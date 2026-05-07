/**
 * Daemon web UI route order — Bun-runtime regression.
 *
 * The Bun staticPlugin pre-registers '/' from index.html at startup. If the
 * entry helper is registered AFTER the plugin, the plugin's cached bundle
 * response shadows the helper for '/' — bundle changes are never reflected.
 *
 * This vitest harness spawns a Bun subprocess that builds the same Elysia
 * stack as packages/daemon/src/server.ts (non-node branch) and asserts the
 * fix: the entry helper is authoritative for the root and application
 * routes after a bundle replacement.
 *
 * Spec:
 * - @daemon-server ac-root-route-current-entry
 * - @daemon-server ac-app-route-current-entry
 * - @daemon-web-ui-bundle ac-reload-uses-current-entry
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(PROJECT_ROOT, "tests/fixtures/daemon-web-ui-bun-route-order.mjs");
const ENTRY_MODULE = join(PROJECT_ROOT, "dist/daemon/web-ui-entry.js");

function bunAvailable(): boolean {
  const result = spawnSync("bun", ["--version"], { encoding: "utf-8" });
  return result.status === 0;
}

describe("Daemon web UI route order under Bun", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kspec-bun-route-order-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // AC: @daemon-server ac-root-route-current-entry
  // AC: @daemon-server ac-app-route-current-entry
  // AC: @daemon-web-ui-bundle ac-reload-uses-current-entry
  it("entry helper handles '/' and app routes when staticPlugin is also mounted", () => {
    if (!bunAvailable()) {
      console.warn("[skip] bun not on PATH — skipping Bun-runtime route order test");
      return;
    }
    if (!existsSync(ENTRY_MODULE)) {
      throw new Error(
        `Compiled web-ui-entry.js missing at ${ENTRY_MODULE}; run npm run build before this test.`,
      );
    }

    const result = spawnSync("bun", ["run", SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        BUN_TEST_TEMP: tempDir,
        ENTRY_MODULE,
      },
      timeout: 30_000,
    });

    if (result.error) {
      throw new Error(`bun spawn failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `bun route order script exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    expect(result.stdout).toContain("PASS: bun route order test");
  }, 60_000);
});

// AC: @trait-json-output ac-1 — N/A: route order test asserts HTML responses, not JSON
// AC: @trait-json-output ac-2 — N/A: same as above
// AC: @trait-json-output ac-3 — N/A: same as above
// AC: @trait-json-output ac-4 — N/A: same as above
// AC: @trait-json-output ac-5 — N/A: same as above
// AC: @trait-json-output ac-6 — N/A: same as above
// AC: @trait-error-guidance ac-1 — N/A: HTTP route order test, not CLI guidance
// AC: @trait-error-guidance ac-2 — N/A: same as above
// AC: @trait-error-guidance ac-3 — N/A: same as above
// AC: @trait-error-guidance ac-4 — N/A: same as above
// AC: @trait-error-guidance ac-5 — N/A: same as above
// AC: @trait-error-guidance ac-6 — N/A: same as above
// AC: @trait-shadow-commit ac-1 — N/A: route order test does not mutate shadow state
// AC: @trait-shadow-commit ac-2 — N/A: same as above
// AC: @trait-shadow-commit ac-3 — N/A: same as above
// AC: @trait-shadow-commit ac-4 — N/A: same as above
// AC: @trait-shadow-commit ac-5 — N/A: same as above
// AC: @trait-shadow-commit ac-6 — N/A: same as above
// AC: @trait-shadow-commit ac-7 — N/A: same as above
// AC: @trait-shadow-commit ac-8 — N/A: same as above
// AC: @trait-localhost-security ac-loopback-default — N/A: web-ui bun route order tests do not invoke app.listen(); default loopback bind is exercised in tests/cli-serve.test.ts (daemon child startup).
// AC: @trait-localhost-security ac-loopback-rejects-nonlocal — N/A: localhostOnly middleware is a server-level concern, exercised in tests/daemon-api/server.test.ts and tests/daemon-server.test.ts.
// AC: @trait-localhost-security ac-external-host-explicit — N/A: explicit non-loopback bind is exercised in tests/cli-serve.test.ts where daemon.host is configured.
// AC: @trait-localhost-security ac-external-warning — N/A: external-bind warning is surfaced from the CLI lifecycle path and exercised in tests/cli-serve.test.ts.
// AC: @trait-websocket-protocol ac-1 — N/A: HTTP route test, not WebSocket
// AC: @trait-websocket-protocol ac-2 — N/A: same as above
// AC: @trait-websocket-protocol ac-3 — N/A: same as above
// AC: @trait-websocket-protocol ac-4 — N/A: same as above
// AC: @trait-websocket-protocol ac-5 — N/A: same as above
// AC: @trait-websocket-protocol ac-6 — N/A: same as above
// AC: @trait-websocket-protocol ac-7 — N/A: same as above
// AC: @trait-websocket-protocol ac-8 — N/A: same as above
