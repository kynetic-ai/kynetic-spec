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
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { cp as fsCp } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { hostname, tmpdir } from "node:os";
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
import { boundedDaemonFetch } from "./daemon-fetch.js";
import { stopChildProcessBounded } from "./process-stop.js";

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
const PORT_START_LOCK_FILE = join(tmpdir(), "kspec-test-daemon-port-start.lock");
const PORT_START_LOCK_MIN_TIMEOUT_MS = 120_000;
const PORT_START_LOCK_POLL_INTERVAL_MS = 25;
// Stale-holder detection must not race a fresh acquirer that has just created
// the lock file but not yet finished writing owner info. The acquirer writes
// the owner file in the same synchronous tick as creating the lock, so a
// short grace window is sufficient.
const PORT_START_LOCK_OWNER_GRACE_MS = 100;

// ── Public types ──────────────────────────────────────────────────────

export type DaemonTestRuntime = DaemonRuntime;

/**
 * Named stages observable by `__testStageHook` during `createTestDaemonProject`.
 * Each stage corresponds to a point at which the project has just claimed a
 * new owned resource (temp dir, shadow worktree, isolated HOME). Contract
 * tests use the hook to simulate a later-step failure and assert that
 * already-owned resources are cleaned up.
 */
export type CreateTestDaemonProjectStage =
  | "after-temp-dir"
  | "after-shadow-detection"
  | "after-isolated-home";

export interface CreateTestDaemonProjectOptions {
  /** Source directory copied into the project's `.kspec/`. Defaults to e2e fixtures. */
  fixturesSource?: string;
  /** When true, do not copy any fixture files into .kspec. */
  skipFixtures?: boolean;
  /** Override WEB_UI_DIR. Defaults to dist/web-ui or packages/web-ui/build if present. */
  webUiDir?: string | null;
  /**
   * Test-only seam: invoked synchronously after each named setup stage so
   * contract tests can simulate a later-step failure by throwing. The hook
   * must remain non-behavioral: it observes the stage label only and does
   * not alter the surrounding flow except by re-throwing. Production callers
   * must not pass this. Pairs with the
   * `ac-setup-failure-cleans-owned-resources` regression coverage.
   */
  __testStageHook?: (stage: CreateTestDaemonProjectStage) => void;
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
  /**
   * Test-only seam: override the binary path passed to `spawn()` while keeping
   * `runtime` for env construction (NODE_ENV vs BUN_ENV) and diagnostic
   * reporting. Production callers must not pass this. Contract tests use it
   * to simulate process launch failures (e.g. ENOENT from a nonexistent
   * binary path) without depending on whether a real system runtime is
   * actually missing on the host, and to substitute a synthetic
   * uncooperative-child script when driving the bounded-stop contract.
   */
  __testBinaryOverride?: string;
  /**
   * Test-only seam: invoked synchronously immediately after the daemon
   * child is spawned and before `registerCleanup` runs. Exposes the live
   * child handle and resolved endpoint so contract tests can deterministically
   * observe the just-spawned daemon (e.g. to assert it is stopped after a
   * subsequent failure). Production callers must not pass this. The seam
   * must remain non-behavioral: it must not catch the registration error,
   * invoke `stop()`, alter startup ordering, or implement cleanup behavior.
   */
  __testObserveSpawn?: (observation: {
    child: ChildProcess;
    endpoint: DaemonResolvedEndpoint;
  }) => void;
  /**
   * Test-only seam: when set, the fixture-owned stop function still kills the
   * spawned child via the default `killChildScoped` path AND then throws this
   * error so contract tests can exercise the cleanup-also-fails scenarios for
   * `@daemon-test-teardown-boundedness ac-cleanup-errors-preserve-primary-failure`.
   * The throw happens exactly once (gated by the same `stopped` flag that
   * guards the kill) so the test-finished cleanup hook can call `stop()`
   * idempotently. Production callers must not pass this.
   */
  __testStopFailure?: Error;
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

export type DaemonEndpointObservation = { status: number; body: string } | { error: string };

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
  /** Final sample of `/api/health` taken at failure time. */
  lastHealth: DaemonEndpointObservation;
  /** Final sample of `/api/debug/cache-status` taken at failure time. */
  lastCacheStatus: DaemonEndpointObservation;
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
export async function isDaemonRuntimeAvailable(runtime: DaemonTestRuntime): Promise<boolean> {
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

function computePortStartLockTimeout(opts: StartTestDaemonOptions): number {
  const readiness = opts.readiness ?? { mode: "health-and-cache" };
  const readinessStages = readiness.mode === "health-and-cache" ? 2 : 1;
  const readinessBudgetMs = (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * readinessStages;
  return Math.max(PORT_START_LOCK_MIN_TIMEOUT_MS, readinessBudgetMs + 15_000);
}

interface PortStartLockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
}

function readPortStartLockOwner(lockPath: string): PortStartLockOwner | null {
  let contents: string;
  try {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- Lock owner info written by acquireTestDaemonPortStartLock; not project source.
    contents = readFileSync(lockPath, "utf-8");
  } catch {
    return null;
  }
  if (contents.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { pid?: unknown }).pid !== "number" ||
    typeof (parsed as { hostname?: unknown }).hostname !== "string" ||
    typeof (parsed as { startedAt?: unknown }).startedAt !== "number"
  ) {
    return null;
  }
  return parsed as PortStartLockOwner;
}

function isPortStartLockOwnerAlive(owner: PortStartLockOwner): boolean {
  if (owner.hostname !== hostname()) {
    // Foreign hostname (shared tmpfs across hosts is unusual but possible).
    // We cannot inspect remote PIDs, so conservatively treat the owner as
    // alive and let the deadline govern.
    return true;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to reclaim a stale lock left behind by a crashed prior holder.
 * Only fires after the contention grace window, so this never races a fresh
 * acquirer that has just created the lock file but is mid-write of its owner
 * info — `writeFileSync` finishes in microseconds, far shorter than the
 * grace window. Reclamation handles three cases:
 *
 *   - Lock file holds a dead PID → reclaim.
 *   - Lock path has unreadable / unparseable owner info → reclaim (covers
 *     legacy mkdir-only directory leftovers from before this helper wrote
 *     owner content).
 *   - Lock holder is alive on this host → leave alone.
 *
 * Returns true when the caller should retry acquisition.
 */
function tryReclaimStalePortStartLock(lockPath: string): boolean {
  const owner = readPortStartLockOwner(lockPath);
  if (owner !== null && isPortStartLockOwnerAlive(owner)) return false;

  // Re-read just before removal so we only evict the holder we observed.
  // Skip the cross-check when the original read returned null (unreadable
  // path / legacy directory leftover) — in that case there is nothing to
  // compare against and the recovery semantics are "force-clear".
  if (owner !== null) {
    const currentOwner = readPortStartLockOwner(lockPath);
    if (
      currentOwner !== null &&
      (currentOwner.pid !== owner.pid || currentOwner.startedAt !== owner.startedAt)
    ) {
      return false;
    }
  }

  // rmSync handles both files (the current implementation) and directories
  // (legacy mkdir-only leftovers from previous helper versions).
  try {
    rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Another worker may have already cleared the path; the caller will
    // retry the writeFileSync step regardless.
  }
  return true;
}

const activePortStartLockReleases = new Set<() => void>();
let portStartLockExitHandlersRegistered = false;

function releaseActivePortStartLocks(): void {
  for (const release of activePortStartLockReleases) {
    try {
      release();
    } catch {
      // Best effort during process teardown.
    }
  }
}

/**
 * Build the signal handler installed for SIGINT/SIGTERM/SIGHUP cleanup. The
 * handler is named so it can remove itself before re-raising — without
 * removeListener the re-raise re-enters this same handler (Node suppresses
 * default termination while a listener is installed) and the process loops
 * indefinitely instead of reaching a bounded terminal outcome.
 *
 * Extracted so contract tests can exercise the handler shape in-process by
 * driving `release` and `reRaise` callables instead of actually sending
 * signals to the test runner.
 */
export function __createPortStartLockSignalHandler(
  signal: NodeJS.Signals,
  release: () => void = releaseActivePortStartLocks,
  reRaise: (sig: NodeJS.Signals) => void = (sig) => {
    process.kill(process.pid, sig);
  },
): () => void {
  const handler = (): void => {
    process.removeListener(signal, handler);
    release();
    // With our handler removed, re-raising hits default disposition unless
    // another listener (e.g. the host test runner) is installed for this
    // signal. In that case the other listener owns termination semantics.
    reRaise(signal);
  };
  return handler;
}

function registerPortStartLockExitHandlers(): void {
  if (portStartLockExitHandlersRegistered) return;
  portStartLockExitHandlersRegistered = true;
  // Best-effort cleanup on normal exit. If the process is SIGKILLed there is
  // no opportunity to run this; subsequent acquirers fall back to the
  // stale-holder recovery path above.
  process.on("exit", releaseActivePortStartLocks);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, __createPortStartLockSignalHandler(signal));
  }
}

/**
 * Test-only seam: allows the contract regressions to exercise the lock
 * acquisition / stale-recovery path against an isolated lock file rather than
 * the shared global one. Production callers omit `__testLockPath` and the
 * helper coordinates through `PORT_START_LOCK_FILE`.
 */
export interface AcquireTestDaemonPortStartLockOptions {
  __testLockPath?: string;
}

export async function acquireTestDaemonPortStartLock(
  timeoutMs = PORT_START_LOCK_MIN_TIMEOUT_MS,
  opts: AcquireTestDaemonPortStartLockOptions = {},
): Promise<() => void> {
  const lockPath = opts.__testLockPath ?? PORT_START_LOCK_FILE;
  const deadline = Date.now() + timeoutMs;
  let firstContentionAt: number | null = null;

  while (true) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          startedAt: Date.now(),
        }),
        { flag: "wx" },
      );
      const ownerSnapshot = readPortStartLockOwner(lockPath);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        activePortStartLockReleases.delete(release);
        // Only unlink if we still appear to be the recorded owner; a
        // takeover by stale-recovery in a parallel worker should not have
        // its file deleted here.
        const current = readPortStartLockOwner(lockPath);
        if (
          current === null ||
          ownerSnapshot === null ||
          (current.pid === ownerSnapshot.pid && current.startedAt === ownerSnapshot.startedAt)
        ) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Best effort — file may have been reclaimed concurrently.
          }
        }
      };
      activePortStartLockReleases.add(release);
      registerPortStartLockExitHandlers();
      return release;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") throw error;

      const now = Date.now();
      if (firstContentionAt === null) firstContentionAt = now;
      const contendedFor = now - firstContentionAt;

      if (now >= deadline) {
        // Last-chance stale recovery before surfacing the timeout.
        if (tryReclaimStalePortStartLock(lockPath)) continue;
        const owner = readPortStartLockOwner(lockPath);
        const ownerSuffix =
          owner !== null
            ? ` (held by pid=${owner.pid} on ${owner.hostname}, started ${
                now - owner.startedAt
              }ms ago)`
            : "";
        throw new Error(
          `Timed out waiting ${timeoutMs}ms for daemon port startup lock at ${lockPath}${ownerSuffix}`,
          { cause: error },
        );
      }

      // Give a brief grace window so we never race-evict an acquirer that
      // has just created the file but is still writing its owner info. Past
      // the grace window, attempt stale recovery on every tick — the
      // recovery path itself short-circuits if the lock holder is alive.
      if (contendedFor >= PORT_START_LOCK_OWNER_GRACE_MS) {
        if (tryReclaimStalePortStartLock(lockPath)) continue;
      }

      await new Promise<void>((resolveSleep) =>
        setTimeout(resolveSleep, PORT_START_LOCK_POLL_INTERVAL_MS),
      );
    }
  }
}

export async function reserveTestDaemonPort(
  port: number,
  host = DEFAULT_BIND_HOST,
): Promise<() => Promise<void>> {
  return await new Promise<() => Promise<void>>((resolveOk, rejectErr) => {
    const server = createNetServer();
    server.once("error", rejectErr);
    server.listen(port, host, () => {
      server.removeListener("error", rejectErr);
      let released = false;
      resolveOk(async () => {
        if (released) return;
        released = true;
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((err) => (err ? rejectClose(err) : resolveClose()));
        });
      });
    });
  });
}

function findFirstWebUiBuild(): string | null {
  for (const candidate of WEB_UI_BUILD_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Error preservation ────────────────────────────────────────────────

/**
 * Attach a secondary cleanup failure to a primary error. Sets
 * `primary.cause` to the cleanup error and appends the cleanup message
 * to `primary.message` so both `error.cause` walkers and plain-string
 * log consumers can observe the secondary failure. The suffix is only
 * appended once so reentry through nested cleanup boundaries (e.g. an
 * inner helper that already attached the same cleanup error) does not
 * stack duplicate suffixes. Any existing `primary.cause` is preserved
 * by chaining it under `cleanup.cause`.
 */
export function attachCleanupFailure(primary: Error, cleanup: Error): void {
  const suffix = `\n[cleanup also failed: ${cleanup.message}]`;
  if (!primary.message.includes(suffix)) {
    primary.message = `${primary.message}${suffix}`;
  }
  const existing = (primary as { cause?: unknown }).cause;
  if (existing instanceof Error && existing !== cleanup) {
    (cleanup as { cause?: unknown }).cause ??= existing;
  }
  (primary as { cause?: unknown }).cause = cleanup;
}

/** Coerce an unknown thrown value to an Error. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// ── Project fixture ───────────────────────────────────────────────────

/**
 * Build a temp project workspace for a daemon-backed test.
 *
 * The resulting project directory contains a `.kspec/` shadow worktree
 * pointer, an isolated HOME/config tree, and (optionally) a fixture data
 * tree copied into `.kspec/`. The default fixture source is the e2e
 * fixtures dir, which already has the shape the daemon expects.
 *
 * Setup-failure cleanup: each owned resource is registered on a cleanup
 * stack as soon as it is claimed. If a later setup step (including the
 * test-only `__testStageHook`) throws, the stack runs in reverse so the
 * temp dir and any sibling owned resources are released before the error
 * propagates. The returned `cleanup()` shares the same stack and remains
 * idempotent across the success path and post-failure teardown.
 */
export async function createTestDaemonProject(
  opts: CreateTestDaemonProjectOptions = {},
): Promise<TestDaemonProject> {
  // Reverse-order cleanup stack: each step pushes its release callback
  // before running the next step. If a later step throws, the stack
  // unwinds in reverse so child resources are released before their
  // parent. The first cleanup error is surfaced; subsequent failures
  // are best-effort so one leak does not mask another.
  const cleanups: Array<() => Promise<void>> = [];
  let cleanedUp = false;

  const runCleanups = async (): Promise<Error | null> => {
    if (cleanedUp) return null;
    cleanedUp = true;
    let cleanupError: Error | null = null;
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try {
        await cleanups[i]();
      } catch (error) {
        cleanupError ??= toError(error);
      }
    }
    return cleanupError;
  };

  try {
    const tempDir = await createTempDir("kspec-daemon-fixture-");
    cleanups.push(() => cleanupTempDir(tempDir));
    opts.__testStageHook?.("after-temp-dir");

    const kspecDir = join(tempDir, ".kspec");
    mkdirSync(kspecDir, { recursive: true });

    // setupShadowDetection initializes git AND writes the worktree pointer
    // .kspec/.git → .git/worktrees/-kspec, so initContext() / daemon project
    // detection resolves spec data from .kspec/. The shadow-detection state
    // lives entirely under tempDir, so removing tempDir releases it.
    await setupShadowDetection(tempDir);
    opts.__testStageHook?.("after-shadow-detection");

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
    opts.__testStageHook?.("after-isolated-home");

    const webUiDir = opts.webUiDir === undefined ? findFirstWebUiBuild() : (opts.webUiDir ?? null);

    return {
      tempDir,
      kspecDir,
      isolatedHome,
      webUiDir,
      cleanup: async () => {
        const cleanupError = await runCleanups();
        if (cleanupError) throw cleanupError;
      },
    };
  } catch (primary) {
    const cleanupError = await runCleanups();
    if (cleanupError) {
      const err = toError(primary);
      attachCleanupFailure(err, cleanupError);
      throw err;
    }
    throw primary;
  }
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

const DIAGNOSTIC_SAMPLE_TIMEOUT_MS = 2_000;

// Total budget for retrying transient diagnostic samples while the child
// daemon is still alive. Under heavy parallel load (full-suite runs, slow
// CI), a daemon spawned with a short readiness timeout may not have bound
// to its port by the time the failure-path catch samples /api/health and
// /api/debug/cache-status — a single ECONNREFUSED then masquerades as a
// dead daemon in the diagnostic bundle. Retrying for up to 5s on transient
// fetch failures gives the kernel-level bind time to land while keeping
// the failure path bounded. The retry stops immediately when the child is
// observably dead (exitCode/signalCode set, or pid undefined from a spawn
// the OS rejected) so launch failures still surface promptly.
const DIAGNOSTIC_SAMPLE_RETRY_BUDGET_MS = 5_000;
const DIAGNOSTIC_SAMPLE_RETRY_INTERVAL_MS = 100;

// Per-probe HTTP budget. Each probe targets a freshly bound localhost
// endpoint, so a healthy response should land in <100ms; bound to 2s so a
// daemon that binds but stops responding mid-request fails the probe instead
// of hanging the readiness wait — `waitForStartup` only re-checks its budget
// between probe iterations.
const PROBE_FETCH_TIMEOUT_MS = 2_000;

interface BoundedProbeFetchResult {
  ok: boolean;
  status: number;
  body: string;
}

async function boundedProbeFetch(url: string): Promise<BoundedProbeFetchResult> {
  const response = await boundedDaemonFetch(url, { timeoutMs: PROBE_FETCH_TIMEOUT_MS });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
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

/**
 * Treat a child as still potentially reachable when it has a pid the OS
 * accepted and neither an exit code nor a fatal signal has been observed.
 * `pid === undefined` indicates the OS rejected the spawn outright (e.g.
 * ENOENT) — there is no process to bind, so retrying samples is futile.
 */
function isChildPotentiallyReachable(child: ChildProcess | null | undefined): boolean {
  if (!child) return false;
  if (child.pid === undefined) return false;
  return child.exitCode === null && child.signalCode === null;
}

interface SampleEndpointDiagnosticOptions {
  /**
   * Live child handle. When provided and the child is still potentially
   * reachable (see `isChildPotentiallyReachable`), transient fetch failures
   * are retried up to `budgetMs`. When omitted or the child has exited,
   * the function falls back to a single non-retried sample.
   */
  child?: ChildProcess | null;
  /** Total retry budget. Defaults to DIAGNOSTIC_SAMPLE_RETRY_BUDGET_MS. */
  budgetMs?: number;
  /** Interval between retries. Defaults to DIAGNOSTIC_SAMPLE_RETRY_INTERVAL_MS. */
  intervalMs?: number;
}

/**
 * Diagnostic sample of a daemon endpoint at failure time. Each fetch is
 * bounded by `DIAGNOSTIC_SAMPLE_TIMEOUT_MS` so the failure-path catch never
 * hangs on an unresponsive daemon. Errors are captured into the observation
 * rather than thrown so the caller can always assemble a complete bundle.
 *
 * When the caller passes a live `child` handle and the child is still
 * potentially reachable (pid set, exitCode/signalCode null), a transient
 * fetch failure (typically ECONNREFUSED before the daemon binds, or a
 * timeout while the daemon is still booting) is retried up to `budgetMs`.
 * This eliminates the race between a short readiness timeout firing and the
 * kernel completing the daemon's port bind: without retry, the bundle would
 * report `{error: "fetch failed"}` for a daemon that the next millisecond
 * would have responded to. The retry stops as soon as a sample succeeds, the
 * child is observably dead, or the budget is exhausted.
 */
async function sampleEndpointDiagnostic(
  url: string,
  opts: SampleEndpointDiagnosticOptions = {},
): Promise<DaemonEndpointObservation> {
  const budgetMs = opts.budgetMs ?? DIAGNOSTIC_SAMPLE_RETRY_BUDGET_MS;
  const intervalMs = opts.intervalMs ?? DIAGNOSTIC_SAMPLE_RETRY_INTERVAL_MS;
  const deadline = Date.now() + budgetMs;
  let lastError: unknown = new Error("no diagnostic sample taken");

  while (true) {
    try {
      const response = await boundedDaemonFetch(url, {
        timeoutMs: DIAGNOSTIC_SAMPLE_TIMEOUT_MS,
      });
      const body = await response.text();
      return { status: response.status, body };
    } catch (error) {
      lastError = error;
    }
    // Retry only while the child still has a chance of binding. No handle
    // (or a handle for a child the OS never started / has reaped) means
    // there is no point waiting longer.
    if (!isChildPotentiallyReachable(opts.child)) break;
    if (Date.now() + intervalMs >= deadline) break;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return { error: lastError instanceof Error ? lastError.message : String(lastError) };
}

async function probeHealth(ctx: ReadinessProbeContext): Promise<StartupProbeResult> {
  const exited = describeChildExit(ctx.child);
  if (exited) {
    return {
      ok: false,
      details: `${exited}; stderr-tail=${ctx.stderrTail() || "<empty>"}`,
    };
  }
  try {
    const response = await boundedProbeFetch(`${ctx.endpoint.apiUrl}/api/health`);
    const ok = response.ok && response.body.includes('"status":"ok"');
    return {
      ok,
      details: `health status=${response.status} body=${response.body || "<empty>"}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, details: `health fetch error=${message}` };
  }
}

/**
 * Cache-readiness probe.
 *
 * Uses /api/debug/cache-status (not /api/tasks) so the probe reflects the
 * actual entity-cache state per project. The disk-fallback in /api/tasks
 * returns cache_status="ready" before registerEntityCache() runs (because
 * cacheDomainState=undefined maps to "ready"); polling /api/tasks would
 * therefore match prematurely during the daemon-startup window between
 * server.listen() and onProjectRegistered() registering the cache. The
 * test's first cache_status assertion would then race the subsequent
 * loadAll() that flips the cache to "loading".
 *
 * /api/debug/cache-status reports `domains: null` until the cache is
 * registered, so this probe rejects the premature-ready window and only
 * accepts after the tasks domain has actually transitioned to "ready".
 */
async function probeCacheReady(ctx: ReadinessProbeContext): Promise<StartupProbeResult> {
  const exited = describeChildExit(ctx.child);
  if (exited) {
    return {
      ok: false,
      details: `${exited}; stderr-tail=${ctx.stderrTail() || "<empty>"}`,
    };
  }
  try {
    const response = await boundedProbeFetch(`${ctx.endpoint.apiUrl}/api/debug/cache-status`);
    if (!response.ok) {
      return {
        ok: false,
        details: `cache-status http=${response.status} body=${response.body || "<empty>"}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return {
        ok: false,
        details: `cache-status non-JSON body=${response.body || "<empty>"}`,
      };
    }
    const projects = (parsed as { projects?: unknown }).projects;
    if (!Array.isArray(projects) || projects.length === 0) {
      return {
        ok: false,
        details: "cache-status reports no registered projects yet",
      };
    }
    type CacheStatusProject = {
      path?: string;
      domains?: Record<string, { state?: string }> | null;
    };
    // Test daemons spawn exactly one startup project per child, so the
    // first registered project is the one we polled for. If the daemon
    // has not yet called registerEntityCache(), `domains` is null — that
    // is the disk-fallback window the probe must reject.
    const project = projects[0] as CacheStatusProject;
    if (!project.domains) {
      return {
        ok: false,
        details: `cache not yet registered for project=${project.path ?? "<unknown>"}`,
      };
    }
    const tasksState = project.domains.tasks?.state;
    if (tasksState !== "ready") {
      return {
        ok: false,
        details: `cache tasks state=${tasksState ?? "<missing>"} project=${project.path ?? "<unknown>"}`,
      };
    }
    return {
      ok: true,
      details: `cache ready: project=${project.path ?? "<unknown>"} tasks=ready`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, details: `cache-status fetch error=${message}` };
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

/**
 * Stop the daemon child via the shared bounded stop primitive: SIGTERM,
 * wait for observed exit on the handle, escalate to SIGKILL on timeout,
 * then wait again for the resulting exit observation. The wait treats
 * `signalCode` as an exit indicator equivalent to `exitCode` so a child
 * killed by signal does not block cleanup. Throws BoundedProcessStopError
 * if termination cannot be observed even after escalation — cleanup never
 * reports success while the child is still observably alive.
 */
async function killChildScoped(child: ChildProcess, gracefulMs = 5_000): Promise<void> {
  await stopChildProcessBounded(child, { gracefulMs, label: "test daemon child" });
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
  const releasePortStartLock =
    opts.port === undefined
      ? await acquireTestDaemonPortStartLock(computePortStartLockTimeout(opts))
      : null;
  let started: StartedTestDaemon;
  try {
    started = await startTestDaemonUnlocked(project, opts);
  } catch (primary) {
    if (releasePortStartLock) {
      try {
        releasePortStartLock();
      } catch (cleanupError) {
        const err = toError(primary);
        attachCleanupFailure(err, toError(cleanupError));
        throw err;
      }
    }
    throw primary;
  }

  if (releasePortStartLock) {
    try {
      releasePortStartLock();
    } catch (cleanupError) {
      const err = toError(cleanupError);
      try {
        await started.stop();
      } catch (stopError) {
        attachCleanupFailure(err, toError(stopError));
      }
      throw err;
    }
  }

  return started;
}

async function startTestDaemonUnlocked(
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
  const portProbeHost = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
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

  const spawnBinary = opts.__testBinaryOverride ?? runtime;
  const child = spawn(spawnBinary, args, {
    cwd: project.tempDir,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const stdoutBuf = makeTailBuffer();
  const stderrBuf = makeTailBuffer();
  child.stdout?.on("data", (chunk: Buffer) => stdoutBuf.append(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrBuf.append(chunk));

  // Capture spawn-time errors (e.g. ENOENT from a bad runtime path) before
  // they propagate as uncaughtException. The readiness orchestration races
  // the readiness wait against this signal so launch failures surface as a
  // structured DaemonReadinessError with a launch-related cause instead of
  // a misleading "Timed out waiting for daemon health" message.
  let launchError: Error | null = null;
  let signalLaunchError: ((err: Error) => void) | null = null;
  child.once("error", (err: Error) => {
    launchError = err;
    signalLaunchError?.(err);
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // killChildScoped routes through the shared bounded-stop primitive.
    // The primitive short-circuits when child.pid is undefined (the OS
    // never started the child — e.g. spawn ENOENT / EACCES — so there is
    // no pid to signal and no 'exit' event will fire) so cleanup stays
    // bounded for launch-failure callers without an extra outer guard.
    await killChildScoped(child);
    // Test-only failure injection: see `__testStopFailure` JSDoc. Gated by
    // the `stopped` flag above, so a subsequent test-finished cleanup call
    // is a no-op and does not throw again.
    if (opts.__testStopFailure) {
      throw opts.__testStopFailure;
    }
  };

  // Test-only observer seam: lets contract tests capture the live child
  // handle and resolved endpoint immediately after spawn — before
  // registerCleanup runs — so they can deterministically observe the
  // just-spawned daemon when a later step fails. Kept purely synchronous
  // and non-behavioral; production callers do not pass __testObserveSpawn.
  if (opts.__testObserveSpawn) {
    opts.__testObserveSpawn({ child, endpoint });
  }

  // Register cleanup BEFORE the readiness wait so an assertion failure or
  // timeout inside readiness still tears down the spawned child. The
  // caller-provided hook is foreign code (a Vitest/Playwright lifecycle
  // wrapper or an ad-hoc test fixture), so it can throw — once spawn() has
  // returned, the fixture owns the child and must stop it before surfacing
  // a registration failure. Otherwise the child leaks: registerCleanup
  // never registered the stop handle, the readiness try/catch below is
  // never entered, and the caller has no reference to kill.
  if (opts.registerCleanup) {
    try {
      opts.registerCleanup(stop);
    } catch (registrationError) {
      try {
        await stop();
      } catch (stopError) {
        // The registration failure is the primary cause — the caller
        // needs to diagnose the misuse that triggered this path. The
        // stop failure is attached as supplementary context.
        const primary = toError(registrationError);
        attachCleanupFailure(primary, toError(stopError));
        throw primary;
      }
      throw registrationError;
    }
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

  const readinessOp = async (): Promise<void> => {
    if (readiness.mode === "custom") {
      await waitForStartup(`daemon at ${endpoint.apiUrl}`, () => readiness.probe(probeContext), {
        timeoutMs,
        intervalMs,
      });
    } else {
      await waitForStartup(`daemon health at ${endpoint.apiUrl}`, () => probeHealth(probeContext), {
        timeoutMs,
        intervalMs,
      });
      if (readiness.mode === "health-and-cache") {
        await waitForStartup(
          `daemon cache ready at ${endpoint.apiUrl}`,
          () => probeCacheReady(probeContext),
          { timeoutMs, intervalMs },
        );
      }
    }
  };

  try {
    const readinessPromise = readinessOp();
    const launchFailurePromise = new Promise<never>((_, reject) => {
      if (launchError) {
        reject(launchError);
        return;
      }
      signalLaunchError = reject;
    });
    // Suppress unhandled-rejection warnings on whichever promise loses the
    // race: if launch fails first, readinessPromise will eventually time
    // out; if readiness fails first, launchFailurePromise stays pending
    // until the test exits. The race below still observes the original
    // rejection because Promise.race watches the original promises.
    readinessPromise.catch(() => {});
    launchFailurePromise.catch(() => {});
    await Promise.race([readinessPromise, launchFailurePromise]);
  } catch (error) {
    const baseCause = error instanceof Error ? error.message : String(error);
    // When the OS rejects the spawn (ENOENT, EACCES, ...), prefer the
    // launch-error message so the diagnostic mentions the launch failure
    // (spawn / ENOENT / the failed binary path) instead of falling back to
    // the readiness timeout message that races alongside it.
    const cause = launchError ? `process launch failed: ${launchError.message}` : baseCause;
    // Always sample the diagnostic endpoints at failure time, regardless of
    // which readiness mode ran. Custom probes never touch /api/health or
    // /api/debug/cache-status during the wait, so the bundle would otherwise
    // be empty for them — and ac-readiness-diagnostics requires both fields.
    // Pass the live child handle so transient fetch failures (typically
    // ECONNREFUSED for a daemon that has not finished binding when a short
    // readiness timeout fires) are retried while the child is still
    // potentially reachable. Launch failures (no pid, child already dead)
    // skip retry and surface the captured error immediately.
    const sampleChild = launchError ? null : child;
    const [lastHealth, lastCacheStatus] = await Promise.all([
      sampleEndpointDiagnostic(`${endpoint.apiUrl}/api/health`, { child: sampleChild }),
      sampleEndpointDiagnostic(`${endpoint.apiUrl}/api/debug/cache-status`, {
        child: sampleChild,
      }),
    ]);
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
      lastHealth,
      lastCacheStatus,
      cause,
    };
    const readinessError = new DaemonReadinessError(diagnostics);
    // Run cleanup defensively: a stop() throw must not replace the
    // actionable readiness diagnostic as the surfaced primary error. The
    // cleanup failure is attached as supplementary context (cause +
    // message suffix) so callers can still observe it.
    try {
      await stop();
    } catch (stopError) {
      attachCleanupFailure(readinessError, toError(stopError));
    }
    throw readinessError;
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
