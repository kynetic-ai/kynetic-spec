/**
 * CLI-level tests for legacy session read fallback.
 *
 * These tests exercise the actual CLI commands (kspec session log list, show,
 * search, migrate) to verify that the command handlers in
 * src/cli/commands/session/log.ts and migrate.ts route through the fallback
 * layer correctly.
 *
 * Complements the unit tests in session-legacy-fallback.test.ts which test the
 * legacy.ts helper functions directly.
 *
 * AC coverage (CLI-level):
 * - @session-legacy-migration ac-read-fallback: CLI reads fall back to .kspec/sessions/
 * - @session-legacy-migration ac-list-merge: CLI list merges both locations
 * - @session-legacy-migration ac-deprecation-warning: CLI emits warning on stderr
 * - @session-legacy-migration ac-migration-copy: CLI migrate copies sessions
 * - @session-legacy-migration ac-migration-idempotent: CLI migrate skips existing
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import type { SessionLogSummary } from "../src/sessions/store.js";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec,
  kspecJson,
  testUlid,
} from "./helpers/cli";

// ─── Test Helpers ────────────────────────────────────────────────────────────

const PRIMARY_SESSION_ID = testUlid("PRMY", 1);
const LEGACY_SESSION_ID = testUlid("LGCY", 1);
const BOTH_SESSION_ID = testUlid("BOTH", 1);

/**
 * Create a session directory with metadata and optional events in a given dir.
 */
async function writeSession(
  dir: string,
  sessionId: string,
  opts: {
    agentType?: string;
    status?: string;
    startedAt?: string;
    endedAt?: string;
    events?: Array<{ type: string; data?: unknown }>;
  } = {},
): Promise<void> {
  const sessionDir = path.join(dir, sessionId);
  await fs.mkdir(sessionDir, { recursive: true });

  const metadata = {
    id: sessionId,
    agent_type: opts.agentType ?? "claude-code",
    status: opts.status ?? "completed",
    started_at: opts.startedAt ?? "2026-03-01T10:00:00.000Z",
    ended_at: opts.endedAt ?? "2026-03-01T11:00:00.000Z",
  };
  await fs.writeFile(
    path.join(sessionDir, "session.yaml"),
    YAML.stringify(metadata),
  );

  if (opts.events && opts.events.length > 0) {
    const lines = opts.events.map((e, i) =>
      JSON.stringify({
        seq: i + 1,
        ts: Date.now() + i * 1000,
        type: e.type,
        session_id: sessionId,
        data: e.data ?? {},
      }),
    );
    await fs.writeFile(
      path.join(sessionDir, "events.jsonl"),
      lines.join("\n") + "\n",
    );
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Legacy session fallback (CLI)", () => {
  let tempDir: string;
  let sessionsDir: string; // .kspec-sessions/ (primary)
  let legacyDir: string; // <specDir>/sessions/ (legacy location)

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // In test fixtures (no shadow branch), specDir = tempDir
    // So legacy location is tempDir/sessions/
    sessionsDir = path.join(tempDir, ".kspec-sessions");
    legacyDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ─── ac-read-fallback: session log list ─────────────────────────────────

  // AC: @session-legacy-migration ac-read-fallback
  // AC: @session-legacy-migration ac-list-merge
  describe("session log list with legacy fallback", () => {
    it("includes legacy-only sessions in list output", async () => {
      await writeSession(sessionsDir, PRIMARY_SESSION_ID);
      await writeSession(legacyDir, LEGACY_SESSION_ID, {
        agentType: "legacy-agent",
      });

      const sessions = kspecJson<SessionLogSummary[]>(
        "session log list",
        tempDir,
      );
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain(PRIMARY_SESSION_ID);
      expect(ids).toContain(LEGACY_SESSION_ID);
    });

    it("deduplicates when session exists in both locations", async () => {
      // Same ID in both — primary should win
      await writeSession(sessionsDir, BOTH_SESSION_ID, {
        agentType: "primary-agent",
      });
      await writeSession(legacyDir, BOTH_SESSION_ID, {
        agentType: "legacy-agent",
      });
      await writeSession(legacyDir, LEGACY_SESSION_ID);

      const sessions = kspecJson<SessionLogSummary[]>(
        "session log list",
        tempDir,
      );
      expect(sessions).toHaveLength(2);
      const both = sessions.find((s) => s.id === BOTH_SESSION_ID);
      expect(both).toBeDefined();
      expect(both!.agent_type).toBe("primary-agent");
    });

    it("filters by --status still work with merged results", async () => {
      await writeSession(sessionsDir, PRIMARY_SESSION_ID, {
        status: "completed",
      });
      await writeSession(legacyDir, LEGACY_SESSION_ID, {
        status: "active",
        agentType: "legacy-agent",
        endedAt: undefined,
      });

      const activeSessions = kspecJson<SessionLogSummary[]>(
        "session log list --status active",
        tempDir,
      );
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].id).toBe(LEGACY_SESSION_ID);
    });
  });

  // ─── ac-deprecation-warning ─────────────────────────────────────────────

  // AC: @session-legacy-migration ac-deprecation-warning
  describe("deprecation warning on stderr", () => {
    it("emits deprecation warning to stderr when listing legacy sessions", async () => {
      await writeSession(legacyDir, LEGACY_SESSION_ID);

      const result = kspec("session log list", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("legacy location");
      expect(result.stderr).toContain("kspec session migrate");
      // Warning must NOT appear in stdout (would corrupt structured output)
      expect(result.stdout).not.toContain("legacy location");
    });

    it("does not emit deprecation warning when only primary sessions exist", async () => {
      await writeSession(sessionsDir, PRIMARY_SESSION_ID);

      const result = kspec("session log list", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("legacy location");
    });
  });

  // ─── ac-read-fallback: session log show ─────────────────────────────────

  // AC: @session-legacy-migration ac-read-fallback
  describe("session log show with legacy fallback", () => {
    it("shows a legacy-only session by full ID", async () => {
      await writeSession(legacyDir, LEGACY_SESSION_ID, {
        events: [{ type: "session.start" }, { type: "session.end" }],
      });

      const result = kspec(`session log show ${LEGACY_SESSION_ID}`, tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(LEGACY_SESSION_ID.slice(0, 8));
    });

    it("shows a legacy-only session in JSON mode with full fields", async () => {
      await writeSession(legacyDir, LEGACY_SESSION_ID, {
        agentType: "legacy-agent",
        events: [{ type: "session.start" }],
      });

      const detail = kspecJson<{ id: string; agent_type: string; status: string }>(
        `session log show ${LEGACY_SESSION_ID}`,
        tempDir,
      );
      expect(detail.id).toBe(LEGACY_SESSION_ID);
      expect(detail.agent_type).toBe("legacy-agent");
      expect(detail.status).toBe("completed");
    });

    it("shows primary session over legacy when both exist", async () => {
      await writeSession(sessionsDir, BOTH_SESSION_ID, {
        agentType: "primary-agent",
      });
      await writeSession(legacyDir, BOTH_SESSION_ID, {
        agentType: "legacy-agent",
      });

      const detail = kspecJson<{ id: string; agent_type: string }>(
        `session log show ${BOTH_SESSION_ID}`,
        tempDir,
      );
      expect(detail.agent_type).toBe("primary-agent");
    });

    it("emits deprecation warning on stderr for legacy session show", async () => {
      await writeSession(legacyDir, LEGACY_SESSION_ID);

      const result = kspec(`session log show ${LEGACY_SESSION_ID}`, tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("legacy location");
    });

    it("resolves legacy session by prefix", async () => {
      await writeSession(legacyDir, LEGACY_SESSION_ID);

      // Use first 8 chars as prefix
      const prefix = LEGACY_SESSION_ID.slice(0, 8);
      const result = kspec(`session log show ${prefix}`, tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(prefix);
    });
  });

  // ─── ac-read-fallback: session log search ───────────────────────────────

  // AC: @session-legacy-migration ac-read-fallback
  describe("session log search with legacy fallback", () => {
    it("finds events in legacy sessions", async () => {
      await writeSession(legacyDir, LEGACY_SESSION_ID, {
        events: [
          {
            type: "session.start",
            data: { message: "legacy-search-marker" },
          },
        ],
      });

      const results = kspecJson<Array<{ session_id: string; matches: unknown[] }>>(
        'session log search "legacy-search-marker"',
        tempDir,
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].session_id).toBe(LEGACY_SESSION_ID);
    });

    it("searches across both primary and legacy sessions", async () => {
      await writeSession(sessionsDir, PRIMARY_SESSION_ID, {
        events: [
          {
            type: "session.start",
            data: { message: "cross-location-search" },
          },
        ],
      });
      await writeSession(legacyDir, LEGACY_SESSION_ID, {
        events: [
          {
            type: "session.start",
            data: { message: "cross-location-search" },
          },
        ],
      });

      const results = kspecJson<Array<{ session_id: string; matches: unknown[] }>>(
        'session log search "cross-location-search"',
        tempDir,
      );
      const sessionIds = results.map((r) => r.session_id);
      expect(sessionIds).toContain(PRIMARY_SESSION_ID);
      expect(sessionIds).toContain(LEGACY_SESSION_ID);
    });

    it("emits deprecation warning on stderr when searching legacy sessions", async () => {
      await writeSession(legacyDir, LEGACY_SESSION_ID, {
        events: [
          {
            type: "session.start",
            data: { message: "warning-check" },
          },
        ],
      });

      const result = kspec('session log search "warning-check"', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("legacy location");
    });
  });
});

// ─── session migrate CLI ─────────────────────────────────────────────────────

describe("kspec session migrate (CLI)", () => {
  let tempDir: string;
  let sessionsDir: string;
  let legacyDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    sessionsDir = path.join(tempDir, ".kspec-sessions");
    legacyDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(legacyDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-legacy-migration ac-migration-copy
  it("migrates legacy sessions and reports counts", async () => {
    const id1 = testUlid("MGRN", 1);
    const id2 = testUlid("MGRN", 2);
    await writeSession(legacyDir, id1);
    await writeSession(legacyDir, id2);

    const result = kspec("session migrate", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Migrated 2 session(s)");
    expect(result.stdout).toContain(id1);
    expect(result.stdout).toContain(id2);

    // Verify files actually exist in target
    const targetExists = await fs
      .access(path.join(sessionsDir, id1, "session.yaml"))
      .then(() => true)
      .catch(() => false);
    expect(targetExists).toBe(true);
  });

  // AC: @session-legacy-migration ac-migration-copy
  it("outputs structured JSON with migrated/skipped counts", async () => {
    const id = testUlid("MGRN", 3);
    await writeSession(legacyDir, id);

    const data = kspecJson<{
      migrated: number;
      skipped: number;
      migratedIds: string[];
      skippedIds: string[];
    }>("session migrate", tempDir);
    expect(data.migrated).toBe(1);
    expect(data.skipped).toBe(0);
    expect(data.migratedIds).toContain(id);
  });

  // AC: @session-legacy-migration ac-migration-idempotent
  it("skips sessions that already exist in target", async () => {
    const existing = testUlid("MGRN", 4);
    const newOne = testUlid("MGRN", 5);
    await writeSession(legacyDir, existing);
    await writeSession(legacyDir, newOne);
    await writeSession(sessionsDir, existing); // Already exists in target

    const data = kspecJson<{
      migrated: number;
      skipped: number;
      migratedIds: string[];
      skippedIds: string[];
    }>("session migrate", tempDir);
    expect(data.migrated).toBe(1);
    expect(data.skipped).toBe(1);
    expect(data.migratedIds).toContain(newOne);
    expect(data.skippedIds).toContain(existing);
  });

  it("reports no legacy sessions when none exist", async () => {
    // legacyDir exists but is empty
    const result = kspec("session migrate", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No legacy sessions");
  });

  // AC: @session-legacy-migration ac-migration-idempotent
  it("is idempotent — second run skips all", async () => {
    const id = testUlid("MGRN", 6);
    await writeSession(legacyDir, id);

    // First run
    const first = kspecJson<{ migrated: number; skipped: number }>(
      "session migrate",
      tempDir,
    );
    expect(first.migrated).toBe(1);

    // Second run — should skip
    const second = kspecJson<{ migrated: number; skipped: number }>(
      "session migrate",
      tempDir,
    );
    expect(second.migrated).toBe(0);
    expect(second.skipped).toBe(1);
  });

  // AC: @trait-semantic-exit-codes ac-1
  it("exits with code 0 on success", async () => {
    const result = kspec("session migrate", tempDir);
    expect(result.exitCode).toBe(0);
  });
});
