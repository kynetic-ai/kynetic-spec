import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  createSession,
  getSessionEventsPath,
  resolveStaleSessionCriteria,
  selectStaleActiveSessions,
} from "../src/sessions/store.js";

describe("stale session criteria", () => {
  let specDir: string;
  const nowIso = "2026-02-28T00:00:00.000Z";
  const nowMs = new Date(nowIso).getTime();

  beforeEach(async () => {
    specDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-stale-session-"));
  });

  afterEach(async () => {
    await fs.rm(specDir, { recursive: true, force: true });
  });

  // AC: @session-stale-criteria ac-5
  it("applies default thresholds when none are provided", () => {
    const resolved = resolveStaleSessionCriteria({});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.criteria.olderThan).toBe("24h");
    expect(resolved.criteria.inactiveFor).toBe("6h");
    expect(resolved.criteria.livenessGuard).toBe("5m");
  });

  // AC: @session-stale-criteria ac-4
  it("rejects invalid relative duration with usage guidance", () => {
    const resolved = resolveStaleSessionCriteria({ olderThan: "abc" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe("older-than");
    expect(resolved.guidance).toContain("relative durations only");
    expect(resolved.guidance).toContain("6h, 7d, 2w, 1m");
  });

  // AC: @session-stale-criteria ac-6
  it("rejects absolute timestamps for criteria flags", () => {
    const resolved = resolveStaleSessionCriteria({
      inactiveFor: "2026-02-27T12:00:00Z",
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.field).toBe("inactive-for");
    expect(resolved.message).toContain("absolute timestamps are not supported");
    expect(resolved.guidance).toContain("relative durations only");
  });

  // AC: @session-stale-criteria ac-1
  it("marks session eligible when age and inactivity thresholds both match", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000001";
    await createSession(specDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-26T00:00:00.000Z",
    });
    await appendEvent(specDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T12:00:00.000Z").getTime(),
      data: { update: "idle" },
    });

    const result = await selectStaleActiveSessions(
      specDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sessionId).toBe(sessionId);
  });

  // AC: @session-stale-criteria ac-2
  it("uses started_at as last-activity fallback when events are missing", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000002";
    await createSession(specDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-26T12:00:00.000Z",
    });

    const result = await selectStaleActiveSessions(
      specDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].lastActivitySource).toBe("started_at");
    expect(result.candidates[0].sessionId).toBe(sessionId);
  });

  // AC: @session-stale-criteria ac-3
  it("applies older-than and inactive-for with AND logic", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000003";
    await createSession(specDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-24T00:00:00.000Z",
    });
    await appendEvent(specDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T21:00:00.000Z").getTime(),
      data: { update: "recent-ish" },
    });

    const result = await selectStaleActiveSessions(
      specDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].meetsAgeThreshold).toBe(true);
    expect(result.evaluations[0].meetsInactivityThreshold).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  // AC: @session-stale-criteria ac-7
  it("skips and reports sessions with corrupt events.jsonl", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000004";
    await createSession(specDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-24T00:00:00.000Z",
    });
    await fs.writeFile(
      getSessionEventsPath(specDir, sessionId),
      '{"ts":1700000000000,"seq":0,"type":"session.update","session_id":"x","data":{}}\n{not-json}\n',
      "utf-8",
    );

    const result = await selectStaleActiveSessions(
      specDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.skipped[0].sessionId).toBe(sessionId);
    expect(result.skipped[0].reason).toBe("events_corrupt");
    expect(result.skipped[0].detail).toContain("invalid line 2");
  });

  // AC: @session-stale-criteria ac-8
  it("blocks closure when session has recent activity inside liveness guard window", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000005";
    await createSession(specDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-20T00:00:00.000Z",
    });
    await appendEvent(specDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T23:58:00.000Z").getTime(),
      data: { update: "very recent" },
    });

    const result = await selectStaleActiveSessions(
      specDir,
      { olderThan: "24h", inactiveFor: "1m" },
      nowMs,
    );
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].meetsAgeThreshold).toBe(true);
    expect(result.evaluations[0].meetsInactivityThreshold).toBe(true);
    expect(result.evaluations[0].blockedByLivenessGuard).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });
});
