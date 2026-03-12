# kspec

`kspec` is spec-first task management for AI-assisted development.

It gives you a durable spec tree, linked implementation tasks, and a shadow-branch workflow that keeps project planning state out of your main git history. The result is a tighter loop between "what should exist", "what is being worked on", and "what shipped".

> Early-stage software: expect rough edges and command/API changes while the workflow stabilizes.

## Why teams use it

- Define features and requirements before implementation.
- Derive tasks directly from specs instead of duplicating intent in tickets.
- Keep spec and task state in a separate `kspec-meta` branch via the `.kspec/` worktree.
- Give human and AI contributors the same project context through `kspec session start` and generated agent instructions.

## Quick start

Install `kspec`:

```bash
npm install -g @kynetic-ai/spec
```

Or run it without a global install:

```bash
npx @kynetic-ai/spec --help
```

Initialize a project:

```bash
kspec init
kspec setup
kspec session start
```

That three-command sequence is the common starting point across real kspec projects:

1. `kspec init` creates the project manifest plus the `.kspec/` shadow worktree.
2. `kspec setup` configures agent authoring and local runtime integration.
3. `kspec session start` shows active work, ready tasks, and pending project context.

For install details, cloning existing kspec projects, and troubleshooting, see [INSTALL.md](INSTALL.md).

## The spec-first loop

The core workflow is short:

```bash
# 1. Define what should exist
kspec item add --under @main --title "Contributing guide" --type feature --slug contributing-guide
kspec item ac add @contributing-guide \
  --given "a new contributor opens the repository" \
  --when "they look for project workflow guidance" \
  --then "they can follow a documented path to set up, make changes, and submit work"

# 2. Derive implementation work from the spec
kspec derive @contributing-guide

# 3. Start and track execution
kspec task start @task-contributing-guide
kspec task note @task-contributing-guide "Drafting CONTRIBUTING.md and linking it from README."

# 4. Submit after code/docs + PR are ready
kspec task submit @task-contributing-guide

# 5. Complete after merge
kspec task complete @task-contributing-guide --reason "Merged in PR #123."
```

For the full walkthrough from install to first completed task, see [docs/getting-started.md](docs/getting-started.md).

## How it works

### Specs stay separate from product code

By default, `kspec` stores specs, tasks, plans, and workflow state inside `.kspec/`, which is a git worktree backed by an orphan `kspec-meta` branch. Your source branch stays focused on code. Your planning state remains versioned and auditable.

### Tasks stay linked to intent

When you run `kspec derive @spec-ref`, the resulting task keeps a `spec_ref` back to the originating item. Reviews can validate the implementation against acceptance criteria instead of relying on a loosely-related ticket title.

### Agents get the same context humans do

`kspec setup` and `kspec agents generate` produce project-scoped instructions and skills so agents can follow the same conventions, workflows, and task lifecycle you use manually.

## Where to go next

- [docs/getting-started.md](docs/getting-started.md): first-project tutorial for humans and agents
- [INSTALL.md](INSTALL.md): installation, setup modes, and troubleshooting
- [AGENTS.md](AGENTS.md): project instructions for agent contributors
- [docs/history/KYNETIC_SPEC_DESIGN.md](docs/history/KYNETIC_SPEC_DESIGN.md): design rationale and architecture history

## Developing kspec itself

This repository is the source for the `@kynetic-ai/spec` npm package. If you want to work on `kspec` rather than adopt it in another repo, use the contributor/development setup in [INSTALL.md](INSTALL.md#from-source) and the project workflow in [AGENTS.md](AGENTS.md).
