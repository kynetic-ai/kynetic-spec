/**
 * Canonical dispatch workspace identity.
 *
 * Workspace registry lookups must compare records by canonical full task ULID,
 * not by raw/display `task_ref` strings. A task can be referenced by a slug, a
 * full ULID, or a unique ULID prefix, and historical records may carry only a
 * `task_ref` (no `task_id`) written before canonical identity was tracked
 * separately. Comparing raw refs forks identity across aliases; comparing
 * canonical ULIDs keeps a single workspace lineage stable across every alias.
 *
 * This module owns the shared canonical-matching primitives and the
 * canonical-safe registry lookup API. Exact raw-ref equality is only a degraded
 * fallback used when neither the query nor the record can be resolved to a task.
 *
 * AC: @dispatch-canonical-task-identity ac-workspace-lookup-apis-use-canonical-identity
 * AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
 * AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
 * AC: @dispatch-canonical-task-identity ac-workspace-target-lookup-canonicalizes-historical-aliases
 */

import { resolveTaskDataManager } from "../parser/task-data-manager.js";
import {
  loadDispatchWorkspaceRegistry,
  type LoadedDispatchWorkspaceRecord,
} from "../parser/dispatch-workspaces.js";
import type { KspecContext } from "../parser/yaml.js";
import type { DispatchWorkspaceRecord } from "../schema/index.js";
import { buildTaskRefResolver, type TaskRefResolver } from "./task-identity.js";

/**
 * Build a task-ref resolver for the project so workspace lookups can compare
 * records by canonical task ULID rather than raw display refs. Best-effort:
 * returns null when the task index cannot be loaded so callers degrade to raw
 * comparison rather than failing.
 */
export async function buildProjectTaskResolver(ctx: KspecContext): Promise<TaskRefResolver | null> {
  try {
    const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
    return buildTaskRefResolver(tasks);
  } catch {
    return null;
  }
}

/**
 * Resolve a task ref (slug, full ULID, or unique ULID prefix) to its canonical
 * full task ULID, or null when it cannot be uniquely resolved.
 */
export function resolveCanonicalId(
  resolver: TaskRefResolver | null,
  taskRef: string,
): string | null {
  if (!resolver) return null;
  const result = resolver.resolve(taskRef);
  return result.ok ? result.ulid : null;
}

/**
 * Canonical task ULID for a workspace record: the recorded `task_id` when
 * present (already canonical), otherwise the resolution of its historical
 * `task_ref`. Returns null for unresolvable historical records so callers can
 * classify them stale rather than fork identity.
 *
 * AC: @dispatch-canonical-task-identity ac-historical-workspace-records-normalize-or-stale
 */
export function recordCanonicalId(
  record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
  resolver: TaskRefResolver | null,
): string | null {
  if (record.task_id) return record.task_id;
  return resolveCanonicalId(resolver, record.task_ref);
}

/**
 * True when a workspace record represents the same canonical task as the query.
 * Prefers canonical ULID comparison; falls back to raw task_ref equality only
 * when neither side can be canonicalized (so behavior degrades safely when the
 * task index is unavailable).
 *
 * AC: @dispatch-canonical-task-identity ac-workspace-lookup-apis-use-canonical-identity
 */
export function recordMatchesTask(
  record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
  queryTaskRef: string,
  queryCanonicalId: string | null,
  resolver: TaskRefResolver | null,
): boolean {
  if (queryCanonicalId) {
    const recordId = recordCanonicalId(record, resolver);
    if (recordId) return recordId === queryCanonicalId;
  }
  return record.task_ref === queryTaskRef;
}

/**
 * Raised when more than one non-closed workspace record resolves to the same
 * canonical task. Callers must report/recover rather than silently selecting a
 * record by its display ref.
 *
 * AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
 */
export class AmbiguousWorkspaceTaskError extends Error {
  readonly canonicalLabel: string;
  readonly workspaceIds: string[];

  constructor(canonicalLabel: string, workspaceIds: string[], detail: string) {
    super(
      `Multiple non-closed dispatch workspace records resolve to canonical task ${canonicalLabel}: ${detail}.`,
    );
    this.name = "AmbiguousWorkspaceTaskError";
    this.canonicalLabel = canonicalLabel;
    this.workspaceIds = workspaceIds;
  }
}

/**
 * Canonical-safe lookup of a single workspace record for a task identifier.
 *
 * Resolves the query and every candidate record to canonical task identity and
 * compares ULIDs. Raw `task_ref` equality is used only as a degraded fallback
 * when neither side resolves. When more than one non-closed record resolves to
 * the same canonical task, throws {@link AmbiguousWorkspaceTaskError} rather
 * than silently selecting the newest by display ref.
 *
 * This is the production-safe replacement for any exact raw-`task_ref` lookup.
 *
 * AC: @dispatch-canonical-task-identity ac-workspace-lookup-apis-use-canonical-identity
 * AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
 * AC: @dispatch-canonical-task-identity ac-workspace-target-lookup-canonicalizes-historical-aliases
 *
 * @param taskRef A task identifier: slug ref, `@slug`, full ULID, `@<ULID>`, or
 *   unique ULID-prefix ref. Display form is accepted because the resolver
 *   canonicalizes it before matching.
 */
export async function findDispatchWorkspaceByCanonicalTask(
  ctx: KspecContext,
  taskRef: string,
  options: { includeClosed?: boolean } = {},
): Promise<LoadedDispatchWorkspaceRecord | undefined> {
  const records = await loadDispatchWorkspaceRegistry(ctx);
  const resolver = await buildProjectTaskResolver(ctx);
  const queryCanonicalId = resolveCanonicalId(resolver, taskRef);

  const matches = records.filter((record) =>
    recordMatchesTask(record, taskRef, queryCanonicalId, resolver),
  );

  // Reject — never silently collapse — more than one non-closed record for the
  // same canonical task. Two open alias records (e.g. @slug and @<ULID>) are an
  // ambiguous target; returning the newest would fork identity. Surface it for
  // operator recovery instead.
  const openMatches = matches.filter((record) => record.lifecycle_state !== "closed");
  if (openMatches.length > 1) {
    const canonicalLabel =
      queryCanonicalId ?? recordCanonicalId(openMatches[0], resolver) ?? taskRef;
    const detail = openMatches
      .map((record) => `${record.workspace_id} (task_ref ${record.task_ref})`)
      .join(", ");
    throw new AmbiguousWorkspaceTaskError(
      canonicalLabel,
      openMatches.map((record) => record.workspace_id),
      detail,
    );
  }

  const candidates = options.includeClosed ? matches : openMatches;
  return candidates.toSorted((a, b) =>
    a.timestamps.updated_at < b.timestamps.updated_at ? 1 : -1,
  )[0];
}
