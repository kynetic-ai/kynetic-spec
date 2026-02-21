/**
 * Tests for Core Skill Installation
 * AC: @core-skill-install ac-1 through ac-5
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

describe('Core Skill Installation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @core-skill-install ac-1
  describe('ac-1: Meta entries created with origin core', () => {
    it('should create skill meta entries with origin "core"', async () => {
      const result = kspecFull('skill install-core', tempDir);
      expect(result.exitCode).toBe(0);

      // Check skill was created
      const skills = kspecJson<{ id: string; origin: string }[]>('skill list', tempDir);
      const coreSkill = skills.find((s) => s.id === 'help');

      expect(coreSkill).toBeDefined();
      expect(coreSkill?.origin).toBe('core');
    });

    it('should include "core" tag on installed skills', async () => {
      kspecFull('skill install-core', tempDir);

      const skills = kspecJson<{ id: string; tags?: string[] }[]>('skill list', tempDir);
      const coreSkill = skills.find((s) => s.id === 'help');

      expect(coreSkill?.tags).toContain('core');
    });
  });

  // AC: @core-skill-install ac-2
  describe('ac-2: Content files copied to .kspec/skills/<id>/', () => {
    it('should copy SKILL.md content from templates', async () => {
      kspecFull('skill install-core', tempDir);

      // Note: In test fixtures (non-shadow mode), skills are at tempDir/skills/ not tempDir/.kspec/skills/
      const skillMdPath = path.join(tempDir, 'skills', 'help', 'SKILL.md');
      const content = await fs.readFile(skillMdPath, 'utf-8');

      // Check content was copied (matches the template content)
      expect(content).toContain('# kspec CLI Map');
      expect(content).toContain('kspec help');
    });

    it('should create skill directory if it does not exist', async () => {
      kspecFull('skill install-core', tempDir);

      const skillDir = path.join(tempDir, 'skills', 'help');
      const stat = await fs.stat(skillDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  // AC: @core-skill-install ac-3
  describe('ac-3: Custom skills skipped with message', () => {
    it('should skip existing custom/project origin skills', async () => {
      // First create a custom skill with the same ID
      kspecFull(
        'skill add --id help --name "My Custom Help" --description "Custom version" --origin project',
        tempDir
      );

      // Try to install core skills
      const result = kspecFull('skill install-core', tempDir);
      expect(result.stdout).toContain('Skipped');
      expect(result.stdout).toContain('help');
      expect(result.stdout).toContain('use --force to overwrite');

      // Verify the skill still has project origin
      const skills = kspecJson<{ id: string; origin: string }[]>('skill list', tempDir);
      const helpSkill = skills.find((s) => s.id === 'help');
      expect(helpSkill?.origin).toBe('project');
    });

    it('should update existing core origin skills', async () => {
      // First install core skills
      kspecFull('skill install-core', tempDir);

      // Install again - should update (not skip)
      const result = kspecFull('skill install-core', tempDir);

      // It should be "Updated" not "Skipped"
      expect(result.stdout).toContain('Updated');
      expect(result.stdout).toContain('help');
    });
  });

  // AC: @core-skill-install ac-4
  describe('ac-4: --force overwrites custom forks', () => {
    it('should overwrite custom skills when --force is used', async () => {
      // First create a custom skill
      kspecFull(
        'skill add --id help --name "My Custom Help" --description "Custom version" --origin project',
        tempDir
      );

      // Verify it's project origin
      let skills = kspecJson<{ id: string; origin: string }[]>('skill list', tempDir);
      expect(skills.find((s) => s.id === 'help')?.origin).toBe('project');

      // Install with --force
      const result = kspecFull('skill install-core --force', tempDir);
      expect(result.stdout).toContain('Updated');
      expect(result.stdout).toContain('help');

      // Verify it's now core origin
      skills = kspecJson<{ id: string; origin: string }[]>('skill list', tempDir);
      expect(skills.find((s) => s.id === 'help')?.origin).toBe('core');
    });

    it('should update SKILL.md content when --force is used', async () => {
      // Create custom skill with custom content
      kspecFull(
        'skill add --id help --name "My Custom Help" --description "Custom version" --origin project',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'help', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Custom Content\n\nThis is my custom content.\n', 'utf-8');

      // Install with --force
      kspecFull('skill install-core --force', tempDir);

      // Verify content was overwritten with core content
      const content = await fs.readFile(skillMdPath, 'utf-8');
      expect(content).toContain('# kspec CLI Map');
      expect(content).not.toContain('Custom Content');
    });
  });

  // AC: @core-skill-install ac-5
  describe('ac-5: Version matches kspec package version', () => {
    it('should set skill version to kspec package version', async () => {
      kspecFull('skill install-core', tempDir);

      const skills = kspecJson<{ id: string; version?: string }[]>('skill list', tempDir);
      const coreSkill = skills.find((s) => s.id === 'help');

      expect(coreSkill?.version).toBeDefined();
      // Version should be a semver-like string (e.g., "0.1.2")
      expect(coreSkill?.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('should show version in install output', async () => {
      const result = kspecFull('skill install-core', tempDir);

      // Should show "(vX.Y.Z)" in output
      expect(result.stdout).toMatch(/\(v\d+\.\d+\.\d+\)/);
    });
  });

  // Dry run support
  describe('dry-run support', () => {
    it('should not make changes with --dry-run', async () => {
      const result = kspecFull('skill install-core --dry-run', tempDir);

      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('No changes were made');

      // Verify skill was NOT created
      const skills = kspecJson<{ id: string }[]>('skill list', tempDir);
      const coreSkill = skills.find((s) => s.id === 'help');
      expect(coreSkill).toBeUndefined();
    });

    it('should show what would be installed with --dry-run', async () => {
      const result = kspecFull('skill install-core --dry-run', tempDir);

      expect(result.stdout).toContain('Created: 1 skill(s)');
      expect(result.stdout).toContain('help');
    });
  });

  // JSON output support
  describe('JSON output', () => {
    it('should return JSON with results array', async () => {
      const result = kspecJson<{ results: { id: string; action: string }[] }>(
        'skill install-core',
        tempDir
      );

      expect(result.results).toBeDefined();
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);

      const kspecHelp = result.results.find((r) => r.id === 'help');
      expect(kspecHelp).toBeDefined();
      expect(kspecHelp?.action).toBe('created');
    });

    it('should include dry_run field in JSON output', async () => {
      const result = kspecJson<{ dry_run: boolean; results: unknown[] }>(
        'skill install-core --dry-run',
        tempDir
      );

      expect(result.dry_run).toBe(true);
    });
  });
});

describe('Core Skills Manifest Loading', () => {
  it('should load core skills from templates/skills/manifest.yaml', async () => {
    // Import the function for direct testing
    const { loadCoreSkillsManifest } = await import('../src/cli/commands/skill.js');

    const skills = await loadCoreSkillsManifest();

    expect(skills.length).toBeGreaterThan(0);

    const kspecHelp = skills.find((s) => s.id === 'help');
    expect(kspecHelp).toBeDefined();
    expect(kspecHelp?.name).toBe('Kspec Help');
    expect(kspecHelp?.description).toContain('help');
    expect(kspecHelp?.platforms).toContain('claude-code');
  });

  it('should load SKILL.md content for core skills', async () => {
    const { loadCoreSkillContent } = await import('../src/cli/commands/skill.js');

    const content = await loadCoreSkillContent('help');

    expect(content).not.toBeNull();
    expect(content).toContain('# kspec CLI Map');
  });

  it('should return null for non-existent skill content', async () => {
    const { loadCoreSkillContent } = await import('../src/cli/commands/skill.js');

    const content = await loadCoreSkillContent('non-existent-skill');

    expect(content).toBeNull();
  });

  it('should return kspec package version', async () => {
    const { getKspecPackageVersion } = await import('../src/cli/commands/skill.js');

    const version = await getKspecPackageVersion();

    expect(version).toBeDefined();
    expect(version).not.toBe('unknown');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
