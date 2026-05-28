# Multi-Turn Session Lifecycle

## Specs

```yaml
# ─── Core Lifecycle ───

- title: Multi-Turn Session Lifecycle
  slug: multi-turn-session-lifecycle
  type: feature
  parent: "@agent-integration"
  description: |
    Event-driven session lifecycle where sessions remain alive between
    turns. After each agent turn completes, the session enters an idle
    state and emits a session idle event. The
    session stays open until something explicitly closes it — a
    timeout, a close action, or the absence of any queued prompts
    after a grace period.

    The lifecycle is: spawn → idle ⇄ prompting → close. The session
    loops between prompting and idle until a close decision is made.
    This enables post-turn automation (reflection prompts, chained
    analysis) and allows external sources to deliver follow-up
    prompts to a running session.

    A multi-turn session is a single invocation. The session
    identifier represents the full lifecycle from spawn to close,
    regardless of how many turns occur. The invocation completed
    event fires once at session close. The session idle event
    provides the per-turn observation point.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent's turn completes
      when: |
        The turn result is processed
      then: |
        The session transitions to idle state
    - id: ac-2
      given: |
        A session is in idle state after a turn
      when: |
        The session state is queried
      then: |
        The session remains open and capable of receiving follow-up
        prompts
    - id: ac-3
      given: |
        A session transitions to idle state after a turn
      when: |
        The state transition is processed
      then: |
        A session idle event is emitted with the session's context
    - id: ac-4
      given: |
        A session is in idle state
      when: |
        A follow-up prompt is delivered
      then: |
        The session transitions to prompting state and the prompt
        is delivered to the agent
    - id: ac-5
      given: |
        A session enters idle and no prompt is queued within the
        configured grace period
      when: |
        The grace period expires
      then: |
        The session is closed
    - id: ac-6
      given: |
        A session is in idle state and the agent uses a session mode
        that disables auto-close
      when: |
        No prompt arrives within the grace period
      then: |
        The session stays in idle state
    - id: ac-7
      given: |
        A session has been in idle state longer than the configured
        idle timeout
      when: |
        The timeout expires
      then: |
        A session idle timeout event is emitted and the session is
        closed
    - id: ac-8
      given: |
        A session is in prompting state
      when: |
        A new prompt is submitted for the same session
      then: |
        The prompt is queued and delivered when the current turn
        completes
    - id: ac-9
      given: |
        Multiple sources submit prompts for an idle session
        simultaneously
      when: |
        The prompts arrive
      then: |
        One prompt transitions the session to prompting and the
        remaining prompts are queued and delivered in order after
        each subsequent idle transition
    - id: ac-10
      given: |
        A session receives a close request while in prompting state
      when: |
        The agent's current turn completes
      then: |
        Queued prompts are discarded and the session closes
    - id: ac-11
      given: |
        An invocation is spawned with no idle-targeting hooks
        configured and no interactive session mode
      when: |
        The agent's first turn completes
      then: |
        The session auto-closes after the grace period with no
        observable behavior change from single-turn dispatch
    - id: ac-12
      given: |
        A session completes multiple turns via follow-up prompts
      when: |
        The session is eventually closed
      then: |
        All turns are recorded in the same session's event history
    - id: ac-13
      given: |
        A multi-turn session closes after completing multiple turns
      when: |
        The session metadata is finalized
      then: |
        The metadata reflects total turn count and cumulative
        duration across all turns
    - id: ac-14
      given: |
        A multi-turn session is closed
      when: |
        The invocation completed event is emitted
      then: |
        The event fires exactly once per session at close and
        includes the turn count
    - id: ac-15
      given: |
        An agent encounters a fatal error during a turn in a
        multi-turn session
      when: |
        The error is detected
      then: |
        The session closes immediately with failed status
    - id: ac-16
      given: |
        A session closes due to an error and prompts are queued
      when: |
        The session closes
      then: |
        Queued prompts are discarded and any session prompt actions
        waiting on those prompts fail
    - id: ac-17
      given: |
        The prompt queue has reached its configured maximum depth
      when: |
        A new prompt is submitted
      then: |
        The prompt is rejected with an error indicating the queue
        is full

- title: Session Idle Event
  slug: session-idle-event
  type: requirement
  parent: "@dispatch-event-taxonomy"
  description: |
    Event emitted each time an agent completes a turn and the session
    enters idle state. This event enables post-turn automation and
    signals that the session is ready for follow-up prompts.

    The session idle event fires while the session is still alive and
    receptive to prompts. Hooks on this event can inject follow-up
    prompts via the session prompt action type, enabling
    trigger-driven multi-turn conversations.
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent completes a turn
      when: |
        The session transitions to idle
      then: |
        A session idle event is emitted with the session context,
        agent identity, task reference, turn count, turn completion
        reason, and the duration of the completed turn
    - id: ac-2
      given: |
        A session completes its third turn via follow-up prompts
      when: |
        The session idle event is emitted
      then: |
        The turn count in the event reflects the cumulative number
        of completed turns
    - id: ac-3
      given: |
        A hook is configured on the session idle event with a filter
        on turn count or agent
      when: |
        A session idle event fires that does not match the filter
      then: |
        The hook does not execute
    - id: ac-4
      given: |
        Existing hooks and dispatch rules target other event types
      when: |
        The session idle event is registered
      then: |
        Existing configurations are unaffected

# ─── Session Prompt Action ───

- title: Session Prompt Action Type
  slug: session-prompt-action
  type: feature
  parent: "@dispatch-action-model"
  description: |
    Action type that delivers a prompt to an active session that is
    currently in idle state. Unlike the agent action (which spawns a
    new invocation), a session prompt action targets an existing
    session.

    This is the mechanism that allows hooks on session idle events to
    inject follow-up prompts into the same conversation. The agent
    retains full conversation context across turns.

    Session prompt actions can only target sessions that are alive
    and idle. If the target session is already closed or in prompting
    state, the prompt is queued or fails gracefully.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        A session prompt action is configured with a prompt
      when: |
        The action executes and the target session is in idle state
      then: |
        The prompt is delivered to the session as a follow-up turn
    - id: ac-2
      given: |
        A session prompt action is executing
      when: |
        The action lifecycle is tracked
      then: |
        An action started event is emitted when delivery begins and
        an action completed event is emitted when the turn finishes
    - id: ac-3
      given: |
        A session prompt action fires from a hook on a session idle
        event
      when: |
        The target session is resolved
      then: |
        The action targets the session from the triggering event
        without requiring explicit session configuration
    - id: ac-4
      given: |
        A session prompt action targets a session that has already
        been closed
      when: |
        The action attempts to deliver the prompt
      then: |
        The action fails with a clear error indicating the session
        is no longer active
    - id: ac-5
      given: |
        A session prompt action targets a session that is in
        prompting state
      when: |
        The action attempts to deliver the prompt
      then: |
        The prompt is queued for delivery after the current turn
        completes
    - id: ac-6
      given: |
        A session prompt action uses template variables in the
        prompt
      when: |
        The prompt is constructed
      then: |
        Template variables are interpolated from the triggering
        event context
    - id: ac-7
      given: |
        A session prompt action is configured outside a session idle
        hook
      when: |
        The action is validated
      then: |
        The action requires an explicit session identifier to
        identify the target session

- title: Session Prompt Action Schema
  slug: session-prompt-action-schema
  type: requirement
  parent: "@session-prompt-action"
  traits:
    - "@trait-error-guidance"
  description: |
    Validation rules for session prompt actions in hooks and
    schedules. Ensures prompt actions are well-formed before
    execution.
  acceptance_criteria:
    - id: ac-1
      given: |
        A session prompt action is defined in a hook or schedule
      when: |
        The configuration is loaded
      then: |
        The action is parsed with a prompt or prompt template
        (at least one required) and an optional session identifier
    - id: ac-2
      given: |
        An existing configuration uses only the previously defined
        action types
      when: |
        The configuration is loaded
      then: |
        The configuration loads successfully with the session prompt
        type as an additive option
    - id: ac-3
      given: |
        A session prompt action in a hook on a session idle event
        omits the session identifier
      when: |
        Validation runs
      then: |
        The action is valid because the session identifier defaults
        to the triggering event's session
    - id: ac-4
      given: |
        A session prompt action in a hook on a non-session event
        omits the session identifier
      when: |
        Validation runs
      then: |
        A warning indicates that a session identifier is required
        and the action will fail at runtime without it

# ─── Session Handle Registry ───

- title: Active Session Registry
  slug: active-session-registry
  type: feature
  parent: "@multi-turn-session-lifecycle"
  description: |
    A runtime registry of active sessions that allows actions to
    deliver prompts to live sessions. Maps session identifiers to
    handles providing prompt delivery and state query capabilities.

    The registry is volatile (daemon lifetime). It exposes a minimal
    interface for prompt delivery, state query, and close requests.
    This keeps action execution decoupled from session internals
    while enabling the session prompt action type.
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent invocation starts and a session is created
      when: |
        The session is registered
      then: |
        The registry maps the session to a handle that supports
        prompt delivery, state query, and close requests
    - id: ac-2
      given: |
        A session is closed
      when: |
        Cleanup runs
      then: |
        The session is removed from the registry and subsequent
        lookups return no result
    - id: ac-3
      given: |
        An action needs to deliver a prompt to a session
      when: |
        It queries the registry by session identifier
      then: |
        It receives a handle if the session is active, or no result
        if the session has been closed
    - id: ac-4
      given: |
        The daemon shuts down
      when: |
        Active sessions exist in the registry
      then: |
        All registered sessions are closed and the registry is
        cleared

```

## Tasks

derive_from_specs: false

```yaml
- title: Implement active session registry
  slug: task-session-registry
  priority: 1
  tags: [dispatch, sessions, foundation]
  spec_ref: "@active-session-registry"
  description: |
    Create the session handle registry that maps session_id to a
    minimal interface for prompt delivery, state query, and close.

    Why: The session_prompt action type needs a way to find and
    interact with live sessions without coupling to ACP internals.
    The registry is the bridge between the stateless event/action
    system and the stateful session lifecycle.

    What: A SessionRegistry class with register(id, handle),
    unregister(id), get(id), and listActive(). The SessionHandle
    interface exposes: sendPrompt(prompt) → Promise, getState() →
    idle|prompting|closed, requestClose(reason) → void. The
    registry is owned by the dispatch engine and shared with the
    action executor via dependency injection.

    How: The registry is a Map<string, SessionHandle>. Handles are
    created by the invocation runner when a session starts and
    removed during teardown. The handle wraps the ACP client but
    doesn't expose it — sendPrompt() calls client.prompt()
    internally. Thread safety comes from the prompt queue (ac-8/ac-9
    of the lifecycle spec).

    Covers: @active-session-registry ac-1 through ac-4.

- title: Refactor invocation runner to multi-turn lifecycle
  slug: task-multi-turn-invocation
  priority: 1
  tags: [dispatch, sessions, invocation]
  spec_ref: "@multi-turn-session-lifecycle"
  depends_on:
    - "@task-session-registry"
  description: |
    Replace the linear prompt-then-teardown flow in invocation.ts
    with an event-driven turn loop that keeps the session alive
    between turns.

    Why: The current runInvocation() sends one prompt, then
    unconditionally tears down. Every other feature in this plan
    depends on sessions staying alive after a turn completes. This
    is the core architectural change.

    What: After the first prompt returns (stopReason: end_turn),
    the session enters idle state instead of proceeding to teardown.
    A prompt queue accepts follow-up prompts from any source. The
    runner loops: wait for prompt → send → wait for turn completion
    → idle → repeat. The loop exits when a close is requested or the
    grace period expires with no queued prompts.

    The session handle (from the registry) is the interface other
    components use to enqueue prompts. The runner consumes the queue.

    How: runInvocation() becomes an async loop instead of a linear
    function. The state machine is: spawning → prompting → idle →
    (prompting | closing). The idle state emits session.idle on the
    event bus (via a callback, same pattern as onInvocationEvent).
    A grace period timer starts on each idle entry — if no prompt
    arrives before it expires and the session isn't interactive, the
    loop breaks and teardown proceeds. The existing timeout_minutes
    applies to total session duration, not per-turn.

    Backward compatibility: when no hooks target session.idle and
    session_mode is not interactive, the grace period expires after
    the first turn and teardown proceeds — identical to current
    behavior.

    Covers: @multi-turn-session-lifecycle ac-1, ac-2, ac-3, ac-4,
    ac-8, ac-9, ac-10, ac-15, ac-16, ac-17.

- title: Add session.idle event to taxonomy and payloads
  slug: task-session-idle-event
  priority: 1
  tags: [dispatch, events, schema]
  spec_ref: "@session-idle-event"
  description: |
    Register session.idle in the event taxonomy and define its
    payload schema.

    Why: Hooks and the UI need to reference session.idle as a valid
    event type. The payload schema defines what filters can match on
    and what template variables are available.

    What: Add session.idle to the event registry in event-registry.ts.
    Define its payload in event-payloads.ts: session_id, agent_id,
    task_ref (nullable), turn_count (number), stop_reason (string),
    duration_ms (of the completed turn). Update validation to accept
    session.idle in hook configurations. Add to the UI trigger picker.

    How: Follow the exact pattern used for session.ended — add to
    SESSION_EVENTS, define payload schema, register in the combined
    registry. The payload is a superset of session.ended with the
    addition of turn_count and stop_reason, minus terminal_reason
    (since the session isn't terminal).

    Covers: @session-idle-event ac-1 through ac-4.

- title: Implement session_prompt action type
  slug: task-session-prompt-action
  priority: 1
  tags: [dispatch, actions, sessions]
  spec_ref: "@session-prompt-action"
  depends_on:
    - "@task-session-registry"
    - "@task-session-idle-event"
  description: |
    Add the session_prompt action type to the shared action model
    and implement its execution in the action executor.

    Why: This is the action that makes trigger-driven multi-turn
    sessions work. Without it, hooks on session.idle can only spawn
    new invocations or run commands — they can't send prompts to the
    session that just went idle.

    What: Add SessionPromptActionSchema to action.ts with fields:
    type ("session_prompt"), prompt (optional), prompt_template
    (optional), session_id (optional — defaults to event's
    session_id for session.idle hooks). Add to the ActionSchema
    discriminated union and ACTION_TYPES constant. Implement
    executeSessionPrompt() in ActionExecutor that resolves the
    target session from the registry, delivers the prompt via the
    session handle, and tracks the action run until the turn
    completes.

    How: The executor resolves session_id from either the explicit
    field or the event context (for session.idle hooks). It calls
    registry.get(sessionId) to get the handle, then
    handle.sendPrompt(interpolatedPrompt). The action run stays
    in running state until the prompt delivery promise resolves
    (which happens when the agent's turn completes). If the session
    is closed, the action fails with a clear error.

    Covers: @session-prompt-action ac-1 through ac-7,
    @session-prompt-action-schema ac-1 through ac-4.

    Note: @session-prompt-action ac-2 (action lifecycle events) is
    inherited from the shared action model pattern — verified by
    existing action executor tests.

- title: Implement idle grace period and auto-close logic
  slug: task-idle-grace-period
  priority: 2
  tags: [dispatch, sessions, backward-compat]
  spec_ref: "@multi-turn-session-lifecycle"
  depends_on:
    - "@task-multi-turn-invocation"
    - "@task-session-prompt-action"
  description: |
    Implement the grace period that determines when an idle session
    auto-closes, and the session mode flag that can disable it.

    Why: Backward compatibility requires that sessions without
    idle-targeting hooks close automatically after one turn, matching
    current behavior. Sessions with hooks or a non-auto-close mode
    need to stay open. The grace period bridges these modes.

    What: When a session enters idle, a configurable timer starts
    (default 5 seconds). If no prompt arrives before it expires and
    the session mode allows auto-close, the session closes. The
    timer resets if a prompt is queued. The agent definition schema
    gets a session mode field and an idle timeout field.

    How: The grace period timer is part of the turn loop in
    invocation.ts. It races against the prompt queue — whichever
    fires first wins. For auto-close mode, the grace period is short
    (enough for hooks to fire and queue prompts). For modes that
    disable auto-close, only idle timeout applies. The agent schema
    extension is in meta.ts.

    Covers: @multi-turn-session-lifecycle ac-5, ac-6, ac-7, ac-11.

- title: Integrate multi-turn lifecycle with dispatch engine
  slug: task-dispatch-multi-turn-integration
  priority: 2
  tags: [dispatch, sessions, integration]
  spec_ref: "@multi-turn-session-lifecycle"
  depends_on:
    - "@task-multi-turn-invocation"
    - "@task-idle-grace-period"
  description: |
    Wire the multi-turn invocation lifecycle into the dispatch
    engine, ensuring session registry, event emission, concurrency
    tracking, and post-invocation cleanup all work with sessions
    that span multiple turns.

    Why: The dispatch engine currently assumes runInvocation() = one
    prompt = done. With multi-turn sessions, a single runInvocation()
    call may span many turns over a longer duration. Concurrency
    tracking, task exclusivity, timeout enforcement, and event
    emission all need to account for this.

    What: The dispatch engine registers sessions in the registry
    before spawning. It receives session.idle events from the bus
    (for metrics/logging). The per-task exclusivity lock is held for
    the entire multi-turn session, not released after each turn.
    The overall timeout_minutes still applies to the total session
    duration. invocation.completed fires once when the session
    finally closes, with turn_count in the payload.

    How: _spawnInvocation() registers the session handle before
    calling runInvocation(). The onIdle callback (from the invocation
    runner) emits session.idle on the event bus. Post-invocation
    cleanup runs when runInvocation() returns (after the turn loop
    exits and teardown completes). The existing invocation.completed
    event payload is extended with turn_count.

    Covers: @multi-turn-session-lifecycle ac-1, ac-2, ac-3, ac-4
    (integration-level verification of state machine wired through
    dispatch), ac-12, ac-13, ac-14.

- title: Update existing specs for multi-turn lifecycle
  slug: task-update-existing-specs
  priority: 1
  tags: [specs, compatibility]
  spec_ref: "@multi-turn-session-lifecycle"
  description: |
    Update existing spec items to align with multi-turn session
    semantics.

    Why: Several existing ACs describe single-turn session behavior.
    Updating them ensures consistent definitions of session
    completion and cleanup across the spec system.

    What: Apply the four updates documented in the "Existing spec
    updates" table in the implementation notes:
    @agent-invocation-lifecycle ac-4 (end_turn → idle, not close),
    @agent-invocation-lifecycle ac-8 (cleanup at session close),
    @dispatch-event-taxonomy description (add session.idle),
    @dispatch-action-model description (add session_prompt).

    How: Use kspec item ac set to update the specific ACs. Use kspec
    item set --description for description updates. Each change is
    a targeted update to an existing spec item, not a new spec.
    Verify each update with kspec item get after applying.

    Covers: @multi-turn-session-lifecycle (alignment of dependent
    specs).

- title: Update automation view for session idle events
  slug: task-ui-session-idle
  priority: 3
  tags: [web-ui, automation]
  spec_ref: "@session-idle-event"
  depends_on:
    - "@task-session-idle-event"
    - "@task-session-prompt-action"
  description: |
    Update the automation view to display session idle events and
    recognize the session prompt action type.

    Why: The event log needs to render session idle events with
    turn count context so users can observe multi-turn session
    behavior. The dispatch trigger picker and hook display need
    to recognize the new event and action types.

    What: The dispatch trigger picker renders from the event
    registry, so session idle appears automatically once registered.
    The event log needs rendering for session idle events showing
    turn count and agent context. The read-only hook display needs
    to show "session_prompt" as a recognized action type badge.

    Note: Full hook editing UI (including a session prompt action
    form with prompt/template fields) does not exist yet — hooks
    are currently read-only in the UI. Building a hook editor is
    separate work that would include forms for all action types,
    not just session prompt.

    How: Add an event log row renderer for session idle events
    following the pattern of existing event type renderers. Ensure
    the action type badge component recognizes "session_prompt" as
    a valid type label. The trigger picker is automatic.

    Covers: @session-idle-event ac-1 (event log rendering).
```

## Implementation Notes

### Grace period design rationale

The grace period (default 5s) bridges backward compatibility with multi-turn capability. It must be long enough for hooks to fire and queue their prompts, but short enough that single-turn dispatch doesn't feel sluggish. The 5s default is conservative — it should be tunable per-agent.

### Prompt queue ordering

When multiple sources submit prompts to the same session (hooks + user), FIFO ordering ensures deterministic behavior. The queue is internal to the session handle — external callers don't control ordering beyond submission time. This is simpler than priority-based ordering and avoids the question of who outranks whom.

### Session handle vs ACP client exposure

The session handle pattern exists to keep the action executor decoupled from ACP internals. The executor calls handle.sendPrompt() without knowing about ACP sessions, JSON-RPC, or process management. This enables future adapter changes without touching the action system.

### Relationship to existing events

session.idle is distinct from all existing events:
- session.ended: fires after teardown (session is dead)
- invocation.completed: fires after teardown (invocation is done)
- session.idle: fires while session is alive (ready for more work)

The existing events continue to fire at their current timing. session.idle adds a new observation point, not a replacement.

### Existing spec updates (task-update-existing-specs reference)

These updates align existing specs with the multi-turn lifecycle:

| Existing AC | Current wording (summary) | Updated wording (summary) | Reason |
|---|---|---|---|
| @agent-invocation-lifecycle ac-4 | "When the agent signals turn complete → session closed with status completed" | "When the agent signals turn complete → session transitions to idle; session is closed when no more prompts arrive (grace period expiry, explicit close, or timeout)" | Turn completion is a turn boundary, not session completion |
| @agent-invocation-lifecycle ac-8 | "When invocation completes → cleanup runs (env restore, process termination)" | "When session closes (after all turns complete) → cleanup runs (env restore, process termination)" | Cleanup is per-session, not per-turn |
| @dispatch-event-taxonomy description | Lists session events as: session.ended, session.idle_timeout, session.cancelled | Add session.idle to the enumeration | New event type |
| @dispatch-action-model description | Lists 4 action types: command, kspec, agent, notify | Add session_prompt as 5th type | New action type |

### session.idle_timeout already exists

The existing taxonomy already includes session.idle_timeout. This plan's lifecycle spec ac-7 emits that event on idle timeout, which is consistent. No payload change is needed — the existing payload contract covers session_id, agent_id, task_ref, duration_ms, and terminal_reason.
