# Kynetic Spec - Agent Guide

@kspec-agents.md

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
├── packages/web-ui/           # SvelteKit web interface
└── tests/                     # Vitest tests
```

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
