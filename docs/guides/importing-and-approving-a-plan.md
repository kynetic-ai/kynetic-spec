# Importing and Approving a Plan

This guide walks you through creating a structured plan document, importing it into kspec, and approving it to derive specs and tasks. By the end, you will have a plan that produces traceable specs with acceptance criteria and ready-to-work tasks.

## Prerequisites

- Completed the [Getting Started](../getting-started/index.md) section
- A project initialized with `kspec init` and `kspec setup`

## Steps

### 1. Write a plan document

A plan document is a markdown file with YAML code blocks that define specs and tasks. Create a file (for example, `plans/my-feature.md`) with this structure:

```markdown
# My Feature Plan

## Specs

\```yaml
- title: Feature Name
  slug: feature-name
  type: feature
  parent: "@main"
  description: |
    What this feature does and why it matters.
  acceptance_criteria:
    - id: ac-1
      given: |
        A user is on the dashboard
      when: |
        They click the export button
      then: |
        A CSV file downloads with the current data
\```

## Tasks

\```yaml
- title: Implement export feature
  slug: task-implement-export
  spec_ref: "@feature-name"
  plan_ref: "@plan-my-feature"
  tags: [mvp, feature]
\```
```

Each spec defines what to build with acceptance criteria. Each task references the spec it implements.

### 2. Preview the import

Before importing, preview what kspec will create:

```bash
kspec plan import plans/my-feature.md --preview
```

The preview shows the specs and tasks that will be created without making any changes. Review the output to confirm the structure matches your intent.

For all import options, run `kspec plan import --help`.

### 3. Import the plan

When satisfied with the preview, import for real:

```bash
kspec plan import plans/my-feature.md
```

kspec creates the plan record and all its specs and tasks on the shadow branch. You can inspect the result:

```bash
kspec plan get @plan-my-feature
```

### 4. Iterate with additions

If you need to add more specs or tasks to an existing plan, use the `--into` flag:

```bash
kspec plan import plans/additional-specs.md --into @plan-my-feature
```

This appends to the existing plan rather than creating a new one.

### 5. Approve the plan

Approving a plan signals that its specs and tasks are ready for work:

```bash
kspec plan approve @plan-my-feature
```

After approval, tasks derived from the plan appear in the ready queue:

```bash
kspec tasks ready
```

### 6. Derive tasks from specs

If your plan defined specs without tasks, you can derive tasks from any spec:

```bash
kspec derive @feature-name
```

This creates a task linked to the spec's acceptance criteria.

## Verification

Run the following to confirm your plan is imported and approved:

```bash
kspec plan get @plan-my-feature
```

The output should show `Status: active` and list the derived specs and tasks. Then verify tasks are ready:

```bash
kspec tasks ready
```

You should see tasks from your plan in the pending state, ready to be started.
