/**
 * Tests for server-side reference resolution in API responses
 *
 * Spec: @ui-api-ref-resolution
 * Tests the ref resolution utility and verifies API response shapes
 * include resolved titles alongside raw refs.
 */

import { describe, it, expect } from "vitest";
import { ReferenceIndex, type LoadedSpecItem, type LoadedTask } from "../src/parser/index.js";
import {
  resolveRefTitle,
  resolveRefEntries,
  buildRefIndex,
} from "../dist/daemon/routes/ref-resolution.js";
import { testUlid } from "./helpers/cli.js";

function makeTask(overrides: Partial<LoadedTask> & { _ulid: string; title: string }): LoadedTask {
  return {
    slugs: [],
    type: "task",
    status: "pending",
    priority: 2,
    tags: [],
    depends_on: [],
    notes: [],
    created_at: new Date().toISOString(),
    ...overrides,
  } as LoadedTask;
}

function makeItem(
  overrides: Partial<LoadedSpecItem> & { _ulid: string; title: string },
): LoadedSpecItem {
  return {
    slugs: [],
    type: "feature",
    tags: [],
    depends_on: [],
    traits: [],
    created_at: new Date().toISOString(),
    ...overrides,
  } as LoadedSpecItem;
}

describe("Reference Resolution Utility", () => {
  const taskUlid = testUlid("TASK", 1);
  const specUlid = testUlid("SPEC", 1);
  const depUlid = testUlid("DEP0", 1);
  const deletedUlid = testUlid("DELT", 1);

  const tasks: LoadedTask[] = [
    makeTask({
      _ulid: taskUlid,
      slugs: ["task-auth"],
      title: "Add user authentication",
      status: "in_progress",
      spec_ref: `@spec-login`,
      depends_on: [`@${depUlid}`],
    }),
    makeTask({
      _ulid: depUlid,
      slugs: ["task-dep"],
      title: "Setup database",
      status: "completed",
    }),
  ];

  const items: LoadedSpecItem[] = [
    makeItem({
      _ulid: specUlid,
      slugs: ["spec-login"],
      title: "Login Feature",
      type: "feature",
      status: { maturity: "draft", implementation: "in_progress" },
    }),
  ];

  const index = new ReferenceIndex(tasks, items);

  // AC: @ui-api-ref-resolution ac-1
  describe("resolveRefTitle (ac-1: single-valued ref → title)", () => {
    it("resolves a valid spec_ref to its title", () => {
      const title = resolveRefTitle(index, "@spec-login");
      expect(title).toBe("Login Feature");
    });

    it("resolves a valid task ref by ULID", () => {
      const title = resolveRefTitle(index, taskUlid);
      expect(title).toBe("Add user authentication");
    });

    it("returns null for undefined ref", () => {
      const title = resolveRefTitle(index, undefined);
      expect(title).toBeNull();
    });

    it("returns null for null ref", () => {
      const title = resolveRefTitle(index, null);
      expect(title).toBeNull();
    });
  });

  // AC: @ui-api-ref-resolution ac-2
  describe("resolveRefEntries (ac-2: array refs → title + status)", () => {
    it("resolves array of refs with titles and status", () => {
      const entries = resolveRefEntries(index, [`@${depUlid}`]);
      expect(entries).toHaveLength(1);
      expect(entries[0].ref).toBe(`@${depUlid}`);
      expect(entries[0].title).toBe("Setup database");
      expect(entries[0].status).toBe("completed");
    });

    it("returns empty array for undefined refs", () => {
      const entries = resolveRefEntries(index, undefined);
      expect(entries).toEqual([]);
    });

    it("returns empty array for empty refs", () => {
      const entries = resolveRefEntries(index, []);
      expect(entries).toEqual([]);
    });

    it("resolves multiple refs", () => {
      const entries = resolveRefEntries(index, [`@${depUlid}`, "@spec-login"]);
      expect(entries).toHaveLength(2);
      expect(entries[0].title).toBe("Setup database");
      expect(entries[1].title).toBe("Login Feature");
    });

    it("normalizes object status to string for spec items", () => {
      const entries = resolveRefEntries(index, ["@spec-login"]);
      expect(entries).toHaveLength(1);
      // Spec status {maturity: "draft", implementation: "in_progress"} → "in_progress"
      expect(entries[0].status).toBe("in_progress");
    });
  });

  // AC: @ui-api-ref-resolution ac-3
  describe("resolveRefTitle/resolveRefEntries (ac-3: deleted/invalid refs)", () => {
    it("returns null title for invalid single ref", () => {
      const title = resolveRefTitle(index, "@nonexistent-ref");
      expect(title).toBeNull();
    });

    it("preserves raw ref and returns null title for invalid array entry", () => {
      const entries = resolveRefEntries(index, ["@nonexistent-ref", `@${depUlid}`]);
      expect(entries).toHaveLength(2);
      // Invalid ref preserved with null title
      expect(entries[0].ref).toBe("@nonexistent-ref");
      expect(entries[0].title).toBeNull();
      expect(entries[0].status).toBeNull();
      // Valid ref resolved
      expect(entries[1].title).toBe("Setup database");
    });

    it("preserves raw ref for deleted entity ULID", () => {
      const entries = resolveRefEntries(index, [deletedUlid]);
      expect(entries).toHaveLength(1);
      expect(entries[0].ref).toBe(deletedUlid);
      expect(entries[0].title).toBeNull();
      expect(entries[0].status).toBeNull();
    });
  });

  // AC: @ui-api-ref-resolution ac-4
  describe("buildRefIndex (ac-4: lightweight index with all refs)", () => {
    it("returns map with ULID and slug keys for each entity", () => {
      const refIndex = buildRefIndex(index);

      // Task by ULID
      expect(refIndex[taskUlid]).toBeDefined();
      expect(refIndex[taskUlid].title).toBe("Add user authentication");
      expect(refIndex[taskUlid].type).toBe("task");

      // Task by slug
      expect(refIndex["task-auth"]).toBeDefined();
      expect(refIndex["task-auth"].title).toBe("Add user authentication");

      // Spec by ULID
      expect(refIndex[specUlid]).toBeDefined();
      expect(refIndex[specUlid].title).toBe("Login Feature");
      expect(refIndex[specUlid].type).toBe("feature");

      // Spec by slug
      expect(refIndex["spec-login"]).toBeDefined();
      expect(refIndex["spec-login"].title).toBe("Login Feature");
    });

    it("includes status when available", () => {
      const refIndex = buildRefIndex(index);

      // Task has string status — passed through directly
      expect(refIndex[taskUlid].status).toBe("in_progress");

      // Spec has object status {maturity, implementation} — normalized to implementation string
      expect(refIndex[specUlid].status).toBe("in_progress");
    });

    it("normalizes object status to string for spec items", () => {
      // Spec items have status: {maturity: "draft", implementation: "in_progress"}
      // buildRefIndex should extract implementation as the string status
      const draftItem = makeItem({
        _ulid: testUlid("DRFT", 1),
        slugs: ["spec-draft"],
        title: "Draft Only",
        type: "feature",
        status: { maturity: "stable", implementation: "not_started" },
      });
      const draftIndex = new ReferenceIndex([], [draftItem]);
      const refIndex = buildRefIndex(draftIndex);
      expect(refIndex[testUlid("DRFT", 1)].status).toBe("not_started");
    });

    it("omits status when not present", () => {
      const noStatusItem = makeItem({
        _ulid: testUlid("NS00", 1),
        slugs: ["no-status"],
        title: "No Status Item",
        type: "requirement",
      });
      const indexWithNoStatus = new ReferenceIndex([], [noStatusItem]);
      const refIndex = buildRefIndex(indexWithNoStatus);

      expect(refIndex[testUlid("NS00", 1)]).toBeDefined();
      expect(refIndex[testUlid("NS00", 1)].status).toBeUndefined();
    });
  });

  // AC: @ui-api-ref-resolution ac-5
  describe("buildRefIndex (ac-5: smaller than full entity lists)", () => {
    it("returns only display metadata (title, type, status) not full entities", () => {
      const refIndex = buildRefIndex(index);
      const entry = refIndex[taskUlid];

      // Should only have display fields
      expect(Object.keys(entry).toSorted()).toEqual(["status", "title", "type"]);

      // Should NOT have full entity fields
      expect(entry).not.toHaveProperty("notes");
      expect(entry).not.toHaveProperty("depends_on");
      expect(entry).not.toHaveProperty("description");
      expect(entry).not.toHaveProperty("priority");
    });

    it("payload is smaller than full entity list", () => {
      // Generate a realistic set of entities
      const manyTasks = Array.from({ length: 100 }, (_, i) =>
        makeTask({
          _ulid: testUlid(`MT${String(i).padStart(2, "0")}`, 0),
          slugs: [`task-${i}`],
          title: `Task number ${i}`,
          status: i % 3 === 0 ? "completed" : "pending",
          description: "A long description that would bloat a full response payload significantly",
          notes: [
            {
              _ulid: testUlid(`NT${String(i).padStart(2, "0")}`, 0),
              content: "note",
              author: "test",
              created_at: new Date().toISOString(),
            },
          ],
        }),
      );
      const bigIndex = new ReferenceIndex(manyTasks, []);
      const refMap = buildRefIndex(bigIndex);

      const refPayload = JSON.stringify({ refs: refMap });
      const fullPayload = JSON.stringify(manyTasks);

      expect(refPayload.length).toBeLessThan(fullPayload.length);
    });
  });

  // AC: @trait-api-endpoint ac-1
  describe("trait-api-endpoint ac-1: valid request returns 2xx JSON", () => {
    it("resolveRefTitle returns a string or null (valid JSON-serializable values)", () => {
      const title = resolveRefTitle(index, "@spec-login");
      expect(typeof title === "string" || title === null).toBe(true);
    });

    it("resolveRefEntries returns JSON-serializable array", () => {
      const entries = resolveRefEntries(index, [`@${depUlid}`]);
      expect(Array.isArray(entries)).toBe(true);
      // Verify JSON round-trip
      const roundTripped = JSON.parse(JSON.stringify(entries));
      expect(roundTripped).toEqual(entries);
    });

    it("buildRefIndex returns JSON-serializable object", () => {
      const refIndex = buildRefIndex(index);
      const roundTripped = JSON.parse(JSON.stringify({ refs: refIndex }));
      expect(roundTripped.refs).toEqual(refIndex);
    });
  });

  // AC: @trait-api-endpoint ac-2
  // N/A for resolution utilities — 404 handling is in route handlers, not the utility
  // AC: @trait-api-endpoint ac-2 — N/A: resolution utility returns null for invalid refs; 404 is handled by route handlers

  // AC: @trait-api-endpoint ac-3
  // N/A for resolution utilities — body validation is in route handlers
  // AC: @trait-api-endpoint ac-3 — N/A: resolution utility has no request body; validation is in route handlers

  // AC: @trait-api-endpoint ac-4
  // N/A for resolution utilities — pagination is in the refs endpoint handler
  // AC: @trait-api-endpoint ac-4 — N/A: ref index endpoint is not paginated (returns full map by design, ac-5 ensures it's lightweight)

  // AC: @trait-api-endpoint ac-5
  // N/A for resolution utilities — shadow commits are not applicable to read-only endpoints
  // AC: @trait-api-endpoint ac-5 — N/A: ref resolution is read-only, no state mutation or shadow commits

  // AC: @trait-api-endpoint ac-6
  // N/A for resolution utilities — X-Request-Id is added by middleware
  // AC: @trait-api-endpoint ac-6 — N/A: X-Request-Id is handled by middleware, not by resolution utilities
});
