# kspec Release Notes

Release notes for `@kynetic-ai/spec` (kspec). Each section below describes a
published version. The most recent version appears first. See the release
skill for the authoring conventions enforced by the CLI.

## Unreleased

Human-authored summary of changes staged for the next release. Promote this
block to a versioned section (with the chosen version number) as part of the
release workflow before tagging.

### New or changed configuration

- **`kynetic: "1.2"` storage format.** Project manifests now declare
  `kynetic: "1.2"`, `task_storage.format: split`, `plan_storage.format: folder`,
  `review_storage.format: folder`, and `resource_storage.format: entity_scoped`.
  `kspec init` writes these fields on new projects; `kspec upgrade` migrates
  existing projects.

### Breaking changes

- **Folder-backed plan and review storage.** Plans now live in
  `.kspec/plans/<plan-ulid>/` directories with `plan.md`, `plan.yaml`, optional
  `notes.yaml`, `resources.yaml`, and `resources/`. Reviews live in
  `.kspec/reviews/<review-ulid>/` directories with cohesive `review.yaml`,
  `resources.yaml`, and `resources/`. The project-wide
  `.kspec/project.plans.yaml` and `.kspec/project.reviews.yaml` files remain as
  lean indexes (identity, lifecycle, summary fields, resource summaries) but no
  longer inline plan markdown, review records, or resource bytes. Existing
  projects must run `kspec upgrade` to migrate; commands and daemon routes that
  need folder-backed plan, review, or resource data on an unmigrated project
  fail with `entity_storage_incompatible`. See
  [Upgrading kspec to a New Version](docs/guides/upgrading-kspec.md) and
  [`entity_storage_incompatible` troubleshooting](docs/troubleshooting/entity-storage-incompatible.md).

### Features & Additions

- **Entity-scoped local resources.** Plans and reviews can own local files —
  screenshots, PDFs, evidence logs — declared in a per-entity `resources.yaml`
  with the fixed `ResourceMetadata` shape (`id`, `label`, `path`,
  `content_type`, `bytes`, `sha256`, `git_commit`, `git_path`, `description`).
  Authoring references use the `./resources/<relative-path>` form. Resource ids
  match `[a-z0-9][a-z0-9._-]{0,127}`; paths must be POSIX-relative under the
  entity's `resources/` directory.
- **Plan resource CLI** — `kspec plan resource add/list/get/remove` attach,
  inspect, and remove plan-owned local resources. `add` requires `--id` and
  `--path`; replacement is opt-in via `--replace`. `remove` requires `--force`
  in non-interactive contexts.
- **Review resource CLI** — `kspec review resource add/list/get/remove` mirror
  the plan resource commands for review-owned evidence files.
- **Plan import with resources** — `kspec plan import` copies declared
  resources from a sibling `resources.yaml` and `resources/` directory into the
  plan's folder, and validates that `./resources/<rel>` markdown links resolve.
  `kspec plan set --content-file` enforces the same resolution against the
  existing plan's manifest.
- **Plan derive resource references** — derived tasks receive versioned
  `TaskResourceRef` entries pointing back at plan-owned resources by default,
  carrying the content hash and git commit captured at derivation time. Use
  `kspec plan derive --materialize-resources` to copy plan resource bytes into
  each derived task's `.kspec/tasks/<task-ulid>/resources/plan/<plan-ulid>/`
  tree with the id `plan-<resource-id>`.
- **Daemon resource API** — `GET/POST/DELETE /api/plans/:ref/resources[/:id[/bytes]]`
  and `GET/POST/DELETE /api/reviews/:ref/resources[/:id[/bytes]]` serve
  resource metadata and bytes. `POST` accepts `multipart/form-data` with
  `file`, `id`, `path`, optional `label`/`description`/`content_type`, and an
  optional `replace` field accepting `"true"`/`"1"` or `"false"`/`"0"`. The
  `/bytes` route sets `Content-Type`, `Content-Length`, and the resource's
  `sha256` via an `X-Kspec-Resource-Sha256` response header.
- **Static export resource layout** — exported plans and reviews copy resource
  files to `assets/resources/plan/<plan-ulid>/<relative-path>` and
  `assets/resources/review/<review-ulid>/<relative-path>`. Plan markdown links
  are rewritten to point at the exported asset path so the offline UI works
  without the daemon.
- **Plan and review index rebuild** — `kspec plan rebuild-index` and
  `kspec review rebuild-index` validate or repair the project-wide index
  against the on-disk entity folders. `--dry-run` previews drift; `--repair`
  rewrites the index from folders; `--repair --force` drops stale index
  entries whose folders are missing. Exit codes are 0 (clean/repaired), 1
  (drift detected), 2 (blocked by conflicts).
- **`entity_storage_incompatible` daemon responses** — plan, review, and
  resource routes return HTTP 409 with a structured envelope (top-level
  `entity_storage_incompatible` discriminator plus domain-specific codes:
  `legacy_plan_storage_removed`, `legacy_review_storage_removed`,
  `missing_plan_folder_storage`, `missing_review_folder_storage`,
  `partial_entity_storage_layout`) when the project is not on folder-backed
  storage. The response body includes a `suggestion`, `domain`, and
  `cache_domain` so clients can surface targeted recovery guidance.
- **Upgrade rollback reference** — `kspec upgrade` and `kspec upgrade --dry-run`
  now report the previous shadow commit (short SHA captured before any
  mutation) so operators have a deterministic rollback point.

### Documentation

- New concept page: [Local Resources for Plans and Reviews](docs/concepts/local-resources.md).
- New guide: [Working With Local Resources](docs/guides/working-with-local-resources.md).
- New troubleshooting pages: [`entity_storage_incompatible`](docs/troubleshooting/entity-storage-incompatible.md)
  and [Plan or Review Index Has Drifted](docs/troubleshooting/plan-or-review-index-drift.md).
- Updated [Upgrading kspec to a New Version](docs/guides/upgrading-kspec.md)
  with the 1.2 manifest fields, folder layout, and rollback procedure.
- Updated [Importing and Approving a Plan](docs/guides/importing-and-approving-a-plan.md)
  with `--materialize-resources` derivation guidance.
- **Project-neutral package guidance.** Package-shipped agent sections
  (`templates/agents-sections/`) and core skills (`templates/skills/`) now
  describe universal kspec mechanics only. Hard-coded branch names (`dev`,
  `main`), toolchain commands (`npm test`, `oxlint`, Vitest), GitHub PR policy,
  fixed agent ids (`task-worker`, `pr-reviewer`), and `kynetic.meta.yaml`
  references have been replaced with project-defined wording or pointers to
  `kspec agent list`, project meta, and project-local skill sources. Consumer
  projects can adopt their own branch policy, toolchain, and external review
  process without inheriting the Kynetic self-hosting repository's defaults.
  Self-hosting policy now lives in local project context (`AGENTS.md`,
  project-local `.kspec/skills/`, project meta conventions). A new project-local
  `shared-guidance-neutrality` reviewer skill encodes the semantic checklist
  reviewers apply to future changes to these shared surfaces.

## v0.14.0

Stability release focused on daemon endpoint coherence, dispatch workspace
cleanup safety, task-storage compatibility responses, docs/search/release-notes
rendering, AC annotation validation, and CI/publish reliability.

### New or changed configuration

- `daemon.host` now defaults to numeric IPv4 loopback `127.0.0.1` instead of
  `localhost` to avoid `/etc/hosts` and DNS resolution drift.
- `daemon.connect_host` — optional host advertised to local clients when the
  daemon binds a wildcard address such as `0.0.0.0` or `::`. It can also be set
  with `KSPEC_DAEMON_CONNECT_HOST`.

### Breaking changes

- None.

### Features & Additions

- **Daemon endpoint resolution** — shared endpoint metadata and resolution now
  flow through daemon startup, CLI lifecycle metadata, auto-start, clients, and
  web UI daemon access. Endpoint validation rejects unreachable bind/connect
  combinations while preserving loopback aliases and wildcard-bind use cases.
- **Docs and release-note surfaces** — added Pagefind-backed docs search,
  docs navigation integration, release-notes rendering in the web UI, and
  canonical `RELEASE_NOTES.md` wiring tests.
- **Task-storage compatibility API responses** — daemon routes now return
  structured `task_storage_incompatible` responses for legacy task-storage
  projects, with shared route helpers and coverage across affected surfaces.
- **Detached reviewer merge helper** — merge/reviewer skills gained detached
  review helper support plus portable supporting-file references.
- **AC annotation validation** — acceptance-criteria annotations now enforce
  the `ac-*` identifier format, normalize catalog IDs, and report malformed
  annotation and stale-mapping cases more precisely.

### Bug Fixes

- Recursive daemon command proxying is suppressed, including inside agent
  invocations, so daemon-handled commands do not call back into the same proxy
  path.
- Dispatch cleanup preserves active/in-flight task workspaces across branches,
  reviewer snapshots, corrupt metadata, unknown worktree roots, and bootstrap
  race windows while surfacing labeled diagnostics for skipped artifacts.
- Dispatch reconciliation no longer overlaps active cycles; event-bus lineage
  and source-ordering state is bounded so aged correlated chains are released.
- Entity-cache diagnostics suppress repeated known task-storage incompatibility
  reports while preserving degraded-cache behavior.
- Daemon/web UI startup asset resolution, runtime readiness, configured host
  validation, and CLI serve lifecycle metadata were hardened.
- Publish workflow now installs Bun before running the full suite, and package
  repository/discussion URLs now point at `lepahc/kynetic-spec`, unblocking npm
  provenance publication.

### Documentation

- README was trimmed into a concise landing page with docs cross-links.
- Added and refreshed Getting Started, Concepts, Guides, and Troubleshooting
  pages, including corrected CLI guidance and recovery procedures.
- Updated merge/reviewer guidance, dispatch-compatible branch guidance, and
  rendered skill outputs.

### Other Changes

- Expanded the daemon-cleanup lint rule and test fixtures to catch unscoped
  daemon ownership, alias/wrapper edge cases, lifecycle hooks, and startup
  failure cleanup leaks.
- Serialized dynamic test-daemon port startup with filesystem locks and held
  Playwright fixture locks across restart windows to remove parallel bind races.
- Applied final `oxfmt`, lint, typecheck, and full-test stability sweeps across
  the dev merge delta.

## v0.13.0

Significant release focused on a daemon entity cache, multi-turn session
lifecycle, a new automation subsystem (hooks/schedules/events), split
per-task storage with a required migration, a review records web UI, plan
branches, and a single-command upgrade flow.

### New or changed configuration

- `daemon.runtime` — new `kspec.config.yaml` key selecting the daemon
  runtime (`bun` or `node`). Defaults to `node`.
- `dispatch.sync` — new `kspec.config.yaml` section controlling
  integration branch sync cadence and behavior.
- `coverage.scan_paths` and `coverage.exclude_patterns` — new
  `kspec.config.yaml` section for the AC coverage scanner, making it
  language-agnostic and allowing per-project include/exclude tuning.
- `hooks:` meta domain — new top-level `kspec.meta.yaml` section for
  event-driven hook actions, managed via
  `kspec hook add/set/list/enable/disable/remove`. Distinct from the
  existing `kspec.config.yaml#hooks` block that controls
  checkpoint/prompt-check hook installation.
- `schedules:` meta domain — new top-level `kspec.meta.yaml` section for
  cron-style scheduled agent actions, managed via `kspec schedule`.
- `session_prompt` action type — new action input for multi-turn session
  lifecycle, with `prompt`/`prompt_template` and skill support.
- `kspec setup` / `kspec init --setup` now scaffold `kspec.config.yaml`,
  default agents, conventions, a session reflection hook (restricted to
  the first idle event), the default module, and gitignore entries on
  first run. Existing setups are preserved.
- `kspec release-notes` — new top-level command that prints notes for the
  installed version or an inclusive `--from <version> --to <version>`
  range, reading directly from `RELEASE_NOTES.md`.
- `kspec upgrade` now appends release notes for every intervening version
  to its output so behavioral changes surface during upgrade.
- `RELEASE_NOTES.md` is shipped in the published package; the release
  skill documents the authoring conventions and the pre-release check
  that enforces a non-empty entry for the version being released.

### Breaking changes

- **Task storage split requires migration.** Task data now lives in a
  per-task directory layout (core, notes, history) instead of the single
  `project.tasks.yaml` monolith. Existing projects must run
  `kspec task migrate` to convert their task file to the split layout
  and `kspec task storage activate` to enable the new backend. Tasks
  continue to read from the monolithic format until activation, so the
  migration can be staged, but task writes after upgrade require the
  split layout.

### Features & Additions

- **Daemon entity cache** — tiered in-memory cache for items, tasks,
  meta, plans, reviews, inbox, and triage, with watcher-driven
  incremental invalidation, write-through updates, and cache-backed read
  concurrency. Adds `GET /api/debug/cache-status` for diagnostics and a
  `cache:status` WebSocket topic for domain-ready invalidation signals.
- **Multi-turn session lifecycle** — active session registry, idle-grace
  auto-close, `session.idle` event, `session_prompt` action type, and
  dispatch engine integration for continuing work across turns.
- **Automation subsystem** — hook, schedule, event, composition, and
  action model with CLI commands (`kspec hook`, `kspec schedule`,
  `kspec event`), a schedule tick engine, a hook execution engine, a
  composition join accumulator, and shared action run tracking.
  `kspec validate` now enforces hook/schedule/composition rules.
- **Split per-task storage** — per-task directory layout with core data,
  notes, and history files. Adds `kspec task migrate`,
  `kspec task storage activate`, `kspec task rebuild-index`, write
  buffering for multi-file transactions, and an in-file activity
  timeline in `task get`.
- **Review UI in the web app** — review list and detail pages with
  thread view, revision selector, inline diff viewer with commenting,
  structured content viewer for plan/spec reviews, verdict/check/
  thread/lifecycle API endpoints, and WebSocket broadcasts for review
  events. Task detail pages link to associated reviews.
- **Plan branches** — new `branch` field on plans, `kspec plan branch`
  command, `kspec plan derive` tasks by default, and dispatch workspace
  base-branch resolution from plan branch.
- **Single-command upgrade** — `kspec upgrade` migrates scaffold,
  skills, and `kspec-agents.md` in one step, with corruption recovery,
  orphan skill cleanup, and `--force` that preserves user-removed
  defaults.
- **Unified daemon API envelope** — all daemon routes return a typed
  `ApiResponse<T>` wrapper. Read routes now serve from the entity
  cache.
- **Dispatch hardening** — session lifecycle event emission on terminal
  states, stale integration target detection when base branch changes,
  dispatch branch push lifecycle, and shadow worktree cross-
  contamination guards.
- **YAML round-trip stability** — raw-data preservation for workflow
  runs and triage records.
- **CLI ergonomics** — `kspec item ac update` alias, smarter rejection
  messages when `kspec task set` rejects a status transition, automatic
  dangling-reference cleanup on item deletion, and restore of pre-block
  status on `kspec task unblock`.
- **Web UI** — automation view with trigger editing, cache-warming
  loading skeletons, session.idle event rendering, query retry
  ceiling, and WebSocket invalidation replacing polling across more
  surfaces.
- **Test infrastructure** — smart test runner caching with condensed
  output, per-file progress in non-verbose mode,
  `no-source-scanning` and `no-leaky-test-daemon` oxlint rules,
  `readTestOutput` helper.

### Bug Fixes

- `kspec setup` base-branch fallback now uses the full dispatch fallback
  chain and handles stale remote HEAD.
- Daemon emits cache-invalidation events for new non-active sessions.
- Daemon loads config from worktree root instead of main repo root.
- Batch atomic failures now report `rolled_back` correctly and include
  a rollback note in output.
- Web UI plan filter resolves via bidirectional ULID-prefix matching.
- CLI auto-start of daemon is suppressed in dispatch sessions and on
  `serve` commands.

### Documentation

- `AGENTS.md` trimmed to architecture/gotchas/decision frameworks; CLI
  and workflow detail moved into skills.
- New review-plan skill for plan document quality review.

### Other Changes

- oxlint + oxfmt replace Prettier in the lint/format pipeline.
- Legacy `ralph` agent references removed; legacy agent config alias
  retained for back-compat.

## v0.12.0

Major feature release with review records, dispatch workspace management,
and web UI modernization.

### New or changed configuration

- `kspec.config.yaml` now accepts a `dispatch.publication_mode` key
  (`manual_merge` or `pull_request`) controlling how dispatched work is
  published. Defaults preserve prior behavior.
- `kspec.config.yaml` gained a `hooks` section for configuring project
  hooks directly during setup.
- `dispatch.base_branch` in `kspec.config.yaml` now doubles as the
  fallback when a dispatched task submits without an explicit upstream.

### Breaking changes

- Dispatched task review is now driven by per-cycle kspec review records.
  Agents no longer open GitHub PRs for dispatched work; reviews are created
  with `kspec review` and merged locally. Automation built around opening
  PRs for dispatched tasks must be updated.

### Features & Additions

- **Per-cycle review records** — review CLI surface for creating, querying,
  and mutating reviews with verdicts, checks, threads, and gate evaluation.
- **Dispatch workspace lifecycle** — canonical task branch lineage, worktree
  isolation, bootstrap preflight, orientation prompts, and workspace
  registry persistence.
- **Task activity timeline** — git query for shadow branch history, activity
  normalization with commit message and diff parsing, and display in
  `task get`.
- **Fix-cycle diff context** — reviewer orientation includes diff summary for
  fix cycles.
- **Portable task submission linkage** — dispatch `base_branch` fallback for
  `upstream_ref`.
- **Session improvements** — branch worktree mode, text search, unified
  filtering, summary stats, and session event detail API.
- **Web UI: TanStack Query v6 migration** — dashboard, core pages, inbox,
  triage, sidebar, and sessions migrated; polling replaced by WebSocket
  invalidation.
- **Web UI: Markdown rendering** — streaming markdown renderer, ANSI
  terminal color rendering, prose typography.
- **Web UI: Session streaming** — WebSocket-first live viewing with infinite
  scroll pagination.
- **Droid ACP adapter** — agent detection, skill import/renderer, and core
  skill registration.
- **YAML serialization stability** — canonical field ordering, round-trip
  stability, and anchor/alias crash prevention.
- **Plan enhancements** — derive from specs, import into existing plans,
  export command, content-only storage.
- **Daemon APIs** — batch item fetch, ref index endpoint, server-side
  aggregation, title resolution, enriched WebSocket broadcasts.
- **Validation** — AC annotation validation, spec completeness policy,
  blanket coverage ref rejection.

### Bug Fixes

- Fixed dispatch workspace provisioning, health reconciliation, and
  lifecycle state management.
- Fixed web UI URL state management — use `goto()` instead of
  `replaceState`/`pushState`.
- Fixed shadow branch sync races with per-worktree locks and in-flight
  dedup.
- Fixed YAML anchor/alias crash when `sortMapEntries` reorders shared
  references.
- Hardened test suite for CI stability across dispatch, session, and daemon
  tests.

## v0.11.0

Comprehensive web UI revamp with 11 new views, a design system foundation,
and extensive bug fixes.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Features & Additions

- **Dashboard Overview** — active work summary, status counts,
  needs-attention section with animated counters.
- **Task Board (Kanban)** — column-based view (Backlog/Ready/In
  Progress/Review/Done) with task cards, detail modal, and Active Fleet
  row showing live agent output.
- **Session Stream** — real-time session viewer with thinking blocks, tool
  call views, message rendering, and auto-scroll.
- **Session History** — list view of past agent sessions with filtering,
  dispatch detection, and duration display.
- **Agent & Dispatch View** — agent cards with edit forms, dispatch status,
  active invocation monitoring.
- **Plans View** — plan list with progress tracking and lazy-loaded content
  expansion.
- **Workflows Page** — workflow list with step visualization and start
  action.
- **Settings Page** — project config, conventions, daemon info, shadow
  branch health status.
- **Validation & Alignment View** — spec coverage metrics, trait AC
  warnings.
- **Specs Page** — spec item browser with plan filtering.
- **Enhanced Inbox** — triage status indicators, category/status filters.
- **Design system** — token contract with semantic color variables,
  animation utilities.
- **ReferenceLink component** — unified task/spec/item reference display
  with title resolution.
- **Shared package** — `@kynetic-ai/shared` with API types and Zod schemas
  used by daemon and web UI.

### Bug Fixes

- Fixed automation filter dropdown options.
- Removed useless Task/Subtask type filter.
- Unified task detail display across kanban and task list.
- Fixed kanban and task list overflowing viewport.
- Fixed shadow branch health check in daemon.
- Fixed validate page crash from undefined traitCycles.
- Fixed inbox/triage filter dropdowns (Svelte 5 migration).
- Gated sidebar badge counts on project store initialization.
- Tool calls collapsed by default with truncatable name badges.

### CI

- Added `build:shared` step to root build script for CI.
- Fixed gh-pages deploy workflow to build shared package before web-ui.

## v0.10.0

Major release introducing the agent dispatch engine — a fully integrated
system for autonomous task execution, replacing the external ralph
orchestrator.

### New or changed configuration

- Agent definitions gained dispatch rules, trigger events, and runtime
  fields. Existing agent definitions continue to load without change.
- Session model extended with `trigger_source`, `agent_id`, and agent
  lifecycle events.

### Breaking changes

- The external ralph orchestrator is superseded by the built-in dispatch
  engine (`kspec agent dispatch start/stop/status/watch`). Projects that
  scripted ralph invocations directly should migrate to the new commands.

### Features & Additions

- **Agent dispatch engine** — autonomous task dispatch with configurable
  agents, dispatch rules, and priority scheduling.
- **Agent invocation lifecycle** — structured agent runs with session
  tracking, budget enforcement, and failure handling.
- **Agent CLI commands** — `kspec agent run`, `kspec agent list`, and
  dispatch management commands.
- **Dispatch watch streaming** — real-time text output from running agent
  invocations.
- **Daemon dispatch integration** — dispatch engine runs inside the daemon
  with WebSocket event streaming.
- **Web UI bundled in npm package** — daemon serves the web interface
  directly from the installed package.
- **Stale session management** — detect and close stale active sessions
  with `kspec session close-stale`.
- **Batch ergonomics** — `tags` alias for `tag`, P1/P2/P3 priority aliases.
- **Task description editing** — `kspec task set --description` support.

### Bug Fixes

- Fixed serve command safety when running under dispatch (prevents agents
  from killing their host daemon).
- Fixed concurrent task mutation data loss during agent invocations.
- Fixed dispatch queue staleness and self-triggering suppression.
- Fixed WebSocket disconnect cleanup for dropped clients.
- Fixed EPIPE handling in JSON-RPC framing output.

## v0.9.1

Bug fixes and stability improvements for the kspec CLI, ralph orchestrator,
and merge driver.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Bug Fixes

- Truncated oversized ACP prompt payloads in ralph to prevent failures.
- Fixed merge driver non-interactive exit code and TTY detection.
- Accepted underscore arg variants in batch payloads.
- Resolved observations slug ambiguity.
- Failed fast for empty batch `--commands` input.
- Avoided shell-based git command execution in shadow operations.
- Added explicit `--agent` override support for setup.
- Accepted P1–P5 priority notation in task commands.
- Included package version in agents freshness hash.
- Prevented task patch TTY hang without `--data`.
- Fixed ralph orchestrator memory leaks causing OOM after long runs.

## v0.9.0

Session event management and ralph adapter improvements.

### New or changed configuration

- Ralph skill invocation became adapter-aware, formatting commands per
  adapter type (Claude Code, Codex).

### Breaking changes

- None.

### Features & Additions

- Added retroactive session event compaction command for managing oversized
  session histories.

### Bug Fixes

- Fixed oversized event payloads in sessions by externalizing them to blob
  storage.
- Routed ralph PR reviews to the dedicated pr-review skill.
- Fixed terminal output streaming to session artifacts.
- Fixed ralph adapter validation false-negative for the codex-acp adapter.

## v0.8.0

Codex integration hardening across setup, skill installation/rendering, and
adapter configuration.

### New or changed configuration

- `codex-acp` adapter gained first-class support and per-role adapter
  selection for ralph loop execution.
- Per-adapter auto-approve argument support added to make loop automation
  behavior adapter-aware.
- Codex `project_doc_fallback_filenames` now seeded with `kspec-agents.md`
  so Codex picks up agent instructions automatically.

### Breaking changes

- None.

### Features & Additions

- Enabled Codex core skill install/render support with namespaced skill
  references.
- Ported project skills to both Claude and Codex render outputs.

### Bug Fixes

- Unified Codex detection behavior across setup/status and enforced Codex
  precedence over Copilot markers.
- Corrected Codex ACP scoped package naming.
- Switched Codex environment injection to TOML and fixed restore handling.
- Fixed shadow git detection for restricted runtime environments.

## v0.7.0

Batch usage documentation for agents, improved CLI discoverability, and a
major test migration from static analysis to E2E.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Features & Additions

- Added the batch usage agent template (`07-batch-usage.md`) documenting
  JSON format, argument rules, and invocation methods.
- Added a path filter to `kspec batch commands` — look up a single
  command's schema via `kspec batch commands "task set"`.

### Bug Fixes

- Fixed bootstrap script detecting stale `dist/` and rebuilding when source
  is newer.
- Improved session-close-error test reliability.

## v0.6.0

Quality and reliability release — massive test migration from static
analysis to E2E, improved validation output, and cross-platform fixes.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Features & Additions

- Split trait AC and own AC coverage in `kspec validate` output for
  clearer coverage visibility.
- Session-scoped checkpoint hook filtering — checkpoints only fire for the
  active session.
- Local test sharding — `npm run test:shard1/2/3` for faster dev runs.

### Bug Fixes

- Bootstrap always npm-links the local kspec build.
- Shadow branch detection works in shallow clones.
- `KSPEC_SESSION_ID` injected via harness config in the ralph loop.

## v0.5.0

Session management overhaul, ralph loop improvements, and multi-harness
support.

### New or changed configuration

- `session_id` added to the task schema for session-scoped task claiming.
- `task budget` schema introduced with CRUD functions and enforcement at
  `task start`.
- Multi-harness environment variable injection added for Gemini CLI and
  OpenCode adapters.

### Breaking changes

- None.

### Features & Additions

- Rewrote `session start` output with primer/full modes, hierarchical
  activity timeline, and computed JSON fields.
- Added triage-aware inbox statistics to `session start`.
- Added `unlocks N` dependency display showing what completing a task
  unblocks.
- Implemented `session create` command and library function.
- Replaced marker files with session budget in the ralph loop.
- Migrated the end-loop signal from a marker file to session state.
- Replaced bash guard scripts with the native `kspec guard worktree`
  command.

### Bug Fixes

- Fixed ralph signal handler to properly await async cleanup.
- Added enum validation for `item set --status` and `--maturity`.
- Added advisory file locking to prevent concurrent write data loss.
- Fixed `task set` null clearing for `--spec-ref` and `--meta-ref`.
- Fixed `task submit` counting toward the max-tasks limit.

## v0.4.0

Core skill system and quality-of-life improvements for the kspec CLI.

### New or changed configuration

- `kspec setup` now installs 11 portable core skills (help, observations,
  reflect, triage, triage-inbox, triage-automation, writing-specs, plan,
  task-work, create-workflow, review).

### Breaking changes

- None.

### Features & Additions

- Core skill system — 11 portable skills now ship with kspec and install
  via `kspec setup`.
- Skill rendering pipeline — content-hash based skip for unchanged skill
  files during regeneration.
- CI improvements — test suite split into 3 parallel shards with path-based
  filtering for faster feedback.

### Bug Fixes

- Fixed plan import dropping `spec_ref` on manual tasks.
- Fixed plan import placing `type:trait` items incorrectly.
- Fixed `task complete --force` to bypass all state checks as intended.
- Fixed JSON-stringify for nested objects in batch arg serialization.

## v0.3.0

Major feature release introducing the daemon, web dashboard, skill system,
plugin architecture, and interactive triage.

### New or changed configuration

- `kspec.config.yaml` introduced with configurable shadow branch, author
  identity, daemon settings, and validation defaults.
- Auto-generated `kspec-agents.md` from meta conventions, workflows, and
  template sections.

### Breaking changes

- Introduced the shadow-branch-backed `.kspec/` worktree architecture.
  Projects initialized prior to this release continue to work but should
  use `kspec init` / `kspec shadow repair` to adopt the new layout.

### Features & Additions

- **Interactive Triage System** — full triage workflow with CLI commands,
  daemon API routes, shared export formatter, and web UI.
- **Web Dashboard** — SvelteKit-based web UI with dashboard, inbox, tasks,
  search, session context, and WebSocket real-time updates.
- **Daemon & Server** — Elysia-based daemon with multi-project support,
  file watching, WebSocket broadcasting, auto-start.
- **Skill System** — full skill lifecycle: import, render, drift detection,
  multi-platform support (Claude Code + Codex), core skill installation,
  and plugin marketplace.
- **Agent Instruction Generation** — auto-generated `kspec-agents.md` from
  meta conventions, workflows, and template sections.
- **Doctor Command** — health check system for diagnosing kspec
  installation issues.
- **Workflow System** — workflow engine with step navigation, pause/resume,
  enforcement modes, and loop mode for autonomous agents.
- **Shadow Branch Merge Driver** — semantic YAML merge for conflict-free
  shadow branch operations.
- **Setup Pipeline** — unified setup with permission seeding, memory
  seeding, and hook installation.
- **Plugin System** — core skills shipped as an npm package plugin with
  marketplace registration.
- **Plan Import** — structured document import for plan-to-spec
  translation.

## v0.1.2

CLI version display fixes and release automation improvements.

### New or changed configuration

- Added the `/release` skill for streamlined version tagging and GitHub
  releases.

### Breaking changes

- None.

### Bug Fixes

- Fixed CLI `--version` flag to read the version from `package.json`
  instead of using a hardcoded value.
- Fixed npm trusted publishers OIDC authentication by upgrading to Node 22
  and `npm@latest`.

## v0.1.1

Bug fixes and documentation updates.

### New or changed configuration

- No new configuration keys.

### Breaking changes

- None.

### Bug Fixes

- Fixed author attribution for auto-generated notes — now properly uses
  the `KSPEC_AUTHOR` environment variable or git user fallback instead of
  hardcoded values.
- Increased timeout for ref resolution test to improve CI reliability.

### Documentation

- Updated `INSTALL.md` with npm installation instructions now that the
  package is published.

## v0.1.0

Initial public release of `@kynetic-ai/spec`.

### New or changed configuration

- Initial configuration surface: `.kspec/kynetic.yaml` manifest, module
  files, project task storage, inbox, plans, reviews, and triage.

### Breaking changes

- N/A (initial release).

### Features & Additions

- First published release of the kspec CLI, library, and schemas.
- YAML-based spec format with Zod validation.
- Task system referencing specs (no duplication).
- Append-only notes with supersession.
- Shadow branch worktree architecture for `.kspec/`.
