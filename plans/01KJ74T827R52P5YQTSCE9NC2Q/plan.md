# Session Start Output Redesign

## Specs

```yaml
- title: Session Start Dependency Display
  slug: session-start-unlocks
  type: requirement
  parent: "@cmd-session-start"
  description: |
    Ready and blocked tasks show how many other tasks depend on them via
    an "unlocks N" annotation. Helps prioritize work that unblocks the most
    downstream tasks. Only shown when N > 0.
  acceptance_criteria:
    - id: ac-unlocks-shown
      given: |
        a ready or blocked task has N>0 pending tasks in its dependents
      when: |
        that task renders in session output
      then: |
        shows "unlocks N" annotation next to the task
    - id: ac-unlocks-omit-zero
      given: |
        a task has zero dependents
      when: |
        that task renders in session output
      then: |
        no unlocks annotation shown
    - id: ac-unlocks-unresolvable
      given: |
        a depends_on ref cannot be resolved by ReferenceIndex
      when: |
        unlocks count is computed
      then: |
        unresolvable ref is silently skipped without error
  implementation_notes: |
    Compute reverse dependency map over non-completed tasks.
    Use pattern from ralph.ts:601 for slug resolution: task.slugs[0] fallback to short ULID.
    Store in computed.task_unlocks as Record<string, number> keyed by ref (short ULID).

- title: Session Start Activity Timeline
  slug: session-start-activity-timeline
  type: requirement
  parent: "@cmd-session-start"
  description: |
    Merge recently completed tasks and git commits into a single
    chronological "Recent Activity" timeline. Commits matched to tasks
    via Task: @slug trailer in commit body. Deduplicates linked entries.
    Replaces separate "Recently Completed" and "Recent Commits" sections
    in human output. Raw arrays preserved in JSON.
  depends_on:
    - "@session-start-unlocks"
  acceptance_criteria:
    - id: ac-activity-merge
      given: |
        completed tasks and git commits exist
      when: |
        recent activity section renders
      then: |
        both sources appear in a single chronological list
    - id: ac-activity-trailer-link
      given: |
        a commit has Task: @slug trailer in its body
      when: |
        recent activity renders
      then: |
        that commit shows linked task info alongside it
    - id: ac-activity-sort
      given: |
        activity items have mixed timestamps
      when: |
        timeline renders
      then: |
        items sorted most recent first
    - id: ac-activity-dedup
      given: |
        a commit is linked to a completed task via trailer
      when: |
        timeline renders
      then: |
        shown as single combined entry, not two separate entries
    - id: ac-activity-no-git
      given: |
        --no-git flag is passed
      when: |
        activity timeline renders
      then: |
        only task completions shown, no commit entries
  implementation_notes: |
    Requires extending git.ts getRecentCommits() to include commit body.
    Current format uses %s (subject only). Change to NUL-delimited format
    with %B or %(trailers:key=Task) to access trailers.
    Parse Task: @slug trailer with regex: /Task:\s*@([\w-]+)/
    Add body and task_ref fields to CommitSummary interface.

- title: Session Start Inbox Triage Awareness
  slug: session-start-inbox-triage
  type: requirement
  parent: "@cmd-session-start"
  description: |
    Inbox section shows triage-aware statistics instead of raw item count.
    Cross-references inbox items with triage records to distinguish
    untriaged items from deferred/acted-on items. Primer shows stat line,
    full mode shows untriaged items.
  acceptance_criteria:
    - id: ac-inbox-stat-line
      given: |
        primer mode and inbox has items with mixed triage status
      when: |
        inbox section renders
      then: |
        shows stat line with untriaged count, deferred count, and total
    - id: ac-inbox-full-list
      given: |
        --full mode and untriaged items exist
      when: |
        inbox section renders
      then: |
        up to 20 untriaged items listed plus stat line
    - id: ac-inbox-all-triaged
      given: |
        all inbox items have triage records
      when: |
        primer renders
      then: |
        stat line shows 0 untriaged
    - id: ac-inbox-untriaged-def
      given: |
        an inbox item has no triage record in project.triage.yaml
      when: |
        triage status computed
      then: |
        item is counted as untriaged
  implementation_notes: |
    Import loadTriageRecords() from src/parser/yaml.ts (already exported).
    Join on triage.inbox_ref to inbox._ulid.
    Untriaged = no triage record exists for that inbox ULID.
    Deferred = triage record exists with action=defer.
    Add triaged (boolean) and triage_action (string|null) to InboxSummary.

- title: Session Start Computed JSON Fields
  slug: session-start-computed-json
  type: requirement
  parent: "@cmd-session-start"
  description: |
    JSON output includes a computed key with derived data: inbox triage
    counts, task unlocks map, and merged activity timeline. Raw source
    arrays (recently_completed, recent_commits) preserved unchanged.
    Computed fields are additive - no existing JSON fields modified.
  depends_on:
    - "@session-start-unlocks"
    - "@session-start-activity-timeline"
    - "@session-start-inbox-triage"
  acceptance_criteria:
    - id: ac-computed-inbox
      given: |
        --json flag used
      when: |
        JSON output renders
      then: |
        computed.inbox_untriaged_count, computed.inbox_deferred_count, and computed.inbox_total are present
    - id: ac-computed-unlocks
      given: |
        --json flag used
      when: |
        JSON output renders
      then: |
        computed.task_unlocks map (ref to count) present for tasks with dependents
    - id: ac-computed-activity
      given: |
        --json flag used
      when: |
        JSON output renders
      then: |
        computed.recent_activity timeline array present with merged entries
```

## Tasks

derive_from_specs: true
