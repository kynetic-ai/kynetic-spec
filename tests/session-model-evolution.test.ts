/**
 * Session Model Evolution tests.
 *
 * Tests for extended session metadata (trigger, agent_id), new status values,
 * new event types, and session type classification (loop vs invocation).
 *
 * Task: @implement-session-model-evolution
 * Spec: @session-model-evolution
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  createSession,
  appendEvent,
  getSession,
  getSessionLogSummary,
  type SessionLogSummary,
  type SessionLogDetail,
} from "../src/sessions/store.js";
import {
  SessionStatusSchema,
  EventTypeSchema,
  SessionMetadataSchema,
} from "../src/sessions/types.js";
import { setupTempFixtures, cleanupTempDir, kspec, kspecJson, readTestOutput, testUlid } from "./helpers/cli.js";

// ─── AC-3: SessionStatusSchema extension ────────────────────────────────────

// AC: @session-model-evolution ac-3
describe("SessionStatusSchema extended statuses", () => {
  it("should accept timed_out as a valid status", () => {
    const result = SessionStatusSchema.safeParse("timed_out");
    expect(result.success).toBe(true);
  });

  it("should accept failed as a valid status", () => {
    const result = SessionStatusSchema.safeParse("failed");
    expect(result.success).toBe(true);
  });

  it("should still accept original statuses", () => {
    for (const status of ["active", "completed", "abandoned"]) {
      const result = SessionStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    }
  });

  it("should reject invalid statuses", () => {
    const result = SessionStatusSchema.safeParse("unknown-status");
    expect(result.success).toBe(false);
  });
});

// ─── AC-4: EventTypeSchema extension ─────────────────────────────────────────

// AC: @session-model-evolution ac-4
describe("EventTypeSchema agent.* event types", () => {
  const agentEventTypes = [
    "agent.dispatched",
    "agent.started",
    "agent.completed",
    "agent.failed",
    "agent.timeout",
  ];

  for (const eventType of agentEventTypes) {
    it(`should accept ${eventType} as a valid event type`, () => {
      const result = EventTypeSchema.safeParse(eventType);
      expect(result.success).toBe(true);
    });
  }

  it("should still accept all original event types", () => {
    const originalTypes = [
      "session.start",
      "session.update",
      "iteration.timeout",
      "session.end",
      "session.wrapup",
      "prompt.sent",
      "tool.call",
      "tool.result",
      "note",
    ];
    for (const eventType of originalTypes) {
      const result = EventTypeSchema.safeParse(eventType);
      expect(result.success).toBe(true);
    }
  });
});

// ─── AC-1: SessionMetadata with trigger and agent_id ─────────────────────────

// AC: @session-model-evolution ac-1
describe("SessionMetadata trigger and agent_id fields", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-session-model-"));
    sessionsDir = path.join(testDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it("should accept trigger and agent_id in session metadata", async () => {
    const sessionId = testUlid("SESS");
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-agent-acp",
      agent_id: "@agent-worker",
      trigger: "task.ready",
      task_id: "@my-task",
    });

    // Read back to verify persistence
    const loaded = await getSession(sessionsDir, sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.agent_id).toBe("@agent-worker");
    expect(loaded!.trigger).toBe("task.ready");
    expect(loaded!.task_id).toBe("@my-task");
  });

  it("should accept all trigger enum values", () => {
    const triggers = [
      "manual",
      "task.in_progress",
      "task.ready",
      "task.needs_work",
      "task.pending_review",
      "legacy",
    ];
    for (const trigger of triggers) {
      const result = SessionMetadataSchema.safeParse({
        id: "01SESS00000000000000000001",
        agent_type: "test-agent",
        trigger,
        status: "active",
        started_at: "2026-01-01T00:00:00.000Z",
      });
      expect(result.success).toBe(true);
    }
  });
});

// ─── AC-2: Backward compatibility for legacy sessions ─────────────────────────

// AC: @session-model-evolution ac-2
describe("Legacy session backward compatibility", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-legacy-session-"));
    sessionsDir = path.join(testDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it("should parse legacy session without trigger or agent_id without error", async () => {
    const sessionId = testUlid("SESS");
    // Write a legacy session.yaml directly (old format, no trigger/agent_id)
    const sessionDir = path.join(testDir, "sessions", sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.yaml"),
      YAML.stringify({
        id: sessionId,
        agent_type: "ralph",
        status: "completed",
        started_at: "2026-01-15T10:00:00.000Z",
        ended_at: "2026-01-15T12:00:00.000Z",
      }),
    );

    // Should parse without error
    const loaded = await getSession(sessionsDir, sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.agent_type).toBe("ralph");
    // AC: @session-model-evolution ac-2 — legacy defaults are materialized on read
    expect(loaded!.trigger).toBe("legacy");
    expect(loaded!.agent_id).toBe("ralph"); // defaults to agent_type value
  });

  it("should classify legacy session as loop type in summary", async () => {
    const sessionId = testUlid("SESS");
    const sessionDir = path.join(testDir, "sessions", sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.yaml"),
      YAML.stringify({
        id: sessionId,
        agent_type: "ralph",
        status: "completed",
        started_at: "2026-01-15T10:00:00.000Z",
        ended_at: "2026-01-15T12:00:00.000Z",
      }),
    );
    await fs.writeFile(path.join(sessionDir, "events.jsonl"), "");

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    // Legacy session (no trigger) should be classified as "loop"
    expect(summary!.session_type).toBe("loop");
  });

  it("should classify session with trigger=legacy as loop type", async () => {
    const sessionId = testUlid("SESS", 1);
    const sessionDir = path.join(testDir, "sessions", sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "session.yaml"),
      YAML.stringify({
        id: sessionId,
        agent_type: "ralph",
        trigger: "legacy",
        status: "completed",
        started_at: "2026-01-15T10:00:00.000Z",
        ended_at: "2026-01-15T12:00:00.000Z",
      }),
    );
    await fs.writeFile(path.join(sessionDir, "events.jsonl"), "");

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.session_type).toBe("loop");
  });
});

// ─── AC-5: Structured agent.completed event ──────────────────────────────────

// AC: @session-model-evolution ac-5
describe("agent.completed event structure", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-agent-event-"));
    sessionsDir = path.join(testDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it("should append agent.completed event with task_id, outcome, and duration_ms", async () => {
    const sessionId = testUlid("SESS");
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-agent-acp",
    });

    // Append structured agent.completed event
    await appendEvent(sessionsDir, {
      type: "agent.completed",
      session_id: sessionId,
      data: {
        task_id: "@my-task",
        outcome: "success",
        duration_ms: 45000,
      },
    });

    // Read back events to verify
    const eventsPath = path.join(testDir, "sessions", sessionId, "events.jsonl");
    const content = await readTestOutput(eventsPath);
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const event = JSON.parse(lines[0]);
    expect(event.type).toBe("agent.completed");
    expect(event.data.task_id).toBe("@my-task");
    expect(event.data.outcome).toBe("success");
    expect(event.data.duration_ms).toBe(45000);
  });

  it("should accept all outcome values for agent.completed", async () => {
    const sessionId = testUlid("SESS", 1);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-agent-acp",
    });

    for (const outcome of ["success", "blocked", "failed"]) {
      await appendEvent(sessionsDir, {
        type: "agent.completed",
        session_id: sessionId,
        data: { task_id: "@task", outcome, duration_ms: 1000 },
      });
    }

    const eventsPath = path.join(testDir, "sessions", sessionId, "events.jsonl");
    const content = await readTestOutput(eventsPath);
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
  });
});

// ─── AC-6: Session log list shows session type ────────────────────────────────

// AC: @session-model-evolution ac-6
describe("kspec session log list session type display (CLI)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Legacy session (no trigger = loop type)
    const s1 = testUlid("SESS", 1);
    const s1Dir = path.join(sessionsDir, s1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(
      path.join(s1Dir, "session.yaml"),
      YAML.stringify({
        id: s1,
        agent_type: "ralph",
        status: "completed",
        started_at: "2026-01-15T10:00:00.000Z",
        ended_at: "2026-01-15T11:30:00.000Z",
      }),
    );
    await fs.writeFile(path.join(s1Dir, "events.jsonl"), "");

    // New invocation session (with trigger = task.ready)
    const s2 = testUlid("SESS", 2);
    const s2Dir = path.join(sessionsDir, s2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(
      path.join(s2Dir, "session.yaml"),
      YAML.stringify({
        id: s2,
        agent_type: "claude-agent-acp",
        agent_id: "@agent-worker",
        trigger: "task.ready",
        task_id: "@my-task",
        status: "completed",
        started_at: "2026-02-10T10:00:00.000Z",
        ended_at: "2026-02-10T11:00:00.000Z",
      }),
    );
    await fs.writeFile(path.join(s2Dir, "events.jsonl"), "");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should show session_type field in JSON output", () => {
    const result = kspecJson<{ items: SessionLogSummary[] }>("session log list", tempDir);
    expect(result.items).toHaveLength(2);

    const legacy = result.items.find((s) => s.agent_type === "ralph");
    const invocation = result.items.find((s) => s.agent_type === "claude-agent-acp");

    expect(legacy).toBeDefined();
    expect(legacy!.session_type).toBe("loop");

    expect(invocation).toBeDefined();
    expect(invocation!.session_type).toBe("invocation");
  });

  it("should display Type column in text output", () => {
    const result = kspec("session log list", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Type");
    expect(result.stdout).toContain("loop");
    expect(result.stdout).toContain("invocation");
  });
});

// ─── AC-7: Session log show renders agent.* events ───────────────────────────

// AC: @session-model-evolution ac-7
describe("kspec session log show agent.* event rendering (CLI)", () => {
  let tempDir: string;
  const sessionId = testUlid("SESS");

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const sDir = path.join(sessionsDir, sessionId);
    await fs.mkdir(sDir);
    await fs.writeFile(
      path.join(sDir, "session.yaml"),
      YAML.stringify({
        id: sessionId,
        agent_type: "claude-agent-acp",
        agent_id: "@agent-worker",
        trigger: "task.ready",
        task_id: "@my-task",
        status: "completed",
        started_at: "2026-02-10T10:00:00.000Z",
        ended_at: "2026-02-10T11:00:00.000Z",
      }),
    );

    // Write events including agent.* types
    const events = [
      JSON.stringify({
        ts: 1000,
        seq: 0,
        type: "agent.dispatched",
        session_id: sessionId,
        data: { task_id: "@my-task" },
      }),
      JSON.stringify({
        ts: 2000,
        seq: 1,
        type: "agent.started",
        session_id: sessionId,
        data: { task_id: "@my-task" },
      }),
      JSON.stringify({
        ts: 5000,
        seq: 2,
        type: "agent.completed",
        session_id: sessionId,
        data: { task_id: "@my-task", outcome: "success", duration_ms: 3000 },
      }),
    ];
    await fs.writeFile(path.join(sDir, "events.jsonl"), events.join("\n") + "\n");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("should display session type in show output", () => {
    const result = kspec(`session log show ${sessionId}`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Type:");
    expect(result.stdout).toContain("invocation");
  });

  it("should include session_type in JSON output", () => {
    const detail = kspecJson<SessionLogDetail>(`session log show ${sessionId}`, tempDir);
    expect(detail.session_type).toBe("invocation");
  });

  it("should render agent.* events in event timeline", () => {
    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent.dispatched");
    expect(result.stdout).toContain("agent.started");
    expect(result.stdout).toContain("agent.completed");
  });

  it("should include agent.* events in JSON output with --events", () => {
    const detail = kspecJson<
      SessionLogDetail & { events?: Array<{ type: string; data: Record<string, unknown> }> }
    >(`session log show ${sessionId} --events`, tempDir);
    expect(detail.events).toBeDefined();
    expect(detail.events!.length).toBe(3);

    const dispatched = detail.events!.find((e) => e.type === "agent.dispatched");
    const started = detail.events!.find((e) => e.type === "agent.started");
    const completed = detail.events!.find((e) => e.type === "agent.completed");

    expect(dispatched).toBeDefined();
    expect(started).toBeDefined();
    expect(completed).toBeDefined();

    // AC: @session-model-evolution ac-5 — agent.completed has task_id, outcome, duration_ms
    expect(completed!.data.task_id).toBe("@my-task");
    expect(completed!.data.outcome).toBe("success");
    expect(completed!.data.duration_ms).toBe(3000);
  });

  it("should show human-readable summary for agent.* events", () => {
    const result = kspec(`session log show ${sessionId} --events`, tempDir);
    expect(result.exitCode).toBe(0);
    // agent.dispatched shows "Dispatched for @my-task"
    expect(result.stdout).toContain("Dispatched for @my-task");
    // agent.started shows "Started work on @my-task"
    expect(result.stdout).toContain("Started work on @my-task");
    // agent.completed shows task_id, outcome, duration
    expect(result.stdout).toContain("@my-task");
    expect(result.stdout).toContain("success");
  });
});
