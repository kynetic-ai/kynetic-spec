/**
 * Validation module for review records.
 *
 * Provides schema validation for review records, threads, checks, verdicts,
 * events, and subject bindings. Used during parsing, persistence, and
 * command mutation to ensure review data integrity.
 *
 * AC: @review-record-validation ac-1, ac-2
 */

import * as path from "node:path";
import {
  ReviewRecordSchema,
  ReviewRecordsFileSchema,
  ReviewRecordInputSchema,
} from "../schema/review-records.js";
import type { SchemaValidationError } from "./validate.js";
import { readYamlFile } from "./yaml.js";

/**
 * Result of validating a single review record.
 */
export interface ReviewValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
}

/**
 * Provide actionable guidance for common review validation failures.
 *
 * AC: @review-record-validation ac-2
 */
function formatActionableMessage(fieldPath: string, message: string): string {
  // Subject type discrimination errors
  if (fieldPath.includes("subject") && message.includes("discriminator")) {
    return `${message}. Subject type must be one of: code, plan, task, spec, external`;
  }

  // Subject version discrimination errors
  if (fieldPath.includes("applies_to_version") && message.includes("discriminator")) {
    return `${message}. Version type must be one of: code_compare, entity_version`;
  }

  // Anchor type discrimination errors
  if (fieldPath.includes("anchor") && message.includes("discriminator")) {
    return `${message}. Anchor type must be one of: code, structured, spec_ac, plan_text`;
  }

  // Missing required title
  if (fieldPath.endsWith("title") && message.includes("too_small")) {
    return "Title is required and must be non-empty";
  }

  // Invalid URL
  if (message.includes("Invalid url")) {
    return `${message}. Provide a valid URL (e.g., https://example.com)`;
  }

  // Invalid ULID
  if (
    fieldPath.endsWith("_ulid") &&
    (message.includes("String must contain") || message.includes("Invalid"))
  ) {
    return `${message}. ULIDs must be exactly 26 uppercase alphanumeric characters (Crockford base32)`;
  }

  // Invalid enum value
  if (message.includes("Invalid enum value")) {
    return message;
  }

  // Invalid datetime
  if (message.includes("Invalid datetime")) {
    return `${message}. Use ISO 8601 format (e.g., 2026-03-14T00:00:00.000Z)`;
  }

  return message;
}

/**
 * Validate a single review record against the full ReviewRecordSchema.
 * Use this when validating persisted or loaded review records.
 *
 * AC: @review-record-validation ac-1
 */
export function validateReviewRecord(data: unknown, source?: string): ReviewValidationResult {
  const errors: SchemaValidationError[] = [];
  const file = source ?? "review-record";

  const result = ReviewRecordSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        file,
        path: issue.path.join("."),
        message: formatActionableMessage(issue.path.join("."), issue.message),
        details: issue,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate review record input (for creating new reviews).
 * Uses ReviewRecordInputSchema which has relaxed requirements.
 *
 * AC: @review-record-validation ac-1, ac-2
 */
export function validateReviewRecordInput(data: unknown, source?: string): ReviewValidationResult {
  const errors: SchemaValidationError[] = [];
  const file = source ?? "review-record-input";

  const result = ReviewRecordInputSchema.safeParse(data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        file,
        path: issue.path.join("."),
        message: formatActionableMessage(issue.path.join("."), issue.message),
        details: issue,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a reviews YAML file (project.reviews.yaml).
 * Validates the file-level schema and each individual review record.
 *
 * AC: @review-record-validation ac-1, ac-2
 */
export async function validateReviewsFile(filePath: string): Promise<SchemaValidationError[]> {
  const errors: SchemaValidationError[] = [];

  try {
    const raw = await readYamlFile<unknown>(filePath);

    if (!raw || typeof raw !== "object") {
      errors.push({
        file: filePath,
        message:
          "Invalid reviews file format: expected an object with { kynetic_reviews, reviews }",
      });
      return errors;
    }

    // Validate the full file schema
    const fileResult = ReviewRecordsFileSchema.safeParse(raw);
    if (!fileResult.success) {
      // Try to give per-review errors for better diagnostics
      const rawObj = raw as Record<string, unknown>;
      if (Array.isArray(rawObj.reviews)) {
        for (let i = 0; i < rawObj.reviews.length; i++) {
          const reviewResult = ReviewRecordSchema.safeParse(rawObj.reviews[i]);
          if (!reviewResult.success) {
            for (const issue of reviewResult.error.issues) {
              const fieldPath = `reviews[${i}].${issue.path.join(".")}`;
              errors.push({
                file: filePath,
                path: fieldPath,
                message: formatActionableMessage(fieldPath, issue.message),
                details: issue,
              });
            }
          }
        }
      }

      // If no per-review errors were found, report file-level errors
      if (errors.length === 0) {
        for (const issue of fileResult.error.issues) {
          errors.push({
            file: filePath,
            path: issue.path.join("."),
            message: formatActionableMessage(issue.path.join("."), issue.message),
            details: issue,
          });
        }
      }
    }
  } catch (err) {
    errors.push({
      file: filePath,
      message: `Failed to parse reviews YAML: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return errors;
}

/**
 * Find review files in a directory (files matching *.reviews.yaml).
 */
export async function findReviewFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await findReviewFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith(".reviews.yaml")) {
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return files;
}

/**
 * Convenience: parse and validate a review record, returning the typed
 * result on success or errors on failure.
 *
 * AC: @review-record-validation ac-1, ac-2
 */
export function parseReviewRecord(
  data: unknown,
  source?: string,
):
  | { ok: true; data: import("../schema/review-records.js").ReviewRecord }
  | { ok: false; errors: SchemaValidationError[] } {
  const result = validateReviewRecord(data, source);
  if (!result.valid) {
    return { ok: false, errors: result.errors };
  }
  // Safe to parse — validation already passed
  return { ok: true, data: ReviewRecordSchema.parse(data) };
}

/**
 * Convenience: parse and validate review record input, returning the typed
 * result on success or errors on failure.
 *
 * AC: @review-record-validation ac-1, ac-2
 */
export function parseReviewRecordInput(
  data: unknown,
  source?: string,
):
  | { ok: true; data: import("../schema/review-records.js").ReviewRecordInput }
  | { ok: false; errors: SchemaValidationError[] } {
  const result = validateReviewRecordInput(data, source);
  if (!result.valid) {
    return { ok: false, errors: result.errors };
  }
  return { ok: true, data: ReviewRecordInputSchema.parse(data) };
}
