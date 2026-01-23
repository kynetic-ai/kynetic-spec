import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  detectShadow,
  detectRunningFromShadowWorktree,
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
  hasRemote,
  remoteBranchExists,
  fetchRemote,
  hasRemoteTracking,
  ensureRemoteTracking,
  shadowPull,
  shadowSync,
  isDebugMode,
  setVerboseModeGetter,
  shadowAutoCommit,
} from '../src/parser/shadow.js';
import { initContext } from '../src/parser/yaml.js';
import { kspec as kspecRun } from './helpers/cli.js';

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

    // AC: @yaml-merge-driver ac-12
    it('configures merge driver during initialization when kspec is in PATH', async () => {
      // Initialize git repo with an initial commit
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Check if kspec is in PATH (it won't be in CI test runs)
      let kspecAvailable = false;
      try {
        execSync('which kspec', { stdio: 'pipe' });
        kspecAvailable = true;
      } catch {
        // kspec not in PATH - skip this test
      }

      if (!kspecAvailable) {
        console.log('  ⊘ Skipping merge driver config test (kspec not in PATH)');
        return;
      }

      const result = await initializeShadow(testDir, { projectName: 'Test Project' });

      expect(result.success).toBe(true);

      // Verify merge driver is configured in .git/config
      const mergeDriverName = execSync('git config merge.kspec.name', {
        cwd: testDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      expect(mergeDriverName).toBe('Kspec YAML semantic merge driver');

      const mergeDriverCmd = execSync('git config merge.kspec.driver', {
        cwd: testDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      expect(mergeDriverCmd).toContain('kspec merge-driver');
      expect(mergeDriverCmd).toContain('--non-interactive');

      // Verify .gitattributes exists in shadow branch
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const gitattributesPath = path.join(worktreeDir, '.gitattributes');
      const gitattributesContent = await fs.readFile(gitattributesPath, 'utf-8');
      expect(gitattributesContent).toContain('*.yaml merge=kspec');
      expect(gitattributesContent).toContain('*.yml merge=kspec');
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

    // AC: @shadow-recovery ac-recovery-1 - Branch exists but .kspec/ deleted → repair recreates
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

    // AC: @shadow-recovery ac-recovery-2 - .kspec/ exists but .git file corrupt → repair recreates
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

    // AC: @shadow-recovery ac-recovery-3 - No shadow branch → repair fails suggesting init
    it('fails with helpful error when shadow branch does not exist', async () => {
      // Just a git repo without shadow branch
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await repairShadow(testDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('kspec init');
    });

    // AC: @shadow-recovery ac-recovery-4 - Healthy → repair succeeds without changes (idempotent)
    it('succeeds without changes when already healthy', async () => {
      await setupHealthyShadow();

      const result = await repairShadow(testDir);
      expect(result.success).toBe(true);
      expect(result.alreadyExists).toBe(true);
      expect(result.worktreeCreated).toBe(false);
    });

    // AC: @shadow-recovery ac-recovery-5 - Healthy → status reports healthy
    it('status reports healthy when shadow is working', async () => {
      await setupHealthyShadow();

      const status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);
      expect(status.branchExists).toBe(true);
      expect(status.worktreeExists).toBe(true);
      expect(status.worktreeLinked).toBe(true);
      expect(status.error).toBeUndefined();
    });

    // AC: @shadow-recovery ac-recovery-6 - Issues → status reports issue and suggests repair
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

  // AC: @shadow-init-remote - Remote detection tests
  describe('initializeShadow with remote', () => {
    // Create a bare repo to act as a "remote"
    const remoteDir = path.join('/tmp', `kspec-remote-test-${Date.now()}`);

    beforeEach(async () => {
      // Clean up remote directory
      try {
        await fs.rm(remoteDir, { recursive: true });
      } catch {
        // Doesn't exist
      }
    });

    afterEach(async () => {
      try {
        await fs.rm(remoteDir, { recursive: true });
      } catch {
        // Best effort cleanup
      }
    });

    // Helper to set up a bare repo as remote
    async function setupBareRemote(): Promise<void> {
      await fs.mkdir(remoteDir, { recursive: true });
      execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });
    }

    // Helper to set up a local repo with remote
    async function setupLocalWithRemote(): Promise<void> {
      execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });
      execSync(`git remote add origin ${remoteDir}`, { cwd: testDir, stdio: 'pipe' });
      execSync('git push -u origin main', { cwd: testDir, stdio: 'pipe' });
    }

    // Helper to push shadow branch to remote
    async function pushShadowToRemote(): Promise<void> {
      execSync(`git -C ${testDir}/.kspec push -u origin ${SHADOW_BRANCH_NAME}`, { stdio: 'pipe' });
    }

    it('hasRemote returns false when no remote configured', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      expect(await hasRemote(testDir)).toBe(false);
    });

    it('hasRemote returns true when origin exists', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();
      expect(await hasRemote(testDir)).toBe(true);
    });

    it('remoteBranchExists returns false when branch not on remote', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();
      expect(await remoteBranchExists(testDir, SHADOW_BRANCH_NAME)).toBe(false);
    });

    it('remoteBranchExists returns true after pushing shadow branch', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();

      // Initialize shadow locally
      await initializeShadow(testDir);

      // Push to remote
      await pushShadowToRemote();

      // Now check - need to fetch first
      await fetchRemote(testDir);
      expect(await remoteBranchExists(testDir, SHADOW_BRANCH_NAME)).toBe(true);
    });

    // AC: @shadow-init-remote ac-1 - Remote has shadow branch → creates worktree from it with tracking
    it('attaches to existing remote shadow branch', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();

      // Initialize shadow in first repo and push
      const result1 = await initializeShadow(testDir);
      expect(result1.success).toBe(true);
      expect(result1.branchCreated).toBe(true);

      // Push shadow to remote
      await pushShadowToRemote();

      // Create a "clone" (new repo pointing to same remote)
      const cloneDir = path.join('/tmp', `kspec-clone-test-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });

        // Initialize shadow in clone - should attach to remote branch
        const result2 = await initializeShadow(cloneDir);
        expect(result2.success).toBe(true);
        expect(result2.createdFromRemote).toBe(true);
        expect(result2.branchCreated).toBe(false);
        expect(result2.worktreeCreated).toBe(true);

        // Verify worktree is healthy
        const status = await getShadowStatus(cloneDir);
        expect(status.healthy).toBe(true);

        // Verify tracking is set up
        const tracking = execSync(`git -C ${cloneDir} config branch.${SHADOW_BRANCH_NAME}.remote`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        expect(tracking).toBe('origin');
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @shadow-init-remote ac-2 - Remote exists but no shadow branch → creates orphan and pushes
    it('creates orphan branch and pushes to remote', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();

      // Verify no shadow branch on remote yet
      expect(await remoteBranchExists(testDir, SHADOW_BRANCH_NAME)).toBe(false);

      // Initialize shadow - should create and push
      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);
      expect(result.branchCreated).toBe(true);
      expect(result.pushedToRemote).toBe(true);

      // Verify shadow branch now exists on remote
      await fetchRemote(testDir);
      expect(await remoteBranchExists(testDir, SHADOW_BRANCH_NAME)).toBe(true);
    });

    // AC: @shadow-init-remote ac-3 - No remote configured → creates orphan locally (no push attempt)
    it('creates orphan locally when no remote configured', async () => {
      // Just a local git repo, no remote
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);
      expect(result.branchCreated).toBe(true);
      expect(result.pushedToRemote).toBe(false);
      expect(result.createdFromRemote).toBe(false);
    });

    // AC: @shadow-init-remote ac-4 - Fetches before checking for remote branch
    it('fetches before checking remote branch existence', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();

      // Initialize in first repo, push shadow
      await initializeShadow(testDir);
      await pushShadowToRemote();

      // Create clone
      const cloneDir = path.join('/tmp', `kspec-clone-test-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });

        // Clone won't have the remote refs yet until we fetch
        // The init should fetch automatically
        const result = await initializeShadow(cloneDir);

        // Should have detected and attached to remote (proves fetch happened)
        expect(result.success).toBe(true);
        expect(result.createdFromRemote).toBe(true);
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });
  });

  // AC: @shadow-sync - Shadow sync tests
  describe('shadow sync', () => {
    const remoteDir = path.join('/tmp', `kspec-sync-remote-${Date.now()}`);

    beforeEach(async () => {
      try {
        await fs.rm(remoteDir, { recursive: true });
      } catch {
        // Doesn't exist
      }
    });

    afterEach(async () => {
      try {
        await fs.rm(remoteDir, { recursive: true });
      } catch {
        // Best effort
      }
    });

    async function setupSyncTest(): Promise<void> {
      // Create bare remote
      await fs.mkdir(remoteDir, { recursive: true });
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
    }

    // AC: @shadow-sync ac-4 - No remote tracking → sync silently skipped
    it('hasRemoteTracking returns false when no tracking configured', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Initialize shadow without remote
      await initializeShadow(testDir);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      expect(await hasRemoteTracking(worktreeDir)).toBe(false);
    });

    it('hasRemoteTracking returns true when tracking is configured', async () => {
      await setupSyncTest();

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      expect(await hasRemoteTracking(worktreeDir)).toBe(true);
    });

    // AC: @shadow-sync ac-4 - shadowPull succeeds immediately when no tracking
    it('shadowPull succeeds immediately when no remote tracking', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });
      await initializeShadow(testDir);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const result = await shadowPull(worktreeDir);

      expect(result.success).toBe(true);
      expect(result.pulled).toBe(false);
      expect(result.hadConflict).toBe(false);
    });

    // AC: @shadow-sync ac-6 - shadowPull uses --ff-only first, falls back to --rebase
    it('shadowPull pulls changes from remote', async () => {
      await setupSyncTest();

      // Make a change on remote by cloning, modifying, and pushing
      const cloneDir = path.join('/tmp', `kspec-sync-clone-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        // Modify a file in the clone's shadow
        const tasksFile = (await fs.readdir(path.join(cloneDir, '.kspec')))
          .find(f => f.endsWith('.tasks.yaml'));
        if (tasksFile) {
          await fs.appendFile(
            path.join(cloneDir, '.kspec', tasksFile),
            '\n# Remote change\n'
          );
          execSync('git add -A && git commit -m "Remote change"', {
            cwd: path.join(cloneDir, '.kspec'),
            stdio: 'pipe',
          });
          execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
            cwd: path.join(cloneDir, '.kspec'),
            stdio: 'pipe',
          });
        }

        // Now pull in original repo
        const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
        const result = await shadowPull(worktreeDir);

        expect(result.success).toBe(true);
        expect(result.pulled).toBe(true);
        expect(result.hadConflict).toBe(false);

        // Verify the change was pulled
        const content = await fs.readFile(path.join(worktreeDir, tasksFile!), 'utf-8');
        expect(content).toContain('# Remote change');
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // shadowSync does pull then push
    it('shadowSync pulls and pushes', async () => {
      await setupSyncTest();

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Make a local change
      const tasksFile = (await fs.readdir(worktreeDir))
        .find(f => f.endsWith('.tasks.yaml'));
      if (tasksFile) {
        await fs.appendFile(
          path.join(worktreeDir, tasksFile),
          '\n# Local change\n'
        );
        execSync('git add -A && git commit -m "Local change"', {
          cwd: worktreeDir,
          stdio: 'pipe',
        });
      }

      const result = await shadowSync(worktreeDir);

      expect(result.success).toBe(true);
      expect(result.pushed).toBe(true);

      // Verify the change was pushed by checking remote
      const cloneDir = path.join('/tmp', `kspec-verify-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync(`git -C ${cloneDir} checkout ${SHADOW_BRANCH_NAME}`, { stdio: 'pipe' });
        const content = await fs.readFile(path.join(cloneDir, tasksFile!), 'utf-8');
        expect(content).toContain('# Local change');
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @shadow-sync ac-8 - Auto-configure tracking when main has remote but shadow doesn't
    it('ensureRemoteTracking sets up tracking when main has remote', async () => {
      // Create local repo WITHOUT using setupSyncTest (which auto-pushes shadow)
      await fs.mkdir(remoteDir, { recursive: true });
      execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });

      execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Add remote to main branch
      execSync(`git remote add origin ${remoteDir}`, { cwd: testDir, stdio: 'pipe' });
      execSync('git push -u origin main', { cwd: testDir, stdio: 'pipe' });

      // Initialize shadow WITHOUT pushing (simulate network failure or manual init)
      // Create orphan branch manually
      execSync(`git worktree add --orphan -b ${SHADOW_BRANCH_NAME} ${SHADOW_WORKTREE_DIR}`, {
        cwd: testDir,
        stdio: 'pipe',
      });

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Create initial file so it's a valid commit
      await fs.writeFile(path.join(worktreeDir, 'test.yaml'), 'test: true');
      execSync('git add -A && git commit -m "initial"', { cwd: worktreeDir, stdio: 'pipe' });

      // Verify no tracking initially
      expect(await hasRemoteTracking(worktreeDir)).toBe(false);

      // Call ensureRemoteTracking
      const result = await ensureRemoteTracking(worktreeDir, testDir);

      expect(result).toBe(true);
      expect(await hasRemoteTracking(worktreeDir)).toBe(true);

      // Verify tracking config
      const remote = execSync(`git config branch.${SHADOW_BRANCH_NAME}.remote`, {
        cwd: worktreeDir,
        encoding: 'utf-8',
      }).trim();
      expect(remote).toBe('origin');
    });

    // AC: @shadow-sync ac-8 - shadowPull auto-configures tracking
    it('shadowPull auto-configures tracking when main has remote', async () => {
      // Same setup as above
      await fs.mkdir(remoteDir, { recursive: true });
      execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });

      execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });
      execSync(`git remote add origin ${remoteDir}`, { cwd: testDir, stdio: 'pipe' });
      execSync('git push -u origin main', { cwd: testDir, stdio: 'pipe' });

      // Create shadow without tracking
      execSync(`git worktree add --orphan -b ${SHADOW_BRANCH_NAME} ${SHADOW_WORKTREE_DIR}`, {
        cwd: testDir,
        stdio: 'pipe',
      });

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await fs.writeFile(path.join(worktreeDir, 'test.yaml'), 'test: true');
      execSync('git add -A && git commit -m "initial"', { cwd: worktreeDir, stdio: 'pipe' });

      // Verify no tracking initially
      expect(await hasRemoteTracking(worktreeDir)).toBe(false);

      // Call shadowPull - should auto-configure tracking
      const result = await shadowPull(worktreeDir);

      // Pull succeeds (nothing to pull, but tracking now configured)
      expect(result.success).toBe(true);

      // Tracking should now be configured
      expect(await hasRemoteTracking(worktreeDir)).toBe(true);
    });
  });

  // AC: @shadow-debug-mode
  describe('Debug Mode', () => {
    let origEnv: string | undefined;

    beforeEach(() => {
      origEnv = process.env.KSPEC_DEBUG;
      delete process.env.KSPEC_DEBUG;
      // Reset verbose mode getter
      setVerboseModeGetter(() => false);
    });

    afterEach(() => {
      if (origEnv !== undefined) {
        process.env.KSPEC_DEBUG = origEnv;
      } else {
        delete process.env.KSPEC_DEBUG;
      }
    });

    // AC: @shadow-debug-mode ac-1
    it('enables debug mode with KSPEC_DEBUG=1 env var', () => {
      expect(isDebugMode()).toBe(false);
      process.env.KSPEC_DEBUG = '1';
      expect(isDebugMode()).toBe(true);
    });

    // AC: @shadow-debug-mode ac-2
    it('enables debug mode with verbose flag parameter', () => {
      expect(isDebugMode(false)).toBe(false);
      expect(isDebugMode(true)).toBe(true);
    });

    it('enables debug mode with --debug-shadow CLI flag via getter', () => {
      expect(isDebugMode()).toBe(false);
      // Simulate --debug-shadow flag set
      setVerboseModeGetter(() => true);
      expect(isDebugMode()).toBe(true);
    });

    // AC: @shadow-debug-mode ac-1
    it('outputs error messages when debug mode enabled via env var', async () => {
      // Setup a git repo with shadow
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Enable debug mode via env var
      process.env.KSPEC_DEBUG = '1';

      // Spy on console.error
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Write a file and trigger auto-commit
      await fs.writeFile(path.join(worktreeDir, 'test.yaml'), 'test: debug');
      await shadowAutoCommit(worktreeDir, 'test commit');

      // Should have debug output
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG] Shadow auto-commit')
      );

      consoleErrorSpy.mockRestore();
    });

    // AC: @shadow-debug-mode ac-2
    it('outputs error messages when debug mode enabled via debug-shadow flag', async () => {
      // Setup a git repo with shadow
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Spy on console.error
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Write a file and trigger auto-commit with verbose flag
      await fs.writeFile(path.join(worktreeDir, 'test2.yaml'), 'test: verbose');
      await shadowAutoCommit(worktreeDir, 'test commit', true);

      // Should have debug output
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG] Shadow auto-commit')
      );

      consoleErrorSpy.mockRestore();
    });

    // AC: @shadow-debug-mode ac-3
    it('does not output error messages when debug mode disabled', async () => {
      // Setup a git repo with shadow
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Spy on console.error
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Write a file and trigger auto-commit WITHOUT debug mode
      await fs.writeFile(path.join(worktreeDir, 'test3.yaml'), 'test: silent');
      await shadowAutoCommit(worktreeDir, 'test commit', false);

      // Should NOT have debug output
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG]')
      );

      consoleErrorSpy.mockRestore();
    });

    // AC: @shadow-debug-mode ac-1 - test with commit failure
    it('outputs error on auto-commit failure when debug enabled', async () => {
      // Setup a git repo with shadow
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Enable debug mode
      process.env.KSPEC_DEBUG = '1';

      // Spy on console.error
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Trigger auto-commit with an invalid scenario (no changes)
      const committed = await shadowAutoCommit(worktreeDir, 'empty commit');

      // Should return false (no changes to commit)
      expect(committed).toBe(false);

      // Should have debug output about no changes
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[DEBUG]')
      );

      consoleErrorSpy.mockRestore();
    });

    // AC: @shadow-debug-mode ac-3
    it('does not output error on auto-commit failure when debug disabled', async () => {
      // Setup a git repo with shadow
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Spy on console.error
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Trigger auto-commit with no changes (should be silent)
      const committed = await shadowAutoCommit(worktreeDir, 'empty commit', false);

      // Should return false (no changes to commit)
      expect(committed).toBe(false);

      // Should NOT have any debug output
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe('detectRunningFromShadowWorktree', () => {
    it('returns null for non-git directory', async () => {
      const result = await detectRunningFromShadowWorktree(testDir);
      expect(result).toBeNull();
    });

    it('returns null for regular git repo (has .git directory)', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      const result = await detectRunningFromShadowWorktree(testDir);
      expect(result).toBeNull();
    });

    it('returns project root when inside .kspec/ worktree', async () => {
      // Setup shadow worktree
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: testDir, stdio: 'pipe' });
      await initializeShadow(testDir);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const result = await detectRunningFromShadowWorktree(worktreeDir);
      expect(result).toBe(testDir);
    });

    it('returns null for non-kspec worktree', async () => {
      // Setup a regular (non-kspec) worktree
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: testDir, stdio: 'pipe' });
      execSync('git branch other-branch', { cwd: testDir, stdio: 'pipe' });

      const otherWorktreeDir = path.join(testDir, 'other-worktree');
      execSync(`git worktree add ${otherWorktreeDir} other-branch`, { cwd: testDir, stdio: 'pipe' });

      const result = await detectRunningFromShadowWorktree(otherWorktreeDir);
      expect(result).toBeNull();

      // Cleanup
      execSync(`git worktree remove ${otherWorktreeDir}`, { cwd: testDir, stdio: 'pipe' });
    });
  });

  // AC: @shadow-errors ac-4 - Running from inside .kspec
  describe('initContext from .kspec/ (E2E)', () => {
    it('throws ShadowError with RUNNING_FROM_SHADOW code', async () => {
      // Setup
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: testDir, stdio: 'pipe' });
      await initializeShadow(testDir);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await expect(initContext(worktreeDir)).rejects.toMatchObject({
        code: 'RUNNING_FROM_SHADOW',
      });
    });

    // AC: @shadow-errors ac-4, ac-5 - Error is actionable
    it('error message includes actionable suggestion', async () => {
      // Setup
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: testDir, stdio: 'pipe' });
      await initializeShadow(testDir);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      try {
        await initContext(worktreeDir);
        expect.fail('Should have thrown ShadowError');
      } catch (err) {
        expect(err).toBeInstanceOf(ShadowError);
        const shadowErr = err as ShadowError;
        expect(shadowErr.message).toContain('Cannot run kspec from inside .kspec/ directory');
        expect(shadowErr.suggestion).toContain('Run from project root');
      }
    });

    it('CLI exits with error when run from .kspec/', async () => {
      // Setup
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: testDir, stdio: 'pipe' });
      await initializeShadow(testDir);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Run CLI from .kspec/ directory - use 'tasks ready' which calls initContext()
      const result = kspecRun('tasks ready', worktreeDir, { expectFail: true });

      // Check combined output (error message may be in stdout or stderr)
      const combinedOutput = `${result.stdout}\n${result.stderr}`;
      expect(combinedOutput).toContain('Cannot run kspec from inside .kspec/ directory');
      expect(combinedOutput).toContain('Run from project root');
    });
  });

  // Shadow hook installation and authorization tests
  describe('installShadowHook', () => {
    it('installs pre-commit hook during shadow initialization', async () => {
      // Setup: Create source hook file
      const hooksSourceDir = path.join(testDir, 'hooks');
      const sourceHookPath = path.join(hooksSourceDir, 'pre-commit');
      await fs.mkdir(hooksSourceDir, { recursive: true });
      await fs.writeFile(sourceHookPath, '#!/bin/sh\necho "test hook"\nexit 0\n', { mode: 0o755 });

      // Initialize git repo with initial commit
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Initialize shadow - should install hook
      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);

      // Verify hook was installed to .git/hooks/pre-commit
      const installedHookPath = path.join(testDir, '.git', 'hooks', 'pre-commit');
      try {
        const hookContent = await fs.readFile(installedHookPath, 'utf-8');
        expect(hookContent).toBe('#!/bin/sh\necho "test hook"\nexit 0\n');

        // Verify hook is executable
        const stats = await fs.stat(installedHookPath);
        expect(stats.mode & 0o111).toBeGreaterThan(0); // At least one execute bit set
      } catch (err) {
        expect.fail(`Hook should be installed at ${installedHookPath}: ${err}`);
      }
    });

    it('blocks unauthorized commits to shadow branch', async () => {
      // Setup with real kspec pre-commit hook
      const realHookPath = path.resolve(__dirname, '../hooks/pre-commit');
      const hooksSourceDir = path.join(testDir, 'hooks');
      const sourceHookPath = path.join(hooksSourceDir, 'pre-commit');

      await fs.mkdir(hooksSourceDir, { recursive: true });
      // Copy the real hook
      const realHookContent = await fs.readFile(realHookPath, 'utf-8');
      await fs.writeFile(sourceHookPath, realHookContent, { mode: 0o755 });

      // Initialize git repo
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Initialize shadow
      await initializeShadow(testDir);

      // Try to commit to shadow branch WITHOUT authorization
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await fs.writeFile(path.join(worktreeDir, 'test.yaml'), 'test: unauthorized');
      execSync('git add -A', { cwd: worktreeDir, stdio: 'pipe' });

      // Attempt commit without KSPEC_SHADOW_COMMIT - should fail
      try {
        execSync('git commit -m "unauthorized commit"', {
          cwd: worktreeDir,
          stdio: 'pipe',
        });
        expect.fail('Commit should have been blocked by pre-commit hook');
      } catch (err: any) {
        // Hook should have blocked the commit
        expect(err.status).toBe(1);
      }

      // Verify no commit was created (still at initial shadow commit)
      // Note: In local dev with kspec in PATH, there may be 2 commits (initial + merge driver config)
      // In CI without kspec, there will be 1 commit (initial only)
      const logOutput = execSync('git log --oneline', {
        cwd: worktreeDir,
        encoding: 'utf-8',
      });
      const commitCount = logOutput.trim().split('\n').length;
      expect(commitCount).toBeGreaterThanOrEqual(1); // At least the initial commit
      expect(commitCount).toBeLessThanOrEqual(2); // At most initial + merge driver config
    });

    it('allows commits with KSPEC_SHADOW_COMMIT=1 env var', async () => {
      // Setup with real kspec pre-commit hook
      const realHookPath = path.resolve(__dirname, '../hooks/pre-commit');
      const hooksSourceDir = path.join(testDir, 'hooks');
      const sourceHookPath = path.join(hooksSourceDir, 'pre-commit');

      await fs.mkdir(hooksSourceDir, { recursive: true });
      const realHookContent = await fs.readFile(realHookPath, 'utf-8');
      await fs.writeFile(sourceHookPath, realHookContent, { mode: 0o755 });

      // Initialize git repo
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Initialize shadow
      await initializeShadow(testDir);

      // Try to commit WITH authorization
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await fs.writeFile(path.join(worktreeDir, 'test.yaml'), 'test: authorized');
      execSync('git add -A', { cwd: worktreeDir, stdio: 'pipe' });

      // Commit with KSPEC_SHADOW_COMMIT=1 - should succeed
      execSync('git commit -m "authorized commit"', {
        cwd: worktreeDir,
        stdio: 'pipe',
        env: { ...process.env, KSPEC_SHADOW_COMMIT: '1' },
      });

      // Verify commit was created
      // Note: In local dev with kspec in PATH, there will be 3 commits (initial + merge driver config + authorized)
      // In CI without kspec, there will be 2 commits (initial + authorized)
      const logOutput = execSync('git log --oneline', {
        cwd: worktreeDir,
        encoding: 'utf-8',
      });
      const commitCount = logOutput.trim().split('\n').length;
      expect(commitCount).toBeGreaterThanOrEqual(2); // At least initial + authorized
      expect(commitCount).toBeLessThanOrEqual(3); // At most initial + merge driver config + authorized

      // Verify commit message
      const latestCommit = execSync('git log -1 --pretty=%B', {
        cwd: worktreeDir,
        encoding: 'utf-8',
      }).trim();
      expect(latestCommit).toBe('authorized commit');
    });
  });
});
