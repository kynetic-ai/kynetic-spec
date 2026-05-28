# Reactive Agent Runtime

Replace the batch-loop ralph architecture with a reactive, event-driven agent dispatch system integrated into the existing daemon. Agents are defined declaratively in `.kspec/kynetic.meta.yaml` with dispatch rules that match task state changes. Each dispatch creates an isolated session. The `kspec agent` command family replaces `kspec ralph`.

## Specs

```yaml
- title: Agent Definition Schema
  slug: agent-definition-schema
  type: feature
  parent: "@meta"
  description: |
    Extend the existing AgentSchema in kynetic.meta.yaml with dispatch rules,
    adapter reference, skill configuration, budget/limit defaults, and
    concurrency settings. Each agent definition is a declarative description
    of when and how to spawn an ACP agent. Includes CLI commands for
    managing agent definitions (add, set, remove).
  traits:
    - "@trait-json-output"
    - "@trait-shadow-commit"
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent definition exists in kynetic.meta.yaml with an adapter field
      when: |
        The meta manifest is loaded and validated
      then: |
        The adapter field is accepted as a string — it may reference a
        registered adapter or an ad-hoc npx package name, matching the
        existing resolveAdapter behavior
    - id: ac-2
      given: |
        An agent definition includes a dispatch array
      when: |
        Each entry specifies an event type (task.ready, task.needs_work,
        task.pending_review) and optional filters
      then: |
        The dispatch rules are parsed and validated by the Zod schema
    - id: ac-3
      given: |
        An agent definition includes filter objects in dispatch rules
      when: |
        Filters specify automation status, tags, or priority constraints
      then: |
        Each filter field is validated independently against its expected
        type (automation: string enum, tags: string array, priority: number)
    - id: ac-4
      given: |
        An agent definition includes budget fields (max_tasks, timeout_minutes)
      when: |
        The schema is validated
      then: |
        Budget fields are accepted as optional positive numbers with no
        required minimum
    - id: ac-5
      given: |
        An agent definition includes a skills array referencing skill slugs
      when: |
        The schema is validated
      then: |
        Skills are accepted as a string array — resolution happens at
        dispatch time, not validation time
    - id: ac-6
      given: |
        An agent definition includes concurrency settings (max_concurrent)
      when: |
        The schema is validated
      then: |
        max_concurrent is accepted as a positive integer defaulting to 1
    - id: ac-7
      given: |
        An agent definition includes an auto_approve boolean
      when: |
        The schema is validated
      then: |
        auto_approve defaults to false when omitted
    - id: ac-8
      given: |
        Existing agent definitions in meta lack the new dispatch/adapter fields
      when: |
        The meta manifest is loaded
      then: |
        The schema validates successfully with all new fields using their
        defaults (dispatch: [], adapter: undefined, skills: [],
        budget: undefined, concurrency: {max_concurrent: 1},
        auto_approve: false)
    - id: ac-9
      given: |
        A user runs kspec meta add agent with required fields
      when: |
        The command executes
      then: |
        A new agent definition is added to kynetic.meta.yaml with
        a generated ULID and the provided configuration
    - id: ac-10
      given: |
        A user runs kspec meta set agent <id> with updated fields
      when: |
        The agent definition exists
      then: |
        The specified fields are updated while preserving unmodified fields
    - id: ac-11
      given: |
        A user runs kspec meta remove agent <id>
      when: |
        The agent definition exists
      then: |
        The agent definition is removed from kynetic.meta.yaml
  implementation_notes: |
    Extend AgentSchema in src/schema/meta.ts. Add dispatch (array of
    {on, filter?}), adapter (string), skills (string[]), budget ({max_tasks?,
    timeout_minutes?}), concurrency ({max_concurrent?}), auto_approve (boolean),
    and prompt_template (string?) fields. All new fields optional for backward
    compatibility. CRUD uses existing meta add/set/remove patterns.

- title: Session Model Evolution
  slug: session-model-evolution
  type: feature
  parent: "@core"
  description: |
    Extend SessionMetadata with trigger source, agent definition reference,
    and structured completion tracking. Extend SessionStatusSchema with
    timed_out and failed statuses. Each agent invocation creates its own
    session rather than sharing one session across a loop of iterations.
    Backward compatible with existing sessions.
  acceptance_criteria:
    - id: ac-1
      given: |
        A session is created for an agent invocation
      when: |
        The session metadata is written
      then: |
        It includes trigger (event type that caused dispatch), agent_id
        (reference to agent definition), and task_id (the task being
        worked on) fields
    - id: ac-2
      given: |
        A session was created by the old ralph system without trigger/agent_id
      when: |
        The session is read by any session command
      then: |
        trigger defaults to "legacy" and agent_id defaults to the
        agent_type value — no error is raised
    - id: ac-3
      given: |
        SessionStatusSchema currently allows active, completed, abandoned
      when: |
        The schema is extended
      then: |
        timed_out and failed are added as valid status values
    - id: ac-4
      given: |
        New event types agent.dispatched, agent.started, agent.completed,
        agent.failed, agent.timeout are defined
      when: |
        Events with these types are appended to a session log
      then: |
        The EventTypeSchema accepts them without error
    - id: ac-5
      given: |
        An agent invocation completes a task
      when: |
        The completion is recorded
      then: |
        A structured agent.completed event is appended with task_id,
        outcome (success, blocked, failed), and duration_ms fields
    - id: ac-6
      given: |
        kspec session log list is run
      when: |
        Sessions from both old ralph and new agent runtime exist
      then: |
        Legacy sessions show type "loop" and new sessions show type
        "invocation" in the output
    - id: ac-7
      given: |
        kspec session log show is run on a new-style invocation session
      when: |
        The session contains agent.* events
      then: |
        The events are rendered with human-readable formatting matching
        the existing event display patterns
  implementation_notes: |
    Extend SessionMetadataSchema in src/sessions/types.ts. Add trigger
    (enum: manual, task.ready, task.needs_work, task.pending_review, legacy),
    agent_id (string), as optional fields. Use existing task_id field for
    task reference (not a new task_ref — maintains backward compat). Extend
    SessionStatusSchema with timed_out, failed. Extend EventTypeSchema
    with new agent.* event types. Update session log list/show rendering
    to distinguish session types.

- title: Agent Invocation Lifecycle
  slug: agent-invocation-lifecycle
  type: feature
  parent: "@cli"
  description: |
    Per-invocation session creation, ACP agent spawn, prompt delivery,
    event logging, timeout handling, and structured completion tracking.
    Each dispatch creates an isolated session with its own event log and
    metadata. This is the core building block used by both the dispatch
    engine and CLI one-shot mode.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent is dispatched for a task
      when: |
        The invocation starts
      then: |
        A new session is created with trigger, agent_id, task_id, and
        adapter metadata populated in session.yaml
    - id: ac-2
      given: |
        A session is created for an agent invocation
      when: |
        The ACP agent is spawned
      then: |
        KSPEC_SESSION_ID is injected into the agent environment using
        the existing harness-specific injection (Claude Code, Codex, etc.)
    - id: ac-3
      given: |
        An agent invocation is running
      when: |
        The configured timeout_minutes is reached
      then: |
        The ACP client sends a cancel request, the session is closed
        with status timed_out, and a timeout note is added to the task
    - id: ac-4
      given: |
        An agent invocation completes successfully
      when: |
        The ACP session ends with stop reason end_turn
      then: |
        The session is closed with status completed and an
        agent.completed event is logged with structured outcome data
    - id: ac-5
      given: |
        An agent invocation fails with a process crash or ACP error
      when: |
        The failure is detected
      then: |
        The session is closed with status failed, an agent.failed
        event is logged with the error details, and the task receives
        a failure note
    - id: ac-6
      given: |
        An agent invocation produces streaming output via ACP updates
      when: |
        Session updates arrive from the ACP client
      then: |
        Events are logged to the session JSONL file with blob
        externalization applied to oversized payloads
    - id: ac-7
      given: |
        The prompt is built for an agent invocation
      when: |
        The agent definition specifies skills
      then: |
        Skills are resolved from the skill registry and their content
        is included in the prompt sent to the agent
    - id: ac-8
      given: |
        An agent invocation completes (success or failure)
      when: |
        Cleanup runs
      then: |
        The adapter env injection is restored to its previous state
        and the ACP agent process is terminated if still running
    - id: ac-9
      given: |
        An agent encounters consecutive failures on the same task
      when: |
        The failure count reaches the agent's configured retry limit
      then: |
        The task is blocked with a failure note describing the
        consecutive failures and the agent definition that failed
  implementation_notes: |
    Extract reusable prompt building from src/cli/commands/ralph.ts into
    src/agent-runtime/prompts.ts. Extract tool request handling and streaming
    into src/agent-runtime/invocation.ts. Reuse existing session store
    (src/sessions/store.ts), ACP client (src/acp/client.ts), and agent
    spawner (src/agents/spawner.ts). The invocation module is the core
    unit — dispatch engine and CLI one-shot both call into it.

- title: Agent Dispatch Engine
  slug: agent-dispatch-engine
  type: feature
  parent: "@cli"
  description: |
    Core dispatch runtime that runs inside the daemon. Watches for task
    state changes via both file watcher events and direct API event
    emission from CLI commands. Matches state changes against agent
    dispatch rules, queues invocations, manages concurrency, and handles
    deduplication of events from dual sources. Serializes shadow branch
    mutations when multiple agents run concurrently.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        A task transitions to a state matching an agent's dispatch rule
      when: |
        The state change is detected via file watcher or API event
      then: |
        The matching agent is queued for dispatch with the triggering
        task reference and event metadata
    - id: ac-2
      given: |
        Multiple agent definitions match the same state change
      when: |
        Dispatch rules overlap
      then: |
        Each matching agent is queued independently, creating separate
        sessions
    - id: ac-3
      given: |
        An agent's max_concurrent limit is reached
      when: |
        A new dispatch trigger fires for that agent
      then: |
        The invocation is queued FIFO and dispatched when a slot opens
    - id: ac-4
      given: |
        The dispatch engine is running
      when: |
        A CLI command mutates task state (e.g. kspec task submit)
      then: |
        The CLI posts a state change event to the daemon and the
        engine processes it
    - id: ac-5
      given: |
        The dispatch engine is running
      when: |
        The file watcher detects a change in project.tasks.yaml
      then: |
        The engine diffs previous vs current task states and emits
        state change events for any transitions found
    - id: ac-6
      given: |
        A dispatch rule includes filters (automation status, tags)
      when: |
        A state change matches the event type
      then: |
        The task is checked against all filters and the agent is only
        queued if every filter matches
    - id: ac-7
      given: |
        The same state transition is detected by both the file watcher
        and a CLI API event
      when: |
        Both events arrive within a short window
      then: |
        The dispatch engine deduplicates them using a (task_id,
        from_state, to_state) tuple with a time window, dispatching
        only once
    - id: ac-8
      given: |
        The dispatch engine starts (daemon startup or explicit start)
      when: |
        Tasks already exist in states matching dispatch rules
      then: |
        The engine evaluates all current task states against dispatch
        rules and queues any matching agents (bootstrap/catch-up)
    - id: ac-9
      given: |
        The dispatch engine encounters a transient error during spawn
      when: |
        The error is an adapter timeout or process crash
      then: |
        The invocation is retried up to the agent's configured retry
        count with exponential backoff
    - id: ac-10
      given: |
        An agent definition's adapter reference cannot be resolved
      when: |
        The dispatch engine attempts to spawn the agent
      then: |
        An error is logged with the unresolvable adapter ID, the
        invocation is skipped, and a note is added to the task
    - id: ac-11
      given: |
        The dispatch engine is stopped (daemon shutdown or explicit stop)
      when: |
        Active agent invocations exist
      then: |
        Running agents receive graceful cancel signals and all sessions
        are closed before the engine reports shutdown complete
    - id: ac-12
      given: |
        Multiple agents are running concurrently (max_concurrent > 1)
      when: |
        Both agents attempt shadow branch mutations (e.g. kspec task note)
      then: |
        The dispatch engine serializes shadow branch commit operations
        to prevent worktree corruption from concurrent git commits
  implementation_notes: |
    New module at src/agent-runtime/dispatch.ts. In-memory queue with
    configurable concurrency. Event deduplication via a Map of recent
    (task_id, from_state, to_state) tuples with TTL (e.g. 2 seconds).
    Bootstrap on start: load all tasks, evaluate dispatch rules, queue
    matches. Shadow branch serialization: wrap kspec CLI mutations in
    a queue/lock when concurrent agents are running. Task state diffing
    stores previous parsed states in memory, compares on file change.

- title: CLI Agent Commands
  slug: cli-agent-commands
  type: feature
  parent: "@cli"
  description: |
    New kspec agent command family for managing and running agents.
    Includes list, run (one-shot), dispatch start/stop, and status.
    One-shot invocations use the same session model as dispatched agents.
  traits:
    - "@trait-json-output"
    - "@trait-semantic-exit-codes"
    - "@trait-error-guidance"
    - "@trait-dry-run"
    - "@trait-filterable-list"
  acceptance_criteria:
    - id: ac-1
      given: |
        Agent definitions exist in meta
      when: |
        kspec agent list is run
      then: |
        All agent definitions are listed with id, adapter, dispatch
        rules summary, and concurrency settings
    - id: ac-2
      given: |
        An agent definition exists with id "worker"
      when: |
        kspec agent run worker --task @task-ref is run
      then: |
        A one-shot invocation is created using the agent's adapter and
        configuration, targeted at the specified task, with a full
        session created and logged
    - id: ac-3
      given: |
        An agent definition exists
      when: |
        kspec agent run <name> "custom prompt text" is run without --task
      then: |
        A one-shot invocation is created with the provided prompt and
        no task binding in the session metadata
    - id: ac-4
      given: |
        The daemon is running
      when: |
        kspec agent dispatch start is run
      then: |
        The dispatch engine begins watching for state changes and
        dispatching agents per their rules
    - id: ac-5
      given: |
        The dispatch engine is running
      when: |
        kspec agent dispatch stop is run
      then: |
        The dispatch engine stops accepting new triggers, waits for
        active invocations to complete, then shuts down
    - id: ac-6
      given: |
        Agent invocations are running or queued
      when: |
        kspec agent status is run
      then: |
        Active invocations and queued invocations are displayed with
        session IDs, agent names, task refs, and elapsed time
    - id: ac-7
      given: |
        kspec agent run is used with --budget, --timeout, or --adapter
      when: |
        These flags differ from the agent definition defaults
      then: |
        The invocation uses the CLI-specified values, overriding the
        definition defaults for this invocation only
    - id: ac-8
      given: |
        kspec agent run is used with --dry-run
      when: |
        The command is executed
      then: |
        The prompt that would be sent is displayed without spawning
        the agent process
    - id: ac-9
      given: |
        kspec agent dispatch status is run
      when: |
        The daemon is running
      then: |
        Shows whether dispatch is enabled, number of active and queued
        invocations, and loaded agent definitions
    - id: ac-10
      given: |
        The daemon is not running
      when: |
        kspec agent dispatch start is run
      then: |
        An error message explains that the daemon must be running and
        suggests kspec serve to start it
  implementation_notes: |
    New command registration at src/cli/commands/agent.ts. Follow existing
    command patterns. The run subcommand reuses agent-invocation-lifecycle
    for session creation and ACP spawn. dispatch start/stop communicates
    with the daemon via HTTP API (POST /api/agent/dispatch).

- title: Daemon Agent Dispatch Integration
  slug: daemon-agent-dispatch
  type: feature
  parent: "@daemon-server"
  description: |
    Agent dispatch API routes in the daemon, enhanced file watcher with
    task state diffing for change detection, CLI event emission endpoint,
    and WebSocket broadcasts for agent invocation status.
  traits:
    - "@trait-api-endpoint"
    - "@trait-localhost-security"
    - "@trait-websocket-protocol"
  acceptance_criteria:
    - id: ac-1
      given: |
        The daemon is running with dispatch enabled
      when: |
        The file watcher detects a change in project.tasks.yaml
      then: |
        The watcher parses the new task states, diffs against the
        previously cached states, and emits state change events to
        the dispatch engine for each detected transition
    - id: ac-2
      given: |
        A CLI command changes task state (e.g. kspec task start)
      when: |
        The daemon is running
      then: |
        The CLI posts a JSON event to POST /api/agent/events containing
        task_id, previous_status, new_status, and timestamp
    - id: ac-3
      given: |
        The daemon receives a state change event matching dispatch rules
      when: |
        The dispatch engine processes it
      then: |
        The agent is dispatched and a status event is broadcast on the
        agents WebSocket topic
    - id: ac-4
      given: |
        A WebSocket client subscribes to agent status updates
      when: |
        An agent invocation starts, completes, or fails
      then: |
        A broadcast event is sent containing session_id, agent_id,
        task_id, status, and timestamp
    - id: ac-5
      given: |
        GET /api/agent/status is called
      when: |
        The dispatch engine is running
      then: |
        Returns JSON with active invocations array, queue depth number,
        dispatch_enabled boolean, and agent_definitions array
    - id: ac-6
      given: |
        POST /api/agent/dispatch is called with action start or stop
      when: |
        The request is from localhost
      then: |
        The dispatch engine starts or stops and returns JSON with the
        new dispatch_enabled state
    - id: ac-7
      given: |
        The daemon is not running
      when: |
        A CLI command changes task state
      then: |
        The event emission POST fails silently with no error to the
        user — dispatch requires a running daemon
  implementation_notes: |
    New route file at packages/daemon/src/routes/agents.ts following
    existing route patterns (createAgentRoutes). Enhanced watcher needs
    a TaskStateDiffCache class that stores last-known parsed task states
    and computes diffs on change. CLI event POST is fire-and-forget
    with a short timeout (1s). WebSocket broadcasts use existing
    pubsub infrastructure with a new "agents" topic.

- title: Ralph Replacement
  slug: ralph-replacement
  type: feature
  parent: "@cli"
  description: |
    Remove the kspec ralph command entirely and replace with equivalent
    kspec agent functionality. Provide built-in agent definitions that
    replicate ralph worker and reviewer behavior. Update all workflows,
    skills, agent instruction templates, and tests that reference ralph.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        A user runs kspec ralph
      when: |
        The ralph command has been removed
      then: |
        An error message explains that ralph has been replaced by
        kspec agent and lists the equivalent commands for common
        ralph operations (run, end-loop, dry-run)
    - id: ac-2
      given: |
        A project has no custom agent definitions
      when: |
        kspec setup is run
      then: |
        Built-in worker and reviewer agent definitions are created
        in kynetic.meta.yaml with default dispatch rules matching
        ralph's behavior (worker: task.ready + task.needs_work with
        automation: eligible filter; reviewer: task.pending_review)
    - id: ac-3
      given: |
        The built-in worker and reviewer agents are configured
      when: |
        Dispatch is enabled and tasks transition through states
      then: |
        Tasks flow through the same lifecycle as ralph: worker picks
        up ready tasks, reviewer handles pending_review, needs_work
        cycles back to worker
    - id: ac-4
      given: |
        Workflow definitions reference ralph concepts (task-work-loop,
        pr-review-loop, session-reflect-loop)
      when: |
        The migration is complete
      then: |
        Workflows are updated to reference agent dispatch concepts
        and the updated workflow IDs are regenerated in kspec-agents.md
    - id: ac-5
      given: |
        Skills reference ralph-specific behavior (task-work skill,
        codex skill, eval-agents skill, pr-review skill)
      when: |
        The migration is complete
      then: |
        Skills are updated to reference agent runtime concepts and
        kspec agent commands instead of kspec ralph
    - id: ac-6
      given: |
        The agent instructions template 06-ralph-loop.md exists
      when: |
        The migration is complete
      then: |
        The template is replaced with an agent dispatch section
        covering the new dispatch model, agent definitions, and
        one-shot invocation
    - id: ac-7
      given: |
        Tests exist for ralph functionality (ralph.test.ts,
        ralph-loop-errors.test.ts, ralph-wrap-up.test.ts,
        ralph-context-refresh.test.ts)
      when: |
        The migration is complete
      then: |
        Ralph tests are replaced with equivalent agent runtime tests
        covering dispatch, invocation lifecycle, and CLI commands
    - id: ac-8
      given: |
        The current ralph loop has a wrap-up agent that handles
        uncommitted changes on exit
      when: |
        An agent invocation ends with uncommitted changes in the
        working directory
      then: |
        The agent runtime detects uncommitted changes and either
        includes a wrap-up phase in the invocation or logs a warning
        to the session
```

## Tasks

derive_from_specs: true

```yaml
- title: Write migration guide from ralph to agent runtime
  slug: task-ralph-migration-guide
  priority: 3
  tags:
    - docs
    - migration
```

## Implementation Notes

### Architecture Overview

The reactive agent runtime replaces ralph's batch for-loop with event-driven dispatch. Instead of iterating N times and polling for work, agents are dispatched in response to task state transitions detected via file watchers and direct API events. Each invocation gets its own isolated session.

### Implementation Sequence

Phase 1 (Foundation): agent-definition-schema + session-model-evolution — schema changes with no runtime impact, enabling stable types for the rest.

Phase 2 (Core Runtime): agent-invocation-lifecycle + agent-dispatch-engine — extract reusable pieces from ralph.ts (prompt building, tool handling, streaming) into shared modules. Build the invocation lifecycle as the core unit, then the dispatch engine to orchestrate.

Phase 3 (CLI + Daemon): cli-agent-commands + daemon-agent-dispatch — wire the runtime into user-facing interfaces.

Phase 4 (Migration): ralph-replacement — remove ralph, update workflows/skills/templates, create default agent definitions.

### Key Reusable Infrastructure

- ACP client and spawner (src/acp/client.ts, src/agents/spawner.ts) — fully reusable
- Session store (src/sessions/store.ts) — extend, don't replace
- Adapter registry (src/agents/adapters.ts) — reuse as-is, including ad-hoc adapter support
- Daemon file watcher (packages/daemon/src/watcher.ts) — enhance with task state diffing
- Prompt building and tool handling from ralph.ts — extract into shared modules

### Risk Areas

- **File watcher task diffing** — must handle partial YAML writes and debounce correctly; store previous parsed state in memory
- **Concurrent shadow branch commits** — parallel agents need serialized commit operations; dispatch engine mediates access
- **Prompt extraction from ralph.ts** — ~2100 lines with interleaved concerns; decompose into prompts.ts, invocation.ts, and tool-handler.ts
- **Daemon not running for one-shot** — CLI one-shot must work independently of daemon; only reactive dispatch requires daemon
- **Event deduplication** — dual event sources (watcher + API) require dedup via (task_id, from, to) tuples with TTL window
- **Bootstrap on start** — dispatch engine must evaluate existing task states on startup, not just react to future changes
