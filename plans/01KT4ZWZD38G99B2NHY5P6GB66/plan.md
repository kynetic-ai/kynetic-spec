# Shared Template Project-Neutrality Cleanup

## Summary

Shared kspec package templates currently mix universal kspec mechanics with self-hosting Kynetic project conventions. This plan makes the package-shipped agent sections and core skills portable for arbitrary kspec projects, relocates the Kynetic-specific instructions to local project context, and adds reviewer/convention guardrails so future edits to shared external guidance are checked semantically instead of relying on brittle markdown string tests.

The cleanup is staged because rendered agent instructions, package plugin skill copies, generated `.factory` skill copies, and tests may all depend on the existing wording. The plan intentionally does not add or update specs in this slice: project-neutral prose guidance is difficult to validate with stable AC-tagged tests, so the durable enforcement mechanism is project-local convention plus reviewer guidance. If leakage continues after this cleanup, a later hardening plan can add narrowly scoped linting for obvious forbidden tokens.

## Specs

```yaml
[]
```

## Tasks

derive_from_specs: false

```yaml
- title: Add shared-guidance neutrality convention and review guidance
  slug: task-add-shared-guidance-neutrality-review-gate
  priority: 1
  tags: [conventions, review, skills, agents]
  description: |
    What:
    - Add or update project-local convention/reviewer guidance for this
      self-hosting repository so changes to package-shipped external guidance are
      reviewed for project neutrality before approval.
    - The guidance must apply when a task or plan changes any of these shared or
      package-derived surfaces:
      - `templates/skills/`
      - `templates/agents-sections/`
      - `templates/skills/manifest.yaml`
      - `plugin/plugins/kspec/skills/`
      - rendered package/core skill outputs under `.agents/skills/` when their
        source is a package core skill rather than a project-local `.kspec/skills/`
        skill
      - rendered package/core skill outputs under `.factory/skills/` when they
        are generated from package core skill sources
      - generated `kspec-agents.md` sections that come from package templates
    - The convention/reviewer guidance must state the semantic review rule:
      package-shipped guidance describes universal kspec mechanics only;
      Kynetic self-hosting branch policy, repo paths, quality gates, generated
      artifact maintenance rules, dispatch workflow choices, agent ids, and
      external review policy belong in project-local context.
    - The guidance must require reviewers to check both directions:
      - shared/package text does not hard-code Kynetic-only policy as universal;
      - any still-needed Kynetic self-hosting instruction removed from shared
        text has a project-local home such as `AGENTS.md`, project-local
        `.kspec/skills/`, or project meta conventions.
    - Prefer a project-local kspec convention domain plus reviewer skill/checklist
      wording over new specs or AC-tagged tests. Attach the convention/checklist
      to the reviewer agents that review task work and plans in this repository,
      using `kspec agent list` and `kspec meta get` to identify the current agent
      ids before editing.
    - Do not add a broad markdown scanner or string-denylist test in this task.
      If implementation discovers an already-existing obvious-token lint, keep
      any changes narrow and non-semantic; do not present it as proof of prose
      neutrality.

    Why:
    Project-neutrality of prose is semantic and brittle to validate by scanning
    strings in markdown. Reviewers and agents can judge whether guidance is
    universal, while mechanical tests should stay focused on rendering,
    installation, and generated-artifact consistency.

    How:
    - Use kspec CLI/meta commands for project-local convention and agent metadata
      edits; do not manually edit `.kspec` YAML files.
    - Keep the guidance self-contained so a future reviewer has no chat history:
      define shared/package surfaces, allowed local homes, and examples of
      Kynetic-specific material that must not be framed as universal.
    - If a project-local reviewer skill is added or edited, render skills and
      regenerate agent instructions as needed so the guidance reaches reviewer
      agents.

    Testing:
    - `kspec agent list`
    - `kspec meta get <reviewer-agent-ref>` for the affected reviewer agents
    - `kspec validate --refs --warnings-ok`
    - If conventions, skills, or generated agent instructions change, run
      `kspec agents generate` and/or `kspec skill render` as appropriate and
      inspect the generated reviewer guidance.

    Covers: convention/reviewer-gate prerequisite only; no spec AC is claimed.

- title: Neutralize static agent-section templates
  slug: task-neutralize-agent-section-templates
  priority: 1
  tags: [agents, templates, docs]
  depends_on:
    - "@task-add-shared-guidance-neutrality-review-gate"
  description: |
    What:
    - Edit static agent-section templates so consumer projects receive only
      universal kspec mechanics.
    - Update `templates/agents-sections/01-quick-start.md` so "edit skill
      sources" guidance directs normal consumers to project-local `.kspec`
      skill/convention sources and supported kspec commands. Keep package
      `templates/skills/` and `templates/skills/manifest.yaml` guidance only in
      package-maintainer/self-hosting context.
    - Update `templates/agents-sections/02-shadow-branch.md` so it does not
      assume a branch named `main`, a GitHub PR workflow, or a universal main
      branch ignore policy. Describe shadow state as separate from the user's
      configured code/integration branch instead.
    - Update `templates/agents-sections/06-agent-dispatch-mode.md` so it refers
      to configured worker/reviewer agents from project meta data instead of
      fixed `task-worker`, `pr-reviewer`, or `kynetic.meta.yaml` names. Keep the
      dispatch mechanics that are truly part of kspec.
    - Remove or generalize the universal "Do NOT create GitHub PRs" wording so
      static guidance says dispatched work is reviewed through kspec review
      records, while external PR use is project/human policy.
    - Review the remaining files in `templates/agents-sections/` for similar
      leaks and neutralize any found by the semantic review guidance added in
      the prerequisite task.

    Why:
    Static sections are copied into generated agent instructions for every
    project. They should not make a new consumer believe their repository must
    have Kynetic's source tree, branch names, GitHub policy, or default agent ids.

    How:
    - Keep user-facing commands like `kspec init`, `kspec setup`,
      `kspec task submit`, and `kspec agent dispatch status` when they are
      universal kspec commands.
    - When guidance needs a variable value, point to project config, project
      meta, `kspec agent list`, or the generated dynamic data section.
    - Preserve Kynetic-specific source-maintenance guidance by moving it to the
      local context task in this plan rather than deleting it.

    Testing:
    - Run the project-defined focused tests for agent instruction generation,
      including `npm test -- --fresh tests/agents-instruction-gen.test.ts` unless
      the local context names a replacement gate.
    - `kspec agents generate` and inspect `kspec-agents.md` for neutral static
      wording and preserved local context.
    - Reviewer applies the shared-guidance neutrality convention to the changed
      static sections; do not rely on a broad string scan as the main evidence.

    Covers: package agent-section neutralization and local-preservation workflow;
    no spec AC is claimed.

- title: Neutralize worker, reviewer, and merge core skills
  slug: task-neutralize-work-review-merge-skills
  priority: 1
  tags: [skills, review, merge, testing]
  depends_on:
    - "@task-add-shared-guidance-neutrality-review-gate"
  description: |
    What:
    - Edit package core skills that guide task execution, review, and merge so
      they defer project-specific policy to project-local context.
    - In `templates/skills/task-work/SKILL.md`, replace hard-coded branch
      prefixes, `dev`/`main` examples, npm/oxlint/typecheck gates, and template
      source regeneration rules with project-defined branch, quality-gate, and
      source-maintenance guidance.
    - In `templates/skills/review/SKILL.md`, replace hard-coded npm/oxlint/
      typecheck/Vitest gates, GitHub PR analogies, and `src/parser/validate.ts`
      review-comment examples with project-defined quality gates and neutral
      file examples.
    - In `templates/skills/merge/SKILL.md`, keep kspec review/merge mechanics
      and dispatch publication-mode behavior, but remove assumptions about
      `dev`, `main`, GitHub PRs, or merge policy unless they are presented as
      examples controlled by project configuration.
    - Keep trait coverage and AC annotation mechanics when they describe kspec
      behavior; do not remove references to built-in trait specs from this
      repository's actual spec catalog.

    Why:
    Task workers and reviewers rely heavily on these core skills. Hard-coded
    TypeScript gates and branch/PR policy should remain available for Kynetic
    self-hosting work, but they should not ship as universal instructions for
    every kspec consumer.

    How:
    - Replace concrete commands with wording such as "run the project-defined
      format, lint, type, test, and validation gates named in project context".
    - Use neutral placeholders like `path/to/file.ext` for anchored review
      examples.
    - Make sure review approval still requires real evidence: project-defined
      gates, focused tests for changed behavior, AC coverage where specs exist,
      and unresolved blocker closure.

    Testing:
    - Run focused tests for skill rendering/status/diff if the rendered content
      or supporting files change.
    - Run `npm test -- --fresh tests/core-skill-install.test.ts` and
      `npm test -- --fresh tests/core-skill-update.test.ts` unless the local
      context names replacement focused gates.
    - Run any changed-file lint/test gates required by local Kynetic context.
    - Reviewer applies the shared-guidance neutrality convention to the changed
      core skills; do not rely on a broad string scan as the main evidence.

    Covers: package core-skill neutralization and reviewer-evidence workflow; no
    spec AC is claimed.

- title: Neutralize planning, writing, workflow, and triage skills
  slug: task-neutralize-planning-writing-triage-skills
  priority: 2
  tags: [skills, planning, triage, workflows]
  depends_on:
    - "@task-add-shared-guidance-neutrality-review-gate"
  description: |
    What:
    - Edit the remaining package core skills and supporting docs that encode
      self-hosting examples as universal instructions.
    - In `templates/skills/create-workflow/SKILL.md`, move package template
      authoring instructions (`templates/skills/<name>/SKILL.md`, manifest
      edits, manual commits to a branch) out of consumer workflow guidance.
      Normal consumers should create project-local workflows/skills through
      kspec project state or project-local skill sources.
    - In `templates/skills/plan/SKILL.md` and
      `templates/skills/writing-specs/SKILL.md`, keep kspec plan/spec writing
      principles while replacing implementation-domain examples such as
      `passport.js`, ACP/JSON-RPC/WebSocket/client-function examples, and
      concrete workflow refs when those refs are not guaranteed in every
      consumer project.
    - In `templates/skills/observe/SKILL.md`, `templates/skills/reflect/SKILL.md`,
      `templates/skills/triage-inbox/SKILL.md`, and
      `templates/skills/triage/docs/*.md`, replace PR-number examples,
      `AskUserQuestion`, and self-hosting CLI-feature examples with neutral
      examples or project-defined wording.
    - Review `templates/skills/manifest.yaml` for descriptions like "Task/PR
      review" and update them to neutral kspec review terminology.

    Why:
    These skills are less central than task-work/review, but they still ship to
    every project. They should teach reusable kspec practice without assuming the
    consumer has Kynetic's workflow catalog, trait catalog, source layout, or
    agent runtime tools.

    How:
    - For concrete trait refs, first verify whether each trait is present in the
      shipped/default catalog for every initialized project. If a trait is
      universal, describe it as a built-in kspec trait. If it is only
      self-hosting catalog content, replace the hard-coded ref with "run
      `kspec item list --type trait` and apply matching project traits".
    - For workflow refs, use "if this workflow exists in the project" wording
      unless the workflow is guaranteed by `kspec setup` for every consumer.
    - Keep examples short and neutral so the shared skill remains portable.

    Testing:
    - Run skill parser/render tests for changed skill files.
    - Run `kspec skill render` in this repository after source edits so rendered
      copies can be compared in the later artifact task.
    - Reviewer applies the shared-guidance neutrality convention to the changed
      planning/writing/workflow/triage skills; do not rely on a broad string scan
      as the main evidence.

    Covers: package core-skill neutralization and reviewer-evidence workflow; no
    spec AC is claimed.

- title: Preserve Kynetic self-hosting conventions in local context
  slug: task-preserve-kynetic-local-template-maintenance-context
  priority: 2
  tags: [local-context, skills, agents, self-hosting]
  depends_on:
    - "@task-neutralize-agent-section-templates"
    - "@task-neutralize-work-review-merge-skills"
    - "@task-neutralize-planning-writing-triage-skills"
  description: |
    What:
    - Add or update project-local context so Kynetic self-hosting agents still
      see the conventions removed from shared package templates.
    - Ensure `AGENTS.md` or another project-local agent context document covers:
      - package-maintainer source locations for `templates/skills/`,
        `templates/skills/manifest.yaml`, and `templates/agents-sections/`;
      - regeneration expectations for `kspec skill render`,
        `kspec agents generate`, generated plugin copies, and `.factory` copies;
      - Kynetic's local TypeScript/Node quality gates and any sharded test
        conventions that task workers and reviewers must use;
      - Kynetic's branch/review/dispatch expectations when they are local
        repository policy rather than package-universal behavior.
    - If a procedural checklist is too large for `AGENTS.md`, create or update a
      project-local skill under `.kspec/skills/` and attach it to the relevant
      Kynetic worker/reviewer agents through kspec meta commands.
    - Do not put consumer-neutral guidance back into local-only form; only move
      instructions that are genuinely specific to maintaining this repository or
      this repository's generated package artifacts.

    Why:
    Neutralizing shared templates should not weaken self-hosting execution. The
    removed project conventions still need a durable home that future Kynetic
    task workers and reviewers receive without chat history.

    How:
    - Prefer `AGENTS.md` for concise repository-wide facts and local skills for
      procedural checklists.
    - Use kspec CLI/meta commands for project-local skill registration when a
      local skill is added or changed.
    - Run `kspec skill render` when a project-local skill is added or changed,
      then regenerate `kspec-agents.md` after project-local context or meta
      changes.

    Testing:
    - `kspec agents generate`
    - Inspect generated `kspec-agents.md` for the self-hosting guidance via local
      context rather than static shared templates.
    - Reviewer verifies the local-preservation side of the shared-guidance
      neutrality convention: Kynetic-only guidance removed from shared text is
      still reachable from local project context.

    Covers: local self-hosting guidance preservation; no spec AC is claimed.

- title: Regenerate shared artifacts and update dependent tests
  slug: task-regenerate-shared-template-artifacts-and-tests
  priority: 3
  tags: [skills, agents, plugin, tests]
  depends_on:
    - "@task-preserve-kynetic-local-template-maintenance-context"
  description: |
    What:
    - Regenerate every repository artifact that is derived from the neutralized
      template sources.
    - Regenerate runtime skill output with `kspec skill render`.
    - Regenerate agent instructions with `kspec agents generate`.
    - Rebuild or refresh package plugin skill copies under
      `plugin/plugins/kspec/skills/` using the repository's plugin build path.
    - Refresh rendered core skill outputs under `.agents/skills/` when they are
      tracked/generated by the repository workflow.
    - Refresh `.factory/skills/` copies if they are generated from the same core
      skill sources in the current repository workflow.
    - Update tests that currently assert old leaked wording so they assert
      mechanical rendering/install/update behavior or project-defined guidance
      boundaries rather than a brittle list of forbidden markdown strings.
    - Do not add a broad scanner test or AC-tagged prose-neutrality test in this
      slice. If future regressions continue, capture that as follow-up hardening
      work for a narrow lint/convention-enforcement plan.

    Why:
    Source template edits are incomplete if generated/package copies still ship
    the old text. Tests that depended on the old wording must become mechanical
    render/install/update checks rather than brittle semantic-prose checks.

    How:
    - Use the repository's existing build scripts rather than hand-editing
      generated plugin or factory copies.
    - If a generated copy cannot be refreshed by an existing command, document
      that gap and add the minimal command or script update needed so future
      maintainers can regenerate it deterministically.
    - Keep generated-file diffs tied to their source-template changes in the
      same task branch.

    Testing:
    - `npm test -- --fresh tests/agents-instruction-gen.test.ts`
    - `npm test -- --fresh tests/core-skill-install.test.ts`
    - `npm test -- --fresh tests/core-skill-update.test.ts`
    - Focused skill render/update tests that cover core skill content.
    - Focused plugin-build test or script smoke proving plugin copies are current.
    - `kspec validate --refs --warnings-ok`
    - Reviewer applies the shared-guidance neutrality convention to the final
      generated/package artifacts.

    Covers: generated artifact refresh and mechanical test update workflow; no
    spec AC is claimed.

- title: Close shared-template neutrality cleanup
  slug: task-close-shared-template-neutrality-cleanup
  priority: 4
  tags: [validation, review, release]
  depends_on:
    - "@task-regenerate-shared-template-artifacts-and-tests"
  description: |
    What:
    - Run final validation for the full cleanup after all shared-source,
      local-context, generated-artifact, and test updates are complete.
    - Verify the reviewer/convention guidance exists and is attached to the
      relevant reviewers for future changes to package-shipped external guidance.
    - Verify package-shipped/shared guidance has been semantically reviewed as
      universal kspec mechanics, not Kynetic self-hosting policy.
    - Verify the Kynetic self-hosting context still exposes local template source,
      regeneration, quality-gate, branch/review, and plugin-build conventions.
    - Add release-note or documentation entries explaining that package core
      guidance is now project-neutral and self-hosting policy lives in local
      project context.
    - Do not change spec statuses or mark new specs implemented; this plan does
      not create or update specs.

    Why:
    This plan changes both shared package content and local self-hosting context.
    Closure needs to prove mechanical artifact consistency and reviewer-confirmed
    semantic neutrality, not just that a text scan is green.

    How:
    - Inspect the final diff for accidental removal of universal kspec mechanics.
    - Confirm any removed Kynetic-only instruction has a durable local home or is
      intentionally obsolete.
    - Record any desired future hardening as a follow-up inbox item or plan idea
      instead of adding scanner scope here.

    Testing:
    - `npm run format:check`
    - `npm run lint -- --quiet`
    - `npm run typecheck`
    - Relevant focused tests from prior tasks.
    - `kspec validate --refs --warnings-ok`
    - Final reviewer check using the shared-guidance neutrality convention.

    Covers: closure and reviewer-confirmed neutrality workflow; no spec AC is
    claimed.
```

## Implementation Notes

### Spec updates and removals

This plan intentionally proposes no new specs, no existing-spec updates, and no spec removals.

The neutrality problem is a semantic documentation/review problem rather than a stable runtime behavior. Broad markdown scanners or AC-tagged tests against prose would be brittle because wording changes frequently and semantically equivalent leaks can evade string checks. For now, enforcement belongs in project-local conventions and reviewer guidance. If future regressions show that review guidance is insufficient, create a separate hardening plan for narrowly scoped linting of obvious forbidden tokens.

### Leak classes reviewers must check

The initial audit identified these leak classes in shared guidance. They are review heuristics, not a request to build a broad scanner in this plan:

- Source-layout and package-maintainer paths presented as consumer instructions, including `templates/skills/`, `templates/skills/manifest.yaml`, `templates/agents-sections/`, and `src/parser/validate.ts` examples.
- Branch and external-review policy presented as universal, including `main`, `dev`, GitHub PR examples, and `PR #...` resolution examples.
- Toolchain gates presented as universal, including npm format/lint/typecheck commands, oxlint changed-file checks, and Vitest-specific checks.
- Fixed self-hosting agent/meta names presented as universal, including `task-worker`, `pr-reviewer`, and `kynetic.meta.yaml`.
- Runtime-specific tool names presented as universal skill guidance, including `AskUserQuestion`.
- Concrete workflow refs or trait refs presented as guaranteed in every consumer project when they are not actually seeded for every project.

### Dependency ordering

The convention/reviewer-guidance task comes first so every later cleanup task has the semantic gate it should satisfy. Agent-section cleanup and skill cleanup can proceed independently after that gate exists, but each cleanup task should keep notes about the exact local-only guidance it removes so the local-context task can preserve it without relying on chat history. Local Kynetic context is preserved after shared sources are neutralized so moved instructions have an obvious home. Generated artifacts and tests are refreshed only after both source and local-context edits are complete. Closure verifies reviewer-guidance attachment, mechanical gates, semantic review of shared guidance, and local self-hosting continuity.
