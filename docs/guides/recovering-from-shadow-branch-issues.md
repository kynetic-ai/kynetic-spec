# Recovering From Shadow Branch Issues

This guide covers diagnosing and fixing common shadow branch problems. By the end, you will have a healthy shadow branch and know how to prevent future issues.

## Prerequisites

- An existing kspec project (initialized with `kspec init`)
- Familiarity with the shadow branch concept (see the Concepts section when available, or the [Initializing a Project](../getting-started/initializing-a-project.md) page)

## Steps

### 1. Check shadow branch status

Start by diagnosing the current state:

```bash
kspec shadow status
```

This reports the health of the `.kspec/` worktree and its connection to the `kspec-meta` branch. Common issues include a disconnected worktree, sync conflicts with a remote, or a missing `.kspec/` directory.

### 2. Repair a broken worktree

If the worktree is disconnected or corrupted:

```bash
kspec shadow repair
```

This reconnects the `.kspec/` directory to the `kspec-meta` branch. The repair command is non-destructive — it does not delete your spec or task data.

For all repair options, run `kspec shadow repair --help`.

### 3. Sync with remote

If your shadow branch is out of sync with a remote (for example, after a teammate pushed changes):

```bash
kspec shadow sync
```

This pulls remote changes and merges them into your local shadow branch. If there are conflicts:

```bash
kspec shadow resolve
```

The resolve command walks you through conflict resolution for shadow branch files.

For all sync options, run `kspec shadow sync --help`.

### 4. Reinitialize if needed

If the `.kspec/` directory is completely missing (for example, after a fresh clone):

```bash
kspec init
```

If the `kspec-meta` branch exists on the remote, `init` reconnects to it and restores your specs and tasks. If no remote branch exists, it creates a new shadow branch.

### 5. Verify the fix

After any repair operation, confirm the shadow branch is healthy:

```bash
kspec shadow status
```

The output should show no issues. Then verify your data is intact:

```bash
kspec item list
kspec task list
```

Your specs and tasks should appear as expected.

### 6. Prevent future issues

To avoid shadow branch problems:

- **Always run kspec from the project root.** Running it from inside `.kspec/` causes the "Cannot run kspec from inside .kspec/ directory" error.
- **Do not manually edit files in `.kspec/`.** Use CLI commands — they handle commits to the shadow branch automatically.
- **Do not run manual git commands inside `.kspec/`.** Use `kspec shadow` commands for worktree operations.
- **Keep your shadow branch pushed.** If your project has a remote, `kspec shadow sync` keeps local and remote in sync.

## Verification

Run the full health check:

```bash
kspec doctor
```

All checks should pass, including the shadow branch check. Then start a session to confirm everything works:

```bash
kspec session start
```

The session output should show your project context without warnings about shadow branch issues.
