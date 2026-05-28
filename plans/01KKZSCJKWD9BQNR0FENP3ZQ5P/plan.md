# Dispatch Remote Sync

## Specs

```yaml
# ─── Core Sync Feature ───

- title: Dispatch Remote Branch Sync
  slug: dispatch-remote-branch-sync
  type: feature
  parent: "@agent-dispatch-engine"
  traits:
    - "@trait-error-guidance"
  description: |
    Automatic remote synchronization for dispatch-managed branches and the
    configured integration target branch (dispatch.base_branch). Ensures
    dispatch work is durable (pushed to remote), the integration target
    stays fresh (pulled from remote), and the engine degrades gracefully
    when sync operations fail.

    The sync remote is determined by convention: the first remote returned
    by git remote (typically origin). A future dispatch.remote config field
    can override this if multi-remote setups arise.

    Design decisions:
    - Dispatch branches are pushed after first invocation completion (not
      on creation), since an empty branch is noise.
    - Integration target uses fast-forward only — divergence is a structural
      problem requiring operator intervention, not auto-merge.
    - Target branch divergence degrades the engine. Individual task merge
      conflicts are handled by the reviewer agent via merge skill
      instructions, not by the dispatcher.
    - Existing workspaces provisioned from an older target commit are not
      rebased; staleness resolves naturally at merge time.
  acceptance_criteria:
    # ─── Dispatch Branch Push ───
    - id: ac-first-push-sets-tracking
      given: |
        An agent invocation completes on a canonical task branch that has
        never been pushed to remote, and remote sync is enabled
      when: |
        The dispatch engine processes the invocation completion
      then: |
        The dispatcher pushes the canonical branch to remote with upstream
        tracking established for subsequent pushes
    - id: ac-first-push-replaces-stale-ref
      given: |
        A remote branch with the same dispatch/task/ name already exists
        from a previous run (e.g. leftover from incomplete cleanup)
      when: |
        The first invocation push sets upstream tracking
      then: |
        The push replaces the stale remote ref safely (verifying no
        concurrent writer), rather than failing on ref mismatch
    - id: ac-subsequent-push
      given: |
        An agent invocation completes on a canonical task branch that
        already has upstream tracking, and the branch has new commits
        not yet on the remote
      when: |
        The dispatch engine processes the invocation completion
      then: |
        The dispatcher pushes the canonical branch to remote
    - id: ac-push-non-fatal
      given: |
        Any dispatch branch push or integration target push fails
        (network error, auth failure, remote rejection)
      when: |
        The push error is caught
      then: |
        The failure is logged as a warning with error details; the
        dispatch engine continues normal operation; the push is retried
        on the next applicable trigger (invocation completion or periodic
        sync)

    # ─── Integration Target Push ───
    - id: ac-push-target-after-merge
      given: |
        A reviewer agent merges a task branch into the integration target
        branch locally
      when: |
        The merge completes successfully
      then: |
        The dispatcher pushes the integration target branch to remote
    - id: ac-push-target-periodic
      given: |
        The periodic sync runs and the local integration target branch
        has commits not yet on the remote
      when: |
        The sync cycle completes
      then: |
        The dispatcher pushes the integration target branch to remote,
        retrying any previously failed post-merge pushes
    - id: ac-target-push-serialization
      given: |
        A post-merge push and a periodic sync push both target the
        integration target branch concurrently
      when: |
        The second push operation is initiated
      then: |
        The second operation is skipped; at most one push to the
        integration target runs at a time

    # ─── Integration Target Pull ───
    - id: ac-pull-target-on-start
      given: |
        The dispatch engine starts and remote sync is enabled
      when: |
        The engine initializes, before evaluating tasks for bootstrap
        dispatch
      then: |
        The engine syncs the integration target branch from remote;
        bootstrap task evaluation uses the synced state
    - id: ac-pull-target-periodic
      given: |
        The dispatch engine is running and no reviewer invocation is
        currently active
      when: |
        The configured sync interval elapses
      then: |
        The engine syncs the integration target branch from remote
    - id: ac-pull-target-periodic-deferred
      given: |
        The configured sync interval elapses while a reviewer invocation
        is active
      when: |
        The sync would normally run
      then: |
        The sync is deferred to the next interval; worker invocations
        do not block sync since they operate on isolated worktrees
    - id: ac-pull-target-before-provision
      given: |
        A new task workspace is about to be provisioned and the last
        successful target sync was more than sync_interval seconds ago
      when: |
        The dispatcher prepares the workspace
      then: |
        The engine syncs the integration target branch from remote
        before creating the task branch
    - id: ac-pull-ff-only
      given: |
        The integration target branch is being synced from remote
      when: |
        The sync completes
      then: |
        The local branch is advanced to match the remote only if the
        remote history is a strict superset of local; no merge commits
        are created

    # ─── Degraded State ───
    - id: ac-divergence-enters-degraded
      given: |
        The integration target branch sync detects that local and remote
        have diverged (local has commits not in remote, or remote history
        was rewritten)
      when: |
        The fast-forward sync fails
      then: |
        The engine enters degraded state with a reason describing the
        divergence
    - id: ac-divergence-log-guidance
      given: |
        The engine enters degraded state due to target branch divergence
      when: |
        The failure is logged
      then: |
        The log message distinguishes between "local has unpushed merges"
        and "remote history was rewritten" and includes resolution steps
        for each case
    - id: ac-degraded-no-provision
      given: |
        The dispatch engine is in degraded state
      when: |
        A new task becomes eligible for dispatch
      then: |
        No new workspaces are provisioned; the task remains in the queue;
        existing in-flight invocations continue to completion normally
    - id: ac-degraded-status-api
      given: |
        The dispatch engine is in degraded state
      when: |
        The dispatch status is queried (CLI or API)
      then: |
        The response includes the degraded flag, the failure reason, and
        the timestamp when degraded state was entered
    - id: ac-degraded-status-broadcast
      given: |
        The dispatch engine enters or exits degraded state
      when: |
        The state transition occurs
      then: |
        A sync state event is broadcast on the agents WebSocket topic
    - id: ac-degraded-auto-recover
      given: |
        The engine is in degraded state due to target branch divergence
      when: |
        A subsequent periodic sync succeeds (the operator resolved the
        divergence externally)
      then: |
        The engine exits degraded state and resumes normal dispatch
        operations, including evaluating queued tasks for provisioning
    - id: ac-degraded-recovery-logged
      given: |
        The engine exits degraded state via successful sync
      when: |
        The recovery occurs
      then: |
        The recovery is logged with the duration the engine was degraded

    # ─── Transient Failures ───
    - id: ac-transient-no-degrade
      given: |
        A remote fetch fails due to a transient error (network
        unreachable, DNS failure, connection timeout)
      when: |
        The sync interval fires
      then: |
        The failure is logged as a warning with error details; the
        engine remains in normal state and retries on the next interval
    - id: ac-repeated-transient-escalation
      given: |
        Remote sync operations have failed consecutively for more than
        a configurable threshold (default 5 intervals)
      when: |
        The next sync attempt also fails
      then: |
        The engine logs an escalated warning indicating persistent
        connectivity issues, including the failure count and duration
    - id: ac-repeated-transient-no-degrade
      given: |
        Consecutive transient failures have exceeded the escalation
        threshold
      when: |
        The engine evaluates its health state
      then: |
        The engine does not enter degraded state; transient failures
        may resolve without operator intervention

    # ─── No Remote ───
    - id: ac-no-remote
      given: |
        The repository has no configured git remote
      when: |
        The dispatch engine starts or any sync operation is triggered
      then: |
        All remote sync operations are skipped silently; the engine
        operates in local-only mode with no degraded state or warnings

    # ─── Cleanup ───
    - id: ac-cleanup-remote-branch
      given: |
        A task reaches a terminal state (completed or cancelled) and
        its dispatch branch has been pushed to remote
      when: |
        The workspace cleanup runs
      then: |
        The remote dispatch branch is deleted; deletion failure is
        non-fatal and logged as a warning

# ─── Configuration ───

- title: Dispatch Sync Configuration
  slug: dispatch-sync-configuration
  type: requirement
  parent: "@dispatch-workspace-configuration"
  traits:
    - "@trait-error-guidance"
  description: |
    Configuration surface for dispatch remote sync behavior in
    kspec.config.yaml. Controls sync interval and whether remote
    sync is enabled. Extends the existing dispatch config section.
  acceptance_criteria:
    - id: ac-sync-interval
      given: |
        kspec.config.yaml sets dispatch.sync_interval to 120
      when: |
        The dispatch engine starts and begins periodic sync
      then: |
        The periodic target branch sync runs every 120 seconds; the
        default when unset is 60 seconds; setting to 0 disables periodic
        sync entirely (on-start and before-provision syncs still run)
    - id: ac-remote-sync-disabled
      given: |
        kspec.config.yaml sets dispatch.remote_sync to false
      when: |
        The dispatch engine runs and an invocation completes
      then: |
        No remote push or pull operations execute; the engine operates
        in local-only mode identical to pre-sync behavior
    - id: ac-remote-sync-default
      given: |
        dispatch.remote_sync is not set in kspec.config.yaml and the
        repository has a remote named origin
      when: |
        The dispatch engine resolves its effective configuration
      then: |
        Remote sync defaults to true; if no remote exists, defaults to
        false; the resolved value is logged at engine startup
    - id: ac-validation
      given: |
        dispatch.sync_interval is set to a negative number or a
        non-integer
      when: |
        kspec validate runs or the config is loaded
      then: |
        A validation error identifies the invalid value and states the
        constraint (non-negative integer, in seconds)
```

## Tasks

```yaml
- title: "Add dispatch sync configuration schema and defaults"
  slug: task-dispatch-sync-config
  spec_ref: "@dispatch-sync-configuration"
  priority: 1
  tags: [dispatch, config]
  description: |
    Why: The dispatch engine needs configuration for remote sync behavior
    before any sync logic can be implemented. Without config schema, the
    sync features have no way to be enabled/disabled or tuned.

    What: Extend DispatchConfigSchema in src/parser/config.ts with two
    new fields: sync_interval (non-negative integer, default 60 seconds)
    and remote_sync (optional boolean, resolved at runtime). Add defaults
    to DEFAULT_CONFIG.dispatch. Wire through resolveConfig() with runtime
    remote detection for the default value. Update the typed config
    interface. Add Zod validation for sync_interval constraints.

    How: Follow the existing shadow.sync_interval pattern in config.ts
    (line 44). Add sync_interval and remote_sync to DispatchConfigSchema
    (line 122-148). Add defaults at line 396 (DEFAULT_CONFIG.dispatch).
    In resolveConfig() (~line 604), wire the new fields with fallback
    to defaults. The remote_sync runtime resolution (checking for git
    remote existence) should use the same listGitRemotes() from
    workspace.ts that the dispatch engine already uses. Add a validation
    test for negative/non-integer sync_interval values.

    Covers: @dispatch-sync-configuration ac-sync-interval,
    ac-remote-sync-disabled, ac-remote-sync-default, ac-validation.

- title: "Implement integration target branch sync"
  slug: task-dispatch-target-sync
  spec_ref: "@dispatch-remote-branch-sync"
  priority: 1
  depends_on:
    - "@task-dispatch-sync-config"
  tags: [dispatch, git]
  description: |
    Why: The integration target branch (dispatch.base_branch) is captured
    at workspace provisioning and never updated. Over time it drifts from
    remote, making merges increasingly stale and conflict-prone. The engine
    needs to keep it fresh.

    What: Fetch + fast-forward sync of the integration target from remote
    at three trigger points: engine start (before bootstrap), periodically
    when no reviewer is active (deferred when reviewer is active), and
    before workspace provisioning when stale. Fast-forward only — no merge
    commits created. Transient fetch failures warn but don't degrade.

    How: Add a syncTargetBranch() method to DispatchEngine that runs
    git fetch <remote> <base_branch> followed by git merge --ff-only
    <remote>/<base_branch> in the project dir (not a worktree). Track
    lastSyncTimestamp to gate before-provision syncs. Hook sync into
    three places: (1) start() — sync before bootstrap evaluation;
    (2) reconcile timer — sync as first step of reconciliation pass,
    skip if reviewer invocation active; (3) workspace provisioning path —
    sync if lastSyncTimestamp > sync_interval ago. Use a running guard
    (like ShadowSyncScheduler) so slow fetches don't stack. When no
    remote is configured, all sync operations are skipped silently.

    Covers: @dispatch-remote-branch-sync ac-pull-target-on-start,
    ac-pull-target-periodic, ac-pull-target-periodic-deferred,
    ac-pull-target-before-provision, ac-pull-ff-only,
    ac-transient-no-degrade, ac-no-remote.

- title: "Implement dispatch engine degraded state"
  slug: task-dispatch-degraded-state
  spec_ref: "@dispatch-remote-branch-sync"
  priority: 1
  depends_on:
    - "@task-dispatch-target-sync"
  tags: [dispatch, git]
  description: |
    Why: When the integration target branch diverges from remote (local
    has unpushed merges, or remote was force-pushed), the engine cannot
    provision workspaces from a reliable base. It needs a degraded state
    that blocks new work while letting in-flight work finish, with clear
    operator guidance and automatic recovery.

    What: A degraded state machine for the dispatch engine. Enters
    degraded when fast-forward sync fails due to divergence. Blocks new
    workspace provisioning. Exposes degraded status via CLI and API.
    Broadcasts state transitions on WebSocket. Auto-recovers when the
    next periodic sync succeeds. Tracks consecutive transient failure
    count for escalated warnings (threshold 5) without entering degraded.

    How: Add a degraded state object to DispatchEngine: { active: boolean,
    reason: string, enteredAt: Date | null }. In syncTargetBranch(),
    classify failures: ff-only rejection with local-ahead = "unpushed
    merges" guidance, ff-only rejection with remote-rewritten = "force
    push" guidance. When degraded is active, the drain loop skips
    provisioning but continues processing in-flight invocations. On
    successful sync while degraded, clear the state and trigger a queue
    drain. Track consecutiveTransientFailures counter (reset on any
    success); log escalated warning when threshold exceeded. Extend
    status() response with { degraded: { active, reason, enteredAt } }.
    Extend the dispatch status CLI to show a prominent warning line.
    Broadcast sync_state events on the agents WebSocket topic on
    enter/exit.

    Covers: @dispatch-remote-branch-sync ac-divergence-enters-degraded,
    ac-divergence-log-guidance, ac-degraded-no-provision,
    ac-degraded-status-api, ac-degraded-status-broadcast,
    ac-degraded-auto-recover, ac-degraded-recovery-logged,
    ac-repeated-transient-escalation, ac-repeated-transient-no-degrade.

- title: "Implement dispatch branch push lifecycle"
  slug: task-dispatch-branch-push
  spec_ref: "@dispatch-remote-branch-sync"
  priority: 1
  depends_on:
    - "@task-dispatch-sync-config"
  tags: [dispatch, git]
  description: |
    Why: Dispatch branches exist only locally. If the host dies or the
    worktree is cleaned up, all in-flight work is lost. Pushing to remote
    provides durability, visibility for other developers/CI, and enables
    the resume-from-remote path that workspace.ts already partially
    supports (tryRestoreBranchFromRemote).

    What: Push dispatch branches to remote at key lifecycle points:
    first invocation completion (set upstream tracking, safely replace
    stale remote refs from previous runs), subsequent invocation
    completions (normal push), and the integration target after reviewer
    merges. Also push the integration target during periodic sync when
    it has unpushed commits (retry for failed post-merge pushes). Delete
    remote dispatch branches on workspace cleanup. Serialize integration
    target pushes so at most one runs at a time. All push failures are
    non-fatal.

    How: Add pushDispatchBranch() and pushIntegrationTarget() helpers.
    pushDispatchBranch detects whether upstream tracking exists (via
    git rev-parse @{u}) to decide first-push vs normal-push behavior.
    First push uses --force-with-lease to safely handle stale remote
    refs (ac-first-push-replaces-stale-ref). Hook into dispatch.ts
    post-invocation path (fire-and-forget with error logging).
    pushIntegrationTarget uses a dedicated mutex (separate from
    shadowMutex) so concurrent pushes skip rather than queue. Hook into:
    (1) reviewer merge completion, (2) periodic sync (check
    isAheadOfUpstream before pushing). For cleanup
    (ac-cleanup-remote-branch), extend the existing workspace cleanup in
    workspace.ts to delete the remote ref when the workspace has upstream
    tracking. Respect remote_sync config toggle. Skip when no remote.

    Covers: @dispatch-remote-branch-sync ac-first-push-sets-tracking,
    ac-first-push-replaces-stale-ref, ac-subsequent-push,
    ac-push-non-fatal, ac-push-target-after-merge,
    ac-push-target-periodic, ac-target-push-serialization,
    ac-cleanup-remote-branch, ac-no-remote.

```

## Implementation Notes

### Design decisions

**Sync remote selection:** Use the first git remote (typically origin). The
same convention as shadow sync. If multi-remote support is needed later,
add dispatch.remote to config. Not needed now.

**Periodic sync scope:** The periodic sync does both pull AND push of the
integration target. Pull keeps it fresh from remote. Push retries any
failed post-merge pushes. This eliminates the "failed push, no retry"
gap without a separate push scheduler.

**Idle definition for periodic sync:** "No reviewer invocation active"
rather than "no invocation active." Workers operate on isolated worktrees
and don't touch the integration target, so syncing it while workers run
is safe. Only reviewer merges interact with the target branch.

**Stale workspace handling:** Workspaces provisioned from an older target
commit are NOT rebased. Staleness resolves at merge time. If the merge
conflicts, the task is blocked per ac-merge-conflict-blocks-task. This is
simpler and safer than mid-flight rebasing, which risks invalidating
in-progress work.

**Reconciliation integration:** Target sync runs as the first step of the
existing reconciliation pass rather than a separate timer. One interval
config, one timer, no races between independent schedulers. The sync has
a running guard so slow network operations don't block subsequent
reconciliation passes — if a sync is already in progress, the reconcile
skips it and proceeds with task evaluation.

**Before-provision sync with active reviewer:** The before-provision sync
(ac-pull-target-before-provision) checks lastSyncTimestamp staleness, not
reviewer activity. If a reviewer IS active and the sync is stale, the
provision sync still runs — it's safe because the provision creates a new
worktree from HEAD of the target, which doesn't interfere with the
reviewer's in-progress merge on a separate worktree. The periodic sync
skips during reviewer activity to avoid moving the target while a merge
is landing; the provision sync has no such concern.

### For @task-dispatch-sync-config
Config follows the existing shadow.sync_interval pattern. The remote_sync
default resolution needs to happen at dispatch engine start time (not
config parse time) since remote availability is a runtime check. Store the
resolved effective value so it doesn't change mid-run.

### For @task-dispatch-target-sync
The sync method should return a result enum: `synced`, `up_to_date`,
`skipped` (reviewer active / already running), `transient_failure`,
`diverged`. The degraded state task consumes this result to decide state
transitions.

### For @task-dispatch-degraded-state
The degraded state needs to be:
- Visible in `kspec agent dispatch status` (prominent warning line)
- Included in `GET /api/agent/status` response (degraded object with
  active, reason, enteredAt fields)
- Broadcast on the agents WebSocket topic (sync_state event)
- Logged clearly with resolution steps that distinguish divergence causes

The consecutive transient failure counter resets on any successful sync
operation (fetch or push).

### For @task-dispatch-branch-push
Push operations are fire-and-forget with respect to the dispatch loop —
they must not delay task evaluation or invocation spawning. Use
Promise-based async with error catch/log, not await in the critical path.
The integration target push mutex is separate from the shadow branch mutex
to avoid unnecessary contention between unrelated operations.

