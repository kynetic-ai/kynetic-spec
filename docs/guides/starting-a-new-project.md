# Starting a New Project

This guide walks you through setting up a new kspec project from scratch, including module structure and initial spec planning. By the end, your project will have a shadow branch, agent instructions, and a top-level module ready for specs.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- Node.js 20+ and Git installed
- A Git repository (existing or new)

## Steps

### 1. Initialize kspec

From your project root, run the initialization command:

```bash
kspec init
```

This creates the shadow branch (`kspec-meta`), sets up the `.kspec/` worktree directory, and creates a root manifest. If your repository already has a `kspec-meta` branch (for example, from a clone), `kspec init` reconnects to it.

For the full list of options, run `kspec init --help`.

### 2. Run setup

Generate agent instruction files and skill definitions:

```bash
kspec setup
```

This produces `AGENTS.md`, `kspec-agents.md`, and the `.agents/skills/` directory. Your AI coding agent reads these files automatically when it starts a session in the repository.

For agent-specific setup options, run `kspec setup --help`.

### 3. Verify project health

Confirm everything is wired correctly:

```bash
kspec doctor
```

All checks should pass. If any fail, follow the suggested fix in the output.

### 4. Plan your module structure

kspec organizes specs under modules. The `init` command creates a default top-level module. List your modules:

```bash
kspec item list --type module
```

If your project has distinct domains (for example, a CLI and a web UI), consider creating additional modules:

```bash
kspec item add --type module --title "Web UI" --slug web-ui
kspec item add --type module --title "CLI" --slug cli
```

Modules are organizational — they group related specs. You can restructure them later without losing spec or task data.

### 5. Create your first spec

Under your chosen module, create a feature spec with acceptance criteria:

```bash
kspec item add --under @main \
  --title "User login" \
  --type feature \
  --slug user-login
```

Then add acceptance criteria that describe observable outcomes:

```bash
kspec item ac add @user-login \
  --given "a registered user visits the login page" \
  --when "they enter valid credentials and submit" \
  --then "they are redirected to the dashboard"
```

### 6. Start a session

Begin a work session to see your project context:

```bash
kspec session start
```

The output shows your modules, active tasks, and suggested next actions.

## Verification

Run the following to confirm your project is ready:

```bash
kspec shadow status
```

The output should show a healthy shadow branch with no issues. Then verify your specs are in place:

```bash
kspec item list
```

You should see your module and any specs you created. Your project is now set up and ready for spec-driven development.
