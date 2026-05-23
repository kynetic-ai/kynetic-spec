/**
 * Unit tests for the entity storage compatibility gates (kynetic 1.2
 * folder-backed plan, review, and entity-scoped local resource storage).
 *
 * Covers:
 *   - manifest-level gate (legacy vs missing folder declarations)
 *   - partial-layout detection
 *   - lenient vs strict gate flavors
 *   - the error type guard and deterministic code set
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestSchema, type Manifest } from "../src/schema/index.js";
import {
  DETERMINISTIC_ENTITY_STORAGE_INCOMPATIBILITY_CODES,
  EntityStorageCompatibilityError,
  LEGACY_PLAN_STORAGE_REMOVED_CODE,
  LEGACY_REVIEW_STORAGE_REMOVED_CODE,
  MISSING_PLAN_FOLDER_STORAGE_CODE,
  MISSING_REVIEW_FOLDER_STORAGE_CODE,
  PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
  assertPlanStorageCompatible,
  assertResourceStorageCompatible,
  assertReviewStorageCompatible,
  buildManifestStorageReport,
  describeLenientManifestIncompatibility,
  describeStrictManifestIncompatibility,
  detectPartialLayoutForDomain,
  isDeterministicEntityStorageIncompatibility,
  requirePlanFolderStorage,
  requireResourceFolderStorage,
  requireReviewFolderStorage,
} from "../src/parser/entity-storage-compatibility.js";
import type { KspecContext } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return ManifestSchema.parse({
    kynetic: "1.2",
    project: { name: "test", version: "0.1.0", status: "draft" },
    plan_storage: { format: "folder" },
    review_storage: { format: "folder" },
    resource_storage: { format: "entity_scoped" },
    ...overrides,
  });
}

function makeContext(specDir: string, manifest: Manifest | null): KspecContext {
  return {
    rootDir: path.dirname(specDir),
    projectRoot: path.dirname(specDir),
    specDir,
    sessionsDir: path.join(path.dirname(specDir), ".kspec-sessions"),
    manifestPath: path.join(specDir, "kynetic.yaml"),
    manifest,
    shadow: null,
    // Minimal config to satisfy the type — the gate does not consult it.
    config: {
      shadow: {
        enabled: true,
        branch: "kspec-meta",
        directory: ".kspec",
        remote: { type: "none", value: null },
      },
      dispatch: {
        worktree_root: ".kspec-worktrees",
        active_concurrency_target: 1,
        idle_keepalive_minutes: 0,
        per_task_timeout_minutes: 60,
        per_task_budget: 5,
      },
    } as KspecContext["config"],
  };
}

describe("EntityStorageCompatibilityError", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("carries code, domain, suggestion, field, and cacheDomain", () => {
    const err = new EntityStorageCompatibilityError("nope", {
      code: LEGACY_PLAN_STORAGE_REMOVED_CODE,
      domain: "plans",
      suggestion: "kspec upgrade",
      field: "plan_storage.format",
    });
    expect(err.code).toBe(LEGACY_PLAN_STORAGE_REMOVED_CODE);
    expect(err.domain).toBe("plans");
    expect(err.suggestion).toBe("kspec upgrade");
    expect(err.field).toBe("plan_storage.format");
    expect(err.cacheDomain).toBe("plans");
  });

  it("allows cacheDomain to be overridden explicitly", () => {
    const err = new EntityStorageCompatibilityError("nope", {
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "resources",
      cacheDomain: "plans",
    });
    expect(err.cacheDomain).toBe("plans");
  });
});

describe("isDeterministicEntityStorageIncompatibility", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("returns true for any of the listed deterministic codes", () => {
    for (const code of [
      LEGACY_PLAN_STORAGE_REMOVED_CODE,
      LEGACY_REVIEW_STORAGE_REMOVED_CODE,
      MISSING_PLAN_FOLDER_STORAGE_CODE,
      MISSING_REVIEW_FOLDER_STORAGE_CODE,
      PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
    ]) {
      const err = new EntityStorageCompatibilityError("x", { code, domain: "plans" });
      expect(isDeterministicEntityStorageIncompatibility(err)).toBe(true);
    }
  });

  it("returns false for unknown codes, plain errors, and non-errors", () => {
    expect(
      isDeterministicEntityStorageIncompatibility(
        new EntityStorageCompatibilityError("x", { code: "made_up", domain: "plans" }),
      ),
    ).toBe(false);
    expect(isDeterministicEntityStorageIncompatibility(new Error("boom"))).toBe(false);
    expect(isDeterministicEntityStorageIncompatibility("nope")).toBe(false);
    expect(isDeterministicEntityStorageIncompatibility(null)).toBe(false);
    expect(isDeterministicEntityStorageIncompatibility(undefined)).toBe(false);
  });

  it("exposes the canonical set of deterministic codes", () => {
    expect([...DETERMINISTIC_ENTITY_STORAGE_INCOMPATIBILITY_CODES].sort()).toEqual(
      [
        LEGACY_PLAN_STORAGE_REMOVED_CODE,
        LEGACY_REVIEW_STORAGE_REMOVED_CODE,
        MISSING_PLAN_FOLDER_STORAGE_CODE,
        MISSING_REVIEW_FOLDER_STORAGE_CODE,
        PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      ].sort(),
    );
  });
});

describe("describeStrictManifestIncompatibility — plans", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("passes when manifest declares plan_storage.format = folder", () => {
    expect(describeStrictManifestIncompatibility(makeManifest(), "plans")).toBeNull();
  });

  it("returns legacy_plan_storage_removed for kynetic < 1.2 without folder", () => {
    const m = makeManifest({ kynetic: "1.1", plan_storage: undefined });
    const err = describeStrictManifestIncompatibility(m, "plans")!;
    expect(err).not.toBeNull();
    expect(err.code).toBe(LEGACY_PLAN_STORAGE_REMOVED_CODE);
    expect(err.domain).toBe("plans");
    expect(err.field).toBe("plan_storage.format");
    expect(err.suggestion).toMatch(/kspec upgrade/);
  });

  it("returns missing_plan_folder_storage for kynetic >= 1.2 without folder", () => {
    const m = makeManifest({ plan_storage: { format: "monolithic" } });
    const err = describeStrictManifestIncompatibility(m, "plans")!;
    expect(err.code).toBe(MISSING_PLAN_FOLDER_STORAGE_CODE);
    expect(err.domain).toBe("plans");
    expect(err.field).toBe("plan_storage.format");
  });
});

describe("describeStrictManifestIncompatibility — reviews", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("returns legacy_review_storage_removed for kynetic < 1.2 without folder", () => {
    const m = makeManifest({ kynetic: "1.0", review_storage: undefined });
    const err = describeStrictManifestIncompatibility(m, "reviews")!;
    expect(err.code).toBe(LEGACY_REVIEW_STORAGE_REMOVED_CODE);
    expect(err.domain).toBe("reviews");
    expect(err.field).toBe("review_storage.format");
  });

  it("returns missing_review_folder_storage for kynetic >= 1.2 without folder", () => {
    const m = makeManifest({ review_storage: { format: "monolithic" } });
    const err = describeStrictManifestIncompatibility(m, "reviews")!;
    expect(err.code).toBe(MISSING_REVIEW_FOLDER_STORAGE_CODE);
  });
});

describe("describeStrictManifestIncompatibility — resources", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("passes when resource_storage.format = entity_scoped", () => {
    expect(describeStrictManifestIncompatibility(makeManifest(), "resources")).toBeNull();
  });

  it("uses entity_scoped as the required folder format", () => {
    const m = makeManifest({ resource_storage: { format: "monolithic" } });
    const err = describeStrictManifestIncompatibility(m, "resources")!;
    expect(err.domain).toBe("resources");
    expect(err.field).toBe("resource_storage.format");
    expect(err.message).toMatch(/entity_scoped/);
  });
});

describe("describeLenientManifestIncompatibility", () => {
  // The lenient gate preserves backward compatibility for legacy projects
  // (kynetic < 1.2 without storage declarations) so existing routes that
  // still read monolithic data do not fail until the project upgrades.

  it("passes on legacy projects without storage declarations (plans)", () => {
    const m = makeManifest({ kynetic: "1.1", plan_storage: undefined });
    expect(describeLenientManifestIncompatibility(m, "plans")).toBeNull();
  });

  it("passes on legacy projects without storage declarations (reviews)", () => {
    const m = makeManifest({ kynetic: "1.0", review_storage: undefined });
    expect(describeLenientManifestIncompatibility(m, "reviews")).toBeNull();
  });

  it("passes when folder/entity_scoped is declared", () => {
    expect(describeLenientManifestIncompatibility(makeManifest(), "plans")).toBeNull();
    expect(describeLenientManifestIncompatibility(makeManifest(), "reviews")).toBeNull();
    expect(describeLenientManifestIncompatibility(makeManifest(), "resources")).toBeNull();
  });

  it("rejects 1.2 projects that did not declare plan_storage", () => {
    const m = makeManifest({ plan_storage: undefined });
    const err = describeLenientManifestIncompatibility(m, "plans")!;
    expect(err.code).toBe(MISSING_PLAN_FOLDER_STORAGE_CODE);
  });

  it("rejects manifests that declare an unsupported non-folder format on any project", () => {
    const m = makeManifest({ kynetic: "1.1", plan_storage: { format: "monolithic" } });
    const err = describeLenientManifestIncompatibility(m, "plans")!;
    expect(err.code).toBe(MISSING_PLAN_FOLDER_STORAGE_CODE);
    expect(err.message).toMatch(/monolithic/);
  });
});

describe("buildManifestStorageReport", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("reports current declarations and per-domain strict/lenient incompatibilities", () => {
    const report = buildManifestStorageReport(makeManifest({ kynetic: "1.1" }));
    expect(report.kynetic).toBe("1.1");
    expect(report.planFormat).toBe("folder");
    expect(report.reviewFormat).toBe("folder");
    expect(report.resourceFormat).toBe("entity_scoped");
    // Lenient passes because declarations match folder requirements
    expect(report.lenientPlanIncompatibility).toBeNull();
    expect(report.lenientReviewIncompatibility).toBeNull();
    expect(report.lenientResourceIncompatibility).toBeNull();
    // Strict also passes because declarations match
    expect(report.strictPlanIncompatibility).toBeNull();
    expect(report.strictReviewIncompatibility).toBeNull();
    expect(report.strictResourceIncompatibility).toBeNull();
  });

  it("surfaces strict incompatibilities for a legacy project", () => {
    const m = makeManifest({
      kynetic: "1.0",
      plan_storage: undefined,
      review_storage: undefined,
      resource_storage: undefined,
    });
    const report = buildManifestStorageReport(m);
    expect(report.strictPlanIncompatibility?.code).toBe(LEGACY_PLAN_STORAGE_REMOVED_CODE);
    expect(report.strictReviewIncompatibility?.code).toBe(LEGACY_REVIEW_STORAGE_REMOVED_CODE);
    expect(report.strictResourceIncompatibility?.code).toBe(LEGACY_PLAN_STORAGE_REMOVED_CODE);
    // Lenient mode passes for a legacy project (no declarations)
    expect(report.lenientPlanIncompatibility).toBeNull();
    expect(report.lenientReviewIncompatibility).toBeNull();
    expect(report.lenientResourceIncompatibility).toBeNull();
  });
});

describe("detectPartialLayoutForDomain", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-entity-storage-partial-");
    specDir = path.join(tempDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("returns partial_entity_storage_layout when folder declared but monolithic plans still exist", async () => {
    await fs.writeFile(
      path.join(specDir, "project.plans.yaml"),
      "kynetic_plans: '1.0'\nplans:\n  - _ulid: 01ABCDEFGHJKMNPQRSTUVWXYZ\n    slugs: []\n    title: Stale\n    content: ''\n    status: draft\n    derived_tasks: []\n    derived_specs: []\n    source_path: null\n    created_at: '2026-01-01T00:00:00Z'\n",
    );
    const ctx = makeContext(specDir, makeManifest());
    const err = await detectPartialLayoutForDomain(ctx, "plans");
    expect(err).not.toBeNull();
    expect(err!.code).toBe(PARTIAL_ENTITY_STORAGE_LAYOUT_CODE);
    expect(err!.domain).toBe("plans");
    expect(err!.message).toMatch(/monolithic/);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("returns partial_entity_storage_layout when folder declared but monolithic reviews still exist", async () => {
    await fs.writeFile(
      path.join(specDir, "project.reviews.yaml"),
      `kynetic_reviews: "1.0"
reviews:
  - _ulid: 01ABCDEFGHJKMNPQRSTUVWXYZ
    slugs: []
    title: Stale Review
    lifecycle_state: open
    subject:
      type: task
      ref: "@something"
      shadow_commit: "abc1234"
      content_hash: "h"
    author: "x@y"
    related_refs: []
    threads: []
    checks: []
    verdicts: []
    events: []
    notes: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`,
    );
    const ctx = makeContext(specDir, makeManifest());
    const err = await detectPartialLayoutForDomain(ctx, "reviews");
    expect(err).not.toBeNull();
    expect(err!.code).toBe(PARTIAL_ENTITY_STORAGE_LAYOUT_CODE);
    expect(err!.domain).toBe("reviews");
  });

  it("returns null when folder declared and no monolithic data remains", async () => {
    const ctx = makeContext(specDir, makeManifest());
    expect(await detectPartialLayoutForDomain(ctx, "plans")).toBeNull();
    expect(await detectPartialLayoutForDomain(ctx, "reviews")).toBeNull();
  });

  it("returns null when manifest does not declare folder storage (lenient)", async () => {
    // Even if a monolithic file is present, partial detection is silent when
    // the manifest does not declare folder format — the layout is "all
    // legacy", not partial.
    await fs.writeFile(
      path.join(specDir, "project.plans.yaml"),
      "plans:\n  - _ulid: 01ABCDEFGHJKMNPQRSTUVWXYZ\n    title: Anything\n",
    );
    const ctx = makeContext(
      specDir,
      makeManifest({ kynetic: "1.1", plan_storage: undefined }),
    );
    expect(await detectPartialLayoutForDomain(ctx, "plans")).toBeNull();
  });
});

describe("assertPlanStorageCompatible / assertReviewStorageCompatible / assertResourceStorageCompatible", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-entity-storage-assert-");
    specDir = path.join(tempDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("lenient assertPlanStorageCompatible passes on legacy projects without plan_storage", async () => {
    const ctx = makeContext(
      specDir,
      makeManifest({ kynetic: "1.0", plan_storage: undefined }),
    );
    await expect(assertPlanStorageCompatible(ctx)).resolves.toBeUndefined();
  });

  it("lenient assertPlanStorageCompatible throws missing_plan_folder_storage on 1.2 without declaration", async () => {
    const ctx = makeContext(specDir, makeManifest({ plan_storage: undefined }));
    await expect(assertPlanStorageCompatible(ctx)).rejects.toMatchObject({
      code: MISSING_PLAN_FOLDER_STORAGE_CODE,
      domain: "plans",
    });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("assertPlanStorageCompatible throws partial_entity_storage_layout when monolithic plans remain alongside a folder declaration", async () => {
    await fs.writeFile(
      path.join(specDir, "project.plans.yaml"),
      "plans:\n  - _ulid: 01ABCDEFGHJKMNPQRSTUVWXYZ\n    title: Stale\n",
    );
    const ctx = makeContext(specDir, makeManifest());
    await expect(assertPlanStorageCompatible(ctx)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "plans",
    });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("assertPlanStorageCompatible passes on a clean folder-declared layout (no monolithic plans)", async () => {
    const ctx = makeContext(specDir, makeManifest());
    await expect(assertPlanStorageCompatible(ctx)).resolves.toBeUndefined();
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("assertReviewStorageCompatible throws partial_entity_storage_layout when monolithic reviews remain alongside a folder declaration", async () => {
    await fs.writeFile(
      path.join(specDir, "project.reviews.yaml"),
      `kynetic_reviews: "1.0"
reviews:
  - _ulid: 01ABCDEFGHJKMNPQRSTUVWXYZ
    slugs: []
    title: Stale Review
    lifecycle_state: open
    subject:
      type: task
      ref: "@something"
      shadow_commit: "abc1234"
      content_hash: "h"
    author: "x@y"
    related_refs: []
    threads: []
    checks: []
    verdicts: []
    events: []
    notes: []
    created_at: "2026-01-01T00:00:00Z"
    updated_at: "2026-01-01T00:00:00Z"
`,
    );
    const ctx = makeContext(specDir, makeManifest());
    await expect(assertReviewStorageCompatible(ctx)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "reviews",
    });
  });

  it("assertReviewStorageCompatible passes on legacy projects without review_storage", async () => {
    const ctx = makeContext(
      specDir,
      makeManifest({ kynetic: "1.1", review_storage: undefined }),
    );
    await expect(assertReviewStorageCompatible(ctx)).resolves.toBeUndefined();
  });

  it("assertResourceStorageCompatible passes on legacy projects without resource_storage", async () => {
    const ctx = makeContext(
      specDir,
      makeManifest({ kynetic: "1.0", resource_storage: undefined }),
    );
    await expect(assertResourceStorageCompatible(ctx)).resolves.toBeUndefined();
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // Resources have no monolithic-vs-folder distinction at the manifest level
  // for partial detection — they ride along with their owning entity's
  // directory. The lenient gate only checks the manifest declaration.
  it("assertResourceStorageCompatible does not raise partial_entity_storage_layout (no monolithic resource file exists)", async () => {
    const ctx = makeContext(specDir, makeManifest());
    await expect(assertResourceStorageCompatible(ctx)).resolves.toBeUndefined();
  });
});

describe("requirePlanFolderStorage / requireReviewFolderStorage / requireResourceFolderStorage", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-entity-storage-strict-");
    specDir = path.join(tempDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  it("strict gate rejects legacy plan projects with legacy_plan_storage_removed", async () => {
    const ctx = makeContext(
      specDir,
      makeManifest({ kynetic: "1.0", plan_storage: undefined }),
    );
    await expect(requirePlanFolderStorage(ctx)).rejects.toMatchObject({
      code: LEGACY_PLAN_STORAGE_REMOVED_CODE,
      domain: "plans",
    });
  });

  it("strict gate rejects 1.2 plan projects without folder with missing_plan_folder_storage", async () => {
    const ctx = makeContext(specDir, makeManifest({ plan_storage: { format: "monolithic" } }));
    await expect(requirePlanFolderStorage(ctx)).rejects.toMatchObject({
      code: MISSING_PLAN_FOLDER_STORAGE_CODE,
      domain: "plans",
    });
  });

  it("strict gate rejects legacy review projects with legacy_review_storage_removed", async () => {
    const ctx = makeContext(
      specDir,
      makeManifest({ kynetic: "1.1", review_storage: undefined }),
    );
    await expect(requireReviewFolderStorage(ctx)).rejects.toMatchObject({
      code: LEGACY_REVIEW_STORAGE_REMOVED_CODE,
      domain: "reviews",
    });
  });

  it("strict gate rejects 1.2 review projects without folder with missing_review_folder_storage", async () => {
    const ctx = makeContext(specDir, makeManifest({ review_storage: { format: "monolithic" } }));
    await expect(requireReviewFolderStorage(ctx)).rejects.toMatchObject({
      code: MISSING_REVIEW_FOLDER_STORAGE_CODE,
      domain: "reviews",
    });
  });

  it("strict gate rejects legacy resource projects with legacy_plan_storage_removed code (canonical set)", async () => {
    const ctx = makeContext(
      specDir,
      makeManifest({ kynetic: "1.0", resource_storage: undefined }),
    );
    await expect(requireResourceFolderStorage(ctx)).rejects.toMatchObject({
      code: LEGACY_PLAN_STORAGE_REMOVED_CODE,
      domain: "resources",
    });
  });

  it("strict gate passes when all storage declarations are folder/entity_scoped", async () => {
    const ctx = makeContext(specDir, makeManifest());
    await expect(requirePlanFolderStorage(ctx)).resolves.toBeUndefined();
    await expect(requireReviewFolderStorage(ctx)).resolves.toBeUndefined();
    await expect(requireResourceFolderStorage(ctx)).resolves.toBeUndefined();
  });
});

describe("Manifest schema acceptance of 1.2 storage declarations", () => {
  // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
  it("parses kynetic 1.2 with all four storage declarations", () => {
    const parsed = ManifestSchema.parse({
      kynetic: "1.2",
      project: { name: "test", version: "0.1.0", status: "draft" },
      task_storage: { format: "split" },
      plan_storage: { format: "folder" },
      review_storage: { format: "folder" },
      resource_storage: { format: "entity_scoped" },
    });
    expect(parsed.kynetic).toBe("1.2");
    expect(parsed.task_storage?.format).toBe("split");
    expect(parsed.plan_storage?.format).toBe("folder");
    expect(parsed.review_storage?.format).toBe("folder");
    expect(parsed.resource_storage?.format).toBe("entity_scoped");
  });

  it("rejects unrecognized storage format values", () => {
    expect(() =>
      ManifestSchema.parse({
        kynetic: "1.2",
        project: { name: "test", version: "0.1.0", status: "draft" },
        plan_storage: { format: "garbage" },
      }),
    ).toThrow();
  });
});
