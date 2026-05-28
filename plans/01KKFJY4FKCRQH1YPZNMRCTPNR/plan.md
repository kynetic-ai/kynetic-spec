# Review Records and Gates

This plan defines first-party review records as durable kspec artifacts for
plans, task work, and other reviewable subjects. The first wave focuses on the
canonical data model and workflow contracts needed to capture review feedback,
check evidence, verdicts, and resolution history without depending on GitHub
PRs as the source of truth.

Reviews use git-backed compare semantics for code subjects and per-entity
content hashing for shadow-branch subjects. v1 covers committed code only —
uncommitted worktree review is explicitly out of scope.

This plan is intentionally scoped to the record model and integration
contracts. It does not try to deliver full hosted-review UI parity or replace
the existing task lifecycle in the same step.

## Context

Today kspec has review-related task states (`pending_review`, `needs_work`) and
optional `review_url`, but no native review artifact. Reviews mainly live in
GitHub PRs or ad hoc task notes. That leaves no first-party record for:

- local review without a PR
- line-targeted comments on code or structured sections in plans/specs
- durable check runs and approval state
- a consistent review history across different artifact types

## Scope

This plan should cover:

- first-party review records with stable subject identity
- explicit storage and referencing rules for review entities
- git-backed compare semantics for code subjects (base + head + merge base)
- per-entity content hashing for shadow-branch subject staleness
- threaded comments with general and targeted anchors including diff-side
  semantics for code
- recorded checks and normalized gate evaluation with compare binding
- reviewer verdicts with compare binding and staleness detection
- blocking thread semantics (blocker vs non-blocking)
- explicit append-only event log for audit history
- separate lifecycle state from computed disposition and gate state
- explicit integration with task review states and compatibility fields
- a minimal CLI surface so agents and humans can create, inspect, and update
  review records without direct file mutation

This plan should not yet cover:

- a full web review experience or GitHub-style UI parity
- provider-specific sync beyond storing external identities and links
- replacing `pending_review` or `needs_work` as the task workflow signal
- review of uncommitted worktree state (v1 is committed code only)

## Specs

```yaml
- title: Review Record Core Model
  slug: review-record-core-model
  type: feature
  parent: "@core"
  description: |
    kspec stores review records as first-party artifacts with a typed subject,
    separate lifecycle and disposition states, authorship, timestamps, an
    append-only event log, and links to the object under review.
  acceptance_criteria:
    - id: ac-1
      given: |
        A review is created for a plan, task, committed code change, or other
        supported artifact
      when: |
        The review record is stored
      then: |
        The record captures subject binding, lifecycle state, author,
        timestamps, and an empty event log in first-party kspec metadata
    - id: ac-2
      given: |
        A review progresses through work
      when: |
        Any state-bearing mutation occurs
      then: |
        The review record has separate lifecycle_state (draft, open, closed,
        archived) and computed disposition (pending, approved,
        changes_requested) fields rather than collapsing lifecycle and outcome
        into one status enum
    - id: ac-3
      given: |
        A review references external systems such as GitHub
      when: |
        External identifiers or URLs exist
      then: |
        The review record stores those links without making them the source of
        truth for local review state
    - id: ac-4
      given: |
        Any mutation occurs on a review record including status changes,
        verdict submissions, thread resolution, check additions, close, and
        archive actions
      when: |
        The mutation is persisted
      then: |
        An append-only event is recorded with event type, actor, timestamp,
        and relevant payload so the full review history can be reconstructed
        from the event log

- title: Review Record Storage and Identity
  slug: review-record-storage-and-identity
  type: requirement
  parent: "@review-record-core-model"
  description: |
    Review records are stored as a first-party top-level entity with stable
    references so they can be addressed through normal kspec lookup and audit
    flows without being modeled as spec items.
  acceptance_criteria:
    - id: ac-1
      given: |
        A review record is created
      when: |
        It is persisted in kspec metadata
      then: |
        The record is stored in dedicated first-party review storage rather
        than being embedded ad hoc under plans, tasks, or module files
    - id: ac-2
      given: |
        A review record exists
      when: |
        It is referenced through kspec commands
      then: |
        The review has a stable ULID-backed identity and can be addressed by
        an @review ref using the shared reference system
    - id: ac-3
      given: |
        Review records are stored in the shadow branch
      when: |
        A review mutation is committed
      then: |
        The review data lives in a single dedicated file per project rather
        than being split across multiple files or embedded inside other entity
        files, so each shadow branch commit touches one predictable path

- title: Review Subject Bindings
  slug: review-subject-bindings
  type: requirement
  parent: "@review-record-core-model"
  description: |
    Review records identify what is under review using git-backed compare
    semantics for code subjects and per-entity content hashing for shadow
    branch subjects. v1 covers committed code only.
  acceptance_criteria:
    - id: ac-1
      given: |
        A review is created for a plan, task, spec, committed code, or other
        supported artifact
      when: |
        The subject binding is stored
      then: |
        The record captures subject type plus a stable local ref or external
        identity that can be used to reopen the review later
    - id: ac-2
      given: |
        A review subject has both a local kspec ref and an external identity
      when: |
        The review record is stored
      then: |
        The local ref remains authoritative while external identifiers are
        kept as linkage metadata
    - id: ac-3
      given: |
        A review targets committed code
      when: |
        The subject binding is stored
      then: |
        The record stores base_commit, head_commit, and optionally
        merge_base_commit as the frozen compare context, with branch names
        stored only as optional metadata and never as the authoritative
        identity
    - id: ac-4
      given: |
        A review targets a shadow-branch entity such as a plan, spec, or task
      when: |
        The subject binding is stored
      then: |
        The record stores the shadow branch commit plus a per-entity content
        hash so review mutations on the same shadow branch do not
        self-invalidate the subject freshness check
    - id: ac-5
      given: |
        The reviewed subject has changed since the review was created
      when: |
        Staleness is evaluated after a review refresh updates the subject
        version
      then: |
        Verdicts and checks whose applies_to_version does not match the
        refreshed subject version are identified as stale, and for
        shadow-branch subjects the entity content hash is compared rather
        than shadow branch HEAD which would self-invalidate on every review
        mutation

- title: Review Comment Threads and Anchors
  slug: review-comment-threads-and-anchors
  type: requirement
  parent: "@review-record-core-model"
  description: |
    Review comments support both general feedback and threaded targeted
    anchors. Code anchors use diff-side semantics (base or head side, file
    path, line range, commit). Structured anchors target sections or fields
    in plans, specs, and other artifacts. Each thread has a ULID-based
    identifier and a kind that distinguishes blocking from non-blocking
    feedback.
  acceptance_criteria:
    - id: ac-1
      given: |
        A reviewer wants to leave general feedback
      when: |
        A comment is created without a target anchor
      then: |
        The comment is stored as a general review thread entry with a ULID
        thread identifier, author, kind, and timestamps
    - id: ac-2
      given: |
        A reviewer wants to comment on code
      when: |
        The comment targets a file and line or range
      then: |
        The review record stores a code anchor with path, side (base or
        head), line_start, line_end, and commit so the comment can be
        rendered against the correct diff context
    - id: ac-3
      given: |
        A reviewer wants to comment on a plan, spec, or other structured
        artifact
      when: |
        The comment targets a section, field, or logical anchor
      then: |
        The review record stores the structured anchor and renders it as
        targeted feedback on that artifact
    - id: ac-4
      given: |
        A reviewer or author replies to an existing review comment
      when: |
        The reply is stored
      then: |
        The conversation is preserved as a durable thread rather than
        isolated standalone comments
    - id: ac-5
      given: |
        A reviewer creates a thread
      when: |
        The thread kind is specified or defaulted
      then: |
        The thread stores a kind field that distinguishes at least blocker,
        question, and nit so the system can determine which unresolved
        threads should block approval and which should not
    - id: ac-6
      given: |
        Unresolved threads exist on a review
      when: |
        The review disposition is computed
      then: |
        Only threads with kind blocker prevent the review from being approved
        while unresolved nit and question threads do not block

- title: Review Checks and Gate Evaluation
  slug: review-checks-and-gate-evaluation
  type: requirement
  parent: "@review-record-core-model"
  description: |
    Reviews can include recorded checks and derived gate state such as test
    runs, local verification, CI runs, or manual attestations. Each check
    records the compare context it applies to so gate evaluation uses only
    checks that match the current reviewed state.
  acceptance_criteria:
    - id: ac-1
      given: |
        A review requires tests, static checks, or other gates
      when: |
        Evidence is recorded
      then: |
        The review stores check records with name, status, timestamps,
        runner, required flag, evidence payload or link, and the
        applies_to_version context (base_commit and head_commit) identifying
        which reviewed state the check ran against
    - id: ac-2
      given: |
        A project has no external CI for a reviewable artifact
      when: |
        An agent or human performs verification locally
      then: |
        The review record can store that verification as a first-party check
        run rather than requiring GitHub Actions
    - id: ac-3
      given: |
        External CI exists
      when: |
        A check run is mirrored into the review record
      then: |
        The local review gate references the external run while preserving
        the normalized local status model
    - id: ac-4
      given: |
        Review policy requires all required gates to pass before approval
      when: |
        An approval is attempted
      then: |
        The system distinguishes required vs informational checks and
        enforces the required ones
    - id: ac-5
      given: |
        Multiple runs exist for the same logical check over the life of a
        review
      when: |
        Gate state is evaluated
      then: |
        Check history is preserved while the current gate decision is
        computed from the latest run whose applies_to_version matches the
        current head_commit
    - id: ac-6
      given: |
        The reviewed subject has been updated with new commits since the last
        check run
      when: |
        Gate state is evaluated
      then: |
        Checks whose applies_to_version head_commit does not match the subject's current version are treated as stale and do not satisfy required
        gate checks

- title: Review Verdicts and Resolution Lifecycle
  slug: review-verdicts-and-resolution-lifecycle
  type: requirement
  parent: "@review-record-core-model"
  description: |
    Reviews support individual reviewer verdicts, blocking requests for
    change, thread resolution, and iterative re-review cycles without losing
    audit history. Each verdict records the compare context it applies to so
    approvals can be invalidated when the reviewed state changes. Reviewer
    identity is a plain string matching the author convention used by task
    notes and git config (e.g. "user@example.com" or "agent-name").
  acceptance_criteria:
    - id: ac-1
      given: |
        One or more reviewers act on a review
      when: |
        They approve, request changes, or leave non-blocking comments
      then: |
        Their verdicts are recorded with the applies_to_version context
        (base_commit and head_commit) identifying the reviewed state, and
        stored distinctly from the overall review disposition
    - id: ac-2
      given: |
        A targeted review thread results in follow-up work
      when: |
        The issue is addressed
      then: |
        The thread can be marked resolved with timestamp and actor
    - id: ac-3
      given: |
        A review subject goes through multiple cycles
      when: |
        It moves from review to changes requested to re-review
      then: |
        The same review record tracks iteration through its event log and
        compare context updates without losing the audit trail
    - id: ac-4
      given: |
        Required gates are failing, blocking threads are unresolved, or
        blocking change requests remain open
      when: |
        The review disposition is evaluated
      then: |
        The computed disposition cannot be approved while those blockers
        remain open
    - id: ac-5
      given: |
        Multiple reviewers have recorded verdicts on the same review
      when: |
        The aggregate review disposition is computed
      then: |
        The default aggregation rule is that any changes_requested verdict
        whose applies_to_version matches the subject's current version (both base_commit and head_commit
        for code subjects, or content_hash for entity subjects) blocks
        approval and at least one explicit approve verdict matching the
        current head_commit is required for the review to be considered
        approved
    - id: ac-6
      given: |
        Review policy requires more than one approval, distinguishes reviewer
        roles, or allows explicit override authority
      when: |
        The verdict schema is defined
      then: |
        Each verdict record includes a reviewer identity string, a role
        field with a default value, and a timestamp so aggregation queries
        can filter by role and count approvals without a schema redesign
    - id: ac-7
      given: |
        The reviewed subject has been updated since the last approval
      when: |
        The review disposition is computed
      then: |
        Verdicts whose applies_to_version does not match the subject's
        current version are treated as stale and excluded from the
        aggregation computation
    - id: ac-8
      given: |
        A reviewer submits a new verdict on the same review after a
        previous verdict
      when: |
        The aggregate disposition is computed
      then: |
        Only the latest verdict per reviewer whose applies_to_version
        matches the current subject version is considered, so a reviewer
        who requests changes and later approves the same version does not
        remain permanently blocking
    - id: ac-9
      given: |
        A review is no longer active because its subject completed, was
        cancelled, or was superseded
      when: |
        The review lifecycle is finalized
      then: |
        The system supports explicit closed or archived terminal handling
        rather than relying on deletion as the only cleanup path

- title: Review Record Validation
  slug: review-record-validation
  type: requirement
  parent: "@review-record-core-model"
  description: |
    Review entities use explicit schema validation so nested review data is
    checked consistently during parsing, persistence, and command mutation.
  acceptance_criteria:
    - id: ac-1
      given: |
        Review records, threads, checks, verdicts, events, and subject
        bindings are persisted or mutated
      when: |
        The data is validated
      then: |
        The review model is covered by first-party schema validation rather
        than relying on loosely typed metadata blobs
    - id: ac-2
      given: |
        Invalid review data is supplied through import, CLI mutation, or
        future automation paths
      when: |
        Validation fails
      then: |
        The system rejects the mutation with actionable validation feedback

- title: Review Task Lifecycle Integration
  slug: review-task-lifecycle-integration
  type: requirement
  parent: "@review-record-core-model"
  description: |
    Review records integrate with task workflow signals and compatibility
    fields without replacing the lightweight task lifecycle model already
    used by kspec. The integration defines exact synchronization rules for
    when review state drives task transitions and when it does not.
  acceptance_criteria:
    - id: ac-1
      given: |
        A task is in pending_review or needs_work
      when: |
        A review record exists for that task or its code work
      then: |
        The task can link to the active review record via a review_ref field
        while task status remains the lightweight workflow signal
    - id: ac-2
      given: |
        A review is created with a task as its subject
      when: |
        The review add command runs with a task subject
      then: |
        The review_ref field on the task is automatically set to the new
        review record ref
    - id: ac-3
      given: |
        A code review is created with a related task ref
      when: |
        The review add command runs with --related @task-ref
      then: |
        The review stores the task in related_refs and the task's
        review_ref is set to the new review, so code reviews can be
        discovered from task context even when the subject is code not
        a task
    - id: ac-4
      given: |
        A reviewer sets a changes_requested verdict on a task review
      when: |
        The verdict is recorded
      then: |
        The task is automatically transitioned to needs_work if it was in
        pending_review
    - id: ac-5
      given: |
        A task is in pending_review with no active review record or a
        review_ref pointing at a closed review
      when: |
        The task state is rendered or validated
      then: |
        The system surfaces a warning about the inconsistent review linkage
    - id: ac-6
      given: |
        A task-associated review records changes requested and later returns
        for re-review
      when: |
        The task moves between needs_work and pending_review
      then: |
        The review history remains intact instead of being replaced by ad hoc
        task notes
    - id: ac-7
      given: |
        A task or review has an external PR URL or provider identifier
      when: |
        Review state is rendered or audited locally
      then: |
        The external link is treated as compatibility linkage, not the sole
        durable review record

- title: Review CLI Commands
  slug: review-cli-commands
  type: feature
  parent: "@cli"
  traits:
    - trait-shadow-commit
    - trait-error-guidance
  description: |
    kspec exposes a first-party CLI for creating, inspecting, and updating
    review records so agents and humans can use the review system without a
    web UI or direct file edits. The CLI covers the full review lifecycle
    including creation, mutation, lifecycle transitions, subject refresh,
    and task linkage.
  acceptance_criteria:
    - id: ac-1
      given: |
        A user or agent needs to work with review records locally
      when: |
        They use kspec review commands
      then: |
        The CLI provides supported commands for the core review workflow
        rather than requiring direct mutation of stored metadata
    - id: ac-2
      given: |
        Review records are rendered through the CLI
      when: |
        A command prints review data
      then: |
        The output includes the subject, lifecycle state, computed
        disposition, computed gate state, thread state, and external linkage
        needed to understand the review without opening raw storage
    - id: ac-3
      given: |
        A workflow needs to perform multiple review mutations in one atomic
        shadow-branch change
      when: |
        It uses supported kspec batching patterns around review commands
      then: |
        The review command surface is compatible with batch-oriented mutation
        flows instead of assuming one-off manual invocations only

- title: Review CLI Creation and Query
  slug: review-cli-creation-and-query
  type: requirement
  parent: "@review-cli-commands"
  traits:
    - trait-json-output
    - trait-filterable-list
    - trait-semantic-exit-codes
    - trait-shadow-commit
  description: |
    The CLI supports creating reviews with subject bindings and reading them
    back by review ref, subject, and status. For code subjects, creation
    accepts base and head commit refs. For non-ref subjects (code, external),
    the CLI accepts structured flags or a JSON input mode.
  acceptance_criteria:
    - id: ac-1
      given: |
        A user or agent needs to create a review for a ref-backed subject
        such as a task, plan, or spec
      when: |
        They run kspec review add with a subject ref
      then: |
        A first-party review record is created with subject binding, initial
        lifecycle state of draft, and author metadata
    - id: ac-2
      given: |
        A user or agent needs to create a review for committed code
      when: |
        They run kspec review add with base and head commit flags
      then: |
        A review record is created with a code subject binding containing
        base_commit, head_commit, and optionally merge_base_commit and
        branch metadata
    - id: ac-3
      given: |
        A review record exists
      when: |
        A user or agent runs kspec review get @review-ref
      then: |
        The CLI shows the review lifecycle state, computed disposition,
        computed gate state, threads, checks, verdicts, events, and linkage
        metadata
    - id: ac-4
      given: |
        Multiple review records exist
      when: |
        A user or agent runs kspec review list with filters for subject,
        lifecycle state, disposition, or reviewer
      then: |
        The CLI can return the matching review set so automation can find the
        active review record instead of scraping task notes
    - id: ac-5
      given: |
        A user or agent creates a review with a --slug flag
      when: |
        The review is created
      then: |
        The provided slug is used instead of an auto-generated one so batch
        workflows can reference the review by a known slug in subsequent
        commands

- title: Review CLI Mutation Commands
  slug: review-cli-mutation-commands
  type: requirement
  parent: "@review-cli-commands"
  traits:
    - trait-json-output
    - trait-semantic-exit-codes
    - trait-shadow-commit
    - trait-confirmation-prompt
  description: |
    The CLI supports the mutations needed to conduct a review cycle: add
    comments with diff-side anchors, record checks with compare binding,
    set verdicts with compare binding, resolve or reopen threads, and
    manage review lifecycle transitions.
  acceptance_criteria:
    - id: ac-1
      given: |
        A review record exists
      when: |
        A reviewer runs kspec review comment add with an optional code
        anchor including path, side, line range, and commit
      then: |
        The review stores a new thread with its anchor, kind (defaulting
        to nit), and authorship
    - id: ac-1b
      given: |
        A thread exists on a review
      when: |
        A user or agent runs kspec review reply with a thread ULID and
        body text
      then: |
        A reply entry is appended to the existing thread with author and
        timestamp, preserving the threaded conversation
    - id: ac-2
      given: |
        Verification evidence exists for a review
      when: |
        A user or agent runs kspec review check add with name, status,
        and the current compare context
      then: |
        The review stores the check result with normalized status, evidence
        details, and the applies_to_version binding
    - id: ac-3
      given: |
        A reviewer needs to approve, request changes, or leave a
        non-blocking verdict
      when: |
        They run kspec review verdict set with the decision and compare
        context
      then: |
        The individual verdict is recorded with applies_to_version and the
        computed disposition is updated according to aggregation, gate, and
        blocker rules
    - id: ac-4
      given: |
        A review thread has been addressed or needs to be reopened
      when: |
        A user or agent runs kspec review resolve or reopen with a thread
        ULID
      then: |
        The thread resolution state changes with actor and timestamp history
    - id: ac-5
      given: |
        A review needs to transition lifecycle state
      when: |
        A user or agent runs kspec review close, kspec review archive, or
        kspec review open
      then: |
        The lifecycle_state transitions and an event is appended to the
        event log
    - id: ac-6
      given: |
        A code review subject has been updated with new commits
      when: |
        A user or agent runs kspec review refresh with updated head_commit
        and optionally updated base_commit
      then: |
        The subject compare context is updated and an event is appended
        recording the subject revision change so stale verdicts and checks
        can be identified
    - id: ac-7
      given: |
        A destructive review mutation such as delete is offered in the
        future
      when: |
        The command surface is extended
      then: |
        Destructive operations are treated separately from close or archive
        lifecycle actions and require explicit safety behavior

- title: Review CLI Task Linkage
  slug: review-cli-task-linkage
  type: requirement
  parent: "@review-cli-commands"
  traits:
    - trait-json-output
    - trait-semantic-exit-codes
  description: |
    Task-oriented CLI output exposes the active review linkage so automation
    can move between task workflow state and the corresponding durable review
    record.
  acceptance_criteria:
    - id: ac-1
      given: |
        A task has an active associated review record
      when: |
        A user or agent inspects the task through task or review CLI output
      then: |
        The active review ref can be discovered without reading raw storage
        or scraping ad hoc task notes
    - id: ac-2
      given: |
        An automation flow starts from a task in pending_review or
        needs_work
      when: |
        It needs the durable review audit object
      then: |
        The CLI supports resolving from the task context to the
        corresponding review record using supported commands rather than
        convention-only fields
```

## Tasks

derive_from_specs: false

```yaml
- slug: task-implement-review-record-core
  title: Implement first-party review record core model
  spec_ref: "@review-record-core-model"
  priority: 1
  tags: [review, core, schema]

- slug: task-implement-review-storage-and-identity
  title: Implement review record storage and reference identity
  spec_ref: "@review-record-storage-and-identity"
  priority: 1
  depends_on:
    - "@task-implement-review-record-core"
  tags: [review, storage, identity]

- slug: task-implement-review-subject-bindings
  title: Implement subject bindings with compare semantics and staleness
  spec_ref: "@review-subject-bindings"
  priority: 1
  depends_on:
    - "@task-implement-review-record-core"
    - "@task-implement-review-storage-and-identity"
  tags: [review, bindings, identity]

- slug: task-implement-review-comment-threads
  title: Implement threaded comments with diff-side anchors and blocking kinds
  spec_ref: "@review-comment-threads-and-anchors"
  priority: 2
  depends_on:
    - "@task-implement-review-subject-bindings"
  tags: [review, comments, ux]

- slug: task-implement-review-checks-and-gates
  title: Implement check recording with compare binding and gate evaluation
  spec_ref: "@review-checks-and-gate-evaluation"
  priority: 2
  depends_on:
    - "@task-implement-review-subject-bindings"
  tags: [review, checks, policy]

- slug: task-implement-review-verdicts-and-resolution
  title: Implement verdict aggregation with compare binding and staleness
  spec_ref: "@review-verdicts-and-resolution-lifecycle"
  priority: 2
  depends_on:
    - "@task-implement-review-comment-threads"
    - "@task-implement-review-checks-and-gates"
  tags: [review, approvals, workflow]

- slug: task-implement-review-validation
  title: Implement schema validation for review records
  spec_ref: "@review-record-validation"
  priority: 2
  depends_on:
    - "@task-implement-review-record-core"
    - "@task-implement-review-storage-and-identity"
  tags: [review, schema, validation]

- slug: task-implement-review-task-integration
  title: Implement review-task sync rules and linkage
  spec_ref: "@review-task-lifecycle-integration"
  priority: 2
  depends_on:
    - "@task-implement-review-verdicts-and-resolution"
  tags: [review, tasks, integration]

- slug: task-implement-review-cli-surface
  title: Implement review CLI command surface
  spec_ref: "@review-cli-commands"
  priority: 2
  depends_on:
    - "@task-implement-review-record-core"
    - "@task-implement-review-storage-and-identity"
  tags: [review, cli, ux]

- slug: task-implement-review-cli-create-query
  title: Implement review CLI creation and query commands
  spec_ref: "@review-cli-creation-and-query"
  priority: 2
  depends_on:
    - "@task-implement-review-cli-surface"
    - "@task-implement-review-validation"
    - "@task-implement-review-subject-bindings"
  tags: [review, cli, query]

- slug: task-implement-review-cli-mutations
  title: Implement review CLI mutation commands
  spec_ref: "@review-cli-mutation-commands"
  priority: 2
  depends_on:
    - "@task-implement-review-cli-surface"
    - "@task-implement-review-verdicts-and-resolution"
    - "@task-implement-review-validation"
  tags: [review, cli, workflow]

- slug: task-implement-review-cli-task-linkage
  title: Implement task and review CLI linkage behavior
  spec_ref: "@review-cli-task-linkage"
  priority: 2
  depends_on:
    - "@task-implement-review-cli-create-query"
    - "@task-implement-review-task-integration"
  tags: [review, cli, tasks]

- slug: task-create-review-skill
  title: Create review skill for agent instructions
  priority: 3
  depends_on:
    - "@task-implement-review-cli-create-query"
    - "@task-implement-review-cli-mutations"
    - "@task-implement-review-cli-task-linkage"
  tags: [review, skill, agents]
```

## Implementation Notes

### Storage location and file structure

Review records are stored in `project.reviews.yaml` inside `.kspec/`, following
the same pattern as `project.tasks.yaml` and `project.plans.yaml`. The file
uses the standard versioned collection shape:

```yaml
kynetic_reviews: "1.0"
reviews:
  - _ulid: 01KX...
    slugs: [review-pr-123]
    title: "Review of PR #123"
    lifecycle_state: open
    subject:
      type: code
      base_commit: "abc123"
      head_commit: "def456"
      merge_base_commit: "aaa111"
      base_branch: "main"
      head_branch: "feat/foo"
    threads: [ ... ]
    checks: [ ... ]
    verdicts: [ ... ]
    events: [ ... ]
    notes: [ ... ]
    created_at: "2026-03-13T..."
```

A single file per entity type keeps shadow branch commits atomic and avoids
scattered state. Note that task integration (auto-setting `review_ref`) does
touch `project.tasks.yaml` as well — this is acceptable because it mirrors how
other cross-entity mutations (e.g. `task set --depends-on`) already work.

### Lifecycle state vs disposition vs gate state

The review record stores only `lifecycle_state` as a persisted field:

- `lifecycle_state`: `draft | open | closed | archived` — explicitly set by
  the user or automation via lifecycle commands

Disposition and gate state are computed from the review's current data:

- `disposition`: `pending | approved | changes_requested` — derived
  from current (non-stale) verdicts, unresolved blocking threads, and
  aggregation policy
- `gate_state`: `passing | failing | pending` — derived from current
  (non-stale) required check results

This separation prevents the contradictions that arise from collapsing
lifecycle, outcome, and gate status into a single enum.

### Schema definition

Create `src/schema/review-records.ts` with Zod schemas following the plan and
task schema patterns:

- `ReviewLifecycleStateSchema` — enum: `draft`, `open`, `closed`, `archived`
- `ReviewSubjectSchema` — discriminated union on `type` field:
  - `code`: `base_commit`, `head_commit`, `merge_base_commit?`,
    `base_branch?`, `head_branch?`
  - `plan`: `ref`, `shadow_commit`, `content_hash`
  - `task`: `ref`, `shadow_commit`, `content_hash`
  - `spec`: `ref`, `shadow_commit`, `content_hash`
  - `external`: `url`, `external_id?`, `provider?`
- `ReviewSubjectVersionSchema` — discriminated union binding verdicts and
  checks to the reviewed state:
  - `code_compare`: `base_commit` + `head_commit`
  - `entity_version`: `content_hash`
- `ReviewCodeAnchorSchema` — `path`, `side` (base | head), `line_start`,
  `line_end`, `commit`
- `ReviewStructuredAnchorSchema` — `section?`, `field?`, `path?`, `ref?`
- `ReviewAnchorSchema` — discriminated union of code and structured anchors
- `ReviewThreadKindSchema` — enum: `blocker`, `question`, `nit`
- `ReviewThreadSchema` — ULID-identified thread with optional anchor, kind
  (default `nit`), entries array (each entry has ULID, author, body,
  timestamp), resolved state (resolved_at, resolved_by)
- `ReviewCheckStatusSchema` — enum: `pass`, `fail`, `running`, `skipped`
- `ReviewCheckSchema` — name, status, required (boolean), runner, evidence,
  timestamps, `applies_to_version` (ReviewSubjectVersionSchema)
- `ReviewVerdictDecisionSchema` — enum: `approve`, `request_changes`, `comment`
  (use underscores consistently, not hyphens)
- `ReviewVerdictSchema` — reviewer (string), role (string, default
  `"reviewer"`), decision, timestamp, `applies_to_version`
  (ReviewSubjectVersionSchema)
- `ReviewEventSchema` — ULID, event_type (lifecycle_change,
  verdict_submitted, thread_created, thread_replied, thread_resolved,
  thread_reopened, check_added, subject_refreshed), actor, timestamp,
  payload (type-specific data)
- `ReviewRecordSchema` — full record with `_ulid`, `slugs`, `title`,
  `lifecycle_state`, subject, related_refs[] (optional refs to tasks or
  other entities related to this review), threads[], checks[], verdicts[],
  events[], notes[], external_links[], timestamps
- `ReviewRecordInputSchema` — input variant (most fields optional)
- `ReviewRecordsFileSchema` — collection wrapper with `kynetic_reviews` version
  key, matching the `kynetic_plans`/`kynetic_tasks` convention

Use `UlidSchema`, `SlugSchema`, `RefSchema`, `DateTimeSchema` from
`src/schema/common.ts`. Import `NoteSchema` from `src/schema/task.ts` (where
it is defined, not common.ts).

### Subject type extensibility

The subject type set (plan, task, spec, code, external) is modeled as a Zod
discriminated union on a `type` field. Adding a new subject type requires
adding a new variant to the union — this is a schema change but not a breaking
one since existing variants are unaffected. For unknown/future types, the
`external` variant with a freeform `provider` field serves as the escape hatch.

### Shadow-branch subject staleness

For subjects that live on the shadow branch (plans, specs, tasks), using
`kspec-meta` HEAD as the staleness signal would be a bug — every review
mutation (comment, check, verdict) commits to the same branch and would
self-invalidate the subject.

Instead, shadow-branch subjects store:
- `shadow_commit`: the kspec-meta commit at the time of review creation
- `content_hash`: a hash of the specific entity's YAML content

Staleness is detected by re-computing the entity content hash and comparing
against the stored hash. This isolates subject freshness from unrelated shadow
branch activity.

The content hash uses a **canonical semantic hash**, not a raw YAML hash.
For each entity type, only substantive fields are included:

- **Tasks**: title, description, spec_ref, depends_on, tags, acceptance_criteria.
  Excluded: status, review_ref, review_url, notes, assigned_to, updated_at
  (these change as side effects of review/workflow actions)
- **Plans**: title, content (the imported document body), specs, tasks.
  Excluded: status, notes, approved_at
- **Specs**: title, description, type, parent, traits, acceptance_criteria.
  Excluded: maturity, implementation status

Fields are sorted by key, serialized to deterministic JSON, and hashed with
SHA-256. This prevents formatting changes, field reordering, or review-driven
mutations from self-invalidating the subject.

### Git-backed compare semantics for code

Code reviews store a frozen compare context, not a single ref:

```yaml
subject:
  type: code
  base_commit: "<sha>"       # authoritative
  head_commit: "<sha>"       # authoritative
  merge_base_commit: "<sha>" # optional but recommended
  base_branch: "main"        # metadata only, never authoritative
  head_branch: "feat/foo"    # metadata only, never authoritative
```

Verdicts and checks bind to the compare they ran against:

```yaml
verdict:
  decision: approve
  applies_to_version:
    type: code_compare
    base_commit: "<sha>"
    head_commit: "<sha>"

check:
  name: tests
  status: pass
  applies_to_version:
    type: code_compare
    base_commit: "<sha>"
    head_commit: "<sha>"

# For entity subjects:
verdict:
  decision: approve
  applies_to_version:
    type: entity_version
    content_hash: "<sha256>"
```

Staleness: a verdict or check is stale when its `applies_to_version` does not
match the subject's current version. For code subjects, both `base_commit` and
`head_commit` must match (a base change alters the reviewed diff even if head
is unchanged). For entity subjects, `content_hash` must match. Stale verdicts
do not count toward approval. Stale required checks do not satisfy gates.

v1 does **not** support uncommitted worktree review. Only committed code is
reviewable.

### Code anchor diff-side semantics

Code anchors store enough context for PR-style rendering:

```yaml
anchor:
  type: code
  path: "src/foo.ts"
  side: head           # or base
  line_start: 42
  line_end: 46
  commit: "<sha>"
```

Optional hunk/context text can be added later but is not required for v1.

### Thread blocking semantics

Every thread has a `kind` field: `blocker`, `question`, or `nit` (default
`nit`). Only unresolved `blocker` threads prevent the computed disposition from
being `approved`. This prevents nits and questions from accidentally blocking
agent workflows.

### Append-only event log

Every mutation appends to `events[]`:

```yaml
events:
  - _ulid: 01KX...
    event_type: verdict_submitted
    actor: "agent@kspec"
    timestamp: "2026-03-13T..."
    payload:
      decision: approve
      applies_to_version: { base_commit: "abc", head_commit: "def" }
```

Event types (canonical list): `lifecycle_change`, `verdict_submitted`,
`thread_created`, `thread_replied`, `thread_resolved`, `thread_reopened`,
`check_added`, `subject_refreshed`. Notes are separate from events — notes
are human-readable context, events are machine-parseable audit records.

### Identity and defaults

Review records get a ULID on creation (via `ulid()`) and an auto-generated
slug derived from the subject (e.g. `review-task-foo-1`). The `--slug` flag
on `review add` allows explicit slug assignment for batch workflows that need
to reference the review by a known name in subsequent commands. Default initial
lifecycle state is `draft`.

### Verdict aggregation

The default aggregation rule: only the **latest verdict per reviewer** whose
`applies_to_version` matches the subject's current version is considered
(supersession by reviewer). Among those active verdicts, any
`request_changes` blocks the disposition from being `approved`, and at least
one explicit `approve` is required. Stale verdicts (those whose
`applies_to_version` does not match the current subject version) and
superseded verdicts (older verdicts from the same reviewer on the same
version) are preserved in history but excluded from the aggregation
computation.

The `role` field on each verdict defaults to `"reviewer"`. v1 ships with the
default aggregation rule only. Policy configuration (quorum, required roles,
override authority) is deferred to a future plan — the schema carries the
fields needed to support it without a redesign.

### Task synchronization rules

Exact rules for review-task interaction:

1. `review add` with a task subject → auto-sets `task.review_ref` to the new
   review
1b. `review add` with `--related @task-ref` → stores task in `related_refs`
    and auto-sets `task.review_ref` (for code reviews tied to a task)
2. `review verdict set --decision request_changes` on a task-subject or
   related-task review → auto-transitions task to `needs_work` if currently
   `pending_review`
3. Approval does **not** auto-transition the task — completion is always a
   manual/explicit step
4. `kspec task get` on a task with `review_ref` pointing at a closed/archived
   review while the task is `pending_review` → surfaces a warning
5. `review_ref` is a new optional field on the task schema alongside existing
   `review_url` — `review_url` remains for external-only linkage

### Parser and storage layer

Create `src/parser/review-records.ts` following the pattern in
`src/parser/plans.ts`:

- `getReviewRecordsFilePath(ctx)` — returns
  `path.join(ctx.specDir, "project.reviews.yaml")`
- `loadReviewRecords(ctx)` — parse file, validate with Zod, return
  `LoadedReviewRecord[]` with `_sourceFile` metadata
- `findReviewRecordByRef(ctx, ref)` — resolve by ULID or slug (strip `@`
  prefix), return single record or undefined
- `saveReviewRecord(ctx, record)` — file-locked read-modify-write via
  `withFileLock` from `src/parser/file-lock.ts`
- `mutateReviewRecordAtomically(ctx, record, mutator)` — atomic
  read-modify-write with callback, same pattern as plan mutations
- `createReviewRecord(input)` — factory that generates ULID, sets defaults
- `computeDisposition(record)` — pure function computing disposition from
  current (non-stale, latest-per-reviewer) verdicts, blocking threads, and
  gate state against the subject's current version
- `computeGateState(record)` — pure function computing gate state from current
  (non-stale) required checks against the subject's current version
- `isVersionMatch(applies_to, subject)` — compare applies_to_version against
  the subject's current version (full compare for code, hash for entities)
- `computeEntityContentHash(entity)` — compute content hash for shadow-branch
  subject staleness detection

All writes use `writeYamlFilePreserveFormat` for format-stable YAML output.
Export everything through `src/parser/index.ts`.

### Reference system integration

Update `ReferenceIndex` constructor in `src/parser/refs.ts` to accept and index
`LoadedReviewRecord[]` alongside tasks, items, plans, and meta items. This
enables `@review-slug` resolution through normal kspec lookup.

Update `buildIndexes()` in `src/parser/yaml.ts` to load and pass review records
into the index.

### CLI command structure

Create `src/cli/commands/review.ts` and register via
`src/cli/commands/index.ts` → `src/cli/index.ts`. Use `review` as the command
group name:

```
kspec review add --title "..." --subject @task-ref [--slug my-review]
kspec review add --title "..." --base-commit abc --head-commit def [--merge-base aaa] [--head-branch feat/foo] [--related @task-ref]
kspec review get @review-ref
kspec review list [--state open] [--disposition pending] [--subject @ref] [--reviewer name]
kspec review comment add @review-ref --body "..." [--kind blocker] [--file path --side head --line-start N --line-end N --commit sha]
kspec review check add @review-ref --name "tests" --status pass --head-commit sha [--base-commit sha] [--evidence "..."]
kspec review verdict set @review-ref --decision approve --head-commit sha [--base-commit sha]
kspec review reply @review-ref <thread-ulid> --body "..."
kspec review resolve @review-ref <thread-ulid>
kspec review reopen @review-ref <thread-ulid>
kspec review open @review-ref
kspec review close @review-ref
kspec review archive @review-ref
kspec review refresh @review-ref --head-commit sha [--base-commit sha]
```

Mark all write commands with `markMutating()` for batch eligibility. Each
mutation follows: load → validate → mutate → append event → save →
`commitIfShadow()`. Use `output()` for all rendering (handles `--json` mode
automatically via `@trait-json-output`).

For code and external subjects that require structured input beyond simple
flags, support `--subject-json '{"type":"code","base_commit":"...","head_commit":"..."}'`
as an alternative input mode.

### Shadow branch commits

All mutations auto-commit to the `kspec-meta` shadow branch via
`commitIfShadow(ctx.shadow, "review-add", slug, title)`. No special
handling needed — the existing shadow commit infrastructure handles this for
any file under `.kspec/`.

### Batch support

Commands marked with `markMutating()` are automatically eligible for
`kspec batch`. For batch workflows that need to reference a review created in
an earlier command, use `--slug` on creation:

```json
[
  {"command": "review add", "args": {"title": "PR #42 review", "subject": "@task-foo", "slug": "review-pr-42"}},
  {"command": "review comment add", "args": {"ref": "@review-pr-42", "body": "Fix the error handling", "kind": "blocker"}},
  {"command": "review check add", "args": {"ref": "@review-pr-42", "name": "tests", "status": "pass", "headCommit": "def456"}}
]
```

### Validation approach

Validation is built into each model task rather than treated as a standalone
milestone. The validation task ensures the complete schema is wired up
end-to-end and that structural relationships are validated correctly.
Validation checks structural shape (e.g. applies_to_version has the right
discriminant for the subject type) but does **not** check freshness equality
— stale verdicts and checks are valid data that must be preserved.

Invalid data supplied through CLI or batch should be rejected with actionable
Zod validation errors, matching the existing pattern in `src/schema/common.ts`
error formatting.

### Checks and gate policy

The review record separates historical check evidence from current gate
evaluation. Each check run is appended (never overwritten) and carries its
`applies_to_version` context. Gate evaluation computes current pass/fail from
the latest run of each logical check name **whose `applies_to_version` matches
the subject's current version** (full compare for code, hash for entities).
Required vs informational check
classification is a property of the check record. Checks with stale compare
context are preserved in history but excluded from gate computation.

v1 gate policy is hardcoded defaults only: all required checks must pass, no
configuration surface. Policy configuration is deferred to a future plan.

### Testing approach

Tests go in `tests/review-records.test.ts` using the standard helpers:
`createTempDir()`, `initGitRepo()`, `kspec()`, `kspecJson()`, `testUlid()`.
Test both the parser layer (load/save/mutate/compute-disposition/compute-gates)
and the CLI surface (create, query, mutate, lifecycle, refresh, batch).

Key test scenarios:
- Stale verdict detection (approve at compare A, refresh to compare B,
  disposition should not be approved)
- Base-commit change staleness (same head but different base → stale, because
  the reviewed diff changed)
- Verdict supersession (reviewer requests changes then approves same version →
  only the approve counts)
- Stale check detection (pass at compare A, refresh to compare B, gate should
  be pending not passing)
- Blocking thread semantics (unresolved blocker prevents approval, unresolved
  nit does not)
- Thread replies (reply appends to existing thread, not new thread)
- Task auto-sync (request_changes auto-transitions task to needs_work)
- Code review with --related @task-ref (task.review_ref set, discoverable)
- Shadow-branch subject staleness (review mutation does not self-invalidate
  plan/spec subject via content hash)
- Entity content hash stability (workflow-driven field changes like status,
  notes, review_ref do not change the hash)
- Entity version binding on verdicts/checks for non-code reviews

Remember: ULIDs must be Crockford base32 — always use `testUlid()`.

### Review skill for agents

Create `templates/skills/review.md` and add it to `templates/skills/manifest.yaml`.
The skill should document the review CLI commands, common workflows (create
review for task, add comments, run checks, submit verdict, handle re-review
cycles), and the review-task sync rules. Since skills auto-surface in
`kspec-agents.md` via `kspec agents generate`, agents will discover the review
system through the skill without needing separate template sections.

### Execution intent

This plan is intended to derive execution tasks directly. The plan itself is
the design step; the derived tasks should build the review record subsystem
and its minimal CLI surface rather than producing another layer of
design-only artifacts.

### Out of scope for this plan

This plan does not yet attempt to specify:

- a full web UI or provider sync implementation for review records
- review of uncommitted worktree state (v1 is committed code only)
- gate policy configuration beyond hardcoded defaults
- verdict aggregation policy configuration (quorum, required roles)

The immediate goal is a stable core record model with git-backed compare
semantics plus the minimal CLI needed for agents and humans to use it. Richer
rendering, interaction design, policy configuration, and provider-specific
synchronization can follow in later plans.
