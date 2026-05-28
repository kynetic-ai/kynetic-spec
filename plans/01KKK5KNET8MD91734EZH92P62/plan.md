# Dispatch Branch Adoption and Deterministic Task Branches

This plan addresses a structural gap in the dispatch system: today reviewer and
fix-cycle continuity only work reliably when a task already has a dispatcher-
managed workspace record or when work happened on the deterministic
`dispatch/task/*` branch lineage from the start.

That leaves manual or externally-created task branches in an awkward state.
Review can be queued from task status alone, but if the local dispatch checkout
does not already have a matching workspace record, the dispatcher has almost no
portable state it can use to recover the branch-of-record. The system then
either falls back to a synthetic dispatch branch or discards the work as
missing, both of which break review and `needs_work` continuity.

This plan combines two layers:

- a durable runtime fix so dispatch can adopt and resume existing non-dispatch
  branch lineages safely
- a preventive workflow layer so humans and agents have an easy deterministic
  branch helper for manual work that stays dispatch-compatible by default

## Context

Today the runtime assumes that `canonical_branch` means both:

- the branch lineage that reviewer and fix-cycle work should resume
- a dispatcher-owned branch that can be normalized, created, and deleted

That coupling is the root problem. It prevents dispatch from treating an
existing manual branch as a stable adopted canonical branch, because metadata
recovery and cleanup semantics are designed around dispatcher-owned
`dispatch/task/*` refs.

The investigation also showed that current task-level branch state is too weak
to bootstrap recovery across checkouts:

- `review_url` is useful context but not enough to recover a branch reliably
- `vcs_refs` exists but is not structured enough for branch ownership, remote
  location, or branch-of-record semantics
- free-form notes are not machine-readable

The runtime already has a better place for durable operational truth:
`project.dispatch-workspaces.yaml`. The missing piece is a portable task-side
submission link that lets a fresh dispatch checkout discover which branch should
be adopted into that registry.

## Scope

This plan should cover:

- portable task submission linkage for review and fix-cycle recovery
- repair or backfill of submission linkage after branch renames, PR-head swaps,
  or older submissions that predate linkage capture
- adoption of existing non-dispatch task branches as the canonical dispatch
  lineage for a task
- registry provenance and cleanup semantics for adopted vs dispatcher-managed
  branches
- reviewer and `needs_work` recovery before queue entries are discarded as
  missing
- a deterministic task-branch helper and documented branch convention for human
  and agent workflows
- tests that exercise adopted/manual branches and do not depend on old fallback
  behavior

This plan should not yet cover:

- full provider-specific PR synchronization or a GitHub-native branch/PR model
- replacing dispatcher-managed `dispatch/task/*` branches as the preferred
  branch shape for automation
- alternate helper naming aliases or a second deterministic branch namespace;
  this plan standardizes on the exact dispatch-compatible branch format for the
  helper path
- broad task-state redesign beyond the submission linkage needed for dispatch
  recovery

## Specs

```yaml
- title: Portable Task Submission Linkage
  slug: portable-task-submission-linkage
  type: requirement
  parent: "@task-submit"
  description: |
    Task submission stores structured branch linkage that another checkout can
    use to recover the submitted code lineage for review and follow-up work.
    This linkage is portable bootstrap state, not local worktree metadata.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A task is submitted from a named branch
      when: |
        `kspec task submit` runs
      then: |
        The task stores structured submission linkage that includes the branch
        name, the current HEAD commit, and remote or upstream locator data when
        available, alongside any provided review URL
    - id: ac-2
      given: |
        A task has stored submission linkage
      when: |
        The task is shown via `task get` or `--json`
      then: |
        The linkage is available as machine-readable task state rather than
        only as prose in notes or prompts
    - id: ac-3
      given: |
        A task is submitted without a recoverable named branch context, such as
        detached HEAD or otherwise unresolved branch identity
      when: |
        Submission linkage is captured
      then: |
        The command records the best available revision identity and returns
        guidance that dispatch review continuity may require an explicit branch
        before adoption can occur
    - id: ac-4
      given: |
        A submitted task's branch linkage is missing or stale because the
        branch was renamed, the PR head changed, or the task predates linkage
        capture
      when: |
        An explicit repair or backfill flow updates the task's submission
        linkage
      then: |
        The linkage can be corrected without resetting task status or losing
        review and fix-cycle history

- title: Adopt Existing Task Branch Lineage for Review and Fix Cycles
  slug: adopt-existing-task-branch-lineage
  type: requirement
  parent: "@canonical-task-workspace-contract"
  description: |
    When review or follow-up work begins without an existing local dispatch
    workspace, dispatch can adopt a previously-submitted branch lineage instead
    of synthesizing a new dispatcher-owned branch and diverging from the code
    already under review.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A task in `pending_review` or `needs_work` has no active dispatch
        workspace record but does have recoverable submission linkage
      when: |
        The dispatcher provisions workspace state
      then: |
        It adopts that existing branch lineage as the task's canonical branch
        for reviewer and fix-cycle continuity instead of creating a fresh
        `dispatch/task/*` branch from the base branch
    - id: ac-2
      given: |
        The adopted branch is not present locally in the dispatch checkout but
        its remote or review locator is known
      when: |
        The dispatcher prepares reviewer or fix-cycle work
      then: |
        It rehydrates the local adopted branch from the recorded locator before
        reviewer or worker eligibility is discarded
    - id: ac-3
      given: |
        A task transitions from review to `needs_work` after an adopted branch
        lineage has been established
      when: |
        The follow-up worker invocation is prepared
      then: |
        The worker resumes the same adopted canonical branch lineage instead of
        forking a new branch for the fix cycle
    - id: ac-4
      given: |
        A task in `pending_review` or `needs_work` has no existing workspace
        record and no recoverable submission lineage
      when: |
        Dispatch attempts to prepare the workspace
      then: |
        The task is blocked or marked with explicit recovery guidance rather
        than silently provisioning a fresh branch that does not contain the
        submitted work under review

- title: Branch Provenance in Dispatch Workspace Registry
  slug: branch-provenance-in-dispatch-workspace-registry
  type: requirement
  parent: "@dispatch-workspace-registry"
  description: |
    Dispatch workspace records capture whether the canonical branch is
    dispatcher-managed or adopted, plus the locator and ownership semantics
    needed to rehydrate and preserve that lineage correctly across restarts and
    reconciliation.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A workspace record is persisted for a task
      when: |
        The canonical branch is dispatcher-managed or adopted from existing
        task state
      then: |
        The record stores branch provenance and locator data sufficient to
        distinguish ownership, remote recovery source, and cleanup semantics
    - id: ac-2
      given: |
        A metadata-backed workspace is reconstructed or reconciled
      when: |
        The canonical branch was previously adopted from a non-dispatch branch
      then: |
        Recovery preserves that adopted canonical branch identity instead of
        normalizing it back to the deterministic `dispatch/task/*` namespace
    - id: ac-3
      given: |
        Existing dispatcher-managed workspace records created before provenance
        tracking existed
      when: |
        They are read after the migration
      then: |
        They default to dispatcher-managed ownership semantics without breaking
        current dispatch continuity

- title: Adopted Branch Cleanup and Recoverability
  slug: adopted-branch-cleanup-and-recoverability
  type: requirement
  parent: "@dispatch-workspace-cleanup-policy"
  description: |
    Cleanup and health reconciliation treat adopted/manual branches differently
    from dispatcher-owned branches so dispatch can preserve externally-owned
    refs while still cleaning local worktrees and surfacing actionable recovery
    states.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        Cleanup runs for a workspace whose canonical branch was adopted from a
        manual or externally-created branch
      when: |
        The workspace becomes cleanup-eligible
      then: |
        Dispatch removes local worker and reviewer worktrees plus runtime
        metadata as appropriate, but preserves the adopted branch ref unless an
        explicit policy says the branch is dispatcher-owned
    - id: ac-2
      given: |
        Cleanup runs for a workspace whose canonical branch is
        dispatcher-managed
      when: |
        Cleanup safety checks pass
      then: |
        Dispatch may still delete the dispatcher-owned branch using the current
        cleanup lifecycle
    - id: ac-3
      given: |
        Reconciliation evaluates a non-healthy workspace
      when: |
        The canonical branch is missing locally, the remote locator is known,
        or only the reviewer snapshot is missing
      then: |
        Health state distinguishes recoverable adopted-branch rehydration,
        missing dispatcher-managed canonical branch, and missing reviewer
        snapshot as separate recovery paths with specific guidance
    - id: ac-4
      given: |
        Dispatch created or fetched a local branch ref only to rehydrate an
        adopted externally-owned branch into the local checkout
      when: |
        Cleanup runs after the workspace closes
      then: |
        Cleanup policy distinguishes the external source branch from the local
        dispatch-side mirror ref so local rehydration state can be removed
        without deleting or mutating the externally-owned branch lineage

- title: Review and Fix-Cycle Workspace Discovery Before Discard
  slug: review-and-fix-cycle-workspace-discovery-before-discard
  type: requirement
  parent: "@agent-dispatch-engine"
  description: |
    Queue pruning for `pending_review` and `needs_work` performs workspace
    discovery and recovery before treating a task as missing or ineligible, so
    dispatch can recover work that already exists outside the local checkout.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A queued `pending_review` or `needs_work` dispatch entry has no healthy
        local workspace candidate
      when: |
        Queue eligibility is evaluated
      then: |
        Dispatch first attempts recovery from registry state, metadata-backed
        worktrees, recorded task submission linkage, and remote or review
        locators before discarding the queue entry as missing
    - id: ac-2
      given: |
        One of those recovery paths succeeds
      when: |
        Eligibility is re-evaluated
      then: |
        The queue entry remains eligible and normal provisioning proceeds on the
        recovered or adopted canonical branch lineage
    - id: ac-3
      given: |
        No trustworthy recovery path exists for the review or fix-cycle task
      when: |
        Dispatch cannot reconstruct a branch-of-record
      then: |
        The engine emits explicit task-linked diagnostics and recovery guidance
        rather than silently pruning the work as stale or synthesizing a fresh
        unrelated branch
    - id: ac-4
      given: |
        Multiple branch signals exist, such as existing registry state,
        explicitly repaired task linkage, captured submission linkage, and
        remote or review-derived discovery
      when: |
        Dispatch resolves the branch-of-record for review or fix-cycle work
      then: |
        It applies explicit precedence in that order and blocks with
        diagnostics rather than guessing when the competing signals cannot be
        reconciled safely

- title: Deterministic Task Branch Helper
  slug: deterministic-task-branch-helper
  type: requirement
  parent: "@task-commands"
  description: |
    kspec provides a first-party helper for humans and agents to create or
    resume a deterministic task branch that remains dispatch-compatible by
    default, reducing branch-identity ambiguity for manual work.
  traits:
    - trait-json-output
    - trait-semantic-exit-codes
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A user or agent wants to begin manual work on a task
      when: |
        The deterministic task-branch helper runs for that task
      then: |
        It creates or resumes the exact dispatch-compatible deterministic branch
        derived from the task's slug and short ref using the documented
        `dispatch/task/<normalized-task-slug>/<short-task-ref>` naming contract
    - id: ac-2
      given: |
        The deterministic branch already exists locally or remotely
      when: |
        The helper runs again
      then: |
        It reuses or rehydrates that same branch lineage instead of creating a
        duplicate branch for the task
    - id: ac-3
      given: |
        The helper reports its result
      when: |
        Output is shown in human or JSON mode
      then: |
        It includes the resolved branch name and explains that using the helper
        preserves dispatch reviewer and fix-cycle continuity for manual work
```

## Tasks

derive_from_specs: true

```yaml
- title: Update branching conventions and agent docs for dispatch-compatible task branches
  slug: update-branching-conventions-and-agent-docs-for-dispatch-compatible-task-branches
  priority: 1
  tags:
    - docs
    - dispatch
    - agents

- title: Add regression coverage for adopted manual branches and fallback-independent dispatch review
  slug: add-regression-coverage-for-adopted-manual-branches-and-fallback-independent-dispatch-review
  priority: 1
  tags:
    - test
    - dispatch
    - reliability
```

## Implementation Notes

Treat this as a staged capability, not a one-shot branch-discovery patch.

Preferred state model:

- task state holds portable submission linkage that another checkout can use to
  discover the submitted code lineage
- dispatch workspace registry remains the runtime source of truth once a branch
  is adopted or provisioned

Important behavioral boundary:

- `task.ready` or fresh automation work may still synthesize deterministic
  dispatcher-owned branches when appropriate
- `pending_review` and `needs_work` must not silently synthesize a fresh branch
  when the submitted work is missing; those states require recovery or explicit
  blockage because code already exists somewhere and the wrong branch would
  corrupt review continuity

Branch-of-record precedence should be explicit in the plan and later specs:

- existing dispatch workspace registry state
- explicitly repaired or backfilled task submission linkage
- captured task submission linkage from submit time
- remote or review-derived discovery
- otherwise block with guidance for `pending_review` and `needs_work`

The deterministic helper and documentation layer should be treated as defense
in depth. It reduces incidence for manual work, but the runtime still needs to
adopt and preserve already-existing non-dispatch branches reliably. In this
plan, the helper standardizes on the exact dispatch-compatible branch format
rather than introducing a second alias or mapping layer.

The documentation/convention work should update the dynamic conventions and any
rendered agent instructions or skill output if their sources change. The helper
command should explain both the naming contract and why dispatch continuity
depends on it.
