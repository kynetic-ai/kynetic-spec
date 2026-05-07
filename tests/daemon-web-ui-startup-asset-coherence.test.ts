/**
 * Daemon-served entry document <-> startup asset coherence.
 *
 * Verifies that every same-origin asset the served entry document tells the
 * browser to fetch before the web UI can start (script src, modulepreload,
 * stylesheet, root favicon) is actually served by the daemon's static asset
 * routes — not stale references from a previous bundle.
 *
 * Spec:
 * - @daemon-web-ui-bundle ac-entry-bootstrap-assets-available
 * - @daemon-server ac-root-route-current-entry
 * - @daemon-server ac-app-route-current-entry
 *
 * Tests build a minimal Elysia app that mirrors the daemon's node-runtime
 * web UI registration order (entry helper first, then asset routes) against a
 * temp bundle fixture with synthetic hash names. The Bun route order test in
 * tests/daemon-web-ui-bun-route-order.test.ts covers the Bun staticPlugin
 * path; this file covers the manual node-runtime asset routes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Elysia } from "elysia";
import { registerWebUiEntryRoutes } from "../dist/daemon/web-ui-entry.js";
import { registerWebUiNodeStaticRoutes } from "../dist/daemon/web-ui-static.js";

let tempBundleDir: string;

beforeEach(() => {
  tempBundleDir = join(
    tmpdir(),
    `kspec-startup-asset-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tempBundleDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempBundleDir)) {
    rmSync(tempBundleDir, { recursive: true, force: true });
  }
});

function writeAsset(relativePath: string, content: string): void {
  const fullPath = join(tempBundleDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function buildBundleApp(webUiPath: string | null): Elysia {
  const app = new Elysia();
  registerWebUiEntryRoutes(app, webUiPath);
  if (webUiPath) {
    registerWebUiNodeStaticRoutes(app, webUiPath);
  }
  return app;
}

function urlFor(path: string): string {
  return `http://localhost${path}`;
}

/**
 * Extract same-origin startup asset URLs the browser would fetch from the
 * served entry document. Looks at the standard HTML attributes that drive
 * automatic asset fetching during page load: <link href="..."> (modulepreload,
 * stylesheet, preload, icon, ...) and <script src="...">. Same-origin paths
 * are detected by a leading slash.
 */
function extractStartupAssetUrls(html: string): string[] {
  const urls = new Set<string>();
  const linkHrefRegex = /<link\s+[^>]*\bhref\s*=\s*"([^"]+)"/gi;
  for (const match of html.matchAll(linkHrefRegex)) {
    const href = match[1];
    if (href.startsWith("/")) urls.add(href);
  }
  const scriptSrcRegex = /<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;
  for (const match of html.matchAll(scriptSrcRegex)) {
    const src = match[1];
    if (src.startsWith("/")) urls.add(src);
  }
  return Array.from(urls);
}

describe("Daemon-served entry document <-> startup asset coherence (node runtime)", () => {
  // AC: @daemon-web-ui-bundle ac-entry-bootstrap-assets-available
  // AC: @daemon-server ac-root-route-current-entry
  it("each same-origin startup asset referenced by the served entry document is returned HTTP 200", async () => {
    writeAsset("_app/immutable/entry/start.HASH-A.js", "// start module");
    writeAsset("_app/immutable/entry/app.HASH-B.js", "// app module");
    writeAsset("_app/immutable/chunks/chunk.HASH-C.js", "// chunk");
    writeAsset("_app/immutable/assets/styles.HASH-D.css", "body{}");
    writeAsset("favicon.ico", "FAVICON-BYTES");
    writeAsset(
      "index.html",
      [
        "<!doctype html><html><head>",
        '  <link href="/_app/immutable/entry/start.HASH-A.js" rel="modulepreload">',
        '  <link href="/_app/immutable/entry/app.HASH-B.js" rel="modulepreload">',
        '  <link href="/_app/immutable/chunks/chunk.HASH-C.js" rel="modulepreload">',
        '  <link href="/_app/immutable/assets/styles.HASH-D.css" rel="stylesheet">',
        '  <link href="/favicon.ico" rel="icon">',
        "</head><body></body></html>",
      ].join("\n"),
    );

    const app = buildBundleApp(tempBundleDir);

    const entryResponse = await app.handle(new Request(urlFor("/")));
    expect(entryResponse.status).toBe(200);
    const html = await entryResponse.text();

    const urls = extractStartupAssetUrls(html);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls).toContain("/_app/immutable/entry/start.HASH-A.js");
    expect(urls).toContain("/_app/immutable/assets/styles.HASH-D.css");
    expect(urls).toContain("/favicon.ico");

    for (const url of urls) {
      const assetResponse = await app.handle(new Request(urlFor(url)));
      expect(assetResponse.status, `asset ${url} should return 200`).toBe(200);
      const body = await assetResponse.text();
      expect(body.length, `asset ${url} body should be non-empty`).toBeGreaterThan(0);
    }
  });

  // AC: @daemon-web-ui-bundle ac-entry-bootstrap-assets-available
  it("served modulepreload, stylesheet, and script-src assets return their bundle content with correct content type", async () => {
    writeAsset("_app/immutable/entry/start.HASH-A.js", "// start module content");
    writeAsset("_app/immutable/assets/styles.HASH-D.css", "/* stylesheet content */");
    writeAsset("_app/legacy/script.js", "// classic script content");
    writeAsset(
      "index.html",
      [
        "<!doctype html><html><head>",
        '  <link href="/_app/immutable/entry/start.HASH-A.js" rel="modulepreload">',
        '  <link href="/_app/immutable/assets/styles.HASH-D.css" rel="stylesheet">',
        "</head><body>",
        '  <script src="/_app/legacy/script.js"></script>',
        "</body></html>",
      ].join("\n"),
    );

    const app = buildBundleApp(tempBundleDir);
    const entry = await app.handle(new Request(urlFor("/")));
    const urls = extractStartupAssetUrls(await entry.text());
    expect(urls).toContain("/_app/immutable/entry/start.HASH-A.js");
    expect(urls).toContain("/_app/immutable/assets/styles.HASH-D.css");
    expect(urls).toContain("/_app/legacy/script.js");

    const moduleResponse = await app.handle(
      new Request(urlFor("/_app/immutable/entry/start.HASH-A.js")),
    );
    expect(moduleResponse.status).toBe(200);
    expect(await moduleResponse.text()).toBe("// start module content");
    expect(moduleResponse.headers.get("content-type") ?? "").toMatch(/text\/javascript/);

    const cssResponse = await app.handle(
      new Request(urlFor("/_app/immutable/assets/styles.HASH-D.css")),
    );
    expect(cssResponse.status).toBe(200);
    expect(await cssResponse.text()).toBe("/* stylesheet content */");
    expect(cssResponse.headers.get("content-type") ?? "").toMatch(/text\/css/);

    const scriptResponse = await app.handle(new Request(urlFor("/_app/legacy/script.js")));
    expect(scriptResponse.status).toBe(200);
    expect(await scriptResponse.text()).toBe("// classic script content");
    expect(scriptResponse.headers.get("content-type") ?? "").toMatch(/text\/javascript/);
  });

  // AC: @daemon-web-ui-bundle ac-entry-bootstrap-assets-available
  // AC: @daemon-server ac-root-route-current-entry
  // AC: @daemon-server ac-app-route-current-entry
  it("after a bundle change, the served entry no longer references missing old assets and the new asset is served", async () => {
    const oldAssetUrl = "/_app/immutable/entry/start.OLD-HASH.js";
    const newAssetUrl = "/_app/immutable/entry/start.NEW-HASH.js";
    const oldAssetFsPath = join(tempBundleDir, "_app/immutable/entry/start.OLD-HASH.js");

    writeAsset("_app/immutable/entry/start.OLD-HASH.js", "// OLD start module");
    writeAsset(
      "index.html",
      [
        "<!doctype html><html><head>",
        `  <link href="${oldAssetUrl}" rel="modulepreload">`,
        "</head><body></body></html>",
      ].join("\n"),
    );

    const app = buildBundleApp(tempBundleDir);

    // Snapshot the older entry doc the browser would have received earlier.
    const olderEntry = await app.handle(new Request(urlFor("/")));
    expect(olderEntry.status).toBe(200);
    const olderHtml = await olderEntry.text();
    expect(extractStartupAssetUrls(olderHtml)).toContain(oldAssetUrl);

    // Replace the bundle: drop the old asset, add a new one with a different
    // hash, rewrite index.html to reference only the new asset. Daemon does
    // not restart.
    unlinkSync(oldAssetFsPath);
    writeAsset("_app/immutable/entry/start.NEW-HASH.js", "// NEW start module");
    writeAsset(
      "index.html",
      [
        "<!doctype html><html><head>",
        `  <link href="${newAssetUrl}" rel="modulepreload">`,
        "</head><body></body></html>",
      ].join("\n"),
    );

    // Sanity: the old asset would 404 — the older entry's references would
    // have been broken if served against the new bundle.
    const oldAssetResponse = await app.handle(new Request(urlFor(oldAssetUrl)));
    expect(oldAssetResponse.status).toBe(404);

    // Current served entry must NOT name the missing old asset, and must
    // name the new asset which the daemon serves successfully.
    const currentEntry = await app.handle(new Request(urlFor("/")));
    expect(currentEntry.status).toBe(200);
    const currentHtml = await currentEntry.text();
    const currentUrls = extractStartupAssetUrls(currentHtml);
    expect(currentUrls).not.toContain(oldAssetUrl);
    expect(currentHtml).not.toContain("OLD-HASH");
    expect(currentUrls).toContain(newAssetUrl);

    const newAssetResponse = await app.handle(new Request(urlFor(newAssetUrl)));
    expect(newAssetResponse.status).toBe(200);
    expect(await newAssetResponse.text()).toBe("// NEW start module");

    // Same invariant for an application route — startup uses the same entry
    // document regardless of which route the browser lands on.
    const tasksEntry = await app.handle(new Request(urlFor("/tasks")));
    expect(tasksEntry.status).toBe(200);
    const tasksUrls = extractStartupAssetUrls(await tasksEntry.text());
    expect(tasksUrls).not.toContain(oldAssetUrl);
    expect(tasksUrls).toContain(newAssetUrl);
  });

  // AC: @daemon-web-ui-bundle ac-entry-bootstrap-assets-available
  it("path traversal asset requests do not escape the bundle root", async () => {
    writeAsset("_app/immutable/entry/start.HASH-A.js", "// start");
    writeAsset(
      "index.html",
      '<!doctype html><html><head><link href="/_app/immutable/entry/start.HASH-A.js" rel="modulepreload"></head></html>',
    );

    // Place a sentinel file outside the bundle root that traversal must NOT reach.
    const outsideDir = dirname(tempBundleDir);
    const outsideName = `outside-secret-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
    const outsideFile = join(outsideDir, outsideName);
    writeFileSync(outsideFile, "FORBIDDEN-OUTSIDE-CONTENT");

    try {
      const app = buildBundleApp(tempBundleDir);

      // Traversal under /_app/* — handled by serveWebUiStaticAsset (containment check).
      const traversalPaths = [
        `/_app/../${outsideName}`,
        `/_app/immutable/../../${outsideName}`,
      ];

      for (const traversalPath of traversalPaths) {
        const response = await app.handle(new Request(urlFor(traversalPath)));
        const body = await response.text();
        expect(
          body,
          `traversal ${traversalPath} must not return outside content`,
        ).not.toContain("FORBIDDEN-OUTSIDE-CONTENT");
        expect(
          response.status,
          `traversal ${traversalPath} must not be 200`,
        ).not.toBe(200);
      }

      // Sanity: the legitimate asset still resolves through the same route.
      const ok = await app.handle(
        new Request(urlFor("/_app/immutable/entry/start.HASH-A.js")),
      );
      expect(ok.status).toBe(200);
    } finally {
      if (existsSync(outsideFile)) {
        unlinkSync(outsideFile);
      }
    }
  });

  // AC: @daemon-web-ui-bundle ac-entry-bootstrap-assets-available
  it("returns 404 for asset paths not referenced by the entry and not present in the bundle", async () => {
    writeAsset("_app/immutable/entry/start.HASH-A.js", "// start");
    writeAsset("favicon.ico", "FAVICON");
    writeAsset(
      "index.html",
      [
        "<!doctype html><html><head>",
        '  <link href="/_app/immutable/entry/start.HASH-A.js" rel="modulepreload">',
        '  <link href="/favicon.ico" rel="icon">',
        "</head></html>",
      ].join("\n"),
    );

    const app = buildBundleApp(tempBundleDir);

    // Confirm referenced assets are 200 first.
    const refOk = await app.handle(
      new Request(urlFor("/_app/immutable/entry/start.HASH-A.js")),
    );
    expect(refOk.status).toBe(200);

    // /_app-shaped path with no matching file.
    const missingNested = await app.handle(
      new Request(urlFor("/_app/immutable/entry/missing-not-referenced.js")),
    );
    expect(missingNested.status).toBe(404);

    // Root-level asset that doesn't exist.
    const missingRoot = await app.handle(
      new Request(urlFor("/missing-favicon-not-referenced.ico")),
    );
    expect(missingRoot.status).toBe(404);
  });
});

// AC: @trait-json-output ac-1 — N/A: web UI startup assets are HTML/JS/CSS, not JSON output
// AC: @trait-json-output ac-2 — N/A: same as above
// AC: @trait-json-output ac-3 — N/A: same as above
// AC: @trait-json-output ac-4 — N/A: same as above
// AC: @trait-json-output ac-5 — N/A: same as above
// AC: @trait-json-output ac-6 — N/A: same as above
// AC: @trait-error-guidance ac-1 — N/A: HTTP asset responses are for browsers, not CLI guidance
// AC: @trait-error-guidance ac-2 — N/A: same as above
// AC: @trait-error-guidance ac-3 — N/A: same as above
// AC: @trait-error-guidance ac-4 — N/A: same as above
// AC: @trait-error-guidance ac-5 — N/A: same as above
// AC: @trait-error-guidance ac-6 — N/A: same as above
// AC: @trait-shadow-commit ac-1 — N/A: asset coherence test does not mutate shadow state
// AC: @trait-shadow-commit ac-2 — N/A: same as above
// AC: @trait-shadow-commit ac-3 — N/A: same as above
// AC: @trait-shadow-commit ac-4 — N/A: same as above
// AC: @trait-shadow-commit ac-5 — N/A: same as above
// AC: @trait-shadow-commit ac-6 — N/A: same as above
// AC: @trait-shadow-commit ac-7 — N/A: same as above
// AC: @trait-shadow-commit ac-8 — N/A: same as above
// AC: @trait-localhost-security ac-loopback-default — N/A: web-ui asset coherence tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: HTTP asset coherence test, not WebSocket
// AC: @trait-websocket-protocol ac-2 — N/A: same as above
// AC: @trait-websocket-protocol ac-3 — N/A: same as above
// AC: @trait-websocket-protocol ac-4 — N/A: same as above
// AC: @trait-websocket-protocol ac-5 — N/A: same as above
// AC: @trait-websocket-protocol ac-6 — N/A: same as above
// AC: @trait-websocket-protocol ac-7 — N/A: same as above
// AC: @trait-websocket-protocol ac-8 — N/A: same as above
