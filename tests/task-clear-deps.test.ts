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
    const after = kspecJson<{ depends_on: string[]; notes: Array<{ content: string }> }>('task get @child-task', tempDir);
    expect(after.depends_on).toHaveLength(0);

    // Verify note was added documenting the change
    const clearNote = after.notes.find(n => n.content.includes('Dependencies cleared'));
    expect(clearNote).toBeDefined();
    expect(clearNote?.content).toContain('@parent-task');
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
});
