/**
 * API Tests for Daemon Session Legacy Detect-and-Warn
 *
 * Tests verify that all session read endpoints include a warning field
 * when legacy sessions exist in .kspec/sessions/, and omit it when
 * no legacy sessions are present.
 *
 * Covered ACs:
 * - @session-legacy-migration ac-read-fallback: Daemon reads warn when legacy sessions exist
 * - @session-legacy-migration ac-list-merge: GET /api/sessions warns about legacy count
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Elysia } from "elysia";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
} from "./helpers.js";

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-sessions-legacy-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

const SESSION_ID = "01JTEST0000000000000000099";

/**
 * Create a session directory with metadata and optional events.
 */
function writeSession(
  dir: string,
  sessionId: string,
  opts: {
    agentType?: string;
    status?: string;
    events?: Array<{ type: string; data?: unknown }>;
  } = {},
): void {
  const sessionDir = join(dir, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const metadata = {
    id: sessionId,
    agent_type: opts.agentType ?? "claude-code",
    status: opts.status ?? "completed",
    started_at: "2026-03-01T10:00:00.000Z",
    ended_at: "2026-03-01T11:00:00.000Z",
  };
  writeFileSync(join(sessionDir, "session.yaml"), YAML.stringify(metadata));

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
    writeFileSync(join(sessionDir, "events.jsonl"), `${lines.join("\n")}\n`);
  }
}

// AC: @session-legacy-migration ac-read-fallback
// AC: @session-legacy-migration ac-list-merge
describe("GET /api/sessions", () => {
  it("includes warning when legacy sessions exist", async () => {
    // Create a primary session
    const sessionsDir = join(tempDir, ".kspec-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(sessionsDir, SESSION_ID, {
      events: [{ type: "session.start" }],
    });

    // Create a legacy session in .kspec/sessions/
    const legacyDir = join(tempDir, ".kspec", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    writeSession(legacyDir, "01JLEGACY000000000000000001");

    const response = await request("/api/sessions");
    expect(response.status).toBe(200);

    const body = await response.json();
    // Warning is inside body.data (the response envelope wraps data + meta)
    expect(body.data).toHaveProperty("warning");
    expect(body.data.warning).toContain("legacy session(s) found");
    expect(body.data.warning).toContain("kspec session migrate");
  });

  it("omits warning when no legacy sessions exist", async () => {
    const sessionsDir = join(tempDir, ".kspec-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(sessionsDir, SESSION_ID);

    const response = await request("/api/sessions");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).not.toHaveProperty("warning");
  });
});

// AC: @session-legacy-migration ac-read-fallback
describe("GET /api/sessions/:id", () => {
  it("includes warning when legacy sessions exist", async () => {
    const sessionsDir = join(tempDir, ".kspec-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(sessionsDir, SESSION_ID, {
      events: [{ type: "session.start" }],
    });

    // Create a legacy session
    const legacyDir = join(tempDir, ".kspec", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    writeSession(legacyDir, "01JLEGACY000000000000000002");

    const response = await request(`/api/sessions/${SESSION_ID}`);
    expect(response.status).toBe(200);

    const body = await response.json();
    // Warning is inside body.data (the response envelope wraps data + meta)
    expect(body.data).toHaveProperty("warning");
    expect(body.data.warning).toContain("legacy session(s) found");
    expect(body.data.warning).toContain("kspec session migrate");
  });

  it("omits warning when no legacy sessions exist", async () => {
    const sessionsDir = join(tempDir, ".kspec-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(sessionsDir, SESSION_ID, {
      events: [{ type: "session.start" }],
    });

    const response = await request(`/api/sessions/${SESSION_ID}`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).not.toHaveProperty("warning");
  });
});

// AC: @session-legacy-migration ac-read-fallback
describe("GET /api/sessions/:id/events", () => {
  it("includes warning when legacy sessions exist", async () => {
    const sessionsDir = join(tempDir, ".kspec-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(sessionsDir, SESSION_ID, {
      events: [{ type: "session.start" }, { type: "session.end" }],
    });

    // Create a legacy session
    const legacyDir = join(tempDir, ".kspec", "sessions");
    mkdirSync(legacyDir, { recursive: true });
    writeSession(legacyDir, "01JLEGACY000000000000000003");

    const response = await request(`/api/sessions/${SESSION_ID}/events`);
    expect(response.status).toBe(200);

    const body = await response.json();
    // Warning is inside body.data (the response envelope wraps data + meta)
    expect(body.data).toHaveProperty("warning");
    expect(body.data.warning).toContain("legacy session(s) found");
    expect(body.data.warning).toContain("kspec session migrate");
  });

  it("omits warning when no legacy sessions exist", async () => {
    const sessionsDir = join(tempDir, ".kspec-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeSession(sessionsDir, SESSION_ID, {
      events: [{ type: "session.start" }],
    });

    const response = await request(`/api/sessions/${SESSION_ID}/events`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data).not.toHaveProperty("warning");
  });
});

// AC: @session-legacy-migration ac-list-merge
it("warning includes correct count of legacy sessions", async () => {
  const sessionsDir = join(tempDir, ".kspec-sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeSession(sessionsDir, SESSION_ID);

  // Create multiple legacy sessions
  const legacyDir = join(tempDir, ".kspec", "sessions");
  mkdirSync(legacyDir, { recursive: true });
  writeSession(legacyDir, "01JLEGACY000000000000000004");
  writeSession(legacyDir, "01JLEGACY000000000000000005");
  writeSession(legacyDir, "01JLEGACY000000000000000006");

  const response = await request("/api/sessions");
  expect(response.status).toBe(200);

  const body = await response.json();
  // Warning is inside body.data
  expect(body.data).toHaveProperty("warning");
  expect(body.data.warning).toContain("3 legacy session(s) found");
});
