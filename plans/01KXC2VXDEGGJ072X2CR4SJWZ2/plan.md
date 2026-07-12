# Dispatch Lifecycle Pause Resume and Stop Controls

**Goal:** Give operators durable, race-safe global and canonical-task dispatch pause, resume, and hard-stop controls without changing semantic task readiness or losing dispatch evidence.

**Architecture:** The daemon owns one explicit global lifecycle authority (`stopped | running | paused`) and a durable project-scoped registry of task controls keyed only by canonical task ULID. A paused engine or task may accept and coalesce trigger intent, but no paused scope may cross the final pre-spawn gate. Resume reconstructs candidates from authoritative task state and drains through existing deduplication. Stop is destructive to runtime scheduling state: it rejects new starts, removes matching queued entries, cancels matching active invocations, and closes their sessions, while preserving workspace and session evidence. `paused` plus a nonzero active count is the projected `draining` condition; draining is not a fourth authority state and pause is not degraded state.

**Tech Stack:** TypeScript, Elysia daemon routes, Commander CLI, SvelteKit UI, Zod/YAML persistence, Vitest, Playwright, kspec.

## Context and Binding Decisions

### Lifecycle matrix

| Scope/action | Accept trigger intent | Existing queue | New starts | Active invocation/session | Durable authority | Resume behavior |
| --- | --- | --- | --- | --- | --- | --- |
| Global pause | yes, coalesced by canonical task identity; reconciliation remains authoritative | preserved as held | forbidden | finishes naturally | engine state remains paused across daemon restart | rebuild/re-evaluate all eligible tasks, dedupe against preserved queue/active work, drain |
| Global resume | yes | revalidated | allowed after gate release | unchanged | engine state becomes running | one serialized reconciliation/drain; no duplicate task invocation |
| Global stop | no | cleared | forbidden | cancel all and close all sessions | engine state remains stopped across daemon restart | only explicit start/resume changes authority; candidates are reconstructed, not restored FIFO |
| Task pause | yes, coalesced for that canonical task | matching entries preserved as held; unrelated queue unchanged | forbidden only for that task | matching invocation finishes naturally | task control record survives bootstrap/reconciliation/restart | clear hold, re-evaluate that task, dedupe, drain; unrelated tasks unaffected |
| Task resume | yes | matching entries revalidated | allowed only for that task when global state permits | unchanged | task control becomes running/absent according to registry contract | one task-scoped serialized reconciliation/drain |
| Task stop | no for that task | matching entries removed | forbidden only for that task | cancel only matching invocation and close only matching session | durable stopped record | explicit task resume removes stopped gate and reconstructs from current task state; no old FIFO/retry entry is revived |

### State ownership and persistence

- The global authority is exactly `stopped | running | paused`. `draining` is a status projection when authority is paused and active count is nonzero. A paused scope with no active invocation projects `paused`.
- Global lifecycle state is durable project dispatch state, not inferred from whether an in-memory engine object exists. Daemon startup loads it before bootstrap, reconciliation, event handling, retry wake-ups, or any drain.
- Per-task controls are durable records keyed by canonical task ULID and contain `mode: paused | stopped`, sanitized reason, actor/source, `created_at`, and `updated_at`. Display slugs/titles are projections only. No raw or mismatched alias may create a second record.
- Semantic readiness remains owned by task status, dependencies, blocked state, and automation filters. Administrative dispatch controls neither mutate task status nor use `blocked`, `blocked_by`, automation eligibility, or degraded-target state as storage.
- The durable control registry is the only hold authority. Queue flags, UI state, session state, and workspace metadata are projections or evidence, never competing write authorities.
- Writes use the same shadow-safe mutation discipline as other project state and are atomic/idempotent. Repeating the same action updates no semantic state; a changed reason/actor updates metadata without multiplying records.

### Queue, restart, and recovery model

- Pause accepts matching trigger intent and coalesces it by `(canonical task ULID, agent/rule landing state)` while preserving already queued entries as held. Reconciliation is authoritative, so an implementation may avoid materializing an extra held queue row when the same candidate is reconstructible; status must still count one held task, not every duplicate trigger.
- Exact in-memory FIFO and retry timers are not promised across daemon restart. Startup and resume reconstruct eligible candidates from current authoritative task state, current agent rules, durable controls, workspace/session registries, and active invocation ownership.
- Resume never blindly releases stale queue bytes. It runs current staleness/readiness/filter checks and existing cross-agent per-task exclusivity before spawn. Repeated or concurrent resume requests collapse into one effective state transition and serialized drain.
- A global stop clears all in-memory queued/retry/coalescing work. A task stop clears only entries/timers/retries for that canonical task. Stopped candidates may be reconstructed only after an explicit corresponding resume/start and only if current state is still dispatchable.

### Race and cancellation model

- Every ingress and drain source checks controls: direct event, file watcher, bootstrap, periodic reconciliation, post-invocation re-evaluation, retry wake-up, coalescing timer, degraded-target recovery, and any future shared drain entrypoint.
- A final no-spawn gate runs after candidate dequeue/current-task validation and immediately before the first irreversible process/session creation boundary. If pause/stop wins before that gate, no process or session starts. If spawn wins first, pause drains it naturally and stop cancels it.
- Control mutations and final gate observation are ordered by one lifecycle mutex/epoch discipline. Dequeued-but-not-started entries are restored as held on pause, removed on stop, and remain cleanup-protected while in flight.
- Task cancellation is selected by canonical task ULID from active invocation details, aborts only matching controllers, closes only matching registry sessions, and cannot call global `closeAll`.
- Stop completion waits for targeted cancellation/session closure and any in-flight reconciliation/control mutation that could still spawn in scope. Cancellation timeout/failure is surfaced as an error/degraded operational result, not reported as a successful stop.

### Evidence and cleanup invariants

- Pause and stop never delete session logs/events, canonical task branches, workspace records, worker worktrees, reviewer snapshots, or audit/control events merely because dispatch was controlled.
- Active, in-flight, paused-held, and stopped-with-preserved-evidence task identities are supplied to centralized cleanup protection. Existing terminal/integration cleanup policy may later remove artifacts only when its normal authoritative conditions are independently satisfied.
- Task stop does not cancel the kspec task and does not imply workspace abandonment. Resuming the task reuses valid canonical workspace/session lineage where existing lifecycle contracts permit; it never invents a fresh identity to hide old evidence.

### Event and status projection

- Lifecycle transitions emit closed, typed dispatch-control events containing scope (`global | task`), action (`pause | resume | stop`), resulting authority, canonical task ULID/ref when task-scoped, sanitized reason, actor/source, timestamp, and idempotency/no-op outcome. Events contain no prompt, secret, terminal buffer, or workspace path.
- CLI/API/UI show authority (`running`, `paused`, `draining`, `stopped`), active/queued/held counts, held canonical tasks and reasons, and whether a hold comes from global or task scope. Global and task controls compose: task resume cannot bypass global pause/stop.
- `degraded` continues to describe target/sync operational inability. Paused/stopped are deliberate administrative state and never set or clear degraded state.

### Existing conflict that must be replaced, not hidden

`@agent-dispatch-engine ac-11` already requires explicit stop to cancel active agents and close sessions. `@cli-agent-commands ac-5` currently says explicit stop waits for active invocations to complete. These are incompatible. This plan assigns natural draining to pause and makes stop hard cancellation everywhere. The focused spec-patch task below must replace both ACs before implementation; additive wording alone is not acceptable.

## Non-goals

- No task lifecycle status, semantic readiness change, generic workflow cancellation framework, exact durable FIFO, cross-daemon distributed scheduler, process checkpoint/resume, workspace deletion on stop, or automatic task cancellation.
- One-shot `kspec agent run` invocations are outside dispatch lifecycle control unless they are registered as dispatch-owned active invocations.
- This plan is imported as draft only. Import does not approve, derive, mark automation eligible, or implement work.

## Specs

```yaml
- title: Dispatch Lifecycle Control Authority
  slug: dispatch-lifecycle-control-authority
  type: requirement
  description: |
    Dispatch lifecycle controls provide durable global and canonical-task administrative gates with distinct pause, resume, and hard-stop behavior while preserving semantic task readiness and operational evidence.
  acceptance_criteria:
    - id: ac-global-pause-drains-without-new-starts
      given: |
        global dispatch is running with zero or more active and eligible invocations
      when: |
        an operator pauses global dispatch
      then: |
        global authority becomes paused, no new invocation starts, queued or reconstructible eligible work is held, and active invocations finish naturally
    - id: ac-global-resume-reconciles-once-without-duplicates
      given: |
        global dispatch is paused with held or currently eligible work
      when: |
        an operator resumes global dispatch one or more times
      then: |
        authority becomes running and one serialized current-state reconciliation and drain starts each canonical task at most once
    - id: ac-global-stop-is-hard-and-durable
      given: |
        global dispatch has queued, held, in-flight, or active work
      when: |
        an operator stops global dispatch
      then: |
        authority becomes stopped, new starts are forbidden, queued and retry work is cleared, every dispatch-owned active invocation is cancelled, and its session is closed before success is reported
    - id: ac-task-pause-is-canonical-and-isolated
      given: |
        a task resolves to a canonical task ULID and unrelated tasks are dispatchable
      when: |
        an operator pauses dispatch for that task
      then: |
        only that canonical task is held from new starts, its active invocation may finish naturally, and unrelated tasks continue normally
    - id: ac-task-stop-is-targeted-and-evidence-preserving
      given: |
        a canonical task has queued, held, in-flight, or active dispatch work
      when: |
        an operator stops dispatch for that task
      then: |
        only matching scheduling work is removed and only matching active invocations and sessions are cancelled and closed, while task, session, branch, and workspace evidence is preserved
    - id: ac-task-resume-obeys-global-authority
      given: |
        a canonical task has a paused or stopped control record
      when: |
        an operator resumes that task
      then: |
        its task control gate is released and current state is re-evaluated without duplicates, but no invocation starts while global authority is paused or stopped
    - id: ac-controls-survive-restart-and-reconciliation
      given: |
        global or task dispatch controls are durable
      when: |
        the daemon restarts or bootstrap, reconciliation, retry, coalescing, post-invocation, or recovery scheduling runs
      then: |
        every path observes the same controls before enqueue and at the final pre-spawn gate
    - id: ac-final-gate-orders-pause-and-spawn
      given: |
        a pause or stop races a candidate between dequeue and process or session creation
      when: |
        lifecycle ordering chooses the winning operation
      then: |
        a winning control prevents process and session creation, while a winning spawn becomes active and is drained by pause or cancelled by stop according to the selected action
    - id: ac-control-state-is-distinct-from-readiness-and-degraded-state
      given: |
        a task is semantically ready or an integration target is degraded
      when: |
        dispatch control state is read or changed
      then: |
        task status, blocked state, automation eligibility, and degraded-target state remain unchanged and the durable control registry remains the only hold authority
    - id: ac-status-projects-authority-holds-and-counts
      given: |
        dispatch has any global state, task controls, active work, queued work, or held work
      when: |
        status is requested through CLI, API, or UI
      then: |
        each surface consistently reports running, paused, draining, or stopped; active, queued, and held counts; and held canonical tasks with scope and sanitized reason
    - id: ac-control-actions-are-idempotent-and-auditable
      given: |
        a global or task lifecycle action is repeated or delivered concurrently
      when: |
        the durable transition is applied
      then: |
        one resulting authority record exists, duplicate scheduling or cancellation effects do not occur, and a typed sanitized audit event identifies the action outcome
    - id: ac-restart-reconstructs-without-fifo-promise
      given: |
        the daemon restarts after paused or stopped scheduling state existed
      when: |
        dispatch later becomes eligible to run
      then: |
        candidates are reconstructed from current authoritative task and registry state without promising restoration of prior in-memory FIFO or retry timing
```

## Existing Spec Changes To Materialize

Apply only the exact description/AC changes below. Preserve every unlisted AC id, trait, maturity, implementation status, and metadata. The spec-patch task must make these changes through kspec CLI and must not edit YAML directly.

### `@agent-dispatch-engine`

Set `ac-11` to:

- **Given:** The dispatch engine has queued, in-flight, or active dispatch work.
- **When:** Global stop is requested or daemon shutdown performs global stop.
- **Then:** The engine atomically forbids new starts, clears queued/retry/coalescing work, sends cancellation to every dispatch-owned active invocation, closes every matching active session, waits for targeted shutdown work to settle, and reports stopped only after no scheduling path can create another invocation.

Add:

- `ac-pause-preserves-work-and-drains-active`: **Given** the dispatch engine is running with queued or active work; **When** global pause is requested; **Then** authority becomes paused, queued/reconstructible work is retained as held, no new invocation starts, and active invocations finish naturally without session cancellation.
- `ac-resume-reconciles-current-state`: **Given** the dispatch engine is paused with held or newly eligible tasks; **When** global resume succeeds; **Then** authority becomes running and one serialized current-state reconciliation and drain revalidates tasks and schedules no duplicate canonical-task invocation.
- `ac-final-control-gate-precedes-spawn`: **Given** a candidate passed queue and readiness checks; **When** it reaches the final boundary before process or session creation; **Then** current global and canonical-task controls are checked under lifecycle ordering and a paused or stopped scope creates neither process nor session.
- `ac-task-controls-scope-all-scheduling-paths`: **Given** a canonical task has a paused or stopped control; **When** event, bootstrap, reconciliation, post-invocation, retry, coalescing, or degraded-recovery scheduling evaluates it; **Then** no path starts that task and unrelated canonical tasks remain schedulable.

### `@cli-agent-commands`

Set description to:

> The `kspec agent` command family lists and runs agents and manages durable global and canonical-task dispatch lifecycle controls. Pause drains active work naturally, resume re-evaluates current work, and stop performs hard targeted cancellation.

Set `ac-5` to:

- **Given:** The dispatch engine has queued, in-flight, or active dispatch work.
- **When:** `kspec agent dispatch stop` is run.
- **Then:** The command requests hard global stop, clears scheduling work, cancels dispatch-owned active invocations, closes their sessions, and returns success only when global authority is stopped.

Add:

- `ac-global-pause-resume-commands`: **Given** the daemon is running; **When** `kspec agent dispatch pause` or `kspec agent dispatch resume` is run; **Then** the command applies the idempotent global lifecycle transition and reports paused/draining or running state in human and JSON output.
- `ac-task-lifecycle-commands-use-canonical-identity`: **Given** a task ref resolves uniquely; **When** `kspec agent dispatch task pause|resume|stop @task --reason <text>` is run; **Then** the command targets the canonical task ULID, reports the resulting task control, and rejects missing, ambiguous, or mismatched identity without effects.
- `ac-status-distinguishes-held-work`: **Given** global or task controls hold work; **When** agent or dispatch status is run; **Then** human and JSON output include lifecycle projection, active/queued/held counts, and held task refs, scope, mode, and sanitized reasons.

### `@daemon-agent-dispatch`

Add:

- `ac-lifecycle-api-is-scope-explicit`: **Given** a valid project context; **When** the dispatch lifecycle API receives global or task pause, resume, or stop; **Then** it validates the closed action and scope, canonicalizes task identity when required, applies one idempotent transition, and returns the resulting authority and counts.
- `ac-status-api-projects-controls`: **Given** lifecycle controls or held work exist; **When** daemon dispatch status is requested; **Then** the response includes global authority and projection, active/queued/held counts, durable task controls, and held reasons without exposing secrets or workspace paths.
- `ac-control-api-errors-have-no-partial-effects`: **Given** identity validation, persistence, cancellation, or session closure fails; **When** a lifecycle request is processed; **Then** the API returns a structured actionable error and does not report the requested transition successful or leave an unreported partial scheduling state.

### `@ui-agent-dispatch`

Add:

- `ac-ui-exposes-distinct-lifecycle-actions`: **Given** the agent dispatch view is writable; **When** an operator views global or task controls; **Then** pause, resume, and hard stop are distinct labelled actions with confirmation for destructive stop and disabled states derived from current authority.
- `ac-ui-shows-draining-and-held-reasons`: **Given** dispatch is paused with active work or tasks are administratively held; **When** status refreshes; **Then** the UI shows draining versus paused versus stopped, active/queued/held counts, and canonical held tasks with scope and sanitized reason.
- `ac-ui-control-state-is-accessible-and-live`: **Given** lifecycle state changes through any client; **When** the control event is broadcast or status is refreshed; **Then** keyboard and screen-reader users receive an accessible live update and controls cannot imply that paused or stopped work is degraded or semantically blocked.

### `@dispatch-event-taxonomy`

Add:

- `ac-lifecycle-control-events-are-closed`: **Given** a dispatch lifecycle transition is attempted; **When** an audit/broadcast event is emitted; **Then** its event type comes from the closed dispatch-control taxonomy and distinguishes pause, resume, and stop without encoding the action in free-form text.

### `@dispatch-event-payload`

Add:

- `ac-lifecycle-control-payload-is-sanitized`: **Given** a lifecycle event is emitted; **When** its payload is validated; **Then** it contains scope, action, resulting authority, canonical task identity when task-scoped, sanitized reason, actor/source, timestamp, and idempotent/no-op outcome, and excludes prompts, secrets, terminal output, and workspace paths.

### `@dispatch-workspace-cleanup-policy`

Add:

- `ac-held-and-stopped-evidence-remains-protected`: **Given** a dispatch task is active, in-flight, paused-held, or stopped with preserved dispatch evidence; **When** any destructive cleanup surface evaluates its session, workspace, worktree, snapshot, root entry, or branch; **Then** lifecycle control alone never makes that artifact cleanup-eligible and centralized protection preserves it until existing terminal or integration cleanup authority independently permits removal.

## Tasks

```yaml
- title: Patch dispatch lifecycle owning specs exactly
  slug: task-patch-dispatch-lifecycle-specs
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  tags: [dispatch, specs, lifecycle]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-global-pause-drains-without-new-starts
    - @dispatch-lifecycle-control-authority ac-global-resume-reconciles-once-without-duplicates
    - @dispatch-lifecycle-control-authority ac-global-stop-is-hard-and-durable
    - @agent-dispatch-engine ac-11
    - @cli-agent-commands ac-5

    What:
    Materialize exactly the Existing Spec Changes To Materialize section before product implementation. Create the new plan-owned requirement through derivation, then use kspec CLI to replace the conflicting stop ACs and add every listed AC to the exact existing owners.

    Why:
    Existing engine ac-11 requires cancellation while CLI ac-5 promises natural completion. Pause must own draining and stop must own cancellation; additive prose would leave automation with contradictory authority.

    How:
    - Apply the exact descriptions and full Given/When/Then wording in this plan, allowing only formatting or line wrapping differences.
    - Preserve all unlisted AC ids, traits, maturity, implementation status, titles, and metadata.
    - Do not rename existing AC ids or create sibling specs for behavior already assigned above.
    - Use `kspec item set` and `kspec item ac set/add`; never edit `.kspec` YAML.
    - Run validation and read every changed item back.

    Sources of Truth:
    - This plan's Existing Spec Changes To Materialize section is the exact target text.
    - `@agent-dispatch-engine ac-11` and `@cli-agent-commands ac-5` are the explicit conflict pair.

    Files:
    - kspec shadow state only through CLI; no product, test, template, or generated file changes.

    Required tests:
    - Readback proves every exact AC id and wording is present and every unlisted AC remains.
    - Validation reports no new schema/reference errors.

    Verification:
    - `kspec item get @dispatch-lifecycle-control-authority`
    - `kspec item get @agent-dispatch-engine`
    - `kspec item get @cli-agent-commands`
    - `kspec item get @daemon-agent-dispatch`
    - `kspec item get @ui-agent-dispatch`
    - `kspec item get @dispatch-event-taxonomy`
    - `kspec item get @dispatch-event-payload`
    - `kspec item get @dispatch-workspace-cleanup-policy`
    - `kspec validate --warnings-ok`

    Review handoff:
    - Provide the exact changed refs/AC ids and validation output; explicitly confirm no product code changed.

- title: Define durable dispatch control schemas and store
  slug: task-dispatch-control-persistence
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-patch-dispatch-lifecycle-specs"]
  tags: [dispatch, schema, persistence]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-controls-survive-restart-and-reconciliation
    - @dispatch-lifecycle-control-authority ac-control-state-is-distinct-from-readiness-and-degraded-state
    - @dispatch-lifecycle-control-authority ac-control-actions-are-idempotent-and-auditable

    What:
    Add the closed lifecycle/control types and one durable project-scoped control store: global `stopped|running|paused`, plus task `paused|stopped` records keyed only by canonical task ULID with reason, actor/source, and timestamps.

    Why:
    In-memory booleans disappear on restart and task status is semantic product state, not administrative dispatch authority.

    How:
    - Add Zod/type contracts and a CLI-safe parser/writer colocated with dispatch runtime state; use existing shadow-safe atomic mutation patterns.
    - Bootstrap missing legacy state as `stopped` when no engine is running; preserve explicit stored state thereafter.
    - Canonicalize task refs before writes; reject aliases that do not resolve to exactly one matching ULID.
    - Make repeated same-state writes no-op outcomes; metadata changes update one record, never duplicate it.
    - Do not store queue rows, exact FIFO, readiness, degraded state, workspace paths, prompts, or session output.

    Sources of Truth:
    - Plan State ownership and persistence decisions.
    - `src/agent-runtime/task-identity.ts` for canonical identity.
    - Existing parser/schema and shadow mutation services for durable project state.

    Files:
    - new schema under `src/schema/`
    - new parser/store under `src/parser/` or `src/agent-runtime/`
    - export barrels and focused tests

    Required tests:
    - Missing/valid/malformed store loads; atomic write failure; same-action idempotency; reason update; canonical slug/ULID convergence; mismatched identity rejection.
    - Restart reload preserves global pause/stop and task controls.
    - Assertions prove no task status, blocked_by, automation, or degraded state mutation.

    Verification:
    - `npm test -- tests/dispatch-control-store.test.ts tests/dispatch-task-identity.test.ts`
    - `npm run typecheck`
    - `npm run lint`
    - `kspec validate --warnings-ok`

    Review handoff:
    - Include persisted shape, default/migration behavior, idempotency table, and tests proving separation from task readiness.

- title: Introduce engine lifecycle authority and global pause resume
  slug: task-engine-global-pause-resume
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-dispatch-control-persistence"]
  tags: [dispatch, engine, lifecycle]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-global-pause-drains-without-new-starts
    - @dispatch-lifecycle-control-authority ac-global-resume-reconciles-once-without-duplicates
    - @agent-dispatch-engine ac-pause-preserves-work-and-drains-active
    - @agent-dispatch-engine ac-resume-reconciles-current-state

    What:
    Replace the loose in-memory running boolean as public authority with the durable lifecycle state and implement global pause/resume while preserving active natural completion and held work.

    Why:
    Current `running=false` conflates hard shutdown and scheduling gate, clears queues, aborts sessions, and cannot represent draining.

    How:
    - Load authority before bootstrap and expose `paused + active>0` as draining projection only.
    - While paused, accept/coalesce trigger intent and retain or reconstruct held candidates, but do not drain into spawn.
    - Resume through one lifecycle-serialized transition, full current-state evaluation, stale pruning, cross-agent task dedupe, and serialized drain.
    - Ensure event ingress, bootstrap, reconciliation, post-invocation, retry, coalescing, and degraded recovery cannot bypass global pause.
    - Do not implement hard stop cancellation or task controls in this slice.

    Sources of Truth:
    - Lifecycle matrix and queue/restart model in this plan.
    - `src/agent-runtime/dispatch.ts` start, handleStateChange, bootstrap, reconcile, serialized drain, retry, and recovery paths.
    - `@per-task-dispatch-drain-coalescing` remains authoritative for event timer serialization.

    Files:
    - `src/agent-runtime/dispatch.ts`
    - control store integration
    - `tests/agent-dispatch-engine.test.ts`
    - new focused global lifecycle tests

    Required tests:
    - Pause with zero and multiple active invocations; active completes and no successor starts.
    - Event/bootstrap/reconcile/post-completion/retry/coalescing/recovery while paused produce held, not started, work.
    - Repeated/concurrent resume schedules each canonical task at most once and stale tasks never start.
    - Pause/restart remains paused and resume reconstructs without FIFO assumptions.

    Verification:
    - `npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-global-lifecycle.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Provide a spawn-path matrix showing each path's pause check and behavioral test.

- title: Add final pre-spawn lifecycle race gate
  slug: task-final-pre-spawn-control-gate
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-global-pause-resume"]
  tags: [dispatch, races, spawn]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-final-gate-orders-pause-and-spawn
    - @agent-dispatch-engine ac-final-control-gate-precedes-spawn

    What:
    Add one lifecycle-ordered no-spawn gate immediately before the first process/session creation boundary and preserve dequeue/in-flight cleanup protection across a losing race.

    Why:
    Checks only at enqueue or drain entry leave a pause race between dequeue, workspace provisioning, session registration, and adapter spawn.

    How:
    - Identify and document the exact first irreversible boundaries in `_spawnInvocation`, session registry, and `runInvocation`/spawner flow.
    - Use one mutex/epoch protocol shared with control mutations; do not scatter unsynchronized boolean checks.
    - If pause wins, restore the candidate as held without duplicate insertion; if stop wins, discard it; if spawn wins, register it active before releasing ordering.
    - Keep canonical task in in-flight cleanup protection during provision/dequeue/gate handoff.
    - Avoid holding lifecycle lock across long-running workspace provisioning or agent execution.

    Sources of Truth:
    - Race and cancellation model in this plan.
    - `src/agent-runtime/dispatch.ts`, `src/agent-runtime/invocation.ts`, `src/agents/spawner.ts`, session registry, and workspace protection contracts.

    Files:
    - `src/agent-runtime/dispatch.ts`
    - minimal invocation/session boundary hooks if required
    - deterministic race tests

    Required tests:
    - Barrier-controlled pause-before-gate creates no process/session.
    - Spawn-before-pause becomes active and drains naturally.
    - Candidate restoration is single and cleanup protection never gaps.
    - Concurrent drains and repeated pause/resume do not exceed concurrency or duplicate a task.

    Verification:
    - `npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-spawn-control-race.test.ts tests/dispatch-artifact-protection.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Name the exact gate line/boundary and include deterministic race evidence rather than timing sleeps.

- title: Implement hard global stop cancellation
  slug: task-engine-global-hard-stop
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-final-pre-spawn-control-gate"]
  tags: [dispatch, cancellation, sessions]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-global-stop-is-hard-and-durable
    - @agent-dispatch-engine ac-11
    - @cli-agent-commands ac-5

    What:
    Implement durable global hard stop: close scheduling ingress, clear queues/retries/coalescing, abort all dispatch-owned invocations, close all matching sessions, await settling, and report stopped only on success.

    Why:
    Stop semantics must remain distinct from pause and must resolve the existing engine/CLI conflict in favor of hard cancellation.

    How:
    - Persist stopped authority under lifecycle ordering before cancellation can race another start.
    - Cancel timers and queues, await in-flight reconciliation/control mutations, abort dispatch controllers, close registry sessions, and await running invocation promises.
    - Preserve session files/events and workspace records/artifacts.
    - Define bounded failure reporting: cancellation/session-close failure cannot return a false successful stop.
    - Keep daemon shutdown routed through the same global hard-stop primitive.

    Sources of Truth:
    - Existing `DispatchEngine.stop`, invocation abort controllers, `SessionRegistry.closeAll`, and multi-turn lifecycle.
    - Plan hard-stop and evidence invariants.

    Files:
    - `src/agent-runtime/dispatch.ts`
    - `src/agent-runtime/session-registry.ts`
    - daemon engine shutdown wiring
    - focused cancellation/session tests

    Required tests:
    - Active, idle multi-turn, retry-waiting, queued, and dequeued-in-flight cases all end with no new starts.
    - Sessions close as cancelled/interrupted, not successful; evidence files remain.
    - Restart remains stopped; repeated stop is no-op; stop failure is surfaced.

    Verification:
    - `npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-multi-turn-integration.test.ts tests/session-registry.test.ts tests/dispatch-global-lifecycle.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Include cancellation ordering, terminal session outcomes, and filesystem evidence before/after.

- title: Enforce canonical task pause resume scheduling isolation
  slug: task-engine-task-pause-resume
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-final-pre-spawn-control-gate", "@task-dispatch-control-persistence"]
  tags: [dispatch, tasks, holds]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-task-pause-is-canonical-and-isolated
    - @dispatch-lifecycle-control-authority ac-task-resume-obeys-global-authority
    - @agent-dispatch-engine ac-task-controls-scope-all-scheduling-paths

    What:
    Implement canonical-task pause/resume across every scheduler ingress and the final gate, with unrelated tasks continuing at normal concurrency.

    Why:
    Filtering only one queue path would let bootstrap/reconciliation/retry bypass the hold, and slug-keyed state could split one task into multiple controls.

    How:
    - Resolve task controls by ULID at event ingress, full scans, queue pruning/selection, retry/coalescing, recovery, and final gate.
    - Preserve one held candidate projection per canonical task/rule landing state while coalescing duplicates.
    - Pause lets a matching active invocation finish; it does not cancel or close its session.
    - Resume removes/releases the task gate, re-evaluates only current task state, dedupes against active/queued work, and still obeys global pause/stop.
    - Prove task A controls cannot delay, remove, cancel, or relabel task B.

    Sources of Truth:
    - Canonical identity contracts and plan lifecycle matrix.
    - Existing queue ordering, cross-agent exclusivity, and coalescing specifications.

    Files:
    - `src/agent-runtime/dispatch.ts`
    - task control store integration
    - canonical identity and scheduling tests

    Required tests:
    - Slug/ULID pause converge; mismatch rejects.
    - Active task A drains while task B starts; held A survives restart/reconcile.
    - Resume A under global pause starts nothing; global resume later starts A once.
    - All spawn-path matrix rows are behaviorally covered.

    Verification:
    - `npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-task-lifecycle.test.ts tests/dispatch-canonical-task-identity-integration.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Include canonical identity fixtures and unrelated-task isolation results.

- title: Implement targeted task hard stop and resumability
  slug: task-engine-task-hard-stop
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-task-pause-resume", "@task-engine-global-hard-stop"]
  tags: [dispatch, cancellation, tasks]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-task-stop-is-targeted-and-evidence-preserving
    - @dispatch-lifecycle-control-authority ac-task-resume-obeys-global-authority

    What:
    Add hard stop for one canonical task: remove its queued/retry/coalescing work, cancel only its active invocation, close only its session, preserve evidence, and define explicit resume reconstruction.

    Why:
    Global `closeAll` or unkeyed abort-controller storage would disrupt unrelated agents. Stopped task work must not silently resurrect until explicit resume.

    How:
    - Index active invocation details and abort/session ownership by canonical task ULID.
    - Add targeted session-registry close operation; never use `closeAll` for task stop.
    - Remove only matching queue, deferred, retry, coalescing, and drain-pending intent.
    - Persist stopped gate before cancellation and await targeted settling before success.
    - Task resume releases the gate and reconstructs from current state; it never revives old FIFO/retry bytes and reuses valid workspace lineage.

    Sources of Truth:
    - Active invocation/session registry and multi-turn lifecycle specs.
    - Plan cancellation, persistence, and evidence decisions.

    Files:
    - `src/agent-runtime/dispatch.ts`
    - `src/agent-runtime/session-registry.ts`
    - invocation active-detail types
    - targeted stop tests

    Required tests:
    - Two tasks active under different/same agents: stopping A aborts/closes only A and B completes.
    - Matching queued/retry/coalesced/in-flight A is removed while B remains.
    - Evidence/workspace bytes remain; restart does not resurrect A; explicit resume reconstructs once if still eligible.
    - Repeated/concurrent stop does not duplicate cancellation or closure.

    Verification:
    - `npm test -- tests/dispatch-task-lifecycle.test.ts tests/dispatch-multi-turn-integration.test.ts tests/session-registry.test.ts tests/dispatch-workspace-and-scheduler-flow.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Provide targeted ownership mapping and proof that unrelated controllers/sessions were untouched.

- title: Protect held dispatch workspaces and evidence from cleanup
  slug: task-protect-held-dispatch-evidence
  priority: 2
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on: ["@task-engine-task-hard-stop"]
  tags: [dispatch, cleanup, workspaces]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-task-stop-is-targeted-and-evidence-preserving
    - @dispatch-workspace-cleanup-policy ac-held-and-stopped-evidence-remains-protected

    What:
    Extend centralized artifact protection inputs/classification to active, in-flight, paused-held, and stopped-with-preserved-evidence task identities across every destructive cleanup surface.

    Why:
    A task can have no active process after pause/stop but still own required workspace/session evidence. Existing active/in-flight-only protection can misclassify it as orphaned.

    How:
    - Feed durable task controls and in-flight gate ownership into the existing centralized protection decision.
    - Apply identical outcomes to worker worktrees, reviewer snapshots, roots, registry records, and branches.
    - Do not make controls permanent retention: existing task-terminal/integration cleanup authority remains decisive once independently satisfied.
    - Preserve quiet-default and opt-in diagnostics contracts; include control scope/mode without reason secrets.

    Sources of Truth:
    - `@dispatch-workspace-cleanup-policy`, `@dispatch-workspace-registry`, and existing artifact protection implementation/tests.
    - Plan Evidence and cleanup invariants.

    Files:
    - `src/agent-runtime/workspace.ts`
    - artifact protection helper/types
    - reconciliation callers and cleanup tests

    Required tests:
    - Every destructive surface preserves paused/stopped evidence.
    - Unknown/corrupt artifact policy remains unchanged when no protected identity matches.
    - Terminal/integration-authorized cleanup still proceeds after control removal/independent eligibility.
    - Diagnostics remain quiet by default and sanitized when enabled.

    Verification:
    - `npm test -- tests/dispatch-artifact-protection.test.ts tests/dispatch-workspace-cleanup.test.ts tests/dispatch-workspace-registry.test.ts tests/dispatch-workspace-terminal-reconciliation.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Supply a cleanup-surface matrix with protected and independently cleanup-eligible cases.

- title: Emit typed dispatch lifecycle control events
  slug: task-dispatch-lifecycle-events
  priority: 2
  spec_ref: "@dispatch-event-taxonomy"
  depends_on: ["@task-engine-task-hard-stop"]
  tags: [dispatch, events, audit]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-control-actions-are-idempotent-and-auditable
    - @dispatch-event-taxonomy ac-lifecycle-control-events-are-closed
    - @dispatch-event-payload ac-lifecycle-control-payload-is-sanitized

    What:
    Extend canonical event schemas/taxonomy and broadcast lifecycle transition/no-op outcomes from the shared control service.

    Why:
    CLI/API/UI need targeted freshness and operators need audit evidence, but free-form events risk divergent actions and secret leakage.

    How:
    - Add closed action/scope/authority fields and canonical task identity requirements.
    - Emit after durable transition outcome is known; represent idempotent no-op explicitly.
    - Sanitize/truncate reason according to one contract and exclude prompts, terminal buffers, secrets, and paths.
    - Route WebSocket invalidation through canonical agent topic without broad unrelated cache invalidation.

    Sources of Truth:
    - `src/agent-runtime/event-*`, dispatch taxonomy/payload schemas, daemon broadcasts, and UI ws invalidation.
    - Plan Event and status projection decisions.

    Files:
    - event schema/taxonomy modules
    - dispatch control service
    - daemon broadcast wiring
    - `packages/web-ui/src/lib/query/ws-invalidation.ts`
    - focused schema/event tests

    Required tests:
    - Global/task pause/resume/stop and no-op payload validation.
    - Missing task identity for task scope rejects; forbidden sensitive fields cannot serialize.
    - One durable outcome emits one event; failed transition emits no false success event.
    - UI agent-status query invalidates on lifecycle event only as intended.

    Verification:
    - `npm test -- tests/dispatch-event-schema.test.ts tests/agent-dispatch-engine.test.ts`
    - `npm --prefix packages/web-ui test -- ws-invalidation`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Include representative sanitized payloads and event-to-query invalidation evidence.

- title: Add scope-explicit daemon lifecycle APIs and status projection
  slug: task-daemon-dispatch-lifecycle-api
  priority: 2
  spec_ref: "@daemon-agent-dispatch"
  depends_on: ["@task-dispatch-lifecycle-events", "@task-protect-held-dispatch-evidence"]
  tags: [dispatch, daemon, api]
  description: |
    Covers:
    - @daemon-agent-dispatch ac-lifecycle-api-is-scope-explicit
    - @daemon-agent-dispatch ac-status-api-projects-controls
    - @daemon-agent-dispatch ac-control-api-errors-have-no-partial-effects
    - @dispatch-lifecycle-control-authority ac-status-projects-authority-holds-and-counts

    What:
    Expose closed global/task pause, resume, and stop requests plus one normalized status projection through canonical daemon routes; preserve documented compatibility aliases without duplicate serializers.

    Why:
    Current routes expose boolean start/stop and duplicate internal/public status shapes. New controls need canonical identity, held counts, reasons, and actionable failure semantics.

    How:
    - Define one request/response schema with explicit scope/action and required task ref for task scope.
    - Canonicalize identity server-side, even when clients supply slugs; reject mismatch before effects.
    - Reuse one status mapper for `/api/agent/status`, internal dispatch status, and control responses.
    - Return global authority/projection, active/queued/held counts, held tasks/control records, and existing degraded targets as a separate field.
    - Keep old start/stop forms as documented compatibility adapters to running/hard-stop, not alternate authority.

    Sources of Truth:
    - `src/daemon/routes/agent-dispatch.ts`, existing API tests, runner-aware status projection, and plan status contract.

    Files:
    - daemon agent-dispatch routes/schemas
    - shared status mapper/types
    - `tests/daemon-api/agent-dispatch.test.ts`
    - `tests/daemon-agent-dispatch-routes.test.ts`

    Required tests:
    - Every action/scope, idempotent repeat, invalid action, missing/ambiguous/mismatched task, persistence failure, and cancellation failure.
    - Status consistency across route aliases and compatibility fields.
    - Held counts coalesce duplicate triggers and compose global/task holds.
    - Degraded targets remain separate from deliberate control state.

    Verification:
    - `npm test -- tests/daemon-api/agent-dispatch.test.ts tests/daemon-agent-dispatch-routes.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Provide request/response examples, compatibility mapping, and route parity test output.

- title: Add global and task lifecycle CLI commands
  slug: task-cli-dispatch-lifecycle-controls
  priority: 3
  spec_ref: "@cli-agent-commands"
  depends_on: ["@task-daemon-dispatch-lifecycle-api"]
  tags: [dispatch, cli, lifecycle]
  description: |
    Covers:
    - @cli-agent-commands ac-5
    - @cli-agent-commands ac-global-pause-resume-commands
    - @cli-agent-commands ac-task-lifecycle-commands-use-canonical-identity
    - @cli-agent-commands ac-status-distinguishes-held-work

    What:
    Add `dispatch pause`, `dispatch resume`, hard `dispatch stop`, and `dispatch task pause|resume|stop @task` with reason/JSON support, plus lifecycle-aware status output.

    Why:
    Operators need explicit drain versus cancellation verbs; the current stop help text incorrectly calls hard cancellation graceful.

    How:
    - Use daemon API only; no direct store mutation from CLI.
    - Keep `start` as transition to running from stopped for compatibility and document resume as the paused-state verb.
    - Accept optional `--reason`; when omitted the server records the sanitized default `operator request`. Preserve structured errors and semantic exit codes.
    - Human output labels `draining` when paused with active work and lists active/queued/held counts and held canonical tasks.
    - JSON contains full API data with stable snake/camel convention matching existing command surface.

    Sources of Truth:
    - `src/cli/commands/agent.ts`, CLI traits, and daemon API contract from prerequisite task.

    Files:
    - `src/cli/commands/agent.ts`
    - CLI help/snapshot/integration tests
    - generated/shared docs only if existing command generation requires them

    Required tests:
    - Human/JSON success and no-op output for all actions.
    - Daemon absent, invalid task, mismatch, cancellation failure, and malformed reason errors.
    - Stop wording and behavior assert hard cancellation; pause wording asserts natural drain.
    - Status renders running/paused/draining/stopped and held reasons.

    Verification:
    - `npm test -- tests/agent-cli.test.ts tests/agent-dispatch-cli.test.ts tests/daemon-agent-dispatch-routes.test.ts`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Include `--help`, human, and JSON samples for each action and explicit conflict-resolution proof for stop.

- title: Build accessible dispatch lifecycle UI controls
  slug: task-ui-dispatch-lifecycle-controls
  priority: 3
  spec_ref: "@ui-agent-dispatch"
  depends_on: ["@task-daemon-dispatch-lifecycle-api"]
  tags: [dispatch, ui, accessibility]
  description: |
    Covers:
    - @ui-agent-dispatch ac-ui-exposes-distinct-lifecycle-actions
    - @ui-agent-dispatch ac-ui-shows-draining-and-held-reasons
    - @ui-agent-dispatch ac-ui-control-state-is-accessible-and-live
    - @dispatch-lifecycle-control-authority ac-status-projects-authority-holds-and-counts

    What:
    Update API types/client and agent dispatch surfaces with distinct global pause/resume/hard-stop controls, per-task held controls, status/count projections, and accessible live updates.

    Why:
    A boolean toggle cannot communicate draining versus hard cancellation and current pages hide active/queued work whenever dispatch_enabled is false.

    How:
    - Replace boolean-derived visibility with authority/projection; continue showing active invocations while draining and held rows while paused/stopped.
    - Add destructive confirmation for stop explaining cancellation and evidence preservation; pause explains active work continues.
    - Add task-scoped controls from held rows and active/queued task rows without exposing unrelated task controls.
    - Display reason/scope/mode, active/queued/held counts, and degraded state separately.
    - Use existing query mutation/invalidation and WebSocket lifecycle events; preserve static-mode safe defaults.
    - Ensure keyboard focus, labels, disabled/loading state, confirmation, live region, narrow viewport, and reduced-motion behavior.

    Sources of Truth:
    - `packages/web-ui/src/routes/agents/+page.svelte`, dispatch components, `$lib/api.ts`, query keys, and prerequisite API/event contracts.

    Files:
    - `packages/web-ui/src/lib/api.ts`
    - `packages/web-ui/src/routes/agents/+page.svelte`
    - dispatch status/row components
    - focused component tests and Playwright specs

    Required tests:
    - Every lifecycle projection and count combination, including paused+active draining.
    - Stop confirmation/cancel, pause no-confirm or non-destructive confirmation, task isolation, mutation failure recovery.
    - Keyboard/screen reader labels/live announcements and mobile layout.
    - Static mode and degraded-state separation.

    Verification:
    - `npm --prefix packages/web-ui test`
    - `npm run test:e2e -- --grep "dispatch lifecycle"`
    - `npm run typecheck`
    - `npm run lint`

    Review handoff:
    - Include screenshots/accessibility tree for running, draining, paused, and stopped plus failed-control state.

- title: Prove dispatch lifecycle recovery and race behavior end to end
  slug: task-verify-dispatch-lifecycle-e2e
  priority: 3
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on:
    - "@task-cli-dispatch-lifecycle-controls"
    - "@task-ui-dispatch-lifecycle-controls"
  tags: [dispatch, e2e, recovery]
  description: |
    Covers:
    - @dispatch-lifecycle-control-authority ac-controls-survive-restart-and-reconciliation
    - @dispatch-lifecycle-control-authority ac-restart-reconstructs-without-fifo-promise
    - @dispatch-lifecycle-control-authority ac-final-gate-orders-pause-and-spawn
    - @dispatch-lifecycle-control-authority ac-status-projects-authority-holds-and-counts

    What:
    Add black-box daemon/CLI/UI scenarios and an invariant audit proving lifecycle semantics across restart, all scheduling boundaries, races, cancellation, resume dedupe, and workspace cleanup.

    Why:
    Unit slices can each pass while a route alias, restart bootstrap, retry timer, or cleanup reconciliation bypasses the control authority.

    How:
    - Build deterministic fake adapters/barriers; do not use timing-only sleeps or real provider spend.
    - Exercise event, bootstrap, periodic reconcile, post-invocation, retry, coalescing, dequeue-to-spawn, and degraded-recovery boundaries.
    - Restart daemon while globally paused/stopped and task paused/stopped; verify authority loads before bootstrap.
    - Compare CLI/API/UI status from the same fixture and assert exact active/queued/held counts and reasons.
    - Audit all spawn and destructive cleanup call sites; record each as covered, preserved, or N/A with reason.
    - Run full project gates after focused suites.

    Sources of Truth:
    - This plan's lifecycle, queue/restart, race, evidence, and projection matrices.
    - All prerequisite behavioral contracts and current implementation call sites.

    Files:
    - daemon API integration tests
    - dispatch engine race/restart tests
    - CLI integration tests
    - web Playwright lifecycle spec
    - test fixtures/helpers only

    Required tests:
    - Global pause/drain/resume and hard stop with multiple tasks/agents.
    - Task pause/resume/stop isolation with active and queued unrelated work.
    - Restart reconstruction, repeated/concurrent controls, stale eligibility, no duplicate starts.
    - Pause-vs-spawn and stop-vs-spawn deterministic barriers.
    - Session/workspace evidence preservation and cleanup protection.
    - Cross-surface projection/event consistency and degraded-state separation.

    Verification:
    - `npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-global-lifecycle.test.ts tests/dispatch-task-lifecycle.test.ts tests/dispatch-spawn-control-race.test.ts tests/daemon-api/agent-dispatch.test.ts tests/daemon-agent-dispatch-routes.test.ts tests/dispatch-artifact-protection.test.ts`
    - `npm --prefix packages/web-ui test`
    - `npm run test:e2e -- --grep "dispatch lifecycle"`
    - `npm run format:check`
    - `npm run lint`
    - `npm run typecheck`
    - `npm test`
    - `kspec validate --warnings-ok`

    Review handoff:
    - Provide the completed spawn/cleanup boundary matrix, focused and full gate outputs, restart evidence, and any intentionally non-covered one-shot behavior.
```

## Implementation Order and Review Boundaries

1. Exact spec conflict patch.
2. Durable control vocabulary/store.
3. Global pause/resume authority.
4. Final pre-spawn race gate.
5. Global hard stop.
6. Canonical task pause/resume.
7. Targeted task stop/resume contract.
8. Cleanup/evidence protection.
9. Typed events.
10. Daemon API/status.
11. CLI and UI in parallel after API.
12. Cross-surface restart/race verification.

Each task is intentionally bounded for a short-running fresh agent. A reviewer should reject any slice that silently implements a later surface, overloads task status/degraded state, uses a slug as durable identity, calls global session closure for task stop, promises FIFO persistence, or proves races only with sleeps.
