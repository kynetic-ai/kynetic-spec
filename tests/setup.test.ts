import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { SHADOW_BRANCH_NAME, SHADOW_WORKTREE_DIR } from '../src/parser/shadow.js';

describe('kspec setup', () => {
  const testDir = path.join('/tmp', `kspec-setup-test-${Date.now()}`);
  const kspecBin = path.join(process.cwd(), 'dist', 'cli', 'index.js');

  beforeEach(async () => {
    // Clean up any previous test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Doesn't exist, that's fine
    }
    await fs.mkdir(testDir, { recursive: true });

    // Initialize a git repo
    execSync('git init', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: testDir, stdio: 'pipe' });

    // Create initial commit on 'main' branch
    await fs.writeFile(path.join(testDir, 'README.md'), '# Test Project', 'utf-8');
    execSync('git add README.md', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: 'pipe' });
    // Rename default branch to 'main' for consistency across git versions
    execSync('git branch -M main', { cwd: testDir, stdio: 'pipe' });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  });

  // AC: worktree-already-exists
  it('should skip worktree creation when .kspec worktree already exists', async () => {
    // Create kspec-meta branch with worktree
    execSync(`git worktree add --orphan -b ${SHADOW_BRANCH_NAME} ${SHADOW_WORKTREE_DIR}`, {
      cwd: testDir,
      stdio: 'pipe',
    });

    // Create a manifest file in the worktree
    const manifestPath = path.join(testDir, SHADOW_WORKTREE_DIR, 'test.yaml');
    await fs.writeFile(manifestPath, 'kynetic: "1.0"\n', 'utf-8');

    // Run kspec setup with dry-run to avoid actual agent config
    // Set CLAUDECODE=1 to simulate Claude Code environment (so agent detection works)
    const result = spawnSync('node', [kspecBin, 'setup', '--dry-run'], {
      cwd: testDir,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: '1' },
    });

    // Should succeed without prompting for worktree creation
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Create it?');
    expect(result.stdout).toContain('Would configure:');
  });

  // AC: auto-worktree-flag
  it('should automatically create .kspec worktree with --auto-worktree flag', async () => {
    // Create kspec-meta branch without worktree
    execSync(`git checkout --orphan ${SHADOW_BRANCH_NAME}`, { cwd: testDir, stdio: 'pipe' });
    execSync('git rm -rf .', { cwd: testDir, stdio: 'pipe' });

    // Create a manifest file
    await fs.writeFile(path.join(testDir, 'test.yaml'), 'kynetic: "1.0"\n', 'utf-8');
    execSync('git add test.yaml', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initialize shadow"', { cwd: testDir, stdio: 'pipe' });

    // Switch back to main
    execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });

    // Verify worktree doesn't exist yet
    const worktreePath = path.join(testDir, SHADOW_WORKTREE_DIR);
    let worktreeExists = false;
    try {
      await fs.access(worktreePath);
      worktreeExists = true;
    } catch {
      // Expected - doesn't exist yet
    }
    expect(worktreeExists).toBe(false);

    // Run kspec setup with --auto-worktree and --dry-run
    const result = spawnSync('node', [kspecBin, 'setup', '--auto-worktree', '--dry-run'], {
      cwd: testDir,
      encoding: 'utf-8',
    });

    // Should succeed and create worktree without prompting
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Detected kspec-meta branch without .kspec worktree');
    expect(result.stdout).toContain('Created .kspec worktree');
    expect(result.stdout).not.toContain('Create it?');

    // Verify worktree was created
    try {
      await fs.access(worktreePath);
      worktreeExists = true;
    } catch {
      worktreeExists = false;
    }
    expect(worktreeExists).toBe(true);
  });

  // AC: detect-existing-repo
  it('should prompt to create worktree when kspec-meta exists but .kspec does not', async () => {
    // Create kspec-meta branch without worktree
    execSync(`git checkout --orphan ${SHADOW_BRANCH_NAME}`, { cwd: testDir, stdio: 'pipe' });
    execSync('git rm -rf .', { cwd: testDir, stdio: 'pipe' });

    // Create a manifest file
    await fs.writeFile(path.join(testDir, 'test.yaml'), 'kynetic: "1.0"\n', 'utf-8');
    execSync('git add test.yaml', { cwd: testDir, stdio: 'pipe' });
    execSync('git commit -m "Initialize shadow"', { cwd: testDir, stdio: 'pipe' });

    // Switch back to main
    execSync('git checkout main', { cwd: testDir, stdio: 'pipe' });

    // Run kspec setup without --auto-worktree, provide 'n' as input to decline
    const result = spawnSync('node', [kspecBin, 'setup', '--dry-run'], {
      cwd: testDir,
      encoding: 'utf-8',
      input: 'n\n', // Decline worktree creation
    });

    // Should prompt with the expected message
    expect(result.stdout).toContain(`${SHADOW_BRANCH_NAME} branch exists but .kspec worktree is missing. Create it?`);
    expect(result.status).toBe(1); // Exit with error since user declined
  });
});
