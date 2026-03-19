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
  shadowPushAsync,
  shadowSync,
  isDebugMode,
  setVerboseModeGetter,
  shadowAutoCommit,
  checkConfigMismatch,
  getGitVersion,
  gitSupportsOrphanWorktree,
  createOrphanBranchFallback,
  SESSIONS_WORKTREE_DIR,
  type ShadowConfig,
  type ShadowOptions,
} from '../src/parser/shadow.js';
import { initContext } from '../src/parser/yaml.js';
import { existsSync } from 'node:fs';
import { kspec as kspecRun } from './helpers/cli.js';
import { detectRemoteType } from '../src/parser/config.js';
import { createSession, appendEvent, getSession } from '../src/sessions/store.js';

// Check if git supports --orphan worktree (requires >= 2.42) and built CLI exists.
// initializeShadow needs both to work.
const projectCli = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');
const canRunShadowInitTests = (() => {
  try {
    const version = execSync('git --version', { encoding: 'utf-8' }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    const gitSupportsOrphan = major > 2 || (major === 2 && minor >= 42);
    return gitSupportsOrphan && existsSync(projectCli);
  } catch {
    return false;
  }
})();

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
    // AC: @trait-shadow-commit ac-2
    // AC: @trait-shadow-commit ac-3
    it.each([
      ['task-start', 'task-123', undefined, 'Start Task: @task-123'],
      ['task-complete', 'task-123', 'Done with implementation', 'Complete Task: @task-123 - Done with implementation'],
      ['task-note', 'task-123', undefined, 'Note Task: @task-123'],
      ['task-add', 'task-123', 'New feature', 'Add Task: @task-123 - New feature'],
      ['task-set', 'task-123', 'priority', 'Update Task: @task-123 - priority'],
      ['task-patch', 'task-123', undefined, 'Patch Task: @task-123'],
      ['task-submit', 'task-123', undefined, 'Submit Task: @task-123'],
      ['task-needs-work', 'task-123', 'fix blockers', 'Needs Work Task: @task-123 - fix blockers'],
      ['task-block', 'task-123', 'waiting on dependency', 'Block Task: @task-123 - waiting on dependency'],
      ['task-unblock', 'task-123', undefined, 'Unblock Task: @task-123'],
      ['task-cancel', 'task-123', 'superseded', 'Cancel Task: @task-123 - superseded'],
      ['task-reset', 'task-123', undefined, 'Reset Task: @task-123'],
      ['task-delete', 'task-123', undefined, 'Delete Task: @task-123'],
      ['spec-sync', 'spec-123', 'implemented', 'Sync Spec: @spec-123 - implemented'],
      ['review-add', 'review-123', 'Review title', 'Add Review: @review-123 - Review title'],
      ['review-comment', 'review-123', undefined, 'Comment Review: @review-123'],
      ['review-reply', 'review-123', undefined, 'Reply Review: @review-123'],
      ['review-check', 'review-123', 'vitest', 'Check Review: @review-123 - vitest'],
      ['review-verdict', 'review-123', 'approve', 'Verdict Review: @review-123 - approve'],
      ['review-verdict-task-transition', 'review-123', 'needs_work', 'Review Verdict Task Transition: @review-123 - needs_work'],
      ['review-resolve', 'review-123', undefined, 'Resolve Review: @review-123'],
      ['review-reopen', 'review-123', undefined, 'Reopen Review: @review-123'],
      ['review-open', 'review-123', undefined, 'Open Review: @review-123'],
      ['review-close', 'review-123', undefined, 'Close Review: @review-123'],
      ['review-archive', 'review-123', undefined, 'Archive Review: @review-123'],
      ['review-refresh', 'review-123', undefined, 'Refresh Review: @review-123'],
      ['review-task-link', 'review-123', 'linked to 2 task(s)', 'Link Review Task: @review-123 - linked to 2 task(s)'],
      ['plan-add', 'plan-123', 'Roadmap', 'Add Plan: @plan-123 - Roadmap'],
      ['plan-set', 'plan-123', 'status=approved', 'Update Plan: @plan-123 - status=approved'],
      ['plan-note', 'plan-123', undefined, 'Note Plan: @plan-123'],
      ['plan-derive', 'plan-123', undefined, 'Derive Plan: @plan-123'],
      ['plan-import', 'plan-123', 'Imported Plan', 'Import Plan: @plan-123 - Imported Plan'],
      ['inbox-promote', 'task-123', undefined, 'Promote Inbox Item: @task-123'],
      ['inbox-delete', '01ABCDEF', undefined, 'Delete Inbox Item: @01ABCDEF'],
      ['inbox-set', '01ABCDEF', undefined, 'Update Inbox Item: @01ABCDEF'],
      ['inbox-note', '01ABCDEF', undefined, 'Note Inbox Item: @01ABCDEF'],
      ['triage-record', '01ABCDEF', 'promote', 'Record Triage: @01ABCDEF - promote'],
      ['triage-act', '01ABCDEF', 'promote', 'Act Triage: @01ABCDEF - promote'],
      ['triage-override', '01ABCDEF', 'defer', 'Override Triage: @01ABCDEF - defer'],
      ['meta-observe', '01ABCDEF', 'friction', 'Observe Meta: @01ABCDEF - friction'],
      ['meta-observe-from-inbox', '01ABCDEF', 'Convert inbox item to friction observation', 'Observe Meta from Inbox: @01ABCDEF - Convert inbox item to friction observation'],
      ['observation-promote', '01ABCDEF', undefined, 'Promote Observation: @01ABCDEF'],
      ['observation-resolve', '01ABCDEF', undefined, 'Resolve Observation: @01ABCDEF'],
      ['meta-add-agent', '01ABCDEF', 'worker', 'Add Agent: @01ABCDEF - worker'],
      ['meta-add-workflow', '01ABCDEF', 'task-lifecycle', 'Add Workflow: @01ABCDEF - task-lifecycle'],
      ['meta-add-convention', '01ABCDEF', 'testing', 'Add Convention: @01ABCDEF - testing'],
      ['meta-set-agent', '01ABCDEF', undefined, 'Update Agent: @01ABCDEF'],
      ['meta-set-workflow', '01ABCDEF', undefined, 'Update Workflow: @01ABCDEF'],
      ['meta-set-convention', '01ABCDEF', undefined, 'Update Convention: @01ABCDEF'],
      ['meta-delete-agent', '01ABCDEF', undefined, 'Delete Agent: @01ABCDEF'],
      ['meta-delete-workflow', '01ABCDEF', undefined, 'Delete Workflow: @01ABCDEF'],
      ['meta-delete-convention', '01ABCDEF', undefined, 'Delete Convention: @01ABCDEF'],
      ['meta-delete-observation', '01ABCDEF', undefined, 'Delete Observation: @01ABCDEF'],
      ['skill-add', 'skill-123', 'My Skill', 'Add Skill: @skill-123 - My Skill'],
      ['skill-set', 'skill-123', 'My Skill', 'Update Skill: @skill-123 - My Skill'],
      ['skill-delete', 'skill-123', undefined, 'Delete Skill: @skill-123'],
      ['skill-import', 'skill-123', 'My Skill', 'Import Skill: @skill-123 - My Skill'],
      ['skill-update', 'skill-123', 'My Skill', 'Update Skill: @skill-123 - My Skill'],
      ['trait-add', 'trait-123', undefined, 'Add Trait: @trait-123'],
      ['item-add', 'item-123', undefined, 'Add Item: @item-123'],
      ['item-set', 'item-123', undefined, 'Update Item: @item-123'],
      ['item-delete', 'item-123', undefined, 'Delete Item: @item-123'],
      ['link-add', 'item-123', 'implements @item-456', 'Add Link: @item-123 - implements @item-456'],
      ['link-remove', 'item-123', 'implements, depends_on @item-456', 'Remove Link: @item-123 - implements, depends_on @item-456'],
      ['item-trait-add', 'item-123', undefined, 'Add Item Trait: @item-123'],
      ['item-trait-remove', 'item-123', undefined, 'Remove Item Trait: @item-123'],
      ['item-note', 'item-123', undefined, 'Note Item: @item-123'],
      ['item-patch', 'item-123', undefined, 'Patch Item: @item-123'],
      ['item-ac-add', 'item-123', undefined, 'Add Item AC: @item-123'],
      ['item-ac-set', 'item-123', undefined, 'Update Item AC: @item-123'],
      ['item-ac-remove', 'item-123', undefined, 'Remove Item AC: @item-123'],
      ['module-add', 'module-123', undefined, 'Add Module: @module-123'],
      ['workflow-start', 'workflow-123', undefined, 'Start Workflow: @workflow-123'],
      ['workflow-abort', 'workflow-123', undefined, 'Abort Workflow: @workflow-123'],
      ['workflow-complete', 'workflow-123', undefined, 'Complete Workflow: @workflow-123'],
      ['workflow-pause', 'workflow-123', undefined, 'Pause Workflow: @workflow-123'],
      ['workflow-resume', 'workflow-123', undefined, 'Resume Workflow: @workflow-123'],
      ['workflow-next', 'workflow-123', undefined, 'Advance Workflow: @workflow-123'],
      ['workflow-prune', 'workflow-123', undefined, 'Prune Workflow: @workflow-123'],
      ['session-compact', 'session-123', undefined, 'Compact Session: @session-123'],
      ['tasks-assess', 'tasks-123', undefined, 'Assess Tasks: @tasks-123'],
      ['dispatch-workspace-registry', '01KKNRC5KR8DTW5JVETBX9CMS8', undefined, 'Update Dispatch Workspace Registry: @01KKNRC5KR8DTW5JVETBX9CMS8'],
      ['hook-add', '01HOOK01', 'Build Hook', 'Add Hook: @01HOOK01 - Build Hook'],
      ['hook-set', '01HOOK01', 'Build Hook', 'Update Hook: @01HOOK01 - Build Hook'],
      ['hook-enable', '01HOOK01', 'Build Hook', 'Enable Hook: @01HOOK01 - Build Hook'],
      ['hook-disable', '01HOOK01', 'Build Hook', 'Disable Hook: @01HOOK01 - Build Hook'],
      ['hook-remove', '01HOOK01', 'Build Hook', 'Remove Hook: @01HOOK01 - Build Hook'],
      ['schedule-add', 'nightly', 'Nightly Build', 'Add Schedule: @nightly - Nightly Build'],
      ['schedule-set', 'nightly', 'Nightly Build', 'Update Schedule: @nightly - Nightly Build'],
      ['schedule-enable', 'nightly', undefined, 'Enable Schedule: @nightly'],
      ['schedule-disable', 'nightly', undefined, 'Disable Schedule: @nightly'],
      ['schedule-remove', 'nightly', undefined, 'Remove Schedule: @nightly'],
      ['derive', 'spec-item', undefined, 'Derive: @spec-item'],
    ])('formats %s with explicit colon-separated messaging', (operation, ref, detail, expected) => {
      expect(generateCommitMessage(operation, ref, detail)).toBe(expected);
    });

    it('formats detail-only operations without inventing a ref', () => {
      expect(generateCommitMessage('task-add', undefined, 'New feature')).toBe(
        'Add Task: New feature',
      );
      expect(generateCommitMessage('skill-render', '2 skills')).toBe(
        'Render Skill: 2 skills',
      );
      expect(generateCommitMessage('skill-install-core', '3 core skills')).toBe(
        'Install Core Skill: 3 core skills',
      );
      expect(generateCommitMessage('item-delete', '3 items')).toBe(
        'Delete Item: 3 items',
      );
    });

    it('generates inbox-add message with truncation', () => {
      const longText = 'a'.repeat(100);
      const msg = generateCommitMessage('inbox-add', undefined, longText);
      expect(msg).toBe(`Add Inbox Item: ${'a'.repeat(50)}...`);
    });

    it('normalizes @-prefixed refs to a single marker', () => {
      const msg = generateCommitMessage(
        'dispatch-workspace-registry',
        '@01KKNRC5KR8DTW5JVETBX9CMS8',
      );
      expect(msg).toBe(
        'Update Dispatch Workspace Registry: @01KKNRC5KR8DTW5JVETBX9CMS8',
      );
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

    async function setupShadowRepo(rootManifest = false): Promise<void> {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: testDir, stdio: 'pipe' });
      await initializeShadow(testDir);

      if (rootManifest) {
        await fs.writeFile(
          path.join(testDir, 'kynetic.yaml'),
          'kynetic: "1.0"\nproject:\n  name: Root Fallback Trap\n  version: "0.1.0"\n  status: draft\n'
        );
      }
    }

    // AC: @broken-shadow-safety ac-context-fails-fast
    // AC: @broken-shadow-safety ac-no-root-fallback
    it('throws DIRECTORY_MISSING instead of falling back to repo-root paths when a root manifest exists', async () => {
      await setupShadowRepo(true);

      execSync(`git worktree remove ${SHADOW_WORKTREE_DIR} --force`, {
        cwd: testDir,
        stdio: 'pipe',
      });

      await expect(initContext(testDir)).rejects.toMatchObject({
        code: 'DIRECTORY_MISSING',
      });
    });

    // AC: @broken-shadow-safety ac-context-fails-fast
    it('throws WORKTREE_DISCONNECTED when the shadow worktree link is corrupted', async () => {
      await setupShadowRepo();

      await fs.writeFile(
        path.join(testDir, SHADOW_WORKTREE_DIR, '.git'),
        'corrupted content'
      );

      await expect(initContext(testDir)).rejects.toMatchObject({
        code: 'WORKTREE_DISCONNECTED',
      });
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
    // Uses a temporary kspec wrapper in PATH pointing to the project's built CLI,
    // so the test works without a global kspec install (e.g. in CI).
    // Requires git >= 2.42 for --orphan worktree support used by initializeShadow.
    it.skipIf(!canRunShadowInitTests)(
      'configures merge driver during initialization',
      async () => {
        // Initialize git repo with an initial commit
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Create a temporary bin directory with a kspec wrapper that delegates
        // to the project's built CLI, so `which kspec` succeeds without a global install
        const binDir = path.join(testDir, '_bin');
        await fs.mkdir(binDir, { recursive: true });
        await fs.writeFile(
          path.join(binDir, 'kspec'),
          `#!/bin/sh\nexec node "${projectCli}" "$@"\n`,
          { mode: 0o755 },
        );

        // Prepend our bin dir to PATH so configureMergeDriver finds it
        const originalPath = process.env.PATH;
        process.env.PATH = `${binDir}:${originalPath}`;
        try {
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
        } finally {
          // Restore original PATH
          process.env.PATH = originalPath;
        }
      },
    );

    // AC: @artifacts-directory ac-init-creates
    it('creates artifacts directory during init', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir, { projectName: 'Test Project' });
      expect(result.success).toBe(true);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const artifactsDir = path.join(worktreeDir, 'artifacts');
      const stat = await fs.stat(artifactsDir);
      expect(stat.isDirectory()).toBe(true);
    });

    // AC: @artifacts-directory ac-gitignore-entry
    it('creates .gitignore with artifacts/ entry during init', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir, { projectName: 'Test Project' });
      expect(result.success).toBe(true);

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const gitignoreContent = await fs.readFile(path.join(worktreeDir, '.gitignore'), 'utf-8');
      expect(gitignoreContent).toContain('artifacts/');
    });

    // AC: @artifacts-directory ac-commits-exclude
    it('does not include artifacts files in shadow branch commits', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      await initializeShadow(testDir, { projectName: 'Test Project' });

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const artifactsDir = path.join(worktreeDir, 'artifacts');

      // Create a file in artifacts/
      await fs.writeFile(path.join(artifactsDir, 'test-report.html'), '<html>test</html>');

      // Stage all and check what would be committed
      execSync('git add -A', { cwd: worktreeDir, stdio: 'pipe' });
      const staged = execSync('git diff --cached --name-only', {
        cwd: worktreeDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // artifacts/ files should not appear in staged changes
      expect(staged).not.toContain('artifacts/');
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

    // AC: @broken-shadow-safety ac-preserve-on-failure
    it('restores the previous .kspec directory when repair cannot recreate the worktree', async () => {
      await setupHealthyShadow();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const gitFile = path.join(worktreeDir, '.git');
      const competingWorktree = path.join(testDir, 'shadow-conflict');

      await fs.writeFile(gitFile, 'corrupted content');
      execSync(`git worktree add --force "${competingWorktree}" kspec-meta`, {
        cwd: testDir,
        stdio: 'pipe',
      });

      const result = await repairShadow(testDir);
      expect(result.success).toBe(false);
      expect(await fs.readFile(gitFile, 'utf-8')).toBe('corrupted content');
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

    // AC: @artifacts-directory ac-repair-recreates
    it('recreates artifacts directory after repair', async () => {
      await setupHealthyShadow();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Break: delete the worktree directory
      execSync(`git worktree remove ${SHADOW_WORKTREE_DIR} --force`, { cwd: testDir, stdio: 'pipe' });

      // Repair
      const result = await repairShadow(testDir);
      expect(result.success).toBe(true);

      // Verify artifacts directory was recreated
      const artifactsDir = path.join(worktreeDir, 'artifacts');
      const stat = await fs.stat(artifactsDir);
      expect(stat.isDirectory()).toBe(true);
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

    // AC: @broken-shadow-safety ac-bootstrap-reuses-repair
    it('repair reattaches shadow state from the remote when the local branch is missing', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();

      await initializeShadow(testDir);
      await pushShadowToRemote();

      const cloneDir = path.join('/tmp', `kspec-repair-clone-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });

        const branchList = execSync(`git -C ${cloneDir} branch --list ${SHADOW_BRANCH_NAME}`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        expect(branchList).toBe('');

        const result = await repairShadow(cloneDir);
        expect(result.success).toBe(true);
        expect(result.createdFromRemote).toBe(true);
        expect(result.worktreeCreated).toBe(true);

        const status = await getShadowStatus(cloneDir);
        expect(status.healthy).toBe(true);
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

    // AC: @shadow-init-remote ac-5 - Works in shallow clones
    it('attaches to existing remote shadow branch from shallow clone', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();

      // Initialize shadow in first repo and push
      await initializeShadow(testDir);
      await pushShadowToRemote();

      // Shallow clone — only gets default branch, no kspec-meta refs
      // Use file:// protocol so --depth is respected (ignored for local path clones)
      const cloneDir = path.join('/tmp', `kspec-shallow-test-${Date.now()}`);
      try {
        execSync(`git clone --depth 1 file://${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });

        // Verify kspec-meta is NOT in local refs (shallow clone doesn't have it)
        try {
          execSync(`git show-ref --verify refs/remotes/origin/${SHADOW_BRANCH_NAME}`, {
            cwd: cloneDir,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          throw new Error('Expected show-ref to fail in shallow clone');
        } catch (err: unknown) {
          // Expected — the ref doesn't exist locally
          if (err instanceof Error && err.message === 'Expected show-ref to fail in shallow clone') {
            throw err;
          }
        }

        // Initialize shadow — should detect remote branch via ls-remote and attach
        const result = await initializeShadow(cloneDir);
        expect(result.success).toBe(true);
        expect(result.createdFromRemote).toBe(true);
        expect(result.branchCreated).toBe(false);
        expect(result.worktreeCreated).toBe(true);

        // Verify worktree is healthy
        const status = await getShadowStatus(cloneDir);
        expect(status.healthy).toBe(true);
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @shadow-init-remote ac-4 - Queries remote refs directly (ls-remote)
    it('detects remote branch without relying on locally-fetched refs', async () => {
      await setupBareRemote();
      await setupLocalWithRemote();

      // Initialize in first repo, push shadow
      await initializeShadow(testDir);
      await pushShadowToRemote();

      // Create clone — remote refs for kspec-meta won't be local yet
      const cloneDir = path.join('/tmp', `kspec-clone-test-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });

        // Verify kspec-meta is not in local remote refs before init
        const hasLocalRef = (() => {
          try {
            execSync(`git show-ref --verify refs/remotes/origin/${SHADOW_BRANCH_NAME}`, {
              cwd: cloneDir,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            return true;
          } catch {
            return false;
          }
        })();

        // Init should detect remote branch via ls-remote (direct remote query)
        // regardless of whether local refs exist
        const result = await initializeShadow(cloneDir);

        expect(result.success).toBe(true);
        expect(result.createdFromRemote).toBe(true);

        // ls-remote works even when local refs are absent
        // (in full clones they may exist from clone, but this proves
        // init doesn't depend on them)
        expect(await remoteBranchExists(cloneDir, SHADOW_BRANCH_NAME)).toBe(true);
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

    // AC: @shadow-sync ac-1 - Auto-push failures are visible in stderr warnings
    it('shadowPushAsync logs warning when background push fails', async () => {
      await setupSyncTest();

      // Break the remote so git push fails while tracking is still configured.
      await fs.rm(remoteDir, { recursive: true, force: true });

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await shadowPushAsync(worktreeDir);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('[WARN] Shadow auto-push failed')
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    // AC: @shadow-sync ac-1 - Repeated failures escalate visibility
    it('shadowPushAsync emits escalation warning after repeated failures', async () => {
      await setupSyncTest();

      // Break the remote so each push attempt fails.
      await fs.rm(remoteDir, { recursive: true, force: true });

      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await shadowPushAsync(worktreeDir);
        await shadowPushAsync(worktreeDir);
        await shadowPushAsync(worktreeDir);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('times in a row')
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
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

    it('shadowPull succeeds with dirty worktree by stashing and restoring local changes', async () => {
      await setupSyncTest();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Push a remote change via clone
      const cloneDir = path.join('/tmp', `kspec-sync-dirty-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        await fs.writeFile(
          path.join(cloneDir, '.kspec', 'remote-file.yaml'),
          'remote: true\n'
        );
        execSync('git add -A && git commit -m "Remote adds file"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });

        // Create uncommitted local changes (dirty worktree)
        await fs.writeFile(
          path.join(worktreeDir, 'dirty-local.yaml'),
          'dirty: true\n'
        );

        // Pull should succeed despite dirty worktree
        const result = await shadowPull(worktreeDir);
        expect(result.success).toBe(true);
        expect(result.pulled).toBe(true);
        expect(result.hadConflict).toBe(false);

        // Remote file should be present
        const remoteContent = await fs.readFile(
          path.join(worktreeDir, 'remote-file.yaml'),
          'utf-8',
        );
        expect(remoteContent).toContain('remote: true');

        // Local dirty file should still be present (restored from stash)
        const localContent = await fs.readFile(
          path.join(worktreeDir, 'dirty-local.yaml'),
          'utf-8',
        );
        expect(localContent).toContain('dirty: true');
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
        // Must set KSPEC_SHADOW_COMMIT=1 to authorize commit to shadow branch
        execSync('git add -A && git commit -m "Local change"', {
          cwd: worktreeDir,
          stdio: 'pipe',
          env: { ...process.env, KSPEC_SHADOW_COMMIT: '1' },
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

      expect(result.success).toBe(true);
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

    // AC: @config-shadow ac-11
    // AC: @shadow-write-sync ac-write-always-syncs
    it('shadowPushAsync integrates remote changes via pull-rebase before pushing', async () => {
      await setupSyncTest();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Make a remote change via a clone — add a NEW file to avoid merge conflicts
      const cloneDir = path.join('/tmp', `kspec-bidir-clone-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        // Clone adds a new file (no conflict with local changes)
        await fs.writeFile(
          path.join(cloneDir, '.kspec', 'remote-marker.yaml'),
          'marker: from-clone\n'
        );
        execSync('git add -A && git commit -m "Clone adds marker file"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });

        // Local adds a DIFFERENT new file (no conflict)
        await fs.writeFile(
          path.join(worktreeDir, 'local-marker.yaml'),
          'marker: from-local\n'
        );
        await shadowAutoCommit(worktreeDir, 'Local adds marker file');

        // Push — should pull-rebase (integrating clone's file), then push
        await shadowPushAsync(worktreeDir);

        // Verify clone's file was pulled into local worktree
        const remoteMarkerContent = await fs.readFile(
          path.join(worktreeDir, 'remote-marker.yaml'),
          'utf-8',
        );
        expect(remoteMarkerContent).toContain('marker: from-clone');

        // Verify local file still exists
        const localMarkerContent = await fs.readFile(
          path.join(worktreeDir, 'local-marker.yaml'),
          'utf-8',
        );
        expect(localMarkerContent).toContain('marker: from-local');

        // Verify remote has both files after push
        const verifyDir = path.join('/tmp', `kspec-bidir-verify-${Date.now()}`);
        try {
          execSync(`git clone ${remoteDir} ${verifyDir}`, { stdio: 'pipe' });
          execSync(`git -C ${verifyDir} checkout ${SHADOW_BRANCH_NAME}`, { stdio: 'pipe' });
          const verifyRemote = await fs.readFile(
            path.join(verifyDir, 'remote-marker.yaml'),
            'utf-8',
          );
          const verifyLocal = await fs.readFile(
            path.join(verifyDir, 'local-marker.yaml'),
            'utf-8',
          );
          expect(verifyRemote).toContain('marker: from-clone');
          expect(verifyLocal).toContain('marker: from-local');
        } finally {
          await fs.rm(verifyDir, { recursive: true, force: true });
        }
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @shadow-write-sync ac-write-always-syncs
    it('commitIfShadow triggers full pull-rebase-before-push sync on mutating write', async () => {
      await setupSyncTest();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Make a remote change via a clone — add a NEW file to avoid merge conflicts
      const cloneDir = path.join('/tmp', `kspec-commitif-clone-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        // Clone adds a new file (no conflict with local changes)
        await fs.writeFile(
          path.join(cloneDir, '.kspec', 'remote-commitif-marker.yaml'),
          'marker: from-clone-commitif\n'
        );
        execSync('git add -A && git commit -m "Clone adds commitif marker file"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });

        // Add a local file that commitIfShadow will auto-commit
        await fs.writeFile(
          path.join(worktreeDir, 'local-commitif-marker.yaml'),
          'marker: from-local-commitif\n'
        );

        // Call commitIfShadow — the actual write entrypoint
        const shadowConfig: ShadowConfig = {
          enabled: true,
          worktreeDir,
          branchName: SHADOW_BRANCH_NAME,
          projectRoot: testDir,
        };
        const committed = await commitIfShadow(shadowConfig, 'test-write', undefined, 'commitIfShadow sync test');
        expect(committed).toBe(true);

        // Wait for the fire-and-forget push to complete (pull-rebase runs inside shadowPushAsync)
        const maxWait = 10_000;
        const start = Date.now();
        const remoteMarkerPath = path.join(worktreeDir, 'remote-commitif-marker.yaml');
        while (Date.now() - start < maxWait) {
          try {
            await fs.access(remoteMarkerPath);
            break; // File exists — pull-rebase integrated the remote change
          } catch {
            await new Promise(r => setTimeout(r, 200));
          }
        }

        // Verify clone's file was pulled into local worktree (proves pull-rebase ran)
        const remoteMarkerContent = await fs.readFile(remoteMarkerPath, 'utf-8');
        expect(remoteMarkerContent).toContain('marker: from-clone-commitif');

        // Verify local file still exists
        const localMarkerContent = await fs.readFile(
          path.join(worktreeDir, 'local-commitif-marker.yaml'),
          'utf-8',
        );
        expect(localMarkerContent).toContain('marker: from-local-commitif');
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @config-shadow ac-11
    it('shadowPushAsync reports failure when pull-rebase has unresolvable conflicts', async () => {
      await setupSyncTest();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      const cloneDir = path.join('/tmp', `kspec-bidir-conflict-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        // Both sides create a file with the SAME name but different content (binary-like conflict)
        // Use a non-YAML file (.txt) so the kspec merge driver doesn't apply
        await fs.writeFile(
          path.join(cloneDir, '.kspec', 'conflict-file.txt'),
          'REMOTE CONTENT LINE 1\nREMOTE CONTENT LINE 2\n'
        );
        execSync('git add -A && git commit -m "Remote adds conflict file"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });

        // Local creates the SAME file with different content
        await fs.writeFile(
          path.join(worktreeDir, 'conflict-file.txt'),
          'LOCAL CONTENT LINE 1\nLOCAL CONTENT LINE 2\n'
        );
        await shadowAutoCommit(worktreeDir, 'Local adds conflict file');

        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await shadowPushAsync(worktreeDir);

          // Should see a push failure warning about conflicts
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining('[WARN] Shadow auto-push failed')
          );
        } finally {
          consoleErrorSpy.mockRestore();
        }
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @config-shadow ac-11
    it('initContext pulls remote shadow changes before returning (pre-read sync)', async () => {
      await setupSyncTest();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Push a new file from a clone so the remote is ahead
      const cloneDir = path.join('/tmp', `kspec-preread-clone-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        // Clone adds a new file and pushes
        await fs.writeFile(
          path.join(cloneDir, '.kspec', 'preread-marker.yaml'),
          'marker: from-remote\n'
        );
        execSync('git add -A && git commit -m "Clone adds preread marker"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });

        // Verify the file does NOT exist locally before initContext
        const markerPath = path.join(worktreeDir, 'preread-marker.yaml');
        expect(existsSync(markerPath)).toBe(false);

        // Call initContext — should trigger pre-read pull
        const ctx = await initContext(testDir);

        // Verify shadow is enabled
        expect(ctx.shadow?.enabled).toBe(true);

        // Verify the remote file was pulled down
        expect(existsSync(markerPath)).toBe(true);
        const content = await fs.readFile(markerPath, 'utf-8');
        expect(content).toContain('marker: from-remote');
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @config-shadow ac-11
    it('initContext skips pre-read pull when KSPEC_NO_SYNC is set', async () => {
      await setupSyncTest();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

      // Push a new file from a clone
      const cloneDir = path.join('/tmp', `kspec-nosync-clone-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        await fs.writeFile(
          path.join(cloneDir, '.kspec', 'nosync-marker.yaml'),
          'marker: should-not-pull\n'
        );
        execSync('git add -A && git commit -m "Clone adds nosync marker"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });

        // Set KSPEC_NO_SYNC to disable pre-read pull
        process.env.KSPEC_NO_SYNC = '1';
        try {
          await initContext(testDir);

          // File should NOT have been pulled
          const markerPath = path.join(worktreeDir, 'nosync-marker.yaml');
          expect(existsSync(markerPath)).toBe(false);
        } finally {
          delete process.env.KSPEC_NO_SYNC;
        }
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
    });

    // AC: @config-shadow ac-3 ac-11
    it('shadowPull uses configured named remote instead of origin', async () => {
      // Set up a bare remote with a non-default name
      const specsRemoteDir = path.join('/tmp', `kspec-specs-remote-${Date.now()}`);
      try {
        await fs.mkdir(specsRemoteDir, { recursive: true });
        execSync('git init --bare', { cwd: specsRemoteDir, stdio: 'pipe' });

        // Create local repo with the non-default remote name
        execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Add remote as "specs-origin" (NOT "origin")
        execSync(`git remote add specs-origin ${specsRemoteDir}`, { cwd: testDir, stdio: 'pipe' });
        execSync('git push -u specs-origin main', { cwd: testDir, stdio: 'pipe' });

        // Initialize shadow and configure tracking against specs-origin
        await initializeShadow(testDir);
        const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
        execSync(`git push specs-origin ${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'pipe' });
        execSync(`git config branch.${SHADOW_BRANCH_NAME}.remote specs-origin`, { cwd: worktreeDir, stdio: 'pipe' });
        execSync(`git config branch.${SHADOW_BRANCH_NAME}.merge refs/heads/${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'pipe' });

        // Clone from specs-origin, push a change to shadow branch
        const cloneDir = path.join('/tmp', `kspec-specs-clone-${Date.now()}`);
        try {
          execSync(`git clone ${specsRemoteDir} ${cloneDir}`, { stdio: 'pipe' });
          execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
          execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
          execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

          await fs.writeFile(
            path.join(cloneDir, '.kspec', 'specs-remote-marker.yaml'),
            'marker: from-specs-origin\n'
          );
          execSync('git add -A && git commit -m "Clone adds marker via specs-origin"', {
            cwd: path.join(cloneDir, '.kspec'),
            stdio: 'pipe',
          });
          execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
            cwd: path.join(cloneDir, '.kspec'),
            stdio: 'pipe',
          });

          // Verify marker does not exist locally yet
          const markerPath = path.join(worktreeDir, 'specs-remote-marker.yaml');
          expect(existsSync(markerPath)).toBe(false);

          // Pull with configured remote options — should use specs-origin, not origin
          const result = await shadowPull(worktreeDir, {
            remote: 'specs-origin',
            remoteType: 'named',
          });

          expect(result.success).toBe(true);
          expect(result.pulled).toBe(true);

          // Verify the marker was pulled from specs-origin
          expect(existsSync(markerPath)).toBe(true);
          const content = await fs.readFile(markerPath, 'utf-8');
          expect(content).toContain('marker: from-specs-origin');
        } finally {
          await fs.rm(cloneDir, { recursive: true, force: true });
        }
      } finally {
        await fs.rm(specsRemoteDir, { recursive: true, force: true });
      }
    });

    // AC: @config-shadow ac-3 ac-11
    it('shadowPushAsync pull-rebase uses configured remote for integration', async () => {
      // Set up a bare remote with a non-default name
      const specsRemoteDir = path.join('/tmp', `kspec-push-specs-remote-${Date.now()}`);
      try {
        await fs.mkdir(specsRemoteDir, { recursive: true });
        execSync('git init --bare', { cwd: specsRemoteDir, stdio: 'pipe' });

        // Create local repo with the non-default remote name
        execSync('git init -b main', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Add remote as "specs-origin" (NOT "origin")
        execSync(`git remote add specs-origin ${specsRemoteDir}`, { cwd: testDir, stdio: 'pipe' });
        execSync('git push -u specs-origin main', { cwd: testDir, stdio: 'pipe' });

        // Initialize shadow and configure tracking against specs-origin
        await initializeShadow(testDir);
        const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
        execSync(`git push specs-origin ${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'pipe' });
        execSync(`git config branch.${SHADOW_BRANCH_NAME}.remote specs-origin`, { cwd: worktreeDir, stdio: 'pipe' });
        execSync(`git config branch.${SHADOW_BRANCH_NAME}.merge refs/heads/${SHADOW_BRANCH_NAME}`, { cwd: worktreeDir, stdio: 'pipe' });

        // Clone from specs-origin, push a new file to shadow branch
        const cloneDir = path.join('/tmp', `kspec-push-specs-clone-${Date.now()}`);
        try {
          execSync(`git clone ${specsRemoteDir} ${cloneDir}`, { stdio: 'pipe' });
          execSync('git config user.email "clone@test.com"', { cwd: cloneDir, stdio: 'pipe' });
          execSync('git config user.name "Clone"', { cwd: cloneDir, stdio: 'pipe' });
          execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

          await fs.writeFile(
            path.join(cloneDir, '.kspec', 'push-specs-marker.yaml'),
            'marker: from-clone-via-specs\n'
          );
          execSync('git add -A && git commit -m "Clone adds push marker via specs-origin"', {
            cwd: path.join(cloneDir, '.kspec'),
            stdio: 'pipe',
          });
          execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
            cwd: path.join(cloneDir, '.kspec'),
            stdio: 'pipe',
          });

          // Local adds a different file
          await fs.writeFile(
            path.join(worktreeDir, 'local-push-marker.yaml'),
            'marker: from-local-push\n'
          );
          await shadowAutoCommit(worktreeDir, 'Local adds push marker file');

          // Push — should pull-rebase from specs-origin, integrate clone's file, then push
          await shadowPushAsync(worktreeDir, undefined, {
            remote: 'specs-origin',
            remoteType: 'named',
          });

          // Verify clone's file was pulled into local worktree
          const remoteMarkerPath = path.join(worktreeDir, 'push-specs-marker.yaml');
          expect(existsSync(remoteMarkerPath)).toBe(true);
          const remoteContent = await fs.readFile(remoteMarkerPath, 'utf-8');
          expect(remoteContent).toContain('marker: from-clone-via-specs');

          // Verify local file still exists
          const localMarkerPath = path.join(worktreeDir, 'local-push-marker.yaml');
          expect(existsSync(localMarkerPath)).toBe(true);
        } finally {
          await fs.rm(cloneDir, { recursive: true, force: true });
        }
      } finally {
        await fs.rm(specsRemoteDir, { recursive: true, force: true });
      }
    });

    // AC: @session-remove-shadow-commits ac-no-sync-conflict
    it('session writes to .kspec-sessions/ do not conflict with shadowPull on .kspec/', async () => {
      await setupSyncTest();
      const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      const sessionsDir = path.join(testDir, SESSIONS_WORKTREE_DIR);

      // Push a remote change to the shadow branch via a clone
      const cloneDir = path.join('/tmp', `kspec-sync-session-conflict-${Date.now()}`);
      try {
        execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: cloneDir, stdio: 'pipe' });
        execSync(`git worktree add .kspec ${SHADOW_BRANCH_NAME}`, { cwd: cloneDir, stdio: 'pipe' });

        await fs.writeFile(
          path.join(cloneDir, '.kspec', 'remote-task-update.yaml'),
          'task_status: updated_remotely\n'
        );
        execSync('git add -A && git commit -m "Remote task update during session"', {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });
        execSync(`git push origin ${SHADOW_BRANCH_NAME}`, {
          cwd: path.join(cloneDir, '.kspec'),
          stdio: 'pipe',
        });

        // Create sessions directory (simulates what kspec init/setup does)
        await fs.mkdir(path.join(sessionsDir, 'sessions'), { recursive: true });

        // Run shadowPull AND session write concurrently — this is the exact
        // scenario where conflicts would occur if sessions were on kspec-meta
        const sessionId = '01KJHSYNC0NFLT0000000001';
        const [pullResult] = await Promise.all([
          shadowPull(worktreeDir),
          createSession(sessionsDir, {
            id: sessionId,
            agent_type: 'ralph',
            agent_id: 'task-worker',
            trigger: 'task.ready',
            status: 'active',
            started_at: new Date().toISOString(),
          }),
          appendEvent(sessionsDir, {
            session_id: sessionId,
            type: 'session.start',
            data: { task_id: '@test-task' },
          }),
        ]);

        // shadowPull should succeed with no conflict
        expect(pullResult.success).toBe(true);
        expect(pullResult.pulled).toBe(true);
        expect(pullResult.hadConflict).toBe(false);

        // Remote change should be present in shadow worktree
        const remoteContent = await fs.readFile(
          path.join(worktreeDir, 'remote-task-update.yaml'),
          'utf-8',
        );
        expect(remoteContent).toContain('task_status: updated_remotely');

        // Session should be readable from .kspec-sessions/ (completely separate path)
        const session = await getSession(sessionsDir, sessionId);
        expect(session).toBeDefined();
        expect(session!.id).toBe(sessionId);
        expect(session!.status).toBe('active');
        expect(session!.agent_id).toBe('task-worker');

        // Verify session files are NOT in the shadow worktree
        const shadowSessionsPath = path.join(worktreeDir, 'sessions', sessionId);
        await expect(fs.access(shadowSessionsPath)).rejects.toThrow();
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true });
      }
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

    // AC: @worktree-support ac-false-positive-guard
    it('does not mistake a code worktree with kspec in the name for the shadow worktree', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: testDir, stdio: 'pipe' });
      execSync('git branch feature-branch', { cwd: testDir, stdio: 'pipe' });

      const kspecNamedWorktreeDir = path.join(testDir, 'kspec-feature');
      execSync(`git worktree add ${kspecNamedWorktreeDir} feature-branch`, {
        cwd: testDir,
        stdio: 'pipe',
      });

      const result = await detectRunningFromShadowWorktree(kspecNamedWorktreeDir);
      expect(result).toBeNull();

      execSync(`git worktree remove ${kspecNamedWorktreeDir}`, {
        cwd: testDir,
        stdio: 'pipe',
      });
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
  // AC: @package-distribution ac-4 - pre-commit hook source included in package
  describe('installShadowHook', () => {
    it('installs pre-commit hook during shadow initialization', async () => {
      // The pre-commit hook is now loaded from the package templates directory
      // (templates/hooks/pre-commit), not from the project root.
      // This test verifies that the hook from the package gets installed.

      // Initialize git repo with initial commit
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Initialize shadow - should install hook from package templates
      const result = await initializeShadow(testDir);
      expect(result.success).toBe(true);

      // Verify hook was installed to .git/hooks/pre-commit
      const installedHookPath = path.join(testDir, '.git', 'hooks', 'pre-commit');
      try {
        const hookContent = await fs.readFile(installedHookPath, 'utf-8');
        // Hook should contain the kspec-meta branch protection logic
        expect(hookContent).toContain('kspec-meta branch protection');
        expect(hookContent).toContain('KSPEC_SHADOW_COMMIT');

        // Verify hook is executable
        const stats = await fs.stat(installedHookPath);
        expect(stats.mode & 0o111).toBeGreaterThan(0); // At least one execute bit set
      } catch (err) {
        expect.fail(`Hook should be installed at ${installedHookPath}: ${err}`);
      }
    });

    it('blocks unauthorized commits to shadow branch', async () => {
      // The pre-commit hook is now loaded from the package templates directory.
      // This test verifies the hook blocks unauthorized commits to the shadow branch.

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

  // ══════════════════════════════════════════════════════════════════════════
  // Configurable Shadow Branch Tests
  // AC: @config-shadow — configurable branch name, directory, and remote
  // ══════════════════════════════════════════════════════════════════════════

  describe('Configurable Shadow Branch', () => {
    // AC: @config-shadow ac-7 — backward compat when called without config
    describe('backward compatibility (ac-7)', () => {
      it('detectShadow uses defaults when no options provided', async () => {
        // Initialize git repo
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

        // Create initial commit
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with defaults
        const result = await initializeShadow(testDir);
        expect(result.success).toBe(true);

        // detectShadow should find it with default options
        const shadow = await detectShadow(testDir);
        expect(shadow).not.toBeNull();
        expect(shadow?.branchName).toBe(SHADOW_BRANCH_NAME);
        expect(shadow?.worktreeDir).toBe(path.join(testDir, SHADOW_WORKTREE_DIR));
      });

      it('getShadowStatus uses defaults when no options provided', async () => {
        // Initialize git repo
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with defaults
        await initializeShadow(testDir);

        // getShadowStatus should work with defaults
        const status = await getShadowStatus(testDir);
        expect(status.healthy).toBe(true);
        expect(status.branchExists).toBe(true);
      });

      it('getShadowStatus reports healthy with directory name, not full path', async () => {
        // Regression: daemon was passing the full worktreeDir path (e.g. /tmp/x/.kspec)
        // as the directory option instead of the directory name (e.g. .kspec).
        // getShadowStatus joins projectRoot + directory, so a full path produced an
        // invalid path like /tmp/x//tmp/x/.kspec, causing a false unhealthy report.
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        await initializeShadow(testDir);

        // Directory name (correct) — should be healthy
        const statusWithName = await getShadowStatus(testDir, {
          directory: SHADOW_WORKTREE_DIR,
        });
        expect(statusWithName.healthy).toBe(true);

        // Full path (bug) — should NOT be healthy because path.join produces garbage
        const fullPath = path.join(testDir, SHADOW_WORKTREE_DIR);
        const statusWithFullPath = await getShadowStatus(testDir, {
          directory: fullPath,
        });
        expect(statusWithFullPath.healthy).toBe(false);
      });
    });

    // AC: @config-shadow ac-1 — custom branch name
    describe('custom branch name (ac-1)', () => {
      it('initializeShadow creates orphan branch with configured name', async () => {
        // Initialize git repo
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with custom branch name
        const customBranch = 'specs-meta';
        const result = await initializeShadow(testDir, {
          shadow: { branchName: customBranch },
        });

        expect(result.success).toBe(true);
        expect(result.branchCreated).toBe(true);

        // Verify branch was created with custom name
        const hasCustomBranch = await branchExists(testDir, customBranch);
        expect(hasCustomBranch).toBe(true);

        // Default branch should NOT exist
        const hasDefaultBranch = await branchExists(testDir, SHADOW_BRANCH_NAME);
        expect(hasDefaultBranch).toBe(false);
      });

      it('detectShadow finds shadow with custom branch name when options provided', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        const customBranch = 'my-specs';
        await initializeShadow(testDir, {
          shadow: { branchName: customBranch },
        });

        // detectShadow with same options should find it
        const shadow = await detectShadow(testDir, { branchName: customBranch });
        expect(shadow).not.toBeNull();
        expect(shadow?.branchName).toBe(customBranch);
      });
    });

    // AC: @config-shadow ac-2 — custom directory
    describe('custom worktree directory (ac-2)', () => {
      it('initializeShadow creates worktree at configured directory', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        const customDir = '.specs';
        const result = await initializeShadow(testDir, {
          shadow: { directory: customDir },
        });

        expect(result.success).toBe(true);
        expect(result.worktreeCreated).toBe(true);

        // Custom directory should exist
        const customDirPath = path.join(testDir, customDir);
        const stat = await fs.stat(customDirPath);
        expect(stat.isDirectory()).toBe(true);

        // Default directory should NOT exist
        const defaultDirPath = path.join(testDir, SHADOW_WORKTREE_DIR);
        await expect(fs.access(defaultDirPath)).rejects.toThrow();
      });

      it('gitignore is updated with configured directory name', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        const customDir = '.my-specs';
        await initializeShadow(testDir, {
          shadow: { directory: customDir },
        });

        const gitignore = await fs.readFile(path.join(testDir, '.gitignore'), 'utf-8');
        expect(gitignore).toContain(`${customDir}/`);
        expect(gitignore).not.toContain(`${SHADOW_WORKTREE_DIR}/`);
      });
    });

    // AC: @config-shadow ac-3 ac-4 ac-5 — remote type detection
    describe('remote type detection (ac-3, ac-4, ac-5)', () => {
      it('detectRemoteType identifies named remote', () => {
        expect(detectRemoteType('origin')).toBe('named');
        expect(detectRemoteType('specs-origin')).toBe('named');
        expect(detectRemoteType('upstream')).toBe('named');
      });

      it('detectRemoteType identifies local filesystem path (ac-4)', () => {
        expect(detectRemoteType('/home/user/specs.git')).toBe('path');
        expect(detectRemoteType('./local-repo')).toBe('path');
        expect(detectRemoteType('../relative/path')).toBe('path');
        expect(detectRemoteType('~/projects/specs')).toBe('path');
      });

      it('detectRemoteType identifies git URL (ac-5)', () => {
        expect(detectRemoteType('https://github.com/org/repo.git')).toBe('url');
        expect(detectRemoteType('git@github.com:org/repo.git')).toBe('url');
        expect(detectRemoteType('ssh://git@host/repo.git')).toBe('url');
      });
    });

    // AC: @config-shadow ac-6 — error with guidance when named remote doesn't exist
    describe('missing named remote error guidance (ac-6)', () => {
      it('ensureRemoteTracking returns error with guidance when named remote does not exist', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with default settings
        await initializeShadow(testDir);

        const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

        // Try to configure tracking with non-existent remote
        const result = await ensureRemoteTracking(worktreeDir, testDir, {
          remote: 'nonexistent-remote',
          remoteType: 'named',
        });

        expect(result.success).toBe(false);
        expect(result.missingRemote).toBe('nonexistent-remote');
        expect(result.guidance).toContain('nonexistent-remote');
        expect(result.guidance).toContain('git remote add');
        expect(result.guidance).toContain('kspec.config.yaml');
      });

      it('shadowPull returns error with guidance when named remote does not exist', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with default settings (no remote configured)
        await initializeShadow(testDir);

        const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);

        // Try to pull with non-existent remote configured
        const result = await shadowPull(worktreeDir, {
          remote: 'specs-origin',
          remoteType: 'named',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('specs-origin');
        expect(result.error).toContain('git remote add');
      });
    });

    // AC: @config-shadow ac-8 — custom directory detection
    describe('detectRunningFromShadowWorktree with custom directory (ac-8)', () => {
      it('detects custom worktree directory using git metadata', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        const customDir = '.my-specs';
        await initializeShadow(testDir, {
          shadow: { directory: customDir },
        });

        // Should detect when running from custom directory
        const customDirPath = path.join(testDir, customDir);
        const mainRoot = await detectRunningFromShadowWorktree(customDirPath, customDir);
        expect(mainRoot).toBe(testDir);
      });

      it('detects worktree by kspec file structure', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with unusual directory name (no "kspec" in it)
        const customDir = '.unusual-specs';
        await initializeShadow(testDir, {
          shadow: { directory: customDir },
        });

        // Should still detect it because of file structure (manifest + modules)
        const customDirPath = path.join(testDir, customDir);
        const mainRoot = await detectRunningFromShadowWorktree(customDirPath);
        expect(mainRoot).toBe(testDir);
      });
    });

    // AC: @config-shadow ac-9 — config mismatch detection
    describe('config mismatch detection (ac-9)', () => {
      it('detects mismatch when default shadow exists but config differs', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with defaults
        await initializeShadow(testDir);

        // Check for mismatch with different config
        const mismatch = await checkConfigMismatch(testDir, 'custom-branch', '.custom-dir');
        expect(mismatch.hasMismatch).toBe(true);
        expect(mismatch.branchMismatch).toBeDefined();
        expect(mismatch.branchMismatch?.detected).toBe(SHADOW_BRANCH_NAME);
        expect(mismatch.branchMismatch?.configured).toBe('custom-branch');
        expect(mismatch.directoryMismatch).toBeDefined();
        expect(mismatch.directoryMismatch?.detected).toBe(SHADOW_WORKTREE_DIR);
        expect(mismatch.directoryMismatch?.configured).toBe('.custom-dir');
        expect(mismatch.guidance).toContain('migrate');
      });

      it('returns no mismatch when config matches defaults', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // Initialize with defaults
        await initializeShadow(testDir);

        // Check for mismatch with matching config
        const mismatch = await checkConfigMismatch(testDir, SHADOW_BRANCH_NAME, SHADOW_WORKTREE_DIR);
        expect(mismatch.hasMismatch).toBe(false);
      });

      it('returns no mismatch when no shadow exists', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        // No shadow initialized
        const mismatch = await checkConfigMismatch(testDir, 'custom-branch', '.custom-dir');
        expect(mismatch.hasMismatch).toBe(false);
      });
    });

    // Combined custom branch and directory
    describe('combined custom branch and directory', () => {
      it('initializeShadow works with both custom branch and directory', async () => {
        execSync('git init', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
        await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
        execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

        const customBranch = 'project-specs';
        const customDir = '.project-specs';

        const result = await initializeShadow(testDir, {
          shadow: { branchName: customBranch, directory: customDir },
        });

        expect(result.success).toBe(true);

        // Verify custom branch
        const hasCustomBranch = await branchExists(testDir, customBranch);
        expect(hasCustomBranch).toBe(true);

        // Verify custom directory
        const customDirPath = path.join(testDir, customDir);
        const stat = await fs.stat(customDirPath);
        expect(stat.isDirectory()).toBe(true);

        // Verify worktree is valid
        expect(await isValidWorktree(customDirPath)).toBe(true);

        // detectShadow should find it with matching options
        const shadow = await detectShadow(testDir, {
          branchName: customBranch,
          directory: customDir,
        });
        expect(shadow).not.toBeNull();
        expect(shadow?.branchName).toBe(customBranch);
        expect(shadow?.worktreeDir).toBe(customDirPath);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Git Version Detection & Orphan Worktree Fallback
  // AC: @config-shadow ac-10 — fallback for git < 2.42
  // ══════════════════════════════════════════════════════════════════════════

  describe('Git Version Detection', () => {
    // AC: @config-shadow ac-10
    it('getGitVersion returns a valid version tuple', () => {
      const version = getGitVersion();
      expect(version).not.toBeNull();
      expect(version).toHaveLength(3);
      expect(version![0]).toBeGreaterThanOrEqual(1);
      expect(version![1]).toBeGreaterThanOrEqual(0);
      expect(version![2]).toBeGreaterThanOrEqual(0);
    });

    // AC: @config-shadow ac-10
    it('gitSupportsOrphanWorktree returns a boolean', () => {
      const result = gitSupportsOrphanWorktree();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('createOrphanBranchFallback (git < 2.42 compatibility)', () => {
    // AC: @config-shadow ac-10
    it('creates orphan branch and worktree without --orphan flag', async () => {
      // Initialize a git repo
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Use the fallback directly
      await createOrphanBranchFallback(testDir, 'orphan-test', '.orphan-wt');

      // Verify the branch was created
      const hasBranch = await branchExists(testDir, 'orphan-test');
      expect(hasBranch).toBe(true);

      // Verify the worktree was created and is valid
      const worktreeDir = path.join(testDir, '.orphan-wt');
      expect(await isValidWorktree(worktreeDir)).toBe(true);

      // Verify the orphan branch has no parent (orphan = first commit has no parents)
      const parents = execSync('git log --format=%P -1 orphan-test', {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(parents).toBe('');

      // Verify the orphan branch does NOT share history with main
      try {
        const mergeBase = execSync('git merge-base main orphan-test', {
          cwd: testDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        // If merge-base succeeds, branches share history — that's wrong
        expect(mergeBase).toBe('');
      } catch {
        // Expected: merge-base fails when branches share no common ancestor
      }
    });

    // AC: @config-shadow ac-10
    it('does not modify the project working tree', async () => {
      // Initialize a git repo with some content
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      await fs.writeFile(path.join(testDir, 'src.ts'), 'export const x = 1;');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Run the fallback
      await createOrphanBranchFallback(testDir, 'safe-orphan', '.safe-wt');

      // Working tree should be unchanged — only the worktree dir itself is new/untracked.
      // No modifications to existing tracked files on the main branch.
      const statusAfter = execSync('git status --porcelain', {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      // Filter out the worktree directory itself (expected to be untracked)
      const changesExcludingWorktree = statusAfter
        .split('\n')
        .filter(line => !line.includes('.safe-wt'))
        .join('\n')
        .trim();
      expect(changesExcludingWorktree).toBe('');

      // Original files should still be present and unchanged
      const readme = await fs.readFile(path.join(testDir, 'README.md'), 'utf-8');
      expect(readme).toBe('# Test');
      const src = await fs.readFile(path.join(testDir, 'src.ts'), 'utf-8');
      expect(src).toBe('export const x = 1;');

      // Current branch should still be whatever it was (not switched)
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: testDir,
        encoding: 'utf-8',
      }).trim();
      expect(currentBranch).not.toBe('safe-orphan');
    });

    // AC: @config-shadow ac-10
    it('works with custom branch names', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      await createOrphanBranchFallback(testDir, 'my-custom-specs', '.my-specs');

      expect(await branchExists(testDir, 'my-custom-specs')).toBe(true);
      expect(await isValidWorktree(path.join(testDir, '.my-specs'))).toBe(true);
    });

    // AC: @config-shadow ac-10
    it('initializeShadow produces a healthy shadow regardless of git version', async () => {
      // This test verifies end-to-end: initializeShadow → detect → status
      // It works on any git version since it exercises whatever path is chosen
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      const result = await initializeShadow(testDir, { projectName: 'Test Project' });

      expect(result.success).toBe(true);
      expect(result.branchCreated).toBe(true);
      expect(result.worktreeCreated).toBe(true);

      // Verify the result is fully healthy
      const status = await getShadowStatus(testDir);
      expect(status.healthy).toBe(true);
      expect(status.branchExists).toBe(true);
      expect(status.worktreeExists).toBe(true);
      expect(status.worktreeLinked).toBe(true);
    });

    // AC: @config-shadow ac-10
    it('cleans up temp directories on success', async () => {
      execSync('git init', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });
      await fs.writeFile(path.join(testDir, 'README.md'), '# Test');
      execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: 'pipe' });

      // Count kspec-orphan temp dirs before
      const tmpBase = require('node:os').tmpdir();
      const beforeDirs = (await fs.readdir(tmpBase))
        .filter(d => d.startsWith('kspec-orphan'));

      await createOrphanBranchFallback(testDir, 'cleanup-test', '.cleanup-wt');

      // Count after — should not increase (temp dirs cleaned up)
      const afterDirs = (await fs.readdir(tmpBase))
        .filter(d => d.startsWith('kspec-orphan'));
      expect(afterDirs.length).toBeLessThanOrEqual(beforeDirs.length);
    });
  });
});
