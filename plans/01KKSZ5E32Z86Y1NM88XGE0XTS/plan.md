# Dispatch Event System Expansion

## Specs

```yaml
# ─── Foundation ───

- title: Dispatch Event Envelope and Delivery Semantics
  slug: dispatch-event-envelope
  type: decision
  parent: "@agent-integration"
  description: |
    Defines the universal event identity and lineage contract for the
    dispatch event bus. Every event emitted by any source carries a
    standard envelope with identity, causation chain, and ordering
    metadata. This is the contract that makes dedup, fan-in grouping,
    loop prevention, replay decisions, and event logging reliable.

    Non-goals: persistent event store, guaranteed delivery, replay.
    Events are transient (daemon lifetime). Session event logs provide
    the durable audit trail.
  acceptance_criteria:
    - id: ac-1
      given: |
        Any event is emitted on the event bus
      when: |
        A consumer receives the event
      then: |
        The event carries an envelope with event_id (unique per occurrence),
        event_type (dotted namespace), emitted_at (timestamp), source_type
        (task_watcher, api, invocation_lifecycle, schedule_engine, manual),
        and source_id (originating entity identifier)
    - id: ac-2
      given: |
        An event is caused by processing a previous event (e.g. a hook
        on invocation.completed fires, causing a new invocation whose
        completion emits another event)
      when: |
        The downstream event is constructed
      then: |
        The event carries causation_id (the event_id that directly caused
        it) and correlation_id (the root event_id of the causal chain,
        propagated transitively); when a kspec hook action triggers a
        CLI command that emits events (e.g. task state changes), the
        CLI propagates correlation_id via KSPEC_CORRELATION_ID env var
        so re-entry events maintain the causal chain for loop prevention
    - id: ac-3
      given: |
        Task events arrive from both file watcher and API within a
        short window
      when: |
        The event bus processes them
      then: |
        Task events are deduplicated using the existing (task_id,
        from_status, to_status) mechanism; non-task events have unique
        event_id and are not deduplicated
    - id: ac-4
      given: |
        Multiple events are emitted from the same source in sequence
      when: |
        Subscribers process them
      then: |
        Events are delivered in emission order per source; subscribers
        process events sequentially per source to preserve causal order
    - id: ac-5
      given: |
        A hook on invocation.completed triggers an agent whose completion
        matches the same hook (or a cycle of hooks)
      when: |
        The causal chain depth exceeds a configured maximum (default 5)
      then: |
        The event is rejected with a logged warning identifying the
        cycle via correlation_id and causation_id chain; the automation
        chain stops without crashing
    - id: ac-6
      given: |
        The event bus has been running and processing events
      when: |
        A consumer queries recent events (API or UI)
      then: |
        A configurable ring buffer (default 500 events) retains recent
        events in memory for inspection; older events are dropped

- title: Dispatch Event Taxonomy
  slug: dispatch-event-taxonomy
  type: feature
  parent: "@agent-integration"
  description: |
    Defines the event domains and maintains a registry of valid event
    type identifiers. Events use dotted-namespace domains. The registry
    is an explicit enumeration of known events, not a free-form string
    pattern — event identifiers must be registered to be valid.

    Event domains:
    - task.ready, task.in_progress, task.needs_work, task.pending_review
      (existing, unchanged)
    - invocation.started, invocation.completed, invocation.failed,
      invocation.stalled
    - session.ended, session.idle_timeout, session.cancelled
    - schedule.tick
    - action.started, action.completed, action.failed (universal action
      run tracking — every hook, schedule, and composition action produces
      action run events regardless of action type)

    Identity model: session_id and invocation_id are the same value.
    A "session" in the dispatch context IS an invocation — they are not
    separate entities. invocation.* events use session_id as the canonical
    identifier. action.* events use action_run_id as their canonical
    identifier and link to session_id when the action type is agent.

    All events carry the standard envelope defined by @dispatch-event-envelope.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent invocation reaches a terminal state
      when: |
        The dispatch engine processes the outcome
      then: |
        A corresponding invocation.completed, invocation.failed, or
        invocation.stalled event is emitted with the standard envelope
    - id: ac-2
      given: |
        A dispatch session ends (agent responds, timeout, or cancellation)
      when: |
        The session reaches a terminal state
      then: |
        A corresponding session.ended, session.idle_timeout, or
        session.cancelled event is emitted with session_id, agent_id,
        task_ref, duration, and terminal reason in the payload
    - id: ac-3
      given: |
        A configuration references an event type not in the registry
      when: |
        The configuration is validated
      then: |
        An error identifies the invalid event and lists valid event
        types within the referenced domain
    - id: ac-4
      given: |
        Existing agent definitions use the current 4 task event types
      when: |
        The expanded event system is active
      then: |
        All existing dispatch rules function identically without changes
    - id: ac-5
      given: |
        An event matches both a dispatch rule and a hook
      when: |
        The event is processed
      then: |
        Both are evaluated independently without interference

- title: Dispatch Event Payload Contracts
  slug: dispatch-event-payload
  type: requirement
  parent: "@dispatch-event-taxonomy"
  description: |
    Defines the typed payload fields guaranteed for each event domain,
    beyond the universal envelope. These are the fields that hook filters
    can match on and template variables can reference.
  acceptance_criteria:
    - id: ac-1
      given: |
        A task.* event is emitted
      when: |
        A consumer reads the payload
      then: |
        The payload includes task_id, task_ref, from_status, to_status,
        task_title, tags, priority, and automation status
    - id: ac-2
      given: |
        An invocation.* event is emitted
      when: |
        A consumer reads the payload
      then: |
        The payload includes session_id (which is the invocation's
        canonical identifier), agent_id, trigger, and duration_ms (for
        terminal events); task_ref is present when the invocation is
        task-scoped, absent otherwise
    - id: ac-3
      given: |
        A session.* event is emitted
      when: |
        A consumer reads the payload
      then: |
        The payload includes session_id, agent_id, task_ref (if
        task-scoped), duration_ms, terminal_reason, and a summary of
        work performed (task notes added, PRs created, etc.)
    - id: ac-4
      given: |
        A schedule.tick event is emitted
      when: |
        A consumer reads the payload
      then: |
        The payload includes schedule_id, schedule_name, tick_time
        (the scheduled time, not evaluation time), and run_count
        (number of accepted runs, not cron matches)
    - id: ac-5
      given: |
        An action.* event is emitted
      when: |
        A consumer reads the payload
      then: |
        The payload includes action_run_id, action_type, hook_id or
        schedule_id (source), duration_ms (for terminal events), and
        session_id (when action type is agent, linking to the spawned
        invocation's canonical identifier)

# ─── Action Model ───

- title: Dispatch Action Model
  slug: dispatch-action-model
  type: feature
  parent: "@agent-integration"
  description: |
    The shared action model used by hooks, schedules, and composition
    join triggers. An action describes what to do when an event matches.

    Four action types:
    - command: Run an executable with explicit arguments
    - kspec: Run a kspec CLI command
    - agent: Spawn an agent invocation
    - notify: Emit a WebSocket notification

    Every action execution produces an action run — a lightweight
    tracking record with unique ID, status, duration, and optional
    linked invocation_id (for agent actions). Action runs are the
    uniform abstraction that overlap policies, UI status, event logging,
    and action history key off of, regardless of action type.

    Template variables use {{var}} syntax resolved from the triggering
    event's envelope and payload.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A command action is configured
      when: |
        The action executes
      then: |
        The command runs asynchronously as a child process; the action
        does not block event processing; an action.started event is
        emitted; on completion an action.completed or action.failed
        event is emitted
    - id: ac-2
      given: |
        A command action is configured with a timeout
      when: |
        The command exceeds the timeout duration
      then: |
        The process is terminated and an action.failed event is emitted
        with timeout as the reason
    - id: ac-3
      given: |
        A kspec action is configured
      when: |
        The action executes
      then: |
        The kspec command runs in the project root directory; shadow
        branch mutations use the existing per-mutation scoped lock
        (consistent with @scoped-dispatch-shadow-serialization), not
        a per-command lock; the parent event's correlation_id is injected
        via KSPEC_CORRELATION_ID env var so CLI-emitted events inherit
        the causal chain for loop prevention
    - id: ac-4
      given: |
        An agent action is configured with agent_id
      when: |
        The action executes
      then: |
        A new invocation spawns using the standard invocation lifecycle;
        the action run tracks the linked invocation_id
    - id: ac-5
      given: |
        An agent action spawns a non-task-scoped invocation
      when: |
        The per-task exclusivity check runs
      then: |
        The invocation is not subject to per-task exclusivity; it is
        subject only to the target agent's max_concurrent
    - id: ac-6
      given: |
        A notify action fires
      when: |
        WebSocket clients are connected
      then: |
        Clients subscribed to the automation topic receive the hook/schedule
        name, event type, and payload summary
    - id: ac-7
      given: |
        A template variable references a field not present in the event
        envelope or payload
      when: |
        kspec validate runs
      then: |
        A warning identifies the unknown template variable and lists
        available fields for the referenced event type
    - id: ac-8
      given: |
        A template variable references an absent field at runtime
      when: |
        The action executes
      then: |
        The unresolved placeholder passes through unchanged and the
        action still executes (runtime non-fatal)
    - id: ac-9
      given: |
        An action fails for any reason
      when: |
        Other actions for the same event are pending
      then: |
        The failure is logged and remaining actions continue unaffected

- title: Dispatch Command Action Contract
  slug: dispatch-command-action
  type: requirement
  parent: "@dispatch-action-model"
  description: |
    Defines the structured command form for command actions. Commands
    use explicit program + args, not shell strings, to eliminate
    injection risks. Environment variables from the event payload use
    a namespaced allowlist.
  acceptance_criteria:
    - id: ac-1
      given: |
        A command action is configured
      when: |
        The schema is validated
      then: |
        The action specifies program (executable path or name) and
        args (array of string arguments); an optional cwd overrides
        the working directory; shell is false by default
    - id: ac-2
      given: |
        A command action uses template variables in args
      when: |
        The args are interpolated at runtime
      then: |
        Each arg is a separate array element; template values are
        interpolated as literal strings within their arg, never
        interpreted as shell syntax
    - id: ac-3
      given: |
        A command action executes
      when: |
        The child process is spawned
      then: |
        Event context is available via namespaced environment variables
        (KSPEC_EVENT_TYPE, KSPEC_EVENT_ID, KSPEC_SESSION_ID, etc.);
        only allowlisted fields are exposed; payload values exceeding
        1KB are truncated
    - id: ac-4
      given: |
        A command action modifies repository files
      when: |
        The command writes to the working tree
      then: |
        The command operates outside the shadow branch mutex; the
        shadow branch pre-commit hook prevents direct git commits to
        kspec-meta as a safety net; command actions that need shadow
        branch serialization should use the kspec action type instead

- title: Dispatch Agent Action Input Contract
  slug: dispatch-agent-action-input
  type: requirement
  parent: "@dispatch-action-model"
  description: |
    Defines how agent actions supply prompt context, manage session
    strategy, and propagate correlation metadata to spawned invocations.
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent action is configured with a prompt or prompt_template
      when: |
        The invocation is spawned
      then: |
        The prompt is interpolated with event envelope and payload
        variables and supplied to the agent as the initial prompt;
        if no prompt is configured, a default prompt is generated
        from the event context
    - id: ac-2
      given: |
        An agent action is triggered by a hook on invocation.completed
      when: |
        The spawned invocation's prompt is constructed
      then: |
        The prompt includes the completed invocation's session_id,
        agent_id, task_ref, and outcome summary so the downstream
        agent has upstream context
    - id: ac-3
      given: |
        An agent action is configured with task_binding: true and the
        triggering event has a task_ref
      when: |
        The invocation is spawned
      then: |
        The invocation is task-scoped and subject to per-task exclusivity;
        without task_binding the invocation is non-task-scoped
    - id: ac-4
      given: |
        An agent action is triggered within a composition group
      when: |
        The invocation is spawned
      then: |
        The correlation_id and group_id from the triggering event
        propagate to the spawned invocation's session metadata

# ─── Hooks ───

- title: Dispatch Hook System
  slug: dispatch-hook-system
  type: feature
  parent: "@agent-integration"
  description: |
    A hook is an event-triggered action. Hooks are configured in
    kynetic.meta.yaml under a top-level hooks section. Each hook has:
    on (event type from registry), filter (structured payload filter),
    action (from the shared action model), name (label), and enabled
    (boolean).

    Hooks run asynchronously and independently. Multiple hooks can
    match the same event. Hook failures are isolated. Configuration
    changes take effect on the next event without daemon restart.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A hook is configured with an event type and action
      when: |
        A matching event fires
      then: |
        The configured action executes with the event envelope and
        payload as context; the hook propagates correlation_id and
        sets causation_id from the triggering event
    - id: ac-2
      given: |
        A hook is disabled (enabled: false)
      when: |
        Its matching event fires
      then: |
        The hook is silently skipped
    - id: ac-3
      given: |
        Multiple hooks match the same event
      when: |
        The event fires
      then: |
        All matching hooks execute; no hook depends on another's outcome
    - id: ac-4
      given: |
        A hook has filters on payload fields
      when: |
        An event fires that does not match the filter criteria
      then: |
        The hook does not execute
    - id: ac-5
      given: |
        Hook configuration changes in kynetic.meta.yaml
      when: |
        The next event is processed
      then: |
        Updated configuration is used; in-flight actions from removed
        hooks complete normally

- title: Dispatch Hook Schema
  slug: dispatch-hook-schema
  type: requirement
  parent: "@dispatch-hook-system"
  description: |
    Schema definitions for hook configuration in kynetic.meta.yaml.
    Extends the meta manifest with an optional hooks array. Defines the
    filter language for payload matching.
  acceptance_criteria:
    - id: ac-1
      given: |
        A valid hook definition exists in kynetic.meta.yaml
      when: |
        The meta manifest is loaded
      then: |
        The hook is parsed with typed fields; the action field uses the
        shared action schema
    - id: ac-2
      given: |
        A hook uses an invalid or unknown action type
      when: |
        Validation runs
      then: |
        The error identifies the invalid type and lists valid options
    - id: ac-3
      given: |
        A hook's agent action references a non-existent agent
      when: |
        kspec validate runs
      then: |
        An error identifies the unresolvable agent reference; agent
        refs in executable hooks and schedules are errors (not warnings)
        because they will fail at runtime
    - id: ac-4
      given: |
        An existing meta manifest has no hooks section
      when: |
        The extended schema is applied
      then: |
        The manifest loads successfully with hooks defaulting to empty

- title: Dispatch Hook Filter Language
  slug: dispatch-hook-filter
  type: requirement
  parent: "@dispatch-hook-schema"
  description: |
    Defines the filter language for hook payload matching. Filters
    operate on event envelope and payload fields and use exact-match
    semantics with array-contains for list fields.
  acceptance_criteria:
    - id: ac-1
      given: |
        A hook filter specifies agent_id: "worker"
      when: |
        An event fires with agent_id "reviewer" in its payload
      then: |
        The hook does not match; filters use exact string equality
    - id: ac-2
      given: |
        A hook filter specifies tags: ["mvp"]
      when: |
        An event fires for a task with tags ["mvp", "cli"]
      then: |
        The hook matches; tag filters use contains-all semantics
        (all specified tags must be present, extra tags are allowed)
    - id: ac-3
      given: |
        A hook filter references a field that is neither a known
        envelope field nor a payload field for the hook's event type
      when: |
        kspec validate runs
      then: |
        A warning identifies the unknown filter field and lists
        available fields; envelope fields (event_id, source_type,
        source_id, correlation_id, causation_id) are always valid
        filter targets for any event type
    - id: ac-4
      given: |
        A hook has no filter configured
      when: |
        Any event matching the hook's event type fires
      then: |
        The hook matches all events of that type
    - id: ac-5
      given: |
        A hook filter specifies source_type: "schedule_engine"
      when: |
        An event fires from a different source (e.g. manual emit)
      then: |
        The hook does not match; filters can target envelope fields
        (source_type, source_id, correlation_id) in addition to
        payload fields

# ─── Schedules ───

- title: Dispatch Schedule Entities
  slug: dispatch-schedule-entities
  type: feature
  parent: "@agent-integration"
  description: |
    Schedules are first-class entities in kynetic.meta.yaml that fire
    events on a cron-style cadence. Each schedule references an action
    (from the shared action model) with overlap policy, enable/disable,
    and optional backfill on restart.

    Overlap policies control behavior when a previous action run (not
    just invocation) is still active: skip (drop the tick), buffer_one
    (queue at most one), allow (start subject to concurrency limits).

    Schedule evaluation has minute-level resolution.
  traits:
    - trait-error-guidance
  acceptance_criteria:
    - id: ac-1
      given: |
        A schedule is configured with a cron expression and an action
      when: |
        The cron expression matches the current time
      then: |
        The configured action executes with schedule context in the
        event payload
    - id: ac-2
      given: |
        A schedule with overlap_policy: skip has an active action run
      when: |
        The next scheduled tick arrives
      then: |
        The tick is skipped and the schedule advances to the next
        occurrence
    - id: ac-3
      given: |
        A schedule with overlap_policy: buffer_one has an active action run
      when: |
        Multiple ticks arrive while the action is running
      then: |
        At most one tick is buffered; additional ticks are dropped;
        the buffered tick runs when the active action completes
    - id: ac-4
      given: |
        A schedule is disabled
      when: |
        Its cron expression would fire
      then: |
        No action is taken until the schedule is re-enabled
    - id: ac-5
      given: |
        A schedule with overlap_policy: allow fires while the previous
        action run is active
      when: |
        The new action is attempted and the target agent has max_concurrent: 1
      then: |
        For agent actions, the invocation is queued (not dropped);
        for command/kspec actions, the action runs immediately since
        they have no concurrency limit
    - id: ac-6
      given: |
        Schedule configuration changes while the schedule engine is running
      when: |
        The next evaluation cycle runs
      then: |
        Updated schedules use new settings; added schedules are evaluated
        from the next cycle; removed schedules stop ticking but in-flight
        actions complete normally

- title: Dispatch Schedule Runtime State and Time Semantics
  slug: dispatch-schedule-runtime
  type: requirement
  parent: "@dispatch-schedule-entities"
  description: |
    Defines the persistence model for schedule runtime state and
    clarifies time semantics for cron evaluation, DST transitions,
    and manual triggers.
  acceptance_criteria:
    - id: ac-1
      given: |
        The daemon restarts after being down during a scheduled tick
      when: |
        The daemon starts and evaluates schedule state
      then: |
        last_tick and run_count are reset to zero (volatile state);
        if the schedule has backfill: true, the engine uses a best-effort
        startup heuristic: it checks if the current time matches the cron
        within the last interval and fires one catch-up action; this is
        not precise (no persisted shutdown timestamp) but handles the
        common "daemon was briefly down" case
    - id: ac-2
      given: |
        A schedule has a timezone configured and a DST transition occurs
      when: |
        The schedule engine evaluates the cron expression
      then: |
        The cron library's DST handling applies; tick_time in the event
        payload reflects the scheduled wall-clock time in the configured
        timezone, not the evaluation time
    - id: ac-3
      given: |
        No timezone is configured on a schedule
      when: |
        The cron expression is evaluated
      then: |
        UTC is used as the default; this avoids surprises in containers
        and CI where the system timezone may be undefined or unexpected
    - id: ac-4
      given: |
        A user manually triggers a schedule via CLI or API
      when: |
        The trigger fires
      then: |
        A normal schedule.tick event is emitted; overlap policy applies
        to manual triggers the same as cron triggers; run_count
        increments
    - id: ac-5
      given: |
        A schedule's action completes or fails
      when: |
        run_count is queried
      then: |
        run_count reflects the number of accepted runs (ticks that
        were not skipped by overlap policy), regardless of whether
        the action succeeded or failed

- title: Dispatch Schedule Schema
  slug: dispatch-schedule-schema
  type: requirement
  parent: "@dispatch-schedule-entities"
  description: |
    Schema for schedule configuration in kynetic.meta.yaml.
  acceptance_criteria:
    - id: ac-1
      given: |
        A schedule uses a valid 5-field cron expression
      when: |
        The meta manifest is loaded
      then: |
        The schedule is accepted; invalid cron expressions produce errors
        with examples of valid syntax
    - id: ac-2
      given: |
        A schedule uses a 6-field (second-level) cron expression
      when: |
        Validation runs
      then: |
        An error indicates that only 5-field (minute-level) expressions
        are supported
    - id: ac-3
      given: |
        A schedule references a non-existent agent
      when: |
        kspec validate runs
      then: |
        An error identifies the unresolvable agent reference
    - id: ac-4
      given: |
        An existing meta manifest has no schedules section
      when: |
        The extended schema is applied
      then: |
        The manifest loads successfully with schedules defaulting to empty

# ─── Composition ───

- title: Dispatch Composition Patterns
  slug: dispatch-composition-patterns
  type: feature
  parent: "@agent-integration"
  description: |
    Multi-agent coordination patterns built on the event bus and hook
    system. Composition is achieved through event-driven chaining:

    1. Fan-out: Multiple agents match the same event (existing).
    2. Pipeline: A hook on one agent's completion triggers another,
       passing outcome context via the agent action input contract.
    3. Synthesis (fan-in): A join configuration waits for N related
       action runs to complete before triggering a synthesis action.
    4. Conditional routing: Separate hooks for success vs failure
       outcomes enable different follow-up paths.
  acceptance_criteria:
    - id: ac-1
      given: |
        A hook chains agent A's completion to agent B
      when: |
        Agent A completes
      then: |
        Agent B receives context about A's session and outcome per
        the agent action input contract
    - id: ac-2
      given: |
        A composition group requires N action runs to complete
      when: |
        The Nth run finishes
      then: |
        The on_complete action is triggered with references to all
        completed action runs and their linked sessions
    - id: ac-3
      given: |
        A composition group has a timeout and not all runs complete
      when: |
        The timeout expires
      then: |
        The on_complete action fires with partial results indicating
        which runs completed, which failed, and which timed out
    - id: ac-4
      given: |
        Separate hooks target invocation.completed and invocation.failed
        for the same agent
      when: |
        The agent fails
      then: |
        Only the failure hook fires; the completion hook does not

- title: Dispatch Composition Correlation and Join Semantics
  slug: dispatch-composition-correlation
  type: requirement
  parent: "@dispatch-composition-patterns"
  description: |
    Defines how composition groups are created, how group_id propagates
    through chained actions, what counts toward the join threshold,
    and behavior on daemon restart.

    Key distinction: a composition config (stored in meta YAML) defines
    the join rules. A composition activation is a runtime instance of
    that config with a unique activation_id. One config can have multiple
    concurrent activations (e.g. a scheduled fan-out that runs nightly).
    API/UI status refers to activations, not configs.
  acceptance_criteria:
    - id: ac-1
      given: |
        A composition config exists and a triggering event matches
        the config's activation criteria (e.g. a hook fires that is
        tagged with the composition's config_id)
      when: |
        The join accumulator processes the event
      then: |
        A new activation is created with a unique activation_id;
        the activation_id is propagated as group_id to all downstream
        action runs and spawned invocations via session metadata;
        subsequent action runs with matching group_id are tracked as
        members of this activation
    - id: ac-2
      given: |
        An action run in a composition group completes successfully
      when: |
        The join accumulator evaluates progress
      then: |
        The run counts toward the join threshold; failed and stalled
        runs do not count toward success threshold but are tracked
        for the partial results payload
    - id: ac-3
      given: |
        The timeout clock for a composition group
      when: |
        The group is activated
      then: |
        The timeout starts when the first action run in the group
        begins, not when the group is configured
    - id: ac-4
      given: |
        The daemon restarts while a composition group is in progress
      when: |
        The daemon starts
      then: |
        In-progress composition groups are lost (volatile state);
        the group does not resume and the on_complete action does not
        fire; this is documented as a known limitation of daemon-
        lifetime composition state

- title: Dispatch Composition Schema
  slug: dispatch-composition-schema
  type: requirement
  parent: "@dispatch-composition-patterns"
  description: |
    Schema for composition group configuration in kynetic.meta.yaml.
  acceptance_criteria:
    - id: ac-1
      given: |
        A composition group defines a join count and on_complete action
      when: |
        The meta manifest is loaded
      then: |
        The group is parsed with typed fields; the on_complete action
        uses the shared action schema
    - id: ac-2
      given: |
        An existing meta manifest has no compositions section
      when: |
        The extended schema is applied
      then: |
        The manifest loads successfully with compositions defaulting
        to empty

# ─── CLI ───

- title: Dispatch Event CLI Commands
  slug: dispatch-event-cli
  type: feature
  parent: "@agent-integration"
  description: |
    CLI commands for managing hooks, schedules, inspecting events,
    and simulating event payloads for testing.

    Hook commands: kspec hook list, add, set, enable, disable, remove.
    Schedule commands: kspec schedule list, add, set, enable, disable,
    remove, trigger.
    Event inspection: kspec event types, kspec event log.
    Testing: kspec event emit (simulate an event to test hook matching).

    All commands follow existing CLI patterns for output formatting,
    shadow branch auto-commit, and batch compatibility.
  traits:
    - trait-json-output
    - trait-error-guidance
    - trait-shadow-commit
    - trait-filterable-list
    - trait-semantic-exit-codes
  acceptance_criteria:
    - id: ac-1
      given: |
        Hooks exist in the project configuration
      when: |
        A user lists hooks
      then: |
        Each hook's name, event trigger, action type, and enabled status
        are shown
    - id: ac-2
      given: |
        Schedules exist in the project configuration
      when: |
        A user lists schedules
      then: |
        Each schedule's name, cron expression, next tick time, and
        enabled status are shown
    - id: ac-3
      given: |
        A user manually triggers a schedule
      when: |
        The daemon is running
      then: |
        The schedule's action executes immediately with overlap policy
        enforced
    - id: ac-4
      given: |
        A user adds a hook with valid event and action configuration
      when: |
        The add command succeeds
      then: |
        The hook is persisted and available for event matching
    - id: ac-5
      given: |
        A user requests the event taxonomy
      when: |
        The event types command runs
      then: |
        All registered event identifiers are listed, grouped by domain,
        with the payload fields available for each type
    - id: ac-6
      given: |
        A user runs kspec event emit with an event type and payload fields
      when: |
        The daemon is running
      then: |
        The event is emitted on the bus as a manual source; matching hooks
        fire; the command reports which hooks matched and their outcomes

# ─── API ───

- title: Automation API
  slug: automation-api
  type: feature
  parent: "@web-ui"
  traits:
    - trait-api-endpoint
    - trait-localhost-security
    - trait-json-output
  description: |
    REST API endpoints for hook, schedule, and event management. Used
    by the CLI (for schedule runtime queries and manual triggers) and
    the web UI (for CRUD and status).
  acceptance_criteria:
    - id: ac-1
      given: |
        A client requests the list of hooks
      when: |
        GET /api/hooks is called
      then: |
        The response includes all configured hooks with their current
        enabled state
    - id: ac-2
      given: |
        A client requests schedule runtime status
      when: |
        GET /api/schedules/:id/status is called
      then: |
        The response includes next_tick, last_tick, run_count,
        active_run_count, active_run_ids (array), and current overlap
        state (idle, running, running_buffered)
    - id: ac-3
      given: |
        A client manually triggers a schedule
      when: |
        POST /api/schedules/:id/trigger is called
      then: |
        The response indicates the trigger outcome: accepted (action
        started), buffered (queued behind active run), queued (agent
        concurrency limit reached), or skipped (overlap policy rejected)
    - id: ac-4
      given: |
        A client queries recent events
      when: |
        GET /api/events/recent is called with optional type filter
      then: |
        The response includes events from the ring buffer with full
        envelope and payload, filtered by event type if specified
    - id: ac-5
      given: |
        A client requests composition status
      when: |
        GET /api/compositions/:config_id/activations is called
      then: |
        The response includes all active activations for the config,
        each with activation_id, join progress (completed/total),
        member action_run_ids, and timeout remaining
    - id: ac-6
      given: |
        A client emits a test event
      when: |
        POST /api/events/emit is called with event type and payload
      then: |
        The event is emitted on the bus as a manual source; the response
        includes matched hook names and their action_run_ids; outcomes
        may not be available synchronously for async actions

- title: Automation Event Stream
  slug: automation-event-stream
  type: requirement
  parent: "@automation-api"
  traits:
    - trait-websocket-protocol
  description: |
    WebSocket event stream for real-time automation updates. Clients
    subscribe to the "automation" topic to receive event bus activity.
  acceptance_criteria:
    - id: ac-1
      given: |
        A WebSocket client subscribes to the "automation" topic
      when: |
        An event is emitted on the bus
      then: |
        The client receives the event with full envelope and payload
    - id: ac-2
      given: |
        An action run starts or completes
      when: |
        The client is subscribed
      then: |
        The client receives action.started and action.completed/failed
        events with the action run details

# ─── Web UI ───

- title: Automation View
  slug: ui-automation-view
  type: feature
  parent: "@web-ui"
  description: |
    A dedicated web UI view for the dispatch event system. Consolidates
    all automation configuration and monitoring: agent dispatch triggers
    (moved from agents view), hooks, schedules, event log, and
    composition group status.

    The agents view retains agent definition management (name, adapter,
    capabilities, tools, skills, budget) but dispatch trigger editing
    moves here.
  acceptance_criteria:
    - id: ac-1
      given: |
        A user navigates to the automation view
      when: |
        Agents, hooks, and schedules are configured
      then: |
        The view shows agent dispatch triggers, hooks, and schedules
        in organized sections with their enabled/disabled state
    - id: ac-2
      given: |
        A user views the event log section
      when: |
        The daemon is running and events have been processed
      then: |
        Recent events are shown in reverse chronological order with
        event type, source, timestamp, and linked entity references
    - id: ac-3
      given: |
        A user edits a hook or schedule from the automation view
      when: |
        They save changes
      then: |
        The configuration is persisted via the API and the view
        updates to reflect the change
    - id: ac-4
      given: |
        A user views a schedule
      when: |
        The daemon is running
      then: |
        The schedule shows next tick time, last tick time, run count,
        active run count, and current overlap state (idle, running,
        running_buffered)
    - id: ac-5
      given: |
        An agent dispatch trigger is shown in the automation view
      when: |
        The user edits it
      then: |
        The trigger's event type and filter criteria are editable
        inline, consistent with the dispatch rule schema
    - id: ac-6
      given: |
        Composition groups are configured
      when: |
        The user views the automation view
      then: |
        Each config shows its active activations with join progress,
        member action runs, and timeout status per activation
    - id: ac-7
      given: |
        Any automation event fires
      when: |
        The automation view is open
      then: |
        The event log updates in real-time via WebSocket
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement event envelope and bus
  slug: task-event-bus
  priority: 1
  tags: [dispatch, events, foundation]
  spec_ref: "@dispatch-event-envelope"
  description: |
    The event bus with standard envelope is the foundation for everything.
    Today, handleStateChange() does dedup, rule matching, enqueue, and
    drain inline. This task refactors that into a publish/subscribe model.

    Why: Every subsequent feature (hooks, schedules, composition) needs a
    central place to emit and subscribe to events with identity, causation
    tracking, and loop prevention. Without the bus, each feature wires into
    handleStateChange() directly.

    What: Create an EventBus class with typed event envelope (event_id,
    event_type, emitted_at, source_type, source_id, correlation_id,
    causation_id). Add emit(event) and subscribe(pattern, handler).
    Refactor existing dispatch rule matching into a subscriber. Add
    invocation lifecycle events by routing existing onInvocationEvent
    through the bus. Implement chain depth limit using correlation_id
    tracking (default max 5). Add configurable ring buffer for recent
    event retention.

    How: The bus lives inside DispatchEngine and shares its lifecycle.
    Task event dedup remains for task.* events only. Non-task events have
    unique event_id and skip dedup. Events are delivered in emission order
    per source. The ring buffer is a simple circular array.

    Covers: @dispatch-event-envelope ac-1 through ac-6.

- title: Register event taxonomy and extend schema
  slug: task-event-schema
  priority: 1
  tags: [dispatch, schema]
  spec_ref: "@dispatch-event-taxonomy"
  depends_on:
    - "@task-event-bus"
  description: |
    Define the event type registry — an explicit enumeration of valid
    event identifiers, not a free-form string pattern. Extend the schema
    to accept new event types while keeping backward compatibility.

    Why: Hooks and schedules reference event types beyond task state
    changes. The registry validates new types while ensuring existing
    dispatch rules work unchanged. Using a registry (not just a regex)
    means ac-3 validation stays tight.

    What: Maintain a registry of known event IDs with domain grouping.
    Replace AgentDispatchEventSchema enum with a union that accepts both
    original 4 values and registered new identifiers. Add session.*
    events (ended, idle_timeout, cancelled) and action.* events (started,
    completed, failed). Update SessionTriggerSchema.

    How: STATUS_TO_EVENT and EVENT_TO_STATUS remain unchanged for task
    events. The registry is a constant map from event_type to payload
    schema, used by both validation and the event types CLI command.

    Covers: @dispatch-event-taxonomy ac-1 through ac-5.

- title: Define event payload schemas
  slug: task-event-payloads
  priority: 1
  tags: [dispatch, schema]
  spec_ref: "@dispatch-event-payload"
  depends_on:
    - "@task-event-schema"
  description: |
    Define typed payload schemas per event domain. These are the fields
    hook filters match on and template variables reference.

    Why: Without a payload contract, hook filters and template variables
    are guesswork. This is the contract that makes the event bus useful
    to consumers.

    What: Zod schemas for task payloads (task_id, task_ref, from_status,
    to_status, task_title, tags, priority, automation), invocation
    payloads (session_id, agent_id, trigger, duration_ms, task_ref),
    session payloads (session_id, agent_id, task_ref, duration_ms,
    terminal_reason, work_summary), schedule tick payloads (schedule_id,
    schedule_name, tick_time, run_count), and action payloads
    (action_run_id, action_type, source hook/schedule, duration_ms,
    invocation_id).

    Note: task payloads are enriched beyond current TaskStateChange —
    they now include tags, priority, automation status so hook filters
    can match on task metadata, not just state transitions.

    Covers: @dispatch-event-payload ac-1 through ac-5.

- title: Implement shared action model and action run tracking
  slug: task-action-model
  priority: 1
  tags: [dispatch, actions, foundation]
  spec_ref: "@dispatch-action-model"
  description: |
    Implement the action model and action run abstraction. Every action
    execution (hook, schedule, or join trigger) produces an action run
    with unique ID, status, duration, and optional linked invocation_id.

    Why: Action runs are the uniform abstraction that overlap policies,
    UI status, event logging, and action history key off of. Without
    this, overlap tracking only works for agent actions and the UI
    can't show command/kspec action status.

    What: ActionExecutor class with execute(action, eventContext) that
    returns an ActionRun. Each action type has its execution path.
    Action runs emit action.started and action.completed/failed events
    on the bus. Template interpolation resolves {{var}} from envelope
    and payload.

    How: The executor is used by both HookExecutor and ScheduleEngine.
    All four action types produce action runs. Agent action runs link
    to invocation_id. Command and kspec runs track PID and exit code.

    Covers: @dispatch-action-model ac-1 through ac-9.

- title: Implement command action with structured form
  slug: task-command-action
  priority: 1
  tags: [dispatch, actions, security]
  spec_ref: "@dispatch-command-action"
  depends_on:
    - "@task-action-model"
  description: |
    Implement the command action using structured program + args form
    instead of shell strings. Eliminates injection risks.

    Why: Shell string interpolation with user-controlled values is an
    injection vector. Structured commands are safe by construction.

    What: Command actions specify program (string) and args (string[]).
    Template variables are interpolated as literal strings within each
    arg element, never passed through shell parsing. Event context is
    available via namespaced KSPEC_* environment variables with an
    allowlist and 1KB size limit per value. Shell mode is off by default.

    How: Use child_process.spawn (not exec/execSync) with shell: false.
    Each arg is a separate argv element. Template values go into args
    via string replacement, not shell expansion. The allowlist for env
    vars is derived from the event payload schema.

    Covers: @dispatch-command-action ac-1 through ac-4.

- title: Implement agent action input contract
  slug: task-agent-action-input
  priority: 2
  tags: [dispatch, actions, agents]
  spec_ref: "@dispatch-agent-action-input"
  depends_on:
    - "@task-action-model"
    - "@task-event-bus"
  description: |
    Implement prompt templating, session strategy, and correlation
    propagation for agent actions.

    Why: "Agent B receives context about A's session" is meaningless
    without defining how the prompt is built. This is the contract that
    makes pipeline chaining actually work.

    What: Agent actions support prompt/prompt_template (interpolated
    with event context), task_binding (opt-in to per-task exclusivity),
    and correlation/group_id propagation to spawned session metadata.
    When triggered by invocation.completed, the default prompt includes
    the upstream session_id, agent_id, and outcome summary.

    How: Extend the existing prompt_template interpolation from
    @agent-dispatch-engine ac-16. Add task_binding flag that controls
    whether the invocation is task-scoped. Propagate correlation_id
    and group_id to InvocationOptions metadata.

    Covers: @dispatch-agent-action-input ac-1 through ac-4.

- title: Emit session lifecycle events
  slug: task-session-events
  priority: 1
  tags: [dispatch, events, sessions]
  spec_ref: "@dispatch-event-taxonomy"
  depends_on:
    - "@task-event-bus"
  description: |
    Emit session.ended, session.idle_timeout, and session.cancelled
    events when dispatch sessions reach terminal states. Also define
    the contract for how agent action runs close when their linked
    invocation reaches a terminal state.

    Why: End-of-session hooks are a headline goal. Without this task,
    session.* events exist in the taxonomy but are never emitted. Also,
    if action runs don't close on invocation terminal states, overlap
    accounting and composition join counts hang indefinitely.

    What: Hook into the invocation completion handlers (which already
    emit invocation.completed/failed/stalled) to also emit the
    corresponding session.* event with terminal_reason and work_summary.
    Define the mapping: invocation.completed -> session.ended,
    invocation.failed -> session.ended (with failure reason),
    invocation.stalled -> session.idle_timeout. Agent-initiated
    cancellation -> session.cancelled. Also: when an agent action run's
    linked invocation reaches a terminal state, the action run is
    closed (action.completed or action.failed emitted) so overlap
    tracking and join accumulators can progress.

    How: The session_id == invocation_id identity means we can emit
    session events from the same completion handler. Work summary is
    derived from session event log (task notes added, PRs created,
    tasks completed — read from session metadata on close).

    Covers: @dispatch-event-taxonomy ac-2,
    @dispatch-event-payload ac-3.
    Also covers action run closure: when an agent action's linked
    invocation ends, the action run is completed/failed accordingly.
    This is emergent behavior from wiring invocation terminal events
    to action run state, not a direct AC on @dispatch-action-model.

- title: Implement hook schema and meta manifest extension
  slug: task-hook-schema
  priority: 1
  tags: [dispatch, hooks, schema]
  spec_ref: "@dispatch-hook-schema"
  description: |
    Define Zod schemas for hooks and extend MetaManifestSchema.

    Why: The schema is the contract for hook configuration. Needs to
    exist before the executor or CLI.

    What: HookSchema with _ulid, name, on, filter, action (reuses
    action schema), enabled. HookFilterSchema for payload matching with
    exact-match and contains-all semantics. Add hooks array to
    MetaManifestSchema with default [].

    How: Follow AgentDispatchRuleSchema as pattern. Filter language
    supports string equality (agent_id, status) and array-contains
    (tags). Unknown filter fields on known event types produce validate
    warnings.

    Covers: @dispatch-hook-schema ac-1 through ac-4,
    @dispatch-hook-filter ac-1 through ac-5.

- title: Implement hook execution engine
  slug: task-hook-executor
  priority: 2
  tags: [dispatch, hooks]
  spec_ref: "@dispatch-hook-system"
  depends_on:
    - "@task-hook-schema"
    - "@task-event-bus"
    - "@task-action-model"
  description: |
    The hook executor subscribes to the event bus and runs matching
    hooks via the shared action model.

    Why: Connects hook configuration to the event bus.

    What: HookExecutor class that loads hooks from meta, subscribes to
    the bus, filters events, and dispatches actions via ActionExecutor.
    Propagates correlation_id and sets causation_id on downstream events.
    Reloads hook config via versioned config snapshot (not re-reading
    YAML on every event) — updated by file watcher or API change
    notification.

    How: On event, iterate hooks, check on + filter match, execute via
    ActionExecutor. All actions are fire-and-forget. In-flight actions
    from removed hooks complete. Config reload uses a version counter
    incremented on meta file change.

    Covers: @dispatch-hook-system ac-1 through ac-5.
    Also implicitly covers @dispatch-composition-patterns ac-1
    (pipeline chaining via hooks) and ac-4 (conditional routing via
    separate hooks for completed vs failed).

- title: Implement schedule schema and meta extension
  slug: task-schedule-schema
  priority: 2
  tags: [dispatch, schedules, schema]
  spec_ref: "@dispatch-schedule-schema"
  description: |
    Define Zod schemas for schedules and extend MetaManifestSchema.
    Reuses the shared action schema.

    Why: Contract must exist before runtime or CLI.

    What: ScheduleSchema with _ulid, id, name, cron (validated 5-field
    only, reject 6-field), timezone, action, overlap_policy (enum: skip,
    buffer_one, allow), backfill (boolean), enabled. Add schedules array
    to MetaManifestSchema.

    How: Use croner for cron validation. Cross-ref validation follows
    hook pattern.

    Covers: @dispatch-schedule-schema ac-1 through ac-4.

- title: Implement schedule tick engine
  slug: task-schedule-engine
  priority: 2
  tags: [dispatch, schedules]
  spec_ref: "@dispatch-schedule-entities"
  depends_on:
    - "@task-schedule-schema"
    - "@task-event-bus"
    - "@task-action-model"
  description: |
    The schedule engine evaluates cron expressions and fires schedule.tick
    events, enforcing overlap policies against action runs (not just
    invocations).

    Why: Makes schedules run. Overlap must work for all action types.

    What: ScheduleEngine with 60-second evaluation loop. Tracks per-
    schedule state: last_tick, next_tick, run_count (accepted runs),
    active_run_ids (array — multiple active runs possible with allow
    policy), buffered_tick. Overlap checks against action runs, not
    invocations — this works for command/kspec/notify too. Config
    reload via versioned snapshot.

    How: Integrates with DispatchEngine lifecycle (start/stop). Subscribe
    to action.completed/failed events to clear active run state. All
    runtime state is volatile (resets on daemon restart). Backfill on
    start: if backfill: true, check current time against cron and fire
    one catch-up. tick_time in payload is the scheduled wall-clock time,
    not evaluation time. Manual triggers emit normal schedule.tick events
    with overlap policy enforced.

    Covers: @dispatch-schedule-entities ac-1 through ac-6,
    @dispatch-schedule-runtime ac-1 through ac-5.

- title: Implement hook CLI commands
  slug: task-hook-cli
  priority: 3
  tags: [dispatch, hooks, cli]
  spec_ref: "@dispatch-event-cli"
  depends_on:
    - "@task-hook-executor"
  description: |
    kspec hook list, add, set, enable, disable, remove.

    Why: Users and agents need to manage hooks without hand-editing YAML.

    What: Standard CRUD commands with --json, shadow branch auto-commit,
    batch compatibility. Follow existing meta mutation patterns.

    Covers: @dispatch-event-cli ac-1, ac-4.

- title: Implement schedule CLI commands
  slug: task-schedule-cli
  priority: 3
  tags: [dispatch, schedules, cli]
  spec_ref: "@dispatch-event-cli"
  depends_on:
    - "@task-schedule-engine"
    - "@task-daemon-api"
  description: |
    kspec schedule list, add, set, enable, disable, remove, trigger.

    Why: Management without hand-editing, plus trigger enables testing.

    What: schedule list merges static config from meta YAML with runtime
    state from daemon API (next_tick, run_count, overlap state). When
    daemon is not running, shows config only. Trigger POSTs to daemon API.

    How: schedule list needs both meta (config) and daemon API (runtime).
    That's why this depends on task-daemon-api.

    Covers: @dispatch-event-cli ac-2, ac-3.

- title: Implement event CLI commands (types, log, emit)
  slug: task-event-cli
  priority: 3
  tags: [dispatch, cli]
  spec_ref: "@dispatch-event-cli"
  depends_on:
    - "@task-event-schema"
    - "@task-daemon-api"
  description: |
    kspec event types (registry listing), kspec event log (query daemon
    ring buffer), kspec event emit (simulate event for testing).

    Why: event types is the reference for valid events. event log is for
    debugging. event emit is essential for testing hook configurations
    without waiting for real events.

    What: event types lists registered events with payload fields per
    type. event log queries GET /api/events/recent with optional type
    filter. event emit POSTs a manual event to the daemon bus with
    user-specified type and payload fields; reports which hooks matched.

    Covers: @dispatch-event-cli ac-5, ac-6.

- title: Implement automation API endpoints
  slug: task-daemon-api
  priority: 2
  tags: [dispatch, daemon, api]
  spec_ref: "@automation-api"
  depends_on:
    - "@task-hook-executor"
    - "@task-schedule-engine"
    - "@task-composition-join"
  description: |
    REST API endpoints for hooks, schedules, events, and composition
    status. Used by CLI and web UI.

    Why: CLI needs runtime state queries and manual triggers. UI needs
    CRUD and real-time status. These need proper API endpoints.

    What: Hook CRUD (GET/POST/PATCH/DELETE /api/hooks). Schedule CRUD +
    runtime state (/api/schedules, /api/schedules/:id/status,
    POST /api/schedules/:id/trigger). Event log (GET /api/events/recent
    with type filter). Composition status (GET /api/compositions/:id/status
    with join progress). WebSocket topic "automation" for real-time
    streaming.

    How: Follow agent-dispatch.ts route patterns. Hook/schedule mutations
    use meta YAML write helpers. Runtime queries read from ScheduleEngine
    and HookExecutor in-memory state. Event log from bus ring buffer.

    Covers: @automation-api ac-1 through ac-6,
    @automation-event-stream ac-1, ac-2.

- title: Extend kspec validate with hook/schedule/composition rules
  slug: task-validate-integration
  priority: 3
  tags: [dispatch, validation]
  spec_ref: "@dispatch-hook-schema"
  depends_on:
    - "@task-hook-schema"
    - "@task-schedule-schema"
  description: |
    Wire hook, schedule, and composition cross-reference validation into
    the existing kspec validate pipeline.

    Why: Invalid agent references, unknown event types, unknown filter
    fields, and unknown template variables should surface during
    validation, not at runtime.

    What: Error on unresolvable agent references in hooks and schedules
    (these will fail at runtime). Error on unknown event types. Warn on
    filter fields not available on the hook's event type. Warn on
    template variables not available for the event type.

    Covers: @dispatch-hook-schema ac-3, @dispatch-hook-filter ac-3,
    @dispatch-schedule-schema ac-3, @dispatch-action-model ac-7.

- title: Implement composition join accumulator
  slug: task-composition-join
  priority: 3
  tags: [dispatch, composition]
  spec_ref: "@dispatch-composition-patterns"
  depends_on:
    - "@task-action-model"
    - "@task-event-bus"
  description: |
    The join accumulator enables fan-in synthesis by tracking action run
    completions per composition group.

    Why: Pipeline chaining works with hooks alone. Fan-in needs a
    primitive that counts completions before firing.

    What: JoinAccumulator subscribes to action.completed events,
    tracks completions by group_id, fires on_complete when threshold
    is met or timeout expires. Group_id is auto-generated per activation
    or inherited from correlation_id. Only successful completions count
    toward threshold; failures are tracked for partial results. Timeout
    starts when first run begins. State is volatile (daemon lifetime).

    How: Define composition schema in meta YAML. Subscribe to
    action.completed/failed on bus. Match runs to groups via group_id.
    State is Map<group_id, GroupState>.

    Covers: @dispatch-composition-patterns ac-2, ac-3,
    @dispatch-composition-correlation ac-1 through ac-4,
    @dispatch-composition-schema ac-1, ac-2.

- title: Build automation view in web UI
  slug: task-automation-view
  priority: 3
  tags: [dispatch, web-ui]
  spec_ref: "@ui-automation-view"
  depends_on:
    - "@task-daemon-api"
  description: |
    New /automation route consolidating all dispatch automation config
    and monitoring.

    Why: With hooks, schedules, and composition, automation needs its
    own view where everything is visible together.

    What: Sections for agent dispatch triggers, hooks, schedules, event
    log (real-time via WebSocket), and composition groups. Inline editing
    for configuration. Real-time event log via "automation" WebSocket
    topic. Schedule runtime state from daemon API.

    How: Follow existing tasks/sessions view patterns. TanStack Query
    for data. WebSocket subscription for live updates.

    Covers: @ui-automation-view ac-1 through ac-7.

- title: Migrate dispatch triggers from agents view
  slug: task-migrate-triggers
  priority: 3
  tags: [dispatch, web-ui, spec-update]
  spec_ref: "@ui-automation-view"
  depends_on:
    - "@task-automation-view"
  description: |
    Move dispatch trigger editing from agent cards to automation view.
    Update @ui-agent-dispatch spec to remove ac-4 through ac-9 since
    those behaviors are superseded by @ui-automation-view ac-5.

    Why: All event-driven configuration should live in one place.

    What: Remove trigger editing from agent cards, add read-only summary
    with link to automation view. Move existing components (relocate, not
    rewrite). Update @ui-agent-dispatch spec — this is a spec change,
    not just an implementation change.

    How: kspec item ac set @ui-agent-dispatch ac-4 through ac-9 to mark
    as superseded, or remove and add a note. Agent cards keep read-only
    trigger summary with "Configure in Automation" link.

- title: Cancel subsumed dispatch trigger expansion task
  slug: task-cancel-old-trigger-task
  priority: 4
  tags: [dispatch, cleanup]
  depends_on:
    - "@task-event-bus"
  description: |
    Cancel task 01KKBD6GBCWTZA2ECFWN62F92F (Dispatch trigger expansion
    ideas) since this plan comprehensively supersedes it. Only execute
    after the plan is approved and foundational work has begun.
```

## Implementation Notes

This plan expands the dispatch engine's event system across lifecycle
hooks, cron schedules, and multi-agent composition.

Architecture: A unified event bus with standard envelope (identity,
causation chain, loop prevention) that all sources publish to. A shared
action model with action run tracking (works for all action types, not
just agent invocations). Hooks and dispatch rules as independent bus
subscribers. Schedules as a time-based event source.

Key contracts added based on review:
1. Event envelope with event_id, correlation_id, causation_id for
   identity, lineage, and loop prevention (max chain depth).
2. Session lifecycle events (session.ended, session.idle_timeout,
   session.cancelled) — distinct from invocation events.
3. Action runs as the uniform abstraction for all action executions,
   not just invocations. Overlap policies key off action runs.
4. Structured command form (program + args[], not shell strings) to
   eliminate injection by construction.
5. Agent action input contract with prompt templating, task_binding
   opt-in, and correlation/group propagation.
6. Schedule runtime state is explicitly volatile (daemon lifetime).
   Backfill is best-effort. tick_time is scheduled wall-clock time.
7. Composition correlation semantics: group_id propagation, success-only
   join counting, timeout from first run, volatile state.
8. Hook filter language: exact-match for scalars, contains-all for
   arrays. Validate warns on unknown fields.
9. Automation API and event stream as proper specs with API/WebSocket
   traits, not just implementation tasks.
10. kspec event emit for testing hook configurations.

Industry patterns: Claude Code hooks (declarative config, handler types),
Temporal Schedules (schedule as entity, overlap policies), LangGraph
scatter-gather (fan-out/fan-in without DAG), CloudEvents envelope
(identity, source, causation).

Existing task 01KKBD6GBCWTZA2ECFWN62F92F (dispatch trigger expansion)
is subsumed and should be cancelled after plan approval.
