/**
 * CLI Plan Commands Tests
 * AC: @plan-crud ac-1, ac-2, ac-3, ac-4, ac-7, ac-8, ac-9, ac-30, ac-31
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
} from "./helpers/cli";

describe("Integration: plan commands", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("plan add", () => {
    // AC: @plan-crud ac-1
    it("should create a plan with content", () => {
      const output = kspec(
        'plan add --title "User Auth Plan" --content "Implement JWT authentication"',
        tempDir,
      );
      expect(output).toContain("Created plan:");
      expect(output).toContain("User Auth Plan");

      // Verify plan was saved
      const plans = kspecJson<Array<{ title: string }>>(
        "plan list --json",
        tempDir,
      );
      expect(plans).toHaveLength(1);
      expect(plans[0].title).toBe("User Auth Plan");
    });

    // AC: @plan-crud ac-2
    it("should read content from file with --content-file", async () => {
      const contentPath = path.join(tempDir, "test-plan.md");
      await fs.writeFile(contentPath, "# Plan Content\n\nDetailed steps...");

      const output = kspec(
        `plan add --title "File Plan" --content-file "${contentPath}"`,
        tempDir,
      );
      expect(output).toContain("Created plan:");

      const plan = kspecJson<{ content: string }>(
        "plan get @01 --json",
        tempDir,
      );
      expect(plan.content).toContain("# Plan Content");
      expect(plan.content).toContain("Detailed steps...");
    });

    // AC: @plan-crud ac-1 - default status is draft
    it("should create plan with default draft status", () => {
      kspec('plan add --title "Draft Plan" --content "Draft content"', tempDir);

      const plan = kspecJson<{ status: string }>(
        "plan get @01 --json",
        tempDir,
      );
      expect(plan.status).toBe("draft");
    });

    it("should support custom status", () => {
      kspec(
        'plan add --title "Approved Plan" --content "Content" --status approved',
        tempDir,
      );

      const plan = kspecJson<{ status: string }>(
        "plan get @01 --json",
        tempDir,
      );
      expect(plan.status).toBe("approved");
    });

    it("should support custom slug", () => {
      const output = kspec(
        'plan add --title "Slugged Plan" --content "Content" --slug my-plan',
        tempDir,
      );
      expect(output).toContain("Created plan:");

      // Should be able to reference by slug
      const plan = kspecJson<{ slugs: string[] }>(
        "plan get @my-plan --json",
        tempDir,
      );
      expect(plan.slugs).toContain("my-plan");
    });

    it("should error when both --content and --content-file are provided", () => {
      const result = kspecRun(
        'plan add --title "Bad" --content "text" --content-file ./file.md',
        tempDir,
        { expectFail: true },
      );
      expect(result.stderr).toContain(
        "Cannot specify both --content and --content-file",
      );
      expect(result.exitCode).toBe(2); // EXIT_CODES.USAGE_ERROR
    });

    // Auto-namespace plan slugs
    it("should auto-generate slug with plan- prefix when no slug provided", () => {
      kspec('plan add --title "My Feature" --content "Content"', tempDir);

      const plan = kspecJson<{ slugs: string[] }>(
        "plan get @plan-my-feature --json",
        tempDir,
      );
      expect(plan.slugs).toContain("plan-my-feature");
    });

    it("should use provided slug as-is (no auto-prefix)", () => {
      kspec(
        'plan add --title "Another Feature" --content "Content" --slug custom-slug',
        tempDir,
      );

      const plan = kspecJson<{ slugs: string[] }>(
        "plan get @custom-slug --json",
        tempDir,
      );
      expect(plan.slugs).toContain("custom-slug");
      expect(plan.slugs).not.toContain("plan-custom-slug");
    });

    it("should error when provided slug collides with existing item", async () => {
      // The fixtures should have a spec item - let's check
      const itemsOutput = kspec("item list --json", tempDir);
      const parsed = JSON.parse(itemsOutput) as { items: Array<{ slugs: string[] }> };

      // Find an existing slug from spec items
      const existingSlug =
        parsed.items.flatMap((i) => i.slugs).find((s) => s) || "test-module";

      const result = kspecRun(
        `plan add --title "Collision Test" --content "Content" --slug ${existingSlug}`,
        tempDir,
        { expectFail: true },
      );

      expect(result.stderr).toContain("collides with existing item");
      expect(result.exitCode).toBe(5); // EXIT_CODES.CONFLICT
    });

    it("should error when provided slug collides with existing plan", () => {
      // Create first plan with custom slug
      kspec('plan add --title "First Plan" --content "Content" --slug my-custom-slug', tempDir);

      // Try to create second plan with same slug
      const result = kspecRun(
        'plan add --title "Second Plan" --content "Content" --slug my-custom-slug',
        tempDir,
        { expectFail: true },
      );

      expect(result.stderr).toContain("collides with existing plan");
      expect(result.exitCode).toBe(5); // EXIT_CODES.CONFLICT
    });

    it("should auto-generate unique slug when same title is used twice", () => {
      // Create two plans with the same title
      kspec('plan add --title "Duplicate Title" --content "First"', tempDir);
      kspec('plan add --title "Duplicate Title" --content "Second"', tempDir);

      // Both should be retrievable with different slugs
      const plan1 = kspecJson<{ title: string; slugs: string[] }>(
        "plan get @plan-duplicate-title --json",
        tempDir,
      );
      expect(plan1.slugs).toContain("plan-duplicate-title");

      const plan2 = kspecJson<{ title: string; slugs: string[] }>(
        "plan get @plan-duplicate-title-1 --json",
        tempDir,
      );
      expect(plan2.slugs).toContain("plan-duplicate-title-1");
    });
  });

  describe("plan get", () => {
    beforeEach(() => {
      // Create test plans
      kspec(
        'plan add --title "Test Plan" --content "# Implementation\n\nSteps..." --slug test-plan',
        tempDir,
      );
    });

    // AC: @plan-crud ac-8
    it("should display full plan details", () => {
      const output = kspec("plan get @test-plan", tempDir);

      expect(output).toContain("ULID:");
      expect(output).toContain("Title:    Test Plan");
      expect(output).toContain("Status:   draft");
      expect(output).toContain("Created:");
      expect(output).toContain("─── Content ───");
      expect(output).toContain("# Implementation");
      expect(output).toContain("Steps...");
    });

    // AC: @plan-crud ac-30
    it("should output valid JSON with --json", () => {
      const plan = kspecJson<{
        _ulid: string;
        title: string;
        content: string;
        status: string;
        derived_tasks: string[];
        created_at: string;
      }>("plan get @test-plan --json", tempDir);

      expect(plan._ulid).toBeDefined();
      expect(plan.title).toBe("Test Plan");
      expect(plan.content).toContain("# Implementation");
      expect(plan.status).toBe("draft");
      expect(plan.derived_tasks).toEqual([]);
      expect(plan.created_at).toBeDefined();
    });

    it("should resolve by ULID prefix", () => {
      const list = kspecJson<Array<{ _ulid: string }>>(
        "plan list --json",
        tempDir,
      );
      const ulid = list[0]._ulid;
      const prefix = ulid.slice(0, 6);

      const output = kspec(`plan get @${prefix}`, tempDir);
      expect(output).toContain("Test Plan");
    });

    it("should error when plan not found", () => {
      const result = kspecRun("plan get @nonexistent", tempDir, {
        expectFail: true,
      });
      expect(result.stderr).toContain("Plan not found");
      expect(result.exitCode).toBe(3); // EXIT_CODES.NOT_FOUND
    });
  });

  describe("plan set", () => {
    beforeEach(() => {
      kspec('plan add --title "Original Title" --content "Content"', tempDir);
    });

    it("should update title", () => {
      const output = kspec('plan set @01 --title "New Title"', tempDir);
      expect(output).toContain("Updated plan:");

      const plan = kspecJson<{ title: string }>("plan get @01 --json", tempDir);
      expect(plan.title).toBe("New Title");
    });

    // AC: @plan-crud ac-3
    it("should update status and set approved_at when transitioning to approved", () => {
      const beforePlan = kspecJson<{ approved_at: string | null }>(
        "plan get @01 --json",
        tempDir,
      );
      expect(beforePlan.approved_at).toBeNull();

      kspec("plan set @01 --status approved", tempDir);

      const afterPlan = kspecJson<{ status: string; approved_at: string | null }>(
        "plan get @01 --json",
        tempDir,
      );
      expect(afterPlan.status).toBe("approved");
      expect(afterPlan.approved_at).toBeDefined();
      expect(afterPlan.approved_at).not.toBeNull();
    });

    // AC: @plan-crud ac-4
    it("should prevent transitions from completed status", () => {
      // Move to completed
      kspec("plan set @01 --status completed", tempDir);

      // Try to change status
      const result = kspecRun("plan set @01 --status draft", tempDir, {
        expectFail: true,
      });
      expect(result.stderr).toContain("Cannot transition from terminal status");
      expect(result.exitCode).toBe(5);
    });

    // AC: @plan-crud ac-4
    it("should prevent transitions from rejected status", () => {
      // Move to rejected
      kspec("plan set @01 --status rejected", tempDir);

      // Try to change status
      const result = kspecRun("plan set @01 --status approved", tempDir, {
        expectFail: true,
      });
      expect(result.stderr).toContain("Cannot transition from terminal status");
      expect(result.exitCode).toBe(5);
    });

    it("should add slug", () => {
      kspec("plan set @01 --slug new-slug", tempDir);

      const plan = kspecJson<{ slugs: string[] }>("plan get @01 --json", tempDir);
      expect(plan.slugs).toContain("new-slug");

      // Should be reachable by new slug
      const output = kspec("plan get @new-slug", tempDir);
      expect(output).toContain("Original Title");
    });

    it("should not duplicate slug if already present", () => {
      kspec("plan set @01 --slug existing-slug", tempDir);
      kspec("plan set @01 --slug existing-slug", tempDir);

      const plan = kspecJson<{ slugs: string[] }>("plan get @01 --json", tempDir);
      expect(plan.slugs.filter((s) => s === "existing-slug")).toHaveLength(1);
    });

    // Slug collision detection for plan set --slug
    it("should error when adding slug that collides with existing item", () => {
      // Get an existing spec item slug from fixtures
      const itemsOutput = kspec("item list --json", tempDir);
      const parsed = JSON.parse(itemsOutput) as { items: Array<{ slugs: string[] }> };
      const existingSlug =
        parsed.items.flatMap((i) => i.slugs).find((s) => s) || "test-module";

      const result = kspecRun(
        `plan set @01 --slug ${existingSlug}`,
        tempDir,
        { expectFail: true },
      );

      expect(result.stderr).toContain("collides with existing item");
      expect(result.exitCode).toBe(5); // EXIT_CODES.CONFLICT
    });

    it("should error when adding slug that collides with existing plan", () => {
      // Create another plan with a known slug
      kspec('plan add --title "Other Plan" --content "Content" --slug other-plan-slug', tempDir);

      // Try to add that slug to the first plan
      const result = kspecRun(
        "plan set @01 --slug other-plan-slug",
        tempDir,
        { expectFail: true },
      );

      expect(result.stderr).toContain("collides with existing plan");
      expect(result.exitCode).toBe(5); // EXIT_CODES.CONFLICT
    });
  });

  describe("plan list", () => {
    beforeEach(() => {
      // Create multiple plans
      kspec('plan add --title "Draft Plan" --content "Draft"', tempDir);
      kspec(
        'plan add --title "Approved Plan" --content "Approved" --status approved',
        tempDir,
      );
      kspec(
        'plan add --title "Completed Plan" --content "Done" --status completed',
        tempDir,
      );
    });

    // AC: @plan-crud ac-7
    it("should list all plans", () => {
      const output = kspec("plan list", tempDir);

      expect(output).toContain("Plans (3)");
      expect(output).toContain("Draft Plan");
      expect(output).toContain("Approved Plan");
      expect(output).toContain("Completed Plan");
      expect(output).toContain("[draft]");
      expect(output).toContain("[approved]");
      expect(output).toContain("[completed]");
    });

    // AC: @plan-crud ac-7 - status filter
    it("should filter by status", () => {
      const output = kspec("plan list --status draft", tempDir);

      expect(output).toContain("Plans (1)");
      expect(output).toContain("Draft Plan");
      expect(output).not.toContain("Approved Plan");
      expect(output).not.toContain("Completed Plan");
    });

    // AC: @plan-crud ac-31
    it("should output JSON array with --json", () => {
      const plans = kspecJson<
        Array<{
          _ulid: string;
          title: string;
          status: string;
          created_at: string;
        }>
      >("plan list --json", tempDir);

      expect(Array.isArray(plans)).toBe(true);
      expect(plans).toHaveLength(3);
      expect(plans[0]._ulid).toBeDefined();
      expect(plans[0].title).toBeDefined();
      expect(plans[0].status).toBeDefined();
      expect(plans[0].created_at).toBeDefined();
    });

    it("should show empty message when no plans", async () => {
      // Start fresh with a new temp directory
      const emptyTempDir = await setupTempFixtures();

      // Delete the plans file if it exists
      const plansPath = path.join(emptyTempDir, ".kspec", "project.plans.yaml");
      try {
        await fs.unlink(plansPath);
      } catch {
        // File might not exist, that's fine
      }

      const output = kspec("plan list", emptyTempDir);
      expect(output).toContain("No plans found");

      await cleanupTempDir(emptyTempDir);
    });
  });

  describe("plan note", () => {
    beforeEach(() => {
      kspec('plan add --title "Plan with Notes" --content "Content"', tempDir);
    });

    // AC: @plan-crud ac-9
    it("should add note with ULID, timestamp, and author", () => {
      const output = kspec('plan note @01 "First progress note"', tempDir);
      expect(output).toContain("Added note to plan:");

      const plan = kspecJson<{
        notes: Array<{
          _ulid: string;
          created_at: string;
          author: string;
          content: string;
        }>;
      }>("plan get @01 --json", tempDir);

      expect(plan.notes).toHaveLength(1);
      expect(plan.notes[0]._ulid).toBeDefined();
      expect(plan.notes[0].created_at).toBeDefined();
      expect(plan.notes[0].author).toBeDefined();
      expect(plan.notes[0].content).toBe("First progress note");
    });

    it("should append multiple notes", () => {
      kspec('plan note @01 "Note 1"', tempDir);
      kspec('plan note @01 "Note 2"', tempDir);
      kspec('plan note @01 "Note 3"', tempDir);

      const plan = kspecJson<{ notes: Array<{ content: string }> }>(
        "plan get @01 --json",
        tempDir,
      );

      expect(plan.notes).toHaveLength(3);
      expect(plan.notes[0].content).toBe("Note 1");
      expect(plan.notes[1].content).toBe("Note 2");
      expect(plan.notes[2].content).toBe("Note 3");
    });

    it("should display notes in plan get output", () => {
      kspec('plan note @01 "Progress update"', tempDir);

      const output = kspec("plan get @01", tempDir);
      expect(output).toContain("─── Notes ───");
      expect(output).toContain("Progress update");
    });
  });

  describe("plan derive", () => {
    // AC: @plan-derive ac-5
    it("should create a task from an approved plan", () => {
      kspec(
        'plan add --title "Auth Feature" --content "Implementation plan" --status approved',
        tempDir,
      );

      const output = kspec("plan derive @01", tempDir);
      expect(output).toContain("Created task from plan:");
      expect(output).toContain("@implement-auth-feature");

      // Verify task was created with plan_ref (auto-namespaced slug)
      const task = kspecJson<{ plan_ref: string; title: string }>(
        "task get @implement-auth-feature --json",
        tempDir,
      );
      expect(task.plan_ref).toBe("@plan-auth-feature");  // Auto-namespaced plan slug
      expect(task.title).toBe("Implement: Auth Feature");
    });

    // AC: @plan-derive ac-5
    it("should create a task from an active plan", () => {
      kspec(
        'plan add --title "Active Plan" --content "Plan" --status active',
        tempDir,
      );

      const output = kspec("plan derive @01", tempDir);
      expect(output).toContain("Created task from plan:");
    });

    // AC: @plan-derive ac-5
    it("should update plan's derived_tasks array", () => {
      kspec(
        'plan add --title "Feature Plan" --content "Plan" --status approved',
        tempDir,
      );

      kspec("plan derive @01", tempDir);

      const plan = kspecJson<{ derived_tasks: string[] }>(
        "plan get @01 --json",
        tempDir,
      );
      expect(plan.derived_tasks).toHaveLength(1);
      expect(plan.derived_tasks[0]).toMatch(/@implement-feature-plan/);
    });

    // AC: @plan-derive ac-5
    it("should transition approved plan to active", () => {
      kspec(
        'plan add --title "Approval Test" --content "Plan" --status approved',
        tempDir,
      );

      kspec("plan derive @01", tempDir);

      const plan = kspecJson<{ status: string }>("plan get @01 --json", tempDir);
      expect(plan.status).toBe("active");
    });

    // AC: @plan-derive ac-5
    it("should not change status if plan is already active", () => {
      kspec(
        'plan add --title "Already Active" --content "Plan" --status active',
        tempDir,
      );

      kspec("plan derive @01", tempDir);

      const plan = kspecJson<{ status: string }>("plan get @01 --json", tempDir);
      expect(plan.status).toBe("active");
    });

    // AC: @plan-derive ac-5
    it("should fail for draft plan", () => {
      kspec('plan add --title "Draft Plan" --content "Plan"', tempDir);

      const result = kspecRun("plan derive @01", tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2);  // USAGE_ERROR
      const output = result.stdout + result.stderr;
      expect(output).toContain(
        "Plan must be in 'approved' or 'active' status",
      );
    });

    // AC: @plan-derive ac-5
    it("should support custom title with --title flag", () => {
      kspec(
        'plan add --title "Custom Title Test" --content "Plan" --status approved',
        tempDir,
      );

      const output = kspec("plan derive @01 --title 'My Custom Task'", tempDir);
      expect(output).toContain("Created task from plan:");

      const task = kspecJson<{ title: string }>(
        "task get @my-custom-task --json",
        tempDir,
      );
      expect(task.title).toBe("My Custom Task");
    });

    // AC: @plan-derive ac-5
    it("should support custom priority with --priority flag", () => {
      kspec(
        'plan add --title "Priority Test" --content "Plan" --status approved',
        tempDir,
      );

      kspec("plan derive @01 --priority 1", tempDir);

      const task = kspecJson<{ priority: number }>(
        "task get @implement-priority-test --json",
        tempDir,
      );
      expect(task.priority).toBe(1);
    });

    // AC: @plan-derive ac-6
    it("should display plan_ref in task get output", () => {
      kspec(
        'plan add --title "Display Test" --content "Plan" --status approved',
        tempDir,
      );
      kspec("plan derive @01", tempDir);

      const output = kspec("task get @implement-display-test", tempDir);
      expect(output).toContain("Plan ref:");
      expect(output).toContain("@plan-display-test");  // Auto-namespaced plan slug
    });

    // AC: @plan-derive ac-6
    it("should display derived_tasks in plan get output", () => {
      kspec(
        'plan add --title "Derived Test" --content "Plan" --status approved',
        tempDir,
      );
      kspec("plan derive @01", tempDir);

      const output = kspec("plan get @01", tempDir);
      expect(output).toContain("Derived Work:");
      expect(output).toContain("Tasks:");
      expect(output).toContain("@implement-derived-test");
    });

    it("should generate unique slugs when derived multiple times", () => {
      kspec('plan add --title "Same Title" --content "Plan" --status approved', tempDir);

      // First derive
      kspec("plan derive @01", tempDir);

      // Manually create second task with same base slug
      kspec('task add --title "Implement: Same Title" --slug implement-same-title-1', tempDir);

      // Second derive should generate unique slug
      kspec("plan derive @01", tempDir);

      const plan = kspecJson<{ derived_tasks: string[] }>(
        "plan get @01 --json",
        tempDir,
      );
      expect(plan.derived_tasks).toHaveLength(2);

      // Check all three tasks exist with unique slugs
      const tasks = kspecJson<Array<{ slugs: string[] }>>(
        "task list --json",
        tempDir,
      );
      const slugs = tasks.flatMap((t) => t.slugs);
      expect(slugs).toContain("implement-same-title");
      expect(slugs).toContain("implement-same-title-1");
      expect(slugs).toContain("implement-same-title-2");
    });

    it("should work with plan slug reference", () => {
      kspec(
        'plan add --title "Slug Test" --content "Plan" --status approved --slug my-feature',
        tempDir,
      );

      const output = kspec("plan derive @my-feature", tempDir);
      expect(output).toContain("Created task from plan:");

      const task = kspecJson<{ plan_ref: string }>(
        "task get @implement-slug-test --json",
        tempDir,
      );
      expect(task.plan_ref).toBe("@my-feature");
    });
  });
});
