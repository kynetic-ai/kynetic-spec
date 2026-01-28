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
 * - ac-27 (@multi-directory-daemon): Reconnect with different project
 */

import { WebSocketManager, type WebSocketManagerOptions } from '../websocket/manager.js';
import type { ConnectionState } from '../websocket/types.js';

// Global WebSocket manager instance
let manager: WebSocketManager | null = null;

// Reactive state
let connectionState = $state<ConnectionState>('disconnected');
let connectionLost = $state(false);

/**
 * Initialize WebSocket connection
 * AC: @web-dashboard ac-28
 * AC: @multi-directory-daemon ac-34 - Supports project path option
 */
export function initConnection(options?: WebSocketManagerOptions | string): void {
	if (manager) {
		console.warn('[ConnectionStore] Already initialized');
		return;
	}

	manager = new WebSocketManager(options);

	// AC: @web-dashboard ac-29 - Track connection state
	manager.onStateChange((state) => {
		connectionState = state;
		connectionLost = manager!.isConnectionLost();
	});

	manager.connect();
}

/**
 * Reconnect with a different project
 * AC: @multi-directory-daemon ac-27
 */
export function reconnectWithProject(projectPath: string | null): void {
	if (!manager) {
		console.warn('[ConnectionStore] Not initialized, cannot reconnect with project');
		return;
	}

	manager.setProjectPath(projectPath);
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
		// No-op during SSR or before initialization
		return;
	}
	manager.subscribe(topics);
}

/**
 * Unsubscribe from topics
 */
export function unsubscribe(topics: string[]): void {
	if (!manager) {
		// No-op during SSR or before initialization
		return;
	}
	manager.unsubscribe(topics);
}

/**
 * Register event handler
 * AC: @web-dashboard ac-33
 */
export function on(topic: string, handler: (event: any) => void): void {
	if (!manager) {
		// No-op during SSR or before initialization
		return;
	}
	manager.on(topic, handler);
}

/**
 * Unregister event handler
 */
export function off(topic: string, handler: (event: any) => void): void {
	if (!manager) {
		// No-op during SSR or before initialization
		return;
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
