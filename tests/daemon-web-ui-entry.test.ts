/**
 * Tests for the daemon web UI entry document helper.
 *
 * Spec:
 * - @daemon-server ac-root-route-current-entry
 * - @daemon-server ac-app-route-current-entry
 * - @daemon-web-ui-bundle ac-entry-unavailable-during-replacement
 * - @daemon-web-ui-bundle ac-entry-recovers-after-replacement
 * - @daemon-web-ui-bundle ac-reload-uses-current-entry
 *
 * The helper is exercised both directly (covering the missing/recover/cache
 * cases) and via a real Elysia app with the daemon's SPA fallback routes
 * registered (covering root + application route AC).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Elysia } from "elysia";
import {
  serveWebUiEntry,
  registerWebUiEntryRoutes,
  WEB_UI_ENTRY_ROUTES,
} from "../dist/daemon/web-ui-entry.js";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `kspec-web-ui-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeIndex(content: string): void {
  writeFileSync(join(tempDir, "index.html"), content);
}

async function readBody(response: Response): Promise<string> {
  return await response.text();
}

function urlFor(path: string): string {
  return `http://localhost${path}`;
}

describe("serveWebUiEntry", () => {
  // AC: @daemon-server ac-root-route-current-entry
  // AC: @daemon-web-ui-bundle ac-reload-uses-current-entry
  it("returns the current entry document on each call after the bundle changes", async () => {
    writeIndex("<!doctype html><html><body>OLD-ASSET-marker</body></html>");
    const first = serveWebUiEntry(tempDir);
    expect(first.status).toBe(200);
    expect(await readBody(first)).toContain("OLD-ASSET-marker");

    writeIndex("<!doctype html><html><body>NEW-ASSET-marker</body></html>");
    const second = serveWebUiEntry(tempDir);
    expect(second.status).toBe(200);
    const secondBody = await readBody(second);
    expect(secondBody).toContain("NEW-ASSET-marker");
    expect(secondBody).not.toContain("OLD-ASSET-marker");
  });

  it("returns text/html content type on successful entry responses", async () => {
    writeIndex("<!doctype html><html><body>x</body></html>");
    const response = serveWebUiEntry(tempDir);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  // AC: @daemon-web-ui-bundle ac-reload-uses-current-entry
  it("sets cache headers that require revalidation before reuse on success", async () => {
    writeIndex("<!doctype html><html><body>x</body></html>");
    const response = serveWebUiEntry(tempDir);
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl.length).toBeGreaterThan(0);
    expect(cacheControl).toMatch(/no-cache|no-store|must-revalidate|max-age=0/);
  });

  // AC: @daemon-web-ui-bundle ac-entry-unavailable-during-replacement
  it("returns HTTP 503 when the entry document is missing", async () => {
    const response = serveWebUiEntry(tempDir);
    expect(response.status).toBe(503);
  });

  // AC: @daemon-web-ui-bundle ac-entry-unavailable-during-replacement
  it("returns HTTP 503 when the web UI directory is null", async () => {
    const response = serveWebUiEntry(null);
    expect(response.status).toBe(503);
  });

  // AC: @daemon-web-ui-bundle ac-entry-unavailable-during-replacement
  it("503 responses set cache headers that prevent the response from being reused", async () => {
    const response = serveWebUiEntry(tempDir);
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl.length).toBeGreaterThan(0);
    expect(cacheControl).toMatch(/no-store|no-cache/);
  });

  // AC: @daemon-web-ui-bundle ac-entry-recovers-after-replacement
  it("recovers and serves the entry document when it becomes available after a 503", async () => {
    const missing = serveWebUiEntry(tempDir);
    expect(missing.status).toBe(503);

    writeIndex("<!doctype html><html><body>RECOVERED-marker</body></html>");
    const recovered = serveWebUiEntry(tempDir);
    expect(recovered.status).toBe(200);
    expect(await readBody(recovered)).toContain("RECOVERED-marker");
  });

  it("includes both root and application routes in the registered SPA route list", () => {
    expect(WEB_UI_ENTRY_ROUTES).toContain("/");
    expect(WEB_UI_ENTRY_ROUTES).toContain("/tasks");
    expect(WEB_UI_ENTRY_ROUTES).toContain("/items");
    expect(WEB_UI_ENTRY_ROUTES).toContain("/plans");
    expect(WEB_UI_ENTRY_ROUTES).toContain("/reviews");
  });
});

describe("registerWebUiEntryRoutes (Elysia integration)", () => {
  function buildApp(webUiPath: string | null): Elysia {
    const app = new Elysia();
    registerWebUiEntryRoutes(app, webUiPath);
    return app;
  }

  // AC: @daemon-server ac-root-route-current-entry
  it("root route serves the current entry document after the bundle changes", async () => {
    writeIndex("<!doctype html><html><body>OLD-ROOT-marker</body></html>");
    const app = buildApp(tempDir);

    const first = await app.handle(new Request(urlFor("/")));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("OLD-ROOT-marker");

    writeIndex("<!doctype html><html><body>NEW-ROOT-marker</body></html>");
    const second = await app.handle(new Request(urlFor("/")));
    expect(second.status).toBe(200);
    const body = await second.text();
    expect(body).toContain("NEW-ROOT-marker");
    expect(body).not.toContain("OLD-ROOT-marker");
  });

  // AC: @daemon-server ac-app-route-current-entry
  it("application route /tasks serves the current entry document after the bundle changes", async () => {
    writeIndex("<!doctype html><html><body>OLD-TASKS-marker</body></html>");
    const app = buildApp(tempDir);

    const first = await app.handle(new Request(urlFor("/tasks")));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("OLD-TASKS-marker");

    writeIndex("<!doctype html><html><body>NEW-TASKS-marker</body></html>");
    const second = await app.handle(new Request(urlFor("/tasks")));
    expect(second.status).toBe(200);
    const body = await second.text();
    expect(body).toContain("NEW-TASKS-marker");
    expect(body).not.toContain("OLD-TASKS-marker");
  });

  // AC: @daemon-server ac-app-route-current-entry
  it("other application routes (/items, /plans, /reviews) also serve the current entry document", async () => {
    writeIndex("<!doctype html><html><body>OLD-APP-marker</body></html>");
    const app = buildApp(tempDir);

    for (const route of ["/items", "/plans", "/reviews"]) {
      const first = await app.handle(new Request(urlFor(route)));
      expect(first.status, `route ${route} initial status`).toBe(200);
      expect(await first.text(), `route ${route} initial body`).toContain("OLD-APP-marker");
    }

    writeIndex("<!doctype html><html><body>NEW-APP-marker</body></html>");
    for (const route of ["/items", "/plans", "/reviews"]) {
      const next = await app.handle(new Request(urlFor(route)));
      expect(next.status, `route ${route} updated status`).toBe(200);
      const body = await next.text();
      expect(body, `route ${route} updated body`).toContain("NEW-APP-marker");
      expect(body, `route ${route} stale leak`).not.toContain("OLD-APP-marker");
    }
  });

  // AC: @daemon-web-ui-bundle ac-entry-unavailable-during-replacement
  it("application route returns 503 when the entry document is temporarily missing", async () => {
    writeIndex("<!doctype html><html><body>x</body></html>");
    const app = buildApp(tempDir);

    const ok = await app.handle(new Request(urlFor("/tasks")));
    expect(ok.status).toBe(200);

    unlinkSync(join(tempDir, "index.html"));
    const missing = await app.handle(new Request(urlFor("/tasks")));
    expect(missing.status).toBe(503);
    const cacheControl = missing.headers.get("cache-control") ?? "";
    expect(cacheControl).toMatch(/no-store|no-cache/);
  });

  // AC: @daemon-web-ui-bundle ac-entry-recovers-after-replacement
  it("application route recovers after the entry document returns", async () => {
    const app = buildApp(tempDir);

    const missing = await app.handle(new Request(urlFor("/tasks")));
    expect(missing.status).toBe(503);

    writeIndex("<!doctype html><html><body>RECOVERED-APP-marker</body></html>");
    const recovered = await app.handle(new Request(urlFor("/tasks")));
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain("RECOVERED-APP-marker");
  });
});

// AC: @trait-json-output ac-1 — N/A: web UI entry routes serve HTML, not JSON
// AC: @trait-json-output ac-2 — N/A: same as above
// AC: @trait-json-output ac-3 — N/A: same as above
// AC: @trait-json-output ac-4 — N/A: same as above
// AC: @trait-json-output ac-5 — N/A: same as above
// AC: @trait-json-output ac-6 — N/A: same as above
// AC: @trait-error-guidance ac-1 — N/A: web UI entry helper returns HTTP responses to browsers, not CLI guidance
// AC: @trait-error-guidance ac-2 — N/A: same as above
// AC: @trait-error-guidance ac-3 — N/A: same as above
// AC: @trait-error-guidance ac-4 — N/A: same as above
// AC: @trait-error-guidance ac-5 — N/A: same as above
// AC: @trait-error-guidance ac-6 — N/A: same as above
// AC: @trait-shadow-commit ac-1 — N/A: web UI entry helper does not mutate shadow state
// AC: @trait-shadow-commit ac-2 — N/A: same as above
// AC: @trait-shadow-commit ac-3 — N/A: same as above
// AC: @trait-shadow-commit ac-4 — N/A: same as above
// AC: @trait-shadow-commit ac-5 — N/A: same as above
// AC: @trait-shadow-commit ac-6 — N/A: same as above
// AC: @trait-shadow-commit ac-7 — N/A: same as above
// AC: @trait-shadow-commit ac-8 — N/A: same as above
// AC: @trait-localhost-security ac-loopback-default — N/A: web-ui entry route tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: web UI entry routes are HTTP, not WebSocket
// AC: @trait-websocket-protocol ac-2 — N/A: same as above
// AC: @trait-websocket-protocol ac-3 — N/A: same as above
// AC: @trait-websocket-protocol ac-4 — N/A: same as above
// AC: @trait-websocket-protocol ac-5 — N/A: same as above
// AC: @trait-websocket-protocol ac-6 — N/A: same as above
// AC: @trait-websocket-protocol ac-7 — N/A: same as above
// AC: @trait-websocket-protocol ac-8 — N/A: same as above
