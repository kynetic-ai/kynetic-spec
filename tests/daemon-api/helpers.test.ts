import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Elysia } from "elysia";
import type { ProjectContextManager } from "../../dist/daemon/project-context.js";
import type {
  EntityCacheAccessor,
  RouteEntityCache,
} from "../../dist/daemon/routes/entity-cache-types.js";
import { PubSubManager } from "../../dist/daemon/websocket/pubsub.js";
import {
  captureBroadcasts,
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  requestJson,
  setupFixtures,
  setupInlineFixtures,
  testUlid,
} from "./helpers.js";

// AC: @daemon-test-mode-boundaries ac-in-process-route-tests-no-child-process
// AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run

let tempDir: string;
let app: Elysia;
let manager: ProjectContextManager;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-helper-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app, manager } = createTestApp());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTempDir(tempDir);
});

describe("setupFixtures (e2e shadow mode)", () => {
  it("keeps project watchers disabled for app.handle integration tests", async () => {
    const response = await makeRequest(app, tempDir, "/api/meta/session");
    expect(response.status).toBe(200);

    const [project] = manager.listProjects();
    expect(project).toBeDefined();
    expect(project.path).toBe(tempDir);
    expect(project.watcherActive).toBe(false);
  });
});

describe("setupInlineFixtures (traditional inline mode)", () => {
  let inlineDir: string;

  beforeEach(async () => {
    inlineDir = await createTempDir("kspec-daemon-api-inline-");
    initGitRepo(inlineDir);
  });

  afterEach(async () => {
    await cleanupTempDir(inlineDir);
  });

  it("writes a default manifest, modules dir, and committed git state when called with no overrides", async () => {
    setupInlineFixtures(inlineDir);

    const { app: inlineApp } = createTestApp();
    const response = await makeRequest(inlineApp, inlineDir, "/api/tasks");

    // Default manifest declares split task storage with no tasks seeded,
    // so /api/tasks resolves and returns an empty list rather than a 5xx.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });

  it("accepts a legacy (kynetic 1.0) manifest with tasksFile for non-task routes", async () => {
    const reviewUlid = testUlid("RVLG", 1);

    setupInlineFixtures(inlineDir, {
      manifest: `kynetic: "1.0"
project:
  name: Legacy Test
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
tasks_file: project.tasks.yaml
`,
      tasksFile: "tasks: []\n",
      reviews: `kynetic_reviews: "1.0"
reviews:
  - _ulid: "${reviewUlid}"
    slugs:
      - legacy-review
    title: "Legacy review"
    lifecycle_state: open
    author: "@test"
    subject:
      type: plan
      ref: "@plan-test"
      shadow_commit: "abc123"
      content_hash: "h"
    verdicts: []
    checks: []
    threads: []
    events: []
    related_refs: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`,
    });

    const { app: inlineApp } = createTestApp();
    const response = await makeRequest(inlineApp, inlineDir, `/api/reviews/${reviewUlid}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { _ulid: string; title: string } };
    expect(body.data._ulid).toBe(reviewUlid);
    expect(body.data.title).toBe("Legacy review");
  });

  it("seeds split-format tasks via splitTasks and exposes them through GET /api/tasks", async () => {
    const taskUlid = testUlid("SPLT", 3);
    const specUlid = testUlid("SPEC", 4);

    setupInlineFixtures(inlineDir, {
      manifest: `kynetic: "1.1"
task_storage:
  format: split
project:
  name: Split Test
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`,
      modules: {
        "test.yaml": `features:
  - _ulid: "${specUlid}"
    slugs:
      - split-spec
    title: "Split spec"
    type: feature
    description: "spec"
    created: "2026-01-01T00:00:00Z"
`,
      },
      splitTasks: [
        {
          _ulid: taskUlid,
          slugs: ["split-task"],
          title: "Split task",
          description: "Split format task",
          type: "task",
          status: "pending",
          priority: 2,
          spec_ref: "@split-spec",
          depends_on: [],
          notes: [],
          todos: [],
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const { app: inlineApp } = createTestApp();
    const response = await makeRequest(inlineApp, inlineDir, "/api/tasks");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ _ulid: string; title: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]._ulid).toBe(taskUlid);
    expect(body.data[0].title).toBe("Split task");
  });

  it("rejects supplying both tasksFile and splitTasks", () => {
    expect(() =>
      setupInlineFixtures(inlineDir, {
        tasksFile: "tasks: []\n",
        splitTasks: [
          {
            _ulid: testUlid("BAD", 1),
            slugs: ["bad"],
            title: "bad",
            type: "task",
            status: "pending",
            priority: 2,
            depends_on: [],
            notes: [],
            todos: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    ).toThrow(/tasksFile or splitTasks/);
  });

  it("skips committing when skipCommit=true, leaving a dirty working tree", async () => {
    const { execSync } = await import("node:child_process");

    setupInlineFixtures(inlineDir, { skipCommit: true });

    const status = execSync("git status --porcelain", {
      cwd: inlineDir,
      encoding: "utf8",
    });
    expect(status.length).toBeGreaterThan(0);
  });
});

describe("requestJson", () => {
  it("auto-stringifies body and sets the Content-Type header for mutation routes", async () => {
    // /api/inbox accepts POST with a JSON body and returns 200 on success.
    const response = await requestJson(app, tempDir, "POST", "/api/inbox", {
      text: "Inbox item from helper test",
      tag: ["test"],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data?: { text?: string } };
    // The data envelope or error response varies by route; we assert the
    // call made it through (no 415, no body parse errors) which is what
    // the helper is responsible for.
    expect(body).toBeDefined();
  });

  it("forwards method and URL path without a body when body is omitted", async () => {
    const response = await requestJson(app, tempDir, "GET", "/api/health");

    // /api/health is registered at server level, not in the route group.
    // For this assertion we just need to confirm requestJson does not
    // produce a 4xx from missing Content-Type when no body is sent.
    expect([200, 404]).toContain(response.status);
  });
});

describe("captureBroadcasts", () => {
  it("records calls made to PubSubManager.broadcast on the spied instance", () => {
    const pubsub = new PubSubManager();
    const spy = captureBroadcasts(pubsub);

    pubsub.broadcast("topic:test", "event_kind", { hello: "world" }, "/some/project");

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      "topic:test",
      "event_kind",
      expect.objectContaining({ hello: "world" }),
      "/some/project",
    );
  });

  it("supports clearing call history mid-test via spy.mockClear()", () => {
    const pubsub = new PubSubManager();
    const spy = captureBroadcasts(pubsub);

    pubsub.broadcast("topic:a", "first", {}, "/p");
    expect(spy).toHaveBeenCalledOnce();

    spy.mockClear();

    pubsub.broadcast("topic:a", "second", {}, "/p");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith("topic:a", "second", expect.anything(), "/p");
  });
});

describe("createTestApp with getEntityCache", () => {
  it("propagates getEntityCache to cache-aware routes and surfaces cached read state", async () => {
    // Build a minimal RouteEntityCache that signals "ready" for tasks;
    // this is the contract reads use to decide between cache and disk.
    let observedProjectPath: string | null = null;
    const cache: RouteEntityCache = {
      getDomainState: (domain) => (domain === "tasks" ? "ready" : "unloaded"),
      getTaskIndex: () => [],
      getTaskDetail: () => null,
      getTaskHistory: () => null,
      setTaskDetail: () => {},
      getAllTaskDetails: () => [],
      getItemIndex: () => null,
      getItemDetail: () => null,
      setItemDetail: () => {},
      getAllItemDetails: () => null,
      getSessionIndex: () => null,
      getSessionLiveEventCount: () => undefined,
      getSessionDetail: () => null,
      setSessionDetail: () => {},
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
      writeThrough: async () => {},
      markWriteThrough: () => {},
      getCacheDiagnostics: () => ({ projectPath: tempDir, domains: {} }),
    } as RouteEntityCache;

    const getEntityCache: EntityCacheAccessor = (projectPath: string) => {
      observedProjectPath = projectPath;
      return cache;
    };

    const { app: cachedApp } = createTestApp({ getEntityCache });
    const response = await makeRequest(cachedApp, tempDir, "/api/tasks");

    // The cache reported tasks as ready with an empty index, so the route
    // serves an empty list from cache rather than touching disk.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);

    // Confirm the accessor was invoked with the resolved project path —
    // proves the route actually consulted the cache.
    expect(observedProjectPath).toBe(tempDir);
  });
});

// AC: @in-process-daemon-test-helper-boundary ac-helper-scope-is-explicit
// AC: @in-process-daemon-test-helper-boundary ac-test-uses-helper-matching-behavior
//
// These tests pin the createTestApp() boundary documented in helpers.ts:
// production server-level concerns (CORS, localhostOnly, /api/health,
// /ws, web UI, plus the projects/refs/diff/command/automation/debug
// route groups) are NOT reproduced by the helper. Tests that need any
// of those concerns must build their own app (see
// tests/daemon-api/server.test.ts and tests/daemon-api/projects.test.ts)
// or use a real daemon child (see tests/daemon-api/websocket-protocol.test.ts).
describe("createTestApp boundary", () => {
  it("does not register the inline /api/health endpoint (server-level only)", async () => {
    const response = await makeRequest(app, tempDir, "/api/health");

    // /api/health is defined inline on the production app in
    // packages/daemon/src/server.ts, not in any route module the helper
    // composes — so the in-process app must surface a 404 here.
    expect(response.status).toBe(404);
  });

  it("does not register createProjectsRoutes (/api/projects)", async () => {
    const response = await makeRequest(app, tempDir, "/api/projects");

    expect(response.status).toBe(404);
  });

  it("does not register createDebugRoutes (/api/debug/cache-status)", async () => {
    const response = await makeRequest(app, tempDir, "/api/debug/cache-status");

    expect(response.status).toBe(404);
  });

  it("does not register createDiffRoutes (/api/diff)", async () => {
    const response = await makeRequest(app, tempDir, "/api/diff");

    expect(response.status).toBe(404);
  });

  it("does not register createRefsRoutes (/api/refs)", async () => {
    const response = await makeRequest(app, tempDir, "/api/refs");

    expect(response.status).toBe(404);
  });

  it("does not register the WebSocket endpoint (/ws)", async () => {
    const response = await makeRequest(app, tempDir, "/ws");

    expect(response.status).toBe(404);
  });

  it("does not enforce the localhostOnly Host header (no server-level guard)", async () => {
    // The production server installs localhostOnly() as middleware that
    // rejects non-loopback Host headers with 403. The in-process app
    // intentionally omits that guard, so a request with an external Host
    // header reaches the handler and resolves to a normal response. We
    // assert the 403 path is NOT taken — anything else is acceptable.
    const response = await app.handle(
      new Request("http://localhost/api/tasks", {
        method: "GET",
        headers: {
          Host: "example.com",
          "X-Kspec-Dir": tempDir,
        },
      }),
    );

    expect(response.status).not.toBe(403);
  });

  it("registers a route handler from the supported subset (smoke /api/tasks)", async () => {
    // Pair to the 404 assertions above: the documented in-scope route
    // groups DO reach a real handler. /api/tasks is registered via
    // createTasksRoutes and resolves against the e2e fixture set.
    const response = await makeRequest(app, tempDir, "/api/tasks");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// Trait AC annotations
// AC: @trait-json-output ac-1 — N/A: helpers are test infrastructure, not CLI commands
// AC: @trait-json-output ac-2 — N/A: helpers do not produce human-readable output
// AC: @trait-json-output ac-3 — N/A: helpers do not produce CLI errors
// AC: @trait-json-output ac-4 — N/A: helpers do not output references
// AC: @trait-json-output ac-5 — N/A: helpers do not emit timestamps
// AC: @trait-json-output ac-6 — N/A: helpers have no formatting flags
