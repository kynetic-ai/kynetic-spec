/**
 * kspec serve commands - daemon server lifecycle management
 * AC: @cli-serve-commands
 */

import type { Command } from "commander";
import { spawn, execSync } from "child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { error, info, output, success, warn, isJsonMode } from "../output.js";
import { EXIT_CODES } from "../exit-codes.js";
import {
  PidFileManager,
  resolveDaemonClientEndpoint,
  isExternallyReachable,
} from "../pid-utils.js";
import {
  getDaemonLogPath,
  readDaemonLastExitRecord,
  type DaemonLastExitRecord,
} from "../../daemon-shared/endpoint.js";
import { loadProjectConfig } from "../../parser/config.js";
import { initContext } from "../../parser/yaml.js";

export async function resolveDefaultKspecDir(explicitDir?: string): Promise<string> {
  if (explicitDir) {
    return explicitDir;
  }

  try {
    const ctx = await initContext();
    return ctx.specDir;
  } catch {
    return join(process.cwd(), ".kspec");
  }
}

type DaemonRuntime = "bun" | "node";

/**
 * Check if Bun runtime is available.
 */
function isRuntimeAvailable(runtime: DaemonRuntime): boolean {
  try {
    execSync(`${runtime} --version`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getRuntimeInstallHint(runtime: DaemonRuntime): string {
  if (runtime === "bun") {
    return process.platform === "win32"
      ? 'Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"'
      : "Install Bun: curl -fsSL https://bun.sh/install | bash";
  }

  return "Install Node.js: https://nodejs.org/en/download";
}

function getRuntimeInstallUrl(runtime: DaemonRuntime): string {
  return runtime === "bun" ? "https://bun.sh/docs/installation" : "https://nodejs.org/en/download";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Check if daemon dist files are stale (source newer than dist)
 * Returns true if rebuild is recommended
 */
function checkDaemonStaleness(): boolean {
  // __dirname is dist/cli/commands, go up 3 levels to package root, then into packages/daemon/src
  const sourceDir = join(__dirname, "../../../packages/daemon/src");
  // dist/daemon is 2 levels up from __dirname
  const distDir = join(__dirname, "../../daemon");

  if (!existsSync(sourceDir) || !existsSync(distDir)) return false;

  try {
    const getNewestMtime = (dir: string, extension: ".ts" | ".js"): number => {
      const files = readdirSync(dir, { withFileTypes: true });
      let newest = 0;
      for (const f of files) {
        const fullPath = join(dir, f.name);
        if (f.isDirectory()) {
          newest = Math.max(newest, getNewestMtime(fullPath, extension));
        } else if (f.name.endsWith(extension)) {
          newest = Math.max(newest, statSync(fullPath).mtimeMs);
        }
      }
      return newest;
    };

    const newestSource = getNewestMtime(sourceDir, ".ts");
    const newestDist = getNewestMtime(distDir, ".js");

    return newestSource > newestDist;
  } catch {
    return false; // Don't warn if check fails
  }
}

/**
 * Normalize daemon uptime payloads to seconds.
 * Some runtimes may serialize uptime as structured objects instead of a number.
 */
function parseUptimeSeconds(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }

  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as { seconds?: unknown; milliseconds?: unknown; ms?: unknown };
  if (typeof candidate.seconds === "number" && Number.isFinite(candidate.seconds)) {
    return candidate.seconds;
  }
  if (typeof candidate.milliseconds === "number" && Number.isFinite(candidate.milliseconds)) {
    return candidate.milliseconds / 1000;
  }
  if (typeof candidate.ms === "number" && Number.isFinite(candidate.ms)) {
    return candidate.ms / 1000;
  }

  return null;
}

/**
 * Command-dispatch health as reported by GET /api/health. Mirrors the
 * CommandDispatchHealth shape built in packages/daemon/src/routes/command.ts
 * (the daemon package depends on src/, not the reverse, so the shape is
 * re-declared structurally here).
 *
 * AC: @daemon-command-api ac-stuck-command-reported
 */
type CommandDispatchStatus =
  | { status: "ok" }
  | { status: "degraded"; stuck_command: string; running_for_ms: number; limit_ms: number };

function parseCommandDispatchHealth(raw: unknown): CommandDispatchStatus | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const candidate = raw as {
    status?: unknown;
    stuck_command?: unknown;
    running_for_ms?: unknown;
    limit_ms?: unknown;
  };
  if (candidate.status === "ok") {
    return { status: "ok" };
  }
  if (
    candidate.status === "degraded" &&
    typeof candidate.stuck_command === "string" &&
    typeof candidate.running_for_ms === "number" &&
    Number.isFinite(candidate.running_for_ms) &&
    typeof candidate.limit_ms === "number" &&
    Number.isFinite(candidate.limit_ms)
  ) {
    return {
      status: "degraded",
      stuck_command: candidate.stuck_command,
      running_for_ms: candidate.running_for_ms,
      limit_ms: candidate.limit_ms,
    };
  }
  return null;
}

function formatMsDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function getProjectRootFromKspecDir(kspecDir: string): string {
  return dirname(kspecDir);
}

async function resolveDaemonRuntime(kspecDir: string): Promise<DaemonRuntime> {
  const projectRoot = getProjectRootFromKspecDir(kspecDir);
  const { config } = await loadProjectConfig(projectRoot, projectRoot);
  return config.daemon.runtime;
}

export function getDaemonRuntimeCommand(runtime: DaemonRuntime): string {
  return runtime;
}

/**
 * Runtime-mode selector environment variables the dispatcher injects on its
 * own process for language-runtime configuration.
 *
 * Consumers:
 *  - `buildDaemonChildEnv` (daemon spawn boundary): strips these from the
 *    inherited env and re-injects the appropriate one with a production value.
 *  - `buildBootstrapStepEnv` (bootstrap step boundary): strips these from
 *    process.env so they are absent from bootstrap step subprocess environments.
 *
 * Spec: @dispatch-runtime-bootstrap-contract ac-12 requires these values be
 * absent from bootstrap step subprocess environments.
 *
 * WARNING: Adding a non-runtime-mode variable to this constant would cause
 * that variable to be stripped from every bootstrap step subprocess,
 * potentially breaking bootstrap steps that shell out to nested CLI calls
 * expecting to observe it. CLI-only control flags (e.g. KSPEC_NO_DAEMON)
 * must be stripped locally at their specific boundary, not added here.
 */
export const DAEMON_RUNTIME_MODE_ENV_KEYS = ["BUN_ENV", "NODE_ENV"] as const;

export function buildDaemonChildEnv(
  runtime: DaemonRuntime,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // KSPEC_NO_DAEMON is a CLI-only control flag stripped here at the
  // daemon-spawn boundary. It is never re-injected on the daemon process
  // and is not a runtime-mode value, so it does not belong in
  // DAEMON_RUNTIME_MODE_ENV_KEYS. Consolidating this inline strip into
  // the shared runtime-mode constant would silently re-broaden the
  // bootstrap step env strip set (via buildBootstrapStepEnv) and
  // reintroduce the drift this split prevents.
  const {
    KSPEC_NO_DAEMON: _kspecNoDaemon,
    BUN_ENV: _bunEnv,
    NODE_ENV: _nodeEnv,
    ...childEnv
  } = baseEnv;
  if (runtime === "node") {
    return { ...childEnv, NODE_ENV: "production" };
  }

  return { ...childEnv, BUN_ENV: "production" };
}

/**
 * AC: @cli-serve-commands ac-11
 * Refuse to modify daemon lifecycle when running inside an agent invocation.
 * Agents inherit KSPEC_SESSION_ID — stopping the daemon would kill the dispatch engine.
 */
function guardAgentContext(action: string): void {
  if (process.env.KSPEC_SESSION_ID) {
    if (isJsonMode()) {
      output({
        error: `Cannot ${action} daemon from inside an agent invocation.`,
        reason:
          "Stopping or restarting the daemon would kill the dispatch engine hosting this agent.",
        suggestion:
          "The daemon is managed externally. Do not run kspec serve commands from agent code.",
      });
    } else {
      error(`Cannot ${action} daemon from inside an agent invocation.`);
      error("Stopping or restarting the daemon would kill the dispatch engine hosting this agent.");
      error("The daemon is managed externally. Do not run kspec serve commands from agent code.");
    }
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }
}

/**
 * Register serve commands
 */
export function registerServeCommands(program: Command): void {
  const serve = program.command("serve").description("Manage the kspec daemon server");

  // AC: @cli-serve-commands ac-1, ac-2, ac-3
  // AC: @config-daemon ac-1, ac-2 — port from config, CLI flag overrides
  serve
    .command("start", { isDefault: true })
    .description("Start the daemon server")
    .option("-d, --detach", "Run in background (detached mode)")
    .option("-p, --port <port>", "Server port (uses config daemon.port if not specified)")
    .option("--kspec-dir <dir>", "Path to .kspec directory (defaults to resolved project .kspec)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        await startServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-4, ac-5
  serve
    .command("stop")
    .description("Stop the daemon server")
    .option("--kspec-dir <dir>", "Path to .kspec directory (defaults to resolved project .kspec)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        await stopServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to stop server: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-6
  serve
    .command("status")
    .description("Check daemon server status")
    .option("--kspec-dir <dir>", "Path to .kspec directory (defaults to resolved project .kspec)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        await statusServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to check status: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-8, ac-9
  serve
    .command("logs")
    .description("Show the daemon log file (last 50 lines by default)")
    .option("-n, --lines <n>", "Number of lines to show (default: 50)")
    .option("-f, --follow", "Stream appended log lines until Ctrl+C")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        await logsServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to read daemon log: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-serve-commands ac-7
  serve
    .command("restart")
    .description("Restart the daemon server")
    .option("--kspec-dir <dir>", "Path to .kspec directory (defaults to resolved project .kspec)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        await restartServer(opts);
      } catch (err) {
        if (isJsonMode()) {
          output({ error: err instanceof Error ? err.message : String(err) });
        } else {
          error(`Failed to restart server: ${err instanceof Error ? err.message : String(err)}`);
        }
        process.exit(EXIT_CODES.ERROR);
      }
    });
}

/**
 * Start the daemon server
 * AC: @cli-serve-commands ac-1 (foreground), ac-2 (daemon), ac-3 (port), ac-10 (port error)
 * AC: @config-daemon ac-1 — port from config, ac-2 — CLI flag overrides config
 */
async function startServer(opts: {
  detach?: boolean;
  port?: string;
  kspecDir?: string;
}): Promise<void> {
  // AC: @cli-serve-commands ac-11
  guardAgentContext("start");
  const jsonMode = isJsonMode();
  const kspecDir = await resolveDefaultKspecDir(opts.kspecDir);
  const runtime = await resolveDaemonRuntime(kspecDir);

  // AC: @config-daemon ac-1, ac-2 — load config for default port, CLI flag overrides
  const { config } = await loadProjectConfig(
    getProjectRootFromKspecDir(kspecDir),
    getProjectRootFromKspecDir(kspecDir),
  );
  const configPort = config.daemon.port;

  // AC: @config-daemon ac-2 — CLI flag takes precedence over config
  const port = opts.port ? parseInt(opts.port, 10) : configPort;

  // AC: @config-daemon ac-host-default, ac-host-config, ac-connect-host-config
  // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // Forward the resolved bind host to the spawned daemon so it never
  // falls back to its built-in defaults if config drifts. We also
  // forward whether the host was explicitly configured so the daemon
  // knows whether IPv6 loopback fallback applies (only for default).
  const bindHost = config.daemon.host;
  const hostExplicitlyConfigured = config.daemon.host_explicitly_configured;
  const connectHost = config.daemon.connect_host;

  // AC: @cli-serve-commands ac-10
  if (isNaN(port) || port < 1 || port > 65535) {
    if (jsonMode) {
      output({
        error: "Invalid port number. Must be between 1 and 65535.",
        hint: "Try: kspec serve --port <PORT>",
      });
    } else {
      error("Invalid port number. Must be between 1 and 65535.");
      error("Try: kspec serve --port <PORT>");
    }
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }

  const pidManager = new PidFileManager();

  // Check if already running
  if (pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
    const pid = pidManager.readPid();
    const existingPort = pidManager.readPort();
    if (isJsonMode()) {
      output({ running: true, pid, port: existingPort, message: "Daemon already running" });
    } else {
      warn(`Daemon already running on port ${existingPort}`);
    }
    process.exit(EXIT_CODES.SUCCESS);
  }

  // Get path to daemon entry point
  // The daemon is compiled to dist/daemon/index.js relative to the package root.
  // __dirname is dist/cli/commands, so go up 2 levels to dist/, then into daemon/
  const daemonBinary = join(__dirname, "../../daemon/index.js");

  if (!existsSync(daemonBinary)) {
    if (isJsonMode()) {
      output({
        error: `Daemon binary not found at ${daemonBinary}`,
        hint: "Ensure the kspec package is properly installed",
      });
    } else {
      error(`Daemon binary not found at: ${daemonBinary}`);
      error("Ensure the kspec package is properly installed");
    }
    process.exit(EXIT_CODES.ERROR);
  }

  // AC: @web-ui ac-2 — clear error with install URL when Bun is missing
  // AC: @daemon-runtime-adapter ac-runtime-missing
  if (!isRuntimeAvailable(runtime)) {
    const runtimeName = runtime === "bun" ? "Bun" : "Node";
    const installHint = getRuntimeInstallHint(runtime);
    const installUrl = getRuntimeInstallUrl(runtime);
    if (isJsonMode()) {
      output({
        error: `${runtimeName} runtime is required for the kspec daemon`,
        hint: installHint,
        url: installUrl,
      });
    } else {
      error(`${runtimeName} runtime is required for the kspec daemon`);
      info(installHint);
      info(`For more options: ${installUrl}`);
    }
    process.exit(EXIT_CODES.ERROR);
  }

  // Check for stale daemon build (dev experience improvement)
  if (checkDaemonStaleness() && !jsonMode) {
    warn("Warning: dist/daemon/ may be stale (source files are newer).");
    warn('  Run "npm run build:daemon" to update.');
  }

  const daemonArgs: string[] = [
    daemonBinary,
    "--port",
    String(port),
    "--kspec-dir",
    kspecDir,
    "--host",
    bindHost,
  ];
  if (hostExplicitlyConfigured) {
    // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
    // Tell the daemon the host came from an explicit user setting so it
    // does NOT auto-fall back to ::1 when 127.0.0.1 binding fails.
    daemonArgs.push("--host-explicit");
  }
  if (connectHost) {
    daemonArgs.push("--connect-host", connectHost);
  }
  // AC: @daemon-log-capture ac-bounded-rotation — forward the configured
  // rotation cap so the daemon's in-process log tee applies it at startup.
  daemonArgs.push("--log-max-size", String(config.daemon.log_max_size_bytes));
  // AC: @daemon-command-api ac-command-timeout — forward the configured
  // command execution limit so the command API bounds caller waits.
  daemonArgs.push("--command-timeout", String(config.daemon.command_timeout_ms));

  // AC: @daemon-network-endpoint-contract ac-external-binding-warning
  // AC: @trait-localhost-security ac-external-warning
  // AC: @config-daemon ac-host-config
  // Surface the external-binding warning from the parent CLI process so
  // it is visible even when the daemon child is detached with stdio
  // ignored. warn() routes to stderr in structured output modes so it
  // never corrupts the JSON payload on stdout.
  const externallyReachable = isExternallyReachable(bindHost);
  if (externallyReachable) {
    warn(
      `WARNING: daemon will bind to ${bindHost}, exposing unauthenticated kspec project data and mutation APIs on a non-loopback interface. Restrict access at the network/firewall level.`,
    );
  }

  // AC: @daemon-network-endpoint-contract ac-external-connect-host-warning
  // A configured non-loopback connect host is added to the daemon's
  // accepted Host-header values and advertised to every client, so a
  // wrong value silently weakens DNS-rebinding protection and misroutes
  // clients — surface it as loudly as the bind-host warning.
  if (connectHost && isExternallyReachable(connectHost)) {
    warn(
      `WARNING: daemon connect host is ${connectHost}, a non-loopback host value; the daemon will accept requests addressed to ${connectHost} and advertise it to clients. Verify connect_host is intended.`,
    );
  }

  // AC: @cli-serve-commands ac-2 - background mode
  if (opts.detach) {
    // Spawn detached process
    const child = spawn(getDaemonRuntimeCommand(runtime), daemonArgs, {
      detached: true,
      // AC: @daemon-log-capture ac-detached-output-captured — stdio stays
      // ignored; the daemon tees its console output into the daemon log
      // in-process (packages/daemon/src/logger.ts), which works identically
      // for detached and foreground modes without parent-held file handles.
      stdio: "ignore",
      cwd: process.cwd(),
      env: buildDaemonChildEnv(runtime),
    });

    // Detach from parent
    child.unref();

    // Poll for PID file with timeout (max 5 seconds)
    const maxWait = 5000;
    const startTime = Date.now();
    let pid: number | null = null;

    while (Date.now() - startTime < maxWait) {
      pid = pidManager.readPid();
      if (pid && pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (pid && pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
      if (isJsonMode()) {
        output({ running: true, pid, port });
      } else {
        success(`Daemon started with PID ${pid} on port ${port}`);
        output({ running: true, pid, port });
      }
    } else {
      if (isJsonMode()) {
        output({ error: "Daemon failed to start within 5 seconds" });
      } else {
        error("Daemon failed to start within 5 seconds");
      }
      process.exit(EXIT_CODES.ERROR);
    }
  } else {
    // AC: @cli-serve-commands ac-1 - foreground mode
    if (!isJsonMode()) {
      info(`Starting server in foreground on port ${port}...`);
      info("Press Ctrl+C to stop");
    }

    const child = spawn(getDaemonRuntimeCommand(runtime), daemonArgs, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: buildDaemonChildEnv(runtime),
    });

    // Handle Ctrl+C - forward SIGTERM to child for graceful shutdown
    process.on("SIGINT", () => {
      if (!isJsonMode()) {
        info("\nStopping server...");
      }
      child.kill("SIGTERM");

      // Wait for graceful shutdown (max 5 seconds)
      const shutdownTimeout = setTimeout(() => {
        child.kill("SIGKILL"); // Force kill if not stopped
      }, 5000);

      child.on("exit", () => {
        clearTimeout(shutdownTimeout);
      });
    });

    // Wait for process to exit
    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
  }
}

/**
 * Stop the daemon server
 * AC: @cli-serve-commands ac-4 (stop), ac-5 (idempotent)
 */
async function stopServer(_opts: { kspecDir?: string; json?: boolean }): Promise<void> {
  // AC: @cli-serve-commands ac-11
  guardAgentContext("stop");

  const pidManager = new PidFileManager();

  if (!pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
    // AC: @cli-serve-commands ac-5
    if (isJsonMode()) {
      output({ running: false });
    } else {
      info("Daemon not running");
      output({ running: false });
    }
    process.exit(EXIT_CODES.SUCCESS);
  }

  const pid = pidManager.readPid();
  if (!pid) {
    if (isJsonMode()) {
      output({ error: "Failed to read PID file" });
    } else {
      error("Failed to read PID file");
    }
    process.exit(EXIT_CODES.ERROR);
  }

  // AC: @cli-serve-commands ac-4
  if (!isJsonMode()) {
    info(`Stopping daemon (PID ${pid})...`);
  }

  try {
    // Send SIGTERM
    process.kill(pid, "SIGTERM");

    // Wait for clean shutdown (max 5 seconds)
    const maxWait = 5000;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWait) {
      if (!pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
      if (!isJsonMode()) {
        warn(`Daemon did not stop gracefully, forcing...`);
      }
      process.kill(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (isJsonMode()) {
      output({ stopped: true, pid });
    } else {
      success("Daemon stopped");
      output({ stopped: true, pid });
    }
  } catch (err) {
    if (isJsonMode()) {
      output({ error: err instanceof Error ? err.message : String(err) });
    } else {
      error(`Failed to stop daemon: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(EXIT_CODES.ERROR);
  }
}

/**
 * Check daemon server status
 * AC: @cli-serve-commands ac-6, @multi-directory-daemon ac-12
 */
async function statusServer(_opts: { kspecDir?: string; json?: boolean }): Promise<void> {
  if (isJsonMode()) {
  }

  const pidManager = new PidFileManager();
  const running = pidManager.isDaemonRunning({ ignoreNoDaemon: true });
  const pid = pidManager.readPid();

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata,
  //     ac-legacy-port-fallback — resolve via metadata first, legacy fallback.
  // AC: @cli-serve-commands ac-6 — status reports bind_host, connect_host,
  //     and runtime alongside running, pid, port, uptime, and projects.
  let port: number | null = null;
  let apiUrl: string | null = null;
  let bindHost: string | null = null;
  let connectHost: string | null = null;
  let runtime: string | null = null;
  if (running) {
    const endpoint = resolveDaemonClientEndpoint();
    if (endpoint) {
      port = endpoint.port;
      apiUrl = endpoint.apiUrl;
      bindHost = endpoint.bindHost;
      connectHost = endpoint.connectHost;
      runtime = endpoint.runtime;
    } else {
      try {
        port = pidManager.readPort();
      } catch {
        port = null;
      }
    }
  }

  // AC: @daemon-network-endpoint-contract ac-external-binding-warning
  // AC: @trait-localhost-security ac-external-warning
  // Surface the warning whenever a lifecycle command reports the daemon
  // endpoint and the bind host is non-loopback.
  if (running && bindHost && isExternallyReachable(bindHost)) {
    warn(
      `WARNING: daemon is bound to ${bindHost}, exposing unauthenticated kspec project data and mutation APIs on a non-loopback interface. Restrict access at the network/firewall level.`,
    );
  }

  // AC: @daemon-network-endpoint-contract ac-external-connect-host-warning
  // Mirror the connect-host warning whenever a lifecycle command reports
  // the endpoint and the advertised connect host is non-loopback.
  if (running && connectHost && isExternallyReachable(connectHost)) {
    warn(
      `WARNING: daemon connect host is ${connectHost}, a non-loopback host value; the daemon will accept requests addressed to ${connectHost} and advertise it to clients. Verify connect_host is intended.`,
    );
  }

  // AC: @multi-directory-daemon ac-12 - Fetch list of registered projects and uptime
  let projects: Array<{ path: string; registeredAt: string; watcherStatus: string }> = [];
  let uptime: number | null = null;
  let commandDispatch: CommandDispatchStatus | null = null;
  if (running && apiUrl) {
    try {
      const response = await fetch(`${apiUrl}/api/projects`);
      if (response.ok) {
        const data = (await response.json()) as {
          projects: Array<{ path: string; registeredAt: string; watcherStatus: string }>;
        };
        projects = data.projects || [];
      }
    } catch {
      // If daemon is not responding, continue without projects list
      // This can happen if daemon is still starting up or network issues
    }

    // Fetch uptime from health endpoint.
    // Retry briefly to reduce startup races where status is checked immediately after daemon start.
    for (let attempt = 1; attempt <= 5 && uptime === null; attempt++) {
      try {
        const healthResponse = await fetch(`${apiUrl}/api/health`);
        if (healthResponse.ok) {
          const healthData = (await healthResponse.json()) as {
            status: string;
            uptime?: unknown;
            command_dispatch?: unknown;
          };
          // AC: @daemon-command-api ac-stuck-command-reported — the timeout
          // error directs operators here, so status must surface the
          // command_dispatch health payload, not just uptime.
          commandDispatch = parseCommandDispatchHealth(healthData.command_dispatch);
          const parsed = parseUptimeSeconds(healthData.uptime);
          if (parsed !== null) {
            uptime = parsed;
            break;
          }
        }
      } catch {
        // If health endpoint fails, continue retry loop.
      }

      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  // AC: @daemon-log-capture ac-log-location-discoverable — lifecycle status
  // reports the daemon log file location.
  const logPath = getDaemonLogPath();

  // AC: @daemon-failure-observability ac-status-surfaces-last-exit — when
  // no daemon is running, surface the most recent termination so a user
  // investigating a disappeared daemon can see why it stopped.
  let lastExit: DaemonLastExitRecord | null = null;
  if (!running) {
    lastExit = readDaemonLastExitRecord();
  }

  // AC: @cli-serve-commands ac-6 — status JSON returns the same fields
  //     as human-readable mode, including bind_host, connect_host, runtime.
  const status = {
    running,
    pid: pid ?? null,
    port,
    bind_host: bindHost,
    connect_host: connectHost,
    runtime,
    uptime,
    // AC: @daemon-command-api ac-stuck-command-reported — surface wedged
    // command dispatch where the timeout error directs operators.
    command_dispatch: commandDispatch,
    log_path: logPath,
    last_exit: lastExit,
    projects,
  };

  if (isJsonMode()) {
    output(status);
  } else {
    if (running) {
      output(`Daemon running (PID: ${pid})`);
      if (port) {
        output(`  Port: ${port}`);
      }
      if (bindHost) {
        output(`  Bind host: ${bindHost}`);
      }
      if (connectHost) {
        output(`  Connect host: ${connectHost}`);
      }
      if (runtime) {
        output(`  Runtime: ${runtime}`);
      }
      // AC: @daemon-log-capture ac-log-location-discoverable
      output(`  Log file: ${logPath}`);
      // AC: @multi-directory-daemon ac-12 - Show uptime
      if (uptime !== null) {
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        if (hours > 0) {
          output(`  Uptime: ${hours}h ${minutes}m ${seconds}s`);
        } else if (minutes > 0) {
          output(`  Uptime: ${minutes}m ${seconds}s`);
        } else {
          output(`  Uptime: ${seconds}s`);
        }
      }
      // AC: @daemon-command-api ac-stuck-command-reported — the command
      // timeout error suggests `kspec serve status`, so a wedged dispatch
      // must be visible here with the stuck command name and held duration.
      if (commandDispatch) {
        if (commandDispatch.status === "degraded") {
          output(
            `  Command dispatch: DEGRADED — '${commandDispatch.stuck_command}' has been running for ${formatMsDuration(commandDispatch.running_for_ms)} (limit ${formatMsDuration(commandDispatch.limit_ms)}). Restart the daemon if it stays wedged.`,
          );
        } else {
          output(`  Command dispatch: ok`);
        }
      }
      // AC: @multi-directory-daemon ac-12 - Show registered projects
      if (projects.length > 0) {
        output(`\nRegistered projects (${projects.length}):`);
        for (const project of projects) {
          output(`  ${project.path} (watcher: ${project.watcherStatus})`);
        }
      } else {
        output(`\nNo projects registered`);
      }
    } else {
      output("Daemon not running");
      // AC: @daemon-failure-observability ac-status-surfaces-last-exit —
      // report the most recent termination kind, reason, and timestamp.
      if (lastExit) {
        output(`  Last exit: ${lastExit.kind} at ${lastExit.timestamp}`);
        output(`  Reason: ${lastExit.reason}`);
      }
      // AC: @daemon-log-capture ac-log-location-discoverable — point at the
      // log from a previous run so a disappeared daemon stays diagnosable.
      if (existsSync(logPath)) {
        output(`  Log file: ${logPath}`);
      }
    }
  }
}

/** Default number of lines printed by `kspec serve logs`. */
const DEFAULT_LOG_TAIL_LINES = 50;

/**
 * Poll interval for `kspec serve logs --follow`. A stat/read polling loop
 * (rather than fs.watch) is rotation-safe: every tick re-stats the active
 * path, so a rotated or truncated file is detected by inode change or size
 * shrink and streaming continues from the start of the new active file.
 */
const FOLLOW_POLL_INTERVAL_MS = 500;

/**
 * Read the byte range [start, end) from a file. Returns null when the file
 * cannot be opened or read (e.g. it was rotated away between the caller's
 * stat and this read) so follow mode can retry on the next poll tick.
 */
function readLogRange(
  path: string,
  start: number,
  end: number,
): { text: string; bytes: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(end - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    return { text: buffer.toString("utf8", 0, bytesRead), bytes: bytesRead };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Tail or follow the daemon log file
 * AC: @cli-serve-commands ac-8 (tail), ac-9 (follow until Ctrl+C)
 *
 * Works whether or not the daemon is currently running — the log file
 * persists across daemon restarts. Tail mode reads the active log file
 * only; older output may live in the rotated generation at <log>.1.
 */
async function logsServer(opts: {
  lines?: string;
  follow?: boolean;
  json?: boolean;
}): Promise<void> {
  const jsonMode = isJsonMode();
  const logPath = getDaemonLogPath();

  // JSON output is a structured snapshot of the tail; it cannot represent
  // an unbounded stream, so the combination is rejected explicitly rather
  // than silently dropping one of the flags.
  if (opts.follow && jsonMode) {
    const message = "--json is not supported with --follow.";
    const suggestion =
      "Use kspec serve logs --json for a structured tail, or --follow without --json to stream.";
    output({ error: message, suggestion });
    process.exit(EXIT_CODES.VALIDATION_FAILED);
  }

  let tailCount = DEFAULT_LOG_TAIL_LINES;
  if (opts.lines !== undefined) {
    const parsed = Number(opts.lines);
    if (!Number.isInteger(parsed) || parsed < 1) {
      // AC: @trait-error-guidance ac-5 — name the failing flag and value
      const message = `Invalid --lines value: ${opts.lines}. Must be a positive integer.`;
      const suggestion = "Try: kspec serve logs --lines 100";
      if (jsonMode) {
        output({ error: message, suggestion });
      } else {
        error(message, { suggestion });
      }
      process.exit(EXIT_CODES.VALIDATION_FAILED);
    }
    tailCount = parsed;
  }

  // AC: @trait-error-guidance ac-1, ac-2 — say what is missing and how to
  // create it. The log file appears the first time a daemon emits output.
  if (!existsSync(logPath)) {
    const message = `No daemon log file found at ${logPath}`;
    const suggestion =
      "The log file is created the first time the daemon writes output. Start the daemon with: kspec serve start --detach";
    if (jsonMode) {
      output({ error: message, suggestion });
    } else {
      error(message, { suggestion });
    }
    process.exit(EXIT_CODES.NOT_FOUND);
  }

  const content = readFileSync(logPath, "utf-8");
  const allLines = content.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const tail = allLines.slice(-tailCount);

  if (!opts.follow) {
    // AC: @cli-serve-commands ac-8
    if (jsonMode) {
      // AC: @trait-json-output ac-2 — same data as human mode (lines array
      // plus the resolved log path).
      output({ log_path: logPath, lines: tail });
    } else {
      for (const line of tail) {
        output(line);
      }
    }
    return;
  }

  // AC: @cli-serve-commands ac-9 — print the tail, then stream appended
  // lines until Ctrl+C.
  for (const line of tail) {
    output(line);
  }

  let position = Buffer.byteLength(content, "utf8");
  let inode: bigint | number | null = null;
  try {
    inode = statSync(logPath).ino;
  } catch {
    inode = null;
  }

  process.on("SIGINT", () => {
    process.exit(EXIT_CODES.SUCCESS);
  });

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_INTERVAL_MS));

    let stat;
    try {
      stat = statSync(logPath);
    } catch {
      // Active file briefly absent mid-rotation (renamed away, next line
      // not yet appended). Keep polling — the writer recreates it on the
      // next append.
      continue;
    }

    if ((inode !== null && stat.ino !== inode) || stat.size < position) {
      // Rotated, replaced, or truncated: continue from the start of the
      // new active file rather than a stale byte offset.
      position = 0;
    }
    inode = stat.ino;

    if (stat.size > position) {
      const chunk = readLogRange(logPath, position, stat.size);
      if (chunk === null) {
        continue;
      }
      process.stdout.write(chunk.text);
      position += chunk.bytes;
    }
  }
}

/**
 * Restart the daemon server
 * AC: @cli-serve-commands ac-7
 */
async function restartServer(opts: { kspecDir?: string; json?: boolean }): Promise<void> {
  // AC: @cli-serve-commands ac-11
  guardAgentContext("restart");
  const pidManager = new PidFileManager();

  // AC: @cli-serve-commands ac-7 - preserve port across restarts
  // Try to read port from existing daemon, otherwise startServer will use config default
  let port: string | undefined;
  try {
    port = pidManager.readPort().toString();
  } catch {
    // Port file doesn't exist or is invalid, let startServer use config
  }

  if (pidManager.isDaemonRunning({ ignoreNoDaemon: true })) {
    if (!isJsonMode()) {
      info("Stopping daemon...");
    }
    await stopServer(opts);
  }

  if (!isJsonMode()) {
    info("Starting daemon...");
  }
  await startServer({ detach: true, port, kspecDir: opts.kspecDir });
}
