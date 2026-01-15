---
name: kspec
description: Use kspec CLI for task and spec management. Invoke when working with tasks, tracking work, capturing ideas, checking session status, or managing specs in this project.
---

# Kspec - Task & Spec Management

Kspec is the task and specification management system for this project. **Always use CLI commands, never manually edit YAML files.**

## Quick Reference

```bash
# Session context (run first!)
kspec session start

# Task workflow
kspec task start @task-slug
kspec task note @task-slug "What you did..."
kspec task complete @task-slug --reason "Summary"

# View tasks
kspec tasks ready          # What can be worked on
kspec task get @task-slug  # Full details

# Capture ideas (not yet tasks)
kspec inbox add "idea or thought"
kspec inbox promote @ref --title "Task title"

# Create task directly
kspec task add --title "Title" --priority 2
```

## Core Workflows

### Starting a Session

Always begin by getting context:

```bash
kspec session start
```

This shows: active work, recently completed, ready tasks, inbox items, recent commits, working tree status.

### Task Lifecycle

1. **Start**: `kspec task start @slug` - marks in_progress, sets started_at
2. **Note**: `kspec task note @slug "progress..."` - append-only work log
3. **Complete**: `kspec task complete @slug --reason "done"` - marks completed

**Important**: Add notes as you work, not just at the end. Notes create context for future sessions.

### Creating Tasks

```bash
# Minimal
kspec task add --title "Fix the bug"

# Full
kspec task add \
  --title "Implement feature X" \
  --spec-ref @spec-item \
  --priority 2 \
  --tag feature --tag mvp
```

### Inbox (Quick Capture)

For ideas without clear scope:

```bash
kspec inbox add "maybe we need better error handling"
kspec inbox list                    # Shows oldest first
kspec inbox promote @ref --title "Improve error handling" --priority 2
kspec inbox delete @ref             # If no longer relevant
```

### Spec-First Development

When implementing behavior changes:

1. Check if spec exists: `kspec item get @relevant-item`
2. If no spec, create one: `kspec item add --under @parent --title "New capability" --type requirement`
3. Derive task from spec: `kspec derive @spec-item`

## Command Reference

| Command | Purpose |
|---------|---------|
| `session start` | Get full session context |
| `session checkpoint` | Check for uncommitted work |
| `task start/complete/block` | State transitions |
| `task note` | Add work log entry |
| `task get/list` | View task details |
| `tasks ready` | List actionable tasks |
| `inbox add/list/promote/delete` | Idea capture |
| `item add/get/set` | Spec item CRUD |
| `derive` | Create task from spec |
| `validate` | Check spec integrity |

## Key Principles

1. **Use CLI, not manual YAML** - Commands maintain consistency
2. **Add notes liberally** - Future context depends on it
3. **Track your work** - Start tasks before working, complete when done
4. **Spec is source of truth** - Code implements what spec defines
5. **Inbox for unclear scope** - Promote to task when ready

## Environment

- `KSPEC_AUTHOR` - Attribution for notes (e.g., @claude)
- Run `kspec setup` to configure automatically
