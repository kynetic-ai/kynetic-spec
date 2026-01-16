---
name: pr
description: Create a pull request from current work. Handles branch creation, commits, push, and PR creation. Detects branch protection and guides through the PR workflow.
---

# PR Skill

Create a pull request from current work. Handles branch creation, commits, push, and PR creation.

## When to Use

- After completing work that needs to be merged via PR
- When direct push to main is blocked by branch protection
- To ship changes in a reviewable format

## Workflow

### Step 1: Detect Context

```bash
# Get current branch
git branch --show-current

# Check for uncommitted changes
git status --porcelain

# Check remote and parse owner/repo
git remote get-url origin
```

### Step 2: Check Branch Protection (Optional)

If on `main`, check if PRs are required:

```bash
# Parse owner/repo from remote URL
# Then check rulesets
gh api repos/{owner}/{repo}/rulesets --jq '.[] | select(.enforcement == "active") | .rules[] | select(.type == "pull_request")'
```

If `pull_request` rule exists, PRs are required. Inform user proactively.

### Step 3: Determine Branch Strategy

**If on `main` with uncommitted changes:**
1. Ask user for branch name (suggest based on task if in-progress task exists)
2. Create branch: `git checkout -b <branch-name>`
3. Stage and commit changes
4. Push with `-u origin <branch-name>`

**If on `main` with committed but unpushed changes:**
1. Ask user for branch name
2. Create branch from current HEAD: `git checkout -b <branch-name>`
3. Reset main to origin/main:
   ```bash
   git checkout main
   git reset --hard origin/main
   git checkout <branch-name>
   ```
4. Push branch

**If already on feature branch:**
1. Commit any uncommitted changes (ask for message)
2. Push to origin

### Step 4: Create PR

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<bullet points>

## Test plan
<checklist>

Task: @<task-ref>
Spec: @<spec-ref>

Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

**Title generation:**
- If linked to kspec task: Use task title
- If conventional commit in last commit: Use that
- Otherwise: Ask user

**Body generation:**
- Summarize changes from `git diff main...HEAD`
- Include task/spec references if available
- Add test plan checklist

### Step 5: Report

Display:
- PR URL
- Branch name
- Summary of what was included

## Arguments

- `<branch-name>` (optional): Name for the feature branch
- `--title "<title>"` (optional): PR title
- `--draft` (optional): Create as draft PR

## Integration with kspec

**Before creating PR:**
```bash
# Check for in-progress tasks
npm run dev -- task list --status in_progress
```

If in-progress task found:
- Suggest branch name based on task slug
- Include task reference in PR body
- Remind to complete task after merge

**Suggested commit format:**
```
<type>: <description>

Task: @<task-slug>
Spec: @<spec-ref>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
```

## Branch Naming

Suggest names based on context:
- Task slug: `feat/<task-slug>` or just `<task-slug>`
- Conventional: `feat/description`, `fix/description`

## Error Handling

**No remote configured:**
```
Error: No git remote configured. Add one with:
  git remote add origin <url>
```

**PR already exists:**
```bash
gh pr list --head <branch> --json number,url
```
If exists, show URL instead of creating new.

**Push rejected:**
Check if branch exists on remote with different history. Offer:
- Force push (if user confirms)
- Create new branch with suffix

## Example Usage

```
User: /pr
Agent: [Detects uncommitted changes on main]
Agent: I'll create a PR for your changes. Branch protection is active on main.

Suggested branch name: feat/ready-task-secondary-sort (based on recent commits)
PR title: "feat: implement secondary sort for ready tasks"

Proceed with these? [y/n/edit]

User: y
Agent: [Creates branch, commits, pushes, creates PR]
Agent: PR created: https://github.com/owner/repo/pull/5
```

## Worktree Support (Future)

For complex, long-running work, consider `/isolate` pattern:
- Create worktree: `git worktree add worktrees/<task-id> -b <task-id>`
- Work in isolation
- Land with `/land` when ready

This skill focuses on the simple case of shipping current work.
