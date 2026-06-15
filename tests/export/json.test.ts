/**
 * JSON Export Tests
 *
 * AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5, ac-7
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { calculateExportStats, formatBytes, generateJsonSnapshot } from "../../src/export/index.js";
import { setupTempFixtures, cleanupTempDir, seedSplitTask, testUlid } from "../helpers/cli.js";
import { ensureSplitBackendRegistered } from "../../src/parser/split-backend.js";

ensureSplitBackendRegistered();

// A task linked to the nested `@test-feature` spec item so the breadcrumb
// ancestor chain has a real multi-segment path (module → feature → task) to
// assert against. The base fixture's tasks carry no spec_ref.
const BREADCRUMB_TASK_ULID = testUlid("bcb");

describe("JSON Export", () => {
  let tempDir: string;
  let originalCwd: string;
  const e2eFixtureDir = path.resolve(process.cwd(), "tests", "e2e", "fixtures");

  beforeAll(async () => {
    originalCwd = process.cwd();
    tempDir = await setupTempFixtures();
    await fs.copyFile(
      path.join(e2eFixtureDir, "project.plans.yaml"),
      path.join(tempDir, "project.plans.yaml"),
    );
    await fs.copyFile(
      path.join(e2eFixtureDir, "project.triage.yaml"),
      path.join(tempDir, "project.triage.yaml"),
    );
    // Seed a task whose spec_ref points at the nested feature so the export
    // bakes a multi-segment breadcrumb chain (@ui-breadcrumb ac-10).
    seedSplitTask(tempDir, {
      _ulid: BREADCRUMB_TASK_ULID,
      slugs: ["task-breadcrumb-fixture"],
      title: "Breadcrumb fixture task",
      type: "task",
      status: "pending",
      priority: 2,
      spec_ref: "@test-feature",
      depends_on: [],
      created_at: "2026-01-01T00:00:00Z",
    });
    process.chdir(tempDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
  });

  // AC: @gh-pages-export ac-1
  describe("generateJsonSnapshot", () => {
    it("generates snapshot with all data types", async () => {
      const snapshot = await generateJsonSnapshot();

      // Verify structure
      expect(snapshot).toHaveProperty("version");
      expect(snapshot).toHaveProperty("exported_at");
      expect(snapshot).toHaveProperty("project");
      expect(snapshot).toHaveProperty("tasks");
      expect(snapshot).toHaveProperty("items");
      expect(snapshot).toHaveProperty("inbox");
      expect(snapshot).toHaveProperty("plans");
      expect(snapshot).toHaveProperty("triage");
      expect(snapshot).toHaveProperty("alignment");
      expect(snapshot).toHaveProperty("observations");
      expect(snapshot).toHaveProperty("agents");
      expect(snapshot).toHaveProperty("workflows");
      expect(snapshot).toHaveProperty("conventions");

      // Verify arrays
      expect(Array.isArray(snapshot.tasks)).toBe(true);
      expect(Array.isArray(snapshot.items)).toBe(true);
      expect(Array.isArray(snapshot.inbox)).toBe(true);
      expect(Array.isArray(snapshot.plans)).toBe(true);
      expect(Array.isArray(snapshot.triage)).toBe(true);
    });

    // AC: @gh-pages-export ac-2
    it("includes metadata with timestamp and version", async () => {
      const snapshot = await generateJsonSnapshot();

      // Version should be a string
      expect(typeof snapshot.version).toBe("string");

      // Timestamp should be valid ISO 8601
      expect(snapshot.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);

      // Project metadata
      expect(snapshot.project).toHaveProperty("name");
      expect(typeof snapshot.project.name).toBe("string");
    });

    // AC: @gh-pages-export ac-3
    it("resolves spec_ref titles in tasks", async () => {
      const snapshot = await generateJsonSnapshot();

      // Find tasks with spec_ref
      const tasksWithSpecRef = snapshot.tasks.filter((t) => t.spec_ref);

      // If there are tasks with spec refs, they should have resolved titles
      for (const task of tasksWithSpecRef) {
        // spec_ref_title should be present for resolved refs
        // (might be undefined if the ref doesn't resolve)
        if (task.spec_ref_title) {
          expect(typeof task.spec_ref_title).toBe("string");
        }
      }
    });

    // AC: @ui-breadcrumb ac-10
    it("bakes a server-resolved breadcrumb ancestor chain into every item", async () => {
      const snapshot = await generateJsonSnapshot();
      expect(snapshot.items.length).toBeGreaterThan(0);

      for (const item of snapshot.items) {
        expect(Array.isArray(item.ancestors)).toBe(true);
        // The chain is root-to-self: the last segment is the item itself.
        const last = item.ancestors!.at(-1)!;
        expect(last.ref).toBe(item._ulid);
        expect(last.kind).toBe(item.type);
        for (const segment of item.ancestors!) {
          expect(typeof segment.ref).toBe("string");
          expect("title" in segment).toBe(true);
          expect(typeof segment.kind).toBe("string");
        }
      }

      // The fixture nests features/requirements under a module, so at least one
      // item must carry a multi-segment chain (proving the parent walk runs).
      const nested = snapshot.items.find((i) => (i.ancestors?.length ?? 0) > 1);
      expect(nested).toBeDefined();
    });

    // AC: @ui-breadcrumb ac-10
    it("bakes a task's chain as its spec_ref chain plus the task", async () => {
      const snapshot = await generateJsonSnapshot();
      const task = snapshot.tasks.find((t) => t.spec_ref && (t.ancestors?.length ?? 0) > 1);
      expect(task).toBeDefined();
      const chain = task!.ancestors!;
      // Last segment is the task itself.
      expect(chain.at(-1)).toEqual({
        ref: task!._ulid,
        title: task!.title ?? null,
        kind: "task",
      });
      // The segment before the task resolves the linked spec item.
      expect(chain.length).toBeGreaterThanOrEqual(2);
      expect(chain.at(-2)!.kind).not.toBe("task");
    });

    // AC: @ui-breadcrumb ac-10
    it("bakes a plan's chain ending in the plan segment", async () => {
      const snapshot = await generateJsonSnapshot();
      expect((snapshot.plans ?? []).length).toBeGreaterThan(0);
      for (const plan of snapshot.plans ?? []) {
        const chain = plan.ancestors!;
        expect(Array.isArray(chain)).toBe(true);
        expect(chain.at(-1)).toEqual({
          ref: plan._ulid,
          title: plan.title ?? null,
          kind: "plan",
        });
      }
    });

    // AC: @gh-pages-export ac-4
    it("expands items with inherited ACs from traits", async () => {
      const snapshot = await generateJsonSnapshot();

      // Check if any items have inherited_acs
      const itemsWithInheritedACs = snapshot.items.filter(
        (i) => i.inherited_acs && i.inherited_acs.length > 0,
      );

      // If there are items with inherited ACs, verify structure
      for (const item of itemsWithInheritedACs) {
        for (const ac of item.inherited_acs!) {
          expect(ac).toHaveProperty("id");
          expect(ac).toHaveProperty("given");
          expect(ac).toHaveProperty("when");
          expect(ac).toHaveProperty("then");
          expect(ac).toHaveProperty("_inherited_from");
          expect(ac._inherited_from).toMatch(/^@/);
        }
      }
    });

    // AC: @gh-pages-export ac-5
    it("includes validation when requested", async () => {
      const snapshot = await generateJsonSnapshot(true);

      expect(snapshot.validation).toBeDefined();
      expect(snapshot.validation).toHaveProperty("valid");
      expect(snapshot.validation).toHaveProperty("errorCount");
      expect(snapshot.validation).toHaveProperty("warningCount");
      expect(snapshot.validation).toHaveProperty("schemaErrors");
      expect(snapshot.validation).toHaveProperty("refErrors");
      expect(snapshot.validation).toHaveProperty("refWarnings");
      expect(snapshot.validation).toHaveProperty("orphans");
      expect(snapshot.validation).toHaveProperty("completenessWarnings");
      expect(snapshot.validation).toHaveProperty("traitCycles");
      expect(snapshot.validation).toHaveProperty("errors");
      expect(snapshot.validation).toHaveProperty("warnings");
      expect(Array.isArray(snapshot.validation!.errors)).toBe(true);
      expect(Array.isArray(snapshot.validation!.warnings)).toBe(true);
    });

    // AC: @gh-pages-export ac-21
    it("includes detailed alignment data for the validate view", async () => {
      const snapshot = await generateJsonSnapshot(true);

      expect(snapshot.alignment).toBeDefined();
      expect(snapshot.alignment).toHaveProperty("stats");
      expect(snapshot.alignment).toHaveProperty("warnings");
      expect(snapshot.alignment?.stats).toHaveProperty("totalSpecs");
      expect(snapshot.alignment?.stats).toHaveProperty("specsWithTasks");
      expect(snapshot.alignment?.stats).toHaveProperty("alignedSpecs");
      expect(snapshot.alignment?.stats).toHaveProperty("orphanedSpecs");
      expect(Array.isArray(snapshot.alignment?.warnings)).toBe(true);
    });

    // AC: @gh-pages-export ac-23
    it("includes plans and triage data needed by static plans and triage views", async () => {
      const snapshot = await generateJsonSnapshot();

      expect(snapshot.plans?.length).toBeGreaterThan(0);
      expect(Array.isArray(snapshot.triage)).toBe(true);
      expect(snapshot.plans?.[0]).toHaveProperty("content");
      expect(snapshot.plans?.[0]).toHaveProperty("task_progress");
      expect(snapshot.plans?.[0]).toHaveProperty("spec_count");
      expect(snapshot.plans?.[0]).toHaveProperty("task_count");
    });

    // AC: @01KM46FW ac-1
    it("excludes cancelled tasks while preserving plan_ref-linked export metrics", async () => {
      await fs.writeFile(
        path.join(tempDir, "project.plans.yaml"),
        `kynetic_plans: "1.0"
plans:
  - _ulid: 01KG0RRPCA45ZT43W2T6HJMVP1
    slugs:
      - test-plan-active
    title: Active Implementation Plan
    content: |
      # Active Plan
    status: active
    derived_tasks: []
    derived_specs: []
    source_path: null
    created_at: "2026-01-15T10:00:00Z"
    approved_at: "2026-01-16T12:00:00Z"
    completed_at: null
    notes: []
`,
      );

      // Clear existing tasks and write fresh split-format data
      // Remove existing tasks directory
      await fs.rm(path.join(tempDir, "tasks"), { recursive: true, force: true });
      await fs.writeFile(path.join(tempDir, "project.tasks.yaml"), "");

      seedSplitTask(tempDir, {
        _ulid: "01KG0RR8CB8N4YGP991WD7XS9R",
        slugs: ["test-task-in-progress"],
        title: "In progress task",
        type: "task",
        status: "in_progress",
        priority: 3,
        plan_ref: "@01KG0RRP",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00Z",
      });

      seedSplitTask(tempDir, {
        _ulid: "01KG0RRFCC9N4YGP991WD7XSCP",
        slugs: ["test-task-completed"],
        title: "Completed task",
        type: "task",
        status: "completed",
        priority: 3,
        plan_ref: "@01KG0RRPCA45ZT43W2T6HJMVP1",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00Z",
      });

      seedSplitTask(tempDir, {
        _ulid: "01KG0RR6CA45ZT43W2T6HJMVA1",
        slugs: ["test-task-ready"],
        title: "Ready task",
        type: "task",
        status: "pending",
        priority: 2,
        plan_ref: "@01KG0RRP",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00Z",
      });

      seedSplitTask(tempDir, {
        _ulid: "01KG0RRJCC9N4YGP991WD7XSM1",
        slugs: ["test-task-cancelled"],
        title: "Cancelled task",
        type: "task",
        status: "cancelled",
        priority: 2,
        plan_ref: "@01KG0RRP",
        tags: ["test"],
        description: "A cancelled task linked to the active plan",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00Z",
      });

      const snapshot = await generateJsonSnapshot();
      const activePlan = snapshot.plans?.find((plan) => plan.slugs.includes("test-plan-active"));

      expect(activePlan).toMatchObject({
        task_count: 3,
        task_progress: {
          total: 3,
          completed: 1,
          in_progress: 1,
          pending: 1,
          blocked: 0,
        },
      });
    });

    it("excludes validation by default", async () => {
      const snapshot = await generateJsonSnapshot(false);
      expect(snapshot.validation).toBeUndefined();
    });
  });

  // AC: @gh-pages-export ac-7
  describe("calculateExportStats", () => {
    it("calculates correct statistics", async () => {
      const snapshot = await generateJsonSnapshot();
      const stats = calculateExportStats(snapshot);

      expect(stats.taskCount).toBe(snapshot.tasks.length);
      expect(stats.itemCount).toBe(snapshot.items.length);
      expect(stats.inboxCount).toBe(snapshot.inbox.length);
      expect(stats.planCount).toBe(snapshot.plans?.length ?? 0);
      expect(stats.triageCount).toBe(snapshot.triage?.length ?? 0);
      expect(stats.observationCount).toBe(snapshot.observations.length);
      expect(stats.agentCount).toBe(snapshot.agents.length);
      expect(stats.workflowCount).toBe(snapshot.workflows.length);
      expect(stats.conventionCount).toBe(snapshot.conventions.length);
      expect(stats.estimatedSizeBytes).toBeGreaterThan(0);
    });
  });

  describe("formatBytes", () => {
    it("formats bytes correctly", () => {
      expect(formatBytes(500)).toBe("500 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1048576)).toBe("1.0 MB");
      expect(formatBytes(1572864)).toBe("1.5 MB");
    });
  });
});
