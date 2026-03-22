# Kynetic Spec - Agent Guide

@kspec-agents.md

## Required Include

For Codex and any harness that does not auto-resolve `@file` references: **you MUST read `kspec-agents.md` explicitly before doing any project work**.  
Treat `AGENTS.md` + `kspec-agents.md` as a single instruction set.

## What This Project Is

Kynetic Spec (`kspec`) is a **self-hosting specification and task management system**. The spec files in `.kspec/` define what kspec should do. The TypeScript code in `src/` implements it. They reference each other.

**Key insight**: The spec IS the source of truth for what to build, and the task system tracks progress on building it. When working on this project, you ARE using kspec to build kspec.

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
├── templates/agents-sections/ # Static sections for kspec-agents.md
├── packages/web-ui/           # SvelteKit web interface
└── tests/                     # Vitest tests
```

## Agent Instructions Generation

`kspec agents generate` produces `kspec-agents.md` by combining two types of content:

| Source | What it provides | How to change |
|--------|-----------------|---------------|
| **Dynamic data** (from `.kspec/`) | Conventions, workflows, skills | `kspec meta set`, `kspec meta add` |
| **Static templates** (`templates/agents-sections/`) | Quick start, shadow branch, task lifecycle, PR workflow, commit convention, agent dispatch mode, batch usage | Edit the markdown files directly |

Templates ship with the npm package and provide the structural documentation that doesn't change per-project. Dynamic data is project-specific and lives in the shadow branch.

**When to edit templates vs meta:**
- New convention rule → `kspec meta set <domain> --add-rule "..."`
- New workflow → `kspec meta add workflow`
- Changing how a workflow section is *explained* → edit the template file
- Adding a new documentation section → create `NN-section-name.md` (numeric prefix controls order)

## Skill Source of Truth

Do not edit rendered skill files directly in `.agents/skills/`.

- **Core skills** (the ones rendered with `kspec-` prefix under `.agents/skills/`) are authored in `templates/skills/` and listed in `templates/skills/manifest.yaml`.
- **Project/local skills** are stored in `.kspec/skills/` (shadow branch state).
- `.agents/skills/` is rendered output for agent runtimes; regenerate from sources via `kspec skill render` or `kspec setup`.

## Test Helpers

| Helper | Purpose |
|--------|---------|
| `setupTempFixtures()` | Copy pre-built fixtures to temp dir |
| `createTempDir()` | Create empty temp dir |
| `initGitRepo(dir)` | Initialize git with test config |
| `testUlid(prefix?)` | Generate valid test ULID |
| `testUlids(prefix, count)` | Generate multiple unique ULIDs |
| `kspec(args, cwd)` | Run CLI command, return result |
| `kspecJson<T>(args, cwd)` | Run CLI with --json, return parsed |

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
