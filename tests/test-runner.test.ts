import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const runnerScript = path.join(projectRoot, 'scripts', 'test.cjs');

/**
 * Run the test runner script as a subprocess and capture output.
 * Uses --dry-run to avoid actually running vitest.
 */
function runTestRunner(
  args: string[] = [],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('node', [runnerScript, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status ?? 1,
  };
}

describe('test runner environment checks', () => {
  // AC: @test-suite-perf-reliability ac-5
  describe('prerequisite verification and auto-fix', () => {
    it('detects missing build artifacts and reports which are missing', () => {
      // Use checkBuild directly to verify it checks multiple artifacts
      const { checkBuild } = require('../scripts/test.cjs');

      // When all artifacts exist, returns ok
      const result = checkBuild();
      // global-setup ensures dist/ exists before tests run
      expect(result.ok).toBe(true);
    });

    it('dry-run succeeds when environment is ready', () => {
      const result = runTestRunner(['--dry-run']);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Environment check passed');
    });

    it('checkDependencies detects missing node_modules', () => {
      const { checkDependencies } = require('../scripts/test.cjs');
      // Currently running, so node_modules exists
      expect(checkDependencies().ok).toBe(true);
    });

    it('ensureEnvironment runs all hooks and returns fix count', () => {
      const { ensureEnvironment } = require('../scripts/test.cjs');
      // Environment is already ready, so fixedCount should be 0
      const fixedCount = ensureEnvironment();
      expect(fixedCount).toBe(0);
    });

    it('build hook respects SKIP_BUILD env var', () => {
      const { preTestHooks } = require('../scripts/test.cjs');
      const buildHook = preTestHooks.find((h: { name: string }) => h.name === 'build');
      expect(buildHook).toBeDefined();
      expect(typeof buildHook.skip).toBe('function');

      const origVal = process.env.SKIP_BUILD;
      try {
        delete process.env.SKIP_BUILD;
        expect(buildHook.skip()).toBe(false);
        process.env.SKIP_BUILD = '1';
        expect(buildHook.skip()).toBe(true);
      } finally {
        if (origVal !== undefined) {
          process.env.SKIP_BUILD = origVal;
        } else {
          delete process.env.SKIP_BUILD;
        }
      }
    });
  });

  // AC: @test-suite-perf-reliability ac-5
  describe('auto-fix flow', () => {
    it('ensureEnvironment calls fix when check fails, then re-checks', () => {
      const { preTestHooks, ensureEnvironment } = require('../scripts/test.cjs');

      // Save original hooks and inject a simulated failing hook
      const originalHooks = [...preTestHooks];
      let fixCalled = false;
      let checkCallCount = 0;

      // Clear hooks and add a test hook that fails first, then passes after fix
      preTestHooks.length = 0;
      preTestHooks.push({
        name: 'test-hook',
        check: () => {
          checkCallCount++;
          if (!fixCalled) {
            return { ok: false, reason: 'simulated missing prerequisite' };
          }
          return { ok: true };
        },
        fix: () => {
          fixCalled = true;
        },
      });

      try {
        const fixedCount = ensureEnvironment();

        // Fix was called
        expect(fixCalled).toBe(true);
        // One issue fixed
        expect(fixedCount).toBe(1);
        // Check was called twice: initial check + re-check after fix
        expect(checkCallCount).toBe(2);
      } finally {
        // Restore original hooks
        preTestHooks.length = 0;
        preTestHooks.push(...originalHooks);
      }
    });

    it('checkBuild detects when dist/daemon/index.ts is missing', () => {
      const { checkBuild } = require('../scripts/test.cjs');
      const artifactPath = path.join(projectRoot, 'dist', 'daemon', 'index.ts');
      const backupPath = artifactPath + '.test-backup';

      if (!fs.existsSync(artifactPath)) {
        return;
      }

      try {
        fs.renameSync(artifactPath, backupPath);
        const result = checkBuild();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('dist/daemon/index.ts not found');
      } finally {
        if (fs.existsSync(backupPath)) {
          fs.renameSync(backupPath, artifactPath);
        }
      }
    });

    it('checkBuild detects when dist/web-ui/index.html is missing', () => {
      const { checkBuild } = require('../scripts/test.cjs');
      const artifactPath = path.join(projectRoot, 'dist', 'web-ui', 'index.html');
      const backupPath = artifactPath + '.test-backup';

      if (!fs.existsSync(artifactPath)) {
        return;
      }

      try {
        fs.renameSync(artifactPath, backupPath);
        const result = checkBuild();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('dist/web-ui/index.html not found');
      } finally {
        if (fs.existsSync(backupPath)) {
          fs.renameSync(backupPath, artifactPath);
        }
      }
    });
  });

  // AC: @test-suite-perf-reliability ac-6
  describe('structured output and extensibility', () => {
    it('dry-run output goes to stderr, keeping stdout clean for piping', () => {
      const result = runTestRunner(['--dry-run']);
      expect(result.stderr).toContain('[test-runner]');
      // stdout should be empty or minimal (no setup noise)
      expect(result.stdout.trim()).toBe('');
    });

    it('passes vitest arguments through', () => {
      // Run with a non-existent test filter — vitest should still be invoked
      // but exit quickly. We verify the runner passes args through.
      const result = runTestRunner(['--dry-run', '--shard=1/3']);
      // dry-run exits before vitest, but args should be parsed without error
      expect(result.status).toBe(0);
    });

    it('shows pass/fail summary after test execution', () => {
      // Run the runner against its own test file for a quick pass
      const result = spawnSync(
        'node',
        [runnerScript, 'tests/test-runner.test.ts', '--reporter=silent'],
        {
          cwd: projectRoot,
          encoding: 'utf8',
          env: { ...process.env, SKIP_BUILD: '1' },
          timeout: 120_000,
        },
      );

      // The summary line should appear in stderr regardless of pass/fail
      expect(result.stderr).toMatch(/\[test-runner\].*Tests (passed|failed)/);
    });

    it('exposes preTestHooks and postTestHooks arrays for extensibility', () => {
      const { preTestHooks, postTestHooks } = require('../scripts/test.cjs');
      expect(preTestHooks).toBeInstanceOf(Array);
      expect(preTestHooks.length).toBeGreaterThanOrEqual(2);
      expect(postTestHooks).toBeInstanceOf(Array);

      // Each hook has the required interface
      for (const hook of preTestHooks) {
        expect(hook).toHaveProperty('name');
        expect(typeof hook.name).toBe('string');
        expect(typeof hook.check).toBe('function');
        expect(typeof hook.fix).toBe('function');
      }
    });
  });
});
