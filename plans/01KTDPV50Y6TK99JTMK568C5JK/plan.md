# Dispatch Canonical Task Identity Plan

## Specs

```yaml
- title: Dispatch Canonical Task Identity
  slug: dispatch-canonical-task-identity
  type: requirement
  parent: "@agent-dispatch-engine"
  description: |
    Dispatch treats the resolved full task ULID as the authoritative identity for every task-scoped runtime decision. Human-readable task refs, slug refs, and unique ULID-prefix refs may be accepted as command/display aliases, but they do not define scheduler, active invocation, in-flight, workspace, cleanup, registry, or session identity.

    This requirement intentionally owns the new alias/canonicalization behavior instead of adding ACs directly to already-implemented broad specs. It relates to the existing dispatch, workspace, event-payload, and reference-resolution contracts that it tightens.
  acceptance_criteria:
    - id: ac-event-ingress-canonicalizes-task-identity
      given: |
        A task-scoped dispatch event, watcher change, bootstrap candidate, reconciliation candidate, retry candidate, or post-invocation candidate identifies a task by full task ULID, unique task ULID prefix, slug ref, loaded task object, or a task_id plus a task_ref that resolves to the same task
      when: |
        The dispatch runtime accepts that input for scheduling or lifecycle processing
      then: |
        The accepted candidate is associated with the resolved full task ULID as its canonical task identity, and any raw/display task ref is kept separate from that identity for prompts, logs, status text, or CLI command text only.

    - id: ac-invalid-or-mismatched-task-ref-rejected
      given: |
        A task-scoped dispatch input identifies a task only by an unresolved or ambiguous task ref, or includes a task_id plus a task_ref that resolves to a different task than the task_id
      when: |
        The dispatch runtime normalizes the input before scheduling, workspace provisioning, cleanup protection, session creation, or event emission
      then: |
        The input is rejected or skipped with an operator-actionable diagnostic identifying the provided task_id when present, the provided task_ref when present, the source path, and the resolution outcome; no queue entry, active invocation, in-flight marker, workspace record, cleanup protection entry, session metadata, or invocation/session payload is created using the invalid or mismatched raw ref as task identity.

    - id: ac-missing-display-ref-normalizes-from-task-id
      given: |
        A dispatch event includes a valid full task_id and omits task_ref
      when: |
        The dispatch runtime accepts the event
      then: |
        The runtime uses the provided task_id as the canonical task identity, derives `@<task_id>` as the default display ref when no better display ref is available, and does not reject the event solely because task_ref is absent.

    - id: ac-scheduler-alias-dedupe
      given: |
        Refs such as `@task-slug`, `@<full-task-ulid>`, and a unique `@<task-ulid-prefix>` all resolve to the same task
      when: |
        Bootstrap, file-watcher, API-event, periodic reconciliation, post-invocation reconciliation, retry wake-up, or queue-drain paths evaluate active, queued, deferred, or in-flight dispatch work for that task
      then: |
        Scheduler dedupe treats those refs as one task and does not enqueue or spawn duplicate work for the same agent and canonical task identity.

    - id: ac-cross-agent-exclusivity-uses-canonical-task
      given: |
        One agent has an active or in-flight invocation for a task under one valid task ref alias
        And another agent has a queued or newly eligible candidate for the same task under another valid task ref alias
      when: |
        The scheduler selects the next invocation
      then: |
        The second candidate remains queued or is deferred until the active or in-flight invocation for the canonical task identity completes, and before any later spawn it is subject to the same stale-candidate checks as any other queued entry.

    - id: ac-workspace-registry-canonical-task-identity
      given: |
        A non-closed dispatch workspace record exists for a task using any historical or display task ref that resolves to that task
      when: |
        Provisioning, reconciliation, validation, cleanup, or lookup evaluates workspace state for the same task using a different valid alias
      then: |
        The registry compares records by canonical task ULID, reuses the existing non-closed workspace record when appropriate, and rejects or reports more than one non-closed workspace record for the same canonical task identity.

    - id: ac-historical-workspace-records-normalize-or-stale
      given: |
        Existing dispatch workspace registry records were persisted before canonical task identity was recorded separately from task_ref
      when: |
        Workspace registry loading, validation, provisioning, or reconciliation encounters those records
      then: |
        Records whose historical task_ref still resolves to a task are backfilled or interpreted with that task's canonical ULID identity; records whose historical task_ref cannot resolve are marked stale or invalid with recovery guidance and must not cause duplicate workspace provisioning for any resolvable task alias.

    - id: ac-workspace-lineage-stable-across-aliases
      given: |
        A task has a canonical dispatch branch or workspace lineage
      when: |
        A worker, reviewer, fix-cycle worker, cleanup pass, or artifact reconciliation refers to that task by slug, full ULID, unique ULID prefix, or after the task's primary slug changes
      then: |
        The existing branch/workspace lineage is selected by canonical task ULID; the dispatcher does not create a new workspace id, branch lineage, worktree path, or workspace record solely because the display ref changed.

    - id: ac-cleanup-protection-uses-canonical-task
      given: |
        A task has active, in-flight, provisioning, stale, or non-closed workspace state under one valid task ref alias
      when: |
        Workspace artifact cleanup evaluates branches, worktrees, reviewer snapshots, root directories, or metadata-backed artifacts that refer to the same task by another valid alias
      then: |
        Cleanup protection resolves both aliases to the same canonical task identity and preserves artifacts that are protected by active, in-flight, provisioning, stale/recoverable, or non-closed registry state.

    - id: ac-session-and-event-payloads-separate-id-from-display-ref
      given: |
        A task-scoped invocation or session lifecycle event is emitted or persisted
      when: |
        The payload or session metadata includes task identity fields
      then: |
        It includes the canonical full task ULID identity separately from any display task ref, and downstream dispatch consumers use the canonical task id for identity decisions rather than the display ref.

    - id: ac-alias-canonicalization-diagnostics
      given: |
        The scheduler, workspace registry, event ingress, or cleanup protection discards, defers, reuses, rejects, or preserves state because another alias already represents the same canonical task
      when: |
        Diagnostics or status output identify the decision
      then: |
        They include the canonical task ULID when known, the original raw task ref when available, the agent id or workspace id when applicable, and the exclusion, reuse, rejection, or preservation reason.
```

## Tasks

derive_from_specs: false

```yaml
- title: Canonicalize dispatch task identity across scheduler and workspaces
  slug: task-canonicalize-dispatch-task-identity
  type: task
  spec_ref: "@dispatch-canonical-task-identity"
  priority: 1
  tags: [dispatch, identity, scheduler, workspaces, regression]
  description: |
    Implement `@dispatch-canonical-task-identity` so task aliases never create duplicate dispatch invocations, fork workspace identity, or bypass cleanup protection.

    Covers:
    - @dispatch-canonical-task-identity ac-event-ingress-canonicalizes-task-identity
    - @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
    - @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
    - @dispatch-canonical-task-identity ac-scheduler-alias-dedupe
    - @dispatch-canonical-task-identity ac-cross-agent-exclusivity-uses-canonical-task
    - @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
    - @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
    - @dispatch-canonical-task-identity ac-workspace-lineage-stable-across-aliases
    - @dispatch-canonical-task-identity ac-cleanup-protection-uses-canonical-task
    - @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
    - @dispatch-canonical-task-identity ac-alias-canonicalization-diagnostics

    Scope:
    - Add a shared dispatch task identity normalization path that resolves task-scoped inputs to a full task ULID and canonical ref (`@<task-ulid>`), while retaining the original/display ref separately.
    - Normalize task identity at dispatch ingress for daemon `/api/agent/events`, CLI-emitted dispatch events, file-watcher changes, bootstrap/reconciliation synthetic changes, and any post-invocation/retry queue paths that construct task candidates.
    - Update dispatch scheduler state so active invocation details, in-flight spawn markers, queued/retry candidates, same-agent dedupe, cross-agent per-task exclusivity, coalescing, cleanup protection, and scheduler diagnostics use canonical task identity for task equality.
    - Update workspace provisioning and registry lookup/validation so workspace ids, short task ids, active workspace uniqueness, non-closed workspace lookup, foreign-open-workspace detection, artifact cleanup protection, and branch/worktree reuse are keyed by canonical task ULID rather than arbitrary raw task refs.
    - Backfill or interpret resolvable historical workspace records with canonical task ULID identity; classify unresolvable historical task_ref records as stale or invalid with recovery guidance and ensure they do not cause duplicate workspace provisioning for resolvable aliases.
    - Preserve human/operator readability by retaining display refs in prompts, logs, notes, and CLI command targeting where useful, but do not use display refs as identity keys.
    - Reject or skip unresolved, ambiguous, or mismatched task refs before scheduling/provisioning/cleanup/session creation; valid task_id-only events normalize to `@<task_id>` as the default display ref.
    - Preserve existing valid behavior for canonical `@ULID` task refs, slug task refs, unique short-ULID task refs, worker/reviewer/fix-cycle dispatch, existing workspace registry records, and submission-linkage branch adoption.

    Required tests:
    - For ac-event-ingress-canonicalizes-task-identity and ac-missing-display-ref-normalizes-from-task-id: add ingress coverage showing valid `task_id` + slug ref, valid `task_id` with no ref, watcher/reconcile canonical refs, and unique prefix refs all produce canonical task identity with display ref kept separately.
    - For ac-invalid-or-mismatched-task-ref-rejected: add coverage for unresolved single task_ref, ambiguous single task_ref, and `task_id` plus different-task task_ref; verify diagnostics and that no queue, active, in-flight, workspace, cleanup, session, or lifecycle payload state is created using the invalid raw ref as task identity.
    - For ac-scheduler-alias-dedupe: add dispatch-engine regression coverage proving an active reviewer recorded under a slug ref prevents periodic or post-invocation reconciliation from spawning a second reviewer for the same task under the canonical ULID ref, and add same-agent active/queued/in-flight dedupe coverage for slug, full ULID, and unique short-ULID aliases of the same task.
    - For ac-cross-agent-exclusivity-uses-canonical-task: add coverage proving a worker active or in-flight under one alias defers a reviewer candidate under another alias until the canonical task's active/in-flight invocation completes and stale checks pass.
    - For ac-workspace-registry-canonical-task-identity and ac-historical-workspace-records-normalize-or-stale: add registry/provisioning coverage proving an existing non-closed workspace record for one alias is reused by another alias, multiple non-closed records for aliases of the same canonical task are rejected or reported, resolvable historical records are backfilled/interpreted canonically, and unresolvable historical records become stale/invalid with recovery guidance.
    - For ac-workspace-lineage-stable-across-aliases: add workspace identity/naming coverage proving slug, full-ULID, unique-prefix, and changed-primary-slug references do not create different workspace ids, branch lineages, worktree paths, or workspace records for the same task.
    - For ac-cleanup-protection-uses-canonical-task: add artifact cleanup coverage proving active, in-flight, provisioning, stale/recoverable, and non-closed registry state under one alias protects artifacts discovered under another alias.
    - For ac-session-and-event-payloads-separate-id-from-display-ref: add invocation/session lifecycle coverage proving canonical task id/full ULID and display task ref are separate fields and identity consumers use the canonical field.
    - For ac-alias-canonicalization-diagnostics: add diagnostics/status coverage proving discard/defer/reuse/reject/preserve decisions include canonical task ULID when known, original raw ref when available, agent/workspace id when applicable, and the decision reason.

    Verification gates:
    - npm run format:check
    - npm run lint -- --quiet
    - focused oxlint for touched source and test files
    - npm run typecheck
    - focused dispatch/workspace tests, including agent-dispatch-engine, canonical-task-workspace-contract, dispatch-artifact-protection, and daemon dispatch route tests if touched
    - full npm test if focused suites pass
    - KSPEC_NO_DAEMON=1 kspec validate --schema --warnings-ok
    - KSPEC_NO_DAEMON=1 kspec validate --refs --warnings-ok
    - KSPEC_NO_DAEMON=1 kspec validate --alignment --completeness --warnings-ok

    Out of scope:
    - Do not stop, restart, or reconfigure the live daemon.
    - Do not cancel or stop existing duplicate sessions as part of this implementation task.
    - Do not change task slug resolution semantics outside dispatch identity normalization.
    - Do not remove slug/display refs from prompts, logs, status output, or CLI-facing text when they are not used as identity keys.
    - Do not change runner/adapters, ACP invocation semantics, or worker/reviewer prompt semantics except where task identity fields are carried separately from display refs.
    - Do not perform unrelated workspace cleanup or delete historical workspace records unless required to migrate/validate canonical task identity safely.
```

## Post-Derive Metadata Updates

Current plan derivation does not materialize spec tags, spec `relates_to`, or task automation. After deriving this approved plan, run these exact updates:

```bash
KSPEC_NO_DAEMON=1 kspec item set @dispatch-canonical-task-identity --tag dispatch identity scheduler workspaces
KSPEC_NO_DAEMON=1 kspec item set @dispatch-canonical-task-identity --relates-to @dispatch-workspace-registry
KSPEC_NO_DAEMON=1 kspec item set @dispatch-canonical-task-identity --relates-to @canonical-task-workspace-contract
KSPEC_NO_DAEMON=1 kspec item set @dispatch-canonical-task-identity --relates-to @dispatch-scheduling-priority-model
KSPEC_NO_DAEMON=1 kspec item set @dispatch-canonical-task-identity --relates-to @dispatch-event-payload
KSPEC_NO_DAEMON=1 kspec item set @dispatch-canonical-task-identity --relates-to @reference-system
KSPEC_NO_DAEMON=1 kspec item set @dispatch-canonical-task-identity --relates-to @slug-resolution
KSPEC_NO_DAEMON=1 kspec task set @task-canonicalize-dispatch-task-identity --automation eligible
```
