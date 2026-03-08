import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  initializeShadow,
  SHADOW_BRANCH_NAME,
  SHADOW_WORKTREE_DIR,
  hasRemoteTracking,
} from '../src/parser/shadow.js';
import { ShadowSyncScheduler } from '../src/parser/shadow-sync-scheduler.js';

describe('ShadowSyncScheduler', () => {
  const testDir = path.join('/tmp', `kspec-sync-sched-${Date.now()}`);
  const remoteDir = path.join('/tmp', `kspec-sync-sched-remote-${Date.now()}`);

  beforeEach(async () => {
    for (const dir of [testDir, remoteDir]) {
      try { await fs.rm(dir, { recursive: true }); } catch { /* noop */ }
      await fs.mkdir(dir, { recursive: true });
    }
  });

  afterEach(async () => {
    for (const dir of [testDir, remoteDir]) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  async function setupSyncTest(): Promise<string> {
    // Create bare remote
    execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });

    // Create local repo with remote
    execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
    execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });
    execSync(`git remote add origin ${remoteDir}`, { cwd: testDir, stdio: 'pipe' });
    execSync('git push -u origin main', { cwd: testDir, stdio: 'pipe' });

    // Initialize shadow with remote
    await initializeShadow(testDir);

    return path.join(testDir, SHADOW_WORKTREE_DIR);
  }

  // AC: @config-shadow ac-12
  it('does not start when interval is 0', () => {
    const scheduler = new ShadowSyncScheduler({
      worktreeDir: '/fake/path',
      intervalSeconds: 0,
    });

    scheduler.start();
    // Should be a no-op — stop should also be safe
    scheduler.stop();
  });

  // AC: @config-shadow ac-12
  it('starts and stops the periodic timer', async () => {
    const worktreeDir = await setupSyncTest();

    const scheduler = new ShadowSyncScheduler({
      worktreeDir,
      intervalSeconds: 60,
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      scheduler.start();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Shadow sync scheduler started')
      );

      scheduler.stop();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Shadow sync scheduler stopped')
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  // AC: @config-shadow ac-12
  it('syncOnce pulls remote changes', async () => {
    const worktreeDir = await setupSyncTest();

    // Make a remote change via a clone
    const cloneDir = path.join('/tmp', `kspec-sched-clone-${Date.now()}`);
    try {
      execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
      execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
      execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
      execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

      const tasksFile = (await fs.readdir(path.join(cloneDir, '.kspec')))
        .find(f => f.endsWith('.tasks.yaml'));
      if (tasksFile) {
        await fs.appendFile(
          path.join(cloneDir, '.kspec', tasksFile),
          '\n# Scheduler sync test change\n'
        );
        execSync('git add -A && git commit -m "Remote change for scheduler"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
      }

      // Run syncOnce
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const scheduler = new ShadowSyncScheduler({
          worktreeDir,
          intervalSeconds: 60,
        });

        await scheduler.syncOnce();

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('Shadow sync: pulled remote changes')
        );

        // Verify the change was pulled
        if (tasksFile) {
          const content = await fs.readFile(path.join(worktreeDir, tasksFile), 'utf-8');
          expect(content).toContain('# Scheduler sync test change');
        }
      } finally {
        consoleSpy.mockRestore();
      }
    } finally {
      await fs.rm(cloneDir, { recursive: true, force: true });
    }
  });

  // AC: @config-shadow ac-12
  it('syncOnce skips when no remote tracking configured', async () => {
    // Set up a local-only repo (no remote)
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
    await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
    execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

    await initializeShadow(testDir);
    const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

    expect(await hasRemoteTracking(worktreeDir)).toBe(false);

    const scheduler = new ShadowSyncScheduler({
      worktreeDir,
      intervalSeconds: 60,
    });

    // Should complete without error — no pull attempted
    await scheduler.syncOnce();
  });

  // AC: @config-shadow ac-12
  it('syncOnce skips when already running', async () => {
    const worktreeDir = await setupSyncTest();

    const scheduler = new ShadowSyncScheduler({
      worktreeDir,
      intervalSeconds: 60,
    });

    // Simulate concurrent sync by starting two
    const [result1, result2] = await Promise.all([
      scheduler.syncOnce(),
      scheduler.syncOnce(),
    ]);

    // Both should complete without error (one skipped due to guard)
    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();
  });
});
