/**
 * Legacy session detection, warning, and migration.
 *
 * No transparent fallback reads — all session reads go directly to
 * .kspec-sessions/. When legacy sessions exist in .kspec/sessions/,
 * a warning is emitted advising the user to run `kspec session migrate`.
 *
 * AC: @session-legacy-migration ac-read-fallback ac-no-write ac-list-merge ac-deprecation-warning
 */

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import {
  listSessions,
} from "./store.js";

// ─── Legacy Path Resolution ─────────────────────────────────────────────────

/**
 * Get the legacy sessions directory path (.kspec/sessions/).
 *
 * @param specDir - The .kspec/ directory (shadow branch worktree)
 * @returns Path to legacy sessions directory, or null if specDir is not available
 */
export function getLegacySessionsDir(
  specDir: string | undefined,
): string | null {
  if (!specDir) return null;
  return path.join(specDir, "sessions");
}

/**
 * Check if a legacy sessions directory exists and has session subdirectories.
 */
export async function hasLegacySessions(
  specDir: string | undefined,
): Promise<boolean> {
  const legacyDir = getLegacySessionsDir(specDir);
  if (!legacyDir) return false;

  try {
    const entries = await fsPromises.readdir(legacyDir, {
      withFileTypes: true,
    });
    return entries.some((e) => e.isDirectory());
  } catch {
    return false;
  }
}

/**
 * Count legacy sessions that haven't been migrated yet.
 *
 * @returns Number of session directories in .kspec/sessions/
 */
export async function countLegacySessions(
  specDir: string | undefined,
): Promise<number> {
  const legacyDir = getLegacySessionsDir(specDir);
  if (!legacyDir) return 0;

  try {
    const entries = await fsPromises.readdir(legacyDir, {
      withFileTypes: true,
    });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

// ─── Deprecation Warning ────────────────────────────────────────────────────

let deprecationWarningEmitted = false;

/**
 * Emit a deprecation warning to stderr for legacy sessions detected.
 * AC: @session-legacy-migration ac-deprecation-warning
 *
 * Emits once per process to avoid spam. Writes to stderr, not stdout,
 * so it doesn't interfere with structured output.
 *
 * @param count - Number of legacy sessions found (included in warning message)
 */
export function emitLegacyDeprecationWarning(count?: number): void {
  if (!deprecationWarningEmitted) {
    const countMsg = count !== undefined ? `${count} legacy session(s) found` : "Legacy sessions found";
    console.error(
      `Warning: ${countMsg} in .kspec/sessions/. ` +
      "Run `kspec session migrate` to move them to .kspec-sessions/.",
    );
    deprecationWarningEmitted = true;
  }
}

/**
 * Reset the deprecation warning state (for testing).
 */
export function resetDeprecationWarning(): void {
  deprecationWarningEmitted = false;
}

/**
 * Check for legacy sessions and emit a warning if found.
 * AC: @session-legacy-migration ac-read-fallback ac-deprecation-warning
 *
 * Convenience function that combines hasLegacySessions + countLegacySessions
 * + emitLegacyDeprecationWarning. Call this at the start of session read
 * operations to detect-and-warn without performing any fallback reads.
 *
 * @returns true if legacy sessions were detected (warning was emitted)
 */
export async function warnIfLegacySessions(
  specDir: string | undefined,
): Promise<boolean> {
  const count = await countLegacySessions(specDir);
  if (count > 0) {
    emitLegacyDeprecationWarning(count);
    return true;
  }
  return false;
}

// ─── Migration ──────────────────────────────────────────────────────────────

/**
 * Result of a session migration operation.
 * AC: @session-legacy-migration ac-migration-copy ac-migration-idempotent
 */
export interface MigrationResult {
  /** Number of sessions copied */
  migrated: number;
  /** Number of sessions skipped (already exist in target) */
  skipped: number;
  /** Session IDs that were migrated */
  migratedIds: string[];
  /** Session IDs that were skipped */
  skippedIds: string[];
}

/**
 * Copy session directories from legacy to primary location.
 *
 * AC: @session-legacy-migration ac-migration-copy
 * Copies session directories from .kspec/sessions/ to .kspec-sessions/.
 * Does not delete originals.
 *
 * AC: @session-legacy-migration ac-migration-idempotent
 * Skips sessions that already exist in target.
 */
export async function migrateLegacySessions(
  sessionsDir: string,
  specDir: string,
): Promise<MigrationResult> {
  const legacyDir = getLegacySessionsDir(specDir);
  if (!legacyDir) {
    return { migrated: 0, skipped: 0, migratedIds: [], skippedIds: [] };
  }

  const legacyIds = await listSessions(legacyDir);
  if (legacyIds.length === 0) {
    return { migrated: 0, skipped: 0, migratedIds: [], skippedIds: [] };
  }

  const primaryIds = new Set(await listSessions(sessionsDir));
  const result: MigrationResult = {
    migrated: 0,
    skipped: 0,
    migratedIds: [],
    skippedIds: [],
  };

  for (const id of legacyIds) {
    if (primaryIds.has(id)) {
      // AC: ac-migration-idempotent — skip existing
      result.skipped++;
      result.skippedIds.push(id);
      continue;
    }

    // Copy entire session directory recursively
    const srcDir = path.join(legacyDir, id);
    const destDir = path.join(sessionsDir, id);
    await fsPromises.cp(srcDir, destDir, { recursive: true });
    result.migrated++;
    result.migratedIds.push(id);
  }

  return result;
}
