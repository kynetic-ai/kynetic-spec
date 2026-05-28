# Task Activity Timeline

## Specs

```yaml
# ─── Core Timeline ───

- title: Task Activity Timeline
  slug: task-activity-timeline
  type: feature
  parent: "@tasks"
  description: |
    Unified chronological view of all activity on a task derived from
    shadow branch git history and linked review records. State transitions,
    notes, review events, and submission changes are merged into a single
    timeline. Recent activity shown by default in task get; full history
    available via --activity flag.
  traits:
    - trait-json-output
  acceptance_criteria:
    - id: ac-1
      given: |
        a task has had state transitions recorded via shadow branch commits
      when: |
        kspec task get @ref is run
      then: |
        the most recent activity entries are shown after the notes section,
        including state changes, notes, and review events in reverse
        chronological order, capped at a reasonable default count
    - id: ac-2
      given: |
        a task has state transitions, notes, and linked review records
      when: |
        kspec task get @ref --activity is run
      then: |
        the full activity timeline is shown, merging shadow branch commit
        history with review record events into a single chronological view
    - id: ac-3
      given: |
        a task has linked review records (current and historical)
      when: |
        the activity timeline is rendered
      then: |
        review events (creation, verdict submission, thread resolution,
        lifecycle changes) appear inline in the timeline with the same
        chronological ordering as task state changes and notes
    - id: ac-4
      given: |
        kspec task get @ref --json includes activity
      when: |
        the output is consumed programmatically
      then: |
        each activity entry is a structured object with type, timestamp,
        author, and summary fields in a typed array

- title: Task Activity Git Query
  slug: task-activity-git-query
  type: requirement
  parent: "@task-activity-timeline"
  description: |
    The mechanism for deriving task activity from shadow branch git history.
    Uses git log filtered by task ref in commit messages to extract state
    transitions and mutations.
  acceptance_criteria:
    - id: ac-1
      given: |
        a task ref is provided
      when: |
        the activity query runs against the shadow branch
      then: |
        all commits whose message references the task ref are returned,
        including the creation commit, state transitions, notes, and
        field changes
    - id: ac-2
      given: |
        multiple tasks exist in the same YAML file
      when: |
        activity is queried for a specific task
      then: |
        only commits whose message references that task's ref are
        included; commits for other tasks are excluded
    - id: ac-3
      given: |
        a commit message follows the shadow branch auto-commit format
      when: |
        the activity entry is constructed
      then: |
        the operation type (start, submit, complete, note, block, etc.)
        is parsed from the commit message into a structured activity type

# ─── Review Lifecycle ───

- title: Review Record Per-Cycle Lifecycle
  slug: review-record-per-cycle-lifecycle
  type: requirement
  parent: "@tasks"
  description: |
    Each review cycle produces a self-contained review record that is
    opened, investigated, verdicted, and closed. This is analogous to
    individual PR reviews on GitHub — each reviewer's review is a
    discrete artifact, and the collection of reviews across cycles
    comprises the full review history for the task.
  acceptance_criteria:
    - id: ac-1
      given: |
        a reviewer submits an approve or request_changes verdict
      when: |
        the verdict is recorded on the review
      then: |
        the review record automatically transitions from open to closed,
        preserving the verdict as a point-in-time artifact
    - id: ac-2
      given: |
        a task re-enters pending_review after a fix cycle
      when: |
        a reviewer begins reviewing the updated work
      then: |
        a new review record is created and linked to the task via
        review_ref; the previous review record remains closed as a
        historical artifact accessible through the activity timeline
    - id: ac-3
      given: |
        a task has multiple closed review records from successive cycles
      when: |
        the activity timeline is rendered
      then: |
        each review appears as a distinct entry with its own verdict,
        disposition, and cycle context

- title: Review Fix-Cycle Diff Context
  slug: review-fix-cycle-diff
  type: requirement
  parent: "@task-activity-timeline"
  description: |
    When a reviewer examines work after a fix cycle, they receive context
    about what changed since the prior review. The review record stores
    the commit it examined so diffs can be computed across cycles.
  acceptance_criteria:
    - id: ac-1
      given: |
        a review record is created for a task with dispatch workspace
        metadata available
      when: |
        the review is initialized
      then: |
        the review record stores the examined commit (the HEAD of the
        detached review snapshot) as metadata on the record; reviews
        created without workspace context leave this field null
    - id: ac-2
      given: |
        a prior closed review record with an examined_commit exists
        for the same task
      when: |
        a new review cycle begins and the reviewer receives orientation
      then: |
        the reviewer prompt includes a summary of what changed between
        the prior review's examined commit and the current submission HEAD
    - id: ac-3
      given: |
        diffs are requested between review cycles
      when: |
        the merge target or prior examined commit is unreachable
      then: |
        the diff is gracefully omitted with a note rather than erroring
```

## Tasks

derive_from_specs: false

```yaml
# ─── Foundation (no dependencies) ───

- title: Fix task-add shadow commit to include entity ref
  slug: task-fix-task-add-commit-ref
  priority: 1
  tags: [cli, bug]
  description: |
    Fix the task-add case in generateCommitMessage() (src/parser/shadow.ts
    line 990) to include the task ref alongside the title.

    Why: @trait-shadow-commit ac-2/ac-3 requires commit messages to include
    the entity ref. The task-add case uses "Add task: <title>" and drops
    the ref entirely because `detail` (the title) takes precedence over
    `ref` in the format string. This is a bug against the existing trait.

    What: Change to "Add task @<ref>: <title>" so both ref and title are
    present. Update the generateCommitMessage test in tests/shadow.test.ts
    for the new format.

    How: Single change in the switch statement. The ref is already passed
    to the function — it's just unused when detail is present.

    Covers: @trait-shadow-commit ac-2, ac-3.

- title: Add submission linkage dispatch config fallback AC
  slug: task-submission-linkage-dispatch-fallback
  priority: 2
  tags: [dispatch, cli]
  spec_ref: "@portable-task-submission-linkage"
  description: |
    Add an AC to @portable-task-submission-linkage for populating
    upstream_ref from dispatch config when git upstream tracking is
    not configured, then implement it.

    Why: For dispatch-managed work, the merge target is known from
    dispatch.base_branch config but git upstream tracking is rarely set
    on feature branches. Without this, upstream_ref is null and
    reviewers/tooling can't determine the merge target from the
    submission alone.

    What: Add AC to existing spec. Update captureSubmissionLinkage() in
    src/utils/git.ts to fall back to dispatch config base_branch when
    getBranchRemote() returns null for upstream_ref. Git upstream
    tracking takes precedence when available.

    How: The caller (task submit in task.ts) already has access to ctx
    which can resolve config. Either pass the resolved base_branch to
    captureSubmissionLinkage() or load config inline.

    Covers: new AC on @portable-task-submission-linkage.

# ─── Review Lifecycle ───

- title: Rewrite review-verdicts-and-resolution-lifecycle ac-3 for per-cycle model
  slug: task-rewrite-review-lifecycle-ac3
  priority: 1
  tags: [spec, reviews]
  description: |
    Rewrite @review-verdicts-and-resolution-lifecycle ac-3 to describe the
    per-cycle review model instead of the single-record iteration model.

    Why: The current ac-3 states "the same review record tracks iteration
    through its event log and compare context updates without losing the
    audit trail." This conflicts with the per-cycle model where each review
    cycle gets its own record. The original assumption predated the dispatch
    review flow — review records were conceived as long-lived mutable
    artifacts, but in practice each review cycle is a discrete assessment.

    What: Rewrite ac-3 to describe that review cycles create new review
    records, with the collection of records comprising the full review
    history. Verify that existing code and tests referencing ac-3 are
    compatible with the rewrite — the current implementation already
    supports creating multiple reviews per task, so this is primarily a
    spec alignment, not a code change.

    How: Use kspec item ac set @review-verdicts-and-resolution-lifecycle
    ac-3 to rewrite the AC text. Check tests tagged with this AC for
    compatibility. Update any test annotations if needed.

- title: Auto-close review records on verdict submission
  slug: task-auto-close-review-on-verdict
  priority: 2
  tags: [cli, reviews]
  spec_ref: "@review-record-per-cycle-lifecycle"
  depends_on:
    - "@task-rewrite-review-lifecycle-ac3"
  description: |
    When a reviewer submits an approve or request_changes verdict, the
    review record automatically transitions from open to closed.

    Why: Currently reviews stay open after verdict, requiring manual
    close. Auto-closing makes each review a clean point-in-time artifact
    on the timeline. Comment verdicts leave the review open since they
    don't represent a final assessment.

    What: In the verdict submission handler (src/cli/commands/review.ts,
    around line 1010), after recording the verdict, transition the review
    lifecycle to closed for approve and request_changes decisions.

    How: Call the existing lifecycle transition logic after verdict
    recording. The handleVerdictTaskTransition() call already runs here
    for request_changes; add lifecycle close alongside it.

    Covers: @review-record-per-cycle-lifecycle ac-1.

- title: Create new review record per fix cycle
  slug: task-new-review-per-cycle
  priority: 2
  tags: [cli, reviews, dispatch]
  spec_ref: "@review-record-per-cycle-lifecycle"
  depends_on:
    - "@task-auto-close-review-on-verdict"
  description: |
    When a task re-enters pending_review after a fix cycle, the reviewer
    creates a new review record rather than reopening the previous one.
    The task's review_ref is updated to point to the new record.

    Why: A single mutable review record spanning multiple fix cycles
    makes it impossible to see what happened in each cycle. Separate
    records per cycle give clean timeline artifacts and match the mental
    model of individual reviews on a pull request.

    What: Update the review skill and pr-reviewer agent workflow to
    always create a new review when picking up a pending_review task
    that already has a closed review_ref. Update review_ref on the task
    to point to the new record. The old record remains closed and
    accessible via the activity timeline.

    How: The reviewer skill instructions check for existing closed
    review_ref and create fresh. The dispatch orientation prompt surfaces
    the prior review ref. Code changes: update review-task-integration
    to handle review_ref replacement, ensure old review records are
    findable by task ref for timeline rendering.

    Covers: @review-record-per-cycle-lifecycle ac-2, ac-3.

- title: Store examined commit on review records
  slug: task-review-examined-commit
  priority: 2
  tags: [reviews, schema]
  spec_ref: "@review-fix-cycle-diff"
  description: |
    Add an examined_commit field to the review record schema that captures
    the HEAD of the detached review snapshot when the review is created.

    Why: After workspaces are cleaned up, there's no way to know what
    commit a reviewer actually looked at. Storing it on the review record
    makes diff-since-last-review computable from durable data alone.

    What: Add examined_commit (string, optional) to ReviewRecordSchema
    in src/schema/review-records.ts. Populate it when the reviewer
    creates a review from a dispatch workspace (from canonicalBranchHead
    workspace metadata or KSPEC_DISPATCH_CANONICAL_HEAD env var). For
    manually created reviews, leave null. Existing reviews without the
    field are handled gracefully (optional field, backward compatible).

    How: Schema change is additive (optional field). The review create
    command auto-detects from KSPEC_DISPATCH_CANONICAL_HEAD env var if
    set, or accepts --examined-commit for manual specification.

    Covers: @review-fix-cycle-diff ac-1.

- title: Include fix-cycle diff in reviewer orientation prompt
  slug: task-review-diff-orientation
  priority: 2
  tags: [dispatch, reviews]
  spec_ref: "@review-fix-cycle-diff"
  depends_on:
    - "@task-review-examined-commit"
    - "@task-new-review-per-cycle"
  description: |
    When a reviewer picks up a task for a fix cycle (previous closed
    review exists with examined_commit), the dispatch orientation prompt
    includes a summary of what changed since the prior review.

    Why: The reviewer in fix cycle #2 currently has no idea what changed
    since fix cycle #1. They re-review everything or miss the actual
    fixes. This was the root cause of the confused reviewer in the
    @01KKTZ0B task.

    What: In buildOrientationContext() (src/agent-runtime/dispatch.ts),
    when rendering for pending_review and a prior closed review record
    exists with examined_commit, compute and include a git diff --stat
    between prior examined_commit and current canonicalBranchHead.

    How: Load the task's previous review records (closed ones), find the
    most recent with examined_commit, diff against current HEAD. Include
    the stat summary in the orientation section. If no prior examined
    commit exists (pre-migration or manual reviews), skip gracefully
    per @review-fix-cycle-diff ac-3.

    Covers: @review-fix-cycle-diff ac-2, ac-3.

# ─── Timeline Implementation ───

- title: Implement task activity git query
  slug: task-implement-activity-git-query
  priority: 1
  tags: [cli, tasks]
  spec_ref: "@task-activity-git-query"
  depends_on:
    - "@task-fix-task-add-commit-ref"
  description: |
    Build the function that queries shadow branch git history to extract
    a task's activity timeline from auto-commit messages.

    Why: This is the data layer for the activity timeline. Without it,
    task get has no way to show state transitions beyond bare timestamps.

    What: Create a getTaskActivity(specDir, taskRef) function that runs
    git log --oneline --format with grep filtering for the task ref in
    the shadow branch worktree, parses commit messages into structured
    activity entries (type, timestamp, author, summary), and returns
    them in chronological order.

    How: Shell out to git in the .kspec worktree directory. Parse each
    line into {hash, timestamp, message}. Map commit message prefixes
    to activity types: "Start @ref" → started, "task-submit @ref" →
    submitted, "Complete @ref" → completed, "Note on @ref" → note,
    "task-needs-work @ref" → needs_work, "Add task @ref" → created,
    etc. Return structured array.

    Covers: @task-activity-git-query ac-1, ac-2, ac-3.

- title: Implement task activity timeline in task get
  slug: task-implement-activity-display
  priority: 1
  tags: [cli, tasks]
  spec_ref: "@task-activity-timeline"
  depends_on:
    - "@task-implement-activity-git-query"
  description: |
    Add the activity timeline section to kspec task get output, merging
    git-derived state transitions with review record events.

    Why: This is the user-facing feature. Task get currently shows notes
    and timestamps separately but has no unified view of what happened
    on a task and when.

    What: Add an "Activity" section to formatTaskDetails() in
    src/cli/output.ts. By default show the last N entries (e.g. 10).
    With --activity flag, show the full timeline. Merge git-derived
    activity entries with review record events (from linked and
    historical review records), sort chronologically. Each entry shows
    timestamp, type icon/label, and summary. JSON output includes the
    full structured array with typed entries.

    How: Call getTaskActivity() for git history. Load review records
    associated with the task (current review_ref plus any closed
    historical records). Extract review events, merge by timestamp.
    Render using existing section header pattern. Add --activity flag
    to task get command options.

    Covers: @task-activity-timeline ac-1, ac-2, ac-3, ac-4.

# ─── Documentation ───

- title: Update review skill for per-cycle review records
  slug: task-update-review-skill-docs
  priority: 2
  tags: [docs, reviews]
  depends_on:
    - "@task-auto-close-review-on-verdict"
    - "@task-new-review-per-cycle"
  description: |
    Update the review skill (templates/skills/review/SKILL.md) and
    review-gates skill to reflect the per-cycle review record model.

    What: Document auto-close behavior on verdict. Add fix-cycle section
    explaining new-record-per-cycle. Update worker perspective for how
    to find historical reviews. Remove guidance about reopening reviews.
    Document the relationship between individual reviews and the task's
    review history (analogous to individual PR reviews comprising a
    PR's full review history).

    Run kspec skill render after editing to regenerate .agents/skills/.

- title: Update task-work skill for fix-cycle notes
  slug: task-update-task-work-skill-docs
  priority: 2
  tags: [docs, tasks]
  depends_on:
    - "@task-new-review-per-cycle"
  description: |
    Update the task-work skill (templates/skills/task-work/SKILL.md)
    to enforce that workers add a task note summarizing what changed
    before resubmitting after a fix cycle.

    What: Add explicit guidance to the Fix Cycle section requiring a
    note before kspec task submit that summarizes what was changed and
    why. Reference the activity timeline as the consumer of this note.
    This note becomes a key timeline entry for understanding fix cycles.

    Run kspec skill render after editing to regenerate .agents/skills/.

- title: Update AGENTS.md for review lifecycle conventions
  slug: task-update-agents-review-conventions
  priority: 3
  tags: [docs]
  depends_on:
    - "@task-update-review-skill-docs"
    - "@task-update-task-work-skill-docs"
  description: |
    Regenerate kspec-agents.md to reflect the updated review lifecycle
    conventions. Add a convention rule for the fix-cycle note requirement
    if needed. Run kspec agents generate.
```

## Implementation Notes

The activity timeline is derived from two sources merged chronologically:

1. Shadow branch git history: git log --grep filtered by task ref in the
   .kspec worktree. Commit messages encode operation type and ref per
   @trait-shadow-commit. The task-add ref bug is the only known gap.

2. Linked review records: review.events array provides lifecycle changes,
   verdicts, and thread activity with timestamps. With the per-cycle model,
   each review record is a discrete artifact — the timeline collects all
   review records for a task (current + historical closed ones) and merges
   their events into the git-derived timeline by timestamp.

The per-cycle review model requires rewriting
@review-verdicts-and-resolution-lifecycle ac-3 which currently describes a
single-record iteration model. A separate task handles that rewrite to
remove the conflict. The per-cycle model is analogous to GitHub PR reviews:
each reviewer's review is a discrete artifact with a verdict, and the
collection of reviews across cycles comprises the full review history.

Diff summaries (diffs against merge target and since prior review in the
timeline view) are deferred to @plan-activity-timeline-diff-summaries to
keep this plan focused. The review-fix-cycle-diff spec in this plan covers
the reviewer orientation use case (diff in the dispatch prompt), which is
the highest-value diff consumer.

Dependency ordering: task-add commit fix is a standalone foundation.
Submission linkage fallback is independent. Review lifecycle changes form
a chain (auto-close → new-per-cycle → examined-commit → diff orientation).
Timeline implementation depends on the commit fix. Documentation tasks
depend on the review lifecycle changes they document.

Related work not in this plan:
- @01KKW3VH: Audit all shadow commit messages for ref consistency gaps
- Inbox item @01KKW3VQ: Enriching commit message detail for auditability
- @plan-activity-timeline-diff-summaries: Diff summaries in the timeline
- @01KKVW67 / @01KKVX1X: YAML serialization invariants (canonical field
  ordering enables reliable git log -L queries as an alternative to
  git log --grep)
