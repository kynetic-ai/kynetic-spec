/**
 * Web UI static asset helpers for the daemon.
 *
 * Serves bundle assets the browser fetches after loading the entry document
 * (script, modulepreload, stylesheet, favicon, etc.). The Bun runtime uses
 * @elysiajs/static; the node runtime uses the manual routes registered here
 * via {@link registerWebUiNodeStaticRoutes}.
 *
 * Spec:
 * - @daemon-server ac-17
 * - @daemon-web-ui-bundle ac-entry-bootstrap-assets-available
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Elysia } from "elysia";

const STATIC_ASSET_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function getStaticAssetContentType(assetPath: string): string {
  return STATIC_ASSET_CONTENT_TYPES[extname(assetPath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Serve a single web UI static asset, with path traversal containment.
 * Returns 404 for paths that escape the bundle root or do not exist.
 */
export function serveWebUiStaticAsset(webUiPath: string, requestPath: string): Response {
  const webUiRoot = resolve(webUiPath);
  const relativePath = requestPath.startsWith("/") ? requestPath.slice(1) : requestPath;
  const assetPath = resolve(webUiRoot, relativePath);
  if (assetPath !== webUiRoot && !assetPath.startsWith(`${webUiRoot}/`)) {
    return new Response("Not found", { status: 404 });
  }

  if (!existsSync(assetPath)) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(readFileSync(assetPath), {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": getStaticAssetContentType(assetPath),
    },
  });
}

/**
 * Predicate for the catch-all /:asset route: only handle root-level files
 * (no nested slash) that look like an asset (have an extension).
 */
export function isRootWebUiAssetPath(requestPath: string): boolean {
  const normalizedPath = requestPath.startsWith("/") ? requestPath.slice(1) : requestPath;
  return normalizedPath.length > 0 && !normalizedPath.includes("/") && normalizedPath.includes(".");
}

/**
 * Register the node-runtime web UI static asset routes on the given Elysia app.
 *
 * The Bun runtime relies on @elysiajs/static (mounted directly in
 * server.ts); node has no equivalent, so this helper installs the manual
 * `/ _app/*` and `/:asset` routes the daemon uses on node.
 */
export function registerWebUiNodeStaticRoutes(app: Elysia, webUiPath: string): void {
  app.get("/_app/*", ({ request }) =>
    serveWebUiStaticAsset(webUiPath, new URL(request.url).pathname),
  );
  app.get("/:asset", ({ request }) => {
    const requestPath = new URL(request.url).pathname;
    if (!isRootWebUiAssetPath(requestPath)) {
      return new Response("Not found", { status: 404 });
    }
    return serveWebUiStaticAsset(webUiPath, requestPath);
  });
}
