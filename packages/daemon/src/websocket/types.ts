/**
 * WebSocket Protocol Types
 *
 * AC coverage:
 * - ac-25 (@api-contract): Connected event with session_id
 * - ac-26 (@api-contract): Command format
 * - ac-27 (@api-contract): Ack response format
 * - ac-28 (@api-contract): Subscribe to topics
 * - ac-29 (@api-contract): Event format with seq
 * - ac-1 (@trait-websocket-protocol): Connection ID and connected event
 * - ac-2 (@trait-websocket-protocol): Subscribe command tracking
 * - ac-3 (@trait-websocket-protocol): Broadcast event format
 */

// AC: @api-contract ac-26
export interface WebSocketCommand {
  action: "subscribe" | "unsubscribe" | "ping";
  request_id?: string;
  payload?: {
    topics?: string[];
  };
}

// AC: @api-contract ac-27
export interface CommandAck {
  ack: boolean;
  request_id?: string;
  success: boolean;
  error?: string;
  details?: string;
}

// AC: @api-contract ac-25, @trait-websocket-protocol ac-1
export interface ConnectedEvent {
  event: "connected";
  data: {
    session_id: string;
  };
}

// AC: @api-contract ac-29, @trait-websocket-protocol ac-3
export interface BroadcastEvent {
  msg_id: string;
  seq: number;
  timestamp: string;
  topic: string;
  event: string;
  data: Record<string, unknown>;
}

// Internal connection metadata
export interface ConnectionData {
  sessionId: string;
  topics: Set<string>;
  lastPing?: number;
  lastPong?: number;
  seq: number; // Per-connection sequence number
  projectPath: string; // AC: @multi-directory-daemon ac-21 - bound project path
}

export interface WebSocketConnection {
  id?: string;
  data?: unknown;
  subscriptions?: string[];
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  ping?(): unknown;
  subscribe?(topic: string): unknown;
  unsubscribe?(topic: string): unknown;
  getBufferedAmount?(): number;
}

export interface WebSocketContext {
  ws: WebSocketConnection;
  connections: Map<string, WebSocketConnection>;
}
