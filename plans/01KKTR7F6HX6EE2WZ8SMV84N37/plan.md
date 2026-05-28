# Review Records Web UI

Add daemon API endpoints and SvelteKit pages for viewing and interacting
with kspec review records. Includes a GitHub-style diff viewer with inline
commenting for code reviews, and structured content viewers for plan/spec
reviews. Reviews are presented as revisions — each review on a subject
represents a revision, with a selector to navigate between them.

## Specs

```yaml
# ─── API Layer ───

- title: Review Records Daemon API
  slug: review-records-daemon-api
  type: requirement
  parent: "@daemon-server"
  traits:
    - "@trait-json-output"
    - "@trait-error-guidance"
    - "@trait-localhost-security"
    - "@trait-websocket-protocol"
  description: |
    REST API endpoints on the daemon for CRUD operations on review records,
    enabling the web UI to display and interact with reviews.
  acceptance_criteria:
    - id: ac-1
      given: |
        The daemon is running
      when: |
        A client requests GET /api/reviews
      then: |
        It returns a paginated list of review records with filtering by status,
        disposition, subject-type, reviewer, linked task (via subject-ref or
        related-refs), and subject-branch (base-branch/head-branch for code
        reviews), with sort parameter support; defaults to open reviews
    - id: ac-2
      given: |
        The daemon is running
      when: |
        A client requests GET /api/reviews/:id
      then: |
        It returns the full review record including threads, checks, verdicts,
        events, and computed disposition
    - id: ac-3
      given: |
        The daemon is running
      when: |
        A client sends POST /api/reviews/:id/comments with body, kind, and
        optional anchor fields
      then: |
        A new thread is created on the review and the response includes the
        created thread
    - id: ac-4
      given: |
        The daemon is running
      when: |
        A client sends POST /api/reviews/:id/comments/:threadId/replies with
        a body
      then: |
        A reply is added to the thread and the response includes the updated
        thread
    - id: ac-5
      given: |
        The daemon is running
      when: |
        A client sends PATCH /api/reviews/:id/comments/:threadId/resolve or
        /reopen
      then: |
        The thread resolution state is updated and the response reflects the
        new state
    - id: ac-6
      given: |
        The daemon is running
      when: |
        A client sends POST /api/reviews/:id/verdicts with decision, reviewer,
        and version fields
      then: |
        The verdict is recorded and the review disposition is recomputed
    - id: ac-7
      given: |
        The daemon is running
      when: |
        A client sends POST /api/reviews/:id/checks with name, status, runner,
        and version fields
      then: |
        The check is recorded and the gate evaluation is updated
    - id: ac-8
      given: |
        The daemon is running
      when: |
        A client sends PATCH /api/reviews/:id/lifecycle with a target state
        (open, closed, archived)
      then: |
        The lifecycle transition is applied if valid, or a 400 error is returned
        with the reason the transition is invalid
    - id: ac-9
      given: |
        A review record is created or mutated via any API endpoint
      when: |
        WebSocket clients are connected
      then: |
        A real-time update event is broadcast on the reviews:updates topic so
        the UI can refresh without polling
    - id: ac-10
      given: |
        A client sends a mutation request with invalid data (missing required
        fields, invalid ref, invalid state transition)
      when: |
        The request is processed
      then: |
        A 400 response is returned with an actionable error message describing
        what is wrong and how to fix it

- title: Review Content Diff API
  slug: review-content-diff-api
  type: requirement
  parent: "@daemon-server"
  traits:
    - "@trait-json-output"
    - "@trait-error-guidance"
    - "@trait-localhost-security"
  description: |
    Daemon API endpoints for serving diff content and file data needed by
    the review content viewer. For code reviews, serves parsed git diffs
    between base and head commits. For plan/spec reviews, serves the
    entity content for structured display.
  acceptance_criteria:
    - id: ac-1
      given: |
        A code review has base and head commit refs
      when: |
        A client requests GET /api/diff?base=X&head=Y
      then: |
        It returns a parsed diff with file list, per-file stats (+/- lines),
        and structured hunks with typed change lines (added, deleted, unchanged)
        including old and new line numbers
    - id: ac-2
      given: |
        A client requests expanded context for a file in a diff
      when: |
        The request includes GET /api/diff/context?base=X&head=Y&path=P&start=N&end=M
      then: |
        It returns the additional context lines from the file at the head
        commit for the specified line range, enabling "show more lines"
        expansion in the diff viewer
    - id: ac-3
      given: |
        A client requests GET /api/diff/file?base=X&head=Y&path=P
      when: |
        The file exists in the diff
      then: |
        It returns the parsed diff for a single file, enabling lazy
        loading of individual file diffs
    - id: ac-4
      given: |
        A plan or spec review has a subject-ref
      when: |
        A client requests GET /api/reviews/:id/content
      then: |
        It returns the parsed entity content — for plans: sections
        (title, specs array, tasks array, notes) extracted from the plan
        document; for specs: structured fields (description, acceptance
        criteria, traits, metadata) from kspec item get — each with
        section identifiers for anchor targeting

# ─── Web UI ───

- title: Review Records Web UI
  slug: review-records-web-ui
  type: requirement
  parent: "@web-ui"
  description: |
    SvelteKit pages for viewing and interacting with review records in the
    browser. The primary interface for humans to see agent review activity
    and participate in reviews. Routes: /reviews for list, /reviews/[id]
    for detail. Reviews on the same subject are treated as revisions with
    a dropdown selector to navigate between them.
  acceptance_criteria:
    - id: ac-1
      given: |
        A user navigates to /reviews
      when: |
        Reviews exist in the system
      then: |
        A list view shows reviews with lifecycle status, disposition badge,
        subject type, reviewer, and linked task, with filtering by status,
        disposition, and subject type, and sortable columns; defaults to
        showing open reviews
    - id: ac-2
      given: |
        A user opens /reviews/[id]
      when: |
        The review has threads, checks, and verdicts
      then: |
        All threads are displayed with their entries, resolution state, and
        kind badges (blocker/question/nit); checks show pass/fail with
        staleness; verdicts show reviewer decisions; computed disposition
        is prominent
    - id: ac-3
      given: |
        A user is viewing a review detail page
      when: |
        They click "Add Comment"
      then: |
        They can create a new thread with a body and kind selection
        (blocker, question, nit)
    - id: ac-4
      given: |
        A user is viewing a thread on a review
      when: |
        They click "Reply"
      then: |
        They can add a reply to the thread
    - id: ac-5
      given: |
        A user is viewing a blocker or question thread
      when: |
        They click "Resolve" or "Reopen"
      then: |
        The thread resolution state is toggled and the UI updates immediately
    - id: ac-6
      given: |
        A user is viewing a review detail page
      when: |
        They submit a verdict (approve, request_changes, comment)
      then: |
        The verdict is recorded and the disposition badge updates to reflect
        the new computed disposition
    - id: ac-7
      given: |
        A user views a task detail page
      when: |
        The task has linked reviews (via review_ref or related_refs)
      then: |
        The reviews are shown with current disposition badge and link to the
        review detail page
    - id: ac-8
      given: |
        A thread comment has a body containing markdown (headings, code blocks,
        inline code, bold, lists, links)
      when: |
        The comment is rendered in the thread view
      then: |
        The body is rendered as formatted markdown with syntax highlighting
        in code blocks
    - id: ac-9
      given: |
        A thread entry is displayed
      when: |
        The entry has author and timestamp fields
      then: |
        The author identity and relative timestamp are shown alongside
        the entry body
    - id: ac-10
      given: |
        A review section (threads, checks, verdicts) has no items
      when: |
        The section is rendered
      then: |
        An empty state message is shown (e.g., "No threads yet",
        "No checks recorded")
    - id: ac-11
      given: |
        Multiple reviews exist for the same subject
      when: |
        The user views any one of those reviews
      then: |
        A revision dropdown is shown listing all reviews for that subject
        ordered by creation date, with the current review selected; selecting
        another review navigates to it; subject matching uses subject-ref
        for plan/task/spec reviews, or head-branch for code reviews

- title: Review Code Diff Viewer
  slug: review-code-diff-viewer
  type: requirement
  parent: "@review-records-web-ui"
  description: |
    A GitHub-style unified diff viewer for code reviews. Shows per-file
    diffs with syntax highlighting, line numbers, expandable context,
    and inline comment threading anchored to specific diff lines.
  acceptance_criteria:
    - id: ac-1
      given: |
        A code review is open with base and head commits
      when: |
        The review detail page loads
      then: |
        A file list shows all changed files with their diff stats (+/- lines)
        and each file is expandable to show its diff content
    - id: ac-2
      given: |
        A file diff is expanded
      when: |
        The diff renders
      then: |
        It shows a unified diff view with syntax highlighting, old and new
        line numbers, added lines (green), deleted lines (red), and unchanged
        context lines
    - id: ac-3
      given: |
        A diff hunk has collapsed unchanged regions
      when: |
        The user clicks "Show N more lines"
      then: |
        Additional context lines are fetched and inserted into the diff
        view without reloading the page
    - id: ac-4
      given: |
        A user hovers over a line number in the diff
      when: |
        They click the comment button (+)
      then: |
        A comment form opens inline between diff rows, anchored to that
        file, line number, and side (old/new); submitting creates a thread
        with a code anchor
    - id: ac-5
      given: |
        Existing review threads have code anchors matching lines in the diff
      when: |
        The diff is rendered
      then: |
        The comment threads are shown inline at their anchored position
        in the diff, between the relevant diff rows
    - id: ac-6
      given: |
        A diff contains more than 20 changed files
      when: |
        The diff viewer loads
      then: |
        Files are lazy-loaded (headers and stats shown immediately, full
        diff content loaded on expand or viewport intersection)

- title: Review Structured Content Viewer
  slug: review-structured-content-viewer
  type: requirement
  parent: "@review-records-web-ui"
  description: |
    Content viewer for non-code reviews (plans, specs). Renders the
    entity content with identifiable sections that support anchored
    commenting, similar to how the diff viewer enables line-level
    comments on code.
  acceptance_criteria:
    - id: ac-1
      given: |
        A plan review is open
      when: |
        The review detail page loads
      then: |
        The plan content is rendered with identifiable sections (specs,
        tasks, implementation notes) that can be targeted for comments
    - id: ac-2
      given: |
        A spec review is open
      when: |
        The review detail page loads
      then: |
        The spec content is rendered showing description, acceptance
        criteria, traits, and metadata with each section targetable
        for comments
    - id: ac-3
      given: |
        A user clicks a comment button next to a content section
      when: |
        The comment form opens
      then: |
        Submitting creates a thread with a structured anchor (section,
        field, anchor-ref) pointing to the selected content area
    - id: ac-4
      given: |
        Existing threads have structured anchors matching content sections
      when: |
        The content is rendered
      then: |
        The threads are shown inline at their anchored position in the
        content, adjacent to the referenced section
```

## Tasks

derive_from_specs: false

```yaml
# ─── API Layer ───

- title: Implement review list and detail API endpoints
  slug: task-review-api-read
  priority: 2
  tags: [daemon, api, review]
  spec_ref: "@review-records-daemon-api"
  description: |
    Add GET /api/reviews and GET /api/reviews/:id endpoints to the daemon.
    These are the read-only foundation the web UI queries.

    Why: The web UI needs server-side data. The review library already has
    loadReviewRecords() and full record parsing — the daemon is a thin HTTP
    layer over these functions, following the same pattern as /api/tasks and
    /api/plans.

    What: GET /api/reviews returns paginated ReviewSummary objects (ulid,
    title, lifecycle, disposition, subject type, reviewer, linked task ref,
    created/updated timestamps). Supports query params: status, disposition,
    subject-type, reviewer, task (matches subject-ref or related-refs),
    sort, limit, offset. Default status filter: open. GET /api/reviews/:id
    returns the full review record including threads, checks, verdicts,
    events, and computed disposition.

    How: Add routes to packages/daemon/src/routes/. Use loadReviewRecords()
    from parser/reviews.ts. Create ReviewSummary and ReviewDetail types in
    packages/shared/src/api.ts following existing PlanSummary/TaskDetail
    patterns. Pagination follows existing tasks route conventions
    (limit/offset with total count header).

    Covers: @review-records-daemon-api ac-1, ac-2.

- title: Implement review thread mutation API endpoints
  slug: task-review-api-threads
  priority: 2
  tags: [daemon, api, review]
  spec_ref: "@review-records-daemon-api"
  depends_on:
    - "@task-review-api-read"
  description: |
    Add endpoints for creating threads, replying, and resolving/reopening.
    These are the core interaction endpoints for the review UI.

    Why: Thread interaction is the primary review workflow — reviewers
    create threads with findings, workers reply and resolve. The review
    library has addThread(), addReply(), resolveThread(), reopenThread()
    in parser/review-threads.ts — the API wraps these.

    What: POST /api/reviews/:id/comments creates a new thread (body, kind,
    optional anchor). POST /api/reviews/:id/comments/:threadId/replies adds
    a reply (body). PATCH /api/reviews/:id/comments/:threadId/resolve and
    /reopen toggle resolution state. All mutations return the updated thread.

    How: Route handlers call the atomic wrapper functions from
    parser/review-threads.ts which handle file locking and persistence.
    Validate request bodies with Zod schemas. Return 400 with actionable
    messages for invalid input (missing body, invalid thread ULID, etc.).

    Covers: @review-records-daemon-api ac-3, ac-4, ac-5, ac-10.

- title: Implement review verdict, check, and lifecycle API endpoints
  slug: task-review-api-verdicts
  priority: 2
  tags: [daemon, api, review]
  spec_ref: "@review-records-daemon-api"
  depends_on:
    - "@task-review-api-read"
  description: |
    Add endpoints for recording verdicts, checks, and lifecycle transitions.
    These complete the mutation API surface.

    Why: Verdicts drive disposition computation (the core review outcome).
    Checks record verification evidence. Lifecycle transitions control
    review state. The review library has functions for all of these in
    parser/review-operations.ts.

    What: POST /api/reviews/:id/verdicts records a verdict (decision,
    reviewer, version fields). POST /api/reviews/:id/checks records a
    check result (name, status, runner, evidence, version fields).
    PATCH /api/reviews/:id/lifecycle transitions lifecycle state (target
    state: open, closed, archived). Invalid transitions return 400 with
    the reason.

    How: Use submitVerdict() and transitionLifecycle() from
    parser/review-operations.ts, and createCheck()/createLocalCheck()
    from review/checks.ts. All mutations need mutateReviewAtomically()
    from parser/reviews.ts for persistence with file locking. Validate
    state transitions server-side (e.g., can't archive from draft).
    Return recomputed disposition in verdict responses so the UI can
    update immediately.

    Covers: @review-records-daemon-api ac-6, ac-7, ac-8, ac-10.

- title: Add WebSocket events for review mutations
  slug: task-review-api-websocket
  priority: 2
  tags: [daemon, websocket, review]
  spec_ref: "@review-records-daemon-api"
  depends_on:
    - "@task-review-api-threads"
    - "@task-review-api-verdicts"
  description: |
    Broadcast WebSocket events when review records are created or mutated,
    so the UI can refresh without polling.

    Why: The web UI uses TanStack Query with WebSocket-driven invalidation.
    Without real-time events, users would need to manually refresh to see
    new threads, verdicts, or disposition changes from agent reviewers.

    What: Add a "reviews:updates" WebSocket topic. Emit events on review
    creation, thread creation/update, verdict submission, check recording,
    and lifecycle transitions. Event types: review_created, review_updated,
    thread_created, thread_updated, verdict_submitted, check_recorded,
    lifecycle_changed.

    How: Follow existing WebSocket patterns (tasks:updates, plans:updates).
    Add broadcast calls at the end of each mutation endpoint handler.
    Events carry the review ULID and the mutation type so the client
    knows which query keys to invalidate.

    Covers: @review-records-daemon-api ac-9.

- title: Implement diff content API endpoints
  slug: task-diff-api
  priority: 2
  tags: [daemon, api, diff]
  spec_ref: "@review-content-diff-api"
  description: |
    Add daemon endpoints for serving parsed git diffs and entity content
    for the review content viewers.

    Why: The diff viewer needs structured diff data (not raw text) to render
    syntax-highlighted diffs with line numbers. The structured content viewer
    needs plan/spec content to display with section markers. The daemon runs
    in the repo and has access to git and .kspec/.

    What: GET /api/diff?base=X&head=Y returns parsed diff with file list,
    stats, and structured hunks. GET /api/diff/file?base=X&head=Y&path=P
    returns single-file diff for lazy loading.
    GET /api/diff/context?base=X&head=Y&path=P&start=N&end=M returns
    expanded context lines for a file region.
    GET /api/reviews/:id/content returns parsed plan/spec content for
    structured reviews.

    How: Run `git diff --unified=3 base..head` on the server, parse with
    parse-git-diff into typed structures (files, chunks, changes with line
    numbers and change types). For context expansion, run `git show
    commit:path` and extract the requested line range. For entity content,
    use existing kspec plan/spec loading functions. Return structured JSON
    matching the input format expected by @git-diff-view/svelte.

    Covers: @review-content-diff-api ac-1, ac-2, ac-3, ac-4.

# ─── Web UI ───

- title: Build review list page
  slug: task-review-list-page
  priority: 3
  tags: [web-ui, review]
  spec_ref: "@review-records-web-ui"
  depends_on:
    - "@task-review-api-read"
  description: |
    Create the /reviews route with a filterable, sortable list of reviews.

    Why: Users need to see all reviews at a glance — which are open,
    which need attention, what disposition each has. This is the entry
    point to the review UI.

    What: SvelteKit page at /reviews. Table showing review title,
    lifecycle status, disposition badge (color-coded: pending=amber,
    approved=emerald, changes_requested=red), subject type, reviewer,
    linked task (clickable), and timestamps. Filters for status,
    disposition, and subject type via URL query params. Default filter:
    open reviews. Sortable columns. Empty state when no reviews exist.

    How: TanStack Query for data fetching from GET /api/reviews.
    WebSocket subscription to "reviews:updates" topic for real-time
    invalidation. Use goto() for URL param changes per project conventions.
    Follow existing list page patterns (tasks list, plans list).

    Covers: @review-records-web-ui ac-1, ac-10.

- title: Build review detail page with thread view and revision selector
  slug: task-review-detail-page
  priority: 3
  tags: [web-ui, review]
  spec_ref: "@review-records-web-ui"
  depends_on:
    - "@task-review-list-page"
    - "@task-review-api-threads"
    - "@task-review-api-verdicts"
  description: |
    Create the /reviews/[id] route showing the full review with threads,
    checks, verdicts, disposition, and a revision selector for navigating
    between reviews on the same subject.

    Why: This is the primary review interaction surface — where humans
    read agent findings, see check results, and understand the overall
    review state. Multiple reviews on the same subject (e.g., 6 rounds
    of plan review) need to be navigable as revisions.

    What: Header with review title, lifecycle badge, disposition badge,
    subject info (type, ref, version), and reviewer. Revision dropdown
    listing all reviews for the same subject ordered by creation date.
    Thread list with kind badges (blocker=red, question=amber, nit=gray),
    resolution state, entries with author/timestamp, and markdown
    rendering in bodies. Checks section with pass/fail status and
    staleness indicator. Verdicts with reviewer decisions. Empty states
    for sections with no items.

    How: TanStack Query fetching from GET /api/reviews/:id. For the
    revision selector, query GET /api/reviews?subject-ref=X to find
    sibling reviews. WebSocket subscription for real-time updates. Thread
    entries rendered as a conversation view. Markdown rendering with
    syntax highlighting in code blocks.

    Covers: @review-records-web-ui ac-2, ac-8, ac-9, ac-10, ac-11.

- title: Add review interaction controls (comment, reply, resolve, verdict)
  slug: task-review-interaction
  priority: 3
  tags: [web-ui, review]
  spec_ref: "@review-records-web-ui"
  depends_on:
    - "@task-review-detail-page"
  description: |
    Add interactive controls to the review detail page so users can
    participate in reviews through the UI.

    Why: Without interaction, the UI is read-only. Users need to create
    threads, reply, resolve issues, and submit verdicts — the same
    operations agents do via CLI but through a visual interface.

    What: "Add Comment" button opening a form with body textarea and
    kind selector (blocker/question/nit). Reply button on each thread
    opening an inline reply form. Resolve/Reopen toggle on blocker and
    question threads. Verdict submission panel with decision selector
    (approve/request_changes/comment) and submit button. All controls
    use optimistic updates with TanStack Query mutations.

    How: POST/PATCH to the thread and verdict API endpoints. Mutation
    hooks with optimistic updates following existing patterns. After
    verdict submission, disposition badge updates immediately from the
    response. WebSocket events handle multi-user scenarios (another
    reviewer acting simultaneously).

    Covers: @review-records-web-ui ac-3, ac-4, ac-5, ac-6.

- title: Build code diff viewer with inline commenting
  slug: task-code-diff-viewer
  priority: 3
  tags: [web-ui, review, diff]
  spec_ref: "@review-code-diff-viewer"
  depends_on:
    - "@task-diff-api"
    - "@task-review-detail-page"
    - "@task-review-interaction"
  description: |
    Build the GitHub-style unified diff viewer for code reviews with
    inline comment threading.

    Why: Code reviews need a visual diff to be useful. Showing threads
    as a flat list without diff context is how the review looks today
    via CLI — the web UI should show threads anchored to the code they
    reference, with the full diff visible.

    What: File list sidebar with changed files and diff stats (+/- lines).
    Per-file unified diff with syntax highlighting, old/new line numbers,
    added/deleted/unchanged lines with color coding. Collapsed unchanged
    regions with "show N more lines" buttons. Click-to-comment on any
    diff line (opens inline form that creates code-anchored threads).
    Existing threads rendered inline at their anchor positions. Lazy
    loading for diffs with many files (20+).

    How: Use @git-diff-view/svelte for rendering — it provides native
    Svelte diff components with a widget system (renderWidgetLine) for
    injecting comment thread components between diff lines.
    onAddWidgetClick handles the click-to-comment interaction. extendData
    attaches existing comment threads to their anchor lines. Use
    parse-git-diff on the server (in the diff API) to parse raw git diff
    output into the structured format git-diff-view expects. TanStack
    Query for fetching diff data and comment threads. Lazy file loading
    via intersection observer or expand-on-click.

    Covers: @review-code-diff-viewer ac-1, ac-2, ac-3, ac-4, ac-5, ac-6.

- title: Build structured content viewer for plan/spec reviews
  slug: task-structured-content-viewer
  priority: 3
  tags: [web-ui, review, content]
  spec_ref: "@review-structured-content-viewer"
  depends_on:
    - "@task-diff-api"
    - "@task-review-detail-page"
    - "@task-review-interaction"
  description: |
    Build the content viewer for non-code reviews (plans, specs) with
    section-level inline commenting.

    Why: Plans and specs are the primary review subjects for design work.
    The current CLI experience shows threads in a flat list — the web UI
    should show the actual content with threads anchored to the sections
    they reference.

    What: For plans: render the plan document with identifiable sections
    (specs list, tasks list, implementation notes). For specs: render
    description, acceptance criteria (each AC individually targetable),
    traits, and metadata. Each section has a comment button that creates
    a thread with a structured anchor. Existing threads with structured
    anchors render inline at their referenced section.

    How: Fetch content from GET /api/reviews/:id/content. Parse plan
    markdown into sections (split on ## headings, YAML code blocks).
    Parse spec YAML into structured fields. Render each section as a
    component with a hover-to-comment button. Map structured anchors
    (section + field + anchor-ref) to rendered section positions. Reuse
    the thread rendering components from the review detail page.

    Covers: @review-structured-content-viewer ac-1, ac-2, ac-3, ac-4.

- title: Add review links to task detail page
  slug: task-review-task-integration
  priority: 3
  tags: [web-ui, review]
  spec_ref: "@review-records-web-ui"
  depends_on:
    - "@task-review-api-read"
  description: |
    Show linked reviews on the task detail page so users can navigate
    from a task to its review history.

    Why: When viewing a task in pending_review or needs_work state, the
    user needs to see the review that's driving the workflow — its
    disposition, outstanding blockers, and a link to the full review.

    What: On the task detail page, if the task has review_ref or appears
    in a review's related_refs, show a "Reviews" section with review
    title, disposition badge, and thread summary (e.g., "3 threads,
    1 blocker unresolved"). Each review links to /reviews/[id]. Show
    the current (open) review prominently, with closed reviews collapsed
    as history.

    How: Use the existing task detail page component. Query
    GET /api/reviews?task=@task-ref to find linked reviews. Render as
    a compact card or list section. Follow existing task detail patterns
    for supplementary data sections.

    Covers: @review-records-web-ui ac-7.
```

## Implementation Notes

### Architecture

The daemon API is a thin HTTP layer over existing review library functions.
Key files: parser/reviews.ts (load/save), parser/review-operations.ts
(verdicts, disposition, lifecycle), parser/review-threads.ts (thread CRUD),
review/checks.ts (gate evaluation), review/subject-bindings.ts (version
tracking).

### Diff Viewer Technology

Use @git-diff-view/svelte for the code diff viewer. It provides native
Svelte components with:
- Split/unified views with syntax highlighting (Shiki/lowlight)
- Widget system (renderWidgetLine) for injecting comment threads inline
- onAddWidgetClick for click-to-comment interaction
- extendData for attaching metadata to lines
- Range mode for large diffs (~280ms for 15k lines)
- ~37-40kb bundle (core + svelte + highlighter)

Server-side parsing: use parse-git-diff to parse raw `git diff` output
into structured typed data (files, chunks, changes with line numbers)
that feeds directly into git-diff-view's input format.

For context expansion ("show more lines"), the daemon runs
`git show commit:path` and returns the requested line range.

### Revision Selector UX

Reviews on the same subject are presented as revisions. The revision
dropdown queries for all reviews sharing the same subject-ref (for
plan/spec reviews) or same base-branch/head-branch (for code reviews),
ordered by creation date. This is analogous to GitHub's "Conversation"
tab showing all reviews in chronological order — each review is a
revision of the same conversation.

### WebSocket Events

Follow existing patterns (tasks:updates, inbox:updates). The
"reviews:updates" topic carries mutation type and review ULID for
targeted query invalidation.

### UI Conventions

Disposition colors: pending=amber, approved=emerald,
changes_requested=red. Thread kind colors: blocker=red, question=amber,
nit=gray. Diff colors: added=green, deleted=red, unchanged=default.
Markdown rendering with syntax highlighting in code blocks.
Use goto() for URL state per project conventions.
