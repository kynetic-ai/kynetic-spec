# Kynetic Spec - Agent Guide

This document provides context for AI agents working on this project.

## What This Project Is

Kynetic Spec (`kspec`) is a **self-hosting specification and task management system**. It's a structured format for defining project specifications that can be programmatically manipulated, and it tracks its own development using itself.

**Key insight**: This is not just a spec format - it's a living system where the spec IS the source of truth for what to build, and the task system tracks progress on building it.

## The Bootstrap

This project was bootstrapped using itself. The initial implementation was created by:

1. Writing a design document (`KYNETIC_SPEC_DESIGN.md`)
2. Running parallel subagents in git worktrees:
   - One agent wrote the spec defining kspec
   - One agent wrote the parser/CLI (`src/` directory)
3. Merging and aligning the outputs
4. Using `kspec tasks ready` to track further development

The spec files in `.kspec/` define what kspec should do. The TypeScript code in `src/` implements it. They reference each other.

## Project Structure

```
kynetic-spec/
├── KYNETIC_SPEC_DESIGN.md    # Comprehensive design document (read this first)
├── .kspec/                    # kspec's own spec (shadow branch worktree)
│   ├── kynetic.yaml          # Root manifest
│   ├── kynetic.tasks.yaml    # Bootstrap tasks
│   ├── project.tasks.yaml    # Active project tasks
│   ├── project.inbox.yaml    # Inbox items
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

- **Spec items** (`.kspec/modules/*.yaml`): Define WHAT to build - features, requirements, constraints
- **Tasks** (`.kspec/project.tasks.yaml`): Track the WORK of building - status, notes, dependencies

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

**For detailed CLI commands and workflows, run `/kspec`.**

### Starting a Session

Always begin by getting context:

```bash
kspec session start
```

This shows active work, recently completed tasks, ready tasks, inbox items, and git status.

### Task Workflow

1. **Start**: Mark task in_progress before working
2. **Note**: Add notes as you work (not just at end)
3. **Complete**: Mark done with summary

### Creating Work

- **Clear scope?** → Create task directly
- **Unclear scope?** → Add to inbox, triage later
- **Behavior change?** → Check/update spec first, then derive task

## Session Context

Track focus, threads, and questions to maintain continuity across sessions.

- **Focus**: What you're working on right now
- **Threads**: Parallel work streams to track
- **Questions**: Open questions about the work

**For managing session context, run `/meta`.**

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

### The Decision Flow

| Situation | Flow |
|-----------|------|
| Clear behavior change | Check spec → Update/create spec → Derive task |
| Vague idea, unclear scope | Capture in inbox → Triage later → Promote when ready |
| Infra/internal (no user impact) | Create task directly, no spec needed |
| Bug revealing spec gap | Fix bug → Update spec to match reality |

**For systematic triage, run `/triage`.**
**After plan approval, run `/spec-plan` to translate plan to specs.**

### Inbox (for unclear scope or quick capture)

The inbox is a low-friction capture space for ideas that aren't tasks yet. Use it liberally - the cost of capture is near zero, and good ideas often emerge from rough notes.

**Use inbox when:**
- You have a vague idea but no clear scope
- Something comes up mid-task that you don't want to forget
- The user mentions something that might be worth doing later
- You notice a potential improvement but it's not the current focus

**Skip inbox and create a task directly when:**
- The scope is clear and actionable
- It's blocking current work
- The user explicitly asked for it to be done

**Rule of thumb**: If an inbox item survives 3+ triage sessions without action, either promote it with a clear scope or delete it.

### Default: Always Confirm

Ask before creating or modifying spec items. Present what would change and get confirmation.

## Staying Aligned During Work

Work rarely follows a straight line. User questions lead to follow-ups, implementations reveal gaps, and scope naturally expands. The key is recognizing these moments and keeping the system in sync.

### Recognizing Scope Expansion

**Watch for these patterns:**

- User asks a follow-up that requires touching different code
- "While I'm here, I should also..." thoughts
- Modifying a file that wasn't part of the original task
- Adding functionality the spec doesn't mention

### Before Modifying Code Outside Your Task

Quick mental checklist:
1. **Is this file part of my current task?** If not, you're expanding scope
2. **Does this command/feature have spec coverage?**
3. **Should I note this expansion?** Almost always yes

This takes seconds and prevents drift from compounding.

### When You Realize You Missed Something

It happens. When you notice after the fact:
1. Add a note to the relevant task explaining what was added
2. Check for spec gaps and capture them (inbox or new spec item)
3. Commit the documentation update

The goal isn't perfection - it's maintaining enough context that future sessions can understand what happened.

## Commit Message Convention

When completing tasks, kspec outputs a suggested commit message with trailers:

```
feat: Feature description

Task: @task-slug
Spec: @spec-ref
```

**Why trailers matter:**
- Enable `kspec log @ref` to find commits by task or spec
- Create natural audit trail linking code to specs
- Standard git format (works with `git log --grep`)

## Code Annotations

Link code to acceptance criteria using this pattern:

```typescript
// AC: @spec-item ac-N
it('should validate input', () => {
  // Test implementation
});
```

**Where to use:**
- Test files: Mark which AC a test covers
- Implementation: Mark code implementing specific AC

This pattern is already used in this project's tests.

## Session Reflection

After significant work, use `/reflect` to identify learnings, friction points, and improvements.

**For structured reflection workflow, run `/reflect`.**

## The Self-Hosting Loop

The goal is for kspec to be fully self-describing:

1. `kspec session start` to get context
2. Pick a task from ready list
3. `kspec task start @task` to begin
4. Implement it, add notes as you go
5. `kspec task complete @task` when done
6. New tasks unblock, repeat

When working on this project, you ARE using kspec to build kspec. Track your work in the task system.

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/kspec` | Task and spec management workflows |
| `/meta` | Session context (focus, threads, questions, observations) |
| `/triage` | Systematic inbox and observation processing |
| `/spec-plan` | Translate approved plans to specs |
| `/reflect` | Session reflection and learning capture |
| `/pr` | Create pull requests from current work |

## Design Decisions

Key decisions are documented in `KYNETIC_SPEC_DESIGN.md` under "Resolved Decisions". Important ones:

- **Format**: YAML with Zod validation
- **Schema source**: Zod (TypeScript-native)
- **Architecture**: Library-first, CLI is a consumer
- **Task-spec relationship**: Tasks reference specs, don't duplicate
- **Notes**: Append-only with supersession
- **Todos**: Lightweight, can promote to full tasks

## Related Files

- `KYNETIC_SPEC_DESIGN.md` - Full design specification
- `FORMAT_COMPARISON.md` - Why YAML was chosen
- `RESEARCH_NOTES.md` - Research that informed design
- `README.md` - User-facing documentation
