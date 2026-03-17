/**
 * Session Event Accumulator
 *
 * Buffers text from ACP SessionUpdate events and flushes at newline boundaries,
 * emitting typed session lifecycle events. Tracks state per session to support
 * concurrent sessions independently.
 *
 * AC: @session-event-broadcast ac-newline-streaming — flush at newline boundaries
 * AC: @session-event-broadcast ac-boundary-flush — flush on state transitions
 * AC: @session-event-broadcast ac-per-session-state — per-session accumulator state
 * AC: @session-event-broadcast ac-tool-input-included — tool_call_start includes input
 * AC: @session-event-broadcast ac-replaces-text-chunks — replaces agent_text_chunk
 */

import type { SessionUpdate } from "../acp/index.js";
import type { SessionEventData } from "./session-event-types.js";

/** Maximum buffer size before forced flush (prevents unbounded memory growth). */
const MAX_BUFFER_SIZE = 8 * 1024; // 8KB

/** The content mode the accumulator is currently tracking for a session. */
type ContentMode = "message" | "thinking" | "idle";

/** Per-session accumulator state. */
export interface AccumulatorState {
  buffer: string;
  mode: ContentMode;
  /** Tracks active tool calls for duration_ms calculation. */
  activeToolCalls: Map<string, { toolName: string; startTime: number }>;
}

/** Context for event emission (session identity + agent metadata). */
export interface SessionContext {
  sessionId: string;
  agentId: string;
  taskId: string | null;
  taskTitle: string | null;
}

/** Callback invoked when the accumulator produces a typed session event. */
export type SessionEventEmitter = (event: SessionEventData) => void;

/**
 * Manages per-session text accumulation and lifecycle event emission.
 *
 * AC: @session-event-broadcast ac-per-session-state
 */
export class SessionEventAccumulator {
  private sessions: Map<string, AccumulatorState> = new Map();

  /**
   * Get or create accumulator state for a session.
   */
  private getState(sessionId: string): AccumulatorState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { buffer: "", mode: "idle", activeToolCalls: new Map() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Build the common base fields for session events.
   */
  private baseFields(ctx: SessionContext): Omit<SessionEventData, "type" | "text" | "tool_call_id" | "tool_name" | "tool_input" | "status" | "duration_ms"> {
    return {
      session_id: ctx.sessionId,
      agent_id: ctx.agentId,
      task_id: ctx.taskId,
      task_title: ctx.taskTitle,
      timestamp: Date.now(),
    };
  }

  /**
   * Flush buffered text as a progress event (newline-boundary streaming).
   * Emits complete lines up to the last newline, keeps the partial remainder.
   * Forces a full flush when the buffer exceeds MAX_BUFFER_SIZE.
   *
   * AC: @session-event-broadcast ac-newline-streaming
   */
  private flushBuffer(
    state: AccumulatorState,
    ctx: SessionContext,
    emit: SessionEventEmitter,
  ): void {
    if (state.buffer.length === 0) return;

    // Newline-boundary flush: emit complete lines, keep partial remainder
    const lastNewline = state.buffer.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No newline yet — check max buffer size
      if (state.buffer.length >= MAX_BUFFER_SIZE) {
        const text = state.buffer;
        state.buffer = "";
        const progressType = state.mode === "thinking" ? "thinking_progress" : "message_progress";
        emit({ ...this.baseFields(ctx), type: progressType, text } as SessionEventData);
      }
      return;
    }

    // Emit everything up to and including the last newline
    const text = state.buffer.slice(0, lastNewline + 1);
    state.buffer = state.buffer.slice(lastNewline + 1);
    const progressType = state.mode === "thinking" ? "thinking_progress" : "message_progress";
    emit({ ...this.baseFields(ctx), type: progressType, text } as SessionEventData);

    // Check if remainder exceeds max buffer
    if (state.buffer.length >= MAX_BUFFER_SIZE) {
      const overflow = state.buffer;
      state.buffer = "";
      emit({ ...this.baseFields(ctx), type: progressType, text: overflow } as SessionEventData);
    }
  }

  /**
   * Transition to a new content mode, flushing the buffer as a _complete event.
   *
   * AC: @session-event-broadcast ac-boundary-flush
   */
  private transitionMode(
    state: AccumulatorState,
    ctx: SessionContext,
    emit: SessionEventEmitter,
    newMode: ContentMode,
  ): void {
    if (state.mode !== "idle" && state.mode !== newMode) {
      // Flush remaining buffer as _complete event
      const text = state.buffer;
      state.buffer = "";
      const completeType = state.mode === "thinking" ? "thinking_complete" : "message_complete";
      emit({ ...this.baseFields(ctx), type: completeType, text } as SessionEventData);
    }

    if (state.mode !== newMode && newMode !== "idle") {
      // Emit _start event for the new mode
      const startType = newMode === "thinking" ? "thinking_start" : "message_start";
      emit({ ...this.baseFields(ctx), type: startType } as SessionEventData);
    }

    state.mode = newMode;
  }

  /**
   * Process a SessionUpdate from ACP, emitting typed session events.
   *
   * This is the main entry point — replaces the old onTextChunk callback.
   */
  handleUpdate(
    ctx: SessionContext,
    update: SessionUpdate,
    emit: SessionEventEmitter,
  ): void {
    const state = this.getState(ctx.sessionId);

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") break;

        // Transition to message mode if needed
        if (state.mode !== "message") {
          this.transitionMode(state, ctx, emit, "message");
        }

        // Accumulate text and flush at newline boundaries
        state.buffer += (update.content as { type: "text"; text: string }).text;
        this.flushBuffer(state, ctx, emit);
        break;
      }

      case "agent_thought_chunk": {
        if (update.content.type !== "text") break;

        // Transition to thinking mode if needed
        if (state.mode !== "thinking") {
          this.transitionMode(state, ctx, emit, "thinking");
        }

        // Accumulate and flush at newline boundaries
        state.buffer += (update.content as { type: "text"; text: string }).text;
        this.flushBuffer(state, ctx, emit);
        break;
      }

      case "tool_call": {
        // State transition: flush any buffered text
        this.transitionMode(state, ctx, emit, "idle");

        // AC: @session-event-broadcast ac-tool-input-included
        const toolCallId = update.toolCallId;
        const toolName = update.title;
        const toolInput = update.rawInput ?? null;

        // Track for duration calculation
        state.activeToolCalls.set(toolCallId, {
          toolName,
          startTime: Date.now(),
        });

        emit({
          ...this.baseFields(ctx),
          type: "tool_call_start",
          tool_call_id: toolCallId,
          tool_name: toolName,
          tool_input: toolInput,
        } as SessionEventData);
        break;
      }

      case "tool_call_update": {
        const tcId = update.toolCallId;
        const tracked = state.activeToolCalls.get(tcId);

        // Emit tool_call_input when populated rawInput arrives (phased streaming)
        // AC: @ws-session-event-streaming ac-tool-input-update
        if (
          update.rawInput != null &&
          typeof update.rawInput === "object" &&
          Object.keys(update.rawInput as Record<string, unknown>).length > 0 &&
          !(update.status === "completed" || update.status === "failed")
        ) {
          const toolName = tracked?.toolName ?? update.title ?? "";
          emit({
            ...this.baseFields(ctx),
            type: "tool_call_input",
            tool_call_id: tcId,
            tool_name: toolName,
            tool_input: update.rawInput,
          } as SessionEventData);
        }

        // Emit complete when status transitions to completed/failed
        if (update.status && (update.status === "completed" || update.status === "failed")) {
          const durationMs = tracked ? Date.now() - tracked.startTime : 0;
          const toolName = tracked?.toolName ?? "";
          state.activeToolCalls.delete(tcId);

          emit({
            ...this.baseFields(ctx),
            type: "tool_call_complete",
            tool_call_id: tcId,
            tool_name: toolName,
            status: update.status,
            duration_ms: durationMs,
          } as SessionEventData);
        }
        break;
      }

      // Other update types (plan, usage_update, etc.) don't produce session events
      default:
        break;
    }
  }

  /**
   * Flush and clean up state for a session (on session end).
   * Emits any remaining buffered text as a _complete event.
   */
  endSession(ctx: SessionContext, emit: SessionEventEmitter): void {
    const state = this.sessions.get(ctx.sessionId);
    if (!state) return;

    // Flush any remaining content
    if (state.mode !== "idle") {
      const text = state.buffer;
      state.buffer = "";
      const completeType = state.mode === "thinking" ? "thinking_complete" : "message_complete";
      emit({ ...this.baseFields(ctx), type: completeType, text } as SessionEventData);
    }

    this.sessions.delete(ctx.sessionId);
  }

  /** Check if a session is currently being tracked. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Get the number of tracked sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
