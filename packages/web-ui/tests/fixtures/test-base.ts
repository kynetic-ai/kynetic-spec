import { test as base, expect } from '@playwright/test';
import { execSync, spawnSync } from 'child_process';
import { mkdirSync, cpSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { createServer } from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// E2E tests use dedicated fixtures to avoid breaking unit tests
const E2E_FIXTURES = join(__dirname, '../fixtures');
// Path to built web UI (daemon serves this for E2E tests)
const WEB_UI_BUILD = join(__dirname, '../../build');

interface DaemonFixture {
  tempDir: string;
  kspecDir: string;
  /** Ephemeral port the test daemon is listening on */
  port: number;
  /** Base URL for HTTP requests (http://localhost:<port>) */
  baseUrl: string;
  /** Base URL for WebSocket connections (ws://localhost:<port>) */
  wsUrl: string;
  /** Create a valid second project for multi-project tests */
  createSecondProject: () => Promise<string>;
}

// AC: @e2e-test-daemon-isolation ac-1 — ephemeral port allocation
async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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
  // AC: @e2e-test-daemon-isolation ac-5 — dynamic baseURL from daemon fixture
  baseURL: async ({ daemon }, use) => {
    await use(daemon.baseUrl);
  },

  daemon: [async ({}, use) => {
    // Check Bun is available (daemon requires it)
    if (!(await checkBunAvailable())) {
      throw new Error(
        'Bun runtime required for daemon. Install: curl -fsSL https://bun.sh/install | bash'
      );
    }

    // AC: @e2e-test-daemon-isolation ac-1 — use ephemeral port, never hardcoded
    // AC: @e2e-test-daemon-isolation ac-2 — never kill user daemons
    const port = await getAvailablePort();
    const baseUrl = `http://localhost:${port}`;
    const wsUrl = `ws://localhost:${port}`;

    // Create temp directory with .kspec subdirectory
    const tempDir = join(tmpdir(), 'kspec-e2e-' + Date.now());
    const kspecDir = join(tempDir, '.kspec');
    mkdirSync(kspecDir, { recursive: true });

    // AC: @e2e-test-daemon-isolation ac-3 — isolated HOME/config
    const isolatedHome = join(tempDir, '.home');
    const configDir = join(isolatedHome, '.config', 'kspec');
    mkdirSync(configDir, { recursive: true });
    const { KSPEC_NO_DAEMON: _kspecNoDaemon, ...baseEnv } = process.env;
    const isolatedEnv = {
      ...baseEnv,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      WEB_UI_DIR: WEB_UI_BUILD,
    };

    // Copy E2E test fixtures to .kspec subdirectory (simulating shadow worktree mode)
    if (existsSync(E2E_FIXTURES)) {
      cpSync(E2E_FIXTURES, kspecDir, {
        recursive: true,
        filter: (src) => !src.includes('test-base') && !src.includes('project-tests')
      });
    } else {
      throw new Error(`E2E test fixtures not found at ${E2E_FIXTURES}`);
    }

    // Copy project-level tests directory for AC coverage scanning
    const projectTests = join(E2E_FIXTURES, 'project-tests');
    if (existsSync(projectTests)) {
      cpSync(projectTests, join(tempDir, 'tests'), { recursive: true });
    }

    // Initialize git repo in project root (required for kspec)
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });

    // Set up shadow worktree simulation for kspec to detect .kspec/ as spec directory
    const gitWorktreesDir = join(tempDir, '.git', 'worktrees', '-kspec');
    mkdirSync(gitWorktreesDir, { recursive: true });
    writeFileSync(join(kspecDir, '.git'), `gitdir: ${gitWorktreesDir}\n`);
    writeFileSync(join(gitWorktreesDir, 'gitdir'), `${join(tempDir, '.git')}\n`);
    writeFileSync(join(gitWorktreesDir, 'HEAD'), 'ref: refs/heads/kspec-meta\n');

    // Verify web UI is built (daemon serves it for E2E tests)
    if (!existsSync(WEB_UI_BUILD)) {
      throw new Error(
        `Web UI not built. Run 'npm run build -w packages/web-ui' first.\n` +
        `Expected build at: ${WEB_UI_BUILD}`
      );
    }

    // Start daemon on ephemeral port with isolated HOME
    const startResult = spawnSync(
      'kspec',
      ['serve', 'start', '--daemon', '--port', String(port), '--kspec-dir', tempDir],
      {
        cwd: tempDir,
        encoding: 'utf-8',
        env: isolatedEnv,
      }
    );

    if (startResult.status !== 0) {
      throw new Error('Failed to start daemon: ' + startResult.stderr);
    }

    // Wait for daemon to be ready by polling health endpoint
    const maxAttempts = 30;
    const pollInterval = 100;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) break;
      } catch {
        // Daemon not ready yet
      }
      if (i === maxAttempts - 1) {
        throw new Error(`Daemon failed to become ready after ${maxAttempts * pollInterval}ms`);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    // Helper to create a valid second project for multi-project tests
    // AC: @multi-directory-daemon ac-25 - Tests need multiple valid projects
    async function createSecondProject(): Promise<string> {
      const secondProjectPath = tempDir + '-second';
      const secondKspecDir = join(secondProjectPath, '.kspec');

      mkdirSync(secondKspecDir, { recursive: true });

      writeFileSync(
        join(secondKspecDir, 'kynetic.yaml'),
        `kynetic: "1.0"
project: Second Test Project
`
      );

      writeFileSync(
        join(secondKspecDir, 'project.tasks.yaml'),
        `# Tasks for second test project
tasks: []
`
      );

      execSync('git init', { cwd: secondProjectPath, stdio: 'ignore' });
      execSync('git config user.email "test@test.com"', { cwd: secondProjectPath, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: secondProjectPath, stdio: 'ignore' });

      const gitWorktreesDir = join(secondProjectPath, '.git', 'worktrees', '-kspec');
      mkdirSync(gitWorktreesDir, { recursive: true });
      writeFileSync(join(secondKspecDir, '.git'), `gitdir: ${gitWorktreesDir}\n`);
      writeFileSync(join(gitWorktreesDir, 'gitdir'), `${join(secondProjectPath, '.git')}\n`);
      writeFileSync(join(gitWorktreesDir, 'HEAD'), 'ref: refs/heads/kspec-meta\n');

      // AC: @e2e-test-daemon-isolation ac-5 — use dynamic port
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: secondProjectPath }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to register second project: ${error}`);
      }

      return secondProjectPath;
    }

    // AC: @e2e-test-daemon-isolation ac-5 — propagate port/URLs to all tests
    await use({ tempDir, kspecDir, port, baseUrl, wsUrl, createSecondProject });

    // AC: @e2e-test-daemon-isolation ac-4 — scoped cleanup via serve stop, not process killing
    spawnSync('kspec', ['serve', 'stop', '--kspec-dir', tempDir], {
      cwd: tempDir,
      encoding: 'utf-8',
      env: isolatedEnv,
    });
    await new Promise((r) => setTimeout(r, 500));

    // Remove temp directories
    try {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(tempDir + '-second', { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }, { scope: 'test' }],
});

export { expect };
