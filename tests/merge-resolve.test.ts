/**
 * Tests for conflict resolution in semantic YAML merge.
 *
 * Covers:
 * - AC-4: Interactive prompts for scalar field conflicts
 * - AC-8: Interactive prompts for delete-modify conflicts
 * - AC-10: Non-interactive mode with YAML comment formatting
 */

import { describe, it, expect, vi } from "vitest";
import {
  formatConflictComment,
  promptScalarConflict,
  promptDeleteModifyConflict,
  type ConflictInfo,
} from "../src/merge/index.js";

describe("formatConflictComment", () => {
  // AC: @yaml-merge-driver ac-10
  it("should format scalar field conflict as YAML comments", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "title",
      oursValue: "Fix authentication bug",
      theirsValue: "Fix auth issue",
      description: 'Field "title" modified with different values in both branches',
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toEqual([
      '# CONFLICT: Field "title" modified with different values in both branches',
      "# Path: title",
      '# Ours:   "Fix authentication bug"',
      '# Theirs: "Fix auth issue"',
      "# Resolution: Using ours (run merge interactively to resolve)",
    ]);
  });

  // AC: @yaml-merge-driver ac-10
  it("should format nested path conflicts", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "tasks[0].priority",
      ulid: "01TASK000000000000000000",
      oursValue: 1,
      theirsValue: 2,
      description: 'Field "priority" modified with different values in both branches',
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain("# Path: tasks[0].priority");
    expect(lines).toContain("# ULID: 01TASK000000000000000000");
    expect(lines).toContain("# Ours:   1");
    expect(lines).toContain("# Theirs: 2");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format delete-modify conflict with deletion in ours", () => {
    const conflict: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      ulid: "01TASK000000000000000000",
      oursValue: undefined,
      theirsValue: { _ulid: "01TASK000000000000000000", title: "Modified task" },
      description: "Item deleted in ours but modified in theirs",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain("# Ours:   <deleted>");
    expect(lines).toContain("# Theirs: {2 fields}");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format delete-modify conflict with deletion in theirs", () => {
    const conflict: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      ulid: "01TASK000000000000000000",
      oursValue: { _ulid: "01TASK000000000000000000", title: "Modified task" },
      theirsValue: undefined,
      description: "Item modified in ours but deleted in theirs",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain("# Ours:   {2 fields}");
    expect(lines).toContain("# Theirs: <deleted>");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format array values concisely", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "tags",
      oursValue: ["feature", "bug", "priority"],
      theirsValue: ["feature", "enhancement"],
      description: "Array field modified in both branches",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain('# Ours:   ["feature", "bug", "priority"]');
    expect(lines).toContain('# Theirs: ["feature", "enhancement"]');
  });

  // AC: @yaml-merge-driver ac-10
  it("should format large arrays with item count", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "items",
      oursValue: Array(10).fill("item"),
      theirsValue: Array(20).fill("item"),
      description: "Array field modified in both branches",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain("# Ours:   [10 items]");
    expect(lines).toContain("# Theirs: [20 items]");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format object values with field names for single field", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "metadata",
      oursValue: { author: "alice" },
      theirsValue: { timestamp: 123 },
      description: "Object field modified in both branches",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain("# Ours:   {author}");
    expect(lines).toContain("# Theirs: {timestamp}");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format large objects with field count", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "config",
      oursValue: {
        field1: 1,
        field2: 2,
        field3: 3,
        field4: 4,
        field5: 5,
      },
      theirsValue: {
        field1: 1,
        field2: 2,
      },
      description: "Object field modified in both branches",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain("# Ours:   {5 fields}");
    expect(lines).toContain("# Theirs: {2 fields}");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format null values", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "description",
      oursValue: "Some description",
      theirsValue: null,
      description: "Field set to null in theirs",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain('# Ours:   "Some description"');
    expect(lines).toContain("# Theirs: null");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format boolean values", () => {
    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "enabled",
      oursValue: true,
      theirsValue: false,
      description: "Boolean field modified in both branches",
    };

    const lines = formatConflictComment(conflict);

    expect(lines).toContain("# Ours:   true");
    expect(lines).toContain("# Theirs: false");
  });

  // AC: @yaml-merge-driver ac-10
  it("should format empty arrays and objects", () => {
    const conflict1: ConflictInfo = {
      type: "scalar_field",
      path: "tags",
      oursValue: [],
      theirsValue: ["tag1"],
      description: "Empty array vs populated",
    };

    const conflict2: ConflictInfo = {
      type: "scalar_field",
      path: "metadata",
      oursValue: {},
      theirsValue: { key: "value" },
      description: "Empty object vs populated",
    };

    const lines1 = formatConflictComment(conflict1);
    const lines2 = formatConflictComment(conflict2);

    expect(lines1).toContain("# Ours:   []");
    expect(lines1).toContain('# Theirs: ["tag1"]');

    expect(lines2).toContain("# Ours:   {}");
    expect(lines2).toContain("# Theirs: {key}");
  });
});

describe("promptScalarConflict", () => {
  // AC: @yaml-merge-driver ac-4
  it("should resolve conflict with user choice 'ours'", async () => {
    // Mock readline to simulate user input
    const mockQuestion = vi.fn().mockResolvedValue("1");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "title",
      oursValue: "Fix bug",
      theirsValue: "Fix issue",
      description: "Title modified in both branches",
    };

    const result = await promptScalarConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("ours");
    expect(result.value).toBe("Fix bug");
    expect(result.conflict).toEqual(conflict);
    expect(mockQuestion).toHaveBeenCalledWith("\nChoose [1/2/3]: ");
    expect(mockClose).toHaveBeenCalled();
  });

  // AC: @yaml-merge-driver ac-4
  it("should resolve conflict with user choice 'theirs'", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("2");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "tasks[0].priority",
      oursValue: 1,
      theirsValue: 2,
      description: "Priority modified with different values",
    };

    const result = await promptScalarConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("theirs");
    expect(result.value).toBe(2);
    expect(result.conflict).toEqual(conflict);
    expect(mockClose).toHaveBeenCalled();
  });

  // AC: @yaml-merge-driver ac-4
  it("should skip conflict with user choice 'skip'", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("3");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "description",
      oursValue: "Old description",
      theirsValue: "New description",
      description: "Description changed",
    };

    const result = await promptScalarConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("skip");
    expect(result.value).toBeUndefined();
    expect(mockClose).toHaveBeenCalled();
  });

  // AC: @yaml-merge-driver ac-4
  it("should default to skip for invalid input", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("invalid");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "status",
      oursValue: "active",
      theirsValue: "completed",
      description: "Status conflict",
    };

    const result = await promptScalarConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("skip");
    expect(mockClose).toHaveBeenCalled();
  });
});

describe("promptDeleteModifyConflict", () => {
  // AC: @yaml-merge-driver ac-8
  it("should handle deletion in ours - choose delete", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("1");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      oursValue: undefined, // Deleted in ours
      theirsValue: { title: "Modified task" },
      description: "Item deleted in ours but modified in theirs",
    };

    const result = await promptDeleteModifyConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("ours");
    expect(result.value).toBeUndefined();
    expect(result.conflict).toEqual(conflict);
    expect(mockClose).toHaveBeenCalled();
  });

  // AC: @yaml-merge-driver ac-8
  it("should handle deletion in ours - keep modified", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("2");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      oursValue: undefined, // Deleted in ours
      theirsValue: { title: "Modified task" },
      description: "Item deleted in ours but modified in theirs",
    };

    const result = await promptDeleteModifyConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("theirs");
    expect(result.value).toEqual({ title: "Modified task" });
    expect(mockClose).toHaveBeenCalled();
  });

  // AC: @yaml-merge-driver ac-8
  it("should handle deletion in theirs - keep modified", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("1");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      oursValue: { title: "Modified task" },
      theirsValue: undefined, // Deleted in theirs
      description: "Item modified in ours but deleted in theirs",
    };

    const result = await promptDeleteModifyConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("ours");
    expect(result.value).toEqual({ title: "Modified task" });
    expect(mockClose).toHaveBeenCalled();
  });

  // AC: @yaml-merge-driver ac-8
  it("should handle deletion in theirs - choose delete", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("2");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      oursValue: { title: "Modified task" },
      theirsValue: undefined, // Deleted in theirs
      description: "Item modified in ours but deleted in theirs",
    };

    const result = await promptDeleteModifyConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("theirs");
    expect(result.value).toBeUndefined();
    expect(mockClose).toHaveBeenCalled();
  });

  // AC: @yaml-merge-driver ac-8
  it("should skip conflict when user chooses skip", async () => {
    const mockQuestion = vi.fn().mockResolvedValue("3");
    const mockClose = vi.fn();

    const mockCreateInterface = vi.fn(() => ({
      question: mockQuestion,
      close: mockClose,
    })) as any;

    const conflict: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      oursValue: undefined,
      theirsValue: { title: "Modified task" },
      description: "Item deleted in ours but modified in theirs",
    };

    const result = await promptDeleteModifyConflict(conflict, mockCreateInterface);

    expect(result.choice).toBe("skip");
    expect(result.value).toBeUndefined();
    expect(mockClose).toHaveBeenCalled();
  });
});
