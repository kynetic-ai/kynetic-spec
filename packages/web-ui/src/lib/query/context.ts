/**
 * Query Context
 *
 * Manages the QueryClient lifecycle: creation, project switch clearing,
 * and access for components that need to manually interact with the cache.
 *
 * AC: @ui-data-freshness ac-5 — Project switch clears all cached data
 */

import type { QueryClient } from "@tanstack/svelte-query";

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
 * Reset all queries and refetch active ones. Called on project switch.
 *
 * Uses resetQueries() instead of clear() because clear() destroys queries
 * without notifying observers — mounted components would continue showing
 * stale data. resetQueries() resets state, notifies observers, and triggers
 * refetches for active queries so they load fresh data for the new project.
 *
 * AC: @ui-data-freshness ac-5 — Discard all cached data on project change
 */
export function clearQueryCache(): void {
  if (queryClientInstance) {
    queryClientInstance.resetQueries();
  }
}
