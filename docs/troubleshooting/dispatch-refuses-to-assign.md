# Agent Dispatch Refuses to Assign a Task

You start the dispatch engine or run an agent, but the task you expect to be picked up is not assigned. The agent reports no eligible work, or the dispatch status shows the task as unmatched.

## What This Means

The [dispatch engine](../concepts/agents-and-dispatch.md) matches tasks to agents based on several conditions. A task will not be assigned if any of these checks fail:

- **The task is not marked as automation-eligible.** Dispatch only picks up tasks where automation has been explicitly enabled. Tasks without this marking are reserved for human contributors.
- **The task is not in a dispatchable state.** Only tasks in `pending`, `in_progress`, or `needs_work` status are candidates for worker agents. Tasks that are `blocked`, `completed`, `cancelled`, or `pending_review` are not routed to workers.
- **No agent matches the trigger event.** Each agent defines which events it handles. If no agent's dispatch rules match the task's current event, it stays in the queue.
- **The task has unmet dependencies.** If a task's `depends_on` references include incomplete tasks, it is not considered ready.

## How to Fix It

Check the task's current state and automation eligibility:

```bash
kspec task get @your-task
```

Look at the `status` and `automation` fields. If automation is not set to `eligible`, mark it:

```bash
kspec task set @your-task --automation eligible
```

Check whether the task has unmet dependencies:

```bash
kspec task get @your-task
```

If dependencies are listed and not completed, those must be finished first, or you can remove the dependency if it's no longer relevant.

Verify which tasks dispatch considers ready:

```bash
kspec tasks ready --eligible
```

If your task does not appear in this list, the output will help you identify what's blocking it.

Check that dispatch is running and has agents configured:

```bash
kspec agent dispatch status
kspec agent list
```

If no agents are defined, run setup to create the defaults:

```bash
kspec setup
```

## Verification

After addressing the issue, confirm the task is now eligible:

```bash
kspec tasks ready --eligible
```

A healthy outcome shows your task in the ready list. If dispatch is running, it should pick up the task on its next cycle. You can watch the assignment happen:

```bash
kspec agent dispatch watch
```

The task should appear in the dispatch output as assigned to a matching agent.
