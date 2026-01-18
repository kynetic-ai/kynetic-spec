# Ralph Loop Instructions

Additions to the built-in ralph prompt. For general kspec workflow, see AGENTS.md.

## Session Start

**Check for open PRs first** before picking a task:
```bash
gh pr list --state open
```
- Review open PRs, leave feedback, fix issues
- Merge if clean (don't merge your own unless changes are trivial)

## Reference Directories

Prior implementations exist in these directories - explore BEFORE implementing:

- `../kspec-acp-test`
- `../kspec-ralph-test`

Search for the same task/spec, review their approach, notes, and inbox.

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
