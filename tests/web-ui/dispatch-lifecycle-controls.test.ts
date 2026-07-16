import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testUlids } from "../helpers/cli.ts";

const modeState = vi.hoisted(() => ({ staticMode: false }));
const modeMock = vi.hoisted(() => () => ({
  isStaticMode: () => modeState.staticMode,
  assertWritable: (operation: string) => {
    if (modeState.staticMode) throw new Error(`Cannot ${operation} in read-only mode.`);
  },
  ReadOnlyModeError: class ReadOnlyModeError extends Error {},
}));
const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));
const constantsMock = vi.hoisted(() => () => ({
  DAEMON_API_BASE: "http://localhost:3456",
}));

vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../../packages/web-ui/src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../../packages/web-ui/src/lib/constants", constantsMock);
vi.mock("$lib/api-static", () => ({}));
vi.mock("../../packages/web-ui/src/lib/api-static", () => ({}));

import {
  controlDispatchLifecycle,
  DispatchLifecycleApiError,
  fetchAgentStatus,
  parseAgentDispatchStatusWire,
  type AgentDispatchStatus,
} from "../../packages/web-ui/src/lib/api";
import {
  getGlobalLifecycleActions,
  getTaskLifecycleActions,
  getLifecycleBadge,
} from "../../packages/web-ui/src/lib/dispatch-lifecycle";

const [taskA, taskB, cleanupA, cleanupB] = testUlids("WU", 4);
const timestamp = "2026-07-16T12:00:00.000Z";

function cleanupEntry(overrides: Record<string, unknown> = {}) {
  return {
    cleanup_id: cleanupA,
    scope: "global",
    status: "pending",
    phase: "owned",
    ...overrides,
  };
}

export function lifecycleStatusFixture(overrides: Record<string, unknown> = {}) {
  return {
    dispatch_enabled: true,
    active_invocations: [
      {
        session_id: taskA,
        agent_id: "task-worker",
        task_ref: "@task-a",
        task_title: "Task A",
        elapsed_ms: 1250,
        resolved_adapter: "codex-acp",
        runner: "worker-runner",
      },
    ],
    queued_invocations: [
      {
        agent_id: "task-worker",
        task_ref: "@task-b",
        task_title: "Task B",
        wait_ms: 500,
        resolved_adapter: "codex-acp",
      },
    ],
    queue_depth: 1,
    agent_definitions: [
      {
        id: "task-worker",
        name: "Task worker",
        adapter: "codex-acp",
        resolved_adapter: "codex-acp",
        runner: "worker-runner",
        completed_sessions: 4,
      },
    ],
    degraded: { active: false, reason: "", enteredAt: null },
    global_authority: "paused",
    projection: "draining",
    cleanup_state: { status: "idle", entries: [] },
    active_count: 1,
    held_count: 1,
    held_tasks: [
      {
        task_id: taskA,
        task_ref: "@task-a",
        title: "Task A",
        scope: "global",
        mode: "paused",
        reason: "operator request",
        actor: "ui",
        source: "ui",
        controlled_at: timestamp,
        updated_at: timestamp,
      },
    ],
    task_controls: [
      {
        task_id: taskB,
        task_ref: "@task-b",
        title: "Task B",
        mode: "stopped",
        reason: "maintenance",
        actor: "ui",
        source: "ui",
        controlled_at: timestamp,
        updated_at: timestamp,
        cleanup_state: { status: "idle", entries: [] },
      },
    ],
    degraded_targets: [],
    ...overrides,
  };
}

function lifecycleMutationData(status = lifecycleStatusFixture()) {
  return {
    global_authority: status.global_authority,
    projection: status.projection,
    cleanup_state: status.cleanup_state,
    active_count: status.active_count,
    queue_depth: status.queue_depth,
    held_count: status.held_count,
    held_tasks: status.held_tasks,
    task_controls: status.task_controls,
    degraded_targets: status.degraded_targets,
  };
}

export function renderLifecycleConsumer(status: AgentDispatchStatus) {
  return {
    badge: getLifecycleBadge(status),
    globalActions: getGlobalLifecycleActions(status),
    heldTaskIds: status.heldTasks.map((task) => task.taskId),
    evidence: [status.activeCount, status.queueDepth, status.heldCount],
  };
}

export function recordControlRequest(responseBody = lifecycleStatusFixture()) {
  const requests: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({
        url: String(input),
        body,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            ...lifecycleMutationData(responseBody),
            outcome: "applied",
            ...(body?.scope === "task" ? { task_id: taskB, task_ref: "@task-b" } : {}),
          },
          error: null,
        }),
      } as Response;
    }),
  );
  return requests;
}

beforeEach(() => {
  modeState.staticMode = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatch lifecycle wire conversion", () => {
  // AC: @ui-agent-dispatch ac-1
  // AC: @ui-agent-dispatch ac-2
  // AC: @ui-agent-dispatch ac-status-projection
  it("deep-converts the exact public snake_case model to camelCase UI data", () => {
    const parsed = parseAgentDispatchStatusWire(lifecycleStatusFixture());
    expect(parsed).toEqual({
      dispatchEnabled: true,
      activeInvocations: [
        {
          sessionId: taskA,
          agentId: "task-worker",
          taskRef: "@task-a",
          taskTitle: "Task A",
          elapsedMs: 1250,
          resolvedAdapter: "codex-acp",
          runner: "worker-runner",
        },
      ],
      queuedInvocations: [
        {
          agentId: "task-worker",
          taskRef: "@task-b",
          taskTitle: "Task B",
          waitMs: 500,
          resolvedAdapter: "codex-acp",
        },
      ],
      queueDepth: 1,
      agentDefinitions: [
        {
          id: "task-worker",
          name: "Task worker",
          adapter: "codex-acp",
          resolvedAdapter: "codex-acp",
          runner: "worker-runner",
          completedSessions: 4,
        },
      ],
      degraded: { active: false, reason: "", enteredAt: null },
      globalAuthority: "paused",
      projection: "draining",
      cleanupState: { status: "idle", entries: [] },
      activeCount: 1,
      heldCount: 1,
      heldTasks: [
        {
          taskId: taskA,
          taskRef: "@task-a",
          title: "Task A",
          scope: "global",
          mode: "paused",
          reason: "operator request",
          actor: "ui",
          source: "ui",
          controlledAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      taskControls: [
        {
          taskId: taskB,
          taskRef: "@task-b",
          title: "Task B",
          mode: "stopped",
          reason: "maintenance",
          actor: "ui",
          source: "ui",
          controlledAt: timestamp,
          updatedAt: timestamp,
          cleanupState: { status: "idle", entries: [] },
        },
      ],
      degradedTargets: [],
    });
    expect(renderLifecycleConsumer(parsed)).toEqual({
      badge: "Paused — draining",
      globalActions: ["resume", "stop"],
      heldTaskIds: [taskA],
      evidence: [1, 1, 1],
    });
  });

  it.each([
    { cleanup_state: { status: "idle", entries: [cleanupEntry()] } },
    { cleanup_state: { status: "pending", entries: [] } },
    { cleanup_state: { status: "failed", entries: [cleanupEntry()] } },
    {
      cleanup_state: {
        status: "pending",
        entries: [cleanupEntry({ error_code: "internal_error" })],
      },
    },
    {
      cleanup_state: {
        status: "failed",
        entries: [cleanupEntry({ status: "failed" })],
      },
    },
    {
      cleanup_state: {
        status: "failed",
        entries: [cleanupEntry({ status: "failed", error_code: "raw_stack_trace" })],
      },
    },
    { held_count: 0 },
    {
      held_tasks: [lifecycleStatusFixture().held_tasks[0], lifecycleStatusFixture().held_tasks[0]],
    },
    { globalAuthority: "paused" },
    { dispatchEnabled: true },
    { cleanupState: { status: "idle", entries: [] } },
    {
      active_invocations: [
        { ...lifecycleStatusFixture().active_invocations[0], agentId: "task-worker" },
      ],
    },
    {
      cleanup_state: {
        status: "pending",
        entries: [cleanupEntry(), cleanupEntry({ cleanup_id: cleanupB })],
      },
    },
    {
      cleanup_state: {
        status: "pending",
        entries: [
          cleanupEntry(),
          cleanupEntry({ cleanup_id: cleanupA, scope: "task", task_id: taskB }),
        ],
      },
    },
    {
      cleanup_state: {
        status: "pending",
        entries: [
          cleanupEntry({ cleanup_id: cleanupB, scope: "task", task_id: taskB }),
          cleanupEntry(),
        ],
      },
    },
    {
      held_tasks: [{ ...lifecycleStatusFixture().held_tasks[0], task_id: taskA.toLowerCase() }],
    },
    {
      held_count: 2,
      held_tasks: [
        { ...lifecycleStatusFixture().held_tasks[0], task_id: taskB },
        lifecycleStatusFixture().held_tasks[0],
      ],
    },
    {
      task_controls: [
        lifecycleStatusFixture().task_controls[0],
        lifecycleStatusFixture().task_controls[0],
      ],
    },
    {
      task_controls: [
        {
          ...lifecycleStatusFixture().task_controls[0],
          cleanup_state: {
            status: "pending",
            entries: [cleanupEntry({ scope: "task", task_id: taskA })],
          },
        },
      ],
    },
  ])("fails closed for malformed or mixed-case lifecycle payload %#", (overrides) => {
    expect(() => parseAgentDispatchStatusWire(lifecycleStatusFixture(overrides))).toThrow();
  });

  it("rejects unknown public status root fields before lifecycle projection", () => {
    expect(() =>
      parseAgentDispatchStatusWire(
        lifecycleStatusFixture({ unexpected_lifecycle_detail: "must not be discarded" }),
      ),
    ).toThrow();
  });

  it.each([
    {
      status: "pending",
      entries: [
        cleanupEntry(),
        cleanupEntry({ cleanup_id: cleanupB, scope: "task", task_id: taskB }),
      ],
    },
    {
      status: "failed",
      entries: [
        cleanupEntry({ status: "failed", error_code: "cancellation_timeout" }),
        cleanupEntry({
          cleanup_id: cleanupB,
          scope: "task",
          task_id: taskB,
          status: "failed",
          error_code: "session_closure_failed",
        }),
      ],
    },
  ])("deep-converts exact all-$status cleanup aggregates", (cleanupState) => {
    const parsed = parseAgentDispatchStatusWire(
      lifecycleStatusFixture({ cleanup_state: cleanupState }),
    );
    expect(parsed.cleanupState).toEqual({
      status: cleanupState.status,
      entries: cleanupState.entries.map((entry) => ({
        cleanupId: entry.cleanup_id,
        scope: entry.scope,
        ...(entry.task_id === undefined ? {} : { taskId: entry.task_id }),
        status: entry.status,
        phase: entry.phase,
        ...(entry.error_code === undefined ? {} : { errorCode: entry.error_code }),
      })),
    });
  });

  it("accepts mixed failed and pending entries only with exact conditionals and ordering", () => {
    const parsed = parseAgentDispatchStatusWire(
      lifecycleStatusFixture({
        cleanup_state: {
          status: "failed",
          entries: [
            cleanupEntry({ status: "failed", error_code: "cancellation_failed" }),
            cleanupEntry({
              cleanup_id: cleanupB,
              scope: "task",
              task_id: taskB,
            }),
          ],
        },
      }),
    );
    expect(parsed.cleanupState.entries[0]).toEqual(
      expect.objectContaining({ cleanupId: cleanupA, errorCode: "cancellation_failed" }),
    );
    expect(parsed.cleanupState.entries[1]).toEqual(
      expect.objectContaining({ cleanupId: cleanupB, taskId: taskB }),
    );
    expect(parsed.cleanupState.entries[1]).not.toHaveProperty("errorCode");
  });

  it("keeps legacy active evidence visible with an unknown/stopping projection", () => {
    const legacy: Record<string, unknown> = lifecycleStatusFixture({ dispatch_enabled: false });
    for (const key of [
      "global_authority",
      "projection",
      "cleanup_state",
      "active_count",
      "held_count",
      "held_tasks",
      "task_controls",
      "degraded_targets",
    ]) {
      delete legacy[key];
    }
    const parsed = parseAgentDispatchStatusWire(legacy);
    expect(parsed).toMatchObject({
      globalAuthority: "stopped",
      projection: "legacy_unknown_stopping",
      activeCount: 1,
      activeInvocations: [expect.objectContaining({ sessionId: taskA })],
    });
  });
});

describe("matching-scope lifecycle controls", () => {
  // AC: @ui-agent-dispatch ac-3
  // AC: @ui-agent-dispatch ac-stopped-actions-valid
  it.each([
    ["running", "running", { status: "idle", entries: [] }, ["pause", "stop"]],
    ["paused", "paused", { status: "idle", entries: [] }, ["resume", "stop"]],
    ["paused", "draining", { status: "idle", entries: [] }, ["resume", "stop"]],
    ["stopped", "stopped", { status: "idle", entries: [] }, ["start"]],
    ["stopped", "stopped", { status: "pending", entries: [cleanupEntry()] }, ["stop"]],
    [
      "stopped",
      "stopped",
      {
        status: "failed",
        entries: [cleanupEntry({ status: "failed", error_code: "cancellation_failed" })],
      },
      ["stop"],
    ],
    [
      "stopped",
      "stopped",
      {
        status: "pending",
        entries: [cleanupEntry({ scope: "task", task_id: taskA })],
      },
      ["start"],
    ],
  ])(
    "selects only valid global actions for %s/%s",
    (authority, projection, cleanupState, actions) => {
      const status = parseAgentDispatchStatusWire(
        lifecycleStatusFixture({
          global_authority: authority,
          projection,
          cleanup_state: cleanupState,
        }),
      );
      expect(getGlobalLifecycleActions(status)).toEqual(actions);
    },
  );

  it("selects task actions using only the matching canonical task cleanup", () => {
    const status = parseAgentDispatchStatusWire(
      lifecycleStatusFixture({
        global_authority: "stopped",
        projection: "stopped",
        cleanup_state: {
          status: "failed",
          entries: [cleanupEntry({ status: "failed", error_code: "internal_error" })],
        },
        task_controls: [
          {
            ...lifecycleStatusFixture().task_controls[0],
            cleanup_state: { status: "idle", entries: [] },
          },
        ],
      }),
    );
    expect(getTaskLifecycleActions(status, taskA)).toEqual(["pause", "stop"]);
    expect(getTaskLifecycleActions(status, taskB)).toEqual(["resume"]);
  });

  it("shows retry hard stop for a stopped task with matching pending cleanup", () => {
    const status = parseAgentDispatchStatusWire(
      lifecycleStatusFixture({
        task_controls: [
          {
            ...lifecycleStatusFixture().task_controls[0],
            cleanup_state: {
              status: "pending",
              entries: [cleanupEntry({ scope: "task", task_id: taskB })],
            },
          },
        ],
      }),
    );
    expect(getTaskLifecycleActions(status, taskB)).toEqual(["stop"]);
  });
});

describe("lifecycle API behavior", () => {
  it("sends canonical global and task requests and converts canonical task response identity", async () => {
    const requests = recordControlRequest();
    await controlDispatchLifecycle({ scope: "global", action: "pause" });
    const taskResult = await controlDispatchLifecycle({
      scope: "task",
      action: "resume",
      taskRef: "@task-b",
    });
    expect(requests.map((request) => request.body)).toEqual([
      { scope: "global", action: "pause" },
      { scope: "task", action: "resume", task_ref: "@task-b" },
    ]);
    expect(taskResult.taskId).toBe(taskB);
    expect(taskResult.taskRef).toBe("@task-b");
    expect(taskResult.status.globalAuthority).toBe("paused");
  });

  it.each([
    {
      label: "response envelope",
      mutate: (body: Record<string, unknown>) => ({ ...body, unexpected: true }),
    },
    {
      label: "response data",
      mutate: (body: Record<string, unknown>) => ({
        ...body,
        data: { ...(body.data as Record<string, unknown>), unexpected: true },
      }),
    },
  ])("rejects unknown mutation $label fields", async ({ mutate }) => {
    const body = {
      ok: true,
      data: { ...lifecycleMutationData(), outcome: "applied" },
      error: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => mutate(body) }) as Response),
    );

    await expect(controlDispatchLifecycle({ scope: "global", action: "pause" })).rejects.toThrow();
  });

  it("fetches and converts the public status response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => lifecycleStatusFixture() }) as Response,
      ),
    );
    expect((await fetchAgentStatus()).heldTasks[0]?.taskId).toBe(taskA);
  });

  it("maps status failures through fixed lifecycle copy while preserving evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 409,
            json: async () => ({
              ok: false,
              data: lifecycleMutationData(),
              error: { code: "invalid_transition", message: "private daemon detail" },
            }),
          }) as Response,
      ),
    );
    const error = await fetchAgentStatus().catch((caught) => caught);
    expect(error).toMatchObject({
      message: "Invalid dispatch lifecycle transition",
      status: expect.objectContaining({ activeCount: 1, heldCount: 1 }),
    });
    expect(error.message).not.toContain("private daemon detail");
  });

  it("maps stale 409 failures to fixed copy while retaining unchanged evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 409,
            json: async () => ({
              ok: false,
              data: lifecycleMutationData(),
              error: {
                code: "invalid_transition",
                message: "/private/worktree/raw failure",
                suggestion: "run rm -rf",
              },
            }),
          }) as Response,
      ),
    );
    const error = await controlDispatchLifecycle({ scope: "global", action: "start" }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(DispatchLifecycleApiError);
    expect(error).toMatchObject({
      message: "Invalid dispatch lifecycle transition",
      suggestion: "Refresh lifecycle status and choose an allowed action.",
      status: expect.objectContaining({ activeCount: 1, heldCount: 1 }),
    });
    expect(`${error.message} ${error.suggestion}`).not.toContain("/private/worktree");
    expect(`${error.message} ${error.suggestion}`).not.toContain("rm -rf");
  });

  it("returns an exact stopped read-only fallback without making a request", async () => {
    modeState.staticMode = true;
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await fetchAgentStatus()).toEqual({
      dispatchEnabled: false,
      activeInvocations: [],
      queuedInvocations: [],
      queueDepth: 0,
      agentDefinitions: [],
      degraded: { active: false, reason: "", enteredAt: null },
      globalAuthority: "stopped",
      projection: "stopped",
      cleanupState: { status: "idle", entries: [] },
      activeCount: 0,
      heldCount: 0,
      heldTasks: [],
      taskControls: [],
      degradedTargets: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps authority, projection, degraded targets, and held evidence separate", () => {
    const status = parseAgentDispatchStatusWire(
      lifecycleStatusFixture({
        degraded: { active: true, reason: "branch diverged", enteredAt: timestamp },
        degraded_targets: [
          { branch: "dev", reason: "branch diverged", enteredAt: timestamp, kind: "sync" },
        ],
      }),
    );
    expect(status.globalAuthority).toBe("paused");
    expect(status.projection).toBe("draining");
    expect(status.degradedTargets).toHaveLength(1);
    expect(status.heldTasks).toHaveLength(1);
  });
});
