/**
 * Daemon Route Helper — format-version ceiling incompatibility error mapping.
 *
 * Translates the deterministic format-version refusals raised by context
 * initialization (project data declaring a format version newer than this
 * installation supports, or an unrecognized declared version) into a stable
 * 409 Conflict response shape, mirroring the entity-storage incompatibility
 * contract (see entity-storage-error.ts).
 *
 * Generic Error values return no match so callers keep their existing
 * not_found/validation handling intact.
 *
 * AC: @data-format-forward-compatibility ac-daemon-structured-error
 */

import type { ErrorResponse } from "@kynetic-ai/shared";
import {
  type FormatVersionCompatibilityError,
  isDeterministicFormatVersionIncompatibility,
} from "../../parser/index.js";

/** Stable HTTP status returned for format-version incompatibility. */
export const FORMAT_VERSION_INCOMPATIBLE_STATUS = 409 as const;

/** Stable top-level `error` discriminator for format-version incompatibility. */
export const FORMAT_VERSION_INCOMPATIBLE_ERROR_CODE = "format_version_incompatible" as const;

/**
 * Materialized 409 response for a deterministic format-version
 * incompatibility. Routes return the body via their preferred mechanism
 * (Elysia's `error()` helper, `set.status = …`, etc.).
 */
export interface FormatVersionIncompatibilityResponse {
  status: typeof FORMAT_VERSION_INCOMPATIBLE_STATUS;
  body: ErrorResponse;
}

/**
 * Convert a candidate error into a structured format-version incompatibility
 * response, or return `null` when the error is not a deterministic
 * format-version refusal. The body carries the same deterministic code as
 * the CLI refusal plus both version values, so clients can branch on the
 * code uniformly across surfaces.
 *
 * AC: @data-format-forward-compatibility ac-daemon-structured-error
 */
export function formatVersionIncompatibilityResponse(
  err: unknown,
): FormatVersionIncompatibilityResponse | null {
  if (!isDeterministicFormatVersionIncompatibility(err)) {
    return null;
  }

  const sourceErr = err as FormatVersionCompatibilityError;

  const body: ErrorResponse = {
    error: FORMAT_VERSION_INCOMPATIBLE_ERROR_CODE,
    message: sourceErr.message,
    code: sourceErr.code,
    suggestion: sourceErr.suggestion,
    declared_version: sourceErr.declaredVersion,
    max_supported_version: sourceErr.maxSupportedVersion,
  };

  return { status: FORMAT_VERSION_INCOMPATIBLE_STATUS, body };
}
