/**
 * Tests for the shared folder-backed entity trait foundation.
 *
 * These tests verify the trait foundation against a fixture "widget"
 * entity that is NOT one of the production entity types (tasks, plans,
 * reviews). Exercising the foundation through a fixture proves the
 * abstraction is general — it must not contain task-specific assumptions.
 *
 * Spec: @trait-folder-backed-entity-1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type FolderBackedEntityLayout,
  ULID_DIRECTORY_PATTERN,
  getEntityDir,
  getEntityFilePath,
  getEntityIndexPath,
  getStorageRoot,
  indexEntriesEqualForFields,
  isValidUlidDirName,
  listEntityDirs,
  mergePreservingRawShape,
  readIndexEntries,
  rebuildEntityIndex,
  writeIndexEntries,
} from "../src/parser/folder-backed-entity.js";
import { readYamlFile, toYaml, writeYamlFile, type KspecContext } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir, readTestOutput, testUlid } from "./helpers/cli.js";

// ── Fixture Entity Type ──────────────────────────────────────────────────────

/**
 * "Widget" — a minimal fixture entity used only by these tests to exercise
 * the trait foundation. Its schema is intentionally tiny so the tests can
 * focus on storage-shape behavior rather than entity semantics.
 */
interface Widget {
  _ulid: string;
  name: string;
  color: string;
  status: string;
  priority: number;
  tags: string[];
  /** Heavy detail field — MUST NOT appear in the index. */
  blueprint: string;
  /** Optional sidecar metadata-derived field used by index rebuild. */
  variant?: string;
}

const WIDGET_LAYOUT: FolderBackedEntityLayout = {
  entityType: "widget",
  storageRoot: "widgets",
  indexFile: "project.widgets.yaml",
  // No wrapper — widgets use a bare array index. Wrapper behavior is
  // covered by a separate "wrapped" layout below.
};

const WIDGET_WRAPPED_LAYOUT: FolderBackedEntityLayout = {
  entityType: "widget-wrapped",
  storageRoot: "widgets-wrapped",
  indexFile: "project.widgets-wrapped.yaml",
  indexWrapperKey: "widgets",
};

const WIDGET_SCHEMA_KEYS: ReadonlySet<string> = new Set<string>([
  "_ulid",
  "name",
  "color",
  "status",
  "priority",
  "tags",
  "blueprint",
  "variant",
]);

const WIDGET_INDEXED_FIELDS = [
  "_ulid",
  "name",
  "color",
  "status",
  "priority",
  "tags",
  "variant",
] as const;

function projectWidgetToIndexEntry(widget: Widget): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    _ulid: widget._ulid,
    name: widget.name,
    color: widget.color,
    status: widget.status,
    priority: widget.priority,
    tags: widget.tags,
  };
  if (widget.variant !== undefined) {
    entry.variant = widget.variant;
  }
  return entry;
}

// ── Fixture Setup ────────────────────────────────────────────────────────────

async function setupCtx(tempDir: string): Promise<KspecContext> {
  const specDir = path.join(tempDir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });
  return {
    rootDir: tempDir,
    projectRoot: tempDir,
    specDir,
    sessionsDir: path.join(tempDir, ".kspec-sessions"),
    manifestPath: path.join(specDir, "kynetic.yaml"),
    manifest: { kynetic_spec: "1.0", title: "Test Project" } as unknown,
    shadow: null,
    config: {} as unknown,
  } as unknown as KspecContext;
}

/**
 * Write a widget entity in the folder-backed layout: create the ULID
 * directory, write `widget.yaml` for the core record, optionally write
 * `metadata.yaml` for the sidecar, and optionally write unknown sibling
 * files/directories.
 */
async function createWidget(
  ctx: KspecContext,
  layout: FolderBackedEntityLayout,
  widget: Widget,
  options: {
    sidecar?: Record<string, unknown>;
    extraFiles?: Record<string, string>;
    extraDirs?: string[];
  } = {},
): Promise<void> {
  const dir = getEntityDir(ctx, layout, widget._ulid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "widget.yaml"), toYaml(widget));
  if (options.sidecar) {
    await fs.writeFile(path.join(dir, "metadata.yaml"), toYaml(options.sidecar));
  }
  for (const [name, content] of Object.entries(options.extraFiles ?? {})) {
    await fs.writeFile(path.join(dir, name), content);
  }
  for (const subdir of options.extraDirs ?? []) {
    await fs.mkdir(path.join(dir, subdir), { recursive: true });
    await fs.writeFile(path.join(dir, subdir, "inside.txt"), "nested");
  }
}

async function readWidget(
  ctx: KspecContext,
  layout: FolderBackedEntityLayout,
  ulid: string,
): Promise<Widget> {
  return readYamlFile<Widget>(getEntityFilePath(ctx, layout, ulid, "widget.yaml"));
}

async function readSidecar(
  ctx: KspecContext,
  layout: FolderBackedEntityLayout,
  ulid: string,
): Promise<Record<string, unknown>> {
  return readYamlFile<Record<string, unknown>>(
    getEntityFilePath(ctx, layout, ulid, "metadata.yaml"),
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("folder-backed entity trait foundation", () => {
  let tempDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-folder-backed-trait-");
    ctx = await setupCtx(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ── ULID Directory Validation ────────────────────────────────────────────

  describe("ULID directory naming", () => {
    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("accepts a full 26-character Crockford ULID", () => {
      const valid = testUlid("WGT");
      expect(valid).toHaveLength(26);
      expect(ULID_DIRECTORY_PATTERN.test(valid)).toBe(true);
      expect(isValidUlidDirName(valid)).toBe(true);
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("rejects ULIDs that contain Crockford-excluded letters (I, L, O, U)", () => {
      const excluded = ["I", "L", "O", "U"];
      for (const ch of excluded) {
        const bad = `01${ch}${"0".repeat(23)}`;
        expect(bad).toHaveLength(26);
        expect(isValidUlidDirName(bad)).toBe(false);
      }
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("rejects names that are not exactly 26 characters", () => {
      expect(isValidUlidDirName("short")).toBe(false);
      expect(isValidUlidDirName("0".repeat(25))).toBe(false);
      expect(isValidUlidDirName("0".repeat(27))).toBe(false);
      expect(isValidUlidDirName("")).toBe(false);
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("rejects lowercase characters", () => {
      const upper = testUlid("WGT");
      expect(isValidUlidDirName(upper.toLowerCase())).toBe(false);
    });
  });

  // ── Path Helpers ─────────────────────────────────────────────────────────

  describe("path helpers", () => {
    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("derives the storage root from specDir + layout.storageRoot", () => {
      expect(getStorageRoot(ctx, WIDGET_LAYOUT)).toBe(path.join(ctx.specDir, "widgets"));
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("derives an entity directory as <storageRoot>/<ulid>", () => {
      const ulid = testUlid("WGT");
      expect(getEntityDir(ctx, WIDGET_LAYOUT, ulid)).toBe(
        path.join(ctx.specDir, "widgets", ulid),
      );
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("derives an entity file path as <entityDir>/<filename>", () => {
      const ulid = testUlid("WGT");
      expect(getEntityFilePath(ctx, WIDGET_LAYOUT, ulid, "widget.yaml")).toBe(
        path.join(ctx.specDir, "widgets", ulid, "widget.yaml"),
      );
      expect(getEntityFilePath(ctx, WIDGET_LAYOUT, ulid, "metadata.yaml")).toBe(
        path.join(ctx.specDir, "widgets", ulid, "metadata.yaml"),
      );
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("derives the index file path from specDir + layout.indexFile", () => {
      expect(getEntityIndexPath(ctx, WIDGET_LAYOUT)).toBe(
        path.join(ctx.specDir, "project.widgets.yaml"),
      );
    });
  });

  // ── Listing ULID Directories ─────────────────────────────────────────────

  describe("listEntityDirs", () => {
    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("returns the names of all valid ULID-named subdirectories", async () => {
      const ulid1 = testUlid("WGTA", 0);
      const ulid2 = testUlid("WGTB", 1);
      await createWidget(ctx, WIDGET_LAYOUT, {
        _ulid: ulid1,
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: ["a"],
        blueprint: "huge text".repeat(100),
      });
      await createWidget(ctx, WIDGET_LAYOUT, {
        _ulid: ulid2,
        name: "beta",
        color: "blue",
        status: "active",
        priority: 2,
        tags: ["b"],
        blueprint: "huge text".repeat(100),
      });

      const dirs = await listEntityDirs(ctx, WIDGET_LAYOUT);
      expect(dirs.toSorted()).toEqual([ulid1, ulid2].toSorted());
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("ignores non-ULID-named entries while keeping them on disk", async () => {
      const ulid = testUlid("WGT");
      await createWidget(ctx, WIDGET_LAYOUT, {
        _ulid: ulid,
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: [],
        blueprint: "data",
      });

      const root = getStorageRoot(ctx, WIDGET_LAYOUT);
      await fs.mkdir(path.join(root, "not-a-ulid"), { recursive: true });
      await fs.writeFile(path.join(root, "README.md"), "stray file");
      await fs.writeFile(path.join(root, "01TOOSHORT"), "stray file 2");
      // Lowercase ULIDs should be rejected.
      await fs.mkdir(path.join(root, ulid.toLowerCase()), { recursive: true });

      const dirs = await listEntityDirs(ctx, WIDGET_LAYOUT);
      expect(dirs).toEqual([ulid]);

      // Unknown entries remain on disk untouched.
      await expect(fs.stat(path.join(root, "not-a-ulid"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(root, "README.md"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(root, "01TOOSHORT"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(root, ulid.toLowerCase()))).resolves.toBeDefined();
    });

    // AC: @trait-folder-backed-entity-1 ac-entity-has-ulid-directory
    it("returns an empty list when the storage root does not exist", async () => {
      const dirs = await listEntityDirs(ctx, WIDGET_LAYOUT);
      expect(dirs).toEqual([]);
    });
  });

  // ── Unknown-File Preservation ────────────────────────────────────────────

  describe("unknown files in entity folders are preserved", () => {
    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("leaves unknown sibling files untouched after the entity core file is rewritten", async () => {
      const ulid = testUlid("WGT");
      await createWidget(
        ctx,
        WIDGET_LAYOUT,
        {
          _ulid: ulid,
          name: "alpha",
          color: "red",
          status: "active",
          priority: 1,
          tags: ["x"],
          blueprint: "secret",
        },
        {
          extraFiles: {
            "attachment.png": "PNGDATA",
            "notes.txt": "human notes",
            "future.json": '{"futureField": "value"}',
          },
          extraDirs: ["subdir"],
        },
      );

      // Update only the entity core file.
      const dir = getEntityDir(ctx, WIDGET_LAYOUT, ulid);
      const currentWidget = await readWidget(ctx, WIDGET_LAYOUT, ulid);
      await fs.writeFile(
        path.join(dir, "widget.yaml"),
        toYaml({ ...currentWidget, status: "completed" }),
      );

      // Unknown files survive verbatim.
      const attachment = await readTestOutput(path.join(dir, "attachment.png"));
      expect(attachment).toBe("PNGDATA");
      const notesTxt = await readTestOutput(path.join(dir, "notes.txt"));
      expect(notesTxt).toBe("human notes");
      const futureJson = await readTestOutput(path.join(dir, "future.json"));
      expect(futureJson).toBe('{"futureField": "value"}');

      // Unknown subdirectory survives.
      const nested = await readTestOutput(path.join(dir, "subdir", "inside.txt"));
      expect(nested).toBe("nested");
    });

    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("preserves unknown fields *inside* the entity core file across a mutation", () => {
      // Raw on-disk shape includes forward-compatible extension fields.
      const raw: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: ["x"],
        blueprint: "data",
        // Forward-compatible extension fields not yet in the schema:
        provenance: { source: "import", batch: 42 },
        custom_score: 99,
      };

      // The mutation produces a schema-normalized shape (no extension fields)
      // and intentionally clears `tags`.
      const normalized: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "blue", // changed
        status: "active",
        priority: 1,
        tags: [],
        blueprint: "data",
      };

      const merged = mergePreservingRawShape(raw, normalized, WIDGET_SCHEMA_KEYS);

      // Unknown extension fields preserved verbatim.
      expect(merged.provenance).toEqual({ source: "import", batch: 42 });
      expect(merged.custom_score).toBe(99);
      // Mutated schema-known field reflects the new value.
      expect(merged.color).toBe("blue");
      // Schema-known field cleared by the mutation is gone (NOT restored).
      expect(merged.tags).toEqual([]);
    });

    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("does not restore schema-known fields that the mutation removed", () => {
      const raw: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: ["x"],
        blueprint: "data",
        variant: "premium",
      };

      // Mutation removes the schema-known `variant` field.
      const normalized: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: ["x"],
        blueprint: "data",
      };

      const merged = mergePreservingRawShape(raw, normalized, WIDGET_SCHEMA_KEYS);
      expect("variant" in merged).toBe(false);
    });

    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("drops empty-array / null schema defaults absent from raw", () => {
      const raw: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
      };

      const normalized: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
        tags: [], // schema default not in raw → drop
        variant: null, // schema default not in raw → drop
        status: "active", // schema default with meaningful value → keep
      };

      const merged = mergePreservingRawShape(raw, normalized, WIDGET_SCHEMA_KEYS);
      expect("tags" in merged).toBe(false);
      expect("variant" in merged).toBe(false);
      expect(merged.status).toBe("active");
    });
  });

  // ── Bounded Index Projection ─────────────────────────────────────────────

  describe("bounded index projection", () => {
    // AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
    it("indexEntriesEqualForFields returns true when bounded fields are unchanged", () => {
      const base: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: ["x", "y"],
      };
      // Detail-only field differs — bounded equality should ignore it.
      expect(
        indexEntriesEqualForFields(
          base,
          { ...base, blueprint: "different bytes" },
          WIDGET_INDEXED_FIELDS,
        ),
      ).toBe(true);
    });

    // AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
    it("indexEntriesEqualForFields returns false when any bounded field changes", () => {
      const base: Record<string, unknown> = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: ["x"],
      };

      expect(indexEntriesEqualForFields(base, { ...base, status: "completed" }, WIDGET_INDEXED_FIELDS))
        .toBe(false);
      expect(indexEntriesEqualForFields(base, { ...base, color: "blue" }, WIDGET_INDEXED_FIELDS))
        .toBe(false);
      expect(indexEntriesEqualForFields(base, { ...base, priority: 5 }, WIDGET_INDEXED_FIELDS))
        .toBe(false);
      expect(indexEntriesEqualForFields(base, { ...base, tags: ["x", "y"] }, WIDGET_INDEXED_FIELDS))
        .toBe(false);
    });

    // AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
    it("indexEntriesEqualForFields treats both-undefined as equal", () => {
      const base = {
        _ulid: "01WGT00000000000000000000",
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: [],
      };
      // Neither entry sets variant — should compare equal.
      expect(indexEntriesEqualForFields(base, { ...base }, WIDGET_INDEXED_FIELDS)).toBe(true);
    });

    // AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
    it("the projection callback returns only bounded fields, never heavy detail", () => {
      const widget: Widget = {
        _ulid: testUlid("WGT"),
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: ["x", "y"],
        blueprint: "A".repeat(10_000), // very heavy detail — must not leak
      };

      const entry = projectWidgetToIndexEntry(widget);

      // All bounded keys present.
      expect(Object.keys(entry).toSorted()).toEqual(
        ["_ulid", "name", "color", "status", "priority", "tags"].toSorted(),
      );
      // Heavy detail absent.
      expect("blueprint" in entry).toBe(false);
      // Detail bytes never appear anywhere in the projection.
      expect(JSON.stringify(entry).includes("A".repeat(100))).toBe(false);
    });
  });

  // ── Index Read/Write with Wrapper Preservation ──────────────────────────

  describe("index file shape preservation", () => {
    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("reads a bare-array index as { entries, useWrapper: false }", async () => {
      const indexPath = getEntityIndexPath(ctx, WIDGET_LAYOUT);
      await writeYamlFile(indexPath, [{ _ulid: "01WGT00000000000000000000", name: "alpha" }]);

      const shape = await readIndexEntries(indexPath, WIDGET_LAYOUT.indexWrapperKey);
      expect(shape.useWrapper).toBe(false);
      expect(shape.entries).toHaveLength(1);
    });

    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("reads a wrapped index as { useWrapper: true } and preserves sibling keys on write", async () => {
      const indexPath = getEntityIndexPath(ctx, WIDGET_WRAPPED_LAYOUT);
      await writeYamlFile(indexPath, {
        widgets: [{ _ulid: "01WGT00000000000000000000", name: "alpha" }],
        metadata: { generated_at: "2026-05-22T00:00:00.000Z", schema_version: "1.0" },
      });

      const shape = await readIndexEntries(indexPath, WIDGET_WRAPPED_LAYOUT.indexWrapperKey);
      expect(shape.useWrapper).toBe(true);
      expect(shape.entries).toHaveLength(1);

      // Round-trip write with a new entry list — sibling keys must survive.
      await writeIndexEntries(
        indexPath,
        [{ _ulid: "01WGT00000000000000000001", name: "beta" }],
        shape,
        WIDGET_WRAPPED_LAYOUT.indexWrapperKey,
      );
      const reloaded = await readYamlFile<Record<string, unknown>>(indexPath);
      expect(reloaded.metadata).toEqual({
        generated_at: "2026-05-22T00:00:00.000Z",
        schema_version: "1.0",
      });
      expect(Array.isArray(reloaded.widgets)).toBe(true);
      expect((reloaded.widgets as unknown[]).length).toBe(1);
    });

    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("treats a missing index file as empty entries with no wrapper", async () => {
      const shape = await readIndexEntries(
        getEntityIndexPath(ctx, WIDGET_LAYOUT),
        WIDGET_LAYOUT.indexWrapperKey,
      );
      expect(shape).toEqual({ entries: [], useWrapper: false });
    });
  });

  // ── Index Rebuild from Folders ───────────────────────────────────────────

  describe("rebuildEntityIndex", () => {
    // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
    it("regenerates the index file from authoritative folder contents", async () => {
      const ulids = [testUlid("WGT", 0), testUlid("WGT", 1), testUlid("WGT", 2)];
      for (let i = 0; i < ulids.length; i++) {
        await createWidget(ctx, WIDGET_LAYOUT, {
          _ulid: ulids[i],
          name: `widget-${i}`,
          color: i === 0 ? "red" : "blue",
          status: "active",
          priority: i,
          tags: [`tag-${i}`],
          blueprint: "heavy".repeat(50),
        });
      }

      // Corrupt the index file so it no longer reflects folders.
      await writeYamlFile(getEntityIndexPath(ctx, WIDGET_LAYOUT), [
        { _ulid: "01STALE0000000000000000000", name: "stale" },
      ]);

      const result = await rebuildEntityIndex(ctx, WIDGET_LAYOUT, {
        loadEntity: async (rebuildCtx, ulid) =>
          readWidget(rebuildCtx, WIDGET_LAYOUT, ulid).catch(() => undefined),
        projectToIndexEntry: projectWidgetToIndexEntry,
      });

      expect(result.count).toBe(3);

      // Rebuilt index reflects folder contents, not the stale state.
      const rebuilt = await readYamlFile<Record<string, unknown>[]>(
        getEntityIndexPath(ctx, WIDGET_LAYOUT),
      );
      expect(rebuilt.map((e) => e._ulid).toSorted()).toEqual(ulids.toSorted());
      expect(rebuilt.find((e) => e._ulid === "01STALE0000000000000000000")).toBeUndefined();
    });

    // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
    it("incorporates sidecar metadata via the loadEntity callback", async () => {
      const ulid = testUlid("WGT");
      await createWidget(
        ctx,
        WIDGET_LAYOUT,
        {
          _ulid: ulid,
          name: "alpha",
          color: "red",
          status: "active",
          priority: 1,
          tags: [],
          blueprint: "data",
        },
        {
          sidecar: { variant: "premium", supplier: "acme-corp" },
        },
      );

      const result = await rebuildEntityIndex(ctx, WIDGET_LAYOUT, {
        loadEntity: async (rebuildCtx, loadUlid) => {
          const core = await readWidget(rebuildCtx, WIDGET_LAYOUT, loadUlid).catch(() => undefined);
          if (!core) return undefined;
          // Pull bounded summary fields from the sidecar.
          const sidecar = await readSidecar(rebuildCtx, WIDGET_LAYOUT, loadUlid).catch(() => ({}));
          return { ...core, variant: sidecar.variant as string | undefined };
        },
        projectToIndexEntry: projectWidgetToIndexEntry,
      });

      expect(result.count).toBe(1);
      const rebuilt = await readYamlFile<Record<string, unknown>[]>(
        getEntityIndexPath(ctx, WIDGET_LAYOUT),
      );
      expect(rebuilt[0].variant).toBe("premium");
    });

    // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("preserves the wrapper shape and sibling keys when rebuilding a wrapped index", async () => {
      const ulid = testUlid("WGTW");
      await createWidget(ctx, WIDGET_WRAPPED_LAYOUT, {
        _ulid: ulid,
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: [],
        blueprint: "data",
      });

      // Seed a wrapped index with a sibling key the rebuild must preserve.
      const indexPath = getEntityIndexPath(ctx, WIDGET_WRAPPED_LAYOUT);
      await writeYamlFile(indexPath, {
        widgets: [],
        metadata: { generated_at: "2026-05-22T00:00:00.000Z" },
      });

      await rebuildEntityIndex(ctx, WIDGET_WRAPPED_LAYOUT, {
        loadEntity: async (rebuildCtx, loadUlid) =>
          readWidget(rebuildCtx, WIDGET_WRAPPED_LAYOUT, loadUlid).catch(() => undefined),
        projectToIndexEntry: projectWidgetToIndexEntry,
      });

      const reloaded = await readYamlFile<Record<string, unknown>>(indexPath);
      expect(reloaded.metadata).toEqual({ generated_at: "2026-05-22T00:00:00.000Z" });
      expect(Array.isArray(reloaded.widgets)).toBe(true);
      expect((reloaded.widgets as unknown[]).length).toBe(1);
    });

    // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
    // AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
    it("ignores unknown sibling files in the storage root during rebuild", async () => {
      const ulid = testUlid("WGT");
      await createWidget(ctx, WIDGET_LAYOUT, {
        _ulid: ulid,
        name: "alpha",
        color: "red",
        status: "active",
        priority: 1,
        tags: [],
        blueprint: "data",
      });

      const root = getStorageRoot(ctx, WIDGET_LAYOUT);
      // A README and a non-ULID directory at the root must not enter the index.
      await fs.writeFile(path.join(root, "README.md"), "human readme");
      await fs.mkdir(path.join(root, "junk-dir"), { recursive: true });
      await fs.writeFile(path.join(root, "junk-dir", "widget.yaml"), toYaml({ name: "ghost" }));

      const result = await rebuildEntityIndex(ctx, WIDGET_LAYOUT, {
        loadEntity: async (rebuildCtx, loadUlid) =>
          readWidget(rebuildCtx, WIDGET_LAYOUT, loadUlid).catch(() => undefined),
        projectToIndexEntry: projectWidgetToIndexEntry,
      });

      expect(result.count).toBe(1);
      const rebuilt = await readYamlFile<Record<string, unknown>[]>(
        getEntityIndexPath(ctx, WIDGET_LAYOUT),
      );
      expect(rebuilt).toHaveLength(1);
      expect(rebuilt[0]._ulid).toBe(ulid);

      // Unknown sibling entries remain on disk.
      await expect(fs.stat(path.join(root, "README.md"))).resolves.toBeDefined();
      await expect(fs.stat(path.join(root, "junk-dir", "widget.yaml"))).resolves.toBeDefined();
    });

    // AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
    it("returns count 0 when there are no entity directories", async () => {
      await fs.mkdir(getStorageRoot(ctx, WIDGET_LAYOUT), { recursive: true });
      const result = await rebuildEntityIndex(ctx, WIDGET_LAYOUT, {
        loadEntity: async (_ctx, _ulid) => undefined,
        projectToIndexEntry: projectWidgetToIndexEntry,
      });
      expect(result.count).toBe(0);
      const rebuilt = await readYamlFile<unknown>(getEntityIndexPath(ctx, WIDGET_LAYOUT));
      expect(rebuilt).toEqual([]);
    });
  });
});
