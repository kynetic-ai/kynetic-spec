# Installing kspec in Your Project

This guide covers installing and setting up kspec in your own projects. For developing kspec itself, see [README.md](README.md).

## Prerequisites

- **Node.js** v18 or later
- **npm** (or pnpm/yarn)
- **Git** - Your project must be a git repository for shadow branch mode (the default)

## Installation

### From Source (Current)

```bash
git clone https://github.com/kynetic-ai/kynetic-spec.git ~/tools/kspec
cd ~/tools/kspec
npm install && npm run build && npm link
```

### npm (Coming Soon)

Once published to npm:

```bash
npm install -g @kynetic/spec
```

Or without global install:

```bash
npx @kynetic/spec <command>
```

## Setup

There are two setup paths depending on whether your project already uses kspec.

### Fresh Project (No Existing kspec)

For projects not yet using kspec:

```bash
cd your-project
kspec init        # Creates shadow branch + .kspec/ worktree
kspec setup       # Configure agent author + hooks
```

This creates:

```
.kspec/                     # Shadow worktree (gitignored from main branch)
  <project>.yaml            # Manifest
  <project>.tasks.yaml      # Task file
  modules/
    main.yaml               # Spec items
```

The shadow branch (`kspec-meta`) keeps spec/task files separate from your main branch history. If you're not using git or prefer simpler setup, use `kspec init --no-shadow` to create files in `spec/` instead. See [AGENTS.md](AGENTS.md#shadow-branch-worktree-architecture) for architecture details.

### Existing kspec Project (Cloning a Repo)

When cloning a repository that already uses kspec:

```bash
git clone <repo-url>
cd <repo>
kspec setup --auto-worktree  # Creates .kspec/ from existing kspec-meta branch
```

This is the typical path for agents joining established projects. The `--auto-worktree` flag automatically creates the `.kspec/` directory if the `kspec-meta` branch exists on the remote.

## Agent Configuration

The `kspec setup` command auto-detects your agent environment and configures:

- **KSPEC_AUTHOR** - Environment variable for note attribution (e.g., `@claude`, `@aider`)
- **Hooks** - Claude Code hooks for spec-first reminders and session checkpoints

```bash
kspec setup              # Auto-detect and configure
kspec setup --dry-run    # Preview what would be configured
kspec setup --no-hooks   # Skip hook installation
```

For manual configuration or supported agent list, see [README.md Agent Integration](README.md#agent-integration).

## Verification

After setup, verify everything works:

```bash
kspec --version        # Confirm installation
kspec shadow status    # Should show "healthy"
kspec session start    # Should display project context
```

Also check:
- `.kspec/` directory exists
- `.kspec/` is listed in `.gitignore`

## Working Directory

> **Important:** Always run kspec commands from your project root, not from inside `.kspec/`.

If you see "Cannot run kspec from inside .kspec/ directory", navigate to your project root first:

```bash
cd ..  # Return to project root
kspec session start
```

## Quick Reference

Essential commands after setup:

```bash
kspec session start              # Get context at session start
kspec task start @task-slug      # Begin work on a task
kspec task note @task-slug "..." # Document what you're doing
kspec inbox add "..."            # Capture ideas for later
```

See [README.md](README.md#task-management) for full command reference.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "kspec: command not found" | Run `npm link` again from kspec directory, or use full path |
| "Not a git repository" | Run `git init` first, or use `kspec init --no-shadow` |
| "Cannot find .kspec" | Run `kspec init` (fresh project) or `kspec setup --auto-worktree` (cloned repo) |
| ".kspec already exists" | Use `kspec init --force` to reinitialize |
| "Cannot run from inside .kspec/" | Run `cd ..` to return to project root |
| Shadow branch errors | Run `kspec shadow repair` |
| Sync conflicts | Run `kspec shadow resolve` |

### Recovery Commands

```bash
kspec shadow status    # Diagnose issues
kspec shadow repair    # Fix broken worktree
kspec init --force     # Reinitialize completely (use as last resort)
```

## Next Steps

- [AGENTS.md](AGENTS.md) - Detailed workflows for AI agents
- [README.md](README.md#task-management) - Full CLI reference
