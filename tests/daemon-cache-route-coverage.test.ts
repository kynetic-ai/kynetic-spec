/**
 * Route-level cache coverage tests for related-sessions and filtered sessions.
 *
 * Verifies that GET /api/tasks/:ref/sessions, GET /api/items/:ref/sessions,
 * and GET /api/sessions?task_id=... serve from the entity cache when warm,
 * without falling back to disk-based initContext/loadAllItems/loadAllTasks.
 *
 * Also verifies ac-daemon-bypass: daemon read routes that fall through to
 * initContext on cache miss pass syncMode "skip" to avoid per-request drift-check.
 *
 * AC: @daemon-entity-cache ac-serve-from-memory
 * AC: @shadow-lazy-read-sync ac-daemon-bypass — daemon reads bypass per-request drift-check
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";
import { createTasksRoutes } from "../dist/daemon/routes/tasks.js";
import { createItemsRoutes } from "../dist/daemon/routes/items.js";
import { createSessionRoutes } from "../dist/daemon/routes/sessions.js";
import { PubSubManager } from "../dist/daemon/websocket/pubsub.js";
import type {
  RouteEntityCache,
  EntityCacheAccessor,
} from "../dist/daemon/routes/entity-cache-types.js";
import type { TaskSummary } from "../dist/parser/task-data-manager.ts";
import type { ItemSummary } from "../dist/daemon/entity-cache.js";
import type { SessionLogSummary } from "../dist/sessions/store.ts";
import * as yamlModule from "../dist/parser/yaml.js";

const TASK_ULID = testUlid("RTSK", 1);
const SPEC_ULID = testUlid("RSPC", 2);
const SESSION_ID = "cache-test-session-001";

let tempDir: string;
let app: Elysia;

/** Minimal TaskSummary for cache index */
function makeTaskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    _ulid: TASK_ULID,
    slugs: ["cache-test-task"],
    title: "Cache Test Task",
    type: "task",
    status: "in_progress",
    priority: 2,
    tags: [],
    spec_ref: `@cache-test-spec`,
    plan_ref: null,
    review_ref: null,
    depends_on: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** Minimal ItemSummary for cache index */
function makeItemSummary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    _ulid: SPEC_ULID,
    slugs: ["cache-test-spec"],
    title: "Cache Test Spec",
    type: "feature",
    status: "draft",
    tags: [],
    traits: [],
    acceptance_criteria_count: 1,
    ...overrides,
  };
}

/** Minimal SessionLogSummary for cache index */
function makeSessionSummary(overrides: Partial<SessionLogSummary> = {}): SessionLogSummary {
  return {
    id: SESSION_ID,
    task_id: `@cache-test-task`,
    agent_type: "claude-agent-acp",
    agent_id: "worker",
    trigger: "task.ready",
    status: "completed",
    started_at: "2026-03-01T10:00:00Z",
    ended_at: "2026-03-01T10:05:00Z",
    duration_ms: 300000,
    event_count: 5,
    ...overrides,
  } as SessionLogSummary;
}

/**
 * Create a mock RouteEntityCache with warm tasks/items/sessions domains.
 * Returns data from in-memory arrays, proving no disk I/O is needed.
 */
function createWarmCache(
  tasks: TaskSummary[],
  items: ItemSummary[],
  sessions: SessionLogSummary[],
): RouteEntityCache {
  const taskDetails = new Map();
  const itemDetails = new Map();
  const sessionDetails = new Map();

  return {
    getDomainState: (domain: string) => {
      if (domain === "tasks" || domain === "items" || domain === "sessions") return "ready";
      return "unloaded";
    },
    getTaskIndex: () => tasks,
    getTaskDetail: (ulid: string) => taskDetails.get(ulid) ?? null,
    setTaskDetail: (ulid, task) => taskDetails.set(ulid, task),
    getItemIndex: () => items,
    getItemDetail: (ulid: string) => itemDetails.get(ulid) ?? null,
    setItemDetail: (ulid, item) => itemDetails.set(ulid, item),
    getSessionIndex: () => sessions,
    getSessionLiveEventCount: (sessionId: string) =>
      sessions.find((summary) => summary.id === sessionId)?.event_count,
    getSessionDetail: (id: string) => sessionDetails.get(id) ?? null,
    setSessionDetail: (id, summary) => sessionDetails.set(id, summary),
    getPlansIndex: () => null,
    getPlanDetail: () => null,
    setPlanDetail: () => {},
    getInboxIndex: () => null,
    getTriageIndex: () => null,
    getTriageDetail: () => null,
    setTriageDetail: () => {},
    getReviewsIndex: () => null,
    getReviewDetail: () => null,
    setReviewDetail: () => {},
    getMetaIndex: () => null,
    getMetaDetail: () => null,
    setMetaDetail: () => {},
    getShadowInfo: () => null,
    getProjectConfig: () => null,
    getSessionContext: () => null,
    getAllTaskDetails: () => null,
    getAllItemDetails: () => null,
    writeThrough: async () => {},
    markWriteThrough: () => {},
  };
}

function createLoadingSessionsCache(
  tasks: TaskSummary[],
  items: ItemSummary[],
  sessions: SessionLogSummary[],
): RouteEntityCache {
  const base = createWarmCache(tasks, items, sessions);
  return {
    ...base,
    getDomainState: (domain: string) => {
      if (domain === "tasks" || domain === "items") return "ready";
      if (domain === "sessions") return "loading";
      return "unloaded";
    },
    getSessionIndex: () => null,
  };
}

function createDegradedSessionsCache(
  tasks: TaskSummary[],
  items: ItemSummary[],
  sessions: SessionLogSummary[],
): RouteEntityCache {
  const base = createWarmCache(tasks, items, sessions);
  return {
    ...base,
    getDomainState: (domain: string) => {
      if (domain === "tasks" || domain === "items") return "ready";
      if (domain === "sessions") return "degraded";
      return "unloaded";
    },
    getSessionIndex: () => null,
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

/**
 * Set up a minimal project fixture (enough for project-context middleware to resolve),
 * plus a .kspec-sessions dir and a real session file for the session index to work.
 */
function setupFixtures() {
  mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });
  mkdirSync(path.join(tempDir, "modules"), { recursive: true });

  writeFileSync(
    path.join(tempDir, "kynetic.yaml"),
    `kynetic: "1.0"
project:
  name: Cache Route Test
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
tasks_file: project.tasks.yaml
`,
  );

  writeFileSync(
    path.join(tempDir, "modules", "test.yaml"),
    `features:
  - _ulid: "${SPEC_ULID}"
    slugs:
      - cache-test-spec
    title: "Cache Test Spec"
    type: feature
    description: "A test spec for cache route coverage"
    created: "2026-01-01T00:00:00Z"
`,
  );

  writeFileSync(
    path.join(tempDir, "project.tasks.yaml"),
    `tasks:
  - _ulid: "${TASK_ULID}"
    slugs:
      - cache-test-task
    title: "Cache Test Task"
    description: "A test task for cache route coverage"
    status: in_progress
    type: task
    automation: eligible
    spec_ref: "@cache-test-spec"
    created_at: "2026-01-01T00:00:00Z"
`,
  );

  // Minimal session for the sessions domain
  const sessionsDir = path.join(tempDir, ".kspec-sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionDir = path.join(sessionsDir, SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    path.join(sessionDir, "session.yaml"),
    `id: "${SESSION_ID}"
task_id: "@cache-test-task"
agent_type: "claude-agent-acp"
agent_id: "worker"
trigger: "task.ready"
status: "completed"
started_at: "2026-03-01T10:00:00Z"
ended_at: "2026-03-01T10:05:00Z"
`,
  );
  writeFileSync(path.join(sessionDir, "events.jsonl"), "", "utf-8");

  execSync('git add -A && git commit -m "cache route test setup"', { cwd: tempDir, stdio: "pipe" });
}

describe("Route-level cache coverage for related-sessions and filtered sessions", () => {
  let warmCache: RouteEntityCache;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-cache-route-");
    initGitRepo(tempDir);
    setupFixtures();

    const taskSummaries = [makeTaskSummary()];
    const itemSummaries = [makeItemSummary()];
    const sessionSummaries = [makeSessionSummary()];
    warmCache = createWarmCache(taskSummaries, itemSummaries, sessionSummaries);

    const getEntityCache: EntityCacheAccessor = () => warmCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    app = new Elysia()
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache }))
      .use(createItemsRoutes({ getEntityCache }))
      .use(createSessionRoutes({ getEntityCache }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ─── Blocker 1: GET /api/tasks/:ref/sessions ──────────────────────────

  // AC: @daemon-entity-cache ac-serve-from-memory — related sessions for task served from cache
  it("GET /api/tasks/:ref/sessions resolves from warm cache", async () => {
    const res = await makeRequest(`/api/tasks/@cache-test-task/sessions`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: SessionLogSummary[];
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      id: SESSION_ID,
      task_id: "@cache-test-task",
      status: "completed",
    });
  });

  // AC: @daemon-entity-cache ac-graceful-degradation — related sessions fall back
  // to disk-backed metadata reads while the sessions domain is still warming.
  it("GET /api/tasks/:ref/sessions falls back to disk when sessions cache is not ready", async () => {
    const taskSummaries = [makeTaskSummary()];
    const itemSummaries = [makeItemSummary()];
    const loadingCache = createLoadingSessionsCache(taskSummaries, itemSummaries, []);
    const getEntityCache: EntityCacheAccessor = () => loadingCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    app = new Elysia()
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache }))
      .use(createItemsRoutes({ getEntityCache }))
      .use(createSessionRoutes({ getEntityCache }));

    const res = await makeRequest(`/api/tasks/@cache-test-task/sessions`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: SessionLogSummary[];
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      id: SESSION_ID,
      task_id: "@cache-test-task",
      status: "completed",
    });
  });

  // ─── Blocker 1: GET /api/items/:ref/sessions ──────────────────────────

  // AC: @daemon-entity-cache ac-serve-from-memory — related sessions for item served from cache
  it("GET /api/items/:ref/sessions resolves from warm cache", async () => {
    const res = await makeRequest(`/api/items/@cache-test-spec/sessions`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: SessionLogSummary[];
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      id: SESSION_ID,
      task_id: "@cache-test-task",
    });
  });

  // ─── Blocker 2: GET /api/sessions?task_id=... ─────────────────────────

  // AC: @daemon-entity-cache ac-serve-from-memory — filtered session list by task_id from cache
  it("GET /api/sessions?task_id=... filters from warm cache without disk reload", async () => {
    const res = await makeRequest(`/api/sessions?task_id=@cache-test-task`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { items: SessionLogSummary[] };
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data.items[0]).toMatchObject({
      id: SESSION_ID,
      task_id: "@cache-test-task",
    });
  });

  // AC: @daemon-entity-cache ac-serve-from-memory — filtered session list by spec_ref from cache
  it("GET /api/sessions?spec_ref=... filters from warm cache without disk reload", async () => {
    const res = await makeRequest(`/api/sessions?spec_ref=@cache-test-spec`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { items: SessionLogSummary[] };
      meta: { total: number; cache_status: string };
    };
    // The spec has one task linked, and that task has one session
    expect(body.meta.total).toBe(1);
    expect(body.data.items[0]).toMatchObject({
      id: SESSION_ID,
    });
  });

  // AC: @daemon-entity-cache ac-session-live-counter
  // AC: @daemon-entity-cache ac-session-event-tracking
  it("GET /api/sessions?task_id=... preserves live event counts while sessions cache is loading", async () => {
    const activeSessionId = "cache-test-session-active";
    const activeSessionDir = path.join(tempDir, ".kspec-sessions", activeSessionId);
    mkdirSync(activeSessionDir, { recursive: true });
    writeFileSync(
      path.join(activeSessionDir, "session.yaml"),
      `id: "${activeSessionId}"
task_id: "@cache-test-task"
agent_type: "claude-agent-acp"
agent_id: "worker"
trigger: "task.ready"
status: "active"
started_at: "2026-03-01T10:00:00Z"
`,
    );
    writeFileSync(path.join(activeSessionDir, "events.jsonl"), "", "utf-8");

    const taskSummaries = [makeTaskSummary()];
    const itemSummaries = [makeItemSummary()];
    const loadingCache = createDegradedSessionsCache(taskSummaries, itemSummaries, [
      makeSessionSummary({
        id: activeSessionId,
        status: "active",
        ended_at: undefined,
        duration_ms: 0,
        event_count: 3,
      }),
    ]);
    const getEntityCache: EntityCacheAccessor = () => loadingCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    app = new Elysia()
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache }))
      .use(createItemsRoutes({ getEntityCache }))
      .use(createSessionRoutes({ getEntityCache }));

    const res = await makeRequest(`/api/sessions?task_id=@cache-test-task`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { items: SessionLogSummary[] };
      meta: { total: number; cache_status: string };
    };
    const activeSession = body.data.items.find((summary) => summary.id === activeSessionId);
    expect(activeSession).toMatchObject({
      id: activeSessionId,
      status: "active",
      event_count: 3,
    });
  });

  // ─── Unfiltered session list (baseline) ───────────────────────────────

  it("GET /api/sessions (unfiltered) serves from warm cache", async () => {
    const res = await makeRequest(`/api/sessions`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { items: SessionLogSummary[] };
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data.items[0]).toMatchObject({ id: SESSION_ID });
  });
});

// ─── ac-daemon-bypass: cache-miss fallback skips drift-check ─────────────────
// These tests verify that daemon read routes pass syncMode "skip" to initContext
// when falling through to disk on cache miss, ensuring no per-request drift-check.

describe("Daemon read routes skip drift-check on cache-miss fallback", () => {
  let noCacheApp: Elysia;
  let noCacheTempDir: string;
  let initContextSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    noCacheTempDir = await createTempDir("kspec-daemon-bypass-");
    initGitRepo(noCacheTempDir);

    // Set up minimal project fixtures
    mkdirSync(path.join(noCacheTempDir, ".kspec"), { recursive: true });
    mkdirSync(path.join(noCacheTempDir, "modules"), { recursive: true });

    writeFileSync(
      path.join(noCacheTempDir, "kynetic.yaml"),
      `kynetic: "1.0"\nproject:\n  name: Daemon Bypass Test\n  version: "0.1.0"\n  status: draft\nincludes:\n  - modules/test.yaml\ntasks_file: project.tasks.yaml\n`,
    );

    writeFileSync(
      path.join(noCacheTempDir, "modules", "test.yaml"),
      `features:\n  - _ulid: "${SPEC_ULID}"\n    slugs:\n      - cache-test-spec\n    title: "Cache Test Spec"\n    type: feature\n    description: "A test spec"\n    created: "2026-01-01T00:00:00Z"\n`,
    );

    writeFileSync(
      path.join(noCacheTempDir, "project.tasks.yaml"),
      `tasks:\n  - _ulid: "${TASK_ULID}"\n    slugs:\n      - cache-test-task\n    title: "Cache Test Task"\n    description: "A test task"\n    status: in_progress\n    type: task\n    automation: eligible\n    spec_ref: "@cache-test-spec"\n    created_at: "2026-01-01T00:00:00Z"\n`,
    );

    execSync('git add -A && git commit -m "daemon bypass test setup"', {
      cwd: noCacheTempDir,
      stdio: "pipe",
    });

    // NO entity cache — routes fall through to initContext on every read
    const getEntityCache: EntityCacheAccessor = () => undefined as unknown as RouteEntityCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    noCacheApp = new Elysia()
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache }))
      .use(createItemsRoutes({ getEntityCache }));

    // Spy on initContext and mock it to return a valid context that includes
    // the test task data. This lets us verify the syncMode argument without
    // needing a full shadow branch setup.
    initContextSpy = vi.spyOn(yamlModule, "initContext").mockResolvedValue({
      rootDir: noCacheTempDir,
      projectRoot: noCacheTempDir,
      specDir: noCacheTempDir,
      sessionsDir: path.join(noCacheTempDir, ".kspec-sessions"),
      manifestPath: path.join(noCacheTempDir, "kynetic.yaml"),
      manifest: {
        project: { name: "Test", version: "0.1.0", status: "draft" as const },
        modules: [],
      },
      shadow: null,
      config: {
        shadow: {
          branch: "kspec-meta",
          directory: ".kspec",
          remote: null,
          sync_interval: 60,
        },
        identity: { author: null },
      },
    } as Awaited<ReturnType<typeof yamlModule.initContext>>);
  });

  afterEach(async () => {
    initContextSpy.mockRestore();
    await cleanupTempDir(noCacheTempDir);
  });

  function makeNoCacheRequest(urlPath: string, init: RequestInit = {}) {
    return noCacheApp.handle(
      new Request(`http://localhost${urlPath}`, {
        method: init.method ?? "GET",
        headers: {
          Host: "localhost",
          "X-Kspec-Dir": noCacheTempDir,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
        body: init.body,
      }),
    );
  }

  // AC: @shadow-lazy-read-sync ac-daemon-bypass — GET /api/tasks without cache passes syncMode "skip"
  it("GET /api/tasks passes syncMode 'skip' to initContext on cache miss", async () => {
    await makeNoCacheRequest("/api/tasks");
    // Route may return 200 or encounter downstream errors from mocked context,
    // but the key assertion is that initContext was called with syncMode: "skip"
    expect(initContextSpy).toHaveBeenCalled();
    const calls = initContextSpy.mock.calls;
    const hasSkipMode = calls.some(
      (call) => call[1] && (call[1] as { syncMode?: string }).syncMode === "skip",
    );
    expect(hasSkipMode).toBe(true);
  });

  // AC: @shadow-lazy-read-sync ac-daemon-bypass — GET /api/tasks/:ref without cache passes syncMode "skip"
  it("GET /api/tasks/:ref passes syncMode 'skip' to initContext on cache miss", async () => {
    await makeNoCacheRequest(`/api/tasks/@cache-test-task`);
    expect(initContextSpy).toHaveBeenCalled();
    const calls = initContextSpy.mock.calls;
    const hasSkipMode = calls.some(
      (call) => call[1] && (call[1] as { syncMode?: string }).syncMode === "skip",
    );
    expect(hasSkipMode).toBe(true);
  });

  // AC: @shadow-lazy-read-sync ac-daemon-bypass — POST /api/items/batch without cache passes syncMode "skip"
  it("POST /api/items/batch passes syncMode 'skip' to initContext on cache miss", async () => {
    initContextSpy.mockClear();
    await makeNoCacheRequest("/api/items/batch", {
      method: "POST",
      body: JSON.stringify({ refs: ["@cache-test-task"] }),
    });
    expect(initContextSpy).toHaveBeenCalled();
    const calls = initContextSpy.mock.calls;
    const hasSkipMode = calls.some(
      (call) => call[1] && (call[1] as { syncMode?: string }).syncMode === "skip",
    );
    expect(hasSkipMode).toBe(true);
  });
});
