/**
 * E2E API Tests for Daemon Projects Endpoints
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 * These replace the static analysis tests in tests/daemon-api-projects.test.ts
 * which used existsSync guards and skipped most assertions when implementation was pending.
 *
 * Covered ACs:
 * - @multi-directory-daemon ac-28: GET /api/projects returns list with paths, registration time, watcher status
 * - @multi-directory-daemon ac-29: POST /api/projects with {path} body for manual registration
 * - @multi-directory-daemon ac-30: DELETE /api/projects/:encodedPath unregisters project and stops watcher
 */

// Trait N/A annotations — @multi-directory-daemon inherits from @trait-localhost-security and @trait-websocket-protocol:
// AC: @trait-localhost-security ac-1 — N/A: localhost binding tested in api-server.spec.ts
// AC: @trait-localhost-security ac-2 — N/A: non-localhost rejection tested in api-server.spec.ts
// AC: @trait-localhost-security ac-3 — N/A: external binding warning not tested (never configured in tests)
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket connection lifecycle tested in future api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket subscribe tested in future api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-3 — N/A: WebSocket broadcast format tested in future api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-4 — N/A: WebSocket heartbeat timing tested in future api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-5 — N/A: WebSocket ping/pong timeout tested in future api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-6 — N/A: WebSocket backpressure tested in future api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-7 — N/A: WebSocket close codes tested in future api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-8 — N/A: WebSocket reconnection tested in future api-websocket.spec.ts

import { test, expect } from "../fixtures/test-base";

test.describe("Projects API", () => {
  test.describe("GET /api/projects", () => {
    // AC: @multi-directory-daemon ac-28
    test("returns list of registered projects with paths, registeredAt, and watcherStatus", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/projects`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      // Response shape: { projects: [...], total: N }
      expect(body).toHaveProperty("projects");
      expect(body).toHaveProperty("total");
      expect(Array.isArray(body.projects)).toBe(true);

      // Daemon always has at least the default project registered
      expect(body.projects.length).toBeGreaterThan(0);
      expect(body.total).toBe(body.projects.length);
    });

    // AC: @multi-directory-daemon ac-28
    test("each project has required fields: path, registeredAt, watcherStatus", async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${daemon.baseUrl}/api/projects`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body.projects.length).toBeGreaterThan(0);

      const project = body.projects[0];
      // AC: @multi-directory-daemon ac-28 — include paths, registration time, watcher status
      expect(project).toHaveProperty("path");
      expect(typeof project.path).toBe("string");
      expect(project.path.length).toBeGreaterThan(0);

      expect(project).toHaveProperty("registeredAt");
      expect(typeof project.registeredAt).toBe("string");
      // registeredAt should be a valid ISO 8601 date
      expect(() => new Date(project.registeredAt)).not.toThrow();
      expect(new Date(project.registeredAt).getTime()).not.toBeNaN();

      expect(project).toHaveProperty("watcherStatus");
      expect(["active", "stopped"]).toContain(project.watcherStatus);
    });

    // AC: @multi-directory-daemon ac-28
    test("returns JSON content type", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/projects`);
      expect(response.status()).toBe(200);

      const contentType = response.headers()["content-type"] || "";
      expect(contentType).toContain("application/json");
    });

    // AC: @multi-directory-daemon ac-28 — default project path is absolute
    test("project paths are absolute filesystem paths", async ({ request, daemon }) => {
      const response = await request.get(`${daemon.baseUrl}/api/projects`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      for (const project of body.projects) {
        // Absolute paths start with / on Unix or drive letter on Windows
        expect(project.path).toMatch(/^(\/|[A-Z]:\\)/);
      }
    });

    // AC: @multi-directory-daemon ac-28 — after registering a second project, list updates
    test("registered second project appears in project list", async ({ request, daemon }) => {
      // Register a second project
      const secondPath = await daemon.createSecondProject();

      const response = await request.get(`${daemon.baseUrl}/api/projects`);
      expect(response.status()).toBe(200);

      const body = await response.json();
      // Should now have at least 2 projects
      expect(body.projects.length).toBeGreaterThanOrEqual(2);

      // The second project should be in the list
      const found = body.projects.find((p: { path: string }) => p.path === secondPath);
      expect(found).toBeDefined();
      expect(found.path).toBe(secondPath);
      expect(found.registeredAt).toBeTruthy();
      expect(["active", "stopped"]).toContain(found.watcherStatus);
    });
  });

  test.describe("POST /api/projects", () => {
    // AC: @multi-directory-daemon ac-29 — POST /api/projects returns {success, project} shape
    test("accepts {path} body and returns {success: true, project: {path, registeredAt, watcherStatus}}", async ({
      request,
      daemon,
    }) => {
      // Set up a valid second project directory structure
      const secondPath = await daemon.createSecondProject();

      // Unregister so we can re-register and capture the direct POST response
      const encodedPath = encodeURIComponent(secondPath);
      await request.delete(`${daemon.baseUrl}/api/projects/${encodedPath}`);

      // AC: @multi-directory-daemon ac-29 — POST with {path} body, verify response shape
      const registerResponse = await request.post(`${daemon.baseUrl}/api/projects`, {
        data: { path: secondPath },
      });

      expect(registerResponse.status()).toBe(200);

      const body = await registerResponse.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);
      expect(body).toHaveProperty("project");

      const project = body.project;
      expect(project).toHaveProperty("path");
      expect(project.path).toBe(secondPath);
      expect(project).toHaveProperty("registeredAt");
      expect(typeof project.registeredAt).toBe("string");
      expect(project).toHaveProperty("watcherStatus");
      expect(["active", "stopped"]).toContain(project.watcherStatus);
    });

    // AC: @multi-directory-daemon ac-29 — POST /api/projects validates path is absolute
    // (Note: ac-6/ac-7/ac-5 are for X-Kspec-Dir header validation; POST /api/projects
    // mirrors those rules for the request body {path} field as part of ac-29 path validation)
    test("returns 400 when path is not absolute", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/projects`, {
        data: { path: "relative/path/without/slash" },
      });

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toMatch(/absolute|Path must be/i);
    });

    // AC: @multi-directory-daemon ac-29 — POST /api/projects rejects parent traversal in path
    test('returns 400 when path contains ".." segments', async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/projects`, {
        data: { path: "/tmp/../etc" },
      });

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toMatch(/parent traversal/i);
    });

    // AC: @multi-directory-daemon ac-29 — POST /api/projects rejects paths without .kspec/
    test("returns 400 for path without .kspec/ directory", async ({ request, daemon }) => {
      const response = await request.post(`${daemon.baseUrl}/api/projects`, {
        data: { path: "/tmp" }, // /tmp exists but has no .kspec/
      });

      expect(response.status()).toBe(400);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toMatch(/\.kspec\//i);
    });

    // AC: @multi-directory-daemon ac-29 — registered project appears in list
    test("newly registered project appears in GET /api/projects", async ({ request, daemon }) => {
      const secondPath = await daemon.createSecondProject();

      const listResponse = await request.get(`${daemon.baseUrl}/api/projects`);
      expect(listResponse.status()).toBe(200);

      const listBody = await listResponse.json();
      const found = listBody.projects.find((p: { path: string }) => p.path === secondPath);
      expect(found).toBeDefined();
      expect(found.watcherStatus).toMatch(/active|stopped/);
    });
  });

  test.describe("DELETE /api/projects/:encodedPath", () => {
    // AC: @multi-directory-daemon ac-30
    test("unregisters project and returns success", async ({ request, daemon }) => {
      // Register a second project first
      const secondPath = await daemon.createSecondProject();

      // Encode the path for URL
      const encodedPath = encodeURIComponent(secondPath);

      // AC: @multi-directory-daemon ac-30 — DELETE to unregister
      const response = await request.delete(`${daemon.baseUrl}/api/projects/${encodedPath}`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);
    });

    // AC: @multi-directory-daemon ac-30 — project no longer appears in list after unregister
    test("unregistered project no longer appears in GET /api/projects", async ({
      request,
      daemon,
    }) => {
      // Register a second project
      const secondPath = await daemon.createSecondProject();

      // Verify it's registered
      const beforeResponse = await request.get(`${daemon.baseUrl}/api/projects`);
      const beforeBody = await beforeResponse.json();
      const foundBefore = beforeBody.projects.find((p: { path: string }) => p.path === secondPath);
      expect(foundBefore).toBeDefined();

      // Unregister it
      const encodedPath = encodeURIComponent(secondPath);
      const deleteResponse = await request.delete(`${daemon.baseUrl}/api/projects/${encodedPath}`);
      expect(deleteResponse.status()).toBe(200);

      // Verify it's gone from the list
      const afterResponse = await request.get(`${daemon.baseUrl}/api/projects`);
      const afterBody = await afterResponse.json();
      const foundAfter = afterBody.projects.find((p: { path: string }) => p.path === secondPath);
      expect(foundAfter).toBeUndefined();
    });

    // AC: @multi-directory-daemon ac-30 — 404 for non-registered project
    test("returns 404 when deleting a project that is not registered", async ({
      request,
      daemon,
    }) => {
      const fakePath = "/tmp/nonexistent-project-xyz-99999";
      const encodedPath = encodeURIComponent(fakePath);

      const response = await request.delete(`${daemon.baseUrl}/api/projects/${encodedPath}`);

      expect(response.status()).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toMatch(/not registered|not_found/i);
    });

    // AC: @multi-directory-daemon ac-30 — URL-encoded paths are decoded correctly
    test("decodes URL-encoded path correctly", async ({ request, daemon }) => {
      const secondPath = await daemon.createSecondProject();

      // Encode the path (paths with special chars)
      const encodedPath = encodeURIComponent(secondPath);

      // Verify encoding is applied (path should have URL-encoded chars if it has /)
      expect(encodedPath).not.toContain("/");

      const response = await request.delete(`${daemon.baseUrl}/api/projects/${encodedPath}`);

      // Should successfully decode and delete
      expect(response.status()).toBe(200);
    });

    // AC: @multi-directory-daemon ac-30 — watcher stops on unregister
    test("project list shows removed project after unregister (watcher cleanup implicit)", async ({
      request,
      daemon,
    }) => {
      const secondPath = await daemon.createSecondProject();
      const encodedPath = encodeURIComponent(secondPath);

      // Unregister (stops watcher as part of unregister)
      await request.delete(`${daemon.baseUrl}/api/projects/${encodedPath}`);

      // Project should not be in list (verifies cleanup happened)
      const listResponse = await request.get(`${daemon.baseUrl}/api/projects`);
      const listBody = await listResponse.json();
      const found = listBody.projects.find((p: { path: string }) => p.path === secondPath);
      expect(found).toBeUndefined();
    });
  });
});
