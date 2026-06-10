/**
 * Review structured-content resource markdown handling.
 *
 * Markdown sections returned by `GET /api/reviews/:id/content` can embed plan
 * content or a task description that authors `./resources/<relative-path>`
 * image and document-link targets. The section's byte-free `resource_context`
 * names the owning entity, its entity-scoped bytes base URL, and the bounded
 * resource metadata/status — exactly what the plan and task detail views use.
 * This module dispatches to the same shared rewriters
 * ({@link rewritePlanResourceLinks} / {@link rewriteTaskResourceLinks}) so the
 * review page never duplicates a plan-only regex or invents its own rewrite
 * semantics:
 *
 *   - plan sections rewrite only declared manifest resources; undeclared or
 *     unsafe paths stay visible untouched.
 *   - task sections rewrite only `present` resolved resources (plan-owned refs
 *     and materialized task-owned copies alike); drifted/missing/unresolved
 *     references stay raw and are surfaced as actionable guidance instead of
 *     silently serving replacement bytes.
 *
 * AC: @review-structured-content-viewer ac-5
 * AC: @review-structured-content-viewer ac-6
 */

import type { ReviewContentResourceContext } from "@kynetic-ai/shared";

import { rewritePlanResourceLinks } from "./plan-resource-links";
import {
  findUnmatchedTaskResourceReferences,
  rewriteTaskResourceLinks,
} from "./task-resource-links";

/**
 * Rewrite `./resources/<path>` markdown targets in a review content markdown
 * section using its byte-free resource context. Sections without a context
 * (spec descriptions, resource-free subjects) render unchanged.
 *
 * AC: @review-structured-content-viewer ac-5
 * AC: @review-structured-content-viewer ac-6
 */
export function rewriteReviewSectionResourceLinks(
  markdown: string,
  context: ReviewContentResourceContext | undefined,
): string {
  if (!markdown || !context) return markdown;
  if (context.owner_type === "plan") {
    return rewritePlanResourceLinks(markdown, context.resources, context.resources_base_url);
  }
  return rewriteTaskResourceLinks(markdown, context.resources, context.resources_base_url);
}

/**
 * A resource reference in a review markdown section that could not be
 * rewritten to a bytes URL and must stay visible with actionable status.
 */
export interface ReviewSectionResourceGuidanceItem {
  status: "drift" | "missing" | "unresolved" | "unmatched";
  /** Owner-relative path the section references as `./resources/<path>`. */
  path: string;
  /** Human-readable status message explaining why the bytes are not served. */
  message: string;
}

/**
 * Collect the resource status messages a task review section must show:
 * resolved task resources whose status is not `present` (drift/missing/
 * unresolved — the rewriter leaves them raw so different bytes are never
 * silently served) plus authored `./resources/<path>` references that match
 * no resolved resource at all (unmatched — without explicit detection their
 * only on-screen trace is a broken `<img src>`/`<a href>`).
 *
 * Plan sections return no guidance: plan contexts carry only declared
 * resources, and AC-5's contract is that undeclared/unsafe paths simply stay
 * visible untouched in the rendered markdown.
 *
 * AC: @review-structured-content-viewer ac-6
 */
export function reviewSectionResourceGuidance(
  markdown: string | undefined,
  context: ReviewContentResourceContext | undefined,
): ReviewSectionResourceGuidanceItem[] {
  if (!context || context.owner_type !== "task") return [];

  const unhealthy = context.resources
    .filter((resource) => resource.status !== "present")
    .map((resource) => ({
      status: resource.status as "drift" | "missing" | "unresolved",
      path: resource.path,
      message: resource.message,
    }));

  const unmatched = findUnmatchedTaskResourceReferences(markdown, context.resources).map(
    (path) => ({
      status: "unmatched" as const,
      path,
      message:
        "No matching task resource — verify the reference path or re-derive the task with this resource present.",
    }),
  );

  return [...unhealthy, ...unmatched];
}
