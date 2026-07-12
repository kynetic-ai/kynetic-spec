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
- Mutation compatibility adapters preserve the exact table shapes on 200/400/409. New pre-commit store/corrupt/commit failures use 503 and append only route-appropriate `error_code` to `{dispatch_enabled:<prior-running>}`, `{started:false}`, or `{stopped:false}`. Post-commit cleanup failures use their mapped 409/500/503 status and `{dispatch_enabled:false,reason:"cleanup_pending",error_code}`, `{started:false,error_code}`, or `{stopped:false,reason:"cleanup_pending",error_code}` respectively. Uncategorized internal failures are 500 with the same route base and `internal_error`. Fixed compatibility `error` strings remain selected from current tables; raw errors are never forwarded.

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
    - id: ac-pause-allows-active-completion
      given: an invocation is active when its scope is paused
      when: the invocation continues
      then: it may finish naturally without pause cancelling its session
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
    - id: ac-reconstruction-does-not-promise-prior-fifo
      given: in-memory scheduling data was lost
      when: candidates are reconstructed
      then: prior FIFO order is not promised
    - id: ac-reconstruction-does-not-promise-prior-retry-timing
      given: in-memory scheduling data was lost
      when: candidates are reconstructed
      then: prior retry timing is not promised
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
    - id: ac-control-outcomes-are-auditable
      given: a lifecycle action is attempted
      when: its durable outcome is known
      then: one sanitized typed event records applied, no-op, or failed outcome
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
    - id: ac-failures-do-not-expose-raw-errors
      given: a lifecycle action fails
      when: an operator surface reports it
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
- Replace `@daemon-agent-dispatch ac-5`: **Given** `GET /api/agent/status` is called. **When** lifecycle state is available. **Then** every legacy field and field-presence rule in the plan's public-status table is preserved.
- Add `@daemon-agent-dispatch ac-public-status-lifecycle-additions`: **Given** `GET /api/agent/status` is called. **When** lifecycle state is available. **Then** lifecycle additions are appended at top level.
- Replace `@daemon-agent-dispatch ac-6`: **Given** a localhost client posts a valid lifecycle control. **When** transition processing succeeds. **Then** the response returns resulting status.
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
- Add `@dispatch-event-payload ac-dispatch-control-common-fields`: **Given** a dispatch-control event is emitted. **When** its payload is read. **Then** the common field set in the plan is present.
- Add `@dispatch-event-payload ac-dispatch-control-task-identity`: **Given** a task-scoped dispatch-control event is emitted. **When** its payload is read. **Then** canonical task identity is present.
- Add `@dispatch-event-payload ac-dispatch-control-field-bounds`: **Given** lifecycle event text exceeds a declared bound. **When** the payload is created. **Then** the field is truncated to that bound.
- Add `@dispatch-event-payload ac-dispatch-control-no-prompts`: **Given** lifecycle event input contains a prompt. **When** the payload is created. **Then** the prompt is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-secrets`: **Given** lifecycle event input contains a secret. **When** the payload is created. **Then** the secret is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-terminal-buffer`: **Given** lifecycle event input contains terminal-buffer text. **When** the payload is created. **Then** terminal-buffer text is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-workspace-path`: **Given** lifecycle event input contains a workspace path. **When** the payload is created. **Then** the workspace path is absent.
- Add `@dispatch-event-payload ac-dispatch-control-no-raw-input-error`: **Given** lifecycle event input contains a raw error. **When** the payload is created. **Then** the raw error is absent.
- Add `@dispatch-event-payload ac-dispatch-control-error-codes`: **Given** a dispatch-control failure is emitted. **When** payload validation runs. **Then** `error_code` is one value from the exact closed enum in the plan.
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
    Covers: ac-task-control-uses-canonical-identity, ac-controls-survive-restart, ac-uncommitted-control-is-not-visible, ac-failed-control-write-is-not-visible, ac-stale-control-is-not-visible, ac-invalid-control-is-not-visible, ac-external-commit-is-eventually-visible, ac-controls-do-not-change-readiness, ac-controls-do-not-change-degraded-targets.
    What: Implement version-1 `.kspec/dispatch-control.yaml` and its single parser/store authority exactly as frozen above.
    Why: No other slice can safely infer persistence, migration, locking, watcher, or corruption behavior.
    How: Create `src/agent-runtime/dispatch-shadow-transaction.ts` as the exported shared lock/commit owner and `src/agent-runtime/dispatch-control-store.ts` as snapshot owner; own schema/parser, index exports, watcher/cache mapping, atomic shadow-lock transaction, migration, corruption degradation, canonical ULID keys, and post-commit snapshot publication. Enforce the frozen lock order. Do not implement engine actions.
    Sources of Truth: Durable source of truth and recovery; `src/parser/yaml.ts`; dispatch shadow mutation discipline in `src/agent-runtime/workspace.ts`; `src/agent-runtime/task-identity.ts`.
    Files: Create `src/schema/dispatch-control.ts`, `src/parser/dispatch-control.ts`, `src/agent-runtime/dispatch-shadow-transaction.ts`, `src/agent-runtime/dispatch-control-store.ts`, and `tests/dispatch-control-store.test.ts`; update Existing `src/schema/index.ts`, `src/parser/index.ts`, `src/parser/file-lock.ts`, `src/agent-runtime/workspace.ts`, `packages/daemon/src/project-context.ts`, `packages/daemon/src/server.ts`, `src/daemon/entity-cache.ts`, `tests/daemon-entity-cache.test.ts`, and `tests/daemon-watcher-chokidar.test.ts`.
    Required tests: missing/version1/unknown/malformed; monotonic revision and canonical convergence/mismatch; repeated identical record mutation creates no second revision/commit while distinct mutations each create one revision/commit; atomic failure/lock concurrency; deterministic watcher-before-external-commit, watcher-before-abort, watcher-before-rollback, commit-before-watcher, duplicate self event, external committed update, dirty external write, ordinary commit false/throw, post-commit verification failure, stale/malformed revision, and force-reclaim rollback; assert prior snapshot/cache remains, no uncommitted bytes publish, and every valid external committed HEAD is eventually delivered once; no readiness/degraded mutation.
    Verification: npm test -- tests/dispatch-control-store.test.ts tests/daemon-entity-cache.test.ts tests/daemon-watcher-chokidar.test.ts; npm run typecheck; npm run lint.
    Review handoff: persisted fixture, migration/corruption matrix, lock evidence.

- title: Implement global start pause resume authority
  slug: task-engine-global-lifecycle
  priority: 1
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-dispatch-control-persistence"]
  tags: [dispatch, engine]
  description: |
    Covers: ac-global-pause-authority, ac-global-paused-work-does-not-start, ac-pause-allows-active-completion, ac-resume-reconciles-held-work, ac-resume-reconciles-eligible-work, ac-repeated-resume-does-not-duplicate, ac-concurrent-resume-does-not-duplicate, ac-paused-reconstruction-uses-current-state, ac-stopped-reconstruction-uses-current-state, ac-reconstruction-does-not-promise-prior-fifo, ac-reconstruction-does-not-promise-prior-retry-timing, ac-global-start-is-idempotent, ac-global-pause-is-idempotent, ac-global-resume-is-idempotent; @agent-dispatch-engine ac-resume-current-task-state, ac-resume-current-dispatch-rules.
    What: Apply the complete global start/pause/resume matrix, startup loading, held/coalesced intent, and current-state reconstruction.
    Why: Start and resume must not be interchangeable and pause must not clear evidence or active sessions.
    How: Update `src/agent-runtime/dispatch.ts`; load control before bootstrap; cover event, watcher, bootstrap, reconciliation, post-invocation, retry, coalescing and degraded recovery; keep stop/cancellation out.
    Sources of Truth: global matrix, queue/recovery contract, @per-task-dispatch-drain-coalescing.
    Files: `src/agent-runtime/dispatch.ts`, `tests/agent-dispatch-engine.test.ts`; create `tests/dispatch-global-lifecycle.test.ts`.
    Required tests: every start/pause/resume matrix cell; repeated and concurrent start/pause/resume prove one action-side-effect sequence at this dependency point; daemon startup stopped/paused/running; held count coalescing; no active cancellation on pause.
    Verification: npm test -- tests/agent-dispatch-engine.test.ts tests/dispatch-global-lifecycle.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts; typecheck; lint.
    Review handoff: matrix-to-test table and scheduling-ingress inventory.

- title: Enforce canonical task pause and resume
  slug: task-engine-task-pause-resume
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-global-lifecycle"]
  tags: [dispatch, tasks]
  description: |
    Covers: ac-task-paused-work-does-not-start, ac-task-control-preserves-unrelated-task-control, ac-task-control-preserves-global-authority, ac-task-resume-obeys-global-authority, ac-task-pause-is-idempotent, ac-task-resume-is-idempotent.
    What: Apply task pause/resume at every scheduling path using canonical identity.
    Why: A path-specific or slug-keyed hold can leak starts or block another task.
    How: Update dispatch scheduling paths; pause keeps matching active work natural; resume re-evaluates only current task and obeys global authority. Consume persistence identity contract without claiming it.
    Sources of Truth: task matrix; `src/agent-runtime/task-identity.ts`; current dedupe/exclusivity.
    Files: `src/agent-runtime/dispatch.ts`; create `tests/dispatch-task-lifecycle.test.ts`; update canonical identity integration test.
    Required tests: task A/B isolation; slug/ULID convergence; every ingress; repeated/concurrent task pause and resume prove one action-side-effect sequence; resume under global pause/stop; coalesced held counts.
    Verification: npm test -- tests/dispatch-task-lifecycle.test.ts tests/dispatch-canonical-task-identity-integration.test.ts; typecheck; lint.
    Review handoff: canonical identity and ingress matrices.

- title: Add final pre-spawn lifecycle gate
  slug: task-final-pre-spawn-control-gate
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-task-pause-resume"]
  tags: [dispatch, race]
  description: |
    Covers: ac-final-gate-prevents-process-creation, ac-final-gate-prevents-session-creation, ac-spawn-win-pause-allows-completion; @agent-dispatch-engine ac-final-gate-global-control, ac-final-gate-task-control, ac-pause-active-natural-completion, ac-pause-does-not-close-session.
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
    Covers: ac-stop-forbids-new-starts, ac-stop-cancels-active-work, ac-stop-closes-active-sessions, ac-stop-failure-retains-stopped-authority, ac-stop-failure-reports-pending-cleanup, ac-stop-failure-reports-no-success, ac-interrupted-stop-recovers-on-startup, ac-interrupted-stop-recovers-on-retry, ac-recovery-requires-session-ownership, ac-recovery-requires-process-birth, ac-missing-leader-live-group-remains-pending, ac-unverified-live-group-is-not-signalled, ac-live-group-prevents-cleanup-completion, ac-spawn-win-stop-cancels-invocation, ac-global-stop-is-idempotent; @agent-dispatch-engine ac-11; @per-task-dispatch-drain-coalescing ac-5, ac-stop-prevents-pending-drain-start, ac-stop-cancels-active-invocation.
    What: Implement commit-first global stop, crash-safe ownership, verified cancellation, session closure, shutdown reuse, and recovery.
    Why: Failure after authority commit must not reopen dispatch or signal a reused/unowned process.
    How: Extend the exact Existing session schema owner `src/sessions/types.ts` and persistence owner `src/sessions/store.ts`; update dispatch/invocation/session registry and shutdown wiring; durably bind adapter/session/task/daemon ownership plus Linux birth ticks before active publication; persist stopped+pending first; verify complete tuple before every signal; never signal unverifiable identity; retry cleanup on startup/stop. Do not own HTTP serialization.
    Sources of Truth: durable ownership/recovery contract; current DispatchEngine.stop, SessionRegistry.closeAll, and session metadata store.
    Files: Existing `src/agent-runtime/dispatch.ts`, `src/agent-runtime/invocation.ts`, `src/agent-runtime/session-registry.ts`, `src/sessions/types.ts`, `src/sessions/store.ts`, `packages/daemon/src/routes/agent-dispatch.ts`, `tests/agent-dispatch-engine.test.ts`, `tests/active-session-registry.test.ts`, and `tests/dispatch-spawn-control-race.test.ts`; Create `tests/dispatch-stop-recovery.test.ts`.
    Required tests: pre/post-spawn ownership persistence failure; matching Linux birth token; absent leader plus empty group; PID/start-time reuse; each adapter/session/task/owner tuple mismatch; unreadable `/proc`; unsupported platform; absent leader with surviving strongly verified group; absent leader with surviving unverifiable group; no cleanup completion while any group lives; cancellation timeout/failure; closure failure; crash after every phase; startup recovery; repeated/concurrent global stop proves one stop-side-effect sequence plus cleanup retry; no signal for unverifiable targets; no false success.
    Verification: npm test -- tests/dispatch-stop-recovery.test.ts tests/dispatch-spawn-control-race.test.ts tests/active-session-registry.test.ts tests/agent-dispatch-engine.test.ts; npm run typecheck; npm run lint.
    Review handoff: session schema diff, process-identity decision table, signal trace, and cleanup fault results.

- title: Implement recoverable targeted task hard stop
  slug: task-engine-task-hard-stop
  priority: 2
  spec_ref: "@dispatch-lifecycle-control-authority"
  depends_on: ["@task-engine-task-pause-resume", "@task-engine-global-hard-stop"]
  tags: [dispatch, cancellation, tasks]
  description: |
    Covers: ac-task-stop-cancels-matching-work, ac-task-stop-preserves-unrelated-invocations, ac-task-stop-closes-matching-session, ac-task-stop-preserves-unrelated-sessions, ac-task-stop-failure-retains-stopped-authority, ac-task-stop-failure-reports-pending-cleanup, ac-task-stop-failure-reports-no-success, ac-task-interrupted-stop-recovers-on-startup, ac-task-interrupted-stop-recovers-on-retry, ac-task-stop-is-idempotent.
    What: Stop one canonical task without disturbing unrelated work.
    Why: Global closeAll or ref aliases violate task isolation.
    How: Add targeted active-controller/session ownership and close-by-canonical-task; commit task stopped+pending first; remove matching queue/retry/coalescing only; retry cleanup; resume reconstructs current state.
    Sources of Truth: task matrix/recovery; active invocation detail; SessionRegistry.
    Files: Existing `src/agent-runtime/dispatch.ts`, `src/agent-runtime/session-registry.ts`, `src/sessions/types.ts`, `src/sessions/store.ts`, `tests/active-session-registry.test.ts`, `tests/dispatch-stop-recovery.test.ts`, and `tests/dispatch-task-lifecycle.test.ts` (created by prerequisite `@task-engine-task-pause-resume`).
    Required tests: A/B active and queued isolation; partial failure/restart recovery; repeated/concurrent task stop proves one task-stop side-effect sequence plus cleanup retry; evidence retained.
    Verification: npm test -- tests/dispatch-task-lifecycle.test.ts tests/active-session-registry.test.ts tests/dispatch-stop-recovery.test.ts; typecheck; lint.
    Review handoff: targeted ownership proof and unrelated-session assertions.

- title: Protect controlled dispatch evidence from cleanup
  slug: task-protect-held-dispatch-evidence
  priority: 2
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on: ["@task-engine-task-hard-stop"]
  tags: [dispatch, cleanup]
  description: |
    Covers: ac-session-evidence-survives-control, ac-branch-evidence-survives-control, ac-workspace-evidence-survives-control, ac-worktree-evidence-survives-control, ac-snapshot-evidence-survives-control, ac-audit-evidence-survives-control; @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected.
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
    Covers: ac-control-outcomes-are-auditable, ac-failure-events-use-closed-error-codes; @dispatch-event-taxonomy ac-dispatch-control-domain; @dispatch-event-payload ac-dispatch-control-common-fields, ac-dispatch-control-task-identity, ac-dispatch-control-field-bounds, ac-dispatch-control-no-prompts, ac-dispatch-control-no-secrets, ac-dispatch-control-no-terminal-buffer, ac-dispatch-control-no-workspace-path, ac-dispatch-control-no-raw-input-error, ac-dispatch-control-error-codes, ac-dispatch-control-no-raw-error.
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
    Covers: ac-status-reports-authority, ac-status-reports-projection, ac-status-reports-active-count, ac-status-reports-queued-count, ac-status-reports-held-count, ac-status-reports-held-task-identity, ac-status-reports-held-task-scope, ac-status-reports-held-task-mode, ac-status-reports-held-task-reason, ac-failure-api-uses-closed-error-codes, ac-failures-do-not-expose-raw-errors; @daemon-agent-dispatch ac-5, ac-public-status-lifecycle-additions, ac-6, ac-control-error-current-status, ac-control-missing-identity, ac-control-ref-canonicalization, ac-control-identity-mismatch, ac-control-failure-no-success, ac-cleanup-failure-no-success.
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
    Covers: ac-failure-cli-uses-closed-error-codes; @cli-agent-commands ac-5, ac-start-reports-authority, ac-pause-reports-authority, ac-resume-reports-authority, ac-lifecycle-command-reports-projection, ac-declined-stop-sends-no-request, ac-declined-stop-exit, ac-task-control-canonicalization, ac-lifecycle-status-authority, ac-lifecycle-status-projection, ac-lifecycle-status-active-count, ac-lifecycle-status-queued-count, ac-lifecycle-status-held-count.
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
    Covers: @ui-agent-dispatch ac-2, ac-status-projection, ac-status-active-work-visible, ac-status-queued-work-visible, ac-status-held-work-visible, ac-3, ac-stopped-actions-valid, ac-control-separated-from-degraded, ac-control-separated-from-blocked, ac-hard-stop-confirmation-cancellation, ac-hard-stop-confirmation-evidence, ac-hard-stop-confirmation-cancelled, ac-lifecycle-controls-labelled, ac-lifecycle-focus-retained, ac-lifecycle-live-update.
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
