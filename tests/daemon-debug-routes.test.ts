/**
 * Debug API route tests.
 *
 * Tests GET /api/debug/cache-status endpoint which returns per-project
 * cache diagnostics including domain states, entry counts, watcher status,
 * and last invalidation timestamps.
 *
 * AC: @daemon-server ac-18
 */

import { Elysia } from "elysia";
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createTempDir, cleanupTempDir, initGitRepo } from "./helpers/cli.js";
import { createDebugRoutes } from "../dist/daemon/routes/debug.js";
import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";
import type {
  RouteEntityCache,
  EntityCacheAccessor,
} from "../dist/daemon/routes/entity-cache-types.js";
import type { CacheDiagnostic, DomainDiagnostic } from "../dist/daemon/entity-cache.js";

let tempDir: string;
let app: Elysia;

function makeRequest(urlPath: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: init.method ?? "GET",
      headers: {
        Host: "localhost",
        "X-Kspec-Dir": tempDir,
        ...init.headers,
      },
    }),
  );
}

/** Set up a minimal .kspec project fixture for the middleware to resolve. */
function setupProjectFixture(dir: string) {
  mkdirSync(path.join(dir, ".kspec"), { recursive: true });
  writeFileSync(
    path.join(dir, "kynetic.yaml"),
    `kynetic: "1.0"\nproject:\n  name: Debug Test\n  version: "0.1.0"\n  status: draft\n`,
  );
}

/** Create a mock RouteEntityCache that includes getCacheDiagnostics(). */
function createMockCache(
  projectPath: string,
  overrides: Partial<Record<string, DomainDiagnostic>> = {},
): RouteEntityCache {
  const defaultDomain: DomainDiagnostic = {
    state: "ready",
    indexCount: 0,
    detailCount: 0,
    lastError: null,
    lastInvalidatedAt: null,
  };

  const domains: Record<string, DomainDiagnostic> = {
    tasks: { ...defaultDomain, indexCount: 5, detailCount: 3 },
    items: { ...defaultDomain, indexCount: 10, detailCount: 8 },
    meta: { ...defaultDomain, indexCount: 1, detailCount: 1 },
    inbox: { ...defaultDomain, indexCount: 2 },
    plans: { ...defaultDomain },
    triage: { ...defaultDomain },
    reviews: { ...defaultDomain },
    sessions: { ...defaultDomain, indexCount: 4 },
    ...overrides,
  };

  return {
    getDomainState: (domain: string) =>
      (domains[domain]?.state ?? "unloaded") as "ready" | "unloaded" | "loading" | "degraded",
    getTaskIndex: () => null,
    getTaskDetail: () => null,
    getTaskHistory: () => null,
    setTaskDetail: () => {},
    getAllTaskDetails: () => null,
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
    getCacheDiagnostics: () =>
      ({
        projectPath,
        domains,
      }) as CacheDiagnostic,
  };
}

describe("Debug API routes", () => {
  afterEach(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  // AC: @daemon-server ac-18
  it("GET /api/debug/cache-status returns per-project cache diagnostics", async () => {
    tempDir = await createTempDir("kspec-debug-");
    await initGitRepo(tempDir);
    setupProjectFixture(tempDir);

    const { manager: projectManager, middleware } = projectContextMiddleware({
      startupProject: tempDir,
    });

    const mockCache = createMockCache(tempDir);
    const getEntityCache: EntityCacheAccessor = (p: string) => (p === tempDir ? mockCache : null);

    app = new Elysia().use(middleware).use(createDebugRoutes({ projectManager, getEntityCache }));

    const res = await makeRequest("/api/debug/cache-status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.projects).toHaveLength(1);

    const project = body.projects[0];
    expect(project.path).toBe(tempDir);
    expect(project.watcherStatus).toBe("stopped"); // No watcher started in test
    expect(project.registeredAt).toBeTruthy();
    expect(project.lastHealthCheckAt).toBeNull();
    expect(project.consecutiveFailures).toBe(0);
    expect(project.domains).toBeTruthy();

    // Verify domain shape
    expect(project.domains.tasks).toEqual({
      state: "ready",
      indexCount: 5,
      detailCount: 3,
      lastError: null,
      lastInvalidatedAt: null,
    });
    expect(project.domains.items.indexCount).toBe(10);
    expect(project.domains.meta.indexCount).toBe(1);
    expect(project.domains.sessions.indexCount).toBe(4);
  });

  // AC: @daemon-server ac-18 — degraded domain includes error
  it("GET /api/debug/cache-status includes lastError for degraded domains", async () => {
    tempDir = await createTempDir("kspec-debug-degraded-");
    await initGitRepo(tempDir);
    setupProjectFixture(tempDir);

    const { manager: projectManager, middleware } = projectContextMiddleware({
      startupProject: tempDir,
    });

    const mockCache = createMockCache(tempDir, {
      tasks: {
        state: "degraded",
        indexCount: 0,
        detailCount: 0,
        lastError: "YAML parse error in project.tasks.yaml",
        lastInvalidatedAt: "2026-03-28T10:00:00.000Z",
      },
    });
    const getEntityCache: EntityCacheAccessor = (p: string) => (p === tempDir ? mockCache : null);

    app = new Elysia().use(middleware).use(createDebugRoutes({ projectManager, getEntityCache }));

    const res = await makeRequest("/api/debug/cache-status");
    expect(res.status).toBe(200);

    const body = await res.json();
    const tasksDomain = body.projects[0].domains.tasks;
    expect(tasksDomain.state).toBe("degraded");
    expect(tasksDomain.lastError).toBe("YAML parse error in project.tasks.yaml");
    expect(tasksDomain.lastInvalidatedAt).toBe("2026-03-28T10:00:00.000Z");
  });

  // AC: @daemon-watcher-health ac-4
  it("GET /api/debug/cache-status exposes watcher health fields per project", async () => {
    tempDir = await createTempDir("kspec-debug-health-");
    await initGitRepo(tempDir);
    setupProjectFixture(tempDir);

    const { manager: projectManager, middleware } = projectContextMiddleware({
      startupProject: tempDir,
    });
    const project = projectManager.getProject(tempDir);
    project.lastHealthCheckAt = new Date("2026-04-02T18:30:00.000Z");
    project.consecutiveFailures = 2;

    const mockCache = createMockCache(tempDir);
    const getEntityCache: EntityCacheAccessor = (p: string) => (p === tempDir ? mockCache : null);

    app = new Elysia().use(middleware).use(createDebugRoutes({ projectManager, getEntityCache }));

    const res = await makeRequest("/api/debug/cache-status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.projects[0].lastHealthCheckAt).toBe("2026-04-02T18:30:00.000Z");
    expect(body.projects[0].consecutiveFailures).toBe(2);
  });

  // AC: @daemon-server ac-18 — no registered projects
  it("GET /api/debug/cache-status returns empty when no projects registered", async () => {
    tempDir = await createTempDir("kspec-debug-empty-");
    await initGitRepo(tempDir);

    // No startup project — middleware has no default
    const { manager: projectManager, middleware } = projectContextMiddleware();
    const getEntityCache: EntityCacheAccessor = () => null;

    app = new Elysia().use(middleware).use(createDebugRoutes({ projectManager, getEntityCache }));

    const res = await app.handle(
      new Request("http://localhost/api/debug/cache-status", {
        method: "GET",
        headers: { Host: "localhost" },
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.projects).toEqual([]);
  });

  // AC: @daemon-server ac-18 — project with no cache returns null domains
  it("GET /api/debug/cache-status handles project with no cache", async () => {
    tempDir = await createTempDir("kspec-debug-nocache-");
    await initGitRepo(tempDir);
    setupProjectFixture(tempDir);

    const { manager: projectManager, middleware } = projectContextMiddleware({
      startupProject: tempDir,
    });

    // Cache accessor always returns null — simulates cache not yet registered
    const getEntityCache: EntityCacheAccessor = () => null;

    app = new Elysia().use(middleware).use(createDebugRoutes({ projectManager, getEntityCache }));

    const res = await makeRequest("/api/debug/cache-status");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.projects[0].domains).toBeNull();
    expect(body.projects[0].watcherStatus).toBe("stopped");
  });

  // AC: @daemon-server ac-18 — loading domain state
  it("GET /api/debug/cache-status shows loading domain states during progressive load", async () => {
    tempDir = await createTempDir("kspec-debug-loading-");
    await initGitRepo(tempDir);
    setupProjectFixture(tempDir);

    const { manager: projectManager, middleware } = projectContextMiddleware({
      startupProject: tempDir,
    });

    const mockCache = createMockCache(tempDir, {
      tasks: {
        state: "loading",
        indexCount: 0,
        detailCount: 0,
        lastError: null,
        lastInvalidatedAt: null,
      },
      items: {
        state: "loading",
        indexCount: 0,
        detailCount: 0,
        lastError: null,
        lastInvalidatedAt: null,
      },
      meta: {
        state: "unloaded",
        indexCount: 0,
        detailCount: 0,
        lastError: null,
        lastInvalidatedAt: null,
      },
    });
    const getEntityCache: EntityCacheAccessor = (p: string) => (p === tempDir ? mockCache : null);

    app = new Elysia().use(middleware).use(createDebugRoutes({ projectManager, getEntityCache }));

    const res = await makeRequest("/api/debug/cache-status");
    expect(res.status).toBe(200);

    const body = await res.json();
    const domains = body.projects[0].domains;
    expect(domains.tasks.state).toBe("loading");
    expect(domains.items.state).toBe("loading");
    expect(domains.meta.state).toBe("unloaded");
  });

  // AC: @trait-json-output ac-1 — N/A: This is a debug endpoint; it does not support --json CLI flag.
  // The endpoint always returns JSON by default (Elysia serializes objects as JSON).

  // AC: @trait-json-output ac-2 — N/A: This endpoint has no human-readable mode; JSON is the only output format.
  // AC: @trait-json-output ac-3 — N/A: Error handling is delegated to the Elysia middleware; this endpoint is read-only with no expected errors.
  // AC: @trait-json-output ac-4 — N/A: This endpoint does not output entity references with @ prefix.
  // AC: @trait-json-output ac-5 — timestamps use ISO 8601 (verified in tests above via registeredAt and lastInvalidatedAt)
  // AC: @trait-json-output ac-6 — N/A: This endpoint has no formatting flags.

  // AC: @trait-error-guidance ac-1 through ac-6 — N/A: This read-only debug endpoint has no command-level errors
  // to surface. All project/cache data is optional (null-safe), and HTTP errors are handled by middleware.

  // AC: @trait-shadow-commit ac-1 through ac-8 — N/A: This endpoint is read-only; it does not modify shadow worktree state.

  // AC: @trait-localhost-security ac-loopback-default — N/A: debug route handler tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
  // AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
  // AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
  // AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.

  // AC: @trait-websocket-protocol ac-1 through ac-8 — N/A: This is an HTTP GET endpoint, not a WebSocket endpoint.
});
