/**
 * E2E tests for kspec serve CLI commands
 * Spec: @cli-serve-commands
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempDir,
  cleanupTempDir,
  createIsolatedKspecHome,
  initGitRepo,
  kspec,
  waitForStartup,
  type KspecOptions,
} from './helpers/cli';
import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { createServer } from 'net';

// Check if Bun runtime is available
let bunAvailable = false;
try {
  execSync('which bun', { stdio: 'pipe' });
  bunAvailable = true;
} catch {
  console.log('⊘ Bun runtime not available - skipping daemon tests requiring actual daemon process');
}

describe('kspec serve commands', () => {
  let tempDir: string;
  let isolatedHome: string;
  let testEnv: Record<string, string>;
  let globalPidFilePath: string;
  let globalPortFilePath: string;

  async function getAvailablePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close(() => reject(new Error('Failed to allocate ephemeral port')));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
      });
    });
  }

  function runKspec(args: string, cwd = tempDir, options: KspecOptions = {}) {
    return kspec(args, cwd, {
      ...options,
      env: { ...testEnv, ...(options.env ?? {}) },
    });
  }

  async function waitForDaemonHealth(port: number): Promise<void> {
    await waitForStartup(`daemon health endpoint on port ${port}`, async () => {
      const url = `http://localhost:${port}/api/health`;
      try {
        const response = await fetch(url);
        const body = (await response.text()).trim();
        const bodyReportsHealthy = body.includes('"status":"ok"');
        return {
          ok: response.ok || bodyReportsHealthy,
          details: `status=${response.status} body=${body || '<empty>'}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, details: `fetch error=${message}` };
      }
    }, { timeoutMs: 10_000 });
  }

  async function waitForDaemonUptime(minUptimeSeconds: number): Promise<void> {
    await waitForStartup(
      `daemon uptime >= ${minUptimeSeconds}s`,
      async () => {
        const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir, {
          expectFail: true
        });
        if (result.exitCode !== 0) {
          return {
            ok: false,
            details: `exit=${result.exitCode} stderr=${result.stderr || '<empty>'}`,
          };
        }

        try {
          const status = JSON.parse(result.stdout);
          const uptime = typeof status.uptime === 'number' ? status.uptime : -1;
          return {
            ok: uptime >= minUptimeSeconds,
            details: `running=${Boolean(status.running)} uptime=${uptime}`,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, details: `invalid-json=${message}` };
        }
      },
      { timeoutMs: 10_000 }
    );
  }

  beforeEach(async () => {
    tempDir = await createTempDir();
    await initGitRepo(tempDir);
    mkdirSync(join(tempDir, '.kspec'), { recursive: true });
    const isolated = await createIsolatedKspecHome(tempDir);
    isolatedHome = isolated.homeDir;
    testEnv = isolated.env;
    globalPidFilePath = isolated.daemonPidFilePath;
    globalPortFilePath = isolated.daemonPortFilePath;

    // Ensure this test HOME starts from clean daemon state.
    try {
      runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
    } catch {
      // Ignore: this is best-effort cleanup.
    }
  });

  afterEach(async () => {
    // Stop daemon scoped to isolated HOME so we never touch ambient daemon state.
    try {
      runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir, { expectFail: true });
    } catch {
      // Ignore cleanup errors
    }

    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-sensitive-cli-test-determinism ac-1
  it('should include actionable context when readiness wait times out', async () => {
    await expect(waitForStartup(
      'synthetic daemon readiness',
      async () => ({ ok: false, details: 'status=503 body=warming-up' }),
      { timeoutMs: 120, intervalMs: 20 }
    )).rejects.toThrow(/Last observation: status=503 body=warming-up/);
  });

  // AC: @cli-serve-commands ac-1
  // AC: @daemon-server ac-12
  it('should start in foreground mode with Ctrl+C support', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    // Use a unique port for this test
    const port = await getAvailablePort();

    // Spawn kspec serve in foreground
    const child = spawn('node', [
      join(__dirname, '../dist/cli/index.js'),
      'serve',
      'start',
      '--port',
      String(port),
      '--kspec-dir',
      join(tempDir, '.kspec')
    ], {
      cwd: tempDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...testEnv },
    });

    let output = '';
    child.stdout?.on('data', (data) => {
      output += data.toString();
    });

    child.stderr?.on('data', (data) => {
      output += data.toString();
    });

    // Wait for startup message (CI can be slower than local runs)
    const started = await new Promise<boolean>((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (
          output.includes('Starting server in foreground')
          && output.includes(`port ${port}`)
        ) {
          clearInterval(interval);
          resolve(true);
          return;
        }
        if (Date.now() - start > 15_000 || child.exitCode !== null) {
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });

    expect(started, `foreground startup output missing:\n${output}`).toBe(true);

    // Send SIGINT (Ctrl+C)
    if (child.exitCode === null) {
      child.kill('SIGINT');
    }

    // Wait for shutdown
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.on('exit', () => resolve());
    });

    expect(child.exitCode).toBe(0);
  });

  // AC: @cli-serve-commands ac-2
  // AC: @daemon-sensitive-cli-test-determinism ac-2
  it('should start in daemon mode and detach', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = await getAvailablePort();

    const result = runKspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    // Should report success
    expect(result.stdout).toContain('Daemon started');
    expect(result.stdout).toContain(`port ${port}`);

    // PID file should exist
    expect(existsSync(globalPidFilePath)).toBe(true);
    expect(existsSync(globalPortFilePath)).toBe(true);
    expect(globalPidFilePath.startsWith(isolatedHome)).toBe(true);
    expect(globalPortFilePath.startsWith(isolatedHome)).toBe(true);

    const pid = parseInt(readFileSync(globalPidFilePath, 'utf-8').trim(), 10);
    expect(pid).toBeGreaterThan(0);

    // Process should be running
    let processRunning = false;
    try {
      process.kill(pid, 0); // Signal 0 checks existence
      processRunning = true;
    } catch {
      processRunning = false;
    }
    expect(processRunning).toBe(true);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-3
  it('should accept custom port via --port flag', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const customPort = await getAvailablePort();

    const result = runKspec(
      `serve start --daemon --port ${customPort} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    expect(result.stdout).toContain(`port ${customPort}`);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-4
  // AC: @daemon-server ac-12
  it('should send SIGTERM and wait for shutdown', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = await getAvailablePort();

    // Start daemon
    runKspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    const pid = parseInt(readFileSync(globalPidFilePath, 'utf-8').trim(), 10);

    // Stop daemon
    const result = runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    expect(result.stdout).toContain('Stopping daemon');
    expect(result.stdout).toContain(`PID ${pid}`);
    expect(result.stdout).toContain('Daemon stopped');

    // PID file should be removed (eventually by daemon cleanup, but may still exist during test)
    // Process should not be running
    let processRunning = false;
    try {
      process.kill(pid, 0);
      processRunning = true;
    } catch {
      processRunning = false;
    }
    expect(processRunning).toBe(false);
  });

  // AC: @cli-serve-commands ac-5
  it('should return success when stopping non-running daemon (idempotent)', async () => {
    const result = runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Daemon not running');
  });

  // AC: @cli-serve-commands ac-6
  it('should return JSON status with process info', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    // Start daemon
    const port = await getAvailablePort();
    runKspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    const pid = parseInt(readFileSync(globalPidFilePath, 'utf-8').trim(), 10);

    // Check status with --json flag
    const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    // Should output valid JSON with process info
    const status = JSON.parse(result.stdout);
    expect(status).toMatchObject({
      running: true,
      pid: pid,
    });

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @multi-directory-daemon ac-12
  // AC: @daemon-sensitive-cli-test-determinism ac-3
  it('should show registered projects with paths in status output', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = await getAvailablePort();

    // Start daemon
    runKspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    await waitForDaemonHealth(port);

    // Register a project via API
    const testProjectPath = tempDir;
    await fetch(`http://localhost:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: testProjectPath }),
    });

    // Check status - should list registered projects
    const result = runKspec(`serve status --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    // Human-readable output should mention projects
    expect(result.stdout).toContain('Registered projects');
    expect(result.stdout).toContain(testProjectPath);
    expect(result.stdout).toContain('watcher:');

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @multi-directory-daemon ac-12
  it('should include projects list in JSON status output', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = await getAvailablePort();

    // Start daemon
    runKspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    await waitForDaemonHealth(port);

    // Register a project via API
    const testProjectPath = tempDir;
    await fetch(`http://localhost:${port}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: testProjectPath }),
    });

    // Check status with --json
    const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    const status = JSON.parse(result.stdout);
    expect(status).toHaveProperty('projects');
    expect(status.projects).toBeInstanceOf(Array);
    expect(status.projects.length).toBeGreaterThan(0);

    // Verify project details
    const project = status.projects.find((p: any) => p.path === testProjectPath);
    expect(project).toBeDefined();
    expect(project).toHaveProperty('path', testProjectPath);
    expect(project).toHaveProperty('registeredAt');
    expect(project).toHaveProperty('watcherStatus');

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @multi-directory-daemon ac-12
  it('should show "No projects registered" when no projects exist', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    // Create temp directory WITHOUT .kspec/ to avoid auto-registration
    const emptyTempDir = await createTempDir();
    await initGitRepo(emptyTempDir);
    const isolated = await createIsolatedKspecHome(emptyTempDir);
    const env = isolated.env;

    const port = await getAvailablePort();

    // Start daemon from directory without .kspec/ (AC: @multi-directory-daemon ac-3)
    // This ensures no default project is registered
    runKspec(
      `serve start --daemon --port ${port}`,
      emptyTempDir,
      { env }
    );

    await waitForDaemonHealth(port);

    // Check status - should indicate no projects
    const result = runKspec(`serve status`, emptyTempDir, { env });

    expect(result.stdout).toContain('No projects registered');

    // Cleanup
    runKspec(`serve stop`, emptyTempDir, { env });
    await cleanupTempDir(emptyTempDir);
  });

  // AC: @multi-directory-daemon ac-12
  it('should show uptime in status output', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = await getAvailablePort();

    // Start daemon
    runKspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    await waitForDaemonHealth(port);
    await waitForDaemonUptime(1);

    // Check status - should show uptime
    const result = runKspec(`serve status --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    expect(result.stdout).toContain('Uptime:');

    // Check JSON output includes uptime
    const jsonResult = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
    const status = JSON.parse(jsonResult.stdout);
    expect(status).toHaveProperty('uptime');
    expect(typeof status.uptime).toBe('number');
    expect(status.uptime).toBeGreaterThan(0);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-7
  it('should stop then start on restart', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = await getAvailablePort();

    // Start daemon
    runKspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    const originalPid = parseInt(readFileSync(globalPidFilePath, 'utf-8').trim(), 10);

    // Restart
    const result = runKspec(`serve restart --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    expect(result.stdout).toContain('Stopping daemon');
    expect(result.stdout).toContain('Starting daemon');

    // Should have new PID
    const newPid = parseInt(readFileSync(globalPidFilePath, 'utf-8').trim(), 10);
    expect(newPid).not.toBe(originalPid);

    // New process should be running
    let processRunning = false;
    try {
      process.kill(newPid, 0);
      processRunning = true;
    } catch {
      processRunning = false;
    }
    expect(processRunning).toBe(true);

    // Cleanup
    runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-10
  it('should show error with recovery hint for invalid port', async () => {
    const result = runKspec(
      `serve start --port 99999 --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir,
      { expectFail: true }
    );

    expect(result.exitCode).not.toBe(0);

    // Error and hint should be in stderr
    expect(result.stderr).toContain('Invalid port number');
    expect(result.stderr).toContain('Try: kspec serve --port');
  });

  // AC: @cli-serve-commands ac-11
  describe('dispatch agent guard', () => {
    it('should refuse serve start when KSPEC_SESSION_ID is set', async () => {
      const result = runKspec(
        `serve start --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir,
        { expectFail: true, env: { KSPEC_SESSION_ID: 'test-session-id' } }
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Cannot start daemon from inside an agent invocation');
      expect(result.stderr).toContain('dispatch engine');
    });

    it('should refuse serve stop when KSPEC_SESSION_ID is set', async () => {
      const result = runKspec(
        `serve stop --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir,
        { expectFail: true, env: { KSPEC_SESSION_ID: 'test-session-id' } }
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Cannot stop daemon from inside an agent invocation');
      expect(result.stderr).toContain('dispatch engine');
    });

    it('should refuse serve restart when KSPEC_SESSION_ID is set', async () => {
      const result = runKspec(
        `serve restart --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir,
        { expectFail: true, env: { KSPEC_SESSION_ID: 'test-session-id' } }
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Cannot restart daemon from inside an agent invocation');
      expect(result.stderr).toContain('dispatch engine');
    });

    // AC: @trait-json-output ac-3 — JSON error output for dispatch guard
    it('should output JSON error when guard triggers with --json', async () => {
      const result = runKspec(
        `serve start --json --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir,
        { expectFail: true, env: { KSPEC_SESSION_ID: 'test-session-id' } }
      );

      expect(result.exitCode).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('error');
      expect(output.error).toContain('Cannot start daemon');
      expect(output).toHaveProperty('reason');
      expect(output).toHaveProperty('suggestion');
    });
  });

  // Trait tests: @trait-json-output
  describe('JSON output mode', () => {
    // AC: @trait-json-output ac-1, ac-2
    it('should output valid JSON with --json for serve status', async () => {
      const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('running');
      expect(output).toHaveProperty('pid');
    });

    // AC: @trait-json-output ac-3, @trait-error-guidance ac-6
    it('should output errors as JSON with --json flag', async () => {
      const result = runKspec(
        `serve start --port 99999 --json --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir,
        { expectFail: true }
      );

      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('error');
      expect(output.error).toContain('Invalid port number');
      expect(output).toHaveProperty('hint');
      expect(output.hint).toContain('Try: kspec serve --port');
    });

    // AC: @trait-json-output ac-2
    it('should include all data in JSON mode that appears in human mode', async () => {
      if (!bunAvailable) {
        console.log('  ⊘ Skipping test - Bun runtime required');
        return;
      }

      const port = await getAvailablePort();

      // Start daemon
      runKspec(
        `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir
      );

      // Compare JSON vs human output
      const humanResult = runKspec(`serve status --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      const jsonResult = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

      const jsonData = JSON.parse(jsonResult.stdout);

      // Human output should contain the same data
      expect(humanResult.stdout).toContain(String(jsonData.pid));
      expect(humanResult.stdout).toContain(jsonData.running ? 'running' : 'not running');

      // Cleanup
      runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
    });

    // AC: @trait-json-output ac-4
    it('should use @ prefix for references in JSON output', async () => {
      // serve commands don't output references, but we can verify the pattern if they did
      // This test ensures future additions follow the trait
      const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      const output = JSON.parse(result.stdout);

      // Defensive test: if refs are ever added, they should use @ prefix
      // For now, just verify JSON is valid and doesn't contain bare ULID prefixes like "01TASK"
      const jsonStr = JSON.stringify(output);
      expect(jsonStr).not.toMatch(/[^@]01[A-Z0-9]{6}/); // No bare ULID prefixes
    });

    // AC: @trait-json-output ac-5
    it('should use ISO 8601 timestamps in JSON output', async () => {
      // serve status doesn't currently include timestamps, but when it does they should be ISO 8601
      const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      const output = JSON.parse(result.stdout);

      // Defensive test for when uptime/timestamps are added
      if (output.started_at) {
        expect(output.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });

    // AC: @trait-json-output ac-6
    it('should make --json take precedence over other format flags', async () => {
      // Test that --json always produces JSON even with other flags
      const result = runKspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

      // Should be valid JSON, not human-readable text
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      // Should not contain human-readable markers
      expect(result.stdout).not.toContain('Daemon running');
      expect(result.stdout).not.toContain('Daemon not running');
    });
  });

  // Trait tests: @trait-semantic-exit-codes
  describe('Exit codes', () => {
    // AC: @trait-semantic-exit-codes ac-1
    it('should exit with code 0 on success', async () => {
      const result = runKspec(`serve status --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-2
    it('should exit with code 4 on validation errors', async () => {
      const result = runKspec(
        `serve start --port 99999 --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir,
        { expectFail: true }
      );
      expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    });

    // AC: @trait-semantic-exit-codes ac-5
    it('should exit with code 0 for idempotent operations', async () => {
      // Stopping non-running daemon should succeed
      const result = runKspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      expect(result.exitCode).toBe(0);
    });
  });
});
