# Interactive Agent Sessions

> **Status: WIP** — Split out from @plan-multi-turn-session-lifecycle during review. These specs need further refinement before they're ready for import. The core multi-turn lifecycle plan provides the foundation this work builds on.

## Context

The multi-turn session lifecycle plan introduces an event-driven session model where sessions stay alive between turns via idle/prompting states, a prompt queue, and session idle events. That plan deliberately scopes to automated multi-turn sessions (hooks injecting prompts, grace period auto-close).

Interactive sessions extend that foundation with human-facing concerns:
- A session mode that disables auto-close so humans can think between turns
- API and CLI surfaces for submitting prompts to a running session
- A prompt loop experience in the terminal

These specs were drafted alongside the multi-turn lifecycle but are under-baked. The API and CLI specs in particular need more thought around:
- How streaming output reaches the user (real-time display during a turn)
- Session discovery (how does a user find and attach to a running session?)
- Relationship to `kspec agent run` which currently does one-shot invocations
- Whether the API prompt endpoint is synchronous (wait for turn) or async (acknowledge + stream)
- Authentication/authorization for session access (currently localhost-only, but multi-user scenarios?)
- How interactive sessions interact with the dispatch engine (does an interactive session block task exclusivity?)

## Specs (draft)

```yaml
- title: Interactive Agent Sessions
  slug: interactive-agent-sessions
  type: feature
  parent: "@agent-integration"
  description: |
    Extends the multi-turn session lifecycle with a human-facing
    interaction mode. When an agent definition uses interactive
    session mode, the session stays open after each turn, waiting
    for user input via API or CLI.

    Interactive sessions use the same multi-turn lifecycle state
    machine — idle and prompting states, prompt queue, session idle
    events, and close semantics are all inherited from the core
    lifecycle. This spec defines only the interactive-specific
    behaviors: the mode flag that disables auto-close, and the
    user-facing prompt submission surfaces (API, CLI).
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent definition uses interactive session mode
      when: |
        An invocation is started for this agent
      then: |
        The session remains open after each turn until explicit
        close, idle timeout, or daemon shutdown
    - id: ac-2
      given: |
        An interactive session is in idle state
      when: |
        A user submits a prompt
      then: |
        The prompt is delivered to the agent as a follow-up turn
        with full conversation context from all prior turns
    - id: ac-3
      given: |
        A user sends an explicit close command to an interactive
        session
      when: |
        The session is in idle state
      then: |
        The session closes and the standard completion events fire
    - id: ac-4
      given: |
        An interactive session is running
      when: |
        The agent produces streaming output during a turn
      then: |
        The output is available to connected clients in real time

- title: Interactive Session API
  slug: interactive-session-api
  type: requirement
  parent: "@interactive-agent-sessions"
  traits:
    - "@trait-api-endpoint"
    - "@trait-localhost-security"
    - "@trait-json-output"
  description: |
    API endpoints for interactive session management. Allows human
    users to submit prompts, query session state, and close sessions.
  acceptance_criteria:
    - id: ac-1
      given: |
        An interactive session is in idle state
      when: |
        A prompt is submitted via the session prompt endpoint
      then: |
        The prompt is delivered to the session and the response
        includes acknowledgment with the turn number
    - id: ac-2
      given: |
        A client queries a session's state
      when: |
        The session state endpoint is called
      then: |
        The response includes current state, turn count, agent,
        task reference, and session duration
    - id: ac-3
      given: |
        A client sends a close request
      when: |
        The session close endpoint is called
      then: |
        If idle, the session closes immediately; if prompting,
        the session closes after the current turn completes
    - id: ac-4
      given: |
        A client submits a prompt to a closed session
      when: |
        The session prompt endpoint is called
      then: |
        The response indicates the session is closed with an error

- title: Interactive Session CLI
  slug: interactive-session-cli
  type: requirement
  parent: "@interactive-agent-sessions"
  traits:
    - "@trait-error-guidance"
    - "@trait-json-output"
  description: |
    CLI commands for interacting with active agent sessions. Provides
    a terminal-based interface for human-agent chat.
  acceptance_criteria:
    - id: ac-1
      given: |
        An interactive session is running
      when: |
        A user submits a prompt to the session via CLI
      then: |
        The prompt is delivered and the agent's response is streamed
        to the terminal
    - id: ac-2
      given: |
        A user starts an agent in interactive mode via CLI
      when: |
        The agent is spawned
      then: |
        The CLI enters a prompt loop where the user can send
        messages and see responses
    - id: ac-3
      given: |
        An interactive CLI session is active
      when: |
        The user sends an empty input or exit command
      then: |
        The session is closed and the CLI exits
    - id: ac-4
      given: |
        Active sessions exist
      when: |
        A user lists active sessions via CLI
      then: |
        Each session shows its identifier, agent, state, turn
        count, and duration
```

## Open Questions

- Should the prompt endpoint be sync (block until turn completes) or async (return immediately, stream via WebSocket)?
- How does a user discover and attach to a session started by dispatch vs one they started themselves?
- Should interactive mode be an agent-level setting or a per-invocation flag (or both)?
- What happens when dispatch wants to assign a task to an agent that's in an interactive session?
- Should there be a web UI component for interactive chat, or is CLI + API sufficient initially?

## Relationship to Multi-Turn Lifecycle

This plan depends on @plan-multi-turn-session-lifecycle being implemented first. The core lifecycle provides:
- Idle/prompting state machine
- Prompt queue with FIFO ordering
- Session idle event emission
- Session prompt action type
- Active session registry
- Grace period and auto-close logic
- Session mode flag (ac-6 of the lifecycle spec supports disabling auto-close)

Interactive sessions layer on top with the user-facing surfaces. The lifecycle's ac-6 ("a session mode that disables auto-close") was designed with interactive mode in mind but is deliberately generic — other modes could also disable auto-close.
