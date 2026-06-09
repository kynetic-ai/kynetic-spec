import type { PlanResourceMetadata } from "@kynetic-ai/shared";

import { rewriteEntityResourceLinks } from "./resource-links";

/**
 * Rewrite `./resources/<path>` markdown link/image targets in a plan
 * document to safe URLs scoped to the owning plan. References whose relative
 * path matches a declared resource are rewritten to that resource's
 * safe fetch URL (built from the plan-scoped `resourcesBaseUrl`, carrying the
 * selected project's `kspec_dir` routing context in live multi-project mode);
 * unresolved references are left untouched so authors see the raw link with
 * visible guidance instead of a silent rewrite to a broken destination.
 *
 * `PlanResourceMetadata` is intentionally the strict 9-field shape — the
 * fetch URL lives outside the metadata object so all resource consumers
 * (API, CLI, static export, agent contexts) see an identical resource
 * record. Every declared plan resource is rewritable; the shared core
 * ({@link rewriteEntityResourceLinks}) handles pattern matching and the
 * selected-project `kspec_dir` append.
 *
 * Safe to run during SSR, in vitest, and in the static export pipeline —
 * `getSelectedProjectPath()` returns `null` outside the browser/in static
 * mode, so the rewrite emits the plain plan-scoped bytes URL there.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
 * AC: @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
 */
export function rewritePlanResourceLinks(
  markdown: string,
  resources: PlanResourceMetadata[] | undefined,
  resourcesBaseUrl: string | undefined,
): string {
  return rewriteEntityResourceLinks(
    markdown,
    resources?.map((resource) => ({ id: resource.id, path: resource.path })),
    resourcesBaseUrl,
  );
}
