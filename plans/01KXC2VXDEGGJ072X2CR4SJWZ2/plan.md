# Dispatch Lifecycle Pause Resume and Stop Controls

**Goal:** Give operators durable, race-safe global and canonical-task dispatch pause, resume, and hard-stop controls without changing semantic task readiness or losing dispatch evidence.

**Architecture:** One daemon owns one project-scoped durable lifecycle authority. Global authority is `stopped | running | paused`; task controls are `paused | stopped` records keyed by canonical task ULID. Pause prevents new starts and lets active dispatch sessions finish. Resume re-evaluates current authoritative state. Stop commits a no-start authority before targeted cancellation and preserves session/workspace evidence. `draining` is only the projection of `paused` with active work.

**Tech Stack:** TypeScript, Elysia, Commander, SvelteKit, Zod/YAML, Vitest, Playwright, kspec.

## Binding Product Decisions

### Global transition matrix

| Current authority | start | pause | resume | stop |
| --- | --- | --- | --- | --- |
| stopped | transition to running; reconcile current state once | invalid (`409 invalid_transition`); no mutation | invalid (`409 invalid_transition`); no mutation | no-op stopped; cleanup recovery may be retried |
| running | no-op running | transition to paused; hold new work; active work finishes | no-op running | commit stopped, then hard-cancel and close dispatch-owned sessions |
| paused | invalid (`409 invalid_transition`) | no-op paused | transition to running; reconcile current state once | commit stopped, then hard-cancel and close dispatch-owned sessions |

`start` is the compatibility verb for leaving `stopped`; `resume` is the verb for leaving `paused`. Invalid transitions never silently substitute the other verb. Repeated/concurrent valid or no-op actions are idempotent. Daemon startup loads durable authority before any scheduling path and does not implicitly start. Graceful daemon shutdown invokes hard global stop; an already-stopped daemon only retries incomplete cleanup.

### Task transition matrix

An absent task record means running subject to global authority. `pause` from absent creates `paused`; pause from paused is a no-op; pause from stopped is invalid. `stop` from absent or paused commits `stopped`; stop from stopped is a no-op plus cleanup retry. `resume` removes paused/stopped; resume with no record is a no-op. Task actions never bypass global authority and never mutate semantic readiness.

### Durable source of truth and recovery

- Canonical file: `.kspec/dispatch-control.yaml`, schema owner `src/schema/dispatch-control.ts`, parser/store owner `src/parser/dispatch-control.ts`, exported by `src/schema/index.ts` and `src/parser/index.ts`.
- Shape: version `1`, `global.authority`, optional global reason/actor/source/timestamps, `tasks` keyed by canonical ULID with mode/reason/actor/source/timestamps, and `pending_cleanup` entries keyed by `global` or task ULID.
- All read-modify-write operations acquire the existing project dispatch shadow mutation lock, re-read under lock, validate, write atomically, commit to the shadow branch, then publish the in-memory snapshot. The file—not queue flags, engine existence, UI cache, task status, sessions, or workspaces—is authority.
- The daemon project watcher and entity-cache mapping explicitly recognize `dispatch-control.yaml`; changes invalidate the dispatch-control snapshot and agent-status projection. A watcher never writes authority.
- Missing legacy file migrates to `stopped` with no task controls. Version 1 loads exactly. Unknown versions, malformed data, duplicate/noncanonical task keys, or failed commit leave the last validated snapshot in force, reject mutations/startup scheduling, and report `control_store_degraded` with an actionable path; they never default to running.
- Stop first durably commits `stopped` plus pending cleanup ownership. Only then may cancellation/session closure run. Success clears pending cleanup. Cancellation timeout/failure returns runtime failure while authority remains stopped and status reports `cleanup_pending` with affected canonical identities and sanitized error.
- Crash after authority commit cannot reopen scheduling. Startup sees pending cleanup, refuses starts in that scope, reconstructs dispatch-owned active/session ownership, and retries idempotent cancellation/closure. A retry reports success only after cleanup settles. Crash before the authority commit leaves the prior authority and has emitted no success event.
- Pause accepts/coalesces trigger intent; stop rejects it. Exact FIFO and retry deadlines are not durable promises. Resume/start reconstruct current eligible candidates and dedupe against active/queued canonical task identity.
- A final ordered gate immediately before first process/session creation rechecks global and task authority. Control winning the gate creates neither process nor session. Spawn winning first is active: pause drains it; stop cancels it.

### Events and wire contract

Add event domain `dispatch_control` to `src/schema/event-registry.ts` and `packages/shared/src/schemas.ts`. Exact identifiers are:

- `dispatch_control.pause_applied`
- `dispatch_control.resume_applied`
- `dispatch_control.stop_applied`
- `dispatch_control.noop`
- `dispatch_control.failed`

Payload fields: `scope: "global"|"task"`, `action: "start"|"pause"|"resume"|"stop"`, `authority: "stopped"|"running"|"paused"`, `projection: "stopped"|"running"|"paused"|"draining"`, `outcome: "applied"|"noop"|"failed"`, `task_id?: string`, `task_ref?: string`, `reason: string`, `actor: string`, `source: "cli"|"api"|"ui"|"daemon_startup"|"daemon_shutdown"|"recovery"`, `timestamp: string`, `error_code?: string`. Task scope requires canonical `task_id`; global scope forbids task identity. Reason defaults to `operator request`, trims/collapses whitespace, removes control characters, and truncates to 240 Unicode code points. Actor truncates to 120; task_ref to 200; error text is represented only by closed `error_code`. Prompts, secrets, terminal buffers, paths, and raw errors are forbidden.

Applied, no-op, and failed attempts each emit exactly one corresponding event after the durable outcome is known. Invalid request shape/identity emits `failed` without mutation. A persistence failure emits `failed` against the prior authority. Post-commit cleanup failure emits `failed` with stopped authority and `cleanup_pending`. Events broadcast on topic `agents`; all five invalidate `queryKeys.agents.all`, while the automation event log also refreshes.

Canonical API:

- `GET /api/agent/status`
- `POST /api/agent/dispatch/control` body `{scope, action, task_ref?, task_id?, reason?}`

Success/no-op is HTTP 200 and returns `{ok:true,data:{global_authority,projection,cleanup_state,active_count,queue_depth,held_count,held_tasks,task_controls,degraded_targets,outcome},error:null}`. Validation is 400, unresolved task 404, ambiguous/mismatched identity or invalid transition 409, durable store unavailable 503, and cancellation/closure failure 500. Errors return `{ok:false,data:<current status>,error:{code,message,suggestion,details?}}`; current status makes partial committed stop visible. `POST /api/agent/dispatch` remains an adapter for `{action:"start"|"stop"}`. `POST /api/agent/dispatch/start` and `/stop` remain aliases. `GET /api/agent/dispatch/status` remains an internal-shape alias. Compatibility `dispatch_enabled`/`running` is true only for running authority; new clients use authority/projection, and active arrays remain visible while draining/stopped cleanup is pending.

### CLI safety and compatibility

Grammar:

- `kspec agent dispatch start [--reason TEXT] [--json]`
- `kspec agent dispatch pause [--reason TEXT] [--json]`
- `kspec agent dispatch resume [--reason TEXT] [--json]`
- `kspec agent dispatch stop [--reason TEXT] [--yes] [--json]`
- `kspec agent dispatch task pause|resume @task [--reason TEXT] [--json]`
- `kspec agent dispatch task stop @task [--reason TEXT] [--yes] [--json]`

Interactive TTY hard stop requires confirmation describing active cancellation and evidence preservation; decline exits 2 without request. Non-interactive human stop without `--yes` exits 1 with guidance. JSON never prompts and requires `--yes`, except dispatch-owned contexts (`KSPEC_SESSION_ID`) are rejected with exit 3 because an agent may not stop its host. Start/pause/resume do not confirm. Validation/usage exits 1; runtime/daemon/store/cancellation failures exit 3; success/no-op exits 0. Existing stop spelling remains hard stop, not graceful; help says “Hard-stop dispatch: cancel matching active invocations, close sessions, preserve evidence.” Pause help says active invocations finish naturally.

### UI consumer inventory and migration

Primary files: `packages/web-ui/src/lib/api.ts`, `packages/web-ui/src/routes/agents/+page.svelte`, `packages/web-ui/src/lib/components/agents/DispatchStatus.svelte`, `ActiveInvocationRow.svelte`, `QueuedInvocationRow.svelte`, new `HeldTaskRow.svelte`, `packages/web-ui/src/lib/query/ws-invalidation.ts`, and focused tests. Existing boolean consumers also owned by this migration: `packages/web-ui/src/routes/+page.svelte`, `packages/web-ui/src/lib/components/board/ActiveFleetRow.svelte`, `packages/web-ui/src/routes/automation/+page.svelte`, and `packages/web-ui/src/lib/components/automation/DispatchTriggersSection.svelte`.

New responses use authority/projection. During mixed-version compatibility, absent authority maps `dispatch_enabled=true` to running and false to stopped; if active work exists with false, consumers still show active work and label legacy status unknown/stopping rather than hide it. Static mode returns stopped, zero counts, empty controls, and read-only controls. Query invalidation uses the `agents` topic. Stop has an accessible confirmation; pause does not. Focus returns to the invoking control, failures remain announced, and status changes use a polite live region.

## Non-goals

No task lifecycle mutation, exact durable FIFO, distributed scheduler, process checkpointing, workspace deletion, one-shot invocation control unless dispatch-owned, or product code in the spec-patch task.

## Specs

```yaml
- title: Dispatch Lifecycle Control Authority
  slug: dispatch-lifecycle-control-authority
  type: requirement
  description: Durable administrative dispatch authority controls whether global or canonical-task work may start without changing task readiness or evidence ownership.
  acceptance_criteria:
    - id: ac-global-pause-authority
      given: global authority is running
      when: global pause succeeds
      then: global authority is paused
    - id: ac-paused-work-does-not-start
      given: global or task authority is paused
      when: eligible work is evaluated
      then: no new invocation starts in that scope
    - id: ac-pause-allows-active-completion
      given: an invocation is active when its scope is paused
      when: the invocation continues
      then: it may finish naturally without pause cancelling its session
    - id: ac-resume-reconciles-current-work
      given: a paused scope contains held or currently eligible work
      when: that scope resumes
      then: current authoritative work is re-evaluated
    - id: ac-resume-does-not-duplicate
      given: resume is repeated or concurrent
      when: eligible work is drained
      then: each canonical task has at most one active invocation
    - id: ac-stop-forbids-new-starts
      given: stop authority has committed for a scope
      when: work is evaluated
      then: no new invocation starts in that scope
    - id: ac-stop-cancels-active-work
      given: dispatch-owned invocations are active in a stopped scope
      when: stop cleanup completes
      then: those invocations are cancelled
    - id: ac-stop-closes-active-sessions
      given: dispatch-owned sessions are active in a stopped scope
      when: stop cleanup completes
      then: those sessions are closed
    - id: ac-task-control-is-isolated
      given: one canonical task is controlled
      when: unrelated tasks are evaluated
      then: unrelated tasks remain governed only by their own controls and global authority
    - id: ac-task-control-uses-canonical-identity
      given: multiple refs denote one task
      when: task control is applied
      then: one control record exists for its canonical ULID
    - id: ac-task-resume-obeys-global-authority
      given: a task control is released while global authority is not running
      when: the task is re-evaluated
      then: no invocation starts
    - id: ac-task-stop-cancels-matching-work
      given: one canonical task has an active dispatch-owned invocation
      when: stop cleanup completes for that task
      then: the matching invocation is cancelled and unrelated invocations are not cancelled
    - id: ac-task-stop-closes-matching-session
      given: one canonical task has an active dispatch-owned session
      when: stop cleanup completes for that task
      then: the matching session is closed and unrelated sessions are not closed
    - id: ac-task-stop-failure-remains-authoritative
      given: stopped task authority committed and its cleanup failed
      when: status is requested
      then: that task remains stopped with pending cleanup and no success outcome
    - id: ac-task-interrupted-stop-recovers
      given: stopped task authority has pending cleanup after interruption
      when: the daemon starts or task stop is retried
      then: matching cleanup resumes without reopening that task or affecting unrelated tasks
    - id: ac-controls-survive-restart
      given: lifecycle authority is durable
      when: the daemon restarts
      then: the same authority governs scheduling before bootstrap
    - id: ac-final-gate-prevents-losing-spawn
      given: control wins ordering before process or session creation
      when: the candidate reaches the final start boundary
      then: neither a process nor a session is created
    - id: ac-spawn-win-honors-selected-action
      given: spawn wins ordering before a control
      when: the control is applied
      then: pause permits natural completion and stop cancels the active invocation
    - id: ac-controls-do-not-change-readiness
      given: task readiness or degraded target state exists
      when: lifecycle control changes
      then: task status, dependencies, blocked state, automation eligibility, and degraded target state remain unchanged
    - id: ac-stop-failure-remains-authoritative
      given: stopped authority committed and cleanup failed
      when: status is requested
      then: stopped authority and pending cleanup are reported without success
    - id: ac-interrupted-stop-recovers
      given: stopped authority has pending cleanup after interruption
      when: the daemon starts or stop is retried
      then: cleanup resumes without reopening scheduling
    - id: ac-reconstruction-uses-current-state
      given: paused or stopped in-memory scheduling data was lost
      when: running becomes permitted
      then: candidates are reconstructed from current authoritative state without promising prior FIFO or retry timing
    - id: ac-status-reports-authority
      given: lifecycle status is requested
      when: the response is produced
      then: authority and running, paused, draining, or stopped projection are reported
    - id: ac-status-reports-work-counts
      given: active, queued, or held work exists
      when: lifecycle status is requested
      then: active, queued, and held counts are reported
    - id: ac-status-reports-held-tasks
      given: canonical tasks are held
      when: lifecycle status is requested
      then: held canonical identities, scope, mode, and sanitized reason are reported
    - id: ac-actions-are-idempotent
      given: the same valid lifecycle action is repeated
      when: it is applied
      then: authority and side effects equal one application
    - id: ac-control-outcomes-are-auditable
      given: a lifecycle action is attempted
      when: its durable outcome is known
      then: one sanitized typed event records applied, no-op, or failed outcome
    - id: ac-evidence-survives-control
      given: dispatch work is paused or stopped
      when: lifecycle control completes
      then: session, branch, workspace, worktree, snapshot, and audit evidence remain available under existing cleanup policy
```

## Exact Existing-Spec Changes

The spec-patch task applies only this wording with `kspec item set` and `kspec item ac set/add`. Preserve all unlisted IDs and metadata.

- `@agent-dispatch-engine ac-11`: **Given** dispatch-owned work is queued, in flight, or active. **When** global stop or daemon shutdown is requested. **Then** stopped authority is committed before new starts are forbidden, matching scheduling work is cleared, active invocations are cancelled, matching sessions are closed, and success is reported only after cleanup settles.
- Add `@agent-dispatch-engine ac-lifecycle-final-gate`: **Given** a candidate remains eligible after dequeue. **When** it reaches the final boundary before process or session creation. **Then** current global and canonical-task controls determine whether creation is permitted.
- Add `@agent-dispatch-engine ac-pause-active-natural-completion`: **Given** an invocation is active in a scope. **When** that scope is paused. **Then** the invocation may finish naturally and pause does not cancel its session.
- Add `@agent-dispatch-engine ac-resume-current-state`: **Given** a scope is paused. **When** it resumes. **Then** current task state and dispatch rules are re-evaluated before work starts.
- `@per-task-dispatch-drain-coalescing ac-5`: **Given** per-task coalescing timers are pending. **When** global or matching task stop authority commits. **Then** matching timers are cancelled, matching pending drains cannot start work, and any already-active invocation is handled by hard-stop cancellation.
- `@cli-agent-commands` description: The `kspec agent` family lists and runs agents and exposes durable global and canonical-task dispatch start, pause, resume, hard-stop, and status controls.
- `@cli-agent-commands ac-5`: **Given** dispatch has queued, in-flight, or active work. **When** `kspec agent dispatch stop` is confirmed and succeeds. **Then** hard stop cancels dispatch-owned active invocations, closes matching sessions, preserves evidence, and reports stopped.
- Add `@cli-agent-commands ac-lifecycle-verbs`: **Given** the daemon is available. **When** start, pause, or resume is requested from a valid authority state. **Then** the command reports the resulting authority and projection.
- Add `@cli-agent-commands ac-destructive-stop-confirmation`: **Given** a user invokes hard stop interactively. **When** confirmation is declined. **Then** no stop request is sent and the command exits as user-cancelled.
- Add `@cli-agent-commands ac-task-control-canonicalization`: **Given** a task control command names a resolvable task. **When** it is accepted. **Then** the result identifies the canonical task ULID.
- Add `@cli-agent-commands ac-lifecycle-status-output`: **Given** lifecycle work exists. **When** status is printed. **Then** authority, projection, active, queued, and held counts are present in human and JSON output.
- `@daemon-agent-dispatch ac-5`: **Given** `GET /api/agent/status` is called. **When** lifecycle state is available. **Then** the response includes authority, projection, cleanup state, active, queued, and held work, task controls, agent definitions, degraded targets, and compatibility `dispatch_enabled`.
- `@daemon-agent-dispatch ac-6`: **Given** a localhost client posts a supported lifecycle control. **When** request validation and transition processing finish. **Then** the response returns the resulting status or a structured error containing current status.
- Add `@daemon-agent-dispatch ac-control-identity-validation`: **Given** a task-scoped control carries task identity. **When** identity is resolved. **Then** missing identity is rejected, a unique ref is canonicalized, and mismatched identities have no effect.
- Add `@daemon-agent-dispatch ac-control-failure-status`: **Given** persistence or stop cleanup fails. **When** the API responds. **Then** it does not report success and includes the current authoritative status.
- `@ui-agent-dispatch ac-2`: **Given** lifecycle status is available. **When** the agents view renders. **Then** it shows authority, projection, active, queued, and held work without hiding active work during draining or cleanup.
- `@ui-agent-dispatch ac-3`: **Given** global authority is paused or stopped. **When** the agents view renders. **Then** it offers only valid lifecycle actions and labels administrative control separately from degraded or blocked state.
- Add `@ui-agent-dispatch ac-hard-stop-confirmation`: **Given** a writable operator selects hard stop. **When** confirmation is shown. **Then** it explains cancellation and evidence preservation and sends no request when cancelled.
- Add `@ui-agent-dispatch ac-live-accessible-status`: **Given** lifecycle status changes. **When** the view refreshes. **Then** keyboard and screen-reader users receive labelled controls, retained focus, and a live status update.
- Add `@dispatch-event-taxonomy ac-dispatch-control-domain`: **Given** a lifecycle outcome is emitted. **When** event type validation runs. **Then** the identifier is one of `dispatch_control.pause_applied`, `dispatch_control.resume_applied`, `dispatch_control.stop_applied`, `dispatch_control.noop`, or `dispatch_control.failed`.
- Add `@dispatch-event-payload ac-dispatch-control-fields`: **Given** a dispatch-control event is emitted. **When** its payload is read. **Then** scope, action, authority, projection, outcome, reason, actor, source, and timestamp are present, and task scope also includes canonical task identity.
- Add `@dispatch-event-payload ac-dispatch-control-sanitization`: **Given** lifecycle event inputs contain sensitive or oversized text. **When** the payload is created. **Then** bounded sanitized fields are emitted without prompts, secrets, terminal buffers, workspace paths, or raw errors.
- Add `@dispatch-workspace-cleanup-policy ac-controlled-evidence-protected`: **Given** dispatch evidence belongs to active, in-flight, paused-held, or stopped-pending-cleanup work. **When** a destructive cleanup surface evaluates it. **Then** lifecycle control alone does not make the evidence cleanup-eligible.

## Coverage Ownership

| Contract | Primary closure owner |
| --- | --- |
| exact existing-spec text | `task-patch-dispatch-lifecycle-specs` |
| durable authority, canonical identity, idempotency | `task-dispatch-control-persistence` |
| global matrix pause/resume and reconstruction | `task-engine-global-lifecycle` |
| final race gate | `task-final-pre-spawn-control-gate` |
| global hard stop and recovery | `task-engine-global-hard-stop` |
| task pause/resume isolation | `task-engine-task-pause-resume` |
| targeted task stop/recovery | `task-engine-task-hard-stop` |
| evidence cleanup protection | `task-protect-held-dispatch-evidence` |
| event taxonomy/payload | `task-dispatch-lifecycle-events` |
| API/status wire contract | `task-daemon-dispatch-lifecycle-api` |
| CLI grammar/safety | `task-cli-dispatch-lifecycle-controls` |
| UI consumers/accessibility | `task-ui-dispatch-lifecycle-controls` |
| restart/race black-box verification | `task-verify-engine-restart-races` |
| API/CLI projection verification | `task-verify-api-cli-projection` |
| browser/accessibility verification | `task-verify-ui-lifecycle-browser` |

Secondary tasks consume prerequisite contracts and do not claim their ACs.

## Tasks

derive_from_specs: false

```yaml
- title: Patch dispatch lifecycle owning specs exactly
  slug: task-patch-dispatch-lifecycle-specs
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  tags: [dispatch, specs]
  description: |
    Covers:
    - @agent-dispatch-engine ac-11
    - @agent-dispatch-engine ac-lifecycle-final-gate
    - @agent-dispatch-engine ac-pause-active-natural-completion
    - @agent-dispatch-engine ac-resume-current-state
    - @per-task-dispatch-drain-coalescing ac-5
    - @cli-agent-commands ac-5
    - @cli-agent-commands ac-lifecycle-verbs
    - @cli-agent-commands ac-destructive-stop-confirmation
    - @cli-agent-commands ac-task-control-canonicalization
    - @cli-agent-commands ac-lifecycle-status-output
    - @daemon-agent-dispatch ac-5
    - @daemon-agent-dispatch ac-6
    - @daemon-agent-dispatch ac-control-identity-validation
    - @daemon-agent-dispatch ac-control-failure-status
    - @ui-agent-dispatch ac-2
    - @ui-agent-dispatch ac-3
    - @ui-agent-dispatch ac-hard-stop-confirmation
    - @ui-agent-dispatch ac-live-accessible-status
    - @dispatch-event-taxonomy ac-dispatch-control-domain
    - @dispatch-event-payload ac-dispatch-control-fields
    - @dispatch-event-payload ac-dispatch-control-sanitization
    - @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected
    What: Materialize the exact replacement/addition text through kspec CLI before product work.
    Why: Current stop contracts conflict, including @per-task-dispatch-drain-coalescing ac-5.
    How: Create the plan-owned requirement through derivation; use item set/ac set/ac add; preserve unlisted IDs, status, maturity, traits, metadata; no product code or YAML edits.
    Sources of Truth: Exact Existing-Spec Changes above and current item readback.
    Files: kspec shadow state only.
    Required tests: exact readback of all nine owners; unchanged unlisted ACs; validation.
    Verification: kspec item get on every named owner; kspec validate --warnings-ok.
    Review handoff: list changed refs/IDs and confirm no product files.

- title: Define durable dispatch control schema and store
  slug: task-dispatch-control-persistence
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-patch-dispatch-lifecycle-specs"]
  tags: [dispatch, schema, persistence]
  description: |
    Covers: ac-task-control-uses-canonical-identity, ac-controls-survive-restart, ac-controls-do-not-change-readiness, ac-actions-are-idempotent.
    What: Implement version-1 `.kspec/dispatch-control.yaml` and its single parser/store authority exactly as frozen above.
    Why: No other slice can safely infer persistence, migration, locking, watcher, or corruption behavior.
    How: Own `src/schema/dispatch-control.ts`, `src/parser/dispatch-control.ts`, index exports, project watcher/entity-cache mapping, atomic shadow-lock read-modify-write/commit, missing-file migration, corruption degradation, canonical ULID keys, and last-valid snapshot publication. Do not implement engine actions.
    Sources of Truth: Durable source of truth and recovery; `src/parser/yaml.ts`; dispatch shadow mutation discipline in `src/agent-runtime/workspace.ts`; `src/agent-runtime/task-identity.ts`.
    Files: create schema/parser and `tests/dispatch-control-store.test.ts`; update indexes, `packages/daemon/src/project-context.ts`, `src/daemon/entity-cache.ts` and focused watcher/cache tests.
    Required tests: missing/version1/unknown/malformed; canonical convergence/mismatch; atomic failure; lock concurrency; watcher invalidation; no readiness/degraded mutation.
    Verification: npm test -- tests/dispatch-control-store.test.ts tests/daemon-entity-cache.test.ts tests/daemon-watcher-chokidar.test.ts; npm run typecheck; npm run lint.
    Review handoff: persisted fixture, migration/corruption matrix, lock evidence.

- title: Implement global start pause resume authority
  slug: task-engine-global-lifecycle
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-dispatch-control-persistence"]
  tags: [dispatch, engine]
  description: |
    Covers: ac-global-pause-authority, ac-paused-work-does-not-start, ac-pause-allows-active-completion, ac-resume-reconciles-current-work, ac-resume-does-not-duplicate, ac-reconstruction-uses-current-state.
    What: Apply the complete global start/pause/resume matrix, startup loading, held/coalesced intent, and current-state reconstruction.
    Why: Start and resume must not be interchangeable and pause must not clear evidence or active sessions.
    How: Update `src/agent-runtime/dispatch.ts`; load control before bootstrap; cover event, watcher, bootstrap, reconciliation, post-invocation, retry, coalescing and degraded recovery; keep stop/cancellation out.
    Sources of Truth: global matrix, queue/recovery contract, @per-task-dispatch-drain-coalescing.
    Files: `src/agent-runtime/dispatch.ts`, `tests/agent-dispatch-engine.test.ts`; create `tests/dispatch-global-lifecycle.test.ts`.
    Required tests: every matrix cell; daemon startup stopped/paused/running; held count coalescing; concurrent resume; no active cancellation on pause.
    Verification: npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-global-lifecycle.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts; typecheck; lint.
    Review handoff: matrix-to-test table and scheduling-ingress inventory.

- title: Add final pre-spawn lifecycle gate
  slug: task-final-pre-spawn-control-gate
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-global-lifecycle"]
  tags: [dispatch, race]
  description: |
    Covers: ac-final-gate-prevents-losing-spawn, ac-spawn-win-honors-selected-action.
    What: Add the last authority check before the first process/session creation boundary.
    Why: Enqueue checks leave a dequeue-to-spawn race.
    How: Modify `src/agent-runtime/dispatch.ts` and minimal invocation/session hooks; order control and spawn, preserve in-flight cleanup ownership, restore pause losers once and discard stop losers; no long lock across provisioning/execution.
    Sources of Truth: race contract; `_spawnInvocation`/`runInvocation`/SessionRegistry current boundaries.
    Files: `src/agent-runtime/dispatch.ts`; minimal `src/agent-runtime/invocation.ts`; create `tests/dispatch-spawn-control-race.test.ts`; update artifact tests.
    Required tests: barrier-controlled pause/stop before gate and spawn before control; no timing sleeps; no protection gap.
    Verification: npm test -- tests/dispatch-spawn-control-race.test.ts tests/dispatch-artifact-protection.test.ts; typecheck; lint.
    Review handoff: exact irreversible boundary and deterministic traces.

- title: Implement recoverable global hard stop
  slug: task-engine-global-hard-stop
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-final-pre-spawn-control-gate"]
  tags: [dispatch, cancellation]
  description: |
    Covers: ac-stop-forbids-new-starts, ac-stop-cancels-active-work, ac-stop-closes-active-sessions, ac-stop-failure-remains-authoritative, ac-interrupted-stop-recovers.
    What: Implement commit-first global stop, pending-cleanup recovery, cancellation, session closure, shutdown reuse, and truthful status.
    Why: Failure after authority commit must not reopen dispatch or claim success.
    How: Update dispatch/session registry and `packages/daemon/src/routes/agent-dispatch.ts` shutdown wiring; persist stopped+pending first; idempotently clear matching scheduling state; retry cleanup on startup/stop; preserve files/workspaces. Do not own API serialization.
    Sources of Truth: recovery contract; current DispatchEngine.stop and SessionRegistry.closeAll.
    Files: `src/agent-runtime/dispatch.ts`, `src/agent-runtime/session-registry.ts`, daemon shutdown wiring, `tests/agent-dispatch-engine.test.ts`, `tests/session-registry.test.ts`, create `tests/dispatch-stop-recovery.test.ts`.
    Required tests: commit failure; cancellation timeout; closure failure; crash after commit; startup recovery; repeated stop; no false success.
    Verification: npm test -- tests/dispatch-stop-recovery.test.ts tests/session-registry.test.ts tests/agent-dispatch-engine.test.ts; typecheck; lint.
    Review handoff: commit/cleanup state machine and fault-injection results.

- title: Enforce canonical task pause and resume
  slug: task-engine-task-pause-resume
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-final-pre-spawn-control-gate"]
  tags: [dispatch, tasks]
  description: |
    Covers: ac-task-control-is-isolated, ac-task-resume-obeys-global-authority.
    What: Apply task pause/resume at every scheduling path using canonical identity.
    Why: A path-specific or slug-keyed hold can leak starts or block another task.
    How: Update dispatch scheduling paths; pause keeps matching active work natural; resume re-evaluates only current task and obeys global authority. Consume persistence identity contract without claiming it.
    Sources of Truth: task matrix; `src/agent-runtime/task-identity.ts`; current dedupe/exclusivity.
    Files: `src/agent-runtime/dispatch.ts`; create `tests/dispatch-task-lifecycle.test.ts`; update canonical identity integration test.
    Required tests: task A/B isolation; slug/ULID convergence; every ingress; resume under global pause/stop; coalesced held counts.
    Verification: npm test -- tests/dispatch-task-lifecycle.test.ts tests/dispatch-canonical-task-identity-integration.test.ts; typecheck; lint.
    Review handoff: canonical identity and ingress matrices.

- title: Implement recoverable targeted task hard stop
  slug: task-engine-task-hard-stop
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-task-pause-resume", "@task-engine-global-hard-stop"]
  tags: [dispatch, cancellation, tasks]
  description: |
    Covers: ac-task-stop-cancels-matching-work, ac-task-stop-closes-matching-session, ac-task-stop-failure-remains-authoritative, ac-task-interrupted-stop-recovers.
    What: Stop one canonical task without disturbing unrelated work.
    Why: Global closeAll or ref aliases violate task isolation.
    How: Add targeted active-controller/session ownership and close-by-canonical-task; commit task stopped+pending first; remove matching queue/retry/coalescing only; retry cleanup; resume reconstructs current state.
    Sources of Truth: task matrix/recovery; active invocation detail; SessionRegistry.
    Files: `src/agent-runtime/dispatch.ts`, `src/agent-runtime/session-registry.ts`, `tests/dispatch-task-lifecycle.test.ts`, `tests/session-registry.test.ts`.
    Required tests: A/B active and queued isolation; partial failure/restart recovery; repeated stop; evidence retained.
    Verification: npm test -- tests/dispatch-task-lifecycle.test.ts tests/session-registry.test.ts tests/dispatch-stop-recovery.test.ts; typecheck; lint.
    Review handoff: targeted ownership proof and unrelated-session assertions.

- title: Protect controlled dispatch evidence from cleanup
  slug: task-protect-held-dispatch-evidence
  priority: 2
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on: ["@task-engine-task-hard-stop"]
  tags: [dispatch, cleanup]
  description: |
    Covers: ac-evidence-survives-control and @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected.
    What: Feed active, in-flight, paused-held, and stopped-pending identities into centralized cleanup protection.
    Why: No active process does not mean evidence is disposable.
    How: Update `src/agent-runtime/workspace.ts` and callers for worker/reviewer/root/record/branch surfaces; retain existing terminal/integration cleanup authority and quiet diagnostics.
    Sources of Truth: cleanup spec and current artifact protection implementation.
    Files: `src/agent-runtime/workspace.ts`, `tests/dispatch-artifact-protection.test.ts`, `tests/dispatch-workspace-cleanup.test.ts`, registry tests.
    Required tests: every destructive surface; removal after independent eligibility; corrupt/unknown policy unchanged.
    Verification: npm test -- tests/dispatch-artifact-protection.test.ts tests/dispatch-workspace-cleanup.test.ts tests/dispatch-workspace-registry.test.ts; typecheck; lint.
    Review handoff: cleanup-surface matrix.

- title: Register and emit lifecycle control events
  slug: task-dispatch-lifecycle-events
  priority: 2
  spec_ref: "@dispatch-event-taxonomy"
  depends_on: ["@task-engine-task-hard-stop"]
  tags: [dispatch, events]
  description: |
    Covers: ac-control-outcomes-are-auditable; @dispatch-event-taxonomy ac-dispatch-control-domain; @dispatch-event-payload ac-dispatch-control-fields and ac-dispatch-control-sanitization.
    What: Materialize the exact domain, five identifiers, payload schema, limits, defaults, and emission mapping.
    Why: Event consumers cannot invent identifiers or sanitization.
    How: Update registry/domain, payload schema, shared mirror, engine/control emission and daemon `agents` broadcast; applied/no-op/failed exactly once after outcome; no raw error.
    Sources of Truth: Events and wire contract; `src/schema/event-registry.ts`, `src/schema/event-payloads.ts`, `packages/shared/src/schemas.ts`.
    Files: those files; dispatch emitter; create `tests/dispatch-control-events.test.ts`; update event/schema/shared tests.
    Required tests: all scope/action/outcomes; exact required/forbidden fields; Unicode limits; commit and cleanup failures; registry mirror.
    Verification: npm test -- tests/dispatch-control-events.test.ts tests/event-bus.test.ts; npm --prefix packages/shared test; typecheck; lint.
    Review handoff: registry diff and representative sanitized payloads.

- title: Add canonical lifecycle API and status projection
  slug: task-daemon-dispatch-lifecycle-api
  priority: 2
  spec_ref: "@daemon-agent-dispatch"
  depends_on: ["@task-dispatch-lifecycle-events", "@task-protect-held-dispatch-evidence"]
  tags: [dispatch, daemon, api]
  description: |
    Covers: ac-status-reports-authority, ac-status-reports-work-counts, ac-status-reports-held-tasks; @daemon-agent-dispatch ac-5, ac-6, ac-control-identity-validation, ac-control-failure-status.
    What: Implement exact methods, paths, envelopes, errors, canonicalization, compatibility aliases and one status mapper.
    Why: Current implementation is in `packages/daemon`, and aliases expose divergent boolean shapes.
    How: Update `packages/daemon/src/routes/agent-dispatch.ts`; canonical POST `/api/agent/dispatch/control`; preserve listed aliases; status keeps active arrays visible; current status accompanies failures.
    Sources of Truth: canonical API section and current route file.
    Files: `packages/daemon/src/routes/agent-dispatch.ts`, `tests/daemon-api/agent-dispatch.test.ts`; create no nonexistent daemon route test.
    Required tests: every status/action/transition; methods/paths; 400/404/409/500/503; alias parity; identity mismatch; cleanup pending; compatibility booleans.
    Verification: npm test -- tests/daemon-api/agent-dispatch.test.ts; typecheck; lint.
    Review handoff: curl/request examples and alias parity table.

- title: Add safe lifecycle CLI commands
  slug: task-cli-dispatch-lifecycle-controls
  priority: 3
  spec_ref: "@cli-agent-commands"
  depends_on: ["@task-daemon-dispatch-lifecycle-api"]
  tags: [dispatch, cli]
  description: |
    Covers: @cli-agent-commands ac-5, ac-lifecycle-verbs, ac-destructive-stop-confirmation, ac-task-control-canonicalization, ac-lifecycle-status-output.
    What: Implement the exact grammar, hard-stop confirmation, noninteractive/JSON rules, dispatch-owned rejection, help and exits.
    Why: Existing stop becomes destructive and must be safe without breaking spelling.
    How: Use daemon API only in `src/cli/commands/agent.ts`; `--yes` rules and exit codes exactly as frozen; default reason server-side; preserve hard stop aliases/help wording.
    Sources of Truth: CLI safety section; semantic-exit-code trait; current command.
    Files: `src/cli/commands/agent.ts`, `tests/cli-agent-commands.test.ts`, `tests/cli-agent.test.ts`; create `tests/cli-agent-dispatch-lifecycle.test.ts`.
    Required tests: TTY confirm accept/decline; piped/JSON missing/with yes; KSPEC_SESSION_ID; human/JSON no-op/failure/status; help snapshots.
    Verification: npm test -- tests/cli-agent-commands.test.ts tests/cli-agent.test.ts tests/cli-agent-dispatch-lifecycle.test.ts; typecheck; lint.
    Review handoff: exact help/output/exit transcript.

- title: Migrate all web lifecycle consumers
  slug: task-ui-dispatch-lifecycle-controls
  priority: 3
  spec_ref: "@ui-agent-dispatch"
  depends_on: ["@task-daemon-dispatch-lifecycle-api"]
  tags: [dispatch, ui, accessibility]
  description: |
    Covers: @ui-agent-dispatch ac-2, ac-3, ac-hard-stop-confirmation, ac-live-accessible-status.
    What: Migrate every inventoried boolean consumer and add global/task controls, held rows and accessible live status.
    Why: Existing pages hide active work when dispatch_enabled is false.
    How: Update all paths in UI inventory; compatibility fallback and static defaults exactly as frozen; lifecycle events invalidate agents/event log; stop confirms, pause does not; preserve focus and responsive/reduced-motion behavior.
    Sources of Truth: UI inventory/migration and API/event prerequisites.
    Files: exact inventory paths; create `HeldTaskRow.svelte`; focused tests under `tests/web-ui/`; create `tests/e2e/dispatch-lifecycle.spec.ts` only for later browser slice fixtures.
    Required tests: running/paused/draining/stopped/cleanup pending; old payload fallback; all consumer visibility; static mode; errors; keyboard/live region.
    Verification: npm --prefix packages/web-ui test; npm run typecheck; npm run lint.
    Review handoff: consumer checklist and component screenshots.

- title: Verify engine restart and race black boxes
  slug: task-verify-engine-restart-races
  priority: 3
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-task-hard-stop", "@task-protect-held-dispatch-evidence"]
  tags: [dispatch, verification]
  description: |
    Covers: verification only; consumes engine/recovery/race contracts without claiming closure.
    What: Add bounded daemon/engine black-box restart, race, reconstruction, and evidence scenarios.
    Why: Unit owners may miss cross-path bypasses.
    How: Deterministic fake adapter/barriers; no provider spend/sleeps; inspect every ingress and cleanup surface.
    Sources of Truth: matrices and prerequisite tests.
    Files: create `tests/dispatch-lifecycle-blackbox.test.ts`; reuse existing engine/artifact helpers only.
    Required tests: paused/stopped restart; pending cleanup crash; task/global races; stale eligibility; no duplicate; evidence.
    Verification: npm test -- tests/dispatch-lifecycle-blackbox.test.ts tests/dispatch-spawn-control-race.test.ts tests/dispatch-artifact-protection.test.ts.
    Review handoff: restart/race boundary matrix.

- title: Verify API and CLI lifecycle projection
  slug: task-verify-api-cli-projection
  priority: 3
  spec_ref: "@daemon-agent-dispatch"
  depends_on: ["@task-cli-dispatch-lifecycle-controls", "@task-verify-engine-restart-races"]
  tags: [dispatch, verification, cli]
  description: |
    Covers: verification only; consumes API/CLI/status contracts without claiming closure.
    What: Compare canonical API, aliases, human CLI, JSON CLI and events from one fixture.
    Why: Compatibility adapters and exit handling can diverge.
    How: Use daemon test helpers with explicit cwd/ephemeral endpoint; assert exact envelopes, errors, counts, reasons, exits and confirmation behavior.
    Sources of Truth: API and CLI frozen contracts.
    Files: create `tests/dispatch-lifecycle-surface-integration.test.ts`; existing daemon/CLI helpers.
    Required tests: all matrix cells, aliases, invalid identity, store/cancellation failure, applied/no-op/failed event mapping.
    Verification: npm test -- tests/dispatch-lifecycle-surface-integration.test.ts tests/daemon-api/agent-dispatch.test.ts tests/cli-agent-dispatch-lifecycle.test.ts.
    Review handoff: cross-surface fixture table.

- title: Verify lifecycle UI in real browser
  slug: task-verify-ui-lifecycle-browser
  priority: 3
  spec_ref: "@ui-agent-dispatch"
  depends_on: ["@task-ui-dispatch-lifecycle-controls", "@task-verify-api-cli-projection"]
  tags: [dispatch, verification, accessibility]
  description: |
    Covers: verification only; consumes UI contracts without claiming closure.
    What: Run focused browser/accessibility scenarios for all inventoried UI consumers.
    Why: Component tests cannot prove focus, announcements, confirmation, narrow layout, or cross-page visibility.
    How: Use `tests/e2e/dispatch-lifecycle.spec.ts`, E2E-managed daemon and deterministic fixtures; inspect accessibility tree at desktop/mobile and reduced motion.
    Sources of Truth: UI inventory and accessibility contract.
    Files: `tests/e2e/dispatch-lifecycle.spec.ts` and E2E fixture helpers only.
    Required tests: running/draining/paused/stopped/pending cleanup; stop cancel/confirm; pause; mutation error; dashboard/fleet/automation visibility; static read-only.
    Verification: npm run test:e2e -- --grep "dispatch lifecycle"; npm --prefix packages/web-ui test.
    Review handoff: screenshots, accessibility tree, focus and viewport evidence.
```

## Implementation Order

Exact spec patch → persistence → global lifecycle → race gate → global stop → task controls → evidence/events → API → CLI/UI → three bounded verification slices. Dependencies are acyclic and priorities never decrease. Import remains draft; do not approve, derive, or implement.
