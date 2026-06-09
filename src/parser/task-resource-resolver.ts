/**
 * Task resource reference resolver.
 *
 * Bridges `Task.resource_refs` (recorded at derivation time) with the current
 * state of the owning entity's `resources.yaml`. Each task reference carries
 * the content hash and git version identity captured when the reference was
 * created; this module re-resolves the reference against the owning entity's
 * present-day manifest and reports drift when the underlying resource has
 * changed.
 *
 * Used by `kspec task get`, the agent dispatch context block, and (via re-
 * export) the API resource resolver owned by a sibling task. Centralizing
 * the drift check ensures every surface reports the same status for the
 * same reference, so a worker never sees "fresh" while a reviewer sees
 * "drifted" or vice versa.
 *
 * Spec: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
 */

import { loadResourceManifest, type ResourceMetadata } from "./entity-local-resources.js";
import { findPlanByRef } from "./plans.js";
import { getPlanDir } from "./plan-storage-manager.js";
import { getTaskDir } from "./split-backend.js";
import type { LoadedTask } from "./yaml.js";
import type { KspecContext } from "./yaml.js";
import type { TaskResourceRef } from "../schema/resources.js";

/**
 * Resolution status for a single task resource reference relative to the
 * owning entity's current state.
 *
 *   - `present`      — owning manifest still declares the path and the
 *                      current hash matches the recorded hash.
 *   - `drift`        — owning manifest still declares the path but the
 *                      current hash differs from the recorded hash.
 *                      Consumers must surface drift instead of silently
 *                      returning the new bytes.
 *   - `missing`      — owning manifest no longer declares the path; the
 *                      reference cannot be resolved at all.
 *   - `unresolved`   — owning entity itself could not be located (deleted
 *                      plan, dropped storage, etc.).
 */
export type TaskResourceStatus = "present" | "drift" | "missing" | "unresolved";

/**
 * Result of resolving one task resource reference against the live owning
 * entity. `current` is non-null only when the owning manifest still has a
 * matching declared path.
 */
export interface ResolvedTaskResource {
  reference: TaskResourceRef;
  status: TaskResourceStatus;
  /**
   * Current owner-manifest entry for the same path, if the entry still
   * exists. Hash may differ from `reference.sha256` (that's what `drift`
   * indicates).
   */
  current: ResourceMetadata | null;
  /**
   * Human-readable explanation suitable for CLI text mode. Always present.
   */
  message: string;
}

/**
 * Resolve a task's `resource_refs` against the current state of each owning
 * entity. Returns one `ResolvedTaskResource` per reference. Best-effort —
 * never throws on missing/deleted owners; instead returns `unresolved`
 * status with an explanatory message so callers can render diagnostics
 * without ad-hoc error swallowing.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
 */
export async function resolveTaskResources(
  ctx: KspecContext,
  task: LoadedTask,
): Promise<ResolvedTaskResource[]> {
  const refs = task.resource_refs ?? [];
  if (refs.length === 0) return [];

  // Cache per-owner manifests so we read each owning entity's resources.yaml
  // at most once per task, even when several references target the same
  // entity. The cache lifetime is one call — callers do not need cross-task
  // sharing here because list surfaces iterate tasks independently.
  const manifestCache = new Map<string, ResourceMetadata[] | null>();

  const resolved: ResolvedTaskResource[] = [];
  for (const reference of refs) {
    const cacheKey = `${reference.owner_type}:${reference.owner_ref}`;
    let ownerManifest = manifestCache.get(cacheKey);
    if (ownerManifest === undefined) {
      ownerManifest = await loadOwnerManifest(ctx, reference, task);
      manifestCache.set(cacheKey, ownerManifest);
    }
    if (ownerManifest === null) {
      resolved.push({
        reference,
        status: "unresolved",
        current: null,
        message: `Owning ${reference.owner_type} ${reference.owner_ref} could not be located; the reference cannot be re-resolved.`,
      });
      continue;
    }
    const current = ownerManifest.find((entry) => entry.path === reference.path) ?? null;
    if (!current) {
      resolved.push({
        reference,
        status: "missing",
        current: null,
        message: `Resource "${reference.path}" is no longer declared on ${reference.owner_type} ${reference.owner_ref}.`,
      });
      continue;
    }
    if (current.sha256 !== reference.sha256) {
      resolved.push({
        reference,
        status: "drift",
        current,
        message: `Resource "${reference.path}" on ${reference.owner_type} ${reference.owner_ref} has changed since this task was derived (recorded sha256 ${shortHash(reference.sha256)} ≠ current ${shortHash(current.sha256)}).`,
      });
      continue;
    }
    resolved.push({
      reference,
      status: "present",
      current,
      message: `Resource "${reference.path}" on ${reference.owner_type} ${reference.owner_ref} matches the version recorded at derivation time.`,
    });
  }
  return resolved;
}

async function loadOwnerManifest(
  ctx: KspecContext,
  reference: TaskResourceRef,
  task: LoadedTask,
): Promise<ResourceMetadata[] | null> {
  try {
    if (reference.owner_type === "plan") {
      const plan = await findPlanByRef(ctx, reference.owner_ref);
      if (!plan) return null;
      return (await loadResourceManifest(getPlanDir(ctx, plan._ulid))).resources;
    }
    // owner_type === "task". The reference may carry either the task's ULID
    // or any of its slugs as `owner_ref` because `plan derive
    // --materialize-resources` records the task's canonical ref (slug-first,
    // ULID fallback). Accept any identifier that resolves to the current
    // task; cross-task ownership is out of scope for this resolver.
    const candidate = stripRefPrefix(reference.owner_ref);
    if (candidate !== task._ulid && !task.slugs.includes(candidate)) {
      return null;
    }
    return (await loadResourceManifest(getTaskDir(ctx, task._ulid))).resources;
  } catch {
    return null;
  }
}

function stripRefPrefix(ref: string): string {
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

function shortHash(sha256: string): string {
  return sha256.length >= 12 ? sha256.slice(0, 12) : sha256;
}

/**
 * Structured, JSON-serializable projection of a single resolved task resource.
 * This is the canonical shape exposed by `kspec task get --json`, the daemon
 * task detail API (`resolved_resources`), and — extended with an
 * `exported_path` — the static export snapshot, so every surface reports the
 * same fields for the same reference.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
 */
export interface ProjectedTaskResource {
  owner_type: TaskResourceRef["owner_type"];
  owner_ref: string;
  id: string;
  path: string;
  content_type: string | null;
  byte_size: number | null;
  status: TaskResourceStatus;
  recorded_sha256: string;
  current_sha256: string | null;
  recorded_git_commit: string | null;
  current_git_commit: string | null;
  message: string;
}

/**
 * Convert a `ResolvedTaskResource[]` into a structured payload suitable for
 * JSON serialization (e.g. by `kspec task get --json` and the daemon API).
 *
 * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
 */
export function projectResolvedTaskResources(
  resolved: ResolvedTaskResource[],
): ProjectedTaskResource[] {
  return resolved.map((entry) => ({
    owner_type: entry.reference.owner_type,
    owner_ref: entry.reference.owner_ref,
    id: entry.reference.id,
    path: entry.reference.path,
    // content_type/byte_size are owner-manifest metadata not recorded on the
    // task reference itself; they are available only when the owner still
    // declares the path (present/drift) and null otherwise (missing/unresolved).
    content_type: entry.current?.content_type ?? null,
    byte_size: entry.current?.bytes ?? null,
    status: entry.status,
    recorded_sha256: entry.reference.sha256,
    current_sha256: entry.current?.sha256 ?? null,
    recorded_git_commit: entry.reference.git_commit,
    current_git_commit: entry.current?.git_commit ?? null,
    message: entry.message,
  }));
}
