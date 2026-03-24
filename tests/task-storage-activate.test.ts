import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecJson,
  testUlid,
  testUlids,
} from "./helpers/cli.js";

/**
 * Helper: set up a monolithic task environment in a temp directory.
 */
async function setupMonolithicEnv(
  tempDir: string,
): Promise<{ env: Record<string, string>; specDir: string }> {
  initGitRepo(tempDir);

  const specDir = path.join(tempDir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });

  // Manifest must pass ManifestSchema validation (requires project.name)
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    toYaml({
      kynetic: "1.0",
      project: { name: "test-project" },
    }),
  );

  await fs.writeFile(path.join(specDir, "project.tasks.yaml"), toYaml([]));

  return { env: { KSPEC_SPEC_DIR: specDir }, specDir };
}

/**
 * Helper: create a monolithic task record.
 */
function makeMonolithicTask(
  ulid: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _ulid: ulid,
    slugs: [slug],
    title: `Task ${slug}`,
    type: "task",
    status: "pending",
    priority: 3,
    tags: ["test"],
    depends_on: [],
    blocked_by: [],
    created_at: "2026-03-20T00:00:00.000Z",
    notes: [],
    todos: [],
    ...overrides,
  };
}

/**
 * Helper: create a per-task directory with task.yaml and notes.yaml.
 */
async function createPerTaskDir(
  specDir: string,
  ulid: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const taskDir = path.join(specDir, "tasks", ulid);
  await fs.mkdir(taskDir, { recursive: true });

  const coreData = {
    _ulid: ulid,
    slugs: [slug],
    title: `Task ${slug}`,
    type: "task",
    status: "pending",
    priority: 3,
    tags: ["test"],
    depends_on: [],
    blocked_by: [],
    created_at: "2026-03-20T00:00:00.000Z",
    todos: [],
    ...overrides,
  };

  await fs.writeFile(path.join(taskDir, "task.yaml"), toYaml(coreData));
  await fs.writeFile(path.join(taskDir, "notes.yaml"), toYaml({ notes: [] }));
}

/**
 * Helper: add a lean index entry to project.tasks.yaml.
 */
async function addLeanIndexEntry(
  specDir: string,
  ulid: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const indexPath = path.join(specDir, "project.tasks.yaml");
  const content = await fs.readFile(indexPath, "utf-8");
  const existing = parseYaml(content) || [];
  const entries = Array.isArray(existing) ? existing : [];

  entries.push({
    _ulid: ulid,
    slugs: [slug],
    title: `Task ${slug}`,
    type: "task",
    status: "pending",
    priority: 3,
    tags: ["test"],
    depends_on: [],
    blocked_by: [],
    created_at: "2026-03-20T00:00:00.000Z",
    notes_count: 0,
    todos_count: 0,
    ...overrides,
  });

  await fs.writeFile(indexPath, toYaml(entries));
}

describe("kspec task storage activate (@task-storage-activation)", () => {
  let tempDir: string;
  let env: Record<string, string>;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-activate-");
  });

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // ── AC: @task-storage-activation ac-4 ────────────────────────────────────
  // Given: The storage format setting needs to change
  // When: The activation command is run
  // Then: The setting is persisted and takes effect on the next operation

  // AC: @task-storage-activation ac-4
  it("persists split format setting in manifest", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

    const result = kspec("task storage activate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Split storage format activated");

    // Verify the manifest was updated
    const manifest = parseYaml(await fs.readFile(path.join(specDir, "kynetic.yaml"), "utf-8"));
    expect(manifest.task_storage).toBeDefined();
    expect(manifest.task_storage.format).toBe("split");
  });

  // AC: @task-storage-activation ac-4
  it("setting takes effect on the next operation", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

    // Activate split format
    const activateResult = kspec("task storage activate --force", tempDir, { env });
    expect(activateResult.exitCode).toBe(0);

    // Subsequent task add should use split format (creates per-task directory)
    const addResult = kspec(
      'task add --title "Post-activation task" --slug post-activate-task',
      tempDir,
      { env },
    );
    expect(addResult.exitCode).toBe(0);

    // Verify per-task directory was created (split format behavior)
    const tasksDir = path.join(specDir, "tasks");
    const entries = await fs.readdir(tasksDir);
    const taskDirs = entries.filter((e) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(e));
    expect(taskDirs.length).toBe(1);

    // Verify task.yaml exists in the per-task dir
    const taskYaml = await fs.readFile(path.join(tasksDir, taskDirs[0], "task.yaml"), "utf-8");
    expect(taskYaml).toContain("post-activate-task");
  });

  // AC: @task-storage-activation ac-4
  it("works with JSON output mode", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

    const result = kspecJson<{ success: boolean; format: string; already_active: boolean }>(
      "task storage activate --force",
      tempDir,
      { env },
    );
    expect(result.success).toBe(true);
    expect(result.format).toBe("split");
    expect(result.already_active).toBe(false);
  });

  // AC: @task-storage-activation ac-4
  it("reports already-active when format is already split", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

    // Set manifest to split format already
    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      toYaml({
        kynetic: "1.0",
        project: { name: "test-project" },
        task_storage: { format: "split" },
      }),
    );

    const result = kspecJson<{ success: boolean; already_active: boolean; format: string }>(
      "task storage activate --force",
      tempDir,
      { env },
    );
    expect(result.success).toBe(true);
    expect(result.already_active).toBe(true);
    expect(result.format).toBe("split");
  });

  // AC: @task-storage-activation ac-4
  it("rejects activation when unmigrated tasks exist", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

    // Write monolithic-format tasks (with `notes` arrays, not `notes_count`)
    const ulid = testUlid("ACTV");
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml([makeMonolithicTask(ulid, "unmigrated-task")]),
    );

    const result = kspec("task storage activate --force", tempDir, {
      env,
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not been migrated");
  });

  // AC: @task-storage-activation ac-4
  it("allows activation after migration is complete", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    // Create per-task directory and lean index entry (fully migrated state)
    const ulid = testUlid("ACTVM");
    await createPerTaskDir(specDir, ulid, "migrated-task");
    await addLeanIndexEntry(specDir, ulid, "migrated-task");

    const result = kspec("task storage activate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Split storage format activated");

    // Verify manifest updated
    const manifest = parseYaml(await fs.readFile(path.join(specDir, "kynetic.yaml"), "utf-8"));
    expect(manifest.task_storage.format).toBe("split");
  });

  // AC: @task-storage-activation ac-4
  it("allows activation with empty task set", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

    // Empty project.tasks.yaml — activation should succeed
    const result = kspec("task storage activate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Split storage format activated");
  });

  // AC: @task-storage-activation ac-4
  it("rejects activation with JSON output when unmigrated tasks exist", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });

    const ulid = testUlid("ACTVJ");
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml([makeMonolithicTask(ulid, "unmigrated-json-test")]),
    );

    const result = kspec("task storage activate --force --json", tempDir, {
      env,
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("not been migrated");
    expect(parsed.suggestion).toContain("kspec task migrate");
  });
});

describe("kspec task storage status", () => {
  let tempDir: string;
  let env: Record<string, string>;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-storage-status-");
  });

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @task-storage-activation ac-1
  it("reports monolithic when no format setting exists", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    const result = kspecJson<{ format: string }>("task storage status", tempDir, { env });
    expect(result.format).toBe("monolithic");
  });

  // AC: @task-storage-activation ac-2
  it("reports split when format is set to split", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      toYaml({
        kynetic: "1.0",
        project: { name: "test-project" },
        task_storage: { format: "split" },
      }),
    );

    const result = kspecJson<{ format: string }>("task storage status", tempDir, { env });
    expect(result.format).toBe("split");
  });
});
