/**
 * Tests for object merging algorithms
 */

import { describe, expect, it } from "vitest";
import { mergeObjects } from "../src/merge/objects.js";

describe("mergeObjects", () => {
  describe("field additions", () => {
    it("should include field added only in ours", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1 };
      const ours = { a: 1, b: 2 };
      const theirs = { a: 1 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should include field added only in theirs", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1 };
      const ours = { a: 1 };
      const theirs = { a: 1, c: 3 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, c: 3 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should include fields added in both branches", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1 };
      const ours = { a: 1, b: 2 };
      const theirs = { a: 1, c: 3 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2, c: 3 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should not conflict when same field added with same value in both", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1 };
      const ours = { a: 1, b: 2 };
      const theirs = { a: 1, b: 2 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should conflict when same field added with different values in both", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1 };
      const ours = { a: 1, b: 2 };
      const theirs = { a: 1, b: 3 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2 }); // Default to ours
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        type: "scalar_field",
        path: "b",
        oursValue: 2,
        theirsValue: 3,
      });
    });
  });

  describe("field modifications", () => {
    it("should take ours when only ours modified", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1, b: 3 };
      const theirs = { a: 1, b: 2 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 3 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should take theirs when only theirs modified", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1, b: 2 };
      const theirs = { a: 1, b: 4 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 4 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should merge when both sides modify different fields", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2, c: 3 };
      const ours = { a: 10, b: 2, c: 3 };
      const theirs = { a: 1, b: 20, c: 3 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 10, b: 20, c: 3 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should not conflict when both sides make same modification", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1, b: 3 };
      const theirs = { a: 1, b: 3 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 3 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should conflict when both sides modify same field with different values", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1, b: 3 };
      const theirs = { a: 1, b: 4 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 3 }); // Default to ours
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        type: "scalar_field",
        path: "b",
        oursValue: 3,
        theirsValue: 4,
      });
    });
  });

  describe("field deletions", () => {
    it("should omit field deleted in ours when theirs also deleted it", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1 };
      const theirs = { a: 1 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should include field from theirs when deleted in ours but kept in theirs", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1 };
      const theirs = { a: 1, b: 2 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should include field from ours when deleted in theirs but kept in ours", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1, b: 2 };
      const theirs = { a: 1 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should include theirs value when field deleted in ours but modified in theirs", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1 };
      const theirs = { a: 1, b: 3 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 3 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should include ours value when field deleted in theirs but modified in ours", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1, b: 2 };
      const ours = { a: 1, b: 3 };
      const theirs = { a: 1 };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 3 });
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe("nested objects", () => {
    it("should recursively merge nested objects when both sides modify different fields", () => {
      // AC: @yaml-merge-driver ac-7
      const base = {
        task: {
          title: "Task",
          priority: 1,
          status: "pending",
        },
      };

      const ours = {
        task: {
          title: "Updated Task",
          priority: 1,
          status: "pending",
        },
      };

      const theirs = {
        task: {
          title: "Task",
          priority: 2,
          status: "pending",
        },
      };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({
        task: {
          title: "Updated Task",
          priority: 2,
          status: "pending",
        },
      });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should detect conflicts in nested objects", () => {
      // AC: @yaml-merge-driver ac-7
      const base = {
        task: {
          title: "Task",
          priority: 1,
        },
      };

      const ours = {
        task: {
          title: "Task from ours",
          priority: 1,
        },
      };

      const theirs = {
        task: {
          title: "Task from theirs",
          priority: 1,
        },
      };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({
        task: {
          title: "Task from ours", // Default to ours
          priority: 1,
        },
      });
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        type: "scalar_field",
        path: "task.title",
        oursValue: "Task from ours",
        theirsValue: "Task from theirs",
      });
    });

    it("should handle deeply nested objects", () => {
      // AC: @yaml-merge-driver ac-7
      const base = {
        metadata: {
          traceability: {
            origin: "manual",
            created_at: "2024-01-01",
          },
        },
      };

      const ours = {
        metadata: {
          traceability: {
            origin: "manual",
            created_at: "2024-01-01",
            updated_at: "2024-01-02",
          },
        },
      };

      const theirs = {
        metadata: {
          traceability: {
            origin: "manual",
            created_at: "2024-01-01",
            updated_by: "user",
          },
        },
      };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({
        metadata: {
          traceability: {
            origin: "manual",
            created_at: "2024-01-01",
            updated_at: "2024-01-02",
            updated_by: "user",
          },
        },
      });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should merge nested objects added in both branches", () => {
      // AC: @yaml-merge-driver ac-7
      const base = { a: 1 };

      const ours = {
        a: 1,
        nested: {
          b: 2,
        },
      };

      const theirs = {
        a: 1,
        nested: {
          c: 3,
        },
      };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({
        a: 1,
        nested: {
          b: 2,
          c: 3,
        },
      });
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("should handle undefined base", () => {
      // AC: @yaml-merge-driver ac-3
      const ours = { a: 1, b: 2 };
      const theirs = { a: 1, c: 3 };

      const result = mergeObjects(undefined, ours, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2, c: 3 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should handle undefined ours", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1 };
      const theirs = { a: 1, b: 2 };

      const result = mergeObjects(base, undefined, theirs);

      expect(result.merged).toEqual({ a: 1, b: 2 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should handle undefined theirs", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { a: 1 };
      const ours = { a: 1, b: 2 };

      const result = mergeObjects(base, ours, undefined);

      expect(result.merged).toEqual({ a: 1, b: 2 });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should handle all undefined", () => {
      // AC: @yaml-merge-driver ac-3
      const result = mergeObjects(undefined, undefined, undefined);

      expect(result.merged).toEqual({});
      expect(result.conflicts).toHaveLength(0);
    });

    it("should handle empty objects", () => {
      // AC: @yaml-merge-driver ac-3
      const base = {};
      const ours = {};
      const theirs = {};

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({});
      expect(result.conflicts).toHaveLength(0);
    });

    it("should handle arrays in object values (treat as opaque values)", () => {
      // AC: @yaml-merge-driver ac-3
      // Arrays are handled separately by mergeUlidArrays/mergeSetArray
      const base = { tags: ["a", "b"] };
      const ours = { tags: ["a", "b", "c"] };
      const theirs = { tags: ["a", "b"] };

      const result = mergeObjects(base, ours, theirs);

      // Array modified only in ours, so take ours value
      expect(result.merged).toEqual({ tags: ["a", "b", "c"] });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should conflict when arrays differ in both branches", () => {
      // AC: @yaml-merge-driver ac-3
      const base = { tags: ["a"] };
      const ours = { tags: ["a", "b"] };
      const theirs = { tags: ["a", "c"] };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({ tags: ["a", "b"] }); // Default to ours
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        type: "scalar_field",
        path: "tags",
      });
    });
  });

  describe("complex scenarios", () => {
    it("should handle multiple modifications and additions across branches", () => {
      // AC: @yaml-merge-driver ac-3, ac-7
      const base = {
        title: "Original",
        priority: 1,
        metadata: {
          created_at: "2024-01-01",
        },
      };

      const ours = {
        title: "Updated in ours",
        priority: 2,
        status: "in_progress",
        metadata: {
          created_at: "2024-01-01",
          updated_at: "2024-01-02",
        },
      };

      const theirs = {
        title: "Original",
        priority: 1,
        tags: ["bug"],
        metadata: {
          created_at: "2024-01-01",
          author: "user",
        },
      };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({
        title: "Updated in ours",
        priority: 2,
        status: "in_progress",
        tags: ["bug"],
        metadata: {
          created_at: "2024-01-01",
          updated_at: "2024-01-02",
          author: "user",
        },
      });
      expect(result.conflicts).toHaveLength(0);
    });

    it("should handle conflicting modifications at multiple nesting levels", () => {
      // AC: @yaml-merge-driver ac-7
      const base = {
        task: {
          title: "Task",
          metadata: {
            priority: 1,
          },
        },
      };

      const ours = {
        task: {
          title: "Task from ours",
          metadata: {
            priority: 2,
          },
        },
      };

      const theirs = {
        task: {
          title: "Task from theirs",
          metadata: {
            priority: 3,
          },
        },
      };

      const result = mergeObjects(base, ours, theirs);

      expect(result.merged).toEqual({
        task: {
          title: "Task from ours", // Default to ours
          metadata: {
            priority: 2, // Default to ours
          },
        },
      });
      expect(result.conflicts).toHaveLength(2);
      expect(result.conflicts[0].path).toBe("task.title");
      expect(result.conflicts[1].path).toBe("task.metadata.priority");
    });
  });
});
