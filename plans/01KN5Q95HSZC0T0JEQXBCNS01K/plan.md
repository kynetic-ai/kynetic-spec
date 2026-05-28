# Plan-Scoped Branch Targeting

## Specs

```yaml
- title: Plan Branch Association
  slug: plan-branch-association
  type: requirement
  parent: "@plan-support"
  description: |
    Plans support an optional branch field that stores a git branch
    name. The field is nullable, persists across sessions, and is
    backward-compatible with existing plans that predate the feature.
  acceptance_criteria:
    - id: ac-field-default
      given: |
        A plan is created without specifying a branch
      when: |
        The plan is loaded
      then: |
        The branch field is null
    - id: ac-field-set
      given: |
        A user sets a plan's branch to a valid branch name
      when: |
        The plan is loaded in a subsequent session
      then: |
        The branch field contains the value that was set
    - id: ac-field-clear
      given: |
        A user clears a plan's branch
      when: |
        The plan is loaded
      then: |
        The branch field is null
    - id: ac-existing-plans-unaffected
      given: |
        Plans created before this feature exist without a branch
        field in their stored YAML
      when: |
        Those plans are loaded
      then: |
        They parse successfully with branch defaulting to null

- title: Plan Branch Creation
  slug: plan-branch-creation
  type: requirement
  parent: "@plan-support"
  traits:
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
    - "@trait-shadow-commit"
  description: |
    A dedicated command creates or resumes a branch for a plan
    using a deterministic naming convention, paralleling task
    branch creation.
  acceptance_criteria:
    - id: ac-deterministic-name
      given: |
        A plan has no branch set
      when: |
        The plan branch command is run without a custom name
      then: |
        A branch is created using the naming convention
        plan/<normalized-slug>/<short-ref>
    - id: ac-forks-from-base
      given: |
        A plan has no branch set
      when: |
        The plan branch command creates a new branch
      then: |
        The branch forks from the current HEAD of the project's
        configured integration branch
    - id: ac-updates-plan-record
      given: |
        The plan branch command creates or resumes a branch
      when: |
        The command completes
      then: |
        The plan's branch field is updated to the resolved branch
        name
    - id: ac-resume-local
      given: |
        A plan already has a branch set and the branch exists
        locally
      when: |
        The plan branch command runs
      then: |
        The existing branch is checked out without creating a
        duplicate
    - id: ac-rehydrate-remote
      given: |
        A plan has a branch set but the branch only exists on a
        remote
      when: |
        The plan branch command runs
      then: |
        The branch is fetched from the remote and checked out
        locally
    - id: ac-custom-name
      given: |
        A user provides an explicit branch name argument
      when: |
        The plan branch command runs
      then: |
        The specified name is used instead of the deterministic
        default
    - id: ac-reports-result
      given: |
        The plan branch command completes
      when: |
        Output is displayed
      then: |
        The output includes the branch name and the action taken
        (created, switched, or rehydrated)

- title: Plan Branch as Dispatch Integration Target
  slug: plan-branch-dispatch-target
  type: requirement
  parent: "@dispatch-workspace-configuration"
  description: |
    When the dispatch engine provisions a workspace for a task that
    belongs to a plan with an associated branch, the plan branch is
    used as the task's integration target instead of the project's
    default integration branch.
  acceptance_criteria:
    - id: ac-plan-branch-priority
      given: |
        A task references a plan that has a branch set
      when: |
        The dispatcher provisions a workspace for that task
      then: |
        The task's base branch is the plan's branch
    - id: ac-integration-target
      given: |
        A task references a plan that has a branch set
      when: |
        The task's workspace integration record is created
      then: |
        The integration target branch is the plan's branch
    - id: ac-no-plan-ref-passthrough
      given: |
        A task has no plan reference
      when: |
        The dispatcher provisions a workspace
      then: |
        The base branch is resolved using the existing fallback
        chain with no change in behavior
    - id: ac-null-branch-passthrough
      given: |
        A task references a plan whose branch is null
      when: |
        The dispatcher provisions a workspace
      then: |
        The base branch is resolved using the existing fallback
        chain with no change in behavior
    - id: ac-plan-branch-not-found
      given: |
        A task references a plan whose branch does not exist
        locally or on any configured remote
      when: |
        The dispatcher provisions a workspace
      then: |
        Workspace provisioning fails with an error identifying the
        missing plan branch and the plan it belongs to
    - id: ac-stale-target-detected
      given: |
        A task has an existing workspace targeting the default
        integration branch and its plan subsequently gains a branch
      when: |
        The workspace is re-provisioned
      then: |
        The mismatch between the workspace's current integration
        target and the plan's branch is detected
    - id: ac-stale-target-updated
      given: |
        A stale integration target mismatch is detected for a task
        whose plan now has a branch
      when: |
        The workspace record is reconciled
      then: |
        The workspace record's integration target is updated to
        the plan's branch

- title: Plan Branch Derive Guidance
  slug: plan-branch-derive-guidance
  type: requirement
  parent: "@plan-support"
  description: |
    The plan derive command surfaces branch awareness so users know
    when and how to use plan branches for task stacking.
  acceptance_criteria:
    - id: ac-derive-hint
      given: |
        A plan is transitioning to active status via the derive
        command and has no branch set
      when: |
        The derive output is displayed
      then: |
        The output includes guidance that a plan branch can be
        created to enable task stacking
    - id: ac-derive-existing
      given: |
        A plan already has a branch set before activation
      when: |
        The plan transitions to active via derive
      then: |
        The output confirms that derived tasks will target the
        plan branch
```

## Tasks

derive_from_specs: false

```yaml
- title: Add branch field to plan schema and CLI
  slug: task-plan-branch-schema
  priority: 1
  tags: [schema, plans, cli]
  spec_ref: "@plan-branch-association"
  description: |
    Add an optional nullable branch field to the plan data model and
    expose it via the plan CLI.

    Why: The branch field is the data foundation — every other task
    in this plan depends on plans being able to store a branch name.
    Without it, the dispatch engine has nothing to look up.

    What:
    - Add branch as an optional nullable string to the plan schema
      (src/schema/plan.ts), following the same pattern as plan_ref
      on tasks — z.string().nullable().optional()
    - Update the plan save logic (src/parser/plans.ts) to preserve
      the branch field through load/save round-trips. The existing
      save logic only writes non-default fields, so branch: null
      should not appear in YAML output for plans that don't use it.
    - Add --branch flag to kspec plan set so users can manually set
      or clear the branch. Clearing should accept null or empty
      string to unset. Follow the pattern of --plan-ref on task set.
    - Add branch to plan get output (both human-readable and JSON).
    - Verify that existing plans without the field parse correctly
      by running the test suite — the optional() + nullable() pattern
      should handle this, but confirm no fixture breakage.

    How: The schema change is in src/schema/plan.ts PlanSchema. The
    CLI change is in src/cli/commands/plan.ts under the set
    subcommand. Save/load is in src/parser/plans.ts. Check the
    existing task set --plan-ref implementation for the exact
    nullable string flag pattern to replicate.

    Testing: Unit tests for schema round-trip (null, set, clear).
    CLI test for plan set --branch and plan get showing the value.

    Covers: @plan-branch-association ac-field-default, ac-field-set,
    ac-field-clear, ac-existing-plans-unaffected.

- title: Implement kspec plan branch command
  slug: task-plan-branch-command
  priority: 1
  tags: [cli, plans, git]
  spec_ref: "@plan-branch-creation"
  depends_on:
    - "@task-plan-branch-schema"
  description: |
    Create the kspec plan branch subcommand that creates or resumes
    a deterministic branch for a plan, then updates the plan's branch
    field.

    Why: Plans need a dedicated command to create their branch, just
    like kspec task branch exists for tasks. The deterministic naming
    convention (plan/<slug>/<short-ref>) makes branches predictable
    and avoids naming collisions.

    What:
    - Add a plan branch <ref> subcommand to src/cli/commands/plan.ts.
    - Accept an optional --name <branch-name> flag that overrides the
      deterministic naming with a custom branch name.
    - Deterministic name computation: normalize the plan's first slug
      to lowercase alphanumeric with hyphens, take the first 8 chars
      of the plan ULID as short-ref, produce plan/<slug>/<short-ref>.
      Reuse the normalization logic from computeDispatchBranchName()
      in src/cli/commands/task.ts (the normalizeSlug and shortId
      helpers).
    - Branch resolution priority (same as kspec task branch):
      1. Check if branch exists locally — if current, report
         already_on_branch; if not current, checkout and report
         switched.
      2. Check remotes — if found, fetch and create local tracking
         branch, report rehydrated.
      3. Create new — fork from HEAD of the project's configured
         dispatch.base_branch (resolve using the same logic as
         resolveDispatchWorkspaceConfig in workspace.ts, or simpler:
         read kspec.config.yaml dispatch.base_branch, fall back to
         default branch detection). Report created.
    - After branch resolution, update the plan's branch field via
      mutatePlanAtomically() (src/parser/plans.ts) so the shadow
      branch records the association.
    - Output: branch name, action (created/switched/rehydrated),
      confirmation that plan record was updated. Support --json flag
      for structured output.
    - Reuse the existing branch helper functions from task.ts:
      findBranchOnRemote(), gitCreateBranchFrom(),
      reportBranchResult(). These may need to be extracted to a
      shared module if they're currently private to the task command.
    - The command mutates shadow branch state (plan record update),
      so it must auto-commit per trait-shadow-commit.
    - Errors (invalid ref, git failures) must include recovery
      guidance per trait-error-guidance.
    - Exit codes must follow trait-semantic-exit-codes.

    How: Model the command implementation after the task branch
    command (src/cli/commands/task.ts lines ~3034-3108). The main
    difference is: (a) resolves a plan ref instead of a task ref,
    (b) uses plan/<slug>/<short-ref> instead of
    dispatch/task/<slug>/<short-ref>, (c) updates the plan record
    instead of being purely git-side.

    Testing: Unit tests for deterministic name computation. CLI
    integration tests for create, resume, and rehydrate flows. Test
    custom --name flag. Verify plan record updated after each flow.
    Verify JSON output mode. Verify error messages include guidance.

    Covers: @plan-branch-creation ac-deterministic-name,
    ac-forks-from-base, ac-updates-plan-record, ac-resume-local,
    ac-rehydrate-remote, ac-custom-name, ac-reports-result.

- title: Wire plan branch into dispatch workspace provisioning
  slug: task-dispatch-plan-branch-resolution
  priority: 1
  tags: [dispatch, workspace, plans]
  spec_ref: "@plan-branch-dispatch-target"
  depends_on:
    - "@task-plan-branch-schema"
  description: |
    Modify the dispatch workspace provisioning pipeline to resolve a
    task's base branch from its plan's branch field before falling
    back to the global dispatch.base_branch.

    Why: This is the core runtime behavior — when a plan has a
    branch, all its derived tasks should automatically target that
    branch. Without this, users would have to manually configure
    each task's base branch.

    What:
    - In resolveDispatchWorkspaceConfig() (src/agent-runtime/
      workspace.ts, around line 1887), add a plan branch resolution
      step as the FIRST check in the base branch fallback chain,
      before the dispatch.base_branch config check.
    - The resolution logic:
      1. Load the task being provisioned.
      2. If task.plan_ref is set, load the referenced plan via
         findPlanByRef() (from src/parser/plans.ts).
      3. If plan.branch is non-null, validate the branch exists
         (locally or via remote fetch) and use it as the resolved
         base branch.
      4. If plan.branch is non-null but the branch cannot be found
         locally or on any remote, fail workspace provisioning with
         a clear error identifying the missing branch and the plan
         it belongs to. Do NOT fall through to the default base.
      5. If plan.branch is null, or task.plan_ref is not set, fall
         through to the existing resolution chain (config file →
         remote HEAD → current branch → "main" default).
    - For stale integration target detection
      (resolveStaleIntegrationTarget, workspace.ts ~line 708): this
      extends the existing detection in @dispatch-workspace-configuration
      ac-6 which handles config-level base_branch changes. Plan branch
      changes are an additional source of target staleness — when a
      plan gains a branch, existing workspaces targeting the old
      default base become stale. The detection logic should check
      plan branch first (since it takes priority), then fall through
      to the existing config-change detection. The update behavior
      is the same: update the workspace record's integration target.
    - No changes needed to worktree creation, branch provenance,
      integration records, or the merge skill — they all operate on
      the resolved base branch which this task changes at the source.

    How: The insertion point is narrow. resolveDispatchWorkspaceConfig
    returns a config object with baseBranch. Add the plan lookup
    before the existing if-blocks. findPlanByRef() is synchronous
    (loads from YAML). Branch existence validation uses the same
    helpers already in workspace.ts. The KSPEC_DISPATCH_MERGE_TARGET
    env var and integration.target_branch are set from the resolved
    base branch downstream — no changes needed there.

    Edge cases to handle:
    - Plan exists but has status completed/rejected — still honor
      the branch field (tasks may still be in progress).
    - Plan ref is invalid/not found — log warning, fall through to
      default resolution (the plan may have been deleted).
    - Plan branch was deleted — fail with clear error per
      ac-plan-branch-not-found.

    Testing: Unit tests for each resolution path: plan with branch,
    plan without branch, no plan_ref, missing plan (warning + fall
    through), missing branch (error). Integration test for stale
    target detection when plan gains a branch. Verify stale detection
    composes with existing config-change detection.

    Covers: @plan-branch-dispatch-target ac-plan-branch-priority,
    ac-integration-target, ac-no-plan-ref-passthrough,
    ac-null-branch-passthrough, ac-plan-branch-not-found,
    ac-stale-target-detected, ac-stale-target-updated.

- title: Add plan branch guidance to derive output
  slug: task-plan-branch-activation
  priority: 2
  tags: [cli, plans]
  spec_ref: "@plan-branch-derive-guidance"
  depends_on:
    - "@task-plan-branch-schema"
  description: |
    When a plan transitions to active via the derive command, include
    contextual guidance about plan branches in the output.

    Why: The derive step is the natural moment users think about how
    tasks will be dispatched. Surfacing the plan branch option here
    prevents the "I didn't know I could do that" problem.

    What:
    - In the plan derive command (src/cli/commands/plan.ts), after
      the derive summary output, add a conditional message:
      - If plan.branch is null: print a hint like
        "Tip: Run kspec plan branch @<ref> to create a shared
        branch for task stacking. Without it, tasks target the
        default integration branch."
      - If plan.branch is set: print a confirmation like
        "Tasks will target plan branch: <branch-name>"
    - The guidance should appear after the derived specs/tasks
      summary, not before.
    - In --json mode, include plan_branch in the output object
      (null or the branch name) so programmatic consumers can
      inspect it.

    How: Find the derive command output section in
    src/cli/commands/plan.ts (search for the derive subcommand
    handler). Add the conditional after the success summary. Read
    plan.branch from the plan record that's already loaded in the
    derive flow.

    Testing: CLI test that derive without branch shows the hint.
    CLI test that derive with branch shows the confirmation.
    JSON output test for plan_branch field.

    Covers: @plan-branch-derive-guidance ac-derive-hint,
    ac-derive-existing.
```

## Implementation Notes

This plan adds plan-scoped branch targeting as opt-in behavior.
Plans without a branch behave identically to today — no migration,
no breaking changes.

Design decisions:
1. The branch field is both the flag and the value — no separate
   mode enum. If set, tasks target it. If null, passthrough.
2. Deterministic naming: plan/<slug>/<short-ref>, parallel to
   dispatch/task/<slug>/<short-ref> for tasks.
3. Custom branch names supported via --name flag.
4. No base_branch_point stored on plans — task workspaces track
   their own fork points, and git computes merge-base on demand.
5. Merging the plan branch to the project integration branch is a
   manual step for now. A future plan merge command could automate
   this but is out of scope.
6. The dispatch insertion point is narrow: one new check at the top
   of the base branch resolution chain. Everything downstream
   operates on the resolved base branch and needs no changes.
7. Plan branch stale target detection composes with the existing
   config-change detection in @dispatch-workspace-configuration ac-6.
   Plan branch takes priority (checked first); config-change
   detection is the fallback for non-plan tasks.
8. When a plan branch cannot be found, provisioning fails with an
   error rather than silently falling through to the default base.
   This prevents tasks from accidentally landing on the wrong branch.

Trait coverage:
- @plan-branch-association inherits traits from parent @plan-support
  (json-output, semantic-exit-codes, error-guidance, shadow-commit,
  filterable-list, priority-parameter, dry-run) via existing plan
  set/get commands.
- @plan-branch-creation declares its own traits (json-output,
  semantic-exit-codes, error-guidance, shadow-commit) since it is a
  new standalone command.
- @plan-branch-dispatch-target and @plan-branch-derive-guidance are
  internal behavioral specs with no direct CLI surface requiring
  additional traits.
