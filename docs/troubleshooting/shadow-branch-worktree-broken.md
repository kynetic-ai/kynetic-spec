# Shadow Branch Worktree Is Broken or Missing

You run a kspec command and see an error that `.kspec/` does not exist, that the worktree is disconnected, or that kspec cannot read its state directory. Alternatively, you notice that the `.kspec/` directory is empty or missing entirely.

## What This Means

kspec stores all of its state in a git worktree checked out into `.kspec/` at your project root. This worktree points at the [shadow branch](../concepts/the-shadow-branch.md) (an orphan branch called `kspec-meta`). The worktree linkage can break if:

- The repository was cloned or moved in a way that didn't preserve git worktree metadata.
- An aggressive `git clean` or manual deletion removed the `.kspec/` directory or its internal `.git` file.
- A git upgrade or filesystem operation corrupted the worktree link files inside `.git/worktrees/`.

When the linkage breaks, kspec cannot find or read its YAML state files, so every command fails.

## How to Fix It

First, check what state the shadow branch infrastructure is in:

```bash
kspec shadow status
```

If the status reports a broken or missing worktree, run the repair command:

```bash
kspec shadow repair
```

This recreates the worktree linkage from the existing shadow branch. Your spec and task data lives on the `kspec-meta` branch in the git history — it is not lost when the worktree breaks. The repair command reconnects the `.kspec/` directory to that branch.

If the shadow branch itself does not exist locally but exists on the remote (common after a fresh clone), run:

```bash
kspec init
```

This detects the remote shadow branch and sets up the local worktree from it.

## Verification

After repairing, confirm that the worktree is healthy:

```bash
kspec shadow status
```

A healthy outcome shows the worktree connected and the shadow branch checked out. You should be able to run `kspec item list` and see your specs and tasks.
