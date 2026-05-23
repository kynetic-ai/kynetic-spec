import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import {
  createPlan,
  deletePlan,
  findPlanByRef,
  loadPlans,
  mutatePlanAtomically,
  savePlan,
} from "../src/parser/plans.js";
import {
  computePlanIndexDrift,
  getPlanDir,
  getPlanCoreFilePath,
  getPlanDocumentFilePath,
  getPlanIndexFilePath,
  getPlanNotesFilePath,
  rebuildPlanIndex,
} from "../src/parser/plan-storage-manager.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
} from "./helpers/cli.js";

interface FolderCtx {
  specDir: string;
  manifest: { kynetic: string; plan_storage: { format: "folder" } };
}

function makeCtx(specDir: string): FolderCtx {
  return {
    specDir,
    manifest: { kynetic: "1.2", plan_storage: { format: "folder" } },
  };
}

async function readIndexFile(indexPath: string): Promise<{
  kynetic_plans?: string;
  plans?: Array<Record<string, unknown>>;
} | null> {
  try {
    const raw = await readTestOutput(indexPath);
    return yamlParse(raw);
  } catch {
    return null;
  }
}

async function readCore(corePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readTestOutput(corePath);
    return yamlParse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("Folder-backed plan storage manager", () => {
  let tempDir: string;
  let kspecDir: string;
  let ctx: FolderCtx;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = path.join(tempDir, ".kspec");
    await fs.mkdir(kspecDir, { recursive: true });
    await initGitRepo(tempDir);
    ctx = makeCtx(kspecDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
  // AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
  // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
  it("creates plan.yaml, plan.md, and ULID directory on save", async () => {
    const plan = createPlan({
      title: "Folder Plan",
      content: "# Header\n\nBody markdown.",
      slugs: ["folder-plan"],
    });

    await savePlan(ctx as any, plan);

    const planDir = getPlanDir(ctx as any, plan._ulid);
    const corePath = getPlanCoreFilePath(ctx as any, plan._ulid);
    const docPath = getPlanDocumentFilePath(ctx as any, plan._ulid);

    expect(await pathExists(planDir)).toBe(true);
    expect(await pathExists(corePath)).toBe(true);
    expect(await pathExists(docPath)).toBe(true);

    const document = await readTestOutput(docPath);
    expect(document).toBe("# Header\n\nBody markdown.");

    const core = await readCore(corePath);
    expect(core?._ulid).toBe(plan._ulid);
    expect(core?.title).toBe("Folder Plan");
    expect(core?.slugs).toEqual(["folder-plan"]);
    expect(core?.status).toBe("draft");
    // plan.yaml must NOT carry the markdown body — plan.md is authoritative.
    expect(core?.content).toBeUndefined();
    // notes are omitted from plan.yaml when there are none.
    expect(core?.notes).toBeUndefined();
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  // AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
  it("writes a lean index entry without markdown or notes content", async () => {
    const plan = createPlan({
      title: "Lean Index",
      content: "Long markdown body that must not appear in the index.",
      slugs: ["lean-index"],
      notes: [
        {
          _ulid: "01TESTA0000000000000000000",
          created_at: "2026-05-23T10:00:00Z",
          author: "@claude",
          content: "Note body that must not appear in the index.",
        },
      ],
    });

    await savePlan(ctx as any, plan);

    const indexPath = getPlanIndexFilePath(ctx as any);
    const indexFile = await readIndexFile(indexPath);
    expect(indexFile?.kynetic_plans).toBe("1.0");
    expect(indexFile?.plans).toHaveLength(1);

    const entry = indexFile!.plans![0];
    expect(entry._ulid).toBe(plan._ulid);
    expect(entry.title).toBe("Lean Index");
    expect(entry.status).toBe("draft");
    expect(entry.slugs).toEqual(["lean-index"]);
    expect(entry.notes_count).toBe(1);
    // Heavy detail fields must be absent from the index.
    expect(entry.content).toBeUndefined();
    expect(entry.notes).toBeUndefined();
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
  it("loads markdown content from plan.md (sidecar is authoritative)", async () => {
    const plan = createPlan({
      title: "Authority Plan",
      content: "Original body.",
    });

    await savePlan(ctx as any, plan);

    // Edit plan.md outside the manager — simulates direct user edit.
    const docPath = getPlanDocumentFilePath(ctx as any, plan._ulid);
    await fs.writeFile(docPath, "Edited body via plan.md", "utf-8");

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe("Edited body via plan.md");
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
  it("stores notes in the notes.yaml sidecar only when notes exist", async () => {
    const plan = createPlan({
      title: "Notes Plan",
      notes: [
        {
          _ulid: "01TESTA0000000000000000001",
          created_at: "2026-05-23T11:00:00Z",
          author: "@claude",
          content: "First note",
        },
      ],
    });

    await savePlan(ctx as any, plan);

    const notesPath = getPlanNotesFilePath(ctx as any, plan._ulid);
    expect(await pathExists(notesPath)).toBe(true);

    const notesYaml = yamlParse(await readTestOutput(notesPath)) as {
      notes: Array<{ content: string }>;
    };
    expect(notesYaml.notes).toHaveLength(1);
    expect(notesYaml.notes[0].content).toBe("First note");

    // notes.yaml must NOT be created for plans without notes.
    const plain = createPlan({ title: "No Notes" });
    await savePlan(ctx as any, plain);
    const noNotesPath = getPlanNotesFilePath(ctx as any, plain._ulid);
    expect(await pathExists(noNotesPath)).toBe(false);
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
  it("supports findPlanByRef via ULID, short prefix, and slug", async () => {
    const plan = createPlan({
      title: "Reference Plan",
      slugs: ["reference-plan"],
    });
    await savePlan(ctx as any, plan);

    const byUlid = await findPlanByRef(ctx as any, plan._ulid);
    expect(byUlid?._ulid).toBe(plan._ulid);

    const byShort = await findPlanByRef(ctx as any, plan._ulid.slice(0, 8));
    expect(byShort?._ulid).toBe(plan._ulid);

    const bySlug = await findPlanByRef(ctx as any, "reference-plan");
    expect(bySlug?._ulid).toBe(plan._ulid);

    const byAt = await findPlanByRef(ctx as any, "@reference-plan");
    expect(byAt?._ulid).toBe(plan._ulid);

    const missing = await findPlanByRef(ctx as any, "nonexistent");
    expect(missing).toBeUndefined();
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
  it("mutatePlanAtomically reads latest disk state and writes both sidecars", async () => {
    const plan = createPlan({ title: "Initial Title", content: "Initial body" });
    await savePlan(ctx as any, plan);

    const updated = await mutatePlanAtomically(ctx as any, plan, (latest) => ({
      ...latest,
      title: "Updated Title",
      content: "Updated body",
      status: "approved",
      approved_at: "2026-05-23T12:00:00Z",
    }));

    expect(updated.title).toBe("Updated Title");

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe("Updated Title");
    expect(loaded[0].content).toBe("Updated body");
    expect(loaded[0].status).toBe("approved");
    expect(loaded[0].approved_at).toBe("2026-05-23T12:00:00Z");

    // Index entry tracks indexed fields without storing the body.
    const indexFile = await readIndexFile(getPlanIndexFilePath(ctx as any));
    const entry = indexFile!.plans![0];
    expect(entry.status).toBe("approved");
    expect(entry.approved_at).toBe("2026-05-23T12:00:00Z");
    expect(entry.content).toBeUndefined();
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-delete-removes-owned-folder
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
  it("deletePlan removes the plan directory (with resources) and index entry", async () => {
    const plan = createPlan({ title: "To Delete" });
    await savePlan(ctx as any, plan);

    // Simulate owned resources to verify the recursive cleanup.
    const planDir = getPlanDir(ctx as any, plan._ulid);
    const resourcesDir = path.join(planDir, "resources");
    await fs.mkdir(resourcesDir, { recursive: true });
    await fs.writeFile(path.join(resourcesDir, "screenshot.png"), "binary-data", "utf-8");
    await fs.writeFile(
      path.join(planDir, "resources.yaml"),
      "resources:\n  - id: screenshot\n    label: Screenshot\n    path: screenshot.png\n",
      "utf-8",
    );

    await deletePlan(ctx as any, plan._ulid);

    expect(await pathExists(planDir)).toBe(false);

    const indexFile = await readIndexFile(getPlanIndexFilePath(ctx as any));
    expect(indexFile?.plans ?? []).toHaveLength(0);
  });

  it("deletePlan throws ENOENT-style error when plan is missing", async () => {
    await expect(deletePlan(ctx as any, "01MSSNGAAAAAAAAAAAAAAAAAAA")).rejects.toThrow(
      /Plan not found/,
    );
  });

  // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
  it("preserves unknown files within a plan directory across mutations", async () => {
    const plan = createPlan({ title: "Unknown Files" });
    await savePlan(ctx as any, plan);

    const planDir = getPlanDir(ctx as any, plan._ulid);
    const unknownPath = path.join(planDir, "scratch.txt");
    await fs.writeFile(unknownPath, "hand-edited notes that must survive", "utf-8");

    await mutatePlanAtomically(ctx as any, plan, (latest) => ({
      ...latest,
      title: "Renamed",
    }));

    expect(await pathExists(unknownPath)).toBe(true);
    expect(await readTestOutput(unknownPath)).toBe(
      "hand-edited notes that must survive",
    );
  });

  // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
  it("preserves unknown plan.yaml fields across mutations", async () => {
    const plan = createPlan({ title: "Unknown Fields" });
    await savePlan(ctx as any, plan);

    const corePath = getPlanCoreFilePath(ctx as any, plan._ulid);
    const original = await readCore(corePath);
    (original as Record<string, unknown>).future_field = { kept: true };
    await fs.writeFile(corePath, `${JSON.stringify(original, null, 2)}\n`, "utf-8");

    await mutatePlanAtomically(ctx as any, plan, (latest) => ({
      ...latest,
      title: "Touched",
    }));

    const after = await readCore(corePath);
    expect(after?.title).toBe("Touched");
    expect(after?.future_field).toEqual({ kept: true });
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  // AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
  it("computePlanIndexDrift detects added/updated entries", async () => {
    const plan = createPlan({ title: "Drift" });
    await savePlan(ctx as any, plan);

    // Add a second plan directory by hand to simulate drift (folder
    // exists but index entry is missing).
    const otherUlid = "01TESTDRFTAAAAAAAAAAAAAAAA";
    const otherDir = path.join(kspecDir, "plans", otherUlid);
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(
      path.join(otherDir, "plan.yaml"),
      `_ulid: ${otherUlid}\nslugs: []\ntitle: Orphan Folder\nstatus: draft\nderived_tasks: []\nderived_specs: []\ncreated_at: 2026-05-23T13:00:00Z\n`,
      "utf-8",
    );
    await fs.writeFile(path.join(otherDir, "plan.md"), "Orphan body", "utf-8");

    const drift = await computePlanIndexDrift(ctx as any);
    expect(drift.changes).toHaveLength(1);
    expect(drift.changes[0].kind).toBe("add");
    expect(drift.changes[0].ref).toBe(otherUlid);
    expect(drift.conflicts).toHaveLength(0);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("computePlanIndexDrift surfaces stale index entries as conflicts without --force", async () => {
    const plan = createPlan({ title: "Stale" });
    await savePlan(ctx as any, plan);

    // Drop the plan folder to leave the index entry stranded.
    await fs.rm(getPlanDir(ctx as any, plan._ulid), { recursive: true });

    const drift = await computePlanIndexDrift(ctx as any);
    expect(drift.conflicts).toHaveLength(1);
    expect(drift.conflicts[0].code).toBe("stale_index_entry_without_force");
    expect(drift.conflicts[0].ref).toBe(plan._ulid);
    expect(drift.changes.filter((c) => c.kind === "remove_stale")).toHaveLength(0);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("computePlanIndexDrift reports stale entries as remove_stale when force is set", async () => {
    const plan = createPlan({ title: "Stale Force" });
    await savePlan(ctx as any, plan);

    await fs.rm(getPlanDir(ctx as any, plan._ulid), { recursive: true });

    const drift = await computePlanIndexDrift(ctx as any, { force: true });
    expect(drift.conflicts).toHaveLength(0);
    expect(drift.changes).toHaveLength(1);
    expect(drift.changes[0].kind).toBe("remove_stale");
    expect(drift.changes[0].ref).toBe(plan._ulid);
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("rebuildPlanIndex (non-force) rewrites index entries from folder contents", async () => {
    const plan = createPlan({ title: "Initial" });
    await savePlan(ctx as any, plan);

    // Tamper with the index entry to introduce drift.
    const indexPath = getPlanIndexFilePath(ctx as any);
    const tampered = await readIndexFile(indexPath);
    tampered!.plans![0].title = "WRONG";
    await fs.writeFile(indexPath, `kynetic_plans: "1.0"\nplans:\n  - ${
      JSON.stringify(tampered!.plans![0])
    }\n`, "utf-8");

    const result = await rebuildPlanIndex(ctx as any);
    expect(result.count).toBe(1);

    const after = await readIndexFile(indexPath);
    expect(after?.plans).toHaveLength(1);
    expect(after?.plans?.[0].title).toBe("Initial");
    // The canonical wrapper must survive the rebuild.
    expect(after?.kynetic_plans).toBe("1.0");
  });

  // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
  it("rebuildPlanIndex with force drops stale entries", async () => {
    const keep = createPlan({ title: "Keep" });
    const drop = createPlan({ title: "Drop" });
    await savePlan(ctx as any, keep);
    await savePlan(ctx as any, drop);

    await fs.rm(getPlanDir(ctx as any, drop._ulid), { recursive: true });

    await rebuildPlanIndex(ctx as any, { force: true });

    const indexFile = await readIndexFile(getPlanIndexFilePath(ctx as any));
    expect(indexFile?.plans).toHaveLength(1);
    expect(indexFile?.plans?.[0]?._ulid).toBe(keep._ulid);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("loadPlans raises partial_entity_storage_layout when folder declared but monolithic ULIDs remain", async () => {
    // Pre-existing monolithic entry without a matching plan folder.
    const monolithicPath = path.join(kspecDir, "project.plans.yaml");
    await fs.writeFile(
      monolithicPath,
      `kynetic_plans: "1.0"\nplans:\n  - _ulid: 01ABCDEFGHJKMNPQRSTVWXYZAA\n    slugs: [legacy]\n    title: Legacy Inline Plan\n    content: Inline body\n    status: draft\n    derived_tasks: []\n    derived_specs: []\n    created_at: 2026-05-23T10:00:00Z\n`,
      "utf-8",
    );

    await expect(loadPlans(ctx as any)).rejects.toMatchObject({
      code: "partial_entity_storage_layout",
      domain: "plans",
    });
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
  it("clearing a plan's notes removes the notes.yaml sidecar via savePlan", async () => {
    const plan = createPlan({
      title: "Notes Cleared via Save",
      notes: [
        {
          _ulid: "01TESTC0000000000000000001",
          created_at: "2026-05-23T15:00:00Z",
          author: "@claude",
          content: "Will be cleared",
        },
      ],
    });

    await savePlan(ctx as any, plan);

    const notesPath = getPlanNotesFilePath(ctx as any, plan._ulid);
    expect(await pathExists(notesPath)).toBe(true);

    // Re-save with an empty notes array — savePlan must drop the sidecar
    // so detail reads do not surface the stale note.
    await savePlan(ctx as any, { ...plan, notes: [] });

    expect(await pathExists(notesPath)).toBe(false);

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].notes).toEqual([]);

    const indexPath = getPlanIndexFilePath(ctx as any);
    const indexFile = await readIndexFile(indexPath);
    expect(indexFile?.plans?.[0].notes_count).toBe(0);
  });

  // AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
  it("mutatePlanAtomically removes notes.yaml when the mutation clears the notes array", async () => {
    const plan = createPlan({
      title: "Notes Cleared via Mutate",
      notes: [
        {
          _ulid: "01TESTC0000000000000000002",
          created_at: "2026-05-23T15:30:00Z",
          author: "@claude",
          content: "Will be cleared via mutate",
        },
      ],
    });
    await savePlan(ctx as any, plan);

    const notesPath = getPlanNotesFilePath(ctx as any, plan._ulid);
    expect(await pathExists(notesPath)).toBe(true);

    await mutatePlanAtomically(ctx as any, plan, (latest) => ({
      ...latest,
      notes: [],
    }));

    expect(await pathExists(notesPath)).toBe(false);

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].notes).toEqual([]);

    const indexFile = await readIndexFile(getPlanIndexFilePath(ctx as any));
    expect(indexFile?.plans?.[0].notes_count).toBe(0);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
  it("loadPlans raises partial_entity_storage_layout when plan.md is missing", async () => {
    const plan = createPlan({ title: "Missing Document", content: "Body" });
    await savePlan(ctx as any, plan);

    // Simulate a corrupted/partially-migrated folder: plan.yaml survives but
    // the authoritative plan.md sidecar disappears. The folder manager must
    // refuse to silently load this as an empty document.
    await fs.rm(getPlanDocumentFilePath(ctx as any, plan._ulid));

    await expect(loadPlans(ctx as any)).rejects.toMatchObject({
      code: "partial_entity_storage_layout",
      domain: "plans",
    });
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  it("rebuild-index drift surfaces missing plan.md as a partial-layout conflict", async () => {
    const plan = createPlan({ title: "Drift Missing Doc", content: "Body" });
    await savePlan(ctx as any, plan);

    await fs.rm(getPlanDocumentFilePath(ctx as any, plan._ulid));

    const drift = await computePlanIndexDrift(ctx as any);
    expect(drift.conflicts).toHaveLength(1);
    expect(drift.conflicts[0].code).toBe("partial_entity_storage_layout");
    expect(drift.conflicts[0].ref).toBe(plan._ulid);
    expect(drift.changes).toHaveLength(0);
  });

  // AC: @plan-crud ac-7
  it("listing returns plans in folder order with full content for each", async () => {
    const a = createPlan({ title: "Plan A", content: "Body A" });
    const b = createPlan({ title: "Plan B", content: "Body B" });
    const c = createPlan({ title: "Plan C", content: "Body C" });

    await savePlan(ctx as any, a);
    await savePlan(ctx as any, b);
    await savePlan(ctx as any, c);

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(3);
    const byUlid = new Map(loaded.map((p) => [p._ulid, p]));
    expect(byUlid.get(a._ulid)?.content).toBe("Body A");
    expect(byUlid.get(b._ulid)?.content).toBe("Body B");
    expect(byUlid.get(c._ulid)?.content).toBe("Body C");
  });
});
