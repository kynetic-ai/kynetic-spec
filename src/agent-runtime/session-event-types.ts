/**
 * Session Event Broadcast Types
 *
 * Type definitions for typed session lifecycle events broadcast over WebSocket.
 * These are the canonical definitions used by the event accumulator (producer).
 * The @kynetic-ai/shared package re-exports equivalent types for consumers
 * (daemon, web-ui).
 *
 * AC: @session-event-broadcast ac-newline-streaming, ac-boundary-flush,
 *     ac-per-session-state, ac-tool-input-included, ac-replaces-text-chunks
 */

/** Common fields shared by all session event broadcast payloads. */
export interface SessionEventBase {
  session_id: string;
  agent_id: string;
  task_id: string | null;
  task_title: string | null;
  timestamp: number;
}

/** Agent started composing a message. */
export interface MessageStartEventData extends SessionEventBase {
  type: "message_start";
}

/** Flushed text lines from agent message output (newline-boundary streaming). */
export interface MessageProgressEventData extends SessionEventBase {
  type: "message_progress";
  text: string;
}

/** Agent message completed (remaining buffer flushed on state transition). */
export interface MessageCompleteEventData extends SessionEventBase {
  type: "message_complete";
  text: string;
}

/** Agent started emitting thinking/reasoning content. */
export interface ThinkingStartEventData extends SessionEventBase {
  type: "thinking_start";
}

/** Flushed text lines from agent thinking output. */
export interface ThinkingProgressEventData extends SessionEventBase {
  type: "thinking_progress";
  text: string;
}

/** Agent thinking completed (remaining buffer flushed). */
export interface ThinkingCompleteEventData extends SessionEventBase {
  type: "thinking_complete";
  text: string;
}

/** Agent initiated a tool call. Includes tool name and input; output excluded. */
export interface ToolCallStartEventData extends SessionEventBase {
  type: "tool_call_start";
  tool_call_id: string;
  tool_name: string;
  tool_input: unknown;
}

/** Tool call input updated (phased streaming: populated input arrives after registration). */
export interface ToolCallInputEventData extends SessionEventBase {
  type: "tool_call_input";
  tool_call_id: string;
  tool_name: string;
  tool_input: unknown;
}

/** Tool call finished. Includes status and duration; output excluded. */
export interface ToolCallCompleteEventData extends SessionEventBase {
  type: "tool_call_complete";
  tool_call_id: string;
  tool_name: string;
  status: string;
  duration_ms: number;
}

/** Union of all typed session event payloads. */
export type SessionEventData =
  | MessageStartEventData
  | MessageProgressEventData
  | MessageCompleteEventData
  | ThinkingStartEventData
  | ThinkingProgressEventData
  | ThinkingCompleteEventData
  | ToolCallStartEventData
  | ToolCallInputEventData
  | ToolCallCompleteEventData;

/** All possible `event` field values for session events on the 'agents' topic. */
export type SessionEventType = SessionEventData["type"];
