/**
 * Folder-backed review storage manager unit tests.
 *
 * Covers @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive,
 * ac-review-index-has-bounded-projection, ac-review-delete-removes-owned-folder,
 * plus the @trait-folder-backed-entity-1 unknown-file preservation and
 * @trait-entity-scoped-local-resources-1 owned-resource cleanup AC the spec
 * inherits.
 *
 * The on-disk screenshot loading AC (ac-review-screenshot-resource-loads-in-ui)
 * is covered behaviorally by exercising the existing entity-scoped local
 * resources resolver (resolveResourceReference) against a folder-backed
 * review that declares a screenshot in `resources.yaml` — proving the
 * resolver can discover and load the file from a folder-backed review at
 * its stable review-scoped path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import {
  createReviewRecord,
  deleteReviewRecord,
  findReviewByRef,
  loadReviewRecords,
  mutateReviewAtomically,
  saveReviewRecord,
} from "../src/parser/reviews.js";
import {
  computeReviewIndexDrift,
  getReviewDetailFilePath,
  getReviewDir,
  getReviewIndexFilePath,
  rebuildReviewIndex,
} from "../src/parser/review-storage-manager.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
} from "./helpers/cli.js";
import { resolveResourceReference } from "../src/parser/entity-local-resources.js";

interface FolderCtx {
  specDir: string;
  manifest: {
    kynetic: string;
    review_storage: { format: "folder" };
    resource_storage?: { format: "entity_scoped" };
  };
}

function makeCtx(specDir: string, withResources = false): FolderCtx {
  return {
    specDir,
    manifest: {
      kynetic: "1.2",
      review_storage: { format: "folder" },
      ...(withResources ? { resource_storage: { format: "entity_scoped" as const } } : {}),
    },
  };
}

async function readIndexFile(indexPath: string): Promise<{
  kynetic_reviews?: string;
  reviews?: Array<Record<string, unknown>>;
} | null> {
  try {
    const raw = await readTestOutput(indexPath);
    return yamlParse(raw);
  } catch {
    return null;
  }
}

async function readDetail(detailPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readTestOutput(detailPath);
    return yamlParse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function makeReview(overrides: Partial<Parameters<typeof createReviewRecord>[0]> = {}) {
  return createReviewRecord({
    title: overrides.title ?? "Folder Review",
    subject: overrides.subject ?? {
      type: "code" as const,
      base_commit: "aaaa1111",
      head_commit: "bbbb2222",
    },
    author: overrides.author ?? "@tester",
    ...overrides,
  });
}

describe("Folder-backed review storage manager", () => {
  let tempDir: string;
  let kspecDir: string;
  let ctx: FolderCtx;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = path.join(tempDir, ".kspec");
    await fs.mkdir(kspecDir, { recursive: true });
    await initGitRepo(tempDir);
    ctx = makeCtx(kspecDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
  // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
  it("creates review.yaml and a ULID directory on save with the full cohesive record", async () => {
    const review = makeReview({
      title: "Cohesive Review",
      slugs: ["cohesive-review"],
      threads: [
        {
          _ulid: "01THRDA000000000000000000A",
          kind: "blocker" as const,
          entries: [
            {
              _ulid: "01THRDENTRA0000000000000AA",
              created_at: "2026-05-23T10:00:00Z",
              author: "@reviewer",
              body: "Found an issue",
            },
          ],
          anchor: {
            type: "code" as const,
            path: "src/foo.ts",
            side: "head" as const,
            line_start: 10,
            line_end: 20,
            commit: "bbbb2222",
          },
        },
      ],
      checks: [
        {
          name: "lint",
          status: "fail" as const,
          required: true,
          applies_to_version: {
            type: "code_compare" as const,
            base_commit: "aaaa1111",
            head_commit: "bbbb2222",
          },
          created_at: "2026-05-23T10:00:00Z",
        },
      ],
      verdicts: [
        {
          reviewer: "@reviewer",
          role: "reviewer",
          decision: "request_changes" as const,
          applies_to_version: {
            type: "code_compare" as const,
            base_commit: "aaaa1111",
            head_commit: "bbbb2222",
          },
          created_at: "2026-05-23T10:00:00Z",
        },
      ],
      external_links: [{ provider: "github", url: "https://github.com/example/pr/1" }],
      notes: [
        {
          _ulid: "01NOTE0000000000000000000A",
          created_at: "2026-05-23T10:00:00Z",
          author: "@reviewer",
          content: "Discussion note",
        },
      ],
    });

    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const detailPath = getReviewDetailFilePath(ctx as any, review._ulid);

    expect(await pathExists(reviewDir)).toBe(true);
    expect(await pathExists(detailPath)).toBe(true);

    const detail = await readDetail(detailPath);
    expect(detail?._ulid).toBe(review._ulid);
    expect(detail?.title).toBe("Cohesive Review");
    expect(Array.isArray(detail?.threads)).toBe(true);
    expect((detail?.threads as unknown[]).length).toBe(1);
    expect(Array.isArray(detail?.checks)).toBe(true);
    expect((detail?.checks as unknown[]).length).toBe(1);
    expect(Array.isArray(detail?.verdicts)).toBe(true);
    expect(Array.isArray(detail?.notes)).toBe(true);
    expect(Array.isArray(detail?.external_links)).toBe(true);
    expect(detail?.subject).toBeDefined();

    // The detail file MUST NOT be split across multiple sidecars — there
    // are no per-thread / per-check / per-verdict files in this slice.
    const dirEntries = await fs.readdir(reviewDir);
    expect(dirEntries.sort()).toEqual(["review.yaml"]);
  });

  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  // AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
  it("writes a lean index entry without thread/check/verdict/event/note bodies", async () => {
    const review = makeReview({
      title: "Lean Index",
      slugs: ["lean-index"],
      threads: [
        {
          _ulid: "01THRDB000000000000000000A",
          kind: "blocker" as const,
          entries: [
            {
              _ulid: "01THRDENTRB0000000000000AA",
              created_at: "2026-05-23T10:00:00Z",
              author: "@reviewer",
              body: "Long thread body that must not appear in the index.",
            },
          ],
        },
      ],
      checks: [
        {
          name: "tests",
          status: "pass" as const,
          required: true,
          applies_to_version: {
            type: "code_compare" as const,
            base_commit: "aaaa1111",
            head_commit: "bbbb2222",
          },
          created_at: "2026-05-23T10:00:00Z",
        },
      ],
      notes: [
        {
          _ulid: "01NOTE0000000000000000000B",
          created_at: "2026-05-23T10:00:00Z",
          author: "@reviewer",
          content: "Note body that must not appear in the index.",
        },
      ],
    });

    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const indexPath = getReviewIndexFilePath(ctx as any);
    const indexFile = await readIndexFile(indexPath);
    expect(indexFile?.kynetic_reviews).toBe("1.0");
    expect(indexFile?.reviews).toHaveLength(1);

    const entry = indexFile!.reviews![0];
    expect(entry._ulid).toBe(review._ulid);
    expect(entry.title).toBe("Lean Index");
    expect(entry.lifecycle_state).toBe("draft");
    expect(entry.author).toBe("@tester");
    expect(entry.disposition).toBeDefined();
    expect(entry.thread_count).toBe(1);
    expect(entry.unresolved_blocker_count).toBe(1);
    expect(entry.check_count).toBe(1);
    expect(entry.verdict_count).toBe(0);
    expect(entry.subject).toBeDefined();
    expect(entry.related_refs).toEqual([]);

    // Heavy detail fields must be absent from the index.
    expect(entry.threads).toBeUndefined();
    expect(entry.checks).toBeUndefined();
    expect(entry.verdicts).toBeUndefined();
    expect(entry.events).toBeUndefined();
    expect(entry.notes).toBeUndefined();
  });

  // AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
  it("supports findReviewByRef via ULID, short prefix, and slug", async () => {
    const review = makeReview({ title: "Reference Review", slugs: ["reference-review"] });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const reviews = await loadReviewRecords(ctx as any);
    expect(reviews).toHaveLength(1);

    const byUlid = findReviewByRef(reviews, review._ulid);
    expect(byUlid?._ulid).toBe(review._ulid);

    const byShort = findReviewByRef(reviews, review._ulid.slice(0, 8));
    expect(byShort?._ulid).toBe(review._ulid);

    const bySlug = findReviewByRef(reviews, "reference-review");
    expect(bySlug?._ulid).toBe(review._ulid);

    const byAt = findReviewByRef(reviews, "@reference-review");
    expect(byAt?._ulid).toBe(review._ulid);

    const missing = findReviewByRef(reviews, "nonexistent");
    expect(missing).toBeUndefined();
  });

  // AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
  it("mutateReviewAtomically updates the detail file and refreshes the index entry", async () => {
    const review = makeReview({ title: "Initial Title" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const updated = await mutateReviewAtomically(ctx as any, { ...review, _sourceFile: undefined }, (latest) => ({
      ...latest,
      title: "Updated Title",
      lifecycle_state: "open" as const,
      updated_at: "2026-05-23T12:00:00Z",
    }));

    expect(updated.title).toBe("Updated Title");
    expect(updated.lifecycle_state).toBe("open");

    const loaded = await loadReviewRecords(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe("Updated Title");
    expect(loaded[0].lifecycle_state).toBe("open");

    // Index entry tracks the changed indexed fields.
    const indexFile = await readIndexFile(getReviewIndexFilePath(ctx as any));
    const entry = indexFile!.reviews![0];
    expect(entry.title).toBe("Updated Title");
    expect(entry.lifecycle_state).toBe("open");
    expect(entry.updated_at).toBe("2026-05-23T12:00:00Z");
  });

  // AC: @folder-backed-review-storage-1 ac-review-delete-removes-owned-folder
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("deleteReviewRecord removes the review directory (with resources) and index entry", async () => {
    const review = makeReview({ title: "To Delete" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    // Simulate owned resources to verify the recursive cleanup.
    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const resourcesDir = path.join(reviewDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });
    await fs.writeFile(path.join(resourcesDir, "screenshot.png"), "binary-data", "utf-8");
    await fs.writeFile(
      path.join(reviewDir, "resources.yaml"),
      "resources:\n  - id: screenshot\n    label: Screenshot\n    path: screenshot.png\n",
      "utf-8",
    );

    const deleted = await deleteReviewRecord(ctx as any, review._ulid);
    expect(deleted).toBe(true);

    expect(await pathExists(reviewDir)).toBe(false);

    const indexFile = await readIndexFile(getReviewIndexFilePath(ctx as any));
    expect(indexFile?.reviews ?? []).toHaveLength(0);
  });

  it("deleteReviewRecord returns false when review is missing", async () => {
    const result = await deleteReviewRecord(ctx as any, "01MSSNGAAAAAAAAAAAAAAAAAAA");
    expect(result).toBe(false);
  });

  // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
  it("preserves unknown files within a review directory across mutations", async () => {
    const review = makeReview({ title: "Unknown Files" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const reviewDir = getReviewDir(ctx as any, review._ulid);
    const unknownPath = path.join(reviewDir, "scratch.txt");
    await fs.writeFile(unknownPath, "hand-edited notes that must survive", "utf-8");

    await mutateReviewAtomically(ctx as any, { ...review, _sourceFile: undefined }, (latest) => ({
      ...latest,
      title: "Renamed",
    }));

    expect(await pathExists(unknownPath)).toBe(true);
    expect(await readTestOutput(unknownPath)).toBe("hand-edited notes that must survive");
  });

  // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
  it("preserves unknown review.yaml fields across mutations", async () => {
    const review = makeReview({ title: "Unknown Fields" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const detailPath = getReviewDetailFilePath(ctx as any, review._ulid);
    const original = await readDetail(detailPath);
    (original as Record<string, unknown>).future_field = { kept: true };
    await fs.writeFile(detailPath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");

    await mutateReviewAtomically(ctx as any, { ...review, _sourceFile: undefined }, (latest) => ({
      ...latest,
      title: "Touched",
    }));

    const after = await readDetail(detailPath);
    expect(after?.title).toBe("Touched");
    expect(after?.future_field).toEqual({ kept: true });
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("resolves a declared screenshot resource through the review-scoped resource path", async () => {
    const resourceCtx = makeCtx(kspecDir, true);
    const review = makeReview({ title: "Screenshot Review" });
    await saveReviewRecord(resourceCtx as any, { ...review, _sourceFile: undefined });

    const reviewDir = getReviewDir(resourceCtx as any, review._ulid);
    const resourcesDir = path.join(reviewDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });
    const screenshotPath = path.join(resourcesDir, "shot.png");
    await fs.writeFile(screenshotPath, "fake-png-bytes", "utf-8");
    await fs.writeFile(
      path.join(reviewDir, "resources.yaml"),
      [
        "resources:",
        "  - id: shot",
        "    label: Screenshot",
        "    path: shot.png",
        "    content_type: image/png",
        "    bytes: 14",
        '    sha256: "0000000000000000000000000000000000000000000000000000000000000000"',
        "    git_commit: null",
        "    git_path: null",
        "    description: null",
        "",
      ].join("\n"),
      "utf-8",
    );

    const resolved = await resolveResourceReference({
      ctx: resourceCtx as any,
      ownerEntityDir: reviewDir,
      relativePath: "shot.png",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.relativePath).toBe("shot.png");
      expect(path.relative(resourcesDir, resolved.value.absolutePath)).toBe("shot.png");
    }
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  it("computeReviewIndexDrift detects added entries (folder exists, index missing)", async () => {
    const review = makeReview({ title: "Drift" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    // Add a second review directory by hand to simulate drift.
    const otherUlid = "01TESTDRFTREVAAAAAAAAAAAAA";
    const otherDir = path.join(kspecDir, "reviews", otherUlid);
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(
      path.join(otherDir, "review.yaml"),
      [
        `_ulid: ${otherUlid}`,
        "slugs: []",
        "title: Orphan Folder",
        "lifecycle_state: draft",
        "subject:",
        "  type: code",
        "  base_commit: aaaa1111",
        "  head_commit: bbbb2222",
        "author: '@tester'",
        "related_refs: []",
        "threads: []",
        "checks: []",
        "verdicts: []",
        "events: []",
        "notes: []",
        "external_links: []",
        "examined_commit: null",
        "created_at: 2026-05-23T13:00:00Z",
        "",
      ].join("\n"),
      "utf-8",
    );

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.changes).toHaveLength(1);
    expect(drift.changes[0].kind).toBe("add");
    expect(drift.changes[0].ref).toBe(otherUlid);
    expect(drift.conflicts).toHaveLength(0);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("computeReviewIndexDrift surfaces stale index entries as conflicts without --force", async () => {
    const review = makeReview({ title: "Stale" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    // Drop the review folder to leave the index entry stranded.
    await fs.rm(getReviewDir(ctx as any, review._ulid), { recursive: true });

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.conflicts).toHaveLength(1);
    expect(drift.conflicts[0].code).toBe("stale_index_entry_without_force");
    expect(drift.conflicts[0].ref).toBe(review._ulid);
    expect(drift.changes.filter((c) => c.kind === "remove_stale")).toHaveLength(0);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("computeReviewIndexDrift reports stale entries as remove_stale when force is set", async () => {
    const review = makeReview({ title: "Stale Force" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    await fs.rm(getReviewDir(ctx as any, review._ulid), { recursive: true });

    const drift = await computeReviewIndexDrift(ctx as any, { force: true });
    expect(drift.conflicts).toHaveLength(0);
    expect(drift.changes).toHaveLength(1);
    expect(drift.changes[0].kind).toBe("remove_stale");
    expect(drift.changes[0].ref).toBe(review._ulid);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("rebuildReviewIndex (non-force) rewrites index entries from folder contents", async () => {
    const review = makeReview({ title: "Initial" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    // Tamper with the index entry to introduce drift.
    const indexPath = getReviewIndexFilePath(ctx as any);
    const tampered = await readIndexFile(indexPath);
    tampered!.reviews![0].title = "WRONG";
    await fs.writeFile(
      indexPath,
      `kynetic_reviews: "1.0"\nreviews:\n  - ${JSON.stringify(tampered!.reviews![0])}\n`,
      "utf-8",
    );

    const result = await rebuildReviewIndex(ctx as any);
    expect(result.count).toBe(1);

    const after = await readIndexFile(indexPath);
    expect(after?.reviews).toHaveLength(1);
    expect(after?.reviews?.[0].title).toBe("Initial");
    // The canonical wrapper must survive the rebuild.
    expect(after?.kynetic_reviews).toBe("1.0");
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("rebuildReviewIndex with force drops stale entries", async () => {
    const keep = makeReview({ title: "Keep" });
    const drop = makeReview({ title: "Drop" });
    await saveReviewRecord(ctx as any, { ...keep, _sourceFile: undefined });
    await saveReviewRecord(ctx as any, { ...drop, _sourceFile: undefined });

    await fs.rm(getReviewDir(ctx as any, drop._ulid), { recursive: true });

    await rebuildReviewIndex(ctx as any, { force: true });

    const indexFile = await readIndexFile(getReviewIndexFilePath(ctx as any));
    expect(indexFile?.reviews).toHaveLength(1);
    expect(indexFile?.reviews?.[0]?._ulid).toBe(keep._ulid);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("loadReviewRecords raises partial_entity_storage_layout when folder declared but monolithic ULIDs remain", async () => {
    // Pre-existing monolithic entry without a matching review folder.
    const monolithicPath = path.join(kspecDir, "project.reviews.yaml");
    await fs.writeFile(
      monolithicPath,
      [
        'kynetic_reviews: "1.0"',
        "reviews:",
        "  - _ulid: 01ABCDEFGHJKMNPQRSTVWXYZAA",
        "    slugs: [legacy]",
        "    title: Legacy Inline Review",
        "    lifecycle_state: draft",
        "    subject:",
        "      type: code",
        "      base_commit: aaaa1111",
        "      head_commit: bbbb2222",
        "    author: '@tester'",
        "    related_refs: []",
        "    threads: []",
        "    checks: []",
        "    verdicts: []",
        "    events: []",
        "    notes: []",
        "    external_links: []",
        "    examined_commit: null",
        "    created_at: 2026-05-23T10:00:00Z",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(loadReviewRecords(ctx as any)).rejects.toMatchObject({
      code: "partial_entity_storage_layout",
      domain: "reviews",
    });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("manager-driven loads on missing-format manifests are blocked with missing_review_folder_storage", async () => {
    // Force folder routing with a manifest that lacks any review_storage
    // declaration on kynetic 1.2 — requireReviewFolderStorage must surface
    // missing_review_folder_storage instead of dual-reading.
    const brokenCtx = {
      specDir: kspecDir,
      manifest: {
        kynetic: "1.2",
        // Routing key still points us into the folder manager so we exercise
        // the strict gate, but the underlying format declaration is absent.
        review_storage: { format: "folder" as const },
      },
    };
    // Drop review_storage on the actual gate path by importing the manager
    // directly with a manifest that has the wrong declared format.
    const wrongFormatCtx = {
      ...brokenCtx,
      manifest: { ...brokenCtx.manifest, review_storage: { format: "monolithic" as any } },
    };
    const { loadReviewRecordsFromFolders } = await import(
      "../src/parser/review-storage-manager.js"
    );
    await expect(loadReviewRecordsFromFolders(wrongFormatCtx as any)).rejects.toMatchObject({
      code: "missing_review_folder_storage",
      domain: "reviews",
    });
  });

  it("listing returns reviews assembled from per-review folders", async () => {
    const a = makeReview({ title: "Review A" });
    const b = makeReview({ title: "Review B" });
    const c = makeReview({ title: "Review C" });

    await saveReviewRecord(ctx as any, { ...a, _sourceFile: undefined });
    await saveReviewRecord(ctx as any, { ...b, _sourceFile: undefined });
    await saveReviewRecord(ctx as any, { ...c, _sourceFile: undefined });

    const loaded = await loadReviewRecords(ctx as any);
    expect(loaded).toHaveLength(3);
    const titlesByUlid = new Map(loaded.map((r) => [r._ulid, r.title]));
    expect(titlesByUlid.get(a._ulid)).toBe("Review A");
    expect(titlesByUlid.get(b._ulid)).toBe("Review B");
    expect(titlesByUlid.get(c._ulid)).toBe("Review C");
  });
});
