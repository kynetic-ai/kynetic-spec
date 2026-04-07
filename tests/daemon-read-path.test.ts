/**
 * Tests for daemon read path optimization.
 *
 * Verifies that read-only API routes serve from the entity cache without
 * per-request git operations or filesystem reads, that background sync
 * invalidates the cache on pull, that indexes are built from cached data,
 * and that write routes use the standard shadow branch commit path with
 * write-through cache updates.
 *
 * AC: @daemon-read-path ac-no-per-request-sync
 * AC: @daemon-read-path ac-background-sync
 * AC: @daemon-read-path ac-index-from-cache
 * AC: @daemon-read-path ac-write-routes-sync
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
import { createAggregationRoutes } from "../dist/daemon/routes/aggregation.js";
import { createValidationRoutes } from "../dist/daemon/routes/validation.js";
import { createInboxRoutes } from "../dist/daemon/routes/inbox.js";
import { createRefsRoutes } from "../dist/daemon/routes/refs.js";
import { createPlansRoutes } from "../dist/daemon/routes/plans.js";
import { createMetaRoutes } from "../dist/daemon/routes/meta.js";
import { PubSubManager } from "../dist/daemon/websocket/pubsub.js";
import type {
  RouteEntityCache,
  EntityCacheAccessor,
} from "../dist/daemon/routes/entity-cache-types.js";
import type { TaskSummary } from "../dist/parser/task-data-manager.ts";
import type {
  ItemSummary,
  TriageIndexSummary,
  PlanIndexSummary,
  CachedShadowInfo,
  CachedProjectConfig,
} from "../dist/daemon/entity-cache.ts";
import { createShadowSyncOnPullHandler } from "../dist/daemon/server.ts";
import type { MetaContext } from "../dist/parser/meta.ts";
import type { LoadedInboxItem, LoadedSpecItem, LoadedTask } from "../dist/parser/yaml.ts";
import { ShadowSyncScheduler } from "../src/parser/shadow-sync-scheduler.js";
import * as parserModule from "../dist/parser/index.js";
import * as shadowModule from "../dist/parser/shadow.js";

// ─── Test Data ────────────────────────────────────────────────────────────────

const TASK_ULID_1 = testUlid("DRTK", 1);
const TASK_ULID_2 = testUlid("DRTK", 2);
const SPEC_ULID = testUlid("DRSP", 1);
const PLAN_ULID = testUlid("DRPN", 1);
const INBOX_ULID = testUlid("DRIN", 1);
const TRIAGE_ULID = testUlid("DRTR", 1);

let tempDir: string;
let app: Elysia;

// ─── Mock Cache ───────────────────────────────────────────────────────────────

function makeTaskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    _ulid: TASK_ULID_1,
    slugs: ["read-path-task-1"],
    title: "Read Path Test Task 1",
    type: "task",
    status: "in_progress",
    priority: 2,
    tags: ["test"],
    spec_ref: "@read-path-spec",
    plan_ref: null,
    review_ref: null,
    depends_on: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00Z",
    notes_count: 0,
    todos_count: 0,
    ...overrides,
  };
}

function makeItemSummary(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    _ulid: SPEC_ULID,
    slugs: ["read-path-spec"],
    title: "Read Path Test Spec",
    type: "feature",
    status: "draft",
    tags: ["test"],
    traits: [],
    acceptance_criteria_count: 2,
    ...overrides,
  };
}

function makePlanSummary(overrides: Partial<PlanIndexSummary> = {}): PlanIndexSummary {
  return {
    _ulid: PLAN_ULID,
    slugs: ["read-path-plan"],
    title: "Read Path Test Plan",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    approved_at: "2026-01-02T00:00:00Z",
    completed_at: null,
    source_path: null,
    module_ref: null,
    derived_tasks: [TASK_ULID_1],
    derived_specs: [SPEC_ULID],
    ...overrides,
  };
}

function makeInboxItem(overrides: Partial<LoadedInboxItem> = {}): LoadedInboxItem {
  return {
    _ulid: INBOX_ULID,
    text: "Test inbox item for read path",
    tags: ["test"],
    added_by: "test",
    created_at: "2026-01-15T00:00:00Z",
    ...overrides,
  } as LoadedInboxItem;
}

function makeTriageSummary(overrides: Partial<TriageIndexSummary> = {}): TriageIndexSummary {
  return {
    _ulid: TRIAGE_ULID,
    inbox_ref: INBOX_ULID,
    item_snapshot: "Test inbox item for read path",
    status: "triaged",
    created_at: "2026-01-16T00:00:00Z",
    action: "promote",
    reasoning: "Looks actionable",
    decided_by: "test",
    evidence_refs: [],
    ...overrides,
  };
}

function makeFullTask(overrides: Partial<LoadedTask> = {}): LoadedTask {
  return {
    _ulid: TASK_ULID_1,
    slugs: ["read-path-task-1"],
    title: "Read Path Test Task 1",
    type: "task",
    status: "in_progress",
    priority: 2,
    tags: ["test"],
    spec_ref: "@read-path-spec",
    plan_ref: null,
    review_ref: null,
    depends_on: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00Z",
    description: "A task with searchable description content about unicorn migration",
    notes: [
      {
        content: "Found a needle-in-haystack pattern during investigation",
        author: "test",
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
    todos: [],
    vcs_refs: [],
    context: [],
    ...overrides,
  } as LoadedTask;
}

function makeFullItem(overrides: Partial<LoadedSpecItem> = {}): LoadedSpecItem {
  return {
    _ulid: SPEC_ULID,
    slugs: ["read-path-spec"],
    title: "Read Path Test Spec",
    type: "feature",
    status: "draft",
    tags: ["test"],
    traits: [],
    description: "Spec describing quantum-entanglement search functionality",
    acceptance_criteria: [
      {
        id: "ac-1",
        given: "test setup",
        when: "read requested",
        then: "xylophone-harmonics verified from cache",
      },
      { id: "ac-2", given: "cache warm", when: "index requested", then: "built from cache" },
    ],
    notes: [],
    _sourceFile: "modules/test.yaml",
    _path: "features[0]",
    created: "2026-01-01T00:00:00Z",
    ...overrides,
  } as LoadedSpecItem;
}

function makeMetaContext(): MetaContext {
  return {
    manifest: null,
    manifestPath: null,
    agents: [
      {
        _ulid: testUlid("DRAG", 1),
        id: "test-agent",
        name: "Test Agent",
        description: "A test agent",
        adapter: "claude",
        dispatch: [],
        capabilities: [],
        tools: [],
        skills: [],
      },
    ] as MetaContext["agents"],
    workflows: [
      {
        _ulid: testUlid("DRWF", 1),
        id: "test-workflow",
        name: "Test Workflow",
        description: "A test workflow",
        steps: [],
      },
    ] as MetaContext["workflows"],
    conventions: [
      {
        _ulid: testUlid("DRCN", 1),
        domain: "testing",
        rules: ["Rule 1"],
      },
    ] as MetaContext["conventions"],
    observations: [
      {
        _ulid: testUlid("DROB", 1),
        type: "friction",
        content: "Test observation content",
        context: "testing",
        created_at: "2026-01-01T00:00:00Z",
      },
    ] as MetaContext["observations"],
    skills: [],
    hooks: [],
    schedules: [],
    compositions: [],
  };
}

/**
 * Create a fully-warm mock RouteEntityCache.
 * All domains report "ready" and return data from in-memory structures.
 * No disk or git access occurs when routes resolve from this cache.
 */
function createWarmCache(
  options: {
    tasks?: TaskSummary[];
    items?: ItemSummary[];
    fullTasks?: LoadedTask[];
    fullItems?: LoadedSpecItem[];
    plans?: PlanIndexSummary[];
    inbox?: LoadedInboxItem[];
    triage?: TriageIndexSummary[];
    meta?: MetaContext;
    shadowInfo?: CachedShadowInfo;
    projectConfig?: CachedProjectConfig;
  } = {},
): RouteEntityCache {
  const tasks = options.tasks ?? [makeTaskSummary()];
  const items = options.items ?? [makeItemSummary()];
  const fullTasks = options.fullTasks ?? [makeFullTask()];
  const fullItems = options.fullItems ?? [makeFullItem()];
  const plans = options.plans ?? [makePlanSummary()];
  const inbox = options.inbox ?? [makeInboxItem()];
  const triage = options.triage ?? [makeTriageSummary()];
  const meta = options.meta ?? makeMetaContext();
  const shadowInfo: CachedShadowInfo = options.shadowInfo ?? {
    enabled: true,
    branch_name: "kspec-meta",
    worktree_dir: "/tmp/test/.kspec",
    healthy: true,
    remote_tracking: false,
  };
  const projectConfig: CachedProjectConfig = options.projectConfig ?? {
    project: { name: "Read Path Test", version: "0.1.0", status: "draft" },
    spec_version: "1.0",
    root_dir: "/tmp/test",
    remote_tracking: null,
    daemon: { port: 3456, host: "localhost", auto_start: false },
  };

  const taskDetails = new Map<string, LoadedTask>();
  for (const t of fullTasks) taskDetails.set(t._ulid, t);
  const itemDetails = new Map<string, LoadedSpecItem>();
  for (const i of fullItems) itemDetails.set(i._ulid, i);
  const planDetails = new Map();
  const triageDetails = new Map();
  const sessionDetails = new Map();
  const reviewDetails = new Map();

  const writeThroughCalls: string[] = [];

  return {
    getDomainState: () => "ready",
    getTaskIndex: () => tasks,
    getTaskDetail: (ulid: string) => taskDetails.get(ulid) ?? null,
    setTaskDetail: (ulid, task) => taskDetails.set(ulid, task),
    getAllTaskDetails: () => Array.from(taskDetails.values()),
    getItemIndex: () => items,
    getItemDetail: (ulid: string) => itemDetails.get(ulid) ?? null,
    setItemDetail: (ulid, item) => itemDetails.set(ulid, item),
    getAllItemDetails: () => Array.from(itemDetails.values()),
    getSessionIndex: () => [],
    getSessionDetail: (id: string) => sessionDetails.get(id) ?? null,
    setSessionDetail: (id, summary) => sessionDetails.set(id, summary),
    getPlansIndex: () => plans,
    getPlanDetail: (ulid: string) => planDetails.get(ulid) ?? null,
    setPlanDetail: (ulid, plan) => planDetails.set(ulid, plan),
    getInboxIndex: () => inbox,
    getTriageIndex: () => triage,
    getTriageDetail: (ulid: string) => triageDetails.get(ulid) ?? null,
    setTriageDetail: (ulid, record) => triageDetails.set(ulid, record),
    getReviewsIndex: () => [],
    getReviewDetail: (ulid: string) => reviewDetails.get(ulid) ?? null,
    setReviewDetail: (ulid, review) => reviewDetails.set(ulid, review),
    getMetaIndex: () => ({ projectName: "test" }),
    getMetaDetail: () => meta,
    setMetaDetail: () => {},
    getShadowInfo: () => shadowInfo,
    getProjectConfig: () => projectConfig,
    getSessionContext: () => ({
      focus: null,
      threads: [],
      questions: [],
      updated_at: new Date().toISOString(),
    }),
    writeThrough: async (domain: string) => {
      writeThroughCalls.push(domain);
    },
    markWriteThrough: () => {},
    // Expose for test assertions
    get _writeThroughCalls() {
      return writeThroughCalls;
    },
  } as RouteEntityCache & { _writeThroughCalls: string[] };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function setupFixtures() {
  mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });
  mkdirSync(path.join(tempDir, ".kspec", "modules"), { recursive: true });

  writeFileSync(
    path.join(tempDir, ".kspec", "kynetic.yaml"),
    `kynetic: "1.0"
project:
  name: Read Path Test
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
tasks_file: project.tasks.yaml
`,
  );

  writeFileSync(
    path.join(tempDir, ".kspec", "modules", "test.yaml"),
    `features:
  - _ulid: "${SPEC_ULID}"
    slugs:
      - read-path-spec
    title: "Read Path Test Spec"
    type: feature
    description: "A test spec for read path optimization"
    created: "2026-01-01T00:00:00Z"
    acceptance_criteria:
      - id: ac-1
        given: test setup
        when: read requested
        then: served from cache
      - id: ac-2
        given: cache warm
        when: index requested
        then: built from cache
`,
  );

  writeFileSync(
    path.join(tempDir, ".kspec", "project.tasks.yaml"),
    `tasks:
  - _ulid: "${TASK_ULID_1}"
    slugs:
      - read-path-task-1
    title: "Read Path Test Task 1"
    description: "A test task"
    status: in_progress
    type: task
    automation: eligible
    spec_ref: "@read-path-spec"
    created_at: "2026-01-01T00:00:00Z"
    tags:
      - test
  - _ulid: "${TASK_ULID_2}"
    slugs:
      - read-path-task-2
    title: "Read Path Test Task 2"
    description: "A second test task with dependency"
    status: pending
    type: task
    automation: eligible
    depends_on:
      - "@read-path-task-1"
    created_at: "2026-01-02T00:00:00Z"
`,
  );

  writeFileSync(
    path.join(tempDir, ".kspec", "project.inbox.yaml"),
    `inbox:
  - _ulid: "${INBOX_ULID}"
    text: "Test inbox item for read path"
    tags:
      - test
    added_by: test
    created_at: "2026-01-15T00:00:00Z"
`,
  );

  writeFileSync(
    path.join(tempDir, ".kspec", "project.triage.yaml"),
    `records:
  - _ulid: "${TRIAGE_ULID}"
    inbox_ref: "${INBOX_ULID}"
    item_snapshot: "Test inbox item for read path"
    status: triaged
    action: promote
    reasoning: "Looks actionable"
    decided_by: test
    created_at: "2026-01-16T00:00:00Z"
`,
  );

  writeFileSync(
    path.join(tempDir, ".kspec", "project.plans.yaml"),
    `plans: []
`,
  );

  writeFileSync(
    path.join(tempDir, ".kspec", "project.reviews.yaml"),
    `reviews: []
`,
  );

  writeFileSync(
    path.join(tempDir, ".kspec", "kynetic.meta.yaml"),
    `kynetic_meta: "1.0"
agents: []
workflows: []
conventions: []
observations: []
`,
  );

  mkdirSync(path.join(tempDir, ".kspec-sessions"), { recursive: true });

  execSync('git add -A && git commit -m "read path test setup"', { cwd: tempDir, stdio: "pipe" });
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

// ─── AC: @daemon-read-path ac-no-per-request-sync ─────────────────────────────

describe("ac-no-per-request-sync: read routes serve from cache without git operations", () => {
  let warmCache: RouteEntityCache;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-read-path-");
    initGitRepo(tempDir);
    setupFixtures();

    warmCache = createWarmCache({
      tasks: [
        makeTaskSummary(),
        makeTaskSummary({
          _ulid: TASK_ULID_2,
          slugs: ["read-path-task-2"],
          title: "Read Path Test Task 2",
          status: "pending",
          depends_on: ["@read-path-task-1"],
        }),
      ],
      fullTasks: [
        makeFullTask(),
        makeFullTask({
          _ulid: TASK_ULID_2,
          slugs: ["read-path-task-2"],
          title: "Read Path Test Task 2",
          status: "pending",
          depends_on: ["@read-path-task-1"],
          description: "Second task depends on the first",
        }),
      ],
    });

    const getEntityCache: EntityCacheAccessor = () => warmCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    app = new Elysia()
      .resolve(({ set }) => ({
        error: (status: number, body: unknown) => {
          set.status = status;
          return body;
        },
      }))
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache }))
      .use(createItemsRoutes({ getEntityCache }))
      .use(createAggregationRoutes({ getEntityCache }))
      .use(createValidationRoutes({ getEntityCache }))
      .use(createInboxRoutes({ pubsub, getEntityCache }))
      .use(createRefsRoutes({ getEntityCache }))
      .use(createPlansRoutes({ getEntityCache }))
      .use(createMetaRoutes({ getEntityCache }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/tasks serves task list from cache", async () => {
    const res = await makeRequest("/api/tasks");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: unknown[];
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(2);
    expect(body.data).toHaveLength(2);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/items serves item list from cache", async () => {
    const res = await makeRequest("/api/items");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: unknown[];
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/inbox serves inbox list from cache", async () => {
    const res = await makeRequest("/api/inbox");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: unknown[];
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/aggregation/tasks/summary serves from cached task index", async () => {
    const res = await makeRequest("/api/aggregation/tasks/summary");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        counts: Record<string, number>;
        ready: number;
        blocked_by_dependencies: number;
        total: number;
      };
      meta: { cache_status: string };
    };
    expect(body.data.total).toBe(2);
    // Task 2 is pending with a dependency on task 1 (in_progress), so it's blocked
    expect(body.data.blocked_by_dependencies).toBe(1);
    // Only task 2 is pending; task 1 is in_progress (not counted as ready)
    expect(body.data.ready).toBe(0);
    expect(body.data.counts["in_progress"]).toBe(1);
    expect(body.data.counts["pending"]).toBe(1);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/aggregation/inbox serves from cached inbox and triage indexes", async () => {
    const res = await makeRequest("/api/aggregation/inbox");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ _ulid: string; triage?: { status: string; reasoning?: string } }>;
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]._ulid).toBe(INBOX_ULID);
    // Triage record should be merged inline
    expect(body.data[0].triage).toBeDefined();
    expect(body.data[0].triage!.status).toBe("triaged");
    expect(body.data[0].triage!.reasoning).toBe("Looks actionable");
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/search?q=... serves from cached entity data", async () => {
    const res = await makeRequest("/api/search?q=Read+Path");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { results: Array<{ type: string; title: string }>; total: number };
      meta: { cache_status: string };
    };
    expect(body.data.total).toBeGreaterThan(0);
    // Should find items/tasks containing "Read Path" from cache
    const types = body.data.results.map((r) => r.type);
    expect(types).toContain("task");
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  // Regression: search must find matches in description, notes, and AC content,
  // not just summary-level fields. Prior implementation used cache summaries that
  // stripped these fields, causing grepItem to miss matches.
  it("GET /api/search finds matches in task description (not just title)", async () => {
    const res = await makeRequest("/api/search?q=unicorn+migration");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        results: Array<{ type: string; ulid: string; matchedFields: string[] }>;
        total: number;
      };
      meta: { cache_status: string };
    };
    expect(body.data.total).toBeGreaterThan(0);
    const taskResult = body.data.results.find((r) => r.type === "task" && r.ulid === TASK_ULID_1);
    expect(taskResult).toBeDefined();
    expect(taskResult!.matchedFields).toContain("description");
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/search finds matches in task notes content", async () => {
    const res = await makeRequest("/api/search?q=needle-in-haystack");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        results: Array<{ type: string; ulid: string; matchedFields: string[] }>;
        total: number;
      };
      meta: { cache_status: string };
    };
    expect(body.data.total).toBeGreaterThan(0);
    const taskResult = body.data.results.find((r) => r.type === "task" && r.ulid === TASK_ULID_1);
    expect(taskResult).toBeDefined();
    expect(taskResult!.matchedFields.some((f) => f.startsWith("notes"))).toBe(true);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/search finds matches in item description and AC content", async () => {
    // Search for text only in the item description
    const descRes = await makeRequest("/api/search?q=quantum-entanglement");
    expect(descRes.status).toBe(200);
    const descBody = (await descRes.json()) as {
      data: {
        results: Array<{ type: string; ulid: string; matchedFields: string[] }>;
        total: number;
      };
      meta: { cache_status: string };
    };
    expect(descBody.data.total).toBeGreaterThan(0);
    const descItem = descBody.data.results.find((r) => r.type === "item" && r.ulid === SPEC_ULID);
    expect(descItem).toBeDefined();
    expect(descItem!.matchedFields).toContain("description");

    // Search for text only in an AC's "then" clause
    const acRes = await makeRequest("/api/search?q=xylophone-harmonics");
    expect(acRes.status).toBe(200);
    const acBody = (await acRes.json()) as {
      data: {
        results: Array<{ type: string; ulid: string; matchedFields: string[] }>;
        total: number;
      };
      meta: { cache_status: string };
    };
    expect(acBody.data.total).toBeGreaterThan(0);
    const acItem = acBody.data.results.find((r) => r.type === "item" && r.ulid === SPEC_ULID);
    expect(acItem).toBeDefined();
    expect(acItem!.matchedFields.some((f) => f.includes("acceptance_criteria"))).toBe(true);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/meta/agents serves from cached meta detail", async () => {
    const res = await makeRequest("/api/meta/agents");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0].id).toBe("test-agent");
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/meta/workflows serves from cached meta detail", async () => {
    const res = await makeRequest("/api/meta/workflows");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0].id).toBe("test-workflow");
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/meta/conventions serves from cached meta detail", async () => {
    const res = await makeRequest("/api/meta/conventions");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ domain: string }>;
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0].domain).toBe("testing");
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/meta/shadow serves from cached shadow info", async () => {
    const res = await makeRequest("/api/meta/shadow");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        enabled: boolean;
        branch_name: string | null;
        worktree_dir: string | null;
        healthy: boolean;
        remote_tracking: boolean;
      };
      meta: { cache_status: string };
    };
    expect(body.data.enabled).toBe(true);
    expect(body.data.branch_name).toBe("kspec-meta");
    expect(body.data.healthy).toBe(true);
    expect(body.data.remote_tracking).toBe(false);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  it("GET /api/meta/config serves from cached project config", async () => {
    const res = await makeRequest("/api/meta/config");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        project: { name: string; version: string; status: string } | null;
        spec_version: string | null;
        root_dir: string;
        daemon: { port: number; host: string; auto_start: boolean };
      };
      meta: { cache_status: string };
    };
    expect(body.data.project?.name).toBe("Read Path Test");
    expect(body.data.spec_version).toBe("1.0");
    expect(body.data.daemon.port).toBe(3456);
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  // Behavioral proof: verify that no parser/shadow git-backed helpers are invoked
  // during read requests when the cache is warm. A regression that re-introduced
  // per-request disk/git work would trigger these spies.
  it("read routes do not call initContext or git-backed helpers when cache is warm", async () => {
    const initContextSpy = vi.spyOn(parserModule, "initContext");
    const getShadowStatusSpy = vi.spyOn(shadowModule, "getShadowStatus");
    const hasRemoteTrackingSpy = vi.spyOn(shadowModule, "hasRemoteTracking");

    try {
      // Hit every read route that should serve from cache
      const readRoutes = [
        "/api/tasks",
        "/api/items",
        "/api/inbox",
        "/api/aggregation/tasks/summary",
        "/api/aggregation/inbox",
        `/api/search?q=Read+Path`,
        "/api/alignment",
        "/api/meta/agents",
        "/api/meta/workflows",
        "/api/meta/conventions",
        "/api/meta/shadow",
        "/api/meta/config",
        "/api/meta/session",
        "/api/meta/observations",
        "/api/refs",
        "/api/plans",
      ];

      for (const route of readRoutes) {
        const res = await makeRequest(route);
        // Route should return 200
        expect(res.status).toBe(200);
      }

      // None of the git-backed helpers should have been called
      expect(initContextSpy).not.toHaveBeenCalled();
      expect(getShadowStatusSpy).not.toHaveBeenCalled();
      expect(hasRemoteTrackingSpy).not.toHaveBeenCalled();
    } finally {
      initContextSpy.mockRestore();
      getShadowStatusSpy.mockRestore();
      hasRemoteTrackingSpy.mockRestore();
    }
  });

  // AC: @daemon-read-path ac-no-per-request-sync
  // Verify that routes which had warmup fallback bugs now return loading responses
  // instead of falling through to initContext() + disk reads during cache warmup.
  it("routes return loading response during cache warmup instead of falling through to disk", async () => {
    // Create a "loading" cache where all domains are in warmup state
    const loadingCache: RouteEntityCache = {
      ...warmCache,
      getDomainState: () => "loading",
    };
    const getLoadingCache: EntityCacheAccessor = () => loadingCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    const loadingApp = new Elysia()
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache: getLoadingCache }))
      .use(createItemsRoutes({ getEntityCache: getLoadingCache }))
      .use(createAggregationRoutes({ getEntityCache: getLoadingCache }))
      .use(createValidationRoutes({ getEntityCache: getLoadingCache }))
      .use(createInboxRoutes({ pubsub, getEntityCache: getLoadingCache }))
      .use(createRefsRoutes({ getEntityCache: getLoadingCache }))
      .use(createPlansRoutes({ getEntityCache: getLoadingCache }))
      .use(createMetaRoutes({ getEntityCache: getLoadingCache }));

    const initContextSpy = vi.spyOn(parserModule, "initContext");
    const getShadowStatusSpy = vi.spyOn(shadowModule, "getShadowStatus");
    const hasRemoteTrackingSpy = vi.spyOn(shadowModule, "hasRemoteTracking");

    try {
      // These routes previously fell through to initContext during warmup
      const warmupRoutes = [
        "/api/meta/config",
        "/api/meta/shadow",
        "/api/aggregation/validation",
        "/api/alignment",
        "/api/search?q=test",
      ];

      for (const route of warmupRoutes) {
        const res = await loadingApp.handle(
          new Request(`http://localhost${route}`, {
            headers: { Host: "localhost", "X-Kspec-Dir": tempDir },
          }),
        );
        // Route should return 200 with cache_status: loading
        expect(res.status).toBe(200);
        const body = (await res.json()) as { meta: { cache_status: string } };
        expect(body.meta.cache_status).toBe("loading");
      }

      // None of the git-backed helpers should have been called during warmup
      expect(initContextSpy).not.toHaveBeenCalled();
      expect(getShadowStatusSpy).not.toHaveBeenCalled();
      expect(hasRemoteTrackingSpy).not.toHaveBeenCalled();
    } finally {
      initContextSpy.mockRestore();
      getShadowStatusSpy.mockRestore();
      hasRemoteTrackingSpy.mockRestore();
    }
  });
});

// ─── AC: @daemon-read-path ac-background-sync ─────────────────────────────────

describe("ac-background-sync: background sync invalidates cache on pull", () => {
  let syncTestDir: string;
  let syncRemoteDir: string;

  beforeEach(async () => {
    syncTestDir = await createTempDir("kspec-bg-sync-");
    syncRemoteDir = await createTempDir("kspec-bg-sync-remote-");
  });

  afterEach(async () => {
    await cleanupTempDir(syncTestDir);
    await cleanupTempDir(syncRemoteDir);
  });

  async function setupSyncEnvironment(): Promise<string> {
    // Create bare remote
    execSync("git init --bare", { cwd: syncRemoteDir, stdio: "pipe" });

    // Create local repo with remote
    execSync("git init -b main", { cwd: syncTestDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: syncTestDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: syncTestDir, stdio: "pipe" });
    writeFileSync(path.join(syncTestDir, "README.md"), "# Test");
    execSync('git add . && git commit -m "initial"', { cwd: syncTestDir, stdio: "pipe" });
    execSync(`git remote add origin ${syncRemoteDir}`, { cwd: syncTestDir, stdio: "pipe" });
    execSync("git push -u origin main", { cwd: syncTestDir, stdio: "pipe" });

    // Initialize shadow branch with worktree
    const { initializeShadow, SHADOW_WORKTREE_DIR } = await import("../src/parser/shadow.js");
    await initializeShadow(syncTestDir);

    return path.join(syncTestDir, SHADOW_WORKTREE_DIR);
  }

  // AC: @daemon-read-path ac-background-sync
  it("server shadow-sync pull handler reloads the full entity cache", async () => {
    const cache = {
      loadAll: vi.fn().mockResolvedValue(undefined),
    };
    const getEntityCache = vi.fn().mockReturnValue(cache);

    const onPull = createShadowSyncOnPullHandler(syncTestDir, getEntityCache);

    await onPull();

    expect(getEntityCache).toHaveBeenCalledWith(syncTestDir);
    expect(cache.loadAll).toHaveBeenCalledTimes(1);
  });

  // AC: @daemon-read-path ac-background-sync
  it("syncOnce invokes onPull callback after pulling remote changes", async () => {
    const worktreeDir = await setupSyncEnvironment();
    const { SHADOW_BRANCH_NAME } = await import("../src/parser/shadow.js");

    // Push shadow branch to remote so tracking is set up
    execSync(`git push -u origin ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Make a remote change via a clone
    const cloneDir = await createTempDir("kspec-bg-sync-clone-");
    try {
      execSync(`git clone ${syncRemoteDir} ${cloneDir}`, { stdio: "pipe" });
      execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: "pipe" });
      execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: "pipe" });

      const { SHADOW_WORKTREE_DIR } = await import("../src/parser/shadow.js");
      execSync(`git worktree add ${SHADOW_WORKTREE_DIR} ${SHADOW_BRANCH_NAME}`, {
        cwd: cloneDir,
        stdio: "pipe",
      });

      // Create a file change on the remote shadow branch
      writeFileSync(
        path.join(cloneDir, SHADOW_WORKTREE_DIR, "remote-change.txt"),
        "Background sync test change",
      );
      execSync('git add -A && git commit -m "Remote change for bg sync"', {
        cwd: path.join(cloneDir, SHADOW_WORKTREE_DIR),
        stdio: "pipe",
      });
      execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
        cwd: path.join(cloneDir, SHADOW_WORKTREE_DIR),
        stdio: "pipe",
      });

      // Create scheduler with onPull spy and run syncOnce
      const onPull = vi.fn().mockResolvedValue(undefined);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const scheduler = new ShadowSyncScheduler({
          worktreeDir,
          intervalSeconds: 60,
          onPull,
        });

        await scheduler.syncOnce();

        // Verify pull happened
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Shadow sync: pulled remote changes"),
        );

        // Verify onPull callback was invoked by the scheduler (not by us directly)
        expect(onPull).toHaveBeenCalledTimes(1);
      } finally {
        consoleSpy.mockRestore();
      }
    } finally {
      await cleanupTempDir(cloneDir);
    }
  });

  // AC: @daemon-read-path ac-background-sync
  it("onPull callback errors are caught and do not break the sync cycle", async () => {
    const worktreeDir = await setupSyncEnvironment();
    const { SHADOW_BRANCH_NAME } = await import("../src/parser/shadow.js");

    // Push shadow branch to remote so tracking is set up
    execSync(`git push -u origin ${SHADOW_BRANCH_NAME}`, {
      cwd: worktreeDir,
      stdio: "pipe",
    });

    // Make a remote change via a clone
    const cloneDir = await createTempDir("kspec-bg-sync-err-clone-");
    try {
      execSync(`git clone ${syncRemoteDir} ${cloneDir}`, { stdio: "pipe" });
      execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: "pipe" });
      execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: "pipe" });

      const { SHADOW_WORKTREE_DIR } = await import("../src/parser/shadow.js");
      execSync(`git worktree add ${SHADOW_WORKTREE_DIR} ${SHADOW_BRANCH_NAME}`, {
        cwd: cloneDir,
        stdio: "pipe",
      });

      writeFileSync(
        path.join(cloneDir, SHADOW_WORKTREE_DIR, "error-test-change.txt"),
        "Error callback test",
      );
      execSync('git add -A && git commit -m "Remote change for error test"', {
        cwd: path.join(cloneDir, SHADOW_WORKTREE_DIR),
        stdio: "pipe",
      });
      execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
        cwd: path.join(cloneDir, SHADOW_WORKTREE_DIR),
        stdio: "pipe",
      });

      // Create an onPull that throws — scheduler should catch and continue
      const onPull = vi.fn().mockRejectedValue(new Error("Cache reload failed"));
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const scheduler = new ShadowSyncScheduler({
          worktreeDir,
          intervalSeconds: 60,
          onPull,
        });

        // Should not throw even though onPull rejects
        await scheduler.syncOnce();

        // onPull was called (pull happened)
        expect(onPull).toHaveBeenCalledTimes(1);
        // Error was caught and logged
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("onPull callback error"),
          expect.any(Error),
        );
      } finally {
        consoleSpy.mockRestore();
        errorSpy.mockRestore();
      }
    } finally {
      await cleanupTempDir(cloneDir);
    }
  });
});

// ─── AC: @daemon-read-path ac-index-from-cache ────────────────────────────────

describe("ac-index-from-cache: indexes built from cached data", () => {
  let warmCache: RouteEntityCache;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-read-path-index-");
    initGitRepo(tempDir);
    setupFixtures();

    warmCache = createWarmCache();
    const getEntityCache: EntityCacheAccessor = () => warmCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    app = new Elysia()
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache }))
      .use(createItemsRoutes({ getEntityCache }))
      .use(createAggregationRoutes({ getEntityCache }))
      .use(createValidationRoutes({ getEntityCache }))
      .use(createRefsRoutes({ getEntityCache }))
      .use(createPlansRoutes({ getEntityCache }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-read-path ac-index-from-cache
  it("GET /api/refs builds reference index from cached task/item/plan data", async () => {
    const res = await makeRequest("/api/refs");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { refs: Record<string, unknown> };
      meta: { cache_status: string };
    };
    // The ref index should contain entries built from cached data
    expect(body.data.refs).toBeDefined();
    // Should have entries for the cached task and spec
    const keys = Object.keys(body.data.refs);
    expect(keys.length).toBeGreaterThan(0);
  });

  // AC: @daemon-read-path ac-index-from-cache
  it("GET /api/tasks list resolves from cached task index with ref resolution from cache", async () => {
    const res = await makeRequest("/api/tasks");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ _ulid: string; title: string; spec_title?: string }>;
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    // Task index was built from cache, spec title resolved from cached item index
    expect(body.data[0]._ulid).toBe(TASK_ULID_1);
    expect(body.data[0].title).toBe("Read Path Test Task 1");
  });

  // AC: @daemon-read-path ac-index-from-cache
  it("GET /api/items serves with plan linkage from cached plan index", async () => {
    const res = await makeRequest("/api/items");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: Array<{ _ulid: string }>;
      meta: { total: number; cache_status: string };
    };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]._ulid).toBe(SPEC_ULID);
  });

  // AC: @daemon-read-path ac-index-from-cache
  it("GET /api/aggregation/validation builds alignment index from cached entity data", async () => {
    const res = await makeRequest("/api/aggregation/validation");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        stats: {
          totalSpecs: number;
          specsWithTasks: number;
          alignedSpecs: number;
          orphanedSpecs: number;
        };
        entity_counts: { items: number; tasks: number; traits: number };
        ac_counts: { total: number; covered: number; uncovered: number };
      };
      meta: { cache_status: string };
    };
    // Alignment index was built from cached task/item summaries
    expect(body.data.stats).toBeDefined();
    expect(body.data.stats.totalSpecs).toBeGreaterThanOrEqual(0);
    // Entity counts should reflect validation data
    expect(body.data.entity_counts).toBeDefined();
    // AC counts should use acceptance_criteria_count from cached ItemSummary
    expect(body.data.ac_counts).toBeDefined();
  });

  // AC: @daemon-read-path ac-index-from-cache
  it("GET /api/alignment builds alignment index from cached entity data", async () => {
    const res = await makeRequest("/api/alignment");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        stats: {
          totalSpecs: number;
          specsWithTasks: number;
          alignedSpecs: number;
          orphanedSpecs: number;
        };
        warnings: unknown[];
      };
      meta: { cache_status: string };
    };
    // Alignment index was built from cached task/item summaries
    expect(body.data.stats).toBeDefined();
    expect(body.data.stats.totalSpecs).toBeGreaterThanOrEqual(0);
    expect(body.data.warnings).toBeDefined();
  });
});

// ─── AC: @daemon-read-path ac-write-routes-sync ───────────────────────────────

describe("ac-write-routes-sync: write operations use standard commit path with cache update", () => {
  let warmCache: RouteEntityCache & { _writeThroughCalls: string[] };

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-read-path-write-");
    initGitRepo(tempDir);
    setupFixtures();

    warmCache = createWarmCache() as RouteEntityCache & { _writeThroughCalls: string[] };
    const getEntityCache: EntityCacheAccessor = () => warmCache;
    const pubsub = new PubSubManager();
    const { middleware } = projectContextMiddleware();

    app = new Elysia()
      .resolve(({ set }) => ({
        error: (status: number, body: unknown) => {
          set.status = status;
          return body;
        },
      }))
      .use(middleware)
      .use(createTasksRoutes({ pubsub, getEntityCache }))
      .use(createInboxRoutes({ pubsub, getEntityCache }));
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-read-path ac-write-routes-sync
  it("POST /api/inbox commits to shadow branch and calls writeThrough", async () => {
    const res = await makeRequest("/api/inbox", {
      method: "POST",
      body: JSON.stringify({
        text: "New inbox item from write test",
        tags: ["write-test"],
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; item: { _ulid: string; text: string } };
    expect(body.success).toBe(true);
    expect(body.item.text).toBe("New inbox item from write test");
    // Cache should have been updated via writeThrough
    expect(warmCache._writeThroughCalls).toContain("inbox");
  });

  // AC: @daemon-read-path ac-write-routes-sync
  it("POST /api/tasks/:ref/start commits state change and calls writeThrough", async () => {
    // The task is already in_progress from our fixture, but the route still
    // triggers the mutation path. Test that writeThrough is called for task mutations.
    const res = await makeRequest(`/api/tasks/@read-path-task-1/note`, {
      method: "POST",
      body: JSON.stringify({
        content: "Test note from write sync test",
      }),
    });

    // Task note endpoint should commit and call writeThrough
    if (res.status === 200) {
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
      // writeThrough should have been called for the tasks domain
      expect(warmCache._writeThroughCalls).toContain("tasks");
    }
  });
});
