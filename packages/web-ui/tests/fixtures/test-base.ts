import { test as base, expect } from '@playwright/test';
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, cpSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DAEMON_PORT = 3456;
// E2E tests use dedicated fixtures to avoid breaking unit tests
const E2E_FIXTURES = join(__dirname, '../fixtures');
// Path to built web UI (daemon serves this for E2E tests)
const WEB_UI_BUILD = join(__dirname, '../../build');

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

    // Create temp directory with .kspec subdirectory
    const tempDir = join(tmpdir(), 'kspec-e2e-' + Date.now());
    const kspecDir = join(tempDir, '.kspec');
    mkdirSync(kspecDir, { recursive: true });

    // Copy E2E test fixtures to .kspec subdirectory (simulating shadow worktree mode)
    if (existsSync(E2E_FIXTURES)) {
      cpSync(E2E_FIXTURES, kspecDir, {
        recursive: true,
        filter: (src) => !src.includes('test-base')
      });
    } else {
      throw new Error(`E2E test fixtures not found at ${E2E_FIXTURES}`);
    }

    // Initialize git repo in project root (required for kspec)
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });

    // Set up shadow worktree simulation for kspec to detect .kspec/ as spec directory
    // The shadow detection checks if .kspec/.git is a file starting with "gitdir:"
    // We create a fake .git file that satisfies this check
    const gitWorktreesDir = join(tempDir, '.git', 'worktrees', '-kspec');
    mkdirSync(gitWorktreesDir, { recursive: true });
    // Create the .git file in .kspec pointing to the worktree location
    writeFileSync(join(kspecDir, '.git'), `gitdir: ${gitWorktreesDir}\n`);
    // Create minimal worktree metadata so git doesn't complain
    writeFileSync(join(gitWorktreesDir, 'gitdir'), `${join(tempDir, '.git')}\n`);
    writeFileSync(join(gitWorktreesDir, 'HEAD'), 'ref: refs/heads/kspec-meta\n');

    // Verify web UI is built (daemon serves it for E2E tests)
    if (!existsSync(WEB_UI_BUILD)) {
      throw new Error(
        `Web UI not built. Run 'npm run build -w packages/web-ui' first.\n` +
        `Expected build at: ${WEB_UI_BUILD}`
      );
    }

    // Start daemon - pass project root (tempDir), daemon derives .kspec internally
    // Set WEB_UI_DIR so daemon serves the built web UI
    const startResult = spawnSync(
      'kspec',
      ['serve', 'start', '--daemon', '--port', String(DAEMON_PORT), '--kspec-dir', tempDir],
      {
        cwd: tempDir,
        encoding: 'utf-8',
        env: { ...process.env, WEB_UI_DIR: WEB_UI_BUILD }
      }
    );

    if (startResult.status !== 0) {
      throw new Error('Failed to start daemon: ' + startResult.stderr);
    }

    // Wait for daemon to be ready
    await new Promise((r) => setTimeout(r, 2000));

    // Provide fixture to test
    await use({ tempDir, kspecDir });

    // Cleanup: stop daemon - pass project root to match start
    spawnSync('kspec', ['serve', 'stop', '--kspec-dir', tempDir], {
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
