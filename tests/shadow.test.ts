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
  hasRemote,
  remoteBranchExists,
  fetchRemote,
  hasRemoteTracking,
  ensureRemoteTracking,
  shadowPull,
  shadowSync,
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
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
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

    // AC-1: Remote has shadow branch → creates worktree from it with tracking
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

    // AC-2: Remote exists but no shadow branch → creates orphan and pushes
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

    // AC-3: No remote configured → creates orphan locally (no push attempt)
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

    // AC-4: Fetches before checking for remote branch
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
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });
      execSync(`git remote add origin ${remoteDir}`, { cwd: testDir, stdio: 'pipe' });
      execSync('git push -u origin main', { cwd: testDir, stdio: 'pipe' });

      // Initialize shadow with remote
      await initializeShadow(testDir);
    }

    // AC-4: No remote tracking → sync silently skipped
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

    // AC-4: shadowPull succeeds immediately when no tracking
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

    // AC-6: shadowPull uses --ff-only first, falls back to --rebase
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

    // AC-8: Auto-configure tracking when main has remote but shadow doesn't
    it('ensureRemoteTracking sets up tracking when main has remote', async () => {
      // Create local repo WITHOUT using setupSyncTest (which auto-pushes shadow)
      await fs.mkdir(remoteDir, { recursive: true });
      execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });

      execSync('git init', { cwd: testDir, stdio: 'pipe' });
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

    // AC-8: shadowPull auto-configures tracking
    it('shadowPull auto-configures tracking when main has remote', async () => {
      // Same setup as above
      await fs.mkdir(remoteDir, { recursive: true });
      execSync('git init --bare', { cwd: remoteDir, stdio: 'pipe' });

      execSync('git init', { cwd: testDir, stdio: 'pipe' });
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
});
