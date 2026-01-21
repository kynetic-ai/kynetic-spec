/**
 * Integration tests for kspec task complete state enforcement
 * AC: @spec-completion-enforcement
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspecOutput as kspec,
  kspecJson,
  kspecWithStatus,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Integration: task completion enforcement', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir); // Shadow commands require git repo
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @spec-completion-enforcement ac-1
  it('should complete task successfully when status is pending_review', () => {
    // Start and submit a task
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    // Verify it's in pending_review
    const beforeComplete = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(beforeComplete.status).toBe('pending_review');

    // Complete should succeed
    const output = kspec('task complete @test-task-pending --reason "All tests pass"', tempDir);
    expect(output).toContain('Completed task');

    // Verify it's completed
    const afterComplete = kspecJson<{ status: string; closed_reason: string | null }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterComplete.status).toBe('completed');
    expect(afterComplete.closed_reason).toBe('All tests pass');
  });

  // AC: @spec-completion-enforcement ac-2
  it('should error when trying to complete in_progress task', () => {
    // Start a task (in_progress)
    kspec('task start @test-task-pending', tempDir);

    // Verify it's in_progress
    const taskData = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskData.status).toBe('in_progress');

    // Complete should fail with specific error
    const { stdout, stderr, exitCode } = kspecWithStatus('task complete @test-task-pending --reason "Done"', tempDir);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain('Task must be submitted for review first');
    expect(stdout + stderr).toContain('kspec task submit');
  });

  // AC: @spec-completion-enforcement ac-3
  it('should error when trying to complete pending task', () => {
    // Task starts in pending state
    const taskData = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskData.status).toBe('pending');

    // Complete should fail with specific error
    const { stdout, stderr, exitCode } = kspecWithStatus('task complete @test-task-pending --reason "Done"', tempDir);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain('Task must be started and submitted first');
  });

  // AC: @spec-completion-enforcement ac-4
  it('should error when trying to complete blocked task', () => {
    // Block a task
    kspec('task block @test-task-pending --reason "Waiting for API"', tempDir);

    // Verify it's blocked
    const taskData = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskData.status).toBe('blocked');

    // Complete should fail with specific error
    const { stdout, stderr, exitCode } = kspecWithStatus('task complete @test-task-pending --reason "Done"', tempDir);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain('Cannot complete blocked task');
  });

  // AC: @spec-completion-enforcement ac-5
  it('should error when trying to complete cancelled task', () => {
    // Cancel a task
    kspec('task cancel @test-task-pending --reason "No longer needed"', tempDir);

    // Verify it's cancelled
    const taskData = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskData.status).toBe('cancelled');

    // Complete should fail with specific error and suggest reset
    const { stdout, stderr, exitCode } = kspecWithStatus('task complete @test-task-pending --reason "Done"', tempDir);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain('Cannot complete cancelled task');
    expect(stdout + stderr).toContain('kspec task reset');
  });

  // AC: @spec-completion-enforcement ac-6
  it('should error when trying to complete already completed task', () => {
    // Start, submit, and complete a task
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);
    kspec('task complete @test-task-pending --reason "Done"', tempDir);

    // Verify it's completed
    const taskData = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskData.status).toBe('completed');

    // Complete should fail with specific error
    const { stdout, stderr, exitCode } = kspecWithStatus('task complete @test-task-pending --reason "Done again"', tempDir);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain('Task is already completed');
  });

  // AC: @spec-completion-enforcement ac-7
  it('should allow skip-review to bypass enforcement and document reason', () => {
    // Start a task (in_progress, not submitted)
    kspec('task start @test-task-pending', tempDir);

    const beforeComplete = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(beforeComplete.status).toBe('in_progress');

    // Complete with skip-review should succeed
    const output = kspec('task complete @test-task-pending --skip-review --reason "Hotfix, no review needed"', tempDir);
    expect(output).toContain('Completed task');

    // Verify it's completed and reason is documented
    const afterComplete = kspecJson<{
      status: string;
      closed_reason: string | null;
      notes: Array<{ content: string; author: string }>;
    }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterComplete.status).toBe('completed');
    expect(afterComplete.closed_reason).toBe('Hotfix, no review needed');

    // Check that a note was added documenting the skip-review
    const skipNote = afterComplete.notes.find(n => n.content.includes('skip-review'));
    expect(skipNote).toBeTruthy();
    expect(skipNote?.content).toContain('Hotfix, no review needed');
  });

  // AC: @spec-completion-enforcement ac-8
  it('should error when skip-review provided without reason', () => {
    // Start a task
    kspec('task start @test-task-pending', tempDir);

    // Complete with skip-review but no reason should fail
    const { stdout, stderr, exitCode } = kspecWithStatus('task complete @test-task-pending --skip-review', tempDir);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain('--skip-review requires --reason to document why');
  });

  // AC: @spec-completion-enforcement ac-9
  it('should handle batch mode with mixed states correctly', () => {
    // Prepare first task: pending_review (can complete)
    kspec('task start @test-task-pending', tempDir);
    kspec('task submit @test-task-pending', tempDir);

    // Prepare second task: in_progress (cannot complete)
    kspec('task start @test-task-blocked', tempDir);

    // Verify states
    const task1 = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    const task2 = kspecJson<{ status: string }>(
      'task get @test-task-blocked',
      tempDir
    );
    expect(task1.status).toBe('pending_review');
    expect(task2.status).toBe('in_progress');

    // Batch complete with mixed states
    const { stdout, stderr, exitCode } = kspecWithStatus(
      'task complete --refs @test-task-pending @test-task-blocked --reason "Done"',
      tempDir
    );

    // Should exit with error (at least one failed)
    expect(exitCode).toBe(1);

    // Output should show both success and failure
    const output = stdout + stderr;
    expect(output).toContain('Completed 1 of 2');
    expect(output).toContain('✓'); // Success indicator
    expect(output).toContain('✗'); // Failure indicator

    // First task should be completed
    const task1After = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(task1After.status).toBe('completed');

    // Second task should still be in_progress
    const task2After = kspecJson<{ status: string }>(
      'task get @test-task-blocked',
      tempDir
    );
    expect(task2After.status).toBe('in_progress');

    // Error should provide guidance
    expect(output).toContain('Task must be submitted for review first');
  });

  // Additional test: Verify skip-review works from pending state too
  it('should allow skip-review from pending state', () => {
    // Task starts in pending
    const taskData = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(taskData.status).toBe('pending');

    // Complete with skip-review should succeed
    const output = kspec('task complete @test-task-pending --skip-review --reason "Trivial change"', tempDir);
    expect(output).toContain('Completed task');

    // Verify it's completed
    const afterComplete = kspecJson<{ status: string }>(
      'task get @test-task-pending',
      tempDir
    );
    expect(afterComplete.status).toBe('completed');
  });
});
