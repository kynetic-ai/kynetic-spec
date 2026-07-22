import { cpSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import WsClient from "ws";
import YAML from "yaml";

vi.mock("../packages/web-ui/src/lib/stores/mode.svelte", () => ({
  isStaticMode: () => false,
  assertWritable: () => undefined,
}));
vi.mock("../packages/web-ui/src/lib/stores/project.svelte", () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => undefined,
  isInvalidProjectError: () => false,
}));
vi.mock("../packages/web-ui/src/lib/api-static", () => ({}));
vi.mock("../packages/web-ui/src/lib/constants", () => ({
  DAEMON_API_BASE: "http://localhost:3456",
}));

import {
  DispatchControlErrorCodeSchema,
  DispatchLifecycleStatusSchema,
  type DispatchLifecycleControlErrorCode,
} from "../packages/shared/src/api.js";
import { parseAgentDispatchStatusWire } from "../packages/web-ui/src/lib/api.js";
import { boundedDaemonFetch } from "./helpers/daemon-fetch.js";
import {
  createTestDaemonProject,
  startTestDaemon,
  type StartedTestDaemon,
  type TestDaemonProject,
} from "./helpers/daemon.js";
import { kspec, type KspecResult } from "./helpers/cli.js";

const TASK_ID = "01KG0RR6CA45ZT43W2T6HJMVA1";
const TASK_REF = "@test-task-ready";
const GLOBAL_CLEANUP_ID = "01KXH2PXT88X9MSC62MQVY2CW1";
const TASK_CLEANUP_ID = "01KXH2PXT88X9MSC62MQVY2CW2";
const NOW = "2026-07-16T12:00:00.000Z";

interface SurfaceDaemonFixture {
  project: TestDaemonProject;
  daemon: StartedTestDaemon;
  taskId: string;
  taskRef: string;
}

interface SurfaceEvent {
  msg_id: string;
  seq: number;
  timestamp: string;
  topic: "agents";
  event: string;
  data: Record<string, unknown>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve request-surface test server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function requestFixture(
  apiUrl: string,
  daemon: {
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
    stdout?: string;
    stderr?: string;
  } = {},
): SurfaceDaemonFixture {
  return {
    project: { tempDir: "request-surface-fixture" },
    daemon: {
      apiUrl,
      child: {
        exitCode: daemon.exitCode ?? null,
        signalCode: daemon.signalCode ?? null,
      },
      stdoutTail: () => daemon.stdout ?? "",
      stderrTail: () => daemon.stderr ?? "",
    },
  } as SurfaceDaemonFixture;
}

async function createSurfaceDaemonFixture(): Promise<SurfaceDaemonFixture> {
  const project = await createTestDaemonProject({ skipFixtures: true });
  onTestFinished(() => project.cleanup());
  rmSync(project.kspecDir, { recursive: true, force: true });
  rmSync(join(project.tempDir, ".git", "worktrees"), { recursive: true, force: true });
  writeFileSync(join(project.tempDir, "README.md"), "surface fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: project.tempDir });
  execFileSync("git", ["commit", "-m", "seed surface fixture"], { cwd: project.tempDir });
  execFileSync("git", ["branch", "kspec-meta"], { cwd: project.tempDir });
  execFileSync("git", ["worktree", "add", ".kspec", "kspec-meta"], {
    cwd: project.tempDir,
  });
  rmSync(join(project.kspecDir, "README.md"));
  cpSync(join(process.cwd(), "tests", "e2e", "fixtures"), project.kspecDir, {
    recursive: true,
    filter: (source) => !source.includes("test-base") && !source.includes("project-tests"),
  });
  writeFileSync(
    join(project.kspecDir, "dispatch-control.yaml"),
    "version: 1\nrevision: 0\nglobal:\n  authority: stopped\ntasks: {}\npending_cleanup: {}\n",
  );
  execFileSync("git", ["add", "-A"], { cwd: project.kspecDir });
  execFileSync("git", ["commit", "-m", "seed lifecycle surface state"], {
    cwd: project.kspecDir,
  });
  const daemon = await startTestDaemon(project, {
    registerCleanup: (stop) => onTestFinished(stop),
  });
  return { project, daemon, taskId: TASK_ID, taskRef: TASK_REF };
}

async function requestSurface(
  fixture: SurfaceDaemonFixture,
  route: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  try {
    return await boundedDaemonFetch(`${fixture.daemon.apiUrl}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        // This fixture alternates API calls with long synchronous CLI gaps.
        // Do not leave an Undici-pooled socket idle past the daemon's keep-alive timeout.
        Connection: "close",
        "X-Kspec-Dir": fixture.project.tempDir,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { child } = fixture.daemon;
    const exitCode =
      child.exitCode === null
        ? child.signalCode === null
          ? "<running>"
          : "<none>"
        : String(child.exitCode);
    throw new Error(
      `Dispatch lifecycle API fetch ${route} failed: ${message}\n` +
        `exitCode=${exitCode} ` +
        `signal=${child.signalCode ?? "<none>"}\n` +
        // StartedTestDaemon owns capped (~8KB) stream-tail buffers.
        `stdout-tail:\n${fixture.daemon.stdoutTail() || "<empty>"}\n` +
        `stderr-tail:\n${fixture.daemon.stderrTail() || "<empty>"}`,
      { cause: error },
    );
  }
}

describe("dispatch lifecycle request harness", () => {
  it("closes each HTTP connection instead of pooling it across synchronous CLI gaps", async () => {
    let connectionHeader: string | undefined;
    const server = createServer((request, response) => {
      connectionHeader = request.headers.connection;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
    onTestFinished(() => closeServer(server));
    const apiUrl = await listenOnLoopback(server);

    const response = await requestSurface(requestFixture(apiUrl), "/surface-probe");
    await response.text();

    expect(connectionHeader).toBe("close");
  });

  it("reports owned daemon exit state and output tails when a fetch fails", async () => {
    const server = createServer((request) => request.socket.destroy());
    onTestFinished(() => closeServer(server));
    const apiUrl = await listenOnLoopback(server);
    const fixture = requestFixture(apiUrl, {
      exitCode: null,
      signalCode: "SIGKILL",
      stdout: "daemon stdout marker",
      stderr: "daemon stderr marker",
    });

    await expect(requestSurface(fixture, "/closed-socket")).rejects.toThrow(
      /exitCode=<none> signal=SIGKILL[\s\S]*stdout-tail:[\s\S]*daemon stdout marker[\s\S]*stderr-tail:[\s\S]*daemon stderr marker/,
    );
  });
});

function runSurfaceCli(
  fixture: SurfaceDaemonFixture,
  command: string,
  expectFail = false,
): KspecResult {
  return kspec(command, fixture.project.tempDir, {
    expectFail,
    env: {
      ...fixture.project.isolatedHome.env,
      KSPEC_NO_DAEMON: "",
    },
  });
}

async function captureSurfaceEvents(fixture: SurfaceDaemonFixture): Promise<{
  events: SurfaceEvent[];
  close: () => Promise<void>;
}> {
  const events: SurfaceEvent[] = [];
  const socket = new WsClient(`${fixture.daemon.wsUrl}?project=${fixture.project.tempDir}`);
  const subscribed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("surface event subscription timed out")),
      5_000,
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.ack === true && message.request_id === "surface-lifecycle") {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (message.topic === "agents" && typeof message.event === "string") {
        events.push(message as unknown as SurfaceEvent);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          action: "subscribe",
          request_id: "surface-lifecycle",
          payload: { topics: ["agents"] },
        }),
      );
    });
  });
  await subscribed;
  return {
    events,
    close: () =>
      new Promise((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1000, "surface integration complete");
      }),
  };
}

function injectLifecycleFailure(
  fixture: SurfaceDaemonFixture,
  code: DispatchLifecycleControlErrorCode | "pending" | "failed_cleanup",
  options: { revision?: number; taskStatus?: "pending" | "failed" } = {},
): void {
  if (code === "pending" || code === "failed_cleanup") {
    const taskStatus = options.taskStatus;
    const pendingCleanup: Record<string, unknown> = {
      global: {
        cleanup_id: GLOBAL_CLEANUP_ID,
        status: code === "pending" ? "pending" : "failed",
        phase: code === "pending" ? "owned" : "signals_sent",
        ...(code === "pending" ? {} : { error_code: "cancellation_failed" }),
        targets: [],
      },
    };
    if (taskStatus) {
      pendingCleanup[fixture.taskId] = {
        cleanup_id: TASK_CLEANUP_ID,
        status: taskStatus,
        phase: taskStatus === "pending" ? "owned" : "signals_sent",
        ...(taskStatus === "pending" ? {} : { error_code: "cancellation_failed" }),
        targets: [],
      };
    }
    writeFileSync(
      join(fixture.project.kspecDir, "dispatch-control.yaml"),
      YAML.stringify({
        version: 1,
        revision: options.revision ?? 1,
        global: { authority: "stopped" },
        tasks: taskStatus
          ? {
              [fixture.taskId]: {
                mode: "stopped",
                reason: "surface cleanup",
                actor: "api",
                source: "api",
                controlled_at: NOW,
                updated_at: NOW,
              },
            }
          : {},
        pending_cleanup: pendingCleanup,
      }),
    );
    execFileSync("git", ["add", "dispatch-control.yaml"], { cwd: fixture.project.kspecDir });
    execFileSync("git", ["commit", "-m", `inject lifecycle ${code}`], {
      cwd: fixture.project.kspecDir,
    });
    return;
  }
  writeFileSync(join(fixture.project.kspecDir, ".test-lifecycle-failure"), `${code}\n`);
}

describe("dispatch lifecycle API/CLI surface projection", { timeout: 90_000 }, () => {
  // AC: @daemon-agent-dispatch ac-6
  // AC: @daemon-agent-dispatch ac-public-status-lifecycle-additions
  // AC: @daemon-agent-dispatch ac-control-ref-canonicalization
  // AC: @daemon-agent-dispatch ac-control-error-current-status
  // AC: @daemon-agent-dispatch ac-control-failure-no-success
  // AC: @trait-api-endpoint ac-1
  // AC: @trait-api-endpoint ac-3
  // AC: @trait-api-endpoint ac-6
  it("preserves exact responses, exits, canonical identity, and matching events", async () => {
    const fixture = await createSurfaceDaemonFixture();
    const capture = await captureSurfaceEvents(fixture);
    onTestFinished(capture.close);

    const invalidBody = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "restart",
    });
    expect(invalidBody.status, "invalid action API validation status").toBe(400);
    expect(await invalidBody.json(), "invalid action API validation details").toEqual({
      error: "validation_error",
      details: [
        {
          field: "action",
          message: expect.any(String),
        },
      ],
    });

    const start = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
      reason: "surface start",
    });
    const startBody = await start.json();
    expect(start.status, `stopped/idle API global start status: ${JSON.stringify(startBody)}`).toBe(
      200,
    );
    expect(start.headers.get("x-request-id"), "API request trace header").toMatch(
      /^[0-9A-HJKMNP-TV-Z]{26}$/,
    );
    expect(startBody, "stopped/idle API global start response").toEqual({
      ok: true,
      data: {
        global_authority: "running",
        projection: "running",
        cleanup_state: { status: "idle", entries: [] },
        active_count: 0,
        queue_depth: 0,
        held_count: 0,
        held_tasks: [],
        task_controls: [],
        degraded_targets: [],
        outcome: "applied",
      },
      error: null,
    });
    expect(startBody.data, "global response forbids task identity").not.toHaveProperty("task_id");
    expect(startBody.data, "global response forbids submitted task ref").not.toHaveProperty(
      "task_ref",
    );

    const cliPause = runSurfaceCli(fixture, "agent dispatch pause --reason 'surface pause' --json");
    expect(cliPause.exitCode, "running CLI pause exit").toBe(0);
    expect(JSON.parse(cliPause.stdout), "running CLI pause response").toEqual({
      ok: true,
      data: expect.objectContaining({
        global_authority: "paused",
        projection: "paused",
        cleanup_state: { status: "idle", entries: [] },
        outcome: "applied",
      }),
      error: null,
    });

    const cliResume = runSurfaceCli(fixture, "agent dispatch resume --json");
    expect(cliResume.exitCode, "paused CLI resume exit").toBe(0);
    expect(JSON.parse(cliResume.stdout).data, "paused CLI resume authority").toMatchObject({
      global_authority: "running",
      projection: "running",
      outcome: "applied",
    });

    const taskPause = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "pause",
      task_ref: fixture.taskRef,
      reason: "surface task hold",
    });
    expect(taskPause.status, "slug API task pause status").toBe(200);
    const taskPauseBody = await taskPause.json();
    expect(taskPauseBody, "slug API task pause canonical response").toEqual({
      ok: true,
      data: expect.objectContaining({
        global_authority: "running",
        projection: "running",
        cleanup_state: { status: "idle", entries: [] },
        task_id: fixture.taskId,
        task_ref: fixture.taskRef,
        outcome: "applied",
        task_controls: [
          expect.objectContaining({
            task_id: fixture.taskId,
            task_ref: fixture.taskRef,
            mode: "paused",
            cleanup_state: { status: "idle", entries: [] },
          }),
        ],
      }),
      error: null,
    });

    const taskResume = runSurfaceCli(
      fixture,
      `agent dispatch task resume ${fixture.taskRef} --json`,
    );
    expect(taskResume.exitCode, "paused task CLI resume exit").toBe(0);
    expect(JSON.parse(taskResume.stdout).data, "paused task CLI canonical identity").toMatchObject({
      task_id: fixture.taskId,
      task_ref: fixture.taskRef,
      task_controls: [],
      outcome: "applied",
    });

    const taskStop = runSurfaceCli(
      fixture,
      `agent dispatch task stop ${fixture.taskRef} --force --json`,
    );
    expect(taskStop.exitCode, "running task CLI hard-stop exit").toBe(0);
    expect(JSON.parse(taskStop.stdout).data, "running task CLI hard-stop response").toMatchObject({
      task_id: fixture.taskId,
      task_ref: fixture.taskRef,
      task_controls: [
        expect.objectContaining({
          task_id: fixture.taskId,
          mode: "stopped",
          cleanup_state: { status: "idle", entries: [] },
        }),
      ],
      outcome: "applied",
    });

    const taskRestart = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "resume",
      task_id: fixture.taskId,
    });
    expect(taskRestart.status, "stopped/idle API task resume status").toBe(200);
    expect((await taskRestart.json()).data, "stopped/idle API task resume response").toMatchObject({
      task_id: fixture.taskId,
      task_controls: [],
      outcome: "applied",
    });

    const globalStop = runSurfaceCli(
      fixture,
      "agent dispatch stop --reason 'surface stop' --force --json",
    );
    expect(globalStop.exitCode, "running CLI global hard-stop exit").toBe(0);
    expect(
      JSON.parse(globalStop.stdout).data,
      "running CLI global hard-stop response",
    ).toMatchObject({
      global_authority: "stopped",
      projection: "stopped",
      cleanup_state: { status: "idle", entries: [] },
      outcome: "applied",
    });

    const invalid = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "pause",
    });
    expect(invalid.status, "stopped API pause invalid-transition status").toBe(409);
    expect(await invalid.json(), "stopped API pause current-status failure").toEqual({
      ok: false,
      data: expect.objectContaining({
        global_authority: "stopped",
        projection: "stopped",
        cleanup_state: { status: "idle", entries: [] },
      }),
      error: {
        code: "invalid_transition",
        message: "Invalid dispatch lifecycle transition",
        suggestion: "Refresh lifecycle status and choose an allowed action.",
      },
    });

    const publicStatus = await requestSurface(fixture, "/api/agent/status");
    expect(publicStatus.status, "public lifecycle status HTTP status").toBe(200);
    const publicBody = await publicStatus.json();
    expect(Object.keys(publicBody).toSorted(), "exact public status field set").toEqual(
      [
        "active_count",
        "active_invocations",
        "agent_definitions",
        "cleanup_state",
        "degraded",
        "degraded_targets",
        "dispatch_enabled",
        "global_authority",
        "held_count",
        "held_tasks",
        "projection",
        "queue_depth",
        "queued_invocations",
        "task_controls",
      ].toSorted(),
    );
    const publicLifecycle = {
      global_authority: publicBody.global_authority,
      projection: publicBody.projection,
      cleanup_state: publicBody.cleanup_state,
      active_count: publicBody.active_count,
      queue_depth: publicBody.queue_depth,
      held_count: publicBody.held_count,
      held_tasks: publicBody.held_tasks,
      task_controls: publicBody.task_controls,
      degraded_targets: publicBody.degraded_targets,
    };
    expect(
      DispatchLifecycleStatusSchema.parse(publicLifecycle),
      "public snake-case lifecycle subset schema",
    ).toEqual(
      expect.objectContaining({
        global_authority: "stopped",
        cleanup_state: { status: "idle", entries: [] },
        active_count: 0,
        held_count: 0,
        held_tasks: [],
        task_controls: [],
      }),
    );
    for (const forbidden of [
      "globalAuthority",
      "cleanupState",
      "activeCount",
      "queueDepth",
      "heldCount",
      "heldTasks",
      "taskControls",
      "degradedTargets",
    ]) {
      expect(publicBody, `public boundary forbids ${forbidden}`).not.toHaveProperty(forbidden);
    }

    const internalStatus = await requestSurface(fixture, "/api/agent/dispatch/status");
    expect(internalStatus.status, "internal lifecycle status HTTP status").toBe(200);
    const internalBody = await internalStatus.json();
    expect(internalBody, "internal lifecycle top-level casing").toMatchObject({
      globalAuthority: "stopped",
      projection: "stopped",
      cleanupState: { status: "idle", entries: [] },
      heldCount: 0,
      heldTasks: [],
      taskControls: [],
    });
    expect(internalBody, "internal boundary forbids public root casing").not.toHaveProperty(
      "global_authority",
    );

    const cliStatus = runSurfaceCli(fixture, "agent dispatch status --json");
    expect(cliStatus.exitCode, "CLI status exit").toBe(0);
    const cliStatusBody = JSON.parse(cliStatus.stdout);
    expect(
      {
        globalAuthority: cliStatusBody.globalAuthority,
        projection: cliStatusBody.projection,
        cleanupState: cliStatusBody.cleanupState,
        heldCount: cliStatusBody.heldCount,
        heldTasks: cliStatusBody.heldTasks,
        taskControls: cliStatusBody.taskControls,
      },
      "CLI preserves the internal lifecycle contract",
    ).toEqual({
      globalAuthority: internalBody.globalAuthority,
      projection: internalBody.projection,
      cleanupState: internalBody.cleanupState,
      heldCount: internalBody.heldCount,
      heldTasks: internalBody.heldTasks,
      taskControls: internalBody.taskControls,
    });

    injectLifecycleFailure(fixture, "control_commit_failed");
    const failedCommit = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    expect(failedCommit.status, "injected commit failure HTTP status").toBe(503);
    expect(await failedCommit.json(), "injected commit failure current-status response").toEqual({
      ok: false,
      data: expect.objectContaining({
        global_authority: "stopped",
        cleanup_state: { status: "idle", entries: [] },
      }),
      error: {
        code: "control_commit_failed",
        message: "Dispatch control commit failed",
        suggestion: "Resolve the shadow worktree commit failure and retry.",
      },
    });

    await vi.waitFor(
      () => {
        expect(
          capture.events.filter((event) => event.event.startsWith("dispatch_control.")),
          "one matching event for each applied/noop/failed surface outcome",
        ).toHaveLength(10);
      },
      { timeout: 10_000 },
    );
    expect(
      capture.events
        .filter((event) => event.event.startsWith("dispatch_control."))
        .map((event) => [event.event, event.data.scope, event.data.task_id, event.data.error_code]),
      "response/exit/event comparison",
    ).toEqual([
      ["dispatch_control.start_applied", "global", undefined, undefined],
      ["dispatch_control.pause_applied", "global", undefined, undefined],
      ["dispatch_control.resume_applied", "global", undefined, undefined],
      ["dispatch_control.pause_applied", "task", fixture.taskId, undefined],
      ["dispatch_control.resume_applied", "task", fixture.taskId, undefined],
      ["dispatch_control.stop_applied", "task", fixture.taskId, undefined],
      ["dispatch_control.resume_applied", "task", fixture.taskId, undefined],
      ["dispatch_control.stop_applied", "global", undefined, undefined],
      ["dispatch_control.failed", "global", undefined, "invalid_transition"],
      ["dispatch_control.failed", "global", undefined, "control_commit_failed"],
    ]);
    for (const event of capture.events) {
      expect(event.data, `event ${event.event} forbids raw errors and paths`).not.toHaveProperty(
        "rawError",
      );
      expect(JSON.stringify(event.data), `event ${event.event} hides fixture path`).not.toContain(
        fixture.project.tempDir,
      );
    }
  });

  // AC: @daemon-agent-dispatch ac-control-error-current-status
  // AC: @daemon-agent-dispatch ac-control-failure-no-success
  // AC: @daemon-agent-dispatch ac-cleanup-failure-no-success
  it("compares every closed failure across HTTP, CLI, and sanitized events", async () => {
    const fixture = await createSurfaceDaemonFixture();
    const capture = await captureSurfaceEvents(fixture);
    onTestFinished(capture.close);
    const started = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    expect(started.status, "failure matrix fixture starts running").toBe(200);

    const expectedStatuses: Record<DispatchLifecycleControlErrorCode, number> = {
      validation_failed: 400,
      task_not_found: 404,
      task_identity_ambiguous: 409,
      task_identity_mismatch: 409,
      invalid_transition: 409,
      control_store_unavailable: 503,
      control_store_corrupt: 503,
      control_commit_failed: 503,
      cancellation_timeout: 500,
      cancellation_failed: 500,
      session_closure_failed: 500,
      cleanup_ownership_mismatch: 409,
      cleanup_process_birth_mismatch: 409,
      cleanup_leader_missing_group_alive: 409,
      cleanup_identity_unverifiable: 503,
      cleanup_group_unverifiable: 503,
      internal_error: 500,
    };
    const observed: Array<{
      code: DispatchLifecycleControlErrorCode;
      apiStatus: number;
      cliExit: number;
      apiEvent: string;
      cliEvent: string;
    }> = [];

    for (const code of DispatchControlErrorCodeSchema.options) {
      const beforeApi = capture.events.length;
      injectLifecycleFailure(fixture, code);
      const api = await requestSurface(fixture, "/api/agent/dispatch/control", {
        scope: "global",
        action: "pause",
      });
      const apiBody = await api.json();
      expect(api.status, `${code} API status`).toBe(expectedStatuses[code]);
      expect(apiBody, `${code} API closed failure with current status`).toEqual({
        ok: false,
        data: expect.objectContaining({
          global_authority: "running",
          cleanup_state: { status: "idle", entries: [] },
        }),
        error: {
          code,
          message: expect.any(String),
          suggestion: expect.any(String),
        },
      });
      await vi.waitFor(() => {
        expect(capture.events.length, `${code} API event count`).toBe(beforeApi + 1);
      });
      const apiEvent = capture.events.at(-1)!;

      const beforeCli = capture.events.length;
      injectLifecycleFailure(fixture, code);
      const cli = runSurfaceCli(fixture, "agent dispatch pause --json", true);
      expect(cli.exitCode, `${code} CLI exit`).toBe(code === "validation_failed" ? 1 : 3);
      const cliBody = JSON.parse(cli.stderr);
      expect(cliBody, `${code} CLI closed copy`).toEqual({
        ok: false,
        data: null,
        error: {
          code,
          message: expect.any(String),
          suggestion: expect.any(String),
        },
      });
      await vi.waitFor(() => {
        expect(capture.events.length, `${code} CLI event count`).toBe(beforeCli + 1);
      });
      const cliEvent = capture.events.at(-1)!;

      for (const [surface, event] of [
        ["API", apiEvent],
        ["CLI", cliEvent],
      ] as const) {
        expect(event.event, `${code} ${surface} failed identifier`).toBe("dispatch_control.failed");
        expect(event.data, `${code} ${surface} event parity`).toMatchObject({
          scope: "global",
          action: "pause",
          outcome: "failed",
          error_code: code,
        });
        expect(event.data, `${code} ${surface} event hides raw error`).not.toHaveProperty(
          "rawError",
        );
        expect(
          JSON.stringify(event.data),
          `${code} ${surface} event hides fixture path`,
        ).not.toContain(fixture.project.tempDir);
      }
      expect(JSON.stringify(apiBody), `${code} API hides fixture path`).not.toContain(
        fixture.project.tempDir,
      );
      expect(`${cli.stdout}\n${cli.stderr}`, `${code} CLI hides fixture path`).not.toContain(
        fixture.project.tempDir,
      );
      observed.push({
        code,
        apiStatus: api.status,
        cliExit: cli.exitCode,
        apiEvent: apiEvent.event,
        cliEvent: cliEvent.event,
      });
    }

    expect(observed, "all 17 response/exit/event rows").toHaveLength(17);
    expect(new Set(observed.map((row) => row.code)), "all failure codes unique").toHaveLength(17);
  });

  // AC: @daemon-agent-dispatch ac-public-status-lifecycle-additions
  // AC: @daemon-agent-dispatch ac-control-error-current-status
  it("projects pending, failed, and mixed cleanup rows and gates only matching scope", async () => {
    const fixture = await createSurfaceDaemonFixture();

    injectLifecycleFailure(fixture, "pending", { revision: 1, taskStatus: "pending" });
    await vi.waitFor(
      async () => {
        const response = await requestSurface(fixture, "/api/agent/status");
        expect(response.status, "all-pending public status").toBe(200);
        expect((await response.json()).cleanup_state, "all-pending public cleanup rows").toEqual({
          status: "pending",
          entries: [
            {
              cleanup_id: GLOBAL_CLEANUP_ID,
              scope: "global",
              status: "pending",
              phase: "owned",
            },
            {
              cleanup_id: TASK_CLEANUP_ID,
              scope: "task",
              task_id: fixture.taskId,
              status: "pending",
              phase: "owned",
            },
          ],
        });
      },
      { timeout: 10_000 },
    );

    injectLifecycleFailure(fixture, "failed_cleanup", {
      revision: 2,
      taskStatus: "failed",
    });
    await vi.waitFor(
      async () => {
        const response = await requestSurface(fixture, "/api/agent/dispatch/status");
        expect(response.status, "all-failed internal status").toBe(200);
        const body = await response.json();
        expect(body.cleanupState, "all-failed internal cleanup rows remain snake_case").toEqual({
          status: "failed",
          entries: [
            {
              cleanup_id: GLOBAL_CLEANUP_ID,
              scope: "global",
              status: "failed",
              phase: "signals_sent",
              error_code: "cancellation_failed",
            },
            {
              cleanup_id: TASK_CLEANUP_ID,
              scope: "task",
              task_id: fixture.taskId,
              status: "failed",
              phase: "signals_sent",
              error_code: "cancellation_failed",
            },
          ],
        });
        expect(body.taskControls, "task control nests only matching cleanup").toEqual([
          {
            task_id: fixture.taskId,
            task_ref: fixture.taskRef,
            title: "Ready task",
            mode: "stopped",
            reason: "surface cleanup",
            actor: "api",
            source: "api",
            controlled_at: NOW,
            updated_at: NOW,
            cleanup_state: {
              status: "failed",
              entries: [
                {
                  cleanup_id: TASK_CLEANUP_ID,
                  scope: "task",
                  task_id: fixture.taskId,
                  status: "failed",
                  phase: "signals_sent",
                  error_code: "cancellation_failed",
                },
              ],
            },
          },
        ]);
      },
      { timeout: 10_000 },
    );
    const allFailedPublicResponse = await requestSurface(fixture, "/api/agent/status");
    expect(allFailedPublicResponse.status, "all-failed public status").toBe(200);
    const allFailedPublicBody = await allFailedPublicResponse.json();
    const publicLifecycle = DispatchLifecycleStatusSchema.parse({
      global_authority: allFailedPublicBody.global_authority,
      projection: allFailedPublicBody.projection,
      cleanup_state: allFailedPublicBody.cleanup_state,
      active_count: allFailedPublicBody.active_count,
      queue_depth: allFailedPublicBody.queue_depth,
      held_count: allFailedPublicBody.held_count,
      held_tasks: allFailedPublicBody.held_tasks,
      task_controls: allFailedPublicBody.task_controls,
      degraded_targets: allFailedPublicBody.degraded_targets,
    });
    const uiStatus = parseAgentDispatchStatusWire(allFailedPublicBody);
    expect(
      {
        globalAuthority: uiStatus.globalAuthority,
        projection: uiStatus.projection,
        cleanupState: uiStatus.cleanupState,
        activeCount: uiStatus.activeCount,
        queueDepth: uiStatus.queueDepth,
        heldCount: uiStatus.heldCount,
        heldTasks: uiStatus.heldTasks,
        taskControls: uiStatus.taskControls,
        degradedTargets: uiStatus.degradedTargets,
      },
      "real public wire deep-converts to the exact UI lifecycle model",
    ).toEqual({
      globalAuthority: publicLifecycle.global_authority,
      projection: publicLifecycle.projection,
      cleanupState: {
        status: publicLifecycle.cleanup_state.status,
        entries: publicLifecycle.cleanup_state.entries.map((entry) => ({
          cleanupId: entry.cleanup_id,
          scope: entry.scope,
          ...(entry.task_id === undefined ? {} : { taskId: entry.task_id }),
          status: entry.status,
          phase: entry.phase,
          ...(entry.error_code === undefined ? {} : { errorCode: entry.error_code }),
        })),
      },
      activeCount: publicLifecycle.active_count,
      queueDepth: publicLifecycle.queue_depth,
      heldCount: publicLifecycle.held_count,
      heldTasks: publicLifecycle.held_tasks.map((task) => ({
        taskId: task.task_id,
        taskRef: task.task_ref,
        title: task.title,
        scope: task.scope,
        mode: task.mode,
        reason: task.reason,
        actor: task.actor,
        source: task.source,
        controlledAt: task.controlled_at,
        updatedAt: task.updated_at,
      })),
      taskControls: publicLifecycle.task_controls.map((control) => ({
        taskId: control.task_id,
        taskRef: control.task_ref,
        title: control.title,
        mode: control.mode,
        reason: control.reason,
        actor: control.actor,
        source: control.source,
        controlledAt: control.controlled_at,
        updatedAt: control.updated_at,
        cleanupState: {
          status: control.cleanup_state.status,
          entries: control.cleanup_state.entries.map((entry) => ({
            cleanupId: entry.cleanup_id,
            scope: entry.scope,
            ...(entry.task_id === undefined ? {} : { taskId: entry.task_id }),
            status: entry.status,
            phase: entry.phase,
            ...(entry.error_code === undefined ? {} : { errorCode: entry.error_code }),
          })),
        },
      })),
      degradedTargets: publicLifecycle.degraded_targets,
    });
    expect(
      DispatchLifecycleStatusSchema.parse({
        global_authority: uiStatus.globalAuthority,
        projection: uiStatus.projection,
        cleanup_state: {
          status: uiStatus.cleanupState.status,
          entries: uiStatus.cleanupState.entries.map((entry) => ({
            cleanup_id: entry.cleanupId,
            scope: entry.scope,
            ...(entry.taskId === undefined ? {} : { task_id: entry.taskId }),
            status: entry.status,
            phase: entry.phase,
            ...(entry.errorCode === undefined ? {} : { error_code: entry.errorCode }),
          })),
        },
        active_count: uiStatus.activeCount,
        queue_depth: uiStatus.queueDepth,
        held_count: uiStatus.heldCount,
        held_tasks: uiStatus.heldTasks.map((task) => ({
          task_id: task.taskId,
          task_ref: task.taskRef,
          title: task.title,
          scope: task.scope,
          mode: task.mode,
          reason: task.reason,
          actor: task.actor,
          source: task.source,
          controlled_at: task.controlledAt,
          updated_at: task.updatedAt,
        })),
        task_controls: uiStatus.taskControls.map((control) => ({
          task_id: control.taskId,
          task_ref: control.taskRef,
          title: control.title,
          mode: control.mode,
          reason: control.reason,
          actor: control.actor,
          source: control.source,
          controlled_at: control.controlledAt,
          updated_at: control.updatedAt,
          cleanup_state: {
            status: control.cleanupState.status,
            entries: control.cleanupState.entries.map((entry) => ({
              cleanup_id: entry.cleanupId,
              scope: entry.scope,
              ...(entry.taskId === undefined ? {} : { task_id: entry.taskId }),
              status: entry.status,
              phase: entry.phase,
              ...(entry.errorCode === undefined ? {} : { error_code: entry.errorCode }),
            })),
          },
        })),
        degraded_targets: uiStatus.degradedTargets,
      }),
      "UI lifecycle data round-trips to the original public wire semantics",
    ).toEqual(publicLifecycle);
    const allFailedCli = runSurfaceCli(fixture, "agent dispatch status --json");
    expect(allFailedCli.exitCode, "all-failed CLI status exit").toBe(0);
    expect(
      JSON.parse(allFailedCli.stdout).cleanupState,
      "all-failed CLI hybrid cleanup rows",
    ).toEqual({
      status: "failed",
      entries: [
        {
          cleanup_id: GLOBAL_CLEANUP_ID,
          scope: "global",
          status: "failed",
          phase: "signals_sent",
          error_code: "cancellation_failed",
        },
        {
          cleanup_id: TASK_CLEANUP_ID,
          scope: "task",
          task_id: fixture.taskId,
          status: "failed",
          phase: "signals_sent",
          error_code: "cancellation_failed",
        },
      ],
    });

    injectLifecycleFailure(fixture, "failed_cleanup", {
      revision: 3,
      taskStatus: "pending",
    });
    await vi.waitFor(
      async () => {
        const response = await requestSurface(fixture, "/api/agent/status");
        const body = await response.json();
        expect(body.cleanup_state, "mixed failed-plus-pending public cleanup rows").toEqual({
          status: "failed",
          entries: [
            {
              cleanup_id: GLOBAL_CLEANUP_ID,
              scope: "global",
              status: "failed",
              phase: "signals_sent",
              error_code: "cancellation_failed",
            },
            {
              cleanup_id: TASK_CLEANUP_ID,
              scope: "task",
              task_id: fixture.taskId,
              status: "pending",
              phase: "owned",
            },
          ],
        });
      },
      { timeout: 10_000 },
    );

    const taskResume = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "resume",
      task_ref: fixture.taskRef,
    });
    expect(taskResume.status, "matching task cleanup rejects task resume").toBe(409);
    expect(
      await taskResume.json(),
      "matching task cleanup failure includes current lifecycle status",
    ).toEqual({
      ok: false,
      data: expect.objectContaining({
        global_authority: "stopped",
        projection: "stopped",
        cleanup_state: {
          status: "failed",
          entries: [
            {
              cleanup_id: GLOBAL_CLEANUP_ID,
              scope: "global",
              status: "failed",
              phase: "signals_sent",
              error_code: "cancellation_failed",
            },
            {
              cleanup_id: TASK_CLEANUP_ID,
              scope: "task",
              task_id: fixture.taskId,
              status: "pending",
              phase: "owned",
            },
          ],
        },
        task_controls: [
          expect.objectContaining({
            task_id: fixture.taskId,
            mode: "stopped",
            cleanup_state: {
              status: "pending",
              entries: [
                expect.objectContaining({
                  cleanup_id: TASK_CLEANUP_ID,
                  task_id: fixture.taskId,
                  status: "pending",
                }),
              ],
            },
          }),
        ],
      }),
      error: {
        code: "invalid_transition",
        message: "Invalid dispatch lifecycle transition",
        suggestion: "Refresh lifecycle status and choose an allowed action.",
      },
    });

    writeFileSync(
      join(fixture.project.kspecDir, "dispatch-control.yaml"),
      YAML.stringify({
        version: 1,
        revision: 4,
        global: { authority: "stopped" },
        tasks: {
          [fixture.taskId]: {
            mode: "stopped",
            reason: "surface cleanup",
            actor: "api",
            source: "api",
            controlled_at: NOW,
            updated_at: NOW,
          },
        },
        pending_cleanup: {
          global: {
            cleanup_id: GLOBAL_CLEANUP_ID,
            status: "failed",
            phase: "signals_sent",
            error_code: "cancellation_failed",
            targets: [],
          },
        },
      }),
    );
    execFileSync("git", ["add", "dispatch-control.yaml"], { cwd: fixture.project.kspecDir });
    execFileSync("git", ["commit", "-m", "retain only global cleanup"], {
      cwd: fixture.project.kspecDir,
    });
    await vi.waitFor(
      async () => {
        const response = await requestSurface(fixture, "/api/agent/status");
        const body = await response.json();
        expect(body.cleanup_state.entries, "global-only cleanup publication").toEqual([
          expect.objectContaining({ scope: "global", error_code: "cancellation_failed" }),
        ]);
      },
      { timeout: 10_000 },
    );
    const taskRetry = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "task",
      action: "resume",
      task_ref: fixture.taskRef,
    });
    expect(taskRetry.status, "cleared matching cleanup permits task metadata retry").toBe(200);
    expect((await taskRetry.json()).data.outcome, "task retry outcome").toBe("applied");
    const globalBlocked = await requestSurface(fixture, "/api/agent/dispatch/control", {
      scope: "global",
      action: "start",
    });
    expect(globalBlocked.status, "global cleanup still prevents work start").toBe(409);
    expect((await globalBlocked.json()).error.code, "global cleanup start rejection").toBe(
      "invalid_transition",
    );

    const unrelatedTaskId = "01KG0RR7CC9N4YGP991WD7XS8S";
    writeFileSync(
      join(fixture.project.kspecDir, "dispatch-control.yaml"),
      YAML.stringify({
        version: 1,
        revision: 6,
        global: { authority: "stopped" },
        tasks: {
          [unrelatedTaskId]: {
            mode: "stopped",
            reason: "unrelated cleanup",
            actor: "api",
            source: "api",
            controlled_at: NOW,
            updated_at: NOW,
          },
        },
        pending_cleanup: {
          [unrelatedTaskId]: {
            cleanup_id: TASK_CLEANUP_ID,
            status: "pending",
            phase: "owned",
            targets: [],
          },
        },
      }),
    );
    execFileSync("git", ["add", "dispatch-control.yaml"], { cwd: fixture.project.kspecDir });
    execFileSync("git", ["commit", "-m", "inject unrelated task cleanup"], {
      cwd: fixture.project.kspecDir,
    });
    await vi.waitFor(
      async () => {
        const response = await requestSurface(fixture, "/api/agent/status");
        expect((await response.json()).cleanup_state.entries[0].task_id).toBe(unrelatedTaskId);
      },
      { timeout: 10_000 },
    );
    const legacyStart = await requestSurface(fixture, "/api/agent/dispatch/start", {});
    expect(legacyStart.status, "unrelated task cleanup permits legacy global start").toBe(200);
    expect((await legacyStart.json()).started, "legacy start alias applies").toBe(true);
    const legacyStop = await requestSurface(fixture, "/api/agent/dispatch/stop", {});
    expect(legacyStop.status, "unrelated task cleanup permits legacy global stop").toBe(200);
    expect((await legacyStop.json()).stopped, "legacy stop alias applies").toBe(true);
    const globalStart = await requestSurface(fixture, "/api/agent/dispatch", {
      action: "start",
    });
    expect(globalStart.status, "unrelated task cleanup permits action alias start").toBe(200);
    expect(await globalStart.json(), "action alias response uses its legacy contract").toEqual({
      dispatch_enabled: true,
    });
    const afterAliases = await requestSurface(fixture, "/api/agent/status");
    expect(
      (await afterAliases.json()).cleanup_state.entries,
      "global aliases leave unrelated task cleanup observable",
    ).toEqual([expect.objectContaining({ scope: "task", task_id: unrelatedTaskId })]);
  });
});
