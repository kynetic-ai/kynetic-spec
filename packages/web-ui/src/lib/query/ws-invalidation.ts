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
	'reviews:updates',
	'agents',
	'sessions',
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

		case 'reviews:updates':
			// Review changes affect review lists and task detail (review_ref display)
			return [queryKeys.reviews.all, queryKeys.tasks.all];

		case 'agents': {
			// Streaming progress events don't need cache invalidation —
			// they're consumed directly by components for real-time display.
			const streamingEvents = new Set([
				'message_start', 'message_progress',
				'thinking_start', 'thinking_progress',
				'tool_call_start',
			]);
			if (streamingEvents.has(event.event)) {
				return [];
			}
			// Completion events (message_complete, thinking_complete, tool_call_complete)
			// and invocation lifecycle events invalidate session event caches.
			if (event.event === 'message_complete' || event.event === 'thinking_complete' || event.event === 'tool_call_complete') {
				const sessionId = (event.data as { session_id?: string })?.session_id;
				if (sessionId) {
					return [queryKeys.sessions.all, queryKeys.agents.all];
				}
			}
			// Agent lifecycle events (agent_invocation) also affect session lists
			return [queryKeys.agents.all, queryKeys.sessions.all];
		}

		case 'sessions':
			return [queryKeys.sessions.all];

		case 'files:updates':
			// File changes (e.g., settings save, meta edits) affect multiple caches
			// Observations and session context live in meta files
			// Automation config (hooks, schedules, compositions) lives in meta files
			return [
				queryKeys.settings.all,
				queryKeys.workflows.all,
				queryKeys.observations.all,
				queryKeys.validation.all,
				queryKeys.automation.all,
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
