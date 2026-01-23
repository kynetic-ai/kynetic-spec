#!/usr/bin/env bun
/**
 * Kspec Daemon Entry Point
 *
 * Long-running server that exposes kspec state via HTTP API and WebSocket.
 * Supports foreground and background modes with PID file management.
 */

import { createServer } from './server.js';

// Parse command line args
const args = process.argv.slice(2);
const isDaemon = args.includes('--daemon');
const port = parseInt(args.find(arg => arg.startsWith('--port='))?.split('=')[1] || '3456', 10);

// Validate port
if (isNaN(port) || port < 1 || port > 65535) {
  console.error('[daemon] Invalid port number. Must be between 1 and 65535.');
  process.exit(1);
}

async function main() {
  try {
    console.log(`[daemon] Starting kspec daemon on port ${port}...`);

    const server = await createServer({ port, isDaemon });

    // Server will start listening in createServer
    // Graceful shutdown handled in server.ts

  } catch (error) {
    console.error('[daemon] Failed to start:', error);
    process.exit(1);
  }
}

main();
