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

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("rejects an explicit content_type that is not a valid MIME token via the documented invalid_resource_path code", async () => {
    // The CLI/API contract for review resources enumerates a closed set of
    // failure codes; invalid_content_type is NOT in that set. content_type
    // is path-derived metadata (inferred from path extension when omitted),
    // so a malformed explicit value surfaces under invalid_resource_path
    // with the offending relative path attached. See
    // ReviewResourceErrorCode docs in review-resource-manager.ts.
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
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.path).toBe("shot.png");
    expect(result.error.resource_id).toBe("shot");
    expect(result.error.message).toContain("content_type");
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

  // ── symlink-safe remove ────────────────────────────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("removeReviewResource rejects deletion through a symlinked intermediate directory and leaves the outside file intact", async () => {
    // The previous implementation called fs.rm(path.join(resourcesDir,
    // resource.path)) without symlink-safe path machinery. If
    // resources/<dir> was a symlink, Node would follow the intermediate
    // symlink and remove the outside target — violating the shared
    // local-resource contract that symlink escapes are rejected and no
    // file outside the owning entity tree is touched.
    //
    // This test sets up the exact attack shape the reviewer reproduced:
    //   <reviewDir>/resources/        — real dir
    //   <reviewDir>/resources/screenshots → symlink → <tempDir>/escape-target/
    //   <tempDir>/escape-target/victim.txt    — outside file
    // Manifest declares a resource at relative path screenshots/victim.txt.
    // Calling removeReviewResource must reject (not delete the outside file).
    const review = await seededReview("rm-symlink-dir");
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const resourcesDir = path.join(reviewDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });

    const escapeTarget = path.join(tempDir, "rm-escape-target");
    await fs.mkdir(escapeTarget, { recursive: true });
    const victimPath = path.join(escapeTarget, "victim.txt");
    await fs.writeFile(victimPath, "outside-evidence");

    // Plant the malicious intermediate symlink AFTER seeding the manifest,
    // since the entity-local-resources copySourceIntoOwnerResources writer
    // would otherwise reject the plant. We hand-write the manifest entry
    // and an inert local file so the get-resource lookup succeeds and the
    // delete path is the one under test.
    const innerFile = path.join(escapeTarget, "evidence.png");
    await fs.writeFile(innerFile, "inert");
    await fs.symlink(escapeTarget, path.join(resourcesDir, "screenshots"));
    // Write the manifest declaring screenshots/evidence.png so getReviewResource
    // succeeds and removeReviewResource proceeds into the deletion path.
    const manifest = {
      resources: [
        {
          id: "evil",
          label: null,
          path: "screenshots/evidence.png",
          content_type: "image/png",
          bytes: 5,
          sha256:
            "0000000000000000000000000000000000000000000000000000000000000000",
          git_commit: null,
          git_path: null,
          description: null,
        },
      ],
    };
    await fs.writeFile(
      path.join(reviewDir, "resources.yaml"),
      `resources:\n  - id: evil\n    label: null\n    path: screenshots/evidence.png\n    content_type: image/png\n    bytes: 5\n    sha256: "0000000000000000000000000000000000000000000000000000000000000000"\n    git_commit: null\n    git_path: null\n    description: null\n`,
    );

    const result = await removeReviewResource(ctx as any, `@${review._ulid}`, "evil");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.message).toMatch(/symlink/i);

    // Crucially: the outside victim files are untouched.
    await fs.stat(victimPath);
    expect(await fs.readFile(victimPath, "utf-8")).toBe("outside-evidence");
    await fs.stat(innerFile);

    // Manifest is also untouched — failed remove must not silently drop
    // the manifest entry, otherwise the user observes a "deleted" resource
    // and never notices that the symlink escape attempt was rejected.
    const remainingRaw = await fs.readFile(path.join(reviewDir, "resources.yaml"), "utf-8");
    const remaining = yamlParse(remainingRaw);
    expect(remaining.resources).toHaveLength(1);
    expect(remaining.resources[0].id).toBe("evil");

    // Silence the unused-manifest lint; we built it to document the expected
    // shape but assert against the on-disk text above.
    void manifest;
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("removeReviewResource rejects deletion when resources/ itself is a symlink", async () => {
    const review = await seededReview("rm-symlink-root");
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    await fs.mkdir(reviewDir, { recursive: true });
    const outside = path.join(tempDir, "rm-symlink-root-target");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "shot.png"), "outside-bytes");
    // Plant the symlink at <reviewDir>/resources pointing OUTSIDE.
    await fs.symlink(outside, path.join(reviewDir, "resources"));
    // Manifest declares the resource so getReviewResource succeeds and the
    // removeReviewResource path is exercised.
    await fs.writeFile(
      path.join(reviewDir, "resources.yaml"),
      `resources:\n  - id: shot\n    label: null\n    path: shot.png\n    content_type: image/png\n    bytes: 13\n    sha256: "0000000000000000000000000000000000000000000000000000000000000000"\n    git_commit: null\n    git_path: null\n    description: null\n`,
    );

    const result = await removeReviewResource(ctx as any, `@${review._ulid}`, "shot");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.message).toMatch(/symlink/i);

    // Outside file is untouched.
    expect(await fs.readFile(path.join(outside, "shot.png"), "utf-8")).toBe(
      "outside-bytes",
    );
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("removeReviewResource rejects deletion of a destination that is itself a symlink", async () => {
    // A symlink at the final-segment destination (resources/shot.png →
    // outside.png) is the third escape variant: the intermediates are
    // fine, but the file we'd unlink is a symlink. Even though fs.unlink
    // does not follow the final symlink (it removes the link itself, not
    // its target), the contract is that ANY symlink in the path implies
    // a tainted state and we should refuse rather than silently mutate
    // unexpected filesystem structure.
    const review = await seededReview("rm-symlink-dest");
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const resourcesDir = path.join(reviewDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });
    const outside = path.join(tempDir, "rm-symlink-dest-target.png");
    await fs.writeFile(outside, "outside-bytes");
    await fs.symlink(outside, path.join(resourcesDir, "shot.png"));
    await fs.writeFile(
      path.join(reviewDir, "resources.yaml"),
      `resources:\n  - id: shot\n    label: null\n    path: shot.png\n    content_type: image/png\n    bytes: 13\n    sha256: "0000000000000000000000000000000000000000000000000000000000000000"\n    git_commit: null\n    git_path: null\n    description: null\n`,
    );

    const result = await removeReviewResource(ctx as any, `@${review._ulid}`, "shot");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.message).toMatch(/symlink/i);

    // Outside file (the symlink target) must be intact.
    await fs.stat(outside);
    expect(await fs.readFile(outside, "utf-8")).toBe("outside-bytes");
  });

  // ── source-file readability (chmod 000 regular files) ──────────────────────

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("addReviewResource returns source_file_unreadable for a regular file the process cannot read", async () => {
    // The previous implementation only used stat().isFile() to gate
    // source-file validity. A regular file with no read permissions
    // (chmod 000) passes isFile() and then fs.copyFile inside
    // copySourceIntoOwnerResources throws EACCES. That EACCES escapes
    // the manager and is mapped to entity_storage_incompatible / exit 3
    // by the CLI — masking the documented source_file_unreadable code.
    //
    // This test reproduces the reviewer's chmod-000 scenario and asserts
    // the documented code surfaces from the manager layer (CLI/API are
    // thin wrappers on top of this Result, so once the manager produces
    // source_file_unreadable the downstream layers map it correctly).
    if (process.platform === "win32" || process.getuid?.() === 0) {
      // chmod 000 has no effect for root or on platforms without POSIX
      // permission semantics; skip rather than produce a flaky test.
      return;
    }
    const review = await seededReview("rd000");
    const unreadable = path.join(sourceDir, "unreadable.png");
    await fs.writeFile(unreadable, "private-bytes");
    await fs.chmod(unreadable, 0o000);
    try {
      const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
        id: "shot",
        relativePath: "shot.png",
        sourceFile: unreadable,
        captureGit: false,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("source_file_unreadable");
      expect(result.error.source_file).toBe(unreadable);

      // And no resource file should have been written into the review's
      // resources tree — the validation must run BEFORE any bytes are
      // copied in.
      const reviewDir = getReviewDir(ctx as any, review._ulid);
      await expect(
        fs.stat(path.join(reviewDir, "resources", "shot.png")),
      ).rejects.toThrow();
    } finally {
      // Restore permissions so the temp dir can be cleaned up.
      await fs.chmod(unreadable, 0o600).catch(() => {});
    }
  });

  // ── symlink-safe writes ────────────────────────────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("addReviewResource rejects writes that would follow a symlinked resources/ root", async () => {
    const review = await seededReview("symlinked-root");
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const outside = path.join(tempDir, "escape-target");
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(reviewDir, { recursive: true });
    // Plant a symlink at <reviewDir>/resources pointing OUTSIDE the review.
    await fs.symlink(outside, path.join(reviewDir, "resources"));

    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "evil",
      relativePath: "screenshot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.message).toMatch(/symlink/i);
    // And no file should have been written to the escape target.
    await expect(fs.stat(path.join(outside, "screenshot.png"))).rejects.toThrow();
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("addReviewResource rejects writes that would follow a symlinked intermediate directory", async () => {
    const review = await seededReview("symlinked-dir");
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const resourcesDir = path.join(reviewDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });
    const outside = path.join(tempDir, "evil-target");
    await fs.mkdir(outside, { recursive: true });
    // Plant a symlink at <reviewDir>/resources/screenshots pointing OUTSIDE.
    await fs.symlink(outside, path.join(resourcesDir, "screenshots"));

    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "evil",
      relativePath: "screenshots/login.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.message).toMatch(/symlink/i);
    await expect(fs.stat(path.join(outside, "login.png"))).rejects.toThrow();
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("addReviewResource rejects overwriting an existing symlink at the destination", async () => {
    const review = await seededReview("symlinked-dest");
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const resourcesDir = path.join(reviewDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });
    const outside = path.join(tempDir, "evil-target.png");
    await fs.writeFile(outside, "outside-bytes");
    // Plant a symlink at <reviewDir>/resources/shot.png pointing OUTSIDE.
    await fs.symlink(outside, path.join(resourcesDir, "shot.png"));

    const result = await addReviewResource(ctx as any, `@${review._ulid}`, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile: pngSource,
      captureGit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_path");
    expect(result.error.message).toMatch(/symlink/i);
    // The outside file content must be unchanged.
    expect(await fs.readFile(outside, "utf-8")).toBe("outside-bytes");
  });

  // ── resource id validation on read/delete paths ────────────────────────────

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("getReviewResource returns invalid_resource_id for malformed ids (not resource_not_found)", async () => {
    const review = await seededReview("getbadid");
    const result = await getReviewResource(ctx as any, `@${review._ulid}`, "BadID!");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_id");
    expect(result.error.resource_id).toBe("BadID!");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("resolveReviewResourceFile returns invalid_resource_id for malformed ids", async () => {
    const review = await seededReview("resolvebadid");
    const result = await resolveReviewResourceFile(ctx as any, `@${review._ulid}`, "Bad/ID");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_id");
    expect(result.error.resource_id).toBe("Bad/ID");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("removeReviewResource returns invalid_resource_id for malformed ids (not resource_not_found)", async () => {
    const review = await seededReview("rmbadid");
    const result = await removeReviewResource(ctx as any, `@${review._ulid}`, "Bad ID");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_resource_id");
    expect(result.error.resource_id).toBe("Bad ID");
  });
});
