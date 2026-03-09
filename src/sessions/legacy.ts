/**
 * Legacy session read fallback.
 *
 * Provides fallback reads from .kspec/sessions/ (shadow branch) for sessions
 * that haven't been migrated to .kspec-sessions/ yet. All writes go to
 * .kspec-sessions/ only — the legacy location is read-only.
 *
 * AC: @session-legacy-migration ac-read-fallback ac-no-write ac-list-merge ac-deprecation-warning
 */

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import type { SessionMetadata, SessionEvent } from "./types.js";
import {
  type SessionLogSummary,
  type SessionSearchResult,
  type SessionIdResolution,
  type ToolUsageStats,
  getSession,
  readEvents,
  listSessions,
  getAllSessionLogSummaries,
  resolveSessionId,
  searchSessionEvents,
  computeToolUsageStats,
  type SearchOptions,
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

// ─── Deprecation Warning ────────────────────────────────────────────────────

const DEPRECATION_WARNING =
  "Warning: Reading session from legacy location .kspec/sessions/. " +
  "Run `kspec session migrate` to move sessions to .kspec-sessions/.";

let deprecationWarningEmitted = false;

/**
 * Emit a deprecation warning to stderr for legacy session reads.
 * AC: @session-legacy-migration ac-deprecation-warning
 *
 * Emits once per process to avoid spam. Writes to stderr, not stdout,
 * so it doesn't interfere with structured output.
 */
export function emitLegacyDeprecationWarning(): void {
  if (!deprecationWarningEmitted) {
    console.error(DEPRECATION_WARNING);
    deprecationWarningEmitted = true;
  }
}

/**
 * Reset the deprecation warning state (for testing).
 */
export function resetDeprecationWarning(): void {
  deprecationWarningEmitted = false;
}

// ─── Fallback Read Operations ───────────────────────────────────────────────
// AC: @session-legacy-migration ac-read-fallback
// Each function tries the primary sessionsDir first, then falls back to
// the legacy .kspec/sessions/ location if the session is not found.

/**
 * Get session metadata with legacy fallback.
 *
 * Tries .kspec-sessions/ first, then .kspec/sessions/ if not found.
 * Emits deprecation warning when reading from legacy location.
 *
 * @returns Session metadata and whether it came from legacy location
 */
export async function getSessionWithFallback(
  sessionsDir: string,
  sessionId: string,
  specDir?: string,
): Promise<{ session: SessionMetadata | null; legacy: boolean }> {
  // Try primary location first
  const session = await getSession(sessionsDir, sessionId);
  if (session) {
    return { session, legacy: false };
  }

  // Try legacy location
  const legacyDir = getLegacySessionsDir(specDir);
  if (legacyDir) {
    const legacySession = await getSession(legacyDir, sessionId);
    if (legacySession) {
      emitLegacyDeprecationWarning();
      return { session: legacySession, legacy: true };
    }
  }

  return { session: null, legacy: false };
}

/**
 * Read session events with legacy fallback.
 *
 * Tries .kspec-sessions/ first, then .kspec/sessions/ if session not found there.
 */
export async function readEventsWithFallback(
  sessionsDir: string,
  sessionId: string,
  specDir?: string,
): Promise<{ events: SessionEvent[]; legacy: boolean }> {
  // Check if session exists in primary location
  const session = await getSession(sessionsDir, sessionId);
  if (session) {
    const events = await readEvents(sessionsDir, sessionId);
    return { events, legacy: false };
  }

  // Try legacy location
  const legacyDir = getLegacySessionsDir(specDir);
  if (legacyDir) {
    const legacySession = await getSession(legacyDir, sessionId);
    if (legacySession) {
      emitLegacyDeprecationWarning();
      const events = await readEvents(legacyDir, sessionId);
      return { events, legacy: true };
    }
  }

  return { events: [], legacy: false };
}

/**
 * List sessions from both primary and legacy locations, deduplicated.
 *
 * AC: @session-legacy-migration ac-list-merge
 * Results include sessions from both locations, deduplicated by ID,
 * with .kspec-sessions/ taking precedence for duplicates.
 */
export async function listSessionsMerged(
  sessionsDir: string,
  specDir?: string,
): Promise<{ ids: string[]; hasLegacy: boolean }> {
  const primaryIds = await listSessions(sessionsDir);
  const primarySet = new Set(primaryIds);

  const legacyDir = getLegacySessionsDir(specDir);
  if (!legacyDir) {
    return { ids: primaryIds, hasLegacy: false };
  }

  const legacyIds = await listSessions(legacyDir);
  if (legacyIds.length === 0) {
    return { ids: primaryIds, hasLegacy: false };
  }

  // Add legacy IDs that aren't already in primary (dedup)
  let hasLegacy = false;
  const merged = [...primaryIds];
  for (const id of legacyIds) {
    if (!primarySet.has(id)) {
      merged.push(id);
      hasLegacy = true;
    }
  }

  if (hasLegacy) {
    emitLegacyDeprecationWarning();
  }

  return { ids: merged, hasLegacy };
}

/**
 * Get all session log summaries with legacy merge.
 *
 * AC: @session-legacy-migration ac-list-merge
 * Merges summaries from both locations, deduplicating by session ID,
 * with .kspec-sessions/ taking precedence.
 */
export async function getAllSessionLogSummariesMerged(
  sessionsDir: string,
  specDir?: string,
): Promise<SessionLogSummary[]> {
  const primarySummaries = await getAllSessionLogSummaries(sessionsDir);

  const legacyDir = getLegacySessionsDir(specDir);
  if (!legacyDir) {
    return primarySummaries;
  }

  const legacySummaries = await getAllSessionLogSummaries(legacyDir);
  if (legacySummaries.length === 0) {
    return primarySummaries;
  }

  // Dedup: primary takes precedence
  const primaryIds = new Set(primarySummaries.map((s) => s.id));
  const legacyOnly = legacySummaries.filter((s) => !primaryIds.has(s.id));

  if (legacyOnly.length > 0) {
    emitLegacyDeprecationWarning();
    return [...primarySummaries, ...legacyOnly];
  }

  return primarySummaries;
}

/**
 * Resolve a session ID with legacy fallback.
 *
 * Tries primary location first. If not found, tries legacy location.
 * If ambiguous in primary, does not check legacy.
 */
export async function resolveSessionIdWithFallback(
  sessionsDir: string,
  idOrPrefix: string,
  specDir?: string,
): Promise<SessionIdResolution & { legacy?: boolean }> {
  const primaryResult = await resolveSessionId(sessionsDir, idOrPrefix);
  if (primaryResult.ok || primaryResult.error === "ambiguous") {
    return { ...primaryResult, legacy: false };
  }

  // Not found in primary — try legacy
  const legacyDir = getLegacySessionsDir(specDir);
  if (legacyDir) {
    const legacyResult = await resolveSessionId(legacyDir, idOrPrefix);
    if (legacyResult.ok) {
      emitLegacyDeprecationWarning();
      return { ...legacyResult, legacy: true };
    }
  }

  return { ...primaryResult, legacy: false };
}

/**
 * Search session events across both primary and legacy locations.
 *
 * AC: @session-legacy-migration ac-list-merge (for search across all sessions)
 */
export async function searchSessionEventsWithFallback(
  sessionsDir: string,
  pattern: string,
  options: SearchOptions = {},
  specDir?: string,
): Promise<SessionSearchResult[]> {
  const primaryResults = await searchSessionEvents(
    sessionsDir,
    pattern,
    options,
  );

  const legacyDir = getLegacySessionsDir(specDir);
  if (!legacyDir) {
    return primaryResults;
  }

  // Get remaining limit after primary results
  const limit = options.limit ?? 50;
  const remaining = limit - primaryResults.length;
  if (remaining <= 0) {
    return primaryResults;
  }

  const legacyResults = await searchSessionEvents(legacyDir, pattern, {
    ...options,
    limit: remaining,
  });

  if (legacyResults.length === 0) {
    return primaryResults;
  }

  // Dedup by session ID — primary takes precedence
  const primarySessionIds = new Set(primaryResults.map((r) => r.session_id));
  const legacyOnly = legacyResults.filter(
    (r) => !primarySessionIds.has(r.session_id),
  );

  if (legacyOnly.length > 0) {
    emitLegacyDeprecationWarning();
    return [...primaryResults, ...legacyOnly];
  }

  return primaryResults;
}

/**
 * Compute tool usage stats across both primary and legacy sessions.
 *
 * Runs computeToolUsageStats against primary dir, then against legacy dir
 * for session IDs not found in primary. Merges results.
 */
export async function computeToolUsageStatsWithFallback(
  sessionsDir: string,
  sessionIds: string[],
  specDir?: string,
  limit?: number,
): Promise<ToolUsageStats[]> {
  const legacyDir = getLegacySessionsDir(specDir);
  if (!legacyDir) {
    return computeToolUsageStats(sessionsDir, sessionIds, limit);
  }

  // Partition session IDs: which exist in primary vs which need legacy
  const primaryIds: string[] = [];
  const legacyIds: string[] = [];
  const primarySet = new Set(await listSessions(sessionsDir));

  for (const id of sessionIds) {
    if (primarySet.has(id)) {
      primaryIds.push(id);
    } else {
      legacyIds.push(id);
    }
  }

  if (legacyIds.length === 0) {
    return computeToolUsageStats(sessionsDir, sessionIds, limit);
  }

  // Get stats from both locations and merge
  const [primaryStats, legacyStats] = await Promise.all([
    computeToolUsageStats(sessionsDir, primaryIds, 0), // no limit, merge later
    computeToolUsageStats(legacyDir, legacyIds, 0),
  ]);

  // Merge by tool name
  const merged = new Map<string, number>();
  let total = 0;
  for (const s of [...primaryStats, ...legacyStats]) {
    const prev = merged.get(s.tool_name) ?? 0;
    merged.set(s.tool_name, prev + s.count);
    total += s.count;
  }

  const effectiveLimit = limit ?? 10;
  return Array.from(merged.entries())
    .map(([tool_name, count]) => ({
      tool_name,
      count,
      percentage: total > 0 ? Math.round((count / total) * 100 * 10) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, effectiveLimit);
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
