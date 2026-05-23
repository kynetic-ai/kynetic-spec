/**
 * Tests that `kspec init` produces a kynetic 1.2 manifest with folder-backed
 * storage declarations for plan, review, and entity-scoped local resources.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempDir, initGitRepo, kspec } from "./helpers/cli.js";

describe("kspec init — folder-backed entity storage declarations", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-init-folder-storage-");
    initGitRepo(testDir);
    await fs.writeFile(path.join(testDir, "README.md"), "# Test Project\n");
    execSync('git add . && git commit -m "Initial commit"', {
      cwd: testDir,
      stdio: "pipe",
    });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
  it("writes kynetic 1.2 with folder/entity_scoped storage declarations into the shadow manifest", async () => {
    const result = kspec("init --no-prompt", testDir);
    expect(result.exitCode).toBe(0);

    const kspecDir = path.join(testDir, ".kspec");
    const entries = await fs.readdir(kspecDir);
    // Shadow init writes the manifest as <project-slug>.yaml; locate it.
    const manifestFile = entries.find(
      (e) => e.endsWith(".yaml") && !e.endsWith(".tasks.yaml") && !e.endsWith(".inbox.yaml"),
    );
    expect(manifestFile).toBeDefined();
    const raw = await fs.readFile(path.join(kspecDir, manifestFile!), "utf-8");
    const manifest = YAML.parse(raw) as Record<string, unknown>;

    expect(manifest.kynetic).toBe("1.2");
    expect((manifest.task_storage as Record<string, unknown>)?.format).toBe("split");
    expect((manifest.plan_storage as Record<string, unknown>)?.format).toBe("folder");
    expect((manifest.review_storage as Record<string, unknown>)?.format).toBe("folder");
    expect((manifest.resource_storage as Record<string, unknown>)?.format).toBe("entity_scoped");
  });

  // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
  it("writes kynetic 1.2 with folder/entity_scoped declarations in non-shadow mode", async () => {
    // Non-git directory triggers non-shadow init path with the same manifest contract.
    const nonGitDir = await createTempDir("kspec-init-folder-storage-nonshadow-");
    try {
      const result = kspec(`init --no-prompt --name TestProj`, nonGitDir);
      expect(result.exitCode).toBe(0);

      // In non-shadow mode the manifest is written to spec/<slug>.yaml
      const specDir = path.join(nonGitDir, "spec");
      const entries = await fs.readdir(specDir);
      const manifestFile = entries.find(
        (e) => e.endsWith(".yaml") && !e.endsWith(".tasks.yaml"),
      );
      expect(manifestFile).toBeDefined();

      const raw = await fs.readFile(path.join(specDir, manifestFile!), "utf-8");
      const manifest = YAML.parse(raw) as Record<string, unknown>;

      expect(manifest.kynetic).toBe("1.2");
      expect((manifest.task_storage as Record<string, unknown>)?.format).toBe("split");
      expect((manifest.plan_storage as Record<string, unknown>)?.format).toBe("folder");
      expect((manifest.review_storage as Record<string, unknown>)?.format).toBe("folder");
      expect((manifest.resource_storage as Record<string, unknown>)?.format).toBe("entity_scoped");
    } finally {
      await cleanupTempDir(nonGitDir);
    }
  });
});
