import { z } from "zod";

/**
 * Resource identifier pattern. Stable, slug-like.
 *
 * Format: `[a-z0-9][a-z0-9._-]{0,127}` — first character must be alphanumeric;
 * remaining characters allow `.`, `_`, `-` for ergonomic file-like ids.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export const RESOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export const ResourceIdSchema = z
  .string()
  .regex(
    RESOURCE_ID_PATTERN,
    "Resource id must match [a-z0-9][a-z0-9._-]{0,127} (lowercase, starts with letter or digit, dot/underscore/hyphen allowed)",
  );

/**
 * Content-type pattern: `type/subtype` with no whitespace and no
 * additional slashes. Tokens themselves may carry the usual MIME
 * characters (letters, digits, `.`, `-`, `+`, `_`).
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

export const ContentTypeSchema = z
  .string()
  .min(1, "content_type must be a non-empty string")
  .regex(
    CONTENT_TYPE_PATTERN,
    'content_type must be a "type/subtype" MIME token without whitespace',
  );

/**
 * Predicate validator for resource paths. Returns an actionable error
 * string when the path is unsafe, or `null` when it is a clean POSIX
 * relative path under an entity's `resources/` directory.
 *
 * Rejected shapes:
 *   - empty paths or non-strings,
 *   - absolute paths (`/`-prefixed),
 *   - paths ending in `/` (would point at a directory),
 *   - paths containing backslashes (Windows-style separator leak),
 *   - paths with `..` segments (parent traversal),
 *   - paths with literal `.` segments (always redundant),
 *   - paths with empty segments (`//`).
 *
 * Shared between the schema (which uses it to reject unsafe `path` values
 * at the resources.yaml boundary) and the runtime validator in
 * `src/parser/entity-local-resources.ts`.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export function checkResourceRelativePath(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) {
    return "Resource path must be a non-empty POSIX-relative path under the entity resources/ directory.";
  }
  if (input.startsWith("/")) {
    return `Resource path "${input}" uses an absolute path; resource references must be POSIX-relative to the entity's resources/ directory.`;
  }
  if (input.endsWith("/")) {
    return `Resource path "${input}" ends with "/"; it must point to a file inside the entity's resources/ directory.`;
  }
  if (input.includes("\\")) {
    return `Resource path "${input}" contains a backslash; use POSIX-style forward slashes only.`;
  }
  const segments = input.split("/");
  for (const segment of segments) {
    if (segment === "") {
      return `Resource path "${input}" contains an empty segment ("//"); use a single forward slash between path components.`;
    }
    if (segment === "..") {
      return `Resource path "${input}" contains a parent traversal segment (".."); resource references must stay within the entity's resources/ tree.`;
    }
    if (segment === ".") {
      return `Resource path "${input}" contains a "." segment; use a clean relative path without "./" components.`;
    }
  }
  return null;
}

/**
 * Schema for a resource's `path` field. Rejects absolute paths, parent
 * traversal, backslashes, and empty/redundant segments at the manifest
 * boundary so unsafe paths cannot reach list/detail/API/static-export
 * surfaces before the resolver gets a chance to inspect them.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
 */
export const ResourcePathSchema = z.string().superRefine((value, ctx) => {
  const error = checkResourceRelativePath(value);
  if (error !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error,
    });
  }
});

/**
 * SHA-256 hash pattern: 64 lowercase hex characters.
 */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const Sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, "sha256 must be 64 lowercase hex characters");

/**
 * Git commit pattern: 40 lowercase hex characters.
 */
export const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const GitCommitSchema = z
  .string()
  .regex(GIT_COMMIT_PATTERN, "git_commit must be a 40-character lowercase hex SHA");

/**
 * Resource metadata: one entry in an entity's `resources.yaml`.
 *
 * The exact shape is fixed for cross-entity compatibility — plans, reviews,
 * and any future folder-backed entity that adopts this trait must store and
 * read the same fields. Binary content lives in the sidecar file at `path`;
 * the metadata never inlines bytes.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 * AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
 */
export const ResourceMetadataSchema = z.object({
  id: ResourceIdSchema,
  label: z.string().nullable(),
  path: ResourcePathSchema,
  content_type: ContentTypeSchema,
  bytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  git_commit: GitCommitSchema.nullable(),
  git_path: z.string().nullable(),
  description: z.string().nullable(),
});

export type ResourceMetadata = z.infer<typeof ResourceMetadataSchema>;

/**
 * On-disk shape of `resources.yaml`: a single `resources` array of metadata
 * entries. Wrapper form (rather than a bare array) lets future extensions
 * add sibling keys without breaking back-compat readers.
 */
export const ResourceManifestSchema = z.object({
  resources: z.array(ResourceMetadataSchema).default([]),
});

export type ResourceManifest = z.infer<typeof ResourceManifestSchema>;

/**
 * Schema-known keys for `resources.yaml`. Used by entity managers that
 * preserve unknown sibling keys via `mergePreservingRawShape`.
 */
export const RESOURCE_MANIFEST_SCHEMA_KEYS: ReadonlySet<string> = new Set(
  Object.keys(ResourceManifestSchema.shape),
);

/**
 * Import-side `resources.yaml` sibling for `kspec plan import`. The plan
 * markdown file imports declared resource files from a sibling `resources/`
 * directory; this schema is what authors write by hand, with only the
 * required identifiers (id + path) and optional descriptive metadata. The
 * import command computes `bytes`, `sha256`, and git version identity from
 * the resolved source file before persisting the full `ResourceMetadata`.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
 */
export const PlanResourceImportEntrySchema = z.object({
  id: ResourceIdSchema,
  path: ResourcePathSchema,
  label: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  content_type: ContentTypeSchema.optional(),
});

export type PlanResourceImportEntry = z.infer<typeof PlanResourceImportEntrySchema>;

export const PlanResourceImportManifestSchema = z.object({
  resources: z.array(PlanResourceImportEntrySchema).default([]),
});

export type PlanResourceImportManifest = z.infer<typeof PlanResourceImportManifestSchema>;

/**
 * Owner kinds for `TaskResourceRef`. Plan-owned references point at the
 * source plan's manifest; task-owned references point at a copy under the
 * task's own `resources/` tree.
 */
export const ResourceOwnerTypeSchema = z.enum(["plan", "task"]);
export type ResourceOwnerType = z.infer<typeof ResourceOwnerTypeSchema>;

/**
 * Per-task resource reference. Recorded by `kspec plan derive` for each
 * `resource_refs` entry in a plan task definition. Stores enough identity
 * (owner type, owner ref, resource id, relative path) to resolve through
 * the owning entity, plus the content hash and git version identity
 * captured at derivation time so consumers can detect drift when the
 * underlying resource changes after derivation.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
 * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
 */
export const TaskResourceRefSchema = z.object({
  owner_type: ResourceOwnerTypeSchema,
  owner_ref: z.string().min(1),
  id: ResourceIdSchema,
  path: ResourcePathSchema,
  sha256: Sha256Schema,
  git_commit: GitCommitSchema.nullable(),
  git_path: z.string().nullable(),
  recorded_at: z.string().datetime(),
});

export type TaskResourceRef = z.infer<typeof TaskResourceRefSchema>;

/**
 * Stable CLI/API authoring prefix for plan resource references on plan
 * task definitions and markdown links.
 */
export const PLAN_RESOURCE_AUTHORING_PREFIX = "./resources/";
