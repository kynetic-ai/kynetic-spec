/**
 * Integration tests for command group default actions
 * AC: @command-group-default-actions
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Integration: command group default actions', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @command-group-default-actions ac-bare-tasks
  it('should list tasks when `kspec tasks` is run with no subcommand', () => {
    const bare = kspec('tasks', tempDir);
    const explicit = kspec('tasks list', tempDir);

    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toBe(explicit.stdout);
  });

  // AC: @command-group-default-actions ac-bare-task
  it('should list tasks when `kspec task` is run with no subcommand', () => {
    const bare = kspec('task', tempDir);
    const explicit = kspec('tasks list', tempDir);

    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toBe(explicit.stdout);
  });

  // AC: @command-group-default-actions ac-bare-with-options
  it('should forward options to default list action', () => {
    const bare = kspec('tasks --status pending', tempDir);
    const explicit = kspec('tasks list --status pending', tempDir);

    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toBe(explicit.stdout);
  });

  // AC: @command-group-default-actions ac-bare-with-options (JSON mode)
  it('should support --json on bare tasks command', () => {
    const result = kspec('tasks --json', tempDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  // AC: @command-group-default-actions ac-bare-with-options (count mode)
  it('should support --count on bare tasks command', () => {
    const bareCount = kspec('tasks --count', tempDir);
    expect(bareCount.exitCode).toBe(0);
    // Should output just the count as a number
    expect(Number.parseInt(bareCount.stdout, 10)).toBeGreaterThan(0);
  });

  // AC: @command-group-default-actions ac-help-still-works
  it('should show full command group help with --help', () => {
    const result = kspec('tasks --help', tempDir);
    expect(result.exitCode).toBe(0);
    // Should list subcommands, not just list help
    expect(result.stdout).toContain('Commands:');
    expect(result.stdout).toContain('list');
    expect(result.stdout).toContain('ready');
    expect(result.stdout).toContain('next');
    expect(result.stdout).toContain('blocked');
  });

  // AC: @command-group-default-actions ac-subcommands-unaffected
  it('should run explicit subcommands as before', () => {
    const ready = kspec('tasks ready', tempDir);
    expect(ready.exitCode).toBe(0);

    const next = kspec('tasks next', tempDir);
    expect(next.exitCode).toBe(0);

    const blocked = kspec('tasks blocked', tempDir);
    expect(blocked.exitCode).toBe(0);
  });

  // AC: @command-group-default-actions ac-unknown-subcommand
  it('should show error with suggestion for unknown tasks subcommand', () => {
    const result = kspec('tasks lst', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'tasks lst'");
    expect(result.stderr).toContain('Did you mean: kspec tasks list?');
  });

  // AC: @command-group-default-actions ac-unknown-subcommand
  it('should show error for unknown task subcommand', () => {
    const result = kspec('task gett', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'task gett'");
    expect(result.stderr).toContain('Did you mean: kspec task get?');
  });

  // AC: @command-group-default-actions ac-unknown-subcommand (no close match)
  it('should show generic help for completely unknown subcommand', () => {
    const result = kspec('tasks zzzzzzz', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'tasks zzzzzzz'");
    expect(result.stderr).toContain('--help');
  });

  // Regression: ensure task subcommands with arguments still work
  it('should not interfere with task subcommands that take arguments', () => {
    // task get requires a ref argument
    const result = kspec('task get @test-task-pending', tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test-task-pending');
  });
});
