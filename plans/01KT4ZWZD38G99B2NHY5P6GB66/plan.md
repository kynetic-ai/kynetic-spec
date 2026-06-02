# Shared Template Project-Neutrality Cleanup

## Summary

Shared kspec package templates currently mix universal kspec mechanics with self-hosting Kynetic project conventions. This plan makes the package-shipped agent sections and core skills portable for arbitrary kspec projects, relocates the Kynetic-specific instructions to local project context, and adds regression coverage so future template edits do not reintroduce project-specific leakage.

The cleanup is staged because rendered agent instructions, package plugin skill copies, generated `.factory` skill copies, and tests may all depend on the existing wording. The plan also tightens the existing specs that currently describe package agent templates and core skill installation without stating the project-neutrality boundary.

## Specs

```yaml
- title: Shared Package Guidance Neutrality
  slug: shared-package-guidance-neutrality
  type: requirement
  parent: "@agent-integration"
  description: |
    Guidance that ships in kspec's package templates is portable across
    consumer projects. Package core skills and static agent sections describe
    kspec mechanics, while project-specific branch policy, review policy,
    quality gates, source paths, agent ids, and toolchain choices come from
    project-local context.
  acceptance_criteria:
    - id: ac-core-guidance-uses-project-inputs
      given: |
        A package core skill or static agent template explains branch policy,
        quality gates, source layout, agent ids, or external review integration
      when: |
        The guidance is installed, rendered, or read in a consuming project
      then: |
        The guidance identifies the value as project-defined instead of
        hard-coding the Kynetic self-hosting repository's value
    - id: ac-static-agent-sections-are-universal
      given: |
        A kspec project whose repository layout differs from the Kynetic
        self-hosting repository generates agent instructions
      when: |
        An agent reads the static template sections in the generated output
      then: |
        The static sections remain applicable without the project having the
        Kynetic source tree or branch names
    - id: ac-project-specific-guidance-has-local-home
      given: |
        The Kynetic self-hosting repository needs instructions for maintaining
        package template sources, TypeScript gates, generated plugin copies,
        or its own dispatch agent conventions
      when: |
        Those instructions are removed from package-shipped shared guidance
      then: |
        Equivalent Kynetic-specific instructions are available from project-local
        agent context or project-local skills
    - id: ac-rendered-copies-match-neutral-sources
      given: |
        Package plugin skills, rendered runtime skills, and generated agent
        instructions are rebuilt from source templates
      when: |
        The generated artifacts are inspected
      then: |
        The artifacts contain the same project-neutral guidance as their source
        templates

- title: Shared Template Portability Guardrails
  slug: shared-template-portability-guardrails
  type: requirement
  parent: "@agent-integration"
  description: |
    The repository provides repeatable checks that distinguish universal kspec
    mechanics from Kynetic self-hosting conventions in package-shipped guidance.
    The checks report non-universal terms in shared template artifacts while
    allowing those same terms in approved project-local context.
  acceptance_criteria:
    - id: ac-leak-scan-reports-offenders
      given: |
        Package-shipped template sources and generated package/runtime copies
        are scanned for non-universal conventions
      when: |
        a non-allowlisted self-hosting source path, branch policy, quality gate,
        fixed agent id, runtime-specific tool name, or external review reference
        appears in shared guidance
      then: |
        the check reports the file path and offending phrase
    - id: ac-consumer-setup-omits-self-hosting-defaults
      given: |
        A temporary consumer project with project-local settings that differ
        from the Kynetic self-hosting repository runs kspec setup or core skill
        installation
      when: |
        generated instructions and installed skills are read from that project
      then: |
        the output does not introduce Kynetic source paths, fixed Kynetic branch
        names, Kynetic quality-gate commands, or fixed self-hosting agent ids
    - id: ac-self-hosting-gates-remain-visible-locally
      given: |
        The Kynetic self-hosting repository generates or reads its own agent
        context after the shared templates are neutralized
      when: |
        a worker or reviewer looks for repository-specific test, lint, render,
        branch, and plugin-build expectations
      then: |
        those expectations are visible through local project context instead of
        package-shipped shared guidance
```

## Tasks

derive_from_specs: false

```yaml
- title: Tighten existing specs for the shared-template boundary
  slug: task-tighten-shared-template-boundary-specs
  priority: 1
  tags: [spec-update, skills, agents]
  spec_ref: "@shared-package-guidance-neutrality"
  description: |
    What:
    - Update existing specs before editing template content so the contract
      being changed is explicit and reviewable.
    - Reopen these implemented specs without cascading before editing them:
      - `kspec item set @agent-templates --status in_progress --no-cascade`
      - `kspec item set @core-skill-install --status in_progress --no-cascade`
      - `kspec item set @core-skill-update --status in_progress --no-cascade`
    - Update `@agent-templates` description to this final wording:

      Static markdown templates ship with kspec in `templates/agents-sections/`.
      They cover package-universal kspec mechanics such as project setup,
      shadow state, task lifecycle, review lifecycle, commit conventions,
      dispatch mechanics, and batch usage. Project-specific facts such as
      branch names, external review systems, source-tree paths, toolchain gates,
      configured agent ids, and local workflow policy come from project config,
      project meta data, or project-local documentation rather than static
      package templates.

    - Update `@agent-templates` AC `ac-2` to this final text:

      Given: Package template files for the current kspec release exist in
      `templates/agents-sections/`.
      When: The template files are assembled into `kspec-agents.md`.
      Then: Every package template section appears in the generated output with
      project-specific facts supplied by dynamic project data or local project
      documentation.

    - Add this AC to `@agent-templates`:

      AC id: ac-static-sections-project-neutral
      Given: A consuming project has branch names, source layout, agent ids,
      external review practices, and quality gates that differ from the Kynetic
      self-hosting repository.
      When: `kspec agents generate` emits static template sections for that
      project.
      Then: The static section text remains applicable because it describes
      kspec mechanics rather than Kynetic self-hosting conventions.

    - Add this AC to `@agent-templates`:

      AC id: ac-package-source-guidance-scoped
      Given: Generated agent instructions describe where skill or agent-section
      sources live.
      When: The instructions are read in a consumer project.
      Then: Package template paths are presented only as package-maintainer
      inputs, while project-local skill and convention changes point to kspec
      project state and supported kspec commands.

    - Add this AC to `@core-skill-install`:

      AC id: ac-installed-core-skills-project-neutral
      Given: `kspec skill install-core` copies package core skills into a
      project.
      When: an agent reads the installed core skill content.
      Then: The installed core skill content describes project-agnostic kspec
      mechanics and obtains project-specific branches, quality gates, source
      paths, agent ids, and external review policy from project-local context.

    - Add this AC to `@core-skill-update`:

      AC id: ac-updated-core-skills-project-neutral
      Given: `kspec skill update` refreshes package core skills in a project.
      When: an agent reads the refreshed core skill content.
      Then: The refreshed core skill content describes project-agnostic kspec
      mechanics and obtains project-specific branches, quality gates, source
      paths, agent ids, and external review policy from project-local context.

    - Add notes to the touched specs naming this plan and explaining that no
      existing spec item is removed in this slice. The existing `@agent-templates`
      spec remains, but its PR-workflow-era wording is generalized to the current
      work/review lifecycle. If implementation later finds a separate spec that
      only describes self-hosting process rather than kspec behavior, stop and
      report it instead of deleting it inside this task.

    Why:
    The existing specs prove static sections are included and core skills are
    copied, but they do not state the consumer-portability boundary. Tightening
    the contract first prevents later template edits from being treated as mere
    wording cleanup.

    How:
    - Use `kspec item get` before editing each target spec.
    - Use `kspec item set --description`, `kspec item ac set`, and
      `kspec item ac add` with the final text above.
    - Keep each touched spec `in_progress`; implementation and tests later in
      this plan provide the evidence for returning them to `implemented`.

    Testing:
    - `kspec item get @agent-templates`
    - `kspec item get @core-skill-install`
    - `kspec item get @core-skill-update`
    - `kspec validate --refs --warnings-ok`

    Covers: @shared-package-guidance-neutrality ac-core-guidance-uses-project-inputs, ac-static-agent-sections-are-universal

- title: Add a shared-template portability audit
  slug: task-shared-template-portability-audit
  priority: 1
  tags: [tests, skills, agents, audit]
  spec_ref: "@shared-template-portability-guardrails"
  depends_on:
    - "@task-tighten-shared-template-boundary-specs"
  description: |
    What:
    - Add a repeatable audit script or test helper that scans shared guidance
      sources and generated/shared copies for known project-specific leakage.
    - Include at least these shared source and generated roots in the scan:
      - `templates/skills/`
      - `templates/agents-sections/`
      - `plugin/plugins/kspec/skills/`
      - rendered core skill outputs under `.agents/skills/` whose source is a
        package core skill, not a project-local `.kspec/skills/` skill
      - rendered core skill outputs under `.factory/skills/` whose source is a
        package core skill, not a project-local `.kspec/skills/` skill
      - generated `kspec-agents.md` when it is present in the repository
    - Make the audit origin-aware so it can distinguish package-shipped/shared
      guidance from project-local rendered guidance. A rendered local skill that
      originates from `.kspec/skills/*` is outside the shared-leak scan unless
      its content is copied into a package-shipped artifact.
    - Flag non-allowlisted instances of these leak classes:
      - self-hosting source paths such as `src/parser/validate.ts`,
        `templates/skills/<name>/SKILL.md`, and
        `templates/agents-sections/` when presented as consumer instructions;
      - fixed branch or external review policy such as `main`, `dev`, GitHub
        PRs, or `PR #...` when presented as universal process;
      - Kynetic-specific quality gates such as `npm run format:check`,
        `npm run lint`, `npm run typecheck`, `npx oxlint`, or Vitest-specific
        checks when presented as universal gates;
      - fixed self-hosting agent ids or meta file names such as `task-worker`,
        `pr-reviewer`, and `kynetic.meta.yaml` when presented as universal;
      - runtime-specific helper names such as `AskUserQuestion` in shared skill
        prose.
    - Support an explicit allowlist for legitimate package-maintainer or code
      references so the check can distinguish "this package source path exists"
      from "every consumer should edit this source path".
    - Add the scanner and focused scanner unit tests to a concrete normal-test
      target, preferably `tests/shared-template-portability.test.ts`, so the
      scanner behavior is protected immediately without making the normal suite
      fail on the current known leaks.
    - Keep the repository-wide shared-guidance scan as a manual diagnostic or
      expected-offender baseline in this task. Do not wire the current-repo scan
      as a required passing test until the later neutralization/regeneration
      task has made the shared guidance clean.

    Why:
    A manual audit found the current leaks, but without a repeatable guard the
    shared templates can regress the next time a self-hosting task patches a
    core skill.

    How:
    - Prefer a data-driven phrase/class allowlist over a broad regex-only test.
    - Keep the scanner output actionable: each failure should include file path,
      matched phrase, and leak class.
    - Do not ban these terms from `AGENTS.md`, `.kspec/` project-local skills,
      rendered local skill copies whose source is `.kspec/skills/*`, docs that
      explicitly discuss maintaining this repository, or source code comments
      that are not rendered as shared guidance.

    Testing:
    - Run the new repository-wide scan manually or through its expected-offender
      baseline and verify it identifies the current leaks before the template
      neutralization tasks are complete.
    - Add focused tests for at least one allowed package-maintainer reference,
      one allowed project-local rendered skill reference, and one blocked
      universal-guidance leak.

    Covers: @shared-template-portability-guardrails ac-leak-scan-reports-offenders

- title: Neutralize static agent-section templates
  slug: task-neutralize-agent-section-templates
  priority: 1
  tags: [agents, templates, docs]
  spec_ref: "@shared-package-guidance-neutrality"
  depends_on:
    - "@task-shared-template-portability-audit"
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
      leaks and neutralize any found by the audit.

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
    - Run the portability audit from `@task-shared-template-portability-audit`.
    - `npm test -- --fresh tests/agents-instruction-gen.test.ts`
    - `kspec agents generate` and inspect `kspec-agents.md` for neutral wording.

    Covers: @shared-package-guidance-neutrality ac-static-agent-sections-are-universal; @agent-templates ac-static-sections-project-neutral, ac-package-source-guidance-scoped; @shared-template-portability-guardrails ac-consumer-setup-omits-self-hosting-defaults

- title: Neutralize worker, reviewer, and merge core skills
  slug: task-neutralize-work-review-merge-skills
  priority: 1
  tags: [skills, review, merge, testing]
  spec_ref: "@shared-package-guidance-neutrality"
  depends_on:
    - "@task-shared-template-portability-audit"
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
      gates, focused tests for changed behavior, AC coverage, and unresolved
      blocker closure.

    Testing:
    - Run the portability audit.
    - Run focused tests for skill rendering/status/diff if the rendered content
      or supporting files change.
    - Run `npm test -- --fresh tests/core-skill-install.test.ts` after the
      core-skill source edits so install/update behavior is checked against the
      new neutrality contract.
    - Run any changed-file lint/test gates required by local Kynetic context.

    Covers: @shared-package-guidance-neutrality ac-core-guidance-uses-project-inputs; @core-skill-install ac-installed-core-skills-project-neutral; @core-skill-update ac-updated-core-skills-project-neutral; @shared-template-portability-guardrails ac-consumer-setup-omits-self-hosting-defaults

- title: Neutralize planning, writing, workflow, and triage skills
  slug: task-neutralize-planning-writing-triage-skills
  priority: 2
  tags: [skills, planning, triage, workflows]
  spec_ref: "@shared-package-guidance-neutrality"
  depends_on:
    - "@task-shared-template-portability-audit"
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
    - Run the portability audit.
    - Run skill parser/render tests for changed skill files.
    - Run `kspec skill render` in this repository after source edits so rendered
      copies can be compared in the later artifact task.

    Covers: @shared-package-guidance-neutrality ac-core-guidance-uses-project-inputs; @shared-template-portability-guardrails ac-leak-scan-reports-offenders

- title: Preserve Kynetic self-hosting conventions in local context
  slug: task-preserve-kynetic-local-template-maintenance-context
  priority: 2
  tags: [local-context, skills, agents, self-hosting]
  spec_ref: "@shared-package-guidance-neutrality"
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
    - Run the portability audit and verify local-only files are either outside
      scope or explicitly allowlisted by source origin.

    Covers: @shared-package-guidance-neutrality ac-project-specific-guidance-has-local-home; @shared-template-portability-guardrails ac-self-hosting-gates-remain-visible-locally

- title: Regenerate shared artifacts and update dependent tests
  slug: task-regenerate-shared-template-artifacts-and-tests
  priority: 3
  tags: [skills, agents, plugin, tests]
  spec_ref: "@shared-package-guidance-neutrality"
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
    - Update tests that currently assert old leaked wording so they assert the
      new project-neutral contract instead.
    - Add at least one consumer-project fixture or temp-project test proving
      setup/install/generate output does not introduce Kynetic source paths,
      fixed Kynetic branch names, Kynetic quality gates, or fixed self-hosting
      agent ids.
    - After the shared guidance is clean, enable the repository-wide
      shared-guidance scan from `@task-shared-template-portability-audit` as a
      required passing normal test and remove any temporary expected-offender
      baseline for resolved leaks.

    Why:
    Source template edits are incomplete if generated/package copies still ship
    the old text. Tests that depended on the old wording must become portability
    tests rather than blockers for neutralization.

    How:
    - Use the repository's existing build scripts rather than hand-editing
      generated plugin or factory copies.
    - If a generated copy cannot be refreshed by an existing command, document
      that gap and add the minimal command or script update needed so future
      maintainers can regenerate it deterministically.
    - Keep generated-file diffs tied to their source-template changes in the
      same task branch.

    Testing:
    - Portability audit passes.
    - `npm test -- --fresh tests/agents-instruction-gen.test.ts`
    - `npm test -- --fresh tests/core-skill-install.test.ts`
    - `npm test -- --fresh tests/core-skill-update.test.ts`
    - Focused skill render/update tests that cover core skill content.
    - Focused plugin-build test or script smoke proving plugin copies are current.
    - `kspec validate --refs --warnings-ok`

    Covers: @shared-package-guidance-neutrality ac-rendered-copies-match-neutral-sources; @core-skill-install ac-installed-core-skills-project-neutral; @core-skill-update ac-updated-core-skills-project-neutral; @shared-template-portability-guardrails ac-consumer-setup-omits-self-hosting-defaults

- title: Close portability cleanup and restore spec statuses
  slug: task-close-shared-template-portability-cleanup
  priority: 4
  tags: [validation, specs, release]
  spec_ref: "@shared-template-portability-guardrails"
  depends_on:
    - "@task-regenerate-shared-template-artifacts-and-tests"
  description: |
    What:
    - Run final validation for the full cleanup and restore spec statuses only
      after implementation evidence exists.
    - Verify the portability audit passes across all scanned shared guidance
      roots and generated copies.
    - Verify the Kynetic self-hosting context still exposes local template source,
      regeneration, quality-gate, branch/review, and plugin-build conventions.
    - Set the touched existing specs back to `implemented` only after the
      corresponding tests and generated artifact checks pass:
      - `kspec item set @agent-templates --status implemented --no-cascade`
      - `kspec item set @core-skill-install --status implemented --no-cascade`
      - `kspec item set @core-skill-update --status implemented --no-cascade`
    - Mark the new plan-derived specs implemented only after their ACs have
      direct test or inspection evidence.
    - Add release-note or documentation entries explaining that package core
      guidance is now project-neutral and self-hosting policy lives in local
      project context.

    Why:
    This plan changes both shared package content and local self-hosting context.
    Closure needs to prove consumer portability and self-hosting continuity, not
    just that a text scan is green.

    How:
    - Inspect the final diff for accidental removal of universal kspec mechanics.
    - Verify no spec item was removed. If implementation discovered a truly
      self-hosting-only existing spec, report it for a separate reviewed plan
      rather than deleting it here.
    - Keep audit allowlist entries narrow and explain each one in comments.

    Testing:
    - Portability audit passes.
    - `npm run format:check`
    - `npm run lint -- --quiet`
    - `npm run typecheck`
    - Relevant focused tests from prior tasks.
    - `kspec validate --refs --warnings-ok`

    Covers: @shared-template-portability-guardrails ac-leak-scan-reports-offenders, ac-consumer-setup-omits-self-hosting-defaults, ac-self-hosting-gates-remain-visible-locally; @shared-package-guidance-neutrality ac-rendered-copies-match-neutral-sources
```

## Implementation Notes

### Spec updates and removals

This plan proposes updating existing specs rather than removing them:

- Update `@agent-templates` because its current description and `ac-2` still frame static agent sections around older fixed topics such as PR workflow. The spec should remain because static agent-section generation is a real package behavior.
- Update `@core-skill-install` and `@core-skill-update` because they own the behavior that copies or refreshes package core skill content into consumer projects. The new ACs make content neutrality part of the installation/update contract.
- Do not remove any existing spec in this slice. If implementation finds a spec whose only purpose is to encode self-hosting repository policy, the worker must stop and report it for a separate reviewed spec-retirement plan.

### Leak classes the implementation must address

The initial audit identified these leak classes in shared guidance:

- Source-layout and package-maintainer paths presented as consumer instructions, including `templates/skills/`, `templates/skills/manifest.yaml`, `templates/agents-sections/`, and `src/parser/validate.ts` examples.
- Branch and external-review policy presented as universal, including `main`, `dev`, GitHub PR examples, and `PR #...` resolution examples.
- Toolchain gates presented as universal, including npm format/lint/typecheck commands, oxlint changed-file checks, and Vitest-specific checks.
- Fixed self-hosting agent/meta names presented as universal, including `task-worker`, `pr-reviewer`, and `kynetic.meta.yaml`.
- Runtime-specific tool names presented as universal skill guidance, including `AskUserQuestion`.
- Concrete workflow refs or trait refs presented as guaranteed in every consumer project when they are not actually seeded for every project.

### Dependency ordering

The spec update task comes first so the contract is explicit. The audit task comes before template cleanup so workers can see failures turn green. Agent-section cleanup and skill cleanup can proceed independently after the audit exists, but each cleanup task should keep notes about the exact local-only guidance it removes so the local-context task can preserve it without relying on chat history. Local Kynetic context is preserved after shared sources are neutralized so moved instructions have an obvious home and can be origin-allowlisted by the audit. Generated artifacts and tests are refreshed only after both source and local-context edits are complete. Closure restores spec statuses only after all evidence exists.
