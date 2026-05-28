# Session Stream Redesign: WebSocket-First with On-Demand Detail

Rework the session stream view from dual-channel (HTTP polling + WebSocket
text chunks) to a WebSocket-first model with on-demand HTTP detail. The
WebSocket broadcasts structured lifecycle events — message progress at
newline boundaries, tool call lifecycle, thinking state — while HTTP serves
full event history for initial/historical loads and on-demand tool output
when the user expands a tool call block.

**Key principles:**
- WebSocket for all live session activity (no HTTP polling during live view)
- Newline-boundary text streaming (not per-token chunks, not full-message buffering)
- Tool call input included in start event; only output deferred to on-demand HTTP
- HTTP still serves full events for historical sessions and initial catch-up on live sessions
- CLI `watch` command uses the same WebSocket event system as the UI

**Relationship with `@ui-session-stream`:** The existing spec covers the
session view layer (structured block rendering, auto-scroll, context panel,
collapsed row layout). This plan's `@ws-session-event-streaming` covers the
streaming data layer beneath it. After this plan, `@ui-session-stream` ac-2
is updated to reference the new streaming model rather than duplicating it.

## Specs

```yaml
- title: WebSocket Session Event Streaming
  slug: ws-session-event-streaming
  type: feature
  description: |
    The session stream view receives all live session activity via WebSocket
    structured lifecycle events. Messages stream progressively at newline
    boundaries (not per-token). Tool calls show name and input immediately,
    with output fetched on demand. HTTP serves historical sessions and
    initial catch-up for live sessions already in progress.

    This replaces the current model where WebSocket sends raw text chunks
    and HTTP polls for structured events every 3 seconds during live sessions.
  traits:
    - trait-websocket-protocol
  acceptance_criteria:
    - id: ac-message-start
      given: |
        A user is viewing a live session
      when: |
        The agent begins composing a response
      then: |
        A writing/thinking indicator appears for the in-progress message block.
    - id: ac-message-progress
      given: |
        A user is viewing a live session where the agent is composing a response
      when: |
        The agent produces text that includes newline characters
      then: |
        Completed lines stream into the message block progressively at
        newline boundaries. The user sees text appear line-by-line rather
        than waiting for the full message or seeing per-character updates.
    - id: ac-message-complete
      given: |
        A user is viewing a live session where the agent is composing a response
      when: |
        The agent finishes the message (begins a tool call, starts thinking,
        ends the session, or starts a new turn)
      then: |
        Any remaining buffered text is flushed to the message block.
        The writing indicator is removed. The message renders as a
        complete block identical to how it appears in historical playback.
    - id: ac-tool-call-start
      given: |
        A user is viewing a live session
      when: |
        The agent initiates a tool call
      then: |
        A tool call block appears in "running" state showing the tool name
        and input parameters. No output is shown yet.
    - id: ac-tool-call-complete
      given: |
        A user is viewing a live session with a running tool call
      when: |
        The tool call finishes (success or failure)
      then: |
        The tool call block updates to show completed/failed status and
        execution duration. Output is not loaded until the user expands
        the block.
    - id: ac-tool-output-on-demand
      given: |
        A completed tool call block is displayed (live or historical)
      when: |
        The user expands the tool call to view output
      then: |
        The output is fetched via HTTP with blob content resolved
        server-side. A loading state shows during the fetch. If the
        fetch fails, an error state is shown with retry option.
    - id: ac-thinking-blocks
      given: |
        A user is viewing a live session
      when: |
        The agent emits thinking/reasoning content
      then: |
        A thinking block appears and streams text progressively
        (same newline-boundary streaming as messages). Thinking
        blocks render collapsed by default.
    - id: ac-historical-playback
      given: |
        A user navigates to a completed session
      when: |
        The session detail page loads
      then: |
        All events are fetched via HTTP in a single request.
        Messages, tool calls, and thinking blocks render using the
        same DisplayBlock components as live streaming. Tool call
        blocks render collapsed — output is fetched on-demand when
        the user expands the block (same behavior as live sessions).
    - id: ac-live-session-catchup
      given: |
        A user navigates to a session that is already in progress
      when: |
        The session detail page loads
      then: |
        Events up to the current point are fetched via HTTP (same as
        historical). Then the view transitions to WebSocket streaming
        for subsequent live events. No gap or duplication between
        the HTTP catch-up and WebSocket stream.
    - id: ac-no-http-polling
      given: |
        A live session is being viewed
      when: |
        Agent activity is occurring
      then: |
        No periodic HTTP polling for events occurs. All live session
        activity arrives via WebSocket. HTTP is only used for initial
        catch-up and on-demand tool output fetches.
    - id: ac-reconnect-recovery
      given: |
        The WebSocket connection drops and reconnects while viewing
        a live session
      when: |
        The connection is re-established
      then: |
        Missed events are fetched via HTTP using the last known
        sequence number. The view resumes WebSocket streaming
        after the gap is filled.
    - id: ac-cli-watch-parity
      given: |
        An operator runs kspec agent dispatch watch
      when: |
        An agent is actively working
      then: |
        The CLI watch output uses the same WebSocket event stream
        as the web UI. Text streams progressively at newline
        boundaries. Tool calls show name and status transitions.

- title: Session Event Broadcasting
  slug: session-event-broadcast
  type: requirement
  parent: "@ws-session-event-streaming"
  traits:
    - trait-websocket-protocol
  description: |
    The daemon broadcasts structured session lifecycle events over
    WebSocket. Text content streams at newline boundaries — balancing
    responsiveness (line-by-line updates) with efficiency (not per-token).
    Event state is tracked per-session to support concurrent sessions.
  acceptance_criteria:
    - id: ac-newline-streaming
      given: |
        An agent is producing text output (message or thinking content)
      when: |
        The accumulated text contains one or more newline characters
      then: |
        Complete lines up to the last newline are broadcast as a
        message_progress (or thinking_progress) event. The remaining
        partial line stays in the buffer for the next flush.
    - id: ac-boundary-flush
      given: |
        An agent has been producing text output
      when: |
        A state transition occurs (text → tool call, text → thinking,
        thinking → text, session end, or new turn)
      then: |
        Any remaining buffered text (including partial lines) is
        flushed as part of a _complete event before the new event
        type is broadcast.
    - id: ac-per-session-state
      given: |
        Multiple agent sessions are active concurrently
      when: |
        Events are broadcast
      then: |
        Text accumulation and boundary detection state is tracked
        independently per session. Events include session_id for
        client-side filtering.
    - id: ac-tool-input-included
      given: |
        An agent initiates a tool call
      when: |
        The tool_call_start event is broadcast
      then: |
        The event payload includes the tool name and input parameters.
        Tool output is excluded — it is fetched on demand via HTTP.
    - id: ac-replaces-text-chunks
      given: |
        The new event streaming is deployed
      when: |
        An agent produces output
      then: |
        The agent_text_chunk event type is no longer broadcast.
        All consumers (web UI, CLI watch, ws-invalidation) use
        the new typed event stream.

- title: Session Event Detail Endpoint
  slug: session-event-detail-endpoint
  type: requirement
  parent: "@ws-session-event-streaming"
  traits:
    - trait-api-endpoint
  description: |
    HTTP endpoint for fetching the full detail of a single session event,
    primarily used for on-demand tool call output. Resolves blob-externalized
    content server-side so clients never handle blob pointers.
  acceptance_criteria:
    - id: ac-single-event-fetch
      given: |
        A session event exists in events.jsonl
      when: |
        GET /api/sessions/:id/events/:seq is called
      then: |
        Returns the full SessionEvent for that sequence number with
        all blob pointers resolved to full content.
    - id: ac-blob-resolution
      given: |
        A tool call output exceeds the externalization threshold (16KB)
      when: |
        The detail endpoint returns the event
      then: |
        The blob file content is read and inlined in the response.
        The client receives full content, never blob pointers.
    - id: ac-not-found
      given: |
        A request references a non-existent session or sequence number
      when: |
        The endpoint processes the request
      then: |
        Returns 404 with a descriptive error message.
```

## Tasks

derive_from_specs: false

```yaml
- title: Implement daemon session event accumulator and new broadcast types
  slug: task-session-event-accumulator
  priority: 1
  spec_ref: "@session-event-broadcast"
  tags:
    - daemon
    - websocket
  description: |
    Replace the onTextChunk callback in the dispatch engine with
    onSessionEvent that emits typed lifecycle events.

    Core implementation:
    1. Create per-session accumulator in dispatch.ts that buffers
       agent_message_chunk text and flushes at newline boundaries.
    2. Detect state transitions (message → tool_call, message → thinking,
       etc.) and flush remaining buffer as _complete event.
    3. Broadcast new event types via PubSubManager:
       - message_start, message_progress, message_complete
       - thinking_start, thinking_progress, thinking_complete
       - tool_call_start (with tool name + input), tool_call_complete
    4. tool_call_start includes input parameters from the ACP tool_call
       SessionUpdate. tool_call_complete includes status and duration_ms
       but NOT output.
    5. Update agent-dispatch.ts broadcast calls to use new event types.
    6. Remove onTextChunk callback and agent_text_chunk event type.

    Consumers to update:
    - ws-invalidation.ts: new event types need invalidation rules
      (message_complete and tool_call_complete should invalidate
      session event queries for the affected session)
    - CLI watch command: update to consume new event stream, display
      text at newline boundaries and tool call status transitions
    - BroadcastEvent types in @kynetic-ai/shared

    The accumulator must handle concurrent sessions independently —
    use a Map<sessionId, AccumulatorState> with cleanup on session end.

    Buffer safety: include a maximum buffer size (e.g., 8KB) that
    triggers a flush even without a newline boundary, to prevent
    unbounded memory growth from newline-sparse content (minified
    JS, base64 strings, long single-line output).

    Acceptance gates:
    - @session-event-broadcast ac-newline-streaming
    - @session-event-broadcast ac-boundary-flush
    - @session-event-broadcast ac-per-session-state
    - @session-event-broadcast ac-tool-input-included
    - @session-event-broadcast ac-replaces-text-chunks

- title: Add session event detail HTTP endpoint with blob resolution
  slug: task-session-event-detail-endpoint
  priority: 1
  spec_ref: "@session-event-detail-endpoint"
  tags:
    - daemon
  description: |
    Add GET /api/sessions/:id/events/:seq endpoint to the daemon
    session routes.

    Implementation:
    1. Read events.jsonl for the session, find event by seq number.
    2. Resolve any blob pointers in the event data — read blob files
       from the session's blobs/ directory and inline the content.
    3. Return the full resolved SessionEvent as JSON.
    4. 404 if session or seq not found.
    5. Respect X-Kspec-Dir project scoping.

    The existing readEvents() in store.ts reads all events. For
    single-event fetch, consider a targeted read that stops at the
    matching seq to avoid reading the full file for large sessions.

    Acceptance gates:
    - @session-event-detail-endpoint ac-single-event-fetch
    - @session-event-detail-endpoint ac-blob-resolution
    - @session-event-detail-endpoint ac-not-found

- title: Update web UI session stream for WebSocket-first live viewing
  slug: task-session-stream-ws-ui
  priority: 2
  spec_ref: "@ws-session-event-streaming"
  tags:
    - web-ui
  depends_on:
    - "@task-session-event-accumulator"
    - "@task-session-event-detail-endpoint"
  description: |
    Rewrite the session detail page to consume the new WebSocket
    event stream for live sessions and use on-demand HTTP for
    tool output.

    Changes to sessions/[id]/+page.svelte:
    1. Remove the refreshEvents() HTTP polling and debounce timer.
    2. Remove streamingText accumulation from agent_text_chunk.
    3. Add WebSocket handlers for new event types:
       - message_start → add DisplayBlock with writing indicator
       - message_progress → append text to current message block
       - message_complete → finalize message block, remove indicator
       - thinking_start/progress/complete → same pattern, collapsed
       - tool_call_start → add ToolCallBlock with name + input, status running
       - tool_call_complete → update status, duration_ms
    4. On expand of tool call block, fetch output via
       GET /api/sessions/:id/events/:seq using TanStack Query
       (createQuery with enabled gated on expand state).
    5. Show error state with retry if detail fetch fails.

    Changes to session-utils.ts:
    - Add incrementalBlockUpdate() for applying WS events to block list
    - Keep parseEventsToBlocks() for historical playback (unchanged)
    - For historical playback, strip tool output from initial render
      and load on-demand same as live (consistent UX)

    Initial/catch-up load:
    - When navigating to a live session, fetch events via HTTP first
      (existing endpoint), then attach WS handlers for new events
      using lastSeq to avoid duplication.

    E2E tests should cover: live message streaming (newline-boundary
    updates visible), tool call expand/load, historical session playback,
    and WebSocket reconnection recovery.

    Acceptance gates:
    - @ws-session-event-streaming ac-message-start
    - @ws-session-event-streaming ac-message-progress
    - @ws-session-event-streaming ac-message-complete
    - @ws-session-event-streaming ac-tool-call-start
    - @ws-session-event-streaming ac-tool-call-complete
    - @ws-session-event-streaming ac-tool-output-on-demand
    - @ws-session-event-streaming ac-thinking-blocks
    - @ws-session-event-streaming ac-live-session-catchup
    - @ws-session-event-streaming ac-no-http-polling
    - @ws-session-event-streaming ac-reconnect-recovery

- title: Update CLI watch to use new WebSocket event stream
  slug: task-cli-watch-ws-events
  priority: 2
  spec_ref: "@ws-session-event-streaming"
  tags:
    - cli
  depends_on:
    - "@task-session-event-accumulator"
  description: |
    The kspec agent dispatch watch command currently consumes
    agent_text_chunk events to display live agent output. Update
    it to use the new typed event stream.

    Changes:
    1. Subscribe to the same new event types as the web UI.
    2. Display message text progressively (newline-boundary streaming
       maps naturally to terminal line output).
    3. Show tool call start (name + input summary) and completion
       (status + timing) as formatted terminal output.
    4. Thinking blocks can be shown dimmed or behind a --verbose flag.
    5. Remove consumption of agent_text_chunk events.

    Acceptance gates:
    - @ws-session-event-streaming ac-cli-watch-parity

- title: Update @ui-session-stream spec and clean up legacy streaming code
  slug: task-update-session-stream-spec-cleanup
  priority: 3
  spec_ref: "@ws-session-event-streaming"
  tags:
    - web-ui
    - docs
  depends_on:
    - "@task-session-stream-ws-ui"
    - "@task-cli-watch-ws-events"
  description: |
    After all consumers are migrated:

    1. Update @ui-session-stream ac-2 which currently reads:
       "Live text streams in real-time via agent_text_chunk WebSocket
       events, with periodic structured refresh from events.jsonl"
       Replace with reference to new WebSocket event streaming model.

    2. Remove dead code:
       - agent_text_chunk event type from shared types
       - onTextChunk callback from dispatch engine
       - streamingText state and accumulateStreamingText from session-utils
       - refreshEvents() polling logic from session detail page
       - Old WebSocket handler for agent_text_chunk in session detail

    3. Update ws-invalidation.ts:
       - Remove agent_text_chunk handler (returns [] currently)
       - Ensure new event types have correct invalidation rules

    4. Verify no remaining references to agent_text_chunk in codebase.

    Acceptance gates:
    - @session-event-broadcast ac-replaces-text-chunks
    - @ws-session-event-streaming ac-no-http-polling
```

## Implementation Notes

### Newline-Boundary Streaming

ACP streams `agent_message_chunk` per-token. Rather than forwarding each
token (too chatty) or buffering the entire message (poor UX for long
responses), the daemon accumulates text and flushes at newline boundaries:

- Each `agent_message_chunk` appends text to a per-session buffer
- When the buffer contains `\n`, everything up to the last `\n` is
  broadcast as `message_progress`; the remainder stays in the buffer
- On state transition (tool call, thinking, session end), the full
  buffer is flushed regardless of newline presence

This gives a natural line-by-line streaming feel — code blocks stream
line by line, prose streams paragraph by paragraph, and the churn from
per-token updates is eliminated.

A maximum buffer size (e.g., 8KB) forces a flush even without a newline,
preventing unbounded growth from newline-sparse content.

### Sequence Numbers

Sequence numbers (`seq`) in WebSocket events correspond to the
`events.jsonl` line sequence numbers, not WebSocket-level message
counters. This means `since_seq` on the HTTP endpoint and the last
seen `seq` from WebSocket events use the same numbering scheme,
enabling seamless catch-up after reconnection or initial load.

### Reconnection Edge Cases

If the session ended while disconnected, the HTTP catch-up fetch
returns all remaining events including `session.end`, and the UI
transitions to completed state. If the gap is very large, the HTTP
fetch handles it the same as historical playback — no special casing.

### Historical vs Live Consistency

HTTP `GET /api/sessions/:id/events` continues to return full events
including tool output for historical sessions. The on-demand pattern
for tool output applies to the UI rendering layer — historical playback
renders tool call blocks collapsed with output fetched on expand, same
as live. This keeps the UX consistent regardless of session state.

For live sessions already in progress, the UI fetches existing events
via HTTP first (full catch-up), then switches to WebSocket for
subsequent events. The lastSeq from the HTTP response gates which
WebSocket events to apply, preventing duplication.

### Key Integration Points

- **Dispatch engine** (`src/agent-runtime/dispatch.ts`): Replace `onTextChunk` with `onSessionEvent`. Per-session accumulator with newline-boundary flushing.
- **Daemon WS** (`packages/daemon/src/routes/agent-dispatch.ts`): Broadcast new typed events via PubSubManager.
- **Daemon routes** (`packages/daemon/src/routes/sessions.ts`): Add `GET /api/sessions/:id/events/:seq` with blob resolution.
- **Web UI session detail** (`packages/web-ui/src/routes/sessions/[id]/+page.svelte`): Consume new WS events, build blocks incrementally, on-demand tool output via TanStack Query.
- **CLI watch** (`src/agent-runtime/dispatch.ts` or daemon route): Same WS events, terminal-formatted output.
- **ws-invalidation.ts**: Update event type → query key mapping for new event types.
- **Shared types** (`@kynetic-ai/shared`): New BroadcastEvent types, deprecate agent_text_chunk.
