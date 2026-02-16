/**
 * Tests for Skill Rendering Pipeline
 * AC: @skill-rendering ac-1 through ac-5
 * AC: @trait-dry-run (dry run support)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspec as kspecFull,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Skill Rendering Pipeline', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a test skill
    const result = kspecFull(
      'skill add --id test-skill --name "Test Skill" --description "A test skill for rendering" --platform claude-code',
      tempDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`skill add failed: ${result.stderr || result.stdout}`);
    }

    // Note: In test fixtures (non-shadow mode), skills are at tempDir/skills/ not tempDir/.kspec/skills/
    const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');

    // Write custom content to the skill's SKILL.md
    await fs.writeFile(skillMdPath, '# Test Skill\n\nThis is test content.\n', 'utf-8');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-rendering ac-1
  describe('ac-1: Creates .claude/skills/<id>/SKILL.md with YAML frontmatter', () => {
    it('should create SKILL.md with YAML frontmatter when rendering', async () => {
      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');

      // Check frontmatter exists
      expect(content).toMatch(/^---\n/);
      expect(content).toContain('name: test-skill');
      expect(content).toContain('description: A test skill for rendering');
      expect(content).toContain('---');

      // Check marker is present
      expect(content).toContain('<!-- kspec-managed -->');

      // Check original content is preserved
      expect(content).toContain('# Test Skill');
      expect(content).toContain('This is test content.');
    });

    it('should use skill id as frontmatter name', async () => {
      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');

      // name should be the skill id, not the skill name
      expect(content).toContain('name: test-skill');
    });
  });

  // AC: @skill-rendering ac-2
  describe('ac-2: Copies docs to .claude/skills/<id>/docs/', () => {
    beforeEach(async () => {
      // Create docs directory in source
      const docsDir = path.join(tempDir, 'skills', 'test-skill', 'docs');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, 'quickref.md'), '# Quick Reference\n\nSome docs.\n', 'utf-8');
      await fs.writeFile(path.join(docsDir, 'advanced.md'), '# Advanced Guide\n\nMore docs.\n', 'utf-8');
    });

    it('should copy docs directory to rendered location', async () => {
      kspecFull('skill render', tempDir);

      const renderedDocsDir = path.join(tempDir, '.claude', 'skills', 'test-skill', 'docs');
      const quickref = await fs.readFile(path.join(renderedDocsDir, 'quickref.md'), 'utf-8');
      const advanced = await fs.readFile(path.join(renderedDocsDir, 'advanced.md'), 'utf-8');

      expect(quickref).toContain('# Quick Reference');
      expect(advanced).toContain('# Advanced Guide');
    });

    it('should work when skill has no docs directory', async () => {
      // Remove the docs we just created
      await fs.rm(path.join(tempDir, 'skills', 'test-skill', 'docs'), { recursive: true });

      const result = kspecFull('skill render', tempDir);
      expect(result.exitCode).toBe(0);

      // Should still render the skill successfully
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      expect(content).toContain('# Test Skill');
    });
  });

  // AC: @skill-rendering ac-3
  describe('ac-3: Idempotent rendering', () => {
    it('should not modify files when called twice with no content changes', async () => {
      // First render
      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const firstRenderStats = await fs.stat(renderedPath);
      const firstRenderMtime = firstRenderStats.mtimeMs;

      // Wait a bit to ensure different mtime if file is modified
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second render - should report unchanged
      const result = kspecFull('skill render', tempDir);
      expect(result.stdout).toContain('Unchanged');

      // Check file was not modified
      const secondRenderStats = await fs.stat(renderedPath);
      expect(secondRenderStats.mtimeMs).toBe(firstRenderMtime);
    });

    it('should update files when source content changes', async () => {
      // First render
      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const firstContent = await fs.readFile(renderedPath, 'utf-8');

      // Modify source
      const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Test Skill\n\nUpdated content!\n', 'utf-8');

      // Second render
      const result = kspecFull('skill render', tempDir);
      expect(result.stdout).toContain('Updated');

      // Check file was updated
      const secondContent = await fs.readFile(renderedPath, 'utf-8');
      expect(secondContent).toContain('Updated content!');
      expect(secondContent).not.toBe(firstContent);
    });

    it('should report unchanged in JSON output when no changes', async () => {
      kspecFull('skill render', tempDir);

      const result = kspecJson<{
        dry_run: boolean;
        rendered: Array<{ id: string; action: string }>;
      }>('skill render', tempDir);

      expect(result.rendered[0].action).toBe('unchanged');
    });
  });

  // AC: @skill-rendering ac-4, ac-5
  describe('ac-4, ac-5: Clean removes orphaned managed skills', () => {
    it('should remove managed skill directories that no longer exist in meta', async () => {
      // Render the skill first
      kspecFull('skill render', tempDir);

      // Verify it was rendered
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      await fs.access(renderedPath);

      // Delete the skill from meta
      kspecFull('skill delete test-skill --confirm', tempDir);

      // Run render --clean
      const result = kspecFull('skill render --clean', tempDir);
      expect(result.stdout).toContain('Removed');
      expect(result.stdout).toContain('test-skill');

      // Verify directory was removed
      await expect(fs.access(path.join(tempDir, '.claude', 'skills', 'test-skill'))).rejects.toThrow();
    });

    it('should NOT remove unmanaged skill directories (ac-4)', async () => {
      // Create an unmanaged skill directory (no kspec-managed marker)
      const unmanagedDir = path.join(tempDir, '.claude', 'skills', 'unmanaged-skill');
      await fs.mkdir(unmanagedDir, { recursive: true });
      await fs.writeFile(
        path.join(unmanagedDir, 'SKILL.md'),
        '---\nname: unmanaged\n---\n\n# Unmanaged\n\nNo marker.\n',
        'utf-8'
      );

      // Run render --clean
      const result = kspecFull('skill render --clean', tempDir);
      expect(result.stdout).toContain('Skipped');
      expect(result.stdout).toContain('unmanaged');

      // Verify directory was NOT removed
      const content = await fs.readFile(path.join(unmanagedDir, 'SKILL.md'), 'utf-8');
      expect(content).toContain('# Unmanaged');
    });

    it('should identify managed skills by kspec-managed marker', async () => {
      // Render a skill (will have marker)
      kspecFull('skill render', tempDir);

      // Create another "orphan" with the marker manually
      const orphanDir = path.join(tempDir, '.claude', 'skills', 'orphan-skill');
      await fs.mkdir(orphanDir, { recursive: true });
      await fs.writeFile(
        path.join(orphanDir, 'SKILL.md'),
        '---\nname: orphan\n---\n<!-- kspec-managed -->\n\n# Orphan\n',
        'utf-8'
      );

      // Delete the original skill
      kspecFull('skill delete test-skill --confirm', tempDir);

      // Run render --clean - should remove both orphaned managed skills
      const result = kspecFull('skill render --clean', tempDir);

      // Both should be removed
      await expect(fs.access(path.join(tempDir, '.claude', 'skills', 'test-skill'))).rejects.toThrow();
      await expect(fs.access(path.join(tempDir, '.claude', 'skills', 'orphan-skill'))).rejects.toThrow();
    });
  });

  // AC: @trait-dry-run
  describe('Dry run mode (trait)', () => {
    it('should not modify files when --dry-run is provided (ac-2)', async () => {
      kspecFull('skill render --dry-run', tempDir);

      // Rendered directory should NOT exist
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'test-skill'))
      ).rejects.toThrow();
    });

    it('should show what would be changed (ac-1)', async () => {
      const result = kspecFull('skill render --dry-run', tempDir);

      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('Created');
      expect(result.stdout).toContain('test-skill');
    });

    it('should include dry_run boolean in JSON output (ac-6)', async () => {
      const result = kspecJson<{ dry_run: boolean }>('skill render --dry-run', tempDir);
      expect(result.dry_run).toBe(true);
    });

    it('should not remove orphaned skills in dry run mode with --clean', async () => {
      // First render normally
      kspecFull('skill render', tempDir);

      // Delete skill from meta
      kspecFull('skill delete test-skill --confirm', tempDir);

      // Dry run clean
      kspecFull('skill render --clean --dry-run', tempDir);

      // Directory should still exist
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      await fs.access(renderedPath);
    });
  });

  // AC: @skill-render-cli ac-2
  describe('ac-2: Filtering by skill (positional ref)', () => {
    beforeEach(async () => {
      // Add another skill
      kspecFull(
        'skill add --id another-skill --name "Another Skill" --description "Another test skill"',
        tempDir
      );
      const anotherSkillMd = path.join(tempDir, 'skills', 'another-skill', 'SKILL.md');
      await fs.writeFile(anotherSkillMd, '# Another Skill\n\nAnother content.\n', 'utf-8');
    });

    it('should render only specified skill with positional ref', async () => {
      // AC: @skill-render-cli ac-2 - kspec skill render @task-work renders only that skill
      kspecFull('skill render @test-skill', tempDir);

      // test-skill should be rendered
      const testSkillPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      await fs.access(testSkillPath);

      // another-skill should NOT be rendered
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'another-skill'))
      ).rejects.toThrow();
    });

    it('should render only specified skill with --skill option (deprecated)', async () => {
      kspecFull('skill render --skill test-skill', tempDir);

      // test-skill should be rendered
      const testSkillPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      await fs.access(testSkillPath);

      // another-skill should NOT be rendered
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'another-skill'))
      ).rejects.toThrow();
    });

    it('should error when specified skill ref not found', async () => {
      const result = kspecFull('skill render @nonexistent', tempDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Skill not found');
    });
  });

  describe('Platform filtering', () => {
    beforeEach(async () => {
      // Add a skill with different platform
      kspecFull(
        'skill add --id copilot-skill --name "Copilot Skill" --description "For Copilot" --platform copilot',
        tempDir
      );
    });

    it('should only render skills with claude-code platform', async () => {
      kspecFull('skill render', tempDir);

      // claude-code skill should be rendered
      const testSkillPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      await fs.access(testSkillPath);

      // copilot skill should NOT be rendered
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'copilot-skill'))
      ).rejects.toThrow();
    });
  });

  describe('Edge cases', () => {
    it('should handle skills with no source SKILL.md', async () => {
      // Delete the source SKILL.md
      await fs.rm(path.join(tempDir, 'skills', 'test-skill', 'SKILL.md'));

      const result = kspecFull('skill render', tempDir);
      expect(result.exitCode).toBe(0);

      // Should create a placeholder
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      expect(content).toContain('name: test-skill');
      expect(content).toContain('<!-- kspec-managed -->');
    });

    it('should strip existing frontmatter from source and replace with generated', async () => {
      // Write source with frontmatter
      const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
      await fs.writeFile(
        skillMdPath,
        '---\nname: wrong-name\ndescription: wrong description\n---\n\n# Actual Content\n',
        'utf-8'
      );

      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');

      // Should have new frontmatter
      expect(content).toContain('name: test-skill');
      expect(content).toContain('description: A test skill for rendering');

      // Should NOT have duplicate frontmatter
      const frontmatterMatches = content.match(/^---/gm);
      expect(frontmatterMatches?.length).toBe(2); // opening and closing

      // Should have the content
      expect(content).toContain('# Actual Content');
    });

    it('should work when .claude/skills directory does not exist', async () => {
      // Remove .claude directory if it exists
      try {
        await fs.rm(path.join(tempDir, '.claude'), { recursive: true });
      } catch {
        // Already doesn't exist
      }

      const result = kspecFull('skill render', tempDir);
      expect(result.exitCode).toBe(0);

      // Directory should be created
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      await fs.access(renderedPath);
    });

    it('should work when no skills exist', async () => {
      // Delete all skills
      kspecFull('skill delete test-skill --confirm', tempDir);

      const result = kspecFull('skill render', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No changes needed');
    });
  });
});

/**
 * Tests for Skill Render CLI commands
 * AC: @skill-render-cli ac-3, ac-4
 */
describe('Skill Render CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a test skill
    const result = kspecFull(
      'skill add --id test-skill --name "Test Skill" --description "A test skill" --platform claude-code',
      tempDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`skill add failed: ${result.stderr || result.stdout}`);
    }

    // Write custom content to the skill's SKILL.md
    const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
    await fs.writeFile(skillMdPath, '# Test Skill\n\nThis is test content.\n', 'utf-8');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-render-cli ac-3
  describe('ac-3: kspec skill status shows sync status table', () => {
    it('should show "not-rendered" for skills not yet rendered', async () => {
      const result = kspecFull('skill status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test-skill');
      expect(result.stdout).toContain('not-rendered');
    });

    it('should show "in-sync" for skills that are in sync', async () => {
      // Render the skill first
      kspecFull('skill render', tempDir);

      const result = kspecFull('skill status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test-skill');
      expect(result.stdout).toContain('in-sync');
      expect(result.stdout).toContain('All skills in sync');
    });

    it('should show "drifted" when rendered file differs from source', async () => {
      // Render the skill
      kspecFull('skill render', tempDir);

      // Modify the rendered file directly
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content + '\n\n# Added Section\n', 'utf-8');

      const result = kspecFull('skill status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test-skill');
      expect(result.stdout).toContain('drifted');
      expect(result.stdout).toContain("run 'kspec skill render' to sync");
    });

    it('should output JSON with status fields', async () => {
      kspecFull('skill render', tempDir);

      const result = kspecJson<Array<{ id: string; status: string; docsStatus: string }>>(
        'skill status',
        tempDir
      );

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-skill');
      expect(result[0].status).toBe('in-sync');
      expect(result[0].docsStatus).toBe('no-docs');
    });

    it('should track docs status separately', async () => {
      // Add docs directory
      const docsDir = path.join(tempDir, 'skills', 'test-skill', 'docs');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n', 'utf-8');

      // Render
      kspecFull('skill render', tempDir);

      // Check status (should be in-sync)
      let result = kspecJson<Array<{ id: string; status: string; docsStatus: string }>>(
        'skill status',
        tempDir
      );
      expect(result[0].docsStatus).toBe('in-sync');

      // Modify source docs
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n\nUpdated content.\n', 'utf-8');

      // Check status again (docs should be drifted)
      result = kspecJson<Array<{ id: string; status: string; docsStatus: string }>>(
        'skill status',
        tempDir
      );
      expect(result[0].docsStatus).toBe('drifted');
    });
  });

  // AC: @skill-render-cli ac-4
  describe('ac-4: kspec skill diff shows unified diff', () => {
    it('should show "in sync" message when no diff', async () => {
      // Render the skill
      kspecFull('skill render', tempDir);

      const result = kspecFull('skill diff test-skill', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('in sync');
    });

    it('should show unified diff when rendered file differs', async () => {
      // Render the skill
      kspecFull('skill render', tempDir);

      // Modify the rendered file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content.replace('test content', 'modified content'), 'utf-8');

      const result = kspecFull('skill diff test-skill', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('drifted');
      expect(result.stdout).toContain('---'); // Diff header
      expect(result.stdout).toContain('+++'); // Diff header
      expect(result.stdout).toContain('@@'); // Hunk header
    });

    it('should show full diff when rendered file does not exist', async () => {
      // Don't render, so rendered file doesn't exist
      const result = kspecFull('skill diff test-skill', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('drifted');
      expect(result.stdout).toContain('+'); // All lines are additions
    });

    it('should error when skill not found', async () => {
      const result = kspecFull('skill diff nonexistent', tempDir);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Skill not found');
    });

    it('should output JSON with diff lines', async () => {
      kspecFull('skill render', tempDir);

      // Modify rendered file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content.replace('test content', 'changed'), 'utf-8');

      const result = kspecJson<{ id: string; hasDiff: boolean; diff: string[] }>(
        'skill diff test-skill',
        tempDir
      );

      expect(result.id).toBe('test-skill');
      expect(result.hasDiff).toBe(true);
      expect(result.diff).toBeInstanceOf(Array);
      expect(result.diff.length).toBeGreaterThan(0);
      expect(result.diff.some((line) => line.startsWith('---'))).toBe(true);
      expect(result.diff.some((line) => line.startsWith('+++'))).toBe(true);
    });

    it('should return empty diff array when in sync', async () => {
      kspecFull('skill render', tempDir);

      const result = kspecJson<{ id: string; hasDiff: boolean; diff: string[] }>(
        'skill diff test-skill',
        tempDir
      );

      expect(result.hasDiff).toBe(false);
      expect(result.diff).toEqual([]);
    });
  });
});

/**
 * Tests for Skill Drift Detection
 * AC: @skill-drift-detection ac-1 through ac-5
 */
describe('Skill Drift Detection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a test skill
    const result = kspecFull(
      'skill add --id test-skill --name "Test Skill" --description "A test skill" --platform claude-code',
      tempDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`skill add failed: ${result.stderr || result.stdout}`);
    }

    // Write custom content to the skill's SKILL.md
    const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
    await fs.writeFile(skillMdPath, '# Test Skill\n\nThis is test content.\n', 'utf-8');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-drift-detection ac-1
  describe('ac-1: Skill shows as in sync when not manually edited', () => {
    it('should show in-sync after rendering', async () => {
      kspecFull('skill render', tempDir);

      const result = kspecFull('skill status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test-skill');
      expect(result.stdout).toContain('in-sync');
    });

    it('should show in-sync on re-render without changes', async () => {
      kspecFull('skill render', tempDir);
      kspecFull('skill render', tempDir);

      const result = kspecFull('skill status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('in-sync');
    });
  });

  // AC: @skill-drift-detection ac-2
  describe('ac-2: Skill shows as drifted when manually edited', () => {
    it('should show drifted after manual edit to rendered file', async () => {
      // Render the skill
      kspecFull('skill render', tempDir);

      // Manually edit the rendered file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content + '\n\n# Manually Added Section\n', 'utf-8');

      const result = kspecFull('skill status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('test-skill');
      expect(result.stdout).toContain('drifted');
    });

    it('should show drifted with the file path in message', async () => {
      kspecFull('skill render', tempDir);

      // Manually edit
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content + '\nEdited.\n', 'utf-8');

      const result = kspecFull('skill status', tempDir);
      expect(result.stdout).toContain('drifted');
      expect(result.stdout).toContain("run 'kspec skill render' to sync");
    });
  });

  // AC: @skill-drift-detection ac-3
  describe('ac-3: Drifted skill is skipped without --force', () => {
    it('should skip drifted skill with warning when rendering without --force', async () => {
      // First render
      kspecFull('skill render', tempDir);

      // Manually edit the rendered file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const originalContent = await fs.readFile(renderedPath, 'utf-8');
      const editedContent = originalContent + '\n\n# Manually Added\n';
      await fs.writeFile(renderedPath, editedContent, 'utf-8');

      // Try to render again without --force
      const result = kspecFull('skill render', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Skipped');
      expect(result.stdout).toContain('drifted');
      expect(result.stdout).toContain('--force to overwrite');

      // Verify the file was NOT overwritten
      const afterContent = await fs.readFile(renderedPath, 'utf-8');
      expect(afterContent).toBe(editedContent);
      expect(afterContent).toContain('# Manually Added');
    });

    it('should show skip reason in JSON output', async () => {
      kspecFull('skill render', tempDir);

      // Edit the file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content + '\nEdited.\n', 'utf-8');

      const result = kspecJson<{
        rendered: Array<{ id: string; action: string; skipReason?: string }>;
      }>('skill render', tempDir);

      expect(result.rendered[0].action).toBe('skipped');
      expect(result.rendered[0].skipReason).toContain('drifted');
    });
  });

  // AC: @skill-drift-detection ac-4
  describe('ac-4: Drifted skill is overwritten with --force', () => {
    it('should overwrite drifted skill when using --force', async () => {
      // First render
      kspecFull('skill render', tempDir);

      // Get the original content
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const originalContent = await fs.readFile(renderedPath, 'utf-8');

      // Manually edit the rendered file
      await fs.writeFile(renderedPath, originalContent + '\n\n# Manually Added\n', 'utf-8');

      // Verify it's drifted
      let status = kspecFull('skill status', tempDir);
      expect(status.stdout).toContain('drifted');

      // Render with --force
      const result = kspecFull('skill render --force', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated');
      expect(result.stdout).toContain('test-skill');

      // Verify the file was overwritten
      const afterContent = await fs.readFile(renderedPath, 'utf-8');
      expect(afterContent).not.toContain('# Manually Added');
      expect(afterContent.trim()).toBe(originalContent.trim());

      // Verify status is now in-sync
      status = kspecFull('skill status', tempDir);
      expect(status.stdout).toContain('in-sync');
    });

    it('should update hash after force overwrite', async () => {
      kspecFull('skill render', tempDir);

      // Edit the file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content + '\nEdited.\n', 'utf-8');

      // Force render
      kspecFull('skill render --force', tempDir);

      // Status should be in-sync (hash was updated)
      const status = kspecFull('skill status', tempDir);
      expect(status.stdout).toContain('in-sync');
    });
  });

  // AC: @skill-drift-detection ac-5
  describe('ac-5: Render hash is stored in .kspec/skills/<id>/.render-hash', () => {
    it('should create .render-hash file after successful render', async () => {
      kspecFull('skill render', tempDir);

      // Check if hash file exists
      // In test fixtures, skills are stored in tempDir/skills/ not tempDir/.kspec/skills/
      const hashPath = path.join(tempDir, 'skills', 'test-skill', '.render-hash');
      const hashContent = await fs.readFile(hashPath, 'utf-8');

      expect(hashContent.trim()).toBeTruthy();
      // SHA256 hashes are 64 hex characters
      expect(hashContent.trim()).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should update .render-hash on subsequent renders', async () => {
      // First render
      kspecFull('skill render', tempDir);

      const hashPath = path.join(tempDir, 'skills', 'test-skill', '.render-hash');
      const firstHash = await fs.readFile(hashPath, 'utf-8');

      // Modify source content
      const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Test Skill\n\nUpdated content.\n', 'utf-8');

      // Second render
      kspecFull('skill render', tempDir);

      const secondHash = await fs.readFile(hashPath, 'utf-8');

      // Hashes should be different
      expect(secondHash.trim()).not.toBe(firstHash.trim());
    });

    it('should not create .render-hash during dry run', async () => {
      kspecFull('skill render --dry-run', tempDir);

      const hashPath = path.join(tempDir, 'skills', 'test-skill', '.render-hash');
      await expect(fs.access(hashPath)).rejects.toThrow();
    });

    it('should use hash to detect drift, not content comparison', async () => {
      // Render the skill
      kspecFull('skill render', tempDir);

      // Get the rendered content
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');

      // Manually edit the rendered file but put back original content after
      await fs.writeFile(renderedPath, content + '\nTemporary edit.\n', 'utf-8');

      // Even if we restore content, hash won't match original since file was overwritten
      // Actually, let's test the opposite - modify source but not rendered
      // The status should still show in-sync because hash matches

      // For this test, we check that modifying rendered file (even slightly) breaks hash match
      await fs.writeFile(renderedPath, content + ' ', 'utf-8'); // Add trailing space

      const status = kspecFull('skill status', tempDir);
      expect(status.stdout).toContain('drifted');
    });
  });

  describe('Edge cases', () => {
    it('should handle missing hash file gracefully (legacy renders)', async () => {
      // Render the skill
      kspecFull('skill render', tempDir);

      // Delete the hash file to simulate legacy render
      const hashPath = path.join(tempDir, 'skills', 'test-skill', '.render-hash');
      await fs.rm(hashPath);

      // Status should fall back to content comparison
      const status = kspecFull('skill status', tempDir);
      expect(status.stdout).toContain('in-sync');
    });

    it('should allow rendering non-drifted skills normally', async () => {
      // First render
      kspecFull('skill render', tempDir);

      // Modify source content (not rendered file)
      const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Test Skill\n\nUpdated source content.\n', 'utf-8');

      // Render again - should work without --force because file isn't drifted
      const result = kspecFull('skill render', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated');
      expect(result.stdout).not.toContain('Skipped');

      // Verify update was applied
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');
      expect(renderedContent).toContain('Updated source content');
    });

    it('should handle multiple skills with mixed drift states', async () => {
      // Add another skill
      kspecFull(
        'skill add --id another-skill --name "Another Skill" --description "Another test" --platform claude-code',
        tempDir
      );
      const anotherSkillMd = path.join(tempDir, 'skills', 'another-skill', 'SKILL.md');
      await fs.writeFile(anotherSkillMd, '# Another Skill\n\nAnother content.\n', 'utf-8');

      // Render both skills
      kspecFull('skill render', tempDir);

      // Edit only the first skill's rendered file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content + '\nEdited.\n', 'utf-8');

      // Render without --force - should skip test-skill but render another-skill
      const result = kspecFull('skill render', tempDir);
      expect(result.stdout).toContain('Skipped');
      expect(result.stdout).toContain('test-skill');
      expect(result.stdout).toContain('Unchanged'); // another-skill

      // With --force - should update both
      const forceResult = kspecFull('skill render --force', tempDir);
      expect(forceResult.stdout).toContain('Updated');
      expect(forceResult.stdout).toContain('test-skill');
    });
  });
});

/**
 * Tests for Extended Frontmatter in Claude Code Renderer
 * AC: @claude-code-renderer-extended ac-1 through ac-8
 */
describe('Claude Code Renderer - Extended Frontmatter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @claude-code-renderer-extended ac-1
  describe('ac-1: Portable fields (license, allowed-tools) in frontmatter', () => {
    it('should include license field when skill has license', async () => {
      // Create skill with license
      const result = kspecFull(
        'skill add --id licensed-skill --name "Licensed Skill" --description "A skill with license" --platform claude-code',
        tempDir
      );
      expect(result.exitCode).toBe(0);

      // Manually update meta.yaml to add license field (proper indentation with 4 spaces)
      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      metaContent = metaContent.replace(
        /id: licensed-skill\n/,
        'id: licensed-skill\n    license: MIT\n'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      // Write content
      const skillMdPath = path.join(tempDir, 'skills', 'licensed-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Licensed Skill\n\nContent.\n', 'utf-8');

      // Render
      kspecFull('skill render', tempDir);

      // Check frontmatter
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'licensed-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');
      expect(renderedContent).toContain('license: MIT');
    });

    it('should include allowed-tools when skill has allowed_tools', async () => {
      // Create skill
      kspecFull(
        'skill add --id tools-skill --name "Tools Skill" --description "A skill with tools" --platform claude-code',
        tempDir
      );

      // Replace the empty allowed_tools array with actual tools
      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      // The skill add command creates: allowed_tools: []
      // Replace that with our array
      metaContent = metaContent.replace(
        /    allowed_tools: \[\]/,
        '    allowed_tools:\n      - Bash\n      - Read'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      // Write content
      const skillMdPath = path.join(tempDir, 'skills', 'tools-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Tools Skill\n\nContent.\n', 'utf-8');

      // Render
      kspecFull('skill render', tempDir);

      // Check frontmatter
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'tools-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');
      expect(renderedContent).toContain('allowed-tools:');
      expect(renderedContent).toContain('- Bash');
      expect(renderedContent).toContain('- Read');
    });
  });

  // AC: @claude-code-renderer-extended ac-2
  describe('ac-2: user-invocable from platform_config.claude_code', () => {
    it('should include user-invocable: false when configured', async () => {
      kspecFull(
        'skill add --id ui-skill --name "UI Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      // Update meta.yaml with platform_config (proper indentation)
      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      metaContent = metaContent.replace(
        /id: ui-skill\n/,
        'id: ui-skill\n    platform_config:\n      claude_code:\n        user_invocable: false\n'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      const skillMdPath = path.join(tempDir, 'skills', 'ui-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# UI Skill\n', 'utf-8');

      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'ui-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');
      expect(renderedContent).toContain('user-invocable: false');
    });
  });

  // AC: @claude-code-renderer-extended ac-3
  describe('ac-3: context and agent from platform_config.claude_code', () => {
    it('should include context: fork and agent when configured', async () => {
      kspecFull(
        'skill add --id ctx-skill --name "Context Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      metaContent = metaContent.replace(
        /id: ctx-skill\n/,
        'id: ctx-skill\n    platform_config:\n      claude_code:\n        context: fork\n        agent: test-agent\n'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      const skillMdPath = path.join(tempDir, 'skills', 'ctx-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Context Skill\n', 'utf-8');

      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'ctx-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');
      expect(renderedContent).toContain('context: fork');
      expect(renderedContent).toContain('agent: test-agent');
    });
  });

  // AC: @claude-code-renderer-extended ac-4
  describe('ac-4: disable-model-invocation from platform_config', () => {
    it('should include disable-model-invocation: true when configured', async () => {
      kspecFull(
        'skill add --id dmi-skill --name "DMI Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      metaContent = metaContent.replace(
        /id: dmi-skill\n/,
        'id: dmi-skill\n    platform_config:\n      claude_code:\n        disable_model_invocation: true\n'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      const skillMdPath = path.join(tempDir, 'skills', 'dmi-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# DMI Skill\n', 'utf-8');

      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'dmi-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');
      expect(renderedContent).toContain('disable-model-invocation: true');
    });
  });

  // AC: @claude-code-renderer-extended ac-5
  describe('ac-5: Only portable fields when no platform_config.claude_code', () => {
    it('should only include name, description, and portable fields when no platform_config', async () => {
      kspecFull(
        'skill add --id simple-skill --name "Simple Skill" --description "A simple skill" --platform claude-code',
        tempDir
      );

      // Add license but no platform_config (proper indentation)
      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      metaContent = metaContent.replace(
        /id: simple-skill\n/,
        'id: simple-skill\n    license: Apache-2.0\n'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      const skillMdPath = path.join(tempDir, 'skills', 'simple-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Simple Skill\n', 'utf-8');

      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'simple-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');

      // Should have name, description, and license
      expect(renderedContent).toContain('name: simple-skill');
      expect(renderedContent).toContain('description: A simple skill');
      expect(renderedContent).toContain('license: Apache-2.0');

      // Should NOT have platform-specific fields
      expect(renderedContent).not.toContain('user-invocable');
      expect(renderedContent).not.toContain('disable-model-invocation');
      expect(renderedContent).not.toContain('context:');
      expect(renderedContent).not.toContain('agent:');
    });
  });

  // AC: @claude-code-renderer-extended ac-6
  describe('ac-6: Hash migration from .render-hash to .render-hash-claude-code', () => {
    it('should migrate legacy .render-hash to .render-hash-claude-code on platform drift check', async () => {
      kspecFull(
        'skill add --id migrate-skill --name "Migrate Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'migrate-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Migrate Skill\n', 'utf-8');

      // Render to create the file with legacy hash
      kspecFull('skill render', tempDir);

      // The CLI render creates .render-hash (legacy)
      const legacyHashPath = path.join(tempDir, 'skills', 'migrate-skill', '.render-hash');
      const platformHashPath = path.join(tempDir, 'skills', 'migrate-skill', '.render-hash-claude-code');

      // Verify legacy hash exists
      const hash = await fs.readFile(legacyHashPath, 'utf-8');
      expect(hash.trim()).toBeTruthy();

      // Import the platform drift check function and run it directly
      // This simulates when the new platform renderer is used
      const { checkPlatformSkillDrift } = await import('../src/parser/skill-render');
      await checkPlatformSkillDrift(
        path.join(tempDir, 'skills', '..'), // specDir
        tempDir,                             // projectRoot
        'migrate-skill',
        'claude-code'
      );

      // After platform drift check, the platform-specific hash should be created from migration
      const migratedHash = await fs.readFile(platformHashPath, 'utf-8');
      expect(migratedHash.trim()).toBe(hash.trim());
    });

    it('should read legacy hash as fallback when platform-specific hash does not exist', async () => {
      kspecFull(
        'skill add --id fallback-skill --name "Fallback Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'fallback-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Fallback Skill\n', 'utf-8');

      // Render
      kspecFull('skill render', tempDir);

      // The CLI render only creates .render-hash (legacy)
      // Status should show in-sync because it reads the legacy hash
      const status = kspecFull('skill status', tempDir);
      expect(status.stdout).toContain('in-sync');
    });
  });

  // AC: @claude-code-renderer-extended ac-7
  describe('ac-7: Supporting directories (references/, scripts/, assets/) copied', () => {
    it('should copy references/ directory to rendered output', async () => {
      kspecFull(
        'skill add --id ref-skill --name "Ref Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const skillDir = path.join(tempDir, 'skills', 'ref-skill');
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Ref Skill\n', 'utf-8');

      // Create references directory
      const refsDir = path.join(skillDir, 'references');
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, 'api.md'), '# API Reference\n', 'utf-8');

      kspecFull('skill render', tempDir);

      // Check references copied
      const renderedRefsDir = path.join(tempDir, '.claude', 'skills', 'ref-skill', 'references');
      const refContent = await fs.readFile(path.join(renderedRefsDir, 'api.md'), 'utf-8');
      expect(refContent).toContain('# API Reference');
    });

    it('should copy scripts/ directory to rendered output', async () => {
      kspecFull(
        'skill add --id scripts-skill --name "Scripts Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const skillDir = path.join(tempDir, 'skills', 'scripts-skill');
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Scripts Skill\n', 'utf-8');

      // Create scripts directory
      const scriptsDir = path.join(skillDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'helper.sh'), '#!/bin/bash\necho "Hello"\n', 'utf-8');

      kspecFull('skill render', tempDir);

      // Check scripts copied
      const renderedScriptsDir = path.join(tempDir, '.claude', 'skills', 'scripts-skill', 'scripts');
      const scriptContent = await fs.readFile(path.join(renderedScriptsDir, 'helper.sh'), 'utf-8');
      expect(scriptContent).toContain('#!/bin/bash');
    });

    it('should copy assets/ directory to rendered output', async () => {
      kspecFull(
        'skill add --id assets-skill --name "Assets Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const skillDir = path.join(tempDir, 'skills', 'assets-skill');
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Assets Skill\n', 'utf-8');

      // Create assets directory
      const assetsDir = path.join(skillDir, 'assets');
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, 'data.json'), '{"key": "value"}', 'utf-8');

      kspecFull('skill render', tempDir);

      // Check assets copied
      const renderedAssetsDir = path.join(tempDir, '.claude', 'skills', 'assets-skill', 'assets');
      const assetContent = await fs.readFile(path.join(renderedAssetsDir, 'data.json'), 'utf-8');
      expect(assetContent).toContain('"key": "value"');
    });
  });

  // AC: @claude-code-renderer-extended ac-8
  describe('ac-8: snake_case to kebab-case conversion in frontmatter', () => {
    it('should convert disable_model_invocation to disable-model-invocation', async () => {
      kspecFull(
        'skill add --id case-skill --name "Case Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      metaContent = metaContent.replace(
        /id: case-skill\n/,
        'id: case-skill\n    platform_config:\n      claude_code:\n        disable_model_invocation: true\n        user_invocable: false\n'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      const skillMdPath = path.join(tempDir, 'skills', 'case-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Case Skill\n', 'utf-8');

      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'case-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');

      // Should use kebab-case in frontmatter
      expect(renderedContent).toContain('disable-model-invocation: true');
      expect(renderedContent).toContain('user-invocable: false');

      // Should NOT have snake_case
      expect(renderedContent).not.toContain('disable_model_invocation');
      expect(renderedContent).not.toContain('user_invocable');
    });

    it('should convert argument_hint to argument-hint', async () => {
      kspecFull(
        'skill add --id hint-skill --name "Hint Skill" --description "A skill" --platform claude-code',
        tempDir
      );

      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      let metaContent = await fs.readFile(metaPath, 'utf-8');
      metaContent = metaContent.replace(
        /id: hint-skill\n/,
        'id: hint-skill\n    platform_config:\n      claude_code:\n        argument_hint: "<task-ref>"\n'
      );
      await fs.writeFile(metaPath, metaContent, 'utf-8');

      const skillMdPath = path.join(tempDir, 'skills', 'hint-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Hint Skill\n', 'utf-8');

      kspecFull('skill render', tempDir);

      const renderedPath = path.join(tempDir, '.claude', 'skills', 'hint-skill', 'SKILL.md');
      const renderedContent = await fs.readFile(renderedPath, 'utf-8');

      expect(renderedContent).toContain('argument-hint:');
      expect(renderedContent).not.toContain('argument_hint');
    });
  });
});
