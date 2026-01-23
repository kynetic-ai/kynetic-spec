/**
 * Tests for array merge algorithms.
 */

import { describe, expect, it } from "vitest";
import {
  mergeUlidArrays,
  mergeSetArray,
  detectDeletion,
} from "../src/merge/arrays.js";

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
