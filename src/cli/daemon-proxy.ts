/**
 * Daemon Proxy Detection and Command Routing
 *
 * Detects whether a kspec daemon is running and routes CLI commands
 * through it when available. The daemon becomes the single writer,
 * eliminating coherence issues between CLI mutations and daemon state.
 *
 * Detection is cached per CLI process lifetime — no re-detection per subcommand.
 *
 * AC: @cli-daemon-proxy ac-direct-fallback, ac-force-direct,
 *     ac-force-proxy, ac-transparent-output, ac-mutation-coherence,
 *     ac-read-from-cache, ac-timeout-fallback, ac-timeout-mutation-error
 * AC: @daemon-proxy-detection ac-legacy-port-file-fallback, ac-fast-detection,
 *     ac-project-registered
 */

import { PidFileManager, isNoDaemonModeEnabled } from "./pid-utils.js";

// ── Types ──────────────────────────────────────────────────────────

/** Result of daemon detection. */
export type DaemonDetectionResult =
  | { available: true; port: number }
  | { available: false; reason: string };

/** Result of proxied command execution. */
export interface ProxyCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ── Configuration ──────────────────────────────────────────────────

/** Timeout for health check in milliseconds. */
const HEALTH_CHECK_TIMEOUT_MS = 200;

/** Timeout for proxied read-only commands. */
const READ_COMMAND_TIMEOUT_MS = 30_000;

/** Timeout for proxied mutating commands. */
const MUTATION_COMMAND_TIMEOUT_MS = 60_000;

/** Timeout for project registration before command routing. */
const REGISTRATION_TIMEOUT_MS = 5_000;

// ── Module-Level Cached State ──────────────────────────────────────

/**
 * Cached detection result for the CLI process lifetime.
 * Set once by detectDaemon(), consumed by shouldProxyCommand().
 *
 * AC: @cli-daemon-proxy — detection result cached for CLI process lifetime
 */
let cachedDetection: DaemonDetectionResult | null = null;

// ── Detection ──────────────────────────────────────────────────────

/**
 * Detect whether a daemon is running and reachable.
 *
 * 1. Read legacy daemon.port file — if missing, fail fast (< 50ms)
 * 2. Send health check — if connection refused, fail fast (< 50ms)
 * 3. If health check doesn't respond, timeout within 200ms
 *
 * Note: This implementation only handles the legacy port-file fallback path.
 * The metadata-driven path (ac-connection-metadata-check, the metadata-keyed
 * ac-auto-detect/ac-health-timeout) is added by the shared endpoint resolver
 * task and the centralize-cli-daemon-clients task.
 *
 * AC: @daemon-proxy-detection ac-legacy-port-file-fallback — reads legacy daemon.port file and health-checks 127.0.0.1:port
 * AC: @daemon-proxy-detection ac-fast-detection — completes within 50ms on missing port/refused
 */
export async function detectDaemon(): Promise<DaemonDetectionResult> {
  // Return cached result if available
  if (cachedDetection !== null) {
    return cachedDetection;
  }

  const pidManager = new PidFileManager();

  // Step 1: Read port file
  let port: number;
  try {
    port = pidManager.readPort();
  } catch {
    // AC: @daemon-proxy-detection ac-fast-detection — no port file, fail fast
    cachedDetection = { available: false, reason: "no port file" };
    return cachedDetection;
  }

  // Step 2: Health check with timeout
  // 200ms HEALTH_CHECK_TIMEOUT_MS applies to both detection paths;
  // the metadata-keyed ac-health-timeout coverage lands with the
  // metadata reader implementation.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      cachedDetection = { available: true, port };
      return cachedDetection;
    }

    cachedDetection = { available: false, reason: `health check returned ${response.status}` };
    return cachedDetection;
  } catch (err) {
    // AC: @daemon-proxy-detection ac-fast-detection — connection refused, fail fast
    const message = err instanceof Error ? err.message : String(err);
    const reason = message.includes("abort") ? "health check timed out" : "connection refused";
    cachedDetection = { available: false, reason };
    return cachedDetection;
  }
}

/**
 * Determine if the current command should be proxied through the daemon.
 *
 * Checks (in order):
 * 1. KSPEC_NO_DAEMON=1 → direct mode (ac-force-direct)
 * 2. --daemon flag → require daemon, error if unavailable (ac-force-proxy)
 * 3. Detection result → proxy if available, direct if not (ac-direct-fallback;
 *    ac-auto-detect once metadata-driven detection is wired in)
 */
export async function shouldProxyCommand(opts: {
  forceDaemon?: boolean;
}): Promise<{ proxy: true; port: number } | { proxy: false; reason?: string }> {
  // AC: @cli-daemon-proxy ac-force-direct
  if (isNoDaemonModeEnabled()) {
    return { proxy: false, reason: "KSPEC_NO_DAEMON is set" };
  }

  const detection = await detectDaemon();

  // AC: @cli-daemon-proxy ac-force-proxy
  if (opts.forceDaemon) {
    if (!detection.available) {
      return { proxy: false, reason: `daemon required but unavailable: ${detection.reason}` };
    }
    return { proxy: true, port: detection.port };
  }

  // AC: @cli-daemon-proxy ac-direct-fallback
  // (ac-auto-detect coverage lands once detectDaemon reads metadata)
  if (detection.available) {
    return { proxy: true, port: detection.port };
  }

  return { proxy: false };
}

// ── Project Registration ───────────────────────────────────────────

/**
 * Ensure the current project is registered with the daemon.
 * The daemon auto-registers projects via the X-Kspec-Dir header in its
 * project context middleware, so we just need to include the header.
 * But if no project context is set, we explicitly register.
 *
 * AC: @daemon-proxy-detection ac-project-registered
 */
async function ensureProjectRegistered(port: number, projectPath: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRATION_TIMEOUT_MS);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // 200 = registered, 409 = already registered — both fine
    if (!response.ok && response.status !== 409) {
      // Non-fatal: if registration fails, the command API middleware
      // will auto-register via X-Kspec-Dir header
    }
  } catch {
    clearTimeout(timeout);
    // Non-fatal: middleware handles auto-registration (timeout or connection error)
  }
}

// ── Command Routing ────────────────────────────────────────────────

/**
 * Route a CLI command through the daemon's command API.
 *
 * Serializes the command into the batch JSON format (command + args)
 * and POSTs to the daemon's /api/command endpoint. Deserializes the
 * response and returns stdout/stderr/exitCode.
 *
 * AC: @cli-daemon-proxy ac-transparent-output — output format identical to direct mode
 * AC: @cli-daemon-proxy ac-mutation-coherence — daemon cache updated immediately
 * AC: @cli-daemon-proxy ac-read-from-cache — reads served from daemon cache
 * AC: @cli-daemon-proxy ac-timeout-fallback — read-only commands fall back on timeout
 * AC: @cli-daemon-proxy ac-timeout-mutation-error — mutating commands error on timeout
 */
export async function proxyCommand(opts: {
  port: number;
  command: string;
  args: Record<string, unknown>;
  projectPath: string;
  isMutating: boolean;
}): Promise<
  | { ok: true; result: ProxyCommandResult }
  | { ok: false; fallbackToDirectMode: boolean; error: string }
> {
  const { port, command, args, projectPath, isMutating } = opts;

  // AC: @daemon-proxy-detection ac-project-registered
  await ensureProjectRegistered(port, projectPath);

  const timeoutMs = isMutating ? MUTATION_COMMAND_TIMEOUT_MS : READ_COMMAND_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kspec-Dir": projectPath,
      },
      body: JSON.stringify({ command, args }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const body = (await response.json()) as ProxyCommandResult;

    return {
      ok: true,
      result: {
        stdout: body.stdout ?? "",
        stderr: body.stderr ?? "",
        exitCode: body.exitCode ?? 0,
      },
    };
  } catch (err) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("abort");

    if (isTimeout) {
      if (isMutating) {
        // AC: @cli-daemon-proxy ac-timeout-mutation-error
        return {
          ok: false,
          fallbackToDirectMode: false,
          error:
            "Daemon command timed out. The daemon may still be processing the mutation — do not retry in direct mode.",
        };
      }
      // AC: @cli-daemon-proxy ac-timeout-fallback
      return {
        ok: false,
        fallbackToDirectMode: true,
        error: "Daemon command timed out for read-only command. Falling back to direct mode.",
      };
    }

    // Connection error — not a timeout, daemon may have crashed
    return {
      ok: false,
      fallbackToDirectMode: !isMutating,
      error: `Daemon command failed: ${message}`,
    };
  }
}

/**
 * Build command string and args object from Commander's actionCommand.
 *
 * Extracts the full command path and all parsed options/arguments
 * from the Commander command instance.
 */
export function extractCommandPayload(actionCommand: {
  name: () => string;
  parent?: { name: () => string; parent?: unknown } | null;
  opts: () => Record<string, unknown>;
  args?: string[];
  registeredArguments?: ReadonlyArray<{ name: () => string; required: boolean; variadic: boolean }>;
  processedArgs?: unknown[];
}): { command: string; args: Record<string, unknown> } {
  // Build the full command path by walking up the parent chain
  const parts: string[] = [];
  let current: typeof actionCommand | null | undefined = actionCommand;
  while (current && typeof current.name === "function") {
    const name = current.name();
    if (name && name !== "kspec") {
      parts.unshift(name);
    }
    current = current.parent as typeof actionCommand | null | undefined;
  }
  const command = parts.join(" ");

  // Extract options (Commander's opts() returns the parsed options)
  const rawOpts = actionCommand.opts();
  const args: Record<string, unknown> = {};

  // Global options that are handled by the proxy layer and should not be
  // forwarded to the daemon command API
  const proxyOnlyOpts = new Set(["daemon", "debug-shadow", "debugShadow"]);

  // Copy options, converting camelCase to kebab-case for the batch format
  for (const [key, value] of Object.entries(rawOpts)) {
    // Skip undefined and default false booleans
    if (value === undefined) continue;
    // Skip proxy-only options
    if (proxyOnlyOpts.has(key)) continue;
    // Convert camelCase to kebab-case
    const kebab = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    if (proxyOnlyOpts.has(kebab)) continue;
    args[kebab] = value;
  }

  // Extract positional arguments
  if (actionCommand.processedArgs && actionCommand.registeredArguments) {
    for (let i = 0; i < actionCommand.registeredArguments.length; i++) {
      const argDef = actionCommand.registeredArguments[i];
      const value = actionCommand.processedArgs[i];
      if (value !== undefined) {
        args[argDef.name()] = value;
      }
    }
  }

  return { command, args };
}

// ── Testing Utilities ──────────────────────────────────────────────

/** Reset cached detection — for testing only. */
export function _resetDetectionCacheForTesting(): void {
  cachedDetection = null;
}

/** Override cached detection — for testing only. */
export function _setDetectionCacheForTesting(result: DaemonDetectionResult): void {
  cachedDetection = result;
}
