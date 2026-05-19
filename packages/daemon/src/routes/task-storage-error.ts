/**
 * Daemon Route Helper — task-storage incompatibility error mapping.
 *
 * Translates deterministic task-storage compatibility/migration failures
 * (legacy monolithic storage, split-but-unmigrated state) into a stable
 * 409 Conflict response shape for any daemon API route that needs task
 * data from disk. Generic TaskDataManagerError values (task-not-found,
 * mutation validation, etc.) return no match so callers keep their
 * existing not_found/validation/transition handling intact.
 *
 * AC: @api-contract ac-task-storage-incompatibility-conflict-status
 * AC: @api-contract ac-task-storage-incompatibility-error-code
 * AC: @api-contract ac-task-storage-incompatibility-guidance
 * AC: @api-contract ac-task-storage-incompatibility-not-not-found
 * AC: @api-contract ac-task-storage-incompatibility-field-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-domain-context
 * AC: @api-contract ac-task-storage-incompatibility-cache-state-context
 */

import type { ErrorResponse } from "@kynetic-ai/shared";
import {
  isDeterministicTaskStorageIncompatibility,
  TaskDataManagerError,
} from "../../parser/index.js";
import type { CacheDomainState, RouteEntityCache } from "./entity-cache-types.js";

/** Stable HTTP status returned for task-storage incompatibility. */
export const TASK_STORAGE_INCOMPATIBLE_STATUS = 409 as const;

/** Stable top-level `error` discriminator for task-storage incompatibility. */
export const TASK_STORAGE_INCOMPATIBLE_ERROR_CODE = "task_storage_incompatible" as const;

/**
 * Options for {@link taskStorageIncompatibilityResponse}.
 *
 * When neither `cacheDomainState` nor `cache` is provided, the response
 * omits `cache_domain_state`. When `cache` is provided without
 * `cacheDomainState`, the helper looks up the state for `cacheDomain`
 * (defaulting to "tasks") on the cache.
 */
export interface TaskStorageIncompatibilityOptions {
  /**
   * Cache domain identifier the failure is associated with. Defaults to
   * "tasks" — the only domain that currently raises deterministic
   * task-storage incompatibilities.
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
 * Materialized 409 response for a deterministic task-storage incompatibility.
 * Routes return the body via their preferred mechanism (Elysia's `error()`
 * helper, `set.status = …`, etc.).
 */
export interface TaskStorageIncompatibilityResponse {
  status: typeof TASK_STORAGE_INCOMPATIBLE_STATUS;
  body: ErrorResponse;
}

/**
 * Convert a candidate error into a structured task-storage incompatibility
 * response, or return `null` when the error is not a deterministic
 * task-storage incompatibility. Routes layered on `resolveTaskDataManager`
 * call this in their catch blocks so legacy/unmigrated projects surface
 * a stable 409 with recovery guidance instead of collapsing to 404
 * not_found (or escaping as an unhandled 500).
 *
 * Generic {@link TaskDataManagerError} values — task-not-found, validation,
 * mutation — return `null` so existing not_found/validation/transition
 * handling remains intact.
 */
export function taskStorageIncompatibilityResponse(
  err: unknown,
  options: TaskStorageIncompatibilityOptions = {},
): TaskStorageIncompatibilityResponse | null {
  if (!isDeterministicTaskStorageIncompatibility(err)) {
    return null;
  }

  // The type guard narrows `err` to TaskDataManagerError, but TS infers a
  // structural shape without the class-private suggestion/field. Casting
  // back to the concrete class keeps the call-site ergonomics simple.
  const sourceErr = err as TaskDataManagerError;

  const cacheDomain = options.cacheDomain ?? "tasks";
  const cacheDomainState: CacheDomainState | undefined =
    options.cacheDomainState ??
    (cacheDomain && options.cache ? options.cache.getDomainState(cacheDomain) : undefined);

  const body: ErrorResponse = {
    error: TASK_STORAGE_INCOMPATIBLE_ERROR_CODE,
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

  return { status: TASK_STORAGE_INCOMPATIBLE_STATUS, body };
}
