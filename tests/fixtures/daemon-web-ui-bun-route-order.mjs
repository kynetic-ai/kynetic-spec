#!/usr/bin/env bun
/**
 * Bun-runtime regression for the daemon web UI route order.
 *
 * Reproduces and asserts the fix for the Bun staticPlugin shadowing the
 * entry helper at the root route — the Bun static plugin pre-registers '/'
 * from index.html, so without ordering control the daemon's '/' returns the
 * plugin's cached bundle response (cacheable, never reflecting a later
 * bundle change) instead of the entry helper's revalidating response.
 *
 * Usage: BUN_TEST_TEMP=<tempDir> ENTRY_MODULE=<path-to-web-ui-entry.js> bun run <this file>
 *   exits 0 if the route order keeps the entry helper authoritative for '/'
 *   and application routes after a bundle change.
 */
import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const tempDir = process.env.BUN_TEST_TEMP;
if (!tempDir) fail("BUN_TEST_TEMP env var must point to a writable temp dir");

const entryModulePath = process.env.ENTRY_MODULE;
if (!entryModulePath) fail("ENTRY_MODULE env var must point to web-ui-entry.js");

const { registerWebUiEntryRoutes } = await import(entryModulePath);
if (typeof registerWebUiEntryRoutes !== "function") {
  fail(`ENTRY_MODULE did not export registerWebUiEntryRoutes (${entryModulePath})`);
}

mkdirSync(tempDir, { recursive: true });
mkdirSync(join(tempDir, "_app"), { recursive: true });
writeFileSync(join(tempDir, "_app/main.js"), "console.log('asset');");
writeFileSync(join(tempDir, "favicon.svg"), "<svg/>");
writeFileSync(
  join(tempDir, "index.html"),
  "<!doctype html><html><body>OLD-BUNDLE-MARKER</body></html>",
);

// Mirror packages/daemon/src/server.ts non-node web UI registration order.
const app = new Elysia();
registerWebUiEntryRoutes(app, tempDir);
app.use(
  await staticPlugin({
    assets: tempDir,
    prefix: "/",
    indexHTML: false,
    noCache: true,
  }),
);

async function getText(path) {
  const response = await app.handle(new Request(`http://localhost${path}`));
  const body = await response.text();
  const cacheControl = response.headers.get("cache-control") ?? "";
  const contentType = response.headers.get("content-type") ?? "";
  return { status: response.status, body, cacheControl, contentType };
}

// Initial responses must come from the entry helper (no plugin shadowing on '/').
const rootBefore = await getText("/");
if (rootBefore.status !== 200) fail(`root status=${rootBefore.status} (expected 200)`);
if (!rootBefore.body.includes("OLD-BUNDLE-MARKER")) {
  fail(
    `root before-change body did not come from entry helper. body=${JSON.stringify(rootBefore.body)}`,
  );
}
if (!rootBefore.contentType.startsWith("text/html")) {
  fail(`root content-type=${rootBefore.contentType} (expected text/html)`);
}
if (!/no-cache|no-store|must-revalidate|max-age=0/.test(rootBefore.cacheControl)) {
  fail(`root cache-control=${rootBefore.cacheControl} (expected revalidating)`);
}

const tasksBefore = await getText("/tasks");
if (tasksBefore.status !== 200) fail(`/tasks status=${tasksBefore.status} (expected 200)`);
if (!tasksBefore.body.includes("OLD-BUNDLE-MARKER")) {
  fail(`/tasks before-change body=${JSON.stringify(tasksBefore.body)}`);
}

// Replace the entry document — the daemon has not restarted.
writeFileSync(
  join(tempDir, "index.html"),
  "<!doctype html><html><body>NEW-BUNDLE-MARKER</body></html>",
);

const rootAfter = await getText("/");
if (rootAfter.status !== 200) fail(`root after-change status=${rootAfter.status}`);
if (!rootAfter.body.includes("NEW-BUNDLE-MARKER")) {
  fail(
    `root after-change body did not reflect bundle change. body=${JSON.stringify(rootAfter.body)}`,
  );
}
if (rootAfter.body.includes("OLD-BUNDLE-MARKER")) {
  fail("root after-change body still contained OLD-BUNDLE-MARKER (stale plugin cache)");
}

const tasksAfter = await getText("/tasks");
if (tasksAfter.status !== 200) fail(`/tasks after-change status=${tasksAfter.status}`);
if (!tasksAfter.body.includes("NEW-BUNDLE-MARKER")) {
  fail(`/tasks after-change body=${JSON.stringify(tasksAfter.body)}`);
}
if (tasksAfter.body.includes("OLD-BUNDLE-MARKER")) {
  fail("/tasks after-change body still contained OLD-BUNDLE-MARKER (stale plugin cache)");
}

// Static asset path must still resolve through the plugin.
const assetResponse = await app.handle(new Request("http://localhost/_app/main.js"));
if (assetResponse.status !== 200) {
  fail(`/_app/main.js status=${assetResponse.status} (expected 200)`);
}

console.log("PASS: bun route order test");
process.exit(0);
