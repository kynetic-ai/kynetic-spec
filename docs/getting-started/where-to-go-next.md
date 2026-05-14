# Where to Go Next

You have installed kspec, initialized a project, connected your agent, and completed one full spec-to-task cycle. Here is where to go from here.

## Guides

The Guides section covers practical workflows you will use as your project grows:

- **Starting a New Project** — deeper coverage of project setup, module structure, and initial spec planning
- **Directing Your Agent** — how to give your agent effective instructions using kspec's task lifecycle and conventions

## Concepts

The Concepts section explains the ideas behind kspec in more depth:

- **What kspec Is** — the design philosophy and how specs, tasks, and agent instructions relate
- **The Shadow Branch** — how the `kspec-meta` branch works, why specs live separately from code, and how synchronization works

## Useful commands

As you continue working with kspec, these commands will become part of your routine:

```bash
kspec session start            # Orient yourself at the start of a session
kspec inbox add "idea"         # Capture a vague idea for later triage
kspec item add --under @module # Create a new spec item
kspec derive @spec-ref         # Derive tasks from a spec
kspec validate                 # Check spec/task consistency
kspec search "keyword"         # Search across specs, tasks, and inbox
kspec --help                   # Full command reference
```

## Getting help

If something goes wrong:

```bash
kspec doctor                   # Check project health
kspec shadow status            # Check shadow branch state
kspec shadow repair            # Fix a broken shadow worktree
```

For command-specific help, append `--help` to any command:

```bash
kspec task --help
kspec item --help
kspec setup --help
```
