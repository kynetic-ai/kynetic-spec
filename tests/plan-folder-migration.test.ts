/**
 * Tests for plan-storage folder migration.
 *
 * Covers the dry-run preview, the executing migration writes, the
 * partial-layout refusal, the identity/unknown-field preservation rule,
 * and the isolation safeguard requested by the migration plan (every
 * test asserts the temp dir lives under the OS tempdir prefix).
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyPlanMigration,
  computePlanMigrationReport,
} from "../src/parser/plan-folder-migration.js";
import {
  PLAN_CORE_FILENAME,
  PLAN_DOCUMENT_FILENAME,
  PLAN_NOTES_FILENAME,
  PLAN_RESOURCES_MANIFEST_FILENAME,
} from "../src/parser/plan-storage-manager.js";
import { toYaml, type KspecContext } from "../src/parser/yaml.js";
import { parse as yamlParse } from "yaml";
import { cleanupTempDir, createTempDir, readTestOutput, testUlid } from "./helpers/cli.js";

/**
 * Build a minimal KspecContext for migration module tests. The migration
 * code only needs specDir/manifest/manifestPath/shadow. The other fields
 * are stubbed so the type-checker is happy.
 *
 * Manifest defaults to legacy (no plan_storage declaration) — tests that
 * need a different manifest pass overrides.
 */
async function buildCtx(
  tempDir: string,
  manifestOverrides: Record<string, unknown> = {},
): Promise<KspecContext> {
  const specDir = path.join(tempDir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  const manifest = {
    kynetic: "1.1",
    project: { name: "plan-migration-test", version: "0.1.0" },
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

/** Write a monolithic `project.plans.yaml` for the given records. */
async function writeMonolithicPlans(
  ctx: KspecContext,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  await fs.writeFile(
    path.join(ctx.specDir, "project.plans.yaml"),
    toYaml({ kynetic_plans: "1.0", plans: records }),
    "utf-8",
  );
}

/**
 * Assert that the test directory lives under the OS tempdir prefix.
 * This is the isolation safeguard the migration plan requires: every
 * executing migration test MUST mutate a temporary or disposable copy
 * of fixture data, never the active kynetic-spec / kynetic-spec-dispatch
 * repos.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 */
function assertTempDirIsolation(dir: string): void {
  const real = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  expect(real.startsWith(tmp + path.sep)).toBe(true);
  expect(real.startsWith(path.resolve("/home/chapel/Projects/kynetic-spec"))).toBe(false);
  expect(real.startsWith(path.resolve("/home/chapel/Projects/kynetic-spec-dispatch"))).toBe(false);
}

describe("plan folder migration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-plan-migration-");
    assertTempDirIsolation(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ── Empty / already migrated detection ───────────────────────────────────

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("reports alreadyMigrated when no monolithic file exists", async () => {
    const ctx = await buildCtx(tempDir);
    const report = await computePlanMigrationReport(ctx);
    expect(report.alreadyMigrated).toBe(true);
    expect(report.migrated).toBe(0);
    expect(report.entries).toEqual([]);
    expect(report.partialLayout).toBe(false);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("reports alreadyMigrated when monolithic file is empty", async () => {
    const ctx = await buildCtx(tempDir);
    await writeMonolithicPlans(ctx, []);
    const report = await computePlanMigrationReport(ctx);
    expect(report.alreadyMigrated).toBe(true);
    expect(report.entries).toEqual([]);
  });

  // ── Dry-run preview ──────────────────────────────────────────────────────

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-dry-run-previews-layout
  it("produces a dry-run report without writing any files", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("PLAN1");
    await writeMonolithicPlans(ctx, [
      {
        _ulid: ulid,
        slugs: ["dry-run-plan"],
        title: "Dry Run Plan",
        content: "# Plan\nBody",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);

    const report = await computePlanMigrationReport(ctx);
    expect(report.alreadyMigrated).toBe(false);
    expect(report.migrated).toBe(1);
    expect(report.entries[0]).toMatchObject({
      ulid,
      title: "Dry Run Plan",
      hadGeneratedUlid: false,
      preexistingFolder: false,
    });
    expect(report.warnings).toEqual([]);

    // Pure projection — never writes.
    const planDir = path.join(ctx.specDir, "plans", ulid);
    await expect(fs.access(planDir)).rejects.toThrow();
  });

  // ── Executing migration writes ───────────────────────────────────────────

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  it("writes plan.yaml, plan.md, resources.yaml, and a lean index entry per plan", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("PLAN2");
    const body = "# Plan Title\n\nMarkdown body here.\n";
    await writeMonolithicPlans(ctx, [
      {
        _ulid: ulid,
        slugs: ["exec-plan"],
        title: "Exec Plan",
        content: body,
        status: "approved",
        derived_tasks: [],
        derived_specs: [],
        source_path: "/tmp/source-plan.md",
        branch: "plan/exec-plan",
        created_at: "2026-05-22T10:00:00Z",
        approved_at: "2026-05-22T11:00:00Z",
        notes: [],
      },
    ]);

    const report = await computePlanMigrationReport(ctx);
    const applied = await applyPlanMigration(ctx, report);
    expect(applied.written).toBe(1);

    const planDir = path.join(ctx.specDir, "plans", ulid);
    const plan = yamlParse(await readTestOutput(path.join(planDir, PLAN_CORE_FILENAME)));
    expect(plan._ulid).toBe(ulid);
    expect(plan.title).toBe("Exec Plan");
    expect(plan.status).toBe("approved");
    expect(plan.source_path).toBe("/tmp/source-plan.md");
    expect(plan.branch).toBe("plan/exec-plan");
    expect(plan.content).toBeUndefined(); // body lives in plan.md
    expect(plan.notes).toBeUndefined(); // notes live in notes.yaml when present

    const markdown = await readTestOutput(path.join(planDir, PLAN_DOCUMENT_FILENAME));
    expect(markdown).toBe(body);

    const resourcesManifest = yamlParse(
      await readTestOutput(path.join(planDir, PLAN_RESOURCES_MANIFEST_FILENAME)),
    );
    expect(resourcesManifest).toEqual({ resources: [] });

    const index = yamlParse(
      await readTestOutput(path.join(ctx.specDir, "project.plans.yaml")),
    );
    expect(index.kynetic_plans).toBe("1.0");
    expect(Array.isArray(index.plans)).toBe(true);
    expect(index.plans).toHaveLength(1);
    const entry = index.plans[0];
    // Lean projection — no content, no notes array.
    expect(entry._ulid).toBe(ulid);
    expect(entry.title).toBe("Exec Plan");
    expect(entry.status).toBe("approved");
    expect(entry.source_path).toBe("/tmp/source-plan.md");
    expect(entry.approved_at).toBe("2026-05-22T11:00:00Z");
    expect(entry.notes_count).toBe(0);
    expect(entry.content).toBeUndefined();
    expect(entry.notes).toBeUndefined();
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  it("preserves unknown fields and notes on the migrated plan", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("PLAN3");
    await writeMonolithicPlans(ctx, [
      {
        _ulid: ulid,
        slugs: [],
        title: "With Notes",
        content: "Body",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [
          {
            _ulid: testUlid("NOTE1"),
            text: "Original note",
            author: "tester",
            created_at: "2026-05-22T11:00:00Z",
          },
        ],
        // Unknown extension field — must survive migration.
        custom_extension_field: { hello: "world" },
      },
    ]);

    const report = await computePlanMigrationReport(ctx);
    await applyPlanMigration(ctx, report);

    const planDir = path.join(ctx.specDir, "plans", ulid);
    const core = yamlParse(await readTestOutput(path.join(planDir, PLAN_CORE_FILENAME)));
    expect(core.custom_extension_field).toEqual({ hello: "world" });

    const notes = yamlParse(await readTestOutput(path.join(planDir, PLAN_NOTES_FILENAME)));
    expect(Array.isArray(notes.notes)).toBe(true);
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0].text).toBe("Original note");

    const index = yamlParse(
      await readTestOutput(path.join(ctx.specDir, "project.plans.yaml")),
    );
    expect(index.plans[0].notes_count).toBe(1);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  it("mints a new ULID when monolithic record has an invalid _ulid", async () => {
    const ctx = await buildCtx(tempDir);
    await writeMonolithicPlans(ctx, [
      {
        _ulid: "not-a-ulid",
        slugs: ["missing-id"],
        title: "Missing ID",
        content: "Body",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);

    const report = await computePlanMigrationReport(ctx);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.entries[0].hadGeneratedUlid).toBe(true);
    const newUlid = report.entries[0].ulid;
    expect(newUlid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    await applyPlanMigration(ctx, report);
    const core = yamlParse(
      await readTestOutput(path.join(ctx.specDir, "plans", newUlid, PLAN_CORE_FILENAME)),
    );
    expect(core._ulid).toBe(newUlid);
    expect(core.title).toBe("Missing ID");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
  it("preserves invalid-but-not-fatal records with a validation warning", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("PLAN5");
    await writeMonolithicPlans(ctx, [
      {
        _ulid: ulid,
        // Missing title — fails schema, but we preserve the record verbatim
        // and surface a warning.
        slugs: ["broken-plan"],
        content: "Body",
        status: "draft",
        created_at: "2026-05-22T10:00:00Z",
      },
    ]);

    const report = await computePlanMigrationReport(ctx);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].validationWarning).toContain("validation warning");

    await applyPlanMigration(ctx, report);
    const core = yamlParse(
      await readTestOutput(path.join(ctx.specDir, "plans", ulid, PLAN_CORE_FILENAME)),
    );
    expect(core._ulid).toBe(ulid);
    expect(core.slugs).toEqual(["broken-plan"]);
  });

  // ── Monolithic file removal ──────────────────────────────────────────────

  // AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
  it("rewrites project.plans.yaml as a lean index (drops monolithic body)", async () => {
    const ctx = await buildCtx(tempDir);
    const ulid = testUlid("PLAN6");
    await writeMonolithicPlans(ctx, [
      {
        _ulid: ulid,
        slugs: [],
        title: "Lean Index Check",
        content: "A".repeat(5000),
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);

    const report = await computePlanMigrationReport(ctx);
    await applyPlanMigration(ctx, report);

    const indexContents = await readTestOutput(
      path.join(ctx.specDir, "project.plans.yaml"),
    );
    expect(indexContents).not.toContain("A".repeat(5000));
    const index = yamlParse(indexContents);
    expect(index.plans[0]._ulid).toBe(ulid);
    expect(index.plans[0].content).toBeUndefined();
  });

  // ── Partial layout refusal ───────────────────────────────────────────────

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("refuses to execute when folders + monolithic records coexist without force", async () => {
    const ctx = await buildCtx(tempDir);
    const existingFolderUlid = testUlid("PLNEX");
    const monolithicUlid = testUlid("PLNML");

    // Pre-existing folder for one plan
    const existingDir = path.join(ctx.specDir, "plans", existingFolderUlid);
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(
      path.join(existingDir, PLAN_CORE_FILENAME),
      toYaml({
        _ulid: existingFolderUlid,
        slugs: [],
        title: "Existing Folder",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(existingDir, PLAN_DOCUMENT_FILENAME), "Body", "utf-8");

    // Plus a monolithic record with a different ULID
    await writeMonolithicPlans(ctx, [
      {
        _ulid: monolithicUlid,
        slugs: [],
        title: "Monolithic",
        content: "Body",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-22T10:00:00Z",
        notes: [],
      },
    ]);

    const report = await computePlanMigrationReport(ctx);
    expect(report.partialLayout).toBe(true);

    await expect(applyPlanMigration(ctx, report)).rejects.toThrow(/partial/i);

    // Force allows the migration to proceed.
    const forcedReport = await computePlanMigrationReport(ctx);
    const applied = await applyPlanMigration(ctx, forcedReport, { force: true });
    expect(applied.written).toBe(1);
  });
});
