/**
 * Session log list tests.
 *
 * Tests for the `kspec session log list` command and supporting store functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  createSession,
  appendEvent,
  saveSessionContext,
  getSessionLogSummary,
  getAllSessionLogSummaries,
  type SessionLogSummary,
} from "../src/sessions/store.js";
import { setupTempFixtures, cleanupTempDir, kspec, kspecJson, testUlid } from "./helpers/cli";

// ─── JSON Output Shape ────────────────────────────────────────────────────

interface SessionListResult {
  items: SessionLogSummary[];
  total: number;
  offset: number;
  limit: number | null;
  filters?: Partial<
    Record<"status" | "agent_type" | "agent_id" | "trigger" | "task_id" | "since", string>
  >;
}

// ─── Store Unit Tests ───────────────────────────────────────────────────────

describe("getSessionLogSummary", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-session-log-"));
    sessionsDir = path.join(testDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  it("should return null for nonexistent session", async () => {
    const summary = await getSessionLogSummary(sessionsDir, "nonexistent");
    expect(summary).toBeNull();
  });

  // AC: @session-log-list ac-1
  it("should return summary with all expected fields", async () => {
    const sessionId = testUlid("SESS");
    const startedAt = "2026-01-20T10:00:00.000Z";
    const endedAt = "2026-01-20T11:30:00.000Z";

    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-agent-acp",
      started_at: startedAt,
    });

    // Simulate completion by writing metadata directly
    const metaPath = path.join(sessionsDir, sessionId, "session.yaml");
    await fs.writeFile(
      metaPath,
      YAML.stringify({
        id: sessionId,
        agent_type: "claude-agent-acp",
        status: "completed",
        started_at: startedAt,
        ended_at: endedAt,
      }),
    );

    // Add some events
    for (let i = 0; i < 5; i++) {
      await appendEvent(sessionsDir, {
        type: i === 0 ? "session.start" : "prompt.sent",
        session_id: sessionId,
        data: null,
      });
    }

    // Add context snapshots
    await saveSessionContext(sessionsDir, sessionId, 1, { iteration: 1 });
    await saveSessionContext(sessionsDir, sessionId, 2, { iteration: 2 });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.id).toBe(sessionId);
    expect(summary!.status).toBe("completed");
    expect(summary!.agent_type).toBe("claude-agent-acp");
    expect(summary!.started_at).toBe(startedAt);
    expect(summary!.ended_at).toBe(endedAt);
    expect(summary!.duration_ms).toBe(5400000); // 1.5 hours
    expect(summary!.event_count).toBe(5);
    expect(summary!.iteration_count).toBe(2);
    expect(summary!.tasks_completed).toBe(0);
  });

  // AC: @ui-session-history ac-1 — task_id included in summary
  it("should include task_id in summary when session has a task", async () => {
    const sessionId = testUlid("SESS", 5);
    const taskId = testUlid("TASK");
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-agent-acp",
      task_id: taskId,
    });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.task_id).toBe(taskId);
  });

  // AC: @ui-session-history ac-1 — task_id undefined when session has no task
  it("should have undefined task_id when session has no task", async () => {
    const sessionId = testUlid("SESS", 6);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
    });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.task_id).toBeUndefined();
  });

  it("should compute duration from now for active sessions", async () => {
    const sessionId = testUlid("SESS", 1);
    const startedAt = new Date(Date.now() - 1000).toISOString();
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "test-agent",
      started_at: startedAt,
    });

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary).not.toBeNull();
    expect(summary!.status).toBe("active");
    expect(summary!.duration_ms).toBeGreaterThan(0);
    expect(summary!.ended_at).toBeUndefined();
  });

  it("should count task completions from realistic tool_call events", async () => {
    const sessionId = testUlid("SESS", 2);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-agent-acp",
    });

    // Append events including realistic task complete tool calls
    await appendEvent(sessionsDir, {
      type: "session.start",
      session_id: sessionId,
      data: null,
    });
    // Write realistic session.update events with tool_call shape
    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    const toolCallEvent1 = JSON.stringify({
      ts: Date.now(),
      seq: 1,
      type: "session.update",
      session_id: sessionId,
      data: {
        iteration: 1,
        update: {
          _meta: { claudeCode: { toolName: "Bash" } },
          sessionUpdate: "tool_call",
          rawInput: { command: 'kspec task complete @my-task --reason "Done"' },
        },
      },
    });
    await fs.appendFile(eventsPath, `${toolCallEvent1}\n`);
    const toolCallEvent2 = JSON.stringify({
      ts: Date.now(),
      seq: 2,
      type: "session.update",
      session_id: sessionId,
      data: {
        iteration: 1,
        update: {
          _meta: { claudeCode: { toolName: "Bash" } },
          sessionUpdate: "tool_call",
          rawInput: { command: 'npm run dev -- task complete @another-task --reason "All done"' },
        },
      },
    });
    await fs.appendFile(eventsPath, `${toolCallEvent2}\n`);

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary!.tasks_completed).toBe(2);
    expect(summary!.event_count).toBe(3); // session.start + 2 tool_call updates
  });

  // AC: @session-log-list ac-1 (claude-agent-acp: commands in tool_call_update events)
  it("should count task completions from tool_call_update events (claude-agent-acp format)", async () => {
    const sessionId = testUlid("SESS", 3);
    await createSession(sessionsDir, { id: sessionId, agent_type: "claude-agent-acp" });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    // claude-agent-acp: initial tool_call has empty rawInput, command arrives in tool_call_update
    const emptyToolCall = JSON.stringify({
      ts: Date.now(),
      seq: 1,
      type: "session.update",
      session_id: sessionId,
      data: { update: { sessionUpdate: "tool_call", rawInput: {}, toolCallId: "tc-1" } },
    });
    await fs.appendFile(eventsPath, `${emptyToolCall}\n`);
    const populatedUpdate = JSON.stringify({
      ts: Date.now(),
      seq: 2,
      type: "session.update",
      session_id: sessionId,
      data: {
        update: {
          sessionUpdate: "tool_call_update",
          rawInput: {
            command: 'kspec task complete @my-task --reason "Done"',
            description: "Complete task",
          },
          toolCallId: "tc-1",
        },
      },
    });
    await fs.appendFile(eventsPath, `${populatedUpdate}\n`);

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary!.tasks_completed).toBe(1);
  });

  // AC: @session-log-list ac-1 (codex-acp: command is array in tool_call events)
  it("should count task completions from array commands (codex-acp format)", async () => {
    const sessionId = testUlid("SESS", 4);
    await createSession(sessionsDir, { id: sessionId, agent_type: "codex-acp" });

    const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
    // codex-acp: command is ['/usr/bin/bash', '-lc', 'kspec task complete @ref']
    const arrayCommandEvent = JSON.stringify({
      ts: Date.now(),
      seq: 1,
      type: "session.update",
      session_id: sessionId,
      data: {
        update: {
          sessionUpdate: "tool_call",
          rawInput: { command: ["/usr/bin/bash", "-lc", "kspec task complete @my-task"] },
        },
      },
    });
    await fs.appendFile(eventsPath, `${arrayCommandEvent}\n`);

    const summary = await getSessionLogSummary(sessionsDir, sessionId);
    expect(summary!.tasks_completed).toBe(1);
  });
});

describe("getAllSessionLogSummaries", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-session-log-all-"));
    sessionsDir = path.join(testDir, "sessions");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true });
  });

  // AC: @session-log-list ac-6
  it("should return empty array when no sessions exist", async () => {
    const summaries = await getAllSessionLogSummaries(sessionsDir);
    expect(summaries).toEqual([]);
  });

  it("should return summaries for all sessions", async () => {
    const id1 = testUlid("SESS", 1);
    const id2 = testUlid("SESS", 2);

    await createSession(sessionsDir, { id: id1, agent_type: "agent-a" });
    await createSession(sessionsDir, { id: id2, agent_type: "agent-b" });

    const summaries = await getAllSessionLogSummaries(sessionsDir);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.id).toSorted()).toEqual([id1, id2].toSorted());
  });
});

// ─── CLI Integration Tests ──────────────────────────────────────────────────

describe("kspec session log list (CLI)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    // Sessions live at projectRoot/.kspec-sessions/ (outside shadow branch)
    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Session 1: completed, old, agent_id=worker, trigger=task.ready, task_id set
    const s1 = testUlid("SESS", 1);
    const s1Dir = path.join(sessionsDir, s1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(
      path.join(s1Dir, "session.yaml"),
      YAML.stringify({
        id: s1,
        agent_type: "claude-agent-acp",
        agent_id: "worker",
        trigger: "task.ready",
        task_id: "@task-auth",
        status: "completed",
        started_at: "2026-01-15T10:00:00.000Z",
        ended_at: "2026-01-15T11:30:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s1Dir, "events.jsonl"),
      `${[
        JSON.stringify({ ts: 1000, seq: 0, type: "session.start", session_id: s1, data: null }),
        JSON.stringify({ ts: 2000, seq: 1, type: "prompt.sent", session_id: s1, data: null }),
        JSON.stringify({ ts: 3000, seq: 2, type: "session.end", session_id: s1, data: null }),
      ].join("\n")}\n`,
    );
    await fs.writeFile(path.join(s1Dir, "context-iter-1.json"), "{}");

    // Session 2: active, recent, no agent_id, trigger=manual
    const s2 = testUlid("SESS", 2);
    const s2Dir = path.join(sessionsDir, s2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(
      path.join(s2Dir, "session.yaml"),
      YAML.stringify({
        id: s2,
        agent_type: "custom-agent",
        trigger: "manual",
        status: "active",
        started_at: "2026-02-05T08:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s2Dir, "events.jsonl"),
      `${[
        JSON.stringify({ ts: 1000, seq: 0, type: "session.start", session_id: s2, data: null }),
        JSON.stringify({ ts: 2000, seq: 1, type: "prompt.sent", session_id: s2, data: null }),
        JSON.stringify({ ts: 3000, seq: 2, type: "prompt.sent", session_id: s2, data: null }),
        JSON.stringify({ ts: 4000, seq: 3, type: "prompt.sent", session_id: s2, data: null }),
        JSON.stringify({ ts: 5000, seq: 4, type: "prompt.sent", session_id: s2, data: null }),
      ].join("\n")}\n`,
    );
    await fs.writeFile(path.join(s2Dir, "context-iter-1.json"), "{}");
    await fs.writeFile(path.join(s2Dir, "context-iter-2.json"), "{}");
    await fs.writeFile(path.join(s2Dir, "context-iter-3.json"), "{}");

    // Session 3: completed, recent, agent_id=pr-reviewer, trigger=task.pending_review, task_id set
    const s3 = testUlid("SESS", 3);
    const s3Dir = path.join(sessionsDir, s3);
    await fs.mkdir(s3Dir);
    await fs.writeFile(
      path.join(s3Dir, "session.yaml"),
      YAML.stringify({
        id: s3,
        agent_type: "claude-agent-acp",
        agent_id: "pr-reviewer",
        trigger: "task.pending_review",
        task_id: "@task-auth",
        status: "completed",
        started_at: "2026-02-04T14:00:00.000Z",
        ended_at: "2026-02-04T15:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s3Dir, "events.jsonl"),
      `${[
        JSON.stringify({ ts: 1000, seq: 0, type: "session.start", session_id: s3, data: null }),
        JSON.stringify({
          ts: 2000,
          seq: 1,
          type: "session.update",
          session_id: s3,
          data: {
            iteration: 1,
            update: {
              _meta: { claudeCode: { toolName: "Bash" } },
              sessionUpdate: "tool_call",
              rawInput: { command: 'kspec task complete @task-1 --reason "Done"' },
            },
          },
        }),
      ].join("\n")}\n`,
    );

    // Session 4: completed, agent_id=worker, trigger=task.needs_work, different task
    const s4 = testUlid("SESS", 4);
    const s4Dir = path.join(sessionsDir, s4);
    await fs.mkdir(s4Dir);
    await fs.writeFile(
      path.join(s4Dir, "session.yaml"),
      YAML.stringify({
        id: s4,
        agent_type: "claude-agent-acp",
        agent_id: "worker",
        trigger: "task.needs_work",
        task_id: "@task-login",
        status: "completed",
        started_at: "2026-02-06T09:00:00.000Z",
        ended_at: "2026-02-06T10:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s4Dir, "events.jsonl"),
      `${[
        JSON.stringify({ ts: 1000, seq: 0, type: "session.start", session_id: s4, data: null }),
      ].join("\n")}\n`,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-log-list ac-1
  it("should display sessions in table format", () => {
    const result = kspec("session log list", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ID");
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Agent");
    expect(result.stdout).toContain("Started");
    expect(result.stdout).toContain("Duration");
    expect(result.stdout).toContain("Events");
    expect(result.stdout).toContain("Iters");
    expect(result.stdout).toContain("Tasks");
    expect(result.stdout).toContain("4 session(s)");
  });

  // AC: @session-log-list ac-1 (JSON variant) — new structured output shape
  it("should output valid JSON with items, total, offset, limit in --json mode", () => {
    const result = kspecJson<SessionListResult>("session log list", tempDir);
    expect(result.items).toHaveLength(4);
    expect(result.total).toBe(4);
    expect(result.offset).toBe(0);
    expect(result.limit).toBeNull();

    for (const session of result.items) {
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("status");
      expect(session).toHaveProperty("agent_type");
      expect(session).toHaveProperty("started_at");
      expect(session).toHaveProperty("duration_ms");
      expect(session).toHaveProperty("event_count");
      expect(session).toHaveProperty("iteration_count");
      expect(session).toHaveProperty("tasks_completed");
    }
  });

  // AC: @session-log-list ac-2
  // AC: @trait-filterable-list ac-1
  it("should filter by --status", () => {
    const result = kspecJson<SessionListResult>("session log list --status completed", tempDir);
    expect(result.items).toHaveLength(3);
    for (const s of result.items) {
      expect(s.status).toBe("completed");
    }
  });

  // AC: @session-log-list ac-2
  it("should filter by --status active", () => {
    const result = kspecJson<SessionListResult>("session log list --status active", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe("active");
    expect(result.items[0].agent_type).toBe("custom-agent");
  });

  // AC: @session-log-list ac-3
  it("should filter by --since", () => {
    const result = kspecJson<SessionListResult>("session log list --since 2026-02-01", tempDir);
    // Sessions 2, 3, 4 are after Feb 1
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
    for (const s of result.items) {
      expect(new Date(s.started_at).getTime()).toBeGreaterThanOrEqual(
        new Date("2026-02-01").getTime(),
      );
    }
  });

  // AC: @session-log-list ac-4
  it("should filter by --agent", () => {
    const result = kspecJson<SessionListResult>("session log list --agent custom-agent", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].agent_type).toBe("custom-agent");
  });

  // AC: @session-log-list ac-4
  it("should filter by --agent for claude-agent-acp", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --agent claude-agent-acp",
      tempDir,
    );
    expect(result.items).toHaveLength(3);
    for (const s of result.items) {
      expect(s.agent_type).toBe("claude-agent-acp");
    }
  });

  // AC: @session-log-list ac-5
  it("should sort by started_at descending by default", () => {
    const result = kspecJson<SessionListResult>("session log list", tempDir);
    expect(result.items).toHaveLength(4);
    for (let i = 1; i < result.items.length; i++) {
      expect(new Date(result.items[i - 1].started_at).getTime()).toBeGreaterThanOrEqual(
        new Date(result.items[i].started_at).getTime(),
      );
    }
  });

  // AC: @session-log-list ac-5
  it("should sort by events when --sort events is provided", () => {
    const result = kspecJson<SessionListResult>("session log list --sort events", tempDir);
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].event_count).toBeGreaterThanOrEqual(result.items[i].event_count);
    }
  });

  // AC: @session-log-list ac-5
  it("should sort by iterations when --sort iterations is provided", () => {
    const result = kspecJson<SessionListResult>("session log list --sort iterations", tempDir);
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].iteration_count).toBeGreaterThanOrEqual(
        result.items[i].iteration_count,
      );
    }
  });

  // AC: @session-log-list ac-6
  it('should show "No sessions found" when no sessions exist', async () => {
    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.rm(sessionsDir, { recursive: true });
    await fs.mkdir(sessionsDir);

    const result = kspec("session log list", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions found");
  });

  // AC: @session-log-list ac-6 (JSON variant)
  it("should return empty items in JSON mode when no sessions exist", async () => {
    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.rm(sessionsDir, { recursive: true });
    await fs.mkdir(sessionsDir);

    const result = kspecJson<SessionListResult>("session log list", tempDir);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  // AC: @session-log-list ac-7
  it("should limit output with --count flag (shows count only)", () => {
    const result = kspec("session log list --count", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4");
  });

  // AC: @session-log-list ac-7 (JSON --count)
  it("should return count in JSON mode with --count", () => {
    const data = kspecJson<{ count: number }>("session log list --count", tempDir);
    expect(data.count).toBe(4);
  });

  // AC: @session-log-list ac-7 (--count with filters)
  it("should respect filters with --count", () => {
    const data = kspecJson<{ count: number }>(
      "session log list --count --status completed",
      tempDir,
    );
    expect(data.count).toBe(3);
  });

  // --limit flag
  // AC: @trait-filterable-list ac-3
  it("should limit number of sessions with -n flag", () => {
    const result = kspecJson<SessionListResult>("session log list -n 2", tempDir);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(4); // total is unaffected by limit
    expect(result.limit).toBe(2);
  });

  // AC: @trait-filterable-list ac-4 — --offset skips first N items
  it("should skip sessions with --offset flag", () => {
    const result = kspecJson<SessionListResult>("session log list --offset 2", tempDir);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.offset).toBe(2);
  });

  // AC: @trait-filterable-list ac-4 + ac-3 — offset and limit together
  it("should support --offset and --limit together", () => {
    const result = kspecJson<SessionListResult>("session log list --offset 1 -n 2", tempDir);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.offset).toBe(1);
    expect(result.limit).toBe(2);
  });

  // Combined filters
  // AC: @trait-filterable-list ac-5
  it("should combine --status and --agent filters", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --status active --agent custom-agent",
      tempDir,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe("active");
    expect(result.items[0].agent_type).toBe("custom-agent");
  });

  // Task completion counting
  it("should count task completions", () => {
    const result = kspecJson<SessionListResult>("session log list --status completed", tempDir);
    const withTasks = result.items.find((s) => s.tasks_completed > 0);
    expect(withTasks).toBeDefined();
    expect(withTasks!.tasks_completed).toBe(1);
  });

  // Iteration counting
  it("should count iterations correctly", () => {
    const result = kspecJson<SessionListResult>("session log list --status active", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].iteration_count).toBe(3);
  });

  // Trait: JSON output has ISO 8601 timestamps
  // AC: @trait-json-output ac-5
  it("should use ISO 8601 timestamps in JSON output", () => {
    const result = kspecJson<SessionListResult>("session log list", tempDir);
    for (const s of result.items) {
      expect(s.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  // Trait: JSON output no ANSI codes
  // AC: @trait-json-output ac-1
  it("should have no ANSI codes in JSON output", () => {
    const result = kspec("session log list --json", tempDir);
    // oxlint-disable-next-line eslint(no-control-regex) -- intentionally matching ANSI escape
    expect(result.stdout).not.toMatch(/\x1b\[\d+m/);
  });

  // Trait: exit code 0 on success
  // AC: @trait-semantic-exit-codes ac-1
  it("should exit with code 0 on success", () => {
    const result = kspec("session log list", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // ─── New Unified Filtering Tests ──────────────────────────────────────────

  // AC: @session-cli-unified-filtering ac-agent-id-filter
  it("should filter by --agent-id", () => {
    const result = kspecJson<SessionListResult>("session log list --agent-id worker", tempDir);
    expect(result.items).toHaveLength(2);
    for (const s of result.items) {
      expect(s.agent_id).toBe("worker");
    }
    expect(result.total).toBe(2);
  });

  // AC: @session-cli-unified-filtering ac-agent-id-filter — different agent_id
  it("should filter by --agent-id pr-reviewer", () => {
    const result = kspecJson<SessionListResult>("session log list --agent-id pr-reviewer", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].agent_id).toBe("pr-reviewer");
  });

  // AC: @session-cli-unified-filtering ac-trigger-filter — manual trigger
  it("should filter by --trigger manual", () => {
    const result = kspecJson<SessionListResult>("session log list --trigger manual", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].trigger).toBe("manual");
  });

  // AC: @session-cli-unified-filtering ac-trigger-filter — dispatched shorthand matches all task.* triggers
  it("should filter by --trigger dispatched to match all task.* triggers", () => {
    const result = kspecJson<SessionListResult>("session log list --trigger dispatched", tempDir);
    // Sessions 1 (task.ready), 3 (task.pending_review), 4 (task.needs_work) match
    expect(result.items).toHaveLength(3);
    for (const s of result.items) {
      expect(s.trigger).toMatch(/^task\./);
    }
  });

  // AC: @session-cli-unified-filtering ac-trigger-filter — specific task.* trigger
  it("should filter by --trigger task.ready", () => {
    const result = kspecJson<SessionListResult>("session log list --trigger task.ready", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].trigger).toBe("task.ready");
  });

  // AC: @session-cli-unified-filtering ac-task-filter
  it("should filter by --task", () => {
    const result = kspecJson<SessionListResult>("session log list --task @task-auth", tempDir);
    // Sessions 1 and 3 both have task_id: @task-auth
    expect(result.items).toHaveLength(2);
    for (const s of result.items) {
      expect(s.task_id).toBe("@task-auth");
    }
  });

  // AC: @session-cli-unified-filtering ac-task-filter — different task
  it("should filter by --task for a different task", () => {
    const result = kspecJson<SessionListResult>("session log list --task @task-login", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].task_id).toBe("@task-login");
  });

  // AC: @session-cli-unified-filtering ac-backward-compat — --agent continues to work
  it("should keep --agent as backward-compatible filter for agent_type", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --agent claude-agent-acp",
      tempDir,
    );
    expect(result.items).toHaveLength(3);
    for (const s of result.items) {
      expect(s.agent_type).toBe("claude-agent-acp");
    }
  });

  // AC: @session-cli-unified-filtering ac-backward-compat — --agent-type also works
  it("should accept --agent-type as synonym for --agent", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --agent-type custom-agent",
      tempDir,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].agent_type).toBe("custom-agent");
  });

  // AC: @session-cli-unified-filtering ac-combined — multiple filters AND'd
  it("should AND multiple new filters together", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --status completed --agent-id worker --since 2026-02-01",
      tempDir,
    );
    // Only session 4 matches: completed + worker + after Feb 1
    expect(result.items).toHaveLength(1);
    expect(result.items[0].agent_id).toBe("worker");
    expect(result.items[0].status).toBe("completed");
    expect(result.total).toBe(1);
  });

  // AC: @session-cli-unified-filtering ac-combined — all filters at once
  it("should AND all filter types together", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --agent-id worker --trigger task.ready --task @task-auth",
      tempDir,
    );
    // Only session 1 matches
    expect(result.items).toHaveLength(1);
    expect(result.items[0].agent_id).toBe("worker");
    expect(result.items[0].trigger).toBe("task.ready");
    expect(result.items[0].task_id).toBe("@task-auth");
  });

  // AC: @session-cli-unified-filtering ac-json-output — filter criteria in JSON output
  it("should include filter criteria in JSON output when filters are active", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --status completed --agent-id worker",
      tempDir,
    );
    expect(result.filters).toBeDefined();
    expect(result.filters!.status).toBe("completed");
    expect(result.filters!.agent_id).toBe("worker");
  });

  // AC: @session-cli-unified-filtering ac-json-output — no filters key when no filters
  it("should not include filters key in JSON when no filters are active", () => {
    const result = kspecJson<SessionListResult>("session log list", tempDir);
    expect(result.filters).toBeUndefined();
  });

  // AC: @session-cli-unified-filtering ac-json-output — filter criteria include all active filters
  it("should include all active filter criteria in JSON output", () => {
    const result = kspecJson<SessionListResult>(
      "session log list --agent-id worker --trigger dispatched --task @task-auth --since 2026-01-01",
      tempDir,
    );
    expect(result.filters).toBeDefined();
    expect(result.filters!.agent_id).toBe("worker");
    expect(result.filters!.trigger).toBe("dispatched");
    expect(result.filters!.task_id).toBe("@task-auth");
    expect(result.filters!.since).toBe("2026-01-01");
  });

  // AC: @trait-filterable-list ac-6 — empty list with filter message
  it("should show informative message when filters return no results", () => {
    const result = kspec("session log list --agent-id nonexistent", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No sessions match the specified filters");
  });

  // AC: @trait-filterable-list ac-7 — summary shows filter state
  it("should show filtered count in summary when filters active", () => {
    const result = kspec("session log list --agent-id worker -n 1", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 of 2 session(s) (filtered: agent_id=worker)");
  });

  // AC: @trait-filterable-list ac-7 — filter state shown even when all filtered results are displayed
  it("should show filter state in summary without truncation", () => {
    const result = kspec("session log list --agent-id worker", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 session(s) (filtered: agent_id=worker)");
  });

  // AC: @trait-filterable-list ac-8 — --count with new filters
  it("should return count with new filter flags", () => {
    const data = kspecJson<{ count: number }>(
      "session log list --count --agent-id worker",
      tempDir,
    );
    expect(data.count).toBe(2);
  });

  // AC: @trait-filterable-list ac-8 — --count ignores limit/offset
  it("should ignore --limit and --offset when --count is used", () => {
    const data = kspecJson<{ count: number }>("session log list --count -n 1 --offset 10", tempDir);
    expect(data.count).toBe(4);
  });

  // AC: @trait-json-output ac-2 — JSON includes all data
  it("should include all session fields in JSON items", () => {
    const result = kspecJson<SessionListResult>("session log list --agent-id worker", tempDir);
    for (const s of result.items) {
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("status");
      expect(s).toHaveProperty("agent_type");
      expect(s).toHaveProperty("agent_id");
      expect(s).toHaveProperty("started_at");
      expect(s).toHaveProperty("duration_ms");
      expect(s).toHaveProperty("event_count");
      expect(s).toHaveProperty("iteration_count");
      expect(s).toHaveProperty("tasks_completed");
    }
  });

  // AC: @trait-json-output ac-4 — references use @ prefix
  it("should preserve @ prefix in task references in JSON output", () => {
    const result = kspecJson<SessionListResult>("session log list --task @task-auth", tempDir);
    expect(result.filters!.task_id).toBe("@task-auth");
    for (const s of result.items) {
      expect(s.task_id).toBe("@task-auth");
    }
  });

  // AC: @trait-json-output ac-6 — --json takes precedence
  it("should output JSON when --json is combined with other display options", () => {
    const result = kspec("session log list --json --agent-id worker", tempDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("items");
    expect(parsed).toHaveProperty("total");
  });

  // AC: @trait-json-output ac-3
  it("should return JSON error payload for invalid status in --json mode", () => {
    const result = kspec("session log list --json --status invalid_status", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    const parsed = JSON.parse(result.stderr);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("Invalid status: 'invalid_status'");
    expect(parsed.error).toContain("active");
    expect(parsed.error).toContain("completed");
  });

  // AC: @trait-filterable-list ac-2 — N/A: session log list does not implement a --tag filter; supported filters are status, agent_type, agent_id, trigger, task_id, and since.
});

// ─── Canonical Task Identity Filtering ───────────────────────────────────────

// Dispatch canonicalization stores the bare task ULID in `task_id` and a
// separate human-readable display ref in `task_ref`. The `--task` filter must
// find a session by either identity spelling — including the standard canonical
// `@<ULID>` ref — even when the display ref differs from the canonical id.
describe("kspec session log list (CLI) — canonical task identity filter", () => {
  let tempDir: string;
  let canonicalUlid: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();

    const sessionsDir = path.join(tempDir, ".kspec-sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    canonicalUlid = testUlid("TASK", 1);

    // Canonicalized dispatch session: bare-ULID task_id, slug display ref.
    const s1 = testUlid("SESS", 1);
    const s1Dir = path.join(sessionsDir, s1);
    await fs.mkdir(s1Dir);
    await fs.writeFile(
      path.join(s1Dir, "session.yaml"),
      YAML.stringify({
        id: s1,
        agent_type: "claude-agent-acp",
        agent_id: "pr-reviewer",
        trigger: "task.pending_review",
        task_id: canonicalUlid,
        task_ref: "@task-payload",
        status: "completed",
        started_at: "2026-03-01T10:00:00.000Z",
        ended_at: "2026-03-01T11:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s1Dir, "events.jsonl"),
      `${JSON.stringify({ ts: 1000, seq: 0, type: "session.start", session_id: s1, data: null })}\n`,
    );

    // Unrelated session under a different canonical task — must never match.
    const s2 = testUlid("SESS", 2);
    const s2Dir = path.join(sessionsDir, s2);
    await fs.mkdir(s2Dir);
    await fs.writeFile(
      path.join(s2Dir, "session.yaml"),
      YAML.stringify({
        id: s2,
        agent_type: "claude-agent-acp",
        agent_id: "worker",
        trigger: "task.ready",
        task_id: testUlid("XTRA", 1),
        task_ref: "@task-other",
        status: "completed",
        started_at: "2026-03-02T10:00:00.000Z",
        ended_at: "2026-03-02T11:00:00.000Z",
      }),
    );
    await fs.writeFile(
      path.join(s2Dir, "events.jsonl"),
      `${JSON.stringify({ ts: 1000, seq: 0, type: "session.start", session_id: s2, data: null })}\n`,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("matches the canonical @<ULID> ref against a bare-ULID task_id", () => {
    const result = kspecJson<SessionListResult>(
      `session log list --task @${canonicalUlid}`,
      tempDir,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].task_id).toBe(canonicalUlid);
    expect(result.items[0].task_ref).toBe("@task-payload");
  });

  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("matches the bare ULID ref against a bare-ULID task_id", () => {
    const result = kspecJson<SessionListResult>(
      `session log list --task ${canonicalUlid}`,
      tempDir,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].task_id).toBe(canonicalUlid);
  });

  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("still matches the display slug ref against task_ref", () => {
    const result = kspecJson<SessionListResult>("session log list --task @task-payload", tempDir);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].task_id).toBe(canonicalUlid);
  });

  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("does not match an unrelated task's canonical ref", () => {
    const result = kspecJson<SessionListResult>(
      `session log list --task @${canonicalUlid}`,
      tempDir,
    );
    expect(result.items.every((s) => s.task_id === canonicalUlid)).toBe(true);
  });
});
