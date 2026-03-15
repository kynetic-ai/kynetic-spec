/**
 * Query Client Factory
 *
 * Creates and configures the TanStack Query client for the kspec web UI.
 * Optimized for localhost daemon communication with appropriate cache timing.
 *
 * AC: @ui-data-freshness ac-1 — Cache-then-revalidate via staleTime + gcTime
 * AC: @ui-data-freshness ac-2 — Request deduplication built into QueryClient
 * AC: @ui-data-freshness ac-7 — Retry config for localhost daemon
 */

import { QueryClient } from '@tanstack/svelte-query';

/**
 * Create a configured QueryClient instance.
 *
 * Default config rationale:
 * - staleTime 30s: Localhost daemon data changes via WebSocket events,
 *   so moderate staleness is acceptable. WS invalidation handles freshness.
 * - gcTime 10min: Keep data in memory for session-length navigation.
 * - retry 1: Localhost daemon — if it's down, retrying won't help much.
 * - retryDelay 1s: Short delay for localhost.
 */
export function createQueryClientInstance(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30 * 1000,
				gcTime: 10 * 60 * 1000,
				retry: 1,
				retryDelay: 1000,
				refetchOnWindowFocus: false,
			},
			mutations: {
				retry: 0,
			},
		},
	});
}
