/**
 * Unit tests for Task Board (Kanban) column distribution logic.
 *
 * AC: @ui-task-board ac-1 — Tasks distributed into correct columns
 * AC: @ui-task-board ac-2 — Utility functions for card metadata
 */

import { describe, it, expect } from "vitest";
import {
  distributeToColumns,
  formatAge,
  formatElapsed,
  formatVcsRef,
} from "../../packages/web-ui/src/lib/components/board/board-utils";
import type { TaskSummary } from "../../packages/shared/src/api";

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    _ulid: `01ABC${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    slugs: ["test-task"],
    title: "Test Task",
    type: "task",
    status: "pending",
    priority: 3,
    tags: [],
    depends_on: [],
    created_at: new Date().toISOString(),
    notes_count: 0,
    ...overrides,
  };
}

describe("distributeToColumns", () => {
  // AC: @ui-task-board ac-1
  it("distributes pending+unassessed tasks to Backlog column", () => {
    const tasks = [
      makeTask({ status: "pending", automation: undefined }),
      makeTask({ status: "pending", automation: "manual_only" }),
    ];
    const columns = distributeToColumns(tasks);
    const backlog = columns.find((c) => c.id === "backlog")!;
    expect(backlog.tasks).toHaveLength(2);
  });

  // AC: @ui-task-board ac-1
  it("distributes pending+eligible tasks to Ready column", () => {
    const tasks = [makeTask({ status: "pending", automation: "eligible" })];
    const columns = distributeToColumns(tasks);
    const ready = columns.find((c) => c.id === "ready")!;
    expect(ready.tasks).toHaveLength(1);
  });

  // AC: @ui-task-board ac-1
  it("distributes in_progress and needs_work to In Progress column", () => {
    const tasks = [makeTask({ status: "in_progress" }), makeTask({ status: "needs_work" })];
    const columns = distributeToColumns(tasks);
    const inProgress = columns.find((c) => c.id === "in_progress")!;
    expect(inProgress.tasks).toHaveLength(2);
  });

  // AC: @ui-task-board ac-1
  it("distributes pending_review to Review column", () => {
    const tasks = [makeTask({ status: "pending_review" })];
    const columns = distributeToColumns(tasks);
    const review = columns.find((c) => c.id === "review")!;
    expect(review.tasks).toHaveLength(1);
  });

  // AC: @ui-task-board ac-1
  it("distributes completed to Done column (limited to 20)", () => {
    const tasks = Array.from({ length: 25 }, (_, i) =>
      makeTask({
        status: "completed",
        created_at: new Date(Date.now() - i * 86400000).toISOString(),
      }),
    );
    const columns = distributeToColumns(tasks);
    const done = columns.find((c) => c.id === "done")!;
    expect(done.tasks).toHaveLength(20);
  });

  // AC: @ui-task-board ac-1
  it("visible task count is less than total when many completed tasks exist", () => {
    // Regression: header showed total fetched tasks (e.g. 500) instead of
    // sum of visible column tasks. With 490 completed tasks capped at 20,
    // visible count should be much less than total.
    const active = [
      makeTask({ status: "pending", automation: undefined }),
      makeTask({ status: "pending", automation: "eligible" }),
      makeTask({ status: "in_progress" }),
    ];
    const completed = Array.from({ length: 100 }, (_, i) =>
      makeTask({
        status: "completed",
        created_at: new Date(Date.now() - i * 86400000).toISOString(),
      }),
    );
    const allTasks = [...active, ...completed];
    const columns = distributeToColumns(allTasks);
    const visibleCount = columns.reduce((sum, col) => sum + col.tasks.length, 0);
    // 1 backlog + 1 ready + 1 in_progress + 0 review + 20 done = 23
    expect(visibleCount).toBe(23);
    expect(visibleCount).toBeLessThan(allTasks.length);
  });

  // AC: @ui-task-board ac-1
  it("places blocked tasks in In Progress column", () => {
    const tasks = [makeTask({ status: "blocked" })];
    const columns = distributeToColumns(tasks);
    const inProgress = columns.find((c) => c.id === "in_progress")!;
    expect(inProgress.tasks).toHaveLength(1);
    expect(inProgress.tasks[0].status).toBe("blocked");
  });

  // AC: @ui-task-board ac-1
  it("places cancelled tasks in Done column", () => {
    const tasks = [makeTask({ status: "cancelled" })];
    const columns = distributeToColumns(tasks);
    const done = columns.find((c) => c.id === "done")!;
    expect(done.tasks).toHaveLength(1);
    expect(done.tasks[0].status).toBe("cancelled");
  });

  // AC: @ui-task-board ac-1
  it("sorts columns by priority (lower number = higher priority)", () => {
    const tasks = [
      makeTask({ status: "pending", automation: "eligible", priority: 5 }),
      makeTask({ status: "pending", automation: "eligible", priority: 1 }),
      makeTask({ status: "pending", automation: "eligible", priority: 3 }),
    ];
    const columns = distributeToColumns(tasks);
    const ready = columns.find((c) => c.id === "ready")!;
    expect(ready.tasks[0].priority).toBe(1);
    expect(ready.tasks[1].priority).toBe(3);
    expect(ready.tasks[2].priority).toBe(5);
  });

  // AC: @ui-task-board ac-1
  it("returns all five columns even when empty", () => {
    const columns = distributeToColumns([]);
    expect(columns).toHaveLength(5);
    expect(columns.map((c) => c.id)).toEqual(["backlog", "ready", "in_progress", "review", "done"]);
  });

  // AC: @ui-task-board ac-all-active-tasks
  it("shows all active tasks in their columns with no arbitrary cap", () => {
    // Simulate what the board does: fetch all tasks, then distribute.
    // With 100+ active tasks across all active statuses, every one
    // must appear in the correct column — no limit truncation.
    const activeTasks = [
      ...Array.from({ length: 40 }, (_, i) =>
        makeTask({ status: "pending", automation: undefined, title: `Backlog ${i}` }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        makeTask({ status: "pending", automation: "eligible", title: `Ready ${i}` }),
      ),
      ...Array.from({ length: 25 }, (_, i) =>
        makeTask({ status: "in_progress", title: `InProgress ${i}` }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeTask({ status: "needs_work", title: `NeedsWork ${i}` }),
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        makeTask({ status: "pending_review", title: `Review ${i}` }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeTask({ status: "blocked", title: `Blocked ${i}` }),
      ),
    ];
    // Also add completed tasks (should be capped at 20)
    const completedTasks = Array.from({ length: 50 }, (_, i) =>
      makeTask({
        status: "completed",
        title: `Done ${i}`,
        created_at: new Date(Date.now() - i * 86400000).toISOString(),
      }),
    );
    const allTasks = [...activeTasks, ...completedTasks];

    const columns = distributeToColumns(allTasks);

    // Active columns must show every matching task — no arbitrary limit
    expect(columns.find((c) => c.id === "backlog")!.tasks).toHaveLength(40);
    expect(columns.find((c) => c.id === "ready")!.tasks).toHaveLength(30);
    expect(columns.find((c) => c.id === "in_progress")!.tasks).toHaveLength(25 + 10 + 5); // in_progress + needs_work + blocked
    expect(columns.find((c) => c.id === "review")!.tasks).toHaveLength(15);
    // Done column should be capped at 20
    expect(columns.find((c) => c.id === "done")!.tasks).toHaveLength(20);

    // Total visible active tasks = sum of active columns
    const activeColumnCount = columns
      .filter((c) => c.id !== "done")
      .reduce((sum, col) => sum + col.tasks.length, 0);
    expect(activeColumnCount).toBe(activeTasks.length);
  });
});

// Task-status → visual-token mapping (formerly board-utils `getStatusClasses`)
// is now owned by the shared status-token vocabulary; its coverage lives in
// tests/web-ui-status-tokens.test.ts, which asserts every TaskStatusSchema state
// resolves to a defined token (label + design-token family) plus uniqueness,
// determinism, and the unknown-state fallback. TaskCard/TaskDetailContent render
// that token via StatusBadge (see tests/e2e/task-board.spec.ts).

describe("formatAge", () => {
  // AC: @ui-task-board ac-2
  it("formats recent dates as minutes", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatAge(fiveMinAgo)).toBe("5m");
  });

  // AC: @ui-task-board ac-2
  it("formats hours", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    expect(formatAge(threeHoursAgo)).toBe("3h");
  });

  // AC: @ui-task-board ac-2
  it("formats days", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
    expect(formatAge(fiveDaysAgo)).toBe("5d");
  });
});

describe("formatElapsed", () => {
  // AC: @ui-task-board ac-4
  it("formats seconds", () => {
    expect(formatElapsed(45000)).toBe("45s");
  });

  // AC: @ui-task-board ac-4
  it("formats minutes and seconds", () => {
    expect(formatElapsed(125000)).toBe("2m 5s");
  });

  // AC: @ui-task-board ac-4
  it("formats hours and minutes", () => {
    expect(formatElapsed(3725000)).toBe("1h 2m");
  });
});

describe("formatVcsRef", () => {
  // AC: @ui-task-board ac-3
  it("parses branch: prefix into label without URL", () => {
    const result = formatVcsRef("branch:feat/my-feature");
    expect(result.label).toBe("feat/my-feature");
    expect(result.url).toBeNull();
  });

  // AC: @ui-task-board ac-3
  it("parses pr: prefix with number", () => {
    const result = formatVcsRef("pr:42");
    expect(result.label).toBe("PR #42");
    expect(result.url).toBeNull();
  });

  // AC: @ui-task-board ac-3
  it("parses pr: prefix with URL", () => {
    const result = formatVcsRef("pr:https://github.com/org/repo/pull/42");
    expect(result.label).toBe("PR 42");
    expect(result.url).toBe("https://github.com/org/repo/pull/42");
  });

  // AC: @ui-task-board ac-3
  it("parses direct GitHub PR URL", () => {
    const result = formatVcsRef("https://github.com/org/repo/pull/99");
    expect(result.label).toBe("PR #99");
    expect(result.url).toBe("https://github.com/org/repo/pull/99");
  });

  // AC: @ui-task-board ac-3
  it("parses direct URL without PR pattern", () => {
    const result = formatVcsRef("https://github.com/org/repo");
    expect(result.label).toBe("repo");
    expect(result.url).toBe("https://github.com/org/repo");
  });

  // AC: @ui-task-board ac-3
  it("returns plain text for unknown format", () => {
    const result = formatVcsRef("some-ref");
    expect(result.label).toBe("some-ref");
    expect(result.url).toBeNull();
  });
});

describe("real-time update support", () => {
  // AC: @ui-task-board ac-5
  it("distributeToColumns is a pure function that can be re-called on data changes", () => {
    // The board re-derives columns from $effect whenever tasks array changes.
    // Verify that distributeToColumns produces correct output when called
    // with updated data (simulating a WebSocket-triggered reload).
    const initial = [makeTask({ status: "pending", automation: "eligible" })];
    const columnsV1 = distributeToColumns(initial);
    expect(columnsV1.find((c) => c.id === "ready")!.tasks).toHaveLength(1);
    expect(columnsV1.find((c) => c.id === "in_progress")!.tasks).toHaveLength(0);

    // After a state change event, the tasks array is updated
    const updated = [makeTask({ ...initial[0], status: "in_progress" })];
    const columnsV2 = distributeToColumns(updated);
    expect(columnsV2.find((c) => c.id === "ready")!.tasks).toHaveLength(0);
    expect(columnsV2.find((c) => c.id === "in_progress")!.tasks).toHaveLength(1);
  });

  // AC: @ui-task-board ac-5
  it("handles empty-to-populated transitions for real-time updates", () => {
    // Board starts empty, then tasks arrive via WebSocket-triggered reload
    const empty = distributeToColumns([]);
    expect(empty.every((c) => c.tasks.length === 0)).toBe(true);

    const populated = distributeToColumns([
      makeTask({ status: "pending", automation: "eligible" }),
      makeTask({ status: "in_progress" }),
      makeTask({ status: "pending_review" }),
    ]);
    expect(populated.find((c) => c.id === "ready")!.tasks).toHaveLength(1);
    expect(populated.find((c) => c.id === "in_progress")!.tasks).toHaveLength(1);
    expect(populated.find((c) => c.id === "review")!.tasks).toHaveLength(1);
  });
});
