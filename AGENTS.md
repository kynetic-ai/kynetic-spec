# Kynetic Spec - Agent Guide

## What This Project Is

Kynetic Spec (`kspec`) is a **self-hosting specification and task management system**. The spec files in `.kspec/` define what kspec should do. The TypeScript code in `src/` implements it. They reference each other.

**Key insight**: The spec IS the source of truth for what to build, and the task system tracks progress on building it. When working on this project, you ARE using kspec to build kspec.

## Finding Information

AGENTS.md provides **project architecture, gotchas, and decision frameworks**. For detailed workflows and command syntax, use skills and CLI help:

| Need | Where to look |
|------|---------------|
| CLI command syntax | `kspec help <command>` or invoke `/kspec` skill |
| Task lifecycle (start → submit → PR → complete) | `/task-work` skill |
| Creating PRs | `/pr` skill, then `/pr-review` for merge gates |
| Spec authoring (items, ACs, traits) | `/spec` skill |
| Plan-to-spec translation | `/spec-plan` skill |
| Session context (focus, threads, observations) | `/meta` skill |
| Inbox/observation processing | `/triage` skill |
| Pre-PR quality checks | `/local-review` skill |
| Session reflection | `/reflect` skill |
| E2E testing patterns | `/e2e` skill |
| Svelte 5 patterns | `/svelte-5` skill |
| Comprehensive audit | `/audit` skill |
| Creating workflows | `/create-workflow` skill |
| Versioned releases | `/release` skill |

Skills inject their full documentation when invoked — you don't need to memorize their contents.

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

## Project Structure

```
kynetic-spec/
├── .kspec/                    # Spec/task state (shadow branch worktree)
│   ├── kynetic.yaml          # Root manifest
│   ├── project.tasks.yaml    # Active project tasks
│   ├── project.inbox.yaml    # Inbox items
│   └── modules/              # Spec items by domain
├── src/                       # TypeScript implementation
│   ├── schema/               # Zod schemas
│   ├── parser/               # YAML loading
│   └── cli/                  # Command handlers
├── packages/web-ui/           # SvelteKit web interface
└── tests/                     # Vitest tests
```

## Shadow Branch Architecture

`.kspec/` is NOT a regular directory — it's a **git worktree** on an orphan branch (`kspec-meta`).

```
.kspec/.git → file pointing to worktree
  ↓
gitdir: .git/worktrees/-kspec
  ↓
Shadow branch (kspec-meta): orphan branch with spec/task files
```

**Why:** Spec/task changes don't clutter main branch history. Code PRs and spec changes tracked independently.

**How it works:** Every `kspec` command auto-commits to `kspec-meta`. Auto-pushes to remote if tracking configured. Main branch gitignores `.kspec/`.

**CRITICAL: Always run kspec from project root, never from inside `.kspec/`.** If you see "Cannot run kspec from inside .kspec/ directory", check `pwd`.

### Shadow Branch Commands

```bash
kspec shadow status   # Verify health
kspec shadow repair   # Fix broken worktree
kspec shadow sync     # Sync with remote
```

### Troubleshooting

| Issue | Fix |
|-------|-----|
| `.kspec/` doesn't exist | `kspec init` |
| Worktree disconnected | `kspec shadow repair` |
| Sync conflicts | `kspec shadow resolve` |
| Commands seem broken | Check `pwd` — must be project root |

## Key Concepts

### IDs and References

Every item has a ULID (canonical) and slug (human-friendly). References use `@` prefix: `@task-slug` or `@01JHNKAB`.

### Spec Items vs Tasks

- **Spec items** (`.kspec/modules/*.yaml`): Define WHAT to build
- **Tasks** (`.kspec/project.tasks.yaml`): Track the WORK of building

Tasks reference specs via `spec_ref`. They don't duplicate spec content.

### Task States

```
pending → in_progress → pending_review → completed
              ↓              ↓
          blocked ←──────────┘
              ↓          needs_work
          cancelled     (fix cycle: → in_progress → pending_review)
```

See `kspec help task` for transition commands and options.

## Spec-First Development

**Core principle**: If you're changing behavior and the spec doesn't cover it, update the spec first.

| Situation | Flow |
|-----------|------|
| Clear behavior change | Check spec → Update/create spec → Derive task |
| Vague idea, unclear scope | Capture in inbox → Triage later |
| Infra/internal (no user impact) | Create task directly, no spec needed |
| Bug revealing spec gap | Fix bug → Update spec to match reality |

### Plan Mode Workflow

When a plan is approved, you MUST translate it to specs before implementing:

1. Create spec item: `kspec item add --under @parent --title "Feature" --type feature`
2. Add acceptance criteria: `kspec item ac add @spec --given "..." --when "..." --then "..."`
3. Derive task: `kspec derive @spec`
4. Add implementation notes to task
5. Begin implementation

**Plans without specs are incomplete.** The spec with ACs IS the durable artifact.

### Creating Work

- **Clear scope?** → Create task directly
- **Unclear scope?** → `kspec inbox add "idea"` → triage later with `/triage`
- **Learning/friction?** → `kspec meta observe friction "..."` → review with `/reflect`

## Staying Aligned During Work

**Watch for scope expansion:**
- Modifying files outside your current task
- Adding functionality the spec doesn't mention
- "While I'm here, I should also..." thoughts

**When you notice something outside your task:** Capture it separately (inbox item, new task, or observation). Add a note to your current task documenting what you found. Don't fix it inline — even small detours compound into drift. Stay on your task.

## PR Workflow

Before creating a PR, mark the task: `kspec task submit @ref` (transitions to `pending_review`).

The full PR lifecycle has three steps — **all required, in order:**

1. **`/local-review`** — Quality gates: AC coverage, test quality, test isolation. Run this FIRST.
2. **`/pr`** — Create the pull request.
3. **`/pr-review`** — Review and merge. Or `kspec workflow start @pr-review-merge`.

**Quality gates (never skip without explicit approval):**
- All CI checks passing
- All review comments addressed
- All review threads resolved
- AC coverage verified

**After merge:** `kspec task complete @ref --reason "Merged in PR #N. Summary..."`

## Commit Convention

```
feat: Feature description

Task: @task-slug
Spec: @spec-ref
```

Trailers enable `kspec log @ref` to find commits by task or spec.

## Code Annotations

Link tests to acceptance criteria:

```typescript
// AC: @spec-item ac-N
it('should validate input', () => { ... });
```

Every AC SHOULD have at least one test with this annotation.

## Ralph Loop Mode

When running in automated loop mode (ralph):

### The Loop

```
for each iteration:
  1. Ralph checks eligible tasks — if none, exits loop
  2. Agent works on tasks, may create PR(s)
  3. Agent stops responding (turn complete)
  4. Ralph sends reflection prompt
  5. Ralph processes pending_review via subagent
  6. Continue
```

**When you stop responding, ralph continues automatically.** Do NOT call `end-loop` after creating a PR.

### Task Inheritance

Priority: `pending_review` > `in_progress` > `pending`. Always inherit existing work before starting new tasks.

### Blocking Rules

**Block only for genuine external blockers:**
- Requires human architectural decision
- Needs spec clarification
- Depends on external API/service not available
- Formally blocked by `depends_on`

**Do NOT block for:**
- Task seems complex (do the work)
- Tests are failing (fix them)
- Service needs running (start it)
- Another task's PR is in CI (not a formal dependency)

**After blocking a task:**
```bash
kspec task block @task --reason "Reason..."
kspec tasks ready --eligible
# If tasks returned: work on next one
# If empty: stop responding — ralph auto-exits
```

**One blocked task is NOT "no more work."** `kspec tasks ready --eligible` output is authoritative.

## Running Services

### Daemon

```bash
kspec serve start                          # Foreground
kspec serve start --daemon                 # Background (daemonized)
```

Default port 3456. Health: `GET /api/health`.

### E2E Tests

E2E tests **manage their own daemon** — do NOT start one manually.

```bash
npm run test:e2e -w packages/web-ui
npm run test:e2e -w packages/web-ui -- tests/e2e/tasks.spec.ts  # Specific file
```

**Architecture:**
- Tests in `packages/web-ui/tests/e2e/`
- Import from `../fixtures/test-base` (NOT main `tests/fixtures/`)
- Daemon runs on port 3456
- Each test gets isolated temp dir
- E2E fixtures are SEPARATE from unit test fixtures — never mix them

```typescript
import { test, expect } from '../fixtures/test-base';

test('my test', async ({ daemon, page }) => {
  await page.goto('http://localhost:3456');
});
```

### Web UI Development

```bash
npm run dev -w packages/web-ui  # Vite dev server (port 5173, connects to daemon on 3456)
```

## Test Fixture Patterns

### ULID Format

ULIDs use Crockford base32 which **excludes: I, L, O, U**.

```
❌ 01TRAIT10...  (contains I)
❌ 01MODULE0...  (contains O and U)
✅ 01TASK0000... (T, A, S, K all valid)
```

**This causes SILENT failures** — invalid ULIDs fail schema validation but tests appear to pass because the fixture doesn't load.

**Solution:** Use `testUlid('PREFIX')` helper or `kspec util ulid` for valid ULIDs.

### YAML Fixtures

**Never use `JSON.stringify()` for YAML** — use template strings or the `yaml` library's `stringify()`.

### Test Helpers

| Helper | Purpose |
|--------|---------|
| `setupTempFixtures()` | Copy pre-built fixtures to temp dir |
| `createTempDir()` | Create empty temp dir |
| `initGitRepo(dir)` | Initialize git with test config |
| `testUlid(prefix?)` | Generate valid test ULID |
| `testUlids(prefix, count)` | Generate multiple unique ULIDs |
| `kspec(args, cwd)` | Run CLI command, return result |
| `kspecJson<T>(args, cwd)` | Run CLI with --json, return parsed |

See `tests/helpers/cli.ts` for full documentation.

### Playwright Exclusion

Playwright E2E tests must be excluded from vitest (configured in `vitest.config.ts`). Run them separately with `npm run test:e2e`.

## CI Limitations

| Limitation | Detail |
|------------|--------|
| File watcher tests skip in CI | GitHub Actions doesn't support recursive `fs.watch`. Run locally before committing watcher changes. |
| E2E port hardcoded | Port 3456. Tests cannot run in parallel on same machine. |
| GitHub Pages BASE_PATH | Must set `BASE_PATH=/kynetic-spec` for local static builds. CI handles this automatically. |

## Daemon Test Architecture

Three approaches, each for different purposes:

1. **Static analysis** (vitest): Read source files, verify patterns. Fast, no runtime.
2. **Unit with isolation** (vitest): Test components in temp dirs with `createTempDir()`.
3. **E2E** (Playwright): Full browser integration. See E2E Tests section above.

Multi-project tests use `setupMultiDirFixtures()` for isolated project directories.

## Design Decisions

Key decisions documented in `docs/history/KYNETIC_SPEC_DESIGN.md`:

- **Format**: YAML with Zod validation
- **Schema source**: Zod (TypeScript-native)
- **Architecture**: Library-first, CLI is a consumer
- **Task-spec relationship**: Tasks reference specs, don't duplicate
- **Notes**: Append-only with supersession
