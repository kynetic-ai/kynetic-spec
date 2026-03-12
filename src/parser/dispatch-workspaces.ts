import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withFileLock } from "./file-lock.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, writeYamlFilePreserveFormat } from "./yaml.js";
import {
  type DispatchWorkspaceRecord,
  DispatchWorkspaceRecordSchema,
  type DispatchWorkspaceRegistryFile,
  DispatchWorkspaceRegistryFileSchema,
} from "../schema/index.js";

export interface LoadedDispatchWorkspaceRecord extends DispatchWorkspaceRecord {
  _sourceFile?: string;
}

export function getDispatchWorkspaceRegistryPath(ctx: KspecContext): string {
  return path.join(ctx.specDir, "project.dispatch-workspaces.yaml");
}

function parseRegistryFromRaw(raw: unknown): DispatchWorkspaceRecord[] {
  const parsed = DispatchWorkspaceRegistryFileSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data.workspaces;
  }

  if (raw && typeof raw === "object" && "workspaces" in raw) {
    const fallbackRecords = (raw as { workspaces?: unknown }).workspaces;
    if (Array.isArray(fallbackRecords)) {
      const workspaces: DispatchWorkspaceRecord[] = [];
      for (const workspace of fallbackRecords) {
        const result = DispatchWorkspaceRecordSchema.safeParse(workspace);
        if (result.success) {
          workspaces.push(result.data);
        }
      }
      return workspaces;
    }
  }

  return [];
}

async function loadRegistryFile(
  registryPath: string,
): Promise<DispatchWorkspaceRecord[]> {
  const raw = await readYamlFile<unknown>(registryPath);
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

function validateSingleOpenWorkspacePerTask(
  records: DispatchWorkspaceRecord[],
): void {
  const openCounts = new Map<string, string[]>();
  for (const record of records) {
    if (!isOpenWorkspace(record)) continue;
    const existing = openCounts.get(record.task_ref) ?? [];
    existing.push(record.workspace_id);
    openCounts.set(record.task_ref, existing);
  }

  for (const [taskRef, workspaceIds] of openCounts) {
    if (workspaceIds.length > 1) {
      throw new Error(
        `Task ${taskRef} has multiple active dispatch workspace records: ${workspaceIds.join(", ")}`,
      );
    }
  }
}

export async function loadDispatchWorkspaceRegistry(
  ctx: KspecContext,
): Promise<LoadedDispatchWorkspaceRecord[]> {
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);

  try {
    const workspaces = await loadRegistryFile(registryPath);
    return workspaces.map((workspace) => ({
      ...workspace,
      _sourceFile: registryPath,
    }));
  } catch {
    return [];
  }
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
  return filtered.sort((a, b) =>
    a.timestamps.updated_at < b.timestamps.updated_at ? 1 : -1
  )[0];
}

export async function findDispatchWorkspaceById(
  ctx: KspecContext,
  workspaceId: string,
): Promise<LoadedDispatchWorkspaceRecord | undefined> {
  const workspaces = await loadDispatchWorkspaceRegistry(ctx);
  return workspaces.find((workspace) => workspace.workspace_id === workspaceId);
}

export async function saveDispatchWorkspaceRecord(
  ctx: KspecContext,
  record: LoadedDispatchWorkspaceRecord,
): Promise<void> {
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);

  await withFileLock(registryPath, async () => {
    const dir = path.dirname(registryPath);
    await fs.mkdir(dir, { recursive: true });

    let workspaces: DispatchWorkspaceRecord[] = [];
    try {
      workspaces = await loadRegistryFile(registryPath);
    } catch {
      // Start fresh.
    }

    const cleanRecord = stripRuntimeMetadata(record);
    const index = workspaces.findIndex(
      (workspace) => workspace.workspace_id === cleanRecord.workspace_id,
    );
    if (index >= 0) {
      workspaces[index] = cleanRecord;
    } else {
      workspaces.push(cleanRecord);
    }

    validateSingleOpenWorkspacePerTask(workspaces);

    const registryFile: DispatchWorkspaceRegistryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces,
    };
    await writeYamlFilePreserveFormat(registryPath, registryFile);
  });
}

export async function mutateDispatchWorkspaceRecordAtomically(
  ctx: KspecContext,
  workspaceId: string,
  mutate: (
    latestRecord: LoadedDispatchWorkspaceRecord,
  ) => DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord | Promise<DispatchWorkspaceRecord | LoadedDispatchWorkspaceRecord>,
): Promise<LoadedDispatchWorkspaceRecord> {
  const registryPath = getDispatchWorkspaceRegistryPath(ctx);
  let updatedRecord: LoadedDispatchWorkspaceRecord | undefined;

  await withFileLock(registryPath, async () => {
    const dir = path.dirname(registryPath);
    await fs.mkdir(dir, { recursive: true });

    const workspaces = await loadRegistryFile(registryPath).catch(() => {
      throw new Error(`Dispatch workspace registry not found: ${registryPath}`);
    });

    const index = workspaces.findIndex(
      (workspace) => workspace.workspace_id === workspaceId,
    );
    if (index === -1) {
      throw new Error(`Dispatch workspace not found in registry: ${workspaceId}`);
    }

    const latestRecord: LoadedDispatchWorkspaceRecord = {
      ...workspaces[index],
      _sourceFile: registryPath,
    };

    const mutated = await mutate(latestRecord);
    workspaces[index] = stripRuntimeMetadata(mutated);
    validateSingleOpenWorkspacePerTask(workspaces);

    const registryFile: DispatchWorkspaceRegistryFile = {
      kynetic_dispatch_workspaces: "1.0",
      workspaces,
    };
    await writeYamlFilePreserveFormat(registryPath, registryFile);

    updatedRecord = {
      ...workspaces[index],
      _sourceFile: registryPath,
    };
  });

  if (!updatedRecord) {
    throw new Error(`Failed to update dispatch workspace: ${workspaceId}`);
  }

  return updatedRecord;
}
