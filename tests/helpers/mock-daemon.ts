/**
 * Shared mock daemon fixture for CLI client tests.
 *
 * Centralises:
 *   - Mock daemon process lifecycle (in-process or child process)
 *   - Bind-host flexibility (127.0.0.1, 127.0.0.2, ::1, …)
 *   - Behavior modes for /api/command (normal | error | hang)
 *   - Request recording (in-memory for in-process, JSONL for child process)
 *   - Canonical daemon.connection.json metadata writing
 *   - Loopback-alias / IPv6 availability probing
 *
 * Two execution modes share the same surface API:
 *
 *   - In-process (default): the helper runs http.createServer() inside the
 *     test process. Used when the test invokes Node functions directly
 *     (postDispatchEvent, getDaemonStatus, detectDaemon, …).
 *
 *   - Child process: the helper spawns mock-daemon.cjs in a separate node
 *     process. Required when the test invokes the kspec CLI through
 *     spawnSync — that call blocks the test runner event loop, so an
 *     in-process listener cannot accept the CLI's requests.
 *
 * Metadata writing routes through writeDaemonConnectionMetadata in
 * src/daemon-shared/endpoint.ts so the resulting daemon.connection.json
 * matches the canonical schema validated by daemon clients in production.
 *
 * AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
 * AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
 * AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
 * AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
 * AC: @daemon-test-harness-guardrails ac-fixture-contract-tests-run
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import { ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDaemonUrls,
  formatHostForUrl,
  writeDaemonConnectionMetadata,
  type DaemonConnectionMetadata,
  type DaemonRuntime,
} from "../../src/daemon-shared/endpoint.js";

import { buildTestSubprocessEnv, readTestOutputSync, type IsolatedKspecHome } from "./cli.js";
import { stopChildProcessBounded } from "./process-stop.js";

// ── Paths ─────────────────────────────────────────────────────────────

const HELPER_DIR =
  typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const MOCK_DAEMON_SCRIPT = join(HELPER_DIR, "mock-daemon.cjs");

// ── Public types ──────────────────────────────────────────────────────

export type MockDaemonMode = "normal" | "error" | "hang" | "refuse";

export interface RecordedMockRequest {
  method: string;
  url: string;
  host: string | null;
  body: string;
  receivedAt: number;
}

export interface MockDaemonClient {
  /** Listening port (resolved from OS-assigned ephemeral port). */
  port: number;
  /** Address the mock daemon binds to. Canonical (no IPv6 brackets). */
  bindHost: string;
  /** API URL formed from bindHost:port via canonical buildDaemonUrls. */
  apiUrl: string;
  /** WebSocket URL formed from bindHost:port via canonical buildDaemonUrls. */
  wsUrl: string;
  /** Synchronous snapshot of recorded requests. */
  requests: () => RecordedMockRequest[];
  /** Idempotent teardown. */
  stop: () => Promise<void>;
}

export interface StartMockDaemonOptions {
  /** Bind host. Defaults to 127.0.0.1. */
  bindHost?: string;
  /** /api/command behavior mode. Defaults to "normal". */
  mode?: MockDaemonMode;
  /**
   * When true, run the mock daemon in a separate node child process. This
   * is required when the test invokes the kspec CLI via spawnSync — that
   * call blocks the test runner event loop, so an in-process listener
   * cannot accept the CLI's requests. The helper writes recorded requests
   * to a JSONL file the parent reads back through `requests()`.
   *
   * Defaults to false (in-process). When true and `recordPath` is omitted,
   * the helper allocates a temp JSONL file alongside the child process.
   */
  asChildProcess?: boolean;
  /**
   * Path for the JSONL request record file (child-process mode only).
   * When omitted, a temp file under the OS temp dir is allocated.
   */
  recordPath?: string;
  /**
   * Test-only seam: extra args appended verbatim to the spawn argv when
   * starting the child mock daemon. Production callers must not pass this.
   * The failure-path contract tests in mock-daemon.test.ts use it to drive
   * the `--break`, `--pid-file`, and `--env-record` flags in mock-daemon.cjs
   * without exposing those failure-injection seams as public helper API.
   */
  __testInjectArgs?: string[];
  /**
   * Test-only seam: override the child startup readiness timeout for the
   * spawn-and-wait path. Production callers must not pass this. The
   * failure-path contract tests use it to exercise the helper's timeout
   * cleanup branch within a single per-test budget rather than waiting
   * out the production CHILD_STARTUP_TIMEOUT_MS default.
   */
  __testStartupTimeoutMs?: number;
  /**
   * Optional `command_dispatch` payload included in the /api/health response
   * body. Tests that verify clients surface command-dispatch health (e.g.
   * `kspec serve status` reporting a wedged dispatch) use this to simulate
   * the daemon's degraded health shape. Omitted from /api/health when unset.
   */
  healthCommandDispatch?: Record<string, unknown>;
  /**
   * Explicit env overrides for the spawned child (child-process mode only).
   *
   * The base env is built via `buildTestSubprocessEnv` so dispatch / agent /
   * runner-mode vars are stripped, and ambient daemon-control vars (e.g.
   * KSPEC_DAEMON_PID, KSPEC_NO_DAEMON) are stripped on top of that — keys
   * present here are preserved regardless of the strip lists, so a test that
   * needs to set (or pass through) a daemon-control var can do so explicitly.
   */
  env?: Record<string, string>;
}

/**
 * Ambient daemon-control env vars that must NOT leak into the mock daemon
 * child via the parent's `process.env`. Inheriting these would let a stale
 * pid / port from the developer's local daemon — or from a parallel test —
 * pin the mock child to an unrelated endpoint, undermining the standardized
 * fixture contract for CLI routing tests. Mirrors the equivalent strip list
 * in `tests/helpers/daemon.ts` (`buildDaemonChildEnv`); the URL twins are
 * included here because the mock daemon child has no use for them and the
 * helper's failure-path contract tests record them as part of the sanitised
 * env snapshot.
 */
const AMBIENT_DAEMON_CONTROL_VARS = [
  "KSPEC_DAEMON_PID",
  "KSPEC_DAEMON_PORT",
  "KSPEC_DAEMON_HOST",
  "KSPEC_DAEMON_CONNECT_HOST",
  "KSPEC_DAEMON_RUNTIME",
  "KSPEC_DAEMON_API_URL",
  "KSPEC_DAEMON_WS_URL",
  "KSPEC_NO_DAEMON",
] as const;

/**
 * Build the env passed to a spawned mock daemon child.
 *
 * Layers, in order:
 *   1. `process.env` with dispatch / agent / runner-mode vars stripped
 *      (delegated to `buildTestSubprocessEnv`).
 *   2. Ambient daemon-control vars stripped on top so a stale local-daemon
 *      pid / port cannot pin the mock child to an unrelated endpoint.
 *   3. Caller `overrides` applied last — keys present here are preserved
 *      regardless of either strip list (caller opts in explicitly).
 *
 * @see ac-child-env-sanitized in @daemon-test-startup-failure-hygiene
 */
function buildMockDaemonChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = buildTestSubprocessEnv(overrides);
  for (const key of AMBIENT_DAEMON_CONTROL_VARS) {
    if (!(key in overrides)) {
      delete env[key];
    }
  }
  return env;
}

// ── Host probing ──────────────────────────────────────────────────────

/**
 * Probe whether a loopback alias / IPv6 host is addressable. Tests use this
 * to skip platform-specific cases (Linux maps 127.0.0.0/8 to loopback so
 * 127.0.0.2 works; macOS / Windows do not bind it by default; ::1 is
 * unavailable in containers without IPv6).
 */
export async function probeHostAvailable(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => {
      try {
        probe.close(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
    probe.once("listening", () => probe.close(() => resolve(true)));
    try {
      probe.listen({ host, port: 0, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

// ── In-process implementation ─────────────────────────────────────────

interface InProcessHandlerContext {
  body: string;
  url: URL;
  request: http.IncomingMessage;
  response: http.ServerResponse;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function respondJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function handleInProcessRequest(
  ctx: InProcessHandlerContext,
  mode: MockDaemonMode,
  healthCommandDispatch?: Record<string, unknown>,
): void {
  const path = ctx.url.pathname;
  const method = ctx.request.method;

  if (path === "/api/health") {
    return respondJson(ctx.response, 200, {
      status: "ok",
      uptime: 1,
      runtime: "node",
      ...(healthCommandDispatch ? { command_dispatch: healthCommandDispatch } : {}),
    });
  }
  if (path === "/api/projects") {
    return respondJson(ctx.response, 200, { status: "ok" });
  }
  if (path === "/api/events/recent") {
    return respondJson(ctx.response, 200, { items: [], total: 0 });
  }
  if (path === "/api/events/emit" && method === "POST") {
    return respondJson(ctx.response, 200, {
      accepted: true,
      event_id: "01EVTRECORDED0000000000000",
      matched_hooks: [],
    });
  }
  if (path === "/api/schedules" && method === "GET") {
    return respondJson(ctx.response, 200, { items: [] });
  }
  if (path.startsWith("/api/schedules/") && path.endsWith("/trigger") && method === "POST") {
    return respondJson(ctx.response, 200, {
      outcome: "executed",
      accepted: true,
      reason: null,
    });
  }
  if (path === "/api/agent/dispatch/status") {
    return respondJson(ctx.response, 200, {
      running: false,
      activeInvocations: 0,
      queuedInvocations: 0,
      invocations: [],
      queued: [],
    });
  }
  if (path === "/api/agent/dispatch/start" && method === "POST") {
    return respondJson(ctx.response, 200, {
      started: true,
      status: { running: true, activeInvocations: 0, queuedInvocations: 0 },
    });
  }
  if (path === "/api/agent/dispatch/stop" && method === "POST") {
    return respondJson(ctx.response, 200, { stopped: true });
  }
  if (path === "/api/agent/events" && method === "POST") {
    return respondJson(ctx.response, 200, { accepted: true });
  }
  if (path === "/api/command" && method === "POST") {
    if (mode === "hang") return; // never respond
    if (mode === "error") {
      ctx.response.writeHead(422, { "Content-Type": "application/json" });
      ctx.response.end(JSON.stringify({ stdout: "", stderr: "error: not found\n", exitCode: 3 }));
      return;
    }
    if (mode === "refuse") {
      ctx.response.writeHead(503, { "Content-Type": "text/plain" });
      ctx.response.end("mock daemon refuses /api/command");
      return;
    }
    let parsed: { command?: unknown };
    try {
      parsed = JSON.parse(ctx.body || "{}") as { command?: unknown };
    } catch {
      parsed = {};
    }
    return respondJson(ctx.response, 200, {
      stdout: `proxied: ${typeof parsed.command === "string" ? parsed.command : ""}\n`,
      stderr: "",
      exitCode: 0,
    });
  }

  ctx.response.writeHead(404);
  ctx.response.end("Not found");
}

// In-process stop() budget. `server.close()` waits for active connections to
// drain, so a hung request keeps the close callback pending forever. The
// graceful budget gives a cooperating handler time to finish; on elapse the
// helper escalates by force-destroying remaining sockets so close finalizes.
// The hard bound is a safety net for any future Node behavior where close
// stays pending even after all sockets are destroyed — teardown must always
// reach a bounded outcome.
const IN_PROCESS_STOP_GRACEFUL_MS = 250;
const IN_PROCESS_STOP_BOUND_MS = 1_000;

async function startInProcessMockDaemon(
  bindHost: string,
  mode: MockDaemonMode,
  healthCommandDispatch?: Record<string, unknown>,
): Promise<MockDaemonClient | null> {
  return new Promise((resolve) => {
    const recorded: RecordedMockRequest[] = [];
    // Track every accepted socket so stop() can force-close active connections
    // when server.close() is otherwise pinned by a hung handler.
    const activeSockets = new Set<Socket>();
    const server = http.createServer(async (req, res) => {
      const body = await readRequestBody(req);
      recorded.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        host: req.headers.host ?? null,
        body,
        receivedAt: Date.now(),
      });
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? bindHost}`);
      handleInProcessRequest(
        { body, url, request: req, response: res },
        mode,
        healthCommandDispatch,
      );
    });
    server.on("connection", (socket: Socket) => {
      activeSockets.add(socket);
      socket.once("close", () => activeSockets.delete(socket));
    });

    let settled = false;
    const finish = (value: MockDaemonClient | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    server.once("error", () => {
      try {
        server.close(() => finish(null));
      } catch {
        finish(null);
      }
    });
    server.listen(0, bindHost, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => finish(null));
        return;
      }
      const port = addr.port;
      const { apiUrl, wsUrl } = buildDaemonUrls(bindHost, port);
      let stopPromise: Promise<void> | undefined;
      // Operational stop(): bounded teardown that cannot block on a hung
      // request. server.close() pins on active connections, so the helper
      // escalates after a small graceful budget by destroying any remaining
      // sockets (matches server.closeAllConnections() semantics) and a hard
      // bound resolves the promise even if close() never fires its callback.
      // Idempotent — subsequent calls return the cached promise.
      // AC: @daemon-test-teardown-boundedness ac-active-requests-do-not-block-teardown
      const stop = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        stopPromise = new Promise<void>((resolveStop) => {
          let settledStop = false;
          const finishStop = (): void => {
            if (settledStop) return;
            settledStop = true;
            clearTimeout(gracefulTimer);
            clearTimeout(boundTimer);
            resolveStop();
          };
          const gracefulTimer = setTimeout(() => {
            // Force-close any sockets still tying up server.close(). Once
            // every connection is destroyed, the close callback fires and
            // finishStop runs via the close path.
            for (const socket of activeSockets) {
              socket.destroy();
            }
          }, IN_PROCESS_STOP_GRACEFUL_MS);
          const boundTimer = setTimeout(finishStop, IN_PROCESS_STOP_BOUND_MS);
          server.close(() => finishStop());
        });
        return stopPromise;
      };
      finish({
        port,
        bindHost,
        apiUrl,
        wsUrl,
        requests: () => [...recorded],
        stop,
      });
    });
  });
}

// ── Child-process implementation ──────────────────────────────────────

const CHILD_STARTUP_TIMEOUT_MS = 5_000;
const CHILD_GRACEFUL_KILL_MS = 1_500;

function readRecordedFromFile(recordPath: string): RecordedMockRequest[] {
  if (!existsSync(recordPath)) return [];
  const raw = readTestOutputSync(recordPath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedMockRequest);
}

function allocateRecordPath(bindHost: string): string {
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const safeHost = bindHost.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(tmpDir, `kspec-mock-daemon-${safeHost}-${stamp}.jsonl`);
}

async function startChildMockDaemon(
  bindHost: string,
  mode: MockDaemonMode,
  recordPath: string,
  ownsRecordPath: boolean,
  injectArgs: string[],
  startupTimeoutMs: number,
  envOverrides: Record<string, string>,
  healthCommandDispatch?: Record<string, unknown>,
): Promise<MockDaemonClient | null> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(
      "node",
      [
        MOCK_DAEMON_SCRIPT,
        "--bind-host",
        bindHost,
        "--mode",
        mode,
        "--record",
        recordPath,
        ...(healthCommandDispatch
          ? ["--health-command-dispatch", JSON.stringify(healthCommandDispatch)]
          : []),
        ...injectArgs,
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: buildMockDaemonChildEnv(envOverrides),
      },
    );

    let settled = false;
    let stdout = "";
    const finish = (value: MockDaemonClient | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };

    // Helper-allocated record files must be removed on stop() so child-process
    // mock daemon runs do not leak request payloads under /tmp. Caller-supplied
    // paths are left intact — the caller owns their own cleanup.
    const cleanupRecordFile = (): void => {
      if (!ownsRecordPath) return;
      try {
        rmSync(recordPath, { force: true });
      } catch {
        // best-effort: ignore unlink errors on teardown
      }
    };

    /**
     * Idempotent child cleanup for startup-failure paths.
     *
     * Resolves only after the still-running mock daemon child has actually
     * been observed terminated — the contract is that the helper must not
     * return failure to the caller while the owned child is still alive.
     * Routes through the shared bounded stop primitive so SIGTERM,
     * escalation to SIGKILL, and exit-observation use the same semantics
     * as the operational `stop()` closure. Also removes the helper-allocated
     * record file. Safe to call from any failure branch (timeout, malformed
     * first-line stdout, spawn error) — subsequent calls return immediately
     * with the prior outcome, so cascading branches cannot double-kill or
     * thrash the record file.
     *
     * @see ac-owned-child-stopped-after-startup-failure in
     * @daemon-test-startup-failure-hygiene
     * @see ac-stop-observes-termination-before-return in
     * @daemon-test-teardown-boundedness
     */
    let startupCleanupPromise: Promise<void> | undefined;
    const cleanupChildOnStartupFailure = (): Promise<void> => {
      if (startupCleanupPromise) return startupCleanupPromise;
      startupCleanupPromise = stopChildProcessBounded(child, {
        gracefulMs: CHILD_GRACEFUL_KILL_MS,
        label: "mock daemon child (startup failure)",
      })
        .catch(() => {
          // Bounded-stop failure on the setup path is best-effort: callers
          // already routing through failStartup will surface their own
          // diagnostic. Swallow so cleanupRecordFile still runs and the
          // helper returns a single failure rather than a compound throw.
        })
        .finally(() => {
          cleanupRecordFile();
        });
      return startupCleanupPromise;
    };

    const failStartup = (): void => {
      cleanupChildOnStartupFailure().then(() => finish(null));
    };

    const timeoutId = setTimeout(failStartup, startupTimeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newlineIdx = stdout.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = stdout.slice(0, newlineIdx);
      let parsed: { port: number; bindHost: string };
      try {
        parsed = JSON.parse(line) as { port: number; bindHost: string };
      } catch {
        failStartup();
        return;
      }
      const { apiUrl, wsUrl } = buildDaemonUrls(parsed.bindHost, parsed.port);
      let stopPromise: Promise<void> | undefined;
      // Operational stop(): route through the shared bounded primitive so
      // SIGTERM, escalation to SIGKILL, and exit observation match the
      // semantics enforced by @daemon-test-teardown-boundedness. Cleanup
      // never reports success while the child is still observably alive.
      // Idempotent — subsequent calls return the cached promise.
      const stop = (): Promise<void> => {
        if (stopPromise) return stopPromise;
        stopPromise = stopChildProcessBounded(child, {
          gracefulMs: CHILD_GRACEFUL_KILL_MS,
          label: "mock daemon child",
        }).finally(() => {
          cleanupRecordFile();
        });
        return stopPromise;
      };
      finish({
        port: parsed.port,
        bindHost: parsed.bindHost,
        apiUrl,
        wsUrl,
        requests: () => readRecordedFromFile(recordPath),
        stop,
      });
    });

    child.on("error", failStartup);
    child.on("exit", () => {
      if (!settled) {
        // Child exited on its own (e.g. mode/break arg validation failed).
        // The OS already reaped it, so we only need the record-file cleanup.
        cleanupRecordFile();
        finish(null);
      }
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Start a mock daemon for CLI client routing tests.
 *
 * Returns null when the bind host is unreachable on this system (e.g.
 * 127.0.0.2 on macOS / Windows, ::1 in IPv6-disabled containers). Callers
 * should probe with `probeHostAvailable` first when targeting non-default
 * loopback addresses, and skip the test on null.
 *
 * AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
 * AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
 * AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
 */
export async function startMockDaemon(
  opts: StartMockDaemonOptions = {},
): Promise<MockDaemonClient | null> {
  const bindHost = opts.bindHost ?? "127.0.0.1";
  const mode: MockDaemonMode = opts.mode ?? "normal";
  if (opts.asChildProcess) {
    const ownsRecordPath = opts.recordPath === undefined;
    const recordPath = opts.recordPath ?? allocateRecordPath(bindHost);
    const injectArgs = opts.__testInjectArgs ?? [];
    const startupTimeoutMs = opts.__testStartupTimeoutMs ?? CHILD_STARTUP_TIMEOUT_MS;
    const envOverrides = opts.env ?? {};
    return startChildMockDaemon(
      bindHost,
      mode,
      recordPath,
      ownsRecordPath,
      injectArgs,
      startupTimeoutMs,
      envOverrides,
      opts.healthCommandDispatch,
    );
  }
  return startInProcessMockDaemon(bindHost, mode, opts.healthCommandDispatch);
}

// ── Metadata writing ──────────────────────────────────────────────────

export interface WriteMockDaemonMetadataOptions {
  home: IsolatedKspecHome;
  client: MockDaemonClient;
  /** Defaults to the test process pid (so PidFileManager.isDaemonRunning sees a live process). */
  pid?: number;
  /** Defaults to "node". */
  runtime?: DaemonRuntime;
  /** Defaults to client.bindHost. Override to advertise a wildcard bind. */
  bindHost?: string;
  /** Defaults to client.bindHost. */
  connectHost?: string;
  /** Defaults to canonical apiUrl derived from connect host & port. */
  apiUrl?: string;
  /** Defaults to canonical wsUrl derived from connect host & port. */
  wsUrl?: string;
}

/**
 * Write canonical daemon connection metadata for a running mock daemon.
 *
 * Routes through writeDaemonConnectionMetadata in src/daemon-shared/endpoint.ts
 * so the on-disk JSON matches the schema clients validate in production —
 * pretty-printed, key-ordered, with snake_case fields. Also writes the
 * companion daemon.pid file (defaults to the test process pid so
 * PidFileManager.isDaemonRunning sees a live process).
 *
 * AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */
export function writeMockDaemonMetadata(opts: WriteMockDaemonMetadataOptions): void {
  const pid = opts.pid ?? process.pid;
  const runtime: DaemonRuntime = opts.runtime ?? "node";
  const bindHost = opts.bindHost ?? opts.client.bindHost;
  const connectHost = opts.connectHost ?? opts.client.bindHost;
  const derived = buildDaemonUrls(connectHost, opts.client.port);
  const metadata: DaemonConnectionMetadata = {
    pid,
    port: opts.client.port,
    bind_host: bindHost,
    connect_host: connectHost,
    api_url: opts.apiUrl ?? derived.apiUrl,
    ws_url: opts.wsUrl ?? derived.wsUrl,
    runtime,
  };

  // Write pid first so a missed teardown leaves the metadata + pid in a
  // consistent state. writeDaemonConnectionMetadata creates the config dir.
  writeFileSync(opts.home.daemonPidFilePath, String(pid));
  writeDaemonConnectionMetadata(metadata, opts.home.configDir);
}

// ── Legacy port file ──────────────────────────────────────────────────

export interface WriteLegacyDaemonPortOptions {
  home: IsolatedKspecHome;
  port: number;
  /** Defaults to the test process pid for liveness checks. */
  pid?: number;
}

/**
 * Write the legacy daemon.port file (no daemon.connection.json).
 *
 * Keeps the legacy fallback path explicit at the call site — tests that
 * verify clients synthesise `http://127.0.0.1:<port>` from the port file
 * alone use this helper instead of writeMockDaemonMetadata.
 *
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 */
export function writeLegacyDaemonPort(opts: WriteLegacyDaemonPortOptions): void {
  const pid = opts.pid ?? process.pid;
  writeFileSync(opts.home.daemonPidFilePath, String(pid));
  writeFileSync(opts.home.daemonPortFilePath, String(opts.port));
}

// ── URL helpers (canonical re-exports) ────────────────────────────────

/**
 * Format the Host header value a client would send to the mock daemon.
 * IPv6 literals are bracketed via the canonical formatHostForUrl helper.
 *
 * Test assertions on `req.headers.host` should compare against this
 * function's output to avoid duplicating IPv6 bracket logic in test
 * code.
 */
export function expectedHostHeader(host: string, port: number): string {
  return `${formatHostForUrl(host)}:${port}`;
}
