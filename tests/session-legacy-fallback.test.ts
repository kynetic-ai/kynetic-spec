/**
 * Tests for legacy session detection and warning.
 *
 * AC coverage:
 * - @session-legacy-migration ac-read-fallback: No transparent fallback — reads only from .kspec-sessions/
 * - @session-legacy-migration ac-no-write: Writes always go to .kspec-sessions/, never .kspec/sessions/
 * - @session-legacy-migration ac-list-merge: List returns only .kspec-sessions/ sessions; warns about legacy
 * - @session-legacy-migration ac-deprecation-warning: Deprecation warning emitted when legacy sessions detected
 * - @session-legacy-migration ac-migration-copy: Copies session dirs from .kspec/sessions/ to .kspec-sessions/
 * - @session-legacy-migration ac-migration-idempotent: Skips sessions that already exist in target
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as YAML from "yaml";
import {
  getLegacySessionsDir,
  hasLegacySessions,
  countLegacySessions,
  warnIfLegacySessions,
  migrateLegacySessions,
  emitLegacyDeprecationWarning,
  resetDeprecationWarning,
} from "../src/sessions/legacy.js";
import {
  createSession,
  appendEvent,
  getSession,
  listSessions,
} from "../src/sessions/store.js";

// ─── Test Helpers ────────────────────────────────────────────────────────────

let tempDir: string;
let primaryDir: string; // .kspec-sessions/
let specDir: string; // .kspec/ (shadow branch dir)
let legacyDir: string; // .kspec/sessions/ (legacy location)

async function createTempDirs(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-legacy-test-"));
  primaryDir = path.join(tempDir, ".kspec-sessions");
  specDir = path.join(tempDir, ".kspec");
  legacyDir = path.join(specDir, "sessions");
  await fs.mkdir(primaryDir, { recursive: true });
  await fs.mkdir(legacyDir, { recursive: true });
}

async function cleanupTempDir(): Promise<void> {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Create a session directory with metadata in the given location.
 */
async function createTestSession(
  dir: string,
  sessionId: string,
  agentType: string = "claude-code",
  status: string = "completed",
): Promise<void> {
  const sessionDir = path.join(dir, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const metadata = {
    id: sessionId,
    agent_type: agentType,
    status,
    started_at: "2026-03-01T00:00:00.000Z",
    ended_at: status !== "active" ? "2026-03-01T01:00:00.000Z" : undefined,
  };
  await fs.writeFile(
    path.join(sessionDir, "session.yaml"),
    YAML.stringify(metadata),
  );
}

/**
 * Create a session with events in the given location.
 */
async function createTestSessionWithEvents(
  dir: string,
  sessionId: string,
  events: Array<{ type: string; data?: unknown }>,
): Promise<void> {
  await createTestSession(dir, sessionId);
  const eventsPath = path.join(dir, sessionId, "events.jsonl");
  const lines = events.map((e, i) =>
    JSON.stringify({
      seq: i + 1,
      ts: Date.now() + i * 1000,
      type: e.type,
      session_id: sessionId,
      data: e.data ?? {},
    }),
  );
  await fs.writeFile(eventsPath, lines.join("\n") + "\n");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Legacy Session Detection and Warning", () => {
  beforeEach(async () => {
    await createTempDirs();
    resetDeprecationWarning();
  });

  afterEach(async () => {
    await cleanupTempDir();
    vi.restoreAllMocks();
  });

  // ─── Path Resolution ───────────────────────────────────────────────────────

  describe("getLegacySessionsDir", () => {
    it("returns .kspec/sessions/ path from specDir", () => {
      const result = getLegacySessionsDir("/project/.kspec");
      expect(result).toBe("/project/.kspec/sessions");
    });

    it("returns null when specDir is undefined", () => {
      const result = getLegacySessionsDir(undefined);
      expect(result).toBeNull();
    });
  });

  describe("hasLegacySessions", () => {
    it("returns true when legacy dir has session directories", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      expect(await hasLegacySessions(specDir)).toBe(true);
    });

    it("returns false when legacy dir is empty", async () => {
      expect(await hasLegacySessions(specDir)).toBe(false);
    });

    it("returns false when legacy dir does not exist", async () => {
      await fs.rm(legacyDir, { recursive: true, force: true });
      expect(await hasLegacySessions(specDir)).toBe(false);
    });

    it("returns false when specDir is undefined", async () => {
      expect(await hasLegacySessions(undefined)).toBe(false);
    });
  });

  describe("countLegacySessions", () => {
    it("returns count of session directories in legacy dir", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      await createTestSession(legacyDir, "01LEGACY02");
      await createTestSession(legacyDir, "01LEGACY03");
      expect(await countLegacySessions(specDir)).toBe(3);
    });

    it("returns 0 when legacy dir is empty", async () => {
      expect(await countLegacySessions(specDir)).toBe(0);
    });

    it("returns 0 when legacy dir does not exist", async () => {
      await fs.rm(legacyDir, { recursive: true, force: true });
      expect(await countLegacySessions(specDir)).toBe(0);
    });

    it("returns 0 when specDir is undefined", async () => {
      expect(await countLegacySessions(undefined)).toBe(0);
    });
  });

  // ─── ac-read-fallback ──────────────────────────────────────────────────────

  // AC: @session-legacy-migration ac-read-fallback
  describe("ac-read-fallback: no transparent fallback reads", () => {
    it("getSession returns null for session only in legacy location", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      const session = await getSession(primaryDir, "01LEGACY01");
      expect(session).toBeNull();
    });

    it("getSession returns session from primary location", async () => {
      await createTestSession(primaryDir, "01PRIMARY01");
      const session = await getSession(primaryDir, "01PRIMARY01");
      expect(session).not.toBeNull();
      expect(session!.id).toBe("01PRIMARY01");
    });

    it("listSessions does not include legacy-only sessions", async () => {
      await createTestSession(primaryDir, "01PRIMARY01");
      await createTestSession(legacyDir, "01LEGACY01");
      const ids = await listSessions(primaryDir);
      expect(ids).toContain("01PRIMARY01");
      expect(ids).not.toContain("01LEGACY01");
    });
  });

  // ─── ac-no-write ───────────────────────────────────────────────────────────

  // AC: @session-legacy-migration ac-no-write
  describe("ac-no-write: writes go to .kspec-sessions/ only", () => {
    it("createSession writes to primary, not legacy", async () => {
      await createSession(primaryDir, {
        id: "01NEWSESS01",
        agent_type: "claude-code",
        trigger: "manual",
      });

      // Verify written to primary
      const primaryExists = await fs
        .access(path.join(primaryDir, "01NEWSESS01", "session.yaml"))
        .then(() => true)
        .catch(() => false);
      expect(primaryExists).toBe(true);

      // Verify NOT written to legacy
      const legacyExists = await fs
        .access(path.join(legacyDir, "01NEWSESS01", "session.yaml"))
        .then(() => true)
        .catch(() => false);
      expect(legacyExists).toBe(false);
    });

    it("appendEvent writes to primary, not legacy", async () => {
      await createSession(primaryDir, {
        id: "01NEWSESS02",
        agent_type: "claude-code",
        trigger: "manual",
      });
      await appendEvent(primaryDir, {
        session_id: "01NEWSESS02",
        type: "session.start",
        data: {},
      });

      // Verify events file in primary
      const eventsPath = path.join(
        primaryDir,
        "01NEWSESS02",
        "events.jsonl",
      );
      const exists = await fs
        .access(eventsPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Verify no events in legacy
      const legacyPath = path.join(
        legacyDir,
        "01NEWSESS02",
        "events.jsonl",
      );
      const legacyExists = await fs
        .access(legacyPath)
        .then(() => true)
        .catch(() => false);
      expect(legacyExists).toBe(false);
    });
  });

  // ─── ac-deprecation-warning ────────────────────────────────────────────────

  // AC: @session-legacy-migration ac-deprecation-warning
  describe("ac-deprecation-warning: warning when legacy sessions detected", () => {
    it("emits deprecation warning to stderr with session count", async () => {
      const stderrSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      emitLegacyDeprecationWarning(3);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("3 legacy session(s) found"),
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("kspec session migrate"),
      );
    });

    it("emits warning only once per process", async () => {
      const stderrSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      emitLegacyDeprecationWarning(2);
      emitLegacyDeprecationWarning(5);
      // Should only have been called once
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    });

    it("warnIfLegacySessions emits warning when legacy sessions exist", async () => {
      const stderrSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      await createTestSession(legacyDir, "01LEGACY01");
      await createTestSession(legacyDir, "01LEGACY02");
      const result = await warnIfLegacySessions(specDir);
      expect(result).toBe(true);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("2 legacy session(s) found"),
      );
    });

    it("warnIfLegacySessions returns false when no legacy sessions", async () => {
      const stderrSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const result = await warnIfLegacySessions(specDir);
      expect(result).toBe(false);
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("warnIfLegacySessions returns false when specDir is undefined", async () => {
      const stderrSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const result = await warnIfLegacySessions(undefined);
      expect(result).toBe(false);
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  // ─── ac-list-merge ─────────────────────────────────────────────────────────

  // AC: @session-legacy-migration ac-list-merge
  describe("ac-list-merge: list returns only primary sessions with warning", () => {
    it("listSessions returns only primary sessions, not legacy", async () => {
      await createTestSession(primaryDir, "01PRIMARY01");
      await createTestSession(legacyDir, "01LEGACY01");
      const ids = await listSessions(primaryDir);
      expect(ids).toContain("01PRIMARY01");
      expect(ids).not.toContain("01LEGACY01");
    });

    it("warnIfLegacySessions warns about the count of unmigrated sessions", async () => {
      const stderrSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      await createTestSession(legacyDir, "01LEGACY01");
      await createTestSession(legacyDir, "01LEGACY02");
      await warnIfLegacySessions(specDir);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("2 legacy session(s)"),
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("kspec session migrate"),
      );
    });
  });

  // ─── ac-migration-copy ─────────────────────────────────────────────────────

  // AC: @session-legacy-migration ac-migration-copy
  describe("ac-migration-copy: migrateLegacySessions", () => {
    it("copies session directories from legacy to primary", async () => {
      await createTestSessionWithEvents(legacyDir, "01LEGACY01", [
        { type: "session.start" },
      ]);
      const result = await migrateLegacySessions(primaryDir, specDir);
      expect(result.migrated).toBe(1);
      expect(result.migratedIds).toContain("01LEGACY01");

      // Verify files exist in primary
      const metadataExists = await fs
        .access(path.join(primaryDir, "01LEGACY01", "session.yaml"))
        .then(() => true)
        .catch(() => false);
      expect(metadataExists).toBe(true);

      const eventsExists = await fs
        .access(path.join(primaryDir, "01LEGACY01", "events.jsonl"))
        .then(() => true)
        .catch(() => false);
      expect(eventsExists).toBe(true);
    });

    it("does not delete originals after copy", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      await migrateLegacySessions(primaryDir, specDir);

      // Original should still exist
      const originalExists = await fs
        .access(path.join(legacyDir, "01LEGACY01", "session.yaml"))
        .then(() => true)
        .catch(() => false);
      expect(originalExists).toBe(true);
    });

    it("migrates multiple sessions", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      await createTestSession(legacyDir, "01LEGACY02");
      await createTestSession(legacyDir, "01LEGACY03");
      const result = await migrateLegacySessions(primaryDir, specDir);
      expect(result.migrated).toBe(3);
      expect(result.migratedIds).toHaveLength(3);
    });

    it("returns zero counts when no legacy sessions exist", async () => {
      const result = await migrateLegacySessions(primaryDir, specDir);
      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(0);
    });
  });

  // ─── ac-migration-idempotent ───────────────────────────────────────────────

  // AC: @session-legacy-migration ac-migration-idempotent
  describe("ac-migration-idempotent: skips existing sessions", () => {
    it("skips sessions that already exist in target", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      await createTestSession(primaryDir, "01LEGACY01"); // Already exists
      const result = await migrateLegacySessions(primaryDir, specDir);
      expect(result.migrated).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skippedIds).toContain("01LEGACY01");
    });

    it("migrates only sessions not already in target", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      await createTestSession(legacyDir, "01LEGACY02");
      await createTestSession(primaryDir, "01LEGACY01"); // Already exists
      const result = await migrateLegacySessions(primaryDir, specDir);
      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.migratedIds).toContain("01LEGACY02");
      expect(result.skippedIds).toContain("01LEGACY01");
    });

    it("reports correct counts after multiple runs", async () => {
      await createTestSession(legacyDir, "01LEGACY01");
      await createTestSession(legacyDir, "01LEGACY02");

      // First run: migrates both
      const first = await migrateLegacySessions(primaryDir, specDir);
      expect(first.migrated).toBe(2);
      expect(first.skipped).toBe(0);

      // Second run: skips both
      const second = await migrateLegacySessions(primaryDir, specDir);
      expect(second.migrated).toBe(0);
      expect(second.skipped).toBe(2);
    });
  });
});
