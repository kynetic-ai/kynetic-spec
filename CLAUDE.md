# Claude Instructions

@AGENTS.md

Read the AGENTS.md file for full project context. Key points:

## Quick Start

```bash
# First: Get session context (active work, ready tasks, inbox, recent activity)
npx tsx src/cli/index.ts session start

# Get details on a specific task
npx tsx src/cli/index.ts task get @task-slug

# When starting work
npx tsx src/cli/index.ts task start @task-slug
npx tsx src/cli/index.ts task note @task-slug "What you're doing..."

# When done
npx tsx src/cli/index.ts task note @task-slug "What was done, how, why..."
npx tsx src/cli/index.ts task complete @task-slug --reason "Summary"

# Create a new task
npx tsx src/cli/index.ts task add --title "Task title" --spec-ref "@spec-item" --priority 2

# Capture ideas quickly (not yet tasks)
npx tsx src/cli/index.ts inbox add "idea or random thought"
npx tsx src/cli/index.ts inbox promote @ref --title "Task title"

# Validate spec files
npx tsx src/cli/index.ts validate
```

## Important

1. **Use CLI, not manual YAML edits** - Always use `kspec task add`, `task note`, etc. Never manually edit task YAML
2. **This project tracks itself** - Use kspec commands to track your work
3. **Add notes** - Document what you do in task notes for future context
4. **Check dependencies** - Tasks have `depends_on` relationships; complete prerequisites first
5. **Read the design doc** - `KYNETIC_SPEC_DESIGN.md` has comprehensive details
6. **Spec is source of truth** - `spec/` defines what to build; code implements it
