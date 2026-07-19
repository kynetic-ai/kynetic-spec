/**
 * Shared redaction helper for runner diagnostic surfaces.
 *
 * Replaces secret values with a fixed marker in any string that may be
 * persisted to CLI output, session events, task notes, daemon API responses,
 * or Web UI payloads. Callers capture the resolved secret values at the
 * runner-resolution boundary and reuse the returned closure for downstream
 * diagnostic writes — the underlying values stay scoped to the closure and
 * never reach call sites that only need a scrubber.
 *
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
 *
 * @module
 */

/** Marker substituted for any matched secret literal. */
export const REDACTION_MARKER = "[REDACTED]";

const NOOP_REDACTOR = (text: string): string => text;

/**
 * Filter inputs to non-empty strings and sort descending by length so longer
 * secrets are replaced first. Without this, a short secret that is a prefix
 * of a longer secret would partially redact the longer literal.
 */
function prepareSecretValues(values: Iterable<string>): readonly string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }
  list.sort((a, b) => b.length - a.length);
  return list;
}

/**
 * Replace every occurrence of any value in `values` with `REDACTION_MARKER`.
 * Empty/duplicate values are ignored. Longest values are replaced first.
 */
export function redactSecretValues(text: string, values: Iterable<string>): string {
  if (typeof text !== "string") return text;
  const list = prepareSecretValues(values);
  if (list.length === 0) return text;
  let result = text;
  for (const value of list) {
    if (!result.includes(value)) continue;
    result = result.split(value).join(REDACTION_MARKER);
  }
  return result;
}

/**
 * Capture a fixed set of secret values and return a closure that redacts
 * them from any string. The captured values are not exposed via the closure
 * interface — callers receive only the scrubber function.
 */
export function createRedactor(values: Iterable<string>): (text: string) => string {
  const list = prepareSecretValues(values);
  if (list.length === 0) return NOOP_REDACTOR;
  return (text: string): string => {
    if (typeof text !== "string") return text;
    let result = text;
    for (const value of list) {
      if (!result.includes(value)) continue;
      result = result.split(value).join(REDACTION_MARKER);
    }
    return result;
  };
}
