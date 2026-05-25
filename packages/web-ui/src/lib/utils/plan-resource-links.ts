import type { PlanResourceMetadata } from "@kynetic-ai/shared";

/**
 * Markdown link/image patterns that may target plan-owned resources. The two
 * branches are:
 *
 *   1. `![alt](./resources/x)` — image (optional `!` prefix)
 *   2. `[label](./resources/x)` — inline link
 *   3. `[label]: ./resources/x` — reference-style link definition
 *
 * The trailing capture stops at whitespace, `)`, `"`, `'` so titles and
 * punctuation do not bleed into the path. Mirrors the resolver-side regex in
 * `src/parser/entity-local-resources.ts` (extractMarkdownResourceLinks) so
 * client-side rewriting catches the same author-style references the daemon
 * recognises.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 */
const PLAN_RESOURCE_LINK_PATTERN =
  /(!?\[[^\]]*\]\()(\.\/resources\/[^\s)"']+)(\))|(^\s*\[[^\]]+\]:\s+)(\.\/resources\/[^\s"']+)/gm;

const AUTHORING_PREFIX = "./resources/";

/**
 * Build the safe per-resource fetch URL clients render in place of an
 * author-style `./resources/<path>` reference. The base URL — `PlanDetail`'s
 * `resources_base_url` — comes from the daemon (`/api/plans/:ulid/resources`)
 * so this helper does not encode the daemon URL layout itself.
 */
function buildResourceFetchUrl(base: string, resource: PlanResourceMetadata): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${encodeURIComponent(resource.id)}/bytes`;
}

/**
 * Rewrite `./resources/<path>` markdown link/image targets in a plan
 * document to safe URLs scoped to the owning plan. References whose relative
 * path matches a declared resource are rewritten to that resource's
 * safe fetch URL (built from the plan-scoped `resourcesBaseUrl`); unresolved
 * references are left untouched so authors see the raw link with visible
 * guidance instead of a silent rewrite to a broken destination.
 *
 * `PlanResourceMetadata` is intentionally the strict 9-field shape — the
 * fetch URL lives outside the metadata object so all resource consumers
 * (API, CLI, static export, agent contexts) see an identical resource
 * record.
 *
 * Pure function — no DOM access — so it is safe to run during SSR, in
 * vitest, and in the static export pipeline.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export function rewritePlanResourceLinks(
  markdown: string,
  resources: PlanResourceMetadata[] | undefined,
  resourcesBaseUrl: string | undefined,
): string {
  if (!markdown || !resources || resources.length === 0 || !resourcesBaseUrl) return markdown;

  const byPath = new Map<string, PlanResourceMetadata>();
  for (const resource of resources) {
    byPath.set(resource.path, resource);
  }

  return markdown.replace(PLAN_RESOURCE_LINK_PATTERN, (
    match,
    inlinePrefix?: string,
    inlineTarget?: string,
    inlineSuffix?: string,
    refDefPrefix?: string,
    refDefTarget?: string,
  ) => {
    const target = inlineTarget ?? refDefTarget;
    if (!target) return match;
    const relative = target.slice(AUTHORING_PREFIX.length);
    const resource = byPath.get(relative);
    if (!resource) return match;
    const url = buildResourceFetchUrl(resourcesBaseUrl, resource);
    if (refDefPrefix !== undefined && refDefTarget !== undefined) {
      return `${refDefPrefix}${url}`;
    }
    return `${inlinePrefix ?? ""}${url}${inlineSuffix ?? ""}`;
  });
}
