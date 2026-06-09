/**
 * Entity-scoped resource markdown rewriting (shared core).
 *
 * Plan, task, and (future) other entity descriptions can author
 * `./resources/<relative-path>` markdown image and link targets that point at
 * the entity's declared/resolved resources. The browser cannot fetch those
 * author-style relative paths directly — they must be rewritten to the daemon's
 * entity-scoped resource bytes route (`<resources_base_url>/<id>/bytes`).
 *
 * Two cross-cutting concerns are factored here so every entity rewriter shares
 * one implementation:
 *
 *   1. Recognising author-style `./resources/<path>` references (inline images,
 *      inline links, and reference-style link definitions) without rewriting
 *      external URLs that merely share a `/resources/` path segment.
 *   2. Carrying selected-project routing context. An `<img src>` / `<a href>`
 *      request cannot send the `X-Kspec-Dir` header the rest of the API relies
 *      on, so when a non-default project is selected its path travels as a
 *      `?kspec_dir=` query parameter — exactly like `reviewResourceBytesUrl`
 *      in `$lib/api`. Without this, browser resource fetches in live
 *      multi-project mode fall back to the daemon default project and load the
 *      wrong bytes or 404.
 *
 * Reading `getSelectedProjectPath()` is SSR- and static-export-safe: it returns
 * `null` outside the browser and in static mode, so the rewrite emits the plain
 * entity-scoped bytes URL with no `kspec_dir` query in those contexts.
 *
 * AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
 * AC: @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
 * AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
 * AC: @live-task-resource-markdown-rendering ac-materialized-task-image-renders
 */

import { getSelectedProjectPath } from "../stores/project.svelte";

/**
 * Markdown link/image patterns that may target entity-owned resources:
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
 */
const RESOURCE_LINK_PATTERN =
  /(!?\[[^\]]*\]\()(\.\/resources\/[^\s)"']+)(\))|(^\s*\[[^\]]+\]:\s+)(\.\/resources\/[^\s"']+)/gm;

export const RESOURCE_AUTHORING_PREFIX = "./resources/";

/**
 * Minimal shape the shared rewriter needs from an entity's resource list.
 * Callers project their richer per-entity metadata (plan manifest entries,
 * resolved task resources) down to this before rewriting.
 */
export interface RewritableResource {
  /** Stable resource id used to build the entity-scoped bytes URL. */
  id: string;
  /** Owner-relative path the author references as `./resources/<path>`. */
  path: string;
  /**
   * Whether this resource is safe to rewrite to a bytes URL. Defaults to
   * `true`. Callers set `false` for references whose bytes would differ from
   * what the entity was authored/derived against (e.g. drifted/missing/
   * unresolved task resources) so the raw authoring reference stays visible
   * instead of silently serving different bytes.
   */
  rewritable?: boolean;
}

/**
 * Append the selected project's path as a `kspec_dir` query parameter so
 * browser-issued resource fetches route to the right project. No-op when no
 * project is selected (default-project routing) or outside the browser.
 */
function appendSelectedProjectContext(url: string): string {
  const projectPath = getSelectedProjectPath();
  if (!projectPath) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}kspec_dir=${encodeURIComponent(projectPath)}`;
}

/**
 * Rewrite `./resources/<path>` markdown image/link targets in an entity
 * description to the entity-scoped resource bytes URL, carrying selected-project
 * routing context. References whose relative path matches a rewritable resource
 * are rewritten to `<resourcesBaseUrl>/<encoded-id>/bytes` (plus `?kspec_dir=`
 * when a project is selected); unmatched or non-rewritable references are left
 * untouched so authors still see the raw reference and actionable guidance
 * instead of a silent rewrite to a broken or mismatched destination.
 *
 * @param markdown - the entity description markdown.
 * @param resources - the entity's resource list projected to {@link RewritableResource}.
 * @param resourcesBaseUrl - the entity-scoped resources base URL from the API.
 */
export function rewriteEntityResourceLinks(
  markdown: string,
  resources: RewritableResource[] | undefined,
  resourcesBaseUrl: string | undefined,
): string {
  if (!markdown || !resources || resources.length === 0 || !resourcesBaseUrl) return markdown;

  const trimmedBase = resourcesBaseUrl.endsWith("/")
    ? resourcesBaseUrl.slice(0, -1)
    : resourcesBaseUrl;

  const byPath = new Map<string, RewritableResource>();
  for (const resource of resources) {
    byPath.set(resource.path, resource);
  }

  return markdown.replace(
    RESOURCE_LINK_PATTERN,
    (
      match,
      inlinePrefix?: string,
      inlineTarget?: string,
      inlineSuffix?: string,
      refDefPrefix?: string,
      refDefTarget?: string,
    ) => {
      const target = inlineTarget ?? refDefTarget;
      if (!target) return match;
      const relative = target.slice(RESOURCE_AUTHORING_PREFIX.length);
      const resource = byPath.get(relative);
      if (!resource || resource.rewritable === false) return match;
      const url = appendSelectedProjectContext(
        `${trimmedBase}/${encodeURIComponent(resource.id)}/bytes`,
      );
      if (refDefPrefix !== undefined && refDefTarget !== undefined) {
        return `${refDefPrefix}${url}`;
      }
      return `${inlinePrefix ?? ""}${url}${inlineSuffix ?? ""}`;
    },
  );
}

/**
 * Extract the distinct author-style `./resources/<path>` relative paths that an
 * entity description references as markdown image/link targets. Recognises the
 * same inline-image, inline-link, and reference-style definition forms as
 * {@link rewriteEntityResourceLinks}, and ignores external URLs that merely
 * share a `/resources/` path segment.
 *
 * Entity UIs use this to detect references that have NO matching resolved
 * resource (so the rewriter left them raw): such references must be surfaced
 * with actionable guidance rather than silently rendered as a broken target
 * whose only on-screen trace is an `<img src>`/`<a href>` attribute the reader
 * never sees.
 *
 * @param markdown - the entity description markdown.
 * @returns the relative paths (e.g. `screens/missing.png`) in first-seen order,
 *   de-duplicated.
 */
export function extractResourceReferencePaths(markdown: string | undefined): string[] {
  if (!markdown) return [];
  // Use a fresh stateful regex so we never disturb the shared pattern's
  // `lastIndex` (it is also driven by `String.replace` above).
  const pattern = new RegExp(RESOURCE_LINK_PATTERN.source, RESOURCE_LINK_PATTERN.flags);
  const paths: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[2] ?? match[5];
    if (!target) continue;
    const relative = target.slice(RESOURCE_AUTHORING_PREFIX.length);
    if (relative && !seen.has(relative)) {
      seen.add(relative);
      paths.push(relative);
    }
  }
  return paths;
}
