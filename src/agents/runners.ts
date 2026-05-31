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
 * AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
 */

import type { Agent } from "../schema/meta.js";
import { getAdapter, resolveAdapter, type AgentAdapter } from "./adapters.js";
import { SANITIZED_ENV_VARS } from "./spawner.js";
import type {
  EffectiveRunner,
  EffectiveRunnerRegistry,
  RunnerEnvInherit,
  RunnerFieldOrigin,
} from "./runner-config.js";

/** Built-in adapter id used when neither runner nor adapter is configured. */
export const DEFAULT_ADAPTER_ID = "claude-agent-acp";

/**
 * Variable names inherited when `env.inherit: minimal`. Intentionally narrow:
 * just the locale, shell, and command-resolution basics a spawned process
 * needs to operate. Operators add anything else explicitly via `env.pass` or
 * `env.set`.
 */
export const MINIMAL_INHERIT_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
] as const;

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
  /**
   * Host environment snapshot used to apply `env.inherit` and `env.pass`. Defaults
   * to `process.env` when omitted. Tests pass an explicit snapshot to avoid host
   * leakage in assertions.
   */
  hostEnv?: NodeJS.ProcessEnv;
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
  /**
   * Adapter spawn contract (command, args, env, autoApproveArgs).
   *
   * When the resolved runner sets `process.executable`, the contract returns a
   * shallow clone of the registered adapter with `command` replaced. This way
   * the spawner does not need to know about runner.process — it spawns the
   * adapter exactly as described.
   */
  adapter: AgentAdapter;
  /**
   * Invocation working directory. Equals `runner.process.cwd` when set, else
   * the caller's invocation cwd. The spawner does not consult runner state.
   */
  cwd: string;
  /**
   * Complete runner-scoped env for the adapter process. Composed from the
   * effective runner's `env.inherit` policy, `env.pass` host pass-through,
   * caller-supplied invocation env, `env.set` literals, and resolved
   * `env.secrets` bindings (in that order of increasing precedence).
   * Required secret bindings whose source cannot be resolved cause the
   * resolver to throw `missing_secret` before the spawn contract is
   * returned.
   */
  env: Record<string, string>;
  /** Adapter args to append (auto-approve flags + runner process.args). */
  extraArgs: readonly string[];
  /**
   * Whether the spawner should additionally inherit the host process env.
   *
   * - `true` on the implicit/legacy path: spawner merges `process.env` under
   *   the contract env (preserves pre-runner-config behavior).
   * - `false` on the runner-backed path: spawner uses the contract env
   *   verbatim. Required so `env.inherit: none`/`minimal` policies are
   *   enforced rather than overwritten by host process env at spawn time.
   *
   * AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
   */
  inheritParentEnv: boolean;
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
    hostEnv = process.env,
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
    hostEnv,
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
    // Implicit/legacy path keeps the pre-runner-config behavior where the
    // spawner inherits the host process env. Runner-backed invocations turn
    // this off so env.inherit policy is the only source of host vars.
    inheritParentEnv: true,
    diagnostics,
    cleanup: noopCleanup,
  };
}

interface RunnerContractInputs {
  runner: EffectiveRunner;
  adapter: AgentAdapter;
  cwd: string;
  env: Record<string, string>;
  hostEnv: NodeJS.ProcessEnv;
  autoApprove: boolean;
  projectLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  systemLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
}

function buildRunnerContract(inputs: RunnerContractInputs): RunnerInvocation {
  const { runner, adapter, cwd, env, hostEnv, autoApprove } = inputs;

  // Replace the adapter command when runner.process.executable is set. The
  // returned adapter is a shallow clone so the registered adapter shared by
  // other invocations remains untouched.
  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  const effectiveAdapter: AgentAdapter = runner.process.executable
    ? { ...adapter, command: runner.process.executable }
    : adapter;

  // Apply runner.process.cwd when set so the spawned process runs in the
  // operator-configured directory.
  // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
  const effectiveCwd: string = runner.process.cwd ?? cwd;

  // Compose the child env per the inheritance policy. The spawner consumes
  // this env verbatim (inheritParentEnv: false), so any host variable that
  // is not listed here will not reach the child.
  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  // AC: @runner-environment-secret-boundaries ac-env-set-overrides-allowed-values
  const composedEnv = composeRunnerEnv({
    inherit: runner.env.inherit,
    pass: runner.env.pass,
    setEntries: runner.env.set,
    baseEnv: env,
    hostEnv,
  });

  // Resolve declared secret bindings. Required bindings that cannot be
  // resolved throw `missing_secret` so the invocation is blocked before any
  // prompt content reaches the adapter. Optional bindings that fail to
  // resolve are silently omitted (operator's explicit opt-in).
  //
  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  const secretEnv = resolveSecretEnv({
    secrets: runner.env.secrets,
    hostEnv,
    runnerName: runner.name,
  });
  // Secret values take final precedence over env.set literals so a runner
  // that binds the same key both ways receives the resolved secret value.
  for (const [key, value] of Object.entries(secretEnv)) {
    composedEnv[key] = value;
  }

  const autoApproveArgs: readonly string[] = autoApprove
    ? (effectiveAdapter.autoApproveArgs ?? [])
    : [];
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
    adapter: effectiveAdapter,
    cwd: effectiveCwd,
    env: composedEnv,
    extraArgs,
    // Runner-backed: spawner uses the contract env verbatim so env.inherit
    // policy is the only source of host environment in the child.
    inheritParentEnv: false,
    diagnostics,
    cleanup: noopCleanup,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compose the child-process env from the runner's inheritance policy. The
 * precedence (low → high) is:
 *
 *   1. host inheritance per `env.inherit` (`none` / `minimal` / `ambient`),
 *      minus the SANITIZED_ENV_VARS that interfere with adapter startup
 *   2. `env.pass` host pass-through (specific allowed names regardless of
 *      inherit policy)
 *   3. caller-supplied invocation env (kspec-required vars like
 *      KSPEC_NO_DAEMON, KSPEC_SHADOW_MUTATION_LOCK_FILE)
 *   4. `env.set` literals from runner config (operator-controlled overrides)
 *
 * Secret bindings (`env.secrets`) are resolved by `resolveSecretEnv` after
 * this function returns; resolved secret values overlay the composed env
 * with the highest precedence. Required bindings that cannot be resolved
 * cause the resolver to throw `missing_secret`.
 *
 * AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
 * AC: @runner-environment-secret-boundaries ac-env-set-overrides-allowed-values
 */
function composeRunnerEnv(params: {
  inherit: RunnerEnvInherit;
  pass: readonly string[];
  setEntries: Readonly<Record<string, string>>;
  baseEnv: Record<string, string>;
  hostEnv: NodeJS.ProcessEnv;
}): Record<string, string> {
  const { inherit, pass, setEntries, baseEnv, hostEnv } = params;
  const result: Record<string, string> = {};
  const sanitized = new Set<string>(SANITIZED_ENV_VARS);

  if (inherit === "ambient") {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value === undefined) continue;
      if (sanitized.has(key)) continue;
      result[key] = value;
    }
  } else if (inherit === "minimal") {
    for (const key of MINIMAL_INHERIT_ENV_KEYS) {
      const value = hostEnv[key];
      if (value === undefined) continue;
      if (sanitized.has(key)) continue;
      result[key] = value;
    }
  }
  // "none" → no host inheritance.

  for (const key of pass) {
    if (sanitized.has(key)) continue;
    const value = hostEnv[key];
    if (value === undefined) continue;
    result[key] = value;
  }

  for (const [key, value] of Object.entries(baseEnv)) {
    result[key] = value;
  }

  for (const [key, value] of Object.entries(setEntries)) {
    result[key] = value;
  }

  return result;
}

/**
 * Resolve declared secret bindings into env values. Throws
 * `RunnerResolutionError("missing_secret")` for any binding marked
 * `required: true` whose source cannot be resolved.
 *
 * Supported source kinds:
 *   - `user_env`: read from `hostEnv[envVarName]`. The binding key names the
 *     child env var; the source is the host env entry with the same name.
 *
 * Unknown sources are treated as unresolved. Optional (`required: false`)
 * bindings that fail to resolve are silently omitted — this preserves the
 * explicit opt-in contract for operator-configured fallbacks.
 *
 * AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
 * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
 */
function resolveSecretEnv(params: {
  secrets: Readonly<Record<string, { source: string; required: boolean }>>;
  hostEnv: NodeJS.ProcessEnv;
  runnerName: string;
}): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [envVarName, binding] of Object.entries(params.secrets)) {
    const value = lookupSecretValue(binding.source, envVarName, params.hostEnv);
    if (value === undefined) {
      if (binding.required) {
        throw new RunnerResolutionError(
          "missing_secret",
          `Runner "${params.runnerName}" requires secret binding "${envVarName}" ` +
            `from source "${binding.source}", but the value could not be resolved. ` +
            `Verify the secret source is configured in the system runner config ` +
            `and that the named source can supply a value for this variable.`,
          { runner: params.runnerName, secret_var: envVarName, source: binding.source },
        );
      }
      continue;
    }
    resolved[envVarName] = value;
  }
  return resolved;
}

/**
 * Resolve a single secret binding's value from the named source. Returns
 * `undefined` when the source is unknown or the source cannot supply a
 * value for `envVarName`.
 */
function lookupSecretValue(
  source: string,
  envVarName: string,
  hostEnv: NodeJS.ProcessEnv,
): string | undefined {
  if (source === "user_env") {
    return hostEnv[envVarName];
  }
  return undefined;
}

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
