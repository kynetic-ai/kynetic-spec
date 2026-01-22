import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTempFixtures, cleanupTempDir, kspec, kspecJson } from './helpers/cli';

describe('Integration: task set --clear-deps', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @spec-task-clear-deps ac-1
  it('should clear all dependencies when task has dependencies', () => {
    // Create tasks with a dependency chain
    kspec('task add --title "Parent Task" --slug parent-task', tempDir);
    kspec('task add --title "Child Task" --slug child-task', tempDir);
    kspec('task set @child-task --depends-on @parent-task', tempDir);

    // Verify dependency exists
    const before = kspecJson<{ depends_on: string[] }>('task get @child-task', tempDir);
    expect(before.depends_on).toHaveLength(1);
    expect(before.depends_on[0]).toBe('@parent-task');

    // Clear dependencies
    const result = kspec('task set @child-task --clear-deps', tempDir);
    expect(result.stdout).toContain('Updated task');
    expect(result.stdout).toContain('depends_on');

    // Verify dependencies cleared
    const after = kspecJson<{ depends_on: string[]; notes: Array<{ content: string; author?: string }> }>('task get @child-task', tempDir);
    expect(after.depends_on).toHaveLength(0);

    // Verify note was added documenting the change
    // AC: @task-set ac-author
    const clearNote = after.notes.find(n => n.content.includes('Dependencies cleared'));
    expect(clearNote).toBeDefined();
    expect(clearNote?.content).toContain('@parent-task');
    expect(clearNote?.author).toBe('@test'); // From KSPEC_AUTHOR env in test helper
  });

  // AC: @spec-task-clear-deps ac-2
  it('should report no changes when task has no dependencies', () => {
    // Create task without dependencies
    kspec('task add --title "Solo Task" --slug solo-task', tempDir);

    // Try to clear dependencies - use JSON mode to capture output
    const result = kspecJson<{ message: string }>('task set @solo-task --clear-deps', tempDir);

    // Should succeed with no-change message
    expect(result.message).toContain('no dependencies to clear');
  });

  // AC: @spec-task-clear-deps ac-3
  it('should error when --clear-deps and --depends-on used together', () => {
    kspec('task add --title "Test Task" --slug conflict-task', tempDir);
    kspec('task add --title "Dep Task" --slug dep-task', tempDir);

    const result = kspec('task set @conflict-task --clear-deps --depends-on @dep-task', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain('Cannot use --clear-deps and --depends-on together');
  });

  it('should clear multiple dependencies', () => {
    // Create tasks with multiple dependencies
    kspec('task add --title "Dep A" --slug dep-a', tempDir);
    kspec('task add --title "Dep B" --slug dep-b', tempDir);
    kspec('task add --title "Multi Dep Task" --slug multi-dep', tempDir);
    // Set dependencies using task set (task add doesn't have --depends-on)
    kspec('task set @multi-dep --depends-on @dep-a @dep-b', tempDir);

    // Verify multiple dependencies exist
    const before = kspecJson<{ depends_on: string[] }>('task get @multi-dep', tempDir);
    expect(before.depends_on).toHaveLength(2);

    // Clear all dependencies
    kspec('task set @multi-dep --clear-deps', tempDir);

    // Verify all cleared
    const after = kspecJson<{ depends_on: string[]; notes: Array<{ content: string }> }>('task get @multi-dep', tempDir);
    expect(after.depends_on).toHaveLength(0);

    // Verify note documents both original deps
    const clearNote = after.notes.find(n => n.content.includes('Dependencies cleared'));
    expect(clearNote?.content).toContain('@dep-a');
    expect(clearNote?.content).toContain('@dep-b');
  });

  // AC: @trait-json-output ac-1, ac-2 - JSON output is valid and contains task data
  it('should output valid JSON with task data when --json flag provided', () => {
    kspec('task add --title "Dep Task" --slug json-dep', tempDir);
    kspec('task add --title "JSON Task" --slug json-task', tempDir);
    kspec('task set @json-task --depends-on @json-dep', tempDir);

    const result = kspec('task set @json-task --clear-deps --json', tempDir);

    // Verify valid JSON (no ANSI codes would cause parse failure)
    const parsed = JSON.parse(result.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toContain('Updated task');

    // Verify task data is included
    expect(parsed.task).toBeDefined();
    expect(parsed.task.depends_on).toEqual([]);
    expect(parsed.task.notes).toBeDefined();
  });

  // AC: @trait-multi-ref-batch ac-1, ac-5 - Batch mode clears deps on multiple tasks
  it('should clear dependencies on multiple tasks with --refs flag', () => {
    // Setup: create dep and two tasks that depend on it
    kspec('task add --title "Shared Dep" --slug shared-dep', tempDir);
    kspec('task add --title "Batch Task 1" --slug batch-1', tempDir);
    kspec('task add --title "Batch Task 2" --slug batch-2', tempDir);
    kspec('task set @batch-1 --depends-on @shared-dep', tempDir);
    kspec('task set @batch-2 --depends-on @shared-dep', tempDir);

    // Clear deps on both tasks at once
    const result = kspec('task set --refs @batch-1 @batch-2 --clear-deps', tempDir);

    // Verify batch output format
    expect(result.stdout).toContain('2 of 2');

    // Verify both tasks had deps cleared
    const task1 = kspecJson<{ depends_on: string[] }>('task get @batch-1', tempDir);
    const task2 = kspecJson<{ depends_on: string[] }>('task get @batch-2', tempDir);
    expect(task1.depends_on).toHaveLength(0);
    expect(task2.depends_on).toHaveLength(0);
  });

  // AC: @trait-multi-ref-batch ac-7 - JSON mode with batch refs
  it('should output JSON array with results for each ref in batch mode', () => {
    kspec('task add --title "Dep" --slug batch-json-dep', tempDir);
    kspec('task add --title "Task A" --slug batch-json-a', tempDir);
    kspec('task add --title "Task B" --slug batch-json-b', tempDir);
    kspec('task set @batch-json-a --depends-on @batch-json-dep', tempDir);
    kspec('task set @batch-json-b --depends-on @batch-json-dep', tempDir);

    const result = kspec('task set --refs @batch-json-a @batch-json-b --clear-deps --json', tempDir);
    const parsed = JSON.parse(result.stdout);

    // Verify batch JSON structure
    expect(parsed.success).toBe(true);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.succeeded).toBe(2);
    expect(parsed.results).toHaveLength(2);

    // Verify each result contains task data
    for (const r of parsed.results) {
      expect(r.status).toBe('success');
      expect(r.data.task.depends_on).toEqual([]);
    }
  });
});
