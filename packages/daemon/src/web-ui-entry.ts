/**
 * Web UI entry document helper for the daemon.
 *
 * Resolves and serves the daemon web UI entry document (index.html) at request
 * time so that long-running daemons reflect bundle changes without restart.
 *
 * Spec:
 * - @daemon-server ac-root-route-current-entry
 * - @daemon-server ac-app-route-current-entry
 * - @daemon-web-ui-bundle ac-entry-unavailable-during-replacement
 * - @daemon-web-ui-bundle ac-entry-recovers-after-replacement
 * - @daemon-web-ui-bundle ac-reload-uses-current-entry
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Elysia } from "elysia";

const ENTRY_FILENAME = "index.html";

const SUCCESS_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-cache",
} as const;

const UNAVAILABLE_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

const UNAVAILABLE_BODY = "Web UI entry document is temporarily unavailable";

/**
 * Web UI route paths the daemon should serve the entry document for. The root
 * route plus the SvelteKit application routes that need to fall back to the
 * SPA shell when no static file exists.
 */
export const WEB_UI_ENTRY_ROUTES: readonly string[] = [
  "/",
  "/tasks",
  "/tasks/*",
  "/items",
  "/items/*",
  "/inbox",
  "/observations",
  "/triage",
  "/validate",
  "/sessions",
  "/sessions/*",
  "/agents",
  "/specs",
  "/workflows",
  "/plans",
  "/reviews",
  "/reviews/*",
  "/settings",
  "/automation",
  "/docs",
  "/docs/*",
];

function entryUnavailableResponse(): Response {
  return new Response(UNAVAILABLE_BODY, {
    status: 503,
    headers: { ...UNAVAILABLE_HEADERS },
  });
}

/**
 * Serve the current web UI entry document from the resolved bundle directory.
 *
 * Reads index.html on every call so that bundle replacements during the
 * daemon's lifetime are reflected on the next request. Returns HTTP 503 when
 * the entry document is missing so that an interrupted bundle does not surface
 * as a generic 404.
 */
export function serveWebUiEntry(webUiPath: string | null | undefined): Response {
  if (!webUiPath) {
    return entryUnavailableResponse();
  }

  const entryPath = join(webUiPath, ENTRY_FILENAME);
  if (!existsSync(entryPath)) {
    return entryUnavailableResponse();
  }

  let body: Buffer;
  try {
    body = readFileSync(entryPath);
  } catch {
    return entryUnavailableResponse();
  }

  return new Response(body, {
    status: 200,
    headers: { ...SUCCESS_HEADERS },
  });
}

/**
 * Register the web UI SPA fallback routes on the given Elysia app. Each route
 * resolves the current entry document at request time via {@link serveWebUiEntry}.
 */
export function registerWebUiEntryRoutes(app: Elysia, webUiPath: string | null): void {
  for (const route of WEB_UI_ENTRY_ROUTES) {
    app.get(route, () => serveWebUiEntry(webUiPath));
  }
}
