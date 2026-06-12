/**
 * Agent spawner.
 *
 * Spawns ACP-compliant agent processes and initializes the ACP client
 * for bidirectional JSON-RPC communication.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { ACPClient, type ACPClientOptions } from "../acp/index.js";
import type { AgentAdapter } from "./adapters.js";

/**
 * Options for spawning an agent.
 */
export interface SpawnAgentOptions {
  /** Working directory for the agent */
  cwd: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Extra arguments to append (e.g., auto-approve flags) */
  extraArgs?: string[];
  /** ACP client options */
  clientOptions?: Omit<ACPClientOptions, "stdin" | "stdout">;
  /**
   * Whether to merge the host process env under `env` when building the child
   * environment.
   *
   * - `true` (default): preserves pre-runner-config behavior. The legacy
   *   adapter invocation path relies on inheriting PATH/HOME and other host
   *   vars implicitly.
   * - `false`: the spawner uses `env` verbatim (after adapter.env merge but
   *   without `process.env`). Runner-backed invocations set this to enforce
   *   the runner's `env.inherit` policy.
   *
   * AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
   */
  inheritParentEnv?: boolean;
  /**
   * Optional redactor applied to adapter stderr lines before they are
   * forwarded to `process.stderr`. Runner-backed invocations pass the
   * resolved runner contract's redactor so any secret value that leaks into
   * adapter diagnostics is scrubbed before reaching operator-visible output.
   *
   * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
   */
  redact?: (text: string) => string;
}

/**
 * Result of spawning an agent.
 */
export interface SpawnedAgent {
  /** The ACP client for communication */
  client: ACPClient;
  /** The child process handle */
  process: ChildProcess;
  /** Kill the agent process */
  kill: (signal?: NodeJS.Signals) => void;
  /** Rejects if the child process emits a spawn error (e.g. ENOENT) */
  spawnError: Promise<never>;
}

/**
 * Environment variables to strip from the parent process before spawning agents.
 * These vars cause agent runtimes to detect a "nested session" and refuse to start
 * when the daemon itself was launched from within such an environment.
 */
export const SANITIZED_ENV_VARS = ["CLAUDECODE", "CLAUDE_CODE_SESSION"] as const;

const UNEXPECTED_CASE_PREFIX = "Unexpected case:";
const RATE_LIMIT_EVENT_TYPE = "rate_limit_event";

function isNonActionableAdapterStderrLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith(UNEXPECTED_CASE_PREFIX)) return false;

  const payload = trimmed.slice(UNEXPECTED_CASE_PREFIX.length).trim();
  if (!payload) return false;

  try {
    const parsed = JSON.parse(payload) as { type?: string };
    return parsed.type === RATE_LIMIT_EVENT_TYPE;
  } catch {
    // Keep a narrow fallback pattern in case adapter logs malformed JSON.
    return /"type"\s*:\s*"rate_limit_event"/.test(payload);
  }
}

function forwardFilteredAdapterStderr(
  child: ChildProcess,
  redact?: (text: string) => string,
): void {
  if (!child.stderr) return;

  child.stderr.setEncoding("utf-8");
  let pending = "";

  // Redact each line before forwarding so resolved secret values cannot leak
  // through adapter stderr into operator-visible output. The redactor is a
  // no-op when the runner contract had no resolved secrets.
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  const forward = (line: string, withNewline: boolean): void => {
    if (isNonActionableAdapterStderrLine(line)) return;
    const scrubbed = redact ? redact(line) : line;
    process.stderr.write(withNewline ? `${scrubbed}\n` : scrubbed);
  };

  child.stderr.on("data", (chunk: string | Buffer) => {
    pending += chunk.toString();
    let newlineIndex = pending.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      forward(line, true);
      newlineIndex = pending.indexOf("\n");
    }
  });

  child.stderr.on("end", () => {
    if (pending.length > 0) {
      forward(pending, false);
    }
  });
}

/**
 * Spawn an ACP agent using the specified adapter.
 *
 * Creates a child process and wraps its stdio with an ACPClient.
 * The caller is responsible for calling client.initialize() after spawning.
 *
 * @param adapter - Adapter definition specifying how to spawn the agent
 * @param options - Spawn options including cwd and environment
 * @returns SpawnedAgent with client, process, and kill function
 */
export function spawnAgent(adapter: AgentAdapter, options: SpawnAgentOptions): SpawnedAgent {
  const { cwd, env = {}, extraArgs, clientOptions = {}, inheritParentEnv = true, redact } = options;

  // Strip host-environment variables that interfere with agent startup
  // (e.g. CLAUDECODE=1 causes nested-session detection in Claude Code)
  // Only inherited when inheritParentEnv is true — runner-backed invocations
  // pass an already-composed env per the runner's inherit policy.
  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  const inheritedHostEnv: NodeJS.ProcessEnv = {};
  if (inheritParentEnv) {
    Object.assign(inheritedHostEnv, process.env);
    for (const key of SANITIZED_ENV_VARS) {
      delete inheritedHostEnv[key];
    }
  }

  // Merge environment variables
  const processEnv = {
    ...inheritedHostEnv,
    ...adapter.env,
    ...env,
  };

  // Build args from fresh copy to prevent cross-call leakage
  const args = [...adapter.args, ...(extraArgs || [])];

  // Defensive guard: an adapter without a resolved command must never reach
  // spawn. The runner resolver replaces a generic adapter's absent command
  // with the runner-supplied executable, and rejects generic invocations that
  // lack one (`missing_process_executable`) before this point — so a missing
  // command here means a resolver bug, not an operator-fixable condition.
  // Throwing keeps us from spawning a placeholder generic command.
  if (adapter.command === undefined) {
    throw new Error(
      "Adapter has no command to spawn. A generic ACP process adapter must be " +
        "resolved through a runner that supplies process.executable.",
    );
  }

  // Spawn the agent process. On POSIX, create a dedicated process group so
  // package runners such as npx cannot orphan the real adapter binary during
  // cleanup. Killing the group terminates the runner and any descendants that
  // inherited its stdio handles.
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(adapter.command, args, {
    cwd,
    env: processEnv,
    shell: adapter.shell,
    detached: useProcessGroup,
    stdio: ["pipe", "pipe", "pipe"], // pipe all stdio so stderr can be filtered
  });

  // Catch spawn-level errors (e.g. ENOENT when command not found) so they
  // propagate as a rejected promise from spawnAndInitialize instead of
  // crashing the daemon with an unhandled exception.
  const spawnError = new Promise<never>((_, reject) => {
    child.on("error", (err) => reject(err));
  });
  // Prevent unhandled rejection when spawn succeeds (nobody races against it)
  spawnError.catch(() => {});

  // Keep actionable adapter stderr visible while dropping known non-actionable noise.
  // Apply the runner contract's redactor so any secret value that surfaces in
  // adapter diagnostics is scrubbed before reaching operator-visible output.
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  forwardFilteredAdapterStderr(child, redact);

  // Ensure stdin/stdout are available
  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to create pipes for agent process");
  }

  // Create ACP client connected to child's stdio
  // Note: From the client's perspective:
  // - stdin is where we READ from (child's stdout)
  // - stdout is where we WRITE to (child's stdin)
  //
  // Forward the runner contract redactor into ACP framing so JSON-RPC error
  // logs (`JSON-RPC error: <message>`) cannot leak resolved secret values to
  // parent stderr when an adapter rejects a request with secret-containing
  // text.
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  const client = new ACPClient({
    ...clientOptions,
    stdin: child.stdout, // We read from child's stdout
    stdout: child.stdin as NodeJS.WritableStream, // We write to child's stdin
    redact,
  });

  // Forward process exit to client close, surfacing exit code/signal
  child.on("exit", (code, signal) => {
    if (!client.isClosed()) {
      let reason: string;
      if (signal !== null) {
        reason = `Subagent process exited with signal ${signal}`;
      } else if (code !== null) {
        reason = `Subagent process exited with code ${code}`;
      } else {
        reason = "Subagent process exited unexpectedly";
      }
      client.close(reason);
    }
  });

  // Kill function with graceful shutdown
  const kill = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (!client.isClosed()) {
      client.close(`Subagent process terminated with signal ${signal}`);
    }

    if (useProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group kill fails (ESRCH) when the process group is already gone —
        // fall back to signaling the child directly instead of surfacing it.
        if (!child.killed) {
          child.kill(signal);
        }
      }
    } else if (!child.killed) {
      child.kill(signal);
    }

    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  };

  return { client, process: child, kill, spawnError };
}

/**
 * Spawn and initialize an ACP agent.
 *
 * Convenience function that spawns an agent and calls initialize().
 *
 * @param adapter - Adapter definition
 * @param options - Spawn options
 * @returns Initialized SpawnedAgent
 */
export async function spawnAndInitialize(
  adapter: AgentAdapter,
  options: SpawnAgentOptions,
): Promise<SpawnedAgent> {
  const agent = spawnAgent(adapter, options);

  try {
    // Race initialization against spawn errors — if the command doesn't exist,
    // the 'error' event fires before initialize() can complete.
    await Promise.race([agent.client.initialize(), agent.spawnError]);
    return agent;
  } catch (err) {
    // Clean up on initialization failure
    agent.kill();
    throw err;
  }
}
