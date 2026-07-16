import { execSync } from "node:child_process";
import { chmodSync, cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Elysia } from "elysia";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  DispatchCleanupStateSchema,
  DispatchHeldTaskSchema,
  DispatchLifecycleStatusSchema,
  DispatchTaskControlStatusSchema,
} from "../packages/shared/src/api.ts";
import { cleanupTempDir, createTempDir, initGitRepo, testUlids } from "./helpers/cli.ts";
import { captureBroadcasts, createTestApp, makeRequest } from "./daemon-api/helpers.ts";
import {
  createAgentDispatchRoutes,
  getDispatchEngine,
  stopAllEngines,
} from "../dist/daemon/routes/agent-dispatch.js";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";
import {
  DispatchEngine,
  DispatchCleanupError,
  DispatchLifecycleTransitionError,
} from "../dist/agent-runtime/dispatch.js";
import { DispatchShadowTransactionError } from "../dist/agent-runtime/dispatch-shadow-transaction.js";
import { getOrCreateDispatchControlStore } from "../dist/agent-runtime/dispatch-control-store.js";

const [taskA, taskB, cleanupA, cleanupB] = testUlids("DL", 4);
const canonicalTaskId = "01KG0RR6CA45ZT43W2T6HJMVA1";
const timestamp = "2026-07-15T12:00:00.000Z";

const pendingEntry = {
  cleanup_id: cleanupA,
  scope: "global" as const,
  status: "pending" as const,
  phase: "owned" as const,
};

const failedEntry = {
  cleanup_id: cleanupB,
  scope: "task" as const,
  task_id: taskB,
  status: "failed" as const,
  phase: "signals_sent" as const,
  error_code: "cancellation_failed" as const,
};

const heldTask = {
  task_id: taskA,
  task_ref: "@task-a",
  title: "Task A",
  scope: "global" as const,
  mode: "paused" as const,
  reason: "operator request",
  actor: "api",
  source: "api" as const,
  controlled_at: timestamp,
  updated_at: timestamp,
};

const taskControl = {
  task_id: taskB,
  task_ref: "@task-b",
  title: "Task B",
  mode: "stopped" as const,
  reason: "maintenance",
  actor: "api",
  source: "api" as const,
  controlled_at: timestamp,
  updated_at: timestamp,
  cleanup_state: { status: "failed" as const, entries: [failedEntry] },
};

const tempDirs: string[] = [];

afterEach(async () => {
  await stopAllEngines();
  for (const dir of tempDirs.splice(0)) await cleanupTempDir(dir);
});

async function createLifecycleRouteFixture() {
  const projectDir = await createTempDir("daemon-lifecycle-route-");
  tempDirs.push(projectDir);
  initGitRepo(projectDir);
  writeFileSync(path.join(projectDir, "README.md"), "seed\n");
  execSync("git add README.md && git commit -m seed && git branch kspec-meta", {
    cwd: projectDir,
    stdio: "pipe",
  });
  execSync("git worktree add .kspec kspec-meta", { cwd: projectDir, stdio: "pipe" });
  const specDir = path.join(projectDir, ".kspec");
  rmSync(path.join(specDir, "README.md"));
  const fixtureDir = path.join(process.cwd(), "tests", "e2e", "fixtures");
  for (const file of [
    "kynetic.yaml",
    "project.tasks.yaml",
    "project.inbox.yaml",
    "project.reviews.yaml",
    "project.plans.yaml",
    "project.triage.yaml",
    "kynetic.meta.yaml",
  ]) {
    cpSync(path.join(fixtureDir, file), path.join(specDir, file));
  }
  for (const dir of ["modules", "tasks", "plans", "reviews"]) {
    cpSync(path.join(fixtureDir, dir), path.join(specDir, dir), { recursive: true });
  }
  writeFileSync(
    path.join(specDir, "dispatch-control.yaml"),
    YAML.stringify({
      version: 1,
      revision: 0,
      global: { authority: "stopped" },
      tasks: {},
      pending_cleanup: {},
    }),
  );
  execSync("git add -A && git commit -m 'seed lifecycle fixture'", {
    cwd: specDir,
    stdio: "pipe",
  });
  const testApp = createTestApp();
  const { middleware } = projectContextMiddleware();
  const app = new Elysia()
    .use(middleware)
    .use(createAgentDispatchRoutes({ pubsub: testApp.pubsub }));
  return { projectDir, app, pubsub: testApp.pubsub };
}

function requestLifecycleRoute(
  fixture: Awaited<ReturnType<typeof createLifecycleRouteFixture>>,
  route: string,
  body?: unknown,
) {
  return makeRequest(fixture.app, fixture.projectDir, route, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function captureLifecycleEvents(fixture: Awaited<ReturnType<typeof createLifecycleRouteFixture>>) {
  return captureBroadcasts(fixture.pubsub);
}

function commitLifecycleControl(
  fixture: Awaited<ReturnType<typeof createLifecycleRouteFixture>>,
  control: {
    version: 1;
    revision: number;
    global: Record<string, unknown>;
    tasks: Record<string, unknown>;
    pending_cleanup: Record<string, unknown>;
  },
) {
  const specDir = path.join(fixture.projectDir, ".kspec");
  writeFileSync(path.join(specDir, "dispatch-control.yaml"), YAML.stringify(control));
  execSync("git add dispatch-control.yaml && git commit -m 'set lifecycle state'", {
    cwd: specDir,
    stdio: "pipe",
  });
}

function commitCorruptLifecycleControl(
  fixture: Awaited<ReturnType<typeof createLifecycleRouteFixture>>,
) {
  const specDir = path.join(fixture.projectDir, ".kspec");
  writeFileSync(
    path.join(specDir, "dispatch-control.yaml"),
    YAML.stringify({ version: 99, revision: 1 }),
  );
  execSync("git add dispatch-control.yaml && git commit -m 'commit corrupt lifecycle state'", {
    cwd: specDir,
    stdio: "pipe",
  });
}

function rejectShadowCommits(fixture: Awaited<ReturnType<typeof createLifecycleRouteFixture>>) {
  const hookPath = execSync("git rev-parse --git-path hooks/pre-commit", {
    cwd: path.join(fixture.projectDir, ".kspec"),
  })
    .toString()
    .trim();
  writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
  chmodSync(hookPath, 0o755);
}

function rejectNextShadowCommit(fixture: Awaited<ReturnType<typeof createLifecycleRouteFixture>>) {
  const hookPath = execSync("git rev-parse --git-path hooks/pre-commit", {
    cwd: path.join(fixture.projectDir, ".kspec"),
  })
    .toString()
    .trim();
  writeFileSync(hookPath, '#!/bin/sh\nrm -f -- "$0"\nexit 1\n');
  chmodSync(hookPath, 0o755);
}

function lifecycleControl(
  authority: "stopped" | "running" | "paused" = "stopped",
): Parameters<typeof commitLifecycleControl>[1] {
  return {
    version: 1,
    revision: 1,
    global: { authority },
    tasks: {},
    pending_cleanup: {},
  };
}

describe("dispatch lifecycle public wire schemas", () => {
  // AC: @daemon-agent-dispatch ac-public-status-lifecycle-additions
  it("accepts exact idle, pending, failed, and mixed lifecycle rows", () => {
    expect(DispatchCleanupStateSchema.parse({ status: "idle", entries: [] })).toEqual({
      status: "idle",
      entries: [],
    });
    expect(
      DispatchCleanupStateSchema.parse({ status: "pending", entries: [pendingEntry] }),
    ).toEqual({ status: "pending", entries: [pendingEntry] });
    expect(DispatchCleanupStateSchema.parse({ status: "failed", entries: [failedEntry] })).toEqual({
      status: "failed",
      entries: [failedEntry],
    });
    expect(
      DispatchCleanupStateSchema.parse({
        status: "failed",
        entries: [pendingEntry, failedEntry],
      }),
    ).toEqual({ status: "failed", entries: [pendingEntry, failedEntry] });

    expect(DispatchHeldTaskSchema.parse(heldTask)).toEqual(heldTask);
    expect(DispatchTaskControlStatusSchema.parse(taskControl)).toEqual(taskControl);
    expect(
      DispatchLifecycleStatusSchema.parse({
        global_authority: "paused",
        projection: "draining",
        cleanup_state: { status: "failed", entries: [pendingEntry, failedEntry] },
        active_count: 2,
        queue_depth: 3,
        held_count: 1,
        held_tasks: [heldTask],
        task_controls: [taskControl],
        degraded_targets: [],
      }),
    ).toBeTruthy();
  });

  // AC: @daemon-agent-dispatch ac-public-status-lifecycle-additions
  it.each([
    { status: "pending", entries: [{ ...pendingEntry, error_code: "internal_error" }] },
    { status: "failed", entries: [{ ...failedEntry, error_code: undefined }] },
    { status: "failed", entries: [pendingEntry] },
    { status: "idle", entries: [pendingEntry] },
    { status: "PENDING", entries: [pendingEntry] },
    { status: "pending", entries: [{ ...pendingEntry, unknown: true }] },
    { status: "failed", entries: [failedEntry, { ...failedEntry, cleanup_id: cleanupA }] },
  ])("rejects malformed cleanup state %#", (candidate) => {
    expect(DispatchCleanupStateSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects noncanonical, unsorted, duplicate, and count-mismatched task rows", () => {
    const base = {
      global_authority: "paused",
      projection: "paused",
      cleanup_state: { status: "idle", entries: [] },
      active_count: 0,
      queue_depth: 0,
      held_count: 2,
      held_tasks: [
        { ...heldTask, task_id: taskB },
        { ...heldTask, task_id: taskA },
      ],
      task_controls: [taskControl],
      degraded_targets: [],
    };
    expect(DispatchLifecycleStatusSchema.safeParse(base).success).toBe(false);
    expect(
      DispatchLifecycleStatusSchema.safeParse({
        ...base,
        held_tasks: [heldTask, heldTask],
      }).success,
    ).toBe(false);
    expect(
      DispatchLifecycleStatusSchema.safeParse({
        ...base,
        held_count: 0,
        held_tasks: [heldTask],
      }).success,
    ).toBe(false);
    expect(
      DispatchLifecycleStatusSchema.safeParse({
        ...base,
        held_count: 1,
        held_tasks: [{ ...heldTask, task_id: taskA.toLowerCase() }],
      }).success,
    ).toBe(false);
    expect(
      DispatchTaskControlStatusSchema.safeParse({
        ...taskControl,
        cleanup_state: {
          status: "failed",
          entries: [{ ...failedEntry, task_id: taskA }],
        },
      }).success,
    ).toBe(false);
  });
});

describe("canonical dispatch lifecycle routes", () => {
  // AC: @daemon-agent-dispatch ac-6
  // AC: @trait-api-endpoint ac-1
  it("returns complete canonical success data and appends lifecycle status", async () => {
    const fixture = await createLifecycleRouteFixture();
    const broadcasts = captureLifecycleEvents(fixture);
    const start = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
      reason: "operator request",
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        global_authority: "running",
        projection: "running",
        cleanup_state: { status: "idle", entries: [] },
        active_count: expect.any(Number),
        queue_depth: expect.any(Number),
        held_count: expect.any(Number),
        held_tasks: expect.any(Array),
        task_controls: [],
        degraded_targets: [],
        outcome: "applied",
      }),
      error: null,
    });
    expect(broadcasts).toHaveBeenCalledWith(
      "agents",
      "dispatch_control.start_applied",
      expect.objectContaining({ scope: "global", action: "start", outcome: "applied" }),
      fixture.projectDir,
    );

    const status = await requestLifecycleRoute(fixture, "/api/agent/status");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(
      expect.objectContaining({
        dispatch_enabled: true,
        global_authority: "running",
        projection: "running",
        cleanup_state: { status: "idle", entries: [] },
        held_tasks: expect.any(Array),
        task_controls: [],
      }),
    );
  });

  // AC: @dispatch-lifecycle-control-authority ac-status-reports-authority
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-projection
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-active-count
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-queued-count
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-count
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-identity
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-scope
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-mode
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-reason
  it("reports exact active, queued, and task-held lifecycle state", async () => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const pause = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
      task_ref: "@test-task-ready",
      reason: "operator hold",
    });
    expect(pause.status).toBe(200);
    const pauseBody = await pause.json();
    const engine = getDispatchEngine(fixture.projectDir)!;
    const now = 1_752_600_000_000;
    const internals = engine as unknown as {
      activeCount: Map<string, number>;
      activeInvocationDetails: Map<string, Record<string, unknown>>;
      queues: Map<string, Array<Record<string, unknown>>>;
    };
    internals.activeCount.set("task-worker", 1);
    internals.activeInvocationDetails.set("invocation-active", {
      invocationId: "invocation-active",
      sessionId: "session-active",
      agentId: "task-worker",
      agentName: "Task Worker",
      taskId: canonicalTaskId,
      taskRef: "@test-task-ready",
      role: "worker",
      startedAtMs: now - 1_000,
      resolvedAdapter: "claude-agent-acp",
      runner: undefined,
    });
    internals.queues.set("task-worker", [
      {
        agent: {
          id: "task-worker",
          name: "Task Worker",
          adapter: "claude-agent-acp",
        },
        change: {
          taskId: canonicalTaskId,
          taskRef: "@test-task-ready",
          fromStatus: "pending",
          toStatus: "pending",
          timestamp: now - 500,
        },
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs: now - 500,
        sequence: 1,
        starvationDeferrals: 0,
      },
    ]);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const response = await requestLifecycleRoute(fixture, "/api/agent/status");
    nowSpy.mockRestore();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect({
      dispatch_enabled: body.dispatch_enabled,
      active_invocations: body.active_invocations,
      queued_invocations: body.queued_invocations,
      queue_depth: body.queue_depth,
      global_authority: body.global_authority,
      projection: body.projection,
      cleanup_state: body.cleanup_state,
      held_count: body.held_count,
      held_tasks: body.held_tasks,
      task_controls: body.task_controls,
    }).toEqual({
      dispatch_enabled: true,
      active_invocations: [
        {
          session_id: "session-active",
          agent_id: "task-worker",
          task_ref: "@test-task-ready",
          task_title: "Ready task",
          elapsed_ms: 1_000,
          resolved_adapter: "claude-agent-acp",
        },
      ],
      queued_invocations: [
        {
          agent_id: "task-worker",
          task_ref: "@test-task-ready",
          task_title: "Ready task",
          wait_ms: 500,
          resolved_adapter: "claude-agent-acp",
        },
      ],
      queue_depth: 1,
      global_authority: "running",
      projection: "running",
      cleanup_state: { status: "idle", entries: [] },
      held_count: 1,
      held_tasks: [
        {
          task_id: canonicalTaskId,
          task_ref: "@test-task-ready",
          title: "Ready task",
          scope: "task",
          mode: "paused",
          reason: "operator hold",
          actor: "api",
          source: "api",
          controlled_at: pauseBody.data.task_controls[0].controlled_at,
          updated_at: pauseBody.data.task_controls[0].updated_at,
        },
      ],
      task_controls: pauseBody.data.task_controls,
    });
  });

  // AC: @trait-api-endpoint ac-2
  it("rejects missing and ambiguous task identities without mutation or alias exposure", async () => {
    const fixture = await createLifecycleRouteFixture();
    const missingTaskId = "01KG0RR6CA45ZT43W2T6HJMVB9";
    const missing = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
      task_id: missingTaskId,
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    expect(missingBody).toEqual({
      ok: false,
      data: expect.objectContaining({ task_controls: [], held_tasks: [] }),
      error: {
        code: "task_not_found",
        message: "Task not found",
        suggestion: "Use an existing canonical task identifier or resolvable task reference.",
      },
    });
    expect(JSON.stringify(missingBody)).not.toContain(missingTaskId);
    expect(getDispatchEngine(fixture.projectDir)).toBeUndefined();

    const ambiguous = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
      task_ref: "@01KG0RR",
    });
    expect(ambiguous.status).toBe(409);
    const ambiguousBody = await ambiguous.json();
    expect(ambiguousBody).toEqual({
      ok: false,
      data: expect.objectContaining({ task_controls: [], held_tasks: [] }),
      error: {
        code: "task_identity_ambiguous",
        message: "Task identity is ambiguous",
        suggestion: "Retry with the canonical task identifier.",
      },
    });
    expect(JSON.stringify(ambiguousBody)).not.toContain("@01KG0RR");
    expect(getDispatchEngine(fixture.projectDir)).toBeUndefined();
  });

  // AC: @trait-api-endpoint ac-5
  // AC: @trait-api-endpoint ac-6
  it("commits task controls semantically and traces canonical success and failure", async () => {
    const fixture = await createLifecycleRouteFixture();
    const success = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
      task_ref: "@test-task-ready",
    });
    expect(success.status).toBe(200);
    expect(success.headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(
      execSync("git log -1 --pretty=%s", { cwd: path.join(fixture.projectDir, ".kspec") })
        .toString()
        .trim(),
    ).toBe(`dispatch-task-pause-${canonicalTaskId}`);

    const failure = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
      task_id: "01KG0RR6CA45ZT43W2T6HJMVB9",
    });
    expect(failure.status).toBe(404);
    expect(failure.headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  // AC: @daemon-agent-dispatch ac-control-missing-identity
  // AC: @daemon-agent-dispatch ac-control-error-current-status
  // AC: @dispatch-lifecycle-control-authority ac-failure-api-uses-closed-error-codes
  // AC: @dispatch-lifecycle-control-authority ac-api-failures-do-not-expose-raw-errors
  // AC: @trait-api-endpoint ac-3
  it("returns closed validation failure with complete current status", async () => {
    const fixture = await createLifecycleRouteFixture();
    const response = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      data: expect.objectContaining({
        global_authority: "stopped",
        cleanup_state: { status: "idle", entries: [] },
      }),
      error: {
        code: "validation_failed",
        message: "Invalid lifecycle control request",
        suggestion: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain(fixture.projectDir);
  });

  // AC: @daemon-agent-dispatch ac-control-ref-canonicalization
  // AC: @daemon-agent-dispatch ac-control-identity-mismatch
  it("canonicalizes task aliases and rejects disagreeing identity fields without mutation", async () => {
    const fixture = await createLifecycleRouteFixture();
    const pause = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
      task_ref: "@test-task-ready",
    });
    expect(pause.status).toBe(200);
    expect(await pause.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        task_id: canonicalTaskId,
        task_ref: "@test-task-ready",
        outcome: "applied",
        task_controls: [expect.objectContaining({ task_id: canonicalTaskId, mode: "paused" })],
      }),
      error: null,
    });

    const mismatch = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "resume",
      task_id: taskB,
      task_ref: "@test-task-ready",
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      ok: false,
      data: expect.objectContaining({
        task_controls: [expect.objectContaining({ task_id: canonicalTaskId, mode: "paused" })],
      }),
      error: {
        code: "task_identity_mismatch",
        message: "Task identity fields do not agree",
        suggestion: expect.any(String),
      },
    });
  });

  // AC: @daemon-agent-dispatch ac-control-failure-no-success
  it("does not report success when lifecycle persistence fails", async () => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const engine = getDispatchEngine(fixture.projectDir)!;
    vi.spyOn(engine, "applyGlobalLifecycleAction").mockRejectedValueOnce(
      new DispatchShadowTransactionError(
        "control_commit_failed",
        `raw commit failure in ${fixture.projectDir}`,
      ),
    );

    const response = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "pause",
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      data: expect.objectContaining({ global_authority: "running" }),
      error: {
        code: "control_commit_failed",
        message: "Dispatch control commit failed",
        suggestion: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain(fixture.projectDir);
  });

  // AC: @daemon-agent-dispatch ac-cleanup-failure-no-success
  it.each([
    ["cancellation_timeout", 500],
    ["cancellation_failed", 500],
    ["session_closure_failed", 500],
    ["cleanup_ownership_mismatch", 409],
    ["cleanup_process_birth_mismatch", 409],
    ["cleanup_leader_missing_group_alive", 409],
    ["cleanup_identity_unverifiable", 503],
    ["cleanup_group_unverifiable", 503],
    ["internal_error", 500],
  ] as const)("does not report success for cleanup failure %s", async (code, status) => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const engine = getDispatchEngine(fixture.projectDir)!;
    vi.spyOn(engine, "applyGlobalLifecycleAction").mockRejectedValueOnce(
      new DispatchCleanupError(code, `raw cleanup failure in ${fixture.projectDir}`),
    );

    const response = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "stop",
    });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({
      ok: false,
      data: expect.objectContaining({ global_authority: "running" }),
      error: {
        code,
        message: expect.any(String),
        suggestion: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain(fixture.projectDir);
  });

  it("rejects invalid stopped transitions without creating runtime state", async () => {
    const fixture = await createLifecycleRouteFixture();
    const response = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "pause",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false,
      data: expect.objectContaining({
        global_authority: "stopped",
        active_count: 0,
        queue_depth: 0,
        held_count: 0,
      }),
      error: {
        code: "invalid_transition",
        message: "Invalid dispatch lifecycle transition",
        suggestion: expect.any(String),
      },
    });
    expect(getDispatchEngine(fixture.projectDir)).toBeUndefined();
  });

  it("gates only matching cleanup scope before engine startup", async () => {
    const taskCleanupFixture = await createLifecycleRouteFixture();
    const taskCleanup = lifecycleControl();
    taskCleanup.pending_cleanup[canonicalTaskId] = {
      cleanup_id: cleanupA,
      status: "pending",
      phase: "owned",
      targets: [],
    };
    commitLifecycleControl(taskCleanupFixture, taskCleanup);

    const globalStart = await requestLifecycleRoute(
      taskCleanupFixture,
      "/api/agent/dispatch/control",
      { scope: "global", action: "start" },
    );
    expect(globalStart.status).toBe(200);
    expect(await globalStart.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        global_authority: "running",
        cleanup_state: expect.objectContaining({ status: "pending" }),
        outcome: "applied",
      }),
      error: null,
    });

    const globalCleanupFixture = await createLifecycleRouteFixture();
    const globalCleanup = lifecycleControl();
    globalCleanup.pending_cleanup.global = {
      cleanup_id: cleanupB,
      status: "pending",
      phase: "owned",
      targets: [],
    };
    commitLifecycleControl(globalCleanupFixture, globalCleanup);
    const taskPause = await requestLifecycleRoute(
      globalCleanupFixture,
      "/api/agent/dispatch/control",
      { scope: "task", action: "pause", task_ref: "@test-task-ready" },
    );
    expect(taskPause.status).toBe(200);
    expect(await taskPause.json()).toEqual({
      ok: true,
      data: expect.objectContaining({ task_id: canonicalTaskId, outcome: "applied" }),
      error: null,
    });

    const matchingTaskFixture = await createLifecycleRouteFixture();
    const matchingTaskCleanup = lifecycleControl();
    matchingTaskCleanup.tasks[canonicalTaskId] = {
      mode: "stopped",
      reason: "maintenance",
      actor: "api",
      source: "api",
      controlled_at: timestamp,
      updated_at: timestamp,
    };
    matchingTaskCleanup.pending_cleanup[canonicalTaskId] = {
      cleanup_id: cleanupA,
      status: "failed",
      phase: "owned",
      error_code: "cancellation_failed",
      targets: [],
    };
    commitLifecycleControl(matchingTaskFixture, matchingTaskCleanup);
    const taskResume = await requestLifecycleRoute(
      matchingTaskFixture,
      "/api/agent/dispatch/control",
      { scope: "task", action: "resume", task_ref: "@test-task-ready" },
    );
    expect(taskResume.status).toBe(409);
    expect(getDispatchEngine(matchingTaskFixture.projectDir)).toBeUndefined();
  });

  it.each([
    ["absent", "pause"],
    ["absent", "resume"],
    ["paused", "pause"],
    ["paused", "resume"],
  ] as const)(
    "rejects task %s control row %s while matching cleanup is pending",
    async (controlState, action) => {
      const fixture = await createLifecycleRouteFixture();
      const control = lifecycleControl();
      if (controlState === "paused") {
        control.tasks[canonicalTaskId] = {
          mode: "paused",
          reason: "maintenance",
          actor: "api",
          source: "api",
          controlled_at: timestamp,
          updated_at: timestamp,
        };
      }
      control.pending_cleanup[canonicalTaskId] = {
        cleanup_id: cleanupA,
        status: "pending",
        phase: "owned",
        targets: [],
      };
      commitLifecycleControl(fixture, control);

      const response = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
        scope: "task",
        action,
        task_ref: "@test-task-ready",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        data: {
          global_authority: "stopped",
          projection: "stopped",
          cleanup_state: {
            status: "pending",
            entries: [
              {
                cleanup_id: cleanupA,
                scope: "task",
                task_id: canonicalTaskId,
                status: "pending",
                phase: "owned",
              },
            ],
          },
          active_count: 0,
          queue_depth: 0,
          held_count: 0,
          held_tasks: [],
          task_controls:
            controlState === "paused"
              ? [
                  {
                    task_id: canonicalTaskId,
                    task_ref: "@test-task-ready",
                    title: "Ready task",
                    mode: "paused",
                    reason: "maintenance",
                    actor: "api",
                    source: "api",
                    controlled_at: timestamp,
                    updated_at: timestamp,
                    cleanup_state: {
                      status: "pending",
                      entries: [
                        {
                          cleanup_id: cleanupA,
                          scope: "task",
                          task_id: canonicalTaskId,
                          status: "pending",
                          phase: "owned",
                        },
                      ],
                    },
                  },
                ]
              : [],
          degraded_targets: [],
        },
        error: {
          code: "invalid_transition",
          message: "Invalid dispatch lifecycle transition",
          suggestion: "Refresh lifecycle status and choose an allowed action.",
        },
      });
      expect(getDispatchEngine(fixture.projectDir)).toBeUndefined();
    },
  );

  // AC: @daemon-agent-dispatch ac-control-failure-no-success
  // AC: @daemon-agent-dispatch ac-control-error-current-status
  it("reports corrupt committed lifecycle state consistently on canonical surfaces", async () => {
    const fixture = await createLifecycleRouteFixture();
    commitCorruptLifecycleControl(fixture);
    const lifecycle = {
      global_authority: "stopped",
      projection: "stopped",
      cleanup_state: { status: "idle", entries: [] },
      active_count: 0,
      queue_depth: 0,
      held_count: 0,
      held_tasks: [],
      task_controls: [],
      degraded_targets: [],
    };

    const control = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    expect(control.status).toBe(503);
    expect(await control.json()).toEqual({
      ok: false,
      data: lifecycle,
      error: {
        code: "control_store_corrupt",
        message: "Dispatch control store is corrupt",
        suggestion: "Repair the committed dispatch control data and retry.",
      },
    });

    const publicStatus = await requestLifecycleRoute(fixture, "/api/agent/status");
    expect(publicStatus.status).toBe(503);
    expect(await publicStatus.json()).toEqual({
      ok: false,
      data: lifecycle,
      error: {
        code: "control_store_corrupt",
        message: "Dispatch control store is corrupt",
        suggestion: "Repair the committed dispatch control data and retry.",
      },
    });

    const internalStatus = await requestLifecycleRoute(fixture, "/api/agent/dispatch/status");
    expect(internalStatus.status).toBe(503);
    expect(await internalStatus.json()).toEqual({
      running: false,
      activeInvocations: 0,
      queuedInvocations: 0,
      invocations: [],
      degraded: { active: false, reason: "", enteredAt: null },
      degradedTargets: [],
      globalAuthority: "stopped",
      projection: "stopped",
      cleanupState: { status: "idle", entries: [] },
      heldCount: 0,
      heldTasks: [],
      taskControls: [],
      error_code: "control_store_corrupt",
    });
  });

  it("retains corrupt-store classification when an engine already exists", async () => {
    const fixture = await createLifecycleRouteFixture();
    const start = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    expect(start.status).toBe(200);

    commitCorruptLifecycleControl(fixture);
    const store = getOrCreateDispatchControlStore(fixture.projectDir);
    await store.observeWorktreeEvent();
    expect(store.getDegradedKind()).toBe("corrupt");

    const control = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "pause",
    });
    expect(control.status).toBe(503);
    expect(await control.json()).toEqual({
      ok: false,
      data: expect.objectContaining({ global_authority: "running" }),
      error: {
        code: "control_store_corrupt",
        message: "Dispatch control store is corrupt",
        suggestion: "Repair the committed dispatch control data and retry.",
      },
    });

    const internalStatus = await requestLifecycleRoute(fixture, "/api/agent/dispatch/status");
    expect(internalStatus.status).toBe(503);
    expect(await internalStatus.json()).toEqual(
      expect.objectContaining({
        running: true,
        globalAuthority: "running",
        error_code: "control_store_corrupt",
      }),
    );
  });

  it.each(["/api/agent/status", "/api/agent/dispatch/status"])(
    "preserves unavailable-store classification on %s",
    async (route) => {
      const fixture = await createLifecycleRouteFixture();
      const store = getOrCreateDispatchControlStore(fixture.projectDir);
      await store.loadCommitted();
      vi.spyOn(store, "getDegradedReason").mockReturnValue("control store unavailable");
      vi.spyOn(store, "getDegradedKind").mockReturnValue("unavailable");

      const response = await requestLifecycleRoute(fixture, route);
      expect(response.status).toBe(503);
      const body = await response.json();
      if (route.endsWith("/dispatch/status")) {
        expect(body).toEqual({
          running: false,
          activeInvocations: 0,
          queuedInvocations: 0,
          invocations: [],
          degraded: { active: false, reason: "", enteredAt: null },
          degradedTargets: [],
          globalAuthority: "stopped",
          projection: "stopped",
          cleanupState: { status: "idle", entries: [] },
          heldCount: 0,
          heldTasks: [],
          taskControls: [],
          error_code: "control_store_unavailable",
        });
      } else {
        expect(body).toEqual({
          ok: false,
          data: {
            global_authority: "stopped",
            projection: "stopped",
            cleanup_state: { status: "idle", entries: [] },
            active_count: 0,
            queue_depth: 0,
            held_count: 0,
            held_tasks: [],
            task_controls: [],
            degraded_targets: [],
          },
          error: {
            code: "control_store_unavailable",
            message: "Dispatch control store is unavailable",
            suggestion: "Restore the project shadow worktree and retry.",
          },
        });
      }
    },
  );

  it("preserves native Elysia invalid-body validation", async () => {
    const fixture = await createLifecycleRouteFixture();
    const response = await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "restart",
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await response.json()).toEqual({
      error: "validation_error",
      details: [
        {
          field: "action",
          message: expect.any(String),
        },
      ],
    });
  });
});

describe("legacy lifecycle compatibility adapters", () => {
  // AC: @daemon-agent-dispatch ac-control-failure-no-success
  it("settles cold startup failure before a concurrent canonical control retries", async () => {
    const fixture = await createLifecycleRouteFixture();
    let startEntered!: () => void;
    let rejectStart!: (reason: unknown) => void;
    const startupEntered = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    const startupGate = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    vi.spyOn(DispatchEngine.prototype, "start").mockImplementationOnce(async () => {
      startEntered();
      await startupGate;
    });

    const firstRequest = requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    await startupEntered;
    const secondRequest = requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectStart(new Error("injected startup failure"));

    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
    expect(firstResponse.status).toBe(500);
    expect(await firstResponse.json()).toEqual({
      ok: false,
      data: expect.objectContaining({
        global_authority: "stopped",
        projection: "stopped",
      }),
      error: {
        code: "internal_error",
        message: "Dispatch lifecycle operation failed",
        suggestion: "Retry after checking daemon health.",
      },
    });
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toEqual({
      ok: true,
      data: expect.objectContaining({
        global_authority: "running",
        projection: "running",
        outcome: "applied",
      }),
      error: null,
    });
    expect(getDispatchEngine(fixture.projectDir)).toBeDefined();
    expect(
      (await getOrCreateDispatchControlStore(fixture.projectDir).loadCommitted()).snapshot.global
        .authority,
    ).toBe("running");
  });

  // AC: @daemon-agent-dispatch ac-control-failure-no-success
  it.each([
    ["canonical control", "/api/agent/dispatch/control", { scope: "global", action: "start" }],
    ["unified alias", "/api/agent/dispatch", { action: "start" }],
    ["start alias", "/api/agent/dispatch/start", {}],
  ])(
    "settles cold-start rollback before a concurrent %s request proceeds",
    async (_name, route, body) => {
      const fixture = await createLifecycleRouteFixture();
      rejectNextShadowCommit(fixture);

      let startEntered!: () => void;
      let releaseStart!: () => void;
      const startupEntered = new Promise<void>((resolve) => {
        startEntered = resolve;
      });
      const startupGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      const originalStart = DispatchEngine.prototype.start;
      vi.spyOn(DispatchEngine.prototype, "start").mockImplementationOnce(async function () {
        startEntered();
        await startupGate;
        return originalStart.call(this);
      });

      const firstRequest = requestLifecycleRoute(fixture, route, body);
      await startupEntered;
      const secondRequest = requestLifecycleRoute(fixture, route, body);
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseStart();

      const responses = await Promise.all([firstRequest, secondRequest]);
      const expectedCodes = ["control_commit_failed", "control_store_unavailable"];
      for (const [index, response] of responses.entries()) {
        expect(response.status).toBe(503);
        const responseBody = await response.json();
        if (route.endsWith("/control")) {
          expect(responseBody).toEqual({
            ok: false,
            data: expect.objectContaining({
              global_authority: "stopped",
              projection: "stopped",
            }),
            error: expect.objectContaining({
              code: expectedCodes[index],
            }),
          });
        } else if (route.endsWith("/start")) {
          expect(responseBody).toEqual({
            started: false,
            error_code: expectedCodes[index],
          });
        } else {
          expect(responseBody).toEqual({
            dispatch_enabled: false,
            error_code: expectedCodes[index],
          });
        }
      }
      expect(getDispatchEngine(fixture.projectDir)).toBeUndefined();
      expect(
        (await getOrCreateDispatchControlStore(fixture.projectDir).loadCommitted()).snapshot.global
          .authority,
      ).toBe("stopped");
    },
  );

  // AC: @daemon-agent-dispatch ac-control-failure-no-success
  it.each([
    ["canonical control", "/api/agent/dispatch/control", { scope: "global", action: "start" }],
    ["unified alias", "/api/agent/dispatch", { action: "start" }],
    ["start alias", "/api/agent/dispatch/start", {}],
  ])("removes a cold engine after %s persistence failure", async (_name, route, body) => {
    const fixture = await createLifecycleRouteFixture();
    rejectShadowCommits(fixture);

    const response = await requestLifecycleRoute(fixture, route, body);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      route.endsWith("/control")
        ? {
            ok: false,
            data: expect.objectContaining({
              global_authority: "stopped",
              projection: "stopped",
            }),
            error: {
              code: "control_commit_failed",
              message: "Dispatch control commit failed",
              suggestion: "Resolve the shadow worktree commit failure and retry.",
            },
          }
        : route.endsWith("/start")
          ? { started: false, error_code: "control_commit_failed" }
          : { dispatch_enabled: false, error_code: "control_commit_failed" },
    );
    expect(getDispatchEngine(fixture.projectDir)).toBeUndefined();
  });

  it.each([
    ["/api/agent/dispatch/stop", undefined],
    ["/api/agent/dispatch", { action: "stop" }],
  ])("emits one lifecycle outcome for a successful %s request", async (route, body) => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const broadcasts = captureLifecycleEvents(fixture);
    broadcasts.mockClear();

    const response = await requestLifecycleRoute(fixture, route, body ?? {});
    expect(response.status).toBe(200);
    const lifecycleCalls = broadcasts.mock.calls.filter(
      ([topic, event]) => topic === "agents" && String(event).startsWith("dispatch_control."),
    );
    expect(lifecycleCalls).toEqual([
      [
        "agents",
        "dispatch_control.stop_applied",
        expect.objectContaining({
          scope: "global",
          action: "stop",
          outcome: "applied",
          source: "api",
        }),
        fixture.projectDir,
      ],
    ]);
  });

  it.each([
    ["/api/agent/dispatch/stop", undefined],
    ["/api/agent/dispatch", { action: "stop" }],
  ])("retries cleanup after a failed %s request", async (route, body) => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const engine = getDispatchEngine(fixture.projectDir)!;
    const original = engine.applyGlobalLifecycleAction.bind(engine);
    const lifecycle = vi
      .spyOn(engine, "applyGlobalLifecycleAction")
      .mockRejectedValueOnce(new DispatchCleanupError("cancellation_failed", "injected"))
      .mockImplementation(original);

    const first = await requestLifecycleRoute(fixture, route, body ?? {});
    expect(first.status).toBe(500);
    expect(await first.json()).toEqual(
      route.endsWith("/stop")
        ? { stopped: false, reason: "cleanup_pending", error_code: "cancellation_failed" }
        : {
            dispatch_enabled: false,
            reason: "cleanup_pending",
            error_code: "cancellation_failed",
          },
    );
    expect(getDispatchEngine(fixture.projectDir)).toBe(engine);

    const second = await requestLifecycleRoute(fixture, route, body ?? {});
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(
      route.endsWith("/stop") ? { stopped: true } : { dispatch_enabled: false },
    );
    expect(lifecycle).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "/api/agent/dispatch/stop",
      undefined,
      { stopped: false, error_code: "control_commit_failed" },
    ],
    [
      "/api/agent/dispatch",
      { action: "stop" },
      { dispatch_enabled: true, error_code: "control_commit_failed" },
    ],
  ])("omits cleanup_pending for pre-commit failure on %s", async (route, body, expected) => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const engine = getDispatchEngine(fixture.projectDir)!;
    vi.spyOn(engine, "applyGlobalLifecycleAction").mockRejectedValueOnce(
      new DispatchShadowTransactionError("control_commit_failed", "injected"),
    );

    const response = await requestLifecycleRoute(fixture, route, body ?? {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(expected);
  });

  it.each([
    ["/api/agent/dispatch/stop", undefined, { stopped: false, error_code: "internal_error" }],
    [
      "/api/agent/dispatch",
      { action: "stop" },
      { dispatch_enabled: true, error_code: "internal_error" },
    ],
  ])("omits cleanup_pending for uncategorized failure on %s", async (route, body, expected) => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const engine = getDispatchEngine(fixture.projectDir)!;
    vi.spyOn(engine, "applyGlobalLifecycleAction").mockRejectedValueOnce(
      new Error(`raw failure in ${fixture.projectDir}`),
    );

    const response = await requestLifecycleRoute(fixture, route, body ?? {});
    expect(response.status).toBe(500);
    const responseBody = await response.json();
    expect(responseBody).toEqual(expected);
    expect(JSON.stringify(responseBody)).not.toContain(fixture.projectDir);
  });

  it.each([
    [
      "/api/agent/dispatch/stop",
      undefined,
      { stopped: false, reason: "invalid_transition", error_code: "invalid_transition" },
    ],
    [
      "/api/agent/dispatch",
      { action: "stop" },
      {
        dispatch_enabled: true,
        error: "Invalid dispatch lifecycle transition",
        error_code: "invalid_transition",
      },
    ],
  ])("preserves the exact invalid-transition row on %s", async (route, body, expected) => {
    const fixture = await createLifecycleRouteFixture();
    await requestLifecycleRoute(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    const engine = getDispatchEngine(fixture.projectDir)!;
    vi.spyOn(engine, "applyGlobalLifecycleAction").mockRejectedValueOnce(
      new DispatchLifecycleTransitionError("injected"),
    );

    const response = await requestLifecycleRoute(fixture, route, body ?? {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(expected);
  });

  it("rejects paused legacy start without creating an engine", async () => {
    const fixture = await createLifecycleRouteFixture();
    commitLifecycleControl(fixture, lifecycleControl("paused"));
    const response = await requestLifecycleRoute(fixture, "/api/agent/dispatch/start", {});
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      started: false,
      error: "Invalid dispatch lifecycle transition",
      status: expect.objectContaining({
        running: false,
        globalAuthority: "paused",
      }),
      error_code: "invalid_transition",
    });
    expect(getDispatchEngine(fixture.projectDir)).toBeUndefined();
  });
});
