/**
 * kspec serve commands - daemon server lifecycle management
 * AC: @cli-serve-commands
 */

import type { Command } from 'commander';
import { spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { error, info, output, success, warn, isJsonMode } from '../output.js';
import { EXIT_CODES } from '../exit-codes.js';
import { PidFileManager } from '../pid-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Reads the daemon port from config file
 */
function readDaemonPort(kspecDir: string): string | null {
  const portFile = join(kspecDir, '.daemon.port');
  try {
    if (existsSync(portFile)) {
      return readFileSync(portFile, 'utf-8').trim();
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

/**
 * Writes the daemon port to config file
 */
function writeDaemonPort(kspecDir: string, port: string): void {
  const portFile = join(kspecDir, '.daemon.port');
  try {
    writeFileSync(portFile, port, 'utf-8');
  } catch {
    // Ignore write errors - not critical
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
  serve
    .command('start', { isDefault: true })
    .description('Start the daemon server')
    .option('-d, --daemon', 'Run in background (detached mode)')
    .option('-p, --port <port>', 'Server port (default: 3456)', '3456')
    .option('--kspec-dir <dir>', 'Path to .kspec directory', join(process.cwd(), '.kspec'))
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
    .option('--kspec-dir <dir>', 'Path to .kspec directory', join(process.cwd(), '.kspec'))
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
    .option('--kspec-dir <dir>', 'Path to .kspec directory', join(process.cwd(), '.kspec'))
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
    .option('--kspec-dir <dir>', 'Path to .kspec directory', join(process.cwd(), '.kspec'))
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
 */
async function startServer(opts: {
  daemon?: boolean;
  port: string;
  kspecDir: string;
}): Promise<void> {
  const port = parseInt(opts.port, 10);
  const jsonMode = isJsonMode();

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

  const pidManager = new PidFileManager(opts.kspecDir);

  // Check if already running
  if (pidManager.isDaemonRunning()) {
    const pid = pidManager.read();
    if (isJsonMode()) {
      output({ running: true, pid, message: 'Daemon already running' });
    } else {
      warn(`Daemon already running with PID ${pid}`);
    }
    process.exit(EXIT_CODES.SUCCESS);
  }

  // Get path to daemon entry point
  // In development (monorepo): packages/daemon/src/index.ts
  // In production (npm install): node_modules/@kynetic-ai/daemon/dist/index.js
  const packageRoot = join(__dirname, '../../..');  // From dist/cli/commands to project root

  // Try production path first (npm install scenario)
  let daemonBinary = join(packageRoot, 'node_modules/@kynetic-ai/daemon/dist/index.js');

  // Fall back to development path (monorepo scenario)
  if (!existsSync(daemonBinary)) {
    daemonBinary = join(packageRoot, 'packages/daemon/src/index.ts');
  }

  if (!existsSync(daemonBinary)) {
    if (isJsonMode()) {
      output({ error: `Daemon binary not found`, hint: 'Ensure the kspec package is properly installed' });
    } else {
      error(`Daemon binary not found at expected locations:`);
      error(`  Production: ${join(packageRoot, 'node_modules/@kynetic-ai/daemon/dist/index.js')}`);
      error(`  Development: ${join(packageRoot, 'packages/daemon/src/index.ts')}`);
      error('Ensure the kspec package is properly installed');
    }
    process.exit(EXIT_CODES.ERROR);
  }

  // AC: @cli-serve-commands ac-2 - background mode
  if (opts.daemon) {
    // Write port config for restart persistence (AC: @cli-serve-commands ac-7)
    writeDaemonPort(opts.kspecDir, opts.port);

    // Determine runtime based on file extension
    // .ts files need bun, .js files can use node
    const runtime = daemonBinary.endsWith('.ts') ? 'bun' : 'node';

    // Spawn detached process
    const child = spawn(runtime, [daemonBinary, '--port', opts.port, '--kspec-dir', opts.kspecDir], {
      detached: true,
      stdio: 'ignore', // TODO: redirect to log file when logging implemented
      cwd: process.cwd(),
    });

    // Detach from parent
    child.unref();

    // Poll for PID file with timeout (max 5 seconds)
    const maxWait = 5000;
    const startTime = Date.now();
    let pid: number | null = null;

    while (Date.now() - startTime < maxWait) {
      pid = pidManager.read();
      if (pid && pidManager.isDaemonRunning()) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (pid && pidManager.isDaemonRunning()) {
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

    // Determine runtime based on file extension
    const runtime = daemonBinary.endsWith('.ts') ? 'bun' : 'node';

    const child = spawn(runtime, [daemonBinary, '--port', opts.port, '--kspec-dir', opts.kspecDir], {
      stdio: 'inherit',
      cwd: process.cwd(),
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
async function stopServer(opts: { kspecDir: string; json?: boolean }): Promise<void> {
  if (isJsonMode()) {
  }

  const pidManager = new PidFileManager(opts.kspecDir);

  if (!pidManager.isDaemonRunning()) {
    // AC: @cli-serve-commands ac-5
    if (isJsonMode()) {
      output({ running: false });
    } else {
      info('Daemon not running');
      output({ running: false });
    }
    process.exit(EXIT_CODES.SUCCESS);
  }

  const pid = pidManager.read();
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
      if (!pidManager.isDaemonRunning()) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (pidManager.isDaemonRunning()) {
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
 * AC: @cli-serve-commands ac-6
 */
async function statusServer(opts: { kspecDir: string; json?: boolean }): Promise<void> {
  if (isJsonMode()) {
  }

  const pidManager = new PidFileManager(opts.kspecDir);
  const running = pidManager.isDaemonRunning();
  const pid = pidManager.read();

  // Read port from config (AC: @cli-serve-commands ac-6)
  const port = readDaemonPort(opts.kspecDir);

  // TODO: Fetch uptime, connections from health endpoint when implemented
  const status = {
    running,
    pid: pid ?? null,
    port: port ? parseInt(port, 10) : null,
    uptime: null, // TODO: fetch from health endpoint
    connections: null, // TODO: fetch from health endpoint
  };

  if (isJsonMode()) {
    output(status);
  } else {
    if (running) {
      output(`Daemon running (PID: ${pid})`);
    } else {
      output('Daemon not running');
    }
    output(status);
  }
}

/**
 * Restart the daemon server
 * AC: @cli-serve-commands ac-7
 */
async function restartServer(opts: { kspecDir: string; json?: boolean }): Promise<void> {
  if (isJsonMode()) {
  }

  const pidManager = new PidFileManager(opts.kspecDir);

  // AC: @cli-serve-commands ac-7 - preserve port across restarts
  let port = readDaemonPort(opts.kspecDir) || '3456'; // use saved port or default

  if (pidManager.isDaemonRunning()) {
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
