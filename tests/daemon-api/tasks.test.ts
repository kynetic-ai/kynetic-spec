/**
 * Daemon API Integration Tests for Tasks Endpoints
 *
 * Migrated from tests/e2e/api-tasks.spec.ts (Playwright) to vitest
 * using Elysia app.handle() pattern.
 *
 * Covered ACs:
 * - @api-contract ac-2: GET /api/tasks returns tasks with expected fields
 * - @api-contract ac-3: GET /api/tasks?status filter (multi-value)
 * - @api-contract ac-4: GET /api/tasks pagination {data, meta} envelope
 * - @api-contract ac-5: GET /api/tasks/:ref returns full task with notes, todos, deps
 * - @api-contract ac-6: POST /api/tasks/:ref/start transitions to in_progress
 * - @api-contract ac-7: POST /api/tasks/:ref/note appends note
 * - @api-contract ac-plan-filter-resolve: Plan filter resolves by ULID or slug
 * - @api-contract ac-plan-filter-derived: Tasks in derived_tasks included
 * - @api-contract ac-plan-filter-ref: Tasks with plan_ref included
 * - @api-contract ac-plan-filter-not-found: Plan not found returns empty
 * - @api-contract ac-plan-filter-additive: Plan filter additive with other filters
 */

import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupFixtures,
} from "./helpers.js";

let tempDir: string;
let app: Elysia;

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-tasks-");
  initGitRepo(tempDir);
  setupFixtures(tempDir);
  ({ app } = createTestApp());
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function request(urlPath: string, init?: RequestInit) {
  return makeRequest(app, tempDir, urlPath, init);
}

describe("Tasks API", () => {
  describe("GET /api/tasks", () => {
    // AC: @api-contract ac-2
    it("returns tasks with required fields", async () => {
      const response = await request("/api/tasks");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      const task = body.data[0];
      expect(task).toHaveProperty("_ulid");
      expect(task).toHaveProperty("title");
      expect(task).toHaveProperty("status");
      expect(task).toHaveProperty("priority");
      expect(task).toHaveProperty("notes_count");
    });

    // AC: @api-contract ac-2 - spec_ref field
    it("returns spec_ref on tasks that have it", async () => {
      const response = await request("/api/tasks");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      const taskWithSpecRef = body.data.find(
        (t: { spec_ref?: string }) => t.spec_ref !== undefined && t.spec_ref !== null,
      );
      expect(taskWithSpecRef).toBeDefined();
      expect(typeof taskWithSpecRef.spec_ref).toBe("string");
      expect(taskWithSpecRef.spec_ref).toMatch(/^@/);
    });

    // AC: @api-contract ac-3 - status filter (single value)
    it("filters tasks by single status value", async () => {
      const response = await request("/api/tasks?status=pending");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const task of body.data) {
        expect(task.status).toBe("pending");
      }
    });

    // AC: @api-contract ac-3 - status filter (multi-value, repeated param)
    it("filters tasks by multiple status values using repeated param", async () => {
      const response = await request("/api/tasks?status=pending&status=in_progress");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const task of body.data) {
        expect(["pending", "in_progress"]).toContain(task.status);
      }
    });

    // AC: @api-contract ac-3 - comma-separated status filter
    it("filters tasks by comma-separated status values", async () => {
      const response = await request("/api/tasks?status=pending,in_progress");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const task of body.data) {
        expect(["pending", "in_progress"]).toContain(task.status);
      }
    });

    // AC: @api-contract ac-4 - pagination shape
    it("returns paginated response with {data, meta} envelope", async () => {
      const response = await request("/api/tasks?offset=0&limit=2");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");

      expect(typeof body.meta.total).toBe("number");
      expect(body.meta.offset).toBe(0);
      expect(body.meta.limit).toBe(2);
      expect(body.data.length).toBeLessThanOrEqual(2);
    });

    // AC: @api-contract ac-4 - pagination offset
    it("respects offset parameter for pagination", async () => {
      const page1 = await request("/api/tasks?offset=0&limit=2");
      expect(page1.status).toBe(200);
      const body1 = await page1.json();

      expect(body1.meta.total).toBeGreaterThan(2);
      expect(body1.data.length).toBe(2);

      const page2 = await request("/api/tasks?offset=2&limit=2");
      expect(page2.status).toBe(200);
      const body2 = await page2.json();

      const ids1 = body1.data.map((t: { _ulid: string }) => t._ulid);
      const ids2 = body2.data.map((t: { _ulid: string }) => t._ulid);
      for (const id of ids2) {
        expect(ids1).not.toContain(id);
      }
    });

    // AC: @web-dashboard ac-9 - automation filter
    it("filters tasks by automation=eligible", async () => {
      const response = await request("/api/tasks?automation=eligible");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const task of body.data) {
        expect(task.automation).toBe("eligible");
      }
    });

    // AC: @web-dashboard ac-9 - automation filter needs_review
    it("filters tasks by automation=needs_review", async () => {
      const response = await request("/api/tasks?automation=needs_review");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const task of body.data) {
        expect(task.automation).toBe("needs_review");
      }
    });

    // AC: @web-dashboard ac-9 - automation filter manual_only
    it("filters tasks by automation=manual_only", async () => {
      const response = await request("/api/tasks?automation=manual_only");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);

      for (const task of body.data) {
        expect(task.automation).toBe("manual_only");
      }
    });

    // AC: @api-contract ac-4 - total count is consistent
    it("total count is consistent across paginated requests", async () => {
      const response1 = await request("/api/tasks?offset=0&limit=2");
      const response2 = await request("/api/tasks?offset=2&limit=2");

      const body1 = await response1.json();
      const body2 = await response2.json();

      expect(body1.meta.total).toBe(body2.meta.total);
    });
  });

  describe("GET /api/tasks/:ref", () => {
    // AC: @api-contract ac-5 - resolve by slug
    it("resolves task by slug and returns full task", async () => {
      const response = await request("/api/tasks/@test-task-ready");
      expect(response.status).toBe(200);

      const envelope = await response.json();
      const task = envelope.data;
      expect(task).toHaveProperty("_ulid");
      expect(task).toHaveProperty("title");
      expect(task).toHaveProperty("status");
      expect(task).toHaveProperty("priority");
      expect(task).toHaveProperty("notes");
      expect(task).toHaveProperty("todos");
      expect(task).toHaveProperty("depends_on");
    });

    // AC: @api-contract ac-5 - returns notes array
    it("returns task with notes array", async () => {
      const response = await request("/api/tasks/@test-task-in-progress");
      expect(response.status).toBe(200);

      const envelope = await response.json();
      const task = envelope.data;
      expect(Array.isArray(task.notes)).toBe(true);
      expect(task.notes.length).toBeGreaterThan(0);

      const note = task.notes[0];
      expect(note).toHaveProperty("_ulid");
      expect(note).toHaveProperty("content");
      expect(note).toHaveProperty("created_at");
    });

    // AC: @api-contract ac-5 - returns dependencies
    it("returns task with depends_on array", async () => {
      const response = await request("/api/tasks/@test-task-blocked");
      expect(response.status).toBe(200);

      const envelope = await response.json();
      const task = envelope.data;
      expect(Array.isArray(task.depends_on)).toBe(true);
      expect(task.depends_on.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-5 - resolve by full ULID
    it("resolves task by full ULID", async () => {
      const listResponse = await request("/api/tasks");
      const body = await listResponse.json();
      expect(body.data.length).toBeGreaterThan(0);

      const firstTask = body.data[0];
      expect(firstTask._ulid).toBeTruthy();

      const response = await request(`/api/tasks/@${firstTask._ulid}`);
      expect(response.status).toBe(200);

      const envelope = await response.json();
      const task = envelope.data;
      expect(task._ulid).toBe(firstTask._ulid);
      expect(task.title).toBe(firstTask.title);
    });

    // AC: @review-records-web-ui ac-7 - review_ref exposed in task detail
    it("returns review_ref for task with linked review", async () => {
      const response = await request("/api/tasks/@test-task-pending-review");
      expect(response.status).toBe(200);

      const envelope = await response.json();
      const task = envelope.data;
      expect(task).toHaveProperty("review_ref");
      expect(task.review_ref).toBe("@test-review-open");
    });

    // AC: @review-records-web-ui ac-7 - review_ref null for task without review
    it("returns null review_ref for task without linked review", async () => {
      const response = await request("/api/tasks/@test-task-ready");
      expect(response.status).toBe(200);

      const envelope = await response.json();
      const task = envelope.data;
      expect(task).toHaveProperty("review_ref");
      expect(task.review_ref).toBeNull();
    });

    // AC: @api-contract ac-5 (error handling) - 404 for invalid ref
    it("returns 404 for non-existent task ref", async () => {
      const response = await request("/api/tasks/@nonexistent-task-xyz");
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toBe("not_found");
    });
  });

  describe("POST /api/tasks/:ref/start", () => {
    // AC: @api-contract ac-6 - transition to in_progress
    it("transitions pending task to in_progress", async () => {
      const startResponse = await request("/api/tasks/@test-task-ready/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(startResponse.status).toBe(200);

      const updatedTask = await startResponse.json();
      expect(updatedTask.status).toBe("in_progress");
      expect(updatedTask).toHaveProperty("started_at");
      expect(updatedTask.started_at).toBeTruthy();
    });

    // AC: @api-contract ac-6 - returns full task shape in response
    it("response includes full task shape after start", async () => {
      const startResponse = await request("/api/tasks/@test-task-ready/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(startResponse.status).toBe(200);

      const task = await startResponse.json();
      expect(task).toHaveProperty("_ulid");
      expect(task).toHaveProperty("status");
      expect(task.status).toBe("in_progress");
      expect(task).toHaveProperty("title");
      expect(task).toHaveProperty("started_at");
    });

    // AC: @api-contract ac-6 (error handling) - 404 for invalid ref
    it("returns 404 for non-existent task", async () => {
      const response = await request("/api/tasks/@nonexistent-task-xyz/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });

    // AC: @api-contract ac-6 (error handling) - 409 for already in_progress task
    it("returns 409 with transition info when task is already in_progress", async () => {
      const response = await request("/api/tasks/@test-task-in-progress/start", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(409);

      const body = await response.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toBe("invalid_transition");
      expect(body).toHaveProperty("current");
      expect(body.current).toBe("in_progress");
      expect(body).toHaveProperty("valid_transitions");
      expect(Array.isArray(body.valid_transitions)).toBe(true);
    });
  });

  describe("POST /api/tasks/:ref/note", () => {
    // AC: @api-contract ac-7 - append note
    it("appends note to task and returns {success, note, task}", async () => {
      const noteContent = `Vitest test note ${Date.now()}`;
      const response = await request("/api/tasks/@test-task-in-progress/note", {
        method: "POST",
        body: JSON.stringify({ content: noteContent, author: "@test" }),
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("success");
      expect(body.success).toBe(true);
      expect(body).toHaveProperty("note");
      expect(body).toHaveProperty("task");

      expect(body.note.content).toBe(noteContent);

      expect(Array.isArray(body.task.notes)).toBe(true);
      const addedNote = body.task.notes.find((n: { content: string }) => n.content === noteContent);
      expect(addedNote).toBeDefined();
    });

    // AC: @api-contract ac-7 - note has required fields
    it("created note has _ulid, content, created_at", async () => {
      const noteContent = `Note field check ${Date.now()}`;
      const response = await request("/api/tasks/@test-task-in-progress/note", {
        method: "POST",
        body: JSON.stringify({ content: noteContent }),
      });
      expect(response.status).toBe(200);

      const body = await response.json();
      const note = body.note;

      expect(note).toHaveProperty("_ulid");
      expect(note).toHaveProperty("content");
      expect(note).toHaveProperty("created_at");
      expect(typeof note._ulid).toBe("string");
      expect(note._ulid.length).toBeGreaterThan(0);
      expect(note.content).toBe(noteContent);
    });

    // AC: @api-contract ac-7 (error handling) - 400 for missing content
    // Elysia schema validation fires first; the middleware onError handler
    // normalizes all VALIDATION errors to 400.
    it("returns 400 validation error when content is missing", async () => {
      const response = await request("/api/tasks/@test-task-in-progress/note", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    // AC: @api-contract ac-7 (error handling) - 404 for invalid ref
    it("returns 404 for non-existent task", async () => {
      const response = await request("/api/tasks/@nonexistent-task-xyz/note", {
        method: "POST",
        body: JSON.stringify({ content: "test note" }),
      });
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe("not_found");
    });
  });

  describe("Content-Type and Response Format", () => {
    // AC: @api-contract ac-1 (partial) - JSON content type for GET endpoints
    it("returns JSON content type for GET endpoints", async () => {
      const responses = await Promise.all([
        request("/api/tasks"),
        request("/api/tasks/@test-task-ready"),
      ]);

      for (const response of responses) {
        const contentType = response.headers.get("content-type") || "";
        expect(contentType).toContain("application/json");
      }
    });

    // AC: @api-contract ac-2 - items have consistent shape across list and detail
    it("list and detail responses have consistent task fields", async () => {
      const listResponse = await request("/api/tasks");
      const listBody = await listResponse.json();
      expect(listBody.data.length).toBeGreaterThan(0);

      const listTask = listBody.data[0];
      expect(listTask._ulid).toBeTruthy();

      const detailResponse = await request(`/api/tasks/@${listTask._ulid}`);
      expect(detailResponse.status).toBe(200);
      const detailEnvelope = await detailResponse.json();
      const detailTask = detailEnvelope.data;

      expect(detailTask._ulid).toBe(listTask._ulid);
      expect(detailTask.title).toBe(listTask.title);
      expect(detailTask.status).toBe(listTask.status);
    });
  });

  describe("GET /api/tasks?plan= (plan filter)", () => {
    // AC: @api-contract ac-plan-filter-resolve
    it("resolves plan by slug", async () => {
      const response = await request("/api/tasks?plan=test-plan-active");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.data.length).toBeGreaterThan(0);
    });

    // AC: @api-contract ac-plan-filter-derived
    it("includes tasks in derived_tasks (forward link)", async () => {
      const response = await request("/api/tasks?plan=test-plan-active");
      expect(response.status).toBe(200);

      const body = await response.json();
      const slugs = body.data.flatMap((t: { slugs: string[] }) => t.slugs);
      // test-task-ready is in derived_tasks but has no plan_ref
      expect(slugs).toContain("test-task-ready");
    });

    // AC: @api-contract ac-plan-filter-ref
    it("includes tasks with plan_ref (reverse link)", async () => {
      const response = await request("/api/tasks?plan=test-plan-active");
      expect(response.status).toBe(200);

      const body = await response.json();
      const slugs = body.data.flatMap((t: { slugs: string[] }) => t.slugs);
      // test-task-planref-only has plan_ref but is NOT in derived_tasks
      expect(slugs).toContain("test-task-planref-only");
    });

    // AC: @api-contract ac-plan-filter-derived, ac-plan-filter-ref
    it("uses bidirectional matching (derived_tasks OR plan_ref)", async () => {
      const response = await request("/api/tasks?plan=test-plan-active");
      expect(response.status).toBe(200);

      const body = await response.json();
      const slugs = body.data.flatMap((t: { slugs: string[] }) => t.slugs);
      // test-task-in-progress: in derived_tasks AND has plan_ref (both links)
      expect(slugs).toContain("test-task-in-progress");
      // test-task-ready: in derived_tasks only (forward link)
      expect(slugs).toContain("test-task-ready");
      // test-task-planref-only: has plan_ref only (reverse link)
      expect(slugs).toContain("test-task-planref-only");
      // test-task-blocked: NOT in derived_tasks, NO plan_ref
      expect(slugs).not.toContain("test-task-blocked");
    });

    // AC: @api-contract ac-plan-filter-not-found
    it("returns empty array when plan is not found", async () => {
      const response = await request("/api/tasks?plan=nonexistent-plan");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.data).toEqual([]);
      expect(body.meta.total).toBe(0);
    });

    // AC: @api-contract ac-plan-filter-additive
    it("plan filter is additive with status filter", async () => {
      const response = await request("/api/tasks?plan=test-plan-active&status=in_progress");
      expect(response.status).toBe(200);

      const body = await response.json();
      // Only test-task-in-progress has status=in_progress AND matches plan
      expect(body.data.length).toBe(1);
      const slugs = body.data.flatMap((t: { slugs: string[] }) => t.slugs);
      expect(slugs).toContain("test-task-in-progress");
    });

    // AC: @api-contract ac-plan-filter-resolve
    it("resolves plan by full ULID", async () => {
      const response = await request("/api/tasks?plan=01KG0RRPCA45ZT43W2T6HJMVP1");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.data.length).toBeGreaterThan(0);
      const slugs = body.data.flatMap((t: { slugs: string[] }) => t.slugs);
      expect(slugs).toContain("test-task-in-progress");
    });

    // AC: @api-contract ac-plan-filter-resolve
    it("resolves plan by ULID prefix", async () => {
      const response = await request("/api/tasks?plan=01KG0RRPCA");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.data.length).toBeGreaterThan(0);
      const slugs = body.data.flatMap((t: { slugs: string[] }) => t.slugs);
      expect(slugs).toContain("test-task-in-progress");
    });
  });
});
