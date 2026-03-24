/**
 * Session compact command tests.
 *
 * Task: @implement-session-event-compaction
 * Spec: @session-compact
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  compactSessionEvents,
  createSession,
  getSessionDir,
  getSessionEventsPath,
  updateSessionStatus,
} from "../src/sessions/store.js";
import {
  cleanupTempDir,
  kspec,
  kspecJson,
  readTestOutput,
  setupTempFixtures,
  testUlid,
} from "./helpers/cli.js";

interface SessionCompactJson {
  dry_run: boolean;
  all: boolean;
  session?: {
    session_id: string;
    status: string;
    changed: boolean;
    events_processed: number;
    blobs_created: number;
    bytes_before: number;
    bytes_after: number;
    bytes_reclaimed: number;
  };
  sessions?: Array<{
    session_id: string;
    status: string;
  }>;
  totals: {
    sessions_total: number;
    sessions_processed: number;
    sessions_changed: number;
    sessions_skipped_active: number;
    sessions_failed: number;
    events_processed: number;
    blobs_created: number;
    bytes_before: number;
    bytes_after: number;
    bytes_reclaimed: number;
  };
}

describe("session compact", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    sessionsDir = path.join(tempDir, ".kspec-sessions");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function createSessionWithStatus(
    sessionId: string,
    status: "active" | "completed" | "abandoned",
  ): Promise<void> {
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });
    if (status !== "active") {
      await updateSessionStatus(sessionsDir, sessionId, status);
    }
  }

  async function writeRawEventWithOversizedPayload(
    sessionId: string,
    payload: string,
  ): Promise<void> {
    const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
    const event = {
      ts: 1000,
      seq: 0,
      type: "session.update",
      session_id: sessionId,
      data: {
        iteration: 1,
        update: {
          sessionUpdate: "tool_call_update",
          rawOutput: payload,
        },
      },
    };
    await fs.writeFile(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  // AC: @session-compact ac-1
  // AC: @session-compact ac-6
  // AC: @trait-semantic-exit-codes ac-1
  // AC: @trait-json-output ac-1
  // AC: @trait-json-output ac-2
  it("externalizes oversized payloads and reports compaction metrics", async () => {
    const sessionId = testUlid("SESS", 1);
    const rawOutput = "X".repeat(22_000);
    await createSessionWithStatus(sessionId, "completed");
    await writeRawEventWithOversizedPayload(sessionId, rawOutput);

    const result = kspecJson<SessionCompactJson>(`session compact ${sessionId}`, tempDir);

    expect(result.dry_run).toBe(false);
    expect(result.session?.status).toBe("compacted");
    expect(result.session?.events_processed).toBe(1);
    expect(result.session?.blobs_created).toBeGreaterThanOrEqual(1);
    expect(result.session?.bytes_reclaimed).toBeGreaterThan(0);

    const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
    const stored = JSON.parse((await readTestOutput(eventsPath)).trim());
    const pointer = stored.data.update.rawOutput as {
      path: string;
    };
    expect(pointer.path).toMatch(/^blobs\//);

    const blobPath = path.join(getSessionDir(sessionsDir, sessionId), pointer.path);
    const blobContent = await readTestOutput(blobPath);
    expect(blobContent).toBe(rawOutput);
  });

  // AC: @session-compact ac-2
  // AC: @session-compact ac-8
  it("preserves original events.jsonl when atomic rename fails", async () => {
    const sessionId = testUlid("SESS", 2);
    await createSessionWithStatus(sessionId, "completed");
    await writeRawEventWithOversizedPayload(sessionId, "Y".repeat(22_000));

    const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
    const before = await readTestOutput(eventsPath);

    await expect(
      compactSessionEvents(sessionsDir, sessionId, {
        renameFn: async () => {
          throw new Error("rename failed");
        },
      }),
    ).rejects.toThrow("rename failed");

    const after = await readTestOutput(eventsPath);
    expect(after).toBe(before);
  });

  // AC: @session-compact ac-3
  // AC: @trait-semantic-exit-codes ac-5
  it("is idempotent for already compacted sessions", async () => {
    const sessionId = testUlid("SESS", 3);
    await createSessionWithStatus(sessionId, "completed");
    await writeRawEventWithOversizedPayload(sessionId, "Z".repeat(22_000));

    kspec(`session compact ${sessionId}`, tempDir);
    const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
    const firstContent = await readTestOutput(eventsPath);
    const blobsDir = path.join(getSessionDir(sessionsDir, sessionId), "blobs");
    const firstBlobCount = (await fs.readdir(blobsDir)).length;

    const second = kspecJson<SessionCompactJson>(`session compact ${sessionId}`, tempDir);
    const secondContent = await readTestOutput(eventsPath);
    const secondBlobCount = (await fs.readdir(blobsDir)).length;

    expect(second.session?.status).toBe("already_compacted");
    expect(second.session?.changed).toBe(false);
    expect(second.session?.blobs_created).toBe(0);
    expect(secondContent).toBe(firstContent);
    expect(secondBlobCount).toBe(firstBlobCount);
  });

  // AC: @session-compact ac-4
  // AC: @trait-semantic-exit-codes ac-2
  it("refuses to compact active sessions", async () => {
    const sessionId = testUlid("SESS", 4);
    await createSessionWithStatus(sessionId, "active");
    await writeRawEventWithOversizedPayload(sessionId, "A".repeat(22_000));

    const result = kspec(`session compact ${sessionId}`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Cannot compact active session");
  });

  // AC: @session-compact ac-5
  it("compacts all non-active sessions sequentially and reports progress", async () => {
    const completedId = testUlid("SESS", 5);
    const abandonedId = testUlid("SESS", 6);
    const activeId = testUlid("SESS", 7);
    await createSessionWithStatus(completedId, "completed");
    await createSessionWithStatus(abandonedId, "abandoned");
    await createSessionWithStatus(activeId, "active");

    await writeRawEventWithOversizedPayload(completedId, "B".repeat(22_000));
    await fs.writeFile(getSessionEventsPath(sessionsDir, abandonedId), "", "utf-8");
    await writeRawEventWithOversizedPayload(activeId, "C".repeat(22_000));

    const output = kspec("session compact --all", tempDir);
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("Processing");

    const allJson = kspecJson<SessionCompactJson>("session compact --all", tempDir);
    expect(allJson.all).toBe(true);
    expect(allJson.totals.sessions_total).toBe(3);
    expect(allJson.totals.sessions_processed).toBe(2);
    expect(allJson.totals.sessions_skipped_active).toBe(1);
  });

  // AC: @session-compact ac-7
  it("exits cleanly when events.jsonl is missing", async () => {
    const sessionId = testUlid("SESS", 8);
    await createSessionWithStatus(sessionId, "completed");

    const result = kspecJson<SessionCompactJson>(`session compact ${sessionId}`, tempDir);
    expect(result.session?.status).toBe("missing_events_file");
    expect(result.session?.changed).toBe(false);
  });

  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-6
  it("supports --dry-run preview without modifying files", async () => {
    const sessionId = testUlid("SESS", 9);
    await createSessionWithStatus(sessionId, "completed");
    await writeRawEventWithOversizedPayload(sessionId, "D".repeat(22_000));

    const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
    const before = await readTestOutput(eventsPath);

    const jsonResult = kspecJson<SessionCompactJson>(
      `session compact ${sessionId} --dry-run`,
      tempDir,
    );
    const humanResult = kspec(`session compact ${sessionId} --dry-run`, tempDir);
    const after = await readTestOutput(eventsPath);

    expect(jsonResult.dry_run).toBe(true);
    expect(jsonResult.session?.status).toBe("would_compact");
    expect(humanResult.stdout).toContain("Dry run preview");
    expect(after).toBe(before);

    const blobsDir = path.join(getSessionDir(sessionsDir, sessionId), "blobs");
    await expect(fs.access(blobsDir)).rejects.toThrow();
  });

  // AC: @trait-dry-run ac-4
  // AC: @trait-semantic-exit-codes ac-4
  // AC: @trait-json-output ac-3
  it("returns errors in --json mode and preserves state in dry-run failures", async () => {
    const sessionId = testUlid("SESS", 10);
    await createSessionWithStatus(sessionId, "completed");
    const eventsPath = getSessionEventsPath(sessionsDir, sessionId);
    await fs.writeFile(eventsPath, "{not-json}\n", "utf-8");
    const before = await readTestOutput(eventsPath);

    const result = kspec(`session compact ${sessionId} --dry-run --json`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(3);

    const errJson = JSON.parse(result.stderr);
    expect(errJson.success).toBe(false);
    expect(errJson.error).toContain("Failed to compact session events");

    const after = await readTestOutput(eventsPath);
    expect(after).toBe(before);
  });

  // AC: @trait-shadow-commit ac-4
  it("completes successfully when shadow is not configured", async () => {
    const sessionId = testUlid("SESS", 11);
    await createSessionWithStatus(sessionId, "completed");
    await writeRawEventWithOversizedPayload(sessionId, "E".repeat(22_000));

    const result = kspec(`session compact ${sessionId}`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-json-output ac-4 -- N/A: compact output contains no spec/task refs.
  // AC: @trait-json-output ac-5 -- N/A: compact output contains size counters, not timestamps.
  // AC: @trait-json-output ac-6 -- N/A: command has no competing format options beyond global --json.
  // AC: @trait-semantic-exit-codes ac-3 -- N/A: compact has no confirmation prompts.
  // AC: @trait-semantic-exit-codes ac-6 -- N/A: invalid flag parsing is handled by commander globally.
  // AC: @trait-semantic-exit-codes ac-7 -- N/A: this command has no partial-success batch mode contract.
  // AC: @trait-semantic-exit-codes ac-8 -- N/A: exit code constants are documented globally in src/cli/exit-codes.ts.
  // AC: @trait-dry-run ac-5 -- N/A: command does not implement a --force flag.
  // AC: @trait-shadow-commit ac-1 -- N/A in unit fixture mode: no shadow worktree is configured.
  // AC: @trait-shadow-commit ac-2 -- N/A in unit fixture mode: no shadow commit is produced.
  // AC: @trait-shadow-commit ac-3 -- N/A in unit fixture mode: no shadow commit is produced.
  // AC: @trait-shadow-commit ac-5 -- N/A in unit fixture mode: no shadow commit path executes.
  // AC: @trait-shadow-commit ac-6 -- N/A in unit fixture mode: no shadow remote push path executes.
  // AC: @trait-shadow-commit ac-7 -- N/A in unit fixture mode: no shadow commit/push failure path executes.
  // AC: @trait-shadow-commit ac-8 -- N/A in unit fixture mode: atomic shadow commit behavior requires real shadow setup.
});
