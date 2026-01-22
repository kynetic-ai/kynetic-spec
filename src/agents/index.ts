/**
 * Agent module.
 *
 * Provides utilities for spawning and communicating with ACP-compliant agents.
 */

// Adapters
export {
  type AgentAdapter,
  getAdapter,
  listAdapters,
  registerAdapter,
  resolveAdapter,
} from "./adapters.js";

// Spawner
export {
  type SpawnAgentOptions,
  type SpawnedAgent,
  spawnAgent,
  spawnAndInitialize,
} from "./spawner.js";
