# Kynetic Spec - Agent Guide

This document provides context for AI agents working on this project.

## What This Project Is

Kynetic Spec (`kspec`) is a **self-hosting specification and task management system**. It's a structured format for defining project specifications that can be programmatically manipulated, and it tracks its own development using itself.

**Key insight**: This is not just a spec format - it's a living system where the spec IS the source of truth for what to build, and the task system tracks progress on building it.

## The Bootstrap

This project was bootstrapped using itself. The initial implementation was created by:

1. Writing a design document (`KYNETIC_SPEC_DESIGN.md`)
2. Running parallel subagents in git worktrees:
   - One agent wrote the spec defining kspec (`spec/` directory)
   - One agent wrote the parser/CLI (`src/` directory)
3. Merging and aligning the outputs
4. Using `kspec tasks ready` to track further development

The spec files in `spec/` define what kspec should do. The TypeScript code in `src/` implements it. They reference each other.

## Project Structure

```
kynetic-spec/
├── KYNETIC_SPEC_DESIGN.md    # Comprehensive design document (read this first)
├── spec/                      # kspec's own spec (YAML)
│   ├── kynetic.yaml          # Root manifest
│   ├── kynetic.tasks.yaml    # Tasks for implementation
│   └── modules/              # Spec items by domain
│       ├── core.yaml         # Core primitives (ULIDs, slugs, refs)
│       ├── schema.yaml       # Item types, validation
│       ├── tasks.yaml        # Task system
│       └── cli.yaml          # CLI commands
├── src/                       # TypeScript implementation
│   ├── schema/               # Zod schemas
│   ├── parser/               # YAML loading
│   └── cli/                  # Command handlers
└── tests/                     # Vitest tests
```

## Key Concepts

### IDs: ULIDs + Slugs

Every item has:
- **ULID**: Canonical unique ID (e.g., `01JHNKAB01TASK100000000000`)
- **Slugs**: Human-friendly aliases (e.g., `task-project-setup`)

References use `@` prefix: `@task-project-setup` or `@01JHNKAB`

### Spec Items vs Tasks

- **Spec items** (`spec/modules/*.yaml`): Define WHAT to build - features, requirements, constraints
- **Tasks** (`spec/kynetic.tasks.yaml`): Track the WORK of building - status, notes, dependencies

Tasks reference spec items via `spec_ref` field. They don't duplicate spec content.

### Task States

```
pending → in_progress → completed
                ↓
            blocked → (unblock) → in_progress
                ↓
            cancelled
```

`blocked` is auto-computed when `depends_on` tasks aren't completed.

### Notes (Work Log)

Tasks have append-only notes that track progress:
```yaml
notes:
  - _ulid: 01KEYRJ953HRYWJ0W4XEG6J9FB
    created_at: "2026-01-14T17:00:00Z"
    author: "@claude"
    content: |
      What was done and why...
```

Always add notes when completing significant work. This creates an audit trail.

## Working on This Project

### Starting a Session

Always begin by getting session context:

```bash
npx tsx src/cli/index.ts session start
```

This shows:
- **Active work**: Tasks currently in progress
- **Recently completed**: What was just finished
- **Ready tasks**: What can be picked up next
- **Recent commits**: Git activity
- **Working tree**: Uncommitted changes

Options: `--full` for more detail, `--since 1d` to filter by time, `--json` for machine output.

### Start Working on a Task

```bash
npx tsx src/cli/index.ts task start @task-slug
npx tsx src/cli/index.ts task note @task-slug "Starting work on X..."
```

### Complete a Task

```bash
npx tsx src/cli/index.ts task note @task-slug "Completed X, approach was Y..."
npx tsx src/cli/index.ts task complete @task-slug --reason "Brief summary"
```

### View Task Details

```bash
npx tsx src/cli/index.ts task get @task-slug
npx tsx src/cli/index.ts task notes @task-slug
```

## Known Limitations (Bootstrap Code)

This is bootstrap code - not everything works perfectly:

1. **File write location**: Updates write to `tasks.yaml` in root, but reads from `spec/kynetic.tasks.yaml`. For now, edit the spec file directly for authoritative changes.

2. **ULID validation**: ULIDs must be valid format (26 chars, Crockford base32). Generate real ones with:
   ```bash
   node -e "const {ulid} = require('ulid'); console.log(ulid())"
   ```

3. **Some CLI commands are stubs**: Check `src/cli/commands/` to see what's actually implemented.

## Design Decisions

Key decisions are documented in `KYNETIC_SPEC_DESIGN.md` under "Resolved Decisions". Important ones:

- **Format**: YAML with Zod validation
- **Schema source**: Zod (TypeScript-native)
- **Architecture**: Library-first, CLI is a consumer
- **Task-spec relationship**: Tasks reference specs, don't duplicate
- **Notes**: Append-only with supersession
- **Todos**: Lightweight, can promote to full tasks

## The Self-Hosting Loop

The goal is for kspec to be fully self-describing:

1. `kspec session start` to get context
2. Pick a task from ready list
3. `kspec task start @task` to begin
4. Implement it, add notes as you go
5. `kspec task complete @task` when done
6. New tasks unblock, repeat

When working on this project, you ARE using kspec to build kspec. Track your work in the task system.

## Related Files

- `KYNETIC_SPEC_DESIGN.md` - Full design specification
- `FORMAT_COMPARISON.md` - Why YAML was chosen
- `RESEARCH_NOTES.md` - Research that informed design
- `README.md` - User-facing documentation
