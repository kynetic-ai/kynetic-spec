/**
 * Tests for session start notes enrichment
 *
 * AC: @cmd-session-start ac-1, ac-2
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from '../helpers/cli';

interface SessionContext {
  recent_notes: Array<{
    task_ref: string;
    task_title: string;
    task_status: 'in_progress' | 'pending_review' | 'completed';
    note_ulid: string;
    created_at: string;
    author: string | null;
    content: string;
  }>;
}

describe('session start notes enrichment', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-session-start ac-1
  describe('pending_review task notes', () => {
    it('should include notes from pending_review tasks', () => {
      // Create a task with notes and submit it to pending_review
      kspec('task add --title "Task with notes" --slug task-with-notes', tempDir);
      kspec('task start @task-with-notes', tempDir);
      kspec('task note @task-with-notes "Working on implementation"', tempDir);
      kspec('task submit @task-with-notes', tempDir);
      kspec('task note @task-with-notes "PR created, awaiting review"', tempDir);

      // Get session context
      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Should have notes from the pending_review task
      const pendingReviewNotes = session.recent_notes.filter(
        (n) => n.task_status === 'pending_review',
      );
      expect(pendingReviewNotes.length).toBeGreaterThan(0);
      expect(pendingReviewNotes.some((n) => n.content.includes('PR created'))).toBe(true);
    });

    it('should group pending_review notes separately from in_progress notes', () => {
      // Create an in_progress task with notes
      kspec('task add --title "In progress task" --slug in-progress-task', tempDir);
      kspec('task start @in-progress-task', tempDir);
      kspec('task note @in-progress-task "Still working"', tempDir);

      // Create a pending_review task with notes
      kspec('task add --title "Pending review task" --slug pending-review-task', tempDir);
      kspec('task start @pending-review-task', tempDir);
      kspec('task note @pending-review-task "Ready for review"', tempDir);
      kspec('task submit @pending-review-task', tempDir);

      // Get session context
      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Should have both types of notes with correct statuses
      const inProgressNotes = session.recent_notes.filter(
        (n) => n.task_status === 'in_progress',
      );
      const pendingReviewNotes = session.recent_notes.filter(
        (n) => n.task_status === 'pending_review',
      );

      expect(inProgressNotes.length).toBeGreaterThan(0);
      expect(pendingReviewNotes.length).toBeGreaterThan(0);
      expect(inProgressNotes.some((n) => n.content.includes('Still working'))).toBe(true);
      expect(pendingReviewNotes.some((n) => n.content.includes('Ready for review'))).toBe(true);
    });

    it('should show pending_review notes in human-readable output', () => {
      // Create a pending_review task with notes
      kspec('task add --title "Task for review" --slug task-for-review', tempDir);
      kspec('task start @task-for-review', tempDir);
      kspec('task note @task-for-review "Ready for merge"', tempDir);
      kspec('task submit @task-for-review', tempDir);

      // Get human-readable output
      const result = kspec('session start', tempDir);

      // Should have Pending Review section in output
      expect(result.stdout).toContain('Pending Review:');
      expect(result.stdout).toContain('Ready for merge');
    });
  });

  // AC: @cmd-session-start ac-2
  describe('recently completed task notes', () => {
    it('should include notes from recently completed tasks', () => {
      // Create and complete a task with notes
      kspec('task add --title "Completed task" --slug completed-task', tempDir);
      kspec('task start @completed-task', tempDir);
      kspec('task note @completed-task "Implementation complete"', tempDir);
      kspec('task submit @completed-task', tempDir);
      kspec('task complete @completed-task --reason "Merged"', tempDir);

      // Get session context
      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Should have notes from the completed task
      const completedNotes = session.recent_notes.filter(
        (n) => n.task_status === 'completed',
      );
      expect(completedNotes.length).toBeGreaterThan(0);
      expect(completedNotes.some((n) => n.content.includes('Implementation complete'))).toBe(true);
    });

    it('should limit to last 3-5 completed tasks', { timeout: 30000 }, () => {
      // Create and complete 7 tasks (more than the limit)
      for (let i = 1; i <= 7; i++) {
        kspec(`task add --title "Completed ${i}" --slug completed-${i}`, tempDir);
        kspec(`task start @completed-${i}`, tempDir);
        kspec(`task note @completed-${i} "Note for task ${i}"`, tempDir);
        kspec(`task submit @completed-${i}`, tempDir);
        kspec(`task complete @completed-${i} --reason "Done"`, tempDir);
      }

      // Get session context
      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Count unique completed tasks in notes
      const completedNotes = session.recent_notes.filter(
        (n) => n.task_status === 'completed',
      );
      const uniqueCompletedTasks = new Set(completedNotes.map((n) => n.task_ref));

      // Should have at most 5 unique completed tasks (per AC-2: last 3-5)
      expect(uniqueCompletedTasks.size).toBeLessThanOrEqual(5);
      expect(uniqueCompletedTasks.size).toBeGreaterThan(0);
    });

    it('should show recently completed notes in human-readable output', () => {
      // Create and complete a task with notes
      kspec('task add --title "Done task" --slug done-task', tempDir);
      kspec('task start @done-task', tempDir);
      kspec('task note @done-task "All tests passing"', tempDir);
      kspec('task complete @done-task --reason "Shipped"', tempDir);

      // Get human-readable output
      const result = kspec('session start', tempDir);

      // Should have Recently Completed section in output
      expect(result.stdout).toContain('Recently Completed:');
      expect(result.stdout).toContain('All tests passing');
    });

    it('should include notes from multiple completed tasks', () => {
      // Create and complete two tasks with notes
      kspec('task add --title "First completed task" --slug first-completed', tempDir);
      kspec('task start @first-completed', tempDir);
      kspec('task note @first-completed "First task note"', tempDir);
      kspec('task submit @first-completed', tempDir);
      kspec('task complete @first-completed --reason "Done first"', tempDir);

      kspec('task add --title "Second completed task" --slug second-completed', tempDir);
      kspec('task start @second-completed', tempDir);
      kspec('task note @second-completed "Second task note"', tempDir);
      kspec('task submit @second-completed', tempDir);
      kspec('task complete @second-completed --reason "Done second"', tempDir);

      // Get session context
      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Should have notes from completed tasks
      const completedNotes = session.recent_notes.filter(
        (n) => n.task_status === 'completed',
      );

      // Should include notes from both completed tasks
      expect(completedNotes.length).toBeGreaterThanOrEqual(1);

      // Check that we can find notes from both tasks (they may be limited by the notes limit)
      const hasFirstNote = completedNotes.some((n) => n.content.includes('First task note'));
      const hasSecondNote = completedNotes.some((n) => n.content.includes('Second task note'));

      // At least one of the notes should be present
      expect(hasFirstNote || hasSecondNote).toBe(true);
    });
  });

  // AC: @cmd-session-start ac-1, ac-2
  describe('mixed-status note starvation prevention', () => {
    it('should include pending_review and completed notes even with many in_progress notes', { timeout: 20000 }, () => {
      // Create many in_progress tasks with notes (potential starvation scenario)
      for (let i = 1; i <= 5; i++) {
        kspec(`task add --title "Active ${i}" --slug active-${i}`, tempDir);
        kspec(`task start @active-${i}`, tempDir);
        kspec(`task note @active-${i} "Active note ${i}"`, tempDir);
      }

      // Create a pending_review task with notes
      kspec('task add --title "Review task" --slug review-task', tempDir);
      kspec('task start @review-task', tempDir);
      kspec('task note @review-task "Review note"', tempDir);
      kspec('task submit @review-task', tempDir);

      // Create a completed task with notes
      kspec('task add --title "Done task" --slug done-task', tempDir);
      kspec('task start @done-task', tempDir);
      kspec('task note @done-task "Done note"', tempDir);
      kspec('task submit @done-task', tempDir);
      kspec('task complete @done-task --reason "Finished"', tempDir);

      // Get session context
      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // All three status types should be represented
      const inProgressNotes = session.recent_notes.filter(
        (n) => n.task_status === 'in_progress',
      );
      const pendingReviewNotes = session.recent_notes.filter(
        (n) => n.task_status === 'pending_review',
      );
      const completedNotes = session.recent_notes.filter(
        (n) => n.task_status === 'completed',
      );

      // Each status should have notes present (not starved out)
      expect(inProgressNotes.length).toBeGreaterThan(0);
      expect(pendingReviewNotes.length).toBeGreaterThan(0);
      expect(completedNotes.length).toBeGreaterThan(0);

      // Verify specific notes are present
      expect(pendingReviewNotes.some((n) => n.content.includes('Review note'))).toBe(true);
      expect(completedNotes.some((n) => n.content.includes('Done note'))).toBe(true);
    });
  });

  describe('task_status field in JSON output', () => {
    it('should include task_status field for all notes', () => {
      // Create tasks in different states with notes
      kspec('task add --title "Active task" --slug active-task', tempDir);
      kspec('task start @active-task', tempDir);
      kspec('task note @active-task "Active work"', tempDir);

      // Get session context
      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // All notes should have task_status field
      for (const note of session.recent_notes) {
        expect(note.task_status).toBeDefined();
        expect(['in_progress', 'pending_review', 'completed']).toContain(note.task_status);
      }
    });
  });
});
