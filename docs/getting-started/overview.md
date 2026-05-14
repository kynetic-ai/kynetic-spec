# Overview

kspec is a specification and task management system for software projects that use AI coding agents. It gives your project a structured way to define **what** to build, track the **work** of building it, and keep agents aligned with your intentions through the entire lifecycle.

## Who kspec is for

kspec is designed for developers who:

- Direct AI agents (Claude Code, Cline, Cursor, Windsurf, or similar) to write code in their projects
- Want a durable record of what was decided, what was built, and why
- Need their agents to understand project context without lengthy re-explanations each session

If you work with AI coding agents and have ever wished they could pick up where they left off, follow your conventions, or understand the bigger picture of your project, kspec gives you the structure to make that happen.

## What kspec does

kspec organizes your project around three ideas:

- **Specs** define desired behavior using acceptance criteria. A spec says what the software should do, not how to build it.
- **Tasks** track the work of satisfying a spec. A task references a spec and carries its own lifecycle: start, work, submit for review, complete.
- **Agent instructions** are generated from your project's conventions, workflows, and specs so that every agent session starts with the right context.

These pieces work together in a loop:

```
Define spec → Derive task → Agent works → Review → Complete → Next spec
```

Each iteration produces commits linked back to the governing spec and task, giving you a traceable history from intention through delivery.

## How it fits into your workflow

kspec is a CLI tool that runs alongside your existing tools. It does not replace Git, your editor, or your CI system. Instead, it adds a layer of structured intent:

- **Before coding**: Define what you want in a spec with acceptance criteria
- **During coding**: Your agent reads the spec and works within the task lifecycle
- **After coding**: Reviews verify work against the spec's acceptance criteria, and completed tasks close the loop

Your specs and tasks live on a separate Git branch (the "shadow branch") so they never clutter your main branch history. The CLI handles all shadow branch operations automatically.

## What you will build in this guide

Over the next few pages you will:

1. **Install** kspec on your machine
2. **Initialize** a project with the shadow branch and agent configuration
3. **Connect** your AI coding agent so it can read kspec's instructions
4. **Complete your first action** by creating a spec, deriving a task, and working it

By the end, you will have a working kspec project and hands-on experience with the core loop.

---

**Next:** [Installation](./installation.md)
