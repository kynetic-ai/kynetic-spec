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

// Runner configuration
export {
  type DiagnosticsRetain,
  type EffectiveRunner,
  type EffectiveRunnerRegistry,
  type EffectiveRunnerSources,
  type LayerLoadResult,
  type ProjectRunnerConfig,
  type ProjectRunnerEntry,
  type ResolveRunnersResult,
  type RunnerConfigLayer,
  type RunnerEnvInherit,
  type RunnerFieldOrigin,
  type RunnerKind,
  type SystemRunnerConfig,
  type SystemRunnerEntry,
  PROJECT_RUNNERS_FILENAME,
  SYSTEM_RUNNERS_FILENAME,
  ProjectRunnerConfigSchema,
  SystemRunnerConfigSchema,
  RunnerEnvInheritEnum,
  RunnerKindEnum,
  DiagnosticsRetainEnum,
  deriveProjectKey,
  deriveProjectKeySync,
  getProjectRunnersPath,
  getSystemRunnersPath,
  isSecretEnvName,
  loadProjectRunnerConfig,
  loadSystemRunnerConfig,
  mergeRunnerConfigs,
  resolveEffectiveRunners,
} from "./runner-config.js";
