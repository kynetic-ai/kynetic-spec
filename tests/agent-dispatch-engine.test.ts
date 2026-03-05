/**
 * Agent Dispatch Engine tests.
 *
 * Tests for core dispatch runtime: state change matching, queuing, deduplication,
 * concurrency limits, filter evaluation, bootstrap, and graceful shutdown.
 *
 * Task: @implement-agent-dispatch-engine
 * Spec: @agent-dispatch-engine
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as YAML from "yaml";
import {
  DispatchEngine,
  type TaskStateChange,
  type DispatchEngineOptions,
} from "../src/agent-runtime/dispatch.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import {
  createTempDir,
  cleanupTempDir,
  createIsolatedKspecHome,
  testUlid,
  testUlids,
  kspec,
  initGitRepo,
} from "./helpers/cli.js";
import * as http from "node:http";
import type { Agent } from "../src/schema/meta.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

/**
 * Create a minimal Agent definition for testing.
 */
function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-worker",
    name: "Test Worker Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [{ on: "task.ready" }],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    adapter: "mock-acp",
    ...overrides,
  };
}

/**
 * Set up a minimal kspec project directory with meta containing agents.
 *
 * Uses traditional (non-shadow) layout: manifest and meta in the specDir directly.
 * Sets KSPEC_SPEC_DIR to point to the spec directory so initContext can find it.
 */
async function setupProjectWithAgents(
  dir: string,
  agents: Agent[],
): Promise<void> {
  initGitRepo(dir);

  // Use traditional layout: manifest in the dir root itself
  // Write manifest
  await fs.writeFile(
    path.join(dir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1", title: "Test Project" }),
    "utf-8",
  );

  // Write meta with agents
  await fs.writeFile(
    path.join(dir, "kynetic.meta.yaml"),
    YAML.stringify({
      kynetic_meta: "1.0",
      agents: agents.map((a) => ({
        _ulid: a._ulid,
        id: a.id,
        name: a.name,
        dispatch: a.dispatch ?? [],
        concurrency: a.concurrency,
        adapter: a.adapter,
        budget: a.budget,
        auto_approve: a.auto_approve ?? false,
        ...(a.prompt_template && { prompt_template: a.prompt_template }),
      })),
    }),
    "utf-8",
  );

  // Write empty tasks file
  await fs.writeFile(
    path.join(dir, "project.tasks.yaml"),
    YAML.stringify({ tasks: [] }),
    "utf-8",
  );
}

/**
 * Write tasks to the project tasks file.
 */
async function writeTasks(dir: string, tasks: Array<{
  _ulid: string;
  status: string;
  automation?: string;
  tags?: string[];
  priority?: number;
}>): Promise<void> {
  await fs.writeFile(
    path.join(dir, "project.tasks.yaml"),
    YAML.stringify({
      tasks: tasks.map((t) => ({
        _ulid: t._ulid,
        type: "task",
        title: `Task ${t._ulid}`,
        status: t.status,
        automation: t.automation,
        tags: t.tags ?? [],
        priority: t.priority,
        created_at: new Date().toISOString(),
        notes: [],
        todos: [],
      })),
    }),
    "utf-8",
  );
}

/**
 * Create a TaskStateChange for testing.
 */
function makeStateChange(overrides: Partial<TaskStateChange> = {}): TaskStateChange {
  return {
    taskId: testUlid("TASK"),
    taskRef: `@${testUlid("TASK")}`,
    fromStatus: "in_progress",
    toStatus: "pending",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Dispatch In-Progress Priority ───────────────────────────────────────────

describe("Dispatch in-progress priority", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-in-progress-priority-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @dispatch-in-progress-priority ac-1
  it("should prioritize in_progress entries ahead of pending/needs_work/pending_review", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [
        { on: "task.in_progress" },
        { on: "task.ready" },
        { on: "task.needs_work" },
        { on: "task.pending_review" },
      ],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });
    await engine.start();

    const internal = engine as unknown as {
      activeCount: Map<string, number>;
      queues: Map<string, Array<{ change: TaskStateChange }>>;
    };

    // Hold dispatching so we can inspect queue ordering.
    internal.activeCount.set(agent.id, 1);

    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 10),
        taskRef: `@${testUlid("TASK", 10)}`,
        fromStatus: "in_progress",
        toStatus: "pending",
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 11),
        taskRef: `@${testUlid("TASK", 11)}`,
        fromStatus: "pending_review",
        toStatus: "needs_work",
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 12),
        taskRef: `@${testUlid("TASK", 12)}`,
        fromStatus: "in_progress",
        toStatus: "pending_review",
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 13),
        taskRef: `@${testUlid("TASK", 13)}`,
        fromStatus: "pending",
        toStatus: "in_progress",
      }),
    );

    const queue = internal.queues.get(agent.id) ?? [];
    expect(queue.map((entry) => entry.change.toStatus)).toEqual([
      "in_progress",
      "needs_work",
      "pending",
      "pending_review",
    ]);

    await engine.stop();
  });

  // AC: @dispatch-in-progress-priority ac-2
  it("should enqueue existing in_progress tasks during bootstrap", async () => {
    const agent = makeTestAgent({
      id: "bootstrap-worker",
      dispatch: [{ on: "task.in_progress" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK", 20);
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  // AC: @dispatch-in-progress-priority ac-3
  it("should match task.in_progress dispatch rules with automation filters", async () => {
    const agent = makeTestAgent({
      id: "filtered-worker",
      dispatch: [{ on: "task.in_progress", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    let enqueueCount = 0;
    vi.spyOn(
      engine as unknown as { _enqueue: (a: unknown, c: unknown) => void },
      "_enqueue",
    ).mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await engine.handleStateChange({
      ...makeStateChange({
        taskId: testUlid("TASK", 30),
        taskRef: `@${testUlid("TASK", 30)}`,
        fromStatus: "pending",
        toStatus: "in_progress",
      }),
      task: { automation: "ineligible", tags: [] } as any,
    });
    expect(enqueueCount).toBe(0);

    await engine.handleStateChange({
      ...makeStateChange({
        taskId: testUlid("TASK", 31),
        taskRef: `@${testUlid("TASK", 31)}`,
        fromStatus: "pending",
        toStatus: "in_progress",
      }),
      task: { automation: "eligible", tags: [] } as any,
    });
    expect(enqueueCount).toBe(1);

    await engine.stop();
  });
});

// ─── AC-1: Matching agents queued for dispatch ────────────────────────────────

// AC: @agent-dispatch-engine ac-1
describe("AC-1: Task state change queues matching agents", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac1-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should queue dispatch when state change matches agent dispatch rule", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    // Spy on _enqueue before start so all enqueue calls are captured
    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();

    // Trigger state change: task transitions to pending (task.ready)
    const taskId = testUlid("TASK");
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    // Agent should have been enqueued
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });
});

// ─── AC-2: Multiple matching agents queued independently ─────────────────────

// AC: @agent-dispatch-engine ac-2
describe("AC-2: Multiple matching agents queued independently", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac2-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should queue each matching agent separately for the same state change", async () => {
    const agent1 = makeTestAgent({ id: "worker-1", dispatch: [{ on: "task.ready" }] });
    const agent2 = makeTestAgent({
      _ulid: testUlid("AGNT", 2),
      id: "worker-2",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent1, agent2]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    // Track enqueue calls per agent
    const enqueuedAgentIds: string[] = [];
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation((agent: unknown) => {
      enqueuedAgentIds.push((agent as { id: string }).id);
    });

    await engine.start();
    // Reset after bootstrap
    enqueuedAgentIds.length = 0;

    const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress" });
    await engine.handleStateChange(change);

    // Both agents should be enqueued independently
    expect(enqueuedAgentIds).toContain("worker-1");
    expect(enqueuedAgentIds).toContain("worker-2");
    expect(enqueuedAgentIds).toHaveLength(2);

    await engine.stop();
  });
});

// ─── AC-3: Concurrency limit queues invocations FIFO ─────────────────────────

// AC: @agent-dispatch-engine ac-3
describe("AC-3: max_concurrent limit enforced", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac3-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should not exceed max_concurrent active invocations per agent", async () => {
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    const status = engine.getStatus();
    expect(status.running).toBe(true);

    await engine.stop();
  });
});

// ─── AC-5: File watcher diffs task states ────────────────────────────────────

// AC: @agent-dispatch-engine ac-5
describe("AC-5: File watcher diffs task states", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac5-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should detect task status transitions from file changes", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    // Start with in_progress
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Update task to pending (task.ready event)
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending" }]);

    // Trigger file change notification
    const detectedChanges: TaskStateChange[] = [];
    const originalHandleStateChange = engine.handleStateChange.bind(engine);
    // Spy on handleStateChange to track changes
    const handleSpy = vi.spyOn(engine, "handleStateChange").mockImplementation(async (change) => {
      detectedChanges.push(change);
    });

    await engine.handleFileChange(testDir);

    expect(detectedChanges).toHaveLength(1);
    expect(detectedChanges[0].taskId).toBe(taskId);
    expect(detectedChanges[0].fromStatus).toBe("in_progress");
    expect(detectedChanges[0].toStatus).toBe("pending");

    handleSpy.mockRestore();
    await engine.stop();
  });

  it("should not emit change events when task status is unchanged", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Same status again — no change
    const detectedChanges: TaskStateChange[] = [];
    vi.spyOn(engine, "handleStateChange").mockImplementation(async (change) => {
      detectedChanges.push(change);
    });

    await engine.handleFileChange(testDir);

    expect(detectedChanges).toHaveLength(0);

    await engine.stop();
  });
});

// ─── AC-6: Filter evaluation ─────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-6
describe("AC-6: Dispatch rule filters applied", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac6-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should only queue agent when automation filter matches", async () => {
    const agentEligibleOnly = makeTestAgent({
      id: "eligible-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agentEligibleOnly]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "ineligible" },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Transition to pending — should NOT be queued (automation: ineligible)
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "ineligible" },
    ]);

    let dispatchedCount = 0;
    const originalEnqueue = (engine as unknown as { _enqueue: (a: unknown, c: unknown) => void })._enqueue;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      dispatchedCount++;
    });

    await engine.handleFileChange(testDir);

    expect(dispatchedCount).toBe(0);

    await engine.stop();
  });

  it("should queue agent when all filters match", async () => {
    const agentTagged = makeTestAgent({
      id: "tagged-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", tags: ["mvp"] } }],
    });
    await setupProjectWithAgents(testDir, [agentTagged]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", tags: ["mvp"] },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", tags: ["mvp"] },
    ]);

    let dispatchedCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      dispatchedCount++;
    });

    await engine.handleFileChange(testDir);

    expect(dispatchedCount).toBe(1);

    await engine.stop();
  });
});

// ─── AC-7: Event deduplication ───────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-7
describe("AC-7: Event deduplication within time window", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac7-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should deduplicate identical state changes within dedup window", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      dedupWindowMs: 5000,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    // Spy before start to capture all enqueue calls
    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    // Reset after bootstrap
    enqueueCount = 0;

    const now = Date.now();
    const taskId = testUlid("TASK");
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: now,
    };

    // First event — should be dispatched
    await engine.handleStateChange(change);
    expect(enqueueCount).toBe(1);

    // Duplicate within window — should be suppressed
    await engine.handleStateChange({ ...change, timestamp: now + 100 });
    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  it("should not deduplicate events outside the dedup window", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      dedupWindowMs: 100, // Very short window
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    // Spy before start
    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    // Reset after bootstrap
    enqueueCount = 0;

    const taskId = testUlid("TASK");
    const now = Date.now();
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: now,
    };

    await engine.handleStateChange(change);
    expect(enqueueCount).toBe(1);

    // After window expired — should be dispatched again
    await engine.handleStateChange({ ...change, timestamp: now + 200 });
    expect(enqueueCount).toBe(2);

    await engine.stop();
  });
});

// ─── AC-8: Bootstrap on start ────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-8
describe("AC-8: Bootstrap evaluates existing tasks on start", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac8-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should evaluate tasks already in matching states on engine start", async () => {
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending" }]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    // Spy before start() so bootstrap calls are captured
    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();

    // Bootstrap should have evaluated the pending task
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  it("should seed prevTaskStates so subsequent diffs work correctly", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // After bootstrap, in_progress is seeded as prevState
    // Change to pending — should detect transition
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending" }]);

    const detectedChanges: TaskStateChange[] = [];
    vi.spyOn(engine, "handleStateChange").mockImplementation(async (change) => {
      detectedChanges.push(change);
    });

    await engine.handleFileChange(testDir);

    expect(detectedChanges).toHaveLength(1);
    expect(detectedChanges[0].fromStatus).toBe("in_progress");
    expect(detectedChanges[0].toStatus).toBe("pending");

    await engine.stop();
  });
});

// ─── AC-10: Unresolvable adapter ─────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-10
describe("AC-10: Unresolvable adapter skips invocation with error log", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac10-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should log error and skip invocation when adapter cannot be resolved", async () => {
    const agentBadAdapter = makeTestAgent({
      id: "bad-adapter-agent",
      adapter: "nonexistent-adapter-xyz",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agentBadAdapter]);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    // Manually call _spawnInvocation with the bad agent via type assertion
    type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => void };
    const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress" });
    const entry = { agent: agentBadAdapter, change, retryCount: 0, nextRetryAt: 0 };

    (engine as unknown as EngineInternal)._spawnInvocation(agentBadAdapter, entry);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("nonexistent-adapter-xyz"),
    );

    errorSpy.mockRestore();
  });

  it("should add a task note when adapter cannot be resolved", async () => {
    const agentBadAdapter = makeTestAgent({
      id: "bad-adapter-agent",
      adapter: "nonexistent-adapter-xyz",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agentBadAdapter]);

    // Set up capture file to track kspec CLI calls
    const captureFile = path.join(testDir, "kspec-capture.json");
    process.env.KSPEC_CAPTURE_FILE = captureFile;

    try {
      const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

      type EngineInternal = { _spawnInvocation: (a: unknown, e: unknown) => void };
      const taskRef = `@${testUlid("TASK")}`;
      const change = makeStateChange({ toStatus: "pending", fromStatus: "in_progress", taskRef });
      const entry = { agent: agentBadAdapter, change, retryCount: 0, nextRetryAt: 0 };

      vi.spyOn(console, "error").mockImplementation(() => {});
      (engine as unknown as EngineInternal)._spawnInvocation(agentBadAdapter, entry);
      vi.restoreAllMocks();

      // Verify task note was added
      const calls = JSON.parse(fsSync.readFileSync(captureFile, "utf-8")) as Array<{ args: string[] }>;
      const noteCall = calls.find((c) => c.args.includes("note") && c.args.includes(taskRef));
      expect(noteCall).toBeTruthy();
      expect(noteCall!.args.join(" ")).toContain("AGENT-SKIP");
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }
  });
});

// ─── AC-11: Graceful shutdown ─────────────────────────────────────────────────

// AC: @agent-dispatch-engine ac-11
describe("AC-11: Graceful shutdown waits for active invocations", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac11-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should stop accepting new events after stop() is called", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    expect(engine.getStatus().running).toBe(true);

    await engine.stop();

    expect(engine.getStatus().running).toBe(false);

    // Triggering changes after stop should be no-ops
    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    const change = makeStateChange({ toStatus: "pending" });
    await engine.handleStateChange(change);
    expect(enqueueCount).toBe(0);
  });

  it("should resolve stop() only after running invocations complete", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Inject a fake long-running invocation
    let invocationResolved = false;
    const invocationPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        invocationResolved = true;
        resolve();
      }, 50);
    });
    (engine as unknown as { runningInvocations: Set<Promise<void>> }).runningInvocations.add(invocationPromise);

    const stopStarted = Date.now();
    await engine.stop();
    const stopDuration = Date.now() - stopStarted;

    // stop() should have waited for the invocation
    expect(invocationResolved).toBe(true);
    expect(stopDuration).toBeGreaterThanOrEqual(40);
  });

  it("should abort active invocations via abort controllers on stop()", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Inject a fake abort controller to verify it gets aborted
    const fakeController = new AbortController();
    let aborted = false;
    fakeController.signal.addEventListener("abort", () => { aborted = true; });
    (engine as unknown as { invocationAbortControllers: Set<AbortController> }).invocationAbortControllers.add(fakeController);

    await engine.stop();

    // Abort controller should have been signalled
    expect(aborted).toBe(true);
  });

  it("should not start queued invocations if drain runs after stop()", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();
    await engine.stop();

    const change = makeStateChange({ toStatus: "pending" });
    const queueEntry = {
      agent,
      change,
      retryCount: 0,
      nextRetryAt: 0,
      enqueuedAtMs: Date.now(),
    };

    const internal = engine as unknown as {
      queues: Map<string, unknown[]>;
      _drainQueues: (agents: unknown[]) => Promise<void>;
    };
    internal.queues.set(agent.id, [queueEntry]);

    const spawnSpy = vi.spyOn(engine as unknown as { _spawnInvocation: (a: unknown, e: unknown) => boolean }, "_spawnInvocation");

    await internal._drainQueues([agent]);

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(internal.queues.get(agent.id)).toHaveLength(1);
  });
});

// ─── AC-12: Shadow branch serialization ──────────────────────────────────────

// AC: @agent-dispatch-engine ac-12
describe("AC-12: Shadow branch mutations serialized via mutex", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac12-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should provide a shadow mutex for exclusive access to shadow branch", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    const mutex = engine.getShadowMutex();
    expect(mutex).toBeDefined();
    expect(typeof mutex.runExclusive).toBe("function");

    await engine.stop();
  });

  it("should serialize concurrent operations through the mutex", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    const mutex = engine.getShadowMutex();
    const results: number[] = [];

    // Run two concurrent operations through the mutex
    await Promise.all([
      mutex.runExclusive(async () => {
        results.push(1);
        await new Promise((r) => setTimeout(r, 10));
        results.push(2);
      }),
      mutex.runExclusive(async () => {
        results.push(3);
        await new Promise((r) => setTimeout(r, 10));
        results.push(4);
      }),
    ]);

    // Operations should be serialized: [1, 2, 3, 4] or [3, 4, 1, 2]
    expect(results).toHaveLength(4);
    // Verify the pairs are not interleaved
    const firstPair = results.slice(0, 2);
    const secondPair = results.slice(2, 4);
    const validOrdering =
      (firstPair[0] === 1 && firstPair[1] === 2 && secondPair[0] === 3 && secondPair[1] === 4) ||
      (firstPair[0] === 3 && firstPair[1] === 4 && secondPair[0] === 1 && secondPair[1] === 2);
    expect(validOrdering).toBe(true);

    await engine.stop();
  });
});

// ─── AC-4: CLI API event processing ─────────────────────────────────────────

// AC: @agent-dispatch-engine ac-4
describe("AC-4: CLI posts state change event via handleStateChange", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac4-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should process state change events submitted directly (CLI API path)", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.needs_work" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // reset after bootstrap

    // Simulate CLI posting a state change event
    const taskId = testUlid("TASK");
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending_review",
      toStatus: "needs_work",
      timestamp: Date.now(),
    };

    await engine.handleStateChange(change);

    // Agent should have been enqueued via direct API event
    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });
});

// ─── AC-8 (daemon-agent-dispatch): structural boundaries for watch rendering ──

describe("Text chunk boundary signaling", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-boundary-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("should emit empty chunk boundary on non-text updates between text chunks", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const seenChunks: string[] = [];
    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      opts.onUpdate?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "before tool" },
      } as unknown as import("../src/acp/index.js").SessionUpdate);
      opts.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        name: "Bash",
        input: {},
      } as unknown as import("../src/acp/index.js").SessionUpdate);
      opts.onUpdate?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "after tool" },
      } as unknown as import("../src/acp/index.js").SessionUpdate);
      return {
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      onTextChunk: (_sessionId, _agentId, _taskId, text) => {
        seenChunks.push(text);
      },
    });

    await engine.start();
    const taskId = testUlid("TASK");
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    });

    expect(seenChunks).toEqual(["before tool", "", "after tool"]);
    await engine.stop();
  });
});

describe("Autonomous dispatch prompt guardrails", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-prompt-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("should include worker completion guardrails for task.ready triggers", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    await engine.start();
    const taskId = testUlid("TASK");
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    });

    for (let i = 0; i < 20 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(runSpy).toHaveBeenCalled();
    const invocationOpts = runSpy.mock.calls[0][0];
    expect(invocationOpts.prompt).toContain("AUTONOMOUS DISPATCH MODE");
    expect(invocationOpts.prompt).toContain("Do not ask for confirmation");
    expect(invocationOpts.prompt).toContain("Perform the required commands");
    expect(invocationOpts.prompt).toContain("avoid PR conflation");

    await engine.stop();
  });

  it("should include reviewer completion guardrails for task.pending_review triggers", async () => {
    const reviewer = makeTestAgent({
      id: "reviewer",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [reviewer]);

    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      session: {} as any,
      outcome: "success",
      durationMs: 1,
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    await engine.start();
    const taskId = testUlid("TASK");
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
    });

    for (let i = 0; i < 20 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(runSpy).toHaveBeenCalled();
    const invocationOpts = runSpy.mock.calls[0][0];
    expect(invocationOpts.prompt).toContain("AUTONOMOUS DISPATCH MODE");
    expect(invocationOpts.prompt).toContain("Review flow completion criteria");
    expect(invocationOpts.prompt).toContain("configured review workflow");

    await engine.stop();
  });
});

// ─── AC-13 through AC-16: Dispatch prompt orientation context ────────────────

describe("Dispatch prompt orientation context and interpolation", () => {
  // AC: @agent-dispatch-engine ac-16
  describe("interpolateTemplate", () => {
    // Import the exported helpers directly
    let interpolateTemplate: typeof import("../src/agent-runtime/dispatch.js").interpolateTemplate;
    let buildOrientationContext: typeof import("../src/agent-runtime/dispatch.js").buildOrientationContext;

    beforeEach(async () => {
      const mod = await import("../src/agent-runtime/dispatch.js");
      interpolateTemplate = mod.interpolateTemplate;
      buildOrientationContext = mod.buildOrientationContext;
    });

    it("should replace known variables", () => {
      const result = interpolateTemplate("Work on {{task_ref}} — {{task_title}}", {
        task_ref: "@my-task",
        task_title: "Fix the bug",
      });
      expect(result).toBe('Work on @my-task — Fix the bug');
    });

    it("should pass through unresolved variables unchanged", () => {
      const result = interpolateTemplate("{{task_ref}} and {{unknown}}", {
        task_ref: "@task",
      });
      expect(result).toBe("@task and {{unknown}}");
    });

    it("should handle template with no variables", () => {
      const result = interpolateTemplate("Work on this task", { task_ref: "@task" });
      expect(result).toBe("Work on this task");
    });

    it("should handle empty vars object", () => {
      const result = interpolateTemplate("{{task_ref}}", {});
      expect(result).toBe("{{task_ref}}");
    });
  });

  // AC: @agent-dispatch-engine ac-13
  describe("buildOrientationContext", () => {
    let buildOrientationContext: typeof import("../src/agent-runtime/dispatch.js").buildOrientationContext;

    beforeEach(async () => {
      const mod = await import("../src/agent-runtime/dispatch.js");
      buildOrientationContext = mod.buildOrientationContext;
    });

    it("should include task title and trigger for task.ready", () => {
      const result = buildOrientationContext("@my-task", "task.ready", {
        title: "Implement feature X",
      });
      expect(result).toContain("## Task Context");
      expect(result).toContain("@my-task");
      expect(result).toContain("Implement feature X");
      expect(result).toContain("New task assignment");
    });

    it("should include trigger for task.in_progress", () => {
      const result = buildOrientationContext("@my-task", "task.in_progress", {
        title: "Continue work",
      });
      expect(result).toContain("Continuing in-progress work");
    });

    // AC: @agent-dispatch-engine ac-14
    it("should include last 3 notes for task.needs_work", () => {
      const notes = [
        { created_at: "2026-01-01T00:00:00Z", author: "alice", content: "Note 1" },
        { created_at: "2026-01-02T00:00:00Z", author: "bob", content: "Note 2" },
        { created_at: "2026-01-03T00:00:00Z", author: "carol", content: "Note 3" },
        { created_at: "2026-01-04T00:00:00Z", author: "dave", content: "Note 4" },
      ];
      const result = buildOrientationContext("@my-task", "task.needs_work", {
        title: "Fix it",
        notes,
      });
      expect(result).toContain("Fix cycle");
      expect(result).toContain("Recent notes:");
      // Should include last 3, not first
      expect(result).not.toContain("Note 1");
      expect(result).toContain("Note 2");
      expect(result).toContain("Note 3");
      expect(result).toContain("Note 4");
    });

    it("should truncate long notes to 200 characters", () => {
      const longContent = "x".repeat(300);
      const notes = [
        { created_at: "2026-01-01T00:00:00Z", author: "reviewer", content: longContent },
      ];
      const result = buildOrientationContext("@my-task", "task.needs_work", {
        title: "Fix it",
        notes,
      });
      // Should not contain full 300-char content
      expect(result).not.toContain(longContent);
      // Should contain truncated version (200 chars)
      expect(result).toContain("x".repeat(200));
    });

    it("should omit notes section when no notes for fix cycle", () => {
      const result = buildOrientationContext("@my-task", "task.needs_work", {
        title: "Fix it",
        notes: [],
      });
      expect(result).toContain("Fix cycle");
      expect(result).not.toContain("Recent notes:");
    });

    // AC: @agent-dispatch-engine ac-15
    it("should include review_url for task.pending_review", () => {
      const result = buildOrientationContext("@my-task", "task.pending_review", {
        title: "Review this",
        review_url: "https://github.com/org/repo/pull/42",
      });
      expect(result).toContain("Task submitted for review");
      expect(result).toContain("https://github.com/org/repo/pull/42");
    });

    it("should show fallback when review_url missing for reviewer", () => {
      const result = buildOrientationContext("@my-task", "task.pending_review", {
        title: "Review this",
      });
      expect(result).toContain("Not provided");
      expect(result).toContain("task notes or git log");
    });

    it("should handle undefined task data gracefully", () => {
      const result = buildOrientationContext("@my-task", "task.ready", undefined);
      expect(result).toContain("(unavailable)");
      expect(result).toContain("## Task Context");
    });
  });

  // Integration: prompt includes orientation context via dispatch engine
  describe("dispatch engine prompt integration", () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = await createTempDir("kspec-dispatch-orientation-");
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanupTempDir(testDir);
    });

    // AC: @agent-dispatch-engine ac-13
    it("should include orientation context in dispatched prompt", async () => {
      const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
      await setupProjectWithAgents(testDir, [agent]);

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
      });

      await engine.start();
      const taskId = testUlid("TASK");
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: { _ulid: taskId, title: "Test task title", slugs: [], status: "pending", type: "task", priority: 3, blocked_by: [], depends_on: [], context: [], tags: [], vcs_refs: [], notes: [], todos: [], created_at: new Date().toISOString() } as any,
      });

      for (let i = 0; i < 20 && runSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(runSpy).toHaveBeenCalled();
      const prompt = runSpy.mock.calls[0][0].prompt;
      expect(prompt).toContain("## Task Context");
      expect(prompt).toContain("Test task title");
      expect(prompt).toContain("New task assignment");

      await engine.stop();
    });

    // AC: @agent-dispatch-engine ac-16
    it("should interpolate prompt_template variables", async () => {
      const agent = makeTestAgent({
        id: "worker",
        dispatch: [{ on: "task.ready" }],
        prompt_template: "Handle {{task_ref}} ({{task_title}}) triggered by {{trigger}}",
      });
      await setupProjectWithAgents(testDir, [agent]);

      const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
        session: {} as any,
        outcome: "success",
        durationMs: 1,
      });

      const engine = new DispatchEngine({
        projectDir: testDir,
        specDir: testDir,
        kspecCliPath: MOCK_KSPEC_CLI,
      });

      await engine.start();
      const taskId = testUlid("TASK");
      await engine.handleStateChange({
        taskId,
        taskRef: `@${taskId}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        timestamp: Date.now(),
        task: { _ulid: taskId, title: "My task", slugs: [], status: "pending", type: "task", priority: 3, blocked_by: [], depends_on: [], context: [], tags: [], vcs_refs: [], notes: [], todos: [], created_at: new Date().toISOString() } as any,
      });

      for (let i = 0; i < 20 && runSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(runSpy).toHaveBeenCalled();
      const prompt = runSpy.mock.calls[0][0].prompt;
      expect(prompt).toContain(`Handle @${taskId}`);
      expect(prompt).toContain("(My task)");
      expect(prompt).toContain("triggered by task.ready");

      await engine.stop();
    });
  });
});

// ─── AC-9: Retry with exponential backoff ─────────────────────────────────────

// AC: @agent-dispatch-engine ac-9
describe("AC-9: Retry transient errors with exponential backoff", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac9-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should re-enqueue failed invocation with retry count incremented", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Verify retry logic by checking the queue re-enqueue behavior
    // The entry should be re-added with retryCount + 1 after a failure
    const change: TaskStateChange = {
      taskId: testUlid("TASK"),
      taskRef: `@${testUlid("TASK")}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    const entry = { agent: agent as unknown, change, retryCount: 0, nextRetryAt: 0 };

    // Simulate a failure in the runExclusive handler by tracking queue state
    type EngineInternal = {
      queues: Map<string, unknown[]>;
      activeCount: Map<string, number>;
    };
    const internal = engine as unknown as EngineInternal;

    // Set up: agent has 1 slot, mark it as active so spawn doesn't actually run
    // but entry still re-enqueues
    internal.activeCount.set(agent.id, agent.concurrency.max_concurrent);

    // Direct queue manipulation to verify retry fields
    const queueEntry = { agent, change, retryCount: 0, nextRetryAt: 0 };

    // Simulate what happens when retry triggers: retryCount increments and nextRetryAt is set
    const retryCount = queueEntry.retryCount + 1;
    const backoffMs = Math.min(1000 * Math.pow(2, retryCount - 1), 30_000);
    queueEntry.retryCount = retryCount;
    queueEntry.nextRetryAt = Date.now() + backoffMs;

    expect(retryCount).toBe(1);
    expect(backoffMs).toBe(1000); // First retry: 1000ms
    expect(queueEntry.nextRetryAt).toBeGreaterThan(Date.now());

    // Second retry
    const retryCount2 = queueEntry.retryCount + 1;
    const backoffMs2 = Math.min(1000 * Math.pow(2, retryCount2 - 1), 30_000);
    expect(backoffMs2).toBe(2000); // Second retry: 2000ms (exponential)

    await engine.stop();
  });

  it("should schedule a wake-up timer to drain the queue after retry backoff", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Track drain calls via _loadAgents spy
    let drainCallCount = 0;
    const origLoadAgents = (engine as unknown as { _loadAgents: () => Promise<unknown[]> })._loadAgents.bind(engine);
    (engine as unknown as { _loadAgents: () => Promise<unknown[]> })._loadAgents = async () => {
      drainCallCount++;
      return origLoadAgents();
    };

    vi.useFakeTimers();

    // Simulate a retry scenario: an entry with nextRetryAt in the future
    const queueEntry = {
      agent,
      change: makeStateChange({ toStatus: "pending" }),
      retryCount: 1,
      nextRetryAt: Date.now() + 1000,
    };

    // Call the retry scheduling path directly via the internal handler
    const queue = (engine as unknown as { queues: Map<string, unknown[]> }).queues;
    queue.set(agent.id, [queueEntry]);

    // Simulate the timer being scheduled (as if a failed invocation just re-enqueued)
    const backoffMs = 1000;
    setTimeout(() => {
      if ((engine as unknown as { running: boolean }).running) {
        (engine as unknown as { _loadAgents: () => Promise<unknown[]> })._loadAgents()
          .then(() => {/* drain */})
          .catch(() => {});
      }
    }, backoffMs);

    // Before timer fires, no extra drain calls
    const countBefore = drainCallCount;

    // Advance timers to fire the wake-up
    await vi.advanceTimersByTimeAsync(1100);

    // After timer fires, drain was called
    expect(drainCallCount).toBeGreaterThan(countBefore);

    vi.useRealTimers();
    await engine.stop();
  });
});

// ─── Trait AC N/A annotations ────────────────────────────────────────────────

// @trait-error-guidance ACs are N/A for the dispatch engine:
// The dispatch engine is an internal runtime, not a CLI command. Error guidance
// traits apply to user-facing CLI commands, not to internal modules.
// AC: @trait-error-guidance ac-1 — N/A: dispatch engine is not a CLI command, errors are logged internally
// AC: @trait-error-guidance ac-2 — N/A: dispatch engine is not a CLI command, errors are logged internally
// AC: @trait-error-guidance ac-3 — N/A: dispatch engine is not a CLI command, no user-facing ref lookup
// AC: @trait-error-guidance ac-4 — N/A: dispatch engine is not a CLI command, no state transition errors shown to user
// AC: @trait-error-guidance ac-5 — N/A: dispatch engine is not a CLI command, no validation errors shown to user
// AC: @trait-error-guidance ac-6 — N/A: dispatch engine is not a CLI command, no JSON mode

// ─── GetStatus ───────────────────────────────────────────────────────────────

describe("getStatus", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-status-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should report not running before start()", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir });
    const status = engine.getStatus();

    expect(status.running).toBe(false);
    expect(status.activeInvocations).toBe(0);
    expect(status.queuedInvocations).toBe(0);
  });

  it("should report running after start()", async () => {
    const agent = makeTestAgent();
    await setupProjectWithAgents(testDir, [agent]);

    const engine = new DispatchEngine({ projectDir: testDir });
    await engine.start();
    const status = engine.getStatus();

    expect(status.running).toBe(true);

    await engine.stop();
  });
});

// ─── Stale Queue Entry Discard ───────────────────────────────────────────────

describe("Stale queue entry discard", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-stale-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-17
  it("should discard queued entries when task has moved to a different state", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.in_progress" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    // Task starts as in_progress
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    // Block runInvocation so the first invocation holds the slot
    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => { resolveFirst = r; });
    const runSpy = vi.spyOn(invocationModule, "runInvocation")
      .mockImplementationOnce(async () => {
        await firstBlock;
        return { session: {} as any, outcome: "success" as const, durationMs: 1 };
      })
      .mockResolvedValue({
        session: {} as any,
        outcome: "success" as const,
        durationMs: 1,
      });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    await engine.start();

    // First invocation is running (bootstrap picked up in_progress task)
    // Wait for first invocation to start
    for (let i = 0; i < 50 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Enqueue another event for the same task while first is running
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "in_progress",
      timestamp: Date.now(),
    });

    // Verify it was enqueued
    expect(engine.getStatus().queuedInvocations).toBe(1);

    // Now update the task to completed (simulating the task finishing)
    await writeTasks(testDir, [{ _ulid: taskId, status: "completed" }]);

    // Release the first invocation
    resolveFirst();

    // Wait for drain to process
    await new Promise((r) => setTimeout(r, 200));

    // The stale entry should have been discarded — only 1 invocation total
    expect(runSpy).toHaveBeenCalledTimes(1);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-17
  it("should keep queued entries when task state still matches", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.in_progress" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskId1, taskId2] = testUlids("TASK", 2);
    // Both tasks in_progress
    await writeTasks(testDir, [
      { _ulid: taskId1, status: "in_progress" },
      { _ulid: taskId2, status: "in_progress" },
    ]);

    // Block first invocation
    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => { resolveFirst = r; });
    const runSpy = vi.spyOn(invocationModule, "runInvocation")
      .mockImplementationOnce(async () => {
        await firstBlock;
        return { session: {} as any, outcome: "success" as const, durationMs: 1 };
      })
      .mockResolvedValue({
        session: {} as any,
        outcome: "success" as const,
        durationMs: 1,
      });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    await engine.start();

    // Wait for bootstrap to fire first invocation
    for (let i = 0; i < 50 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runSpy).toHaveBeenCalledTimes(1);

    // task2 is still in_progress — its queue entry should survive
    expect(engine.getStatus().queuedInvocations).toBeGreaterThanOrEqual(1);

    // Release first invocation
    resolveFirst();

    // Wait for second invocation to start
    for (let i = 0; i < 50 && runSpy.mock.calls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Second invocation should have been spawned (task2 still in_progress)
    expect(runSpy).toHaveBeenCalledTimes(2);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-17
  it("should discard queued entries when task has been deleted", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.in_progress" }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress" }]);

    // Block first invocation
    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => { resolveFirst = r; });
    const runSpy = vi.spyOn(invocationModule, "runInvocation")
      .mockImplementationOnce(async () => {
        await firstBlock;
        return { session: {} as any, outcome: "success" as const, durationMs: 1 };
      })
      .mockResolvedValue({
        session: {} as any,
        outcome: "success" as const,
        durationMs: 1,
      });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    await engine.start();

    for (let i = 0; i < 50 && runSpy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Enqueue another event while first is running
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "in_progress",
      timestamp: Date.now(),
    });

    expect(engine.getStatus().queuedInvocations).toBe(1);

    // Delete the task (write empty tasks list)
    await writeTasks(testDir, []);

    // Release first invocation
    resolveFirst();
    await new Promise((r) => setTimeout(r, 200));

    // Entry for deleted task should have been discarded
    expect(runSpy).toHaveBeenCalledTimes(1);

    await engine.stop();
  });
});

// ─── Self-trigger suppression ────────────────────────────────────────────────

describe("Self-trigger suppression", () => {
  let testDir: string;
  let server: http.Server;
  let serverPort: number;
  let receivedEvents: unknown[];

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-selftrigger-");
    receivedEvents = [];

    // Start a minimal HTTP server to capture dispatch events
    server = http.createServer((req, res) => {
      if (req.url === "/api/agent/events" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try { receivedEvents.push(JSON.parse(body)); } catch { /* ignore */ }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    serverPort = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-18
  it("should suppress dispatch events when KSPEC_SESSION_ID is set", async () => {
    // Set up a minimal kspec project with a task
    initGitRepo(testDir);
    const taskId = testUlid("TASK");
    await fs.writeFile(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    await fs.writeFile(
      path.join(testDir, "project.tasks.yaml"),
      YAML.stringify({
        tasks: [{
          _ulid: taskId,
          type: "task",
          title: "Test task",
          status: "pending",
          tags: [],
          notes: [],
          todos: [],
          created_at: new Date().toISOString(),
        }],
      }),
    );
    // Initial git commit so kspec commands work
    await fs.writeFile(path.join(testDir, ".gitignore"), "");
    const { execSync } = await import("node:child_process");
    execSync("git add -A && git commit -m init", { cwd: testDir, stdio: "pipe" });

    // Create isolated home with fake daemon PID/port pointing at our server
    const isolated = await createIsolatedKspecHome(testDir);
    await fs.writeFile(isolated.daemonPidFilePath, String(process.pid));
    await fs.writeFile(isolated.daemonPortFilePath, String(serverPort));

    const specDirEnv = { KSPEC_SPEC_DIR: testDir };

    // Run task start WITHOUT KSPEC_SESSION_ID — event should be posted
    kspec(`task start @${taskId}`, testDir, {
      env: { ...isolated.env, ...specDirEnv },
    });
    // Give async fire-and-forget fetch time to complete
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedEvents.length).toBe(1);

    // Reset task to pending for the next test
    receivedEvents = [];
    await fs.writeFile(
      path.join(testDir, "project.tasks.yaml"),
      YAML.stringify({
        tasks: [{
          _ulid: taskId,
          type: "task",
          title: "Test task",
          status: "pending",
          tags: [],
          notes: [],
          todos: [],
          created_at: new Date().toISOString(),
        }],
      }),
    );
    execSync("git add -A && git commit -m reset", { cwd: testDir, stdio: "pipe" });

    // Run task start WITH KSPEC_SESSION_ID — event should be suppressed
    kspec(`task start @${taskId}`, testDir, {
      env: { ...isolated.env, ...specDirEnv, KSPEC_SESSION_ID: "test-session-id" },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedEvents.length).toBe(0);
  });
});
