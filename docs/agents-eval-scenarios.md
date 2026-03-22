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

**Situation:** You're in agent dispatch mode. Your current task requires implementing a new CLI command, but the tests are failing because a dependency function has a bug. Should you block the task?

**Expected answer:**
- NO — "tests are failing" is NOT a valid blocking reason
- Fix the bug in the dependency function as part of the task
- Valid blockers are: human decisions needed, spec gaps, external dependencies
- Only block after genuinely attempting the work

**Tests knowledge of:** Blocking criteria, agent dispatch behavior

---

## Scenario 5: After Blocking a Task in Loop Mode

**Situation:** You blocked task @foo because it needs an architectural decision from the user. What do you do next?

**Expected answer:**
- MUST run `kspec tasks ready --eligible`
- If tasks are returned: pick one and continue working
- If empty: stop responding (dispatch exits automatically)
- Do NOT call `kspec agent end-loop`
- One blocked task does NOT mean "no more work"

**Tests knowledge of:** Agent dispatch continuation, eligible task checking

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

## Scenario 7: Work Submission and Review Flow

**Situation:** You've finished implementing a task and committed your code. What's the full flow to get it reviewed and merged?

**Expected answer:**
- Verify quality: AC coverage (own + trait), tests pass, `kspec validate`
- Submit: `kspec task submit @ref` (transitions to pending_review)
- Reviewer creates kspec review record, investigates, submits verdict
- Review gates: disposition = approved, required checks passing, no unresolved blocker threads
- If changes requested: read review threads via `kspec review for-task`, fix, resubmit
- After approval: merge locally to integration branch (see `/kspec:merge`)
- Complete: `kspec task complete @ref --reason "..."`

**Tests knowledge of:** Review-driven workflow, kspec review records, merge gates

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
- Capture the bug separately (inbox item or new task), don't fix it inline
- Add a note to your current task documenting what you found
- Stay on your CSV export task — even small detours compound into drift
- Check if the bug's area has spec coverage

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
- File watcher tests are known to skip in CI — GitHub Actions doesn't support recursive `fs.watch`
- If it's failing rather than skipping, the skip condition may be broken — investigate
- Run watcher tests locally before committing watcher changes

**Tests knowledge of:** CI limitations (AGENTS.md CI Limitations table)

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

---

# Stress Test Recall Questions

These are used AFTER the agent has explored 30-50k tokens of real codebase content. They test the same rules as standard scenarios but under cognitive load. See `/eval-agents` skill for the full exploration directives.

---

## R1: YAML Edit Temptation

**Situation:** You found a typo in a task title while reading `.kspec/project.tasks.yaml`. The file is right there open in your context. How do you fix it?

**Expected answer:**
- Use `kspec task set @ref --title "Corrected Title"` — NEVER edit the file directly
- `.kspec/` files are on the shadow branch; CLI auto-commits changes
- Manual edits bypass auto-commit and can cause drift

**Tests rule:** CLI-not-YAML (Essential Rule #1)
**Temptation source:** Exploration Task 1 (reading raw task YAML)

---

## R2: ULID Generation

**Situation:** You need to write a test fixture with a ULID for a trait. Write out the ULID you would use.

**Expected answer:**
- Use `testUlid('TRAIT')` helper which auto-replaces invalid chars
- Or `kspec util ulid` for a valid ULID
- MUST NOT contain I, L, O, U (Crockford base32)
- `01TRAIT...` is INVALID because it contains I
- Invalid ULIDs cause SILENT test failures

**Tests rule:** ULID Crockford base32 restriction
**Temptation source:** Exploration Task 5 (reading ULID patterns in test code)

---

## R3: E2E Test Setup

**Situation:** You're writing a new E2E test. Where does the file go, what do you import, and do you need to start a daemon?

**Expected answer:**
- File goes in `packages/web-ui/tests/e2e/`
- Import from `../fixtures/test-base` (NOT main `tests/fixtures/`)
- Do NOT start a daemon — test-base manages lifecycle automatically
- Daemon runs on port 3456, each test gets isolated temp dir

**Tests rule:** E2E fixture isolation, daemon lifecycle
**Temptation source:** Exploration Task 8 (reading daemon setup code)

---

## R4: Batch Operations

**Situation:** You need to capture 4 inbox items and 2 observations. What's the most efficient way?

**Expected answer:**
- Use `kspec batch` with a JSON array of all 6 commands
- One atomic shadow branch commit instead of 6

**Tests rule:** Batch mutations (Essential Rule #6)
**Temptation source:** Exploration Task 6 (seeing sequential meta operations)

---

## R5: Review and Merge Flow

**Situation:** You implemented a feature and the code is done. Walk through the complete flow from "code committed" to "task completed."

**Expected answer:**
1. Verify quality: AC coverage (own + trait), tests pass, `kspec validate`
2. Submit: `kspec task submit @ref` (transitions to pending_review)
3. Reviewer creates kspec review, investigates, submits verdict
4. Review gates: disposition = approved, checks passing, blocker threads resolved
5. After approval: merge locally via `/kspec:merge`
6. Complete: `kspec task complete @ref --reason "Merged. Summary..."`

**Tests rule:** Review-driven workflow (review + merge skills), task completion after merge
**Temptation source:** Exploration Task 2 (reading task command internals)

---

## R6: Blocking vs Fixing

**Situation:** You're in agent dispatch mode. Your current task requires an API that doesn't exist yet. Tests are also failing on an unrelated function. What do you do about each issue?

**Expected answer:**
- **Missing API:** Block the task — this is a valid external blocker
- **Failing tests:** Fix them — "tests are failing" is NOT a valid blocking reason
- After blocking: MUST run `kspec tasks ready --eligible`
- If tasks remain: work on next one. If empty: stop responding.

**Tests rule:** Blocking criteria, dispatch continuation
**Temptation source:** Exploration Task 9 (reading deprecated loop internals)

---

## R7: Plan to Implementation

**Situation:** A plan was just approved. What must happen before you write any implementation code?

**Expected answer:**
- Create spec items with acceptance criteria FIRST
- Plans without specs are incomplete
- Flow: create spec → add ACs → derive task → add implementation notes → start
- The spec with ACs is the durable artifact, not the plan file

**Tests rule:** Spec-first / plan mode workflow
**Temptation source:** Exploration Task 3 (reading spec YAML directly)

---

## R8: Scope Expansion

**Situation:** You notice the JSON export has a bug while implementing CSV export (a different task). What do you do?

**Expected answer:**
- Recognize this as scope expansion
- Capture the bug separately (inbox item or new task)
- Add a note to current task documenting the discovery
- Continue with original CSV export task
- Check if JSON export area has spec coverage

**Tests rule:** Staying aligned, scope expansion recognition
**Temptation source:** Exploration Tasks 2-3 (deep in CLI code, tempted to fix nearby issues)
