# Auto-close stale active sessions

## Specs

```yaml
- title: Stale Active Session Cleanup
  slug: session-stale-cleanup
  type: feature
  parent: "@session-events"
  description: |
    Detect and close stale active sessions so maintenance commands like
    session compaction can proceed without manual cleanup. The cleanup path
    must be safe, auditable, and previewable before mutation.
  traits:
    - trait-json-output
    - trait-dry-run
    - trait-semantic-exit-codes
    - trait-shadow-commit
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        one or more sessions are currently in status "active"
      when: |
        user runs "kspec session stale close --dry-run"
      then: |
        command reports which sessions would be marked abandoned and includes
        per-session reasons without modifying any session files
    - id: ac-2
      given: |
        stale active sessions match the configured criteria
      when: |
        user runs "kspec session stale close"
      then: |
        command marks only matching sessions abandoned and leaves all other
        session statuses unchanged
    - id: ac-3
      given: |
        no active sessions match the stale criteria
      when: |
        command executes
      then: |
        command exits successfully and reports zero sessions changed
    - id: ac-4
      given: |
        command runs in --all mode against many sessions
      when: |
        execution completes
      then: |
        output includes totals for candidates, changed sessions, skipped
        sessions, and failures in both human and JSON modes

- title: Stale Session Candidate Criteria
  slug: session-stale-criteria
  type: requirement
  parent: "@session-stale-cleanup"
  description: |
    Candidate selection is deterministic and based on explicit time criteria,
    not guessed session age.
  acceptance_criteria:
    - id: ac-1
      given: |
        an active session has a most-recent event timestamp older than the
        inactivity threshold
      when: |
        stale candidates are computed
      then: |
        the session is eligible for closure if it also satisfies the age
        threshold
    - id: ac-2
      given: |
        an active session has no events in events.jsonl
      when: |
        stale candidates are computed
      then: |
        started_at is used as the last-activity fallback timestamp
    - id: ac-3
      given: |
        user provides both --older-than and --inactive-for criteria
      when: |
        candidates are filtered
      then: |
        both criteria are applied with AND logic
    - id: ac-4
      given: |
        user provides an invalid time specification
      when: |
        command validates input
      then: |
        command returns usage error with guidance on accepted formats

- title: Auto-abandon Metadata and Audit Trail
  slug: session-stale-close-metadata
  type: requirement
  parent: "@session-stale-cleanup"
  description: |
    Automatic closure must preserve auditability so operators can understand
    why and when a session was auto-abandoned.
  acceptance_criteria:
    - id: ac-1
      given: |
        a stale active session is selected for closure
      when: |
        closure is applied
      then: |
        session metadata is updated to status "abandoned" and ended_at is set
        to an ISO 8601 timestamp
    - id: ac-2
      given: |
        a stale active session is auto-closed
      when: |
        close metadata is written
      then: |
        close_reason includes an "auto-abandoned" marker and the criteria
        used for selection
    - id: ac-3
      given: |
        multiple sessions are auto-closed in one command
      when: |
        persistence completes
      then: |
        all metadata updates are captured in one shadow commit with a
        command-specific commit message
```

## Tasks

derive_from_specs: true

## Implementation Notes

Use existing session summary and last-event helpers in src/sessions/store.ts to avoid duplicate log scanning.
Prefer the same time-spec parsing style already used by session log and workflow prune commands.
