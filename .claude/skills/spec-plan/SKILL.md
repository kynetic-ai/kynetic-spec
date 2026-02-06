---
name: spec-plan
description: Plan-to-spec translation - two paths (import and manual) with trait considerations and workflow orchestration.
---

# Plan to Spec Translation

Plans are durable artifacts that capture implementation context, approach, and rationale. Unlike conversations, plans persist in the shadow branch, link to derived specs and tasks, and provide auditable planning history across sessions.

## Quick Start

Always start with the design workflow:

```bash
kspec workflow start @spec-plan-design
```

Design concludes by choosing an execution path:

- **Import**: `kspec workflow start @spec-plan-import`
- **Manual**: `kspec workflow start @spec-plan-manual`

## When to Use

- After plan mode approval (approved plan -> specs + tasks)
- When creating specs for new features or requirements
- When translating ideas into trackable work
- **NOT** for raw ideas (use `/triage` or inbox instead)

**Tip:** If coming from Claude Code's `/plan`, the plan file is at `~/.claude/plans/<name>.md`.

## Three-Phase Approach

1. **Design** (`@spec-plan-design`): Explore, clarify, design, review -> produces a vetted plan
2. **Execute**: Import path (`@spec-plan-import`) or Manual path (`@spec-plan-manual`)

Always start with design. Never skip research and review.

## Choosing a Path

### Import Path

When: 3+ specs, structured plan document, batch creation
Start: `kspec workflow start @spec-plan-import`
Best for: Larger features, new capability areas, post-plan-mode

### Manual Path

When: 1-2 specs, incremental updates, quick additions
Start: `kspec workflow start @spec-plan-manual`
Best for: Small features, adding specs to existing areas

### Programmatic Alternative: `kspec batch`

For fully programmatic spec/task creation (e.g. scripts or agent pipelines), use `kspec batch` to execute multiple commands atomically:

```bash
kspec batch --commands '[
  {"command":"item add","args":{"under":"@parent","title":"Feature X","type":"feature","slug":"feature-x"}},
  {"command":"item ac add","args":{"ref":"@feature-x","given":"...","when":"...","then":"..."}},
  {"command":"derive","args":{"ref":"@feature-x"}}
]'
```

Batch runs all commands against an isolated state copy and commits once on success. On failure, everything rolls back. Use `--dry-run` to preview. See `/kspec` for full batch documentation.

### Decision Guide

| Situation                                | Path   |
|------------------------------------------|--------|
| Plan mode just approved, complex feature | Import |
| Adding a requirement to existing feature | Manual |
| Multiple related specs with parent/child | Import |
| Quick bug fix that needs spec coverage   | Manual |
| Translating design doc with many specs   | Import |
| Iterating on a previously imported plan  | Import (`--update`) |

## Plan Document Format

The import path uses structured markdown documents. The parser (`parsePlanDocument()`) extracts specs, tasks, and notes from this format:

```markdown
# Auth Redesign

## Specs

```yaml
- title: OAuth Provider Support
  slug: oauth-provider
  type: feature
  parent: "@auth"
  traits:
    - error-guidance
  acceptance_criteria:
    - id: ac-1
      given: User clicks "Sign in with Google"
      when: OAuth flow completes successfully
      then: User session is created with provider metadata
    - id: ac-2
      given: OAuth provider returns an error
      when: Error callback is received
      then: User sees descriptive error with retry option
- title: Token Refresh
  slug: token-refresh
  type: requirement
  parent: "@oauth-provider"
  implementation_notes: |
    Use sliding window with 15min expiry for token refresh.
```

## Tasks

derive_from_specs: true

```yaml
- title: Write migration guide
  slug: migration-guide
  priority: 2
  tags:
    - docs
```

## Implementation Notes

Use passport.js for OAuth. General architecture follows existing auth patterns.
```

**Section details:**
- `## Specs` - YAML code block with array of spec objects. Fields: `title` (required), `slug`, `type`, `parent` (use `@ref`), `description`, `acceptance_criteria` (each needs `id`, `given`, `when`, `then`), `traits` (array of trait IDs), `implementation_notes` (plain text, scoped to this spec's derived task)
- `## Tasks` - `derive_from_specs: true|false` as a bare line (creates a task per spec). Optional YAML code block with additional manual tasks (fields: `title` required, `slug`, `priority`, `description`, `tags`). Manual tasks get `plan_ref` but no `spec_ref`
- `## Implementation Notes` - Plain text, attached to the plan record. Per-spec notes use the `implementation_notes` field in each spec's YAML entry

## Trait Considerations

Traits are reusable AC bundles for cross-cutting concerns. CLI features commonly need:

- `json-output` - structured JSON output mode
- `dry-run` - preview without side effects
- `error-guidance` - actionable error messages
- `semantic-exit-codes` - meaningful process exit codes

```bash
# Browse available traits
kspec trait list

# Apply trait to spec (adds inherited AC automatically)
kspec item trait add @spec @trait
```

Import path: declare traits in the plan document YAML.
Manual path: apply after spec creation with `kspec item trait add`.

See `/spec` for full trait reference.

## Plan Lifecycle

Plans track status: `draft` -> `approved` -> `active` -> `completed` (or `rejected` from any non-terminal state)

- **Import** auto-creates plan as `active` (specs being created)
- **Manual** creates plan as `approved` (you're committing to the work)
- Mark `completed` when all derived work is done: `kspec plan set @plan --status completed`

## Common Mistakes

- **Skipping AC**: Every spec needs acceptance criteria
- **Vague AC**: "Works correctly" is not testable - use concrete Given/When/Then
- **Missing notes**: Plan context gets lost across sessions - add implementation notes
- **Wrong parent**: Check the item fits under its parent's domain
- **Too granular**: Not every plan bullet needs its own spec
- **Forgetting traits**: Leads to missing cross-cutting AC (check `kspec trait list`)
- **Skipping dry-run on import**: Catches errors before they create partial state

## Integration

- `/spec` - Spec authoring details (types, AC format, traits, validation)
- `/kspec` - General task and spec management
- `/task-work` - After specs are created, use for task lifecycle
- `/meta` - Track session focus during planning work
- `/reflect` - Post-work reflection and learning capture

## Quick Reference

```bash
# Design phase (always start here)
kspec workflow start @spec-plan-design

# Import path (3+ specs, batch)
kspec plan import <path> --module @module --dry-run   # preview
kspec plan import <path> --module @module             # create
kspec plan import <path> --module @module --update    # re-import

# Manual path (1-2 specs, incremental)
kspec plan add --title "Plan Title" --content "Description" --status approved
kspec item add --under @parent --title "Feature" --type feature --slug slug
kspec item ac add @slug --given "..." --when "..." --then "..."
kspec item trait add @slug @trait-name
kspec derive @slug
kspec task note @task-slug "Implementation approach: ..."
kspec task start @task-slug

# Common operations
kspec trait list                    # browse traits
kspec validate --refs              # verify all references
kspec plan get @plan               # view plan details
kspec plan set @plan --status completed  # mark done
```
