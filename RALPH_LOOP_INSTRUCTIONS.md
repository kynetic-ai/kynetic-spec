# Ralph Loop Instructions

Additions to the built-in ralph prompt. For general kspec workflow, see AGENTS.md.

## Session Start

1. **Get session context**:
   ```bash
   kspec session start
   ```

2. **Check for open PRs** before picking a task:
   ```bash
   gh pr list --state open
   ```

### PR Review Workflow

For each open PR, launch a **dedicated review subagent**:
```
Task tool → subagent_type: "general-purpose" → prompt: "Review PR #N: check code quality, test coverage, and alignment with task/spec. Run: gh pr view N --json body,commits,files && gh pr diff N"
```

Then follow this decision tree:

**Did you author this PR?** (i.e., did you create it in a previous session iteration?)

- **No (someone else's PR or from a prior session)**:
  - Review passes → Merge it: `gh pr merge N --merge`
  - Review finds issues → Post feedback, then implement fixes yourself

- **Yes (you created this PR in the current session)**:
  - Review passes → Merge it: `gh pr merge N --merge`
  - Review finds issues → Implement fixes, then:
    - **Trivial fixes** (typos, formatting, small tweaks) → Merge
    - **Non-trivial fixes** (logic changes, new code) → Run another review subagent cycle

**Key point**: The review subagent provides the independent review. "Don't merge your own" means don't skip the review step - it doesn't mean abandon the PR. Every PR should be reviewed and merged (or have clear blocking issues documented).

**Merge strategy**: Use `--merge` (not `--squash`) to preserve kspec trailers in commit messages.

**After merge**: Complete the linked task:
```bash
kspec task complete @task-ref --reason "Merged in PR #N"
```

## Problematic Tasks

| Situation | Action |
|-----------|--------|
| Under-defined | Lower priority + note why |
| Too big | Break into subtasks OR inbox item to decompose later |
| Already done | Complete with note explaining |
| Not worth doing | Lower priority + note why (don't delete) |

## After Commit: Create PR (REQUIRED)

The built-in prompt handles committing. **After that:**

1. **Submit task for review** (marks as pending_review):
   ```bash
   kspec task submit @task-ref
   ```

2. **Create PR**:
   ```
   /pr
   ```

Never leave changes only on main. Every iteration should end with a PR.

**After PR is merged** (by you or a subsequent iteration):
```bash
kspec task complete @task-ref --reason "Merged in PR #N"
```

## Reflect Guidance

Since there's no human in the loop, be selective:

- **Systemic only** - skip one-off issues
- **Concrete only** - skip vague ideas
- **Search first** - check specs/tasks/inbox before adding duplicates

See `/reflect` skill for the full framework.

## Session Context

Track focus and observations during work using `/meta`:

```bash
kspec meta focus set "Working on @task-slug"
kspec meta observe friction "Description of systemic issue"
kspec meta observe success "Pattern worth replicating"
```

This context persists across session iterations and informs future work.

## Available Skills

| Skill | When to Use |
|-------|-------------|
| `/kspec` | Task and spec management workflows |
| `/meta` | Session context (focus, observations) |
| `/triage` | Process inbox items systematically |
| `/spec-plan` | Translate approved plans to specs |
| `/reflect` | Session reflection and learning capture |
| `/pr` | Create PR from current work (decisive, no confirmations) |

**Note**: There is no `/review` skill. For PR reviews, use subagents with gh commands as shown in the PR Review Workflow section above.
