import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { getDiffSince, getRecentCommits, isGitRepo, getCurrentBranch } from '../src/utils/git.js';

describe('Git utilities', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Create temporary directory for test git repo
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-git-test-'));

    // Initialize git repo
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('isGitRepo', () => {
    it('should return true for git repository', () => {
      expect(isGitRepo(tmpDir)).toBe(true);
    });

    it('should return false for non-git directory', async () => {
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-non-git-'));
      try {
        expect(isGitRepo(nonGitDir)).toBe(false);
      } finally {
        await fs.rm(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch name', () => {
      // Git init creates 'main' or 'master' depending on config, but we can create a commit to establish branch
      execSync('git commit --allow-empty -m "Initial commit"', { cwd: tmpDir, stdio: 'ignore' });
      const branch = getCurrentBranch(tmpDir);
      expect(branch).toBeTruthy();
      expect(typeof branch).toBe('string');
    });
  });

  describe('getDiffSince', () => {
    it('should return null when no changes exist', () => {
      // Empty repo with no commits
      const result = getDiffSince(new Date(), tmpDir);
      expect(result).toBeNull();
    });

    it('should return diff from beginning when no commits before timestamp', async () => {
      // Create a file and commit it
      await fs.writeFile(path.join(tmpDir, 'test.txt'), 'content');
      execSync('git add test.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Add test file"', { cwd: tmpDir, stdio: 'ignore' });

      // Get diff since far in the past (before any commits)
      const veryOldDate = new Date('2000-01-01');
      const result = getDiffSince(veryOldDate, tmpDir);

      expect(result).toBeTruthy();
      expect(result).toContain('test.txt');
      expect(result).toContain('content');
    });

    it('should return diff since specific timestamp', async () => {
      // Create initial commit
      await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'initial');
      execSync('git add file1.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Initial commit"', { cwd: tmpDir, stdio: 'ignore' });

      // Wait 2 seconds to ensure timestamp difference (git log --before uses second precision)
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const timestampBetween = new Date();
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Create another commit after timestamp
      await fs.writeFile(path.join(tmpDir, 'file2.txt'), 'new content');
      execSync('git add file2.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Add file2"', { cwd: tmpDir, stdio: 'ignore' });

      const result = getDiffSince(timestampBetween, tmpDir);

      expect(result).toBeTruthy();
      expect(result).toContain('file2.txt');
      expect(result).toContain('new content');
      // Should NOT contain file1 since it was committed before timestamp
      expect(result).not.toContain('file1.txt');
    });

    it('should include uncommitted changes in diff', async () => {
      // Create initial commit
      await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'initial');
      execSync('git add file1.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Initial commit"', { cwd: tmpDir, stdio: 'ignore' });

      const timestampBefore = new Date();
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Create uncommitted change (staged but not committed)
      await fs.writeFile(path.join(tmpDir, 'file2.txt'), 'uncommitted');
      execSync('git add file2.txt', { cwd: tmpDir, stdio: 'ignore' });

      const result = getDiffSince(timestampBefore, tmpDir);

      expect(result).toBeTruthy();
      expect(result).toContain('file2.txt');
      expect(result).toContain('uncommitted');
    });

    it('should combine committed and uncommitted changes', async () => {
      // Create initial commit
      await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'initial');
      execSync('git add file1.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Initial commit"', { cwd: tmpDir, stdio: 'ignore' });

      const timestampBefore = new Date();
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Create committed change
      await fs.writeFile(path.join(tmpDir, 'file2.txt'), 'committed');
      execSync('git add file2.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Add file2"', { cwd: tmpDir, stdio: 'ignore' });

      // Create uncommitted change (staged but not committed)
      await fs.writeFile(path.join(tmpDir, 'file3.txt'), 'uncommitted');
      execSync('git add file3.txt', { cwd: tmpDir, stdio: 'ignore' });

      const result = getDiffSince(timestampBefore, tmpDir);

      expect(result).toBeTruthy();
      expect(result).toContain('file2.txt');
      expect(result).toContain('committed');
      expect(result).toContain('file3.txt');
      expect(result).toContain('uncommitted');
    });

    it('should return null when timestamp is after all commits and no working changes', async () => {
      // Create a commit
      await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'content');
      execSync('git add file1.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Add file"', { cwd: tmpDir, stdio: 'ignore' });

      // Get diff since future date
      const futureDate = new Date(Date.now() + 1000 * 60 * 60); // 1 hour in future
      const result = getDiffSince(futureDate, tmpDir);

      expect(result).toBeNull();
    });
  });

  describe('getRecentCommits', () => {
    it('should return empty array for repo with no commits', () => {
      const commits = getRecentCommits({ cwd: tmpDir });
      expect(commits).toEqual([]);
    });

    it('should return recent commits', async () => {
      // Create some commits
      await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'content1');
      execSync('git add file1.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "First commit"', { cwd: tmpDir, stdio: 'ignore' });

      await fs.writeFile(path.join(tmpDir, 'file2.txt'), 'content2');
      execSync('git add file2.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "Second commit"', { cwd: tmpDir, stdio: 'ignore' });

      const commits = getRecentCommits({ cwd: tmpDir, limit: 5 });

      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe('Second commit');
      expect(commits[1].message).toBe('First commit');
      expect(commits[0].author).toBe('Test User');
    });

    it('should respect limit parameter', async () => {
      // Create multiple commits
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(tmpDir, `file${i}.txt`), `content${i}`);
        execSync(`git add file${i}.txt`, { cwd: tmpDir, stdio: 'ignore' });
        execSync(`git commit -m "Commit ${i}"`, { cwd: tmpDir, stdio: 'ignore' });
      }

      const commits = getRecentCommits({ cwd: tmpDir, limit: 3 });
      expect(commits.length).toBe(3);
    });
  });
});
