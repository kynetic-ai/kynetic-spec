// AC: @multi-directory-daemon ac-28 — GET /api/projects returns list with paths, registration time, watcher status
// AC: @multi-directory-daemon ac-29 — POST /api/projects with {path} body for manual registration
// AC: @multi-directory-daemon ac-30 — DELETE /api/projects/:encodedPath unregisters project and stops watcher
// AC: @trait-localhost-security ac-loopback-default — N/A: projects route handler tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket lifecycle not tested in projects API tests
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket subscribe not tested in projects API tests
// AC: @trait-websocket-protocol ac-3 — N/A: WebSocket broadcast not tested in projects API tests
// AC: @trait-websocket-protocol ac-4 — N/A: WebSocket heartbeat not tested in projects API tests
// AC: @trait-websocket-protocol ac-5 — N/A: WebSocket ping/pong not tested in projects API tests
// AC: @trait-websocket-protocol ac-6 — N/A: WebSocket backpressure not tested in projects API tests
// AC: @trait-websocket-protocol ac-7 — N/A: WebSocket close codes not tested in projects API tests
// AC: @trait-websocket-protocol ac-8 — N/A: WebSocket reconnection not tested in projects API tests
import { Elysia } from "elysia";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempDir, initGitRepo, setupFixtures } from "./helpers.js";
// Import from dist (same as helpers.ts pattern) to match the built output
import { projectContextMiddleware } from "../../dist/daemon/middleware/project-context.js";
import { createProjectsRoutes } from "../../dist/daemon/routes/projects.js";

let tempDir: string;
let app: Elysia;

/**
 * Create an additional kspec project directory for multi-project tests.
 */
function createProjectDir(parentDir: string, name: string): string {
  const dir = path.join(parentDir, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(dir, ".kspec"), { recursive: true });
  writeFileSync(
    path.join(dir, ".kspec", "kynetic.yaml"),
    `kynetic: "1.0"\nproject:\n  name: ${name}\n  version: "0.1.0"\n  status: draft\n`,
  );
  initGitRepo(dir);
  return dir;
}

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-projects-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);

  // Use startupProject so the middleware has a default project context.
  // Without X-Kspec-Dir in requests, the middleware uses this default.
  const { middleware, manager } = projectContextMiddleware({ startupProject: tempDir });
  app = new Elysia()
    // Polyfill Elysia's `error` function for app.handle() in Node.js.
    .resolve(({ set }) => ({
      error: (status: number, body: unknown) => {
        set.status = status;
        return body;
      },
    }))
    .use(middleware)
    .use(
      createProjectsRoutes({
        projectManager: manager,
      }),
    );
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  const headers: Record<string, string> = {
    Host: "localhost",
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body,
    }),
  );
}

describe("GET /api/projects", () => {
  it("returns list shape with projects array and total", async () => {
    const response = await request("/api/projects");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: unknown[]; total: number };
    expect(body).toHaveProperty("projects");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.projects.length);
  });

  it("returns JSON content type", async () => {
    const response = await request("/api/projects");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("each project has required fields: path, registeredAt, watcherStatus", async () => {
    // tempDir is already registered via startupProject
    const response = await request("/api/projects");
    const body = (await response.json()) as {
      projects: Array<Record<string, unknown>>;
    };
    expect(body.projects.length).toBeGreaterThan(0);
    const project = body.projects[0];
    expect(project).toHaveProperty("path");
    expect(typeof project.path).toBe("string");

    expect(project).toHaveProperty("registeredAt");
    expect(typeof project.registeredAt).toBe("string");
    // registeredAt should be a valid ISO 8601 date
    expect(new Date(project.registeredAt as string).getTime()).not.toBeNaN();

    expect(project).toHaveProperty("watcherStatus");
    expect(["active", "stopped"]).toContain(project.watcherStatus);
  });

  it("project paths are absolute", async () => {
    const response = await request("/api/projects");
    const body = (await response.json()) as {
      projects: Array<{ path: string }>;
    };
    for (const project of body.projects) {
      expect(path.isAbsolute(project.path)).toBe(true);
    }
  });

  it("second registered project appears in list with full fields", async () => {
    const secondDir = createProjectDir(tempDir, "second-project");

    await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: secondDir }),
    });

    const response = await request("/api/projects");
    const body = (await response.json()) as {
      projects: Array<{ path: string; registeredAt: string; watcherStatus: string }>;
    };
    expect(body.projects.length).toBeGreaterThanOrEqual(2);
    const found = body.projects.find((p) => p.path === secondDir);
    expect(found).toBeDefined();
    expect(found!.registeredAt).toBeTruthy();
    expect(["active", "stopped"]).toContain(found!.watcherStatus);
  });
});

describe("POST /api/projects", () => {
  it("returns success and project with path, registeredAt, watcherStatus", async () => {
    const newDir = createProjectDir(tempDir, "new-project");
    const response = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: newDir }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      project: { path: string; registeredAt: string; watcherStatus: string };
    };
    expect(body).toHaveProperty("success");
    expect(body.success).toBe(true);
    expect(body).toHaveProperty("project");

    const project = body.project;
    expect(project).toHaveProperty("path");
    expect(project.path).toBe(newDir);
    expect(project).toHaveProperty("registeredAt");
    expect(typeof project.registeredAt).toBe("string");
    expect(project).toHaveProperty("watcherStatus");
    expect(["active", "stopped"]).toContain(project.watcherStatus);
  });

  it("returns 400 for non-absolute path", async () => {
    const response = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: "relative/path" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 for path with .. segments", async () => {
    const response = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: "/some/../path" }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 400 when directory has no .kspec folder", async () => {
    const noKspecDir = path.join(tempDir, "no-kspec");
    mkdirSync(noKspecDir, { recursive: true });
    initGitRepo(noKspecDir);

    const response = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: noKspecDir }),
    });
    expect(response.status).toBe(400);
  });

  it("registered project appears in subsequent list", async () => {
    const newDir = createProjectDir(tempDir, "listed-project");
    await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: newDir }),
    });

    const listResponse = await request("/api/projects");
    const body = (await listResponse.json()) as {
      projects: Array<{ path: string }>;
    };
    const paths = body.projects.map((p) => p.path);
    expect(paths).toContain(newDir);
  });

  it("returns 400 for missing path field", async () => {
    const response = await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/projects/:encodedPath", () => {
  it("unregisters project and returns success payload", async () => {
    // Register a secondary project to delete (keep tempDir as default)
    const targetDir = createProjectDir(tempDir, "delete-target");
    await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: targetDir }),
    });

    const encoded = encodeURIComponent(targetDir);
    const response = await request(`/api/projects/${encoded}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean };
    expect(body).toHaveProperty("success");
    expect(body.success).toBe(true);
  });

  it("project is gone from list after deletion", async () => {
    const targetDir = createProjectDir(tempDir, "delete-verify");
    await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: targetDir }),
    });

    const encoded = encodeURIComponent(targetDir);
    await request(`/api/projects/${encoded}`, { method: "DELETE" });

    const listResponse = await request("/api/projects");
    const body = (await listResponse.json()) as {
      projects: Array<{ path: string }>;
    };
    const paths = body.projects.map((p) => p.path);
    expect(paths).not.toContain(targetDir);
  });

  it("returns 404 for non-registered path", async () => {
    const nonRegistered = path.join(tempDir, "not-registered");
    const encoded = encodeURIComponent(nonRegistered);
    const response = await request(`/api/projects/${encoded}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });

  it("correctly URL-decodes path parameter", async () => {
    const targetDir = createProjectDir(tempDir, "decode-target");
    await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: targetDir }),
    });

    // targetDir will contain slashes and possibly hyphens — encode and verify decode works
    const encoded = encodeURIComponent(targetDir);
    expect(encoded).not.toBe(targetDir); // Should be encoded
    const response = await request(`/api/projects/${encoded}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
  });

  it("removing one project does not affect others", async () => {
    const targetDir = createProjectDir(tempDir, "remove-target");
    const keepDir = createProjectDir(tempDir, "keep-project");

    await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: targetDir }),
    });
    await request("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path: keepDir }),
    });

    const encoded = encodeURIComponent(targetDir);
    await request(`/api/projects/${encoded}`, { method: "DELETE" });

    const listResponse = await request("/api/projects");
    const body = (await listResponse.json()) as {
      projects: Array<{ path: string }>;
    };
    const paths = body.projects.map((p) => p.path);
    expect(paths).toContain(keepDir);
    expect(paths).not.toContain(targetDir);
  });
});
