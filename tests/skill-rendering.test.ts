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

  describe('Filtering by skill', () => {
    beforeEach(async () => {
      // Add another skill
      kspecFull(
        'skill add --id another-skill --name "Another Skill" --description "Another test skill"',
        tempDir
      );
      const anotherSkillMd = path.join(tempDir, 'skills', 'another-skill', 'SKILL.md');
      await fs.writeFile(anotherSkillMd, '# Another Skill\n\nAnother content.\n', 'utf-8');
    });

    it('should render only specified skill with --skill', async () => {
      kspecFull('skill render --skill test-skill', tempDir);

      // test-skill should be rendered
      const testSkillPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      await fs.access(testSkillPath);

      // another-skill should NOT be rendered
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'another-skill'))
      ).rejects.toThrow();
    });

    it('should error when specified skill not found', async () => {
      const result = kspecFull('skill render --skill nonexistent', tempDir);
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
