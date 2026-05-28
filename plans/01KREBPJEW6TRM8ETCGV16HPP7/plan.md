# Dispatch Workspace Provisioning Lease Protection

## Context

Dispatch workspace artifact reconciliation can currently run while a worker or reviewer workspace is between queue dequeue and active invocation registration. During that window the dispatcher may be creating or repairing a worktree, running bootstrap commands such as `npm install`, or re-validating the workspace after recovery. The runtime has an in-memory `inFlightTaskKeys` marker for scheduler deduplication, but artifact cleanup only receives `activeInvocationDetails` via `_activeTaskRefs()`, and the registry does not durably expose a provisioning/bootstrap lease that cleanup can honor after restart.

The observed failure mode is a compound race:

- `DispatchEngine._spawnInvocation()` adds an in-flight key before provisioning, but it does not register an active invocation until after provisioning, bootstrap, validation, prompt creation, and adapter setup.
- `reconcileDispatchWorkspaceArtifacts()` is called from startup and periodic reconciliation with only active invocation refs, so it can treat a task in the provisioning/bootstrap window as idle.
- `reconcileDispatchWorkspaceArtifacts()` may remove unregistered directories under the dispatch worktree root, cleanup-eligible workspace trees, reviewer snapshot trees, or orphan-looking dispatch branches without knowing that bootstrap is still mutating them.
- Bootstrap steps such as `npm install` create and rename many nested filesystem entries; removing or pruning their parent workspace mid-step yields transient-looking `ENOENT`, `TAR_ENTRY_ERROR`, and `spawn sh ENOENT` failures.

This plan makes the protected window explicit and durable. Provisioning, bootstrap, and pre-invocation validation become leased workspace phases. Artifact cleanup must honor both live in-memory in-flight refs and registry-backed leases, and expired leases must recover safely rather than leaving artifacts forever or deleting active work.

## Deferred Supersession Note

This draft is intentionally preserved as a deferred durable-lease design, not as the current implementation path. Focused review cycles were run after the initial clean review:

- `@01KRETXETZV92HX06C0F0R46QC` reviewed long-term/backfire risks and requested changes.
- `@01KREVDS9XYG0933RSJPPD5WEC` reviewed necessity, value, and alternatives and requested changes.

The current implementation direction moved to a simpler in-memory/current-state cleanup protection plan because this project normally has one daemon and one dispatch engine per project. The immediate failure can be addressed by ensuring cleanup treats active, in-flight, and provisioning work as protected, while daemon restart recovery can conservatively classify partial artifacts before destructive cleanup without requiring full durable owner/TTL lease semantics.

If this durable lease design is revived, incorporate the review feedback before approval or derivation:

- Registry-unavailable or corrupt cleanup must fail closed rather than falling back to destructive deletion.
- Different-owner non-expired lease writes need conflict or compare-and-swap semantics; another daemon/spawn must not silently overwrite, renew, clear, or abandon a live owner’s lease.
- Abandoned lease retention, cleanup eligibility, retry/reset behavior, and operator inspection windows must be explicit.
- Observability must expose owner, phase, expiry, abandoned reason, and cleanup skip/preservation reasons.
- Task ordering must prevent producer tasks from landing before cleanup honors the protective signal.
- The plan must justify why durable restart-surviving owner state is required instead of the smaller active/in-flight/provisioning cleanup-protection fix.
- The durable schema/API surface should be deferred unless cross-process cleanup, multiple daemons, or restart-surviving provisioning ownership becomes a proven requirement.

## Existing Spec Updates

This plan updates existing kspec items; it intentionally has no structured
`## Specs` YAML block. The exact acceptance criteria to add are embedded in the
Phase 1 spec-update tasks below so derived tasks remain standalone and so plan
derivation cannot create duplicate sibling specs with collision-suffixed slugs.

Existing specs updated by this plan:

- `@dispatch-workspace-registry` receives provisioning lease, protection,
  finalization, and abandoned-lease recovery ACs.
- `@dispatch-runtime-bootstrap-contract` receives durable bootstrap
  `in_progress`, terminal-state, and cleanup interlock ACs.
- `@agent-dispatch-engine` receives an in-flight cleanup protection AC.

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Spec Updates ───

- title: Add provisioning lease ACs to dispatch workspace registry
  slug: task-add-dispatch-workspace-provisioning-lease-acs
  priority: 1
  tags: [spec-update, dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-registry"
  description: |
    Add registry-level acceptance criteria that define durable provisioning
    leases, cleanup protection, finalization, and abandoned lease recovery.

    Why: @dispatch-workspace-registry currently defines lifecycle_state
    `provisioning`, but it does not specify a durable lease/owner/expiry
    contract, does not say cleanup must treat provisioning as protected, and
    does not define how expired provisioning state recovers after restart. That
    gap allowed cleanup to classify a workspace being bootstrapped as stale or
    idle.

    What: Add these exact ACs to @dispatch-workspace-registry.

    AC id: ac-provisioning-lease-recorded-before-mutation
    Given: The dispatcher is about to create, repair, rehydrate, bootstrap, or
      validate a dispatch workspace before the related agent invocation is
      registered as active.
    When: The dispatcher will mutate workspace branches, worktree directories,
      reviewer snapshot directories, workspace metadata, or bootstrap artifacts.
    Then: The workspace registry records a durable provisioning lease for the
      containing workspace record before that mutation begins.

    AC id: ac-provisioning-lease-identifies-owner
    Given: The workspace registry records a provisioning lease for a workspace.
    When: The lease is stored or renewed.
    Then: The lease identifies the affected task ref, workspace role, phase,
      owner daemon instance id, owner process pid, owner process started_at,
      owner spawn id, started_at, updated_at, and expires_at; the containing
      workspace record supplies the workspace id.

    AC id: ac-provisioning-lease-keeps-lifecycle-open
    Given: A workspace has a non-expired provisioning lease.
    When: Registry lifecycle state is evaluated for cleanup or recovery.
    Then: The workspace lifecycle is treated as non-closed for the duration of
      the lease.

    AC id: ac-provisioning-lease-protects-worker-worktree
    Given: Workspace artifact reconciliation evaluates a worker worktree path for
      a workspace record.
    When: The registry contains a non-expired provisioning lease for that
      workspace.
    Then: Artifact reconciliation preserves the worker worktree path.

    AC id: ac-provisioning-lease-protects-reviewer-worktree
    Given: Workspace artifact reconciliation evaluates a reviewer snapshot or
      reviewer worktree path for a workspace record.
    When: The registry contains a non-expired provisioning lease for that
      workspace.
    Then: Artifact reconciliation preserves the reviewer path.

    AC id: ac-provisioning-lease-protects-root-directory
    Given: Workspace artifact reconciliation evaluates an unregistered directory
      under the dispatch worktree root.
    When: The directory is equal to or contained by a worker or reviewer path for
      a workspace with a non-expired provisioning lease.
    Then: Artifact reconciliation preserves the directory.

    AC id: ac-provisioning-lease-protects-dispatch-branch
    Given: Workspace artifact reconciliation evaluates a dispatch branch for a
      workspace record.
    When: The registry contains a non-expired provisioning lease for that
      workspace.
    Then: Artifact reconciliation preserves the dispatch branch.

    AC id: ac-provisioning-lease-success-finalized
    Given: A provisioning, bootstrap, or pre-invocation validation phase reaches
      a successful handoff point.
    When: Control leaves that phase.
    Then: The dispatcher finalizes the provisioning lease in a finally-equivalent
      path by clearing it or atomically replacing it with ready/active workspace
      state.

    AC id: ac-provisioning-lease-failure-finalized
    Given: A provisioning, bootstrap, or pre-invocation validation phase fails,
      aborts, or throws before active invocation registration.
    When: Control leaves that phase.
    Then: The dispatcher finalizes the provisioning lease in a finally-equivalent
      path by clearing or expiring it and recording actionable unhealthy/stale
      diagnostics.

    AC id: ac-expired-provisioning-lease-recovery
    Given: The daemon starts or periodic reconciliation observes a workspace
      record with an expired provisioning lease.
    When: The task is not protected by activeTaskRefs/in-flight refs and the
      current daemon has no live spawn attempt whose owner_spawn_id matches the
      lease.
    Then: Reconciliation marks the lease abandoned and records an actionable
      stale or invalid health issue before any later cleanup can delete the
      workspace artifacts.

    How: Use `kspec item ac add @dispatch-workspace-registry ...`
    for each AC. Verify with `kspec item get
    @dispatch-workspace-registry` and ensure the new AC IDs are present exactly
    once. Do not create a new spec item; these are existing-spec AC additions.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-recorded-before-mutation,
    ac-provisioning-lease-identifies-owner, ac-provisioning-lease-keeps-lifecycle-open,
    ac-provisioning-lease-protects-worker-worktree,
    ac-provisioning-lease-protects-reviewer-worktree, ac-provisioning-lease-protects-root-directory,
    ac-provisioning-lease-protects-dispatch-branch, ac-provisioning-lease-success-finalized,
    ac-provisioning-lease-failure-finalized, ac-expired-provisioning-lease-recovery.

- title: Add bootstrap in-progress interlock ACs
  slug: task-add-bootstrap-in-progress-interlock-acs
  priority: 1
  tags: [spec-update, dispatch, bootstrap, cleanup]
  spec_ref: "@dispatch-runtime-bootstrap-contract"
  depends_on:
    - "@task-add-dispatch-workspace-provisioning-lease-acs"
  description: |
    Add bootstrap-specific acceptance criteria requiring durable in-progress and
    terminal bootstrap state around subprocess execution.

    Why: @dispatch-runtime-bootstrap-contract currently distinguishes not_run,
    succeeded, and failed outcomes, but it does not require an in_progress state
    before filesystem-mutating subprocesses run. Cleanup therefore lacks a
    spec-backed signal that `npm install` or equivalent bootstrap work is active.

    What: Add these exact ACs to @dispatch-runtime-bootstrap-contract.

    AC id: ac-bootstrap-in-progress-is-durable
    Given: The dispatcher is about to run one or more configured bootstrap steps
      for a workspace role.
    When: The first bootstrap subprocess is spawned.
    Then: The workspace registry durably records that role's bootstrap state as
      in_progress, associated with the current provisioning lease and bootstrap
      config hash, before the subprocess can mutate the workspace.

    AC id: ac-bootstrap-terminal-state-after-subprocess
    Given: A bootstrap subprocess succeeds, fails, is aborted, or throws while
      the dispatcher is preparing an invocation.
    When: The subprocess handling path completes.
    Then: The role bootstrap state is durably finalized as succeeded or failed
      with step results and failure guidance, and no in_progress bootstrap state
      remains unless a fresh retry has started.

    AC id: ac-bootstrap-cleanup-interlock
    Given: Artifact cleanup runs while bootstrap is in_progress for a role.
    When: Cleanup considers any path or branch belonging to the workspace.
    Then: Cleanup treats the bootstrap in_progress state and provisioning lease
      as a hard protection signal and skips deletion or pruning for that
      workspace until bootstrap reaches a terminal state or the lease is
      recovered as abandoned.

    How: Use `kspec item ac add
    @dispatch-runtime-bootstrap-contract ...` for each AC. Verify with
    `kspec item get @dispatch-runtime-bootstrap-contract`. Do not
    create a new spec item; these are existing-spec AC additions.

    Covers: @dispatch-runtime-bootstrap-contract ac-bootstrap-in-progress-is-durable,
    ac-bootstrap-terminal-state-after-subprocess, ac-bootstrap-cleanup-interlock.

- title: Add dispatch in-flight cleanup protection AC
  slug: task-add-dispatch-inflight-cleanup-protection-ac
  priority: 1
  tags: [spec-update, dispatch, scheduler, cleanup]
  spec_ref: "@agent-dispatch-engine"
  depends_on:
    - "@task-add-dispatch-workspace-provisioning-lease-acs"
  description: |
    Add an engine-level acceptance criterion requiring in-flight queue entries to
    count as active for cleanup protection before activeInvocationDetails exists.

    Why: The dispatch engine already has `inFlightTaskKeys` for scheduler
    deduplication, but `_activeTaskRefs()` only returns active invocation
    records. Reconciliation calls `reconcileDispatchWorkspaceArtifacts()` with
    that incomplete set, leaving the provisioning/bootstrap window unprotected.

    What: Add this exact AC to @agent-dispatch-engine.

    AC id: ac-inflight-provisioning-counts-active-for-cleanup
    Given: A queue entry has been selected for spawn and the dispatch engine has
      marked the task in-flight, but no agent invocation has been registered yet.
    When: Startup, periodic, or post-event reconciliation invokes workspace
      artifact cleanup.
    Then: The dispatch engine includes the in-flight task reference in the active
      protection set passed to cleanup so provisioning, bootstrap, and validation
      cannot race with artifact deletion.

    How: Use `kspec item ac add @agent-dispatch-engine ...` and
    verify with `kspec item get @agent-dispatch-engine`. Do not
    create a new spec item; this is an existing-spec AC addition.

    Covers: @agent-dispatch-engine ac-inflight-provisioning-counts-active-for-cleanup.

# ─── Phase 2: Registry Schema and Lease Helpers ───

- title: Add provisioning lease schema to dispatch workspace records
  slug: task-add-dispatch-workspace-provisioning-lease-schema
  priority: 1
  tags: [dispatch, workspace, schema]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-add-dispatch-workspace-provisioning-lease-acs"
    - "@task-add-bootstrap-in-progress-interlock-acs"
  description: |
    Extend the dispatch workspace registry schema and TypeScript types with an
    explicit provisioning lease record.

    Why: Existing lifecycle_state values can say `provisioning`, but they do not
    encode owner, role, phase, timestamps, or expiry. Cleanup needs a durable,
    inspectable signal that survives daemon restart and can be recovered if the
    daemon dies mid-bootstrap.

    What:
    1. In `src/schema/dispatch-workspace.ts`, add
       `DispatchWorkspaceProvisioningLeaseSchema` with fields:
       - `status`: `none | in_progress | abandoned`
       - `task_ref`: string nullable/optional
       - `role`: `worker | reviewer` nullable/optional
       - `phase`: `workspace | bootstrap | validation | invocation_start` nullable/optional
       - `owner_daemon_id`: string nullable/optional
       - `owner_pid`: number nullable/optional
       - `owner_process_started_at`: DateTime nullable/optional
       - `owner_spawn_id`: string nullable/optional
       - `started_at`: DateTime nullable/optional
       - `updated_at`: DateTime nullable/optional
       - `expires_at`: DateTime nullable/optional
       - `detail`: string nullable/optional
       The containing `DispatchWorkspaceRecord` supplies the workspace id; do
       not duplicate a second workspace id inside the lease.
    2. Add `provisioning_lease` to `DispatchWorkspaceRecordSchema` with a
       backward-compatible default `{ status: "none" }`.
    3. Export the inferred lease type and update the corresponding runtime
       record/metadata conversion types in `src/agent-runtime/workspace.ts`.
    4. Extend `DispatchWorkspaceBootstrapStatusSchema` with `in_progress` and
       ensure old records without the status still default to `not_run`.

    How: Keep schema defaults backward compatible so existing
    `.kspec/project.dispatch-workspaces.yaml` files validate without migration.
    Update normalization helpers so omitted lease fields never produce validation
    errors.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-recorded-before-mutation,
    ac-provisioning-lease-identifies-owner; @dispatch-runtime-bootstrap-contract
    ac-bootstrap-in-progress-is-durable.

- title: Implement provisioning lease mutation helpers
  slug: task-implement-dispatch-workspace-provisioning-lease-helpers
  priority: 1
  tags: [dispatch, workspace, registry]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-add-dispatch-workspace-provisioning-lease-schema"
  description: |
    Add first-party helpers for starting, renewing, clearing, and abandoning
    provisioning leases through the protected shadow mutation path.

    Why: Lease updates must be durable before cleanup relies on them. Ad hoc
    record writes from dispatch.ts or bootstrap.ts would risk bypassing the
    existing shadow-branch serialization and creating another cleanup race.

    What:
    1. In `src/agent-runtime/workspace.ts`, add exported helpers similar to the
       existing mark-active/mark-idle functions:
       - `markDispatchWorkspaceProvisioning(options)`
       - `renewDispatchWorkspaceProvisioningLease(options)`
       - `clearDispatchWorkspaceProvisioningLease(options)`
       - `markDispatchWorkspaceProvisioningAbandoned(options)`
    2. Helpers must load the matching registry record, mutate only lease,
       lifecycle, health/bootstrap fields required for the transition, save via
       existing registry persistence, and commit through the protected shadow
       mutation path.
    3. `markDispatchWorkspaceProvisioning` must set lifecycle_state to
       `provisioning` unless the record is already `active`, set a finite
       `expires_at` based on a constant/default TTL, and write the owner tuple:
       daemon instance id, process pid, process started_at, and spawn id.
    4. `clearDispatchWorkspaceProvisioningLease` must clear the lease to
       `{ status: "none" }` and move lifecycle to `ready` unless invocation
       activation immediately moves it to `active`.
    5. `markDispatchWorkspaceProvisioningAbandoned` must set lease status to
       `abandoned`, record a health issue with suggested recovery, and avoid
       deleting artifacts itself.
    6. Liveness must not rely on `process.kill(pid, 0)` alone. A lease is live
       only when the task is in activeTaskRefs/in-flight refs, or when the
       current daemon instance still has an in-memory spawn attempt matching
       `owner_spawn_id`. After daemon restart, an expired old-owner lease is
       abandoned before any later cleanup deletes artifacts.

    How: Keep mutation helpers idempotent. Repeated start/renew calls for the
    same owner/phase should update timestamps but not create duplicate records.
    Repeated clear calls when no lease exists should be a no-op.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-recorded-before-mutation,
    ac-provisioning-lease-identifies-owner, ac-provisioning-lease-keeps-lifecycle-open,
    ac-provisioning-lease-success-finalized, ac-provisioning-lease-failure-finalized,
    ac-expired-provisioning-lease-recovery.

# ─── Phase 3: Protect the Provisioning/Bootstrap Window ───

- title: Mark workspace provisioning before filesystem mutation
  slug: task-mark-workspace-provisioning-before-mutation
  priority: 1
  tags: [dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-implement-dispatch-workspace-provisioning-lease-helpers"
  description: |
    Ensure workspace creation, repair, branch adoption, reviewer snapshot setup,
    and metadata recovery enter a leased provisioning phase before cleanup can
    classify their artifacts as stale.

    Why: The first vulnerable window begins before bootstrap: worktree creation
    or repair may create directories under the dispatch worktree root before
    active invocation registration. Cleanup currently removes unregistered root
    directories that lack a `.git` marker and may also reap cleanup-eligible
    workspace metadata without knowing provisioning is active.

    What:
    1. Update `provisionDispatchWorkspace()` in `src/agent-runtime/workspace.ts`
       so new and reused records are moved into provisioning with a lease before
       mutating worktrees/branches where possible.
    2. For brand-new workspaces, create or update the registry record with the
       intended worker worktree path and lifecycle_state `provisioning` before
       long-running filesystem work begins.
    3. For reviewer provisioning, set the lease phase before creating/resetting
       the detached reviewer worktree.
    4. Ensure all error paths either clear the lease with unhealthy diagnostics
       or mark it abandoned/failed with actionable guidance.

    How: Use `try/finally` or equivalent around each provisioning phase. Do not
    mark a workspace ready merely because branch/worktree creation finished if
    bootstrap still needs to run; dispatch.ts will advance the phase to
    bootstrap next.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-recorded-before-mutation,
    ac-provisioning-lease-keeps-lifecycle-open, ac-provisioning-lease-failure-finalized.

- title: Record bootstrap in-progress and terminal states
  slug: task-record-bootstrap-in-progress-terminal-states
  priority: 1
  tags: [dispatch, bootstrap, workspace]
  spec_ref: "@dispatch-runtime-bootstrap-contract"
  depends_on:
    - "@task-implement-dispatch-workspace-provisioning-lease-helpers"
  description: |
    Make `ensureWorkspaceBootstrap()` persist in_progress bootstrap state and
    provisioning lease phase before spawning bootstrap subprocesses, then always
    persist terminal state after subprocess completion.

    Why: Bootstrap is the observed failure point. `npm install` can be killed by
    parent workspace deletion while files are being extracted. Cleanup needs a
    durable hard protection signal before `bash -lc <bootstrap command>` starts.

    What:
    1. In `src/agent-runtime/bootstrap.ts`, before the first call to `runShell`,
       update the role bootstrap state to `in_progress`, store config hash,
       canonical branch head, lastRole, and clear prior failure details for the
       current attempt.
    2. Start/renew the workspace provisioning lease with phase `bootstrap` and
       role `worker` or `reviewer` before spawning each subprocess.
    3. On successful completion, persist existing succeeded state and step
       results, then let the caller clear/advance the lease.
    4. On failure/abort/throw, persist failed state and failureMessage in a
       `finally`-equivalent path before rethrowing `DispatchBootstrapError`.
    5. Ensure skipped/reused bootstrap does not create an in_progress state.

    How: Preserve existing ACs requiring exact command strings and sanitized
    environment. Do not wrap or modify configured bootstrap commands.

    Covers: @dispatch-runtime-bootstrap-contract ac-bootstrap-in-progress-is-durable,
    ac-bootstrap-terminal-state-after-subprocess.

- title: Include in-flight task refs in cleanup protection
  slug: task-include-inflight-refs-in-cleanup-protection
  priority: 1
  tags: [dispatch, scheduler, cleanup]
  spec_ref: "@agent-dispatch-engine"
  depends_on:
    - "@task-add-dispatch-inflight-cleanup-protection-ac"
  description: |
    Update the dispatch engine's active task set used for artifact cleanup so it
    includes tasks between queue dequeue and active invocation registration.

    Why: `_spawnInvocation()` adds `${agentId}:${taskRef}` to `inFlightTaskKeys`
    before provisioning. `_activeTaskRefs()` currently ignores those keys, so
    startup/periodic reconciliation can call cleanup with an incomplete active
    set during the exact window that needs protection.

    What:
    1. Update `_activeTaskRefs()` in `src/agent-runtime/dispatch.ts` to include
       task refs parsed from `this.inFlightTaskKeys` in addition to
       `activeInvocationDetails`.
    2. Keep `_hasActiveInvocationForTask()` behavior unchanged except where it
       can reuse the same parser helper.
    3. Ensure both reconcile call sites that pass `activeTaskRefs:
       this._activeTaskRefs()` now receive the expanded protection set.

    How: Parse in-flight keys by splitting only on the first `:` so task refs
    remain intact. Add a small helper if needed to avoid duplicating parsing.

    Covers: @agent-dispatch-engine ac-inflight-provisioning-counts-active-for-cleanup.

- title: Make artifact reconciliation lease-aware
  slug: task-make-artifact-reconciliation-lease-aware
  priority: 1
  tags: [dispatch, workspace, cleanup]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-mark-workspace-provisioning-before-mutation"
    - "@task-record-bootstrap-in-progress-terminal-states"
    - "@task-include-inflight-refs-in-cleanup-protection"
  description: |
    Teach `reconcileDispatchWorkspaceArtifacts()` to preserve leased and
    in-flight workspace artifacts across every deletion path.

    Why: Cleanup has several independent deletion paths: cleanup-eligible record
    reaping, unreferenced reviewer snapshot deletion, unregistered root directory
    pruning, and orphan dispatch branch deletion. All must honor the same
    protection contract or the race can reappear through a different path.

    What:
    1. In `src/agent-runtime/workspace.ts`, load the workspace registry once near
       the start of `reconcileDispatchWorkspaceArtifacts()` and build protected
       sets for:
       - task refs with non-expired provisioning leases;
       - worker worktree paths for leased/non-closed records;
       - reviewer worktree paths for leased/non-closed records;
       - canonical branches for leased/non-closed records.
    2. Treat `options.activeTaskRefs` as an additional hard protection source.
    3. Before calling `reapDispatchWorkspace()`, skip records whose task ref is
       active/in-flight or whose registry record has a non-expired provisioning
       lease or in_progress bootstrap state.
    4. Before deleting reviewer snapshot directories, skip paths in the
       protected reviewer set.
    5. Before deleting root directories without `.git`, skip any candidate that
       is equal to or contained by a protected worker/reviewer path.
    6. Before deleting dispatch branches, preserve branches for any non-closed
       registry record and explicitly include leased branches in diagnostics.
    7. When a lease is expired, call the abandonment helper before allowing
       cleanup to proceed on later cycles.

    How: Keep cleanup conservative. A protected path false-positive is safer
    than deleting an active bootstrap tree. Existing closed-record retention and
    branch-pruning behavior should remain unchanged for records with no active
    task and no valid lease.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-protects-worker-worktree,
    ac-provisioning-lease-protects-reviewer-worktree, ac-provisioning-lease-protects-root-directory,
    ac-provisioning-lease-protects-dispatch-branch,
    ac-provisioning-lease-keeps-lifecycle-open, ac-expired-provisioning-lease-recovery;
    @dispatch-runtime-bootstrap-contract ac-bootstrap-cleanup-interlock.

- title: Finalize leases around invocation activation and preparation failures
  slug: task-finalize-provisioning-leases-around-invocation-start
  priority: 1
  tags: [dispatch, workspace, scheduler]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-make-artifact-reconciliation-lease-aware"
  description: |
    Wire lease finalization into `_spawnInvocation()` so successful preparation
    hands off to active invocation state and failed preparation does not leave a
    stale protected lease.

    Why: Provisioning and bootstrap are called from `_spawnInvocation()` before
    active invocation registration. The caller owns the overall preparation
    lifecycle and must guarantee lease cleanup across success, adapter errors,
    prompt errors, validation failures, and thrown exceptions.

    What:
    1. In `src/agent-runtime/dispatch.ts`, establish a provisioning owner tuple
       before provisioning starts: daemon instance id, process pid, process
       started_at, and a dedicated spawn attempt ULID. The spawn attempt ULID is
       the value cleanup uses to match an expired lease to a still-live
       in-memory preparation attempt; pid liveness by itself is not sufficient.
    2. Advance lease phases as preparation proceeds: workspace, bootstrap,
       validation, invocation_start.
    3. On successful `markDispatchWorkspaceActive()`, clear the provisioning
       lease or allow mark-active to atomically replace it with active_role.
    4. On provisioning/bootstrap/validation/prompt/adapter failure before
       invocation registration, finalize the lease with failed/unhealthy
       diagnostics before returning false.
    5. Ensure `finally` still removes `inFlightTaskKeys` when no invocation was
       registered, preserving existing scheduler deduplication semantics.

    How: Avoid making task-blocking or task-note recovery depend on the lease
    write succeeding. If lease finalization fails, log the failure but keep the
    task recovery path actionable.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-success-finalized,
    ac-provisioning-lease-failure-finalized, ac-provisioning-lease-identifies-owner.

# ─── Phase 4: Regression Coverage and Guardrails ───

- title: Cover lease schema defaults and transitions
  slug: task-test-provisioning-lease-schema-and-transitions
  priority: 1
  tags: [tests, dispatch, schema]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-implement-dispatch-workspace-provisioning-lease-helpers"
  description: |
    Add unit coverage proving old registry records validate, lease transitions
    persist, and expired leases become abandoned diagnostics instead of silent
    deletes.

    Why: The registry file is durable project metadata. Backward compatibility
    and deterministic transition semantics are required before cleanup relies on
    the new fields.

    What:
    1. Add tests in `tests/dispatch-workspace-registry.test.ts` or a focused new
       test file for schema defaulting when `provisioning_lease` is omitted.
    2. Test mark/renew/clear helper idempotence and timestamp/phase updates.
    3. Test expired lease recovery records stale/invalid health details and does
       not delete artifacts in the same step.

    How: Use existing fixture helpers for temp kspec projects and registry
    persistence. Avoid real long-running subprocesses in these unit tests.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-recorded-before-mutation,
    ac-provisioning-lease-identifies-owner, ac-provisioning-lease-success-finalized,
    ac-provisioning-lease-failure-finalized, ac-expired-provisioning-lease-recovery.

- title: Cover artifact reconciliation preserving active bootstrap artifacts
  slug: task-test-artifact-reconciliation-preserves-bootstrap-artifacts
  priority: 1
  tags: [tests, dispatch, cleanup, bootstrap]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-make-artifact-reconciliation-lease-aware"
  description: |
    Add regression tests proving artifact reconciliation does not delete worker
    or reviewer workspace artifacts while provisioning/bootstrap is leased or
    in-flight.

    Why: This is the direct regression for the `npm` extraction ENOENT failure.
    Cleanup must skip all relevant deletion paths, not just the branch-pruning
    path.

    What:
    1. Create a test workspace registry record with a non-expired provisioning
       lease and a worker worktree path under the dispatch worktree root.
    2. Place nested bootstrap-like directories/files under the worker path,
       including directories without `.git` markers that would otherwise look
       pruneable from the worktree root scan.
    3. Run `reconcileDispatchWorkspaceArtifacts()` with no active invocation and
       assert the leased worker path, nested files, reviewer path, and canonical
       branch are preserved.
    4. Repeat with `activeTaskRefs` containing the task ref but no lease to prove
       in-flight engine protection works.
    5. Add a negative control for a closed/no-lease stale artifact to ensure
       cleanup still removes truly orphaned artifacts.

    How: Keep the fixture small and deterministic. The test does not need to run
    real `npm`; it only needs to prove cleanup cannot remove the parent tree
    during an active bootstrap window.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-protects-worker-worktree,
    ac-provisioning-lease-protects-reviewer-worktree, ac-provisioning-lease-protects-root-directory,
    ac-provisioning-lease-protects-dispatch-branch,
    @dispatch-runtime-bootstrap-contract ac-bootstrap-cleanup-interlock,
    @agent-dispatch-engine ac-inflight-provisioning-counts-active-for-cleanup.

- title: Cover dispatch bootstrap race with controlled in-flight spawn
  slug: task-test-dispatch-bootstrap-race-inflight-protection
  priority: 1
  tags: [tests, dispatch, scheduler, bootstrap]
  spec_ref: "@agent-dispatch-engine"
  depends_on:
    - "@task-finalize-provisioning-leases-around-invocation-start"
  description: |
    Add a higher-level dispatch engine regression test where reconciliation runs
    while a spawn attempt is blocked in bootstrap, then verify cleanup does not
    remove the workspace.

    Why: Unit tests around cleanup are necessary but not sufficient; the bug
    exists because `_spawnInvocation()`, in-memory in-flight tracking, bootstrap,
    and reconciliation compose incorrectly.

    What:
    1. Add a dispatch engine test using `DispatchEngine` with
       `reconcileIntervalMs: 0` and controlled/manual invocation of the
       reconciliation path.
    2. Configure a bootstrap step that blocks on a fixture-controlled signal or
       creates a sentinel file before waiting.
    3. Start spawn for a task and wait until the bootstrap sentinel exists.
    4. Trigger workspace artifact reconciliation while the spawn is still
       in-flight.
    5. Assert the workspace directory and bootstrap sentinel survive, then
       release bootstrap and assert the lease is finalized and the invocation can
       proceed or fail in the expected controlled way.

    How: Prefer a tiny shell script fixture over sleeps. The test should wait on
    file existence or a probarrier to avoid timing flakes.

    Covers: @agent-dispatch-engine ac-inflight-provisioning-counts-active-for-cleanup,
    @dispatch-runtime-bootstrap-contract ac-bootstrap-in-progress-is-durable,
    ac-bootstrap-terminal-state-after-subprocess.

# ─── Phase 5: Validation ───

- title: Validate provisioning lease protection implementation
  slug: task-validate-provisioning-lease-protection
  priority: 1
  tags: [validation, dispatch, tests]
  spec_ref: "@dispatch-workspace-registry"
  depends_on:
    - "@task-test-provisioning-lease-schema-and-transitions"
    - "@task-test-artifact-reconciliation-preserves-bootstrap-artifacts"
    - "@task-test-dispatch-bootstrap-race-inflight-protection"
  description: |
    Run targeted and broad validation for the provisioning lease protection work
    and record the results on the validation task. Add notes to individual
    implementation tasks only when their task-specific evidence needs to be
    preserved there.

    Why: The failure is race-like and touches durable metadata, cleanup, and
    dispatch engine scheduling. Validation must prove both the new regression
    tests and existing dispatch workspace behavior still pass.

    What:
    1. Run targeted tests for the changed areas, including:
       - dispatch workspace registry tests;
       - dispatch workspace/artifact cleanup tests;
       - dispatch runtime bootstrap tests;
       - dispatch engine scheduler/in-flight tests.
    2. Run project validation commands:
       - `npm run typecheck`
       - `npm test -- --fresh` for the full suite, or the focused
         `npm test -- --run <test-file>` form supported by
         `scripts/test.cjs` when validating an individual changed test file.
       - `kspec validate`
    3. Verify `git status --short` and shadow branch status are clean or contain
       only the intended spec/task/implementation changes.
    4. If dispatch was paused for implementation, resume it and verify
       `kspec agent status --json` reports expected running state.

    How: Capture command outputs in task notes with exact commands, exit codes,
    and any intentionally skipped expensive suites.

    Covers: @dispatch-workspace-registry ac-provisioning-lease-recorded-before-mutation,
    ac-provisioning-lease-identifies-owner, ac-provisioning-lease-keeps-lifecycle-open,
    ac-provisioning-lease-protects-worker-worktree,
    ac-provisioning-lease-protects-reviewer-worktree, ac-provisioning-lease-protects-root-directory,
    ac-provisioning-lease-protects-dispatch-branch, ac-provisioning-lease-success-finalized,
    ac-provisioning-lease-failure-finalized, ac-expired-provisioning-lease-recovery;
    @dispatch-runtime-bootstrap-contract
    ac-bootstrap-in-progress-is-durable, ac-bootstrap-terminal-state-after-subprocess,
    ac-bootstrap-cleanup-interlock; @agent-dispatch-engine
    ac-inflight-provisioning-counts-active-for-cleanup.
```


## Implementation Notes

This is an existing-spec update plan. The `## Specs` section deliberately does
not contain structured YAML specs because kspec derivation creates new spec
items from that block; the intended work is to add ACs to existing refs. Phase 1
spec-update tasks are therefore the source of truth for the exact AC text.

Lease owner semantics are intentionally stricter than pid liveness. A
provisioning lease owner is the tuple `(owner_daemon_id, owner_pid,
owner_process_started_at, owner_spawn_id)`. Cleanup may preserve a non-expired
lease regardless of owner. For an expired lease, cleanup may treat it as still
live only if the task is in the active/in-flight protection set or the current
daemon instance has a live in-memory spawn attempt matching `owner_spawn_id`.
After restart, no such in-memory attempt exists, so an expired foreign lease is
marked abandoned before any subsequent cleanup cycle may delete artifacts.

Dependency ordering keeps spec updates first, schema/helpers second, runtime
wiring third, regression coverage fourth, and validation last. The schema task
makes the lease shape durable before runtime code depends on it; cleanup becomes
lease-aware only after provisioning/bootstrap/in-flight producers exist.
