/**
 * Meta manifest loading and operations.
 *
 * The meta manifest (kynetic.meta.yaml) contains process definitions:
 * - Agents: roles, capabilities, conventions
 * - Workflows: structured processes with steps
 * - Conventions: project rules and standards
 * - Observations: feedback about processes
 */

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import { ulid } from "ulid";
import { accessBufferAware, readdirBufferAware } from "../cli/batch-write-buffer.js";
import {
  type Agent,
  AgentSchema,
  type Convention,
  ConventionSchema,
  getMetaItemType,
  isSkill,
  type MetaItem,
  type MetaManifest,
  MetaManifestSchema,
  type Observation,
  ObservationSchema,
  type ObservationType,
  type SessionContext,
  SessionContextSchema,
  type Skill,
  SkillSchema,
  type Workflow,
  type WorkflowRun,
  WorkflowRunsFileSchema,
  WorkflowRunSchema,
  WorkflowSchema,
} from "../schema/index.js";
import { type Hook, HookSchema } from "../schema/hooks.js";
import { type Schedule, ScheduleSchema } from "../schema/schedules.js";
import { type Composition, CompositionSchema } from "../schema/composition.js";
import { withFileLock } from "./file-lock.js";
import { getEntityCacheContext, type KspecContext } from "./yaml.js";
import {
  expandIncludePattern,
  readFileBufferAware,
  readYamlFile,
  writeYamlFilePreserveFormat,
} from "./yaml.js";

/**
 * Loaded agent with runtime metadata
 */
export interface LoadedAgent extends Agent {
  _sourceFile?: string;
}

/**
 * Loaded workflow with runtime metadata
 */
export interface LoadedWorkflow extends Workflow {
  _sourceFile?: string;
}

/**
 * Loaded convention with runtime metadata
 */
export interface LoadedConvention extends Convention {
  _sourceFile?: string;
}

/**
 * Loaded observation with runtime metadata
 */
export interface LoadedObservation extends Observation {
  _sourceFile?: string;
}

/**
 * Loaded skill with runtime metadata
 */
export interface LoadedSkill extends Skill {
  _sourceFile?: string;
}

/**
 * Loaded hook with runtime metadata
 */
export interface LoadedHook extends Hook {
  _sourceFile?: string;
}

/**
 * Loaded schedule with runtime metadata
 */
export interface LoadedSchedule extends Schedule {
  _sourceFile?: string;
}

/**
 * Loaded composition with runtime metadata
 */
export interface LoadedComposition extends Composition {
  _sourceFile?: string;
}

/**
 * Any loaded meta item
 */
export type LoadedMetaItem =
  | LoadedAgent
  | LoadedWorkflow
  | LoadedConvention
  | LoadedObservation
  | LoadedSkill;

/**
 * Meta context containing all loaded meta items
 */
export interface MetaContext {
  manifest: MetaManifest | null;
  manifestPath: string | null;
  agents: LoadedAgent[];
  workflows: LoadedWorkflow[];
  conventions: LoadedConvention[];
  observations: LoadedObservation[];
  skills: LoadedSkill[];
  hooks: LoadedHook[];
  schedules: LoadedSchedule[];
  compositions: LoadedComposition[];
}

interface MetaContextEntityCache {
  getDomainState?(domain: string): string | null | undefined;
  getMetaDetail?(): MetaContext | null;
}

/**
 * Find the meta manifest file.
 *
 * Discovery algorithm:
 * 1. Check for explicit name: kynetic.meta.yaml (backward compat)
 * 2. If not found, scan directory for *.meta.yaml files
 * 3. For each candidate, validate it contains a 'kynetic_meta:' version field
 * 4. Return first valid match (alphabetically after explicit name)
 *
 * AC: @meta-manifest-discovery ac-1, ac-2, ac-3
 */
export async function findMetaManifest(specDir: string): Promise<string | null> {
  // AC: @meta-manifest-discovery ac-1, ac-3 - explicit name has priority
  const priorityPath = path.join(specDir, "kynetic.meta.yaml");
  try {
    await accessBufferAware(priorityPath);
    return priorityPath;
  } catch {
    // Continue to glob fallback
  }

  // AC: @meta-manifest-discovery ac-2, ac-3 - glob fallback with validation
  try {
    const entries = (await readdirBufferAware(specDir)) as string[];
    // AC: @meta-manifest-discovery ac-3 - alphabetical order
    const candidates = entries.filter((f) => f.endsWith(".meta.yaml")).toSorted();

    for (const candidate of candidates) {
      const filePath = path.join(specDir, candidate);
      try {
        const raw = await readYamlFile<unknown>(filePath);
        // AC: @meta-manifest-discovery ac-2 - validate kynetic_meta version field
        if (raw && typeof raw === "object" && "kynetic_meta" in raw) {
          return filePath;
        }
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Directory read failed
  }

  return null;
}

/**
 * Get the base name (slug) from a manifest path.
 * E.g., "kynetic.yaml" -> "kynetic", "myproject.spec.yaml" -> "myproject"
 */
function getManifestBaseName(manifestPath: string | null): string {
  if (!manifestPath) return "kynetic";
  const fileName = path.basename(manifestPath);
  // Remove .yaml extension
  let baseName = fileName.replace(/\.yaml$/, "");
  // Remove .spec suffix if present
  baseName = baseName.replace(/\.spec$/, "");
  return baseName || "kynetic";
}

/**
 * Get the meta manifest file path.
 * Derives from main manifest name (e.g., myproject.yaml -> myproject.meta.yaml)
 * Returns path even if file doesn't exist yet.
 */
export function getMetaManifestPath(ctx: KspecContext): string {
  const baseName = getManifestBaseName(ctx.manifestPath);
  return path.join(ctx.specDir, `${baseName}.meta.yaml`);
}

/**
 * Load meta items from a single file.
 */
async function loadMetaFile(filePath: string): Promise<{
  agents: LoadedAgent[];
  workflows: LoadedWorkflow[];
  conventions: LoadedConvention[];
  observations: LoadedObservation[];
  skills: LoadedSkill[];
  hooks: LoadedHook[];
  schedules: LoadedSchedule[];
  compositions: LoadedComposition[];
}> {
  const result: {
    agents: LoadedAgent[];
    workflows: LoadedWorkflow[];
    conventions: LoadedConvention[];
    observations: LoadedObservation[];
    skills: LoadedSkill[];
    hooks: LoadedHook[];
    schedules: LoadedSchedule[];
    compositions: LoadedComposition[];
  } = {
    agents: [],
    workflows: [],
    conventions: [],
    observations: [],
    skills: [],
    hooks: [],
    schedules: [],
    compositions: [],
  };

  try {
    const raw = await readYamlFile<unknown>(filePath);
    if (!raw || typeof raw !== "object") {
      return result;
    }

    const obj = raw as Record<string, unknown>;

    // Parse agents
    if (Array.isArray(obj.agents)) {
      for (const agent of obj.agents) {
        const parsed = AgentSchema.safeParse(agent);
        if (parsed.success) {
          result.agents.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }

    // Parse workflows
    if (Array.isArray(obj.workflows)) {
      for (const workflow of obj.workflows) {
        const parsed = WorkflowSchema.safeParse(workflow);
        if (parsed.success) {
          result.workflows.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }

    // Parse conventions
    if (Array.isArray(obj.conventions)) {
      for (const convention of obj.conventions) {
        const parsed = ConventionSchema.safeParse(convention);
        if (parsed.success) {
          result.conventions.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }

    // Parse observations
    if (Array.isArray(obj.observations)) {
      for (const observation of obj.observations) {
        const parsed = ObservationSchema.safeParse(observation);
        if (parsed.success) {
          result.observations.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }

    // Parse skills
    // AC: @skill-meta-type ac-4 - skills loaded with _sourceFile set
    if (Array.isArray(obj.skills)) {
      for (const skill of obj.skills) {
        const parsed = SkillSchema.safeParse(skill);
        if (parsed.success) {
          result.skills.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }

    // Parse hooks
    // AC: @dispatch-hook-schema ac-1 - hooks parsed with typed fields
    if (Array.isArray(obj.hooks)) {
      for (const hook of obj.hooks) {
        const parsed = HookSchema.safeParse(hook);
        if (parsed.success) {
          result.hooks.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }

    // Parse schedules
    // AC: @dispatch-schedule-schema ac-1 - schedules parsed with typed fields
    if (Array.isArray(obj.schedules)) {
      for (const schedule of obj.schedules) {
        const parsed = ScheduleSchema.safeParse(schedule);
        if (parsed.success) {
          result.schedules.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }

    // Parse compositions
    // AC: @dispatch-composition-schema ac-1 - compositions parsed with typed fields
    if (Array.isArray(obj.compositions)) {
      for (const composition of obj.compositions) {
        const parsed = CompositionSchema.safeParse(composition);
        if (parsed.success) {
          result.compositions.push({ ...parsed.data, _sourceFile: filePath });
        }
      }
    }
  } catch {
    // File doesn't exist or parse error
  }

  return result;
}

/**
 * Load the meta context from a kspec context.
 * Loads meta manifest and follows includes.
 * AC: @skill-meta-type ac-4 - MetaContext.skills contains LoadedSkill objects with _sourceFile set
 */
export async function loadMetaContext(ctx: KspecContext): Promise<MetaContext> {
  const cacheContext = getEntityCacheContext();
  const resolvedCache = cacheContext?.cacheAccessor(cacheContext.projectPath) as
    | MetaContextEntityCache
    | null
    | undefined;
  if (resolvedCache?.getDomainState?.("meta") === "ready") {
    const cachedMeta = resolvedCache.getMetaDetail?.();
    if (cachedMeta) {
      return cachedMeta;
    }
  }

  const result: MetaContext = {
    manifest: null,
    manifestPath: null,
    agents: [],
    workflows: [],
    conventions: [],
    observations: [],
    skills: [],
    hooks: [],
    schedules: [],
    compositions: [],
  };

  const manifestPath = await findMetaManifest(ctx.specDir);
  if (!manifestPath) {
    return result;
  }

  result.manifestPath = manifestPath;

  try {
    const raw = await readYamlFile<unknown>(manifestPath);
    const parsed = MetaManifestSchema.safeParse(raw);
    if (!parsed.success) {
      // Invalid manifest, but we can still try to extract items
      const items = await loadMetaFile(manifestPath);
      result.agents.push(...items.agents);
      result.workflows.push(...items.workflows);
      result.conventions.push(...items.conventions);
      result.observations.push(...items.observations);
      result.skills.push(...items.skills);
      result.hooks.push(...items.hooks);
      result.schedules.push(...items.schedules);
      result.compositions.push(...items.compositions);
      return result;
    }

    result.manifest = parsed.data;

    // Load items from manifest
    const manifestItems = await loadMetaFile(manifestPath);
    result.agents.push(...manifestItems.agents);
    result.workflows.push(...manifestItems.workflows);
    result.conventions.push(...manifestItems.conventions);
    result.observations.push(...manifestItems.observations);
    result.skills.push(...manifestItems.skills);
    result.hooks.push(...manifestItems.hooks);
    result.schedules.push(...manifestItems.schedules);
    result.compositions.push(...manifestItems.compositions);

    // Process includes
    const includes = parsed.data.includes || [];
    const manifestDir = path.dirname(manifestPath);

    for (const include of includes) {
      const expandedPaths = await expandIncludePattern(include, manifestDir);

      for (const filePath of expandedPaths) {
        const items = await loadMetaFile(filePath);
        result.agents.push(...items.agents);
        result.workflows.push(...items.workflows);
        result.conventions.push(...items.conventions);
        result.observations.push(...items.observations);
        result.skills.push(...items.skills);
        result.hooks.push(...items.hooks);
        result.schedules.push(...items.schedules);
        result.compositions.push(...items.compositions);
      }
    }
  } catch {
    // Manifest exists but may be invalid
  }

  return result;
}

/**
 * Get meta stats summary
 */
export function getMetaStats(meta: MetaContext): {
  agents: number;
  workflows: number;
  conventions: number;
  observations: number;
  unresolvedObservations: number;
  skills: number;
} {
  return {
    agents: meta.agents.length,
    workflows: meta.workflows.length,
    conventions: meta.conventions.length,
    observations: meta.observations.length,
    unresolvedObservations: meta.observations.filter((o) => !o.resolved).length,
    skills: meta.skills.length,
  };
}

/**
 * Meta item type string literal
 */
export type MetaItemTypeName = "agent" | "workflow" | "convention" | "observation" | "skill";

/**
 * Result of resolving a meta reference
 */
export interface ResolvedMetaRef {
  item: LoadedMetaItem;
  type: MetaItemTypeName;
  ulid: string;
}

/**
 * Resolve a meta reference to its item, type, and ULID.
 *
 * This is the unified resolver for meta items that consolidates various
 * ref-to-item resolution patterns. Handles ULID prefixes, full ULIDs,
 * semantic IDs (id field for agents/workflows/skills), and domains (conventions).
 *
 * AC: @skill-meta-type ac-5 - skills returned by semantic id lookup
 * AC: @skill-meta-type ac-6 - skills returned by ULID prefix lookup
 * AC: @skill-meta-integration ac-4 - skills included in resolution
 */
export function resolveMetaRef(meta: MetaContext, ref: string): ResolvedMetaRef | null {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  // Search all item types
  const allItems: LoadedMetaItem[] = [
    ...meta.agents,
    ...meta.workflows,
    ...meta.conventions,
    ...meta.observations,
    ...meta.skills,
  ];

  for (const item of allItems) {
    // Match full ULID
    if (item._ulid === cleanRef) {
      return { item, type: getMetaItemType(item), ulid: item._ulid };
    }

    // Match short ULID (prefix)
    if (item._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) {
      return { item, type: getMetaItemType(item), ulid: item._ulid };
    }

    // Match by id (for agents, workflows, and skills)
    if ("id" in item && item.id === cleanRef) {
      return { item, type: getMetaItemType(item), ulid: item._ulid };
    }

    // Match by domain (for conventions)
    if ("domain" in item && item.domain === cleanRef) {
      return { item, type: getMetaItemType(item), ulid: item._ulid };
    }
  }

  return null;
}

/**
 * Find a meta item by reference (ULID, short ULID, or id)
 *
 * This is a convenience wrapper around resolveMetaRef that returns just the item.
 * Use resolveMetaRef when you also need the type and ULID.
 *
 * AC: @skill-meta-type ac-5 - skills returned by semantic id lookup
 * AC: @skill-meta-type ac-6 - skills returned by ULID prefix lookup
 */
export function findMetaItemByRef(meta: MetaContext, ref: string): LoadedMetaItem | undefined {
  const result = resolveMetaRef(meta, ref);
  return result?.item;
}

/**
 * Determine if an item is a meta item type
 */
export function isMetaItemType(type: string): boolean {
  return ["agent", "workflow", "convention", "observation", "skill"].includes(type);
}

// ============================================================
// RAW DATA PRESERVATION HELPERS
// ============================================================

/** Top-level array field names in the meta manifest. */
const META_ARRAY_FIELDS = [
  "agents",
  "workflows",
  "conventions",
  "observations",
  "skills",
  "hooks",
  "schedules",
  "compositions",
  "includes",
] as const;

type MetaArrayField = (typeof META_ARRAY_FIELDS)[number];

/**
 * Extract the raw meta manifest data from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
async function extractRawMetaManifest(filePath: string): Promise<{
  wrapperObj?: Record<string, unknown>;
}> {
  let existingRaw: unknown = null;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
  } catch {
    return {};
  }

  if (!existingRaw || typeof existingRaw !== "object") {
    return {};
  }

  return {
    wrapperObj: existingRaw as Record<string, unknown>,
  };
}

/**
 * Get a raw array from the wrapper object, defaulting to empty.
 */
function getRawArray(
  wrapperObj: Record<string, unknown> | undefined,
  field: MetaArrayField,
): unknown[] {
  if (!wrapperObj) return [];
  const arr = wrapperObj[field];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Write the meta manifest back to file, preserving wrapper metadata.
 * Only includes array fields that were present in the original wrapper
 * or that have non-empty values.
 */
async function writeRawMetaManifest(
  filePath: string,
  wrapperObj: Record<string, unknown> | undefined,
  updates: Partial<Record<MetaArrayField, unknown[]>>,
): Promise<void> {
  const output: Record<string, unknown> = {};

  if (wrapperObj) {
    // Copy all existing top-level fields in their original order
    for (const [key, value] of Object.entries(wrapperObj)) {
      if (key in updates) {
        // This field was mutated — use the updated value
        output[key] = updates[key as MetaArrayField];
      } else {
        output[key] = value;
      }
    }
    // Add any new fields from updates that weren't in the original
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in output)) {
        output[key] = value;
      }
    }
  } else {
    output.kynetic_meta = "1.0";
    for (const [key, value] of Object.entries(updates)) {
      output[key] = value;
    }
  }

  await writeYamlFilePreserveFormat(filePath, output);
}

/**
 * Find an item index in a raw array by ULID match.
 */
function findRawMetaItemIndex(rawItems: unknown[], itemUlid: string): number {
  return rawItems.findIndex(
    (item) =>
      item && typeof item === "object" && (item as Record<string, unknown>)._ulid === itemUlid,
  );
}

/**
 * Merge a schema-normalized meta item onto the original raw data.
 * Only adds fields that were in the original raw data or that contain
 * non-default values. This prevents Zod defaults from polluting YAML
 * output with fields that weren't originally present.
 */
function mergeMetaItemPreservingRawShape(
  rawItem: Record<string, unknown>,
  normalizedItem: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(normalizedItem)) {
    if (key in rawItem) {
      // Field existed in raw — always include (even if value changed)
      result[key] = value;
    } else {
      // Field was added by schema normalization — only include if non-trivial.
      // Skip empty arrays, null/undefined, and false (common Zod defaults).
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isNull = value === null || value === undefined;
      const isFalse = value === false;
      if (!isEmptyArray && !isNull && !isFalse) {
        result[key] = value;
      }
    }
  }

  return result;
}

// ============================================================
// META ITEM CRUD
// ============================================================

/**
 * Strip runtime metadata before serialization
 */
function stripMetaMetadata<T extends LoadedMetaItem>(item: T): Omit<T, "_sourceFile"> {
  const { _sourceFile, ...cleanItem } = item;
  return cleanItem as Omit<T, "_sourceFile">;
}

/**
 * Create a new observation
 */
export function createObservation(
  type: ObservationType,
  content: string,
  options: {
    workflow_ref?: string;
    /**
     * Required, caller-resolved canonical actor. This leaf constructor does
     * not fall back to `getAuthor()`: the calling command/action resolves and
     * canonicalizes the author through the shared actor-write utility before
     * reaching here, so no sanctioned path can persist a non-canonical or
     * out-of-pool observation author.
     */
    author: string;
  },
): Observation {
  return {
    _ulid: ulid(),
    type,
    content,
    workflow_ref: options.workflow_ref,
    created_at: new Date().toISOString(),
    author: options.author,
    resolved: false,
    resolution: null,
  };
}

/**
 * Save an observation to the meta manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 */
export async function saveObservation(
  ctx: KspecContext,
  observation: LoadedObservation,
): Promise<void> {
  const manifestPath = getMetaManifestPath(ctx);

  await withFileLock(manifestPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(manifestPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw manifest data without schema normalization
    const { wrapperObj } = await extractRawMetaManifest(manifestPath);
    const rawObservations = getRawArray(wrapperObj, "observations");

    // Strip runtime metadata and schema-parse only the target item
    const cleanObs = stripMetaMetadata(observation);

    // Update existing or add new — replace only the target observation
    const existingIndex = findRawMetaItemIndex(rawObservations, observation._ulid);
    if (existingIndex >= 0) {
      const rawTarget = rawObservations[existingIndex] as Record<string, unknown>;
      rawObservations[existingIndex] = mergeMetaItemPreservingRawShape(
        rawTarget,
        cleanObs as unknown as Record<string, unknown>,
      );
    } else {
      rawObservations.push(cleanObs);
    }

    await writeRawMetaManifest(manifestPath, wrapperObj, {
      observations: rawObservations,
    });
  });
}

/**
 * Delete an observation from the meta manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 */
export async function deleteObservation(ctx: KspecContext, targetUlid: string): Promise<boolean> {
  const manifestPath = getMetaManifestPath(ctx);

  return withFileLock(manifestPath, async () => {
    try {
      const { wrapperObj } = await extractRawMetaManifest(manifestPath);
      const rawObservations = getRawArray(wrapperObj, "observations");

      const index = findRawMetaItemIndex(rawObservations, targetUlid);
      if (index < 0) {
        return false;
      }

      rawObservations.splice(index, 1);
      await writeRawMetaManifest(manifestPath, wrapperObj, {
        observations: rawObservations,
      });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Save a hook to the meta manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 * AC: @dispatch-event-cli ac-4 — hook is persisted and available for event matching
 */
export async function saveHook(ctx: KspecContext, hook: LoadedHook): Promise<void> {
  const manifestPath = getMetaManifestPath(ctx);

  await withFileLock(manifestPath, async () => {
    const dir = path.dirname(manifestPath);
    await fs.mkdir(dir, { recursive: true });

    const { wrapperObj } = await extractRawMetaManifest(manifestPath);
    const rawHooks = wrapperObj
      ? Array.isArray(wrapperObj.hooks)
        ? (wrapperObj.hooks as unknown[])
        : []
      : [];

    const { _sourceFile: _, ...cleanHook } = hook;

    const existingIndex = findRawMetaItemIndex(rawHooks, hook._ulid);
    if (existingIndex >= 0) {
      const rawTarget = rawHooks[existingIndex] as Record<string, unknown>;
      rawHooks[existingIndex] = mergeMetaItemPreservingRawShape(
        rawTarget,
        cleanHook as unknown as Record<string, unknown>,
      );
    } else {
      rawHooks.push(cleanHook);
    }

    await writeRawMetaManifest(manifestPath, wrapperObj, {
      hooks: rawHooks,
    } as unknown as Partial<Record<MetaArrayField, unknown[]>>);
  });
}

/**
 * Delete a hook from the meta manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 */
export async function deleteHook(ctx: KspecContext, targetUlid: string): Promise<boolean> {
  const manifestPath = getMetaManifestPath(ctx);

  return withFileLock(manifestPath, async () => {
    try {
      const { wrapperObj } = await extractRawMetaManifest(manifestPath);
      const rawHooks = wrapperObj
        ? Array.isArray(wrapperObj.hooks)
          ? (wrapperObj.hooks as unknown[])
          : []
        : [];

      const index = findRawMetaItemIndex(rawHooks, targetUlid);
      if (index < 0) {
        return false;
      }

      rawHooks.splice(index, 1);
      await writeRawMetaManifest(manifestPath, wrapperObj, {
        hooks: rawHooks,
      } as unknown as Partial<Record<MetaArrayField, unknown[]>>);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Get the path for skill content file.
 * Skills are stored in .kspec/skills/<id>/SKILL.md
 */
export function getSkillContentPath(ctx: KspecContext, skillId: string): string {
  return path.join(ctx.specDir, "skills", skillId, "SKILL.md");
}

/**
 * Load skill content from the SKILL.md file.
 * AC: @skill-meta-type ac-3 - loadSkillContent returns full markdown content
 * AC: @skill-content-model ac-1 - loadSkillContent returns markdown content as a string
 */
export async function loadSkillContent(
  ctx: KspecContext,
  skill: LoadedSkill,
): Promise<string | null> {
  const contentPath = getSkillContentPath(ctx, skill.id);
  try {
    const content = await readFileBufferAware(contentPath);
    return content;
  } catch {
    return null;
  }
}

/**
 * Skill doc object returned by loadSkillDocs.
 * AC: @skill-content-model ac-2
 */
export interface SkillDoc {
  /** File name (e.g., "quickref.md") */
  name: string;
  /** Full file path */
  path: string;
  /** File content */
  content: string;
}

/**
 * Supported skill supporting directory types.
 * AC: @supporting-files-convention ac-1
 */
export type SupportingDirType = "references" | "scripts" | "assets" | "docs";

/**
 * A file from a skill's supporting directory.
 * AC: @supporting-files-convention ac-1
 */
export interface SupportingFile {
  /** File name (e.g., "api.md", "helper.sh") */
  name: string;
  /** Full file path */
  path: string;
  /** File content (for text files) */
  content: string;
  /** Supporting directory type */
  dirType: SupportingDirType;
}

/**
 * Get the docs directory path for a skill.
 * Skills can have supporting docs at .kspec/skills/<id>/docs/
 */
export function getSkillDocsPath(ctx: KspecContext, skillId: string): string {
  return path.join(ctx.specDir, "skills", skillId, "docs");
}

/**
 * Load skill documentation files from the docs/ subdirectory.
 * AC: @skill-content-model ac-2 - loadSkillDocs returns array of doc objects
 */
export async function loadSkillDocs(ctx: KspecContext, skill: LoadedSkill): Promise<SkillDoc[]> {
  const docsPath = getSkillDocsPath(ctx, skill.id);
  const docs: SkillDoc[] = [];

  try {
    const entries = (await readdirBufferAware(docsPath, { withFileTypes: true })) as Dirent[];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = path.join(docsPath, entry.name);
        try {
          const content = await readFileBufferAware(filePath);
          docs.push({
            name: entry.name,
            path: filePath,
            content,
          });
        } catch {
          // Skip files that can't be read
        }
      }
    }
  } catch {
    // docs directory doesn't exist or can't be read
  }

  return docs;
}

/**
 * Get the path to a supporting directory for a skill.
 * AC: @supporting-files-convention ac-1
 */
export function getSkillSupportingDirPath(
  ctx: KspecContext,
  skillId: string,
  dirType: SupportingDirType,
): string {
  return path.join(ctx.specDir, "skills", skillId, dirType);
}

/**
 * Load files from a skill's supporting directory.
 * AC: @supporting-files-convention ac-1 - references files are accessible
 *
 * @param ctx - Kspec context
 * @param skill - The skill to load files from
 * @param dirType - The supporting directory type (references, scripts, assets, docs)
 * @returns Array of files found in the directory
 */
export async function loadSkillSupportingFiles(
  ctx: KspecContext,
  skill: LoadedSkill,
  dirType: SupportingDirType,
): Promise<SupportingFile[]> {
  const dirPath = getSkillSupportingDirPath(ctx, skill.id, dirType);
  const files: SupportingFile[] = [];

  try {
    const entries = (await readdirBufferAware(dirPath, { withFileTypes: true })) as Dirent[];

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = path.join(dirPath, entry.name);
        try {
          const content = await readFileBufferAware(filePath);
          files.push({
            name: entry.name,
            path: filePath,
            content,
            dirType,
          });
        } catch {
          // Skip files that can't be read (e.g., binary files)
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read - return empty array
  }

  return files;
}

/**
 * List which supporting directories exist for a skill.
 * AC: @supporting-files-convention ac-1
 *
 * @returns Array of directory types that exist for the skill
 */
export async function listSkillSupportingDirs(
  ctx: KspecContext,
  skillId: string,
): Promise<SupportingDirType[]> {
  const dirs: SupportingDirType[] = [];
  const allDirs: SupportingDirType[] = ["references", "scripts", "assets", "docs"];

  for (const dirType of allDirs) {
    const dirPath = getSkillSupportingDirPath(ctx, skillId, dirType);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory()) {
        dirs.push(dirType);
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return dirs;
}

// ============================================================
// SCHEDULE / HOOK CRUD
// ============================================================

/**
 * Save a schedule to the meta manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 */
export async function saveSchedule(ctx: KspecContext, schedule: LoadedSchedule): Promise<void> {
  const manifestPath = getMetaManifestPath(ctx);

  await withFileLock(manifestPath, async () => {
    const dir = path.dirname(manifestPath);
    await fs.mkdir(dir, { recursive: true });

    const { wrapperObj } = await extractRawMetaManifest(manifestPath);
    const rawSchedules = getRawArray(wrapperObj, "schedules");

    const { _sourceFile, ...cleanSchedule } = schedule;

    const existingIndex = findRawMetaItemIndex(rawSchedules, schedule._ulid);
    if (existingIndex >= 0) {
      const rawTarget = rawSchedules[existingIndex] as Record<string, unknown>;
      rawSchedules[existingIndex] = mergeMetaItemPreservingRawShape(
        rawTarget,
        cleanSchedule as unknown as Record<string, unknown>,
      );
    } else {
      rawSchedules.push(cleanSchedule);
    }

    await writeRawMetaManifest(manifestPath, wrapperObj, {
      schedules: rawSchedules,
    });
  });
}

/**
 * Delete a schedule from the meta manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 */
export async function deleteSchedule(ctx: KspecContext, targetUlid: string): Promise<boolean> {
  const manifestPath = getMetaManifestPath(ctx);

  return withFileLock(manifestPath, async () => {
    try {
      const { wrapperObj } = await extractRawMetaManifest(manifestPath);
      const rawSchedules = getRawArray(wrapperObj, "schedules");

      const index = findRawMetaItemIndex(rawSchedules, targetUlid);
      if (index < 0) {
        return false;
      }

      rawSchedules.splice(index, 1);
      await writeRawMetaManifest(manifestPath, wrapperObj, {
        schedules: rawSchedules,
      });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Resolve a schedule reference by id, ULID, or ULID prefix.
 */
export function resolveScheduleRef(meta: MetaContext, ref: string): LoadedSchedule | undefined {
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  for (const schedule of meta.schedules) {
    if (schedule._ulid === cleanRef) return schedule;
    if (schedule._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return schedule;
    if (schedule.id === cleanRef) return schedule;
  }

  return undefined;
}

// Re-export the getMetaItemType and isSkill functions
export { getMetaItemType, isSkill };
export type { Agent, Workflow, Convention, Observation, Skill, Hook, MetaItem };

// ============================================================
// GENERIC META ITEM CRUD
// ============================================================

/**
 * Map item type to manifest array field name.
 */
function itemTypeToField(
  itemType: "agent" | "workflow" | "convention" | "observation" | "skill",
): MetaArrayField {
  return `${itemType}s` as MetaArrayField;
}

/**
 * Save any meta item (agent, workflow, convention, skill) to the manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 * AC: @skill-parser ac-1 - skill is appended to manifest.skills and written to disk
 * AC: @skill-parser ac-2 - .kspec/skills/<id>/ directory is created for skills
 */
export async function saveMetaItem(
  ctx: KspecContext,
  item: LoadedMetaItem,
  itemType: "agent" | "workflow" | "convention" | "skill",
): Promise<void> {
  const manifestPath = getMetaManifestPath(ctx);

  await withFileLock(manifestPath, async () => {
    // Ensure directory exists
    const dir = path.dirname(manifestPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw manifest data without schema normalization
    const { wrapperObj } = await extractRawMetaManifest(manifestPath);
    const field = itemTypeToField(itemType);
    const rawItems = getRawArray(wrapperObj, field);

    // Strip runtime metadata
    const cleanItem = stripMetaMetadata(item);

    // Update existing or add new — replace only the target item
    const existingIndex = findRawMetaItemIndex(rawItems, item._ulid);
    if (existingIndex >= 0) {
      const rawTarget = rawItems[existingIndex] as Record<string, unknown>;
      rawItems[existingIndex] = mergeMetaItemPreservingRawShape(
        rawTarget,
        cleanItem as unknown as Record<string, unknown>,
      );
    } else {
      rawItems.push(cleanItem);
    }

    await writeRawMetaManifest(manifestPath, wrapperObj, {
      [field]: rawItems,
    });
  });

  // AC: @skill-parser ac-2 - Create skill content directory
  if (itemType === "skill" && "id" in item) {
    const skillDir = path.join(ctx.specDir, "skills", item.id);
    await fs.mkdir(skillDir, { recursive: true });
  }
}

/**
 * Delete any meta item from the manifest.
 * Uses raw-data-preservation pattern to avoid adding Zod defaults for absent sections.
 * AC: @skill-parser ac-3 - skill is removed from manifest.skills
 * AC: @skill-parser ac-4 - .kspec/skills/<id>/ directory is deleted for skills
 */
export async function deleteMetaItem(
  ctx: KspecContext,
  itemUlid: string,
  itemType: "agent" | "workflow" | "convention" | "observation" | "skill",
): Promise<boolean> {
  const manifestPath = getMetaManifestPath(ctx);

  return withFileLock(manifestPath, async () => {
    try {
      const { wrapperObj } = await extractRawMetaManifest(manifestPath);
      if (!wrapperObj) {
        return false;
      }

      const field = itemTypeToField(itemType);
      const rawItems = getRawArray(wrapperObj, field);

      const index = findRawMetaItemIndex(rawItems, itemUlid);
      if (index < 0) {
        return false;
      }

      // AC: @skill-parser ac-4 - Delete skill directory before removing from manifest
      if (itemType === "skill") {
        const rawSkill = rawItems[index] as Record<string, unknown>;
        const skillId = rawSkill.id as string | undefined;
        if (skillId) {
          const skillDir = path.join(ctx.specDir, "skills", skillId);
          try {
            await fs.rm(skillDir, { recursive: true, force: true });
          } catch {
            // Directory might not exist, that's fine
          }
        }
      }

      rawItems.splice(index, 1);
      await writeRawMetaManifest(manifestPath, wrapperObj, {
        [field]: rawItems,
      });
      return true;
    } catch {
      return false;
    }
  });
}

// ============================================================
// SESSION CONTEXT
// ============================================================

/**
 * Get the session context file path
 */
export function getSessionContextPath(ctx: KspecContext): string {
  return path.join(ctx.specDir, ".kspec-session");
}

/**
 * Load session context (or return empty context if not exists)
 */
export async function loadSessionContext(ctx: KspecContext): Promise<SessionContext> {
  const contextPath = getSessionContextPath(ctx);

  try {
    const raw = await readYamlFile<unknown>(contextPath);
    if (!raw || typeof raw !== "object") {
      return {
        focus: null,
        threads: [],
        open_questions: [],
        updated_at: new Date().toISOString(),
      };
    }

    // Validate and parse using schema
    const result = SessionContextSchema.safeParse(raw);
    if (result.success) {
      return result.data;
    }

    // If validation fails, return empty context
    return {
      focus: null,
      threads: [],
      open_questions: [],
      updated_at: new Date().toISOString(),
    };
  } catch {
    return {
      focus: null,
      threads: [],
      open_questions: [],
      updated_at: new Date().toISOString(),
    };
  }
}

/**
 * Save session context
 */
export async function saveSessionContext(
  ctx: KspecContext,
  context: SessionContext,
): Promise<void> {
  const contextPath = getSessionContextPath(ctx);

  // Update timestamp
  context.updated_at = new Date().toISOString();

  await writeYamlFilePreserveFormat(contextPath, context);
}

// ============================================================
// WORKFLOW RUNS
// ============================================================

/**
 * Get the workflow runs file path.
 * Derives from main manifest name (e.g., myproject.yaml -> myproject.runs.yaml)
 */
export function getWorkflowRunsPath(ctx: KspecContext): string {
  const baseName = getManifestBaseName(ctx.manifestPath);
  return path.join(ctx.specDir, `${baseName}.runs.yaml`);
}

/**
 * Extract the raw workflow run array and format info from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
async function extractRawRunArray(
  filePath: string,
): Promise<{ rawRuns: unknown[]; wrapperObj?: Record<string, unknown> }> {
  let existingRaw: unknown = null;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
  } catch {
    // File doesn't exist
    return { rawRuns: [] };
  }

  if (!existingRaw || typeof existingRaw !== "object") {
    return { rawRuns: [] };
  }

  if ("runs" in existingRaw) {
    const wrapper = existingRaw as Record<string, unknown>;
    const runs = wrapper.runs;
    return {
      rawRuns: Array.isArray(runs) ? runs : [],
      wrapperObj: wrapper,
    };
  }

  return { rawRuns: [] };
}

/**
 * Write raw workflow run array back to file, preserving the wrapper format.
 */
async function writeRawRunArray(
  filePath: string,
  rawRuns: unknown[],
  wrapperObj?: Record<string, unknown>,
): Promise<void> {
  const output = wrapperObj
    ? { ...wrapperObj, runs: rawRuns }
    : { kynetic_runs: "1.0", runs: rawRuns };
  await writeYamlFilePreserveFormat(filePath, output);
}

/**
 * Find workflow run index in a raw array by ULID match.
 */
function findRawRunIndex(rawRuns: unknown[], ulid: string): number {
  return rawRuns.findIndex(
    (r) => r && typeof r === "object" && (r as Record<string, unknown>)._ulid === ulid,
  );
}

/**
 * Merge a schema-normalized workflow run onto the original raw run data.
 * Only adds fields that were in the original raw data or that contain
 * non-default values. This prevents Zod defaults from polluting YAML
 * output with fields that weren't originally present.
 */
function mergeRunPreservingRawShape(
  rawRun: Record<string, unknown>,
  normalizedRun: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(normalizedRun)) {
    if (key in rawRun) {
      // Field existed in raw — always include (even if value changed)
      result[key] = value;
    } else {
      // Field was added by schema normalization — only include if non-trivial
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isNull = value === null || value === undefined;
      if (!isEmptyArray && !isNull) {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Load workflow runs from file
 */
export async function loadWorkflowRuns(ctx: KspecContext): Promise<WorkflowRun[]> {
  const runsPath = getWorkflowRunsPath(ctx);

  try {
    const raw = await readYamlFile<unknown>(runsPath);
    const parsed = WorkflowRunsFileSchema.safeParse(raw);

    if (!parsed.success) {
      return [];
    }

    return parsed.data.runs;
  } catch {
    // File doesn't exist
    return [];
  }
}

/**
 * Save a workflow run (create or update)
 *
 * Non-target runs are preserved as raw data (no schema parsing) to ensure
 * round-trip stability — fields not present in the original YAML won't be
 * added by Zod defaults.
 */
export async function saveWorkflowRun(ctx: KspecContext, run: WorkflowRun): Promise<void> {
  const runsPath = getWorkflowRunsPath(ctx);

  await withFileLock(runsPath, async () => {
    const dir = path.dirname(runsPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw run data without schema normalization
    const { rawRuns, wrapperObj } = await extractRawRunArray(runsPath);

    // Update existing or add new — replace only the target run
    const existingIndex = findRawRunIndex(rawRuns, run._ulid);
    if (existingIndex >= 0) {
      // Merge onto raw data to avoid adding Zod defaults for absent fields
      const rawTarget = rawRuns[existingIndex] as Record<string, unknown>;
      rawRuns[existingIndex] = mergeRunPreservingRawShape(
        rawTarget,
        run as unknown as Record<string, unknown>,
      );
    } else {
      rawRuns.push(run);
    }

    await writeRawRunArray(runsPath, rawRuns, wrapperObj);
  });
}

/**
 * Update an existing workflow run
 */
export async function updateWorkflowRun(ctx: KspecContext, run: WorkflowRun): Promise<void> {
  await saveWorkflowRun(ctx, run);
}

/**
 * Atomically mutate a workflow run using the latest on-disk state.
 *
 * The callback receives the current run value while holding the runs file lock,
 * so concurrent writers do not clobber unrelated fields.
 *
 * Non-target runs are preserved as raw data (no schema parsing) to ensure
 * round-trip stability.
 */
export async function mutateWorkflowRunAtomically(
  ctx: KspecContext,
  run: WorkflowRun,
  mutate: (latestRun: WorkflowRun) => WorkflowRun | Promise<WorkflowRun>,
): Promise<WorkflowRun> {
  const runsPath = getWorkflowRunsPath(ctx);
  let updatedRun: WorkflowRun | undefined;

  await withFileLock(runsPath, async () => {
    const dir = path.dirname(runsPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw run data without schema normalization for non-target runs
    const { rawRuns, wrapperObj } = await extractRawRunArray(runsPath);

    const runIndex = findRawRunIndex(rawRuns, run._ulid);
    if (runIndex === -1) {
      throw new Error(`Workflow run not found in file: ${run._ulid}`);
    }

    // Schema-parse only the target run for the mutation callback
    const rawTarget = rawRuns[runIndex];
    const parsed = WorkflowRunSchema.safeParse(rawTarget);
    if (!parsed.success) {
      throw new Error(`Invalid workflow run data for ${run._ulid}: ${parsed.error.message}`);
    }
    const latestRun = parsed.data;

    const mutatedRun = await mutate(latestRun);

    // Merge onto raw data to avoid adding Zod defaults for absent fields
    rawRuns[runIndex] = mergeRunPreservingRawShape(
      rawTarget as Record<string, unknown>,
      mutatedRun as unknown as Record<string, unknown>,
    );

    await writeRawRunArray(runsPath, rawRuns, wrapperObj);

    updatedRun = mutatedRun;
  });

  if (!updatedRun) {
    throw new Error(`Failed to mutate workflow run atomically: ${run._ulid}`);
  }

  return updatedRun;
}

/**
 * Find a workflow run by reference (ULID or ULID prefix)
 */
export async function findWorkflowRunByRef(
  ctx: KspecContext,
  ref: string,
): Promise<WorkflowRun | undefined> {
  const runs = await loadWorkflowRuns(ctx);
  const cleanRef = ref.startsWith("@") ? ref.slice(1) : ref;

  return runs.find(
    (r) => r._ulid === cleanRef || r._ulid.toLowerCase().startsWith(cleanRef.toLowerCase()),
  );
}

/**
 * Find active workflow runs
 */
export async function findActiveRuns(ctx: KspecContext): Promise<WorkflowRun[]> {
  const runs = await loadWorkflowRuns(ctx);
  return runs.filter((r) => r.status === "active");
}

/**
 * Delete workflow runs by ULIDs
 *
 * Non-target runs are preserved as raw data (no schema parsing) to ensure
 * round-trip stability.
 * AC: @workflow-prune ac-1, ac-2, ac-3, ac-4
 */
export async function deleteWorkflowRuns(
  ctx: KspecContext,
  ulidsToDelete: string[],
): Promise<void> {
  const runsPath = getWorkflowRunsPath(ctx);

  await withFileLock(runsPath, async () => {
    const { rawRuns, wrapperObj } = await extractRawRunArray(runsPath);

    // Filter out runs to delete using raw ULID field
    const remainingRuns = rawRuns.filter((r) => {
      if (!r || typeof r !== "object") return true;
      const runUlid = (r as Record<string, unknown>)._ulid;
      return typeof runUlid !== "string" || !ulidsToDelete.includes(runUlid);
    });

    await writeRawRunArray(runsPath, remainingRuns, wrapperObj);
  });
}
