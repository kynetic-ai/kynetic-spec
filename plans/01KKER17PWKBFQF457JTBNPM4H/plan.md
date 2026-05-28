# Initial Activity Watchdog for Agent Invocations

## Problem

When the dispatch engine spawns a codex-acp agent, the ACP handshake succeeds (initialize, session/new) and the prompt is delivered via session/prompt, but the agent sometimes goes completely silent — no message chunks, no tool calls, nothing. The only protection is the 30-minute invocation timeout, which wastes the full budget before detecting the problem.

Observed: 2 out of 3 recent codex-acp dispatch invocations stalled on initial prompt with zero meaningful output. The successful session produced 1,600+ events in 13 minutes; the stalled sessions produced 3-4 events (handshake only) before timing out.

## Approach

Add a watchdog timer at the invocation level that detects when an agent accepts a prompt but never starts producing meaningful output. On stall detection, fail fast and let the dispatch engine's existing reconciliation cycle re-queue the work.

Key design decisions:
- Watchdog lives in invocation.ts, not the framing layer — it needs semantic knowledge of what "meaningful activity" means
- Stalls get a distinct session status (`stalled`) and outcome, separate from generic failures — cleaner diagnostics and avoids needing special-case logic in the consecutive failure counter
- `available_commands_update` and other handshake-level notifications do NOT count as meaningful activity
- Default stall timeout is 120 seconds, configurable via agent budget
- No task notes on stall — these are transient infrastructure issues, not agent logic failures
- `runInvocation` handles stalls internally (returns `{ outcome: "stalled" }` without throwing), so the dispatch engine's retry counter is never triggered — reconciliation handles re-evaluation naturally

### Meaningful update types

Activity from the agent model that proves it received and is processing the prompt:
- `agent_message_chunk` — model producing text
- `agent_thought_chunk` — model internal reasoning (extended thinking models emit this before visible output)
- `tool_call` — model initiated a tool call
- `tool_call_update` — tool call progress
- `plan` — agent execution plan for complex tasks
- `usage_update` — token usage reported (UNSTABLE in ACP spec; watchdog correctness does not depend on it)

NOT meaningful (infrastructure-level, not model activity):
- `available_commands_update` — agent advertising capabilities
- `current_mode_update` — session config
- `config_option_update` — session config
- `session_info_update` — metadata
- `user_message_chunk` — echoed user input

## Specs

```yaml
- slug: invocation-initial-activity-watchdog
  title: Initial Activity Watchdog
  type: feature
  parent: "@agent-invocation-lifecycle"
  description: |
    Detects when an agent accepts a prompt via ACP but never starts producing
    meaningful output. Races a stall timer alongside the prompt promise and
    fails fast on detection, allowing the dispatch engine's reconciliation
    cycle to retry without penalty. Prevents wasting the full invocation
    timeout budget on non-responsive agent sessions.
  traits:
    - "@trait-error-guidance"
  acceptance_criteria:
    - id: ac-1
      given: |
        An agent invocation has sent the prompt via session/prompt
      when: |
        No meaningful session updates (agent_message_chunk,
        agent_thought_chunk, tool_call, tool_call_update, plan,
        usage_update) are received within the configured
        initial_response_timeout_seconds (default 120)
      then: |
        The invocation detects the stall and cancels the ACP session
    - id: ac-2
      given: |
        A stall has been detected per ac-1
      when: |
        The invocation handles the stall
      then: |
        The agent process is terminated, the session is closed with
        status stalled and a reason indicating the duration, and no
        task note is added
    - id: ac-3
      given: |
        An agent invocation has sent the prompt via session/prompt
      when: |
        A meaningful session update arrives before the stall timer fires
      then: |
        The stall timer is cancelled and never fires for the remainder
        of the invocation, allowing the normal invocation timeout to
        govern session lifetime
    - id: ac-4
      given: |
        A prior invocation ended with status stalled
      when: |
        The consecutive failure counter evaluates the task history
      then: |
        Stalled sessions are excluded from the count because they
        are transient infrastructure issues not agent logic failures
    - id: ac-5
      given: |
        An agent definition includes a budget configuration
      when: |
        The initial_response_timeout_seconds field is set
      then: |
        The stall watchdog uses the configured value instead of the
        default 120 seconds
```

## Tasks

derive_from_specs: true

```yaml
- slug: task-implement-stall-watchdog
  spec_ref: "@invocation-initial-activity-watchdog"
  title: Implement initial activity watchdog in invocation lifecycle
  tags: [mvp, agent-runtime]
  implementation_notes: |
    Schema changes (src/schema/meta.ts):
    1. Add initial_response_timeout_seconds (optional positive integer) to agent budget schema

    Session types (src/sessions/types.ts):
    2. Add "stalled" to SessionStatusSchema z.enum (line ~24), which derives SessionMetadata.status
    3. Add "agent.stalled" to EventTypeSchema z.enum (line ~128) for observability parity
       with agent.timeout and agent.failed

    Invocation types (src/agent-runtime/invocation.ts):
    4. Add "stalled" to InvocationResult.outcome union (line ~84)
    5. Add InvocationStallError class alongside InvocationTimeoutError

    Session store (src/sessions/store.ts):
    6. Add "stalled" to any Record<SessionStatus, number> maps or ordered status arrays
       that enumerate session statuses

    Invocation logic (src/agent-runtime/invocation.ts):
    7. In the updateHandler (line ~358), check update type — if it's one of the
       meaningful types, set stallResolved=true and clearTimeout(stallHandle)
    8. Create stallPromise alongside timeoutPromise/abortPromise (lines ~406-422)
       that rejects with InvocationStallError after initial_response_timeout_seconds
       if stallResolved is still false. Add to racers array at line ~431.
    9. Add catch block for InvocationStallError BETWEEN InvocationAbortedError (line ~524)
       and the generic failure handler (line ~526) — ordering matters for reachability:
       - Cancel ACP session (best-effort)
       - Log agent.stalled event to session JSONL
       - Close session with status "stalled", reason "No initial response within Ns"
       - Do NOT add task note
       - Do NOT call getConsecutiveFailureCount
       - Return { outcome: "stalled" }
    10. Add clearTimeout(stallHandle) to the finally block alongside existing
        timeout handle cleanup (line ~434-438)

    Failure counter (src/agent-runtime/invocation.ts):
    11. In getConsecutiveFailureCount, exclude sessions with status "stalled"
        from the consecutive failure count (add "stalled" to toInvocationOutcome
        mapping as a non-failure outcome that returns null)

    Dispatch (src/agent-runtime/dispatch.ts):
    12. No changes needed — runInvocation handles stalls internally (returns rather
        than throws), so the dispatch retry counter is never triggered. Reconciliation
        re-evaluates task eligibility and re-dispatches naturally. Note: the dispatch
        engine will emit type "completed" for stalled invocations — this is expected
        and acceptable for now since stalls are not failures.

- slug: task-test-stall-watchdog
  spec_ref: "@invocation-initial-activity-watchdog"
  title: Test initial activity watchdog behavior
  tags: [mvp, agent-runtime, test]
  depends_on: ["@task-implement-stall-watchdog"]
  implementation_notes: |
    Test cases using mock-acp adapter:
    1. Agent sends no updates after prompt — stall fires, session closed as stalled (ac-1, ac-2)
    2. Agent sends available_commands_update only — still stalls, not meaningful (ac-1)
    3. Agent sends agent_message_chunk before timer — stall cancelled, normal flow (ac-3)
    4. Agent sends tool_call before timer — stall cancelled, normal flow (ac-3)
    5. Agent sends agent_thought_chunk before timer — stall cancelled (ac-3)
    6. Agent sends plan before timer — stall cancelled (ac-3)
    7. Agent sends usage_update before timer — stall cancelled (ac-3)
    8. Custom initial_response_timeout_seconds respected (ac-5)
    9. Stalled sessions excluded from consecutive failure count (ac-4)
    10. No task note added on stall (ac-2)
    11. agent.stalled event logged to session JSONL (ac-2)
    12. Stall timer cleaned up on normal completion (no leaked timers)
```

## Implementation Notes

The stall watchdog uses the same Promise.race pattern as the existing invocation
timeout — a stallPromise that rejects with InvocationStallError is added to the
racers array. The stallResolved flag in the updateHandler closure cancels the timer
on first meaningful activity. The updateHandler is registered before the prompt is
sent (line ~370), so there's no race between the first update and the stall timer setup.

The dispatch engine requires no changes. runInvocation never throws for stalls —
it catches InvocationStallError internally and returns { outcome: "stalled" }.
The dispatch engine sees a resolved promise and moves on. The task remains in its
current state (in_progress or needs_work), and the next reconciliation cycle
re-evaluates eligibility and re-dispatches if appropriate.
