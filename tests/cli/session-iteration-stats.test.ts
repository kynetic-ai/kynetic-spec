/**
 * Tests for getIterationStats function
 *
 * AC: @cli-session-context ac-iteration-stats
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from '../helpers/cli';

interface Task {
  status: string;
  slugs: string[];
}

describe('getIterationStats', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cli-session-context ac-iteration-stats
  it('should count tasks completed since a given time', () => {
    // Start a task and complete it
    kspec('task start @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --reason "Test completion"', tempDir);

    // The iteration stats would be queried internally by the dispatch engine
    // We can verify the task is completed by checking task list
    // Note: tasks list --json returns an array directly
    const tasks = kspecJson<Task[]>('tasks list --json', tempDir);
    const completedTasks = tasks.filter(t => t.status === 'completed');
    expect(completedTasks.length).toBeGreaterThanOrEqual(1);
  });

  it('should track multiple completions', () => {
    // Create and complete multiple tasks with unique slugs
    // Note: task workflow requires start -> submit -> complete
    const addA = kspec('task add --title "Task Alpha" --slug task-alpha-test', tempDir);
    const addB = kspec('task add --title "Task Beta" --slug task-beta-test', tempDir);
    expect(addA.exitCode).toBe(0);
    expect(addB.exitCode).toBe(0);

    // Task A: start -> submit -> complete
    kspec('task start @task-alpha-test', tempDir);
    kspec('task submit @task-alpha-test', tempDir);
    const completeA = kspec('task complete @task-alpha-test --reason "Done A"', tempDir);
    expect(completeA.exitCode).toBe(0);

    // Task B: start -> submit -> complete
    kspec('task start @task-beta-test', tempDir);
    kspec('task submit @task-beta-test', tempDir);
    const completeB = kspec('task complete @task-beta-test --reason "Done B"', tempDir);
    expect(completeB.exitCode).toBe(0);

    // Verify both are completed - use status filter for efficiency
    const tasks = kspecJson<Task[]>('tasks list --status completed --json', tempDir);
    // Filter to just our test tasks
    const completedNew = tasks.filter(t =>
      t.slugs.includes('task-alpha-test') || t.slugs.includes('task-beta-test')
    );
    expect(completedNew.length).toBe(2);
  });

  // AC: @cli-session-context ac-iteration-stats
  it('should count submitted (pending_review) tasks toward iteration limit', async () => {
    const { getIterationStats } = await import('../../src/cli/commands/session');
    const { initContext } = await import('../../src/parser/yaml');

    // Record time before submitting so we can query "since" this point
    const since = new Date();

    // Start and submit a task (not complete)
    kspec('task add --title "Submit Only" --slug submit-only', tempDir);
    kspec('task start @submit-only', tempDir);
    kspec('task submit @submit-only', tempDir);

    // Verify it's pending_review (not completed)
    const tasks = kspecJson<Task[]>('tasks list --json', tempDir);
    const submitted = tasks.find(t => t.slugs.includes('submit-only'));
    expect(submitted?.status).toBe('pending_review');

    // The key behavioral change: getIterationStats must count pending_review
    // tasks toward tasks_completed, not just completed tasks.
    const ctx = await initContext(tempDir);
    const stats = await getIterationStats(ctx, since);
    expect(stats.tasks_completed).toBeGreaterThanOrEqual(1);
  });
});
