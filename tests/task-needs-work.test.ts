/**
 * Integration tests for kspec task needs-work state and fix cycle
 * AC: @01KHYRCW (needs-work-state)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspecOutput as kspec,
  kspecJson,
  kspecWithStatus,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from "./helpers/cli";

describe("Integration: needs_work state", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @01KHYRCW ac-1
  it("needs_work is a valid task status in schema", () => {
    // Start, submit, then kick back
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);
    kspec('task needs-work @test-task-pending --reason "Missing test coverage"', tempDir);

    const task = kspecJson<{ status: string }>("task get @test-task-pending", tempDir);
    expect(task.status).toBe("needs_work");
  });

  // AC: @01KHYRCW ac-2
  it("transitions pending_review to needs_work with reason and fix cycle note", () => {
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);

    const beforeKickback = kspecJson<{ status: string }>("task get @test-task-pending", tempDir);
    expect(beforeKickback.status).toBe("pending_review");

    const output = kspec(
      'task needs-work @test-task-pending --reason "MUST-FIX: validation missing on input"',
      tempDir,
    );
    expect(output).toContain("Kicked back task");
    expect(output).toContain("fix cycle 1");

    const afterKickback = kspecJson<{
      status: string;
      notes: Array<{ content: string }>;
    }>("task get @test-task-pending", tempDir);
    expect(afterKickback.status).toBe("needs_work");

    const kickbackNote = afterKickback.notes.find((n) => n.content.includes("[FIX_CYCLE:"));
    expect(kickbackNote).toBeTruthy();
    expect(kickbackNote?.content).toContain("[FIX_CYCLE: 1]");
    expect(kickbackNote?.content).toContain("MUST-FIX: validation missing on input");
  });

  // AC: @01KHYRCW ac-3
  it("allows task start from needs_work state", () => {
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);
    kspec('task needs-work @test-task-pending --reason "Issues found"', tempDir);

    const beforeStart = kspecJson<{ status: string }>("task get @test-task-pending", tempDir);
    expect(beforeStart.status).toBe("needs_work");

    const output = kspec("task start @test-task-pending", tempDir);
    expect(output).toContain("Started task");

    const afterStart = kspecJson<{ status: string }>("task get @test-task-pending", tempDir);
    expect(afterStart.status).toBe("in_progress");
  });

  // AC: @01KHYRCW ac-4
  it("rejects needs-work from non-pending_review states", () => {
    // From pending
    const {
      stdout: s1,
      stderr: e1,
      exitCode: c1,
    } = kspecWithStatus('task needs-work @test-task-pending --reason "test"', tempDir);
    expect(c1).not.toBe(0);
    expect(s1 + e1).toContain("must be pending_review");

    // From in_progress
    kspec("task start @test-task-pending", tempDir);
    const {
      stdout: s2,
      stderr: e2,
      exitCode: c2,
    } = kspecWithStatus('task needs-work @test-task-pending --reason "test"', tempDir);
    expect(c2).not.toBe(0);
    expect(s2 + e2).toContain("must be pending_review");
  });

  // AC: @01KHYRCW ac-5
  it("needs_work tasks appear in active task list", () => {
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);
    kspec('task needs-work @test-task-pending --reason "Issues found"', tempDir);

    const activeTasks = kspecJson<Array<{ status: string; slugs: string[] }>>(
      "tasks in-progress",
      tempDir,
    );
    const needsWorkTask = activeTasks.find((t) => t.slugs.includes("test-task-pending"));
    expect(needsWorkTask).toBeTruthy();
    expect(needsWorkTask?.status).toBe("needs_work");
  });

  // AC: @01KHYRCW ac-6
  it("help content documents needs_work state", () => {
    const output = kspec("help task", tempDir);
    expect(output).toContain("needs_work");
    expect(output).toContain("needs-work");
  });

  // AC: @01KHYRCW ac-7
  it("increments fix cycle counter on repeated kickbacks", () => {
    // First cycle
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);
    kspec('task needs-work @test-task-pending --reason "First review: missing tests"', tempDir);

    // Worker fixes and resubmits
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);

    // Second kickback
    const output2 = kspec(
      'task needs-work @test-task-pending --reason "Second review: edge case not handled"',
      tempDir,
    );
    expect(output2).toContain("fix cycle 2");

    // Worker fixes and resubmits again
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);

    // Third kickback
    const output3 = kspec(
      'task needs-work @test-task-pending --reason "Third review: regression introduced"',
      tempDir,
    );
    expect(output3).toContain("fix cycle 3");

    // Verify all notes present
    const task = kspecJson<{ notes: Array<{ content: string }> }>(
      "task get @test-task-pending",
      tempDir,
    );
    const kickbackNotes = task.notes.filter((n) => n.content.includes("[FIX_CYCLE:"));
    expect(kickbackNotes).toHaveLength(3);
    expect(kickbackNotes[0].content).toContain("[FIX_CYCLE: 1]");
    expect(kickbackNotes[1].content).toContain("[FIX_CYCLE: 2]");
    expect(kickbackNotes[2].content).toContain("[FIX_CYCLE: 3]");
  });

  // Additional: full fix cycle round-trip
  it(
    "supports full fix cycle: pending_review -> needs_work -> in_progress -> pending_review",
    () => {
      // Initial work
      kspec("task start @test-task-pending", tempDir);
      kspec("task submit @test-task-pending", tempDir);
      expect(kspecJson<{ status: string }>("task get @test-task-pending", tempDir).status).toBe(
        "pending_review",
      );

      // Reviewer kicks back
      kspec('task needs-work @test-task-pending --reason "Fix needed"', tempDir);
      expect(kspecJson<{ status: string }>("task get @test-task-pending", tempDir).status).toBe(
        "needs_work",
      );

      // Worker picks up and fixes
      kspec("task start @test-task-pending", tempDir);
      expect(kspecJson<{ status: string }>("task get @test-task-pending", tempDir).status).toBe(
        "in_progress",
      );

      // Worker resubmits
      kspec("task submit @test-task-pending", tempDir);
      expect(kspecJson<{ status: string }>("task get @test-task-pending", tempDir).status).toBe(
        "pending_review",
      );

      // Reviewer approves and completes
      kspec('task complete @test-task-pending --reason "Clean after fix cycle"', tempDir);
      expect(kspecJson<{ status: string }>("task get @test-task-pending", tempDir).status).toBe(
        "completed",
      );
    },
  );

  // Additional: --reason is required
  it("requires --reason flag for needs-work command", () => {
    kspec("task start @test-task-pending", tempDir);
    kspec("task submit @test-task-pending", tempDir);

    const { exitCode } = kspecWithStatus("task needs-work @test-task-pending", tempDir);
    expect(exitCode).not.toBe(0);
  });
});
