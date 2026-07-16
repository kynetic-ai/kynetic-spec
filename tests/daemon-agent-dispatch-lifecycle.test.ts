import { execSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Elysia } from "elysia";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  DispatchCleanupStateSchema,
  DispatchHeldTaskSchema,
  DispatchLifecycleStatusSchema,
  DispatchTaskControlStatusSchema,
} from "../packages/shared/src/api.ts";
import { cleanupTempDir, createTempDir, initGitRepo, testUlids } from "./helpers/cli.ts";
import { captureBroadcasts, createTestApp, makeRequest } from "./daemon-api/helpers.ts";
import { createAgentDispatchRoutes, stopAllEngines } from "../dist/daemon/routes/agent-dispatch.js";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";

const [taskA, taskB, cleanupA, cleanupB] = testUlids("DL", 4);
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

describe("dispatch lifecycle public wire schemas", () => {
  // AC: @daemon-agent-dispatch ac-public-status-lifecycle-additions
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-authority
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-projection
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-active-count
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-queued-count
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-count
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

  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-identity
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-scope
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-mode
  // AC: @dispatch-lifecycle-control-authority ac-status-reports-held-task-reason
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
        held_count: 1,
        held_tasks: [{ ...heldTask, task_id: taskA.toLowerCase() }],
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
    const canonicalTaskId = "01KG0RR6CA45ZT43W2T6HJMVA1";
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
});
