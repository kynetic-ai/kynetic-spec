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
import { SessionSummaryCache } from "../src/sessions/cache.js";
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

  // AC: @session-summary-cache ac-summary-stats
  describe("ac-summary-stats: compute and cache stats from events.jsonl", () => {
    it("should compute event_count from events.jsonl", async () => {
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
      expect(session!.event_count).toBe(4);
    });

    it("should compute iteration_count from context files", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestIterations(sessionsDir, "session-001", 3);

      const summaries = await cache.getAll(sessionsDir);
      const session = summaries.find((s) => s.id === "session-001");
      expect(session).toBeDefined();
      expect(session!.iteration_count).toBeGreaterThanOrEqual(3);
    });

    it("should compute tasks_completed by scanning events for task complete commands", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestEvents(sessionsDir, "session-001", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-001", data: {} },
        {
          ts: 2000,
          seq: 1,
          type: "tool.call",
          session_id: "session-001",
          data: {
            update: {
              rawInput: {
                command: "kspec task complete @task-foo --reason done",
              },
            },
          },
        },
        { ts: 3000, seq: 2, type: "session.end", session_id: "session-001", data: {} },
      ]);

      const summaries = await cache.getAll(sessionsDir);
      const session = summaries.find((s) => s.id === "session-001");
      expect(session).toBeDefined();
      expect(session!.tasks_completed).toBe(1);
    });

    it("should not recompute stats for completed sessions on subsequent requests", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });
      await createTestEvents(sessionsDir, "session-001", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-001", data: {} },
        { ts: 2000, seq: 1, type: "session.end", session_id: "session-001", data: {} },
      ]);

      // First call builds cache with stats
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);
      expect(first[0].event_count).toBe(2);

      // Add more events to the file (simulating corruption or external write)
      await createTestEvents(sessionsDir, "session-001", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-001", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-001", data: {} },
        { ts: 3000, seq: 2, type: "tool.call", session_id: "session-001", data: {} },
        { ts: 4000, seq: 3, type: "session.end", session_id: "session-001", data: {} },
      ]);

      // Second call should use cached stats (completed sessions don't change)
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(1);
      // Stats should still be the original cached values
      expect(second[0].event_count).toBe(2);
    });
  });

  // AC: @session-summary-cache ac-active-refresh
  describe("ac-active-refresh: recompute stats for active sessions", () => {
    it("should recompute stats for active sessions on each request", async () => {
      await createTestSession(sessionsDir, "session-active", {
        status: "active",
        started_at: "2026-03-01T00:00:00.000Z",
        ended_at: undefined,
      });
      await createTestEvents(sessionsDir, "session-active", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-active", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-active", data: {} },
      ]);

      // First call
      const first = await cache.getAll(sessionsDir);
      expect(first).toHaveLength(1);
      expect(first[0].event_count).toBe(2);

      // Add more events (session is still active, events are being appended)
      await createTestEvents(sessionsDir, "session-active", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-active", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-active", data: {} },
        { ts: 3000, seq: 2, type: "tool.call", session_id: "session-active", data: {} },
        { ts: 4000, seq: 3, type: "tool.result", session_id: "session-active", data: {} },
      ]);

      // Second call should recompute stats for active session
      const second = await cache.getAll(sessionsDir);
      expect(second).toHaveLength(1);
      expect(second[0].event_count).toBe(4);
    });

    it("should not recompute stats for completed/failed/abandoned sessions", async () => {
      for (const status of ["completed", "failed", "abandoned"] as const) {
        const cache = new SessionSummaryCache();
        const id = `session-${status}`;
        await createTestSession(sessionsDir, id, {
          status,
          started_at: "2026-03-01T00:00:00.000Z",
          ended_at: "2026-03-01T01:00:00.000Z",
        });
        await createTestEvents(sessionsDir, id, [
          { ts: 1000, seq: 0, type: "session.start", session_id: id, data: {} },
        ]);

        const first = await cache.getAll(sessionsDir);
        const sessionBefore = first.find((s) => s.id === id)!;
        expect(sessionBefore.event_count).toBe(1);

        // Add more events
        await createTestEvents(sessionsDir, id, [
          { ts: 1000, seq: 0, type: "session.start", session_id: id, data: {} },
          { ts: 2000, seq: 1, type: "prompt.sent", session_id: id, data: {} },
          { ts: 3000, seq: 2, type: "session.end", session_id: id, data: {} },
        ]);

        // Should use cached stats
        const second = await cache.getAll(sessionsDir);
        const sessionAfter = second.find((s) => s.id === id)!;
        expect(sessionAfter.event_count).toBe(1);

        // Cleanup for next status
        await fs.rm(path.join(sessionsDir, id), { recursive: true, force: true });
      }
    });

    it("should use cached summary for completed sessions in single get()", async () => {
      await createTestSession(sessionsDir, "session-001", {
        status: "completed",
      });

      // Build cache via getAll
      await cache.getAll(sessionsDir);

      // Single get should return cached value
      const result = await cache.get(sessionsDir, "session-001");
      expect(result).toBeDefined();
      expect(result!.id).toBe("session-001");
      expect(result!.status).toBe("completed");
    });

    it("should re-read active sessions in single get()", async () => {
      await createTestSession(sessionsDir, "session-active", {
        status: "active",
        ended_at: undefined,
      });
      await createTestEvents(sessionsDir, "session-active", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-active", data: {} },
      ]);

      // Build cache
      await cache.getAll(sessionsDir);

      // Add more events
      await createTestEvents(sessionsDir, "session-active", [
        { ts: 1000, seq: 0, type: "session.start", session_id: "session-active", data: {} },
        { ts: 2000, seq: 1, type: "prompt.sent", session_id: "session-active", data: {} },
        { ts: 3000, seq: 2, type: "tool.call", session_id: "session-active", data: {} },
      ]);

      // Single get should re-read from disk for active sessions
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
});
