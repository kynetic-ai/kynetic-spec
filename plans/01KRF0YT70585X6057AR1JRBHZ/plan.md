# Dispatch Workspace In-Flight Cleanup Protection

## Context

Dispatch workspace artifact reconciliation can currently run while a worker or reviewer task is between queue dequeue and active invocation registration. During that window the dispatch engine has already selected a task and added an in-memory `inFlightTaskKeys` entry, but `reconcileDispatchWorkspaceArtifacts()` is called with only `_activeTaskRefs()`, and `_activeTaskRefs()` currently returns only registered `activeInvocationDetails`.

That leaves a cleanup race during workspace provisioning, bootstrap, and pre-invocation validation:

- `_spawnInvocation()` adds `${agentId}:${taskRef}` to `inFlightTaskKeys` before `provisionDispatchWorkspace()`, `ensureWorkspaceBootstrap()`, `validateDispatchWorkspaceForInvocation()`, prompt creation, and adapter setup.
- `DispatchEngine.start()` and periodic `_reconcile()` call `reconcileDispatchWorkspaceArtifacts(this.projectDir, { activeTaskRefs: this._activeTaskRefs() })`.
- `reconcileDispatchWorkspaceArtifacts()` can remove metadata-less dispatch worktrees, reviewer snapshots, root directories without `.git`, cleanup-eligible workspaces through `reapDispatchWorkspace()`, and untracked dispatch branches.
- Bootstrap tools such as `npm install` mutate many nested files while the task is still in-flight; deleting the workspace parent during that window can surface as transient-looking `ENOENT`, `TAR_ENTRY_ERROR`, or `spawn sh ENOENT` failures.

A previous draft, `@plan-dispatch-workspace-provisioning-lease-protection`, explored full durable provisioning leases. Focused challenge reviews found useful future constraints but also concluded that durable owner/TTL leases are likely over-scoped for the current product shape: a project normally has one daemon process and one dispatch engine. This plan supersedes that durable lease plan for the immediate fix. It keeps the invariant smaller: cleanup must treat active, in-flight, and provisioning work as protected, must use one shared protection decision across destructive paths, and must block blind destructive cleanup when protection state is unavailable or unclassified.

Daemon restart recovery does not require full durable ownership. On restart there is no live in-memory spawn to preserve, but registry-backed provisioning or unclassified records and metadata-backed partial workspaces must be reconciled and classified before destructive cleanup treats them as ordinary garbage.

## Existing Spec Updates

This plan updates existing kspec items; it intentionally has no structured `## Specs` YAML block. The exact acceptance criteria to add are embedded in Phase 1 spec-update tasks so derivation cannot create duplicate sibling specs.

Existing specs updated by this plan:

- `@agent-dispatch-engine` receives an AC requiring in-flight spawn refs to be included in cleanup protection inputs.
- `@dispatch-workspace-cleanup-policy` receives ACs requiring active/in-flight/provisioning artifacts to be preserved, the same protection outcome to apply across destructive cleanup surfaces, and cleanup to block blind destructive deletion until ambiguous protection state is classified.
- `@dispatch-workspace-registry` receives an AC requiring startup/periodic reconciliation to classify provisioning, unclassified, or metadata-backed partial workspaces before destructive cleanup, while still allowing classified `closing` workspaces to complete cleanup.

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Spec Alignment ───

- title: Add in-flight cleanup protection AC to dispatch engine
  slug: task-add-inflight-cleanup-protection-engine-ac
  priority: 1
  tags: [spec-update, dispatch, scheduler, cleanup]
  spec_ref: "@agent-dispatch-engine"
  description: |
    Add an engine-level acceptance criterion requiring queued-to-spawn work to
    count as protected cleanup ownership until the spawn attempt reaches a
    registered active invocation or terminal preparation outcome.

    Why: @agent-dispatch-engine already has ac-26 requiring at most one active
    invocation per task, and the implementation uses inFlightTaskKeys to enforce
    that during the pre-active window. Cleanup does not currently receive that
    in-flight set, so the same work can be protected from duplicate dispatch but
    unprotected from artifact deletion.

    What: Add this exact AC to @agent-dispatch-engine.

    AC id: ac-inflight-spawn-refs-protect-cleanup
    Given: A dispatch entry has been dequeued for spawn and the dispatch engine
      has marked the task in-flight, but no active invocation has been
      registered for that task yet.
    When: Startup, periodic, or post-event reconciliation invokes workspace
      artifact cleanup.
    Then: The task reference is included in the cleanup protection input so the
      pre-active spawn window receives the same artifact protection as a
      registered active invocation.

    How: Use `kspec item ac add @agent-dispatch-engine ...` with
    the exact AC text above, then set @agent-dispatch-engine implementation
    status to in_progress with `--no-cascade` unless current evidence proves the
    new AC is already implemented. Verify with `kspec item get
    @agent-dispatch-engine`.

    Covers: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup.

- title: Add cleanup preservation and no-blind-deletion ACs
  slug: task-add-cleanup-preservation-no-blind-deletion-acs
  priority: 1
  tags: [spec-update, dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  description: |
    Add cleanup-policy acceptance criteria for active, in-flight, and
    provisioning artifact preservation, consistent protection across destructive
    cleanup surfaces, and no-blind-deletion behavior when protection state cannot be
    trusted.

    Why: @dispatch-workspace-cleanup-policy ac-4 protects active invocation
    ownership for branch deletion, but the incident involves multiple artifact
    surfaces and the in-flight/provisioning window before active registration.
    The cleanup contract must make preservation path-independent and conservative
    when ownership/protection state is unavailable, while remaining compatible with existing policy that may deterministically block or clean untrusted metadata after classification.

    What: Add these exact ACs to @dispatch-workspace-cleanup-policy.

    AC id: ac-active-inflight-provisioning-artifact-preserved
    Given: Artifact cleanup evaluates a dispatcher-managed worktree, reviewer
      snapshot, root directory, or dispatch branch for work that is active,
      in-flight, or in provisioning.
    When: Cleanup determines whether that artifact is eligible for destructive
      removal.
    Then: Cleanup preserves the artifact instead of removing, pruning, or
      deleting it.

    AC id: ac-protection-applies-to-every-destructive-surface
    Given: Artifact cleanup discovers the same protected task or workspace
      through any destructive cleanup surface.
    When: Cleanup evaluates worker worktrees, reviewer snapshots, root
      directories, workspace records, or dispatch branches.
    Then: The protected artifact receives the same preserve outcome regardless
      of which cleanup surface discovered it.

    AC id: ac-ambiguous-protection-blocks-blind-deletion
    Given: Artifact cleanup cannot load or trust the registry, metadata, or
      protection state needed to classify whether a dispatcher-managed artifact
      is protected or safely cleanup-eligible.
    When: The artifact would otherwise be considered eligible for destructive
      cleanup.
    Then: Cleanup does not blindly delete the artifact; it reconstructs or
      reattaches trusted state, blocks cleanup with actionable guidance, or
      proceeds only after existing cleanup policy classification determines the
      metadata is untrusted and cleanup is safe.

    How: Use `kspec item ac add @dispatch-workspace-cleanup-policy
    ...` for each AC. Set @dispatch-workspace-cleanup-policy implementation
    status to in_progress with `--no-cascade` unless current evidence proves all
    new ACs are already implemented. Verify with `kspec item get
    @dispatch-workspace-cleanup-policy`.

    Covers: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved,
    ac-protection-applies-to-every-destructive-surface,
    ac-ambiguous-protection-blocks-blind-deletion.

- title: Add startup classification AC for partial provisioning artifacts
  slug: task-add-startup-provisioning-classification-ac
  priority: 1
  tags: [spec-update, dispatch, workspace, recovery]
  spec_ref: "@dispatch-workspace-registry"
  description: |
    Add a registry/recovery acceptance criterion requiring restart and periodic
    reconciliation to classify provisioning, unclassified, or metadata-backed
    partial workspaces before destructive cleanup treats them as orphaned
    artifacts, while preserving the existing ability for classified `closing`
    workspaces to complete scheduled cleanup.

    Why: This plan intentionally avoids full durable owner/TTL leases. Restart
    recovery still needs a conservative contract: ambiguous partial provisioning
    artifacts must be reattached, retried, marked stale/unhealthy, or otherwise
    classified before cleanup deletes them.

    What: Add this exact AC to @dispatch-workspace-registry.

    AC id: ac-partial-provisioning-classified-before-cleanup
    Given: Daemon startup or periodic reconciliation finds a provisioning
      lifecycle state, unclassified non-closed workspace record, or
      metadata-backed dispatch artifact that may belong to a task whose
      invocation is not currently active.
    When: Artifact cleanup is about to evaluate that workspace's worktrees,
      reviewer snapshot, root directory, or dispatch branch for destructive
      cleanup.
    Then: Reconciliation first classifies the workspace as preserved for retry,
      active/in-flight, stale/unhealthy with actionable recovery detail, or
      cleanup-eligible state. A `closing` workspace with satisfied cleanup
      prerequisites and no active/in-flight/provisioning ownership may be
      classified cleanup-eligible so scheduled cleanup can reach `closed`.

    How: Use `kspec item ac add @dispatch-workspace-registry ...`
    with the exact AC text above. Set @dispatch-workspace-registry implementation
    status to in_progress with `--no-cascade` unless current evidence proves the
    new AC is already implemented. Verify with `kspec item get
    @dispatch-workspace-registry`.

    Covers: @dispatch-workspace-registry ac-partial-provisioning-classified-before-cleanup.

# ─── Phase 2: Runtime Cleanup Protection ───

- title: Centralize dispatch artifact protection decisions
  slug: task-centralize-dispatch-artifact-protection-decisions
  priority: 1
  tags: [dispatch, workspace, cleanup, maintainability]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on:
    - "@task-add-cleanup-preservation-no-blind-deletion-acs"
    - "@task-add-startup-provisioning-classification-ac"
  description: |
    Introduce a single protection-policy helper for dispatch artifact cleanup and
    route destructive cleanup decisions through that helper.

    Why: The race can reappear if branch cleanup, root-directory pruning,
    reviewer snapshot cleanup, and workspace-record reaping each use separate
    protection logic. A shared policy is the long-term maintenance guardrail: new
    cleanup surfaces must consume the same active/in-flight/provisioning decision
    instead of inventing their own eligibility checks.

    What:
    1. In `src/agent-runtime/workspace.ts`, add an internal helper such as
       `buildDispatchArtifactProtectionState(...)` or
       `shouldPreserveDispatchArtifact(...)` that accepts resolved dispatch
       config, registry records/metadata, and active/in-flight task refs.
    2. The helper must treat these as protection sources:
       - task refs supplied by cleanup callers as active/in-flight protection;
       - non-closed registry records while they still represent protected or
         unclassified work, including lifecycle_state `provisioning`, `ready`,
         `active`, `stale`, `integrating`, and `cleanup_blocked`; `closing`
         records are protected only while active/in-flight/provisioning
         ownership or unresolved integration remains, and otherwise may proceed
         through scheduled `reapDispatchWorkspace()` cleanup once classification
         says cleanup is eligible; generic orphan-branch pruning still preserves
         non-closed registry branches;
       - metadata-backed worktrees that can be recovered or classified before
         deletion.
    3. The helper must return enough information for cleanup to preserve worker
       worktrees, reviewer worktrees/snapshots, unregistered root-directory
       candidates equal to or contained by protected paths, and dispatch
       branches belonging to protected records or unclassified records that have
       not yet been determined cleanup-eligible.
    4. Registry or metadata load/parsing failure must produce a no-blind-deletion
       result for dispatcher-managed artifacts unless existing cleanup policy
       classification can determine that cleanup is safe. The result must
       include actionable diagnostic text for logs/test assertions.
    5. Replace ad hoc protection checks inside `reconcileDispatchWorkspaceArtifacts()`
       with calls to this helper or helper-derived protected sets.

    How: Keep the helper local to workspace cleanup unless other code needs it.
    Do not add durable lease schema or owner/TTL fields. Preserve existing cleanup
    behavior for records that are explicitly closed or terminal cleanup-eligible
    after classification.

    Testing: Add focused helper-level tests in `tests/dispatch-workspace-cleanup.test.ts`
    or a new `tests/dispatch-artifact-protection.test.ts` proving preserve/delete
    decisions for active, in-flight, provisioning/protected-unclassified,
    closing cleanup-eligible, closed, and registry-unavailable cases.

    Covers: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved,
    ac-protection-applies-to-every-destructive-surface,
    ac-ambiguous-protection-blocks-blind-deletion; @dispatch-workspace-registry
    ac-partial-provisioning-classified-before-cleanup.

- title: Include in-flight spawn refs in cleanup inputs
  slug: task-include-inflight-spawn-refs-in-cleanup-inputs
  priority: 1
  tags: [dispatch, scheduler, cleanup]
  spec_ref: "@agent-dispatch-engine"
  depends_on:
    - "@task-add-inflight-cleanup-protection-engine-ac"
  description: |
    Update the dispatch engine cleanup input so tasks between queue dequeue and
    active invocation registration are protected from artifact reconciliation.

    Why: `_spawnInvocation()` already records `${agentId}:${taskRef}` in
    `inFlightTaskKeys` before provisioning/bootstrap. `_hasActiveInvocationForTask()`
    already considers those keys for scheduler deduplication. `_activeTaskRefs()`
    currently ignores them, so cleanup receives a weaker view than the scheduler.

    What:
    1. In `src/agent-runtime/dispatch.ts`, replace `_activeTaskRefs()` with a
       cleanup-specific helper or update it so the set includes task refs parsed
       from `this.inFlightTaskKeys` as well as `activeInvocationDetails`.
    2. Parse in-flight keys safely by splitting only on the first `:` so task
       refs remain intact.
    3. Keep `_hasActiveInvocationForTask()` semantics unchanged, but reuse the
       same parsing helper if practical.
    4. Verify both `reconcileDispatchWorkspaceArtifacts()` call sites in
       `start()` and `_reconcile()` receive the expanded protection set.

    How: Keep this as an in-memory/current-state protection fix. Do not add
    registry-backed leases or durable owner fields.

    Testing: Add or update unit coverage in `tests/agent-dispatch-engine.test.ts`
    for cleanup input generation, including a task that is in-flight but not yet
    in `activeInvocationDetails`.

    Covers: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup.

- title: Apply protection policy across artifact reconciliation surfaces
  slug: task-apply-protection-policy-across-artifact-reconciliation
  priority: 1
  tags: [dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on:
    - "@task-centralize-dispatch-artifact-protection-decisions"
    - "@task-include-inflight-spawn-refs-in-cleanup-inputs"
  description: |
    Ensure every destructive path in `reconcileDispatchWorkspaceArtifacts()` and
    the cleanup paths it calls honors active, in-flight, and provisioning
    protection.

    Why: The original failure can reappear through any cleanup surface that
    bypasses protection: metadata-less worktree removal, reviewer snapshot
    cleanup, root-directory pruning, cleanup-eligible record reaping, or orphan
    dispatch branch deletion.

    What:
    1. In `src/agent-runtime/workspace.ts`, before removing metadata-less
       dispatch worktrees, consult the shared protection decision and preserve
       artifacts that can be associated with active/in-flight/provisioning work
       or that cannot be classified safely.
    2. Before calling `reapDispatchWorkspace()`, skip or block records whose task
       ref is active/in-flight or whose registry state is provisioning, protected, or unclassified
       until classification says the record is cleanup-eligible. Do not treat
       `closing` alone as protected when existing cleanup prerequisites are met
       and no active/in-flight/provisioning ownership remains.
    3. Before deleting reviewer snapshot worktrees, preserve paths associated
       with protected records or active/in-flight task refs.
    4. Before deleting unregistered root directories without `.git`, preserve
       candidates equal to or contained by protected worker/reviewer paths, and
       avoid blind deletion for ambiguous dispatcher-managed candidates when
       protection state is unavailable unless classification determines cleanup
       is safe.
    5. Before deleting dispatch branches, preserve branches tracked by protected
       or unclassified records and avoid blind deletion when the registry cannot
       be loaded or trusted unless existing cleanup classification has
       determined the branch is safely cleanup-eligible.
    6. Ensure diagnostics identify the cleanup surface and protection source when
       an artifact is preserved or blocked.

    How: Preserve existing behavior for truly orphaned artifacts, for scheduled
    `reapDispatchWorkspace()` cleanup of `closing` records after classification,
    and for closed records that are cleanup-eligible under existing retention
    rules. Orphan dispatch-branch pruning must still honor the existing
    registry contract that preserves branches for non-closed records; branch
    deletion for a closing workspace belongs to scheduled/bounded reaping, not to
    the generic orphan-branch sweep. Avoid a broad grace-period heuristic as the
    primary fix; use explicit protection state instead.

    Testing: Update `tests/dispatch-workspace-cleanup.test.ts` and/or
    `tests/dispatch-workspace-registry.test.ts` to cover each destructive surface
    with both protected and cleanup-eligible negative-control cases.

    Covers: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved,
    ac-protection-applies-to-every-destructive-surface,
    ac-ambiguous-protection-blocks-blind-deletion; @dispatch-workspace-registry
    ac-partial-provisioning-classified-before-cleanup.

# ─── Phase 3: Regression Coverage and Maintenance Guardrails ───

- title: Add positive and regression coverage for cleanup protection
  slug: task-test-cleanup-protection-positive-and-regression-cases
  priority: 1
  tags: [tests, dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on:
    - "@task-apply-protection-policy-across-artifact-reconciliation"
  description: |
    Add tests proving cleanup preserves active/in-flight/provisioning artifacts,
    still removes truly stale terminal artifacts, and blocks blind deletion when
    registry or protection state is unavailable.

    Why: The fix must be provable in both directions. Positive cases prove the
    intended cleanup behavior still works; regression cases prove the bootstrap
    race cannot delete active preparation artifacts; negative controls prove the
    conservative policy does not permanently disable cleanup.

    What:
    1. Add protected-case tests for:
       - active task refs passed through cleanup options;
       - in-flight task refs passed through cleanup options before active
         invocation registration;
       - registry records with lifecycle_state `provisioning` or another
         protected/unclassified state;
       - `closing` records that are cleanup-eligible through scheduled reaping
         while non-closed orphan-branch pruning still preserves their branches;
       - reviewer snapshot paths associated with protected records;
       - dispatch branches associated with protected or unclassified records;
       - root-directory candidates contained by protected worker/reviewer paths.
    2. Add cleanup-positive tests showing closed or truly orphaned worktrees,
       root directories, reviewer snapshots, and dispatch branches are still
       removed when no protection source applies.
    3. Add ambiguous-state tests where registry/protection state cannot be loaded or
       trusted, asserting cleanup does not blindly delete dispatcher-managed
       artifacts before reconstructing, blocking with actionable diagnostics,
       or classifying them as safely cleanup-eligible.
    4. Add behavioral guardrail coverage for each destructive surface through
       the public reconciliation path or focused helper API, asserting both
       protected and cleanup-eligible outcomes for metadata-less worktree
       removal, cleanup-eligible record reaping, reviewer snapshot removal,
       unregistered root-directory pruning, and dispatch branch pruning.
    5. Add a direct regression test that creates bootstrap-like nested files under
       a worker workspace, runs `reconcileDispatchWorkspaceArtifacts()` with the
       task protected as in-flight, and asserts the nested files and parent
       workspace survive.

    How: Prefer deterministic fixtures over sleeps. Use existing temp project,
    git worktree, and registry helpers in the dispatch workspace tests. The
    regression does not need to run real `npm`; it only needs to prove cleanup
    cannot remove the parent tree during the in-flight bootstrap window.

    Testing: Run
    `npm test -- --run tests/dispatch-workspace-cleanup.test.ts tests/dispatch-workspace-registry.test.ts`.

    Covers: @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved,
    ac-protection-applies-to-every-destructive-surface,
    ac-ambiguous-protection-blocks-blind-deletion; @dispatch-workspace-registry
    ac-partial-provisioning-classified-before-cleanup.

- title: Add dispatch-level in-flight bootstrap race regression
  slug: task-test-dispatch-inflight-bootstrap-race-regression
  priority: 1
  tags: [tests, dispatch, scheduler, bootstrap]
  spec_ref: "@agent-dispatch-engine"
  depends_on:
    - "@task-apply-protection-policy-across-artifact-reconciliation"
  description: |
    Add a higher-level dispatch engine regression test proving reconciliation
    cannot delete a workspace while a spawn attempt is in-flight and blocked in
    bootstrap or pre-invocation preparation.

    Why: Cleanup unit tests prove the policy, but the incident came from
    composition across `_spawnInvocation()`, inFlightTaskKeys, bootstrap, and
    artifact reconciliation. A dispatch-level regression protects that boundary.

    What:
    1. Add a test in `tests/agent-dispatch-engine.test.ts` or a focused dispatch
       integration test that starts a spawn attempt for a task and blocks it at a
       deterministic bootstrap/preparation barrier after `inFlightTaskKeys` is
       set but before active invocation registration.
    2. Create a sentinel file under the worker workspace representing
       bootstrap-created files.
    3. Trigger workspace artifact reconciliation while the spawn remains
       in-flight.
    4. Assert the workspace directory and sentinel survive.
    5. Release the barrier and assert the spawn reaches the expected controlled
       success or failure path without cleanup-induced ENOENT/TAR/spawn errors.

    How: Use a probarrier, fixture script, or file sentinel instead of
    timing sleeps. Keep the test focused on cleanup/provisioning interaction;
    do not require real package-manager network work.

    Testing: Run
    `npm test -- --run tests/agent-dispatch-engine.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts`.

    Covers: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup;
    @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved.

# ─── Phase 4: Validation ───

- title: Validate in-flight cleanup protection implementation
  slug: task-validate-inflight-cleanup-protection
  priority: 2
  tags: [validation, dispatch, cleanup]
  spec_ref: "@dispatch-workspace-cleanup-policy"
  depends_on:
    - "@task-test-cleanup-protection-positive-and-regression-cases"
    - "@task-test-dispatch-inflight-bootstrap-race-regression"
  description: |
    Run targeted and broad validation for the simplified in-flight cleanup
    protection work and record the evidence on this validation task.

    Why: The simplified plan is only acceptable if it is testable in both
    directions and maintainable long-term. Validation must prove positive cleanup
    behavior, regression protection for the bootstrap race, and guardrails for
    future destructive cleanup paths.

    What:
    1. Run targeted tests:
       - `npm test -- --run tests/dispatch-workspace-cleanup.test.ts tests/dispatch-workspace-registry.test.ts`
       - `npm test -- --run tests/agent-dispatch-engine.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts`
    2. Run project quality gates:
       - `npm run typecheck`
       - `npm test -- --fresh`
       - `kspec validate --warnings-ok`
    3. If the full suite fails for known unrelated baseline instability, record
       the exact command, exit code, failing test names, and focused passing
       evidence rather than hiding the failure.
    4. Verify `git status --short` and `.kspec` shadow status are clean or contain
       only intended changes.

    How: Capture exact command outputs and exit codes in task notes. Do not mark
    unrelated durable-lease tasks complete; this plan supersedes that approach
    but does not implement the deferred lease design.

    Covers: @agent-dispatch-engine ac-inflight-spawn-refs-protect-cleanup;
    @dispatch-workspace-cleanup-policy ac-active-inflight-provisioning-artifact-preserved,
    ac-protection-applies-to-every-destructive-surface,
    ac-ambiguous-protection-blocks-blind-deletion; @dispatch-workspace-registry
    ac-partial-provisioning-classified-before-cleanup.
```

## Implementation Notes

This is an existing-spec update plan. The `## Specs` section is deliberately omitted because structured plan specs create new spec items; the intended work is to tighten existing specs with explicit spec-update tasks.

The durable-lease plan remains useful as deferred design context, but this plan intentionally does not add owner IDs, PIDs, process-start timestamps, TTLs, renewals, abandoned lease ownership, or compare-and-swap lease writes. If future requirements introduce multiple daemon owners, external cleanup processes, or restart-surviving provisioning ownership, revive and harden the durable lease design using review feedback recorded on `@01KRETXETZV92HX06C0F0R46QC` and `@01KREVDS9XYG0933RSJPPD5WEC`.

The central invariant for this plan is: dispatcher cleanup must not destructively remove artifacts for work that is active, in-flight, provisioning, pending classification, or unclassifiable because protection state is unavailable unless existing cleanup policy has classified the artifact as safe to clean. Cleanup may still remove closing, closed, terminal, or truly orphaned artifacts after the same protection policy classifies them as cleanup-eligible and unprotected.

Dependency ordering keeps spec updates first, cleanup policy centralization second, engine input wiring in parallel with policy work, destructive-surface application after both are available, tests/guardrails after behavior lands, and validation last.
