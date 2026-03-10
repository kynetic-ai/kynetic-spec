/**
 * Session summary cache.
 *
 * In-memory cache for session metadata and summary stats.
 * Avoids reading 700+ session.yaml files and scanning events.jsonl on every list request.
 *
 * AC Coverage:
 * - @session-summary-cache ac-cache-build: Build cache on first request
 * - @session-summary-cache ac-cache-invalidate: Detect changes via directory listing diff
 * - @session-summary-cache ac-cache-graceful: Skip corrupt/missing entries with warning
 * - @session-summary-cache ac-summary-stats: Compute and cache summary stats from events.jsonl
 * - @session-summary-cache ac-active-refresh: Recompute stats for active sessions on each request
 */

import * as fsPromises from "node:fs/promises";
import { type SessionLogSummary, getSessionLogSummary } from "./store.js";

/**
 * Cached entry: session summary plus the session's status for active-refresh logic.
 */
interface CacheEntry {
  summary: SessionLogSummary;
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
   * Get a single session summary, using cache when possible.
   * Falls back to disk read if not cached.
   */
  async get(
    sessionsDir: string,
    sessionId: string,
  ): Promise<SessionLogSummary | null> {
    const cached = this.entries.get(sessionId);
    if (cached && cached.summary.status !== "active") {
      return cached.summary;
    }

    // Not cached or active — read from disk and update cache
    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    if (summary) {
      this.entries.set(sessionId, { summary });
    }
    return summary;
  }

  /**
   * Invalidate a specific session's cache entry.
   * Next access will re-read from disk.
   */
  invalidate(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /**
   * Clear the entire cache. Next getAll() will rebuild from disk.
   */
  clear(): void {
    this.entries.clear();
    this.knownSessionIds.clear();
    this.initialized = false;
    this.buildPromise = null;
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

    // Read all sessions in parallel
    const results = await Promise.all(
      sessionIds.map(async (id) => {
        // AC: @session-summary-cache ac-cache-graceful
        try {
          const summary = await getSessionLogSummary(sessionsDir, id);
          return { id, summary };
        } catch (err) {
          console.warn(
            `[session-cache] Skipping session ${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { id, summary: null };
        }
      }),
    );

    this.entries.clear();
    for (const { id, summary } of results) {
      if (summary) {
        this.entries.set(id, { summary });
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

    // Remove deleted sessions from cache
    for (const id of removedIds) {
      this.entries.delete(id);
    }

    // Fetch new + active sessions in parallel
    const idsToRefresh = [...new Set([...newIds, ...activeIds])];
    if (idsToRefresh.length > 0) {
      const results = await Promise.all(
        idsToRefresh.map(async (id) => {
          // AC: @session-summary-cache ac-cache-graceful
          try {
            const summary = await getSessionLogSummary(sessionsDir, id);
            return { id, summary };
          } catch (err) {
            console.warn(
              `[session-cache] Skipping session ${id}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { id, summary: null };
          }
        }),
      );

      for (const { id, summary } of results) {
        if (summary) {
          this.entries.set(id, { summary });
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
   */
  private summaries(): SessionLogSummary[] {
    return [...this.entries.values()].map((e) => e.summary);
  }
}
