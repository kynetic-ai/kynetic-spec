/**
 * Tests for validation using the canonical task data source.
 *
 * Verifies that validation uses TaskDataManager to load tasks from split
 * storage rather than the legacy findTaskFiles() path, ensuring validation
 * sees the same tasks that all other kspec consumers see.
 *
 * AC: @validation-task-data-source
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecWithStatus,
  seedSplitTask,
  testUlid,
  testUlids,
} from "./helpers/cli";

describe("validation task data source", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("kspec-validate-tds-");
    initGitRepo(tmpDir);
  });

  afterEach(async () => {
    if (tmpDir) {
      await cleanupTempDir(tmpDir);
    }
  });

  /**
   * Set up a minimal project with split task storage containing the given tasks.
   * Manifest at rootDir, spec module in spec/, tasks in tasks/<ULID>/.
   */
  async function setupProject(options?: {
    specs?: Array<{ ulid: string; slug: string; title: string }>;
    tasks?: Array<Record<string, unknown> & { _ulid: string; notes?: unknown[] }>;
    /** If true, also write a malformed task.yaml for a ULID directory */
    malformedTask?: { ulid: string; content: string };
  }): Promise<void> {
    const specDir = path.join(tmpDir, "spec");
    await fs.mkdir(specDir, { recursive: true });

    const specs = options?.specs ?? [];
    const tasks = options?.tasks ?? [];

    // Write manifest
    const includesLine = specs.length > 0 ? 'includes:\n  - "spec/module.yaml"' : "";
    await fs.writeFile(
      path.join(tmpDir, "kynetic.yaml"),
      `kynetic: "1.1"
task_storage:
  format: split
project:
  name: validate-tds-test
  version: 0.1.0
${includesLine}
`,
    );

    // Write spec module if specs provided
    if (specs.length > 0) {
      const specYaml = specs
        .map(
          (s) => `- _ulid: ${s.ulid}
  slugs:
    - ${s.slug}
  title: "${s.title}"
  type: feature
  description: "Test spec for validation task data source"`,
        )
        .join("\n");
      await fs.writeFile(path.join(specDir, "module.yaml"), specYaml);
    }

    // Seed split tasks
    for (const task of tasks) {
      seedSplitTask(tmpDir, task);
    }

    // Write malformed task if requested
    if (options?.malformedTask) {
      const taskDir = path.join(tmpDir, "tasks", options.malformedTask.ulid);
      await fs.mkdir(taskDir, { recursive: true });
      await fs.writeFile(
        path.join(taskDir, "task.yaml"),
        options.malformedTask.content,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // AC: @validation-task-data-source ac-all-persisted-tasks-included
  //
  // Given: A project contains persisted task records in the supported task
  //        storage layout
  // When:  validation runs task-aware checks
  // Then:  Every persisted task record is included in the validation task set
  // ────────────────────────────────────────────────────────────────────────────

  describe("ac-all-persisted-tasks-included", () => {
    // AC: @validation-task-data-source ac-all-persisted-tasks-included
    it("includes split-storage tasks in validation task count", async () => {
      const [taskUlid1, taskUlid2, taskUlid3] = testUlids("TSK", 3);
      const specUlid = testUlid("SPC01");

      await setupProject({
        specs: [{ ulid: specUlid, slug: "tds-spec", title: "TDS Spec" }],
        tasks: [
          {
            _ulid: taskUlid1,
            slugs: ["task-one"],
            title: "Task One",
            status: "pending",
            priority: 3,
            depends_on: [],
            spec_ref: "@tds-spec",
            notes: [],
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            _ulid: taskUlid2,
            slugs: ["task-two"],
            title: "Task Two",
            status: "in_progress",
            priority: 2,
            depends_on: [],
            notes: [{ _ulid: testUlid("NOTE1"), content: "working on it", author: "test", created_at: "2026-01-02T00:00:00Z" }],
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            _ulid: taskUlid3,
            slugs: ["task-three"],
            title: "Task Three",
            status: "completed",
            priority: 1,
            depends_on: [],
            notes: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });

      const result = kspec("validate --schema --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      expect(parsed.stats.tasksChecked).toBe(3);
    });

    // AC: @validation-task-data-source ac-all-persisted-tasks-included
    it("reports tasks checked in human-readable output", async () => {
      const taskUlid = testUlid("TSK01");

      await setupProject({
        tasks: [
          {
            _ulid: taskUlid,
            slugs: ["task-solo"],
            title: "Solo Task",
            status: "pending",
            priority: 3,
            depends_on: [],
            notes: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });

      const result = kspecWithStatus("validate --schema -v", tmpDir);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(output).toContain("Tasks checked: 1");
    });

    // AC: @validation-task-data-source ac-all-persisted-tasks-included
    it("reports zero tasks when no task directories exist", async () => {
      await setupProject({ specs: [] });

      const result = kspec("validate --schema --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      expect(parsed.stats.tasksChecked).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC: @validation-task-data-source ac-task-references-checked
  //
  // Given: A persisted task contains a field that validation treats as a
  //        reference
  // When:  reference validation runs
  // Then:  The reference contributes to validation findings with the task as
  //        the source
  // ────────────────────────────────────────────────────────────────────────────

  describe("ac-task-references-checked", () => {
    // AC: @validation-task-data-source ac-task-references-checked
    it("detects dangling spec_ref from a split-storage task", async () => {
      const taskUlid = testUlid("TSK01");

      await setupProject({
        tasks: [
          {
            _ulid: taskUlid,
            slugs: ["task-dangling-ref"],
            title: "Task With Dangling Ref",
            status: "pending",
            priority: 3,
            depends_on: [],
            spec_ref: "@nonexistent-spec",
            notes: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });

      const result = kspec("validate --refs --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      // Should have a ref error for the dangling spec_ref
      const refErrors = parsed.refErrors ?? [];
      const danglingRef = refErrors.find(
        (e: { ref: string }) => e.ref === "@nonexistent-spec",
      );
      expect(danglingRef).toBeDefined();
      expect(danglingRef.sourceUlid).toBe(taskUlid);
    });

    // AC: @validation-task-data-source ac-task-references-checked
    it("detects dangling depends_on from a split-storage task", async () => {
      const taskUlid = testUlid("TSK01");
      const phantomUlid = testUlid("GONE1");

      await setupProject({
        tasks: [
          {
            _ulid: taskUlid,
            slugs: ["task-dangling-dep"],
            title: "Task With Dangling Dependency",
            status: "pending",
            priority: 3,
            depends_on: [`@${phantomUlid}`],
            notes: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });

      const result = kspec("validate --refs --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      const refErrors = parsed.refErrors ?? [];
      const danglingDep = refErrors.find(
        (e: { ref: string }) => e.ref === `@${phantomUlid}`,
      );
      expect(danglingDep).toBeDefined();
      expect(danglingDep.sourceUlid).toBe(taskUlid);
    });

    // AC: @validation-task-data-source ac-task-references-checked
    it("resolves valid spec_ref without errors", async () => {
      const taskUlid = testUlid("TSK01");
      const specUlid = testUlid("SPC01");

      await setupProject({
        specs: [{ ulid: specUlid, slug: "valid-spec", title: "Valid Spec" }],
        tasks: [
          {
            _ulid: taskUlid,
            slugs: ["task-valid-ref"],
            title: "Task With Valid Ref",
            status: "pending",
            priority: 3,
            depends_on: [],
            spec_ref: "@valid-spec",
            notes: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });

      const result = kspec("validate --refs --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      expect(parsed.refErrors).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // AC: @validation-task-data-source ac-task-load-errors-reported
  //
  // Given: A persisted task record cannot be parsed as a valid task
  // When:  validation runs
  // Then:  A validation finding identifies the affected task record instead
  //        of silently omitting it
  // ────────────────────────────────────────────────────────────────────────────

  describe("ac-task-load-errors-reported", () => {
    // AC: @validation-task-data-source ac-task-load-errors-reported
    it("reports schema errors for malformed task records", async () => {
      const malformedUlid = testUlid("BAD01");

      await setupProject({
        malformedTask: {
          ulid: malformedUlid,
          // Missing required fields: title, status, priority, slugs
          content: `_ulid: ${malformedUlid}\ndescription: "incomplete task"\n`,
        },
      });

      const result = kspec("validate --schema --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      // Should report at least one schema error for the malformed task
      const taskErrors = (parsed.schemaErrors ?? []).filter(
        (e: { file: string }) => e.file.includes(malformedUlid),
      );
      expect(taskErrors.length).toBeGreaterThan(0);
    });

    // AC: @validation-task-data-source ac-task-load-errors-reported
    it("reports errors for task with invalid YAML content", async () => {
      const badYamlUlid = testUlid("BAD02");

      await setupProject({
        malformedTask: {
          ulid: badYamlUlid,
          content: "this: is: not: valid: yaml: [unclosed",
        },
      });

      const result = kspec("validate --schema --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      const taskErrors = (parsed.schemaErrors ?? []).filter(
        (e: { file: string }) => e.file.includes(badYamlUlid),
      );
      expect(taskErrors.length).toBeGreaterThan(0);
    });

    // AC: @validation-task-data-source ac-task-load-errors-reported
    it("reports error for split project with unmigrated tasks instead of falling back to legacy path", async () => {
      const unmigratedUlid = testUlid("UNM01");

      // Set up split-format project with a full (unmigrated) task record
      // in project.tasks.yaml but NO per-task directory.
      // The canonical TaskDataManager should reject this, and validation
      // should surface the error — NOT silently fall back to legacy findTaskFiles.
      const specDir = path.join(tmpDir, "spec");
      await fs.mkdir(specDir, { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "kynetic.yaml"),
        `kynetic: "1.1"\ntask_storage:\n  format: split\nproject:\n  name: unmigrated-test\n  version: 0.1.0\n`,
      );
      // Write an unmigrated task record (has notes array, not notes_count scalar)
      await fs.writeFile(
        path.join(tmpDir, "project.tasks.yaml"),
        `- _ulid: ${unmigratedUlid}\n  slugs:\n    - task-unmigrated\n  title: "Unmigrated Task"\n  status: pending\n  priority: 3\n  depends_on: []\n  notes: []\n  created_at: "2026-01-01T00:00:00Z"\n`,
      );

      const result = kspec("validate --schema --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      // Should produce a schema error about unmigrated tasks
      const migrationErrors = (parsed.schemaErrors ?? []).filter(
        (e: { message: string }) => e.message.includes("migrated"),
      );
      expect(migrationErrors.length).toBeGreaterThan(0);

      // Should NOT have silently loaded the task via the legacy path
      expect(parsed.stats.tasksChecked).toBe(0);
    });

    // AC: @validation-task-data-source ac-task-load-errors-reported
    // Regression: resolveTaskDataManager() errors must not silently fall back
    // to legacy findTaskFiles(). A split-format project where the resolver
    // succeeds but loadAllTasks() fails due to unmigrated data should surface
    // validation errors, not silently report tasksChecked: 0 while the legacy
    // path finds no tasks. This was the exact scenario reproduced in review
    // cycle 2 — `task list --json` threw TaskDataManagerError but `validate
    // --refs --json` exited successfully with 0 tasks and no ref errors.
    it("does not silently fall back to legacy path when canonical task loading fails for split-format project", async () => {
      const unmigratedUlid = testUlid("UNM02");

      // Create a split-format project where the canonical TDM will fail:
      // project.tasks.yaml has full records (unmigrated) but no per-task dirs.
      const specDir = path.join(tmpDir, "spec");
      await fs.mkdir(specDir, { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "kynetic.yaml"),
        `kynetic: "1.1"\ntask_storage:\n  format: split\nproject:\n  name: resolver-fallback-test\n  version: 0.1.0\n`,
      );
      await fs.writeFile(
        path.join(tmpDir, "project.tasks.yaml"),
        `- _ulid: ${unmigratedUlid}\n  slugs:\n    - task-should-not-silently-vanish\n  title: "Task That Must Not Vanish"\n  status: pending\n  priority: 3\n  depends_on: []\n  spec_ref: "@nonexistent-spec"\n  notes: []\n  created_at: "2026-01-01T00:00:00Z"\n`,
      );

      // Run ref validation (the mode that triggered the original bug)
      const result = kspec("validate --refs --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      // The old code would silently fall back to findTaskFiles(), which
      // finds project.tasks.yaml, parses it as legacy, and reports 0 tasks
      // because the legacy path expects a different format. The fix ensures
      // the canonical path error is surfaced instead.
      const hasSchemaError = (parsed.schemaErrors ?? []).length > 0;
      const hasTaskLoadError = (parsed.schemaErrors ?? []).some(
        (e: { message: string }) =>
          e.message.includes("migrated") || e.message.includes("Task data manager"),
      );

      // Must have surfaced an error — not silently succeeded with 0 tasks
      expect(hasSchemaError).toBe(true);
      expect(hasTaskLoadError).toBe(true);
    });

    // AC: @validation-task-data-source ac-task-load-errors-reported
    it("still loads valid tasks alongside malformed ones", async () => {
      const goodUlid = testUlid("GOOD1");
      const badUlid = testUlid("BAD01");

      await setupProject({
        tasks: [
          {
            _ulid: goodUlid,
            slugs: ["task-good"],
            title: "Good Task",
            status: "pending",
            priority: 3,
            depends_on: [],
            notes: [],
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        malformedTask: {
          ulid: badUlid,
          content: `_ulid: ${badUlid}\ndescription: "incomplete"\n`,
        },
      });

      const result = kspec("validate --schema --json", tmpDir);
      const parsed = JSON.parse(result.stdout);

      // Both tasks should be counted — good task loaded by canonical path,
      // malformed task counted as a partial (included for ref validation)
      expect(parsed.stats.tasksChecked).toBe(2);

      // Bad task should produce schema errors
      const taskErrors = (parsed.schemaErrors ?? []).filter(
        (e: { file: string }) => e.file.includes(badUlid),
      );
      expect(taskErrors.length).toBeGreaterThan(0);
    });

    // AC: @validation-task-data-source ac-task-load-errors-reported
    // AC: @validation-task-data-source ac-task-references-checked
    // Regression: malformed split per-task records must NOT be silently omitted
    // when task-aware validation runs without schema validation (e.g. validate
    // --refs). The canonical loadAllTasks() silently skips parse failures, and
    // validatePerTaskFiles() previously only ran behind runSchema. This meant a
    // malformed task with spec_ref: "@missing-spec" was invisible to both schema
    // AND ref checks when running validate --refs.
    it("reports malformed split tasks and checks their refs even without --schema", async () => {
      const malformedUlid = testUlid("MALR1");

      await setupProject({
        malformedTask: {
          ulid: malformedUlid,
          // Missing required title — schema invalid, but has spec_ref
          content: `_ulid: ${malformedUlid}\nspec_ref: "@missing-spec"\nstatus: pending\npriority: 3\n`,
        },
      });

      // Run ONLY ref validation (no schema), the exact mode that triggered
      // the review blocker. Use kspecWithStatus because validation will exit
      // non-zero when it finds errors.
      const result = kspecWithStatus("validate --refs --json", tmpDir);
      const output = result.stdout || result.stderr;
      const parsed = JSON.parse(output);

      // Must report schema error for the malformed task even without --schema
      const taskErrors = (parsed.schemaErrors ?? []).filter(
        (e: { file: string }) => e.file.includes(malformedUlid),
      );
      expect(taskErrors.length).toBeGreaterThan(0);

      // Malformed task must be counted (not silently omitted)
      expect(parsed.stats.tasksChecked).toBeGreaterThanOrEqual(1);

      // The malformed task's spec_ref must contribute to ref validation findings
      const refErrors = parsed.refErrors ?? [];
      const danglingRef = refErrors.find(
        (e: { ref: string }) => e.ref === "@missing-spec",
      );
      expect(danglingRef).toBeDefined();
      expect(danglingRef.sourceUlid).toBe(malformedUlid);
    });
  });
});
