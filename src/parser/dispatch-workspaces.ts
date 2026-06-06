import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "./file-lock.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, writeYamlFilePreserveFormat } from "./yaml.js";
import {
  type DispatchWorkspaceRecord,
  DispatchWorkspaceRecordSchema,
  DispatchWorkspaceRegistryFileSchema,
} from "../schema/index.js";

export interface LoadedDispatchWorkspaceRecord extends DispatchWorkspaceRecord {
  _sourceFile?: string;
}

export function getDispatchWorkspaceRegistryPath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.dispatch-workspaces.yaml");
}

function defaultLegacyIntegrationOutcome(status: unknown, publicationMode: unknown): string {
  switch (status) {
    case "merged":
    case "abandoned":
    case "reset":
      return status;
    default:
      return publicationMode === "pull_request" ? "pull_request" : "manual_merge";
  }
}

function normalizeLegacyRegistryRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") {
    return raw;
  }

  const registry = raw as {
    workspaces?: unknown[];
  };
  if (!Array.isArray(registry.workspaces)) {
    return raw;
  }

  return {
    ...registry,
    workspaces: registry.workspaces.map((workspace) => {
      if (!workspace || typeof workspace !== "object") {
        return workspace;
      }

      const record = workspace as {
        base_branch_point?: unknown;
        canonical_branch_head?: unknown;
        integration?: {
          status?: unknown;
          target_branch?: unknown;
          target_commit?: unknown;
          publication_mode?: unknown;
          outcome?: unknown;
          detail?: unknown;
          updated_at?: unknown;
        };
      };
      const integration = record.integration;
      if (!integration || typeof integration !== "object") {
        return workspace;
      }

      const publicationMode =
        integration.publication_mode === "pull_request" ||
        integration.publication_mode === "manual_merge"
          ? integration.publication_mode
          : integration.outcome === "pull_request" || integration.outcome === "manual_merge"
            ? integration.outcome
            : "manual_merge";
      const targetCommit =
        typeof integration.target_commit === "string" && integration.target_commit.trim().length > 0
          ? integration.target_commit
          : typeof record.base_branch_point === "string" &&
              record.base_branch_point.trim().length > 0
            ? record.base_branch_point
            : record.canonical_branch_head;

      return {
        ...record,
        integration: {
          ...integration,
          target_commit: targetCommit,
          publication_mode: publicationMode,
          outcome:
            integration.outcome ??
            defaultLegacyIntegrationOutcome(integration.status, publicationMode),
        },
      };
    }),
  };
}

/**
 * Normalize a single legacy workspace record (same logic as normalizeLegacyRegistryRaw
 * but for one workspace instead of the full registry).
 */
function normalizeLegacyWorkspaceRaw(workspace: unknown): unknown {
  if (!workspace || typeof workspace !== "object") {
    return workspace;
  }

  const record = workspace as {
    base_branch_point?: unknown;
    canonical_branch_head?: unknown;
    integration?: {
      status?: unknown;
      target_branch?: unknown;
      target_commit?: unknown;
      publication_mode?: unknown;
      outcome?: unknown;
      detail?: unknown;
      updated_at?: unknown;
    };
  };
  const integration = record.integration;
  if (!integration || typeof integration !== "object") {
    return workspace;
  }

  const publicationMode =
    integration.publication_mode === "pull_request" ||
    integration.publication_mode === "manual_merge"
      ? integration.publication_mode
      : integration.outcome === "pull_request" || integration.outcome === "manual_merge"
        ? integration.outcome
        : "manual_merge";
  const targetCommit =
    typeof integration.target_commit === "string" && integration.target_commit.trim().length > 0
      ? integration.target_commit
      : typeof record.base_branch_point === "string" && record.base_branch_point.trim().length > 0
        ? record.base_branch_point
        : record.canonical_branch_head;

  return {
    ...record,
    integration: {
      ...integration,
      target_commit: targetCommit,
      publication_mode: publicationMode,
      outcome:
        integration.outcome ?? defaultLegacyIntegrationOutcome(integration.status, publicationMode),
    },
  };
}

function formatRegistryValidationError(raw: unknown): string {
  const parsed = DispatchWorkspaceRegistryFileSchema.safeParse(normalizeLegacyRegistryRaw(raw));
  if (parsed.success) {
    return "Unknown dispatch workspace registry validation error";
  }

  return parsed.error.issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join(".") : "root";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

function parseRegistryFromRaw(raw: unknown): DispatchWorkspaceRecord[] {
  const parsed = DispatchWorkspaceRegistryFileSchema.safeParse(normalizeLegacyRegistryRaw(raw));
  if (parsed.success) {
    return parsed.data.workspaces;
  }

  throw new Error(formatRegistryValidationError(raw));
}

async function loadRegistryFile(registryPath: string): Promise<DispatchWorkspaceRecord[]> {
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return parseRegistryFromRaw(raw);
}

function stripRuntimeMetadata(
  record: DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord,
): DispatchWorkspaceRecord {
  const { _sourceFile, ...cleanRecord } = record as LoadedDispatchWorkspaceRecord;
  return cleanRecord as DispatchWorkspaceRecord;
}

function isOpenWorkspace(record: DispatchWorkspaceRecord): boolean {
  return record.lifecycle_state !== "closed";
}

function _validateSingleOpenWorkspacePerTask(records: DispatchWorkspaceRecord[]): void {
  // Key uniqueness on canonical task identity (task_id) when present so two
  // non-closed records for different display aliases of the same task are
  // rejected. Historical records without task_id fall back to task_ref.
  // AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
  const openCounts = new Map<string, string[]>();
  for (const record of records) {
    if (!isOpenWorkspace(record)) continue;
    const key = record.task_id ?? record.task_ref;
    const existing = openCounts.get(key) ?? [];
    existing.push(record.workspace_id);
    openCounts.set(key, existing);
  }

  for (const [taskKey, workspaceIds] of openCounts) {
    if (workspaceIds.length > 1) {
      throw new Error(
        `Task ${taskKey} has multiple active dispatch workspace records: ${workspaceIds.join(", ")}`,
      );
    }
  }
}

export async function loadDispatchWorkspaceRegistry(
  ctx: KspecContext,
): Promise<LoadedDispatchWorkspaceRecord[]> {
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);
  const workspaces = await loadRegistryFile(registryPath);
  return workspaces.map((workspace) => ({
    ...workspace,
    _sourceFile: registryPath,
  }));
}

export async function findDispatchWorkspaceByTaskRef(
  ctx: KspecContext,
  taskRef: string,
  options: { includeClosed?: boolean } = {},
): Promise<LoadedDispatchWorkspaceRecord | undefined> {
  const workspaces = await loadDispatchWorkspaceRegistry(ctx);
  const matches = workspaces.filter((workspace) => workspace.task_ref === taskRef);
  const filtered = options.includeClosed
    ? matches
    : matches.filter((workspace) => workspace.lifecycle_state !== "closed");
  return [...filtered].sort((a, b) =>
    a.timestamps.updated_at < b.timestamps.updated_at ? 1 : -1,
  )[0];
}

export async function findDispatchWorkspaceById(
  ctx: KspecContext,
  workspaceId: string,
): Promise<LoadedDispatchWorkspaceRecord | undefined> {
  const workspaces = await loadDispatchWorkspaceRegistry(ctx);
  return workspaces.find((workspace) => workspace.workspace_id === workspaceId);
}

/** Default retention threshold for closed workspace records (7 days in milliseconds). */
export const CLOSED_WORKSPACE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function _isClosedBeyondRetention(
  record: DispatchWorkspaceRecord,
  now: number,
  retentionMs: number,
): boolean {
  if (record.lifecycle_state !== "closed") return false;
  const closedAt = record.timestamps.closed_at;
  if (!closedAt) return false;
  return now - new Date(closedAt).getTime() > retentionMs;
}

/**
 * Check if a raw workspace record is closed beyond the retention threshold.
 * Operates on untyped raw data to avoid schema parsing for non-target records.
 */
function isRawClosedBeyondRetention(rawRecord: unknown, now: number, retentionMs: number): boolean {
  if (!rawRecord || typeof rawRecord !== "object") return false;
  const rec = rawRecord as Record<string, unknown>;
  if (rec.lifecycle_state !== "closed") return false;
  const timestamps = rec.timestamps;
  if (!timestamps || typeof timestamps !== "object") return false;
  const closedAt = (timestamps as Record<string, unknown>).closed_at;
  if (typeof closedAt !== "string") return false;
  return now - new Date(closedAt).getTime() > retentionMs;
}

/**
 * Extract the raw workspace array and wrapper metadata from a YAML file.
 * Does NOT run schema validation — preserves original data for round-trip stability.
 */
async function extractRawWorkspaceArray(
  filePath: string,
): Promise<{ rawWorkspaces: unknown[]; wrapperObj?: Record<string, unknown> }> {
  let existingRaw: unknown = null;

  try {
    existingRaw = await readYamlFile<unknown>(filePath);
  } catch {
    // File doesn't exist
    return { rawWorkspaces: [] };
  }

  if (!existingRaw || typeof existingRaw !== "object") {
    return { rawWorkspaces: [] };
  }

  const wrapper = existingRaw as Record<string, unknown>;
  const workspaces = wrapper.workspaces;
  return {
    rawWorkspaces: Array.isArray(workspaces) ? workspaces : [],
    wrapperObj: wrapper,
  };
}

/**
 * Write raw workspace array back to file, preserving wrapper metadata.
 */
async function writeRawWorkspaceArray(
  filePath: string,
  rawWorkspaces: unknown[],
  wrapperObj?: Record<string, unknown>,
): Promise<void> {
  const output = wrapperObj
    ? { ...wrapperObj, workspaces: rawWorkspaces }
    : { kynetic_dispatch_workspaces: "1.0", workspaces: rawWorkspaces };
  await writeYamlFilePreserveFormat(filePath, output);
}

/**
 * Find workspace index in a raw array by workspace_id match.
 */
function findRawWorkspaceIndex(rawWorkspaces: unknown[], workspaceId: string): number {
  return rawWorkspaces.findIndex(
    (w) =>
      w && typeof w === "object" && (w as Record<string, unknown>).workspace_id === workspaceId,
  );
}

/**
 * Check if a value is a Zod default that should not be added to raw data
 * when the field wasn't originally present. Dispatch workspace records have
 * deeply nested schema defaults (branch_provenance objects, roleStates, etc.)
 * that must not pollute non-original fields.
 */
function isTrivialDefault(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value === false) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  // Treat plain objects not in raw as schema defaults — they would be
  // default-constructed objects like branch_provenance, roleStates, etc.
  if (typeof value === "object" && !Array.isArray(value)) return true;
  return false;
}

/**
 * Merge a schema-normalized workspace onto the original raw workspace data.
 * Recursively preserves the raw shape: fields not present in the original
 * YAML are only included if they carry non-default values. Nested objects
 * (like bootstrap, integration, etc.) are merged recursively so that
 * deeply nested Zod defaults don't leak into output.
 *
 * When `preMutationWorkspace` is provided (for atomic mutations), fields
 * absent from raw data are compared against the pre-mutation record. If the
 * value differs from pre-mutation, the callback explicitly set it and it
 * must be persisted — even if `isTrivialDefault` would otherwise suppress it.
 */
function mergeWorkspacePreservingRawShape(
  rawWorkspace: Record<string, unknown>,
  normalizedWorkspace: Record<string, unknown>,
  preMutationWorkspace?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(normalizedWorkspace)) {
    if (key in rawWorkspace) {
      const rawValue = rawWorkspace[key];
      // Both values are plain objects — recurse to preserve nested raw shape
      if (
        rawValue != null &&
        typeof rawValue === "object" &&
        !Array.isArray(rawValue) &&
        value != null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const preMutationNested = preMutationWorkspace?.[key];
        result[key] = mergeWorkspacePreservingRawShape(
          rawValue as Record<string, unknown>,
          value as Record<string, unknown>,
          preMutationNested != null &&
            typeof preMutationNested === "object" &&
            !Array.isArray(preMutationNested)
            ? (preMutationNested as Record<string, unknown>)
            : undefined,
        );
      } else {
        // Scalar, array, or type mismatch — use the normalized value
        result[key] = value;
      }
    } else {
      // Field was added by schema normalization — only include if non-trivial
      // OR if the callback explicitly changed it from its pre-mutation value
      if (!isTrivialDefault(value)) {
        result[key] = value;
      } else if (preMutationWorkspace && !deepEqual(value, preMutationWorkspace[key])) {
        // The callback changed this field from its Zod default — persist it
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Deep equality check for comparing pre/post-mutation values.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => k in bObj && deepEqual(aObj[k], bObj[k]));
}

/**
 * Validate the single-open-workspace-per-task constraint on raw data.
 * Operates on untyped raw records to avoid schema parsing.
 */
function validateSingleOpenWorkspacePerTaskRaw(rawWorkspaces: unknown[]): void {
  // Key uniqueness on canonical task identity (task_id) when present.
  // AC: @dispatch-canonical-task-identity ac-workspace-registry-canonical-task-identity
  const openCounts = new Map<string, string[]>();
  for (const rawWs of rawWorkspaces) {
    if (!rawWs || typeof rawWs !== "object") continue;
    const rec = rawWs as Record<string, unknown>;
    if (rec.lifecycle_state === "closed") continue;
    const taskRef = rec.task_ref as string;
    const taskId = typeof rec.task_id === "string" ? rec.task_id : null;
    const workspaceId = rec.workspace_id as string;
    if (!taskRef || !workspaceId) continue;
    const key = taskId ?? taskRef;
    const existing = openCounts.get(key) ?? [];
    existing.push(workspaceId);
    openCounts.set(key, existing);
  }

  for (const [taskKey, workspaceIds] of openCounts) {
    if (workspaceIds.length > 1) {
      throw new Error(
        `Task ${taskKey} has multiple active dispatch workspace records: ${workspaceIds.join(", ")}`,
      );
    }
  }
}

/**
 * Save a dispatch workspace record.
 *
 * Non-target workspaces are preserved as raw data (no schema parsing) to ensure
 * round-trip stability — fields not present in the original YAML won't be
 * added by Zod defaults.
 */
export async function saveDispatchWorkspaceRecord(
  ctx: KspecContext,
  record: LoadedDispatchWorkspaceRecord,
  options?: { retentionMs?: number },
): Promise<void> {
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);
  const retentionMs = options?.retentionMs ?? CLOSED_WORKSPACE_RETENTION_MS;

  await withFileLock(registryPath, async () => {
    const dir = path.dirname(registryPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw workspace data without schema normalization
    // oxlint-disable-next-line eslint/prefer-const -- rawWorkspaces is reassigned, wrapperObj shares destructuring
    let { rawWorkspaces, wrapperObj } = await extractRawWorkspaceArray(registryPath);

    // Validate existing registry content to catch corruption early.
    // This is a read-only check — the parsed result is not used for writing.
    const registryCheck = DispatchWorkspaceRegistryFileSchema.safeParse(
      normalizeLegacyRegistryRaw(
        wrapperObj ? { ...wrapperObj, workspaces: rawWorkspaces } : { workspaces: rawWorkspaces },
      ),
    );
    if (!registryCheck.success) {
      throw new Error(
        formatRegistryValidationError(
          wrapperObj ? { ...wrapperObj, workspaces: rawWorkspaces } : { workspaces: rawWorkspaces },
        ),
      );
    }

    const cleanRecord = stripRuntimeMetadata(record);
    const existingIndex = findRawWorkspaceIndex(rawWorkspaces, cleanRecord.workspace_id);
    if (existingIndex >= 0) {
      // Merge onto raw data to avoid adding Zod defaults for absent fields
      const rawTarget = rawWorkspaces[existingIndex] as Record<string, unknown>;
      rawWorkspaces[existingIndex] = mergeWorkspacePreservingRawShape(
        rawTarget,
        cleanRecord as unknown as Record<string, unknown>,
      );
    } else {
      rawWorkspaces.push(cleanRecord);
    }

    // Purge closed records older than the retention threshold (ac-9)
    const now = Date.now();
    rawWorkspaces = rawWorkspaces.filter((ws) => !isRawClosedBeyondRetention(ws, now, retentionMs));

    validateSingleOpenWorkspacePerTaskRaw(rawWorkspaces);

    await writeRawWorkspaceArray(registryPath, rawWorkspaces, wrapperObj);
  });
}

/**
 * Atomically mutate a dispatch workspace record using the latest on-disk state.
 *
 * The callback receives the current record value while holding the registry file lock.
 * Non-target workspaces are preserved as raw data (no schema parsing) to ensure
 * round-trip stability.
 */
export async function mutateDispatchWorkspaceRecordAtomically(
  ctx: KspecContext,
  workspaceId: string,
  mutate: (
    latestRecord: LoadedDispatchWorkspaceRecord,
  ) =>
    | DispatchWorkspaceRecord
    | LoadedDispatchWorkspaceRecord
    | Promise<DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord>,
): Promise<LoadedDispatchWorkspaceRecord> {
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);
  let updatedRecord: LoadedDispatchWorkspaceRecord | undefined;

  await withFileLock(registryPath, async () => {
    const dir = path.dirname(registryPath);
    await fs.mkdir(dir, { recursive: true });

    // Load raw workspace data without schema normalization for non-target workspaces
    const { rawWorkspaces, wrapperObj } = await extractRawWorkspaceArray(registryPath).catch(() => {
      throw new Error(`Dispatch workspace registry not found: ${registryPath}`);
    });

    if (rawWorkspaces.length === 0) {
      throw new Error(`Dispatch workspace registry not found: ${registryPath}`);
    }

    // Validate existing registry content to catch corruption early.
    // This ensures malformed sibling records are rejected before rewriting.
    const registryCheck = DispatchWorkspaceRegistryFileSchema.safeParse(
      normalizeLegacyRegistryRaw(
        wrapperObj ? { ...wrapperObj, workspaces: rawWorkspaces } : { workspaces: rawWorkspaces },
      ),
    );
    if (!registryCheck.success) {
      throw new Error(
        formatRegistryValidationError(
          wrapperObj ? { ...wrapperObj, workspaces: rawWorkspaces } : { workspaces: rawWorkspaces },
        ),
      );
    }

    const wsIndex = findRawWorkspaceIndex(rawWorkspaces, workspaceId);
    if (wsIndex === -1) {
      throw new Error(`Dispatch workspace not found in registry: ${workspaceId}`);
    }

    // Apply legacy normalization only to the target workspace, then schema-parse
    const rawTarget = rawWorkspaces[wsIndex];
    const normalizedTarget = normalizeLegacyWorkspaceRaw(rawTarget);
    const parsed = DispatchWorkspaceRecordSchema.safeParse(normalizedTarget);
    if (!parsed.success) {
      throw new Error(
        `Invalid dispatch workspace data for ${workspaceId}: ${parsed.error.message}`,
      );
    }
    const latestRecord: LoadedDispatchWorkspaceRecord = {
      ...parsed.data,
      _sourceFile: registryPath,
    };

    // Snapshot the pre-mutation parsed record for detecting callback-set fields
    const preMutationRecord = stripRuntimeMetadata(latestRecord);

    const mutated = await mutate(latestRecord);
    const cleanMutated = stripRuntimeMetadata(mutated);

    // Merge onto raw data to avoid adding Zod defaults for absent fields.
    // Pass pre-mutation record so the merge can detect callback-added fields
    // (fields that changed between pre-mutation and post-mutation are persisted
    // even if they would otherwise be suppressed as trivial defaults).
    rawWorkspaces[wsIndex] = mergeWorkspacePreservingRawShape(
      rawTarget as Record<string, unknown>,
      cleanMutated as unknown as Record<string, unknown>,
      preMutationRecord as unknown as Record<string, unknown>,
    );

    validateSingleOpenWorkspacePerTaskRaw(rawWorkspaces);

    await writeRawWorkspaceArray(registryPath, rawWorkspaces, wrapperObj);

    updatedRecord = {
      ...cleanMutated,
      _sourceFile: registryPath,
    };
  });

  if (!updatedRecord) {
    throw new Error(`Failed to update dispatch workspace: ${workspaceId}`);
  }

  return updatedRecord;
}

/**
 * Delete a dispatch workspace record from the registry by workspace_id.
 *
 * Operates within the file lock to ensure atomicity. Non-target workspaces
 * are preserved as raw data (no schema parsing) to maintain round-trip stability.
 *
 * AC: @dispatch-workspace-registry ac-14
 */
export async function deleteDispatchWorkspaceRecord(
  ctx: KspecContext,
  workspaceId: string,
): Promise<void> {
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);

  await withFileLock(registryPath, async () => {
    const { rawWorkspaces, wrapperObj } = await extractRawWorkspaceArray(registryPath).catch(
      () => ({
        rawWorkspaces: [] as unknown[],
        wrapperObj: undefined,
      }),
    );

    const wsIndex = findRawWorkspaceIndex(rawWorkspaces, workspaceId);
    if (wsIndex === -1) {
      // Record already absent — nothing to do.
      return;
    }

    rawWorkspaces.splice(wsIndex, 1);

    await writeRawWorkspaceArray(registryPath, rawWorkspaces, wrapperObj);
  });
}
