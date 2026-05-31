/**
 * Runner resolver and invocation contract.
 *
 * One source of truth for runner selection across the daemon, CLI, sessions,
 * and dispatch engine. Resolves an agent definition + effective runner
 * registry into a single invocation contract that downstream callers feed
 * into the ACP spawner.
 *
 * Resolution rules:
 *   - When `adapterOverride` is supplied (e.g., `--adapter` CLI flag), the
 *     resolver takes the implicit/legacy path with the override adapter and
 *     ignores any configured runner.
 *   - When `agent.runner` is set, the resolver looks the name up in the
 *     effective runner registry. Missing names throw
 *     `RunnerResolutionError("unknown_runner")` with guidance pointing at the
 *     project runner config, system runner config, and the agent definition.
 *   - When the runner's adapter is no longer registered, the resolver throws
 *     `RunnerResolutionError("invalid_adapter")`.
 *   - When `agent.runner` is absent, the resolver falls back to
 *     `agent.adapter` (or the documented default `claude-agent-acp`).
 *
 * The resolver is a pure function — it never forwards prompts, opens
 * processes, or mutates files. Spawn happens in `spawnAndInitialize`. The
 * returned `cleanup` hook lets future runner kinds (temp config files,
 * harness state) restore prior state best-effort after the invocation
 * closes.
 *
 * AC: @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution
 * AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
 * AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
 * AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
 * AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
 * AC: @agent-runner-configuration ac-adapter-field-backcompat
 * AC: @agent-runner-configuration ac-runner-precedence-over-adapter
 * AC: @runner-invocation-semantics ac-skill-formatting-uses-resolved-adapter
 * AC: @runner-invocation-semantics ac-auto-approve-from-resolved-contract
 */

import type { Agent } from "../schema/meta.js";
import { getAdapter, resolveAdapter, type AgentAdapter } from "./adapters.js";
import type {
  EffectiveRunner,
  EffectiveRunnerRegistry,
  RunnerFieldOrigin,
} from "./runner-config.js";

/** Built-in adapter id used when neither runner nor adapter is configured. */
export const DEFAULT_ADAPTER_ID = "claude-agent-acp";

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Machine-readable reason codes for resolver failures. Callers (CLI, daemon,
 * dispatch engine) translate these into user guidance + structured telemetry.
 */
export type RunnerResolutionReason =
  | "unknown_runner"
  | "invalid_adapter"
  | "invalid_command_reference"
  | "invalid_cwd"
  | "invalid_args"
  | "missing_secret"
  | "preflight_failure";

export interface RunnerResolutionDetails {
  /** Configured runner name when the failure is runner-scoped. */
  runner?: string;
  /** Adapter id involved in the failure when adapter-scoped. */
  adapter?: string;
  /** Free-form structured details for telemetry. */
  [key: string]: unknown;
}

export class RunnerResolutionError extends Error {
  constructor(
    public readonly reason: RunnerResolutionReason,
    message: string,
    public readonly details: RunnerResolutionDetails = {},
  ) {
    super(message);
    this.name = "RunnerResolutionError";
  }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * Selected-runner descriptor. Records whether the runner came from the
 * agent definition or was implicit (legacy adapter path).
 */
export type SelectedRunnerDiagnostic =
  | { name: string; source: "agent.runner" }
  | { name: null; source: "implicit" };

/**
 * Selected-adapter descriptor. Records whether the adapter came from the
 * runner's adapter field, the agent's legacy adapter field, the built-in
 * default, or a CLI override.
 */
export interface SelectedAdapterDiagnostic {
  id: string;
  source: "runner" | "agent.adapter" | "default" | "override";
}

/**
 * Source-layer summary. `project` and `system` mean only that layer
 * contributed; `merged` means both layers contributed values; `implicit`
 * is the legacy path with no runner config involved.
 */
export type SourceLayerDiagnostic = "project" | "system" | "merged" | "implicit";

/**
 * Diagnostics block returned alongside the invocation contract. Designed
 * for telemetry, structured CLI output, and operator surfaces. Never
 * contains env values, secret material, or prompt content.
 */
export interface RunnerInvocationDiagnostics {
  selectedRunner: SelectedRunnerDiagnostic;
  selectedAdapter: SelectedAdapterDiagnostic;
  sourceLayer: SourceLayerDiagnostic;
  /** Field paths overridden by the system layer (from runner sources). */
  overrides: readonly string[];
  /** Validation issues from the project layer load step, when supplied. */
  projectLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  /** Validation issues from the system layer load step, when supplied. */
  systemLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  /** Field-level origin map for the resolved runner. Absent on the implicit path. */
  fieldOrigins?: {
    kind: RunnerFieldOrigin;
    adapter: RunnerFieldOrigin;
    envInherit: RunnerFieldOrigin;
    envPass: RunnerFieldOrigin;
    /** Per-key origin map for env.set. Values are never recorded. */
    envSetKeys: Record<string, RunnerFieldOrigin>;
    envSecrets: RunnerFieldOrigin | null;
    privacyDisableNonessentialTraffic: RunnerFieldOrigin;
    diagnosticsRetainRawLogs: RunnerFieldOrigin;
  };
}

// ─── Contract types ──────────────────────────────────────────────────────────

export interface ResolveRunnerInvocationInput {
  /** The agent being invoked. */
  agent: Agent;
  /** The effective (merged) runner registry. */
  registry: EffectiveRunnerRegistry;
  /** Invocation working directory. */
  cwd: string;
  /** Pre-assigned session id (injected into env for downstream kspec calls). */
  sessionId: string;
  /** Whether the invocation should request auto-approve adapter behavior. */
  autoApprove: boolean;
  /** Base invocation env (caller-supplied, before runner overlay). */
  env: Record<string, string>;
  /**
   * Explicit adapter override (e.g., `kspec agent run --adapter <id>`).
   * Bypasses runner resolution entirely and uses the override adapter.
   */
  adapterOverride?: string;
  /** Validation issues from the project-layer load step. */
  projectLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  /** Validation issues from the system-layer load step. */
  systemLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
}

/**
 * Resolved invocation contract. The downstream spawner consumes only this
 * shape — it does not re-resolve the runner.
 */
export interface RunnerInvocation {
  /** Configured runner name, or null for the implicit/legacy path. */
  runnerId: string | null;
  /** Resolved adapter id (registered or override). */
  adapterId: string;
  /** The adapter spawn contract (command, args, env, autoApproveArgs). */
  adapter: AgentAdapter;
  /** Invocation working directory. */
  cwd: string;
  /** Complete runner-scoped env overlay for the adapter process. */
  env: Record<string, string>;
  /** Adapter args to append (auto-approve flags + runner process.args). */
  extraArgs: readonly string[];
  /** Diagnostics for telemetry / display. */
  diagnostics: RunnerInvocationDiagnostics;
  /** Optional async cleanup hook — invoked after the session closes. */
  cleanup?: () => Promise<void>;
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve an invocation contract from an agent definition + runner registry.
 *
 * Pure: no I/O, no process spawning, no prompt forwarding. Throws
 * `RunnerResolutionError` with structured reason codes when configuration
 * is invalid.
 */
export function resolveRunnerInvocation(input: ResolveRunnerInvocationInput): RunnerInvocation {
  const {
    agent,
    registry,
    cwd,
    autoApprove,
    env,
    adapterOverride,
    projectLayerIssues,
    systemLayerIssues,
  } = input;

  if (adapterOverride) {
    return buildImplicitContract({
      agent,
      adapterId: adapterOverride,
      adapterSource: "override",
      cwd,
      env,
      autoApprove,
      projectLayerIssues,
      systemLayerIssues,
    });
  }

  if (!agent.runner) {
    const adapterId = agent.adapter ?? DEFAULT_ADAPTER_ID;
    const adapterSource: SelectedAdapterDiagnostic["source"] = agent.adapter
      ? "agent.adapter"
      : "default";
    return buildImplicitContract({
      agent,
      adapterId,
      adapterSource,
      cwd,
      env,
      autoApprove,
      projectLayerIssues,
      systemLayerIssues,
    });
  }

  const runner = registry.runners[agent.runner];
  if (!runner) {
    throw new RunnerResolutionError(
      "unknown_runner",
      `Agent "${agent.id}" references unknown runner "${agent.runner}". ` +
        `Check the project runner config (project.runners.yaml in the kspec ` +
        `shadow worktree), the system runner config (runners.yaml under the ` +
        `daemon config dir), and the agent definition's runner field.`,
      { runner: agent.runner, agent: agent.id },
    );
  }

  const adapter = getAdapter(runner.adapter);
  if (!adapter) {
    throw new RunnerResolutionError(
      "invalid_adapter",
      `Runner "${runner.name}" references adapter "${runner.adapter}" ` +
        `which is not registered. Either register the adapter via ` +
        `registerAdapter() before invocation or update the system runner config.`,
      { runner: runner.name, adapter: runner.adapter },
    );
  }

  return buildRunnerContract({
    runner,
    adapter,
    cwd,
    env,
    autoApprove,
    projectLayerIssues,
    systemLayerIssues,
  });
}

// ─── Builders ────────────────────────────────────────────────────────────────

interface ImplicitContractInputs {
  agent: Agent;
  adapterId: string;
  adapterSource: SelectedAdapterDiagnostic["source"];
  cwd: string;
  env: Record<string, string>;
  autoApprove: boolean;
  projectLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  systemLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
}

function buildImplicitContract(inputs: ImplicitContractInputs): RunnerInvocation {
  const { adapterId, adapterSource, cwd, env, autoApprove } = inputs;
  // resolveAdapter falls back to an ad-hoc npx adapter when the id is not
  // registered — preserved from the legacy code path so adapter ids passed
  // as npm packages still work.
  const adapter = resolveAdapter(adapterId);
  const extraArgs: readonly string[] = autoApprove ? (adapter.autoApproveArgs ?? []) : [];

  const diagnostics: RunnerInvocationDiagnostics = {
    selectedRunner: { name: null, source: "implicit" },
    selectedAdapter: { id: adapterId, source: adapterSource },
    sourceLayer: "implicit",
    overrides: [],
    ...(inputs.projectLayerIssues ? { projectLayerIssues: inputs.projectLayerIssues } : {}),
    ...(inputs.systemLayerIssues ? { systemLayerIssues: inputs.systemLayerIssues } : {}),
  };

  return {
    runnerId: null,
    adapterId,
    adapter,
    cwd,
    env: { ...env },
    extraArgs,
    diagnostics,
    cleanup: noopCleanup,
  };
}

interface RunnerContractInputs {
  runner: EffectiveRunner;
  adapter: AgentAdapter;
  cwd: string;
  env: Record<string, string>;
  autoApprove: boolean;
  projectLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  systemLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
}

function buildRunnerContract(inputs: RunnerContractInputs): RunnerInvocation {
  const { runner, adapter, cwd, env, autoApprove } = inputs;

  const overlayEnv: Record<string, string> = { ...env, ...runner.env.set };

  const autoApproveArgs: readonly string[] = autoApprove ? (adapter.autoApproveArgs ?? []) : [];
  const extraArgs: readonly string[] = [...autoApproveArgs, ...runner.process.args];

  const sourceLayer = computeSourceLayer(runner);

  const fieldOrigins: RunnerInvocationDiagnostics["fieldOrigins"] = {
    kind: runner.sources.kind,
    adapter: runner.sources.adapter,
    envInherit: runner.sources.envInherit,
    envPass: runner.sources.envPass,
    envSetKeys: { ...runner.sources.envSet.keys },
    envSecrets: runner.sources.envSecrets,
    privacyDisableNonessentialTraffic: runner.sources.privacyDisableNonessentialTraffic,
    diagnosticsRetainRawLogs: runner.sources.diagnosticsRetainRawLogs,
  };

  const diagnostics: RunnerInvocationDiagnostics = {
    selectedRunner: { name: runner.name, source: "agent.runner" },
    selectedAdapter: { id: runner.adapter, source: "runner" },
    sourceLayer,
    overrides: [...runner.sources.overriddenBySystem],
    fieldOrigins,
    ...(inputs.projectLayerIssues ? { projectLayerIssues: inputs.projectLayerIssues } : {}),
    ...(inputs.systemLayerIssues ? { systemLayerIssues: inputs.systemLayerIssues } : {}),
  };

  return {
    runnerId: runner.name,
    adapterId: runner.adapter,
    adapter,
    cwd,
    env: overlayEnv,
    extraArgs,
    diagnostics,
    cleanup: noopCleanup,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeSourceLayer(runner: EffectiveRunner): SourceLayerDiagnostic {
  // System always supplies kind+adapter; check whether project contributed
  // any value. The merge step records origin per-field, so we can scan
  // sources for "project" origins.
  const sources = runner.sources;
  const hasProjectContribution =
    sources.privacyDisableNonessentialTraffic === "project" ||
    sources.diagnosticsRetainRawLogs === "project" ||
    Object.values(sources.envSet.keys).some((origin) => origin === "project");

  return hasProjectContribution ? "merged" : "system";
}

function noopCleanup(): Promise<void> {
  return Promise.resolve();
}
