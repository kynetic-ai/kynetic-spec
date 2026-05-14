# Working With kspec Through an Agent

kspec is designed so that AI agents and humans share the same project context. This page explains the mental model for directing an agent that uses kspec: how to frame requests, what the agent decides on its own, what it asks about, and how to read what it has done.

## Why This Matters

An AI agent working on your codebase needs the same things a human contributor needs: a clear description of what to build, criteria for when it's done, and a way to record what happened. Without that structure, the agent either asks too many questions or guesses wrong.

kspec provides that structure. The agent reads specs to understand requirements, follows the task lifecycle to track progress, and writes notes so you can see its reasoning after the fact. You don't need to restate context that's already in the spec — the agent can look it up.

## What the Agent Decides on Its Own

When an agent picks up a task, it handles most of the execution independently:

- **Reading specs and acceptance criteria.** The agent uses `kspec item get` and `kspec task get` to understand what's expected. You don't need to paste requirements into the prompt.
- **Choosing an implementation approach.** The agent plans based on the spec's acceptance criteria, existing code patterns, and any notes on the task.
- **Writing code and tests.** The agent implements the feature, writes tests annotated against acceptance criteria, and runs the test suite.
- **Recording progress.** The agent adds task notes explaining decisions, discoveries, and approach — the same way a human would.
- **Submitting for review.** When the agent believes the work meets all acceptance criteria, it submits the task.

## What the Agent Asks About

Agents escalate when the work requires judgment that the spec doesn't cover:

- **Architectural decisions** not specified in the spec.
- **Scope ambiguity** — when it's unclear whether something is in or out of scope for this task.
- **External blockers** — dependencies that aren't available or specs that need clarification.

If the agent blocks a task, it records a reason. You can unblock it after providing guidance.

## How to Frame Requests

Good requests give the agent a clear starting point:

- **Point to the spec.** "Work on task @task-slug" is better than describing the feature from scratch. The task already links to a spec with acceptance criteria.
- **Be specific about scope.** If you want a subset of the work, say so. Otherwise the agent works toward all acceptance criteria.
- **Trust the lifecycle.** You don't need to tell the agent to write tests or add notes — the task workflow includes those steps.

If you want something that isn't covered by an existing spec, consider creating the spec first. The agent performs better when it has acceptance criteria to check against rather than interpreting a free-form description.

## How to Read What the Agent Did

After an agent works on a task, you can reconstruct what happened:

- **Task notes** show the agent's reasoning, approach, and any surprises it encountered. Check these first.
- **Git commits** carry task and spec trailers, so you can trace commits back to the work item.
- **Test annotations** (`// AC: @spec-ref ac-N`) link each test to the acceptance criterion it covers. This tells you which criteria have been verified.
- **The review record**, if one exists, shows what a reviewer found — including any threads that need attention.

The combination of notes, commits, and AC annotations gives you a complete picture without reading every line of code.

## The Feedback Loop

If the agent's work doesn't meet your expectations, the review process sends it back with specific feedback. The agent reads the review threads, addresses each point, and resubmits. Each cycle narrows the gap between what you wanted and what was built.

Over time, better specs produce better agent output. If you find yourself repeatedly correcting the same kind of mistake, the fix is usually a clearer acceptance criterion or an additional trait — not a longer prompt.
