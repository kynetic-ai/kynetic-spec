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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_WEB_UI = join(PROJECT_ROOT, 'dist', 'web-ui');

/**
 * Recreates resolveWebUiPath from packages/daemon/src/server.ts for unit testing.
 * Accepts cwd override so tests can simulate a non-monorepo working directory.
 */
function resolveWebUiPath(
  webUiDir?: string,
  envOverride?: Record<string, string | undefined>,
  cwd = process.cwd()
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

  // 3. Monorepo development: packages/web-ui/build from cwd
  const monorepoPath = join(cwd, 'packages', 'web-ui', 'build');
  if (existsSync(monorepoPath)) {
    return monorepoPath;
  }

  // 4. Alternate location: web-ui/build in cwd
  const altPath = join(cwd, 'web-ui', 'build');
  if (existsSync(altPath)) {
    return altPath;
  }

  // 5. Bundled assets: dist/web-ui/ relative to daemon module (dist/daemon/server.js)
  const daemonModuleDir = join(PROJECT_ROOT, 'dist', 'daemon');
  const bundledPath = join(daemonModuleDir, '..', 'web-ui');
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return null;
}

describe('Web UI asset bundling (@daemon-web-ui-bundle)', () => {
  // AC: @daemon-web-ui-bundle ac-1
  it('dist/web-ui/ is populated with index.html after build', () => {
    // pretest runs npm run build which includes build:web-ui.
    // index.html existing proves the build pipeline correctly copies assets.
    expect(existsSync(join(DIST_WEB_UI, 'index.html'))).toBe(true);
  });

  describe('resolveWebUiPath — priority ordering', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(PROJECT_ROOT, '.tmp-web-ui-test-' + Date.now());
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // AC: @daemon-web-ui-bundle ac-2
    it('falls back to bundled dist/web-ui/ when no local or env build exists', () => {
      // Use tempDir as cwd so steps 3 (packages/web-ui/build) and 4 (web-ui/build)
      // find nothing — forces resolution to reach step 5 (bundled dist/web-ui/).
      const result = resolveWebUiPath(undefined, {}, tempDir);
      expect(result).toBe(DIST_WEB_UI);
      expect(existsSync(result!)).toBe(true);
    });

    // AC: @daemon-web-ui-bundle ac-4
    it('explicit webUiDir option takes precedence over bundled fallback', () => {
      const result = resolveWebUiPath(tempDir, {}, tempDir);
      expect(result).toBe(tempDir);
    });

    // AC: @daemon-web-ui-bundle ac-4
    it('WEB_UI_DIR env var takes precedence over bundled fallback', () => {
      const result = resolveWebUiPath(undefined, { WEB_UI_DIR: tempDir }, tempDir);
      expect(result).toBe(tempDir);
    });

    // AC: @daemon-web-ui-bundle ac-4
    it('non-existent explicit webUiDir is skipped and falls through to bundled', () => {
      const result = resolveWebUiPath('/non/existent/path', {}, tempDir);
      expect(result).toBe(DIST_WEB_UI);
    });
  });
});
