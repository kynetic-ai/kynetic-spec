# What kspec Is

kspec is a specification-first task management system for software projects. It connects three things that usually drift apart: what the software should do, what people are working on, and what has actually shipped.

## Why It Exists

Most teams track work in one system and define requirements in another — or don't define requirements at all. Over time the gap between "what we intended" and "what we built" widens silently. Nobody notices until a feature is half-implemented, a review has no criteria to check against, or an AI agent invents its own interpretation of what to do.

kspec closes that gap by making specifications the origin point for work. A spec defines what should exist. A task tracks the effort to build it. The task points back to the spec, so anyone reviewing the work — human or agent — can check it against the original intent.

## The Shape of the System

kspec has four layers:

**Spec items** define behavior. They form a tree: modules contain features, features contain requirements, and each item carries acceptance criteria that say exactly what "done" means. Specs live in `.kspec/` as YAML files validated by Zod schemas.

**Tasks** track implementation. A task references a spec and carries its own status, notes, and VCS links. Tasks don't duplicate the spec — they point to it.

**Plans** coordinate larger efforts that span multiple specs and tasks. When a feature is big enough to need design up front, a plan captures the approach before work begins.

**The inbox** catches everything else — observations, ideas, and requests that aren't yet scoped enough to be specs or tasks. Items sit in the inbox until someone triages them.

All of this state lives on a separate git branch (the shadow branch) so it doesn't clutter your source code history. The CLI auto-commits every change, keeping the audit trail intact without manual discipline.

## How It Surfaces in Use

You interact with kspec mainly through its CLI and, optionally, through a local web UI. A typical cycle looks like this:

1. Define a spec with acceptance criteria.
2. Derive a task from that spec.
3. Work the task — writing code, adding notes, annotating tests against acceptance criteria.
4. Submit the task for review.
5. A reviewer (human or agent) checks the work against the spec's acceptance criteria.
6. After approval, the task is marked complete.

At every step, the spec is the reference point. When you run `kspec session start`, you see what's active, what's ready, and what's blocked — all grounded in spec-defined outcomes rather than vague ticket titles.

kspec is also designed to work with AI agents. The same spec and task context that a human reads is available to an agent, so both participants share a single source of truth about what needs to happen and what has been done.
