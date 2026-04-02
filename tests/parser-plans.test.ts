import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createPlan,
  deletePlan,
  filterPlansByStatus,
  findPlanByRef,
  getPlanStats,
  getPlansFilePath,
  loadPlans,
  savePlan,
} from "../src/parser/plans.js";
import type { PlanInput } from "../src/schema/index.js";
import { createTempDir, cleanupTempDir, initGitRepo } from "./helpers/cli.js";

describe("Plan Parser", () => {
  let tempDir: string;
  let kspecDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = path.join(tempDir, ".kspec");
    await fs.mkdir(kspecDir, { recursive: true });
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-crud ac-1
  it("should get plans file path", () => {
    const ctx = { specDir: kspecDir };
    const plansPath = getPlansFilePath(ctx as any);
    expect(plansPath).toBe(path.join(kspecDir, "project.plans.yaml"));
  });

  // AC: @plan-crud ac-1
  it("should create a new plan with defaults", () => {
    const input: PlanInput = {
      title: "Test Plan",
    };

    const plan = createPlan(input);

    expect(plan._ulid).toBeDefined();
    expect(plan._ulid).toHaveLength(26);
    expect(plan.title).toBe("Test Plan");
    expect(plan.content).toBe("");
    expect(plan.status).toBe("draft");
    expect(plan.derived_tasks).toEqual([]);
    expect(plan.derived_specs).toEqual([]);
    expect(plan.slugs).toEqual([]);
    // AC: @plan-branch-association ac-field-default
    expect(plan.branch).toBeNull();
    expect(plan.notes).toEqual([]);
    expect(plan.created_at).toBeDefined();
  });

  // AC: @plan-crud ac-1, ac-2
  it("should create plan with content", () => {
    const input: PlanInput = {
      title: "Auth Redesign",
      content: "# Plan\n\nDetailed auth redesign...",
    };

    const plan = createPlan(input);

    expect(plan.title).toBe("Auth Redesign");
    expect(plan.content).toBe("# Plan\n\nDetailed auth redesign...");
  });

  // AC: @plan-crud ac-1
  it("should save and load a plan", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({
      title: "Test Plan",
      content: "Plan content here",
      slugs: ["test-plan"],
    });

    await savePlan(ctx as any, plan);

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]._ulid).toBe(plan._ulid);
    expect(loaded[0].title).toBe("Test Plan");
    expect(loaded[0].content).toBe("Plan content here");
    expect(loaded[0].slugs).toEqual(["test-plan"]);
    expect(loaded[0].branch).toBeNull();
  });

  // AC: @plan-branch-association ac-field-set
  it("should persist branch when explicitly set", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({
      title: "Branch Plan",
      branch: "plan/feature/01abc123",
    });

    await savePlan(ctx as any, plan);

    const loaded = await loadPlans(ctx as any);
    expect(loaded[0].branch).toBe("plan/feature/01abc123");
  });

  // AC: @plan-branch-association ac-field-clear
  it("should clear branch to null without writing branch null to yaml", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({
      title: "Branch Clear Plan",
      branch: "plan/feature/01abc123",
    });

    await savePlan(ctx as any, plan);
    plan.branch = null;
    await savePlan(ctx as any, plan);

    const loaded = await loadPlans(ctx as any);
    expect(loaded[0].branch).toBeNull();

    const fileContents = await fs.readFile(getPlansFilePath(ctx as any), "utf-8");
    expect(fileContents).not.toContain("branch: null");
  });

  // AC: @plan-branch-association ac-existing-plans-unaffected
  it("should load existing plans without branch field as null", async () => {
    const ctx = { specDir: kspecDir };
    await fs.writeFile(
      getPlansFilePath(ctx as any),
      `kynetic_plans: "1.0"
plans:
  - _ulid: 01ARZ3NDEKTSV4RRFFQ69G5FAV
    slugs:
      - legacy-plan
    title: Legacy Plan
    content: Existing content
    status: draft
    created_at: 2026-04-01T00:00:00.000Z
`,
    );

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe("Legacy Plan");
    expect(loaded[0].branch).toBeNull();
  });

  // AC: @plan-crud ac-1
  it("should update existing plan", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({ title: "Original Title" });

    await savePlan(ctx as any, plan);

    // Update plan
    plan.title = "Updated Title";
    plan.content = "New content";
    await savePlan(ctx as any, plan);

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe("Updated Title");
    expect(loaded[0].content).toBe("New content");
  });

  // AC: @plan-crud ac-8
  it("should find plan by ULID", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({ title: "Find Me" });

    await savePlan(ctx as any, plan);

    const found = await findPlanByRef(ctx as any, plan._ulid);
    expect(found).toBeDefined();
    expect(found?._ulid).toBe(plan._ulid);
    expect(found?.title).toBe("Find Me");
  });

  // AC: @plan-crud ac-8
  it("should find plan by short ULID", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({ title: "Find Me" });

    await savePlan(ctx as any, plan);

    const shortUlid = plan._ulid.substring(0, 8);
    const found = await findPlanByRef(ctx as any, shortUlid);
    expect(found).toBeDefined();
    expect(found?._ulid).toBe(plan._ulid);
  });

  // AC: @plan-crud ac-8
  it("should find plan by slug", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({
      title: "Auth Plan",
      slugs: ["auth-redesign"],
    });

    await savePlan(ctx as any, plan);

    const found = await findPlanByRef(ctx as any, "auth-redesign");
    expect(found).toBeDefined();
    expect(found?._ulid).toBe(plan._ulid);
  });

  // AC: @plan-crud ac-8
  it("should find plan with @ prefix", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({
      title: "Test",
      slugs: ["test-slug"],
    });

    await savePlan(ctx as any, plan);

    const found = await findPlanByRef(ctx as any, "@test-slug");
    expect(found).toBeDefined();
    expect(found?._ulid).toBe(plan._ulid);
  });

  it("should return undefined for non-existent plan", async () => {
    const ctx = { specDir: kspecDir };
    const found = await findPlanByRef(ctx as any, "nonexistent");
    expect(found).toBeUndefined();
  });

  it("should delete a plan", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({ title: "To Delete" });

    await savePlan(ctx as any, plan);

    let loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);

    const deleted = await deletePlan(ctx as any, plan._ulid);
    expect(deleted).toBe(true);

    loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(0);
  });

  it("should return false when deleting non-existent plan", async () => {
    const ctx = { specDir: kspecDir };
    const deleted = await deletePlan(ctx as any, "nonexistent");
    expect(deleted).toBe(false);
  });

  // AC: @plan-crud ac-7
  it("should filter plans by status", async () => {
    const ctx = { specDir: kspecDir };

    const draft1 = createPlan({ title: "Draft 1" });
    const draft2 = createPlan({ title: "Draft 2" });
    const approved = createPlan({ title: "Approved", status: "approved" });
    const active = createPlan({ title: "Active", status: "active" });

    await savePlan(ctx as any, draft1);
    await savePlan(ctx as any, draft2);
    await savePlan(ctx as any, approved);
    await savePlan(ctx as any, active);

    const plans = await loadPlans(ctx as any);

    const drafts = filterPlansByStatus(plans, "draft");
    expect(drafts).toHaveLength(2);

    const approveds = filterPlansByStatus(plans, "approved");
    expect(approveds).toHaveLength(1);

    const actives = filterPlansByStatus(plans, "active");
    expect(actives).toHaveLength(1);

    const all = filterPlansByStatus(plans);
    expect(all).toHaveLength(4);
  });

  // AC: @plan-crud ac-7
  it("should get plan statistics", async () => {
    const ctx = { specDir: kspecDir };

    await savePlan(ctx as any, createPlan({ title: "Draft 1" }));
    await savePlan(ctx as any, createPlan({ title: "Draft 2" }));
    await savePlan(ctx as any, createPlan({ title: "Approved", status: "approved" }));
    await savePlan(ctx as any, createPlan({ title: "Active", status: "active" }));

    const plans = await loadPlans(ctx as any);
    const stats = getPlanStats(plans);

    expect(stats.total).toBe(4);
    expect(stats.byStatus.draft).toBe(2);
    expect(stats.byStatus.approved).toBe(1);
    expect(stats.byStatus.active).toBe(1);
  });

  // AC: @plan-crud ac-3
  it("should handle approved_at timestamp", async () => {
    const ctx = { specDir: kspecDir };
    const approvedTime = "2025-01-14T12:00:00Z";

    const plan = createPlan({
      title: "Approved Plan",
      status: "approved",
      approved_at: approvedTime,
    });

    await savePlan(ctx as any, plan);

    const loaded = await loadPlans(ctx as any);
    expect(loaded[0].approved_at).toBe(approvedTime);
  });

  // AC: @plan-crud ac-9
  it("should preserve notes array", async () => {
    const ctx = { specDir: kspecDir };
    const plan = createPlan({
      title: "Plan with Notes",
      notes: [
        {
          _ulid: "01TESTA0000000000000000000",
          created_at: "2025-01-14T10:00:00Z",
          author: "@claude",
          content: "Initial note",
        },
      ],
    });

    await savePlan(ctx as any, plan);

    const loaded = await loadPlans(ctx as any);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].notes).toHaveLength(1);
    expect(loaded[0].notes[0].content).toBe("Initial note");
  });

  it("should return empty array when plans file doesn't exist", async () => {
    const ctx = { specDir: kspecDir };
    const plans = await loadPlans(ctx as any);
    expect(plans).toEqual([]);
  });

  it("should handle multiple plans", async () => {
    const ctx = { specDir: kspecDir };

    const plan1 = createPlan({ title: "Plan 1" });
    const plan2 = createPlan({ title: "Plan 2" });
    const plan3 = createPlan({ title: "Plan 3" });

    await savePlan(ctx as any, plan1);
    await savePlan(ctx as any, plan2);
    await savePlan(ctx as any, plan3);

    const plans = await loadPlans(ctx as any);
    expect(plans).toHaveLength(3);
    expect(plans.map((p) => p.title)).toEqual(["Plan 1", "Plan 2", "Plan 3"]);
  });
});
