import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTempFixtures, cleanupTempDir, kspec, kspecJson } from './helpers/cli';

describe('Integration: task set batch support', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @spec-task-set-batch ac-1
  it('should update all tasks when multiple refs provided', () => {
    // Create multiple tasks
    kspec('task add --title "Task A" --slug batch-a --priority 3', tempDir);
    kspec('task add --title "Task B" --slug batch-b --priority 3', tempDir);
    kspec('task add --title "Task C" --slug batch-c --priority 3', tempDir);

    // Update all with same priority
    const result = kspec('task set --refs @batch-a @batch-b @batch-c --priority 1', tempDir);
    expect(result.stdout).toContain('Setd 3 of 3');

    // Verify all tasks updated
    const taskA = kspecJson<{ priority: number }>('task get @batch-a', tempDir);
    const taskB = kspecJson<{ priority: number }>('task get @batch-b', tempDir);
    const taskC = kspecJson<{ priority: number }>('task get @batch-c', tempDir);

    expect(taskA.priority).toBe(1);
    expect(taskB.priority).toBe(1);
    expect(taskC.priority).toBe(1);
  });

  // AC: @spec-task-set-batch ac-2
  it('should update multiple fields at once', () => {
    kspec('task add --title "Task D" --slug batch-d --priority 5', tempDir);
    kspec('task add --title "Task E" --slug batch-e --priority 5', tempDir);

    const result = kspec('task set --refs @batch-d @batch-e --priority 2 --tag urgent', tempDir);
    expect(result.stdout).toContain('Setd 2 of 2');

    const taskD = kspecJson<{ priority: number; tags: string[] }>('task get @batch-d', tempDir);
    const taskE = kspecJson<{ priority: number; tags: string[] }>('task get @batch-e', tempDir);

    expect(taskD.priority).toBe(2);
    expect(taskD.tags).toContain('urgent');
    expect(taskE.priority).toBe(2);
    expect(taskE.tags).toContain('urgent');
  });

  // AC: @spec-task-set-batch ac-3
  it('should reject --status flag with error message', () => {
    kspec('task add --title "Status Test" --slug status-test', tempDir);

    const result = kspec('task set --refs @status-test --status completed', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain('Use state transition commands');
    expect(result.stderr).toContain('start, complete, block');
  });

  // AC: @spec-task-set-batch ac-4
  it('should warn when no changes specified', () => {
    kspec('task add --title "No Changes" --slug no-changes', tempDir);

    const result = kspec('task set --refs @no-changes', tempDir);
    expect(result.stdout).toContain('No changes specified');
  });

  // AC: @spec-task-set-batch ac-5
  it('should handle partial validation failure', () => {
    kspec('task add --title "Valid Task" --slug valid-task', tempDir);
    kspec('task add --title "Invalid Task" --slug invalid-task', tempDir);

    // Try to set spec-ref where one ref is invalid (doesn't exist)
    const result = kspec('task set --refs @valid-task @invalid-task --spec-ref @nonexistent-spec', tempDir, { expectFail: true });

    // Both should fail because the spec ref doesn't exist
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Setd 0 of 2');
  });

  // AC: @trait-multi-ref-batch ac-1
  it('should operate on all provided references in batch mode', () => {
    kspec('task add --title "Batch 1" --slug b1', tempDir);
    kspec('task add --title "Batch 2" --slug b2', tempDir);
    kspec('task add --title "Batch 3" --slug b3', tempDir);

    const result = kspec('task set --refs @b1 @b2 @b3 --tag batch-test', tempDir);
    expect(result.stdout).toContain('Setd 3 of 3');

    const task1 = kspecJson<{ tags: string[] }>('task get @b1', tempDir);
    const task2 = kspecJson<{ tags: string[] }>('task get @b2', tempDir);
    const task3 = kspecJson<{ tags: string[] }>('task get @b3', tempDir);

    expect(task1.tags).toContain('batch-test');
    expect(task2.tags).toContain('batch-test');
    expect(task3.tags).toContain('batch-test');
  });

  // AC: @trait-multi-ref-batch ac-2
  it('should continue processing after errors', () => {
    kspec('task add --title "Good Task" --slug good-task', tempDir);
    kspec('task add --title "Another Good Task" --slug another-good', tempDir);

    // Try to update with one invalid ref in the middle
    const result = kspec('task set --refs @good-task @nonexistent @another-good --priority 1', tempDir, { expectFail: true });

    // Should process all refs even though one fails
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Setd 2 of 3');

    // Verify the valid tasks were updated
    const task1 = kspecJson<{ priority: number }>('task get @good-task', tempDir);
    const task2 = kspecJson<{ priority: number }>('task get @another-good', tempDir);

    expect(task1.priority).toBe(1);
    expect(task2.priority).toBe(1);
  });

  // AC: @trait-multi-ref-batch ac-3
  it('should return exit code 0 when all refs succeed', () => {
    kspec('task add --title "Success 1" --slug success-1', tempDir);
    kspec('task add --title "Success 2" --slug success-2', tempDir);

    // This should succeed without errors
    const result = kspec('task set --refs @success-1 @success-2 --priority 2', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Setd 2 of 2');
  });

  // AC: @trait-multi-ref-batch ac-4
  it('should return exit code 1 when any refs fail', () => {
    kspec('task add --title "Will Succeed" --slug will-succeed', tempDir);

    // Mix valid and invalid refs
    const result = kspec('task set --refs @will-succeed @will-fail --priority 1', tempDir, { expectFail: true });

    // Should show partial failure
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Setd 1 of 2');
  });

  // AC: @trait-multi-ref-batch ac-5
  it('should report success and failure counts', () => {
    kspec('task add --title "Count Test 1" --slug count-1', tempDir);
    kspec('task add --title "Count Test 2" --slug count-2', tempDir);
    kspec('task add --title "Count Test 3" --slug count-3', tempDir);

    const result = kspec('task set --refs @count-1 @count-2 @count-3 @nonexistent --priority 3', tempDir, { expectFail: true });

    // Should show 3 of 4 succeeded (3 valid, 1 invalid)
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Setd 3 of 4');
  });

  // AC: @trait-multi-ref-batch ac-6
  it('should error when both positional ref and --refs provided', () => {
    kspec('task add --title "Mutual Test" --slug mutual-test', tempDir);

    const result = kspec('task set @mutual-test --refs @mutual-test --priority 1', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain('Cannot use both positional ref and --refs flag');
  });

  // AC: @trait-multi-ref-batch ac-7
  it('should output JSON array with result for each ref', () => {
    kspec('task add --title "JSON Batch 1" --slug json-b1', tempDir);
    kspec('task add --title "JSON Batch 2" --slug json-b2', tempDir);

    const result = kspecJson<{
      success: boolean;
      summary: { total: number; succeeded: number; failed: number };
      results: Array<{ ref: string; status: string }>;
    }>('task set --refs @json-b1 @json-b2 --priority 4 --json', tempDir);

    expect(result.summary.total).toBe(2);
    expect(result.summary.succeeded).toBe(2);
    expect(result.summary.failed).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe('success');
    expect(result.results[1].status).toBe('success');
  });

  // AC: @trait-multi-ref-batch ac-8
  it('should process each ref once when duplicates provided', () => {
    kspec('task add --title "Dup Test" --slug dup-test --priority 5', tempDir);

    // Provide same ref multiple times
    const result = kspec('task set --refs @dup-test @dup-test --priority 2', tempDir);

    // For single item, batch formatter uses single-item format
    // Just verify the task was updated (processed once)
    const task = kspecJson<{ priority: number }>('task get @dup-test', tempDir);
    expect(task.priority).toBe(2);
    expect(result.stdout).toContain('Updated task');
  });

  // Additional test: single ref mode still works
  it('should work in single ref mode (backward compatibility)', () => {
    kspec('task add --title "Single Mode" --slug single-mode --priority 5', tempDir);

    const result = kspec('task set @single-mode --priority 3', tempDir);
    expect(result.stdout).toContain('Updated task');

    const task = kspecJson<{ priority: number }>('task get @single-mode', tempDir);
    expect(task.priority).toBe(3);
  });

  // Additional test: error when neither positional nor --refs provided
  it('should error when neither positional ref nor --refs provided', () => {
    const result = kspec('task set --priority 1', tempDir, { expectFail: true });

    expect(result.exitCode).toBe(2); // USAGE_ERROR
    expect(result.stderr).toContain('Either provide a positional ref or use --refs flag');
  });
});
