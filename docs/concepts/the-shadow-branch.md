# The Shadow Branch

kspec stores all of its state — specs, tasks, plans, inbox items, reviews, and metadata — on a separate git branch called the shadow branch. This page explains what the shadow branch is, why it exists, and how it appears in your day-to-day work.

## What It Is

The shadow branch is an orphan branch (by default named `kspec-meta`) that has no common history with your source code branches. It's checked out as a git worktree into the `.kspec/` directory at your project root.

From git's perspective, `.kspec/` is a separate working tree pointing at a different branch. From your perspective, it's a directory containing YAML files that kspec reads and writes. Your main branch gitignores `.kspec/`, so spec state never appears in your source code commits.

Every kspec CLI command that modifies state — adding a spec, starting a task, recording a note — automatically commits the change to the shadow branch. You don't run `git add` or `git commit` for spec state. The audit trail builds itself.

## Why It Exists

Spec and task state needs version control, but mixing it into your source branch creates problems:

- **Noisy history.** Every task note, status change, and spec edit would be a commit on your main branch. The signal-to-noise ratio drops fast.
- **Merge conflicts.** Spec YAML files would conflict with other developers' spec changes during code merges, even though spec edits and code edits are independent.
- **Branch coupling.** Feature branches would carry spec state that might not be relevant to the code changes on that branch.

The shadow branch avoids all of this. Spec history lives in its own timeline. Code history stays clean. The two can be pushed and synced independently.

The alternative — storing state in a database or external service — would sacrifice the auditability and portability that git provides. With the shadow branch, your spec history is as durable and inspectable as your code history, and it travels with the repository.

## How It Surfaces in Use

Most of the time, you don't interact with the shadow branch directly. The kspec CLI handles reads and writes transparently. Here's where it shows up:

**Initialization.** When you run `kspec init`, it creates the orphan branch and sets up the `.kspec/` worktree. This is a one-time operation per project.

**Syncing.** If your team shares spec state, `kspec shadow sync` pushes and pulls the shadow branch to a remote. This is separate from pushing your code branches.

**Health checks.** If something goes wrong with the worktree linkage — which can happen after aggressive git operations — `kspec shadow status` diagnoses the problem and `kspec shadow repair` fixes it.

**Cloning.** When someone clones a repository that uses kspec, `kspec init` detects the existing shadow branch on the remote and sets up the local worktree from it.

The key thing to remember: always run kspec commands from your project root, never from inside `.kspec/`. The CLI expects to be in the main working tree and manages the shadow worktree on your behalf.
