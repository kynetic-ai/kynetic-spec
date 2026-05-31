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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Agent } from "../schema/meta.js";
import { getAdapter, resolveAdapter, type AgentAdapter } from "./adapters.js";
import { SANITIZED_ENV_VARS } from "./spawner.js";
import { createRedactor } from "./redaction.js";
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
  | "unspawnable_command"
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
    /**
     * Origin of `process.executable` (the configured command reference). `null`
     * when the runner did not declare an executable and the adapter's
     * registered command is used.
     *
     * AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
     */
    processExecutable: RunnerFieldOrigin | null;
    /**
     * Origin of `process.args`. `null` when the runner did not declare extra
     * arguments.
     *
     * AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
     */
    processArgs: RunnerFieldOrigin | null;
    /**
     * Origin of `process.cwd`. `null` when the runner did not override the
     * invocation cwd.
     *
     * AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
     */
    processCwd: RunnerFieldOrigin | null;
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
  /**
   * Sanitized env for internal kspec mutation subprocesses (e.g.
   * `kspec task note`, `kspec task block`) spawned during failure and
   * timeout handling. Contains only the kspec-required invocation
   * variables — never resolved `env.secrets`, runner `env.set` literals,
   * `env.pass` host pass-through, or `env.inherit` host vars. The adapter
   * secret boundary stops at the adapter spawn; kspec-internal mutation
   * helpers run with the dispatch contract only.
   *
   * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
   * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
   */
  mutationEnv: Record<string, string>;
  /**
   * Names of env vars resolved from runner `env.secrets` bindings. The
   * adapter spawn consumes these via `env`; every other subprocess kspec
   * spawns (mutation helpers, diagnostic shells) must strip these keys
   * from inherited host env so a `user_env`-sourced binding does not
   * silently leak via `process.env` inheritance even though `mutationEnv`
   * itself contains no secret material.
   *
   * Empty for the implicit/legacy path and for runner contracts that did
   * not resolve any secret bindings.
   *
   * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
   * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
   */
  secretEnvKeys: readonly string[];
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
  const mutationEnv = buildKspecRequiredEnv(sessionId, mutationLockFile);

  return {
    runnerId: null,
    adapterId,
    adapter,
    cwd,
    env: contractEnv,
    mutationEnv,
    // Implicit/legacy path never resolves env.secrets — nothing to strip
    // from host env on mutation subprocess spawn.
    secretEnvKeys: [],
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
  const {
    env: composedEnv,
    secretValues,
    secretEnvKeys,
  } = buildRunnerEnv({
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
    processExecutable: runner.sources.processExecutable,
    processArgs: runner.sources.processArgs,
    processCwd: runner.sources.processCwd,
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

  // Sanitized env for kspec-internal mutation subprocesses. The adapter
  // env (composedEnv) carries the resolved env.secrets, env.set, env.pass,
  // and inherited host vars — none of which belong in the env passed to
  // `kspec task note` or `kspec task block` child processes. Build the
  // mutation env from kspec-required vars only.
  // AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  const mutationEnv = buildKspecRequiredEnv(sessionId, mutationLockFile);

  return {
    runnerId: runner.name,
    adapterId: runner.adapter,
    adapter: effectiveAdapter,
    cwd: effectiveCwd,
    env: composedEnv,
    mutationEnv,
    secretEnvKeys,
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
  /**
   * Env var names that were populated by resolved `env.secrets` bindings.
   * The adapter spawn consumes them through `env`; mutation subprocesses
   * must strip these names from inherited host env so a `user_env` source
   * (which by definition mirrors a host variable) does not leak via
   * `process.env` inheritance.
   *
   * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
   */
  secretEnvKeys: readonly string[];
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
  const secretEnvKeys: string[] = [];
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
    secretEnvKeys.push(envVarName);
  }

  // 7) kspec-required invocation variables — applied last so env.set cannot
  //    accidentally override the dispatch contract.
  applyKspecRequiredEnv(env, sessionId, mutationLockFile);

  return { env, secretValues: Array.from(secretValueSet), secretEnvKeys };
}

/**
 * Build the kspec-required invocation variables. These vars are always
 * present in the resolved contract regardless of runner inheritance/set/
 * secrets configuration so kspec subprocesses spawned by the agent
 * (e.g. `kspec task note`) inherit the dispatch contract.
 *
 * Returned as a fresh dictionary so callers can either overlay onto the
 * adapter env (high precedence) or use it verbatim as the sanitized
 * mutation env for internal kspec subprocesses — which must NEVER inherit
 * resolved `env.secrets`, runner env.set, env.pass, or host inheritance.
 *
 * AC: @runner-environment-secret-boundaries ac-env-inheritance-policy-applied
 * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
 * AC: @runner-invocation-semantics ac-session-env-injected-through-runner
 */
function buildKspecRequiredEnv(
  sessionId: string,
  mutationLockFile: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    KSPEC_NO_DAEMON: "1",
    KSPEC_SESSION_ID: sessionId,
  };
  if (mutationLockFile) {
    env.KSPEC_SHADOW_MUTATION_LOCK_FILE = mutationLockFile;
  }
  return env;
}

/**
 * Overlay the kspec-required invocation variables onto the supplied env
 * map. Thin wrapper around `buildKspecRequiredEnv` used where the adapter
 * env is assembled in place.
 */
function applyKspecRequiredEnv(
  env: Record<string, string>,
  sessionId: string,
  mutationLockFile: string | undefined,
): void {
  Object.assign(env, buildKspecRequiredEnv(sessionId, mutationLockFile));
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

// ─── Executable preflight ────────────────────────────────────────────────────

/**
 * Reason an executable could not be confirmed spawnable. Stable identifiers
 * so callers (CLI, dispatch, daemon, Web UI) can format guidance uniformly.
 */
export type PreflightUnspawnableReason = "not_found" | "not_executable" | "timeout";

export type PreflightExecutableResult =
  | { spawnable: true; resolved: string }
  | { spawnable: false; reason: PreflightUnspawnableReason; message: string };

export interface PreflightExecutableOptions {
  /**
   * Working directory used to resolve relative executable paths. Defaults to
   * `process.cwd()` so callers that do not pass a cwd still resolve sanely.
   */
  cwd?: string;
  /**
   * `PATH`-shaped string consulted when the command is a bare name. Defaults
   * to `process.env.PATH`. Tests pass a controlled value to avoid host-PATH
   * dependence.
   */
  searchPath?: string;
  /**
   * Hard timeout for the spawnability check in milliseconds. The check
   * resolves to `{ spawnable: false, reason: "timeout" }` when the underlying
   * filesystem probes do not complete within this window. Defaults to
   * 1500ms — fast enough to keep dry-run interactive, long enough to cover
   * slow filesystems and network mounts.
   */
  timeoutMs?: number;
}

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 1500;

/**
 * Probe whether `command` can be spawned, bounded by a timeout.
 *
 * - Absolute paths and paths with a directory separator are resolved against
 *   `cwd` (when relative) and then checked for the executable bit.
 * - Bare command names are looked up against `PATH` segment-by-segment until
 *   an executable hit is found.
 * - The whole probe is wrapped in a single timeout race; if filesystem
 *   probes hang (e.g., dead network mount), the result is the `timeout`
 *   diagnostic — never an indefinite hang.
 *
 * AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
 */
export async function preflightExecutable(
  command: string,
  options: PreflightExecutableOptions = {},
): Promise<PreflightExecutableResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const cwd = options.cwd ?? process.cwd();
  const searchPath = options.searchPath ?? process.env.PATH ?? "";

  const work = (async (): Promise<PreflightExecutableResult> => {
    if (!command) {
      return {
        spawnable: false,
        reason: "not_found",
        message: "Executable reference is empty",
      };
    }

    if (path.isAbsolute(command) || command.includes(path.sep)) {
      const resolved = path.isAbsolute(command) ? command : path.resolve(cwd, command);
      return checkAccess(resolved);
    }

    const segments = searchPath.split(path.delimiter).filter((s) => s.length > 0);
    for (const segment of segments) {
      const candidate = path.join(segment, command);
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return { spawnable: true, resolved: candidate };
      } catch {
        // continue searching the next PATH segment
      }
    }
    return {
      spawnable: false,
      reason: "not_found",
      message: `Command "${command}" not found in PATH`,
    };
  })();

  return Promise.race([work, timeoutResult(timeoutMs)]);
}

async function checkAccess(resolvedPath: string): Promise<PreflightExecutableResult> {
  try {
    await fs.access(resolvedPath, fs.constants.X_OK);
    return { spawnable: true, resolved: resolvedPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        spawnable: false,
        reason: "not_found",
        message: `Executable not found: ${resolvedPath}`,
      };
    }
    if (code === "EACCES") {
      return {
        spawnable: false,
        reason: "not_executable",
        message: `Executable bit not set on: ${resolvedPath}`,
      };
    }
    return {
      spawnable: false,
      reason: "not_executable",
      message: `Cannot probe executable ${resolvedPath}: ${(err as Error).message}`,
    };
  }
}

function timeoutResult(ms: number): Promise<PreflightExecutableResult> {
  const diagnostic: PreflightExecutableResult = {
    spawnable: false,
    reason: "timeout",
    message: `Executable spawnability check timed out after ${ms}ms`,
  };
  // A non-positive budget short-circuits to the timeout diagnostic so callers
  // that want to assert "no probe time" get a deterministic typed result
  // without racing the underlying fs.access.
  if (ms <= 0) return Promise.resolve(diagnostic);
  return new Promise<PreflightExecutableResult>((resolve) => {
    const t = setTimeout(() => resolve(diagnostic), ms);
    // Don't keep the event loop alive for the timer itself.
    if (typeof t.unref === "function") t.unref();
  });
}

/**
 * Default PATH the C library (`execvp` / `posix_spawnp`) falls back to when
 * the spawned process env contains no `PATH` key. On Linux/macOS this is
 * `_PATH_DEFPATH` from `<paths.h>` — typically `/usr/bin:/bin`. Mirroring it
 * here keeps bare-command preflight in parity with `child_process.spawn`:
 * when a runner with `env.inherit: none` and no `env.set.PATH` produces a
 * PATH-less child env, spawn would still resolve `sh` / `cat` / `ls`
 * because the libc default path is searched. Treating "PATH absent" as
 * "search nothing" was rejecting commands the child could actually spawn.
 *
 * Windows uses a different lookup model (CreateProcess + PATHEXT) that the
 * preflight probe does not model. Returning an empty default there keeps
 * the bare-name probe conservative ("not found" rather than misreporting).
 */
const POSIX_DEFAULT_SEARCH_PATH = "/usr/bin:/bin";

function defaultSearchPath(): string {
  return process.platform === "win32" ? "" : POSIX_DEFAULT_SEARCH_PATH;
}

/**
 * Compute the PATH the spawned child will see, mirroring `spawnAgent`'s env
 * composition exactly. The runner-backed path uses the contract env verbatim
 * (`inheritParentEnv: false`), so PATH lookup for bare commands must use that
 * same env — not `process.env.PATH`. Otherwise preflight can pass when spawn
 * will fail, or fail when spawn would succeed, whenever the runner's
 * `env.inherit` / `env.set.PATH` differs from the daemon's host PATH.
 *
 * The distinction between "PATH key absent" and "PATH set to empty string"
 * is preserved end-to-end: an absent PATH triggers the spawn-time libc
 * default path (`POSIX_DEFAULT_SEARCH_PATH`), while an explicitly empty PATH
 * searches no segments — matching what Node's spawn actually does in each
 * case.
 */
function resolveInvocationSearchPath(invocation: RunnerInvocation): string {
  // Precedence (low → high) must match spawner.ts:
  //   inheritedHostEnv (only when inheritParentEnv) → adapter.env → contract.env
  let pathValue: string | undefined;
  if (invocation.inheritParentEnv) {
    pathValue = process.env.PATH;
  }
  const adapterPath = invocation.adapter.env?.PATH;
  if (adapterPath !== undefined) pathValue = adapterPath;
  const contractPath = invocation.env.PATH;
  if (contractPath !== undefined) pathValue = contractPath;
  // undefined → no env source set PATH → mirror the libc default path that
  //   `child_process.spawn` (`posix_spawnp` / `execvp`) consults when PATH
  //   is absent from the spawned process env.
  // "" → PATH explicitly set to empty → spawn searches no segments, so
  //   preflight must do the same; preserve the empty string verbatim.
  return pathValue ?? defaultSearchPath();
}

/**
 * Probe the runner invocation contract's executable using the same env-aware
 * PATH lookup the spawn path would consult. Returns `null` when the runner
 * did not configure an executable (implicit/legacy path) so the caller can
 * record the skip without forwarding a synthetic outcome. Never throws —
 * use `preflightRunnerInvocation` for the throwing variant.
 *
 * AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
 */
export async function probeRunnerInvocationExecutable(
  invocation: RunnerInvocation,
  options: PreflightExecutableOptions = {},
): Promise<PreflightExecutableResult | null> {
  const fromConfig = invocation.diagnostics.fieldOrigins?.processExecutable;
  if (!fromConfig) return null;
  return preflightExecutable(invocation.adapter.command, {
    cwd: invocation.cwd,
    searchPath: resolveInvocationSearchPath(invocation),
    ...options,
  });
}

/**
 * Preflight the resolved runner invocation contract. Runs the executable
 * spawnability probe and throws `RunnerResolutionError("unspawnable_command")`
 * when the configured command cannot be spawned. No-op on the implicit/legacy
 * path or when the resolved adapter command did not come from runner config.
 *
 * Bare-command lookup uses the invocation env's PATH (the same PATH Node's
 * `child_process.spawn` will consult given the contract env), not the daemon
 * host's PATH. Runner-backed invocations spawn with `inheritParentEnv: false`,
 * so a runner that scopes PATH via `env.inherit: none` + `env.set.PATH` is
 * what the child actually sees at spawn — preflight mirrors that.
 *
 * AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
 * AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
 */
export async function preflightRunnerInvocation(
  invocation: RunnerInvocation,
  options: PreflightExecutableOptions = {},
): Promise<void> {
  const result = await probeRunnerInvocationExecutable(invocation, options);
  if (!result || result.spawnable) return;

  throw new RunnerResolutionError(
    "unspawnable_command",
    `Runner "${invocation.runnerId ?? "(implicit)"}" configured executable ` +
      `"${invocation.adapter.command}" is not spawnable: ${result.message}.`,
    {
      ...(invocation.runnerId ? { runner: invocation.runnerId } : {}),
      adapter: invocation.adapterId,
      command: invocation.adapter.command,
      unspawnable_reason: result.reason,
    },
  );
}

// ─── Runner invocation summary ───────────────────────────────────────────────

/**
 * Source labels for each process input. Distinguishes runner-config layers
 * from non-runner sources (adapter registry, invocation cwd, auto-approve).
 * Used by diagnostic surfaces (CLI dry-run, dispatch logs, Web UI) to tell
 * operators where each effective input came from without exposing env values.
 */
export type ProcessInputSource =
  | "runner.project"
  | "runner.system"
  | "runner.merged"
  | "adapter"
  | "invocation"
  | "auto_approve"
  | "none";

/**
 * Redacted summary of the runner-resolved process invocation contract.
 *
 * Designed to feed structured diagnostic surfaces (CLI `--dry-run`, dispatch
 * preflight logs, daemon telemetry, Web UI) without exposing env values,
 * secret material, or prompt content. Env entries are reported as key names
 * only — values never leave the contract.
 *
 * AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
 */
export interface RunnerInvocationSummary {
  /** Selected runner identity. `name: null` on the implicit/legacy path. */
  runner: {
    name: string | null;
    source: SelectedRunnerDiagnostic["source"];
  };
  /** Selected adapter identity and where it came from. */
  adapter: {
    id: string;
    source: SelectedAdapterDiagnostic["source"];
  };
  /** Which config layer(s) supplied the effective runner config. */
  source_layer: SourceLayerDiagnostic;
  /** Field paths the system layer overrode from the project layer. */
  overrides: readonly string[];
  /** Process inputs that will be applied around the spawned ACP adapter. */
  process: {
    /** Effective executable path or bare command name to spawn. */
    command: string;
    /** Where the command came from. */
    command_source: ProcessInputSource;
    /** Effective working directory for the child process. */
    cwd: string;
    /** Where the cwd came from. */
    cwd_source: ProcessInputSource;
    /** Extra arguments contributed by the runner's `process.args`. */
    runner_args: readonly string[];
    /** Where the runner args came from. `none` when no runner args were appended. */
    runner_args_source: ProcessInputSource;
    /** Auto-approve args contributed by the adapter when auto-approve is on. */
    auto_approve_args: readonly string[];
  };
  /** Environment policy applied to the spawn. Never contains env values. */
  env_policy: {
    /**
     * Whether the spawner additionally inherits the host process env.
     * `true` on the implicit/legacy path, `false` on the runner-backed path.
     */
    inherit_parent_env: boolean;
    /** Host inheritance policy (runner-backed only). */
    inherit: RunnerEnvInherit | null;
    /** Allow-listed host env keys to pass through (key names only). */
    pass_keys: readonly string[];
    /** Where the pass list came from. `none` when no pass entries are set. */
    pass_source: ProcessInputSource;
    /** Keys whose values were set literally by the runner config. */
    set_keys: readonly string[];
    /** Per-key origin of `env.set` entries. */
    set_keys_origin: Readonly<Record<string, RunnerFieldOrigin>>;
    /** Names of declared secret bindings (variable names only). */
    secret_keys: readonly string[];
    /** Where the secret bindings came from. `none` when no secrets are declared. */
    secret_source: ProcessInputSource;
  };
  /** Preflight outcome for the configured executable, when available. */
  preflight: {
    status: "ok" | "unspawnable" | "skipped";
    /** Typed reason for unspawnable outcome. */
    reason?: PreflightUnspawnableReason;
    /** Human-readable diagnostic message for unspawnable outcome. */
    message?: string;
    /** Resolved absolute path when status is `ok`. */
    resolved?: string;
  };
}

function originToProcessSource(
  origin: RunnerFieldOrigin | null,
  fallback: ProcessInputSource,
): ProcessInputSource {
  if (origin === "project") return "runner.project";
  if (origin === "system") return "runner.system";
  // origin === "default" or null → not contributed by runner config; the
  // caller's fallback (adapter, invocation, none, ...) is the real source.
  return fallback;
}

/**
 * Build a redacted, JSON-safe summary of the resolved runner invocation
 * contract. Intended for diagnostic surfaces that must identify the runner
 * name, resolved adapter, command source, cwd policy, argument source, and
 * env policy without exposing env values or secrets.
 *
 * When `effectiveRunner` is supplied (the lookup from the registry that
 * produced this contract), the summary fills in the runner's full env policy.
 * On the implicit/legacy path or when the runner is not available, env policy
 * fields collapse to their non-runner defaults.
 *
 * When `preflight` is supplied, the summary records the preflight outcome.
 * Callers should run `preflightRunnerInvocation` (or `preflightExecutable`
 * directly) and pass the result so the summary reflects the actual spawnability
 * check the spawn path will see.
 *
 * AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
 * AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
 */
export function summarizeRunnerInvocation(
  contract: RunnerInvocation,
  options: {
    effectiveRunner?: EffectiveRunner;
    preflight?:
      | { status: "ok"; resolved: string }
      | { status: "unspawnable"; reason: PreflightUnspawnableReason; message: string }
      | { status: "skipped" };
  } = {},
): RunnerInvocationSummary {
  const fieldOrigins = contract.diagnostics.fieldOrigins;
  const runner = options.effectiveRunner;

  // The contract's extraArgs is [autoApproveArgs..., runner.process.args...]
  // when runner-backed, or [autoApproveArgs...] alone on the implicit/legacy
  // path. Split it back so each segment can be attributed to its source. When
  // no runner is supplied, assume everything is auto-approve so the runner
  // segment is empty rather than mislabeling adapter args as runner args.
  const runnerArgsLen = runner?.process.args.length ?? 0;
  const autoApproveSegmentLen = Math.max(0, contract.extraArgs.length - runnerArgsLen);
  const splitAutoApproveArgs: readonly string[] = contract.extraArgs.slice(
    0,
    autoApproveSegmentLen,
  );
  const splitRunnerArgs: readonly string[] = contract.extraArgs.slice(autoApproveSegmentLen);

  const passKeys: readonly string[] = runner?.env.pass ?? [];
  const setKeys: readonly string[] = runner ? Object.keys(runner.env.set) : [];
  const setKeysOrigin: Record<string, RunnerFieldOrigin> = fieldOrigins?.envSetKeys
    ? { ...fieldOrigins.envSetKeys }
    : {};
  const secretKeys: readonly string[] = runner ? Object.keys(runner.env.secrets) : [];

  return {
    runner: {
      name: contract.diagnostics.selectedRunner.name,
      source: contract.diagnostics.selectedRunner.source,
    },
    adapter: {
      id: contract.diagnostics.selectedAdapter.id,
      source: contract.diagnostics.selectedAdapter.source,
    },
    source_layer: contract.diagnostics.sourceLayer,
    overrides: [...contract.diagnostics.overrides],
    process: {
      command: contract.adapter.command,
      command_source: originToProcessSource(fieldOrigins?.processExecutable ?? null, "adapter"),
      cwd: contract.cwd,
      cwd_source: originToProcessSource(fieldOrigins?.processCwd ?? null, "invocation"),
      runner_args: [...splitRunnerArgs],
      runner_args_source: originToProcessSource(fieldOrigins?.processArgs ?? null, "none"),
      auto_approve_args: [...splitAutoApproveArgs],
    },
    env_policy: {
      inherit_parent_env: contract.inheritParentEnv,
      inherit: runner ? runner.env.inherit : null,
      pass_keys: [...passKeys],
      pass_source:
        passKeys.length > 0 ? originToProcessSource(fieldOrigins?.envPass ?? null, "none") : "none",
      set_keys: [...setKeys],
      set_keys_origin: setKeysOrigin,
      secret_keys: [...secretKeys],
      secret_source:
        secretKeys.length > 0
          ? originToProcessSource(fieldOrigins?.envSecrets ?? null, "none")
          : "none",
    },
    preflight: options.preflight ?? { status: "skipped" },
  };
}
