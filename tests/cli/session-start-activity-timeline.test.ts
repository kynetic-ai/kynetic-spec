/**
 * Tests for session start activity timeline
 *
 * AC: @session-start-activity-timeline ac-activity-merge
 * AC: @session-start-activity-timeline ac-activity-trailer-link
 * AC: @session-start-activity-timeline ac-activity-sort
 * AC: @session-start-activity-timeline ac-activity-dedup
 * AC: @session-start-activity-timeline ac-activity-no-git
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir, initGitRepo, git } from '../helpers/cli';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface CommitSummary {
  hash: string;
  full_hash: string;
  date: string;
  message: string;
  author: string;
  task_refs: string[];
}

interface CompletedTaskSummary {
  ref: string;
  title: string;
  completed_at: string;
  closed_reason: string | null;
}

interface ActivityItem {
  type: 'task_completion' | 'commit' | 'linked_commit';
  date: string;
  commit?: CommitSummary;
  task?: CompletedTaskSummary;
}

interface SessionContext {
  recently_completed: CompletedTaskSummary[];
  recent_commits: CommitSummary[];
  activity_timeline: ActivityItem[];
}

describe('session start activity timeline', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    // Initial commit so git log works
    writeFileSync(join(tempDir, 'README.md'), '# Test\n');
    git('add .', tempDir);
    git('commit -m "initial commit"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @session-start-activity-timeline ac-activity-merge
  describe('activity merge (ac-activity-merge)', () => {
    it('should include both completed tasks and commits in a single timeline', () => {
      // Create and complete a task
      kspec('task add --title "Feature alpha" --slug task-alpha', tempDir);
      kspec('task start @task-alpha', tempDir);
      kspec('task submit @task-alpha', tempDir);
      kspec('task complete @task-alpha --reason "Shipped alpha"', tempDir);

      // Create a git commit (not linked to any task)
      writeFileSync(join(tempDir, 'feature.ts'), 'export const x = 1;\n');
      git('add feature.ts', tempDir);
      git('commit -m "feat: add feature file"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // activity_timeline should contain entries from both sources
      expect(session.activity_timeline.length).toBeGreaterThanOrEqual(2);

      const taskEntries = session.activity_timeline.filter(
        (i) => i.type === 'task_completion',
      );
      const commitEntries = session.activity_timeline.filter(
        (i) => i.type === 'commit',
      );

      expect(taskEntries.length).toBeGreaterThanOrEqual(1);
      expect(commitEntries.length).toBeGreaterThanOrEqual(1);
    });

    it('should show Recent Activity header in human output instead of separate sections', () => {
      // Create and complete a task
      kspec('task add --title "Feature beta" --slug task-beta', tempDir);
      kspec('task start @task-beta', tempDir);
      kspec('task submit @task-beta', tempDir);
      kspec('task complete @task-beta --reason "Shipped beta"', tempDir);

      // Create a git commit
      writeFileSync(join(tempDir, 'beta.ts'), 'export const beta = 1;\n');
      git('add beta.ts', tempDir);
      git('commit -m "feat: add beta"', tempDir);

      const result = kspec('session start', tempDir);

      // Should have unified "Recent Activity" section
      expect(result.stdout).toContain('Recent Activity');

      // Should NOT have separate "Recent Commits" section
      // (the section header text is "--- Recent Commits ---")
      expect(result.stdout).not.toContain('Recent Commits ---');
    });

    it('should preserve raw recently_completed and recent_commits arrays in JSON', () => {
      // Create and complete a task
      kspec('task add --title "Raw check" --slug task-raw', tempDir);
      kspec('task start @task-raw', tempDir);
      kspec('task submit @task-raw', tempDir);
      kspec('task complete @task-raw --reason "Done"', tempDir);

      // Create a commit
      writeFileSync(join(tempDir, 'raw.ts'), 'export const raw = 1;\n');
      git('add raw.ts', tempDir);
      git('commit -m "feat: raw check"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Raw arrays should still be present
      expect(session.recently_completed).toBeDefined();
      expect(session.recently_completed.length).toBeGreaterThanOrEqual(1);
      expect(session.recent_commits).toBeDefined();
      expect(session.recent_commits.length).toBeGreaterThanOrEqual(1);

      // Plus the unified timeline
      expect(session.activity_timeline).toBeDefined();
      expect(session.activity_timeline.length).toBeGreaterThanOrEqual(2);
    });
  });

  // AC: @session-start-activity-timeline ac-activity-trailer-link
  describe('trailer linking (ac-activity-trailer-link)', () => {
    it('should show linked task info when commit has Task: @slug trailer', () => {
      // Create and complete a task
      kspec('task add --title "Linked feature" --slug task-linked', tempDir);
      kspec('task start @task-linked', tempDir);
      kspec('task submit @task-linked', tempDir);
      kspec('task complete @task-linked --reason "All done"', tempDir);

      // Create a commit with a Task: trailer using the task slug (convention)
      writeFileSync(join(tempDir, 'linked.ts'), 'export const linked = 1;\n');
      git('add linked.ts', tempDir);
      git('commit -m "feat: implement linked feature" -m "Task: @task-linked"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Should have a linked_commit entry
      const linkedEntries = session.activity_timeline.filter(
        (i) => i.type === 'linked_commit',
      );
      expect(linkedEntries.length).toBe(1);
      expect(linkedEntries[0].commit!.task_refs).toContain('task-linked');
      expect(linkedEntries[0].task!.title).toBe('Linked feature');
    });

    it('should show linked task info in human output', () => {
      kspec('task add --title "Human linked" --slug task-human-linked', tempDir);
      kspec('task start @task-human-linked', tempDir);
      kspec('task submit @task-human-linked', tempDir);
      kspec('task complete @task-human-linked --reason "Done"', tempDir);

      writeFileSync(join(tempDir, 'hl.ts'), 'export const hl = 1;\n');
      git('add hl.ts', tempDir);
      git('commit -m "feat: human linked feature" -m "Task: @task-human-linked"', tempDir);

      const result = kspec('session start', tempDir);

      // Human output should show commit → task link
      expect(result.stdout).toContain('Human linked');
      expect(result.stdout).toContain('human linked feature');
    });

    it('should include task_refs in commit summary JSON', () => {
      writeFileSync(join(tempDir, 'refcheck.ts'), 'export const rc = 1;\n');
      git('add refcheck.ts', tempDir);
      git('commit -m "feat: ref check commit" -m "Task: @task-ref-check"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      const commit = session.recent_commits.find((c) =>
        c.message.includes('ref check commit'),
      );
      expect(commit).toBeDefined();
      expect(commit!.task_refs).toContain('task-ref-check');
    });
  });

  // AC: @session-start-activity-timeline ac-activity-sort
  describe('chronological sort (ac-activity-sort)', () => {
    it('should sort timeline items most recent first', { timeout: 15000 }, () => {
      // Create a task completed "earlier"
      kspec('task add --title "Earlier task" --slug task-earlier', tempDir);
      kspec('task start @task-earlier', tempDir);
      kspec('task submit @task-earlier', tempDir);
      kspec('task complete @task-earlier --reason "Done first"', tempDir);

      // Create a commit with a future date to guarantee different timestamps
      // Git --date flag sets the author date, ensuring it sorts after the task completion
      writeFileSync(join(tempDir, 'later.ts'), 'export const later = 1;\n');
      git('add later.ts', tempDir);
      git('commit -m "feat: later commit" --date="2099-01-01T00:00:00Z"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Should have at least 2 items (task + commit)
      expect(session.activity_timeline.length).toBeGreaterThanOrEqual(2);

      // Verify sorted most recent first
      for (let i = 1; i < session.activity_timeline.length; i++) {
        const prevDate = new Date(session.activity_timeline[i - 1].date).getTime();
        const currDate = new Date(session.activity_timeline[i].date).getTime();
        expect(prevDate).toBeGreaterThanOrEqual(currDate);
      }

      // The commit with future date should be first
      expect(session.activity_timeline[0].type).toBe('commit');
      expect(session.activity_timeline[0].commit!.message).toBe('feat: later commit');
    });
  });

  // AC: @session-start-activity-timeline ac-activity-dedup
  describe('deduplication (ac-activity-dedup)', () => {
    it('should show linked commit+task as single combined entry, not two separate entries', () => {
      kspec('task add --title "Dedup task" --slug task-dedup', tempDir);
      kspec('task start @task-dedup', tempDir);
      kspec('task submit @task-dedup', tempDir);
      kspec('task complete @task-dedup --reason "Dedup done"', tempDir);

      writeFileSync(join(tempDir, 'dedup.ts'), 'export const dedup = 1;\n');
      git('add dedup.ts', tempDir);
      git('commit -m "feat: dedup feature" -m "Task: @task-dedup"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Should have exactly one linked_commit entry for this task
      const linkedEntries = session.activity_timeline.filter(
        (i) => i.type === 'linked_commit' && i.task?.title === 'Dedup task',
      );
      expect(linkedEntries.length).toBe(1);

      // The task should NOT appear as a separate task_completion entry
      const taskOnlyEntries = session.activity_timeline.filter(
        (i) => i.type === 'task_completion' && i.task?.title === 'Dedup task',
      );
      expect(taskOnlyEntries.length).toBe(0);

      // The commit should NOT appear as a separate commit entry
      const commitOnlyEntries = session.activity_timeline.filter(
        (i) => i.type === 'commit' && i.commit?.message === 'feat: dedup feature',
      );
      expect(commitOnlyEntries.length).toBe(0);
    });

    it('should show unlinked commit and unlinked task as separate entries', () => {
      // Complete a task (no commit linked)
      kspec('task add --title "Standalone task" --slug task-standalone', tempDir);
      kspec('task start @task-standalone', tempDir);
      kspec('task submit @task-standalone', tempDir);
      kspec('task complete @task-standalone --reason "Done alone"', tempDir);

      // Create unlinked commit
      writeFileSync(join(tempDir, 'standalone.ts'), 'export const x = 1;\n');
      git('add standalone.ts', tempDir);
      git('commit -m "chore: standalone commit"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // Each should appear as its own type
      const taskEntries = session.activity_timeline.filter(
        (i) => i.type === 'task_completion' && i.task?.title === 'Standalone task',
      );
      expect(taskEntries.length).toBe(1);

      const commitEntries = session.activity_timeline.filter(
        (i) => i.type === 'commit' && i.commit?.message === 'chore: standalone commit',
      );
      expect(commitEntries.length).toBe(1);
    });
  });

  // AC: @session-start-activity-timeline ac-activity-no-git
  describe('--no-git flag (ac-activity-no-git)', () => {
    it('should only show task completions when --no-git is passed', () => {
      // Create and complete a task
      kspec('task add --title "No-git task" --slug task-no-git', tempDir);
      kspec('task start @task-no-git', tempDir);
      kspec('task submit @task-no-git', tempDir);
      kspec('task complete @task-no-git --reason "Done without git"', tempDir);

      // Create a commit
      writeFileSync(join(tempDir, 'nogit.ts'), 'export const x = 1;\n');
      git('add nogit.ts', tempDir);
      git('commit -m "feat: should not appear"', tempDir);

      const session = kspecJson<SessionContext>('session start --json --no-git', tempDir);

      // Timeline should only contain task_completion entries
      expect(session.activity_timeline.length).toBeGreaterThanOrEqual(1);
      for (const item of session.activity_timeline) {
        expect(item.type).toBe('task_completion');
      }

      // recent_commits should be empty
      expect(session.recent_commits).toHaveLength(0);
    });

    it('should not show commit entries in human output with --no-git', () => {
      kspec('task add --title "Visible task" --slug task-visible', tempDir);
      kspec('task start @task-visible', tempDir);
      kspec('task submit @task-visible', tempDir);
      kspec('task complete @task-visible --reason "Visible"', tempDir);

      writeFileSync(join(tempDir, 'hidden.ts'), 'export const x = 1;\n');
      git('add hidden.ts', tempDir);
      git('commit -m "feat: invisible commit"', tempDir);

      const result = kspec('session start --no-git', tempDir);

      // Task should be visible
      expect(result.stdout).toContain('Visible task');
      // Commit should not be visible
      expect(result.stdout).not.toContain('invisible commit');
    });
  });
});
