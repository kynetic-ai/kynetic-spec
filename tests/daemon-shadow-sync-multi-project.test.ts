/**
 * Tests for multi-project shadow sync in daemon
 *
 * Verifies that shadow sync schedulers are started/stopped for projects
 * registered and unregistered via all four registration paths (POST /api/projects,
 * middleware auto-registration, WebSocket project resolution, startup) and both
 * unregistration paths (API DELETE, watcher-permanent-failure), plus shutdown.
 *
 * Task: @01KPP7XFJ7Z1MG2NQAXMWZTA6W
 * Spec: @config-shadow (ac-13, ac-14, ac-15, ac-16, ac-17)
 *
 * AC: @trait-error-guidance ac-1 — N/A: shadow sync manager is a background daemon component, not a CLI command that surfaces errors to users
 * AC: @trait-error-guidance ac-2 — N/A: shadow sync manager is a background daemon component, not a CLI command that surfaces errors to users
 * AC: @trait-error-guidance ac-3 — N/A: shadow sync manager does not resolve references
 * AC: @trait-error-guidance ac-4 — N/A: shadow sync manager does not perform state transitions
 * AC: @trait-error-guidance ac-5 — N/A: shadow sync manager does not perform field validation
 * AC: @trait-error-guidance ac-6 — N/A: shadow sync manager does not have a --json mode
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupMultiDirFixtures, cleanupTempDir } from "./helpers/cli";
import { join } from "path";

// Mock loadProjectConfig before importing the manager module
vi.mock("../src/parser/config.js", () => ({
  loadProjectConfig: vi.fn(),
}));

import {
  startShadowSyncForProject,
  stopShadowSyncForProject,
  shadowSyncSchedulers,
  createShadowSyncOnPullHandler,
  type ShadowPullReloadableCache,
} from "../src/daemon/shadow-sync-manager";
import { ShadowSyncScheduler } from "../src/parser/shadow-sync-scheduler";
import type { ShadowSyncPubSub } from "../src/parser/shadow-sync-scheduler";

// Spy on ShadowSyncScheduler prototype methods to prevent real timer creation
const startSpy = vi.spyOn(ShadowSyncScheduler.prototype, "start").mockImplementation(() => {});
const stopSpy = vi.spyOn(ShadowSyncScheduler.prototype, "stop").mockImplementation(() => {});

function mockPubsub(): ShadowSyncPubSub {
  return { broadcast: vi.fn() };
}

function mockGetEntityCache(): (projectPath: string) => ShadowPullReloadableCache | undefined {
  return vi.fn().mockReturnValue(undefined);
}

// Import the mocked module — vi.mock() hoists above this import
import { loadProjectConfig } from "../src/parser/config";
const mockedLoadProjectConfig = vi.mocked(loadProjectConfig);

/**
 * Configure the mocked loadProjectConfig for the test.
 * sync_interval > 0 enables the scheduler.
 */
function setupConfigMock(opts?: { syncInterval?: number; hasRemote?: boolean }): void {
  const syncInterval = opts?.syncInterval ?? 60;
  const hasRemote = opts?.hasRemote ?? true;

  mockedLoadProjectConfig.mockResolvedValue({
    config: {
      shadow: {
        branch: "kspec-meta",
        directory: ".kspec",
        sync_interval: syncInterval,
        remote: hasRemote ? { value: "origin", type: "named" as const } : undefined,
      },
    },
    configPath: "/fake/kspec.config.yaml",
  } as never);
}

describe("Multi-project shadow sync", () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, "project-a");
    projectB = join(fixturesRoot, "project-b");
    // Clear the shared map between tests
    shadowSyncSchedulers.clear();
    // Reset all spies
    startSpy.mockClear();
    stopSpy.mockClear();
  });

  afterEach(async () => {
    // Clean up any remaining schedulers
    for (const scheduler of shadowSyncSchedulers.values()) {
      scheduler.stop();
    }
    shadowSyncSchedulers.clear();
    await cleanupTempDir(fixturesRoot);
  });

  describe("startShadowSyncForProject", () => {
    // AC: @config-shadow ac-13
    it("should create and start a shadow sync scheduler for a project with remote tracking", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);

      expect(shadowSyncSchedulers.has(projectA)).toBe(true);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    // AC: @config-shadow ac-13
    it("should start schedulers for multiple registered projects", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);
      await startShadowSyncForProject(projectB, pubsub, getCache);

      expect(shadowSyncSchedulers.size).toBe(2);
      expect(shadowSyncSchedulers.has(projectA)).toBe(true);
      expect(shadowSyncSchedulers.has(projectB)).toBe(true);
      expect(startSpy).toHaveBeenCalledTimes(2);
    });

    // AC: @config-shadow ac-16
    it("should be idempotent — registering the same project twice creates only one scheduler", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);
      await startShadowSyncForProject(projectA, pubsub, getCache);

      expect(shadowSyncSchedulers.size).toBe(1);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it("should not create a scheduler when sync_interval is 0", async () => {
      setupConfigMock({ syncInterval: 0, hasRemote: true });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);

      expect(shadowSyncSchedulers.has(projectA)).toBe(false);
      expect(startSpy).not.toHaveBeenCalled();
    });

    // AC: @config-shadow ac-14 (task case (e): no remote tracking → no scheduler)
    it("should not create a scheduler when project has no shadow remote tracking configured", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: false });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);

      expect(shadowSyncSchedulers.has(projectA)).toBe(false);
      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe("stopShadowSyncForProject", () => {
    // AC: @config-shadow ac-15
    it("should stop and remove a scheduler for an unregistered project", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);
      expect(shadowSyncSchedulers.has(projectA)).toBe(true);

      stopShadowSyncForProject(projectA);

      expect(shadowSyncSchedulers.has(projectA)).toBe(false);
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it("should be safe to call for a project that has no scheduler", () => {
      // Should not throw
      stopShadowSyncForProject("/nonexistent/project");
      expect(stopSpy).not.toHaveBeenCalled();
    });
  });

  describe("Shutdown — stop all schedulers", () => {
    // AC: @config-shadow ac-17
    it("should stop all shadow sync schedulers when iterating the map", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);
      await startShadowSyncForProject(projectB, pubsub, getCache);
      expect(shadowSyncSchedulers.size).toBe(2);

      // Simulate the shutdown handler pattern from server.ts
      for (const scheduler of shadowSyncSchedulers.values()) {
        scheduler.stop();
      }
      shadowSyncSchedulers.clear();

      expect(shadowSyncSchedulers.size).toBe(0);
      expect(stopSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("Single-project regression guard", () => {
    // AC: @config-shadow ac-13 (regression: startup project still works)
    it("should still work when only the startup project is registered", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });
      const pubsub = mockPubsub();
      const getCache = mockGetEntityCache();

      await startShadowSyncForProject(projectA, pubsub, getCache);

      expect(shadowSyncSchedulers.size).toBe(1);
      expect(shadowSyncSchedulers.has(projectA)).toBe(true);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Per-project onPull handler", () => {
    // AC: @config-shadow ac-13 (per-project cache refresh)
    it("should refresh the correct project's shadow metadata cache on pull", async () => {
      const cacheA: ShadowPullReloadableCache = {
        refreshMetaShadowInfo: vi.fn().mockResolvedValue(undefined),
      };
      const cacheB: ShadowPullReloadableCache = {
        refreshMetaShadowInfo: vi.fn().mockResolvedValue(undefined),
      };

      const getCache = vi.fn((projectPath: string) => {
        if (projectPath === projectA) return cacheA;
        if (projectPath === projectB) return cacheB;
        return undefined;
      });

      // Create onPull handler for project B
      const onPullB = createShadowSyncOnPullHandler(projectB, getCache);
      await onPullB();

      // Should refresh project B's cache, not project A's
      expect(cacheB.refreshMetaShadowInfo).toHaveBeenCalledTimes(1);
      expect(cacheA.refreshMetaShadowInfo).not.toHaveBeenCalled();
    });

    it("should handle missing cache gracefully", async () => {
      const getCache = vi.fn().mockReturnValue(undefined);

      const onPull = createShadowSyncOnPullHandler("/nonexistent", getCache);

      // Should not throw
      await onPull();
      expect(getCache).toHaveBeenCalledWith("/nonexistent");
    });
  });

  describe("Integration with registration callbacks", () => {
    // AC: @config-shadow ac-14
    it("should start shadow sync when project is registered via POST /api/projects", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });

      const { ProjectContextManager } = await import(
        "../packages/daemon/src/project-context"
      );
      const { createProjectsRoutes } = await import(
        "../packages/daemon/src/routes/projects"
      );

      const onRegistered = vi.fn(async (projectPath: string) => {
        await startShadowSyncForProject(projectPath, mockPubsub(), mockGetEntityCache());
      });
      const manager = new ProjectContextManager();

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(routes);

      const response = await app.handle(
        new Request("http://localhost/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: projectA }),
        }),
      );

      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
      expect(shadowSyncSchedulers.has(projectA)).toBe(true);
      expect(startSpy).toHaveBeenCalled();
    });

    // AC: @config-shadow ac-14
    it("should start shadow sync when project is auto-registered via middleware", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });

      const { projectContextMiddleware } = await import(
        "../packages/daemon/src/middleware/project-context"
      );

      const onRegistered = vi.fn(async (projectPath: string) => {
        await startShadowSyncForProject(projectPath, mockPubsub(), mockGetEntityCache());
      });

      const { middleware } = projectContextMiddleware({
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(middleware).get("/api/test", () => ({ ok: true }));

      const response = await app.handle(
        new Request("http://localhost/api/test", {
          headers: {
            Host: "localhost",
            "X-Kspec-Dir": projectB,
          },
        }),
      );

      expect(response.status).toBe(200);
      // Middleware fires onProjectRegistered fire-and-forget — wait for it
      await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(shadowSyncSchedulers.has(projectB)).toBe(true));
    });

    // AC: @config-shadow ac-14
    it("should start shadow sync when project is registered via WebSocket resolution", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });

      const { ProjectContextManager } = await import(
        "../packages/daemon/src/project-context"
      );
      const { resolveWebSocketProject } = await import(
        "../packages/daemon/src/websocket/project-resolution"
      );

      const manager = new ProjectContextManager();
      const startWatcherSpy = vi.spyOn(manager, "startWatcher").mockResolvedValue(undefined);

      const onRegistered = vi.fn(async (projectPath: string) => {
        await startShadowSyncForProject(projectPath, mockPubsub(), mockGetEntityCache());
      });

      const request = new Request("http://localhost/ws", {
        headers: { Host: "localhost", "X-Kspec-Dir": projectA },
      });

      const result = await resolveWebSocketProject({
        request,
        manager,
        fallbackPath: "/fallback",
        onProjectRegistered: onRegistered,
      });

      expect(result.resolvedPath).toBe(projectA);
      expect(result.wasRegistered).toBe(true);
      expect(startWatcherSpy).toHaveBeenCalledWith(projectA);

      // onProjectRegistered is fire-and-forget — wait for the scheduler to appear
      await vi.waitFor(() => expect(shadowSyncSchedulers.has(projectA)).toBe(true));
      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(startSpy).toHaveBeenCalled();

      startWatcherSpy.mockRestore();
    });

    // AC: @config-shadow ac-15
    it("should stop shadow sync when project is unregistered via DELETE", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });

      // Pre-populate a scheduler for projectA
      await startShadowSyncForProject(projectA, mockPubsub(), mockGetEntityCache());
      expect(shadowSyncSchedulers.has(projectA)).toBe(true);

      const { ProjectContextManager } = await import(
        "../packages/daemon/src/project-context"
      );

      const manager = new ProjectContextManager();
      manager.registerProject(projectA);

      // Wire unregister callback the same way server.ts does
      manager.setUnregisterCallback((projectPath: string) => {
        stopShadowSyncForProject(projectPath);
      });

      const { createProjectsRoutes } = await import(
        "../packages/daemon/src/routes/projects"
      );

      const routes = createProjectsRoutes({
        projectManager: manager,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(routes);

      const encodedPath = encodeURIComponent(projectA);
      const response = await app.handle(
        new Request(`http://localhost/api/projects/${encodedPath}`, {
          method: "DELETE",
        }),
      );

      expect(response.status).toBe(200);
      expect(shadowSyncSchedulers.has(projectA)).toBe(false);
      expect(stopSpy).toHaveBeenCalled();
    });

    // AC: @config-shadow ac-15
    it("should stop shadow sync when watcher reports permanent failure", async () => {
      setupConfigMock({ syncInterval: 60, hasRemote: true });

      // Pre-populate a scheduler for projectA
      await startShadowSyncForProject(projectA, mockPubsub(), mockGetEntityCache());
      expect(shadowSyncSchedulers.has(projectA)).toBe(true);

      const { ProjectContextManager } = await import(
        "../packages/daemon/src/project-context"
      );

      const manager = new ProjectContextManager();
      manager.registerProject(projectA);

      // Wire unregister callback the same way server.ts does — covers both
      // API DELETE and watcher-permanent-failure paths
      manager.setUnregisterCallback((projectPath: string) => {
        stopShadowSyncForProject(projectPath);
      });

      // Simulate watcher permanent failure by calling unregisterProject directly,
      // which is what the onPermanentFailure callback in project-context does
      manager.unregisterProject(projectA);

      expect(shadowSyncSchedulers.has(projectA)).toBe(false);
      expect(stopSpy).toHaveBeenCalled();
      // Project should also be removed from the manager
      expect(manager.hasProject(projectA)).toBe(false);
    });
  });
});
