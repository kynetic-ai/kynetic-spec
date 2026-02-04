/**
 * Tests for plan_ref field on Task schema
 * AC: @plan-derive ac-5, ac-6
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
} from "./helpers/cli";

describe("Integration: task plan_ref field", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-derive ac-6 - task displays plan_ref
  it("should allow creating task with plan_ref", () => {
    // Create a plan first
    kspec(
      'plan add --title "Test Plan" --content "Plan content" --slug test-plan-1',
      tempDir,
    );

    // Create task with plan_ref
    const output = kspec(
      'task add --title "Task from Plan" --plan-ref @test-plan-1 --slug task-from-plan',
      tempDir,
    );
    expect(output).toContain("Created task:");

    // Verify plan_ref is set
    const task = kspecJson<{ plan_ref: string | null }>(
      "task get @task-from-plan --json",
      tempDir,
    );
    expect(task.plan_ref).toBeDefined();
    expect(task.plan_ref).toBe("@test-plan-1");
  });

  // AC: @plan-derive ac-6 - task get displays plan_ref
  it("should display plan_ref in task get output", () => {
    // Create plan and task
    kspec(
      'plan add --title "Test Plan" --content "Content" --slug test-plan-2',
      tempDir,
    );
    kspec(
      'task add --title "Test Task" --plan-ref @test-plan-2 --slug test-task-2',
      tempDir,
    );

    // Check task get output
    const output = kspec("task get @test-task-2", tempDir);
    expect(output).toContain("Plan ref:");
    expect(output).toContain("@test-plan-2");
  });

  it("should allow setting plan_ref with task set", () => {
    // Create plan and task
    kspec(
      'plan add --title "Test Plan" --content "Content" --slug test-plan-3',
      tempDir,
    );
    kspec('task add --title "Test Task" --slug test-task-3', tempDir);

    // Set plan_ref
    kspec("task set @test-task-3 --plan-ref @test-plan-3", tempDir);

    // Verify it was set
    const task = kspecJson<{ plan_ref: string | null }>(
      "task get @test-task-3 --json",
      tempDir,
    );
    expect(task.plan_ref).toBe("@test-plan-3");
  });

  it("should allow clearing plan_ref", () => {
    // Create plan and task with plan_ref
    kspec(
      'plan add --title "Test Plan" --content "Content" --slug test-plan-4',
      tempDir,
    );
    kspec(
      'task add --title "Test Task" --plan-ref @test-plan-4 --slug test-task-4',
      tempDir,
    );

    // Clear plan_ref
    kspec("task set @test-task-4 --plan-ref null", tempDir);

    // Verify it was cleared
    const task = kspecJson<{ plan_ref: string | null }>(
      "task get @test-task-4 --json",
      tempDir,
    );
    expect(task.plan_ref).toBeNull();
  });

  it("should include plan_ref in JSON output", () => {
    // Create plan and task
    kspec(
      'plan add --title "Test Plan" --content "Content" --slug test-plan-5',
      tempDir,
    );

    const addOutput = kspecJson<{ task: { plan_ref: string | null } }>(
      'task add --title "Test Task" --plan-ref @test-plan-5 --json',
      tempDir,
    );

    expect(addOutput.task.plan_ref).toBeDefined();
    expect(addOutput.task.plan_ref).toBe("@test-plan-5");
  });

  it("should validate plan_ref exists", () => {
    const result = kspecRun(
      'task add --title "Test Task" --plan-ref @nonexistent',
      tempDir,
      { expectFail: true },
    );

    expect(result.stderr).toContain("not found");
    expect(result.exitCode).not.toBe(0);
  });

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
    const output = kspec(
      'task add --title "No Plan Task" --slug no-plan-task',
      tempDir,
    );
    expect(output).toContain("Created task:");

    const task = kspecJson<{ plan_ref?: string | null }>(
      "task get @no-plan-task --json",
      tempDir,
    );
    // plan_ref should be absent or null
    expect(task.plan_ref === null || task.plan_ref === undefined).toBe(true);
  });
});
