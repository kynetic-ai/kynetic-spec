/**
 * Shared CLI validation helpers.
 *
 * All helpers return Result<T> — pure functions with no process.exit() or throws.
 * Exit-code mapping stays at the command boundary.
 *
 * Task: @01KGWDPV
 */

import type { LoadedSpecItem, LoadedTask } from "../parser/yaml.js";
import type { ReferenceIndex } from "../parser/refs.js";
import { errors } from "../strings/index.js";

// ─── Result type ────────────────────────────────────────────

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ─── parseIntOption ─────────────────────────────────────────

export interface IntOptionConfig {
  /** Minimum allowed value (inclusive) */
  min: number;
  /** Maximum allowed value (inclusive) */
  max: number;
  /** Human-readable name for error messages (e.g., "Priority") */
  name: string;
}

/**
 * Parse and validate an integer CLI option.
 *
 * Uses Number(value) (not parseInt) to reject partial parses like "3abc" or "1.9".
 */
export function parseIntOption(
  value: string,
  config: IntOptionConfig,
): Result<number> {
  const num = Number(value);

  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return {
      ok: false,
      error: `${config.name} must be a number between ${config.min} and ${config.max}`,
    };
  }

  if (!Number.isInteger(num)) {
    return {
      ok: false,
      error: `${config.name} must be a whole number between ${config.min} and ${config.max}`,
    };
  }

  if (num < config.min || num > config.max) {
    return {
      ok: false,
      error: `${config.name} must be between ${config.min} and ${config.max}`,
    };
  }

  return { ok: true, value: num };
}

// ─── validateEnumOption ─────────────────────────────────────

/**
 * Validate a CLI option against a set of allowed values.
 */
export function validateEnumOption<T extends string>(
  value: string,
  allowed: readonly T[],
  name: string,
): Result<T> {
  if (!(allowed as readonly string[]).includes(value)) {
    return {
      ok: false,
      error: `Invalid ${name}: ${value}. Must be one of: ${allowed.join(", ")}`,
    };
  }

  return { ok: true, value: value as T };
}

// ─── validateSpecRef ────────────────────────────────────────

/**
 * Validate that a reference points to a spec item (not a task or meta item).
 *
 * Positively asserts the ref IS in the items array, closing the gap where
 * meta refs could previously pass through as valid spec_refs.
 */
export function validateSpecRef(
  ref: string,
  index: ReferenceIndex,
  tasks: LoadedTask[],
  items: LoadedSpecItem[],
): Result<string> {
  const result = index.resolve(ref);

  if (!result.ok) {
    return {
      ok: false,
      error: errors.reference.specRefNotFound(ref),
    };
  }

  // Positive assertion: the resolved ULID must be a spec item
  const isSpecItem = items.some((i) => i._ulid === result.ulid);
  if (!isSpecItem) {
    // Give a more specific error if it's a task
    const isTask = tasks.some((t) => t._ulid === result.ulid);
    if (isTask) {
      return {
        ok: false,
        error: errors.reference.specRefIsTask(ref),
      };
    }
    // It's a meta item or something else
    return {
      ok: false,
      error: errors.reference.specRefNotFound(ref),
    };
  }

  return { ok: true, value: ref };
}
