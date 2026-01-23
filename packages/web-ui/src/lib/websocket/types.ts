/**
 * WebSocket Manager Types
 *
 * Internal types for WebSocketManager connection state and management.
 * AC: @web-dashboard ac-28, ac-29, ac-30, ac-31, ac-32, ac-33
 */

/**
 * WebSocket connection state
 * AC: @web-dashboard ac-28, ac-29
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Subscription topic
 * AC: @web-dashboard ac-32
 */
export interface Subscription {
	topic: string;
	subscribed_at: Date;
}

/**
 * Connection statistics
 * AC: @web-dashboard ac-28
 */
export interface ConnectionStats {
	connect_count: number;
	reconnect_count: number;
	last_connected_at: Date | null;
	last_disconnected_at: Date | null;
}

/**
 * Event handler callback
 * AC: @web-dashboard ac-33
 */
export type EventHandler = (event: any) => void;

/**
 * State change handler callback
 * AC: @web-dashboard ac-29
 */
export type StateChangeHandler = (state: ConnectionState) => void;
