/**
 * Daemon Automation Agent Spawner Wiring Tests
 *
 * Tests that createAutomationAgentSpawner correctly threads correlation_id
 * and group_id through to runInvocation as environment variables, preserving
 * the event correlation chain across spawned agent invocations.
 *
 * AC: @automation-action-type-completeness ac-1, ac-2, ac-3
 * AC: @dispatch-agent-action-input ac-4 (correlation_id & group_id propagation)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { testUlid } from "./helpers/cli.js";

// Mock state must be hoisted above vi.mock calls
const mockState = vi.hoisted(() => ({
  runInvocation: vi.fn(),
  initContext: vi.fn(),
  loadMetaContext: vi.fn(),
  resolveTaskDataManager: vi.fn(),
  // Tasks returned by the mocked data manager; tests override per-case.
  tasks: [] as Array<{ _ulid: string; slugs: string[] }>,
}));

// Mock the invocation module to capture runInvocation calls
vi.mock("../dist/agent-runtime/invocation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-runtime/invocation.js")>();
  return {
    ...actual,
    runInvocation: mockState.runInvocation,
  };
});

// Mock the parser module to avoid needing a real project directory. Task
// identity resolution (normalizeTaskIdentity/buildTaskRefResolver) is NOT
// mocked — it runs against the tasks returned here so the spawner's
// canonicalization behavior is exercised for real.
vi.mock("../dist/parser/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/parser/index.js")>();
  return {
    ...actual,
    initContext: mockState.initContext,
    loadMetaContext: mockState.loadMetaContext,
    resolveTaskDataManager: mockState.resolveTaskDataManager,
  };
});

import { createAutomationAgentSpawner } from "../dist/daemon/routes/agent-dispatch.js";

describe("createAutomationAgentSpawner daemon wiring", () => {
  const fakeProjectDir = "/tmp/test-project";
  const TASK_ABC_ULID = testUlid("ABC");

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock returns
    mockState.initContext.mockResolvedValue({
      specDir: "/tmp/test-project/.kspec",
      projectDir: fakeProjectDir,
    });
    mockState.loadMetaContext.mockResolvedValue({
      agents: [
        { id: "task-worker", adapter: "claude-code", prompt_file: "worker.md" },
        { id: "pr-reviewer", adapter: "claude-code", prompt_file: "reviewer.md" },
      ],
      hooks: [],
      manifest: { compositions: [] },
    });
    // Default task set: a single task resolvable by slug "task-abc".
    mockState.tasks = [{ _ulid: TASK_ABC_ULID, slugs: ["task-abc"] }];
    mockState.resolveTaskDataManager.mockImplementation(() => ({
      loadAllTasks: async () => mockState.tasks,
    }));
    mockState.runInvocation.mockResolvedValue({
      session: { id: "test-session-001" },
      outcome: "success",
      durationMs: 1000,
      turnCount: 1,
    });
  });

  // AC: @dispatch-agent-action-input ac-4 — correlation_id propagation
  it("threads correlation_id through to runInvocation as KSPEC_CORRELATION_ID env var", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({
      agent_id: "task-worker",
      prompt: "Do work",
      correlation_id: "corr-abc-123",
    });

    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.env).toBeDefined();
    expect(invocationArgs.env.KSPEC_CORRELATION_ID).toBe("corr-abc-123");
  });

  // AC: @dispatch-agent-action-input ac-4 — group_id propagation
  it("threads group_id through to runInvocation as KSPEC_COMPOSITION_GROUP_ID env var", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({
      agent_id: "task-worker",
      prompt: "Handle composition",
      group_id: "group-xyz-456",
    });

    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.env).toBeDefined();
    expect(invocationArgs.env.KSPEC_COMPOSITION_GROUP_ID).toBe("group-xyz-456");
  });

  // AC: @dispatch-agent-action-input ac-4 — both fields propagated together
  it("threads both correlation_id and group_id when both are provided", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({
      agent_id: "task-worker",
      prompt: "Composition member",
      correlation_id: "corr-both-001",
      group_id: "group-both-002",
    });

    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.env).toEqual({
      KSPEC_CORRELATION_ID: "corr-both-001",
      KSPEC_COMPOSITION_GROUP_ID: "group-both-002",
    });
  });

  // AC: @automation-action-type-completeness ac-1 — env is omitted when no context fields
  it("does not include env when neither correlation_id nor group_id is provided", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({
      agent_id: "task-worker",
      prompt: "Simple invocation",
    });

    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.env).toBeUndefined();
  });

  // AC: @automation-action-type-completeness ac-1 — core spawner fields pass through
  it("passes agent definition, specDir, cwd, taskRef, prompt, and timeout to runInvocation", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({
      agent_id: "task-worker",
      prompt: "Work on task",
      task_ref: "@task-abc",
      timeout_minutes: 30,
    });

    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.agent.id).toBe("task-worker");
    expect(invocationArgs.specDir).toBe("/tmp/test-project/.kspec");
    expect(invocationArgs.cwd).toBe(fakeProjectDir);
    // Display ref is preserved; identity is the resolved canonical ULID.
    expect(invocationArgs.taskRef).toBe("@task-abc");
    expect(invocationArgs.taskId).toBe(TASK_ABC_ULID);
    expect(invocationArgs.prompt).toBe("Work on task");
    expect(invocationArgs.trigger).toBe("manual");
    expect(invocationArgs.timeoutMinutes).toBe(30);
  });

  // ─── Canonical task identity resolution ──────────────────────────────────

  // AC: @dispatch-canonical-task-identity ac-automation-agent-actions-canonicalize-task-binding
  // AC: @dispatch-canonical-task-identity ac-project-invocation-callers-supply-canonical-task-id
  it("resolves a slug task_ref to the canonical full ULID task_id with display slug", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({ agent_id: "task-worker", task_ref: "@task-abc", prompt: "Go" });

    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.taskId).toBe(TASK_ABC_ULID);
    expect(invocationArgs.taskRef).toBe("@task-abc");
  });

  // AC: @dispatch-canonical-task-identity ac-automation-agent-actions-canonicalize-task-binding
  // AC: @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
  it("derives @<task_id> display ref for a task_id-only event binding", async () => {
    const eventTaskId = testUlid("EVT");
    mockState.tasks = []; // task not in snapshot — a valid full ULID is still trusted
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({ agent_id: "task-worker", task_id: eventTaskId, prompt: "Go" });

    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.taskId).toBe(eventTaskId);
    expect(invocationArgs.taskRef).toBe(`@${eventTaskId}`);
  });

  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("rejects an event task_id/task_ref pair that resolves to different tasks without creating an invocation", async () => {
    const ulidA = testUlid("AAA");
    const ulidB = testUlid("BBB");
    mockState.tasks = [
      { _ulid: ulidA, slugs: ["task-a"] },
      { _ulid: ulidB, slugs: ["task-b"] },
    ];
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await expect(
      spawner({ agent_id: "task-worker", task_id: ulidA, task_ref: "@task-b", prompt: "Go" }),
    ).rejects.toThrow(/task-bound agent action.*resolves to a different task|rejecting/i);

    expect(mockState.runInvocation).not.toHaveBeenCalled();
  });

  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("rejects an unresolved task_ref without creating an invocation", async () => {
    mockState.tasks = [{ _ulid: TASK_ABC_ULID, slugs: ["task-abc"] }];
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await expect(
      spawner({ agent_id: "task-worker", task_ref: "@task-ghost", prompt: "Go" }),
    ).rejects.toThrow(/task-bound agent action.*could not be resolved|rejecting/i);

    expect(mockState.runInvocation).not.toHaveBeenCalled();
  });

  // AC: @dispatch-canonical-task-identity ac-automation-agent-actions-canonicalize-task-binding
  // Non-task-scoped actions skip resolution entirely and run unchanged.
  it("does not resolve task identity for non-task-scoped actions", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await spawner({ agent_id: "task-worker", prompt: "No task binding" });

    expect(mockState.resolveTaskDataManager).not.toHaveBeenCalled();
    expect(mockState.runInvocation).toHaveBeenCalledOnce();
    const invocationArgs = mockState.runInvocation.mock.calls[0][0];
    expect(invocationArgs.taskId).toBeUndefined();
    expect(invocationArgs.taskRef).toBeUndefined();
  });

  // AC: @automation-action-type-completeness ac-4 — unknown agent error
  it("throws descriptive error when agent_id is not found", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    await expect(
      spawner({
        agent_id: "nonexistent-agent",
        prompt: "Should fail",
      }),
    ).rejects.toThrow(/nonexistent-agent.*not found.*Available agents.*task-worker.*pr-reviewer/);
  });

  // AC: @dispatch-agent-action-input ac-4 — returns invocation_id
  it("returns invocation_id from the spawned session", async () => {
    const spawner = createAutomationAgentSpawner(fakeProjectDir);

    const result = await spawner({
      agent_id: "task-worker",
      prompt: "Do work",
    });

    expect(result.invocation_id).toBe("test-session-001");
  });
});
