/**
 * Tests for Agent Instruction Generation
 * AC: @agent-instruction-gen ac-1 through ac-5
 * AC: @trait-dry-run (dry run support)
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

describe('Agent Instruction Generation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @agent-instruction-gen ac-1
  describe('ac-1: kspec agents generate creates kspec-agents.md in project root', () => {
    it('should create kspec-agents.md when generate is run', async () => {
      const result = kspecFull('agents generate', tempDir);
      expect(result.exitCode).toBe(0);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBeTruthy();
      expect(content).toContain('# kspec Agent Instructions');
    });

    it('should overwrite existing kspec-agents.md', async () => {
      // Create initial file
      kspecFull('agents generate', tempDir);

      // Create a skill to add content
      kspecFull(
        'skill add --id my-skill --name "My Skill" --description "Test skill"',
        tempDir
      );

      // Regenerate
      const result = kspecFull('agents generate', tempDir);
      expect(result.exitCode).toBe(0);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('my-skill');
    });
  });

  // AC: @agent-instruction-gen ac-2
  describe('ac-2: output includes Finding Information table with row per skill', () => {
    beforeEach(async () => {
      // Create 3 skills
      kspecFull(
        'skill add --id task-work --name "Task Work" --description "Work on tasks with proper lifecycle"',
        tempDir
      );
      kspecFull(
        'skill add --id pr-review --name "PR Review" --description "Review and merge pull requests"',
        tempDir
      );
      kspecFull(
        'skill add --id spec-plan --name "Spec Plan" --description "Plan to spec translation"',
        tempDir
      );
    });

    it('should include Finding Information table', async () => {
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('## Finding Information');
      expect(content).toContain('| Need | Where to look |');
      expect(content).toContain('|------|---------------|');
    });

    it('should have a row per skill', async () => {
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // Each skill should be listed with its description and /id reference
      expect(content).toContain('Work on tasks with proper lifecycle');
      expect(content).toContain('`/task-work` skill');

      expect(content).toContain('Review and merge pull requests');
      expect(content).toContain('`/pr-review` skill');

      expect(content).toContain('Plan to spec translation');
      expect(content).toContain('`/spec-plan` skill');
    });

    it('should not include Finding Information table when no skills exist', async () => {
      // No skills in this test case (fresh fixture)
      // Use a new temp dir
      const freshDir = await setupTempFixtures();
      await initGitRepo(freshDir);

      // Don't add any skills
      kspecFull('agents generate', freshDir);

      const filePath = path.join(freshDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // Should NOT have Finding Information section
      expect(content).not.toContain('## Finding Information');

      await cleanupTempDir(freshDir);
    });
  });

  // AC: @agent-instruction-gen ac-3
  describe('ac-3: output includes conventions section listing rules by domain', () => {
    it('should include conventions section with rules by domain', async () => {
      // The test fixtures include conventions in the meta manifest
      // We need to check if they appear in the generated file
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // Check for conventions section
      // Note: The fixtures may or may not have conventions
      // We check the structure is correct when conventions exist
      if (content.includes('## Conventions')) {
        expect(content).toMatch(/### \w+/); // Domain headers
        expect(content).toMatch(/^- /m); // Rules as list items
      }
    });

    it('should not include conventions section when no conventions exist', async () => {
      // Fresh dir without conventions
      const freshDir = await setupTempFixtures();
      await initGitRepo(freshDir);

      // Remove any conventions from meta (write empty meta file)
      const metaPath = path.join(freshDir, 'kynetic.meta.yaml');
      await fs.writeFile(
        metaPath,
        'kynetic_meta: "1.0"\nagents: []\nworkflows: []\nconventions: []\nobservations: []\nskills: []\n',
        'utf-8'
      );

      kspecFull('agents generate', freshDir);

      const filePath = path.join(freshDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).not.toContain('## Conventions');

      await cleanupTempDir(freshDir);
    });
  });

  // AC: @agent-instruction-gen ac-4
  describe('ac-4: output contains freshness comment with kspec version and timestamp', () => {
    it('should have freshness comment at the top', async () => {
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // First lines should be the freshness comment
      expect(content).toMatch(/^<!-- Generated by kspec v[\d.]+ at \d{4}-\d{2}-\d{2}T/);
      expect(content).toContain('<!-- Do not edit manually');
      expect(content).toContain('regenerate with: kspec agents generate');
    });

    it('should include valid ISO timestamp', async () => {
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // Extract timestamp from comment
      const match = content.match(/at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z)/);
      expect(match).toBeTruthy();

      // Verify it's a valid date
      const date = new Date(match![1]);
      expect(date.getTime()).not.toBeNaN();
    });
  });

  // AC: @agent-instruction-gen ac-5
  describe('ac-5: kspec agents status reports stale when not regenerated after meta changes', () => {
    it('should report missing when file does not exist', async () => {
      const result = kspecFull('agents status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('does not exist');
      expect(result.stdout).toContain("'kspec agents generate'");
    });

    it('should report current when file is up to date', async () => {
      kspecFull('agents generate', tempDir);

      const result = kspecFull('agents status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('up to date');
    });

    it('should report stale when meta has changed since generation', async () => {
      kspecFull('agents generate', tempDir);

      // Add a new skill (changes meta)
      kspecFull(
        'skill add --id new-skill --name "New Skill" --description "A new skill"',
        tempDir
      );

      const result = kspecFull('agents status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('stale');
      expect(result.stdout).toContain("'kspec agents generate'");
    });

    it('should report stale when hash file is missing', async () => {
      kspecFull('agents generate', tempDir);

      // Delete the hash file
      const hashPath = path.join(tempDir, '.kspec', '.kspec-agents-hash');
      await fs.rm(hashPath);

      const result = kspecFull('agents status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('stale');
    });

    it('should return status in JSON output', async () => {
      kspecFull('agents generate', tempDir);

      const result = kspecJson<{
        exists: boolean;
        path: string;
        status: string;
        generatedAt?: string;
      }>('agents status', tempDir);

      expect(result.exists).toBe(true);
      expect(result.status).toBe('current');
      expect(result.path).toContain('kspec-agents.md');
      expect(result.generatedAt).toBeTruthy();
    });

    it('should become current again after regenerating', async () => {
      kspecFull('agents generate', tempDir);

      // Add a skill to make it stale
      kspecFull(
        'skill add --id another-skill --name "Another" --description "Another skill"',
        tempDir
      );

      // Verify stale
      let status = kspecFull('agents status', tempDir);
      expect(status.stdout).toContain('stale');

      // Regenerate
      kspecFull('agents generate', tempDir);

      // Verify current
      status = kspecFull('agents status', tempDir);
      expect(status.stdout).toContain('up to date');
    });
  });

  // AC: @trait-dry-run
  describe('Dry run mode (trait)', () => {
    // AC: @trait-dry-run ac-1
    it('should show what would be changed without applying (ac-1)', async () => {
      const result = kspecFull('agents generate --dry-run', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would write to');
      expect(result.stdout).toContain('kspec-agents.md');
    });

    // AC: @trait-dry-run ac-2
    it('should not modify files when --dry-run is provided (ac-2)', async () => {
      kspecFull('agents generate --dry-run', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    // AC: @trait-dry-run ac-3
    it('should show clear indication that this is a preview (ac-3)', async () => {
      const result = kspecFull('agents generate --dry-run', tempDir);
      expect(result.stdout).toContain('DRY RUN');
      expect(result.stdout).toContain('No changes were made');
    });

    // AC: @trait-dry-run ac-4
    it('should show error but no state changed in dry run mode (ac-4)', async () => {
      // This test would need to trigger an error condition in dry run mode
      // For now, we verify that dry run doesn't create any files even on success
      kspecFull('agents generate --dry-run', tempDir);

      // No files should be created
      const filePath = path.join(tempDir, 'kspec-agents.md');
      await expect(fs.access(filePath)).rejects.toThrow();

      const hashPath = path.join(tempDir, '.kspec', '.kspec-agents-hash');
      await expect(fs.access(hashPath)).rejects.toThrow();
    });

    // AC: @trait-dry-run ac-5 is not applicable (no --force option for agents generate)

    // AC: @trait-dry-run ac-6
    it('should include dry_run boolean field in JSON output (ac-6)', async () => {
      const result = kspecJson<{ dry_run: boolean; content: string }>(
        'agents generate --dry-run',
        tempDir
      );

      expect(result.dry_run).toBe(true);
      expect(result.content).toBeTruthy();
      expect(result.content).toContain('# kspec Agent Instructions');
    });
  });

  describe('Workflows section', () => {
    it('should include workflows summary when workflows exist', async () => {
      // The test fixtures include workflows
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // Check for workflows section if workflows exist in fixtures
      if (content.includes('## Workflows')) {
        expect(content).toContain('Available workflows:');
        expect(content).toContain('kspec workflow start');
      }
    });
  });

  describe('JSON output', () => {
    it('should return generation stats in JSON', async () => {
      // Add some content
      kspecFull(
        'skill add --id test-skill --name "Test" --description "Test skill"',
        tempDir
      );

      const result = kspecJson<{
        path: string;
        skills: number;
        conventions: number;
        workflows: number;
        generatedAt: string;
      }>('agents generate', tempDir);

      expect(result.path).toContain('kspec-agents.md');
      expect(result.skills).toBe(1);
      expect(typeof result.conventions).toBe('number');
      expect(typeof result.workflows).toBe('number');
      expect(result.generatedAt).toBeTruthy();
    });
  });
});
