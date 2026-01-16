import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  detectShadow,
  getShadowStatus,
  generateCommitMessage,
  isValidWorktree,
  branchExists,
  SHADOW_BRANCH_NAME,
  SHADOW_WORKTREE_DIR,
  ShadowError,
  createShadowError,
  commitIfShadow,
  initializeShadow,
  repairShadow,
} from '../src/parser/shadow.js';
import { initContext } from '../src/parser/yaml.js';

describe('Shadow Branch', () => {
  // Use /tmp to ensure we're outside any git repo for proper isolation
  const testDir = path.join('/tmp', `kspec-shadow-test-${Date.now()}`);

  beforeEach(async () => {
    // Clean up any previous test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Doesn't exist, that's fine
    }
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe('detectShadow', () => {
    it('returns null for non-git directory', async () => {
      const result = await detectShadow(testDir);
      expect(result).toBeNull();
    });

    it('returns null for git repo without .kspec', async () => {
      // Initialize a git repo
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await detectShadow(testDir);
      expect(result).toBeNull();
    });
  });

  describe('getShadowStatus', () => {
    it('reports not a git repo', async () => {
      const status = await getShadowStatus(testDir);
      expect(status.exists).toBe(false);
      expect(status.healthy).toBe(false);
      expect(status.error).toBe('Not a git repository');
    });

    it('reports no shadow branch for fresh git repo', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const status = await getShadowStatus(testDir);
      expect(status.exists).toBe(false);
      expect(status.healthy).toBe(false);
      expect(status.branchExists).toBe(false);
      expect(status.worktreeExists).toBe(false);
    });
  });

  describe('generateCommitMessage', () => {
    it('generates task-start message', () => {
      const msg = generateCommitMessage('task-start', 'my-task');
      expect(msg).toBe('Start @my-task');
    });

    it('generates task-complete message with reason', () => {
      const msg = generateCommitMessage('task-complete', 'my-task', 'Done with implementation');
      expect(msg).toBe('Complete @my-task: Done with implementation');
    });

    it('generates task-note message', () => {
      const msg = generateCommitMessage('task-note', 'my-task');
      expect(msg).toBe('Note on @my-task');
    });

    it('generates task-add message', () => {
      const msg = generateCommitMessage('task-add', undefined, 'New feature');
      expect(msg).toBe('Add task: New feature');
    });

    it('generates inbox-add message with truncation', () => {
      const longText = 'a'.repeat(100);
      const msg = generateCommitMessage('inbox-add', undefined, longText);
      expect(msg).toBe(`Inbox: ${'a'.repeat(50)}...`);
    });

    it('generates inbox-promote message', () => {
      const msg = generateCommitMessage('inbox-promote', 'new-task');
      expect(msg).toBe('Promote to @new-task');
    });

    it('generates derive message', () => {
      const msg = generateCommitMessage('derive', 'spec-item');
      expect(msg).toBe('Derive from @spec-item');
    });

    it('handles unknown operation', () => {
      const msg = generateCommitMessage('custom-op', 'ref');
      expect(msg).toBe('custom-op @ref');
    });
  });

  describe('ShadowError', () => {
    it('creates error with code and suggestion', () => {
      const err = new ShadowError(
        'Test message',
        'NOT_INITIALIZED',
        'Run kspec init'
      );
      expect(err.message).toBe('Test message');
      expect(err.code).toBe('NOT_INITIALIZED');
      expect(err.suggestion).toBe('Run kspec init');
      expect(err.name).toBe('ShadowError');
    });
  });

  describe('createShadowError', () => {
    it('creates NOT_INITIALIZED error when nothing exists', () => {
      const err = createShadowError({
        exists: false,
        healthy: false,
        branchExists: false,
        worktreeExists: false,
        worktreeLinked: false,
      });
      expect(err.code).toBe('NOT_INITIALIZED');
    });

    it('creates DIRECTORY_MISSING error when branch exists but worktree does not', () => {
      const err = createShadowError({
        exists: true,
        healthy: false,
        branchExists: true,
        worktreeExists: false,
        worktreeLinked: false,
      });
      expect(err.code).toBe('DIRECTORY_MISSING');
    });

    it('creates WORKTREE_DISCONNECTED error when worktree exists but not linked', () => {
      const err = createShadowError({
        exists: true,
        healthy: false,
        branchExists: true,
        worktreeExists: true,
        worktreeLinked: false,
      });
      expect(err.code).toBe('WORKTREE_DISCONNECTED');
    });
  });

  describe('commitIfShadow', () => {
    it('returns false when shadow is not enabled', async () => {
      const result = await commitIfShadow(null, 'task-start', 'test');
      expect(result).toBe(false);
    });

    it('returns false when shadow config has enabled: false', async () => {
      const result = await commitIfShadow(
        { enabled: false, worktreeDir: '', branchName: '', projectRoot: '' },
        'task-start',
        'test'
      );
      expect(result).toBe(false);
    });
  });

  describe('initContext with shadow', () => {
    it('returns context without shadow for traditional layout', async () => {
      // Create a traditional spec layout
      const specDir = path.join(testDir, 'spec');
      await fs.mkdir(specDir, { recursive: true });
      await fs.writeFile(
        path.join(specDir, 'kynetic.yaml'),
        'kynetic: "1.0"\nproject:\n  name: Test\n  version: "0.1.0"\n  status: draft\n'
      );

      // Initialize git so detectShadow can check
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const ctx = await initContext(testDir);
      expect(ctx.shadow).toBeNull();
      expect(ctx.specDir).toBe(specDir);
      expect(ctx.manifestPath).toBe(path.join(specDir, 'kynetic.yaml'));
    });
  });

  describe('initializeShadow', () => {
    it('creates shadow branch and worktree in git repo', async () => {
      // Initialize git repo with an initial commit
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir, { projectName: 'Test Project' });

      expect(result.success).toBe(true);
      expect(result.branchCreated).toBe(true);
      expect(result.worktreeCreated).toBe(true);
      expect(result.gitignoreUpdated).toBe(true);

      // Verify branch exists
      expect(await branchExists(testDir, SHADOW_BRANCH_NAME)).toBe(true);

      // Verify worktree exists and is valid
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      expect(await isValidWorktree(worktreeDir)).toBe(true);

      // Verify status is healthy
      const status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);
    });

    it('is idempotent - succeeds if already initialized', async () => {
      // Initialize git repo
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // First init
      const result1 = await initializeShadow(testDir);
      expect(result1.success).toBe(true);
      expect(result1.branchCreated).toBe(true);

      // Second init - should succeed without creating branch again
      const result2 = await initializeShadow(testDir);
      expect(result2.success).toBe(true);
      expect(result2.alreadyExists).toBe(true);
      expect(result2.branchCreated).toBe(false);
    });

    it('fails if not a git repo', async () => {
      const result = await initializeShadow(testDir);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Not a git repository');
    });
  });

  describe('repairShadow', () => {
    // Helper to set up a healthy shadow branch
    async function setupHealthyShadow(): Promise<void> {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });
      await initializeShadow(testDir);
    }

    // AC-recovery-1: Branch exists but .kspec/ deleted → repair recreates
    it('recreates worktree when .kspec/ directory is deleted', async () => {
      await setupHealthyShadow();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Verify healthy before breaking
      let status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);

      // Break: delete the worktree directory
      // First remove from git worktree list to avoid stale reference
      execSync(`git worktree remove ${SHADOW_WORKTREE_DIR} --force`, { cwd: testDir, stdio: 'pipe' });

      // Verify broken
      status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(false);
      expect(status.branchExists).toBe(true);
      expect(status.worktreeExists).toBe(false);

      // Repair
      const result = await repairShadow(testDir);
      expect(result.success).toBe(true);
      expect(result.worktreeCreated).toBe(true);

      // Verify healthy again
      status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);
      expect(await isValidWorktree(worktreeDir)).toBe(true);
    });

    // AC-recovery-2: .kspec/ exists but .git file corrupt → repair recreates
    it('recreates worktree when .git file is corrupted', async () => {
      await setupHealthyShadow();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const gitFile = path.join(worktreeDir, '.git');

      // Verify healthy before breaking
      let status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);

      // Break: corrupt the .git file
      await fs.writeFile(gitFile, 'corrupted content');

      // Verify broken
      status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(false);
      expect(status.worktreeExists).toBe(true);
      expect(status.worktreeLinked).toBe(false);

      // Repair
      const result = await repairShadow(testDir);
      expect(result.success).toBe(true);
      expect(result.worktreeCreated).toBe(true);

      // Verify healthy again
      status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);
    });

    // AC-recovery-3: No shadow branch → repair fails suggesting init
    it('fails with helpful error when shadow branch does not exist', async () => {
      // Just a git repo without shadow branch
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await repairShadow(testDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('kspec init');
    });

    // AC-recovery-4: Healthy → repair succeeds without changes (idempotent)
    it('succeeds without changes when already healthy', async () => {
      await setupHealthyShadow();

      const result = await repairShadow(testDir);
      expect(result.success).toBe(true);
      expect(result.alreadyExists).toBe(true);
      expect(result.worktreeCreated).toBe(false);
    });

    // AC-recovery-5: Healthy → status reports healthy
    it('status reports healthy when shadow is working', async () => {
      await setupHealthyShadow();

      const status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);
      expect(status.branchExists).toBe(true);
      expect(status.worktreeExists).toBe(true);
      expect(status.worktreeLinked).toBe(true);
      expect(status.error).toBeUndefined();
    });

    // AC-recovery-6: Issues → status reports issue and suggests repair
    it('status reports specific issue when worktree is broken', async () => {
      await setupHealthyShadow();

      // Break: remove worktree
      execSync(`git worktree remove ${SHADOW_WORKTREE_DIR} --force`, { cwd: testDir, stdio: 'pipe' });

      const status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(false);
      expect(status.branchExists).toBe(true);
      expect(status.worktreeExists).toBe(false);
      expect(status.error).toContain('worktree missing');
    });
  });
});
