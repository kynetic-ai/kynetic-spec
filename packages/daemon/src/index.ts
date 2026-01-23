#!/usr/bin/env bun
/**
 * Kspec Daemon Entry Point
 *
 * Long-running server that exposes kspec state via HTTP API and WebSocket.
 * Supports foreground and background modes with PID file management.
 * AC: @daemon-server ac-9
 */

import { createServer } from './server.js';
import { parseArgs } from 'util';
import { join } from 'path';

// Parse command line args
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: 'string', default: '3456' },
    'kspec-dir': { type: 'string' }
  },
  allowPositionals: true
});

const port = parseInt(values.port as string, 10);
const kspecDir = (values['kspec-dir'] as string) || join(process.cwd(), '.kspec');

// Validate port
if (isNaN(port) || port < 1 || port > 65535) {
  console.error('[daemon] Invalid port number. Must be between 1 and 65535.');
  process.exit(1);
}

async function main() {
  try {
    console.log(`[daemon] Starting kspec daemon on port ${port}...`);

    const server = await createServer({
      port,
      isDaemon: true, // Always true when running as standalone daemon
      kspecDir
    });

    // Server will start listening in createServer
    // Graceful shutdown handled in server.ts

  } catch (error) {
    console.error('[daemon] Failed to start:', error);
    process.exit(1);
  }
}

main();
