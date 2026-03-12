import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readYamlFile, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";

describe("atomic yaml writes", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  it("replaces YAML through temp-file renames without leaving temp artifacts behind", async () => {
    tempDir = await createTempDir("kspec-yaml-atomic-");
    const filePath = path.join(tempDir, "project.dispatch-workspaces.yaml");

    for (const workspaceId of ["old", "next", "final"]) {
      await writeYamlFilePreserveFormat(filePath, {
        kynetic_dispatch_workspaces: "1.0",
        workspaces: [{ workspace_id: workspaceId, task_ref: `@${workspaceId}-task` }],
      });
    }

    const afterWrite = await readYamlFile<{
      workspaces: Array<{ workspace_id: string; task_ref: string }>;
    }>(filePath);
    expect(afterWrite.workspaces).toEqual([{ workspace_id: "final", task_ref: "@final-task" }]);

    const siblingFiles = await fs.readdir(tempDir);
    expect(siblingFiles.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
