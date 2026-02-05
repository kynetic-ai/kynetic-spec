# Kynetic Spec - Agent Guide

This document provides context for AI agents working on this project.

## What This Project Is

Kynetic Spec (`kspec`) is a **self-hosting specification and task management system**. It's a structured format for defining project specifications that can be programmatically manipulated, and it tracks its own development using itself.

**Key insight**: This is not just a spec format - it's a living system where the spec IS the source of truth for what to build, and the task system tracks progress on building it.

## The Bootstrap

This project was bootstrapped using itself. The initial implementation was created by:

1. Writing a design document (now archived at `docs/history/KYNETIC_SPEC_DESIGN.md`)
2. Running parallel subagents in git worktrees:
   - One agent wrote the spec defining kspec
   - One agent wrote the parser/CLI (`src/` directory)
3. Merging and aligning the outputs
4. Using `kspec tasks ready` to track further development

The spec files in `.kspec/` define what kspec should do. The TypeScript code in `src/` implements it. They reference each other.

## Project Structure

```
kynetic-spec/
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
| Running kspec from .kspec/ | Run from project root: `cd ..` |
| kspec commands seem broken | First check `pwd` - ensure you're at project root, not inside .kspec/ |

### Important: Always Run from Project Root

kspec commands must be run from the project root, not from inside `.kspec/`:

```bash
# Correct
kspec task list

# Incorrect - will error
cd .kspec && kspec task list
```

**Common agent pitfall:** Agents sometimes forget they changed their working directory during a session (e.g., to inspect files in `.kspec/`). Before running kspec commands:

1. Check your current directory: `pwd`
2. If you're inside `.kspec/`, return to project root: `cd ..`
3. Then run the kspec command

If you see the error "Cannot run kspec from inside .kspec/ directory", this is the cause.

### Integration with Main Branch

- Main branch `.gitignore` includes `.kspec/`
- Spec changes tracked in shadow, code changes in main
- Both branches can be worked on independently
- Commit trailers (Task: @ref, Spec: @ref) link commits across branches
- `kspec log @ref` shows commits from both branches

### For New Contributors

**Recommended: Use the bootstrap script**

The bootstrap script handles all setup automatically and reports what it did:

```bash
# Clone repo
git clone <repo-url>
cd kynetic-spec

# Bootstrap (detects state, runs only needed steps, shows session context)
node scripts/bootstrap.cjs
```

The bootstrap script:
1. Checks if kspec is already configured (skips unnecessary steps)
2. Runs `npm install` if dependencies missing
3. Runs `npm run build` if not built
4. Runs `npm link` if CLI not available
5. Runs `kspec init --no-prompt` if shadow branch not set up
6. Outputs session context at the end
7. Reports exactly what actions it took (transparency for agents)

**Manual setup (alternative)**

```bash
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
pending → in_progress → pending_review → completed
              ↓              ↓
          blocked ←──────────┘
              ↓
          cancelled
```

**State transitions:**
- `kspec task start` → `in_progress`
- `kspec task submit` → `pending_review` (code done, awaiting merge)
- `kspec task complete` → `completed` (from in_progress, pending, or pending_review)
- `kspec task complete --force` → `completed` (force from any state, for cleanup or stuck tasks)
- `kspec task block` → `blocked`
- `kspec task unblock` → `pending`
- `kspec task cancel` → `cancelled`

`blocked` is auto-computed when `depends_on` tasks aren't completed.

### Task Blocking in Loop Mode

When running in automated loop mode (ralph), understanding when to block vs continue is critical.

**Key principle:** One blocked task is NOT "no more work." You MUST run `kspec tasks ready --eligible` and act on its output — it is authoritative.

**The pattern:**
1. **Attempt the work** - actually try to solve the problem first
2. **Hit a genuine blocker** - external dependency, needs human decision, spec gap
3. **Block the task** - with documented reason and what you tried
4. **MUST run `kspec tasks ready --eligible`** - command output is authoritative
5. **If tasks remain: work on the next one.** If empty: stop responding — ralph exits automatically.

**Trust the YAML state.** Only formal dependencies (`depends_on` field) constitute task-level blocking. If `depends_on` is empty, the task has no dependencies. If `kspec tasks ready --eligible` lists a task, it IS ready. Do not invent blocking relationships based on perceived connections between tasks, PRs in CI, or other inferred state.

**Valid blocking reasons** (external blockers):
- Requires human architectural decision
- Needs spec clarification
- Depends on external API/service not available
- Formally blocked by another task (listed in `depends_on`)

**Invalid blocking reasons** (do the work):
- Task seems complex
- Tests are failing (fix them)
- Service needs running (start it)
- Might take multiple iterations
- Another task's PR is in CI (not a formal dependency)

```bash
# When you hit a genuine blocker after attempting work
kspec task note @task "Attempted: X, Y, Z. Blocked because: [external reason]"
kspec task block @task --reason "Requires architectural decision on X"
kspec task set @task --automation needs_review

# MUST check for other work — command output is authoritative
kspec tasks ready --eligible
# If tasks exist: pick one and continue
# If empty: stop responding — ralph exits the loop automatically
```

### Ralph Loop Model

Ralph operates in a prompt-response loop:

```
for each iteration (1..maxLoops):
  1. Ralph checks for eligible tasks — if none remain, exits loop
  2. Ralph sends task-work prompt
  3. Agent works on tasks, may create PR(s)
  4. Agent stops responding (turn complete)
  5. Ralph sends reflection prompt
  6. Agent captures learnings, stops responding
  7. Ralph processes pending_review tasks via subagent
  8. Continue to next iteration (back to step 1)
```

**Key insight:** When you stop responding, ralph continues automatically.
The loop ends when (in order of how common):
- **Ralph's automatic check finds no eligible tasks** (primary mechanism — handles most cases)
- Max iterations reached
- Max consecutive failures reached
- Agent calls `kspec ralph end-loop` (rare escape hatch — only for stalled work across iterations)

**Do NOT call `end-loop` after creating a PR.** Simply stop responding.
Ralph will check for remaining work and either continue or exit on its own.

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

**Always run bootstrap first** to ensure kspec is ready:

```bash
node scripts/bootstrap.cjs
```

This handles setup if needed and shows session context. If kspec is already configured, it skips setup and just shows the session.

Alternatively, if you know kspec is already set up:

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

# Resolve when addressed (single or batch)
kspec meta resolve @observation-ref "How it was resolved"
kspec meta resolve @ref1 @ref2 @ref3 "Resolved in batch"

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

# Resolve observations (single or batch)
kspec meta resolve @obs-ref "Resolution notes"
kspec meta resolve @ref1 @ref2 "Batch resolution"

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

**Use the `@pr-review-merge` workflow for all PR merges:**

```bash
kspec workflow start @pr-review-merge
```

This workflow enforces quality gates:
1. All CI checks complete and passing
2. All review comments addressed (automated AND human)
3. All @claude requests completed
4. All review threads resolved
5. Explicit merge decision

**Do not merge while CI is running or failing.** Only skip gates if user explicitly approves.

### Automated Review Resolution Check

The `pr-review-resolution-check.yml` CI workflow blocks merging if unresolved review threads exist. To resolve: click "Resolve conversation" on each thread in GitHub UI after addressing feedback.

### PR Agent Limitations

The automated `@claude` PR agent:
- Reviews code automatically on PR creation
- Responds to `@claude` mentions
- Has **limited capabilities** (can't run kspec, npm, etc.)

When the PR agent can't complete a request, **you must complete it yourself** before merging.

### Pre-PR Local Review

Before creating a PR, use `/local-review` for quality checks:

```bash
kspec workflow start @local-review
```

This checks AC coverage, test quality, E2E preference, and test isolation. See the `/local-review` skill for details.

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

## Running Services

### Daemon

The daemon provides the API for the web UI. Start it for E2E tests or local development:

```bash
# Start daemon (foreground)
npm run daemon

# Start daemon in background with logs
npm run daemon > /tmp/daemon.log 2>&1 &
DAEMON_PID=$!

# Wait for ready
for i in {1..30}; do
  curl -s http://localhost:3000/health > /dev/null 2>&1 && break
  sleep 1
done

# Clean up when done
kill $DAEMON_PID 2>/dev/null
```

Default port is 3000. Health endpoint: `GET /health`

### E2E Tests

E2E tests **manage their own daemon instance** - do not start one manually.

```bash
# Just run E2E tests - daemon starts/stops automatically
npm run test:e2e -w packages/web-ui

# Or run specific test file
npm run test:e2e -w packages/web-ui -- tests/e2e/tasks.spec.ts
```

**How it works:** The `test-base.ts` fixture handles everything:
- Creates isolated temp directory with fixtures
- Starts daemon on port 3456 (not 3000) with `--kspec-dir <temp>`
- Cleans up daemon and temp dir after tests

**Writing new E2E tests:** Import from `test-base.ts`:
```typescript
import { test, expect } from '../fixtures/test-base';

test('my test', async ({ daemon, page }) => {
  // daemon.tempDir - isolated project directory
  // daemon.kspecDir - the .kspec directory
  await page.goto('http://localhost:3456');
});
```

**Do NOT** start a global daemon for E2E tests - each test run needs isolation.

**E2E Fixture Isolation Pattern:**

E2E tests use dedicated fixtures at `packages/web-ui/tests/fixtures/` to avoid breaking unit tests. This separation is critical:

```
packages/web-ui/tests/
├── fixtures/              # E2E test fixtures ONLY
│   ├── test-base.ts      # Playwright fixture (daemon lifecycle)
│   ├── kynetic.yaml      # Sample kspec project
│   ├── project.tasks.yaml
│   ├── project.inbox.yaml
│   ├── kynetic.meta.yaml
│   └── project-tests/    # Mock test files for AC coverage scanning
└── e2e/                   # E2E test specs
    └── *.spec.ts
```

Why separate fixtures:
- **Unit test fixtures** (`tests/fixtures/`) use `setupTempFixtures()` with specific YAML structures for testing validators, parsers, etc.
- **E2E fixtures** (`packages/web-ui/tests/fixtures/`) simulate a real kspec project with realistic data for UI testing
- Mixing them causes schema validation failures (unit tests expect minimal structures, E2E expects complete projects)

When `test-base.ts` runs:
1. Creates temp directory at `/tmp/kspec-e2e-<timestamp>`
2. Copies E2E fixtures to `<temp>/.kspec/` (simulating shadow worktree)
3. Initializes git repo (required for kspec detection)
4. Creates fake shadow worktree `.git` file (so kspec finds spec directory)
5. Starts daemon pointing at temp directory
6. Tests run against isolated project
7. Cleanup removes temp directory and stops daemon

**Important:** Never add E2E fixtures to the main `tests/fixtures/` directory. Keep them in `packages/web-ui/tests/fixtures/`.

### Web UI Development

```bash
# Start daemon + web UI together
npm run dev -w packages/web-ui

# Or separately:
npm run daemon &
npm run dev:ui -w packages/web-ui
```

## Daemon Test Architecture

Daemon testing uses three distinct approaches:

### 1. Static Analysis Tests (vitest)

Verify code structure without running actual daemons:
- `daemon-server.test.ts` - Server setup, middleware, port configuration
- `daemon-api-*.test.ts` - API route structure and validation
- `daemon-websocket.test.ts` - WebSocket protocol definitions

These tests read source files and verify expected patterns exist. Fast, no runtime requirements.

### 2. Unit Tests with Isolation (vitest)

Test components in isolation using temp directories:
- `daemon-pid.test.ts` - PID file management
- `daemon-context-manager.test.ts` - Multi-project registration and caching
- `daemon-pubsub.test.ts` - WebSocket broadcast filtering (with mocks)

Uses `createTempDir()` and `setupMultiDirFixtures()` for isolation.

### 3. E2E Tests (Playwright)

Full integration via browser - see [Running Services > E2E Tests](#e2e-tests) above.

**Why no live daemon integration tests in vitest?**

E2E tests via Playwright provide sufficient integration coverage. Adding live daemon tests to vitest would:
- Require Bun runtime in CI
- Add complexity without testing different code paths
- Duplicate what Playwright already covers

### Multi-Project Test Fixtures

Tests needing multiple projects use `setupMultiDirFixtures()`:

```typescript
const fixturesRoot = await setupMultiDirFixtures();
const projectA = join(fixturesRoot, 'project-a');  // Valid project
const projectB = join(fixturesRoot, 'project-b');  // Valid project
const invalid = join(fixturesRoot, 'project-invalid');  // No .kspec/
```

## CI Limitations

### File Watcher Tests Skip in CI

`daemon-watcher-multi-project.test.ts` skips in GitHub Actions:

```typescript
const describeOrSkip = process.env.CI ? describe.skip : describe;
describeOrSkip('Per-Project File Watchers', () => { ... });
```

**Reason:** GitHub Actions containers don't support recursive `fs.watch`. Chokidar fallback doesn't emit events reliably.

**Impact:** Run file watcher tests locally before committing watcher changes.

### E2E Port Hardcoding

E2E tests use hardcoded port 3456. Tests cannot run in parallel on the same machine.

**Mitigation:** `test-base.ts` kills any existing daemon on port 3456 before each test run.

### GitHub Pages Deployment Quirks

Two common issues when working with the GitHub Pages deployment:

1. **SvelteKit BASE_PATH requirement**: When deploying to a GitHub Pages subdirectory (e.g., `username.github.io/repo-name/`), the `BASE_PATH` environment variable must be set during build. The CI workflow handles this automatically, but local static builds need it too:
   ```bash
   BASE_PATH=/kynetic-spec npm run build -w packages/web-ui
   ```

2. **Workflow file location**: GitHub Actions workflows only trigger when the workflow file exists on the branch being pushed. For `kspec-meta` branch pushes, the workflow must either:
   - Exist on `kspec-meta` itself, OR
   - Use `workflow_dispatch` for manual triggering from any branch

The current setup uses separate workflows: `gh-pages.yml` (manual dispatch) and `gh-pages-ui.yml` (auto on main push).

## Test Fixture Patterns

When writing tests, follow these patterns to avoid common friction points.

### ULID Format Requirements

ULIDs use **Crockford base32** which excludes: `I`, `L`, `O`, `U`

Valid characters: `0-9`, `A-H`, `J-K`, `M-N`, `P-T`, `V-Z`

**Common mistakes that cause silent failures:**
```
❌ 01TRAIT10...  (contains I)
❌ 01TASK100...  (contains I - the second character after TASK)
❌ 01MODULE0...  (contains O and U)
✅ 01TRATT100... (valid - no I, L, O, U)
✅ 01TASK0000... (valid - T, A, S, K are all allowed)
```

**Why this matters:** Invalid ULIDs fail schema validation silently. Tests pass locally because the fixture doesn't load, making it appear the feature works when it doesn't. This has caused multiple debugging sessions where "the code works manually but tests fail."

**Solution - use `testUlid()` helper:**
```typescript
import { testUlid, testUlids } from './helpers/cli';

// Generate valid ULID with readable prefix
const taskId = testUlid('TASK');     // '01TASK00000000000000000000'
const traitId = testUlid('TRAIT');   // '01TRAJT0000000000000000000' (I auto-replaced)

// Generate multiple unique ULIDs
const [id1, id2, id3] = testUlids('TASK', 3);
```

### YAML Fixture Creation

**Don't use `JSON.stringify()` for YAML** - it produces invalid syntax that breaks parsing.

```typescript
// ❌ Wrong - produces invalid YAML
await fs.writeFile('kynetic.yaml', JSON.stringify({ kynetic: '1.0' }));

// ✅ Correct options:

// 1. Use pre-built fixtures (preferred)
const tempDir = await setupTempFixtures();

// 2. Write YAML strings directly
await fs.writeFile('kynetic.yaml', `
kynetic: "1.0"
project: Test Project
`);

// 3. Use yaml library for complex structures
import { stringify } from 'yaml';
await fs.writeFile('kynetic.yaml', stringify({ kynetic: '1.0' }));
```

**Why this matters:** JSON.stringify produces `{"kynetic":"1.0"}` which is technically valid YAML but behaves differently than expected multi-line YAML. Nested structures often break entirely.

### Test Helper Reference

| Helper | Purpose |
|--------|---------|
| `setupTempFixtures()` | Copy pre-built fixtures to temp dir (preferred) |
| `createTempDir()` | Create empty temp dir |
| `cleanupTempDir(dir)` | Remove temp dir |
| `initGitRepo(dir)` | Initialize git with test user config |
| `testUlid(prefix?, seq?)` | Generate valid test ULID |
| `testUlids(prefix, count)` | Generate multiple unique ULIDs |
| `kspec(args, cwd)` | Run CLI command, return result object |
| `kspecJson<T>(args, cwd)` | Run CLI with --json, return parsed |

See `tests/helpers/cli.ts` for full documentation.

### Generating ULIDs for YAML Fixtures

When manually creating YAML fixture files, use the `kspec util ulid` command:

```bash
# Generate a single valid ULID
kspec util ulid

# Generate multiple ULIDs
kspec util ulid --count 5
```

### E2E Tests (Playwright)

E2E tests live in `packages/web-ui/tests/e2e/` and use Playwright, not vitest.

**Important:** Playwright tests must be excluded from vitest. This is configured in `vitest.config.ts`:

```typescript
exclude: [
  '**/node_modules/**',
  '**/dist/**',
  '**/packages/web-ui/tests/e2e/**',  // Playwright uses different API
],
```

Run E2E tests separately: `npm run test:e2e -w packages/web-ui`

## Session Reflection

After significant work, use `/reflect` to identify learnings, friction points, and improvements.

**For structured reflection workflow, run `/reflect`.**

## The Self-Hosting Loop

The goal is for kspec to be fully self-describing:

1. `kspec session start` - get context, check for existing work
2. **Inherit existing work** - pending_review or in_progress tasks take priority
3. `kspec task start @task` - mark in_progress (or continue existing)
4. Implement it, add notes as you go
5. `kspec task submit @task` - mark pending_review when code done
6. `/pr` - create pull request
7. `@pr-review-merge` workflow - review and merge PR
8. `kspec task complete @task` - only after PR merged
9. New tasks unblock, repeat

**For the full task lifecycle, use `/task-work`.**

When working on this project, you ARE using kspec to build kspec. Track your work in the task system.

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/audit` | Comprehensive codebase audit for release readiness |
| `/create-workflow` | Create new workflows with consistent structure and matching skills |
| `/kspec` | Task and spec management workflows |
| `/local-review` | Pre-PR quality review - AC coverage, test quality, isolation (`@local-review` workflow) |
| `/meta` | Session context (focus, threads, questions, observations) |
| `/pr` | Create pull requests, then use `@pr-review-merge` workflow for merge |
| `/pr-review` | Review and merge a PR with quality gates. Verifies AC coverage and spec alignment before merge. Used in subagent context. |
| `/reflect` | Session reflection and learning capture |
| `/release` | Create versioned releases with git tags and GitHub releases |
| `/spec` | Spec authoring guide - item types, acceptance criteria, traits |
| `/spec-plan` | Translate approved plans to specs |
| `/task-work` | Full task lifecycle - inherit, verify, start, note, submit, PR, complete (`@task-work-session` workflow) |
| `/triage` | Systematic inbox and observation processing |

## Design Decisions

Key decisions are documented in `docs/history/KYNETIC_SPEC_DESIGN.md` under "Resolved Decisions". Important ones:

- **Format**: YAML with Zod validation
- **Schema source**: Zod (TypeScript-native)
- **Architecture**: Library-first, CLI is a consumer
- **Task-spec relationship**: Tasks reference specs, don't duplicate
- **Notes**: Append-only with supersession
- **Todos**: Lightweight, can promote to full tasks

## Related Files

- `README.md` - User-facing documentation
- `docs/history/KYNETIC_SPEC_DESIGN.md` - Archived design specification (historical)
