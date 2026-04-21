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

Before importing, preview what kspec will store:

```bash
kspec plan import plans/my-feature.md --dry-run
```

The preview shows the plan record that would be created without saving anything. Review the output to confirm the structure matches your intent.

For all import options, run `kspec plan import --help`.

### 3. Import the plan

When satisfied with the preview, import for real:

```bash
kspec plan import plans/my-feature.md
```

kspec stores the plan document content on the shadow branch. Importing does not create specs or tasks — that happens in the derive step. Inspect the result:

```bash
kspec plan get @plan-my-feature
```

### 4. Iterate with additions

If you need to update a plan with revised content, use the `--into` flag:

```bash
kspec plan import plans/revised-feature.md --into @plan-my-feature --reason "Addressed review feedback"
```

This updates the existing plan's stored content rather than creating a new one.

### 5. Approve the plan

Approving a plan signals that its content is ready for derivation:

```bash
kspec plan set @plan-my-feature --status approved
```

### 6. Derive specs and tasks

Derive materializes the stored plan content into specs and tasks:

```bash
kspec plan derive @plan-my-feature
```

Preview what will be created before committing:

```bash
kspec plan derive @plan-my-feature --dry-run
```

After derivation, tasks appear in the ready queue:

```bash
kspec tasks ready
```

## Verification

Run the following to confirm your plan is imported and approved:

```bash
kspec plan get @plan-my-feature
```

The output should show `Status: approved` and list the derived specs and tasks. Then verify tasks are ready:

```bash
kspec tasks ready
```

You should see tasks from your plan in the pending state, ready to be started.
