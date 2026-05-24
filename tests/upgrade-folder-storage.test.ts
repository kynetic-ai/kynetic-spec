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
});
