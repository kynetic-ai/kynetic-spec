# Directing Your Agent Effectively

This guide covers how to give your AI coding agent effective instructions using kspec's task lifecycle and conventions. By the end, you will know how to frame requests so your agent stays aligned with your specs and produces traceable work.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- An AI coding agent connected to your project (see [Connecting Your Agent](../getting-started/connecting-your-agent.md))
- At least one spec with acceptance criteria in your project

## Steps

### 1. Start a session

At the beginning of every work session, have your agent run:

```bash
kspec session start
```

This gives the agent your project context: active tasks, specs, and conventions. The agent reads the generated instruction files (`kspec-agents.md` and skills) automatically, but `session start` grounds it in your project's current state.

### 2. Frame requests around specs

Instead of describing implementation details, point your agent to the spec:

```
Work on @task-user-login. The spec is @user-login — read the acceptance criteria and implement accordingly.
```

The agent will run `kspec item get @user-login` to read the ACs and plan its approach. This keeps the agent focused on what the spec requires rather than what you happen to remember to say.

### 3. Let the agent use the task lifecycle

kspec tasks have a defined lifecycle: start, work, submit, review, complete. Direct your agent to follow it:

```
Start the task, create a branch, implement the feature, then submit for review.
```

The agent will run the appropriate commands:

```bash
kspec task start @task-user-login
kspec task branch @task-user-login
# ... implement ...
kspec task submit @task-user-login
```

You do not need to dictate each command. The agent reads the task-work skill and follows the lifecycle.

### 4. Use notes for context

When you want the agent to understand a decision or constraint, add a task note:

```bash
kspec task note @task-user-login \
  "Use the existing auth library in src/lib/auth.ts. Do not add a new dependency."
```

Notes persist across sessions. The next time an agent picks up this task, it sees your constraint without you repeating it.

### 5. Review against acceptance criteria

After the agent submits work, review it against the spec's ACs:

```bash
kspec item get @user-login
```

Each AC describes an observable outcome. Check whether the implementation satisfies each one. If something is missing, create a review record and the agent will address it in a fix cycle.

### 6. Keep the agent on scope

If the agent starts expanding beyond the current task, redirect it:

```
That's outside the scope of @task-user-login. Capture it as an inbox item and continue with the current task.
```

The agent will run:

```bash
kspec inbox add "Discovered: need to refactor auth middleware"
```

This captures the idea without derailing the current work.

### 7. Use conventions to set expectations

Your project's conventions (commit format, naming, testing rules) are defined in `kspec-agents.md` and generated from your project metadata. If you want the agent to follow a new convention, add it:

```bash
kspec meta set development --add-rule "Always run linting before committing"
kspec agents generate
```

The agent reads the updated conventions on its next session.

For all convention management options, run `kspec meta --help`.

## Verification

Ask your agent:

```
What is the current task and what are its acceptance criteria?
```

The agent should run `kspec task get` and `kspec item get` to answer with specific details from your project. If it gives a generic response instead of referencing your actual specs, verify that `kspec setup` has been run and the instruction files exist.
