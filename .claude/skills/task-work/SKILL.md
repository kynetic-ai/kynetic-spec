---
name: task-work
description: Work on a kspec task with proper lifecycle - verify, start, note, submit, PR, complete.
---

Base directory for this skill: /home/chapel/Projects/kynetic-spec/.claude/skills/task-work

# Task Work Session

Structured workflow for working on tasks. Full lifecycle from start through PR merge.

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

## Task States

```
pending → in_progress → pending_review → completed
```

- `task start` → in_progress (working on it)
- `task submit` → pending_review (code done, PR created, awaiting merge)
- `task complete` → completed (PR merged)

## Workflow Overview

9 steps for full task lifecycle:

1. **Choose Task** - Select from ready tasks
2. **Verify Not Done** - Check git history, existing code
3. **Start Task** - Mark in_progress
4. **Work & Note** - Add notes during work
5. **Commit** - Ensure changes committed with trailers
6. **Submit Task** - Mark pending_review
7. **Create PR** - Use /pr skill
8. **PR Merged** - Wait for review and merge
9. **Complete Task** - Mark completed after merge

## Key Commands

```bash
# See available tasks
kspec tasks ready

# Get task details
kspec task get @task-slug

# Start working (in_progress)
kspec task start @task-slug

# Add notes as you work
kspec task note @task-slug "What you're doing..."

# Submit for review (pending_review) - code done, PR ready
kspec task submit @task-slug

# Complete after PR merged (completed)
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

## Submit vs Complete

**Submit** (`task submit`):
- Use when code is done and you're creating a PR
- Task moves to `pending_review`
- Indicates "ready for review, not yet merged"

**Complete** (`task complete`):
- Use only after PR is merged to main
- Task moves to `completed`
- Indicates "work is done and shipped"

**Why this matters:**
- Tracks tasks awaiting merge separately from done tasks
- `kspec tasks ready` won't show pending_review tasks as available
- Gives accurate picture of what's in progress vs awaiting review

## After Completion

After completing a task:

1. Check if other tasks were unblocked: `kspec tasks ready`
2. Consider starting the next task
3. If work revealed new tasks/issues, add to inbox

## Integration with Other Workflows

- **Before submit**: Consider `/local-review` for quality check
- **After submit**: Use `/pr` to create PR
- **For merge**: Use `@pr-review-merge` workflow
- **After merge**: Complete the task
