/**
 * Tests for the shared entity-scoped local-resources trait foundation.
 *
 * These tests verify the trait foundation against a fixture "widget" entity
 * that is NOT one of the production entity types (plans, reviews) that will
 * later adopt the trait. Exercising the foundation through a fixture proves
 * the abstraction is general — it must not contain plan- or review-specific
 * assumptions.
 *
 * Spec: @trait-entity-scoped-local-resources-1
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_TYPE_PATTERN,
  DEFAULT_CONTENT_TYPE,
  RESOURCE_AUTHORING_PREFIX,
  RESOURCES_DIR_NAME,
  RESOURCES_MANIFEST_FILENAME,
  RESOURCE_ID_PATTERN,
  RESOURCE_PREVIEW_MAX_BYTES,
  STATIC_EXPORT_RESOURCES_PREFIX,
  ResourceManifestSchema,
  ResourceMetadataSchema,
  captureResourceGitVersion,
  computeResourceMetadata,
  copyResourceForStaticExport,
  formatResourceReference,
  getResourcePreview,
  getResourcesDir,
  getResourcesManifestPath,
  getStaticExportResourcePath,
  hashResourceFile,
  inferContentType,
  loadResourceManifest,
  parseResourceReference,
  resolveContentType,
  resolveResourcePath,
  validateContentType,
  validateResourceId,
  validateResourceRelativePath,
  writeResourceManifest,
  type ResourceManifest,
  type ResourceMetadata,
} from "../src/parser/entity-local-resources.js";
import { readYamlFile } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir, readTestOutput, testUlid } from "./helpers/cli.js";

// ── Fixture Entity Type ──────────────────────────────────────────────────────

/**
 * "Widget" — minimal fixture entity used only by these tests. The trait
 * foundation must work for any folder-backed entity with a `resources/`
 * directory beside its core record.
 */
interface WidgetLayout {
  entityType: "widget";
  storageRoot: string;
}

const WIDGET_LAYOUT: WidgetLayout = {
  entityType: "widget",
  storageRoot: "widgets",
};

interface WidgetWithResources {
  ulid: string;
  entityDir: string;
  resourcesDir: string;
}

async function createWidget(
  specDir: string,
  ulid: string = testUlid("WGT"),
): Promise<WidgetWithResources> {
  const entityDir = path.join(specDir, WIDGET_LAYOUT.storageRoot, ulid);
  const resourcesDir = path.join(entityDir, RESOURCES_DIR_NAME);
  await fs.mkdir(resourcesDir, { recursive: true });
  return { ulid, entityDir, resourcesDir };
}

async function writeResourceFile(
  resourcesDir: string,
  relativePath: string,
  contents: Buffer | string,
): Promise<string> {
  const abs = path.join(resourcesDir, relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
  return abs;
}

// Some CIs run from inside a checkout; tests should not depend on whichever
// git repo happens to surround the temp dir, so we point captureGit at a
// non-repo location for deterministic git-null assertions.
async function nonGitTempBase(): Promise<string> {
  const base = await fs.realpath(os.tmpdir());
  return base;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("entity-scoped local-resources trait foundation", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-entity-local-resources-");
    specDir = path.join(tempDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ── Constants & Patterns ─────────────────────────────────────────────────

  describe("constants and patterns", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("exposes the exact resource id pattern from the spec", () => {
      expect(RESOURCE_ID_PATTERN.source).toBe("^[a-z0-9][a-z0-9._-]{0,127}$");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("enforces non-empty 'type/subtype' shape with no whitespace", () => {
      expect(CONTENT_TYPE_PATTERN.test("image/png")).toBe(true);
      expect(CONTENT_TYPE_PATTERN.test("application/vnd.ms-excel")).toBe(true);
      expect(CONTENT_TYPE_PATTERN.test("text/plain ")).toBe(false);
      expect(CONTENT_TYPE_PATTERN.test("text/ plain")).toBe(false);
      expect(CONTENT_TYPE_PATTERN.test("textplain")).toBe(false);
      expect(CONTENT_TYPE_PATTERN.test("text/plain/extra")).toBe(false);
      expect(CONTENT_TYPE_PATTERN.test("")).toBe(false);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("defaults unknown extensions to application/octet-stream", () => {
      expect(DEFAULT_CONTENT_TYPE).toBe("application/octet-stream");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
    it("uses the documented static-export prefix", () => {
      expect(STATIC_EXPORT_RESOURCES_PREFIX).toBe("assets/resources");
    });
  });

  // ── Path Helpers ─────────────────────────────────────────────────────────

  describe("path helpers", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("derives the resources directory under an owning entity", async () => {
      const widget = await createWidget(specDir);
      expect(getResourcesDir(widget.entityDir)).toBe(path.join(widget.entityDir, "resources"));
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("derives the resource manifest path inside the entity directory", async () => {
      const widget = await createWidget(specDir);
      expect(getResourcesManifestPath(widget.entityDir)).toBe(
        path.join(widget.entityDir, "resources.yaml"),
      );
      expect(RESOURCES_MANIFEST_FILENAME).toBe("resources.yaml");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
    it("derives static-export paths as assets/resources/<type>/<ulid>/<relative-path>", () => {
      const exportRoot = "/tmp/export";
      const ulid = testUlid("WGT");
      expect(getStaticExportResourcePath(exportRoot, "widget", ulid, "diagrams/flow.svg")).toBe(
        path.posix.join(exportRoot, "assets/resources/widget", ulid, "diagrams/flow.svg"),
      );
    });
  });

  // ── Resource Id Validation ───────────────────────────────────────────────

  describe("validateResourceId", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("accepts ids matching [a-z0-9][a-z0-9._-]{0,127}", () => {
      const cases = ["a", "1", "screenshot-1", "diagram.flow.v2", "weights_03", "x".repeat(128)];
      for (const id of cases) {
        const result = validateResourceId(id);
        expect(result.ok, `id "${id}" expected to validate`).toBe(true);
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("rejects uppercase, leading-punctuation, empty, and over-length ids", () => {
      const cases = ["", "A", "ABC", "-leading-hyphen", ".dot", "_underscore", "x".repeat(129)];
      for (const id of cases) {
        const result = validateResourceId(id);
        expect(result.ok, `id "${id}" expected to fail`).toBe(false);
      }
    });
  });

  // ── Relative Path Validation ─────────────────────────────────────────────

  describe("validateResourceRelativePath", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("accepts simple and nested POSIX relative paths", () => {
      for (const p of ["a.png", "diagrams/flow.svg", "logs/2026/05/run.log"]) {
        expect(validateResourceRelativePath(p).ok).toBe(true);
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects empty path with actionable guidance", () => {
      const result = validateResourceRelativePath("");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/non-empty/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects absolute paths with guidance to use POSIX-relative", () => {
      const result = validateResourceRelativePath("/etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/absolute path/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects parent-traversal segments anywhere in the path", () => {
      for (const p of ["..", "../x", "a/../b", "logs/../../escape", "a/..", "..//x"]) {
        const result = validateResourceRelativePath(p);
        expect(result.ok, `path "${p}" expected to fail`).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/\.\.|empty segment|absolute|forward/i);
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects backslash-separated paths", () => {
      const result = validateResourceRelativePath("a\\b\\c.png");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/backslash/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects redundant '.' segments", () => {
      const result = validateResourceRelativePath("./a.png");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/\.\s|"\." segment|clean/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects paths that end in /", () => {
      const result = validateResourceRelativePath("a/");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/end|directory/i);
    });
  });

  // ── Reference Parsing ────────────────────────────────────────────────────

  describe("parseResourceReference", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("accepts ./resources/<relative> form and extracts the relative path", () => {
      const result = parseResourceReference("./resources/diagrams/flow.svg");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.relativePath).toBe("diagrams/flow.svg");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("rejects references missing the ./resources/ prefix", () => {
      for (const ref of [
        "resources/x.png", // missing ./ prefix
        "diagrams/flow.svg", // bare relative
        "/abs/path.png", // absolute
        "./other/path.png", // wrong subdirectory
        "../escape.png", // parent traversal at root
        "./resources", // missing trailing path
      ]) {
        const result = parseResourceReference(ref);
        expect(result.ok, `reference "${ref}" should be rejected`).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/resource reference|\.\/resources\//i);
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("propagates relative-path validation errors for ./resources/.. style escapes", () => {
      const result = parseResourceReference("./resources/../etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/parent traversal|\.\./i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("formatResourceReference round-trips with parseResourceReference", () => {
      const rel = "logs/run.log";
      const ref = formatResourceReference(rel);
      expect(ref).toBe(`${RESOURCE_AUTHORING_PREFIX}${rel}`);
      const parsed = parseResourceReference(ref);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.relativePath).toBe(rel);
    });
  });

  // ── Resolver (symlink-safe) ──────────────────────────────────────────────

  describe("resolveResourcePath", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("resolves a declared file to its real absolute path inside the resources tree", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "diagrams/flow.svg", "<svg/>");
      const realAbs = await fs.realpath(abs);

      const result = await resolveResourcePath({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "diagrams/flow.svg",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.absolutePath).toBe(realAbs);
        expect(result.value.relativePath).toBe("diagrams/flow.svg");
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects parent-traversal relative paths before touching the filesystem", async () => {
      const widget = await createWidget(specDir);
      // Place a sibling file to ensure rejection is not just "file missing"
      const sibling = path.join(widget.entityDir, "..", "secret.txt");
      await fs.writeFile(sibling, "secret");

      const result = await resolveResourcePath({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "../secret.txt",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/parent traversal|\.\./i);

      // Sibling file is not deleted by the rejection.
      await expect(fs.stat(sibling)).resolves.toBeDefined();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects absolute paths even when the file exists at that absolute location", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "real.txt", "real");

      const result = await resolveResourcePath({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: abs, // absolute on purpose
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/absolute path/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("rejects paths not declared in the manifest when a manifest is supplied", async () => {
      const widget = await createWidget(specDir);
      await writeResourceFile(widget.resourcesDir, "screenshot.png", "PNGDATA");
      await writeResourceFile(widget.resourcesDir, "extra.png", "EXTRA");

      const manifest: ResourceManifest = {
        resources: [
          {
            id: "screenshot",
            label: null,
            path: "screenshot.png",
            content_type: "image/png",
            bytes: 7,
            sha256: "f".repeat(64),
            git_commit: null,
            git_path: null,
            description: null,
          },
        ],
      };

      const undeclared = await resolveResourcePath({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "extra.png",
        manifest,
      });
      expect(undeclared.ok).toBe(false);
      if (!undeclared.ok) expect(undeclared.error).toMatch(/not declared|resources\.yaml/i);

      const declared = await resolveResourcePath({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "screenshot.png",
        manifest,
      });
      expect(declared.ok).toBe(true);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects resolution when the resources/ directory itself is a symlink to outside the entity tree", async () => {
      const ulid = testUlid("WGT");
      const entityDir = path.join(specDir, WIDGET_LAYOUT.storageRoot, ulid);
      await fs.mkdir(entityDir, { recursive: true });

      // Outside dir contains a file matching what a malicious manifest would
      // declare. If the symlinked resources root were treated as the trust
      // root, this declared file would resolve "successfully" outside the
      // entity tree.
      const outsideDir = path.join(tempDir, "outside-resources");
      await fs.mkdir(outsideDir, { recursive: true });
      const escapedSecret = path.join(outsideDir, "secret.txt");
      await fs.writeFile(escapedSecret, "secret content");

      // Make <entity>/resources itself a symlink to the outside directory.
      const resourcesDir = path.join(entityDir, RESOURCES_DIR_NAME);
      try {
        await fs.symlink(outsideDir, resourcesDir);
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === "EPERM" || errno === "ENOSYS") return;
        throw err;
      }

      const manifest: ResourceManifest = {
        resources: [
          {
            id: "secret",
            label: null,
            path: "secret.txt",
            content_type: "text/plain",
            bytes: 14,
            sha256: "0".repeat(64),
            git_commit: null,
            git_path: null,
            description: null,
          },
        ],
      };

      const result = await resolveResourcePath({
        ownerResourcesDir: resourcesDir,
        relativePath: "secret.txt",
        manifest,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/symlink|escape|not a directory/i);
      }

      // No path is leaked through the static-export helper either.
      const exportRoot = path.join(tempDir, "export-out");
      const exportResult = await copyResourceForStaticExport({
        ownerResourcesDir: resourcesDir,
        relativePath: "secret.txt",
        exportRoot,
        entityType: WIDGET_LAYOUT.entityType,
        entityUlid: ulid,
        manifest,
      });
      expect(exportResult.ok).toBe(false);

      // The outside file must remain untouched.
      await expect(fs.readFile(escapedSecret, "utf-8")).resolves.toBe("secret content");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects resolution through a symlink that escapes the resources tree", async () => {
      const widget = await createWidget(specDir);
      // Place the secret outside the entity directory entirely.
      const secretDir = path.join(tempDir, "outside");
      await fs.mkdir(secretDir, { recursive: true });
      const secretPath = path.join(secretDir, "secret.txt");
      await fs.writeFile(secretPath, "secret");

      // Create a symlink inside the resources tree pointing at the outside file.
      const linkPath = path.join(widget.resourcesDir, "leak.txt");
      try {
        await fs.symlink(secretPath, linkPath);
      } catch (err) {
        // Some filesystems (notably Windows without admin) can't create symlinks.
        // Skip the test silently when the OS doesn't support it.
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === "EPERM" || errno === "ENOSYS") return;
        throw err;
      }

      const result = await resolveResourcePath({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "leak.txt",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/symlink|escape/i);

      // Secret file outside the tree is not touched.
      await expect(fs.readFile(secretPath, "utf-8")).resolves.toBe("secret");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("returns missing-resource guidance when the file does not exist", async () => {
      const widget = await createWidget(specDir);
      const result = await resolveResourcePath({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "ghost.png",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/does not exist|under the owning entity's resources/i);
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
    it("returns guidance when the owning entity has no resources directory yet", async () => {
      const ulid = testUlid("WGT");
      const entityDir = path.join(specDir, WIDGET_LAYOUT.storageRoot, ulid);
      const resourcesDir = path.join(entityDir, RESOURCES_DIR_NAME);
      // Do NOT create the resourcesDir. The entity directory exists but the
      // resources/ subdirectory has not been created.
      await fs.mkdir(entityDir, { recursive: true });

      const result = await resolveResourcePath({
        ownerResourcesDir: resourcesDir,
        relativePath: "anything.png",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/no resources directory|resources\.yaml/i);
    });
  });

  // ── Content Type Validation / Inference ──────────────────────────────────

  describe("content type validation and inference", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("validates type/subtype shape", () => {
      expect(validateContentType("image/png").ok).toBe(true);
      expect(validateContentType("application/vnd.ms-excel").ok).toBe(true);
      const bad = validateContentType("text plain");
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toMatch(/type\/subtype/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("rejects empty content_type input", () => {
      const result = validateContentType("");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/non-empty/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("infers common image and text MIME types from extension", () => {
      expect(inferContentType("screenshot.png")).toBe("image/png");
      expect(inferContentType("Photo.JPG")).toBe("image/jpeg");
      expect(inferContentType("logs/run.log")).toBe("text/plain");
      expect(inferContentType("readme.md")).toBe("text/markdown");
      expect(inferContentType("config.yaml")).toBe("application/yaml");
      expect(inferContentType("config.YML")).toBe("application/yaml");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("falls back to application/octet-stream for unknown or extension-less paths", () => {
      expect(inferContentType("unknown.xyz")).toBe(DEFAULT_CONTENT_TYPE);
      expect(inferContentType("no-extension")).toBe(DEFAULT_CONTENT_TYPE);
      expect(inferContentType(".dotfile")).toBe(DEFAULT_CONTENT_TYPE);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("resolveContentType prefers explicit input over inference", () => {
      const explicit = resolveContentType("application/vnd.acme+json", "screenshot.png");
      expect(explicit.ok).toBe(true);
      if (explicit.ok) expect(explicit.value).toBe("application/vnd.acme+json");

      const inferred = resolveContentType(undefined, "screenshot.png");
      expect(inferred.ok).toBe(true);
      if (inferred.ok) expect(inferred.value).toBe("image/png");

      const inferredFromNull = resolveContentType(null, "data.bin");
      expect(inferredFromNull.ok).toBe(true);
      if (inferredFromNull.ok) expect(inferredFromNull.value).toBe(DEFAULT_CONTENT_TYPE);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("resolveContentType rejects invalid explicit input rather than silently inferring", () => {
      const result = resolveContentType("not a mime", "screenshot.png");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/type\/subtype/i);
    });
  });

  // ── Hash / Metadata Computation ──────────────────────────────────────────

  describe("hashResourceFile and computeResourceMetadata", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("hashes file contents with SHA-256 and reports exact byte size", async () => {
      const widget = await createWidget(specDir);
      const contents = Buffer.from("hello world", "utf-8");
      const abs = await writeResourceFile(widget.resourcesDir, "hello.txt", contents);

      const { bytes, sha256 } = await hashResourceFile(abs);
      expect(bytes).toBe(contents.length);
      // sha256("hello world") well-known hash:
      expect(sha256).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
    it("streams large binary content without inlining into memory representations", async () => {
      const widget = await createWidget(specDir);
      // 1 MiB of pseudo-random binary content.
      const big = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
      const abs = await writeResourceFile(widget.resourcesDir, "blob.bin", big);

      const { bytes, sha256 } = await hashResourceFile(abs);
      expect(bytes).toBe(big.length);
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("composes a complete ResourceMetadata record with explicit content_type", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "report.csv", "a,b,c\n1,2,3\n");

      const result = await computeResourceMetadata({
        id: "report",
        relativePath: "report.csv",
        absolutePath: abs,
        contentType: "text/csv",
        label: "Q2 Report",
        description: "Quarterly figures",
        captureGit: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Validate against the Zod schema — the produced shape MUST round-trip.
      const parsed = ResourceMetadataSchema.parse(result.value);
      expect(parsed.id).toBe("report");
      expect(parsed.label).toBe("Q2 Report");
      expect(parsed.path).toBe("report.csv");
      expect(parsed.content_type).toBe("text/csv");
      expect(parsed.bytes).toBeGreaterThan(0);
      expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.description).toBe("Quarterly figures");
      expect(parsed.git_commit).toBeNull();
      expect(parsed.git_path).toBeNull();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("infers content_type from path extension when input is absent", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "shot.png", Buffer.from([0, 1, 2]));
      const result = await computeResourceMetadata({
        id: "shot",
        relativePath: "shot.png",
        absolutePath: abs,
        captureGit: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content_type).toBe("image/png");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("falls back to application/octet-stream when inference and input are both absent", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "data.unknown", "x");
      const result = await computeResourceMetadata({
        id: "data",
        relativePath: "data.unknown",
        absolutePath: abs,
        captureGit: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.content_type).toBe(DEFAULT_CONTENT_TYPE);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("rejects malformed content_type input rather than storing it", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "shot.png", Buffer.from([0, 1, 2]));
      const result = await computeResourceMetadata({
        id: "shot",
        relativePath: "shot.png",
        absolutePath: abs,
        contentType: "image png", // whitespace, no slash
        captureGit: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/type\/subtype/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("rejects invalid id with actionable guidance", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "shot.png", "x");
      const result = await computeResourceMetadata({
        id: "BadId", // uppercase
        relativePath: "shot.png",
        absolutePath: abs,
        captureGit: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/resource id/i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("rejects parent-traversal relative paths in computed metadata", async () => {
      const widget = await createWidget(specDir);
      const result = await computeResourceMetadata({
        id: "x",
        relativePath: "../outside.png",
        absolutePath: path.join(widget.resourcesDir, "any"),
        captureGit: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/parent traversal|\.\./i);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("returns missing-resource guidance when the underlying file cannot be read", async () => {
      const widget = await createWidget(specDir);
      const result = await computeResourceMetadata({
        id: "ghost",
        relativePath: "ghost.png",
        absolutePath: path.join(widget.resourcesDir, "ghost.png"),
        captureGit: false,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/could not be read|resources\//i);
    });
  });

  // ── Git Version Metadata ─────────────────────────────────────────────────

  describe("captureResourceGitVersion", () => {
    /**
     * Initialize a clean git repo at `repoDir` with a single committed
     * baseline file. Returns `null` if git is unavailable (some CIs run
     * without git), in which case callers should skip the assertion path.
     */
    async function initRepoWithBaseline(repoDir: string): Promise<string | null> {
      const inits = [
        ["init", "-q"],
        ["config", "user.email", "kspec-test@example.invalid"],
        ["config", "user.name", "kspec-test"],
        ["config", "commit.gpgsign", "false"],
      ];
      for (const args of inits) {
        const r = spawnSync("git", args, { cwd: repoDir, stdio: "ignore" });
        if (r.status !== 0) return null;
      }
      await fs.writeFile(path.join(repoDir, "README"), "baseline\n");
      const add = spawnSync("git", ["add", "README"], { cwd: repoDir, stdio: "ignore" });
      if (add.status !== 0) return null;
      const commit = spawnSync("git", ["commit", "-q", "-m", "init"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (commit.status !== 0) return null;
      const head = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf-8",
      });
      if (head.status !== 0) return null;
      return (head.stdout ?? "").trim();
    }

    // AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
    it("returns null commit and null path when the file is not in a git repo", async () => {
      const base = await nonGitTempBase();
      const outside = await fs.mkdtemp(path.join(base, "kspec-no-git-"));
      try {
        const abs = path.join(outside, "x.txt");
        await fs.writeFile(abs, "y");
        const result = captureResourceGitVersion(abs);
        // Either no git available or the file is outside any git repo —
        // both yield nulls (no separate history log).
        expect(result.git_commit).toBeNull();
        expect(result.git_path).toBeNull();
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
    it("captures HEAD commit and repository-relative path when the file lives inside a git repo", async () => {
      const repoDir = await fs.mkdtemp(path.join(tempDir, "git-repo-"));

      const inits = [
        ["init", "-q"],
        ["config", "user.email", "kspec-test@example.invalid"],
        ["config", "user.name", "kspec-test"],
        ["config", "commit.gpgsign", "false"],
      ];
      for (const args of inits) {
        const result = spawnSync("git", args, { cwd: repoDir, stdio: "ignore" });
        if (result.status !== 0) {
          // No git available — skip the assertion path silently.
          return;
        }
      }

      const resourcePath = path.join(repoDir, "resources", "diagram.svg");
      await fs.mkdir(path.dirname(resourcePath), { recursive: true });
      await fs.writeFile(resourcePath, "<svg/>");
      const addResult = spawnSync("git", ["add", "resources/diagram.svg"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (addResult.status !== 0) return;
      const commitResult = spawnSync("git", ["commit", "-q", "-m", "add diagram"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (commitResult.status !== 0) return;

      const result = captureResourceGitVersion(resourcePath);
      expect(result.git_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(result.git_path).toBe("resources/diagram.svg");
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
    it("returns null git fields for an untracked resource even when the worktree has a HEAD", async () => {
      const repoDir = await fs.mkdtemp(path.join(tempDir, "git-repo-untracked-"));
      const head = await initRepoWithBaseline(repoDir);
      if (head === null) return;

      // Write a new untracked resource file. HEAD exists but this file is
      // NOT present in HEAD — recording HEAD/path would be misleading.
      const resourcePath = path.join(repoDir, "resources", "new.txt");
      await fs.mkdir(path.dirname(resourcePath), { recursive: true });
      await fs.writeFile(resourcePath, "fresh content");

      const result = captureResourceGitVersion(resourcePath);
      expect(result.git_commit).toBeNull();
      expect(result.git_path).toBeNull();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
    it("returns null git fields for a staged-but-not-committed resource", async () => {
      const repoDir = await fs.mkdtemp(path.join(tempDir, "git-repo-staged-"));
      const head = await initRepoWithBaseline(repoDir);
      if (head === null) return;

      const resourcePath = path.join(repoDir, "resources", "staged.txt");
      await fs.mkdir(path.dirname(resourcePath), { recursive: true });
      await fs.writeFile(resourcePath, "staged content");
      const add = spawnSync("git", ["add", "resources/staged.txt"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (add.status !== 0) return;

      // The file is staged but not committed; HEAD does not contain it, so
      // the recorded HEAD/path pair could not resolve this resource.
      const result = captureResourceGitVersion(resourcePath);
      expect(result.git_commit).toBeNull();
      expect(result.git_path).toBeNull();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
    it("returns null git fields when a tracked resource has uncommitted modifications", async () => {
      const repoDir = await fs.mkdtemp(path.join(tempDir, "git-repo-dirty-"));
      const head = await initRepoWithBaseline(repoDir);
      if (head === null) return;

      const resourcePath = path.join(repoDir, "resources", "doc.txt");
      await fs.mkdir(path.dirname(resourcePath), { recursive: true });
      await fs.writeFile(resourcePath, "original");
      const add = spawnSync("git", ["add", "resources/doc.txt"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (add.status !== 0) return;
      const commit = spawnSync("git", ["commit", "-q", "-m", "add doc"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (commit.status !== 0) return;

      // Modify the working tree without committing — HEAD no longer
      // represents this file's content.
      await fs.writeFile(resourcePath, "modified");

      const result = captureResourceGitVersion(resourcePath);
      expect(result.git_commit).toBeNull();
      expect(result.git_path).toBeNull();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
    it("returns null git fields when a tracked resource has been deleted from the working tree", async () => {
      const repoDir = await fs.mkdtemp(path.join(tempDir, "git-repo-deleted-"));
      const head = await initRepoWithBaseline(repoDir);
      if (head === null) return;

      const resourcePath = path.join(repoDir, "resources", "gone.txt");
      await fs.mkdir(path.dirname(resourcePath), { recursive: true });
      await fs.writeFile(resourcePath, "to be deleted");
      const add = spawnSync("git", ["add", "resources/gone.txt"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (add.status !== 0) return;
      const commit = spawnSync("git", ["commit", "-q", "-m", "add gone"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (commit.status !== 0) return;

      await fs.rm(resourcePath);
      const result = captureResourceGitVersion(resourcePath);
      expect(result.git_commit).toBeNull();
      expect(result.git_path).toBeNull();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-versioning-uses-git-backed-identity
    it("captures git fields when the working tree exactly matches HEAD for that path", async () => {
      const repoDir = await fs.mkdtemp(path.join(tempDir, "git-repo-clean-"));
      const head = await initRepoWithBaseline(repoDir);
      if (head === null) return;

      const resourcePath = path.join(repoDir, "resources", "kept.txt");
      await fs.mkdir(path.dirname(resourcePath), { recursive: true });
      await fs.writeFile(resourcePath, "committed content");
      const add = spawnSync("git", ["add", "resources/kept.txt"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (add.status !== 0) return;
      const commit = spawnSync("git", ["commit", "-q", "-m", "add kept"], {
        cwd: repoDir,
        stdio: "ignore",
      });
      if (commit.status !== 0) return;
      const newHead = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir,
        encoding: "utf-8",
      });
      if (newHead.status !== 0) return;

      const result = captureResourceGitVersion(resourcePath);
      expect(result.git_commit).toBe((newHead.stdout ?? "").trim());
      expect(result.git_path).toBe("resources/kept.txt");
    });
  });

  // ── Bounded Preview ──────────────────────────────────────────────────────

  describe("getResourcePreview", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
    it("returns no preview for binary content types so bytes stay sidecar", async () => {
      const widget = await createWidget(specDir);
      const big = Buffer.alloc(10 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
      const abs = await writeResourceFile(widget.resourcesDir, "blob.bin", big);

      const preview = await getResourcePreview(abs, "application/octet-stream");
      expect(preview.text).toBe(false);
      expect(preview.preview).toBeNull();
      expect(preview.truncated).toBe(false);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("returns the full content verbatim for short text resources", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(widget.resourcesDir, "note.md", "# hello");

      const preview = await getResourcePreview(abs, "text/markdown");
      expect(preview.text).toBe(true);
      expect(preview.preview).toBe("# hello");
      expect(preview.truncated).toBe(false);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
    it("truncates long text and marks truncated when the file exceeds the bounded limit", async () => {
      const widget = await createWidget(specDir);
      const oversized = "x".repeat(RESOURCE_PREVIEW_MAX_BYTES + 100);
      const abs = await writeResourceFile(widget.resourcesDir, "big.txt", oversized);

      const preview = await getResourcePreview(abs, "text/plain");
      expect(preview.text).toBe(true);
      expect(preview.truncated).toBe(true);
      expect(preview.preview).not.toBeNull();
      expect(preview.preview!.length).toBe(RESOURCE_PREVIEW_MAX_BYTES);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("treats common textual subtypes (json, yaml, xml, svg+xml, javascript) as text", async () => {
      const widget = await createWidget(specDir);
      const cases: Array<[string, string, string]> = [
        ["data.json", "application/json", '{"a":1}'],
        ["config.yaml", "application/yaml", "a: 1"],
        ["doc.xml", "application/xml", "<a/>"],
        ["icon.svg", "image/svg+xml", "<svg/>"],
        ["script.js", "text/javascript", "1+1;"],
      ];
      for (const [name, ct, body] of cases) {
        const abs = await writeResourceFile(widget.resourcesDir, name, body);
        const preview = await getResourcePreview(abs, ct);
        expect(preview.text, `${ct} should preview as text`).toBe(true);
        expect(preview.preview).toBe(body);
      }
    });
  });

  // ── Manifest IO ──────────────────────────────────────────────────────────

  describe("loadResourceManifest / writeResourceManifest", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
    it("persists manifest entries that store metadata only, never resource bytes", async () => {
      const widget = await createWidget(specDir);
      const abs = await writeResourceFile(
        widget.resourcesDir,
        "shot.png",
        Buffer.from([0xff, 0xd8, 0xff]),
      );

      const metadata = await computeResourceMetadata({
        id: "shot",
        relativePath: "shot.png",
        absolutePath: abs,
        captureGit: false,
      });
      expect(metadata.ok).toBe(true);
      if (!metadata.ok) return;

      const manifest: ResourceManifest = { resources: [metadata.value] };
      await writeResourceManifest(widget.entityDir, manifest);

      const manifestPath = getResourcesManifestPath(widget.entityDir);
      const onDisk = await readTestOutput(manifestPath);
      // Manifest YAML should never carry the raw bytes — only metadata.
      // The PNG magic bytes (0xff 0xd8 0xff) would render as control chars
      // in YAML if inlined; assert by checking the file is short and only
      // contains the schema-known fields.
      expect(onDisk.length).toBeLessThan(2_000);
      expect(onDisk).not.toContain("\xff\xd8\xff");

      const reloaded = await loadResourceManifest(widget.entityDir);
      expect(reloaded.resources).toHaveLength(1);
      expect(reloaded.resources[0].id).toBe("shot");
      expect(reloaded.resources[0].path).toBe("shot.png");
      expect(reloaded.resources[0].content_type).toBe("image/png");
      expect(reloaded.resources[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("returns an empty manifest when resources.yaml is missing", async () => {
      const widget = await createWidget(specDir);
      const manifest = await loadResourceManifest(widget.entityDir);
      expect(manifest).toEqual({ resources: [] });
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("rejects malformed manifests via Zod schema validation on load", async () => {
      const widget = await createWidget(specDir);
      // Write a malformed manifest with an invalid sha256 string.
      await fs.writeFile(
        getResourcesManifestPath(widget.entityDir),
        "resources:\n  - id: x\n    label: null\n    path: x.png\n    content_type: image/png\n    bytes: 1\n    sha256: not-a-real-sha\n    git_commit: null\n    git_path: null\n    description: null\n",
        "utf-8",
      );
      await expect(loadResourceManifest(widget.entityDir)).rejects.toThrow();
    });
  });

  // ── Static Export ────────────────────────────────────────────────────────

  describe("copyResourceForStaticExport", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
    it("copies a declared resource to assets/resources/<type>/<ulid>/<relative-path>", async () => {
      const widget = await createWidget(specDir);
      const contents = "<svg/>";
      await writeResourceFile(widget.resourcesDir, "diagrams/flow.svg", contents);

      const manifest: ResourceManifest = {
        resources: [
          {
            id: "flow",
            label: "Flow",
            path: "diagrams/flow.svg",
            content_type: "image/svg+xml",
            bytes: contents.length,
            sha256: "a".repeat(64),
            git_commit: null,
            git_path: null,
            description: null,
          },
        ],
      };

      const exportRoot = path.join(tempDir, "export-out");
      const result = await copyResourceForStaticExport({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "diagrams/flow.svg",
        exportRoot,
        entityType: WIDGET_LAYOUT.entityType,
        entityUlid: widget.ulid,
        manifest,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.exportedPath).toBe(
        `assets/resources/widget/${widget.ulid}/diagrams/flow.svg`,
      );
      expect(result.value.absoluteExportedPath).toBe(
        path.join(exportRoot, "assets/resources/widget", widget.ulid, "diagrams/flow.svg"),
      );

      const copied = await readTestOutput(result.value.absoluteExportedPath);
      expect(copied).toBe(contents);
      expect(result.value.bytes).toBe(contents.length);
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("refuses to copy undeclared paths even when the file exists on disk", async () => {
      const widget = await createWidget(specDir);
      await writeResourceFile(widget.resourcesDir, "rogue.png", "ROGUE");

      const manifest: ResourceManifest = { resources: [] };
      const exportRoot = path.join(tempDir, "export-out");
      const result = await copyResourceForStaticExport({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "rogue.png",
        exportRoot,
        entityType: WIDGET_LAYOUT.entityType,
        entityUlid: widget.ulid,
        manifest,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not declared/i);

      // Export root must not have been polluted.
      await expect(
        fs.stat(path.join(exportRoot, "assets/resources/widget", widget.ulid, "rogue.png")),
      ).rejects.toBeDefined();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("refuses to copy paths that would resolve through a symlink escape", async () => {
      const widget = await createWidget(specDir);
      const secretDir = path.join(tempDir, "outside");
      await fs.mkdir(secretDir, { recursive: true });
      const secretPath = path.join(secretDir, "secret.txt");
      await fs.writeFile(secretPath, "secret");

      const linkPath = path.join(widget.resourcesDir, "leak.txt");
      try {
        await fs.symlink(secretPath, linkPath);
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === "EPERM" || errno === "ENOSYS") return;
        throw err;
      }

      const manifest: ResourceManifest = {
        resources: [
          {
            id: "leak",
            label: null,
            path: "leak.txt",
            content_type: "text/plain",
            bytes: 6,
            sha256: "0".repeat(64),
            git_commit: null,
            git_path: null,
            description: null,
          },
        ],
      };

      const exportRoot = path.join(tempDir, "export-out");
      const result = await copyResourceForStaticExport({
        ownerResourcesDir: widget.resourcesDir,
        relativePath: "leak.txt",
        exportRoot,
        entityType: WIDGET_LAYOUT.entityType,
        entityUlid: widget.ulid,
        manifest,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/symlink|escape/i);
    });
  });

  // ── Schema-Level Contract (round-trip + invariants) ──────────────────────

  describe("schema-level contract", () => {
    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("ResourceMetadataSchema requires content_type and rejects null", () => {
      const ok: ResourceMetadata = {
        id: "x",
        label: null,
        path: "x.png",
        content_type: "image/png",
        bytes: 1,
        sha256: "0".repeat(64),
        git_commit: null,
        git_path: null,
        description: null,
      };
      expect(ResourceMetadataSchema.parse(ok)).toEqual(ok);

      const nullCt = { ...ok, content_type: null as unknown as string };
      expect(() => ResourceMetadataSchema.parse(nullCt)).toThrow();

      const emptyCt = { ...ok, content_type: "" };
      expect(() => ResourceMetadataSchema.parse(emptyCt)).toThrow();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("ResourceMetadataSchema rejects absolute, traversal, and backslash paths at the manifest boundary", () => {
      const base: ResourceMetadata = {
        id: "x",
        label: null,
        path: "ok.txt",
        content_type: "text/plain",
        bytes: 1,
        sha256: "0".repeat(64),
        git_commit: null,
        git_path: null,
        description: null,
      };

      for (const badPath of [
        "/etc/passwd",
        "../secret.txt",
        "a\\b\\c.png",
        "",
        "logs/../escape.txt",
        "a/./b.txt",
        "a//b.txt",
        "a/",
      ]) {
        const candidate = { ...base, path: badPath };
        const parsed = ResourceMetadataSchema.safeParse(candidate);
        expect(parsed.success, `path "${badPath}" must be rejected by the schema`).toBe(false);
      }
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("loadResourceManifest rejects a resources.yaml that declares an absolute path", async () => {
      const widget = await createWidget(specDir);
      const sha = "0".repeat(64);
      await fs.writeFile(
        getResourcesManifestPath(widget.entityDir),
        `resources:\n  - id: x\n    label: null\n    path: /etc/passwd\n    content_type: text/plain\n    bytes: 1\n    sha256: ${sha}\n    git_commit: null\n    git_path: null\n    description: null\n`,
        "utf-8",
      );
      await expect(loadResourceManifest(widget.entityDir)).rejects.toThrow();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
    it("loadResourceManifest rejects a resources.yaml that declares a parent-traversal path", async () => {
      const widget = await createWidget(specDir);
      const sha = "0".repeat(64);
      await fs.writeFile(
        getResourcesManifestPath(widget.entityDir),
        `resources:\n  - id: y\n    label: null\n    path: ../escape.txt\n    content_type: text/plain\n    bytes: 1\n    sha256: ${sha}\n    git_commit: null\n    git_path: null\n    description: null\n`,
        "utf-8",
      );
      await expect(loadResourceManifest(widget.entityDir)).rejects.toThrow();
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
    it("ResourceManifestSchema defaults resources to an empty array when omitted", () => {
      const parsed = ResourceManifestSchema.parse({});
      expect(parsed).toEqual({ resources: [] });
    });

    // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
    it("writeResourceManifest persists a YAML manifest that round-trips through loadResourceManifest", async () => {
      const widget = await createWidget(specDir);
      const original: ResourceManifest = {
        resources: [
          {
            id: "a",
            label: "Alpha",
            path: "alpha.txt",
            content_type: "text/plain",
            bytes: 5,
            sha256: "1".repeat(64),
            git_commit: "f".repeat(40),
            git_path: ".kspec/widgets/x/resources/alpha.txt",
            description: "first",
          },
        ],
      };
      await writeResourceManifest(widget.entityDir, original);

      // Confirm YAML is well-formed by reading raw and re-validating.
      const raw = await readYamlFile<unknown>(getResourcesManifestPath(widget.entityDir));
      expect(() => ResourceManifestSchema.parse(raw)).not.toThrow();

      const reloaded = await loadResourceManifest(widget.entityDir);
      expect(reloaded).toEqual(original);
    });
  });
});
