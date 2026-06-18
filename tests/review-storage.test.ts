import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createReviewRecord,
  deleteReviewRecord,
  findReviewByRef,
  getReviewsFilePath,
  loadReviewRecords,
  mutateReviewAtomically,
  saveReviewRecord,
} from "../src/parser/reviews.js";
import { ReferenceIndex } from "../src/parser/refs.js";
import type { ReviewRecordInput } from "../src/schema/index.js";
import { buildReferenceIndex, buildIndexes } from "../src/parser/yaml.js";
import type { KspecContext } from "../src/parser/yaml.js";
import {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
  testUlids,
} from "./helpers/cli.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";

ensureSplitBackendRegistered();

function makeCtx(specDir: string): KspecContext {
  return { specDir } as KspecContext;
}

function makeInput(overrides: Partial<ReviewRecordInput> = {}): ReviewRecordInput {
  return {
    title: "Test Review",
    author: "test-author",
    subject: {
      type: "code",
      base_commit: "abc123",
      head_commit: "def456",
    },
    ...overrides,
  };
}

describe("Review Record Storage and Identity", () => {
  let tempDir: string;
  let kspecDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = path.join(tempDir, ".kspec");
    await fs.mkdir(kspecDir, { recursive: true });
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // AC-1: Dedicated first-party review storage
  // ============================================================

  // AC: @review-record-storage-and-identity ac-1
  it("should store review records in dedicated first-party storage", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("REV") }));

    await saveReviewRecord(ctx, { ...review, _sourceFile: undefined });

    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]._ulid).toBe(review._ulid);
    expect(loaded[0].title).toBe("Test Review");
    expect(loaded[0].author).toBe("test-author");
    expect(loaded[0].subject.type).toBe("code");
  });

  // AC: @review-record-storage-and-identity ac-1
  it("should store reviews separately from tasks, plans, and modules", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("REV") }));
    await saveReviewRecord(ctx, { ...review });

    // Verify the file exists at the dedicated path
    const reviewsPath = getReviewsFilePath(ctx);
    const stat = await fs.stat(reviewsPath);
    expect(stat.isFile()).toBe(true);

    // Verify no reviews ended up in task or plan files
    const tasksPath = path.join(kspecDir, "project.tasks.yaml");
    const plansPath = path.join(kspecDir, "project.plans.yaml");

    await expect(fs.stat(tasksPath)).rejects.toThrow();
    await expect(fs.stat(plansPath)).rejects.toThrow();
  });

  // AC: @review-spec-ac-anchors ac-legacy-anchors-load
  it("loads legacy loose structured AC anchors from monolithic storage unchanged", async () => {
    const ctx = makeCtx(kspecDir);
    const [reviewUlid, threadUlid, entryUlid] = testUlids("REV", 3);
    await fs.writeFile(
      getReviewsFilePath(ctx),
      `kynetic_reviews: "1.0"
reviews:
  - _ulid: ${reviewUlid}
    slugs:
      - legacy-structured-ac-anchor
    title: Legacy Structured AC Anchor
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
            body: Legacy loose AC anchor.
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

    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].threads[0].anchor).toEqual({
      type: "structured",
      ref: "@legacy-spec",
      section: "acceptance_criteria",
      field: "ac-legacy-load",
    });
  });

  // AC: @review-record-storage-and-identity ac-1
  it("should persist all review record fields", async () => {
    const ctx = makeCtx(kspecDir);
    const [reviewUlid, threadUlid, entryUlid, eventUlid] = testUlids("REV", 4);

    const review = createReviewRecord(
      makeInput({
        _ulid: reviewUlid,
        slugs: ["my-code-review"],
        lifecycle_state: "open",
        related_refs: ["@some-task"],
        threads: [
          {
            _ulid: threadUlid,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlid,
                author: "reviewer",
                body: "This needs fixing",
                created_at: new Date().toISOString(),
              },
            ],
          },
        ],
        events: [
          {
            _ulid: eventUlid,
            event_type: "lifecycle_change",
            actor: "test-author",
            timestamp: new Date().toISOString(),
            payload: { from: "draft", to: "open" },
          },
        ],
        external_links: [
          {
            url: "https://github.com/org/repo/pull/42",
            provider: "github",
            external_id: "42",
          },
        ],
      }),
    );

    await saveReviewRecord(ctx, { ...review });
    const loaded = await loadReviewRecords(ctx);

    expect(loaded).toHaveLength(1);
    const r = loaded[0];
    expect(r.slugs).toEqual(["my-code-review"]);
    expect(r.lifecycle_state).toBe("open");
    expect(r.related_refs).toEqual(["@some-task"]);
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].kind).toBe("blocker");
    expect(r.threads[0].entries).toHaveLength(1);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].event_type).toBe("lifecycle_change");
    expect(r.external_links).toHaveLength(1);
    expect(r.external_links[0].provider).toBe("github");
  });

  // AC: @review-record-storage-and-identity ac-1
  it("should return empty array when no reviews file exists", async () => {
    const ctx = makeCtx(kspecDir);
    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toEqual([]);
  });

  // AC: @review-record-storage-and-identity ac-1
  it("should update an existing review record by ULID", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("REV") }));

    await saveReviewRecord(ctx, { ...review });

    // Update the review
    const updated = { ...review, title: "Updated Review Title" };
    await saveReviewRecord(ctx, updated);

    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe("Updated Review Title");
  });

  // AC: @review-record-storage-and-identity ac-1
  it("should save multiple review records", async () => {
    const ctx = makeCtx(kspecDir);
    const [ulid1, ulid2, ulid3] = testUlids("REV", 3);

    await saveReviewRecord(ctx, {
      ...createReviewRecord(makeInput({ _ulid: ulid1, title: "Review 1" })),
    });
    await saveReviewRecord(ctx, {
      ...createReviewRecord(makeInput({ _ulid: ulid2, title: "Review 2" })),
    });
    await saveReviewRecord(ctx, {
      ...createReviewRecord(makeInput({ _ulid: ulid3, title: "Review 3" })),
    });

    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toHaveLength(3);
    expect(loaded.map((r) => r.title)).toEqual(["Review 1", "Review 2", "Review 3"]);
  });

  // ============================================================
  // AC-2: ULID-backed identity and @review ref
  // ============================================================

  // AC: @review-record-storage-and-identity ac-2
  it("should assign a ULID identity to new review records", () => {
    const review = createReviewRecord(makeInput());

    expect(review._ulid).toBeDefined();
    expect(review._ulid).toHaveLength(26);
  });

  // AC: @review-record-storage-and-identity ac-2
  it("should use provided ULID when creating review records", () => {
    const customUlid = testUlid("REV");
    const review = createReviewRecord(makeInput({ _ulid: customUlid }));

    expect(review._ulid).toBe(customUlid);
  });

  // AC: @review-record-storage-and-identity ac-2
  it("should find review by full ULID ref", async () => {
    const ctx = makeCtx(kspecDir);
    const reviewUlid = testUlid("REV");
    const review = createReviewRecord(makeInput({ _ulid: reviewUlid }));
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const found = findReviewByRef(loaded, `@${reviewUlid}`);

    expect(found).toBeDefined();
    expect(found!._ulid).toBe(reviewUlid);
  });

  // AC: @review-record-storage-and-identity ac-2
  it("should find review by short ULID prefix", async () => {
    const ctx = makeCtx(kspecDir);
    const reviewUlid = testUlid("REV");
    const review = createReviewRecord(makeInput({ _ulid: reviewUlid }));
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    // Use first 8 chars as prefix
    const found = findReviewByRef(loaded, reviewUlid.slice(0, 8));

    expect(found).toBeDefined();
    expect(found!._ulid).toBe(reviewUlid);
  });

  // AC: @review-record-storage-and-identity ac-2
  it("should find review by slug ref", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(
      makeInput({
        _ulid: testUlid("REV"),
        slugs: ["my-review"],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const found = findReviewByRef(loaded, "@my-review");

    expect(found).toBeDefined();
    expect(found!.title).toBe("Test Review");
  });

  // AC: @review-record-storage-and-identity ac-2
  it("should resolve review through ReferenceIndex by ULID", async () => {
    const ctx = makeCtx(kspecDir);
    const reviewUlid = testUlid("REV");
    const review = createReviewRecord(
      makeInput({
        _ulid: reviewUlid,
        slugs: ["review-for-task-42"],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const index = new ReferenceIndex([], [], [], [], loaded);

    // Resolve by full ULID
    const byUlid = index.resolve(`@${reviewUlid}`);
    expect(byUlid.ok).toBe(true);
    if (byUlid.ok) {
      expect(byUlid.ulid).toBe(reviewUlid);
      expect(byUlid.matchType).toBe("ulid-full");
    }

    // Resolve by slug
    const bySlug = index.resolve("@review-for-task-42");
    expect(bySlug.ok).toBe(true);
    if (bySlug.ok) {
      expect(bySlug.ulid).toBe(reviewUlid);
      expect(bySlug.matchType).toBe("slug");
    }

    // Resolve by ULID prefix
    const byPrefix = index.resolve(reviewUlid.slice(0, 10));
    expect(byPrefix.ok).toBe(true);
    if (byPrefix.ok) {
      expect(byPrefix.ulid).toBe(reviewUlid);
      expect(byPrefix.matchType).toBe("ulid-prefix");
    }
  });

  // AC: @review-record-storage-and-identity ac-2
  it("should coexist with tasks and specs in the reference index", () => {
    const reviewUlid = testUlid("REV");
    const taskUlid = testUlid("TASK");

    const review = createReviewRecord(
      makeInput({
        _ulid: reviewUlid,
        slugs: ["code-review-1"],
      }),
    );

    const task = {
      _ulid: taskUlid,
      slugs: ["task-fix-bug"],
      title: "Fix Bug",
      status: "pending" as const,
      priority: 1,
      tags: [],
      depends_on: [],
      notes: [],
      created_at: new Date().toISOString(),
    };

    const index = new ReferenceIndex([task as any], [], [], [], [review as any]);

    // Both should be resolvable
    const resolvedReview = index.resolve("@code-review-1");
    expect(resolvedReview.ok).toBe(true);

    const resolvedTask = index.resolve("@task-fix-bug");
    expect(resolvedTask.ok).toBe(true);

    // Total size should include both
    expect(index.size).toBe(2);
  });

  // ============================================================
  // AC-3: Single dedicated file per project
  // ============================================================

  // AC: @review-record-storage-and-identity ac-3
  it("should use project.reviews.yaml as the dedicated file path", () => {
    const ctx = makeCtx(kspecDir);
    const reviewsPath = getReviewsFilePath(ctx);
    expect(reviewsPath).toBe(path.join(kspecDir, "project.reviews.yaml"));
  });

  // AC: @review-record-storage-and-identity ac-3
  it("should store all reviews in a single file", async () => {
    const ctx = makeCtx(kspecDir);
    const [ulid1, ulid2] = testUlids("REV", 2);

    await saveReviewRecord(ctx, { ...createReviewRecord(makeInput({ _ulid: ulid1 })) });
    await saveReviewRecord(ctx, { ...createReviewRecord(makeInput({ _ulid: ulid2 })) });

    // Read the raw file to verify structure
    const reviewsPath = getReviewsFilePath(ctx);
    const content = await readTestOutput(reviewsPath);

    // Should have the version wrapper
    expect(content).toContain("kynetic_reviews:");
    expect(content).toContain("reviews:");

    // Both records should be in the same file
    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toHaveLength(2);
    expect(loaded.every((r) => r._sourceFile === reviewsPath)).toBe(true);
  });

  // AC: @review-record-storage-and-identity ac-3
  it("should use kynetic_reviews version wrapper format", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("REV") }));
    await saveReviewRecord(ctx, { ...review });

    const reviewsPath = getReviewsFilePath(ctx);
    const content = await readTestOutput(reviewsPath);

    // Verify the file structure has the version wrapper
    expect(content).toMatch(/^kynetic_reviews:/m);
    expect(content).toMatch(/^reviews:/m);
  });

  // AC: @review-record-storage-and-identity ac-3
  it("should only touch the reviews file path on mutation", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("REV") }));

    // Record files before save
    const filesBefore = await fs.readdir(kspecDir);

    await saveReviewRecord(ctx, { ...review });

    // Check that only the reviews file was created
    const filesAfter = await fs.readdir(kspecDir);
    const newFiles = filesAfter.filter((f) => !filesBefore.includes(f));
    expect(newFiles).toEqual(["project.reviews.yaml"]);
  });

  // ============================================================
  // Additional storage operations
  // ============================================================

  it("should delete a review record", async () => {
    const ctx = makeCtx(kspecDir);
    const reviewUlid = testUlid("REV");
    const review = createReviewRecord(makeInput({ _ulid: reviewUlid }));
    await saveReviewRecord(ctx, { ...review });

    const deleted = await deleteReviewRecord(ctx, reviewUlid);
    expect(deleted).toBe(true);

    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toHaveLength(0);
  });

  it("should return false when deleting non-existent review", async () => {
    const ctx = makeCtx(kspecDir);
    const deleted = await deleteReviewRecord(ctx, testUlid("REV"));
    expect(deleted).toBe(false);
  });

  it("should mutate review atomically", async () => {
    const ctx = makeCtx(kspecDir);
    const reviewUlid = testUlid("REV");
    const review = createReviewRecord(
      makeInput({
        _ulid: reviewUlid,
        lifecycle_state: "draft",
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    const updated = await mutateReviewAtomically(ctx, loaded[0], (latest) => ({
      ...latest,
      lifecycle_state: "open",
      updated_at: new Date().toISOString(),
    }));

    expect(updated.lifecycle_state).toBe("open");
    expect(updated.updated_at).toBeDefined();

    // Verify persistence
    const reloaded = await loadReviewRecords(ctx);
    expect(reloaded[0].lifecycle_state).toBe("open");
  });

  it("should create review with default values", () => {
    const review = createReviewRecord(makeInput());

    expect(review._ulid).toHaveLength(26);
    expect(review.lifecycle_state).toBe("draft");
    expect(review.slugs).toEqual([]);
    expect(review.related_refs).toEqual([]);
    expect(review.threads).toEqual([]);
    expect(review.checks).toEqual([]);
    expect(review.verdicts).toEqual([]);
    expect(review.events).toEqual([]);
    expect(review.notes).toEqual([]);
    expect(review.external_links).toEqual([]);
    expect(review.created_at).toBeDefined();
  });

  it("should track _sourceFile on loaded review records", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("REV") }));
    await saveReviewRecord(ctx, { ...review });

    const loaded = await loadReviewRecords(ctx);
    expect(loaded[0]._sourceFile).toBe(getReviewsFilePath(ctx));
  });

  it("should strip _sourceFile metadata on save", async () => {
    const ctx = makeCtx(kspecDir);
    const review = createReviewRecord(makeInput({ _ulid: testUlid("REV") }));
    await saveReviewRecord(ctx, { ...review, _sourceFile: "/some/path" });

    const reviewsPath = getReviewsFilePath(ctx);
    const content = await readTestOutput(reviewsPath);
    expect(content).not.toContain("_sourceFile");
  });

  // ============================================================
  // AC-2: Shared entry points load reviews into ReferenceIndex
  // ============================================================

  // AC: @review-record-storage-and-identity ac-2
  it("should include reviews in buildReferenceIndex()", async () => {
    const ctx = makeCtx(kspecDir);
    ctx.rootDir = tempDir;
    ctx.projectRoot = tempDir;
    ctx.manifest = null;
    ctx.manifestPath = null;
    ctx.shadow = null;

    const reviewUlid = testUlid("BRI");
    const review = createReviewRecord(
      makeInput({
        _ulid: reviewUlid,
        slugs: ["build-ref-idx-review"],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const { index } = await buildReferenceIndex(ctx);

    // Review should be resolvable through the shared reference system
    const bySlug = index.resolve("@build-ref-idx-review");
    expect(bySlug.ok).toBe(true);
    if (bySlug.ok) {
      expect(bySlug.ulid).toBe(reviewUlid);
    }

    const byUlid = index.resolve(`@${reviewUlid}`);
    expect(byUlid.ok).toBe(true);
  });

  // AC: @review-record-storage-and-identity ac-2
  it("should include reviews in buildIndexes()", async () => {
    const ctx = makeCtx(kspecDir);
    ctx.rootDir = tempDir;
    ctx.projectRoot = tempDir;
    ctx.manifest = null;
    ctx.manifestPath = null;
    ctx.shadow = null;

    const reviewUlid = testUlid("BDX");
    const review = createReviewRecord(
      makeInput({
        _ulid: reviewUlid,
        slugs: ["build-indexes-review"],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const { refIndex } = await buildIndexes(ctx);

    const bySlug = refIndex.resolve("@build-indexes-review");
    expect(bySlug.ok).toBe(true);
    if (bySlug.ok) {
      expect(bySlug.ulid).toBe(reviewUlid);
    }
  });
});
