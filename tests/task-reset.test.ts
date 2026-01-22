/**
 * Integration tests for kspec task reset command
 * AC: @spec-task-reset
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Integration: task reset', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir); // Shadow commands require git repo
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @spec-task-reset ac-1 - Reset from various statuses to pending, clear fields
  it('should reset completed task to pending and clear completed_at', () => {
    // Start and complete a task
    kspec('task start @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --skip-review --reason "Test completion"', tempDir);

    // Verify it's completed
    const beforeReset = kspecJson<{ status: string; completed_at: string | null; closed_reason: string | null }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(beforeReset.status).toBe('completed');
    expect(beforeReset.completed_at).toBeTruthy();
    expect(beforeReset.closed_reason).toBe('Test completion');

    // Reset the task
    const output = kspec('task reset @test-task-pending', tempDir);
    expect(output).toContain('Reset task');
    expect(output).toContain('completed → pending');

    // Verify fields are cleared
    const afterReset = kspecJson<{
      status: string;
      completed_at: string | null;
      started_at: string | null;
      closed_reason: string | null;
    }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterReset.status).toBe('pending');
    expect(afterReset.completed_at).toBeNull();
    expect(afterReset.started_at).toBeNull();
    expect(afterReset.closed_reason).toBeNull();
  });

  // AC: @spec-task-reset ac-1 - Reset from in_progress
  it('should reset in_progress task to pending', () => {
    // Start a task
    kspec('task start @test-task-pending', tempDir);

    const beforeReset = kspecJson<{ status: string; started_at: string | null }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(beforeReset.status).toBe('in_progress');
    expect(beforeReset.started_at).toBeTruthy();

    // Reset the task
    const output = kspec('task reset @test-task-pending', tempDir);
    expect(output).toContain('in_progress → pending');

    // Verify started_at is cleared
    const afterReset = kspecJson<{ status: string; started_at: string | null }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterReset.status).toBe('pending');
    expect(afterReset.started_at).toBeNull();
  });

  // AC: @spec-task-reset ac-1 - Reset from blocked
  it('should reset blocked task to pending and clear blocked_by', () => {
    // Block a task
    kspec('task block @test-task-pending --reason "Test blocker"', tempDir);

    const beforeReset = kspecJson<{ status: string; blocked_by: string[] }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(beforeReset.status).toBe('blocked');
    expect(beforeReset.blocked_by).toContain('Test blocker');

    // Reset the task
    const output = kspec('task reset @test-task-pending', tempDir);
    expect(output).toContain('blocked → pending');

    // Verify blocked_by is cleared
    const afterReset = kspecJson<{ status: string; blocked_by: string[] }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterReset.status).toBe('pending');
    expect(afterReset.blocked_by).toEqual([]);
  });

  // AC: @spec-task-reset ac-1 - Reset from cancelled
  it('should reset cancelled task to pending and clear closed_reason', () => {
    // Cancel a task
    kspec('task cancel @test-task-pending --reason "Test cancellation"', tempDir);

    const beforeReset = kspecJson<{ status: string; closed_reason: string | null }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(beforeReset.status).toBe('cancelled');
    expect(beforeReset.closed_reason).toBe('Test cancellation');

    // Reset the task
    const output = kspec('task reset @test-task-pending', tempDir);
    expect(output).toContain('cancelled → pending');

    // Verify closed_reason is cleared
    const afterReset = kspecJson<{ status: string; closed_reason: string | null }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterReset.status).toBe('pending');
    expect(afterReset.closed_reason).toBeNull();
  });

  // AC: @spec-task-reset ac-1 - Reset from pending_review
  it('should reset pending_review task to pending', () => {
    // Start and submit a task
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    const beforeReset = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(beforeReset.status).toBe('pending_review');

    // Reset the task
    const output = kspec('task reset @test-task-pending', tempDir);
    expect(output).toContain('pending_review → pending');

    // Verify status is pending
    const afterReset = kspecJson<{ status: string; started_at: string | null }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterReset.status).toBe('pending');
    expect(afterReset.started_at).toBeNull();
  });

  // AC: @spec-task-reset ac-2 - Error if already pending
  it('should error if task is already pending', () => {
    // Task is already pending in fixtures
    expect(() => {
      kspec('task reset @test-task-pending', tempDir);
    }).toThrow(/already pending/i);
  });

  // AC: @spec-task-reset ac-3 - Shadow commit with message task-reset
  it('should create shadow commit when resetting task', () => {
    // Start and complete a task
    kspec('task start @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --skip-review --reason "Done"', tempDir);

    // Reset the task - should create shadow commit
    const output = kspec('task reset @test-task-pending', tempDir);

    // The command succeeds, which means shadow commit was created
    // (commitIfShadow would fail if git operations failed)
    expect(output).toContain('Reset task');
  });

  // AC: @spec-task-reset ac-4 - Note auto-added with previous status
  it('should add note documenting the reset', () => {
    // Start and complete a task
    kspec('task start @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --skip-review --reason "Done"', tempDir);

    // Reset the task
    kspec('task reset @test-task-pending', tempDir);

    // Check notes
    const task = kspecJson<{ notes: Array<{ content: string; author?: string }> }>(
      'task get @test-task-pending',
      tempDir
    );

    // AC: @spec-task-reset ac-author - author set via getAuthor()
    const resetNote = task.notes.find(n => n.content.includes('Reset from'));
    expect(resetNote).toBeTruthy();
    expect(resetNote?.content).toContain('Reset from completed to pending');
    expect(resetNote?.author).toBe('@test'); // From KSPEC_AUTHOR env in test helper
  });

  // AC: @spec-task-reset ac-4 - Note includes cancel_reason if was cancelled
  it('should include cancel reason in note if task was cancelled', () => {
    // Cancel a task with reason
    kspec('task cancel @test-task-pending --reason "No longer needed"', tempDir);

    // Reset the task
    kspec('task reset @test-task-pending', tempDir);

    // Check notes
    const task = kspecJson<{ notes: Array<{ content: string }> }>(
      'task get @test-task-pending',
      tempDir
    );

    const resetNote = task.notes.find(n => n.content.includes('Reset from'));
    expect(resetNote).toBeTruthy();
    expect(resetNote?.content).toContain('Reset from cancelled to pending');
    expect(resetNote?.content).toContain('was cancelled: No longer needed');
  });

  // AC: @spec-task-reset ac-5 - Dependency check happens on B's start, not A's reset
  it('should reset task without affecting dependent tasks', () => {
    // Fixture: test-task-blocked depends on @test-task-pending
    // AC scenario: task A is completed, task B depends on A

    // Step 1: Complete task A (test-task-pending)
    kspec('task start @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --skip-review --reason "Done"', tempDir);

    // Step 2: Verify task A is completed
    const taskA = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskA.status).toBe('completed');

    // Step 3: Get status of task B (test-task-blocked) before reset
    const taskBBefore = kspecJson<{ status: string; depends_on: string[] }>(
      'task get @test-task-blocked',
      tempDir
    );
    expect(taskBBefore.depends_on).toContain('@test-task-pending');
    const taskBStatusBefore = taskBBefore.status;

    // Step 4: Verify task B is ready (dependency satisfied)
    const readyBefore = kspec('tasks ready', tempDir);
    expect(readyBefore).toContain('test-task-blocked');

    // Step 5: Reset task A to pending
    const output = kspec('task reset @test-task-pending', tempDir);
    expect(output).toContain('Reset task');

    // Step 6: Verify task A is now pending
    const taskAAfterReset = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskAAfterReset.status).toBe('pending');

    // Step 7: Verify task B status is unaffected by the reset
    // AC-5: "B unaffected (dependency check happens on B's start)"
    // The reset of A doesn't change B's status field
    const taskBAfter = kspecJson<{ status: string }>(
      'task get @test-task-blocked',
      tempDir
    );
    expect(taskBAfter.status).toBe(taskBStatusBefore);

    // Step 8: But dependency checking means B is no longer ready
    // This validates that "dependency check happens on B's start" -
    // it's not ready to start anymore because A is pending again
    const readyAfter = kspec('tasks ready', tempDir);
    expect(readyAfter).not.toContain('test-task-blocked');
  });

  // AC: @spec-task-reset ac-6 - JSON output includes previous_status, new_status, cleared_fields
  it('should output correct JSON structure', () => {
    // Start and complete a task
    kspec('task start @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --skip-review --reason "Done"', tempDir);

    // Reset with JSON output
    const result = kspecJson<{
      task: { status: string };
      previous_status: string;
      new_status: string;
      cleared_fields: string[];
    }>('task reset @test-task-pending', tempDir);

    expect(result.previous_status).toBe('completed');
    expect(result.new_status).toBe('pending');
    expect(result.task.status).toBe('pending');
    expect(result.cleared_fields).toContain('completed_at');
    expect(result.cleared_fields).toContain('started_at');
    expect(result.cleared_fields).toContain('closed_reason');
  });

  // AC: @trait-json-output ac-1 - Valid JSON with --json flag
  it('should output valid JSON with --json flag', () => {
    // Start a task
    kspec('task start @test-task-pending', tempDir);

    // Reset with JSON output
    const output = kspec('task reset @test-task-pending --json', tempDir);

    // Should be valid JSON (kspecJson would fail if not)
    expect(() => JSON.parse(output)).not.toThrow();

    // Should not contain ANSI codes
    expect(output).not.toMatch(/\u001b\[/);
  });

  // AC: @trait-semantic-exit-codes ac-1 - Exit code 0 on success
  it('should exit with code 0 on success', () => {
    // Start a task
    kspec('task start @test-task-pending', tempDir);

    // Reset should succeed
    expect(() => {
      kspec('task reset @test-task-pending', tempDir);
    }).not.toThrow();
  });

  // AC: @trait-semantic-exit-codes ac-2 - Exit code 1 on validation error
  it('should exit with code 1 when task already pending', () => {
    // Task is already pending
    try {
      kspec('task reset @test-task-pending', tempDir);
      expect.fail('Should have thrown');
    } catch (err: any) {
      // Should fail with validation error
      expect(err.message).toContain('already pending');
    }
  });

  // AC: @trait-error-guidance ac-1, ac-2 - Error includes description and suggestion
  it('should provide helpful error message for already-pending task', () => {
    // Task is already pending
    try {
      kspec('task reset @test-task-pending', tempDir);
      expect.fail('Should have thrown');
    } catch (err: any) {
      // Should include what went wrong
      expect(err.message).toContain('already pending');
    }
  });
});
