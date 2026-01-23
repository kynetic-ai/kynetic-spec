---
name: task-work
description: Work on a kspec task with proper lifecycle - verify, start, note, complete, commit.
---

Base directory for this skill: /home/chapel/Projects/kynetic-spec/.claude/skills/task-work

# Task Work Session

Structured workflow for working on tasks. Ensures proper lifecycle management.

## Quick Start

```bash
# Start the workflow
kspec workflow start @task-work-session
kspec workflow next --input task_ref="@task-slug"
```

## When to Use

- Starting work on a ready task
- Ensuring consistent task lifecycle
- When you need to track progress with notes

## Workflow Overview

6 steps to complete a task properly:

1. **Choose Task** - Select from ready tasks
2. **Verify Not Done** - Check git history, existing code
3. **Start Task** - Mark in_progress
4. **Work & Note** - Add notes during work, not just at end
5. **Complete** - Mark done with summary
6. **Commit** - Ensure changes committed with trailers

## Key Commands

```bash
# See available tasks
kspec tasks ready

# Get task details
kspec task get @task-slug

# Start working
kspec task start @task-slug

# Add notes as you work
kspec task note @task-slug "What you're doing..."

# Complete with summary
kspec task complete @task-slug --reason "Summary of what was done"
```

## Verification Step

Before starting, always check if work is already done:

```bash
# Check git history
git log --oneline --grep="feature-name"
git log --oneline -- path/to/relevant/files

# Read existing implementation
# If code exists and works, mark complete with "Already implemented"
```

This prevents duplicate work and wasted effort.

## Notes Best Practices

Add notes **during** work, not just at the end:

- When you discover something unexpected
- When you make a design decision
- When you encounter a blocker
- When you complete a significant piece

Good notes help future sessions understand context:

```bash
# Good: explains decision
kspec task note @task "Using retry with exponential backoff. Chose 3 max retries based on API rate limits."

# Bad: no context
kspec task note @task "Done"
```

## Commit Format

Include task trailer in commits:

```
feat: add user authentication

Implemented JWT-based auth with refresh tokens.
Sessions expire after 24h.

Task: @task-add-auth
Spec: @auth-feature

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

This enables `kspec log @task` to find related commits.

## After Completion

After completing a task:

1. Check if other tasks were unblocked: `kspec tasks ready`
2. Consider starting the next task
3. If work revealed new tasks/issues, add to inbox

## Integration with Other Workflows

- **Before PR**: After task complete, use `/pr` to create PR
- **After PR**: Use `@pr-review-merge` workflow for merge
- **Before completing**: Consider `@local-review` for quality check
