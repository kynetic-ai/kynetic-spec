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
} from "../schema/resources.js";
import { readYamlFile, writeYamlFile } from "./yaml.js";

export {
  CONTENT_TYPE_PATTERN,
  RESOURCE_ID_PATTERN,
  RESOURCE_MANIFEST_SCHEMA_KEYS,
  ResourceManifestSchema,
  ResourceMetadataSchema,
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
 * `resources/` directory. Rejects:
 *   - empty paths or paths ending in `/`,
 *   - absolute paths (`/`-prefixed),
 *   - paths containing backslashes (Windows-style separators leak),
 *   - paths with `..` or empty segments (traversal),
 *   - paths with literal `.` segments (always redundant; rejected for clarity).
 *
 * The validator is purely textual — it does not touch the filesystem. Pair
 * it with `resolveResourcePath` to enforce symlink-safe resolution.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export function validateResourceRelativePath(
  relativePath: string,
): ResourceValidationResult<string> {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return {
      ok: false,
      error:
        "Resource path must be a non-empty POSIX-relative path under the entity resources/ directory.",
    };
  }
  if (relativePath.startsWith("/")) {
    return {
      ok: false,
      error: `Resource path "${relativePath}" uses an absolute path; resource references must be POSIX-relative to the entity's resources/ directory.`,
    };
  }
  if (relativePath.endsWith("/")) {
    return {
      ok: false,
      error: `Resource path "${relativePath}" ends with "/"; it must point to a file inside the entity's resources/ directory.`,
    };
  }
  if (relativePath.includes("\\")) {
    return {
      ok: false,
      error: `Resource path "${relativePath}" contains a backslash; use POSIX-style forward slashes only.`,
    };
  }

  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "") {
      return {
        ok: false,
        error: `Resource path "${relativePath}" contains an empty segment ("//"); use a single forward slash between path components.`,
      };
    }
    if (segment === "..") {
      return {
        ok: false,
        error: `Resource path "${relativePath}" contains a parent traversal segment (".."); resource references must stay within the entity's resources/ tree.`,
      };
    }
    if (segment === ".") {
      return {
        ok: false,
        error: `Resource path "${relativePath}" contains a "." segment; use a clean relative path without "./" components.`,
      };
    }
  }

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
 * anything that escapes the tree via path traversal or symlink redirection.
 *
 * The resolver:
 *   1. validates the relative path textually,
 *   2. resolves the realpath of the owner resources root,
 *   3. resolves the realpath of the candidate file,
 *   4. requires the candidate realpath to be located *inside* the owner
 *      realpath. Anything outside is rejected with actionable guidance.
 *
 * If a `manifest` is supplied, the relative path must additionally appear
 * in the manifest's `resources[*].path` list — undeclared paths are
 * rejected even if they exist on disk inside the resources tree. This
 * satisfies the "no arbitrary filesystem reads" contract for API/static-
 * export/agent surfaces.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export async function resolveResourcePath(options: {
  ownerResourcesDir: string;
  relativePath: string;
  manifest?: ResourceManifest;
}): Promise<ResourceValidationResult<ResolvedResourceLocation>> {
  const pathValidation = validateResourceRelativePath(options.relativePath);
  if (!pathValidation.ok) return pathValidation;
  const relativePath = pathValidation.value;

  if (options.manifest) {
    const declared = options.manifest.resources.some((r) => r.path === relativePath);
    if (!declared) {
      return {
        ok: false,
        error: `Resource path "${relativePath}" is not declared in the owning entity's resources.yaml manifest. Add an entry with this path or use an existing declared path.`,
      };
    }
  }

  let realOwner: string;
  try {
    realOwner = await fs.realpath(options.ownerResourcesDir);
  } catch {
    return {
      ok: false,
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
      error: `Resource path "${relativePath}" resolves through a symlink that escapes the owning entity's resources/ tree; symlink escapes are rejected.`,
    };
  }

  return { ok: true, value: { absolutePath: realCandidate, relativePath } };
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
 * path to the file. Returns `{ git_commit: null, git_path: null }` when git
 * metadata is unavailable (no repo, file not tracked, etc.) — callers store
 * the resulting nullable fields without recording a separate per-resource
 * history log.
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
 * Load and validate an entity's resource manifest. Returns an empty manifest
 * when the file is missing — callers may pre-create resources without first
 * writing an empty manifest.
 */
export async function loadResourceManifest(ownerEntityDir: string): Promise<ResourceManifest> {
  const manifestPath = getResourcesManifestPath(ownerEntityDir);
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(manifestPath);
  } catch {
    return { resources: [] };
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
  manifest?: ResourceManifest;
}): Promise<ResourceValidationResult<StaticExportResult>> {
  const resolution = await resolveResourcePath({
    ownerResourcesDir: options.ownerResourcesDir,
    relativePath: options.relativePath,
    manifest: options.manifest,
  });
  if (!resolution.ok) return resolution;

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
