---
name: reflect
description: Reflect on a session to identify learnings, friction points, and improvements. Captures valuable insights for future sessions and system evolution.
---

# Session Reflection

Structured reflection using the `@session-reflect` workflow.

## Quick Start

```bash
# Start the reflection workflow
kspec workflow start @session-reflect

# Advance through steps (workflow will guide you)
kspec workflow next --notes "your notes..."
```

## Workflow Overview

The reflection workflow has 6 steps:

1. **What Worked Well** - Identify effective practices
2. **Friction Points** - Where things were harder than needed
3. **Check Coverage** - Search specs/tasks/inbox for existing tracking
4. **Propose Improvements** - Concrete ideas for untracked friction
5. **Discussion** - Present to user, get approval one at a time
6. **Capture** - Add approved items to inbox/observations

Use `kspec workflow show` to see current progress.

## Step Details

### Step 1: What Worked Well

Identify practices that were effective:
- Workflows that flowed smoothly
- Tools/commands that helped
- Communication patterns that kept alignment
- Decisions that proved correct

*Be specific - "categorizing items first" not "good planning"*

### Step 2: Friction Points

Identify where things were harder than needed:
- Repetitive manual steps
- Missing commands or options
- Context loss or re-explanation
- Workarounds used

*Focus on systemic issues, not one-off mistakes*

### Step 3: Check Existing Coverage

Before proposing improvements, search ALL sources:

```bash
kspec search "<keyword>"  # Searches specs, tasks, AND inbox
```

For each friction point, note if it's:
- **Already tracked** - reference the existing item/task
- **Partially covered** - note what's missing
- **Not tracked** - candidate for capture

**Exit criteria:** Must have searched specs, tasks, and inbox.

### Step 4: Propose Improvements

For untracked friction, propose concrete improvements:
- What it would do
- How it would help
- Rough scope (small/medium/large)

### Step 5: Discussion

Present findings to user. **Ask one at a time** about each improvement:
- Is this worth capturing?
- Any refinements to the idea?
- Related ideas from user perspective?

### Step 6: Capture

Use appropriate destination. **When capturing 2+ items, use `kspec batch`** for a single atomic commit:

```bash
# Single item
kspec inbox add "Description" --tag reflection --tag <area>
kspec meta observe friction "Description"

# Multiple items — use batch
echo '[
  {"command":"inbox add","args":{"text":"Improvement idea","tag":["reflection","area"]}},
  {"command":"meta observe","args":{"type":"friction","content":"Friction pattern"}},
  {"command":"meta observe","args":{"type":"success","content":"Success pattern"}}
]' | kspec batch
```

## Where to Capture What

| What you found | Where to put it | Why |
|----------------|-----------------|-----|
| Clear scope (know what to do and where) | `task add` | Ready to implement — don't use inbox |
| Unclear scope (vague idea, needs triage) | `inbox add` | Will be triaged into a task later |
| Behavior change that may need spec work | Ask user: task or inbox? | May need spec-first workflow |
| Friction pattern (systemic) | `meta observe friction` | Informs process improvement |
| Success pattern | `meta observe success` | Worth documenting/replicating |
| Open question needing research | `meta question add` | Track during session |

**Inbox vs Task:** Can you describe the change and where it goes? Use `task add`. Many tasks (infra, bug fixes, tooling, skills) don't need specs. Only ask the user when the item involves a behavior change that might need spec coverage first. If you're unsure, ask — don't default to inbox.

## Reflection Prompts

Use these during steps 1-2:

**Process:** What pattern did I repeat 3+ times? What workarounds did I use?
**Tools:** What command/flag did I wish existed?
**Communication:** Where was the user surprised? What should I have asked earlier?
**Learning:** What do I know now that I didn't at session start?

## Key Principles

- **Specific over general** - "No bulk AC add" not "CLI could be better"
- **Systemic over incidental** - Focus on repeatable friction
- **Ask don't assume** - User decides what's worth capturing
- **Brief on successes** - Friction points are the value

## Workflow Commands

```bash
# Check current step
kspec workflow show

# Advance with notes
kspec workflow next --notes "..."

# Skip a step if not applicable
kspec workflow next --skip --notes "reason"

# Pause for later
kspec workflow pause

# Resume
kspec workflow resume
```

## Integration

After reflection, observations can be:
- Promoted to tasks: `kspec meta promote @ref --title "..."`
- Resolved when addressed: `kspec meta resolve @ref`

## Loop Mode

You are running in autonomous loop mode.

### Gate: Check for Meaningful Session Work

**BEFORE starting reflection, check if there's anything worth reflecting on.**

Use the session introspection data (provided in your prompt context or via `kspec session start --json`) to check:

1. **Tasks completed recently** - Check `recently_completed` array. Are any `completed_at` timestamps from the current session (within the last ~1 hour)?

2. **Code changes** - Check `working_tree`:
   - Is `clean` false?
   - Are there any `staged`, `unstaged`, or `untracked` files?

3. **Recent commits** - Check `recent_commits` array. Are any commit timestamps from the current session?

**Skip reflection if ALL of these are true:**
- No tasks completed in the current session
- Working tree is clean (no staged/unstaged/untracked files)
- No commits made in the current session

If skipping, output:
```
Reflection skipped: no meaningful session work detected (no tasks completed, no code changes, no commits).
```

Then **exit immediately** without starting the workflow.

### If There IS Meaningful Work

Start the workflow:

```bash
kspec workflow start @session-reflect-loop
```

### Key Differences from Interactive Mode

1. **High confidence only** - Only capture friction/successes you're certain about
2. **Search first** - MUST search existing specs/tasks/inbox before capturing anything
3. **No user prompts** - Skip discussion step, auto-resolve decisions
4. **Lower volume** - Better to capture nothing than capture noise
5. **Higher bar for tasks** - In loop mode, prefer `inbox add` over `task add` unless the task is clearly scoped and obviously needed. Creating tasks has a higher bar without user confirmation — when in doubt, use inbox so the user can triage later

### Workflow Steps

1. **Review session** - What worked well, what caused friction
2. **Search existing** - For each potential capture:
   ```bash
   kspec search "<keyword>"
   ```
   If already tracked, skip it.
3. **Capture high-confidence items only**
   - Clear friction pattern you encountered multiple times? Capture it
   - Uncertain or one-off issue? Skip it
   - Success pattern worth replicating? Capture it
4. **Exit** - Don't wait for user confirmation

### Exit Conditions

- **Session reviewed** - Reflection complete (normal exit)
- **Nothing to capture** - No high-confidence items identified
- **All already tracked** - Search found existing coverage

### What NOT to Capture

- Vague observations ("could be better")
- One-time issues that won't recur
- Things you're unsure about
- Anything already tracked in specs/tasks/inbox
