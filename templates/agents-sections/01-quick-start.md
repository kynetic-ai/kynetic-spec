## Quick Start

```bash
# First time setup
kspec init            # Initialize kspec in the project
kspec setup           # Configure agent environment

# Returning to work
kspec session start   # Get session context
```

Verify shadow branch health with `kspec shadow status` if you encounter issues.

## Essential Rules

1. **Use CLI, not manual YAML edits** — Never manually edit files in `.kspec/`. CLI auto-commits to shadow branch.
2. **Spec before code** — If changing behavior, check spec coverage. Update spec first if needed.
3. **Add notes** — Document what you do in task notes for audit trail.
4. **Check dependencies** — Tasks have `depends_on` relationships; complete prerequisites first.
5. **Always confirm** — Ask before creating or modifying spec items.
6. **Batch mutations** — Use `kspec batch` for 2+ sequential write operations (one atomic commit).
7. **Regenerate agent instructions** — Run `kspec agents generate` after changing conventions, workflows, or skills. These are the inputs to `kspec-agents.md`.
