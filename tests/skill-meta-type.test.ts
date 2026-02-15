/**
 * Tests for Skill Meta Type
 * AC: @skill-meta-type ac-1 through ac-7
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { createTempDir, cleanupTempDir, testUlid, initGitRepo } from './helpers/cli';
import {
  loadMetaContext,
  loadSkillContent,
  findMetaItemByRef,
  getSkillContentPath,
} from '../src/parser/meta';
import { getMetaItemType, MetaManifestSchema, SkillSchema } from '../src/schema/meta';
import type { KspecContext } from '../src/parser/yaml';

describe('Skill Meta Type', () => {
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
      yamlStringify({ kynetic: '1.0' }),
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('SkillSchema validation', () => {
    // AC: @skill-meta-type ac-1
    it('should validate skill entries via MetaManifestSchema', () => {
      const skillUlid = testUlid('SKTEST');
      const manifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'task-work',
            name: 'Task Work',
            description: 'Work on kspec tasks',
            origin: 'core',
            version: '0.2.0',
            tags: ['workflow'],
          },
        ],
      };

      const result = MetaManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skills).toHaveLength(1);
        expect(result.data.skills[0].id).toBe('task-work');
        expect(result.data.skills[0].origin).toBe('core');
      }
    });

    // AC: @skill-meta-type ac-2
    it('should validate skill with origin core and version', () => {
      const skillUlid = testUlid('SKCORE');
      const skill = {
        _ulid: skillUlid,
        id: 'pr-review',
        name: 'PR Review',
        origin: 'core',
        version: '0.2.0',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.origin).toBe('core');
        expect(result.data.version).toBe('0.2.0');
      }
    });

    it('should accept origin values: core, project, local', () => {
      const baseSkill = {
        _ulid: testUlid('SKORIG'),
        id: 'test-skill',
        name: 'Test Skill',
      };

      for (const origin of ['core', 'project', 'local']) {
        const result = SkillSchema.safeParse({ ...baseSkill, origin, _ulid: testUlid('SK' + origin.toUpperCase().slice(0, 3)) });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.origin).toBe(origin);
        }
      }
    });

    it('should reject invalid origin values', () => {
      const skill = {
        _ulid: testUlid('SKBAD'),
        id: 'bad-skill',
        name: 'Bad Skill',
        origin: 'invalid',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
    });

    it('should require id and name fields', () => {
      const skillNoId = {
        _ulid: testUlid('SKNOID'),
        name: 'No ID Skill',
        origin: 'core',
      };

      const skillNoName = {
        _ulid: testUlid('SKNONA'),
        id: 'no-name',
        origin: 'core',
      };

      expect(SkillSchema.safeParse(skillNoId).success).toBe(false);
      expect(SkillSchema.safeParse(skillNoName).success).toBe(false);
    });
  });

  describe('loadSkillContent', () => {
    // AC: @skill-meta-type ac-3
    it('should return full markdown content of SKILL.md', async () => {
      const skillId = 'my-skill';
      const skillUlid = testUlid('SKLCNT');

      // Create skill directory and SKILL.md file
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });

      const skillContent = `# My Skill

This is the skill content.

## Usage

Some usage instructions.
`;
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent);

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'My Skill',
        origin: 'core' as const,
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
      const skillPath = getSkillContentPath(ctx, 'test-skill');
      expect(skillPath).toBe(path.join(tempDir, 'skills', 'test-skill', 'SKILL.md'));
    });
  });

  describe('loadMetaContext with skills', () => {
    // AC: @skill-meta-type ac-4
    it('should load skills into MetaContext with _sourceFile set', async () => {
      const skill1Ulid = testUlid('SK001');
      const skill2Ulid = testUlid('SK002');
      const skill3Ulid = testUlid('SK003');

      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skill1Ulid,
            id: 'skill-one',
            name: 'Skill One',
            origin: 'core',
            version: '0.1.0',
          },
          {
            _ulid: skill2Ulid,
            id: 'skill-two',
            name: 'Skill Two',
            origin: 'project',
          },
          {
            _ulid: skill3Ulid,
            id: 'skill-three',
            name: 'Skill Three',
            origin: 'local',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      expect(meta.skills).toHaveLength(3);

      // Verify _sourceFile is set for all skills
      for (const skill of meta.skills) {
        expect(skill._sourceFile).toBe(path.join(tempDir, 'kynetic.meta.yaml'));
      }

      // Verify skill data
      const skillOne = meta.skills.find(s => s.id === 'skill-one');
      expect(skillOne).toBeDefined();
      expect(skillOne?.origin).toBe('core');
      expect(skillOne?.version).toBe('0.1.0');
    });

    it('should return empty skills array when no skills defined', async () => {
      const metaManifest = {
        kynetic_meta: '1.0',
        agents: [],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      expect(meta.skills).toEqual([]);
    });
  });

  describe('findMetaItemByRef for skills', () => {
    // AC: @skill-meta-type ac-5
    it('should return skill by semantic id lookup', async () => {
      const skillUlid = testUlid('SKTW01');
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'task-work',
            name: 'Task Work',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const found = findMetaItemByRef(meta, 'task-work');
      expect(found).toBeDefined();
      expect('id' in found! && found.id).toBe('task-work');
      expect('origin' in found! && found.origin).toBe('core');
    });

    // AC: @skill-meta-type ac-6
    it('should return skill by ULID prefix lookup', async () => {
      const skillUlid = testUlid('SKTW02');
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'task-work',
            name: 'Task Work',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      // Use first 8 chars of the generated ULID as prefix
      const found = findMetaItemByRef(meta, skillUlid.slice(0, 8));
      expect(found).toBeDefined();
      expect('id' in found! && found.id).toBe('task-work');
    });

    it('should return skill by full ULID', async () => {
      const skillUlid = testUlid('SKTW03');
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'task-work',
            name: 'Task Work',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const found = findMetaItemByRef(meta, skillUlid);
      expect(found).toBeDefined();
      expect('id' in found! && found.id).toBe('task-work');
    });

    it('should return skill with @ prefix', async () => {
      const skillUlid = testUlid('SKTW04');
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'task-work',
            name: 'Task Work',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const found = findMetaItemByRef(meta, '@task-work');
      expect(found).toBeDefined();
      expect('id' in found! && found.id).toBe('task-work');
    });

    it('should return undefined for non-existent ref', async () => {
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const found = findMetaItemByRef(meta, 'nonexistent');
      expect(found).toBeUndefined();
    });
  });

  describe('getMetaItemType for skills', () => {
    // AC: @skill-meta-type ac-7
    it('should return skill for item with origin field', () => {
      const skill = {
        _ulid: testUlid('SKTYPE'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core' as const,
        tags: [],
      };

      const itemType = getMetaItemType(skill);
      expect(itemType).toBe('skill');
    });

    it('should correctly discriminate skill from other meta types', () => {
      const agent = {
        _ulid: testUlid('AGTYPE'),
        id: 'test-agent',
        name: 'Test Agent',
        capabilities: [],
        tools: [],
        conventions: [],
      };

      const workflow = {
        _ulid: testUlid('WFTYPE'),
        id: 'test-workflow',
        trigger: 'on command',
        steps: [],
      };

      const convention = {
        _ulid: testUlid('CVTYPE'),
        domain: 'test-convention',
        rules: [],
        examples: [],
      };

      const observation = {
        _ulid: testUlid('OBTYPE'),
        type: 'friction' as const,
        content: 'Test observation',
        created_at: new Date().toISOString(),
        resolved: false,
      };

      const skill = {
        _ulid: testUlid('SKTYPE'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core' as const,
        tags: [],
      };

      expect(getMetaItemType(agent)).toBe('agent');
      expect(getMetaItemType(workflow)).toBe('workflow');
      expect(getMetaItemType(convention)).toBe('convention');
      expect(getMetaItemType(observation)).toBe('observation');
      expect(getMetaItemType(skill)).toBe('skill');
    });
  });
});
