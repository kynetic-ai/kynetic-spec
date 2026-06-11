/**
 * Tests for the daemon command API endpoint.
 *
 * AC Coverage:
 * - @daemon-command-api ac-command-endpoint: POST /api/command executes commands
 * - @daemon-command-api ac-mutation-cache-update: cache updated after mutations
 * - @daemon-command-api ac-batch-support: batch array execution
 * - @daemon-command-api ac-concurrent-mutations: serialized mutation execution
 * - @daemon-command-api ac-response-parity: stdout/stderr/exitCode match direct CLI
 * - @daemon-command-api ac-cache-context-propagation: command execution receives entity cache async context
 * - @daemon-command-api ac-no-recursive-command-proxy: daemon-internal command execution sees proxying suppressed
 * - @daemon-command-api ac-command-timeout: structured 504 when the execution limit elapses
 * - @daemon-command-api ac-timeout-queue-bounded: queued callers bounded; expired queued commands discarded
 * - @daemon-command-api ac-stuck-command-reported: health surface reports degraded dispatch while wedged
 * - @daemon-command-api ac-timeout-isolation: late output/rejections stay isolated from later commands
 * - @daemon-command-api ac-timeout-late-completion-effects: late completions still write through and broadcast
 * - @trait-api-endpoint ac-1: returns 2xx with JSON body
 * - @trait-api-endpoint ac-3: returns 400 on invalid body
 * - @trait-api-endpoint ac-6: includes X-Request-Id header
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  seedSplitTask,
  testUlid,
} from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";
import { createCommandRoutes } from "../dist/daemon/routes/command.js";
import { PubSubManager } from "../dist/daemon/websocket/pubsub.js";
import type {
  RouteEntityCache,
  EntityCacheAccessor,
} from "../dist/daemon/routes/entity-cache-types.js";
import type { CacheDomain } from "../src/daemon/entity-cache.js";
import type { LoadedTask } from "../src/parser/index.js";
import type { LoadedSpecItem } from "../src/parser/index.js";
import type { LoadedPlan } from "../src/parser/plans.js";
import type { LoadedReviewRecord } from "../src/parser/reviews.js";
import type { MetaContext } from "../src/parser/meta.js";

ensureSplitBackendRegistered();

const TASK_ULID = testUlid("TASK", 1);
const SPEC_ULID = testUlid("SPEC", 2);
const PLAN_ULID = testUlid("PLAN", 3);
const TEST_CWD = process.cwd();

let tempDir: string;
let app: Elysia;
let pubsub: PubSubManager;
let mockCache: RouteEntityCache;
let writeThroughCalls: string[];
let cacheSnapshot: CacheSnapshot;
let prepareProgram: ((program: Command) => void | Promise<void>) | undefined;

type CacheState = "unloaded" | "loading" | "ready" | "degraded";

interface RefEntity {
  _ulid: string;
  slugs: string[];
}

interface CacheSnapshot {
  tasks: LoadedTask[];
  items: LoadedSpecItem[];
  plans: LoadedPlan[];
  reviews: LoadedReviewRecord[];
  meta: MetaContext;
  taskIndex: RefEntity[];
  itemIndex: RefEntity[];
  planIndex: RefEntity[];
  reviewIndex: RefEntity[];
  projectConfig: NonNullable<RouteEntityCache["getProjectConfig"]>;
  shadowInfo: NonNullable<RouteEntityCache["getShadowInfo"]>;
}

async function withCacheContextCommand<T>(fn: () => Promise<T>): Promise<T> {
  prepareProgram = (program) => {
    program.command("debug-cache-context").action(async () => {
      const { getEntityCacheContext } = await import("../dist/parser/yaml.js");
      const context = getEntityCacheContext();
      const resolvedCache = context?.cacheAccessor(context.projectPath) ?? null;

      console.log(
        JSON.stringify({
          hasContext: context !== undefined,
          projectPath: context?.projectPath ?? null,
          resolvedCache: resolvedCache !== null,
        }),
      );
    });
  };
  try {
    return await fn();
  } finally {
    prepareProgram = undefined;
  }
}

function pickRefEntity(entity: { _ulid: string; slugs?: string[] }): RefEntity {
  return {
    _ulid: entity._ulid,
    slugs: entity.slugs ?? [],
  };
}

async function buildCacheSnapshot(): Promise<CacheSnapshot> {
  const previousCwd = TEST_CWD;
  process.chdir(tempDir);

  try {
    const parser = await import("../src/parser/index.js");
    const { loadReviewRecords } = await import("../src/parser/reviews.js");
    const ctx = await parser.initContext();
    const taskManager = parser.resolveTaskDataManager(ctx);
    const tasks = await taskManager.loadAllTasks(ctx);
    const items = await parser.loadAllItems(ctx);
    const plans = await parser.loadPlans(ctx);
    const reviews = await loadReviewRecords(ctx);
    const meta = await parser.loadMetaContext(ctx);

    return {
      tasks,
      items,
      plans,
      reviews,
      meta,
      taskIndex: tasks.map(pickRefEntity),
      itemIndex: items.map(pickRefEntity),
      planIndex: plans.map(pickRefEntity),
      reviewIndex: reviews.map(pickRefEntity),
      projectConfig: () => ({
        project: ctx.config?.project ?? null,
        spec_version: "1.1",
        root_dir: tempDir,
        remote_tracking: null,
        daemon: ctx.config?.daemon ?? { port: 3456, host: "127.0.0.1", auto_start: false },
        manifest_path: ctx.manifestPath ?? null,
        manifest: ctx.manifest ?? null,
        config: ctx.config,
      }),
      shadowInfo: () => ({
        enabled: true,
        branch_name: ctx.shadow?.branchName ?? "kspec-meta",
        worktree_dir: tempDir,
        healthy: true,
        remote_tracking: false,
      }),
    };
  } finally {
    process.chdir(previousCwd);
  }
}

function findCommand(program: Command, pathParts: string[]): Command {
  let current = program;
  for (const part of pathParts) {
    const next = current.commands.find((command) => command.name() === part);
    if (!next) {
      throw new Error(`Command not found: ${pathParts.join(" ")}`);
    }
    current = next;
  }
  return current;
}

async function withDelayedCommandAction<T>(
  commandPath: string,
  delayMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  prepareProgram = (program) => {
    const command = findCommand(program, commandPath.split(" "));
    const originalHandler = (
      command as Command & {
        _actionHandler?: (...args: unknown[]) => unknown;
      }
    )._actionHandler;

    if (!originalHandler) {
      throw new Error(`Command has no action handler: ${commandPath}`);
    }

    (
      command as Command & { _actionHandler: (...args: unknown[]) => Promise<unknown> }
    )._actionHandler = async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return originalHandler(...args);
    };
  };
  try {
    return await fn();
  } finally {
    prepareProgram = undefined;
  }
}

async function withInjectedCommand<T>(
  configure: (program: Command) => void | Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  prepareProgram = configure;
  try {
    return await fn();
  } finally {
    prepareProgram = undefined;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

/** Manually-settled promise used to wedge or gate stubbed command actions. */
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Poll until condition holds — for asserting effects of detached late completions. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitFor: condition not met in time");
    }
    await new Promise((res) => setTimeout(res, 10));
  }
}

async function measureConcurrentRequests(
  requests: Array<() => Promise<Response>>,
): Promise<number> {
  const startedAt = Date.now();
  const responses = await Promise.all(requests.map((request) => request()));
  await Promise.all(responses.map((response) => response.json()));
  return Date.now() - startedAt;
}

/**
 * Create a mock entity cache that tracks writeThrough calls.
 * This ensures ac-mutation-cache-update is genuinely exercised.
 */
function createMockEntityCache(
  states: Partial<Record<CacheDomain, CacheState>> = {},
): RouteEntityCache {
  writeThroughCalls = [];
  const getState = (domain: CacheDomain): CacheState => states[domain] ?? "ready";

  return {
    getDomainState: (domain: string) => getState(domain as CacheDomain),
    getTaskIndex: () => cacheSnapshot.taskIndex as any,
    getTaskDetail: (ulid: string) =>
      cacheSnapshot.tasks.find((task) => task._ulid === ulid) ?? null,
    getTaskHistory: () => null,
    setTaskDetail: () => {},
    getAllTaskDetails: () => cacheSnapshot.tasks as any,
    getItemIndex: () => cacheSnapshot.itemIndex as any,
    getItemDetail: (ulid: string) =>
      cacheSnapshot.items.find((item) => item._ulid === ulid) ?? null,
    setItemDetail: () => {},
    getAllItemDetails: () => cacheSnapshot.items,
    getSessionIndex: () => null,
    getSessionLiveEventCount: () => undefined,
    getSessionDetail: () => null,
    setSessionDetail: () => {},
    getPlansIndex: () => cacheSnapshot.planIndex as any,
    getPlanDetail: (ulid: string) =>
      cacheSnapshot.plans.find((plan) => plan._ulid === ulid) ?? null,
    setPlanDetail: () => {},
    getInboxIndex: () => [],
    getTriageIndex: () => null,
    getTriageDetail: () => null,
    setTriageDetail: () => {},
    getReviewsIndex: () => cacheSnapshot.reviewIndex as any,
    getReviewDetail: (ulid: string) =>
      cacheSnapshot.reviews.find((review) => review._ulid === ulid) ?? null,
    setReviewDetail: () => {},
    getMetaIndex: () => null,
    getMetaDetail: () => cacheSnapshot.meta,
    setMetaDetail: () => {},
    getShadowInfo: cacheSnapshot.shadowInfo,
    getProjectConfig: cacheSnapshot.projectConfig,
    getSessionContext: () => null,
    writeThrough: vi.fn(async (domain: string) => {
      writeThroughCalls.push(domain);
    }),
    markWriteThrough: vi.fn(),
    getCacheDiagnostics: () => ({
      projectPath: tempDir,
      domains: {
        tasks: {
          state: getState("tasks"),
          indexCount: cacheSnapshot.taskIndex.length,
          detailCount: cacheSnapshot.tasks.length,
          lastError: null,
          lastInvalidatedAt: null,
        },
        items: {
          state: getState("items"),
          indexCount: cacheSnapshot.itemIndex.length,
          detailCount: cacheSnapshot.items.length,
          lastError: null,
          lastInvalidatedAt: null,
        },
        meta: {
          state: getState("meta"),
          indexCount: 0,
          detailCount: 1,
          lastError: null,
          lastInvalidatedAt: null,
        },
        inbox: {
          state: getState("inbox"),
          indexCount: 0,
          detailCount: 0,
          lastError: null,
          lastInvalidatedAt: null,
        },
        plans: {
          state: getState("plans"),
          indexCount: cacheSnapshot.planIndex.length,
          detailCount: cacheSnapshot.plans.length,
          lastError: null,
          lastInvalidatedAt: null,
        },
        triage: {
          state: getState("triage"),
          indexCount: 0,
          detailCount: 0,
          lastError: null,
          lastInvalidatedAt: null,
        },
        reviews: {
          state: getState("reviews"),
          indexCount: cacheSnapshot.reviewIndex.length,
          detailCount: cacheSnapshot.reviews.length,
          lastError: null,
          lastInvalidatedAt: null,
        },
        sessions: {
          state: getState("sessions"),
          indexCount: 0,
          detailCount: 0,
          lastError: null,
          lastInvalidatedAt: null,
        },
      },
    }),
  };
}

function makeRequest(urlPath: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: init.method ?? "GET",
      headers: {
        Host: "localhost",
        "X-Kspec-Dir": tempDir,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.body,
    }),
  );
}

function setupFixtures() {
  mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });
  mkdirSync(path.join(tempDir, "modules"), { recursive: true });

  // Use kynetic 1.1 with split task storage format
  writeFileSync(
    path.join(tempDir, "kynetic.yaml"),
    `kynetic: "1.1"
task_storage:
  format: split
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
  );

  writeFileSync(
    path.join(tempDir, "modules", "test.yaml"),
    `features:
  - _ulid: "${SPEC_ULID}"
    slugs:
      - test-feature
    title: "Test Feature"
    type: feature
    description: "A test feature"
    created: "2026-01-01T00:00:00Z"
`,
  );

  // Seed task in split format (per-task directory)
  seedSplitTask(tempDir, {
    _ulid: TASK_ULID,
    slugs: ["task-test"],
    title: "Test Task",
    description: "A test task",
    status: "pending",
    type: "task",
    automation: "eligible",
    spec_ref: "@test-feature",
    created_at: "2026-01-01T00:00:00Z",
    notes: [],
  });

  writeFileSync(
    path.join(tempDir, "project.inbox.yaml"),
    `items: []
`,
  );

  writeFileSync(
    path.join(tempDir, "project.reviews.yaml"),
    `kynetic_reviews: "1.0"
reviews: []
`,
  );

  writeFileSync(
    path.join(tempDir, "project.plans.yaml"),
    `kynetic_plans: "1.0"
plans:
  - _ulid: "${PLAN_ULID}"
    slugs:
      - test-plan
    title: "Test Plan"
    content: |
      # Test Plan Content

      This is plan content written via process.stdout.write.
      It spans multiple lines to verify full capture.
    status: draft
    derived_tasks: []
    derived_specs: []
    created_at: "2026-01-01T00:00:00Z"
    notes: []
`,
  );

  writeFileSync(
    path.join(tempDir, "project.triage.yaml"),
    `kynetic_triage: "1.0"
records: []
`,
  );

  writeFileSync(
    path.join(tempDir, "kynetic.meta.yaml"),
    `kynetic_meta: "1.0"
agents: []
observations: []
workflows: []
conventions: []
`,
  );

  mkdirSync(path.join(tempDir, ".kspec-sessions"), { recursive: true });

  execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: "pipe" });
}

/**
 * (Re)build the route app under test. Timeout tests pass a short
 * commandTimeoutMs (e.g. 50ms) — never the 120s default.
 */
function rebuildApp(routeOptions: { commandTimeoutMs?: number } = {}) {
  const getEntityCache: EntityCacheAccessor = (projectPath: string) => {
    // Return mock cache only for the temp project
    if (projectPath === tempDir) return mockCache;
    return null;
  };
  const { middleware } = projectContextMiddleware();
  app = new Elysia()
    // Polyfill Elysia's `error` context function for app.handle() in
    // Node.js — same approach as tests/daemon-api/helpers.ts. The real
    // server adapter provides it natively.
    .resolve(({ set }) => ({
      error: (status: number, body: unknown) => {
        set.status = status;
        return body;
      },
    }))
    .use(middleware)
    .use(
      createCommandRoutes({
        pubsub,
        getEntityCache,
        prepareProgram: (program) => prepareProgram?.(program),
        ...routeOptions,
      }),
    );
}

describe("Daemon Command API", () => {
  beforeEach(async () => {
    prepareProgram = undefined;
    tempDir = await createTempDir("kspec-daemon-command-api-");
    initGitRepo(tempDir);
    setupFixtures();

    pubsub = new PubSubManager();
    cacheSnapshot = await buildCacheSnapshot();
    mockCache = createMockEntityCache();
    rebuildApp();
  });

  afterEach(async () => {
    process.chdir(TEST_CWD);
    await cleanupTempDir(tempDir);
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-command-endpoint
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-command-endpoint
  it("executes a read-only command and returns stdout, stderr, and exitCode", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("stdout");
    expect(body).toHaveProperty("stderr");
    expect(body).toHaveProperty("exitCode");
    expect(body.exitCode).toBe(0);
    // stdout should contain task data since we have a task in fixtures
    expect(body.stdout).toBeTruthy();
  });

  // AC: @daemon-command-api ac-no-recursive-command-proxy
  it("executes daemon-internal commands without proxying back to /api/command", async () => {
    await withInjectedCommand(
      (program) => {
        program.command("debug-proxy-decision").action(async () => {
          const {
            shouldProxyCommand,
            _resetDetectionCacheForTesting,
            _setDetectionCacheForTesting,
          } = await import("../dist/cli/daemon-proxy.js");

          const originalNoDaemon = process.env.KSPEC_NO_DAEMON;
          _resetDetectionCacheForTesting();
          _setDetectionCacheForTesting({ available: true, port: 3456 });
          delete process.env.KSPEC_NO_DAEMON;
          try {
            const result = await shouldProxyCommand({ forceDaemon: false });
            console.log(JSON.stringify(result));
          } finally {
            if (originalNoDaemon === undefined) {
              delete process.env.KSPEC_NO_DAEMON;
            } else {
              process.env.KSPEC_NO_DAEMON = originalNoDaemon;
            }
            _resetDetectionCacheForTesting();
          }
        });
      },
      async () => {
        const response = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({
            command: "debug-proxy-decision",
            args: {},
          }),
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.exitCode).toBe(0);
        const decision = JSON.parse(body.stdout);
        expect(decision).toMatchObject({
          proxy: false,
          reason: "daemon command API execution",
        });
      },
    );
  });

  // AC: @daemon-command-api ac-command-endpoint
  it("returns non-zero exitCode for unknown commands", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "nonexistent-command",
        args: {},
      }),
    });

    const body = await response.json();
    expect(body.exitCode).not.toBe(0);
    expect(body.stderr).toBeTruthy();
  });

  // AC: @daemon-command-api ac-command-endpoint
  // AC: @daemon-command-api ac-response-parity
  it("preserves exit codes for commands that call process.exit directly", async () => {
    await withInjectedCommand(
      (program) => {
        program.command("debug-exit").action(() => {
          process.exit(7);
        });
      },
      async () => {
        const response = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({
            command: "debug-exit",
            args: {},
          }),
        });

        expect(response.status).toBe(422);
        const body = await response.json();
        expect(body.exitCode).toBe(7);
        expect(body.stderr).toBe("");
      },
    );
  });

  // AC: @daemon-command-api ac-response-parity
  it("produces matching stderr for unknown commands vs direct CLI", async () => {
    // Run the same unknown command via direct CLI (subprocess) as ground truth
    const cliResult = kspec("nonexistent-command", tempDir, { expectFail: true });

    // Run the same unknown command via the daemon API
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "nonexistent-command",
        args: {},
      }),
    });

    const body = await response.json();
    expect(body.exitCode).not.toBe(0);

    // CLI stderr contains the Commander "command:*" handler output.
    // The API must produce the same error text — not a custom message.
    // Strip ANSI codes for comparison since chalk may differ between contexts.
    // oxlint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const cliStderr = stripAnsi(cliResult.stderr);
    const apiStderr = stripAnsi(body.stderr);

    expect(apiStderr).toContain("error: unknown command 'nonexistent-command'");
    expect(apiStderr).toContain(
      cliStderr.includes("Did you mean")
        ? "Did you mean"
        : "Run 'kspec help' to see available commands",
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-response-parity
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-response-parity
  it("produces the same stdout content as direct CLI execution", async () => {
    // Run the same command via the direct CLI (subprocess) as ground truth
    const cliResult = kspec("task get @task-test --json", tempDir);

    // Run the same command via the daemon API
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task get",
        args: { ref: "@task-test", json: true },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Both should produce parseable JSON with the same task data
    const cliTask = JSON.parse(cliResult.stdout);
    const apiTask = JSON.parse(body.stdout);

    // Verify key structural fields match — these are the user-visible outputs
    // that must be identical between CLI and API
    expect(apiTask.title).toBe(cliTask.title);
    expect(apiTask.status).toBe(cliTask.status);
    expect(apiTask._ulid).toBe(cliTask._ulid);
    expect(apiTask.type).toBe(cliTask.type);
    expect(apiTask.spec_ref).toBe(cliTask.spec_ref);

    // Verify stdout is returned verbatim (not trimmed) — the kspec() helper
    // trims its output, so the API result should contain that content plus
    // the trailing newline that direct CLI execution produces.
    expect(body.stdout).toContain(cliResult.stdout);
    expect(body.stdout).toMatch(/\n$/);
  });

  // AC: @daemon-command-api ac-response-parity
  it("captures process.stdout.write output (plan export uses stdout.write)", async () => {
    // plan export writes directly to process.stdout.write, not console.log.
    // This was the exact scenario the reviewer identified as broken.
    const cliResult = kspec("plan export @test-plan", tempDir);

    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "plan export",
        args: { ref: "@test-plan" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Both should contain the plan content
    expect(cliResult.stdout).toContain("# Test Plan Content");
    expect(body.stdout).toContain("# Test Plan Content");

    // API stdout contains the trimmed CLI result (kspec() helper trims)
    expect(body.stdout).toContain(cliResult.stdout);
    // API stdout is returned verbatim — not stripped
    expect(body.stdout.length).toBeGreaterThanOrEqual(cliResult.stdout.length);
  });

  // AC: @daemon-command-api ac-response-parity
  it("produces matching exitCode for failing commands via CLI and API", async () => {
    // Run a command that fails via direct CLI
    const cliResult = kspec("task get @nonexistent-task --json", tempDir, { expectFail: true });

    // Run the same command via the daemon API
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task get",
        args: { ref: "@nonexistent-task", json: true },
      }),
    });

    const body = await response.json();

    // Both should fail with non-zero exit code
    expect(cliResult.exitCode).not.toBe(0);
    expect(body.exitCode).not.toBe(0);
  });

  // AC: @daemon-command-api ac-response-parity
  // AC: @daemon-concurrent-reads ac-concurrent-cache-reads
  it("preserves pure JSON stderr for helper-based review errors under daemon execution", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "review get",
        args: { ref: "@does-not-exist", json: true },
      }),
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.exitCode).not.toBe(0);

    const parsed = JSON.parse(body.stderr);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not found");
    expect(parsed.suggestion ?? parsed.guidance ?? "").not.toContain("\nSuggestion:");
    expect(body.stderr).not.toContain("\nSuggestion:");
  });

  // AC: @daemon-command-api ac-response-parity
  it("does not emit wrapper error lines for text-mode review failures", async () => {
    // Text-mode review get for a missing ref should produce the same stderr
    // as direct CLI: just the not-found message and suggestion, without an
    // extra "Failed to get review" wrapper from the catch block.
    const cliResult = kspec("review get @does-not-exist", tempDir, { expectFail: true });

    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "review get",
        args: { ref: "@does-not-exist" },
      }),
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.exitCode).toBe(cliResult.exitCode);

    // The daemon stderr should NOT contain the wrapper error line that the
    // catch block would emit if CommandExitError were not re-thrown.
    expect(body.stderr).not.toContain("Failed to get review");

    // Stderr should match direct CLI output (both contain the not-found message)
    expect(body.stderr).toContain("not found");
  });

  // AC: @daemon-command-api ac-response-parity
  // AC: @daemon-concurrent-reads ac-concurrent-cache-reads
  it("preserves independent exit results for concurrent failing read commands", async () => {
    const [reviewResponse, taskResponse] = await Promise.all([
      makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "review get",
          args: { ref: "@does-not-exist", json: true },
        }),
      }),
      makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "task get",
          args: { ref: "@missing-task", json: true },
        }),
      }),
    ]);

    expect(reviewResponse.status).toBe(422);
    expect(taskResponse.status).toBe(422);

    const reviewBody = await reviewResponse.json();
    const taskBody = await taskResponse.json();

    expect(reviewBody.exitCode).toBe(3);
    expect(taskBody.exitCode).toBe(3);
    expect(JSON.parse(reviewBody.stderr).error).toContain("not found");
    expect(JSON.parse(taskBody.stderr).error).toContain("not found");
    expect(reviewBody.stderr).not.toContain("CommandExitError");
    expect(taskBody.stderr).not.toContain("CommandExitError");
    expect(reviewBody.stderr).not.toContain("Task not found");
    expect(taskBody.stderr).not.toContain("Review not found");
  });

  // AC: @daemon-command-api ac-cache-context-propagation
  it("installs entity cache context for in-process command execution", async () => {
    await withCacheContextCommand(async () => {
      const response = await makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "debug-cache-context",
          args: {},
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exitCode).toBe(0);

      const context = JSON.parse(body.stdout);
      expect(context).toEqual({
        hasContext: true,
        projectPath: tempDir,
        resolvedCache: true,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-mutation-cache-update
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-mutation-cache-update
  it("calls writeThrough on entity cache after successful mutating command", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task start",
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Verify writeThrough was called with all cache domains including sessions
    expect(writeThroughCalls.length).toBeGreaterThan(0);
    expect(writeThroughCalls).toContain("tasks");
    expect(writeThroughCalls).toContain("items");
    expect(writeThroughCalls).toContain("sessions");
  });

  // AC: @daemon-command-api ac-mutation-cache-update
  it("writes through all entity cache domains after mutation", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task start",
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Every CacheDomain must be written through after a mutation so
    // cross-domain side effects (e.g., session mutations, task → spec
    // status changes) are always reflected before the response.
    const expectedDomains = [
      "tasks",
      "items",
      "meta",
      "inbox",
      "plans",
      "triage",
      "reviews",
      "sessions",
    ];
    for (const domain of expectedDomains) {
      expect(writeThroughCalls).toContain(domain);
    }
  });

  // AC: @daemon-command-api ac-mutation-cache-update
  it("broadcasts WebSocket event after successful mutating command", async () => {
    const broadcastEvents: Array<{ topic: string; event: string; data: Record<string, unknown> }> =
      [];
    const origBroadcast = pubsub.broadcast.bind(pubsub);
    pubsub.broadcast = (
      topic: string,
      event: string,
      data: Record<string, unknown>,
      projectPath?: string,
    ) => {
      broadcastEvents.push({ topic, event, data });
      origBroadcast(topic, event, data, projectPath);
    };

    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task start",
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);

    // Verify WebSocket broadcast was triggered
    const commandEvent = broadcastEvents.find((e) => e.event === "command_executed");
    expect(commandEvent).toBeDefined();
    expect(commandEvent!.data.mutating).toBe(true);
    expect(commandEvent!.data.success).toBe(true);
    expect(commandEvent!.data.command).toBe("task start");
  });

  // AC: @daemon-command-api ac-mutation-cache-update
  it("does not call writeThrough for read-only commands", async () => {
    await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    // Read-only commands should not trigger cache writes
    expect(writeThroughCalls.length).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-concurrent-mutations
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-concurrent-mutations
  it("serializes concurrent mutating commands via dispatch mutex", async () => {
    const [response1, response2] = await Promise.all([
      makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "inbox add",
          args: { text: "First concurrent item", tag: ["test"] },
        }),
      }),
      makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({
          command: "inbox add",
          args: { text: "Second concurrent item", tag: ["test"] },
        }),
      }),
    ]);

    const body1 = await response1.json();
    const body2 = await response2.json();

    // Both should succeed — the dispatch mutex ensures no cwd/console corruption
    // and the file lock ensures no shadow branch conflicts
    expect(body1.exitCode).toBe(0);
    expect(body2.exitCode).toBe(0);
  });

  // AC: @daemon-concurrent-reads ac-concurrent-cache-reads
  it("allows cache-backed allowlisted read commands to overlap", async () => {
    await withDelayedCommandAction("tasks list", 80, async () => {
      const elapsed = await measureConcurrentRequests([
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "tasks list",
              args: { json: true },
            }),
          }),
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "tasks list",
              args: { json: true },
            }),
          }),
      ]);

      expect(elapsed).toBeLessThan(150);
    });
  });

  // AC: @daemon-concurrent-reads ac-concurrent-cache-reads
  it("keeps concurrent cache-backed read outputs isolated", async () => {
    const leakedStdout: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);

    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString()
            : String(chunk);
      leakedStdout.push(text);
      return originalWrite(
        chunk as Parameters<typeof process.stdout.write>[0],
        ...(rest as Parameters<typeof process.stdout.write>[1][]),
      );
    }) as typeof process.stdout.write;

    try {
      const [tasksResponse, planResponse] = await Promise.all([
        makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({
            command: "tasks list",
            args: { json: true },
          }),
        }),
        makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({
            command: "plan list",
            args: {},
          }),
        }),
      ]);

      const tasksBody = await tasksResponse.json();
      const planBody = await planResponse.json();

      expect(tasksBody.exitCode).toBe(0);
      expect(planBody.exitCode).toBe(0);
      expect(tasksBody.stdout).toContain(TASK_ULID);
      expect(tasksBody.stdout).not.toContain("Plans (1):");
      expect(planBody.stdout).toContain("Plans (1):");
      expect(planBody.stdout).not.toContain(TASK_ULID);
      expect(leakedStdout).toEqual([]);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  // AC: @daemon-concurrent-reads ac-disk-fallback-serialization
  it("serializes allowlisted reads when a required cache domain is not ready", async () => {
    mockCache = createMockEntityCache({ meta: "loading" });

    await withDelayedCommandAction("tasks list", 80, async () => {
      const elapsed = await measureConcurrentRequests([
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "tasks list",
              args: { json: true },
            }),
          }),
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "tasks list",
              args: { json: true },
            }),
          }),
      ]);

      expect(elapsed).toBeGreaterThanOrEqual(150);
    });
  });

  it("serializes read commands that are not in the cache-safe allowlist", async () => {
    await withDelayedCommandAction("tasks next", 80, async () => {
      const elapsed = await measureConcurrentRequests([
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "tasks next",
              args: {},
            }),
          }),
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "tasks next",
              args: {},
            }),
          }),
      ]);

      expect(elapsed).toBeGreaterThanOrEqual(150);
    });
  });

  // AC: @daemon-concurrent-reads ac-mutation-serialization
  it("keeps mutating commands serialized even when cache domains are ready", async () => {
    await withDelayedCommandAction("task start", 80, async () => {
      const elapsed = await measureConcurrentRequests([
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "task start",
              args: { ref: "@task-test" },
            }),
          }),
        () =>
          makeRequest("/api/command", {
            method: "POST",
            body: JSON.stringify({
              command: "task start",
              args: { ref: "@task-test" },
            }),
          }),
      ]);

      expect(elapsed).toBeGreaterThanOrEqual(150);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-batch-support
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-batch-support
  it("executes batch commands atomically", async () => {
    const response = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Batch item 1", tag: ["batch"] },
            id: "cmd-1",
          },
          {
            command: "inbox add",
            args: { text: "Batch item 2", tag: ["batch"] },
            id: "cmd-2",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.summary.total).toBe(2);
    expect(body.summary.succeeded).toBe(2);
    expect(body.summary.failed).toBe(0);

    expect(body.results[0].id).toBe("cmd-1");
    expect(body.results[0].success).toBe(true);
    expect(body.results[1].id).toBe("cmd-2");
    expect(body.results[1].success).toBe(true);
  });

  // AC: @daemon-command-api ac-batch-support
  // AC: @daemon-command-api ac-mutation-cache-update
  it("calls writeThrough on entity cache after successful batch", async () => {
    await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Cache test batch item" },
          },
        ],
      }),
    });

    // Verify writeThrough was called for all domains after the batch completed
    expect(writeThroughCalls.length).toBeGreaterThan(0);
    expect(writeThroughCalls).toContain("tasks");
    expect(writeThroughCalls).toContain("inbox");
    expect(writeThroughCalls).toContain("sessions");
  });

  // AC: @daemon-command-api ac-batch-support
  it("broadcasts WebSocket event after batch completion", async () => {
    const broadcastEvents: Array<{ topic: string; event: string; data: Record<string, unknown> }> =
      [];
    const origBroadcast = pubsub.broadcast.bind(pubsub);
    pubsub.broadcast = (
      topic: string,
      event: string,
      data: Record<string, unknown>,
      projectPath?: string,
    ) => {
      broadcastEvents.push({ topic, event, data });
      origBroadcast(topic, event, data, projectPath);
    };

    await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Broadcast test" },
          },
        ],
      }),
    });

    const batchEvent = broadcastEvents.find((e) => e.event === "batch_executed");
    expect(batchEvent).toBeDefined();
    expect(batchEvent!.data.mutating).toBe(true);
    expect(batchEvent!.data.success).toBe(true);
  });

  // AC: @daemon-command-api ac-batch-support
  it("returns 422 when a batch command fails", async () => {
    const response = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "nonexistent command",
            args: {},
          },
        ],
      }),
    });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.success).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // Trait: @trait-api-endpoint ACs
  // ───────────────────────────────────────────────────────────────────

  // AC: @trait-api-endpoint ac-1
  it("returns 200 with JSON body on successful command", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type");
    expect(contentType).toContain("json");
    const body = await response.json();
    expect(body.exitCode).toBe(0);
  });

  // AC: @trait-api-endpoint ac-3
  it("returns 400 when body is missing required command field", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        args: { ref: "@task-test" },
      }),
    });

    // Elysia validation returns 422 for schema validation failures
    expect(response.status).toBeLessThan(500);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // AC: @trait-api-endpoint ac-3
  it("returns 400 when command is empty string", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "",
        args: {},
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  // AC: @trait-api-endpoint ac-6
  it("includes X-Request-Id header in response", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
        args: { json: true },
      }),
    });

    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    // Should be a ULID-like string (26 chars)
    expect(requestId!.length).toBe(26);
  });

  // AC: @trait-api-endpoint ac-6
  it("includes X-Request-Id header on validation error responses", async () => {
    // Send a request missing the required 'command' field — triggers Elysia
    // body validation before the handler (and onBeforeHandle) runs.
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        args: { ref: "@task-test" },
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();
    expect(requestId!.length).toBe(26);
  });

  // AC: @trait-api-endpoint ac-2 — N/A: command refs are free-form strings
  // resolved by CLI, not by the daemon route. Invalid refs produce non-zero
  // exitCode with error in stderr, not 404.

  // AC: @trait-api-endpoint ac-4 — N/A: command endpoint is not a list endpoint.
  // Pagination is handled by the underlying CLI commands when applicable.

  // AC: @trait-api-endpoint ac-5 — N/A: shadow commits are made by the CLI
  // commands themselves, not by the command route.

  // AC: @trait-localhost-security ac-loopback-default — N/A: command API route handler tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
  // AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
  // AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
  // AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.

  // AC: @daemon-command-api ac-response-parity
  it("does not leak --yaml output mode between sequential requests", async () => {
    // First request uses --yaml: this sets globalOutputFormat = "yaml"
    const yamlResponse = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "validate",
        args: { warningsOk: true, yaml: true },
      }),
    });
    expect(yamlResponse.status).toBeLessThan(500);

    // Second request does NOT pass --yaml — output must be text, not YAML.
    // Before the fix, setJsonMode(false) only cleared "json" format, leaving
    // "yaml" intact. The second request would then produce YAML output.
    const textResponse = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task get",
        args: { ref: "@task-test", json: true },
      }),
    });

    expect(textResponse.status).toBe(200);
    const body = await textResponse.json();
    expect(body.exitCode).toBe(0);

    // If YAML mode leaked, stdout would be YAML (contains "---" or "key: val"
    // style lines) instead of JSON. Since we asked for --json, it must be valid JSON.
    const parsed = JSON.parse(body.stdout);
    expect(parsed._ulid).toBe(TASK_ULID);
    expect(parsed.title).toBe("Test Task");
  });

  // AC: @daemon-command-api ac-response-parity
  it("does not leak --yaml output mode into batch commands", async () => {
    // First request uses --yaml via the single-command endpoint — sets
    // globalOutputFormat = "yaml" at the process level.
    const yamlResponse = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "validate",
        args: { warningsOk: true, yaml: true },
      }),
    });
    expect(yamlResponse.status).toBeLessThan(500);

    // Second request is a BATCH with a mutating command.
    // Before the fix, dispatchCommand() in batch-exec.ts called
    // setJsonMode(false) which only clears "json" format — leaving "yaml"
    // intact from the prior request. Batch commands would then inherit
    // the leaked YAML mode, corrupting their output capture.
    const batchResponse = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Batch after yaml leak" },
            id: "batch-leak-test",
          },
        ],
      }),
    });

    expect(batchResponse.status).toBe(200);
    const body = await batchResponse.json();
    expect(body.success).toBe(true);

    const result = body.results[0];
    expect(result.success).toBe(true);

    // Verify the output doesn't contain YAML indicators that would signal
    // leaked format. The inbox add output, captured by dispatchCommand(),
    // should be plain text (not YAML-formatted).
    const output =
      typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    expect(output).not.toMatch(/^---\s*$/m);
  });

  // ───────────────────────────────────────────────────────────────────
  // AC: @daemon-command-api ac-cache-context-propagation (batch)
  // ───────────────────────────────────────────────────────────────────

  // AC: @daemon-command-api ac-cache-context-propagation
  // AC: @daemon-command-api ac-batch-support
  it("propagates entity cache context into batch command execution", async () => {
    // Verify that batch execution wraps commands in runWithEntityCache.
    // Strategy: spy on cache domain methods (getProjectConfig, getShadowInfo)
    // that are ONLY called from tryGetCachedInitContext() in the parser.
    // That function is only reached via the entityCacheStorage ALS context
    // set by runWithEntityCache. The post-batch writeThrough calls
    // cache.writeThrough(domain) but never getProjectConfig/getShadowInfo.
    // So calls to these methods prove ALS propagation into batch execution.
    const getProjectConfigSpy = vi.fn(cacheSnapshot.projectConfig);
    const getShadowInfoSpy = vi.fn(cacheSnapshot.shadowInfo);

    const spiedCache: RouteEntityCache = {
      ...mockCache,
      getProjectConfig: getProjectConfigSpy,
      getShadowInfo: getShadowInfoSpy,
    };

    const spiedAccessor: EntityCacheAccessor = (projectPath: string) => {
      if (projectPath === tempDir) return spiedCache;
      return null;
    };

    const { middleware } = projectContextMiddleware();
    app = new Elysia().use(middleware).use(
      createCommandRoutes({
        pubsub,
        getEntityCache: spiedAccessor,
        prepareProgram: (program) => prepareProgram?.(program),
      }),
    );

    const response = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [
          {
            command: "inbox add",
            args: { text: "Cache context propagation test" },
            id: "cache-ctx-check",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);

    // getProjectConfig and getShadowInfo are called by tryGetCachedInitContext()
    // inside initContext(), which only reaches the cache when runWithEntityCache
    // has installed the ALS context. The post-batch writeThrough does NOT call
    // these methods — it only calls cache.writeThrough(domain). So these spies
    // prove the batch command ran inside the entity cache ALS context.
    expect(getProjectConfigSpy).toHaveBeenCalled();
    expect(getShadowInfoSpy).toHaveBeenCalled();
  });

  // AC: @daemon-command-api ac-batch-support
  // AC: @daemon-command-api ac-response-parity
  it("captures batch process.stdout.write output without leaking to real stdout", async () => {
    // Verify that process.stdout.write output during batch execution is
    // intercepted by the route's ALS-based hook (commandExecutionStorage),
    // not forwarded to the underlying stdout stream.
    //
    // Strategy: wrap inbox add's handler to call process.stdout.write with
    // a sentinel. Spy on process.stdout._write (the underlying Writable
    // stream method) to detect whether the sentinel passes through. When
    // commandExecutionStorage is active, the route's process.stdout.write
    // hook captures the sentinel and returns true without calling the
    // original write — so _write never sees it.
    const SENTINEL = "BATCH_STDOUT_WRITE_SENTINEL_" + Date.now();
    let sentinelWritten = false;

    // Spy on the underlying stream writer to detect sentinel leaks.
    // The route module's process.stdout.write hook calls originalStdoutWrite
    // (the real write method) only when commandExecutionStorage has no active
    // store. The real write method calls _write on the stream.
    const writeSpy = vi.spyOn(process.stdout, "_write" as keyof typeof process.stdout);

    try {
      await withInjectedCommand(
        (program) => {
          const inboxCmd = findCommand(program, ["inbox", "add"]);
          const originalHandler = (
            inboxCmd as Command & {
              _actionHandler?: (...args: unknown[]) => unknown;
            }
          )._actionHandler;

          if (!originalHandler) {
            throw new Error("inbox add has no action handler");
          }

          (
            inboxCmd as Command & { _actionHandler: (...args: unknown[]) => Promise<unknown> }
          )._actionHandler = async (...args: unknown[]) => {
            // Write sentinel via process.stdout.write — the exact channel
            // that plan export and similar commands use.
            process.stdout.write(SENTINEL);
            sentinelWritten = true;

            return originalHandler(...args);
          };
        },
        async () => {
          const response = await makeRequest("/api/command/batch", {
            method: "POST",
            body: JSON.stringify({
              commands: [
                {
                  command: "inbox add",
                  args: { text: "Stdout leak test batch" },
                  id: "leak-test",
                },
              ],
            }),
          });

          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body.success).toBe(true);

          // The handler must have executed and written the sentinel.
          expect(sentinelWritten).toBe(true);

          // The sentinel must NOT have reached the underlying stream writer.
          // If commandExecutionStorage is active, the route's hook intercepts
          // the process.stdout.write call and captures it into the ALS store
          // without forwarding to originalStdoutWrite → _write.
          const sentinelReachedStream = writeSpy.mock.calls.some((call) => {
            const chunk = call[0];
            const text =
              typeof chunk === "string"
                ? chunk
                : Buffer.isBuffer(chunk)
                  ? chunk.toString()
                  : String(chunk);
            return text.includes(SENTINEL);
          });
          expect(sentinelReachedStream).toBe(false);

          // The captured process.stdout.write output must appear in the
          // batch response's stdout field — not silently dropped.
          // AC: @daemon-command-api ac-response-parity — batch includes raw stdout
          expect(body.stdout).toBeDefined();
          expect(body.stdout).toContain(SENTINEL);
        },
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  // AC: @daemon-command-api ac-batch-support
  it("does not mutate process.cwd during batch execution", async () => {
    // Verify that the batch route uses runWithWorkingDirectory (ALS-based)
    // instead of process.chdir() for working directory isolation.
    // We intercept process.chdir to detect any calls during batch execution.
    const cwdBefore = process.cwd();
    const chdirCalls: string[] = [];
    const originalChdir = process.chdir.bind(process);

    process.chdir = ((dir: string) => {
      chdirCalls.push(dir);
      return originalChdir(dir);
    }) as typeof process.chdir;

    try {
      const response = await makeRequest("/api/command/batch", {
        method: "POST",
        body: JSON.stringify({
          commands: [
            {
              command: "inbox add",
              args: { text: "CWD isolation test" },
              id: "cwd-check",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);

      // The batch route should NOT call process.chdir at all.
      // With runWithWorkingDirectory, the working directory is propagated
      // via ALS, not by mutating the global process.cwd().
      expect(chdirCalls).toEqual([]);

      // process.cwd() should be unchanged after batch execution
      expect(process.cwd()).toBe(cwdBefore);
    } finally {
      process.chdir = originalChdir;
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // Edge cases
  // ───────────────────────────────────────────────────────────────────

  it("handles command with default empty args", async () => {
    const response = await makeRequest("/api/command", {
      method: "POST",
      body: JSON.stringify({
        command: "task list",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exitCode).toBe(0);
  });

  it("rejects batch with empty commands array", async () => {
    const response = await makeRequest("/api/command/batch", {
      method: "POST",
      body: JSON.stringify({
        commands: [],
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // ───────────────────────────────────────────────────────────────────
  // Command execution timeout
  // AC: @daemon-command-api ac-command-timeout, ac-timeout-queue-bounded,
  //     ac-stuck-command-reported, ac-timeout-isolation,
  //     ac-timeout-late-completion-effects
  // ───────────────────────────────────────────────────────────────────

  describe("command execution timeout", () => {
    const SHORT_TIMEOUT_MS = 50;

    function captureBroadcasts() {
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const origBroadcast = pubsub.broadcast.bind(pubsub);
      pubsub.broadcast = (
        topic: string,
        event: string,
        data: Record<string, unknown>,
        projectPath?: string,
      ) => {
        events.push({ event, data });
        origBroadcast(topic, event, data, projectPath);
      };
      return events;
    }

    beforeEach(() => {
      rebuildApp({ commandTimeoutMs: SHORT_TIMEOUT_MS });
    });

    // AC: @daemon-command-api ac-command-timeout
    it("returns a structured 504 command_timeout error when a command exceeds its limit", async () => {
      const wedge = deferred();
      prepareProgram = (program) => {
        program.command("debug-wedge").action(() => wedge.promise);
      };

      try {
        const response = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "debug-wedge", args: {} }),
        });

        expect(response.status).toBe(504);
        const body = await response.json();
        expect(body.error).toBe("command_timeout");
        // Identifies the command and the elapsed limit
        expect(body.message).toContain("debug-wedge");
        expect(body.message).toContain(`${SHORT_TIMEOUT_MS}ms`);
        expect(body.suggestion).toContain("kspec serve status");
      } finally {
        // Resolve the wedge stub so no handles leak, and let the abandoned
        // execution drain before the next test inspects module state
        wedge.resolve();
        await new Promise((res) => setTimeout(res, 25));
      }
    });

    // AC: @daemon-command-api ac-timeout-queue-bounded
    it("bounds queued commands behind a wedge and discards them once expired", async () => {
      const wedge = deferred();
      let trackedExecuted = false;
      prepareProgram = (program) => {
        program.command("debug-wedge").action(() => wedge.promise);
        program.command("debug-tracked").action(async () => {
          trackedExecuted = true;
        });
      };

      try {
        // First command wedges the dispatch queue and times out for its caller
        const first = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "debug-wedge", args: {} }),
        });
        expect(first.status).toBe(504);

        // Second command queues behind the wedge; it must get its own
        // bounded timeout response instead of an unbounded hang.
        const queuedAt = Date.now();
        const second = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "debug-tracked", args: {} }),
        });
        const elapsed = Date.now() - queuedAt;

        expect(second.status).toBe(504);
        const body = await second.json();
        expect(body.error).toBe("command_timeout");
        // Bounded: response well within the same order as the limit, not the wedge duration
        expect(elapsed).toBeLessThan(SHORT_TIMEOUT_MS * 20);

        // Clear the wedge — the discarded command's slot frees up
        wedge.resolve();

        // Give the queue time to drain; the expired queued command must
        // never execute after its caller was already told it timed out.
        await new Promise((res) => setTimeout(res, 100));
        expect(trackedExecuted).toBe(false);
      } finally {
        wedge.resolve();
      }
    });

    // AC: @daemon-command-api ac-stuck-command-reported
    it("reports degraded command dispatch on the health surface while wedged, clearing on completion", async () => {
      const { buildHealthResponse } = await import("../dist/daemon/server.js");
      const healthApp = new Elysia().get("/api/health", () =>
        buildHealthResponse({ connections: 0, runtime: "node" }),
      );
      const getHealth = async () => {
        const response = await healthApp.handle(
          new Request("http://localhost/api/health", { headers: { Host: "localhost" } }),
        );
        expect(response.status).toBe(200);
        return response.json();
      };

      const wedge = deferred();
      prepareProgram = (program) => {
        program.command("debug-wedge").action(() => wedge.promise);
      };

      try {
        // Before the wedge: dispatch reported healthy
        const before = await getHealth();
        expect(before.command_dispatch).toEqual({ status: "ok" });

        // Wedge the queue past its limit (the 504 only returns once the
        // limit has elapsed, so the dispatch is stuck by then)
        const response = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "debug-wedge", args: {} }),
        });
        expect(response.status).toBe(504);

        // Ensure measurable time past the limit before querying health
        await new Promise((res) => setTimeout(res, 10));
        const during = await getHealth();
        expect(during.command_dispatch.status).toBe("degraded");
        expect(during.command_dispatch.stuck_command).toBe("debug-wedge");
        expect(during.command_dispatch.running_for_ms).toBeGreaterThan(SHORT_TIMEOUT_MS);
        expect(during.command_dispatch.limit_ms).toBe(SHORT_TIMEOUT_MS);

        // Completion clears the report
        wedge.resolve();
        await waitFor(async () => (await getHealth()).command_dispatch.status === "ok");
      } finally {
        wedge.resolve();
      }
    });

    // AC: @daemon-command-api ac-timeout-isolation
    it("keeps late output isolated and frees waiting commands when the slow command completes", async () => {
      const slowGate = deferred();
      prepareProgram = (program) => {
        program.command("debug-slow").action(async () => {
          await slowGate.promise;
          console.log("SLOW_OUTPUT_SENTINEL");
        });
        program.command("debug-after").action(async () => {
          console.log("AFTER_OUTPUT_SENTINEL");
        });
      };

      try {
        // Slow command times out for its caller but keeps running
        const slowResponse = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "debug-slow", args: {} }),
        });
        expect(slowResponse.status).toBe(504);

        // Queue the next command behind the still-running slow command,
        // then complete the slow command: its completion must free the
        // waiting command to proceed within its own limit.
        const afterPromise = makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "debug-after", args: {} }),
        });
        slowGate.resolve();

        const afterResponse = await afterPromise;
        expect(afterResponse.status).toBe(200);
        const afterBody = await afterResponse.json();
        expect(afterBody.exitCode).toBe(0);
        // Late output from the timed-out command is not attributed to the
        // next command's response.
        expect(afterBody.stdout).toContain("AFTER_OUTPUT_SENTINEL");
        expect(afterBody.stdout).not.toContain("SLOW_OUTPUT_SENTINEL");
      } finally {
        slowGate.resolve();
      }
    });

    // AC: @daemon-command-api ac-timeout-isolation
    it("survives a late rejection from an abandoned command", async () => {
      const rejectGate = deferred();
      prepareProgram = (program) => {
        program.command("debug-late-reject").action(() => rejectGate.promise);
      };

      try {
        const response = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "debug-late-reject", args: {} }),
        });
        expect(response.status).toBe(504);

        // Reject the abandoned execution after the caller already got 504.
        // Without the route's .catch this would surface as an unhandled
        // rejection (which kills the daemon via its fatal handlers and
        // fails this test in vitest).
        rejectGate.reject(new Error("late failure from abandoned command"));
        await new Promise((res) => setTimeout(res, 50));

        // The daemon (test process) is still alive and serving commands
        const followUp = await makeRequest("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "task list", args: { json: true } }),
        });
        expect(followUp.status).toBe(200);
      } finally {
        rejectGate.resolve(undefined);
      }
    });

    // AC: @daemon-command-api ac-timeout-late-completion-effects
    it("runs cache write-through and broadcast when a mutating command completes after its caller timed out", async () => {
      const broadcasts = captureBroadcasts();
      const gate = deferred();

      await withInjectedCommand(
        (program) => {
          const inboxCmd = findCommand(program, ["inbox", "add"]);
          const originalHandler = (
            inboxCmd as Command & { _actionHandler?: (...args: unknown[]) => unknown }
          )._actionHandler;
          if (!originalHandler) {
            throw new Error("inbox add has no action handler");
          }
          (
            inboxCmd as Command & { _actionHandler: (...args: unknown[]) => Promise<unknown> }
          )._actionHandler = async (...args: unknown[]) => {
            await gate.promise;
            return originalHandler(...args);
          };
        },
        async () => {
          try {
            // Mutating command wedges past the caller's limit
            const response = await makeRequest("/api/command", {
              method: "POST",
              body: JSON.stringify({
                command: "inbox add",
                args: { text: "Late completion test item" },
              }),
            });
            expect(response.status).toBe(504);
            const body = await response.json();
            expect(body.error).toBe("command_timeout");

            // Nothing completed yet — no effects
            expect(writeThroughCalls).toEqual([]);
            expect(broadcasts.find((e) => e.event === "command_executed")).toBeUndefined();

            // Let the abandoned execution complete successfully
            gate.resolve();

            // The same completion effects as an in-time success still occur
            await waitFor(
              () =>
                writeThroughCalls.includes("inbox") &&
                broadcasts.some((e) => e.event === "command_executed"),
            );
            const event = broadcasts.find((e) => e.event === "command_executed");
            expect(event!.data.mutating).toBe(true);
            expect(event!.data.success).toBe(true);
            expect(event!.data.command).toBe("inbox add");
            // Write-through covers all mutation-affected domains
            expect(writeThroughCalls).toContain("tasks");
            expect(writeThroughCalls).toContain("inbox");
          } finally {
            gate.resolve();
          }
        },
      );
    });

    // AC: @daemon-command-api ac-timeout-late-completion-effects
    // AC: @daemon-command-api ac-command-timeout — whole-batch bound
    it("runs batch write-through and batch_executed broadcast after a late successful batch completion", async () => {
      const broadcasts = captureBroadcasts();
      const gate = deferred();

      await withInjectedCommand(
        (program) => {
          const inboxCmd = findCommand(program, ["inbox", "add"]);
          const originalHandler = (
            inboxCmd as Command & { _actionHandler?: (...args: unknown[]) => unknown }
          )._actionHandler;
          if (!originalHandler) {
            throw new Error("inbox add has no action handler");
          }
          (
            inboxCmd as Command & { _actionHandler: (...args: unknown[]) => Promise<unknown> }
          )._actionHandler = async (...args: unknown[]) => {
            await gate.promise;
            return originalHandler(...args);
          };
        },
        async () => {
          try {
            const response = await makeRequest("/api/command/batch", {
              method: "POST",
              body: JSON.stringify({
                commands: [
                  {
                    command: "inbox add",
                    args: { text: "Late batch completion item" },
                    id: "late-batch-1",
                  },
                ],
              }),
            });

            // The whole batch is one atomic dispatch with one bound
            expect(response.status).toBe(504);
            const body = await response.json();
            expect(body.error).toBe("command_timeout");
            expect(body.message).toContain("inbox add");

            expect(writeThroughCalls).toEqual([]);
            expect(broadcasts.find((e) => e.event === "batch_executed")).toBeUndefined();

            gate.resolve();

            await waitFor(
              () =>
                writeThroughCalls.includes("inbox") &&
                broadcasts.some((e) => e.event === "batch_executed"),
            );
            const event = broadcasts.find((e) => e.event === "batch_executed");
            expect(event!.data.mutating).toBe(true);
            expect(event!.data.success).toBe(true);
            expect(event!.data.total).toBe(1);
            expect(event!.data.succeeded).toBe(1);
          } finally {
            gate.resolve();
          }
        },
      );
    });

    // AC: @daemon-command-api ac-command-timeout — commands completing in
    // time are unaffected by the timeout machinery
    it("returns normal results for commands that complete within the limit", async () => {
      prepareProgram = (program) => {
        program.command("debug-quick").action(async () => {
          console.log("QUICK_OUTPUT");
        });
      };

      const response = await makeRequest("/api/command", {
        method: "POST",
        body: JSON.stringify({ command: "debug-quick", args: {} }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.exitCode).toBe(0);
      expect(body.stdout).toContain("QUICK_OUTPUT");
    });
  });
});
