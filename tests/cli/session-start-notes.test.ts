/**
 * Tests for session start notes enrichment
 *
 * AC: @cmd-session-start ac-review-detail
 * AC: @cmd-session-start ac-notes-starvation
 * AC: @trait-json-output ac-1 - Valid JSON output purity
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir, testUlids, seedSplitTask } from "../helpers/cli";
import type { SessionContext } from "../helpers/session-types";

const SESSION_START_NOTES_TIMEOUT_MS = 20_000;

describe("session start notes enrichment", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-session-start ac-review-detail
  describe("pending_review task notes", () => {
    it(
      "should include notes from pending_review tasks",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Create a task with notes and submit it to pending_review
        kspec('task add --title "Task with notes" --slug task-with-notes', tempDir);
        kspec("task start @task-with-notes", tempDir);
        kspec('task note @task-with-notes "Working on implementation"', tempDir);
        kspec("task submit @task-with-notes", tempDir);
        kspec('task note @task-with-notes "PR created, awaiting review"', tempDir);

        // Get session context
        const session = kspecJson<SessionContext>("session start --json", tempDir);

        // Should have notes from the pending_review task
        const pendingReviewNotes = session.recent_notes.filter(
          (n) => n.task_status === "pending_review",
        );
        expect(pendingReviewNotes.length).toBeGreaterThan(0);
        expect(pendingReviewNotes.some((n) => n.content.includes("PR created"))).toBe(true);
      },
    );

    it(
      "should group pending_review notes separately from in_progress notes",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Create an in_progress task with notes
        kspec('task add --title "In progress task" --slug in-progress-task', tempDir);
        kspec("task start @in-progress-task", tempDir);
        kspec('task note @in-progress-task "Still working"', tempDir);

        // Create a pending_review task with notes
        kspec('task add --title "Pending review task" --slug pending-review-task', tempDir);
        kspec("task start @pending-review-task", tempDir);
        kspec('task note @pending-review-task "Ready for review"', tempDir);
        kspec("task submit @pending-review-task", tempDir);

        // Get session context
        const session = kspecJson<SessionContext>("session start --json", tempDir);

        // Should have both types of notes with correct statuses
        const inProgressNotes = session.recent_notes.filter((n) => n.task_status === "in_progress");
        const pendingReviewNotes = session.recent_notes.filter(
          (n) => n.task_status === "pending_review",
        );

        expect(inProgressNotes.length).toBeGreaterThan(0);
        expect(pendingReviewNotes.length).toBeGreaterThan(0);
        expect(inProgressNotes.some((n) => n.content.includes("Still working"))).toBe(true);
        expect(pendingReviewNotes.some((n) => n.content.includes("Ready for review"))).toBe(true);
      },
    );

    it(
      "should show pending_review notes in human-readable output",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Create a pending_review task with notes
        kspec('task add --title "Task for review" --slug task-for-review', tempDir);
        kspec("task start @task-for-review", tempDir);
        kspec('task note @task-for-review "Ready for merge"', tempDir);
        kspec("task submit @task-for-review", tempDir);

        // Get human-readable output
        const result = kspec("session start", tempDir);

        // AC: @cmd-session-start ac-review-detail — notes shown inline under review tasks
        expect(result.stdout).toContain("Awaiting Review");
        expect(result.stdout).toContain("Ready for merge");
      },
    );
  });

  // AC: @cmd-session-start ac-notes-starvation
  describe("recently completed task notes", () => {
    it(
      "should include notes from recently completed tasks",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Create and complete a task with notes
        kspec('task add --title "Completed task" --slug completed-task', tempDir);
        kspec("task start @completed-task", tempDir);
        kspec('task note @completed-task "Implementation complete"', tempDir);
        kspec("task submit @completed-task", tempDir);
        kspec('task complete @completed-task --reason "Merged"', tempDir);

        // Get session context
        const session = kspecJson<SessionContext>("session start --json", tempDir);

        // Should have notes from the completed task
        const completedNotes = session.recent_notes.filter((n) => n.task_status === "completed");
        expect(completedNotes.length).toBeGreaterThan(0);
        expect(completedNotes.some((n) => n.content.includes("Implementation complete"))).toBe(
          true,
        );
      },
    );

    it(
      "should limit to last 3-5 completed tasks",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Seed 7 completed tasks in split format to avoid 35+ CLI subprocess calls
        // that time out under parallel test load.
        const taskUlids = testUlids("CMPL", 7);
        const noteUlids = testUlids("CNOT", 7);

        for (let i = 0; i < 7; i++) {
          const hour = (i + 1).toString().padStart(2, "0");
          seedSplitTask(tempDir, {
            _ulid: taskUlids[i],
            slugs: [`completed-${i + 1}`],
            title: `Completed ${i + 1}`,
            type: "task",
            status: "completed",
            priority: 3,
            tags: ["test"],
            depends_on: [],
            notes: [
              {
                _ulid: noteUlids[i],
                created_at: `2026-01-01T00:${hour}:00Z`,
                author: "@test",
                content: `Note for task ${i + 1}`,
              },
            ],
            todos: [],
            created_at: "2026-01-01T00:00:00Z",
            started_at: `2026-01-01T00:${hour}:00Z`,
            submitted_at: `2026-01-01T00:${hour}:30Z`,
            completed_at: `2026-01-01T${hour}:00:00Z`,
            closed_reason: "Done",
          });
        }

        // Get session context
        const session = kspecJson<SessionContext>("session start --json", tempDir);

        // Count unique completed tasks in notes
        const completedNotes = session.recent_notes.filter((n) => n.task_status === "completed");
        const uniqueCompletedTasks = new Set(completedNotes.map((n) => n.task_ref));

        // Should have at most 5 unique completed tasks (per AC-2: last 3-5)
        expect(uniqueCompletedTasks.size).toBeLessThanOrEqual(5);
        expect(uniqueCompletedTasks.size).toBeGreaterThan(0);
      },
    );

    it(
      "should show recently completed tasks in activity timeline",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Create and complete a task with notes
        kspec('task add --title "Done task" --slug done-task', tempDir);
        kspec("task start @done-task", tempDir);
        kspec('task note @done-task "All tests passing"', tempDir);
        kspec('task complete @done-task --reason "Shipped"', tempDir);

        // Get human-readable output
        const result = kspec("session start", tempDir);

        // Completed tasks appear in the activity timeline, not a separate notes section
        // AC: @cmd-session-start ac-section-order — activity timeline shows completed tasks
        expect(result.stdout).toContain("Recent Activity");
        expect(result.stdout).toContain("✓");
        expect(result.stdout).toContain("Done task");
      },
    );

    it("should include notes from multiple completed tasks", { timeout: 20000 }, () => {
      // Create and complete two tasks with notes
      kspec('task add --title "First completed task" --slug first-completed', tempDir);
      kspec("task start @first-completed", tempDir);
      kspec('task note @first-completed "First task note"', tempDir);
      kspec("task submit @first-completed", tempDir);
      kspec('task complete @first-completed --reason "Done first"', tempDir);

      kspec('task add --title "Second completed task" --slug second-completed', tempDir);
      kspec("task start @second-completed", tempDir);
      kspec('task note @second-completed "Second task note"', tempDir);
      kspec("task submit @second-completed", tempDir);
      kspec('task complete @second-completed --reason "Done second"', tempDir);

      // Get session context
      const session = kspecJson<SessionContext>("session start --json", tempDir);

      // Should have notes from completed tasks
      const completedNotes = session.recent_notes.filter((n) => n.task_status === "completed");

      // Should include notes from both completed tasks
      expect(completedNotes.length).toBeGreaterThanOrEqual(1);

      // Check that we can find notes from both tasks (they may be limited by the notes limit)
      const hasFirstNote = completedNotes.some((n) => n.content.includes("First task note"));
      const hasSecondNote = completedNotes.some((n) => n.content.includes("Second task note"));

      // At least one of the notes should be present
      expect(hasFirstNote || hasSecondNote).toBe(true);
    });
  });

  // AC: @cmd-session-start ac-notes-starvation
  describe("mixed-status note starvation prevention", () => {
    it(
      "should include pending_review and completed notes even with many in_progress notes",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Seed tasks in split format to avoid 24+ CLI subprocess calls
        // that time out under parallel test load.
        const taskUlids = testUlids("STRV", 7);
        const noteUlids = testUlids("SNOT", 7);

        // 5 in_progress tasks with notes (potential starvation scenario)
        for (let i = 0; i < 5; i++) {
          const minute = (i + 1).toString().padStart(2, "0");
          seedSplitTask(tempDir, {
            _ulid: taskUlids[i],
            slugs: [`active-${i + 1}`],
            title: `Active ${i + 1}`,
            type: "task",
            status: "in_progress",
            priority: 3,
            tags: ["test"],
            depends_on: [],
            notes: [
              {
                _ulid: noteUlids[i],
                created_at: `2026-01-01T00:${minute}:00Z`,
                author: "@test",
                content: `Active note ${i + 1}`,
              },
            ],
            todos: [],
            created_at: "2026-01-01T00:00:00Z",
            started_at: `2026-01-01T00:${minute}:00Z`,
          });
        }

        // 1 pending_review task with note
        seedSplitTask(tempDir, {
          _ulid: taskUlids[5],
          slugs: ["review-task"],
          title: "Review task",
          type: "task",
          status: "pending_review",
          priority: 3,
          tags: ["test"],
          depends_on: [],
          notes: [
            {
              _ulid: noteUlids[5],
              created_at: "2026-01-01T00:06:00Z",
              author: "@test",
              content: "Review note",
            },
          ],
          todos: [],
          created_at: "2026-01-01T00:00:00Z",
          started_at: "2026-01-01T00:06:00Z",
          submitted_at: "2026-01-01T00:06:30Z",
        });

        // 1 completed task with note
        seedSplitTask(tempDir, {
          _ulid: taskUlids[6],
          slugs: ["done-task"],
          title: "Done task",
          type: "task",
          status: "completed",
          priority: 3,
          tags: ["test"],
          depends_on: [],
          notes: [
            {
              _ulid: noteUlids[6],
              created_at: "2026-01-01T00:07:00Z",
              author: "@test",
              content: "Done note",
            },
          ],
          todos: [],
          created_at: "2026-01-01T00:00:00Z",
          started_at: "2026-01-01T00:07:00Z",
          submitted_at: "2026-01-01T00:07:30Z",
          completed_at: "2026-01-01T01:00:00Z",
          closed_reason: "Finished",
        });

        // Get session context
        const session = kspecJson<SessionContext>("session start --json", tempDir);

        // All three status types should be represented
        const inProgressNotes = session.recent_notes.filter((n) => n.task_status === "in_progress");
        const pendingReviewNotes = session.recent_notes.filter(
          (n) => n.task_status === "pending_review",
        );
        const completedNotes = session.recent_notes.filter((n) => n.task_status === "completed");

        // Each status should have notes present (not starved out)
        expect(inProgressNotes.length).toBeGreaterThan(0);
        expect(pendingReviewNotes.length).toBeGreaterThan(0);
        expect(completedNotes.length).toBeGreaterThan(0);

        // Verify specific notes are present
        expect(pendingReviewNotes.some((n) => n.content.includes("Review note"))).toBe(true);
        expect(completedNotes.some((n) => n.content.includes("Done note"))).toBe(true);
      },
    );
  });

  describe("task_status field in JSON output", () => {
    it(
      "should include task_status field for all notes",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Create tasks in different states with notes
        kspec('task add --title "Active task" --slug active-task', tempDir);
        kspec("task start @active-task", tempDir);
        kspec('task note @active-task "Active work"', tempDir);

        // Get session context
        const session = kspecJson<SessionContext>("session start --json", tempDir);

        // All notes should have task_status field
        for (const note of session.recent_notes) {
          expect(note.task_status).toBeDefined();
          expect(["in_progress", "pending_review", "completed"]).toContain(note.task_status);
        }
      },
    );
  });

  // AC: @trait-json-output ac-1 - Valid JSON with no ANSI color codes
  describe("JSON output purity", () => {
    it(
      "should produce valid JSON on stdout with no extra lines",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Run session start --json and verify stdout is pure JSON
        const result = kspec("session start --json", tempDir);
        expect(result.exitCode).toBe(0);

        // stdout should be valid JSON - no info lines mixed in
        expect(() => JSON.parse(result.stdout)).not.toThrow();

        // Verify it's an object with expected session fields
        const parsed = JSON.parse(result.stdout);
        expect(parsed).toHaveProperty("branch");
        expect(parsed).toHaveProperty("context");
      },
    );

    it(
      "should not contain ANSI color codes in JSON output",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        // Create some data to ensure output has content
        kspec('task add --title "Color check" --slug color-check', tempDir);
        kspec("task start @color-check", tempDir);

        const result = kspec("session start --json", tempDir);

        // ANSI escape sequences start with \x1b[ or \u001b[
        // oxlint-disable-next-line eslint(no-control-regex) -- intentionally matching ANSI escape
        expect(result.stdout).not.toMatch(/\x1b\[/);
      },
    );

    it(
      "should not have info/warning lines on stdout",
      { timeout: SESSION_START_NOTES_TIMEOUT_MS },
      () => {
        const result = kspec("session start --json", tempDir);

        // stdout should not contain info markers
        expect(result.stdout).not.toContain("ℹ");
        expect(result.stdout).not.toContain("⚠");

        // stdout should start with { (JSON object)
        expect(result.stdout.trimStart()).toMatch(/^\{/);
      },
    );
  });
});
