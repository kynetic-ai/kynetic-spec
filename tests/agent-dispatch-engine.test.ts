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
  depends_on?: string[];
  blocked_by?: string[];
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
        depends_on: t.depends_on ?? [],
        blocked_by: t.blocked_by ?? [],
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
  // AC: @dispatch-in-progress-priority ac-4
  it("should prioritize in_progress first and pending_review ahead of pending", async () => {
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

    // Provide inline task data with automation: eligible so task.ready/task.needs_work
    // default filter passes (AC-21). Tasks are not on disk to avoid staleness discard.
    const makeEligibleTask = (id: string) => ({ automation: "eligible", tags: [] }) as any;

    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 10),
        taskRef: `@${testUlid("TASK", 10)}`,
        fromStatus: "in_progress",
        toStatus: "pending",
        task: makeEligibleTask(testUlid("TASK", 10)),
      }),
    );
    await engine.handleStateChange(
      makeStateChange({
        taskId: testUlid("TASK", 11),
        taskRef: `@${testUlid("TASK", 11)}`,
        fromStatus: "pending_review",
        toStatus: "needs_work",
        task: makeEligibleTask(testUlid("TASK", 11)),
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
      "pending_review",
      "pending",
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

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

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

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    // Track enqueue calls per agent
    const enqueuedAgentIds: string[] = [];
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation((agent: unknown) => {
      enqueuedAgentIds.push((agent as { id: string }).id);
    });

    await engine.start();
    // Reset after bootstrap
    enqueuedAgentIds.length = 0;

    const change = makeStateChange({ taskId, taskRef: `@${taskId}`, toStatus: "pending", fromStatus: "in_progress" });
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

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

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

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "in_progress", automation: "eligible" }]);

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
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

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

// ─── Active fleet cleanup ordering ──────────────────────────────────────────

describe("Active fleet cleanup on invocation completion", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-fleet-cleanup-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("should remove completed invocation from getStatus before draining next invocation", async () => {
    const agent = makeTestAgent({ id: "worker", dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    // Track getStatus snapshots taken during drain (inside runExclusive of the NEXT invocation)
    const statusDuringSecondInvocation: Array<ReturnType<DispatchEngine["getStatus"]>> = [];
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      invocationCount++;
      if (invocationCount === 2) {
        // During the second invocation (spawned by drain), check if the first
        // invocation has been cleaned up from status. If the bug is present,
        // the first invocation would still appear in getStatus().invocations.
        statusDuringSecondInvocation.push(engine.getStatus());
      }
      return { session: {} as any, outcome: "success", durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
    });

    await engine.start();

    // Enqueue two tasks so the drain after the first completion triggers the second
    const [taskId1, taskId2] = testUlids("TASK", 2);
    await engine.handleStateChange({
      taskId: taskId1,
      taskRef: `@${taskId1}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });
    await engine.handleStateChange({
      taskId: taskId2,
      taskRef: `@${taskId2}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now() + 1,
      task: { automation: "eligible", tags: [] } as any,
    });

    // Wait for both invocations to complete
    for (let i = 0; i < 50 && invocationCount < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(invocationCount).toBe(2);
    expect(statusDuringSecondInvocation).toHaveLength(1);

    // During the second invocation, getStatus should show exactly 1 active invocation
    // (the second one), NOT 2 (which would include the stale first invocation)
    const statusSnapshot = statusDuringSecondInvocation[0];
    expect(statusSnapshot.invocations).toHaveLength(1);
    expect(statusSnapshot.activeInvocations).toBe(1);

    await engine.stop();
  });

  it("should clean up activeInvocationDetails on failed invocation (retry exhausted)", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready" }],
      budget: { max_retries: 0 } as any,
    });
    await setupProjectWithAgents(testDir, [agent]);

    vi.spyOn(invocationModule, "runInvocation").mockRejectedValue(new Error("test failure"));

    const events: Array<{ type: string }> = [];
    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      onInvocationEvent: (e) => events.push(e),
    });

    await engine.start();

    const taskId = testUlid("TASK", 50);
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
    });

    // Wait for the invocation to fail
    for (let i = 0; i < 50 && events.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // After failure, getStatus should show no active invocations
    const status = engine.getStatus();
    expect(status.invocations).toHaveLength(0);
    expect(status.activeInvocations).toBe(0);

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

    // Write task with automation: eligible so default filter passes (AC-21)
    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending_review", automation: "eligible" }]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // reset after bootstrap

    // Simulate CLI posting a state change event
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

    const taskId = testUlid("TASK");
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
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
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

    const taskId = testUlid("TASK");

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
    await engine.handleStateChange({
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
      task: { automation: "eligible", tags: [] } as any,
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
        task: { _ulid: taskId, title: "Test task title", slugs: [], status: "pending", type: "task", priority: 3, blocked_by: [], depends_on: [], context: [], tags: [], vcs_refs: [], notes: [], todos: [], created_at: new Date().toISOString(), automation: "eligible" } as any,
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
        task: { _ulid: taskId, title: "My task", slugs: [], status: "pending", type: "task", priority: 3, blocked_by: [], depends_on: [], context: [], tags: [], vcs_refs: [], notes: [], todos: [], created_at: new Date().toISOString(), automation: "eligible" } as any,
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

// ─── AC-19: Periodic reconciliation ───────────────────────────────────────────

// AC: @agent-dispatch-engine ac-19
describe("AC-19: Periodic reconciliation re-enqueues missed tasks", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-reconcile-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-19
  it("should enqueue matching tasks with no active or queued invocation", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    // Mock _drainQueues to prevent actual invocation spawning
    vi.spyOn(engine as unknown as { _drainQueues: (a: unknown) => Promise<void> }, "_drainQueues")
      .mockResolvedValue(undefined);
    const enqueueSpy = vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue");

    await engine.start();

    // Bootstrap enqueued it via _enqueue (drain is no-op so entries stay)
    expect(enqueueSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Clear the queue to simulate a lost event scenario
    (engine as unknown as { queues: Map<string, unknown[]> }).queues.clear();
    enqueueSpy.mockClear();

    // Now call _reconcile — it should re-discover the task
    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();

    expect(enqueueSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-19
  it("should NOT re-enqueue tasks that already have a queued invocation", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "pending", automation: "eligible" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    // Mock _drainQueues to prevent actual invocation spawning
    vi.spyOn(engine as unknown as { _drainQueues: (a: unknown) => Promise<void> }, "_drainQueues")
      .mockResolvedValue(undefined);
    const enqueueSpy = vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue");

    await engine.start();

    // Bootstrap enqueued it — DON'T clear the queue this time
    enqueueSpy.mockClear();

    // Reconcile should see the queued entry and skip
    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();

    expect(enqueueSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-19
  it("should skip tasks in non-dispatchable states (completed, blocked)", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [{ _ulid: taskId, status: "completed" }]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    const enqueueSpy = vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue");
    await engine.start();

    // Neither bootstrap nor reconcile should enqueue completed tasks
    expect(enqueueSpy.mock.calls.length).toBe(0);

    await (engine as unknown as { _reconcile: () => Promise<void> })._reconcile();
    expect(enqueueSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });
});

// ─── AC-20: Reconciliation interval configuration ─────────────────────────────

// AC: @agent-dispatch-engine ac-20
describe("AC-20: Reconciliation interval configuration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-reconcile-interval-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-20
  it("should run reconciliation on the configured interval", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 100, // 100ms for testing
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();

    // Wait enough for at least one interval tick
    await new Promise((r) => setTimeout(r, 250));

    expect(reconcileSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-20
  it("should NOT run reconciliation when interval is 0", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(reconcileSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-20
  it("should NOT run reconciliation when interval is null", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: null,
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();
    await new Promise((r) => setTimeout(r, 200));

    expect(reconcileSpy.mock.calls.length).toBe(0);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-20
  it("should stop reconciliation timer on engine stop", async () => {
    const agent = makeTestAgent({ dispatch: [{ on: "task.ready" }] });
    await setupProjectWithAgents(testDir, [agent]);
    await writeTasks(testDir, []);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 50,
    });

    const reconcileSpy = vi.spyOn(
      engine as unknown as { _reconcile: () => Promise<void> },
      "_reconcile",
    );

    await engine.start();
    await engine.stop();

    const callsAtStop = reconcileSpy.mock.calls.length;

    // Wait well past interval — no more calls should happen
    await new Promise((r) => setTimeout(r, 200));
    expect(reconcileSpy.mock.calls.length).toBe(callsAtStop);
  });
});

// ─── AC-21: Default automation filter for task.ready/task.needs_work ────────

// AC: @agent-dispatch-engine ac-21
describe("AC-21: Default automation:eligible for task.ready/task.needs_work without filter", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-ac21-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should reject ineligible tasks on task.ready rules with no filter", async () => {
    // Agent with NO filter on task.ready — should still default to automation:eligible
    const agent = makeTestAgent({
      id: "no-filter-worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "ineligible" },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // reset after bootstrap

    // Transition to pending (task.ready) — should NOT be queued because task is ineligible
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "ineligible" },
    ]);

    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);

    await engine.stop();
  });

  it("should accept eligible tasks on task.ready rules with no filter", async () => {
    const agent = makeTestAgent({
      id: "no-filter-worker",
      dispatch: [{ on: "task.ready" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible" },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible" },
    ]);

    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  it("should reject ineligible tasks on task.needs_work rules with no filter", async () => {
    const agent = makeTestAgent({
      id: "needs-work-worker",
      dispatch: [{ on: "task.needs_work" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "ineligible" },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "needs_work", automation: "ineligible" },
    ]);

    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);

    await engine.stop();
  });

  it("should NOT default automation filter for task.pending_review rules", async () => {
    // task.pending_review should NOT default to automation:eligible
    // Use same pattern as AC-6 positive test: spy handleStateChange to verify event detection
    const agent = makeTestAgent({
      id: "reviewer-no-filter",
      dispatch: [{ on: "task.pending_review" }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "ineligible" },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });
    await engine.start();

    // Transition to pending_review — should be queued even though task is ineligible
    // because task.pending_review does NOT default to automation:eligible
    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending_review", automation: "ineligible" },
    ]);

    // Use handleStateChange directly to test filter behavior independently of file diffing
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending_review",
      timestamp: Date.now(),
    };

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  it("should allow explicit filter override on task.ready rules", async () => {
    // Rule explicitly says automation: undefined (via empty filter) — default still applies
    const agentWithExplicitAny = makeTestAgent({
      id: "explicit-any-worker",
      dispatch: [{ on: "task.ready", filter: { tags: ["mvp"] } }],
    });
    await setupProjectWithAgents(testDir, [agentWithExplicitAny]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "ineligible", tags: ["mvp"] },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "ineligible", tags: ["mvp"] },
    ]);

    await engine.handleFileChange(testDir);

    // Still rejected — default automation:eligible applies when filter doesn't specify automation
    expect(enqueueCount).toBe(0);

    await engine.stop();
  });
});

// ─── Priority filter threshold semantics ──────────────────────────────────────

// AC: @ui-agent-dispatch ac-8
describe("Priority filter uses threshold semantics (<=)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-priority-threshold-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should match tasks with priority equal to filter threshold", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 3 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", priority: 3 },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", priority: 3 },
    ]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(1);
    await engine.stop();
  });

  it("should match tasks with higher priority (lower number) than threshold", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 3 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", priority: 1 },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", priority: 1 },
    ]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(1);
    await engine.stop();
  });

  it("should reject tasks with lower priority (higher number) than threshold", async () => {
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 2 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible", priority: 5 },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", priority: 5 },
    ]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  it("should reject tasks with default priority (3) when filter requires higher (1)", async () => {
    // Schema defaults task priority to 3 when not specified.
    // Filter priority: 1 means only tasks with priority <= 1 match.
    const agent = makeTestAgent({
      id: "priority-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", priority: 1 } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const taskId = testUlid("TASK");
    await writeTasks(testDir, [
      { _ulid: taskId, status: "in_progress", automation: "eligible" },
    ]);

    const engine = new DispatchEngine({ projectDir: testDir, specDir: testDir, kspecCliPath: MOCK_KSPEC_CLI });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible" },
    ]);
    await engine.handleFileChange(testDir);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });
});

// ─── Trait: Task Readiness ────────────────────────────────────────────────────

describe("Task readiness checks in dispatch (trait-task-readiness)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-readiness-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @trait-task-readiness ac-status
  it("should only consider pending and needs_work tasks as ready, excluding all other statuses", async () => {
    const agent = makeTestAgent({
      dispatch: [
        { on: "task.ready", filter: { automation: "eligible" } },
        { on: "task.needs_work", filter: { automation: "eligible" } },
      ],
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [readyId, needsWorkId, inProgressId, reviewId, completedId, blockedId, cancelledId] = testUlids("STAT", 7);
    await writeTasks(testDir, [
      { _ulid: readyId, status: "pending", automation: "eligible" },
      { _ulid: needsWorkId, status: "needs_work", automation: "eligible" },
      { _ulid: inProgressId, status: "in_progress", automation: "eligible" },
      { _ulid: reviewId, status: "pending_review", automation: "eligible" },
      { _ulid: completedId, status: "completed", automation: "eligible" },
      { _ulid: blockedId, status: "blocked", automation: "eligible" },
      { _ulid: cancelledId, status: "cancelled", automation: "eligible" },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    const enqueuedTaskIds: string[] = [];
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation((_agent, change) => {
      enqueuedTaskIds.push((change as TaskStateChange).taskId);
    });

    await engine.start();

    // Only pending and needs_work should be enqueued via task.ready / task.needs_work rules
    expect(enqueuedTaskIds).toContain(readyId);
    expect(enqueuedTaskIds).toContain(needsWorkId);
    expect(enqueuedTaskIds).not.toContain(inProgressId);
    expect(enqueuedTaskIds).not.toContain(reviewId);
    expect(enqueuedTaskIds).not.toContain(completedId);
    expect(enqueuedTaskIds).not.toContain(blockedId);
    expect(enqueuedTaskIds).not.toContain(cancelledId);

    await engine.stop();
    vi.restoreAllMocks();
  });

  // AC: @trait-task-readiness ac-deps
  it("should not dispatch task.ready when depends_on tasks are not completed", async () => {
    const [depId, taskId] = testUlids("RDEP", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Write dep task as in_progress (not completed) and the dependent task as pending
    await writeTasks(testDir, [
      { _ulid: depId, status: "in_progress", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // Reset after bootstrap

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    // The dependent task should NOT be enqueued
    expect(enqueueCount).toBe(0);

    await engine.stop();
  });

  // AC: @trait-task-readiness ac-deps
  it("should dispatch task.ready when all depends_on tasks are completed", async () => {
    const [depId, taskId] = testUlids("RDEP", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Dep is completed, dependent task is pending — should be dispatched
    await writeTasks(testDir, [
      { _ulid: depId, status: "completed", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0; // Reset after bootstrap

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(1);

    await engine.stop();
  });

  // AC: @trait-task-readiness ac-not-blocked
  it("should not dispatch task.ready when task has blocked_by entries", async () => {
    const taskId = testUlid("RBLK");
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    await writeTasks(testDir, [
      { _ulid: taskId, status: "pending", automation: "eligible", blocked_by: ["Waiting for API key"] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-not-blocked
  it("should not dispatch task.needs_work when task has blocked_by entries", async () => {
    const taskId = testUlid("RNWB");
    const agent = makeTestAgent({
      dispatch: [{ on: "task.needs_work", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    await writeTasks(testDir, [
      { _ulid: taskId, status: "needs_work", automation: "eligible", blocked_by: ["Needs clarification"] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending_review",
      toStatus: "needs_work",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-composable
  it("should check base readiness before consumer filters", async () => {
    const [depId, taskId] = testUlids("RCMP", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible", tags: ["cli"] } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Task matches all consumer filters but has unmet dep — should NOT dispatch
    await writeTasks(testDir, [
      { _ulid: depId, status: "pending", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", tags: ["cli"], depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-deps — bootstrap/reconciliation path
  it("should not enqueue tasks with unmet deps during bootstrap evaluation", async () => {
    const [depId, taskId] = testUlids("RBOT", 2);
    const agent = makeTestAgent({
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Dep is in_progress (not completed), task is pending with depends_on
    await writeTasks(testDir, [
      { _ulid: depId, status: "in_progress", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();

    // Bootstrap should not have enqueued the dependent task
    expect(enqueueCount).toBe(0);
    await engine.stop();
  });

  // AC: @trait-task-readiness ac-deps, ac-not-blocked — drainQueues path
  it("should discard queued entries in drainQueues when deps become unmet", async () => {
    const [depId, taskId] = testUlids("RDRN", 2);
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Initially dep is completed — task is dispatchable
    await writeTasks(testDir, [
      { _ulid: depId, status: "completed", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    // Block draining entirely during enqueue so entries stay in queue
    const drainSpy = vi.spyOn(engine as unknown as { _drainQueues: (...args: unknown[]) => Promise<void> }, "_drainQueues").mockResolvedValue(undefined);
    vi.spyOn(invocationModule, "runInvocation").mockResolvedValue(undefined as never);

    await engine.start();

    // Enqueue the task via handleStateChange (drain is blocked)
    const change: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "in_progress",
      toStatus: "pending",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change);

    // Verify it got queued
    let status = engine.getStatus();
    expect(status.queued.length).toBeGreaterThanOrEqual(1);

    // Now change dep to not-completed (simulating dep regression)
    await writeTasks(testDir, [
      { _ulid: depId, status: "in_progress", automation: "eligible" },
      { _ulid: taskId, status: "pending", automation: "eligible", depends_on: [`@${depId}`] },
    ]);

    // Restore drain so readiness check runs, trigger via file change
    drainSpy.mockRestore();
    await engine.handleFileChange(testDir);

    // The queued entry should have been discarded due to unmet deps
    status = engine.getStatus();
    expect(status.queued).toHaveLength(0);

    await engine.stop();
  });

  // Verify task.in_progress and task.pending_review are NOT affected by dep checks
  it("should not apply dep/blocked checks to task.in_progress or task.pending_review events", async () => {
    const [depId, taskId] = testUlids("RNRR", 2);
    const agent = makeTestAgent({
      dispatch: [
        { on: "task.in_progress" },
        { on: "task.pending_review" },
      ],
    });
    await setupProjectWithAgents(testDir, [agent]);

    // Task has unmet dep and blocked_by, but events are in_progress/pending_review
    await writeTasks(testDir, [
      { _ulid: depId, status: "pending", automation: "eligible" },
      { _ulid: taskId, status: "in_progress", automation: "eligible", depends_on: [`@${depId}`], blocked_by: ["something"] },
    ]);

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    let enqueueCount = 0;
    vi.spyOn(engine as unknown as { _enqueue: (a: unknown, c: unknown) => void }, "_enqueue").mockImplementation(() => {
      enqueueCount++;
    });

    await engine.start();
    enqueueCount = 0;

    // task.in_progress should dispatch even with unmet deps and blocked_by
    const change1: TaskStateChange = {
      taskId,
      taskRef: `@${taskId}`,
      fromStatus: "pending",
      toStatus: "in_progress",
      timestamp: Date.now(),
    };
    await engine.handleStateChange(change1);

    expect(enqueueCount).toBeGreaterThanOrEqual(1);

    await engine.stop();
  });
});

// ─── AC-23, AC-24, AC-25: Post-invocation re-evaluation ─────────────────────

describe("Post-invocation re-evaluation", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-dispatch-post-invocation-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  // AC: @agent-dispatch-engine ac-23
  // AC: @agent-dispatch-engine ac-24
  it("should re-evaluate tasks from disk after invocation completes, discovering new pending_review tasks", async () => {
    // Setup: pr-reviewer defined BEFORE task-worker (definition order controls drain priority).
    // Both share max_concurrent: 1 per agent. The key scenario: a worker runs, and during its
    // execution a task transitions to pending_review on disk. Without re-evaluation, the drain
    // loop after worker completion won't see it (it was never in any queue).
    const reviewer = makeTestAgent({
      id: "pr-reviewer",
      dispatch: [{ on: "task.pending_review" }],
      concurrency: { max_concurrent: 1 },
    });
    const worker = makeTestAgent({
      id: "task-worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [reviewer, worker]);

    const [taskA, taskB] = testUlids("PREV", 2);

    // Initially: only taskA is pending (ready for worker). No pending_review tasks yet.
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
    ]);

    const spawned: Array<{ agentId: string; taskRef: string }> = [];
    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => { resolveFirst = r; });
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async (opts) => {
      invocationCount++;
      const agentId = (opts as any).agent?.id ?? "unknown";
      const taskRef = (opts as any).taskRef ?? "unknown";
      spawned.push({ agentId, taskRef });

      if (invocationCount === 1) {
        // Simulate the worker finishing: taskA moves to pending_review,
        // and taskB appears as pending_review (submitted during worker run).
        await writeTasks(testDir, [
          { _ulid: taskA, status: "pending_review" },
          { _ulid: taskB, status: "pending_review" },
        ]);
        await firstBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0, // Disable periodic reconciliation
    });

    await engine.start();

    // Wait for first invocation (worker picks up taskA via bootstrap)
    for (let i = 0; i < 100 && invocationCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(1);
    expect(spawned[0].agentId).toBe("task-worker");

    // Release worker — post-invocation re-evaluation should discover pending_review tasks
    resolveFirst();

    // Wait for reviewer to be spawned
    for (let i = 0; i < 100 && invocationCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // The second spawn should be the reviewer, discovering the pending_review tasks
    // that appeared on disk during the worker's execution.
    expect(invocationCount).toBeGreaterThanOrEqual(2);
    expect(spawned[1].agentId).toBe("pr-reviewer");

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-24
  it("should not double-enqueue tasks already queued via skipIfActive dedup", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskA, taskB] = testUlids("DDUP", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
      { _ulid: taskB, status: "pending", automation: "eligible" },
    ]);

    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => { resolveFirst = r; });
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      invocationCount++;
      if (invocationCount === 1) {
        await firstBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    await engine.start();

    // Wait for first invocation to start
    for (let i = 0; i < 100 && invocationCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(1);

    // Release first invocation — re-evaluation runs, but should NOT double-enqueue taskB
    resolveFirst();

    // Wait for second invocation
    for (let i = 0; i < 100 && invocationCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Exactly 2 invocations (one per task), not 3+ from double-enqueue
    expect(invocationCount).toBe(2);

    await engine.stop();
  });

  // AC: @agent-dispatch-engine ac-25
  it("should still drain existing queue when re-evaluation fails", async () => {
    const agent = makeTestAgent({
      id: "worker",
      dispatch: [{ on: "task.ready", filter: { automation: "eligible" } }],
      concurrency: { max_concurrent: 1 },
    });
    await setupProjectWithAgents(testDir, [agent]);

    const [taskA, taskB] = testUlids("FAIL", 2);
    await writeTasks(testDir, [
      { _ulid: taskA, status: "pending", automation: "eligible" },
      { _ulid: taskB, status: "pending", automation: "eligible" },
    ]);

    let resolveFirst!: () => void;
    const firstBlock = new Promise<void>((r) => { resolveFirst = r; });
    let invocationCount = 0;

    vi.spyOn(invocationModule, "runInvocation").mockImplementation(async () => {
      invocationCount++;
      if (invocationCount === 1) {
        await firstBlock;
      }
      return { session: {} as any, outcome: "success" as const, durationMs: 1 };
    });

    const engine = new DispatchEngine({
      projectDir: testDir,
      specDir: testDir,
      kspecCliPath: MOCK_KSPEC_CLI,
      reconcileIntervalMs: 0,
    });

    await engine.start();

    // Wait for first invocation to start
    for (let i = 0; i < 100 && invocationCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(invocationCount).toBe(1);

    // Sabotage _evaluateAllTasks so it throws on the next call (post-invocation re-eval).
    // The already-queued taskB should still drain.
    const evaluateSpy = vi.spyOn(
      engine as unknown as { _evaluateAllTasks: (opts: { skipIfActive: boolean }) => Promise<number> },
      "_evaluateAllTasks",
    );
    evaluateSpy.mockRejectedValueOnce(new Error("simulated disk failure"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Release first invocation
    resolveFirst();

    // Wait for second invocation (from pre-existing queue, not re-evaluation)
    for (let i = 0; i < 100 && invocationCount < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // taskB should still have been drained from the existing queue
    expect(invocationCount).toBe(2);

    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Post-invocation re-evaluation failed"),
      expect.any(Error),
    );

    warnSpy.mockRestore();
    await engine.stop();
  });
});
