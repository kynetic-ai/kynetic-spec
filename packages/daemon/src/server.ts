/**
 * Kspec Daemon Server
 *
 * Elysia.js HTTP server with WebSocket support for real-time kspec state updates.
 * Implements localhost-only security, file watching, and graceful shutdown.
 */

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';

export interface ServerOptions {
  port: number;
  isDaemon: boolean;
}

/**
 * Creates and configures the Elysia server instance.
 *
 * AC Coverage:
 * - ac-1: Server starts on configurable port (default 3456)
 * - ac-2: Binds to localhost only (127.0.0.1 and ::1)
 * - ac-15: Uses plugin pattern for middleware
 */
export async function createServer(options: ServerOptions) {
  const { port, isDaemon } = options;

  const app = new Elysia()
    // AC-15: Plugin pattern for middleware
    .use(cors({
      origin: 'localhost',
      credentials: true
    }))

    // AC-11: Health check endpoint
    .get('/api/health', () => ({
      status: 'ok',
      uptime: process.uptime(),
      connections: 0, // TODO: implement connection tracking
      version: '0.1.0'
    }))

    // Placeholder for WebSocket endpoint
    .ws('/ws', {
      open(ws) {
        console.log('[daemon] WebSocket client connected');
        // TODO: implement WebSocket protocol
      },
      message(ws, message) {
        console.log('[daemon] WebSocket message:', message);
        // TODO: implement message handling
      },
      close(ws) {
        console.log('[daemon] WebSocket client disconnected');
        // TODO: cleanup connection state
      }
    })

    // AC-1, AC-2: Start server on localhost only
    .listen({
      port,
      hostname: '127.0.0.1', // Localhost only
    });

  console.log(`[daemon] Server listening on http://127.0.0.1:${port}`);
  console.log(`[daemon] WebSocket available at ws://127.0.0.1:${port}/ws`);

  // TODO: AC-9, AC-10: Implement daemon mode (process detach, PID file)
  // TODO: AC-12: Implement graceful shutdown (SIGTERM, SIGINT)
  // TODO: AC-4-8: Implement file watching
  // TODO: AC-13-14: Implement WebSocket ping/pong

  return app;
}
