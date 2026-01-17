---
name: spec-plan
description: Translate an approved plan into specs with acceptance criteria and derived tasks. Use after plan mode when transitioning to implementation.
---

# Plan to Spec Translation

After a plan is approved, translate it into durable kspec artifacts before implementing.

## Why This Matters

- Plan files may not persist across sessions
- Specs with AC are the source of truth
- Tasks link to specs for context
- Implementation notes capture the "how"

## Workflow

### 1. Identify Spec Items from Plan

Review the approved plan and extract:
- **Features**: Major capabilities being added
- **Requirements**: Specific behaviors under features
- **Acceptance Criteria**: Testable outcomes (Given/When/Then)

Most plans translate to 1-3 spec items with 3-7 AC total.

### 2. Find the Right Parent

```bash
# List existing items to find appropriate parent
npm run dev -- item list | grep -i "<domain>"

# Check a potential parent
npm run dev -- item get @parent-slug
```

Spec items need a parent (module or feature). Choose based on domain fit.

### 3. Create Spec Item(s)

```bash
npm run dev -- item add \
  --under @parent \
  --title "Feature Title" \
  --type feature \
  --slug feature-slug \
  --tag <relevant-tag> \
  --description "What this feature does and why"
```

For requirements under features:
```bash
npm run dev -- item add \
  --under @feature-slug \
  --title "Specific Requirement" \
  --type requirement \
  --slug requirement-slug
```

### 4. Add Acceptance Criteria

For each testable outcome from the plan:

```bash
npm run dev -- item ac add @spec-slug \
  --given "The precondition or context" \
  --when "The action or trigger" \
  --then "The expected observable result"
```

**Tips:**
- Each AC should be independently testable
- Use concrete examples, not abstract descriptions
- Cover happy path and key edge cases
- 3-5 AC per spec item is typical

### 5. Derive Implementation Task

```bash
# Recursive (default) - derives tasks for spec and all children
npm run dev -- derive @spec-slug

# Preview first with dry-run
npm run dev -- derive @spec-slug --dry-run

# Flat - only this spec, not children
npm run dev -- derive @spec-slug --flat
```

This creates task(s) linked to the spec. Child tasks automatically depend on parent tasks.
For hierarchical specs (feature with requirements), recursive derive creates the full task tree.

### 6. Add Implementation Notes

Transfer key implementation details from the plan:

```bash
npm run dev -- task note @task-slug "Implementation approach:

**Files to modify:**
- path/to/file.ts - description

**Key decisions:**
- Decision 1: rationale
- Decision 2: rationale

**Verification:**
- How to test this works"
```

### 7. Begin Implementation

```bash
npm run dev -- task start @task-slug
```

## Checklist

Before starting implementation, verify:

- [ ] Spec item created with meaningful description
- [ ] All acceptance criteria from plan captured
- [ ] Task derived and linked to spec
- [ ] Implementation notes transferred from plan
- [ ] Task started and ready for work

## Examples

### Small Feature (1 spec, 3 AC)

```bash
# Create spec
npm run dev -- item add --under @cli --title "JSON Output Mode" --type feature --slug json-output

# Add AC
npm run dev -- item ac add @json-output --given "User runs any command" --when "--json flag is passed" --then "Output is valid JSON"
npm run dev -- item ac add @json-output --given "Command produces output" --when "--json flag is passed" --then "Output includes all data that text mode shows"
npm run dev -- item ac add @json-output --given "Command fails" --when "--json flag is passed" --then "Error is JSON with 'error' field"

# Derive and note
npm run dev -- derive @json-output
npm run dev -- task note @task-json-output "Check globalJsonMode pattern in output.ts..."
```

### Larger Feature (1 feature + 2 requirements)

```bash
# Create feature
npm run dev -- item add --under @cli --title "Auto Documentation" --type feature --slug auto-docs

# Create requirements
npm run dev -- item add --under @auto-docs --title "Command Introspection" --type requirement --slug cmd-introspection
npm run dev -- item add --under @auto-docs --title "Dynamic Help" --type requirement --slug dynamic-help

# Add AC to each
npm run dev -- item ac add @cmd-introspection --given "..." --when "..." --then "..."
npm run dev -- item ac add @dynamic-help --given "..." --when "..." --then "..."

# Preview what derive will create
npm run dev -- derive @auto-docs --dry-run

# Derive all tasks recursively (creates 3 tasks with proper dependencies)
npm run dev -- derive @auto-docs
```

Recursive derive creates: `task-auto-docs`, then `task-cmd-introspection` and `task-dynamic-help`
both depending on `@task-auto-docs`.

## Common Mistakes

- **Skipping AC**: Every spec needs acceptance criteria
- **Vague AC**: "Works correctly" is not testable
- **Missing notes**: Plan context gets lost
- **Wrong parent**: Check item fits under parent's domain
- **Too granular**: Not every plan bullet needs its own spec

## Integration

This skill pairs with:
- **Plan mode**: Use after plan approval
- **kspec skill**: For ongoing task/spec management
- **reflect skill**: Review if spec-first was followed

## Quick Reference

```bash
# The full flow in one block
npm run dev -- item add --under @parent --title "Title" --type feature --slug slug
npm run dev -- item ac add @slug --given "..." --when "..." --then "..."
npm run dev -- derive @slug
npm run dev -- task note @task-slug "Implementation: ..."
npm run dev -- task start @task-slug
```
