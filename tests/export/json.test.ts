/**
 * JSON Export Tests
 *
 * AC: @gh-pages-export ac-1, ac-2, ac-3, ac-4, ac-5, ac-7
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  calculateExportStats,
  formatBytes,
  generateJsonSnapshot,
  type KspecSnapshot,
} from "../../src/export/index.js";
import { setupTempFixtures, cleanupTempDir } from "../helpers/cli.js";

describe("JSON Export", () => {
  let tempDir: string;
  let originalCwd: string;
  const webUiFixtureDir = path.resolve(
    process.cwd(),
    "packages",
    "web-ui",
    "tests",
    "fixtures"
  );

  beforeAll(async () => {
    originalCwd = process.cwd();
    tempDir = await setupTempFixtures();
    await fs.copyFile(
      path.join(webUiFixtureDir, "project.plans.yaml"),
      path.join(tempDir, "project.plans.yaml")
    );
    await fs.copyFile(
      path.join(webUiFixtureDir, "project.triage.yaml"),
      path.join(tempDir, "project.triage.yaml")
    );
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
      expect(snapshot.exported_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/
      );

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

    // AC: @gh-pages-export ac-4
    it("expands items with inherited ACs from traits", async () => {
      const snapshot = await generateJsonSnapshot();

      // Check if any items have inherited_acs
      const itemsWithInheritedACs = snapshot.items.filter(
        (i) => i.inherited_acs && i.inherited_acs.length > 0
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
      await fs.writeFile(
        path.join(tempDir, "project.tasks.yaml"),
        `tasks:
  - _ulid: 01KG0RR8CB8N4YGP991WD7XS9R
    slugs:
      - test-task-in-progress
    title: In progress task
    type: task
    status: in_progress
    priority: 3
    plan_ref: "@test-plan-active"
    depends_on: []
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: 01KG0RRFCC9N4YGP991WD7XSCP
    slugs:
      - test-task-completed
    title: Completed task
    type: task
    status: completed
    priority: 3
    plan_ref: "@01KG0RRPCA45ZT43W2T6HJMVP1"
    depends_on: []
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: 01KG0RR6CA45ZT43W2T6HJMVA1
    slugs:
      - test-task-ready
    title: Ready task
    type: task
    status: pending
    priority: 2
    plan_ref: "@test-plan-active"
    depends_on: []
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
  - _ulid: 01KG0RRJCC9N4YGP991WD7XSM1
    slugs:
      - test-task-cancelled
    title: Cancelled task
    type: task
    status: cancelled
    priority: 2
    plan_ref: "@test-plan-active"
    tags:
      - test
    description: A cancelled task linked to the active plan
    depends_on: []
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
`
      );

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
