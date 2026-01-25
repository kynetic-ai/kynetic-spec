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

## Inherit Existing Work First

**Before starting new work, check for existing in-progress or pending_review tasks.**

```bash
kspec session start  # Shows active work at the top
```

Priority order:
1. **pending_review** - PR awaiting merge, highest priority
2. **in_progress** - Work already started, continue it
3. **ready (pending)** - New work to start

**Always inherit existing work** unless user explicitly says otherwise. If there's an in_progress task, pick it up and continue. If there's a pending_review task, check the PR status and push it to completion.

Only start new work when:
- No in_progress or pending_review tasks exist
- User explicitly tells you to work on something else
- User says to ignore the existing work

This prevents orphaned work and ensures tasks get completed.

## Task States

```
pending → in_progress → pending_review → completed
```

- `task start` → in_progress (working on it)
- `task submit` → pending_review (code done, PR created, awaiting merge)
- `task complete` → completed (PR merged)

## Workflow Overview

10 steps for full task lifecycle:

1. **Check Existing Work** - Inherit in_progress or pending_review tasks first
2. **Choose Task** - Select from ready tasks (if no existing work)
3. **Verify Not Done** - Check git history, existing code
4. **Start Task** - Mark in_progress
5. **Work & Note** - Add notes during work
6. **Commit** - Ensure changes committed with trailers
7. **Submit Task** - Mark pending_review
8. **Create PR** - Use /pr skill
9. **PR Merged** - Wait for review and merge
10. **Complete Task** - Mark completed after merge

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

Before starting, check if work might already be done - but **always validate yourself**:

```bash
# Check git history for related work
git log --oneline --grep="feature-name"
git log --oneline -- path/to/relevant/files

# If code/tests exist, VERIFY they actually work:
npm test -- --grep "relevant-tests"
# Review code against acceptance criteria
# Check coverage is real, not just test.skip()
```

### Notes Are Context, Not Proof

Task notes provide historical context, but **never trust notes as proof of completion**. If a task is in the queue, there's a reason - validate independently:

- **"Already implemented"** → Run the tests yourself. Do they pass? Do they cover the ACs?
- **"Tests exist but skip in CI"** → That's a gap to fix, not a reason to mark complete
- **"Work done in PR #X"** → Verify the PR was merged AND the work is correct

Treat verification like a code review: check the actual code and tests against the acceptance criteria. Don't rubber-stamp based on notes.

### What "Already Implemented" Actually Requires

To mark a task complete as "Already implemented", you must:

1. **Run the tests** and see them pass (not skip)
2. **Verify AC coverage** - each acceptance criterion has a corresponding test
3. **Check the implementation** matches what the spec requires

If tests are skipped, broken, or missing coverage - the task is NOT done. Fix the gaps.

## Scope Expansion During Work

Tasks describe expected outcomes, not rigid boundaries. During work, you may discover:

- **Tests need implementation**: A "testing" task may reveal missing functionality. **Implementing that functionality is in scope** - the goal is verified behavior, not just test files.

- **Implementation needs tests**: An "implementation" task includes proving it works. Add tests.

- **DoD constraints are hard requirements**: If the task notes include Definition of Done criteria, those are not suggestions. Never produce deliverables that violate DoD.

### When to Expand vs Escalate

**Expand scope** (do it yourself) when:
- The additional work is clearly implied by the goal
- It's proportional to the original task (not 10x larger)
- You have the context to do it correctly

**Escalate** (ask user) when:
- Scope expansion is major (testing task becomes architecture redesign)
- You're uncertain about the right approach
- DoD is ambiguous and requires judgment calls

### Anti-patterns to Avoid

- **`test.skip()` as a deliverable**: Never use `test.skip()` to document missing functionality unless explicitly approved by user. Skipped tests give false coverage and fail the goal of verification.

- **Literal task title interpretation**: "Add tests for X" means "ensure X is verified." If X doesn't exist, implement it first.

- **Checkbox completion**: Completing *something* is not the goal. Completing the *right thing* is. If you can't achieve the actual goal, ask for guidance rather than delivering a hollow artifact.

- **Trusting notes without validation**: Notes saying "already done" or "tests exist" are not proof. Run the tests. Check the code. Verify against ACs. If a task is in the ready queue, assume there's unfinished work until you prove otherwise.

- **"Skipped in CI" as acceptable**: Tests that skip in CI are gaps, not completed work. Either fix the CI issue or document why it's acceptable (with user approval).

- **Automation mode shortcuts**: Automation mode means "make good decisions autonomously" - the same decisions a skilled human would make. It does NOT mean take shortcuts, skip hard problems, or produce placeholder deliverables.

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

## Loop Mode

You are running in autonomous loop mode. Start the workflow:

```bash
kspec workflow start @task-work-loop
```

Then follow the workflow steps below.

### Workflow Steps

1. **Get eligible tasks**
   ```bash
   kspec tasks ready --eligible
   ```

2. **Select task** (priority order):
   - First: any `in_progress` task (continue existing work)
   - Then: tasks that unblock others (high impact)
   - Finally: highest priority ready task (lowest number)

3. **Verify work is needed**
   - Check git history for related commits
   - Read existing implementation if files exist
   - If already done: `kspec task complete @task --reason "Already implemented"` and EXIT

4. **Start and implement**
   ```bash
   kspec task start @task
   # Do the work
   kspec task note @task "What you did..."
   ```

5. **Commit and submit**
   ```bash
   git add <files> && git commit -m "feat/fix: description

   Task: @task-slug"
   kspec task submit @task
   ```

6. **Create PR and exit**
   ```bash
   /pr
   ```
   After PR created, EXIT. Ralph handles PR review via separate subagent.

### Exit Conditions

Exit when any of these apply:
- **Task work complete** - PR created (normal exit)
- **No eligible tasks** - `kspec tasks ready --eligible` returns empty
- **All blocked** - All eligible tasks have unmet dependencies
- **Already implemented** - Verification found work already done

### Key Behaviors

- Only `automation: eligible` tasks are considered
- Verification still performed (prevent duplicate work)
- Decisions auto-resolve without prompts
- PR review handled externally by ralph (not this workflow)
