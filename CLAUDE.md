# Claude Instructions

@AGENTS.md

Read the AGENTS.md file for full project context. Key points:

## Quick Start

```bash
# First: Get session context (active work, ready tasks, recent activity)
npx tsx src/cli/index.ts session start

# Get details on a specific task
npx tsx src/cli/index.ts task get @task-slug

# When starting work
npx tsx src/cli/index.ts task start @task-slug
npx tsx src/cli/index.ts task note @task-slug "What you're doing..."

# When done
npx tsx src/cli/index.ts task note @task-slug "What was done, how, why..."
npx tsx src/cli/index.ts task complete @task-slug --reason "Summary"
```

## Important

1. **This project tracks itself** - Use kspec commands to track your work
2. **Add notes** - Document what you do in task notes for future context
3. **Check dependencies** - Tasks have `depends_on` relationships; complete prerequisites first
4. **Read the design doc** - `KYNETIC_SPEC_DESIGN.md` has comprehensive details
5. **Spec is source of truth** - `spec/` defines what to build; code implements it
