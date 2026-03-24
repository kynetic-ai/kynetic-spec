/**
 * Integration tests for needs_work tasks appearing in `kspec tasks ready`
 * Verifies that tasks kicked back from review appear as ready work items,
 * and that they sort before pending tasks (fix cycles take priority).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from "./helpers/cli";

describe("Integration: needs_work tasks in tasks ready", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-filterable-list ac-1
  it("needs_work tasks appear in tasks ready output", () => {
    // Move task through: pending -> in_progress -> pending_review -> needs_work
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);
    kspec('task needs-work @test-task-pending --reason "Missing test coverage"', tempDir);

    const task = kspecJson<{ status: string }>("task get @test-task-pending", tempDir);
    expect(task.status).toBe("needs_work");

    // Verify it appears in tasks ready
    const readyTasks = kspecJson<Array<{ slugs: string[]; status: string }>>(
      "tasks ready",
      tempDir,
    );
    const needsWorkTask = readyTasks.find((t) => t.slugs.includes("test-task-pending"));
    expect(needsWorkTask).toBeTruthy();
    expect(needsWorkTask?.status).toBe("needs_work");
  });

  // AC: @trait-filterable-list ac-1
  // AC: @trait-filterable-list ac-5
  it("needs_work tasks appear in tasks ready --eligible when automation is eligible", () => {
    kspec("task set @test-task-pending --automation eligible", tempDir);
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);
    kspec('task needs-work @test-task-pending --reason "Issues found"', tempDir);

    const readyTasks = kspecJson<Array<{ slugs: string[]; status: string }>>(
      "tasks ready --eligible",
      tempDir,
    );
    const needsWorkTask = readyTasks.find((t) => t.slugs.includes("test-task-pending"));
    expect(needsWorkTask).toBeTruthy();
    expect(needsWorkTask?.status).toBe("needs_work");
  });

  // AC: @trait-filterable-list ac-7
  it("needs_work tasks sort before pending tasks in tasks ready", () => {
    // Kick test-task-pending to needs_work; test-task-secondary remains pending
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);
    kspec('task needs-work @test-task-pending --reason "Fix needed"', tempDir);

    const readyTasks = kspecJson<Array<{ slugs: string[]; status: string }>>(
      "tasks ready",
      tempDir,
    );

    // Both tasks should be present
    const needsWorkIdx = readyTasks.findIndex((t) => t.slugs.includes("test-task-pending"));
    const pendingIdx = readyTasks.findIndex((t) => t.slugs.includes("test-task-secondary"));

    expect(needsWorkIdx).not.toBe(-1);
    expect(pendingIdx).not.toBe(-1);
    // needs_work must appear before pending
    expect(needsWorkIdx).toBeLessThan(pendingIdx);
  });
});
