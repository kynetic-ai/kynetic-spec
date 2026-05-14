# Shadow Branch Is Out of Sync With Remote

You run `kspec shadow status` and see a message that your local shadow branch is behind or ahead of the remote, or you notice that spec and task changes made by a teammate are not showing up locally.

## What This Means

The [shadow branch](../concepts/the-shadow-branch.md) is an independent git branch that tracks spec state separately from your code branches. Like any git branch, it can fall out of sync when multiple contributors are making changes. The local copy on your machine may have commits that the remote does not, or the remote may have commits that you have not pulled yet.

This is normal when teams share spec state. It's the same situation as a code branch being behind `origin` — it just needs syncing.

## How to Fix It

Run the sync command from your project root:

```bash
kspec shadow sync
```

This pushes your local shadow branch commits to the remote and pulls any remote commits that you don't have locally. If both sides have diverged, kspec will attempt to merge them.

If the sync reports a conflict, run:

```bash
kspec shadow resolve
```

This opens the conflict resolution flow. Most shadow branch conflicts are in YAML files and resolve cleanly once you choose which version of a changed field to keep.

## Verification

After syncing, confirm that the branch is healthy:

```bash
kspec shadow status
```

A healthy outcome shows the local and remote branches at the same commit with no pending changes. You should see your teammate's specs and tasks when you run `kspec item list` or `kspec task list`.
