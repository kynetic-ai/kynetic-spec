/**
 * Shared diagnostic shape for runner registry load failures.
 *
 * When a project or system runner config file exists but cannot be parsed or
 * validated, the layered loader records the failure as
 * `LayerLoadResult.issues`. Without a structured diagnostic, downstream
 * surfaces collapse that state into an empty registry — every reference to a
 * runner then looks like a missing-name (`unknown_runner`) problem and
 * operators cannot tell that the real issue is malformed YAML or a schema
 * violation. This module turns those layer issues into a first-class
 * `runner_registry_unavailable` diagnostic with the failing layer, config
 * path, and the redacted issue messages.
 *
 * The shape is reused by:
 *   - the runner validation report (CLI list + validate output);
 *   - one-shot invocation and dispatch preflight (block before spawn/prompt
 *     forwarding when a runner-backed agent cannot resolve);
 *   - daemon agent list, agent PATCH, and dispatch-status responses (attach
 *     the diagnostic to runner-backed agents).
 *
 * Redaction is intentionally centralised here so every consumer scrubs
 * secret-looking literals from issue messages identically. The loader already
 * keeps raw config contents out of issue messages — this helper is a defense
 * in depth: zod errors and YAML parse errors typically do not include input
 * values, but if a future parser ever does, this redaction prevents a leak.
 *
 * AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
 * AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 *
 * @module
 */

import { REDACTION_MARKER } from "./redaction.js";
import type { LayerLoadResult, ResolveRunnersResult } from "./runner-config.js";

/**
 * Stable reason identifier for registry-load diagnostics. Mirrors the
 * `RunnerResolutionReason` vocabulary so CLI, daemon, and dispatch surfaces
 * can branch on a single shared identifier.
 */
export const RUNNER_REGISTRY_UNAVAILABLE_REASON = "runner_registry_unavailable" as const;

export type RunnerRegistryUnavailableReason = typeof RUNNER_REGISTRY_UNAVAILABLE_REASON;

/** Layer that produced the registry-load failure. */
export type RegistryLoadFailureLayer = "project" | "system";

/** Individual parse / validation issue from the failing layer. */
export interface RegistryLoadIssue {
  /** Zod-style path within the YAML document where the issue occurred. */
  path: string;
  /** Redacted human-readable issue message. */
  message: string;
}

/**
 * Redacted first-class diagnostic describing a single failing runner config
 * layer. One failure is produced per failing layer; an agent whose runner
 * cannot resolve because the registry is unavailable carries the full set so
 * operators can see which file needs editing.
 */
export interface RegistryLoadFailure {
  /** Stable reason identifier used by downstream branching. */
  reason: RunnerRegistryUnavailableReason;
  /** Layer that produced the failure. */
  layer: RegistryLoadFailureLayer;
  /** Absolute path to the failing config file. */
  config_path: string;
  /** Redacted parse / validation issues raised against the layer. */
  issues: readonly RegistryLoadIssue[];
}

/**
 * Detect registry-load failures from a resolver result. A layer counts as
 * failing when the file was loaded (i.e., the file existed) but parsing or
 * validation produced one or more issues. Absent files are not failures —
 * a missing project runner config is the normal case for repos that do not
 * use the project layer.
 */
export function diagnoseRegistryLoad(
  resolved: ResolveRunnersResult,
): readonly RegistryLoadFailure[] {
  const failures: RegistryLoadFailure[] = [];
  const project = layerLoadFailure("project", resolved.project);
  if (project) failures.push(project);
  const system = layerLoadFailure("system", resolved.system);
  if (system) failures.push(system);
  return failures;
}

function layerLoadFailure<T>(
  layer: RegistryLoadFailureLayer,
  result: LayerLoadResult<T>,
): RegistryLoadFailure | null {
  if (!result.loaded) return null;
  if (!result.issues || result.issues.length === 0) return null;
  return {
    reason: RUNNER_REGISTRY_UNAVAILABLE_REASON,
    layer,
    config_path: result.path,
    issues: result.issues.map((issue) => ({
      path: issue.path,
      message: redactIssueMessage(issue.message),
    })),
  };
}

/**
 * Compact one-line summary of a registry-load failure. Designed for human
 * surfaces (CLI guidance, task notes) where readers need to see the failing
 * layer and config path without scanning every issue. The first issue path
 * + message is included to give a starting point; full issue lists are
 * available on the diagnostic object.
 */
export function summarizeRegistryLoadFailure(failure: RegistryLoadFailure): string {
  const first = failure.issues[0];
  const detail = first ? ` at "${first.path}": ${first.message}` : "";
  return `${failure.layer} runner config at ${failure.config_path} cannot be loaded${detail}`;
}

/**
 * Compose a runner-resolution error message that names the registry-load
 * failures responsible for the unresolved runner. Used by both the resolver
 * (when throwing `runner_registry_unavailable`) and the validation report.
 *
 * The message intentionally does not enumerate every issue — that detail is
 * carried on the structured failures attached to the error. Operators see
 * the failing layer + config path so they can open the right file.
 */
export function describeRegistryLoadFailures(failures: readonly RegistryLoadFailure[]): string {
  if (failures.length === 0) {
    return "Runner registry is unavailable.";
  }
  if (failures.length === 1) {
    return `Runner registry unavailable: ${summarizeRegistryLoadFailure(failures[0])}.`;
  }
  const layers = failures.map((f) => `${f.layer} (${f.config_path})`).join(", ");
  return `Runner registry unavailable. Failing layers: ${layers}.`;
}

// ─── Redaction ──────────────────────────────────────────────────────────────

/**
 * Secret-bearing environment variable names. Issue messages that pair one of
 * these names with a value via `:`, `=`, or quoted JSON syntax have the value
 * portion replaced with `[REDACTED]`.
 *
 * Kept in sync with the project-layer secret-key rejection list so YAML
 * parse errors that happen to echo the offending line never leak the
 * accompanying value.
 */
const SECRET_NAME_PATTERNS: readonly string[] = [
  // Substring patterns — case-insensitive.
  "API_KEY",
  "AUTH_TOKEN",
  "ACCESS_TOKEN",
  "OAUTH_TOKEN",
  "SECRET",
  "PASSWORD",
  // Specific known names — already covered by substrings above but listed
  // explicitly for traceability with `isSecretEnvName`.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_AUTH_TOKEN",
  "CODEX_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
];

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact secret-looking values from a single issue message.
 *
 * The strategy:
 *   1. For each known secret name pattern, locate the name in the message
 *      (case-insensitive) and replace any value that follows after `:` or
 *      `=` (with optional surrounding quotes) with `[REDACTION_MARKER]`.
 *   2. Leave the rest of the message intact so operators still see the
 *      structural diagnostic (which key was rejected and why).
 *
 * This is a defense-in-depth pass: Zod issue messages today never include
 * input values, and YAML parser errors include line/column references
 * rather than payload content. The redactor exists so a future parser
 * change that surfaces input text cannot leak credentials through this
 * diagnostic.
 */
export function redactIssueMessage(message: string): string {
  if (typeof message !== "string" || message.length === 0) return message;
  let redacted = message;
  for (const name of SECRET_NAME_PATTERNS) {
    const namePattern = escapeRegex(name);
    // Match "<NAME>" optionally surrounded by quotes, followed by ":" or "=",
    // followed by a value token. The value token is either a quoted string
    // or a non-whitespace, non-comma sequence; we replace just the value.
    const pattern = new RegExp(
      `("?${namePattern}"?\\s*[:=]\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s,}\\]]+))`,
      "gi",
    );
    redacted = redacted.replace(pattern, (_match, prefix: string) => {
      return `${prefix}${REDACTION_MARKER}`;
    });
  }
  return redacted;
}
