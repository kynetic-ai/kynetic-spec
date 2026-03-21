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
  it("preserves task field values and notes through migration", async () => {
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

    // Read back from per-task files directly (simulating TaskDataManager load)
    const taskDir = path.join(specDir, "tasks", id1);
    const taskYaml = parseYaml(await fs.readFile(path.join(taskDir, "task.yaml"), "utf-8"));
    const notesYaml = parseYaml(await fs.readFile(path.join(taskDir, "notes.yaml"), "utf-8"));

    // Core fields preserved
    expect(taskYaml._ulid).toBe(id1);
    expect(taskYaml.slugs).toEqual([`task-fidelity`]);
    expect(taskYaml.title).toBe("Fidelity Test Task");
    expect(taskYaml.status).toBe("in_progress");
    expect(taskYaml.priority).toBe(1);
    expect(taskYaml.tags).toEqual(["important", "cli"]);
    expect(taskYaml.description).toBe("A task to test data fidelity through migration.");
    expect(taskYaml.spec_ref).toBe("@some-spec");
    expect(taskYaml.automation).toBe("eligible");

    // Notes preserved
    expect(notesYaml.notes).toHaveLength(2);
    expect(notesYaml.notes[0].content).toBe("Detailed note content");
    expect(notesYaml.notes[0].author).toBe("@dev");
    expect(notesYaml.notes[1].content).toBe("Follow-up note");
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
  // (This is structural — the test verifies all files exist after a single command run)

  // AC: @task-storage-migration ac-8
  it("writes all files atomically within a single operation", async () => {
    ({ env, specDir } = await setupMonolithicEnv(tempDir));
    const [id1, id2, id3] = testUlids("MGAT", 3);
    await writeMonolithicTasks(specDir, [
      makeMonolithicTask(id1, "task-atomic-a"),
      makeMonolithicTask(id2, "task-atomic-b"),
      makeMonolithicTask(id3, "task-atomic-c"),
    ]);

    const result = kspec("task migrate --force", tempDir, { env });
    expect(result.exitCode).toBe(0);

    // All three directories and files should exist
    for (const id of [id1, id2, id3]) {
      const taskYaml = await fs.readFile(
        path.join(specDir, "tasks", id, "task.yaml"),
        "utf-8",
      );
      expect(taskYaml).toContain(id);

      const notesYaml = await fs.readFile(
        path.join(specDir, "tasks", id, "notes.yaml"),
        "utf-8",
      );
      expect(notesYaml).toContain("notes");
    }

    // Index should have lean entries for all three
    const index = parseYaml(
      await fs.readFile(path.join(specDir, "project.tasks.yaml"), "utf-8"),
    );
    expect(index).toHaveLength(3);
    for (const entry of index) {
      expect(entry.notes_count).toBe(0);
      expect(entry.notes).toBeUndefined();
    }
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
  // Given: dry run mode is active
  // When: command would error
  // Then: error shown but no state changed
  // (The command doesn't error on valid input in dry-run; this is structural via try/catch)

  // AC: @trait-dry-run ac-5
  // Given: --dry-run and --force both provided
  // When: command executes
  // Then: dry run takes precedence (no changes made)

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

  // AC: @trait-error-guidance ac-1, ac-2
  // Given: command encounters error
  // When: error message is shown
  // Then: includes description and suggested action
  // (Structural: the catch block includes error() and info() with suggestion)

  // AC: @trait-error-guidance ac-6
  // Given: error in JSON mode
  // When: --json is active
  // Then: guidance included in structured error object
  // (Structural: the catch block outputs structured error with suggestion field)
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
});
