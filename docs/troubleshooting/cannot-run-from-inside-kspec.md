# "Cannot Run kspec From Inside the Shadow Directory" Error

You run a kspec command and see the error message "Cannot run kspec from inside .kspec/ directory" (or similar), and the command refuses to execute.

## What This Means

kspec expects to be run from your project root — the directory that contains `.kspec/` as a subdirectory. The `.kspec/` directory is a git worktree for the [shadow branch](../concepts/the-shadow-branch.md), and it has its own `.git` pointer inside it.

If your current working directory is inside `.kspec/` (or is the `.kspec/` directory itself), kspec detects that you are inside the shadow worktree rather than the main project tree. Running commands from this location would operate on the wrong git context, so kspec blocks it.

This most often happens when:

- You navigated into `.kspec/` to inspect a YAML file and forgot to change back.
- A script or terminal session started inside the shadow directory.
- An editor's integrated terminal opened with `.kspec/` as the working directory.

## How to Fix It

Change your working directory back to the project root:

```bash
cd ..
```

If you are nested deeper inside `.kspec/`, navigate up to the project root — the directory that contains `.kspec/` as a child:

```bash
cd /path/to/your/project
```

Then run your kspec command again from the project root.

If you need to inspect files inside `.kspec/`, use your editor or `cat` to read them without changing directories. The kspec CLI provides commands to query spec state directly:

```bash
kspec item get @your-item
kspec task get @your-task
```

These commands read from the shadow branch without requiring you to navigate into `.kspec/`.

## Verification

Confirm you are in the right directory:

```bash
pwd
```

The output should be your project root (the parent of `.kspec/`). Running any kspec command should now work:

```bash
kspec session start
```

A healthy outcome is that the command executes without the "Cannot run kspec from inside .kspec/ directory" error.
