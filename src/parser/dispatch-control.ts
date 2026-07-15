import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseDocument, stringify } from "yaml";
import {
  createMissingDispatchControl,
  DispatchControlSchema,
  type DispatchControl,
} from "../schema/dispatch-control.js";
import { withFileLock } from "./file-lock.js";

export const DISPATCH_CONTROL_FILE = "dispatch-control.yaml";

export function getDispatchControlPath(specDir: string): string {
  return path.join(specDir, DISPATCH_CONTROL_FILE);
}

export function parseDispatchControl(content: string): DispatchControl {
  const document = parseDocument(content, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`Invalid dispatch-control.yaml: ${document.errors[0]?.message}`);
  }
  const parsed = DispatchControlSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw new Error(`Invalid dispatch-control.yaml: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

export function serializeDispatchControl(snapshot: DispatchControl): string {
  const parsed = DispatchControlSchema.parse(snapshot);
  return stringify(parsed, { lineWidth: 0 });
}

export async function readDispatchControlFile(specDir: string): Promise<DispatchControl> {
  try {
    return parseDispatchControl(await fs.readFile(getDispatchControlPath(specDir), "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createMissingDispatchControl();
    }
    throw error;
  }
}

export async function replaceDispatchControlFile(
  specDir: string,
  snapshot: DispatchControl,
): Promise<{ path: string; bytes: string }> {
  const filePath = getDispatchControlPath(specDir);
  const bytes = serializeDispatchControl(snapshot);
  await withFileLock(filePath, async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, bytes, "utf-8");
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  });
  return { path: filePath, bytes };
}
