/**
 * Tests for array merge algorithms.
 */

import { describe, expect, it } from "vitest";
import {
  mergeUlidArrays,
  mergeSetArray,
  normalizeRef,
  detectDeletion,
} from "../src/merge/arrays.js";
import { ReferenceIndex } from "../src/parser/refs.js";
import type { LoadedTask, LoadedSpecItem } from "../src/parser/yaml.js";

describe("mergeUlidArrays", () => {
  it("should merge arrays with items added in both branches", () => {
    // AC: @yaml-merge-driver ac-2
    interface Task {
      _ulid: string;
      title: string;
    }

    const base: Task[] = [
      { _ulid: "01BASE0000000000000000000", title: "Base task" },
    ];

    const ours: Task[] = [
      { _ulid: "01BASE0000000000000000000", title: "Base task" },
      { _ulid: "01OURS0000000000000000000", title: "Ours task" },
    ];

    const theirs: Task[] = [
      { _ulid: "01BASE0000000000000000000", title: "Base task" },
      { _ulid: "01THRS0000000000000000000", title: "Theirs task" },
    ];

    const result = mergeUlidArrays(base, ours, theirs);

    expect(result).toHaveLength(3);
    expect(result.map((t) => t._ulid)).toEqual([
      "01BASE0000000000000000000",
      "01OURS0000000000000000000",
      "01THRS0000000000000000000",
    ]);
  });

  it("should handle append-only arrays (notes) by ULID union", () => {
    // AC: @yaml-merge-driver ac-5
    interface Note {
      _ulid: string;
      content: string;
    }

    const base: Note[] = [
      { _ulid: "01NOTE1000000000000000000", content: "Note 1" },
    ];

    const ours: Note[] = [
      { _ulid: "01NOTE1000000000000000000", content: "Note 1" },
      { _ulid: "01NOTE2000000000000000000", content: "Note 2" },
    ];

    const theirs: Note[] = [
      { _ulid: "01NOTE1000000000000000000", content: "Note 1" },
      { _ulid: "01NOTE3000000000000000000", content: "Note 3" },
    ];

    const result = mergeUlidArrays(base, ours, theirs);

    // All notes should be present
    expect(result).toHaveLength(3);
    expect(result.map((n) => n._ulid)).toContain("01NOTE1000000000000000000");
    expect(result.map((n) => n._ulid)).toContain("01NOTE2000000000000000000");
    expect(result.map((n) => n._ulid)).toContain("01NOTE3000000000000000000");
  });

  it("should preserve ours modifications when item exists in both", () => {
    // AC: @yaml-merge-driver ac-2
    interface Task {
      _ulid: string;
      title: string;
    }

    const base: Task[] = [
      { _ulid: "01TASK0000000000000000000", title: "Original" },
    ];

    const ours: Task[] = [
      { _ulid: "01TASK0000000000000000000", title: "Modified in ours" },
    ];

    const theirs: Task[] = [
      { _ulid: "01TASK0000000000000000000", title: "Modified in theirs" },
    ];

    const result = mergeUlidArrays(base, ours, theirs);

    // Ours should take precedence (field-level conflict will be handled separately)
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Modified in ours");
  });

  it("should handle empty arrays", () => {
    // AC: @yaml-merge-driver ac-2
    interface Task {
      _ulid: string;
      title: string;
    }

    const base: Task[] = [];
    const ours: Task[] = [
      { _ulid: "01OURS0000000000000000000", title: "Ours task" },
    ];
    const theirs: Task[] = [
      { _ulid: "01THRS0000000000000000000", title: "Theirs task" },
    ];

    const result = mergeUlidArrays(base, ours, theirs);

    expect(result).toHaveLength(2);
    expect(result.map((t) => t._ulid)).toEqual([
      "01OURS0000000000000000000",
      "01THRS0000000000000000000",
    ]);
  });

  it("should handle undefined arrays", () => {
    // AC: @yaml-merge-driver ac-2
    interface Task {
      _ulid: string;
      title: string;
    }

    const ours: Task[] = [
      { _ulid: "01OURS0000000000000000000", title: "Ours task" },
    ];

    const result = mergeUlidArrays(undefined, ours, undefined);

    expect(result).toHaveLength(1);
    expect(result[0]._ulid).toBe("01OURS0000000000000000000");
  });

  it("should maintain insertion order (ours first, then theirs additions)", () => {
    // AC: @yaml-merge-driver ac-2
    interface Task {
      _ulid: string;
      title: string;
    }

    const base: Task[] = [];

    const ours: Task[] = [
      { _ulid: "01OURS1000000000000000000", title: "Ours 1" },
      { _ulid: "01OURS2000000000000000000", title: "Ours 2" },
    ];

    const theirs: Task[] = [
      { _ulid: "01THRS1000000000000000000", title: "Theirs 1" },
      { _ulid: "01THRS2000000000000000000", title: "Theirs 2" },
    ];

    const result = mergeUlidArrays(base, ours, theirs);

    expect(result).toHaveLength(4);
    expect(result.map((t) => t._ulid)).toEqual([
      "01OURS1000000000000000000",
      "01OURS2000000000000000000",
      "01THRS1000000000000000000",
      "01THRS2000000000000000000",
    ]);
  });

  it("should include item deleted in ours but kept in theirs (union merge)", () => {
    // AC: @yaml-merge-driver ac-2, ac-8
    // In union merge, items from theirs are included even if deleted in ours
    // Note: ac-8 says this should prompt interactively - that will be future work
    interface Task {
      _ulid: string;
      title: string;
    }

    const base: Task[] = [
      { _ulid: "01TASK0000000000000000000", title: "Task" },
    ];

    const ours: Task[] = []; // deleted in ours

    const theirs: Task[] = [
      { _ulid: "01TASK0000000000000000000", title: "Task modified" },
    ];

    const result = mergeUlidArrays(base, ours, theirs);

    // Union merge: item from theirs should be included
    expect(result).toHaveLength(1);
    expect(result[0]._ulid).toBe("01TASK0000000000000000000");
    expect(result[0].title).toBe("Task modified");
  });
});

describe("mergeSetArray", () => {
  it("should merge set-like arrays (tags) with union", () => {
    // AC: @yaml-merge-driver ac-6
    const base = ["tag1"];
    const ours = ["tag1", "tag2"];
    const theirs = ["tag1", "tag3"];

    const result = mergeSetArray(base, ours, theirs);

    expect(result).toHaveLength(3);
    expect(result).toContain("tag1");
    expect(result).toContain("tag2");
    expect(result).toContain("tag3");
  });

  it("should remove duplicates in set union", () => {
    // AC: @yaml-merge-driver ac-6
    const base = ["tag1"];
    const ours = ["tag1", "tag2", "tag2"]; // duplicate in ours
    const theirs = ["tag1", "tag2"]; // same tag added in theirs

    const result = mergeSetArray(base, ours, theirs);

    expect(result).toHaveLength(2);
    expect(result).toContain("tag1");
    expect(result).toContain("tag2");
  });

  it("should handle depends_on refs", () => {
    // AC: @yaml-merge-driver ac-6
    const base: string[] = [];
    const ours = ["@task-1", "@task-2"];
    const theirs = ["@task-2", "@task-3"]; // @task-2 is common

    const result = mergeSetArray(base, ours, theirs);

    expect(result).toHaveLength(3);
    expect(result).toContain("@task-1");
    expect(result).toContain("@task-2");
    expect(result).toContain("@task-3");
  });

  it("should handle empty arrays", () => {
    // AC: @yaml-merge-driver ac-6
    const result = mergeSetArray([], ["tag1"], []);

    expect(result).toEqual(["tag1"]);
  });

  it("should handle undefined arrays", () => {
    // AC: @yaml-merge-driver ac-6
    const result = mergeSetArray(undefined, ["tag1"], undefined);

    expect(result).toEqual(["tag1"]);
  });

  it("should work with numeric arrays", () => {
    // AC: @yaml-merge-driver ac-6
    const result = mergeSetArray([1], [1, 2], [1, 3]);

    expect(result).toHaveLength(3);
    expect(result).toContain(1);
    expect(result).toContain(2);
    expect(result).toContain(3);
  });
});

describe("detectDeletion", () => {
  it("should detect deletion in ours branch", () => {
    // AC: @yaml-merge-driver ac-8
    const base = new Map([["01TASK0000000000000000000", {}]]);
    const ours = new Map(); // deleted
    const theirs = new Map([
      ["01TASK0000000000000000000", { modified: true }],
    ]);

    const result = detectDeletion("01TASK0000000000000000000", base, ours, theirs);

    expect(result.deletedInOurs).toBe(true);
    expect(result.deletedInTheirs).toBe(false);
    expect(result.modifiedInTheirs).toBe(true);
  });

  it("should detect deletion in theirs branch", () => {
    // AC: @yaml-merge-driver ac-8
    const base = new Map([["01TASK0000000000000000000", {}]]);
    const ours = new Map([
      ["01TASK0000000000000000000", { modified: true }],
    ]);
    const theirs = new Map(); // deleted

    const result = detectDeletion("01TASK0000000000000000000", base, ours, theirs);

    expect(result.deletedInOurs).toBe(false);
    expect(result.deletedInTheirs).toBe(true);
    expect(result.modifiedInOurs).toBe(true);
  });

  it("should detect no deletion when item exists in all versions", () => {
    // AC: @yaml-merge-driver ac-8
    const base = new Map([["01TASK0000000000000000000", {}]]);
    const ours = new Map([["01TASK0000000000000000000", {}]]);
    const theirs = new Map([["01TASK0000000000000000000", {}]]);

    const result = detectDeletion("01TASK0000000000000000000", base, ours, theirs);

    expect(result.deletedInOurs).toBe(false);
    expect(result.deletedInTheirs).toBe(false);
  });

  it("should handle item not in base (new in both branches)", () => {
    // AC: @yaml-merge-driver ac-8
    const base = new Map();
    const ours = new Map([["01TASK0000000000000000000", {}]]);
    const theirs = new Map([["01TASK0000000000000000000", {}]]);

    const result = detectDeletion("01TASK0000000000000000000", base, ours, theirs);

    expect(result.deletedInOurs).toBe(false);
    expect(result.deletedInTheirs).toBe(false);
    expect(result.modifiedInOurs).toBe(false);
    expect(result.modifiedInTheirs).toBe(false);
  });
});

// ============================================================
// Reference Normalization Tests
// AC: @merge-ref-normalization ac-1, ac-2
// ============================================================

/**
 * Helper to create a minimal ReferenceIndex for testing.
 */
function createTestRefIndex(): ReferenceIndex {
  const tasks: LoadedTask[] = [
    {
      _ulid: "01TASKAAAA000000000000000",
      slugs: ["task-one"],
      title: "Task One",
      type: "task",
      status: "pending",
      priority: 2,
      tags: [],
      notes: [],
      todos: [],
      context: [],
      vcs_refs: [],
      blocked_by: [],
      depends_on: [],
      created_at: new Date().toISOString(),
      _sourceFile: "test.yaml",
    },
    {
      _ulid: "01TASKBBBB000000000000001",
      slugs: ["task-two"],
      title: "Task Two",
      type: "task",
      status: "pending",
      priority: 2,
      tags: [],
      notes: [],
      todos: [],
      context: [],
      vcs_refs: [],
      blocked_by: [],
      depends_on: [],
      created_at: new Date().toISOString(),
      _sourceFile: "test.yaml",
    },
  ];
  const items: LoadedSpecItem[] = [];
  return new ReferenceIndex(tasks, items, []);
}

describe("normalizeRef", () => {
  it("should return non-ref strings unchanged", () => {
    // AC: @merge-ref-normalization ac-2
    const refIndex = createTestRefIndex();

    expect(normalizeRef("plain-tag", refIndex)).toBe("plain-tag");
    expect(normalizeRef("another-value", refIndex)).toBe("another-value");
  });

  it("should return numbers unchanged", () => {
    // AC: @merge-ref-normalization ac-2
    const refIndex = createTestRefIndex();

    expect(normalizeRef(42, refIndex)).toBe(42);
    expect(normalizeRef(0, refIndex)).toBe(0);
  });

  it("should normalize slug ref to canonical ULID", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const result = normalizeRef("@task-one", refIndex);

    expect(result).toBe("@01TASKAAAA000000000000000");
  });

  it("should normalize full ULID ref to same form", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const result = normalizeRef("@01TASKAAAA000000000000000", refIndex);

    expect(result).toBe("@01TASKAAAA000000000000000");
  });

  it("should normalize ULID prefix ref to full ULID", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const result = normalizeRef("@01TASKAAAA", refIndex);

    expect(result).toBe("@01TASKAAAA000000000000000");
  });

  it("should keep unresolvable ref as-is", () => {
    // AC: @merge-ref-normalization ac-2
    const refIndex = createTestRefIndex();

    const result = normalizeRef("@nonexistent-task", refIndex);

    expect(result).toBe("@nonexistent-task");
  });

  it("should keep ref as-is when no refIndex provided", () => {
    // AC: @merge-ref-normalization ac-2
    const result = normalizeRef("@task-one", undefined);

    expect(result).toBe("@task-one");
  });
});

describe("mergeSetArray with ref normalization", () => {
  it("should deduplicate refs when one uses @slug and other uses @ULID", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const base: string[] = [];
    const ours = ["@task-one"]; // Uses slug
    const theirs = ["@01TASKAAAA000000000000000"]; // Uses full ULID for same task

    const result = mergeSetArray(base, ours, theirs, refIndex);

    // Should have only one entry, not two
    expect(result).toHaveLength(1);
    // Ours takes precedence for representation
    expect(result[0]).toBe("@task-one");
  });

  it("should keep unresolvable refs as-is without error", () => {
    // AC: @merge-ref-normalization ac-2
    const refIndex = createTestRefIndex();

    const base: string[] = [];
    const ours = ["@nonexistent-task"];
    const theirs = ["@01NONEXJSTENT000000000000"];

    // Should not throw
    const result = mergeSetArray(base, ours, theirs, refIndex);

    // Both should be present (couldn't resolve, so treated as distinct)
    expect(result).toHaveLength(2);
    expect(result).toContain("@nonexistent-task");
    expect(result).toContain("@01NONEXJSTENT000000000000");
  });

  it("should work without refIndex (backward compatibility)", () => {
    // Existing behavior when no refIndex provided
    const base: string[] = [];
    const ours = ["@task-one"];
    const theirs = ["@01TASKAAAA000000000000000"];

    // No refIndex - should treat as distinct strings
    const result = mergeSetArray(base, ours, theirs);

    expect(result).toHaveLength(2);
  });

  it("should handle mixed refs and non-refs in same array", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const base: string[] = [];
    const ours = ["@task-one", "plain-tag"];
    const theirs = ["@01TASKAAAA000000000000000", "another-tag"];

    const result = mergeSetArray(base, ours, theirs, refIndex);

    // Should have 3: one task ref (deduplicated) + two tags
    expect(result).toHaveLength(3);
    expect(result).toContain("@task-one");
    expect(result).toContain("plain-tag");
    expect(result).toContain("another-tag");
  });

  it("should handle ULID prefix refs", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const base: string[] = [];
    const ours = ["@task-one"];
    const theirs = ["@01TASKAAAA"]; // ULID prefix

    const result = mergeSetArray(base, ours, theirs, refIndex);

    // Should deduplicate - both resolve to same item
    expect(result).toHaveLength(1);
  });

  it("should prefer ours representation when both resolve to same ref", () => {
    // AC: @merge-ref-normalization ac-1 - verify ours precedence
    const refIndex = createTestRefIndex();

    const base: string[] = [];
    const ours = ["@01TASKAAAA000000000000000"]; // Full ULID
    const theirs = ["@task-one"]; // Slug

    const result = mergeSetArray(base, ours, theirs, refIndex);

    expect(result).toHaveLength(1);
    // Ours form should be preserved
    expect(result[0]).toBe("@01TASKAAAA000000000000000");
  });

  it("should deduplicate multiple refs pointing to different items", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const base: string[] = [];
    const ours = ["@task-one", "@task-two"];
    const theirs = ["@01TASKAAAA000000000000000", "@01TASKBBBB000000000000001"];

    const result = mergeSetArray(base, ours, theirs, refIndex);

    // Should have 2 items (each pair deduplicated)
    expect(result).toHaveLength(2);
    expect(result).toContain("@task-one");
    expect(result).toContain("@task-two");
  });

  it("should handle all refs being the same item", () => {
    // AC: @merge-ref-normalization ac-1
    const refIndex = createTestRefIndex();

    const base: string[] = [];
    const ours = ["@task-one", "@01TASKAAAA000000000000000"];
    const theirs = ["@01TASKAAAA", "@task-one"];

    const result = mergeSetArray(base, ours, theirs, refIndex);

    // All resolve to same item - should be just 1
    expect(result).toHaveLength(1);
    // First occurrence wins (ours: @task-one)
    expect(result[0]).toBe("@task-one");
  });
});
