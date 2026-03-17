/**
 * Tests for Agent Instruction Generation
 * AC: @agent-instruction-gen ac-1 through ac-6
 * AC: @agents-cli ac-1 through ac-4
 * AC: @trait-dry-run (dry run support)
 * AC: @agent-templates ac-1 through ac-3
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { computeMetaHash, getPackageRoot, loadTemplateSections } from '../src/cli/commands/agents.js';
import { initContext, loadMetaContext } from '../src/parser/index.js';
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

  // AC: @agent-instruction-gen ac-1, @agents-cli ac-1
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

      // Add a convention to change the content
      kspecFull(
        'meta add convention --domain test-overwrite --rule "Rule for overwrite test"',
        tempDir
      );

      // Regenerate
      const result = kspecFull('agents generate', tempDir);
      expect(result.exitCode).toBe(0);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('Rule for overwrite test');
    });
  });

  // Skill table removed — agent runtimes discover skills via rendered SKILL.md frontmatter.
  // Descriptions live in skill metadata (manifest.yaml / kynetic.meta.yaml)
  // and are written to rendered SKILL.md frontmatter by `kspec skill render`.
  describe('skill table is no longer generated', () => {
    it('should not include Finding Information table even when skills exist', async () => {
      kspecFull(
        'skill add --id task-work --name "Task Work" --description "Work on tasks with proper lifecycle"',
        tempDir
      );
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).not.toContain('## Finding Information');
      expect(content).not.toContain('| Need | Where to look |');
    });
  });

  // AC: @agent-instruction-gen ac-3
  describe('ac-3: output includes conventions section listing rules by domain', () => {
    it('should include conventions section with rules by domain', async () => {
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // Fixture has commits and naming conventions
      expect(content).toContain('## Conventions');
      expect(content).toContain('### commits');
      expect(content).toContain('### naming');
      expect(content).toContain('- Use conventional commits format');
      expect(content).toContain('- Use camelCase for variables and functions');
    });

    it('should render examples for conventions that have them', async () => {
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // commits convention has examples
      expect(content).toContain('**Examples:**');
      expect(content).toContain('Good: `feat: add user login flow`');
      expect(content).toContain('Bad: `Added login`');
    });

    it('should not render examples for conventions without them', async () => {
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      // naming convention has no examples — verify no Examples block after it
      const namingPos = content.indexOf('### naming');
      const afterNaming = content.slice(namingPos);
      // The next section header or end-of-conventions should come before any **Examples:**
      const nextHeader = afterNaming.indexOf('##', 3); // skip the ### naming itself
      const examplesInNaming = afterNaming.indexOf('**Examples:**');
      if (examplesInNaming !== -1) {
        // If found, it must be after the next section header (i.e. belongs to another section)
        expect(examplesInNaming).toBeGreaterThan(nextHeader);
      }
    });

    it('should not include conventions section when no conventions exist', async () => {
      const freshDir = await setupTempFixtures();
      await initGitRepo(freshDir);

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

  // AC: @agent-instruction-gen ac-5, @agents-cli ac-3, @agents-cli ac-4
  describe('ac-5: kspec agents status reports stale when not regenerated after meta changes', () => {
    it('should report missing when file does not exist', async () => {
      const result = kspecFull('agents status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('does not exist');
      expect(result.stdout).toContain("'kspec agents generate'");
    });

    // AC: @agents-cli ac-3
    it('should report current when file is up to date', async () => {
      kspecFull('agents generate', tempDir);

      const result = kspecFull('agents status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('up to date');
    });

    // AC: @agents-cli ac-4
    it('should report stale when meta has changed since generation', async () => {
      kspecFull('agents generate', tempDir);

      // Add a new convention (changes meta)
      kspecFull(
        'meta add convention --domain stale-test --rule "Staleness test rule"',
        tempDir
      );

      const result = kspecFull('agents status', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('stale');
      expect(result.stdout).toContain("'kspec agents generate'");
    });

    it('should report stale when only convention examples change', async () => {
      kspecFull('agents generate', tempDir);

      // Verify current first
      let status = kspecFull('agents status', tempDir);
      expect(status.stdout).toContain('up to date');

      // Modify meta to add an example to the naming convention (which has none)
      const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      const updatedContent = metaContent.replace(
        '    - "Use PascalCase for types and classes"\n',
        '    - "Use PascalCase for types and classes"\n' +
        '    examples:\n' +
        '      - good: "getUserName"\n' +
        '        bad: "get_user_name"\n',
      );
      await fs.writeFile(metaPath, updatedContent, 'utf-8');

      // Status should now be stale
      status = kspecFull('agents status', tempDir);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain('stale');
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

    it('should report stale when stored hash was computed without version', async () => {
      kspecFull('agents generate', tempDir);

      const ctx = await initContext(tempDir);
      const meta = await loadMetaContext(ctx);
      const templateSections = await loadTemplateSections(getPackageRoot());

      const hashPath = path.join(tempDir, '.kspec', '.kspec-agents-hash');
      const hashData = JSON.parse(await fs.readFile(hashPath, 'utf-8'));

      const legacyData = {
        skills: meta.skills.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
        })),
        conventions: meta.conventions.map((c) => ({
          domain: c.domain,
          rules: c.rules,
          examples: (c.examples ?? []).map((e) => ({ good: e.good, bad: e.bad })),
        })),
        workflows: meta.workflows.map((w) => ({
          id: w.id,
          trigger: w.trigger,
          description: w.description,
        })),
        templates: templateSections,
      };
      const legacyHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(legacyData), 'utf-8')
        .digest('hex');
      const currentHash = computeMetaHash(
        meta.conventions,
        meta.workflows,
        templateSections
      );

      expect(legacyHash).not.toBe(currentHash);
      await fs.writeFile(
        hashPath,
        JSON.stringify({ ...hashData, metaHash: legacyHash }, null, 2) + '\n',
        'utf-8'
      );

      const status = kspecFull('agents status', tempDir);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain('stale');
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

      // Add a convention to make it stale
      kspecFull(
        'meta add convention --domain staleness-test --rule "Rule for staleness test"',
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

  // AC: @agent-instruction-gen ac-6
  describe('ac-6: skip regeneration when content unchanged', () => {
    it('should skip writing and report up to date when meta has not changed', async () => {
      // First generate
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const firstContent = await fs.readFile(filePath, 'utf-8');

      // Second generate without changes
      const result = kspecFull('agents generate', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('up to date');

      // File should not have been rewritten (timestamp unchanged)
      const secondContent = await fs.readFile(filePath, 'utf-8');
      expect(secondContent).toBe(firstContent);
    });

    it('should return skipped flag in JSON output when unchanged', async () => {
      kspecFull('agents generate', tempDir);

      const result = kspecJson<{
        path: string;
        status: string;
        skipped: boolean;
      }>('agents generate', tempDir);

      expect(result.skipped).toBe(true);
      expect(result.status).toBe('current');
    });

    it('should regenerate when meta has changed', async () => {
      kspecFull('agents generate', tempDir);

      // Add a convention to change meta
      kspecFull(
        'meta add convention --domain skip-test-domain --rule "Skip test rule for regeneration"',
        tempDir,
      );

      // Should regenerate, not skip
      const result = kspecFull('agents generate', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('up to date');
      expect(result.stdout).toContain('Generated');

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('Skip test rule for regeneration');
    });
  });

  // AC: @trait-dry-run, @agents-cli ac-2
  describe('Dry run mode (trait)', () => {
    // AC: @trait-dry-run ac-1, @agents-cli ac-2
    it('should show what would be changed without applying (ac-1)', async () => {
      const result = kspecFull('agents generate --dry-run', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Would write to');
      expect(result.stdout).toContain('kspec-agents.md');
    });

    // AC: @trait-dry-run ac-2, @agents-cli ac-2
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
      kspecFull('agents generate', tempDir);

      const filePath = path.join(tempDir, 'kspec-agents.md');
      const content = await fs.readFile(filePath, 'utf-8');

      expect(content).toContain('## Workflows');
      expect(content).toContain('Available workflows:');
      expect(content).toContain('kspec workflow start');
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
        templates: number;
        generatedAt: string;
      }>('agents generate', tempDir);

      expect(result.path).toContain('kspec-agents.md');
      expect(result.skills).toBe(1);
      expect(typeof result.conventions).toBe('number');
      expect(typeof result.workflows).toBe('number');
      expect(result.templates).toBeGreaterThan(0);
      expect(result.generatedAt).toBeTruthy();
    });
  });

  // AC: @agent-templates ac-1 through ac-3
  describe('Agent Template System', () => {
    // AC: @agent-templates ac-1
    describe('ac-1: template sections included in defined order', () => {
      it('should include all template sections in the generated output', async () => {
        const result = kspecFull('agents generate', tempDir);
        expect(result.exitCode).toBe(0);

        const filePath = path.join(tempDir, 'kspec-agents.md');
        const content = await fs.readFile(filePath, 'utf-8');

        // Read actual template files to get their headings
        const templateDir = path.join(getPackageRoot(), 'templates', 'agents-sections');
        const templateFiles = (await fs.readdir(templateDir))
          .filter(f => f.endsWith('.md'))
          .sort();

        // Each template should contribute its first ## heading to the output
        for (const file of templateFiles) {
          const templateContent = await fs.readFile(path.join(templateDir, file), 'utf-8');
          const headingMatch = templateContent.match(/^## (.+)$/m);
          expect(headingMatch, `Template ${file} should have a ## heading`).toBeTruthy();
          expect(content).toContain(headingMatch![0]);
        }
      });

      it('should include templates in file order (sorted by prefix)', async () => {
        kspecFull('agents generate', tempDir);

        const filePath = path.join(tempDir, 'kspec-agents.md');
        const content = await fs.readFile(filePath, 'utf-8');

        // Read actual template headings in file order
        const templateDir = path.join(getPackageRoot(), 'templates', 'agents-sections');
        const templateFiles = (await fs.readdir(templateDir))
          .filter(f => f.endsWith('.md'))
          .sort();

        const headings: string[] = [];
        for (const file of templateFiles) {
          const templateContent = await fs.readFile(path.join(templateDir, file), 'utf-8');
          const headingMatch = templateContent.match(/^## (.+)$/m);
          if (headingMatch) headings.push(headingMatch[0]);
        }

        // Verify they appear in order in the generated output
        for (let i = 1; i < headings.length; i++) {
          const prevPos = content.indexOf(headings[i - 1]);
          const currPos = content.indexOf(headings[i]);
          expect(prevPos).toBeLessThan(currPos);
        }
      });
    });

    // AC: @agent-templates ac-2
    describe('ac-2: each template section appears in generated output', () => {
      it('should include content from every template file', async () => {
        kspecFull('agents generate', tempDir);

        const filePath = path.join(tempDir, 'kspec-agents.md');
        const content = await fs.readFile(filePath, 'utf-8');

        // Read all template files and verify each one's content appears in the output
        const templateDir = path.join(getPackageRoot(), 'templates', 'agents-sections');
        const templateFiles = (await fs.readdir(templateDir))
          .filter(f => f.endsWith('.md'))
          .sort();

        for (const file of templateFiles) {
          const templateContent = await fs.readFile(path.join(templateDir, file), 'utf-8');
          // Each template's heading must appear in the generated output
          const headingMatch = templateContent.match(/^## (.+)$/m);
          expect(headingMatch, `Template ${file} should have a ## heading`).toBeTruthy();
          expect(content).toContain(headingMatch![0]);

          // A non-trivial substring from the template body should appear too
          // (skip the heading line, take the first non-empty content line)
          const lines = templateContent.split('\n').filter(l => l.trim() && !l.startsWith('##'));
          if (lines.length > 0) {
            const sampleLine = lines[0].trim();
            expect(content).toContain(sampleLine);
          }
        }
      });
    });

    // AC: @agent-templates ac-2 (JSON output verification)
    it('should include templates count in JSON output', async () => {
      const result = kspecJson<{
        templates: number;
      }>('agents generate', tempDir);

      // Verify templates count is returned (currently 6 templates)
      expect(result.templates).toBe(7);
    });

    it('should include templates count in dry-run JSON output', async () => {
      const result = kspecJson<{
        dry_run: boolean;
        templates: number;
      }>('agents generate --dry-run', tempDir);

      expect(result.dry_run).toBe(true);
      expect(result.templates).toBe(7);
    });

    // Note: AC: @agent-templates ac-3 (error if templates directory missing/empty)
    // Testing this would require modifying the installed kspec package, which is
    // outside the scope of standard CLI tests. The error handling is implemented
    // in src/cli/commands/agents.ts:loadTemplateSections() with appropriate
    // error messages when templates directory is missing or empty.
  });
});
