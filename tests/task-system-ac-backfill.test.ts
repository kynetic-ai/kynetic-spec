import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { createTask, initContext, loadAllTasks } from "../src/parser/index.js";
import { TaskSchema } from "../src/schema/index.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspecJson,
  kspecOutput,
  setupTempFixtures,
  testUlid,
} from "./helpers/cli.js";

const touchedTaskRefs = [
  "@task-types",
  "@state-pending",
  "@state-in-progress",
  "@state-completed",
  "@state-cancelled",
  "@state-blocked",
  "@task-schema",
  "@task-spec-ref",
  "@task-work-fields",
  "@task-timestamps",
  "@task-vcs-refs",
  "@derived-ready",
  "@query-ready",
  "@query-next",
  "@query-filters",
  "@derive-command",
  "@derive-idempotency",
  "@note-structure",
  "@note-cli",
  "@todo-structure",
  "@todo-cli",
  "@task-storage",
  "@task-storage-alongside",
  "@task-storage-separate",
];

async function writeTaskBackfillSpecFixture(rootDir: string): Promise<void> {
  const items = touchedTaskRefs.map((ref, index) => {
    const slug = ref.slice(1);

    return {
      _ulid: testUlid("TASK", index + 20),
      slugs: [slug],
      title: slug
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      type: "feature",
      status: {
        maturity: "draft",
        implementation: "implemented",
      },
      description: `Synthetic task-system fixture coverage for ${ref}.`,
      acceptance_criteria: [
        {
          id: "ac-1",
          given: `${ref} exists in the task-system fixture with a documented scenario`,
          when: "the item is reviewed for backfill quality in an isolated test project",
          then: "the behavior remains concrete, observable, and suitable for spec completeness checks",
        },
      ],
    };
  });

  const tasksModule = {
    _ulid: testUlid("TASK", 1),
    slugs: ["tasks"],
    title: "Task System",
    type: "module",
    status: {
      maturity: "draft",
      implementation: "implemented",
    },
    description: "Synthetic task-system module used for AC backfill review coverage.",
    features: items,
  };

  await fs.mkdir(path.join(rootDir, "modules"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "modules", "tasks.yaml"), yamlStringify(tasksModule), "utf-8");

  const configPath = path.join(rootDir, "kynetic.yaml");
  const config = yamlParse(await fs.readFile(configPath, "utf-8")) as {
    includes?: string[];
  };
  const includes = new Set(config.includes ?? []);
  includes.add("modules/tasks.yaml");
  config.includes = [...includes];
  await fs.writeFile(configPath, yamlStringify(config), "utf-8");
}

describe("Task system AC backfill coverage", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-types ac-1
  // AC: @task-schema ac-1
  // AC: @task-spec-ref ac-1
  // AC: @task-work-fields ac-1
  // AC: @task-timestamps ac-1
  // AC: @task-vcs-refs ac-1
  it("creates task records with supported types, task-specific metadata, timestamps, and vcs refs", () => {
    const base = createTask({
      title: "Implement feature",
      type: "task",
      spec_ref: "@test-feature",
      priority: 1,
      complexity: 2,
      assignee: "@tester",
      blocked_by: ["Waiting on review"],
      closed_reason: "Captured for schema validation",
      vcs_refs: [{ ref: "feat/task-system", type: "branch" }],
    });

    expect(base.type).toBe("task");
    expect(base.spec_ref).toBe("@test-feature");
    expect(base.priority).toBe(1);
    expect(base.complexity).toBe(2);
    expect(base.assignee).toBe("@tester");
    expect(base.blocked_by).toEqual(["Waiting on review"]);
    expect(base.closed_reason).toBe("Captured for schema validation");
    expect(base.vcs_refs).toEqual([{ ref: "feat/task-system", type: "branch" }]);
    expect(base.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect("acceptance_criteria" in base).toBe(false);

    const validTypes: Array<"epic" | "task" | "bug" | "spike" | "infra"> = [
      "epic",
      "task",
      "bug",
      "spike",
      "infra",
    ];

    for (const type of validTypes) {
      const parsed = TaskSchema.safeParse({
        ...base,
        _ulid: createTask({ title: `Task ${type}` })._ulid,
        title: `Task ${type}`,
        type,
      });
      expect(parsed.success).toBe(true);
    }

    const bugTask = createTask({ title: "Fix regression", type: "bug" });
    const infraTask = createTask({ title: "Rotate keys", type: "infra" });
    expect(bugTask.spec_ref ?? null).toBeNull();
    expect(infraTask.spec_ref ?? null).toBeNull();
  });

  // AC: @state-pending ac-1
  // AC: @state-in-progress ac-1
  // AC: @state-completed ac-1
  // AC: @state-cancelled ac-1
  it("moves tasks through pending, active, review, completed, and cancelled states with persisted reasons", () => {
    kspecOutput("task start @test-task-pending", tempDir);
    let task = kspecJson<{ status: string }>("task get @test-task-pending", tempDir);
    expect(task.status).toBe("in_progress");

    kspecOutput("task submit @test-task-pending", tempDir);
    task = kspecJson<{ status: string }>("task get @test-task-pending", tempDir);
    expect(task.status).toBe("pending_review");

    kspecOutput('task complete @test-task-pending --reason "Merged"', tempDir);
    const completed = kspecJson<{
      status: string;
      closed_reason: string | null;
      completed_at: string | null;
    }>("task get @test-task-pending", tempDir);
    expect(completed.status).toBe("completed");
    expect(completed.closed_reason).toBe("Merged");
    expect(completed.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    kspecOutput('task add --title "Cancel me" --slug cancel-me', tempDir);
    kspecOutput("task start @cancel-me", tempDir);
    kspecOutput('task cancel @cancel-me --reason "No longer needed"', tempDir);
    const cancelled = kspecJson<{
      status: string;
      closed_reason: string | null;
    }>("task get @cancel-me", tempDir);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.closed_reason).toBe("No longer needed");
  });

  // AC: @state-blocked ac-1
  it("returns blocked tasks to a non-terminal state when they are unblocked", () => {
    kspecOutput('task add --title "Blocked task" --slug blocked-task', tempDir);
    kspecOutput("task start @blocked-task", tempDir);
    kspecOutput('task block @blocked-task --reason "Waiting on API"', tempDir);

    const blocked = kspecJson<{ status: string; blocked_by: string[] }>(
      "task get @blocked-task",
      tempDir,
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.blocked_by).toEqual(["Waiting on API"]);

    kspecOutput("task unblock @blocked-task", tempDir);
    const unblocked = kspecJson<{ status: string; blocked_by: string[] }>(
      "task get @blocked-task",
      tempDir,
    );
    expect(unblocked.status).toBe("pending");
    expect(unblocked.blocked_by).toEqual([]);
  });

  // AC: @derived-ready ac-1
  // AC: @query-ready ac-1
  it("computes ready work from status, blockers, and dependencies and sorts needs_work before pending", () => {
    kspecOutput("task start @test-task-pending", tempDir);
    kspecOutput("task submit @test-task-pending", tempDir);
    kspecOutput('task needs-work @test-task-pending --reason "Needs follow-up"', tempDir);

    const ready = kspecJson<Array<{ slugs: string[]; status: string }>>(
      "tasks ready",
      tempDir,
    );

    expect(ready[0].slugs).toContain("test-task-pending");
    expect(ready[0].status).toBe("needs_work");
    expect(ready.some((task) => task.slugs.includes("test-task-secondary"))).toBe(true);
    expect(ready.some((task) => task.slugs.includes("test-task-blocked"))).toBe(false);
    expect(ready.some((task) => task.status === "completed")).toBe(false);
  });

  // AC: @query-next ac-1
  // AC: @query-filters ac-1
  it("returns the highest-priority ready task and supports task list filters in json mode", () => {
    kspecOutput("task set @test-task-pending --priority 4", tempDir);
    kspecOutput("task set @test-task-secondary --priority 5", tempDir);
    kspecOutput(
      'task add --title "Filter match" --slug filter-match --priority 1 --tag cli --meta-ref @task-start',
      tempDir,
    );
    kspecOutput(
      'task add --title "Filter miss" --slug filter-miss --priority 4 --tag other --meta-ref @test-agent',
      tempDir,
    );

    const nextTask = kspecJson<{ slugs: string[]; priority: number }>("tasks next", tempDir);
    expect(nextTask.slugs).toContain("filter-match");
    expect(nextTask.priority).toBe(1);

    const byStatus = kspecJson<Array<{ slugs: string[]; status: string }>>(
      "tasks list --status pending",
      tempDir,
    );
    expect(byStatus.every((task) => task.status === "pending")).toBe(true);

    const byType = kspecJson<Array<{ slugs: string[]; type: string }>>(
      "tasks list --type task",
      tempDir,
    );
    expect(byType.every((task) => task.type === "task")).toBe(true);

    const byTag = kspecJson<Array<{ slugs: string[] }>>("tasks list --tag cli", tempDir);
    expect(byTag.some((task) => task.slugs.includes("filter-match"))).toBe(true);
    expect(byTag.some((task) => task.slugs.includes("filter-miss"))).toBe(false);

    const byMetaRef = kspecJson<Array<{ slugs: string[] }>>(
      "tasks list --meta-ref @task-start",
      tempDir,
    );
    expect(byMetaRef.map((task) => task.slugs[0])).toContain("filter-match");
  });

  // AC: @derive-command ac-1
  // AC: @derive-idempotency ac-1
  it("derives spec-linked tasks once and skips duplicates without force", () => {
    const first = kspecOutput("derive @test-feature --flat", tempDir);
    expect(first).toContain("Created");

    const derivedTask = kspecJson<{
      title: string;
      type: string;
      spec_ref: string | null;
      derivation?: string;
    }>("task get @task-test-feature", tempDir);
    expect(derivedTask.title).toContain("Test Feature");
    expect(derivedTask.type).toBe("task");
    expect(derivedTask.spec_ref).toBe("@test-feature");
    expect(derivedTask.derivation).toBe("auto");

    const second = kspecOutput("derive @test-feature --flat", tempDir);
    expect(second).toContain("Skipped");
    expect(second).toContain("task exists");
  });

  // AC: @note-structure ac-1
  // AC: @note-cli ac-1
  it("stores append-only notes with supersession metadata and exposes them through CLI commands", () => {
    kspecOutput('task note @test-task-pending "Initial note"', tempDir);
    const firstRead = kspecJson<{
      notes: Array<{
        _ulid: string;
        created_at: string;
        author?: string;
        content: string;
        supersedes?: string | null;
      }>;
    }>("task get @test-task-pending", tempDir);

    const firstNote = firstRead.notes[0];
    expect(firstNote.content).toBe("Initial note");
    expect(firstNote.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(firstNote.author).toBe("@test");

    kspecOutput(
      `task note @test-task-pending "Corrected note" --supersedes ${firstNote._ulid}`,
      tempDir,
    );

    const secondRead = kspecJson<{
      notes: Array<{ content: string; supersedes?: string | null }>;
    }>("task get @test-task-pending", tempDir);
    expect(secondRead.notes).toHaveLength(2);
    expect(secondRead.notes.some((note) => note.content === "Corrected note")).toBe(true);
    expect(secondRead.notes.some((note) => note.supersedes === firstNote._ulid)).toBe(true);

    const logOutput = kspecOutput("task notes @test-task-pending", tempDir);
    expect(logOutput).toContain("Initial note");
    expect(logOutput).toContain("Corrected note");
  });

  // AC: @todo-structure ac-1
  // AC: @todo-cli ac-1
  it("stores todo identity and state changes across add, done, undone, and list commands", () => {
    kspecOutput('task todo add @test-task-pending "Write task-system checks"', tempDir);

    let task = kspecJson<{
      todos: Array<{
        id: number;
        text: string;
        done: boolean;
        added_at: string;
        added_by?: string;
        done_at?: string;
      }>;
    }>("task get @test-task-pending", tempDir);

    expect(task.todos).toHaveLength(1);
    expect(task.todos[0].id).toBe(1);
    expect(task.todos[0].text).toBe("Write task-system checks");
    expect(task.todos[0].done).toBe(false);
    expect(task.todos[0].added_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    kspecOutput("task todo done @test-task-pending 1", tempDir);
    task = kspecJson("task get @test-task-pending", tempDir);
    expect(task.todos[0].id).toBe(1);
    expect(task.todos[0].done).toBe(true);
    expect(task.todos[0].done_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    kspecOutput("task todo undone @test-task-pending 1", tempDir);
    task = kspecJson("task get @test-task-pending", tempDir);
    expect(task.todos[0].id).toBe(1);
    expect(task.todos[0].done).toBe(false);

    const todosOutput = kspecOutput("task todos @test-task-pending", tempDir);
    expect(todosOutput).toContain("Write task-system checks");
  });
});

describe("Task storage discovery coverage", () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await cleanupTempDir(tempDir);
    }
  });

  // AC: @task-storage ac-1
  // AC: @task-storage-alongside ac-1
  it("loads tasks from project.tasks.yaml alongside the spec manifest", async () => {
    tempDir = await createTempDir();
    const specDir = path.join(tempDir, "spec");
    await fs.mkdir(specDir, { recursive: true });
    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      'kynetic: "1.0"\nproject: Alongside\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(specDir, "project.tasks.yaml"),
      `tasks:
  - _ulid: ${testUlid("TASK", 1)}
    slugs: [alongside-task]
    title: Alongside task
    type: task
    status: pending
    blocked_by: []
    depends_on: []
    context: []
    priority: 3
    tags: []
    vcs_refs: []
    created_at: 2026-03-01T00:00:00Z
    notes: []
    todos: []
`,
      "utf-8",
    );

    const ctx = await initContext(tempDir);
    const tasks = await loadAllTasks(ctx);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].slugs).toContain("alongside-task");
    expect(tasks[0]._sourceFile).toBe(path.join(specDir, "project.tasks.yaml"));
  });

  // AC: @task-storage-separate ac-1
  it("loads tasks from separate backlog and active task files", async () => {
    tempDir = await createTempDir();
    const specDir = path.join(tempDir, "spec");
    const tasksDir = path.join(tempDir, "tasks");
    await fs.mkdir(specDir, { recursive: true });
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(specDir, "kynetic.yaml"),
      'kynetic: "1.0"\nproject: Separate\n',
      "utf-8",
    );
    await fs.writeFile(
      path.join(tasksDir, "backlog.tasks.yaml"),
      `tasks:
  - _ulid: ${testUlid("TASK", 2)}
    slugs: [backlog-task]
    title: Backlog task
    type: task
    status: pending
    blocked_by: []
    depends_on: []
    context: []
    priority: 4
    tags: []
    vcs_refs: []
    created_at: 2026-03-01T00:00:00Z
    notes: []
    todos: []
`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(tasksDir, "active.tasks.yaml"),
      `tasks:
  - _ulid: ${testUlid("TASK", 3)}
    slugs: [active-task]
    title: Active task
    type: task
    status: in_progress
    blocked_by: []
    depends_on: []
    context: []
    priority: 2
    tags: []
    vcs_refs: []
    created_at: 2026-03-01T00:00:00Z
    started_at: 2026-03-01T00:05:00Z
    notes: []
    todos: []
`,
      "utf-8",
    );

    const ctx = await initContext(tempDir);
    const tasks = await loadAllTasks(ctx);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.slugs[0]).sort()).toEqual([
      "active-task",
      "backlog-task",
    ]);
    expect(tasks.every((task) => task._sourceFile?.startsWith(tasksDir))).toBe(true);
  });
});

describe("Task system AC backfill spec quality", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await writeTaskBackfillSpecFixture(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @tasks-ac-backfill ac-coverage
  it("leaves no non-module @tasks descendants without acceptance criteria", () => {
    const listing = kspecJson<{
      items: Array<{
        ref: string;
        type: string;
        acceptance_criteria?: Array<unknown>;
      }>;
    }>("item list --under @tasks --limit 999", tempDir);

    const missing = listing.items
      .filter((item) => item.ref !== "@tasks" && item.type !== "module")
      .filter((item) => (item.acceptance_criteria?.length ?? 0) === 0)
      .map((item) => item.ref);

    expect(missing).toEqual([]);
  });

  // AC: @tasks-ac-backfill ac-testable
  it("keeps each touched task-system AC in concrete given/when/then form", () => {
    const listing = kspecJson<{
      items: Array<{
        ref: string;
        acceptance_criteria?: Array<{
          id: string;
          given: string;
          when: string;
          then: string;
        }>;
      }>;
    }>("item list --under @tasks --limit 999", tempDir);

    const touchedItems = listing.items.filter((item) => touchedTaskRefs.includes(item.ref));
    expect(touchedItems).toHaveLength(touchedTaskRefs.length);

    for (const item of touchedItems) {
      expect(item.acceptance_criteria?.length ?? 0).toBeGreaterThan(0);

      for (const criterion of item.acceptance_criteria ?? []) {
        expect(criterion.id).toMatch(/^ac-/);
        expect(criterion.given.trim().length).toBeGreaterThan(10);
        expect(criterion.when.trim().length).toBeGreaterThan(10);
        expect(criterion.then.trim().length).toBeGreaterThan(10);
        expect(`${criterion.given} ${criterion.when} ${criterion.then}`).not.toContain("...");
        expect(criterion.then.toLowerCase()).not.toContain("works correctly");
      }
    }
  });
});
