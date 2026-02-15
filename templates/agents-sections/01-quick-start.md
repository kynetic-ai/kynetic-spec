## Quick Start

```bash
# First time or any session — handles install, build, link, init if needed
node scripts/bootstrap.cjs

# If already set up, just get session context
kspec session start
```

Use `kspec` for all commands. Only use `npm run dev --` when testing uncommitted code changes.

## Essential Rules

1. **Use CLI, not manual YAML edits** — Never manually edit files in `.kspec/`. CLI auto-commits to shadow branch.
2. **Spec before code** — If changing behavior, check spec coverage. Update spec first if needed.
3. **Add notes** — Document what you do in task notes for audit trail.
4. **Check dependencies** — Tasks have `depends_on` relationships; complete prerequisites first.
5. **Always confirm** — Ask before creating or modifying spec items.
6. **Batch mutations** — Use `kspec batch` for 2+ sequential write operations (one atomic commit).
