## Shadow Branch Architecture

`.kspec/` is NOT a regular directory — it's a **git worktree** on an orphan branch (`kspec-meta`).

```
.kspec/.git → file pointing to worktree
  ↓
gitdir: .git/worktrees/-kspec
  ↓
Shadow branch (kspec-meta): orphan branch with spec/task files
```

**Why:** Spec/task changes don't clutter main branch history. Code PRs and spec changes tracked independently.

**How it works:** Every `kspec` command auto-commits to `kspec-meta`. Auto-pushes to remote if tracking configured. Main branch gitignores `.kspec/`.

**CRITICAL: Always run kspec from project root, never from inside `.kspec/`.** If you see "Cannot run kspec from inside .kspec/ directory", check `pwd`.

### Shadow Branch Commands

```bash
kspec shadow status   # Verify health
kspec shadow repair   # Fix broken worktree
kspec shadow sync     # Sync with remote
```

### Troubleshooting

| Issue | Fix |
|-------|-----|
| `.kspec/` doesn't exist | `kspec init` |
| Worktree disconnected | `kspec shadow repair` |
| Sync conflicts | `kspec shadow resolve` |
| Commands seem broken | Check `pwd` — must be project root |
