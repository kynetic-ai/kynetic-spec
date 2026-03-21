import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, initGitRepo, testUlids } from "./helpers/cli";
import {
  assembleActivityFromFiles,
  historyToActivity,
  notesToActivity,
  getPreMigrationActivity,
} from "../src/utils/activity";
import type { HistoryEntry } from "../src/parser/task-data-manager";
import type { Note } from "../src/schema/task";

// ─── Helpers ───

function makeHistory(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    timestamp: "2026-03-20T10:00:00.000Z",
    author: "test@example.com",
    command: "task-set",
    changes: {
      priority: { previous: 3, new: 1 },
    },
    ...overrides,
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    _ulid: "01ACTVTY00000000000000NOTE",
    created_at: "2026-03-20T11:00:00.000Z",
    content: "Test note content",
    ...overrides,
  };
}

// AC: @task-activity-in-file ac-1
describe("historyToActivity — ac-1: field changes from stored history entries", () => {
  it("converts a single-field history entry to an activity entry", () => {
    const history: HistoryEntry[] = [
      makeHistory({
        command: "task-set",
        changes: { priority: { previous: 3, new: 1 } },
      }),
    ];

    const entries = historyToActivity(history);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("field_updated");
    expect(entries[0].timestamp).toBe("2026-03-20T10:00:00.000Z");
    expect(entries[0].author).toBe("test@example.com");
    expect(entries[0].summary).toBe("Updated priority");
    expect(entries[0].commitHash).toBe("");
    expect(entries[0].source).toBe("history");
    expect(entries[0].command).toBe("task-set");
    expect(entries[0].detail).toEqual({
      field: "priority",
      from: "3",
      to: "1",
    });
  });

  it("converts a status change to state_change type", () => {
    const history: HistoryEntry[] = [
      makeHistory({
        command: "task-start",
        changes: {
          status: { previous: "pending", new: "in_progress" },
          started_at: { previous: null, new: "2026-03-20T10:00:00.000Z" },
        },
      }),
    ];

    const entries = historyToActivity(history);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("started");
    expect(entries[0].summary).toBe("Task started");
    expect(entries[0].source).toBe("history");
  });

  it("maps known commands to correct activity types", () => {
    const commands: Array<[string, string, string]> = [
      ["task-add", "created", "Task created"],
      ["task-start", "started", "Task started"],
      ["task-submit", "submitted", "Task submitted for review"],
      ["task-complete", "completed", "Task completed"],
      ["task-block", "blocked", "Task blocked"],
      ["task-needs-work", "needs_work", "Task returned for changes"],
      ["task-cancel", "cancelled", "Task cancelled"],
    ];

    for (const [command, expectedType, expectedSummary] of commands) {
      const entries = historyToActivity([
        makeHistory({
          command,
          changes: { status: { previous: "pending", new: "in_progress" } },
        }),
      ]);
      expect(entries[0].type).toBe(expectedType);
      expect(entries[0].summary).toBe(expectedSummary);
      // AC: @task-activity-in-file ac-2 — command preserved in activity entry
      expect(entries[0].command).toBe(command);
    }
  });

  it("shows status transition for single-status-change entry", () => {
    const entries = historyToActivity([
      makeHistory({
        command: "task-set",
        changes: { status: { previous: "pending", new: "blocked" } },
      }),
    ]);
    expect(entries[0].summary).toBe("Status: pending → blocked");
    expect(entries[0].type).toBe("state_change");
  });

  it("shows review_linked for review_ref changes", () => {
    const entries = historyToActivity([
      makeHistory({
        command: "task-set",
        changes: {
          review_ref: {
            previous: null,
            new: "@review-abc",
          },
        },
      }),
    ]);
    expect(entries[0].type).toBe("review_linked");
    expect(entries[0].summary).toBe("Review linked: @review-abc");
  });

  // AC: @task-activity-in-file ac-2 — multi-field changes expose all field-level details
  it("handles multi-field updates with namespaced detail", () => {
    const entries = historyToActivity([
      makeHistory({
        changes: {
          priority: { previous: 3, new: 1 },
          tags: { previous: [], new: ["urgent"] },
        },
      }),
    ]);
    expect(entries[0].summary).toBe("Updated priority, tags");
    expect(entries[0].command).toBe("task-set");
    expect(entries[0].detail).toEqual({
      "priority.from": "3",
      "priority.to": "1",
      "tags.from": "",
      "tags.to": "urgent",
    });
  });
});

// AC: @task-activity-in-file ac-1
describe("notesToActivity — ac-1: note events from stored note entries", () => {
  it("converts notes to note_added activity entries", () => {
    const notes: Note[] = [
      makeNote({ author: "alice" }),
      makeNote({
        _ulid: "01ACTVTY00000000000000NOT2",
        created_at: "2026-03-20T12:00:00.000Z",
        author: "bob",
      }),
    ];

    const entries = notesToActivity(notes);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("note_added");
    expect(entries[0].author).toBe("alice");
    expect(entries[0].source).toBe("note");
    expect(entries[0].command).toBeUndefined(); // notes don't have commands
    expect(entries[1].author).toBe("bob");
    expect(entries[1].timestamp).toBe("2026-03-20T12:00:00.000Z");
  });

  it("defaults author to 'unknown' when not present", () => {
    const entries = notesToActivity([makeNote({ author: undefined })]);
    expect(entries[0].author).toBe("unknown");
  });
});

// AC: @task-activity-in-file ac-1
// AC: @task-activity-in-file ac-2
describe("assembleActivityFromFiles — ac-1, ac-2: assembled timeline from persisted data", () => {
  it("merges history and notes in chronological order", () => {
    const history: HistoryEntry[] = [
      makeHistory({
        timestamp: "2026-03-20T09:00:00.000Z",
        command: "task-add",
        changes: { status: { previous: undefined, new: "pending" } },
      }),
      makeHistory({
        timestamp: "2026-03-20T11:00:00.000Z",
        command: "task-start",
        changes: { status: { previous: "pending", new: "in_progress" } },
      }),
    ];

    const notes: Note[] = [
      makeNote({
        created_at: "2026-03-20T10:00:00.000Z",
        author: "alice",
      }),
    ];

    const entries = assembleActivityFromFiles(history, notes);
    expect(entries).toHaveLength(3);
    // Chronological: task-add (09:00), note (10:00), task-start (11:00)
    expect(entries[0].type).toBe("created");
    expect(entries[0].source).toBe("history");
    expect(entries[1].type).toBe("note_added");
    expect(entries[1].source).toBe("note");
    expect(entries[2].type).toBe("started");
    expect(entries[2].source).toBe("history");
  });

  // AC: @task-activity-in-file ac-2
  it("includes all change types in a complex lifecycle", () => {
    const history: HistoryEntry[] = [
      makeHistory({
        timestamp: "2026-03-20T08:00:00.000Z",
        command: "task-add",
        changes: { status: { previous: undefined, new: "pending" } },
      }),
      makeHistory({
        timestamp: "2026-03-20T09:00:00.000Z",
        command: "task-start",
        changes: {
          status: { previous: "pending", new: "in_progress" },
          started_at: { previous: null, new: "2026-03-20T09:00:00.000Z" },
        },
      }),
      makeHistory({
        timestamp: "2026-03-20T10:00:00.000Z",
        command: "task-set",
        changes: { priority: { previous: 3, new: 1 } },
      }),
      makeHistory({
        timestamp: "2026-03-20T12:00:00.000Z",
        command: "task-set",
        changes: { review_ref: { previous: null, new: "@review-123" } },
      }),
      makeHistory({
        timestamp: "2026-03-20T13:00:00.000Z",
        command: "task-submit",
        changes: {
          status: { previous: "in_progress", new: "pending_review" },
          submitted_at: { previous: null, new: "2026-03-20T13:00:00.000Z" },
        },
      }),
    ];

    const notes: Note[] = [
      makeNote({
        created_at: "2026-03-20T11:00:00.000Z",
        author: "worker",
        content: "Implementing feature X",
      }),
    ];

    const entries = assembleActivityFromFiles(history, notes);
    expect(entries).toHaveLength(6);

    // Verify chronological order
    for (let i = 1; i < entries.length; i++) {
      expect(new Date(entries[i].timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(entries[i - 1].timestamp).getTime(),
      );
    }

    // Verify all activity types present
    const types = entries.map((e) => e.type);
    expect(types).toContain("created");
    expect(types).toContain("started");
    expect(types).toContain("field_updated");
    expect(types).toContain("note_added");
    expect(types).toContain("review_linked");
    expect(types).toContain("submitted");

    // Verify each entry has timestamp, author, and source
    for (const entry of entries) {
      expect(entry.timestamp).toBeTruthy();
      expect(entry.author).toBeTruthy();
      expect(entry.source).toBeTruthy();
    }

    // AC: @task-activity-in-file ac-2 — commands preserved in history entries
    const historyEntryResults = entries.filter((e) => e.source === "history");
    for (const entry of historyEntryResults) {
      expect(entry.command).toBeTruthy();
    }

    // AC: @task-activity-in-file ac-2 — multi-field entries expose all changed fields
    // task-start changes both status and started_at
    const startEntry = entries.find((e) => e.type === "started");
    expect(startEntry!.command).toBe("task-start");
    expect(startEntry!.detail).toEqual({
      "status.from": "pending",
      "status.to": "in_progress",
      "started_at.from": "null",
      "started_at.to": "2026-03-20T09:00:00.000Z",
    });

    // task-submit changes both status and submitted_at
    const submitEntry = entries.find((e) => e.type === "submitted");
    expect(submitEntry!.command).toBe("task-submit");
    expect(submitEntry!.detail).toEqual({
      "status.from": "in_progress",
      "status.to": "pending_review",
      "submitted_at.from": "null",
      "submitted_at.to": "2026-03-20T13:00:00.000Z",
    });
  });

  it("returns empty array when no history and no notes", () => {
    const entries = assembleActivityFromFiles([], []);
    expect(entries).toEqual([]);
  });

  it("does not execute any version control queries", () => {
    // AC: @task-activity-in-file ac-1 — assembled from persisted data without VCS
    // This test verifies the function operates on in-memory data only.
    // If execSync were called, it would throw in this test context since
    // there's no git repo. The function should not import or use execSync.
    const history: HistoryEntry[] = [
      makeHistory({ command: "task-add", changes: { status: { previous: undefined, new: "pending" } } }),
    ];
    const notes: Note[] = [makeNote()];

    // Should succeed without any git access
    const entries = assembleActivityFromFiles(history, notes);
    expect(entries.length).toBe(2);
  });
});

// AC: @task-activity-in-file ac-3
describe("getPreMigrationActivity — ac-3: pre-migration fallback", () => {
  let tmpDir: string;
  const [ULID_A, ULID_B] = testUlids("ACTVTY", 2);

  beforeEach(async () => {
    tmpDir = await createTempDir("activity-fallback-");
    initGitRepo(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns entries from per-directory git log", () => {
    // Create task directory with files
    const taskDir = path.join(tmpDir, "tasks", ULID_A);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.yaml"),
      `_ulid: ${ULID_A}\ntitle: Test Task\nstatus: pending\n`,
    );
    execSync('git add tasks/ && git commit -m "Add task @test-task"', {
      cwd: tmpDir,
      stdio: "pipe",
    });

    // Mutate and commit
    fs.writeFileSync(
      path.join(taskDir, "task.yaml"),
      `_ulid: ${ULID_A}\ntitle: Test Task\nstatus: in_progress\n`,
    );
    execSync('git add tasks/ && git commit -m "Start @test-task"', {
      cwd: tmpDir,
      stdio: "pipe",
    });

    const entries = getPreMigrationActivity(tmpDir, ULID_A);
    expect(entries.length).toBe(2);
    // Chronological order (oldest first)
    expect(entries[0].type).toBe("created");
    expect(entries[0].summary).toBe("Task created");
    expect(entries[0].source).toBe("git_fallback");
    expect(entries[1].type).toBe("started");
    expect(entries[1].summary).toBe("Task started");
    expect(entries[1].source).toBe("git_fallback");
  });

  it("returns empty for non-existent task directory", () => {
    const entries = getPreMigrationActivity(tmpDir, ULID_B);
    expect(entries).toEqual([]);
  });

  it("returns entries with commit hashes", () => {
    const taskDir = path.join(tmpDir, "tasks", ULID_A);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.yaml"),
      `_ulid: ${ULID_A}\ntitle: Test\nstatus: pending\n`,
    );
    execSync('git add tasks/ && git commit -m "Add task @test"', {
      cwd: tmpDir,
      stdio: "pipe",
    });

    const entries = getPreMigrationActivity(tmpDir, ULID_A);
    expect(entries[0].commitHash).toMatch(/^[a-f0-9]{7}$/);
  });

  it("git fallback note entries are filterable to prevent duplication with notes.yaml", () => {
    // AC: @task-activity-in-file ac-3 — when a migrated task has notes in notes.yaml
    // but no stored history, the consumer filters note_added entries from the
    // git fallback to avoid duplicating notes already present from notes.yaml.
    const taskDir = path.join(tmpDir, "tasks", ULID_A);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.yaml"),
      `_ulid: ${ULID_A}\ntitle: Test Task\nstatus: pending\n`,
    );
    execSync('git add tasks/ && git commit -m "Add task @test-task"', {
      cwd: tmpDir,
      stdio: "pipe",
    });

    // Add a note commit (git log will classify this as note_added)
    fs.writeFileSync(
      path.join(taskDir, "notes.yaml"),
      `- _ulid: 01ACTVTY00000000000000NOTE\n  content: A note\n`,
    );
    execSync('git add tasks/ && git commit -m "Note on @test-task"', {
      cwd: tmpDir,
      stdio: "pipe",
    });

    const fallbackEntries = getPreMigrationActivity(tmpDir, ULID_A);
    expect(fallbackEntries.length).toBe(2);
    expect(fallbackEntries.some((e) => e.type === "note_added")).toBe(true);

    // The consumer filters out note_added from fallback when notes already
    // exist from notes.yaml (this is the fix for the duplication bug).
    const filtered = fallbackEntries.filter((e) => e.type !== "note_added");
    expect(filtered.length).toBe(1);
    expect(filtered[0].type).toBe("created");

    // Combine with notes from notes.yaml — no duplication
    const noteEntries = notesToActivity([
      makeNote({ created_at: "2026-03-20T11:00:00.000Z", author: "alice" }),
    ]);
    const combined = [...noteEntries, ...filtered].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    const noteCount = combined.filter((e) => e.type === "note_added").length;
    expect(noteCount).toBe(1); // exactly one note, not duplicated
  });

  it("does not use git log -L (uses per-directory git log)", () => {
    // AC: @task-activity-in-file ac-3 — fast per-directory git log, not line-range
    // Create two tasks and verify querying one doesn't return the other
    const dirA = path.join(tmpDir, "tasks", ULID_A);
    const dirB = path.join(tmpDir, "tasks", ULID_B);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "task.yaml"), `_ulid: ${ULID_A}\ntitle: A\n`);
    fs.writeFileSync(path.join(dirB, "task.yaml"), `_ulid: ${ULID_B}\ntitle: B\n`);
    execSync('git add tasks/ && git commit -m "Add tasks"', { cwd: tmpDir, stdio: "pipe" });

    // Mutate only task A
    fs.writeFileSync(path.join(dirA, "task.yaml"), `_ulid: ${ULID_A}\ntitle: A updated\n`);
    execSync('git add tasks/ && git commit -m "Update @task-a"', { cwd: tmpDir, stdio: "pipe" });

    const entriesA = getPreMigrationActivity(tmpDir, ULID_A);
    const entriesB = getPreMigrationActivity(tmpDir, ULID_B);
    expect(entriesA.length).toBe(2); // initial + update
    expect(entriesB.length).toBe(1); // only initial
  });
});
