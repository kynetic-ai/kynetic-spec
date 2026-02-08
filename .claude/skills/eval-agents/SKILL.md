---
name: eval-agents
description: Evaluate whether AGENTS.md provides enough context for agents to make correct decisions. Spawns test agents with scenario questions and grades responses.
---

# Agent Documentation Evaluation

Validates that AGENTS.md (and the skill system) gives agents enough context to work correctly on this project. Use after modifying AGENTS.md, adding/removing skills, or changing core workflows.

## Why This Exists

AGENTS.md is loaded into every agent's context. It must be:
- **Complete enough** that agents can make correct decisions without guessing
- **Concise enough** that it doesn't waste context window on info available via skills/help
- **Accurate** — wrong information is worse than missing information

This skill tests completeness by spawning subagents with real-world scenarios and checking if they know what to do.

## When to Use

- After trimming or restructuring AGENTS.md
- After adding/removing/renaming skills
- After changing core workflows (task lifecycle, PR flow, shadow branch)
- Periodically as a health check

## How It Works

### Phase 1: Read Current State

Read the current AGENTS.md and the scenario reference file:

```
Read: AGENTS.md
Read: docs/agents-eval-scenarios.md
```

### Phase 2: Spawn Evaluation Agents

For each scenario group, spawn a subagent that:
1. Receives ONLY the current AGENTS.md content (plus skill blurbs as they would normally)
2. Gets asked the scenario question
3. Must answer what it would do and why

Spawn 3-4 agents in parallel, each handling a cluster of related scenarios:

**Agent 1 — Setup & Architecture** (Scenarios 1, 2, 11):
- First session setup
- Shadow branch understanding
- Where to find information

**Agent 2 — Task Lifecycle & Loop Mode** (Scenarios 3, 4, 5, 12):
- Inheriting work
- Blocking decisions
- Post-block behavior
- Batch operations

**Agent 3 — Spec-First & PR Flow** (Scenarios 6, 7, 10, 14, 15):
- Adding features (spec-first)
- PR workflow pairing
- Scope expansion
- Plan-to-spec
- Commit convention

**Agent 4 — Testing & CI** (Scenarios 8, 9, 13):
- ULID gotchas
- E2E test setup
- CI limitations

### Phase 3: Grade Responses

For each scenario, compare the agent's response against the expected answer:

| Grade | Criteria |
|-------|----------|
| **PASS** | Correct action AND correct reasoning |
| **PARTIAL** | Correct action but wrong/missing reasoning, or mostly right with minor gaps |
| **FAIL** | Wrong action, would lead to incorrect behavior |

### Phase 4: Report & Fix

Present results as a scorecard:

```
## Evaluation Results

| # | Scenario | Grade | Notes |
|---|----------|-------|-------|
| 1 | First Session Setup | PASS | Correctly identified bootstrap |
| 2 | Shadow Branch | PARTIAL | Knew CLI-only but didn't mention auto-commit |
| ... | ... | ... | ... |

**Score: 13/15 PASS, 1 PARTIAL, 1 FAIL**

### Gaps Found
- Scenario 2: AGENTS.md doesn't emphasize auto-commit enough
- ...

### Recommended Fixes
- Add sentence about auto-commit to Shadow Branch section
- ...
```

If FAILs are found, propose specific AGENTS.md edits to fix them.

## Prompt Template for Eval Agents

Use this prompt template when spawning evaluation agents:

```
You are an AI agent that has been given the following project documentation.
Answer each scenario question by explaining EXACTLY what you would do and why.
Be specific about commands, order of operations, and decision rationale.

If you don't have enough information to answer confidently, say "INSUFFICIENT INFO"
and explain what's missing.

---
PROJECT DOCUMENTATION:
<paste AGENTS.md content here>
---

SCENARIOS:
<paste relevant scenarios here>

For each scenario, respond with:
1. **Action**: What you would do (specific steps)
2. **Reasoning**: Why you chose this approach
3. **Confidence**: High/Medium/Low
```

## Scenario Reference

The full scenario set lives at `docs/agents-eval-scenarios.md`. Each scenario tests knowledge of a specific area:

| Scenario | Tests |
|----------|-------|
| 1. First Session Setup | Bootstrap, setup |
| 2. Shadow Branch Confusion | Architecture, CLI-not-YAML |
| 3. Inheriting Work | Task priority, state |
| 4. Task Blocking Decision | Blocking criteria |
| 5. After Blocking in Loop | Ralph continuation |
| 6. Adding a New Feature | Spec-first flow |
| 7. PR Workflow | PR + PR-review pairing |
| 8. Test Fixture ULID | Silent failure gotcha |
| 9. E2E Test Setup | Fixture isolation |
| 10. Scope Expansion | Alignment during work |
| 11. Where to Find Info | Information hierarchy |
| 12. Batch Operations | Efficiency patterns |
| 13. CI Test Failure | CI limitations |
| 14. Plan to Implementation | Plan mode, spec-first |
| 15. Commit Convention | Trailers, linking |

## Adding New Scenarios

When you discover a gap (agent made a wrong decision due to missing docs), add a scenario:

1. Add to `docs/agents-eval-scenarios.md` following the existing format
2. Include: situation, expected answer, what knowledge it tests
3. Run `/eval-agents` to verify the new scenario passes with current docs
4. If it fails, fix AGENTS.md first, then re-run

## Key Principles

- **Test real decisions, not trivia** — scenarios should reflect actual moments where an agent could go wrong
- **Expected answers are prescriptive** — they represent the project's preferred way of working
- **PARTIAL is a signal** — if agents consistently get partial credit on a topic, the docs need strengthening
- **Low confidence = doc gap** — if an agent says "I'm not sure" about something important, that's a fix needed

---

# Long-Context Stress Testing

Tests whether agents retain AGENTS.md rules after accumulating significant context from real codebase exploration. This simulates the real failure mode: rules loaded at token 0 get diluted by token 80k+.

## Why Stress Test

In real sessions, agents:
1. Load AGENTS.md at conversation start
2. Spend 30-100k tokens reading code, running commands, editing files
3. Make a critical decision that requires recalling an AGENTS.md rule

The standard eval tests recall with minimal context. Stress testing adds realistic cognitive load between learning and recall.

## Mode 1: Live Exploration (Realistic)

Spawn a single subagent that explores the real codebase, building genuine context, then answers recall questions. This is slower but most realistic.

### Running Mode 1

Spawn ONE general-purpose agent with the full prompt below. The agent will:
1. Read AGENTS.md (loaded naturally via project instructions)
2. Execute exploration directives (building 30-50k tokens of real context)
3. Answer recall questions at the end

Use `model: sonnet` for cost efficiency. The agent should be given generous `max_turns` (30+) to complete all exploration and recall.

### Exploration Directives

These are ordered to build context progressively. Each has a hidden "temptation" that tests whether a specific AGENTS.md rule survives context dilution.

```
PHASE 1: CODEBASE EXPLORATION

You are an agent onboarding to the kynetic-spec project. Complete each
exploration task thoroughly. Read the files, analyze the code, and answer
the questions. Take your time — thoroughness matters.

TASK 1: Understand the task system
Read .kspec/project.tasks.yaml (first 200 lines) and src/schema/task.ts.
Question: What fields does a task have? What are the valid states?

TASK 2: Explore CLI command structure
Read src/cli/commands/task.ts (first 500 lines).
Question: How does the `task start` command work? What validations does it perform?

TASK 3: Understand the spec system
Read .kspec/modules/cli.yaml (first 300 lines) and src/schema/item.ts (or similar).
Question: What types of spec items exist? How are acceptance criteria structured?

TASK 4: Explore the parser
Read src/parser/yaml.ts (first 400 lines).
Question: How does kspec load and save YAML files? What happens on save?

TASK 5: Study test patterns
Read tests/helpers/cli.ts and tests/integration.test.ts (first 300 lines).
Question: What test helpers are available? How are test fixtures set up?

TASK 6: Understand the meta system
Read src/cli/commands/meta.ts (first 400 lines).
Question: What are observations? How do they differ from inbox items?

TASK 7: Explore shadow branch mechanics
Read tests/shadow.test.ts (first 300 lines).
Question: How is the shadow branch worktree tested? What edge cases are covered?

TASK 8: Study E2E test architecture
Read packages/web-ui/tests/fixtures/test-base.ts (if it exists) and
look at packages/web-ui/tests/e2e/ for any test file.
Question: How are E2E tests structured? What does the fixture provide?

TASK 9: Review workflow system
Read tests/workflow-runs.test.ts (first 300 lines).
Question: How do workflows execute? What is the ralph loop model?

TASK 10: Check CI configuration
Read .github/workflows/ — pick any CI workflow file.
Question: What checks run in CI? Are there any known limitations?
```

### Recall Questions

After all exploration tasks, present these WITHOUT referencing AGENTS.md:

```
PHASE 2: DECISION SCENARIOS

Now that you've explored the codebase, answer these practical scenarios.
For each, explain what you would do and why.

R1: You found a typo in a task title while reading .kspec/project.tasks.yaml.
    The file is right there. How do you fix it?

R2: You need to write a test fixture with a ULID for a trait.
    Write out the ULID you would use.

R3: You're writing a new E2E test. Where does the file go, and what
    do you import? Do you need to start a daemon?

R4: You need to capture 4 inbox items and 2 observations.
    What's the most efficient way?

R5: You implemented a feature and are ready to get it merged.
    Walk through the complete flow from "code done" to "task completed."

R6: You're in ralph loop mode and your current task requires an API
    that doesn't exist yet. Tests are also failing on an unrelated function.
    What do you do about each issue?

R7: A plan was just approved. What must happen before you write any
    implementation code?

R8: You notice the JSON export has a bug while implementing CSV export
    (a different task). What do you do?
```

### Grading Rubric for Stress Test

| Question | Key Rule Being Tested | Pass Criteria |
|----------|----------------------|---------------|
| R1 | CLI-not-YAML | Uses `kspec task set`, does NOT edit file |
| R2 | ULID Crockford base32 | Avoids I, L, O, U — uses `testUlid()` or valid chars |
| R3 | E2E fixture isolation | Correct path, imports test-base, no manual daemon |
| R4 | Batch operations | Uses `kspec batch`, not 6 sequential commands |
| R5 | PR workflow pairing | local-review → /pr → /pr-review, task complete after merge |
| R6 | Blocking criteria | Block for missing API (valid), fix failing tests (invalid blocker) |
| R7 | Spec-first / plan mode | Create specs with ACs → derive tasks → then implement |
| R8 | Scope expansion | Capture separately, note in task, don't derail |

**Scoring:** Same PASS/PARTIAL/FAIL scale. Compare against standard eval to find degradation.

### Interpreting Results

| Standard Eval | Stress Test | Interpretation |
|---------------|-------------|----------------|
| PASS | PASS | Rule is well-documented and memorable |
| PASS | PARTIAL | Rule needs reinforcement (bolder text, repetition) |
| PASS | FAIL | Rule is too subtle — needs structural prominence |
| FAIL | FAIL | Rule is missing or unclear in AGENTS.md |

## Mode 2: Simulated Trace (Fast, Repeatable)

For quick regression testing, use a pre-built session trace instead of live exploration. This is deterministic and faster since it skips actual file reads.

### Building a Trace

Generate a trace from a real session:

```bash
# After a real work session, export the conversation context
# (This is manual — copy tool results from a past session into a file)
```

Or build one synthetically by concatenating key file excerpts:

```
Read: src/cli/commands/task.ts (lines 1-500)
[paste actual file content]

Read: .kspec/project.tasks.yaml (lines 1-200)
[paste actual file content]

... etc for 30k+ tokens ...
```

Save as `docs/eval-session-trace.md` and use in the eval agent prompt:

```
PROJECT DOCUMENTATION:
<AGENTS.md content>

PREVIOUS SESSION CONTEXT:
<session trace content>

SCENARIOS:
<recall questions>
```

### Keeping Traces Fresh

Session traces go stale as the codebase evolves. Regenerate periodically:
- After major refactoring
- When file structures change significantly
- When adding new modules or commands

## Progressive Degradation Testing

To find the breaking point, run the stress test at multiple context levels:

1. **Light** (10k tokens): 3 exploration tasks → recall
2. **Medium** (30k tokens): 6 exploration tasks → recall
3. **Heavy** (50k+ tokens): All 10 exploration tasks → recall

Compare scores across levels to identify which rules degrade first. Those rules need the most prominent placement in AGENTS.md.

## Temptation Map

Each exploration task creates specific temptation to violate a rule:

| Exploration Task | What Agent Sees | Temptation Created |
|-----------------|-----------------|-------------------|
| 1. Read task YAML | Raw status fields | Edit YAML directly |
| 2. CLI commands | Complex code | Skip to manual approach |
| 3. Spec system | AC structures in YAML | Add ACs by editing YAML |
| 4. Parser code | Auto-commit logic | Think they understand git enough to skip CLI |
| 5. Test patterns | ULID strings in tests | Copy invalid ULID patterns |
| 6. Meta system | Observation code | Confuse observations with inbox |
| 7. Shadow branch | Git worktree mechanics | Manual git operations |
| 8. E2E tests | Daemon setup code | Start daemon manually |
| 9. Workflows | Ralph loop internals | Call end-loop prematurely |
| 10. CI config | Skipped tests | Assume CI failure = skip |

This ensures the recall questions test rules that were specifically challenged by the preceding exploration.
