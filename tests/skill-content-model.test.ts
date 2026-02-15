/**
 * Tests for Skill File-Based Content Model
 * AC: @skill-content-model ac-1, ac-2, ac-3
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { createTempDir, cleanupTempDir, testUlid, initGitRepo } from './helpers/cli';
import {
  loadSkillContent,
  loadSkillDocs,
  getSkillContentPath,
  getSkillDocsPath,
} from '../src/parser/meta';
import { validate } from '../src/parser/validate';
import { initContext, type KspecContext } from '../src/parser/yaml';

describe('Skill File-Based Content Model', () => {
  let tempDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await initGitRepo(tempDir);
    ctx = {
      specDir: tempDir,
      manifestPath: path.join(tempDir, 'kynetic.yaml'),
      rootPath: tempDir,
    };

    // Create minimal manifest
    await fs.writeFile(
      path.join(tempDir, 'kynetic.yaml'),
      yamlStringify({ kynetic: '1.0', includes: [] }),
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('loadSkillContent (ac-1)', () => {
    // AC: @skill-content-model ac-1
    it('should return markdown content as a string when SKILL.md exists', async () => {
      const skillId = 'task-work';
      const skillUlid = testUlid('SKCNT1');

      // Create skill directory and SKILL.md file
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });

      const skillContent = `# Task Work Skill

This is the task work skill content.

## Usage

\`\`\`bash
kspec workflow start @task-work
\`\`\`

## When to Use

- Starting work on a ready task
- Ensuring consistent task lifecycle
`;
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent);

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Task Work',
        origin: 'core' as const,
        tags: [],
      };

      const content = await loadSkillContent(ctx, skill);
      expect(content).toBe(skillContent);
    });

    // AC: @skill-content-model ac-1
    it('should return the exact content of SKILL.md', async () => {
      const skillId = 'simple-skill';
      const skillUlid = testUlid('SKCNT2');

      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });

      const skillContent = '# Simple\n\nJust some content.';
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent);

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Simple Skill',
        origin: 'project' as const,
        tags: [],
      };

      const content = await loadSkillContent(ctx, skill);
      expect(content).toBe(skillContent);
    });

    it('should return null when SKILL.md does not exist', async () => {
      const skill = {
        _ulid: testUlid('SKNONE'),
        id: 'nonexistent-skill',
        name: 'Nonexistent Skill',
        origin: 'core' as const,
        tags: [],
      };

      const content = await loadSkillContent(ctx, skill);
      expect(content).toBeNull();
    });

    it('should use correct path for skill content', () => {
      const skillPath = getSkillContentPath(ctx, 'my-skill');
      expect(skillPath).toBe(path.join(tempDir, 'skills', 'my-skill', 'SKILL.md'));
    });
  });

  describe('loadSkillDocs (ac-2)', () => {
    // AC: @skill-content-model ac-2
    it('should return an array of doc objects with matching file names', async () => {
      const skillId = 'task-work';
      const skillUlid = testUlid('SKDOC1');

      // Create skill directory and docs subdirectory
      const skillDir = path.join(tempDir, 'skills', skillId);
      const docsDir = path.join(skillDir, 'docs');
      await fs.mkdir(docsDir, { recursive: true });

      // Create SKILL.md
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Task Work');

      // Create docs files
      const quickrefContent = '# Quick Reference\n\nKey commands:\n- `kspec task start`';
      const examplesContent = '# Examples\n\nExample 1:\n```bash\nkspec task note @task "note"```';

      await fs.writeFile(path.join(docsDir, 'quickref.md'), quickrefContent);
      await fs.writeFile(path.join(docsDir, 'examples.md'), examplesContent);

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Task Work',
        origin: 'core' as const,
        tags: [],
      };

      const docs = await loadSkillDocs(ctx, skill);

      expect(docs).toHaveLength(2);

      // Find the quickref doc
      const quickref = docs.find(d => d.name === 'quickref.md');
      expect(quickref).toBeDefined();
      expect(quickref?.content).toBe(quickrefContent);
      expect(quickref?.path).toBe(path.join(docsDir, 'quickref.md'));

      // Find the examples doc
      const examples = docs.find(d => d.name === 'examples.md');
      expect(examples).toBeDefined();
      expect(examples?.content).toBe(examplesContent);
    });

    // AC: @skill-content-model ac-2
    it('should only return markdown files from docs directory', async () => {
      const skillId = 'filtered-skill';
      const skillUlid = testUlid('SKDOC2');

      const skillDir = path.join(tempDir, 'skills', skillId);
      const docsDir = path.join(skillDir, 'docs');
      await fs.mkdir(docsDir, { recursive: true });

      // Create various file types
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide');
      await fs.writeFile(path.join(docsDir, 'data.json'), '{}');
      await fs.writeFile(path.join(docsDir, 'config.yaml'), 'key: value');
      await fs.writeFile(path.join(docsDir, 'readme.txt'), 'text file');

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Filtered Skill',
        origin: 'local' as const,
        tags: [],
      };

      const docs = await loadSkillDocs(ctx, skill);

      // Should only return the .md file
      expect(docs).toHaveLength(1);
      expect(docs[0].name).toBe('guide.md');
    });

    it('should return empty array when docs directory does not exist', async () => {
      const skill = {
        _ulid: testUlid('SKNODS'),
        id: 'no-docs-skill',
        name: 'No Docs Skill',
        origin: 'core' as const,
        tags: [],
      };

      const docs = await loadSkillDocs(ctx, skill);
      expect(docs).toEqual([]);
    });

    it('should return empty array when docs directory is empty', async () => {
      const skillId = 'empty-docs-skill';
      const skillUlid = testUlid('SKEMPT');

      const docsDir = path.join(tempDir, 'skills', skillId, 'docs');
      await fs.mkdir(docsDir, { recursive: true });

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Empty Docs Skill',
        origin: 'core' as const,
        tags: [],
      };

      const docs = await loadSkillDocs(ctx, skill);
      expect(docs).toEqual([]);
    });

    it('should use correct path for docs directory', () => {
      const docsPath = getSkillDocsPath(ctx, 'test-skill');
      expect(docsPath).toBe(path.join(tempDir, 'skills', 'test-skill', 'docs'));
    });
  });

  describe('validation for missing SKILL.md (ac-3)', () => {
    // AC: @skill-content-model ac-3
    it('should report validation error when skill meta entry has no SKILL.md file', async () => {
      const skillUlid = testUlid('SKVALD');

      // Create meta manifest with a skill but NO corresponding SKILL.md
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'missing-content-skill',
            name: 'Missing Content Skill',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      // Use initContext to properly set up the context including rootDir
      const validationCtx = await initContext(tempDir);

      const result = await validate(validationCtx);

      // Should have a schema error for the missing content file
      const missingContentError = result.schemaErrors.find(
        err => err.message.includes('missing content file') ||
               err.message.includes('missing-content-skill'),
      );
      expect(missingContentError).toBeDefined();
      expect(missingContentError?.message).toContain('missing-content-skill');
    });

    // AC: @skill-content-model ac-3
    it('should pass validation when skill meta entry has corresponding SKILL.md file', async () => {
      const skillUlid = testUlid('SKVPAS');
      const skillId = 'valid-skill';

      // Create skill directory and SKILL.md
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Valid Skill\n\nContent here.');

      // Create meta manifest with the skill
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: skillId,
            name: 'Valid Skill',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      // Use initContext to properly set up the context including rootDir
      const validationCtx = await initContext(tempDir);

      const result = await validate(validationCtx);

      // Should not have any skill content errors
      const skillContentErrors = result.schemaErrors.filter(
        err => err.message.includes('missing content file') ||
               err.path?.includes('skills'),
      );
      expect(skillContentErrors).toHaveLength(0);
    });

    // AC: @skill-content-model ac-3
    it('should report multiple errors when multiple skills are missing SKILL.md', async () => {
      const skill1Ulid = testUlid('SKMLT1');
      const skill2Ulid = testUlid('SKMLT2');

      // Create meta manifest with two skills but no SKILL.md files
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skill1Ulid,
            id: 'skill-one',
            name: 'Skill One',
            origin: 'core',
          },
          {
            _ulid: skill2Ulid,
            id: 'skill-two',
            name: 'Skill Two',
            origin: 'project',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      // Use initContext to properly set up the context including rootDir
      const validationCtx = await initContext(tempDir);

      const result = await validate(validationCtx);

      // Should have errors for both missing content files
      const missingContentErrors = result.schemaErrors.filter(
        err => err.message.includes('missing content file'),
      );
      expect(missingContentErrors).toHaveLength(2);
      expect(missingContentErrors.some(e => e.message.includes('skill-one'))).toBe(true);
      expect(missingContentErrors.some(e => e.message.includes('skill-two'))).toBe(true);
    });
  });
});
