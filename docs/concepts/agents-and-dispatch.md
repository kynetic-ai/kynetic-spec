# Agents and Dispatch

Agents are project-defined AI participants. Dispatch is the optional routing loop that matches project events to those definitions and invokes a suitable agent. Together they automate assignment; they do not replace the task, spec, review, or integration records that define the work.

## Why Agents and Dispatch Exist

Agent definitions make repeated work consistent by attaching capabilities, conventions, skills, execution limits, and event rules to a named participant. Dispatch removes the need for a person to notice every ready task or submitted review and start the matching participant by hand.

Projects still decide what may be automated. A dispatch rule can narrow an event to eligible work or another project condition, and an agent can stop at a genuine external blocker just as a human contributor would.

## What Setup Provides

`kspec setup` scaffolds default agent definitions for a fresh project: a task worker, a code review agent, a primary development agent, and a plan reviewer. The task worker responds to ready and needs-work task events with automation eligibility filtering by default. The code review agent responds to pending-review tasks. The primary development agent covers coding, testing, refactoring, and review, while the plan reviewer provides plan-review capability. These scaffolded definitions are write-authorized so they can carry out their roles.

They are starting points, not built-in identities that every project must keep. Projects can configure or rename them, deliberately remove them, or add different agents. The live agent registry is authoritative after setup.

## How Dispatch Surfaces in Use

When a matching event occurs, dispatch evaluates the live rules, selects an agent, and prepares an isolated task workspace. A worker reads the task and spec, implements and verifies the change, records notes, and submits it. Review uses a separate snapshot. If changes are requested, a later worker resumes the canonical workspace and task branch.

Dispatch status shows admission authority and observable active, queued, held, cleanup, and degraded-target state. Lifecycle controls govern whether new work may start and whether dispatch-owned work is cancelled; they do not change semantic task readiness or delete workspace evidence.

For the durable isolation and continuity model, read [Dispatch Workspaces](./dispatch-workspaces.md). For operational detail, use [Configuring Dispatch Workspaces](../guides/configuring-dispatch-workspaces.md), [Controlling Dispatch Lifecycle](../guides/controlling-dispatch-lifecycle.md), and the supported [troubleshooting paths](../troubleshooting/index.md).

## Runners and One-Off Invocation

An agent definition points to an execution adapter or a named runner. Runners hold reusable execution configuration and separate project-owned settings from machine-local credentials. See [Agent Runners](./agent-runners.md) for that boundary and [Configuring Agent Runners](../guides/configuring-agent-runners.md) for the setup walkthrough.

An operator can also invoke an agent once without entering the dispatch loop. That one-off path is useful for targeted work and runner testing, but it is not automatically owned by dispatch workspace or lifecycle management.
