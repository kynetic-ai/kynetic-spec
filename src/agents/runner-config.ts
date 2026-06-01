/**
 * Layered runner configuration for agent execution.
 *
 * Two raw config layers compose into one effective runner registry:
 *
 *   1. Project layer (`<projectRoot>/.kspec/project.runners.yaml`)
 *      Repo-managed sidecar in the shadow worktree. Carries portable,
 *      non-secret values only. Loaded only when the shadow context is
 *      available; never read from the root-branch `kspec.config.yaml`.
 *
 *   2. System layer (`<daemonConfigDir>/projects/<project-key>/runners.yaml`)
 *      Local, machine-specific. Owns process settings, command paths,
 *      argument/env/cwd policy, and credential source bindings.
 *
 * The effective runner is the merged result, with system values overriding
 * project values for the same runner field. Each effective runner carries
 * source metadata identifying which layer supplied or overrode each field.
 *
 * Downstream tasks consume the effective runner registry. This module is
 * concerned only with storage, schema, merge, and shared TypeScript types.
 *
 * @module
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import { z } from "zod";
import { getAdapter, listAdapters } from "./adapters.js";
import { getDefaultDaemonConfigDir } from "../daemon-shared/endpoint.js";

// ── Source metadata ─────────────────────────────────────────────────────

/** Which layer supplied a value in the merged effective runner. */
export type RunnerConfigLayer = "project" | "system";

/** File names for each layer's runner config artifact. */
export const PROJECT_RUNNERS_FILENAME = "project.runners.yaml";
export const SYSTEM_RUNNERS_FILENAME = "runners.yaml";

// ── Secret-key detection ────────────────────────────────────────────────

/**
 * Substrings that mark an environment variable name as secret-looking.
 * Match is case-insensitive against the full variable name.
 */
const SECRET_NAME_SUBSTRINGS: readonly string[] = [
  "API_KEY",
  "AUTH_TOKEN",
  "ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "SECRET",
  "PASSWORD",
];

/**
 * Known adapter / harness credential variable names that operators are likely
 * to mishandle if accepted in project config. Match is case-insensitive
 * against the full variable name.
 */
const KNOWN_SECRET_VAR_NAMES: readonly string[] = [
  // Anthropic / Claude
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // OpenAI / Codex
  "OPENAI_API_KEY",
  "OPENAI_AUTH_TOKEN",
  "CODEX_API_KEY",
  // Generic
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

/**
 * Returns true when the given environment variable name looks like a secret.
 *
 * Matches:
 *   - any of `SECRET_NAME_SUBSTRINGS` as a case-insensitive substring;
 *   - any of `KNOWN_SECRET_VAR_NAMES` as a case-insensitive full-name match.
 */
export function isSecretEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (KNOWN_SECRET_VAR_NAMES.includes(upper)) return true;
  for (const needle of SECRET_NAME_SUBSTRINGS) {
    if (upper.includes(needle)) return true;
  }
  return false;
}

/**
 * Treat a CLI flag name as secret-bearing when its hyphen-and-equals
 * normalization matches the same secret-name predicate used for env vars.
 * `--api-key` -> `API_KEY`, `--anthropic-auth-token` -> `ANTHROPIC_AUTH_TOKEN`.
 */
function isSecretFlagName(flag: string): boolean {
  const normalized = flag.toUpperCase().replace(/-/g, "_");
  return isSecretEnvName(normalized);
}

/**
 * Identify indices in a process-args array whose value is likely a secret.
 *
 * The detection runs over two shapes operators commonly use to pass
 * credentials on the command line, intentionally erring toward false positives
 * since the consequence of accepting a secret here is irreversible disclosure
 * via process listings and ACP diagnostics:
 *
 *   1. `--api-key=<value>` and `-k=<value>` — flagged when the flag name is
 *      secret-looking and a non-empty value follows the `=`.
 *   2. `--api-key <value>` and `-k <value>` — the value position is flagged
 *      when the preceding token is a flag (not another value) with a
 *      secret-looking name.
 *   3. `Bearer <token>` — flagged anywhere it appears, since it is the
 *      universal HTTP Authorization shape.
 *
 * Args that legitimately need credentials must come through `env.secrets`
 * bindings instead.
 *
 * AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
 */
export function findSecretArgIndices(args: readonly string[]): number[] {
  const indices = new Set<number>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string" || arg.length === 0) continue;

    // Bearer-token shape: matched regardless of position.
    if (/^Bearer\s+\S+$/i.test(arg)) {
      indices.add(i);
      continue;
    }

    // `--flag=value` shape.
    if (arg.startsWith("-")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const prefix = arg.startsWith("--") ? arg.slice(2, eq) : arg.slice(1, eq);
        const value = arg.slice(eq + 1);
        if (value.length > 0 && isSecretFlagName(prefix)) {
          indices.add(i);
        }
      }
      continue;
    }

    // `--flag value` shape: previous arg is a flag with a secret-looking name.
    if (i > 0) {
      const prev = args[i - 1];
      if (typeof prev === "string" && prev.startsWith("-") && !prev.includes("=")) {
        const flag = prev.startsWith("--") ? prev.slice(2) : prev.slice(1);
        if (isSecretFlagName(flag)) {
          indices.add(i);
        }
      }
    }
  }
  return [...indices].toSorted((a, b) => a - b);
}

// ── Shared schema fragments ─────────────────────────────────────────────

/**
 * Refines a Zod record so any secret-looking key triggers a validation
 * error. Used by both layers — secret values must come from env.secrets
 * bindings (system-only), not literal env.set entries.
 */
function refineEnvSetNoSecrets<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodEffects<T, z.infer<T>, z.input<T>> {
  return schema.superRefine((value, ctx) => {
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (isSecretEnvName(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Secret-looking env name "${key}" is not allowed in env.set. Use env.secrets bindings in system runner config for credential variables.`,
        });
      }
    }
  });
}

// ── Project layer schema ────────────────────────────────────────────────

const ProjectPrivacySchema = z
  .object({
    /** Whether to set the kspec privacy/nonessential-traffic defaults. */
    disable_nonessential_traffic: z.boolean().optional(),
  })
  .strict();

const ProjectDiagnosticsSchema = z
  .object({
    /** Diagnostic retention preference. */
    retain_raw_logs: z.enum(["never", "on_failure", "always"]).optional(),
  })
  .strict();

const ProjectEnvSchema = z
  .object({
    /** Non-secret env literals. Secret-looking keys are rejected. */
    set: refineEnvSetNoSecrets(z.record(z.string(), z.string())).optional(),
  })
  .strict();

/**
 * A single project-layer runner entry. Project config is intentionally
 * restricted to portable, non-secret values only. Operational fields
 * (kind, adapter, process settings, env.secrets, env.pass, env.inherit)
 * live in system runner config.
 */
const ProjectRunnerEntrySchema = z
  .object({
    env: ProjectEnvSchema.optional(),
    privacy: ProjectPrivacySchema.optional(),
    diagnostics: ProjectDiagnosticsSchema.optional(),
  })
  .strict();

/**
 * Project runner config file shape (`project.runners.yaml`).
 *
 * AC: @agent-runner-configuration ac-project-runner-storage-is-repo-managed
 * AC: @agent-runner-configuration ac-project-layer-accepts-portable-runner-values
 * AC: @agent-runner-configuration ac-project-layer-blocks-known-secret-keys
 * AC: @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret
 * AC: @runner-environment-secret-boundaries ac-secret-bindings-system-only
 */
export const ProjectRunnerConfigSchema = z
  .object({
    runners: z.record(z.string(), ProjectRunnerEntrySchema).optional(),
  })
  .strict();

export type ProjectRunnerConfig = z.infer<typeof ProjectRunnerConfigSchema>;
export type ProjectRunnerEntry = z.infer<typeof ProjectRunnerEntrySchema>;

// ── System layer schema ─────────────────────────────────────────────────

/** Inheritance policy for assembling the adapter process environment. */
export const RunnerEnvInheritEnum = z.enum(["ambient", "minimal", "none"]);
export type RunnerEnvInherit = z.infer<typeof RunnerEnvInheritEnum>;

/** Supported runner kinds. Only `acp_process` is implemented in this plan. */
export const RunnerKindEnum = z.enum(["acp_process"]);
export type RunnerKind = z.infer<typeof RunnerKindEnum>;

/** Retention policy for diagnostic raw logs. */
export const DiagnosticsRetainEnum = z.enum(["never", "on_failure", "always"]);
export type DiagnosticsRetain = z.infer<typeof DiagnosticsRetainEnum>;

const SystemProcessSchema = z
  .object({
    /** Optional executable / command reference for the adapter spawn. */
    executable: z.string().min(1).optional(),
    /**
     * Additional non-secret arguments appended to the ACP process invocation.
     * Secret-looking values (Bearer tokens, --api-key/--auth-token style
     * flag values) are rejected here so credential material never enters
     * process.args; use env.secrets bindings instead.
     *
     * AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
     */
    args: z
      .array(z.string())
      .optional()
      .superRefine((value, ctx) => {
        if (!value) return;
        const flagged = findSecretArgIndices(value);
        for (const i of flagged) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `process.args[${i}] looks like a secret value. Use env.secrets bindings in system runner config for credential variables.`,
          });
        }
      }),
    /**
     * Cwd override for the child process. Absolute paths are kept as-is
     * (after normal path normalization). Relative paths are resolved by
     * `mergeRunnerConfigs` against the directory containing this system
     * runners.yaml file, not against the daemon/CLI parent process cwd, so
     * that the resolved cwd is stable regardless of which process launches
     * kspec.
     *
     * AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
     */
    cwd: z.string().min(1).optional(),
  })
  .strict();

/**
 * A single secret-source binding. Names a source only; the secret value is
 * resolved at invocation time from the named source and never persisted in
 * config or diagnostics.
 *
 * AC: @runner-environment-secret-boundaries ac-secret-values-not-stored-inline
 */
const SystemSecretBindingSchema = z
  .object({
    /** Source identifier (e.g., `user_env`). */
    source: z.string().min(1),
    /** Whether the binding must resolve for invocation to proceed. */
    required: z.boolean().optional(),
  })
  .strict();

const SystemEnvSchema = z
  .object({
    /** Inheritance policy. Default: `minimal`. */
    inherit: RunnerEnvInheritEnum.optional(),
    /** Allowed inherited variable names. */
    pass: z.array(z.string()).optional(),
    /** Non-secret literals. Secret-looking keys are rejected. */
    set: refineEnvSetNoSecrets(z.record(z.string(), z.string())).optional(),
    /** Secret source bindings, keyed by child env var name. */
    secrets: z.record(z.string(), SystemSecretBindingSchema).optional(),
  })
  .strict();

const SystemPrivacySchema = z
  .object({
    disable_nonessential_traffic: z.boolean().optional(),
  })
  .strict();

const SystemDiagnosticsSchema = z
  .object({
    retain_raw_logs: DiagnosticsRetainEnum.optional(),
  })
  .strict();

/**
 * Adapter reference that must resolve to a registered adapter at parse time.
 *
 * The registry is dynamic (callers may register additional adapters via
 * `registerAdapter`), so validation queries it inside the refine callback
 * instead of capturing the registered set at schema construction. Unknown
 * adapter IDs are rejected so invalid configs fail at load rather than at
 * invocation time.
 *
 * AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
 */
const SystemAdapterRefSchema = z
  .string()
  .min(1)
  .refine(
    (id) => getAdapter(id) !== undefined,
    (id) => ({
      message: `Adapter "${id}" is not a registered adapter. Registered adapters: ${listAdapters().join(", ")}.`,
    }),
  );

const SystemRunnerEntrySchema = z
  .object({
    kind: RunnerKindEnum,
    adapter: SystemAdapterRefSchema,
    process: SystemProcessSchema.optional(),
    env: SystemEnvSchema.optional(),
    privacy: SystemPrivacySchema.optional(),
    diagnostics: SystemDiagnosticsSchema.optional(),
  })
  .strict();

/**
 * System runner config file shape (`<daemonConfigDir>/projects/<project-key>/runners.yaml`).
 *
 * AC: @agent-runner-configuration ac-system-runner-storage-is-local
 * AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
 */
export const SystemRunnerConfigSchema = z
  .object({
    runners: z.record(z.string(), SystemRunnerEntrySchema).optional(),
  })
  .strict();

export type SystemRunnerConfig = z.infer<typeof SystemRunnerConfigSchema>;
export type SystemRunnerEntry = z.infer<typeof SystemRunnerEntrySchema>;

// ── Effective runner shape (resolved + source metadata) ─────────────────

/** Default values applied when neither layer specifies the field. */
const RUNNER_DEFAULTS = {
  envInherit: "minimal" as const satisfies RunnerEnvInherit,
  privacyDisableNonessentialTraffic: true,
  diagnosticsRetainRawLogs: "on_failure" as const satisfies DiagnosticsRetain,
} as const;

/** Origin of a single field in the resolved effective runner. */
export type RunnerFieldOrigin = "project" | "system" | "default";

/**
 * Per-field source metadata for the resolved effective runner. Each entry
 * records which layer supplied the final value and whether the system layer
 * overrode a project value for that field.
 */
export interface EffectiveRunnerSources {
  kind: RunnerFieldOrigin;
  adapter: RunnerFieldOrigin;
  processExecutable: RunnerFieldOrigin | null;
  processArgs: RunnerFieldOrigin | null;
  processCwd: RunnerFieldOrigin | null;
  envInherit: RunnerFieldOrigin;
  envPass: RunnerFieldOrigin;
  envSet: { keys: Record<string, RunnerFieldOrigin> };
  envSecrets: RunnerFieldOrigin | null;
  privacyDisableNonessentialTraffic: RunnerFieldOrigin;
  diagnosticsRetainRawLogs: RunnerFieldOrigin;
  /** Field names whose value system overrode from project. */
  overriddenBySystem: readonly string[];
}

/** Resolved effective runner entry with all defaults applied. */
export interface EffectiveRunner {
  /** Configured runner name. */
  name: string;
  /** Required kind (only `acp_process` in this plan). */
  kind: RunnerKind;
  /** Required adapter reference. */
  adapter: string;
  process: {
    executable: string | null;
    args: readonly string[];
    /**
     * Resolved child-process cwd, or `null` when the runner did not configure
     * one. Always an absolute, normalized path when set — relative system
     * config values are pre-resolved against the system runners.yaml
     * directory by `mergeRunnerConfigs`, so downstream consumers (preflight,
     * diagnostics, spawn) never see an unresolved relative path.
     *
     * AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
     */
    cwd: string | null;
  };
  env: {
    inherit: RunnerEnvInherit;
    pass: readonly string[];
    set: Readonly<Record<string, string>>;
    secrets: Readonly<Record<string, { source: string; required: boolean }>>;
  };
  privacy: {
    disable_nonessential_traffic: boolean;
  };
  diagnostics: {
    retain_raw_logs: DiagnosticsRetain;
  };
  /** Source metadata for diagnostics and validation. */
  sources: EffectiveRunnerSources;
}

/** Result of resolving both layers into an effective runner registry. */
export interface EffectiveRunnerRegistry {
  /** Runners keyed by configured name. */
  runners: Readonly<Record<string, EffectiveRunner>>;
}

// ── Project key helper ──────────────────────────────────────────────────

/**
 * Derive the `<project-key>` segment used in
 * `<daemonConfigDir>/projects/<project-key>/runners.yaml`.
 *
 * Defined as the lowercase hex SHA-256 digest of the canonical absolute
 * project root path after realpath normalization. The raw path is never
 * embedded in the directory name, and the digest is never truncated.
 *
 * The same helper must be used in CLI, daemon, and tests so the layered
 * config resolves to the same directory regardless of caller.
 *
 * AC: @agent-runner-configuration ac-system-runner-storage-is-local
 */
export async function deriveProjectKey(projectRoot: string): Promise<string> {
  const canonical = await fs.realpath(projectRoot);
  const absolute = path.resolve(canonical);
  return createHash("sha256").update(absolute).digest("hex");
}

/**
 * Synchronous variant of `deriveProjectKey` for callers that cannot await
 * (e.g., synchronous CLI startup paths). Falls back to `path.resolve` when
 * the path does not exist on disk.
 */
export function deriveProjectKeySync(projectRoot: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(projectRoot);
  } catch {
    canonical = path.resolve(projectRoot);
  }
  return createHash("sha256").update(path.resolve(canonical)).digest("hex");
}

// ── Path helpers ────────────────────────────────────────────────────────

/**
 * Path to the project-layer runner config file inside the shadow worktree.
 *
 * Callers must pass the resolved shadow worktree directory (e.g., the
 * `.kspec/` directory) so this helper does not need to re-derive shadow
 * state. When viewed from the main checkout this resolves to
 * `<projectRoot>/.kspec/project.runners.yaml`.
 */
export function getProjectRunnersPath(shadowWorktreeDir: string): string {
  return path.join(shadowWorktreeDir, PROJECT_RUNNERS_FILENAME);
}

/**
 * Path to the system-layer runner config file for a project.
 *
 * AC: @agent-runner-configuration ac-system-runner-storage-is-local
 */
export async function getSystemRunnersPath(
  projectRoot: string,
  options: { daemonConfigDir?: string } = {},
): Promise<string> {
  const daemonConfigDir = options.daemonConfigDir ?? getDefaultDaemonConfigDir();
  const projectKey = await deriveProjectKey(projectRoot);
  return path.join(daemonConfigDir, "projects", projectKey, SYSTEM_RUNNERS_FILENAME);
}

// ── Load result types ──────────────────────────────────────────────────

/** Outcome of loading a single layer file. */
export interface LayerLoadResult<T> {
  /** Parsed config, or null if the file is absent or invalid. */
  config: T | null;
  /** Absolute path to the file (whether or not it exists). */
  path: string;
  /** True when the file existed and was read. */
  loaded: boolean;
  /** Validation error issues (path + message), or null on success / missing. */
  issues: Array<{ path: string; message: string }> | null;
}

/**
 * Outcome of resolving the layered runner config into the effective runner
 * registry. Includes both layer results plus the merged registry.
 */
export interface ResolveRunnersResult {
  project: LayerLoadResult<ProjectRunnerConfig>;
  system: LayerLoadResult<SystemRunnerConfig>;
  registry: EffectiveRunnerRegistry;
}

// ── Layer loaders ──────────────────────────────────────────────────────

/**
 * Outcome of attempting to read and parse a YAML file. Distinct from the
 * layer-level `LayerLoadResult` because the parse step happens before schema
 * validation — a parse failure needs to be reported as a registry-load
 * issue even though the layer never produced a parsed config object.
 */
type ReadYamlResult =
  | { kind: "missing" }
  | { kind: "ok"; data: unknown }
  | { kind: "parse_error"; issue: { path: string; message: string } };

async function readYamlFile(filePath: string): Promise<ReadYamlResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  try {
    return { kind: "ok", data: YAML.parse(content) };
  } catch (err) {
    // Capture YAML parse failures as a registry-load issue so the loader can
    // attach them to the layer result instead of propagating an uncaught
    // exception. Downstream surfaces translate this into a redacted
    // `runner_registry_unavailable` diagnostic.
    //
    // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
    return {
      kind: "parse_error",
      issue: {
        path: "",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function collectZodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}

/**
 * Load and validate project runner config from `project.runners.yaml`.
 *
 * Callers MUST only invoke this after shadow branch context is available —
 * project runner config is never read from the root-branch
 * `kspec.config.yaml`. The caller passes the resolved shadow worktree
 * directory; this loader does not perform shadow detection.
 *
 * Returns `{ config: null, loaded: false }` when the file is absent. Returns
 * `{ config: null, loaded: true, issues }` when the file exists but is
 * invalid (including secret-looking env.set keys).
 *
 * AC: @agent-runner-configuration ac-project-runner-storage-is-repo-managed
 * AC: @agent-runner-configuration ac-project-layer-accepts-portable-runner-values
 * AC: @agent-runner-configuration ac-project-layer-blocks-known-secret-keys
 * AC: @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret
 * AC: @runner-environment-secret-boundaries ac-secret-bindings-system-only
 */
export async function loadProjectRunnerConfig(
  shadowWorktreeDir: string,
): Promise<LayerLoadResult<ProjectRunnerConfig>> {
  const filePath = getProjectRunnersPath(shadowWorktreeDir);
  const raw = await readYamlFile(filePath);
  if (raw.kind === "missing") {
    return { config: null, path: filePath, loaded: false, issues: null };
  }
  if (raw.kind === "parse_error") {
    return { config: null, path: filePath, loaded: true, issues: [raw.issue] };
  }

  const parsed = ProjectRunnerConfigSchema.safeParse(raw.data);
  if (!parsed.success) {
    return {
      config: null,
      path: filePath,
      loaded: true,
      issues: collectZodIssues(parsed.error),
    };
  }
  return { config: parsed.data, path: filePath, loaded: true, issues: null };
}

/**
 * Load and validate system runner config from
 * `<daemonConfigDir>/projects/<project-key>/runners.yaml`.
 *
 * The daemon config dir defaults to `getDefaultDaemonConfigDir()` and may be
 * overridden by tests. Returns `{ config: null, loaded: false }` when the
 * file is absent.
 *
 * AC: @agent-runner-configuration ac-system-runner-storage-is-local
 * AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
 */
export async function loadSystemRunnerConfig(
  projectRoot: string,
  options: { daemonConfigDir?: string } = {},
): Promise<LayerLoadResult<SystemRunnerConfig>> {
  const filePath = await getSystemRunnersPath(projectRoot, options);
  const raw = await readYamlFile(filePath);
  if (raw.kind === "missing") {
    return { config: null, path: filePath, loaded: false, issues: null };
  }
  if (raw.kind === "parse_error") {
    return { config: null, path: filePath, loaded: true, issues: [raw.issue] };
  }

  const parsed = SystemRunnerConfigSchema.safeParse(raw.data);
  if (!parsed.success) {
    return {
      config: null,
      path: filePath,
      loaded: true,
      issues: collectZodIssues(parsed.error),
    };
  }
  return { config: parsed.data, path: filePath, loaded: true, issues: null };
}

// ── Merge ──────────────────────────────────────────────────────────────

/**
 * Options that adjust how `mergeRunnerConfigs` resolves system-layer values
 * whose meaning depends on the on-disk location of the system runners.yaml
 * file.
 */
export interface MergeRunnerConfigsOptions {
  /**
   * Absolute path to the system runners.yaml file. When provided, a relative
   * `process.cwd` value from the system layer is resolved against
   * `path.dirname(systemConfigPath)`, so the effective cwd does not depend on
   * the daemon/CLI parent process cwd. Absolute `process.cwd` values are
   * normalized via `path.resolve` but otherwise unchanged.
   *
   * When omitted (the test-only raw merge path), relative cwd values are
   * preserved verbatim. Production code paths always go through
   * `resolveEffectiveRunners`, which supplies this option.
   *
   * AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
   */
  systemConfigPath?: string;
}

/**
 * Merge project and system runner configs into the effective runner registry.
 *
 * Merge semantics (per runner name):
 *   - `kind` and `adapter` come from system (required there); project layer
 *     never supplies them.
 *   - Scalar fields (process.executable, process.cwd, env.inherit,
 *     privacy.disable_nonessential_traffic, diagnostics.retain_raw_logs):
 *     system replaces project. Defaults fill in when neither layer sets a
 *     value.
 *   - `process.cwd` is normalized when `options.systemConfigPath` is
 *     supplied: relative values resolve against the system config directory,
 *     and absolute values are normalized via `path.resolve`. This makes the
 *     resolved cwd deterministic and independent of the parent process cwd.
 *   - Array fields (process.args, env.pass): system replaces project when
 *     present; otherwise the project value is used, otherwise empty.
 *   - Map fields (env.set): merged key-by-key. System keys override project
 *     keys for the same name. Source metadata tracks origin per key.
 *   - env.secrets: system-only (project schema rejects it).
 *
 * Runners that appear only in the project layer have no `kind` / `adapter`
 * and therefore cannot become effective runners. They are omitted from the
 * registry. Downstream surfaces (e.g., `kspec agent runners validate`) can
 * report this; the schema-layer module is concerned only with producing
 * valid effective runners.
 *
 * AC: @agent-runner-configuration ac-named-runners-loaded
 * AC: @agent-runner-configuration ac-system-overrides-project-values
 * AC: @agent-runner-configuration ac-effective-runner-kind-and-adapter-required
 * AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
 */
export function mergeRunnerConfigs(
  project: ProjectRunnerConfig | null,
  system: SystemRunnerConfig | null,
  options: MergeRunnerConfigsOptions = {},
): EffectiveRunnerRegistry {
  const projectRunners = project?.runners ?? {};
  const systemRunners = system?.runners ?? {};

  const systemConfigDir = options.systemConfigPath ? path.dirname(options.systemConfigPath) : null;

  const runners: Record<string, EffectiveRunner> = {};

  for (const [name, systemEntry] of Object.entries(systemRunners)) {
    const projectEntry: ProjectRunnerEntry | undefined = projectRunners[name];
    runners[name] = mergeOne(name, projectEntry, systemEntry, systemConfigDir);
  }

  return { runners };
}

/**
 * Normalize a raw `process.cwd` string from system runner config.
 *
 * - Absolute paths pass through `path.resolve` so `.` / `..` segments are
 *   collapsed but the absolute root is preserved.
 * - Relative paths resolve against `systemConfigDir` when known so the
 *   effective cwd is independent of the parent process cwd.
 * - When `systemConfigDir` is null (raw merge path used only by tests),
 *   the value is returned verbatim so existing callers keep working.
 *
 * AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
 */
function normalizeSystemProcessCwd(rawCwd: string, systemConfigDir: string | null): string {
  if (path.isAbsolute(rawCwd)) {
    return path.resolve(rawCwd);
  }
  if (systemConfigDir === null) {
    return rawCwd;
  }
  return path.resolve(systemConfigDir, rawCwd);
}

function mergeOne(
  name: string,
  projectEntry: ProjectRunnerEntry | undefined,
  systemEntry: SystemRunnerEntry,
  systemConfigDir: string | null,
): EffectiveRunner {
  const overridden: string[] = [];

  // process.* ────────────────────────────────────────────────
  const processExecutable = systemEntry.process?.executable ?? null;
  const processArgs = systemEntry.process?.args ?? [];
  const processCwd =
    systemEntry.process?.cwd !== undefined
      ? normalizeSystemProcessCwd(systemEntry.process.cwd, systemConfigDir)
      : null;

  // env.inherit ────────────────────────────────────────────────
  const envInheritOrigin: RunnerFieldOrigin =
    systemEntry.env?.inherit !== undefined ? "system" : "default";
  const envInherit: RunnerEnvInherit = systemEntry.env?.inherit ?? RUNNER_DEFAULTS.envInherit;

  // env.pass ────────────────────────────────────────────────
  const envPass = systemEntry.env?.pass ?? [];
  const envPassOrigin: RunnerFieldOrigin =
    systemEntry.env?.pass !== undefined ? "system" : "default";

  // env.set ────────────────────────────────────────────────
  const envSet: Record<string, string> = {};
  const envSetKeys: Record<string, RunnerFieldOrigin> = {};
  const projectSet = projectEntry?.env?.set ?? {};
  const systemSet = systemEntry.env?.set ?? {};
  for (const [k, v] of Object.entries(projectSet)) {
    envSet[k] = v;
    envSetKeys[k] = "project";
  }
  for (const [k, v] of Object.entries(systemSet)) {
    if (k in envSet) {
      overridden.push(`env.set.${k}`);
    }
    envSet[k] = v;
    envSetKeys[k] = "system";
  }

  // env.secrets ────────────────────────────────────────────────
  const envSecrets: Record<string, { source: string; required: boolean }> = {};
  if (systemEntry.env?.secrets) {
    for (const [k, binding] of Object.entries(systemEntry.env.secrets)) {
      envSecrets[k] = { source: binding.source, required: binding.required ?? false };
    }
  }
  const envSecretsOrigin: RunnerFieldOrigin | null = systemEntry.env?.secrets ? "system" : null;

  // privacy.disable_nonessential_traffic ────────────────────
  const projectDisableTraffic = projectEntry?.privacy?.disable_nonessential_traffic;
  const systemDisableTraffic = systemEntry.privacy?.disable_nonessential_traffic;
  let privacyOrigin: RunnerFieldOrigin = "default";
  let privacyValue: boolean = RUNNER_DEFAULTS.privacyDisableNonessentialTraffic;
  if (systemDisableTraffic !== undefined) {
    if (projectDisableTraffic !== undefined && projectDisableTraffic !== systemDisableTraffic) {
      overridden.push("privacy.disable_nonessential_traffic");
    }
    privacyValue = systemDisableTraffic;
    privacyOrigin = "system";
  } else if (projectDisableTraffic !== undefined) {
    privacyValue = projectDisableTraffic;
    privacyOrigin = "project";
  }

  // diagnostics.retain_raw_logs ─────────────────────────────
  const projectRetain = projectEntry?.diagnostics?.retain_raw_logs;
  const systemRetain = systemEntry.diagnostics?.retain_raw_logs;
  let diagnosticsOrigin: RunnerFieldOrigin = "default";
  let diagnosticsValue: DiagnosticsRetain = RUNNER_DEFAULTS.diagnosticsRetainRawLogs;
  if (systemRetain !== undefined) {
    if (projectRetain !== undefined && projectRetain !== systemRetain) {
      overridden.push("diagnostics.retain_raw_logs");
    }
    diagnosticsValue = systemRetain;
    diagnosticsOrigin = "system";
  } else if (projectRetain !== undefined) {
    diagnosticsValue = projectRetain;
    diagnosticsOrigin = "project";
  }

  const sources: EffectiveRunnerSources = {
    kind: "system",
    adapter: "system",
    processExecutable: systemEntry.process?.executable !== undefined ? "system" : null,
    processArgs: systemEntry.process?.args !== undefined ? "system" : null,
    processCwd: systemEntry.process?.cwd !== undefined ? "system" : null,
    envInherit: envInheritOrigin,
    envPass: envPassOrigin,
    envSet: { keys: envSetKeys },
    envSecrets: envSecretsOrigin,
    privacyDisableNonessentialTraffic: privacyOrigin,
    diagnosticsRetainRawLogs: diagnosticsOrigin,
    overriddenBySystem: overridden,
  };

  return {
    name,
    kind: systemEntry.kind,
    adapter: systemEntry.adapter,
    process: {
      executable: processExecutable,
      args: processArgs,
      cwd: processCwd,
    },
    env: {
      inherit: envInherit,
      pass: envPass,
      set: envSet,
      secrets: envSecrets,
    },
    privacy: {
      disable_nonessential_traffic: privacyValue,
    },
    diagnostics: {
      retain_raw_logs: diagnosticsValue,
    },
    sources,
  };
}

// ── Top-level resolver ─────────────────────────────────────────────────

/**
 * Load both layers and produce the effective runner registry.
 *
 * The shadow worktree directory is optional. When omitted (e.g., before
 * shadow context is available), the project layer is skipped entirely.
 * This preserves the contract that project runner config is loaded only
 * after shadow context is available.
 */
export async function resolveEffectiveRunners(options: {
  projectRoot: string;
  shadowWorktreeDir?: string;
  daemonConfigDir?: string;
}): Promise<ResolveRunnersResult> {
  const project: LayerLoadResult<ProjectRunnerConfig> = options.shadowWorktreeDir
    ? await loadProjectRunnerConfig(options.shadowWorktreeDir)
    : {
        config: null,
        path: "",
        loaded: false,
        issues: null,
      };

  const system = await loadSystemRunnerConfig(options.projectRoot, {
    daemonConfigDir: options.daemonConfigDir,
  });

  // Pass the system config path so `mergeRunnerConfigs` can resolve any
  // relative `process.cwd` against the system runners.yaml directory rather
  // than the daemon/CLI parent process cwd.
  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  const registry = mergeRunnerConfigs(project.config, system.config, {
    systemConfigPath: system.path,
  });
  return { project, system, registry };
}
