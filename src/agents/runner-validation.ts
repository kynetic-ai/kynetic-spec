/**
 * Runner validation surface.
 *
 * Reuses the runner resolver in a non-spawning mode so operator-facing
 * surfaces (`kspec agent runners validate`, `kspec agent list`, and the
 * dry-run preview) report the same validation outcome the dispatch engine
 * would observe just before spawn. Every diagnostic is redacted via the
 * resolver's secret scrubber so no secret value leaks into CLI output,
 * JSON payloads, or persisted notes.
 *
 * AC: @runner-operator-surfaces ac-agent-list-shows-runner
 * AC: @runner-operator-surfaces ac-runner-validation-human-output
 * AC: @runner-operator-surfaces ac-runner-validation-json-output
 * AC: @runner-operator-surfaces ac-runner-validation-exit-status
 * AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 *
 * @module
 */

import { ulid } from "ulid";
import { getAdapter, listAdapters } from "./adapters.js";
import type {
  EffectiveRunner,
  EffectiveRunnerRegistry,
  ResolveRunnersResult,
  RunnerFieldOrigin,
} from "./runner-config.js";
import {
  probeRunnerInvocationExecutable,
  resolveRunnerInvocation,
  RunnerResolutionError,
  type PreflightExecutableResult,
  type RunnerResolutionReason,
} from "./runners.js";
import { AgentSchema, type Agent } from "../schema/meta.js";

/**
 * Stable identifiers for the per-source attribution of a validated runner.
 * Mirrors the dry-run summary's `ProcessInputSource` vocabulary so operator
 * surfaces can render the same labels across both diagnostic flows.
 */
export type RunnerFieldSource =
  | "runner.project"
  | "runner.system"
  | "runner.merged"
  | "adapter"
  | "invocation"
  | "auto_approve"
  | "none";

function originToFieldSource(
  origin: RunnerFieldOrigin | null | undefined,
  fallback: RunnerFieldSource,
): RunnerFieldSource {
  if (origin === "project") return "runner.project";
  if (origin === "system") return "runner.system";
  return fallback;
}

/**
 * Issue raised against a single runner during validation. Each issue carries
 * a stable `reason` code paired with an actionable, redacted `message` that
 * names the misconfiguration and points at the layer that owns the fix.
 *
 * AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
 */
export interface RunnerValidationIssue {
  /** Stable reason code so structured callers can branch without parsing text. */
  reason: RunnerResolutionReason | "missing_adapter_registration";
  /** Operator-facing diagnostic — already redacted of any secret material. */
  message: string;
  /** Free-form structured details for telemetry. Never contains secret values. */
  details?: Readonly<Record<string, unknown>>;
}

/**
 * Per-runner validation entry. Designed for both JSON and human-readable
 * surfaces — names match the JSON schema declared in the
 * `ac-runner-validation-json-output` acceptance criterion.
 */
export interface RunnerValidationEntry {
  /** Configured runner name. */
  runner: string;
  /** Effective runner kind (only `acp_process` in the current plan). */
  kind: string;
  /** Resolved adapter identity that the runner will spawn. */
  resolved_adapter: string;
  /** Source attribution for the configured executable. */
  command_source: RunnerFieldSource;
  /** Source attribution for the configured working directory. */
  cwd_source: RunnerFieldSource;
  /** Source attribution for the appended runner args. */
  args_source: RunnerFieldSource;
  /** Aggregate runner validation outcome. */
  status: "valid" | "invalid";
  /** Per-field source map for fields the resolver carried into the contract. */
  sources: {
    kind: RunnerFieldOrigin;
    adapter: RunnerFieldOrigin;
    process_executable: RunnerFieldOrigin | null;
    process_args: RunnerFieldOrigin | null;
    process_cwd: RunnerFieldOrigin | null;
    env_inherit: RunnerFieldOrigin;
    env_pass: RunnerFieldOrigin;
    env_set_keys: Readonly<Record<string, RunnerFieldOrigin>>;
    env_secrets: RunnerFieldOrigin | null;
    privacy_disable_nonessential_traffic: RunnerFieldOrigin;
    diagnostics_retain_raw_logs: RunnerFieldOrigin;
  };
  /** Field paths the system layer overrode from the project layer. */
  overrides: readonly string[];
  /** Redacted diagnostics issues, empty when the runner is valid. */
  diagnostics: readonly RunnerValidationIssue[];
}

/**
 * Top-level validation report consumed by CLI surfaces. Carries both per-runner
 * entries and report-level issues that are not scoped to a single runner
 * (e.g. project/system layer YAML validation errors).
 */
export interface RunnerValidationReport {
  /** True when every selected runner reports `status: "valid"` and no report-level issues exist. */
  ok: boolean;
  /** Validation entries, one per selected runner. */
  runners: readonly RunnerValidationEntry[];
  /** Issues raised against the registry as a whole rather than a single runner. */
  issues: readonly RunnerValidationIssue[];
}

/**
 * Synthetic agent definition used to drive `resolveRunnerInvocation` against
 * a single named runner. We need a populated `id`, `name`, and `runner` so
 * the resolver follows the runner-backed path instead of the implicit one;
 * everything else inherits the agent schema defaults.
 */
function syntheticAgentForRunner(runnerName: string): Agent {
  return AgentSchema.parse({
    _ulid: ulid(),
    id: `__validate_${runnerName}`,
    name: `Validate ${runnerName}`,
    runner: runnerName,
  });
}

interface ValidateRunnerOptions {
  /** Working directory the resolver should record as the invocation cwd. */
  cwd: string;
}

const IDENTITY_REDACTOR = (text: string): string => text;

async function validateOneRunner(
  runner: EffectiveRunner,
  registry: EffectiveRunnerRegistry,
  options: ValidateRunnerOptions,
): Promise<RunnerValidationEntry> {
  const issues: RunnerValidationIssue[] = [];
  let contract;
  let redactor: (text: string) => string = IDENTITY_REDACTOR;

  try {
    contract = resolveRunnerInvocation({
      agent: syntheticAgentForRunner(runner.name),
      registry,
      cwd: options.cwd,
      sessionId: ulid(),
      autoApprove: false,
      env: {},
    });
    redactor = contract.redact;
  } catch (err) {
    if (err instanceof RunnerResolutionError) {
      issues.push({
        reason: err.reason,
        message: err.message,
        details: redactDetails(err.details, redactor),
      });
    } else {
      issues.push({
        reason: "preflight_failure",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (contract && !getAdapter(contract.adapterId)) {
    issues.push({
      reason: "missing_adapter_registration",
      message:
        `Resolved adapter "${contract.adapterId}" is not a registered adapter. ` +
        `Registered adapters: ${listAdapters().join(", ")}. ` +
        `Update the system runner config or register the adapter before invocation.`,
      details: { runner: runner.name, adapter: contract.adapterId },
    });
  }

  if (contract && contract.diagnostics.fieldOrigins?.processExecutable) {
    let probeResult: PreflightExecutableResult | null = null;
    try {
      probeResult = await probeRunnerInvocationExecutable(contract);
    } catch (err) {
      issues.push({
        reason: "preflight_failure",
        message: redactor(err instanceof Error ? err.message : String(err)),
        details: { runner: runner.name, adapter: contract.adapterId },
      });
    }
    if (probeResult && !probeResult.spawnable) {
      issues.push({
        reason: "unspawnable_command",
        message: redactor(
          `Configured executable "${contract.adapter.command}" is not spawnable: ${probeResult.message}.`,
        ),
        details: {
          runner: runner.name,
          adapter: contract.adapterId,
          command: contract.adapter.command,
          unspawnable_reason: probeResult.reason,
        },
      });
    }
  }

  const fieldOrigins = contract?.diagnostics.fieldOrigins ?? null;
  const sources: RunnerValidationEntry["sources"] = {
    kind: fieldOrigins?.kind ?? runner.sources.kind,
    adapter: fieldOrigins?.adapter ?? runner.sources.adapter,
    process_executable: runner.sources.processExecutable,
    process_args: runner.sources.processArgs,
    process_cwd: runner.sources.processCwd,
    env_inherit: runner.sources.envInherit,
    env_pass: runner.sources.envPass,
    env_set_keys: { ...runner.sources.envSet.keys },
    env_secrets: runner.sources.envSecrets,
    privacy_disable_nonessential_traffic: runner.sources.privacyDisableNonessentialTraffic,
    diagnostics_retain_raw_logs: runner.sources.diagnosticsRetainRawLogs,
  };

  const overrides: readonly string[] = [...runner.sources.overriddenBySystem];

  const status: RunnerValidationEntry["status"] = issues.length === 0 ? "valid" : "invalid";
  const resolvedAdapter = contract?.adapterId ?? runner.adapter;

  return {
    runner: runner.name,
    kind: runner.kind,
    resolved_adapter: resolvedAdapter,
    command_source: originToFieldSource(runner.sources.processExecutable, "adapter"),
    cwd_source: originToFieldSource(runner.sources.processCwd, "invocation"),
    args_source: originToFieldSource(runner.sources.processArgs, "none"),
    status,
    sources,
    overrides,
    diagnostics: issues.map((issue) => ({
      reason: issue.reason,
      message: redactor(issue.message),
      ...(issue.details ? { details: issue.details } : {}),
    })),
  };
}

function redactDetails(
  details: Readonly<Record<string, unknown>> | undefined,
  redactor: (text: string) => string,
): Readonly<Record<string, unknown>> | undefined {
  if (!details) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") {
      out[key] = redactor(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface BuildRunnerValidationOptions {
  /** Working directory passed through to the resolver. */
  cwd: string;
  /**
   * Optional name filter. When provided, only the named runner is validated.
   * An unknown name produces an `unknown_runner` report-level issue and
   * `ok: false`.
   *
   * AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
   */
  runner?: string;
}

/**
 * Produce a validation report for the given runner registry. Reuses the
 * runner resolver in validation mode so the report exactly matches what the
 * dispatch engine would observe just before spawn.
 *
 * AC: @runner-operator-surfaces ac-runner-validation-human-output
 * AC: @runner-operator-surfaces ac-runner-validation-json-output
 * AC: @runner-operator-surfaces ac-runner-validation-exit-status
 */
export async function buildRunnerValidationReport(
  resolved: ResolveRunnersResult,
  options: BuildRunnerValidationOptions,
): Promise<RunnerValidationReport> {
  const issues: RunnerValidationIssue[] = [];

  if (resolved.project.loaded && resolved.project.issues && resolved.project.issues.length > 0) {
    for (const issue of resolved.project.issues) {
      issues.push({
        reason: "preflight_failure",
        message: `project runner config issue at "${issue.path}": ${issue.message}`,
        details: { layer: "project", path: issue.path, file: resolved.project.path },
      });
    }
  }
  if (resolved.system.loaded && resolved.system.issues && resolved.system.issues.length > 0) {
    for (const issue of resolved.system.issues) {
      issues.push({
        reason: "preflight_failure",
        message: `system runner config issue at "${issue.path}": ${issue.message}`,
        details: { layer: "system", path: issue.path, file: resolved.system.path },
      });
    }
  }

  const allRunners = Object.values(resolved.registry.runners);

  let selected: EffectiveRunner[];
  if (options.runner) {
    const candidate = resolved.registry.runners[options.runner];
    if (!candidate) {
      issues.push({
        reason: "unknown_runner",
        message:
          `Runner "${options.runner}" is not present in the effective runner registry. ` +
          `Check the project runner config (project.runners.yaml in the kspec shadow worktree), ` +
          `the system runner config (runners.yaml under the daemon config dir), and the runner name spelling.`,
        details: { runner: options.runner },
      });
      return { ok: false, runners: [], issues };
    }
    selected = [candidate];
  } else {
    selected = allRunners;
  }

  const entries: RunnerValidationEntry[] = [];
  for (const runner of selected) {
    entries.push(await validateOneRunner(runner, resolved.registry, options));
  }

  const ok = issues.length === 0 && entries.every((entry) => entry.status === "valid");
  return { ok, runners: entries, issues };
}
