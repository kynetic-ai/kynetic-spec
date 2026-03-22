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

    it("should error when provided slug collides with existing item", () => {
      // Create first plan with custom slug
      kspec('plan add --title "First Plan" --content "Content" --slug my-custom-slug', tempDir);

      // Try to create second plan with same slug
      const result = kspecRun(
        'plan add --title "Second Plan" --content "Content" --slug my-custom-slug',
        tempDir,
        { expectFail: true },
      );

      expect(result.stderr).toContain("collides with existing item");
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

    it("should reject missing title", () => {
      // --title is a required option in Commander
      const result = kspec(
        "plan add --content Content",
        tempDir,
        { expectFail: true },
      );
      // Commander itself rejects missing required options
      expect(result.exitCode).not.toBe(0);
    });

    it("should auto-increment slug when auto-generated slug collides with existing spec", () => {
      // Create a spec item with a slug that matches the auto-generated plan slug pattern
      kspec(
        'item add --under @test-core --title "Collision Test" --slug plan-collision-test',
        tempDir,
      );

      // Create a plan whose auto-generated slug would be plan-collision-test
      kspec(
        'plan add --title "Collision Test" --content "Content"',
        tempDir,
      );

      // Plan slug should have been incremented to avoid the spec collision
      const plan = kspecJson<{ slugs: string[] }>(
        "plan get @plan-collision-test-1 --json",
        tempDir,
      );
      expect(plan.slugs).toContain("plan-collision-test-1");
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

    it("should error when adding slug that collides with existing item", () => {
      // Create another plan with a known slug
      kspec('plan add --title "Other Plan" --content "Content" --slug other-plan-slug', tempDir);

      // Try to add that slug to the first plan
      const result = kspecRun(
        "plan set @01 --slug other-plan-slug",
        tempDir,
        { expectFail: true },
      );

      expect(result.stderr).toContain("collides with existing item");
      expect(result.exitCode).toBe(5); // EXIT_CODES.CONFLICT
    });
  });

  describe("plan export", () => {
    beforeEach(async () => {
      const planPath = path.join(tempDir, "export-plan.md");
      await fs.writeFile(planPath, "# Iterative Plan\n\n## Specs\n\n- export me");
      kspec(
        `plan add --title "Export Plan" --content-file "${planPath}" --slug export-plan`,
        tempDir,
      );
    });

    // AC: @plan-export ac-stdout
    // AC: @trait-semantic-exit-codes ac-1
    it("should write plan content to stdout", () => {
      const output = kspec("plan export @export-plan", tempDir);

      expect(output).toBe("# Iterative Plan\n\n## Specs\n\n- export me");
    });

    // AC: @plan-export ac-output-file
    it("should write plan content to the specified file", async () => {
      const outputPath = path.join(tempDir, "exported-plan.md");
      const output = kspec(
        `plan export @export-plan --output "${outputPath}"`,
        tempDir,
      );

      expect(output).toContain("Exported plan content");
      const fileContents = await fs.readFile(outputPath, "utf-8");
      expect(fileContents).toBe("# Iterative Plan\n\n## Specs\n\n- export me");
    });

    // AC: @trait-semantic-exit-codes ac-4
    it("should return a runtime error when writing the export file fails", () => {
      const result = kspecRun(`plan export @export-plan --output "${tempDir}"`, tempDir, {
        expectFail: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`Failed to write plan export file: ${tempDir}`);
    });

    // AC: @plan-export ac-empty
    // AC: @trait-semantic-exit-codes ac-2
    it("should fail when plan content is empty", () => {
      kspec('plan add --title "Empty Plan" --content "" --slug empty-plan', tempDir);

      const result = kspecRun("plan export @empty-plan", tempDir, {
        expectFail: true,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Plan has no content to export");
    });

    // AC: @plan-export ac-not-found
    // AC: @trait-json-output ac-3
    it("should return a usage error when the plan ref does not resolve", () => {
      const result = kspecRun("plan export @nonexistent --json", tempDir, {
        expectFail: true,
      });

      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(result.stderr) as { error: string };
      expect(parsed.error).toContain("Plan not found");
    });

    // AC: @plan-export ac-json
    // AC: @trait-json-output ac-1
    // AC: @trait-json-output ac-2
    // AC: @trait-json-output ac-4
    // AC: @trait-json-output ac-5
    it("should output full plan data as JSON", () => {
      kspec("plan set @export-plan --status approved", tempDir);

      const exported = kspecJson<{
        title: string;
        content: string;
        status: string;
        derived_specs: string[];
        derived_tasks: string[];
        created_at: string;
      }>("plan export @export-plan", tempDir);

      expect(exported.title).toBe("Export Plan");
      expect(exported.content).toBe("# Iterative Plan\n\n## Specs\n\n- export me");
      expect(exported.status).toBe("approved");
      expect(exported.derived_specs).toEqual([]);
      expect(exported.derived_tasks).toEqual([]);
      expect(exported.created_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    // AC: @trait-json-output ac-6 — N/A: plan export has no competing output-format flags beyond global --json.
    // AC: @trait-semantic-exit-codes ac-3 — N/A: plan export has no confirmation prompt.
    // AC: @trait-semantic-exit-codes ac-5 — N/A: plan export is single-record lookup, not an empty-result query.
    // AC: @trait-semantic-exit-codes ac-6 — N/A: invalid flag handling is provided by commander globally.
    // AC: @trait-semantic-exit-codes ac-7 — N/A: plan export is not a batch command.
    // AC: @trait-semantic-exit-codes ac-8 — documented centrally in src/cli/exit-codes.ts.
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

    // AC: @01KM46FW ac-1
    it("excludes cancelled tasks while preserving plan_ref-linked plan list counts", async () => {
      const isolatedTempDir = await setupTempFixtures();
      kspec(
        'plan add --title "Plan Metrics" --content "Metrics" --slug plan-metrics',
        isolatedTempDir,
      );
      const planRef = "@plan-metrics";
      kspec(
        `task add --title "Active work" --slug active-work --plan-ref ${planRef}`,
        isolatedTempDir,
      );
      kspec(
        `task add --title "Cancelled work" --slug cancelled-work --plan-ref ${planRef}`,
        isolatedTempDir,
      );
      kspec('task cancel @cancelled-work --reason "No longer needed"', isolatedTempDir);

      const output = kspec("plan list", isolatedTempDir);
      expect(output).toContain('[1 task] Plan Metrics');
      expect(output).not.toContain('[2 tasks] Plan Metrics');
      await cleanupTempDir(isolatedTempDir);
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
    it("is covered in cli-plan-derive.test.ts", () => {
      expect(true).toBe(true);
    });
  });
});
