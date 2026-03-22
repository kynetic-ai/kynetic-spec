/**
 * kspec serve commands - daemon server lifecycle management
 * AC: @cli-serve-commands
 */

import type { Command } from 'commander';
import { spawn, execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { error, info, output, success, warn, isJsonMode } from '../output.js';
import { EXIT_CODES } from '../exit-codes.js';
import { PidFileManager } from '../pid-utils.js';
import { loadProjectConfig } from '../../parser/config.js';
import { initContext } from '../../parser/yaml.js';

export async function resolveDefaultKspecDir(explicitDir?: string): Promise<string> {
  if (explicitDir) {
    return explicitDir;
  }

  try {
    const ctx = await initContext();
    return ctx.specDir;
  } catch {
    return join(process.cwd(), '.kspec');
  }
}

/**
 * Check if Bun runtime is available.
 * Daemon requires Bun to run TypeScript directly.
 */
function isBunAvailable(): boolean {
  try {
    execSync('bun --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Check if daemon dist files are stale (source newer than dist)
 * Returns true if rebuild is recommended
 */
function checkDaemonStaleness(): boolean {
  // __dirname is dist/cli/commands, go up 3 levels to package root, then into packages/daemon/src
  const sourceDir = join(__dirname, '../../../packages/daemon/src');
  // dist/daemon is 2 levels up from __dirname
  const distDir = join(__dirname, '../../daemon');

  if (!existsSync(sourceDir) || !existsSync(distDir)) return false;

  try {
    const getNewestMtime = (dir: string): number => {
      const files = readdirSync(dir, { withFileTypes: true });
      let newest = 0;
      for (const f of files) {
        const fullPath = join(dir, f.name);
        if (f.isDirectory()) {
          newest = Math.max(newest, getNewestMtime(fullPath));
        } else if (f.name.endsWith('.ts')) {
          newest = Math.max(newest, statSync(fullPath).mtimeMs);
        }
      }
      return newest;
    };

    const newestSource = getNewestMtime(sourceDir);
    const newestDist = getNewestMtime(distDir);

    return newestSource > newestDist;
  } catch {
    return false; // Don't warn if check fails
  }
}

/**
 * Normalize daemon uptime payloads to seconds.
 * Some runtimes may serialize uptime as structured objects instead of a number.
 */
function parseUptimeSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }

  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as { seconds?: unknown; milliseconds?: unknown; ms?: unknown };
  if (typeof candidate.seconds === 'number' && Number.isFinite(candidate.seconds)) {
    return candidate.seconds;
  }
  if (typeof candidate.milliseconds === 'number' && Number.isFinite(candidate.milliseconds)) {
    return candidate.milliseconds / 1000;
  }
  if (typeof candidate.ms === 'number' && Number.isFinite(candidate.ms)) {
    return candidate.ms / 1000;
  }

  return null;
}

export function buildDaemonChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const { KSPEC_NO_DAEMON: _kspecNoDaemon, ...childEnv } = baseEnv;
  return { ...childEnv, BUN_ENV: 'production' };
}


/**
 * AC: @cli-serve-commands ac-11
 * Refuse to modify daemon lifecycle when running inside an agent invocation.
 * Agents inherit KSPEC_SESSION_ID — stopping the daemon would kill the dispatch engine.
 */
function guardAgentContext(action: string): void {
  if (process.env.KSPEC_SESSION_ID) {
    if (isJsonMode()) {
      output({
        error: `Cannot ${action} daemon from inside an agent invocation.`,
        reason: 'Stopping or restarting the daemon would kill the dispatch engine hosting this agent.',
        suggestion: 'The daemon is managed externally. Do not run kspec serve commands from agent code.',
      });
    } else {
      error(`Cannot ${action} daemon from inside an agent invocation.`);
      error('Stopping or restarting the daemon would kill the dispatch engine hosting this agent.');
      error('The daemon is managed externally. Do not run kspec serve commands from agent code.');
    }
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }
}

/**
 * Register serve commands
 */
export function registerServeCommands(program: Command): void {
  const serve = program
    .command('serve')
    .description('Manage the kspec daemon server');

  // AC: @cli-serve-commands ac-1, ac-2, ac-3
  // AC: @config-daemon ac-1, ac-2 — port from config, CLI flag overrides
  serve
    .command('start', { isDefault: true })
    .description('Start the daemon server')
    .option('-d, --daemon', 'Run in background (detached mode)')
    .option('-p, --port <port>', 'Server port (uses config daemon.port if not specified)')
    .option('--kspec-dir <dir>', 'Path to .kspec directory (defaults to resolved project .kspec)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await startServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-4, ac-5
  serve
    .command('stop')
    .description('Stop the daemon server')
    .option('--kspec-dir <dir>', 'Path to .kspec directory (defaults to resolved project .kspec)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await stopServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to stop server: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-6
  serve
    .command('status')
    .description('Check daemon server status')
    .option('--kspec-dir <dir>', 'Path to .kspec directory (defaults to resolved project .kspec)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await statusServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to check status: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-7
  serve
    .command('restart')
    .description('Restart the daemon server')
    .option('--kspec-dir <dir>', 'Path to .kspec directory (defaults to resolved project .kspec)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      try {
        await restartServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to restart server: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Start the daemon server
 * AC: @cli-serve-commands ac-1 (foreground), ac-2 (daemon), ac-3 (port), ac-10 (port error)
 * AC: @config-daemon ac-1 — port from config, ac-2 — CLI flag overrides config
 */
async function startServer(opts: {
  daemon?: boolean;
  port?: string;
  kspecDir?: string;
}): Promise<void> {
  // AC: @cli-serve-commands ac-11
  guardAgentContext('start');
  const jsonMode = isJsonMode();
  const kspecDir = await resolveDefaultKspecDir(opts.kspecDir);

  // AC: @config-daemon ac-1, ac-2 — load config for default port, CLI flag overrides
  const { config } = await loadProjectConfig();
  const configPort = config.daemon.port;

  // AC: @config-daemon ac-2 — CLI flag takes precedence over config
  const port = opts.port ? parseInt(opts.port, 10) : configPort;

  // AC: @cli-serve-commands ac-10
  if (isNaN(port) || port < 1 || port > 65535) {
    if (jsonMode) {
      output({
        error: 'Invalid port number. Must be between 1 and 65535.',
        hint: 'Try: kspec serve --port <PORT>',
      });
    } else {
      error('Invalid port number. Must be between 1 and 65535.');
      error('Try: kspec serve --port <PORT>');
    }
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }

  const pidManager = new PidFileManager();

  // Check if already running
  if (pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
    const pid = pidManager.readPid();
    const existingPort = pidManager.readPort();
    if (isJsonMode()) {
      output({ running: true, pid, port: existingPort, message: 'Daemon already running' });
    } else {
      warn(`Daemon already running on port ${existingPort}`);
    }
    process.exit(EXIT_CODES.SUCCESS);
  }

  // Get path to daemon entry point
  // Daemon source is bundled at dist/daemon/index.ts (relative to package root)
  // __dirname is dist/cli/commands, so go up 2 levels to dist/, then into daemon/
  // Note: Daemon is TypeScript source - requires Bun runtime
  const daemonBinary = join(__dirname, '../../daemon/index.ts');

  if (!existsSync(daemonBinary)) {
    if (isJsonMode()) {
      output({ error: `Daemon binary not found at ${daemonBinary}`, hint: 'Ensure the kspec package is properly installed' });
    } else {
      error(`Daemon binary not found at: ${daemonBinary}`);
      error('Ensure the kspec package is properly installed');
    }
    process.exit(EXIT_CODES.ERROR);
  }

  // AC: @web-ui ac-2 — clear error with install URL when Bun is missing
  if (!isBunAvailable()) {
    const installHint = process.platform === 'win32'
      ? 'Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"'
      : 'Install Bun: curl -fsSL https://bun.sh/install | bash';
    if (isJsonMode()) {
      output({
        error: 'Bun runtime is required for the kspec daemon',
        hint: installHint,
        url: 'https://bun.sh/docs/installation',
      });
    } else {
      error('Bun runtime is required for the kspec daemon');
      error('The daemon uses Elysia (a Bun-native framework) and cannot run on Node.js alone.');
      info(installHint);
      info('For more options: https://bun.sh/docs/installation');
    }
    process.exit(EXIT_CODES.ERROR);
  }

  // Check for stale daemon build (dev experience improvement)
  if (checkDaemonStaleness() && !jsonMode) {
    warn('Warning: dist/daemon/ may be stale (source files are newer).');
    warn('  Run "npm run build:daemon" to update.');
  }

  // AC: @cli-serve-commands ac-2 - background mode
  if (opts.daemon) {
    const runtime = 'bun';

    // Spawn detached process
    // Set BUN_ENV=production to prevent Bun dev mode HTML transformation
    // which can cause asset hash mismatches in the web UI
    const child = spawn(runtime, [daemonBinary, '--port', String(port), '--kspec-dir', kspecDir], {
      detached: true,
      stdio: 'ignore', // TODO: redirect to log file when logging implemented
      cwd: process.cwd(),
      env: buildDaemonChildEnv(),
    });

    // Detach from parent
    child.unref();

    // Poll for PID file with timeout (max 5 seconds)
    const maxWait = 5000;
    const startTime = Date.now();
    let pid: number | null = null;

    while (Date.now() - startTime < maxWait) {
      pid = pidManager.readPid();
      if (pid && pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (pid && pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
      if (isJsonMode()) {
        output({ running: true, pid, port });
      } else {
        success(`Daemon started with PID ${pid} on port ${port}`);
        output({ running: true, pid, port });
      }
    } else {
      if (isJsonMode()) {
        output({ error: 'Daemon failed to start within 5 seconds' });
      } else {
        error('Daemon failed to start within 5 seconds');
      }
      process.exit(EXIT_CODES.ERROR);
    }
  } else {
    // AC: @cli-serve-commands ac-1 - foreground mode
    if (!isJsonMode()) {
      info(`Starting server in foreground on port ${port}...`);
      info('Press Ctrl+C to stop');
    }

    const runtime = 'bun';

    // Set BUN_ENV=production to prevent Bun dev mode HTML transformation
    const child = spawn(runtime, [daemonBinary, '--port', String(port), '--kspec-dir', kspecDir], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: buildDaemonChildEnv(),
    });

    // Handle Ctrl+C - forward SIGTERM to child for graceful shutdown
    process.on('SIGINT', () => {
      if (!isJsonMode()) {
        info('\nStopping server...');
      }
      child.kill('SIGTERM');

      // Wait for graceful shutdown (max 5 seconds)
      const shutdownTimeout = setTimeout(() => {
        child.kill('SIGKILL'); // Force kill if not stopped
      }, 5000);

      child.on('exit', () => {
        clearTimeout(shutdownTimeout);
      });
    });

    // Wait for process to exit
    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  }
}

/**
 * Stop the daemon server
 * AC: @cli-serve-commands ac-4 (stop), ac-5 (idempotent)
 */
async function stopServer(opts: { kspecDir?: string; json?: boolean }): Promise<void> {
  // AC: @cli-serve-commands ac-11
  guardAgentContext('stop');

  const pidManager = new PidFileManager();

  if (!pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
    // AC: @cli-serve-commands ac-5
    if (isJsonMode()) {
      output({ running: false });
    } else {
      info('Daemon not running');
      output({ running: false });
    }
    process.exit(EXIT_CODES.SUCCESS);
  }

  const pid = pidManager.readPid();
  if (!pid) {
    if (isJsonMode()) {
      output({ error: 'Failed to read PID file' });
    } else {
      error('Failed to read PID file');
    }
    process.exit(EXIT_CODES.ERROR);
  }

  // AC: @cli-serve-commands ac-4
  if (!isJsonMode()) {
    info(`Stopping daemon (PID ${pid})...`);
  }

  try {
    // Send SIGTERM
    process.kill(pid, 'SIGTERM');

    // Wait for clean shutdown (max 5 seconds)
    const maxWait = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      if (!pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
      if (!isJsonMode()) {
        warn(`Daemon did not stop gracefully, forcing...`);
      }
      process.kill(pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (isJsonMode()) {
      output({ stopped: true, pid });
    } else {
      success('Daemon stopped');
      output({ stopped: true, pid });
    }
  } catch (err) {
    if (isJsonMode()) {
      output({ error: err instanceof Error ? err.message : String(err) });
    } else {
      error(`Failed to stop daemon: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(EXIT_CODES.ERROR);
  }
}

/**
 * Check daemon server status
 * AC: @cli-serve-commands ac-6, @multi-directory-daemon ac-12
 */
async function statusServer(opts: { kspecDir?: string; json?: boolean }): Promise<void> {
  if (isJsonMode()) {
  }

  const pidManager = new PidFileManager();
  const running = pidManager.isDaemonRunning({ ignoreNoDaemon: true });
  const pid = pidManager.readPid();

  // Read port from global config (AC: @multi-directory-daemon ac-13)
  let port: number | null = null;
  if (running) {
    try {
      port = pidManager.readPort();
    } catch {
      // Port file might not exist or be invalid
      port = null;
    }
  }

  // AC: @multi-directory-daemon ac-12 - Fetch list of registered projects and uptime
  let projects: Array<{ path: string; registeredAt: string; watcherStatus: string }> = [];
  let uptime: number | null = null;
  if (running && port) {
    try {
      const response = await fetch(`http://localhost:${port}/api/projects`);
      if (response.ok) {
        const data = await response.json() as { projects: Array<{ path: string; registeredAt: string; watcherStatus: string }> };
        projects = data.projects || [];
      }
    } catch {
      // If daemon is not responding, continue without projects list
      // This can happen if daemon is still starting up or network issues
    }

    // Fetch uptime from health endpoint.
    // Retry briefly to reduce startup races where status is checked immediately after daemon start.
    for (let attempt = 1; attempt <= 5 && uptime === null; attempt++) {
      try {
        const healthResponse = await fetch(`http://localhost:${port}/api/health`);
        if (healthResponse.ok) {
          const healthData = await healthResponse.json() as { status: string; uptime?: unknown };
          const parsed = parseUptimeSeconds(healthData.uptime);
          if (parsed !== null) {
            uptime = parsed;
            break;
          }
        }
      } catch {
        // If health endpoint fails, continue retry loop.
      }

      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }

  const status = {
    running,
    pid: pid ?? null,
    port,
    uptime,
    projects,
  };

  if (isJsonMode()) {
    output(status);
  } else {
    if (running) {
      output(`Daemon running (PID: ${pid})`);
      if (port) {
        output(`  Port: ${port}`);
      }
      // AC: @multi-directory-daemon ac-12 - Show uptime
      if (uptime !== null) {
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        if (hours > 0) {
          output(`  Uptime: ${hours}h ${minutes}m ${seconds}s`);
        } else if (minutes > 0) {
          output(`  Uptime: ${minutes}m ${seconds}s`);
        } else {
          output(`  Uptime: ${seconds}s`);
        }
      }
      // AC: @multi-directory-daemon ac-12 - Show registered projects
      if (projects.length > 0) {
        output(`\nRegistered projects (${projects.length}):`);
        for (const project of projects) {
          output(`  ${project.path} (watcher: ${project.watcherStatus})`);
        }
      } else {
        output(`\nNo projects registered`);
      }
    } else {
      output('Daemon not running');
    }
  }
}

/**
 * Restart the daemon server
 * AC: @cli-serve-commands ac-7
 */
async function restartServer(opts: { kspecDir?: string; json?: boolean }): Promise<void> {
  // AC: @cli-serve-commands ac-11
  guardAgentContext('restart');
  const pidManager = new PidFileManager();

  // AC: @cli-serve-commands ac-7 - preserve port across restarts
  // Try to read port from existing daemon, otherwise startServer will use config default
  let port: string | undefined;
  try {
    port = pidManager.readPort().toString();
  } catch {
    // Port file doesn't exist or is invalid, let startServer use config
  }

  if (pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
    if (!isJsonMode()) {
      info('Stopping daemon...');
    }
    await stopServer(opts);
  }

  if (!isJsonMode()) {
    info('Starting daemon...');
  }
  await startServer({ daemon: true, port, kspecDir: opts.kspecDir });
}
