/**
 * Tests for review-storage folder migration.
 *
 * Mirrors the plan-migration test suite: dry-run preview, executing
 * writes, partial-layout refusal, identity/unknown-field preservation,
 * and the same temp-dir isolation safeguard.
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import {
  applyReviewMigration,
  computeReviewMigrationReport,
} from "../src/parser/review-folder-migration.js";
import {
  REVIEW_DETAIL_FILENAME,
  REVIEW_RESOURCES_MANIFEST_FILENAME,
} from "../src/parser/review-storage-manager.js";
import { toYaml, type KspecContext } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir, readTestOutput, testUlid } from "./helpers/cli.js";

async function buildCtx(
  tempDir: string,
  manifestOverrides: Record<string, unknown> = {},
): Promise<KspecContext> {
  const specDir = path.join(tempDir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  const manifest = {
    kynetic: "1.1",
    project: { name: "review-migration-test", version: "0.1.0" },
    task_storage: { format: "split" },
    ...manifestOverrides,
  } as Record<string, unknown>;
  const manifestPath = path.join(specDir, "kynetic.yaml");
  await fs.writeFile(manifestPath, toYaml(manifest), "utf-8");
  return {
    rootDir: tempDir,
    projectRoot: tempDir,
    specDir,
    sessionsDir: path.join(tempDir, ".kspec-sessions"),
    manifestPath,
    manifest,
    shadow: null,
    config: {} as unknown,
  } as unknown as KspecContext;
}

async function writeMonolithicReviews(
  ctx: KspecContext,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  await fs.writeFile(
    path.join(ctx.specDir, "project.reviews.yaml"),
    toYaml({ kynetic_reviews: "1.0", reviews: records }),
    "utf-8",
  );
}

/**
 * Build a minimal but schema-valid review record. The migration's
 * record-preservation contract applies to any record (valid or not),
 * but tests that assert on the *projected* index entry need a record
 * the schema can parse so disposition + counts come out correctly.
 */
function buildValidReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _ulid: testUlid("REVL"),
    slugs: [],
    title: "Valid Review",
    lifecycle_state: "open",
    subject: {
      type: "task",
      ref: "@task-ref",
      shadow_commit: "shadow-commit-sha",
      content_hash: "content-hash",
    },
    author: "reviewer",
    related_refs: [],
    threads: [],
    checks: [],
    verdicts: [],
    events: [],
    notes: [],
    external_links: [],
    examined_commit: null,
    created_at: "2026-05-22T10:00:00Z",
    ...overrides,
  };
}

function assertTempDirIsolation(dir: string): void {
  const real = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  expect(real.startsWith(tmp + path.sep)).toBe(true);
  expect(real.startsWith(path.resolve("/home/chapel/Projects/kynetic-spec"))).toBe(false);
  expect(real.startsWith(path.resolve("/home/chapel/Projects/kynetic-spec-dispatch"))).toBe(false);
}

describe("review folder migration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-review-migration-");
    assertTempDirIsolation(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("reports alreadyMigrated when no monolithic file exists", async () => {
    const ctx = await buildCtx(tempDir);
    const report = await computeReviewMigrationReport(ctx);
    expect(report.alreadyMigrated).toBe(true);
    expect(report.entries).toEqual([]);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("produces a dry-run report without writing any files", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("REV1");
    await writeMonolithicReviews(ctx, [
      buildValidReview({
        _ulid: ulid,
        title: "Dry Run Review",
        slugs: ["dry-run-review"],
        threads: [
          {
            _ulid: testUlid("TH1"),
            kind: "blocker",
            entries: [
              {
                _ulid: testUlid("ENT1"),
                author: "reviewer",
                body: "Please address",
                created_at: "2026-05-22T10:00:00Z",
              },
            ],
          },
        ],
      }),
    ]);

    const report = await computeReviewMigrationReport(ctx);
    expect(report.alreadyMigrated).toBe(false);
    expect(report.migrated).toBe(1);
    expect(report.entries[0]).toMatchObject({
      ulid,
      title: "Dry Run Review",
      preexistingFolder: false,
    });

    const reviewDir = path.join(ctx.specDir, "reviews", ulid);
    await expect(fs.access(reviewDir)).rejects.toThrow();
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  it("writes review.yaml, resources.yaml, and a lean index entry per review", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("REV2");
    const threadUlid = testUlid("TH2");
    await writeMonolithicReviews(ctx, [
      buildValidReview({
        _ulid: ulid,
        slugs: ["exec-review"],
        title: "Exec Review",
        lifecycle_state: "open",
        threads: [
          {
            _ulid: threadUlid,
            kind: "blocker",
            entries: [
              {
                _ulid: testUlid("ENT2"),
                author: "reviewer",
                body: "Please fix X",
                created_at: "2026-05-22T10:00:00Z",
              },
            ],
          },
        ],
        external_links: [{ url: "https://example.com/pr/1", label: "PR" }],
        examined_commit: "abc123",
      }),
    ]);

    const report = await computeReviewMigrationReport(ctx);
    const applied = await applyReviewMigration(ctx, report);
    expect(applied.written).toBe(1);

    const reviewDir = path.join(ctx.specDir, "reviews", ulid);
    const detail = yamlParse(
      await readTestOutput(path.join(reviewDir, REVIEW_DETAIL_FILENAME)),
    );
    expect(detail._ulid).toBe(ulid);
    expect(detail.title).toBe("Exec Review");
    expect(detail.examined_commit).toBe("abc123");
    expect(Array.isArray(detail.threads)).toBe(true);
    expect(detail.threads).toHaveLength(1);
    expect(detail.threads[0]._ulid).toBe(threadUlid);

    const resourcesManifest = yamlParse(
      await readTestOutput(path.join(reviewDir, REVIEW_RESOURCES_MANIFEST_FILENAME)),
    );
    expect(resourcesManifest).toEqual({ resources: [] });

    const index = yamlParse(
      await readTestOutput(path.join(ctx.specDir, "project.reviews.yaml")),
    );
    expect(index.kynetic_reviews).toBe("1.0");
    expect(index.reviews).toHaveLength(1);
    const entry = index.reviews[0];
    expect(entry._ulid).toBe(ulid);
    expect(entry.title).toBe("Exec Review");
    expect(entry.lifecycle_state).toBe("open");
    expect(entry.thread_count).toBe(1);
    expect(entry.unresolved_blocker_count).toBe(1);
    expect(entry.external_links).toEqual([{ url: "https://example.com/pr/1", label: "PR" }]);
    expect(entry.examined_commit).toBe("abc123");
    // Lean projection — never carries the full threads array.
    expect(entry.threads).toBeUndefined();
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  it("preserves unknown fields on migrated reviews", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("REV3");
    await writeMonolithicReviews(ctx, [
      buildValidReview({
        _ulid: ulid,
        title: "With Extension",
        threads: [],
        // Unknown extension that must survive migration.
        custom_review_metadata: { source: "ci" },
      }),
    ]);

    const report = await computeReviewMigrationReport(ctx);
    await applyReviewMigration(ctx, report);

    const detail = yamlParse(
      await readTestOutput(
        path.join(ctx.specDir, "reviews", ulid, REVIEW_DETAIL_FILENAME),
      ),
    );
    expect(detail.custom_review_metadata).toEqual({ source: "ci" });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  it("preserves invalid-but-not-fatal records with a validation warning", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("REV4");
    // Missing required `subject` field — schema rejects, raw payload still
    // migrates with a warning.
    await writeMonolithicReviews(ctx, [
      {
        _ulid: ulid,
        slugs: ["broken-review"],
        title: "Broken",
        lifecycle_state: "draft",
        author: "reviewer",
        threads: [{ _ulid: testUlid("THBR"), kind: "blocker", entries: [] }],
        created_at: "2026-05-22T10:00:00Z",
      },
    ]);

    const report = await computeReviewMigrationReport(ctx);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].validationWarning).toContain("validation warning");

    await applyReviewMigration(ctx, report);
    const detail = yamlParse(
      await readTestOutput(
        path.join(ctx.specDir, "reviews", ulid, REVIEW_DETAIL_FILENAME),
      ),
    );
    expect(detail._ulid).toBe(ulid);
    expect(detail.slugs).toEqual(["broken-review"]);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("refuses to execute when folders + monolithic records coexist without force", async () => {
    const ctx = await buildCtx(tempDir);
    const existingFolderUlid = testUlid("RVEX");
    const monolithicUlid = testUlid("RVML");

    const existingDir = path.join(ctx.specDir, "reviews", existingFolderUlid);
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(
      path.join(existingDir, REVIEW_DETAIL_FILENAME),
      toYaml(buildValidReview({ _ulid: existingFolderUlid, title: "Existing" })),
      "utf-8",
    );

    await writeMonolithicReviews(ctx, [
      buildValidReview({
        _ulid: monolithicUlid,
        title: "Monolithic",
        threads: [
          {
            _ulid: testUlid("TH3"),
            kind: "blocker",
            entries: [
              {
                _ulid: testUlid("ENT3"),
                author: "reviewer",
                body: "x",
                created_at: "2026-05-22T10:00:00Z",
              },
            ],
          },
        ],
      }),
    ]);

    const report = await computeReviewMigrationReport(ctx);
    expect(report.partialLayout).toBe(true);
    await expect(applyReviewMigration(ctx, report)).rejects.toThrow(/partial/i);

    const forcedReport = await computeReviewMigrationReport(ctx);
    const applied = await applyReviewMigration(ctx, forcedReport, { force: true });
    expect(applied.written).toBe(1);
  });
});
