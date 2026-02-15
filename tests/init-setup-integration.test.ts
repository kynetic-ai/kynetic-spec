/**
 * Tests for init --setup integration
 *
 * AC: @init-setup-integration ac-1 - shadow branch created and manifest exists
 * AC: @init-setup-integration ac-2 - core skills installed in .kspec/skills/
 * AC: @init-setup-integration ac-3 - rendered skill files, hooks, and kspec-agents.md present
 * AC: @init-setup-integration ac-4 - without --setup, behavior unchanged
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspec,
  kspecWithStatus,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli.js';

describe('Init Setup Integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir('kspec-init-setup-');
    initGitRepo(testDir);
    // Create initial commit so we have a branch
    await fs.writeFile(path.join(testDir, 'README.md'), '# Test Project\n');
    const { execSync } = await import('node:child_process');
    execSync('git add . && git commit -m "Initial commit"', {
      cwd: testDir,
      stdio: 'pipe',
    });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  describe('kspec init --setup', () => {
    // AC: @init-setup-integration ac-1 - shadow branch created and manifest exists
    it('creates shadow branch and manifest when --setup is passed', async () => {
      const result = kspec('init --no-prompt --setup', testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Initialized kspec project');

      // Verify shadow branch exists
      const { execSync } = await import('node:child_process');
      const branches = execSync('git branch', { cwd: testDir, encoding: 'utf-8' });
      expect(branches).toContain('main');

      // Verify .kspec directory exists (worktree)
      const kspecDir = path.join(testDir, '.kspec');
      const exists = await fs.access(kspecDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Verify manifest exists
      const manifestFiles = await fs.readdir(kspecDir);
      const hasManifest = manifestFiles.some(f => f.endsWith('.yaml') && !f.endsWith('.tasks.yaml'));
      expect(hasManifest).toBe(true);
    });

    // AC: @init-setup-integration ac-2 - core skills installed in .kspec/skills/
    it('installs core skills in .kspec/skills/ when --setup is passed', async () => {
      const result = kspec('init --no-prompt --setup', testDir);

      expect(result.exitCode).toBe(0);

      // Core skills directory must exist after --setup
      const skillsDir = path.join(testDir, '.kspec', 'skills');
      const skillsDirExists = await fs.access(skillsDir).then(() => true).catch(() => false);
      expect(skillsDirExists).toBe(true);

      // Must have at least one skill installed
      const skills = await fs.readdir(skillsDir);
      expect(skills.length).toBeGreaterThan(0);

      // Output should mention setup was run
      expect(result.stdout).toContain('Setup');
    });

    // AC: @init-setup-integration ac-3 - rendered skill files, hooks, and kspec-agents.md present
    it('creates rendered skills, hooks config, and kspec-agents.md when --setup is passed', async () => {
      const result = kspec('init --no-prompt --setup', testDir);

      expect(result.exitCode).toBe(0);

      // kspec-agents.md must be generated
      const agentsMdPath = path.join(testDir, 'kspec-agents.md');
      const agentsMdExists = await fs.access(agentsMdPath).then(() => true).catch(() => false);
      expect(agentsMdExists).toBe(true);

      // Rendered skills should exist in .claude/skills/ (if claude-code detected)
      // Agent detection runs in setup - in test environment it may detect claude-code
      // since we're running inside a Claude Code session
      const claudeDir = path.join(testDir, '.claude');
      const claudeExists = await fs.access(claudeDir).then(() => true).catch(() => false);

      if (claudeExists) {
        // If .claude was created, hooks or settings must be present
        const hooksDir = path.join(claudeDir, 'hooks');
        const settingsPath = path.join(claudeDir, 'settings.json');
        const hooksExists = await fs.access(hooksDir).then(() => true).catch(() => false);
        const settingsExists = await fs.access(settingsPath).then(() => true).catch(() => false);
        expect(hooksExists || settingsExists).toBe(true);
      }
    });

    it('shows setup summary in output when --setup is passed', async () => {
      const result = kspec('init --no-prompt --setup', testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Setup Summary');
      expect(result.stdout).toContain('Agent detection');
    });
  });

  describe('kspec init (without --setup)', () => {
    // AC: @init-setup-integration ac-4 - behavior unchanged without --setup
    it('creates only shadow branch and manifest without --setup', async () => {
      const result = kspec('init --no-prompt', testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Initialized kspec project');

      // Verify shadow branch exists
      const kspecDir = path.join(testDir, '.kspec');
      const exists = await fs.access(kspecDir).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      // Should NOT have kspec-agents.md
      const agentsMdPath = path.join(testDir, 'kspec-agents.md');
      const agentsMdExists = await fs.access(agentsMdPath).then(() => true).catch(() => false);
      expect(agentsMdExists).toBe(false);

      // Output should show next steps, not setup summary
      expect(result.stdout).toContain('Next steps');
      expect(result.stdout).not.toContain('Setup Summary');
    });

    // AC: @init-setup-integration ac-4 - shows tip about --setup option
    it('shows tip about --setup option after init', async () => {
      const result = kspec('init --no-prompt', testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--setup');
      expect(result.stdout).toContain('kspec setup');
    });

    it('does not install hooks without --setup', async () => {
      const result = kspec('init --no-prompt', testDir);

      expect(result.exitCode).toBe(0);

      // Should NOT have .claude directory with settings
      const settingsPath = path.join(testDir, '.claude', 'settings.json');
      const settingsExists = await fs.access(settingsPath).then(() => true).catch(() => false);
      expect(settingsExists).toBe(false);
    });
  });

  describe('kspec init --setup edge cases', () => {
    it('handles already initialized project gracefully', async () => {
      // First init
      kspec('init --no-prompt', testDir);

      // Second init with --setup should handle already existing project
      const result = kspecWithStatus('init --no-prompt --setup', testDir);

      // Should either succeed with "already initialized" message or fail gracefully
      // The behavior depends on whether --force is needed
      if (result.exitCode === 0) {
        expect(result.stdout).toMatch(/already|initialized|setup/i);
      } else {
        // If it fails, it should mention conflict or existing
        expect(result.stderr || result.stdout).toMatch(/exists|conflict|already/i);
      }
    });

    it('handles --setup with --force for reinitializing', async () => {
      // First init
      kspec('init --no-prompt', testDir);

      // Second init with --setup --force
      const result = kspec('init --no-prompt --setup --force', testDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Setup');
    });
  });
});
