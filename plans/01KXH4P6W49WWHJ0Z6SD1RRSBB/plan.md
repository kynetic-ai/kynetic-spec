# Documentation Completeness and Dispatch Workspaces

**Goal:** Correct and complete Kynetic Spec's active public documentation, with a source-bound dispatch/bootstrap/workspace operator story and a deterministic whole-public-surface audit.

**Architecture:** This is a documentation correction plan, not a dispatch product-expansion plan. It documents behavior present on the integrated target branch, names explicit limitations or unavailable/experimental surfaces, adds one configuration guide, one workspace concept page, and two symptom-first recovery pages, then closes the bounded public-surface inventory with structured drift tests and rendered-doc validation.

**Plan shape:** This task-only document intentionally omits `## Specs` and uses `derive_from_specs: false`. It proposes no product ACs and no spec patches. Documentation work maps to existing behavioral owners verified with `kspec item get`: `@docs-guides-section`, `@docs-concepts-section`, `@docs-troubleshooting-section`, `@docs-section-taxonomy`, `@docs-getting-started-section`, `@docs-navigation-shape`, `@docs-search`, `@docs-reachability`, `@docs-release-notes-availability`, `@readme-landing-page`, `@default-project-agents-and-conventions`, and `@auto-cli-docs`. `@user-documentation` is a module with no ACs and is not claimed as an AC owner.

## Binding Scope and Freshness Rules

- This plan owns documentation, documentation fixtures/tests, source-owned package guidance, generated documentation outputs, and non-behavioral setup/upgrade scaffold comments only. It does **not** add bootstrap timeout/process-group/shell-preflight contracts, workspace CLI commands, destructive reset/cleanup behavior, dispatch-root ownership validation, new status projections, or remote-sync implementation.
- Current CLI help has `kspec agent dispatch start|stop|status|watch` and no workspace list/show/reset/cleanup command. Documentation must not invent one. In particular, no page may recommend the nonexistent `kspec dispatch workspace reset` or `kspec agent dispatch workspace reset`; recovery must use currently supported status/help, configuration correction, normal retry/reconciliation behavior proven by tests, and escalation/manual observation that does not mutate dispatcher-managed metadata or worktrees.
- `@dispatch-remote-branch-sync` is currently `in_progress`. Schema presence is not proof of support. Remote-sync prose must describe only behavior confirmed on the fresh integrated branch and must label incomplete behavior as experimental, limited, or unavailable; this plan does not make the feature complete.
- The active `@plan-dispatch-lifecycle-pause-resume-and-stop-controls` owns dispatch runtime, cleanup, status, API, CLI, and UI behavior on its own plan branch. No task below edits those product surfaces. Before any task branch for this plan is created, a maintainer/dispatcher must confirm the lifecycle plan's relevant work is merged into this plan's integration target and the task starts from that fresh target. If it is not integrated, the task blocks; adding cross-plan `depends_on` refs is not a substitute for branch availability.
- Task 1 refreshes every dispatch/bootstrap/workspace claim from the integrated source, schemas, tests, generated defaults, and live CLI help. Later prose uses that evidence, not the stale pre-integration snapshot. Task 6 repeats the source-fact comparison after all page slices land.
- Existing source facts to verify rather than reinterpret include project-before-agent bootstrap ordering; role filtering and reviewer reuse/rerun behavior; tracked-file mutation guard; dispatch-only bootstrap scope; base-branch and plan-target precedence; relative/absolute `worktree_root`; publication modes; remote-sync defaults and limitations; worker/reviewer workspace distinction; registry/cleanup ownership; agent-rule `on`/`filter`; and event-specific automation filtering.
- Package sources remain universal. Kynetic-only branch names, agent ids, quality gates, generated-artifact policy, and review policy remain in `AGENTS.md`, project meta, or project-local skills.
- Documentation tests compare structured facts, links, examples, ownership, and generated output. They do not police tone/style or use broad string deny-lists as the primary package-neutrality proof.

## Deterministic Public-Surface Universe

Task 1 creates `tests/fixtures/public-documentation-surfaces.json` and `tests/public-documentation-inventory.test.ts`. The manifest is the declared universe, not a hand-picked list:

1. **Tracked Markdown universe:** start from the exact sorted result of `git ls-files '*.md'`. Every result must have one manifest record; no tracked Markdown may be silently omitted. File records use `kind: "markdown-file"`, stable `id` equal to the repository-relative path, `path`, `classification`, `source_of_truth`, `audit_topics`, and, when excluded from active-public rewriting, a non-empty `exclusion_reason`.
2. **Required classifications and explicit exclusions:**
   - `active-public`: `docs/` pages except the historical/internal sets below; root `README.md`, `INSTALL.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RELEASE_NOTES.md`; `packages/web-ui/README.md`; and `.github/ISSUE_TEMPLATE/maintainer-approved-issues-and-features.md`.
   - `historical`: `docs/history/**`; verify historical labeling and absence of dangerous current recovery instructions, but do not rewrite history as current guidance.
   - `internal-eval`: `docs/agents-eval-scenarios.md` and `docs/prime-mock.md`; exclude because they are evaluation/design inputs, not user instructions.
   - `source-template`: `templates/agents-sections/**/*.md` and `templates/skills/**/*.md`; these are package-shipped authoring sources and require package-neutral factual review.
   - `generated`: tracked `kspec-agents.md` and rendered package-core skill outputs under `.agents/skills/**` and `.factory/skills/**`; each record names its source template and regeneration command. Project-local rendered skills that do not originate in `templates/skills/` are classified `internal-agent-guidance` instead.
   - `internal-agent-guidance`: root `AGENTS.md`, root `CLAUDE.md`, `.claude/**/*.md`, and project-local `.agents/**/*.md`/`.factory/**/*.md`; exclude from the public-doc rewrite because they govern this repository or local agents, while still recording owner and reason.
   - `fixture`: `tests/**/fixtures/**/*.md`; exclude because it is test input, with the owning test recorded.
3. **Non-file public and generated surfaces:** records do not require `path`. They use a stable `kind` plus `id` and authority fields:
   - `kind: "cli-help"`, `id` and `command` for `kspec --help`, `kspec help --all`, `kspec help --json`, and every public command-family/subcommand help node discovered from the exported Commander command tree. Completeness compares records to that tree rather than a frozen prose list.
   - `kind: "scaffold"`, stable ids `setup-project-config` and `upgrade-project-config`, with producer source paths and the command/test that renders each surface.
   - `kind: "generated-artifact"` for ignored plugin skill output, docs-search output, and packaged/web-rendered docs; each records source owner, destination, and build command. Ignored plugin files are not treated as tracked Markdown but cannot disappear from the generated-surface set.
   - `kind: "documentation-test"` for link, README, render, search, E2E, scaffold, generated-guidance, and inventory gates, with stable repository-relative test ids.
4. The completeness test independently derives tracked Markdown, the Commander help tree, required scaffold ids, generated destinations, and documentation tests; it compares each derived set to the manifest, rejects duplicates/missing/extra records, requires reasons for every excluded classification, and validates source/generated pairings.

## Tasks

derive_from_specs: false

```yaml
- title: Freeze integrated documentation facts and create the public-surface inventory gate
  slug: task-freeze-doc-facts-and-inventory
  priority: 1
  spec_ref: "@docs-section-taxonomy"
  tags: [docs, audit, testing]
  description: |
    Covers:
    - @docs-section-taxonomy ac-1, ac-2
    - @auto-cli-docs ac-1, ac-3, ac-4, ac-5

    Preconditions:
    - Confirm `@plan-dispatch-lifecycle-pause-resume-and-stop-controls` changes relevant to runtime, cleanup, status, CLI, and public projections are merged into this plan's integration target and this task starts from a fresh target checkout. Block if not; cross-plan task completion alone is not branch integration evidence.

    What:
    Refresh the binding dispatch/bootstrap/workspace fact sheet from integrated schemas, runtime tests, setup defaults, and captured CLI help. Create the deterministic manifest and its comparison test before any page task consumes them.

    Files:
    - Create: `tests/fixtures/public-documentation-surfaces.json`
    - Create: `tests/public-documentation-inventory.test.ts`
    - Create: `tests/dispatch-workspace-docs.test.ts`
    - Do not modify prose or product/runtime files.

    Required content and tests:
    - Implement the complete tracked/non-file universe and classification rules in this plan, including package README, `.github` template, AGENTS/CLAUDE, `.claude`, project-local skills, fixture Markdown, historical/internal-eval docs, ignored plugin output, scaffolds, generated docs/search, and recursively discovered CLI help.
    - Record source-of-truth locations and audit topics for bootstrap, workspace, remote sync, automation filters, setup/upgrade, generated guidance, navigation, search, and rendering. Record exact limitations, including absence of workspace commands and the current `@dispatch-remote-branch-sync` status.
    - Capture CLI help through `tests/helpers/cli.ts` with explicit fixture cwd. Validate schemas/defaults through exported public types or focused fixtures, never source-body regexes.
    - The inventory test fails for one removed record, one duplicate id, one unreasoned exclusion, one unpaired generated output, one missing command-tree node, and one omitted scaffold.

    Verification:
    - `npm test -- tests/public-documentation-inventory.test.ts tests/dispatch-workspace-docs.test.ts tests/plan-document-parser.test.ts`
    - `npm run format:check`
    - `npm run typecheck`

    Review handoff:
    Reviewer independently runs `git ls-files '*.md'`, samples every classification/kind, compares CLI records to the exported command tree, and verifies the freshness prerequisite evidence. Unclassified surfaces or stale pre-integration facts are blockers.

- title: Publish the source-bound dispatch workspace configuration guide
  slug: task-document-dispatch-workspace-configuration
  priority: 1
  spec_ref: "@docs-guides-section"
  tags: [docs, dispatch, guides]
  depends_on:
    - "@task-freeze-doc-facts-and-inventory"
  description: |
    Covers:
    - @docs-guides-section ac-1, ac-2, ac-3

    What:
    Create `docs/guides/configuring-dispatch-workspaces.md`, add it to `docs/guides/index.md`, and correct the two dispatch-rule examples in `docs/guides/configuring-agent-runners.md` from legacy `trigger`/`filters` to schema-valid `on`/`filter`.

    Files:
    - Create: `docs/guides/configuring-dispatch-workspaces.md`
    - Modify once in this plan: `docs/guides/index.md`, `docs/guides/configuring-agent-runners.md`
    - Modify creator-owned test: `tests/dispatch-workspace-docs.test.ts`

    Required guide sections:
    - Goal and prerequisites; Minimal configuration; Base-branch and plan-target resolution; Worktree-root placement; Publication mode; Project bootstrap; Per-agent bootstrap; Step behavior; Environment boundaries; Remote synchronization and current limitations; Supported inspection and recovery; Managed `.gitignore`; Verification; Related concepts and troubleshooting.
    - Describe only integrated keys/defaults/enums and supported authoring commands. Point to exact `--help` output instead of transcribing full flags.
    - State project-before-agent ordering, role/reviewer behavior, invalidation, tracked-only mutation guard, allowed untracked artifacts, current shell/cwd/environment behavior, named-runner separation, output-tail/security limitation, and one-shot exclusion exactly as proven by Task 1.
    - State that no workspace reset/list/show/cleanup command exists. Do not recommend metadata edits, deleting managed paths, or manual worktree mutation. Route recovery to current supported status/config correction/retry or escalation.
    - Describe remote sync only to the proven integrated boundary and visibly label incomplete/experimental or unavailable behavior. Do not claim `@dispatch-remote-branch-sync` complete.

    Required tests:
    - Validate tagged `yaml kspec-config` and `yaml kspec-agent` examples through public schemas.
    - Compare documented config fields/defaults/enums to Task 1 structured facts; validate links and help-backed command paths.
    - Assert the legacy rule examples are corrected and no unsupported workspace command appears as a procedure.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/parser/config.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer verifies every normative statement against the fresh fact sheet and confirms the page is goal/prerequisite/steps/verification shaped, package-neutral, and explicit about unsupported surfaces.

- title: Publish the dispatch workspace lifecycle concept and correct the overview
  slug: task-document-dispatch-workspace-concept
  priority: 1
  spec_ref: "@docs-concepts-section"
  tags: [docs, dispatch, concepts]
  depends_on:
    - "@task-document-dispatch-workspace-configuration"
  description: |
    Covers:
    - @docs-concepts-section ac-1, ac-2
    - @default-project-agents-and-conventions ac-task-worker-agent, ac-pr-reviewer-agent, ac-primary-dev-agent, ac-plan-reviewer-agent

    What:
    Create `docs/concepts/dispatch-workspaces.md`, add it to `docs/concepts/index.md`, and keep `docs/concepts/agents-and-dispatch.md` as the short overview linking to the guide and concept.

    Files:
    - Create: `docs/concepts/dispatch-workspaces.md`
    - Modify once in this plan: `docs/concepts/index.md`, `docs/concepts/agents-and-dispatch.md`
    - Modify creator-owned test: `tests/dispatch-workspace-docs.test.ts`

    Required concept sections:
    - What a dispatch workspace is; Why isolation exists; Workspace and target identity; Worker lifecycle; Detached reviewer lifecycle; Review rejection/fix cycle; Bootstrap state; Integration/publication; Health and cleanup; What the operator owns; Current limitations; Related operations.
    - Explain behavior through durable concepts, not a release-sensitive field dump. Separate worker continuity, detached reviewer snapshots, and one-shot `kspec agent run`.
    - Do not absorb pause/resume/stop, cleanup, status, CLI, or UI product ownership from the active lifecycle plan; describe only its integrated public behavior and link to current help.
    - Explicitly replace “kspec ships with four built-in agents” with “`kspec setup` scaffolds default agent definitions”; make clear projects can configure/rename them and the live registry is authoritative.

    Required tests:
    - Render the page; verify its headings, index membership, overview links, stable anchors, and absence of release-sensitive schema-field enumeration.
    - Verify the scaffold wording against `@default-project-agents-and-conventions` and setup tests.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/web-ui-docs-rendering.test.ts tests/setup-builtin-agents.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer compares lifecycle claims to integrated workspace/registry tests and confirms the overview says setup scaffolds defaults rather than claiming immutable package-shipped agents.

- title: Publish symptom-first bootstrap and workspace recovery pages
  slug: task-document-dispatch-workspace-recovery
  priority: 1
  spec_ref: "@docs-troubleshooting-section"
  tags: [docs, dispatch, troubleshooting]
  depends_on:
    - "@task-document-dispatch-workspace-concept"
  description: |
    Covers:
    - @docs-troubleshooting-section ac-1, ac-2, ac-3

    What:
    Create the two linked recovery pages after their guide and concept targets exist, index them, and correct assignment troubleshooting without inventing operator commands.

    Files:
    - Create: `docs/troubleshooting/dispatch-bootstrap-failures.md`
    - Create: `docs/troubleshooting/dispatch-workspace-sync-and-cleanup.md`
    - Modify once in this plan: `docs/troubleshooting/index.md`, `docs/troubleshooting/dispatch-refuses-to-assign.md`
    - Modify creator-owned test: `tests/dispatch-workspace-docs.test.ts`

    Required page sections:
    - Bootstrap page symptom blocks: nonzero exit, tracked-file mutation, reviewer rerun refusal, invalidated cached state, inaccessible/unrunnable workspace, and unsafe output exposure. Include what the symptom means, supported observations/config correction, normal retry boundary, healthy result, and links to guide/concept/runner validation. Do not promise a timeout or shell preflight classification unless Task 1 proves it exists. State retained output is bounded as proven and bootstrap commands must not print secrets; do not claim complete redaction unless proven.
    - Workspace page status-first blocks: target/config mismatch, plan target change, missing/colliding path, stale/unrecoverable registry state, local-only/no-remote mode, transient sync failure, divergence, occupied checkout, deferred reviewer behavior, cleanup protection, unknown root entries, and retention—only where Task 1 proves a stable observable. Label incomplete remote-sync cases and route unsupported recovery to safe observation/escalation.
    - State plainly that no reset/list/show/cleanup workspace command exists. Never tell users to edit shadow-managed registry state, remove dispatcher-managed paths, or run manual worktree mutations. Remove/replace the stale nonexistent reset suggestion only in documentation owned here; product/runtime suggestion sites remain outside this plan and are reported as follow-up if still present.
    - In `dispatch-refuses-to-assign.md`, describe automation filtering per rule/event: preserve eligible-only worker defaults while distinguishing reviewer and arbitrary registered event rules.

    Required tests:
    - Verify symptom/meaning/procedure/healthy-outcome structure and concept links for both pages.
    - Validate all command paths against captured help and all links after both pages exist.
    - Test that unsupported reset strings are not presented as runnable recovery and that reviewer/arbitrary-event prose is not blanket eligible-only.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/web-ui-docs-rendering.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer walks one bootstrap failure, one target mismatch, one sync limitation, and one cleanup-protected case from integrated evidence through the written recovery; unsupported procedures are blockers.

- title: Correct top-level, package, scaffold, release, and generated guidance drift
  slug: task-correct-adjacent-public-guidance
  priority: 2
  spec_ref: "@readme-landing-page"
  tags: [docs, setup, templates, release]
  depends_on:
    - "@task-document-dispatch-workspace-recovery"
  description: |
    Covers:
    - @readme-landing-page ac-1, ac-2
    - @docs-release-notes-availability ac-1, ac-2
    - @default-project-agents-and-conventions ac-agents-md-reflects-defaults

    What:
    Audit and factually correct the non-`docs/` public landing/contributor/package surfaces and source-owned generated guidance. Keep universal package guidance separate from Kynetic-local policy and make no product behavior change.

    Exact owned surfaces:
    - `README.md` (overview/install/first steps/docs links only), `INSTALL.md` (installation/setup), `CONTRIBUTING.md` (contributor workflow), `SECURITY.md` (supported reporting/security claims), `RELEASE_NOTES.md` (historical release facts), `packages/web-ui/README.md`, and `.github/ISSUE_TEMPLATE/maintainer-approved-issues-and-features.md`.
    - Non-behavioral comments/discoverability in `src/cli/commands/setup.ts` and `src/cli/commands/upgrade.ts`, with existing scaffold tests; do not change resolved defaults or introduce new keys/commands.
    - Package-neutral sources under `templates/agents-sections/**/*.md` and `templates/skills/**/*.md` only when Task 1 identifies factual drift; regenerate tracked `.agents`/`.factory` outputs and `kspec-agents.md`, and build ignored plugin output. Never author in generated files.

    Required corrections and tests:
    - Correct the v0.12 release-note publication-mode row to include `manual_merge`, `pull_request`, and `auto` while preserving historical tense.
    - Ensure setup/upgrade scaffold comments point to canonical docs and accurately describe existing dispatch keys without changing semantics.
    - Keep README concise and preserve one-click links to Getting Started, Concepts, and Guides. Validate all relative links/anchors.
    - Run semantic shared-guidance-neutrality review in both directions: no Kynetic policy becomes universal, and local policy removed from package text still has a local owner.
    - Parse changed snippets, run scaffold snapshots, regenerate twice, and require the second generation to be clean.

    Verification:
    - `npm test -- tests/docs-readme-structure.test.ts tests/scaffold-project-config.test.ts tests/upgrade-command.test.ts`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `git diff --exit-code -- kspec-agents.md .agents .factory`
    - `npm run format:check`

    Review handoff:
    Reviewer reports each changed surface, its source-of-truth comparison, generated convergence, and a separate package-neutrality judgment.

- title: Audit and correct the remaining declared public documentation universe
  slug: task-audit-remaining-public-docs
  priority: 2
  spec_ref: "@docs-getting-started-section"
  tags: [docs, audit, consistency]
  depends_on:
    - "@task-correct-adjacent-public-guidance"
  description: |
    Covers:
    - @docs-getting-started-section ac-1, ac-2, ac-3
    - @docs-section-taxonomy ac-1, ac-2
    - @docs-release-notes-availability ac-1, ac-2

    What:
    Run the requested full factual pass over every declared surface not owned by Tasks 2-5, refresh dispatch/bootstrap/workspace facts after the page slices, and close every inventory record without style-only churn.

    Exact owned file sets:
    - All existing `docs/getting-started/**/*.md`.
    - Existing `docs/guides/**/*.md`, excluding the three files owned by Task 2.
    - Existing `docs/concepts/**/*.md`, excluding the three files owned by Task 3.
    - Existing `docs/troubleshooting/**/*.md`, excluding the four files owned by Task 4.
    - `docs/release-notes/index.md` and remaining active-public `docs/**/*.md` records not classified historical/internal-eval.
    - Historical/internal-eval/internal-agent-guidance/fixture records receive their declared limited checks and disposition only; do not rewrite them into public guidance.
    - Modify `tests/public-documentation-inventory.test.ts`; do not modify `tests/dispatch-workspace-docs.test.ts` or any Task 2-5 owned prose file.

    Source-of-truth checks:
    - Commands against captured Commander help; YAML/defaults/enums against exported schemas/resolved config; setup/upgrade claims against scaffold tests; package locations against packaging code; navigation/index/link/anchor claims against rendered docs; release notes against the canonical source; automation/state language against exact existing specs.
    - Recheck known dispatch/bootstrap/workspace errors and gaps from the integrated branch. Documentation corrections in this owned set are in scope. Product contradictions become explicit limitations and follow-up evidence, not implementation in this plan.
    - Every manifest record receives `audit_status`, evidence/source, and correction or exclusion disposition. No “reviewed by implication” rows.

    Required tests:
    - Full manifest closure against independently derived tracked Markdown and non-file universes.
    - Relative links/anchors, section landing membership/order, release-note single-source equivalence, deterministic tagged snippet validation, and generated-source ownership.
    - Preserve historical text except dangerous unsupported current instructions; avoid wording/style churn unrelated to factual correction.

    Verification:
    - `npm test -- tests/public-documentation-inventory.test.ts tests/docs-readme-structure.test.ts tests/folder-backed-resource-docs.test.ts tests/resource-ui-task-markdown-docs.test.ts tests/web-ui-docs-rendering.test.ts tests/web-ui-docs-search.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`
    - `npm run typecheck`

    Review handoff:
    Reviewer independently samples every classification and audit topic, diffs the manifest against all derived universes, and rejects any unsupported normative command, silent omission, style-only sweep, or edit to a prior task's owned prose.

- title: Close structured documentation drift gates and rendered validation
  slug: task-close-documentation-drift-gates
  priority: 2
  spec_ref: "@docs-navigation-shape"
  tags: [docs, testing, web-ui]
  depends_on:
    - "@task-audit-remaining-public-docs"
  description: |
    Covers:
    - @docs-navigation-shape ac-1, ac-2
    - @docs-search ac-1, ac-2, ac-3
    - @docs-reachability ac-1, ac-2, ac-3
    - @auto-cli-docs ac-1, ac-3, ac-4, ac-5

    What:
    Harden the two Task 1-created tests after all content exists, validate navigation/search/rendering and package generation, and report focused-plan success separately from the unrelated refs baseline.

    Files:
    - Modify: `tests/public-documentation-inventory.test.ts`, `tests/dispatch-workspace-docs.test.ts`, `tests/web-ui-docs-rendering.test.ts`, `tests/web-ui-docs-search.test.ts`, `tests/e2e/docs.spec.ts`
    - Modify `scripts/build-docs-search.cjs` only if a factual indexing defect is exposed.
    - No prose edits except a correction exposed by a failing gate; route it to the task that owns that file or record the explicit dependency rather than editing in parallel.

    Required gates:
    - Structured schema/default/enum comparisons; tagged example parsing; command-tree/help existence; inventory/link/anchor/index completeness; source/generated convergence; search inclusion for all four new pages; desktop/mobile sidebar, current page, TOC anchors, offline/static rendering, and no raw Markdown link leaks.
    - Negative fixtures target concrete drift: legacy `trigger`/`filters`, unsupported workspace recovery command, missing inventory record, invalid dispatch key/default, broken anchor, unpaired generated output, and generated file treated as source. Do not add style or package-neutrality string policing.
    - Regenerate package outputs twice and prove the second run is clean. Build docs search and web UI; run focused browser docs QA.

    Baseline validation policy:
    - Changed/focused docs-plan gates, formatting, lint, typecheck, tests, generation, search, web build, and docs E2E must pass.
    - Run `kspec validate --alignment --warnings-ok` and `kspec validate --completeness --warnings-ok` as focused state checks.
    - Run `kspec validate --refs --warnings-ok` only to capture/compare project baseline evidence. At plan drafting time it exits 4 with seven unrelated ambiguous-reference errors involving duplicate `@observations` and `@spec-plan-import` slugs. This plan neither fixes nor absorbs them. Completion requires no new/changed refs errors and an exact captured diff against that baseline; it must not claim the refs gate or project-wide validation is green.
    - Project-wide green/release-ready status remains externally blocked until the owning work resolves those seven ambiguity errors and a fresh full refs validation passes. Report that prerequisite explicitly.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/public-documentation-inventory.test.ts tests/docs-readme-structure.test.ts tests/web-ui-docs-rendering.test.ts tests/web-ui-docs-search.test.ts`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `git diff --exit-code -- kspec-agents.md .agents .factory`
    - `npm run build:docs-search`
    - `npm run build:web-ui`
    - `npm run test:e2e -- tests/e2e/docs.spec.ts`
    - `npm run format:check`
    - `npm run lint`
    - `npm run typecheck`
    - `npm test`
    - `kspec validate --alignment --warnings-ok`
    - `kspec validate --completeness --warnings-ok`
    - `kspec validate --refs --warnings-ok` (baseline evidence comparison; not an expected green completion gate until external ambiguity cleanup lands)

    Review handoff:
    Final reviewer receives the inventory diff, fresh source-fact evidence, focused/full test output, generated-clean proof, desktop/mobile evidence, and exact refs-baseline comparison. The handoff may claim this docs plan's gates passed; it may not claim project-wide green or review approval.
```

## Implementation Notes

### Slice and ownership order

1. Task 1 waits for lifecycle-plan integration, refreshes facts, and is the sole creator of the inventory fixture and both shared tests.
2. Tasks 2-4 are serialized guide → concept/overview → troubleshooting, so every link target exists before use and every shared test modifier depends transitively on its creator. Each documentation page and index is authored once.
3. Task 5 owns non-`docs/` public/package/scaffold/generated corrections; Task 6 owns the explicitly excluded remainder of `docs/`; their file sets do not overlap Tasks 2-4.
4. Task 7 modifies shared tests only after all creators and content slices complete. A correction exposed at this stage returns to the declared file owner rather than creating a parallel write.

### Spec text and AC policy

No spec patch is proposed. If execution discovers a genuinely missing documentation behavior that cannot map to the exact existing owners above, stop and obtain separate approval for a spec change. Any later approved spec patch must appear verbatim in its task body with exact spec ref, AC id, Given/When/Then, preservation rules, and `kspec item get <ref>` readback; workers may not paraphrase it. Product AC proposals from the first draft—timeout/process group, reset prerequisites, cleanup policy restatements, status projection, and runner schema wording—are removed rather than rewritten because their product work is deferred.

### Completion claim

Completion means the documentation plan's changed/focused gates pass and every declared public-surface record has evidence. It does not mean the active lifecycle plan is approved by this plan, remote sync is complete, the seven pre-existing refs ambiguities are fixed, project-wide validation is green, or either first-pass review has approved this revision.
