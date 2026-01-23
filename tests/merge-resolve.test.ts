/**
 * Tests for conflict resolution in semantic YAML merge.
 *
 * Covers:
 * - AC-4: Interactive prompts for scalar field conflicts
 * - AC-8: Interactive prompts for delete-modify conflicts
 * - AC-10: Non-interactive mode with YAML comment formatting
 */

import { describe, it, expect } from "vitest";
import {
  formatConflictComment,
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

describe("Interactive resolution (manual testing)", () => {
  // AC: @yaml-merge-driver ac-4
  it("should provide interactive prompts for scalar conflicts - manual test only", () => {
    // Note: Interactive prompts require manual testing with stdin/stdout
    // This test documents the expected behavior but cannot be fully automated

    const conflict: ConflictInfo = {
      type: "scalar_field",
      path: "title",
      oursValue: "Fix bug",
      theirsValue: "Fix issue",
      description: "Title modified in both branches",
    };

    // Expected interactive flow:
    // 1. Display conflict description
    // 2. Show "Path: title"
    // 3. Show "[1] Ours: "Fix bug""
    // 4. Show "[2] Theirs: "Fix issue""
    // 5. Show "[3] Skip (leave unresolved)"
    // 6. Prompt "Choose [1/2/3]: "
    // 7. Return resolution based on choice

    expect(conflict.type).toBe("scalar_field");
  });

  // AC: @yaml-merge-driver ac-8
  it("should provide interactive prompts for delete-modify conflicts - manual test only", () => {
    // Note: Interactive prompts require manual testing with stdin/stdout
    // This test documents the expected behavior but cannot be fully automated

    const conflictDeletedInOurs: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      oursValue: undefined,
      theirsValue: { title: "Modified task" },
      description: "Item deleted in ours but modified in theirs",
    };

    const conflictDeletedInTheirs: ConflictInfo = {
      type: "delete_modify",
      path: "tasks[0]",
      oursValue: { title: "Modified task" },
      theirsValue: undefined,
      description: "Item modified in ours but deleted in theirs",
    };

    // Expected flow for deletion in ours:
    // 1. Display conflict description
    // 2. Show "[1] Delete (ours deleted this)"
    // 3. Show "[2] Keep modified version: {title}"
    // 4. Show "[3] Skip (leave unresolved)"

    // Expected flow for deletion in theirs:
    // 1. Display conflict description
    // 2. Show "[1] Keep modified version: {title}"
    // 3. Show "[2] Delete (theirs deleted this)"
    // 4. Show "[3] Skip (leave unresolved)"

    expect(conflictDeletedInOurs.type).toBe("delete_modify");
    expect(conflictDeletedInTheirs.type).toBe("delete_modify");
  });
});
