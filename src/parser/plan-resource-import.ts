/**
 * Plan resource import helpers.
 *
 * Bridges the sibling `resources.yaml` declaration that ships next to an
 * authored plan markdown file and the plan's on-disk resource manifest under
 * `.kspec/plans/<plan-ulid>/`. Used by `kspec plan import` (new plans, copy
 * declared sibling files into the plan directory) and the
 * existing-plan content-update paths (`kspec plan import --into` and
 * `kspec plan set --content-file`) which only validate that every markdown
 * link resolves against the plan's already-attached resources.
 *
 * Spec: @plan-resource-derivation-semantics-1
 *       @trait-entity-scoped-local-resources-1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  computeResourceMetadata,
  extractMarkdownResourceLinks,
  getResourcesDir,
  loadResourceManifest,
  validateResourceId,
  validateResourceRelativePath,
  writeResourceManifest,
  type MarkdownResourceLink,
} from "./entity-local-resources.js";
import { getPlanDir, refreshPlanIndexEntry } from "./plan-storage-manager.js";
import {
  PlanResourceImportManifestSchema,
  type PlanResourceImportManifest,
  type ResourceMetadata,
} from "../schema/resources.js";
import type { KspecContext } from "./yaml.js";

/**
 * Filename of the sibling manifest that authors place next to a plan markdown
 * file when the plan references local resource files.
 */
export const SIBLING_RESOURCES_MANIFEST_FILENAME = "resources.yaml";

/**
 * Directory next to a plan markdown file that holds the actual resource bytes
 * the manifest describes. Each declared `path` is resolved relative to this
 * directory.
 */
export const SIBLING_RESOURCES_DIR_NAME = "resources";

/**
 * Strongly-typed error raised when plan import validation fails. The CLI
 * maps these into its existing exit-code helpers — keeping the helper
 * module CLI-agnostic so daemon/import-script integrations can also call it.
 */
export class PlanImportResourceError extends Error {
  readonly code:
    | "missing_sibling_manifest"
    | "invalid_sibling_manifest"
    | "duplicate_resource_id"
    | "duplicate_resource_path"
    | "undeclared_markdown_link"
    | "missing_sibling_source_file"
    | "unreadable_sibling_source_file"
    | "unsafe_sibling_source_file"
    | "invalid_resource_id"
    | "invalid_resource_path";
  readonly resourceId?: string;
  readonly path?: string;
  readonly sourceFile?: string;
  readonly line?: number;

  constructor(
    code: PlanImportResourceError["code"],
    message: string,
    fields: {
      resourceId?: string;
      path?: string;
      sourceFile?: string;
      line?: number;
    } = {},
  ) {
    super(message);
    this.name = "PlanImportResourceError";
    this.code = code;
    this.resourceId = fields.resourceId;
    this.path = fields.path;
    this.sourceFile = fields.sourceFile;
    this.line = fields.line;
  }
}

/**
 * Result of validating a new plan import's sibling manifest against the
 * plan's markdown links.
 */
export interface PlanImportResourceValidation {
  /** Parsed sibling manifest contents. */
  manifest: PlanResourceImportManifest;
  /** Absolute paths to each declared source file in the sibling tree. */
  resolvedSources: Map<string, string>;
  /** Markdown links discovered in the plan content. */
  links: MarkdownResourceLink[];
}

/**
 * Load + validate the sibling `resources.yaml` next to a plan markdown file.
 *
 * Validation rules (all enforced before any bytes are copied):
 *
 *   - Sibling manifest is required when the markdown contains any
 *     `./resources/<rel>` reference.
 *   - Manifest entries must have valid resource ids and POSIX-relative paths.
 *   - Resource ids must be unique within the manifest.
 *   - Resource paths must be unique within the manifest.
 *   - Every markdown link's target path must appear in the manifest.
 *   - Each declared path must resolve to a regular file under the sibling
 *     `resources/<path>` directory.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function validatePlanImportResources(
  planMdAbsolutePath: string,
  markdownContent: string,
): Promise<PlanImportResourceValidation> {
  const planDir = path.dirname(planMdAbsolutePath);
  const manifestPath = path.join(planDir, SIBLING_RESOURCES_MANIFEST_FILENAME);
  const siblingResourcesDir = path.join(planDir, SIBLING_RESOURCES_DIR_NAME);

  const links = extractMarkdownResourceLinks(markdownContent);
  let manifest: PlanResourceImportManifest = { resources: [] };
  let manifestText: string | null = null;
  try {
    manifestText = await fs.readFile(manifestPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new PlanImportResourceError(
        "invalid_sibling_manifest",
        `Failed to read sibling resources manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
        { sourceFile: manifestPath },
      );
    }
    // ENOENT — no sibling manifest. Allowed only when the markdown has no
    // resource links; otherwise this is a missing_sibling_manifest failure.
    if (links.length > 0) {
      throw new PlanImportResourceError(
        "missing_sibling_manifest",
        `Plan markdown references ${links.length} local resource(s) but the sibling ${SIBLING_RESOURCES_MANIFEST_FILENAME} next to ${path.basename(planMdAbsolutePath)} is missing. Declare each referenced file in ${manifestPath} before importing.`,
        { sourceFile: manifestPath },
      );
    }
    return { manifest, resolvedSources: new Map(), links };
  }

  let rawManifest: unknown;
  try {
    rawManifest = parseYaml(manifestText);
  } catch (err) {
    throw new PlanImportResourceError(
      "invalid_sibling_manifest",
      `Sibling resources manifest at ${manifestPath} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      { sourceFile: manifestPath },
    );
  }
  const parsed = PlanResourceImportManifestSchema.safeParse(rawManifest ?? { resources: [] });
  if (!parsed.success) {
    throw new PlanImportResourceError(
      "invalid_sibling_manifest",
      `Sibling resources manifest at ${manifestPath} failed schema validation: ${parsed.error.message}`,
      { sourceFile: manifestPath },
    );
  }
  manifest = parsed.data;

  const seenIds = new Map<string, string>();
  const seenPaths = new Map<string, string>();
  for (const entry of manifest.resources) {
    const idCheck = validateResourceId(entry.id);
    if (!idCheck.ok) {
      throw new PlanImportResourceError("invalid_resource_id", idCheck.error, {
        resourceId: entry.id,
        path: entry.path,
        sourceFile: manifestPath,
      });
    }
    const pathCheck = validateResourceRelativePath(entry.path);
    if (!pathCheck.ok) {
      throw new PlanImportResourceError("invalid_resource_path", pathCheck.error, {
        resourceId: entry.id,
        path: entry.path,
        sourceFile: manifestPath,
      });
    }
    if (seenIds.has(entry.id)) {
      throw new PlanImportResourceError(
        "duplicate_resource_id",
        `Sibling manifest declares resource id "${entry.id}" twice. Each id may appear once.`,
        { resourceId: entry.id, sourceFile: manifestPath },
      );
    }
    if (seenPaths.has(entry.path)) {
      throw new PlanImportResourceError(
        "duplicate_resource_path",
        `Sibling manifest declares path "${entry.path}" twice (ids ${seenPaths.get(entry.path)} and ${entry.id}). Each resource path may appear once.`,
        { resourceId: entry.id, path: entry.path, sourceFile: manifestPath },
      );
    }
    seenIds.set(entry.id, entry.path);
    seenPaths.set(entry.path, entry.id);
  }

  // Every markdown link must resolve to a declared resource path.
  const declaredPaths = new Set(manifest.resources.map((r) => r.path));
  for (const link of links) {
    const pathCheck = validateResourceRelativePath(link.relativePath);
    if (!pathCheck.ok) {
      throw new PlanImportResourceError(
        "invalid_resource_path",
        `Plan markdown link "${link.rawTarget}" (line ${link.line}) is not a safe resource path: ${pathCheck.error}`,
        { path: link.relativePath, sourceFile: planMdAbsolutePath, line: link.line },
      );
    }
    if (!declaredPaths.has(link.relativePath)) {
      throw new PlanImportResourceError(
        "undeclared_markdown_link",
        `Plan markdown link "${link.rawTarget}" (line ${link.line}) is not declared in ${path.basename(manifestPath)}. Add an entry with this path or remove the link.`,
        { path: link.relativePath, sourceFile: manifestPath, line: link.line },
      );
    }
  }

  // Every declared file must exist as a readable regular file under the
  // sibling resources/ directory. Validate up-front so we never copy a
  // partial batch into the plan directory.
  //
  // Containment is enforced by resolving the realpath of each declared
  // file and rejecting any path whose real location is not inside the
  // sibling resources tree. fs.stat alone would silently follow symlinks
  // and let `imports/resources/linked.txt → /outside/secret` be copied
  // into the plan directory, violating the trait's "symlink escapes are
  // forbidden" contract. We also reject the sibling resources directory
  // itself being a symlink so a maliciously prepared bundle cannot
  // re-root the whole tree.
  const resolvedSources = new Map<string, string>();
  let realSiblingResourcesDir: string | null = null;
  try {
    const siblingDirStat = await fs.lstat(siblingResourcesDir);
    if (siblingDirStat.isSymbolicLink()) {
      throw new PlanImportResourceError(
        "unsafe_sibling_source_file",
        `Sibling resources directory ${siblingResourcesDir} is a symlink; symlinked sibling resources/ trees are rejected to keep all resolution inside the import bundle.`,
        { sourceFile: siblingResourcesDir },
      );
    }
    realSiblingResourcesDir = await fs.realpath(siblingResourcesDir);
  } catch (err) {
    if (err instanceof PlanImportResourceError) throw err;
    // ENOENT or any other lstat/realpath failure for the directory falls
    // through to the per-entry check below, which surfaces the same
    // missing_sibling_source_file diagnostic the existing tests rely on.
  }

  for (const entry of manifest.resources) {
    const sourceFile = path.join(siblingResourcesDir, entry.path);
    let leafLstat;
    try {
      leafLstat = await fs.lstat(sourceFile);
    } catch {
      throw new PlanImportResourceError(
        "missing_sibling_source_file",
        `Declared resource "${entry.id}" → ${entry.path} has no source file at ${sourceFile}. Place the file under ${SIBLING_RESOURCES_DIR_NAME}/ next to the plan markdown.`,
        { resourceId: entry.id, path: entry.path, sourceFile },
      );
    }
    if (leafLstat.isSymbolicLink()) {
      throw new PlanImportResourceError(
        "unsafe_sibling_source_file",
        `Declared resource "${entry.id}" → ${entry.path} is a symlink at ${sourceFile}; symlinked sibling resources are rejected because they may resolve outside the import bundle.`,
        { resourceId: entry.id, path: entry.path, sourceFile },
      );
    }
    let realSource: string;
    try {
      realSource = await fs.realpath(sourceFile);
    } catch {
      throw new PlanImportResourceError(
        "missing_sibling_source_file",
        `Declared resource "${entry.id}" → ${entry.path} could not be resolved at ${sourceFile}.`,
        { resourceId: entry.id, path: entry.path, sourceFile },
      );
    }
    if (realSiblingResourcesDir !== null) {
      const relativeToReal = path.relative(realSiblingResourcesDir, realSource);
      if (
        relativeToReal === "" ||
        relativeToReal.startsWith("..") ||
        path.isAbsolute(relativeToReal)
      ) {
        throw new PlanImportResourceError(
          "unsafe_sibling_source_file",
          `Declared resource "${entry.id}" → ${entry.path} resolves outside the sibling ${SIBLING_RESOURCES_DIR_NAME}/ tree at ${sourceFile}; symlink escapes are rejected.`,
          { resourceId: entry.id, path: entry.path, sourceFile },
        );
      }
    }
    let stat;
    try {
      stat = await fs.stat(realSource);
    } catch {
      throw new PlanImportResourceError(
        "missing_sibling_source_file",
        `Declared resource "${entry.id}" → ${entry.path} could not be read at ${sourceFile}.`,
        { resourceId: entry.id, path: entry.path, sourceFile },
      );
    }
    if (!stat.isFile()) {
      throw new PlanImportResourceError(
        "unreadable_sibling_source_file",
        `Declared resource "${entry.id}" → ${entry.path} resolved to a non-file at ${sourceFile}. Sibling resources must be regular files.`,
        { resourceId: entry.id, path: entry.path, sourceFile },
      );
    }
    resolvedSources.set(entry.id, sourceFile);
  }

  return { manifest, resolvedSources, links };
}

/**
 * Copy declared sibling resources into the plan's on-disk directory and
 * write the plan's `resources.yaml` manifest with full `ResourceMetadata`
 * entries (id, label, path, content_type, bytes, sha256, git_commit,
 * git_path, description) computed from the destination files.
 *
 * Must be called after the plan record has been saved so the plan directory
 * exists at `.kspec/plans/<plan-ulid>/`. After persisting the manifest,
 * the owning plan's bounded index entry is refreshed in the same logical
 * mutation so `project.plans.yaml.resource_summary` reflects the new
 * resources without needing a follow-up `rebuild-index` run.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
 * AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
 */
export async function persistPlanResourcesFromSibling(
  ctx: KspecContext,
  planUlid: string,
  validation: PlanImportResourceValidation,
): Promise<ResourceMetadata[]> {
  if (validation.manifest.resources.length === 0) return [];

  const planDir = getPlanDir(ctx, planUlid);
  const resourcesDir = getResourcesDir(planDir);
  await fs.mkdir(resourcesDir, { recursive: true });

  const metadataEntries: ResourceMetadata[] = [];
  for (const entry of validation.manifest.resources) {
    const sourceFile = validation.resolvedSources.get(entry.id);
    if (!sourceFile) {
      // Should never happen — validation guarantees a source for every id.
      throw new PlanImportResourceError(
        "missing_sibling_source_file",
        `Internal error: no resolved source file for declared resource "${entry.id}".`,
        { resourceId: entry.id, path: entry.path },
      );
    }
    const destination = path.join(resourcesDir, entry.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(sourceFile, destination);

    const result = await computeResourceMetadata({
      id: entry.id,
      relativePath: entry.path,
      absolutePath: destination,
      contentType: entry.content_type ?? null,
      label: entry.label ?? null,
      description: entry.description ?? null,
    });
    if (!result.ok) {
      throw new PlanImportResourceError("invalid_resource_path", result.error, {
        resourceId: entry.id,
        path: entry.path,
        sourceFile,
      });
    }
    metadataEntries.push(result.value);
  }

  await writeResourceManifest(planDir, { resources: metadataEntries });
  // The lean index now has a stale resource_summary — refresh it inside the
  // same atomic mutation so list/dashboard/API consumers see the new bytes
  // without a manual rebuild-index. See refreshPlanIndexEntry for locking.
  await refreshPlanIndexEntry(ctx, planUlid);
  return metadataEntries;
}

/**
 * Validate that every `./resources/<rel>` reference in markdown content
 * resolves against the supplied plan's on-disk resource manifest. Used by
 * the existing-plan content-update paths (`kspec plan import --into`,
 * `kspec plan set --content-file`) where the user must attach resources
 * via `kspec plan resource add` before referencing them from markdown.
 *
 * Returns the discovered links; throws `PlanImportResourceError` on
 * unresolved or unsafe references.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function assertMarkdownLinksResolveAgainstPlan(
  planDir: string,
  markdownContent: string,
  sourceLabel: string,
): Promise<MarkdownResourceLink[]> {
  const links = extractMarkdownResourceLinks(markdownContent);
  if (links.length === 0) return links;

  const manifest = await loadResourceManifest(planDir);
  const declaredPaths = new Set(manifest.resources.map((r) => r.path));
  for (const link of links) {
    const pathCheck = validateResourceRelativePath(link.relativePath);
    if (!pathCheck.ok) {
      throw new PlanImportResourceError(
        "invalid_resource_path",
        `Plan markdown link "${link.rawTarget}" (line ${link.line}) is not a safe resource path: ${pathCheck.error}`,
        { path: link.relativePath, sourceFile: sourceLabel, line: link.line },
      );
    }
    if (!declaredPaths.has(link.relativePath)) {
      throw new PlanImportResourceError(
        "undeclared_markdown_link",
        `Plan markdown link "${link.rawTarget}" (line ${link.line}) is not declared on the plan's existing resources. Attach the resource first with "kspec plan resource add" or remove the link.`,
        { path: link.relativePath, sourceFile: sourceLabel, line: link.line },
      );
    }
  }
  return links;
}
