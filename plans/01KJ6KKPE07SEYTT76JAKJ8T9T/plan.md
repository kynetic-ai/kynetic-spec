# Session Scoping for Kspec

## Context

Ralph loop agents don't stop after completing one task per iteration because there's no reliable enforcement mechanism. The current approach uses a fragile 3-piece system: ralph writes a marker JSON file, a bash hook script reads it and blocks `kspec task start`, and ralph parses ACP tool call output to detect completions. This has multiple failure modes — the marker file can go stale, the bash script depends on jq, and event attribution to the active iteration is unreliable.

The deeper issue is that kspec has no concept of session identity flowing through agent interactions. Ralph creates a session internally, but the spawned agent has no awareness of it. This means:
- Multiple sessions (ralph loops, interactive) can step on each other's tasks
- Hooks can't scope their enforcement to the right session
- There's no way to attribute agent actions to a specific session

**Goal:** Replace the marker file + bash hook system with session-scoped enforcement built into kspec commands themselves. Add a `KSPEC_SESSION_ID` environment variable that flows through agent tool calls, enabling task claiming, budget enforcement, and cross-session coordination — all within the kspec library, no external hooks needed for task limiting.

**Key design decisions:**
- Budget state lives on local filesystem (not shadow branch) to avoid contention
- Single-writer guarantee: ralph resets budget between iterations (agent not running), agent is only writer during its turn
- Enforcement is cooperative — agents that bypass `kspec task start` are not gated
- Interactive sessions get session IDs but no budget (budget is opt-in via `--budget`)
- End-loop marker also migrated to session state
- Sessions always closed on exit, including SIGINT/SIGTERM

## Specs

```yaml
- title: Session creation and env injection
  type: feature
  traits:
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
  description: |
    CLI command and library function to create a kspec session with an optional
    task budget and inject the session ID into the agent's environment via
    KSPEC_SESSION_ID. Harness-specific injection for Claude Code, Codex, OpenCode,
    and Gemini CLI. Fallback to export instructions for unknown harnesses.
    Budget state stored in local filesystem (.kspec/sessions/{id}/budget.json),
    not on shadow branch, to avoid contention between ralph and spawned agents.
  implementation_notes: |
    Add TaskBudgetSchema to src/sessions/types.ts: { max_per_cycle: number,
    started_this_cycle: number }. Budget stored in .kspec/sessions/{id}/budget.json
    (local filesystem, NOT shadow branch). Add incrementBudget(), resetBudget(),
    checkBudget() to src/sessions/store.ts. Add session create subcommand to
    src/cli/commands/session.ts. Reuse detectAgent() from src/cli/commands/setup.ts
    for harness detection. Start with Claude Code (CLAUDE_ENV_FILE or settings.json
    env), add others incrementally.
  acceptance_criteria:
    - id: ac-create
      given: |
        kspec session create --agent-type <type> is run
      when: |
        the command executes
      then: |
        a session is created in .kspec/sessions/{id}/ with status active and the
        session ID is printed to stdout
    - id: ac-budget
      given: |
        --budget N flag is provided
      when: |
        the session is created
      then: |
        budget.json is written with max_per_cycle=N, started_this_cycle=0
    - id: ac-budget-local
      given: |
        budget state is written
      when: |
        budget.json is created or updated
      then: |
        it lives in .kspec/sessions/{id}/budget.json on local filesystem and is
        NOT committed to the shadow branch
    - id: ac-inject-claude
      given: |
        --inject flag with Claude Code detected (CLAUDECODE=1)
      when: |
        the session is created
      then: |
        KSPEC_SESSION_ID=<id> is written to CLAUDE_ENV_FILE if set, or appended to
        project .claude/settings.json env section
    - id: ac-inject-codex
      given: |
        --inject flag with Codex CLI detected (CODEX_SANDBOX)
      when: |
        the session is created
      then: |
        KSPEC_SESSION_ID is added to shell_environment_policy.set in codex config
    - id: ac-inject-fallback
      given: |
        --inject flag with unknown agent harness
      when: |
        the session is created
      then: |
        the command prints export KSPEC_SESSION_ID=<id> for manual sourcing
    - id: ac-library
      given: |
        the library function createSessionWithBudget() is called directly
      when: |
        the function returns
      then: |
        it returns session metadata including the ID without console output
    - id: ac-invalid-session
      given: |
        KSPEC_SESSION_ID is set but points to a nonexistent or corrupt session
      when: |
        any kspec command reads the session
      then: |
        a clear error is shown with the invalid session ID and suggestion to
        unset the env var or create a new session

- title: Session-scoped task claiming
  type: feature
  description: |
    Soft advisory session scoping for task operations. When KSPEC_SESSION_ID is set,
    task start stamps the task with the session ID. Other sessions see claimed tasks
    but can still operate on them. No hard isolation — crashed sessions don't orphan
    tasks. Enforcement is cooperative — agents that bypass kspec task start are not
    gated.
  implementation_notes: |
    Add session_id: z.string().optional() to TaskSchema and TaskInputSchema in
    src/schema/task.ts. Modify task start handler in src/cli/commands/task.ts
    (~line 1068) to read process.env.KSPEC_SESSION_ID and stamp the task.
    Modify tasks ready display in src/cli/commands/tasks.ts (~line 234) and
    session context in src/cli/commands/session.ts to show session indicator.
  acceptance_criteria:
    - id: ac-stamp
      given: |
        KSPEC_SESSION_ID is set in the environment
      when: |
        kspec task start @ref is run
      then: |
        the task's session_id field is set to the session ID value
    - id: ac-display
      given: |
        a task has session_id set to another active session
      when: |
        kspec tasks ready is run
      then: |
        the task shows a visual indicator like [session 01KH...] but remains
        listed in the output
    - id: ac-startable
      given: |
        a task has session_id set to another session
      when: |
        kspec task start @ref is run
      then: |
        the task is started with a warning that it was claimed by another session
    - id: ac-no-env
      given: |
        KSPEC_SESSION_ID is not set
      when: |
        kspec task start @ref is run
      then: |
        behavior is unchanged from current — no session_id stamped on the task
    - id: ac-schema
      given: |
        session_id is added as an optional field to TaskSchema
      when: |
        existing tasks without session_id are loaded
      then: |
        they pass validation without changes (backward compatible)
    - id: ac-claim-clear
      given: |
        a task with session_id returns to pending or needs_work status
      when: |
        the status transition occurs
      then: |
        session_id is cleared so the task is unencumbered for other sessions

- title: Task budget enforcement
  type: feature
  traits:
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
  description: |
    Replaces the marker file + PreToolUse bash hook with enforcement built into kspec
    task start. When a session has a budget configured, kspec task start checks the
    budget before proceeding and increments the counter on success. Ralph resets the
    budget at each iteration boundary. Single-writer guarantee: ralph resets only
    between iterations (agent not running), agent is only writer during its turn.
    Budget only gates task start — review subagents that call task complete do not
    trigger budget logic since they don't start new work.
  implementation_notes: |
    Modify task start in src/cli/commands/task.ts to check budget before proceeding.
    Budget check reads .kspec/sessions/{id}/budget.json. On success, increment
    started_this_cycle. Error message must include budget counts AND wrap-up
    instructions (replaces both the hook block message and ralph's injected prompt).
    This REPLACES: TaskLimitMarker, writeTaskLimitMarker, readTaskLimitMarker,
    clearTaskLimitMarker, clearStaleMarker, detectTaskCompleteCommand,
    ralph-task-limit-guard.sh, AND the ACP prompt injection at ralph.ts:1542-1549.
  acceptance_criteria:
    - id: ac-block-start
      given: |
        session has budget with started_this_cycle >= max_per_cycle
      when: |
        kspec task start is run with KSPEC_SESSION_ID set
      then: |
        the command exits with nonzero code and error message including the budget
        counts (e.g. 1/1 tasks started) and instructions to wrap up current work
        and let the iteration end naturally without starting new tasks
    - id: ac-reset
      given: |
        ralph calls resetBudget() at iteration start
      when: |
        the agent is not running (between iterations)
      then: |
        started_this_cycle is set to 0 in budget.json
    - id: ac-no-session
      given: |
        KSPEC_SESSION_ID is not set
      when: |
        kspec task start is run
      then: |
        no budget check occurs — backward compatible
    - id: ac-no-budget
      given: |
        session exists but has no budget.json
      when: |
        kspec task start is run with KSPEC_SESSION_ID set
      then: |
        no budget check occurs — budget is opt-in (interactive sessions have no
        budget by default)
    - id: ac-increment
      given: |
        kspec task start succeeds with KSPEC_SESSION_ID set and budget configured
      when: |
        the task transitions to in_progress
      then: |
        started_this_cycle is incremented by 1 in budget.json
    - id: ac-atomic-write
      given: |
        budget.json is updated (increment or reset)
      when: |
        the write completes
      then: |
        the file is written atomically (write to temp then rename) to prevent
        corruption on crash
    - id: ac-resume-no-increment
      given: |
        a task is already in_progress and kspec task start is called on it
      when: |
        the task start returns early (already in progress)
      then: |
        budget is not incremented since no new task was started

- title: Session end-loop signal
  type: feature
  traits:
    - "@trait-error-guidance"
  description: |
    Migrate end-loop signaling from marker file (.claude/ralph-end-loop.json) to
    session state. kspec ralph end-loop writes to the session instead of a marker
    file. kspec task start also checks for end-loop signal. Sessions are always
    closed properly on exit, including SIGINT/SIGTERM.
  implementation_notes: |
    Add end_requested field to session metadata or a session-local file
    (.kspec/sessions/{id}/end-loop.json). Modify kspec ralph end-loop to write
    to session state. Modify kspec task start to check for end-loop. Modify
    ralph signal handlers to always close session (update status to abandoned).
    Remove END_LOOP_MARKER_PATH, readEndLoopMarker, clearEndLoopMarker,
    clearStaleEndLoopMarker from ralph.ts.
  acceptance_criteria:
    - id: ac-signal
      given: |
        agent runs kspec ralph end-loop --reason "..." with KSPEC_SESSION_ID set
      when: |
        the command executes
      then: |
        end-loop state is written to the session (not a marker file)
    - id: ac-block-task
      given: |
        end-loop has been signaled for the current session
      when: |
        kspec task start is run with that KSPEC_SESSION_ID
      then: |
        the command exits with error explaining the loop is ending
    - id: ac-detect
      given: |
        ralph checks for end-loop signal
      when: |
        it reads session state between iterations
      then: |
        it detects end_requested and exits the loop gracefully
    - id: ac-session-close-normal
      given: |
        the ralph loop ends normally (no tasks, all done, max iterations)
      when: |
        cleanup runs
      then: |
        session status is updated to completed with reason
    - id: ac-session-close-signal
      given: |
        ralph receives SIGINT or SIGTERM
      when: |
        the signal handler runs
      then: |
        session status is updated to abandoned and process exits
    - id: ac-session-close-error
      given: |
        ralph exits due to max failures or unrecoverable error
      when: |
        cleanup runs
      then: |
        session status is updated to abandoned with error reason
    - id: ac-remove-markers
      given: |
        end-loop is session-scoped
      when: |
        ralph runs
      then: |
        END_LOOP_MARKER_PATH, readEndLoopMarker, clearEndLoopMarker, and
        clearStaleEndLoopMarker are removed from ralph.ts

- title: Native guard commands
  type: feature
  traits:
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
  description: |
    Replace bash shell script hooks with native kspec CLI commands. kspec guard
    worktree replaces kspec-worktree-guard.sh. The task-limit guard hook is removed
    entirely since budget enforcement is now in kspec task start. kspec setup installs
    native commands instead of bash scripts and cleans up old hook entries.
  implementation_notes: |
    New file: src/cli/commands/guard.ts with registerGuardCommands(). Register in
    src/cli/index.ts. Port pattern matching from .claude/hooks/kspec-worktree-guard.sh
    to TypeScript. Update GUARD_SCRIPTS in src/cli/commands/setup.ts to use
    kspec guard worktree. Remove ralph-task-limit-guard.sh from installation.
    Setup must also remove stale PreToolUse entries from .claude/settings.json
    that reference old bash scripts and delete the old script files.
  acceptance_criteria:
    - id: ac-worktree-guard
      given: |
        kspec guard worktree is called with PreToolUse hook JSON on stdin
      when: |
        the command reads tool_input.command and cwd
      then: |
        it blocks commands that delete kspec-meta branch, create/checkout branches
        in .kspec/, or run dangerous git operations (reset, rebase, stash, clean)
        in .kspec/ — same patterns as kspec-worktree-guard.sh
    - id: ac-worktree-allow
      given: |
        kspec guard worktree receives a non-git or safe command
      when: |
        the command processes the input
      then: |
        it outputs {"decision": "allow"} and exits 0
    - id: ac-setup-native
      given: |
        kspec setup is run on a project
      when: |
        hooks are installed to .claude/settings.json
      then: |
        PreToolUse references kspec guard worktree command (not bash scripts)
    - id: ac-no-task-limit-hook
      given: |
        kspec setup is run after this change
      when: |
        hooks are installed
      then: |
        no task-limit guard hook is installed (enforcement is in kspec task start)
    - id: ac-migrate-hooks
      given: |
        existing .claude/settings.json has PreToolUse entries referencing old
        bash scripts (.claude/hooks/ralph-task-limit-guard.sh or
        .claude/hooks/kspec-worktree-guard.sh)
      when: |
        kspec setup is run
      then: |
        old entries are replaced with native command entries and old bash script
        files in .claude/hooks/ are deleted
    - id: ac-idempotent
      given: |
        kspec setup is run multiple times
      when: |
        hooks are already installed with native commands
      then: |
        no duplicate PreToolUse entries are created

- title: Ralph session budget integration
  type: feature
  description: |
    Integrate session budget into the ralph loop, replacing marker file management
    and ACP output parsing for task completion detection. Ralph creates sessions with
    budget, resets budget per iteration, and passes KSPEC_SESSION_ID to spawned agents.
    Major simplification of the ralph main loop. Also removes end-loop marker logic
    in favor of session-scoped end-loop signal.
  implementation_notes: |
    Key file: src/cli/commands/ralph.ts. Remove: TaskLimitMarker type,
    writeTaskLimitMarker, readTaskLimitMarker, clearTaskLimitMarker, clearStaleMarker,
    detectTaskCompleteCommand, TASK_LIMIT_MARKER_PATH, END_LOOP_MARKER_PATH,
    readEndLoopMarker, clearEndLoopMarker, clearStaleEndLoopMarker, the ACP update
    handler block that detects completions and injects wrap-up prompts (lines 1517-1557),
    marker-related signal handler cleanup. Add: budget creation at session create
    (~line 1237), resetBudget() call at iteration start (~line 1317), KSPEC_SESSION_ID
    in spawn env options, session close in all exit paths including signal handlers.
  acceptance_criteria:
    - id: ac-create-budget
      given: |
        ralph starts a loop with --max-tasks N
      when: |
        it creates the session
      then: |
        budget.json is written with max_per_cycle=N in the session directory
    - id: ac-reset-iteration
      given: |
        ralph starts a new iteration
      when: |
        it prepares the iteration context (agent is not running)
      then: |
        it calls resetBudget() to set started_this_cycle=0
    - id: ac-env-inject
      given: |
        ralph spawns an agent for an iteration
      when: |
        the agent process starts
      then: |
        KSPEC_SESSION_ID is set in the agent's environment variables
    - id: ac-remove-marker-code
      given: |
        budget and end-loop enforcement is session-scoped
      when: |
        ralph runs
      then: |
        all marker file code (task-limit and end-loop), detectTaskCompleteCommand,
        and ACP prompt injection for task limits are removed from ralph.ts
    - id: ac-session-close-all-paths
      given: |
        the ralph loop ends for any reason (normal exit, no tasks, max failures,
        SIGINT, SIGTERM, uncaught error)
      when: |
        cleanup runs
      then: |
        session status is updated (completed for normal, abandoned for error/signal)
        and budget.json is cleaned up
```

## Tasks

```yaml
- title: Extend session schema with task budget
  spec_ref: "@session-creation-and-env-injection"
  description: |
    Add TaskBudgetSchema to src/sessions/types.ts. Budget stored in local filesystem
    at .kspec/sessions/{id}/budget.json (NOT shadow branch). Add incrementBudget(),
    resetBudget(), checkBudget() functions to src/sessions/store.ts. Atomic writes
    via write-to-temp-then-rename pattern. Single-writer guarantee documented.
  tags: [schema, sessions]

- title: Add session_id to task schema
  spec_ref: "@session-scoped-task-claiming"
  description: |
    Add optional session_id field to TaskSchema and TaskInputSchema in
    src/schema/task.ts. Single line addition: session_id: z.string().optional().
    Clear session_id on status transitions back to pending or needs_work.
  tags: [schema, tasks]

- title: Implement session create command
  spec_ref: "@session-creation-and-env-injection"
  description: |
    Add session create subcommand to src/cli/commands/session.ts. Creates session
    with optional --budget flag. Returns session ID on stdout. Also exposes
    createSessionWithBudget() library function for ralph to call directly.
    Include validation for invalid/stale KSPEC_SESSION_ID with clear error messages.
  tags: [cli, sessions]

- title: Add budget enforcement to task start
  spec_ref: "@task-budget-enforcement"
  description: |
    Modify task start handler (~line 1068 in src/cli/commands/task.ts) to check
    session budget before proceeding. Read KSPEC_SESSION_ID from process.env, read
    budget.json, check started_this_cycle vs max_per_cycle. On success increment
    counter. Error message must include budget counts AND wrap-up instructions
    (replaces both hook block message and ralph prompt injection). Skip increment
    when task is already in_progress (resume case). Also stamp session_id on task.
  tags: [cli, tasks, enforcement]

- title: Add session indicator to tasks ready
  spec_ref: "@session-scoped-task-claiming"
  description: |
    Modify tasks ready output in src/cli/commands/tasks.ts (~line 234) and session
    context in src/cli/commands/session.ts to show session indicator when tasks have
    session_id from another active session. Tasks remain visible and startable.
  tags: [cli, tasks]

- title: Migrate end-loop to session state
  spec_ref: "@session-end-loop-signal"
  description: |
    Replace end-loop marker file (.claude/ralph-end-loop.json) with session-scoped
    state. Modify kspec ralph end-loop to write to session state. Modify kspec task
    start to also check end-loop signal. Ensure sessions are always closed on exit
    including SIGINT/SIGTERM — signal handlers must update session status to abandoned.
    Remove END_LOOP_MARKER_PATH, readEndLoopMarker, clearEndLoopMarker,
    clearStaleEndLoopMarker from ralph.ts.
  tags: [ralph, sessions]

- title: Implement native worktree guard
  spec_ref: "@native-guard-commands"
  description: |
    Port kspec-worktree-guard.sh logic to TypeScript as kspec guard worktree command.
    New file: src/cli/commands/guard.ts. Register in src/cli/index.ts. Reads
    PreToolUse hook JSON from stdin. Blocks: kspec-meta branch deletion,
    branch creation/checkout in .kspec/, dangerous git ops (reset, rebase, stash,
    clean) in .kspec/. Allows everything else.
  tags: [cli, guards]

- title: Update setup with migration cleanup
  spec_ref: "@native-guard-commands"
  description: |
    Update GUARD_SCRIPTS in src/cli/commands/setup.ts to use kspec guard worktree
    instead of bash scripts. Remove ralph-task-limit-guard.sh from installation.
    Add migration logic: detect old PreToolUse entries in .claude/settings.json
    referencing bash scripts, replace with native commands, delete old script files.
    Ensure idempotent — no duplicate entries on re-run.
  tags: [cli, setup]

- title: Simplify ralph with session budget
  spec_ref: "@ralph-session-budget-integration"
  description: |
    Major refactor of src/cli/commands/ralph.ts. Create session with budget at loop
    start (~line 1237). Reset budget at each iteration start (~line 1317). Pass
    KSPEC_SESSION_ID to spawned agents via env. Remove ALL marker file code (both
    task-limit and end-loop), detectTaskCompleteCommand, ACP prompt injection block
    (lines 1517-1557), stale marker cleanup, and marker-related signal handler
    cleanup. Ensure session close in ALL exit paths including signal handlers.
  tags: [ralph, sessions]

- title: Add multi-harness env injection
  spec_ref: "@session-creation-and-env-injection"
  description: |
    Implement --inject flag for kspec session create with per-harness environment
    variable injection. Reuse detectAgent() from src/cli/commands/setup.ts. Claude
    Code via CLAUDE_ENV_FILE or settings.json env. Codex via config.toml. Fallback
    to export instructions for unknown harnesses. Start with Claude Code (best
    documented), add others incrementally.
  tags: [cli, sessions, multi-harness]
```

## Implementation Notes

### Key Files
- `src/sessions/types.ts` — Extend with TaskBudgetSchema
- `src/sessions/store.ts` — Add budget CRUD functions (local filesystem, not shadow)
- `src/schema/task.ts` — Add optional session_id
- `src/cli/commands/task.ts` — Budget enforcement in task start, session_id stamping
- `src/cli/commands/tasks.ts` — Session indicator in tasks ready display
- `src/cli/commands/session.ts` — New create command, session context display
- `src/cli/commands/ralph.ts` — Major simplification (~150+ lines removed)
- `src/cli/commands/guard.ts` — New native guard commands
- `src/cli/commands/setup.ts` — Update hook installation with migration cleanup

### What Gets Removed
- `.claude/hooks/ralph-task-limit-guard.sh` — Replaced by budget enforcement in kspec task start
- `.claude/hooks/kspec-worktree-guard.sh` — Replaced by kspec guard worktree
- `TaskLimitMarker` type and all marker file functions in ralph.ts
- `detectTaskCompleteCommand()` in ralph.ts
- ACP prompt injection for task limits (ralph.ts lines 1542-1549)
- End-loop marker file functions in ralph.ts
- Stale marker cleanup logic in ralph iteration loop
- Marker-related signal handler cleanup

### Architecture: Budget State Location
Budget state lives in `.kspec/sessions/{id}/budget.json` on the local filesystem, NOT on the shadow branch. This avoids git contention between ralph (which writes session events) and spawned agents (which run kspec commands that commit to kspec-meta). The single-writer guarantee ensures correctness: ralph resets budget only between iterations when the agent is not running.

### Backward Compatibility
- All schema changes are additive (optional fields)
- Sessions without KSPEC_SESSION_ID work exactly as today
- Sessions without budget.json skip enforcement
- Existing tasks without session_id pass validation
- Invalid KSPEC_SESSION_ID produces clear error with recovery instructions

### Testing Strategy
- Unit tests for budget schema validation and CRUD (atomic writes)
- CLI integration tests for task start with budget enforcement (setupTempFixtures + kspec helper)
- CLI integration tests for session create command
- CLI integration tests for invalid/stale session ID handling
- Port existing guard test patterns to native command tests
- Ralph loop tests verifying marker file code is gone and budget integration works
- E2E test for full budget round-trip: ralph creates session → agent starts task → completes → tries second start → blocked
- Migration test: existing settings.json with old hooks → kspec setup → hooks replaced

### Risk: Node.js Startup for Guard Hook
The native `kspec guard worktree` command runs on every Bash tool call. Node.js startup adds ~100-200ms latency vs ~10ms for the bash script. If this is problematic, we could keep a thin bash wrapper that does the fast-path check (is the command even git-related?) and only invokes kspec for the actual guard logic. Monitor after implementation.
