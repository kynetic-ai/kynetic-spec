---
name: triage
description: Triage inbox items systematically. Analyzes items against spec/tasks, categorizes them, and processes using spec-first approach with plan mode for larger features.
---

# Inbox Triage

Systematically process inbox items: analyze, categorize, and convert to specs/tasks using spec-first development.

## Workflow

### 1. Gather Context

```bash
kspec session start --full
kspec inbox list
kspec meta observations --pending-resolution
```

Understand: current tasks, spec coverage, inbox volume, and any unresolved observations.

### 2. Categorize Items

Group inbox items by type:
- **Bugs** - implementation issues, errors
- **Spec gaps** - missing or incomplete specs
- **Quick wins** - small, well-defined improvements
- **Larger features** - need plan mode to design
- **Process/workflow** - meta improvements
- **Delete candidates** - outdated, duplicates, already done

Present categories to user for alignment.

### 3. Process Each Item

For each item, follow this decision tree:

```
Is it still relevant?
├─ No → Delete: kspec inbox delete @ref --force
└─ Yes → Does spec cover this?
         ├─ No spec exists → Create spec first
         │   └─ Small: item add + ac add
         │   └─ Large: Enter plan mode
         ├─ Spec exists but incomplete → Update spec (add AC)
         └─ Spec complete → Promote to task
```

### 4. Spec-First Processing

**For each behavior change:**

1. **Check coverage**: `kspec item list | grep <relevant>`
2. **Identify gaps**: Does spec have description AND acceptance criteria?
3. **Update spec**:
   ```bash
   kspec item set @ref --description "..."
   kspec item ac add @ref --given "..." --when "..." --then "..."
   ```
4. **Derive or promote**:
   ```bash
   kspec derive @spec-ref           # If spec exists
   kspec inbox promote @ref --title "..." --spec-ref @spec  # If from inbox
   ```

### 5. Plan Mode for Larger Items

When an item needs design work:

1. Enter plan mode
2. Explore codebase for patterns/context
3. Design spec structure and implementation approach
4. Write plan, exit for approval
5. Execute: create spec, add AC, derive task

### 6. Processing Observations

During triage, also process pending observations:

```bash
kspec meta observations --pending-resolution
```

For each observation type:

| Type | How to Process |
|------|----------------|
| **friction** | Does it reveal a spec gap? → Create spec or inbox item. If already addressed → resolve |
| **success** | Document in relevant spec or AGENTS.md if broadly useful → resolve |
| **question** | Answer it if you can. If needs investigation → promote to task |
| **idea** | Evaluate scope. Clear → inbox or task. Unclear → leave or delete |

**Processing commands:**

```bash
# Promote observation to task (when actionable work is clear)
kspec meta observations promote @ref --title "Add bulk AC command" --priority 2

# Resolve observation (when addressed or no longer relevant)
kspec meta observations resolve @ref

# Convert inbox item to observation (if it's friction, not a task)
kspec meta observe --from-inbox @ref
```

**When to use which:**
- **Inbox** = future work that becomes tasks
- **Observations** = systemic patterns that inform improvements
- **Tasks** = clear, actionable implementation work

## Key Principles

- **Ask one question at a time** - Use AskUserQuestion for decisions, don't batch
- **Spec before task** - Fill spec gaps before creating implementation tasks
- **AC is required** - Specs without acceptance criteria are incomplete
- **Use CLI, not YAML** - All changes through kspec commands
- **Delete freely** - Inbox items that are outdated or duplicates should go

## Quick Commands

```bash
# Triage decisions
kspec inbox delete @ref --force     # Remove irrelevant
kspec inbox promote @ref --title "..." --spec-ref @spec  # Convert to task

# Spec updates
kspec item set @ref --description "..."
kspec item ac add @ref --given "..." --when "..." --then "..."

# Create spec for gap
kspec item add --under @parent --title "..." --type requirement --slug slug

# Derive task from spec (recursive by default - includes children)
kspec derive @spec-ref

# Preview before deriving
kspec derive @spec-ref --dry-run

# Derive only this spec, not children
kspec derive @spec-ref --flat
```

## Session Pattern

1. Get context: `kspec session start --full`
2. List inbox: `kspec inbox list`
3. Present categorized overview to user
4. Ask which category to tackle
5. Process items in that category
6. Repeat or stop when user indicates

## Progress Tracking

Use TodoWrite to track progress during triage:
- Create todos for each item being processed
- Mark completed as you go (don't batch)
- Keeps both agent and user oriented

Keep a running summary:
- Items processed (deleted, promoted, spec'd)
- Tasks created
- Specs updated

At session end, provide summary:
- Started with X inbox items, Y observations
- Processed: Z items (deleted, promoted, spec'd)
- Tasks created
- Observations resolved
- Remaining items

## Common Patterns

| Pattern | Action |
|---------|--------|
| Already implemented | Verify impl exists → check spec for gaps → fill gaps → delete inbox |
| Duplicate of existing | Verify original covers scope → reference it → delete inbox |
| Small flag/option | Update spec description + AC → derive task |
| New command | Plan mode → design spec → create spec + AC → derive task |
| Bug report | Check spec coverage → update spec if needed → promote with spec-ref |
| Friction observation | Check if spec/task exists → create if needed → resolve observation |
| Success observation | Document pattern if broadly useful → resolve |
| Question observation | Answer or promote to task if needs investigation → resolve |
| Vague idea | Ask for clarification or leave in inbox for later |

## Tips

- **Verify before delete**: Quick check that feature really exists
- **Link related items**: When promoting, add spec-ref and depends-on
- **Spec status**: Mark as `implemented` if catching up spec to reality
- **Ask early**: If unsure about user intent, ask before deep work
