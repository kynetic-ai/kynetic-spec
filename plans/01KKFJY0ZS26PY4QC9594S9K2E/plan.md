# Dispatch Worktree Isolation and Scheduling

This plan covers the highest-priority dispatcher/runtime gaps for autonomous task execution:

- each dispatched worker or reviewer should run inside an isolated git worktree under a dispatcher-managed worktree root
- each task branch should be sourced from one configurable project base branch and carry an explicit merge target back to that branch
- the dispatcher should own workspace provisioning, branch selection, cleanup, and enough runtime/bootstrap setup that agents do not have to rediscover routine environment steps every time
- worker, reviewer, and fix-cycle flows should share an explicit canonical workspace model rather than relying on ad hoc branch switching
- dispatch ordering should be governed by an explicit scheduler contract spanning candidate kind, numeric priority (`P1`-`P5`), continuity, and fairness
- shadow-branch serialization should be narrowed so code work can run in parallel while kspec metadata mutations stay safe

This plan supersedes the older artifact-oriented framing in `.kspec/artifacts/task-isolation-and-review-system.md` for the dispatch/isolation area. Planning is no longer import-only; this plan assumes the current `plan import` / `plan import --into` / `plan derive` lifecycle.

## Context

The current dispatch engine has improved state visibility after invocation completion, but several structural gaps remain:

1. Invocations still share one code checkout, so worker/reviewer overlap is fragile.
2. The global shadow mutex still wraps the full invocation instead of just the kspec mutation windows.
3. The dispatcher does not own workspace creation, branch naming, base-branch targeting, or runtime bootstrap in a first-class way.
4. Reviewers do not have a durable, Git-safe branch/workspace model to attach to.
5. Queue ordering still does not use a fully explicit contract across candidate kind, numeric priority, continuity, and fairness.
6. Cleanup of task branches and dispatch worktrees is not first-class, so stale state can accumulate.

## Design Decisions

This draft makes the following intentional decisions so the plan is executable instead of leaving core identity rules open-ended:

1. **One project base branch per dispatch domain.** The dispatcher resolves a canonical base/integration branch from `kspec.config.yaml` (`dispatch.base_branch`), with deterministic fallback when unset. All task branches in this plan fork from and target that branch. Chain-of-work ancestry is out of scope.
2. **One canonical mutable task branch per task.** Workers and fix-cycle workers own the mutable checkout for that task branch.
3. **Reviewer isolation must be Git-safe.** Reviewers get separate isolated worktrees materialized from the canonical task branch head, but not a second checked-out copy of the same local branch. Detached HEAD or an equivalent read-only review ref is the intended model.
4. **One active canonical workspace record per task.** Group-level workspace sharing is out of scope for this plan and belongs to the grouped-work plan.
5. **Dispatcher-managed worktrees live under a project-local root by default.** The default root is `.kspec-worktrees/` under the project root; `/tmp` is not the default because workspaces must survive daemon restarts and remain inspectable.
6. **Dispatcher-owned bootstrap is bounded.** Bootstrap may provision environment state and run configured setup commands, but it must not silently modify tracked source files unless a bootstrap step is explicitly marked as allowing tracked mutations.
7. **Merge target and cleanup state are first-class.** The dispatcher records the base branch, publication target, integration status, and cleanup status so worker/reviewer/fix-cycle prompts can stay consistent and the daemon can clean up deterministically.
8. **Numeric priority is strict within a candidate band.** Fairness prevents starvation caused by affinity/FIFO within the same candidate band and numeric priority, but it does not override explicit `P1`-`P5` ordering.

## Specs

```yaml
- title: Dispatch Workspace Configuration
  slug: dispatch-workspace-configuration
  type: feature
  parent: "@project-config"
  description: |
    kspec.config.yaml exposes dispatch-specific configuration for canonical
    base branch selection and dispatcher-managed worktree placement.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        kspec.config.yaml sets dispatch.base_branch to a branch such as
        agent-dev
      when: |
        The dispatcher provisions a task workspace
      then: |
        Canonical task branches are created from that branch and the same
        branch is recorded as the default PR or manual merge target for the
        task
    - id: ac-2
      given: |
        dispatch.base_branch is not configured
      when: |
        A task workspace is provisioned
      then: |
        The dispatcher resolves the repository's default integration branch
        deterministically using remote HEAD when available, otherwise the
        current symbolic branch of the main repo checkout, otherwise `main`,
        and records the resolved value on the workspace so later invocations do
        not drift
    - id: ac-3
      given: |
        kspec.config.yaml sets dispatch.worktree_root to a relative or absolute
        path
      when: |
        The dispatch worktree root is resolved
      then: |
        Relative paths resolve from the project root, absolute paths are used
        as-is, and the default when unset is `.kspec-worktrees`
    - id: ac-4
      given: |
        The configured base branch or worktree root is invalid or unusable
      when: |
        The dispatcher provisions a workspace
      then: |
        Dispatch fails with actionable guidance instead of silently falling back
        to a shared checkout or hardcoded branch

- title: Canonical Task Workspace Contract
  slug: canonical-task-workspace-contract
  type: feature
  parent: "@agent-dispatch-engine"
  description: |
    Each dispatchable task owns one canonical mutable branch lineage and one
    canonical workspace identity. Workers and fix-cycle workers attach to the
    mutable task branch, while reviewers attach to an isolated snapshot context
    anchored to that branch lineage.
  acceptance_criteria:
    - id: ac-1
      given: |
        The dispatcher provisions workspace state for a task and the base
        branch has been resolved
      when: |
        It establishes the task's code identity
      then: |
        One canonical task branch is created from the resolved base branch and
        the originating base commit is recorded
    - id: ac-2
      given: |
        A worker invocation and a later needs_work fix-cycle invocation run for
        the same task
      when: |
        The dispatcher prepares their code context
      then: |
        Both use the same canonical mutable task branch rather than creating a
        new branch per cycle
    - id: ac-3
      given: |
        A reviewer invocation is prepared for a task with an existing canonical
        branch
      when: |
        The reviewer workspace is created
      then: |
        The reviewer gets a separate isolated worktree materialized from the
        recorded canonical branch head in detached HEAD or equivalent read-only
        mode, and the dispatcher never attempts to check out the same local
        branch in two worktrees
    - id: ac-4
      given: |
        A task transitions to needs_work after review
      when: |
        A follow-up worker invocation is prepared
      then: |
        The worker resumes on the same canonical branch lineage instead of
        forking a new task branch
    - id: ac-5
      given: |
        The dispatcher generates a canonical branch name for a task
      when: |
        The branch is first provisioned
      then: |
        The branch name follows the deterministic format
        `dispatch/task/<normalized-task-slug-or-task>/<short-task-ulid>` where
        the slug portion is normalized to kebab-case and the ULID suffix makes
        collisions impossible without relying on role-specific prefixes
    - id: ac-6
      given: |
        A task branch has been integrated into its recorded base branch or the
        task has been explicitly abandoned or reset
      when: |
        The dispatcher reconciles the workspace lifecycle
      then: |
        The canonical task branch becomes cleanup-eligible rather than
        remaining indefinitely active

- title: Dispatch Workspace Registry
  slug: dispatch-workspace-registry
  type: requirement
  parent: "@canonical-task-workspace-contract"
  description: |
    The dispatcher persists canonical workspace metadata in a first-party
    registry so branch, worktree, integration, and cleanup identity survive
    restarts and can be reused across worker, reviewer, and fix-cycle
    invocations.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        A canonical task workspace is provisioned
      when: |
        The dispatcher persists its identity
      then: |
        A first-party workspace record is stored in kspec-managed metadata on
        the shadow branch rather than existing only in daemon memory
    - id: ac-2
      given: |
        A task has an active canonical workspace
      when: |
        The registry is validated
      then: |
        At most one active canonical workspace record exists for that task
    - id: ac-3
      given: |
        A workspace record exists
      when: |
        It is stored in the registry
      then: |
        The record includes at minimum workspace id, task ref, resolved base
        branch, base head at branch point, canonical branch, canonical branch
        head, per-role worktrees, bootstrap state, integration status, health
        status, timestamps, and cleanup state
    - id: ac-4
      given: |
        The daemon restarts or reloads dispatch state
      when: |
        It reconstructs active workspace state
      then: |
        The dispatcher reloads workspace records from the registry and
        reconciles them against the filesystem instead of losing
        branch/worktree continuity
    - id: ac-5
      given: |
        A workspace record's referenced branch or worktree is missing,
        unhealthy, or out of sync with its recorded state
      when: |
        Reconciliation runs
      then: |
        The record transitions to an explicit non-healthy state such as invalid
        or stale, with actionable recovery data rather than silent fallback
    - id: ac-6
      given: |
        A workspace record is tracked over time
      when: |
        Its lifecycle state changes
      then: |
        The transition states are explicit and behavioral: `provisioning`
        during initial branch/worktree/bootstrap setup, `ready` after
        provisioning/bootstrap with no running invocation, `active` while a
        role invocation is attached, `stale` when reconciliation finds missing
        or invalid recorded state, `integrating` when PR or manual merge-back
        is pending or in progress, `closing` when merged or abandoned state
        schedules cleanup, `cleanup_blocked` when cleanup safety checks fail,
        and `closed` after tracked worktrees are removed and the record is
        finalized
    - id: ac-7
      given: |
        Integration or cleanup state changes over the life of the task
      when: |
        The registry is updated
      then: |
        Those transitions are durably persisted on the shadow branch for
        restart recovery and later review workflows

- title: Dispatched Invocation Worktree Isolation
  slug: dispatch-invocation-worktree-isolation
  type: feature
  parent: "@worktree-support"
  description: |
    Each dispatched agent invocation runs in an isolated git worktree rooted
    under a dispatcher-managed worktree root instead of sharing the primary
    checkout.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        The dispatch engine is about to spawn a worker or fix-cycle invocation
        for a task
      when: |
        The invocation is created
      then: |
        The engine creates or reuses an isolated mutable worktree under a
        dedicated dispatch worktree root rather than running in the main
        checkout
    - id: ac-2
      given: |
        A reviewer invocation is prepared for a task with a canonical branch
      when: |
        The review worktree is prepared
      then: |
        The reviewer uses a separate worktree directory positioned at the
        recorded canonical branch head without checking out the same local
        branch a second time
    - id: ac-3
      given: |
        A role-specific worktree already exists for a task and is healthy for
        reuse
      when: |
        A later invocation for that role is spawned
      then: |
        The dispatcher may reuse that role worktree by reconciling it to the
        recorded canonical state appropriate to the role rather than creating a
        fresh checkout every time
    - id: ac-4
      given: |
        A tracked worktree is missing, broken, or cannot be prepared safely
      when: |
        The dispatch engine prepares an invocation
      then: |
        The engine either repairs or recreates the worktree using the canonical
        workspace record, or blocks the task with guidance; it does not fall
        back to the shared main checkout
    - id: ac-5
      given: |
        Dispatch worktrees are created on disk
      when: |
        Their location is chosen
      then: |
        They live outside the shadow worktree itself and under one configurable
        dispatch worktree root with deterministic path derivation

- title: Dispatch Branch Integration Contract
  slug: dispatch-branch-integration-contract
  type: requirement
  parent: "@canonical-task-workspace-contract"
  description: |
    Each canonical task branch carries explicit integration metadata so workers
    and reviewers know which base branch to target for PRs or local merge-back
    instead of assuming `main`.
  acceptance_criteria:
    - id: ac-1
      given: |
        A canonical task branch is provisioned
      when: |
        The workspace record is created
      then: |
        The resolved base branch and branch-point commit are recorded as the
        integration target metadata for that task
    - id: ac-2
      given: |
        A worker or reviewer invocation is prepared
      when: |
        Orientation or workflow entry content is rendered
      then: |
        The canonical branch, integration target branch, and canonical head or
        snapshot under review are included explicitly
    - id: ac-3
      given: |
        Publication guidance must be prepared for a task workspace
      when: |
        Repository capabilities and dispatch configuration are evaluated
      then: |
        The dispatcher selects one explicit publication mode for that workspace,
        such as `pull_request` or `manual_merge`, and records that selection
        before rendering role instructions
    - id: ac-4
      given: |
        Hosted PR tooling is available and selected for publication
      when: |
        Publish instructions are rendered
      then: |
        PR creation or update targets the recorded base branch rather than a
        hardcoded branch name
    - id: ac-5
      given: |
        Hosted PR tooling is unavailable or disabled
      when: |
        Publish instructions are rendered
      then: |
        The dispatcher provides deterministic manual merge-back guidance against
        the recorded base branch, including explicit conflict-handling
        escalation
    - id: ac-6
      given: |
        Merge-back or PR integration outcomes become known
      when: |
        Workspace state is updated
      then: |
        The integration outcome is recorded in a form that later cleanup or
        fix-cycle logic can consume

- title: Dispatch Workspace Cleanup Policy
  slug: dispatch-workspace-cleanup-policy
  type: requirement
  parent: "@dispatch-workspace-registry"
  description: |
    The dispatcher cleans up dispatch worktrees and task branches
    deterministically so it does not leave stale directories or refs behind.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        A reviewer snapshot worktree finishes and no retention or debug hold
        exists
      when: |
        Cleanup policy evaluates role worktrees
      then: |
        The reviewer worktree becomes immediately cleanup-eligible while the
        canonical worker worktree persists across in_progress and needs_work
        continuity
    - id: ac-2
      given: |
        A task reaches completed or cancelled status, or the workspace
        integration outcome becomes merged or explicitly abandoned
      when: |
        Cleanup policy runs
      then: |
        The workspace enters `closing` and scheduled cleanup is created
    - id: ac-3
      given: |
        Cleanup executes for a workspace with tracked dispatch worktrees
      when: |
        The cleanup steps run
      then: |
        Worktree directories and their corresponding git worktree metadata are
        removed from the configured dispatch root without touching the main or
        shadow worktrees
    - id: ac-4
      given: |
        A canonical task branch still has active invocation ownership or
        unresolved integration status
      when: |
        Cleanup evaluates branch deletion
      then: |
        The branch is not deleted and the record moves to `cleanup_blocked`
        with actionable guidance
    - id: ac-5
      given: |
        Daemon startup or periodic reconciliation finds orphaned dispatch
        worktrees or task branches under the dispatch root
      when: |
        Registry and filesystem state are compared
      then: |
        The dispatcher either reattaches them to a workspace record or cleans
        them up deterministically instead of leaving orphaned state

- title: Dispatch Runtime Bootstrap Contract
  slug: dispatch-runtime-bootstrap-contract
  type: requirement
  parent: "@agent-invocation-lifecycle"
  description: |
    The dispatcher performs bounded, reproducible bootstrap and dependency
    preparation for task workspaces so agents do not have to rediscover routine
    environment setup on every invocation.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        A task workspace is ready to use
      when: |
        Invocation preflight runs
      then: |
        The dispatcher resolves bootstrap configuration from explicit dispatch
        or agent configuration and runs the configured bootstrap workflow
        before delivering the prompt
    - id: ac-2
      given: |
        Bootstrap steps are configured for a workspace
      when: |
        The dispatcher executes them
      then: |
        The bootstrap contract explicitly distinguishes allowed environment or
        dependency provisioning from tracked source mutations, and tracked
        source mutations require explicit opt-in
    - id: ac-3
      given: |
        A reviewer invocation is prepared for a workspace that a worker already
        bootstrapped
      when: |
        Reviewer preflight runs
      then: |
        The reviewer reuses recorded bootstrap state where valid and may rerun
        only idempotent or explicitly allowed bootstrap steps; it does not
        silently introduce new tracked source changes
    - id: ac-4
      given: |
        Bootstrap state is cached for workspace reuse
      when: |
        The dispatcher decides whether to reuse or rerun bootstrap
      then: |
        The invalidation signals are explicit and testable, including recorded
        canonical branch head changes, bootstrap config changes, and failed
        prior bootstrap state
    - id: ac-5
      given: |
        A workspace has already completed bootstrap and no invalidation signal
        is present
      when: |
        A later invocation for that workspace is prepared
      then: |
        The dispatcher reuses the prior bootstrap result instead of rerunning
        expensive setup blindly
    - id: ac-6
      given: |
        Bootstrap fails because dependencies or runtime requirements cannot be
        satisfied automatically
      when: |
        The invocation would otherwise start
      then: |
        The dispatcher records the failure with actionable detail and either
        blocks the task or marks the workspace unhealthy; it does not hand the
        agent an unexplained broken environment

- title: Dispatch Workspace Orientation Prompt
  slug: dispatch-workspace-orientation-prompt
  type: requirement
  parent: "@agent-dispatch-engine"
  description: |
    The dispatch prompt explicitly orients the agent to its workspace, branch,
    integration target, role, focus, and current bootstrap state so the agent
    starts from the correct operational context without guesswork.
  acceptance_criteria:
    - id: ac-1
      given: |
        A worker or reviewer invocation prompt is built
      when: |
        Workspace metadata is available
      then: |
        The prompt includes the workspace path, canonical branch, integration
        target branch, task ref, role, focus, and the reason this invocation
        was selected
    - id: ac-2
      given: |
        The dispatcher has branch mode, canonical head, bootstrap, health, or
        dependency status for the workspace
      when: |
        The prompt is built
      then: |
        The prompt states whether the workspace is a mutable worker branch or a
        detached review snapshot, identifies the canonical head being resumed or
        reviewed, and summarizes relevant prepared state and caveats
    - id: ac-3
      given: |
        The invocation is part of a fix cycle or review cycle
      when: |
        The prompt is rendered
      then: |
        The prompt makes the cycle context explicit, including whether a
        follow-up worker will resume the same canonical branch after review and
        which base branch remains the publication target

- title: Dispatch Role Workflow Entry Contract
  slug: dispatch-role-workflow-entry-contract
  type: requirement
  parent: "@agent-invocation-lifecycle"
  description: |
    Role-specific workflow entry is a dispatcher-owned contract separate from
    workspace orientation. The dispatcher selects and renders the correct work,
    review, PR-target, and manual merge guidance entrypoint for the adapter and
    role.
  acceptance_criteria:
    - id: ac-1
      given: |
        A worker or reviewer invocation is prepared
      when: |
        The dispatcher builds the actionable part of the invocation
      then: |
        The dispatcher selects the configured workflow or skill entrypoint for
        that role independently from the orientation block
    - id: ac-2
      given: |
        Worker and reviewer adapters or harnesses differ
      when: |
        Their role entrypoints are rendered
      then: |
        The dispatcher renders adapter-appropriate invocation syntax and
        includes the publish path instructions against the recorded base branch,
        using the recorded publication mode for that workspace
    - id: ac-3
      given: |
        Manual merge-back is the selected publication path
      when: |
        The role entrypoint is rendered
      then: |
        It includes explicit conflict-handling guidance and when to stop or
        escalate rather than auto-resolving blindly
    - id: ac-4
      given: |
        A role-specific workflow entrypoint or publication mode is missing or
        invalid
      when: |
        The invocation is prepared
      then: |
        The dispatcher fails fast with actionable guidance instead of
        delivering a half-oriented prompt with no valid workflow entry

- title: Scoped Dispatch Shadow Serialization
  slug: scoped-dispatch-shadow-serialization
  type: requirement
  parent: "@agent-dispatch-engine"
  description: |
    Shadow-branch protection serializes only kspec metadata mutations, not the
    full lifetime of every invocation, so isolated code work can overlap safely
    across worker and reviewer roles.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        Two isolated invocations are running concurrently in separate code
        worktrees
      when: |
        Neither invocation is performing a kspec mutation
      then: |
        They are allowed to continue in parallel without waiting on a global
        invocation-level mutex
    - id: ac-2
      given: |
        Multiple invocations attempt shadow-branch mutations such as task note,
        task submit, task needs-work, or plan/task metadata writes
      when: |
        Those mutation windows overlap
      then: |
        Only the mutation sections are serialized so shadow branch integrity is
        preserved
    - id: ac-3
      given: |
        A mutation-level lock cannot be acquired or a protected mutation fails
      when: |
        The invocation handles the failure
      then: |
        The error is surfaced as a mutation failure, not disguised as a generic
        workspace execution failure

- title: Dispatch Scheduling Priority Model
  slug: dispatch-scheduling-priority-model
  type: requirement
  parent: "@dispatch-in-progress-priority"
  description: |
    Dispatch ordering is governed by one explicit cross-agent scheduler
    contract spanning candidate kind, numeric task priority, continuity or
    affinity, and fairness. Agent definition order must not be the deciding
    rule for cross-agent work ordering.
  traits:
    - "@trait-priority-parameter"
  acceptance_criteria:
    - id: ac-1
      given: |
        The scheduler evaluates queued or candidate invocations
      when: |
        It determines eligibility
      then: |
        Only candidates that satisfy the applicable eligibility contract are
        ranked: pending and needs_work candidates must pass base task
        readiness, in_progress and pending_review candidates must come from
        explicit continuation or handoff dispatch support, and any candidate
        with stale workspace state or unresolved dependency blocking is
        excluded
    - id: ac-2
      given: |
        Eligible candidates exist across candidate bands
      when: |
        The scheduler ranks them
      then: |
        The fixed band order is in_progress first, then needs_work, then
        pending_review, then pending
    - id: ac-3
      given: |
        Multiple eligible candidates share the same candidate band
      when: |
        The scheduler ranks them
      then: |
        Lower numeric task priority values (P1 before P5) rank ahead of higher
        numeric values before continuity or FIFO is considered
    - id: ac-4
      given: |
        Multiple eligible candidates share the same candidate band and the same
        numeric priority
      when: |
        The scheduler ranks them
      then: |
        Continuity or affinity signals may prefer continuing an active review
        or fix-cycle chain before unrelated work
    - id: ac-5
      given: |
        Continuity or affinity would otherwise keep skipping other equal-band,
        equal-priority work indefinitely
      when: |
        A candidate exceeds the scheduler's starvation threshold
      then: |
        Continuity or affinity is ignored for that comparison and the oldest
        equal-band, equal-priority eligible candidate wins
    - id: ac-6
      given: |
        pending_review and pending candidates both exist and no in_progress or
        needs_work work is waiting
      when: |
        The scheduler selects the next invocation
      then: |
        pending_review work remains ahead of pending work as a hard scheduler
        rule, not merely an affinity preference
    - id: ac-7
      given: |
        The scheduler chooses between worker and reviewer candidates
      when: |
        Their relative rank is determined
      then: |
        The chosen order follows the scheduler contract above rather than agent
        definition order alone
```

## Tasks

derive_from_specs: false

```yaml
- slug: task-design-dispatch-workspace-config
  title: Design dispatch config for base branch and worktree root
  spec_ref: "@dispatch-workspace-configuration"
  priority: 1
  tags: [dispatch, config, worktree]

- slug: task-design-canonical-task-workspace-contract
  title: Design canonical task branch and workspace contract
  spec_ref: "@canonical-task-workspace-contract"
  priority: 1
  tags: [dispatch, worktree, design]
  depends_on: ["@task-design-dispatch-workspace-config"]

- slug: task-design-dispatch-workspace-registry
  title: Design persistent dispatch workspace registry
  spec_ref: "@dispatch-workspace-registry"
  priority: 1
  tags: [dispatch, worktree, schema]
  depends_on:
    - "@task-design-dispatch-workspace-config"
    - "@task-design-canonical-task-workspace-contract"

- slug: task-implement-dispatch-workspace-config
  title: Implement dispatch config for base branch and worktree root
  spec_ref: "@dispatch-workspace-configuration"
  priority: 1
  tags: [dispatch, config]
  depends_on: ["@task-design-dispatch-workspace-config"]

- slug: task-implement-canonical-task-workspace-contract
  title: Implement canonical task branch lineage contract
  spec_ref: "@canonical-task-workspace-contract"
  priority: 1
  tags: [dispatch, branch, worktree]
  depends_on:
    - "@task-design-canonical-task-workspace-contract"
    - "@task-implement-dispatch-workspace-config"

- slug: task-implement-dispatch-workspace-registry
  title: Implement persistent dispatch workspace registry
  spec_ref: "@dispatch-workspace-registry"
  priority: 1
  tags: [dispatch, worktree, schema]
  depends_on:
    - "@task-design-dispatch-workspace-registry"
    - "@task-implement-canonical-task-workspace-contract"

- slug: task-implement-dispatch-worktree-provisioning
  title: Implement canonical worktree provisioning and reviewer snapshot isolation
  spec_ref: "@dispatch-invocation-worktree-isolation"
  priority: 1
  tags: [dispatch, worktree, runtime]
  depends_on:
    - "@task-implement-canonical-task-workspace-contract"
    - "@task-implement-dispatch-workspace-registry"

- slug: task-implement-dispatch-branch-integration-contract
  title: Implement dispatch branch integration target contract
  spec_ref: "@dispatch-branch-integration-contract"
  priority: 1
  tags: [dispatch, branch, review]
  depends_on:
    - "@task-implement-canonical-task-workspace-contract"
    - "@task-implement-dispatch-workspace-registry"

- slug: task-implement-dispatch-workspace-cleanup
  title: Implement dispatch workspace cleanup and reaping
  spec_ref: "@dispatch-workspace-cleanup-policy"
  priority: 1
  tags: [dispatch, cleanup, worktree]
  depends_on:
    - "@task-implement-dispatch-worktree-provisioning"
    - "@task-implement-dispatch-branch-integration-contract"

- slug: task-implement-dispatch-bootstrap-contract
  title: Implement dispatcher-owned runtime bootstrap contract
  spec_ref: "@dispatch-runtime-bootstrap-contract"
  priority: 1
  tags: [dispatch, runtime, bootstrap]
  depends_on:
    - "@task-implement-dispatch-workspace-registry"
    - "@task-implement-dispatch-worktree-provisioning"

- slug: task-implement-dispatch-orientation-prompt
  title: Implement workspace-aware dispatch orientation prompt
  spec_ref: "@dispatch-workspace-orientation-prompt"
  priority: 1
  tags: [dispatch, prompts]
  depends_on:
    - "@task-implement-dispatch-branch-integration-contract"
    - "@task-implement-dispatch-bootstrap-contract"

- slug: task-implement-dispatch-role-entrypoints
  title: Implement role-specific workflow, PR target, and manual merge entry contract
  spec_ref: "@dispatch-role-workflow-entry-contract"
  priority: 1
  tags: [dispatch, prompts, skills]
  depends_on:
    - "@task-implement-dispatch-orientation-prompt"
    - "@task-implement-dispatch-branch-integration-contract"

- slug: task-scope-dispatch-shadow-serialization
  title: Narrow dispatch serialization to mutation windows
  spec_ref: "@scoped-dispatch-shadow-serialization"
  priority: 1
  tags: [dispatch, concurrency, shadow]
  depends_on: ["@task-implement-dispatch-worktree-provisioning"]

- slug: task-implement-priority-aware-dispatch-scheduler
  title: Implement explicit cross-agent dispatch scheduler
  spec_ref: "@dispatch-scheduling-priority-model"
  priority: 1
  tags: [dispatch, scheduling, priority]
  depends_on:
    - "@task-implement-dispatch-workspace-registry"
    - "@task-implement-canonical-task-workspace-contract"

- slug: task-test-dispatch-workspace-and-scheduler-flow
  title: Test base-branch sourcing, isolated worktree flow, cleanup, and scheduler ordering
  priority: 1
  tags: [dispatch, test, integration]
  depends_on:
    - "@task-implement-dispatch-workspace-config"
    - "@task-implement-dispatch-worktree-provisioning"
    - "@task-implement-dispatch-branch-integration-contract"
    - "@task-implement-dispatch-workspace-cleanup"
    - "@task-implement-dispatch-bootstrap-contract"
    - "@task-implement-dispatch-orientation-prompt"
    - "@task-implement-dispatch-role-entrypoints"
    - "@task-scope-dispatch-shadow-serialization"
    - "@task-implement-priority-aware-dispatch-scheduler"
```

## Implementation Notes

### Scope boundaries

This plan is intentionally focused on dispatch/runtime behavior, scheduling, and the branch/worktree lifecycle needed to make them reliable. It is not the full review-record system and it is not the full human-facing review package model.

### Base branch and worktree root assumptions

- The canonical source and integration branch comes from `dispatch.base_branch` in `kspec.config.yaml`.
- If `dispatch.base_branch` is unset, the dispatcher resolves a deterministic fallback and records it on the workspace at provisioning time so later invocations do not drift.
- The default dispatch worktree root is `.kspec-worktrees/` under the project root.
- `/tmp` is intentionally not the default because dispatch workspaces must survive daemon restarts and remain inspectable.
- Chain-of-work custom ancestry is out of scope here and belongs in the grouped-work plan.

### Git-safe reviewer model

- One canonical mutable task branch exists per task.
- That canonical branch may be checked out in at most one mutable worker worktree at a time.
- Reviewer isolation comes from a separate worktree materialized from the canonical branch head in detached or equivalent read-only mode.
- Fix-cycle work returns to the same canonical task branch lineage after review.
- The intended canonical branch format is `dispatch/task/<normalized-task-slug-or-task>/<short-task-ulid>`.

### Storage assumptions

The workspace registry should be a first-party kspec artifact persisted on the shadow branch, not daemon-only memory. It must carry enough identity to recover base branch, canonical branch, per-role worktrees, integration status, cleanup status, and bootstrap state after restart.

### Integration and merge assumptions

- Every task workspace records both its canonical task branch and its base or integration branch.
- Orientation and role-entry content must always name that target branch so agents know where PRs or manual merge-back should land.
- PR publication should target the recorded base branch when hosted tooling is available.
- Manual merge-back guidance is part of this plan only at the level of deterministic instructions and conflict escalation; fuller review approval and merge policy remains in the review-system plan.

### Bootstrap assumptions

Bootstrap should support:

- repository-level setup commands
- role-specific additions
- cached reuse with explicit invalidation rules
- bounded mutation rules so tracked source changes are never introduced accidentally by reviewer or bootstrap flows

### Scheduler contract

The intended deterministic order is:

1. candidate band (`in_progress`, then `needs_work`, then `pending_review`, then `pending`)
2. numeric priority
3. continuity or affinity preference
4. FIFO enqueue order

Fairness overrides continuity only when an equal-band, equal-priority candidate crosses the starvation threshold. It does not invert `P1` to `P5` ordering.

### Out of scope for this plan

- generic review record storage and line comments
- CI check records and approval policy
- grouped human-facing review packages across multiple tasks
- chain-of-work ancestry that intentionally forks work from something other than the configured base branch
