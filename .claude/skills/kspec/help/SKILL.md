---
name: help
description: Get help with kspec commands and workflows
---
<!-- kspec-managed -->
# kspec CLI Map

Quick overview of available commands. **Use `kspec help <command>` for detailed syntax and options.**

## Tasks

| Command | What it does |
|---------|-------------|
| `kspec tasks ready` | Show tasks available to work on |
| `kspec tasks list` | List tasks with filters (--status, --tag, --grep) |
| `kspec task get @ref` | Full task details |
| `kspec task start @ref` | Begin working (→ in_progress) |
| `kspec task note @ref "..."` | Add context note |
| `kspec task submit @ref` | Submit for review (→ pending_review) |
| `kspec task complete @ref` | Mark done after merge (→ completed) |
| `kspec task block @ref` | Block with reason |
| `kspec task add --title "..."` | Create a new task |
| `kspec task set @ref` | Update fields (--priority, --tag, --depends-on) |

## Specs

| Command | What it does |
|---------|-------------|
| `kspec item list` | List spec items (--type, --tag, --tree) |
| `kspec item get @ref` | Show spec with ACs and traits |
| `kspec item add --under @parent` | Create spec item |
| `kspec item set @ref` | Update spec fields |
| `kspec item ac add @ref` | Add acceptance criterion (--given/--when/--then) |
| `kspec item ac list @ref` | List acceptance criteria |
| `kspec derive @ref` | Create tasks from spec (--dry-run first) |

## Inbox

| Command | What it does |
|---------|-------------|
| `kspec inbox add "..."` | Quick-capture an idea |
| `kspec inbox list` | List inbox items |
| `kspec inbox promote @ref` | Convert to task (--title required) |
| `kspec inbox delete @ref` | Remove item |

## Session & Context

| Command | What it does |
|---------|-------------|
| `kspec session start` | Get full session context |
| `kspec meta focus "..."` | Set current focus |
| `kspec meta thread` | Manage parallel work streams |
| `kspec meta question` | Track open questions |
| `kspec meta observe` | Record observations and friction |

## Validation & Search

| Command | What it does |
|---------|-------------|
| `kspec validate` | Check schema, refs, alignment |
| `kspec search "pattern"` | Search across all entities |
| `kspec refs @ref` | Show inbound references |
| `kspec log @ref` | Find commits by task/spec |

## Infrastructure

| Command | What it does |
|---------|-------------|
| `kspec init` | Initialize kspec in a project |
| `kspec setup` | Configure agent environment |
| `kspec doctor` | Health check (shadow branch, setup) |
| `kspec shadow status` | Shadow branch health |
| `kspec shadow repair` | Fix broken worktree |
| `kspec serve start` | Start daemon server |
| `kspec skill render` | Render skills to platform files |
| `kspec agents generate` | Regenerate kspec-agents.md |
| `kspec batch` | Execute multiple commands atomically |
| `kspec export` | Export data to JSON or HTML |

## Key Patterns

- **References**: Use `@` prefix — `@task-slug` or `@01JHNKAB` (ULID)
- **Dry run**: Most mutating commands support `--dry-run`
- **JSON output**: Most commands support `--json`
- **Batch ops**: Use `kspec batch` for 2+ sequential writes (atomic commit)
