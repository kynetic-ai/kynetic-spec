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

function forwardFilteredAdapterStderr(child: ChildProcess): void {
  if (!child.stderr) return;

  child.stderr.setEncoding("utf-8");
  let pending = "";

  const forward = (line: string, withNewline: boolean): void => {
    if (isNonActionableAdapterStderrLine(line)) return;
    process.stderr.write(withNewline ? `${line}\n` : line);
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
export function spawnAgent(
  adapter: AgentAdapter,
  options: SpawnAgentOptions,
): SpawnedAgent {
  const { cwd, env = {}, extraArgs, clientOptions = {} } = options;

  // Strip host-environment variables that interfere with agent startup
  // (e.g. CLAUDECODE=1 causes nested-session detection in Claude Code)
  const cleanProcessEnv = { ...process.env };
  for (const key of SANITIZED_ENV_VARS) {
    delete cleanProcessEnv[key];
  }

  // Merge environment variables
  const processEnv = {
    ...cleanProcessEnv,
    ...adapter.env,
    ...env,
  };

  // Build args from fresh copy to prevent cross-call leakage
  const args = [...adapter.args, ...(extraArgs || [])];

  // Spawn the agent process
  const child = spawn(adapter.command, args, {
    cwd,
    env: processEnv,
    shell: adapter.shell,
    stdio: ["pipe", "pipe", "pipe"], // pipe all stdio so stderr can be filtered
  });

  // Keep actionable adapter stderr visible while dropping known non-actionable noise.
  forwardFilteredAdapterStderr(child);

  // Ensure stdin/stdout are available
  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error("Failed to create pipes for agent process");
  }

  // Create ACP client connected to child's stdio
  // Note: From the client's perspective:
  // - stdin is where we READ from (child's stdout)
  // - stdout is where we WRITE to (child's stdin)
  const client = new ACPClient({
    ...clientOptions,
    stdin: child.stdout, // We read from child's stdout
    stdout: child.stdin as NodeJS.WritableStream, // We write to child's stdin
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
    if (!child.killed) {
      child.kill(signal);
    }
  };

  return { client, process: child, kill };
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
    await agent.client.initialize();
    return agent;
  } catch (err) {
    // Clean up on initialization failure
    agent.kill();
    throw err;
  }
}
