# Kynetic Spec - Agent Guide

@kspec-agents.md

## Required Include

For Codex and any harness that does not auto-resolve `@file` references: **you MUST read `kspec-agents.md` explicitly before doing any project work**.  
Treat `AGENTS.md` + `kspec-agents.md` as a single instruction set.

## What This Project Is

Kynetic Spec (`kspec`) is a **self-hosting specification and task management system**. The spec files in `.kspec/` define what kspec should do. The TypeScript code in `src/` implements it. They reference each other.

**Key insight**: The spec IS the source of truth for what to build, and the task system tracks progress on building it. When working on this project, you ARE using kspec to build kspec.

You are also the **package maintainer** for kspec. Files under `templates/` and `src/` ship to every kspec consumer; treat edits there as changes to the public surface, not as project-local docs. Shared/package guidance must describe universal kspec mechanics only — Kynetic-only policy (branch names, toolchain commands, agent ids, source paths) belongs in the local context surfaces described below. See the `shared-guidance-neutrality` skill for the reviewer rule.

## Project Structure

```
kynetic-spec/
├── .kspec/                    # Spec/task state (shadow branch worktree)
│   ├── kynetic.yaml          # Root manifest
│   ├── project.tasks.yaml    # Active project tasks
│   ├── project.inbox.yaml    # Inbox items
│   └── modules/              # Spec items by domain
├── src/                       # TypeScript implementation
│   ├── schema/               # Zod schemas
│   ├── parser/               # YAML loading
│   └── cli/                  # Command handlers
├── templates/agents-sections/ # Static sections for kspec-agents.md (ships to consumers)
├── templates/skills/          # Package core skill sources (ships to consumers)
│   └── manifest.yaml         # Package skill manifest (ships to consumers)
├── plugin/                    # Generated npm plugin output (gitignored; rebuilt locally)
├── packages/web-ui/           # SvelteKit web interface
└── tests/                     # Vitest tests
```

## Package Maintainer Source Layout

These directories ship with the kspec npm package and are consumed by every kspec project. As the package maintainer, edit the sources here — never the rendered outputs.

| Surface                           | Source                                      | Rendered/consumer-visible output                                                                 |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Package core skills               | `templates/skills/<id>/SKILL.md`            | `.agents/skills/kspec-<id>/`, `.factory/skills/kspec-<id>/`, `plugin/plugins/kspec/skills/<id>/` |
| Package skill manifest            | `templates/skills/manifest.yaml`            | Drives core skill registration in every consumer project                                         |
| Static agent-instruction sections | `templates/agents-sections/NN-<section>.md` | `kspec-agents.md` (between dynamic data) for every consumer                                      |
| TypeScript implementation         | `src/`                                      | Published npm package                                                                            |

Project-local skill sources (`.kspec/skills/`) and project meta conventions stay in the shadow branch and never ship to consumers — those are the right home for Kynetic-only policy.

## Local Repository Policy

This is project-local repository policy for this Kynetic self-hosting repo. Shared package guidance does not describe these values.

### Branch and Merge Targets

- **Integration target for dispatched task work**: `dev`. Dispatch worker branches (`dispatch/task/<slug>/<short-id>`) merge back into `dev` via the supported merge helper after review approval.
- **Release branch**: `main`. Feature-level merges from `dev` → `main` are human-directed and may be done as GitHub PRs.
- **Shadow branch**: `kspec-meta` orphan branch under `.kspec/`. Managed entirely by `kspec` — never run manual git worktree commands inside `.kspec/`.

### External Review (GitHub PRs)

- Dispatched task work is reviewed through **kspec review records** and merged into `dev` via the supported merge helper. Do not open GitHub PRs for dispatched task work.
- GitHub PRs are reserved for **human-directed feature-level merges from `dev` → `main`** and similar release-track activity.

### Dispatch Agents

Default Kynetic dispatch agents (confirm current registry with `kspec agent list`):

| Agent id      | Adapter            | Dispatch triggers                                                         | Role                                                                                    |
| ------------- | ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `task-worker` | `claude-agent-acp` | `task.ready`, `task.in_progress`, `task.needs_work` (automation=eligible) | Dispatched task work; skills include `work-gates`                                       |
| `pr-reviewer` | `codex-acp`        | `task.pending_review`                                                     | Dispatched review; skills include `review-gates`, `merge`, `shared-guidance-neutrality` |

Other agents (`reviewer`, `ux-reviewer`, `ui-worker`, `plan-reviewer`, `primary-dev`) are configured for non-dispatch invocation. Use `kspec agent list` and `kspec meta get @<agent-id>` for the live definitions.

## Quality Gates and Generated Artifact Maintenance

Concrete Kynetic toolchain commands and the regeneration table for `templates/` outputs live in project-local skills, not in shared package guidance:

- **`work-gates` skill** — Kynetic quality gate commands (npm format/lint/typecheck/test, sharded test scripts, kspec validation) and the generated artifact regeneration table (`kspec skill render`, `kspec agents generate`, `npm run build:plugin`). Attached to the `task-worker` agent.
- **`review-gates` skill** — Reviewer mapping of each Kynetic quality gate to `kspec review check --name`/`--runner` values. Attached to all reviewer agents.
- **`shared-guidance-neutrality` skill** — Reviewer checklist for changes to shared/package guidance surfaces (`templates/skills/`, `templates/agents-sections/`, `templates/skills/manifest.yaml`, `plugin/plugins/kspec/skills/`, rendered core skill outputs, generated `kspec-agents.md` sections). Attached to all reviewer agents.

When you change shared package surfaces (`templates/skills/`, `templates/agents-sections/`, `templates/skills/manifest.yaml`), regenerate the corresponding outputs in the same change:

- `kspec skill render` — refreshes `.agents/skills/` and `.factory/skills/` from `templates/skills/` and `.kspec/skills/`.
- `kspec agents generate` — refreshes `kspec-agents.md` from `templates/agents-sections/` plus conventions/workflows/skills.
- `npm run build:plugin` — refreshes `plugin/plugins/kspec/skills/` (gitignored; rebuild locally to verify).

`work-gates` carries the full table; this section is the pointer.

## Agent Instructions Generation

`kspec agents generate` produces `kspec-agents.md` by combining two types of content:

| Source                                              | What it provides                                                                                                       | How to change                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Dynamic data** (from `.kspec/`)                   | Conventions, workflows, skills                                                                                         | `kspec meta set`, `kspec meta add`                                                     |
| **Static templates** (`templates/agents-sections/`) | Quick start, shadow branch, task lifecycle, work/review lifecycle, commit convention, agent dispatch mode, batch usage | Edit the markdown files directly (these ship to consumers — keep them project-neutral) |

Static templates ship with the npm package and provide the structural documentation that doesn't change per-project. Dynamic data is project-local and lives in the shadow branch.

**When to edit templates vs meta:**

- New convention rule → `kspec meta set <domain> --add-rule "..."`
- New workflow → `kspec meta add workflow`
- Changing how a workflow section is _explained_ for every consumer → edit the template file (apply the `shared-guidance-neutrality` rule)
- Adding a new documentation section that ships to every consumer → create `NN-section-name.md` (numeric prefix controls order)
- Adding Kynetic-only policy → put it in `AGENTS.md`, a project-local `.kspec/skills/` skill, or a project meta convention — not in `templates/`

## Skill Source of Truth

Do not edit rendered skill files directly in `.agents/skills/` or `.factory/skills/`.

- **Package core skills** are authored in `templates/skills/<id>/SKILL.md` and listed in `templates/skills/manifest.yaml`. They ship to every kspec consumer — keep them project-neutral (see the `shared-guidance-neutrality` skill).
- **Project-local skills** live in `.kspec/skills/` (shadow branch state) and are managed via `kspec skill add/set/import`. Use these for Kynetic-only procedural checklists; attach them to the relevant agents through `kspec meta` so agents pick them up.
- `.agents/skills/` and `.factory/skills/` are rendered outputs for agent runtimes; regenerate from sources via `kspec skill render` (or `kspec setup`).
- `plugin/plugins/kspec/skills/` is generated by `npm run build:plugin` from `templates/skills/`; `plugin/` is gitignored, so rebuild locally when verifying that core skill changes still render correctly into the plugin output.

## Test Helpers

| Helper                      | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `setupTempFixtures()`       | Copy pre-built fixtures to temp dir           |
| `createTempDir()`           | Create empty temp dir                         |
| `initGitRepo(dir)`          | Initialize git with test config               |
| `setupShadowDetection(dir)` | Set up fake shadow worktree for initContext() |
| `testUlid(prefix?)`         | Generate valid test ULID                      |
| `testUlids(prefix, count)`  | Generate multiple unique ULIDs                |
| `kspec(args, cwd)`          | Run CLI command, return result                |
| `kspecJson<T>(args, cwd)`   | Run CLI with --json, return parsed            |

See `tests/helpers/cli.ts` for full documentation.

## Daemon Test Architecture

Three approaches, each for different purposes:

1. **Static analysis** (vitest): Read source files, verify patterns. Fast, no runtime.
2. **Unit with isolation** (vitest): Test components in temp dirs with `createTempDir()`.
3. **E2E** (Playwright): Full browser integration. See testing and development conventions.

Multi-project tests use `setupMultiDirFixtures()` for isolated project directories.

## Design Decisions

Key decisions documented in `docs/history/KYNETIC_SPEC_DESIGN.md`:

- **Format**: YAML with Zod validation
- **Schema source**: Zod (TypeScript-native)
- **Architecture**: Library-first, CLI is a consumer
- **Task-spec relationship**: Tasks reference specs, don't duplicate
- **Notes**: Append-only with supersession
