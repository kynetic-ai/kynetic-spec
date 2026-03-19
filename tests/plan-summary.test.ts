import { describe, expect, it } from "vitest";
import {
  countPlanTaskProgress,
  getLinkedPlanSummaryTasks,
  isCountedInPlanSummary,
} from "../src/lib/plan-summary.js";

describe("plan summary helpers", () => {
  // AC: @01KM46FW ac-1
  it("includes both derived_tasks and plan_ref links without double-counting overlap", () => {
    const plan = {
      _ulid: "01PLAN00000000000000000001",
      slugs: ["plan-one"],
      derived_tasks: ["@task-derived", "@task-overlap"],
    };
    const tasks = [
      {
        _ulid: "01TASK00000000000000000001",
        slugs: ["task-derived"],
        plan_ref: null,
        status: "in_progress",
      },
      {
        _ulid: "01TASK00000000000000000002",
        slugs: ["task-plan-ref"],
        plan_ref: "@plan-one",
        status: "completed",
      },
      {
        _ulid: "01TASK00000000000000000003",
        slugs: ["task-overlap"],
        plan_ref: "@01PLAN00000000000000000001",
        status: "pending",
      },
      {
        _ulid: "01TASK00000000000000000004",
        slugs: ["task-other-plan"],
        plan_ref: "@plan-two",
        status: "blocked",
      },
      {
        _ulid: "01TASK00000000000000000005",
        slugs: ["task-cancelled"],
        plan_ref: "@plan-one",
        status: "cancelled",
      },
    ];

    const linkedTasks = getLinkedPlanSummaryTasks(plan, tasks);

    expect(linkedTasks.map((task) => task.slugs[0])).toEqual([
      "task-derived",
      "task-plan-ref",
      "task-overlap",
      "task-cancelled",
    ]);
    expect(linkedTasks.filter((task) => isCountedInPlanSummary(task))).toHaveLength(3);
    expect(countPlanTaskProgress(linkedTasks)).toEqual({
      total: 3,
      completed: 1,
      in_progress: 1,
      pending: 1,
      blocked: 0,
    });
  });
});
