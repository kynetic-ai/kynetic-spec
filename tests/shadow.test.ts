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
});
