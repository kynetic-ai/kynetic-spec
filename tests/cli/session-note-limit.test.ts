/**
 * Tests for note limit behavior in gatherSessionContext.
 *
 * Verifies that:
 * - Non-full mode caps total notes at --limit (not 3x limit)
 * - Full mode uncaps notes (consistent with other sections)
 * - Per-status starvation prevention still works with the cap
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { kspec, kspecJson, createTempDir, initGitRepo, cleanupTempDir } from "../helpers/cli";
import type { SessionContext } from "../helpers/session-types";

describe("session start note limit behavior", () => {
  let tempDir: string;
  const NOTE_LIMIT_TEST_TIMEOUT_MS = 120_000;

  beforeEach(async () => {
    // Use clean environment to avoid fixture notes contaminating counts
    tempDir = await createTempDir("kspec-note-limit-");
    initGitRepo(tempDir);
    kspec("init", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe("non-full mode total cap", () => {
    it("should cap total notes at --limit value", { timeout: NOTE_LIMIT_TEST_TIMEOUT_MS }, () => {
      // Create tasks across all 3 status buckets with many notes each.
      // With --limit 3, each bucket gets ceil(3/3) = 1 per-status,
      // and total should be capped at 3 after concatenation.

      // in_progress tasks with notes
      for (let i = 1; i <= 2; i++) {
        kspec(`task add --title "Active ${i}" --slug active-${i}`, tempDir);
        kspec(`task start @active-${i}`, tempDir);
        kspec(`task note @active-${i} "Active note ${i}"`, tempDir);
      }

      // pending_review tasks with notes
      for (let i = 1; i <= 2; i++) {
        kspec(`task add --title "Review ${i}" --slug review-${i}`, tempDir);
        kspec(`task start @review-${i}`, tempDir);
        kspec(`task note @review-${i} "Review note ${i}"`, tempDir);
        kspec(`task submit @review-${i}`, tempDir);
      }

      // completed tasks with notes
      for (let i = 1; i <= 2; i++) {
        kspec(`task add --title "Done ${i}" --slug done-${i}`, tempDir);
        kspec(`task start @done-${i}`, tempDir);
        kspec(`task note @done-${i} "Done note ${i}"`, tempDir);
        kspec(`task submit @done-${i}`, tempDir);
        kspec(`task complete @done-${i} --reason "Finished ${i}"`, tempDir);
      }

      // With --limit 3, total notes should not exceed 3
      const session = kspecJson<SessionContext>("session start --json --limit 3", tempDir);

      expect(session.recent_notes!.length).toBeLessThanOrEqual(3);
      expect(session.recent_notes!.length).toBeGreaterThan(0);
    });

    it(
      "should not exceed limit even with ceil rounding across 3 buckets",
      { timeout: NOTE_LIMIT_TEST_TIMEOUT_MS },
      () => {
        // --limit 4: ceil(4/3) = 2 per bucket = up to 6 without final cap.
        // With fix, total should be capped at 4.

        for (let i = 1; i <= 2; i++) {
          kspec(`task add --title "Active ${i}" --slug act-${i}`, tempDir);
          kspec(`task start @act-${i}`, tempDir);
          kspec(`task note @act-${i} "Active note ${i}"`, tempDir);
        }

        for (let i = 1; i <= 2; i++) {
          kspec(`task add --title "Review ${i}" --slug rev-${i}`, tempDir);
          kspec(`task start @rev-${i}`, tempDir);
          kspec(`task note @rev-${i} "Review note ${i}"`, tempDir);
          kspec(`task submit @rev-${i}`, tempDir);
        }

        for (let i = 1; i <= 2; i++) {
          kspec(`task add --title "Done ${i}" --slug dn-${i}`, tempDir);
          kspec(`task start @dn-${i}`, tempDir);
          kspec(`task note @dn-${i} "Done note ${i}"`, tempDir);
          kspec(`task submit @dn-${i}`, tempDir);
          kspec(`task complete @dn-${i} --reason "Finished ${i}"`, tempDir);
        }

        const session = kspecJson<SessionContext>("session start --json --limit 4", tempDir);

        // Total notes should not exceed the limit (4), not 3*ceil(4/3) = 6
        expect(session.recent_notes!.length).toBeLessThanOrEqual(4);
        expect(session.recent_notes!.length).toBeGreaterThan(0);
      },
    );
  });

  describe("full mode uncap", () => {
    it(
      "should allow more notes than default limit in full mode",
      { timeout: NOTE_LIMIT_TEST_TIMEOUT_MS },
      () => {
        // Create many notes across multiple statuses.
        // Full mode should return all notes without artificial cap.

        for (let i = 1; i <= 3; i++) {
          kspec(`task add --title "Active ${i}" --slug active-${i}`, tempDir);
          kspec(`task start @active-${i}`, tempDir);
          kspec(`task note @active-${i} "Active note A${i}"`, tempDir);
          kspec(`task note @active-${i} "Active note B${i}"`, tempDir);
        }

        for (let i = 1; i <= 3; i++) {
          kspec(`task add --title "Done ${i}" --slug done-${i}`, tempDir);
          kspec(`task start @done-${i}`, tempDir);
          kspec(`task note @done-${i} "Done note A${i}"`, tempDir);
          kspec(`task note @done-${i} "Done note B${i}"`, tempDir);
          kspec(`task submit @done-${i}`, tempDir);
          kspec(`task complete @done-${i} --reason "Finished ${i}"`, tempDir);
        }

        // Full mode: should not artificially cap notes
        const fullSession = kspecJson<SessionContext>("session start --json --full", tempDir);
        // Non-full with --limit 3: should cap at 3
        const limitedSession = kspecJson<SessionContext>("session start --json --limit 3", tempDir);

        // Full mode should have more notes than the limited mode
        expect(fullSession.recent_notes!.length).toBeGreaterThan(
          limitedSession.recent_notes!.length,
        );
        expect(limitedSession.recent_notes!.length).toBeLessThanOrEqual(3);
      },
    );
  });

  describe("starvation prevention with cap", () => {
    it(
      "should still include notes from all status buckets when capped",
      { timeout: NOTE_LIMIT_TEST_TIMEOUT_MS },
      () => {
        // With --limit 6 and notes in all 3 statuses, each status should be represented.
        // ceil(6/3) = 2 per bucket, so each status gets up to 2 notes.

        // Create in_progress notes
        for (let i = 1; i <= 2; i++) {
          kspec(`task add --title "Active ${i}" --slug active-${i}`, tempDir);
          kspec(`task start @active-${i}`, tempDir);
          kspec(`task note @active-${i} "Active note ${i}"`, tempDir);
        }

        // Create 1 pending_review note
        kspec('task add --title "Review task" --slug review-task', tempDir);
        kspec("task start @review-task", tempDir);
        kspec('task note @review-task "Review note"', tempDir);
        kspec("task submit @review-task", tempDir);

        // Create 1 completed note
        kspec('task add --title "Done task" --slug done-task', tempDir);
        kspec("task start @done-task", tempDir);
        kspec('task note @done-task "Done note"', tempDir);
        kspec("task submit @done-task", tempDir);
        kspec('task complete @done-task --reason "Finished"', tempDir);

        const session = kspecJson<SessionContext>("session start --json --limit 6", tempDir);

        // Total capped at 6
        expect(session.recent_notes!.length).toBeLessThanOrEqual(6);

        // Each status should be represented (starvation prevention still works)
        const statuses = new Set(session.recent_notes!.map((n) => n.task_status));
        expect(statuses.has("in_progress")).toBe(true);
        expect(statuses.has("pending_review")).toBe(true);
        expect(statuses.has("completed")).toBe(true);
      },
    );
  });
});
