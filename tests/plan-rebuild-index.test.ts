import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { cleanupTempDir, createTempDir, kspec, setupShadowDetection } from "./helpers/cli.js";

/**
 * Bootstrap a project directory with a folder-backed plan storage manifest
 * and a shadow worktree marker so `kspec` CLI invocations resolve the
 * correct specDir.
 */
async function bootstrapFolderProject(): Promise<{ root: string; specDir: string }> {
  const root = await createTempDir();
  const specDir = path.join(root, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    yamlStringify({
      kynetic: "1.2",
      project: { name: "rebuild-index-test", version: "0.1.0" },
      default_module: "01MDAAAAAAAAAAAAAAAAAAAAAA",
      plan_storage: { format: "folder" },
    }),
    "utf-8",
  );
  await fs.writeFile(
    path.join(specDir, "kspec.config.yaml"),
    yamlStringify({ schema: { version: "1.0" } }),
    "utf-8",
  );
  // Minimal default module so loaders that consult modules don't choke.
  await fs.mkdir(path.join(specDir, "modules"), { recursive: true });
  await fs.writeFile(
    path.join(specDir, "modules", "core.yaml"),
    yamlStringify({
      kynetic_module: "1.0",
      module: { _ulid: "01MDAAAAAAAAAAAAAAAAAAAAAA", slug: "core", title: "Core" },
    }),
    "utf-8",
  );
  await setupShadowDetection(root);
  return { root, specDir };
}

async function writePlanFolder(
  specDir: string,
  ulid: string,
  fields: { title: string; status?: string; createdAt?: string; body?: string },
): Promise<void> {
  const planDir = path.join(specDir, "plans", ulid);
  await fs.mkdir(planDir, { recursive: true });
  await fs.writeFile(
    path.join(planDir, "plan.yaml"),
    yamlStringify({
      _ulid: ulid,
      slugs: [],
      title: fields.title,
      status: fields.status ?? "draft",
      derived_tasks: [],
      derived_specs: [],
      created_at: fields.createdAt ?? "2026-05-23T10:00:00Z",
    }),
    "utf-8",
  );
  await fs.writeFile(path.join(planDir, "plan.md"), fields.body ?? "Body", "utf-8");
}

async function writeIndex(specDir: string, entries: Array<Record<string, unknown>>): Promise<void> {
  await fs.writeFile(
    path.join(specDir, "project.plans.yaml"),
    yamlStringify({ kynetic_plans: "1.0", plans: entries }),
    "utf-8",
  );
}

describe("kspec plan rebuild-index", () => {
  let root: string;
  let specDir: string;

  beforeEach(async () => {
    const project = await bootstrapFolderProject();
    root = project.root;
    specDir = project.specDir;
  });

  afterEach(async () => {
    await cleanupTempDir(root);
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("emits status=clean with exit 0 when folders and index agree", async () => {
    const ulid = "01CNAAAAAAAAAAAAAAAAAAAAAA";
    await writePlanFolder(specDir, ulid, { title: "Clean Plan" });
    await writeIndex(specDir, [
      {
        _ulid: ulid,
        slugs: [],
        title: "Clean Plan",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-23T10:00:00Z",
        notes_count: 0,
      },
    ]);

    const result = kspec("plan rebuild-index --json", root);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.domain).toBe("plans");
    expect(envelope.status).toBe("clean");
    expect(envelope.summary.folders).toBe(1);
    expect(envelope.summary.index_entries).toBe(1);
    expect(envelope.changes).toEqual([]);
    expect(envelope.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("emits status=drift with exit 1 when folder exists without index entry", async () => {
    const ulid = "01ADAAAAAAAAAAAAAAAAAAAAAA";
    await writePlanFolder(specDir, ulid, { title: "Added" });

    const result = kspec("plan rebuild-index --json", root, { expectFail: true });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("drift");
    expect(envelope.summary.added).toBe(1);
    expect(envelope.summary.updated).toBe(0);
    expect(envelope.changes).toHaveLength(1);
    expect(envelope.changes[0]).toMatchObject({ kind: "add", ref: ulid });
    expect(envelope.conflicts).toEqual([]);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("dry-run preserves the index even when drift exists", async () => {
    const ulid = "01DRAAAAAAAAAAAAAAAAAAAAAA";
    await writePlanFolder(specDir, ulid, { title: "Dry Run" });

    const indexPath = path.join(specDir, "project.plans.yaml");
    const before = await fs.readFile(indexPath, "utf-8").catch(() => "");

    const result = kspec("plan rebuild-index --dry-run --json", root, { expectFail: true });
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.dry_run).toBe(true);
    expect(envelope.status).toBe("drift");

    const after = await fs.readFile(indexPath, "utf-8").catch(() => "");
    expect(after).toBe(before);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("repair rewrites the index from folders and exits 0", async () => {
    const ulid = "01RPAAAAAAAAAAAAAAAAAAAAAA";
    await writePlanFolder(specDir, ulid, { title: "Repaired" });

    const result = kspec("plan rebuild-index --repair --json", root);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("repaired");
    expect(envelope.repair).toBe(true);
    expect(envelope.summary.added).toBe(1);

    const indexData = yamlParse(
      await fs.readFile(path.join(specDir, "project.plans.yaml"), "utf-8"),
    ) as { plans: Array<{ _ulid: string; title: string }> };
    expect(indexData.plans).toHaveLength(1);
    expect(indexData.plans[0]._ulid).toBe(ulid);
    expect(indexData.plans[0].title).toBe("Repaired");
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("emits status=blocked with exit 2 when stale index entries lack --force", async () => {
    const staleUlid = "01STAAAAAAAAAAAAAAAAAAAAAA";
    await writeIndex(specDir, [
      {
        _ulid: staleUlid,
        slugs: [],
        title: "Stale",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-23T10:00:00Z",
        notes_count: 0,
      },
    ]);

    const result = kspec("plan rebuild-index --json", root, { expectFail: true });
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("blocked");
    expect(envelope.summary.conflicts).toBe(1);
    expect(envelope.conflicts).toHaveLength(1);
    expect(envelope.conflicts[0].code).toBe("stale_index_entry_without_force");
    expect(envelope.conflicts[0].ref).toBe(staleUlid);

    // No writes: the stale index entry must still be there.
    const indexData = yamlParse(
      await fs.readFile(path.join(specDir, "project.plans.yaml"), "utf-8"),
    ) as { plans: Array<{ _ulid: string }> };
    expect(indexData.plans).toHaveLength(1);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("--force --repair drops stale index entries and rewrites the index", async () => {
    const staleUlid = "01SFAAAAAAAAAAAAAAAAAAAAAA";
    const keptUlid = "01KFAAAAAAAAAAAAAAAAAAAAAA";
    await writePlanFolder(specDir, keptUlid, { title: "Kept" });
    await writeIndex(specDir, [
      {
        _ulid: keptUlid,
        slugs: [],
        title: "Kept",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-23T10:00:00Z",
        notes_count: 0,
      },
      {
        _ulid: staleUlid,
        slugs: [],
        title: "Stale",
        status: "draft",
        derived_tasks: [],
        derived_specs: [],
        created_at: "2026-05-23T10:00:00Z",
        notes_count: 0,
      },
    ]);

    const result = kspec("plan rebuild-index --repair --force --json", root);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("repaired");
    expect(envelope.force).toBe(true);
    expect(envelope.summary.removed_stale).toBe(1);

    const indexData = yamlParse(
      await fs.readFile(path.join(specDir, "project.plans.yaml"), "utf-8"),
    ) as { plans: Array<{ _ulid: string }> };
    expect(indexData.plans).toHaveLength(1);
    expect(indexData.plans[0]._ulid).toBe(keptUlid);
  });

  it("rejects --force without --repair", async () => {
    const result = kspec("plan rebuild-index --force", root, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--force can only be used with --repair/);
  });
});
