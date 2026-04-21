# Specs, Tasks, Plans, and Inbox

kspec organizes work into four kinds of items. Each serves a different purpose, and choosing the right one matters — it determines how the item is tracked, reviewed, and eventually completed.

## Why Four Kinds

A single bucket for "things to do" conflates ideas with commitments, requirements with work items, and design with execution. kspec separates them so each kind can carry the right metadata and follow the right lifecycle.

The result: specs don't get lost in task backlogs, tasks don't duplicate spec content, plans coordinate without micromanaging, and the inbox catches everything else without polluting the structured items.

## What Each Kind Is

### Specs

A spec defines **what the software should do**. It's the source of truth for behavior.

Specs form a hierarchy: a module groups related features, a feature describes a capability, and a requirement pins down a specific behavior. Each spec item carries acceptance criteria — structured Given/When/Then statements that say exactly what "done" means.

Specs don't describe how to implement something. They describe the outcome. A spec for "user login" says what happens when a user enters valid credentials, not which library to use for authentication.

### Tasks

A task tracks **the work of building something**. It points to a spec (via `spec_ref`) and carries its own lifecycle: pending, in progress, under review, completed.

Tasks are where execution happens. They accumulate notes about decisions and discoveries, link to branches and commits, and eventually get reviewed against the spec's acceptance criteria. A task doesn't duplicate the spec — it references it.

### Plans

A plan coordinates **a group of specs and tasks that need to ship together**. When a feature is big enough to span multiple specs, a plan captures the design and tracks which specs and tasks have been derived from it.

Plans have their own lifecycle: draft, approved, active, completed, and rejected. You approve a plan before deriving work from it, which prevents wasted effort on designs that haven't been agreed on. A plan that doesn't survive review ends up rejected — a terminal state that keeps the decision visible rather than silently deleting the proposal.

### Inbox

The inbox captures **ideas and observations that aren't yet scoped**. An inbox item is just text, a timestamp, and optional tags. It has no acceptance criteria, no lifecycle states, and no review process.

The inbox exists because not every thought is ready to be a spec or task. Some need more context, some turn out to be duplicates, and some are just notes. Triage converts inbox items into structured work when the time is right.

## How to Decide Which Kind to Use

When you encounter a unit of work, apply these rules in order:

**Is it a clear behavior change with a defined outcome?**
Create a **spec** with acceptance criteria, then derive a **task** from it. The spec defines what should change; the task tracks the work of changing it.

**Is it a large effort spanning multiple specs?**
Create a **plan** first. Capture the design, get it approved, then derive specs and tasks from the plan. This prevents scope creep and ensures the parts fit together.

**Is it infrastructure, tooling, or internal work with no user-visible behavior?**
Create a **task** directly. Not everything needs a spec — work that doesn't change user-facing behavior can skip the spec step.

**Is it vague, incomplete, or something you noticed while doing other work?**
Add it to the **inbox**. Don't interrupt your current task to scope it out. Triage it later when you have context to decide whether it becomes a spec, a task, or nothing.

## How They Surface in Use

When you run `kspec session start`, you see active tasks and inbox items awaiting triage. The CLI commands for each kind follow predictable patterns — `kspec item` for specs, `kspec task` for tasks, `kspec plan` for plans, and `kspec inbox` for the inbox.

During a review, the reviewer checks the task's implementation against the spec's acceptance criteria. The plan, if one exists, provides the broader design context. And if someone spots something that doesn't fit any current spec, it goes into the inbox rather than getting lost in a commit message.

The four kinds create a pipeline: inbox items get triaged into specs, specs get derived into tasks, tasks get worked and reviewed, and plans keep the larger picture coherent.
