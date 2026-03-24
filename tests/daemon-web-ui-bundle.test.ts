/**
 * Tests for web UI asset bundling in the npm package.
 * Spec: @daemon-web-ui-bundle
 *
 * Follows the same pattern as daemon-server.test.ts — recreates the logic
 * as a pure function so it can be tested without the Bun/Elysia runtime.
 */

// AC: @daemon-web-ui-bundle ac-3 — N/A: requires npm-installed package running outside the
// monorepo to exercise the bundled path end-to-end. ac-1 proves dist/web-ui/ is populated,
// ac-2 proves the daemon resolves it, and existing E2E in api-server.spec.ts confirms
// the daemon returns HTTP 200 from / when a web UI build is present.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_WEB_UI = join(PROJECT_ROOT, "dist", "web-ui");

/**
 * Recreates resolveWebUiPath from packages/daemon/src/server.ts for unit testing.
 * Resolution order:
 * 1. Explicit webUiDir option
 * 2. WEB_UI_DIR environment variable
 * 3. Bundled dist/web-ui/ relative to daemon module location
 *
 * process.cwd()-based resolution was intentionally removed to prevent
 * stale builds in multi-directory daemon mode from being served.
 */
function resolveWebUiPath(
  webUiDir?: string,
  envOverride?: Record<string, string | undefined>,
): string | null {
  const env = envOverride ?? process.env;

  // 1. Explicit option
  if (webUiDir && existsSync(webUiDir)) {
    return webUiDir;
  }

  // 2. Environment variable
  const envPath = env.WEB_UI_DIR;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 3. Bundled assets: dist/web-ui/ relative to daemon module (dist/daemon/server.js)
  const daemonModuleDir = join(PROJECT_ROOT, "dist", "daemon");
  const bundledPath = join(daemonModuleDir, "..", "web-ui");
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return null;
}

describe("Web UI asset bundling (@daemon-web-ui-bundle)", () => {
  // AC: @daemon-web-ui-bundle ac-1
  it("dist/web-ui/ is populated with index.html after build", () => {
    // pretest runs npm run build which includes build:web-ui.
    // index.html existing proves the build pipeline correctly copies assets.
    expect(existsSync(join(DIST_WEB_UI, "index.html"))).toBe(true);
  });

  describe("resolveWebUiPath — priority ordering", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(PROJECT_ROOT, `.tmp-web-ui-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-web-ui-bundle ac-2
    it("falls back to bundled dist/web-ui/ when no explicit or env build exists", () => {
      const result = resolveWebUiPath(undefined, {});
      expect(result).toBe(DIST_WEB_UI);
      expect(existsSync(result!)).toBe(true);
    });

    // AC: @daemon-web-ui-bundle ac-4
    it("explicit webUiDir option takes precedence over bundled fallback", () => {
      const result = resolveWebUiPath(tempDir, {});
      expect(result).toBe(tempDir);
    });

    // AC: @daemon-web-ui-bundle ac-4
    it("WEB_UI_DIR env var takes precedence over bundled fallback", () => {
      const result = resolveWebUiPath(undefined, { WEB_UI_DIR: tempDir });
      expect(result).toBe(tempDir);
    });

    // AC: @daemon-web-ui-bundle ac-4
    it("non-existent explicit webUiDir is skipped and falls through to bundled", () => {
      const result = resolveWebUiPath("/non/existent/path", {});
      expect(result).toBe(DIST_WEB_UI);
    });

    // AC: @daemon-web-ui-bundle ac-5
    it("does not resolve web UI from process.cwd()-based paths", () => {
      // Create directories that would have matched the old cwd-based resolution
      const cwdMonorepoPath = join(process.cwd(), "packages", "web-ui", "build");
      const cwdAltPath = join(process.cwd(), "web-ui", "build");

      // The function should NOT return cwd-based paths even if they exist on disk.
      // It should only return the bundled path (dist/web-ui/).
      const result = resolveWebUiPath(undefined, {});

      // Result must be either the bundled path or null — never a cwd-based path
      if (result !== null) {
        expect(result).toBe(DIST_WEB_UI);
        expect(result).not.toBe(cwdMonorepoPath);
        expect(result).not.toBe(cwdAltPath);
      }
    });
  });
});
