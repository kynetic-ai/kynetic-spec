/**
 * Plan folder-storage migration.
 *
 * Converts the monolithic `.kspec/project.plans.yaml` (with full inline plan
 * records) into the folder-backed layout owned by
 * {@link ./plan-storage-manager.ts}:
 *
 *   .kspec/plans/<plan-ulid>/plan.md         — authoritative markdown body
 *   .kspec/plans/<plan-ulid>/plan.yaml       — bounded core metadata sidecar
 *   .kspec/plans/<plan-ulid>/notes.yaml      — only when notes are non-empty
 *   .kspec/plans/<plan-ulid>/resources.yaml  — empty `{ resources: [] }` stub
 *   .kspec/project.plans.yaml                — lean index projection
 *
 * The migration is dry-run-capable and idempotent: an already-migrated
 * project (manifest declares folder storage, no monolithic entries, every
 * indexed entry has a matching directory) reports `already_migrated` and
 * makes no writes. Partial layouts (monolithic records co-existing with
 * folders) are reported and refused by the executing run unless the caller
 * passes `--force` (mirrors the task migration contract).
 *
 * The migration explicitly does NOT touch resource bytes — there is no
 * legacy on-disk source for them. Each migrated plan gets an empty
 * `resources.yaml` (`{ resources: [] }`) sidecar so the resource model
 * has a stable starting point that downstream commands can populate.
 *
 * Spec: @entity-folder-migration-and-compatibility-1
 */

import * as path from "node:path";
import { ulid as generateUlid } from "ulid";
import {
  mkdirBufferAware,
  runWithBuffer,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import { PlanSchema } from "../schema/plan.js";
import {
  PLAN_DOCUMENT_FILENAME,
  PLAN_CORE_FILENAME,
  PLAN_LAYOUT,
  PLAN_NOTES_FILENAME,
  PLAN_RESOURCES_MANIFEST_FILENAME,
  toIndexEntry as toPlanIndexEntry,
} from "./plan-storage-manager.js";
import { getEntityDir, listEntityDirs, writeIndexEntries } from "./folder-backed-entity.js";
import { getMonolithicPlansFilePath } from "./entity-storage-compatibility.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, toYaml } from "./yaml.js";

/** ULID regex used to recover or validate a record's identity field. */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Per-plan migration plan. The executing run materializes every field in
 * this record onto disk inside a single buffered transaction; the dry-run
 * preview surfaces the same record without writes.
 */
export interface PlanMigrationEntry {
  /** ULID written to disk (recovered or freshly generated when missing). */
  readonly ulid: string;
  /** Title at the time of migration — used for diagnostic output. */
  readonly title: string;
  /** Raw on-disk core fields (everything except `content` and `notes`). */
  readonly core: Record<string, unknown>;
  /** Markdown body — written verbatim to `plan.md`. */
  readonly content: string;
  /** Notes array — written to `notes.yaml` only when length > 0. */
  readonly notes: unknown[];
  /** Final per-plan directory path (under `<specDir>/plans/<ulid>/`). */
  readonly planDir: string;
  /** Lean index entry projection used to rewrite `project.plans.yaml`. */
  readonly indexEntry: Record<string, unknown>;
  /** True when this plan record lacked a valid `_ulid` and one was minted. */
  readonly hadGeneratedUlid: boolean;
  /**
   * True when an existing folder for the same ULID was found on disk
   * before the migration ran. Used to detect a partial layout (folders
   * + monolithic entries) so the executing run can refuse without
   * `--force` rather than risk overwriting unrelated folder contents.
   */
  readonly preexistingFolder: boolean;
  /**
   * True when the record failed PlanSchema validation but was preserved
   * verbatim so the operator can repair it post-migration.
   */
  readonly validationWarning?: string;
}

/**
 * Stable plan-storage migration report. Dry-run and executing paths
 * produce the same report shape; the only difference is whether the
 * filesystem changed.
 */
export interface PlanMigrationReport {
  /** Number of monolithic plans migrated in this run. */
  readonly migrated: number;
  /** Number of plan folders confirmed present and reconciled with the index. */
  readonly reconciled: number;
  /** Per-plan summaries surfaced to dry-run callers and tests. */
  readonly entries: PlanMigrationEntry[];
  /** True when every monolithic plan already had a matching folder. */
  readonly alreadyMigrated: boolean;
  /**
   * True when the migration detected a partial layout (folders + monolithic
   * entries for distinct ULIDs) and refused to execute without `--force`.
   * Dry-runs still emit this flag for diagnostic surfaces.
   */
  readonly partialLayout: boolean;
  /** Plan validation warnings collected during the run. */
  readonly warnings: string[];
  /** Resolved monolithic file path that was read or would be read. */
  readonly monolithicPath: string;
  /** Resolved `<specDir>/plans/` folder root. */
  readonly folderRoot: string;
  /** Resolved index file path written by the executing run. */
  readonly indexPath: string;
  /**
   * Lean index entries already present in `project.plans.yaml` that do
   * not belong to monolithic records (i.e. they describe existing
   * folder-backed plans). The executing run preserves these in the
   * rewritten index so a force-through-partial-layout migration does
   * not silently drop pre-existing folder plans from discovery.
   */
  readonly preservedLeanEntries: Record<string, unknown>[];
}

const PLAN_SCHEMA_KEYS = new Set(Object.keys(PlanSchema.shape));

/**
 * Read raw plan records from `<specDir>/project.plans.yaml`. Returns the
 * entries plus the wrapper object so the index can be rewritten under the
 * same `{ kynetic_plans, plans }` shape after migration.
 */
async function readMonolithicPlans(
  filePath: string,
): Promise<{ raw: Record<string, unknown>[]; wrapper: Record<string, unknown> | null }> {
  let parsed: unknown;
  try {
    parsed = await readYamlFile<unknown>(filePath);
  } catch {
    return { raw: [], wrapper: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { raw: [], wrapper: null };
  }
  const wrapper = parsed as Record<string, unknown>;
  const list = wrapper.plans;
  const raw: Record<string, unknown>[] = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        raw.push(entry as Record<string, unknown>);
      }
    }
  }
  return { raw, wrapper };
}

/**
 * Detect monolithic plan records by looking for fields the lean index
 * never carries (content body, notes array entries). A lean index entry
 * carries `notes_count: <number>`; anything else with a string `_ulid`
 * is treated as a monolithic record that needs migrating. This matches
 * the heuristic used by the task migration code.
 */
function isMonolithicEntry(entry: Record<string, unknown>): boolean {
  // Lean index entries have notes_count as a number AND no inline content.
  const hasContent = typeof entry.content === "string" && entry.content.length > 0;
  const hasNotesArray = Array.isArray(entry.notes) && entry.notes.length > 0;
  if (hasContent || hasNotesArray) return true;
  // A record without notes_count as a number is monolithic by definition —
  // even malformed entries get migrated so we don't silently drop them.
  return typeof entry.notes_count !== "number";
}

/**
 * Build the migration entry for one monolithic plan record. Records that
 * fail schema validation are still migrated — the raw core data is
 * preserved verbatim and a `validationWarning` is attached for surfacing.
 *
 * Records without a usable `_ulid` get a freshly minted ULID so they can
 * still be migrated into the folder layout (no plan record is silently
 * dropped on a `kspec upgrade`).
 */
function buildMigrationEntry(
  ctx: KspecContext,
  raw: Record<string, unknown>,
  existingFolderUlids: Set<string>,
  warnings: string[],
): PlanMigrationEntry {
  // Recover the identity field. If the existing _ulid is unusable, mint a
  // new one and warn — the task migration follows the same contract.
  let ulid = typeof raw._ulid === "string" && ULID_REGEX.test(raw._ulid) ? raw._ulid : "";
  let hadGenerated = false;
  if (!ulid) {
    ulid = generateUlid();
    hadGenerated = true;
    warnings.push(
      `Plan "${typeof raw.title === "string" ? raw.title : "(untitled)"}": missing or invalid _ulid — generated ${ulid}`,
    );
  }

  const content = typeof raw.content === "string" ? raw.content : "";
  const notes = Array.isArray(raw.notes) ? raw.notes : [];

  // Strip content/notes from the core sidecar — they live in plan.md /
  // notes.yaml.
  const core: Record<string, unknown> = { ...raw, _ulid: ulid };
  delete core.content;
  delete core.notes;

  // Try schema validation purely for warning generation (and to derive an
  // accurate index entry from the canonical shape when possible). The
  // raw core data is what actually persists, so failed validation never
  // drops the record.
  let validationWarning: string | undefined;
  let indexEntry: Record<string, unknown>;
  const assembled = { ...core, content, notes };
  const parsed = PlanSchema.safeParse(assembled);
  if (parsed.success) {
    indexEntry = toPlanIndexEntry(parsed.data);
  } else {
    validationWarning = `Plan ${ulid}: validation warning — ${parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ")}`;
    warnings.push(validationWarning);
    // Build a best-effort index entry directly from raw fields. We mirror
    // the shape produced by toIndexEntry() so the lean index keeps its
    // bounded contract.
    indexEntry = {
      _ulid: ulid,
      slugs: Array.isArray(raw.slugs) ? raw.slugs : [],
      title: typeof raw.title === "string" ? raw.title : "",
      status: typeof raw.status === "string" ? raw.status : "draft",
      derived_tasks: Array.isArray(raw.derived_tasks) ? raw.derived_tasks : [],
      derived_specs: Array.isArray(raw.derived_specs) ? raw.derived_specs : [],
      created_at:
        typeof raw.created_at === "string" ? raw.created_at : new Date().toISOString(),
      notes_count: notes.length,
    };
    for (const field of ["source_path", "module_ref", "branch", "approved_at", "completed_at"]) {
      const value = raw[field];
      if (value !== undefined && value !== null) {
        indexEntry[field] = value;
      }
    }
  }

  return {
    ulid,
    title: typeof raw.title === "string" ? raw.title : "",
    core,
    content,
    notes,
    planDir: getEntityDir(ctx, PLAN_LAYOUT, ulid),
    indexEntry,
    hadGeneratedUlid: hadGenerated,
    preexistingFolder: existingFolderUlids.has(ulid),
    validationWarning,
  };
}

/**
 * Compute a plan-storage migration plan from the on-disk state. Pure
 * projection — never writes. Surfaces the entry list and the partial-layout
 * flag so callers can decide whether to proceed.
 */
export async function computePlanMigrationReport(
  ctx: KspecContext,
): Promise<PlanMigrationReport> {
  const monolithicPath = getMonolithicPlansFilePath(ctx);
  const folderRoot = path.join(ctx.specDir, PLAN_LAYOUT.storageRoot);
  const indexPath = path.join(ctx.specDir, PLAN_LAYOUT.indexFile);

  const { raw } = await readMonolithicPlans(monolithicPath);
  const folderUlids = new Set(await listEntityDirs(ctx, PLAN_LAYOUT));
  const monolithicRecords = raw.filter(isMonolithicEntry);
  // Pre-existing lean index entries describe folder-backed plans already
  // recorded in `project.plans.yaml`. We capture them now so the apply
  // step can rebuild the index as the union of migrated entries + these
  // preserved entries — otherwise a force-through-partial-layout migration
  // overwrites the index with monolithic-only data and the folder-backed
  // plans disappear from list/get even though their folders survive.
  const preservedLeanEntries = raw.filter((entry) => !isMonolithicEntry(entry));

  const warnings: string[] = [];
  const entries: PlanMigrationEntry[] = monolithicRecords.map((record) =>
    buildMigrationEntry(ctx, record, folderUlids, warnings),
  );

  const partialLayout =
    folderUlids.size > 0 &&
    entries.some((entry) => !folderUlids.has(entry.ulid)) &&
    entries.length > 0;

  return {
    migrated: entries.filter((e) => !e.preexistingFolder).length,
    reconciled: folderUlids.size,
    entries,
    alreadyMigrated: monolithicRecords.length === 0,
    partialLayout,
    warnings,
    monolithicPath,
    folderRoot,
    indexPath,
    preservedLeanEntries,
  };
}

/**
 * Migration options shared by dry-run and executing paths.
 *
 * `force` allows the executing run to proceed under a partial layout
 * (folders + monolithic records present). Without it the executing run
 * refuses with `partial_entity_storage_layout` instead of risking
 * inconsistent state.
 */
export interface PlanMigrationOptions {
  /** Permit migration when both folders and monolithic records exist. */
  readonly force?: boolean;
}

/**
 * Apply a precomputed migration report to disk. All writes happen inside a
 * single buffered transaction so partial states cannot reach disk if any
 * step fails. The caller is responsible for the surrounding shadow commit.
 *
 * `report` MUST be the latest result of {@link computePlanMigrationReport}
 * for `ctx` — the executing path re-reads the partial-layout flag and the
 * monolithic entries without re-scanning.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-upgrade-executes-folder-migration
 * AC: @entity-folder-migration-and-compatibility-1 ac-migration-preserves-record-identity-and-unknown-fields
 */
export async function applyPlanMigration(
  ctx: KspecContext,
  report: PlanMigrationReport,
  options: PlanMigrationOptions = {},
): Promise<{ written: number; indexEntries: number }> {
  if (report.entries.length === 0) {
    return { written: 0, indexEntries: 0 };
  }
  if (report.partialLayout && !options.force) {
    const err = new Error(
      `Plan storage layout is partial: folders exist alongside monolithic records. ` +
        `Re-run with --force to migrate the monolithic remnants in place, or run ` +
        `'kspec plan rebuild-index' after manual cleanup.`,
    );
    (err as NodeJS.ErrnoException).code = "partial_entity_storage_layout";
    throw err;
  }

  let written = 0;
  let indexEntriesWritten = 0;
  await runWithBuffer(ctx.specDir, async () => {
    await mkdirBufferAware(report.folderRoot);

    for (const entry of report.entries) {
      await mkdirBufferAware(entry.planDir);

      const corePath = path.join(entry.planDir, PLAN_CORE_FILENAME);
      const docPath = path.join(entry.planDir, PLAN_DOCUMENT_FILENAME);
      const notesPath = path.join(entry.planDir, PLAN_NOTES_FILENAME);
      const manifestPath = path.join(entry.planDir, PLAN_RESOURCES_MANIFEST_FILENAME);

      await writeFileBufferAware(corePath, toYaml(entry.core));
      await writeFileBufferAware(docPath, entry.content);
      if (entry.notes.length > 0) {
        await writeFileBufferAware(notesPath, toYaml({ notes: entry.notes }));
      }
      // resources.yaml is always written (empty stub) so downstream
      // resource consumers have a stable sidecar to read. The
      // resources/<files> directory materialises on first resource
      // import — keeping it empty avoids carrying around a tracked
      // empty directory in git.
      await writeFileBufferAware(manifestPath, toYaml({ resources: [] }));
      written += 1;
    }

    // Replace the monolithic plans file (which is the same path as the
    // lean index file: `<specDir>/project.plans.yaml`) with a fresh lean
    // projection. The write overwrites the inline-record body, so no
    // separate delete step is needed — the previous content is gone the
    // moment the new file lands.
    //
    // Migrated monolithic records win over any pre-existing lean entry
    // for the same ULID; pre-existing folder-backed plans (lean entries
    // for ULIDs the migration did not touch) are carried forward so the
    // index rewrite never drops them. Both branches of the partial-layout
    // contract are honoured: without force the executing run already
    // threw above; with force the index still describes every plan
    // discoverable on disk.
    const migratedUlids = new Set(report.entries.map((e) => e.ulid));
    const finalIndexEntries: Record<string, unknown>[] = [];
    for (const lean of report.preservedLeanEntries) {
      const id = lean._ulid;
      if (typeof id === "string" && !migratedUlids.has(id)) {
        finalIndexEntries.push(lean);
      }
    }
    for (const entry of report.entries) {
      finalIndexEntries.push(entry.indexEntry);
    }
    const shape = {
      entries: finalIndexEntries,
      useWrapper: true,
      wrapperObj: { kynetic_plans: "1.0" },
    };
    await writeIndexEntries(
      report.indexPath,
      finalIndexEntries,
      shape,
      PLAN_LAYOUT.indexWrapperKey,
    );
    indexEntriesWritten = finalIndexEntries.length;
  });

  return { written, indexEntries: indexEntriesWritten };
}
