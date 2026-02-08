# AGENTS.md Evaluation Scenarios

These test whether an agent reading only AGENTS.md (plus skill blurbs injected at invocation time) has enough context to make correct decisions.

## Scoring

For each scenario, the agent should identify the correct action AND reasoning.
- **PASS**: Correct action with correct reasoning
- **PARTIAL**: Correct action but wrong/missing reasoning
- **FAIL**: Wrong action

---

## Scenario 1: First Session Setup

**Situation:** You just cloned this repo and need to start working.

**Expected answer:**
- Run `node scripts/bootstrap.cjs` first
- This handles install, build, link, init automatically
- Then check `kspec session start` for context
- MUST run from project root, never from inside `.kspec/`

**Tests knowledge of:** Bootstrap, setup, project root requirement

---

## Scenario 2: Shadow Branch Confusion

**Situation:** You ran `ls .kspec/` and see YAML files. You want to fix a typo in a task's title. What do you do?

**Expected answer:**
- NEVER manually edit YAML in `.kspec/` — use `kspec task set @ref --title "Fixed title"`
- `.kspec/` is a git worktree on the `kspec-meta` shadow branch
- CLI auto-commits changes to shadow branch
- Manual edits bypass auto-commit and can cause drift

**Tests knowledge of:** Shadow branch architecture, CLI-not-YAML rule

---

## Scenario 3: Inheriting Work

**Situation:** You run `kspec session start` and see a task in `pending_review` state and two `pending` tasks.

**Expected answer:**
- Inherit the `pending_review` task first — it takes priority
- Check if its PR exists and needs attention (review, CI, merge)
- Don't start new pending tasks until pending_review is resolved
- Priority order: `pending_review` > `in_progress` > `pending`

**Tests knowledge of:** Task inheritance, state priority

---

## Scenario 4: Task Blocking Decision

**Situation:** You're in ralph loop mode. Your current task requires implementing a new CLI command, but the tests are failing because a dependency function has a bug. Should you block the task?

**Expected answer:**
- NO — "tests are failing" is NOT a valid blocking reason
- Fix the bug in the dependency function as part of the task
- Valid blockers are: human decisions needed, spec gaps, external dependencies
- Only block after genuinely attempting the work

**Tests knowledge of:** Blocking criteria, ralph loop behavior

---

## Scenario 5: After Blocking a Task in Loop Mode

**Situation:** You blocked task @foo because it needs an architectural decision from the user. What do you do next?

**Expected answer:**
- MUST run `kspec tasks ready --eligible`
- If tasks are returned: pick one and continue working
- If empty: stop responding (ralph auto-exits)
- Do NOT call `kspec ralph end-loop`
- One blocked task does NOT mean "no more work"

**Tests knowledge of:** Ralph loop continuation, eligible task checking

---

## Scenario 6: Adding a New Feature

**Situation:** User asks you to add a `kspec export --format csv` command. Where do you start?

**Expected answer:**
- This is a behavior change — check spec coverage first
- Look for existing spec items covering export functionality
- If no spec coverage: create spec item with ACs before implementing
- Use `/spec-plan` or manual spec creation flow
- Derive task from spec, then implement

**Tests knowledge of:** Spec-first development, decision flow

---

## Scenario 7: PR Workflow

**Situation:** You've finished implementing a task and committed your code. What's the full flow to get it merged?

**Expected answer:**
- Run `/local-review` first for quality gates (AC coverage, test quality)
- Use `/pr` to create the pull request
- Use `@pr-review-merge` workflow for merge (or `/pr-review`)
- Quality gates: CI passing, review comments addressed, threads resolved
- After merge: `kspec task complete @ref --reason "..."`
- Include commit trailers: `Task: @task-slug`, `Spec: @spec-ref`

**Tests knowledge of:** PR + PR review pairing, quality gates, task completion

---

## Scenario 8: Test Fixture ULID Gotcha

**Situation:** You're writing a test fixture YAML file and need a task ULID. You write `01TRAIT10000000000000000000`. Will this work?

**Expected answer:**
- NO — contains `I` which is invalid in Crockford base32
- ULIDs exclude: I, L, O, U
- Use `testUlid('TRAIT')` helper which auto-replaces invalid chars
- Or use `kspec util ulid` to generate valid ULIDs
- This causes SILENT failures — schema validation rejects it but tests appear to pass

**Tests knowledge of:** ULID format requirements, silent failure gotcha

---

## Scenario 9: E2E Test Setup

**Situation:** You need to write a new E2E test for the web UI. How do you set it up?

**Expected answer:**
- Tests go in `packages/web-ui/tests/e2e/`
- Import from `../fixtures/test-base` (NOT main `tests/fixtures/`)
- Do NOT start a daemon manually — test-base handles lifecycle
- Daemon runs on port 3456 (not 3000)
- Each test gets isolated temp dir with fixtures
- E2E fixtures are separate from unit test fixtures — never mix them

**Tests knowledge of:** E2E architecture, fixture isolation

---

## Scenario 10: Scope Expansion

**Situation:** You're working on task @add-csv-export. While implementing, you notice the existing JSON export has a bug. Should you fix it?

**Expected answer:**
- This is scope expansion — recognize it
- If the fix is small and proportional: fix it, but add a note to the task
- If major: capture in inbox or new task, don't derail current work
- Check if the bug's area has spec coverage
- Always note scope expansion in task notes

**Tests knowledge of:** Staying aligned, scope expansion recognition

---

## Scenario 11: Where to Find Information

**Situation:** You need to know how to manage session observations. Where do you look?

**Expected answer:**
- Invoke `/meta` skill — it has full observation commands and workflows
- AGENTS.md tells you which skills exist and when to use them
- Skills provide detailed step-by-step workflows when invoked
- CLI `--help` has command syntax reference

**Tests knowledge of:** Information hierarchy, skill awareness

---

## Scenario 12: Batch Operations

**Situation:** You need to capture 5 inbox items and resolve 3 observations. What's the most efficient approach?

**Expected answer:**
- Use `kspec batch` — one atomic shadow branch commit instead of 8 separate ones
- Pipe JSON array with commands
- Better than 8 sequential `kspec` calls

**Tests knowledge of:** Batch operations for efficiency

---

## Scenario 13: CI Test Failure

**Situation:** Your PR's CI is failing because `daemon-watcher-multi-project.test.ts` fails in GitHub Actions but passes locally.

**Expected answer:**
- This test is designed to skip in CI (`process.env.CI ? describe.skip : describe`)
- GitHub Actions containers don't support recursive `fs.watch`
- If it's NOT skipping, check that the CI skip condition is intact
- Run watcher tests locally before committing watcher changes

**Tests knowledge of:** CI limitations

---

## Scenario 14: Plan to Implementation

**Situation:** Your plan was approved in plan mode. What do you do before writing code?

**Expected answer:**
- Translate plan to specs FIRST — plans without specs are incomplete
- Create spec items under appropriate parent: `kspec item add --under @parent ...`
- Add acceptance criteria for each testable outcome
- Derive tasks from specs: `kspec derive @spec-slug`
- Add implementation notes from plan to task
- THEN start implementation

**Tests knowledge of:** Plan mode workflow, spec-first requirement

---

## Scenario 15: Commit Convention

**Situation:** You just completed task @add-csv-export which implements spec @csv-export-feature. Write the commit message.

**Expected answer:**
```
feat: Add CSV export format support

Task: @add-csv-export
Spec: @csv-export-feature
```
- Trailers enable `kspec log @ref` to find related commits
- Standard git format compatible with `git log --grep`

**Tests knowledge of:** Commit message convention with trailers
