## Agent Dispatch Mode

When running as an automated agent via the dispatch engine:

### Dispatch Engine Commands

```bash
# Start background dispatch (daemon must be running)
kspec agent dispatch start

# Inspect active/queued work and loaded agents
kspec agent dispatch status

# Stream live text output from running invocations
kspec agent dispatch watch

# Stop dispatch gracefully
kspec agent dispatch stop
```

### Configured Agents

Worker and reviewer agents are defined in your project's kspec meta data. `kspec setup` seeds default worker/reviewer agent definitions for new projects; the exact agent ids and adapters are project configuration, not part of the kspec package.

Inspect current definitions with:

```bash
kspec agent list
```

Use `kspec agent list` to discover the agent ids configured for your project before relying on a specific handler name.

### Dispatch Rules and Trigger Events

| Trigger event         | Typical handler     | Notes                                                  |
| --------------------- | ------------------- | ------------------------------------------------------ |
| `task.ready`          | configured worker   | Worker picks up newly ready automation-eligible tasks  |
| `task.in_progress`    | configured worker   | Worker can continue existing automation-eligible tasks |
| `task.needs_work`     | configured worker   | Fix-cycle tasks return to worker                       |
| `task.pending_review` | configured reviewer | Review from detached snapshot, merge via helper        |

### One-Shot Invocation

Run a single agent directly (outside dispatch):

```bash
kspec agent run <agent-id> [prompt]
```

Common flags:

- `--task @task-ref` to target a specific task
- `--dry-run` to preview prompt without spawning
- `--json` for structured output
- `--timeout <minutes>` and `--budget <n>` for execution limits

### Dispatch Loop Behavior

```
for each dispatched invocation:
  1. Agent runtime checks eligible tasks — if none, invocation ends
  2. Agent works on tasks
     - Before editing files, use `kspec task branch @ref` for the deterministic
       dispatch-compatible branch (dispatch/task/<slug>/<short-id>)
  3. Agent submits task (kspec task submit @ref) when work is complete
  4. Agent stops responding (turn complete)
  5. Reviewer agent picks up pending_review tasks in a detached snapshot:
     creates kspec review, investigates, submits verdict, merges via
     the supported merge helper if approved (see /kspec:merge)
  6. Continue
```

**Dispatched work is reviewed via kspec review records and merged to the configured integration branch using the supported merge helper.** Whether external review platforms (such as GitHub PRs) are also used is a per-project policy choice — defer to your project's local context for guidance on when to open external review threads.

**When you stop responding, the dispatch engine continues automatically.** Do NOT call `kspec agent end-loop` after submitting a task.

### Task Inheritance

Priority: `needs_work` > `in_progress` > `pending`. Always inherit existing work before starting new tasks. (`pending_review` tasks are handled by the reviewer agent, not the worker.)

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
- Another task is in review (not a formal dependency)
- Merge conflicts that you can resolve (resolve them — see `/kspec:merge` skill conflict handling)

**After blocking a task:**

```bash
kspec task block @task --reason "Reason..."
kspec tasks ready --eligible
# If tasks returned: work on next one
# If empty: stop responding — dispatch engine auto-exits
```

**One blocked task is NOT "no more work."** `kspec tasks ready --eligible` output is authoritative.
