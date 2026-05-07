/**
 * Shared daemon test fixture core.
 *
 * Provides the contract that real daemon child-process tests share — both
 * Vitest and Playwright. Vitest tests register the returned `stop()` with
 * `onTestFinished`; the Playwright wrapper registers it through `test.extend`
 * teardown. The core itself does not import vitest globals so a Playwright
 * wrapper can build on it without polluting the runtime.
 *
 * Fixture contract covers:
 *   - Temp project workspace with .kspec/ + shadow worktree pointer
 *   - Isolated HOME / kspec config dir (no ambient daemon PID/port leaks)
 *   - Sanitized child env (dispatch, agent, runner, ambient daemon vars stripped)
 *   - Resolved endpoint via src/daemon-shared/endpoint.ts (127.0.0.1 by default)
 *   - Bounded readiness polling on top of waitForStartup
 *   - Diagnostic bundle on readiness failure (endpoint, runtime, pid, exit
 *     code/signal, stdout/stderr tails, last health response, last cache-status
 *     response)
 *   - Scoped cleanup that targets only the fixture-owned child handle —
 *     never kills by port number or by reading the ambient pid file.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { cp as fsCp } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BIND_HOST,
  normalizeDaemonHost,
  resolveDaemonEndpoint,
  type DaemonResolvedEndpoint,
  type DaemonRuntime,
} from "../../src/daemon-shared/endpoint.js";
import {
  buildTestSubprocessEnv,
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  setupShadowDetection,
  waitForStartup,
  type IsolatedKspecHome,
  type StartupProbeResult,
} from "./cli.js";

// ── Paths ─────────────────────────────────────────────────────────────

const HELPER_DIR =
  typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HELPER_DIR, "..", "..");
const DAEMON_ENTRY = join(PROJECT_ROOT, "dist", "daemon", "index.js");
const E2E_FIXTURES = join(PROJECT_ROOT, "tests", "e2e", "fixtures");
const WEB_UI_BUILD_CANDIDATES = [
  join(PROJECT_ROOT, "dist", "web-ui"),
  join(PROJECT_ROOT, "packages", "web-ui", "build"),
];

// ── Public types ──────────────────────────────────────────────────────

export type DaemonTestRuntime = DaemonRuntime;

export interface CreateTestDaemonProjectOptions {
  /** Source directory copied into the project's `.kspec/`. Defaults to e2e fixtures. */
  fixturesSource?: string;
  /** When true, do not copy any fixture files into .kspec. */
  skipFixtures?: boolean;
  /** Override WEB_UI_DIR. Defaults to dist/web-ui or packages/web-ui/build if present. */
  webUiDir?: string | null;
}

export interface TestDaemonProject {
  /** Project temp directory. */
  tempDir: string;
  /** `.kspec/` subdirectory inside `tempDir`. */
  kspecDir: string;
  /** Isolated HOME / config / pid / port paths. */
  isolatedHome: IsolatedKspecHome;
  /** Resolved web UI build directory, or null when none is available. */
  webUiDir: string | null;
  /** Idempotent project teardown — removes the temp project tree. */
  cleanup: () => Promise<void>;
}

export type ReadinessMode =
  | { mode: "health" }
  | { mode: "health-and-cache" }
  | { mode: "custom"; probe: ReadinessProbe };

export interface ReadinessProbeContext {
  endpoint: DaemonResolvedEndpoint;
  child: ChildProcess;
  stdoutTail: () => string;
  stderrTail: () => string;
}

export type ReadinessProbe = (
  ctx: ReadinessProbeContext,
) => StartupProbeResult | Promise<StartupProbeResult>;

export interface StartTestDaemonOptions {
  /** Daemon runtime. Defaults to "node" so generic tests do not require Bun. */
  runtime?: DaemonTestRuntime;
  /** Bind host. Defaults to 127.0.0.1 (no localhost DNS dependency). */
  bindHost?: string;
  /** Explicit connect host (only meaningful with a wildcard bind host). */
  connectHost?: string | null;
  /** When true, passes `--host-explicit` to suppress the daemon's IPv6 fallback. */
  hostExplicitlyConfigured?: boolean;
  /** Listen port. Defaults to a dynamically allocated free port. */
  port?: number;
  /** Readiness mode. Defaults to "health-and-cache" so tests get a hot cache. */
  readiness?: ReadinessMode;
  /** Per-stage readiness budget in ms. Defaults to 15s. */
  timeoutMs?: number;
  /** Poll interval in ms for readiness. Defaults to 100ms. */
  intervalMs?: number;
  /** Extra env merged onto the sanitized child env. */
  extraEnv?: Record<string, string>;
  /** Extra CLI args appended to the daemon spawn. */
  extraArgs?: string[];
  /**
   * Called synchronously immediately after the daemon child is spawned but
   * before readiness polling. Use this to register the returned `stop`
   * function with `onTestFinished` (vitest), Playwright fixture teardown, or
   * any callback that survives assertion failures inside the readiness wait.
   */
  registerCleanup?: (stop: () => Promise<void>) => void;
}

export interface StartedTestDaemon {
  endpoint: DaemonResolvedEndpoint;
  runtime: DaemonTestRuntime;
  child: ChildProcess;
  pid: number | undefined;
  apiUrl: string;
  wsUrl: string;
  port: number;
  /** Snapshot of stdout collected so far (capped tail, ~8KB). */
  stdoutTail: () => string;
  /** Snapshot of stderr collected so far (capped tail, ~8KB). */
  stderrTail: () => string;
  /**
   * Stop the fixture-owned daemon. Idempotent. Targets only the captured
   * child handle — never reads the global pid/port file or kills by port.
   */
  stop: () => Promise<void>;
}

export interface DaemonReadinessDiagnostics {
  endpoint: {
    apiUrl: string;
    wsUrl: string;
    port: number;
    bindHost: string;
    connectHost: string;
  };
  runtime: DaemonTestRuntime;
  pid: number | undefined;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  lastHealth:
    | { status: number; body: string }
    | { error: string }
    | null;
  lastCacheStatus:
    | { status: number; cacheStatus: string | null; body: string }
    | { error: string }
    | null;
  cause: string;
}

export class DaemonReadinessError extends Error {
  readonly diagnostics: DaemonReadinessDiagnostics;
  constructor(diagnostics: DaemonReadinessDiagnostics) {
    super(
      [
        `Test daemon failed to reach readiness: ${diagnostics.cause}`,
        formatDiagnostics(diagnostics),
      ].join("\n"),
    );
    this.name = "DaemonReadinessError";
    this.diagnostics = diagnostics;
  }
}

// ── Env construction ──────────────────────────────────────────────────

/**
 * Ambient daemon-control env vars that must NOT leak into the test daemon
 * child. These pin a daemon to the user's global config directory and would
 * make the test child collide with — or stop — an unrelated running daemon.
 */
const AMBIENT_DAEMON_CONTROL_VARS = [
  "KSPEC_DAEMON_PID",
  "KSPEC_DAEMON_PORT",
  "KSPEC_DAEMON_HOST",
  "KSPEC_DAEMON_CONNECT_HOST",
  "KSPEC_DAEMON_RUNTIME",
  "KSPEC_NO_DAEMON",
];

/**
 * Build the env passed to the daemon child process.
 *
 * Layers, in order:
 *   1. `process.env` with dispatch/agent/runner-mode vars stripped
 *      (delegated to `buildTestSubprocessEnv` in cli.ts).
 *   2. Ambient daemon-control vars stripped so the child cannot reuse the
 *      developer's local daemon socket / pid file.
 *   3. Isolated HOME/USERPROFILE so daemon writes go to the temp .home dir.
 *   4. `WEB_UI_DIR` set if the project resolved a build path.
 *   5. NODE_ENV / BUN_ENV reset to "test" matching the runtime.
 *   6. Caller `extraEnv` overrides applied last (caller opts in explicitly).
 */
export function buildDaemonChildEnv(args: {
  runtime: DaemonTestRuntime;
  isolatedHome: IsolatedKspecHome;
  webUiDir?: string | null;
  extraEnv?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const overrides: Record<string, string> = {
    HOME: args.isolatedHome.homeDir,
    USERPROFILE: args.isolatedHome.homeDir,
  };
  if (args.runtime === "node") {
    overrides.NODE_ENV = "test";
  } else {
    overrides.BUN_ENV = "test";
  }
  if (args.webUiDir) {
    overrides.WEB_UI_DIR = args.webUiDir;
  }
  if (args.extraEnv) {
    Object.assign(overrides, args.extraEnv);
  }

  const env = buildTestSubprocessEnv(overrides);

  // Strip ambient daemon-control vars unless the caller explicitly opted
  // them in via extraEnv. The cli.ts strip list deliberately omits these
  // because daemon-sensitive CLI tests sometimes set KSPEC_NO_DAEMON=1
  // themselves; the daemon child must always start from a clean slate.
  const optedIn = new Set(Object.keys(args.extraEnv ?? {}));
  for (const key of AMBIENT_DAEMON_CONTROL_VARS) {
    if (!optedIn.has(key)) {
      delete env[key];
    }
  }
  return env;
}

// ── Runtime / port helpers ────────────────────────────────────────────

/**
 * Detect whether a daemon runtime is on PATH. Used by parity tests to skip
 * optional runtimes (Bun) without failing the generic Node coverage path.
 */
export async function isDaemonRuntimeAvailable(
  runtime: DaemonTestRuntime,
): Promise<boolean> {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    execSync(`${probe} ${runtime}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Allocate an OS-assigned free TCP port on the given host. */
export async function allocateTestDaemonPort(host = DEFAULT_BIND_HOST): Promise<number> {
  return await new Promise<number>((resolveOk, rejectErr) => {
    const server = createNetServer();
    server.once("error", rejectErr);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectErr(new Error("Failed to allocate ephemeral test daemon port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? rejectErr(err) : resolveOk(port)));
    });
  });
}

function findFirstWebUiBuild(): string | null {
  for (const candidate of WEB_UI_BUILD_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Project fixture ───────────────────────────────────────────────────

/**
 * Build a temp project workspace for a daemon-backed test.
 *
 * The resulting project directory contains a `.kspec/` shadow worktree
 * pointer, an isolated HOME/config tree, and (optionally) a fixture data
 * tree copied into `.kspec/`. The default fixture source is the e2e
 * fixtures dir, which already has the shape the daemon expects.
 */
export async function createTestDaemonProject(
  opts: CreateTestDaemonProjectOptions = {},
): Promise<TestDaemonProject> {
  const tempDir = await createTempDir("kspec-daemon-fixture-");
  const kspecDir = join(tempDir, ".kspec");
  mkdirSync(kspecDir, { recursive: true });

  // setupShadowDetection initializes git AND writes the worktree pointer
  // .kspec/.git → .git/worktrees/-kspec, so initContext() / daemon project
  // detection resolves spec data from .kspec/.
  await setupShadowDetection(tempDir);

  if (!opts.skipFixtures) {
    const source = opts.fixturesSource ?? E2E_FIXTURES;
    if (existsSync(source)) {
      await fsCp(source, kspecDir, {
        recursive: true,
        // Skip e2e wrapper artifacts that are not part of the daemon-visible
        // .kspec/ tree (test-base.ts, project-tests/).
        filter: (src) => !src.includes("test-base") && !src.includes("project-tests"),
      });
    }
  }

  const isolatedHome = await createIsolatedKspecHome(tempDir);

  const webUiDir =
    opts.webUiDir === undefined ? findFirstWebUiBuild() : opts.webUiDir ?? null;

  let cleanedUp = false;
  return {
    tempDir,
    kspecDir,
    isolatedHome,
    webUiDir,
    cleanup: async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await cleanupTempDir(tempDir);
    },
  };
}

// ── Output buffers ────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 100;
const TAIL_MAX_BYTES = 8 * 1024;

interface OutputBuffer {
  append(chunk: Buffer | string): void;
  text(): string;
}

function makeTailBuffer(maxBytes = TAIL_MAX_BYTES): OutputBuffer {
  let buf = "";
  return {
    append(chunk) {
      buf += typeof chunk === "string" ? chunk : chunk.toString();
      if (buf.length > maxBytes) {
        buf = buf.slice(buf.length - maxBytes);
      }
    },
    text() {
      return buf;
    },
  };
}

// ── Readiness probes ──────────────────────────────────────────────────

interface HealthProbeState {
  observed: { status: number; body: string } | null;
  errorMessage: string | null;
}

interface CacheProbeState {
  observed: { status: number; cacheStatus: string | null; body: string } | null;
  errorMessage: string | null;
}

function describeChildExit(child: ChildProcess): string | null {
  if (child.exitCode !== null && child.exitCode !== undefined) {
    return `process exited with code ${child.exitCode}`;
  }
  if (child.signalCode) {
    return `process exited with signal ${child.signalCode}`;
  }
  return null;
}

async function probeHealth(
  ctx: ReadinessProbeContext,
  state: HealthProbeState,
): Promise<StartupProbeResult> {
  const exited = describeChildExit(ctx.child);
  if (exited) {
    return {
      ok: false,
      details: `${exited}; stderr-tail=${ctx.stderrTail() || "<empty>"}`,
    };
  }
  try {
    const response = await fetch(`${ctx.endpoint.apiUrl}/api/health`);
    const body = await response.text();
    state.observed = { status: response.status, body };
    state.errorMessage = null;
    const ok = response.ok && body.includes('"status":"ok"');
    return {
      ok,
      details: `health status=${response.status} body=${body || "<empty>"}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.errorMessage = message;
    return { ok: false, details: `health fetch error=${message}` };
  }
}

async function probeCacheReady(
  ctx: ReadinessProbeContext,
  state: CacheProbeState,
): Promise<StartupProbeResult> {
  const exited = describeChildExit(ctx.child);
  if (exited) {
    return {
      ok: false,
      details: `${exited}; stderr-tail=${ctx.stderrTail() || "<empty>"}`,
    };
  }
  try {
    const response = await fetch(`${ctx.endpoint.apiUrl}/api/tasks`);
    const body = await response.text();
    let cacheStatus: string | null = null;
    try {
      const parsed = JSON.parse(body) as { meta?: { cache_status?: string } };
      cacheStatus = parsed?.meta?.cache_status ?? null;
    } catch {
      cacheStatus = null;
    }
    state.observed = { status: response.status, cacheStatus, body };
    state.errorMessage = null;
    return {
      ok: response.ok && cacheStatus === "ready",
      details: `cache status=${response.status} cache_status=${cacheStatus ?? "<missing>"}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.errorMessage = message;
    return { ok: false, details: `cache fetch error=${message}` };
  }
}

// ── Spawn / readiness orchestration ───────────────────────────────────

function buildDaemonArgs(args: {
  port: number;
  kspecDir: string;
  runtime: DaemonTestRuntime;
  bindHost: string;
  connectHost: string | null | undefined;
  hostExplicitlyConfigured: boolean;
  extraArgs: string[];
}): string[] {
  const result: string[] = [
    DAEMON_ENTRY,
    "--port",
    String(args.port),
    "--runtime",
    args.runtime,
    "--kspec-dir",
    args.kspecDir,
  ];
  if (args.bindHost !== DEFAULT_BIND_HOST) {
    result.push("--host", args.bindHost);
  }
  if (args.hostExplicitlyConfigured) {
    result.push("--host-explicit");
  }
  if (args.connectHost) {
    result.push("--connect-host", args.connectHost);
  }
  if (args.extraArgs.length > 0) {
    result.push(...args.extraArgs);
  }
  return result;
}

async function killChildScoped(child: ChildProcess, gracefulMs = 5_000): Promise<void> {
  if (describeChildExit(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // already exited between the check and the kill
  }
  await new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      if (!describeChildExit(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      resolveExit();
    }, gracefulMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

function formatDiagnostics(d: DaemonReadinessDiagnostics): string {
  const lines: string[] = [];
  lines.push(`endpoint=${JSON.stringify(d.endpoint)}`);
  lines.push(
    `runtime=${d.runtime} pid=${String(d.pid ?? "<none>")} ` +
      `exitCode=${d.exitCode === null ? "<running>" : String(d.exitCode)} ` +
      `signal=${d.signal ?? "<none>"}`,
  );
  lines.push(`stdout-tail:\n${d.stdoutTail || "<empty>"}`);
  lines.push(`stderr-tail:\n${d.stderrTail || "<empty>"}`);
  lines.push(`last-health=${JSON.stringify(d.lastHealth)}`);
  lines.push(`last-cache-status=${JSON.stringify(d.lastCacheStatus)}`);
  return lines.join("\n");
}

/**
 * Start a real daemon child process scoped to a `TestDaemonProject`.
 *
 * Returns a `StartedTestDaemon` whose `stop()` targets only this child
 * handle. Use `registerCleanup` (vitest `onTestFinished`, Playwright
 * teardown) to ensure cleanup survives assertion failures during the
 * readiness wait.
 */
export async function startTestDaemon(
  project: TestDaemonProject,
  opts: StartTestDaemonOptions = {},
): Promise<StartedTestDaemon> {
  const runtime: DaemonTestRuntime = opts.runtime ?? "node";

  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error(
      `Daemon entry not found at ${DAEMON_ENTRY}. ` +
        "Run 'npm run build:daemon' before invoking startTestDaemon().",
    );
  }

  const bindHost = normalizeDaemonHost(opts.bindHost ?? DEFAULT_BIND_HOST);
  // Choose a sensible host for port allocation: wildcard binds need a real
  // local interface to listen on, so probe via the loopback that maps to
  // that family.
  const portProbeHost =
    bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
  const port = opts.port ?? (await allocateTestDaemonPort(portProbeHost));
  const endpoint = resolveDaemonEndpoint({
    bindHost,
    connectHost: opts.connectHost ?? undefined,
    port,
  });

  const env = buildDaemonChildEnv({
    runtime,
    isolatedHome: project.isolatedHome,
    webUiDir: project.webUiDir,
    extraEnv: opts.extraEnv,
  });

  const args = buildDaemonArgs({
    port,
    kspecDir: project.tempDir,
    runtime,
    bindHost,
    connectHost: opts.connectHost,
    hostExplicitlyConfigured: opts.hostExplicitlyConfigured ?? false,
    extraArgs: opts.extraArgs ?? [],
  });

  const child = spawn(runtime, args, {
    cwd: project.tempDir,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const stdoutBuf = makeTailBuffer();
  const stderrBuf = makeTailBuffer();
  child.stdout?.on("data", (chunk: Buffer) => stdoutBuf.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrBuf.append(chunk));

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await killChildScoped(child);
  };

  // Register cleanup BEFORE the readiness wait so an assertion failure or
  // timeout inside readiness still tears down the spawned child.
  if (opts.registerCleanup) {
    opts.registerCleanup(stop);
  }

  const probeContext: ReadinessProbeContext = {
    endpoint,
    child,
    stdoutTail: () => stdoutBuf.text(),
    stderrTail: () => stderrBuf.text(),
  };

  const readiness: ReadinessMode = opts.readiness ?? { mode: "health-and-cache" };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  const healthState: HealthProbeState = { observed: null, errorMessage: null };
  const cacheState: CacheProbeState = { observed: null, errorMessage: null };

  try {
    if (readiness.mode === "custom") {
      await waitForStartup(
        `daemon at ${endpoint.apiUrl}`,
        () => readiness.probe(probeContext),
        { timeoutMs, intervalMs },
      );
    } else {
      await waitForStartup(
        `daemon health at ${endpoint.apiUrl}`,
        () => probeHealth(probeContext, healthState),
        { timeoutMs, intervalMs },
      );
      if (readiness.mode === "health-and-cache") {
        await waitForStartup(
          `daemon cache ready at ${endpoint.apiUrl}`,
          () => probeCacheReady(probeContext, cacheState),
          { timeoutMs, intervalMs },
        );
      }
    }
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const diagnostics: DaemonReadinessDiagnostics = {
      endpoint: {
        apiUrl: endpoint.apiUrl,
        wsUrl: endpoint.wsUrl,
        port: endpoint.port,
        bindHost: endpoint.bindHost,
        connectHost: endpoint.connectHost,
      },
      runtime,
      pid: child.pid,
      exitCode: child.exitCode,
      signal: child.signalCode,
      stdoutTail: stdoutBuf.text(),
      stderrTail: stderrBuf.text(),
      lastHealth: healthState.observed
        ? healthState.observed
        : healthState.errorMessage
          ? { error: healthState.errorMessage }
          : null,
      lastCacheStatus: cacheState.observed
        ? cacheState.observed
        : cacheState.errorMessage
          ? { error: cacheState.errorMessage }
          : null,
      cause,
    };
    await stop();
    throw new DaemonReadinessError(diagnostics);
  }

  return {
    endpoint,
    runtime,
    child,
    pid: child.pid,
    apiUrl: endpoint.apiUrl,
    wsUrl: endpoint.wsUrl,
    port: endpoint.port,
    stdoutTail: () => stdoutBuf.text(),
    stderrTail: () => stderrBuf.text(),
    stop,
  };
}
