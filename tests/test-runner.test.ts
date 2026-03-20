import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

// Import the shipped module — tests exercise this, not reimplemented logic
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runner = require('../scripts/test.cjs');

describe('test runner environment checks', () => {
  // AC: @test-suite-perf-reliability ac-5
  describe('prerequisite verification and auto-fix', () => {
    it('dry-run succeeds when environment is ready', () => {
      const result = runTestRunner(['--dry-run']);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Environment check passed');
    });

    it('checkDependencies passes against real project root', () => {
      expect(runner.checkDependencies().ok).toBe(true);
    });

    it('checkBuild passes against real project root', () => {
      expect(runner.checkBuild().ok).toBe(true);
    });

    it('ensureEnvironment runs all hooks and returns fix count', () => {
      // Environment is already ready, so fixedCount should be 0
      const fixedCount = runner.ensureEnvironment();
      expect(fixedCount).toBe(0);
    });

    it('build hook respects SKIP_BUILD env var', () => {
      const buildHook = runner.preTestHooks.find((h: { name: string }) => h.name === 'build');
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
      // Save original hooks and inject a simulated failing hook
      const originalHooks = [...runner.preTestHooks];
      let fixCalled = false;
      let checkCallCount = 0;

      // Clear hooks and add a test hook that fails first, then passes after fix
      runner.preTestHooks.length = 0;
      runner.preTestHooks.push({
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
        const fixedCount = runner.ensureEnvironment();

        // Fix was called
        expect(fixCalled).toBe(true);
        // One issue fixed
        expect(fixedCount).toBe(1);
        // Check was called twice: initial check + re-check after fix
        expect(checkCallCount).toBe(2);
      } finally {
        // Restore original hooks
        runner.preTestHooks.length = 0;
        runner.preTestHooks.push(...originalHooks);
      }
    });

    describe('checkBuild missing-artifact detection (temp-dir isolated)', () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kspec-test-runner-'));
      });

      afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      it('detects when dist/daemon/index.ts is missing', () => {
        // Create all artifacts except dist/daemon/index.ts
        for (const artifact of ['dist/cli/index.js', 'dist/web-ui/index.html']) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, '');
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('dist/daemon/index.ts not found');
      });

      it('detects when dist/web-ui/index.html is missing', () => {
        for (const artifact of ['dist/cli/index.js', 'dist/daemon/index.ts']) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, '');
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('dist/web-ui/index.html not found');
      });

      it('detects when dist/cli/index.js is missing', () => {
        for (const artifact of ['dist/web-ui/index.html', 'dist/daemon/index.ts']) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, '');
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('dist/cli/index.js not found');
      });

      it('succeeds when all artifacts are present', () => {
        for (const artifact of [
          'dist/cli/index.js',
          'dist/web-ui/index.html',
          'dist/daemon/index.ts',
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, '');
        }

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(true);
      });

      it('detects stale build artifacts when a source file is newer', async () => {
        for (const artifact of [
          'dist/cli/index.js',
          'dist/web-ui/index.html',
          'dist/daemon/index.ts',
        ]) {
          const fullPath = path.join(tempDir, artifact);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, '');
        }

        await new Promise((resolve) => setTimeout(resolve, 20));

        const sourcePath = path.join(tempDir, 'src', 'cli', 'commands', 'plan-import.ts');
        fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
        fs.writeFileSync(sourcePath, '// newer than dist');

        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('src');
        expect(result.reason).toContain('is newer than build artifacts');
      });

      it('detects empty temp dir with no artifacts', () => {
        const result = runner.checkBuild(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('not found');
      });
    });

    describe('checkDependencies missing detection (temp-dir isolated)', () => {
      let tempDir: string;

      beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kspec-test-runner-'));
      });

      afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
      });

      it('detects missing node_modules', () => {
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({ devDependencies: { vitest: '^4.0.0' } }),
        );
        fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('node_modules/ not found');
      });

      it('detects missing vitest in node_modules', () => {
        fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true });
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({ devDependencies: { vitest: '^4.0.0' } }),
        );
        fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('vitest');
      });

      it('detects newly added direct dependencies that are missing from node_modules', () => {
        fs.mkdirSync(path.join(tempDir, 'node_modules', 'vitest'), { recursive: true });
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({
            dependencies: { croner: '^10.0.0' },
            devDependencies: { vitest: '^4.0.0' },
          }),
        );
        fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');

        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('croner');
      });

      it('passes when node_modules and vitest exist', () => {
        fs.mkdirSync(path.join(tempDir, 'node_modules', 'vitest'), { recursive: true });
        fs.mkdirSync(path.join(tempDir, 'node_modules', 'croner'), { recursive: true });
        fs.writeFileSync(
          path.join(tempDir, 'package.json'),
          JSON.stringify({
            dependencies: { croner: '^10.0.0' },
            devDependencies: { vitest: '^4.0.0' },
          }),
        );
        fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{}');
        const result = runner.checkDependencies(tempDir);
        expect(result.ok).toBe(true);
      });
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

    it('setup noise is suppressed — fix steps only emit runner-level status', () => {
      // Run dry-run and confirm all output is runner-prefixed, no raw npm noise
      const result = runTestRunner(['--dry-run']);
      for (const line of result.stderr.split('\n').filter((l) => l.trim())) {
        expect(line).toContain('[test-runner]');
      }
    });

    it('passes vitest arguments through', () => {
      const result = runTestRunner(['--dry-run', '--shard=1/3']);
      // dry-run exits before vitest, but args should be parsed without error
      expect(result.status).toBe(0);
    });

    it('shows pass/fail summary after test execution', () => {
      // Create a trivial temp test file inside the project so vitest's include pattern matches
      const tempTestFile = path.join(projectRoot, 'tests', '_trivial-summary-check.test.ts');
      fs.writeFileSync(
        tempTestFile,
        `import { it, expect } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n`,
      );

      try {
        const result = spawnSync(
          'node',
          [runnerScript, '--reporter=dot', 'tests/_trivial-summary-check.test.ts'],
          {
            cwd: projectRoot,
            encoding: 'utf8',
            env: { ...process.env, SKIP_BUILD: '1' },
            timeout: 30_000,
          },
        );

        // Must show a summary line — and specifically "Tests passed" for a passing run
        expect(result.stderr).toContain('[test-runner]');
        expect(result.stderr).toContain('Tests passed');
        expect(result.status).toBe(0);
      } finally {
        fs.unlinkSync(tempTestFile);
      }
    });

    it('exposes preTestHooks and postTestHooks arrays for extensibility', () => {
      expect(runner.preTestHooks).toBeInstanceOf(Array);
      expect(runner.preTestHooks.length).toBeGreaterThanOrEqual(2);
      expect(runner.postTestHooks).toBeInstanceOf(Array);

      // Each hook has the required interface
      for (const hook of runner.preTestHooks) {
        expect(hook).toHaveProperty('name');
        expect(typeof hook.name).toBe('string');
        expect(typeof hook.check).toBe('function');
        expect(typeof hook.fix).toBe('function');
      }
    });
  });
});
