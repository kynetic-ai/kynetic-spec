/**
 * Kspec Daemon Server
 *
 * Elysia.js HTTP server with WebSocket support for real-time kspec state updates.
 * Implements localhost-only security, file watching, and graceful shutdown.
 */

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { ulid } from 'ulidx';
import { existsSync } from 'fs';
import { KspecWatcher } from './watcher';
import { PubSubManager } from './websocket/pubsub';
import { HeartbeatManager } from './websocket/heartbeat';
import { WebSocketHandler } from './websocket/handler';
import type { ConnectionData, ConnectedEvent } from './websocket/types';
import { PidFileManager } from './pid';
import { createTasksRoutes } from './routes/tasks';
import { createItemsRoutes } from './routes/items';
import { createInboxRoutes } from './routes/inbox';
import { createMetaRoutes } from './routes/meta';
import { createValidationRoutes } from './routes/validation';
import { join, relative } from 'path';

export interface ServerOptions {
  port: number;
  isDaemon: boolean;
  kspecDir?: string; // Path to .kspec directory (default: .kspec in cwd)
  webUiDir?: string; // Path to web UI build directory (default: auto-detect)
}

/**
 * Resolves the path to the web UI build directory.
 * Tries multiple locations in order:
 * 1. Explicit webUiDir option
 * 2. WEB_UI_DIR environment variable
 * 3. packages/web-ui/build in current working directory (monorepo dev)
 * 4. web-ui/build in current working directory
 */
function resolveWebUiPath(webUiDir?: string): string | null {
  // 1. Explicit option
  if (webUiDir && existsSync(webUiDir)) {
    return webUiDir;
  }

  // 2. Environment variable
  const envPath = process.env.WEB_UI_DIR;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 3. Monorepo development: packages/web-ui/build from cwd
  // The daemon is spawned with cwd set to project root
  const monorepoPath = join(process.cwd(), 'packages', 'web-ui', 'build');
  if (existsSync(monorepoPath)) {
    return monorepoPath;
  }

  // 4. Alternate location: web-ui/build in cwd
  const altPath = join(process.cwd(), 'web-ui', 'build');
  if (existsSync(altPath)) {
    return altPath;
  }

  return null;
}

// WebSocket pub/sub and heartbeat managers
let pubsubManager: PubSubManager;
let heartbeatManager: HeartbeatManager;
let wsHandler: WebSocketHandler;

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
  const { port, isDaemon, kspecDir = join(process.cwd(), '.kspec'), webUiDir } = options;

  // AC: @daemon-server ac-17 - Resolve web UI path for static file serving
  const resolvedWebUiPath = resolveWebUiPath(webUiDir);
  if (resolvedWebUiPath) {
    console.log(`[daemon] Web UI assets found at: ${resolvedWebUiPath}`);
  } else {
    console.log('[daemon] Web UI assets not found - UI will not be served');
    console.log('[daemon] Build the web UI with: cd packages/web-ui && npm run build');
  }

  // Initialize PID file manager
  const pidManager = new PidFileManager(kspecDir);

  // AC: @daemon-server ac-9 - Write PID file in daemon mode
  if (isDaemon) {
    pidManager.write();
    console.log(`[daemon] PID file written: ${process.pid}`);
  }

  // Initialize WebSocket managers
  pubsubManager = new PubSubManager();
  heartbeatManager = new HeartbeatManager();
  wsHandler = new WebSocketHandler(pubsubManager);

  // AC-4: Initialize file watcher
  const watcher = new KspecWatcher({
    kspecDir,
    onFileChange: (file, content) => {
      // AC-4, ac-29: Broadcast file change to subscribed clients via topic
      const relativePath = relative(kspecDir, file);
      pubsubManager.broadcast('files:updates', 'file_changed', {
        ref: relativePath,
        action: 'modified'
      });

      console.log(`[daemon] Broadcast file change: ${relativePath}`);
    },
    onError: (error, file) => {
      // AC-6: Broadcast error event on YAML parse errors
      const relativePath = file ? relative(kspecDir, file) : undefined;
      pubsubManager.broadcast('files:errors', 'file_error', {
        ref: relativePath,
        error: error.message
      });

      console.error('[daemon] Broadcast error:', error.message);
    }
  });

  const app = new Elysia()
    // AC-15: Plugin pattern for middleware
    // AC: @api-contract ac-1 - Allow CORS from dev server on localhost:5173
    .use(cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], // Dev server origins
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
    }))

    // AC-3: Enforce localhost-only connections
    .onRequest(localhostOnly())

    // AC-11: Health check endpoint
    .get('/api/health', () => ({
      status: 'ok',
      uptime: process.uptime(),
      connections: pubsubManager.getConnectionCount(),
      version: '0.1.0'
    }))

    // AC: @api-contract ac-2 through ac-7 - Task API endpoints
    .use(createTasksRoutes({ kspecDir, pubsub: pubsubManager }))

    // AC: @api-contract ac-8 through ac-11 - Spec Item API endpoints
    .use(createItemsRoutes({ kspecDir }))

    // AC: @api-contract ac-12 through ac-14 - Inbox API endpoints
    .use(createInboxRoutes({ kspecDir, pubsub: pubsubManager }))

    // AC: @api-contract ac-15 through ac-18 - Meta API endpoints
    .use(createMetaRoutes({ kspecDir }))

    // AC: @api-contract ac-19 through ac-21 - Validation and search endpoints
    .use(createValidationRoutes({ kspecDir }))

    // AC-4: WebSocket endpoint for real-time updates
    .ws<ConnectionData>('/ws', {
      open(ws) {
        // AC: @api-contract ac-25, @trait-websocket-protocol ac-1
        const sessionId = ulid();
        ws.data = {
          sessionId,
          topics: new Set<string>(),
          seq: 0,
          lastPing: undefined,
          lastPong: Date.now()
        };

        pubsubManager.addConnection(sessionId, ws);
        console.log(`[daemon] WebSocket client connected: ${sessionId} (${pubsubManager.getConnectionCount()} total)`);

        // Send connected event with session_id
        const connectedEvent: ConnectedEvent = {
          event: 'connected',
          data: {
            session_id: sessionId
          }
        };
        ws.send(JSON.stringify(connectedEvent));
      },
      message(ws, message) {
        // AC: @api-contract ac-26, ac-27
        wsHandler.handleMessage(ws, message);
      },
      pong(ws) {
        // AC: @trait-websocket-protocol ac-5
        heartbeatManager.recordPong(ws);
      },
      close(ws, code, reason) {
        pubsubManager.removeConnection(ws.data.sessionId);
        console.log(`[daemon] WebSocket client disconnected: ${ws.data.sessionId} (code: ${code}, reason: ${reason})`);
      }
    });

  // AC: @daemon-server ac-17 - Serve web UI static assets
  // Added after API routes so API routes take precedence
  if (resolvedWebUiPath) {
    const indexHtmlPath = join(resolvedWebUiPath, 'index.html');

    // Serve static files from web UI build directory
    app.use(await staticPlugin({
      assets: resolvedWebUiPath,
      prefix: '/',
      noCache: process.env.NODE_ENV === 'development', // Disable cache in dev
    }));

    // SPA fallback routes for client-side routing
    // These catch paths like /tasks, /items, /inbox that don't have static files
    const spaRoutes = ['/tasks', '/tasks/*', '/items', '/items/*', '/inbox', '/observations'];
    for (const route of spaRoutes) {
      app.get(route, () => Bun.file(indexHtmlPath));
    }

    console.log('[daemon] Web UI static file serving enabled');
  }

  // AC-1, AC-2: Start server on localhost only
  // Using 'localhost' hostname allows Bun/OS to bind to both 127.0.0.1 and ::1
  app.listen({
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

  // AC: @daemon-server ac-13, ac-14 - Start heartbeat monitoring
  heartbeatManager.start(pubsubManager.getAllConnections());

  // AC-12: Graceful shutdown on SIGTERM/SIGINT
  const shutdown = async (signal: string) => {
    console.log(`[daemon] Received ${signal}, shutting down gracefully...`);

    try {
      // Stop heartbeat monitoring
      heartbeatManager.stop();

      // Stop file watcher
      await watcher.stop();

      // Close all WebSocket connections with code 1000 (clean close)
      // AC: @trait-websocket-protocol ac-7
      for (const [sessionId, ws] of pubsubManager.getAllConnections()) {
        ws.close(1000, 'Server shutting down');
      }

      // Stop the server
      await app.server?.stop();

      // AC: @daemon-server ac-10 - Remove PID file on shutdown
      if (isDaemon) {
        pidManager.remove();
        console.log('[daemon] PID file removed');
      }

      console.log('[daemon] Server stopped successfully');
      process.exit(0);
    } catch (error) {
      console.error('[daemon] Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return app;
}
