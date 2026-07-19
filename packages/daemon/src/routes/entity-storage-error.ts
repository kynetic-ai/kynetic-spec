/**
 * Daemon Route Helper — entity-storage incompatibility error mapping.
 *
 * Translates deterministic entity-storage compatibility/migration failures
 * (legacy plan/review storage, missing folder declarations, partial folder
 * layouts) into a stable 409 Conflict response shape for any daemon API
 * route that needs plan, review, or resource data from disk.
 *
 * Generic Error values (or non-deterministic EntityStorageCompatibilityError
 * codes) return no match so callers keep their existing not_found/validation
 * handling intact.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
 */

import type { ErrorResponse } from "@kynetic-ai/shared";
import {
  EntityStorageCompatibilityError,
  isDeterministicEntityStorageIncompatibility,
} from "../../parser/index.js";
import type { CacheDomainState, RouteEntityCache } from "./entity-cache-types.js";

/** Stable HTTP status returned for entity-storage incompatibility. */
export const ENTITY_STORAGE_INCOMPATIBLE_STATUS = 409 as const;

/** Stable top-level `error` discriminator for entity-storage incompatibility. */
export const ENTITY_STORAGE_INCOMPATIBLE_ERROR_CODE = "entity_storage_incompatible" as const;

/**
 * Options for {@link entityStorageIncompatibilityResponse}.
 *
 * The default cache domain comes from the error itself (plans, reviews, or
 * resources). When `cache` is provided, the helper looks up the domain
 * state for that cache. Callers may override either via the options bag.
 */
export interface EntityStorageIncompatibilityOptions {
  /**
   * Override the cache domain attribution. Defaults to the error's domain
   * (plans, reviews, or resources).
   */
  cacheDomain?: string;
  /**
   * Explicit cache domain state to surface when known. Takes precedence
   * over deriving the state from `cache`.
   */
  cacheDomainState?: CacheDomainState;
  /**
   * Entity cache accessor to derive the domain state from when an explicit
   * state is not supplied.
   */
  cache?: RouteEntityCache | null;
}

/**
 * Materialized 409 response for a deterministic entity-storage
 * incompatibility. Routes return the body via their preferred mechanism
 * (Elysia's `error()` helper, `set.status = …`, etc.).
 */
export interface EntityStorageIncompatibilityResponse {
  status: typeof ENTITY_STORAGE_INCOMPATIBLE_STATUS;
  body: ErrorResponse;
}

/**
 * Convert a candidate error into a structured entity-storage incompatibility
 * response, or return `null` when the error is not a deterministic
 * incompatibility. Routes layered on `assert*Compatible` / `require*FolderStorage`
 * call this in their catch blocks so unmigrated projects surface a stable
 * 409 with recovery guidance instead of escaping as an unhandled 500.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-daemon-returns-structured-conflict
 */
export function entityStorageIncompatibilityResponse(
  err: unknown,
  options: EntityStorageIncompatibilityOptions = {},
): EntityStorageIncompatibilityResponse | null {
  if (!isDeterministicEntityStorageIncompatibility(err)) {
    return null;
  }

  const sourceErr = err as EntityStorageCompatibilityError;

  const cacheDomain = options.cacheDomain ?? sourceErr.cacheDomain;
  const cacheDomainState: CacheDomainState | undefined =
    options.cacheDomainState ??
    (cacheDomain && options.cache ? options.cache.getDomainState(cacheDomain) : undefined);

  const body: ErrorResponse = {
    error: ENTITY_STORAGE_INCOMPATIBLE_ERROR_CODE,
    message: sourceErr.message,
  };
  if (sourceErr.code) {
    body.code = sourceErr.code;
  }
  if (sourceErr.suggestion) {
    body.suggestion = sourceErr.suggestion;
  }
  if (sourceErr.field) {
    body.field = sourceErr.field;
  }
  if (cacheDomain) {
    body.cache_domain = cacheDomain;
  }
  if (cacheDomainState !== undefined) {
    body.cache_domain_state = cacheDomainState;
  }
  body.domain = sourceErr.domain;

  return { status: ENTITY_STORAGE_INCOMPATIBLE_STATUS, body };
}
