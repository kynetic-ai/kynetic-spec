# Activity Timeline Diff Summaries

**Status: Needs refinement — stub capturing design direction from the task activity timeline plan.**

Deferred from @plan-task-activity-timeline to keep that plan focused on the core timeline and review lifecycle changes. This plan covers enriching the activity timeline with diff summaries at submission points.

## Context

With the activity timeline in place (@task-activity-timeline), submission entries show _what happened_ (state changed to pending_review) but not _what changed_ (code). Diff summaries connect timeline events to actual work.

Three diffs are computable once the foundations land:

1. **Diff against merge target** — `git diff <upstream>...<submission_commit>` — the "PR diff" equivalent showing the total scope of work on this task
2. **Diff since prior review** — `git diff <prior_examined_commit>...<current_submission_commit>` — what changed in the fix cycle, which is what the reviewer needs to focus on
3. **Incremental diff per submission** — diff between successive submission_linkage commits on the same task, showing what changed between resubmissions

## Dependencies

Requires these from @plan-task-activity-timeline to be implemented first:
- @task-implement-activity-display — the timeline section in task get
- @submission-linkage-merge-target (AC on @portable-task-submission-linkage) — upstream_ref populated
- @task-review-examined-commit — examined_commit stored on review records

## Design Questions to Resolve

- Should diffs be shown inline in the timeline or as a separate section?
- Should `--activity` always include diffs, or should there be a `--diff` flag?
- Performance: computing diffs shells out to git. Cache? Lazy compute? Only on explicit flag?
- How to handle large diffs — stat-only by default, full diff on request?
- Should the daemon API expose diff computation for the web UI?

## Specs

```yaml
- title: Activity Timeline Diff Summaries
  slug: activity-diff-summaries
  type: feature
  parent: "@task-activity-timeline"
  description: |
    Enrich activity timeline entries at submission points with diff
    summaries showing what changed relative to the merge target and
    since the prior review. Needs refinement — AC shapes below are
    directional, not final.
  acceptance_criteria:
    - id: ac-1
      given: |
        a task has submission linkage with upstream_ref and commit
      when: |
        the activity timeline renders a submission entry
      then: |
        a diff stat summary is available showing scope of changes
        relative to the merge target
    - id: ac-2
      given: |
        a prior review record with examined_commit exists
      when: |
        the activity timeline renders a resubmission entry
      then: |
        an incremental diff stat summary is available showing what
        changed since the prior review
    - id: ac-3
      given: |
        diff computation is requested
      when: |
        the merge target or prior examined commit is unreachable
      then: |
        the diff is gracefully omitted with a note rather than erroring
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement diff summaries in activity timeline
  slug: task-activity-diff-summaries
  priority: 3
  tags: [cli, tasks]
  spec_ref: "@activity-diff-summaries"
  depends_on:
    - "@task-implement-activity-display"
    - "@task-review-examined-commit"
  description: |
    Add diff stat summaries to activity timeline submission entries.
    Needs detailed design — this is a placeholder task.
```

## Implementation Notes

Deferred from the main activity timeline plan. Revisit once the core
timeline, review lifecycle, and submission linkage changes are in place.
The design questions above should be resolved before refining this plan.
