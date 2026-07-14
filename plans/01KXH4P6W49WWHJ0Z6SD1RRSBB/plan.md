# Documentation Completeness and Dispatch Workspaces

**Goal:** Correct and complete Kynetic Spec's active public documentation, with a fully supported dispatch/bootstrap/workspace operator story and a deterministic whole-surface consistency pass.

**Architecture:** Resolve product contracts before publishing normative prose, then add one dispatch configuration guide, one workspace lifecycle concept page, focused recovery pages, and corrections across adjacent package surfaces. Finish from a machine-readable public-surface inventory and automated comparisons against schemas, CLI help, setup scaffolds, generated guidance, and rendered documentation.

**Plan shape:** This plan amends existing owners rather than inventing documentation or dispatch siblings: `@user-documentation`, `@agent-definition-schema`, `@agent-dispatch-engine`, `@cli-agent-commands`, `@dispatch-workspace-configuration`, `@dispatch-runtime-bootstrap-contract`, `@dispatch-workspace-registry`, `@dispatch-workspace-cleanup-policy`, and `@dispatch-remote-branch-sync`. Therefore it intentionally omits `## Specs`; existing-spec changes are applied by the owning prerequisite tasks, and `derive_from_specs: false` derives only the explicit tasks below.

## Binding Audit and Information Architecture

The public overview at `docs/concepts/agents-and-dispatch.md` explains routing but does not explain dispatcher-managed workspace configuration or operations. The implementation and internal requirements already expose a substantially larger contract through `src/parser/config.ts`, `src/schema/meta.ts`, `src/agent-runtime/bootstrap.ts`, `src/agent-runtime/workspace.ts`, `src/agent-runtime/dispatch.ts`, `src/schema/dispatch-workspace.ts`, workspace tests, and the existing dispatch specs.

The documentation architecture is fixed for this plan:

- Create `docs/guides/configuring-dispatch-workspaces.md` for configuration and operational setup.
- Create `docs/concepts/dispatch-workspaces.md` for worker/reviewer/fix-cycle lifecycle and ownership concepts.
- Create `docs/troubleshooting/dispatch-bootstrap-failures.md` for bootstrap diagnostics and safe retry.
- Create `docs/troubleshooting/dispatch-workspace-sync-and-cleanup.md` for provisioning, target drift, remote sync, health, reset, cleanup, and retention recovery.
- Keep `docs/concepts/agents-and-dispatch.md` as the short dispatch overview and link to the new pages rather than duplicating their contracts.
- Keep named-runner configuration in `docs/concepts/agent-runners.md` and `docs/guides/configuring-agent-runners.md`; explain bootstrap/runner environment separation by cross-linking, not by merging the two configuration models.
- Update `docs/concepts/index.md`, `docs/guides/index.md`, `docs/troubleshooting/index.md`, README links only where their existing concise role permits, and the rendered docs navigation/search through the existing build pipeline.
- Treat `templates/skills/` and `templates/agents-sections/` as package-neutral sources. Regenerate `.agents/skills/`, `.factory/skills/`, `kspec-agents.md`, and the ignored plugin output from their owners. Kynetic-only branch names, agent ids, quality gates, and review policy remain in `AGENTS.md`, project-local meta, or project-local skills.

Known facts that documentation tasks must not rediscover or reinterpret:

- Project bootstrap steps precede current-agent bootstrap steps; declaration order is retained within each source.
- Current step defaults are no role filter, `idempotent: false`, `allow_tracked_changes: false`, and `reviewer_rerun_allowed: false`.
- A role-less step applies to worker and reviewer. Reviewer execution may reuse valid worker state only when there are no reviewer-applicable steps; otherwise reviewer reruns are limited to idempotent or explicitly reviewer-rerunnable steps. Config changes, canonical branch-head changes, and prior failure invalidate cached role state.
- Bootstrap currently executes `bash -lc` in the selected role worktree. It inherits the daemon host environment except dispatch runtime-mode keys, adds dispatch workspace variables and `KSPEC_DISPATCH_BOOTSTRAP_ROLE`, `KSPEC_DISPATCH_BOOTSTRAP_SOURCE`, and `KSPEC_DISPATCH_BOOTSTRAP_STEP`, and does not apply named-runner env policy or runner secret bindings. The runner receives its separately resolved environment after bootstrap.
- The tracked-change guard compares tracked status only (`git status --porcelain --untracked-files=no`); untracked/ignored dependency artifacts are not rejected. Failure details currently retain a 4,000-character output tail in managed workspace state, so normative secret handling must wait for Task 1.
- Bootstrap is a dispatch-workspace preflight, not part of `kspec agent run` one-shot invocation.
- `dispatch.base_branch` resolves remote HEAD, then the current symbolic branch of the main checkout, then `main`; plan-scoped task targeting can override the project fallback. The resolved target is persisted for continuity.
- Relative `dispatch.worktree_root` resolves from project root; absolute paths are used as-is; default is `.kspec-worktrees`. The root is dispatcher-owned, and cleanup may remove unknown unprotected entries directly under it. Relative roots are managed in the kspec `.gitignore` block; absolute external roots cannot be represented by repository `.gitignore`.
- `dispatch.publication_mode` accepts `pull_request`, `manual_merge`, and `auto`; `auto` resolves to pull request only when `gh` is available and a GitHub remote exists, otherwise manual merge. `RELEASE_NOTES.md` currently omits `auto`.
- `dispatch.sync_interval` defaults to 60 seconds; zero disables periodic target sync but not start/before-provision sync. `dispatch.remote_sync` omitted means runtime detection from remote presence; false is local-only. `@dispatch-remote-branch-sync` is still `in_progress`, so Task 3 gates normative remote-sync recovery prose.
- Worker worktrees preserve canonical task-branch continuity across `in_progress` and `needs_work`; reviewer worktrees are detached snapshots and normally become immediately cleanup-eligible after review. Registry state records lifecycle, bootstrap, integration, health, cleanup, and timestamps; closed records are retained only until the implementation's retention threshold.
- Current CLI help has `kspec agent dispatch start|stop|status|watch` and no workspace inspect/reset command. Runtime guidance currently suggests nonexistent `kspec dispatch workspace reset`; no documentation task may publish that command before Task 2 lands.
- Agent dispatch rule schema uses `on` and `filter`. `docs/guides/configuring-agent-runners.md` incorrectly uses `trigger` and `filters` in two examples.
- Automation eligibility is event/rule-specific: default worker `task.ready` and `task.needs_work` rules require eligible automation, while explicitly filtered rules, reviewer events, and arbitrary registered events cannot be described by a blanket “all dispatch requires automation eligible” statement.

## Tasks

derive_from_specs: false

```yaml
- title: Close the bootstrap authoring, execution-bound, and secret-output contracts
  slug: task-close-bootstrap-public-contract
  priority: 1
  spec_ref: "@dispatch-runtime-bootstrap-contract"
  tags: [dispatch, bootstrap, cli, security]
  description: |
    Covers:
    - @dispatch-runtime-bootstrap-contract ac-1 through ac-6 and ac-11 through ac-13
    - @agent-definition-schema ac-9, ac-10, ac-12

    What:
    Make the already-supported project and per-agent bootstrap schema safely authorable and bounded before public documentation treats it as an operator feature. This task owns exact existing-spec amendments and implementation; it does not write the new public guide.

    Why:
    `dispatch.bootstrap.steps` is editable in `kspec.config.yaml`, but per-agent `bootstrap.steps` has no supported meta CLI authoring surface. Bootstrap hardcodes `bash`, has no subprocess timeout, and persists an output tail without a complete redaction contract. Documentation must not paper over those gaps.

    How:
    - Add `--bootstrap-steps <json>` and `--clear-bootstrap` to `kspec meta add agent` and `kspec meta set <agent>`. The JSON value is the complete ordered step array using schema keys `run`, optional `name`, optional `roles`, optional `idempotent`, optional `allow_tracked_changes`, optional `reviewer_rerun_allowed`. Reject non-arrays, unknown fields, empty commands, invalid roles, and malformed JSON without mutating meta state. `set` replaces only `bootstrap.steps`; `clear` removes the bootstrap block; all unrelated agent fields remain byte-semantically preserved.
    - Add optional `timeout_seconds` to project and agent bootstrap-step schemas. Resolve omitted values to 600 seconds; accept positive integers only. Include the resolved timeout in the bootstrap config hash and persisted step result. Kill the step process group on timeout, record a stable timeout failure classification, and never hand off to the adapter after timeout.
    - Keep `bash -lc` as the version-1 shell contract. Before any step, preflight that `bash` is resolvable/executable and fail with actionable guidance if absent. Do not silently fall back to another shell.
    - Redact persisted and operator-visible bootstrap output before it reaches workspace metadata or thrown error text. Reuse the repository's credential-name/value redaction primitives: replace values from inherited environment keys classified as credentials, runner/system secret bindings if present in the host environment, bearer-token forms, and credential-shaped command arguments with `[REDACTED]`. Preserve only the final 4,000 redacted characters. Document in code comments and tests that redaction is defense in depth and bootstrap commands must not print secrets.
    - Preserve the current environment split: bootstrap inherits host env minus `DAEMON_RUNTIME_MODE_ENV_KEYS`, receives dispatch/bootstrap injected variables, and never consumes named-runner `env.inherit/pass/set/secrets`; runner resolution remains a later, separate spawn boundary.
    - Amend existing specs with these exact ACs, preserving all existing IDs/metadata: add `@agent-definition-schema ac-bootstrap-cli-authoring` (Given a valid ordered bootstrap step array / When meta add or set receives `--bootstrap-steps` / Then that array is stored on the selected agent while unspecified fields are preserved); add `ac-bootstrap-cli-clear` (Given an agent has bootstrap configuration / When meta set receives `--clear-bootstrap` / Then only that bootstrap configuration is removed); add `@dispatch-runtime-bootstrap-contract ac-bootstrap-shell-preflight` (Given bootstrap steps exist / When preflight cannot resolve executable bash / Then invocation is not launched and actionable shell guidance is recorded); add `ac-bootstrap-step-timeout` (Given a bootstrap step exceeds its resolved timeout / When the bound expires / Then its process group is terminated and invocation is not launched); add `ac-bootstrap-output-redaction` (Given bootstrap output contains recognized credential material / When failure or step state is persisted or displayed / Then recognized credential material is replaced by a redaction marker); add `ac-bootstrap-runner-env-separation` (Given an agent uses a named runner / When bootstrap executes / Then runner env and secret bindings are not applied to bootstrap).

    Files:
    - Modify: `src/schema/meta.ts`, `src/parser/config.ts`, `src/cli/commands/meta.ts`, `src/agent-runtime/bootstrap.ts`
    - Modify focused tests: `tests/meta.test.ts`, `tests/meta-agent-schema.test.ts`, `tests/parser/config.test.ts`, `tests/dispatch-runtime-bootstrap-contract.test.ts`, and the existing bootstrap/runner environment test files selected by implementation

    Required tests:
    - Add/set/replace/clear round trips and malformed-input no-mutation assertions.
    - Default and explicit timeout, process-group termination, missing bash, ordered execution, project-before-agent ordering, and unchanged tracked-file guard behavior.
    - Redaction in success/failure state and thrown diagnostics using sentinel secrets; assert ordinary non-secret output remains useful.
    - Assert bootstrap does not receive runner-only env or runner secret values while the later runner spawn still does.

    Verification:
    - `npm test -- tests/meta.test.ts tests/meta-agent-schema.test.ts tests/parser/config.test.ts tests/dispatch-runtime-bootstrap-contract.test.ts`
    - `npm run typecheck`
    - `npm run lint`
    - `kspec meta add --help`
    - `kspec meta set --help`
    - `kspec validate --warnings-ok`

    Review handoff:
    Reviewer must verify the new CLI is the only documented mutation path for per-agent bootstrap, raw sentinel secrets do not enter persisted metadata/errors, and timeout cleanup leaves no child process.

- title: Add supported dispatch workspace inspection, reset, and cleanup operations
  slug: task-add-dispatch-workspace-operator-surface
  priority: 1
  spec_ref: "@dispatch-workspace-registry"
  tags: [dispatch, workspace, cli, safety]
  description: |
    Covers:
    - @dispatch-workspace-configuration ac-2 through ac-4 and ac-6 through ac-8
    - @dispatch-workspace-registry ac-3 through ac-10 and ac-14
    - @dispatch-workspace-cleanup-policy ac-1 through ac-6 and all artifact-protection ACs
    - @cli-agent-commands ac-9

    What:
    Provide a supported, read-only-first operator surface for rich workspace state and a guarded path for the target-drift reset and cleanup recovery that runtime errors already recommend.

    Why:
    Registry state is rich but internal. Current runtime guidance names nonexistent `kspec dispatch workspace reset`, and asking operators to edit shadow-managed registry files or manually run git worktree commands would violate ownership and safety contracts.

    How:
    - Extend the real command hierarchy as `kspec agent dispatch workspace list`, `show <task-ref>`, `reset <task-ref>`, and `cleanup [task-ref]`; remove every runtime suggestion for `kspec dispatch workspace reset`.
    - `list` and `show` are read-only, work while dispatch is stopped, support `--json`, and project sanitized registry fields: canonical task/workspace identity, resolved target and branch provenance, role worktree paths/modes, lifecycle, role bootstrap summary/invalidation reasons (never command output), integration, health issues/suggestions, cleanup status, and timestamps.
    - `reset` is narrowly an integration-target reset/re-provision permission, not arbitrary registry deletion. Require no active/in-flight invocation, a non-terminal task, no unresolved merge/integration result, and a clean canonical worker branch. Require `--reason`; interactive mode confirms; non-interactive/JSON requires `--force`. On success, persist `integration.status: reset`, reconcile the configured/plan target, and re-provision through existing protected workspace APIs. Unsafe cases exit with actionable guidance and no mutation.
    - `cleanup` invokes existing policy rather than deleting paths directly. Default is a dry-run classification showing protected, eligible, or blocked artifacts. Mutation requires `--force`, refuses active/in-flight/provisioning ownership, persists cleanup transitions, and retains blocked evidence. Without a task ref it scans only the configured dispatcher-owned root.
    - Treat the configured worktree root as exclusive dispatcher ownership. Preserve current semantics that unknown unprotected direct children may be removed. Reject a root equal to the project root, shadow worktree, session root, or a parent/child overlap with those protected roots. Relative roots are maintained in the managed `.gitignore` block; absolute roots are explicitly not representable there.
    - Preserve the existing closed-record retention constant as implementation source of truth and expose the effective duration in `workspace show --json`/human status instead of duplicating a magic number in docs.
    - Amend existing owners with exact ACs: add `@dispatch-workspace-registry ac-operator-inspection` (Given workspace state exists / When list or show is requested / Then sanitized lifecycle, bootstrap, integration, health, cleanup, ownership, and timestamp state is returned without bootstrap output); add `@dispatch-workspace-configuration ac-guarded-target-reset` (Given a recorded target conflicts with current target configuration / When guarded reset prerequisites hold / Then reset permits reconciliation and re-provisioning to the current target); add `@dispatch-workspace-cleanup-policy ac-operator-cleanup-uses-policy` (Given an operator requests cleanup / When artifacts are classified / Then destructive action occurs only through existing protection and cleanup policy); add `ac-dispatch-root-exclusive-ownership` (Given a configured dispatch root is accepted / When cleanup scans direct children / Then unprotected children are dispatcher-owned and protected repository/shadow/session roots cannot overlap it); add corresponding `@cli-agent-commands` ACs for workspace list/show/reset/cleanup human and JSON output and dry-run precedence.

    Files:
    - Modify: `src/cli/commands/agent.ts`, `src/agent-runtime/workspace.ts`, `src/schema/dispatch-workspace.ts`, `src/parser/dispatch-workspaces.ts`, `src/parser/config.ts`, `src/parser/gitignore.ts`
    - Modify: runtime suggestion sites in `src/agent-runtime/workspace.ts`
    - Test: create `tests/dispatch-workspace-cli.test.ts`; modify focused workspace config/registry/cleanup/provenance tests and `tests/gitignore-managed-block.test.ts`

    Required tests:
    - Full human/JSON list/show projections and absence of command output/secrets.
    - Safe reset, target conflict repair, active/dirty/integration/terminal refusal, confirmation/force/exit behavior, and no-mutation failures.
    - Cleanup dry run versus force, all protection classes, blocked evidence, custom relative root, absolute root, and prohibited overlap.
    - Help snapshot proves the supported command path and no source/runtime string suggests the nonexistent old path.

    Verification:
    - `npm test -- tests/dispatch-workspace-cli.test.ts tests/dispatch-workspace-config.test.ts tests/dispatch-workspace-registry.test.ts tests/dispatch-workspace-cleanup.test.ts tests/gitignore-managed-block.test.ts`
    - `npm run typecheck`
    - `npm run lint`
    - `kspec agent dispatch workspace --help`
    - `kspec validate --warnings-ok`

    Review handoff:
    Reviewer must try list/show against fixture records and verify reset/cleanup cannot bypass active ownership, Git safety, registry persistence, or the shadow mutation path.

- title: Finish and expose the remote-sync operator contract
  slug: task-finish-dispatch-remote-sync-contract
  priority: 1
  spec_ref: "@dispatch-remote-branch-sync"
  tags: [dispatch, git, sync, status]
  description: |
    Covers:
    - @dispatch-remote-branch-sync all acceptance criteria
    - @agent-dispatch-engine ac-8, ac-19, ac-25

    What:
    Close the existing `in_progress` remote-sync requirement before troubleshooting prose presents it as generally available, and make status sufficient for an operator to distinguish disabled, transient, degraded, deferred, and recovered states.

    Why:
    Schema/defaults and much runtime behavior exist, but readiness is not established by status alone. Normative docs must be based on an implemented contract rather than selectively describing an in-progress feature.

    How:
    - Audit every AC on `@dispatch-remote-branch-sync` against `src/agent-runtime/dispatch.ts`, workspace integration/cleanup paths, daemon status routes, CLI status, and focused tests; implement missing behavior or tighten incorrect stale tests. Do not weaken ACs to match omissions.
    - Add a sanitized status projection for effective `remote_sync`, selected remote, `sync_interval`, per-target last success, transient failure count, deferred-active-reviewer state, degraded kind/reason/since, and next operator action. Do not expose credentials or raw command stderr.
    - Ensure omitted `remote_sync` resolves once at dispatch start from actual remote presence; false performs no fetch/push/delete; zero interval suppresses periodic cycles only; startup and stale before-provision sync ordering remain explicit.
    - Preserve per-target isolation: transient failures warn/retry without degradation, divergence/unsafe occupied checkout degrades only the target, healthy targets continue, and successful later sync clears degradation and requeues affected work.
    - Keep the spec `in_progress` until its complete focused matrix passes. Restore `implemented` only after all ACs have behavioral evidence and `kspec validate --warnings-ok` agrees.

    Files:
    - Likely modify: `src/agent-runtime/dispatch.ts`, `src/agent-runtime/workspace.ts`, `packages/daemon/src/routes/agent-dispatch.ts`, `src/cli/commands/agent.ts`
    - Modify/add focused tests: `tests/dispatch-target-sync.test.ts`, `tests/dispatch-degraded-state.test.ts`, `tests/dispatch-workspace-remote-branch-fallback.test.ts`, `tests/dispatch-workspace-cleanup.test.ts`, `tests/daemon-api/agent-dispatch.test.ts`, `tests/agent-dispatch-engine.test.ts`

    Required tests:
    - No remote, explicit false, omitted auto resolution, interval zero, startup order, stale before-provision, periodic deferral, push/retry/delete, target divergence, transient escalation, per-target isolation, occupied-checkout recovery, and status serialization.
    - Use local bare remotes and deterministic barriers; no network or GitHub dependency.

    Verification:
    - `npm test -- tests/dispatch-target-sync.test.ts tests/dispatch-degraded-state.test.ts tests/dispatch-workspace-remote-branch-fallback.test.ts tests/daemon-api/agent-dispatch.test.ts tests/agent-dispatch-engine.test.ts`
    - `npm run typecheck`
    - `npm run lint`
    - `kspec item get @dispatch-remote-branch-sync`
    - `kspec validate --warnings-ok`

    Review handoff:
    Reviewer must map each remote-sync AC to behavioral evidence and reject status-only or source-scan claims of completion.

- title: Publish the dispatch workspace configuration and operations guide
  slug: task-document-dispatch-workspace-configuration
  priority: 1
  spec_ref: "@dispatch-workspace-configuration"
  tags: [docs, dispatch, configuration]
  depends_on:
    - "@task-close-bootstrap-public-contract"
    - "@task-add-dispatch-workspace-operator-surface"
    - "@task-finish-dispatch-remote-sync-contract"
  description: |
    Covers:
    - @dispatch-workspace-configuration ac-1 through ac-8
    - @dispatch-runtime-bootstrap-contract ac-1 through ac-6 and Task 1 additions
    - @dispatch-remote-branch-sync configuration ACs

    What:
    Create the single authoritative user guide `docs/guides/configuring-dispatch-workspaces.md` and add it to `docs/guides/index.md`.

    Why:
    Operators currently have no complete page for dispatch workspace config, bootstrap authoring, placement, publication, sync, or supported inspection/reset/cleanup commands.

    How:
    - Use sections exactly: Prerequisites; Minimal configuration; Base branch resolution; Worktree root placement and ownership; Publication mode; Project bootstrap steps; Per-agent bootstrap steps; Step field reference; Environment and shell contract; Remote synchronization; Inspect/reset/cleanup commands; Managed `.gitignore`; Verification; Related concepts and troubleshooting.
    - Include one schema-valid complete `kspec.config.yaml` example and one supported `kspec meta set <agent> --bootstrap-steps '<json>'` example. Use `on`/`filter` in any agent rule example.
    - Provide a field table with type, default, scope, and semantics for `base_branch`, `worktree_root`, `publication_mode`, `sync_interval`, `remote_sync`, `bootstrap.steps[].run/name/roles/idempotent/allow_tracked_changes/reviewer_rerun_allowed/timeout_seconds`.
    - State exact project-before-agent ordering, role filter behavior, reviewer reuse/rerun rules, invalidators, tracked-only mutation guard, untracked artifact allowance, bash prerequisite, cwd, inherited/injected env, runner-env separation, timeout, redacted retained output warning, and dispatch-only scope.
    - Explain plan-scoped target precedence, persisted target continuity, `auto` publication detection, relative/absolute root behavior, exclusive root ownership, relative-root `.gitignore` management, and why users must never manually edit registry files or run git worktree commands inside managed roots.
    - Document only commands delivered by Task 2 and status delivered by Task 3. Include literal successful verification commands and unsafe reset/cleanup preconditions.
    - Link from the short dispatch overview and runner guide only where cross-model context is needed; do not duplicate runner secret configuration.

    Files:
    - Create: `docs/guides/configuring-dispatch-workspaces.md`
    - Modify: `docs/guides/index.md`, `docs/concepts/agents-and-dispatch.md`, `docs/guides/configuring-agent-runners.md`
    - Test: create or extend `tests/dispatch-workspace-docs.test.ts`

    Required tests:
    - Extract all YAML examples and validate with `KspecConfigSchema`/`AgentSchema` fixtures.
    - Assert every dispatch config key and bootstrap step key appears in the field table.
    - Assert command snippets exist in current Commander help and forbidden nonexistent command strings are absent.
    - Assert guide/index/overview links resolve.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/parser/config.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`
    - `npm run typecheck`

    Review handoff:
    Reviewer compares every table default and example key directly to schemas/resolved defaults and checks package-neutral language rather than Kynetic self-hosting policy.

- title: Publish the dispatch workspace lifecycle concept
  slug: task-document-dispatch-workspace-lifecycle
  priority: 1
  spec_ref: "@dispatch-workspace-registry"
  tags: [docs, dispatch, workspace]
  depends_on:
    - "@task-add-dispatch-workspace-operator-surface"
    - "@task-finish-dispatch-remote-sync-contract"
  description: |
    Covers:
    - @dispatch-workspace-registry all lifecycle, recovery, and retention ACs
    - @dispatch-workspace-cleanup-policy ac-1 through ac-5

    What:
    Create `docs/concepts/dispatch-workspaces.md` and add it to `docs/concepts/index.md` as the durable mental model behind the configuration and recovery pages.

    Why:
    The overview says “isolated workspace” but does not explain canonical branch continuity, detached review snapshots, fix cycles, registry authority, health, integration, cleanup, or retention.

    How:
    - Use sections exactly: Workspace identity; Target resolution and branch lineage; Worker lifecycle; Detached reviewer lifecycle; Review rejection and fix cycles; Registry and health; Integration and publication; Cleanup and retention; What operators own; Related operations.
    - Include a compact state diagram covering `provisioning`, `ready`, `active`, `stale`, `integrating`, `closing`, `cleanup_blocked`, and `closed` without presenting every internal field as a user API.
    - Explain one canonical workspace/task identity, worker branch persistence, reviewer detached snapshot disposal, reviewer-to-worker needs-work continuity, adopted branch provenance, target persistence, startup reconciliation, stale/unrecoverable recovery, protected artifacts, cleanup blockers, closed-record retention, and the dispatcher-exclusive root.
    - Clearly separate worker invocation lifecycle from detached reviewer lifecycle and from one-shot `agent run`. Do not imply that reviewer automation needs the worker's automation filter or that all events have task readiness semantics.
    - Point operations to the guide and troubleshooting pages rather than embedding procedures.

    Files:
    - Create: `docs/concepts/dispatch-workspaces.md`
    - Modify: `docs/concepts/index.md`, `docs/concepts/agents-and-dispatch.md`
    - Test: extend `tests/dispatch-workspace-docs.test.ts`

    Required tests:
    - Assert all lifecycle states are represented exactly once in the state explanation.
    - Assert worker/reviewer/fix-cycle and registry/cleanup headings exist and links resolve.
    - Render the page and verify heading anchors/navigation in existing docs rendering tests.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/web-ui-docs-rendering.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer checks the page against registry schema and workspace tests and rejects any suggestion to edit `.kspec/project.dispatch-workspaces.yaml` manually.

- title: Publish bootstrap failure diagnostics and recovery
  slug: task-document-dispatch-bootstrap-recovery
  priority: 1
  spec_ref: "@dispatch-runtime-bootstrap-contract"
  tags: [docs, dispatch, troubleshooting]
  depends_on:
    - "@task-close-bootstrap-public-contract"
    - "@task-add-dispatch-workspace-operator-surface"
  description: |
    Covers:
    - @dispatch-runtime-bootstrap-contract ac-2 through ac-10 and Task 1 additions

    What:
    Create `docs/troubleshooting/dispatch-bootstrap-failures.md` and index it from `docs/troubleshooting/index.md`.

    Why:
    Bootstrap failures can block a task or mark a workspace unhealthy, but users lack a supported way to distinguish command failure, timeout, tracked mutation, reviewer safety rejection, invalidation, missing bash, or workspace executability failure.

    How:
    - Use symptom-first sections for missing bash, nonzero exit, timeout, tracked-file mutation, reviewer non-idempotent rerun rejection, stale cached state/config/head invalidation, and missing/inaccessible/unrunnable workspace.
    - For each symptom provide: what status/list/show reports; what was persisted; safe inspection commands; config correction; when normal dispatch retry is sufficient; when guarded workspace reset is appropriate; and verification.
    - State that output is tail-limited and recognized secrets are redacted, but commands still must not print credentials. Explain runner secret bindings do not feed bootstrap and direct users to runner docs for adapter-process credentials.
    - Explain that untracked/ignored install artifacts are allowed while tracked source mutation requires explicit opt-in; warn against using `allow_tracked_changes` merely to silence an unexpected diff.
    - Never tell operators to edit workspace metadata, delete managed paths, or use an unsupported command.

    Files:
    - Create: `docs/troubleshooting/dispatch-bootstrap-failures.md`
    - Modify: `docs/troubleshooting/index.md`, `docs/guides/configuring-dispatch-workspaces.md`
    - Test: extend `tests/dispatch-workspace-docs.test.ts`

    Required tests:
    - Every stable failure class from bootstrap implementation maps to a heading/recovery block.
    - Every command snippet resolves in current help.
    - Secret sentinel and unsupported reset command strings are absent.
    - Links to guide, lifecycle, runner validation, and dispatch assignment troubleshooting resolve.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer simulates at least tracked-change, timeout, and reviewer-rerun fixtures and confirms the written recovery matches actual status and retry behavior.

- title: Publish workspace, sync, health, and cleanup recovery
  slug: task-document-dispatch-workspace-recovery
  priority: 1
  spec_ref: "@dispatch-workspace-cleanup-policy"
  tags: [docs, dispatch, troubleshooting]
  depends_on:
    - "@task-add-dispatch-workspace-operator-surface"
    - "@task-finish-dispatch-remote-sync-contract"
    - "@task-document-dispatch-workspace-lifecycle"
  description: |
    Covers:
    - @dispatch-workspace-configuration ac-4, ac-6, ac-8
    - @dispatch-workspace-registry ac-4 through ac-14
    - @dispatch-workspace-cleanup-policy all ACs
    - @dispatch-remote-branch-sync degraded/recovery/status ACs

    What:
    Create `docs/troubleshooting/dispatch-workspace-sync-and-cleanup.md` and index it.

    Why:
    Operators need bounded recovery for target changes, missing/colliding worktrees, stale registry state, remote divergence, transient sync failure, blocked cleanup, and retention. The current assignment page covers eligibility only and overstates automation gating.

    How:
    - Use a status-first decision table keyed by workspace lifecycle/health/cleanup and remote-sync state.
    - Cover configured-versus-recorded target mismatch, plan target changes, foreign worktree collision, missing worker/reviewer path, stale/unrecoverable record, no remote/local-only mode, transient remote failure, divergence, unsafe occupied target checkout, deferred reviewer sync, cleanup-blocked active/integration ownership, unknown root entries, and closed-record retention.
    - State exactly what dispatch continues or pauses: degraded target blocks new provisioning only for that target; healthy targets and existing in-flight invocations continue; transient failures retry; reviewer snapshots and worker worktrees have different retention.
    - Use only supported `workspace list/show/reset/cleanup`, `agent dispatch status`, and safe git observation commands. Make reset/cleanup limits explicit and route conditions outside those limits to operator repair rather than promising automatic recovery.
    - Correct `docs/troubleshooting/dispatch-refuses-to-assign.md`: describe automation filtering per rule/event, preserve worker defaults, add reviewer/arbitrary-event cases, and link to status/workspace recovery.

    Files:
    - Create: `docs/troubleshooting/dispatch-workspace-sync-and-cleanup.md`
    - Modify: `docs/troubleshooting/index.md`, `docs/troubleshooting/dispatch-refuses-to-assign.md`, `docs/guides/configuring-dispatch-workspaces.md`
    - Test: extend `tests/dispatch-workspace-docs.test.ts`

    Required tests:
    - Matrix rows cover every stable degraded kind, workspace health/lifecycle, and cleanup block classification exposed by status.
    - Automation prose fixture proves reviewer/arbitrary rules are not described as blanket eligible-only.
    - All commands and links validate; no manual managed-file mutation instructions occur.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/dispatch-degraded-state.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`

    Review handoff:
    Reviewer walks one transient, one divergence, one target-reset, and one cleanup-blocked fixture from status output through the documented recovery and records mismatches as blockers.

- title: Correct adjacent examples, scaffolds, release notes, and generated guidance
  slug: task-correct-adjacent-public-guidance
  priority: 2
  spec_ref: "@user-documentation"
  tags: [docs, setup, templates, release]
  depends_on:
    - "@task-close-bootstrap-public-contract"
    - "@task-add-dispatch-workspace-operator-surface"
  description: |
    Covers:
    - @agent-definition-schema ac-2, ac-3, ac-8, ac-12
    - @agent-dispatch-engine ac-6, ac-21, ac-22
    - @dispatch-workspace-configuration ac-1 through ac-5

    What:
    Correct confirmed drift in existing public examples and align setup/release/generated guidance with the new dispatch documentation without copying Kynetic-only policy into package sources.

    Why:
    Runner examples currently use invalid `trigger`/`filters`; automation statements are overbroad; release notes omit `publication_mode: auto`; the setup scaffold does not discover the workspace/bootstrap guide; generated dispatch guidance must remain universal and source-owned.

    How:
    - Replace both runner-guide rule examples with schema-valid `on`/`filter`, and audit all active public Markdown/YAML snippets for the same legacy aliases.
    - Correct dispatch overview, assignment troubleshooting, and package agent template statements to distinguish worker default automation filters from reviewer and arbitrary event rules.
    - Correct the v0.12 release-note configuration row to list `manual_merge`, `pull_request`, and `auto`, explain auto detection concisely, and preserve historical tense rather than rewriting release history as current setup instructions.
    - Expand `generateConfigContent` in `src/cli/commands/setup.ts` and the parallel upgrade scaffold in `src/cli/commands/upgrade.ts` with concise comments for `worktree_root`, `sync_interval`, `remote_sync`, and `bootstrap.steps`, plus the canonical docs URL/path. Keep defaults semantically identical and do not seed project-specific commands.
    - Verify managed `.gitignore` comments/docs state that setup maintains a relative configured root and skips absolute roots.
    - Edit only source templates under `templates/agents-sections/` or `templates/skills/`; regenerate `kspec-agents.md`, `.agents/skills/`, `.factory/skills/`, and ignored plugin output when their source changes. Do not hand-edit generated outputs.

    Files:
    - Modify: `docs/guides/configuring-agent-runners.md`, `docs/concepts/agents-and-dispatch.md`, `docs/troubleshooting/dispatch-refuses-to-assign.md`, `RELEASE_NOTES.md`
    - Modify: `src/cli/commands/setup.ts`, `src/cli/commands/upgrade.ts`, `src/parser/gitignore.ts` comments if needed
    - Likely modify source: `templates/agents-sections/06-agent-dispatch-mode.md`; modify package skill sources only if their audit finds the same factual drift
    - Modify tests: `tests/scaffold-project-config.test.ts`, `tests/upgrade-command.test.ts`, generated guidance tests, `tests/dispatch-workspace-docs.test.ts`

    Required tests:
    - Parse every changed YAML snippet against current schemas.
    - Scaffold snapshots contain all accepted publication values and dispatch keys while resolved defaults remain unchanged.
    - Generated guidance is semantically package-neutral and rendered output matches source generation.
    - Repository-wide active public prose contains no dispatch-rule `trigger`/`filters` examples and no blanket eligibility assertion.

    Verification:
    - `npm test -- tests/scaffold-project-config.test.ts tests/upgrade-command.test.ts tests/dispatch-workspace-docs.test.ts tests/gitignore-managed-block.test.ts`
    - `kspec agents generate`
    - `kspec skill render`
    - `npm run build:plugin`
    - `git diff --exit-code -- kspec-agents.md .agents .factory` after a second regeneration
    - `npm run format:check`

    Review handoff:
    Apply the `shared-guidance-neutrality` review: package outputs describe universal mechanics; Kynetic `dev`/`main`, local agents, quality gates, and review policy remain only in local surfaces.

- title: Inventory and correct every active public documentation surface
  slug: task-whole-public-doc-consistency-sweep
  priority: 2
  spec_ref: "@user-documentation"
  tags: [docs, audit, consistency]
  depends_on:
    - "@task-document-dispatch-workspace-configuration"
    - "@task-document-dispatch-workspace-lifecycle"
    - "@task-document-dispatch-bootstrap-recovery"
    - "@task-document-dispatch-workspace-recovery"
    - "@task-correct-adjacent-public-guidance"
  description: |
    Covers:
    - @user-documentation full active public surface

    What:
    Perform the bounded whole-doc-set pass and leave a deterministic inventory proving what was reviewed, what source of truth was compared, and what is intentionally historical/internal.

    Why:
    “Full pass” cannot mean an open-ended rewrite or stop after dispatch pages. Every public entry point, shipped template, generated artifact, scaffold, help surface, and documentation test must have an explicit disposition.

    How:
    - Create `tests/fixtures/public-documentation-surfaces.json` as the maintenance manifest. Enumerate: every `docs/**/*.md`; `README.md`, `INSTALL.md`, `CONTRIBUTING.md`, `SECURITY.md`, `RELEASE_NOTES.md`; setup/upgrade config scaffold producers; all `templates/agents-sections/**/*.md`; all `templates/skills/**/*.md`; generated `kspec-agents.md` and tracked rendered skills; package/plugin generated destinations; top-level and command-family CLI help snapshots; and documentation/link/render/search tests.
    - Each entry records `path`, `classification` (`active-public`, `historical`, `internal-eval`, `generated`, or `source-template`), `owner/source_of_truth`, `rendered_from` when generated, and `audit_topics`. No existing file may be silently omitted. Historical/internal files are checked for labeling and dangerous current instructions but are not rewritten into active guides.
    - For active prose compare commands to current Commander help, YAML keys/defaults/enums to Zod/resolved config, task state/automation language to current specs, file locations to packaging/setup code, and links to actual targets/anchors. Correct every factual mismatch found; avoid style-only churn.
    - Audit README/INSTALL/CONTRIBUTING/SECURITY for their stated roles: README remains the tested concise landing page; INSTALL remains installation/setup; CONTRIBUTING remains contributor-local; SECURITY contains only supported reporting/security claims.
    - Audit release notes as historical records, setup scaffolds as first-run discoverability, templates as package-neutral universal guidance, skills as source-owned procedures, generated outputs for exact regeneration, and CLI help as the command authority.
    - For features whose owning spec remains draft/in-progress after prerequisite tasks, either complete the prerequisite, label the doc as unavailable/experimental with exact limits, or omit normative instructions. Never infer support from schema presence alone.
    - Record only unresolved product contradictions as follow-up kspec work; documentation corrections found in this bounded inventory are in scope and must be fixed before completion.

    Files:
    - Create: `tests/fixtures/public-documentation-surfaces.json`
    - Modify: any inventoried active public documentation/source template/scaffold that fails a source-of-truth comparison
    - Modify/add: `tests/public-documentation-inventory.test.ts`

    Required tests:
    - Manifest completeness against filesystem globs and known CLI/scaffold/generated surfaces.
    - Unique canonical paths, valid classifications, existing source owners, generated source/destination pairing.
    - All relative links and Markdown anchors across active public docs.
    - YAML/JSON/shell snippet parsing where deterministic; command first-token/path validation against captured help.
    - No generated file is treated as an authoring source.

    Verification:
    - `npm test -- tests/public-documentation-inventory.test.ts tests/docs-readme-structure.test.ts tests/folder-backed-resource-docs.test.ts tests/resource-ui-task-markdown-docs.test.ts tests/web-ui-docs-rendering.test.ts tests/web-ui-docs-search.test.ts`
    - `npm run build:docs-search`
    - `npm run format:check`
    - `npm run typecheck`
    - `kspec validate --warnings-ok`

    Review handoff:
    Reviewer samples at least one entry from every classification and independently diffs the manifest against filesystem globs; an unclassified surface or unsupported normative command is a blocker.

- title: Add durable documentation drift gates and run final rendered validation
  slug: task-documentation-drift-gates-and-final-validation
  priority: 2
  spec_ref: "@user-documentation"
  tags: [docs, testing, ci]
  depends_on:
    - "@task-whole-public-doc-consistency-sweep"
  description: |
    Covers:
    - @user-documentation closure and discoverability

    What:
    Turn high-value factual comparisons into maintainable tests and verify the final source, generated, packaged, searched, and browser-rendered documentation as one release-ready surface.

    Why:
    A one-time sweep will drift again unless schema keys, enums, help paths, navigation, generated ownership, and inventory completeness have deterministic gates. Tests must target structured facts, not police prose style.

    How:
    - Keep `tests/public-documentation-inventory.test.ts` as the completeness/link/ownership gate and `tests/dispatch-workspace-docs.test.ts` as the dispatch schema/help/example gate.
    - Compare the dispatch field table to structured exported schema/default metadata or a small explicit adapter derived from `src/parser/config.ts`; do not regex private implementation bodies. Compare accepted enum/default sets, not paragraph wording.
    - Parse fenced examples carrying `yaml kspec-config` or `yaml kspec-agent` info strings and require new/changed canonical examples to use those labels. Validate through public schemas.
    - Capture CLI help through the test CLI helper with explicit fixture cwd and assert documented command paths/subcommands exist. Do not require every prose mention to match a denylist.
    - Validate all relative links/anchors and docs index membership. Build docs search and assert all four new pages are indexed under the intended concept/guide/troubleshooting groups.
    - Regenerate package outputs twice and assert the second run is clean. Build the web UI/docs search, run focused browser docs QA at desktop and mobile, and verify new pages render, sidebar grouping/current-page state works, TOC anchors work, search finds “bootstrap”, “worktree_root”, and “cleanup_blocked”, and no raw Markdown link leaks.
    - Run complete project gates after focused tests. If an unrelated baseline failure remains, record its exact command/output and prove all changed-file/focused gates pass; do not weaken tests or claim a green full gate.

    Files:
    - Modify: `tests/public-documentation-inventory.test.ts`, `tests/dispatch-workspace-docs.test.ts`, `tests/e2e/docs.spec.ts`, `tests/web-ui-docs-rendering.test.ts`, `tests/web-ui-docs-search.test.ts`
    - Modify helper/build scripts only if needed: `scripts/build-docs-search.cjs`
    - No prose changes except fixes exposed by these final gates

    Required tests:
    - Structured schema/default/enum comparison; valid tagged examples; current CLI paths; link/anchor/index/inventory completeness; source/generated convergence; search inclusion; desktop/mobile render and navigation.
    - Negative fixtures for legacy `trigger`/`filters`, nonexistent workspace command, missing inventory entry, invalid dispatch key/default, broken anchor, and direct generated-source ownership.

    Verification:
    - `npm test -- tests/dispatch-workspace-docs.test.ts tests/public-documentation-inventory.test.ts tests/docs-readme-structure.test.ts tests/web-ui-docs-rendering.test.ts tests/web-ui-docs-search.test.ts`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `kspec agents generate && kspec skill render && npm run build:plugin`
    - `git diff --exit-code -- kspec-agents.md .agents .factory`
    - `npm run build:web-ui`
    - `npm run test:e2e -- tests/e2e/docs.spec.ts`
    - `npm run format:check`
    - `npm run lint`
    - `npm run typecheck`
    - `npm test`
    - `kspec validate --warnings-ok`

    Review handoff:
    Final reviewer receives the inventory diff, focused/full gate output, generated-clean proof, and desktop/mobile browser evidence. Approval requires no unclassified public surface, no unsupported normative command, no schema/example mismatch, and no package-local policy leak.
```

## Implementation Notes

### Slice order

1. **Product-contract prerequisites:** Tasks 1–3 close authoring, safety, workspace operations, ownership, and remote-sync readiness. Documentation workers must not start normative pages before their dependencies land.
2. **Core dispatch documentation:** Tasks 4–7 create the fixed guide/concept/troubleshooting information architecture in independently reviewable pages.
3. **Adjacent public surfaces:** Task 8 corrects known factual drift and keeps scaffolds/templates/generated outputs aligned.
4. **Whole-surface closure:** Task 9 inventories and corrects every public surface; Task 10 makes the closure criteria durable and validates rendered output.

### Scope boundaries

- This plan does not redesign dispatch scheduling, task lifecycle, runner configuration, or publication policy beyond prerequisite gaps that block accurate documentation.
- Product-contract tasks amend existing owners; they do not create new sibling specs.
- Documentation tests validate structured facts, links, examples, and ownership. They do not enforce tone or package neutrality through broad string deny-lists; neutrality remains a reviewer judgment backed by the project convention.
- Root `plans/` is not task-agent context. Every binding audit fact, information-architecture decision, path, command, dependency, and verification gate needed by workers is repeated in the owning task above.
