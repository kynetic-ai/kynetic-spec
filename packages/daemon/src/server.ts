/**
 * Kspec Daemon Server
 *
 * Elysia.js HTTP server with WebSocket support for real-time kspec state updates.
 * Implements localhost-only security, file watching, and graceful shutdown.
 */

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { KspecWatcher } from './watcher';
import { join } from 'path';

export interface ServerOptions {
  port: number;
  isDaemon: boolean;
  kspecDir?: string; // Path to .kspec directory (default: .kspec in cwd)
}

// WebSocket connection tracking
const wsConnections = new Set<any>();

/**
 * Middleware to enforce localhost-only connections.
 * AC-3: Reject non-localhost connections with 403 Forbidden
 */
function localhostOnly() {
  return (context: { request: Request }) => {
    const host = context.request.headers.get('host');
    if (!host) {
      return new Response(JSON.stringify({
        error: 'Forbidden',
        message: 'This server only accepts connections from localhost'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Extract hostname, handling IPv6 brackets
    let hostname: string;
    if (host.startsWith('[')) {
      // IPv6 with brackets: [::1]:3456 -> ::1
      const closeBracket = host.indexOf(']');
      hostname = closeBracket > 0 ? host.substring(1, closeBracket) : host;
    } else {
      // IPv4 or hostname: localhost:3456 -> localhost
      hostname = host.split(':')[0];
    }

    // Allow localhost, 127.0.0.1, and ::1
    const isLocalhost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1';

    if (!isLocalhost) {
      return new Response(JSON.stringify({
        error: 'Forbidden',
        message: 'This server only accepts connections from localhost'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

/**
 * Creates and configures the Elysia server instance.
 *
 * AC Coverage:
 * - ac-1: Server starts on configurable port (default 3456)
 * - ac-2: Binds to localhost only (127.0.0.1 and ::1)
 * - ac-3: Rejects non-localhost connections with 403
 * - ac-15: Uses plugin pattern for middleware
 */
export async function createServer(options: ServerOptions) {
  const { port, isDaemon, kspecDir = join(process.cwd(), '.kspec') } = options;

  // AC-4: Initialize file watcher
  const watcher = new KspecWatcher({
    kspecDir,
    onFileChange: (file, content) => {
      // AC-4: Broadcast file change to all connected WebSocket clients
      const event = {
        type: 'file_change',
        file: file.replace(kspecDir + '/', ''),
        timestamp: new Date().toISOString()
      };

      for (const ws of wsConnections) {
        ws.send(JSON.stringify(event));
      }

      console.log(`[daemon] Broadcast file change: ${event.file}`);
    },
    onError: (error, file) => {
      // AC-6: Broadcast error event on YAML parse errors
      const event = {
        type: 'error',
        file: file ? file.replace(kspecDir + '/', '') : undefined,
        error: error.message,
        timestamp: new Date().toISOString()
      };

      for (const ws of wsConnections) {
        ws.send(JSON.stringify(event));
      }

      console.error('[daemon] Broadcast error:', error.message);
    }
  });

  const app = new Elysia()
    // AC-15: Plugin pattern for middleware
    .use(cors({
      origin: true, // Allow same-origin requests only (localhost)
      credentials: true
    }))

    // AC-3: Enforce localhost-only connections
    .onRequest(localhostOnly())

    // AC-11: Health check endpoint
    .get('/api/health', () => ({
      status: 'ok',
      uptime: process.uptime(),
      connections: wsConnections.size,
      version: '0.1.0'
    }))

    // AC-4: WebSocket endpoint for real-time updates
    .ws('/ws', {
      open(ws) {
        wsConnections.add(ws);
        console.log(`[daemon] WebSocket client connected (${wsConnections.size} total)`);

        // Send welcome message
        ws.send(JSON.stringify({
          type: 'connected',
          timestamp: new Date().toISOString(),
          version: '0.1.0'
        }));
      },
      message(ws, message) {
        console.log('[daemon] WebSocket message:', message);
        // TODO: AC-13-14 implement ping/pong and subscription protocol
      },
      close(ws) {
        wsConnections.delete(ws);
        console.log(`[daemon] WebSocket client disconnected (${wsConnections.size} remaining)`);
      }
    })

    // AC-1, AC-2: Start server on localhost only
    // Using 'localhost' hostname allows Bun/OS to bind to both 127.0.0.1 and ::1
    .listen({
      port,
      hostname: 'localhost', // Resolves to both IPv4 and IPv6 loopback
    });

  console.log(`[daemon] Server listening on http://localhost:${port} (IPv4: 127.0.0.1, IPv6: ::1)`);
  console.log(`[daemon] WebSocket available at ws://localhost:${port}/ws`);

  // AC-4: Start file watcher
  try {
    await watcher.start();
  } catch (error) {
    console.error('[daemon] Failed to start file watcher:', error);
  }

  // AC-12: Graceful shutdown on SIGTERM/SIGINT
  const shutdown = async (signal: string) => {
    console.log(`[daemon] Received ${signal}, shutting down gracefully...`);

    try {
      // Stop file watcher
      await watcher.stop();

      // Close all WebSocket connections
      for (const ws of wsConnections) {
        ws.close(1000, 'Server shutting down');
      }
      wsConnections.clear();

      // Stop the server
      await app.server?.stop();

      console.log('[daemon] Server stopped successfully');
      process.exit(0);
    } catch (error) {
      console.error('[daemon] Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // TODO: AC-9, AC-10: Implement daemon mode (process detach, PID file)
  // TODO: AC-13-14: Implement WebSocket ping/pong

  return app;
}
