## Agent Dispatch Mode

When running as an automated agent via the dispatch engine:

### Dispatch Loop

```
for each dispatched invocation:
  1. Agent runtime checks eligible tasks — if none, invocation ends
  2. Agent works on tasks, may create PR(s)
     - Before editing files on a selected task, create/switch to a dedicated task branch
  3. Agent stops responding (turn complete)
  4. pr-reviewer agent handles pending_review tasks via separate dispatch
  5. Continue
```

**When you stop responding, the dispatch engine continues automatically.** Do NOT call `end-loop` after creating a PR.

### Task Inheritance

Priority: `needs_work` > `in_progress` > `pending`. Always inherit existing work before starting new tasks. (`pending_review` tasks are handled by the pr-reviewer agent, not the worker.)

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
# If empty: stop responding — dispatch engine auto-exits
```

**One blocked task is NOT "no more work."** `kspec tasks ready --eligible` output is authoritative.
