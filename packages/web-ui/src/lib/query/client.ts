/**
 * Query Client Factory
 *
 * Creates and configures the TanStack Query client for the kspec web UI.
 * Optimized for localhost daemon communication with appropriate cache timing.
 *
 * AC: @ui-data-freshness ac-1 — Cache-then-revalidate via staleTime + gcTime
 * AC: @ui-data-freshness ac-2 — Request deduplication built into QueryClient
 * AC: @ui-data-freshness ac-7 — Retry config for localhost daemon
 * AC: @ui-data-freshness ac-warming-retry-fallback — Cache warming retry at 2s intervals
 * AC: @ui-data-freshness ac-warming-timeout — 30s ceiling (15 attempts × 2s)
 */

import { QueryClient } from "@tanstack/svelte-query";
import { CacheWarmingError } from "$lib/api";

/** Maximum retry attempts for cache warming errors (15 × 2s = 30s ceiling). */
export const CACHE_WARMING_MAX_RETRIES = 15;

/** Retry delay in ms for cache warming errors. */
export const CACHE_WARMING_RETRY_DELAY_MS = 2000;

/** Default retry attempts for normal errors. */
const DEFAULT_MAX_RETRIES = 1;

/** Default retry delay in ms for normal errors. */
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Create a configured QueryClient instance.
 *
 * Default config rationale:
 * - staleTime 30s: Localhost daemon data changes via WebSocket events,
 *   so moderate staleness is acceptable. WS invalidation handles freshness.
 * - gcTime 10min: Keep data in memory for session-length navigation.
 * - retry: Function — CacheWarmingError gets 15 retries (30s ceiling),
 *   other errors get 1 retry (localhost daemon).
 * - retryDelay: Function — 2s for cache warming, 1s for other errors.
 * - refetchOnWindowFocus false: Avoid unnecessary refetches; WS handles freshness.
 *
 * AC: @ui-data-freshness ac-warming-retry-fallback — CacheWarmingError retries at 2s
 * AC: @ui-data-freshness ac-warming-timeout — 15 attempts × 2s = 30s max
 * AC: @ui-data-freshness ac-warming-skeleton — CacheWarmingError prevents caching warming data
 */
export function createQueryClientInstance(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        gcTime: 10 * 60 * 1000,
        retry(failureCount, error) {
          if (error instanceof CacheWarmingError) {
            return failureCount < CACHE_WARMING_MAX_RETRIES;
          }
          return failureCount < DEFAULT_MAX_RETRIES;
        },
        retryDelay(failureCount, error) {
          if (error instanceof CacheWarmingError) {
            return CACHE_WARMING_RETRY_DELAY_MS;
          }
          return DEFAULT_RETRY_DELAY_MS;
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
