## Ralph Loop Mode

When running in automated loop mode (ralph):

### The Loop

```
for each iteration:
  1. Ralph checks eligible tasks — if none, exits loop
  2. Agent works on tasks, may create PR(s)
  3. Agent stops responding (turn complete)
  4. Ralph sends reflection prompt
  5. Ralph processes pending_review via subagent
  6. Continue
```

**When you stop responding, ralph continues automatically.** Do NOT call `end-loop` after creating a PR.

### Task Inheritance

Priority: `pending_review` > `in_progress` > `pending`. Always inherit existing work before starting new tasks.

### Blocking Rules

**Block only for genuine external blockers:**
- Requires human architectural decision
- Needs spec clarification
- Depends on external API/service not available
- Formally blocked by `depends_on`

**Do NOT block for:**
- Task seems complex (do the work)
- Tests are failing (fix them)
- Service needs running (start it)
- Another task's PR is in CI (not a formal dependency)

**After blocking a task:**
```bash
kspec task block @task --reason "Reason..."
kspec tasks ready --eligible
# If tasks returned: work on next one
# If empty: stop responding — ralph auto-exits
```

**One blocked task is NOT "no more work."** `kspec tasks ready --eligible` output is authoritative.
