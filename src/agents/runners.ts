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
import { createRedactor } from "./redaction.js";
import type {
  EffectiveRunner,
  EffectiveRunnerRegistry,
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

/**
 * Default privacy / telemetry suppression variables applied when the
 * effective runner has `privacy.disable_nonessential_traffic: true` and the
 * key is not overridden via `env.set`. Inheritance/pass values for these
 * names are overwritten because the privacy directive is a runner-policy
 * statement that should override host signals.
 *
 * AC: @runner-environment-secret-boundaries ac-privacy-defaults-applied
 */
export const PRIVACY_DEFAULT_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1",
} as const;

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
  /**
   * Shared shadow-mutation lock file path. When supplied, the resolver writes
   * `KSPEC_SHADOW_MUTATION_LOCK_FILE` into the contract env as part of the
   * kspec-required invocation variables (highest precedence — env.set cannot
   * override it).
   *
   * AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
   * AC: @runner-invocation-semantics ac-session-env-injected-through-runner
   */
  mutationLockFile?: string;
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
  /**
   * Scrubber that replaces any resolved secret value in arbitrary diagnostic
   * text with the `[REDACTED]` marker. CLI output, session events, task
   * notes, daemon responses, and Web UI payloads must run free-form strings
   * derived from this invocation through `redact()` before persisting them.
   *
   * The redactor captures the resolved secret values at contract construction
   * time; the underlying values are never re-exposed by this closure.
   * Implicit/legacy invocations (no `env.secrets`) receive a no-op redactor.
   *
   * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
   */
  redact: (text: string) => string;
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
    sessionId,
    autoApprove,
    env,
    adapterOverride,
    hostEnv = process.env,
    mutationLockFile,
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
      sessionId,
      mutationLockFile,
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
      sessionId,
      mutationLockFile,
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
    sessionId,
    mutationLockFile,
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
  sessionId: string;
  mutationLockFile?: string;
  autoApprove: boolean;
  projectLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  systemLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
}

function buildImplicitContract(inputs: ImplicitContractInputs): RunnerInvocation {
  const { adapterId, adapterSource, cwd, env, sessionId, mutationLockFile, autoApprove } = inputs;
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

  // Implicit/legacy invocations route the session id through the resolver
  // contract instead of having the caller overlay it at spawn time. Other
  // runner-policy features (env.inherit, env.set, env.secrets, privacy
  // defaults) do not apply on the implicit path — the spawner inherits the
  // host process env directly.
  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  const contractEnv: Record<string, string> = { ...env };
  applyKspecRequiredEnv(contractEnv, sessionId, mutationLockFile);

  return {
    runnerId: null,
    adapterId,
    adapter,
    cwd,
    env: contractEnv,
    extraArgs,
    // Implicit/legacy path keeps the pre-runner-config behavior where the
    // spawner inherits the host process env. Runner-backed invocations turn
    // this off so env.inherit policy is the only source of host vars.
    inheritParentEnv: true,
    diagnostics,
    // No resolved secrets on the implicit path — redact is a no-op.
    redact: createRedactor([]),
    cleanup: noopCleanup,
  };
}

interface RunnerContractInputs {
  runner: EffectiveRunner;
  adapter: AgentAdapter;
  cwd: string;
  env: Record<string, string>;
  hostEnv: NodeJS.ProcessEnv;
  sessionId: string;
  mutationLockFile?: string;
  autoApprove: boolean;
  projectLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
  systemLayerIssues?: ReadonlyArray<{ path: string; message: string }>;
}

function buildRunnerContract(inputs: RunnerContractInputs): RunnerInvocation {
  const { runner, adapter, cwd, env, hostEnv, sessionId, mutationLockFile, autoApprove } = inputs;

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

  // Build the child env per the runner contract. The spawner consumes this
  // env verbatim (inheritParentEnv: false), so any variable not assembled
  // here will not reach the child. Required-secret failures throw before any
  // adapter spawn happens.
  // AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
  // AC: @runner-environment-secret-boundaries ac-env-set-overrides-allowed-values
  // AC: @runner-environment-secret-boundaries ac-privacy-defaults-applied
  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  // AC: @runner-invocation-semantics ac-session-env-injected-through-runner
  const { env: composedEnv, secretValues } = buildRunnerEnv({
    runner,
    baseEnv: env,
    hostEnv,
    sessionId,
    mutationLockFile,
  });

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
    // Capture resolved secret values so downstream diagnostic writers can
    // scrub free-form text without re-handling the values.
    // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
    redact: createRedactor(secretValues),
    cleanup: noopCleanup,
  };
}

// ─── Env builder ─────────────────────────────────────────────────────────────

export interface BuildRunnerEnvInput {
  /** Effective runner whose env policy is being applied. */
  runner: EffectiveRunner;
  /**
   * Caller-supplied base invocation env (e.g. process-level overrides). Goes
   * after host inheritance/pass and before runner env.set. The KSPEC required
   * invocation variables are NOT taken from this map — they come from
   * `sessionId` and `mutationLockFile` and overlay at the very end.
   */
  baseEnv: Readonly<Record<string, string>>;
  /** Host env snapshot used for `env.inherit` and `env.pass`. */
  hostEnv: NodeJS.ProcessEnv;
  /** Pre-assigned session id for `KSPEC_SESSION_ID` injection. */
  sessionId: string;
  /** Shared shadow-mutation lock file path, when supplied by the caller. */
  mutationLockFile?: string;
}

export interface BuildRunnerEnvResult {
  /** Final env dictionary that the spawner consumes verbatim. */
  env: Record<string, string>;
  /**
   * Distinct secret values resolved during the build, in no particular order.
   * Callers feed these into `createRedactor()` so downstream diagnostics can
   * scrub them. The values themselves never appear in `BuildRunnerEnvInput`
   * or any returned diagnostic.
   *
   * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
   */
  secretValues: readonly string[];
}

/**
 * Build the child-process env for a runner-backed invocation. The precedence
 * (low → high) is:
 *
 *   1. host inheritance per `env.inherit` (`none` / `minimal` / `ambient`),
 *      minus the SANITIZED_ENV_VARS that interfere with adapter startup
 *   2. `env.pass` host pass-through (specific allowed names regardless of
 *      inherit policy), also minus SANITIZED_ENV_VARS
 *   3. caller-supplied base invocation env
 *   4. `env.set` literals from runner config (operator-controlled overrides)
 *   5. privacy defaults when `privacy.disable_nonessential_traffic` is true
 *      and the key is not already present in `env.set` (privacy directives
 *      override inheritance/pass for these names)
 *   6. resolved `env.secrets` bindings (required bindings whose source
 *      cannot be resolved throw `RunnerResolutionError("missing_secret")`)
 *   7. kspec-required invocation variables: `KSPEC_NO_DAEMON=1`,
 *      `KSPEC_SESSION_ID=<sessionId>`, and `KSPEC_SHADOW_MUTATION_LOCK_FILE`
 *      when supplied. These are always present so `env.set` cannot
 *      accidentally override the kspec dispatch contract.
 *
 * Nested-agent variables listed in SANITIZED_ENV_VARS (CLAUDECODE,
 * CLAUDE_CODE_SESSION) are stripped from host inheritance and `env.pass`
 * before any inheritance policy is applied; this preserves the pre-runner
 * spawner behavior so runner-launched adapters do not detect a nested
 * session.
 *
 * AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
 * AC: @runner-environment-secret-boundaries ac-env-set-overrides-allowed-values
 * AC: @runner-environment-secret-boundaries ac-privacy-defaults-applied
 * AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
 * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
 * AC: @runner-invocation-semantics ac-session-env-injected-through-runner
 */
export function buildRunnerEnv(input: BuildRunnerEnvInput): BuildRunnerEnvResult {
  const { runner, baseEnv, hostEnv, sessionId, mutationLockFile } = input;
  const env: Record<string, string> = {};
  const sanitized = new Set<string>(SANITIZED_ENV_VARS);

  // 1) Host inheritance per env.inherit. SANITIZED_ENV_VARS are stripped
  //    before any inheritance policy applies — runner-launched adapters
  //    must not detect a nested-agent host session.
  if (runner.env.inherit === "ambient") {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value === undefined) continue;
      if (sanitized.has(key)) continue;
      env[key] = value;
    }
  } else if (runner.env.inherit === "minimal") {
    for (const key of MINIMAL_INHERIT_ENV_KEYS) {
      if (sanitized.has(key)) continue;
      const value = hostEnv[key];
      if (value === undefined) continue;
      env[key] = value;
    }
  }
  // "none" → no host inheritance.

  // 2) env.pass: forced host pass-through, also stripped of SANITIZED_ENV_VARS.
  for (const key of runner.env.pass) {
    if (sanitized.has(key)) continue;
    const value = hostEnv[key];
    if (value === undefined) continue;
    env[key] = value;
  }

  // 3) Caller-supplied base invocation env.
  for (const [key, value] of Object.entries(baseEnv)) {
    env[key] = value;
  }

  // 4) env.set literals from runner config.
  for (const [key, value] of Object.entries(runner.env.set)) {
    env[key] = value;
  }

  // 5) Privacy defaults: applied when disable_nonessential_traffic is true
  //    and the key is not explicitly set in env.set. Privacy directives
  //    override inheritance/pass/base for these names so a host signal does
  //    not silently undo the runner's policy.
  if (runner.privacy.disable_nonessential_traffic) {
    const explicitSetKeys = new Set(Object.keys(runner.env.set));
    for (const [key, value] of Object.entries(PRIVACY_DEFAULT_ENV)) {
      if (explicitSetKeys.has(key)) continue;
      env[key] = value;
    }
  }

  // 6) Resolve declared secret bindings.
  const secretValueSet = new Set<string>();
  for (const [envVarName, binding] of Object.entries(runner.env.secrets)) {
    const value = lookupSecretValue(binding.source, envVarName, hostEnv);
    if (value === undefined) {
      if (binding.required) {
        throw new RunnerResolutionError(
          "missing_secret",
          `Runner "${runner.name}" requires secret binding "${envVarName}" ` +
            `from source "${binding.source}", but the value could not be resolved. ` +
            `Verify the secret source is configured in the system runner config ` +
            `and that the named source can supply a value for this variable.`,
          { runner: runner.name, secret_var: envVarName, source: binding.source },
        );
      }
      continue;
    }
    env[envVarName] = value;
    secretValueSet.add(value);
  }

  // 7) kspec-required invocation variables — applied last so env.set cannot
  //    accidentally override the dispatch contract.
  applyKspecRequiredEnv(env, sessionId, mutationLockFile);

  return { env, secretValues: Array.from(secretValueSet) };
}

/**
 * Overlay the kspec-required invocation variables onto the supplied env
 * map. These vars are always present in the resolved contract regardless
 * of runner inheritance/set/secrets configuration so kspec subprocesses
 * spawned by the agent (e.g. `kspec task note`) inherit the dispatch
 * contract.
 *
 * AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
 * AC: @runner-invocation-semantics ac-session-env-injected-through-runner
 */
function applyKspecRequiredEnv(
  env: Record<string, string>,
  sessionId: string,
  mutationLockFile: string | undefined,
): void {
  env.KSPEC_NO_DAEMON = "1";
  env.KSPEC_SESSION_ID = sessionId;
  if (mutationLockFile) {
    env.KSPEC_SHADOW_MUTATION_LOCK_FILE = mutationLockFile;
  }
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
