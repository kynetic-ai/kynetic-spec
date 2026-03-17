import { describe, expect, it } from "vitest";
import * as YAML from "yaml";
import { toYaml, canonicalKeyComparator } from "../src/parser/yaml.js";
import type { Pair } from "yaml";

/**
 * Helper: extract top-level keys from a YAML string in order.
 */
function extractTopLevelKeys(yamlStr: string): string[] {
  const doc = YAML.parseDocument(yamlStr);
  const map = doc.contents;
  if (!YAML.isMap(map)) return [];
  return map.items.map((pair) => String(pair.key));
}

/**
 * Helper: extract keys from the first item in a YAML array field.
 */
function extractFirstItemKeys(yamlStr: string, arrayField: string): string[] {
  const parsed = YAML.parse(yamlStr);
  const arr = parsed[arrayField];
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return Object.keys(arr[0]);
}

/**
 * Helper: create a Pair-like object for testing the comparator directly.
 */
function makePair(key: string): Pair {
  return { key, value: null } as unknown as Pair;
}

describe("canonical key ordering", () => {
  // AC: @yaml-serialization-invariants ac-1
  describe("_ulid is always first", () => {
    it("places _ulid first in a flat record", () => {
      const obj = {
        title: "Test",
        status: "pending",
        _ulid: "01JHNKAB01TASK100000000000",
        type: "task",
      };
      const yaml = toYaml(obj);
      const keys = extractTopLevelKeys(yaml);
      expect(keys[0]).toBe("_ulid");
    });

    it("places _ulid first in nested array items", () => {
      const obj = {
        tasks: [
          {
            title: "First task",
            status: "pending",
            _ulid: "01JHNKAB01TASK100000000000",
            type: "task",
          },
          {
            type: "task",
            _ulid: "01JHNKAB01TASK200000000000",
            status: "completed",
            title: "Second task",
          },
        ],
      };
      const yaml = toYaml(obj);
      // Parse and check each item
      const parsed = YAML.parse(yaml);
      for (const task of parsed.tasks) {
        const keys = Object.keys(task);
        expect(keys[0]).toBe("_ulid");
      }
    });

    it("places _ulid first in deeply nested records (notes inside tasks)", () => {
      const obj = {
        tasks: [
          {
            _ulid: "01JHNKAB01TASK100000000000",
            title: "Task with notes",
            notes: [
              {
                content: "A note",
                created_at: "2026-01-01T00:00:00Z",
                _ulid: "01JHNKAB01NOTE100000000000",
                author: "agent",
              },
            ],
          },
        ],
      };
      const yaml = toYaml(obj);
      const parsed = YAML.parse(yaml);
      const noteKeys = Object.keys(parsed.tasks[0].notes[0]);
      expect(noteKeys[0]).toBe("_ulid");
    });
  });

  // AC: @yaml-serialization-invariants ac-2
  describe("canonical stable key ordering", () => {
    it("orders task-like keys by priority tier", () => {
      const obj = {
        automation: "eligible",
        notes: [],
        tags: ["cli"],
        _ulid: "01JHNKAB01TASK100000000000",
        status: "pending",
        title: "Test task",
        description: "A task",
        priority: 2,
        slugs: ["test-task"],
        type: "task",
        spec_ref: "@some-spec",
        created_at: "2026-01-01T00:00:00Z",
      };
      const yaml = toYaml(obj);
      const keys = extractTopLevelKeys(yaml);
      expect(keys).toEqual([
        "_ulid",
        "slugs",
        "title",
        "type",
        "description",
        "spec_ref",
        "status",
        "priority",
        "tags",
        "created_at",
        "notes",
        "automation",
      ]);
    });

    it("sorts unknown keys alphabetically at default tier", () => {
      const obj = {
        zebra: "z",
        _ulid: "01JHNKAB01TASK100000000000",
        alpha: "a",
        title: "Test",
        middle: "m",
      };
      const yaml = toYaml(obj);
      const keys = extractTopLevelKeys(yaml);
      expect(keys).toEqual(["_ulid", "title", "alpha", "middle", "zebra"]);
    });

    it("produces the same order regardless of JS object key insertion order", () => {
      const fields = {
        _ulid: "01JHNKAB01TASK100000000000",
        slugs: ["test"],
        title: "Test",
        type: "task",
        status: "pending",
        tags: ["cli"],
      };

      // Build two objects with different insertion orders
      const obj1 = { ...fields };
      const obj2 = {
        tags: fields.tags,
        status: fields.status,
        type: fields.type,
        title: fields.title,
        slugs: fields.slugs,
        _ulid: fields._ulid,
      };

      const yaml1 = toYaml(obj1);
      const yaml2 = toYaml(obj2);
      expect(yaml1).toBe(yaml2);
    });
  });

  // AC: @yaml-serialization-invariants ac-3
  describe("round-trip stability", () => {
    it("produces identical output when re-serializing parsed YAML", () => {
      const original = {
        tasks: [
          {
            _ulid: "01JHNKAB01TASK100000000000",
            slugs: ["my-task"],
            title: "My Task",
            type: "task",
            description: "A description",
            spec_ref: "@some-spec",
            status: "pending",
            priority: 2,
            tags: ["cli", "schema"],
            created_at: "2026-01-01T00:00:00.000Z",
            notes: [
              {
                _ulid: "01JHNKAB01NOTE100000000000",
                created_at: "2026-01-01T00:00:00.000Z",
                author: "agent",
                content: "Started work",
              },
            ],
          },
        ],
      };

      const yaml1 = toYaml(original);
      const parsed = YAML.parse(yaml1);
      const yaml2 = toYaml(parsed);
      expect(yaml2).toBe(yaml1);
    });

    it("round-trips spec items stably", () => {
      const original = {
        _ulid: "01JHNKAB01SPEC100000000000",
        slugs: ["my-spec"],
        title: "My Spec",
        type: "requirement",
        status: { maturity: "approved" },
        priority: 1,
        tags: ["mvp"],
        description: "A requirement",
        acceptance_criteria: [
          {
            id: "ac-1",
            given: "some precondition",
            when: "action occurs",
            then: "expected result",
          },
        ],
        traits: ["@trait-json-output"],
        created: "2026-01-01",
      };

      const yaml1 = toYaml(original);
      const parsed = YAML.parse(yaml1);
      const yaml2 = toYaml(parsed);
      expect(yaml2).toBe(yaml1);
    });

    it("round-trips inbox items stably", () => {
      const original = {
        inbox: [
          {
            _ulid: "01JHNKAB01INBX100000000000",
            text: "An idea to triage",
            created_at: "2026-01-01T00:00:00.000Z",
            tags: ["feature"],
            added_by: "user",
          },
        ],
      };

      const yaml1 = toYaml(original);
      const parsed = YAML.parse(yaml1);
      const yaml2 = toYaml(parsed);
      expect(yaml2).toBe(yaml1);
    });
  });

  // AC: @yaml-serialization-invariants ac-4
  describe("_ulid-first as record boundary delimiter", () => {
    it("every record in a task list starts with _ulid for regex boundary detection", () => {
      const obj = {
        tasks: [
          {
            title: "First",
            _ulid: "01JHNKAB01TASK100000000000",
            status: "pending",
          },
          {
            status: "completed",
            title: "Second",
            _ulid: "01JHNKAB01TASK200000000000",
          },
          {
            _ulid: "01JHNKAB01TASK300000000000",
            title: "Third",
            status: "in_progress",
          },
        ],
      };
      const yaml = toYaml(obj);
      const lines = yaml.split("\n");

      // Find all lines that start a list item with _ulid
      const recordBoundaries = lines.filter((l) => /^\s*- _ulid:/.test(l));
      expect(recordBoundaries).toHaveLength(3);

      // Verify no task starts with a different key
      const taskItemStarts = lines.filter((l) => /^\s*- \w+:/.test(l));
      for (const line of taskItemStarts) {
        expect(line).toMatch(/^\s*- _ulid:/);
      }
    });

    it("module-level records start with _ulid for boundary detection", () => {
      const obj = {
        title: "Module",
        _ulid: "01JHNKAB01MOD0100000000000",
        type: "module",
        features: [
          {
            type: "feature",
            _ulid: "01JHNKAB01FEAT100000000000",
            title: "Feature A",
          },
        ],
      };
      const yaml = toYaml(obj);
      const lines = yaml.split("\n");

      // Top-level _ulid should be first
      const firstNonEmptyLine = lines.find((l) => l.trim().length > 0);
      expect(firstNonEmptyLine).toMatch(/^_ulid:/);

      // Nested feature should have _ulid first
      const featureLines = lines.filter((l) => /^\s*- _ulid:/.test(l));
      expect(featureLines).toHaveLength(1);
    });
  });

  describe("canonicalKeyComparator", () => {
    it("sorts _ulid before any other key", () => {
      expect(canonicalKeyComparator(makePair("_ulid"), makePair("title"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("_ulid"), makePair("zzz"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("title"), makePair("_ulid"))).toBeGreaterThan(0);
    });

    it("sorts known keys by priority tier", () => {
      expect(canonicalKeyComparator(makePair("slugs"), makePair("title"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("title"), makePair("type"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("type"), makePair("description"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("status"), makePair("priority"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("tags"), makePair("created_at"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("notes"), makePair("automation"))).toBeLessThan(0);
    });

    it("sorts unknown keys alphabetically among themselves", () => {
      expect(canonicalKeyComparator(makePair("alpha"), makePair("beta"))).toBeLessThan(0);
      expect(canonicalKeyComparator(makePair("zebra"), makePair("alpha"))).toBeGreaterThan(0);
    });

    it("returns 0 for identical keys", () => {
      expect(canonicalKeyComparator(makePair("title"), makePair("title"))).toBe(0);
      expect(canonicalKeyComparator(makePair("_ulid"), makePair("_ulid"))).toBe(0);
    });
  });
});
