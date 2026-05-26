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
  status: "done" | "skipped" | "failed" | "rolled_back";
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

    // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
    // Layout contract: each migrated plan/review folder must contain its
    // sidecar manifest AND the empty resources/ subdirectory. A
    // successful migration cannot leave the resources/ dir missing —
    // downstream resource imports rely on it existing.
    const planResourcesManifest = yamlParse(
      await readTestOutput(path.join(specDir, "plans", planUlid, "resources.yaml")),
    ) as { resources: unknown[] };
    expect(planResourcesManifest.resources).toEqual([]);
    const planResourcesDirStat = await fs.stat(path.join(specDir, "plans", planUlid, "resources"));
    expect(planResourcesDirStat.isDirectory()).toBe(true);

    const reviewResourcesManifest = yamlParse(
      await readTestOutput(path.join(specDir, "reviews", reviewUlid, "resources.yaml")),
    ) as { resources: unknown[] };
    expect(reviewResourcesManifest.resources).toEqual([]);
    const reviewResourcesDirStat = await fs.stat(
      path.join(specDir, "reviews", reviewUlid, "resources"),
    );
    expect(reviewResourcesDirStat.isDirectory()).toBe(true);

    // Lean indexes exist.
    const planIndex = yamlParse(await readTestOutput(path.join(specDir, "project.plans.yaml")));
    expect(planIndex.plans[0]._ulid).toBe(planUlid);
    expect(planIndex.plans[0].content).toBeUndefined();
    const reviewIndex = yamlParse(await readTestOutput(path.join(specDir, "project.reviews.yaml")));
    expect(reviewIndex.reviews[0]._ulid).toBe(reviewUlid);
    expect(reviewIndex.reviews[0].threads).toBeUndefined();

    // Manifest promoted to kynetic 1.2 with all storage declarations.
    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.2");
    expect((manifest.plan_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifest.review_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifest.resource_storage as Record<string, unknown>).format).toBe("entity_scoped");
    expect((manifest.task_storage as Record<string, unknown>).format).toBe("split");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("reports previous_shadow_commit when shadow worktree is configured", async () => {
    await initProject(tempDir);
    const result = kspecJson<UpgradeResultShape>("upgrade --dry-run", tempDir);
    expect(
      typeof result.previous_shadow_commit === "string" || result.previous_shadow_commit === null,
    ).toBe(true);
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
    expect((manifest.resource_storage as Record<string, unknown>).format).toBe("entity_scoped");
  });

  // Regression: dry-run details must include every sidecar file the
  // executing migration would write (plan.md, plan.yaml, optional
  // notes.yaml, resources.yaml, resources/) AND the resource manifest
  // change summary. Without this disclosure the user can only see the
  // folder root + index path, leaving the rest of the layout contract
  // invisible until the executing run mutates the project.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("dry-run reports plan sidecar paths and resource manifest changes", async () => {
    const { specDir } = await initProject(tempDir);

    const planWithNotesUlid = testUlid("PNOTES");
    const planNoNotesUlid = testUlid("PBARE");
    await writeMonolithicPlans(specDir, [
      {
        _ulid: planWithNotesUlid,
        slugs: ["with-notes"],
        title: "Plan With Notes",
        content: "Body",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [{ author: "tester", body: "n1", created_at: "2026-05-22T10:00:00Z" }],
      },
      {
        _ulid: planNoNotesUlid,
        slugs: ["no-notes"],
        title: "Plan Without Notes",
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

    const entries = planStep!.details!.entries as Array<{
      ulid: string;
      plan_dir: string;
      sidecars: {
        plan_yaml: string;
        plan_md: string;
        notes_yaml: string | null;
        resources_yaml: string;
        resources_dir: string;
      };
    }>;
    expect(entries).toHaveLength(2);

    const notesEntry = entries.find((e) => e.ulid === planWithNotesUlid)!;
    expect(notesEntry.sidecars.plan_yaml).toBe(
      path.join(specDir, "plans", planWithNotesUlid, "plan.yaml"),
    );
    expect(notesEntry.sidecars.plan_md).toBe(
      path.join(specDir, "plans", planWithNotesUlid, "plan.md"),
    );
    // Notes sidecar must be reported when notes are non-empty.
    expect(notesEntry.sidecars.notes_yaml).toBe(
      path.join(specDir, "plans", planWithNotesUlid, "notes.yaml"),
    );
    expect(notesEntry.sidecars.resources_yaml).toBe(
      path.join(specDir, "plans", planWithNotesUlid, "resources.yaml"),
    );
    expect(notesEntry.sidecars.resources_dir).toBe(
      path.join(specDir, "plans", planWithNotesUlid, "resources"),
    );

    const bareEntry = entries.find((e) => e.ulid === planNoNotesUlid)!;
    // Notes sidecar must be NULL when source has no notes — the
    // executing migration skips writing notes.yaml in that case, and
    // the dry-run preview must reflect that decision.
    expect(bareEntry.sidecars.notes_yaml).toBeNull();
    expect(bareEntry.sidecars.resources_yaml).toBe(
      path.join(specDir, "plans", planNoNotesUlid, "resources.yaml"),
    );
    expect(bareEntry.sidecars.resources_dir).toBe(
      path.join(specDir, "plans", planNoNotesUlid, "resources"),
    );

    // Resource manifest changes must be summarised separately so dashboards
    // and JSON consumers do not need to walk every entry.
    const manifestChanges = planStep!.details!.resource_manifest_changes as {
      new_empty_manifests: number;
      manifest_filename: string;
      paths: string[];
    };
    expect(manifestChanges.new_empty_manifests).toBe(2);
    expect(manifestChanges.manifest_filename).toBe("resources.yaml");
    expect(manifestChanges.paths).toContain(
      path.join(specDir, "plans", planWithNotesUlid, "resources.yaml"),
    );
    expect(manifestChanges.paths).toContain(
      path.join(specDir, "plans", planNoNotesUlid, "resources.yaml"),
    );
  });

  // Same dry-run contract for the review migration — review.yaml,
  // resources.yaml, and resources/ targets plus resource manifest changes
  // must be surfaced before any write occurs.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("dry-run reports review sidecar paths and resource manifest changes", async () => {
    const { specDir } = await initProject(tempDir);
    const reviewUlid1 = testUlid("RVDR1");
    const reviewUlid2 = testUlid("RVDR2");
    const threadUlidA = testUlid("THRX");
    const entryUlidA = testUlid("ENTX");
    const threadUlidB = testUlid("THRY");
    const entryUlidB = testUlid("ENTY");

    await writeMonolithicReviews(specDir, [
      {
        _ulid: reviewUlid1,
        slugs: ["r1"],
        title: "Review 1",
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
            _ulid: threadUlidA,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlidA,
                author: "reviewer",
                body: "x",
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
      {
        _ulid: reviewUlid2,
        slugs: ["r2"],
        title: "Review 2",
        author: "reviewer",
        subject: {
          type: "task",
          ref: "@other-task",
          shadow_commit: "def",
          content_hash: "h",
        },
        lifecycle_state: "open",
        related_refs: [],
        threads: [
          {
            _ulid: threadUlidB,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlidB,
                author: "reviewer",
                body: "y",
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
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    expect(reviewStep?.status).toBe("done");

    const entries = reviewStep!.details!.entries as Array<{
      ulid: string;
      review_dir: string;
      sidecars: {
        review_yaml: string;
        resources_yaml: string;
        resources_dir: string;
      };
    }>;
    expect(entries).toHaveLength(2);

    const e1 = entries.find((e) => e.ulid === reviewUlid1)!;
    expect(e1.sidecars.review_yaml).toBe(path.join(specDir, "reviews", reviewUlid1, "review.yaml"));
    expect(e1.sidecars.resources_yaml).toBe(
      path.join(specDir, "reviews", reviewUlid1, "resources.yaml"),
    );
    expect(e1.sidecars.resources_dir).toBe(path.join(specDir, "reviews", reviewUlid1, "resources"));

    const manifestChanges = reviewStep!.details!.resource_manifest_changes as {
      new_empty_manifests: number;
      manifest_filename: string;
      paths: string[];
    };
    expect(manifestChanges.new_empty_manifests).toBe(2);
    expect(manifestChanges.manifest_filename).toBe("resources.yaml");
    expect(manifestChanges.paths).toContain(
      path.join(specDir, "reviews", reviewUlid1, "resources.yaml"),
    );
    expect(manifestChanges.paths).toContain(
      path.join(specDir, "reviews", reviewUlid2, "resources.yaml"),
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

    const index = yamlParse(await readTestOutput(path.join(specDir, "project.plans.yaml"))) as {
      plans: Array<{ _ulid: string }>;
    };
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

  // Regression: storage migration must be atomic across plan + review +
  // manifest steps. Reproduces the reviewer's scenario from fix cycle 2:
  // one valid monolithic plan plus a partial review layout (a pre-existing
  // review folder alongside a monolithic review record) — the plan migration
  // would succeed and the review migration would fail without --force.
  // The earlier non-atomic implementation committed the plan rewrite to the
  // shadow before review migration ran, leaving the project with a lean
  // project.plans.yaml + new .kspec/plans/<ulid>/ on disk while the manifest
  // stayed at kynetic 1.1 with no plan_storage. Atomic execution must roll
  // back ALL writes when any later step fails.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("upgrade rolls back plan migration when review migration fails (atomic)", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const monolithicPlanUlid = testUlid("ATPLN");
    const existingReviewFolderUlid = testUlid("ATERV");
    const monolithicReviewUlid = testUlid("ATMRV");
    const threadUlidA = testUlid("THRA");
    const entryUlidA = testUlid("ENTA");

    // Capture the contents of project.plans.yaml BEFORE the upgrade so we
    // can prove the file is byte-identical after a failed run.
    const yamlMod = await import("yaml");
    await writeMonolithicPlans(specDir, [
      {
        _ulid: monolithicPlanUlid,
        slugs: ["atomic-plan"],
        title: "Atomic Plan",
        content: "# Plan\nBody",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);
    const planFileBefore = await readTestOutput(path.join(specDir, "project.plans.yaml"));

    // Partial review layout: pre-existing folder + monolithic record. This
    // forces the review migration step to fail without --force.
    const existingReviewDir = path.join(specDir, "reviews", existingReviewFolderUlid);
    await fs.mkdir(existingReviewDir, { recursive: true });
    const existingReview = {
      _ulid: existingReviewFolderUlid,
      slugs: [],
      title: "Existing Review",
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
      path.join(existingReviewDir, "review.yaml"),
      yamlMod.stringify(existingReview),
      "utf-8",
    );
    await fs.writeFile(
      path.join(existingReviewDir, "resources.yaml"),
      yamlMod.stringify({ resources: [] }),
      "utf-8",
    );

    await writeMonolithicReviews(specDir, [
      {
        _ulid: existingReviewFolderUlid,
        slugs: [],
        title: "Existing Review",
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
        _ulid: monolithicReviewUlid,
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
            _ulid: threadUlidA,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlidA,
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
    const reviewFileBefore = await readTestOutput(path.join(specDir, "project.reviews.yaml"));

    // Run upgrade WITHOUT --force. Plan migration would succeed in
    // isolation; review migration must fail because the layout is partial.
    const cliResult = kspec("upgrade --json", tempDir, { expectFail: true });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    const manifestStep = result.steps.find((s) => s.name === "Storage manifest (kynetic 1.2)");

    // Atomic rollback contract: plan migration was collected as `done`
    // in isolation but its buffered writes were discarded when the
    // review step threw. The orchestrator MUST relabel that step as
    // `rolled_back` so JSON consumers, follow-up generators, and
    // tooling do not treat the plan rewrite as committed work.
    //
    // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
    expect(planStep?.status).toBe("rolled_back");
    expect(planStep?.message).toMatch(/rolled back/i);
    expect(reviewStep?.status).toBe("failed");
    expect(reviewStep?.message).toMatch(/partial/i);
    expect(manifestStep?.status).not.toBe("done");

    // Follow-ups must not advertise rolled-back work as completed.
    expect(result.follow_ups.some((f) => /plan storage:.*migrated/i.test(f))).toBe(false);

    // Manifest stays at 1.1 with no plan_storage declaration.
    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.1");
    expect(manifest.plan_storage).toBeUndefined();
    expect(manifest.review_storage).toBeUndefined();

    // project.plans.yaml must be byte-identical to before the run —
    // the lean index rewrite the plan migration would have done was
    // rolled back with the rest of the buffered mutation.
    const planFileAfter = await readTestOutput(path.join(specDir, "project.plans.yaml"));
    expect(planFileAfter).toBe(planFileBefore);

    // project.reviews.yaml must also be byte-identical — the review
    // step threw before it wrote anything, so nothing changed there.
    const reviewFileAfter = await readTestOutput(path.join(specDir, "project.reviews.yaml"));
    expect(reviewFileAfter).toBe(reviewFileBefore);

    // No new plan folder was created for the monolithic plan.
    await expect(fs.access(path.join(specDir, "plans", monolithicPlanUlid))).rejects.toThrow();

    // The pre-existing review folder is still on disk untouched.
    const existingPersisted = yamlParse(
      await readTestOutput(path.join(existingReviewDir, "review.yaml")),
    ) as Record<string, unknown>;
    expect(existingPersisted._ulid).toBe(existingReviewFolderUlid);
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

    const index = yamlParse(await readTestOutput(path.join(specDir, "project.reviews.yaml"))) as {
      reviews: Array<{ _ulid: string }>;
    };
    const ulids = new Set(index.reviews.map((r) => r._ulid));
    expect(ulids.has(existingFolderUlid)).toBe(true);
    expect(ulids.has(monolithicUlid)).toBe(true);
    expect(index.reviews.length).toBe(2);
  });

  // Regression for fix cycle 4 blocker 2: a stale lean plan index entry that
  // points at a missing `.kspec/plans/<ulid>/` folder is a partial layout —
  // upgrade without --force MUST fail the plan migration step and leave the
  // manifest at 1.1, otherwise `kspec plan list` will fail with
  // `partial_entity_storage_layout` immediately after upgrade returns
  // success.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("upgrade fails on stale lean plan index entry with no matching folder", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const orphanUlid = testUlid("ORPLN");

    // Lean entry exists in the index but `.kspec/plans/<ulid>/` does not.
    // Notes_count is the marker that flips isMonolithicEntry to false,
    // so the compute step classifies this as "non-monolithic" — exactly
    // the path that previously short-circuited as alreadyMigrated.
    await writeMonolithicPlans(specDir, [
      {
        _ulid: orphanUlid,
        slugs: ["orphan"],
        title: "Orphan Plan",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes_count: 0,
      },
    ]);

    const cliResult = kspec("upgrade --json", tempDir, { expectFail: true });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    expect(planStep?.status).toBe("failed");
    expect(planStep?.message).toMatch(/partial/i);

    // Manifest must stay at 1.1 — failing detection means the upgrade did
    // not promote folder-storage on top of an incoherent layout.
    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.1");
    expect(manifest.plan_storage).toBeUndefined();
  });

  // Regression for fix cycle 4 blocker 3: symmetric to the plan case — a
  // stale lean review index entry that points at a missing
  // `.kspec/reviews/<ulid>/` folder must also fail upgrade without --force
  // and leave the manifest unchanged.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("upgrade fails on stale lean review index entry with no matching folder", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const orphanUlid = testUlid("ORREV");

    await writeMonolithicReviews(specDir, [
      {
        _ulid: orphanUlid,
        slugs: ["orphan"],
        title: "Orphan Review",
        lifecycle_state: "open",
        subject: {
          type: "task",
          ref: "@some-task",
          shadow_commit: "abc",
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

  // Regression for fix cycle 4 blocker 1: a failed task storage migration
  // step must NOT permit the storage manifest promotion to land. Without
  // this gate the manifest moved to kynetic 1.2 / task_storage.format=split
  // even when the task migration above failed — a misleading state that
  // suppresses re-run of the broken step.
  //
  // The repro seeds the project with a monolithic task record so the task
  // migration step actually runs `task migrate --force` (it short-circuits
  // when there are no monolithic tasks), then replaces `.kspec/tasks` with
  // a regular file so the migration fails with ENOTDIR. We then assert the
  // manifest is left at 1.1 and the manifest promotion step is skipped.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("upgrade leaves manifest at 1.1 when task storage migration fails", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);

    // Step 1: replace .kspec/project.tasks.yaml with a monolithic record so
    // the task migration step has work to do. Without a monolithic record
    // the step short-circuits as "no monolithic tasks to migrate" and never
    // exercises the failure path.
    const monolithicTaskUlid = testUlid("BADTK");
    const yamlMod = await import("yaml");
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      yamlMod.stringify({
        kynetic_tasks: "1.0",
        tasks: [
          {
            _ulid: monolithicTaskUlid,
            slugs: ["bad-task"],
            title: "Bad Task",
            type: "task",
            status: "pending",
            priority: 4,
            created_at: "2026-05-22T10:00:00Z",
            description: "Forces task migrate to run",
            notes: [],
          },
        ],
      }),
      "utf-8",
    );

    // Step 2: replace the .kspec/tasks/ directory with a regular file so
    // `kspec task migrate --force` fails when it tries to write the new
    // per-task subdirectory.
    const tasksDir = path.join(specDir, "tasks");
    await fs.rm(tasksDir, { recursive: true, force: true });
    await fs.writeFile(tasksDir, "not a directory\n", "utf-8");

    // Step 3: seed monolithic plan + review records so the plan/review
    // steps would otherwise succeed and the manifest promotion would
    // otherwise fire (proving the gate is what holds them back).
    await writeMonolithicPlans(specDir, [
      {
        _ulid: planUlid,
        slugs: ["plan-after-task-fail"],
        title: "Plan",
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
        slugs: [],
        title: "Review",
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
            _ulid: threadUlid,
            kind: "blocker",
            entries: [
              {
                _ulid: entryUlid,
                author: "reviewer",
                body: "x",
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

    const cliResult = kspec("upgrade --json", tempDir, { expectFail: true });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    const taskStep = result.steps.find((s) => s.name === "Task storage migration");
    expect(taskStep?.status).toBe("failed");

    // Plan/review/manifest steps must be skipped — they cannot safely run
    // on top of a broken task layout. The manifest promotion in particular
    // must NOT advertise kynetic 1.2 / task_storage.format=split.
    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    const manifestStep = result.steps.find((s) => s.name === "Storage manifest (kynetic 1.2)");
    expect(planStep?.status).toBe("skipped");
    expect(reviewStep?.status).toBe("skipped");
    expect(manifestStep?.status).toBe("skipped");
    expect(manifestStep?.message).toMatch(/task storage/i);

    // Manifest on disk must be unchanged — still kynetic 1.1 with no
    // storage declarations the upgrade would have added.
    const manifest = yamlParse(await readTestOutput(manifestPath)) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.1");
    expect(manifest.plan_storage).toBeUndefined();
    expect(manifest.review_storage).toBeUndefined();
    expect(manifest.resource_storage).toBeUndefined();
  });

  // Regression for fix cycle 5 blocker: the protected-project tripwire must
  // fire for EVERY executing folder-storage upgrade path, not just the apply
  // calls inside plan/review migration steps. The reviewer's repro: a project
  // with no monolithic plan/review records (plan + review both short-circuit
  // as `alreadyMigrated` before their per-step `assertSafeMigrationTarget`
  // runs) but a manifest still at kynetic 1.1. The manifest promotion step
  // would silently mutate the protected project despite the env-configured
  // tripwire pointing at its root. The fix hoists the safety check to the
  // orchestrator entrypoint so it always runs before any executing mutation.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("upgrade refuses to mutate when KSPEC_PROTECTED_PROJECT_PATHS guards the target (no monolithic records)", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);

    // No monolithic plan/review records — both migration steps would
    // short-circuit as alreadyMigrated. Manifest stays at 1.1 from
    // initProject() so the manifest promotion step has real work to do.
    await writeMonolithicPlans(specDir, []);
    await writeMonolithicReviews(specDir, []);

    const manifestBefore = await readTestOutput(manifestPath);

    const cliResult = kspec("upgrade --json", tempDir, {
      expectFail: true,
      env: { KSPEC_PROTECTED_PROJECT_PATHS: tempDir },
    });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    // Safety preflight must be present as a failed step. Plan, review, and
    // manifest steps must all be skipped — the tripwire short-circuited
    // every storage mutation.
    const safetyStep = result.steps.find((s) => s.name === "Storage migration safety preflight");
    expect(safetyStep?.status).toBe("failed");
    expect(safetyStep?.message).toMatch(/protected/i);
    expect(safetyStep?.message).toMatch(/KSPEC_PROTECTED_PROJECT_PATHS/);

    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    const manifestStep = result.steps.find((s) => s.name === "Storage manifest (kynetic 1.2)");
    expect(planStep?.status).toBe("skipped");
    expect(reviewStep?.status).toBe("skipped");
    expect(manifestStep?.status).toBe("skipped");

    // Manifest on disk must be byte-identical to before the run — no
    // promotion to kynetic 1.2, no storage declarations written.
    const manifestAfter = await readTestOutput(manifestPath);
    expect(manifestAfter).toBe(manifestBefore);
    const manifest = yamlParse(manifestAfter) as Record<string, unknown>;
    expect(manifest.kynetic).toBe("1.1");
    expect(manifest.plan_storage).toBeUndefined();
    expect(manifest.review_storage).toBeUndefined();
    expect(manifest.resource_storage).toBeUndefined();

    // No plan/review folder directories were created.
    await expect(fs.access(path.join(specDir, "plans"))).rejects.toThrow();
    await expect(fs.access(path.join(specDir, "reviews"))).rejects.toThrow();
  });

  // Companion regression: the tripwire must also fire when there IS real
  // plan/review work to migrate. Asserting both paths in this test file
  // guarantees future refactors do not regress one path while keeping the
  // other.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("upgrade refuses to mutate when KSPEC_PROTECTED_PROJECT_PATHS guards the target (with monolithic records)", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);

    await writeMonolithicPlans(specDir, [
      {
        _ulid: planUlid,
        slugs: ["guarded"],
        title: "Guarded Plan",
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
        slugs: ["guarded"],
        title: "Guarded Review",
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

    const planFileBefore = await readTestOutput(path.join(specDir, "project.plans.yaml"));
    const reviewFileBefore = await readTestOutput(path.join(specDir, "project.reviews.yaml"));
    const manifestBefore = await readTestOutput(manifestPath);

    const cliResult = kspec("upgrade --json", tempDir, {
      expectFail: true,
      env: { KSPEC_PROTECTED_PROJECT_PATHS: tempDir },
    });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    const safetyStep = result.steps.find((s) => s.name === "Storage migration safety preflight");
    expect(safetyStep?.status).toBe("failed");

    const planStep = result.steps.find((s) => s.name === "Plan storage folder migration");
    const reviewStep = result.steps.find((s) => s.name === "Review storage folder migration");
    const manifestStep = result.steps.find((s) => s.name === "Storage manifest (kynetic 1.2)");
    expect(planStep?.status).toBe("skipped");
    expect(reviewStep?.status).toBe("skipped");
    expect(manifestStep?.status).toBe("skipped");

    // All three input files must be byte-identical to before — no
    // buffered write landed because the preflight aborted before the
    // buffer opened.
    expect(await readTestOutput(path.join(specDir, "project.plans.yaml"))).toBe(planFileBefore);
    expect(await readTestOutput(path.join(specDir, "project.reviews.yaml"))).toBe(reviewFileBefore);
    expect(await readTestOutput(manifestPath)).toBe(manifestBefore);

    // No plan/review folder directories were created for the would-be
    // migrated ULIDs.
    await expect(fs.access(path.join(specDir, "plans", planUlid))).rejects.toThrow();
    await expect(fs.access(path.join(specDir, "reviews", reviewUlid))).rejects.toThrow();
  });

  // Regression for fix cycle 6 blocker: the protected-project tripwire must
  // halt the ENTIRE upgrade pipeline, not just the plan/review/manifest
  // storage sub-block. The reviewer reproduced this with
  // KSPEC_PROTECTED_PROJECT_PATHS set to the project root and observed
  // `Storage migration safety preflight=failed` plus `Backfill core
  // skills=done` in the same JSON result. Backfilling core skills,
  // re-rendering skills, regenerating the agents file, repairing
  // gitignore, scaffolding files, and recording the version all WRITE
  // to the protected project — exactly the mutations the tripwire is
  // supposed to refuse. The fix hoists the preflight to the pipeline
  // entrypoint so a failed preflight skips every downstream step.
  //
  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("upgrade refuses every pipeline step when KSPEC_PROTECTED_PROJECT_PATHS guards the target", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);

    // Empty plan/review files — no monolithic records — and a downgraded
    // manifest so the pipeline would otherwise have real work to do
    // across multiple steps (manifest promotion, skills backfill, skills
    // render, agents regen, gitignore repair, scaffold, version record).
    await writeMonolithicPlans(specDir, []);
    await writeMonolithicReviews(specDir, []);

    // Snapshot every artifact the downstream steps would mutate so we
    // can prove they remained untouched.
    const manifestBefore = await readTestOutput(manifestPath);
    const setupStatePath = path.join(specDir, ".setup-state.json");
    const setupStateBefore = await readTestOutput(setupStatePath);
    const gitignorePath = path.join(tempDir, ".gitignore");
    const gitignoreBefore = await fs.readFile(gitignorePath, "utf-8").catch(() => "<missing>");
    const skillsDir = path.join(specDir, "skills");
    const skillsBefore = await fs
      .readdir(skillsDir)
      .then((entries) => entries.sort())
      .catch(() => [] as string[]);

    const cliResult = kspec("upgrade --json", tempDir, {
      expectFail: true,
      env: { KSPEC_PROTECTED_PROJECT_PATHS: tempDir },
    });
    expect(cliResult.exitCode).not.toBe(0);
    const result = JSON.parse(cliResult.stdout) as UpgradeResultShape;
    expect(result.success).toBe(false);

    const safetyStep = result.steps.find((s) => s.name === "Storage migration safety preflight");
    expect(safetyStep?.status).toBe("failed");
    expect(safetyStep?.message).toMatch(/protected/i);
    expect(safetyStep?.message).toMatch(/KSPEC_PROTECTED_PROJECT_PATHS/);

    // Every downstream pipeline step must be reported as `skipped`.
    // None of them are allowed to run on a protected target — they all
    // mutate disk in some way (task storage layout, plan/review folders,
    // manifest, .kspec/skills/, .agents/, .gitignore, scaffolded files,
    // setup state). A `done` here means the tripwire failed to halt the
    // pipeline and the protected project was mutated.
    const pipelineStepNames = [
      "Task storage migration",
      "Plan storage folder migration",
      "Review storage folder migration",
      "Storage manifest (kynetic 1.2)",
      "Backfill core skills",
      "Re-render skills",
      "Regenerate agent instructions",
      "Restore gitignore entries",
      "Scaffold missing files",
      "Record version",
    ];
    for (const stepName of pipelineStepNames) {
      const step = result.steps.find((s) => s.name === stepName);
      expect(step, `expected ${stepName} step present`).toBeDefined();
      expect(step?.status, `${stepName} must be skipped under tripwire`).toBe("skipped");
    }

    // The result must NOT report any step as `done` — that would prove
    // the tripwire failed to halt the pipeline and the protected
    // project was mutated.
    const doneSteps = result.steps.filter((s) => s.status === "done");
    expect(
      doneSteps,
      `no step may run after the tripwire fires; got: ${doneSteps.map((s) => s.name).join(", ")}`,
    ).toEqual([]);

    // Every mutation-target artifact must be byte-identical to before.
    expect(await readTestOutput(manifestPath)).toBe(manifestBefore);
    expect(await readTestOutput(setupStatePath)).toBe(setupStateBefore);
    expect(await fs.readFile(gitignorePath, "utf-8").catch(() => "<missing>")).toBe(
      gitignoreBefore,
    );
    const skillsAfter = await fs
      .readdir(skillsDir)
      .then((entries) => entries.sort())
      .catch(() => [] as string[]);
    expect(skillsAfter).toEqual(skillsBefore);

    // No plan/review folders were created.
    await expect(fs.access(path.join(specDir, "plans"))).rejects.toThrow();
    await expect(fs.access(path.join(specDir, "reviews"))).rejects.toThrow();
  });
});
