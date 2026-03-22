/**
 * Tests for session checkpoint — git-only checking behavior.
 *
 * AC: @cmd-session-checkpoint ac-git-only
 *
 * Verifies that the checkpoint hook only reports uncommitted git changes
 * and does NOT check task status or todo completeness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  kspec,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  git,
} from '../helpers/cli';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('session checkpoint: git-only checking', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    // Commit fixture files so working tree starts clean
    git('add -A', tempDir);
    git('commit -m "fixtures"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-session-checkpoint ac-git-only
  it('should not report in-progress tasks as issues', () => {
    // Start a task so it becomes in_progress
    kspec('task start @test-task-pending', tempDir);
    // Commit the task state change so working tree is clean
    git('add -A', tempDir);
    git('commit -m "start task"', tempDir);

    // Checkpoint should pass cleanly — no git changes, task status ignored
    const result = kspec('session checkpoint --json', tempDir, {
      expectFail: true,
    });

    // Clean pass: exit 0 with no output (silent on success)
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  // AC: @cmd-session-checkpoint ac-git-only
  it('should not report incomplete todos as issues', () => {
    // Start a task and add an incomplete todo
    kspec('task start @test-task-pending', tempDir);
    kspec('task todo add @test-task-pending "Incomplete item"', tempDir);
    // Commit the changes so working tree is clean
    git('add -A', tempDir);
    git('commit -m "start task with todo"', tempDir);

    // Checkpoint should pass cleanly — todos are not checked
    const result = kspec('session checkpoint --json', tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  // AC: @cmd-session-checkpoint ac-git-only
  it('should report only uncommitted git changes', () => {
    // Start a task (creates in-progress state)
    kspec('task start @test-task-pending', tempDir);
    // Commit task state so only the new file triggers the checkpoint
    git('add -A', tempDir);
    git('commit -m "start task"', tempDir);

    // Create uncommitted file
    fs.writeFileSync(
      path.join(tempDir, 'uncommitted.ts'),
      '// uncommitted work\n',
    );

    const result = kspec('session checkpoint --json', tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      decision: string;
      reason: string;
    };
    expect(output.decision).toBe('block');
    expect(output.reason).toContain('uncommitted changes');
    // Should NOT mention tasks or todos
    expect(output.reason).not.toContain('in progress');
    expect(output.reason).not.toContain('Incomplete todo');
  });

  it('should exit silently when no issues found', () => {
    // Clean working tree, no uncommitted changes
    const result = kspec('session checkpoint --json', tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('should ignore transient plan files when plans/ is gitignored', () => {
    kspec('init --name test-project --no-prompt', tempDir);

    fs.mkdirSync(path.join(tempDir, 'plans'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'plans', 'transient-plan.md'),
      '# Working plan\n',
    );

    const result = kspec('session checkpoint --json', tempDir, {
      expectFail: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });
});
