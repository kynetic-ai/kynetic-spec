# Daemon Dispatch OOM Hardening Spec Alignment

This draft plan records the spec alignment and implementation tasks for the daemon/dispatch hardening work prompted by a legacy task-storage project repeatedly failing inside daemon/dispatch until the Node.js process reached OOM.

The work is intentionally scoped to behavioral contracts that prevent deterministic project incompatibility or daemon-internal command execution from amplifying into crash loops, recursive command routing, unbounded long-running memory growth, or repeated diagnostic noise.

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: Update daemon and dispatch hardening specs
  slug: task-update-daemon-dispatch-hardening-specs
  priority: 1
  tags: [spec-update, daemon, dispatch, stability]
  spec_ref: "@daemon-entity-cache"
  description: |
    Add the behavioral acceptance criteria needed to cover the daemon and
    dispatch hardening work from this plan.

    Why: The current specs already cover graceful task-cache degradation for
    deterministic task-storage incompatibility, and @api-contract already owns
    the task-storage incompatibility API response contract through existing ACs.
    This plan covers the adjacent stability contracts exposed by the same
    incident: bounded event lineage/source-ordering lifetime, non-overlapping
    periodic dispatch reconciliation, command API recursion suppression, agent
    invocation daemon isolation, and cleanup diagnostic log gating.

    What: Add the following ACs exactly, unless the same behavioral contract
    already exists under an equivalent AC id.

    1. Add to @dispatch-event-envelope:

       ac-retained-event-lineage-is-bounded:
         given: The event bus has accepted more related events than its retained
           recent-event history can hold
         when: Earlier related events age out of the retained recent-event
           history
         then: Event-lineage state for aged-out events no longer accumulates
           beyond the retained recent-event lifetime

       ac-completed-source-ordering-is-released:
         given: Events from a source have completed delivery to matching
           subscribers
         when: No later event delivery for that source depends on the completed
           delivery
         then: Source-ordering state for the completed delivery no longer
           accumulates over daemon lifetime

    2. Add to @agent-dispatch-engine:

       ac-reconcile-non-overlap:
         given: Periodic reconciliation is enabled and a reconciliation pass is
           still running
         when: Another reconciliation interval elapses
         then: The dispatch engine does not start a second reconciliation pass
           before the running pass completes

       ac-stop-awaits-reconciliation:
         given: The dispatch engine is stopping while one or more reconciliation
           passes are in flight
         when: Stop completes
         then: No in-flight reconciliation pass continues mutating dispatch
           state after stop has returned

    3. Add to @daemon-command-api:

       ac-no-recursive-command-proxy:
         given: The daemon command API is executing a CLI command inside the
           daemon process
         when: That command evaluates whether it should proxy through the daemon
         then: The command is executed directly in the current daemon request
           instead of posting back to the command API

    4. Add to @cli-daemon-proxy:

       ac-daemon-internal-proxy-suppression-is-scoped:
         given: Daemon proxying is suppressed for a command running inside a
           daemon command API request
         when: Other CLI commands evaluate proxy mode outside that request
         then: They continue to follow the normal daemon detection, force-direct,
           and force-proxy rules

    5. Add to @agent-invocation-lifecycle:

       ac-invocation-commands-do-not-proxy-to-supervising-daemon:
         given: An agent subprocess is spawned by dispatch or one-shot agent
           invocation
         when: The subprocess invokes kspec commands
         then: Those commands run without proxying through the supervising daemon

       ac-invocation-lifecycle-helper-commands-do-not-proxy:
         given: Invocation timeout, failure, or retry-exhaustion handling writes
           lifecycle notes or task blocks through kspec helper commands
         when: Those helper commands run
         then: They run without daemon proxying

    6. Add to @dispatch-workspace-cleanup-policy:

       ac-preservation-diagnostics-quiet-by-default:
         given: Cleanup repeatedly preserves protected dispatch artifacts during
           normal daemon reconciliation
         when: detailed cleanup diagnostics have not been explicitly enabled
         then: Preservation diagnostics are not emitted for each preserved
           artifact

       ac-preservation-diagnostics-opt-in:
         given: Detailed cleanup diagnostics have been explicitly enabled
         when: Cleanup preserves a protected dispatch artifact
         then: A preservation diagnostic identifies the cleanup surface, artifact,
           and preservation reason

    How: Apply the AC additions with one `kspec batch` mutation that contains the
    required `kspec item ac add` commands, then verify each owning spec with
    `kspec item get`. If an AC already exists with the same behavior but a
    different id, prefer updating the task Covers lines to the existing id over
    creating a duplicate.

    Testing: Run `kspec validate --refs --warnings-ok` and inspect any existing
    non-blocking warnings separately from these spec additions.

    Covers: @dispatch-event-envelope ac-retained-event-lineage-is-bounded,
    ac-completed-source-ordering-is-released; @agent-dispatch-engine
    ac-reconcile-non-overlap, ac-stop-awaits-reconciliation;
    @daemon-command-api ac-no-recursive-command-proxy; @cli-daemon-proxy
    ac-daemon-internal-proxy-suppression-is-scoped;
    @agent-invocation-lifecycle
    ac-invocation-commands-do-not-proxy-to-supervising-daemon,
    ac-invocation-lifecycle-helper-commands-do-not-proxy;
    @dispatch-workspace-cleanup-policy
    ac-preservation-diagnostics-quiet-by-default,
    ac-preservation-diagnostics-opt-in.

- title: Bound event bus lineage and source-ordering lifetime
  slug: task-bound-event-bus-lineage-and-source-ordering-lifetime
  priority: 1
  tags: [dispatch, event-bus, memory]
  spec_ref: "@dispatch-event-envelope"
  depends_on:
    - "@task-update-daemon-dispatch-hardening-specs"
  description: |
    Bound EventBus lineage and source-ordering lifetime so long-running daemon
    processes do not keep state after the corresponding observable events and
    deliveries are no longer active.

    Why: The event bus already retains only a bounded recent-event history, but
    the daemon/dispatch OOM incident showed that adjacent ordering and lineage
    state must follow the same lifetime. High-cardinality source ids and related
    event chains should not accumulate indefinitely across daemon lifetime.

    What:
    - In `src/agent-runtime/event-bus.ts`, expose the recent-event capacity
      without relying on private field access during clear.
    - After each accepted event enters the recent-event history, release lineage
      state whose related events no longer appear in retained recent events.
    - After subscriber delivery settles for a source, release completed
      source-ordering state when no newer delivery for that source depends on it.
    - Preserve per-source sequential delivery while releasing only completed,
      superseded ordering state.
    - Add regression coverage in `tests/event-bus.test.ts` for completed
      source-ordering release and bounded retained event-lineage state.

    How: Use the EventBus retained recent events as the source of truth for which
    event lineage remains observable. Only release completed source-ordering
    state if no newer source delivery has replaced or depends on that completion.

    Testing: Run
    `npm test -- --run tests/event-bus.test.ts`, then include this test in the
    full focused hardening slice with the other tasks.

    Covers: @dispatch-event-envelope ac-6,
    ac-retained-event-lineage-is-bounded,
    ac-completed-source-ordering-is-released.

- title: Prevent overlapping periodic dispatch reconciliation
  slug: task-prevent-overlapping-dispatch-reconciliation
  priority: 1
  tags: [dispatch, daemon, stability]
  spec_ref: "@agent-dispatch-engine"
  depends_on:
    - "@task-update-daemon-dispatch-hardening-specs"
  description: |
    Ensure periodic dispatch reconciliation never overlaps with itself and that
    shutdown does not return while reconciliation can still mutate dispatch
    state.

    Why: During deterministic project failures or slow filesystem/git paths,
    periodic reconciliation should recover missed work but must not amplify load
    by stacking overlapping scans. Overlap increases pending async work, repeated
    logs, and filesystem mutation risk during daemon shutdown.

    What:
    - In `src/agent-runtime/dispatch.ts`, make the periodic reconciliation timer
      skip a tick when the engine is stopped or a reconciliation pass is already
      in flight.
    - Keep tracking in-flight reconciliation promises and ensure `stop()` waits
      for all currently running reconciliation passes before it returns.
    - Add regression coverage in `tests/agent-dispatch-engine.test.ts` proving a
      short reconciliation interval does not start a second pass while the first
      pass is blocked.

    How: Treat skipped interval ticks as coalesced recovery work. The next timer
    tick after the current pass completes may start a new pass if the engine is
    still running.

    Testing: Run
    `npm test -- --run tests/agent-dispatch-engine.test.ts` or the focused
    hardening slice. Verify no test depends on overlapping reconciliation for
    correctness.

    Covers: @agent-dispatch-engine ac-19, ac-20,
    ac-reconcile-non-overlap, ac-stop-awaits-reconciliation.

- title: Suppress recursive daemon command proxying
  slug: task-suppress-recursive-daemon-command-proxying
  priority: 1
  tags: [daemon, cli, api, recursion]
  spec_ref: "@daemon-command-api"
  depends_on:
    - "@task-update-daemon-dispatch-hardening-specs"
  description: |
    Prevent commands executed by the daemon command API from recursively routing
    back into the same daemon command API.

    Why: The command API runs CLI commands in-process. The CLI pre-action hook
    can otherwise observe the running daemon and decide to proxy the command
    back through `/api/command`, producing self-referential command execution
    instead of direct daemon-internal execution.

    What:
    - In `src/cli/daemon-proxy.ts`, add a request-scoped suppression guard and
      export a wrapper for daemon-internal command execution.
    - Make `shouldProxyCommand()` return a direct-mode decision while the guard
      is active, without changing normal proxy behavior outside that guarded
      execution.
    - In `packages/daemon/src/routes/command.ts`, wrap command execution for
      `/api/command` with the suppression guard.
    - Add regression coverage in `tests/daemon-command-api.test.ts` proving a
      command executed through `/api/command` sees proxying disabled even when
      daemon detection reports an available daemon.
    - Add or adjust CLI proxy tests if needed to prove normal force-direct,
      force-proxy, and auto-detect behavior remain unchanged outside the daemon
      command API request.

    How: The suppression must be scoped to the async execution chain of one
    command API request. Do not use a process-wide mutable flag that can leak
    across concurrent requests.

    Testing: Run
    `npm test -- --run tests/daemon-command-api.test.ts tests/cli-daemon-proxy.test.ts`.

    Covers: @daemon-command-api ac-command-endpoint,
    ac-no-recursive-command-proxy; @cli-daemon-proxy
    ac-daemon-internal-proxy-suppression-is-scoped.

- title: Disable daemon proxying inside agent invocations
  slug: task-disable-daemon-proxying-inside-agent-invocations
  priority: 1
  tags: [agent-runtime, dispatch, daemon]
  spec_ref: "@agent-invocation-lifecycle"
  depends_on:
    - "@task-update-daemon-dispatch-hardening-specs"
  description: |
    Ensure dispatched agents and invocation lifecycle helper commands do not
    route their own kspec calls back through the supervising daemon.

    Why: Dispatch controls workspace provisioning and shadow-branch mutation
    serialization. Agent subprocesses and failure/timeout note helpers must use
    the invocation's controlled environment rather than discovering the daemon
    and re-entering command proxy mode.

    What:
    - In `src/agent-runtime/invocation.ts`, build a shared invocation
      environment that sets `KSPEC_NO_DAEMON=1`, preserves caller-provided env
      overrides, and preserves `KSPEC_SHADOW_MUTATION_LOCK_FILE` when present.
    - Use that shared environment when spawning the ACP agent subprocess.
    - Use the same daemon-disabled environment for timeout notes, failure notes,
      and retry-exhaustion task-blocking helper commands.
    - Add regression coverage in `tests/invocation-daemon-isolation.test.ts`
      proving both spawned agents and failure-note helper commands receive
      `KSPEC_NO_DAEMON=1` while preserving mutation-lock env and custom env.
    - Ensure `tests/mocks/kspec-capture-mock.cjs` captures requested env values
      for the helper-command assertions.

    How: Do not remove `KSPEC_SESSION_ID` injection for spawned agents and do
    not weaken the shadow mutation lock behavior. Daemon-proxy isolation is
    additive to the existing invocation environment; mutation-lock preservation
    remains an implementation invariant rather than a new AC in this plan.

    Testing: Run
    `npm test -- --run tests/invocation-daemon-isolation.test.ts`.

    Covers: @agent-invocation-lifecycle
    ac-invocation-commands-do-not-proxy-to-supervising-daemon,
    ac-invocation-lifecycle-helper-commands-do-not-proxy.

- title: Gate cleanup preservation diagnostics behind explicit opt-in
  slug: task-gate-cleanup-preservation-diagnostics
  priority: 1
  tags: [dispatch, cleanup, logging]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on:
    - "@task-update-daemon-dispatch-hardening-specs"
  description: |
    Keep dispatch cleanup preservation diagnostics available for debugging while
    preventing normal reconciliation from emitting repeated preservation logs for
    every protected artifact.

    Why: Cleanup preservation decisions can repeat on startup, periodic
    reconciliation, and post-event reconciliation. Those diagnostics are useful
    when investigating cleanup safety, but in normal daemon operation they can
    amplify deterministic blockers into high-volume logs.

    What:
    - In `src/agent-runtime/workspace.ts`, make preservation diagnostics quiet
      by default.
    - Emit the existing surface-labeled preservation diagnostic only when
      detailed cleanup diagnostics are explicitly enabled.
    - Update diagnostic tests in `tests/dispatch-workspace-cleanup.test.ts` so
      tests that assert diagnostic content enable the opt-in before capturing
      `console.debug`, and restore the prior environment afterward.
    - Preserve existing cleanup safety behavior. This task changes diagnostic
      visibility only, not whether artifacts are preserved or removed.

    How: Do not weaken any destructive-cleanup protection AC. The opt-in gate
    must wrap only the diagnostic emission path.

    Testing: Run
    `npm test -- --run tests/dispatch-workspace-cleanup.test.ts tests/dispatch-workspace-registry.test.ts`.

    Covers: @dispatch-workspace-cleanup-policy
    ac-preservation-diagnostics-quiet-by-default,
    ac-preservation-diagnostics-opt-in.

- title: Validate daemon dispatch OOM hardening slice
  slug: task-validate-daemon-dispatch-oom-hardening-slice
  priority: 2
  tags: [validation, daemon, dispatch]
  spec_ref: "@daemon-entity-cache"
  depends_on:
    - "@task-bound-event-bus-lineage-and-source-ordering-lifetime"
    - "@task-prevent-overlapping-dispatch-reconciliation"
    - "@task-suppress-recursive-daemon-command-proxying"
    - "@task-disable-daemon-proxying-inside-agent-invocations"
    - "@task-gate-cleanup-preservation-diagnostics"
    - "@task-daemon-api-task-storage-incompatibility-errors"
  description: |
    Run the integrated validation slice for the daemon/dispatch OOM hardening
    work and verify the implementation, spec annotations, and build are stable.

    Why: The incident involved multiple daemon subsystems interacting under
    long-running load. Individual task tests are necessary but not sufficient;
    the final validation must exercise the affected daemon, dispatch, event-bus,
    invocation, cleanup, and task-storage API surfaces together. The
    task-storage API response work is owned by the existing
    @task-daemon-api-task-storage-incompatibility-errors task, so this validation
    task depends on that task instead of duplicating its implementation scope.

    What:
    - Ensure every new regression test has accurate `// AC:` annotations for
      the exact AC ids added or referenced by this plan.
    - Confirm @task-daemon-api-task-storage-incompatibility-errors is complete
      before claiming @api-contract task-storage incompatibility API coverage in
      this validation task.
    - Run the focused test slice:
      `npm test -- --run tests/invocation-daemon-isolation.test.ts tests/event-bus.test.ts tests/agent-dispatch-engine.test.ts tests/dispatch-workspace-cleanup.test.ts tests/dispatch-workspace-registry.test.ts tests/daemon-command-api.test.ts tests/cli-daemon-proxy.test.ts tests/daemon-entity-cache.test.ts`
    - Run the daemon API task-storage incompatibility route tests from
      @task-daemon-api-task-storage-incompatibility-errors.
    - Run `npm run build`.
    - Run `git diff --check`.
    - Run `kspec validate --refs --warnings-ok` and inspect whether any warnings
      are pre-existing or caused by this plan's AC/task changes.
    - Confirm no scratch investigation files are included in the final changes.

    How: Treat a focused test pass as evidence for the hardening slice, not as a
    substitute for fixing AC annotation or spec/status drift. If validation finds
    a failure tied to one implementation task, send the task back to needs_work
    instead of weakening the spec.

    Testing: This task is the validation task; record exact command outputs or
    failure summaries in the task notes.

    Covers: @daemon-entity-cache
    ac-task-storage-incompatibility-degraded-state,
    ac-task-storage-incompatibility-stable-reporting,
    ac-task-storage-incompatibility-rechecked-after-storage-change,
    ac-task-storage-incompatibility-recovers-after-migration,
    ac-task-storage-incompatibility-persists-when-unresolved,
    ac-manifest-task-storage-settings-affect-tasks-domain;
    @api-contract ac-task-storage-incompatibility-conflict-status,
    ac-task-storage-incompatibility-error-code,
    ac-task-storage-incompatibility-guidance,
    ac-task-storage-incompatibility-not-not-found,
    ac-task-storage-incompatibility-field-context,
    ac-task-storage-incompatibility-cache-domain-context,
    ac-task-storage-incompatibility-cache-state-context;
    @dispatch-event-envelope ac-retained-event-lineage-is-bounded,
    ac-completed-source-ordering-is-released; @agent-dispatch-engine
    ac-reconcile-non-overlap, ac-stop-awaits-reconciliation;
    @daemon-command-api ac-no-recursive-command-proxy; @cli-daemon-proxy
    ac-daemon-internal-proxy-suppression-is-scoped;
    @agent-invocation-lifecycle
    ac-invocation-commands-do-not-proxy-to-supervising-daemon,
    ac-invocation-lifecycle-helper-commands-do-not-proxy;
    @dispatch-workspace-cleanup-policy
    ac-preservation-diagnostics-quiet-by-default,
    ac-preservation-diagnostics-opt-in.
```

## Implementation Notes

- This is an existing-spec update plan. It intentionally has no structured new
  spec items in `## Specs`; all new behavioral changes are AC additions to
  existing specs through the first task.
- The implementation tasks correspond to the current uncommitted hardening diff
  in `src/agent-runtime/event-bus.ts`, `src/agent-runtime/dispatch.ts`,
  `src/agent-runtime/invocation.ts`, `src/agent-runtime/workspace.ts`,
  `src/cli/daemon-proxy.ts`, `packages/daemon/src/routes/command.ts`, and their
  related tests.
- The task-storage incompatibility API response contract is not duplicated here:
  @api-contract already owns the ACs, and
  @task-daemon-api-task-storage-incompatibility-errors owns the implementation
  work for structured HTTP 409 task_storage_incompatible responses.
