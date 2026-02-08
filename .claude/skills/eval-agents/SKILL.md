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
