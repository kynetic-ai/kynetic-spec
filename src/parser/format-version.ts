/**
 * Format Version Ceiling — forward-compatibility gate for the project
 * manifest's declared format version (`kynetic`).
 *
 * Each released kspec declares a maximum supported format version. Project
 * data declaring a NEWER format version was written by a newer kspec whose
 * layout this installation does not understand, so context initialization
 * refuses before any project data is read, mutated, or synchronized instead
 * of operating on it. Backward compatibility (older formats) is governed by
 * the existing per-domain storage gates (entity-storage-compatibility,
 * task-data-manager) and is intentionally NOT handled here.
 *
 * The deterministic error codes are:
 *
 *  - `format_version_newer_than_supported` — declared version parses to a
 *    numeric version greater than {@link MAX_SUPPORTED_KYNETIC_VERSION}
 *  - `unrecognized_format_version` — the field is present but cannot be
 *    interpreted as a numeric version; never silently treated as the
 *    oldest format
 *
 * A manifest with no declared `kynetic` field keeps its existing legacy
 * interpretation — callers must perform the check against the RAW manifest
 * read from disk, not the schema-parsed manifest, because the Zod schema
 * defaults a missing field to "1.0" and would erase the missing-field case.
 *
 * Spec: @data-format-forward-compatibility
 */

/**
 * Maximum manifest format version this kspec installation can read and
 * write. Advance this alongside any release that introduces a new
 * `kynetic` manifest version.
 */
export const MAX_SUPPORTED_KYNETIC_VERSION = "1.2";

/** Numeric form used for `parseFloat` comparisons against `kynetic` strings. */
export const MAX_SUPPORTED_KYNETIC_NUMERIC = 1.2;

// ── Deterministic error codes ──────────────────────────────────────────────

/**
 * Stable code reserved for project data declaring a format version newer
 * than this installation supports. The condition will not resolve on retry —
 * only upgrading the kspec installation (or using the newer kspec that wrote
 * the data) can clear it.
 *
 * AC: @data-format-forward-compatibility ac-newer-version-refused
 */
export const FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE = "format_version_newer_than_supported";

/**
 * Stable code for a declared format version that cannot be interpreted as a
 * numeric version. Refused as incompatible rather than silently treated as
 * the oldest format.
 *
 * AC: @data-format-forward-compatibility ac-unrecognized-version-refused
 */
export const UNRECOGNIZED_FORMAT_VERSION_CODE = "unrecognized_format_version";

export const DETERMINISTIC_FORMAT_VERSION_INCOMPATIBILITY_CODES: ReadonlySet<string> = new Set([
  FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE,
  UNRECOGNIZED_FORMAT_VERSION_CODE,
]);

/**
 * Error thrown when the project manifest's declared format version is newer
 * than this installation supports, or cannot be interpreted at all.
 *
 * Carries the deterministic code, both version values, and upgrade guidance.
 * The deterministic code is embedded in the message so every consumer that
 * only surfaces `err.message` (CLI command catch blocks, daemon fallbacks)
 * still presents it.
 */
export class FormatVersionCompatibilityError extends Error {
  readonly code: string;
  /** The literal declared `kynetic` value from the manifest. */
  readonly declaredVersion: string;
  /** The running tool's maximum supported format version. */
  readonly maxSupportedVersion: string;
  readonly suggestion: string;

  constructor(
    message: string,
    options: {
      code: string;
      declaredVersion: string;
      suggestion: string;
    },
  ) {
    super(message);
    this.name = "FormatVersionCompatibilityError";
    this.code = options.code;
    this.declaredVersion = options.declaredVersion;
    this.maxSupportedVersion = MAX_SUPPORTED_KYNETIC_VERSION;
    this.suggestion = options.suggestion;
  }
}

/**
 * Type guard for deterministic format-version incompatibilities. Returns
 * true only when the error carries a known incompatibility code; generic
 * Error values and other thrown values return false.
 */
export function isDeterministicFormatVersionIncompatibility(
  err: unknown,
): err is FormatVersionCompatibilityError {
  return (
    err instanceof FormatVersionCompatibilityError &&
    DETERMINISTIC_FORMAT_VERSION_INCOMPATIBILITY_CODES.has(err.code)
  );
}

const UPGRADE_SUGGESTION =
  "Upgrade your kspec installation to a version that supports this data format, or use the newer kspec version that wrote this project.";

/**
 * Build the format-version ceiling incompatibility for a RAW declared
 * `kynetic` value, or return null when the value is supported.
 *
 * Semantics (decided on the raw manifest representation — see module doc):
 *  - `undefined` / `null` (field absent) → null; missing fields keep their
 *    existing legacy interpretation.
 *  - string → `parseFloat`, consistent with every existing version gate.
 *    NaN refuses as unrecognized; a numeric value greater than
 *    {@link MAX_SUPPORTED_KYNETIC_NUMERIC} refuses as newer-than-supported.
 *  - finite number (YAML-unquoted version) → same numeric comparison.
 *  - anything else (boolean, object, array, non-finite number) → refused as
 *    unrecognized, naming the literal value.
 *
 * AC: @data-format-forward-compatibility ac-newer-version-refused
 * AC: @data-format-forward-compatibility ac-unrecognized-version-refused
 * AC: @data-format-forward-compatibility ac-supported-versions-unaffected
 */
export function describeFormatVersionIncompatibility(
  declared: unknown,
): FormatVersionCompatibilityError | null {
  if (declared === undefined || declared === null) return null;

  let numeric: number;
  if (typeof declared === "string") {
    numeric = parseFloat(declared);
  } else if (typeof declared === "number") {
    numeric = declared;
  } else {
    numeric = NaN;
  }

  const literal = typeof declared === "string" ? declared : JSON.stringify(declared);

  if (!Number.isFinite(numeric)) {
    return new FormatVersionCompatibilityError(
      `This project's manifest declares format version "${literal}", which cannot be interpreted ` +
        `as a known kynetic format version (maximum supported: "${MAX_SUPPORTED_KYNETIC_VERSION}") ` +
        `[${UNRECOGNIZED_FORMAT_VERSION_CODE}]. ${UPGRADE_SUGGESTION}`,
      {
        code: UNRECOGNIZED_FORMAT_VERSION_CODE,
        declaredVersion: literal,
        suggestion: UPGRADE_SUGGESTION,
      },
    );
  }

  if (numeric > MAX_SUPPORTED_KYNETIC_NUMERIC) {
    return new FormatVersionCompatibilityError(
      `This project's manifest declares format version "${literal}", which is newer than the ` +
        `maximum format version supported by this kspec installation ("${MAX_SUPPORTED_KYNETIC_VERSION}") ` +
        `[${FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE}]. No project data was modified. ${UPGRADE_SUGGESTION}`,
      {
        code: FORMAT_VERSION_NEWER_THAN_SUPPORTED_CODE,
        declaredVersion: literal,
        suggestion: UPGRADE_SUGGESTION,
      },
    );
  }

  return null;
}

/**
 * Extract the raw `kynetic` field from a raw (non-schema-parsed) manifest
 * object. Returns undefined when the manifest is not an object or the field
 * is absent, keeping the missing-field case unambiguous.
 */
export function getRawDeclaredFormatVersion(rawManifest: unknown): unknown {
  if (!rawManifest || typeof rawManifest !== "object") return undefined;
  return (rawManifest as Record<string, unknown>).kynetic;
}

/**
 * Throw the format-version ceiling incompatibility for a raw manifest
 * object, if any. Callers pass the manifest as read from disk BEFORE schema
 * parsing so a missing `kynetic` field is genuinely absent.
 *
 * AC: @data-format-forward-compatibility ac-newer-version-refused
 * AC: @data-format-forward-compatibility ac-unrecognized-version-refused
 */
export function assertRawManifestFormatVersionSupported(rawManifest: unknown): void {
  const err = describeFormatVersionIncompatibility(getRawDeclaredFormatVersion(rawManifest));
  if (err) throw err;
}
