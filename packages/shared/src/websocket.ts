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
  action: 'subscribe' | 'unsubscribe' | 'ping';
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
  event: 'connected';
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

/**
 * Union of all possible WebSocket messages from server
 */
export type WebSocketMessage = ConnectedEvent | BroadcastEvent | CommandAck;
