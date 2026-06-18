/**
 * Initial Activity Watchdog tests.
 *
 * Tests for stall detection when an agent accepts a prompt via ACP but
 * produces no meaningful output within the configured timeout.
 *
 * Task: @task-test-stall-watchdog
 * Spec: @invocation-initial-activity-watchdog
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import { createSession, closeSession } from "../src/sessions/store.js";
import {
  runInvocation,
  InvocationStallError,
  DEFAULT_INITIAL_RESPONSE_TIMEOUT_SECONDS,
} from "../src/agent-runtime/invocation.js";
import { registerAdapter } from "../src/agents/adapters.js";
import { ACPClient } from "../src/acp/index.js";
import type { Agent } from "../src/schema/meta.js";
import { testUlid, createTempDir, cleanupTempDir, readTestOutputSync } from "./helpers/cli.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");

/** Very short stall timeout for tests (100ms = 0.1s) */
const TEST_STALL_TIMEOUT_SECONDS = 0.1;

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-worker",
    name: "Test Worker Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    adapter: "stall-mock-acp",
    ...overrides,
  };
}

/**
 * Register a mock adapter that delays long enough for stall to trigger.
 * The delay (5s) is much longer than the test stall timeout (100ms).
 */
function registerStallAdapter(env: Record<string, string> = {}): void {
  registerAdapter("stall-mock-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: {
      MOCK_ACP_DELAY_MS: "5000",
      MOCK_ACP_SUPPRESS_UPDATES: "true",
      ...env,
    },
    description: "Stall mock ACP agent for watchdog tests",
  });
}

/**
 * Register a fast mock adapter that sends meaningful updates before responding.
 */
function registerFastAdapter(env: Record<string, string> = {}): void {
  registerAdapter("fast-mock-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: {
      MOCK_ACP_DELAY_MS: "0",
      ...env,
    },
    description: "Fast mock ACP agent that sends updates immediately",
  });
}

async function seedStalledSession(
  sessionsDir: string,
  sessionId: string,
  taskRef: string,
  agentId: string,
): Promise<void> {
  await createSession(sessionsDir, {
    id: sessionId,
    agent_type: "stall-mock-acp",
    agent_id: agentId,
    task_id: taskRef,
    trigger: "task.ready",
  });
  await closeSession(sessionsDir, sessionId, "stalled", "No initial response within 120s");
  await new Promise((resolve) => setTimeout(resolve, 2));
}

async function seedFailedSession(
  sessionsDir: string,
  sessionId: string,
  taskRef: string,
  agentId: string,
): Promise<void> {
  await createSession(sessionsDir, {
    id: sessionId,
    agent_type: "stall-mock-acp",
    agent_id: agentId,
    task_id: taskRef,
    trigger: "task.ready",
  });
  await closeSession(sessionsDir, sessionId, "failed", "Seeded failure");
  await new Promise((resolve) => setTimeout(resolve, 2));
}

function readEventsJsonl(
  eventsPath: string,
): Array<{ type: string; data: Record<string, unknown> }> {
  const content = readTestOutputSync(eventsPath);
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ─── AC-1: Stall detection when no meaningful updates arrive ──────────────────

// AC: @invocation-initial-activity-watchdog ac-1
describe("Stall detection — no meaningful updates", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-stall-ac1-");
    registerStallAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should detect stall and return stalled outcome when agent sends no updates", async () => {
    // AC: @invocation-initial-activity-watchdog ac-1
    const agent = makeTestAgent({
      budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test stall detection",
      trigger: "task.ready",
      timeoutMinutes: 1, // Long timeout so stall fires first
    });

    expect(result.outcome).toBe("stalled");
    expect(result.session.status).toBe("stalled");
    expect(result.error).toContain("no initial response");
  });

  it("should detect stall when agent sends only non-meaningful updates", async () => {
    // AC: @invocation-initial-activity-watchdog ac-1
    registerAdapter("nonmeaningful-mock-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_DELAY_MS: "5000",
        MOCK_ACP_SEND_NON_MEANINGFUL_ONLY: "true",
      },
      description: "Mock that sends only available_commands_update",
    });

    const agent = makeTestAgent({
      adapter: "nonmeaningful-mock-acp",
      budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test non-meaningful update stall",
      trigger: "task.ready",
      timeoutMinutes: 1,
    });

    expect(result.outcome).toBe("stalled");
    expect(result.session.status).toBe("stalled");
  });
});

// ─── AC-2: Stall handling — session closed, no task note ──────────────────────

// AC: @invocation-initial-activity-watchdog ac-2
describe("Stall handling — session close and cleanup", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-stall-ac2-");
    registerStallAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should close session with status stalled and reason indicating duration", async () => {
    // AC: @invocation-initial-activity-watchdog ac-2
    const agent = makeTestAgent({
      budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test stall session close",
      trigger: "task.ready",
      timeoutMinutes: 1,
    });

    expect(result.session.status).toBe("stalled");
    expect(result.session.close_reason).toContain("No initial response within");
  });

  it("should log agent.stalled event to session JSONL", async () => {
    // AC: @invocation-initial-activity-watchdog ac-2
    const agent = makeTestAgent({
      budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
    });
    const taskRef = `@${testUlid("TASK")}`;

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Test stall event logging",
      trigger: "task.ready",
      timeoutMinutes: 1,
    });

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const events = readEventsJsonl(eventsPath);

    const stallEvent = events.find((e) => e.type === "agent.stalled");
    expect(stallEvent).toBeDefined();
    expect(stallEvent!.data.task_id).toBe(taskRef);
    expect(stallEvent!.data.stall_timeout_seconds).toBe(TEST_STALL_TIMEOUT_SECONDS);
    expect(stallEvent!.data.duration_ms).toBeGreaterThan(0);
  });

  it("should NOT add task note on stall", async () => {
    // AC: @invocation-initial-activity-watchdog ac-2
    const agent = makeTestAgent({
      budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
    });
    const taskRef = `@${testUlid("TASK")}`;
    const notes: Array<{ taskRef: string; note: string }> = [];
    const blocks: Array<{ taskRef: string; reason: string }> = [];

    await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Test no task note on stall",
      trigger: "task.ready",
      timeoutMinutes: 1,
      taskBookkeeping: {
        addTaskNote: async (ref, note) => {
          notes.push({ taskRef: ref, note });
        },
        blockTask: async (ref, reason) => {
          blocks.push({ taskRef: ref, reason });
        },
      },
    });

    expect(notes).toEqual([]);
    expect(blocks).toEqual([]);
  });

  it("should cancel ACP session on stall detection", async () => {
    // AC: @invocation-initial-activity-watchdog ac-1, ac-2
    let cancelCalledWith: string | undefined;
    const cancelSpy = vi
      .spyOn(ACPClient.prototype, "cancel")
      .mockImplementation(async (sessionId) => {
        cancelCalledWith = sessionId;
      });

    const agent = makeTestAgent({
      budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
    });

    try {
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Test stall cancel",
        trigger: "task.ready",
        timeoutMinutes: 1,
      });
    } finally {
      cancelSpy.mockRestore();
    }

    expect(cancelCalledWith).toBeDefined();
  });
});

// ─── AC-3: Stall timer cancelled on meaningful activity ───────────────────────

// AC: @invocation-initial-activity-watchdog ac-3
describe("Stall timer cancelled on meaningful activity", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-stall-ac3-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  const meaningfulTypes = [
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "usage_update",
  ];

  for (const updateType of meaningfulTypes) {
    it(`should cancel stall timer when ${updateType} is received`, async () => {
      // AC: @invocation-initial-activity-watchdog ac-3
      registerAdapter(`meaningful-${updateType}-mock`, {
        command: "node",
        args: [MOCK_ACP],
        env: {
          MOCK_ACP_DELAY_MS: "0",
          MOCK_ACP_CUSTOM_UPDATE_TYPE: updateType,
        },
        description: `Mock that sends ${updateType} update`,
      });

      const agent = makeTestAgent({
        adapter: `meaningful-${updateType}-mock`,
        budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
      });

      const result = await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: `Test ${updateType} cancels stall`,
        trigger: "task.ready",
        timeoutMinutes: 1,
      });

      // Should complete normally, not stall
      expect(result.outcome).toBe("success");
      expect(result.session.status).toBe("completed");
    });
  }
});

// ─── AC-4: Stalled sessions excluded from consecutive failure count ───────────

// AC: @invocation-initial-activity-watchdog ac-4
describe("Stalled sessions excluded from failure count", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-stall-ac4-");
    registerStallAdapter();
    registerFastAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should not count stalled sessions toward consecutive failures", async () => {
    // AC: @invocation-initial-activity-watchdog ac-4
    // Seed: 2 failed sessions, then 1 stalled session (most recent)
    const sessionsDir = path.join(testDir, "sessions");
    const taskRef = `@${testUlid("TASK")}`;

    await seedFailedSession(sessionsDir, testUlid("SES1"), taskRef, "test-worker");
    await seedFailedSession(sessionsDir, testUlid("SES2"), taskRef, "test-worker");
    await seedStalledSession(sessionsDir, testUlid("SES3"), taskRef, "test-worker");

    // Now run a real invocation that fails — the stalled session should be
    // filtered out, so only 2 consecutive failures + this one = 3.
    // With max_retries=3, this should trigger blocking.
    registerAdapter("fail-mock-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_EXIT_CODE: "1",
      },
      description: "Failing mock for retry count test",
    });

    const blocks: Array<{ taskRef: string; reason: string }> = [];
    await runInvocation({
      agent: makeTestAgent({
        adapter: "fail-mock-acp",
        id: "test-worker",
        budget: { max_retries: 3 },
      }),
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef,
      prompt: "Test failure after stalled",
      trigger: "task.ready",
      timeoutMinutes: 1,
      taskBookkeeping: {
        addTaskNote: async () => undefined,
        blockTask: async (ref, reason) => {
          blocks.push({ taskRef: ref, reason });
        },
      },
    });

    // The stalled session should be excluded from the count.
    // With only 2 prior failures (not 3), the new failure makes 3 total,
    // which meets the max_retries threshold → task should be blocked.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.taskRef).toBe(taskRef);
  });

  it("should not break failure streak when stalled session is between successes and failures", async () => {
    // AC: @invocation-initial-activity-watchdog ac-4
    // Stalled sessions return null from toInvocationOutcome, so they're
    // filtered out of the consecutive failure calculation entirely.
    const sessionsDir = path.join(testDir, "sessions");
    const taskRef = `@${testUlid("TASK")}`;

    // Seed: 1 success, then 1 stalled, then 1 failed
    await createSession(sessionsDir, {
      id: testUlid("SES1"),
      agent_type: "stall-mock-acp",
      agent_id: "test-worker",
      task_id: taskRef,
      trigger: "task.ready",
    });
    await closeSession(sessionsDir, testUlid("SES1"), "completed", "Success");
    await new Promise((resolve) => setTimeout(resolve, 2));

    await seedStalledSession(sessionsDir, testUlid("SES2"), taskRef, "test-worker");
    await seedFailedSession(sessionsDir, testUlid("SES3"), taskRef, "test-worker");

    // Run another failure — with stalled excluded, we have:
    // [failed, <stalled excluded>, success] → only 1 consecutive failure before this
    // With max_retries=3, this new failure makes 2 → should NOT trigger blocking
    registerAdapter("fail-mock-acp2", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_EXIT_CODE: "1",
      },
      description: "Failing mock for streak test",
    });

    const blocks: Array<{ taskRef: string; reason: string }> = [];
    await runInvocation({
      agent: makeTestAgent({
        adapter: "fail-mock-acp2",
        id: "test-worker",
        budget: { max_retries: 3 },
      }),
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef,
      prompt: "Test failure streak with stalled",
      trigger: "task.ready",
      timeoutMinutes: 1,
      taskBookkeeping: {
        addTaskNote: async () => undefined,
        blockTask: async (ref, reason) => {
          blocks.push({ taskRef: ref, reason });
        },
      },
    });

    // Should NOT be blocked — only 2 consecutive failures (< 3)
    expect(blocks).toEqual([]);
  });
});

// ─── AC-5: Custom initial_response_timeout_seconds ────────────────────────────

// AC: @invocation-initial-activity-watchdog ac-5
describe("Custom stall timeout configuration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-stall-ac5-");
    registerStallAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should use configured initial_response_timeout_seconds", async () => {
    // AC: @invocation-initial-activity-watchdog ac-5
    const customTimeout = 0.05; // 50ms — even shorter than default test timeout
    const agent = makeTestAgent({
      budget: { initial_response_timeout_seconds: customTimeout },
    });

    const startTime = Date.now();
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test custom stall timeout",
      trigger: "task.ready",
      timeoutMinutes: 1,
    });
    const _elapsed = Date.now() - startTime;

    expect(result.outcome).toBe("stalled");
    // Verify the close reason includes the custom timeout value
    expect(result.session.close_reason).toContain(`${customTimeout}s`);
  });

  it("should export DEFAULT_INITIAL_RESPONSE_TIMEOUT_SECONDS as 120", () => {
    // AC: @invocation-initial-activity-watchdog ac-5
    expect(DEFAULT_INITIAL_RESPONSE_TIMEOUT_SECONDS).toBe(120);
  });
});

// ─── Additional coverage: InvocationStallError ────────────────────────────────

describe("InvocationStallError", () => {
  it("should have correct name and message", () => {
    const err = new InvocationStallError(60);
    expect(err.name).toBe("InvocationStallError");
    expect(err.message).toContain("60s");
    expect(err.stallTimeoutSeconds).toBe(60);
  });
});

// ─── Additional coverage: Stall timer cleanup on normal completion ────────────

describe("Stall timer cleanup", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-stall-cleanup-");
    registerFastAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should not leak stall timer on normal completion", async () => {
    // The fast adapter sends agent_message_chunk immediately, resolving the stall.
    // The stall timer should be cleared in the finally block without firing.
    const agent = makeTestAgent({
      adapter: "fast-mock-acp",
      budget: { initial_response_timeout_seconds: TEST_STALL_TIMEOUT_SECONDS },
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test stall timer cleanup",
      trigger: "task.ready",
      timeoutMinutes: 1,
    });

    expect(result.outcome).toBe("success");

    // Wait longer than the stall timeout to confirm no delayed error
    await new Promise((resolve) => setTimeout(resolve, 200));
    // If the stall timer leaked, it would have fired and thrown by now
  });
});

// ─── Trait coverage: @trait-error-guidance ─────────────────────────────────────

// AC: @trait-error-guidance ac-1 — N/A: InvocationStallError is an internal error type
// handled within runInvocation, not a CLI command error shown to users.
// The error message is logged to session JSONL and returned as result.error.

// AC: @trait-error-guidance ac-2 — N/A: Stall errors are infrastructure-level and
// handled automatically by the dispatch engine's reconciliation cycle. No user action needed.

// AC: @trait-error-guidance ac-3 — N/A: Stall detection doesn't involve reference lookup.

// AC: @trait-error-guidance ac-4 — N/A: Stall is not a state transition error.

// AC: @trait-error-guidance ac-5 — N/A: Stall is not a validation error.

// AC: @trait-error-guidance ac-6 — N/A: Stall detection is not a CLI JSON mode operation.
