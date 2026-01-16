# Claude Instructions

@AGENTS.md

Read the AGENTS.md file for full project context. Key points:

## Quick Start

```bash
# First: Get session context (active work, ready tasks, inbox, recent activity)
npm run dev -- session start

# Get details on a specific task
npm run dev -- task get @task-slug

# When starting work
npm run dev -- task start @task-slug
npm run dev -- task note @task-slug "What you're doing..."

# When done
npm run dev -- task note @task-slug "What was done, how, why..."
npm run dev -- task complete @task-slug --reason "Summary"

# Create a new task
npm run dev -- task add --title "Task title" --spec-ref "@spec-item" --priority 2

# Capture ideas quickly (not yet tasks)
npm run dev -- inbox add "idea or random thought"
npm run dev -- inbox promote @ref --title "Task title"

# Validate spec files
npm run dev -- validate
```

## Important

1. **Use CLI, not manual YAML edits** - Always use `kspec task add`, `task note`, etc. Never manually edit task YAML
2. **This project tracks itself** - Use kspec commands to track your work
3. **Add notes** - Document what you do in task notes for future context
4. **Check dependencies** - Tasks have `depends_on` relationships; complete prerequisites first
5. **Read the design doc** - `KYNETIC_SPEC_DESIGN.md` has comprehensive details
6. **Spec is source of truth** - `.kspec/` defines what to build; code implements it
