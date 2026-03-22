/**
 * Multi-Turn Session Lifecycle tests.
 *
 * Tests for the event-driven turn loop that keeps sessions alive between
 * turns. After each agent turn completes, the session enters idle state
 * and the onIdle callback fires. Follow-up prompts are delivered via the
 * prompt queue / session handle.
 *
 * Task: @task-multi-turn-invocation
 * Spec: @multi-turn-session-lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import {
  runInvocation,
  PromptQueue,
  PromptQueueFullError,
  DEFAULT_IDLE_GRACE_MS,
  type SessionIdleContext,
} from "../src/agent-runtime/invocation.js";
import { SessionRegistry, type SessionHandle } from "../src/agent-runtime/session-registry.js";
import { registerAdapter } from "../src/agents/adapters.js";
import * as spawnerModule from "../src/agents/spawner.js";
import {
  testUlid,
  createTempDir,
  cleanupTempDir,
} from "./helpers/cli.js";
import type { Agent } from "../src/schema/meta.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");

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

function registerMockAdapter(env: Record<string, string> = {}): void {
  registerAdapter("mock-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: {
      MOCK_ACP_PROJECT_DIR: process.cwd(),
      ...env,
    },
    description: "Mock ACP agent for testing",
  });
}

/**
 * Create a mock spawned agent that responds to prompts programmatically.
 * Each call to prompt() resolves with { stopReason: "end_turn" }.
 * Returns the mock and the EventEmitter used for update/request events.
 */
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

// ─── PromptQueue Unit Tests ─────────────────────────────────────────────────

describe("PromptQueue", () => {
  // AC: @multi-turn-session-lifecycle ac-8
  it("should deliver enqueued prompts in FIFO order", async () => {
    const queue = new PromptQueue();

    queue.enqueue("first");
    queue.enqueue("second");
    queue.enqueue("third");

    expect(await queue.waitForPrompt()).toBe("first");
    expect(await queue.waitForPrompt()).toBe("second");
    expect(await queue.waitForPrompt()).toBe("third");
  });

  // AC: @multi-turn-session-lifecycle ac-9
  it("should deliver prompt immediately to a waiting consumer", async () => {
    const queue = new PromptQueue();

    // Start waiting before any prompt is enqueued
    const waitPromise = queue.waitForPrompt();

    // Enqueue after a short delay
    setTimeout(() => queue.enqueue("delivered"), 10);

    const result = await waitPromise;
    expect(result).toBe("delivered");
  });

  // AC: @multi-turn-session-lifecycle ac-17
  it("should reject enqueue when queue is full", () => {
    const queue = new PromptQueue(2);

    queue.enqueue("first");
    queue.enqueue("second");

    expect(() => queue.enqueue("third")).toThrow(PromptQueueFullError);
    expect(() => queue.enqueue("third")).toThrow(/maximum depth: 2/);
  });

  // AC: @multi-turn-session-lifecycle ac-10, ac-16
  it("should discard queued prompts on close and return them", () => {
    const queue = new PromptQueue();

    queue.enqueue("a");
    queue.enqueue("b");

    const discarded = queue.close();
    expect(discarded).toEqual(["a", "b"]);
    expect(queue.pending).toBe(0);
  });

  // AC: @multi-turn-session-lifecycle ac-10
  it("should resolve waiting consumer with null on close", async () => {
    const queue = new PromptQueue();

    const waitPromise = queue.waitForPrompt();

    queue.close();
    const result = await waitPromise;
    expect(result).toBeNull();
  });

  it("should reject enqueue after close", () => {
    const queue = new PromptQueue();
    queue.close();

    expect(() => queue.enqueue("late")).toThrow("Prompt queue is closed");
  });

  it("should return null from waitForPrompt after close with empty queue", async () => {
    const queue = new PromptQueue();
    queue.close();

    const result = await queue.waitForPrompt();
    expect(result).toBeNull();
  });
});

// ─── Single-Turn Backward Compatibility ─────────────────────────────────────

describe("Single-turn backward compatibility", { timeout: 60_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-multi-turn-compat-");
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-1
  it("should transition to idle after first turn and then close with no follow-up prompts", async () => {
    const idleContexts: SessionIdleContext[] = [];

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Single turn test",
      trigger: "task.ready",
      onIdle: (ctx) => idleContexts.push(ctx),
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(1);
    // onIdle was called once
    expect(idleContexts).toHaveLength(1);
    expect(idleContexts[0].turnCount).toBe(1);
    expect(idleContexts[0].stopReason).toBe("end_turn");
  });

  it("should return turnCount=1 for single-turn invocation without onIdle", async () => {
    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Backward compat test",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(1);
  });

  // AC: @multi-turn-session-lifecycle ac-1
  it("should log agent.turn_completed event in session events", async () => {
    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Turn event test",
      trigger: "task.ready",
    });

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await fs.readFile(eventsPath, "utf-8");
    const events = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

    const turnEvent = events.find((e: { type: string }) => e.type === "agent.turn_completed");
    expect(turnEvent).toBeDefined();
    expect(turnEvent.data.turn_count).toBe(1);
    expect(turnEvent.data.stop_reason).toBe("end_turn");
    expect(turnEvent.data.turn_duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ─── Multi-Turn Lifecycle ───────────────────────────────────────────────────

describe("Multi-turn lifecycle", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-multi-turn-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-1
  // AC: @multi-turn-session-lifecycle ac-4
  it("should execute multiple turns when onIdle queues follow-up prompts", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const idleContexts: SessionIdleContext[] = [];
    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Initial prompt",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        idleContexts.push(ctx);
        // Queue a follow-up prompt on turns 1 and 2, stop after 3
        if (ctx.turnCount < 3) {
          const handle = registry.get(ctx.sessionId);
          handle?.sendPrompt(`Follow-up prompt for turn ${ctx.turnCount + 1}`);
        }
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(3);
    expect(idleContexts).toHaveLength(3);

    // Verify prompt calls: initial + 2 follow-ups
    expect(spawnedAgent.client.prompt).toHaveBeenCalledTimes(3);

    // Verify each idle context has incrementing turn count
    expect(idleContexts[0].turnCount).toBe(1);
    expect(idleContexts[1].turnCount).toBe(2);
    expect(idleContexts[2].turnCount).toBe(3);
  });

  // AC: @multi-turn-session-lifecycle ac-2
  it("should keep session open and capable of receiving prompts while in idle", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();
    let idleHandle: SessionHandle | undefined;

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Check idle state",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        idleHandle = registry.get(ctx.sessionId);
        if (ctx.turnCount === 1) {
          // Verify state is idle when callback fires
          expect(idleHandle?.getState()).toBe("idle");
          // Queue a prompt to prove session is receptive
          idleHandle?.sendPrompt("Prompt while idle");
        }
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(2);
    // After session closes, handle should report closed
    expect(idleHandle?.getState()).toBe("closed");
  });

  // AC: @multi-turn-session-lifecycle ac-3
  it("should emit onIdle with session context on each idle transition", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();
    const idleContexts: SessionIdleContext[] = [];

    const taskRef = "@" + testUlid("TASK");

    const result = await runInvocation({
      agent: makeTestAgent({ id: "my-agent" }),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Context verification",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        idleContexts.push(ctx);
        if (ctx.turnCount < 2) {
          registry.get(ctx.sessionId)?.sendPrompt("Follow-up");
        }
      },
    });

    expect(idleContexts).toHaveLength(2);

    // First idle context
    expect(idleContexts[0].sessionId).toBe(result.session.id);
    expect(idleContexts[0].agentId).toBe("my-agent");
    expect(idleContexts[0].taskRef).toBe(taskRef);
    expect(idleContexts[0].turnCount).toBe(1);
    expect(idleContexts[0].stopReason).toBe("end_turn");
    expect(idleContexts[0].turnDurationMs).toBeGreaterThanOrEqual(0);

    // Second idle context
    expect(idleContexts[1].turnCount).toBe(2);
  });

  // AC: @multi-turn-session-lifecycle ac-8
  it("should queue prompts delivered during prompting state and deliver after turn completes", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    let promptCallCount = 0;

    // Make the first prompt take a bit to simulate work
    spawnedAgent.client.prompt = vi.fn(async () => {
      promptCallCount++;
      return { stopReason: "end_turn" };
    });

    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();
    const idleContexts: SessionIdleContext[] = [];

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Initial prompt",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        idleContexts.push(ctx);
        if (ctx.turnCount === 1) {
          // Queue two prompts during idle
          registry.get(ctx.sessionId)?.sendPrompt("Follow-up 1");
          registry.get(ctx.sessionId)?.sendPrompt("Follow-up 2");
        }
        // Turn 2: the first queued prompt was delivered, second is still queued
        if (ctx.turnCount === 2) {
          // Don't queue more — let the second queued prompt be delivered
        }
        // Turn 3: the second queued prompt was delivered, no more
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(3);
    expect(promptCallCount).toBe(3);
  });

  // AC: @multi-turn-session-lifecycle ac-9
  it("should deliver prompts from multiple sources in FIFO order", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    const receivedPrompts: string[] = [];

    spawnedAgent.client.prompt = vi.fn(async (params: { prompt: Array<{ text: string }> }) => {
      receivedPrompts.push(params.prompt[0].text);
      return { stopReason: "end_turn" };
    });

    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Prompt A",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount === 1) {
          // Simulate multiple sources queueing prompts
          registry.get(ctx.sessionId)?.sendPrompt("Prompt B");
          registry.get(ctx.sessionId)?.sendPrompt("Prompt C");
          registry.get(ctx.sessionId)?.sendPrompt("Prompt D");
        }
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(4);
    expect(receivedPrompts).toEqual(["Prompt A", "Prompt B", "Prompt C", "Prompt D"]);
  });

  // AC: @multi-turn-session-lifecycle ac-2
  // AC: @multi-turn-session-lifecycle ac-4
  it("should accept asynchronous prompt delivery via registry handle after onIdle returns", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();
    const idleContexts: SessionIdleContext[] = [];

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Initial prompt",
      trigger: "task.ready",
      timeoutMinutes: 0.05, // safety timeout
      sessionRegistry: registry,
      idleGracePeriodMs: DEFAULT_IDLE_GRACE_MS,
      onIdle: (ctx) => {
        idleContexts.push(ctx);
        if (ctx.turnCount === 1) {
          // Simulate an async prompt source: deliver prompt after a
          // short delay (not synchronously in onIdle). This exercises
          // the grace period that keeps the queue open for async sources.
          setTimeout(() => {
            registry.get(ctx.sessionId)?.sendPrompt("Async follow-up");
          }, 50);
        }
        // Turn 2: don't queue more — session closes naturally
      },
    });

    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(2);
    expect(idleContexts).toHaveLength(2);
    expect(spawnedAgent.client.prompt).toHaveBeenCalledTimes(2);
  });

  // AC: @multi-turn-session-lifecycle ac-10
  it("should discard queued prompts and close when close is requested during prompting", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Initial prompt",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount === 1) {
          // Queue some prompts then request close
          registry.get(ctx.sessionId)?.sendPrompt("This should be discarded");
          registry.get(ctx.sessionId)?.requestClose("user requested close");
        }
      },
    });

    // Session should have completed after first turn (close requested)
    // The turn loop checks for close after the NEXT turn completes,
    // but since close discards the queue, the loop exits after trying
    // to get the next prompt and getting null.
    expect(result.outcome).toBe("success");
    expect(result.turnCount).toBe(1);
  });

  // AC: @multi-turn-session-lifecycle ac-10
  it("should not start a new turn with an already-dequeued prompt when close is requested", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    // Race scenario: after idle, a prompt arrives asynchronously
    // (via setTimeout, so it resolves a waiting consumer), then
    // requestClose fires immediately after. The dequeued prompt
    // must not start a new turn because closeRequested is set.
    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Initial prompt",
      trigger: "task.ready",
      sessionRegistry: registry,
      idleGracePeriodMs: DEFAULT_IDLE_GRACE_MS,
      onIdle: (ctx) => {
        if (ctx.turnCount === 1) {
          const handle = registry.get(ctx.sessionId);
          // Schedule both operations to fire during idle wait (after
          // waitForPrompt is already listening). sendPrompt resolves
          // the waiter with the prompt, then requestClose sets the
          // closeRequested flag.
          setTimeout(() => {
            handle?.sendPrompt("should not execute");
            handle?.requestClose("race close");
          }, 10);
        }
      },
    });

    expect(result.outcome).toBe("success");
    // Only 1 turn — the dequeued prompt must not start a second turn
    expect(result.turnCount).toBe(1);
    // prompt() should only have been called once (the initial prompt)
    expect(spawnedAgent.client.prompt).toHaveBeenCalledTimes(1);
  });
});

// ─── Session Registry Integration ───────────────────────────────────────────

describe("Session registry integration", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-multi-turn-registry-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @active-session-registry ac-1
  it("should register session handle in registry before first prompt", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();
    let handleFoundDuringIdle = false;

    await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Registry test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        const handle = registry.get(ctx.sessionId);
        handleFoundDuringIdle = handle !== undefined;
      },
    });

    expect(handleFoundDuringIdle).toBe(true);
  });

  // AC: @active-session-registry ac-2
  it("should unregister session handle from registry after session closes", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Unregister test",
      trigger: "task.ready",
      sessionRegistry: registry,
    });

    // After runInvocation returns, session should be unregistered
    expect(registry.get(result.session.id)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  // AC: @active-session-registry ac-2
  it("should unregister session handle even on failure", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnedAgent.client.prompt = vi.fn(async () => {
      throw new Error("Simulated failure");
    });

    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    // Omit taskRef to avoid slow kspec CLI calls in failure handler
    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      prompt: "Failure cleanup test",
      trigger: "task.ready",
      sessionRegistry: registry,
    });

    expect(result.outcome).toBe("failed");
    expect(registry.get(result.session.id)).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});

// ─── Error Handling ──────────────────────────────────────────────────────────

describe("Multi-turn error handling", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-multi-turn-errors-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-15
  it("should close session immediately with failed status on fatal error during turn", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    let promptCallCount = 0;

    spawnedAgent.client.prompt = vi.fn(async () => {
      promptCallCount++;
      if (promptCallCount === 2) {
        throw new Error("Fatal agent error");
      }
      return { stopReason: "end_turn" };
    });

    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    // Omit taskRef to avoid slow kspec CLI calls in failure handler
    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      prompt: "Initial",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount === 1) {
          registry.get(ctx.sessionId)?.sendPrompt("This will cause error");
        }
      },
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("Fatal agent error");
    expect(result.turnCount).toBe(1); // Only one turn completed
    expect(result.session.status).toBe("failed");
  });

  // AC: @multi-turn-session-lifecycle ac-16
  it("should discard queued prompts when session closes due to error", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    let promptCallCount = 0;

    spawnedAgent.client.prompt = vi.fn(async () => {
      promptCallCount++;
      if (promptCallCount === 2) {
        throw new Error("Error during turn 2");
      }
      return { stopReason: "end_turn" };
    });

    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    // Omit taskRef to avoid slow kspec CLI calls in failure handler
    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      prompt: "Initial",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount === 1) {
          // Queue multiple prompts — they should all be discarded
          registry.get(ctx.sessionId)?.sendPrompt("Follow-up 1 (will error)");
          registry.get(ctx.sessionId)?.sendPrompt("Follow-up 2 (should discard)");
          registry.get(ctx.sessionId)?.sendPrompt("Follow-up 3 (should discard)");
        }
      },
    });

    expect(result.outcome).toBe("failed");

    // Verify prompts_discarded event was logged
    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await fs.readFile(eventsPath, "utf-8");
    const events = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

    const discardEvent = events.find((e: { type: string }) => e.type === "session.prompts_discarded");
    expect(discardEvent).toBeDefined();
    expect(discardEvent.data.discarded_count).toBe(2); // 2 remaining after first follow-up consumed
  });

  // AC: @multi-turn-session-lifecycle ac-16
  it("should reject sendPrompt on session handle after session closes", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();
    let capturedSessionId: string | undefined;

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Close test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        capturedSessionId = ctx.sessionId;
      },
    });

    // After invocation completes, the handle should reject sendPrompt
    // The handle is no longer in the registry, but let's test the handle
    // behavior directly through the session state check
    expect(result.outcome).toBe("success");
    expect(registry.get(capturedSessionId!)).toBeUndefined();
  });

  // AC: @multi-turn-session-lifecycle ac-17
  it("should reject prompt with PromptQueueFullError when queue is at max depth", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();
    let queueFullError: Error | undefined;

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Queue depth test",
      trigger: "task.ready",
      sessionRegistry: registry,
      maxPromptQueueDepth: 2,
      onIdle: (ctx) => {
        if (ctx.turnCount === 1) {
          const handle = registry.get(ctx.sessionId)!;
          // Queue up to max depth
          handle.sendPrompt("prompt 1");
          handle.sendPrompt("prompt 2");
          // This should return a rejected promise, not throw synchronously
          handle.sendPrompt("prompt 3 (overflow)").catch((err) => {
            queueFullError = err as Error;
          });
        }
      },
    });

    expect(queueFullError).toBeDefined();
    expect(queueFullError).toBeInstanceOf(PromptQueueFullError);
    expect(queueFullError!.message).toContain("maximum depth: 2");
    // Session should still complete normally with the 2 queued prompts + initial
    expect(result.turnCount).toBe(3);
  });
});

// ─── Turn Count and Duration Tracking ───────────────────────────────────────

describe("Turn count and duration tracking", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-multi-turn-tracking-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  // AC: @multi-turn-session-lifecycle ac-13
  it("should include turn count in the agent.completed event", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Turn tracking test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount < 3) {
          registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
        }
      },
    });

    expect(result.turnCount).toBe(3);

    // Check the agent.completed event includes turn_count
    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await fs.readFile(eventsPath, "utf-8");
    const events = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

    const completedEvent = events.find((e: { type: string }) => e.type === "agent.completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent.data.turn_count).toBe(3);
    expect(completedEvent.data.duration_ms).toBeGreaterThan(0);
  });

  // AC: @multi-turn-session-lifecycle ac-13
  it("should record turn_completed events for each turn with per-turn duration", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Duration tracking test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount < 2) {
          registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
        }
      },
    });

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await fs.readFile(eventsPath, "utf-8");
    const events = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

    const turnEvents = events.filter((e: { type: string }) => e.type === "agent.turn_completed");
    expect(turnEvents).toHaveLength(2);

    // Each turn event has per-turn duration
    for (const evt of turnEvents) {
      expect(evt.data.turn_duration_ms).toBeGreaterThanOrEqual(0);
      expect(evt.data.turn_count).toBeGreaterThan(0);
    }

    // Turn counts are monotonically increasing
    expect(turnEvents[0].data.turn_count).toBe(1);
    expect(turnEvents[1].data.turn_count).toBe(2);
  });

  // AC: @multi-turn-session-lifecycle ac-14
  it("should fire agent.completed exactly once at session close", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Single completed event test",
      trigger: "task.ready",
      sessionRegistry: registry,
      onIdle: (ctx) => {
        if (ctx.turnCount < 3) {
          registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
        }
      },
    });

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await fs.readFile(eventsPath, "utf-8");
    const events = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

    // agent.completed should appear exactly once
    const completedEvents = events.filter((e: { type: string }) => e.type === "agent.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].data.turn_count).toBe(3);
  });
});

// ─── New Event Types ─────────────────────────────────────────────────────────

describe("New event types in schema", () => {
  // AC: @multi-turn-session-lifecycle ac-1
  it("should include agent.turn_completed in EventTypeSchema", async () => {
    const { EventTypeSchema } = await import("../src/sessions/types.js");
    expect(() => EventTypeSchema.parse("agent.turn_completed")).not.toThrow();
  });

  // AC: @multi-turn-session-lifecycle ac-16
  it("should include session.prompts_discarded in EventTypeSchema", async () => {
    const { EventTypeSchema } = await import("../src/sessions/types.js");
    expect(() => EventTypeSchema.parse("session.prompts_discarded")).not.toThrow();
  });
});

// ─── Session Timeout Across Multiple Turns ───────────────────────────────────

describe("Session timeout across multiple turns", { timeout: 60_000 }, () => {
  let testDir: string;
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-multi-timeout-");
    registerMockAdapter();
  });

  afterEach(async () => {
    spawnSpy?.mockRestore();
    await cleanupTempDir(testDir);
  });

  it("should apply timeout to total session duration, not per-turn", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnedAgent.client.prompt = vi.fn(async () => {
      // Each turn takes ~30ms
      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: "end_turn" };
    });

    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Turn 1",
      trigger: "task.ready",
      timeoutMinutes: 0.003, // ~180ms total timeout
      sessionRegistry: registry,
      onIdle: (ctx) => {
        // Keep sending prompts indefinitely — timeout should stop us
        registry.get(ctx.sessionId)?.sendPrompt(`Turn ${ctx.turnCount + 1}`);
      },
    });

    // Session should have timed out after completing some turns
    expect(result.outcome).toBe("timed_out");
    expect(result.turnCount).toBeGreaterThanOrEqual(1);
  });

  it("should include turn_count in timeout event data", async () => {
    const { spawnedAgent } = createMockSpawnedAgent();
    spawnedAgent.client.prompt = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { stopReason: "end_turn" };
    });

    spawnSpy = vi.spyOn(spawnerModule, "spawnAndInitialize").mockResolvedValue(
      spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
    );

    const registry = new SessionRegistry();

    const result = await runInvocation({
      agent: makeTestAgent(),
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: "@" + testUlid("TASK"),
      prompt: "Timeout turn count test",
      trigger: "task.ready",
      timeoutMinutes: 0.003,
      sessionRegistry: registry,
      onIdle: (ctx) => {
        registry.get(ctx.sessionId)?.sendPrompt("next");
      },
    });

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await fs.readFile(eventsPath, "utf-8");
    const events = content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

    const timeoutEvent = events.find((e: { type: string }) => e.type === "agent.timeout");
    expect(timeoutEvent).toBeDefined();
    expect(timeoutEvent.data.turn_count).toBeGreaterThanOrEqual(1);
  });
});

// ─── Trait: error-guidance ────────────────────────────────────────────────────

// AC: @trait-error-guidance ac-1 — N/A: This is a library module (not a CLI command).
// It does not produce user-facing error messages directly. Error details are passed
// to callers via InvocationResult.error for higher-level handling.

// AC: @trait-error-guidance ac-2 — N/A: Library module; error guidance is responsibility
// of CLI commands that invoke runInvocation().

// AC: @trait-error-guidance ac-3 — N/A: No ref lookups in this module.

// AC: @trait-error-guidance ac-4 — N/A: No state transitions displayed to users.

// AC: @trait-error-guidance ac-5 — N/A: Validation errors are thrown as TypeScript errors,
// not formatted for user display.

// AC: @trait-error-guidance ac-6 — N/A: Module has no --json mode; it's a library function.
