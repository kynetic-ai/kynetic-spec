/**
 * Connection Store
 *
 * Global WebSocket connection state managed via Svelte runes.
 * Provides reactive connection status and message handling.
 *
 * AC Coverage:
 * - ac-28 (@web-dashboard): Automatic reconnect with exponential backoff
 * - ac-29 (@web-dashboard): Connection lost indicator
 * - ac-30 (@web-dashboard): Sequence deduplication
 * - ac-31 (@web-dashboard): Reset lastSeqProcessed on reconnect
 * - ac-32 (@web-dashboard): Re-subscribe on reconnect
 * - ac-33 (@web-dashboard): Trigger UI updates on events
 */

import { WebSocketManager } from '../websocket/manager.js';
import type { ConnectionState } from '../websocket/types.js';

// Global WebSocket manager instance
let manager: WebSocketManager | null = null;

// Reactive state
let connectionState = $state<ConnectionState>('disconnected');
let connectionLost = $state(false);

/**
 * Initialize WebSocket connection
 * AC: @web-dashboard ac-28
 */
export function initConnection(url?: string): void {
	if (manager) {
		console.warn('[ConnectionStore] Already initialized');
		return;
	}

	manager = new WebSocketManager(url);

	// AC: @web-dashboard ac-29 - Track connection state
	manager.onStateChange((state) => {
		connectionState = state;
		connectionLost = manager!.isConnectionLost();
	});

	manager.connect();
}

/**
 * Get connection state
 * AC: @web-dashboard ac-29
 */
export function getConnectionState(): ConnectionState {
	return connectionState;
}

/**
 * Check if connection is lost (>10s)
 * AC: @web-dashboard ac-29
 */
export function isConnectionLost(): boolean {
	return connectionLost;
}

/**
 * Check if connected
 */
export function isConnected(): boolean {
	return manager?.isConnected() ?? false;
}

/**
 * Subscribe to topics
 * AC: @web-dashboard ac-32
 */
export function subscribe(topics: string[]): void {
	if (!manager) {
		throw new Error('Connection not initialized');
	}
	manager.subscribe(topics);
}

/**
 * Unsubscribe from topics
 */
export function unsubscribe(topics: string[]): void {
	if (!manager) {
		throw new Error('Connection not initialized');
	}
	manager.unsubscribe(topics);
}

/**
 * Register event handler
 * AC: @web-dashboard ac-33
 */
export function on(topic: string, handler: (event: any) => void): void {
	if (!manager) {
		throw new Error('Connection not initialized');
	}
	manager.on(topic, handler);
}

/**
 * Unregister event handler
 */
export function off(topic: string, handler: (event: any) => void): void {
	if (!manager) {
		throw new Error('Connection not initialized');
	}
	manager.off(topic, handler);
}

/**
 * Disconnect
 */
export function disconnect(): void {
	if (manager) {
		manager.disconnect();
		manager = null;
	}
}

/**
 * Get connection statistics
 */
export function getConnectionStats() {
	return manager?.getStats();
}

/**
 * Get active subscriptions
 */
export function getSubscriptions(): string[] {
	return manager?.getSubscriptions() ?? [];
}
