/**
 * Agent spawner.
 *
 * Spawns ACP-compliant agent processes and initializes the ACP client
 * for bidirectional JSON-RPC communication.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { ACPClient, type ACPClientOptions } from '../acp/index.js';
import type { AgentAdapter } from './adapters.js';

/**
 * Options for spawning an agent.
 */
export interface SpawnAgentOptions {
  /** Working directory for the agent */
  cwd: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** ACP client options */
  clientOptions?: Omit<ACPClientOptions, 'stdin' | 'stdout'>;
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
  options: SpawnAgentOptions
): SpawnedAgent {
  const { cwd, env = {}, clientOptions = {} } = options;

  // Merge environment variables
  const processEnv = {
    ...process.env,
    ...adapter.env,
    ...env,
  };

  // Spawn the agent process
  const child = spawn(adapter.command, adapter.args, {
    cwd,
    env: processEnv,
    shell: adapter.shell,
    stdio: ['pipe', 'pipe', 'inherit'], // pipe stdin/stdout, inherit stderr
  });

  // Ensure stdin/stdout are available
  if (!child.stdin || !child.stdout) {
    child.kill();
    throw new Error('Failed to create pipes for agent process');
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

  // Forward process exit to client close
  child.on('exit', () => {
    if (!client.isClosed()) {
      client.close();
    }
  });

  // Kill function with graceful shutdown
  const kill = (signal: NodeJS.Signals = 'SIGTERM'): void => {
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
  options: SpawnAgentOptions
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
