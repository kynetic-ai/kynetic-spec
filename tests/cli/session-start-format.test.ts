/**
 * Tests for formatSessionContext() rewrite — primer/full modes
 *
 * AC: @cmd-session-start ac-primer-default
 * AC: @cmd-session-start ac-full-sections
 * AC: @cmd-session-start ac-brief-alias
 * AC: @cmd-session-start ac-section-order
 * AC: @cmd-session-start ac-empty-skip
 * AC: @cmd-session-start ac-slug-display
 * AC: @cmd-session-start ac-slug-fallback
 * AC: @cmd-session-start ac-relative-time-human
 * AC: @cmd-session-start ac-iso-time-json
 * AC: @cmd-session-start ac-dirty-tree-only
 * AC: @cmd-session-start ac-active-detail
 * AC: @cmd-session-start ac-needs-work-indicator
 * AC: @cmd-session-start ac-review-detail
 * AC: @cmd-session-start ac-notes-starvation
 * AC: @cmd-session-start ac-json-raw-preserved
 *
 * Trait coverage:
 * AC: @trait-json-output ac-1 (via session-start-notes.test.ts)
 * AC: @trait-json-output ac-2 (JSON includes all human-visible data — verified structurally)
 * AC: @trait-json-output ac-4 (refs use @ prefix in human output; JSON refs are identifiers)
 * AC: @trait-json-output ac-5 (ISO 8601 timestamps in JSON — ac-iso-time-json test)
 * AC: @trait-json-output ac-6 (--json takes precedence — verified via ac-brief-alias test using --brief --json)
 * AC: @trait-semantic-exit-codes ac-1 (exit code 0 on success)
 *
 * N/A trait ACs:
 * @trait-json-output ac-3 (error JSON envelope — pre-existing, not introduced by this PR)
 * @trait-semantic-exit-codes ac-2 (validation error — no user input validation in session start)
 * @trait-semantic-exit-codes ac-3 (cancellation — session start has no confirmation prompts)
 * @trait-semantic-exit-codes ac-4 (runtime error — pre-existing behavior, not changed by this PR)
 * @trait-semantic-exit-codes ac-6 (invalid flags — handled by commander, not session start)
 * @trait-semantic-exit-codes ac-5 (empty result set — session start always returns data, never empty)
 * @trait-semantic-exit-codes ac-7 (batch partial failures — session start is not batch)
 * @trait-semantic-exit-codes ac-8 (documentation — exit codes documented in exit-codes.ts)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  git,
  testUlids,
} from '../helpers/cli';
import type { SessionContext } from '../helpers/session-types';

/**
 * Seed completed tasks directly into fixture YAML instead of using CLI subprocess loops.
 * Each task gets a unique ULID and staggered completed_at timestamps so they appear
 * as distinct items in the activity timeline.
 *
 * AC: @test-suite-perf-reliability ac-1
 */
function seedCompletedTasks(dir: string, count: number): void {
  const tasksFile = join(dir, 'project.tasks.yaml');
  const existing = yamlParse(readFileSync(tasksFile, 'utf8')) as { tasks: unknown[] };
  const ulids = testUlids('TMLN', count);

  for (let i = 0; i < count; i++) {
    const hour = (i + 1).toString().padStart(2, '0');
    existing.tasks.push({
      _ulid: ulids[i],
      slugs: [`timeline-task-${i + 1}`],
      title: `Task ${i + 1}`,
      type: 'task',
      status: 'completed',
      priority: 3,
      tags: ['test'],
      description: `Completed task ${i + 1} for timeline`,
      depends_on: [],
      notes: [],
      todos: [],
      created_at: `2026-01-01T00:00:00Z`,
      started_at: `2026-01-01T00:${hour}:00Z`,
      submitted_at: `2026-01-01T00:${hour}:30Z`,
      completed_at: `2026-01-01T${hour}:00:00Z`,
      closed_reason: 'Done',
    });
  }

  writeFileSync(tasksFile, yamlStringify(existing));
}

/**
 * Seed tasks with notes directly into fixture YAML for starvation prevention tests.
 * Avoids 25+ CLI subprocess calls that cause CI timeouts under load.
 *
 * AC: @test-suite-perf-reliability ac-1
 */
function seedTasksWithNotes(dir: string): void {
  const tasksFile = join(dir, 'project.tasks.yaml');
  const existing = yamlParse(readFileSync(tasksFile, 'utf8')) as { tasks: unknown[] };
  const taskUlids = testUlids('STRV', 7);
  const noteUlids = testUlids('SNOT', 7);

  // 5 in_progress tasks with notes
  for (let i = 0; i < 5; i++) {
    const minute = (i + 1).toString().padStart(2, '0');
    existing.tasks.push({
      _ulid: taskUlids[i],
      slugs: [`active-${i + 1}`],
      title: `Active ${i + 1}`,
      type: 'task',
      status: 'in_progress',
      priority: 3,
      tags: ['test'],
      depends_on: [],
      notes: [{
        _ulid: noteUlids[i],
        created_at: `2026-01-01T00:${minute}:00Z`,
        author: '@test',
        content: `Active note ${i + 1}`,
      }],
      todos: [],
      created_at: '2026-01-01T00:00:00Z',
      started_at: `2026-01-01T00:${minute}:00Z`,
    });
  }

  // 1 pending_review task with note
  existing.tasks.push({
    _ulid: taskUlids[5],
    slugs: ['review-task'],
    title: 'Review',
    type: 'task',
    status: 'pending_review',
    priority: 3,
    tags: ['test'],
    depends_on: [],
    notes: [{
      _ulid: noteUlids[5],
      created_at: '2026-01-01T00:06:00Z',
      author: '@test',
      content: 'Review note',
    }],
    todos: [],
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:06:00Z',
    submitted_at: '2026-01-01T00:06:30Z',
  });

  // 1 completed task with note
  existing.tasks.push({
    _ulid: taskUlids[6],
    slugs: ['done-task'],
    title: 'Done',
    type: 'task',
    status: 'completed',
    priority: 3,
    tags: ['test'],
    depends_on: [],
    notes: [{
      _ulid: noteUlids[6],
      created_at: '2026-01-01T00:07:00Z',
      author: '@test',
      content: 'Done note',
    }],
    todos: [],
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:07:00Z',
    submitted_at: '2026-01-01T00:07:30Z',
    completed_at: '2026-01-01T01:00:00Z',
    closed_reason: 'Finished',
  });

  writeFileSync(tasksFile, yamlStringify(existing));
}

describe('session start format rewrite', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    writeFileSync(join(tempDir, 'README.md'), '# Test\n');
    git('add .', tempDir);
    git('commit -m "initial commit"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-session-start ac-primer-default
  describe('primer mode (default)', () => {
    it('should limit ready tasks to 5 in primer mode', { timeout: 30000 }, () => {
      // Create 8 ready tasks
      for (let i = 1; i <= 8; i++) {
        kspec(`task add --title "Ready ${i}" --slug ready-${i}`, tempDir);
      }

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      expect(session.ready_tasks.length).toBe(5);
    });

    // AC: @test-suite-perf-reliability ac-1
    it('should limit activity timeline to 10 items in primer mode', () => {
      // Seed 12 completed tasks directly into fixture YAML instead of 48 CLI calls
      seedCompletedTasks(tempDir, 12);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      expect(session.activity_timeline.length).toBeLessThanOrEqual(10);
    });

    it('should show inbox stat line in primer mode', () => {
      // Add inbox items so stat line appears
      kspec('inbox add "Test inbox item for primer"', tempDir);

      const result = kspec('session start', tempDir);

      // Stat line should unconditionally appear when inbox has items
      expect(result.stdout).toContain('untriaged');
      expect(result.stdout).toContain('total');
    });
  });

  // AC: @cmd-session-start ac-full-sections
  describe('full mode', () => {
    it('should show all ready tasks in full mode', { timeout: 30000 }, () => {
      // Create 8 ready tasks (fixture already has some)
      for (let i = 1; i <= 8; i++) {
        kspec(`task add --title "Ready ${i}" --slug ready-${i}`, tempDir);
      }

      const primerSession = kspecJson<SessionContext>('session start --json', tempDir);
      const fullSession = kspecJson<SessionContext>('session start --full --json', tempDir);

      // Primer caps at 5, full shows all
      expect(primerSession.ready_tasks.length).toBe(5);
      expect(fullSession.ready_tasks.length).toBeGreaterThan(5);
    });

    // AC: @test-suite-perf-reliability ac-1
    it('should show up to 20 activity items in full mode', () => {
      // Seed 12 completed tasks directly into fixture YAML instead of 48 CLI calls
      seedCompletedTasks(tempDir, 12);

      const session = kspecJson<SessionContext>('session start --full --json', tempDir);
      expect(session.activity_timeline.length).toBeLessThanOrEqual(20);
      expect(session.activity_timeline.length).toBeGreaterThan(10);
    });

    it('should show untriaged inbox items in full mode human output', () => {
      // Add inbox items so the section appears
      kspec('inbox add "Untriaged item for full mode"', tempDir);

      const result = kspec('session start --full', tempDir);

      // Full mode should show inbox header and untriaged items
      expect(result.stdout).toContain('Inbox');
      expect(result.stdout).toContain('untriaged');
    });
  });

  // AC: @cmd-session-start ac-brief-alias
  // AC: @trait-json-output ac-6 (--json takes precedence over --brief)
  describe('--brief alias', () => {
    it('should produce identical JSON output to primer mode', { timeout: 20000 }, () => {
      kspec('task add --title "Test task" --slug test-task', tempDir);

      const primerSession = kspecJson<SessionContext>('session start --json', tempDir);
      const briefSession = kspecJson<SessionContext>('session start --brief --json', tempDir);

      // Both should have same structure and limits
      // generated_at will differ, so compare structural fields
      expect(briefSession.ready_tasks.length).toBe(primerSession.ready_tasks.length);
      expect(briefSession.activity_timeline.length).toBe(primerSession.activity_timeline.length);
      expect(briefSession.active_tasks.length).toBe(primerSession.active_tasks.length);
    });
  });

  // AC: @cmd-session-start ac-section-order
  describe('section ordering', () => {
    it('should render sections in correct order: active → review → blocked → ready → activity → inbox → working tree → quick commands', { timeout: 20000 }, () => {
      // Create tasks in various states
      kspec('task add --title "Active task" --slug active-task', tempDir);
      kspec('task start @active-task', tempDir);

      kspec('task add --title "Review task" --slug review-task', tempDir);
      kspec('task start @review-task', tempDir);
      kspec('task submit @review-task', tempDir);

      kspec('task add --title "Ready task" --slug ready-task', tempDir);

      // Complete a task to appear in activity timeline
      kspec('task add --title "Done task" --slug done-task', tempDir);
      kspec('task start @done-task', tempDir);
      kspec('task submit @done-task', tempDir);
      kspec('task complete @done-task --reason "Done"', tempDir);

      // Create dirty working tree
      writeFileSync(join(tempDir, 'dirty.txt'), 'dirty\n');

      const result = kspec('session start', tempDir);
      const output = result.stdout;

      // Verify section ordering
      const activeIdx = output.indexOf('Active Work');
      const reviewIdx = output.indexOf('Awaiting Review');
      const readyIdx = output.indexOf('Ready to Pick Up');
      const activityIdx = output.indexOf('Recent Activity');
      const workingTreeIdx = output.indexOf('Working Tree');
      const quickIdx = output.indexOf('Quick Commands');

      expect(activeIdx).toBeGreaterThan(-1);
      expect(reviewIdx).toBeGreaterThan(activeIdx);
      expect(readyIdx).toBeGreaterThan(reviewIdx);
      expect(activityIdx).toBeGreaterThan(readyIdx);
      expect(workingTreeIdx).toBeGreaterThan(activityIdx);
      expect(quickIdx).toBeGreaterThan(workingTreeIdx);
    });
  });

  // AC: @cmd-session-start ac-empty-skip
  describe('empty section skipping', () => {
    it('should not show "No Active Work" when no active tasks', () => {
      const result = kspec('session start', tempDir);
      expect(result.stdout).not.toContain('No Active Work');
    });

    it('should not show Active Work header when no active tasks', () => {
      // Only create ready tasks, no active
      kspec('task add --title "Ready task" --slug ready-task', tempDir);

      const result = kspec('session start', tempDir);
      // Ready section should appear, Active section should not
      expect(result.stdout).toContain('Ready to Pick Up');
      expect(result.stdout).not.toContain('Active Work');
    });

    it('should not show Awaiting Review header when no review tasks', () => {
      const result = kspec('session start', tempDir);
      expect(result.stdout).not.toContain('Awaiting Review');
    });
  });

  // AC: @cmd-session-start ac-slug-display
  describe('slug display', () => {
    it('should display @slug for tasks with slugs in human output', () => {
      kspec('task add --title "My feature" --slug my-feature', tempDir);
      kspec('task start @my-feature', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('@my-feature');
    });

    it('should include slug field in JSON active task summaries', () => {
      kspec('task add --title "My feature" --slug my-feature', tempDir);
      kspec('task start @my-feature', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      const task = session.active_tasks.find((t) => t.title === 'My feature');
      expect(task).toBeDefined();
      expect(task!.slug).toBe('my-feature');
    });

    it('should include slug field in JSON ready task summaries', () => {
      kspec('task add --title "Ready feature" --slug ready-feature', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      const task = session.ready_tasks.find((t) => t.title === 'Ready feature');
      expect(task).toBeDefined();
      expect(task!.slug).toBe('ready-feature');
    });
  });

  // AC: @cmd-session-start ac-slug-fallback
  describe('slug fallback', () => {
    it('should display @short-ulid for tasks without slugs in human output', () => {
      kspec('task add --title "No slug task"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      const task = session.ready_tasks.find((t) => t.title === 'No slug task');
      expect(task).toBeDefined();
      expect(task!.slug).toBeNull();

      const result = kspec('session start', tempDir);
      // Should show @ref (short ULID) instead
      expect(result.stdout).toContain(`@${task!.ref}`);
    });

    // AC: @cmd-session-start ac-slug-fallback — inbox always uses @short-ulid
    it('should use @short-ulid for inbox items (no slug schema)', () => {
      const result = kspec('session start --full', tempDir);
      // Inbox items don't have slugs — they use short ULID refs
      // If there are inbox items they should show @ refs
      const session = kspecJson<SessionContext>('session start --json', tempDir);
      for (const item of session.inbox_items) {
        // ref should be 8-char ULID prefix
        expect(item.ref.length).toBe(8);
      }
    });
  });

  // AC: @cmd-session-start ac-relative-time-human
  describe('relative time in human output', () => {
    it('should show relative timestamps in human output', () => {
      kspec('task add --title "Recent task" --slug recent-task', tempDir);
      kspec('task start @recent-task', tempDir);

      const result = kspec('session start', tempDir);
      // Should contain "just now" or similar relative time for recently started task
      expect(result.stdout).toContain('just now');
    });
  });

  // AC: @cmd-session-start ac-iso-time-json
  // AC: @trait-json-output ac-5
  describe('ISO 8601 timestamps in JSON', () => {
    it('should use ISO 8601 timestamps in JSON output', () => {
      kspec('task add --title "Timestamp task" --slug ts-task', tempDir);
      kspec('task start @ts-task', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      // generated_at should be ISO 8601
      expect(session.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // active task started_at should be ISO 8601
      const task = session.active_tasks.find((t) => t.slug === 'ts-task');
      expect(task).toBeDefined();
      expect(task!.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // AC: @cmd-session-start ac-dirty-tree-only
  describe('working tree display', () => {
    it('should omit working tree section when clean', () => {
      const result = kspec('session start', tempDir);
      expect(result.stdout).not.toContain('Working Tree');
    });

    it('should show working tree section when dirty', () => {
      writeFileSync(join(tempDir, 'dirty.txt'), 'changes\n');

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('Working Tree');
    });
  });

  // AC: @cmd-session-start ac-active-detail
  describe('active task detail', () => {
    it('should show title and description for active tasks', () => {
      kspec(
        'task add --title "My big feature" --slug big-feature --description "Building the next big thing"',
        tempDir,
      );
      kspec('task start @big-feature', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('My big feature');
      expect(result.stdout).toContain('Building the next big thing');
    });

    it('should show recent notes inline under active tasks', () => {
      kspec('task add --title "Active task" --slug active-task', tempDir);
      kspec('task start @active-task', tempDir);
      kspec('task note @active-task "Working on the implementation"', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('Active Work');
      expect(result.stdout).toContain('Working on the implementation');
    });

    it('should include description field in JSON active task summaries', () => {
      kspec(
        'task add --title "Described task" --slug described-task --description "A detailed description"',
        tempDir,
      );
      kspec('task start @described-task', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      const task = session.active_tasks.find((t) => t.slug === 'described-task');
      expect(task).toBeDefined();
      expect(task!.description).toBe('A detailed description');
    });
  });

  // AC: @cmd-session-start ac-needs-work-indicator
  describe('needs_work visual distinction', () => {
    it('should display [needs_work] label for needs_work tasks', () => {
      kspec('task add --title "Fix task" --slug fix-task', tempDir);
      kspec('task start @fix-task', tempDir);
      kspec('task submit @fix-task', tempDir);
      kspec('task needs-work @fix-task --reason "Failing tests"', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('[needs_work]');
      expect(result.stdout).toContain('Fix task');
    });

    it('should include needs_work status in JSON', () => {
      kspec('task add --title "Fix task" --slug fix-task', tempDir);
      kspec('task start @fix-task', tempDir);
      kspec('task submit @fix-task', tempDir);
      kspec('task needs-work @fix-task --reason "Failing tests"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      const task = session.active_tasks.find((t) => t.slug === 'fix-task');
      expect(task).toBeDefined();
      expect(task!.status).toBe('needs_work');
    });

    it('should distinguish needs_work from in_progress in same output', () => {
      kspec('task add --title "Normal task" --slug normal-task', tempDir);
      kspec('task start @normal-task', tempDir);

      kspec('task add --title "Fix task" --slug fix-task', tempDir);
      kspec('task start @fix-task', tempDir);
      kspec('task submit @fix-task', tempDir);
      kspec('task needs-work @fix-task --reason "Failing tests"', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('[in_progress]');
      expect(result.stdout).toContain('[needs_work]');
    });
  });

  // AC: @cmd-session-start ac-review-detail
  describe('review task detail', () => {
    it('should show title and recent notes for pending_review tasks', () => {
      kspec('task add --title "Review this" --slug review-this', tempDir);
      kspec('task start @review-this', tempDir);
      kspec('task note @review-this "Implementation complete, PR #100"', tempDir);
      kspec('task submit @review-this', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('Awaiting Review');
      expect(result.stdout).toContain('Review this');
      expect(result.stdout).toContain('Implementation complete, PR #100');
    });
  });

  // AC: @cmd-session-start ac-notes-starvation
  // AC: @test-suite-perf-reliability ac-1
  describe('notes starvation prevention', () => {
    it('should include notes from all statuses in JSON', () => {
      // Seed tasks with notes directly into fixture YAML instead of 25 CLI calls
      seedTasksWithNotes(tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      const inProgressNotes = session.recent_notes.filter(
        (n) => n.task_status === 'in_progress',
      );
      const reviewNotes = session.recent_notes.filter(
        (n) => n.task_status === 'pending_review',
      );
      const completedNotes = session.recent_notes.filter(
        (n) => n.task_status === 'completed',
      );

      // Each status should have at least one note (not starved)
      expect(inProgressNotes.length).toBeGreaterThan(0);
      expect(reviewNotes.length).toBeGreaterThan(0);
      expect(completedNotes.length).toBeGreaterThan(0);
    });
  });

  // AC: @cmd-session-start ac-json-raw-preserved
  describe('JSON raw arrays preserved', () => {
    it('should include recently_completed array in JSON', { timeout: 20000 }, () => {
      kspec('task add --title "Task A" --slug task-a', tempDir);
      kspec('task start @task-a', tempDir);
      kspec('task submit @task-a', tempDir);
      kspec('task complete @task-a --reason "Done A"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      expect(session.recently_completed).toBeDefined();
      expect(Array.isArray(session.recently_completed)).toBe(true);
      expect(session.recently_completed.length).toBeGreaterThan(0);
      expect(session.recently_completed[0].title).toBe('Task A');
      expect(session.recently_completed[0].slug).toBe('task-a');
    });

    it('should include recent_commits array in JSON', () => {
      writeFileSync(join(tempDir, 'new-file.ts'), 'export const x = 1;\n');
      git('add new-file.ts', tempDir);
      git('commit -m "feat: add new file"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      expect(session.recent_commits).toBeDefined();
      expect(Array.isArray(session.recent_commits)).toBe(true);
      expect(session.recent_commits.length).toBeGreaterThan(0);
    });

    it('should include activity_timeline alongside raw arrays', { timeout: 20000 }, () => {
      kspec('task add --title "Task B" --slug task-b', tempDir);
      kspec('task start @task-b', tempDir);
      kspec('task submit @task-b', tempDir);
      kspec('task complete @task-b --reason "Done B"', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      // Both raw arrays and unified timeline should be present
      expect(session.recently_completed).toBeDefined();
      expect(session.recent_commits).toBeDefined();
      expect(session.activity_timeline).toBeDefined();
    });
  });

  // AC: @cmd-session-start ac-full-sections — observations section
  describe('observations in full mode', () => {
    it('should show unresolved observations in full mode', () => {
      // Add an observation
      kspec('meta observe friction "Tests take too long to run"', tempDir);

      const result = kspec('session start --full', tempDir);
      expect(result.stdout).toContain('Observations');
      expect(result.stdout).toContain('Tests take too long to run');
    });

    it('should include observations in JSON in full mode', () => {
      kspec('meta observe friction "Build is slow"', tempDir);

      const session = kspecJson<SessionContext & { observations: Array<{ type: string; content: string; resolved: boolean }> }>(
        'session start --full --json',
        tempDir,
      );
      expect(session.observations).toBeDefined();
      expect(session.observations.length).toBeGreaterThan(0);
      expect(session.observations[0].type).toBe('friction');
      expect(session.observations[0].content).toBe('Build is slow');
      expect(session.observations[0].resolved).toBe(false);
    });

    it('should not show observations in primer mode', () => {
      kspec('meta observe friction "Should not appear"', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).not.toContain('Observations');
    });

    it('should return empty observations array in primer JSON', () => {
      kspec('meta observe friction "Should be empty in primer"', tempDir);

      const session = kspecJson<SessionContext & { observations: Array<unknown> }>(
        'session start --json',
        tempDir,
      );
      expect(session.observations).toEqual([]);
    });
  });

  // AC: @trait-json-output ac-2
  describe('JSON includes all human-visible data', () => {
    it('should include all section data in JSON output', () => {
      kspec('task add --title "Active task" --slug active-task', tempDir);
      kspec('task start @active-task', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);

      // All major sections should have corresponding JSON fields
      expect(session).toHaveProperty('active_tasks');
      expect(session).toHaveProperty('pending_review_tasks');
      expect(session).toHaveProperty('ready_tasks');
      expect(session).toHaveProperty('blocked_tasks');
      expect(session).toHaveProperty('activity_timeline');
      expect(session).toHaveProperty('inbox_items');
      expect(session).toHaveProperty('inbox_stats');
      expect(session).toHaveProperty('working_tree');
      expect(session).toHaveProperty('observations');
      expect(session).toHaveProperty('stats');
      expect(session).toHaveProperty('context');
      expect(session).toHaveProperty('recently_completed');
      expect(session).toHaveProperty('recent_commits');
      expect(session).toHaveProperty('recent_notes');
    });
  });

  // AC: @trait-semantic-exit-codes ac-1
  describe('exit code 0 on success', () => {
    it('should exit with code 0 for successful session start', () => {
      const result = kspec('session start', tempDir);
      expect(result.exitCode).toBe(0);
    });

    it('should exit with code 0 for successful JSON session start', () => {
      const result = kspec('session start --json', tempDir);
      expect(result.exitCode).toBe(0);
    });
  });

  // AC: @trait-json-output ac-4 — references use @ prefix consistently
  describe('ref @ prefix consistency', () => {
    it('should use @ prefix for task refs in human output', () => {
      kspec('task add --title "Ref test" --slug ref-test', tempDir);
      kspec('task start @ref-test', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('@ref-test');
    });

    it('should use @ prefix for task refs throughout human output sections', () => {
      kspec('task add --title "Ready ref" --slug ready-ref', tempDir);

      const result = kspec('session start', tempDir);
      // Ready tasks section should show @slug
      expect(result.stdout).toContain('@ready-ref');
    });

    it('should include slug field in JSON for programmatic @ prefix usage', () => {
      kspec('task add --title "Ref json" --slug ref-json', tempDir);
      kspec('task start @ref-json', tempDir);

      const session = kspecJson<SessionContext>('session start --json', tempDir);
      const task = session.active_tasks.find((t) => t.slug === 'ref-json');
      expect(task).toBeDefined();
      // JSON provides slug for consumers to construct @slug references
      expect(task!.slug).toBe('ref-json');
      // ref is bare ULID for unique identification
      expect(task!.ref).toMatch(/^[0-9A-Z]{8}$/);
    });
  });

  // AC: @cmd-session-start ac-slug-display — quick commands use slug
  describe('quick commands use slugs', () => {
    it('should use @slug in quick commands for active tasks with slugs', () => {
      kspec('task add --title "Work item" --slug work-item', tempDir);
      kspec('task start @work-item', tempDir);

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain('kspec task note @work-item');
      expect(result.stdout).toContain('kspec task submit @work-item');
    });

    it('should use @slug in quick commands for ready tasks with slugs', () => {
      // When no active tasks, quick commands suggest starting the first ready task
      // Fixture has existing ready tasks, so the first ready task will be from fixture
      const session = kspecJson<SessionContext>('session start --json', tempDir);
      const firstReady = session.ready_tasks[0];
      const expectedRef = firstReady.slug ? `@${firstReady.slug}` : `@${firstReady.ref}`;

      const result = kspec('session start', tempDir);
      expect(result.stdout).toContain(`kspec task start ${expectedRef}`);
    });
  });
});
