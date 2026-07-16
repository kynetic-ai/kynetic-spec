# Documentation Completeness and Dispatch Workspaces

**Goal:** Correct and complete Kynetic Spec's active public documentation, with source-bound dispatch workspace and lifecycle-control operator guidance plus a deterministic whole-public-surface audit.

**Architecture:** This is a documentation correction plan, not a dispatch product-expansion plan. It documents behavior on the final reviewed integrated lifecycle target, keeps workspace configuration separate from lifecycle control, adds a dedicated lifecycle-control guide because the implemented CLI/API/UI surface is larger than an overview section, adds one workspace concept page and three symptom-first recovery pages, then closes the bounded public-surface inventory with structured drift tests and rendered/browser validation.

**Plan shape:** This task-only document intentionally omits `## Specs` and uses `derive_from_specs: false`. It proposes no product ACs, no spec patches, and no product changes. Documentation work maps to existing documentation owners verified with `kspec item get`: `@docs-guides-section`, `@docs-concepts-section`, `@docs-troubleshooting-section`, `@docs-section-taxonomy`, `@docs-getting-started-section`, `@docs-navigation-shape`, `@docs-search`, `@docs-reachability`, `@docs-release-notes-availability`, `@readme-landing-page`, `@default-project-agents-and-conventions`, and `@auto-cli-docs`. Lifecycle specs and ACs named below are factual source authorities only; tasks do not claim to implement or close them. `@user-documentation` is a module with no ACs and is not claimed as an AC owner.

## Binding Scope and Freshness Rules

- This plan owns documentation, documentation fixtures/tests, source-owned package guidance, generated documentation outputs, and non-behavioral setup/upgrade scaffold comments or links. It does **not** alter lifecycle schemas, parser/store, engine/admission gates, sessions/process ownership, API routes, CLI handlers/help, UI controls, event contracts, workspace management, remote sync, or task readiness.
- Source inspection on 2026-07-16 establishes that `dev` and the local lifecycle plan branch are at `0fceed5aa3a2bc93c9bd0ab504df4f48b84494d9`; `origin/dev` is two unrelated daemon timing-test commits ahead at `87ba5a40db4a3a66c21c89c9ff90b28d9177727c`. Final task review `@01KXPCP5Y3Y0BEY2KP8KDFXNS8` approved examined commit `b28c29557d3ec15ee1cfc0b14c6d2ee5a57b86aa`; the completed task was merged at the lifecycle plan's remote target tip `3f22e6c93c68115d77e1bde062f7cd12034f91d8`, which contains both `b28c2955` and `0fceed5a`. No lifecycle review is open. The reviewed lifecycle tip is not yet an ancestor of local or `origin/dev`; the lifecycle plan may remain administratively `active` without changing that review evidence.
- The preceding fact is not an unconditional “lifecycle work is not merged” blocker. Before Task 1 starts, the maintainer/dispatcher confirms that the branch chosen as this plan's integration target contains approved reviewed lifecycle tip `3f22e6c93c68115d77e1bde062f7cd12034f91d8` and creates the task branch from that target. If a genuinely later lifecycle fix/review appears before execution, record its approved reviewed tip and use that instead. Task 1 waits only when its chosen base does not contain the applicable approved reviewed tip; no stale hard-coded commit in this document overrides newer approved evidence.
- Task 1 repeats the ancestry check and refreshes every dispatch/bootstrap/workspace/lifecycle claim from the approved integrated schemas, parser/store, engine, session ownership, API, CLI help, UI adapter/components, events, setup/defaults, generated guidance, and passing tests. Later prose consumes that structured evidence. Task 7 repeats the source comparison after all page slices; Task 8 compares help/render/browser surfaces. Any genuinely later approved fix that changes a public fact must be reflected before page work proceeds.
- The integrated CLI surface is `kspec agent dispatch start|pause|resume|stop|status|watch`, `kspec agent dispatch task pause|resume|stop <task>`, and `kspec agent status`. Lifecycle control commands are distinct from workspace management. There is still no workspace list/show/reset/cleanup command; no page may invent `kspec dispatch workspace ...` or `kspec agent dispatch workspace ...`.
- `@dispatch-remote-branch-sync` remains `in_progress`. Schema or tests for one path are not proof that every remote-sync behavior is complete. Remote-sync prose describes only behavior confirmed on the fresh reviewed target and labels incomplete behavior as limited, experimental, or unavailable.
- Existing workspace facts still requiring refresh include project-before-agent bootstrap ordering; role filtering and reviewer reuse/rerun behavior; tracked-file mutation guard; dispatch-only bootstrap scope; base-branch and plan-target precedence; relative/absolute `worktree_root`; publication modes; remote-sync defaults/limits; worker/reviewer workspace distinction; registry/cleanup ownership; agent-rule `on`/`filter`; and event-specific automation filtering.
- Package sources remain universal. Kynetic-only branch names, agent ids, quality gates, generated-artifact policy, and review policy remain in `AGENTS.md`, project meta, or project-local skills.
- Documentation tests compare structured facts, links, examples, ownership, accessibility behavior, and generated output. They use public schemas/helpers/fixtures and observable command/API/UI behavior. They do not regex implementation bodies, police style/tone, or use broad deny-lists as primary package-neutrality proof.

## Integrated Lifecycle Facts the Documentation Must Preserve

Task 1 freezes these as structured, source-cited facts from the approved reviewed lifecycle tip, refreshing them for any genuinely later approved fix rather than copying this plan or the lifecycle plan prose:

1. **Authority and scope:** global durable authority is `stopped | running | paused`; per-canonical-task records are `paused | stopped`. `draining` is a status projection for paused authority with active work, not another durable authority. Controls do not mutate semantic task readiness or degraded-target state.
2. **Transitions:** global `start` leaves cleanup-idle stopped; `resume` leaves paused; pause allows active dispatch invocations/sessions to finish naturally; hard stop commits no-start authority before cancelling matching dispatch-owned work and closing its sessions. Task controls affect one canonical task and do not bypass global authority. Repeated valid/no-op actions are idempotent; invalid transitions fail without substituting another action.
3. **Canonical identity:** task commands accept a resolvable ref alias, canonicalize to the task ULID, reject missing/ambiguous/not-found identity and ref/id disagreement, and keep unrelated task controls/cleanup independent.
4. **Admission and durability:** `.kspec/dispatch-control.yaml` is committed shadow-state authority; missing state defaults stopped. Startup loads durable control and retries matching pending cleanup before bootstrap scheduling. Final admission gates recheck global and task authority before process/session creation.
5. **Status and cleanup observability:** status reports authority, projection, active/queued counts, held count and canonical held-task rows, task-control rows, cleanup `idle|pending|failed` with scoped entries/phases/codes, and degraded targets. Global operations inspect global cleanup only; task operations inspect matching task cleanup only. Aggregate cleanup is observability, not a blanket transition gate.
6. **Recovery and evidence:** hard stop targets only dispatch-owned sessions/processes whose durable ownership and process identity can be verified. Timeout, ownership/birth/group uncertainty, signalling failure, or session-closure failure remains stopped with retryable pending/failed cleanup and never reports false success. Session, branch, workspace, worktree, snapshot, and audit evidence remain governed by existing cleanup policy; lifecycle control does not delete workspaces.
7. **Public surfaces:** canonical mutation is `POST /api/agent/dispatch/control`; public status is `GET /api/agent/status`; compatibility routes/status remain additive. CLI status consumes the internal dispatch status contract. The web adapter validates snake-case public wire data and maps to camelCase UI data. The agents UI exposes only valid global/task actions, confirms hard stop, retains focus, announces status/failures, keeps active/queued/held/cleanup evidence visible, and is stopped/read-only in static mode.
8. **Safety:** interactive hard stop confirms active cancellation and evidence preservation; noninteractive and JSON stop require `--force`; dispatch-owned contexts reject global/task hard stop so an agent cannot stop its host; fixed closed error codes/messages do not expose raw errors or paths.
9. **Events:** if public docs expose lifecycle events, the exact registered names are `dispatch_control.start_applied`, `dispatch_control.pause_applied`, `dispatch_control.resume_applied`, `dispatch_control.stop_applied`, `dispatch_control.noop`, and `dispatch_control.failed`. Task events use canonical task identity; failure uses a closed code. Event details are documented only where useful to public trigger/filter authoring, not as an internal payload dump.
10. **Supported limitations:** pause is the graceful admission hold and stop is hard stop; there is no checkpointing, distributed scheduler, exact durable FIFO promise, workspace deletion/reset command, or control of arbitrary one-shot processes. One-shot `kspec agent run` remains outside lifecycle control unless it is dispatch-owned. Recovery may remain pending when process ownership cannot be proven, especially where equivalent process-birth/group verification is unavailable.

## Deterministic Public-Surface Universe

Task 1 creates `tests/fixtures/public-documentation-surfaces.json` and `tests/public-documentation-inventory.test.ts`. The manifest is the declared universe, not a hand-picked list:

1. **Tracked Markdown universe:** start from the exact sorted result of `git ls-files '*.md'`. Every result has one manifest record. File records use `kind: "markdown-file"`, stable repository-relative `id`, `path`, `classification`, `source_of_truth`, `audit_topics`, and, when excluded from active-public rewriting, a non-empty `exclusion_reason`.
2. **Required classifications and explicit exclusions:**
   - `active-public`: `docs/` pages except historical/internal sets below; root `README.md`, `INSTALL.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RELEASE_NOTES.md`; `packages/web-ui/README.md`; and `.github/ISSUE_TEMPLATE/maintainer-approved-issues-and-features.md`.
   - `historical`: `docs/history/**`; verify labeling and absence of dangerous current recovery instructions without rewriting history as current guidance.
   - `internal-eval`: `docs/agents-eval-scenarios.md` and `docs/prime-mock.md`; exclude because they are evaluation/design inputs.
   - `source-template`: `templates/agents-sections/**/*.md` and `templates/skills/**/*.md`; package-shipped authoring sources requiring package-neutral factual review.
   - `generated`: tracked `kspec-agents.md` and rendered package-core skills under `.agents/skills/**` and `.factory/skills/**`; each names its source and regeneration command. Project-local rendered skills remain `internal-agent-guidance`.
   - `internal-agent-guidance`: root `AGENTS.md`, `CLAUDE.md`, `.claude/**/*.md`, and project-local `.agents/**/*.md`/`.factory/**/*.md`; record owner/reason but exclude from public rewriting.
   - `fixture`: `tests/**/fixtures/**/*.md`; exclude as test input and record the owning test.
3. **Non-file public/generated surfaces:**
   - `kind: "cli-help"` for `kspec --help`, `kspec help --all`, `kspec help --json`, and every public command-family/subcommand node recursively derived from the exported Commander tree, including lifecycle global/task nodes.
   - `kind: "api-surface"` for publicly documented lifecycle status/control endpoints, with schema/helper/test authority; this is an inventory record, not a new hand-maintained API reference.
   - `kind: "ui-surface"` for writable and static/read-only lifecycle projections and accessibility behavior on the agents view.
   - `kind: "scaffold"`, stable ids `setup-project-config` and `upgrade-project-config`, with producer source paths and rendering tests.
   - `kind: "generated-artifact"` for ignored plugin skill output, docs-search output, and packaged/web-rendered docs, each with source owner, destination, and build command.
   - `kind: "documentation-test"` for link, README, render, search, E2E, scaffold, generated-guidance, inventory, and lifecycle docs gates.
4. The completeness test independently derives tracked Markdown, Commander help nodes, required API/UI/scaffold ids, generated destinations, and documentation tests; in strict closure mode it rejects duplicates/missing/extra records, requires reasons for exclusions, and validates source/generated pairings. Task 1's manifest is exact for the tracked Markdown universe at its creation point. Until Task 7 updates it, the shared test keeps full-suite verification satisfiable through an explicit construction-phase allowance for only the six planned pages created by Tasks 2-5; those paths are reported as expected pending additions rather than accepted as reviewed records. Task 7 adds their records/evidence/dispositions and removes that temporary allowance before strict closure.
5. Every record receives `audit_status`, evidence/source, and correction or exclusion disposition by Task 7. No record is “reviewed by implication.”

## Tasks

derive_from_specs: false

```yaml
- title: Freeze final integrated dispatch facts and create the public-surface inventory gate
  slug: task-freeze-doc-facts-and-inventory
  priority: 1
  spec_ref: "@docs-section-taxonomy"
  tags: [docs, audit, testing]
  description: |
    Covers (documentation ownership only):
    - @docs-section-taxonomy ac-1, ac-2
    - @auto-cli-docs ac-1, ac-3, ac-4, ac-5

    Factual source authorities (read-only; no product AC closure):
    - @dispatch-lifecycle-control-authority ac-controls-survive-restart, ac-controls-do-not-change-readiness, ac-status-reports-authority, ac-status-reports-projection, ac-status-reports-active-count, ac-status-reports-queued-count, ac-status-reports-held-count, ac-status-reports-held-task-identity, ac-status-reports-held-task-scope, ac-status-reports-held-task-mode, ac-status-reports-held-task-reason
    - @cli-agent-commands ac-4, ac-5, ac-6, ac-9, ac-13, ac-start-reports-authority, ac-pause-reports-authority, ac-resume-reports-authority, ac-lifecycle-command-reports-projection, ac-task-control-canonicalization, ac-lifecycle-status-authority, ac-lifecycle-status-projection, ac-lifecycle-status-active-count, ac-lifecycle-status-queued-count, ac-lifecycle-status-held-count
    - @daemon-agent-dispatch ac-5, ac-6, ac-public-status-lifecycle-additions, ac-control-error-current-status
    - @ui-agent-dispatch ac-2, ac-3, ac-status-projection, ac-status-active-work-visible, ac-status-queued-work-visible, ac-status-held-work-visible

    Preconditions:
    - Current evidence is final task review `@01KXPCP5Y3Y0BEY2KP8KDFXNS8`, which approved examined commit `b28c29557d3ec15ee1cfc0b14c6d2ee5a57b86aa`; the completed task is merged at remote lifecycle tip `3f22e6c93c68115d77e1bde062f7cd12034f91d8`, and no lifecycle review is open. Confirm that reviewed tip is contained in this task's integration target and create the task branch from that target.
    - If a genuinely later lifecycle fix/review appears before execution, record its approved reviewed tip, prove the task target contains it, and refresh all facts from it. Do not rely on the prior documentation-plan approvals as review of this revision.

    What:
    Build a structured fact fixture from the final integrated schemas, public helpers, CLI tree/help, API/UI fixtures, and passing behavior tests. Create the deterministic public-surface manifest and comparison test before prose tasks consume them.

    Files:
    - Create: `tests/fixtures/public-documentation-surfaces.json`
    - Create: `tests/fixtures/dispatch-operator-facts.json`
    - Create: `tests/public-documentation-inventory.test.ts`
    - Create: `tests/dispatch-operator-docs.test.ts`
    - Do not modify prose or product/runtime files.

    Required facts and tests:
    - Cover workspace/bootstrap/remote-sync/default-agent facts retained by this plan plus all ten lifecycle fact groups above: command tree; global/task matrices; alias canonicalization; durable default/restart/admission behavior; status/held/task-control/cleanup projections; API and UI mapping; accessibility/static mode; events only when selected for public docs; safety/errors; evidence and limitations.
    - Use `tests/helpers/cli.ts` with explicit fixture cwd for command help. Validate configuration/control/status through exported schemas, public conversion helpers, route fixtures, or black-box command fixtures. Never regex function bodies.
    - Derive tracked Markdown and non-file records independently. The manifest must exactly match the tracked Markdown universe when Task 1 lands. The inventory test may temporarily classify only `docs/guides/configuring-dispatch-workspaces.md`, `docs/guides/controlling-dispatch-lifecycle.md`, `docs/concepts/dispatch-workspaces.md`, `docs/troubleshooting/dispatch-bootstrap-failures.md`, `docs/troubleshooting/dispatch-workspace-sync-and-cleanup.md`, and `docs/troubleshooting/dispatch-lifecycle-control-failures.md` as reported pending additions so intervening full-suite and selected verification remain satisfiable; all other extras fail, and Task 7 must remove this construction allowance while adding those six records. Negative fixture checks cover a missing/duplicate manifest record, an unexpected extra, unreasoned exclusion, unpaired generated output, missing command node, omitted API/UI/scaffold id, and stale fact fixture.

    Verification:
    - `npm test -- tests/public-documentation-inventory.test.ts tests/dispatch-operator-docs.test.ts tests/plan-document-parser.test.ts`
    - `npm run format:check`
    - `npm run typecheck`

    Review handoff:
    Provide final-reviewed-tip ancestry, the fact-source matrix, independently derived universes, and negative-fixture results. A stale review-time commit, unclassified surface, or implementation-body regex is a blocker.

- title: Publish the source-bound dispatch workspace configuration guide
  slug: task-document-dispatch-workspace-configuration
  priority: 1
  spec_ref: "@docs-guides-section"
  tags: [docs, dispatch, guides]
  depends_on:
    - "@task-freeze-doc-facts-and-inventory"
  description: |
    Covers (documentation ownership only):
    - @docs-guides-section ac-2, ac-3

    Factual source authorities (read-only):
    - @dispatch-remote-branch-sync ac-no-remote, ac-degraded-status-api, ac-degraded-status-api-reason, ac-degraded-status-api-timestamp, ac-pull-ff-only, ac-pull-target-periodic-deferred
    - @dispatch-workspace-cleanup-policy ac-1, ac-2, ac-3, ac-4, ac-5, ac-controlled-evidence-protected

    What:
    Create the workspace/bootstrap configuration guide and correct schema-invalid dispatch-rule examples. Keep lifecycle operations out of bootstrap step detail; Task 3 provides lifecycle cross-discovery by indexing both completed guides.

    Files:
    - Create: `docs/guides/configuring-dispatch-workspaces.md`
    - Modify once in this plan: `docs/guides/configuring-agent-runners.md`
    - Modify creator-owned test: `tests/dispatch-operator-docs.test.ts`
    - Do not modify `docs/guides/index.md` (Task 3 owns it).

    Required sections:
    - Goal and prerequisites; Minimal configuration; Base/plan target resolution; Worktree root; Publication mode; Project bootstrap; Per-agent bootstrap; Step behavior; Environment boundaries; Remote synchronization and limits; Managed `.gitignore`; Supported inspection/recovery; Verification; Related concepts and troubleshooting.
    - Correct legacy `trigger`/`filters` examples to schema-valid `on`/`filter`. Describe only final integrated keys/defaults/enums and point to command help rather than transcribing flags.
    - Keep `manual_merge | pull_request | auto` publication modes accurate. State project-before-agent ordering, role/reviewer behavior, tracked-only mutation guard, named-runner separation, one-shot exclusion, output-tail/security limitation, and remote-sync status exactly as Task 1 proves.
    - State that lifecycle controls do not manage/delete workspaces and no workspace list/show/reset/cleanup command exists. Never recommend editing registry/control state, deleting managed paths, or manual worktree mutation.

    Required tests:
    - Validate tagged `yaml kspec-config` and `yaml kspec-agent` examples through public schemas and compare fields/defaults/enums to the fact fixture.
    - Validate links/help-backed paths; prove no workspace command is presented as runnable and the two rule examples no longer use legacy keys.

    Verification:
    - `npm test -- tests/dispatch-operator-docs.test.ts tests/parser/config.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer traces every normative statement to Task 1 facts and confirms workspace configuration is not overloaded with lifecycle transition matrices.

- title: Publish the dispatch lifecycle controls operator guide
  slug: task-document-dispatch-lifecycle-controls
  priority: 1
  spec_ref: "@docs-guides-section"
  tags: [docs, dispatch, lifecycle]
  depends_on:
    - "@task-document-dispatch-workspace-configuration"
  description: |
    Covers (documentation ownership only):
    - @docs-guides-section ac-1, ac-2, ac-3

    Factual source authorities (read-only; no product work):
    - @dispatch-lifecycle-control-authority ac-global-pause-authority, ac-global-paused-work-does-not-start, ac-task-paused-work-does-not-start, ac-global-pause-allows-active-completion, ac-task-pause-allows-active-completion, ac-resume-reconciles-held-work, ac-stop-forbids-new-starts, ac-stop-cancels-active-work, ac-task-control-uses-canonical-identity, ac-task-resume-obeys-global-authority, ac-task-stop-preserves-unrelated-invocations, ac-controls-survive-restart, ac-controls-do-not-change-readiness, ac-stop-failure-retains-stopped-authority, ac-stop-failure-reports-pending-cleanup, ac-interrupted-stop-recovers-on-retry, ac-recovery-requires-session-ownership, ac-recovery-requires-process-birth
    - @cli-agent-commands ac-5, ac-start-reports-authority, ac-pause-reports-authority, ac-resume-reports-authority, ac-lifecycle-command-reports-projection, ac-declined-stop-sends-no-request, ac-declined-stop-exit, ac-task-control-canonicalization, ac-lifecycle-status-authority, ac-lifecycle-status-projection, ac-lifecycle-status-active-count, ac-lifecycle-status-queued-count, ac-lifecycle-status-held-count
    - @daemon-agent-dispatch ac-5, ac-6, ac-public-status-lifecycle-additions, ac-control-missing-identity, ac-control-ref-canonicalization, ac-control-identity-mismatch, ac-control-failure-no-success, ac-cleanup-failure-no-success
    - @ui-agent-dispatch ac-2, ac-3, ac-stopped-actions-valid, ac-control-separated-from-degraded, ac-control-separated-from-blocked, ac-hard-stop-confirmation-cancellation, ac-hard-stop-confirmation-evidence, ac-hard-stop-confirmation-cancelled, ac-lifecycle-controls-labelled, ac-lifecycle-focus-retained, ac-lifecycle-live-update
    - @dispatch-event-taxonomy ac-dispatch-control-domain
    - @dispatch-workspace-cleanup-policy ac-controlled-evidence-protected

    Why a dedicated page:
    The implemented surface has two scopes, two transition matrices, hard-stop safety, durable recovery, status projections, canonical identity, API/UI equivalents, accessibility/static behavior, and explicit limitations. Putting this in bootstrap or the short Agents and Dispatch overview would obscure both workflows and duplicate CLI help.

    What:
    Create `docs/guides/controlling-dispatch-lifecycle.md`; add both new dispatch guides to `docs/guides/index.md`; keep commands concise and link to generated help.

    Files:
    - Create: `docs/guides/controlling-dispatch-lifecycle.md`
    - Modify once in this plan: `docs/guides/index.md`
    - Modify creator-owned test: `tests/dispatch-operator-docs.test.ts`

    Required guide sections:
    - Goal/prerequisites; Choose global or task scope; Read authority/projection/counts/held/task-control/cleanup status; Global action table; Task action table; Pause versus hard stop; CLI procedure; API/UI equivalents; Retry and restart recovery; Events for automation (only if retained as public authoring surface); Safety/error semantics; Static/read-only UI; Supported limitations; Verification; Workspace/concept/troubleshooting links.
    - Name the actual global and task commands, but defer full options to `kspec help agent dispatch` and child help. Explain `start` versus `resume`, `draining`, matching-scope cleanup, canonical alias handling, no-op versus invalid transition, hard-stop confirmation/`--force`, dispatch-owned host-stop rejection, and evidence preservation.
    - Mention canonical `POST /api/agent/dispatch/control`, public `GET /api/agent/status`, and agents-view equivalents without duplicating complete generated schemas. Distinguish public snake-case wire fields from UI camelCase only where a public API reader needs it.
    - Do not claim lifecycle control changes task state, clears degraded targets, deletes workspaces, checkpoints work, guarantees exact FIFO, controls arbitrary one-shot runs, or can always finish cleanup when ownership cannot be proven.

    Required tests:
    - Compare documented command/action tables to the exported Commander tree and public lifecycle action helpers/fixtures.
    - Exercise global/task transition examples, aliases/canonical ids, matching-scope cleanup, status fields, API/UI projections, hard-stop safety, accessibility/static behavior, and any documented event names through public schemas/helpers/fixtures.
    - Fail on command-tree drift, unsupported action/scope, alias stored as canonical id, blanket aggregate-cleanup gating, or invented workspace procedure; do not snapshot prose style.

    Verification:
    - `npm test -- tests/dispatch-operator-docs.test.ts tests/cli-agent-dispatch-lifecycle.test.ts tests/daemon-agent-dispatch-lifecycle.test.ts tests/web-ui/dispatch-lifecycle-controls.test.ts tests/dispatch-control-events.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer walks global pause/resume, global hard stop/retry, task alias pause/resume, task hard stop with unrelated work, static UI, and one failure from source fixture through the guide. Product ACs remain evidence, not documentation deliverables.

- title: Publish the dispatch workspace concept and correct the dispatch overview
  slug: task-document-dispatch-workspace-concept
  priority: 1
  spec_ref: "@docs-concepts-section"
  tags: [docs, dispatch, concepts]
  depends_on:
    - "@task-document-dispatch-lifecycle-controls"
  description: |
    Covers (documentation ownership only):
    - @docs-concepts-section ac-1, ac-2
    - @default-project-agents-and-conventions ac-task-worker-agent, ac-pr-reviewer-agent, ac-primary-dev-agent, ac-plan-reviewer-agent

    Factual source authorities (read-only):
    - @dispatch-lifecycle-control-authority ac-controls-do-not-change-readiness, ac-session-evidence-survives-control, ac-workspace-evidence-survives-control
    - @dispatch-workspace-cleanup-policy ac-1, ac-2, ac-controlled-evidence-protected

    What:
    Create the durable workspace mental model, index it, and keep `agents-and-dispatch.md` as the short overview linking to workspace configuration, lifecycle controls, and recovery.

    Files:
    - Create: `docs/concepts/dispatch-workspaces.md`
    - Modify once in this plan: `docs/concepts/index.md`, `docs/concepts/agents-and-dispatch.md`
    - Modify creator-owned test: `tests/dispatch-operator-docs.test.ts`

    Required concept sections:
    - What a dispatch workspace is; Why isolation exists; Target/task identity; Worker continuity; Detached reviewer lifecycle; Fix cycle; Bootstrap state; Integration/publication; Lifecycle authority versus task readiness; Evidence/cleanup ownership; Operator ownership; Current limitations; Related operations.
    - Keep transition procedures on the lifecycle guide. Explain only the durable distinction: controls govern admission/cancellation, while workspace lifecycle and task state remain separate.
    - Replace “kspec ships with four built-in agents” with “`kspec setup` scaffolds default agent definitions”; projects can configure/rename them and the live registry is authoritative.

    Required tests:
    - Render headings, index membership, stable links/anchors, overview cross-links, and absence of release-sensitive schema/flag dumps.
    - Verify scaffold wording through setup fixtures and the exact default-agent ACs above.

    Verification:
    - `npm test -- tests/dispatch-operator-docs.test.ts tests/web-ui-docs-rendering.test.ts tests/setup-builtin-agents.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Confirm the concept separates readiness, lifecycle authority, workspace state, degraded state, and cleanup rather than collapsing them.

- title: Publish symptom-first bootstrap workspace and lifecycle recovery pages
  slug: task-document-dispatch-recovery
  priority: 1
  spec_ref: "@docs-troubleshooting-section"
  tags: [docs, dispatch, troubleshooting]
  depends_on:
    - "@task-document-dispatch-workspace-concept"
  description: |
    Covers (documentation ownership only):
    - @docs-troubleshooting-section ac-1, ac-2, ac-3

    Factual source authorities (read-only):
    - @dispatch-lifecycle-control-authority ac-stop-failure-retains-stopped-authority, ac-stop-failure-reports-pending-cleanup, ac-stop-failure-reports-no-success, ac-interrupted-stop-recovers-on-startup, ac-interrupted-stop-recovers-on-retry, ac-task-stop-failure-retains-stopped-authority, ac-task-stop-failure-reports-pending-cleanup, ac-task-interrupted-stop-recovers-on-retry, ac-recovery-requires-session-ownership, ac-recovery-requires-process-birth, ac-missing-leader-live-group-remains-pending, ac-unverified-live-group-is-not-signalled
    - @daemon-agent-dispatch ac-control-error-current-status, ac-control-missing-identity, ac-control-identity-mismatch, ac-control-failure-no-success, ac-cleanup-failure-no-success
    - @ui-agent-dispatch ac-stopped-actions-valid, ac-hard-stop-confirmation-cancelled, ac-lifecycle-live-update
    - @dispatch-remote-branch-sync ac-no-remote, ac-transient-no-degrade, ac-divergence-enters-degraded, ac-degraded-status-api

    What:
    Create three indexed recovery pages and correct assignment troubleshooting. Recovery stays within supported status, matching-scope retry, configuration correction, normal reconciliation, or escalation.

    Files:
    - Create: `docs/troubleshooting/dispatch-bootstrap-failures.md`
    - Create: `docs/troubleshooting/dispatch-workspace-sync-and-cleanup.md`
    - Create: `docs/troubleshooting/dispatch-lifecycle-control-failures.md`
    - Modify once in this plan: `docs/troubleshooting/index.md`, `docs/troubleshooting/dispatch-refuses-to-assign.md`
    - Modify creator-owned test: `tests/dispatch-operator-docs.test.ts`

    Required symptom blocks:
    - Bootstrap: nonzero exit, tracked-file mutation, reviewer rerun refusal, invalidated cached state, inaccessible workspace, and unsafe output exposure, only where Task 1 proves an observable.
    - Workspace: target/config mismatch, plan target change, path collision, stale/unrecoverable registry, local-only mode, transient sync, divergence, occupied checkout, deferred reviewer sync, cleanup protection, unknown root entries, and retention, only where proven.
    - Lifecycle: invalid start/resume/pause transition; held task not starting; task alias not found/ambiguous/mismatched; stopped with pending/failed cleanup; control store unavailable/corrupt/commit failure; ownership/birth/group verification limitation; host-stop rejection; confirmation/`--force`; static UI read-only. For each give meaning, supported observation, safe procedure, healthy result, and concept/guide link.
    - Retry only the matching global/task hard stop where status offers it. Successful cleanup leaves stopped authority until explicit start/resume as applicable. Never tell users to edit `.kspec/dispatch-control.yaml`, session ownership, registry metadata, process ids/groups, or managed worktrees manually.
    - In `dispatch-refuses-to-assign.md`, add lifecycle authority/held status as a distinct admission check and describe automation filtering per rule/event; preserve eligible-only worker defaults without claiming every reviewer/arbitrary event is eligible-only.

    Required tests:
    - Verify symptom/meaning/procedure/healthy-outcome structure and guide/concept links.
    - Validate every command against captured help; validate failure/status examples through public fixtures; reject unsupported reset/cleanup procedures and blanket eligible-only or aggregate-cleanup claims.

    Verification:
    - `npm test -- tests/dispatch-operator-docs.test.ts tests/web-ui-docs-rendering.test.ts tests/dispatch-lifecycle-surface-integration.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Walk one bootstrap failure, one target divergence, one invalid lifecycle transition, one failed cleanup, and one identity failure from integrated evidence to safe recovery.

- title: Correct top-level package scaffold release and generated guidance drift
  slug: task-correct-adjacent-public-guidance
  priority: 2
  spec_ref: "@readme-landing-page"
  tags: [docs, setup, templates, release]
  depends_on:
    - "@task-document-dispatch-recovery"
  description: |
    Covers (documentation ownership only):
    - @readme-landing-page ac-1, ac-2
    - @docs-release-notes-availability ac-1, ac-2
    - @default-project-agents-and-conventions ac-agents-md-reflects-defaults

    Factual source authorities (read-only):
    - @cli-agent-commands ac-start-reports-authority, ac-pause-reports-authority, ac-resume-reports-authority, ac-task-control-canonicalization
    - @dispatch-event-taxonomy ac-dispatch-control-domain

    What:
    Audit and factually correct non-`docs/` public landing/contributor/package surfaces, setup/upgrade discoverability, and source-owned generated guidance. Make no product/default change.

    Exact owned surfaces:
    - `README.md`, `INSTALL.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RELEASE_NOTES.md`, `packages/web-ui/README.md`, `.github/ISSUE_TEMPLATE/maintainer-approved-issues-and-features.md`.
    - Non-behavioral comments/links only in `src/cli/commands/setup.ts` and `src/cli/commands/upgrade.ts`; do not add keys, change defaults, or change command behavior.
    - `templates/agents-sections/**/*.md`, `templates/skills/**/*.md`, and `templates/skills/manifest.yaml` only where inventory evidence shows factual/discoverability drift. Author only in sources; regenerate tracked `.agents`/`.factory`, `kspec-agents.md`, and ignored plugin output.

    Required corrections and tests:
    - Correct the v0.12 publication-mode row to `manual_merge`, `pull_request`, and `auto` while preserving historical tense.
    - Ensure setup/upgrade scaffolds and package guidance discover lifecycle controls/help accurately if they currently mention dispatch operation; do not force lifecycle prose into unaffected surfaces.
    - Keep README concise with one-click Getting Started/Concepts/Guides links. Apply semantic package-neutrality review in both directions.
    - Parse changed snippets, run scaffold snapshots, regenerate twice, and require the second generation to be clean.

    Verification:
    - `npm test -- tests/docs-readme-structure.test.ts tests/scaffold-project-config.test.ts tests/upgrade-command.test.ts tests/dispatch-operator-docs.test.ts`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `git diff --exit-code -- kspec-agents.md .agents .factory`
    - `npm run format:check`

    Review handoff:
    Report every changed surface, evidence, generated convergence, and a separate package-neutrality judgment. An inventory disposition of “no drift” is valid and must not force an edit.

- title: Audit and correct the remaining declared public documentation universe
  slug: task-audit-remaining-public-docs
  priority: 2
  spec_ref: "@docs-getting-started-section"
  tags: [docs, audit, consistency]
  depends_on:
    - "@task-correct-adjacent-public-guidance"
  description: |
    Covers (documentation ownership only):
    - @docs-getting-started-section ac-1, ac-2, ac-3
    - @docs-section-taxonomy ac-1, ac-2
    - @docs-release-notes-availability ac-1, ac-2

    Factual source authorities (read-only):
    - @dispatch-lifecycle-control-authority ac-controls-survive-restart, ac-controls-do-not-change-readiness, ac-controls-do-not-change-degraded-targets
    - @cli-agent-commands ac-4, ac-5, ac-6, ac-9, ac-13
    - @dispatch-remote-branch-sync ac-degraded-status-api, ac-no-remote

    What:
    Complete the factual pass over every declared surface not owned by Tasks 2-6, refresh all dispatch facts after page slices, and close every inventory record without style-only churn.

    Exact owned file sets:
    - Modify `tests/fixtures/public-documentation-surfaces.json` to add the six pages created by Tasks 2-5 with their evidence/dispositions.
    - All existing `docs/getting-started/**/*.md`.
    - Existing `docs/guides/**/*.md` excluding `configuring-dispatch-workspaces.md`, `controlling-dispatch-lifecycle.md`, `configuring-agent-runners.md`, and `guides/index.md`.
    - Existing `docs/concepts/**/*.md` excluding `dispatch-workspaces.md`, `agents-and-dispatch.md`, and `concepts/index.md`.
    - Existing `docs/troubleshooting/**/*.md` excluding the three created recovery pages, `dispatch-refuses-to-assign.md`, and `troubleshooting/index.md`.
    - `docs/release-notes/index.md` and remaining active-public `docs/**/*.md` not historical/internal-eval.
    - Historical/internal-eval/internal-agent-guidance/fixture records receive their declared limited checks/disposition only.
    - Modify `tests/public-documentation-inventory.test.ts` to remove the six-path construction allowance and enforce strict closure; do not modify `tests/dispatch-operator-docs.test.ts` or prior-task prose.

    Source-of-truth checks:
    - Commands against captured Commander help; YAML/defaults/enums against exported schemas/resolved config; lifecycle/API/UI statements against Task 1 facts and public fixtures; setup/upgrade against scaffold tests; navigation/link/anchor claims against rendering; release notes against canonical source.
    - Recheck approved reviewed lifecycle tip `3f22e6c93c68115d77e1bde062f7cd12034f91d8`, any genuinely later approved lifecycle fix, and current remote-sync status. Correct owned documentation; record product contradictions as limitations/follow-up evidence, not implementation.
    - Add the six pages created by Tasks 2-5 to `tests/fixtures/public-documentation-surfaces.json`, assign evidence/disposition to them and every other manifest record, and remove the temporary pending-addition allowance. Preserve historical text except dangerous unsupported current instructions.

    Required tests:
    - Full manifest closure; relative links/anchors; landing membership/order; release-note single-source equivalence; tagged snippet validation; generated-source ownership.

    Verification:
    - `npm test -- tests/public-documentation-inventory.test.ts tests/docs-readme-structure.test.ts tests/folder-backed-resource-docs.test.ts tests/resource-ui-task-markdown-docs.test.ts tests/web-ui-docs-rendering.test.ts tests/web-ui-docs-search.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`
    - `npm run typecheck`

    Review handoff:
    Reviewer samples every classification/topic, compares manifest to independently derived universes, and rejects silent omission, unsupported normative commands, style-only sweeps, or edits to prior owners.

- title: Close structured documentation drift gates and rendered browser validation
  slug: task-close-documentation-drift-gates
  priority: 2
  spec_ref: "@docs-navigation-shape"
  tags: [docs, testing, web-ui]
  depends_on:
    - "@task-audit-remaining-public-docs"
  description: |
    Covers (documentation ownership only):
    - @docs-navigation-shape ac-1, ac-2
    - @docs-search ac-1, ac-2, ac-3
    - @docs-reachability ac-1, ac-2, ac-3
    - @auto-cli-docs ac-1, ac-3, ac-4, ac-5

    Factual source authorities (read-only):
    - @cli-agent-commands ac-declined-stop-sends-no-request, ac-declined-stop-exit, ac-task-control-canonicalization, ac-lifecycle-status-authority, ac-lifecycle-status-projection, ac-lifecycle-status-active-count, ac-lifecycle-status-queued-count, ac-lifecycle-status-held-count
    - @daemon-agent-dispatch ac-5, ac-6, ac-public-status-lifecycle-additions, ac-control-error-current-status
    - @ui-agent-dispatch ac-status-active-work-visible, ac-status-queued-work-visible, ac-status-held-work-visible, ac-stopped-actions-valid, ac-lifecycle-controls-labelled, ac-lifecycle-focus-retained, ac-lifecycle-live-update
    - @dispatch-event-taxonomy ac-dispatch-control-domain

    What:
    Harden Task 1 tests after all content exists, validate navigation/search/static rendering and browser accessibility, regenerate package outputs, and report focused success separately from the unrelated refs baseline.

    Files:
    - Modify: `tests/public-documentation-inventory.test.ts`, `tests/dispatch-operator-docs.test.ts`, `tests/web-ui-docs-rendering.test.ts`, `tests/web-ui-docs-search.test.ts`, `tests/e2e/docs.spec.ts`
    - Modify `scripts/build-docs-search.cjs` only if a factual indexing defect is exposed.
    - Validate `tests/fixtures/public-documentation-surfaces.json` as closed by Task 7; do not modify it in Task 8.
    - No prose edits except through the declared owner; do not repair prior files in parallel.

    Required gates:
    - Structured schema/default/enum comparisons; tagged examples; complete command tree including global/task lifecycle nodes; transition/alias/status/cleanup/recovery/API/UI/event facts; inventory/link/anchor/index closure; generated convergence; search inclusion for all six new pages; desktop/mobile sidebar, current page, TOC anchors, offline/static rendering, and no raw Markdown link leaks.
    - Browser docs QA searches for and reaches workspace configuration, lifecycle controls, workspace concept, and all three recovery pages at wide/narrow viewports. Lifecycle docs links reach the agents UI where available; static/public docs remain readable without daemon mutation. Accessibility assertions use rendered semantics, labels, focus/live behavior fixtures, not CSS/style policing.
    - Negative fixtures target concrete drift: legacy `trigger`/`filters`, unsupported workspace command, wrong global/task action, alias/canonical mismatch, omitted status field, aggregate cleanup used as blanket gate, stale API/UI projection, undocumented event mismatch, missing inventory record, broken anchor, unpaired generated output, and generated file treated as source.
    - Regenerate twice and prove second-run cleanliness. Build docs search/web UI and run focused browser docs QA.

    Baseline validation policy:
    - Changed/focused plan gates, formatting, lint, typecheck, tests, generation, search, web build, and docs E2E must pass.
    - Run `kspec validate --alignment --warnings-ok` and `kspec validate --completeness --warnings-ok` as focused state checks.
    - At plan revision time, a fresh verbose `kspec validate --refs --warnings-ok` exits 0 with `References: OK` and six deprecation warnings: `@session-summary-cache` from tasks `01KKB3PHA6MSJDZS7AZ1Z2VN6A`, `01KKSRDQY1HZBENKBD06V6KDGW`, and `01KMMB3WY8E1JYRGHBHZ4RMH9E`; and `@task-activity-git-query` from tasks `01KKW4VPB0MV22C92JHNR7APJZ`, `01KKW6PK9QFXKH69HE6KY8Q40Y`, and `01KKWG44FR0W955X7EFVBHPX6B`.
    - Run a fresh execution-time refs validation under the chosen warnings policy. Require no new or changed reference errors, compare every warning to that fresh baseline, and either preserve an evidenced pre-existing disposition or record an intentional plan-owned disposition. Do not add unrelated deprecation-warning cleanup to this documentation plan; fix a warning here only if this plan introduces or changes it.
    - Claim project-wide refs green only when that fresh execution-time run passes under the explicitly chosen warnings policy; do not infer green from revision-time evidence or from focused documentation gates.

    Verification:
    - `npm test -- tests/dispatch-operator-docs.test.ts tests/public-documentation-inventory.test.ts tests/docs-readme-structure.test.ts tests/web-ui-docs-rendering.test.ts tests/web-ui-docs-search.test.ts`
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
    - `kspec validate --refs --warnings-ok` (fresh comparison under the chosen warnings policy)

    Review handoff:
    Supply inventory diff, final-reviewed-tip source facts, focused/full tests, generated-clean proof, desktop/mobile/static evidence, accessibility evidence, and exact refs-baseline comparison. Claim only this plan's gates, not review approval or project-wide green.
```

## Implementation Notes

### Slice and page ownership order

1. Task 1 is the sole creator of the manifest, fact fixture, and two shared documentation tests. It starts only from the approved reviewed integrated lifecycle target and refreshes only for a genuinely later approved lifecycle fix/review.
2. Task 2 owns workspace configuration and runner-example correction. Task 3 depends on it, owns the dedicated lifecycle guide and the guide index, and adds both guide links only after both targets exist.
3. Task 4 owns the workspace concept, concept index, and short overview. Task 5 owns three recovery pages, troubleshooting index, and assignment correction. Shared-test writes are transitively serialized.
4. Task 6 owns non-`docs/` public/package/scaffold/generated corrections. Task 7 owns the explicit remainder of `docs/`, adds the six Tasks 2-5 pages to `tests/fixtures/public-documentation-surfaces.json`, and closes the inventory. Its prose file sets exclude Tasks 2-5.
5. Task 8 modifies shared gates only after all content exists and validates, but does not modify, Task 7's closed manifest. A prose correction returns to its declared owner instead of creating a parallel write. The graph is a single acyclic chain of eight standalone slices.

### Documentation versus product ownership

No product spec patch is proposed. Lifecycle refs and ACs appear only under “Factual source authorities” so workers know which implemented contracts to verify; `Covers` lists only documentation/spec owners for documentation work. If source review reveals missing product behavior or a genuinely ownerless documentation contract, stop and obtain separate approval rather than adding product scope here.

### Current integration and conditional freshness

Final task review `@01KXPCP5Y3Y0BEY2KP8KDFXNS8` approved examined commit `b28c29557d3ec15ee1cfc0b14c6d2ee5a57b86aa`, and the completed task is integrated at remote lifecycle target tip `3f22e6c93c68115d77e1bde062f7cd12034f91d8`; no lifecycle review is open. Local and `origin/dev` do not yet contain that reviewed tip, and the lifecycle plan may remain administratively `active`, so Task 1 must start from a target that does contain it. Only a genuinely later approved lifecycle fix/review supersedes this evidence and triggers another fact refresh. The earlier approved documentation reviews `@01KXH7G6DBP8RRS39VKMPWE28M` and `@01KXH7BNXKV4KXA7AVSJ14GGB3` predate this revision and do not approve it.

### Completion claim

Completion means the documentation plan's changed/focused gates pass and every declared public-surface record has evidence. It does not mean this revised plan has been reviewed or approved, remote sync is complete, unrelated deprecation warnings are fixed, or project-wide refs are green without a fresh passing execution-time run under the chosen warnings policy.
