# Ralph Loop Instructions

Additions to the built-in ralph prompt. For general kspec workflow, see AGENTS.md.

## Session Start

**Check for open PRs first** before picking a task:
```bash
gh pr list --state open
```

### PR Review Workflow

For each open PR, launch a **dedicated review subagent**:
```
Task tool → subagent_type: "general-purpose" → prompt: "Run /review against PR #N"
```

Then follow this decision tree:

**Did you author this PR?** (i.e., did you create it in a previous session iteration?)

- **No (someone else's PR or from a prior session)**:
  - Review passes → Merge it
  - Review finds issues → Post feedback, then implement fixes yourself

- **Yes (you created this PR in the current session)**:
  - Review passes → Merge it (your changes haven't been reviewed yet, but the subagent just did)
  - Review finds issues → Implement fixes, then:
    - **Trivial fixes** (typos, formatting, small tweaks) → Merge
    - **Non-trivial fixes** (logic changes, new code) → Run another review subagent cycle

**Key point**: The review subagent provides the independent review. "Don't merge your own" means don't skip the review step - it doesn't mean abandon the PR. Every PR should be reviewed and merged (or have clear blocking issues documented).

## Reference Directories

Prior implementations exist in these directories - explore BEFORE implementing:

- `../kspec-acp-test`
- `../kspec-ralph-test`

**Use subagents for exploration** - these directories can be large:
```
Task tool → subagent_type: "Explore" → prompt: "In ../kspec-acp-test, find work related to [task/spec]. Check .kspec/ for tasks, notes, and inbox items. Summarize their approach and any lessons learned."
```

When picking up a task:
1. Launch an Explore subagent to search reference directories for related prior work
2. If the subagent finds relevant implementations, review their approach and notes
3. Spin up additional subagents as needed for deeper dives into specific files or patterns

This prevents context bloat from loading entire directories while still benefiting from prior work.

## Problematic Tasks

| Situation | Action |
|-----------|--------|
| Under-defined | Lower priority + note why |
| Too big | Break into subtasks OR inbox item to decompose later |
| Already done | Complete with note explaining |
| Not worth doing | Lower priority + note why (don't delete) |

## After Commit: Create PR (REQUIRED)

The built-in prompt handles committing. **After that, create a PR:**

```
/pr
```

Never leave changes only on main. Every iteration should end with a PR.

## Reflect Guidance

The built-in prompt asks you to reflect. Since there's no human in the loop:

- Capture **systemic friction** only (not one-off issues)
- Skip vague ideas - only concrete, actionable items
- Check existing inbox/tasks first to avoid duplicates
- Tag: `reflection`, `dx`, `workflow`, etc.
