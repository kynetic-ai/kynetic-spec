import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTempDir, initGitRepo, testUlids } from './helpers/cli';
import {
  findTaskBlockLines,
  getRawTaskCommits,
  parseGitLogLOutput,
} from '../src/utils/activity';

const TASKS_FILE = 'project.tasks.yaml';

/**
 * Set up a git repo with a project.tasks.yaml containing multiple tasks.
 * Simulates a shadow branch worktree with task mutations tracked via git.
 */
async function setupTaskRepo(tmpDir: string, tasks: string): Promise<void> {
  initGitRepo(tmpDir);
  const tasksPath = path.join(tmpDir, TASKS_FILE);
  fs.writeFileSync(tasksPath, tasks, 'utf-8');
  execSync(`git add ${TASKS_FILE} && git commit -m "Initial tasks"`, {
    cwd: tmpDir,
    stdio: 'pipe',
  });
}

/**
 * Mutate the tasks file and commit.
 */
function mutateAndCommit(tmpDir: string, content: string, message: string): void {
  fs.writeFileSync(path.join(tmpDir, TASKS_FILE), content, 'utf-8');
  execSync(`git add ${TASKS_FILE} && git commit -m "${message}"`, {
    cwd: tmpDir,
    stdio: 'pipe',
  });
}

describe('findTaskBlockLines', () => {
  let tmpDir: string;
  const [ULID_A, ULID_B, ULID_C] = testUlids('ACTVTY', 3);

  beforeEach(async () => {
    tmpDir = await createTempDir('activity-test-');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds line range for first task in multi-task file', () => {
    const content = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: pending',
      `- _ulid: ${ULID_B}`,
      '  title: Task B',
      '  status: pending',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, TASKS_FILE), content, 'utf-8');

    const result = findTaskBlockLines(tmpDir, ULID_A);
    expect(result).toEqual([1, 3]);
  });

  it('finds line range for last task extending to EOF', () => {
    const content = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: pending',
      `- _ulid: ${ULID_B}`,
      '  title: Task B',
      '  status: pending',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, TASKS_FILE), content, 'utf-8');

    const result = findTaskBlockLines(tmpDir, ULID_B);
    expect(result).toEqual([4, 6]);
  });

  it('finds line range for middle task in three-task file', () => {
    const content = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      `- _ulid: ${ULID_B}`,
      '  title: Task B',
      '  status: in_progress',
      '  notes:',
      '    - _ulid: 01N0TE0000000000000000000',
      '      content: A note',
      `- _ulid: ${ULID_C}`,
      '  title: Task C',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, TASKS_FILE), content, 'utf-8');

    const result = findTaskBlockLines(tmpDir, ULID_B);
    expect(result).toEqual([3, 8]);
  });

  it('returns null for non-existent task', () => {
    const content = `- _ulid: ${ULID_A}\n  title: Task A\n`;
    fs.writeFileSync(path.join(tmpDir, TASKS_FILE), content, 'utf-8');

    const result = findTaskBlockLines(tmpDir, '01XXXXXXXXXXXXXXXXXXXXXXXXX');
    expect(result).toBeNull();
  });

  it('returns null when tasks file does not exist', () => {
    const result = findTaskBlockLines(tmpDir, ULID_A);
    expect(result).toBeNull();
  });
});

describe('parseGitLogLOutput', () => {
  it('parses single commit output', () => {
    const output = [
      'abc1234567890abcdef1234567890abcdef123456\x001999-12-31T23:59:59-08:00\x00Test Author\x00Initial commit\x00',
      '',
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '--- /dev/null',
      '+++ b/project.tasks.yaml',
      '@@ -0,0 +1,3 @@',
      '+- _ulid: 01ABC',
      '+  title: Test',
      '+  status: pending',
    ].join('\n');

    const result = parseGitLogLOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe('abc1234');
    expect(result[0].fullHash).toBe('abc1234567890abcdef1234567890abcdef123456');
    expect(result[0].timestamp).toBe('1999-12-31T23:59:59-08:00');
    expect(result[0].author).toBe('Test Author');
    expect(result[0].message).toBe('Initial commit');
    expect(result[0].diff).toContain('+- _ulid: 01ABC');
  });

  it('parses multiple commits', () => {
    const output = [
      'aaaa000000000000000000000000000000000000\x002026-01-01T00:00:00Z\x00Alice\x00Second change\x00',
      '',
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -1,3 +1,3 @@',
      ' - _ulid: 01ABC',
      '-  status: pending',
      '+  status: in_progress',
      '',
      'bbbb000000000000000000000000000000000000\x002026-01-01T00:00:00Z\x00Bob\x00Initial\x00',
      '',
      'diff --git a/project.tasks.yaml b/project.tasks.yaml',
      '@@ -0,0 +1,3 @@',
      '+- _ulid: 01ABC',
      '+  title: Test',
    ].join('\n');

    const result = parseGitLogLOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0].author).toBe('Alice');
    expect(result[0].message).toBe('Second change');
    expect(result[1].author).toBe('Bob');
    expect(result[1].message).toBe('Initial');
  });

  it('returns empty array for empty output', () => {
    expect(parseGitLogLOutput('')).toEqual([]);
    expect(parseGitLogLOutput('  \n  ')).toEqual([]);
  });
});

// AC: @task-activity-git-query ac-1
describe('getRawTaskCommits — ac-1: returns all commits that modified the task', () => {
  let tmpDir: string;
  const [ULID_A, ULID_B] = testUlids('GTRW', 2);

  beforeEach(async () => {
    tmpDir = await createTempDir('activity-ac1-');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns the creation commit', async () => {
    const initial = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: pending',
    ].join('\n');
    await setupTaskRepo(tmpDir, initial);

    const commits = getRawTaskCommits(tmpDir, ULID_A);
    expect(commits.length).toBeGreaterThanOrEqual(1);
    expect(commits.some(c => c.message === 'Initial tasks')).toBe(true);
  });

  it('returns state transitions and field changes', async () => {
    const initial = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: pending',
    ].join('\n');
    await setupTaskRepo(tmpDir, initial);

    // State transition
    const updated = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: in_progress',
    ].join('\n');
    mutateAndCommit(tmpDir, updated, 'Start @task-a');

    // Note addition
    const withNote = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: in_progress',
      '  notes:',
      '    - content: First note',
    ].join('\n');
    mutateAndCommit(tmpDir, withNote, 'Note on @task-a');

    const commits = getRawTaskCommits(tmpDir, ULID_A);
    expect(commits.length).toBe(3);
    expect(commits[0].message).toBe('Note on @task-a');
    expect(commits[1].message).toBe('Start @task-a');
    expect(commits[2].message).toBe('Initial tasks');
  });

  it('returns empty array for non-existent task', async () => {
    const initial = `- _ulid: ${ULID_A}\n  title: Task A\n  status: pending\n`;
    await setupTaskRepo(tmpDir, initial);

    const commits = getRawTaskCommits(tmpDir, '01XXXXXXXXXXXXXXXXXXXXXXXXX');
    expect(commits).toEqual([]);
  });
});

// AC: @task-activity-git-query ac-2
describe('getRawTaskCommits — ac-2: only includes commits for the specific task', () => {
  let tmpDir: string;
  const [ULID_A, ULID_B] = testUlids('GTRW2', 2);

  beforeEach(async () => {
    tmpDir = await createTempDir('activity-ac2-');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('excludes changes to other tasks in the same file', async () => {
    const initial = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: pending',
      `- _ulid: ${ULID_B}`,
      '  title: Task B',
      '  status: pending',
    ].join('\n');
    await setupTaskRepo(tmpDir, initial);

    // Only modify Task B
    const updated = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: pending',
      `- _ulid: ${ULID_B}`,
      '  title: Task B',
      '  status: in_progress',
    ].join('\n');
    mutateAndCommit(tmpDir, updated, 'Start @task-b');

    // Query for Task A — should NOT include the Task B change
    const commitsA = getRawTaskCommits(tmpDir, ULID_A);
    // Task A was only in the initial commit (creation)
    expect(commitsA.every(c => c.message !== 'Start @task-b')).toBe(true);

    // Query for Task B — should include both creation and state change
    const commitsB = getRawTaskCommits(tmpDir, ULID_B);
    expect(commitsB.some(c => c.message === 'Start @task-b')).toBe(true);
  });

  it('tracks changes to correct task when both tasks change in same commit', async () => {
    const initial = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: pending',
      `- _ulid: ${ULID_B}`,
      '  title: Task B',
      '  status: pending',
    ].join('\n');
    await setupTaskRepo(tmpDir, initial);

    // Only modify Task A
    const updated = [
      `- _ulid: ${ULID_A}`,
      '  title: Task A',
      '  status: in_progress',
      `- _ulid: ${ULID_B}`,
      '  title: Task B',
      '  status: pending',
    ].join('\n');
    mutateAndCommit(tmpDir, updated, 'Start @task-a');

    const commitsA = getRawTaskCommits(tmpDir, ULID_A);
    const commitsB = getRawTaskCommits(tmpDir, ULID_B);

    // Task A should have both: creation + state change
    expect(commitsA.length).toBe(2);
    // Task B should only have creation (git log -L may still show initial commit)
    // The key assertion: the "Start @task-a" commit should NOT appear for Task B
    // since its lines weren't modified
    expect(commitsB.every(c => c.message !== 'Start @task-a')).toBe(true);
  });
});
