/**
 * Behavioral tests proving that the monolithic plan and review storage
 * managers (loadPlans / savePlan / mutatePlanAtomically / deletePlan and
 * the loadReviewRecords / saveReviewRecord / mutateReviewAtomically /
 * deleteReviewRecord siblings) fail with `partial_entity_storage_layout`
 * once a project has been promoted to folder-backed storage but still has
 * monolithic records on disk.
 *
 * The previous fix-cycle implementation called the lenient gate that only
 * inspected the manifest declaration; it allowed `project.plans.yaml` /
 * `project.reviews.yaml` reads and writes to silently dual-source data after
 * the migration boundary. This file pins the storage managers themselves
 * (not the gate function in isolation) to the AC-required behavior so a
 * regression to the lenient-only check fails the build.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManifestSchema, type Manifest } from "../src/schema/index.js";
import {
  PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
  isDeterministicEntityStorageIncompatibility,
} from "../src/parser/entity-storage-compatibility.js";
import {
  createPlan,
  deletePlan,
  loadPlans,
  mutatePlanAtomically,
  savePlan,
  type LoadedPlan,
} from "../src/parser/plans.js";
import {
  createReviewRecord,
  deleteReviewRecord,
  loadReviewRecords,
  mutateReviewAtomically,
  saveReviewRecord,
  type LoadedReviewRecord,
} from "../src/parser/reviews.js";
import type { KspecContext } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir, testUlid } from "./helpers/cli.js";

function folderDeclaredManifest(): Manifest {
  return ManifestSchema.parse({
    kynetic: "1.2",
    project: { name: "test", version: "0.1.0", status: "draft" },
    plan_storage: { format: "folder" },
    review_storage: { format: "folder" },
    resource_storage: { format: "entity_scoped" },
  });
}

function legacyManifest(): Manifest {
  return ManifestSchema.parse({
    kynetic: "1.1",
    project: { name: "test", version: "0.1.0", status: "draft" },
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

async function writeMonolithicPlan(specDir: string, ulid: string): Promise<void> {
  await fs.writeFile(
    path.join(specDir, "project.plans.yaml"),
    `kynetic_plans: "1.0"
plans:
  - _ulid: ${ulid}
    slugs: []
    title: Stale Monolithic Plan
    content: ""
    status: draft
    derived_tasks: []
    derived_specs: []
    source_path: null
    created_at: "2026-01-01T00:00:00Z"
`,
    "utf-8",
  );
}

async function writeMonolithicReview(specDir: string, ulid: string): Promise<void> {
  await fs.writeFile(
    path.join(specDir, "project.reviews.yaml"),
    `kynetic_reviews: "1.0"
reviews:
  - _ulid: ${ulid}
    slugs: []
    title: Stale Monolithic Review
    lifecycle_state: open
    subject:
      type: code
      base_commit: "abc"
      head_commit: "def"
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
    "utf-8",
  );
}

function expectPartialLayoutError(
  err: unknown,
  domain: "plans" | "reviews",
): asserts err is Error & { code: string; domain: string } {
  expect(isDeterministicEntityStorageIncompatibility(err)).toBe(true);
  const typed = err as Error & { code: string; domain: string };
  expect(typed.code).toBe(PARTIAL_ENTITY_STORAGE_LAYOUT_CODE);
  expect(typed.domain).toBe(domain);
}

describe("Plan storage manager — partial-layout rejection", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-plan-partial-mgr-");
    specDir = path.join(tempDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("loadPlans rejects with partial_entity_storage_layout when manifest declares folder but monolithic plans remain", async () => {
    await writeMonolithicPlan(specDir, testUlid("PLN"));
    const ctx = makeContext(specDir, folderDeclaredManifest());
    await expect(loadPlans(ctx)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "plans",
    });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("savePlan rejects with partial_entity_storage_layout on a partial folder layout instead of rewriting the monolithic file", async () => {
    const monolithicUlid = testUlid("PLN");
    await writeMonolithicPlan(specDir, monolithicUlid);
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const newPlan: LoadedPlan = {
      ...createPlan({ _ulid: testUlid("NEW"), title: "Net-new plan" }),
    };
    await expect(savePlan(ctx, newPlan)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "plans",
    });
    // Confirm the monolithic file was not rewritten under the new plan.
    const after = await fs.readFile(path.join(specDir, "project.plans.yaml"), "utf-8");
    expect(after).toContain(monolithicUlid);
    expect(after).not.toContain(newPlan._ulid);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("mutatePlanAtomically rejects with partial_entity_storage_layout on a partial folder layout", async () => {
    const monolithicUlid = testUlid("PLN");
    await writeMonolithicPlan(specDir, monolithicUlid);
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const targetPlan: LoadedPlan = {
      ...createPlan({ _ulid: monolithicUlid, title: "Stale Monolithic Plan" }),
    };
    let mutationCallbackInvoked = false;
    await expect(
      mutatePlanAtomically(ctx, targetPlan, (latest) => {
        mutationCallbackInvoked = true;
        return latest;
      }),
    ).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "plans",
    });
    expect(mutationCallbackInvoked).toBe(false);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("deletePlan rejects with partial_entity_storage_layout on a partial folder layout instead of mutating the monolithic file", async () => {
    const monolithicUlid = testUlid("PLN");
    await writeMonolithicPlan(specDir, monolithicUlid);
    const ctx = makeContext(specDir, folderDeclaredManifest());
    await expect(deletePlan(ctx, monolithicUlid)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "plans",
    });
    const after = await fs.readFile(path.join(specDir, "project.plans.yaml"), "utf-8");
    expect(after).toContain(monolithicUlid);
  });

  it("loadPlans passes on a legacy project (kynetic 1.1 with no plan_storage declaration) even when monolithic plans exist", async () => {
    await writeMonolithicPlan(specDir, testUlid("PLN"));
    const ctx = makeContext(specDir, legacyManifest());
    const plans = await loadPlans(ctx);
    expect(plans).toHaveLength(1);
  });

  it("loadPlans passes on a clean folder-declared project (no monolithic file present)", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const plans = await loadPlans(ctx);
    expect(plans).toEqual([]);
  });

  it("savePlan partial-layout error is a deterministic entity-storage incompatibility (suitable for daemon 409 mapping)", async () => {
    await writeMonolithicPlan(specDir, testUlid("PLN"));
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const newPlan: LoadedPlan = {
      ...createPlan({ _ulid: testUlid("NEW"), title: "Net-new plan" }),
    };
    let captured: unknown;
    try {
      await savePlan(ctx, newPlan);
    } catch (err) {
      captured = err;
    }
    expectPartialLayoutError(captured, "plans");
  });

  // ── Clean folder-declared projects route through the folder manager ───
  // A fresh kynetic 1.2 project that declares `plan_storage.format: folder`
  // routes savePlan / mutatePlanAtomically / deletePlan through the folder
  // storage manager. The dispatcher in src/parser/plans.ts switches on the
  // manifest declaration; the folder manager writes per-plan sidecars under
  // `.kspec/plans/<ulid>/` and never creates `.kspec/project.plans.yaml` as
  // a monolithic file. These behavioural tests pin that contract so a
  // regression that bypasses the dispatcher and falls back to the
  // monolithic writer fails the build.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
  it("savePlan on a clean folder-declared project writes per-plan sidecars and never creates a monolithic plans file", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const newUlid = testUlid("NEW");
    const newPlan: LoadedPlan = {
      ...createPlan({ _ulid: newUlid, title: "Net-new plan" }),
    };

    await savePlan(ctx, newPlan);

    // Folder sidecars exist.
    await fs.access(path.join(specDir, "plans", newUlid, "plan.yaml"));
    await fs.access(path.join(specDir, "plans", newUlid, "plan.md"));
    // The lean index is created (under the folder layout it is the
    // authoritative bounded projection, not a monolithic record). It must
    // not carry the full plan body.
    const indexBody = await fs.readFile(path.join(specDir, "project.plans.yaml"), "utf-8");
    expect(indexBody).toContain(newUlid);
    expect(indexBody).not.toContain("content:");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // mutatePlanAtomically requires an existing entry to update. The folder
  // manager fails at lookup when the plan folder is missing, without ever
  // creating a monolithic file.
  it("mutatePlanAtomically on a clean folder-declared project fails at lookup without creating a monolithic file", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const targetPlan: LoadedPlan = {
      ...createPlan({ _ulid: testUlid("MUT"), title: "Target plan" }),
    };
    let mutationCallbackInvoked = false;
    await expect(
      mutatePlanAtomically(ctx, targetPlan, (latest) => {
        mutationCallbackInvoked = true;
        return latest;
      }),
    ).rejects.toThrow(/Plan not found/);
    expect(mutationCallbackInvoked).toBe(false);
    await expect(fs.access(path.join(specDir, "project.plans.yaml"))).rejects.toThrow(/ENOENT/);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("deletePlan on a clean folder-declared project fails with ENOENT and creates no monolithic file", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    await expect(deletePlan(ctx, testUlid("PLN"))).rejects.toThrow(/Plan not found/);
    await expect(fs.access(path.join(specDir, "project.plans.yaml"))).rejects.toThrow(/ENOENT/);
  });
});

describe("Review storage manager — partial-layout rejection", () => {
  let tempDir: string;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-review-partial-mgr-");
    specDir = path.join(tempDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("loadReviewRecords rejects with partial_entity_storage_layout when manifest declares folder but monolithic reviews remain", async () => {
    await writeMonolithicReview(specDir, testUlid("REV"));
    const ctx = makeContext(specDir, folderDeclaredManifest());
    await expect(loadReviewRecords(ctx)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "reviews",
    });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("saveReviewRecord rejects with partial_entity_storage_layout on a partial folder layout instead of rewriting the monolithic file", async () => {
    const monolithicUlid = testUlid("REV");
    await writeMonolithicReview(specDir, monolithicUlid);
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const newReview: LoadedReviewRecord = {
      ...createReviewRecord({
        _ulid: testUlid("NEW"),
        title: "Net-new review",
        author: "x@y",
        subject: { type: "code", base_commit: "a", head_commit: "b" },
      }),
    };
    await expect(saveReviewRecord(ctx, newReview)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "reviews",
    });
    const after = await fs.readFile(path.join(specDir, "project.reviews.yaml"), "utf-8");
    expect(after).toContain(monolithicUlid);
    expect(after).not.toContain(newReview._ulid);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("mutateReviewAtomically rejects with partial_entity_storage_layout on a partial folder layout", async () => {
    const monolithicUlid = testUlid("REV");
    await writeMonolithicReview(specDir, monolithicUlid);
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const targetReview: LoadedReviewRecord = {
      ...createReviewRecord({
        _ulid: monolithicUlid,
        title: "Stale Monolithic Review",
        author: "x@y",
        subject: { type: "code", base_commit: "abc", head_commit: "def" },
      }),
    };
    let mutationCallbackInvoked = false;
    await expect(
      mutateReviewAtomically(ctx, targetReview, (latest) => {
        mutationCallbackInvoked = true;
        return latest;
      }),
    ).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "reviews",
    });
    expect(mutationCallbackInvoked).toBe(false);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("deleteReviewRecord rejects with partial_entity_storage_layout on a partial folder layout instead of mutating the monolithic file", async () => {
    const monolithicUlid = testUlid("REV");
    await writeMonolithicReview(specDir, monolithicUlid);
    const ctx = makeContext(specDir, folderDeclaredManifest());
    await expect(deleteReviewRecord(ctx, monolithicUlid)).rejects.toMatchObject({
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "reviews",
    });
    const after = await fs.readFile(path.join(specDir, "project.reviews.yaml"), "utf-8");
    expect(after).toContain(monolithicUlid);
  });

  it("loadReviewRecords passes on a legacy project (kynetic 1.1 with no review_storage declaration) even when monolithic reviews exist", async () => {
    await writeMonolithicReview(specDir, testUlid("REV"));
    const ctx = makeContext(specDir, legacyManifest());
    const reviews = await loadReviewRecords(ctx);
    expect(reviews).toHaveLength(1);
  });

  it("loadReviewRecords passes on a clean folder-declared project (no monolithic file present)", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const reviews = await loadReviewRecords(ctx);
    expect(reviews).toEqual([]);
  });

  it("saveReviewRecord partial-layout error is a deterministic entity-storage incompatibility (suitable for daemon 409 mapping)", async () => {
    await writeMonolithicReview(specDir, testUlid("REV"));
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const newReview: LoadedReviewRecord = {
      ...createReviewRecord({
        _ulid: testUlid("NEW"),
        title: "Net-new review",
        author: "x@y",
        subject: { type: "code", base_commit: "a", head_commit: "b" },
      }),
    };
    let captured: unknown;
    try {
      await saveReviewRecord(ctx, newReview);
    } catch (err) {
      captured = err;
    }
    expectPartialLayoutError(captured, "reviews");
  });

  // ── Clean folder-declared projects route through the folder manager ───
  // A fresh kynetic 1.2 project that declares `review_storage.format: folder`
  // routes saveReviewRecord / mutateReviewAtomically / deleteReviewRecord
  // through the folder storage manager. The dispatcher in
  // src/parser/reviews.ts switches on the manifest declaration; the folder
  // manager writes per-review `review.yaml` sidecars under
  // `.kspec/reviews/<ulid>/` and never creates a monolithic
  // `.kspec/project.reviews.yaml` record. These behavioural tests pin that
  // contract so a regression that bypasses the dispatcher and falls back
  // to the monolithic writer fails the build.

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // AC: @folder-backed-review-storage-1 ac-review-detail-file-is-cohesive
  it("saveReviewRecord on a clean folder-declared project writes per-review sidecars and never creates a monolithic reviews file", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const newUlid = testUlid("NEW");
    const newReview: LoadedReviewRecord = {
      ...createReviewRecord({
        _ulid: newUlid,
        title: "Net-new review",
        author: "x@y",
        subject: { type: "code", base_commit: "a", head_commit: "b" },
      }),
    };

    await saveReviewRecord(ctx, newReview);

    // Per-review cohesive detail sidecar exists.
    await fs.access(path.join(specDir, "reviews", newUlid, "review.yaml"));
    // The lean index is created under the folder layout. It must carry the
    // ULID and bounded fields, but never the full thread/check/verdict/note
    // arrays (the cohesive detail file is authoritative for those).
    const indexBody = await fs.readFile(path.join(specDir, "project.reviews.yaml"), "utf-8");
    expect(indexBody).toContain(newUlid);
    expect(indexBody).not.toContain("threads:");
    expect(indexBody).not.toContain("checks:");
    expect(indexBody).not.toContain("verdicts:");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // mutateReviewAtomically requires an existing entry to update. The folder
  // manager fails at lookup when the review folder is missing, without
  // ever creating a monolithic file.
  it("mutateReviewAtomically on a clean folder-declared project fails at lookup without creating a monolithic file", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const targetReview: LoadedReviewRecord = {
      ...createReviewRecord({
        _ulid: testUlid("MUT"),
        title: "Target review",
        author: "x@y",
        subject: { type: "code", base_commit: "abc", head_commit: "def" },
      }),
    };
    let mutationCallbackInvoked = false;
    await expect(
      mutateReviewAtomically(ctx, targetReview, (latest) => {
        mutationCallbackInvoked = true;
        return latest;
      }),
    ).rejects.toThrow(/Review not found/);
    expect(mutationCallbackInvoked).toBe(false);
    await expect(fs.access(path.join(specDir, "project.reviews.yaml"))).rejects.toThrow(/ENOENT/);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("deleteReviewRecord on a clean folder-declared project returns false and creates no monolithic file", async () => {
    const ctx = makeContext(specDir, folderDeclaredManifest());
    const result = await deleteReviewRecord(ctx, testUlid("REV"));
    expect(result).toBe(false);
    await expect(fs.access(path.join(specDir, "project.reviews.yaml"))).rejects.toThrow(/ENOENT/);
  });
});
