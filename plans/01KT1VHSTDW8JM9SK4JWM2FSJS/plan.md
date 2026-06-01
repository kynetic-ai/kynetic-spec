# Agent Runner Contract Hardening Follow-up

## Summary

Harden the completed agent-runner configuration layer where closure validation found behavior that was implemented too loosely or not specified precisely enough. This follow-up updates the existing runner specs rather than creating sibling specs: the runner feature already exists, and the gaps are in deterministic cwd semantics, registry-load diagnostics, dispatch preflight equivalence, daemon/API response parity, and operator-visible runner metadata.

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: Tighten existing runner contracts for closure gaps
  slug: task-tighten-runner-closure-gap-specs
  priority: 1
  tags: [spec-update, agents, runners, diagnostics]
  spec_ref: "@runner-process-invocation-inputs"
  description: |
    What:
    - Update only existing runner-related specs. Do not create duplicate runner specs from this follow-up plan.
    - Reopen exactly these specs before adding ACs because the follow-up broadens implemented contracts that later tasks will implement:
      - `kspec item set @runner-process-invocation-inputs --status in_progress --no-cascade`
      - `kspec item set @runner-resolution-and-preflight --status in_progress --no-cascade`
      - `kspec item set @runner-invocation-semantics --status in_progress --no-cascade`
      - `kspec item set @runner-operator-surfaces --status in_progress --no-cascade`
    - Add these ACs to `@runner-process-invocation-inputs`:

      AC id: ac-relative-system-cwd-resolves-from-config-dir
      Given: A system runner config declares `process.cwd` as a relative path.
      When: kspec resolves the runner invocation contract, runs preflight, or spawns the adapter process.
      Then: The child-process cwd is the normalized path resolved relative to the directory that contains that system runner config file.

      AC id: ac-effective-adapter-command-preflighted
      Given: A runner-backed agent resolves to a registered adapter command and the runner does not override `process.executable`.
      When: runner validation or dispatch preflight checks whether the invocation can spawn.
      Then: The effective adapter command is checked under the runner-resolved cwd and process environment search path before prompt forwarding or dispatch acceptance.

    - Add these ACs to `@runner-resolution-and-preflight`:

      AC id: ac-registry-load-failure-reports-config-error
      Given: Project or system runner config exists but cannot be parsed or validated into an effective runner registry.
      When: kspec validates, lists, edits, or prepares an agent that references a runner.
      Then: The diagnostic identifies the runner registry as unavailable, identifies the failing config layer and config path, includes the validation or parse reason, and redacts secret-looking values.

      AC id: ac-registry-load-failure-blocks-runner-spawn
      Given: Project or system runner config exists but cannot be parsed or validated into an effective runner registry.
      When: kspec prepares a runner-backed one-shot or dispatched invocation.
      Then: No adapter process is spawned and no prompt content is forwarded until the registry-load error is fixed.

    - Add this AC to `@runner-invocation-semantics`:

      AC id: ac-dispatch-preflight-uses-canonical-session-id
      Given: Dispatch prepares a runner-backed task invocation and preflight needs session-scoped environment, diagnostics, or interpolation.
      When: the same invocation is later recorded as active and passed to `runInvocation`.
      Then: dispatch preflight and the actual invocation use the same canonical session id.

    - Add these ACs to `@runner-operator-surfaces`:

      AC id: ac-daemon-agent-patch-returns-runner-state
      Given: A daemon client updates an agent definition through the agent PATCH endpoint.
      When: the saved agent has a runner field or resolves through legacy adapter compatibility.
      Then: the response includes the same `adapter`, `resolved_adapter`, and redacted `runner_validation` shape that the agent list endpoint would return for that saved agent.

      AC id: ac-web-ui-invocation-rows-show-resolved-adapter
      Given: The Web UI displays active or queued invocation rows whose daemon payload includes a runner name and resolved adapter identity.
      When: the rows are rendered.
      Then: visible row text and the row's accessible label include both the runner identity and the resolved adapter identity.

    - Add notes to the touched specs naming this follow-up plan and the closure evidence that motivated the stricter ACs.

    Why:
    The runner layer landed functionally, but closure validation found several places where the specs let implementations satisfy the letter while preserving ambiguous runtime behavior: relative system cwd values were accepted without a deterministic base, registry-load failures could be collapsed into unknown-runner fallbacks, dispatch preflight could diverge from the actual invocation session, daemon mutation responses could be less enriched than list responses, and active/queued Web UI rows could hide resolved adapter identity behind weak presentation.

    How:
    - Use `kspec item get` to capture each touched spec before editing.
    - Use `kspec item ac add` for each new AC id exactly as written above.
    - Use `kspec item note` to record the follow-up context; do not edit unrelated ACs.
    - Do not mark any touched spec back to `implemented` in this task; implementation tasks provide that evidence later.

    Testing:
    - `kspec item get @runner-process-invocation-inputs`
    - `kspec item get @runner-resolution-and-preflight`
    - `kspec item get @runner-invocation-semantics`
    - `kspec item get @runner-operator-surfaces`
    - `kspec validate --refs --warnings-ok`

    Covers: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir, ac-effective-adapter-command-preflighted; @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error, ac-registry-load-failure-blocks-runner-spawn; @runner-invocation-semantics ac-dispatch-preflight-uses-canonical-session-id; @runner-operator-surfaces ac-daemon-agent-patch-returns-runner-state, ac-web-ui-invocation-rows-show-resolved-adapter

- title: Resolve system runner cwd deterministically
  slug: task-resolve-system-runner-cwd-deterministically
  priority: 1
  tags: [agents, runners, cwd, runtime]
  spec_ref: "@runner-process-invocation-inputs"
  depends_on:
    - "@task-tighten-runner-closure-gap-specs"
  description: |
    What:
    - Update runner config loading/resolution so a relative `process.cwd` from system runner config is normalized against the directory containing the system `runners.yaml` file, not against the daemon or CLI parent process cwd.
    - Keep absolute `process.cwd` values unchanged except for normal path normalization.
    - Preserve the existing rule that project runner config cannot supply `process.cwd`; only system runner config owns machine-local cwd policy.
    - Ensure the resolved invocation contract, preflight executable checks, session metadata/diagnostics summaries, and actual adapter spawn all consume the same normalized cwd string.
    - Update docs that currently describe `process.cwd` as system-config-relative so they match the implemented behavior.
    - Add regression tests covering:
      - relative system cwd resolves from the system config directory;
      - absolute system cwd remains absolute;
      - changing the parent process cwd does not change the resolved child cwd;
      - preflight and spawn use the normalized cwd.

    Why:
    The original plan said `process.cwd` could be system-config-relative, but the implementation stored and spawned the raw string. A relative cwd would therefore be interpreted relative to whichever shell, daemon, or test process launched kspec, which is not a stable machine-local runner policy.

    How:
    - Prefer resolving cwd during effective runner construction or immediately after loading the system layer, while the system config file path is still known.
    - If `mergeRunnerConfigs(...)` needs the system config path, extend its inputs or add a wrapper so tests cannot call the old raw merge path accidentally for cwd-sensitive behavior.
    - Keep diagnostics redacted as today; do not expose secret env values while adding cwd source/path details.
    - Do not change legacy adapter-backed invocation cwd behavior.

    Testing:
    - `npm test -- --fresh tests/runner-config.test.ts tests/agent-runner-resolver.test.ts tests/agent-runner-process.test.ts`
    - `npm run typecheck`
    - `kspec validate --refs --warnings-ok`

    Covers: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir, ac-runner-cwd-is-invocation-only, ac-invocation-diagnostics-identify-inputs

- title: Preserve registry-load failures as first-class runner diagnostics
  slug: task-runner-registry-load-failure-diagnostics
  priority: 1
  tags: [agents, runners, diagnostics, daemon, dispatch]
  spec_ref: "@runner-resolution-and-preflight"
  depends_on:
    - "@task-tighten-runner-closure-gap-specs"
  description: |
    What:
    - Add a shared redacted diagnostic shape for runner registry load failures. The shape must include a stable reason such as `runner_registry_unavailable`, the failing layer (`project` or `system` when known), the config path, and parse/validation issue messages with secret-looking values redacted.
    - Update runner validation/listing surfaces so malformed project or system runner config is reported as a registry-load/config error, not as an absent runner name.
    - Update one-shot invocation and dispatch preflight so a runner-backed agent blocks before spawn/prompt when the registry cannot be loaded.
    - Update daemon agent list, daemon agent PATCH, and dispatch-status API enrichment so they attach the registry-load diagnostic to runner-backed agents when the registry is unavailable instead of returning only legacy adapter fallback state.
    - Preserve legacy adapter-backed behavior for agents without `runner`: they may continue to list and invoke through the adapter path when runner config is absent or invalid.
    - Add tests proving malformed project config, malformed system config, and validation issues distinguish registry-unavailable from true unknown-runner diagnostics.

    Why:
    Collapsing loader failures into an empty registry makes a malformed YAML/schema problem look like `unknown_runner`, and daemon responses may fabricate a resolved adapter from legacy fields. Operators need the real config-layer error so they know which file to fix before dispatch retries or UI debugging begins.

    How:
    - Reuse the existing `LayerLoadResult.issues` and config paths from `resolveEffectiveRunners(...)` instead of reparsing files in each surface.
    - Keep redaction at one helper boundary and reuse it for CLI output, task notes, daemon responses, session events, and Web UI payloads.
    - Do not include raw config contents in diagnostics.
    - In dispatch, task notes should include the stable reason and config path but no secret values.

    Testing:
    - `npm test -- --fresh tests/agent-runner-cli.test.ts tests/cli-agent.test.ts tests/daemon-agent-api.test.ts tests/agent-dispatch-engine.test.ts tests/agent-dispatch-api.test.ts`
    - `npm run typecheck`
    - `kspec validate --refs --warnings-ok`

    Covers: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error, ac-registry-load-failure-blocks-runner-spawn, ac-invalid-runner-blocks-before-prompt; @runner-environment-secret-boundaries ac-diagnostics-redact-secrets; @runner-operator-surfaces ac-daemon-agent-api-includes-runner

- title: Make dispatch preflight match the eventual runner invocation
  slug: task-dispatch-runner-preflight-invocation-equivalence
  priority: 1
  tags: [dispatch, agents, runners, preflight]
  spec_ref: "@runner-invocation-semantics"
  depends_on:
    - "@task-tighten-runner-closure-gap-specs"
    - "@task-resolve-system-runner-cwd-deterministically"
    - "@task-runner-registry-load-failure-diagnostics"
  description: |
    What:
    - Generate the dispatch invocation's canonical session id before runner preflight, and pass that same id to preflight, active invocation tracking, event emission, session context, and `runInvocation`.
    - Update dispatch preflight tests so any runner env/session injection or diagnostic interpolation sees the same `KSPEC_SESSION_ID` that appears in active invocation records and invocation lifecycle events.
    - Update runner preflight so runner-backed invocations check the effective adapter command under the resolved runner cwd and env search path even when `process.executable` is omitted and the command comes from the registered adapter.
    - Keep implicit/legacy adapter-only agents on their current compatibility path unless they are explicitly runner-backed.
    - Ensure deterministic unspawnable-command failures still take the AGENT-SKIP path: no active invocation, no prompt forwarding, no retry counter increment, and a redacted task note.

    Why:
    Dispatch currently runs a runner preflight before allocating the final tracked session id, so future session-scoped runner behavior can diverge between preflight and the actual invocation. Preflight also skips adapter command spawnability when no runner executable override exists, even though a runner's env/PATH policy still controls whether the adapter command can spawn.

    How:
    - Move `preSessionId = ulid()` before the preflight resolver call in `src/agent-runtime/dispatch.ts` and reuse it for every later session-id field.
    - Adjust `probeRunnerInvocationExecutable(...)` / `preflightRunnerInvocation(...)` to distinguish implicit legacy invocations from named runner-backed invocations; named runner-backed contracts should preflight the effective adapter command under runner env/cwd whether the command source is runner config or adapter registry.
    - Keep diagnostic details bounded to runner id, adapter id, command reference, and unspawnable reason.

    Testing:
    - `npm test -- --fresh tests/agent-dispatch-engine.test.ts tests/agent-runner-process.test.ts tests/agent-runner-e2e.test.ts`
    - `npm run typecheck`
    - `kspec validate --refs --warnings-ok`

    Covers: @runner-invocation-semantics ac-dispatch-preflight-uses-canonical-session-id, ac-dispatch-preflight-accepts-configured-runners, ac-dispatch-preflight-rejects-invalid-runners; @runner-process-invocation-inputs ac-effective-adapter-command-preflighted, ac-existing-executable-reference-resolves; @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution, ac-invalid-runner-blocks-before-prompt

- title: Align daemon mutation responses and Web UI invocation rows with runner state
  slug: task-runner-operator-surface-parity
  priority: 2
  tags: [daemon, web-ui, agents, runners, accessibility]
  spec_ref: "@runner-operator-surfaces"
  depends_on:
    - "@task-tighten-runner-closure-gap-specs"
    - "@task-runner-registry-load-failure-diagnostics"
  description: |
    What:
    - Refactor daemon agent enrichment so GET agent-list responses and PATCH `/api/meta/agents/:id` responses share the same code path for `adapter`, `resolved_adapter`, and redacted `runner_validation` fields.
    - Add daemon API tests where PATCH sets a valid runner, clears a runner, sets an unknown runner, and runs while the runner registry is unavailable. Assert the returned body matches the list endpoint's runner-state shape for the updated agent.
    - Update active and queued invocation row components so runner identity and resolved adapter identity are both visible in row text and available to assistive technology.
    - Preserve current compact display for legacy adapter-only rows, but ensure resolved adapter is still visible for those rows when daemon payloads provide it.
    - Add or update Web UI tests/E2E fixtures for runner-backed active rows, runner-backed queued rows, legacy rows, and invalid-runner diagnostics. The tests must assert rendered text or accessible labels, not only `title` attributes.

    Why:
    The list endpoint was enriched, but PATCH returned the raw saved agent, so API clients could observe a less complete contract immediately after editing runner fields. Active and queued rows also displayed runner identity while leaving resolved adapter identity weakly exposed. Operator surfaces should make the resolved harness visible wherever dispatch state is shown.

    How:
    - Prefer extracting a local helper in `packages/daemon/src/routes/meta.ts` or a shared daemon utility rather than duplicating enrichment logic.
    - Use daemon-provided fields in the Web UI; do not parse runner config in browser code.
    - Do not expose raw env maps or secret source values in UI or API payloads.

    Testing:
    - `npm test -- --fresh tests/daemon-agent-api.test.ts packages/web-ui/tests/e2e/agents.spec.ts`
    - `npm --workspace packages/web-ui run check`
    - `npm run typecheck`
    - `kspec validate --refs --warnings-ok`

    Covers: @runner-operator-surfaces ac-daemon-agent-patch-returns-runner-state, ac-web-ui-invocation-rows-show-resolved-adapter, ac-daemon-agent-api-includes-runner, ac-daemon-dispatch-active-api-includes-runner, ac-daemon-dispatch-queued-api-includes-runner, ac-web-ui-active-invocations-include-runner, ac-web-ui-queued-invocations-include-runner; @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
```

## Implementation Notes

- This is an existing-spec hardening plan. The `## Specs` block is intentionally empty so derivation does not create duplicate runner specs.
- The first task is the contract update. Later implementation tasks should treat the new ACs as already-approved behavior and should not invent alternate AC ids, field names, or UI/API payload shapes.
- The closure audit also observed broad `svelte-check` and dependency-audit failures. This follow-up includes the Web UI check where runner UI work touches that surface, but it does not turn unrelated dependency vulnerabilities into runner behavior specs. If those vulnerabilities remain after runner hardening, they should be handled by a separate dependency/security maintenance item.
- All runner process tests must use temp projects, temp daemon config dirs, fake adapters, and fake command roots. Do not run cwd/preflight/spawn tests against the live self-hosting checkout.
