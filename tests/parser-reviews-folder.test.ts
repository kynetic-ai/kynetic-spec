/**
 * Folder-backed review storage manager unit tests.
 *
 * Covers @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive,
 * ac-review-index-has-bounded-projection, ac-review-delete-removes-owned-folder,
 * plus the @trait-folder-backed-entity-1 unknown-file preservation and
 * @trait-entity-scoped-local-resources-1 owned-resource cleanup AC the spec
 * inherits.
 *
 * The UI/static export AC ac-review-screenshot-resource-loads-in-ui is owned
 * by @task-review-screenshot-resource-ui, which exercises the review-scoped
 * resource API routes, web UI rendering, and static export asset copying.
 * This storage-manager task only proves that declared screenshot resources
 * can be discovered and resolved at the parser/data layer, which contributes
 * to the trait ACs annotated on the screenshot test below.
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
  testUlid,
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
    expect(detail).toBeDefined();
    if (!detail) throw new Error("Expected review detail to be written");
    expect(detail?._ulid).toBe(review._ulid);
    expect(detail?.title).toBe("Cohesive Review");
    expect(Array.isArray(detail?.threads)).toBe(true);
    expect((detail.threads as unknown[]).length).toBe(1);
    expect(Array.isArray(detail?.checks)).toBe(true);
    expect((detail.checks as unknown[]).length).toBe(1);
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

    const updated = await mutateReviewAtomically(
      ctx as any,
      { ...review, _sourceFile: undefined },
      (latest) => ({
        ...latest,
        title: "Updated Title",
        lifecycle_state: "open" as const,
        updated_at: "2026-05-23T12:00:00Z",
      }),
    );

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
    const { loadReviewRecordsFromFolders } =
      await import("../src/parser/review-storage-manager.js");
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

  // AC: @review-spec-ac-anchors ac-legacy-anchors-load
  it("loads legacy loose structured AC anchors from folder storage unchanged", async () => {
    const reviewUlid = testUlid("REV", 20);
    const threadUlid = testUlid("THR", 20);
    const entryUlid = testUlid("ENT", 20);
    const seedReview = makeReview({
      _ulid: reviewUlid,
      title: "Legacy Folder Structured AC Anchor",
      slugs: ["legacy-folder-structured-ac-anchor"],
      subject: {
        type: "spec",
        ref: "@legacy-spec",
        shadow_commit: "abc123",
        content_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    });
    await saveReviewRecord(ctx as any, { ...seedReview, _sourceFile: undefined });

    const reviewDir = getReviewDir(ctx as any, reviewUlid);
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(
      getReviewDetailFilePath(ctx as any, reviewUlid),
      `_ulid: ${reviewUlid}
slugs:
  - legacy-folder-structured-ac-anchor
title: Legacy Folder Structured AC Anchor
lifecycle_state: open
subject:
  type: spec
  ref: "@legacy-spec"
  shadow_commit: abc123
  content_hash: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
author: "@reviewer"
related_refs: []
threads:
  - _ulid: ${threadUlid}
    kind: nit
    anchor:
      type: structured
      ref: "@legacy-spec"
      section: acceptance_criteria
      field: ac-legacy-load
    entries:
      - _ulid: ${entryUlid}
        author: "@reviewer"
        body: Legacy loose folder AC anchor.
        created_at: "2026-06-18T00:00:00.000Z"
checks: []
verdicts: []
events: []
notes: []
external_links: []
examined_commit:
created_at: "2026-06-18T00:00:00.000Z"
`,
    );

    const loaded = await loadReviewRecords(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].threads[0].anchor).toEqual({
      type: "structured",
      ref: "@legacy-spec",
      section: "acceptance_criteria",
      field: "ac-legacy-load",
    });
  });

  // ── Index Consistency After Normal Mutations ─────────────────────────────
  //
  // Every normal mutator path is expected to leave the bounded index in sync
  // with the per-review folder. Rebuild-index is a recovery tool, not the
  // expected follow-up after normal commands. These tests pin that invariant
  // by running computeReviewIndexDrift() immediately after a mutation and
  // asserting zero drift without first running repair.
  //
  // AC: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder
  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection

  // AC: @trait-folder-backed-entity-1 ac-index-entry-created-with-folder
  it("saveReviewRecord leaves the index in sync with the new review folder (no drift)", async () => {
    const review = makeReview({ title: "Fresh Review", slugs: ["fresh-review"] });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.changes).toEqual([]);
    expect(drift.conflicts).toEqual([]);
    expect(drift.folders).toBe(1);
    expect(drift.indexEntries).toBe(1);
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("mutateReviewAtomically adding a thread refreshes thread_count without leaving the index stale", async () => {
    const review = makeReview({ title: "Add Thread" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    await mutateReviewAtomically(ctx as any, { ...review, _sourceFile: undefined }, (latest) => ({
      ...latest,
      threads: [
        ...latest.threads,
        {
          // 26-char Crockford base32 (no I, L, O, U).
          _ulid: "01THRDCNSST000000000000AAA",
          kind: "blocker" as const,
          entries: [
            {
              _ulid: "01THRDCNSSTENTRY000000AAAA",
              created_at: "2026-05-23T11:00:00Z",
              author: "@reviewer",
              body: "Blocker thread",
            },
          ],
        },
      ],
    }));

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.changes).toEqual([]);
    expect(drift.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("mutateReviewAtomically adding a check refreshes check_count without leaving the index stale", async () => {
    const review = makeReview({ title: "Add Check" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    await mutateReviewAtomically(ctx as any, { ...review, _sourceFile: undefined }, (latest) => ({
      ...latest,
      checks: [
        ...latest.checks,
        {
          name: "lint",
          status: "pass" as const,
          required: true,
          applies_to_version: {
            type: "code_compare" as const,
            base_commit: "aaaa1111",
            head_commit: "bbbb2222",
          },
          created_at: "2026-05-23T11:00:00Z",
        },
      ],
    }));

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.changes).toEqual([]);
    expect(drift.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("mutateReviewAtomically adding a verdict refreshes verdict_count and disposition without leaving the index stale", async () => {
    const review = makeReview({ title: "Add Verdict" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    await mutateReviewAtomically(ctx as any, { ...review, _sourceFile: undefined }, (latest) => ({
      ...latest,
      verdicts: [
        ...latest.verdicts,
        {
          reviewer: "@reviewer",
          role: "reviewer",
          decision: "approve" as const,
          applies_to_version: {
            type: "code_compare" as const,
            base_commit: "aaaa1111",
            head_commit: "bbbb2222",
          },
          created_at: "2026-05-23T11:00:00Z",
        },
      ],
    }));

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.changes).toEqual([]);
    expect(drift.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  it("mutateReviewAtomically transitioning lifecycle_state (close) keeps the index in sync", async () => {
    const review = makeReview({ title: "Close Review" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    await mutateReviewAtomically(ctx as any, { ...review, _sourceFile: undefined }, (latest) => ({
      ...latest,
      lifecycle_state: "closed" as const,
      updated_at: "2026-05-23T12:00:00Z",
    }));

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.changes).toEqual([]);
    expect(drift.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  // The review resource manager (addReviewResource) writes resources.yaml
  // and routes back through saveReviewRecordToFolder so the lean index's
  // resource_summary updates in the same logical mutation. End-to-end
  // resource add/replace/remove invariants are exercised by the
  // review-resource-cli integration suite which drives the public CLI.
  it("addReviewResource keeps the lean index in sync with the new resource_summary", async () => {
    const resourceCtx = makeCtx(kspecDir, true);
    const review = makeReview({ title: "Resource API" });
    await saveReviewRecord(resourceCtx as any, { ...review, _sourceFile: undefined });

    const baseline = await computeReviewIndexDrift(resourceCtx as any);
    expect(baseline.changes).toEqual([]);

    // Stage a source file outside the review folder — addReviewResource
    // copies bytes into the review's resources/ tree.
    const stagingDir = path.join(tempDir, "review-resource-staging");
    await fs.mkdir(stagingDir, { recursive: true });
    const sourceFile = path.join(stagingDir, "shot.png");
    await fs.writeFile(sourceFile, "PNG_BYTES", "utf-8");

    const { addReviewResource } = await import("../src/parser/review-resource-manager.js");
    const result = await addReviewResource(resourceCtx as any, review._ulid, {
      id: "shot",
      relativePath: "shot.png",
      sourceFile,
      label: "Screenshot",
      captureGit: false,
    });
    expect(result.ok).toBe(true);

    // After the mutation, the lean index resource_summary must already
    // reflect the new resource — no rebuild-index repair needed.
    const drift = await computeReviewIndexDrift(resourceCtx as any);
    expect(drift.conflicts).toEqual([]);
    expect(drift.changes).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  // The detail file's external_links: [] and an index entry that omits the
  // external_links field are semantically equivalent — both mean "no
  // external links." Drift detection must treat them as equal so a clean
  // post-repair state stays clean across a second dry-run rebuild.
  it("no drift when the detail file has external_links: [] and the index omits external_links", async () => {
    const review = makeReview({ title: "Defaults Omitted" });
    // Default external_links is [], so saveReviewRecord writes the
    // detail file with external_links: [] and omits the field from the
    // index entry. The drift detector must treat that pair as equal.
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    const drift = await computeReviewIndexDrift(ctx as any);
    expect(drift.changes).toEqual([]);
    expect(drift.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  // An index entry persisted with external_links: [] and a detail file
  // whose default is also [] must not surface drift — the projection
  // omits empty arrays but the stored entry may carry an explicit `[]`
  // (older serializer or a hand edit) and the two forms are semantically
  // equivalent. After repair, dry-run must continue to read as clean.
  it("repair converges when the index entry persists external_links: [] alongside an empty detail array", async () => {
    const review = makeReview({ title: "Defaults Explicit" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    // Manually rewrite the index entry to include external_links: [].
    // Older serializers (or hand edits) may have done so even though the
    // detail file's empty array is the canonical representation.
    const indexPath = getReviewIndexFilePath(ctx as any);
    const indexFile = await readIndexFile(indexPath);
    expect(indexFile?.reviews).toHaveLength(1);
    indexFile!.reviews![0].external_links = [];
    await fs.writeFile(
      indexPath,
      [
        'kynetic_reviews: "1.0"',
        "reviews:",
        `  - ${JSON.stringify(indexFile!.reviews![0])}`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const before = await computeReviewIndexDrift(ctx as any);
    // Semantic-defaults: external_links: [] in the index entry and []
    // (or omitted) in the detail file mean the same thing; drift must
    // not surface this as an update.
    expect(before.changes).toEqual([]);
    expect(before.conflicts).toEqual([]);

    // Even if repair runs, the post-repair index must continue to read
    // as clean on a follow-up dry-run rebuild.
    await rebuildReviewIndex(ctx as any);
    const after = await computeReviewIndexDrift(ctx as any);
    expect(after.changes).toEqual([]);
    expect(after.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  // After repair has rewritten the index, a subsequent dry-run rebuild must
  // report no changes. This proves the projection used at write time is the
  // same as the projection used at drift time — no spurious update churn.
  it("rebuild-index converges: after repair, a subsequent dry-run reports no changes", async () => {
    const review = makeReview({ title: "Converge Review" });
    await saveReviewRecord(ctx as any, { ...review, _sourceFile: undefined });

    // Introduce drift by tampering with the index entry.
    const indexPath = getReviewIndexFilePath(ctx as any);
    const indexFile = await readIndexFile(indexPath);
    indexFile!.reviews![0].title = "WRONG";
    await fs.writeFile(
      indexPath,
      [
        'kynetic_reviews: "1.0"',
        "reviews:",
        `  - ${JSON.stringify(indexFile!.reviews![0])}`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const before = await computeReviewIndexDrift(ctx as any);
    expect(before.changes.some((c) => c.kind === "update")).toBe(true);

    await rebuildReviewIndex(ctx as any);

    const after = await computeReviewIndexDrift(ctx as any);
    expect(after.changes).toEqual([]);
    expect(after.conflicts).toEqual([]);
  });
});
