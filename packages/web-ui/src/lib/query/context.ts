/**
 * Query Context
 *
 * Manages the QueryClient lifecycle: creation, project switch clearing,
 * and access for components that need to manually interact with the cache.
 *
 * AC: @ui-data-freshness ac-5 — Project switch clears all cached data
 */

import type { QueryClient } from '@tanstack/svelte-query';

let queryClientInstance: QueryClient | null = null;

/**
 * Store a reference to the QueryClient for use outside components.
 * Called once during app initialization in the root layout.
 */
export function setQueryClient(client: QueryClient): void {
	queryClientInstance = client;
}

/**
 * Get the global QueryClient instance.
 * Use inside non-component code (e.g., WS handlers, mutation callbacks).
 *
 * Prefer using `useQueryClient()` from @tanstack/svelte-query inside components.
 */
export function getQueryClient(): QueryClient | null {
	return queryClientInstance;
}

/**
 * Clear all query cache. Called on project switch.
 *
 * AC: @ui-data-freshness ac-5 — Discard all cached data on project change
 */
export function clearQueryCache(): void {
	if (queryClientInstance) {
		queryClientInstance.clear();
	}
}
