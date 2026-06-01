# Agents and Dispatch

kspec can assign tasks to AI agents and manage their execution automatically. Agents are defined in the project metadata, and the dispatch engine matches tasks to agents based on trigger rules.

## Why They Exist

Manual task assignment works for small teams, but it becomes a bottleneck when you want to parallelize work across multiple agents or run routine tasks overnight. The dispatch system removes that bottleneck by automatically routing eligible tasks to the right agent.

Agents also bring consistency. A configured agent follows the same conventions, workflows, and task lifecycle every time. It reads the spec, writes tests against acceptance criteria, adds notes, and submits for review — the same steps a human would follow, without variation.

## What an Agent Is

An agent in kspec is a definition that describes an AI participant's capabilities, constraints, and dispatch rules. Each agent has:

- **An identity** — a name and ID used to track which agent did what.
- **Capabilities** — what the agent is allowed to do (work tasks, review submissions, etc.).
- **Dispatch rules** — which events trigger this agent. For example, a worker agent might respond to `task.ready` and `task.needs_work` events, while a reviewer agent responds to `task.pending_review`.
- **Budget and concurrency limits** — how many turns an agent can take and how many tasks it can handle at once.

kspec ships with four built-in agent definitions: a task worker that handles implementation, a PR reviewer that handles review and merge, a primary dev for general-purpose development work, and a plan reviewer that evaluates plans. Projects can customize these or define additional agents.

## How Dispatch Works

The dispatch engine is a loop that watches for events and matches them to agents:

1. **An event occurs** — a task becomes ready, a submission arrives for review, or a fix cycle returns a task to the worker.
2. **The engine checks dispatch rules** — each agent's rules specify which events it handles and any filters (like requiring a task to be marked eligible for automation).
3. **A matching agent is invoked** — the engine spawns the agent in an isolated workspace with the task context.
4. **The agent works** — it follows the task lifecycle: reads the spec, implements, tests, notes, and submits.
5. **The cycle continues** — the submitted task triggers a review event, which the reviewer agent picks up.

Dispatch handles task inheritance automatically. If an agent finishes one task and another eligible task is waiting, it picks up the next one. Priority ordering ensures that fix cycles (tasks that need rework after review) are handled before new tasks.

## What Dispatch Decides vs. What Humans Decide

Dispatch automates the routing, not the judgment. Agents can be blocked just like human contributors when they encounter genuine external blockers — missing specs, architectural decisions that need human input, or dependencies that aren't available.

When an agent blocks a task, it records a reason and checks whether other eligible tasks are available. If none are, the agent stops and the dispatch engine waits for the situation to change.

Tasks must be explicitly marked as eligible for automation to be picked up by dispatch. This is a deliberate gate — not every task should be automated, and the decision to automate is a human one.

## How Agents and Dispatch Surface in Use

**During setup.** `kspec setup` creates default agent definitions. You can inspect them with `kspec agent list` and customize their dispatch rules in the project metadata.

**During execution.** `kspec agent dispatch start` launches the dispatch loop. `kspec agent dispatch status` shows what's running, what's queued, and which agents are active. `kspec agent dispatch watch` streams live output from running agents.

**In task history.** Every note, commit, and state transition made by an agent is attributed to it. When you look at a task's activity, you can see which agent worked on it and what it did.

**For one-off work.** `kspec agent run <agent-id>` runs an agent outside the dispatch loop for a single task. This is useful for testing agent behavior or handling specific tasks manually.

Agents and dispatch are optional. You can use kspec entirely through manual CLI commands and never enable automated dispatch. The system works the same way — dispatch just removes the human from the routing step.

## How Agents Get Spawned: Runners

An agent definition points at either an adapter (the legacy path) or a named runner. A runner is an execution harness with its own configuration — command, args, working directory, environment policy, and credential bindings — layered across project-level and machine-local files. Runners are the right place to put project-wide non-secret settings and machine-specific overrides without leaking them into agent definitions or into the repository.

For the mental model, see [Agent Runners](./agent-runners.md). For configuration walkthroughs and migration guidance, see [Configuring Agent Runners](../guides/configuring-agent-runners.md).
