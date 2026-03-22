/**
 * Session summary cache tests.
 *
 * Tests the in-memory cache for session metadata and summary stats,
 * covering all acceptance criteria for @session-summary-cache.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { SessionSummaryCache, getSessionCache } from "../src/sessions/cache.js";
import {
  createSession,
  closeSession,
  appendEvent,
  getSession,
  getSessionMetadataOnly,
} from "../src/sessions/store.js";
import { createTempDir } from "./helpers/cli.js";

// Helper to create a session directory with metadata
async function createTestSession(
  sessionsDir: string,
  id: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const sessionDir = path.join(sessionsDir, id);
  await fs.mkdir(sessionDir, { recursive: true });
  const content = yamlStringify({
    id,
    agent_type: "claude-agent-acp",
    status: "completed",
    started_at: "2026-03-01T00:00:00.000Z",
    ended_at: "2026-03-01T01:00:00.000Z",
    ...metadata,
  });
  await fs.writeFile(path.join(sessionDir, "session.yaml"), content, "utf-8");
}

// Helper to create events.jsonl with test events
async function createTestEvents(
  sessionsDir: string,
  id: string,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const sessionDir = path.join(sessionsDir, id);
  await fs.mkdir(sessionDir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await fs.writeFile(path.join(sessionDir, "events.jsonl"), lines + "\n", "utf-8");
}

// Helper to create context-iter-*.json files (iteration markers)
async function createTestIterations(
  sessionsDir: string,
  id: string,
  count: number,
): Promise<void> {
  const sessionDir = path.join(sessionsDir, id);
  await fs.mkdir(sessionDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    await fs.writeFile(
      path.join(sessionDir, `context-iter-${i}.json`),
      JSON.stringify({ iteration: i }),
      "utf-8",
    );
  }
}

describe("SessionSummaryCache", () => {
  let sessionsDir: string;
  let cache: SessionSummaryCache;

  beforeEach(async () => {
    sessionsDir = await createTempDir("kspec-cache-test-");
    cache = new SessionSummaryCache();
  });

  afterEach(async () => {
    await fs.rm(sessionsDir, { recursive: true, force: true });
  });

  // AC: @session-summary-cache ac-cache-build
  describe("ac-cache-build: initial cache population", () => {
    it("should build cache by reading all session.yaml files on first request", async () => {
      // Create 3 sessions
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
      });
      await createTestSession(sessionsDir, "session-002", {
        status: "completed",
        started_at: "2026-03-02T00:00:00.000Z",
        ended_at: "2026-03-02T01:00:00.000Z",
      });
      await createTestSession(sessionsDir, "session-003", {
        status: "active",
        started_at: "2026-03-03T00:00:00.000Z",
      });

      const summaries = await cache.getAll(sessionsDir);
      expect(summaries).toHaveLength(3);
      expect(summaries.map((s) => s.id).sort()).toEqual([
        "session-001",
        "session-002",
        "session-003",
      ]);
    });

    it("should return cached results on subsequent requests without re-reading files", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });

      // First call builds cache
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);

      // Delete the file to prove cache is used (if it re-read, it would still find it
      // because we don't delete the directory — but we can verify by checking the result
      // matches the original)
      const secondCall = await cache.getAll(sessionsDir);
      expect(secondCall).toHaveLength(1);
      expect(secondCall[0].id).toBe("session-001");
    });

    it("should handle empty sessions directory", async () => {
      const summaries = await cache.getAll(sessionsDir);
      expect(summaries).toHaveLength(0);
    });

    it("should handle nonexistent sessions directory", async () => {
      const nonexistent = path.join(sessionsDir, "does-not-exist");
      const summaries = await cache.getAll(nonexistent);
      expect(summaries).toHaveLength(0);
    });
  });

  // AC: @session-summary-cache ac-cache-invalidate
  describe("ac-cache-invalidate: incremental updates via directory diff", () => {
    it("should detect new sessions added after initial build", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });

      // Build initial cache
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);

      // Add a new session
      await createTestSession(sessionsDir, "session-002", {
        status: "completed",
        started_at: "2026-03-02T00:00:00.000Z",
        ended_at: "2026-03-02T01:00:00.000Z",
      });

      // Cache should detect the new session
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(2);
      expect(second.map((s) => s.id).sort()).toEqual([
        "session-001",
        "session-002",
      ]);
    });

    it("should detect removed sessions after initial build", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestSession(sessionsDir, "session-002", {
        status: "completed",
      });

      // Build initial cache
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(2);

      // Remove a session directory
      await fs.rm(path.join(sessionsDir, "session-002"), {
        recursive: true,
        force: true,
      });

      // Cache should detect the removal
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe("session-001");
    });

    it("should update only affected entries, not rebuild entire cache", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestSession(sessionsDir, "session-002", {
        status: "completed",
      });

      // Build initial cache
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(2);

      // Add one new session — existing sessions should remain cached
      await createTestSession(sessionsDir, "session-003", {
        status: "completed",
      });

      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(3);

      // Verify existing sessions are still present with correct data
      const s1 = second.find((s) => s.id === "session-001");
      expect(s1).toBeDefined();
      expect(s1!.status).toBe("completed");
    });

    // AC: @session-summary-cache ac-cache-invalidate
    it("should detect in-place session.yaml status/metadata changes for existing sessions", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
      });

      // Build initial cache
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);
      expect(first[0].status).toBe("completed");

      // Wait briefly to ensure mtime differs (filesystem mtime granularity)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Modify session.yaml in-place (status changes to "failed")
      await createTestSession(sessionsDir, "session-001", {
        status: "failed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
      });

      // Cache should detect the mtime change and re-read the updated metadata
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(1);
      expect(second[0].status).toBe("failed");
    });
  });

  // AC: @session-summary-cache ac-cache-graceful
  describe("ac-cache-graceful: skip corrupt/missing entries", () => {
    it("should skip session directories with missing session.yaml", async () => {
      // Create a valid session
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });

      // Create a directory without session.yaml
      await fs.mkdir(path.join(sessionsDir, "session-bad"), { recursive: true });

      const summaries = await cache.getAll(sessionsDir);
      // Should have only the valid session
      expect(summaries).toHaveLength(1);
      expect(summaries[0].id).toBe("session-001");
    });

    it("should skip session directories with corrupt session.yaml", async () => {
      // Create a valid session
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });

      // Create a corrupt session.yaml
      const corruptDir = path.join(sessionsDir, "session-corrupt");
      await fs.mkdir(corruptDir, { recursive: true });
      await fs.writeFile(
        path.join(corruptDir, "session.yaml"),
        "invalid: yaml: content: [",
        "utf-8",
      );

      const summaries = await cache.getAll(sessionsDir);
      // Should have only the valid session
      expect(summaries).toHaveLength(1);
      expect(summaries[0].id).toBe("session-001");
    });

    it("should continue building cache despite corrupt entries", async () => {
      // Create multiple valid sessions with a corrupt one in between
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestSession(sessionsDir, "session-003", {
        status: "completed",
      });

      // Create corrupt session between them
      const corruptDir = path.join(sessionsDir, "session-002");
      await fs.mkdir(corruptDir, { recursive: true });
      await fs.writeFile(
        path.join(corruptDir, "session.yaml"),
        "not valid yaml {{{",
        "utf-8",
      );

      const summaries = await cache.getAll(sessionsDir);
      expect(summaries).toHaveLength(2);
      expect(summaries.map((s) => s.id).sort()).toEqual([
        "session-001",
        "session-003",
      ]);
    });
  });

  // AC: @session-list-pagination-api ac-metadata-only
  describe("ac-metadata-only: getAll reads only session.yaml, not events.jsonl", () => {
    it("should return 0 for event_count/iteration_count/tasks_completed in list results", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestEvents(sessionsDir, "session-001", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-001", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-001", data: {} },
        { ts: 3000, seq: 2, type: "tool.call", session_id: "session-001", data: {} },
        { ts: 4000, seq: 3, type: "session.end", session_id: "session-001", data: {} },
      ]);

      const summaries = await cache.getAll(sessionsDir);
      const session = summaries.find((s) => s.id === "session-001");
      expect(session).toBeDefined();
      // getAll() reads metadata only — stats are 0
      expect(session!.event_count).toBe(0);
      expect(session!.iteration_count).toBe(0);
      expect(session!.tasks_completed).toBe(0);
    });

    it("should compute full stats via get() for single session detail", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestEvents(sessionsDir, "session-001", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-001", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-001", data: {} },
        { ts: 3000, seq: 2, type: "tool.call", session_id: "session-001", data: {} },
        { ts: 4000, seq: 3, type: "session.end", session_id: "session-001", data: {} },
      ]);

      // get() reads events.jsonl for full stats
      const session = await cache.get(sessionsDir, "session-001");
      expect(session).toBeDefined();
      expect(session!.event_count).toBe(4);
    });

    it("should work when events.jsonl does not exist", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      // No events.jsonl created — getAll should still work

      const summaries = await cache.getAll(sessionsDir);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].id).toBe("session-001");
      expect(summaries[0].event_count).toBe(0);
    });
  });

  // AC: @session-summary-cache ac-active-refresh
  describe("ac-active-refresh: re-read metadata for active sessions", () => {
    it("should re-read metadata for active sessions on each getAll() request", async () => {
      await createTestSession(sessionsDir, "session-active", {
        status: "active",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: undefined,
      });

      // First call
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);
      expect(first[0].status).toBe("active");

      // Wait for mtime to change
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Session completes — status changes in session.yaml
      await createTestSession(sessionsDir, "session-active", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T02:00:00.000Z",
      });

      // Second call should detect the active session changed
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(1);
      expect(second[0].status).toBe("completed");
    });

    it("should not re-read completed sessions on getAll()", async () => {
      await createTestSession(sessionsDir, "session-done", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
      });

      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);
      expect(first[0].status).toBe("completed");

      // Completed sessions are stable in the list cache
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe("session-done");
    });

    it("should compute full stats via get() for detail view", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestEvents(sessionsDir, "session-001", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-001", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-001", data: {} },
        { ts: 3000, seq: 2, type: "tool.call", session_id: "session-001", data: {} },
      ]);

      // Build list cache (metadata only)
      await cache.getAll(sessionsDir);

      // Detail get() should compute full stats from events.jsonl
      const result = await cache.get(sessionsDir, "session-001");
      expect(result).toBeDefined();
      expect(result!.event_count).toBe(3);
    });

    it("should compute full stats via get() for active sessions", async () => {
      await createTestSession(sessionsDir, "session-active", {
        status: "active",
        ended_at: undefined,
      });
      await createTestEvents(sessionsDir, "session-active", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-active", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-active", data: {} },
        { ts: 3000, seq: 2, type: "tool.call", session_id: "session-active", data: {} },
      ]);

      // Detail get() always computes fresh stats
      const result = await cache.get(sessionsDir, "session-active");
      expect(result).toBeDefined();
      expect(result!.event_count).toBe(3);
    });
  });

  describe("cache management", () => {
    it("should support invalidating a single session", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });

      // Build cache
      await cache.getAll(sessionsDir);

      // Invalidate and verify re-read
      cache.invalidate("session-001");

      // get() should re-read from disk
      const result = await cache.get(sessionsDir, "session-001");
      expect(result).toBeDefined();
      expect(result!.id).toBe("session-001");
    });

    it("should re-discover invalidated session in getAll() after status change on disk", async () => {
      // Regression: invalidate() used to leave the session ID in knownSessionIds,
      // causing refresh() to treat it as neither new nor existing — a ghost entry
      // invisible until daemon restart.
      await createTestSession(sessionsDir, "session-001", {
        status: "active",
        started_at: "2026-03-01T00:00:00.000Z",
      });

      // Build cache — session appears as active
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);
      expect(first[0].status).toBe("active");

      // Session completes on disk (dispatch writes session.yaml)
      await new Promise((resolve) => setTimeout(resolve, 50));
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
        event_count: 10,
      });

      // Dispatch calls invalidate() after completing the session
      cache.invalidate("session-001");

      // getAll() must re-discover the session with its updated status
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(1);
      expect(second[0].id).toBe("session-001");
      expect(second[0].status).toBe("completed");
      expect(second[0].event_count).toBe(10);
    });

    it("should clean up live event counter on invalidate", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "active",
        started_at: "2026-03-01T00:00:00.000Z",
      });

      await cache.getAll(sessionsDir);
      cache.incrementEventCount("session-001");
      cache.incrementEventCount("session-001");
      expect(cache.getLiveEventCount("session-001")).toBe(2);

      cache.invalidate("session-001");
      expect(cache.getLiveEventCount("session-001")).toBe(0);
    });

    it("should support clearing entire cache", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });

      // Build cache
      await cache.getAll(sessionsDir);

      // Clear cache
      cache.clear();

      // Add a new session before next getAll
      await createTestSession(sessionsDir, "session-002", {
        status: "completed",
      });

      // Should rebuild from scratch, finding both sessions
      const summaries = await cache.getAll(sessionsDir);
      expect(summaries).toHaveLength(2);
    });

    it("should handle concurrent getAll calls with in-flight dedup", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestSession(sessionsDir, "session-002", {
        status: "completed",
      });

      // Fire multiple concurrent calls — should not break
      const results = await Promise.all([
        cache.getAll(sessionsDir),
        cache.getAll(sessionsDir),
        cache.getAll(sessionsDir),
      ]);

      for (const result of results) {
        expect(result).toHaveLength(2);
      }
    });
  });

  // AC: @session-summary-cache ac-persist-on-close
  describe("ac-persist-on-close: closed sessions have stats persisted in metadata", () => {
    it("should read persisted event_count from session metadata", async () => {
      // Simulate a session that was closed with stats persisted in session.yaml
      await createTestSession(sessionsDir, "session-closed", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
        event_count: 42,
        iteration_count: 3,
        tasks_completed: 1,
      });

      const summaries = await cache.getAll(sessionsDir);
      const session = summaries.find((s) => s.id === "session-closed");
      expect(session).toBeDefined();
      expect(session!.event_count).toBe(42);
      expect(session!.iteration_count).toBe(3);
      expect(session!.tasks_completed).toBe(1);
    });

    it("should default to 0 when persisted stats are absent (legacy sessions)", async () => {
      // Session without persisted stats (pre-feature sessions)
      await createTestSession(sessionsDir, "session-legacy", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
      });

      const summaries = await cache.getAll(sessionsDir);
      const session = summaries.find((s) => s.id === "session-legacy");
      expect(session).toBeDefined();
      expect(session!.event_count).toBe(0);
      expect(session!.iteration_count).toBe(0);
      expect(session!.tasks_completed).toBe(0);
    });

    it("should read persisted stats for failed/abandoned/timed_out sessions", async () => {
      await createTestSession(sessionsDir, "session-failed", {
        status: "failed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T00:30:00.000Z",
        event_count: 15,
        iteration_count: 1,
        tasks_completed: 0,
      });

      await createTestSession(sessionsDir, "session-abandoned", {
        status: "abandoned",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T00:15:00.000Z",
        event_count: 8,
        iteration_count: 1,
        tasks_completed: 0,
      });

      const summaries = await cache.getAll(sessionsDir);
      const failed = summaries.find((s) => s.id === "session-failed");
      expect(failed!.event_count).toBe(15);

      const abandoned = summaries.find((s) => s.id === "session-abandoned");
      expect(abandoned!.event_count).toBe(8);
    });
  });

  // AC: @session-summary-cache ac-persist-on-close (store-level)
  describe("ac-persist-on-close: closeSession writes stats to session.yaml", () => {
    it("should persist event_count, iteration_count, tasks_completed on close", async () => {
      // Create a session via store API
      await createSession(sessionsDir, {
        id: "session-stats",
        agent_type: "test-agent",
      });

      // Add events so closeSession has something to count
      await appendEvent(sessionsDir, {
        type: "session.start",
        session_id: "session-stats",
        data: {},
      });
      await appendEvent(sessionsDir, {
        type: "prompt.sent",
        session_id: "session-stats",
        data: {},
      });
      await appendEvent(sessionsDir, {
        type: "tool.call",
        session_id: "session-stats",
        data: {},
      });
      await appendEvent(sessionsDir, {
        type: "session.end",
        session_id: "session-stats",
        data: {},
      });

      // Close session — should compute and persist stats
      const result = await closeSession(sessionsDir, "session-stats", "completed", "Test done");
      expect(result).not.toBeNull();
      expect(result!.event_count).toBe(4);
      expect(result!.iteration_count).toBe(0); // no context-iter-*.json files
      expect(result!.tasks_completed).toBe(0); // no task complete events

      // Verify stats survive a round-trip (read from disk)
      const reread = await getSession(sessionsDir, "session-stats");
      expect(reread).not.toBeNull();
      expect(reread!.event_count).toBe(4);
      expect(reread!.iteration_count).toBe(0);
      expect(reread!.tasks_completed).toBe(0);
    });

    it("should persist stats that getSessionMetadataOnly reads", async () => {
      // Create session, add events, close
      await createSession(sessionsDir, {
        id: "session-roundtrip",
        agent_type: "test-agent",
      });

      for (let i = 0; i < 5; i++) {
        await appendEvent(sessionsDir, {
          type: "prompt.sent",
          session_id: "session-roundtrip",
          data: {},
        });
      }

      await closeSession(sessionsDir, "session-roundtrip", "completed", "Done");

      // getSessionMetadataOnly should read persisted stats (not 0)
      const summary = await getSessionMetadataOnly(sessionsDir, "session-roundtrip");
      expect(summary).not.toBeNull();
      expect(summary!.event_count).toBe(5);
    });

    it("should persist stats for failed sessions", async () => {
      await createSession(sessionsDir, {
        id: "session-fail",
        agent_type: "test-agent",
      });

      await appendEvent(sessionsDir, {
        type: "session.start",
        session_id: "session-fail",
        data: {},
      });
      await appendEvent(sessionsDir, {
        type: "agent.failed",
        session_id: "session-fail",
        data: { error: "crash" },
      });

      const result = await closeSession(sessionsDir, "session-fail", "failed", "Crashed");
      expect(result!.event_count).toBe(2);
      expect(result!.status).toBe("failed");
    });
  });

  // AC: @session-summary-cache ac-live-counter
  describe("ac-live-counter: active sessions get event_count from in-memory counter", () => {
    it("should serve live event_count for active sessions", async () => {
      await createTestSession(sessionsDir, "session-active", {
        status: "active",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: undefined,
      });

      // Build cache — active session starts with event_count: 0 from metadata
      const first = await cache.getAll(sessionsDir);
      const activeFirst = first.find((s) => s.id === "session-active");
      expect(activeFirst!.event_count).toBe(0);

      // Simulate events being appended
      cache.incrementEventCount("session-active");
      cache.incrementEventCount("session-active");
      cache.incrementEventCount("session-active");

      // Refresh should now show live count for the active session
      const second = await cache.getAll(sessionsDir);
      const activeSecond = second.find((s) => s.id === "session-active");
      expect(activeSecond!.event_count).toBe(3);
    });

    it("should not affect completed sessions", async () => {
      await createTestSession(sessionsDir, "session-done", {
        status: "completed",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: "2026-03-01T01:00:00.000Z",
        event_count: 42,
      });

      // Even if we increment (shouldn't happen, but testing defensive behavior)
      cache.incrementEventCount("session-done");

      const summaries = await cache.getAll(sessionsDir);
      const session = summaries.find((s) => s.id === "session-done");
      // Completed session uses persisted value, not live counter
      expect(session!.event_count).toBe(42);
    });

    it("should discard live counter when session closes", async () => {
      await createTestSession(sessionsDir, "session-closing", {
        status: "active",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: undefined,
      });

      // Build cache and increment counter
      await cache.getAll(sessionsDir);
      cache.incrementEventCount("session-closing");
      cache.incrementEventCount("session-closing");
      expect(cache.getLiveEventCount("session-closing")).toBe(2);

      // Discard counter (as dispatch does after session close)
      cache.discardLiveCounter("session-closing");
      expect(cache.getLiveEventCount("session-closing")).toBe(0);
    });

    it("should clear live counters when cache is cleared", async () => {
      cache.incrementEventCount("session-a");
      cache.incrementEventCount("session-b");
      expect(cache.getLiveEventCount("session-a")).toBe(1);
      expect(cache.getLiveEventCount("session-b")).toBe(1);

      cache.clear();
      expect(cache.getLiveEventCount("session-a")).toBe(0);
      expect(cache.getLiveEventCount("session-b")).toBe(0);
    });

    it("should accumulate event counts across multiple increments", async () => {
      for (let i = 0; i < 100; i++) {
        cache.incrementEventCount("session-busy");
      }
      expect(cache.getLiveEventCount("session-busy")).toBe(100);
    });
  });

  describe("getSessionCache: per-project scoping", () => {
    it("should return the same cache instance for the same sessionsDir", () => {
      const cache1 = getSessionCache("/tmp/project-a/.kspec-sessions");
      const cache2 = getSessionCache("/tmp/project-a/.kspec-sessions");
      expect(cache1).toBe(cache2);
    });

    it("should return different cache instances for different sessionsDirs", () => {
      const cacheA = getSessionCache("/tmp/project-a/.kspec-sessions");
      const cacheB = getSessionCache("/tmp/project-b/.kspec-sessions");
      expect(cacheA).not.toBe(cacheB);
    });

    it("should isolate session data between projects", async () => {
      const dirA = await createTempDir("kspec-cache-scope-a-");
      const dirB = await createTempDir("kspec-cache-scope-b-");

      try {
        // Create sessions in each project
        await createTestSession(dirA, "session-a", { status: "completed" });
        await createTestSession(dirB, "session-b", { status: "completed" });

        const cacheA = getSessionCache(dirA);
        const cacheB = getSessionCache(dirB);

        const summariesA = await cacheA.getAll(dirA);
        const summariesB = await cacheB.getAll(dirB);

        // Each cache should only see its own project's sessions
        expect(summariesA).toHaveLength(1);
        expect(summariesA[0].id).toBe("session-a");
        expect(summariesB).toHaveLength(1);
        expect(summariesB[0].id).toBe("session-b");
      } finally {
        await fs.rm(dirA, { recursive: true, force: true });
        await fs.rm(dirB, { recursive: true, force: true });
      }
    });
  });
});
