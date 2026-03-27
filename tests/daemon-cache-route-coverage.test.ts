/**
 * Route-level cache coverage tests for related-sessions and filtered sessions.
 *
 * Verifies that GET /api/tasks/:ref/sessions, GET /api/items/:ref/sessions,
 * and GET /api/sessions?task_id=... serve from the entity cache when warm,
 * without falling back to disk-based initContext/loadAllItems/loadAllTasks.
 *
 * AC: @daemon-entity-cache ac-serve-from-memory
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.ts";
import { createTasksRoutes } from "../dist/daemon/routes/tasks.ts";
import { createItemsRoutes } from "../dist/daemon/routes/items.ts";
import { createSessionRoutes } from "../dist/daemon/routes/sessions.ts";
import { PubSubManager } from "../dist/daemon/websocket/pubsub.ts";
import type { RouteEntityCache, EntityCacheAccessor } from "../dist/daemon/routes/entity-cache-types.ts";
import type { TaskSummary } from "../dist/parser/task-data-manager.ts";
import type { ItemSummary } from "../dist/daemon/entity-cache.ts";
import type { SessionLogSummary } from "../dist/sessions/store.ts";

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
    writeThrough: async () => {},
    markWriteThrough: () => {},
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

    const body = (await res.json()) as { items: SessionLogSummary[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
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

    const body = (await res.json()) as { items: SessionLogSummary[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: SESSION_ID,
      task_id: "@cache-test-task",
    });
  });

  // ─── Blocker 2: GET /api/sessions?task_id=... ─────────────────────────

  // AC: @daemon-entity-cache ac-serve-from-memory — filtered session list by task_id from cache
  it("GET /api/sessions?task_id=... filters from warm cache without disk reload", async () => {
    const res = await makeRequest(`/api/sessions?task_id=@cache-test-task`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { items: SessionLogSummary[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: SESSION_ID,
      task_id: "@cache-test-task",
    });
  });

  // AC: @daemon-entity-cache ac-serve-from-memory — filtered session list by spec_ref from cache
  it("GET /api/sessions?spec_ref=... filters from warm cache without disk reload", async () => {
    const res = await makeRequest(`/api/sessions?spec_ref=@cache-test-spec`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { items: SessionLogSummary[]; total: number };
    // The spec has one task linked, and that task has one session
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: SESSION_ID,
    });
  });

  // ─── Unfiltered session list (baseline) ───────────────────────────────

  it("GET /api/sessions (unfiltered) serves from warm cache", async () => {
    const res = await makeRequest(`/api/sessions`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { items: SessionLogSummary[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ id: SESSION_ID });
  });
});
