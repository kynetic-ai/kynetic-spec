/**
 * Tests for Core Skill Update
 * AC: @core-skill-update ac-1 through ac-3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspec as kspecFull,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Core Skill Update', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @core-skill-update ac-1
  describe('ac-1: Skill content and version updated when version differs', () => {
    it('should update skill version when package version differs', async () => {
      // Install core skills
      kspecFull('skill install-core', tempDir);

      // Get current version
      const { getKspecPackageVersion } = await import('../src/cli/commands/skill.js');
      const packageVersion = await getKspecPackageVersion();

      // Manually set skill to an older version
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      // Verify version changed
      let skills = kspecJson<{ id: string; version?: string }[]>('skill list', tempDir);
      expect(skills.find((s) => s.id === 'help')?.version).toBe('0.0.1');

      // Run update
      const result = kspecFull('skill update', tempDir);
      expect(result.stdout).toContain('Updated');
      expect(result.stdout).toContain('help');
      expect(result.stdout).toContain('0.0.1');
      expect(result.stdout).toContain(packageVersion);

      // Verify version is now package version
      skills = kspecJson<{ id: string; version?: string }[]>('skill list', tempDir);
      expect(skills.find((s) => s.id === 'help')?.version).toBe(packageVersion);
    });

    it('should update SKILL.md content when version differs', async () => {
      // Install core skills
      kspecFull('skill install-core', tempDir);

      // Manually set skill to an older version
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      // Modify SKILL.md content
      const skillMdPath = path.join(tempDir, 'skills', 'help', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Old Content\n\nThis is old content.\n', 'utf-8');

      // Run update
      kspecFull('skill update', tempDir);

      // Verify content was restored from templates
      const content = await fs.readFile(skillMdPath, 'utf-8');
      expect(content).toContain('# kspec Help');
      expect(content).not.toContain('Old Content');
    });

    it('should show version transition in output', async () => {
      kspecFull('skill install-core', tempDir);
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      const result = kspecFull('skill update', tempDir);

      // Should show "0.0.1 → X.Y.Z"
      expect(result.stdout).toMatch(/0\.0\.1\s*→\s*\d+\.\d+\.\d+/);
    });

    // AC: @core-skill-update ac-1
    it('should update supporting directories when version differs', async () => {
      kspecFull('skill install-core', tempDir);

      // Set triage to older version so update picks it up
      kspecFull('skill set @triage --skill-version 0.0.1', tempDir);

      // Delete a docs file to simulate stale content
      const inboxPath = path.join(tempDir, 'skills', 'triage', 'docs', 'inbox.md');
      await fs.unlink(inboxPath);

      // Run update
      kspecFull('skill update', tempDir);

      // Verify docs were restored
      const content = await fs.readFile(inboxPath, 'utf-8');
      expect(content).toContain('Inbox Triage');
    });
  });

  // AC: @core-skill-update ac-2
  describe('ac-2: Skill skipped when already at current version', () => {
    it('should skip skills already at current package version', async () => {
      // Install core skills (will have current package version)
      kspecFull('skill install-core', tempDir);

      // Run update - should skip because version already matches
      const result = kspecFull('skill update', tempDir);

      expect(result.stdout).toContain('Skipped');
      expect(result.stdout).toContain('help');
      expect(result.stdout).toContain('already at current version');
    });

    it('should not show "Updated" when all skills are current', async () => {
      kspecFull('skill install-core', tempDir);
      const result = kspecFull('skill update', tempDir);

      expect(result.stdout).not.toContain('Updated:');
      expect(result.stdout).toContain('No skills needed updating');
    });

    it('should report skipped reason in JSON output', async () => {
      kspecFull('skill install-core', tempDir);

      const result = kspecJson<{
        results: { id: string; action: string; reason?: string }[];
      }>('skill update', tempDir);

      const kspecHelp = result.results.find((r) => r.id === 'help');
      expect(kspecHelp?.action).toBe('skipped');
      expect(kspecHelp?.reason).toContain('already at current version');
    });
  });

  // AC: @core-skill-update ac-3
  describe('ac-3: Skills with origin custom/project not touched', () => {
    it('should not process skills with origin "project"', async () => {
      // Create a project-origin skill
      kspecFull(
        'skill add --id my-skill --name "My Skill" --description "My project skill" --origin project',
        tempDir
      );

      // Run update
      const result = kspecFull('skill update', tempDir);

      // Should not mention my-skill at all (not even as skipped)
      expect(result.stdout).not.toContain('my-skill');

      // Verify skill is unchanged
      const skills = kspecJson<{ id: string; origin: string }[]>('skill list', tempDir);
      expect(skills.find((s) => s.id === 'my-skill')?.origin).toBe('project');
    });

    it('should not process skills with origin "local"', async () => {
      // Create a local-origin skill
      kspecFull(
        'skill add --id local-skill --name "Local Skill" --description "Local only" --origin local',
        tempDir
      );

      // Run update
      const result = kspecFull('skill update', tempDir);

      // Should not mention local-skill
      expect(result.stdout).not.toContain('local-skill');
    });

    it('should only process skills with origin "core"', async () => {
      // Install core skill
      kspecFull('skill install-core', tempDir);

      // Add a project skill with same ID pattern
      kspecFull(
        'skill add --id my-helper --name "Helper" --description "Project helper" --origin project',
        tempDir
      );

      // Set core skill to old version
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      // Run update
      const result = kspecFull('skill update', tempDir);

      // Should only show help (core) being updated
      expect(result.stdout).toContain('help');
      expect(result.stdout).not.toContain('my-helper');
    });
  });

  // Dry run support
  describe('dry-run support', () => {
    it('should not make changes with --dry-run', async () => {
      kspecFull('skill install-core', tempDir);
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      const result = kspecFull('skill update --dry-run', tempDir);

      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('No changes were made');

      // Verify version was NOT updated
      const skills = kspecJson<{ id: string; version?: string }[]>('skill list', tempDir);
      expect(skills.find((s) => s.id === 'help')?.version).toBe('0.0.1');
    });

    it('should show what would be updated with --dry-run', async () => {
      kspecFull('skill install-core', tempDir);
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      const result = kspecFull('skill update --dry-run', tempDir);

      expect(result.stdout).toContain('Updated');
      expect(result.stdout).toContain('help');
    });
  });

  // JSON output support
  describe('JSON output', () => {
    it('should return JSON with results array', async () => {
      kspecFull('skill install-core', tempDir);
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      const result = kspecJson<{ results: { id: string; action: string }[] }>(
        'skill update',
        tempDir
      );

      expect(result.results).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);

      const kspecHelp = result.results.find((r) => r.id === 'help');
      expect(kspecHelp?.action).toBe('updated');
    });

    it('should include dry_run field in JSON output', async () => {
      kspecFull('skill install-core', tempDir);

      const result = kspecJson<{ dry_run: boolean; results: unknown[] }>(
        'skill update --dry-run',
        tempDir
      );

      expect(result.dry_run).toBe(true);
    });

    it('should include kspec_version in JSON output', async () => {
      kspecFull('skill install-core', tempDir);

      const result = kspecJson<{ kspec_version: string }>(
        'skill update',
        tempDir
      );

      expect(result.kspec_version).toBeDefined();
      expect(result.kspec_version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should include version info in update results', async () => {
      kspecFull('skill install-core', tempDir);
      kspecFull('skill set @help --skill-version 0.0.1', tempDir);

      const result = kspecJson<{
        results: { id: string; previousVersion?: string; newVersion?: string }[];
      }>('skill update', tempDir);

      const kspecHelp = result.results.find((r) => r.id === 'help');
      expect(kspecHelp?.previousVersion).toBe('0.0.1');
      expect(kspecHelp?.newVersion).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('should handle no core skills installed', async () => {
      const result = kspecFull('skill update', tempDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No skills needed updating');
    });

    it('should skip core skill not in manifest', async () => {
      // Install a core skill, then rename it to something not in manifest
      kspecFull(
        'skill add --id fake-core --name "Fake Core" --description "Not in manifest" --origin core --skill-version 0.0.1',
        tempDir
      );

      const result = kspecFull('skill update', tempDir);

      expect(result.stdout).toContain('Skipped');
      expect(result.stdout).toContain('fake-core');
      expect(result.stdout).toContain('not found in core skills manifest');
    });
  });
});
