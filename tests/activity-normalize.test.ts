import { describe, it, expect } from 'vitest';
import {
  parseCommitMessage,
  parseDiffChanges,
  normalizeTaskActivity,
  type RawTaskCommit,
} from '../src/utils/activity';

// ─── Helpers ───

function makeCommit(overrides: Partial<RawTaskCommit> = {}): RawTaskCommit {
  return {
    hash: 'abc1234',
    fullHash: 'abc1234567890abcdef1234567890abcdef123456',
    timestamp: '2026-03-16T12:00:00Z',
    author: 'Test User',
    message: 'Some commit',
    diff: '',
    ...overrides,
  };
}

// AC: @task-activity-git-query ac-3
describe('parseCommitMessage — ac-3: parse operation type from commit message', () => {
  const cases: Array<[string, string, string]> = [
    ['Start @task-foo', 'started', 'Task started'],
    ['Complete @task-foo', 'completed', 'Task completed'],
    ['Complete @task-foo: Merged to dev.', 'completed', 'Task completed: Merged to dev.'],
    ['Note on @task-foo', 'note_added', 'Note added'],
    ['Add task @task-foo: Some title', 'created', 'Task created'],
    ['task-submit @task-foo', 'submitted', 'Task submitted for review'],
    ['task-needs-work @task-foo', 'needs_work', 'Task returned for changes'],
    ['task-block @task-foo', 'blocked', 'Task blocked'],
    ['task-cancel @task-foo', 'cancelled', 'Task cancelled'],
    ['task-set @task-foo', 'field_updated', 'Task updated'],
    ['Update @task-foo', 'field_updated', 'Task updated'],
    ['batch: 3 commands', 'field_updated', 'batch: 3 commands'],
    ['batch: 1 command', 'field_updated', 'batch: 1 command'],
    ['spec-sync @01ABC', 'field_updated', 'Spec sync'],
  ];

  it.each(cases)('"%s" → type=%s, summary="%s"', (message, expectedType, expectedSummary) => {
    const result = parseCommitMessage(message);
    expect(result.type).toBe(expectedType);
    expect(result.summary).toBe(expectedSummary);
  });

  it('returns "unknown" for unrecognized messages', () => {
    const result = parseCommitMessage('some random message');
    expect(result.type).toBe('unknown');
    expect(result.summary).toBe('some random message');
  });
});

// AC: @task-activity-git-query ac-4
describe('parseDiffChanges — ac-4: extract field-level changes from diff', () => {
  it('detects status field change', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '--- a/project.tasks.yaml',
      '+++ b/project.tasks.yaml',
      '@@ -1,3 +1,3 @@',
      ' - _ulid: 01ABC',
      '-  status: pending',
      '+  status: in_progress',
      '   title: Test Task',
    ].join('\n');

    const changes = parseDiffChanges(diff);
    expect(changes).toContainEqual({
      field: 'status',
      oldValue: 'pending',
      newValue: 'in_progress',
    });
  });

  it('detects new note added', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -3,2 +3,8 @@',
      '   title: Test Task',
      '+  notes:',
      '+    - _ulid: 01NOTE000000000000000000',
      '+      content: My note content',
      '+      author: "@claude"',
    ].join('\n');

    const changes = parseDiffChanges(diff);
    expect(changes.some(c => c.field === 'notes')).toBe(true);
  });

  it('detects review_ref linkage', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,3 +1,4 @@',
      ' - _ulid: 01ABC',
      '   status: pending_review',
      '-  review_ref: null',
      '+  review_ref: "@01REVIEW"',
    ].join('\n');

    const changes = parseDiffChanges(diff);
    expect(changes).toContainEqual({
      field: 'review_ref',
      oldValue: 'null',
      newValue: '"@01REVIEW"',
    });
  });

  it('detects priority change', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,3 +1,3 @@',
      ' - _ulid: 01ABC',
      '-  priority: 3',
      '+  priority: 1',
    ].join('\n');

    const changes = parseDiffChanges(diff);
    expect(changes).toContainEqual({
      field: 'priority',
      oldValue: '3',
      newValue: '1',
    });
  });

  it('detects new field added (not previously present)', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,3 +1,4 @@',
      ' - _ulid: 01ABC',
      '   status: pending',
      '+  started_at: 2026-03-16T12:00:00Z',
    ].join('\n');

    const changes = parseDiffChanges(diff);
    expect(changes).toContainEqual({
      field: 'started_at',
      newValue: '2026-03-16T12:00:00Z',
    });
  });

  it('returns empty for empty diff', () => {
    expect(parseDiffChanges('')).toEqual([]);
  });

  it('handles multiple field changes in one diff', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,5 +1,5 @@',
      ' - _ulid: 01ABC',
      '-  status: pending',
      '+  status: in_progress',
      '-  priority: 3',
      '+  priority: 1',
      '   title: Test',
    ].join('\n');

    const changes = parseDiffChanges(diff);
    expect(changes.length).toBe(2);
    expect(changes.map(c => c.field).sort()).toEqual(['priority', 'status']);
  });
});

// AC: @task-activity-git-query ac-3, ac-4
describe('normalizeTaskActivity — integration', () => {
  it('uses diff-based detection when diff has field changes', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,3 +1,3 @@',
      ' - _ulid: 01ABC',
      '-  status: pending',
      '+  status: in_progress',
    ].join('\n');

    const commits = [makeCommit({ message: 'Start @task-foo', diff })];
    const entries = normalizeTaskActivity(commits);

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('state_change');
    expect(entries[0].detail?.from).toBe('pending');
    expect(entries[0].detail?.to).toBe('in_progress');
  });

  it('falls back to commit message when diff is empty', () => {
    const commits = [makeCommit({ message: 'Start @task-foo', diff: '' })];
    const entries = normalizeTaskActivity(commits);

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('started');
    expect(entries[0].summary).toBe('Task started');
  });

  it('falls back to commit message when diff has no parseable changes', () => {
    // Diff with only context lines (no +/- changes to scalar fields)
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,3 +1,3 @@',
      '  - _ulid: 01ABC',
      '    status: pending',
    ].join('\n');

    const commits = [makeCommit({ message: 'Note on @task-foo', diff })];
    const entries = normalizeTaskActivity(commits);

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('note_added');
  });

  it('produces multiple entries for multi-field changes in one commit', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,5 +1,5 @@',
      ' - _ulid: 01ABC',
      '-  status: pending',
      '+  status: in_progress',
      '-  priority: 3',
      '+  priority: 1',
    ].join('\n');

    const commits = [makeCommit({ message: 'task-set @task-foo', diff })];
    const entries = normalizeTaskActivity(commits);

    expect(entries.length).toBe(2);
    const types = entries.map(e => e.type);
    expect(types).toContain('state_change');
    expect(types).toContain('field_updated');
  });

  it('returns chronological order (oldest first)', () => {
    const commits = [
      makeCommit({
        message: 'Start @task-foo',
        timestamp: '2026-03-16T14:00:00Z',
        hash: 'newer01',
      }),
      makeCommit({
        message: 'Add task @task-foo: Title',
        timestamp: '2026-03-16T12:00:00Z',
        hash: 'older01',
      }),
    ];

    const entries = normalizeTaskActivity(commits);

    // Input is newest-first (git log order), output should be oldest-first
    expect(entries[0].commitHash).toBe('older01');
    expect(entries[1].commitHash).toBe('newer01');
  });

  it('preserves commit hash on all entries', () => {
    const commits = [
      makeCommit({ hash: 'aaa1111', message: 'Start @task-foo' }),
    ];
    const entries = normalizeTaskActivity(commits);

    expect(entries[0].commitHash).toBe('aaa1111');
  });

  it('handles review_ref change in diff', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,4 +1,4 @@',
      ' - _ulid: 01ABC',
      '   status: pending_review',
      '-  review_ref: null',
      '+  review_ref: "@01REVIEWREF"',
    ].join('\n');

    const commits = [makeCommit({ message: 'review-task-link @01REVIEW', diff })];
    const entries = normalizeTaskActivity(commits);

    expect(entries.some(e => e.type === 'review_linked')).toBe(true);
  });

  it('handles creation commit (all adds, no removes)', () => {
    const diff = [
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '--- /dev/null',
      '+++ b/project.tasks.yaml',
      '@@ -0,0 +1,5 @@',
      '+- _ulid: 01ABC',
      '+  title: New Task',
      '+  status: pending',
      '+  priority: 2',
    ].join('\n');

    const commits = [makeCommit({ message: 'Add task @task-foo: New Task', diff })];
    const entries = normalizeTaskActivity(commits);

    // Creation has new fields but no old values — should produce entries or fall back
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});
