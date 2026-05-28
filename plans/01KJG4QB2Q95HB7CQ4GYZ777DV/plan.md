# Session Compact Command

## Context

PR #578 added blob externalization guardrails to `appendEvent`, but they only apply to new events. The project has 87 sessions totaling ~820 MB of `events.jsonl` data, with the largest single session (01KJF8SY) at 272 MB. These pre-existing oversized events inflate the shadow branch and every clone/sync. A retroactive compact command reprocesses existing events through the same externalization pipeline.

Existing inbox item `01KGWQ2T` proposed stats compilation + pruning, but blob externalization is better — it preserves full auditability while reducing JSONL line sizes.

## Specs

```yaml
- title: Session Event Compaction
  slug: session-compact
  type: feature
  parent: "@session-events"
  description: |
    Retroactive compaction of session event logs. Rewrites events.jsonl
    by running existing events through the blob externalization pipeline,
    replacing oversized inline payloads with blob pointers. Preserves
    full auditability — no data is lost, payloads are moved to blob files.
  traits:
    - "@trait-semantic-exit-codes"
    - "@trait-dry-run"
    - "@trait-shadow-commit"
    - "@trait-json-output"
  acceptance_criteria:
    - id: ac-1
      given: |
        A session has events.jsonl with oversized inline payloads
      when: |
        kspec session compact <session-id> is run
      then: |
        Each event's data is processed through the blob externalization
        pipeline and oversized fields are written to blobs/ as blob files
    - id: ac-2
      given: |
        Events have been externalized to blobs
      when: |
        The compacted events are persisted
      then: |
        events.jsonl is atomically replaced using temp-file-then-rename
        so a crash mid-compact does not corrupt the event log
    - id: ac-3
      given: |
        A session has already been compacted (all payloads are blob pointers
        or below thresholds)
      when: |
        kspec session compact <session-id> is run again
      then: |
        No new blobs are created and events.jsonl content is unchanged
    - id: ac-4
      given: |
        The target session has status "active"
      when: |
        kspec session compact <session-id> is run
      then: |
        The command refuses with an error and non-zero exit code
        because compacting an actively-written session risks data loss
    - id: ac-5
      given: |
        The user wants to compact all eligible sessions
      when: |
        kspec session compact --all is run
      then: |
        All non-active sessions are processed sequentially with
        per-session progress output
    - id: ac-6
      given: |
        A compaction completes (single or --all)
      when: |
        Results are reported
      then: |
        Output shows events processed, blobs created, bytes before,
        bytes after, and bytes reclaimed
    - id: ac-7
      given: |
        A session directory has empty or missing events.jsonl
      when: |
        kspec session compact <session-id> is run
      then: |
        The command exits cleanly reporting nothing to compact
    - id: ac-8
      given: |
        A blob write or temp-file rename fails during compaction
      when: |
        The error is caught
      then: |
        The original events.jsonl is preserved unchanged and the
        command exits with a non-zero error code
```

## Tasks

derive_from_specs: true

## Implementation Notes

**Key reuse points:**
- `externalizeOversizedPayloads` and `createBlobPointer` in `src/sessions/store.ts` — currently private. Wrap in a new public `compactSessionEvents(specDir, sessionId)` function rather than exporting internals.
- `readEvents()` for reading existing events (note: loads all into memory — acceptable for current session sizes, largest is 272 MB / 1841 lines)
- `isSessionBlobPointer` already handles idempotency (early return in externalization)
- Atomic write pattern from `writeBudgetAtomic` (write to `.{pid}.tmp`, then `rename`)

**Two-stage externalization (must replicate both):**
1. Field-level: `externalizeOversizedPayloads` targets specific key paths (rawOutput, toolResponse stdout/stderr, chunk text)
2. Line-level: if JSON line still exceeds `EVENT_LINE_MAX_BYTES` (256 KB) after field externalization, externalize entire `data` payload as single blob

**Re-validate each event through `SessionEventSchema.parse()` after externalization** (same as `appendEvent` does).

**Implementation approach:**
1. Add `compactSessionEvents(specDir, sessionId): Promise<CompactResult>` to `store.ts`
2. Add `session compact` CLI command in new `src/cli/commands/session/compact.ts`
3. Register in `commands.ts` with `markMutating()`
4. Handle `--all` by iterating `getAllSessionLogSummaries()`, skipping active sessions
5. Single shadow commit after all compaction completes (not per-session)
6. Check session status via `readSessionMetadata()` — refuse active sessions

**Rollback strategy:** Git history on shadow branch serves as implicit backup. The atomic rename ensures no partial writes.

**Git size note:** Rewriting events.jsonl means git stores both old and new versions. Net shadow branch size may increase temporarily until `git gc`. The JSONL shrinks but blob files are added. Long-term net effect is positive for clone/sync because JSONL lines stay bounded.

**Files to modify:**
- `src/sessions/store.ts` — add `compactSessionEvents()` wrapping existing internals
- `src/cli/commands/session/compact.ts` — new file, CLI action
- `src/cli/commands/session/commands.ts` — register command
- `tests/session-compact.test.ts` — new file, tests

**Supersedes inbox item:** `01KGWQ2T` (session log compaction)
