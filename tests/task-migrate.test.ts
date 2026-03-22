import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { TaskDataManager } from "../src/parser/task-data-manager.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import type { KspecContext } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecJson,
  testUlid,
  testUlids,
} from "./helpers/cli.js";

// Register the split backend so TaskDataManager can load split-format data
ensureSplitBackendRegistered();

/**
 * Helper: set up a monolithic task environment in a temp directory.
 * Creates .kspec/ with manifest and a monolithic project.tasks.yaml.
 */
async function setupMonolithicEnv(
  tempDir: string,
): Promise<{ env: Record<string, string>; specDir: string }> {
  initGitRepo(tempDir);

  const specDir = path.join(tempDir, ".kspec");
  await fs.mkdir(specDir, { recursive: true });

  // Write minimal manifest
  await fs.writeFile(
    path.join(specDir, "kynetic.yaml"),
    toYaml({ kynetic_spec: "1.0", title: "Test Project" }),
  );

  // Start with empty tasks file
  await fs.writeFile(
    path.join(specDir, "project.tasks.yaml"),
    toYaml([]),
  );

  return { env: { KSPEC_SPEC_DIR: specDir }, specDir };
}

/**
 * Helper: write monolithic tasks to project.tasks.yaml.
 * Each entry includes the full `notes` array (monolithic format).
 */
async function writeMonolithicTasks(
  specDir: string,
  tasks: Array<Record<string, unknown>>,
): Promise<void> {
  await fs.writeFile(
    path.join(specDir, "project.tasks.yaml"),
    toYaml(tasks),
  );
}

/**
 * Helper: create a monolithic task record with notes.
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
  await fs.writeFile(
    path.join(taskDir, "notes.yaml"),
    toYaml({ notes: [] }),
  );
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

describe("kspec task migrate", () => {
  let tempDir: string;
  let env: Record<string, string>;
  let specDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-migrate-");
  });

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // ── AC: @task-storage-migration ac-1 ────────────────────────────────────
  // Given: A project has tasks in the monolithic format
  // When: The migration command is run
  // Then: Each task gets its own directory with separate core data and notes files

  // AC: @task-storage-migration ac-1
  it("creates per-task directories with task.yaml and notes.yaml", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1, id2] = testUlids("MGRN", 2);
    const notes1 = [
      { _ulid: testUlid("NTE", 10), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "Note one" },
    ];
    await writeMonolithicTasks(specDir, [
      makeMonolithicTask(id1, "task-alpha", { notes: notes1 }),
      makeMonolithicTask(id2, "task-beta"),
    ]);

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Migrated 2 task(s)");

    // Verify per-task directories
    const taskDir1 = path.join(specDir, "tasks", id1);
    const taskDir2 = path.join(specDir, "tasks", id2);

    const stat1 = await fs.stat(taskDir1);
    expect(stat1.isDirectory()).toBe(true);
    const stat2 = await fs.stat(taskDir2);
    expect(stat2.isDirectory()).toBe(true);

    // Verify task.yaml
    const taskYaml1 = parseYaml(await fs.readFile(path.join(taskDir1, "task.yaml"), "utf-8"));
    expect(taskYaml1._ulid).toBe(id1);
    expect(taskYaml1.title).toBe("Task task-alpha");
    // Notes should NOT be in task.yaml
    expect(taskYaml1.notes).toBeUndefined();

    // Verify notes.yaml
    const notesYaml1 = parseYaml(await fs.readFile(path.join(taskDir1, "notes.yaml"), "utf-8"));
    expect(notesYaml1.notes).toHaveLength(1);
    expect(notesYaml1.notes[0].content).toBe("Note one");

    // Verify empty notes
    const notesYaml2 = parseYaml(await fs.readFile(path.join(taskDir2, "notes.yaml"), "utf-8"));
    expect(notesYaml2.notes).toHaveLength(0);
  });

  // ── AC: @task-storage-migration ac-2 ────────────────────────────────────
  // Given: The migration command is run
  // When: The migration completes
  // Then: The index file is rewritten with only listing/filtering fields

  // AC: @task-storage-migration ac-2
  it("rewrites index with lean entries (notes_count instead of notes array)", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1] = testUlids("MGDX", 1);
    const notes = [
      { _ulid: testUlid("NTE", 20), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "A note" },
      { _ulid: testUlid("NTE", 21), created_at: "2026-03-20T02:00:00.000Z", author: "@test", content: "Another note" },
    ];
    await writeMonolithicTasks(specDir, [
      makeMonolithicTask(id1, "task-indexed", { notes, assignee: "@user" }),
    ]);

    kspec("task migrate --force", tempDir, { env });

    // Read index
    const indexPath = path.join(specDir, "project.tasks.yaml");
    const index = parseYaml(await fs.readFile(indexPath, "utf-8"));
    expect(Array.isArray(index)).toBe(true);
    expect(index).toHaveLength(1);

    const entry = index[0];
    // Should have notes_count, NOT notes array
    expect(entry.notes_count).toBe(2);
    expect(entry.notes).toBeUndefined();
    // Should have indexed fields
    expect(entry._ulid).toBe(id1);
    expect(entry.title).toBe("Task task-indexed");
    expect(entry.assignee).toBe("@user");
    // Should NOT have full description or non-indexed fields in the index
    expect(entry.todos).toBeUndefined();
  });

  // ── AC: @task-storage-migration ac-3 ────────────────────────────────────
  // Given: The migration command is run with dry-run mode
  // When: The preview completes
  // Then: Summary reports how many tasks would be migrated, total notes count,
  //       and any issues detected without modifying any files

  // AC: @task-storage-migration ac-3
  it("dry-run reports migration summary without modifying files", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1, id2] = testUlids("MGDR", 2);
    const notes1 = [
      { _ulid: testUlid("NTE", 30), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "Note" },
    ];
    await writeMonolithicTasks(specDir, [
      makeMonolithicTask(id1, "task-dry-a", { notes: notes1 }),
      makeMonolithicTask(id2, "task-dry-b"),
    ]);

    // Snapshot the original file content
    const indexBefore = await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8");

    const result = kspec("task migrate --dry-run", tempDir, { env });
    expect(result.exitCode).toBe(0);
    // DRY RUN goes to stderr via warn()
    expect(result.stderr).toContain("DRY RUN");
    expect(result.stdout).toContain("2");

    // Verify no files were modified
    const indexAfter = await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8");
    expect(indexAfter).toBe(indexBefore);

    // Verify no per-task directories were created
    try {
      await fs.access(path.join(specDir, "tasks"));
      // If tasks dir exists, it should be empty
      const entries = await fs.readdir(path.join(specDir, "tasks"));
      expect(entries).toHaveLength(0);
    } catch {
      // tasks dir doesn't exist — correct
    }
  });

  // AC: @task-storage-migration ac-3
  it("dry-run JSON output includes counts and dry_run flag", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1] = testUlids("MGJS", 1);
    const notes = [
      { _ulid: testUlid("NTE", 40), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "Note" },
    ];
    await writeMonolithicTasks(specDir, [
      makeMonolithicTask(id1, "task-json-dry", { notes }),
    ]);

    // AC: @trait-dry-run ac-6 — JSON includes dry_run boolean
    const json = kspecJson<{ dry_run: boolean; migrated: number; notes_total: number }>(
      "task migrate --dry-run",
      tempDir,
      { env },
    );
    expect(json.dry_run).toBe(true);
    expect(json.migrated).toBe(1);
    expect(json.notes_total).toBe(1);
  });

  // ── AC: @task-storage-migration ac-4 ────────────────────────────────────
  // Given: The migration completes
  // When: The resulting data is loaded through the task data manager
  // Then: Every task has identical field values and notes to the pre-migration state

  // AC: @task-storage-migration ac-4
  it("preserves task field values and notes through migration (loaded via TaskDataManager)", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1] = testUlids("MGFD", 1);
    const notes = [
      { _ulid: testUlid("NTE", 50), created_at: "2026-03-20T01:00:00.000Z", author: "@dev", content: "Detailed note content" },
      { _ulid: testUlid("NTE", 51), created_at: "2026-03-20T02:00:00.000Z", author: "@dev", content: "Follow-up note" },
    ];
    const task = makeMonolithicTask(id1, "task-fidelity", {
      title: "Fidelity Test Task",
      status: "in_progress",
      priority: 1,
      tags: ["important", "cli"],
      notes,
      description: "A task to test data fidelity through migration.",
      spec_ref: "@some-spec",
      automation: "eligible",
    });

    await writeMonolithicTasks(specDir, [task]);

    kspec("task migrate --force", tempDir, { env });

    // Load migrated data through TaskDataManager (the actual split-format load path)
    const ctx: KspecContext = {
      rootDir: tempDir,
      projectRoot: tempDir,
      specDir,
      sessionsDir: path.join(tempDir, ".kspec-sessions"),
      manifestPath: path.join(specDir, "kynetic.yaml"),
      manifest: { kynetic_spec: "1.0", title: "Test Project", task_storage: { format: "split" } } as any,
      shadow: null,
      config: {} as any,
    };
    const manager = new TaskDataManager("split");
    const loaded = await manager.getTask(ctx, id1);

    expect(loaded).toBeDefined();

    // Core fields preserved through TaskDataManager load
    expect(loaded!._ulid).toBe(id1);
    expect(loaded!.slugs).toEqual(["task-fidelity"]);
    expect(loaded!.title).toBe("Fidelity Test Task");
    expect(loaded!.status).toBe("in_progress");
    expect(loaded!.priority).toBe(1);
    expect(loaded!.tags).toEqual(["important", "cli"]);
    expect(loaded!.description).toBe("A task to test data fidelity through migration.");
    expect(loaded!.spec_ref).toBe("@some-spec");
    expect(loaded!.automation).toBe("eligible");

    // Notes preserved through TaskDataManager load
    expect(loaded!.notes).toHaveLength(2);
    expect(loaded!.notes[0].content).toBe("Detailed note content");
    expect(loaded!.notes[0].author).toBe("@dev");
    expect(loaded!.notes[1].content).toBe("Follow-up note");
  });

  // ── AC: @task-storage-migration ac-5 ────────────────────────────────────
  // Given: The migration encounters a task with validation errors
  // When: The migration processes that task
  // Then: The task is migrated preserving its raw data with a warning

  // AC: @task-storage-migration ac-5
  it("migrates tasks with validation errors preserving raw data with warnings", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [idValid, idInvalid] = testUlids("MGVW", 2);
    const validTask = makeMonolithicTask(idValid, "task-valid");
    // Create an invalid task (e.g., bad status value)
    const invalidTask = {
      _ulid: idInvalid,
      slugs: ["task-invalid-schema"],
      title: "Invalid Schema Task",
      type: "task",
      status: "not_a_real_status", // Invalid status
      priority: 999, // Out of range (probably)
      tags: "not-an-array", // Should be an array
      notes: [
        { _ulid: testUlid("NTE", 60), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "Bad task note" },
      ],
    };

    await writeMonolithicTasks(specDir, [validTask, invalidTask]);

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    // Should contain warning about the invalid task
    expect(result.stdout).toContain("warning");

    // Both tasks should have per-task directories
    const taskDir1 = await fs.stat(path.join(specDir, "tasks", idValid));
    expect(taskDir1.isDirectory()).toBe(true);
    const taskDir2 = await fs.stat(path.join(specDir, "tasks", idInvalid));
    expect(taskDir2.isDirectory()).toBe(true);

    // Invalid task should have its raw data preserved
    const invalidTaskYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", idInvalid, "task.yaml"), "utf-8"),
    );
    expect(invalidTaskYaml._ulid).toBe(idInvalid);
    expect(invalidTaskYaml.title).toBe("Invalid Schema Task");
    // The raw (invalid) status should be preserved
    expect(invalidTaskYaml.status).toBe("not_a_real_status");
  });

  // AC: @task-storage-migration ac-5
  it("migrates tasks with malformed or missing notes (not silently skipped)", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [idStringNotes, idNullNotes, idMissingNotes] = testUlids("MGMN", 3);

    // Task with notes as a string (malformed)
    const stringNotesTask = {
      ...makeMonolithicTask(idStringNotes, "task-string-notes"),
      notes: "bad",
    };
    // Task with notes as null
    const nullNotesTask = {
      ...makeMonolithicTask(idNullNotes, "task-null-notes"),
      notes: null,
    };
    // Task with notes missing entirely (delete notes from the spread)
    const { notes: _n, ...missingNotesBase } = makeMonolithicTask(idMissingNotes, "task-missing-notes");
    const missingNotesTask = missingNotesBase;

    await writeMonolithicTasks(specDir, [stringNotesTask, nullNotesTask, missingNotesTask]);

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);

    // All three tasks should be migrated (not skipped as "already migrated")
    expect(result.stdout).not.toContain("Already migrated");

    // All three should have per-task directories
    for (const id of [idStringNotes, idNullNotes, idMissingNotes]) {
      const stat = await fs.stat(path.join(specDir, "tasks", id));
      expect(stat.isDirectory()).toBe(true);
    }

    // String-notes task should have warning and empty notes
    const strNotesYaml = parseYaml(await fs.readFile(
      path.join(specDir, "tasks", idStringNotes, "notes.yaml"), "utf-8",
    )) as Record<string, unknown>;
    expect(Array.isArray(strNotesYaml.notes)).toBe(true);
    expect((strNotesYaml.notes as unknown[]).length).toBe(0);
  });

  // ── AC: @task-storage-migration ac-6 ────────────────────────────────────
  // Given: The migration is run on a project already in split format
  // When: The command detects existing per-task directories
  // Then: The migration reports that the project is already migrated

  // AC: @task-storage-migration ac-6
  it("reports already migrated when no monolithic entries exist", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    // Set up a split environment: lean index + per-task dirs
    const [id1] = testUlids("MGSQ", 1);
    await createPerTaskDir(specDir, id1, "task-already-split");
    await addLeanIndexEntry(specDir, id1, "task-already-split");

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Already migrated");
  });

  // AC: @task-storage-migration ac-6
  it("reports already migrated when project.tasks.yaml is empty", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    // project.tasks.yaml already empty from setupMonolithicEnv

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Already migrated");
  });

  // ── AC: @task-storage-migration ac-7 ────────────────────────────────────
  // Given: New tasks were written to the monolithic file after a previous migration
  // When: The migration command is run
  // Then: Tasks present in the monolithic file but missing from per-task dirs
  //       are backfilled without affecting existing per-task data

  // AC: @task-storage-migration ac-7
  it("backfills new monolithic tasks without affecting existing per-task dirs", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    // Simulate a previous migration: existing per-task dir + lean index entry
    const [idExisting, idNew] = testUlids("MGBF", 2);
    await createPerTaskDir(specDir, idExisting, "task-existing", {
      title: "Existing Split Task",
      description: "This should not be touched",
    });
    await addLeanIndexEntry(specDir, idExisting, "task-existing", {
      title: "Existing Split Task",
    });

    // Add a new monolithic task (simulating older tooling writing to the file)
    const indexPath = path.join(specDir, "project.tasks.yaml");
    const existingIndex = parseYaml(await fs.readFile(indexPath, "utf-8"));
    existingIndex.push(
      makeMonolithicTask(idNew, "task-new-backfill", {
        title: "New Backfill Task",
        notes: [
          { _ulid: testUlid("NTE", 70), created_at: "2026-03-20T03:00:00.000Z", author: "@test", content: "Backfill note" },
        ],
      }),
    );
    await fs.writeFile(indexPath, toYaml(existingIndex));

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Backfilled 1 task(s)");

    // New task should have a per-task directory
    const newTaskDir = path.join(specDir, "tasks", idNew);
    const newTaskYaml = parseYaml(
      await fs.readFile(path.join(newTaskDir, "task.yaml"), "utf-8"),
    );
    expect(newTaskYaml.title).toBe("New Backfill Task");

    const newNotesYaml = parseYaml(
      await fs.readFile(path.join(newTaskDir, "notes.yaml"), "utf-8"),
    );
    expect(newNotesYaml.notes).toHaveLength(1);
    expect(newNotesYaml.notes[0].content).toBe("Backfill note");

    // Existing task should be untouched
    const existingTaskYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", idExisting, "task.yaml"), "utf-8"),
    );
    expect(existingTaskYaml.title).toBe("Existing Split Task");
    expect(existingTaskYaml.description).toBe("This should not be touched");
  });

  // AC: @task-storage-migration ac-7
  it("index entries for already-migrated tasks use canonical split data, not stale monolithic data", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    const [idExisting, idNew] = testUlids("MGCI", 2);

    // Create per-task dir with canonical title
    await createPerTaskDir(specDir, idExisting, "task-canonical", {
      title: "Canonical Split Title",
      status: "in_progress",
    });

    // Write index with stale monolithic entry (different title) + a new monolithic entry
    // The existing task has a stale monolithic row with a different title
    const staleMonolithic = makeMonolithicTask(idExisting, "task-canonical", {
      title: "Stale Monolithic Title",
      status: "pending",
    });
    const newMonolithic = makeMonolithicTask(idNew, "task-new-for-index", {
      title: "New Task For Index",
    });
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml([staleMonolithic, newMonolithic]),
    );

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);

    // Read the resulting index
    const index = parseYaml(
      await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8"),
    ) as Array<Record<string, unknown>>;

    // Find the existing task's index entry
    const existingEntry = index.find((e) => e._ulid === idExisting);
    expect(existingEntry).toBeDefined();
    // Index should use the canonical split title, NOT the stale monolithic title
    expect(existingEntry!.title).toBe("Canonical Split Title");
    expect(existingEntry!.status).toBe("in_progress");

    // The new task should also be in the index
    const newEntry = index.find((e) => e._ulid === idNew);
    expect(newEntry).toBeDefined();
    expect(newEntry!.title).toBe("New Task For Index");
  });

  // ── AC: @task-storage-migration ac-8 ────────────────────────────────────
  // Given: The migration or backfill completes
  // When: The shadow branch state is examined
  // Then: All file changes are committed as a single atomic shadow branch commit

  // AC: @task-storage-migration ac-8
  it("commits all migration files in a single atomic shadow branch commit", async () => {
    // Set up a real shadow branch (not KSPEC_SPEC_DIR) so commitIfShadow actually commits
    initGitRepo(tempDir);
    execSync('git add . && git commit --allow-empty -m "initial"', {
      cwd: tempDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    kspec("init --no-prompt", tempDir);

    const shadowDir = path.join(tempDir, ".kspec");

    // Write monolithic tasks directly into the shadow worktree's project.tasks.yaml
    const [id1, id2, id3] = testUlids("MGAT", 3);
    const monolithicTasks = [
      makeMonolithicTask(id1, "task-atomic-a"),
      makeMonolithicTask(id2, "task-atomic-b", {
        notes: [
          { _ulid: testUlid("NTE", 95), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "A note" },
        ],
      }),
      makeMonolithicTask(id3, "task-atomic-c"),
    ];
    await fs.writeFile(
      path.join(shadowDir, "project.tasks.yaml"),
      toYaml(monolithicTasks),
    );
    // Stage and commit the monolithic data so migrate sees it
    // KSPEC_SHADOW_COMMIT=1 authorizes the commit past the pre-commit hook
    execSync("git add -A && git commit -m 'add monolithic tasks'", {
      cwd: shadowDir,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
    });

    // Count shadow commits before migration
    const commitsBefore = Number.parseInt(
      execSync("git rev-list --count HEAD", { cwd: shadowDir, encoding: "utf-8" }).trim(),
      10,
    );

    const result = kspec("task migrate --force", tempDir);
    expect(result.exitCode).toBe(0);

    // Count shadow commits after migration — must be exactly 1 new commit
    const commitsAfter = Number.parseInt(
      execSync("git rev-list --count HEAD", { cwd: shadowDir, encoding: "utf-8" }).trim(),
      10,
    );
    expect(commitsAfter).toBe(commitsBefore + 1);

    // Verify all three per-task directories were created in that single commit
    for (const id of [id1, id2, id3]) {
      const taskYaml = await fs.readFile(
        path.join(shadowDir, "tasks", id, "task.yaml"),
        "utf-8",
      );
      expect(taskYaml).toContain(id);
    }

    // Verify shadow branch is clean (no uncommitted changes)
    const status = execSync("git status --porcelain", {
      cwd: shadowDir,
      encoding: "utf-8",
    }).trim();
    expect(status).toBe("");
  });

  // ── Trait: @trait-dry-run ────────────────────────────────────────────────

  // AC: @trait-dry-run ac-1
  // Given: command supports dry run
  // When: --dry-run flag is provided
  // Then: show what would be changed without applying
  // (covered by ac-3 test above)

  // AC: @trait-dry-run ac-2
  // Given: dry run mode is active
  // When: command completes
  // Then: no files are modified
  // (covered by ac-3 test above — verifies file content unchanged)

  // AC: @trait-dry-run ac-3
  // Given: dry run mode is active
  // When: output is shown
  // Then: clear indication that this is a preview

  // AC: @trait-dry-run ac-3
  it("dry-run output clearly indicates preview", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1] = testUlids("MGDP", 1);
    await writeMonolithicTasks(specDir, [makeMonolithicTask(id1, "task-preview")]);

    const result = kspec("task migrate --dry-run", tempDir, { env });
    // DRY RUN goes to stderr via warn()
    expect(result.stderr).toContain("DRY RUN");
  });

  // AC: @trait-dry-run ac-4
  it("dry-run shows error but does not change state when command would error", async () => {
    // Set up a real shadow branch project so initContext uses shadow detection
    initGitRepo(tempDir);
    execSync('git add . && git commit --allow-empty -m "initial"', {
      cwd: tempDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    kspec("init --no-prompt", tempDir);

    const shadowDir = path.join(tempDir, ".kspec");

    // Write some monolithic tasks that would normally be migrated
    const [id1] = testUlids("MGDE", 1);
    await fs.writeFile(
      path.join(shadowDir, "project.tasks.yaml"),
      toYaml([makeMonolithicTask(id1, "task-dry-error")]),
    );
    execSync('git add -A && git commit -m "add monolithic tasks"', {
      cwd: shadowDir,
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, KSPEC_SHADOW_COMMIT: "1" },
    });

    // Snapshot state before dry-run
    const tasksBefore = await fs.readFile(path.join(shadowDir, "project.tasks.yaml"), "utf-8");
    const commitsBefore = Number.parseInt(
      execSync("git rev-list --count HEAD", { cwd: shadowDir, encoding: "utf-8" }).trim(),
      10,
    );

    // Break the shadow worktree so initContext throws
    await fs.writeFile(path.join(shadowDir, ".git"), "broken");

    const result = kspec("task migrate --dry-run", tempDir, { expectFail: true });
    // Command should fail
    expect(result.exitCode).not.toBe(0);
    // Error output should describe the problem
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    expect(combinedOutput.toLowerCase()).toMatch(/fail|error|disconnect/i);

    // Restore .git so we can verify state
    // The worktree gitdir path is under .git/worktrees/
    const worktreeGitdir = path.join(tempDir, ".git", "worktrees");
    const worktreeEntries = await fs.readdir(worktreeGitdir);
    const worktreeLink = path.join(worktreeGitdir, worktreeEntries[0]);
    await fs.writeFile(path.join(shadowDir, ".git"), `gitdir: ${worktreeLink}`);

    // Verify no state was changed
    const tasksAfter = await fs.readFile(path.join(shadowDir, "project.tasks.yaml"), "utf-8");
    expect(tasksAfter).toBe(tasksBefore);
    const commitsAfter = Number.parseInt(
      execSync("git rev-list --count HEAD", { cwd: shadowDir, encoding: "utf-8" }).trim(),
      10,
    );
    expect(commitsAfter).toBe(commitsBefore);
  });

  // AC: @trait-dry-run ac-5
  it("dry-run takes precedence over --force", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1] = testUlids("MGDF", 1);
    await writeMonolithicTasks(specDir, [makeMonolithicTask(id1, "task-dryforce")]);

    const indexBefore = await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8");

    const result = kspec("task migrate --dry-run --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    // DRY RUN goes to stderr via warn()
    expect(result.stderr).toContain("DRY RUN");

    const indexAfter = await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8");
    expect(indexAfter).toBe(indexBefore);
  });

  // AC: @trait-dry-run ac-6 — covered by JSON dry-run test above

  // ── Trait: @trait-error-guidance ──────────────────────────────────────────

  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  it("error output includes description and suggested action", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    // Write monolithic tasks and make the tasks directory read-only
    // so the write buffer flush fails with a permission error
    const [id1] = testUlids("MGEG", 1);
    await writeMonolithicTasks(specDir, [makeMonolithicTask(id1, "task-err-guidance")]);
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });
    await fs.chmod(path.join(specDir, "tasks"), 0o444);

    try {
      const result = kspec("task migrate --force", tempDir, { env, expectFail: true });
      expect(result.exitCode).not.toBe(0);

      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      // AC: @trait-error-guidance ac-1 — description of what went wrong
      expect(combinedOutput).toMatch(/Failed to migrate|EACCES|permission denied/i);
      // AC: @trait-error-guidance ac-2 — suggested action to resolve
      expect(combinedOutput).toMatch(/kspec shadow status|Check that/i);
    } finally {
      await fs.chmod(path.join(specDir, "tasks"), 0o755);
    }
  });

  // AC: @trait-error-guidance ac-6
  it("JSON error output includes structured guidance", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    // Write monolithic tasks and make the tasks directory read-only
    const [id1] = testUlids("MGEJ", 1);
    await writeMonolithicTasks(specDir, [makeMonolithicTask(id1, "task-err-json")]);
    await fs.mkdir(path.join(specDir, "tasks"), { recursive: true });
    await fs.chmod(path.join(specDir, "tasks"), 0o444);

    try {
      const result = kspec("task migrate --force --json", tempDir, { env, expectFail: true });
      expect(result.exitCode).not.toBe(0);

      // Parse the JSON error output
      const jsonOutput = JSON.parse(result.stdout || result.stderr);
      // AC: @trait-error-guidance ac-6 — guidance in structured error object
      expect(jsonOutput.success).toBe(false);
      expect(typeof jsonOutput.error).toBe("string");
      expect(jsonOutput.error.length).toBeGreaterThan(0);
      expect(typeof jsonOutput.suggestion).toBe("string");
      expect(jsonOutput.suggestion.length).toBeGreaterThan(0);
    } finally {
      await fs.chmod(path.join(specDir, "tasks"), 0o755);
    }
  });

  // AC: @trait-error-guidance ac-3 — N/A: migrate doesn't use references that could be "not found"
  // AC: @trait-error-guidance ac-4 — N/A: migrate doesn't perform state transitions
  // AC: @trait-error-guidance ac-5 — N/A: migrate doesn't validate individual fields with user-provided values

  // ── Additional edge cases ────────────────────────────────────────────────

  it("handles tasks wrapper format ({tasks: [...]})", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1] = testUlids("MGWP", 1);
    const task = makeMonolithicTask(id1, "task-wrapper");

    // Write in wrapper format
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml({ tasks: [task] }),
    );

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Migrated 1 task(s)");

    // Per-task dir should exist
    const taskDir = await fs.stat(path.join(specDir, "tasks", id1));
    expect(taskDir.isDirectory()).toBe(true);
  });

  it("handles mixed monolithic and lean entries during backfill", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [idLean, idMono] = testUlids("MGMX", 2);

    // Create per-task dir for the lean entry
    await createPerTaskDir(specDir, idLean, "task-lean-existing");

    // Write index with both lean entry and a monolithic entry
    const leanEntry = {
      _ulid: idLean,
      slugs: ["task-lean-existing"],
      title: "Task task-lean-existing",
      type: "task",
      status: "pending",
      priority: 3,
      tags: ["test"],
      depends_on: [],
      blocked_by: [],
      created_at: "2026-03-20T00:00:00.000Z",
      notes_count: 0,
      todos_count: 0,
    };
    const monoEntry = makeMonolithicTask(idMono, "task-mono-new", {
      notes: [
        { _ulid: testUlid("NTE", 80), created_at: "2026-03-20T04:00:00.000Z", author: "@test", content: "Mixed note" },
      ],
    });
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml([leanEntry, monoEntry]),
    );

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);

    // New task should have per-task dir
    const newTaskYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", idMono, "task.yaml"), "utf-8"),
    );
    expect(newTaskYaml._ulid).toBe(idMono);

    // Index should be all lean
    const index = parseYaml(
      await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8"),
    );
    expect(index).toHaveLength(2);
    for (const entry of index) {
      expect(entry.notes).toBeUndefined();
      expect(typeof entry.notes_count).toBe("number");
    }
  });

  it("tasks with no notes get empty notes.yaml", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1] = testUlids("MGEN", 1);
    await writeMonolithicTasks(specDir, [
      makeMonolithicTask(id1, "task-no-notes"),
    ]);

    kspec("task migrate --force", tempDir, { env });

    const notesYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", id1, "notes.yaml"), "utf-8"),
    );
    expect(notesYaml.notes).toEqual([]);
  });

  // ── Regression: blocker — missing _ulid tasks must be migrated with warning ──

  // AC: @task-storage-migration ac-5
  it("migrates tasks with missing _ulid by generating one and emitting a warning", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [idValid] = testUlids("MGNU", 1);

    // Task with a valid _ulid
    const validTask = makeMonolithicTask(idValid, "task-has-ulid");

    // Task missing _ulid entirely — should NOT be silently skipped
    const missingUlidTask = {
      slugs: ["task-no-ulid"],
      title: "No ULID Task",
      type: "task",
      status: "pending",
      priority: 3,
      tags: [],
      depends_on: [],
      blocked_by: [],
      created_at: "2026-03-20T00:00:00.000Z",
      notes: [
        { _ulid: testUlid("NTE", 90), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "Note on missing-ulid task" },
      ],
      todos: [],
    };

    await writeMonolithicTasks(specDir, [validTask, missingUlidTask]);

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    // Should report both tasks migrated (not just the valid one)
    expect(result.stdout).toContain("Migrated 2 task(s)");
    // Should warn about the missing _ulid (warn() goes to stderr, individual warnings to stdout)
    expect(result.stderr).toContain("warning");
    expect(result.stdout).toContain("missing or invalid _ulid");

    // Both tasks should have per-task directories
    const taskDirValid = await fs.stat(path.join(specDir, "tasks", idValid));
    expect(taskDirValid.isDirectory()).toBe(true);

    // Find the generated ULID directory (not idValid)
    const taskDirs = await fs.readdir(path.join(specDir, "tasks"));
    expect(taskDirs).toHaveLength(2);
    const generatedDir = taskDirs.find((d) => d !== idValid);
    expect(generatedDir).toBeDefined();

    // Verify the task data was preserved
    const noUlidTaskYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", generatedDir!, "task.yaml"), "utf-8"),
    );
    expect(noUlidTaskYaml.title).toBe("No ULID Task");

    // Verify notes were preserved
    const noUlidNotesYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", generatedDir!, "notes.yaml"), "utf-8"),
    );
    expect(noUlidNotesYaml.notes).toHaveLength(1);
    expect(noUlidNotesYaml.notes[0].content).toBe("Note on missing-ulid task");

    // Verify the index has both entries
    const index = parseYaml(
      await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8"),
    ) as Array<Record<string, unknown>>;
    expect(index).toHaveLength(2);
  });

  // ── Regression: blocker — malformed non-empty _ulid must be regenerated, not used verbatim ──

  // AC: @task-storage-migration ac-5
  it("migrates tasks with malformed non-empty _ulid by regenerating and emitting a warning", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [idValid] = testUlids("MGMF", 1);

    // Task with a valid _ulid
    const validTask = makeMonolithicTask(idValid, "task-valid-ulid");

    // Task with a malformed _ulid (non-empty string but not a valid ULID)
    const malformedUlidTask = {
      _ulid: "not-a-valid-ulid",
      slugs: ["task-bad-ulid"],
      title: "Malformed ULID Task",
      type: "task",
      status: "pending",
      priority: 3,
      tags: [],
      depends_on: [],
      blocked_by: [],
      created_at: "2026-03-20T00:00:00.000Z",
      notes: [
        { _ulid: testUlid("NTE", 91), created_at: "2026-03-20T01:00:00.000Z", author: "@test", content: "Note on malformed-ulid task" },
      ],
      todos: [],
    };

    await writeMonolithicTasks(specDir, [validTask, malformedUlidTask]);

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);
    // Should report both tasks migrated
    expect(result.stdout).toContain("Migrated 2 task(s)");
    // Should warn about the malformed _ulid
    expect(result.stderr).toContain("warning");
    expect(result.stdout).toContain("missing or invalid _ulid");

    // Both tasks should have per-task directories
    const taskDirs = await fs.readdir(path.join(specDir, "tasks"));
    expect(taskDirs).toHaveLength(2);

    // The malformed "not-a-valid-ulid" should NOT be used as a directory name
    expect(taskDirs).not.toContain("not-a-valid-ulid");

    // The valid task dir should exist
    expect(taskDirs).toContain(idValid);

    // The other dir is the generated ULID
    const generatedDir = taskDirs.find((d) => d !== idValid);
    expect(generatedDir).toBeDefined();
    // Generated dir name should be a valid 26-char ULID
    expect(generatedDir).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);

    // Verify task data was preserved
    const taskYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", generatedDir!, "task.yaml"), "utf-8"),
    );
    expect(taskYaml.title).toBe("Malformed ULID Task");

    // Verify notes were preserved
    const notesYaml = parseYaml(
      await fs.readFile(path.join(specDir, "tasks", generatedDir!, "notes.yaml"), "utf-8"),
    );
    expect(notesYaml.notes).toHaveLength(1);
    expect(notesYaml.notes[0].content).toBe("Note on malformed-ulid task");

    // Verify the index has both entries with valid ULIDs
    const index = parseYaml(
      await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8"),
    ) as Array<Record<string, unknown>>;
    expect(index).toHaveLength(2);
    // No entry should have the malformed ULID
    const ulids = index.map((e) => e._ulid);
    expect(ulids).not.toContain("not-a-valid-ulid");
  });

  // ── Regression: blocker — canonical index for already-migrated tasks with notes ──

  // AC: @task-storage-migration ac-7
  it("index entries for already-migrated tasks with notes use canonical split data", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));

    const [idExisting, idNew] = testUlids("MGCN", 2);

    // Create per-task dir with canonical title and notes
    await createPerTaskDir(specDir, idExisting, "task-with-notes", {
      title: "Canonical Title With Notes",
      status: "in_progress",
    });
    // Write notes to the per-task dir
    await fs.writeFile(
      path.join(specDir, "tasks", idExisting, "notes.yaml"),
      toYaml({
        notes: [
          { _ulid: testUlid("NTE", 91), created_at: "2026-03-20T01:00:00.000Z", author: "@dev", content: "A canonical note" },
          { _ulid: testUlid("NTE", 92), created_at: "2026-03-20T02:00:00.000Z", author: "@dev", content: "Another canonical note" },
        ],
      }),
    );

    // Write stale monolithic entry with different title + a new task
    const staleMonolithic = makeMonolithicTask(idExisting, "task-with-notes", {
      title: "Stale Monolithic Title",
      status: "pending",
    });
    const newMonolithic = makeMonolithicTask(idNew, "task-new-trigger", {
      title: "New Trigger Task",
    });
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      toYaml([staleMonolithic, newMonolithic]),
    );

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);

    // Read the resulting index
    const index = parseYaml(
      await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8"),
    ) as Array<Record<string, unknown>>;

    // Find the existing task's index entry
    const existingEntry = index.find((e) => e._ulid === idExisting);
    expect(existingEntry).toBeDefined();
    // MUST use canonical split title, NOT stale monolithic title
    expect(existingEntry!.title).toBe("Canonical Title With Notes");
    expect(existingEntry!.status).toBe("in_progress");
    // Notes count should reflect canonical notes (2), not stale monolithic (0)
    expect(existingEntry!.notes_count).toBe(2);
  });
});
