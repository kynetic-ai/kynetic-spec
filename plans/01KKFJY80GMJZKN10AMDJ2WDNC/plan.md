# Grouped Work and Human Handoff

This draft plan covers how multiple low-level agent tasks can be grouped into a more coherent reviewable unit for humans, including shared chain affinity and human-facing handoff packages.

It is downstream of dispatch isolation and the review record system. It should not block the dispatcher/worktree work.

## Context

The current task model is effective for discrete agent work but weak for:

- multi-step chains that should stay on one branch or workspace
- presenting a set of related agent tasks as one human reviewable change
- producing a durable handoff package that explains what changed and how to validate it

## Specs

```yaml
- title: Task Group and Chain Affinity
  slug: task-group-and-chain-affinity
  type: feature
  parent: "@task-system"
  description: |
    Tasks can be grouped into an intentional chain or work package so dispatch
    and review workflows can preserve branch/workspace affinity across the set.
  acceptance_criteria:
    - id: ac-1
      given: |
        Multiple tasks belong to the same grouped line of work
      when: |
        Their metadata is stored
      then: |
        The group identity and sequencing information can be represented without
        relying only on free-form tags
    - id: ac-2
      given: |
        A grouped task completes and another ready task in the same group exists
      when: |
        Dispatch selects follow-up work
      then: |
        The scheduler can prefer continuing the existing group context over
        unrelated work when that does not violate higher-priority dispatch rules

- title: Human Review Package
  slug: human-review-package
  type: requirement
  parent: "@task-group-and-chain-affinity"
  description: |
    A grouped work unit can produce a human-facing review package that explains
    the change coherently without requiring a reviewer to reconstruct the full
    agent task history manually.
  acceptance_criteria:
    - id: ac-1
      given: |
        A grouped work unit is ready for human review
      when: |
        The package is generated
      then: |
        It includes a change summary, impacted specs or acceptance criteria,
        validation evidence, and suggested review/test steps
    - id: ac-2
      given: |
        The grouped work unit spans multiple underlying agent tasks
      when: |
        The package is rendered
      then: |
        The package aggregates them into one human-facing delivery summary while
        preserving traceability back to the constituent tasks
```

## Tasks

derive_from_specs: true

```yaml
- slug: task-design-task-groups
  title: Design grouped task and chain-affinity model
  spec_ref: "@task-group-and-chain-affinity"
  priority: 3
  tags: [tasks, grouping, design]

- slug: task-design-human-review-package
  title: Design human-facing review package model
  spec_ref: "@human-review-package"
  priority: 3
  tags: [review, handoff, design]
```

## Implementation Notes

### Prerequisites (completed or in progress)

- **Dispatch worktree isolation and workspace tracking** — implemented
- **Review record and gate modeling** — implemented, with per-cycle
  review lifecycle improvements tracked in @plan-task-activity-timeline
- **`dispatch.publication_mode: manual_merge`** — landed (task @01KKTZ0B),
  agents no longer create PRs; work merges locally to integration branch
- **`dispatch.base_branch: dev`** — configured, `dev` branch created and
  pushed to remote

### Integration branch as implicit grouping

The `dev` branch already provides a lightweight version of task grouping
without explicit group metadata. The flow:

1. Agent tasks merge individually to `dev` via local merge (reviewer agent)
2. Related work accumulates on `dev` over time
3. When a coherent set of changes is ready, a human creates a PR from
   `dev` → `main` — this PR is the "human review package"

This gives implicit grouping by time window and branch scope. The question
for this plan is whether explicit group metadata (ac-1 of
@task-group-and-chain-affinity) adds enough value over this implicit
model to justify the complexity.

### Activity timeline as review package data source

The task activity timeline (@plan-task-activity-timeline) provides the
per-task audit trail that the human review package would aggregate.
The "change summary" in @human-review-package ac-1 could be derived from:
- Activity timelines of constituent tasks (state changes, review history)
- `git log main..dev` for the commit-level view
- Linked spec refs and AC coverage from each task

### Design considerations

- Avoid forcing a separate heavyweight task type unless the simpler
  grouped metadata model is clearly insufficient
- Consider whether `dev` branch scope + `git log` is sufficient for
  the review package, or whether explicit task-to-group linking is needed
  for dispatch affinity (ac-2 of @task-group-and-chain-affinity)
