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
  path: z.string().min(1, "path must be a non-empty relative path"),
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
