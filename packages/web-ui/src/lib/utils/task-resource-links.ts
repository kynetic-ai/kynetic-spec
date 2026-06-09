/**
 * Task description resource-link rewriting.
 *
 * Task descriptions can author `./resources/<relative-path>` markdown image and
 * link targets that point at the task's resolved resources. Unlike plan
 * resources (whose `path -> id` mapping comes straight off the owning plan
 * manifest via {@link rewritePlanResourceLinks}), a task's resources are the
 * versioned `resource_refs` projected by the daemon as `resolved_resources`.
 * Each projected entry may be plan-owned (a non-drifted reference back to the
 * owning plan's manifest) or task-owned (a copy materialized with
 * `kspec plan derive --materialize-resources`). Both render through the same
 * task-scoped bytes route, so the rewriter only needs the resolved entry's
 * `id`, `path`, and `status` to build a URL.
 *
 * The browser-fetchable URL must carry selected-project routing context the
 * same way review resources do (`reviewResourceBytesUrl` in `$lib/api`): an
 * `<img src>` / `<a href>` request cannot send the `X-Kspec-Dir` header, so the
 * selected project's path travels as a `?kspec_dir=` query parameter built from
 * the project store. This and the `./resources/<path>` pattern matching are
 * shared with plan rewriting through {@link rewriteEntityResourceLinks}.
 *
 * Spec: @live-task-resource-markdown-rendering
 */

import { rewriteEntityResourceLinks } from "./resource-links";

/**
 * Minimal shape the rewriter needs from a task's `resolved_resources`
 * projection. Structurally compatible with the richer daemon projection
 * (`projectResolvedTaskResources` in `src/parser/task-resource-resolver.ts`
 * and the `resolved_resources` field the task detail API exposes), so callers
 * can pass the full projection objects directly.
 */
export interface ResolvedTaskResourceLink {
  /** Stable resource id used to build the task-scoped bytes URL. */
  id: string;
  /** Owner-relative path the author references as `./resources/<path>`. */
  path: string;
  /** Resolution status against the owning entity's current manifest. */
  status: "present" | "drift" | "missing" | "unresolved";
  /** Whether the resolved bytes come from the owning plan or a task-owned copy. */
  owner_type: "plan" | "task";
}

/**
 * Rewrite `./resources/<path>` markdown image/link targets in a task
 * description to the task-scoped resource bytes URL, scoped to the selected
 * project. Only references that resolve to a `present` task resource (whether
 * plan-owned or task-owned) are rewritten; unmatched, drifted, missing, or
 * unresolved references are left untouched so the author still sees the raw
 * reference and actionable guidance rather than a silent rewrite to bytes that
 * differ from what the task was derived against.
 *
 * @param markdown - the task description markdown.
 * @param resources - the task's resolved resource projection.
 * @param resourcesBaseUrl - the task-scoped `resources_base_url` from the task
 *   detail API; clients construct `${resourcesBaseUrl}/${id}/bytes`.
 *
 * AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
 * AC: @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
 * AC: @live-task-resource-markdown-rendering ac-materialized-task-image-renders
 * AC: @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
 * AC: @live-task-resource-markdown-rendering ac-drifted-task-resource-is-visible-not-silent
 * AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
 *
 * Spec: @live-task-resource-markdown-rendering
 */
export function rewriteTaskResourceLinks(
  markdown: string,
  resources: ResolvedTaskResourceLink[] | undefined,
  resourcesBaseUrl: string | undefined,
): string {
  return rewriteEntityResourceLinks(
    markdown,
    resources?.map((resource) => ({
      id: resource.id,
      path: resource.path,
      // Only non-drifted, present resources serve the bytes the task was
      // derived against; drift/missing/unresolved references stay raw so the
      // UI surfaces their status instead of silently serving different bytes.
      rewritable: resource.status === "present",
    })),
    resourcesBaseUrl,
  );
}
