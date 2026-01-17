# .kspec Directory - Git Worktree Warning

This directory is a **git worktree** tracking the `kspec-meta` branch.

## Rules

1. **NEVER create branches here** - no `git checkout -b`, no `git branch`
2. **NEVER switch branches** - this worktree must stay on `kspec-meta`
3. **Only commit spec/task changes** - this branch contains YAML specs, not source code

## If You're Here By Mistake

You probably meant to be in the parent directory:
```bash
cd /home/chapel/Projects/kynetic-spec
```

## If Branch Was Accidentally Changed

Fix it:
```bash
git checkout kspec-meta
```

## What Belongs Here

- `*.yaml` spec and task files
- Module definitions in `modules/`
- Session data in `sessions/`

## What Does NOT Belong Here

- Source code changes
- Feature branches
- Anything meant for `main` branch
