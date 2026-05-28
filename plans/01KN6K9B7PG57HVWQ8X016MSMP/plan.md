# Reviewer Workflow and Workflow UX Hardening

## Specs

```yaml
- title: Detached Reviewer Merge Path
  slug: detached-reviewer-merge-path
  type: feature
  parent: "@dispatch-branch-integration-contract"
  description: |
    Reviewers working from detached review snapshots need a supported way
    to complete manual_merge publication when the integration branch is
    already checked out in another worktree.

    The system should provide one clear, supported merge path for this
    situation instead of requiring reviewers to rediscover ad hoc git
    workarounds.
  acceptance_criteria:
    - id: ac-1
      given: |
        A review is approved in manual_merge publication mode
      when: |
        The reviewer is working from a detached review snapshot and the
        integration branch is already checked out in another worktree
      then: |
        The reviewer workflow provides an explicit merge path that does
        not require checking out the integration branch inside the
        detached snapshot
    - id: ac-2
      given: |
        The supported merge path encounters merge conflicts
      when: |
        The reviewer attempts the merge
      then: |
        The workflow tells the reviewer how to stop safely and return the
        work for follow-up without leaving the integration branch in an
        ambiguous state
    - id: ac-3
      given: |
        The reviewed change is already integrated at the target tip
      when: |
        The reviewer completes the review workflow
      then: |
        The workflow identifies the no-op merge case and lets the review
        complete without asking the reviewer to perform a redundant merge

- title: Detached Reviewer Workspace Integrity
  slug: detached-reviewer-workspace-integrity
  type: requirement
  parent: "@dispatch-workspace-orientation-prompt"
  description: |
    Detached reviewer handoff should point at a real, usable review
    workspace. Reviewer metadata and prompts should not send the reviewer
    to a nonexistent snapshot path when the actual reviewable worktree
    exists elsewhere.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reviewer invocation is prepared for a detached review snapshot
      when: |
        Workspace metadata is rendered into the reviewer handoff
      then: |
        The referenced workspace path exists and identifies the reviewable
        worktree the reviewer is expected to use
    - id: ac-2
      given: |
        Stored reviewer workspace metadata no longer points to an existing
        worktree path
      when: |
        A reviewer invocation is prepared
      then: |
        The system repairs or replaces the stale path before handoff, or
        fails with explicit recovery guidance instead of emitting a broken
        workspace path
    - id: ac-3
      given: |
        Reviewer workspace metadata and the canonical reviewable snapshot
        disagree
      when: |
        The reviewer handoff is generated
      then: |
        The handoff uses the canonical existing workspace path and does
        not require manual worktree discovery before review can begin

- title: Detached Reviewer CLI Readiness
  slug: detached-reviewer-cli-readiness
  type: requirement
  parent: "@dispatch-workspace-orientation-prompt"
  description: |
    Detached review snapshots should be ready for standard reviewer
    commands without local bootstrap work. Reviewers should not have to
    discover whether they need a built dist CLI, a PATH fix, or a source
    mode workaround before they can inspect, validate, or update review
    state.
  acceptance_criteria:
    - id: ac-1
      given: |
        A detached reviewer snapshot is provisioned
      when: |
        The reviewer runs standard kspec read commands such as task get,
        review get, or validate
      then: |
        The commands run successfully without requiring the reviewer to
        build the project or switch to an alternate CLI entrypoint first
    - id: ac-2
      given: |
        Reviewer workflow instructions are rendered for a detached review
        snapshot
      when: |
        The reviewer starts the review
      then: |
        The instructions use the supported kspec command path for that
        workspace and do not assume an unavailable executable on PATH
    - id: ac-3
      given: |
        A detached reviewer snapshot cannot satisfy CLI readiness
      when: |
        The reviewer invocation begins
      then: |
        The reviewer receives an explicit, deterministic recovery path
        instead of a generic command failure

- title: Review Thread Deduplication and Reuse
  slug: review-thread-deduplication-and-reuse
  type: feature
  parent: "@review-comment-threads-and-anchors"
  description: |
    Review records should avoid accumulating duplicate blocker threads for
    the same anchored issue. Repeated attempts to report the same finding
    should preserve a single review conversation whenever the issue is
    materially the same.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reviewer creates a blocker comment on an anchor that already has
        an unresolved blocker thread describing the same issue
      when: |
        The new comment is submitted
      then: |
        The system reuses or updates the existing thread instead of
        creating a second independent blocker thread for the same issue
    - id: ac-2
      given: |
        A reviewer creates a comment on the same anchor but it describes a
        distinct issue
      when: |
        The new comment is submitted
      then: |
        The system preserves it as a separate thread so distinct findings
        are still tracked independently
    - id: ac-3
      given: |
        A review contains reused and distinct threads on the same anchor
      when: |
        The review is displayed or its disposition is computed
      then: |
        Open issues remain visible without redundant blocker inflation and
        approval logic still reflects the true set of unresolved blockers

- title: Workflow Current Run Resolution
  slug: workflow-current-run-resolution
  type: feature
  parent: "@workflow-run-foundation"
  description: |
    Users following a workflow should have a clear, low-friction way to
    inspect the current run after starting it. The workflow UX should not
    depend on remembering a newly created run reference before the next
    command.
  traits:
    - trait-json-output
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        Exactly one active run exists for the current user context
      when: |
        the user asks to show the current workflow run without providing a
        run reference
      then: |
        the current active run is shown
    - id: ac-2
      given: |
        Multiple active workflow runs exist
      when: |
        the user asks to show the current workflow run without providing a
        run reference
      then: |
        the command does not guess; it explains that the run reference is
        ambiguous and tells the user how to choose one

- title: Workflow Run Guidance Alignment
  slug: workflow-run-guidance-alignment
  type: requirement
  parent: "@workflow-run-foundation"
  description: |
    Workflow skills, examples, and help text should match the supported
    commands for inspecting workflow runs so users are not taught a
    follow-up command path that the product does not support.
  acceptance_criteria:
    - id: ac-1
      given: |
        A workflow start example or skill shows the next step after
        creating a run
      when: |
        the guidance is presented to the user
      then: |
        the follow-up command matches supported workflow-run behavior
    - id: ac-2
      given: |
        Workflow-run behavior changes
      when: |
        shipped skills or help examples are updated
      then: |
        the user-visible guidance stays aligned with the implemented
        command path for inspecting the current run
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement detached reviewer merge path for manual_merge workflows
  slug: task-detached-reviewer-merge-path
  priority: 1
  tags:
    - dispatch
    - review
    - merge
  spec_ref: "@detached-reviewer-merge-path"
  description: |
    Update the reviewer merge workflow so detached review snapshots have a
    first-class, supported completion path in manual_merge mode.

    Covers:
    - @detached-reviewer-merge-path ac-1
    - @detached-reviewer-merge-path ac-2
    - @detached-reviewer-merge-path ac-3

    Scope:
    - Identify the canonical merge path the product should support when
      the integration branch is already checked out in another worktree.
    - Update the merge skill, rendered skill output, and any dispatch
      reviewer guidance that currently instructs reviewers to check out
      the integration branch inside the detached snapshot.
    - Cover no-op merge detection and conflict escalation so reviewers can
      finish or safely stop without improvising git mechanics.

    Verification:
    - Validate the updated guidance against the current detached-review
      workspace model.
    - Add tests for the selected merge path or for the command/guidance
      generator that produces reviewer instructions.

- title: Repair detached reviewer workspace metadata and prompt paths
  slug: task-detached-reviewer-workspace-integrity
  priority: 1
  tags:
    - dispatch
    - review
    - metadata
  spec_ref: "@detached-reviewer-workspace-integrity"
  description: |
    Ensure reviewer handoff metadata and prompts always reference a real,
    reviewable detached worktree path.

    Covers:
    - @detached-reviewer-workspace-integrity ac-1
    - @detached-reviewer-workspace-integrity ac-2
    - @detached-reviewer-workspace-integrity ac-3

    Scope:
    - Trace how reviewer snapshot paths are stored, refreshed, and emitted
      into dispatch prompts.
    - Detect and repair stale reviewer worktree paths before reviewer
      handoff.
    - Ensure the prompt and workspace metadata agree on the same existing
      reviewable worktree so reviewers do not need manual discovery.

    Verification:
    - Add tests for stale-path repair and prompt rendering with detached
      reviewer worktrees.

- title: Make detached reviewer snapshots CLI-ready
  slug: task-detached-reviewer-cli-readiness
  priority: 1
  tags:
    - dispatch
    - review
    - cli
  spec_ref: "@detached-reviewer-cli-readiness"
  description: |
    Ensure detached reviewer snapshots can run normal reviewer commands
    immediately, without manual build or PATH repair steps.

    Covers:
    - @detached-reviewer-cli-readiness ac-1
    - @detached-reviewer-cli-readiness ac-2
    - @detached-reviewer-cli-readiness ac-3

    Scope:
    - Decide the supported CLI entry path for detached reviewer workspaces.
    - Remove the current split between "works through daemon route" and
      "may fail directly in source mode" for reviewer-critical commands.
    - Update reviewer startup guidance so it points at the supported path
      and provides deterministic fallback behavior when readiness cannot
      be met automatically.

    Verification:
    - Add focused tests covering detached reviewer command execution.
    - Confirm task get, review get, and validate work in the provisioned
      reviewer environment.

- title: Prevent duplicate blocker threads for the same anchored issue
  slug: task-review-thread-deduplication
  priority: 2
  tags:
    - review
    - daemon
    - cli
  spec_ref: "@review-thread-deduplication-and-reuse"
  description: |
    Add deduplication or thread reuse behavior for repeated blocker
    findings on the same anchor when they represent the same issue.

    Covers:
    - @review-thread-deduplication-and-reuse ac-1
    - @review-thread-deduplication-and-reuse ac-2
    - @review-thread-deduplication-and-reuse ac-3

    Scope:
    - Define the matching rule for "same issue" so the system can reuse
      a thread without collapsing distinct findings.
    - Apply the rule consistently in the parser/API/CLI write path used to
      create review comments.
    - Preserve review disposition correctness and UI rendering clarity.

    Verification:
    - Add tests for duplicate blocker attempts, distinct blockers on one
      anchor, and disposition outcomes after reuse.

- title: Add current-run resolution for workflow show
  slug: task-workflow-current-run-resolution
  priority: 2
  tags:
    - workflow
    - cli
    - ux
  spec_ref: "@workflow-current-run-resolution"
  description: |
    Improve the workflow CLI so users can inspect the current active run
    without having to capture a fresh run ref from the previous command.

    Covers:
    - @workflow-current-run-resolution ac-1
    - @workflow-current-run-resolution ac-2

    Scope:
    - Add a supported current-run path for showing a workflow run when
      exactly one active run is in scope.
    - Preserve explicit-ref behavior and return a clear ambiguity error
      when multiple active runs exist.
    - Keep JSON and human-readable output aligned with existing workflow
      run display contracts.

    Verification:
    - Add CLI tests for the single-active-run, ambiguous, and explicit-ref
      paths.

- title: Align workflow skills and help text with workflow-run behavior
  slug: task-workflow-guidance-alignment
  priority: 3
  tags:
    - workflow
    - docs
    - skills
  spec_ref: "@workflow-run-guidance-alignment"
  depends_on:
    - "@task-workflow-current-run-resolution"
  description: |
    Update shipped workflow skills and examples so they match the actual
    supported workflow-run behavior.

    Covers:
    - @workflow-run-guidance-alignment ac-1
    - @workflow-run-guidance-alignment ac-2

    Scope:
    - Fix the reflect and create-workflow skill text that currently shows
      `kspec workflow show` without a run ref.
    - Regenerate rendered skill output after updating the source files.
    - Confirm help text and examples are consistent with the implemented
      current-run UX.

    Verification:
    - Run the required skill render step and validate the regenerated
      output.
```

## Implementation Notes

This plan addresses two adjacent clusters of friction that repeatedly
showed up in recent observations:

1. Reviewer handoff and review execution in detached-review workflows:
   merge mechanics, stale reviewer workspace metadata, and reviewer CLI
   readiness.
2. Workflow-run UX alignment: current-run inspection and the user-facing
   guidance that teaches that command path.

The broadened scope reflects that this is no longer only a reviewer-flow
cleanup plan. It now includes one small workflow UX track with explicit
separation between product behavior and docs/skills alignment.

The specs are intentionally behavioral. They describe the user-facing
contract we want the system to provide and leave implementation strategy
to the tasks.
