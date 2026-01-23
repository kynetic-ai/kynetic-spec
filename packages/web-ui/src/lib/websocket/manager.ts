/**
 * WebSocketManager
 *
 * Manages WebSocket connection lifecycle with exponential backoff reconnection,
 * sequence deduplication, and automatic topic re-subscription.
 *
 * AC Coverage:
 * - ac-28 (@web-dashboard): Exponential backoff reconnect (1s, 2s, 4s... max 30s)
 * - ac-29 (@web-dashboard): Connection lost indicator after 10s
 * - ac-30 (@web-dashboard): Sequence deduplication (skip seq <= lastSeqProcessed)
 * - ac-31 (@web-dashboard): Reset lastSeqProcessed = -1 on reconnect
 * - ac-32 (@web-dashboard): Re-subscribe to all topics on reconnect
 * - ac-33 (@web-dashboard): Trigger update handlers on broadcast events
 */

import type {
	WebSocketCommand,
	WebSocketMessage,
	BroadcastEvent,
	ConnectedEvent,
	CommandAck
} from '@kynetic-ai/shared';
import type {
	ConnectionState,
	Subscription,
	ConnectionStats,
	EventHandler,
	StateChangeHandler
} from './types.js';

const DEFAULT_URL = 'ws://localhost:3456/ws';
const MAX_BACKOFF_MS = 30000; // 30s
const CONNECTION_LOST_THRESHOLD_MS = 10000; // 10s
const MAX_RECONNECT_ATTEMPTS = 10;

export class WebSocketManager {
	private ws: WebSocket | null = null;
	private url: string;
	private state: ConnectionState = 'disconnected';
	private subscriptions = new Map<string, Subscription>();
	private eventHandlers = new Map<string, Set<EventHandler>>();
	private stateChangeHandlers = new Set<StateChangeHandler>();

	// AC: @web-dashboard ac-30, ac-31
	private lastSeqProcessed = -1;

	// AC: @web-dashboard ac-28
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	// AC: @web-dashboard ac-29
	private connectionLostTimer: ReturnType<typeof setTimeout> | null = null;

	private stats: ConnectionStats = {
		connect_count: 0,
		reconnect_count: 0,
		last_connected_at: null,
		last_disconnected_at: null
	};

	constructor(url: string = DEFAULT_URL) {
		this.url = url;
	}

	/**
	 * Get current connection state
	 * AC: @web-dashboard ac-29
	 */
	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Check if connection is established
	 * AC: @web-dashboard ac-29
	 */
	isConnected(): boolean {
		return this.state === 'connected';
	}

	/**
	 * Check if connection has been lost for > threshold
	 * AC: @web-dashboard ac-29
	 */
	isConnectionLost(): boolean {
		if (this.state === 'connected') return false;
		if (!this.stats.last_disconnected_at) return false;

		const timeSinceDisconnect = Date.now() - this.stats.last_disconnected_at.getTime();
		return timeSinceDisconnect > CONNECTION_LOST_THRESHOLD_MS;
	}

	/**
	 * Connect to WebSocket server
	 * AC: @web-dashboard ac-28
	 */
	connect(): void {
		if (this.ws && (this.state === 'connected' || this.state === 'connecting')) {
			console.warn('[WebSocketManager] Already connected or connecting');
			return;
		}

		this.setState('connecting');
		this.ws = new WebSocket(this.url);

		this.ws.onopen = () => {
			console.log('[WebSocketManager] Connected');
			this.setState('connected');
			this.reconnectAttempts = 0;
			this.stats.connect_count++;
			this.stats.last_connected_at = new Date();
			this.clearConnectionLostTimer();
		};

		this.ws.onmessage = (event) => {
			try {
				const message: WebSocketMessage = JSON.parse(event.data);
				this.handleMessage(message);
			} catch (err) {
				console.error('[WebSocketManager] Failed to parse message:', err);
			}
		};

		this.ws.onerror = (error) => {
			console.error('[WebSocketManager] WebSocket error:', error);
		};

		this.ws.onclose = (event) => {
			console.log('[WebSocketManager] Disconnected:', event.code, event.reason);
			this.setState('disconnected');
			this.stats.last_disconnected_at = new Date();
			this.ws = null;

			// AC: @web-dashboard ac-28, ac-29
			this.startConnectionLostTimer();
			this.scheduleReconnect();
		};
	}

	/**
	 * Disconnect from WebSocket server
	 */
	disconnect(): void {
		this.clearReconnectTimer();
		this.clearConnectionLostTimer();

		if (this.ws) {
			this.ws.close(1000, 'Client disconnect');
			this.ws = null;
		}

		this.setState('disconnected');
	}

	/**
	 * Subscribe to topics
	 * AC: @web-dashboard ac-32
	 */
	subscribe(topics: string[]): void {
		// Track subscriptions
		for (const topic of topics) {
			if (!this.subscriptions.has(topic)) {
				this.subscriptions.set(topic, {
					topic,
					subscribed_at: new Date()
				});
			}
		}

		// Send subscribe command if connected
		if (this.isConnected()) {
			this.sendCommand({
				action: 'subscribe',
				request_id: crypto.randomUUID(),
				payload: { topics }
			});
		}
	}

	/**
	 * Unsubscribe from topics
	 */
	unsubscribe(topics: string[]): void {
		for (const topic of topics) {
			this.subscriptions.delete(topic);
		}

		if (this.isConnected()) {
			this.sendCommand({
				action: 'unsubscribe',
				request_id: crypto.randomUUID(),
				payload: { topics }
			});
		}
	}

	/**
	 * Register event handler for topic
	 * AC: @web-dashboard ac-33
	 */
	on(topic: string, handler: EventHandler): void {
		if (!this.eventHandlers.has(topic)) {
			this.eventHandlers.set(topic, new Set());
		}
		this.eventHandlers.get(topic)!.add(handler);
	}

	/**
	 * Unregister event handler
	 */
	off(topic: string, handler: EventHandler): void {
		const handlers = this.eventHandlers.get(topic);
		if (handlers) {
			handlers.delete(handler);
			if (handlers.size === 0) {
				this.eventHandlers.delete(topic);
			}
		}
	}

	/**
	 * Register state change handler
	 * AC: @web-dashboard ac-29
	 */
	onStateChange(handler: StateChangeHandler): void {
		this.stateChangeHandlers.add(handler);
	}

	/**
	 * Unregister state change handler
	 */
	offStateChange(handler: StateChangeHandler): void {
		this.stateChangeHandlers.delete(handler);
	}

	/**
	 * Handle incoming WebSocket message
	 * AC: @web-dashboard ac-30, ac-31, ac-32, ac-33
	 */
	private handleMessage(message: WebSocketMessage): void {
		// Handle ConnectedEvent
		if ('event' in message && message.event === 'connected') {
			const connectedEvent = message as ConnectedEvent;
			console.log('[WebSocketManager] Session ID:', connectedEvent.data.session_id);

			// AC: @web-dashboard ac-31 - Reset sequence on new connection
			this.lastSeqProcessed = -1;

			// AC: @web-dashboard ac-32 - Re-subscribe to all topics
			if (this.subscriptions.size > 0) {
				const topics = Array.from(this.subscriptions.keys());
				this.sendCommand({
					action: 'subscribe',
					request_id: crypto.randomUUID(),
					payload: { topics }
				});
			}
			return;
		}

		// Handle CommandAck
		if ('ack' in message) {
			const ack = message as CommandAck;
			if (!ack.success) {
				console.error('[WebSocketManager] Command failed:', ack.error);
			}
			return;
		}

		// Handle BroadcastEvent
		if ('msg_id' in message && 'seq' in message) {
			const event = message as BroadcastEvent;

			// AC: @web-dashboard ac-30 - Sequence deduplication
			if (event.seq <= this.lastSeqProcessed) {
				console.debug('[WebSocketManager] Skipping duplicate event:', event.seq);
				return;
			}

			this.lastSeqProcessed = event.seq;

			// AC: @web-dashboard ac-33 - Trigger event handlers
			const handlers = this.eventHandlers.get(event.topic);
			if (handlers) {
				for (const handler of handlers) {
					try {
						handler(event);
					} catch (err) {
						console.error('[WebSocketManager] Event handler error:', err);
					}
				}
			}
		}
	}

	/**
	 * Send command to server
	 */
	private sendCommand(command: WebSocketCommand): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			console.warn('[WebSocketManager] Cannot send command: not connected');
			return;
		}

		try {
			this.ws.send(JSON.stringify(command));
		} catch (err) {
			console.error('[WebSocketManager] Failed to send command:', err);
		}
	}

	/**
	 * Schedule reconnect with exponential backoff
	 * AC: @web-dashboard ac-28
	 */
	private scheduleReconnect(): void {
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			console.error('[WebSocketManager] Max reconnect attempts reached');
			return;
		}

		this.clearReconnectTimer();

		// Increment attempt counter before calculating backoff
		this.reconnectAttempts++;
		this.stats.reconnect_count++;

		// Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
		const backoffMs = Math.min(
			Math.pow(2, this.reconnectAttempts - 1) * 1000,
			MAX_BACKOFF_MS
		);

		console.log(
			`[WebSocketManager] Reconnecting in ${backoffMs}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
		);

		this.reconnectTimer = setTimeout(() => {
			this.setState('reconnecting');
			this.connect();
		}, backoffMs);
	}

	/**
	 * Clear reconnect timer
	 */
	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/**
	 * Start connection lost timer
	 * AC: @web-dashboard ac-29
	 */
	private startConnectionLostTimer(): void {
		this.clearConnectionLostTimer();

		this.connectionLostTimer = setTimeout(() => {
			// Notify UI that connection has been lost for >10s
			// This triggers even if state hasn't changed (e.g., still 'disconnected')
			this.notifyConnectionLostChange();
		}, CONNECTION_LOST_THRESHOLD_MS);
	}

	/**
	 * Clear connection lost timer
	 */
	private clearConnectionLostTimer(): void {
		if (this.connectionLostTimer) {
			clearTimeout(this.connectionLostTimer);
			this.connectionLostTimer = null;
		}
	}

	/**
	 * Update state and notify listeners
	 */
	private setState(state: ConnectionState): void {
		if (this.state === state) return;
		this.state = state;
		this.notifyStateChange();
	}

	/**
	 * Notify state change handlers
	 */
	private notifyStateChange(): void {
		for (const handler of this.stateChangeHandlers) {
			try {
				handler(this.state);
			} catch (err) {
				console.error('[WebSocketManager] State change handler error:', err);
			}
		}
	}

	/**
	 * Notify state change handlers when connectionLost threshold is crossed
	 * This ensures the UI updates even if the state hasn't changed
	 */
	private notifyConnectionLostChange(): void {
		this.notifyStateChange();
	}

	/**
	 * Get connection statistics
	 */
	getStats(): Readonly<ConnectionStats> {
		return { ...this.stats };
	}

	/**
	 * Get active subscriptions
	 */
	getSubscriptions(): string[] {
		return Array.from(this.subscriptions.keys());
	}
}
