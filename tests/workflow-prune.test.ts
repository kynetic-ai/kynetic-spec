import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setupTempFixtures,
  cleanupTempDir,
  kspecOutput as kspec,
  kspecJson,
} from './helpers/cli';

describe('Integration: workflow prune', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @workflow-prune ac-1
  it('should delete runs older than specified duration', () => {
    // Create some workflow runs with different ages
    // Start 3 runs (they'll all have recent timestamps)
    kspec('workflow start @task-start', tempDir);
    kspec('workflow start @task-start', tempDir);
    kspec('workflow start @task-start', tempDir);

    // Check dry-run first
    const dryRun = kspec(
      'workflow prune --older-than 1d --dry-run',
      tempDir
    );
    expect(dryRun).toContain('Would delete 0'); // All recent

    // Try with 0 minutes (should match all)
    const dryRun2 = kspec(
      'workflow prune --older-than 0m --dry-run',
      tempDir
    );
    expect(dryRun2).toContain('Would delete');

    // Actually delete
    const output = kspec('workflow prune --older-than 0m', tempDir);
    expect(output).toContain('Deleted');

    // Verify they're gone
    const runs = kspecJson<{ runs: unknown[] }>(
      'workflow runs --json',
      tempDir
    );
    expect(runs.runs).toHaveLength(0);
  });

  // AC: @workflow-prune ac-2
  it('should delete runs with specific status', () => {
    // Create runs and abort some
    const run1 = kspecJson<{ run_id: string }>(
      'workflow start @task-start --json',
      tempDir
    );
    const run2 = kspecJson<{ run_id: string }>(
      'workflow start @task-start --json',
      tempDir
    );
    const run3 = kspecJson<{ run_id: string }>(
      'workflow start @task-start --json',
      tempDir
    );

    // Abort run1 and run2
    kspec(`workflow abort @${run1.run_id}`, tempDir);
    kspec(`workflow abort @${run2.run_id}`, tempDir);

    // Dry run - should show 2 aborted runs
    const dryRun = kspec(
      'workflow prune --status aborted --dry-run',
      tempDir
    );
    expect(dryRun).toContain('Would delete 2');

    // Actually delete aborted runs
    const output = kspec('workflow prune --status aborted', tempDir);
    expect(output).toContain('Deleted 2');

    // Verify only the active run remains
    const runs = kspecJson<{ runs: { _ulid: string; status: string }[] }>(
      'workflow runs --json',
      tempDir
    );
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]._ulid).toBe(run3.run_id);
    expect(runs.runs[0].status).toBe('active');
  });

  // AC: @workflow-prune ac-3
  it('should identify abandoned active runs', () => {
    // This test can't easily simulate 7 days of inactivity,
    // but we can test the flag is accepted and doesn't error
    kspec('workflow start @task-start', tempDir);

    const dryRun = kspec(
      'workflow prune --abandoned --dry-run',
      tempDir
    );
    // Should show 0 because runs are fresh
    expect(dryRun).toContain('Would delete 0');
  });

  // AC: @workflow-prune ac-4
  it('should show what would be deleted with --dry-run', () => {
    // Create some runs
    kspec('workflow start @task-start', tempDir);
    kspec('workflow start @task-start', tempDir);

    // Dry run should not delete
    const dryRun = kspec(
      'workflow prune --older-than 0m --dry-run',
      tempDir
    );
    expect(dryRun).toContain('Would delete 2');
    expect(dryRun).toContain('Run without --dry-run');

    // Verify runs still exist
    const runs = kspecJson<{ runs: unknown[] }>(
      'workflow runs --json',
      tempDir
    );
    expect(runs.runs).toHaveLength(2);

    // Now actually delete
    kspec('workflow prune --older-than 0m', tempDir);

    // Verify runs are gone
    const runsAfter = kspecJson<{ runs: unknown[] }>(
      'workflow runs --json',
      tempDir
    );
    expect(runsAfter.runs).toHaveLength(0);
  });

  it('should combine multiple filters', () => {
    // Create runs with different statuses
    const run1 = kspecJson<{ run_id: string }>(
      'workflow start @task-start --json',
      tempDir
    );
    const run2 = kspecJson<{ run_id: string }>(
      'workflow start @task-start --json',
      tempDir
    );

    // Abort one
    kspec(`workflow abort @${run1.run_id}`, tempDir);

    // Prune: old + aborted (should match run1 only)
    const output = kspec(
      'workflow prune --older-than 0m --status aborted',
      tempDir
    );
    expect(output).toContain('Deleted 1');

    // Verify run2 still exists
    const runs = kspecJson<{ runs: { _ulid: string }[] }>(
      'workflow runs --json',
      tempDir
    );
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]._ulid).toBe(run2.run_id);
  });

  it('should error if no filter specified', () => {
    expect(() => {
      kspec('workflow prune', tempDir);
    }).toThrow(/Must specify at least one filter/);
  });

  it('should handle no matches gracefully', () => {
    // No runs exist
    const output = kspec('workflow prune --older-than 1d', tempDir);
    expect(output).toContain('No runs match');
  });

  it('should validate duration format', () => {
    expect(() => {
      kspec('workflow prune --older-than invalid', tempDir);
    }).toThrow(/Invalid duration format/);
  });

  it('should validate status values', () => {
    expect(() => {
      kspec('workflow prune --status invalid', tempDir);
    }).toThrow(/Invalid status/);
  });
});
