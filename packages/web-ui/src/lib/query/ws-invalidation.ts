/**
 * WebSocket → Query Invalidation Wiring
 *
 * Maps WebSocket broadcast topics to TanStack Query key invalidations.
 * Centralized handler that replaces per-page WS reload patterns.
 *
 * AC: @ui-data-freshness ac-3 — WS events invalidate cached data
 * AC: @ui-data-freshness ac-4 — Event-driven, not polling
 */

import type { QueryClient } from '@tanstack/svelte-query';
import type { BroadcastEvent } from '@kynetic-ai/shared';
import { queryKeys } from './keys.js';
import { on, off, subscribe, unsubscribe } from '$lib/stores/connection.svelte';

/**
 * Topics we subscribe to for cache invalidation.
 * Must match the exact topic strings the daemon broadcasts on.
 */
const INVALIDATION_TOPICS = [
	'tasks:updates',
	'items:updates',
	'inbox:updates',
	'triage:updates',
	'agents',
	'files:updates',
] as const;

/**
 * Map a broadcast event to the query keys that should be invalidated.
 *
 * Returns an array of query key prefixes to invalidate.
 * Returning an empty array means no invalidation needed (e.g., text chunks).
 */
function getInvalidationKeys(topic: string, event: BroadcastEvent): readonly (readonly unknown[])[] {
	switch (topic) {
		case 'tasks:updates':
			// Task status changes affect task lists, summaries, sidebar counts,
			// and session context (which includes current focus/active work)
			return [queryKeys.tasks.all, queryKeys.validation.all, queryKeys.sessionContext.all];

		case 'items:updates':
			// Spec item changes affect item lists and validation
			return [queryKeys.items.all, queryKeys.validation.all];

		case 'inbox:updates':
			// Inbox changes affect inbox list, count, and merged inbox (triage status)
			return [queryKeys.inbox.all];

		case 'triage:updates':
			// Triage changes affect the merged inbox view (triage status inline)
			return [queryKeys.inbox.all];

		case 'agents':
			// Agent text chunks are handled separately (streaming buffer).
			// Only lifecycle events (started, completed, etc.) need invalidation.
			if (event.event === 'agent_text_chunk') {
				return [];
			}
			return [queryKeys.agents.all];

		case 'files:updates':
			// File changes (e.g., settings save, meta edits) affect multiple caches
			// Observations and session context live in meta files
			return [
				queryKeys.settings.all,
				queryKeys.workflows.all,
				queryKeys.validation.all,
				queryKeys.observations.all,
				queryKeys.sessionContext.all,
			];

		default:
			return [];
	}
}

let queryClientRef: QueryClient | null = null;
let handlersRegistered = false;

function handleBroadcastEvent(topic: string) {
	return (event: BroadcastEvent) => {
		if (!queryClientRef) return;

		const keys = getInvalidationKeys(topic, event);
		for (const key of keys) {
			queryClientRef.invalidateQueries({ queryKey: key as unknown[] });
		}
	};
}

// Store handler references for cleanup
const topicHandlers = new Map<string, (event: BroadcastEvent) => void>();

/**
 * Wire up WebSocket events to TanStack Query invalidation.
 * Call this once after the QueryClient and WebSocket connection are initialized.
 *
 * AC: @ui-data-freshness ac-3 — Broadcast events → query invalidation
 */
export function setupWsInvalidation(queryClient: QueryClient): void {
	if (handlersRegistered) return;

	queryClientRef = queryClient;

	// Subscribe to all relevant topics
	subscribe([...INVALIDATION_TOPICS]);

	// Register handlers for each topic
	for (const topic of INVALIDATION_TOPICS) {
		const handler = handleBroadcastEvent(topic);
		topicHandlers.set(topic, handler);
		on(topic, handler);
	}

	handlersRegistered = true;
}

/**
 * Tear down WebSocket invalidation wiring.
 * Called on app teardown or when reinitializing.
 */
export function teardownWsInvalidation(): void {
	if (!handlersRegistered) return;

	for (const [topic, handler] of topicHandlers) {
		off(topic, handler);
	}
	topicHandlers.clear();

	unsubscribe([...INVALIDATION_TOPICS]);

	queryClientRef = null;
	handlersRegistered = false;
}
