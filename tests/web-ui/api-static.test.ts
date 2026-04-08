import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KspecSnapshot } from "../../packages/shared/src/api";

const modeState = vi.hoisted(() => ({
  snapshot: null as KspecSnapshot | null,
  staticMode: false,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => modeState.snapshot,
  isStaticMode: () => modeState.staticMode,
  assertWritable: (op: string) => {
    if (modeState.staticMode) {
      throw new Error(`Cannot ${op} in read-only mode.`);
    }
  },
  ReadOnlyModeError: class ReadOnlyModeError extends Error {
    constructor(operation: string) {
      super(`Cannot ${operation} in read-only mode.`);
    }
  },
}));

const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));

const constantsMock = vi.hoisted(() => () => ({
  DAEMON_API_BASE: "http://localhost:3456",
}));

// Mock both $lib/ alias (used by api-static.ts) and relative path (resolved by api.ts)
vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../../packages/web-ui/src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../../packages/web-ui/src/lib/constants", constantsMock);

import {
  fetchAlignmentStatic,
  fetchItemsStatic,
  fetchPlanContentStatic,
  fetchPlansStatic,
  fetchTasksStatic,
  fetchTriageRecordsStatic,
  fetchValidationStatic,
} from "../../packages/web-ui/src/lib/api-static";
import { fetchSessions, fetchSession } from "../../packages/web-ui/src/lib/api";

function createSnapshot(): KspecSnapshot {
  return {
    version: "1.0.0",
    exported_at: "2026-03-08T00:00:00.000Z",
    project: { name: "Test Project", version: "0.1.0" },
    tasks: [
      {
        _ulid: "01TASK00000000000000000001",
        slugs: ["task-one"],
        title: "Task One",
        type: "task",
        status: "in_progress",
        priority: 2,
        spec_ref: "@spec-one",
        tags: ["ui"],
        depends_on: [],
        plan_ref: "@plan-one",
        automation: "eligible",
        notes: [],
        todos: [],
        notes_count: 0,
        todos_count: 0,
        created_at: "2026-03-01T00:00:00.000Z",
      },
      {
        _ulid: "01TASK00000000000000000002",
        slugs: ["task-two"],
        title: "Task Two",
        type: "task",
        status: "pending",
        priority: 3,
        spec_ref: "@spec-two",
        tags: ["docs"],
        depends_on: [],
        plan_ref: "@plan-two",
        notes: [],
        todos: [],
        notes_count: 0,
        todos_count: 0,
        created_at: "2026-03-02T00:00:00.000Z",
      },
    ],
    items: [
      {
        _ulid: "01SPEC00000000000000000001",
        slugs: ["spec-one"],
        title: "Spec One",
        type: "feature",
        tags: ["ui"],
        traits: [],
        depends_on: [],
        acceptance_criteria: [
          {
            _ulid: "01AC0000000000000000000001",
            given: "given",
            when: "when",
            then: "then", // oxlint-disable-line unicorn/no-thenable
          },
        ],
        created_at: "2026-03-01T00:00:00.000Z",
      },
      {
        _ulid: "01SPEC00000000000000000002",
        slugs: ["spec-two"],
        title: "Spec Two",
        type: "feature",
        tags: ["docs"],
        traits: [],
        depends_on: [],
        acceptance_criteria: [],
        created_at: "2026-03-02T00:00:00.000Z",
      },
    ],
    inbox: [],
    plans: [
      {
        _ulid: "01PLAN00000000000000000001",
        slugs: ["plan-one"],
        title: "Plan One",
        status: "active",
        created_at: "2026-03-01T00:00:00.000Z",
        derived_specs: ["@spec-one"],
        derived_tasks: ["@task-one"],
        spec_count: 1,
        task_count: 1,
        task_progress: {
          total: 1,
          completed: 0,
          in_progress: 1,
          pending: 0,
          blocked: 0,
        },
        content: "# Plan One",
      },
    ],
    triage: [
      {
        _ulid: "01TRIAGE000000000000000001",
        inbox_ref: "01INBOX000000000000000001",
        item_snapshot: "Investigate static mode",
        status: "triaged",
        action: "defer",
        reasoning: "Later",
        decided_by: "@test-user",
        evidence_refs: [],
        created_at: "2026-03-03T00:00:00.000Z",
      },
    ],
    session: null,
    observations: [],
    agents: [],
    workflows: [],
    conventions: [],
    validation: {
      valid: false,
      errorCount: 1,
      warningCount: 2,
      schemaErrors: [{ file: "a.yaml", message: "schema problem" }],
      refErrors: [],
      refWarnings: [],
      orphans: [],
      completenessWarnings: [
        {
          type: "missing_test_coverage",
          itemRef: "@spec-one",
          itemTitle: "Spec One",
          message: "Missing coverage",
          details: "Uncovered: ac-1",
        },
      ],
      traitCycles: [],
      errors: [{ file: "a.yaml", message: "schema problem" }],
      warnings: [{ file: "@spec-one", message: "Missing coverage" }],
    },
    alignment: {
      stats: {
        totalSpecs: 2,
        specsWithTasks: 1,
        alignedSpecs: 1,
        orphanedSpecs: 1,
      },
      warnings: [],
    },
  };
}

describe("static API snapshot adapters", () => {
  beforeEach(() => {
    modeState.snapshot = createSnapshot();
  });

  // AC: @web-dashboard ac-default-active-filter
  it("filters tasks by multiple statuses (array)", () => {
    // Add completed and cancelled tasks to the snapshot
    modeState.snapshot!.tasks.push(
      {
        _ulid: "01TASK00000000000000000003",
        slugs: ["task-completed"],
        title: "Completed Task",
        type: "task",
        status: "completed",
        priority: 1,
        spec_ref: "@spec-one",
        tags: [],
        depends_on: [],
        blocked_by: [],
        context: [],
        vcs_refs: [],
        plan_ref: "",
        automation: "manual_only",
        notes: [],
        todos: [],
        notes_count: 0,
        todos_count: 0,
        created_at: "2026-03-03T00:00:00.000Z",
      } as any,
      {
        _ulid: "01TASK00000000000000000004",
        slugs: ["task-cancelled"],
        title: "Cancelled Task",
        type: "task",
        status: "cancelled",
        priority: 1,
        spec_ref: "@spec-two",
        tags: [],
        depends_on: [],
        blocked_by: [],
        context: [],
        vcs_refs: [],
        plan_ref: "",
        automation: "manual_only",
        notes: [],
        todos: [],
        notes_count: 0,
        todos_count: 0,
        created_at: "2026-03-04T00:00:00.000Z",
      } as any,
    );

    // AC: @api-contract ac-envelope — static returns unified envelope
    // AC: @api-contract ac-cache-status-field — static data always "ready"

    // Filter by active statuses only (array of statuses)
    const active = fetchTasksStatic({
      status: ["pending", "in_progress", "pending_review", "needs_work", "blocked"],
    });
    expect(active.meta.cache_status).toBe("ready");
    expect(active.meta.total).toBe(2);
    expect(active.data.map((t: any) => t.status)).toEqual(
      expect.arrayContaining(["in_progress", "pending"]),
    );

    // Filter by single status (string)
    const pendingOnly = fetchTasksStatic({ status: "pending" });
    expect(pendingOnly.meta.total).toBe(1);
    expect(pendingOnly.data[0].status).toBe("pending");

    // No filter returns all
    const all = fetchTasksStatic();
    expect(all.meta.total).toBe(4);
  });

  // AC: @gh-pages-export ac-23
  it("returns static plans and resolves plan content by ref", () => {
    const plans = fetchPlansStatic();
    expect(plans.meta.total).toBe(1);
    expect(plans.data[0].title).toBe("Plan One");

    const detail = fetchPlanContentStatic("@plan-one");
    expect(detail.data.content).toContain("Plan One");
  });

  // AC: @gh-pages-export ac-23
  it("returns static triage records with filters", () => {
    const triaged = fetchTriageRecordsStatic({ status: "triaged" });
    expect(triaged.meta.total).toBe(1);
    expect(triaged.data[0].action).toBe("defer");

    const acted = fetchTriageRecordsStatic({ status: "acted_on" });
    expect(acted.meta.total).toBe(0);
  });

  // AC: @gh-pages-export ac-21
  it("returns detailed validation and alignment data from the snapshot", () => {
    const validation = fetchValidationStatic();
    const alignment = fetchAlignmentStatic();

    expect(validation.data.schemaErrors).toHaveLength(1);
    expect(validation.data.completenessWarnings).toHaveLength(1);
    expect(alignment.data.stats.totalSpecs).toBe(2);
    expect(alignment.data.stats.orphanedSpecs).toBe(1);
  });

  // AC: @ui-task-board ac-all-active-tasks — static paginate returns all tasks when no limit
  it("returns all tasks when no limit is specified (board fetch path)", () => {
    // Create a snapshot with many tasks across active statuses
    const snapshot = createSnapshot();
    const statuses = [
      "pending",
      "in_progress",
      "needs_work",
      "pending_review",
      "blocked",
      "completed",
    ];
    const extraTasks = Array.from({ length: 60 }, (_, i) => ({
      _ulid: `01TASK0000000000000000${String(i + 10).padStart(5, "0")}`,
      slugs: [`task-extra-${i}`],
      title: `Extra Task ${i}`,
      type: "task" as const,
      status: statuses[i % statuses.length],
      priority: 3,
      tags: [],
      depends_on: [],
      automation: "eligible" as const,
      notes: [],
      todos: [],
      notes_count: 0,
      todos_count: 0,
      created_at: new Date(Date.now() - i * 86400000).toISOString(),
    }));
    snapshot.tasks = [...snapshot.tasks, ...extraTasks];
    modeState.snapshot = snapshot;

    // Board calls fetchTasks() with no params — should return ALL tasks
    const result = fetchTasksStatic();
    expect(result.data).toHaveLength(snapshot.tasks.length);
    expect(result.meta.total).toBe(snapshot.tasks.length);
    expect(result.meta.limit).toBe(snapshot.tasks.length);
  });

  // AC: @ui-task-board ac-all-active-tasks — explicit limit still works
  it("respects explicit limit when provided", () => {
    const result = fetchTasksStatic({ limit: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.meta.total).toBe(2); // snapshot has 2 tasks
    expect(result.meta.limit).toBe(1);
  });

  // AC: @gh-pages-export ac-23
  it("supports plan filtering for static task and item lists", () => {
    const tasks = fetchTasksStatic({ plan: "plan-one" });
    const items = fetchItemsStatic({ plan: "plan-one" });

    expect(tasks.meta.total).toBe(1);
    expect(tasks.data[0].title).toBe("Task One");
    expect(items.meta.total).toBe(1);
    expect(items.data[0].title).toBe("Spec One");
    expect(items.data[0].acceptance_criteria_count).toBe(1);
  });

  // AC: @api-contract ac-plan-filter-derived
  it("includes tasks in derived_tasks even without plan_ref (bidirectional)", () => {
    // Add a task that is in plan-one's derived_tasks but has NO plan_ref
    modeState.snapshot!.tasks.push({
      _ulid: "01TASK00000000000000000005",
      slugs: ["task-derived-only"],
      title: "Derived Only Task",
      type: "task",
      status: "pending",
      priority: 2,
      spec_ref: "@spec-one",
      tags: [],
      depends_on: [],
      plan_ref: "",
      automation: "eligible",
      notes: [],
      todos: [],
      notes_count: 0,
      todos_count: 0,
      created_at: "2026-03-05T00:00:00.000Z",
    } as any);
    // Add this task to plan-one's derived_tasks
    modeState.snapshot!.plans![0].derived_tasks.push("@task-derived-only");

    const tasks = fetchTasksStatic({ plan: "plan-one" });
    const titles = tasks.data.map((t: any) => t.title);
    expect(titles).toContain("Task One"); // matched by plan_ref
    expect(titles).toContain("Derived Only Task"); // matched by derived_tasks
    expect(tasks.meta.total).toBe(2);
  });

  // AC: @api-contract ac-plan-filter-ref
  it("includes tasks with plan_ref even when not in derived_tasks (bidirectional)", () => {
    // Add a task with plan_ref pointing to plan-one but NOT in derived_tasks
    modeState.snapshot!.tasks.push({
      _ulid: "01TASK00000000000000000006",
      slugs: ["task-planref-only"],
      title: "PlanRef Only Task",
      type: "task",
      status: "pending",
      priority: 2,
      spec_ref: "@spec-one",
      tags: [],
      depends_on: [],
      plan_ref: "@plan-one",
      automation: "eligible",
      notes: [],
      todos: [],
      notes_count: 0,
      todos_count: 0,
      created_at: "2026-03-06T00:00:00.000Z",
    } as any);
    // plan-one.derived_tasks still only has ["@task-one"]

    const tasks = fetchTasksStatic({ plan: "plan-one" });
    const titles = tasks.data.map((t: any) => t.title);
    expect(titles).toContain("Task One"); // matched by both
    expect(titles).toContain("PlanRef Only Task"); // matched by plan_ref only
    expect(tasks.meta.total).toBe(2);
  });

  // AC: @api-contract ac-plan-filter-not-found
  it("returns empty array when plan filter matches no plan", () => {
    const tasks = fetchTasksStatic({ plan: "nonexistent-plan" });
    expect(tasks.data).toEqual([]);
    expect(tasks.meta.total).toBe(0);
  });

  // AC: @api-contract ac-plan-filter-additive
  it("plan filter is additive with other filters", () => {
    // Add a task with plan_ref pointing to plan-one but different status
    modeState.snapshot!.tasks.push({
      _ulid: "01TASK00000000000000000007",
      slugs: ["task-plan-completed"],
      title: "Completed Plan Task",
      type: "task",
      status: "completed",
      priority: 2,
      spec_ref: "@spec-one",
      tags: [],
      depends_on: [],
      plan_ref: "@plan-one",
      automation: "eligible",
      notes: [],
      todos: [],
      notes_count: 0,
      todos_count: 0,
      created_at: "2026-03-07T00:00:00.000Z",
    } as any);
    modeState.snapshot!.plans![0].derived_tasks.push("@task-plan-completed");

    // Filter by plan AND status
    const tasks = fetchTasksStatic({ plan: "plan-one", status: "in_progress" });
    expect(tasks.meta.total).toBe(1);
    expect(tasks.data[0].title).toBe("Task One");
  });

  // AC: @api-contract ac-plan-filter-resolve
  it("resolves plan by ULID prefix", () => {
    const tasks = fetchTasksStatic({ plan: "01PLAN" });
    expect(tasks.meta.total).toBe(1);
    expect(tasks.data[0].title).toBe("Task One");
  });
});

// AC: @gh-pages-export ac-22
describe("static sessions behavior (@gh-pages-export ac-22)", () => {
  beforeEach(() => {
    modeState.staticMode = true;
  });

  afterEach(() => {
    modeState.staticMode = false;
  });

  it("fetchSessions returns empty list in static mode", async () => {
    const result = await fetchSessions();
    expect(result).toEqual({ items: [], total: 0, unfiltered_total: 0, offset: 0, limit: 25 });
  });

  it("fetchSession throws in static mode", async () => {
    await expect(fetchSession("test-session-id")).rejects.toThrow(
      "Session data not available in static mode",
    );
  });
});
