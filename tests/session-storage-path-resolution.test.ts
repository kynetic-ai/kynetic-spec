/**
 * Tests for session storage path resolution.
 *
 * AC coverage:
 * - @session-storage-path-resolution ac-resolver: Paths rooted at .kspec-sessions/, not .kspec/sessions/
 * - @session-storage-path-resolution ac-path-helpers: All path helpers use the new sessions root
 * - @session-storage-path-resolution ac-context: initContext() includes sessionsDir
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  getSessionsDir,
  getSessionDir,
  getSessionMetadataPath,
  getSessionEventsPath,
  getSessionContextPath,
  getSessionBudgetPath,
  getSessionBlobDir,
} from "../src/sessions/store.js";

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
  describe("ac-context: KspecContext includes sessionsDir", () => {
    it("KspecContext type has sessionsDir field (compile-time check)", () => {
      // This test verifies at compile time that sessionsDir exists on KspecContext.
      // The import and type assertion would fail compilation if sessionsDir was missing.
      type AssertHasSessionsDir = import("../src/parser/yaml.js").KspecContext extends { sessionsDir: string } ? true : false;
      const check: AssertHasSessionsDir = true;
      expect(check).toBe(true);
    });
  });
});
