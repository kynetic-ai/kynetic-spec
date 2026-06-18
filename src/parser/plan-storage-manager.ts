/**
 * Folder-backed plan storage manager.
 *
 * Plans are stored as folder-backed entities under `<specDir>/plans/<plan-ulid>/`:
 *
 *   plan.yaml       — authoritative bounded plan metadata (identity, status,
 *                     source_path, module_ref, branch, derived refs, timestamps)
 *   plan.md         — authoritative source for the plan's markdown document
 *   notes.yaml      — optional sidecar carrying `{ notes: [...] }`
 *   resources.yaml  — optional resource manifest (owned by the resource model)
 *   resources/      — optional local resource files
 *
 * The lean index at `<specDir>/project.plans.yaml` carries a bounded
 * projection of each plan's identity, lifecycle, and relationship fields —
 * no markdown body, no note content, no resource file bytes.
 *
 * Spec: @folder-backed-plan-storage-1
 *       @trait-folder-backed-entity-1
 *       @trait-entity-scoped-local-resources-1 (sidecar preservation only;
 *           resource semantics ship in a sibling task)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Plan } from "../schema/plan.js";
import { PlanSchema } from "../schema/plan.js";
import {
  type FolderBackedEntityLayout,
  getEntityDir,
  getEntityFilePath,
  getEntityIndexPath,
  getStorageRoot,
  indexEntriesEqualForFields,
  listEntityDirs,
  mergePreservingRawShape,
  readIndexEntries,
  rebuildEntityIndex,
  writeIndexEntries,
} from "./folder-backed-entity.js";
import {
  getActiveBatchBuffer,
  mkdirBufferAware,
  runWithBuffer,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import {
  EntityStorageCompatibilityError,
  PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
  describeStrictManifestIncompatibility,
  requirePlanFolderStorage,
} from "./entity-storage-compatibility.js";
import { withFileLock } from "./file-lock.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, toYaml } from "./yaml.js";

/**
 * Loaded plan with runtime metadata. Matches the shape exposed by the
 * monolithic parser so consumer code can switch backends transparently.
 */
export interface LoadedPlan extends Plan {
  _sourceFile?: string;
}

// ── Layout ────────────────────────────────────────────────────────────────────

/**
 * Plan storage layout — `<specDir>/plans/<plan-ulid>/...` with a lean index
 * at `<specDir>/project.plans.yaml`. The wrapper key `plans` is preserved
 * across read/write so the canonical `{ kynetic_plans, plans }` shape
 * round-trips.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 */
export const PLAN_LAYOUT: FolderBackedEntityLayout = {
  entityType: "plan",
  storageRoot: "plans",
  indexFile: "project.plans.yaml",
  indexWrapperKey: "plans",
};

/** Filename for the per-plan core metadata sidecar. */
export const PLAN_CORE_FILENAME = "plan.yaml";
/** Filename for the per-plan markdown document sidecar. */
export const PLAN_DOCUMENT_FILENAME = "plan.md";
/** Filename for the per-plan notes sidecar. */
export const PLAN_NOTES_FILENAME = "notes.yaml";
/** Filename for the per-plan resource manifest sidecar. */
export const PLAN_RESOURCES_MANIFEST_FILENAME = "resources.yaml";
/** Directory name for per-plan resource files. */
export const PLAN_RESOURCES_DIR = "resources";

// ── Path Helpers ─────────────────────────────────────────────────────────────

/** Root directory that holds all per-plan directories (`<specDir>/plans/`). */
export function getPlansFolderRoot(ctx: KspecContext): string {
  return getStorageRoot(ctx, PLAN_LAYOUT);
}

/** Directory for a single plan (`<specDir>/plans/<ulid>/`). */
export function getPlanDir(ctx: KspecContext, ulid: string): string {
  return getEntityDir(ctx, PLAN_LAYOUT, ulid);
}

/** Path to a plan's core metadata sidecar (`plan.yaml`). */
export function getPlanCoreFilePath(ctx: KspecContext, ulid: string): string {
  return getEntityFilePath(ctx, PLAN_LAYOUT, ulid, PLAN_CORE_FILENAME);
}

/** Path to a plan's markdown document (`plan.md`). */
export function getPlanDocumentFilePath(ctx: KspecContext, ulid: string): string {
  return getEntityFilePath(ctx, PLAN_LAYOUT, ulid, PLAN_DOCUMENT_FILENAME);
}

/** Path to a plan's notes sidecar (`notes.yaml`). */
export function getPlanNotesFilePath(ctx: KspecContext, ulid: string): string {
  return getEntityFilePath(ctx, PLAN_LAYOUT, ulid, PLAN_NOTES_FILENAME);
}

/** Path to a plan's lean index file (`<specDir>/project.plans.yaml`). */
export function getPlanIndexFilePath(ctx: KspecContext): string {
  return getEntityIndexPath(ctx, PLAN_LAYOUT);
}

// ── Index Projection ─────────────────────────────────────────────────────────

/**
 * Resource summary projected into the lean index — bounded counts only,
 * never resource file bytes or preview content.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export interface PlanResourceSummary {
  count: number;
  total_bytes: number;
}

/**
 * Bounded set of indexed fields. These are the only fields that survive into
 * `project.plans.yaml`. Markdown body (`content`) and the full notes array
 * are explicitly excluded.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
const INDEXED_FIELDS = [
  "_ulid",
  "slugs",
  "title",
  "status",
  "source_path",
  "module_ref",
  "branch",
  "derived_tasks",
  "derived_specs",
  "created_at",
  "approved_at",
  "completed_at",
  "notes_count",
  "current_revision",
  "resource_summary",
] as const;

/**
 * Compute a resource summary from a plan's `resources.yaml` sidecar without
 * reading any resource file bytes. Returns `undefined` when the manifest is
 * absent so the index entry omits the field instead of carrying empty data.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 * AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
 */
async function readResourceSummary(
  ctx: KspecContext,
  ulid: string,
): Promise<PlanResourceSummary | undefined> {
  const manifestPath = path.join(getPlanDir(ctx, ulid), PLAN_RESOURCES_MANIFEST_FILENAME);
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(manifestPath);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") {
    return { count: 0, total_bytes: 0 };
  }
  const resources = (raw as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) {
    return { count: 0, total_bytes: 0 };
  }
  let total = 0;
  for (const entry of resources) {
    if (entry && typeof entry === "object") {
      const bytes = (entry as Record<string, unknown>).bytes;
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) {
        total += bytes;
      }
    }
  }
  return { count: resources.length, total_bytes: total };
}

/**
 * Project a loaded plan to its index entry. Optional fields are omitted
 * (rather than emitted as `null`) so the YAML index stays compact and
 * round-trips without spurious diff churn.
 *
 * Counts are persisted as scalars (notes_count) — the full notes array
 * lives in the per-plan `notes.yaml` sidecar.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 */
export function toIndexEntry(
  plan: Plan,
  resourceSummary?: PlanResourceSummary,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    _ulid: plan._ulid,
    slugs: plan.slugs,
    title: plan.title,
    status: plan.status,
    derived_tasks: plan.derived_tasks,
    derived_specs: plan.derived_specs,
    created_at: plan.created_at,
    notes_count: Array.isArray(plan.notes) ? plan.notes.length : 0,
  };

  if (plan.source_path !== undefined && plan.source_path !== null) {
    entry.source_path = plan.source_path;
  }
  if (plan.module_ref !== undefined && plan.module_ref !== null) {
    entry.module_ref = plan.module_ref;
  }
  if (plan.branch !== undefined && plan.branch !== null) {
    entry.branch = plan.branch;
  }
  if (plan.approved_at) {
    entry.approved_at = plan.approved_at;
  }
  if (plan.completed_at) {
    entry.completed_at = plan.completed_at;
  }
  if ((plan.revisions ?? []).length > 0) {
    entry.current_revision = plan.revisions?.at(-1)?.ordinal;
  }
  if (resourceSummary) {
    entry.resource_summary = { ...resourceSummary };
  }

  return entry;
}

/**
 * Compare two index entries for equality on the bounded indexed-field set.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-excludes-heavy-detail-bytes
 * AC: @trait-folder-backed-entity-1 ac-semantic-defaults-do-not-drift
 */
export function indexEntriesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (
    !indexEntriesEqualForFields(
      a,
      b,
      INDEXED_FIELDS.filter((f) => f !== "resource_summary"),
    )
  ) {
    return false;
  }
  // resource_summary is a nested object; compare structurally. An omitted
  // summary and an explicit `{count:0, total_bytes:0}` summary describe the
  // same empty state — treat them as semantically equal so a freshly
  // migrated index entry (no summary) and a rebuilt entry (zero-resource
  // summary computed from an empty `resources.yaml`) do not flap as drift.
  return resourceSummariesEqual(
    a.resource_summary as PlanResourceSummary | undefined,
    b.resource_summary as PlanResourceSummary | undefined,
  );
}

function isEmptyResourceSummary(s: PlanResourceSummary | undefined): boolean {
  return s === undefined || (s.count === 0 && s.total_bytes === 0);
}

function resourceSummariesEqual(
  a: PlanResourceSummary | undefined,
  b: PlanResourceSummary | undefined,
): boolean {
  if (isEmptyResourceSummary(a) && isEmptyResourceSummary(b)) return true;
  if (a === undefined || b === undefined) return false;
  return a.count === b.count && a.total_bytes === b.total_bytes;
}

// ── Core / Notes / Document File Helpers ────────────────────────────────────

const PLAN_SCHEMA_KEYS: ReadonlySet<string> = new Set(Object.keys(PlanSchema.shape));

/**
 * Project a plan record to the fields that belong in `plan.yaml` (everything
 * except the markdown body, which lives in `plan.md`, and the notes array,
 * which lives in `notes.yaml`). `_sourceFile` is runtime-only metadata.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
 * AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
 */
function toCoreData(plan: LoadedPlan): Record<string, unknown> {
  const { _sourceFile: _sf, content: _content, notes: _notes, ...rest } = plan;
  const core: Record<string, unknown> = { ...rest };
  if (Array.isArray(core.revisions) && core.revisions.length === 0) {
    delete core.revisions;
  }
  return core as Record<string, unknown>;
}

/**
 * Read the markdown document for a plan. Returns the file contents when
 * present. Returns `undefined` when the file does not exist so callers can
 * distinguish "missing required sidecar" (partial layout) from "empty body".
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
 */
async function readPlanDocument(ctx: KspecContext, ulid: string): Promise<string | undefined> {
  const docPath = getPlanDocumentFilePath(ctx, ulid);
  try {
    return await fs.readFile(docPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * Build the deterministic partial-layout incompatibility for a plan folder
 * that exists with `plan.yaml` but is missing the authoritative `plan.md`
 * sidecar. The folder layout requires both sidecars; falling back to an
 * empty document would silently drop the plan body, violating
 * ac-plan-document-sidecar-is-authoritative.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 * AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
 */
function missingPlanDocumentError(
  ctx: KspecContext,
  ulid: string,
): EntityStorageCompatibilityError {
  const planDir = getPlanDir(ctx, ulid);
  return new EntityStorageCompatibilityError(
    `Plan folder ${ulid} is missing its authoritative plan.md sidecar at ${planDir}. ` +
      `Folder-backed plan storage requires both plan.yaml and plan.md.`,
    {
      code: PARTIAL_ENTITY_STORAGE_LAYOUT_CODE,
      domain: "plans",
      suggestion:
        'Restore plan.md from version control, or run "kspec upgrade" to repair the folder layout.',
      field: "plan_storage.format",
      cacheDomain: "plans",
    },
  );
}

/** Read the notes sidecar for a plan, returning [] when absent. */
async function readPlanNotes(ctx: KspecContext, ulid: string): Promise<unknown[]> {
  const notesPath = getPlanNotesFilePath(ctx, ulid);
  try {
    const raw = await readYamlFile<unknown>(notesPath);
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).notes)) {
      return (raw as Record<string, unknown>).notes as unknown[];
    }
  } catch {
    // Missing or unreadable — treat as zero notes.
  }
  return [];
}

/**
 * Read the raw core sidecar object (no schema validation) so mutation
 * helpers can preserve forward-compatible extension fields.
 */
async function readRawCore(
  ctx: KspecContext,
  ulid: string,
): Promise<Record<string, unknown> | null> {
  const corePath = getPlanCoreFilePath(ctx, ulid);
  try {
    const raw = await readYamlFile<unknown>(corePath);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // missing
  }
  return null;
}

/**
 * Assemble a `LoadedPlan` from sidecar files. Returns `undefined` when the
 * core metadata is missing or schema-invalid — that plan is dropped from
 * listings rather than surfacing partial data.
 *
 * Raises `EntityStorageCompatibilityError` with `partial_entity_storage_layout`
 * when `plan.yaml` exists but the authoritative `plan.md` sidecar is missing.
 * Callers (loadPlansFromFolders, mutate, save) propagate this error; the
 * rebuild-index diagnostic converts it into a structured conflict instead of
 * a thrown error.
 *
 * Implements the document-sidecar authority rule: when core metadata and
 * `plan.md` disagree on the markdown body, `plan.md` wins.
 *
 * Attaches the bounded `resource_summary` (count + total_bytes) read from
 * the per-plan `resources.yaml` sidecar so cache projections and the
 * cache-ready list route can surface resource presence without re-reading
 * sidecars on hot paths.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
 * AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
async function loadPlanFromDir(ctx: KspecContext, ulid: string): Promise<LoadedPlan | undefined> {
  const rawCore = await readRawCore(ctx, ulid);
  if (!rawCore) {
    return undefined;
  }
  const documentContent = await readPlanDocument(ctx, ulid);
  if (documentContent === undefined) {
    throw missingPlanDocumentError(ctx, ulid);
  }
  const notes = await readPlanNotes(ctx, ulid);

  // plan.md is authoritative for content.
  const assembled = { ...rawCore, content: documentContent, notes };
  const parsed = PlanSchema.safeParse(assembled);
  if (!parsed.success) {
    return undefined;
  }
  const resourceSummary = await readResourceSummary(ctx, ulid);
  const loaded: LoadedPlan = {
    ...parsed.data,
    _sourceFile: getPlanCoreFilePath(ctx, ulid),
  };
  if (resourceSummary) {
    (loaded as LoadedPlan & { resource_summary: PlanResourceSummary }).resource_summary = {
      count: resourceSummary.count,
      total_bytes: resourceSummary.total_bytes,
    };
  }
  return loaded;
}

/** Write `plan.yaml`, preserving unknown extension fields. */
async function writeCoreFile(
  filePath: string,
  core: Record<string, unknown>,
  rawCore: Record<string, unknown> | null,
): Promise<void> {
  const merged = rawCore ? mergePreservingRawShape(rawCore, core, PLAN_SCHEMA_KEYS) : core;
  await writeFileBufferAware(filePath, toYaml(merged));
}

/** Write `plan.md` verbatim. */
async function writeDocumentFile(filePath: string, content: string): Promise<void> {
  await writeFileBufferAware(filePath, content);
}

/** Write `notes.yaml` as `{ notes: [...] }`. */
async function writeNotesFile(filePath: string, notes: unknown[]): Promise<void> {
  await writeFileBufferAware(filePath, toYaml({ notes }));
}

/**
 * Remove the notes sidecar — used when a mutation clears the notes array so
 * detail reads do not surface stale notes. Buffer-aware so the deletion
 * participates in the surrounding batch transaction; otherwise calls
 * `fs.rm` with `force: true` (no error when the file is already absent).
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
 */
async function removeNotesFileIfPresent(notesPath: string): Promise<void> {
  const buffer = getActiveBatchBuffer();
  if (buffer?.isInScope(notesPath)) {
    buffer.delete(notesPath);
    return;
  }
  await fs.rm(notesPath, { force: true });
}

// ── Public Manager API ──────────────────────────────────────────────────────

/**
 * List all plans by reading the lean index. The cache (if present and ready)
 * is consulted first so the daemon can serve list/detail surfaces without a
 * disk read on hot paths.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 */
export async function loadPlansFromFolders(ctx: KspecContext): Promise<LoadedPlan[]> {
  await requirePlanFolderStorage(ctx);

  // Cache hit path: same shape as the monolithic loader so daemon cache
  // consumers don't change.
  const { getEntityCacheContext } = await import("./yaml.js");
  const cacheContext = getEntityCacheContext();
  if (cacheContext) {
    const cache = cacheContext.cacheAccessor(cacheContext.projectPath) as
      | {
          getDomainState?(domain: string): string | null | undefined;
          getPlansIndex?(): Array<{ _ulid: string }> | null;
          getPlanDetail?(ulid: string): LoadedPlan | null;
        }
      | null
      | undefined;
    if (cache?.getDomainState?.("plans") === "ready") {
      const planIndex = cache.getPlansIndex?.();
      if (planIndex) {
        const cachedPlans = planIndex
          .map((plan) => cache.getPlanDetail?.(plan._ulid) ?? null)
          .filter((plan): plan is LoadedPlan => plan !== null);
        if (cachedPlans.length === planIndex.length) {
          return cachedPlans;
        }
      }
    }
  }

  const ulids = await listEntityDirs(ctx, PLAN_LAYOUT);
  const plans: LoadedPlan[] = [];
  for (const ulid of ulids) {
    const plan = await loadPlanFromDir(ctx, ulid);
    if (plan) {
      plans.push(plan);
    }
  }
  return plans;
}

/**
 * Resolve a plan by ULID, short ULID, or slug. Matches the monolithic
 * loader's semantics so callers do not need to know which backend served
 * the lookup.
 */
export async function findPlanByRefInFolders(
  ctx: KspecContext,
  ref: string,
): Promise<LoadedPlan | undefined> {
  const plans = await loadPlansFromFolders(ctx);
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;
  return plans.find(
    (p) =>
      p._ulid === cleanRef ||
      p._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()) ||
      p.slugs.includes(cleanRef),
  );
}

/**
 * Create or update a single plan. The plan body is written to `plan.md`,
 * the metadata sidecar to `plan.yaml`, the optional notes sidecar to
 * `notes.yaml`, and the lean index entry to `project.plans.yaml`. All
 * writes happen inside a single buffered transaction so partial states
 * cannot reach disk if any step fails.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-document-sidecar-is-authoritative
 * AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 */
export async function savePlanToFolder(ctx: KspecContext, plan: LoadedPlan): Promise<void> {
  await requirePlanFolderStorage(ctx);

  const planDir = getPlanDir(ctx, plan._ulid);
  const corePath = getPlanCoreFilePath(ctx, plan._ulid);
  const docPath = getPlanDocumentFilePath(ctx, plan._ulid);
  const notesPath = getPlanNotesFilePath(ctx, plan._ulid);
  const indexPath = getPlanIndexFilePath(ctx);

  await withFileLock(indexPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      await mkdirBufferAware(planDir);

      const rawCore = await readRawCore(ctx, plan._ulid);
      const core = toCoreData(plan);
      await writeCoreFile(corePath, core, rawCore);
      await writeDocumentFile(docPath, plan.content);

      // notes.yaml is authoritative when notes exist and must be removed when
      // a mutation clears them — otherwise a stale sidecar would re-surface
      // deleted notes on the next detail read.
      if (plan.notes && plan.notes.length > 0) {
        await writeNotesFile(notesPath, plan.notes);
      } else {
        await removeNotesFileIfPresent(notesPath);
      }

      const resourceSummary = await readResourceSummary(ctx, plan._ulid);
      const entry = toIndexEntry(plan, resourceSummary);
      await upsertIndexEntry(indexPath, entry);
    });
  });
}

/**
 * Atomically mutate an existing plan. The callback receives the latest
 * on-disk state (so concurrent writers do not clobber unrelated fields)
 * and returns the desired post-mutation plan; the manager handles all
 * file writes and the bounded index update.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-metadata-sidecar-is-authoritative
 */
export async function mutatePlanInFolder(
  ctx: KspecContext,
  plan: LoadedPlan,
  mutate: (latestPlan: LoadedPlan) => Plan | LoadedPlan | Promise<Plan | LoadedPlan>,
): Promise<LoadedPlan> {
  // mutate cannot introduce drift — only the compatibility gate fires
  // (the writable gate would reject in-place updates under consistent
  // folder layouts).
  await requirePlanFolderStorage(ctx);

  const corePath = getPlanCoreFilePath(ctx, plan._ulid);
  const docPath = getPlanDocumentFilePath(ctx, plan._ulid);
  const notesPath = getPlanNotesFilePath(ctx, plan._ulid);
  const indexPath = getPlanIndexFilePath(ctx);

  let result: LoadedPlan | undefined;
  await withFileLock(indexPath, async () => {
    const latest = await loadPlanFromDir(ctx, plan._ulid);
    if (!latest) {
      throw new Error(`Plan not found in folder storage: ${plan._ulid}`);
    }

    const mutated = await mutate(latest);
    if (mutated._ulid !== latest._ulid) {
      throw new Error(
        `Mutation must not change a plan's ULID. Original: ${latest._ulid}, received: ${mutated._ulid}`,
      );
    }
    const clean: LoadedPlan = { ...(mutated as LoadedPlan) };
    delete clean._sourceFile;

    await runWithBuffer(ctx.specDir, async () => {
      const rawCore = await readRawCore(ctx, plan._ulid);
      const core = toCoreData(clean);
      await writeCoreFile(corePath, core, rawCore);
      await writeDocumentFile(docPath, clean.content);

      // Clearing the notes array must drop the sidecar so detail reads do
      // not return stale notes after a mutation. Without this, a mutation
      // returning `notes: []` would leave the previous notes.yaml on disk
      // and `loadPlanFromDir` would still surface the deleted entries.
      if (clean.notes && clean.notes.length > 0) {
        await writeNotesFile(notesPath, clean.notes);
      } else {
        await removeNotesFileIfPresent(notesPath);
      }

      const oldEntry = toIndexEntry(latest, await readResourceSummary(ctx, plan._ulid));
      const newSummary = await readResourceSummary(ctx, plan._ulid);
      const newEntry = toIndexEntry(clean, newSummary);
      if (!indexEntriesEqual(oldEntry, newEntry)) {
        await upsertIndexEntry(indexPath, newEntry);
      }
    });

    result = { ...clean, _sourceFile: corePath };
  });

  if (!result) {
    throw new Error(`Failed to mutate plan atomically: ${plan._ulid}`);
  }
  return result;
}

/**
 * Refresh a plan's bounded index entry from authoritative folder state.
 *
 * Reads the latest plan sidecar files (plan.yaml / plan.md / notes.yaml)
 * and resource manifest, projects to the bounded index entry, and upserts
 * it under the same file lock + buffered transaction the rest of the
 * manager uses. Callers that mutate the on-disk plan folder outside the
 * `savePlanToFolder` / `mutatePlanInFolder` paths (e.g. resource manifest
 * writers in CLI handlers and sibling-resource import) MUST call this
 * helper after the folder write so the lean index is updated as part of
 * the same logical atomic mutation. Without it, `project.plans.yaml`
 * lags behind the folder until a manual `rebuild-index` runs.
 *
 * Returns silently when the plan folder is missing or unloadable —
 * matching the rebuild-index contract that drops unrecoverable folders
 * from the index rather than throwing.
 *
 * AC: @trait-folder-backed-entity-1 ac-indexed-mutation-updates-index
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 */
export async function refreshPlanIndexEntry(ctx: KspecContext, ulid: string): Promise<void> {
  await requirePlanFolderStorage(ctx);
  const indexPath = getPlanIndexFilePath(ctx);
  await withFileLock(indexPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      const plan = await loadPlanFromDir(ctx, ulid);
      if (!plan) return;
      const summary = await readResourceSummary(ctx, ulid);
      const entry = toIndexEntry(plan, summary);
      await upsertIndexEntry(indexPath, entry);
    });
  });
}

/**
 * Remove a plan: delete its directory (and everything underneath it,
 * including owned resource files) and its index entry in one logical
 * shadow mutation.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-delete-removes-owned-folder
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-delete-follows-owner-delete
 */
export async function deletePlanFromFolder(ctx: KspecContext, ulid: string): Promise<void> {
  await requirePlanFolderStorage(ctx);

  const planDir = getPlanDir(ctx, ulid);
  const indexPath = getPlanIndexFilePath(ctx);

  // Verify the plan actually exists before queueing destructive writes —
  // matches the ENOENT contract of the monolithic delete path.
  try {
    await fs.access(planDir);
  } catch {
    const err = new Error(`Plan not found: ${ulid}`);
    (err as NodeJS.ErrnoException).code = "ENOENT";
    throw err;
  }

  await withFileLock(indexPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      const buffer = getActiveBatchBuffer();
      if (buffer) {
        buffer.deleteDirectory(planDir);
      } else {
        await fs.rm(planDir, { recursive: true, force: true });
      }
      await removeFromIndex(indexPath, ulid);
    });
  });
}

// ── Index Mutation Helpers ───────────────────────────────────────────────────

/**
 * Insert or replace a plan's entry in the lean index, preserving the on-disk
 * wrapper shape so sibling keys (e.g. `kynetic_plans` version) survive.
 *
 * AC: @trait-folder-backed-entity-1 ac-unknown-files-preserved
 */
async function upsertIndexEntry(indexPath: string, entry: Record<string, unknown>): Promise<void> {
  const shape = await readIndexEntries(indexPath, PLAN_LAYOUT.indexWrapperKey);
  const updated = [...shape.entries];
  const existing = updated.findIndex(
    (e) => e && typeof e === "object" && (e as Record<string, unknown>)._ulid === entry._ulid,
  );
  if (existing >= 0) {
    updated[existing] = entry;
  } else {
    updated.push(entry);
  }
  // Preserve canonical `{ kynetic_plans, plans }` wrapper even when the index
  // file does not yet exist — the monolithic writer used the same default.
  const shapeWithWrapper =
    shape.useWrapper || shape.wrapperObj
      ? shape
      : { entries: shape.entries, useWrapper: true, wrapperObj: { kynetic_plans: "1.0" } };
  await writeIndexEntries(indexPath, updated, shapeWithWrapper, PLAN_LAYOUT.indexWrapperKey);
}

/** Remove a plan's index entry; preserves the wrapper shape. */
async function removeFromIndex(indexPath: string, ulid: string): Promise<void> {
  const shape = await readIndexEntries(indexPath, PLAN_LAYOUT.indexWrapperKey);
  if (shape.entries.length === 0 && !shape.useWrapper) {
    return;
  }
  const filtered = shape.entries.filter(
    (e) => !(e && typeof e === "object" && (e as Record<string, unknown>)._ulid === ulid),
  );
  await writeIndexEntries(indexPath, filtered, shape, PLAN_LAYOUT.indexWrapperKey);
}

// ── Index Rebuild ────────────────────────────────────────────────────────────

/**
 * Describes a single change relative to the on-disk index.
 *
 * - `add`        — a plan folder exists but the index has no matching entry
 * - `update`     — the folder and index entry differ on at least one
 *                  indexed field
 * - `remove_stale` — an index entry has no matching plan folder; safe to
 *                  drop only when the caller explicitly requested `--force`
 */
export type PlanIndexChange = {
  kind: "add" | "update" | "remove_stale";
  ref: string;
  path: string;
};

/**
 * Description of a non-recoverable conflict surfaced by `rebuild-index`.
 *
 * Stale entries without `--force` are reported with code
 * `stale_index_entry_without_force`; folders that fail to load are
 * reported with code `unloadable_plan_folder`.
 */
export type PlanIndexConflict = {
  code: string;
  ref: string | null;
  path: string | null;
  message: string;
};

export interface PlanRebuildReport {
  changes: PlanIndexChange[];
  conflicts: PlanIndexConflict[];
  folders: number;
  indexEntries: number;
  added: number;
  updated: number;
  removedStale: number;
}

/**
 * Compute the drift between the lean index and the per-plan folders without
 * touching disk beyond reads. Pure projection — callers decide whether to
 * surface, repair, or block based on the report and CLI flags.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 */
export async function computePlanIndexDrift(
  ctx: KspecContext,
  options: { force?: boolean } = {},
): Promise<PlanRebuildReport> {
  // Manifest-only check — drift detection runs *because* the layout may be
  // partial; running the partial-layout gate here would defeat the purpose
  // of the rebuild-index path.
  const manifestErr = describeStrictManifestIncompatibility(ctx.manifest, "plans");
  if (manifestErr) throw manifestErr;

  const indexPath = getPlanIndexFilePath(ctx);
  const shape = await readIndexEntries(indexPath, PLAN_LAYOUT.indexWrapperKey);
  const indexByUlid = new Map<string, Record<string, unknown>>();
  for (const entry of shape.entries) {
    if (entry && typeof entry === "object") {
      const id = (entry as Record<string, unknown>)._ulid;
      if (typeof id === "string" && id.length > 0) {
        indexByUlid.set(id, entry as Record<string, unknown>);
      }
    }
  }

  const folderUlids = await listEntityDirs(ctx, PLAN_LAYOUT);
  const folderSet = new Set(folderUlids);

  const changes: PlanIndexChange[] = [];
  const conflicts: PlanIndexConflict[] = [];

  for (const ulid of folderUlids) {
    const planDir = getPlanDir(ctx, ulid);
    let plan: LoadedPlan | undefined;
    try {
      plan = await loadPlanFromDir(ctx, ulid);
    } catch (err) {
      if (err instanceof EntityStorageCompatibilityError) {
        conflicts.push({
          code: err.code,
          ref: ulid,
          path: planDir,
          message: err.message,
        });
        continue;
      }
      throw err;
    }
    if (!plan) {
      conflicts.push({
        code: "unloadable_plan_folder",
        ref: ulid,
        path: planDir,
        message: `Plan folder ${ulid} could not be loaded (missing or invalid plan.yaml).`,
      });
      continue;
    }
    const summary = await readResourceSummary(ctx, ulid);
    const rebuiltEntry = toIndexEntry(plan, summary);
    const existingEntry = indexByUlid.get(ulid);
    if (!existingEntry) {
      changes.push({ kind: "add", ref: ulid, path: planDir });
    } else if (!indexEntriesEqual(existingEntry, rebuiltEntry)) {
      changes.push({ kind: "update", ref: ulid, path: planDir });
    }
  }

  for (const [ulid, _entry] of indexByUlid) {
    if (!folderSet.has(ulid)) {
      const planDir = getPlanDir(ctx, ulid);
      if (options.force) {
        changes.push({ kind: "remove_stale", ref: ulid, path: planDir });
      } else {
        conflicts.push({
          code: "stale_index_entry_without_force",
          ref: ulid,
          path: planDir,
          message: `Index entry ${ulid} has no matching plan folder. Re-run with --force to drop stale entries.`,
        });
      }
    }
  }

  const added = changes.filter((c) => c.kind === "add").length;
  const updated = changes.filter((c) => c.kind === "update").length;
  const removedStale = changes.filter((c) => c.kind === "remove_stale").length;

  return {
    changes,
    conflicts,
    folders: folderUlids.length,
    indexEntries: indexByUlid.size,
    added,
    updated,
    removedStale,
  };
}

/**
 * Rewrite the lean index from per-plan folders. Used by
 * `kspec plan rebuild-index --repair`. Stale entries are dropped only when
 * `options.force` is true; without it, `computePlanIndexDrift` would have
 * surfaced a conflict and the caller should refuse to call this.
 *
 * AC: @trait-folder-backed-entity-1 ac-index-rebuilds-from-folders
 */
export async function rebuildPlanIndex(
  ctx: KspecContext,
  options: { force?: boolean } = {},
): Promise<{ count: number }> {
  // Manifest-only check — see computePlanIndexDrift for the rationale.
  const manifestErr = describeStrictManifestIncompatibility(ctx.manifest, "plans");
  if (manifestErr) throw manifestErr;
  const indexPath = getPlanIndexFilePath(ctx);

  return await withFileLock(indexPath, async () => {
    if (options.force) {
      // Force path — drop everything and project from folders verbatim.
      return rebuildEntityIndex<LoadedPlan>(ctx, PLAN_LAYOUT, {
        loadEntity: (rebuildCtx, ulid) => loadPlanFromDir(rebuildCtx, ulid),
        projectToIndexEntry: (plan) => {
          // resource summary is read synchronously in the project step is
          // not supported; rebuildEntityIndex serialises loads, so we
          // bake the summary into a second pass below.
          return toIndexEntry(plan);
        },
      }).then(async (result) => {
        // Second pass to fold in resource summaries (which require an
        // async read of resources.yaml per folder).
        await foldResourceSummariesIntoIndex(ctx, indexPath);
        return result;
      });
    }

    // Non-force path — preserve stale entries instead of dropping them.
    // The CLI gate guarantees we only get here when drift can be fully
    // resolved without --force.
    const shape = await readIndexEntries(indexPath, PLAN_LAYOUT.indexWrapperKey);
    const indexByUlid = new Map<string, Record<string, unknown>>();
    for (const entry of shape.entries) {
      if (entry && typeof entry === "object") {
        const id = (entry as Record<string, unknown>)._ulid;
        if (typeof id === "string" && id.length > 0) {
          indexByUlid.set(id, entry as Record<string, unknown>);
        }
      }
    }
    const folderUlids = await listEntityDirs(ctx, PLAN_LAYOUT);
    for (const ulid of folderUlids) {
      const plan = await loadPlanFromDir(ctx, ulid);
      if (!plan) continue;
      const summary = await readResourceSummary(ctx, ulid);
      indexByUlid.set(ulid, toIndexEntry(plan, summary));
    }
    const updated = [...indexByUlid.values()];
    const shapeWithWrapper =
      shape.useWrapper || shape.wrapperObj
        ? shape
        : { entries: shape.entries, useWrapper: true, wrapperObj: { kynetic_plans: "1.0" } };
    await writeIndexEntries(indexPath, updated, shapeWithWrapper, PLAN_LAYOUT.indexWrapperKey);
    return { count: updated.length };
  });
}

/**
 * Re-project each entry with its current resource summary. Used after a
 * --force rebuild because `rebuildEntityIndex` only supports synchronous
 * projection callbacks.
 */
async function foldResourceSummariesIntoIndex(ctx: KspecContext, indexPath: string): Promise<void> {
  const shape = await readIndexEntries(indexPath, PLAN_LAYOUT.indexWrapperKey);
  const updated: Record<string, unknown>[] = [];
  for (const raw of shape.entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = { ...(raw as Record<string, unknown>) };
    const id = entry._ulid;
    if (typeof id === "string") {
      const summary = await readResourceSummary(ctx, id);
      if (summary) {
        entry.resource_summary = { ...summary };
      } else {
        delete entry.resource_summary;
      }
    }
    updated.push(entry);
  }
  await writeIndexEntries(indexPath, updated, shape, PLAN_LAYOUT.indexWrapperKey);
}
