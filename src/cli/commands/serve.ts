/**
 * kspec serve commands - daemon server lifecycle management
 * AC: @cli-serve-commands
 */

import type { Command } from 'commander';
import { spawn, spawnSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { error, info, output, success, warn } from '../output.js';
import { EXIT_CODES } from '../exit-codes.js';
import { PidFileManager } from '../pid-utils.js';

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
    .action(async (opts) => {
      try {
        await startServer(opts);
      } catch (err) {
        error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-4, ac-5
  serve
    .command('stop')
    .description('Stop the daemon server')
    .option('--kspec-dir <dir>', 'Path to .kspec directory', join(process.cwd(), '.kspec'))
    .action(async (opts) => {
      try {
        await stopServer(opts);
      } catch (err) {
        error(`Failed to stop server: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-6
  serve
    .command('status')
    .description('Check daemon server status')
    .option('--kspec-dir <dir>', 'Path to .kspec directory', join(process.cwd(), '.kspec'))
    .action(async (opts) => {
      try {
        await statusServer(opts);
      } catch (err) {
        error(`Failed to check status: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-7
  serve
    .command('restart')
    .description('Restart the daemon server')
    .option('--kspec-dir <dir>', 'Path to .kspec directory', join(process.cwd(), '.kspec'))
    .action(async (opts) => {
      try {
        await restartServer(opts);
      } catch (err) {
        error(`Failed to restart server: ${err instanceof Error ? err.message : String(err)}`);
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

  // AC: @cli-serve-commands ac-10
  if (isNaN(port) || port < 1 || port > 65535) {
    error('Invalid port number. Must be between 1 and 65535.');
    info('Try: kspec serve --port <PORT>');
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }

  const pidManager = new PidFileManager(opts.kspecDir);

  // Check if already running
  if (pidManager.isDaemonRunning()) {
    const pid = pidManager.read();
    warn(`Daemon already running with PID ${pid}`);
    process.exit(EXIT_CODES.SUCCESS);
  }

  // Get path to daemon entry point
  const daemonBinary = join(import.meta.dirname, '../../../packages/daemon/src/index.ts');

  if (!existsSync(daemonBinary)) {
    error(`Daemon binary not found at: ${daemonBinary}`);
    process.exit(EXIT_CODES.ERROR);
  }

  // AC: @cli-serve-commands ac-2 - background mode
  if (opts.daemon) {
    // Spawn detached process
    const child = spawn('bun', [daemonBinary, '--port', opts.port, '--kspec-dir', opts.kspecDir], {
      detached: true,
      stdio: 'ignore', // TODO: redirect to log file when logging implemented
      cwd: process.cwd(),
    });

    // Detach from parent
    child.unref();

    // Give it a moment to start and write PID
    await new Promise(resolve => setTimeout(resolve, 500));

    const pid = pidManager.read();
    if (pid && pidManager.isDaemonRunning()) {
      success(`Daemon started with PID ${pid} on port ${port}`);
      output({ running: true, pid, port });
    } else {
      error('Daemon failed to start');
      process.exit(EXIT_CODES.ERROR);
    }
  } else {
    // AC: @cli-serve-commands ac-1 - foreground mode
    info(`Starting server in foreground on port ${port}...`);
    info('Press Ctrl+C to stop');

    const child = spawn('bun', [daemonBinary, '--port', opts.port, '--kspec-dir', opts.kspecDir], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      info('\nStopping server...');
      child.kill('SIGTERM');
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
async function stopServer(opts: { kspecDir: string }): Promise<void> {
  const pidManager = new PidFileManager(opts.kspecDir);

  if (!pidManager.isDaemonRunning()) {
    // AC: @cli-serve-commands ac-5
    info('Daemon not running');
    output({ running: false });
    process.exit(EXIT_CODES.SUCCESS);
  }

  const pid = pidManager.read();
  if (!pid) {
    error('Failed to read PID file');
    process.exit(EXIT_CODES.ERROR);
  }

  // AC: @cli-serve-commands ac-4
  info(`Stopping daemon (PID ${pid})...`);

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
      warn(`Daemon did not stop gracefully, forcing...`);
      process.kill(pid, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    success('Daemon stopped');
    output({ stopped: true, pid });
  } catch (err) {
    error(`Failed to stop daemon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_CODES.ERROR);
  }
}

/**
 * Check daemon server status
 * AC: @cli-serve-commands ac-6
 */
async function statusServer(opts: { kspecDir: string }): Promise<void> {
  const pidManager = new PidFileManager(opts.kspecDir);
  const running = pidManager.isDaemonRunning();
  const pid = pidManager.read();

  // TODO: Fetch uptime, connections, port from health endpoint when implemented
  const status = {
    running,
    pid: pid ?? null,
    port: null, // TODO: read from config or health endpoint
    uptime: null, // TODO: fetch from health endpoint
    connections: null, // TODO: fetch from health endpoint
  };

  if (running) {
    output(`Daemon running (PID: ${pid})`);
  } else {
    output('Daemon not running');
  }

  output(status);
}

/**
 * Restart the daemon server
 * AC: @cli-serve-commands ac-7
 */
async function restartServer(opts: { kspecDir: string }): Promise<void> {
  const pidManager = new PidFileManager(opts.kspecDir);

  // Get current port if running (TODO: implement port persistence)
  let port = '3456'; // default

  if (pidManager.isDaemonRunning()) {
    info('Stopping daemon...');
    await stopServer(opts);
  }

  info('Starting daemon...');
  await startServer({ daemon: true, port, kspecDir: opts.kspecDir });
}
