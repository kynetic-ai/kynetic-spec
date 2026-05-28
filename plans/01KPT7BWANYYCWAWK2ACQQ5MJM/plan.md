# Portable Skill File References and Detached Reviewer Merge Foundation

## Specs

```yaml
- title: Portable Skill Supporting File References
  slug: portable-skill-supporting-file-references
  type: requirement
  parent: "@agent-integration"
  description: |
    Skill-authored content can reference supporting files that live beside a
    skill, such as scripts, reference documents, assets, and legacy docs,
    using one portable authoring form. Rendered skill output and adapter
    prompt delivery both resolve that portable form to the platform-specific,
    project-root-relative path of the rendered supporting file copy for the
    active skill runtime.

    The contract covers both direct skill markdown and markdown files copied
    from the skill's supporting directories. It rejects missing or out-of-
    boundary references so agents do not receive broken helper links.
  acceptance_criteria:
    - id: ac-rendered-supporting-link-resolution
      given: |
        A skill markdown file or copied markdown supporting file contains a
        portable reference to a supporting file within the same skill
      when: |
        The skill is rendered for a specific platform
      then: |
        The rendered content points to the platform-specific, project-root-
        relative path of that rendered supporting file copy
    - id: ac-prompt-supporting-link-resolution
      given: |
        An agent definition injects a skill whose markdown contains a portable
        supporting-file reference
      when: |
        The invocation prompt is built for a specific adapter
      then: |
        The prompt contains the adapter-appropriate, project-root-relative
        path for that supporting file instead of the unresolved portable form
    - id: ac-missing-supporting-target-rejected
      given: |
        A portable supporting-file reference points to a file that does not
        exist in the source skill
      when: |
        The skill is validated, rendered, or injected into a prompt
      then: |
        The operation fails with explicit guidance naming the unresolved file
        reference instead of silently producing a broken path
    - id: ac-supporting-reference-boundary
      given: |
        A portable supporting-file reference attempts to escape the skill's
        own directory tree
      when: |
        The skill is validated, rendered, or injected into a prompt
      then: |
        The operation is rejected and no escaped path is emitted

- title: Detached Reviewer Merge Helper
  slug: detached-reviewer-merge-helper
  type: feature
  parent: "@dispatch-branch-integration-contract"
  description: |
    In manual_merge publication mode, reviewers working from detached review
    snapshots have one supported merge helper path for completing review after
    approval. The helper is distributed with the merge skill, is invokable
    from the detached review workspace, and performs the standard clean merge
    mechanics without requiring the reviewer to rediscover ad hoc git
    workarounds.

    The helper keeps the integration branch authoritative while preventing the
    stale checked-out integration worktree state that occurs when the branch
    ref advances without the occupied worktree being refreshed.
  acceptance_criteria:
    - id: ac-helper-path-in-reviewer-guidance
      given: |
        A reviewer invocation is prepared in manual_merge publication mode
      when: |
        Reviewer workflow guidance is rendered for a detached review snapshot
      then: |
        The reviewer is directed to a single supported merge helper path and
        is not instructed to check out the integration branch manually inside
        the detached snapshot
    - id: ac-occupied-target-clean-refresh
      given: |
        The integration target branch is already checked out in another clean
        worktree and the reviewer helper performs a successful merge
      when: |
        The helper completes
      then: |
        The integration target ref advances to the merged commit and the
        occupied target worktree is refreshed so its files and index match the
        new target tip
    - id: ac-helper-no-op-merge
      given: |
        The reviewed canonical branch head is already integrated at the
        integration target tip
      when: |
        The reviewer runs the supported merge helper
      then: |
        The helper reports a no-op merge outcome and exits successfully
        without moving refs or dirtying any worktree
    - id: ac-helper-refuses-dirty-target
      given: |
        The integration target branch is checked out in another worktree that
        contains tracked modifications or staged drift
      when: |
        The reviewer runs the supported merge helper
      then: |
        The helper refuses to advance the integration target and returns
        explicit recovery guidance instead of overwriting the occupied
        worktree state
    - id: ac-helper-safe-conflict-exit
      given: |
        The supported merge helper encounters merge conflicts while preparing
        the reviewed change for integration
      when: |
        The helper stops
      then: |
        The integration target ref remains unchanged and the reviewer receives
        explicit conflict-handling guidance without leaving the occupied
        integration worktree in an ambiguous state
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement portable skill supporting-file reference resolution
  slug: task-portable-skill-supporting-file-references
  priority: 1
  tags: [skills, rendering, prompts]
  spec_ref: "@portable-skill-supporting-file-references"
  description: |
    Implement the portable reference rewrite path for skill supporting files
    across skill rendering and adapter prompt injection.

    Why: A script-backed merge helper is only usable if skill-authored content
    can point at the right rendered script path for whichever platform or
    adapter is consuming the skill. Today only {skill:...} alias references
    are rewritten; supporting-file paths are not.

    What:
    - Define one portable supporting-file reference form for skill-authored
      markdown and copied markdown supporting files.
    - Extend the existing skill reference rewrite pipeline so render-time
      markdown output and prompt-injected skill content both rewrite that
      form to the active platform or adapter path.
    - Add validation that rejects unresolved supporting-file references and
      any reference that escapes the skill's own directory tree.
    - Preserve existing {skill:...} alias rewriting behavior.

    How: Reuse the current skill render and prompt rewrite infrastructure
    instead of creating a parallel substitution system. Keep the reference
    rewrite deterministic from the source skill id, supporting directory,
    and active render root so helper links remain stable across rerenders.

    Testing:
    - Render-time coverage for at least codex and claude-code outputs.
    - Prompt-build coverage proving adapter-injected skill content gets the
      same resolved supporting-file path.
    - Validation coverage for missing targets and boundary-escape attempts.

    Covers:
    - @portable-skill-supporting-file-references ac-rendered-supporting-link-resolution
    - @portable-skill-supporting-file-references ac-prompt-supporting-link-resolution
    - @portable-skill-supporting-file-references ac-missing-supporting-target-rejected
    - @portable-skill-supporting-file-references ac-supporting-reference-boundary

- title: Implement detached reviewer merge helper mechanics
  slug: task-detached-reviewer-merge-helper
  priority: 1
  tags: [dispatch, review, merge]
  spec_ref: "@detached-reviewer-merge-helper"
  description: |
    Add the supported detached-review merge helper as a merge-skill script and
    implement the standard clean merge mechanics it relies on.

    Why: Reviewers are intentionally placed in detached snapshots, but current
    manual_merge guidance still leaves them improvising merge choreography when
    the integration branch is already occupied elsewhere. The helper needs to
    encode the one sanctioned path.

    What:
    - Add a merge helper script under the merge skill's supporting files.
    - Define the helper's required dispatch environment contract using the
      existing dispatch metadata environment variables.
    - Implement the clean merge path for a detached reviewer snapshot,
      including occupied-target detection, no-op merge detection, successful
      target ref advancement, and post-merge occupied-worktree refresh.
    - Refuse to proceed when the occupied target worktree has tracked
      modifications or staged drift.
    - Ensure merge conflicts stop without advancing the integration target ref.

    How: Keep the reviewer as merge owner, but make the helper responsible for
    the git mechanics and post-merge integrity checks. Do not rely on manual
    `git update-ref` use outside the helper.

    Testing:
    - Detached reviewer merge into an occupied clean integration target.
    - Already-integrated no-op merge.
    - Dirty occupied integration target refusal.
    - Conflict exit with unchanged target ref.
    - Post-success verification that the occupied integration worktree's files
      and index match the new integration target tip.

    Covers:
    - @detached-reviewer-merge-helper ac-occupied-target-clean-refresh
    - @detached-reviewer-merge-helper ac-helper-no-op-merge
    - @detached-reviewer-merge-helper ac-helper-refuses-dirty-target
    - @detached-reviewer-merge-helper ac-helper-safe-conflict-exit

- title: Wire reviewer guidance and merge skill usage to the detached merge helper
  slug: task-detached-reviewer-merge-guidance
  priority: 1
  tags: [dispatch, review, skills, docs]
  spec_ref: "@detached-reviewer-merge-helper"
  depends_on:
    - "@task-portable-skill-supporting-file-references"
    - "@task-detached-reviewer-merge-helper"
  description: |
    Update reviewer-facing guidance so manual_merge reviewer sessions use the
    supported helper path consistently.

    Why: Even with a good helper script, agents will continue inventing git
    workarounds unless reviewer prompts, merge-skill instructions, and default
    reviewer descriptions all converge on the same supported path.

    What:
    - Update manual_merge reviewer publication guidance in dispatch prompt
      construction to direct reviewers to the supported helper path.
    - Update the merge skill source to explain detached reviewer context,
      helper invocation, no-op handling, dirty-target refusal, and conflict
      escalation.
    - Update shipped docs and default reviewer descriptions that currently say
      reviewers perform local merge without qualifying the detached workspace
      model.
    - Regenerate rendered skill output and agent instructions.

    How: Use the new portable supporting-file reference mechanism for the
    helper path so the merge skill stays portable across codex and
    claude-code render roots.

    Testing:
    - Prompt-generation coverage for manual_merge reviewer guidance.
    - Rendered merge skill output contains the supported helper path for each
      platform.
    - Docs/default-agent assertions cover the updated reviewer wording.

    Covers:
    - @detached-reviewer-merge-helper ac-helper-path-in-reviewer-guidance
```

## Implementation Notes

This plan intentionally couples two changes that would be awkward to ship
separately:

1. A detached-reviewer merge helper only becomes durable if the merge skill can
   reference its script path portably across rendered skill roots and prompt
   injection.
2. Portable supporting-file references are highest-value when exercised by a
   real, user-facing workflow immediately; the detached-reviewer merge helper is
   that workflow.

### Dependency order
- Task 1 establishes the portable supporting-file reference contract and its
  validation boundary.
- Task 2 adds the helper script and the merge mechanics it needs; it is kept
  independent from Task 1 so the helper's git behavior can be implemented and
  reviewed on its own.
- Task 3 depends on both earlier tasks, updates every reviewer-facing
  instruction surface to use the helper path, and regenerates rendered output.

### Scope boundaries
- Keep reviewer-owned merging; do not redesign publication ownership.
- Do not add a brand-new dispatch publication mode.
- Do not broaden the helper into a generic human-facing merge CLI yet; this is
  specifically the detached reviewer manual_merge path.
- Do not weaken existing shared-checkout safety checks. The helper should reuse
  or align with those protections, not bypass them.

### Key design constraints
- Supporting-file reference rewriting must work in both rendered skill files and
  prompt-injected skill content, because dispatch invocations build prompts from
  source skill content while agents often act on rendered files inside the
  workspace.
- Missing or escaping supporting-file references should fail deterministically;
  broken links are worse than explicit validation failures because they defer the
  problem to runtime agent improvisation.
- Successful detached-review merges must leave any occupied integration target
  worktree aligned with the new target tip. Avoiding stale checked-out target
  state is the load-bearing regression guard for this plan.
