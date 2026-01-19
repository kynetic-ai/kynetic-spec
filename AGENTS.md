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

## Shadow Branch Worktree Architecture

Kspec uses a **shadow branch worktree** architecture to separate spec/task state from code:

### What is a Shadow Branch?

- **Shadow branch** (`kspec-meta`): An orphan git branch that stores all kspec state files
- **Worktree** (`.kspec/` directory): A git worktree pointing to the shadow branch
- **Main branch**: Gitignores `.kspec/` and contains only code/docs
- **Auto-commit**: All kspec operations automatically commit changes to shadow branch

### Why This Architecture?

1. **Separation**: Spec/task files don't clutter main branch history
2. **Sync**: Each commit to shadow = atomic snapshot of project state
3. **Collaboration**: Shadow branch can be pushed/pulled independently from code
4. **Clean diffs**: Code PRs don't include spec changes and vice versa

### How It Works

```
.kspec/.git → file (not directory) pointing to worktree
  ↓
gitdir: .git/worktrees/-kspec
  ↓
Shadow branch (kspec-meta): orphan branch with spec/task files
```

When you run `kspec task start @ref`:
1. CLI modifies `.kspec/project.tasks.yaml`
2. Changes are automatically staged and committed to `kspec-meta` branch
3. Commit pushed to remote (if tracking configured)
4. Main branch working tree remains clean

### Setup Commands

```bash
# Initialize shadow branch (first time)
kspec init

# Check shadow status
kspec shadow status

# Repair broken worktree
kspec shadow repair

# Sync with remote shadow branch
kspec shadow sync
```

### Worktree Verification

```bash
# List all worktrees
git worktree list
# Should show:
# /path/to/kynetic-spec/.kspec  <commit> [kspec-meta]

# Check shadow branch exists
git branch --list kspec-meta
# Should show: + kspec-meta (+ = checked out in worktree)

# Verify .kspec/.git is a file (not directory)
file .kspec/.git
# Should show: .kspec/.git: ASCII text
```

### Remote Synchronization

Shadow branches can be pushed/pulled like regular branches:

```bash
# Push shadow branch to remote
git push origin kspec-meta

# Pull shadow branch changes (or use kspec shadow sync)
cd .kspec && git pull

# Track remote shadow branch (automatic during init if remote exists)
git branch --set-upstream-to=origin/kspec-meta kspec-meta
```

**Auto-sync behavior:**
- Every kspec command auto-commits to shadow branch
- Auto-pushes to remote if tracking configured (fire-and-forget)
- `kspec session start` pulls before operations to sync state
- Conflicts are rare but handled via `kspec shadow resolve`

### Troubleshooting

| Issue | Fix |
|-------|-----|
| `.kspec/` doesn't exist | Run `kspec init` |
| Worktree disconnected | Run `kspec shadow repair` |
| Shadow branch exists but no worktree | Run `kspec shadow repair` |
| Sync conflicts | Run `kspec shadow resolve` (manual resolution) |
| `.kspec/` not gitignored | `kspec init` adds it automatically |

### Integration with Main Branch

- Main branch `.gitignore` includes `.kspec/`
- Spec changes tracked in shadow, code changes in main
- Both branches can be worked on independently
- Commit trailers (Task: @ref, Spec: @ref) link commits across branches
- `kspec log @ref` shows commits from both branches

### For New Contributors

When cloning the repo:

```bash
# Clone repo
git clone <repo-url>
cd kynetic-spec

# Initialize shadow (fetches remote kspec-meta if exists)
npm install
npm run build
npm link
kspec init

# Verify setup
kspec shadow status  # Should show: healthy
kspec session start  # Should show current context
```

If remote has `kspec-meta` branch, `kspec init` automatically:
1. Fetches remote shadow branch
2. Creates `.kspec/` worktree tracking remote
3. Syncs state before first use

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

1. **Verify**: Before starting, check if work is already done:
   - Check git history for related commits: `git log --oneline --grep="feature-name"`
   - Read implementation code if it exists
   - If already implemented, mark task complete with "Already implemented" reason
2. **Start**: Mark task in_progress before working
3. **Note**: Add notes as you work (not just at end)
4. **Complete**: Mark done with summary

### Creating Work

- **Clear scope?** → Create task directly
- **Unclear scope?** → Add to inbox, triage later
- **Behavior change?** → Check/update spec first, then derive task

## Session Context

Track focus, threads, questions, and observations to maintain continuity across sessions.

- **Focus**: What you're working on right now
- **Threads**: Parallel work streams to track
- **Questions**: Open questions about the work
- **Observations**: Patterns, friction, and learnings captured during work

### Example Session Context Commands

```bash
# Set focus before starting work
kspec meta focus "Implementing @task-slug"

# Capture friction as you encounter it
kspec meta observe friction "Command X failed when Y condition..."

# Capture successes for future reference
kspec meta observe success "Using pattern Z made refactoring much cleaner"

# Track parallel work
kspec meta thread add "Background: investigating performance issue"

# Capture open questions
kspec meta question add "Should we support legacy format in v2?"
```

**For managing session context, run `/meta`.**

## Observations System

Observations capture patterns, learnings, friction, and questions that emerge **during work**. They're different from inbox items - observations document what you noticed, while inbox captures what you might do.

### Observation Types

- **friction**: Things that didn't work, gotchas, blockers, pain points
- **success**: Patterns that worked well, useful approaches worth replicating
- **question**: Clarifications needed, process decisions, open questions
- **idea**: Thoughts that emerge but aren't actionable yet

### When to Use Observations vs Inbox

**Observations** (`kspec meta observe`) - capture during work:
- "This command failed in X situation" (friction)
- "Using pattern Y made Z much easier" (success)
- "Should we handle edge case A?" (question)
- "Could explore approach B" (idea - not yet scoped)

**Inbox** (`kspec inbox add`) - capture for later:
- Feature ideas that might become specs/tasks
- Enhancement suggestions with potential scope
- Things you want to do but haven't defined

**Key distinction**: Observations are about learning and reflection. Inbox is about potential work.

### Observation Workflow

```bash
# Capture during work
kspec meta observe friction "Description of what went wrong..."
kspec meta observe success "Pattern that worked well..."

# Review later
kspec meta observations list

# Resolve when addressed
kspec meta resolve @observation-ref "How it was resolved"

# Promote to task if actionable
kspec meta promote @observation-ref --title "Task title"
```

### Triage Routing

When processing items:
- If tagged `[reflection, ...]` → observation
- If describes 'what worked' or 'what didn't work' → observation
- If describes a feature or improvement → inbox
- If has clear action → promote to task

## Meta Commands Reference

The meta system manages session context, observations, and meta-specifications (agents, workflows, conventions).

### Session Context Commands

```bash
# Show current context summary
kspec meta show

# Manage focus (what you're working on now)
kspec meta focus "Working on @task-slug"
kspec meta focus --clear

# Manage threads (parallel work streams)
kspec meta thread add "Background work on feature X"
kspec meta thread remove 1
kspec meta thread list

# Manage questions (open questions about work)
kspec meta question add "Should we support format Y?"
kspec meta question remove 1
kspec meta question list
```

### Observation Lifecycle

```bash
# Capture observations
kspec meta observe friction "Description..."
kspec meta observe success "Pattern that worked..."
kspec meta observe question "Open question..."
kspec meta observe idea "Thought to explore..."

# Review observations
kspec meta observations list
kspec meta observations list --type friction
kspec meta observations list --unresolved

# Resolve observations
kspec meta resolve @obs-ref "Resolution notes"

# Promote to task
kspec meta promote @obs-ref --title "Task title"
```

### Meta Items (Agents, Workflows, Conventions)

```bash
# Browse meta items
kspec meta agents
kspec meta workflows
kspec meta conventions

# CRUD operations
kspec meta add agent --id agent-name --role "Description"
kspec meta set @agent-ref --status active
kspec meta get @agent-ref
kspec meta delete @agent-ref
kspec meta list agents
```

### Context Integration

Meta context persists across sessions:
- Focus shows in `kspec session start` output
- Threads track parallel work
- Questions capture decisions to make
- Observations feed into reflection and learning

**For detailed workflows, run `/meta`.**

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

### Inbox vs Observations

Two capture mechanisms serve different purposes:

**Inbox** (for potential work):
- Feature ideas that might become specs/tasks
- Enhancement suggestions
- Things you want to do but haven't scoped
- User mentions something that might be worth doing later

**Observations** (for learnings and patterns):
- Friction encountered during work
- Patterns that worked well
- Open questions about approach
- Ideas that emerged but aren't actionable yet

**Use inbox when:**
- You have a vague idea but no clear scope
- Something comes up mid-task that you don't want to forget
- You notice a potential improvement but it's not the current focus

**Use observations when:**
- You encounter friction or blockers
- You discover a useful pattern
- You have questions about process or approach
- You notice something worth remembering for future work

**Skip both and create a task directly when:**
- The scope is clear and actionable
- It's blocking current work
- The user explicitly asked for it to be done

**Rule of thumb**:
- Inbox items that survive 3+ triage sessions without action should be promoted with clear scope or deleted
- Observations accumulate as learning - review periodically with `/reflect` to identify patterns

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

## PR Merge Requirements

**Before merging ANY PR, verify:**

1. **All CI checks pass** - Do not merge with failing checks
2. **All review comments addressed** - PRs have automated Claude review that posts comments identifying issues. These MUST be fixed before merge.
3. **User requests completed** - If the user asks for something via `@claude` in PR comments and the PR agent couldn't complete it (limited permissions), YOU must complete it before merging

### How PR Review Works

PRs have an automated `@claude` agent that:
- Runs automatically on PR creation to review code
- Responds to `@claude` mentions from users
- Has **limited capabilities** (may not be able to run kspec, npm, etc.)

When the PR agent can't complete a user request (e.g., "add an inbox item"), it will say so. **You must complete those actions before merging.**

### PR Review Workflow

1. **Create PR** with implementation
2. **Wait for CI** - Automated review runs and posts findings
3. **Read review comments** - Check for identified issues
4. **Fix ALL issues** - Don't merge with known problems
5. **Re-run CI** if you pushed fixes
6. **Check for user comments** - User may have asked @claude to do something
7. **Complete pending actions** - If PR agent couldn't do something, do it yourself
8. **Merge** only when CI green AND all comments/requests addressed

### What Review Comments Look Like

The automated review posts structured comments like:
```
## Code Review
Found N issues...

### Issue 1: file.ts line X
**Current:** [problematic code]
**Should be:** [correct code]
**Reason:** [explanation]
```

**Each identified issue must be fixed before merge.**

### If You Can't Fix an Issue

If an issue can't be fixed in the current PR:
1. Add a comment explaining why
2. Create a task or inbox item to track it
3. Get explicit user approval to merge with known issues

### Local Review Subagents

When spawning a subagent to review your work before creating a PR, instruct it to be **strict** about:

1. **AC Coverage** - Every acceptance criterion MUST have at least one test that validates it
   - Missing AC coverage is a **blocking issue**, not a suggestion
   - Use `// AC: @spec-item ac-N` annotations to link tests to criteria

2. **Test Quality** - All tests must properly validate their intended purpose
   - AC-specific tests validate acceptance criteria
   - Non-AC tests are fine if they test something important (edge cases, integrations, etc.)
   - Reject "fluff tests" - tests that don't meaningfully verify anything
   - A test that always passes or only tests implementation details is not valid
   - Tests should fail if the feature breaks

3. **Test Strategy** - Prioritize E2E over unit tests
   - **Prefer end-to-end tests** that validate actual user functionality
   - Test the CLI as a user would invoke it, not just internal functions
   - Unit tests are okay for complex logic, but E2E proves the feature works

4. **Test Isolation** - NEVER test kspec within the kspec repo
   - All tests MUST run in temp directories (system temp, `/tmp`, etc.)
   - Manual testing and validation MUST also use temp directories
   - This prevents nested worktree issues and data corruption
   - Test fixtures should create isolated test repos, not use the real `.kspec/`

5. **What to Check**
   - Read the linked spec and its acceptance criteria
   - Verify each AC has corresponding test(s)
   - Verify tests would catch regressions
   - Verify tests run in temp directories, not kspec repo
   - Flag any ACs without proper coverage as MUST-FIX

Example prompt for review subagent:
```
Review this implementation against the spec @spec-ref. Be strict:
- Every AC must have test coverage with // AC: annotation
- Missing tests are blocking issues, not suggestions
- Prioritize E2E tests over unit tests
- Verify tests run in temp dirs, not kspec repo
- Reject fluff tests that don't validate real behavior
- List any issues as MUST-FIX
```

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

**Test coverage requirements:**
- Every acceptance criterion SHOULD have at least one test that validates it
- Use AC annotations in tests to create traceability
- When completing tasks, verify all linked spec ACs are covered by tests
- Validation warns about specs with ACs but no test coverage

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
| `/audit` | Comprehensive codebase audit for release readiness |
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
