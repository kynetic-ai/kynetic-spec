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
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PubSubManager } from './websocket/pubsub';
import { HeartbeatManager } from './websocket/heartbeat';
import { WebSocketHandler } from './websocket/handler';
import { handleWebSocketClose } from './websocket/lifecycle';
import { resolveWebSocketProject } from './websocket/project-resolution';
import type { ConnectionData, ConnectedEvent } from './websocket/types';
import { PidFileManager } from './pid';
import { projectContextMiddleware } from './middleware/project-context';
import { createTasksRoutes } from './routes/tasks';
import { createItemsRoutes } from './routes/items';
import { createInboxRoutes } from './routes/inbox';
import { createMetaRoutes } from './routes/meta';
import { createValidationRoutes } from './routes/validation';
import { createProjectsRoutes } from './routes/projects';
import { createTriageRoutes } from './routes/triage';
import { createAgentDispatchRoutes, getDispatchEngine, stopAllEngines } from './routes/agent-dispatch';
import { createSessionRoutes } from './routes/sessions';
import { createPlansRoutes } from './routes/plans';
import { createAggregationRoutes } from './routes/aggregation';
import { createRefsRoutes } from './routes/refs';
import { createDiffRoutes } from './routes/diff';
import { createReviewsRoutes } from './routes/reviews';
import { ShadowSyncScheduler } from './shadow-sync';
import { SessionSyncScheduler } from './session-sync';
import { join } from 'path';

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
 * 3. Bundled dist/web-ui/ relative to this module (npm package installs)
 *
 * AC: @daemon-web-ui-bundle ac-4, ac-5
 * Exported for testing only.
 */
export function resolveWebUiPath(webUiDir?: string): string | null {
  // 1. Explicit option
  if (webUiDir && existsSync(webUiDir)) {
    return webUiDir;
  }

  // 2. Environment variable
  const envPath = process.env.WEB_UI_DIR;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 3. Bundled assets: dist/web-ui/ relative to daemon module location
  // Covers npm package installs where no local web UI build exists.
  // import.meta.url resolves to dist/daemon/server.js → sibling is dist/web-ui/
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const bundledPath = join(selfDir, '..', 'web-ui');
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return null;
}

// WebSocket pub/sub and heartbeat managers
let pubsubManager: PubSubManager;
let heartbeatManager: HeartbeatManager;
let wsHandler: WebSocketHandler;
let projectManager: import('./project-context').ProjectContextManager | undefined;
let shadowSyncScheduler: ShadowSyncScheduler | undefined;
const sessionSyncSchedulers: Map<string, SessionSyncScheduler> = new Map();

/**
 * Start a session sync scheduler for a project if it has session branch configured.
 * Safe to call multiple times — skips if scheduler already exists for that project.
 */
async function startSessionSyncForProject(
  projectPath: string,
  pubsub: PubSubManager,
): Promise<void> {
  if (sessionSyncSchedulers.has(projectPath)) {
    return;
  }

  const { loadProjectConfig } = await import('../parser/config.js');
  const { config } = await loadProjectConfig(projectPath);
  const specDir = join(projectPath, config.shadow.directory);

  // AC: @multi-directory-daemon ac-31, @manifest-discovery ac-6
  // Use discovery API instead of hardcoding kynetic.yaml
  const { findManifestInDir, readYamlFile } = await import('../parser/yaml.js');
  const manifestPath = await findManifestInDir(specDir);
  if (!manifestPath) {
    // No manifest found — gracefully skip session sync for this project
    return;
  }
  const manifest = await readYamlFile<{ sessions?: { storage?: string; branch?: string } }>(manifestPath);

  if (manifest?.sessions?.storage === 'branch') {
    const syncInterval = config.shadow.sync_interval;

    if (syncInterval > 0) {
      const { resolveSessionBranchConfig } = await import('../parser/session-branch.js');
      const sessionConfig = resolveSessionBranchConfig(projectPath, manifest);

      if (sessionConfig) {
        const scheduler = new SessionSyncScheduler({
          worktreeDir: sessionConfig.worktreeDir,
          intervalSeconds: syncInterval,
          branchName: sessionConfig.branchName,
          pubsub,
        });
        scheduler.start();
        sessionSyncSchedulers.set(projectPath, scheduler);
      }
    }
  }
}

/**
 * Stop session sync scheduler for a specific project.
 */
function stopSessionSyncForProject(projectPath: string): void {
  const scheduler = sessionSyncSchedulers.get(projectPath);
  if (scheduler) {
    scheduler.stop();
    sessionSyncSchedulers.delete(projectPath);
  }
}

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

  // Determine startup project path (project root, not .kspec/)
  // AC: @multi-directory-daemon ac-2 - daemon uses startup directory as default project
  const startupProjectPath = kspecDir.endsWith('.kspec')
    ? kspecDir.slice(0, -('.kspec'.length + 1)) // Remove '/.kspec'
    : kspecDir;

  // Import ProjectContextManager (needed for WebSocket binding)
  const { ProjectContextManager } = await import('./project-context');

  // AC: @daemon-server ac-17 - Resolve web UI path for static file serving
  const resolvedWebUiPath = resolveWebUiPath(webUiDir);
  if (resolvedWebUiPath) {
    console.log(`[daemon] Web UI assets found at: ${resolvedWebUiPath}`);
  } else {
    console.log('[daemon] Web UI assets not found - UI will not be served');
    console.log('[daemon] Build the web UI with: cd packages/web-ui && npm run build');
  }

  // Initialize PID file manager (uses global ~/.config/kspec/)
  const pidManager = new PidFileManager();

  // AC: @multi-directory-daemon ac-9 - Write PID and port files in daemon mode
  if (isDaemon) {
    pidManager.writePid();
    pidManager.writePort(port);
    console.log(`[daemon] PID file written: ${process.pid}`);
    console.log(`[daemon] Port file written: ${port}`);
  }

  // Initialize WebSocket managers
  pubsubManager = new PubSubManager();
  heartbeatManager = new HeartbeatManager();
  wsHandler = new WebSocketHandler(pubsubManager);

  // WeakMap to store project path during WebSocket upgrade (keyed by Request object)
  // Using WeakMap avoids needing to pass a requestId through beforeHandle return value,
  // which breaks WebSocket upgrade in Elysia 1.4 when derive middleware is present.
  const wsProjectPaths = new WeakMap<Request, string>();

  const app = new Elysia()
    // AC-15: Plugin pattern for middleware
    // AC: @api-contract ac-1 - Allow CORS from dev server on localhost:5173
    .use(cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173'], // Dev server origins
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
    }))

    // AC-3: Enforce localhost-only connections
    .onRequest(localhostOnly());

  // Shared callback for all registration paths (middleware, projects API, WebSocket)
  const onProjectRegistered = async (projectPath: string) => {
    await startSessionSyncForProject(projectPath, pubsubManager);
  };

  // AC: @multi-directory-daemon ac-1, ac-2, ac-3 - Project context middleware
  const { manager: projectContextManager, middleware: projectMiddleware } = projectContextMiddleware({
    startupProject: startupProjectPath,
    pubsub: pubsubManager,
    onProjectRegistered,
  });

  // Store manager globally for shutdown
  projectManager = projectContextManager;

  app.use(projectMiddleware)

    // AC-11: Health check endpoint
    .get('/api/health', () => ({
      status: 'ok',
      uptime: process.uptime(),
      connections: pubsubManager.getConnectionCount(),
      version: '0.1.0'
    }))

    // AC: @api-contract ac-2 through ac-7 - Task API endpoints
    // AC: @multi-directory-daemon ac-24 - Routes use projectContext from middleware
    .use(createTasksRoutes({ pubsub: pubsubManager }))

    // AC: @api-contract ac-8 through ac-11 - Spec Item API endpoints
    .use(createItemsRoutes())

    // AC: @api-contract ac-12 through ac-14 - Inbox API endpoints
    .use(createInboxRoutes({ pubsub: pubsubManager }))

    // AC: @api-contract ac-15 through ac-18 - Meta API endpoints
    .use(createMetaRoutes())

    // AC: @triage-daemon-api ac-1 through ac-9 - Triage API endpoints
    .use(createTriageRoutes({ pubsub: pubsubManager }))

    // AC: @api-contract ac-19 through ac-21 - Validation and search endpoints
    .use(createValidationRoutes())

    // AC: @multi-directory-daemon ac-28, ac-29, ac-30 - Projects management endpoints
    .use(createProjectsRoutes({
      projectManager: projectContextManager,
      onProjectRegistered,
      onProjectUnregistered: (projectPath) => {
        stopSessionSyncForProject(projectPath);
      },
    }))

    // AC: @ui-session-stream ac-1, ac-4 - Session data endpoints
    .use(createSessionRoutes())

    // AC: @ui-plans-view ac-1 - Plans data endpoints
    .use(createPlansRoutes())

    // AC: @ui-api-aggregation ac-1, ac-2, ac-3 - Aggregation endpoints
    .use(createAggregationRoutes())

    // AC: @ui-api-ref-resolution ac-4, ac-5 - Lightweight ref index endpoint
    .use(createRefsRoutes())

    // AC: @review-content-diff-api ac-1, ac-2, ac-3, ac-4 - Diff and review content endpoints
    .use(createDiffRoutes())

    // AC: @review-records-daemon-api ac-3, ac-4, ac-5, ac-9, ac-10 - Review thread mutation endpoints
    .use(createReviewsRoutes({ pubsub: pubsubManager }))

    // AC: @agent-dispatch-engine ac-4 - Agent dispatch API endpoints
    // AC: @daemon-agent-dispatch ac-3, ac-4 - Pass pubsub for WebSocket broadcast on invocation events
    .use(createAgentDispatchRoutes({ pubsub: pubsubManager }))

    // AC-4: WebSocket endpoint for real-time updates
    .ws<ConnectionData>('/ws', {
      beforeHandle({ request, store }) {
        // IMPORTANT: Do NOT return a value from ws beforeHandle.
        // In Elysia 1.4 with derive middleware, returning a value short-circuits
        // the WebSocket upgrade and sends the value as an HTTP 200 response.
        // Use a WeakMap keyed by Request object to pass data to open().
        try {
          const manager = (store as Record<string, unknown>).projectManager as import('./project-context').ProjectContextManager | undefined;
          if (!manager) {
            // Fallback: project manager not initialized yet
            wsProjectPaths.set(request, startupProjectPath);
            return;
          }

          const { resolvedPath } = resolveWebSocketProject({
            request,
            manager,
            fallbackPath: startupProjectPath,
            onProjectRegistered,
          });

          // Store resolved path for open() handler via WeakMap
          wsProjectPaths.set(request, resolvedPath);
        } catch (err: unknown) {
          console.error(`[daemon] WebSocket connection rejected: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
      open(ws) {
        // AC: @api-contract ac-25, @trait-websocket-protocol ac-1
        const sessionId = ulid();
        const openContext = ws.data as { id?: unknown; request?: unknown } | undefined;
        const contextId = typeof openContext?.id === 'string' ? openContext.id : undefined;

        // AC: @multi-directory-daemon ac-21 - Get bound project path
        // Retrieve project path from WeakMap via the request object on ws.data
        const request = openContext?.request as Request | undefined;
        const projectPath = request ? wsProjectPaths.get(request) || startupProjectPath : startupProjectPath;

        ws.data = {
          sessionId,
          topics: new Set<string>(),
          seq: 0,
          lastPing: undefined,
          lastPong: Date.now(),
          projectPath // AC: @multi-directory-daemon ac-21 - immutable binding
        };

        pubsubManager.addConnection(sessionId, ws, contextId);
        console.log(`[daemon] WebSocket client connected: ${sessionId} bound to ${projectPath} (${pubsubManager.getConnectionCount()} total)`);

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
        handleWebSocketClose(pubsubManager, ws, code, reason);
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
    const spaRoutes = [
      '/',
      '/tasks', '/tasks/*',
      '/items', '/items/*',
      '/inbox',
      '/observations',
      '/triage',
      '/validate',
      '/sessions', '/sessions/*',
      '/agents',
      '/specs',
      '/workflows',
      '/plans',
      '/settings',
    ];
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

  // AC: @agent-dispatch-engine ac-5 - Wire file change callback to dispatch engine
  projectContextManager.setFileChangeCallback((projectPath, file) => {
    // Only forward changes to project.tasks.yaml
    if (!file.endsWith('project.tasks.yaml')) return;
    const engine = getDispatchEngine(projectPath);
    if (engine) {
      engine.handleFileChange(projectPath).catch((err) => {
        console.error('[dispatch] Error handling file change:', err);
      });
    }
  });

  // AC: @multi-directory-daemon ac-17 - Start file watcher for startup project
  if (startupProjectPath) {
    try {
      await projectContextManager.startWatcher(startupProjectPath);
      console.log(`[daemon] File watcher started for startup project: ${startupProjectPath}`);
    } catch (error) {
      console.error('[daemon] Failed to start file watcher for startup project:', error);
    }
  }

  // AC: @config-shadow ac-12 - Start periodic shadow sync if remote tracking configured
  if (startupProjectPath) {
    try {
      const { loadProjectConfig } = await import('../parser/config.js');
      const { config } = await loadProjectConfig(startupProjectPath);
      const syncInterval = config.shadow.sync_interval;
      const worktreeDir = join(startupProjectPath, config.shadow.directory);

      if (syncInterval > 0) {
        shadowSyncScheduler = new ShadowSyncScheduler({
          worktreeDir,
          intervalSeconds: syncInterval,
          shadowOptions: {
            branchName: config.shadow.branch,
            directory: config.shadow.directory,
            remote: config.shadow.remote?.value,
            remoteType: config.shadow.remote?.type,
          },
          pubsub: pubsubManager,
        });
        shadowSyncScheduler.start();
      }
    } catch (error) {
      console.error('[daemon] Failed to initialize shadow sync scheduler:', error);
    }
  }

  // AC: @session-branch-worktree ac-sync - Start periodic session branch sync if configured
  // Session sync runs independently from kspec-meta sync — failures in one do not affect the other
  if (startupProjectPath) {
    try {
      await startSessionSyncForProject(startupProjectPath, pubsubManager);
    } catch (error) {
      // Session sync init failure does not block daemon startup
      console.error('[daemon] Failed to initialize session sync scheduler:', error);
    }
  }

  // AC: @daemon-server ac-13, ac-14 - Start heartbeat monitoring
  heartbeatManager.start(pubsubManager.getAllConnections());

  // AC-12: Graceful shutdown on SIGTERM/SIGINT
  const shutdown = async (signal: string) => {
    console.log(`[daemon] Received ${signal}, shutting down gracefully...`);

    try {
      // Stop heartbeat monitoring
      heartbeatManager.stop();

      // AC: @config-shadow ac-12 - Stop shadow sync scheduler
      shadowSyncScheduler?.stop();

      // AC: @session-branch-worktree ac-sync - Stop all session sync schedulers
      for (const scheduler of sessionSyncSchedulers.values()) {
        scheduler.stop();
      }
      sessionSyncSchedulers.clear();

      // AC: @agent-dispatch-engine ac-11 - Stop all dispatch engines before shutting down
      await stopAllEngines();

      // AC: @multi-directory-daemon ac-11b - Stop all file watchers
      await projectContextManager.stopAllWatchers();
      console.log('[daemon] All file watchers stopped');

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
