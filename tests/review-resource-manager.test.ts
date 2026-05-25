/**
 * Review resource manager unit tests.
 *
 * Covers the manager layer that the CLI and daemon both call: add, list,
 * get, resolve, and remove against folder-backed reviews, exercising the
 * exact error codes downstream surfaces need.
 *
 * Spec: @folder-backed-review-storage-1
 *       @trait-entity-scoped-local-resources-1
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";

import {
  addReviewResource,
  getReviewResource,
  listReviewResources,
  removeReviewResource,
  resolveReviewResourceFile,
} from "../src/parser/review-resource-manager.js";
import { saveReviewRecord, createReviewRecord } from "../src/parser/reviews.js";
import { getReviewDir } from "../src/parser/review-storage-manager.js";
import { cleanupTempDir, createTempDir, initGitRepo } from "./helpers/cli.js";

interface FolderCtx {
  specDir: string;
  manifest: {
    kynetic: string;
    review_storage: { format: "folder" };
    resource_storage: { format: "entity_scoped" };
  };
}

function makeCtx(specDir: string): FolderCtx {
  return {
    specDir,
    manifest: {
      kynetic: "1.2",
      review_storage: { format: "folder" },
      resource_storage: { format: "entity_scoped" },
    },
  };
}

function makeReview(overrides: Partial<Parameters<typeof createReviewRecord>[0]> = {}) {
  return createReviewRecord({
    title: overrides.title ?? "Resource Review",
    subject: overrides.subject ?? {
      type: "code" as const,
      base_commit: "aaaa1111",
      head_commit: "bbbb2222",
    },
    author: overrides.author ?? "@tester",
    ...overrides,
  });
}

describe("review-resource-manager", () => {
  let tempDir: string;
  let kspecDir: string;
  let ctx: FolderCtx;
  let sourceDir: string;
  let pngSource: string;
  let logSource: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = path.join(tempDir, ".kspec");
    await fs.mkdir(kspecDir, { recursive: true });
    await initGitRepo(tempDir);
    ctx = makeCtx(kspecDir);

    sourceDir = path.join(tempDir, "uploads");
    await fs.mkdir(sourceDir, { recursive: true });
    pngSource = path.join(sourceDir, "screenshot.png");
    await fs.writeFile(pngSource, "fake-png-bytes-for-testing");
    logSource = path.join(sourceDir, "build.log");
    await fs.writeFile(logSource, "build started\nbuild ok\n");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function seededReview(slug = "test") {
    const review = makeReview({ slugs: [slug] });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });
    return review;
  }

  // ── add ────────────────────────────────────────────────────────────────────

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("addReviewResource attaches a screenshot and records SHA-256, byte size, content type", async () => {
    const review = await seededReview("screenshot");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "login-bug",
      relativePath: "screenshots/login.png",
      sourceFile: pngSource,
      label: "Login screenshot",
      captureGit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replaced).toBe(false);
    expect(result.value.resource.id).toBe("login-bug");
    expect(result.value.resource.path).toBe("screenshots/login.png");
    expect(result.value.resource.content_type).toBe("image/png");
    expect(result.value.resource.bytes).toBe(
      Buffer.byteLength("fake-png-bytes-for-testing"),
    );
    expect(result.value.resource.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The file actually exists under the review's resources/ tree.
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const onDisk = await fs.stat(path.join(reviewDir, "resources", "screenshots", "login.png"));
    expect(onDisk.isFile()).toBe(true);
    // Manifest reflects the new entry.
    const manifestRaw = await fs.readFile(path.join(reviewDir, "resources.yaml"), "utf-8");
    const manifest = yamlParse(manifestRaw);
    expect(manifest.resources).toHaveLength(1);
    expect(manifest.resources[0].id).toBe("login-bug");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("rejects relative paths that escape the resources tree", async () => {
    const review = await seededReview("escape");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "evil",
      relativePath: "../../../etc/passwd",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.path).toBe("../../../etc/passwd");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("rejects invalid resource ids", async () => {
    const review = await seededReview("badid");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "Login-Bug!", // uppercase + punctuation not allowed
      relativePath: "shot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_id");
    expect(result.error.resource_id).toBe("Login-Bug!");
  });

  it("rejects an explicit content_type that is not a valid MIME token", async () => {
    const review = await seededReview("badtype");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: pngSource,
      contentType: "image png",
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_content_type");
  });

  it("returns source_file_missing when the source file does not exist", async () => {
    const review = await seededReview("nofile");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: path.join(sourceDir, "does-not-exist.png"),
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("source_file_missing");
    expect(result.error.source_file).toContain("does-not-exist.png");
  });

  it("returns source_file_unreadable for non-regular sources", async () => {
    const review = await seededReview("dirsrc");
    const dirSrc = path.join(sourceDir, "a-dir");
    await fs.mkdir(dirSrc);
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: dirSrc,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("source_file_unreadable");
  });

  it("returns review_not_found when the review ref does not match", async () => {
    const result = await addReviewResource(ctx as any, "@no-such-review", {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("review_not_found");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
  it("infers content_type from the path extension when none is supplied", async () => {
    const review = await seededReview("infer");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "log",
      relativePath: "logs/build.log",
      sourceFile: logSource,
      captureGit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resource.content_type).toBe("text/plain");
  });

  it("rejects id collisions without --replace", async () => {
    const review = await seededReview("collide-id");
    const first = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(first.ok).toBe(true);
    const collision = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot2.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(collision.ok).toBe(false);
    if (collision.ok) return;
    expect(collision.error.code).toBe("resource_conflict");
  });

  it("rejects path collisions across resource ids even with --replace", async () => {
    const review = await seededReview("collide-path");
    await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "first",
      relativePath: "shot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    const collision = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "second",
      relativePath: "shot.png",
      sourceFile: pngSource,
      replace: true,
      captureGit: false,
    });
    expect(collision.ok).toBe(false);
    if (collision.ok) return;
    expect(collision.error.code).toBe("resource_conflict");
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("replaces an existing resource's bytes, content_type, and metadata with --replace", async () => {
    const review = await seededReview("replace");
    await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "old.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    const newSource = path.join(sourceDir, "new.png");
    await fs.writeFile(newSource, "completely-different-bytes-for-replace");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "new.png",
      sourceFile: newSource,
      replace: true,
      captureGit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replaced).toBe(true);
    expect(result.value.resource.path).toBe("new.png");
    expect(result.value.resource.bytes).toBe(
      Buffer.byteLength("completely-different-bytes-for-replace"),
    );
    // The old file is removed since the path moved.
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    await expect(fs.stat(path.join(reviewDir, "resources", "old.png"))).rejects.toThrow();
    await fs.stat(path.join(reviewDir, "resources", "new.png"));
    // Manifest should still have exactly one entry.
    const manifestRaw = await fs.readFile(path.join(reviewDir, "resources.yaml"), "utf-8");
    const manifest = yamlParse(manifestRaw);
    expect(manifest.resources).toHaveLength(1);
  });

  it("rejects --replace when the id does not exist", async () => {
    const review = await seededReview("replace-missing");
    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "no-such-resource",
      relativePath: "shot.png",
      sourceFile: pngSource,
      replace: true,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("resource_not_found");
  });

  // ── list / get / resolve ───────────────────────────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("listReviewResources returns metadata for every declared resource", async () => {
    const review = await seededReview("list");
    await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "one",
      relativePath: "a.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "two",
      relativePath: "b.log",
      sourceFile: logSource,
      captureGit: false,
    });
    const listing = await listReviewResources(ctx as any, `@${review._ulid}`);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    expect(listing.value.resources.map((r) => r.id)).toEqual(["one", "two"]);
  });

  it("listReviewResources returns review_not_found for missing reviews", async () => {
    const result = await listReviewResources(ctx as any, "@no-such-review");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("review_not_found");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("getReviewResource returns resource_not_found for undeclared ids", async () => {
    const review = await seededReview("getmiss");
    const result = await getReviewResource(ctx as any, `@${review._ulid}`, "missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("resource_not_found");
    expect(result.error.resource_id).toBe("missing");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("resolveReviewResourceFile returns the real on-disk path inside the review tree", async () => {
    const review = await seededReview("resolve");
    await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    const result = await resolveReviewResourceFile(ctx as any, `@${review._ulid}`, "shot");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    expect(result.value.absolutePath).toBe(
      await fs.realpath(path.join(reviewDir, "resources", "shot.png")),
    );
  });

  // ── remove ─────────────────────────────────────────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("removeReviewResource deletes the manifest entry and the owned file", async () => {
    const review = await seededReview("remove");
    await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    await fs.stat(path.join(reviewDir, "resources", "shot.png"));

    const result = await removeReviewResource(ctx as any, `@${review._ulid}`, "shot");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.removed).toEqual({ id: "shot", path: "shot.png" });
    await expect(fs.stat(path.join(reviewDir, "resources", "shot.png"))).rejects.toThrow();
    const manifestRaw = await fs.readFile(path.join(reviewDir, "resources.yaml"), "utf-8");
    const manifest = yamlParse(manifestRaw);
    expect(manifest.resources).toEqual([]);
  });

  it("removeReviewResource returns resource_not_found for unknown ids", async () => {
    const review = await seededReview("rm-missing");
    const result = await removeReviewResource(ctx as any, `@${review._ulid}`, "nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("resource_not_found");
  });
});
