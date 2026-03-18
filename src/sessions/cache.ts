/**
 * Session summary cache.
 *
 * In-memory cache for session metadata. Reads only session.yaml files —
 * never reads events.jsonl. Summary stats for closed sessions come from
 * persisted metadata fields. Active sessions get live event counts from
 * an in-memory counter incremented on each event append.
 *
 * AC Coverage:
 * - @session-summary-cache ac-cache-build: Build cache on first request
 * - @session-summary-cache ac-cache-invalidate: Detect changes via directory listing diff
 * - @session-summary-cache ac-cache-graceful: Skip corrupt/missing entries with warning
 * - @session-list-pagination-api ac-metadata-only: List path reads only session.yaml
 * - @session-summary-cache ac-active-refresh: Re-read metadata for active sessions on each request
 * - @session-summary-cache ac-persist-on-close: Closed sessions read persisted stats from metadata
 * - @session-summary-cache ac-live-counter: Active sessions serve event_count from in-memory counter
 */

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import {
  type SessionLogSummary,
  getSessionLogSummary,
  getSessionMetadataOnly,
} from "./store.js";

/**
 * Cached entry: session summary plus mtime for change detection.
 */
interface CacheEntry {
  summary: SessionLogSummary;
  /** mtime of session.yaml when this entry was cached, for invalidation */
  mtimeMs: number;
}

/**
 * In-memory cache for session summaries.
 *
 * Usage:
 *   const cache = new SessionSummaryCache();
 *   const summaries = await cache.getAll(sessionsDir);
 */
export class SessionSummaryCache {
  /** Cached summaries keyed by session ID */
  private entries = new Map<string, CacheEntry>();

  /** Set of session IDs from last directory listing, used for invalidation */
  private knownSessionIds = new Set<string>();

  /** Whether the cache has been populated at least once */
  private initialized = false;

  /** In-flight promise for cache build to prevent concurrent builds */
  private buildPromise: Promise<void> | null = null;

  /**
   * Live event counters for active sessions.
   * Incremented on each event append, served as event_count for active sessions.
   * Discarded when a session closes (persisted value takes over).
   * AC: @session-summary-cache ac-live-counter
   */
  private liveEventCounts = new Map<string, number>();

  /**
   * Get all session summaries, using cache when possible.
   *
   * AC: @session-summary-cache ac-cache-build — First call builds cache from disk.
   * AC: @session-summary-cache ac-cache-invalidate — Subsequent calls diff directory listing.
   * AC: @session-summary-cache ac-active-refresh — Active sessions get stats recomputed.
   */
  async getAll(sessionsDir: string): Promise<SessionLogSummary[]> {
    if (!this.initialized) {
      await this.build(sessionsDir);
      return this.summaries();
    }

    await this.refresh(sessionsDir);
    return this.summaries();
  }

  /**
   * Get a single session's full summary, including stats from events.jsonl.
   * Always computes fresh stats (not metadata-only) for detail views.
   */
  async get(
    sessionsDir: string,
    sessionId: string,
  ): Promise<SessionLogSummary | null> {
    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    return summary;
  }

  /**
   * Invalidate a specific session's cache entry.
   * Next access will re-read from disk.
   */
  invalidate(sessionId: string): void {
    this.entries.delete(sessionId);
    this.knownSessionIds.delete(sessionId);
    this.liveEventCounts.delete(sessionId);
  }

  /**
   * Clear the entire cache. Next getAll() will rebuild from disk.
   */
  clear(): void {
    this.entries.clear();
    this.knownSessionIds.clear();
    this.initialized = false;
    this.buildPromise = null;
    this.liveEventCounts.clear();
  }

  /**
   * Increment the live event counter for an active session.
   * Called when an event is appended to events.jsonl during a running invocation.
   * AC: @session-summary-cache ac-live-counter
   */
  incrementEventCount(sessionId: string): void {
    const current = this.liveEventCounts.get(sessionId) ?? 0;
    this.liveEventCounts.set(sessionId, current + 1);
  }

  /**
   * Discard the live event counter for a session.
   * Called when a session closes — the persisted stats in session.yaml take over.
   * AC: @session-summary-cache ac-live-counter
   */
  discardLiveCounter(sessionId: string): void {
    this.liveEventCounts.delete(sessionId);
  }

  /**
   * Get the current live event count for a session (for testing/inspection).
   */
  getLiveEventCount(sessionId: string): number {
    return this.liveEventCounts.get(sessionId) ?? 0;
  }

  /**
   * Build the cache from scratch by reading all session directories.
   *
   * AC: @session-summary-cache ac-cache-build — Reads all session.yaml files.
   * AC: @session-summary-cache ac-cache-graceful — Skips corrupt/missing entries.
   *
   * Uses in-flight promise dedup to prevent concurrent builds.
   */
  private async build(sessionsDir: string): Promise<void> {
    if (this.buildPromise) {
      return this.buildPromise;
    }

    this.buildPromise = this.doBuild(sessionsDir);
    try {
      await this.buildPromise;
    } finally {
      this.buildPromise = null;
    }
  }

  private async doBuild(sessionsDir: string): Promise<void> {
    const sessionIds = await this.listSessionDirs(sessionsDir);
    this.knownSessionIds = new Set(sessionIds);

    // AC: @session-list-pagination-api ac-metadata-only — Read only session.yaml, not events.jsonl
    const results = await Promise.all(
      sessionIds.map(async (id) => {
        // AC: @session-summary-cache ac-cache-graceful
        try {
          const summary = await getSessionMetadataOnly(sessionsDir, id);
          const mtimeMs = await this.getMetadataMtime(sessionsDir, id);
          return { id, summary, mtimeMs };
        } catch (err) {
          console.warn(
            `[session-cache] Skipping session ${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { id, summary: null, mtimeMs: 0 };
        }
      }),
    );

    this.entries.clear();
    for (const { id, summary, mtimeMs } of results) {
      if (summary) {
        this.entries.set(id, { summary, mtimeMs });
      }
    }

    this.initialized = true;
  }

  /**
   * Refresh the cache by detecting changes since last build.
   *
   * AC: @session-summary-cache ac-cache-invalidate — Detects new/removed sessions
   *     via directory listing diff and updates only affected entries.
   * AC: @session-summary-cache ac-active-refresh — Recomputes stats for active sessions.
   */
  private async refresh(sessionsDir: string): Promise<void> {
    const currentIds = await this.listSessionDirs(sessionsDir);
    const currentSet = new Set(currentIds);

    // Find new sessions (in current listing but not in cache)
    const newIds = currentIds.filter((id) => !this.knownSessionIds.has(id));

    // Find removed sessions (in cache but not in current listing)
    const removedIds = [...this.knownSessionIds].filter(
      (id) => !currentSet.has(id),
    );

    // Find active sessions that need stats refresh
    // AC: @session-summary-cache ac-active-refresh
    const activeIds = [...this.entries.values()]
      .filter((entry) => entry.summary.status === "active")
      .map((entry) => entry.summary.id);

    // AC: @session-summary-cache ac-cache-invalidate — Detect in-place session.yaml changes
    // Check mtime of session.yaml for all existing non-active cached sessions
    const mtimeChangedIds: string[] = [];
    const existingNonActiveIds = [...this.entries.entries()]
      .filter(([, entry]) => entry.summary.status !== "active")
      .map(([id]) => id)
      .filter((id) => currentSet.has(id)); // still exists on disk

    if (existingNonActiveIds.length > 0) {
      const mtimeChecks = await Promise.all(
        existingNonActiveIds.map(async (id) => {
          const currentMtime = await this.getMetadataMtime(sessionsDir, id);
          const cached = this.entries.get(id);
          return { id, changed: cached != null && currentMtime !== cached.mtimeMs };
        }),
      );
      for (const { id, changed } of mtimeChecks) {
        if (changed) {
          mtimeChangedIds.push(id);
        }
      }
    }

    // Remove deleted sessions from cache
    for (const id of removedIds) {
      this.entries.delete(id);
    }

    // AC: @session-list-pagination-api ac-metadata-only — Read only session.yaml, not events.jsonl
    const idsToRefresh = [...new Set([...newIds, ...activeIds, ...mtimeChangedIds])];
    if (idsToRefresh.length > 0) {
      const results = await Promise.all(
        idsToRefresh.map(async (id) => {
          // AC: @session-summary-cache ac-cache-graceful
          try {
            const summary = await getSessionMetadataOnly(sessionsDir, id);
            const mtimeMs = await this.getMetadataMtime(sessionsDir, id);
            return { id, summary, mtimeMs };
          } catch (err) {
            console.warn(
              `[session-cache] Skipping session ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { id, summary: null, mtimeMs: 0 };
          }
        }),
      );

      for (const { id, summary, mtimeMs } of results) {
        if (summary) {
          this.entries.set(id, { summary, mtimeMs });
        } else {
          // Remove from cache if it was there (e.g., active session that became unreadable)
          this.entries.delete(id);
        }
      }
    }

    // Update known session IDs
    this.knownSessionIds = currentSet;
  }

  /**
   * Get mtime of session.yaml for change detection.
   * Returns 0 if the file doesn't exist.
   */
  private async getMetadataMtime(
    sessionsDir: string,
    sessionId: string,
  ): Promise<number> {
    try {
      const metadataPath = path.join(sessionsDir, sessionId, "session.yaml");
      const stat = await fsPromises.stat(metadataPath);
      return stat.mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * List session directories (same logic as listSessions in store.ts).
   */
  private async listSessionDirs(sessionsDir: string): Promise<string[]> {
    try {
      const entries = await fsPromises.readdir(sessionsDir, {
        withFileTypes: true,
      });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Return all cached summaries as an array.
   * AC: @session-summary-cache ac-live-counter — Active sessions get event_count
   * from the in-memory live counter instead of the (stale) metadata value.
   */
  private summaries(): SessionLogSummary[] {
    return [...this.entries.values()].map((e) => {
      const liveCount = this.liveEventCounts.get(e.summary.id);
      if (e.summary.status === "active" && liveCount !== undefined) {
        return { ...e.summary, event_count: liveCount };
      }
      return e.summary;
    });
  }
}

/**
 * Per-sessionsDir cache registry.
 *
 * The daemon is multi-project: each request can target a different project root,
 * each with its own sessionsDir. This registry ensures cache instances are scoped
 * per sessionsDir to prevent cross-project session bleed.
 */
const cacheRegistry = new Map<string, SessionSummaryCache>();

/**
 * Get (or create) a SessionSummaryCache scoped to a specific sessionsDir.
 * Ensures multi-project daemon requests don't share cached session data.
 */
export function getSessionCache(sessionsDir: string): SessionSummaryCache {
  let cache = cacheRegistry.get(sessionsDir);
  if (!cache) {
    cache = new SessionSummaryCache();
    cacheRegistry.set(sessionsDir, cache);
  }
  return cache;
}
