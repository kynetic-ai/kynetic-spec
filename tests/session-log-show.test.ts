/**
 * Session log show tests.
 *
 * Tests for the `kspec session log show` command and supporting store functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  createSession,
  saveSessionContext,
  resolveSessionId,
  getSessionLogDetail,
  type SessionLogDetail,
} from "../src/sessions/store.js";
import { setupTempFixtures, cleanupTempDir, kspec, kspecJson, testUlid } from "./helpers/cli";

// ─── Store Unit Tests ───────────────────────────────────────────────────────

describe("resolveSessionId", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-session-show-"));
    sessionsDir = path.join(testDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  // AC: @session-log-show ac-9
  it("should return not_found for nonexistent session", async () => {
    const result = await resolveSessionId(sessionsDir, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not_found");
    }
  });

  // AC: @session-log-show ac-7
  it("should resolve exact session ID", async () => {
    const sessionId = testUlid("SESS");
    await createSession(sessionsDir, { id: sessionId, agent_type: "test-agent" });

    const result = await resolveSessionId(sessionsDir, sessionId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe(sessionId);
    }
  });

  // AC: @session-log-show ac-7
  it("should resolve unique prefix to full session ID", async () => {
    const sessionId = testUlid("SESS");
    await createSession(sessionsDir, { id: sessionId, agent_type: "test-agent" });

    // Use first 8 chars as prefix
    const prefix = sessionId.slice(0, 8);
    const result = await resolveSessionId(sessionsDir, prefix);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe(sessionId);
    }
  });

  // AC: @session-log-show ac-8
  it("should return ambiguous error for multiple matches", async () => {
    // Create two sessions with similar prefixes
    const id1 = "01SESS00000000000000000001";
    const id2 = "01SESS00000000000000000002";
    await createSession(sessionsDir, { id: id1, agent_type: "test-agent" });
    await createSession(sessionsDir, { id: id2, agent_type: "test-agent" });

    const result = await resolveSessionId(sessionsDir, "01SESS");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("ambiguous");
      expect(result.matches).toContain(id1);
      expect(result.matches).toContain(id2);
    }
  });
});

describe("getSessionLogDetail", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-session-detail-"));
    sessionsDir = path.join(testDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it("should return null for nonexistent session", async () => {
    const detail = await getSessionLogDetail(sessionsDir, "nonexistent");
    expect(detail).toBeNull();
  });

  // AC: @session-log-show ac-1
  it("should return detail with all metadata fields", async () => {
    const sessionId = testUlid("SESS");
    const startedAt = "2026-01-20T10:00:00.000Z";
    const endedAt = "2026-01-20T11:30:00.000Z";

    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-agent-acp",
      task_id: "@my-task",
      started_at: startedAt,
    });

    // Simulate completion by writing metadata directly
    const metaPath = path.join(sessionsDir, sessionId, "session.yaml");
    await fs.writeFile(
      metaPath,
      YAML.stringify({
        id: sessionId,
        agent_type: "claude-agent-acp",
        task_id: "@my-task",
        status: "completed",
        started_at: startedAt,
        ended_at: endedAt,
      }),
    );

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(sessionId);
    expect(detail!.status).toBe("completed");
    expect(detail!.agent_type).toBe("claude-agent-acp");
    expect(detail!.task_id).toBe("@my-task");
    expect(detail!.started_at).toBe(startedAt);
    expect(detail!.ended_at).toBe(endedAt);
    expect(detail!.duration_ms).toBe(5400000); // 1.5 hours
  });

  // AC: @session-log-show ac-2
  it("should compute per-iteration summaries with boundaries", async () => {
    const sessionId = testUlid("SESS", 1);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    // Add context snapshots
    await saveSessionContext(sessionsDir, sessionId, 1, { iteration: 1 });
    await saveSessionContext(sessionsDir, sessionId, 2, { iteration: 2 });

    // Add events with prompt.sent boundaries (phase: task-work)
    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const events = [
      {
        ts: 1000,
        seq: 0,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 1 },
      },
      {
        ts: 2000,
        seq: 1,
        type: "session.update",
        session_id: sessionId,
        data: {
          iteration: 1,
          update: {
            sessionUpdate: "tool_call",
            rawInput: { command: "kspec task start @task-1" },
          },
        },
      },
      {
        ts: 3000,
        seq: 2,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 2 },
      },
      {
        ts: 4000,
        seq: 3,
        type: "session.update",
        session_id: sessionId,
        data: {
          iteration: 2,
          update: {
            sessionUpdate: "tool_call",
            rawInput: { command: 'kspec task complete @task-1 --reason "Done"' },
          },
        },
      },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.iteration_count).toBe(2);
    expect(detail!.iterations).toHaveLength(2);

    const iter1 = detail!.iterations.find((i) => i.iteration === 1);
    const iter2 = detail!.iterations.find((i) => i.iteration === 2);
    expect(iter1).toBeDefined();
    expect(iter2).toBeDefined();
    expect(iter1!.tasks_started).toContain("@task-1");
    expect(iter2!.tasks_completed).toContain("@task-1");
  });

  // AC: @session-log-show ac-10 — wrong data.iteration on streaming events, still grouped correctly
  it("should group by boundary position even when data.iteration is wrong", async () => {
    const sessionId = testUlid("SESS", 2);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const events = [
      // Iteration 1 boundary
      {
        ts: 1000,
        seq: 0,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 1 },
      },
      // These events have WRONG data.iteration (race condition bug)
      {
        ts: 2000,
        seq: 1,
        type: "session.update",
        session_id: sessionId,
        data: { iteration: 4, update: { sessionUpdate: "tool_call", rawInput: { command: "ls" } } },
      },
      {
        ts: 3000,
        seq: 2,
        type: "session.update",
        session_id: sessionId,
        data: {
          iteration: 4,
          update: { sessionUpdate: "tool_call", rawInput: { command: "cat file" } },
        },
      },
      // Iteration 2 boundary
      {
        ts: 4000,
        seq: 3,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 2 },
      },
      // More events with wrong iteration
      {
        ts: 5000,
        seq: 4,
        type: "session.update",
        session_id: sessionId,
        data: {
          iteration: 4,
          update: { sessionUpdate: "tool_call", rawInput: { command: "echo hi" } },
        },
      },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.iterations).toHaveLength(2);

    // Boundary-based: iter 1 gets events at indices 0,1,2 (3 events)
    // iter 2 gets events at indices 3,4 (2 events)
    const iter1 = detail!.iterations.find((i) => i.iteration === 1);
    const iter2 = detail!.iterations.find((i) => i.iteration === 2);
    expect(iter1!.event_count).toBe(3);
    expect(iter2!.event_count).toBe(2);
  });

  // AC: @session-log-show ac-10 — legacy fallback when no prompt.sent boundaries exist
  it("should fall back to legacy data.iteration grouping without boundaries", async () => {
    const sessionId = testUlid("SESS", 3);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    await saveSessionContext(sessionsDir, sessionId, 1, { iteration: 1 });

    // Events with data.iteration but NO prompt.sent with phase: task-work
    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const events = [
      { ts: 1000, seq: 0, type: "session.start", session_id: sessionId, data: { iteration: 1 } },
      {
        ts: 2000,
        seq: 1,
        type: "session.update",
        session_id: sessionId,
        data: { iteration: 1, update: { sessionUpdate: "tool_call", rawInput: { command: "ls" } } },
      },
      { ts: 3000, seq: 2, type: "prompt.sent", session_id: sessionId, data: { iteration: 2 } }, // No phase field
      {
        ts: 4000,
        seq: 3,
        type: "session.update",
        session_id: sessionId,
        data: {
          iteration: 2,
          update: { sessionUpdate: "tool_call", rawInput: { command: "cat" } },
        },
      },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.iterations).toHaveLength(2);

    const iter1 = detail!.iterations.find((i) => i.iteration === 1);
    const iter2 = detail!.iterations.find((i) => i.iteration === 2);
    expect(iter1!.event_count).toBe(2);
    expect(iter2!.event_count).toBe(2);
  });

  // AC: @session-log-show ac-10 — pre-boundary events merge into first iteration
  it("should merge pre-boundary events into first iteration", async () => {
    const sessionId = testUlid("SESS", 4);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const events = [
      // Pre-boundary events (session.start before any prompt.sent)
      { ts: 1000, seq: 0, type: "session.start", session_id: sessionId, data: null },
      {
        ts: 1500,
        seq: 1,
        type: "session.update",
        session_id: sessionId,
        data: {
          update: { sessionUpdate: "tool_call", rawInput: { command: "kspec task start @task-1" } },
        },
      },
      // First boundary
      {
        ts: 2000,
        seq: 2,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 1 },
      },
      {
        ts: 3000,
        seq: 3,
        type: "session.update",
        session_id: sessionId,
        data: { iteration: 1, update: { sessionUpdate: "tool_call", rawInput: { command: "ls" } } },
      },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.iterations).toHaveLength(1);
    // All 4 events in iteration 1 (2 pre-boundary + 2 from boundary range)
    expect(detail!.iterations[0].event_count).toBe(4);
    // Pre-boundary task start should be captured
    expect(detail!.iterations[0].tasks_started).toContain("@task-1");
  });

  // AC: @session-log-show ac-10 — single iteration captures all events
  it("should handle single iteration with one boundary", async () => {
    const sessionId = testUlid("SESS", 5);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const events = [
      {
        ts: 1000,
        seq: 0,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 1 },
      },
      {
        ts: 2000,
        seq: 1,
        type: "session.update",
        session_id: sessionId,
        data: { iteration: 1, update: { sessionUpdate: "tool_call", rawInput: { command: "ls" } } },
      },
      {
        ts: 3000,
        seq: 2,
        type: "session.end",
        session_id: sessionId,
        data: { reason: "completed" },
      },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.iterations).toHaveLength(1);
    expect(detail!.iterations[0].event_count).toBe(3);
    expect(detail!.iteration_count).toBe(1);
  });

  // AC: @session-log-show ac-10 — mixed phase prompt.sent (only task-work used as boundaries)
  it("should only use task-work phase prompt.sent as boundaries", async () => {
    const sessionId = testUlid("SESS", 6);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const events = [
      {
        ts: 1000,
        seq: 0,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 1 },
      },
      { ts: 2000, seq: 1, type: "session.update", session_id: sessionId, data: { iteration: 1 } },
      // Reflect prompt.sent — NOT a boundary
      {
        ts: 3000,
        seq: 2,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "reflect", iteration: 1 },
      },
      {
        ts: 4000,
        seq: 3,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 2 },
      },
      { ts: 5000, seq: 4, type: "session.update", session_id: sessionId, data: { iteration: 2 } },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    // Only 2 iterations (task-work boundaries), not 3
    expect(detail!.iterations).toHaveLength(2);

    const iter1 = detail!.iterations.find((i) => i.iteration === 1);
    const iter2 = detail!.iterations.find((i) => i.iteration === 2);
    // Iter 1: events at indices 0,1,2 (prompt.sent task-work, update, reflect)
    expect(iter1!.event_count).toBe(3);
    // Iter 2: events at indices 3,4
    expect(iter2!.event_count).toBe(2);
  });

  // AC: @session-log-show ac-10 — malformed boundaries gracefully fall back
  it("should fall back to legacy when prompt.sent has missing phase/iteration", async () => {
    const sessionId = testUlid("SESS", 7);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    await saveSessionContext(sessionsDir, sessionId, 1, { iteration: 1 });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const events = [
      // prompt.sent without phase field — not a valid boundary
      { ts: 1000, seq: 0, type: "prompt.sent", session_id: sessionId, data: { iteration: 1 } },
      {
        ts: 2000,
        seq: 1,
        type: "session.update",
        session_id: sessionId,
        data: { iteration: 1, update: { sessionUpdate: "tool_call", rawInput: { command: "ls" } } },
      },
      // prompt.sent with phase but missing iteration — not a valid boundary
      {
        ts: 3000,
        seq: 2,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work" },
      },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    // Falls back to legacy: iteration 1 from data.iteration
    expect(detail!.iterations.length).toBeGreaterThan(0);
    expect(detail!.iterations[0].iteration).toBe(1);
  });

  // AC: @session-log-show ac-10 — duplicate seq values don't affect boundary math
  it("should handle duplicate seq values with correct boundary grouping", async () => {
    const sessionId = testUlid("SESS", 8);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    // Simulate concurrent appends producing duplicate seq numbers
    const events = [
      {
        ts: 1000,
        seq: 0,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 1 },
      },
      { ts: 2000, seq: 1, type: "session.update", session_id: sessionId, data: { iteration: 1 } },
      { ts: 2001, seq: 1, type: "session.update", session_id: sessionId, data: { iteration: 1 } }, // Duplicate seq!
      {
        ts: 3000,
        seq: 2,
        type: "prompt.sent",
        session_id: sessionId,
        data: { phase: "task-work", iteration: 2 },
      },
      { ts: 4000, seq: 3, type: "session.update", session_id: sessionId, data: { iteration: 2 } },
    ];
    await fs.writeFile(eventsPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    const detail = await getSessionLogDetail(sessionsDir, sessionId);
    expect(detail).not.toBeNull();
    expect(detail!.iterations).toHaveLength(2);
    // readEvents sorts by seq, so duplicate seq events are adjacent.
    // Boundary at index of first prompt.sent, second boundary at index of second prompt.sent.
    // The exact counts depend on sort stability, but total should be 5
    const totalEvents = detail!.iterations.reduce((sum, i) => sum + i.event_count, 0);
    expect(totalEvents).toBe(5);
  });
});

// ─── CLI Integration Tests ──────────────────────────────────────────────────

describe("kspec session log show (CLI)", () => {
  let tempDir: string;
  const sessionId1 = testUlid("SESS", 1);
  const sessionId2 = testUlid("SESS", 2);

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // In traditional mode (no shadow branch), specDir = tempDir
    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session 1: completed with events and context
    const s1Dir = path.join(sessionsDir, sessionId1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(
      path.join(s1Dir, "session.yaml"),
      YAML.stringify({
        id: sessionId1,
        agent_type: "claude-agent-acp",
        task_id: "@my-task",
        status: "completed",
        started_at: "2026-01-15T10:00:00.000Z",
        ended_at: "2026-01-15T11:30:00.000Z",
      }),
    );
    const blobRelPath = "blobs/session-show-output.blob";
    const blobContent = "FULL_BLOB_CONTENT_FOR_SHOW_RESOLUTION";
    await fs.mkdir(path.join(s1Dir, "blobs"), { recursive: true });
    await fs.writeFile(path.join(s1Dir, blobRelPath), blobContent, "utf-8");
    await fs.writeFile(
      path.join(s1Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 1000,
          seq: 0,
          type: "session.start",
          session_id: sessionId1,
          data: { iteration: 1 },
        }),
        JSON.stringify({
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: sessionId1,
          data: {
            iteration: 1,
            update: {
              _meta: { claudeCode: { toolName: "Bash" } },
              sessionUpdate: "tool_call",
              rawInput: { command: "kspec task start @my-task" },
            },
          },
        }),
        JSON.stringify({
          ts: 3000,
          seq: 2,
          type: "prompt.sent",
          session_id: sessionId1,
          data: { phase: "task-work", iteration: 1, prompt: "Continue the task" },
        }),
        JSON.stringify({
          ts: 4000,
          seq: 3,
          type: "tool.call",
          session_id: sessionId1,
          data: { iteration: 1, tool: "Read" },
        }),
        JSON.stringify({
          ts: 4500,
          seq: 4,
          type: "tool.result",
          session_id: sessionId1,
          data: {
            output: {
              path: blobRelPath,
              bytes: blobContent.length,
              sha256: "test-hash",
              truncated: true,
              preview: "PREVIEW_ONLY_SHOW",
            },
          },
        }),
        JSON.stringify({
          ts: 5000,
          seq: 5,
          type: "session.end",
          session_id: sessionId1,
          data: { reason: "completed" },
        }),
      ].join("\n")}\n`,
    );
    await fs.writeFile(
      path.join(s1Dir, "context-iter-1.json"),
      JSON.stringify({ focus: "test focus", ready_tasks: [] }),
    );

    // Session 2: active, different prefix
    const s2Dir = path.join(sessionsDir, sessionId2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(
      path.join(s2Dir, "session.yaml"),
      YAML.stringify({
        id: sessionId2,
        agent_type: "custom-agent",
        status: "active",
        started_at: "2026-02-05T08:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s2Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 1000,
          seq: 0,
          type: "session.start",
          session_id: sessionId2,
          data: null,
        }),
      ].join("\n")}\n`,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-log-show ac-1
  it("should display session metadata", () => {
    const result = kspec(`session log show ${sessionId1}`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Session");
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Agent");
    expect(result.stdout).toContain("Started");
    expect(result.stdout).toContain("Ended");
    expect(result.stdout).toContain("Duration");
    expect(result.stdout).toContain("claude-agent-acp");
  });

  // AC: @session-log-show ac-1 - JSON output
  it("should output valid JSON with metadata in --json mode", () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    expect(detail.id).toBe(sessionId1);
    expect(detail.status).toBe("completed");
    expect(detail.agent_type).toBe("claude-agent-acp");
    expect(detail.task_id).toBe("@my-task");
    expect(detail.started_at).toBe("2026-01-15T10:00:00.000Z");
    expect(detail.ended_at).toBe("2026-01-15T11:30:00.000Z");
    expect(detail.duration_ms).toBe(5400000);
  });

  // AC: @session-log-show ac-2
  it("should display per-iteration summary", () => {
    const result = kspec(`session log show ${sessionId1}`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Iterations");
    expect(result.stdout).toContain("[1]");
  });

  // AC: @session-log-show ac-2 - JSON output
  it("should include iterations array in JSON output", () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    expect(detail.iterations).toBeDefined();
    expect(detail.iterations.length).toBeGreaterThan(0);
    const iter1 = detail.iterations[0];
    expect(iter1.iteration).toBe(1);
    expect(iter1.event_count).toBeGreaterThan(0);
    expect(iter1.tasks_started).toContain("@my-task");
  });

  // AC: @session-log-show ac-3
  it("should display event timeline with --events flag", () => {
    const result = kspec(`session log show ${sessionId1} --events`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Events");
    expect(result.stdout).toContain("session.start");
    expect(result.stdout).toContain("session.update");
    expect(result.stdout).toContain("session.end");
  });

  // AC: @session-log-show ac-3 - JSON output with events
  it("should include events array in JSON output with --events", () => {
    const detail = kspecJson<SessionLogDetail & { events?: unknown[] }>(
      `session log show ${sessionId1} --events`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(6);
  });

  // AC: @session-log-show ac-4
  it("should filter events by --type", () => {
    const detail = kspecJson<SessionLogDetail & { events?: Array<{ type: string }> }>(
      `session log show ${sessionId1} --events --type session.update`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(1);
    expect(detail.events![0].type).toBe("session.update");
  });

  // AC: @session-log-show ac-4 - filter by tool.call
  it("should filter events by --type tool.call", () => {
    const detail = kspecJson<SessionLogDetail & { events?: Array<{ type: string }> }>(
      `session log show ${sessionId1} --events --type tool.call`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(1);
    expect(detail.events![0].type).toBe("tool.call");
  });

  // AC: @session-log-show ac-5
  it("should limit to last N events with --limit", () => {
    const detail = kspecJson<SessionLogDetail & { events?: Array<{ type: string }> }>(
      `session log show ${sessionId1} --events --limit 2`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(2);
    // Should be the last 2 events (tool.result and session.end)
    expect(detail.events![0].type).toBe("tool.result");
    expect(detail.events![1].type).toBe("session.end");
  });

  // AC: @session-log-show ac-6
  it("should display context snapshot with --context N", () => {
    const result = kspec(`session log show ${sessionId1} --context 1`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Context Snapshot");
    expect(result.stdout).toContain("focus");
    expect(result.stdout).toContain("test focus");
  });

  // AC: @session-log-show ac-6 - JSON output with context
  it("should include context in JSON output with --context N", () => {
    const detail = kspecJson<SessionLogDetail & { context?: { focus: string } }>(
      `session log show ${sessionId1} --context 1`,
      tempDir,
    );
    expect(detail.context).toBeDefined();
    expect(detail.context!.focus).toBe("test focus");
  });

  // AC: @session-log-show ac-6 - error for nonexistent iteration
  it("should error when --context N references nonexistent iteration", () => {
    const result = kspec(`session log show ${sessionId1} --context 99`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No context snapshot found for iteration 99");
  });

  // AC: @session-log-show ac-7
  it("should resolve session by unique prefix", () => {
    // Use a more specific prefix that uniquely identifies session1
    // sessionId1 = 01SESS00000001... and sessionId2 = 01SESS00000002...
    // They differ at position 14, so we need at least 15 chars
    const prefix = sessionId1.slice(0, 15);
    const detail = kspecJson<SessionLogDetail>(`session log show ${prefix}`, tempDir);
    expect(detail.id).toBe(sessionId1);
  });

  // AC: @session-log-show ac-8
  it("should error on ambiguous prefix with guidance", async () => {
    // Create two more sessions with same prefix
    const ambig1 = "01AMBG00000000000000000001";
    const ambig2 = "01AMBG00000000000000000002";
    const sessionsDir = path.join(tempDir, ".kspec-sessions");

    const a1Dir = path.join(sessionsDir, ambig1);
    await fs.mkdir(a1Dir);
    await fs.writeFile(
      path.join(a1Dir, "session.yaml"),
      YAML.stringify({
        id: ambig1,
        agent_type: "test-agent",
        status: "active",
        started_at: "2026-01-01T00:00:00.000Z",
      }),
    );

    const a2Dir = path.join(sessionsDir, ambig2);
    await fs.mkdir(a2Dir);
    await fs.writeFile(
      path.join(a2Dir, "session.yaml"),
      YAML.stringify({
        id: ambig2,
        agent_type: "test-agent",
        status: "active",
        started_at: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = kspec("session log show 01AMBG", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Ambiguous");
    expect(result.stderr).toContain(ambig1);
    expect(result.stderr).toContain(ambig2);
    expect(result.stderr).toContain("more specific");
  });

  // AC: @session-log-show ac-9
  it('should error with "Session not found" for nonexistent ID', () => {
    const result = kspec("session log show NONEXISTENT", tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Session not found");
  });

  // AC: @session-log-show ac-11
  it("should replay assistant text from session.update events with --text", async () => {
    const s1Dir = path.join(tempDir, ".kspec-sessions", sessionId1);
    const textBlobRelPath = "blobs/session-show-text.blob";
    await fs.writeFile(path.join(s1Dir, textBlobRelPath), "world", "utf-8");

    await fs.writeFile(
      path.join(s1Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: sessionId1,
          data: {
            content: [
              { type: "text", text: "Hello " },
              {
                type: "text",
                text: {
                  path: textBlobRelPath,
                  bytes: 5,
                  sha256: "text-blob-hash",
                  truncated: true,
                  preview: "wor",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: sessionId1,
          data: {
            content: { type: "text", text: "!" },
          },
        }),
        JSON.stringify({
          ts: 3000,
          seq: 2,
          type: "session.update",
          session_id: sessionId1,
          data: {
            sessionUpdate: "tool_call_update",
            content: [{ type: "content", content: { type: "text", text: "TOOL_NOISE" } }],
          },
        }),
      ].join("\n")}\n`,
    );

    const result = kspec(`session log show ${sessionId1} --text`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello world!");
    expect(result.stdout).not.toContain("TOOL_NOISE");
    expect(result.stdout).not.toContain("Session");
  });

  // AC: @session-log-show ac-11
  // AC: @trait-json-output ac-6
  it("should support --text and --events together in JSON output", async () => {
    const s1Dir = path.join(tempDir, ".kspec-sessions", sessionId1);
    await fs.writeFile(
      path.join(s1Dir, "events.jsonl"),
      `${[
        JSON.stringify({
          ts: 1000,
          seq: 0,
          type: "session.update",
          session_id: sessionId1,
          data: { content: [{ type: "text", text: "alpha" }] },
        }),
        JSON.stringify({
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: sessionId1,
          data: { content: [{ type: "text", text: "beta" }] },
        }),
      ].join("\n")}\n`,
    );

    const detail = kspecJson<
      SessionLogDetail & {
        text?: string;
        events?: Array<{ type: string }>;
      }
    >(`session log show ${sessionId1} --json --text --events`, tempDir);
    expect(detail.text).toBe("alphabeta");
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(2);
    expect(detail.events![0].type).toBe("session.update");
    expect(detail.events![1].type).toBe("session.update");
  });

  // AC: @trait-json-output ac-1
  it("should have no ANSI codes in JSON output", () => {
    const result = kspec(`session log show ${sessionId1} --json`, tempDir);
    // oxlint-disable-next-line eslint(no-control-regex) -- intentionally matching ANSI escape
    expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
  });

  // AC: @trait-json-output ac-5
  it("should use ISO 8601 timestamps in JSON output", () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    expect(detail.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (detail.ended_at) {
      expect(detail.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  // AC: @trait-semantic-exit-codes ac-1
  it("should exit with code 0 on success", () => {
    const result = kspec(`session log show ${sessionId1}`, tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-json-output ac-3
  it("should return JSON error object for not-found in --json mode", () => {
    const result = kspec("session log show NONEXISTENT --json", tempDir, { expectFail: true });
    const output = result.stderr || result.stdout;
    const parsed = JSON.parse(output);
    expect(parsed.error).toBeDefined();
  });

  // AC: @trait-semantic-exit-codes ac-4
  it("should exit with code 3 (runtime error) for not found", () => {
    const result = kspec("session log show NONEXISTENT", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(3);
  });

  // Combined flags: events + limit + type
  it("should support combined --events --type --limit flags", () => {
    const detail = kspecJson<SessionLogDetail & { events?: unknown[] }>(
      `session log show ${sessionId1} --events --type prompt.sent --limit 1`,
      tempDir,
    );
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(1);
  });

  it("should keep blob pointer previews by default in --events JSON output", () => {
    const detail = kspecJson<
      SessionLogDetail & {
        events?: Array<{ type: string; data: Record<string, unknown> }>;
      }
    >(`session log show ${sessionId1} --events`, tempDir);
    const toolResult = detail.events!.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    const output = toolResult!.data.output as {
      preview?: string;
      content?: string;
    };
    expect(output.preview).toBe("PREVIEW_ONLY_SHOW");
    expect(output.content).toBeUndefined();
  });

  it("should resolve blob content on demand with --resolve-blobs", () => {
    const detail = kspecJson<
      SessionLogDetail & {
        events?: Array<{ type: string; data: Record<string, unknown> }>;
      }
    >(`session log show ${sessionId1} --events --resolve-blobs`, tempDir);
    const toolResult = detail.events!.find((e) => e.type === "tool.result");
    expect(toolResult).toBeDefined();
    const output = toolResult!.data.output as {
      preview?: string;
      content?: string;
    };
    expect(output.preview).toBe("PREVIEW_ONLY_SHOW");
    expect(output.content).toBe("FULL_BLOB_CONTENT_FOR_SHOW_RESOLUTION");
  });

  it("should warn when --resolve-blobs is used without --events", () => {
    const result = kspec(`session log show ${sessionId1} --resolve-blobs`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("--resolve-blobs has no effect without --events");
  });

  // Show active session
  it("should show active session without ended_at", () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId2}`, tempDir);
    expect(detail.status).toBe("active");
    expect(detail.ended_at).toBeUndefined();
    expect(detail.duration_ms).toBeGreaterThan(0);
  });

  // ─── Trait AC: @trait-json-output ──────────────────────────────────────────

  // AC: @trait-json-output ac-2
  it("should include all human-readable data in JSON output", () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    // JSON must include all fields shown in human-readable: id, status, agent_type, task_id,
    // started_at, ended_at, duration_ms, event_count, iteration_count, iterations
    expect(detail.id).toBe(sessionId1);
    expect(detail.status).toBe("completed");
    expect(detail.agent_type).toBe("claude-agent-acp");
    expect(detail.task_id).toBe("@my-task");
    expect(detail.started_at).toBeDefined();
    expect(detail.ended_at).toBeDefined();
    expect(detail.duration_ms).toBeGreaterThan(0);
    expect(detail.event_count).toBeGreaterThan(0);
    expect(detail.iteration_count).toBeGreaterThanOrEqual(1);
    expect(detail.iterations).toBeDefined();
    expect(detail.iterations.length).toBeGreaterThan(0);
    // Each iteration has all fields shown in human-readable output
    const iter = detail.iterations[0];
    expect(iter.iteration).toBeDefined();
    expect(iter.event_count).toBeDefined();
    expect(iter.tasks_started).toBeDefined();
    expect(iter.tasks_completed).toBeDefined();
  });

  // AC: @trait-json-output ac-4
  it("should use @ prefix for references in JSON output", () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId1}`, tempDir);
    // task_id should have @ prefix
    expect(detail.task_id).toMatch(/^@/);
    // task refs in iteration summaries should have @ prefix
    for (const iter of detail.iterations) {
      for (const ref of iter.tasks_started) {
        expect(ref).toMatch(/^@/);
      }
      for (const ref of iter.tasks_completed) {
        expect(ref).toMatch(/^@/);
      }
    }
  });

  // AC: @trait-json-output ac-6
  it("should use JSON output when --json is combined with --events", () => {
    const result = kspec(`session log show ${sessionId1} --json --events`, tempDir);
    expect(result.exitCode).toBe(0);
    // Should be valid JSON, not human-readable text
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe(sessionId1);
    expect(parsed.events).toBeDefined();
    // Should have no ANSI escape codes
    // oxlint-disable-next-line eslint(no-control-regex) -- intentionally matching ANSI escape
    expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
  });

  // AC: @trait-json-output ac-6
  it("should use JSON output when --json is combined with --context", () => {
    const result = kspec(`session log show ${sessionId1} --json --context 1`, tempDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe(sessionId1);
    expect(parsed.context).toBeDefined();
  });

  // ─── Trait AC: @trait-semantic-exit-codes ───────────────────────────────────

  // AC: @trait-semantic-exit-codes ac-2
  // Note: Trait says "exit code 1" but kspec uses a richer exit code scheme
  // (EXIT_CODES in src/cli/exit-codes.ts). Validation errors map to
  // VALIDATION_FAILED (4). This is consistent with other commands (e.g. cli-serve.test.ts).
  it("should exit with VALIDATION_FAILED (4) for ambiguous prefix", async () => {
    const ambig1 = "01XTEST0000000000000000001";
    const ambig2 = "01XTEST0000000000000000002";
    const sessionsDir = path.join(tempDir, ".kspec-sessions");

    const a1Dir = path.join(sessionsDir, ambig1);
    await fs.mkdir(a1Dir);
    await fs.writeFile(
      path.join(a1Dir, "session.yaml"),
      YAML.stringify({
        id: ambig1,
        agent_type: "test",
        status: "active",
        started_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    const a2Dir = path.join(sessionsDir, ambig2);
    await fs.mkdir(a2Dir);
    await fs.writeFile(
      path.join(a2Dir, "session.yaml"),
      YAML.stringify({
        id: ambig2,
        agent_type: "test",
        status: "active",
        started_at: "2026-01-01T00:00:00.000Z",
      }),
    );

    const result = kspec("session log show 01XTEST", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(4); // VALIDATION_FAILED
  });

  // AC: @trait-semantic-exit-codes ac-6
  // Commander handles invalid flags/missing args before our code runs, exits with code 1.
  it("should exit with code 1 for unknown flags", () => {
    const result = kspec(`session log show ${sessionId1} --bogus-flag`, tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown option");
  });

  // AC: @trait-semantic-exit-codes ac-6
  it("should exit with code 1 for missing required argument", () => {
    const result = kspec("session log show", tempDir, { expectFail: true });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing required argument");
  });

  // AC: @trait-semantic-exit-codes ac-8
  // Verifies that distinct error conditions produce distinct, documented exit codes
  // matching the constants defined in src/cli/exit-codes.ts (EXIT_CODE_METADATA).
  it("should produce distinct documented exit codes for each error class", () => {
    // NOT_FOUND (3) — nonexistent session
    const notFound = kspec("session log show NONEXISTENT", tempDir, { expectFail: true });
    expect(notFound.exitCode).toBe(3);

    // USAGE_ERROR (2) — invalid argument value
    const usageErr = kspec(`session log show ${sessionId1} --context abc`, tempDir, {
      expectFail: true,
    });
    expect(usageErr.exitCode).toBe(2);
  });

  // @trait-semantic-exit-codes ac-3 — N/A: session log show is read-only with no confirmation prompts
  // @trait-semantic-exit-codes ac-5 — N/A: command either finds a session or returns not_found; no empty result set
  // @trait-semantic-exit-codes ac-7 — N/A: not a batch command
});
