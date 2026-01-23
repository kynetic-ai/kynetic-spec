/**
 * E2E tests for daemon executable compilation
 * Spec: @daemon-server
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { stat, rm } from 'fs/promises';
import { join } from 'path';

describe('Daemon Executable Compilation', () => {
  const daemonDir = join(process.cwd(), 'packages/daemon');
  // When running from packages/daemon, outfile is relative to that directory
  // But bun seems to resolve it from the repo root. Let's check both.
  const possiblePaths = [
    join(process.cwd(), 'dist/kspec-daemon'),
    join(daemonDir, 'dist/kspec-daemon'),
  ];

  afterEach(async () => {
    // Clean up compiled executables if they exist
    for (const path of possiblePaths) {
      try {
        await rm(path, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // AC: @daemon-server ac-16
  it('should compile standalone executable with bun build --compile', async () => {
    // Run build:compile script
    const buildResult = spawnSync('bun', ['run', 'build:compile'], {
      cwd: daemonDir,
      encoding: 'utf-8',
      timeout: 60000, // 60s timeout for compilation
    });

    // Build should succeed
    if (buildResult.error) {
      throw new Error(`Build failed: ${buildResult.error.message}\nstdout: ${buildResult.stdout}\nstderr: ${buildResult.stderr}`);
    }
    expect(buildResult.status).toBe(0);

    // Find which path the executable was created at
    let executablePath: string | undefined;
    for (const path of possiblePaths) {
      try {
        const stats = await stat(path);
        if (stats.isFile()) {
          executablePath = path;
          break;
        }
      } catch {
        // Try next path
      }
    }

    if (!executablePath) {
      throw new Error(`Executable not found at any of: ${possiblePaths.join(', ')}`);
    }

    // Verify executable exists
    const stats = await stat(executablePath);
    expect(stats.isFile()).toBe(true);

    // Verify executable permissions (should have execute bit)
    expect(stats.mode & 0o111).toBeGreaterThan(0);

    // Verify it's a valid executable using file command
    const fileResult = spawnSync('file', [executablePath], {
      encoding: 'utf-8',
    });

    expect(fileResult.stdout).toMatch(/executable/i);

    // Verify standalone (should run without Bun runtime)
    // The binary should at least execute even if it fails due to missing .kspec directory
    const runResult = spawnSync(executablePath, ['--port', '9999'], {
      encoding: 'utf-8',
      timeout: 5000,
    });

    // If the binary requires Bun, we'd get ENOENT or "command not found"
    // Instead, it should start (and may fail with app logic error, but that's OK)
    expect(runResult.error?.code).not.toBe('ENOENT');

    // Should at least try to start the daemon
    expect(runResult.stderr || runResult.stdout).toMatch(/daemon/i);
  }, 90000); // 90s timeout for the entire test including compilation

  // AC: @daemon-server ac-16
  it('should have build:compile script in daemon package.json', async () => {
    const { readFile } = await import('fs/promises');
    const packageJson = JSON.parse(
      await readFile(join(daemonDir, 'package.json'), 'utf-8')
    );

    expect(packageJson.scripts).toHaveProperty('build:compile');
    expect(packageJson.scripts['build:compile']).toContain('bun build');
    expect(packageJson.scripts['build:compile']).toContain('--compile');
  });

  // AC: @daemon-server ac-16
  it('should have cross-platform build script', async () => {
    const { access } = await import('fs/promises');
    const scriptPath = join(process.cwd(), 'scripts/build-executables.sh');

    // Script should exist
    await expect(access(scriptPath)).resolves.not.toThrow();

    // Script should be executable
    const stats = await stat(scriptPath);
    expect(stats.mode & 0o111).toBeGreaterThan(0);

    // Script should target multiple platforms
    const { readFile } = await import('fs/promises');
    const scriptContent = await readFile(scriptPath, 'utf-8');

    expect(scriptContent).toContain('bun-linux-x64');
    expect(scriptContent).toContain('bun-darwin-arm64');
    expect(scriptContent).toContain('bun-darwin-x64');
    expect(scriptContent).toContain('bun-windows-x64');
  });
});
