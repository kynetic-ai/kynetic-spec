/**
 * Tests for the plan/review folder-storage migration steps wired into
 * `kspec upgrade`. Covers the dry-run preview, the executing run that
 * writes folders + lean indexes + manifest fields, the previous-shadow
 * commit reporting, and isolation safeguards (the temp dir must live
 * under the OS tempdir prefix; tests refuse to touch the live repos).
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 *       @single-command-version-upgrade
 *       @plan-revisions
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
    const backfillStep = result.steps.find((s) => s.name === "Plan revision backfill");
    expect(planStep?.status).toBe("done");
    expect(planStep?.details?.migrated).toBe(1);
    expect(reviewStep?.status).toBe("done");
    expect(reviewStep?.details?.migrated).toBe(1);
    expect(manifestStep?.status).toBe("done");
    expect(backfillStep?.status).toBe("done");

    // Folder layout exists.
    const planCore = yamlParse(
      await readTestOutput(path.join(specDir, "plans", planUlid, "plan.yaml")),
    );
    expect(planCore._ulid).toBe(planUlid);
    expect(planCore.revisions).toHaveLength(1);
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
    expect(planIndex.plans[0].current_revision).toBe(1);
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

  // AC: @plan-revisions ac-backfill-revision-one
  it("upgrade backfills revision 1 for existing plans and is idempotent", async () => {
    const { specDir } = await initProject(tempDir);

    await writeMonolithicPlans(specDir, [
      {
        _ulid: planUlid,
        slugs: ["backfill-plan"],
        title: "Backfill Plan",
        content: "# Backfill\nBody",
        status: "approved",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        approved_at: "2026-05-23T10:00:00Z",
        notes: [],
      },
    ]);

    const dryRun = kspecJson<UpgradeResultShape>("upgrade --force --dry-run", tempDir);
    const dryBackfill = dryRun.steps.find((s) => s.name === "Plan revision backfill");
    expect(dryBackfill?.status).toBe("done");
    expect(dryBackfill?.details?.backfilled).toBe(1);
    await expect(fs.access(path.join(specDir, "plans", planUlid))).rejects.toThrow();

    const first = kspecJson<UpgradeResultShape>("upgrade --force", tempDir);
    expect(first.success).toBe(true);
    const firstBackfill = first.steps.find((s) => s.name === "Plan revision backfill");
    expect(firstBackfill?.status).toBe("done");
    expect(firstBackfill?.details?.backfilled).toBe(1);

    const corePath = path.join(specDir, "plans", planUlid, "plan.yaml");
    const firstCore = yamlParse(await readTestOutput(corePath)) as {
      revisions: Array<{
        ordinal: number;
        author: string;
        note: string;
        created_at: string;
        shadow_commit: string;
      }>;
    };
    expect(firstCore.revisions).toHaveLength(1);
    expect(firstCore.revisions[0]).toMatchObject({
      ordinal: 1,
      author: "kspec-upgrade",
      note: "Backfilled revision 1 during kspec upgrade",
    });
    expect(firstCore.revisions[0].created_at).toBeTruthy();
    expect(firstCore.revisions[0].shadow_commit).toMatch(/^[0-9a-f]{40}$/);

    const resolvedContent = execSync(
      `git show ${firstCore.revisions[0].shadow_commit}:plans/${planUlid}/plan.md`,
      { cwd: specDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(resolvedContent).toBe("# Backfill\nBody");

    const planIndex = yamlParse(await readTestOutput(path.join(specDir, "project.plans.yaml"))) as {
      plans: Array<Record<string, unknown>>;
    };
    expect(planIndex.plans[0].current_revision).toBe(1);
    expect(JSON.stringify(planIndex.plans[0])).not.toContain("Backfill\\nBody");

    const second = kspecJson<UpgradeResultShape>("upgrade --force", tempDir);
    const secondBackfill = second.steps.find((s) => s.name === "Plan revision backfill");
    expect(secondBackfill?.status).toBe("skipped");
    expect(secondBackfill?.details?.backfilled).toBe(0);

    const secondCore = yamlParse(await readTestOutput(corePath)) as {
      revisions: unknown[];
    };
    expect(secondCore.revisions).toEqual(firstCore.revisions);
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

// ── Idempotence + Repair Convergence Across All Entity Types ─────────────────
//
// After a migration or repair, an immediate dry-run rebuild for the same
// domain MUST report no drift. This pins the convergence contract from
// @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders,
// ac-index-repair-converges, and ac-semantic-defaults-do-not-drift across
// tasks, plans, and reviews together. Prior coverage proved migrations
// could write the folder layout, but not that the rebuilt index agreed with
// the folders on the very next dry-run — exactly the loop operators rely on
// to distinguish real damage from false drift.

interface RebuildIndexEnvelope {
  domain: string;
  status: "clean" | "drift" | "blocked" | "repaired";
  dry_run?: boolean;
  repair?: boolean;
  force?: boolean;
  summary: {
    folders: number;
    index_entries: number;
    added: number;
    updated: number;
    removed_stale: number;
    conflicts: number;
  };
  changes: unknown[];
  conflicts: unknown[];
}

describe("kspec upgrade — post-migration rebuild-index idempotence", () => {
  let tempDir: string;
  let planUlid: string;
  let reviewUlid: string;
  let threadUlid: string;
  let entryUlid: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-upgrade-idempotence-");
    assertTempDirIsolation(tempDir);
    planUlid = testUlid("CVPLN");
    reviewUlid = testUlid("CVREV");
    threadUlid = testUlid("CVTHR");
    entryUlid = testUlid("CVENT");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function expectCleanDryRun(
    domain: "plan" | "review" | "task",
    cwd: string,
    label: string,
  ): RebuildIndexEnvelope {
    // task rebuild-index does not emit the structured envelope —
    // assert exit code + "up to date" text. Plan/review rebuilds emit
    // JSON; assert exit 0 + status=clean + zero changes/conflicts.
    if (domain === "task") {
      const result = kspec("task rebuild-index --dry-run", cwd);
      expect(result.exitCode, `${label}: ${result.stderr || result.stdout}`).toBe(0);
      const combined = `${result.stdout} ${result.stderr}`;
      expect(combined, `${label}: must report up to date`).toMatch(/up to date/i);
      return {
        domain: "tasks",
        status: "clean",
        dry_run: true,
        summary: {
          folders: 0,
          index_entries: 0,
          added: 0,
          updated: 0,
          removed_stale: 0,
          conflicts: 0,
        },
        changes: [],
        conflicts: [],
      };
    }
    const result = kspec(`${domain} rebuild-index --dry-run --json`, cwd);
    expect(result.exitCode, `${label}: ${result.stderr || result.stdout}`).toBe(0);
    const envelope = JSON.parse(result.stdout) as RebuildIndexEnvelope;
    expect(envelope.status, `${label}: status`).toBe("clean");
    expect(envelope.changes, `${label}: changes`).toEqual([]);
    expect(envelope.conflicts, `${label}: conflicts`).toEqual([]);
    return envelope;
  }

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  // AC: @single-command-version-upgrade ac-runs-task-storage-migration
  it("upgrade then immediate plan + review + task dry-run rebuilds report clean", async () => {
    const { specDir } = await initProject(tempDir);

    // Seed a monolithic task too so the post-upgrade task layout exists
    // (`task rebuild-index` errors on an empty tasks/ dir by design — its
    // purpose is to repair an existing split layout, not bootstrap one).
    const taskUlidSeed = testUlid("CVTSK");
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      (await import("yaml")).stringify({
        kynetic_tasks: "1.0",
        tasks: [
          {
            _ulid: taskUlidSeed,
            slugs: ["task-converge-seed"],
            title: "Converge Task",
            type: "task",
            status: "pending",
            priority: 3,
            created_at: "2026-05-22T10:00:00Z",
            description: "Seed task for convergence smoke test",
            notes: [],
            todos: [],
            depends_on: [],
            blocked_by: [],
          },
        ],
      }),
      "utf-8",
    );

    await writeMonolithicPlans(specDir, [
      {
        _ulid: planUlid,
        slugs: ["converge-plan"],
        title: "Converge Plan",
        content: "# Converge\nBody",
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
        slugs: ["converge-review"],
        title: "Converge Review",
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

    const upgradeResult = kspecJson<UpgradeResultShape>("upgrade", tempDir);
    expect(upgradeResult.success).toBe(true);

    // Immediate dry-run rebuilds across all three domains MUST be clean.
    // No repair step in between — this is the convergence contract for
    // migration: the moment migration completes, the bounded index must
    // agree with the folder sidecars on disk.
    expectCleanDryRun("plan", tempDir, "plan dry-run immediately after upgrade");
    expectCleanDryRun("review", tempDir, "review dry-run immediately after upgrade");
    expectCleanDryRun("task", tempDir, "task dry-run immediately after upgrade");

    // Sanity: the folders the upgrade just wrote must still be on disk.
    await fs.access(path.join(specDir, "plans", planUlid));
    await fs.access(path.join(specDir, "reviews", reviewUlid));
  });

  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  it("plan rebuild-index --repair after upgrade is followed by a clean dry-run", async () => {
    const { specDir } = await initProject(tempDir);

    await writeMonolithicPlans(specDir, [
      {
        _ulid: planUlid,
        slugs: ["repair-converge"],
        title: "Repair Converge",
        content: "Body",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);
    await writeMonolithicReviews(specDir, []);

    const upgradeResult = kspecJson<UpgradeResultShape>("upgrade", tempDir);
    expect(upgradeResult.success).toBe(true);

    // Corrupt the lean index by hand-rewriting it so repair has real work
    // to do. We mutate a projected field (title) so the repair pass must
    // overwrite the index entry from the authoritative plan.yaml content.
    const indexPath = path.join(specDir, "project.plans.yaml");
    const indexData = yamlParse(await readTestOutput(indexPath)) as {
      plans: Array<Record<string, unknown>>;
    };
    indexData.plans[0].title = "Drifted Title";
    const yamlMod = await import("yaml");
    await fs.writeFile(indexPath, yamlMod.stringify(indexData), "utf-8");

    // Dry-run sees drift, exits 1, no writes.
    const driftResult = kspec("plan rebuild-index --dry-run --json", tempDir, {
      expectFail: true,
    });
    expect(driftResult.exitCode).toBe(1);
    const driftEnv = JSON.parse(driftResult.stdout) as RebuildIndexEnvelope;
    expect(driftEnv.status).toBe("drift");

    // Repair rewrites the index from folder authority.
    const repairResult = kspec("plan rebuild-index --repair --json", tempDir);
    expect(repairResult.exitCode).toBe(0);
    const repairEnv = JSON.parse(repairResult.stdout) as RebuildIndexEnvelope;
    expect(repairEnv.status).toBe("repaired");

    // The immediate follow-up dry-run with no intervening mutation must be
    // clean. This is the convergence guarantee: a successful repair leaves
    // the index in agreement with the folders.
    expectCleanDryRun("plan", tempDir, "plan dry-run after repair");
  });

  // AC: @trait-folder-backed-entity-1 ac-index-repair-converges
  it("review rebuild-index --repair after upgrade is followed by a clean dry-run", async () => {
    const { specDir } = await initProject(tempDir);

    await writeMonolithicPlans(specDir, []);
    await writeMonolithicReviews(specDir, [
      {
        _ulid: reviewUlid,
        slugs: ["repair-converge-review"],
        title: "Repair Converge Review",
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

    const upgradeResult = kspecJson<UpgradeResultShape>("upgrade", tempDir);
    expect(upgradeResult.success).toBe(true);

    // Hand-corrupt an indexed field to give repair real work.
    const indexPath = path.join(specDir, "project.reviews.yaml");
    const indexData = yamlParse(await readTestOutput(indexPath)) as {
      reviews: Array<Record<string, unknown>>;
    };
    indexData.reviews[0].title = "Drifted Review Title";
    const yamlMod = await import("yaml");
    await fs.writeFile(indexPath, yamlMod.stringify(indexData), "utf-8");

    const driftResult = kspec("review rebuild-index --dry-run --json", tempDir, {
      expectFail: true,
    });
    expect(driftResult.exitCode).toBe(1);
    const driftEnv = JSON.parse(driftResult.stdout) as RebuildIndexEnvelope;
    expect(driftEnv.status).toBe("drift");

    const repairResult = kspec("review rebuild-index --repair --json", tempDir);
    expect(repairResult.exitCode).toBe(0);
    const repairEnv = JSON.parse(repairResult.stdout) as RebuildIndexEnvelope;
    expect(repairEnv.status).toBe("repaired");

    expectCleanDryRun("review", tempDir, "review dry-run after repair");
  });

  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  // AC: @single-command-version-upgrade ac-idempotent-when-current
  it("legacy reviews migrated with empty external_links produce no repeated drift", async () => {
    const { specDir } = await initProject(tempDir);

    await writeMonolithicPlans(specDir, []);
    // Two legacy review records:
    //  - one with an explicit `external_links: []`
    //  - one with `external_links` populated
    // After migration, the lean index entry omits `external_links` when
    // empty (per the bounded projection). A follow-up dry-run rebuild must
    // not flag the omitted-vs-`[]` divergence as drift.
    const reviewWithEmpty = testUlid("SDEMP");
    const reviewWithLinks = testUlid("SDFUL");
    await writeMonolithicReviews(specDir, [
      {
        _ulid: reviewWithEmpty,
        slugs: ["empty-links"],
        title: "Empty Links Review",
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
      {
        _ulid: reviewWithLinks,
        slugs: ["with-links"],
        title: "With Links Review",
        author: "reviewer",
        subject: {
          type: "task",
          ref: "@other-task",
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
        external_links: [{ url: "https://example.com/pr/1", label: "PR" }],
        examined_commit: null,
        created_at: "2026-05-22T10:00:00Z",
      },
    ]);

    const upgradeResult = kspecJson<UpgradeResultShape>("upgrade", tempDir);
    expect(upgradeResult.success).toBe(true);

    // First dry-run must be clean — no spurious updates from empty-vs-omitted
    // external_links round-trip OR from the order in which YAML and the
    // Zod schema project subject/external_links object fields.
    expectCleanDryRun("review", tempDir, "review dry-run after migration with empty links");

    // Repair is a no-op when there is no drift: the CLI short-circuits to
    // `status=clean` before invoking the rebuild writer, exit 0. This
    // proves the semantic-equality treatment of empty defaults survives a
    // repair invocation without rewriting the index.
    const repairResult = kspec("review rebuild-index --repair --json", tempDir);
    expect(repairResult.exitCode).toBe(0);
    const repairEnv = JSON.parse(repairResult.stdout) as RebuildIndexEnvelope;
    expect(repairEnv.status).toBe("clean");
    expect(repairEnv.summary.added).toBe(0);
    expect(repairEnv.summary.updated).toBe(0);

    // And a follow-up dry-run after the repair-invocation must STILL be
    // clean — the index file remained untouched, so semantic-equality
    // treatment survived the round trip.
    expectCleanDryRun("review", tempDir, "review dry-run after no-op repair");
  });
});

// ── Operator Workflow CLI Smoke Test ────────────────────────────────────────
//
// Mirrors the real operator sequence end-to-end against a temp project so
// dispatch agents and humans can rely on the documented commands:
//
//   1. kspec upgrade --force --dry-run    (preview the upgrade)
//   2. kspec upgrade --force              (run the upgrade)
//   3. plan/review/task rebuild-index --dry-run   (post-upgrade convergence)
//   4. representative plan/review/task mutations
//   5. plan/review/task rebuild-index --dry-run   (post-mutation convergence)
//
// Every dry-run must exit 0 (clean) with no drift. The smoke test never
// touches live self-hosting repos: it asserts tempdir isolation, runs the
// CLI via dist/cli/index.js with KSPEC_NO_DAEMON=1 already set by the helper.

describe("kspec operator workflow — CLI smoke", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-operator-smoke-");
    assertTempDirIsolation(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function dryRunIsClean(
    domain: "plan" | "review",
    cwd: string,
    label: string,
  ): RebuildIndexEnvelope {
    const result = kspec(`${domain} rebuild-index --dry-run --json`, cwd);
    expect(result.exitCode, `${label}: exit code (${result.stderr || result.stdout})`).toBe(0);
    const envelope = JSON.parse(result.stdout) as RebuildIndexEnvelope;
    expect(envelope.status, `${label}: status`).toBe("clean");
    expect(envelope.changes, `${label}: changes`).toEqual([]);
    expect(envelope.conflicts, `${label}: conflicts`).toEqual([]);
    return envelope;
  }

  function taskDryRunIsClean(cwd: string, label: string): void {
    const result = kspec("task rebuild-index --dry-run", cwd);
    expect(result.exitCode, `${label}: exit code (${result.stderr || result.stdout})`).toBe(0);
    const combined = `${result.stdout} ${result.stderr}`;
    expect(combined, `${label}: must report up to date`).toMatch(/up to date/i);
  }

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  // AC: @single-command-version-upgrade ac-runs-task-storage-migration
  // AC: @single-command-version-upgrade ac-idempotent-when-current
  // AC: @single-command-version-upgrade ac-dry-run-no-writes
  it("upgrade → rebuild dry-runs → mutations → final dry-runs are all clean (exit 0)", async () => {
    const { specDir, manifestPath } = await initProject(tempDir);
    const seedPlanUlid = testUlid("OPSDP");
    const seedReviewUlid = testUlid("OPSDR");

    // Seed legacy monolithic plan + review records so upgrade has real
    // migration work to do (not just a manifest bump).
    await writeMonolithicPlans(specDir, [
      {
        _ulid: seedPlanUlid,
        slugs: ["operator-seed-plan"],
        title: "Operator Seed Plan",
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
        _ulid: seedReviewUlid,
        slugs: ["operator-seed-review"],
        title: "Operator Seed Review",
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

    // Snapshot key artifacts so the dry-run preview must not write.
    const manifestBeforeDryRun = await readTestOutput(manifestPath);
    const plansFileBeforeDryRun = await readTestOutput(path.join(specDir, "project.plans.yaml"));
    const reviewsFileBeforeDryRun = await readTestOutput(
      path.join(specDir, "project.reviews.yaml"),
    );

    // Step 1: `kspec upgrade --force --dry-run` — must not write anything.
    // AC: @single-command-version-upgrade ac-dry-run-no-writes
    const dryUpgrade = kspecJson<UpgradeResultShape>("upgrade --force --dry-run", tempDir);
    expect(dryUpgrade.dry_run).toBe(true);
    expect(dryUpgrade.success).toBe(true);
    expect(await readTestOutput(manifestPath)).toBe(manifestBeforeDryRun);
    expect(await readTestOutput(path.join(specDir, "project.plans.yaml"))).toBe(
      plansFileBeforeDryRun,
    );
    expect(await readTestOutput(path.join(specDir, "project.reviews.yaml"))).toBe(
      reviewsFileBeforeDryRun,
    );
    await expect(fs.access(path.join(specDir, "plans", seedPlanUlid))).rejects.toThrow();
    await expect(fs.access(path.join(specDir, "reviews", seedReviewUlid))).rejects.toThrow();

    // Step 2: `kspec upgrade --force` — applies the migration.
    // AC: @single-command-version-upgrade ac-runs-task-storage-migration
    const upgrade = kspecJson<UpgradeResultShape>("upgrade --force", tempDir);
    expect(upgrade.success).toBe(true);
    const manifestAfterUpgrade = yamlParse(await readTestOutput(manifestPath)) as Record<
      string,
      unknown
    >;
    expect(manifestAfterUpgrade.kynetic).toBe("1.2");
    expect((manifestAfterUpgrade.plan_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifestAfterUpgrade.review_storage as Record<string, unknown>).format).toBe("folder");

    // Step 3: immediate dry-run rebuilds across plan + review — must report
    // clean. (Task rebuild-index is intentionally not exercised here: the
    // upgrade did not migrate any task records into the split layout, so
    // .kspec/tasks/ does not exist yet and the recovery tool refuses to
    // bootstrap. The post-mutation assertion below covers task rebuild
    // once a real task has been written through the normal CLI path.)
    dryRunIsClean("plan", tempDir, "plan dry-run immediately after upgrade --force");
    dryRunIsClean("review", tempDir, "review dry-run immediately after upgrade --force");

    // Step 4: representative mutations — exercise the normal CLI surface.
    const planAdd = kspec(
      'plan add --title "Operator Plan" --content "# Plan\\nBody" --slug operator-cli-plan',
      tempDir,
    );
    expect(planAdd.exitCode, `plan add: ${planAdd.stderr || planAdd.stdout}`).toBe(0);

    const reviewAdd = kspec(
      'review add --title "Operator Review" --slug operator-cli-review --subject-type code --base aaa111 --head bbb222',
      tempDir,
    );
    expect(reviewAdd.exitCode, `review add: ${reviewAdd.stderr || reviewAdd.stdout}`).toBe(0);

    const taskAdd = kspec(
      'task add --title "Operator Task" --slug task-operator-cli --priority 3',
      tempDir,
    );
    expect(taskAdd.exitCode, `task add: ${taskAdd.stderr || taskAdd.stdout}`).toBe(0);

    // Add a note + a resource to exercise resource_summary and notes_count
    // index updates without leaving the index stale.
    const taskNote = kspec('task note @task-operator-cli "Initial note from smoke test"', tempDir);
    expect(taskNote.exitCode, `task note: ${taskNote.stderr || taskNote.stdout}`).toBe(0);

    const sampleResource = path.join(tempDir, "sample.png");
    await fs.writeFile(sampleResource, "FAKE_PNG_BYTES", "utf-8");
    const planResource = kspec(
      `plan resource add @operator-cli-plan ${sampleResource} --id smoke-res --path attached.png`,
      tempDir,
    );
    expect(
      planResource.exitCode,
      `plan resource add: ${planResource.stderr || planResource.stdout}`,
    ).toBe(0);

    const reviewResource = kspec(
      `review resource add @operator-cli-review ${sampleResource} --id review-res --path attached.png`,
      tempDir,
    );
    expect(
      reviewResource.exitCode,
      `review resource add: ${reviewResource.stderr || reviewResource.stdout}`,
    ).toBe(0);

    // Step 5: final dry-run rebuilds across all three domains — all clean.
    // Every mutator above is supposed to keep the bounded index synchronized
    // with the folder sidecars in the same atomic write. If any path bypasses
    // that contract this assertion fails with status=drift.
    dryRunIsClean("plan", tempDir, "plan dry-run after mutations");
    dryRunIsClean("review", tempDir, "review dry-run after mutations");
    taskDryRunIsClean(tempDir, "task dry-run after mutations");
  });

  // AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
  // AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
  // AC: @single-command-version-upgrade ac-idempotent-when-current
  it("a fresh kspec init project (kynetic 1.2, folder storage) stays clean after representative mutations", async () => {
    // Fresh project: NO downgrade. `kspec init --no-prompt` already writes
    // kynetic 1.2 with folder plan/review storage and split task storage.
    // Operators getting a brand-new project should never see a non-zero
    // dry-run rebuild — even after writing real entities.
    initGitRepo(tempDir);
    await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n", "utf-8");
    execSync('git add . && git commit -m "initial"', { cwd: tempDir, stdio: "pipe" });
    const initResult = kspec("init --no-prompt", tempDir);
    expect(initResult.exitCode, `kspec init: ${initResult.stderr || initResult.stdout}`).toBe(0);

    const specDir = path.join(tempDir, ".kspec");
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
    const manifest = yamlParse(await readTestOutput(path.join(specDir, manifestName))) as Record<
      string,
      unknown
    >;
    expect(manifest.kynetic).toBe("1.2");
    expect((manifest.plan_storage as Record<string, unknown>).format).toBe("folder");
    expect((manifest.review_storage as Record<string, unknown>).format).toBe("folder");

    // Baseline cleanliness — empty plan and review folder layouts must
    // already report clean. (task rebuild-index errors on an empty tasks/
    // dir by design — it expects at least one per-task directory before
    // the rebuild has anything to project. The post-mutation assertion
    // below covers the populated case.)
    dryRunIsClean("plan", tempDir, "fresh init plan dry-run (empty)");
    dryRunIsClean("review", tempDir, "fresh init review dry-run (empty)");

    // Representative mutations across all three entity types.
    const planAdd = kspec(
      'plan add --title "Fresh Plan" --content "# Fresh\\nBody" --slug fresh-cli-plan',
      tempDir,
    );
    expect(planAdd.exitCode, `plan add: ${planAdd.stderr || planAdd.stdout}`).toBe(0);

    const reviewAdd = kspec(
      'review add --title "Fresh Review" --slug fresh-cli-review --subject-type code --base aaa111 --head bbb222',
      tempDir,
    );
    expect(reviewAdd.exitCode, `review add: ${reviewAdd.stderr || reviewAdd.stdout}`).toBe(0);

    const taskAdd = kspec(
      'task add --title "Fresh Task" --slug task-fresh-cli --priority 3',
      tempDir,
    );
    expect(taskAdd.exitCode, `task add: ${taskAdd.stderr || taskAdd.stdout}`).toBe(0);

    const reviewComment = kspec(
      'review comment @fresh-cli-review --body "Initial blocker" --kind blocker',
      tempDir,
    );
    expect(
      reviewComment.exitCode,
      `review comment: ${reviewComment.stderr || reviewComment.stdout}`,
    ).toBe(0);

    const reviewCheck = kspec("review check @fresh-cli-review --name lint --status pass", tempDir);
    expect(reviewCheck.exitCode, `review check: ${reviewCheck.stderr || reviewCheck.stdout}`).toBe(
      0,
    );

    const planNote = kspec('plan note @fresh-cli-plan "First note"', tempDir);
    expect(planNote.exitCode, `plan note: ${planNote.stderr || planNote.stdout}`).toBe(0);

    // Resource paths — exercise the index resource_summary projection.
    const sampleResource = path.join(tempDir, "sample.bin");
    await fs.writeFile(sampleResource, "SAMPLE_BYTES", "utf-8");
    const planResource = kspec(
      `plan resource add @fresh-cli-plan ${sampleResource} --id fresh-res --path attached.bin`,
      tempDir,
    );
    expect(
      planResource.exitCode,
      `plan resource add: ${planResource.stderr || planResource.stdout}`,
    ).toBe(0);
    const reviewResource = kspec(
      `review resource add @fresh-cli-review ${sampleResource} --id fresh-res --path attached.bin`,
      tempDir,
    );
    expect(
      reviewResource.exitCode,
      `review resource add: ${reviewResource.stderr || reviewResource.stdout}`,
    ).toBe(0);

    // Final dry-run rebuilds — every mutation above is expected to keep its
    // bounded index entry in sync atomically. If any path leaves stale
    // projection state the dry-run reports drift and this fails.
    dryRunIsClean("plan", tempDir, "fresh init plan dry-run after mutations");
    dryRunIsClean("review", tempDir, "fresh init review dry-run after mutations");
    taskDryRunIsClean(tempDir, "fresh init task dry-run after mutations");
  });
});
