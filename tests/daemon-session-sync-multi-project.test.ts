/**
 * Tests for multi-project session sync in daemon
 *
 * Verifies that session sync schedulers are started/stopped for projects
 * registered and unregistered via the projects API and middleware auto-registration.
 *
 * Task: @01KKBD6KH5F5MVC5BXV2NQG474
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupMultiDirFixtures, cleanupTempDir } from "./helpers/cli";
import { join } from "path";
import { ProjectContextManager } from "../packages/daemon/src/project-context";
import { createProjectsRoutes } from "../packages/daemon/src/routes/projects";
import { resolveWebSocketProject } from "../packages/daemon/src/websocket/project-resolution";

describe("Multi-project session sync", () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, "project-a");
    projectB = join(fixturesRoot, "project-b");
  });

  afterEach(async () => {
    await cleanupTempDir(fixturesRoot);
  });

  describe("Projects API callbacks", () => {
    it("should call onProjectRegistered when project is registered via POST", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const onUnregistered = vi.fn();
      const manager = new ProjectContextManager();

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
        onProjectUnregistered: onUnregistered,
      });

      // Use Elysia's handler directly by creating a test app
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
      const body = await response.json();
      expect(body.success).toBe(true);

      // onProjectRegistered should have been called with the normalized project path
      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(onRegistered).toHaveBeenCalledWith(projectA);
    });

    it("should call onProjectUnregistered when project is unregistered via DELETE", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const onUnregistered = vi.fn();
      const manager = new ProjectContextManager();
      manager.registerProject(projectA);

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
        onProjectUnregistered: onUnregistered,
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
      const body = await response.json();
      expect(body.success).toBe(true);

      // onProjectUnregistered should have been called
      expect(onUnregistered).toHaveBeenCalledTimes(1);
      expect(onUnregistered).toHaveBeenCalledWith(projectA);
    });

    it("should normalize path before calling onProjectUnregistered (regression: non-canonical DELETE)", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const onUnregistered = vi.fn();
      const manager = new ProjectContextManager();
      // Register with canonical path
      manager.registerProject(projectA);

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
        onProjectUnregistered: onUnregistered,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(routes);

      // DELETE with non-canonical path (trailing "/./" appended)
      const nonCanonicalPath = `${projectA}/./`;
      const encodedPath = encodeURIComponent(nonCanonicalPath);
      const response = await app.handle(
        new Request(`http://localhost/api/projects/${encodedPath}`, {
          method: "DELETE",
        }),
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);

      // onProjectUnregistered should receive the normalized path, not the raw non-canonical one
      expect(onUnregistered).toHaveBeenCalledTimes(1);
      expect(onUnregistered).toHaveBeenCalledWith(projectA);
      expect(onUnregistered).not.toHaveBeenCalledWith(nonCanonicalPath);
    });

    it("should not fail registration if onProjectRegistered throws", async () => {
      const onRegistered = vi.fn().mockRejectedValue(new Error("Session sync failed"));
      const manager = new ProjectContextManager();

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(routes);

      // Suppress expected error log
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const response = await app.handle(
          new Request("http://localhost/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: projectA }),
          }),
        );

        // Registration should still succeed even if session sync callback fails
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);

        // Project should be registered
        expect(manager.hasProject(projectA)).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("should work without callbacks (backward compatible)", async () => {
      const manager = new ProjectContextManager();

      // No callbacks provided — should still work
      const routes = createProjectsRoutes({
        projectManager: manager,
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
      expect(manager.hasProject(projectA)).toBe(true);
    });
  });

  describe("getOrRegisterProject (shared by WebSocket, middleware, and API)", () => {
    it("should register new project and return wasRegistered=true", () => {
      const manager = new ProjectContextManager();

      const result = manager.getOrRegisterProject(projectA);

      expect(result.wasRegistered).toBe(true);
      expect(result.context.path).toBe(projectA);
      expect(manager.hasProject(projectA)).toBe(true);
    });

    it("should return existing project with wasRegistered=false", () => {
      const manager = new ProjectContextManager();
      manager.registerProject(projectA);

      const result = manager.getOrRegisterProject(projectA);

      expect(result.wasRegistered).toBe(false);
      expect(result.context.path).toBe(projectA);
    });

    it("should normalize path and return normalized context", () => {
      const manager = new ProjectContextManager();
      const nonNormalizedPath = `${projectA}/./`;

      const result = manager.getOrRegisterProject(nonNormalizedPath);

      expect(result.wasRegistered).toBe(true);
      // Context path should be normalized
      expect(result.context.path).toBe(projectA);
      // Subsequent call with normalized path should find the same project
      const result2 = manager.getOrRegisterProject(projectA);
      expect(result2.wasRegistered).toBe(false);
      expect(result2.context.path).toBe(projectA);
    });

    it("should not double-register when called with same non-normalized path twice", () => {
      const manager = new ProjectContextManager();
      const nonNormalizedPath = `${projectA}/./`;

      const result1 = manager.getOrRegisterProject(nonNormalizedPath);
      const result2 = manager.getOrRegisterProject(nonNormalizedPath);

      expect(result1.wasRegistered).toBe(true);
      expect(result2.wasRegistered).toBe(false);
      expect(result1.context.path).toBe(projectA);
      expect(result2.context.path).toBe(projectA);
    });

    it("should enable callers to trigger session sync only for new registrations", async () => {
      // This test verifies the pattern used by WebSocket beforeHandle, middleware,
      // and projects API: call onProjectRegistered only when wasRegistered is true
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const manager = new ProjectContextManager();

      // First call — new registration, should trigger callback
      const result1 = manager.getOrRegisterProject(projectA);
      if (result1.wasRegistered) {
        await onRegistered(result1.context.path);
      }

      // Second call — already registered, should NOT trigger callback
      const result2 = manager.getOrRegisterProject(projectA);
      if (result2.wasRegistered) {
        await onRegistered(result2.context.path);
      }

      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(onRegistered).toHaveBeenCalledWith(projectA);
    });
  });

  describe("Middleware auto-registration callback", () => {
    it("should call onProjectRegistered when project is auto-registered via middleware", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const { projectContextMiddleware } =
        await import("../packages/daemon/src/middleware/project-context");

      const { manager: _manager, middleware } = projectContextMiddleware({
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(middleware).get("/api/test", () => ({ ok: true }));

      // First request with a new project path triggers auto-registration
      const response = await app.handle(
        new Request("http://localhost/api/test", {
          headers: {
            Host: "localhost",
            "X-Kspec-Dir": projectA,
          },
        }),
      );

      // The request should succeed (auto-registration)
      expect(response.status).toBe(200);

      // onProjectRegistered should have been called
      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(onRegistered).toHaveBeenCalledWith(projectA);
    });

    it("should normalize path before calling onProjectRegistered (regression: non-canonical header)", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const { projectContextMiddleware } =
        await import("../packages/daemon/src/middleware/project-context");

      const { manager: _manager2, middleware } = projectContextMiddleware({
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(middleware).get("/api/test", () => ({ ok: true }));

      // Send a request with a non-normalized path (trailing "/./")
      const nonNormalizedPath = `${projectA}/./`;
      const response = await app.handle(
        new Request("http://localhost/api/test", {
          headers: {
            Host: "localhost",
            "X-Kspec-Dir": nonNormalizedPath,
          },
        }),
      );

      expect(response.status).toBe(200);

      // Callback should receive the normalized path, not the raw header value
      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(onRegistered).toHaveBeenCalledWith(projectA);
      // Critically: NOT called with the non-normalized path
      expect(onRegistered).not.toHaveBeenCalledWith(nonNormalizedPath);
    });

    it("should not call onProjectRegistered for already-registered projects", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const { projectContextMiddleware } =
        await import("../packages/daemon/src/middleware/project-context");

      const { manager: _manager3, middleware } = projectContextMiddleware({
        startupProject: projectA,
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import("elysia");
      const app = new Elysia().use(middleware).get("/api/test", () => ({ ok: true }));

      // Startup project is already registered — should not trigger callback
      const response = await app.handle(
        new Request("http://localhost/api/test", {
          headers: {
            Host: "localhost",
            "X-Kspec-Dir": projectA,
          },
        }),
      );

      expect(response.status).toBe(200);
      expect(onRegistered).not.toHaveBeenCalled();
    });
  });

  describe("WebSocket registration path (resolveWebSocketProject)", () => {
    it("should call onProjectRegistered for new project via X-Kspec-Dir header", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const manager = new ProjectContextManager();

      const request = new Request("http://localhost/ws", {
        headers: { Host: "localhost", "X-Kspec-Dir": projectA },
      });

      const result = resolveWebSocketProject({
        request,
        manager,
        fallbackPath: "/fallback",
        onProjectRegistered: onRegistered,
      });

      expect(result.resolvedPath).toBe(projectA);
      expect(result.wasRegistered).toBe(true);

      // Allow the void promise to settle
      await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
      expect(onRegistered).toHaveBeenCalledWith(projectA);
    });

    it("should call onProjectRegistered for new project via ?project= query param", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const manager = new ProjectContextManager();

      const encodedPath = encodeURIComponent(projectB);
      const request = new Request(`http://localhost/ws?project=${encodedPath}`, {
        headers: { Host: "localhost" },
      });

      const result = resolveWebSocketProject({
        request,
        manager,
        fallbackPath: "/fallback",
        onProjectRegistered: onRegistered,
      });

      expect(result.resolvedPath).toBe(projectB);
      expect(result.wasRegistered).toBe(true);

      await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
      expect(onRegistered).toHaveBeenCalledWith(projectB);
    });

    it("should NOT call onProjectRegistered for already-registered project", () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const manager = new ProjectContextManager();
      manager.registerProject(projectA);

      const request = new Request("http://localhost/ws", {
        headers: { Host: "localhost", "X-Kspec-Dir": projectA },
      });

      const result = resolveWebSocketProject({
        request,
        manager,
        fallbackPath: "/fallback",
        onProjectRegistered: onRegistered,
      });

      expect(result.resolvedPath).toBe(projectA);
      expect(result.wasRegistered).toBe(false);
      expect(onRegistered).not.toHaveBeenCalled();
    });

    it("should normalize non-canonical path before calling onProjectRegistered (regression)", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const manager = new ProjectContextManager();

      const nonCanonicalPath = `${projectA}/./`;
      const request = new Request("http://localhost/ws", {
        headers: { Host: "localhost", "X-Kspec-Dir": nonCanonicalPath },
      });

      const result = resolveWebSocketProject({
        request,
        manager,
        fallbackPath: "/fallback",
        onProjectRegistered: onRegistered,
      });

      // Should resolve to the normalized path
      expect(result.resolvedPath).toBe(projectA);
      expect(result.wasRegistered).toBe(true);

      await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
      // Callback receives the normalized path, not the raw non-canonical one
      expect(onRegistered).toHaveBeenCalledWith(projectA);
      expect(onRegistered).not.toHaveBeenCalledWith(nonCanonicalPath);
    });

    it("should use default project when no project path is specified", () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const manager = new ProjectContextManager(projectA);
      manager.registerProject(projectA);

      const request = new Request("http://localhost/ws", {
        headers: { Host: "localhost" },
      });

      const result = resolveWebSocketProject({
        request,
        manager,
        fallbackPath: "/fallback",
        onProjectRegistered: onRegistered,
      });

      expect(result.resolvedPath).toBe(projectA);
      expect(result.wasRegistered).toBe(false);
      expect(onRegistered).not.toHaveBeenCalled();
    });

    it("should throw when no project path specified and no default project", () => {
      const manager = new ProjectContextManager();

      const request = new Request("http://localhost/ws", {
        headers: { Host: "localhost" },
      });

      expect(() =>
        resolveWebSocketProject({
          request,
          manager,
          fallbackPath: "/fallback",
        }),
      ).toThrow("No project specified");
    });

    it("should prefer X-Kspec-Dir header over ?project= query param", async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const manager = new ProjectContextManager();

      const encodedB = encodeURIComponent(projectB);
      const request = new Request(`http://localhost/ws?project=${encodedB}`, {
        headers: { Host: "localhost", "X-Kspec-Dir": projectA },
      });

      const result = resolveWebSocketProject({
        request,
        manager,
        fallbackPath: "/fallback",
        onProjectRegistered: onRegistered,
      });

      // Header takes precedence
      expect(result.resolvedPath).toBe(projectA);
      expect(result.wasRegistered).toBe(true);

      await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
      expect(onRegistered).toHaveBeenCalledWith(projectA);
    });
  });
});
