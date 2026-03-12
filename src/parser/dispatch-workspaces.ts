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

function defaultLegacyIntegrationOutcome(
  status: unknown,
  publicationMode: unknown,
): string {
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

      const publicationMode = integration.publication_mode === "pull_request"
        || integration.publication_mode === "manual_merge"
        ? integration.publication_mode
        : integration.outcome === "pull_request"
          || integration.outcome === "manual_merge"
          ? integration.outcome
          : "manual_merge";
      const targetCommit = typeof integration.target_commit === "string" && integration.target_commit.trim().length > 0
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
          outcome: integration.outcome ?? defaultLegacyIntegrationOutcome(integration.status, publicationMode),
        },
      };
    }),
  };
}

function formatRegistryValidationError(raw: unknown): string {
  const parsed = DispatchWorkspaceRegistryFileSchema.safeParse(
    normalizeLegacyRegistryRaw(raw),
  );
  if (parsed.success) {
    return "Unknown dispatch workspace registry validation error";
  }

  return parsed.error.issues
    .map((issue) => {
      const issuePath = issue.path.length > 0
        ? issue.path.map((segment) => String(segment)).join(".")
        : "root";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}

function parseRegistryFromRaw(raw: unknown): DispatchWorkspaceRecord[] {
  const parsed = DispatchWorkspaceRegistryFileSchema.safeParse(
    normalizeLegacyRegistryRaw(raw),
  );
  if (parsed.success) {
    return parsed.data.workspaces;
  }

  throw new Error(formatRegistryValidationError(raw));
}

async function loadRegistryFile(
  registryPath: string,
): Promise<DispatchWorkspaceRecord[]> {
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
    const workspaces = await loadRegistryFile(registryPath);

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
