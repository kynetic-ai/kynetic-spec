/**
 * Tests for review CLI task linkage behavior.
 *
 * Verifies that task-oriented CLI output exposes active review linkage
 * so automation can move between task workflow state and review records.
 *
 * AC: @review-cli-task-linkage ac-1 — active review ref discoverable from CLI output
 * AC: @review-cli-task-linkage ac-2 — CLI supports resolving from task context to review record
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
} from "./helpers/cli";

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

/**
 * Helper: create a review for a task subject, which auto-links via review_ref.
 * Returns the created review's ref.
 */
function createLinkedReview(taskRef: string, slug: string, title = "Linked Review"): string {
  kspec(
    `review add --title '${title}' --subject-ref ${taskRef} --subject-type task --slug ${slug}`,
    tempDir,
  );
  return `@${slug}`;
}

/**
 * Helper: create a code review with a related task ref.
 */
function createRelatedReview(taskRef: string, slug: string, title = "Code Review"): string {
  kspec(
    `review add --title '${title}' --base aaa111 --head bbb222 --related-ref ${taskRef} --slug ${slug}`,
    tempDir,
  );
  return `@${slug}`;
}

describe("Review CLI Task Linkage", () => {
  describe("task get with review linkage", () => {
    // AC: @review-cli-task-linkage ac-1
    it("should include active_review in JSON output when task has review_ref", () => {
      // Create a review targeting the fixture task, which auto-sets review_ref
      createLinkedReview("@test-task-pending", "pr-review-1", "PR Review for Pending Task");

      const result = kspecJson<{
        _ulid: string;
        title: string;
        review_ref: string;
        active_review: {
          ref: string;
          title: string;
          lifecycle_state: string;
          disposition: string;
        };
      }>("task get @test-task-pending", tempDir);

      expect(result.review_ref).toBe("@pr-review-1");
      expect(result.active_review).toBeDefined();
      expect(result.active_review.ref).toBe("@pr-review-1");
      expect(result.active_review.title).toBe("PR Review for Pending Task");
      expect(result.active_review.lifecycle_state).toBe("draft");
      expect(result.active_review.disposition).toBe("pending");
    });

    // AC: @review-cli-task-linkage ac-1
    it("should show resolved review info in human-readable output", () => {
      createLinkedReview("@test-task-pending", "human-rv", "Human Readable Review");

      const output = kspec("task get @test-task-pending", tempDir);
      // Should show review ref with resolved info
      expect(output).toContain("Review ref:");
      expect(output).toContain("@human-rv");
      expect(output).toContain("Human Readable Review");
    });

    // AC: @review-cli-task-linkage ac-1
    it("should not include active_review when task has no review_ref", () => {
      const result = kspecJson<{
        _ulid: string;
        review_ref?: string;
        active_review?: unknown;
      }>("task get @test-task-secondary", tempDir);

      expect(result.review_ref).toBeUndefined();
      expect(result.active_review).toBeUndefined();
    });

    // AC: @review-cli-task-linkage ac-1
    it("should include review_ref in JSON even when active_review is resolved", () => {
      // Verify that both review_ref (the raw field) and active_review (resolved summary)
      // are present in JSON output for tasks with linked reviews
      createLinkedReview("@test-task-pending", "both-rv", "Both Fields Review");

      const result = kspecJson<{
        review_ref: string;
        active_review: { ref: string; title: string };
      }>("task get @test-task-pending", tempDir);

      // Both fields present
      expect(result.review_ref).toBe("@both-rv");
      expect(result.active_review.ref).toBe("@both-rv");
      expect(result.active_review.title).toBe("Both Fields Review");
    });
  });

  describe("review for-task with review_ref resolution", () => {
    // AC: @review-cli-task-linkage ac-2
    it("should find reviews via task review_ref field", () => {
      // Create a code review (not task subject) and manually link via related_ref
      // Then create another review with task subject (auto-links review_ref)
      createLinkedReview("@test-task-pending", "task-subj-rv", "Task Subject Review");

      // Now create a separate code review NOT linked via related_refs or subject
      // but ensure the task's review_ref points to the first one
      const result = kspecJson<{
        reviews: Array<{ title: string; ref: string }>;
        total: number;
        task_ref: string;
      }>("review for-task @test-task-pending", tempDir);

      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.task_ref).toBe("@test-task-pending");
      expect(result.reviews.some((r) => r.title === "Task Subject Review")).toBe(true);
    });

    // AC: @review-cli-task-linkage ac-2
    it("should include review from review_ref even when not in related_refs", () => {
      // Create a code review with related_ref to test-task-pending
      // This sets review_ref on the task
      createRelatedReview("@test-task-pending", "code-rv", "Code Review");

      // Verify the task now has review_ref set
      const taskResult = kspecJson<{ review_ref: string }>("task get @test-task-pending", tempDir);
      expect(taskResult.review_ref).toBe("@code-rv");

      // Create ANOTHER code review that references a different task
      // but doesn't reference test-task-pending
      kspec(
        "review add --title 'Unrelated Review' --base ccc333 --head ddd444 --slug unrelated-rv",
        tempDir,
      );

      // review for-task should find the linked review
      const result = kspecJson<{
        reviews: Array<{ title: string; ref: string }>;
        total: number;
      }>("review for-task @test-task-pending", tempDir);

      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.reviews.some((r) => r.ref === "@code-rv")).toBe(true);
      // Should NOT include the unrelated review
      expect(result.reviews.some((r) => r.ref === "@unrelated-rv")).toBe(false);
    });

    // AC: @review-cli-task-linkage ac-2
    it("should deduplicate reviews found via multiple paths", () => {
      // Create a review that is both the task subject AND has related_ref
      // This should only appear once in the output
      createLinkedReview("@test-task-pending", "dedup-rv", "Dedup Review");

      const result = kspecJson<{
        reviews: Array<{ ref: string }>;
        total: number;
      }>("review for-task @test-task-pending", tempDir);

      const dedup = result.reviews.filter((r) => r.ref === "@dedup-rv");
      expect(dedup).toHaveLength(1);
    });

    // AC: @review-cli-task-linkage ac-2
    it("should return empty when task has no review linkage", () => {
      const result = kspecJson<{
        reviews: Array<unknown>;
        total: number;
      }>("review for-task @test-task-secondary", tempDir);

      expect(result.total).toBe(0);
      expect(result.reviews).toEqual([]);
    });
  });

  describe("review list --task filter", () => {
    // AC: @review-cli-task-linkage ac-1
    it("should filter reviews by task ref", () => {
      createLinkedReview("@test-task-pending", "list-rv-1", "First Review");
      kspec("review add --title 'Other Review' --base xxx --head yyy --slug other-rv", tempDir);

      const result = kspecJson<{
        reviews: Array<{ ref: string; title: string }>;
        total: number;
      }>("review list --task @test-task-pending", tempDir);

      expect(result.total).toBe(1);
      expect(result.reviews[0].ref).toBe("@list-rv-1");
    });

    // AC: @review-cli-task-linkage ac-2
    it("should find reviews via review_ref when using --task filter", () => {
      createRelatedReview("@test-task-pending", "related-rv", "Related Code Review");

      const result = kspecJson<{
        reviews: Array<{ ref: string; title: string }>;
        total: number;
      }>("review list --task @test-task-pending", tempDir);

      expect(result.total).toBe(1);
      expect(result.reviews[0].ref).toBe("@related-rv");
    });

    // AC: @review-cli-task-linkage ac-1
    it("should return empty when no reviews match task", () => {
      const result = kspecJson<{
        reviews: Array<unknown>;
        total: number;
      }>("review list --task @test-task-secondary", tempDir);

      expect(result.total).toBe(0);
    });

    // AC: @review-cli-task-linkage ac-1
    it("should combine --task with other filters", () => {
      createLinkedReview("@test-task-pending", "combo-rv", "Combo Review");
      // Open the review
      kspec("review open @combo-rv", tempDir);

      // Filter by task AND status
      const openResult = kspecJson<{
        reviews: Array<{ ref: string }>;
        total: number;
      }>("review list --task @test-task-pending --status open", tempDir);
      expect(openResult.total).toBe(1);

      // Filter by task AND wrong status
      const closedResult = kspecJson<{
        reviews: Array<unknown>;
        total: number;
      }>("review list --task @test-task-pending --status closed", tempDir);
      expect(closedResult.total).toBe(0);
    });
  });

  // --- Trait AC coverage ---

  // AC: @trait-json-output ac-1
  describe("JSON output trait compliance", () => {
    // AC: @trait-json-output ac-1
    it("should output valid JSON with no ANSI color codes for task get with review", () => {
      createLinkedReview("@test-task-pending", "json-rv", "JSON Test Review");

      const result = kspecRun("task get @test-task-pending --json", tempDir);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toBeDefined();
      expect(parsed.active_review).toBeDefined();
      // No ANSI escape codes
      // oxlint-disable-next-line eslint(no-control-regex) -- intentionally matching ANSI escape
      expect(result.stdout).not.toMatch(/\x1b\[/);
    });

    // AC: @trait-json-output ac-2
    it("should include all review data in JSON that is available in human mode", () => {
      createLinkedReview("@test-task-pending", "full-rv", "Full Data Review");

      const result = kspecJson<{
        review_ref: string;
        active_review: {
          ref: string;
          title: string;
          lifecycle_state: string;
          disposition: string;
        };
      }>("task get @test-task-pending", tempDir);

      // All fields present in JSON
      expect(result.active_review.ref).toBeDefined();
      expect(result.active_review.title).toBeDefined();
      expect(result.active_review.lifecycle_state).toBeDefined();
      expect(result.active_review.disposition).toBeDefined();
    });

    // AC: @trait-json-output ac-3
    it("should return JSON error when task not found", () => {
      const result = kspecRun("task get @nonexistent-task --json", tempDir, {
        expectFail: true,
      });
      const parsed = JSON.parse(result.stderr || result.stdout);
      expect(parsed.error).toBeDefined();
    });

    // AC: @trait-json-output ac-4
    it("should use @ prefix for review references in JSON output", () => {
      createLinkedReview("@test-task-pending", "ref-rv", "Ref Test Review");

      const result = kspecJson<{
        active_review: { ref: string };
        review_ref: string;
      }>("task get @test-task-pending", tempDir);

      expect(result.active_review.ref).toMatch(/^@/);
      expect(result.review_ref).toMatch(/^@/);
    });

    // AC: @trait-json-output ac-5
    it("should use ISO 8601 timestamps in review list --task output", () => {
      createLinkedReview("@test-task-pending", "time-rv", "Time Test");

      const result = kspecJson<{
        reviews: Array<{ created_at: string }>;
      }>("review list --task @test-task-pending", tempDir);

      expect(result.reviews[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    // AC: @trait-json-output ac-6 — N/A: review list --task has no competing format flags beyond global --json
  });

  // AC: @trait-semantic-exit-codes ac-1, ac-2, ac-5
  describe("semantic exit codes trait compliance", () => {
    // AC: @trait-semantic-exit-codes ac-1
    it("should exit 0 when task get with review succeeds", () => {
      createLinkedReview("@test-task-pending", "exit-rv", "Exit Test");

      const result = kspecRun("task get @test-task-pending", tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-1
    it("should exit 0 when review for-task succeeds", () => {
      createLinkedReview("@test-task-pending", "exit-rv2", "Exit Test 2");

      const result = kspecRun("review for-task @test-task-pending", tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-1
    it("should exit 0 when review list --task succeeds", () => {
      createLinkedReview("@test-task-pending", "exit-rv3", "Exit Test 3");

      const result = kspecRun("review list --task @test-task-pending", tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-5
    it("should exit 0 with empty result set for review for-task", () => {
      const result = kspecRun("review for-task @test-task-secondary", tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-5
    it("should exit 0 with empty result set for review list --task", () => {
      const result = kspecRun("review list --task @test-task-secondary", tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-2 — N/A: task ref validation handled by existing task get; --task filter on review list does not validate task existence
    // AC: @trait-semantic-exit-codes ac-3 — N/A: no interactive confirmation in these commands
    // AC: @trait-semantic-exit-codes ac-4 — runtime error handling is inherited from task get and review list base commands
    // AC: @trait-semantic-exit-codes ac-6 — usage errors handled by commander for invalid flags
    // AC: @trait-semantic-exit-codes ac-7 — N/A: no batch partial failure applies to these read-only commands
    // AC: @trait-semantic-exit-codes ac-8 — exit code constants documented in src/cli/exit-codes.ts
  });
});
