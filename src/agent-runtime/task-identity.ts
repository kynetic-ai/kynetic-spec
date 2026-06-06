/**
 * Canonical dispatch task identity.
 *
 * Dispatch treats the resolved full task ULID as the authoritative identity for
 * every task-scoped runtime decision (scheduling, active/in-flight tracking,
 * workspace provisioning, cleanup protection, session payloads). Human-readable
 * task refs — slug refs, full ULID refs, and unique ULID-prefix refs — are
 * accepted as command/display aliases but never define identity.
 *
 * This module owns the single normalization path that resolves any task-scoped
 * input (`task_id` and/or `task_ref`) to a {@link CanonicalTaskIdentity}: a full
 * task ULID plus a separately-retained display ref. Unresolved, ambiguous, or
 * mismatched inputs are rejected with operator-actionable diagnostics so no
 * downstream state is ever keyed on an invalid raw ref.
 *
 * AC: @dispatch-canonical-task-identity ac-event-ingress-canonicalizes-task-identity
 * AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
 * AC: @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
 * AC: @dispatch-canonical-task-identity ac-alias-canonicalization-diagnostics
 */

import { ReferenceIndex, type ResolveResult } from "../parser/refs.js";
import { initContext } from "../parser/yaml.js";
import { resolveTaskDataManager } from "../parser/task-data-manager.js";
import type { LoadedTask } from "../parser/yaml.js";

/**
 * The canonical identity of a task-scoped dispatch input.
 *
 * `taskId` is the authoritative key for every identity decision. `displayRef`
 * is for prompts, logs, status text, and CLI command text only — never an
 * identity key.
 */
export interface CanonicalTaskIdentity {
  /** Resolved full task ULID — the authoritative identity. */
  taskId: string;
  /** Display ref preserved for human/operator readability. Never an identity key. */
  displayRef: string;
}

/**
 * Why a task-scoped input could not be canonicalized.
 */
export type TaskIdentityRejectionCode =
  | "unresolved-task-ref"
  | "ambiguous-task-ref"
  | "duplicate-task-slug"
  | "task-id-ref-mismatch"
  | "missing-task-identity";

/**
 * Fields shared by every normalization outcome so diagnostics can always name
 * the provided identifiers and the source path.
 *
 * AC: @dispatch-canonical-task-identity ac-alias-canonicalization-diagnostics
 */
interface TaskIdentityOutcomeBase {
  /** The raw `task_id` provided by the input, if any. */
  providedTaskId: string | null;
  /** The raw `task_ref` provided by the input, if any. */
  providedTaskRef: string | null;
  /** Source path of the input (e.g. "api/events", "file-watcher", "bootstrap"). */
  source: string;
}

export interface TaskIdentityResolved extends TaskIdentityOutcomeBase {
  ok: true;
  identity: CanonicalTaskIdentity;
  /** The full ULID the input resolved to (alias of identity.taskId). */
  canonicalTaskId: string;
  /** True when the display ref was synthesized from the task id (`@<ulid>`). */
  displayRefDerivedFromTaskId: boolean;
}

export interface TaskIdentityRejection extends TaskIdentityOutcomeBase {
  ok: false;
  code: TaskIdentityRejectionCode;
  /** The canonical task ULID when one is known despite rejection. */
  canonicalTaskId: string | null;
  /** Operator-actionable diagnostic naming the inputs, source, and outcome. */
  diagnostic: string;
  /** Candidate ULIDs for ambiguous/duplicate rejections. */
  candidates?: string[];
}

export type TaskIdentityResolution = TaskIdentityResolved | TaskIdentityRejection;

/**
 * A task-scoped input to canonicalize. Either field may be absent; at least one
 * resolvable identifier is required for a successful resolution.
 */
export interface TaskIdentityInput {
  taskId?: string | null;
  taskRef?: string | null;
  /** Source path used in diagnostics. */
  source: string;
}

/**
 * Minimal resolver surface needed to canonicalize task identity. {@link
 * ReferenceIndex} satisfies this; tests may supply a lighter implementation.
 */
export interface TaskRefResolver {
  resolve(ref: string): ResolveResult;
  getByUlid(ulid: string): { _ulid?: string } | undefined;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripAt(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

/** Crockford base32 ULID: 26 chars, excludes I, L, O, U. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function isUlidLike(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/**
 * Resolve a raw value that is expected to be a full task ULID to its canonical
 * ULID. Prefers the value indexed by the resolver; otherwise trusts a
 * syntactically valid full ULID (the task may be newer than the loaded
 * snapshot). Returns null when the value is neither indexed nor ULID-shaped.
 * Intentionally does NOT prefix-match — a `task_id` is authoritative identity
 * and must be a full ULID.
 */
function resolveFullUlid(resolver: TaskRefResolver, rawId: string): string | null {
  const cleaned = stripAt(rawId);
  const match = resolver.getByUlid(cleaned.toUpperCase());
  if (match?._ulid) return match._ulid;
  return isUlidLike(cleaned) ? cleaned.toUpperCase() : null;
}

/**
 * Normalize a task-scoped input to a canonical task identity (pure).
 *
 * Resolution policy:
 * - A `task_ref` is resolved through the reference index (slug, full ULID, or
 *   unique ULID prefix). A `task_id` is validated as a full ULID.
 * - When both resolve, they must resolve to the same task or the input is
 *   rejected as a mismatch.
 * - When only the id is valid, the canonical identity is the id and the display
 *   ref is derived as `@<task_id>` (unless a ref equal to the id form was
 *   supplied).
 * - A provided `task_ref` that cannot be resolved (not found, ambiguous, or a
 *   duplicate slug) rejects the input — a present ref must resolve to the
 *   canonical task.
 *
 * AC: @dispatch-canonical-task-identity ac-event-ingress-canonicalizes-task-identity
 * AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
 * AC: @dispatch-canonical-task-identity ac-missing-display-ref-normalizes-from-task-id
 * AC: @dispatch-canonical-task-identity ac-alias-canonicalization-diagnostics
 */
export function normalizeTaskIdentity(
  input: TaskIdentityInput,
  resolver: TaskRefResolver,
): TaskIdentityResolution {
  const rawId = trimToNull(input.taskId);
  const rawRef = trimToNull(input.taskRef);
  const source = input.source;
  const base: TaskIdentityOutcomeBase = {
    providedTaskId: rawId,
    providedTaskRef: rawRef,
    source,
  };

  const idUlid = rawId ? resolveFullUlid(resolver, rawId) : null;

  // Resolve the ref (if any). Short-circuit the `@<id>` display form so a
  // valid id is never rejected merely because the index has not indexed it as a
  // ref yet (the route's default display ref is `@<task_id>`).
  let refUlid: string | null = null;
  let refResult: ResolveResult | null = null;
  if (rawRef) {
    const cleanedRef = stripAt(rawRef).toUpperCase();
    if (idUlid && cleanedRef === idUlid.toUpperCase()) {
      refUlid = idUlid;
    } else {
      refResult = resolver.resolve(rawRef);
      if (refResult.ok) {
        refUlid = refResult.ulid;
      }
    }
  }

  // Both id and ref resolved: enforce agreement.
  if (idUlid && refUlid) {
    if (idUlid !== refUlid) {
      return {
        ok: false,
        code: "task-id-ref-mismatch",
        canonicalTaskId: null,
        diagnostic:
          `[${source}] task_id "${rawId}" resolves to ${idUlid} but task_ref "${rawRef}" ` +
          `resolves to a different task (${refUlid}); rejecting to avoid forking task identity.`,
        ...base,
      };
    }
    return {
      ok: true,
      identity: { taskId: idUlid, displayRef: rawRef as string },
      canonicalTaskId: idUlid,
      displayRefDerivedFromTaskId: false,
      ...base,
    };
  }

  // A ref was provided but could not be resolved. When an authoritative id is
  // also present the id wins and the unresolvable ref is replaced by the derived
  // `@<id>` display ref (the id is authoritative; the bad ref is display-only).
  // Without a usable id, an unresolvable/ambiguous ref is rejected so no state
  // is keyed on it.
  if (rawRef && !refUlid && !idUlid) {
    const result = refResult as Exclude<ResolveResult, { ok: true }> | null;
    if (result?.error === "ambiguous") {
      return {
        ok: false,
        code: "ambiguous-task-ref",
        canonicalTaskId: null,
        diagnostic: `[${source}] task_ref "${rawRef}" is ambiguous (matches ${result.candidates.join(", ")}); rejecting before scheduling.`,
        candidates: result.candidates,
        ...base,
      };
    }
    if (result?.error === "duplicate_slug") {
      return {
        ok: false,
        code: "duplicate-task-slug",
        canonicalTaskId: null,
        diagnostic: `[${source}] task_ref "${rawRef}" maps to multiple items (${result.candidates.join(", ")}); rejecting before scheduling.`,
        candidates: result.candidates,
        ...base,
      };
    }
    return {
      ok: false,
      code: "unresolved-task-ref",
      canonicalTaskId: null,
      diagnostic: `[${source}] task_ref "${rawRef}" could not be resolved to a task; rejecting before scheduling.`,
      ...base,
    };
  }

  // Only the ref resolved (no usable id): canonicalize on the ref.
  if (refUlid) {
    return {
      ok: true,
      identity: { taskId: refUlid, displayRef: rawRef as string },
      canonicalTaskId: refUlid,
      displayRefDerivedFromTaskId: false,
      ...base,
    };
  }

  // A valid id (ref absent or unresolvable): derive the display ref from the id.
  if (idUlid) {
    return {
      ok: true,
      identity: { taskId: idUlid, displayRef: `@${idUlid}` },
      canonicalTaskId: idUlid,
      displayRefDerivedFromTaskId: true,
      ...base,
    };
  }

  // Nothing usable provided.
  return {
    ok: false,
    code: "missing-task-identity",
    canonicalTaskId: null,
    diagnostic:
      `[${source}] no resolvable task identity provided` +
      `${rawId ? ` (task_id "${rawId}" is not a known task ULID)` : ""}` +
      `${rawRef ? ` (task_ref "${rawRef}")` : ""}; rejecting before scheduling.`,
    ...base,
  };
}

/**
 * Build a {@link TaskRefResolver} from a set of loaded tasks. Dispatch identity
 * resolution only needs tasks — spec items, plans, and reviews never define
 * dispatch task identity.
 */
export function buildTaskRefResolver(tasks: LoadedTask[]): TaskRefResolver {
  return new ReferenceIndex(tasks, []);
}

/**
 * Load the current tasks for a project and canonicalize a task-scoped input.
 * Best-effort: when tasks cannot be loaded, returns null so callers can decide
 * whether to proceed leniently (identity normalization is advisory only when
 * the project context itself is unavailable).
 */
export async function resolveCanonicalTaskIdentity(
  projectDir: string,
  input: TaskIdentityInput,
): Promise<TaskIdentityResolution | null> {
  let tasks: LoadedTask[];
  try {
    const ctx = await initContext(projectDir);
    tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  } catch {
    return null;
  }
  return normalizeTaskIdentity(input, buildTaskRefResolver(tasks));
}

/**
 * Resolve a task ref (slug, full ULID, or unique ULID prefix) to its canonical
 * full task ULID, or null when it cannot be uniquely resolved. Used by workspace
 * provisioning/registry paths that receive only a display ref but must key state
 * on canonical identity.
 */
export async function resolveCanonicalTaskId(
  projectDir: string,
  taskRef: string,
): Promise<string | null> {
  let tasks: LoadedTask[];
  try {
    const ctx = await initContext(projectDir);
    tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
  } catch {
    return null;
  }
  const result = buildTaskRefResolver(tasks).resolve(taskRef);
  return result.ok ? result.ulid : null;
}
