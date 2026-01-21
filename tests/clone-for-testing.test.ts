/**
 * E2E tests for kspec clone-for-testing command.
 *
 * Tests all 5 acceptance criteria with proper test isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  git,
  initGitRepo,
} from './helpers/cli';
import * as os from 'node:os';

describe('Integration: clone-for-testing', () => {
  let tempDir: string;
  let sourceRepo: string;

  beforeEach(async () => {
    // Create a source repo with kspec setup in temp directory
    tempDir = await setupTempFixtures();
    sourceRepo = tempDir;

    // Ensure git repo is initialized
    initGitRepo(sourceRepo);

    // Create and commit a test file to ensure repo has content
    const testFile = path.join(sourceRepo, 'test.txt');
    fs.writeFileSync(testFile, 'test content');
    git('add test.txt', sourceRepo);
    git('commit -m "Initial commit"', sourceRepo);

    // Create kspec-meta branch if it doesn't exist
    try {
      git('checkout -b kspec-meta', sourceRepo);
      const kspecFile = path.join(sourceRepo, 'test-meta.yaml');
      fs.writeFileSync(kspecFile, 'meta: true');
      git('add test-meta.yaml', sourceRepo);
      git('commit -m "Add meta"', sourceRepo);
      git('checkout main', sourceRepo);
    } catch (err) {
      // Branch might already exist, switch back to main
      try {
        git('checkout main', sourceRepo);
      } catch {
        // Ignore
      }
    }
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-clone-for-testing ac-1
  it('should create isolated copy of source repo', () => {
    const dest = path.join(os.tmpdir(), `clone-test-${Date.now()}`);

    try {
      // Clone the repo - run from temp dir, not source repo
      const output = kspec(`clone-for-testing ${dest} ${sourceRepo}`, tempDir);

      // Should report success
      expect(output).toContain(dest);

      // Destination should exist
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.existsSync(path.join(dest, '.git'))).toBe(true);

      // Should have the test file
      expect(fs.existsSync(path.join(dest, 'test.txt'))).toBe(true);

      // Should not have remote origin (isolation)
      const remotes = execSync('git remote', { cwd: dest, encoding: 'utf-8' });
      expect(remotes.trim()).toBe('');

      // Should have all branches including kspec-meta
      const branches = execSync('git branch -a', { cwd: dest, encoding: 'utf-8' });
      expect(branches).toContain('kspec-meta');
    } finally {
      // Cleanup
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  });

  // AC: @cmd-clone-for-testing ac-2
  it('should setup .kspec worktree when kspec-meta branch exists', () => {
    const dest = path.join(os.tmpdir(), `clone-test-${Date.now()}`);

    try {
      // Clone the repo
      kspec(`clone-for-testing ${dest} ${sourceRepo}`);

      // Worktree should exist
      expect(fs.existsSync(path.join(dest, '.kspec'))).toBe(true);

      // Worktree should be linked to kspec-meta
      const worktreeList = execSync('git worktree list', { cwd: dest, encoding: 'utf-8' });
      expect(worktreeList).toContain('.kspec');
      expect(worktreeList).toContain('kspec-meta');

      // Worktree should have the meta file
      expect(fs.existsSync(path.join(dest, '.kspec', 'test-meta.yaml'))).toBe(true);
    } finally {
      // Cleanup
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  });

  // AC: @cmd-clone-for-testing ac-2 (negative case)
  it('should not fail when kspec-meta branch does not exist', () => {
    // Create a source repo WITHOUT kspec-meta
    const noMetaRepo = path.join(os.tmpdir(), `no-meta-${Date.now()}`);
    fs.mkdirSync(noMetaRepo, { recursive: true });

    try {
      // Initialize git repo
      initGitRepo(noMetaRepo);

      // Create and commit a file
      fs.writeFileSync(path.join(noMetaRepo, 'readme.txt'), 'test');
      execSync('git add readme.txt', { cwd: noMetaRepo });
      execSync('git commit -m "Initial"', { cwd: noMetaRepo });

      const dest = path.join(os.tmpdir(), `clone-test-${Date.now()}`);

      try {
        // Clone should succeed - run from temp dir
        const output = kspec(`clone-for-testing ${dest} ${noMetaRepo}`, tempDir);
        expect(output).toContain(dest);

        // Destination should exist
        expect(fs.existsSync(dest)).toBe(true);

        // But no .kspec worktree should exist
        expect(fs.existsSync(path.join(dest, '.kspec'))).toBe(false);
      } finally {
        if (fs.existsSync(dest)) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
      }
    } finally {
      if (fs.existsSync(noMetaRepo)) {
        fs.rmSync(noMetaRepo, { recursive: true, force: true });
      }
    }
  });

  // AC: @cmd-clone-for-testing ac-3
  it('should checkout specified branch when --branch flag provided', () => {
    // Create a feature branch in source repo
    git('checkout -b feature-test', sourceRepo);
    const featureFile = path.join(sourceRepo, 'feature.txt');
    fs.writeFileSync(featureFile, 'feature content');
    git('add feature.txt', sourceRepo);
    git('commit -m "Add feature"', sourceRepo);
    git('checkout main', sourceRepo);

    const dest = path.join(os.tmpdir(), `clone-test-${Date.now()}`);

    try {
      // Clone with --branch flag - run from temp dir
      const output = kspec(`clone-for-testing ${dest} ${sourceRepo} --branch feature-test`, tempDir);

      expect(output).toContain('feature-test');

      // Should be on feature-test branch
      const currentBranch = execSync('git branch --show-current', {
        cwd: dest,
        encoding: 'utf-8',
      }).trim();
      expect(currentBranch).toBe('feature-test');

      // Should have the feature file
      expect(fs.existsSync(path.join(dest, 'feature.txt'))).toBe(true);
    } finally {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  });

  // AC: @cmd-clone-for-testing ac-4
  it('should create clone in system temp directory when no dest provided', () => {
    let clonedPath = '';

    try {
      // Clone without dest argument (will use temp dir) - specify source
      const output = kspec(`clone-for-testing '' ${sourceRepo}`, tempDir);

      // Output should contain the temp path
      expect(output).toContain('tmp');
      expect(output).toContain('kspec-test-');

      // Extract the path from output
      const match = output.match(/Created test repo at: (.+)/);
      expect(match).toBeTruthy();
      clonedPath = match![1].trim();

      // Path should be in temp directory
      expect(clonedPath).toContain(os.tmpdir());

      // Clone should exist and be valid
      expect(fs.existsSync(clonedPath)).toBe(true);
      expect(fs.existsSync(path.join(clonedPath, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(clonedPath, 'test.txt'))).toBe(true);
    } finally {
      if (clonedPath && fs.existsSync(clonedPath)) {
        fs.rmSync(clonedPath, { recursive: true, force: true });
      }
    }
  });

  // AC: @cmd-clone-for-testing ac-5
  it('should output JSON with path and branch when --json flag provided', () => {
    const dest = path.join(os.tmpdir(), `clone-test-${Date.now()}`);

    try {
      // Clone with global --json flag (added by kspecJson helper)
      const result = kspecJson<{ path: string; branch: string }>(
        `clone-for-testing ${dest} ${sourceRepo}`,
        tempDir
      );

      // Should return raw JSON object (not wrapped)
      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('branch');
      expect(result.path).toBe(dest);
      expect(result.branch).toBe('main');

      // Clone should actually exist
      expect(fs.existsSync(dest)).toBe(true);
    } finally {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  });

  // AC: @cmd-clone-for-testing ac-5 (with branch)
  it('should output correct branch in JSON when --branch flag used', () => {
    // Create a feature branch
    git('checkout -b feature-json', sourceRepo);
    git('checkout main', sourceRepo);

    const dest = path.join(os.tmpdir(), `clone-test-${Date.now()}`);

    try {
      // Clone with --branch and global --json flag (added by kspecJson helper)
      const result = kspecJson<{ path: string; branch: string }>(
        `clone-for-testing ${dest} ${sourceRepo} --branch feature-json`,
        tempDir
      );

      expect(result.path).toBe(dest);
      expect(result.branch).toBe('feature-json');

      // Verify branch is actually checked out
      const currentBranch = execSync('git branch --show-current', {
        cwd: dest,
        encoding: 'utf-8',
      }).trim();
      expect(currentBranch).toBe('feature-json');
    } finally {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  });

  it('should default source to current repo when not provided', () => {
    const dest = path.join(os.tmpdir(), `clone-test-${Date.now()}`);

    try {
      // Run from within source repo using test helper
      const output = kspec(`clone-for-testing ${dest}`, sourceRepo);

      expect(output).toContain(dest);

      // Clone should exist and have same content as source
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.existsSync(path.join(dest, 'test.txt'))).toBe(true);
    } finally {
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
  });
});
