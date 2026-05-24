/**
 * Tests for the plan/review folder-storage migration steps wired into
 * `kspec upgrade`. Covers the dry-run preview, the executing run that
 * writes folders + lean indexes + manifest fields, the previous-shadow
 * commit reporting, and isolation safeguards (the temp dir must live
 * under the OS tempdir prefix; tests refuse to touch the live repos).
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 *       @single-command-version-upgrade
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecJson,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";

interface UpgradeStep {
  name: string;
  status: "done" | "skipped" | "failed";
  message: string;
  details?: Record<string, unknown>;
}

interface UpgradeResultShape {
  success: boolean;
  source_version: string | null;
  target_version: string;
  confidence: string;
  is_refresh: boolean;
  noop: boolean;
  steps: UpgradeStep[];
  follow_ups: string[];
  previous_shadow_commit: string | null;
  dry_run?: boolean;
}

/**
 * Initialise a kspec project + downgrade the manifest to a pre-1.2 state
 * so the upgrade pipeline actually exercises the plan/review folder
 * migration paths (a fresh `kspec init` already produces a kynetic 1.2
 * manifest with folder declarations, which would short-circuit the new
 * pipeline steps).
 */
async function initProject(tempDir: string): Promise<{ specDir: string; manifestPath: string }> {
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
  execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: "pipe" });
  const result = kspec("init --no-prompt --setup", tempDir);
  if (result.exitCode !== 0) {
    throw new Error(`kspec init failed: ${result.stderr}`);
  }

  const specDir = path.join(tempDir, ".kspec");
  // Mark this project as a downstream of an older kspec so the pipeline
  // doesn't short-circuit on the idempotent-when-current path.
  const statePath = path.join(specDir, ".setup-state.json");
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(await readTestOutput(statePath));
  } catch {
    state = {};
  }
  state.lastKnownVersion = "0.9.0";
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");

  const specFiles = await fs.readdir(specDir);
  const manifestName = specFiles.find(
    (f) =>
      f.endsWith(".yaml") &&
      !f.endsWith(".tasks.yaml") &&
      !f.endsWith(".inbox.yaml") &&
      !f.endsWith(".meta.yaml") &&
      !f.startsWith("."),
  );
  if (!manifestName) throw new Error("manifest not found after kspec init");
  const manifestPath = path.join(specDir, manifestName);

  // Downgrade the manifest to kynetic 1.1 with monolithic plan/review
  // declarations so the upgrade pipeline exercises the migration path.
  await rewriteManifest(manifestPath, {
    kynetic: "1.1",
    task_storage: { format: "split" },
    plan_storage: undefined,
    review_storage: undefined,
    resource_storage: undefined,
  });

  return { specDir, manifestPath };
}

/** Replace the manifest with explicit storage declarations for the test. */
async function rewriteManifest(
  manifestPath: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const raw = await readTestOutput(manifestPath);
  const manifest = yamlParse(raw) as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete manifest[key];
    } else {
      manifest[key] = value;
    }
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  // Re-write as YAML so the parser handles it.
  const yamlMod = await import("yaml");
  await fs.writeFile(manifestPath, yamlMod.stringify(manifest), "utf-8");
}

/** Write a monolithic plans file with the given records. */
async function writeMonolithicPlans(
  specDir: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const yamlMod = await import("yaml");
  await fs.writeFile(
    path.join(specDir, "project.plans.yaml"),
    yamlMod.stringify({ kynetic_plans: "1.0", plans: records }),
    "utf-8",
  );
}

/** Write a monolithic reviews file with the given records. */
async function writeMonolithicReviews(
  specDir: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const yamlMod = await import("yaml");
  await fs.writeFile(
    path.join(specDir, "project.reviews.yaml"),
    yamlMod.stringify({ kynetic_reviews: "1.0", reviews: records }),
    "utf-8",
  );
}

function assertTempDirIsolation(dir: string): void {
  const real = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  expect(real.startsWith(tmp + path.sep)).toBe(true);
  expect(real.startsWith(path.resolve("/home/chapel/Projects/kynetic-spec"))).toBe(false);
  expect(real.startsWith(path.resolve("/home/chapel/Projects/kynetic-spec-dispatch"))).toBe(false);
}

describe("kspec upgrade — folder storage migration", () => {
  let tempDir: string;
  let planUlid: string;
  let reviewUlid: string;
  let threadUlid: string;
  let entryUlid: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-upgrade-folder-");
    assertTempDirIsolation(tempDir);
    planUlid = testUlid("PLAN");
    reviewUlid = testUlid("REV");
    threadUlid = testUlid("THRD");
    entryUlid = testUlid("ENTR");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("dry-run previews plan + review migration without writing", async () => {
    const { specDir } = await initProject(tempDir);

    await writeMonolithicPlans(specDir, [
      {
        _ulid: planUlid,
        slugs: ["preview-plan"],
        title: "Preview Plan",
        content: "Body",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);
    await writeMonolithicReviews(specDir, [
      {
        _ulid: reviewUlid,
        slugs: ["preview-review"],
        title: "Preview Review",
        author: "reviewer",
        subject: {
          type: "task",
          ref: "@some-task",
          shadow_commit: "abc",
          content_hash: "h",
        },
        lifecycle_state: "open",
        related_refs: [],
        threads: [
          {
            _ulid: threadUlid,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlid,
                author: "reviewer",
                body: "Address",
                created_at: "2026-05-22T10:00:00Z",
              },
            ],
          },
        ],
        checks: [],
        verdicts: [],
        events: [],
        notes: [],
        external_links: [],
        examined_commit: null,
        created_at: "2026-05-22T10:00:00Z",
      },
    ]);

    const result = kspecJson<UpgradeResultShape>("upgrade --dry-run", tempDir);
    expect(result.dry_run).toBe(true);
    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    const manifestStep = result.steps.find((s) => s.name === "Storage manifest (kynetic 1.2)");
    expect(planStep?.status).toBe("done");
    expect(planStep?.message).toMatch(/would migrate/i);
    expect(reviewStep?.status).toBe("done");
    expect(reviewStep?.message).toMatch(/would migrate/i);
    expect(manifestStep?.status).toBe("done");
    expect(manifestStep?.message).toMatch(/would set/i);

    // No folders written, no manifest mutation.
    await expect(fs.access(path.join(specDir, "plans", planUlid))).rejects.toThrow();
    await expect(fs.access(path.join(specDir, "reviews", reviewUlid))).rejects.toThrow();
    const indexExists = await fs.access(path.join(specDir, "project.plans.yaml")).then(
      () => true,
      () => false,
    );
    expect(indexExists).toBe(true); // the monolithic file is still there
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
  it("upgrade migrates plans + reviews and promotes the manifest to kynetic 1.2", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);

    await writeMonolithicPlans(specDir, [
      {
        _ulid: planUlid,
        slugs: ["exec-plan"],
        title: "Exec Plan",
        content: "# Plan\nBody",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);
    await writeMonolithicReviews(specDir, [
      {
        _ulid: reviewUlid,
        slugs: ["exec-review"],
        title: "Exec Review",
        author: "reviewer",
        subject: {
          type: "task",
          ref: "@some-task",
          shadow_commit: "abc",
          content_hash: "h",
        },
        lifecycle_state: "open",
        related_refs: [],
        threads: [],
        checks: [],
        verdicts: [],
        events: [],
        notes: [],
        external_links: [],
        examined_commit: null,
        created_at: "2026-05-22T10:00:00Z",
      },
    ]);

    const result = kspecJson<UpgradeResultShape>("upgrade", tempDir);
    expect(result.success).toBe(true);

    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    const manifestStep = result.steps.find((s) => s.name === "Storage manifest (kynetic 1.2)");
    expect(planStep?.status).toBe("done");
    expect(planStep?.details?.migrated).toBe(1);
    expect(reviewStep?.status).toBe("done");
    expect(reviewStep?.details?.migrated).toBe(1);
    expect(manifestStep?.status).toBe("done");

    // Folder layout exists.
    const planCore = yamlParse(
      await readTestOutput(path.join(specDir, "plans", planUlid, "plan.yaml")),
    );
    expect(planCore._ulid).toBe(planUlid);
    const planMd = await readTestOutput(path.join(specDir, "plans", planUlid, "plan.md"));
    expect(planMd).toBe("# Plan\nBody");
    const reviewDetail = yamlParse(
      await readTestOutput(path.join(specDir, "reviews", reviewUlid, "review.yaml")),
    );
    expect(reviewDetail._ulid).toBe(reviewUlid);

    // Lean indexes exist.
    const planIndex = yamlParse(
      await readTestOutput(path.join(specDir, "project.plans.yaml")),
    );
    expect(planIndex.plans[0]._ulid).toBe(planUlid);
    expect(planIndex.plans[0].content).toBeUndefined();
    const reviewIndex = yamlParse(
      await readTestOutput(path.join(specDir, "project.reviews.yaml")),
    );
    expect(reviewIndex.reviews[0]._ulid).toBe(reviewUlid);
    expect(reviewIndex.reviews[0].threads).toBeUndefined();

    // Manifest promoted to kynetic 1.2 with all storage declarations.
    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.2");
    expect((manifest.plan_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifest.review_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifest.resource_storage as Record<string, unknown>).format).toBe(
      "entity_scoped",
    );
    expect((manifest.task_storage as Record<string, unknown>).format).toBe("split");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("reports previous_shadow_commit when shadow worktree is configured", async () => {
    await initProject(tempDir);
    const result = kspecJson<UpgradeResultShape>("upgrade --dry-run", tempDir);
    expect(typeof result.previous_shadow_commit === "string" || result.previous_shadow_commit === null).toBe(
      true,
    );
    // After kspec init the shadow branch is created, so we should have a commit.
    expect(result.previous_shadow_commit).toMatch(/^[0-9a-f]{7,}$/);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("manifest step promotes to kynetic 1.2 even when no monolithic records exist", async () => {
    // Fresh init -> manifest is downgraded by initProject to 1.1 with no
    // plan/review/resource declarations. Empty plan/review files simulate a
    // project that's already migrated except for the manifest declarations.
    const { specDir, manifestPath } = await initProject(tempDir);
    await writeMonolithicPlans(specDir, []);
    await writeMonolithicReviews(specDir, []);

    const result = kspecJson<UpgradeResultShape>("upgrade", tempDir);
    expect(result.success).toBe(true);
    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    const manifestStep = result.steps.find((s) => s.name === "Storage manifest (kynetic 1.2)");
    // No monolithic records → migration steps skip cleanly.
    expect(planStep?.status).toBe("skipped");
    expect(reviewStep?.status).toBe("skipped");
    // Manifest was at 1.1 → step promotes to 1.2.
    expect(manifestStep?.status).toBe("done");

    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.2");
    expect((manifest.plan_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifest.review_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifest.resource_storage as Record<string, unknown>).format).toBe(
      "entity_scoped",
    );
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("dry-run reports warnings for plans with missing _ulid", async () => {
    const { specDir } = await initProject(tempDir);
    await writeMonolithicPlans(specDir, [
      {
        slugs: ["missing-id"],
        title: "No ID",
        content: "Body",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);

    const result = kspecJson<UpgradeResultShape>("upgrade --dry-run", tempDir);
    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    expect(planStep?.status).toBe("done");
    expect(Array.isArray(planStep?.details?.warnings)).toBe(true);
    expect((planStep!.details!.warnings as string[]).length).toBeGreaterThan(0);
  });

  // Regression: a normal `kspec upgrade` against a partial PLAN layout must
  // fail the plan migration step, leave the manifest at 1.1, and NOT rewrite
  // the index. Prior to the fix the upgrade integration hardcoded
  // `applyPlanMigration(..., { force: true })`, which silently bypassed the
  // partial-layout guard and could drop pre-existing folder plans from the
  // rewritten index.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("upgrade without --force fails when plan layout is partial", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const existingFolderUlid = testUlid("EXPLN");
    const monolithicUlid = testUlid("MOPLN");

    // Pre-existing folder + matching lean index entry, plus a separate
    // monolithic record — the classic partial-layout shape.
    const existingDir = path.join(specDir, "plans", existingFolderUlid);
    await fs.mkdir(existingDir, { recursive: true });
    const yamlMod = await import("yaml");
    await fs.writeFile(
      path.join(existingDir, "plan.yaml"),
      yamlMod.stringify({
        _ulid: existingFolderUlid,
        slugs: ["existing"],
        title: "Existing Folder Plan",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(existingDir, "plan.md"), "Body", "utf-8");
    await fs.writeFile(
      path.join(existingDir, "resources.yaml"),
      yamlMod.stringify({ resources: [] }),
      "utf-8",
    );

    await writeMonolithicPlans(specDir, [
      {
        _ulid: existingFolderUlid,
        slugs: ["existing"],
        title: "Existing Folder Plan",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes_count: 0,
      },
      {
        _ulid: monolithicUlid,
        slugs: ["mono"],
        title: "Monolithic Plan",
        content: "# Mono\nBody",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T11:00:00Z",
        notes: [],
      },
    ]);

    const cliResult = kspec("upgrade --json", tempDir, { expectFail: true });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    expect(planStep?.status).toBe("failed");
    expect(planStep?.message).toMatch(/partial/i);

    // Manifest stays at 1.1 — no half-promotion.
    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.1");
    expect(manifest.plan_storage).toBeUndefined();

    // Pre-existing folder is still on disk AND the lean index entry is still
    // present — the failed step did not rewrite the index.
    const indexAfter = yamlParse(
      await readTestOutput(path.join(specDir, "project.plans.yaml")),
    ) as { plans: Array<{ _ulid: string }> };
    const ulidsAfter = new Set(indexAfter.plans.map((p) => p._ulid));
    expect(ulidsAfter.has(existingFolderUlid)).toBe(true);
  });

  // Regression: a normal `kspec upgrade` against a partial REVIEW layout must
  // also fail (same bypass existed for the review migration step). The
  // structured error must include the partial-layout code so callers can
  // recognise it.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("upgrade without --force fails when review layout is partial", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const existingFolderUlid = testUlid("EXRV");
    const monolithicUlid = testUlid("MORV");
    const threadUlid2 = testUlid("THR5");
    const entryUlid2 = testUlid("ENT5");

    const existingDir = path.join(specDir, "reviews", existingFolderUlid);
    await fs.mkdir(existingDir, { recursive: true });
    const yamlMod = await import("yaml");
    const validReview = {
      _ulid: existingFolderUlid,
      slugs: [],
      title: "Existing Folder Review",
      lifecycle_state: "open",
      subject: {
        type: "task",
        ref: "@task-ref",
        shadow_commit: "sha",
        content_hash: "h",
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
    };
    await fs.writeFile(
      path.join(existingDir, "review.yaml"),
      yamlMod.stringify(validReview),
      "utf-8",
    );
    await fs.writeFile(
      path.join(existingDir, "resources.yaml"),
      yamlMod.stringify({ resources: [] }),
      "utf-8",
    );

    await writeMonolithicReviews(specDir, [
      {
        _ulid: existingFolderUlid,
        slugs: [],
        title: "Existing Folder Review",
        lifecycle_state: "open",
        subject: {
          type: "task",
          ref: "@task-ref",
          shadow_commit: "sha",
          content_hash: "h",
        },
        author: "reviewer",
        related_refs: [],
        disposition: "pending",
        thread_count: 0,
        unresolved_blocker_count: 0,
        check_count: 0,
        verdict_count: 0,
        created_at: "2026-05-22T10:00:00Z",
      },
      {
        _ulid: monolithicUlid,
        slugs: [],
        title: "Monolithic Review",
        lifecycle_state: "open",
        subject: {
          type: "task",
          ref: "@some-task",
          shadow_commit: "abc",
          content_hash: "h",
        },
        author: "reviewer",
        related_refs: [],
        threads: [
          {
            _ulid: threadUlid2,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlid2,
                author: "reviewer",
                body: "blocker",
                created_at: "2026-05-22T10:00:00Z",
              },
            ],
          },
        ],
        checks: [],
        verdicts: [],
        events: [],
        notes: [],
        external_links: [],
        examined_commit: null,
        created_at: "2026-05-22T11:00:00Z",
      },
    ]);

    const cliResult = kspec("upgrade --json", tempDir, { expectFail: true });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    expect(reviewStep?.status).toBe("failed");
    expect(reviewStep?.message).toMatch(/partial/i);

    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.1");
    expect(manifest.review_storage).toBeUndefined();
  });

  // Regression: `kspec upgrade --force` against a partial PLAN layout must
  // succeed AND preserve any pre-existing lean index entries. The bug being
  // guarded against rewrote the index using only the migrated monolithic
  // entry, silently dropping folder-backed plans from list/get even though
  // the folders remained on disk.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("upgrade --force migrates partial plan layout while preserving existing folder plans", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const existingFolderUlid = testUlid("FRPLN");
    const monolithicUlid = testUlid("FRMOL");

    const existingDir = path.join(specDir, "plans", existingFolderUlid);
    await fs.mkdir(existingDir, { recursive: true });
    const yamlMod = await import("yaml");
    await fs.writeFile(
      path.join(existingDir, "plan.yaml"),
      yamlMod.stringify({
        _ulid: existingFolderUlid,
        slugs: ["existing"],
        title: "Existing Folder Plan",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(existingDir, "plan.md"), "Body", "utf-8");
    await fs.writeFile(
      path.join(existingDir, "resources.yaml"),
      yamlMod.stringify({ resources: [] }),
      "utf-8",
    );

    await writeMonolithicPlans(specDir, [
      {
        _ulid: existingFolderUlid,
        slugs: ["existing"],
        title: "Existing Folder Plan",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes_count: 0,
      },
      {
        _ulid: monolithicUlid,
        slugs: ["mono"],
        title: "Monolithic Plan",
        content: "# Mono\nBody",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T11:00:00Z",
        notes: [],
      },
    ]);

    const result = kspecJson<UpgradeResultShape>("upgrade --force", tempDir);
    expect(result.success).toBe(true);

    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    expect(planStep?.status).toBe("done");
    expect(planStep?.details?.migrated).toBe(1);
    expect(planStep?.details?.index_entries).toBe(2);

    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.2");

    const index = yamlParse(
      await readTestOutput(path.join(specDir, "project.plans.yaml")),
    ) as { plans: Array<{ _ulid: string }> };
    const ulids = new Set(index.plans.map((p) => p._ulid));
    expect(ulids.has(existingFolderUlid)).toBe(true);
    expect(ulids.has(monolithicUlid)).toBe(true);
    expect(index.plans.length).toBe(2);

    // Existing folder contents untouched.
    const existingPlan = yamlParse(
      await readTestOutput(path.join(existingDir, "plan.yaml")),
    ) as Record<string, unknown>;
    expect(existingPlan.title).toBe("Existing Folder Plan");
  });

  // Regression: same shape as the plan test but for the review migration —
  // proves the review upgrade integration honours --force AND preserves
  // pre-existing lean index entries.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("upgrade --force migrates partial review layout while preserving existing folder reviews", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const existingFolderUlid = testUlid("FRRV");
    const monolithicUlid = testUlid("FMORV");
    const threadUlid3 = testUlid("THR6");
    const entryUlid3 = testUlid("ENT6");

    const existingDir = path.join(specDir, "reviews", existingFolderUlid);
    await fs.mkdir(existingDir, { recursive: true });
    const yamlMod = await import("yaml");
    const validReview = {
      _ulid: existingFolderUlid,
      slugs: [],
      title: "Existing Folder Review",
      lifecycle_state: "open",
      subject: {
        type: "task",
        ref: "@task-ref",
        shadow_commit: "sha",
        content_hash: "h",
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
    };
    await fs.writeFile(
      path.join(existingDir, "review.yaml"),
      yamlMod.stringify(validReview),
      "utf-8",
    );
    await fs.writeFile(
      path.join(existingDir, "resources.yaml"),
      yamlMod.stringify({ resources: [] }),
      "utf-8",
    );

    await writeMonolithicReviews(specDir, [
      {
        _ulid: existingFolderUlid,
        slugs: [],
        title: "Existing Folder Review",
        lifecycle_state: "open",
        subject: {
          type: "task",
          ref: "@task-ref",
          shadow_commit: "sha",
          content_hash: "h",
        },
        author: "reviewer",
        related_refs: [],
        disposition: "pending",
        thread_count: 0,
        unresolved_blocker_count: 0,
        check_count: 0,
        verdict_count: 0,
        created_at: "2026-05-22T10:00:00Z",
      },
      {
        _ulid: monolithicUlid,
        slugs: [],
        title: "Monolithic Review",
        lifecycle_state: "open",
        subject: {
          type: "task",
          ref: "@some-task",
          shadow_commit: "abc",
          content_hash: "h",
        },
        author: "reviewer",
        related_refs: [],
        threads: [
          {
            _ulid: threadUlid3,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlid3,
                author: "reviewer",
                body: "blocker",
                created_at: "2026-05-22T10:00:00Z",
              },
            ],
          },
        ],
        checks: [],
        verdicts: [],
        events: [],
        notes: [],
        external_links: [],
        examined_commit: null,
        created_at: "2026-05-22T11:00:00Z",
      },
    ]);

    const result = kspecJson<UpgradeResultShape>("upgrade --force", tempDir);
    expect(result.success).toBe(true);

    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    expect(reviewStep?.status).toBe("done");
    expect(reviewStep?.details?.migrated).toBe(1);
    expect(reviewStep?.details?.index_entries).toBe(2);

    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.2");

    const index = yamlParse(
      await readTestOutput(path.join(specDir, "project.reviews.yaml")),
    ) as { reviews: Array<{ _ulid: string }> };
    const ulids = new Set(index.reviews.map((r) => r._ulid));
    expect(ulids.has(existingFolderUlid)).toBe(true);
    expect(ulids.has(monolithicUlid)).toBe(true);
    expect(index.reviews.length).toBe(2);
  });
});
