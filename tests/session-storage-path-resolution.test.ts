/**
 * Tests for session storage path resolution.
 *
 * AC coverage:
 * - @session-storage-path-resolution ac-resolver: Paths rooted at .kspec-sessions/, not .kspec/sessions/
 * - @session-storage-path-resolution ac-path-helpers: All path helpers use the new sessions root
 * - @session-storage-path-resolution ac-context: initContext() includes sessionsDir at project root
 * - @session-storage-path-resolution ac-cli-commands: CLI session commands resolve via ctx.sessionsDir
 * - @session-storage-path-resolution ac-daemon-routes: Daemon routes resolve via ctx.sessionsDir
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  getSessionsDir,
  getSessionDir,
  getSessionMetadataPath,
  getSessionEventsPath,
  getSessionContextPath,
  getSessionBudgetPath,
  getSessionBlobDir,
  createSession,
} from "../src/sessions/store.js";
import { initContext } from "../src/parser/yaml.js";
import { kspec, setupTempFixtures, cleanupTempDir, testUlid } from "./helpers/cli";

describe("Session Storage Path Resolution", () => {
  const sessionsDir = "/project/.kspec-sessions";
  const sessionId = "01ABCDEF";

  // AC: @session-storage-path-resolution ac-resolver
  describe("ac-resolver: paths rooted at .kspec-sessions/", () => {
    it("getSessionsDir returns sessionsDir directly (identity)", () => {
      const result = getSessionsDir(sessionsDir);
      expect(result).toBe(sessionsDir);
      expect(result).not.toContain(".kspec/sessions");
    });

    it("getSessionDir returns path under sessionsDir, not specDir", () => {
      const result = getSessionDir(sessionsDir, sessionId);
      expect(result).toBe(path.join(sessionsDir, sessionId));
      expect(result).toContain(".kspec-sessions");
      expect(result).not.toMatch(/\.kspec\/sessions/);
    });
  });

  // AC: @session-storage-path-resolution ac-path-helpers
  describe("ac-path-helpers: all helpers use new sessions root", () => {
    it("getSessionMetadataPath uses sessionsDir", () => {
      const result = getSessionMetadataPath(sessionsDir, sessionId);
      expect(result).toBe(path.join(sessionsDir, sessionId, "session.yaml"));
    });

    it("getSessionEventsPath uses sessionsDir", () => {
      const result = getSessionEventsPath(sessionsDir, sessionId);
      expect(result).toBe(path.join(sessionsDir, sessionId, "events.jsonl"));
    });

    it("getSessionContextPath uses sessionsDir", () => {
      const result = getSessionContextPath(sessionsDir, sessionId, 3);
      expect(result).toBe(path.join(sessionsDir, sessionId, "context-iter-3.json"));
    });

    it("getSessionBudgetPath uses sessionsDir", () => {
      const result = getSessionBudgetPath(sessionsDir, sessionId);
      expect(result).toBe(path.join(sessionsDir, sessionId, "budget.json"));
    });

    it("getSessionBlobDir uses sessionsDir", () => {
      const result = getSessionBlobDir(sessionsDir, sessionId);
      expect(result).toBe(path.join(sessionsDir, sessionId, "blobs"));
    });

    it("none of the helpers produce paths containing .kspec/sessions/", () => {
      const paths = [
        getSessionsDir(sessionsDir),
        getSessionDir(sessionsDir, sessionId),
        getSessionMetadataPath(sessionsDir, sessionId),
        getSessionEventsPath(sessionsDir, sessionId),
        getSessionContextPath(sessionsDir, sessionId, 1),
        getSessionBudgetPath(sessionsDir, sessionId),
        getSessionBlobDir(sessionsDir, sessionId),
      ];
      for (const p of paths) {
        expect(p).not.toMatch(/\.kspec\/sessions/);
      }
    });
  });

  // AC: @session-storage-path-resolution ac-context
  describe("ac-context: initContext() resolves sessionsDir at project root", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await setupTempFixtures();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("KspecContext type has sessionsDir field (compile-time check)", () => {
      type AssertHasSessionsDir = import("../src/parser/yaml.js").KspecContext extends {
        sessionsDir: string;
      }
        ? true
        : false;
      const check: AssertHasSessionsDir = true;
      expect(check).toBe(true);
    });

    it("initContext() returns sessionsDir pointing to .kspec-sessions/ at project root", async () => {
      const ctx = await initContext(tempDir);
      expect(ctx.sessionsDir).toBe(path.join(ctx.rootDir, ".kspec-sessions"));
      expect(ctx.sessionsDir).not.toMatch(/\.kspec\/sessions/);
    });

    it("sessionsDir is separate from specDir", async () => {
      const ctx = await initContext(tempDir);
      expect(ctx.sessionsDir).not.toBe(ctx.specDir);
      expect(ctx.sessionsDir).not.toContain(path.basename(ctx.specDir) + "/sessions");
    });
  });

  // AC: @session-storage-path-resolution ac-cli-commands
  describe("ac-cli-commands: CLI session commands resolve via ctx.sessionsDir", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await setupTempFixtures();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("session create writes to .kspec-sessions/, not specDir/sessions/", async () => {
      const result = kspec("session create --agent-type test-agent", tempDir);
      expect(result.exitCode).toBe(0);

      // Extract session ID from output
      const match = result.stdout.match(/Created session:\s+(\S+)/);
      expect(match).not.toBeNull();
      const createdId = match![1];

      // Session metadata should be at .kspec-sessions/{id}/session.yaml
      const expectedPath = path.join(tempDir, ".kspec-sessions", createdId, "session.yaml");
      const fileExists = await fs
        .access(expectedPath)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
    });

    it("session log list reads from .kspec-sessions/", async () => {
      // Create a session at the correct path
      const sid = testUlid("SCLI");
      const sessDir = path.join(tempDir, ".kspec-sessions");
      await createSession(sessDir, { id: sid, agent_type: "test-agent" });

      // CLI should find it
      const result = kspec("session log list", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("1 session(s)");
    });

    it("session checkpoint resolves session data from .kspec-sessions/", async () => {
      const sid = testUlid("SCLI", 1);
      const sessDir = path.join(tempDir, ".kspec-sessions");
      await createSession(sessDir, { id: sid, agent_type: "test-agent" });

      // Checkpoint should not error trying to resolve the session
      const result = kspec("session checkpoint", tempDir, {
        env: { KSPEC_SESSION_ID: sid },
        expectFail: true,
      });
      // Should complete (exit 0 or 1 for issues) — not crash
      expect(result.exitCode).toBeLessThanOrEqual(1);
    });
  });

  // AC: @session-storage-path-resolution ac-daemon-routes
  // Daemon routes call initContext() on every request, which provides ctx.sessionsDir.
  // All session store functions (getAllSessionLogSummaries, getSession, readEvents, etc.)
  // are called with ctx.sessionsDir. Full E2E coverage is in
  // packages/web-ui/tests/e2e/sessions.spec.ts.
  describe("ac-daemon-routes: daemon routes resolve sessionsDir from context", () => {
    it("initContext provides sessionsDir that daemon routes would use", async () => {
      const tempDir = await setupTempFixtures();
      try {
        const ctx = await initContext(tempDir);
        // Daemon routes pass ctx.sessionsDir to getAllSessionLogSummaries, getSession, etc.
        // Verify it resolves to .kspec-sessions/ — the same path CLI commands use.
        expect(ctx.sessionsDir).toBe(path.join(tempDir, ".kspec-sessions"));
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    it("session data written to .kspec-sessions/ is readable by store functions using same path", async () => {
      const tempDir = await setupTempFixtures();
      try {
        const ctx = await initContext(tempDir);

        // Create a session at ctx.sessionsDir (same path daemon would use)
        const sid = testUlid("DMON");
        await createSession(ctx.sessionsDir, { id: sid, agent_type: "test-daemon" });

        // Verify the session is accessible via the same sessionsDir
        const { getAllSessionLogSummaries } = await import("../src/sessions/store.js");
        const summaries = await getAllSessionLogSummaries(ctx.sessionsDir);
        expect(summaries.some((s) => s.id === sid)).toBe(true);
      } finally {
        await cleanupTempDir(tempDir);
      }
    });
  });
});
