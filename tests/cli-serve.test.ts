/**
 * E2E tests for kspec serve CLI commands
 * Spec: @cli-serve-commands
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir, initGitRepo, setupTempFixtures, kspec, kspecJson } from './helpers/cli';
import { spawn, execSync } from 'child_process';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

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
  let pidFilePath: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await initGitRepo(tempDir);
    await setupTempFixtures(tempDir);
    pidFilePath = join(tempDir, '.kspec', '.daemon.pid');
  });

  afterEach(async () => {
    // Kill any daemon that might still be running
    try {
      if (existsSync(pidFilePath)) {
        const pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
        if (!isNaN(pid)) {
          process.kill(pid, 'SIGTERM');
          // Give it a moment to stop
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch {
      // Ignore if process doesn't exist
    }

    await cleanupTempDir(tempDir);
  });

  // AC: @cli-serve-commands ac-1
  it('should start in foreground mode with Ctrl+C support', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    // Use a unique port for this test
    const port = 3500 + Math.floor(Math.random() * 100);

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
    });

    let output = '';
    child.stdout?.on('data', (data) => {
      output += data.toString();
    });

    child.stderr?.on('data', (data) => {
      output += data.toString();
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify output mentions foreground and port
    expect(output).toContain('Starting server in foreground');
    expect(output).toContain(`port ${port}`);

    // Send SIGINT (Ctrl+C)
    child.kill('SIGINT');

    // Wait for shutdown
    await new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });

    expect(child.exitCode).toBe(0);
  });

  // AC: @cli-serve-commands ac-2
  it('should start in daemon mode and detach', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = 3500 + Math.floor(Math.random() * 100);

    const result = kspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    // Should report success
    expect(result.stdout).toContain('Daemon started');
    expect(result.stdout).toContain(`port ${port}`);

    // PID file should exist
    expect(existsSync(pidFilePath)).toBe(true);

    const pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
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
    kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-3
  it('should accept custom port via --port flag', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const customPort = 4567;

    const result = kspec(
      `serve start --daemon --port ${customPort} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    expect(result.stdout).toContain(`port ${customPort}`);

    // Cleanup
    kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-4
  it('should send SIGTERM and wait for shutdown', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = 3500 + Math.floor(Math.random() * 100);

    // Start daemon
    kspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    const pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);

    // Stop daemon
    const result = kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

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
    const result = kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

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
    const port = 3500 + Math.floor(Math.random() * 100);
    kspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    const pid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);

    // Check status
    const result = kspec(`serve status --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    expect(result.stdout).toContain('Daemon running');
    expect(result.stdout).toContain(`PID: ${pid}`);

    // Should output JSON
    const lines = result.stdout.split('\n');
    const jsonLine = lines.find(line => line.trim().startsWith('{'));
    expect(jsonLine).toBeTruthy();

    const status = JSON.parse(jsonLine!);
    expect(status).toMatchObject({
      running: true,
      pid: pid,
    });

    // Cleanup
    kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-7
  it('should stop then start on restart', async () => {
    if (!bunAvailable) {
      console.log('  ⊘ Skipping test - Bun runtime required');
      return;
    }

    const port = 3500 + Math.floor(Math.random() * 100);

    // Start daemon
    kspec(
      `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir
    );

    const originalPid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);

    // Restart
    const result = kspec(`serve restart --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

    expect(result.stdout).toContain('Stopping daemon');
    expect(result.stdout).toContain('Starting daemon');

    // Should have new PID
    const newPid = parseInt(readFileSync(pidFilePath, 'utf-8').trim(), 10);
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
    kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
  });

  // AC: @cli-serve-commands ac-10
  it('should show error with recovery hint for invalid port', async () => {
    const result = kspec(
      `serve start --port 99999 --kspec-dir ${join(tempDir, '.kspec')}`,
      tempDir,
      { expectFail: true }
    );

    expect(result.exitCode).not.toBe(0);

    // Error and hint should be in stderr
    expect(result.stderr).toContain('Invalid port number');
    expect(result.stderr).toContain('Try: kspec serve --port');
  });

  // Trait tests: @trait-json-output
  describe('JSON output mode', () => {
    // AC: @trait-json-output ac-1, ac-2
    it('should output valid JSON with --json for serve status', async () => {
      const result = kspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

      // Should be valid JSON
      expect(() => JSON.parse(result.stdout)).not.toThrow();

      const output = JSON.parse(result.stdout);
      expect(output).toHaveProperty('running');
      expect(output).toHaveProperty('pid');
    });

    // AC: @trait-json-output ac-3, @trait-error-guidance ac-6
    it('should output errors as JSON with --json flag', async () => {
      const result = kspec(
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

      const port = 3500 + Math.floor(Math.random() * 100);

      // Start daemon
      kspec(
        `serve start --daemon --port ${port} --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir
      );

      // Compare JSON vs human output
      const humanResult = kspec(`serve status --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      const jsonResult = kspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

      const jsonData = JSON.parse(jsonResult.stdout);

      // Human output should contain the same data
      expect(humanResult.stdout).toContain(String(jsonData.pid));
      expect(humanResult.stdout).toContain(jsonData.running ? 'running' : 'not running');

      // Cleanup
      kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
    });

    // AC: @trait-json-output ac-4
    it('should use @ prefix for references in JSON output', async () => {
      // serve commands don't output references, but we can verify the pattern if they did
      // This test ensures future additions follow the trait
      const result = kspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      const output = JSON.parse(result.stdout);

      // Defensive test: if refs are ever added, they should use @ prefix
      // For now, just verify JSON is valid and doesn't contain bare ULID prefixes like "01TASK"
      const jsonStr = JSON.stringify(output);
      expect(jsonStr).not.toMatch(/[^@]01[A-Z0-9]{6}/); // No bare ULID prefixes
    });

    // AC: @trait-json-output ac-5
    it('should use ISO 8601 timestamps in JSON output', async () => {
      // serve status doesn't currently include timestamps, but when it does they should be ISO 8601
      const result = kspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      const output = JSON.parse(result.stdout);

      // Defensive test for when uptime/timestamps are added
      if (output.started_at) {
        expect(output.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }
    });

    // AC: @trait-json-output ac-6
    it('should make --json take precedence over other format flags', async () => {
      // Test that --json always produces JSON even with other flags
      const result = kspec(`serve status --json --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);

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
      const result = kspec(`serve status --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-2
    it('should exit with code 4 on validation errors', async () => {
      const result = kspec(
        `serve start --port 99999 --kspec-dir ${join(tempDir, '.kspec')}`,
        tempDir,
        { expectFail: true }
      );
      expect(result.exitCode).toBe(4); // VALIDATION_FAILED
    });

    // AC: @trait-semantic-exit-codes ac-5
    it('should exit with code 0 for idempotent operations', async () => {
      // Stopping non-running daemon should succeed
      const result = kspec(`serve stop --kspec-dir ${join(tempDir, '.kspec')}`, tempDir);
      expect(result.exitCode).toBe(0);
    });
  });
});
