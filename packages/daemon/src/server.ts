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
import { PidFileManager, writeDaemonLastExitRecord } from "./pid.js";
import {
  DEFAULT_BIND_HOST,
  formatHostForUrl,
  isIpv6Literal,
  resolveDaemonEndpoint,
  selectStartupBindHost,
  type DaemonConnectionMetadata,
} from "./endpoint.js";
import { projectContextMiddleware } from "./middleware/project-context.js";
import { formatVersionIncompatibilityResponse } from "./routes/format-version-error.js";
import { createTasksRoutes } from "./routes/tasks.js";
import { createTaskResourcesRoutes } from "./routes/task-resources.js";
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
import { createCommandRoutes, getCommandDispatchHealth } from "./routes/command.js";
import { createAutomationRoutes } from "./routes/automation.js";
import { createDebugRoutes } from "./routes/debug.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createPlansRoutes } from "./routes/plans.js";
import { createPlanResourcesRoutes } from "./routes/plan-resources.js";
import { createAggregationRoutes } from "./routes/aggregation.js";
import { createRefsRoutes } from "./routes/refs.js";
import { createDiffRoutes } from "./routes/diff.js";
import { createReviewsRoutes } from "./routes/reviews.js";
import { createReviewResourcesRoutes } from "./routes/review-resources.js";
import { SessionSyncScheduler } from "./session-sync.js";
import { WatcherHealthMonitor } from "./watcher-health-monitor.js";
import {
  startShadowSyncForProject,
  stopShadowSyncForProject,
  stopAllShadowSync,
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
  /**
   * Execution time limit in milliseconds for commands dispatched through
   * the command API. Defaults to 120 seconds when omitted.
   *
   * AC: @daemon-command-api ac-command-timeout
   */
  commandTimeoutMs?: number;
}

type ManagedServer = {
  stop?: () => unknown;
  close?: (callback: (error?: Error | null) => void) => void;
};

/**
 * Captured shape of the server handle exposed by the listen() callback.
 *
 * `@elysiajs/node` builds a serverInfo object that wraps the underlying
 * srvx NodeServer (`raw`) and the raw `node:http` Server (`raw.node.server`).
 * We narrow it to the fields we actually use so awaitListenSuccess works
 * without leaning on adapter internals.
 */
interface ListenServerInfo {
  raw?: {
    ready?: () => Promise<unknown>;
    node?: {
      server?: {
        listening?: boolean;
        once: (event: string, listener: (...args: unknown[]) => void) => unknown;
        off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
      };
    };
  };
}

/**
 * Wait for the underlying server to confirm it is actually listening.
 *
 * `app.listen()` returns synchronously on Node — the real `http.Server`
 * `listen()` is invoked on the next tick by srvx's NodeServer, and bind
 * errors (EADDRINUSE, EADDRNOTAVAIL, EACCES) surface on its `'error'`
 * event after `app.listen()` has already returned. Treating the absence
 * of a synchronous throw as "the daemon is up" is therefore unsafe —
 * the daemon would write connection metadata advertising a URL that no
 * process actually owns.
 *
 * On Bun, `Bun.serve` throws synchronously on bind errors, so the
 * absence of an exception already proves the daemon is bound; this
 * helper short-circuits.
 *
 * AC: @daemon-network-endpoint-contract ac-connection-metadata
 */
async function awaitListenSuccess(
  serverInfo: ListenServerInfo | null,
  runtime: DaemonRuntime,
): Promise<void> {
  if (runtime === "bun") return;
  if (!serverInfo) return;
  const raw = serverInfo.raw;
  if (raw && typeof raw.ready === "function") {
    await raw.ready();
    return;
  }
  // Fallback for adapter shapes without `.ready()`: attach listeners
  // directly to the underlying http.Server. If the server is already
  // listening we resolve immediately.
  const httpServer = raw?.node?.server;
  if (!httpServer) return;
  if (httpServer.listening === true) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      httpServer.off?.("listening", onListening);
      httpServer.off?.("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    httpServer.once("listening", onListening as (...args: unknown[]) => void);
    httpServer.once("error", onError as (...args: unknown[]) => void);
  });
}

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
 * Options for the localhost-enforcement middleware.
 *
 * `additionalAllowedHosts` adds extra Host header values that the
 * middleware accepts beyond the default localhost set. The daemon passes
 * its resolved bind/connect hosts here so that requests addressed to
 * the advertised endpoint are accepted when external binding is
 * explicitly configured. Wildcard addresses are filtered out — they are
 * not real hosts to address, only bind targets.
 */
export interface LocalhostOnlyOptions {
  additionalAllowedHosts?: ReadonlyArray<string>;
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

/** Default Vite dev-server port for the web UI. */
const DEFAULT_WEB_UI_DEV_PORT = 5173;

function readWebUiDevPort(): number {
  const raw = process.env.KSPEC_WEB_UI_DEV_PORT;
  if (raw === undefined) return DEFAULT_WEB_UI_DEV_PORT;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_WEB_UI_DEV_PORT;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_WEB_UI_DEV_PORT;
  }
  return parsed;
}

/**
 * Build the set of CORS / WebSocket origins the daemon should accept,
 * derived from the resolved daemon endpoint instead of being hardcoded.
 *
 * Always includes:
 *  - The same-origin daemon URL (api_url) so the bundled production web
 *    UI can call the daemon it's served from.
 *  - Loopback aliases of the daemon URL (http://localhost:PORT,
 *    http://127.0.0.1:PORT, http://[::1]:PORT). The localhostOnly
 *    middleware always accepts Host: localhost, 127.0.0.1, and ::1
 *    regardless of bind host, so a user opening the production daemon
 *    UI through any loopback alias gets a same-origin browser context
 *    whose requests must be allowed. Mirroring those aliases here
 *    preserves production same-origin across IPv4/IPv6 fallback and
 *    developer-typed `localhost` URLs.
 *  - The local Vite dev server origin at the resolved connect host
 *    (with IPv6 bracketing) on KSPEC_WEB_UI_DEV_PORT (default 5173).
 *  - Loopback dev origins (http://localhost:DEV_PORT and
 *    http://127.0.0.1:DEV_PORT) so a developer running the dev server
 *    on either localhost alias can reach a loopback-bound daemon.
 *
 * Wildcard bind addresses are not added as concrete origins. When the
 * daemon binds to a non-loopback address the resolved connect host is
 * still added (a loopback or explicitly configured connect host), but
 * the allow-list is never widened to `*` — that would expose the
 * unauthenticated mutation API to any cross-origin caller.
 *
 * AC: @api-contract ac-1
 * AC: @api-contract ac-websocket-origin
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 */
export function buildAllowedOrigins(args: {
  apiUrl: string;
  connectHost: string;
  devPort?: number;
}): ReadonlyArray<string> {
  const devPort = args.devPort ?? DEFAULT_WEB_UI_DEV_PORT;
  const origins = new Set<string>();

  // Same-origin daemon URL (production: web UI is served from the daemon).
  origins.add(args.apiUrl);

  // Same-origin daemon-port loopback aliases. Empty string when the
  // daemon listens on the protocol's default port — browsers strip the
  // default port from the Origin header, so we must not append `:80` to
  // the alias.
  const apiUrlPort = new URL(args.apiUrl).port;
  const daemonPortSuffix = apiUrlPort.length > 0 ? `:${apiUrlPort}` : "";
  origins.add(`http://localhost${daemonPortSuffix}`);
  origins.add(`http://127.0.0.1${daemonPortSuffix}`);
  origins.add(`http://[::1]${daemonPortSuffix}`);

  // Local dev server origin at the resolved connect host. IPv6 is bracketed.
  const formattedConnect = formatHostForUrl(args.connectHost);
  origins.add(`http://${formattedConnect}:${devPort}`);

  // Loopback dev origins so a dev server on either localhost alias works
  // against a loopback-bound daemon.
  origins.add(`http://localhost:${devPort}`);
  origins.add(`http://127.0.0.1:${devPort}`);

  return Array.from(origins);
}

/**
 * True when the request's `Origin` header is in the allow-list. Returns
 * true when the header is absent so non-browser clients (curl, the CLI,
 * native test runners) are not gratuitously rejected — origin checks
 * are a CSRF mitigation against the browser-controlled `Origin` header,
 * not a host-level authorization gate (which `localhostOnly` covers).
 *
 * AC: @api-contract ac-websocket-origin
 */
export function isAllowedOrigin(
  origin: string | null | undefined,
  allowed: ReadonlyArray<string>,
): boolean {
  if (origin === null || origin === undefined || origin.length === 0) return true;
  return allowed.includes(origin);
}

/**
 * Middleware to enforce localhost-only connections.
 *
 * Default allowed hosts: localhost, 127.0.0.1, ::1. Callers may extend
 * the allow-list via `additionalAllowedHosts` to accept the daemon's
 * resolved/advertised connect host when external binding is configured.
 *
 * AC: @daemon-server ac-3 — Reject non-localhost connections with 403 Forbidden
 * AC: @trait-localhost-security ac-loopback-rejects-nonlocal
 */
export function localhostOnly(options: LocalhostOnlyOptions = {}) {
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const host of options.additionalAllowedHosts ?? []) {
    if (typeof host !== "string") continue;
    const trimmed = host.trim();
    if (trimmed.length === 0) continue;
    // Accept bracketed IPv6 input from callers that pass URL-formatted hosts.
    const stripped =
      trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    if (WILDCARD_HOSTS.has(stripped)) continue;
    allowed.add(stripped);
  }

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

    if (!allowed.has(hostname)) {
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
 * Build the GET /api/health response body. Exported so tests exercise the
 * production health shape without booting the full server.
 *
 * Top-level status stays "ok" while the process is serving requests;
 * command-dispatch degradation is reported in the command_dispatch
 * sub-object so existing status consumers keep working.
 *
 * AC: @daemon-server ac-11 — {status, uptime, connections, version, runtime}
 * AC: @daemon-command-api ac-stuck-command-reported — degraded command
 * dispatch reported with stuck command name and held duration
 */
export function buildHealthResponse(args: { connections: number; runtime: DaemonRuntime }) {
  return {
    status: "ok",
    uptime: process.uptime(),
    connections: args.connections,
    version: "0.1.0",
    runtime: args.runtime,
    command_dispatch: getCommandDispatchHealth(),
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
    commandTimeoutMs,
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

  // AC: @multi-directory-daemon ac-9 - Write PID and port files in daemon mode.
  // PID is written before listen() because it serves as the coordination
  // primitive for stale-daemon detection (atomic O_CREAT|O_EXCL); the legacy
  // port file is written alongside it for back-compat consumers. Connection
  // metadata is written *after* listen() succeeds (see below) so a failed
  // bind never advertises a daemon URL clients would honor.
  // AC: @daemon-server ac-9 — detach writes lifecycle and connection metadata
  if (isDaemon) {
    pidManager.writePid();
    pidManager.writePort(port);
    console.log(`[daemon] PID file written: ${process.pid}`);
    console.log(`[daemon] Port file written: ${port}`);
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

  // AC: @api-contract ac-1
  // AC: @api-contract ac-websocket-origin
  // Derive the CORS allow-list from the resolved daemon endpoint
  // (same-origin daemon URL + dev server origins at the resolved
  // connect host) instead of hardcoding localhost:5173. Explicitly
  // never expand to wildcard CORS — even when the daemon binds
  // externally — because the API is unauthenticated.
  const allowedOrigins = buildAllowedOrigins({
    apiUrl: endpoint.apiUrl,
    connectHost: endpoint.connectHost,
    devPort: readWebUiDevPort(),
  });

  app
    // AC-15: Plugin pattern for middleware
    .use(
      cors({
        origin: Array.from(allowedOrigins),
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      }),
    )

    // AC-3: Enforce localhost-only connections
    // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
    // AC: @config-daemon ac-connect-host-config
    // When external binding is explicitly configured (wildcard bind or a
    // specific non-loopback address), the resolved connect host is the
    // value clients call. Extend the localhost allow-list with the
    // resolved bind/connect hosts so requests addressed to the daemon's
    // advertised endpoint are not rejected as non-localhost.
    .onRequest(
      localhostOnly({
        additionalAllowedHosts: [endpoint.bindHost, endpoint.connectHost],
      }),
    )

    // AC: @data-format-forward-compatibility ac-daemon-structured-error
    // Global mapper for format-version ceiling refusals raised by
    // initContext inside any route handler. Registered on the parent app
    // before route plugins so it applies to every API route; route-group
    // onError handlers that don't match (entity/task storage mappers) fall
    // through to this handler.
    .onError(({ error: err, set }) => {
      const conflict = formatVersionIncompatibilityResponse(err);
      if (conflict) {
        set.status = conflict.status;
        return conflict.body;
      }
    });

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
    // AC: @daemon-command-api ac-stuck-command-reported — reports degraded
    // command dispatch with the stuck command name and held duration
    .get("/api/health", () =>
      buildHealthResponse({
        connections: pubsubManager.getConnectionCount(),
        runtime,
      }),
    )

    // AC: @api-contract ac-2 through ac-7 - Task API endpoints
    // AC: @multi-directory-daemon ac-24 - Routes use projectContext from middleware
    // AC: @daemon-entity-cache ac-serve-from-memory, ac-write-through — pass cache accessor
    .use(
      createTasksRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    )

    // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
    // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-task-owned-copy
    // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-refuse-drifted-or-missing-ref
    // AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
    //     — task-scoped resource list/metadata/bytes routes with drift-safe byte serving
    .use(createTaskResourcesRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

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
    // AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    //     — plan resource API (list/metadata/bytes/upload/delete)
    .use(createPlanResourcesRoutes({ getEntityCache: entityCacheModule.getEntityCache }))

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

    // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
    .use(
      createReviewResourcesRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
      }),
    )

    // AC: @agent-dispatch-engine ac-4 - Agent dispatch API endpoints
    // AC: @daemon-agent-dispatch ac-3, ac-4 - Pass pubsub for WebSocket broadcast on invocation events
    .use(createAgentDispatchRoutes({ pubsub: pubsubManager }))

    // AC: @daemon-command-api ac-command-endpoint, ac-batch-support - Command execution API
    // AC: @daemon-command-api ac-command-timeout — configured execution limit
    .use(
      createCommandRoutes({
        pubsub: pubsubManager,
        getEntityCache: entityCacheModule.getEntityCache,
        commandTimeoutMs,
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
          // AC: @api-contract ac-websocket-origin
          // Reject the upgrade when the browser-supplied Origin header
          // is not in the daemon's CORS allow-list. Origin headers are
          // attached by browsers, not by curl/CLI clients — when absent
          // we let `localhostOnly` enforce host-level access instead.
          const origin = request.headers.get("origin");
          if (!isAllowedOrigin(origin, allowedOrigins)) {
            throw new Error(
              `WebSocket origin '${origin ?? ""}' is not in the daemon's allowed origin list`,
            );
          }

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
  let listenServerInfo: ListenServerInfo | null = null;
  const captureServerInfo = (info: unknown): void => {
    listenServerInfo = info as ListenServerInfo;
  };
  if (isIpv6Literal(endpoint.bindHost)) {
    const OriginalURL = globalThis.URL;
    function PatchedURL(
      input: ConstructorParameters<typeof URL>[0],
      base?: ConstructorParameters<typeof URL>[1],
    ): URL {
      const fixed =
        typeof input === "string"
          ? input.replace(/^(https?:\/\/)([0-9a-fA-F]*:[0-9a-fA-F:]+)(:\d+)/, "$1[$2]$3")
          : input;
      return new OriginalURL(fixed, base);
    }
    PatchedURL.prototype = OriginalURL.prototype;
    (globalThis as { URL: typeof URL }).URL = PatchedURL as unknown as typeof URL;
    try {
      app.listen({ port, hostname: endpoint.bindHost }, captureServerInfo);
    } finally {
      (globalThis as { URL: typeof URL }).URL = OriginalURL;
    }
  } else {
    app.listen({ port, hostname: endpoint.bindHost }, captureServerInfo);
  }

  // Block until the underlying http.Server actually emits 'listening'
  // (or rejects with the bind error). On Node, app.listen() above only
  // schedules the bind — bind errors fire asynchronously on the http
  // server's 'error' event. Awaiting here ensures we never write
  // connection metadata advertising a daemon that failed to bind. On
  // Bun, app.listen() throws synchronously on bind errors so this is a
  // no-op once the call returned.
  //
  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  // AC: @daemon-server ac-9
  await awaitListenSuccess(listenServerInfo, runtime);

  console.log(`[daemon] Server listening on ${endpoint.apiUrl} (bind: ${endpoint.bindHost})`);
  console.log(`[daemon] WebSocket available at ${endpoint.wsUrl}`);

  // AC: @daemon-network-endpoint-contract ac-connection-metadata
  // AC: @daemon-server ac-9
  // Write connection metadata only after the server has confirmed it is
  // listening on the resolved bind host (see awaitListenSuccess above).
  // Bind errors (EADDRINUSE, EADDRNOTAVAIL) surface as a rejection from
  // that helper before this point — main() catches and exits, leaving
  // no daemon.connection.json behind.
  if (isDaemon) {
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
    console.log(`[daemon] Connection metadata written: ${endpoint.apiUrl}`);
  }

  // AC: @daemon-network-endpoint-contract ac-external-binding-warning
  // AC: @daemon-server ac-external-bind-warning
  // AC: @trait-localhost-security ac-external-warning
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
  projectContextManager.setCacheInvalidationCallback(
    (projectPath, projectKspecDir, file, content) => {
      const cache = entityCacheModule.getEntityCache(projectPath);
      if (!cache) return;

      cache.handleFileChange(projectKspecDir, file, content).catch((err: unknown) => {
        console.error(`[entity-cache] Error handling file change for ${projectPath}:`, err);
      });
    },
  );

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

    // AC: @daemon-failure-observability ac-graceful-exit-recorded — record
    // the graceful termination up front so even a teardown hang (followed
    // by a forced SIGKILL from `kspec serve stop`) leaves an accurate
    // record. A teardown failure overwrites this with a fatal record in
    // the catch below. Unlike pidManager.remove(), the last-exit record is
    // deliberately NOT removed — it must survive the process.
    if (isDaemon) {
      writeDaemonLastExitRecord({ kind: "graceful", reason: `Received ${signal}` });
    }

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

      // AC: @daemon-server ac-10 — Remove PID, port, and connection metadata
      // files on graceful shutdown. PidFileManager.remove() unlinks the full
      // global lifecycle set so a stopped daemon never leaves an api_url
      // advertising itself as available.
      if (isDaemon) {
        pidManager.remove();
        console.log("[daemon] Lifecycle files removed (pid, port, connection metadata)");
      }

      console.log("[daemon] Server stopped successfully");
      process.exit(0);
    } catch (error) {
      console.error("[daemon] Error during shutdown:", error);
      // A failed teardown is not a graceful exit — overwrite the record
      // written above so status reports the failure.
      if (isDaemon) {
        const err = error instanceof Error ? error : new Error(String(error));
        writeDaemonLastExitRecord({
          kind: "fatal",
          reason: `Error during ${signal} shutdown: ${err.message}`,
          stack: err.stack,
        });
      }
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return app;
}
