/**
 * Unified API Response Envelope
 *
 * Server-side wrapper that route handlers call to construct normalized
 * envelope responses. Ensures consistent {data, meta} shape across all
 * cache-backed endpoints.
 *
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */

import type { ApiResponse, ApiResponseMeta, CacheStatus } from "@kynetic-ai/shared";
import type { CacheDomainState } from "./entity-cache-types.js";

/**
 * Options for constructing an API response envelope.
 */
export interface WrapResponseOptions {
  /** Pagination total count (list endpoints only). */
  total?: number;
  /** Pagination offset applied. */
  offset?: number;
  /** Pagination limit applied. */
  limit?: number;
  /** Raw cache domain state from the entity cache. */
  cacheDomainState?: CacheDomainState | undefined;
}

/**
 * Maps the internal CacheDomainState to the API-facing CacheStatus.
 * "loading" stays "loading"; everything else maps to "ready".
 * AC: @api-contract ac-cache-status-field
 */
export function toCacheStatus(domainState: CacheDomainState | undefined): CacheStatus {
  return domainState === "loading" ? "loading" : "ready";
}

/**
 * Constructs a normalized API response envelope.
 *
 * For cache-warming responses, call with a default-empty data value and
 * cacheDomainState = "loading". For normal responses, the data payload is
 * the domain result and cacheDomainState is "ready" (or omitted).
 *
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 *
 * @param data - Typed payload (array for lists, object for detail/aggregation).
 * @param options - Pagination params and cache domain state.
 * @returns Normalized {data, meta} envelope.
 */
export function wrapResponse<T>(data: T, options: WrapResponseOptions = {}): ApiResponse<T> {
  const { total, offset, limit, cacheDomainState } = options;

  const meta: ApiResponseMeta = {
    cache_status: toCacheStatus(cacheDomainState),
  };

  if (total !== undefined) meta.total = total;
  if (offset !== undefined) meta.offset = offset;
  if (limit !== undefined) meta.limit = limit;

  return { data, meta };
}
