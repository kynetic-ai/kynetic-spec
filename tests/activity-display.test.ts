import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTempDir, initGitRepo, kspec, kspecJson } from './helpers/cli';

/**
 * Set up a kspec project with shadow branch for activity testing.
 */
async function setupKspecProject(tmpDir: string): Promise<void> {
  initGitRepo(tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n', 'utf-8');
  execSync('git add README.md && git commit -m "initial"', {
    cwd: tmpDir,
    stdio: 'pipe',
  });

  const result = kspec('init --no-prompt --setup', tmpDir, {
    env: { CLAUDECODE: '1', KSPEC_AUTHOR: '@test' },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init failed: ${result.stderr}`);
  }
}

// AC: @task-activity-timeline ac-1
describe('task get — ac-1: shows recent activity by default', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('activity-display-');
    await setupKspecProject(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('shows activity section after creating and starting a task', () => {
    kspec(
      'task add --title "Test task" --slug task-test-activity',
      tmpDir,
      { env: { KSPEC_AUTHOR: '@test' } },
    );
    kspec('task start @task-test-activity', tmpDir, {
      env: { KSPEC_AUTHOR: '@test' },
    });

    const result = kspec('task get @task-test-activity', tmpDir);
    expect(result.stdout).toContain('Activity');
    // Should contain state change from pending → in_progress
    expect(result.stdout).toMatch(/Status:.*pending.*in_progress|started/i);
  });

  it('caps default display to 10 entries', () => {
    kspec(
      'task add --title "Noted task" --slug task-many-notes',
      tmpDir,
      { env: { KSPEC_AUTHOR: '@test' } },
    );
    // Add many notes to generate commits
    for (let i = 0; i < 12; i++) {
      kspec(`task note @task-many-notes "Note number ${i}"`, tmpDir, {
        env: { KSPEC_AUTHOR: '@test' },
      });
    }

    const result = kspec('task get @task-many-notes', tmpDir);
    // Should mention hidden entries
    expect(result.stdout).toMatch(/older entr.*hidden.*--activity/);
  });
});

// AC: @task-activity-timeline ac-2
describe('task get --activity — ac-2: shows full timeline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('activity-full-');
    await setupKspecProject(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('shows all entries with --activity flag', () => {
    kspec(
      'task add --title "Full timeline" --slug task-full-timeline',
      tmpDir,
      { env: { KSPEC_AUTHOR: '@test' } },
    );
    for (let i = 0; i < 12; i++) {
      kspec(`task note @task-full-timeline "Note ${i}"`, tmpDir, {
        env: { KSPEC_AUTHOR: '@test' },
      });
    }

    const result = kspec('task get @task-full-timeline --activity', tmpDir);
    // Should NOT mention hidden entries when --activity is used
    expect(result.stdout).not.toMatch(/older entr.*hidden/);
  });
});

// AC: @task-activity-timeline ac-4
describe('task get --json — ac-4: structured activity in JSON output', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('activity-json-');
    await setupKspecProject(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('includes activity array with typed entries in JSON', () => {
    kspec(
      'task add --title "JSON task" --slug task-json-activity',
      tmpDir,
      { env: { KSPEC_AUTHOR: '@test' } },
    );
    kspec('task start @task-json-activity', tmpDir, {
      env: { KSPEC_AUTHOR: '@test' },
    });

    const output = kspecJson<{
      activity?: Array<{
        type: string;
        timestamp: string;
        author: string;
        summary: string;
      }>;
    }>('task get @task-json-activity', tmpDir);

    expect(output.activity).toBeDefined();
    expect(output.activity!.length).toBeGreaterThan(0);

    // Each entry has required fields
    for (const entry of output.activity!) {
      expect(entry.type).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.author).toBeTruthy();
      expect(entry.summary).toBeTruthy();
    }

    // Should have a state_change entry for start
    const stateChanges = output.activity!.filter(
      (e) => e.type === 'state_change',
    );
    expect(stateChanges.length).toBeGreaterThan(0);
  });

  // AC: @trait-json-output ac-5 — timestamps use ISO 8601
  it('uses ISO 8601 timestamps in activity entries', () => {
    kspec(
      'task add --title "ISO timestamps" --slug task-iso-ts',
      tmpDir,
      { env: { KSPEC_AUTHOR: '@test' } },
    );

    const output = kspecJson<{
      activity?: Array<{ timestamp: string }>;
    }>('task get @task-iso-ts', tmpDir);

    expect(output.activity).toBeDefined();
    for (const entry of output.activity!) {
      // ISO 8601 format: YYYY-MM-DDTHH:MM:SS with timezone
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });
});

// AC: @trait-json-output ac-1 — N/A: task get already tests JSON output validity elsewhere
// AC: @trait-json-output ac-2 — covered by ac-4 test above (activity included in JSON)
// AC: @trait-json-output ac-3 — N/A: error JSON handled by existing task get error path
// AC: @trait-json-output ac-4 — N/A: no new refs introduced in activity output
// AC: @trait-json-output ac-6 — N/A: --activity is not a formatting flag that conflicts with --json
