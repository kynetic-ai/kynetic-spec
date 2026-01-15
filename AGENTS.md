# Kynetic Spec - Agent Guide

This document provides context for AI agents working on this project.

## What This Project Is

Kynetic Spec (`kspec`) is a **self-hosting specification and task management system**. It's a structured format for defining project specifications that can be programmatically manipulated, and it tracks its own development using itself.

**Key insight**: This is not just a spec format - it's a living system where the spec IS the source of truth for what to build, and the task system tracks progress on building it.

## The Bootstrap

This project was bootstrapped using itself. The initial implementation was created by:

1. Writing a design document (`KYNETIC_SPEC_DESIGN.md`)
2. Running parallel subagents in git worktrees:
   - One agent wrote the spec defining kspec (`spec/` directory)
   - One agent wrote the parser/CLI (`src/` directory)
3. Merging and aligning the outputs
4. Using `kspec tasks ready` to track further development

The spec files in `spec/` define what kspec should do. The TypeScript code in `src/` implements it. They reference each other.

## Project Structure

```
kynetic-spec/
├── KYNETIC_SPEC_DESIGN.md    # Comprehensive design document (read this first)
├── spec/                      # kspec's own spec (YAML)
│   ├── kynetic.yaml          # Root manifest
│   ├── kynetic.tasks.yaml    # Tasks for implementation
│   └── modules/              # Spec items by domain
│       ├── core.yaml         # Core primitives (ULIDs, slugs, refs)
│       ├── schema.yaml       # Item types, validation
│       ├── tasks.yaml        # Task system
│       └── cli.yaml          # CLI commands
├── src/                       # TypeScript implementation
│   ├── schema/               # Zod schemas
│   ├── parser/               # YAML loading
│   └── cli/                  # Command handlers
└── tests/                     # Vitest tests
```

## Key Concepts

### IDs: ULIDs + Slugs

Every item has:
- **ULID**: Canonical unique ID (e.g., `01JHNKAB01TASK100000000000`)
- **Slugs**: Human-friendly aliases (e.g., `task-project-setup`)

References use `@` prefix: `@task-project-setup` or `@01JHNKAB`

### Spec Items vs Tasks

- **Spec items** (`spec/modules/*.yaml`): Define WHAT to build - features, requirements, constraints
- **Tasks** (`spec/kynetic.tasks.yaml`): Track the WORK of building - status, notes, dependencies

Tasks reference spec items via `spec_ref` field. They don't duplicate spec content.

### Task States

```
pending → in_progress → completed
                ↓
            blocked → (unblock) → in_progress
                ↓
            cancelled
```

`blocked` is auto-computed when `depends_on` tasks aren't completed.

### Notes (Work Log)

Tasks have append-only notes that track progress:
```yaml
notes:
  - _ulid: 01KEYRJ953HRYWJ0W4XEG6J9FB
    created_at: "2026-01-14T17:00:00Z"
    author: "@claude"
    content: |
      What was done and why...
```

Always add notes when completing significant work. This creates an audit trail.

## Working on This Project

### Starting a Session

Always begin by getting session context:

```bash
npx tsx src/cli/index.ts session start
```

This shows:
- **Active work**: Tasks currently in progress
- **Recently completed**: What was just finished
- **Ready tasks**: What can be picked up next
- **Inbox items**: Ideas awaiting triage (oldest first)
- **Recent commits**: Git activity
- **Working tree**: Uncommitted changes

Options: `--full` for more detail, `--since 1d` to filter by time, `--json` for machine output.

### Start Working on a Task

```bash
npx tsx src/cli/index.ts task start @task-slug
npx tsx src/cli/index.ts task note @task-slug "Starting work on X..."
```

### Complete a Task

```bash
npx tsx src/cli/index.ts task note @task-slug "Completed X, approach was Y..."
npx tsx src/cli/index.ts task complete @task-slug --reason "Brief summary"
```

### View Task Details

```bash
npx tsx src/cli/index.ts task get @task-slug
npx tsx src/cli/index.ts task notes @task-slug
```

### Create a New Task

```bash
npx tsx src/cli/index.ts task add \
  --title "Task title" \
  --spec-ref "@spec-item" \
  --priority 2 \
  --slug my-task-slug \
  --tag mvp --tag feature
```

ULIDs are generated automatically. Use `--spec-ref` to link to a spec item.

### Validate the Spec

```bash
npx tsx src/cli/index.ts validate           # Full validation
npx tsx src/cli/index.ts validate --refs    # Check references only
npx tsx src/cli/index.ts validate --schema  # Check schema only
```

## Spec-First Development

The spec defines what to build. Tasks track the work. When these drift apart, problems compound.

**Core principle**: If you're changing behavior and the spec doesn't cover it, update the spec first.

### When This Flow Applies

Any change that affects behavior:
- Adding new functionality
- Modifying existing behavior
- Fixing bugs that reveal spec gaps
- Removing or deprecating features

This flow bridges spec-reality gaps **in the moment** rather than after the fact.

### Step 1: Check the Spec

Before implementing, ask: **Does the spec cover this?**

```bash
kspec item get @relevant-item    # Check existing spec
kspec item list --tag feature    # Browse related items
```

- **Spec exists and matches** → Derive task, proceed
- **Spec exists but outdated** → Update spec first
- **No spec exists** → Create spec first (if behavior change) or task directly (if infra)

### Step 2: Reflect and Clarify

When spec work is needed, use `AskUserQuestion` to align with the user:

- Present your interpretation of the change
- State where it fits in the spec hierarchy
- Note any assumptions about scope/behavior
- Offer options:
  - **Dive deeper**: Answer questions to define precisely
  - **Fill gaps**: Agent uses existing patterns to complete spec
  - **Just task**: Skip spec for now (appropriate for infra, spikes, unclear scope)

### Step 3: Update or Create Spec

```bash
# Update existing item
kspec item set @existing-item --description "Updated behavior..."

# Or create new item under appropriate parent
kspec item add --under @parent --title "New capability" --type requirement
```

**Consider granularity**: Large changes should be multiple spec items, not one monolithic entry.

### Step 4: Derive Task

Check before deriving:

1. **Existing coverage**: Does a task already implement this spec?
2. **Task size**: Should the spec be broken down further?

```bash
kspec derive @spec-item
```

The task inherits context from the spec via `spec_ref`.

### Handling Different Request Types

| Situation | Flow |
|-----------|------|
| Clear behavior change | Check spec → Update/create spec → Derive task |
| Vague idea, unclear scope | Capture in inbox → Triage later → Promote when ready |
| Infra/internal (no user impact) | Create task directly, no spec needed |
| Bug revealing spec gap | Fix bug → Update spec to match reality |

### Inbox (for unclear scope or quick capture)

The inbox is a low-friction capture space for ideas that aren't tasks yet. Use it liberally - the cost of capture is near zero, and good ideas often emerge from rough notes.

#### When to Use Inbox

**Use inbox when:**
- You have a vague idea but no clear scope
- Something comes up mid-task that you don't want to forget
- The user mentions something that might be worth doing later
- You notice a potential improvement but it's not the current focus
- You're unsure if it's worth doing at all

**Skip inbox and create a task directly when:**
- The scope is clear and actionable
- It's blocking current work
- The user explicitly asked for it to be done
- It's infrastructure/cleanup with obvious next steps

#### Commands

```bash
# Quick capture - just dump the thought
kspec inbox add "maybe we need better error messages"
kspec inbox add "refactor auth flow" --tag auth --tag refactor

# List items (oldest first to encourage triage)
kspec inbox list

# Get full details on an item
kspec inbox get @01KF0...

# Promote to task when ready
kspec inbox promote @01KF0... --title "Improve error messages" --priority 2

# Delete if no longer relevant
kspec inbox delete @01KF0...
```

#### Triage Workflow

Session context shows inbox items oldest-first deliberately - older items deserve attention. During triage, for each item ask:

1. **Is this still relevant?** → If not, delete it
2. **Is the scope clear now?** → If yes, promote to task
3. **Does it need spec work first?** → Create/update spec, then derive task
4. **Still unclear?** → Leave it, add a tag, revisit later

Promote with full context when you can:
```bash
# Good: provides enough for the task to be actionable
kspec inbox promote @01KF0... \
  --title "Add retry logic to API client" \
  --priority 2 \
  --spec-ref @api-client \
  --tag reliability

# The original inbox text becomes the task description
```

#### Philosophy

The inbox exists because **not every idea deserves immediate structure**. Creating a task has overhead - title, priority, maybe spec work. The inbox lets you capture without that friction.

But inbox items shouldn't live forever. Regular triage (during session start, between tasks, end of session) keeps the inbox useful. An inbox with 50 stale items is just noise.

**Rule of thumb**: If an inbox item survives 3+ triage sessions without action, either promote it with a clear scope or delete it - it's probably not important enough.

### Default: Always Confirm

Ask before creating or modifying spec items. Present what would change and get confirmation. Future project onboarding may configure more autonomous behavior.

### Why This Matters

- Spec stays accurate as source of truth
- Tasks trace back to defined behavior
- Future agents/sessions understand what was built and why
- Drift is caught immediately, not discovered later

## Staying Aligned During Work

Work rarely follows a straight line. User questions lead to follow-ups, implementations reveal gaps, and scope naturally expands. The key is recognizing these moments and keeping the system in sync.

### Recognizing Scope Expansion

**Watch for these patterns:**

- User asks a follow-up that requires touching different code
- "While I'm here, I should also..." thoughts
- Modifying a file that wasn't part of the original task
- Adding functionality the spec doesn't mention

**Example - What went wrong:**
```
Task: Implement session checkpoint command
  → Completed checkpoint, committed
  → User: "Does setup command install this hook?"
  → Modified setup.ts to add hook installation
  → Committed without checking if setup had spec coverage
  → Result: Undocumented feature, spec gap
```

**Example - Better approach:**
```
Task: Implement session checkpoint command
  → Completed checkpoint, committed
  → User: "Does setup command install this hook?"
  → Before coding: "Let me check if setup has spec coverage"
  → kspec item list | grep setup → No results
  → "This is new scope. I'll note it on the checkpoint task
     and capture a spec gap in inbox before proceeding"
  → Add note, capture inbox item, then implement
```

### Before Modifying Code Outside Your Task

Quick mental checklist:
1. **Is this file part of my current task?** If not, you're expanding scope
2. **Does this command/feature have spec coverage?** `kspec item list | grep <name>`
3. **Should I note this expansion?** Almost always yes

This takes seconds and prevents drift from compounding.

### When You Realize You Missed Something

It happens. When you notice after the fact:
1. Add a note to the relevant task explaining what was added
2. Check for spec gaps and capture them (inbox or new spec item)
3. Commit the documentation update

The goal isn't perfection - it's maintaining enough context that future sessions can understand what happened.

### Why This Matters More Than It Seems

Each undocumented change is small. But they accumulate:
- Specs drift from reality
- Tasks don't reflect actual work done
- Future agents lack context for decisions
- The self-hosting loop breaks down

Taking 30 seconds to note scope expansion saves hours of archaeology later.

## Design Decisions

Key decisions are documented in `KYNETIC_SPEC_DESIGN.md` under "Resolved Decisions". Important ones:

- **Format**: YAML with Zod validation
- **Schema source**: Zod (TypeScript-native)
- **Architecture**: Library-first, CLI is a consumer
- **Task-spec relationship**: Tasks reference specs, don't duplicate
- **Notes**: Append-only with supersession
- **Todos**: Lightweight, can promote to full tasks

## The Self-Hosting Loop

The goal is for kspec to be fully self-describing:

1. `kspec session start` to get context
2. Pick a task from ready list
3. `kspec task start @task` to begin
4. Implement it, add notes as you go
5. `kspec task complete @task` when done
6. New tasks unblock, repeat

When working on this project, you ARE using kspec to build kspec. Track your work in the task system.

## Related Files

- `KYNETIC_SPEC_DESIGN.md` - Full design specification
- `FORMAT_COMPARISON.md` - Why YAML was chosen
- `RESEARCH_NOTES.md` - Research that informed design
- `README.md` - User-facing documentation
