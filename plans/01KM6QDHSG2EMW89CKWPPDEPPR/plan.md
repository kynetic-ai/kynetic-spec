# Task Storage Split: Per-Task Directory Architecture

## Specs

```yaml
# ─── Storage Architecture ───

- title: Per-Task Directory Storage
  slug: task-directory-storage
  type: feature
  parent: "@tasks"
  description: |
    Each task is stored as its own directory, with separate files for
    core data and notes. A lean index file contains only the fields
    needed for listing and filtering. Task semantics, CLI surface, and
    schema types visible to consumers are unchanged.
  acceptance_criteria:
    - id: ac-1
      given: |
        A task exists in the system
      when: |
        The task is persisted
      then: |
        The task has its own directory named by its full ULID
    - id: ac-2
      given: |
        A task is persisted
      when: |
        The task directory is examined
      then: |
        Core task data and notes are stored in separate files within
        the directory
    - id: ac-3
      given: |
        A task directory exists
      when: |
        Unknown files or directories are placed within it
      then: |
        The task system ignores them and preserves them across reads
        and writes
    - id: ac-4
      given: |
        A task is deleted
      when: |
        The deletion is persisted
      then: |
        The task's entire directory is removed
    - id: ac-5
      given: |
        A task is deleted
      when: |
        The deletion is persisted
      then: |
        The corresponding index entry is removed in the same atomic
        operation as the directory removal

- title: Task Index File
  slug: task-index-file
  type: requirement
  parent: "@task-directory-storage"
  description: |
    project.tasks.yaml serves as a lean index optimized for listing and
    filtering. It contains only the fields needed to answer list queries
    without reading individual task directories. The index is the
    authoritative source for filterable fields; per-task files are the
    authoritative source for full task data.
  acceptance_criteria:
    - id: ac-1
      given: |
        Tasks exist in the system
      when: |
        The index file is read
      then: |
        Each entry contains only the fields required for listing,
        filtering, and dependency resolution — no notes, history,
        or other detail-only data
    - id: ac-2
      given: |
        A task's filterable field changes (status, priority, tags, etc.)
      when: |
        The mutation is persisted
      then: |
        Both the index entry in project.tasks.yaml and the corresponding
        field in tasks/<ulid>/task.yaml are updated in the same atomic
        operation
    - id: ac-3
      given: |
        A task's non-indexed data changes (notes, history entries)
      when: |
        The mutation is persisted
      then: |
        Only the per-task file is written; the index is not modified
    - id: ac-4
      given: |
        A new task is created
      when: |
        The creation is persisted
      then: |
        A task directory is created with the per-task files
    - id: ac-5
      given: |
        A new task is created
      when: |
        The creation is persisted
      then: |
        An index entry is added in the same atomic operation as the
        directory creation
    - id: ac-6
      given: |
        The index and a per-task file disagree on a filterable field value
      when: |
        The task is loaded for detailed view
      then: |
        The per-task file is authoritative
    - id: ac-7
      given: |
        The index has drifted from per-task files
      when: |
        A rebuild is requested
      then: |
        The index can be fully regenerated from per-task files alone

- title: Per-Task Core Data File
  slug: task-core-data-file
  type: requirement
  parent: "@task-directory-storage"
  description: |
    tasks/<ulid>/task.yaml contains the complete task record excluding
    notes. This includes all current field values plus an append-only
    history section that records field-level changes with metadata.
  acceptance_criteria:
    - id: ac-1
      given: |
        A task's mutable field is modified
      when: |
        The mutation is persisted
      then: |
        The current field value is updated in-place and a history entry
        is appended recording the timestamp, author, command that made
        the change, the field name, the previous value, and the new value
    - id: ac-2
      given: |
        A task is loaded for detailed view
      when: |
        The caller requests activity information
      then: |
        The history section provides a complete audit trail of all field
        changes without requiring version control queries
    - id: ac-3
      given: |
        A history entry is recorded
      when: |
        The entry is read back
      then: |
        The entry includes: timestamp (ISO 8601), author (who made the
        change), command (the kspec command or API call that triggered
        it), and a changes object mapping field names to their previous
        and new values

- title: Per-Task Notes File
  slug: task-notes-file
  type: requirement
  parent: "@task-directory-storage"
  description: |
    tasks/<ulid>/notes.yaml contains the task's append-only notes array,
    stored separately from core task data so that note growth does not
    affect task field reads or history.
  acceptance_criteria:
    - id: ac-1
      given: |
        A note is added to a task
      when: |
        The note is persisted
      then: |
        The note is appended to tasks/<ulid>/notes.yaml; the task.yaml
        file is not modified
    - id: ac-2
      given: |
        A task has no notes
      when: |
        The notes file is read
      then: |
        The file contains an empty notes array or does not exist; both
        are treated as zero notes
    - id: ac-3
      given: |
        A note supersedes a previous note
      when: |
        The superseding note is persisted
      then: |
        The new note is appended with a supersedes reference to the
        original, consistent with existing note supersession semantics

# ─── Task Data Manager ───

- title: Task Data Manager
  slug: task-data-manager
  type: feature
  parent: "@tasks"
  description: |
    A single module that owns all task storage operations. All consumers
    (CLI, API, batch, automation) read and write tasks exclusively
    through this module. It encapsulates the storage format behind a
    consistent interface so callers provide mutations, not I/O strategy.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        Any consumer needs to read or write task data
      when: |
        It interacts with the task data manager
      then: |
        Callers do not know or care about the underlying storage format
    - id: ac-2
      given: |
        A consumer requests a list of tasks
      when: |
        The list is computed
      then: |
        Only index data is read; per-task detail files are not accessed
    - id: ac-3
      given: |
        A consumer requests full details for a specific task
      when: |
        The detail is loaded
      then: |
        The manager assembles the complete task from index and per-task
        files transparently
    - id: ac-4
      given: |
        A consumer provides a task mutation
      when: |
        The mutation is persisted
      then: |
        All affected files, locking, and shadow branch commits are
        handled by the manager as a single coordinated operation
    - id: ac-5
      given: |
        Multiple mutations target different tasks concurrently
      when: |
        They are executed
      then: |
        Non-overlapping mutations proceed without contention
    - id: ac-6
      given: |
        A mutation affects both indexed and non-indexed data
      when: |
        The mutation is persisted
      then: |
        All writes happen within a single atomic operation that either
        all succeed or all roll back
    - id: ac-7
      given: |
        The storage format has not been explicitly activated
      when: |
        The manager reads or writes tasks
      then: |
        The monolithic format is used; the split backend is not
        engaged until explicitly activated
    - id: ac-8
      given: |
        The split storage format has been activated
      when: |
        The manager reads or writes tasks
      then: |
        The split format is used for all operations
    - id: ac-9
      given: |
        Two mutations target the same task concurrently
      when: |
        They are executed
      then: |
        One acquires the lock and proceeds while the other waits; no
        data corruption occurs

- title: Atomic Multi-File Task Writes
  slug: task-atomic-writes
  type: requirement
  parent: "@task-data-manager"
  description: |
    Task mutations that span multiple files (index + task.yaml + notes.yaml)
    must be atomic. All task writes — single or batch — either fully
    succeed or fully roll back.
  acceptance_criteria:
    - id: ac-1
      given: |
        A task mutation requires writing to the index and a per-task file
      when: |
        The write is executed
      then: |
        Both files are written within a single buffered transaction that
        commits atomically to the shadow branch
    - id: ac-2
      given: |
        A write to the per-task file succeeds but the index write fails
      when: |
        The transaction is evaluated
      then: |
        Neither write is persisted; the shadow branch state is unchanged
    - id: ac-3
      given: |
        A batch operation modifies multiple tasks
      when: |
        The batch is executed
      then: |
        All index updates and all per-task file writes are collected in
        the write buffer and flushed as a single shadow branch commit
    - id: ac-4
      given: |
        A single logical operation affects multiple tasks (e.g.
        cancellation with dependency cleanup)
      when: |
        The mutation is persisted
      then: |
        All affected task directories and index entries are written in
        a single atomic operation

- title: Task Listing Performance
  slug: task-listing-performance
  type: requirement
  parent: "@task-data-manager"
  description: |
    Listing and filtering tasks reads only the index file, not individual
    task directories. This keeps list operations fast regardless of how
    many tasks exist or how much data each task contains.
  acceptance_criteria:
    - id: ac-1
      given: |
        A caller requests a filtered list of tasks (by status, tag,
        priority, automation eligibility, or any combination)
      when: |
        The list is computed
      then: |
        Only project.tasks.yaml is read; no per-task directory is accessed
    - id: ac-2
      given: |
        Tasks have extensive notes and history
      when: |
        A filtered task list is requested
      then: |
        The response time is proportional to the number of tasks, not
        the total volume of notes and history across all tasks

- title: Task Detail Loading
  slug: task-detail-loading
  type: requirement
  parent: "@task-data-manager"
  description: |
    Loading a single task's full details reads the index entry plus the
    per-task directory contents. This is the only operation that accesses
    per-task files.
  acceptance_criteria:
    - id: ac-1
      given: |
        A caller requests full details for a specific task
      when: |
        The task is loaded
      then: |
        The manager reads the index entry for filterable fields and the
        per-task directory (task.yaml + notes.yaml) for complete data;
        the result is a unified task object indistinguishable from the
        current monolithic format
    - id: ac-2
      given: |
        A per-task directory is missing but an index entry exists
      when: |
        The task detail is requested
      then: |
        The manager returns the index data with a warning indicating
        the per-task directory is missing; it does not fail silently
        or throw an unrecoverable error

# ─── Activity Timeline ───

- title: In-File Task Activity
  slug: task-activity-in-file
  type: requirement
  parent: "@task-directory-storage"
  description: |
    Task activity is recorded directly in the per-task files rather than
    reconstructed from version control history. Field changes are
    recorded in task.yaml's history section. Note additions are evident
    from notes.yaml entries. The activity timeline is assembled from
    file contents alone.
  acceptance_criteria:
    - id: ac-1
      given: |
        A task's activity timeline is requested
      when: |
        The timeline is assembled
      then: |
        Field changes come from the task's stored history entries and
        note events come from stored note entries; the timeline is
        assembled from persisted data without version control queries
    - id: ac-2
      given: |
        A task has been through multiple status transitions, note additions,
        priority changes, and review linkages
      when: |
        The full activity timeline is requested
      then: |
        All changes are present in chronological order with timestamps,
        authors, commands, and field-level details
    - id: ac-3
      given: |
        A task created before the storage migration has no history entries
      when: |
        The activity timeline is requested
      then: |
        Pre-migration activity may be incomplete; the timeline indicates
        which entries are from stored history versus best-effort recovery

# ─── Storage Activation ───

- title: Task Storage Format Activation
  slug: task-storage-activation
  type: requirement
  parent: "@task-data-manager"
  description: |
    The active storage format is an explicit setting, not auto-detected.
    The system defaults to the monolithic format until activation. This
    ensures the switchover from monolithic to split format is a
    deliberate, coordinated action taken after migration.
  acceptance_criteria:
    - id: ac-1
      given: |
        A project has no explicit storage format setting
      when: |
        The task data manager initializes
      then: |
        The monolithic format is used for all reads and writes
    - id: ac-2
      given: |
        The storage format has been set to split
      when: |
        The task data manager initializes
      then: |
        The split per-task directory format is used for all reads
        and writes
    - id: ac-3
      given: |
        The storage format is set to split but unmigrated tasks exist
        in the monolithic file without corresponding per-task directories
      when: |
        The task data manager initializes
      then: |
        An error indicates that migration must be run before activation
    - id: ac-4
      given: |
        The storage format setting needs to change
      when: |
        The activation command is run
      then: |
        The setting is persisted and takes effect on the next operation
    - id: ac-5
      given: |
        The storage format is set to split and no tasks exist at all
      when: |
        The task data manager initializes
      then: |
        The system operates normally with an empty task set

# ─── Migration ───

- title: Task Storage Migration
  slug: task-storage-migration
  type: feature
  parent: "@tasks"
  traits:
    - trait-dry-run
    - trait-error-guidance
  description: |
    A built-in command to migrate task data from the monolithic format
    to the split per-task directory format. Also handles backfilling
    tasks that were written in legacy format after an initial migration
    (e.g. by an older version of kspec or external tooling).
  acceptance_criteria:
    - id: ac-1
      given: |
        A project has tasks in the monolithic format
      when: |
        The migration command is run
      then: |
        Each task gets its own directory with separate core data and
        notes files
    - id: ac-2
      given: |
        The migration command is run
      when: |
        The migration completes
      then: |
        The index file is rewritten with only the fields needed for
        listing and filtering
    - id: ac-3
      given: |
        The migration command is run with dry-run mode
      when: |
        The preview completes
      then: |
        A summary reports how many tasks would be migrated, total notes
        count, and any issues detected without modifying any files
    - id: ac-4
      given: |
        The migration completes
      when: |
        The resulting data is loaded through the task data manager
      then: |
        Every task has identical field values and notes to the
        pre-migration state
    - id: ac-5
      given: |
        The migration encounters a task with validation errors
      when: |
        The migration processes that task
      then: |
        The task is migrated preserving its raw data with a warning;
        the migration does not fail on individual task issues
    - id: ac-6
      given: |
        The migration is run on a project already in split format
      when: |
        The command detects existing per-task directories
      then: |
        The migration reports that the project is already migrated and
        exits without changes
    - id: ac-7
      given: |
        New tasks were written to the monolithic file after a previous
        migration (e.g. by older tooling)
      when: |
        The migration command is run
      then: |
        Tasks present in the monolithic file but missing from the
        per-task directory structure are backfilled into their own
        directories without affecting existing per-task data
    - id: ac-8
      given: |
        The migration or backfill completes
      when: |
        The shadow branch state is examined
      then: |
        All file changes are committed as a single atomic shadow
        branch commit

- title: Task Index Rebuild
  slug: task-index-rebuild
  type: requirement
  parent: "@task-data-manager"
  traits:
    - trait-dry-run
    - trait-error-guidance
  description: |
    A CLI command to regenerate the task index from per-task directories.
    Serves as both a repair mechanism for index drift and a verification
    tool after migration.
  acceptance_criteria:
    - id: ac-1
      given: |
        Per-task directories exist
      when: |
        An index rebuild is requested
      then: |
        The index file is regenerated by scanning all task directories
        and extracting indexed fields
    - id: ac-2
      given: |
        The rebuilt index differs from the current index
      when: |
        The rebuild completes
      then: |
        The differences are reported to the user
    - id: ac-3
      given: |
        The rebuild is run in repair mode
      when: |
        Differences are found
      then: |
        The index is overwritten with the rebuilt version
    - id: ac-4
      given: |
        No per-task directories exist
      when: |
        An index rebuild is requested
      then: |
        The command reports that no task directories were found and
        suggests running migration first

```

## Tasks

derive_from_specs: false

```yaml
# ─── Phase 1: Foundation ───

- title: Deprecate superseded task specs
  slug: task-deprecate-old-storage-specs
  priority: 1
  tags: [tasks, spec]
  description: |
    Mark the old task storage and activity specs as deprecated before
    implementation begins, signaling that the new specs are the source
    of truth.

    Why: @task-storage, @task-storage-alongside, and @task-storage-separate
    describe the old monolithic storage model — superseded by
    @task-directory-storage. @task-activity-git-query describes the
    git log -L based activity extraction — superseded by
    @task-activity-in-file. Deprecating upfront prevents confusion about
    which specs are authoritative during implementation.

    What: Set maturity to deprecated on all four specs. Set superseded_by
    to the corresponding new spec on each:
    - @task-storage → superseded_by @task-directory-storage
    - @task-storage-alongside → superseded_by @task-directory-storage
    - @task-storage-separate → superseded_by @task-directory-storage
    - @task-activity-git-query → superseded_by @task-activity-in-file

    How: Use kspec item set --maturity deprecated --superseded-by <ref>
    for each spec.

- title: Update activity timeline spec for in-file data source
  slug: task-update-activity-timeline-spec
  priority: 1
  tags: [tasks, spec]
  description: |
    Update the @task-activity-timeline feature spec's ACs to reflect
    that activity is assembled from in-file data, not git history.

    Why: @task-activity-timeline ac-1 says "state transitions recorded
    via shadow branch commits" and ac-2 says "merging shadow branch
    commit history with review record events." After this plan, activity
    comes from in-file history entries and note timestamps — the feature
    still exists but the data source changes. Unlike the child spec
    @task-activity-git-query (which is deprecated), the parent feature
    spec should be updated, not deprecated.

    What: Update ac-1 and ac-2 to say activity comes from stored history
    entries and note records rather than shadow branch commits. Keep the
    behavioral requirements (chronological ordering, review event merging,
    default count, --activity flag) unchanged.

    How: Use kspec item ac set to update the given/when/then clauses on
    ac-1 and ac-2 of @task-activity-timeline. Replace "shadow branch
    commits" with "stored history entries" and "shadow branch commit
    history" with "stored task history and note records."

- title: Implement task data manager module
  slug: task-impl-data-manager
  priority: 1
  tags: [tasks, storage, foundation]
  spec_ref: "@task-data-manager"
  description: |
    Create the task data manager as a single library module that will
    become the exclusive interface for all task I/O operations.

    Why: Task I/O is currently spread across loadAllTasks, saveTask,
    mutateTaskAtomically, and mutateTasksAtomically in yaml.ts, with
    callers managing file paths and locking. The split storage format
    requires coordinated writes across multiple files (index + task.yaml
    + notes.yaml), which is unsustainable if every caller implements
    its own I/O strategy.

    What: Create a TaskDataManager class/module that encapsulates:
    - listTasks(filters): reads only the index, returns summary records
    - getTask(ref): reads index + per-task directory, returns full record
    - createTask(input): writes task directory + index entry atomically
    - mutateTask(ref, mutation): atomic read-modify-write with locking
    - mutateTasks(refs, mutation): batch atomic operation
    - deleteTask(ref): removes directory + index entry atomically
    - addNote(ref, note): writes only to notes.yaml (no index update)

    How: Start by wrapping the existing monolithic file operations behind
    this interface. The initial implementation reads/writes the monolithic
    file — the split format comes later. This lets us migrate all callers
    to the new interface without changing storage format, then swap the
    storage backend independently.

    The interface must support the existing write buffer system for batch
    operations. File locking moves inside the manager — callers no longer
    acquire locks directly.

- title: Migrate CLI task commands to task data manager
  slug: task-migrate-cli
  priority: 1
  tags: [tasks, cli, migration]
  spec_ref: "@task-data-manager"
  depends_on:
    - "@task-impl-data-manager"
  description: |
    Replace all direct yaml.ts task function calls in src/cli/commands/task.ts
    with task data manager calls.

    Why: The CLI is the largest consumer of task I/O — every task
    subcommand (add, set, start, submit, complete, block, cancel, reset,
    note, branch, get, list) calls into yaml.ts directly. These must go
    through the manager before the storage format changes.

    What: For each task CLI command, replace calls to loadAllTasks,
    saveTask, mutateTaskAtomically, mutateTasksAtomically, and deleteTask
    with the corresponding task data manager method. The CLI behavior
    must be identical — same output, same exit codes, same shadow branch
    commits.

    How: Methodical find-and-replace within task.ts. Each command handler
    currently loads context, calls yaml.ts functions, then formats output.
    The load/save calls change; the context and formatting stay the same.
    Run the full test suite after each command migration to catch regressions.

- title: Migrate daemon API to task data manager
  slug: task-migrate-daemon
  priority: 1
  tags: [tasks, daemon, migration]
  spec_ref: "@task-data-manager"
  depends_on:
    - "@task-impl-data-manager"
  description: |
    Replace all direct task loading/saving in the daemon routes with task
    data manager calls.

    Why: The daemon is the second major consumer of task I/O. Its routes
    in packages/daemon/src/routes/tasks.ts call loadAllTasks and saveTask
    directly. These must go through the manager for the same reason as
    the CLI.

    What: Replace direct yaml.ts calls in daemon task routes (GET /api/tasks,
    GET /api/tasks/:ref, POST /api/tasks/:ref/start, /note, /submit,
    /complete, /block) with task data manager methods. The daemon should
    use listTasks for the list endpoint (index-only read) and getTask
    for the detail endpoint (full read).

    How: The daemon already uses initContext() on each route which
    provides the project context. The task data manager receives this
    context and handles all I/O. The daemon routes become thin wrappers:
    validate input, call manager, format response, broadcast WebSocket.

- title: Migrate supporting modules to task data manager
  slug: task-migrate-supporting
  priority: 1
  tags: [tasks, migration]
  spec_ref: "@task-data-manager"
  depends_on:
    - "@task-impl-data-manager"
  description: |
    Replace direct task I/O in all remaining consumers: review-task
    integration, plan derive, validation, alignment, batch execution,
    and dispatch.

    Why: These modules also call loadAllTasks and mutateTaskAtomically
    directly. All task I/O must flow through the manager before the
    storage format can change.

    What: Update imports and calls in:
    - src/parser/review-task-integration.ts (linkReviewToTasks,
      handleVerdictTaskTransition)
    - src/cli/commands/derive.ts (task creation during plan derive)
    - src/parser/validate.ts (task loading for validation)
    - src/parser/align.ts (spec-task alignment)
    - src/cli/batch-exec.ts (batch write buffer integration)
    - Any other files that import task functions from yaml.ts

    How: Same pattern as CLI migration — replace direct calls with
    manager methods. These modules tend to have simpler task interactions
    (load all, find one, mutate one) so the changes are straightforward.

# ─── Phase 2: Split Storage Format ───

- title: Implement split storage backend
  slug: task-impl-split-storage
  priority: 1
  tags: [tasks, storage, foundation]
  spec_ref: "@task-directory-storage"
  depends_on:
    - "@task-migrate-cli"
    - "@task-migrate-daemon"
    - "@task-migrate-supporting"
  description: |
    Create the split storage backend abstraction inside the task data
    manager: format detection, directory layout conventions, and the
    routing logic that decides which files to read/write for each
    operation type. The child tasks (@task-impl-index and
    @task-impl-per-task-files) implement the specific read/write
    operations for each file type.

    Why: All callers now use the task data manager. The internal storage
    can change from monolithic file to split directories without any
    caller modifications.

    What: Implement the storage backend abstraction with:
    - Format detection (monolithic vs split) for dual-format support
    - Directory layout: .kspec/tasks/<full-ulid>/ per task
    - Routing: which operations touch the index, which touch per-task
      files, which touch both
    - Per-task file locking replacing whole-file locking

    The actual index read/write and per-task file read/write operations
    are implemented by the child tasks. This task provides the framework
    they plug into.

    How: Add a storage backend interface to the task data manager. The
    split backend implements format detection (does .kspec/tasks/ exist
    with ULID directories?), directory management, and routing logic.
    Atomic writes use the existing write buffer — buffer all file writes,
    flush as one shadow branch commit.

- title: Implement task index file operations
  slug: task-impl-index
  priority: 1
  tags: [tasks, storage]
  spec_ref: "@task-index-file"
  depends_on:
    - "@task-impl-split-storage"
  description: |
    Implement the index file read/write operations within the split
    storage backend.

    Why: The index is what makes list operations fast. Without it,
    listing tasks requires scanning every task directory and reading
    every task.yaml file.

    What: Define which fields are indexed (ulid, slugs, title, status,
    priority, type, tags, spec_ref, plan_ref, review_ref, depends_on,
    automation, timestamps). Implement index reads for listTasks and
    index writes that keep the index in sync with per-task mutations.

    How: The index is a standard YAML array in project.tasks.yaml with
    the same schema validation as today but fewer fields per entry. On
    mutations that affect indexed fields, the manager reads the index,
    updates the matching entry, writes it back. On note-only mutations,
    the index is untouched. The index write is included in the same
    write buffer transaction as the per-task file writes.

- title: Implement per-task core data and notes files
  slug: task-impl-per-task-files
  priority: 1
  tags: [tasks, storage]
  spec_ref: "@task-core-data-file"
  depends_on:
    - "@task-impl-split-storage"
  description: |
    Implement task.yaml and notes.yaml read/write operations within the
    split storage backend.

    Why: These are the per-task files that replace the monolithic blob.
    task.yaml holds core data plus the append-only history section.
    notes.yaml holds the notes array separately to keep task.yaml small.

    What: task.yaml contains all current task fields minus notes, plus a
    history array. Each history entry has timestamp, author, command,
    and a changes object with field names mapped to previous/new values.
    notes.yaml contains the notes array in the current schema format.

    Note: spec_ref is @task-core-data-file but this task also covers
    @task-notes-file ACs (notes.yaml implementation). Both specs must
    have AC coverage.

    How: On field mutations, update the field in-place and append a
    history entry. On note additions, append to notes.yaml only. On
    task reads, merge task.yaml fields with notes.yaml notes to produce
    the unified task object that callers expect.

- title: Implement in-file activity timeline
  slug: task-impl-activity
  priority: 1
  tags: [tasks, activity]
  spec_ref: "@task-activity-in-file"
  depends_on:
    - "@task-impl-per-task-files"
  description: |
    Replace the git log -L based activity extraction with history entries
    from task.yaml.

    Why: git log -L on the monolithic file takes 35+ seconds for old
    tasks. The in-file history provides instant activity timelines.

    What: Update getRawTaskCommits and normalizeTaskActivity (or their
    replacements) to read history entries from task.yaml instead of
    running git log -L. Merge note timestamps from notes.yaml into the
    timeline. For tasks migrated from the old format, fall back to
    git log -- tasks/<ulid>/ (per-directory git log, which is fast).

    How: The activity module reads task.yaml history entries and
    notes.yaml timestamps, merges them chronologically, and produces
    the same ActivityEntry[] format the CLI and daemon already consume.
    The git log -L codepath is removed. A lightweight git log fallback
    handles pre-migration tasks that lack history entries.

# ─── Phase 3: Atomic Write Support ───

- title: Extend write buffer for multi-file task transactions
  slug: task-extend-write-buffer
  priority: 1
  tags: [tasks, storage, atomicity]
  spec_ref: "@task-atomic-writes"
  depends_on:
    - "@task-impl-split-storage"
  description: |
    Extend the existing write buffer system to handle multi-file task
    transactions where a single logical operation touches the index,
    task.yaml, and notes.yaml.

    Why: A status change that also adds a note must update three files
    atomically (index + task.yaml + notes.yaml). If any write fails,
    none should persist. The existing write buffer handles this for
    batch operations but needs to be the default for all task mutations.

    What: Ensure that every task mutation — not just batch operations —
    uses a write buffer. The manager opens a buffer, queues all file
    writes, then flushes as one shadow branch commit. This replaces the
    current pattern where single-task mutations write files individually.

    How: The task data manager wraps each mutation in a write buffer
    scope. For single-task operations this is lightweight (2-3 files).
    For batch operations the existing batch write buffer continues to
    work — the manager detects when a batch buffer is already active
    and uses it instead of creating a nested one.

- title: Build index rebuild command
  slug: task-build-index-rebuild
  priority: 2
  tags: [tasks, cli]
  spec_ref: "@task-index-rebuild"
  depends_on:
    - "@task-impl-index"
  description: |
    Build the kspec task rebuild-index command that regenerates
    project.tasks.yaml from per-task directories.

    Why: If the index drifts from per-task files (bug, manual edit,
    interrupted write), users need a repair tool. The index is a derived
    cache and must always be rebuildable from authoritative per-task data.

    What: A CLI command that scans .kspec/tasks/*/ directories, reads
    each task.yaml, extracts indexed fields, and writes a fresh
    project.tasks.yaml. Reports differences between the old and new
    index. In repair mode (--repair), overwrites the index. Supports
    --dry-run to preview without writing.

    How: Scan the tasks directory for ULID-named subdirectories. Read
    task.yaml from each. Build the index entries. Compare with the
    current index and report diffs. On --repair, write the rebuilt index
    and commit to shadow branch.

- title: Build migration command
  slug: task-build-migration
  priority: 1
  tags: [tasks, migration, cli]
  spec_ref: "@task-storage-migration"
  depends_on:
    - "@task-impl-index"
    - "@task-impl-per-task-files"
    - "@task-extend-write-buffer"
  description: |
    Build the kspec task migrate command that transforms the monolithic
    project.tasks.yaml into the split per-task directory format, and
    handles backfilling tasks written in legacy format after migration.

    Why: Other users of the project need a supported migration path.
    The command also handles backfill: if older tooling or a previous
    kspec version writes tasks to the monolithic file after an initial
    migration, running migrate again should pick up the new tasks
    without affecting existing per-task directories.

    What: A CLI command that reads the monolithic file, creates per-task
    directories with task.yaml and notes.yaml, rewrites project.tasks.yaml
    as a lean index, and commits everything atomically. Supports dry-run
    mode. On subsequent runs, detects tasks in the monolithic file that
    don't have corresponding per-task directories and backfills them.

    How: Read the current monolithic file. For each task: check if a
    per-task directory already exists (skip if so). Otherwise extract
    notes into notes.yaml, write remaining fields plus an empty history
    array into task.yaml, create the directory. Build the index from
    the extracted filterable fields. Use the write buffer to collect all
    writes, then flush as one shadow branch commit. Dry-run collects
    writes but discards instead of flushing.

    Edge cases: tasks with validation errors are migrated as-is with
    warnings. Tasks with no notes get an empty notes.yaml. Fully
    migrated projects with no monolithic tasks report "already migrated."

    CRITICAL: Agents working on this task must never use npm run dev,
    node dist/, or npm link to run in-progress code against live shadow
    branch data. Always use the globally installed kspec binary for CLI
    operations. All testing must use the test harness with temp fixtures.

# ─── Phase 4: Post-Migration Cleanup (manual only) ───

- title: Activate split storage format
  slug: task-activate-split-storage
  priority: 1
  tags: [tasks, storage, manual]
  spec_ref: "@task-storage-activation"
  depends_on:
    - "@task-build-migration"
  description: |
    Activate the split storage format after migration has been run and
    verified. This is the switchover point — after this, all task writes
    go to the split format.

    Why: The migration command creates the per-task directories but the
    system continues writing to the monolithic format until explicitly
    switched. This task is the deliberate switchover after confirming
    the migration is correct.

    What: Run the activation command to set the storage format to split.
    Verify that subsequent task operations (list, get, add, set, note)
    read from and write to the per-task directory structure. Confirm
    the index stays in sync.

    How: Run the activation command. Exercise the full task lifecycle
    through CLI and daemon API. Verify shadow branch commits show
    per-task file changes rather than monolithic file changes.

    MANUAL ONLY: This task requires human coordination. Migration must
    be run first, all dispatch/agent work must be paused, and the
    switchover must be verified before resuming automated work.

- title: Remove monolithic task file support
  slug: task-remove-monolithic
  priority: 2
  tags: [tasks, cleanup, manual]
  depends_on:
    - "@task-activate-split-storage"
  description: |
    Remove the legacy monolithic file loading path from the task data
    manager after the split format is activated and stable.

    Why: Keeping two storage backends increases complexity and testing
    surface. Once all projects are migrated and activated, the old path
    serves no purpose.

    What: Remove the code that loads tasks from a monolithic array in
    project.tasks.yaml. Remove loadTasksFromFile, extractRawTaskArray,
    writeRawTaskArray, and related helpers. Remove the fallback search
    paths (backlog.tasks.yaml, active.tasks.yaml, etc.). Remove the
    git log -L based activity extraction.

    How: Delete the old codepaths, update tests to use the split format,
    verify the full test suite passes.

    MANUAL ONLY: Must confirm the switchover is stable before removing
    the fallback path.

- title: Purge deprecated spec references
  slug: task-purge-old-storage-refs
  priority: 2
  tags: [tasks, cleanup, manual]
  depends_on:
    - "@task-remove-monolithic"
  description: |
    Remove all remaining references to the deprecated specs from the
    codebase: @task-storage, @task-storage-alongside,
    @task-storage-separate, and @task-activity-git-query.

    Why: After the monolithic code is removed, any AC annotation comments,
    test references, documentation links, or spec cross-references
    pointing to the old specs are stale and misleading.

    What: Search the entire codebase for references to the four
    deprecated spec slugs. Remove AC annotation comments in tests,
    delete tests that only existed to verify old storage or git-based
    activity behavior, update any documentation or other specs that
    reference them.

    How: Grep for task-storage-alongside, task-storage-separate,
    task-storage (exact, not the new task-directory-storage), and
    task-activity-git-query across all source, test, doc, and spec files.
    Remove or update each reference. Verify no broken links remain via
    kspec validate.

    MANUAL ONLY: Final cleanup after confirming the old code and format
    are fully retired.
```

## Implementation Notes

**Phasing is critical.** Phase 1 (deprecation + task data manager + caller migration) starts by deprecating old specs, then is pure refactoring with zero behavior change. Phase 2 (split storage) implements the new backend behind a format flag, defaulting to monolithic. Phase 3 (atomic writes + migration command + index rebuild) ensures multi-file safety and provides the migration and repair tools. Phase 4 (post-migration cleanup) is manual only — activation, old code removal, and reference purging happen after migration is run and verified out-of-band.

**Switchover sequence.** After all automated tasks complete: (1) pause dispatch/agent work, (2) run migration command, (3) verify data integrity, (4) activate split format, (5) exercise task operations, (6) resume automated work. Only then do the Phase 4 cleanup tasks proceed.

**The manager-first approach is key.** By migrating all callers to the task data manager before changing the storage format, the actual storage split becomes a contained change in one module. If the manager interface is right, the storage swap is invisible to all consumers. This is the same pattern as database migrations behind a repository layer.

**Index consistency.** The index is a derived cache. Per-task files are authoritative. The rebuild command is the escape hatch. During normal operation, the manager keeps them in sync through atomic writes. The index should never be written to directly — only through the manager. The "index-only reads" invariant for list operations refers to the logical data source — during batch operations, the write buffer may hold pending index updates that must be visible to subsequent reads within the same batch.

**History entries vs git history.** Going forward, all field changes are recorded as history entries in task.yaml. Git history becomes supplementary (per-task directory commit log), not primary. Pre-migration tasks won't have history entries — the fallback to git log -- tasks/<ulid>/ handles those. This degradation is acceptable because it only applies to historical data that predates the migration.

**Write buffer integration.** The existing WriteBuffer class already supports multi-file atomic writes. The task data manager uses this for every mutation, not just batch operations. The overhead is minimal for single-task operations (buffer 2-3 files, flush immediately). Batch operations continue to use the shared batch buffer.

**Shadow branch commit messages.** With per-task files, shadow branch commit messages should include the task ULID for fast git log --grep lookups. The manager should generate structured commit messages (e.g. "task-start @task-slug 01KJP279: pending → in_progress") that enable future git-based queries without line tracking.

**Testing strategy.** Phase 1 tests verify behavioral equivalence — same inputs produce same outputs through the manager as through direct yaml.ts calls. Phase 2 tests verify the split format produces correct file structures. The full test suite runs after each phase.

**No schema changes.** The TaskSchema, TaskInputSchema, and TasksFileSchema types are unchanged. The manager maps between the external schema (what callers see) and the internal storage format (how files are organized). The history and notes separation is internal to the storage backend.

**Agent safety: never use local kspec builds.** Agents working on this plan must NEVER use `npm run dev`, `node dist/`, or `npm link` to run their in-progress code against live shadow branch data. Always use the globally installed `kspec` binary for any kspec CLI operations. Running partially-implemented storage code against real project data risks corruption. All testing must use the test harness with temp fixtures.
