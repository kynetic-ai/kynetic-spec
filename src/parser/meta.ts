/**
 * Meta manifest loading and operations.
 *
 * The meta manifest (kynetic.meta.yaml) contains process definitions:
 * - Agents: roles, capabilities, conventions
 * - Workflows: structured processes with steps
 * - Conventions: project rules and standards
 * - Observations: feedback about processes
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ulid } from 'ulid';
import {
  MetaManifestSchema,
  AgentSchema,
  WorkflowSchema,
  ConventionSchema,
  ObservationSchema,
  type MetaManifest,
  type Agent,
  type Workflow,
  type Convention,
  type Observation,
  type MetaItem,
  type ObservationType,
  getMetaItemType,
} from '../schema/index.js';
import { readYamlFile, writeYamlFile, expandIncludePattern, getAuthor } from './yaml.js';
import type { KspecContext } from './yaml.js';

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
 * Any loaded meta item
 */
export type LoadedMetaItem = LoadedAgent | LoadedWorkflow | LoadedConvention | LoadedObservation;

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
}

/**
 * Find the meta manifest file (kynetic.meta.yaml)
 */
export async function findMetaManifest(specDir: string): Promise<string | null> {
  const candidates = ['kynetic.meta.yaml'];

  for (const candidate of candidates) {
    const filePath = path.join(specDir, candidate);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // File doesn't exist, try next
    }
  }

  return null;
}

/**
 * Get the meta manifest file path.
 * Returns path even if file doesn't exist yet.
 */
export function getMetaManifestPath(ctx: KspecContext): string {
  return path.join(ctx.specDir, 'kynetic.meta.yaml');
}

/**
 * Load meta items from a single file.
 */
async function loadMetaFile(
  filePath: string
): Promise<{
  agents: LoadedAgent[];
  workflows: LoadedWorkflow[];
  conventions: LoadedConvention[];
  observations: LoadedObservation[];
}> {
  const result: {
    agents: LoadedAgent[];
    workflows: LoadedWorkflow[];
    conventions: LoadedConvention[];
    observations: LoadedObservation[];
  } = {
    agents: [],
    workflows: [],
    conventions: [],
    observations: [],
  };

  try {
    const raw = await readYamlFile<unknown>(filePath);
    if (!raw || typeof raw !== 'object') {
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
  } catch {
    // File doesn't exist or parse error
  }

  return result;
}

/**
 * Load the meta context from a kspec context.
 * Loads meta manifest and follows includes.
 */
export async function loadMetaContext(ctx: KspecContext): Promise<MetaContext> {
  const result: MetaContext = {
    manifest: null,
    manifestPath: null,
    agents: [],
    workflows: [],
    conventions: [],
    observations: [],
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
      return result;
    }

    result.manifest = parsed.data;

    // Load items from manifest
    const manifestItems = await loadMetaFile(manifestPath);
    result.agents.push(...manifestItems.agents);
    result.workflows.push(...manifestItems.workflows);
    result.conventions.push(...manifestItems.conventions);
    result.observations.push(...manifestItems.observations);

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
} {
  return {
    agents: meta.agents.length,
    workflows: meta.workflows.length,
    conventions: meta.conventions.length,
    observations: meta.observations.length,
    unresolvedObservations: meta.observations.filter((o) => !o.resolved).length,
  };
}

/**
 * Find a meta item by reference (ULID, short ULID, or id)
 */
export function findMetaItemByRef(
  meta: MetaContext,
  ref: string
): LoadedMetaItem | undefined {
  const cleanRef = ref.startsWith('@') ? ref.slice(1) : ref;

  // Search all item types
  const allItems: LoadedMetaItem[] = [
    ...meta.agents,
    ...meta.workflows,
    ...meta.conventions,
    ...meta.observations,
  ];

  for (const item of allItems) {
    // Match full ULID
    if (item._ulid === cleanRef) return item;

    // Match short ULID (prefix)
    if (item._ulid.toLowerCase().startsWith(cleanRef.toLowerCase())) return item;

    // Match by id (for agents and workflows)
    if ('id' in item && item.id === cleanRef) return item;

    // Match by domain (for conventions)
    if ('domain' in item && item.domain === cleanRef) return item;
  }

  return undefined;
}

/**
 * Determine if an item is a meta item type
 */
export function isMetaItemType(type: string): boolean {
  return ['agent', 'workflow', 'convention', 'observation'].includes(type);
}

// ============================================================
// META ITEM CRUD
// ============================================================

/**
 * Save the entire meta manifest to file
 */
async function saveMetaManifest(
  manifestPath: string,
  manifest: MetaManifest
): Promise<void> {
  await writeYamlFile(manifestPath, manifest);
}

/**
 * Strip runtime metadata before serialization
 */
function stripMetaMetadata<T extends LoadedMetaItem>(item: T): Omit<T, '_sourceFile'> {
  const { _sourceFile, ...cleanItem } = item;
  return cleanItem as Omit<T, '_sourceFile'>;
}

/**
 * Create a new observation
 */
export function createObservation(
  type: ObservationType,
  content: string,
  options: {
    workflow_ref?: string;
    author?: string;
  } = {}
): Observation {
  return {
    _ulid: ulid(),
    type,
    content,
    workflow_ref: options.workflow_ref,
    created_at: new Date().toISOString(),
    author: options.author ?? getAuthor(),
    resolved: false,
    resolution: null,
  };
}

/**
 * Save an observation to the meta manifest
 */
export async function saveObservation(
  ctx: KspecContext,
  observation: LoadedObservation
): Promise<void> {
  const manifestPath = getMetaManifestPath(ctx);

  // Ensure directory exists
  const dir = path.dirname(manifestPath);
  await fs.mkdir(dir, { recursive: true });

  // Load existing manifest
  let manifest: MetaManifest = {
    kynetic_meta: '1.0',
    agents: [],
    workflows: [],
    conventions: [],
    observations: [],
    includes: [],
  };

  try {
    const raw = await readYamlFile<unknown>(manifestPath);
    const parsed = MetaManifestSchema.safeParse(raw);
    if (parsed.success) {
      manifest = parsed.data;
    }
  } catch {
    // File doesn't exist, use defaults
  }

  // Strip runtime metadata
  const cleanObs = stripMetaMetadata(observation);

  // Update or add
  const existingIndex = manifest.observations.findIndex(
    (o) => o._ulid === observation._ulid
  );
  if (existingIndex >= 0) {
    manifest.observations[existingIndex] = cleanObs as Observation;
  } else {
    manifest.observations.push(cleanObs as Observation);
  }

  await saveMetaManifest(manifestPath, manifest);
}

/**
 * Delete an observation from the meta manifest
 */
export async function deleteObservation(
  ctx: KspecContext,
  ulid: string
): Promise<boolean> {
  const manifestPath = getMetaManifestPath(ctx);

  try {
    const raw = await readYamlFile<unknown>(manifestPath);
    const parsed = MetaManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return false;
    }

    const manifest = parsed.data;
    const index = manifest.observations.findIndex((o) => o._ulid === ulid);
    if (index < 0) {
      return false;
    }

    manifest.observations.splice(index, 1);
    await saveMetaManifest(manifestPath, manifest);
    return true;
  } catch {
    return false;
  }
}

// Re-export the getMetaItemType function
export { getMetaItemType };
export type { Agent, Workflow, Convention, Observation, MetaItem };

// ============================================================
// GENERIC META ITEM CRUD
// ============================================================

/**
 * Save any meta item (agent, workflow, convention) to the manifest
 */
export async function saveMetaItem(
  ctx: KspecContext,
  item: LoadedMetaItem,
  itemType: 'agent' | 'workflow' | 'convention'
): Promise<void> {
  const manifestPath = getMetaManifestPath(ctx);

  // Ensure directory exists
  const dir = path.dirname(manifestPath);
  await fs.mkdir(dir, { recursive: true });

  // Load existing manifest
  let manifest: MetaManifest = {
    kynetic_meta: '1.0',
    agents: [],
    workflows: [],
    conventions: [],
    observations: [],
    includes: [],
  };

  try {
    const raw = await readYamlFile<unknown>(manifestPath);
    const parsed = MetaManifestSchema.safeParse(raw);
    if (parsed.success) {
      manifest = parsed.data;
    }
  } catch {
    // File doesn't exist, use defaults
  }

  // Strip runtime metadata
  const cleanItem = stripMetaMetadata(item);

  // Get the appropriate array
  const getArray = () => {
    switch (itemType) {
      case 'agent':
        return manifest.agents;
      case 'workflow':
        return manifest.workflows;
      case 'convention':
        return manifest.conventions;
    }
  };

  const array = getArray();

  // Update or add
  const existingIndex = array.findIndex((i) => i._ulid === item._ulid);
  if (existingIndex >= 0) {
    (array as unknown[])[existingIndex] = cleanItem;
  } else {
    (array as unknown[]).push(cleanItem);
  }

  await saveMetaManifest(manifestPath, manifest);
}

/**
 * Delete any meta item from the manifest
 */
export async function deleteMetaItem(
  ctx: KspecContext,
  itemUlid: string,
  itemType: 'agent' | 'workflow' | 'convention' | 'observation'
): Promise<boolean> {
  const manifestPath = getMetaManifestPath(ctx);

  try {
    const raw = await readYamlFile<unknown>(manifestPath);
    const parsed = MetaManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return false;
    }

    const manifest = parsed.data;

    const getArray = () => {
      switch (itemType) {
        case 'agent':
          return manifest.agents;
        case 'workflow':
          return manifest.workflows;
        case 'convention':
          return manifest.conventions;
        case 'observation':
          return manifest.observations;
      }
    };

    const array = getArray();
    const index = array.findIndex((i) => i._ulid === itemUlid);
    if (index < 0) {
      return false;
    }

    array.splice(index, 1);
    await saveMetaManifest(manifestPath, manifest);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// SESSION CONTEXT
// ============================================================

/**
 * Session context for ephemeral session state
 */
export interface SessionContext {
  focus: string | null;
  threads: string[];
  open_questions: string[];
  updated_at: string;
}

/**
 * Get the session context file path
 */
export function getSessionContextPath(ctx: KspecContext): string {
  return path.join(ctx.specDir, '.kspec-session');
}

/**
 * Load session context (or return empty context if not exists)
 */
export async function loadSessionContext(ctx: KspecContext): Promise<SessionContext> {
  const contextPath = getSessionContextPath(ctx);

  try {
    const raw = await readYamlFile<unknown>(contextPath);
    if (!raw || typeof raw !== 'object') {
      return {
        focus: null,
        threads: [],
        open_questions: [],
        updated_at: new Date().toISOString(),
      };
    }

    const obj = raw as Record<string, unknown>;
    return {
      focus: typeof obj.focus === 'string' ? obj.focus : null,
      threads: Array.isArray(obj.threads) ? obj.threads.filter((t): t is string => typeof t === 'string') : [],
      open_questions: Array.isArray(obj.open_questions) ? obj.open_questions.filter((q): q is string => typeof q === 'string') : [],
      updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : new Date().toISOString(),
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
export async function saveSessionContext(ctx: KspecContext, context: SessionContext): Promise<void> {
  const contextPath = getSessionContextPath(ctx);

  // Update timestamp
  context.updated_at = new Date().toISOString();

  await writeYamlFile(contextPath, context);
}
