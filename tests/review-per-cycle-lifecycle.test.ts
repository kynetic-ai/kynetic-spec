/**
 * Tests for per-cycle review record lifecycle.
 * AC: @review-record-per-cycle-lifecycle ac-1, ac-2, ac-3
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { kspecOutput as kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli";

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("review per-cycle lifecycle", () => {
  // AC: @review-record-per-cycle-lifecycle ac-2
  it("creates new review record per fix cycle and updates review_ref", () => {
    // Setup: create a task and submit it
    kspec('task add --title "Fix cycle test" --slug fix-cycle-test', tempDir);
    kspec("task start @fix-cycle-test", tempDir);
    kspec("task submit @fix-cycle-test", tempDir);

    // Cycle 1: reviewer creates review with task subject
    kspec(
      'review add --title "Cycle 1 review" --slug cycle1-review --subject-type task --subject-ref @fix-cycle-test',
      tempDir,
    );

    // Verify review_ref is set on task
    const taskAfterLink1 = kspecJson<{ review_ref: string | null }>(
      "task get @fix-cycle-test --json",
      tempDir,
    );
    expect(taskAfterLink1.review_ref).toBe("@cycle1-review");

    // Reviewer submits request_changes verdict (auto-closes review, kicks task to needs_work)
    kspec(
      "review verdict @cycle1-review --decision request_changes --reviewer @review-agent",
      tempDir,
    );

    // Verify cycle 1 review is closed
    const cycle1Review = kspecJson<{ lifecycle_state: string }>(
      "review get @cycle1-review --json",
      tempDir,
    );
    expect(cycle1Review.lifecycle_state).toBe("closed");

    // Verify task is in needs_work
    const taskNeedsWork = kspecJson<{ status: string }>("task get @fix-cycle-test --json", tempDir);
    expect(taskNeedsWork.status).toBe("needs_work");

    // Worker addresses feedback, resubmits
    kspec("task start @fix-cycle-test", tempDir);
    kspec("task submit @fix-cycle-test", tempDir);

    // Cycle 2: reviewer creates a NEW review
    kspec(
      'review add --title "Cycle 2 review" --slug cycle2-review --subject-type task --subject-ref @fix-cycle-test',
      tempDir,
    );

    // Verify review_ref is updated to the new review
    const taskAfterLink2 = kspecJson<{ review_ref: string | null }>(
      "task get @fix-cycle-test --json",
      tempDir,
    );
    expect(taskAfterLink2.review_ref).toBe("@cycle2-review");

    // Verify the old review is still closed and untouched
    const cycle1ReviewAfter = kspecJson<{ lifecycle_state: string }>(
      "review get @cycle1-review --json",
      tempDir,
    );
    expect(cycle1ReviewAfter.lifecycle_state).toBe("closed");
  });

  // AC: @review-record-per-cycle-lifecycle ac-2
  // AC: @review-record-per-cycle-lifecycle ac-3
  it("review for-task returns both current and historical reviews", () => {
    // Setup task
    kspec('task add --title "History test" --slug history-test', tempDir);
    kspec("task start @history-test", tempDir);
    kspec("task submit @history-test", tempDir);

    // Cycle 1: create review with task subject, request changes
    kspec(
      'review add --title "History review 1" --slug hist-review-1 --subject-type task --subject-ref @history-test',
      tempDir,
    );
    kspec(
      "review verdict @hist-review-1 --decision request_changes --reviewer @review-agent",
      tempDir,
    );

    // Worker fixes and resubmits
    kspec("task start @history-test", tempDir);
    kspec("task submit @history-test", tempDir);

    // Cycle 2: create new review with task subject, approve
    kspec(
      'review add --title "History review 2" --slug hist-review-2 --subject-type task --subject-ref @history-test',
      tempDir,
    );
    kspec("review verdict @hist-review-2 --decision approve --reviewer @test-agent", tempDir);

    // Both reviews should be findable via for-task
    const forTask = kspecJson<{
      reviews: Array<{
        ref: string;
        lifecycle_state: string;
        disposition: string;
      }>;
      total: number;
    }>("review for-task @history-test --json", tempDir);

    expect(forTask.total).toBe(2);

    // Both reviews are closed (auto-closed on verdict)
    const review1 = forTask.reviews.find((r) => r.ref === "@hist-review-1");
    const review2 = forTask.reviews.find((r) => r.ref === "@hist-review-2");

    expect(review1).toBeDefined();
    expect(review1!.lifecycle_state).toBe("closed");
    expect(review1!.disposition).toBe("changes_requested");

    expect(review2).toBeDefined();
    expect(review2!.lifecycle_state).toBe("closed");
    expect(review2!.disposition).toBe("approved");
  });

  // AC: @review-record-per-cycle-lifecycle ac-3
  it("each closed review preserves its own verdict and disposition independently", () => {
    kspec('task add --title "Independent reviews" --slug indep-test', tempDir);
    kspec("task start @indep-test", tempDir);
    kspec("task submit @indep-test", tempDir);

    // Cycle 1: request_changes
    kspec(
      'review add --title "Independent R1" --slug indep-r1 --subject-type task --subject-ref @indep-test',
      tempDir,
    );
    kspec("review verdict @indep-r1 --decision request_changes --reviewer @review-agent", tempDir);
    kspec("task start @indep-test", tempDir);
    kspec("task submit @indep-test", tempDir);

    // Cycle 2: request_changes again
    kspec(
      'review add --title "Independent R2" --slug indep-r2 --subject-type task --subject-ref @indep-test',
      tempDir,
    );
    kspec("review verdict @indep-r2 --decision request_changes --reviewer @review-agent", tempDir);
    kspec("task start @indep-test", tempDir);
    kspec("task submit @indep-test", tempDir);

    // Cycle 3: approve
    kspec(
      'review add --title "Independent R3" --slug indep-r3 --subject-type task --subject-ref @indep-test',
      tempDir,
    );
    kspec("review verdict @indep-r3 --decision approve --reviewer @test-agent", tempDir);

    // All 3 reviews findable and each has its own distinct disposition
    const forTask = kspecJson<{
      reviews: Array<{
        ref: string;
        disposition: string;
      }>;
      total: number;
    }>("review for-task @indep-test --json", tempDir);

    expect(forTask.total).toBe(3);

    const r1 = forTask.reviews.find((r) => r.ref === "@indep-r1");
    const r2 = forTask.reviews.find((r) => r.ref === "@indep-r2");
    const r3 = forTask.reviews.find((r) => r.ref === "@indep-r3");

    expect(r1!.disposition).toBe("changes_requested");
    expect(r2!.disposition).toBe("changes_requested");
    expect(r3!.disposition).toBe("approved");

    // Task's review_ref points to the latest review
    const task = kspecJson<{ review_ref: string | null }>("task get @indep-test --json", tempDir);
    expect(task.review_ref).toBe("@indep-r3");
  });
});
