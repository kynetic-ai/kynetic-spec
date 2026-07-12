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
- Shape: version `1`, monotonically increasing `revision` (nonnegative integer), `global.authority`, optional global reason/actor/source/timestamps, `tasks` keyed by canonical ULID with mode/reason/actor/source/timestamps, and `pending_cleanup` entries keyed by `global` or task ULID. The committed publication token is `{revision, commit_oid}`; `revision` is stored in the YAML and `commit_oid` is the shadow worktree `HEAD` that contains those exact bytes.
- `task-dispatch-control-persistence` creates `src/agent-runtime/dispatch-shadow-transaction.ts`. That module exports `withDispatchShadowTransaction(projectDir, operation, fn)` and `commitDispatchShadowTransaction(ctx, paths, message)`. It reuses the public `acquireFileLock` primitive from existing `src/parser/file-lock.ts` and the existing public `getDispatchShadowMutationLockPath` from `src/agent-runtime/workspace.ts`; it does not call or expose the private `withDispatchShadowMutationLock`. The transaction owner alone acquires that project lock, rolls back force-reclaimed dirty shadow state through existing `rollbackDirtyShadowWorktree`, re-reads every transaction input, writes all changed files atomically, invokes `commitIfShadow` once, and only after that commit publishes the validated dispatch-control snapshot. Lock order is dispatch-shadow lock first, then per-file `withFileLock` only inside parser writes; no caller may hold a parser file lock while acquiring the dispatch-shadow lock, and no engine/process/session wait occurs while either lock is held.
- `src/parser/dispatch-control.ts` owns schema parsing and atomic file replacement but never commits or publishes. `src/agent-runtime/dispatch-shadow-transaction.ts` owns the write/commit transaction and returns `{validatedSnapshot, revision, commit_oid}` only after `commitIfShadow` succeeds and a `git show <commit_oid>:.kspec/dispatch-control.yaml` re-read byte-for-byte parses to the same revision/snapshot. `src/agent-runtime/dispatch-control-store.ts` (Create, same persistence task) owns the last-valid snapshot and publication token. It publishes only that verified return value, never the pre-commit file.
- Existing `packages/daemon/src/project-context.ts` remains the chokidar event owner, but for `dispatch-control.yaml` it must not broadcast, call the dispatch callback, or invalidate cache from watcher-supplied `content`. It forwards only a path notification plus the observed shadow `HEAD` to `packages/daemon/src/server.ts`; server calls `DispatchControlStore.reloadCommitted(observedHead)`. Reload acquires the exported dispatch-shadow lock, reads current `HEAD`, reads the file through `git show HEAD:.kspec/dispatch-control.yaml` (never the worktree), validates it, and publishes/invalidate/broadcasts only when `{revision, HEAD}` is newer than and differs from the store token. If the event arrived before commit, `HEAD`/revision still equal the published token, so reload is a no-op; the transaction owner explicitly calls the same verified publication path after commit, making self-write delivery independent of watcher timing. A later duplicate self-write watcher event is suppressed by token equality. An external committed change is accepted only when current `HEAD` contains a valid file and its revision is strictly greater; an external dirty/uncommitted write, stale/lower revision, unknown commit, parse failure, commit failure, or post-commit verification mismatch retains the prior snapshot and prior cache, emits no success publication, and marks `control_store_degraded` where corruption/verification failed. Force-reclaim rollback re-reads verified `HEAD`, restores the worktree to it, and republishes only if that committed token is valid; rollback bytes are never published directly. `src/daemon/entity-cache.ts` invalidates dispatch-control and agent-status only after store publication. Watchers/cache never write authority. Behavioral fault tests deterministically cover watcher-before-commit, commit-before-watcher, duplicate self event, external committed update, external dirty write, commit failure, verification mismatch, stale revision, malformed committed revision, and force-reclaim rollback; no test may accept an uncommitted or failed snapshot.
- Missing legacy file migrates to `stopped` with no task controls. Version 1 loads exactly. Unknown versions, malformed data, duplicate/noncanonical task keys, or failed commit leave the last validated snapshot in force, reject mutations/startup scheduling, and report `control_store_degraded` with an actionable path; they never default to running.
- Durable invocation ownership lives in existing `.kspec-sessions/{session_id}/session.yaml`; schema owner is existing `src/sessions/types.ts` and persistence owner is existing `src/sessions/store.ts`. Version-1 dispatch ownership adds `dispatch_ownership?: {invocation_id, session_id, task_id:null|string, agent_id, adapter, owner_instance_id, pid:null|integer, pgid:null|integer, process_start_ticks:null|string, process_identity_platform:"linux_proc_stat_v1"|"unverifiable", captured_at, exited_at?}`. `process_start_ticks` is Linux `/proc/<pid>/stat` field 22 parsed after the final `)`; `owner_instance_id` is the daemon-instance ULID and `invocation_id/session_id/task_id/agent_id/adapter` bind the process to the exact dispatch target. The invocation owner writes session metadata before spawn with null process fields, then after child spawn reads PID, PGID, and start ticks and durably updates metadata before the engine publishes the invocation as active or admits stop ownership. If this post-spawn durability step fails, the same still-live owner cancels/reaps its just-created child directly and never exposes it as recoverable active work.
- Stop first commits `stopped` and one durable `pending_cleanup` entry. Each entry contains `cleanup_id` (ULID), `scope`, optional canonical `task_id`, `phase: "owned"|"signals_sent"|"sessions_closed"`, and immutable `targets[]`; every target copies the complete `dispatch_ownership` tuple plus the project-relative session metadata path. `DispatchEngine` writes `owned` from durable session ownership records before cancelling. Before any PID or process-group signal, the recovery/signalling helper re-reads session ownership, requires every copied ownership field to match, reads `/proc/<pid>/stat`, requires the same start ticks, and verifies the PGID still belongs to that verified PID. Only then may it signal the PID/PGID. Absent PID is receipted `not_found`; PID present with different start ticks, mismatched adapter/session/task/owner, reused PID/PGID, unreadable/malformed `/proc`, or a platform without equivalent birth verification is never signalled and remains pending with respectively `cleanup_identity_mismatch` or `cleanup_identity_unverifiable`. After signalling, it waits/rechecks the same birth identity: if leader exits but the verified process group survives, it may signal that group only while an originally verified member with a recorded birth token remains; otherwise cleanup stays pending/unverifiable. Never signal from PID/PGID alone.
- After every verifiably owned target exits, commit `signals_sent`; after every durable session record is terminal/closed, commit `sessions_closed`; only a final transaction removes the entry. Per-target receipts use `signal: not_found|sent|exited|identity_mismatch|identity_unverifiable|group_survived` and `session: already_closed|closed|closure_failed`. On startup, cleanup loads before bootstrap and closes surviving sessions through `src/sessions/store.ts`, not volatile `SessionRegistry`. Recovery is idempotent after every phase commit. Cancellation timeout/failure, identity mismatch/unverifiable, surviving unverifiable group, or closure failure keeps stopped authority and pending cleanup; success clears only after all receipts settle.
- Pause accepts/coalesces trigger intent; stop rejects it. Exact FIFO and retry deadlines are not durable promises. Resume/start reconstruct current eligible candidates and dedupe against active/queued canonical task identity.
- A final ordered gate immediately before first process/session creation rechecks global and task authority. Control winning the gate creates neither process nor session. Spawn winning first is active: pause drains it; stop cancels it.

### Events and wire contract

Add event domain `dispatch_control` to `src/schema/event-registry.ts` and `packages/shared/src/schemas.ts`. Exact identifiers are:

- `dispatch_control.pause_applied`
- `dispatch_control.start_applied`
- `dispatch_control.resume_applied`
- `dispatch_control.stop_applied`
- `dispatch_control.noop`
- `dispatch_control.failed`

Payload fields: `scope: "global"|"task"`, `action: "start"|"pause"|"resume"|"stop"`, `authority: "stopped"|"running"|"paused"`, `projection: "stopped"|"running"|"paused"|"draining"`, `outcome: "applied"|"noop"|"failed"`, `task_id?: string`, `task_ref?: string`, `reason: string`, `actor: string`, `source: "cli"|"api"|"ui"|"daemon_startup"|"daemon_shutdown"|"recovery"`, `timestamp: string`, `error_code?: DispatchControlErrorCode`. `DispatchControlErrorCode` is the closed enum `validation_failed | task_not_found | task_identity_ambiguous | task_identity_mismatch | invalid_transition | control_store_unavailable | control_store_corrupt | control_commit_failed | cancellation_timeout | cancellation_failed | session_closure_failed | cleanup_identity_mismatch | cleanup_identity_unverifiable | internal_error`; no other string is schema-valid. Task scope requires canonical `task_id`; global scope forbids task identity. Reason defaults to `operator request`, trims/collapses whitespace, removes control characters, and truncates to 240 Unicode code points. Actor truncates to 120; task_ref to 200. Prompts, secrets, terminal buffers, paths, stack traces, exception messages, and raw errors are forbidden from events.

Exact mapping is action-independent across `cli|api|ui|daemon_startup|daemon_shutdown|recovery`: applied start/pause/resume/stop emits respectively `start_applied|pause_applied|resume_applied|stop_applied`; every no-op emits `noop` with its original action and no `error_code`; every failure emits `failed` with its original action and exactly one closed code. The exhaustive failure map is: request/schema/reason/actor/task-identity-required validation → `validation_failed`, HTTP 400, CLI exit 1; no task resolution → `task_not_found`, 404, exit 3; multiple ref matches → `task_identity_ambiguous`, 409, exit 3; supplied ref/id disagreement or ownership tuple disagreement → `task_identity_mismatch`, 409, exit 3; matrix rejection → `invalid_transition`, 409, exit 3; store inaccessible/lock timeout/I/O unavailable → `control_store_unavailable`, 503, exit 3; malformed or unsupported committed control data → `control_store_corrupt`, 503, exit 3; shadow commit or committed-byte verification failure → `control_commit_failed`, 503, exit 3; bounded cancellation wait expires → `cancellation_timeout`, 500, exit 3; verified process signal/cancel fails → `cancellation_failed`, 500, exit 3; durable session close fails → `session_closure_failed`, 500, exit 3; recovery ownership/birth tuple mismatch including PID reuse → `cleanup_identity_mismatch`, 409, exit 3; birth identity cannot be verified or a surviving group has no verifiable recorded member → `cleanup_identity_unverifiable`, 503, exit 3; uncategorized implementation fault → `internal_error`, 500, exit 3. API `error.code` is the same enum; human `message/suggestion` is selected from a fixed server table and may not contain raw exceptions. Each attempt emits exactly one event after the durable outcome is known. Pre-commit failures use prior authority; post-commit cleanup failures use stopped authority and pending cleanup. Events broadcast on topic `agents`; all six invalidate `queryKeys.agents.all`, while the automation event log also refreshes.

Canonical API:

- `GET /api/agent/status`
- `POST /api/agent/dispatch/control` body `{scope, action, task_ref?, task_id?, reason?}`

Canonical `POST /api/agent/dispatch/control` uses the envelope: success/no-op is HTTP 200 and returns `{ok:true,data:{global_authority,projection,cleanup_state,active_count,queue_depth,held_count,held_tasks,task_controls,degraded_targets,outcome},error:null}`; errors use the exhaustive status map above and `{ok:false,data:<current status>,error:{code,message,suggestion,details?}}`. `details` may contain only typed field names/canonical ids, never raw exceptions or paths.

Compatibility adapters are frozen from current `packages/daemon/src/routes/agent-dispatch.ts` and tests, not replaced by the canonical envelope:

- `GET /api/agent/status` remains HTTP 200 and remains the unwrapped public snake_case object with every current field at top level: `{dispatch_enabled,active_invocations:[{session_id,agent_id,task_ref,task_title,elapsed_ms}],queue_depth,agent_definitions:[{id,name,adapter,completed_sessions}],degraded:{active,reason,enteredAt},degraded_targets:[{branch,reason,enteredAt,kind}]}`. Add top-level `global_authority,projection,cleanup_state,held_count,held_tasks,task_controls`; do not move old fields into `data`. Store unavailable/corrupt cannot safely project status and returns canonical error envelope with 503; other status-mapping faults return canonical error envelope with 500.
- `GET /api/agent/dispatch/status` remains HTTP 200 and unwrapped camelCase with every current field `{running,activeInvocations,queuedInvocations,invocations,queued,degraded,degradedTargets}` (including complete current invocation/queued item subfields), adding `globalAuthority,projection,cleanupState,heldCount,heldTasks,taskControls`. Store unavailable/corrupt returns `{running:false,activeInvocations:0,queuedInvocations:0,invocations:[],queued:[],degraded,degradedTargets,globalAuthority:"stopped",projection:"stopped",cleanupState:"unknown",heldCount:0,heldTasks:[],taskControls:[],error_code:<closed store code>}` with HTTP 503; internal mapping failure uses the same legacy shape plus `error_code:"internal_error"`, HTTP 500.
- `POST /api/agent/dispatch` accepts exactly current `{action:"start"|"stop"}`. Start success is 200 `{dispatch_enabled:true}`; already-running same cwd is 200 `{dispatch_enabled:true,reason:"Already running"}`; foreign/relative cwd is 400 `{dispatch_enabled:false,error:<existing fixed cwd message>}`; same-project different-cwd conflict is 409 `{dispatch_enabled:true,error:<existing conflict message>}`. Stop success is 200 `{dispatch_enabled:false}`; no engine is 200 `{dispatch_enabled:false,reason:"No engine running"}`. New pre-commit store/corrupt/commit failures are 503 `{dispatch_enabled:<prior running compatibility boolean>,error_code:<closed code>}`; post-commit cancellation/closure failures are 500 `{dispatch_enabled:false,reason:"cleanup_pending",error_code:<closed code>}`. Invalid action/body remains the existing Elysia 400 validation shape.
- `POST /api/agent/dispatch/start` has no body. Start success remains 200 `{started:true,status:<complete current internal engine status>}`; same-cwd no-op remains 200 `{started:false,reason:"Already running",status:<complete status>}`; foreign/relative cwd remains 400 `{started:false,error:<existing fixed cwd message>}`; different-cwd conflict remains 409 `{started:false,error:<existing conflict message>,status:<complete status>}`. New store/corrupt/commit failure is 503 `{started:false,error_code:<closed code>}`; internal start failure is 500 `{started:false,error_code:"internal_error"}`. Do not add `status` where the current 400 omits it.
- `POST /api/agent/dispatch/stop` has no body. Success remains 200 `{stopped:true}`; no engine remains 200 `{stopped:false,reason:"No engine running"}`. New pre-commit store/corrupt/commit failure is 503 `{stopped:false,error_code:<closed code>}`; post-commit cancellation/closure failure is 500 `{stopped:false,reason:"cleanup_pending",error_code:<closed code>}`; internal failure is 500 `{stopped:false,error_code:"internal_error"}`.

No deprecation header is introduced; comments/help may mark aliases deprecated. Exact regressions live in existing `tests/daemon-api/agent-dispatch.test.ts`, `tests/daemon-agent-dispatch-routes.test.ts`, `tests/daemon-api/agent-runner-surfaces.test.ts`, `tests/daemon-automation-routes.test.ts`, `tests/e2e/agents.spec.ts`, and `tests/cli-daemon-endpoint-regression.test.ts`. Compatibility booleans are true only for running authority, while active arrays remain visible during draining/pending cleanup.

### CLI safety and compatibility

Grammar:

- `kspec agent dispatch start [--reason TEXT] [--json]`
- `kspec agent dispatch pause [--reason TEXT] [--json]`
- `kspec agent dispatch resume [--reason TEXT] [--json]`
- `kspec agent dispatch stop [--reason TEXT] [--force] [--json]`
- `kspec agent dispatch task pause|resume @task [--reason TEXT] [--json]`
- `kspec agent dispatch task stop @task [--reason TEXT] [--force] [--json]`
- `kspec agent status [--json]`
- `kspec agent dispatch status [--json]`

Routing is exact: all mutating lifecycle commands use canonical `POST /api/agent/dispatch/control`; neither start nor stop CLI calls a legacy mutation alias after this task. `kspec agent status` preserves its current detailed invocation/queue projection and calls legacy-compatible `GET /api/agent/dispatch/status`, then adds authority/projection/held/cleanup fields without removing current human or JSON fields. `kspec agent dispatch status` also calls `GET /api/agent/dispatch/status`, preserves its current loaded-agent augmentation and daemon-offline success projection, and adds the same lifecycle fields. The public `GET /api/agent/status` is reserved for web/public consumers. Tests must assert the exact URL chosen by each command and fail if a status command is silently routed to the public endpoint or a mutation command to a legacy alias.

Interactive TTY hard stop without `--force` requires confirmation describing active cancellation and evidence preservation; decline exits 2 without request. `--force` suppresses the prompt. Non-interactive human stop without `--force` exits 1 with guidance. JSON never prompts and requires `--force`. Dispatch-owned contexts (`KSPEC_SESSION_ID`) reject global stop and task stop before prompting or HTTP with exit 3 even with `--force`, because an agent may not stop its host. Start/pause/resume do not confirm. Validation/usage exits 1; runtime/daemon/store/cancellation failures exit 3; success/no-op exits 0. Existing stop spelling remains hard stop, not graceful; help says “Hard-stop dispatch: cancel matching active invocations, close sessions, preserve evidence.” Pause help says active invocations finish naturally.

### UI consumer inventory and migration

Primary files: `packages/web-ui/src/lib/api.ts`, `packages/web-ui/src/routes/agents/+page.svelte`, `packages/web-ui/src/lib/components/agents/DispatchStatus.svelte`, `ActiveInvocationRow.svelte`, `QueuedInvocationRow.svelte`, new `HeldTaskRow.svelte`, `packages/web-ui/src/lib/query/ws-invalidation.ts`, and focused tests. Existing boolean/running consumers also owned by this migration: `packages/web-ui/src/routes/+page.svelte`, `packages/web-ui/src/routes/tasks/board/+page.svelte`, `packages/web-ui/src/lib/components/board/ActiveFleetRow.svelte`, `packages/web-ui/src/routes/automation/+page.svelte`, and `packages/web-ui/src/lib/components/automation/DispatchTriggersSection.svelte`.

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
      then: the matching invocation is cancelled
    - id: ac-task-stop-preserves-unrelated-invocations
      given: an unrelated dispatch-owned invocation is active
      when: stop cleanup completes for another canonical task
      then: the unrelated invocation remains active
    - id: ac-task-stop-closes-matching-session
      given: one canonical task has an active dispatch-owned session
      when: stop cleanup completes for that task
      then: the matching session is closed
    - id: ac-task-stop-preserves-unrelated-sessions
      given: an unrelated dispatch-owned session is active
      when: stop cleanup completes for another canonical task
      then: the unrelated session remains open
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
    - id: ac-only-committed-control-is-visible
      given: a dispatch-control worktree write is uncommitted, failed, stale, or invalid
      when: a watcher or same-process publisher observes it
      then: the last verified committed authority remains published
    - id: ac-recovery-signals-only-verified-processes
      given: stopped cleanup contains durable process ownership
      when: recovery considers a process or process group signal
      then: signalling occurs only after session ownership and process birth identity are verified
    - id: ac-final-gate-prevents-losing-spawn
      given: control wins ordering before process or session creation
      when: the candidate reaches the final start boundary
      then: neither a process nor a session is created
    - id: ac-spawn-win-pause-allows-completion
      given: spawn wins ordering before a control
      when: pause is applied
      then: the active invocation may finish naturally
    - id: ac-spawn-win-stop-cancels-invocation
      given: spawn wins ordering before a control
      when: stop cleanup completes
      then: the active invocation is cancelled
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
    - id: ac-failures-use-closed-error-codes
      given: a lifecycle action fails
      when: its event, API result, and CLI result are projected
      then: the failure uses the closed dispatch-control error code mapped to that failure class without exposing a raw error
    - id: ac-evidence-survives-control
      given: dispatch work is paused or stopped
      when: lifecycle control completes
      then: session, branch, workspace, worktree, snapshot, and audit evidence remain available under existing cleanup policy
```

## Exact Existing-Spec Changes

The spec-patch task applies only this wording with `kspec item set` and `kspec item ac set/add`. Preserve all unlisted IDs and metadata.

- `@agent-dispatch-engine ac-11`: **Given** global stop authority is committed. **When** hard-stop cleanup is incomplete. **Then** dispatch does not report stop success.
- Add `@agent-dispatch-engine ac-lifecycle-final-gate`: **Given** a candidate remains eligible after dequeue. **When** it reaches the final boundary before process or session creation. **Then** current global and canonical-task controls determine whether creation is permitted.
- Add `@agent-dispatch-engine ac-pause-active-natural-completion`: **Given** an invocation is active in a scope. **When** that scope is paused. **Then** the invocation may finish naturally and pause does not cancel its session.
- Add `@agent-dispatch-engine ac-resume-current-state`: **Given** a scope is paused. **When** it resumes. **Then** current task state and dispatch rules are re-evaluated before work starts.
- `@per-task-dispatch-drain-coalescing ac-5`: **Given** per-task coalescing timers are pending. **When** global or matching task stop authority commits. **Then** matching timers are cancelled, matching pending drains cannot start work, and any already-active invocation is handled by hard-stop cancellation.
- `@cli-agent-commands` description: The `kspec agent` family lists and runs agents and exposes durable global and canonical-task dispatch start, pause, resume, hard-stop, and status controls.
- `@cli-agent-commands ac-5`: **Given** dispatch-owned hard-stop cleanup is incomplete. **When** `kspec agent dispatch stop` reports its result. **Then** the command does not report stopped success.
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
- Add `@dispatch-event-taxonomy ac-dispatch-control-domain`: **Given** a lifecycle outcome is emitted. **When** event type validation runs. **Then** the identifier is one of `dispatch_control.start_applied`, `dispatch_control.pause_applied`, `dispatch_control.resume_applied`, `dispatch_control.stop_applied`, `dispatch_control.noop`, or `dispatch_control.failed`.
- Add `@dispatch-event-payload ac-dispatch-control-fields`: **Given** a dispatch-control event is emitted. **When** its payload is read. **Then** scope, action, authority, projection, outcome, reason, actor, source, and timestamp are present, and task scope also includes canonical task identity.
- Add `@dispatch-event-payload ac-dispatch-control-sanitization`: **Given** lifecycle event inputs contain sensitive or oversized text. **When** the payload is created. **Then** bounded sanitized fields are emitted without prompts, secrets, terminal buffers, workspace paths, or raw errors.
- Add `@dispatch-event-payload ac-dispatch-control-error-codes`: **Given** a dispatch-control failure is emitted. **When** payload validation and surface projection run. **Then** `error_code` is exactly one of `validation_failed`, `task_not_found`, `task_identity_ambiguous`, `task_identity_mismatch`, `invalid_transition`, `control_store_unavailable`, `control_store_corrupt`, `control_commit_failed`, `cancellation_timeout`, `cancellation_failed`, `session_closure_failed`, `cleanup_identity_mismatch`, `cleanup_identity_unverifiable`, or `internal_error`, and no raw error is present.
- Add `@dispatch-workspace-cleanup-policy ac-controlled-evidence-protected`: **Given** dispatch evidence belongs to active, in-flight, paused-held, or stopped-pending-cleanup work. **When** a destructive cleanup surface evaluates it. **Then** lifecycle control alone does not make the evidence cleanup-eligible.

## Coverage Ownership

| Contract | Primary closure owner |
| --- | --- |
| exact existing-spec text/materialization process (no behavioral closure) | `task-patch-dispatch-lifecycle-specs` |
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
    Covers: process-only exact spec text/materialization; claims no behavioral AC closure.
    What: Materialize the exact replacement/addition text through kspec CLI before product work.
    Why: Current stop contracts conflict, including @per-task-dispatch-drain-coalescing ac-5.
    How: Create the plan-owned requirement through derivation; use item set/ac set/ac add; preserve unlisted IDs, status, maturity, traits, metadata; no product code or YAML edits.
    Sources of Truth: Exact Existing-Spec Changes above and current item readback.
    Files: kspec shadow state only.
    Required tests: exact readback of all eight owners; unchanged unlisted ACs; validation.
    Verification: kspec item get on every named owner; kspec validate --warnings-ok.
    Review handoff: list changed refs/IDs and confirm no product files.

- title: Define durable dispatch control schema and store
  slug: task-dispatch-control-persistence
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-patch-dispatch-lifecycle-specs"]
  tags: [dispatch, schema, persistence]
  description: |
    Covers: ac-task-control-uses-canonical-identity, ac-controls-survive-restart, ac-only-committed-control-is-visible, ac-controls-do-not-change-readiness, ac-actions-are-idempotent.
    What: Implement version-1 `.kspec/dispatch-control.yaml` and its single parser/store authority exactly as frozen above.
    Why: No other slice can safely infer persistence, migration, locking, watcher, or corruption behavior.
    How: Create `src/agent-runtime/dispatch-shadow-transaction.ts` as the exported shared lock/commit owner and `src/agent-runtime/dispatch-control-store.ts` as snapshot owner; own schema/parser, index exports, watcher/cache mapping, atomic shadow-lock transaction, migration, corruption degradation, canonical ULID keys, and post-commit snapshot publication. Enforce the frozen lock order. Do not implement engine actions.
    Sources of Truth: Durable source of truth and recovery; `src/parser/yaml.ts`; dispatch shadow mutation discipline in `src/agent-runtime/workspace.ts`; `src/agent-runtime/task-identity.ts`.
    Files: Create `src/schema/dispatch-control.ts`, `src/parser/dispatch-control.ts`, `src/agent-runtime/dispatch-shadow-transaction.ts`, `src/agent-runtime/dispatch-control-store.ts`, and `tests/dispatch-control-store.test.ts`; update Existing `src/schema/index.ts`, `src/parser/index.ts`, `src/parser/file-lock.ts`, `src/agent-runtime/workspace.ts`, `packages/daemon/src/project-context.ts`, `packages/daemon/src/server.ts`, `src/daemon/entity-cache.ts`, `tests/daemon-entity-cache.test.ts`, and `tests/daemon-watcher-chokidar.test.ts`.
    Required tests: missing/version1/unknown/malformed; monotonic revision and canonical convergence/mismatch; atomic failure/lock concurrency; deterministic watcher-before-commit, commit-before-watcher, duplicate self event, external committed update, dirty external write, commit/verification failure, stale/malformed revision, and force-reclaim rollback; assert prior snapshot/cache remains and no uncommitted bytes publish; no readiness/degraded mutation.
    Verification: npm test -- tests/dispatch-control-store.test.ts tests/daemon-entity-cache.test.ts tests/daemon-watcher-chokidar.test.ts; npm run typecheck; npm run lint.
    Review handoff: persisted fixture, migration/corruption matrix, lock evidence.

- title: Implement global start pause resume authority
  slug: task-engine-global-lifecycle
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-dispatch-control-persistence"]
  tags: [dispatch, engine]
  description: |
    Covers: ac-global-pause-authority, ac-pause-allows-active-completion, ac-resume-reconciles-current-work, ac-resume-does-not-duplicate, ac-reconstruction-uses-current-state; @agent-dispatch-engine ac-resume-current-state.
    What: Apply the complete global start/pause/resume matrix, startup loading, held/coalesced intent, and current-state reconstruction.
    Why: Start and resume must not be interchangeable and pause must not clear evidence or active sessions.
    How: Update `src/agent-runtime/dispatch.ts`; load control before bootstrap; cover event, watcher, bootstrap, reconciliation, post-invocation, retry, coalescing and degraded recovery; keep stop/cancellation out.
    Sources of Truth: global matrix, queue/recovery contract, @per-task-dispatch-drain-coalescing.
    Files: `src/agent-runtime/dispatch.ts`, `tests/agent-dispatch-engine.test.ts`; create `tests/dispatch-global-lifecycle.test.ts`.
    Required tests: every matrix cell; daemon startup stopped/paused/running; held count coalescing; concurrent resume; no active cancellation on pause.
    Verification: npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-global-lifecycle.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts; typecheck; lint.
    Review handoff: matrix-to-test table and scheduling-ingress inventory.

- title: Enforce canonical task pause and resume
  slug: task-engine-task-pause-resume
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-global-lifecycle"]
  tags: [dispatch, tasks]
  description: |
    Covers: ac-paused-work-does-not-start, ac-task-control-is-isolated, ac-task-resume-obeys-global-authority.
    What: Apply task pause/resume at every scheduling path using canonical identity.
    Why: A path-specific or slug-keyed hold can leak starts or block another task.
    How: Update dispatch scheduling paths; pause keeps matching active work natural; resume re-evaluates only current task and obeys global authority. Consume persistence identity contract without claiming it.
    Sources of Truth: task matrix; `src/agent-runtime/task-identity.ts`; current dedupe/exclusivity.
    Files: `src/agent-runtime/dispatch.ts`; create `tests/dispatch-task-lifecycle.test.ts`; update canonical identity integration test.
    Required tests: task A/B isolation; slug/ULID convergence; every ingress; resume under global pause/stop; coalesced held counts.
    Verification: npm test -- tests/dispatch-task-lifecycle.test.ts tests/dispatch-canonical-task-identity-integration.test.ts; typecheck; lint.
    Review handoff: canonical identity and ingress matrices.

- title: Add final pre-spawn lifecycle gate
  slug: task-final-pre-spawn-control-gate
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-task-pause-resume"]
  tags: [dispatch, race]
  description: |
    Covers: ac-final-gate-prevents-losing-spawn, ac-spawn-win-pause-allows-completion; @agent-dispatch-engine ac-lifecycle-final-gate and ac-pause-active-natural-completion.
    What: Add the last global-and-task authority check before the first process/session creation boundary and classify the ordering winner.
    Why: Enqueue checks leave a dequeue-to-spawn race.
    How: Modify Existing `src/agent-runtime/dispatch.ts` and the minimal Existing `src/agent-runtime/invocation.ts` hook; restore a pause loser once, discard a stop loser before creation, and when spawn wins return an active ownership handoff for the later hard-stop task. This task must not signal, cancel, close sessions, claim stop completion, or implement stop recovery. Until the dependent hard-stop task lands, a spawn-wins-stop fixture asserts only the active ownership handoff and committed no-new-start authority, not cancellation.
    Sources of Truth: race contract; `_spawnInvocation`/`runInvocation`/SessionRegistry current boundaries.
    Files: Existing `src/agent-runtime/dispatch.ts`, `src/agent-runtime/invocation.ts`, and `tests/dispatch-artifact-protection.test.ts`; Create `tests/dispatch-spawn-control-race.test.ts`.
    Required tests: barrier-controlled global/task pause and stop before gate; spawn-before-pause natural completion; spawn-before-stop ownership handoff only; no timing sleeps; no protection gap.
    Verification: npm test -- tests/dispatch-spawn-control-race.test.ts tests/dispatch-artifact-protection.test.ts; npm run typecheck; npm run lint.
    Review handoff: exact irreversible boundary, ownership handoff, and deterministic traces.

- title: Implement recoverable global hard stop
  slug: task-engine-global-hard-stop
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-final-pre-spawn-control-gate"]
  tags: [dispatch, cancellation]
  description: |
    Covers: ac-stop-forbids-new-starts, ac-stop-cancels-active-work, ac-stop-closes-active-sessions, ac-stop-failure-remains-authoritative, ac-interrupted-stop-recovers, ac-recovery-signals-only-verified-processes, ac-spawn-win-stop-cancels-invocation; @agent-dispatch-engine ac-11 and @per-task-dispatch-drain-coalescing ac-5.
    What: Implement commit-first global stop, crash-safe ownership, verified cancellation, session closure, shutdown reuse, and recovery.
    Why: Failure after authority commit must not reopen dispatch or signal a reused/unowned process.
    How: Extend the exact Existing session schema owner `src/sessions/types.ts` and persistence owner `src/sessions/store.ts`; update dispatch/invocation/session registry and shutdown wiring; durably bind adapter/session/task/daemon ownership plus Linux birth ticks before active publication; persist stopped+pending first; verify complete tuple before every signal; never signal unverifiable identity; retry cleanup on startup/stop. Do not own HTTP serialization.
    Sources of Truth: durable ownership/recovery contract; current DispatchEngine.stop, SessionRegistry.closeAll, and session metadata store.
    Files: Existing `src/agent-runtime/dispatch.ts`, `src/agent-runtime/invocation.ts`, `src/agent-runtime/session-registry.ts`, `src/sessions/types.ts`, `src/sessions/store.ts`, `packages/daemon/src/routes/agent-dispatch.ts`, `tests/agent-dispatch-engine.test.ts`, `tests/active-session-registry.test.ts`, and `tests/dispatch-spawn-control-race.test.ts`; Create `tests/dispatch-stop-recovery.test.ts`.
    Required tests: pre/post-spawn ownership persistence failure; matching Linux birth token; absent process; PID/start-time reuse; adapter/session/task/owner mismatch; unreadable `/proc`; unsupported platform; leader exit with surviving verified/unverified group; cancellation timeout/failure; closure failure; crash after every phase; startup recovery; repeated stop; no signal for unverifiable targets; no false success.
    Verification: npm test -- tests/dispatch-stop-recovery.test.ts tests/dispatch-spawn-control-race.test.ts tests/active-session-registry.test.ts tests/agent-dispatch-engine.test.ts; npm run typecheck; npm run lint.
    Review handoff: session schema diff, process-identity decision table, signal trace, and cleanup fault results.

- title: Implement recoverable targeted task hard stop
  slug: task-engine-task-hard-stop
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-task-pause-resume", "@task-engine-global-hard-stop"]
  tags: [dispatch, cancellation, tasks]
  description: |
    Covers: ac-task-stop-cancels-matching-work, ac-task-stop-preserves-unrelated-invocations, ac-task-stop-closes-matching-session, ac-task-stop-preserves-unrelated-sessions, ac-task-stop-failure-remains-authoritative, ac-task-interrupted-stop-recovers.
    What: Stop one canonical task without disturbing unrelated work.
    Why: Global closeAll or ref aliases violate task isolation.
    How: Add targeted active-controller/session ownership and close-by-canonical-task; commit task stopped+pending first; remove matching queue/retry/coalescing only; retry cleanup; resume reconstructs current state.
    Sources of Truth: task matrix/recovery; active invocation detail; SessionRegistry.
    Files: Existing `src/agent-runtime/dispatch.ts`, `src/agent-runtime/session-registry.ts`, `src/sessions/types.ts`, `src/sessions/store.ts`, `tests/active-session-registry.test.ts`, `tests/dispatch-stop-recovery.test.ts`, and `tests/dispatch-task-lifecycle.test.ts` (created by prerequisite `@task-engine-task-pause-resume`).
    Required tests: A/B active and queued isolation; partial failure/restart recovery; repeated stop; evidence retained.
    Verification: npm test -- tests/dispatch-task-lifecycle.test.ts tests/active-session-registry.test.ts tests/dispatch-stop-recovery.test.ts; typecheck; lint.
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
    Covers: ac-control-outcomes-are-auditable; @dispatch-event-taxonomy ac-dispatch-control-domain; @dispatch-event-payload ac-dispatch-control-fields, ac-dispatch-control-sanitization, and ac-dispatch-control-error-codes.
    What: Materialize the exact domain, six identifiers, payload schema, limits, defaults, and emission mapping.
    Why: Event consumers cannot invent identifiers or sanitization.
    How: Update registry/domain, payload schema, shared mirror, engine/control emission and daemon `agents` broadcast; applied/no-op/failed exactly once after outcome; no raw error.
    Sources of Truth: Events and wire contract; `src/schema/event-registry.ts`, `src/schema/event-payloads.ts`, `packages/shared/src/schemas.ts`.
    Files: those files; dispatch emitter; create `tests/dispatch-control-events.test.ts`; update event/schema/shared tests.
    Required tests: all scope/action/outcomes; exhaustive closed error enum with unknown strings rejected; exact required/forbidden fields and no raw error/stack/path; Unicode limits; every mapped commit, store, transition, identity, cancellation, closure, recovery, and internal failure; registry mirror.
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
    Files: Existing `packages/daemon/src/routes/agent-dispatch.ts`, `tests/daemon-api/agent-dispatch.test.ts`, `tests/daemon-agent-dispatch-routes.test.ts`, `tests/daemon-api/agent-runner-surfaces.test.ts`, `tests/daemon-automation-routes.test.ts`, and `tests/cli-daemon-endpoint-regression.test.ts`.
    Required tests: canonical envelope and every action/transition; exact legacy field presence/absence, casing, nested invocation/queue/agent/degraded shapes, cwd 400, cwd conflict 409, current no-op reasons, Elysia invalid-body shape, and exact 500/503 adapters for every alias; closed code/status mapping; identity mismatch; cleanup pending; compatibility booleans and visible active arrays.
    Verification: npm test -- tests/daemon-api/agent-dispatch.test.ts tests/daemon-agent-dispatch-routes.test.ts tests/daemon-api/agent-runner-surfaces.test.ts tests/daemon-automation-routes.test.ts tests/cli-daemon-endpoint-regression.test.ts; npm run typecheck; npm run lint.
    Review handoff: curl/request examples and alias parity table.

- title: Add safe lifecycle CLI commands
  slug: task-cli-dispatch-lifecycle-controls
  priority: 3
  spec_ref: "@cli-agent-commands"
  depends_on: ["@task-daemon-dispatch-lifecycle-api"]
  tags: [dispatch, cli]
  description: |
    Covers: ac-failures-use-closed-error-codes; @cli-agent-commands ac-5, ac-lifecycle-verbs, ac-destructive-stop-confirmation, ac-task-control-canonicalization, ac-lifecycle-status-output.
    What: Implement the exact grammar, hard-stop confirmation, noninteractive/JSON rules, dispatch-owned rejection, help and exits.
    Why: Existing stop becomes destructive and must be safe without breaking spelling.
    How: Use daemon API only in `src/cli/commands/agent.ts`; route every mutation to canonical control and both existing status commands to legacy-compatible dispatch status exactly as frozen; canonical `--force` rules and exit/code mappings; default reason server-side; preserve both status projections and hard-stop help wording.
    Sources of Truth: CLI safety section; semantic-exit-code trait; current command.
    Files: Existing `src/cli/commands/agent.ts`, `tests/cli-agent-commands.test.ts`, `tests/cli-agent.test.ts`, and `tests/cli-daemon-endpoint-regression.test.ts`; Create `tests/cli-agent-dispatch-lifecycle.test.ts`.
    Required tests: TTY confirm accept/decline; piped/JSON missing/with `--force`; global/task stop with `KSPEC_SESSION_ID`; exact URL/method assertions for every mutation, `kspec agent status`, and `kspec agent dispatch status`; both existing human/JSON status field sets plus lifecycle projection; daemon-offline dispatch-status compatibility; every closed API code to exit mapping with no raw error; no-op/failure/help snapshots.
    Verification: npm test -- tests/cli-agent-commands.test.ts tests/cli-agent.test.ts tests/cli-agent-dispatch-lifecycle.test.ts tests/cli-daemon-endpoint-regression.test.ts; npm run typecheck; npm run lint.
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

## Path Classification

Classification is evaluated at each task's dependency point, not only against today's tree. Every source/test path is **Existing** unless its first owning task marks it **Create**, uses the word `new`, or it appears in this first-owner Create list: persistence creates `src/schema/dispatch-control.ts`, `src/parser/dispatch-control.ts`, `src/agent-runtime/dispatch-shadow-transaction.ts`, `src/agent-runtime/dispatch-control-store.ts`, and `tests/dispatch-control-store.test.ts`; global lifecycle creates `tests/dispatch-global-lifecycle.test.ts`; task pause/resume creates `tests/dispatch-task-lifecycle.test.ts`; pre-spawn gate creates `tests/dispatch-spawn-control-race.test.ts`; global hard stop creates `tests/dispatch-stop-recovery.test.ts`; events creates `tests/dispatch-control-events.test.ts`; CLI creates `tests/cli-agent-dispatch-lifecycle.test.ts`; UI creates `packages/web-ui/src/lib/components/agents/HeldTaskRow.svelte` and `tests/e2e/dispatch-lifecycle.spec.ts`; the three verification slices respectively create `tests/dispatch-lifecycle-blackbox.test.ts`, `tests/dispatch-lifecycle-surface-integration.test.ts`, and no additional browser file. Therefore `tests/dispatch-task-lifecycle.test.ts`, `tests/dispatch-spawn-control-race.test.ts`, `tests/dispatch-stop-recovery.test.ts`, and `tests/e2e/dispatch-lifecycle.spec.ts` are **Existing-by-that-task** in every dependent task that names them. Existing session ownership files are exactly `src/sessions/types.ts` and `src/sessions/store.ts`. `tests/web-ui/` is an **Existing directory**, not a file. No other missing path is an implicit deliverable.

## Implementation Order

Exact spec patch → persistence → global lifecycle → task pause/resume → race gate → global hard stop → targeted task hard stop → evidence/events → API → CLI/UI → three bounded verification slices. Each task is testable at its point: the race task returns stop ownership but does not cancel; global hard stop first owns verified cancellation; targeted stop then narrows that mechanism. Dependencies are acyclic and priorities never decrease. Import remains draft; do not approve, derive, or implement.
