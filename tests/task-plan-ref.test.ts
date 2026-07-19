/**
 * Tests for plan_ref field on Task schema
 * AC: @plan-derive-enhanced ac-bidirectional-links
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { join } from "path";
import { parse, stringify } from "yaml";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  readTestOutput,
} from "./helpers/cli";

describe("Integration: task plan_ref field", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @task-add ac-plan-ref
  // AC: @plan-derive-enhanced ac-bidirectional-links
  it("should allow creating task with plan_ref", () => {
    // Create a plan first
    kspec('plan add --title "Test Plan" --content "Plan content" --slug test-plan-1', tempDir);

    // Create task with plan_ref
    const output = kspec(
      'task add --title "Task from Plan" --plan-ref @test-plan-1 --slug task-from-plan',
      tempDir,
    );
    expect(output).toContain("Created task:");

    // Verify plan_ref is set
    const task = kspecJson<{ plan_ref: string | null }>("task get @task-from-plan --json", tempDir);
    expect(task.plan_ref).toBeDefined();
    expect(task.plan_ref).toBe("@test-plan-1");
  });

  // AC: @plan-derive-enhanced ac-bidirectional-links
  it("should display plan_ref in task get output", () => {
    // Create plan and task
    kspec('plan add --title "Test Plan" --content "Content" --slug test-plan-2', tempDir);
    kspec('task add --title "Test Task" --plan-ref @test-plan-2 --slug test-task-2', tempDir);

    // Check task get output
    const output = kspec("task get @test-task-2", tempDir);
    expect(output).toContain("Plan ref:");
    expect(output).toContain("@test-plan-2");
  });

  it("should allow setting plan_ref with task set", () => {
    // Create plan and task
    kspec('plan add --title "Test Plan" --content "Content" --slug test-plan-3', tempDir);
    kspec('task add --title "Test Task" --slug test-task-3', tempDir);

    // Set plan_ref
    kspec("task set @test-task-3 --plan-ref @test-plan-3", tempDir);

    // Verify it was set
    const task = kspecJson<{ plan_ref: string | null }>("task get @test-task-3 --json", tempDir);
    expect(task.plan_ref).toBe("@test-plan-3");
  });

  // AC: @task-set ac-clear-ref
  it("should allow clearing plan_ref", () => {
    // Create plan and task with plan_ref
    kspec('plan add --title "Test Plan" --content "Content" --slug test-plan-4', tempDir);
    kspec('task add --title "Test Task" --plan-ref @test-plan-4 --slug test-task-4', tempDir);

    // Clear plan_ref
    kspec("task set @test-task-4 --plan-ref null", tempDir);

    // Verify it was cleared
    const task = kspecJson<{ plan_ref: string | null }>("task get @test-task-4 --json", tempDir);
    expect(task.plan_ref).toBeNull();
  });

  it("should include plan_ref in JSON output", () => {
    // Create plan and task
    kspec('plan add --title "Test Plan" --content "Content" --slug test-plan-5', tempDir);

    const addOutput = kspecJson<{ task: { plan_ref: string | null } }>(
      'task add --title "Test Task" --plan-ref @test-plan-5 --json',
      tempDir,
    );

    expect(addOutput.task.plan_ref).toBeDefined();
    expect(addOutput.task.plan_ref).toBe("@test-plan-5");
  });

  // AC: @task-add ac-plan-ref-invalid
  it("should validate plan_ref exists", () => {
    const result = kspecRun('task add --title "Test Task" --plan-ref @nonexistent', tempDir, {
      expectFail: true,
    });

    expect(result.stderr).toContain("not found");
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @task-add ac-plan-ref-invalid
  it("should error when plan_ref points to a task", () => {
    // Create a task (not a plan)
    kspec('task add --title "Other Task" --slug other-task-not-plan', tempDir);

    // Try to use task as plan_ref
    const result = kspecRun(
      'task add --title "Test Task" --plan-ref @other-task-not-plan',
      tempDir,
      { expectFail: true },
    );

    expect(result.stderr).toContain("not a plan");
    expect(result.exitCode).not.toBe(0);
  });

  it("should handle plan_ref when task is created without it", () => {
    const output = kspec('task add --title "No Plan Task" --slug no-plan-task', tempDir);
    expect(output).toContain("Created task:");

    const task = kspecJson<{ plan_ref?: string | null }>("task get @no-plan-task --json", tempDir);
    // plan_ref should be absent or null
    expect(task.plan_ref === null || task.plan_ref === undefined).toBe(true);
  });

  // AC: @plan-validation ac-10
  describe("Validation", () => {
    it("should pass validation when plan_ref points to existing plan", () => {
      // Create a plan and task with valid plan_ref
      kspec('plan add --title "Test Plan" --content "Content" --slug valid-plan', tempDir);
      kspec('task add --title "Test Task" --plan-ref @valid-plan --slug test-task-valid', tempDir);

      // Validation should pass (no reference errors for this ref)
      const output = kspec("validate", tempDir);
      // Should not have errors about this specific ref
      // (Other errors might exist but not about @valid-plan)
      expect(output).not.toContain('"@valid-plan" not found');
    });

    // Inject a dangling reference directly into the per-task detail file
    // (split storage), bypassing CLI-time ref validation. The finding can only
    // surface if validate() loads the persisted split-storage record.
    async function injectIntoTaskDetailFile(
      slug: string,
      mutate: (taskData: Record<string, unknown>) => void,
    ): Promise<void> {
      // Find the task's ULID from the index
      const tasksFile = join(tempDir, "project.tasks.yaml");
      const content = await readTestOutput(tasksFile);
      const entries = parse(content) as Array<{ _ulid: string; slugs: string[] }>;
      const entry = entries.find((t) => t.slugs.includes(slug));
      expect(entry).toBeDefined();

      const taskFile = join(tempDir, "tasks", entry!._ulid, "task.yaml");
      const taskData = parse(await readTestOutput(taskFile)) as Record<string, unknown>;
      mutate(taskData);
      await fs.writeFile(taskFile, stringify(taskData));
    }

    // AC: @plan-validation ac-10
    // AC: @validation-task-data-source ac-task-references-checked
    // AC: @validation-task-data-source ac-all-persisted-tasks-included
    it("should report dangling plan_ref in a split-storage task file as a validation error", async () => {
      kspec('task add --title "Test Task" --slug test-dangling', tempDir);
      await injectIntoTaskDetailFile("test-dangling", (taskData) => {
        taskData.plan_ref = "@nonexistent-plan";
      });

      // strict_refs defaults to true, so the dangling ref is an error and
      // validate exits non-zero
      const result = kspecRun("validate", tempDir, { expectFail: true });
      const output = result.stdout + result.stderr;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("@nonexistent-plan");
      expect(output).toMatch(/not found/i);
    });

    // AC: @validation-task-data-source ac-task-references-checked
    // AC: @validation-task-data-source ac-all-persisted-tasks-included
    it("should report dangling spec_ref in a split-storage task file as a validation error", async () => {
      kspec('task add --title "Test Task" --slug test-dangling-spec', tempDir);
      await injectIntoTaskDetailFile("test-dangling-spec", (taskData) => {
        taskData.spec_ref = "@nonexistent-spec-item";
      });

      const result = kspecRun("validate", tempDir, { expectFail: true });
      const output = result.stdout + result.stderr;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("@nonexistent-spec-item");
      expect(output).toMatch(/not found/i);
    });

    // AC: @validation-task-data-source ac-task-references-checked
    // AC: @validation-task-data-source ac-all-persisted-tasks-included
    it("should report dangling depends_on entry in a split-storage task file as a validation error", async () => {
      kspec('task add --title "Test Task" --slug test-dangling-dep', tempDir);
      await injectIntoTaskDetailFile("test-dangling-dep", (taskData) => {
        taskData.depends_on = ["@nonexistent-dependency"];
      });

      const result = kspecRun("validate", tempDir, { expectFail: true });
      const output = result.stdout + result.stderr;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain("@nonexistent-dependency");
      expect(output).toMatch(/not found/i);
    });
  });
});
