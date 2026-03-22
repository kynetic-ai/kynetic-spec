import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  initializeShadow,
  SHADOW_WORKTREE_DIR,
  SESSIONS_WORKTREE_DIR,
  TRANSIENT_PLANS_DIR,
  ensurePlansGitignore,
  ensureSessionsGitignore,
  ensureShadowSessionsGitignore,
  needsPlansGitignore,
  needsSessionsGitignore,
  needsShadowSessionsGitignore,
} from '../src/parser/shadow.js';

// Check if git supports --orphan worktree (requires >= 2.42)
const canRunInitTests = (() => {
  try {
    const version = execSync('git --version', { encoding: 'utf-8' }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    return major > 2 || (major === 2 && minor >= 42);
  } catch {
    return false;
  }
})();

describe('Init/Setup Sessions Directory', () => {
  const testDir = path.join('/tmp', `kspec-sessions-dir-test-${Date.now()}`);

  beforeEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Doesn't exist
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

  function initGit(dir: string): void {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    execSync('git branch -M main', { cwd: dir, stdio: 'pipe' });
  }

  function initialCommit(dir: string): void {
    execSync('echo "# Test" > README.md && git add README.md && git commit -m "initial"', {
      cwd: dir,
      stdio: 'pipe',
    });
  }

  describe('ensureSessionsGitignore', () => {
    // AC: @session-storage-modes ac-gitignore
    it('adds .kspec-sessions/ to root .gitignore', async () => {
      initGit(testDir);
      initialCommit(testDir);

      const result = await ensureSessionsGitignore(testDir);

      expect(result).toBe(true);
      const content = await fs.readFile(path.join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.kspec-sessions/');
    });

    // AC: @session-storage-modes ac-gitignore
    it('is idempotent — does not add duplicate entries', async () => {
      initGit(testDir);
      initialCommit(testDir);

      const result1 = await ensureSessionsGitignore(testDir);
      expect(result1).toBe(true);

      const result2 = await ensureSessionsGitignore(testDir);
      expect(result2).toBe(false);

      const content = await fs.readFile(path.join(testDir, '.gitignore'), 'utf-8');
      const matches = content.split('\n').filter((l) => l.trim() === '.kspec-sessions/');
      expect(matches).toHaveLength(1);
    });

    // AC: @session-storage-modes ac-gitignore
    it('creates .gitignore if it does not exist', async () => {
      initGit(testDir);
      initialCommit(testDir);

      // Remove .gitignore if it exists
      try {
        await fs.unlink(path.join(testDir, '.gitignore'));
      } catch {
        // Doesn't exist
      }

      const result = await ensureSessionsGitignore(testDir);

      expect(result).toBe(true);
      const content = await fs.readFile(path.join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain('.kspec-sessions/');
    });

    // AC: @session-storage-modes ac-gitignore
    it('detects various existing patterns as already present', async () => {
      initGit(testDir);
      initialCommit(testDir);

      // Write .gitignore with the entry in a different format
      await fs.writeFile(path.join(testDir, '.gitignore'), '/.kspec-sessions/\n', 'utf-8');

      const result = await ensureSessionsGitignore(testDir);
      expect(result).toBe(false);
    });
  });

  describe('ensurePlansGitignore', () => {
    it('adds plans/ to root .gitignore', async () => {
      initGit(testDir);
      initialCommit(testDir);

      const result = await ensurePlansGitignore(testDir);

      expect(result).toBe(true);
      const content = await fs.readFile(path.join(testDir, '.gitignore'), 'utf-8');
      expect(content).toContain(`${TRANSIENT_PLANS_DIR}/`);
    });

    it('is idempotent — does not add duplicate entries', async () => {
      initGit(testDir);
      initialCommit(testDir);

      const result1 = await ensurePlansGitignore(testDir);
      expect(result1).toBe(true);

      const result2 = await ensurePlansGitignore(testDir);
      expect(result2).toBe(false);

      const content = await fs.readFile(path.join(testDir, '.gitignore'), 'utf-8');
      const matches = content.split('\n').filter((l) => l.trim() === `${TRANSIENT_PLANS_DIR}/`);
      expect(matches).toHaveLength(1);
    });

    it('detects various existing patterns as already present', async () => {
      initGit(testDir);
      initialCommit(testDir);

      await fs.writeFile(path.join(testDir, '.gitignore'), '/plans/\n', 'utf-8');

      const result = await ensurePlansGitignore(testDir);
      expect(result).toBe(false);
    });
  });

  describe('needsSessionsGitignore', () => {
    it('returns true when .gitignore does not exist', async () => {
      const result = await needsSessionsGitignore(testDir);
      expect(result).toBe(true);
    });

    it('returns true when entry is not present', async () => {
      await fs.writeFile(path.join(testDir, '.gitignore'), 'node_modules/\n', 'utf-8');
      const result = await needsSessionsGitignore(testDir);
      expect(result).toBe(true);
    });

    it('returns false when entry already present', async () => {
      await fs.writeFile(path.join(testDir, '.gitignore'), '.kspec-sessions/\n', 'utf-8');
      const result = await needsSessionsGitignore(testDir);
      expect(result).toBe(false);
    });
  });

  describe('needsPlansGitignore', () => {
    it('returns true when .gitignore does not exist', async () => {
      const result = await needsPlansGitignore(testDir);
      expect(result).toBe(true);
    });

    it('returns true when entry is not present', async () => {
      await fs.writeFile(path.join(testDir, '.gitignore'), 'node_modules/\n', 'utf-8');
      const result = await needsPlansGitignore(testDir);
      expect(result).toBe(true);
    });

    it('returns false when entry already present', async () => {
      await fs.writeFile(path.join(testDir, '.gitignore'), 'plans/\n', 'utf-8');
      const result = await needsPlansGitignore(testDir);
      expect(result).toBe(false);
    });
  });

  describe('ensureShadowSessionsGitignore', () => {
    // AC: @session-legacy-migration ac-shadow-gitignore
    it('adds sessions/ to .kspec/.gitignore', async () => {
      initGit(testDir);
      initialCommit(testDir);

      // Create a .kspec directory with an existing .gitignore
      const kspecDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await fs.mkdir(kspecDir, { recursive: true });
      await fs.writeFile(path.join(kspecDir, '.gitignore'), 'artifacts/\n', 'utf-8');

      const result = await ensureShadowSessionsGitignore(testDir);

      expect(result).toBe(true);
      const content = await fs.readFile(path.join(kspecDir, '.gitignore'), 'utf-8');
      expect(content).toContain('sessions/');
      expect(content).toContain('artifacts/');
    });

    // AC: @session-legacy-migration ac-shadow-gitignore
    it('is idempotent', async () => {
      const kspecDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await fs.mkdir(kspecDir, { recursive: true });
      await fs.writeFile(path.join(kspecDir, '.gitignore'), 'artifacts/\n', 'utf-8');

      await ensureShadowSessionsGitignore(testDir);
      const result2 = await ensureShadowSessionsGitignore(testDir);

      expect(result2).toBe(false);
    });

    it('returns false when .kspec/.gitignore does not exist', async () => {
      const result = await ensureShadowSessionsGitignore(testDir);
      expect(result).toBe(false);
    });
  });

  describe('needsShadowSessionsGitignore', () => {
    it('returns true when sessions/ not in .kspec/.gitignore', async () => {
      const kspecDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await fs.mkdir(kspecDir, { recursive: true });
      await fs.writeFile(path.join(kspecDir, '.gitignore'), 'artifacts/\n', 'utf-8');

      const result = await needsShadowSessionsGitignore(testDir);
      expect(result).toBe(true);
    });

    it('returns false when sessions/ already present', async () => {
      const kspecDir = path.join(testDir, SHADOW_WORKTREE_DIR);
      await fs.mkdir(kspecDir, { recursive: true });
      await fs.writeFile(path.join(kspecDir, '.gitignore'), 'artifacts/\nsessions/\n', 'utf-8');

      const result = await needsShadowSessionsGitignore(testDir);
      expect(result).toBe(false);
    });

    it('returns false when .kspec/.gitignore does not exist', async () => {
      const result = await needsShadowSessionsGitignore(testDir);
      expect(result).toBe(false);
    });
  });

  describe('initializeShadow — sessions directory', () => {
    // AC: @session-storage-modes ac-sessions-dir-autocreate
    it.skipIf(!canRunInitTests)(
      'creates .kspec-sessions/ directory during init',
      async () => {
        initGit(testDir);
        initialCommit(testDir);

        const result = await initializeShadow(testDir, { projectName: 'Test Project' });

        expect(result.success).toBe(true);
        expect(result.sessionsDirectoryCreated).toBe(true);

        const sessionsDir = path.join(testDir, SESSIONS_WORKTREE_DIR);
        const stat = await fs.stat(sessionsDir);
        expect(stat.isDirectory()).toBe(true);
      },
    );

    // AC: @session-storage-modes ac-gitignore
    it.skipIf(!canRunInitTests)(
      'adds .kspec-sessions/ to root .gitignore during init',
      async () => {
        initGit(testDir);
        initialCommit(testDir);

        await initializeShadow(testDir, { projectName: 'Test Project' });

        const content = await fs.readFile(path.join(testDir, '.gitignore'), 'utf-8');
        expect(content).toContain('.kspec-sessions/');
        expect(content).toContain('plans/');
        expect(content).toContain('.kspec/');
      },
    );

    // AC: @session-legacy-migration ac-shadow-gitignore
    it.skipIf(!canRunInitTests)(
      'adds sessions/ to .kspec/.gitignore during init',
      async () => {
        initGit(testDir);
        initialCommit(testDir);

        await initializeShadow(testDir, { projectName: 'Test Project' });

        const shadowGitignore = await fs.readFile(
          path.join(testDir, SHADOW_WORKTREE_DIR, '.gitignore'),
          'utf-8',
        );
        expect(shadowGitignore).toContain('sessions/');
        expect(shadowGitignore).toContain('artifacts/');
      },
    );

    // AC: @session-storage-modes ac-sessions-dir
    it.skipIf(!canRunInitTests)(
      '.kspec-sessions/ is separate from .kspec/ worktree',
      async () => {
        initGit(testDir);
        initialCommit(testDir);

        await initializeShadow(testDir, { projectName: 'Test Project' });

        const sessionsDir = path.join(testDir, SESSIONS_WORKTREE_DIR);
        const kspecDir = path.join(testDir, SHADOW_WORKTREE_DIR);

        // Both should exist
        expect((await fs.stat(sessionsDir)).isDirectory()).toBe(true);
        expect((await fs.stat(kspecDir)).isDirectory()).toBe(true);

        // Sessions dir should NOT be inside .kspec/
        expect(sessionsDir).not.toContain(kspecDir + '/');
        expect(path.dirname(sessionsDir)).toBe(testDir);
        expect(path.dirname(kspecDir)).toBe(testDir);
      },
    );
  });
});
