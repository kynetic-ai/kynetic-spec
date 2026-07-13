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
- The shadow branch is orphaned and its tree root is the contents of the `.kspec/` worktree: the Git object path is exactly `dispatch-control.yaml`, not `.kspec/dispatch-control.yaml`. `src/parser/dispatch-control.ts` owns schema parsing and atomic worktree replacement but never commits or publishes. `src/agent-runtime/dispatch-shadow-transaction.ts` owns the write/commit transaction. It captures `pre_head` and the pre-write validated snapshot, writes under the shadow lock, and calls `commitIfShadow` once. `commitIfShadow === false` after changed bytes is `control_commit_failed`. A thrown/false ordinary commit failure resets the worktree to `pre_head`, re-reads `git show <pre_head>:dispatch-control.yaml`, restores/publishes that verified snapshot if valid, and only then releases the lock. After a successful commit it captures `commit_oid=HEAD` and verifies `git show <commit_oid>:dispatch-control.yaml` byte-for-byte parses to the proposed revision/snapshot. Verification failure resets the shadow branch/worktree to `pre_head`, re-reads and reloads the verified pre-commit snapshot, marks the store degraded, and only then releases the lock. Neither failure path publishes proposed or rollback worktree bytes. The transaction returns `{validatedSnapshot, revision, commit_oid}` only after successful committed-object verification. `src/agent-runtime/dispatch-control-store.ts` (Create, same persistence task) publishes only that verified return value.
- Existing `packages/daemon/src/project-context.ts` remains the chokidar event owner. For `dispatch-control.yaml` it records a path event and the HEAD observed at event time, but never broadcasts, invokes dispatch, invalidates cache, or publishes watcher `content`. `DispatchControlStore.reloadCommitted(observedHead)` acquires the exported shadow lock, then reads current `HEAD` and `git show HEAD:dispatch-control.yaml`. If the observed/current HEAD is unchanged from the published token, reload records that a pre-commit event was observed and installs one coalesced committed-HEAD reread to run after the current writer releases the lock and commit/abort/rollback settles; it may not discard that event permanently. The settled reread reacquires the lock and compares current HEAD with both the event-observed HEAD and the published token. A newer valid revision at current HEAD publishes exactly once even when an external writer committed after its earlier worktree event; an abort/rollback with unchanged HEAD is a deterministic no-op. If HEAD already differs when the first reload acquires the lock, it reads and applies that committed HEAD immediately. The transaction owner invokes the same committed-object publication path after its own verified commit, so self-write delivery is independent of watcher timing; token equality suppresses the later duplicate event. External dirty bytes never publish. Stale/lower revisions, unknown commits, parse failures, commit failures, and verification mismatches retain or reload the last verified committed snapshot before unlock, preserve prior cache, emit no success publication, and mark `control_store_degraded` for corruption/verification failure. `src/daemon/entity-cache.ts` invalidates dispatch-control and agent-status only after publication. Deterministic barrier tests cover watcher-before-external-commit followed by commit, watcher-before-abort, watcher-before-rollback, commit-before-watcher, duplicate self event, external committed update, external dirty write, ordinary commit false/throw, post-commit verification failure, stale/malformed revision, and force-reclaim rollback; each asserts no publication before commit and eventual single delivery of every valid externally committed newer HEAD.
- Missing legacy file migrates to `stopped` with no task controls. Version 1 loads exactly. Unknown versions, malformed data, duplicate/noncanonical task keys, or failed commit leave the last validated snapshot in force, reject mutations/startup scheduling, and report `control_store_degraded` with an actionable path; they never default to running.
- Durable invocation ownership lives in existing `.kspec-sessions/{session_id}/session.yaml`; schema owner is existing `src/sessions/types.ts` and persistence owner is existing `src/sessions/store.ts`. Version-1 dispatch ownership adds `dispatch_ownership?: {invocation_id, session_id, task_id:null|string, agent_id, adapter, owner_instance_id, pid:null|integer, pgid:null|integer, process_start_ticks:null|string, process_identity_platform:"linux_proc_stat_v1"|"unverifiable", captured_at, exited_at?}`. `process_start_ticks` is Linux `/proc/<pid>/stat` field 22 parsed after the final `)`; `owner_instance_id` is the daemon-instance ULID and `invocation_id/session_id/task_id/agent_id/adapter` bind the process to the exact dispatch target. The invocation owner writes session metadata before spawn with null process fields, then after child spawn reads PID, PGID, and start ticks and durably updates metadata before the engine publishes the invocation as active or admits stop ownership. If this post-spawn durability step fails, the same still-live owner cancels/reaps its just-created child directly and never exposes it as recoverable active work.
- Stop first commits `stopped` and one durable `pending_cleanup` entry. Each entry contains `cleanup_id` (ULID), `scope`, optional canonical `task_id`, `phase: "owned"|"signals_sent"|"sessions_closed"`, and immutable `targets[]`; every target copies the complete `dispatch_ownership` tuple plus the project-relative session metadata path. `DispatchEngine` writes `owned` from durable session ownership records before cancelling. Before any signal, the helper re-reads session ownership and distinguishes four cases: (1) any session/process ownership tuple field differs → `cleanup_ownership_mismatch`; (2) the recorded leader PID exists but `/proc/<pid>/stat` birth ticks differ, including PID reuse → `cleanup_process_birth_mismatch`; (3) birth/ownership evidence cannot be read or is unsupported → `cleanup_identity_unverifiable`; (4) the leader is absent → inspect the recorded PGID rather than receipt `not_found` immediately. A leader-absent target is `not_found` only when a platform-supported group existence check proves no process remains in the recorded PGID. On Linux, a surviving group is safely verified only by enumerating `/proc/[0-9]*/stat`, parsing each member after the final `)`, finding at least one member whose PGID equals the recorded PGID, and matching that member to an immutable member proof captured before active publication in the target record: `{pid, process_start_ticks}` plus the same invocation/session/task/agent/adapter/owner tuple. The plan extends ownership with `group_members:[{pid,process_start_ticks}]` captured from the spawned group before active publication and refreshed transactionally while the live owner can strongly bind additions. A matching recorded member permits group signalling; a surviving group with no matching recorded birth token is `cleanup_group_unverifiable`, remains pending, and is not signalled. Platforms without equivalent process-birth plus group-member enumeration proof also return `cleanup_group_unverifiable`. PID/PGID alone is never proof.
- After a signal, the helper repeats the same leader/group checks. `signals_sent` may commit only when each target is proven exited: the leader birth identity is absent and the recorded PGID is proven empty, or every surviving safely verified member has been signalled and the group is subsequently proven empty. A missing leader with a live verified group is not complete. A missing leader with a live unverifiable group remains pending. Session closure does not override a live/unverifiable process result. After every target is proven exited, commit `signals_sent`; after every durable session record is terminal/closed, commit `sessions_closed`; only then may a final transaction remove the entry. Per-target receipts use `signal: not_found|sent|exited|ownership_mismatch|process_birth_mismatch|identity_unverifiable|group_verified|group_unverifiable|group_survived` and `session: already_closed|closed|closure_failed`. Startup loads cleanup before bootstrap and closes sessions through `src/sessions/store.ts`, not volatile `SessionRegistry`. Recovery is idempotent after every phase commit. Timeout, signal failure, any mismatch/unverifiable result, surviving group, or closure failure keeps stopped authority and pending cleanup; no process group can remain alive while cleanup is marked complete.
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

Payload fields: `scope: "global"|"task"`, `action: "start"|"pause"|"resume"|"stop"`, `authority: "stopped"|"running"|"paused"`, `projection: "stopped"|"running"|"paused"|"draining"`, `outcome: "applied"|"noop"|"failed"`, `task_id?: string`, `task_ref?: string`, `reason: string`, `actor: string`, `source: "cli"|"api"|"ui"|"daemon_startup"|"daemon_shutdown"|"recovery"`, `timestamp: string`, `error_code?: DispatchControlErrorCode`. `DispatchControlErrorCode` is the closed enum `validation_failed | task_not_found | task_identity_ambiguous | task_identity_mismatch | invalid_transition | control_store_unavailable | control_store_corrupt | control_commit_failed | cancellation_timeout | cancellation_failed | session_closure_failed | cleanup_ownership_mismatch | cleanup_process_birth_mismatch | cleanup_leader_missing_group_alive | cleanup_identity_unverifiable | cleanup_group_unverifiable | internal_error`; unknown strings are invalid. The exhaustive failure map keeps identity classes disjoint: request/ref/id disagreement is `task_identity_mismatch` (409); copied versus current session/process ownership tuple disagreement is `cleanup_ownership_mismatch` (409); leader PID birth-token mismatch or PID reuse is `cleanup_process_birth_mismatch` (409); leader absent while a safely verified owned group is still alive is `cleanup_leader_missing_group_alive` (409 while cleanup remains pending); unreadable/malformed ownership or birth evidence is `cleanup_identity_unverifiable` (503); a live group lacking a durable strongly matching member proof, including unsupported platforms, is `cleanup_group_unverifiable` (503). The remaining map is: validation → `validation_failed`/400/CLI 1; no task → `task_not_found`/404/3; ambiguous ref → `task_identity_ambiguous`/409/3; invalid matrix transition → `invalid_transition`/409/3; inaccessible store/lock timeout/I/O → `control_store_unavailable`/503/3; malformed committed control data → `control_store_corrupt`/503/3; commit or committed-object verification failure → `control_commit_failed`/503/3; bounded cancellation timeout → `cancellation_timeout`/500/3; verified signal failure → `cancellation_failed`/500/3; durable session close failure → `session_closure_failed`/500/3; uncategorized fault → `internal_error`/500/3. Every listed cleanup code exits CLI 3. Every code is mapped unchanged through `dispatch_control.failed`, canonical `error.code`, canonical HTTP status, CLI JSON/human fixed message and exit, `GET /api/agent/dispatch/status.error_code`, and all three mutation compatibility adapters' `error_code`/status rules. Compatibility routes use 409 for the three mismatch/live-verified-group codes, 503 for the two unverifiable codes, and preserve their route-specific legacy fields; none emits a raw exception, stack, path, or dynamic error string. Task scope requires canonical `task_id`; global scope forbids task identity. Reason defaults to `operator request`, trims/collapses whitespace, removes control characters, and truncates to 240 Unicode code points; actor truncates to 120 and task_ref to 200. Applied actions emit their matching applied identifier, no-ops emit `noop` without `error_code`, and failures emit `failed` with exactly one code after the durable outcome is known. Events broadcast on `agents`; all six invalidate `queryKeys.agents.all`, and the automation event log also refreshes.

Canonical API:

- `GET /api/agent/status`
- `POST /api/agent/dispatch/control` body `{scope, action, task_ref?, task_id?, reason?}`

Canonical `POST /api/agent/dispatch/control` uses the envelope: success/no-op is HTTP 200 and returns `{ok:true,data:{global_authority,projection,cleanup_state,active_count,queue_depth,held_count,held_tasks,task_controls,degraded_targets,outcome},error:null}`; errors use the exhaustive status map above and `{ok:false,data:<current status>,error:{code,message,suggestion,details?}}`. `details` may contain only typed field names/canonical ids, never raw exceptions or paths.

Compatibility adapters are additive and preserve the following current field tables exactly; lifecycle additions never delete or rename them.

| Route/result | Required legacy fields | Conditional legacy fields |
| --- | --- | --- |
| `GET /api/agent/status` 200 | `dispatch_enabled`; `active_invocations[]` items `{session_id,agent_id,task_ref,task_title,elapsed_ms,resolved_adapter}`; `queued_invocations[]` items `{agent_id,task_ref,task_title,wait_ms,resolved_adapter}`; `queue_depth`; `agent_definitions[]` items `{id,name,adapter,resolved_adapter,completed_sessions}`; `degraded:{active,reason,enteredAt}`; `degraded_targets[]:{branch,reason,enteredAt,kind}` | active/queued items include `runner` only when configured; agent definitions include `runner` only when configured and `runner_validation:{status,diagnostics[]}` only when current resolution emits it; diagnostics retain current `reason,message,details?` projection |
| `GET /api/agent/dispatch/status` 200, engine present | `running,activeInvocations,queuedInvocations,invocations,queued,degraded,degradedTargets`; invocation item `{invocationId,sessionId,agentId,agentName,taskRef,elapsedMs,resolvedAdapter,runner}`; queued item `{agentId,agentName,taskRef,waitMs,runner,adapter}` | `taskRef`, `runner`, and `adapter` remain present with `undefined` omitted by JSON serialization exactly as today |
| `GET /api/agent/dispatch/status` 200, no engine | `{running:false,activeInvocations:0,queuedInvocations:0,invocations:[],degraded:{active:false,reason:"",enteredAt:null},degradedTargets:[]}` | current no-engine response omits `queued`; lifecycle additions are still appended |
| `POST /api/agent/dispatch` | start success `{dispatch_enabled:true}`; same-cwd no-op adds `reason:"Already running"`; cwd validation 400 `{dispatch_enabled:false,error:<fixed current message>}`; cwd conflict 409 `{dispatch_enabled:true,error:<fixed current conflict message>}`; stop success `{dispatch_enabled:false}`; no engine adds `reason:"No engine running"` | invalid body remains Elysia 400 validation details unchanged |
| `POST /api/agent/dispatch/start` | success `{started:true,status:<complete engine status>}`; no-op `{started:false,reason:"Already running",status:<complete status>}`; cwd 400 `{started:false,error:<fixed message>}`; conflict 409 `{started:false,error:<fixed conflict>,status:<complete status>}` | no `status` on cwd 400 |
| `POST /api/agent/dispatch/stop` | success `{stopped:true}`; no engine `{stopped:false,reason:"No engine running"}` | no additional legacy fields |

- `GET /api/agent/status` appends top-level `global_authority,projection,cleanup_state,held_count,held_tasks,task_controls` while retaining every table field and presence rule. It remains unwrapped HTTP 200 when mapping succeeds. Store unavailable/corrupt returns the canonical error envelope at 503; internal status mapping failure returns it at 500.
- `GET /api/agent/dispatch/status` appends `globalAuthority,projection,cleanupState,heldCount,heldTasks,taskControls` to the exact engine-present or no-engine shape above. On 503/500 it returns the corresponding legacy base shape plus those lifecycle fields and `error_code`; it does not invent `queued` in the no-engine/error base. `degraded` and `degradedTargets` remain present.
- Mutation compatibility adapters preserve the exact table shapes on 200/400/409 except for one deliberate security correction: cwd validation/conflict `error` values become fixed path-free messages (`"Invalid dispatch working directory"` and `"Dispatch is already running for another project"`) and do not preserve embedded project/cwd paths. This is an approved breaking sanitization of message text only. Invalid-transition 409 bodies are exact: `/api/agent/dispatch` returns `{dispatch_enabled:<current-running-boolean>,error:"Invalid dispatch lifecycle transition",error_code:"invalid_transition"}`; `/api/agent/dispatch/start` returns `{started:false,error:"Invalid dispatch lifecycle transition",status:<complete current status>,error_code:"invalid_transition"}`; `/api/agent/dispatch/stop` returns `{stopped:false,reason:"invalid_transition",error_code:"invalid_transition"}`.  New pre-commit store/corrupt/commit failures use 503 and append only route-appropriate `error_code` to `{dispatch_enabled:<prior-running>}`, `{started:false}`, or `{stopped:false}`. Post-commit cleanup failures use their mapped 409/500/503 status and `{dispatch_enabled:false,reason:"cleanup_pending",error_code}`, `{started:false,error_code}`, or `{stopped:false,reason:"cleanup_pending",error_code}` respectively. Uncategorized internal failures are 500 with the same route base and `internal_error`. Fixed compatibility `error` strings remain selected from current tables; raw errors are never forwarded.

No deprecation header is introduced; comments/help may mark aliases deprecated. Exact regressions assert full deep equality and forbidden-field absence for every row, including `queued_invocations`, `queue_depth`, active/queued runner and resolved-adapter projections, agent `adapter/resolved_adapter/runner/runner_validation`, no-op reason fields, Elysia validation details, cwd/project fields, complete internal `status`, and every 500/503 translation.

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
    - id: ac-global-paused-work-does-not-start
      given: global authority is paused
      when: eligible work is evaluated
      then: no new invocation starts
    - id: ac-task-paused-work-does-not-start
      given: one canonical task authority is paused
      when: eligible work for that task is evaluated
      then: no new invocation starts for that task
    - id: ac-global-pause-allows-active-completion
      given: an invocation is active when global authority is paused
      when: the invocation continues
      then: it may finish naturally
    - id: ac-task-pause-allows-active-completion
      given: an invocation is active when its canonical task authority is paused
      when: the invocation continues
      then: it may finish naturally
    - id: ac-global-pause-keeps-active-session-open
      given: a session belongs to an active invocation when global authority is paused
      when: pause is applied
      then: pause does not close that session
    - id: ac-task-pause-keeps-active-session-open
      given: a session belongs to an active invocation when its canonical task authority is paused
      when: pause is applied
      then: pause does not close that session
    - id: ac-resume-reconciles-held-work
      given: a paused scope contains held work
      when: that scope resumes
      then: current authoritative work is re-evaluated
    - id: ac-resume-reconciles-eligible-work
      given: a paused scope contains currently eligible work
      when: that scope resumes
      then: current authoritative work is re-evaluated
    - id: ac-repeated-resume-does-not-duplicate
      given: resume is repeated
      when: eligible work is drained
      then: each canonical task has at most one active invocation
    - id: ac-concurrent-resume-does-not-duplicate
      given: resume is concurrent
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
    - id: ac-task-control-preserves-unrelated-task-control
      given: one canonical task is controlled
      when: unrelated tasks are evaluated
      then: unrelated tasks remain governed by their own controls
    - id: ac-task-control-preserves-global-authority
      given: one canonical task is controlled
      when: unrelated tasks are evaluated
      then: unrelated tasks remain governed by global authority
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
    - id: ac-task-stop-failure-retains-stopped-authority
      given: stopped task authority committed and its cleanup failed
      when: status is requested
      then: that task remains stopped
    - id: ac-task-stop-failure-reports-pending-cleanup
      given: stopped task authority committed and its cleanup failed
      when: status is requested
      then: pending cleanup is reported
    - id: ac-task-stop-failure-reports-no-success
      given: stopped task authority committed and its cleanup failed
      when: status is requested
      then: no success outcome is reported
    - id: ac-task-interrupted-stop-recovers-on-startup
      given: stopped task authority has pending cleanup after interruption
      when: the daemon starts
      then: matching cleanup resumes without reopening that task
    - id: ac-task-interrupted-stop-recovers-on-retry
      given: stopped task authority has pending cleanup after interruption
      when: task stop is retried
      then: matching cleanup resumes without affecting unrelated tasks
    - id: ac-controls-survive-restart
      given: lifecycle authority is durable
      when: the daemon restarts
      then: the same authority governs scheduling before bootstrap
    - id: ac-uncommitted-control-is-not-visible
      given: a dispatch-control worktree write is uncommitted
      when: a watcher observes it
      then: the last verified committed authority remains published
    - id: ac-failed-control-write-is-not-visible
      given: a dispatch-control transaction fails
      when: same-process publication is considered
      then: the last verified committed authority remains published
    - id: ac-stale-control-is-not-visible
      given: a committed dispatch-control revision is stale
      when: committed reload is performed
      then: the last verified newer authority remains published
    - id: ac-invalid-control-is-not-visible
      given: committed dispatch-control data is invalid
      when: committed reload is performed
      then: the last verified committed authority remains published
    - id: ac-external-commit-is-eventually-visible
      given: a watcher path event precedes an external valid commit
      when: the writer settles
      then: the newer committed authority is published exactly once
    - id: ac-recovery-requires-session-ownership
      given: stopped cleanup contains durable process ownership
      when: recovery considers a signal
      then: signalling occurs only after session ownership is verified
    - id: ac-recovery-requires-process-birth
      given: stopped cleanup contains durable process ownership
      when: recovery considers a signal
      then: signalling occurs only after process birth identity is verified
    - id: ac-missing-leader-live-group-remains-pending
      given: the recorded leader is absent and its recorded process group is alive
      when: durable group-member ownership cannot be verified
      then: cleanup remains pending
    - id: ac-unverified-live-group-is-not-signalled
      given: the recorded leader is absent and its recorded process group is alive
      when: durable group-member ownership cannot be verified
      then: the group is not signalled
    - id: ac-live-group-prevents-cleanup-completion
      given: a recorded process group remains alive
      when: cleanup completion is evaluated
      then: cleanup is not marked complete
    - id: ac-final-gate-prevents-process-creation
      given: control wins ordering before process creation
      when: the candidate reaches the final start boundary
      then: no process is created
    - id: ac-final-gate-prevents-session-creation
      given: control wins ordering before session creation
      when: the candidate reaches the final start boundary
      then: no session is created
    - id: ac-spawn-win-pause-allows-completion
      given: spawn wins ordering before a control
      when: pause is applied
      then: the active invocation may finish naturally
    - id: ac-spawn-win-stop-cancels-invocation
      given: spawn wins ordering before a control
      when: stop cleanup completes
      then: the active invocation is cancelled
    - id: ac-controls-do-not-change-readiness
      given: task readiness state exists
      when: lifecycle control changes
      then: task readiness state remains unchanged
    - id: ac-controls-do-not-change-degraded-targets
      given: degraded target state exists
      when: lifecycle control changes
      then: degraded target state remains unchanged
    - id: ac-stop-failure-retains-stopped-authority
      given: stopped authority committed and cleanup failed
      when: status is requested
      then: stopped authority is reported
    - id: ac-stop-failure-reports-pending-cleanup
      given: stopped authority committed and cleanup failed
      when: status is requested
      then: pending cleanup is reported
    - id: ac-stop-failure-reports-no-success
      given: stopped authority committed and cleanup failed
      when: status is requested
      then: no success outcome is reported
    - id: ac-interrupted-stop-recovers-on-startup
      given: stopped authority has pending cleanup after interruption
      when: the daemon starts
      then: cleanup resumes without reopening scheduling
    - id: ac-interrupted-stop-recovers-on-retry
      given: stopped authority has pending cleanup after interruption
      when: stop is retried
      then: cleanup resumes without reopening scheduling
    - id: ac-paused-reconstruction-uses-current-state
      given: paused in-memory scheduling data was lost
      when: running becomes permitted
      then: candidates are reconstructed from current authoritative state
    - id: ac-stopped-reconstruction-uses-current-state
      given: stopped in-memory scheduling data was lost
      when: running becomes permitted
      then: candidates are reconstructed from current authoritative state
    - id: ac-status-reports-authority
      given: lifecycle status is requested
      when: the response is produced
      then: durable authority is reported
    - id: ac-status-reports-projection
      given: lifecycle status is requested
      when: the response is produced
      then: the running, paused, draining, or stopped projection is reported
    - id: ac-status-reports-active-count
      given: active work exists
      when: lifecycle status is requested
      then: the active count is reported
    - id: ac-status-reports-queued-count
      given: queued work exists
      when: lifecycle status is requested
      then: the queued count is reported
    - id: ac-status-reports-held-count
      given: held work exists
      when: lifecycle status is requested
      then: the held count is reported
    - id: ac-status-reports-held-task-identity
      given: canonical tasks are held
      when: lifecycle status is requested
      then: each held canonical identity is reported
    - id: ac-status-reports-held-task-scope
      given: canonical tasks are held
      when: lifecycle status is requested
      then: each held task scope is reported
    - id: ac-status-reports-held-task-mode
      given: canonical tasks are held
      when: lifecycle status is requested
      then: each held task mode is reported
    - id: ac-status-reports-held-task-reason
      given: canonical tasks are held
      when: lifecycle status is requested
      then: each held task sanitized reason is reported
    - id: ac-global-start-is-idempotent
      given: global start has already succeeded
      when: global start is repeated
      then: the observable result equals one successful start
    - id: ac-global-pause-is-idempotent
      given: global pause has already succeeded
      when: global pause is repeated
      then: the observable result equals one successful pause
    - id: ac-global-resume-is-idempotent
      given: global resume has already succeeded
      when: global resume is repeated
      then: the observable result equals one successful resume
    - id: ac-global-stop-is-idempotent
      given: global stop has already committed
      when: global stop is repeated
      then: the observable result equals one successful stop plus any pending cleanup retry
    - id: ac-task-pause-is-idempotent
      given: task pause has already succeeded
      when: pause is repeated for that canonical task
      then: the observable result equals one successful task pause
    - id: ac-task-resume-is-idempotent
      given: task resume has already succeeded
      when: resume is repeated for that canonical task
      then: the observable result equals one successful task resume
    - id: ac-task-stop-is-idempotent
      given: task stop has already committed
      when: stop is repeated for that canonical task
      then: the observable result equals one successful task stop plus any pending cleanup retry
    - id: ac-applied-control-is-auditable
      given: a lifecycle action is applied
      when: its durable outcome is known
      then: one sanitized typed applied event is emitted
    - id: ac-noop-control-is-auditable
      given: a lifecycle action is a no-op
      when: its durable outcome is known
      then: one sanitized typed no-op event is emitted
    - id: ac-failed-control-is-auditable
      given: a lifecycle action fails
      when: its durable outcome is known
      then: one sanitized typed failed event is emitted
    - id: ac-failure-events-use-closed-error-codes
      given: a lifecycle action fails
      when: its event is projected
      then: the event uses the closed code mapped to that failure class
    - id: ac-failure-api-uses-closed-error-codes
      given: a lifecycle action fails
      when: its API result is projected
      then: the API uses the closed code mapped to that failure class
    - id: ac-failure-cli-uses-closed-error-codes
      given: a lifecycle action fails
      when: its CLI result is projected
      then: the CLI uses the closed code mapped to that failure class
    - id: ac-api-failures-do-not-expose-raw-errors
      given: a lifecycle action fails
      when: the canonical API reports it
      then: no raw error is exposed
    - id: ac-cli-failures-do-not-expose-raw-errors
      given: a lifecycle action fails
      when: the CLI reports it
      then: no raw error is exposed
    - id: ac-ui-failures-do-not-expose-raw-errors
      given: a lifecycle action fails
      when: the web UI reports it
      then: no raw error is exposed
    - id: ac-session-evidence-survives-control
      given: dispatch work is controlled
      when: lifecycle control completes
      then: session evidence remains available under existing cleanup policy
    - id: ac-branch-evidence-survives-control
      given: dispatch work is controlled
      when: lifecycle control completes
      then: branch evidence remains available under existing cleanup policy
    - id: ac-workspace-evidence-survives-control
      given: dispatch work is controlled
      when: lifecycle control completes
      then: workspace evidence remains available under existing cleanup policy
    - id: ac-worktree-evidence-survives-control
      given: dispatch work is controlled
      when: lifecycle control completes
      then: worktree evidence remains available under existing cleanup policy
    - id: ac-snapshot-evidence-survives-control
      given: dispatch work is controlled
      when: lifecycle control completes
      then: snapshot evidence remains available under existing cleanup policy
    - id: ac-audit-evidence-survives-control
      given: dispatch work is controlled
      when: lifecycle control completes
      then: audit evidence remains available under existing cleanup policy
```

## Exact Existing-Spec Changes

The spec-patch task applies only this wording with `kspec item set` and `kspec item ac set/add`. Preserve all unlisted IDs and metadata.

- `@agent-dispatch-engine ac-11`: **Given** global stop authority is committed. **When** hard-stop cleanup is incomplete. **Then** dispatch does not report stop success.
- Add `@agent-dispatch-engine ac-final-gate-global-control`: **Given** a candidate remains eligible after dequeue. **When** it reaches the final creation boundary. **Then** current global control determines whether creation is permitted.
- Add `@agent-dispatch-engine ac-final-gate-task-control`: **Given** a candidate remains eligible after dequeue. **When** it reaches the final creation boundary. **Then** its canonical-task control determines whether creation is permitted.
- Add `@agent-dispatch-engine ac-pause-active-natural-completion`: **Given** an invocation is active in a scope. **When** that scope is paused. **Then** the invocation may finish naturally.
- Add `@agent-dispatch-engine ac-pause-does-not-close-session`: **Given** a session belongs to an active invocation. **When** its scope is paused. **Then** pause does not close the session.
- Add `@agent-dispatch-engine ac-resume-current-task-state`: **Given** a scope is paused. **When** it resumes. **Then** current task state is re-evaluated before work starts.
- Add `@agent-dispatch-engine ac-resume-current-dispatch-rules`: **Given** a scope is paused. **When** it resumes. **Then** current dispatch rules are re-evaluated before work starts.
- Replace `@per-task-dispatch-drain-coalescing ac-5`: **Given** per-task coalescing timers are pending. **When** matching stop authority commits. **Then** matching timers are cancelled.
- Add `@per-task-dispatch-drain-coalescing ac-stop-prevents-pending-drain-start`: **Given** a matching pending drain exists. **When** stop authority commits. **Then** that drain does not start work.
- Add `@per-task-dispatch-drain-coalescing ac-stop-cancels-active-invocation`: **Given** a matching invocation is active. **When** hard-stop cleanup runs. **Then** that invocation is cancelled.
- `@cli-agent-commands` description: The `kspec agent` family lists and runs agents and exposes durable global and canonical-task dispatch start, pause, resume, hard-stop, and status controls.
- `@cli-agent-commands ac-5`: **Given** dispatch-owned hard-stop cleanup is incomplete. **When** `kspec agent dispatch stop` reports its result. **Then** the command does not report stopped success.
- Add `@cli-agent-commands ac-start-reports-authority`: **Given** the daemon is available. **When** start is requested from stopped authority. **Then** the command reports running authority.
- Add `@cli-agent-commands ac-pause-reports-authority`: **Given** the daemon is available. **When** pause is requested from running authority. **Then** the command reports paused authority.
- Add `@cli-agent-commands ac-resume-reports-authority`: **Given** the daemon is available. **When** resume is requested from paused authority. **Then** the command reports running authority.
- Add `@cli-agent-commands ac-lifecycle-command-reports-projection`: **Given** a lifecycle command succeeds. **When** output is rendered. **Then** the command reports the resulting projection.
- Add `@cli-agent-commands ac-declined-stop-sends-no-request`: **Given** a user invokes hard stop interactively. **When** confirmation is declined. **Then** no stop request is sent.
- Add `@cli-agent-commands ac-declined-stop-exit`: **Given** a user declines interactive hard stop. **When** the command exits. **Then** it exits as user-cancelled.
- Add `@cli-agent-commands ac-task-control-canonicalization`: **Given** a task control command names a resolvable task. **When** it is accepted. **Then** the result identifies the canonical task ULID.
- Add `@cli-agent-commands ac-lifecycle-status-authority`: **Given** lifecycle status is printed. **When** human or JSON output is rendered. **Then** authority is present.
- Add `@cli-agent-commands ac-lifecycle-status-projection`: **Given** lifecycle status is printed. **When** human or JSON output is rendered. **Then** projection is present.
- Add `@cli-agent-commands ac-lifecycle-status-active-count`: **Given** lifecycle status is printed. **When** human or JSON output is rendered. **Then** active count is present.
- Add `@cli-agent-commands ac-lifecycle-status-queued-count`: **Given** lifecycle status is printed. **When** human or JSON output is rendered. **Then** queued count is present.
- Add `@cli-agent-commands ac-lifecycle-status-held-count`: **Given** lifecycle status is printed. **When** human or JSON output is rendered. **Then** held count is present.
- Replace `@daemon-agent-dispatch ac-5`: **Given** `GET /api/agent/status` is called. **When** lifecycle state is available. **Then** the response preserves top-level `dispatch_enabled`, `active_invocations`, `queued_invocations`, `queue_depth`, `agent_definitions`, `degraded`, and `degraded_targets`; preserves each active item’s `session_id,agent_id,task_ref,task_title,elapsed_ms,resolved_adapter`, each queued item’s `agent_id,task_ref,task_title,wait_ms,resolved_adapter`, each agent definition’s `id,name,adapter,resolved_adapter,completed_sessions`, and each degraded target’s `branch,reason,enteredAt,kind`; includes `runner` only where currently configured and `runner_validation:{status,diagnostics[]}` only where current resolution emits it.
- Add `@daemon-agent-dispatch ac-public-status-lifecycle-additions`: **Given** `GET /api/agent/status` is called. **When** lifecycle state is available. **Then** lifecycle additions are appended at top level.
- Replace `@daemon-agent-dispatch ac-6`: **Given** a localhost client posts a valid lifecycle control. **When** transition processing succeeds. **Then** `POST /api/agent/dispatch/control` returns HTTP 200 with `{ok:true,data:{global_authority,projection,cleanup_state,active_count,queue_depth,held_count,held_tasks,task_controls,degraded_targets,outcome},error:null}`.
- Add `@daemon-agent-dispatch ac-control-error-current-status`: **Given** a localhost lifecycle control fails. **When** the API responds. **Then** its structured error includes current status.
- Add `@daemon-agent-dispatch ac-control-missing-identity`: **Given** a task-scoped control omits task identity. **When** validation runs. **Then** the request is rejected.
- Add `@daemon-agent-dispatch ac-control-ref-canonicalization`: **Given** a task-scoped control carries one uniquely resolvable ref. **When** identity is resolved. **Then** the ref is canonicalized to its task ULID.
- Add `@daemon-agent-dispatch ac-control-identity-mismatch`: **Given** supplied task identity fields disagree. **When** identity is resolved. **Then** the request has no effect.
- Add `@daemon-agent-dispatch ac-control-failure-no-success`: **Given** lifecycle persistence fails. **When** the API responds. **Then** it does not report success.
- Add `@daemon-agent-dispatch ac-cleanup-failure-no-success`: **Given** stop cleanup fails. **When** the API responds. **Then** it does not report success.
- Replace `@ui-agent-dispatch ac-2`: **Given** lifecycle status is available. **When** the agents view renders. **Then** it shows durable authority.
- Add `@ui-agent-dispatch ac-status-projection`: **Given** lifecycle status is available. **When** the agents view renders. **Then** it shows lifecycle projection.
- Add `@ui-agent-dispatch ac-status-active-work-visible`: **Given** active work exists during draining or cleanup. **When** the agents view renders. **Then** active work remains visible.
- Add `@ui-agent-dispatch ac-status-queued-work-visible`: **Given** queued work exists. **When** the agents view renders. **Then** queued work is visible.
- Add `@ui-agent-dispatch ac-status-held-work-visible`: **Given** held work exists. **When** the agents view renders. **Then** held work is visible.
- Replace `@ui-agent-dispatch ac-3`: **Given** global authority is paused. **When** the agents view renders. **Then** it offers only transitions valid from paused authority.
- Add `@ui-agent-dispatch ac-stopped-actions-valid`: **Given** global authority is stopped. **When** the agents view renders. **Then** it offers only transitions valid from stopped authority.
- Add `@ui-agent-dispatch ac-control-separated-from-degraded`: **Given** administrative lifecycle control and degraded state coexist. **When** the agents view renders. **Then** they are labelled separately.
- Add `@ui-agent-dispatch ac-control-separated-from-blocked`: **Given** administrative lifecycle control and blocked state coexist. **When** the agents view renders. **Then** they are labelled separately.
- Add `@ui-agent-dispatch ac-hard-stop-confirmation-cancellation`: **Given** a writable operator selects hard stop. **When** confirmation is shown. **Then** it explains active cancellation.
- Add `@ui-agent-dispatch ac-hard-stop-confirmation-evidence`: **Given** a writable operator selects hard stop. **When** confirmation is shown. **Then** it explains evidence preservation.
- Add `@ui-agent-dispatch ac-hard-stop-confirmation-cancelled`: **Given** hard-stop confirmation is shown. **When** the operator cancels it. **Then** no request is sent.
- Add `@ui-agent-dispatch ac-lifecycle-controls-labelled`: **Given** lifecycle controls render. **When** assistive technology reads them. **Then** each control has an accessible label.
- Add `@ui-agent-dispatch ac-lifecycle-focus-retained`: **Given** a lifecycle control initiated a refresh. **When** the refresh completes. **Then** focus returns to that control.
- Add `@ui-agent-dispatch ac-lifecycle-live-update`: **Given** lifecycle status changes. **When** the view refreshes. **Then** a polite live status update is emitted.
- Add `@dispatch-event-taxonomy ac-dispatch-control-domain`: **Given** a lifecycle outcome is emitted. **When** event type validation runs. **Then** the identifier is one of `dispatch_control.start_applied`, `dispatch_control.pause_applied`, `dispatch_control.resume_applied`, `dispatch_control.stop_applied`, `dispatch_control.noop`, or `dispatch_control.failed`.
- Add `@dispatch-event-payload ac-dispatch-control-common-fields`: **Given** a dispatch-control event is emitted. **When** its payload is read. **Then** it contains `scope,action,authority,projection,outcome,reason,actor,source,timestamp`; task scope also contains canonical `task_id` and may contain `task_ref`, while global scope contains neither task identity field; only failed outcomes contain `error_code`.
- Add `@dispatch-event-payload ac-dispatch-control-task-identity`: **Given** a task-scoped dispatch-control event is emitted. **When** its payload is read. **Then** canonical task identity is present.
- Add `@dispatch-event-payload ac-dispatch-control-field-bounds`: **Given** `reason`, `actor`, or `task_ref` exceeds its declared bound. **When** the payload is created. **Then** control characters are removed, whitespace is normalized, `reason` is at most 240 Unicode code points, `actor` is at most 120, and `task_ref` is at most 200.
- Add `@dispatch-event-payload ac-dispatch-control-no-prompts`: **Given** lifecycle event input contains a prompt. **When** the payload is created. **Then** the prompt is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-secrets`: **Given** lifecycle event input contains a secret. **When** the payload is created. **Then** the secret is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-terminal-buffer`: **Given** lifecycle event input contains terminal-buffer text. **When** the payload is created. **Then** terminal-buffer text is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-workspace-path`: **Given** lifecycle event input contains a workspace path. **When** the payload is created. **Then** the workspace path is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-raw-input-error`: **Given** lifecycle event input contains a raw error. **When** the payload is created. **Then** the raw error is absent.
- Add `@dispatch-event-payload ac-dispatch-control-error-codes`: **Given** a dispatch-control failure is emitted. **When** payload validation runs. **Then** `error_code` is exactly one of `validation_failed`, `task_not_found`, `task_identity_ambiguous`, `task_identity_mismatch`, `invalid_transition`, `control_store_unavailable`, `control_store_corrupt`, `control_commit_failed`, `cancellation_timeout`, `cancellation_failed`, `session_closure_failed`, `cleanup_ownership_mismatch`, `cleanup_process_birth_mismatch`, `cleanup_leader_missing_group_alive`, `cleanup_identity_unverifiable`, `cleanup_group_unverifiable`, or `internal_error`, and every other string is rejected.
- Add `@dispatch-event-payload ac-dispatch-control-no-raw-error`: **Given** a dispatch-control failure is emitted. **When** its payload is read. **Then** no raw error is present.
- Add `@dispatch-workspace-cleanup-policy ac-controlled-evidence-protected`: **Given** dispatch evidence belongs to active, in-flight, paused-held, or stopped-pending-cleanup work. **When** a destructive cleanup surface evaluates it. **Then** lifecycle control alone does not make the evidence cleanup-eligible.

## Coverage Ownership

| Contract | Primary closure owner |
| --- | --- |
| exact existing-spec text/materialization process (no behavioral closure) | `task-patch-dispatch-lifecycle-specs` |
| durable authority, canonical identity, record revision transaction idempotency only | `task-dispatch-control-persistence` |
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

## Coverage Ownership

Every @dispatch-lifecycle-control-authority AC has one primary behavior owner; patch and verification tasks claim no behavioral closure.

| Owner | Primary closure |
| --- | --- |
| task-dispatch-control-persistence | ac-task-control-uses-canonical-identity; ac-controls-survive-restart; ac-uncommitted-control-is-not-visible; ac-failed-control-write-is-not-visible; ac-stale-control-is-not-visible; ac-invalid-control-is-not-visible; ac-external-commit-is-eventually-visible; ac-controls-do-not-change-readiness; ac-controls-do-not-change-degraded-targets |
| task-engine-global-lifecycle | ac-global-pause-authority; ac-global-paused-work-does-not-start; ac-global-pause-allows-active-completion; ac-global-pause-keeps-active-session-open; ac-resume-reconciles-held-work; ac-resume-reconciles-eligible-work; ac-repeated-resume-does-not-duplicate; ac-concurrent-resume-does-not-duplicate; ac-paused-reconstruction-uses-current-state; ac-stopped-reconstruction-uses-current-state; ac-global-start-is-idempotent; ac-global-pause-is-idempotent; ac-global-resume-is-idempotent |
| task-engine-task-pause-resume | ac-task-paused-work-does-not-start; ac-task-pause-allows-active-completion; ac-task-pause-keeps-active-session-open; ac-task-control-preserves-unrelated-task-control; ac-task-control-preserves-global-authority; ac-task-resume-obeys-global-authority; ac-task-pause-is-idempotent; ac-task-resume-is-idempotent |
| task-final-pre-spawn-control-gate | ac-final-gate-prevents-process-creation; ac-final-gate-prevents-session-creation; ac-spawn-win-pause-allows-completion; ac-spawn-win-stop-cancels-invocation |
| task-engine-stop-recovery | ac-stop-forbids-new-starts; ac-stop-cancels-active-work; ac-stop-closes-active-sessions; ac-task-stop-cancels-matching-work; ac-task-stop-preserves-unrelated-invocations; ac-task-stop-closes-matching-session; ac-task-stop-preserves-unrelated-sessions; ac-task-stop-failure-retains-stopped-authority; ac-task-stop-failure-reports-pending-cleanup; ac-task-stop-failure-reports-no-success; ac-task-interrupted-stop-recovers-on-startup; ac-task-interrupted-stop-recovers-on-retry; ac-recovery-requires-session-ownership; ac-recovery-requires-process-birth; ac-missing-leader-live-group-remains-pending; ac-unverified-live-group-is-not-signalled; ac-live-group-prevents-cleanup-completion; ac-stop-failure-retains-stopped-authority; ac-stop-failure-reports-pending-cleanup; ac-stop-failure-reports-no-success; ac-interrupted-stop-recovers-on-startup; ac-interrupted-stop-recovers-on-retry; ac-global-stop-is-idempotent; ac-task-stop-is-idempotent |
| task-dispatch-lifecycle-events | ac-applied-control-is-auditable; ac-noop-control-is-auditable; ac-failed-control-is-auditable; ac-failure-events-use-closed-error-codes |
| task-daemon-dispatch-lifecycle-api | ac-status-reports-authority; ac-status-reports-projection; ac-status-reports-active-count; ac-status-reports-queued-count; ac-status-reports-held-count; ac-status-reports-held-task-identity; ac-status-reports-held-task-scope; ac-status-reports-held-task-mode; ac-status-reports-held-task-reason; ac-failure-api-uses-closed-error-codes; ac-api-failures-do-not-expose-raw-errors |
| task-cli-dispatch-lifecycle-controls | ac-failure-cli-uses-closed-error-codes; ac-cli-failures-do-not-expose-raw-errors |
| task-ui-dispatch-lifecycle-controls | ac-ui-failures-do-not-expose-raw-errors |
| task-protect-controlled-dispatch-evidence | ac-session-evidence-survives-control; ac-branch-evidence-survives-control; ac-workspace-evidence-survives-control; ac-worktree-evidence-survives-control; ac-snapshot-evidence-survives-control; ac-audit-evidence-survives-control |

## Tasks

derive_from_specs: false

```yaml
- title: Patch dispatch engine and coalescing specs exactly
  slug: task-patch-dispatch-engine-coalescing-specs
  priority: 1
  spec_ref: "@agent-dispatch-engine"
  tags: [dispatch, specs, engine]
  description: |
    ### Covers

    - @agent-dispatch-engine ac-11, ac-final-gate-global-control, ac-final-gate-task-control, ac-pause-active-natural-completion, ac-pause-does-not-close-session, ac-resume-current-task-state, ac-resume-current-dispatch-rules
    - @per-task-dispatch-drain-coalescing ac-5, ac-stop-prevents-pending-drain-start, ac-stop-cancels-active-invocation

    ### Required context

    Metadata only: use kspec item ac set/add, never direct .kspec edits. Do not create or derive @dispatch-lifecycle-control-authority; plan materialization creates that requirement. Preserve all unlisted fields.

    ### Deliverable

    Apply exactly these complete payloads:
    - Set @agent-dispatch-engine ac-11 — Given global stop authority is committed. When hard-stop cleanup is incomplete. Then dispatch does not report stop success.
    - Add @agent-dispatch-engine ac-final-gate-global-control — Given a candidate remains eligible after dequeue. When it reaches the final creation boundary. Then current global control determines whether creation is permitted.
    - Add @agent-dispatch-engine ac-final-gate-task-control — Given a candidate remains eligible after dequeue. When it reaches the final creation boundary. Then its canonical-task control determines whether creation is permitted.
    - Add @agent-dispatch-engine ac-pause-active-natural-completion — Given an invocation is active in a scope. When that scope is paused. Then the invocation may finish naturally.
    - Add @agent-dispatch-engine ac-pause-does-not-close-session — Given a session belongs to an active invocation. When its scope is paused. Then pause does not close the session.
    - Add @agent-dispatch-engine ac-resume-current-task-state — Given a scope is paused. When it resumes. Then current task state is re-evaluated before work starts.
    - Add @agent-dispatch-engine ac-resume-current-dispatch-rules — Given a scope is paused. When it resumes. Then current dispatch rules are re-evaluated before work starts.
    - Set @per-task-dispatch-drain-coalescing ac-5 — Given per-task coalescing timers are pending. When matching stop authority commits. Then matching timers are cancelled.
    - Add @per-task-dispatch-drain-coalescing ac-stop-prevents-pending-drain-start — Given a matching pending drain exists. When stop authority commits. Then that drain does not start work.
    - Add @per-task-dispatch-drain-coalescing ac-stop-cancels-active-invocation — Given a matching invocation is active. When hard-stop cleanup runs. Then that invocation is cancelled.

    ### Implementation

    Read both owners before and after mutation; account for each changed field. No source, test, plan, review, or resource changes.

    ### Files

    - Create: none.
    - Modify: none.
    - Tests: none.

    ### Behavioral tests

    Make a nonmutating ten-row readback of item, id, operation, Given, When, and Then; prove neighboring ACs/metadata are unchanged.

    ### Verification

    - kspec item get @agent-dispatch-engine
    - kspec item get @per-task-dispatch-drain-coalescing
    - git diff --check

    ### Reviewer handoff

    Supply the ten-row readback and confirm metadata-only scope.

- title: Patch dispatch CLI specs exactly
  slug: task-patch-dispatch-cli-specs
  priority: 1
  spec_ref: "@cli-agent-commands"
  tags: [dispatch, specs, cli]
  description: |
    ### Covers

    - @cli-agent-commands description, ac-5, ac-start-reports-authority, ac-pause-reports-authority, ac-resume-reports-authority, ac-lifecycle-command-reports-projection, ac-declined-stop-sends-no-request, ac-declined-stop-exit, ac-task-control-canonicalization, ac-lifecycle-status-authority, ac-lifecycle-status-projection, ac-lifecycle-status-active-count, ac-lifecycle-status-queued-count, ac-lifecycle-status-held-count

    ### Required context

    Metadata only. Set the description with kspec item set; use item ac set/add for the exact payloads. Do not derive this draft.

    ### Deliverable

    Set description: The kspec agent family lists and runs agents and exposes durable global and canonical-task dispatch start, pause, resume, hard-stop, and status controls.
    - Set ac-5 — Given dispatch-owned hard-stop cleanup is incomplete. When kspec agent dispatch stop reports its result. Then the command does not report stopped success.
    - Add ac-start-reports-authority — Given the daemon is available. When start is requested from stopped authority. Then the command reports running authority.
    - Add ac-pause-reports-authority — Given the daemon is available. When pause is requested from running authority. Then the command reports paused authority.
    - Add ac-resume-reports-authority — Given the daemon is available. When resume is requested from paused authority. Then the command reports running authority.
    - Add ac-lifecycle-command-reports-projection — Given a lifecycle command succeeds. When output is rendered. Then the command reports the resulting projection.
    - Add ac-declined-stop-sends-no-request — Given a user invokes hard stop interactively. When confirmation is declined. Then no stop request is sent.
    - Add ac-declined-stop-exit — Given a user declines interactive hard stop. When the command exits. Then it exits as user-cancelled.
    - Add ac-task-control-canonicalization — Given a task control command names a resolvable task. When it is accepted. Then the result identifies the canonical task ULID.
    - Add ac-lifecycle-status-authority — Given lifecycle status is printed. When human or JSON output is rendered. Then authority is present.
    - Add ac-lifecycle-status-projection — Given lifecycle status is printed. When human or JSON output is rendered. Then projection is present.
    - Add ac-lifecycle-status-active-count — Given lifecycle status is printed. When human or JSON output is rendered. Then active count is present.
    - Add ac-lifecycle-status-queued-count — Given lifecycle status is printed. When human or JSON output is rendered. Then queued count is present.
    - Add ac-lifecycle-status-held-count — Given lifecycle status is printed. When human or JSON output is rendered. Then held count is present.

    ### Implementation

    Apply text verbatim and read the full owner back. No CLI implementation belongs here.

    ### Files

    - Create: none.
    - Modify: none.
    - Tests: none.

    ### Behavioral tests

    Read back one description, one replacement, and twelve additions without altering state.

    ### Verification

    - kspec item get @cli-agent-commands
    - git diff --check

    ### Reviewer handoff

    Provide the fourteen-row exact text matrix and metadata-only confirmation.

- title: Patch daemon dispatch API specs exactly
  slug: task-patch-dispatch-api-specs
  priority: 1
  spec_ref: "@daemon-agent-dispatch"
  tags: [dispatch, specs, api]
  description: |
    ### Covers

    - @daemon-agent-dispatch ac-5, ac-public-status-lifecycle-additions, ac-6, ac-control-error-current-status, ac-control-missing-identity, ac-control-ref-canonicalization, ac-control-identity-mismatch, ac-control-failure-no-success, ac-cleanup-failure-no-success

    ### Required context

    Metadata only; the daemon API task implements the contract later.

    ### Deliverable

    - Set ac-5 — Given GET /api/agent/status is called. When lifecycle state is available. Then the response preserves dispatch_enabled, active_invocations, queued_invocations, queue_depth, agent_definitions, degraded, degraded_targets; active session_id/agent_id/task_ref/task_title/elapsed_ms/resolved_adapter; queued agent_id/task_ref/task_title/wait_ms/resolved_adapter; definitions id/name/adapter/resolved_adapter/completed_sessions; targets branch/reason/enteredAt/kind; runner only when configured; runner_validation only where current resolution emits it.
    - Add ac-public-status-lifecycle-additions — Given GET /api/agent/status is called. When lifecycle state is available. Then lifecycle additions are appended at top level.
    - Set ac-6 — Given a localhost client posts a valid lifecycle control. When transition processing succeeds. Then POST /api/agent/dispatch/control returns HTTP 200 with ok true, data containing global_authority, projection, cleanup_state, active_count, queue_depth, held_count, held_tasks, task_controls, degraded_targets, outcome, and error null.
    - Add ac-control-error-current-status — Given a localhost lifecycle control fails. When the API responds. Then its structured error includes current status.
    - Add ac-control-missing-identity — Given a task-scoped control omits task identity. When validation runs. Then the request is rejected.
    - Add ac-control-ref-canonicalization — Given a task-scoped control carries one uniquely resolvable ref. When identity is resolved. Then the ref is canonicalized to its task ULID.
    - Add ac-control-identity-mismatch — Given supplied task identity fields disagree. When identity is resolved. Then the request has no effect.
    - Add ac-control-failure-no-success — Given lifecycle persistence fails. When the API responds. Then it does not report success.
    - Add ac-cleanup-failure-no-success — Given stop cleanup fails. When the API responds. Then it does not report success.

    ### Implementation

    Apply only these nine payloads; preserve Elysia validation and all unlisted compatibility ACs.

    ### Files

    - Create: none.
    - Modify: none.
    - Tests: none.

    ### Behavioral tests

    Read back a nine-row table and verify ac-6 retains the full envelope instead of vague success text.

    ### Verification

    - kspec item get @daemon-agent-dispatch
    - git diff --check

    ### Reviewer handoff

    Supply exact stored payloads and confirm no route/test edits.

- title: Patch dispatch UI specs exactly
  slug: task-patch-dispatch-ui-specs
  priority: 1
  spec_ref: "@ui-agent-dispatch"
  tags: [dispatch, specs, ui]
  description: |
    ### Covers

    - @ui-agent-dispatch ac-2, ac-status-projection, ac-status-active-work-visible, ac-status-queued-work-visible, ac-status-held-work-visible, ac-3, ac-stopped-actions-valid, ac-control-separated-from-degraded, ac-control-separated-from-blocked, ac-hard-stop-confirmation-cancellation, ac-hard-stop-confirmation-evidence, ac-hard-stop-confirmation-cancelled, ac-lifecycle-controls-labelled, ac-lifecycle-focus-retained, ac-lifecycle-live-update

    ### Required context

    Metadata only. AC wording stays product-facing and contains no component paths.

    ### Deliverable

    - Set ac-2 — Given lifecycle status is available. When the agents view renders. Then it shows durable authority.
    - Add ac-status-projection — Given lifecycle status is available. When the agents view renders. Then it shows lifecycle projection.
    - Add ac-status-active-work-visible — Given active work exists during draining or cleanup. When the agents view renders. Then active work remains visible.
    - Add ac-status-queued-work-visible — Given queued work exists. When the agents view renders. Then queued work is visible.
    - Add ac-status-held-work-visible — Given held work exists. When the agents view renders. Then held work is visible.
    - Set ac-3 — Given global authority is paused. When the agents view renders. Then it offers only transitions valid from paused authority.
    - Add ac-stopped-actions-valid — Given global authority is stopped. When the agents view renders. Then it offers only transitions valid from stopped authority.
    - Add ac-control-separated-from-degraded — Given administrative lifecycle control and degraded state coexist. When the agents view renders. Then they are labelled separately.
    - Add ac-control-separated-from-blocked — Given administrative lifecycle control and blocked state coexist. When the agents view renders. Then they are labelled separately.
    - Add ac-hard-stop-confirmation-cancellation — Given a writable operator selects hard stop. When confirmation is shown. Then it explains active cancellation.
    - Add ac-hard-stop-confirmation-evidence — Given a writable operator selects hard stop. When confirmation is shown. Then it explains evidence preservation.
    - Add ac-hard-stop-confirmation-cancelled — Given hard-stop confirmation is shown. When the operator cancels it. Then no request is sent.
    - Add ac-lifecycle-controls-labelled — Given lifecycle controls render. When assistive technology reads them. Then each control has an accessible label.
    - Add ac-lifecycle-focus-retained — Given a lifecycle control initiated a refresh. When the refresh completes. Then focus returns to that control.
    - Add ac-lifecycle-live-update — Given lifecycle status changes. When the view refreshes. Then a polite live status update is emitted.

    ### Implementation

    Apply and read back these fifteen payloads only.

    ### Files

    - Create: none.
    - Modify: none.
    - Tests: none.

    ### Behavioral tests

    Readback distinguishes authority/projection, three visibility cases, control states, confirmation, labels, focus, and live updates.

    ### Verification

    - kspec item get @ui-agent-dispatch
    - git diff --check

    ### Reviewer handoff

    Supply fifteen exact rows and metadata-only confirmation.

- title: Patch dispatch event payload specs exactly
  slug: task-patch-dispatch-events-specs
  priority: 1
  spec_ref: "@dispatch-event-taxonomy"
  tags: [dispatch, specs, events]
  description: |
    ### Covers

    - @dispatch-event-taxonomy ac-dispatch-control-domain
    - @dispatch-event-payload ac-dispatch-control-common-fields, ac-dispatch-control-task-identity, ac-dispatch-control-field-bounds, ac-dispatch-control-no-prompts, ac-dispatch-control-no-secrets, ac-dispatch-control-no-terminal-buffer, ac-dispatch-control-no-workspace-path, ac-dispatch-control-no-raw-input-error, ac-dispatch-control-error-codes, ac-dispatch-control-no-raw-error

    ### Required context

    Metadata only. The complete identifier, payload, sanitizer, and closed-code contract must appear here, not by reference to parent prose.

    ### Deliverable

    - Add @dispatch-event-taxonomy ac-dispatch-control-domain — Given a lifecycle outcome is emitted. When event type validation runs. Then the identifier is one of dispatch_control.start_applied, dispatch_control.pause_applied, dispatch_control.resume_applied, dispatch_control.stop_applied, dispatch_control.noop, or dispatch_control.failed.
    - Add @dispatch-event-payload ac-dispatch-control-common-fields — Given a dispatch-control event is emitted. When its payload is read. Then it contains scope, action, authority, projection, outcome, reason, actor, source, timestamp; task scope contains canonical task_id and may contain task_ref; global scope contains neither; only failed outcomes contain error_code.
    - Add ac-dispatch-control-task-identity — Given a task-scoped dispatch-control event is emitted. When its payload is read. Then canonical task identity is present.
    - Add ac-dispatch-control-field-bounds — Given reason, actor, or task_ref exceeds its bound. When the payload is created. Then control characters are removed, whitespace is normalized, reason is at most 240 Unicode code points, actor 120, and task_ref 200.
    - Add ac-dispatch-control-no-prompts — Given lifecycle event input contains a prompt. When the payload is created. Then the prompt is absent.
    - Add ac-dispatch-control-no-secrets — Given lifecycle event input contains a secret. When the payload is created. Then the secret is absent.
    - Add ac-dispatch-control-no-terminal-buffer — Given lifecycle event input contains terminal-buffer text. When the payload is created. Then terminal-buffer text is absent.
    - Add ac-dispatch-control-no-workspace-path — Given lifecycle event input contains a workspace path. When the payload is created. Then the workspace path is absent.
    - Add ac-dispatch-control-no-raw-input-error — Given lifecycle event input contains a raw error. When the payload is created. Then the raw error is absent.
    - Add ac-dispatch-control-error-codes — Given a dispatch-control failure is emitted. When payload validation runs. Then error_code is exactly validation_failed, task_not_found, task_identity_ambiguous, task_identity_mismatch, invalid_transition, control_store_unavailable, control_store_corrupt, control_commit_failed, cancellation_timeout, cancellation_failed, session_closure_failed, cleanup_ownership_mismatch, cleanup_process_birth_mismatch, cleanup_leader_missing_group_alive, cleanup_identity_unverifiable, cleanup_group_unverifiable, or internal_error; every other string is rejected.
    - Add ac-dispatch-control-no-raw-error — Given a dispatch-control failure is emitted. When its payload is read. Then no raw error is present.

    ### Implementation

    Add each AC to the stated owner; do not change product code.

    ### Files

    - Create: none.
    - Modify: none.
    - Tests: none.

    ### Behavioral tests

    Nonmutating readback covers six identifiers, presence rules, exact bounds, five forbidden classes, and all 17 codes.

    ### Verification

    - kspec item get @dispatch-event-taxonomy
    - kspec item get @dispatch-event-payload
    - git diff --check

    ### Reviewer handoff

    Supply enum/bounds and eleven-payload readbacks.

- title: Patch dispatch workspace cleanup spec exactly
  slug: task-patch-dispatch-workspace-cleanup-spec
  priority: 1
  spec_ref: "@dispatch-workspace-cleanup-policy"
  tags: [dispatch, specs, cleanup]
  description: |
    ### Covers

    - @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected

    ### Required context

    Metadata only; cleanup code follows in its own task.

    ### Deliverable

    Add ac-controlled-evidence-protected — Given dispatch evidence belongs to active, in-flight, paused-held, or stopped-pending-cleanup work. When a destructive cleanup surface evaluates it. Then lifecycle control alone does not make the evidence cleanup-eligible.

    ### Implementation

    Add the one AC, preserve all existing cleanup policy, then read it back.

    ### Files

    - Create: none.
    - Modify: none.
    - Tests: none.

    ### Behavioral tests

    Readback distinguishes lifecycle protection from terminal/integration eligibility.

    ### Verification

    - kspec item get @dispatch-workspace-cleanup-policy
    - git diff --check

    ### Reviewer handoff

    Provide the complete payload and metadata-only confirmation.

- title: Define durable dispatch control persistence and committed publication
  slug: task-dispatch-control-persistence
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on:
    - "@task-patch-dispatch-engine-coalescing-specs"
  tags: [dispatch, persistence, schema]
  description: |
    ### Covers

    - ac-task-control-uses-canonical-identity
    - ac-controls-survive-restart
    - ac-uncommitted-control-is-not-visible
    - ac-failed-control-write-is-not-visible
    - ac-stale-control-is-not-visible
    - ac-invalid-control-is-not-visible
    - ac-external-commit-is-eventually-visible
    - ac-controls-do-not-change-readiness
    - ac-controls-do-not-change-degraded-targets

    ### Required context

    The canonical document is .kspec/dispatch-control.yaml: version 1, nonnegative monotonic revision, global authority stopped/running/paused, task records keyed only by canonical ULID, and pending_cleanup keyed by global/task ULID. Its published token is revision plus the shadow HEAD commit oid. src/schema/dispatch-control.ts owns Zod shape; src/parser/dispatch-control.ts owns parse/atomic replace; src/agent-runtime/dispatch-shadow-transaction.ts owns commit; src/agent-runtime/dispatch-control-store.ts owns memory publication.

    ### Deliverable

    A store that only publishes a byte-for-byte parsed dispatch-control.yaml from a verified committed Git object. Missing file is stopped/no controls; corruption never defaults to running.

    ### Implementation

    Use acquireFileLock and getDispatchShadowMutationLockPath, never private withDispatchShadowMutationLock. Acquire shadow lock before parser file locks; no engine/process/session wait may occur while locked. Capture pre_head, reclaim dirty state with rollbackDirtyShadowWorktree, write atomically, call commitIfShadow once, then verify git show HEAD:dispatch-control.yaml parses to the proposed snapshot. False/throw/verification failure resets to pre_head and reloads/publishes only its valid snapshot. project-context records watcher event/observed HEAD but never watcher content; reloadCommitted rereads git show HEAD under the same lock, retains one coalesced pre-commit event reread, publishes a newer valid head once, and suppresses self-event duplicates. entity-cache invalidates only after publication.

    ### Files

    - Create: src/schema/dispatch-control.ts
    - Create: src/parser/dispatch-control.ts
    - Create: src/agent-runtime/dispatch-shadow-transaction.ts
    - Create: src/agent-runtime/dispatch-control-store.ts
    - Create: tests/dispatch-control-store.test.ts
    - Modify: src/schema/index.ts
    - Modify: src/parser/index.ts
    - Modify: src/parser/file-lock.ts
    - Modify: src/agent-runtime/workspace.ts
    - Modify: packages/daemon/src/project-context.ts
    - Modify: src/daemon/entity-cache.ts
    - Modify: tests/daemon-entity-cache.test.ts
    - Modify: tests/daemon-watcher-chokidar.test.ts

    ### Behavioral tests

    Test missing/version-1/unknown/malformed, canonical keys, monotonic revisions, commit false/throw, verification rollback, and force reclaim. Use barriers for watcher-before-external-commit/abort/rollback, commit-before-watcher, self duplicate, dirty write, stale/malformed commit, and valid external commit; every valid newer committed head publishes once and no dirty bytes publish.

    ### Verification

    - npm test -- tests/dispatch-control-store.test.ts tests/daemon-entity-cache.test.ts tests/daemon-watcher-chokidar.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Supply commit/rollback, lock-order, and watcher barrier tables. State that scheduling/cancellation are not owned here.

- title: Implement global lifecycle authority and coalesced reconstruction
  slug: task-engine-global-lifecycle
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on:
    - "@task-dispatch-control-persistence"
  tags: [dispatch, engine, lifecycle]
  description: |
    ### Covers

    - ac-global-pause-authority
    - ac-global-paused-work-does-not-start
    - ac-global-pause-allows-active-completion
    - ac-global-pause-keeps-active-session-open
    - ac-resume-reconciles-held-work
    - ac-resume-reconciles-eligible-work
    - ac-repeated-resume-does-not-duplicate
    - ac-concurrent-resume-does-not-duplicate
    - ac-paused-reconstruction-uses-current-state
    - ac-stopped-reconstruction-uses-current-state
    - ac-global-start-is-idempotent
    - ac-global-pause-is-idempotent
    - ac-global-resume-is-idempotent

    ### Required context

    Start leaves stopped; resume leaves paused; invalid transitions are not substitutions. Pause blocks starts but lets active work/session finish. Stop admission/cancellation belongs later.

    ### Deliverable

    Apply authority at bootstrap, events, coalescing, retries, reconciliation, post-invocation, and degraded recovery; reconstruct current task/rule state with canonical dedupe.

    ### Implementation

    Load authority before bootstrap. Running accepts/coalesces intent; paused holds it; stopped starts none. Start/resume rebuild current candidates and dedupe active/queued canonical task ids. Serialize drain/reconcile work. Do not replay historical FIFO/retry deadlines and do not implement hard stop.

    ### Files

    - Create: tests/dispatch-global-lifecycle.test.ts
    - Modify: src/agent-runtime/dispatch.ts
    - Modify: src/agent-runtime/bootstrap.ts
    - Modify: tests/agent-dispatch-engine.test.ts
    - Modify: tests/dispatch-runtime-bootstrap-contract.test.ts

    ### Behavioral tests

    Cover all start/pause/resume matrix cells, three startup authorities, all ingress, held work, active natural completion/open session, changed current task/rule state, and repeated/concurrent dedupe with barriers.

    ### Verification

    - npm test -- tests/dispatch-global-lifecycle.test.ts tests/agent-dispatch-engine.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide matrix/ingress evidence; task scope, final gate, and cancellation remain later work.

- title: Enforce canonical task pause and resume
  slug: task-engine-task-pause-resume
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on:
    - "@task-engine-global-lifecycle"
  tags: [dispatch, engine, tasks]
  description: |
    ### Covers

    - ac-task-paused-work-does-not-start
    - ac-task-pause-allows-active-completion
    - ac-task-pause-keeps-active-session-open
    - ac-task-control-preserves-unrelated-task-control
    - ac-task-control-preserves-global-authority
    - ac-task-resume-obeys-global-authority
    - ac-task-pause-is-idempotent
    - ac-task-resume-is-idempotent

    ### Required context

    Absent task record means running subject to global. Pause absent creates paused; pause paused is no-op; pause stopped is invalid. Resume removes paused/stopped; resume absent is no-op. Identity is canonical ULID, never a slug alias.

    ### Deliverable

    Task scope applies at every scheduling ingress without changing another task/global authority.

    ### Implementation

    Resolve identity before control lookup/write; apply at enqueue, coalesced expiry, dequeue/retry, bootstrap/reconcile, event/watcher, and post-invocation. Held task work resumes from current state only if global authority permits it; active task work/session completes naturally.

    ### Files

    - Create: tests/dispatch-task-lifecycle.test.ts
    - Modify: src/agent-runtime/dispatch.ts
    - Modify: src/agent-runtime/task-identity.ts
    - Modify: tests/dispatch-canonical-task-identity-integration.test.ts
    - Modify: tests/dispatch-task-identity.test.ts

    ### Behavioral tests

    Use A/B and slug/ULID fixtures across every ingress, repeated/concurrent pause/resume, global paused/stopped, active session completion, and unrelated controls.

    ### Verification

    - npm test -- tests/dispatch-task-lifecycle.test.ts tests/dispatch-canonical-task-identity-integration.test.ts tests/dispatch-task-identity.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide A/B ingress and canonicalization evidence; hard stop is excluded.

- title: Add final ordered lifecycle gate before creation
  slug: task-final-pre-spawn-control-gate
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on:
    - "@task-engine-task-pause-resume"
  tags: [dispatch, race, engine]
  description: |
    ### Covers

    - ac-final-gate-prevents-process-creation
    - ac-final-gate-prevents-session-creation
    - ac-spawn-win-pause-allows-completion
    - ac-spawn-win-stop-cancels-invocation

    ### Required context

    Queue checks cannot close the dequeue-to-create race. The gate is immediately before shared process/session creation; control winner creates neither, spawn winner becomes durable active ownership.

    ### Deliverable

    One deterministic final global/task check returning held, discarded, or active ownership handoff.

    ### Implementation

    Put the gate in the common invocation path. Pause winning restores held intent once; stop winning discards pre-artifact; spawn winning publishes the in-flight/active handoff for recovery. Use no timing-based ordering.

    ### Files

    - Create: tests/dispatch-spawn-control-race.test.ts
    - Modify: src/agent-runtime/dispatch.ts
    - Modify: src/agent-runtime/invocation.ts
    - Modify: tests/dispatch-artifact-protection.test.ts

    ### Behavioral tests

    Barrier global/task pause and stop before creation; assert zero process/session creations on control win, one durable handoff on spawn win, and no protection gap.

    ### Verification

    - npm test -- tests/dispatch-spawn-control-race.test.ts tests/dispatch-artifact-protection.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide boundary location and four barrier traces; no cancellation claim.

- title: Implement verified stop recovery for global and task scopes
  slug: task-engine-stop-recovery
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on:
    - "@task-final-pre-spawn-control-gate"
  tags: [dispatch, recovery, cancellation]
  description: |
    ### Covers

    - ac-stop-forbids-new-starts
    - ac-stop-cancels-active-work
    - ac-stop-closes-active-sessions
    - ac-task-stop-cancels-matching-work
    - ac-task-stop-preserves-unrelated-invocations
    - ac-task-stop-closes-matching-session
    - ac-task-stop-preserves-unrelated-sessions
    - ac-task-stop-failure-retains-stopped-authority
    - ac-task-stop-failure-reports-pending-cleanup
    - ac-task-stop-failure-reports-no-success
    - ac-task-interrupted-stop-recovers-on-startup
    - ac-task-interrupted-stop-recovers-on-retry
    - ac-recovery-requires-session-ownership
    - ac-recovery-requires-process-birth
    - ac-missing-leader-live-group-remains-pending
    - ac-unverified-live-group-is-not-signalled
    - ac-live-group-prevents-cleanup-completion
    - ac-stop-failure-retains-stopped-authority
    - ac-stop-failure-reports-pending-cleanup
    - ac-stop-failure-reports-no-success
    - ac-interrupted-stop-recovers-on-startup
    - ac-interrupted-stop-recovers-on-retry
    - ac-global-stop-is-idempotent
    - ac-task-stop-is-idempotent

    ### Required context

    Durable session dispatch_ownership contains invocation_id, session_id, task_id nullable, agent_id, adapter, owner_instance_id, pid nullable, pgid nullable, process_start_ticks nullable, process_identity_platform linux_proc_stat_v1/unverifiable, captured_at, exited_at optional, and immutable group_members pid/start-ticks proofs. Start ticks are Linux /proc/<pid>/stat field 22 after the final right parenthesis. pending_cleanup has cleanup_id, scope, optional canonical task_id, phase owned/signals_sent/sessions_closed, immutable targets, and project-relative session metadata paths.

    ### Deliverable

    Commit-first hard stop/recovery for both scopes: stopped commits before signal, verified ownership is required for every signal, cleanup is removed only after group exit and durable session closure.

    ### Implementation

    Persist null ownership before spawn then PID/PGID/birth/member proof before active publication; failed post-spawn durability cancels/reaps directly. Re-read tuple before signal: tuple mismatch is cleanup_ownership_mismatch, birth/PID reuse is cleanup_process_birth_mismatch, unreadable evidence is cleanup_identity_unverifiable. Missing leader is not not_found until recorded PGID is proven empty. Linux group signal requires enumerating /proc numeric stats and a matching immutable member proof; live verified leaderless group is cleanup_leader_missing_group_alive, live unproven/unsupported group is cleanup_group_unverifiable. PID/PGID alone never proves ownership. Advance owned to signals_sent only after every leader/PGID is proven exited; close via src/sessions/store.ts, then sessions_closed/remove. Timeout, signal/close failure, mismatch, or live/unverifiable group remains stopped/pending. Global selects all; task selects matching canonical id and preserves unrelated active/queued/retry/session/control/cleanup state.

    ### Files

    - Create: tests/dispatch-stop-recovery.test.ts
    - Modify: src/agent-runtime/dispatch.ts
    - Modify: src/agent-runtime/invocation.ts
    - Modify: src/agent-runtime/session-registry.ts
    - Modify: src/agent-runtime/bootstrap.ts
    - Modify: src/sessions/types.ts
    - Modify: src/sessions/store.ts
    - Modify: tests/active-session-registry.test.ts
    - Modify: tests/agent-dispatch-engine.test.ts
    - Modify: tests/dispatch-spawn-control-race.test.ts

    ### Behavioral tests

    Cover durability failure, tuple/PID reuse, unreadable proc, unsupported platform, leaderless empty/verified-live/unverifiable-live groups, timeout/signal/close failure, every phase crash/restart, global and A/B task scope, repeated/concurrent stop, and graceful shutdown. No live group may complete cleanup; no failure returns stop success.

    ### Verification

    - npm test -- tests/dispatch-stop-recovery.test.ts tests/dispatch-spawn-control-race.test.ts tests/active-session-registry.test.ts tests/agent-dispatch-engine.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide ownership schema, phase table, Linux proof matrix, and A/B recovery traces.

- title: Protect controlled dispatch evidence from cleanup
  slug: task-protect-controlled-dispatch-evidence
  priority: 2
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on:
    - "@task-patch-dispatch-workspace-cleanup-spec"
    - "@task-engine-stop-recovery"
  tags: [dispatch, cleanup, evidence]
  description: |
    ### Covers

    - ac-session-evidence-survives-control
    - ac-branch-evidence-survives-control
    - ac-workspace-evidence-survives-control
    - ac-worktree-evidence-survives-control
    - ac-snapshot-evidence-survives-control
    - ac-audit-evidence-survives-control

    ### Required context

    Protection uses canonical active, final-gate in-flight, paused-held, and stopped-pending-cleanup task identities. Lifecycle control never independently grants cleanup eligibility.

    ### Deliverable

    All destructive workspace cleanup decisions receive protection and reject overlapping controlled evidence.

    ### Implementation

    Thread protection through workspace registry evaluation, physical reap, worktree removal, branch deletion, remote branch deletion, abandoned classification, and terminal reconciliation in src/agent-runtime/workspace.ts. Preserve unrelated terminal/integrated cleanup and block ambiguous ownership from blind deletion.

    ### Files

    - Create: tests/dispatch-controlled-evidence-protection.test.ts
    - Modify: src/agent-runtime/workspace.ts
    - Modify: tests/dispatch-artifact-protection.test.ts
    - Modify: tests/dispatch-workspace-cleanup.test.ts
    - Modify: tests/dispatch-workspace-cleanup-completion.test.ts
    - Modify: tests/dispatch-workspace-terminal-reconciliation.test.ts

    ### Behavioral tests

    Run each protected lifecycle state through every listed destructive surface; assert session, branch, workspace/worktree, snapshot, audit preservation and unchanged unrelated terminal cleanup.

    ### Verification

    - npm test -- tests/dispatch-controlled-evidence-protection.test.ts tests/dispatch-artifact-protection.test.ts tests/dispatch-workspace-cleanup.test.ts tests/dispatch-workspace-cleanup-completion.test.ts tests/dispatch-workspace-terminal-reconciliation.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide destructive-surface/protected-state matrix.

- title: Register, sanitize, and emit dispatch lifecycle events
  slug: task-dispatch-lifecycle-events
  priority: 2
  spec_ref: "@dispatch-event-taxonomy"
  depends_on:
    - "@task-patch-dispatch-events-specs"
    - "@task-engine-stop-recovery"
  tags: [dispatch, events, schema]
  description: |
    ### Covers

    - ac-applied-control-is-auditable
    - ac-noop-control-is-auditable
    - ac-failed-control-is-auditable
    - ac-failure-events-use-closed-error-codes

    ### Required context

    Identifiers are dispatch_control.pause_applied/start_applied/resume_applied/stop_applied/noop/failed. Payload is scope global/task, action start/pause/resume/stop, authority stopped/running/paused, projection stopped/running/paused/draining, outcome applied/noop/failed, reason, actor, source cli/api/ui/daemon_startup/daemon_shutdown/recovery, timestamp, task_id/task_ref only for task, and failure-only error_code. Codes are validation_failed, task_not_found, task_identity_ambiguous, task_identity_mismatch, invalid_transition, control_store_unavailable, control_store_corrupt, control_commit_failed, cancellation_timeout, cancellation_failed, session_closure_failed, cleanup_ownership_mismatch, cleanup_process_birth_mismatch, cleanup_leader_missing_group_alive, cleanup_identity_unverifiable, cleanup_group_unverifiable, internal_error.

    ### Deliverable

    One typed sanitized outcome emitter: applied uses matching applied id; noop has no error_code; failed has exactly one closed code only after durable outcome is known.

    ### Implementation

    Register domain/types in both schema owners, normalize default reason operator request/control removal/whitespace, bound reason 240 Unicode code points, actor 120, task_ref 200, and omit raw errors/prompts/secrets/terminal buffers/workspace paths. Emit agents topic. UI owner invalidates queryKeys.agents.all and refreshes automation event log.

    ### Files

    - Create: tests/dispatch-control-events.test.ts
    - Modify: src/schema/event-registry.ts
    - Modify: src/schema/event-payloads.ts
    - Modify: packages/shared/src/schemas.ts
    - Modify: packages/shared/src/websocket.ts
    - Modify: src/agent-runtime/dispatch.ts
    - Modify: tests/event-registry.test.ts
    - Modify: tests/event-payloads.test.ts
    - Modify: tests/event-bus.test.ts

    ### Behavioral tests

    Assert all identifiers, presence/absence, full enum rejection, bounds/redactions, and exactly one applied/noop/failed event per durable result.

    ### Verification

    - npm test -- tests/dispatch-control-events.test.ts tests/event-registry.test.ts tests/event-payloads.test.ts tests/event-bus.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide identifier, enum, sanitizer, and durable-result tables.

- title: Add canonical lifecycle API and compatibility adapters
  slug: task-daemon-dispatch-lifecycle-api
  priority: 2
  spec_ref: "@daemon-agent-dispatch"
  depends_on:
    - "@task-patch-dispatch-api-specs"
    - "@task-dispatch-lifecycle-events"
    - "@task-protect-controlled-dispatch-evidence"
  tags: [dispatch, daemon, api]
  description: |
    ### Covers

    - ac-status-reports-authority
    - ac-status-reports-projection
    - ac-status-reports-active-count
    - ac-status-reports-queued-count
    - ac-status-reports-held-count
    - ac-status-reports-held-task-identity
    - ac-status-reports-held-task-scope
    - ac-status-reports-held-task-mode
    - ac-status-reports-held-task-reason
    - ac-failure-api-uses-closed-error-codes
    - ac-api-failures-do-not-expose-raw-errors

    ### Required context

    Canonical GET /api/agent/status and POST /api/agent/dispatch/control body scope/action/task_ref optional/task_id optional/reason optional. Success/noop HTTP 200 is {ok:true,data:{global_authority,projection,cleanup_state,active_count,queue_depth,held_count,held_tasks,task_controls,degraded_targets,outcome},error:null}; errors are {ok:false,data:<current status>,error:{code,message,suggestion,details optional}} with typed fields/ids only. Error map: validation 400; not-found 404; identity mismatch/ambiguous/invalid transition/ownership/birth/verified-live-group 409; unavailable/corrupt/commit/unverifiable identity/group 503; timeout/cancellation/closure/internal 500.

    ### Deliverable

    Canonical control/status plus additive POST /api/agent/dispatch, /start, /stop and GET /api/agent/dispatch/status adapters.

    ### Implementation

    Preserve public status dispatch_enabled, active_invocations session_id/agent_id/task_ref/task_title/elapsed_ms/resolved_adapter, queued_invocations agent_id/task_ref/task_title/wait_ms/resolved_adapter, queue_depth, agent_definitions id/name/adapter/resolved_adapter/completed_sessions, degraded/degraded_targets and conditional runner/runner_validation; append lifecycle fields. Internal status preserves engine-present and no-engine shape without adding queued to no-engine; append camel-case lifecycle fields/error_code. Preserve existing success/no-op/Elysia 400 alias shapes. Cwd errors are only Invalid dispatch working directory and Dispatch is already running for another project. Exact invalid 409: dispatch {dispatch_enabled:<current-running-boolean>,error:"Invalid dispatch lifecycle transition",error_code:"invalid_transition"}; start {started:false,error:"Invalid dispatch lifecycle transition",status:<complete current status>,error_code:"invalid_transition"}; stop {stopped:false,reason:"invalid_transition",error_code:"invalid_transition"}. Precommit 503 uses route base plus code; postcommit cleanup maps 409/500/503 and route base plus cleanup_pending/error_code.

    ### Files

    - Create: tests/daemon-agent-dispatch-lifecycle.test.ts
    - Modify: packages/daemon/src/routes/agent-dispatch.ts
    - Modify: packages/daemon/src/server.ts
    - Modify: packages/shared/src/api.ts
    - Modify: tests/daemon-api/agent-dispatch.test.ts
    - Modify: tests/daemon-agent-dispatch-routes.test.ts

    ### Behavioral tests

    Deep-equality every compatibility shape/presence rule, canonical envelope, all error codes/statuses, sanitized cwd, exact 409 bodies, pre/postcommit distinction, and raw-field absence.

    ### Verification

    - npm test -- tests/daemon-agent-dispatch-lifecycle.test.ts tests/daemon-api/agent-dispatch.test.ts tests/daemon-agent-dispatch-routes.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide canonical/alias field/status fixtures and forbidden-field matrix.

- title: Add safe lifecycle CLI commands
  slug: task-cli-dispatch-lifecycle-controls
  priority: 3
  spec_ref: "@cli-agent-commands"
  depends_on:
    - "@task-patch-dispatch-cli-specs"
    - "@task-daemon-dispatch-lifecycle-api"
  tags: [dispatch, cli, safety]
  description: |
    ### Covers

    - ac-failure-cli-uses-closed-error-codes
    - ac-cli-failures-do-not-expose-raw-errors

    ### Required context

    Grammar: kspec agent dispatch start/pause/resume [--reason TEXT] [--json]; kspec agent dispatch stop [--reason TEXT] [--force] [--json]; kspec agent dispatch task pause|resume @task [--reason TEXT] [--json]; kspec agent dispatch task stop @task [--reason TEXT] [--force] [--json]; kspec agent status [--json]; kspec agent dispatch status [--json]. Mutations use only POST /api/agent/dispatch/control; both status commands use only GET /api/agent/dispatch/status and append lifecycle fields to current projection.

    ### Deliverable

    Parser/routing, human/JSON output, confirmation, and exits for all global/task controls.

    ### Implementation

    TTY stop without force prompts about cancellation/evidence; decline makes no request/exits 2. Force suppresses prompt. Noninteractive human stop without force exits 1 with guidance; JSON never prompts and requires force. KSPEC_SESSION_ID rejects global/task stop before prompt/HTTP even with force, exit 3. Start/pause/resume do not confirm. Usage/validation exit 1; success/noop 0; daemon/store/cancellation/recovery/task lookup 3. Render fixed codes/messages, no raw path/error.

    ### Files

    - Create: tests/cli-agent-dispatch-lifecycle.test.ts
    - Modify: src/cli/commands/agent.ts
    - Modify: src/cli/exit-codes.ts
    - Modify: src/cli/output.ts
    - Modify: tests/cli-agent-commands.test.ts
    - Modify: tests/cli-agent.test.ts

    ### Behavioral tests

    Assert exact grammar/URL, all TTY/force/JSON/dispatch-owned branches, decline no-request, exits, canonical task id, status route/preservation, cleanup/error output, and sanitization.

    ### Verification

    - npm test -- tests/cli-agent-dispatch-lifecycle.test.ts tests/cli-agent-commands.test.ts tests/cli-agent.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Supply command/route/exit and prompt-transcript tables.

- title: Migrate every lifecycle UI consumer and control
  slug: task-ui-dispatch-lifecycle-controls
  priority: 3
  spec_ref: "@ui-agent-dispatch"
  depends_on:
    - "@task-patch-dispatch-ui-specs"
    - "@task-daemon-dispatch-lifecycle-api"
  tags: [dispatch, ui, accessibility]
  description: |
    ### Covers

    - ac-ui-failures-do-not-expose-raw-errors

    ### Required context

    Inventory: packages/web-ui/src/lib/api.ts; packages/web-ui/src/routes/agents/+page.svelte; packages/web-ui/src/lib/components/agents/DispatchStatus.svelte, ActiveInvocationRow.svelte, QueuedInvocationRow.svelte, HeldTaskRow.svelte; packages/web-ui/src/lib/query/ws-invalidation.ts; packages/web-ui/src/routes/+page.svelte; packages/web-ui/src/routes/tasks/board/+page.svelte; packages/web-ui/src/lib/components/board/ActiveFleetRow.svelte; packages/web-ui/src/routes/automation/+page.svelte; packages/web-ui/src/lib/components/automation/DispatchTriggersSection.svelte and EventLogSection.svelte. Authority/projection is primary; absent maps dispatch_enabled true to running/false to stopped, except false plus active work retains active work and labels legacy unknown/stopping. Static mode is stopped, zero/empty/read-only.

    ### Deliverable

    Every consumer consistently projects lifecycle evidence and valid controls; agents events invalidate queryKeys.agents.all and refresh the automation event log.

    ### Implementation

    Update every listed consumer. Separate authority/projection from degraded/blocked. Show active/queued/held evidence. Render only matrix-valid controls. Pause never confirms; hard stop explains cancellation/evidence and cancel sends no request. Ensure accessible labels, polite live status, focus returns to invoking control, keyboard/narrow/reduced-motion support, and only sanitized failures.

    ### Files

    - Create: packages/web-ui/src/lib/components/agents/HeldTaskRow.svelte
    - Create: tests/web-ui/dispatch-lifecycle-controls.test.ts
    - Modify: packages/web-ui/src/lib/api.ts
    - Modify: packages/web-ui/src/routes/agents/+page.svelte
    - Modify: packages/web-ui/src/lib/components/agents/DispatchStatus.svelte
    - Modify: packages/web-ui/src/lib/components/agents/ActiveInvocationRow.svelte
    - Modify: packages/web-ui/src/lib/components/agents/QueuedInvocationRow.svelte
    - Modify: packages/web-ui/src/lib/query/ws-invalidation.ts
    - Modify: packages/web-ui/src/routes/+page.svelte
    - Modify: packages/web-ui/src/routes/tasks/board/+page.svelte
    - Modify: packages/web-ui/src/lib/components/board/ActiveFleetRow.svelte
    - Modify: packages/web-ui/src/routes/automation/+page.svelte
    - Modify: packages/web-ui/src/lib/components/automation/DispatchTriggersSection.svelte
    - Modify: packages/web-ui/src/lib/components/automation/EventLogSection.svelte
    - Modify: tests/web-ui/ws-cache-invalidation.test.ts
    - Modify: tests/web-ui/fleet-buffer.test.ts

    ### Behavioral tests

    Cover running/paused/draining/stopped/pending cleanup, legacy/no-authority, false-with-active, static, each inventory page, controls/task controls, confirm cancel, error, focus, keyboard, live region, and no raw failure text.

    ### Verification

    - npm test -- tests/web-ui/dispatch-lifecycle-controls.test.ts tests/web-ui/ws-cache-invalidation.test.ts tests/web-ui/fleet-buffer.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Supply consumer inventory, fallback fixtures, control matrix, accessibility/invalidation evidence.

- title: Verify lifecycle engine restart and race behavior
  slug: task-verify-engine-restart-races
  priority: 3
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on:
    - "@task-engine-stop-recovery"
    - "@task-protect-controlled-dispatch-evidence"
  tags: [dispatch, verification, engine]
  description: |
    ### Covers

    Verification only; implementation ownership does not move.

    ### Required context

    Join persisted control, watcher reload, admission, final gate, recovery, and protection using deterministic adapters/barriers only.

    ### Deliverable

    A black-box restart/race suite; no production behavior change.

    ### Implementation

    Add fixtures for paused/stopped bootstrap, watcher-before-commit/abort/rollback, stale state reconstruction, concurrent resume, control/final-gate ordering, each cleanup phase crash, A/B recovery, and evidence protection.

    ### Files

    - Create: tests/dispatch-lifecycle-blackbox.test.ts
    - Modify: tests/dispatch-control-store.test.ts
    - Modify: tests/dispatch-global-lifecycle.test.ts
    - Modify: tests/dispatch-stop-recovery.test.ts
    - Modify: tests/dispatch-controlled-evidence-protection.test.ts

    ### Behavioral tests

    Assert token/authority/projection/count/phase/process/session/evidence outcomes; fail on zero/twice external publication, blocked scope start, duplicate active task, or evidence deletion.

    ### Verification

    - npm test -- tests/dispatch-lifecycle-blackbox.test.ts tests/dispatch-control-store.test.ts tests/dispatch-global-lifecycle.test.ts tests/dispatch-stop-recovery.test.ts tests/dispatch-controlled-evidence-protection.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide scenario/barrier evidence and no ownership reassignment.

- title: Verify API and CLI lifecycle projection end to end
  slug: task-verify-api-cli-projection
  priority: 3
  spec_ref: "@daemon-agent-dispatch"
  depends_on:
    - "@task-cli-dispatch-lifecycle-controls"
    - "@task-verify-engine-restart-races"
  tags: [dispatch, verification, api, cli]
  description: |
    ### Covers

    Verification only; API, CLI, and event tasks remain behavior owners.

    ### Required context

    One daemon fixture with explicit cwd/ephemeral endpoint must drive canonical control, three aliases, public/internal status, CLI human/JSON, and events.

    ### Deliverable

    Exact cross-surface fixtures, not field-only smoke tests.

    ### Implementation

    Cover global/task matrices, canonical task identity, all code/status pairs, compatibility deep equality/presence, sanitized cwd, exact invalid 409s, cleanup pending, CLI routing/force/decline/exits, and applied/noop/failed events.

    ### Files

    - Create: tests/dispatch-lifecycle-surface-integration.test.ts
    - Modify: tests/daemon-agent-dispatch-lifecycle.test.ts
    - Modify: tests/cli-agent-dispatch-lifecycle.test.ts
    - Modify: tests/dispatch-control-events.test.ts

    ### Behavioral tests

    Every fixture asserts canonical code/status, alias shape, CLI exit/message/JSON code, event outcome, and forbidden-field absence.

    ### Verification

    - npm test -- tests/dispatch-lifecycle-surface-integration.test.ts tests/daemon-agent-dispatch-lifecycle.test.ts tests/cli-agent-dispatch-lifecycle.test.ts tests/dispatch-control-events.test.ts
    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Supply one response/exit/event comparison table.

- title: Verify lifecycle UI behavior in a real browser
  slug: task-verify-ui-lifecycle-browser
  priority: 3
  spec_ref: "@ui-agent-dispatch"
  depends_on:
    - "@task-ui-dispatch-lifecycle-controls"
    - "@task-verify-api-cli-projection"
  tags: [dispatch, verification, ui, accessibility]
  description: |
    ### Covers

    Verification only; UI AC ownership remains with task-ui-dispatch-lifecycle-controls.

    ### Required context

    Use E2E-managed daemon/local fixtures only. Cover agents, dashboard, board, fleet, automation triggers/event log at desktop/narrow viewports.

    ### Deliverable

    Focused Playwright lifecycle browser regression without provider work.

    ### Implementation

    Add running/paused/draining/stopped/pending-cleanup, legacy, and static fixtures; test evidence visibility, valid controls, confirmation cancel, mutation error, keyboard/focus/live region/reduced motion, and reachability. Do not change product UI here.

    ### Files

    - Create: tests/e2e/dispatch-lifecycle.spec.ts
    - Modify: tests/e2e/agents.spec.ts
    - Modify: tests/e2e/static-mode.spec.ts

    ### Behavioral tests

    Assert active/queued/held visibility on every consumer, no request after cancel, static read-only, accessible labels, focus return, sanitized error, and no narrow viewport horizontal overflow.

    ### Verification

    - npm run typecheck
    - npm run lint
    - git diff --check

    ### Reviewer handoff

    Provide scenario name, fixture/viewport/accessibility matrix, focus/live-region proof, and console/page-error outcome.
```

## Path Classification

At each dependency point, Create belongs only to its first owner: task-dispatch-control-persistence creates src/schema/dispatch-control.ts, src/parser/dispatch-control.ts, src/agent-runtime/dispatch-shadow-transaction.ts, src/agent-runtime/dispatch-control-store.ts, tests/dispatch-control-store.test.ts; task-engine-global-lifecycle creates tests/dispatch-global-lifecycle.test.ts; task-engine-task-pause-resume creates tests/dispatch-task-lifecycle.test.ts; task-final-pre-spawn-control-gate creates tests/dispatch-spawn-control-race.test.ts; task-engine-stop-recovery creates tests/dispatch-stop-recovery.test.ts; task-protect-controlled-dispatch-evidence creates tests/dispatch-controlled-evidence-protection.test.ts; task-dispatch-lifecycle-events creates tests/dispatch-control-events.test.ts; task-daemon-dispatch-lifecycle-api creates tests/daemon-agent-dispatch-lifecycle.test.ts; task-cli-dispatch-lifecycle-controls creates tests/cli-agent-dispatch-lifecycle.test.ts; task-ui-dispatch-lifecycle-controls creates packages/web-ui/src/lib/components/agents/HeldTaskRow.svelte and tests/web-ui/dispatch-lifecycle-controls.test.ts; task-verify-engine-restart-races creates tests/dispatch-lifecycle-blackbox.test.ts; task-verify-api-cli-projection creates tests/dispatch-lifecycle-surface-integration.test.ts; task-verify-ui-lifecycle-browser creates tests/e2e/dispatch-lifecycle.spec.ts. Every other listed path exists at that dependency point.

## Implementation Order

The six spec patches are independent metadata prerequisites, never one giant gate. Persistence follows engine/coalescing; global lifecycle follows persistence; task pause/resume, final gate, then shared stop recovery follow. Cleanup protection/events/API use only declared predecessors; CLI/UI follow API; the three verification tasks follow completed behaviors. Import remains draft and derive_from_specs false. Do not approve, derive, dispatch, or mutate kspec state, reviews, or resources from this revision.

