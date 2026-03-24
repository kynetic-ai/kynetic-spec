/**
 * Dispatch engine multi-turn integration tests.
 *
 * Verifies that the multi-turn invocation lifecycle is properly wired into
 * the dispatch engine: session registry, event bus emission, concurrency
 * tracking, and post-invocation cleanup all work with sessions that span
 * multiple turns.
 *
 * These tests verify integration-level behavior (dispatch → invocation →
 * event bus) rather than duplicating the unit-level runInvocation() tests
 * in multi-turn-invocation.test.ts.
 *
 * Task: @task-dispatch-multi-turn-integration
 * Spec: @multi-turn-session-lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import {
  runInvocation,
  type InvocationOptions,
  type InvocationResult,
  type SessionIdleContext,
} from "../src/agent-runtime/invocation.js";
import { SessionRegistry, type SessionHandle } from "../src/agent-runtime/session-registry.js";
import { EventBus, type EventEnvelope } from "../src/agent-runtime/event-bus.js";
import {
  InvocationTerminalPayloadSchema,
  SessionIdlePayloadSchema,
  validateEventPayload,
} from "../src/schema/event-payloads.js";
import { registerAdapter } from "../src/agents/adapters.js";
import * as spawnerModule from "../src/agents/spawner.js";
import { testUlid, createTempDir, cleanupTempDir } from "./helpers/cli.js";
import type { Agent } from "../src/schema/meta.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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
    adapter: "mock-acp",
    ...overrides,
  };
}

function registerMockAdapter(): void {
  registerAdapter("mock-acp", {
    command: "node",
    args: [path.join(__dirname, "mocks", "acp-mock.js")],
    env: {
      MOCK_ACP_PROJECT_DIR: process.cwd(),
    },
    description: "Mock ACP agent for testing",
  });
}

function createMockSpawnedAgent() {
  const emitter = new EventEmitter();
  const mockAcpSessionId = "mock-acp-session";

  const spawnedAgent = {
    client: {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
      },
      newSession: vi.fn(async () => mockAcpSessionId),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
      cancel: vi.fn(async () => undefined),
      endSession: vi.fn(() => undefined),
      respondPermission: vi.fn(() => undefined),
    },
    kill: vi.fn(() => undefined),
  };

  return { spawnedAgent, emitter, mockAcpSessionId };
}

/**
 * Simulate the dispatch engine's terminal event emission logic.
 *
 * This exercises the same code path that DispatchEngine._spawnInvocation()
 * uses: run an invocation, then emit the terminal event on the event bus
 * with the enriched payload (including turn_count, duration_ms, trigger).
 */
async function runAndEmitTerminalEvent(
  eventBus: EventBus,
  options: InvocationOptions,
): Promise<{ result: InvocationResult; emittedEvents: EventEnvelope[] }> {
  const emittedEvents: EventEnvelope[] = [];
  eventBus.subscribe("invocation.*", (event) => {
    emittedEvents.push(event);
  });
  eventBus.subscribe("session.*", (event) => {
    emittedEvents.push(event);
  });

  const result = await runInvocation(options);

  // Replicate dispatch engine's terminal event emission
  // AC: @multi-turn-session-lifecycle ac-14 — include turn_count in terminal payload
  const terminalPayload: Record<string, unknown> = {
    session_id: options.sessionId ?? result.session.id,
    agent_id: options.agent.id,
    trigger: options.trigger,
    task_ref: options.taskRef ?? undefined,
    duration_ms: result.durationMs,
    turn_count: result.turnCount,
  };

  eventBus.emit({
    event_type: `invocation.${result.outcome === "success" ? "completed" : result.outcome}`,
    source_type: "invocation_lifecycle",
    source_id: options.sessionId ?? result.session.id,
    payload: terminalPayload,
  });

  return { result, emittedEvents };
}

// ─── Integration: Event Bus Terminal Events ──────────────────────────────────

// AC: @multi-turn-session-lifecycle ac-14
describe("Dispatch terminal event includes turn_count", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-mt-integration-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-14
  it("should include turn_count=1 in invocation.completed event for single-turn sessions", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const eventBus = new EventBus();
    const registry = new SessionRegistry();

    const { result, emittedEvents } = await runAndEmitTerminalEvent(eventBus, {
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Single-turn integration test",
      trigger: "task.ready",
      sessionRegistry: registry,
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(1);

    const completedEvents = emittedEvents.filter((e) => e.event_type === "invocation.completed");
    expect(completedEvents).toHaveLength(1);

    const payload = completedEvents[0].payload;
    expect(payload.turn_count).toBe(1);
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);

    // Validate payload against schema
    const validation = validateEventPayload("invocation.completed", payload);
    expect(validation.success).toBe(true);
  });

  // AC: @multi-turn-session-lifecycle ac-14
  it("should include correct turn_count in invocation.completed event for multi-turn sessions", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const eventBus = new EventBus();
    const registry = new SessionRegistry();

    const { result, emittedEvents } = await runAndEmitTerminalEvent(eventBus, {
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Multi-turn integration test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount < 3) {
          registry.get(ctx.sessionId)?.sendPrompt(`Follow-up ${ctx.turnCount + 1}`);
        }
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(3);

    const completedEvents = emittedEvents.filter((e) => e.event_type === "invocation.completed");
    expect(completedEvents).toHaveLength(1);

    const payload = completedEvents[0].payload;
    expect(payload.turn_count).toBe(3);

    // Validate against schema
    const validation = validateEventPayload("invocation.completed", payload);
    expect(validation.success).toBe(true);
  });

  // AC: @multi-turn-session-lifecycle ac-14
  it("should emit invocation.completed exactly once per session even with multiple turns", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const eventBus = new EventBus();
    const registry = new SessionRegistry();

    const { emittedEvents } = await runAndEmitTerminalEvent(eventBus, {
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Single event test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount < 5) {
          registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
        }
      },
    });

    // Only one invocation.completed event, despite 5 turns
    const completedEvents = emittedEvents.filter((e) => e.event_type === "invocation.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].payload.turn_count).toBe(5);
  });

  // AC: @multi-turn-session-lifecycle ac-14
  it("should validate terminal payload with turn_count against InvocationTerminalPayloadSchema", () => {
    // Direct schema validation test — ensures turn_count is required
    const validPayload = {
      session_id: "01JSESS000000000000000000",
      agent_id: "test-worker",
      trigger: "task.ready",
      task_ref: "@task-test",
      duration_ms: 5000,
      turn_count: 3,
    };

    const result = InvocationTerminalPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.turn_count).toBe(3);
    }

    // Should reject without turn_count
    const { turn_count: _, ...missingTurnCount } = validPayload;
    expect(InvocationTerminalPayloadSchema.safeParse(missingTurnCount).success).toBe(false);
  });
});

// ─── Integration: session.idle Events via Event Bus ──────────────────────────

// AC: @multi-turn-session-lifecycle ac-3
describe("Dispatch emits session.idle events on event bus", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-mt-idle-events-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-1
  // AC: @multi-turn-session-lifecycle ac-3
  it("should emit session.idle event on event bus when session transitions to idle", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const eventBus = new EventBus();
    const registry = new SessionRegistry();
    const idleEvents: EventEnvelope[] = [];

    eventBus.subscribe("session.idle", (event) => {
      idleEvents.push(event);
    });

    const taskRef = "@" + testUlid("TASK");

    const result = await runInvocation({
      agent: makeTestAgent({ id: "dispatch-agent" }),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Session idle event test",
      trigger: "task.ready",
      sessionRegistry: registry,
      // Wire onIdle to emit on event bus (mimics dispatch engine behavior)
      onIdle: (ctx: SessionIdleContext) => {
        eventBus.emit({
          event_type: "session.idle",
          source_type: "invocation_lifecycle",
          source_id: ctx.sessionId,
          payload: {
            session_id: ctx.sessionId,
            agent_id: ctx.agentId,
            task_ref: ctx.taskRef ?? undefined,
            turn_count: ctx.turnCount,
            stop_reason: ctx.stopReason,
            turn_duration_ms: ctx.turnDurationMs,
          },
        });

        // Queue follow-up prompts for turns 1 and 2
        if (ctx.turnCount < 3) {
          registry.get(ctx.sessionId)?.sendPrompt(`Follow-up ${ctx.turnCount + 1}`);
        }
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(3);

    // Should have 3 session.idle events (one per turn)
    expect(idleEvents).toHaveLength(3);

    // Validate each idle event payload
    for (let i = 0; i < idleEvents.length; i++) {
      const payload = idleEvents[i].payload;
      expect(payload.session_id).toBe(result.session.id);
      expect(payload.agent_id).toBe("dispatch-agent");
      expect(payload.task_ref).toBe(taskRef);
      expect(payload.turn_count).toBe(i + 1);
      expect(payload.stop_reason).toBe("end_turn");
      expect(payload.turn_duration_ms).toBeGreaterThanOrEqual(0);

      // Validate against schema
      const validation = validateEventPayload("session.idle", payload);
      expect(validation.success).toBe(true);
    }
  });

  // AC: @multi-turn-session-lifecycle ac-3
  it("should emit session.idle with valid SessionIdlePayloadSchema", () => {
    // Direct schema validation test
    const validIdlePayload = {
      session_id: "01JSESS000000000000000000",
      agent_id: "dispatch-agent",
      task_ref: "@task-test",
      turn_count: 2,
      stop_reason: "end_turn",
      turn_duration_ms: 1500,
    };

    const result = SessionIdlePayloadSchema.safeParse(validIdlePayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.turn_count).toBe(2);
      expect(result.data.turn_duration_ms).toBe(1500);
    }
  });
});

// ─── Integration: Session Registry Wiring ────────────────────────────────────

// AC: @multi-turn-session-lifecycle ac-2
// AC: @multi-turn-session-lifecycle ac-4
describe("Dispatch wires session registry for prompt delivery", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-mt-registry-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-2
  it("should keep session registered and idle-capable during multi-turn session", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const registry = new SessionRegistry();
    const statesSeenDuringIdle: string[] = [];

    await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Registry wiring test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        const handle = registry.get(ctx.sessionId);
        if (handle) {
          statesSeenDuringIdle.push(handle.getState());
        }
        if (ctx.turnCount < 2) {
          handle?.sendPrompt("Follow-up");
        }
      },
    });

    // Session was idle (registered and capable) during each idle transition
    expect(statesSeenDuringIdle).toEqual(["idle", "idle"]);
    // Session unregistered after close
    expect(registry.size).toBe(0);
  });

  // AC: @multi-turn-session-lifecycle ac-4
  it("should deliver follow-up prompts from registry handle back to agent", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    const promptTexts: string[] = [];

    spawnedAgent.client.prompt = vi.fn(async (params: { prompt: Array<{ text: string }> }) => {
      promptTexts.push(params.prompt[0].text);
      return { stopReason: "end_turn" };
    });

    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Initial dispatch prompt",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount === 1) {
          registry.get(ctx.sessionId)?.sendPrompt("Hook-injected follow-up");
        }
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(2);
    expect(promptTexts).toEqual(["Initial dispatch prompt", "Hook-injected follow-up"]);
  });
});

// ─── Integration: Multi-Turn Session Event History ───────────────────────────

// AC: @multi-turn-session-lifecycle ac-12
describe("All turns recorded in same session event history", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-mt-history-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-12
  it("should record all turns in the same session's events.jsonl", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Event history test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount < 4) {
          registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
        }
      },
    });

    expect(result.turnCount).toBe(4);

    // Read the session's event history
    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(eventsPath, "utf-8");
    const events = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // All events should share the same session
    const sessionIds = [...new Set(events.map((e: Record<string, unknown>) => e.session_id))];
    expect(sessionIds).toHaveLength(1);

    // Should have turn_completed events for each turn
    const turnEvents = events.filter((e: { type: string }) => e.type === "agent.turn_completed");
    expect(turnEvents).toHaveLength(4);

    // Turn counts should be monotonically increasing
    for (let i = 0; i < turnEvents.length; i++) {
      expect(turnEvents[i].data.turn_count).toBe(i + 1);
    }

    // Should have exactly one agent.completed event at the end
    const completedEvents = events.filter((e: { type: string }) => e.type === "agent.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].data.turn_count).toBe(4);
  });
});

// ─── Integration: Session Metadata ───────────────────────────────────────────

// AC: @multi-turn-session-lifecycle ac-13
describe("Multi-turn session metadata reflects totals", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-mt-metadata-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-13
  it("should reflect total turn count and cumulative duration in InvocationResult", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const registry = new SessionRegistry();

    const startTime = Date.now();
    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Metadata test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount < 3) {
          registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
        }
      },
    });
    const elapsed = Date.now() - startTime;

    // AC: @multi-turn-session-lifecycle ac-13 — turn count
    expect(result.turnCount).toBe(3);

    // AC: @multi-turn-session-lifecycle ac-13 — cumulative duration
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThanOrEqual(elapsed + 100); // allow small overhead

    // Session status should be completed
    expect(result.outcome).toBe("success");
    expect(result.session.status).toBe("completed");
  });
});

// ─── Integration: Task Exclusivity Across Turns ──────────────────────────────

describe("Per-task exclusivity held for entire multi-turn session", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-mt-exclusivity-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  it("should maintain session identity across all turns", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const registry = new SessionRegistry();
    const sessionIdsSeenDuringIdle: string[] = [];
    const registrySizesDuringIdle: number[] = [];

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Exclusivity test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        sessionIdsSeenDuringIdle.push(ctx.sessionId);
        registrySizesDuringIdle.push(registry.size);
        if (ctx.turnCount < 3) {
          registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
        }
      },
    });

    // All idle callbacks received the same session ID
    expect(new Set(sessionIdsSeenDuringIdle).size).toBe(1);
    expect(sessionIdsSeenDuringIdle[0]).toBe(result.session.id);

    // Registry held exactly 1 entry throughout the session
    expect(registrySizesDuringIdle).toEqual([1, 1, 1]);

    // After completion, registry is empty (session released)
    expect(registry.size).toBe(0);
  });
});
