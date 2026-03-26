/**
 * Tests for version-gated legacy format detection.
 *
 * Verifies that projects using kynetic 1.0 without task_storage.format: "split"
 * are rejected with clear migration guidance, and that the migration command
 * upgrades the manifest correctly.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { resolveTaskDataManager, TaskDataManager } from "../src/parser/task-data-manager.js";
import type { KspecContext } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecJson,
  testUlids,
} from "./helpers/cli.js";

// Register the split backend so TaskDataManager can load split-format data
ensureSplitBackendRegistered();

// AC: @task-remove-monolithic — version-gated legacy detection
describe("Legacy format detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  /**
   * Helper: set up a legacy (kynetic 1.0, no split format) project.
   */
  async function setupLegacyProject(
    dir: string,
    opts?: { format?: string; version?: string },
  ): Promise<{ specDir: string; env: Record<string, string> }> {
    initGitRepo(dir);
    const specDir = path.join(dir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });

    const manifest: Record<string, unknown> = {
      kynetic: opts?.version ?? "1.0",
      project: { name: "Legacy Test", version: "0.1.0", status: "draft" },
    };
    if (opts?.format) {
      manifest.task_storage = { format: opts.format };
    }

    await fs.writeFile(path.join(specDir, "kynetic.yaml"), toYaml(manifest));
    await fs.writeFile(path.join(specDir, "project.tasks.yaml"), toYaml([]));

    return { specDir, env: { KSPEC_SPEC_DIR: specDir } };
  }

  // AC: @task-remove-monolithic — resolveTaskDataManager rejects legacy projects
  it("resolveTaskDataManager throws for kynetic 1.0 without split format", () => {
    const legacyCtx = {
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir: path.join(tempDir, ".kspec"),
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: path.join(tempDir, ".kspec", "kynetic.yaml"),
      manifest: {
        kynetic: "1.0",
        project: { name: "Legacy", version: "0.1.0", status: "draft" as const },
        sessions: { storage: "local" as const },
      },
      shadow: null,
      config: {} as any,
    } satisfies KspecContext;

    expect(() => resolveTaskDataManager(legacyCtx)).toThrow(
      /monolithic task storage format has been removed/,
    );
  });

  // AC: @task-remove-monolithic — clear migration guidance in error
  it("version-gated error includes migration guidance", () => {
    const legacyCtx = {
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir: path.join(tempDir, ".kspec"),
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: path.join(tempDir, ".kspec", "kynetic.yaml"),
      manifest: {
        kynetic: "1.0",
        project: { name: "Legacy", version: "0.1.0", status: "draft" as const },
        sessions: { storage: "local" as const },
      },
      shadow: null,
      config: {} as any,
    } satisfies KspecContext;

    try {
      resolveTaskDataManager(legacyCtx);
      expect.unreachable("should have thrown");
    } catch (err: any) {
      // Migration guidance is in the suggestion field, not the message
      expect(err.suggestion).toContain("kspec task migrate");
    }
  });

  // AC: @task-remove-monolithic — split format works normally
  it("resolveTaskDataManager succeeds for kynetic 1.1 with split format", () => {
    const splitCtx = {
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir: path.join(tempDir, ".kspec"),
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: path.join(tempDir, ".kspec", "kynetic.yaml"),
      manifest: {
        kynetic: "1.1",
        project: { name: "Modern", version: "0.1.0", status: "draft" as const },
        task_storage: { format: "split" as const },
        sessions: { storage: "local" as const },
      },
      shadow: null,
      config: {} as any,
    } satisfies KspecContext;

    const manager = resolveTaskDataManager(splitCtx);
    expect(manager.storageFormat).toBe("split");
  });

  // AC: @task-remove-monolithic — version >= 1.1 implies split even without explicit format
  it("resolveTaskDataManager succeeds for kynetic 1.1 without explicit split format", () => {
    const ctx = {
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir: path.join(tempDir, ".kspec"),
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: path.join(tempDir, ".kspec", "kynetic.yaml"),
      manifest: {
        kynetic: "1.1",
        project: { name: "Modern", version: "0.1.0", status: "draft" as const },
        sessions: { storage: "local" as const },
      },
      shadow: null,
      config: {} as any,
    } satisfies KspecContext;

    const manager = resolveTaskDataManager(ctx);
    expect(manager.storageFormat).toBe("split");
  });

  // AC: @task-remove-monolithic — TaskDataManager defaults to split
  it("TaskDataManager defaults to split format", () => {
    const manager = new TaskDataManager();
    expect(manager.storageFormat).toBe("split");
  });

  // AC: @task-remove-monolithic — migrate updates manifest
  it("kspec task migrate sets task_storage.format and bumps version", async () => {
    const { specDir, env } = await setupLegacyProject(tempDir);

    // Write monolithic-style tasks (with notes array inline)
    const [ulid] = testUlids("LGCY", 1);
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml([
        {
          _ulid: ulid,
          slugs: ["legacy-task"],
          title: "Legacy task",
          type: "task",
          status: "pending",
          priority: 3,
          tags: [],
          depends_on: [],
          blocked_by: [],
          created_at: "2026-01-01T00:00:00.000Z",
          notes: [{ content: "A note", author: "test", created_at: "2026-01-01T00:00:00.000Z" }],
          todos: [],
        },
      ]),
    );

    // Run migration
    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);

    // Verify manifest was updated
    const manifestRaw = await fs.readFile(path.join(specDir, "kynetic.yaml"), "utf8");
    const manifest = parseYaml(manifestRaw) as Record<string, unknown>;

    expect(manifest.kynetic).toBe("1.1");
    expect(manifest.task_storage).toEqual({ format: "split" });
  });

  // AC: @task-remove-monolithic — migrate creates per-task directories
  it("kspec task migrate creates per-task directory structure", async () => {
    const { specDir, env } = await setupLegacyProject(tempDir);

    const [ulid] = testUlids("LGCD", 1);
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml([
        {
          _ulid: ulid,
          slugs: ["dir-test"],
          title: "Directory test",
          type: "task",
          status: "pending",
          priority: 3,
          tags: [],
          depends_on: [],
          blocked_by: [],
          created_at: "2026-01-01T00:00:00.000Z",
          notes: [{ content: "Note 1", author: "test", created_at: "2026-01-01T00:00:00.000Z" }],
          todos: [],
        },
      ]),
    );

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);

    // Per-task directory should exist
    const taskDir = path.join(specDir, "tasks", ulid);
    const taskStat = await fs.stat(taskDir);
    expect(taskStat.isDirectory()).toBe(true);

    // task.yaml should exist (core data without notes)
    const taskYaml = await fs.readFile(path.join(taskDir, "task.yaml"), "utf8");
    const taskData = parseYaml(taskYaml) as Record<string, unknown>;
    expect(taskData._ulid).toBe(ulid);
    expect(taskData.title).toBe("Directory test");
    expect(taskData).not.toHaveProperty("notes");

    // notes.yaml should exist
    const notesYaml = await fs.readFile(path.join(taskDir, "notes.yaml"), "utf8");
    const notesData = parseYaml(notesYaml) as Record<string, unknown>;
    expect(notesData.notes).toHaveLength(1);
  });
});
