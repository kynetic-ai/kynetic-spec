/**
 * WebSocket Protocol Types
 *
 * Shared types for WebSocket communication between daemon and web-ui.
 * These types define the contract for real-time communication.
 *
 * AC Coverage:
 * - ac-25 (@api-contract): Connected event with session_id
 * - ac-26 (@api-contract): Command format
 * - ac-27 (@api-contract): Ack response format
 * - ac-28 (@api-contract): Subscribe to topics
 * - ac-29 (@api-contract): Event format with seq
 */

/**
 * Command sent from client to server
 * AC: @api-contract ac-26
 */
export interface WebSocketCommand {
  action: "subscribe" | "unsubscribe" | "ping";
  request_id?: string;
  payload?: {
    topics?: string[];
  };
}

/**
 * Acknowledgment response from server to client
 * AC: @api-contract ac-27
 */
export interface CommandAck {
  ack: boolean;
  request_id?: string;
  success: boolean;
  error?: string;
  details?: any;
}

/**
 * Initial connection event sent to client
 * AC: @api-contract ac-25
 */
export interface ConnectedEvent {
  event: "connected";
  data: {
    session_id: string;
  };
}

/**
 * Broadcast event sent from server to subscribed clients
 * AC: @api-contract ac-29
 */
export interface BroadcastEvent {
  msg_id: string;
  seq: number;
  timestamp: string;
  topic: string;
  event: string;
  data: any;
}

// ─── Enriched Event Data Payloads ─────────────────────────────────────────────
// AC: @ui-api-aggregation ac-4

/**
 * Data payload for task_updated broadcast events.
 * Includes display title and both old/new status for in-place UI updates.
 */
export interface TaskUpdatedEventData {
  ref: string;
  ulid: string;
  action: string;
  title: string;
  old_status: string | null;
  new_status: string | null;
  note_ulid?: string;
}

/**
 * Data payload for inbox_item_created broadcast events.
 * Includes full item data so consumers can render without re-fetching.
 */
export interface InboxItemCreatedEventData {
  ulid: string;
  text: string;
  tags?: string[];
  added_by?: string;
  created_at: string;
}

/**
 * Data payload for agent_invocation broadcast events.
 * Includes task_title for display alongside task_id.
 *
 * AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
 */
export interface AgentInvocationEventData {
  session_id: string;
  agent_id: string;
  task_id: string | null;
  task_title: string | null;
  status: string;
  timestamp: number;
  /** Resolved adapter identity for this invocation, when known. */
  resolved_adapter?: string;
  /** Named runner that resolved this invocation, when one was configured. */
  runner?: string;
}

// ─── Session Event Broadcast Types ──────────────────────────────────────────
// AC: @session-event-broadcast ac-newline-streaming, ac-boundary-flush,
//     ac-per-session-state, ac-tool-input-included, ac-replaces-text-chunks

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

// ─── Review Event Data Payloads ──────────────────────────────────────────────
// AC: @review-records-daemon-api ac-9

/** Data payload for thread_created broadcast events on reviews:updates topic. */
export interface ReviewThreadCreatedEventData {
  review_ulid: string;
  thread_ulid: string;
  kind: string;
  author: string;
}

/** Data payload for thread_replied broadcast events on reviews:updates topic. */
export interface ReviewThreadRepliedEventData {
  review_ulid: string;
  thread_ulid: string;
  entry_ulid: string;
  author: string;
}

/** Data payload for thread_resolved broadcast events on reviews:updates topic. */
export interface ReviewThreadResolvedEventData {
  review_ulid: string;
  thread_ulid: string;
  actor: string;
}

/** Data payload for thread_reopened broadcast events on reviews:updates topic. */
export interface ReviewThreadReopenedEventData {
  review_ulid: string;
  thread_ulid: string;
  actor: string;
}

/** Data payload for verdict_submitted broadcast events on reviews:updates topic. */
export interface ReviewVerdictSubmittedEventData {
  review_ulid: string;
  decision: string;
  reviewer: string;
  lifecycle_state: string;
  disposition: string;
}

/** Data payload for check_added broadcast events on reviews:updates topic. */
export interface ReviewCheckAddedEventData {
  review_ulid: string;
  check_name: string;
  check_status: string;
  gate_state: string;
}

/** Data payload for lifecycle_changed broadcast events on reviews:updates topic. */
export interface ReviewLifecycleChangedEventData {
  review_ulid: string;
  from: string;
  to: string;
  actor: string;
}

/** Union of all review event payloads for the reviews:updates topic. */
export type ReviewEventData =
  | ReviewThreadCreatedEventData
  | ReviewThreadRepliedEventData
  | ReviewThreadResolvedEventData
  | ReviewThreadReopenedEventData
  | ReviewVerdictSubmittedEventData
  | ReviewCheckAddedEventData
  | ReviewLifecycleChangedEventData;

/**
 * Union of all possible WebSocket messages from server
 */
export type WebSocketMessage = ConnectedEvent | BroadcastEvent | CommandAck;
