import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyAutoAbandonMetadata,
  appendEvent,
  createSession,
  getSession,
  getSessionEventsPath,
  resolveStaleSessionCriteria,
  selectStaleActiveSessions,
} from "../src/sessions/store.js";

describe("stale session criteria", () => {
  let specDir: string;
  let sessionsDir: string;
  const nowIso = "2026-02-28T00:00:00.000Z";
  const nowMs = new Date(nowIso).getTime();

  beforeEach(async () => {
    specDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-stale-session-"));
    sessionsDir = path.join(specDir, "sessions");
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
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-26T00:00:00.000Z",
    });
    await appendEvent(sessionsDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T12:00:00.000Z").getTime(),
      data: { update: "idle" },
    });

    const result = await selectStaleActiveSessions(
      sessionsDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].sessionId).toBe(sessionId);
  });

  // AC: @session-stale-criteria ac-2
  it("uses started_at as last-activity fallback when events are missing", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000002";
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-26T12:00:00.000Z",
    });

    const result = await selectStaleActiveSessions(
      sessionsDir,
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
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-24T00:00:00.000Z",
    });
    await appendEvent(sessionsDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T21:00:00.000Z").getTime(),
      data: { update: "recent-ish" },
    });

    const result = await selectStaleActiveSessions(
      sessionsDir,
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
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-24T00:00:00.000Z",
    });
    await fs.writeFile(
      getSessionEventsPath(sessionsDir, sessionId),
      '{"ts":1700000000000,"seq":0,"type":"session.update","session_id":"x","data":{}}\n{not-json}\n',
      "utf-8",
    );

    const result = await selectStaleActiveSessions(
      sessionsDir,
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

  // AC: @session-stale-criteria ac-7
  it("skips and reports sessions with unreadable events.jsonl", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A000000A";
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-24T00:00:00.000Z",
    });
    await fs.mkdir(getSessionEventsPath(sessionsDir, sessionId), {
      recursive: true,
    });

    const result = await selectStaleActiveSessions(
      sessionsDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.skipped[0].sessionId).toBe(sessionId);
    expect(result.skipped[0].reason).toBe("events_unreadable");
    expect(result.skipped[0].detail).toContain("Unable to read events.jsonl");
    expect(result.skipped[0].detail).toContain(sessionId);
  });

  // AC: @session-stale-criteria ac-8
  it("blocks closure when session has recent activity inside liveness guard window", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000005";
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-20T00:00:00.000Z",
    });
    await appendEvent(sessionsDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T23:58:00.000Z").getTime(),
      data: { update: "very recent" },
    });

    const result = await selectStaleActiveSessions(
      sessionsDir,
      { olderThan: "24h", inactiveFor: "1m" },
      nowMs,
    );
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].meetsAgeThreshold).toBe(true);
    expect(result.evaluations[0].meetsInactivityThreshold).toBe(true);
    expect(result.evaluations[0].blockedByLivenessGuard).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  // AC: @session-stale-close-metadata ac-1
  // AC: @session-stale-close-metadata ac-2
  it("writes abandoned status with canonical auto-abandoned close_reason", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000006";
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-20T00:00:00.000Z",
    });
    await appendEvent(sessionsDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T12:00:00.000Z").getTime(),
      data: { update: "idle" },
    });

    const selection = await selectStaleActiveSessions(
      sessionsDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    const applied = await applyAutoAbandonMetadata(sessionsDir, selection, {
      nowMs,
    });

    expect(applied.updatedCount).toBe(1);
    const updated = await getSession(sessionsDir, sessionId);
    expect(updated?.status).toBe("abandoned");
    expect(updated?.ended_at).toBe(nowIso);
    expect(updated?.close_reason?.startsWith("auto-abandoned:")).toBe(true);
    expect(updated?.close_reason).toContain("older-than=24h");
    expect(updated?.close_reason).toContain("inactive-for=6h");
    expect(updated?.close_reason).toContain("liveness-guard=5m");
    expect(updated?.close_reason).toContain("last-activity=2026-02-27T12:00:00.000Z");
  });

  // AC: @session-stale-close-metadata ac-3
  it("applies batch metadata updates for multiple sessions in one invocation", async () => {
    const sessionA = "01KJHSTAL3CR1T3R1A0000007";
    const sessionB = "01KJHSTAL3CR1T3R1A0000008";
    await createSession(sessionsDir, {
      id: sessionA,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-20T00:00:00.000Z",
    });
    await createSession(sessionsDir, {
      id: sessionB,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-19T00:00:00.000Z",
    });

    const selection = await selectStaleActiveSessions(
      sessionsDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    const applied = await applyAutoAbandonMetadata(sessionsDir, selection, {
      nowMs,
    });

    expect(applied.updatedCount).toBe(2);
    expect(applied.updates).toHaveLength(2);
    expect(applied.updates[0].endedAt).toBe(nowIso);
    expect(applied.updates[1].endedAt).toBe(nowIso);
    expect(applied.updates[0].closeReason.startsWith("auto-abandoned:")).toBe(true);
    expect(applied.updates[1].closeReason.startsWith("auto-abandoned:")).toBe(true);

    const updatedA = await getSession(sessionsDir, sessionA);
    const updatedB = await getSession(sessionsDir, sessionB);
    expect(updatedA?.status).toBe("abandoned");
    expect(updatedB?.status).toBe("abandoned");
    expect(updatedA?.ended_at).toBe(nowIso);
    expect(updatedB?.ended_at).toBe(nowIso);
  });

  // AC: @session-remove-shadow-commits ac-stale-cleanup
  it("does not commit to kspec-meta when abandoning stale sessions", async () => {
    const sessionA = "01KJHSTAL3CR1T3R1A000000B";
    const sessionB = "01KJHSTAL3CR1T3R1A000000C";
    await createSession(sessionsDir, {
      id: sessionA,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-20T00:00:00.000Z",
    });
    await createSession(sessionsDir, {
      id: sessionB,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-19T00:00:00.000Z",
    });

    const selection = await selectStaleActiveSessions(
      sessionsDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    const applied = await applyAutoAbandonMetadata(sessionsDir, selection, {
      nowMs,
    });

    expect(applied.updatedCount).toBe(2);
    // No shadowCommitted field — sessions no longer commit to kspec-meta
    expect("shadowCommitted" in applied).toBe(false);
  });

  // AC: @session-stale-close-metadata ac-4
  it("returns preview close_reason in dry-run mode without changing files", async () => {
    const sessionId = "01KJHSTAL3CR1T3R1A0000009";
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "ralph",
      status: "active",
      started_at: "2026-02-20T00:00:00.000Z",
    });
    await appendEvent(sessionsDir, {
      session_id: sessionId,
      type: "session.update",
      ts: new Date("2026-02-27T12:00:00.000Z").getTime(),
      data: { update: "idle" },
    });

    const before = await getSession(sessionsDir, sessionId);
    const selection = await selectStaleActiveSessions(
      sessionsDir,
      { olderThan: "24h", inactiveFor: "6h" },
      nowMs,
    );
    const applied = await applyAutoAbandonMetadata(sessionsDir, selection, {
      dryRun: true,
      nowMs,
    });
    const after = await getSession(sessionsDir, sessionId);

    expect(applied.dryRun).toBe(true);
    expect(applied.updatedCount).toBe(1);
    expect(applied.updates[0].closeReason.startsWith("auto-abandoned:")).toBe(true);
    expect(applied.updates[0].closeReason).toContain("older-than=24h");

    expect(after?.status).toBe(before?.status);
    expect(after?.ended_at).toBe(before?.ended_at);
    expect(after?.close_reason).toBe(before?.close_reason);
  });
});
