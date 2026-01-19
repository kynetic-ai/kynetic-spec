# Claude Instructions

@AGENTS.md

Read the AGENTS.md file for full project context. Key points:

## Quick Start

**Note:** Use `npm run dev --` when working on kspec itself (runs TypeScript directly, no build needed). Use `kspec` for normal usage after running `npm link`.

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

## Plan Mode Workflow

When a plan is approved, you MUST translate it to specs before implementing:

```bash
# 1. Create spec item under appropriate parent
npm run dev -- item add --under @parent --title "Feature Name" --type feature --slug feature-slug

# 2. Add acceptance criteria (repeat for each AC)
npm run dev -- item ac add @feature-slug --given "precondition" --when "action" --then "expected result"

# 3. Derive implementation task
npm run dev -- derive @feature-slug

# 4. Add implementation notes from plan to task
npm run dev -- task note @task-slug "Implementation approach: ..."

# 5. Begin implementation
npm run dev -- task start @task-slug
```

**Plans without specs are incomplete.** The spec with acceptance criteria IS the durable artifact - plan files may not persist across sessions. Always capture:
- Feature/requirement definitions in spec items
- Acceptance criteria for testable outcomes
- Implementation context in task notes
