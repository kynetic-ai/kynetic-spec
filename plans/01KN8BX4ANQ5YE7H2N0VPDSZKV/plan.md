# Workspace-Scoped Integration Target Sync

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Description and Foundation ───

- title: Rewrite dispatch-remote-branch-sync description for workspace-scoped targets
  slug: task-sync-description-rewrite
  priority: 1
  tags: [spec-update, dispatch, sync]
  spec_ref: "@dispatch-remote-branch-sync"
  description: |
    Rewrite the description of @dispatch-remote-branch-sync to replace
    the single-global-target assumption with workspace-scoped target
    terminology.

    Why: The current description says "the configured integration target
    branch (dispatch.base_branch)" — treating the integration target as
    a single global value. Since @plan-branch-dispatch-target was
    implemented, each workspace can have a different integration target
    (the plan's branch when the task belongs to a plan with a branch set,
    or the project's configured base branch otherwise). The sync spec's
    description still reflects the pre-plan-branch world, and every AC
    inherits this single-target framing. Updating the description first
    establishes the vocabulary that subsequent AC updates will use.

    What: Replace the current description with text that:
    - Defines "active integration targets" as the set of distinct
      integration target branches across all non-closed workspaces, plus
      the project's configured base branch (which is always active).
    - States that each workspace's integration target is resolved at
      provisioning time (by @plan-branch-dispatch-target for plan-scoped
      tasks, or from dispatch.base_branch for others).
    - Preserves the existing design decisions (push after first
      invocation completion not on creation, fast-forward only, staleness
      resolves at merge time).
    - Adds a design decision: the active target set is rebuilt from the
      workspace registry on engine start, not maintained incrementally,
      to avoid stale-set races.
    - Adds a design decision: degraded state, staleness tracking, and
      push serialization are per-target-branch so that one diverged
      target does not block tasks targeting healthy branches.
    - Adds a design decision: the push and pull paths must share a
      single source of truth for active targets. The current codebase
      has two parallel state groups (push-side and pull-side) that
      could diverge; the unified active target set eliminates this.
    - Notes the concurrent merge constraint: when two reviewers merge
      concurrently into the same integration target, git ref serialization
      means one merge succeeds and the other fails non-fast-forward. The
      failing task returns to needs_work via normal review disposition.
      This is expected behavior, not a bug.

    How: Use kspec item set @dispatch-remote-branch-sync --description
    with the revised text. The description should be a block of plain
    text, not YAML. Run kspec item get @dispatch-remote-branch-sync
    afterward to verify the update.

    Covers: @dispatch-remote-branch-sync description (rewrite).

- title: Add active target set lifecycle ACs to dispatch-remote-branch-sync
  slug: task-sync-active-target-acs
  priority: 1
  tags: [spec-update, dispatch, sync]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-sync-description-rewrite"
  description: |
    Add new acceptance criteria to @dispatch-remote-branch-sync that
    define when integration targets enter and leave the active set, and
    how the set is rebuilt on engine start.

    Why: The existing spec has no concept of multiple integration targets
    or their lifecycle. Before updating the push/pull/degraded ACs to
    reference "active targets," the spec needs ACs that define what
    makes a target active. Without this foundation, the updated ACs
    would reference an undefined concept.

    What: Add three new ACs via kspec item ac add:

    ac-active-target-includes-base:
      given: The dispatch engine is running with remote sync enabled
      when: The active integration target set is evaluated
      then: The project's configured base branch is always included
            in the active set, regardless of whether any workspace
            currently targets it

    ac-active-target-rebuilt-on-start:
      given: The dispatch engine starts with remote sync enabled and
             the workspace registry contains non-closed workspaces
      when: The engine initializes the active integration target set
      then: The set is rebuilt by collecting the distinct integration
            target branches from all non-closed workspace records,
            plus the configured base branch

    ac-active-target-removed-on-cleanup:
      given: A workspace is cleaned up and no other non-closed
             workspace has the same integration target branch
      when: The active target set is re-evaluated
      then: That integration target branch is removed from the
            active set

    How: Run kspec item ac add commands against
    @dispatch-remote-branch-sync, one per AC. Use the exact id, given,
    when, and then text above. Verify with kspec item get afterward.

    Covers: @dispatch-remote-branch-sync (new ACs:
    ac-active-target-includes-base, ac-active-target-rebuilt-on-start,
    ac-active-target-removed-on-cleanup).

# ─── Phase 2: Push Path Updates ───

- title: Update push ACs on dispatch-remote-branch-sync for workspace-scoped targets
  slug: task-sync-push-ac-updates
  priority: 1
  tags: [spec-update, dispatch, sync]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-sync-active-target-acs"
  description: |
    Rewrite the three push-related ACs on @dispatch-remote-branch-sync
    to use the workspace's integration target branch instead of a single
    global target. Add a new AC for concurrent merge failure handling.

    Why: The push ACs (ac-push-target-after-merge, ac-push-target-periodic,
    ac-target-push-serialization) all say "the integration target branch"
    as if there is exactly one. Since workspaces can now have different
    integration targets (plan branches vs the default base), the push
    path must operate on the correct per-workspace target. The current
    implementation pushes the global base branch after every reviewer
    completion, which means plan branches that receive merged work are
    never pushed to remote — their merged commits exist only locally.
    Additionally, when two reviewers merge concurrently into the same
    target, the second merge fails at the git ref level. The spec should
    document this expected failure mode.

    What: Rewrite the following existing ACs and add new ACs:

    ac-push-target-after-merge (REWRITE):
      given: A reviewer agent merges a task branch into the workspace's
             integration target branch locally
      when: The dispatch engine processes the reviewer invocation
            completion
      then: The dispatcher pushes the workspace's integration target
            branch to remote

    ac-push-target-periodic (REWRITE):
      given: The periodic sync runs and at least one active integration
             target branch has local commits not yet on the remote
      when: The sync cycle evaluates each active target
      then: The dispatcher pushes each active integration target that
            has unpushed commits

    ac-push-target-periodic-retry (NEW):
      given: A previous post-merge push for an active integration
             target failed
      when: The periodic sync cycle evaluates that target
      then: The push is retried for that target

    ac-target-push-serialization (REWRITE):
      given: Two push operations target the same integration target
             branch concurrently
      when: The second push operation is initiated
      then: The second operation is skipped for that branch

    ac-target-push-cross-branch-concurrency (NEW):
      given: Push operations target two different integration target
             branches
      when: Both push operations are initiated
      then: Both pushes may proceed concurrently

    ac-concurrent-merge-same-target (NEW):
      given: Two reviewer invocations attempt to merge their respective
             task branches into the same integration target branch
             concurrently
      when: The second merge is attempted after the first has updated
            the target branch ref
      then: The second merge fails with a non-fast-forward error

    ac-concurrent-merge-fix-cycle (NEW):
      given: A reviewer merge fails due to a concurrent update to the
             same integration target branch
      when: The dispatch engine processes the failed reviewer invocation
      then: The affected task follows the standard fix cycle path

    How: Run kspec item ac set for the rewritten ACs, and kspec item
    ac add for the new ones. Use a kspec batch command to make all
    changes atomic. Verify with kspec item get afterward.

    Covers: @dispatch-remote-branch-sync ac-push-target-after-merge
    (rewrite), ac-push-target-periodic (rewrite),
    ac-push-target-periodic-retry (new),
    ac-target-push-serialization (rewrite),
    ac-target-push-cross-branch-concurrency (new),
    ac-concurrent-merge-same-target (new),
    ac-concurrent-merge-fix-cycle (new).

# ─── Phase 3: Pull/Sync Path Updates ───

- title: Update pull/sync ACs on dispatch-remote-branch-sync for workspace-scoped targets
  slug: task-sync-pull-ac-updates
  priority: 1
  tags: [spec-update, dispatch, sync]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-sync-active-target-acs"
  description: |
    Rewrite the pull/sync-related ACs on @dispatch-remote-branch-sync
    to operate on all active integration targets instead of a single
    global branch. Add new ACs for per-target staleness tracking and
    partial sync failure handling.

    Why: The pull/sync ACs (ac-pull-target-on-start,
    ac-pull-target-periodic, ac-pull-target-before-provision,
    ac-pull-ff-only) all refer to syncing "the integration target
    branch" — singular. With multiple active targets, each needs
    independent sync. The current implementation uses a single
    _lastTargetSyncTimestamp, which means syncing the base branch
    makes a plan branch appear fresh even though it was never synced.
    The before-provision sync must sync the specific target for the
    workspace being provisioned. Additionally, when syncing multiple
    targets, a failure on one target must not prevent syncing the
    others — the sync cycle must continue through all active targets.

    What: Rewrite the following existing ACs and add new ACs:

    ac-pull-target-on-start (REWRITE):
      given: The dispatch engine starts and remote sync is enabled
      when: The engine initializes, before evaluating tasks for
            bootstrap dispatch
      then: The engine syncs every branch in the active integration
            target set from remote

    ac-pull-target-on-start-before-bootstrap (NEW):
      given: The dispatch engine has completed its startup sync of
             active integration targets
      when: The engine evaluates tasks for bootstrap dispatch
      then: Bootstrap task evaluation uses the synced state of each
            target

    ac-pull-target-periodic (REWRITE):
      given: The dispatch engine is running and no reviewer invocation
             is currently active on a given integration target
      when: The configured sync interval elapses
      then: The engine syncs that integration target branch from
            remote

    ac-pull-target-periodic-deferred (REWRITE):
      given: The configured sync interval elapses while a reviewer
             invocation is active on a specific integration target
      when: The sync evaluates that target
      then: The sync of that specific target is deferred to the next
            interval

    ac-pull-target-before-provision (REWRITE):
      given: A new task workspace is about to be provisioned and the
             last successful sync of that workspace's resolved
             integration target was more than sync_interval seconds ago
      when: The dispatcher prepares the workspace
      then: The engine syncs the specific integration target branch
            for this workspace from remote before creating the task
            branch

    ac-pull-ff-only (REWRITE):
      given: An integration target branch is being synced from remote
      when: The sync completes
      then: The local branch is advanced to match the remote only if
            the remote history is a strict superset of local

    ac-pull-no-merge-commits (NEW):
      given: An integration target branch is being synced from remote
      when: The sync completes
      then: No merge commits are created on the local branch

    ac-per-target-staleness (NEW):
      given: The engine tracks sync freshness for integration targets
      when: A sync completes successfully for one target
      then: Only that target's staleness timestamp is updated

    ac-per-target-staleness-isolation (NEW):
      given: A sync completes successfully for one integration target
      when: Another target's staleness is evaluated
      then: The other target's staleness state is unaffected by the
            first target's sync

    ac-partial-sync-continues (NEW):
      given: The periodic sync is iterating through the active
             integration target set and one target fails
      when: The failure is handled for that target
      then: The sync cycle continues to the remaining targets

    ac-partial-sync-scoped-degradation (NEW):
      given: A sync failure occurs for one target during a periodic
             sync cycle
      when: The engine evaluates the failure
      then: Only the failed target enters degraded state or logs a
            warning

    How: Run kspec item ac set for the rewritten ACs, and kspec item
    ac add for the new ones. Use a kspec batch command to make all
    changes atomic. Verify with kspec item get afterward.

    Covers: @dispatch-remote-branch-sync ac-pull-target-on-start
    (rewrite), ac-pull-target-on-start-before-bootstrap (new),
    ac-pull-target-periodic (rewrite),
    ac-pull-target-periodic-deferred (rewrite),
    ac-pull-target-before-provision (rewrite), ac-pull-ff-only
    (rewrite), ac-pull-no-merge-commits (new),
    ac-per-target-staleness (new),
    ac-per-target-staleness-isolation (new),
    ac-partial-sync-continues (new),
    ac-partial-sync-scoped-degradation (new).

# ─── Phase 4: Degraded State Updates ───

- title: Update degraded state ACs on dispatch-remote-branch-sync for per-target scoping
  slug: task-sync-degraded-ac-updates
  priority: 1
  tags: [spec-update, dispatch, sync]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-sync-active-target-acs"
  description: |
    Rewrite the degraded state ACs on @dispatch-remote-branch-sync so
    that degraded state is scoped per integration target branch instead
    of being a single global engine flag.

    Why: The current degraded state is a single boolean on the dispatch
    engine (this._degraded). When it is set, ALL provisioning stops —
    even for tasks targeting a completely healthy branch. With plan
    branches, this creates an unacceptable blast radius: a diverged plan
    branch blocks tasks targeting the healthy base branch, and vice versa.
    Per-target degraded state means a diverged plan branch only blocks
    tasks whose resolved integration target is that plan branch.

    The drain logic change is the hardest part of the eventual
    implementation. Currently, the drain loop checks this._degraded and
    returns early if true, skipping all tasks. With per-target degraded
    state, the drain loop must resolve each candidate task's integration
    target (via plan_ref → plan.branch → resolved target) before checking
    degraded state for that specific target. This creates a dependency:
    target resolution must happen before the degraded check, not after.
    The spec should capture this ordering requirement.

    What: Rewrite the following existing ACs and add new ACs:

    ac-divergence-enters-degraded (REWRITE):
      given: An integration target branch sync detects that local and
             remote have diverged
      when: The fast-forward sync fails for that target
      then: That specific integration target enters degraded state
            with a reason describing the divergence

    ac-divergence-scoped-to-target (NEW):
      given: One integration target enters degraded state due to
             divergence
      when: Other active integration targets are evaluated
      then: The other targets remain unaffected and continue normal
            sync operations

    ac-divergence-log-target (NEW):
      given: An integration target enters degraded state due to branch
             divergence
      when: The failure is logged
      then: The log message identifies the affected target branch

    ac-divergence-log-classification (REWRITE):
      given: An integration target enters degraded state due to branch
             divergence
      when: The failure is logged
      then: The log message distinguishes between "local has unpushed
            merges" and "remote history was rewritten"

    ac-divergence-log-resolution (NEW):
      given: An integration target enters degraded state due to branch
             divergence
      when: The failure is logged
      then: The log message includes resolution steps appropriate to
            the type of divergence

    ac-degraded-no-provision (REWRITE):
      given: A task becomes eligible for dispatch and its resolved
             integration target is in degraded state
      when: The dispatch engine evaluates the task for provisioning
      then: The task is not provisioned

    ac-degraded-task-queued (NEW):
      given: A task is not provisioned because its integration target
             is in degraded state
      when: The dispatch engine skips the task
      then: The task remains in the queue for future evaluation

    ac-degraded-healthy-unblocked (NEW):
      given: One integration target is in degraded state
      when: A task targeting a non-degraded integration target becomes
            eligible for dispatch
      then: The task is provisioned normally

    ac-degraded-inflight-continues (NEW):
      given: An integration target enters degraded state
      when: An invocation is already in-flight for a workspace
            targeting that target
      then: The in-flight invocation continues to completion

    ac-degraded-auto-recover (REWRITE):
      given: An integration target is in degraded state due to branch
             divergence
      when: A subsequent periodic sync of that specific target succeeds
      then: That target exits degraded state

    ac-degraded-recovery-requeues (NEW):
      given: An integration target exits degraded state
      when: The recovery is processed
      then: Tasks targeting that integration target become eligible
            for provisioning again

    ac-degraded-status-api (REWRITE):
      given: One or more integration targets are in degraded state
      when: The dispatch status is queried via CLI or API
      then: The response includes the branch name of each degraded
            target

    ac-degraded-status-api-reason (NEW):
      given: One or more integration targets are in degraded state
      when: The dispatch status is queried via CLI or API
      then: The response includes the failure reason for each
            degraded target

    ac-degraded-status-api-timestamp (NEW):
      given: One or more integration targets are in degraded state
      when: The dispatch status is queried via CLI or API
      then: The response includes the timestamp when each target
            entered degraded state

    ac-degraded-status-broadcast (REWRITE):
      given: An integration target enters or exits degraded state
      when: The state transition occurs
      then: A sync state event is broadcast on the agents WebSocket
            topic

    ac-degraded-status-broadcast-target (NEW):
      given: An integration target enters or exits degraded state
      when: The sync state event is broadcast
      then: The event identifies the specific target branch and the
            new state

    ac-degraded-recovery-logged (REWRITE):
      given: An integration target exits degraded state via successful
             sync
      when: The recovery occurs
      then: The recovery is logged with the target branch name

    ac-degraded-recovery-logged-duration (NEW):
      given: An integration target exits degraded state via successful
             sync
      when: The recovery is logged
      then: The log includes the duration that target was degraded

    How: Run kspec item ac set for the rewritten ACs, and kspec item
    ac add for the new ones. Use a kspec batch command to make all
    changes atomic. Verify with kspec item get afterward.

    Note on ac-degraded-no-provision ordering: The rewritten AC implies
    the drain loop resolves the task's integration target BEFORE checking
    degraded state. The current implementation checks degraded state
    first (a global early return) and resolves the target later during
    provisioning. This ordering change is the key architectural shift
    and should be called out in implementation task descriptions when
    the implementation plan is created.

    Covers: @dispatch-remote-branch-sync ac-divergence-enters-degraded
    (rewrite), ac-divergence-scoped-to-target (new),
    ac-divergence-log-target (new), ac-divergence-log-classification
    (rewrite), ac-divergence-log-resolution (new),
    ac-degraded-no-provision (rewrite), ac-degraded-task-queued (new),
    ac-degraded-healthy-unblocked (new),
    ac-degraded-inflight-continues (new),
    ac-degraded-auto-recover (rewrite), ac-degraded-recovery-requeues
    (new), ac-degraded-status-api (rewrite),
    ac-degraded-status-api-reason (new),
    ac-degraded-status-api-timestamp (new),
    ac-degraded-status-broadcast (rewrite),
    ac-degraded-status-broadcast-target (new),
    ac-degraded-recovery-logged (rewrite),
    ac-degraded-recovery-logged-duration (new).

# ─── Phase 5: Implementation — Active Target Set Infrastructure ───


- title: Unify sync state and implement active target set management
  slug: task-impl-active-target-set
  priority: 1
  tags: [dispatch, sync, implementation]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-sync-description-rewrite"
    - "@task-sync-active-target-acs"
  description: |
    Replace the dual push/pull state groups in the dispatch engine with
    a unified active target set, and add methods to rebuild, query, and
    update the set.

    Why: The dispatch engine currently maintains two parallel sets of
    state for integration target tracking. The push side has
    this.integrationTargetBranch (dispatch.ts line 870, set at line 979)
    and the pull side has this._syncBaseBranch (dispatch.ts line 886,
    set at line 3052). Both are initialized independently in start() from
    the same config value and both store a single branch name. With
    workspace-scoped targets, both paths need to operate on a shared set
    of active branches. Unifying these into a single data structure is
    the foundation that all subsequent implementation tasks depend on.

    What:
    - Remove the fields: this.integrationTargetBranch (line 870),
      this._syncBaseBranch (line 886). Replace with a single
      this._activeTargets: Set<string> that holds all branch names
      the engine should push to and pull from.
    - Keep a this._configuredBaseBranch: string field to track the
      project's configured base branch (always in the active set).
    - Add method _rebuildActiveTargetSet(): reads all non-closed
      workspace records from the registry, collects distinct
      integrationTargetBranch values, unions with _configuredBaseBranch,
      and replaces _activeTargets. This method is called during engine
      start (replacing both line 979 and line 3052 initialization).
    - Add method _addActiveTarget(branch: string): adds a branch to
      the set. Called after workspace provisioning when a new target
      appears.
    - Add method _removeActiveTargetIfOrphaned(branch: string): removes
      a branch if no non-closed workspace targets it and it is not the
      configured base branch. Called after workspace cleanup.
    - Update _resolveBaseBranch() (line 1445) to return the active set
      or accept a specific branch parameter, depending on caller needs.
      Some callers need "which branch?" (post-merge push) and others
      need "all branches" (periodic sync).
    - Update the two initialization sites: the push-side init at line 979
      and the pull-side init at line 3052 both call
      _rebuildActiveTargetSet() instead of caching a single branch.

    How: The workspace registry is already loaded during engine start.
    Use the registry's list method to get non-closed workspaces, extract
    integrationTargetBranch from each record's metadata (via toMetadata
    or directly from record.integration.target_branch), and deduplicate
    into a Set. The configured base branch comes from the existing config
    resolution (resolvedConfig.baseBranch). The _addActiveTarget and
    _removeActiveTargetIfOrphaned methods are simple Set operations — the
    "rebuild from registry" approach means they only need to handle the
    incremental case for efficiency, and _rebuildActiveTargetSet is the
    authoritative fallback.

    Testing: Unit test that _rebuildActiveTargetSet produces the correct
    set from mock registry data (empty registry = just base branch,
    multiple workspaces with same target = one entry, multiple targets =
    all present). Test that _removeActiveTargetIfOrphaned does not remove
    the configured base branch. Test that the push and pull paths read
    from the same _activeTargets field.

    Covers: @dispatch-remote-branch-sync ac-active-target-includes-base,
    ac-active-target-rebuilt-on-start, ac-active-target-removed-on-cleanup.

# ─── Phase 6: Implementation — Push Path ───

- title: Update dispatch push path for workspace-scoped integration targets
  slug: task-impl-push-path
  priority: 1
  tags: [dispatch, sync, implementation]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-impl-active-target-set"
    - "@task-sync-push-ac-updates"
  description: |
    Modify the dispatch engine's integration target push path to push
    the workspace's specific target after reviewer completion, and to
    iterate all active targets during periodic push.

    Why: After a reviewer merges a task branch into the integration
    target, the engine calls _pushIntegrationTargetAsync("post-merge")
    at dispatch.ts line 2878. This method resolves the branch via
    _resolveBaseBranch() (line 1415 → line 1446), which returns the
    global this.integrationTargetBranch — now replaced by the active
    target set. The post-merge push must use the workspace's specific
    integration target (available in workspace.metadata.integrationTargetBranch
    at line 2878's closure scope), not the global default. The periodic
    push at reconciliation time must iterate all active targets.

    What:
    - Change _pushIntegrationTargetAsync signature from (trigger: string)
      to (targetBranch: string, trigger: string). The caller passes the
      specific branch to push.
    - At the post-merge call site (dispatch.ts line 2878), pass
      workspace.metadata.integrationTargetBranch as the targetBranch
      parameter. The workspace variable is already in scope from the
      closure at line 2842.
    - Replace the single this.targetPushInProgress boolean (line 864)
      with this._targetPushesInProgress: Set<string>. Before pushing,
      check if the target branch is already in the set. After push
      completes (or fails), remove it. This allows concurrent pushes
      to different branches while serializing pushes to the same branch.
    - For periodic push (triggered from _reconcile at line 1355), iterate
      this._activeTargets and call _pushIntegrationTargetAsync for each
      target that has unpushed commits. The existing
      isLocalBranchAheadOfUpstream check in pushIntegrationTarget()
      (workspace.ts line 2751) already handles the "has unpushed commits"
      check per-branch, so no change needed there.
    - Remove the _resolveBaseBranch() method (line 1445) since callers
      now pass the branch explicitly.

    How: The pushIntegrationTarget function in workspace.ts (line 2739)
    already accepts (projectDir, integrationBranch, remote) — it does
    not hardcode a global branch. The fix is entirely in dispatch.ts:
    thread the branch through _pushIntegrationTargetAsync and update
    the serialization gate. The mutation scope check
    (resolveDispatchIntegrationMutationScope at line 1420) also takes
    the branch as a parameter — verify it receives the per-workspace
    branch, not a global value.

    Testing: Test that after reviewer completion on a plan-scoped
    workspace, the plan branch (not the base branch) is pushed. Test
    that the per-branch serialization set allows concurrent pushes to
    different branches. Test that periodic push iterates all active
    targets. Test backward compatibility: single-target case (no plan
    branches) behaves identically to before.

    Covers: @dispatch-remote-branch-sync ac-push-target-after-merge,
    ac-push-target-periodic, ac-push-target-periodic-retry,
    ac-target-push-serialization,
    ac-target-push-cross-branch-concurrency,
    ac-concurrent-merge-same-target, ac-concurrent-merge-fix-cycle.

# ─── Phase 7: Implementation — Pull/Sync Path ───

- title: Update dispatch pull/sync path for workspace-scoped integration targets
  slug: task-impl-pull-path
  priority: 1
  tags: [dispatch, sync, implementation]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-impl-active-target-set"
    - "@task-sync-pull-ac-updates"
  description: |
    Modify the dispatch engine's integration target sync (pull) path to
    operate on all active targets with per-target staleness tracking and
    partial failure handling.

    Why: _syncTargetBranch() (dispatch.ts line 3080) currently syncs a
    single branch stored in this._syncBaseBranch. It uses a single
    _lastTargetSyncTimestamp (line 3304) for staleness, meaning syncing
    the base branch makes a plan branch appear fresh. The pre-provision
    sync at line 2338 checks this single timestamp, so a plan-scoped
    workspace could be provisioned against a stale plan branch that was
    never pulled. The sync cycle must iterate all active targets, track
    staleness independently, and continue past failures.

    What:
    - Replace this._lastTargetSyncTimestamp (single number) with
      this._targetSyncTimestamps: Map<string, number> keyed by branch.
    - Update _isTargetSyncStale() (line 3304) to accept a branch
      parameter and check that specific branch's timestamp. The method
      is called from the pre-provision check at line 2338 — the caller
      must pass the workspace's resolved integration target.
    - Rename _syncTargetBranch() to _syncTarget(branch: string) — sync
      a single specified branch. Keep the existing fetch + ff-merge
      logic, transient failure handling, and divergence detection. Pass
      the branch to _classifyDivergence() (line 3190) which currently
      reads this._syncBaseBranch — change it to accept a branch parameter.
    - Add _syncAllActiveTargets(): iterates this._activeTargets, calls
      _syncTarget for each. On failure for one target, log/degrade for
      that target and continue to the next. Replace the direct
      _syncTargetBranch call in periodic reconciliation (line 1325) and
      engine start (line 3065) with _syncAllActiveTargets.
    - In _syncAllActiveTargets, implement per-target reviewer deferral:
      before syncing each target, check whether a reviewer invocation is
      currently active on that target (by checking in-flight workspace
      metadata). If a reviewer is active on that specific target, skip
      it and defer to the next interval. Other targets in the same cycle
      that have no active reviewer are synced normally. This replaces the
      current global deferral where any active reviewer blocks the entire
      sync cycle.
    - For pre-provision sync (line 2338): resolve the task's integration
      target first (via plan_ref → plan.branch or default), then sync
      just that specific target if stale. The existing
      resolveDispatchWorkspaceConfig already resolves the target — the
      pre-provision sync should use that resolved value.
    - Update the _targetSyncRunning guard (line 3087) to be per-branch
      (Set<string>) to allow concurrent syncs of different targets while
      preventing re-entrant sync of the same branch.
    - Update the consecutive failure counter (this._consecutiveSyncFailures
      at line 3115) to be per-target: Map<string, number>. Escalation
      warnings are per-target.

    How: The _syncTarget method is a refactor of _syncTargetBranch with
    the branch parameter threaded through. The iteration in
    _syncAllActiveTargets is a simple for-of loop over the Set with
    try/catch per iteration. The pre-provision path already resolves the
    workspace config before syncing — the resolved baseBranch is available
    and should be passed to _isTargetSyncStale and _syncTarget.

    Testing: Test per-target staleness (syncing branch A does not refresh
    branch B's timestamp). Test partial failure (branch A fails, branch B
    still syncs). Test pre-provision syncs the specific target. Test
    on-start syncs all active targets. Test per-target reviewer deferral
    (reviewer active on branch A defers A but not B). Test backward
    compatibility: single-target case.

    Covers: @dispatch-remote-branch-sync ac-pull-target-on-start,
    ac-pull-target-on-start-before-bootstrap,
    ac-pull-target-periodic, ac-pull-target-periodic-deferred,
    ac-pull-target-before-provision, ac-pull-ff-only,
    ac-pull-no-merge-commits,
    ac-per-target-staleness, ac-per-target-staleness-isolation,
    ac-partial-sync-continues, ac-partial-sync-scoped-degradation.

# ─── Phase 8: Implementation — Degraded State ───

- title: Implement per-target degraded state in dispatch engine
  slug: task-impl-degraded-state
  priority: 1
  tags: [dispatch, sync, implementation]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-impl-pull-path"
    - "@task-sync-degraded-ac-updates"
  description: |
    Replace the dispatch engine's global degraded state with per-target
    degraded state, and update the drain loop to check degraded state
    per-task after resolving integration targets.

    Why: The global _degraded boolean (dispatch.ts line 896) blocks ALL
    provisioning when set. With per-target degraded state, a diverged
    plan branch should only block tasks targeting that plan branch. The
    drain loop currently checks degraded state as an early return (line
    2147: if (this._degraded) return) before resolving any task's
    integration target. This ordering must be inverted: resolve the
    task's target first, then check if that specific target is degraded.

    What:
    - Replace these fields on the dispatch engine:
      this._degraded: boolean (line 896) → removed
      this._degradedReason: string (line 898) → removed
      this._degradedEnteredAt: number (line 900) → removed
      Add: this._degradedTargets: Map<string, { reason: string,
      enteredAt: number }> keyed by branch name.
    - Update _enterDegradedState(reason: string) (line 3247) to accept
      a branch parameter: _enterDegradedState(branch: string,
      reason: string). Add the branch to the map. Only add if not already
      degraded for that branch (preserve existing "no re-entry" check at
      line 3248, but scoped per-branch).
    - Update _exitDegradedState() (line 3272) to accept a branch
      parameter: _exitDegradedState(branch: string). Remove from map.
      Log recovery with branch name and duration.
    - Update the drain loop. Remove the global degraded early-return at
      line 2147. Instead, in the per-task evaluation within the drain
      loop, resolve the task's integration target (using the same
      plan_ref → plan.branch → fallback chain as workspace provisioning).
      If the resolved target is in _degradedTargets, skip that task (log
      it as deferred due to degraded target) and continue to the next
      task. Tasks targeting healthy branches are provisioned normally.
    - The target resolution in the drain loop should use a lightweight
      path — not full workspace provisioning, just plan_ref lookup and
      branch resolution. If the plan_ref is invalid or the plan cannot
      be found, fall through to the configured base branch (same as
      workspace provisioning does).
    - Update getDegradedState() (line 3393) to return the full map
      (or an array of per-target degraded info). Callers include the
      status API endpoint.
    - Update the SyncStateEvent (line 3257, 3263) to include the
      target branch name in the broadcast. The WebSocket event payload
      should identify which branch entered/exited degraded state.
    - Update the divergence log guidance in _enterDegradedState to
      include the affected target branch name. The existing log message
      distinguishes between "local has unpushed merges" and "remote
      history was rewritten" — preserve that distinction but add the
      branch name so operators know which target diverged. The
      resolution steps should also reference the specific branch.
    - Update _syncTarget (from task-impl-pull-path) calls to
      _enterDegradedState and _exitDegradedState to pass the branch.
    - Update _drainQueues post-recovery (line 3295) — currently called
      when exiting degraded state to evaluate queued tasks. With per-
      target state, call _drainQueues when any target exits degraded
      state (some previously-deferred tasks may now be eligible).

    How: The drain loop change is the most complex part. Currently
    _drainQueues iterates eligible tasks and provisions them. The
    change adds a pre-provisioning step per task: resolve the
    integration target using resolveTaskPlanRef (workspace.ts line 815)
    and findPlanByRef to get plan.branch, then check _degradedTargets.
    This is a synchronous YAML read (plan files are local), so it adds
    minimal latency. Tasks without a plan_ref use the configured base
    branch. Cache the resolution if the same plan_ref appears on
    multiple tasks.

    Testing: Test that divergence on plan branch A degrades only A.
    Test that tasks targeting A are deferred while tasks targeting
    healthy branch B are provisioned. Test that recovery on A re-enables
    A's tasks. Test that the status API returns per-target degraded info.
    Test that the WebSocket event includes the target branch. Test
    backward compatibility: single-target degraded state blocks all
    tasks (since all target the same branch). Test drain loop with
    mixed degraded/healthy targets processes healthy tasks.

    Covers: @dispatch-remote-branch-sync ac-divergence-enters-degraded,
    ac-divergence-scoped-to-target, ac-divergence-log-target,
    ac-divergence-log-classification, ac-divergence-log-resolution,
    ac-degraded-no-provision, ac-degraded-task-queued,
    ac-degraded-healthy-unblocked, ac-degraded-inflight-continues,
    ac-degraded-auto-recover, ac-degraded-recovery-requeues,
    ac-degraded-status-api, ac-degraded-status-api-reason,
    ac-degraded-status-api-timestamp, ac-degraded-status-broadcast,
    ac-degraded-status-broadcast-target, ac-degraded-recovery-logged,
    ac-degraded-recovery-logged-duration.

# ─── Phase 9: Testing ───

- title: Integration tests for workspace-scoped sync
  slug: task-impl-sync-integration-tests
  priority: 2
  tags: [dispatch, sync, test]
  spec_ref: "@dispatch-remote-branch-sync"
  depends_on:
    - "@task-impl-push-path"
    - "@task-impl-pull-path"
    - "@task-impl-degraded-state"
  description: |
    End-to-end integration tests verifying the complete workspace-scoped
    sync lifecycle: provisioning with plan branches, reviewer merge,
    push to remote, periodic sync, per-target degraded state, and
    recovery.

    Why: The individual implementation tasks include unit tests for their
    specific components, but the interactions between push, pull, and
    degraded state across multiple targets need integration coverage.
    The most dangerous failure modes are cross-component: a plan branch
    merge triggers a push to the wrong branch, or degraded state on one
    target leaks into another target's evaluation. These require tests
    with a real workspace registry, multiple workspaces, and a git remote.

    What:
    - Multi-target push test: provision two workspaces — one targeting the
      base branch, one targeting a plan branch. Complete reviewer
      invocations on both. Verify each workspace's integration target is
      pushed to remote (not the global base branch for both). Verify the
      remote has both branches with the expected merge commits.
    - Multi-target periodic sync test: set up a remote with commits on
      both the base branch and a plan branch. Start the engine. Verify
      both branches are synced on start. Advance the remote on only the
      plan branch. Verify periodic sync pulls only the plan branch (base
      branch unchanged).
    - Per-target staleness test: sync both targets. Advance only the plan
      branch remote. Verify pre-provision sync for a plan-scoped task
      pulls the plan branch, not the base branch. Verify the base branch
      staleness timestamp is unaffected.
    - Per-target degraded test: force divergence on the plan branch
      remote. Verify only the plan branch enters degraded state. Provision
      a task targeting the base branch — should succeed. Provision a task
      targeting the plan branch — should be deferred. Resolve the
      divergence. Verify auto-recovery and the deferred task becomes
      eligible.
    - Concurrent merge test: provision two tasks targeting the same plan
      branch. Simulate concurrent reviewer completions. Verify one merge
      succeeds and the other fails, and the failing task enters fix cycle.
    - Single-target regression test: run the full lifecycle with no plan
      branches. Verify behavior is identical to the pre-change baseline
      (no regressions from the multi-target machinery).

    How: Use the existing dispatch test infrastructure with temp
    directories, bare git remotes (git init --bare), and the workspace
    registry. The dispatch engine can be instantiated directly with a
    mock config. Plan branches are created by writing plan records with
    branch fields to the shadow branch fixture. Remote manipulation uses
    direct git commands against the bare remote.

    Testing: This task IS the test task. Run npm test to verify.

    Covers: @dispatch-remote-branch-sync ac-push-target-after-merge,
    ac-push-target-periodic, ac-push-target-periodic-retry,
    ac-target-push-serialization,
    ac-target-push-cross-branch-concurrency,
    ac-concurrent-merge-same-target, ac-concurrent-merge-fix-cycle,
    ac-pull-target-on-start, ac-pull-target-on-start-before-bootstrap,
    ac-pull-target-periodic, ac-pull-target-periodic-deferred,
    ac-pull-target-before-provision, ac-pull-ff-only,
    ac-pull-no-merge-commits, ac-per-target-staleness,
    ac-per-target-staleness-isolation, ac-partial-sync-continues,
    ac-partial-sync-scoped-degradation,
    ac-divergence-enters-degraded, ac-divergence-scoped-to-target,
    ac-divergence-log-target, ac-divergence-log-classification,
    ac-divergence-log-resolution, ac-degraded-no-provision,
    ac-degraded-task-queued, ac-degraded-healthy-unblocked,
    ac-degraded-inflight-continues, ac-degraded-auto-recover,
    ac-degraded-recovery-requeues, ac-degraded-status-api,
    ac-degraded-status-api-reason, ac-degraded-status-api-timestamp,
    ac-degraded-status-broadcast, ac-degraded-status-broadcast-target,
    ac-degraded-recovery-logged, ac-degraded-recovery-logged-duration,
    ac-active-target-includes-base, ac-active-target-rebuilt-on-start,
    ac-active-target-removed-on-cleanup.
```

## Implementation Notes

This plan updates @dispatch-remote-branch-sync to support
workspace-scoped integration targets and implements the changes.
No new specs are created — the existing spec's description and ACs
are rewritten to replace the single-global-target assumption with
per-workspace-target semantics, then code is updated to match.

Background: @plan-branch-dispatch-target (implemented in
@plan-plan-scoped-branch-targeting) correctly resolves plan branches
as per-workspace integration targets during provisioning. The
reviewer agent correctly merges into the workspace's integration
target via KSPEC_DISPATCH_INTEGRATION_TARGET. However, the dispatch
engine's remote sync system was never updated to handle multiple
distinct integration targets. It pushes, pulls, and tracks degraded
state for a single global branch (dispatch.base_branch), ignoring
the per-workspace target stored in workspace metadata. This means
plan branches that receive merged work are never pushed to remote,
never pulled before provisioning, and never checked for divergence.

The core terminology shift is from "the integration target branch"
(singular, global) to "the workspace's integration target branch"
(per-workspace, resolved from plan branch or config). The "active
integration target set" is the union of distinct targets across
non-closed workspaces plus the configured base branch.

Key design decisions:
1. The active target set is rebuilt from the workspace registry on
   engine start, not maintained incrementally. Incremental maintenance
   has TOCTOU races between workspace cleanup and new task queueing.
2. Degraded state is per-target-branch. A diverged plan branch blocks
   only tasks targeting that branch, not all dispatch work.
3. Push serialization is per-target-branch. Pushes to different
   targets may proceed concurrently; pushes to the same target are
   serialized.
4. Staleness tracking is per-target-branch. Syncing the base branch
   does not make a plan branch appear fresh.
5. Concurrent merge to the same target is handled by git ref-level
   serialization. One merge succeeds, the other fails non-ff. The
   failing task follows the normal fix cycle. This is documented as
   expected behavior, not built as new serialization logic.
6. The configured base branch is always in the active set, even when
   no workspace currently targets it. This preserves the existing
   behavior where the base branch is kept in sync for future use.
7. The push and pull paths must share a single source of truth for
   active targets. The current codebase has two parallel state groups
   (this.integrationTargetBranch for push, this._syncBaseBranch for
   pull) initialized independently from the same config. Unifying
   them into one active target set eliminates a divergence hazard.

Scope explicitly excluded from this plan:
- Plan branch push on creation — existing design decision says empty
  branches are noise; push happens after first invocation completion
- Plan branch deletion/cleanup on remote — plan lifecycle is separate
  from workspace lifecycle
- Changes to @plan-branch-dispatch-target — that spec covers
  provisioning, which is already correct
- Changes to @dispatch-sync-configuration — the config surface does
  not change; sync_interval and remote_sync apply to all targets
