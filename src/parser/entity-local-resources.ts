/**
 * Entity-scoped local resources trait foundation.
 *
 * Shared schema, validators, resolver, and static-export helpers for entities
 * that own local resource files alongside their structured data. Resource
 * files live under the owning entity directory's `resources/` subdirectory
 * and are declared in `resources.yaml`. User-authored references use
 * `./resources/<relative-path>`; consumers receive normalized owner/type/
 * resource metadata instead of arbitrary file paths.
 *
 * This module defines:
 *   - the on-disk manifest schema (re-exported from `src/schema/resources.ts`),
 *   - path layout helpers (`getResourcesDir`, `getResourcesManifestPath`,
 *     `getStaticExportResourcePath`),
 *   - authoring-reference parsing and POSIX-relative-path validation,
 *   - a symlink-safe resolver that constrains all resolution to the owning
 *     resources tree,
 *   - content-type validation/inference (explicit value, then extension
 *     lookup, then `application/octet-stream`),
 *   - bounded previews that never inline binary or oversized text bytes
 *     into YAML records,
 *   - a static-export copier that drops resource files at the standard
 *     `assets/resources/<entity-type>/<entity-ulid>/<relative-path>` layout.
 *
 * Spec: @trait-entity-scoped-local-resources-1
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  CONTENT_TYPE_PATTERN,
  RESOURCE_ID_PATTERN,
  RESOURCE_MANIFEST_SCHEMA_KEYS,
  type ResourceManifest,
  ResourceManifestSchema,
  type ResourceMetadata,
  ResourceMetadataSchema,
  ResourcePathSchema,
  checkResourceRelativePath,
} from "../schema/resources.js";
import { requireResourceFolderStorage } from "./entity-storage-compatibility.js";
import { type KspecContext, readYamlFile, writeYamlFile } from "./yaml.js";

export {
  CONTENT_TYPE_PATTERN,
  RESOURCE_ID_PATTERN,
  RESOURCE_MANIFEST_SCHEMA_KEYS,
  ResourceManifestSchema,
  ResourceMetadataSchema,
  ResourcePathSchema,
  checkResourceRelativePath,
};
export type { ResourceManifest, ResourceMetadata };

// ── Constants ────────────────────────────────────────────────────────────────

/** Subdirectory under each owning entity directory that holds resource files. */
export const RESOURCES_DIR_NAME = "resources";

/** Filename of the resource manifest inside each owning entity directory. */
export const RESOURCES_MANIFEST_FILENAME = "resources.yaml";

/** Required prefix for user-authored resource references. */
export const RESOURCE_AUTHORING_PREFIX = "./resources/";

/**
 * Standard subdirectory under a static-export root that owns all
 * exported resource files: `assets/resources/<entity-type>/<entity-ulid>/<relative-path>`.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
export const STATIC_EXPORT_RESOURCES_PREFIX = path.posix.join("assets", "resources");

/**
 * Content type stored when explicit input is absent and extension inference
 * does not match any known type.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * Max bytes of bounded preview text returned by `getResourcePreview`.
 * Chosen to fit comfortably inside a single API/UI surface payload while
 * still allowing useful inspection of text resources.
 */
export const RESOURCE_PREVIEW_MAX_BYTES = 4096;

// ── Extension → MIME Lookup ──────────────────────────────────────────────────

/**
 * Lightweight built-in extension → MIME map used when no project-specific
 * MIME lookup is configured. Covers the common formats that flow through
 * plan and review attachments (screenshots, diagrams, logs, transcripts,
 * tabular data, archives). Unknown extensions fall back to
 * `application/octet-stream`.
 *
 * The mapping is intentionally small and self-contained — adding a heavy
 * MIME database would inflate the binary footprint for a corner case that
 * is not in scope for this trait foundation.
 */
const EXTENSION_TO_CONTENT_TYPE: ReadonlyMap<string, string> = new Map(
  Object.entries({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".ico": "image/vnd.microsoft.icon",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".toml": "application/toml",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".xml": "application/xml",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
  }),
);

// ── Result Type ──────────────────────────────────────────────────────────────

/**
 * Pure validation result — never throws, never exits. Callers pattern-match
 * on `ok` and map errors to HTTP, CLI, or YAML diagnostics at the boundary.
 */
export type ResourceValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Categorized failure kinds produced by {@link resolveResourcePath}. Lets
 * callers map resolver outcomes onto their own structured error codes
 * (e.g. CLI/HTTP layers) without pattern-matching on error message text.
 *
 * The categories are deliberately resolver-shaped, not surface-shaped:
 * surfaces decide how to render them (CLI exit codes, HTTP status). The
 * key contract is that `symlink_escape` and `not_a_regular_file` describe
 * path-safety rejections that must NOT be reported as "missing" — the
 * declared path exists but is not a safe resolution.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 */
export type ResourceResolutionErrorKind =
  /** Textual path validation rejected the input (traversal, absolute, backslash, etc.). */
  | "path_invalid"
  /** Path not declared in the supplied manifest. */
  | "not_declared"
  /** Owner resources directory or candidate file does not exist on disk. */
  | "missing"
  /**
   * Symlink at the owner root, an intermediate directory, the destination
   * leaf, or a realpath-containment violation after resolution. Path-safety
   * rejection — distinct from `missing` so callers can map to 400-level
   * "invalid path" responses rather than 404 "not found".
   */
  | "symlink_escape"
  /** Destination resolves to a non-file (directory, socket, FIFO, etc.). */
  | "not_a_regular_file";

/**
 * Result variant for {@link resolveResourcePath} that carries a categorized
 * `kind` discriminator on the failure branch. Assignable to
 * {@link ResourceValidationResult} via structural width subtyping — callers
 * that only need the error string can ignore `kind`.
 */
export type ResourceResolutionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; kind: ResourceResolutionErrorKind };

// ── Path Helpers ─────────────────────────────────────────────────────────────

/**
 * Path to the resources directory for one owning entity
 * (`<ownerEntityDir>/resources/`).
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 */
export function getResourcesDir(ownerEntityDir: string): string {
  return path.join(ownerEntityDir, RESOURCES_DIR_NAME);
}

/**
 * Path to the resource manifest for one owning entity
 * (`<ownerEntityDir>/resources.yaml`).
 */
export function getResourcesManifestPath(ownerEntityDir: string): string {
  return path.join(ownerEntityDir, RESOURCES_MANIFEST_FILENAME);
}

/**
 * Path under a static-export root where one resource file should be copied:
 * `<exportRoot>/assets/resources/<entityType>/<entityUlid>/<relativePath>`.
 *
 * Uses POSIX joins because static-export paths are part of the exported
 * artifact contract and must not vary by host OS path separator.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
export function getStaticExportResourcePath(
  exportRoot: string,
  entityType: string,
  entityUlid: string,
  relativePath: string,
): string {
  return path.posix.join(
    exportRoot,
    STATIC_EXPORT_RESOURCES_PREFIX,
    entityType,
    entityUlid,
    relativePath,
  );
}

// ── Identifier Validation ───────────────────────────────────────────────────

/**
 * Validate a resource id against `RESOURCE_ID_PATTERN`.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export function validateResourceId(id: string): ResourceValidationResult<string> {
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: "Resource id must be a non-empty string." };
  }
  if (!RESOURCE_ID_PATTERN.test(id)) {
    return {
      ok: false,
      error: `Resource id "${id}" must match [a-z0-9][a-z0-9._-]{0,127} (lowercase, starts with letter or digit, dot/underscore/hyphen allowed).`,
    };
  }
  return { ok: true, value: id };
}

// ── Reference / Path Validation ──────────────────────────────────────────────

/**
 * Validate that a string is a safe POSIX-relative path under an entity's
 * `resources/` directory. Delegates to `checkResourceRelativePath` from the
 * schema module so the runtime validator and the manifest schema reject
 * identical shapes.
 *
 * The validator is purely textual — it does not touch the filesystem. Pair
 * it with `resolveResourcePath` to enforce symlink-safe resolution.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export function validateResourceRelativePath(
  relativePath: string,
): ResourceValidationResult<string> {
  const error = checkResourceRelativePath(relativePath);
  if (error !== null) return { ok: false, error };
  return { ok: true, value: relativePath };
}

/**
 * Parsed `./resources/<relative-path>` reference.
 */
export interface ParsedResourceReference {
  /** The portion after `./resources/`, validated as a POSIX-relative path. */
  relativePath: string;
}

/**
 * Parse and validate an authoring-style resource reference. Only the exact
 * `./resources/<relative-path>` form is accepted — other relative shapes
 * (`resources/x`, `./x`, `../y`, `/abs`) are rejected with actionable
 * guidance so users get the same answer through any surface (CLI, UI, API).
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export function parseResourceReference(
  reference: string,
): ResourceValidationResult<ParsedResourceReference> {
  if (typeof reference !== "string" || reference.length === 0) {
    return {
      ok: false,
      error: 'Resource reference must be a non-empty "./resources/<relative-path>" string.',
    };
  }
  if (!reference.startsWith(RESOURCE_AUTHORING_PREFIX)) {
    return {
      ok: false,
      error: `Resource reference "${reference}" must start with "./resources/"; only entity-owned sidecar paths are accepted.`,
    };
  }
  const relativePath = reference.slice(RESOURCE_AUTHORING_PREFIX.length);
  const validation = validateResourceRelativePath(relativePath);
  if (!validation.ok) return validation;
  return { ok: true, value: { relativePath: validation.value } };
}

/**
 * Format a `./resources/<relative-path>` authoring reference from a
 * pre-validated relative path. Useful for round-tripping resource metadata
 * through user-facing surfaces.
 */
export function formatResourceReference(relativePath: string): string {
  return `${RESOURCE_AUTHORING_PREFIX}${relativePath}`;
}

// ── Markdown Link Extraction ─────────────────────────────────────────────────

/**
 * A single `./resources/<relative-path>` reference discovered in a markdown
 * document. Captures the validated relative path plus the byte offset where
 * the link appeared so error messages can point users at the right line.
 */
export interface MarkdownResourceLink {
  /** Original raw link target (e.g. `./resources/screenshots/login.png`). */
  rawTarget: string;
  /** Validated POSIX-relative path under the entity's resources/ directory. */
  relativePath: string;
  /** Byte index where the link target starts in the source markdown. */
  offset: number;
  /** 1-based line number where the link was found. */
  line: number;
}

/**
 * Regex matching markdown links/images and reference-style link definitions
 * whose target begins with `./resources/`. Three branches:
 *
 *   1. `![alt](./resources/x)` — image
 *   2. `[label](./resources/x)` — inline link
 *   3. `[label]: ./resources/x` — reference definition (line-start)
 *
 * The trailing capture stops at whitespace, `)`, `"`, or `'` so titles and
 * trailing punctuation do not poison the path.
 */
const MARKDOWN_RESOURCE_LINK_REGEX =
  /!?\[[^\]]*\]\((\.\/resources\/[^\s)"']+)\)|^\s*\[[^\]]+\]:\s+(\.\/resources\/[^\s"']+)/gm;

/**
 * Extract every `./resources/<relative-path>` reference from a markdown
 * document. Returns parsed entries with byte offset and line for each link.
 * Invalid paths (absolute, traversal, undeclared) are still surfaced so the
 * caller can produce a single batched error envelope instead of stopping
 * at the first bad link.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 */
export function extractMarkdownResourceLinks(content: string): MarkdownResourceLink[] {
  const links: MarkdownResourceLink[] = [];
  if (typeof content !== "string" || content.length === 0) return links;
  const newlineOffsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") newlineOffsets.push(i);
  }
  const lineForOffset = (offset: number): number => {
    // Binary-search-free is fine here — markdown documents are short.
    let line = 1;
    for (const nlOffset of newlineOffsets) {
      if (nlOffset >= offset) break;
      line += 1;
    }
    return line;
  };

  for (const match of content.matchAll(MARKDOWN_RESOURCE_LINK_REGEX)) {
    const rawTarget = match[1] ?? match[2];
    if (!rawTarget) continue;
    const offset = (match.index ?? 0) + match[0].indexOf(rawTarget);
    const relativePath = rawTarget.slice(RESOURCE_AUTHORING_PREFIX.length);
    links.push({
      rawTarget,
      relativePath,
      offset,
      line: lineForOffset(offset),
    });
  }
  return links;
}

// ── Symlink-Safe Resolver ────────────────────────────────────────────────────

/**
 * Resolved location of a resource on disk, after symlink-safety checks.
 */
export interface ResolvedResourceLocation {
  /** Real (symlink-followed) absolute path to the resource file. */
  absolutePath: string;
  /** The POSIX-relative path under the owner resources tree. */
  relativePath: string;
}

/**
 * Resolve a `./resources/<relative-path>` reference (or already-parsed
 * relative path) against an owning entity's resources directory, rejecting
 * anything that is not declared in the manifest or that escapes the tree
 * via path traversal or symlink redirection.
 *
 * The resolver:
 *   1. validates the relative path textually,
 *   2. requires the relative path to appear in the supplied manifest's
 *      `resources[*].path` list — undeclared paths are rejected even if
 *      the file exists on disk, satisfying the "no arbitrary filesystem
 *      reads" contract for API/static-export/agent surfaces,
 *   3. checks that the owner resources directory is itself a real
 *      directory (not a symlink to outside the entity tree),
 *   4. resolves the realpath of the owner resources root and the
 *      candidate file,
 *   5. requires the candidate realpath to be located *inside* the owner
 *      realpath. Anything outside is rejected with actionable guidance.
 *
 * Step 3 is essential: without it, a symlinked `<entity>/resources/`
 * directory would silently redirect every declared file to whichever
 * outside tree the symlink targets, and the realpath-based containment
 * check below would still pass because both the owner and its files
 * resolve into the same (outside) target.
 *
 * The manifest argument is required. Callers that have not yet parsed a
 * manifest should use `resolveResourceReference`, which loads
 * `resources.yaml` from disk and then delegates here.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function resolveResourcePath(options: {
  ownerResourcesDir: string;
  relativePath: string;
  manifest: ResourceManifest;
}): Promise<ResourceResolutionResult<ResolvedResourceLocation>> {
  const pathValidation = validateResourceRelativePath(options.relativePath);
  if (!pathValidation.ok) {
    return { ok: false, error: pathValidation.error, kind: "path_invalid" };
  }
  const relativePath = pathValidation.value;

  const declared = options.manifest.resources.some((r) => r.path === relativePath);
  if (!declared) {
    return {
      ok: false,
      kind: "not_declared",
      error: `Resource path "${relativePath}" is not declared in the owning entity's resources.yaml manifest. Add an entry with this path or use an existing declared path.`,
    };
  }

  let ownerStat;
  try {
    ownerStat = await fs.lstat(options.ownerResourcesDir);
  } catch {
    return {
      ok: false,
      kind: "missing",
      error: `Owning entity has no resources directory yet; declare resources via resources.yaml before resolving "${relativePath}".`,
    };
  }
  if (ownerStat.isSymbolicLink()) {
    return {
      ok: false,
      kind: "symlink_escape",
      error: `Resource path "${relativePath}" cannot be resolved: the owning entity's resources/ directory is itself a symlink, which is rejected so all resolution stays inside the entity tree.`,
    };
  }
  if (!ownerStat.isDirectory()) {
    return {
      ok: false,
      kind: "missing",
      error: `Resource path "${relativePath}" cannot be resolved: the owning entity's resources/ path is not a directory.`,
    };
  }

  let realOwner: string;
  try {
    realOwner = await fs.realpath(options.ownerResourcesDir);
  } catch {
    return {
      ok: false,
      kind: "missing",
      error: `Owning entity has no resources directory yet; declare resources via resources.yaml before resolving "${relativePath}".`,
    };
  }

  const candidate = path.resolve(options.ownerResourcesDir, relativePath);
  let realCandidate: string;
  try {
    realCandidate = await fs.realpath(candidate);
  } catch {
    return {
      ok: false,
      kind: "missing",
      error: `Resource file "${relativePath}" does not exist under the owning entity's resources/ directory.`,
    };
  }

  const relativeToOwner = path.relative(realOwner, realCandidate);
  if (
    relativeToOwner === "" ||
    relativeToOwner.startsWith("..") ||
    path.isAbsolute(relativeToOwner)
  ) {
    return {
      ok: false,
      kind: "symlink_escape",
      error: `Resource path "${relativePath}" resolves through a symlink that escapes the owning entity's resources/ tree; symlink escapes are rejected.`,
    };
  }

  // The trait describes local resource *files*; reject directories, sockets,
  // FIFOs, and other non-regular entries here so callers (static export,
  // hashing, preview, API) get the same actionable rejection instead of an
  // unstructured EISDIR/EBADF deeper in the pipeline.
  let candidateStat;
  try {
    candidateStat = await fs.stat(realCandidate);
  } catch {
    return {
      ok: false,
      kind: "missing",
      error: `Resource file "${relativePath}" does not exist under the owning entity's resources/ directory.`,
    };
  }
  if (!candidateStat.isFile()) {
    return {
      ok: false,
      kind: "not_a_regular_file",
      error: `Resource path "${relativePath}" does not point to a regular file under the owning entity's resources/ directory; resources must be files, not directories or other non-regular entries.`,
    };
  }

  return { ok: true, value: { absolutePath: realCandidate, relativePath } };
}

/**
 * Validate that a resource mutation (write or delete) against
 * `<ownerResourcesDir>/<relativePath>` stays inside the owning entity's
 * resources tree even when intermediate directories or the destination
 * leaf already exist as symlinks.
 *
 * The textual `validateResourceRelativePath` check stops authoring-time
 * traversal (`../escape`, absolute paths, backslashes) but does not catch
 * a *pre-existing* symlink on disk: if the user — or a hostile manifest —
 * created `<ownerResourcesDir>/sub` as a symlink to an outside tree, a
 * plain `path.join(ownerResourcesDir, "sub/leak.txt")` followed by
 * `fs.copyFile` / `fs.rm` will silently escape the entity tree. This
 * helper walks the textual chain segment-by-segment with `lstat` and
 * rejects the request the moment any existing component is a symlink:
 *
 *   1. The resources directory itself, if it exists, must not be a
 *      symlink (rejecting symlinked roots that would re-route every
 *      declared path at once).
 *   2. Each intermediate directory along the relative chain, if it
 *      exists, must not be a symlink (rejecting partial-tree symlinks
 *      like `resources/sub → /outside`).
 *   3. The destination leaf, if it exists, must not be a symlink and
 *      must be a regular file (rejecting symlinked manifest entries that
 *      would delete arbitrary files under `fs.rm`).
 *
 * Missing components are tolerated — the caller will create them with
 * `fs.mkdir`, which is safe under the existing-symlink-free chain that
 * this helper has just verified. The textual path validation is
 * re-applied so callers may pass either the raw user input or a
 * previously-validated path.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function assertSafeResourceMutationPath(options: {
  ownerResourcesDir: string;
  relativePath: string;
}): Promise<ResourceValidationResult<{ absolutePath: string }>> {
  const pathValidation = validateResourceRelativePath(options.relativePath);
  if (!pathValidation.ok) return pathValidation;
  const relativePath = pathValidation.value;

  try {
    const rootStat = await fs.lstat(options.ownerResourcesDir);
    if (rootStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be mutated: the owning entity's resources/ directory is itself a symlink, which is rejected so all writes stay inside the entity tree.`,
      };
    }
    if (!rootStat.isDirectory()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be mutated: the owning entity's resources/ path exists but is not a directory.`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be mutated: failed to inspect the owning entity's resources/ directory: ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
    // ENOENT is fine — the caller will mkdir the root and the rest of
    // the chain. There can be no symlinked intermediates beneath a
    // not-yet-created root.
  }

  const segments = relativePath.split("/").filter((seg) => seg.length > 0);
  let probe = options.ownerResourcesDir;
  for (let i = 0; i < segments.length; i++) {
    probe = path.join(probe, segments[i]);
    const isLast = i === segments.length - 1;
    let segStat;
    try {
      segStat = await fs.lstat(probe);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Remaining chain does not exist yet. Anything mkdir creates
        // here is a fresh non-symlink directory, so containment is
        // guaranteed for the rest of the walk.
        break;
      }
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be mutated: failed to inspect intermediate "${segments.slice(0, i + 1).join("/")}": ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
    if (segStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" resolves through a symlink at "${segments.slice(0, i + 1).join("/")}"; symlink escapes are rejected so all mutations stay inside the entity tree.`,
      };
    }
    if (!isLast && !segStat.isDirectory()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be mutated: intermediate "${segments.slice(0, i + 1).join("/")}" exists but is not a directory.`,
      };
    }
    if (isLast && !segStat.isFile()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be mutated: destination exists but is not a regular file.`,
      };
    }
  }

  return { ok: true, value: { absolutePath: path.join(options.ownerResourcesDir, relativePath) } };
}

/**
 * Resolve a `./resources/<relative-path>` reference against an owning
 * entity directory by first loading the entity's `resources.yaml`
 * manifest from disk, then delegating to `resolveResourcePath`.
 *
 * This is the trait-compliant entry point for callers that do not
 * already have a parsed manifest in memory (CLI commands, API handlers,
 * static-export drivers). The two-step structure ensures every
 * resolution path is gated by the declared manifest — there is no way to
 * resolve an undeclared file via this helper, satisfying
 * `ac-resource-reference-resolves-within-owner` and `ac-path-escape-rejected`.
 *
 * The required `ctx` argument lets the resolver enforce the entity-storage
 * compatibility gate before touching the resources tree: entity-scoped
 * resources only exist under folder-backed entity layouts, so legacy
 * (kynetic < 1.2) projects and 1.2 projects missing the
 * `resource_storage.format: entity_scoped` declaration must surface a
 * structured `entity_storage_incompatible` error here rather than appearing
 * to "work" for callers that do not own a separate manifest probe. Daemon
 * routes that expose this resolver thread the same error through their
 * `entityStorageIncompatibilityResponse` mapping to produce the 409 contract.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 */
export async function resolveResourceReference(options: {
  ctx: KspecContext;
  ownerEntityDir: string;
  relativePath: string;
}): Promise<ResourceResolutionResult<ResolvedResourceLocation>> {
  await requireResourceFolderStorage(options.ctx);
  const manifest = await loadResourceManifest(options.ownerEntityDir);
  return resolveResourcePath({
    ownerResourcesDir: getResourcesDir(options.ownerEntityDir),
    relativePath: options.relativePath,
    manifest,
  });
}

// ── Content-Type Validation / Inference ──────────────────────────────────────

/**
 * Validate that a string is a well-formed `type/subtype` MIME-ish token with
 * no whitespace. Returns the input verbatim on success.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export function validateContentType(input: string): ResourceValidationResult<string> {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: "content_type must be a non-empty string." };
  }
  if (!CONTENT_TYPE_PATTERN.test(input)) {
    return {
      ok: false,
      error: `content_type "${input}" must be of the form "type/subtype" with no whitespace and no extra slashes.`,
    };
  }
  return { ok: true, value: input };
}

/**
 * Infer a content type from a path's final extension. Returns
 * `application/octet-stream` for unknown or extension-less paths.
 *
 * Extension lookup is case-insensitive. Returns `application/octet-stream`
 * exactly when no built-in mapping matches.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export function inferContentType(filePath: string): string {
  const ext = path.posix.extname(filePath.replaceAll("\\", "/")).toLowerCase();
  if (!ext) return DEFAULT_CONTENT_TYPE;
  return EXTENSION_TO_CONTENT_TYPE.get(ext) ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Resolve a final content type for a resource: when explicit input is
 * supplied, validate and use it verbatim; otherwise infer from the path's
 * extension. The field is never null on the resulting metadata.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export function resolveContentType(
  input: string | undefined | null,
  filePath: string,
): ResourceValidationResult<string> {
  if (input !== undefined && input !== null) {
    return validateContentType(input);
  }
  return { ok: true, value: inferContentType(filePath) };
}

// ── Hash / Size ─────────────────────────────────────────────────────────────

/**
 * Hash a file with SHA-256, streaming so binary or large files never load
 * fully into memory. Returns both the byte size and the lowercase hex hash.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export async function hashResourceFile(
  absolutePath: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
      bytes += buf.length;
      hash.update(buf);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { bytes, sha256: hash.digest("hex") };
}

// ── Git-Backed Version Identity ──────────────────────────────────────────────

/**
 * Capture git-backed version identity for a resource file when the project
 * is stored in git: returns the HEAD commit and the repository-relative
 * path to the file ONLY when that exact (commit, path) pair can resolve the
 * file's current content. The recorded identity must be authoritative —
 * consumers will use it for drift detection and later resolution, so any
 * mismatch between HEAD and the working tree (untracked, staged-but-not-
 * committed, modified, deleted) yields `{ git_commit: null, git_path: null }`
 * instead of a misleading commit/path pair.
 *
 * Verification uses two git-plumbing checks against the path:
 *   1. `git ls-tree HEAD -- <relPath>` must return a blob entry, proving
 *      the path exists in the HEAD tree.
 *   2. `git diff --quiet HEAD -- <relPath>` must exit zero, proving the
 *      working-tree content matches HEAD (no staged/unstaged drift).
 *
 * Both must pass for the (commit, path) pair to be returned; otherwise the
 * fields are null. Callers persist the nullable result without keeping a
 * separate per-resource history log.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
 */
export function captureResourceGitVersion(absolutePath: string): {
  git_commit: string | null;
  git_path: string | null;
} {
  const fileDir = path.dirname(absolutePath);
  const topLevel = runGit(fileDir, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return { git_commit: null, git_path: null };

  const head = runGit(fileDir, ["rev-parse", "HEAD"]);
  if (!head) return { git_commit: null, git_path: null };

  let relPath = path.relative(topLevel, absolutePath);
  if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return { git_commit: null, git_path: null };
  }
  // Normalize to POSIX separators for cross-platform stability.
  relPath = relPath.split(path.sep).join("/");

  // The path must exist as a blob in the HEAD tree.
  const headEntry = runGit(topLevel, ["ls-tree", "HEAD", "--", relPath]);
  if (!headEntry || !/^\d+\s+blob\s+[0-9a-f]{40,64}\b/.test(headEntry)) {
    return { git_commit: null, git_path: null };
  }

  // The working-tree content must match HEAD's blob at that path. Any
  // staged-only change, unstaged modification, or deletion fails this
  // check and disqualifies the (commit, path) pair.
  const diffStatus = runGitExit(topLevel, ["diff", "--quiet", "HEAD", "--", relPath]);
  if (diffStatus !== 0) return { git_commit: null, git_path: null };

  return { git_commit: head, git_path: relPath };
}

function runGit(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return null;
  const stdout = (result.stdout ?? "").trim();
  return stdout || null;
}

function runGitExit(cwd: string, args: string[]): number | null {
  const result = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result.error) return null;
  return result.status;
}

// ── Compose Metadata From a File ─────────────────────────────────────────────

export interface ComputeResourceMetadataOptions {
  id: string;
  relativePath: string;
  absolutePath: string;
  contentType?: string | null;
  label?: string | null;
  description?: string | null;
  /**
   * When `false`, skip git metadata capture (useful in tests that run in
   * non-repo temp dirs but still want deterministic metadata). Defaults to
   * `true`.
   */
  captureGit?: boolean;
}

/**
 * Compute a complete `ResourceMetadata` record from a file on disk.
 * Validates the id, relative path, and content type; computes byte size
 * and SHA-256; optionally captures git version identity.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
 */
export async function computeResourceMetadata(
  options: ComputeResourceMetadataOptions,
): Promise<ResourceValidationResult<ResourceMetadata>> {
  const idValidation = validateResourceId(options.id);
  if (!idValidation.ok) return idValidation;

  const pathValidation = validateResourceRelativePath(options.relativePath);
  if (!pathValidation.ok) return pathValidation;

  const contentTypeResolved = resolveContentType(options.contentType, options.relativePath);
  if (!contentTypeResolved.ok) return contentTypeResolved;

  let hash: { bytes: number; sha256: string };
  try {
    hash = await hashResourceFile(options.absolutePath);
  } catch {
    return {
      ok: false,
      error: `Resource file at "${options.absolutePath}" could not be read while computing metadata; ensure the file exists under the owning entity's resources/ directory.`,
    };
  }

  const gitVersion =
    options.captureGit === false
      ? { git_commit: null, git_path: null }
      : captureResourceGitVersion(options.absolutePath);

  return {
    ok: true,
    value: {
      id: idValidation.value,
      label: options.label ?? null,
      path: pathValidation.value,
      content_type: contentTypeResolved.value,
      bytes: hash.bytes,
      sha256: hash.sha256,
      git_commit: gitVersion.git_commit,
      git_path: gitVersion.git_path,
      description: options.description ?? null,
    },
  };
}

// ── Manifest IO ──────────────────────────────────────────────────────────────

/**
 * Load and validate an entity's resource manifest.
 *
 * Distinguishes "missing manifest" from "corrupt manifest":
 *   - Missing file (ENOENT) → returns an empty manifest so callers may
 *     pre-create resources without first writing an empty file.
 *   - Any other read error or YAML parse failure → surfaces as a thrown
 *     error annotated with the manifest path so corrupt manifests cannot
 *     masquerade as "no resources declared."
 *
 * Schema validation failures from `ResourceManifestSchema.parse` propagate
 * normally as `ZodError` so callers can map them to API/CLI diagnostics.
 */
export async function loadResourceManifest(ownerEntityDir: string): Promise<ResourceManifest> {
  const manifestPath = getResourcesManifestPath(ownerEntityDir);
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(manifestPath);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { resources: [] };
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load resource manifest at "${manifestPath}": ${reason}. Fix or remove the manifest before resolving resources.`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
  if (raw === null || raw === undefined) {
    return { resources: [] };
  }
  return ResourceManifestSchema.parse(raw);
}

/**
 * Persist a validated resource manifest for an owning entity.
 */
export async function writeResourceManifest(
  ownerEntityDir: string,
  manifest: ResourceManifest,
): Promise<void> {
  const parsed = ResourceManifestSchema.parse(manifest);
  await writeYamlFile(getResourcesManifestPath(ownerEntityDir), parsed);
}

/**
 * Remove an owning entity's resource sidecar state — the `resources/`
 * subtree and the `resources.yaml` manifest — as a single logical mutation
 * for the entity's delete flow.
 *
 * The trait's storage layout puts both artifacts inside the owning entity
 * directory (`<entityDir>/resources/` and `<entityDir>/resources.yaml`), so
 * a concrete entity manager that recursively removes the entity directory
 * already cascades the delete to its resources. This helper is the
 * surface-level primitive for managers that want to:
 *   - prune resource state without removing the parent entity (e.g. a
 *     "drop all attachments" operation),
 *   - prove deletion follows the entity record in tests, or
 *   - share one tested cleanup path across every entity type that adopts
 *     the trait.
 *
 * Behavior:
 *   - Missing artifacts are tolerated (idempotent — safe to call twice).
 *   - The manifest is removed before the directory, mirroring the order
 *     in which the manifest declares what the directory holds.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
 */
export async function removeOwnerResources(ownerEntityDir: string): Promise<void> {
  const manifestPath = getResourcesManifestPath(ownerEntityDir);
  const resourcesDir = getResourcesDir(ownerEntityDir);
  await fs.rm(manifestPath, { force: true });
  await fs.rm(resourcesDir, { recursive: true, force: true });
}

// ── Bounded Preview ──────────────────────────────────────────────────────────

export interface ResourcePreview {
  /** Whether the resource is treated as text for preview purposes. */
  text: boolean;
  /**
   * Bounded text preview — UTF-8, truncated at `RESOURCE_PREVIEW_MAX_BYTES`.
   * `null` for binary or oversized-binary resources that have no inline
   * preview.
   */
  preview: string | null;
  /** Whether the preview was truncated relative to the resource bytes. */
  truncated: boolean;
}

/**
 * Heuristic: treat the resource as text iff its content type begins with
 * `text/` or matches a known textual subtype (json, yaml, toml, xml,
 * javascript, svg+xml). Everything else (images, audio, video, archives,
 * pdf, octet-stream) is binary and gets no inline preview.
 */
function isTextualContentType(contentType: string): boolean {
  if (contentType.startsWith("text/")) return true;
  const subtype = contentType.slice(contentType.indexOf("/") + 1).toLowerCase();
  return (
    subtype === "json" ||
    subtype === "yaml" ||
    subtype === "x-yaml" ||
    subtype === "toml" ||
    subtype === "xml" ||
    subtype === "javascript" ||
    subtype === "svg+xml"
  );
}

/**
 * Produce a bounded inspection preview of a resource without loading binary
 * bytes into structured records. Text resources up to
 * `RESOURCE_PREVIEW_MAX_BYTES` are returned verbatim; longer text is
 * truncated with `truncated: true`; binary resources return
 * `{ text: false, preview: null, truncated: false }`.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export async function getResourcePreview(
  absolutePath: string,
  contentType: string,
  options: { maxBytes?: number } = {},
): Promise<ResourcePreview> {
  if (!isTextualContentType(contentType)) {
    return { text: false, preview: null, truncated: false };
  }
  const maxBytes = options.maxBytes ?? RESOURCE_PREVIEW_MAX_BYTES;
  const handle = await fs.open(absolutePath, "r");
  try {
    const stat = await handle.stat();
    const readSize = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    if (readSize > 0) {
      await handle.read(buffer, 0, readSize, 0);
    }
    const preview = buffer.toString("utf-8");
    return {
      text: true,
      preview,
      truncated: stat.size > readSize,
    };
  } finally {
    await handle.close();
  }
}

// ── Symlink-Safe Write ──────────────────────────────────────────────────────

/**
 * Copy a source file into an owning entity's resources tree at
 * `<ownerResourcesDir>/<relativePath>`, refusing to follow any symlink along
 * the destination path. Companion to the read-side {@link resolveResourcePath}
 * — both close the same symlink-escape gap, but on the write path.
 *
 * The plain `fs.copyFile(path.join(ownerResourcesDir, relativePath), ...)`
 * pattern is unsafe: if any ancestor of the destination (the owner
 * resources directory itself, or any intermediate folder) is a symlink,
 * `copyFile` follows it and writes outside the owning entity tree —
 * violating @trait-entity-scoped-local-resources-1 ac-path-escape-rejected.
 *
 * This helper instead:
 *   1. Verifies the owner resources directory either does not exist yet or
 *      is a real (non-symlink) directory.
 *   2. Walks every intermediate path segment beneath the owner and rejects
 *      any that exists as a symlink or non-directory.
 *   3. Rejects a pre-existing symlink at the destination itself.
 *   4. Creates the intermediate directories and copies the source bytes.
 *   5. Defense in depth: resolves the realpath of what was just written and
 *      verifies it is still contained inside the owner realpath. On failure
 *      the partial write is cleaned up so the caller never observes
 *      half-written escape state.
 *
 * Returns an `ok: false` result with an actionable error string on any
 * symlink rejection — callers (review-resource-manager etc.) map this onto
 * their structured error codes.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 */
export async function copySourceIntoOwnerResources(options: {
  ownerResourcesDir: string;
  relativePath: string;
  sourceAbsolutePath: string;
}): Promise<ResourceValidationResult<{ destAbsolute: string }>> {
  const { ownerResourcesDir, relativePath, sourceAbsolutePath } = options;

  // 1. Owner resources dir: must be either nonexistent or a real directory.
  try {
    const ownerStat = await fs.lstat(ownerResourcesDir);
    if (ownerStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be written: the owning entity's resources/ directory is itself a symlink; symlink escapes are rejected.`,
      };
    }
    if (!ownerStat.isDirectory()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be written: the owning entity's resources/ path exists but is not a directory.`,
      };
    }
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno !== "ENOENT") {
      return {
        ok: false,
        error: `Could not inspect resources directory "${ownerResourcesDir}": ${e instanceof Error ? e.message : String(e)}.`,
      };
    }
    // Nonexistent is fine — mkdir below creates the tree.
  }

  // 2. Walk every intermediate directory under the owner and reject any
  //    symlink or non-directory along the way.
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  let current = ownerResourcesDir;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]);
    let segmentStat;
    try {
      segmentStat = await fs.lstat(current);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") continue;
      return {
        ok: false,
        error: `Could not inspect intermediate path "${current}" while writing resource "${relativePath}": ${e instanceof Error ? e.message : String(e)}.`,
      };
    }
    if (segmentStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be written: an intermediate directory ("${segments[i]}") is a symlink; symlink escapes are rejected.`,
      };
    }
    if (!segmentStat.isDirectory()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be written: intermediate path component "${segments[i]}" exists but is not a directory.`,
      };
    }
  }

  // 3. Destination itself: must not be a pre-existing symlink.
  const destAbsolute = path.join(ownerResourcesDir, relativePath);
  try {
    const destStat = await fs.lstat(destAbsolute);
    if (destStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be written: the destination is an existing symlink; symlink escapes are rejected.`,
      };
    }
    if (!destStat.isFile()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be written: the destination exists but is not a regular file.`,
      };
    }
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno !== "ENOENT") {
      return {
        ok: false,
        error: `Could not inspect destination "${destAbsolute}": ${e instanceof Error ? e.message : String(e)}.`,
      };
    }
  }

  // 4. Safe to create intermediate directories and copy the source bytes.
  await fs.mkdir(path.dirname(destAbsolute), { recursive: true });
  await fs.copyFile(sourceAbsolutePath, destAbsolute);

  // 5. Defense in depth: the realpath of what we just wrote must still be
  //    inside the owner's realpath. If a race or unanticipated symlink
  //    redirected the write, clean up so no escape-state file is left
  //    behind.
  const realOwner = await fs.realpath(ownerResourcesDir);
  let realDest: string;
  try {
    realDest = await fs.realpath(destAbsolute);
  } catch (e) {
    return {
      ok: false,
      error: `Could not verify the realpath of written resource "${relativePath}": ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
  const containment = path.relative(realOwner, realDest);
  if (containment === "" || containment.startsWith("..") || path.isAbsolute(containment)) {
    // Best-effort cleanup of the escaped write — the structured rejection
    // below is returned either way, so an rm failure only leaves the file
    // for the operator to remove; it never converts the escape into success.
    await fs.rm(destAbsolute, { force: true }).catch(() => {});
    return {
      ok: false,
      error: `Resource path "${relativePath}" resolves outside the owning entity's resources/ tree after write; symlink escapes are rejected and the partial write was cleaned up.`,
    };
  }

  return { ok: true, value: { destAbsolute } };
}

// ── Symlink-Safe Remove ─────────────────────────────────────────────────────

/**
 * Remove a single resource file from an owning entity's resources tree at
 * `<ownerResourcesDir>/<relativePath>`, refusing to follow any symlink along
 * the destination path. Companion to {@link copySourceIntoOwnerResources} —
 * both close the same symlink-escape gap on the delete path.
 *
 * The plain `fs.rm(path.join(ownerResourcesDir, relativePath))` pattern is
 * unsafe: if any ancestor of the destination (the owner resources directory
 * itself, or any intermediate folder) is a symlink, `fs.rm` follows it and
 * removes a file *outside* the owning entity tree — violating
 * @trait-entity-scoped-local-resources-1 ac-path-escape-rejected.
 *
 * This helper instead:
 *   1. Validates the relative path textually (rejects traversal, absolute,
 *      and other forbidden shapes — same gate as the read/write paths).
 *   2. Verifies the owner resources directory is a real (non-symlink)
 *      directory. A missing directory is treated as "nothing to remove."
 *   3. Walks every intermediate path segment beneath the owner and rejects
 *      any that exists as a symlink or non-directory.
 *   4. Rejects a pre-existing symlink at the destination itself, so a
 *      symlinked file inside the resources tree cannot be used to unlink
 *      its outside target.
 *   5. Calls `fs.unlink` (which does NOT follow symlinks for the final
 *      path component) on the destination. Missing files are tolerated.
 *
 * Returns `{ ok: true, value: { removed } }` on success (`removed: false`
 * if the file was already absent, `true` if a real file was unlinked) or
 * `{ ok: false, error }` with an actionable message on any symlink
 * rejection.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
 */
export async function removeResourceFromOwnerResources(options: {
  ownerResourcesDir: string;
  relativePath: string;
}): Promise<ResourceValidationResult<{ removed: boolean }>> {
  const { ownerResourcesDir, relativePath } = options;

  const pathValidation = validateResourceRelativePath(relativePath);
  if (!pathValidation.ok) return pathValidation;

  // 1. Owner resources dir: missing → nothing to remove; symlink → reject;
  //    non-directory → reject.
  try {
    const ownerStat = await fs.lstat(ownerResourcesDir);
    if (ownerStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be removed: the owning entity's resources/ directory is itself a symlink; symlink escapes are rejected.`,
      };
    }
    if (!ownerStat.isDirectory()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be removed: the owning entity's resources/ path exists but is not a directory.`,
      };
    }
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { ok: true, value: { removed: false } };
    return {
      ok: false,
      error: `Could not inspect resources directory "${ownerResourcesDir}": ${e instanceof Error ? e.message : String(e)}.`,
    };
  }

  // 2. Walk intermediate directories. Any symlink or non-directory is a
  //    rejection; a missing intermediate means the file is already gone.
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  let current = ownerResourcesDir;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]);
    let segmentStat;
    try {
      segmentStat = await fs.lstat(current);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") return { ok: true, value: { removed: false } };
      return {
        ok: false,
        error: `Could not inspect intermediate path "${current}" while removing resource "${relativePath}": ${e instanceof Error ? e.message : String(e)}.`,
      };
    }
    if (segmentStat.isSymbolicLink()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be removed: an intermediate directory ("${segments[i]}") is a symlink; symlink escapes are rejected.`,
      };
    }
    if (!segmentStat.isDirectory()) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" cannot be removed: intermediate path component "${segments[i]}" exists but is not a directory.`,
      };
    }
  }

  // 3. Destination: lstat (does not follow symlinks). A pre-existing
  //    symlink at the destination is rejected so we never delete the
  //    symlink's outside target. A missing destination is tolerated.
  const destAbsolute = path.join(ownerResourcesDir, relativePath);
  let destStat;
  try {
    destStat = await fs.lstat(destAbsolute);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { ok: true, value: { removed: false } };
    return {
      ok: false,
      error: `Could not inspect destination "${destAbsolute}": ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
  if (destStat.isSymbolicLink()) {
    return {
      ok: false,
      error: `Resource path "${relativePath}" cannot be removed: the destination is a symlink; symlink escapes are rejected.`,
    };
  }
  if (!destStat.isFile()) {
    return {
      ok: false,
      error: `Resource path "${relativePath}" cannot be removed: the destination exists but is not a regular file.`,
    };
  }

  // 4. fs.unlink does not follow the final-path-segment symlink; combined
  //    with the lstat rejection above, the deletion is constrained to the
  //    owning entity's resources tree.
  try {
    await fs.unlink(destAbsolute);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { ok: true, value: { removed: false } };
    return {
      ok: false,
      error: `Could not remove resource file "${destAbsolute}": ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
  return { ok: true, value: { removed: true } };
}

// ── Static Export ────────────────────────────────────────────────────────────

export interface StaticExportResult {
  /**
   * The exported resource path, relative to `exportRoot` and using POSIX
   * separators: `assets/resources/<entity-type>/<entity-ulid>/<relative-path>`.
   */
  exportedPath: string;
  /** Absolute path the file was written to. */
  absoluteExportedPath: string;
  /** Bytes written. */
  bytes: number;
}

/**
 * Copy one resource file from an owning entity's resources tree into a
 * static-export layout at
 * `<exportRoot>/assets/resources/<entityType>/<entityUlid>/<relativePath>`,
 * creating intermediate directories as needed. Returns the exported path
 * for inclusion in exported metadata.
 *
 * The relative path is re-validated to defend against unsanitized input;
 * the source file is resolved with symlink safety before copying so static
 * exports cannot smuggle files from outside the resources tree even when
 * a malicious manifest points at a symlink.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function copyResourceForStaticExport(options: {
  ownerResourcesDir: string;
  relativePath: string;
  exportRoot: string;
  entityType: string;
  entityUlid: string;
  manifest: ResourceManifest;
}): Promise<ResourceValidationResult<StaticExportResult>> {
  const resolution = await resolveResourcePath({
    ownerResourcesDir: options.ownerResourcesDir,
    relativePath: options.relativePath,
    manifest: options.manifest,
  });
  if (!resolution.ok) {
    return { ok: false, error: resolution.error };
  }

  const exportedPath = path.posix.join(
    STATIC_EXPORT_RESOURCES_PREFIX,
    options.entityType,
    options.entityUlid,
    resolution.value.relativePath,
  );
  const absoluteExportedPath = path.join(options.exportRoot, exportedPath);
  await fs.mkdir(path.dirname(absoluteExportedPath), { recursive: true });
  await fs.copyFile(resolution.value.absolutePath, absoluteExportedPath);
  const stat = await fs.stat(absoluteExportedPath);

  return {
    ok: true,
    value: {
      exportedPath,
      absoluteExportedPath,
      bytes: stat.size,
    },
  };
}
