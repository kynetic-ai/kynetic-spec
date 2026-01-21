# Ralph Loop Instructions

Additions to the built-in ralph prompt. For general kspec workflow, see AGENTS.md.

## PR Review (Start of Iteration)

Check for open PRs before picking a task:
```bash
gh pr list --state open
```

For each open PR, spawn a review subagent:
```
Task tool → subagent_type: "general-purpose" → prompt: "Review PR #N: check code quality, test coverage, and alignment with task/spec. Run: gh pr view N --json body,commits,files && gh pr diff N"
```

**Decision tree:**
- Review passes → Merge: `gh pr merge N --merge`
- Review finds issues → Fix them, re-review if non-trivial
- After merge: `kspec task complete @task-ref --reason "Merged in PR #N"`

**Merge strategy**: Use `--merge` (not `--squash`) to preserve kspec trailers in commit messages.

## After Task Submit: Create PR

When code is complete and you've run `kspec task submit @task-ref`:
```
/pr
```

Do NOT create PRs for WIP commits. PRs are for completed work ready for review.

## Reflect Guidance

Be selective (no human in the loop):
- **Systemic only** - skip one-off issues
- **Concrete only** - skip vague ideas
- **Search first** - check specs/tasks/inbox before adding duplicates

See `/reflect` skill for the full framework.
