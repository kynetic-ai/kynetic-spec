/**
 * Kspec Daemon Server
 *
 * Elysia.js HTTP server with WebSocket support for real-time kspec state updates.
 * Implements localhost-only security, file watching, and graceful shutdown.
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import { ulid } from "ulidx";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PubSubManager } from "./websocket/pubsub.js";
import { HeartbeatManager } from "./websocket/heartbeat.js";
import { WebSocketHandler } from "./websocket/handler.js";
import { handleWebSocketClose } from "./websocket/lifecycle.js";
import { ConnectionStateManager } from "./websocket/connection-state.js";
import { getWebSocketContextId } from "./websocket/context-id.js";
import { resolveWebSocketProject } from "./websocket/project-resolution.js";
import type { ConnectionData, ConnectedEvent } from "./websocket/types.js";
import { PidFileManager } from "./pid.js";
import {
  DEFAULT_BIND_HOST,
  isIpv6Literal,
  resolveDaemonEndpoint,
  selectStartupBindHost,
  type DaemonConnectionMetadata,
} from "./endpoint.js";
import { projectContextMiddleware } from "./middleware/project-context.js";
import { createTasksRoutes } from "./routes/tasks.js";
import { createItemsRoutes } from "./routes/items.js";
import { createInboxRoutes } from "./routes/inbox.js";
import { createMetaRoutes } from "./routes/meta.js";
import { createValidationRoutes } from "./routes/validation.js";
import { createProjectsRoutes } from "./routes/projects.js";
import { createTriageRoutes } from "./routes/triage.js";
import {
  createAgentDispatchRoutes,
  getDispatchEngine,
  stopAllEngines,
} from "./routes/agent-dispatch.js";
import { createCommandRoutes } from "./routes/command.js";
import { createAutomationRoutes } from "./routes/automation.js";
import { createDebugRoutes } from "./routes/debug.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createPlansRoutes } from "./routes/plans.js";
import { createAggregationRoutes } from "./routes/aggregation.js";
import { createRefsRoutes } from "./routes/refs.js";
import { createDiffRoutes } from "./routes/diff.js";
import { createReviewsRoutes } from "./routes/reviews.js";
import { SessionSyncScheduler } from "./session-sync.js";
import { WatcherHealthMonitor } from "./watcher-health-monitor.js";
import {
  startShadowSyncForProject,
  stopShadowSyncForProject,
  stopAllShadowSync,
  createShadowSyncOnPullHandler,
} from "./shadow-sync-manager.js";
import { registerWebUiEntryRoutes } from "./web-ui-entry.js";
import { registerWebUiNodeStaticRoutes } from "./web-ui-static.js";

export type DaemonRuntime = "bun" | "node";

export interface ServerOptions {
  port: number;
  isDaemon: boolean;
  runtime: DaemonRuntime;
  kspecDir?: string; // Path to .kspec directory (default: .kspec in cwd)
  webUiDir?: string; // Path to web UI build directory (default: auto-detect)
  /**
   * Host the daemon binds to. Defaults to 127.0.0.1 (numeric IPv4
   * loopback) so startup does not depend on OS hostname resolution.
   *
   * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
   * AC: @daemon-network-endpoint-contract ac-configured-bind-host
   */
  bindHost?: string;
  /**
   * True when `bindHost` came from an explicit env/config value rather
   * than the built-in default. Disables IPv6 fallback when set —
   * explicit configuration is honored verbatim.
   *
   * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
   */
  bindHostExplicitlyConfigured?: boolean;
  /**
   * Host the daemon advertises to local clients. When omitted, derived
   * from `bindHost` (loopback when bind is wildcard).
   *
   * AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
   * AC: @config-daemon ac-connect-host-config
   */
  connectHost?: string | null;
  /**
   * Override directory for daemon lifecycle files (PID, port, metadata).
   * Tests use this to avoid writing to the real ~/.config/kspec.
   */
  configDir?: string;
}

type ManagedServer = {
  stop?: () => unknown;
  close?: (callback: (error?: Error | null) => void) => void;
};

export async function createServerApp(runtime: DaemonRuntime): Promise<Elysia> {
  if (runtime === "node") {
    const { node } = await import("@elysiajs/node");
    return new Elysia({ adapter: node() });
  }

  return new Elysia();
}

export async function stopManagedServer(server: ManagedServer | undefined): Promise<void> {
  if (!server) {
    return;
  }

  if (typeof server.stop === "function") {
    await server.stop();
    return;
  }

  if (typeof server.close === "function") {
    await new Promise<void>((resolve, reject) => {
      server.close?.((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

// AC: @daemon-runtime-adapter ac-heartbeat-degradation
export function shouldEnableHeartbeat(runtime: DaemonRuntime): boolean {
  return runtime !== "node";
}

export function logHeartbeatDegradationWarning(runtime: DaemonRuntime): void {
  if (runtime !== "node") {
    return;
  }

  console.warn(
    "[daemon] Running on node: WebSocket heartbeat ping/pong is unavailable. Dead connection detection is disabled.",
  );
}

function hasWebUiIndex(dir: string | undefined): dir is string {
  return Boolean(dir && existsSync(join(dir, "index.html")));
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
  if (hasWebUiIndex(webUiDir)) {
    return webUiDir;
  }

  // 2. Environment variable
  const envPath = process.env.WEB_UI_DIR;
  if (hasWebUiIndex(envPath)) {
    return envPath;
  }

  // 3. Bundled assets: dist/web-ui/ relative to daemon module location
  // Covers npm package installs where no local web UI build exists.
  // import.meta.url resolves to dist/daemon/server.js → sibling is dist/web-ui/
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const bundledPath = join(selfDir, "..", "web-ui");
  if (hasWebUiIndex(bundledPath)) {
    return bundledPath;
  }

  return null;
}

// WebSocket pub/sub and heartbeat managers
let pubsubManager: PubSubManager;
let heartbeatManager: HeartbeatManager;
let wsHandler: WebSocketHandler;
let _projectManager: import("./project-context.js").ProjectContextManager | undefined;
let watcherHealthMonitor: WatcherHealthMonitor | undefined;
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

  const { loadProjectConfig } = await import("../parser/config.js");
  const { config } = await loadProjectConfig(projectPath);
  const specDir = join(projectPath, config.shadow.directory);

  // AC: @multi-directory-daemon ac-31, @manifest-discovery ac-6
  // Use discovery API instead of hardcoding kynetic.yaml
  const { findManifestInDir, readYamlFile } = await import("../parser/yaml.js");
  const manifestPath = await findManifestInDir(specDir);
  if (!manifestPath) {
    // No manifest found — gracefully skip session sync for this project
    return;
  }
  const manifest = await readYamlFile<{ sessions?: { storage?: string; branch?: string } }>(
    manifestPath,
  );

  if (manifest?.sessions?.storage === "branch") {
    const syncInterval = config.shadow.sync_interval;

    if (syncInterval > 0) {
      const { resolveSessionBranchConfig } = await import("../parser/session-branch.js");
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
export function localhostOnly() {
  return (context: { request: Request }) => {
    const host = context.request.headers.get("host");
    if (!host) {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "This server only accepts connections from localhost",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Extract hostname, handling IPv6 brackets
    let hostname: string;
    if (host.startsWith("[")) {
      // IPv6 with brackets: [::1]:3456 -> ::1
      const closeBracket = host.indexOf("]");
      hostname = closeBracket > 0 ? host.substring(1, closeBracket) : host;
    } else {
      // IPv4 or hostname: localhost:3456 -> localhost
      hostname = host.split(":")[0];
    }

    // Allow localhost, 127.0.0.1, and ::1
    const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

    if (!isLocalhost) {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "This server only accepts connections from localhost",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
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
  const {
    port,
    isDaemon,
    runtime,
    kspecDir = join(process.cwd(), ".kspec"),
    webUiDir,
    bindHost,
    bindHostExplicitlyConfigured,
    connectHost,
    configDir,
  } = options;

  // Determine startup project path (project root, not .kspec/)
  // AC: @multi-directory-daemon ac-2 - daemon uses startup directory as default project
  const startupProjectPath = kspecDir.endsWith(".kspec")
    ? kspecDir.slice(0, -(".kspec".length + 1)) // Remove '/.kspec'
    : kspecDir;

  // Import ProjectContextManager (needed for WebSocket binding)
  const { ProjectContextManager: _ProjectContextManager } = await import("./project-context.js");

  // AC: @daemon-server ac-17 - Resolve web UI path for static file serving
  const resolvedWebUiPath = resolveWebUiPath(webUiDir);
  if (resolvedWebUiPath) {
    console.log(`[daemon] Web UI assets found at: ${resolvedWebUiPath}`);
  } else {
    console.log("[daemon] Web UI assets not found - UI will not be served");
    console.log("[daemon] Build the web UI with: cd packages/web-ui && npm run build");
  }

  // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
  // AC: @daemon-network-endpoint-contract ac-configured-bind-host
  // AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // AC: @config-daemon ac-host-default
  // Resolve the bind host once via the shared module. When the user
  // didn't explicitly configure a host AND the default IPv4 loopback
  // can't be bound (e.g. IPv4 disabled on the system), fall back to ::1
  // so daemon startup still succeeds and metadata advertises bracketed
  // IPv6 URLs. The explicit-config flag is forwarded by the CLI from
  // the parsed config (env / kspec.config.yaml) so explicit settings
  // are never silently rewritten.
  const requestedBindHost = bindHost ?? DEFAULT_BIND_HOST;
  const bindSelection = await selectStartupBindHost({
    resolvedBindHost: requestedBindHost,
    port,
    hostExplicitlyConfigured: bindHostExplicitlyConfigured === true,
  });
  if (bindSelection.fellBackToIpv6) {
    console.warn(
      `[daemon] IPv4 loopback (${DEFAULT_BIND_HOST}) is unavailable for binding; falling back to IPv6 loopback (::1).`,
    );
  }
  const endpoint = resolveDaemonEndpoint({
    port,
    bindHost: bindSelection.bindHost,
    connectHost: connectHost ?? null,
  });

  // Initialize PID file manager. configDir override lets tests redirect
  // metadata writes away from the real ~/.config/kspec.
  const pidManager = configDir ? new PidFileManager(configDir) : new PidFileManager();

  // AC: @multi-directory-daemon ac-9 - Write PID and port files in daemon mode
  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  if (isDaemon) {
    pidManager.writePid();
    pidManager.writePort(port);
    const metadata: DaemonConnectionMetadata = {
      pid: process.pid,
      port: endpoint.port,
      bind_host: endpoint.bindHost,
      connect_host: endpoint.connectHost,
      api_url: endpoint.apiUrl,
      ws_url: endpoint.wsUrl,
      runtime,
    };
    pidManager.writeConnectionMetadata(metadata);
    console.log(`[daemon] PID file written: ${process.pid}`);
    console.log(`[daemon] Port file written: ${port}`);
    console.log(`[daemon] Connection metadata written: ${endpoint.apiUrl}`);
  }

  // Initialize WebSocket managers
  const connectionState = new ConnectionStateManager();
  pubsubManager = new PubSubManager(connectionState);
  heartbeatManager = new HeartbeatManager(connectionState);
  wsHandler = new WebSocketHandler(pubsubManager);

  // WeakMap to store project path during WebSocket upgrade (keyed by Request object)
  // Using WeakMap avoids needing to pass a requestId through beforeHandle return value,
  // which breaks WebSocket upgrade in Elysia 1.4 when derive middleware is present.
  const wsProjectPaths = new WeakMap<Request, string>();

  const app = await createServerApp(runtime);

  app
    // AC-15: Plugin pattern for middleware
    // AC: @api-contract ac-1 - Allow CORS from dev server on localhost:5173
    .use(
      cors({
        origin: ["http://localhost:5173", "http://127.0.0.1:5173"], // Dev server origins
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      }),
    )

    // AC-3: Enforce localhost-only connections
    .onRequest(localhostOnly());

  // AC: @daemon-entity-cache ac-load-on-register — lazy import entity cache module
  // The daemon build compiles packages/daemon/src plus src/daemon/entity-cache.ts
  // into dist/daemon/, where entity-cache.js is a sibling module.
  const entityCacheModule = await import("./entity-cache.js");

  // Shared callback for all registration paths (middleware, projects API, WebSocket)
  // AC: @config-shadow ac-14 — shadow sync starts for projects registered after startup
  const onProjectRegistered = async (projectPath: string) => {
    await startSessionSyncForProject(projectPath, pubsubManager);
    await startShadowSyncForProject(projectPath, pubsubManager, entityCacheModule.getEntityCache);
    // AC: @daemon-entity-cache ac-load-on-register — create cache and start progressive loading
    // AC: @daemon-entity-cache ac-domain-ready-event — wire domain-ready transitions to WebSocket broadcast
    const entityCache = entityCacheModule.registerEntityCache(
      projectPath,
      undefined,
      (domain, cachePath, previousState) => {
        pubsubManager.broadcast(
          "cache:status",
          "domain_ready",
          { domain, projectPath: cachePath, previousState, timestamp: new Date().toISOString() },
          cachePath,
        );
      },
      (domain, cachePath) => {
        if (domain !== "sessions") {
          return;
        }
        pubsubManager.broadcast(
          "sessions",
          "session_changed",
          {
            domain,
            projectPath: cachePath,
            action: "modified",
            timestamp: new Date().toISOString(),
          },
          cachePath,
        );
      },
    );
    entityCache.loadAll().catch((err: unknown) => {
      console.error(`[entity-cache] Error during initial load for ${projectPath}:`, err);
    });
  };

  // AC: @multi-directory-daemon ac-1, ac-2, ac-3 - Project context middleware
  const { manager: projectContextManager, middleware: projectMiddleware } =
    projectContextMiddleware({
      startupProject: startupProjectPath,
      pubsub: pubsubManager,
      onProjectRegistered,
    });

  // Store manager globally for shutdown
  _projectManager = projectContextManager;

  app
    .use(projectMiddleware)

    // AC-11: Health check endpoint
    .get("/api/health", () => ({
      status: "ok",
      uptime: process.uptime(),
      connections: pubsubManager.getConnectionCount(),
      version: "0.1.0",
      runtime,
    }))

    // AC: @api-contract ac-2 through ac-7 - Task API endpoints
    // AC: @multi-directory-daemon ac-24 - Routes use projectContext from middleware
    // AC: @daemon-entity-cache ac-serve-from-memory, ac-write-through — pass cache accessor
    .use(
      createTasksRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    )

    // AC: @api-contract ac-8 through ac-11 - Spec Item API endpoints
    // AC: @daemon-entity-cache ac-serve-from-memory — pass cache accessor
    .use(createItemsRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

    // AC: @api-contract ac-12 through ac-14 - Inbox API endpoints
    // AC: @daemon-entity-cache ac-serve-from-memory, ac-write-through — pass cache accessor
    .use(
      createInboxRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    )

    // AC: @api-contract ac-15 through ac-18 - Meta API endpoints
    // AC: @daemon-entity-cache ac-write-through — pass cache accessor for meta write-through
    .use(createMetaRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

    // AC: @triage-daemon-api ac-1 through ac-9 - Triage API endpoints
    // AC: @daemon-entity-cache ac-serve-from-memory, ac-write-through — pass cache accessor
    .use(
      createTriageRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    )

    // AC: @api-contract ac-19 through ac-21 - Validation and search endpoints
    // AC: @daemon-read-path ac-no-per-request-sync, ac-index-from-cache — pass cache accessor
    .use(createValidationRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

    // AC: @multi-directory-daemon ac-28, ac-29, ac-30 - Projects management endpoints
    .use(
      createProjectsRoutes({
        projectManager: projectContextManager,
        onProjectRegistered,
        // Cleanup now handled centrally by ProjectContextManager.unregisterCallback
        // (wired below) so all unregister paths (API + watcher permanent failure) are covered.
      }),
    )

    // AC: @ui-session-stream ac-1, ac-4 - Session data endpoints
    // AC: @daemon-entity-cache ac-serve-from-memory — pass cache accessor for session routes
    .use(createSessionRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

    // AC: @ui-plans-view ac-1 - Plans data endpoints
    // AC: @daemon-entity-cache ac-serve-from-memory — pass cache accessor
    .use(createPlansRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

    // AC: @ui-api-aggregation ac-1, ac-2, ac-3 - Aggregation endpoints
    // AC: @daemon-read-path ac-no-per-request-sync, ac-index-from-cache — pass cache accessor
    .use(createAggregationRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

    // AC: @ui-api-ref-resolution ac-4, ac-5 - Lightweight ref index endpoint
    // AC: @daemon-entity-cache ac-serve-from-memory — pass cache accessor
    .use(createRefsRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

    // AC: @review-content-diff-api ac-1, ac-2, ac-3, ac-4 - Diff and review content endpoints
    .use(createDiffRoutes())

    // AC: @review-records-daemon-api ac-3, ac-4, ac-5, ac-6, ac-7, ac-8, ac-9, ac-10 - Review endpoints
    // AC: @daemon-entity-cache ac-serve-from-memory, ac-write-through — pass cache accessor
    .use(
      createReviewsRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    )

    // AC: @agent-dispatch-engine ac-4 - Agent dispatch API endpoints
    // AC: @daemon-agent-dispatch ac-3, ac-4 - Pass pubsub for WebSocket broadcast on invocation events
    .use(createAgentDispatchRoutes({ pubsub: pubsubManager }))

    // AC: @daemon-command-api ac-command-endpoint, ac-batch-support - Command execution API
    .use(
      createCommandRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    )

    // AC: @automation-api ac-1 through ac-6 - Automation management endpoints
    .use(createAutomationRoutes())

    // AC: @daemon-server ac-18 - Debug/diagnostic endpoints
    .use(
      createDebugRoutes({
        projectManager: projectContextManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    );

  // Test-only routes: cache delay injection for E2E tests (KSPEC_TEST guard)
  if (process.env.KSPEC_TEST) {
    const { createTestHookRoutes } = await import("./routes/test-hooks.js");
    app.use(createTestHookRoutes({ getEntityCache: entityCacheModule.getEntityCache }));
  }

  app
    // AC-4: WebSocket endpoint for real-time updates
    .ws<ConnectionData>("/ws", {
      async beforeHandle({ request, store }) {
        // IMPORTANT: Do NOT return a value from ws beforeHandle.
        // In Elysia 1.4 with derive middleware, returning a value short-circuits
        // the WebSocket upgrade and sends the value as an HTTP 200 response.
        // Use a WeakMap keyed by Request object to pass data to open().
        try {
          const manager = (store as Record<string, unknown>).projectManager as
            | import("./project-context.js").ProjectContextManager
            | undefined;
          if (!manager) {
            // Fallback: project manager not initialized yet
            wsProjectPaths.set(request, startupProjectPath);
            return;
          }

          // AC: @multi-directory-daemon ac-35 - Await watcher startup before serving cached data
          const { resolvedPath } = await resolveWebSocketProject({
            request,
            manager,
            fallbackPath: startupProjectPath,
            onProjectRegistered,
          });

          // Store resolved path for open() handler via WeakMap
          wsProjectPaths.set(request, resolvedPath);
        } catch (err: unknown) {
          console.error(
            `[daemon] WebSocket connection rejected: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      },
      open(ws) {
        // AC: @api-contract ac-25, @trait-websocket-protocol ac-1
        const sessionId = ulid();
        const openContext = ws.data as { request?: unknown } | undefined;
        const contextId = getWebSocketContextId(ws);

        // AC: @multi-directory-daemon ac-21 - Get bound project path
        // Retrieve project path from WeakMap via the request object on ws.data
        const request = openContext?.request as Request | undefined;
        const projectPath = request
          ? wsProjectPaths.get(request) || startupProjectPath
          : startupProjectPath;

        connectionState.init(ws, {
          sessionId,
          topics: new Set<string>(),
          seq: 0,
          lastPing: undefined,
          lastPong: Date.now(),
          projectPath, // AC: @multi-directory-daemon ac-21 - immutable binding
        });

        pubsubManager.addConnection(sessionId, ws, contextId);
        console.log(
          `[daemon] WebSocket client connected: ${sessionId} bound to ${projectPath} (${pubsubManager.getConnectionCount()} total)`,
        );

        // Send connected event with session_id
        const connectedEvent: ConnectedEvent = {
          event: "connected",
          data: {
            session_id: sessionId,
          },
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
      },
    });

  // AC: @daemon-server ac-17 - Serve web UI static assets
  // Added after API routes so API routes take precedence
  if (resolvedWebUiPath) {
    // SPA fallback routes for client-side routing.
    // Registered BEFORE the static plugin so the entry helper owns the root
    // and application routes — the Bun static plugin pre-registers '/' from
    // index.html, which would otherwise serve a stale, browser-cacheable
    // bundle after a web UI rebuild.
    // AC: @daemon-server ac-root-route-current-entry, ac-app-route-current-entry
    // AC: @daemon-web-ui-bundle ac-entry-unavailable-during-replacement,
    // ac-entry-recovers-after-replacement, ac-reload-uses-current-entry
    registerWebUiEntryRoutes(app, resolvedWebUiPath);

    if (runtime === "node") {
      registerWebUiNodeStaticRoutes(app, resolvedWebUiPath);
    } else {
      // Bun's static plugin serves bundle assets with correct MIME metadata.
      // indexHTML: false stops the plugin from claiming '/' (and other
      // directory paths) for index.html — the entry helper owns those routes
      // so bundle changes are reflected on the next request.
      app.use(
        await staticPlugin({
          assets: resolvedWebUiPath,
          prefix: "/",
          indexHTML: false,
          noCache: process.env.NODE_ENV === "development", // Disable cache in dev
        }),
      );
    }

    console.log("[daemon] Web UI static file serving enabled");
  }

  // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
  // AC: @daemon-network-endpoint-contract ac-configured-bind-host
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // AC: @daemon-server ac-1, ac-2
  // Bind to the resolved bind host (numeric IPv4 loopback by default —
  // never 'localhost', so binding does not depend on /etc/hosts or DNS).
  // The bind host has already been adjusted via selectStartupBindHost to
  // prefer ::1 when IPv4 loopback is unavailable on this host.
  //
  // The IPv6 path needs a localized URL polyfill: @elysiajs/node
  // constructs `new URL("http://::1:port")` synchronously inside its
  // listen() implementation, which throws because IPv6 hosts must be
  // bracketed inside URL strings. We patch globalThis.URL to bracket
  // bare IPv6 host segments only for the duration of the listen call,
  // then restore the original. The underlying http.Server bind itself
  // accepts the bare ::1 hostname (and rejects the bracketed form), so
  // we cannot change what we pass to Elysia — only what Elysia builds
  // internally. Bug context: https://github.com/elysiajs/elysia/issues
  if (isIpv6Literal(endpoint.bindHost)) {
    const OriginalURL = globalThis.URL;
    function PatchedURL(input: ConstructorParameters<typeof URL>[0], base?: ConstructorParameters<typeof URL>[1]): URL {
      const fixed =
        typeof input === "string"
          ? input.replace(
              /^(https?:\/\/)([0-9a-fA-F]*:[0-9a-fA-F:]+)(:\d+)/,
              "$1[$2]$3",
            )
          : input;
      return new OriginalURL(fixed, base);
    }
    PatchedURL.prototype = OriginalURL.prototype;
    (globalThis as { URL: typeof URL }).URL = PatchedURL as unknown as typeof URL;
    try {
      app.listen({ port, hostname: endpoint.bindHost });
    } finally {
      (globalThis as { URL: typeof URL }).URL = OriginalURL;
    }
  } else {
    app.listen({ port, hostname: endpoint.bindHost });
  }

  console.log(`[daemon] Server listening on ${endpoint.apiUrl} (bind: ${endpoint.bindHost})`);
  console.log(`[daemon] WebSocket available at ${endpoint.wsUrl}`);
  // AC: @daemon-network-endpoint-contract ac-external-binding-warning
  if (endpoint.externallyReachable) {
    console.warn(
      `[daemon] WARNING: bind host ${endpoint.bindHost} exposes unauthenticated kspec project data and mutation APIs on a non-loopback interface. Restrict access at the network/firewall level.`,
    );
  }
  logHeartbeatDegradationWarning(runtime);

  // AC: @agent-dispatch-engine ac-5 - Wire file change callback to dispatch engine
  projectContextManager.setFileChangeCallback((projectPath, file) => {
    // Only forward changes to project.tasks.yaml
    if (!file.endsWith("project.tasks.yaml")) return;
    const engine = getDispatchEngine(projectPath);
    if (engine) {
      engine.handleFileChange(projectPath).catch((err) => {
        console.error("[dispatch] Error handling file change:", err);
      });
    }
  });

  // AC: @daemon-entity-cache ac-watcher-invalidation — wire cache invalidation to file watcher
  // Both .kspec/ and .kspec-sessions/ changes flow through handleFileChange;
  // fileToDomain() maps YAML files to their domains and ULID-prefixed session
  // paths to the sessions domain.
  projectContextManager.setCacheInvalidationCallback((projectPath, kspecDir, file, content) => {
    const cache = entityCacheModule.getEntityCache(projectPath);
    if (!cache) return;

    cache.handleFileChange(kspecDir, file, content).catch((err: unknown) => {
      console.error(`[entity-cache] Error handling file change for ${projectPath}:`, err);
    });
  });

  // AC: @daemon-entity-cache ac-unregister-cleanup — dispose cache on any unregister path
  // (including watcher permanent failure, not just API-driven unregister)
  // AC: @config-shadow ac-15 — stop shadow sync when project is removed
  projectContextManager.setUnregisterCallback((projectPath) => {
    stopSessionSyncForProject(projectPath);
    stopShadowSyncForProject(projectPath);
    entityCacheModule.unregisterEntityCache(projectPath);
  });

  // AC: @daemon-entity-cache ac-load-on-register — create cache for the startup project.
  // The startup project is registered directly by projectContextMiddleware (not via
  // getOrRegisterProject), so the onProjectRegistered callback isn't fired for it.
  // Explicitly trigger it here after all callbacks are wired so the startup project
  // gets an entity cache instance and progressive loading starts immediately.
  if (startupProjectPath) {
    try {
      await onProjectRegistered(startupProjectPath);
    } catch (error) {
      console.error("[daemon] Failed to initialize entity cache for startup project:", error);
    }
  }

  // AC: @multi-directory-daemon ac-17 - Start file watcher for startup project
  if (startupProjectPath) {
    try {
      await projectContextManager.startWatcher(startupProjectPath);
      console.log(`[daemon] File watcher started for startup project: ${startupProjectPath}`);
    } catch (error) {
      console.error("[daemon] Failed to start file watcher for startup project:", error);
    }
  }

  watcherHealthMonitor = new WatcherHealthMonitor(projectContextManager, {
    intervalMs: parseInt(process.env.KSPEC_WATCHER_HEALTH_INTERVAL_MS ?? "60000", 10) || 60000,
  });
  watcherHealthMonitor.start();

  // AC: @config-shadow ac-12, ac-13 - Start periodic shadow sync if remote tracking configured
  // Shadow sync now uses the same per-project helper as onProjectRegistered
  if (startupProjectPath) {
    try {
      await startShadowSyncForProject(
        startupProjectPath,
        pubsubManager,
        entityCacheModule.getEntityCache,
      );
    } catch (error) {
      console.error("[daemon] Failed to initialize shadow sync scheduler:", error);
    }
  }

  // AC: @session-branch-worktree ac-sync - Start periodic session branch sync if configured
  // Session sync runs independently from kspec-meta sync — failures in one do not affect the other
  if (startupProjectPath) {
    try {
      await startSessionSyncForProject(startupProjectPath, pubsubManager);
    } catch (error) {
      // Session sync init failure does not block daemon startup
      console.error("[daemon] Failed to initialize session sync scheduler:", error);
    }
  }

  // AC: @daemon-server ac-13, ac-14 - Start heartbeat monitoring
  // AC: @daemon-runtime-adapter ac-heartbeat-degradation — skip on runtimes without frame-level ping
  if (shouldEnableHeartbeat(runtime)) {
    heartbeatManager.start(pubsubManager.getAllConnections());
  }

  // AC-12: Graceful shutdown on SIGTERM/SIGINT
  const shutdown = async (signal: string) => {
    console.log(`[daemon] Received ${signal}, shutting down gracefully...`);

    try {
      // Stop heartbeat monitoring
      heartbeatManager.stop();

      // AC: @config-shadow ac-17 - Stop all shadow sync schedulers
      // Uses stopAllShadowSync() instead of iterating the map directly so that
      // in-flight starts (suspended in loadProjectConfig) are also cancelled.
      stopAllShadowSync();

      watcherHealthMonitor?.stop();

      // AC: @session-branch-worktree ac-sync - Stop all session sync schedulers
      for (const scheduler of sessionSyncSchedulers.values()) {
        scheduler.stop();
      }
      sessionSyncSchedulers.clear();

      // AC: @agent-dispatch-engine ac-11 - Stop all dispatch engines before shutting down
      await stopAllEngines();

      // AC: @multi-directory-daemon ac-11b - Stop all file watchers
      await projectContextManager.stopAllWatchers();
      console.log("[daemon] All file watchers stopped");

      // Close all WebSocket connections with code 1000 (clean close)
      // AC: @trait-websocket-protocol ac-7
      for (const [_sessionId, ws] of pubsubManager.getAllConnections()) {
        ws.close(1000, "Server shutting down");
      }

      // Stop the server
      await stopManagedServer(app.server as ManagedServer | undefined);

      // AC: @daemon-server ac-10 - Remove PID file on shutdown
      if (isDaemon) {
        pidManager.remove();
        console.log("[daemon] PID file removed");
      }

      console.log("[daemon] Server stopped successfully");
      process.exit(0);
    } catch (error) {
      console.error("[daemon] Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return app;
}
