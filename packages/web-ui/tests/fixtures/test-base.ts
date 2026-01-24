import { test as base, expect } from '@playwright/test';
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, cpSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DAEMON_PORT = 3456;
const ROOT_FIXTURES = join(__dirname, '../../../../tests/fixtures');

interface DaemonFixture {
  tempDir: string;
  kspecDir: string;
}

async function cleanupExistingDaemon(): Promise<void> {
  // Kill any daemon that might be running on port 3456
  try {
    if (process.platform === 'win32') {
      // Windows: use netstat to find PID, then taskkill
      const result = spawnSync('netstat', ['-ano'], { encoding: 'utf-8' });
      const lines = result.stdout.split('\n');
      for (const line of lines) {
        if (line.includes(':' + DAEMON_PORT) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid)) {
            spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' });
          }
        }
      }
    } else {
      // Unix: use lsof
      const result = spawnSync('lsof', ['-ti', ':' + DAEMON_PORT], { encoding: 'utf-8' });
      if (result.stdout.trim()) {
        const pids = result.stdout.trim().split('\n');
        for (const pid of pids) {
          try {
            process.kill(parseInt(pid, 10), 'SIGTERM');
          } catch {
            // Process may already be gone
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // Command may not be available on all systems
  }
}

async function checkBunAvailable(): Promise<boolean> {
  try {
    // Use 'where' on Windows, 'which' on Unix
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${cmd} bun`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const test = base.extend<{ daemon: DaemonFixture }>({
  daemon: async ({}, use) => {
    // Check Bun is available (daemon requires it)
    if (!(await checkBunAvailable())) {
      throw new Error(
        'Bun runtime required for daemon. Install: curl -fsSL https://bun.sh/install | bash'
      );
    }

    // Clean up any existing daemon
    await cleanupExistingDaemon();

    // Create temp directory
    const tempDir = join(tmpdir(), 'kspec-e2e-' + Date.now());
    const kspecDir = join(tempDir, '.kspec');
    mkdirSync(kspecDir, { recursive: true });

    // Copy test fixtures
    if (existsSync(ROOT_FIXTURES)) {
      cpSync(ROOT_FIXTURES, kspecDir, { recursive: true });
    } else {
      throw new Error(`Test fixtures not found at ${ROOT_FIXTURES}`);
    }

    // Initialize git repo (required for kspec)
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });

    // Start daemon
    const startResult = spawnSync(
      'kspec',
      ['serve', 'start', '--daemon', '--port', String(DAEMON_PORT), '--kspec-dir', kspecDir],
      { cwd: tempDir, encoding: 'utf-8' }
    );

    if (startResult.status !== 0) {
      throw new Error('Failed to start daemon: ' + startResult.stderr);
    }

    // Wait for daemon to be ready
    await new Promise((r) => setTimeout(r, 1500));

    // Provide fixture to test
    await use({ tempDir, kspecDir });

    // Cleanup: stop daemon
    spawnSync('kspec', ['serve', 'stop', '--kspec-dir', kspecDir], {
      cwd: tempDir,
      encoding: 'utf-8',
    });
    await new Promise((r) => setTimeout(r, 1000));

    // Remove temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  },
});

export { expect };
