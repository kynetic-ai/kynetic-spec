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
  resolveMetaRef,
  getSkillContentPath,
} from '../src/parser/meta';
import { getMetaItemType, isSkill, MetaManifestSchema, SkillSchema } from '../src/schema/meta';
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
        _type: 'skill' as const,
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
        _type: 'skill' as const,
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

  describe('resolveMetaRef', () => {
    it('should resolve skill by semantic id and return item, type, and ulid', async () => {
      const skillUlid = testUlid('SKRESL');
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'resolve-test',
            name: 'Resolve Test',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const resolved = resolveMetaRef(meta, 'resolve-test');

      expect(resolved).not.toBeNull();
      expect(resolved?.type).toBe('skill');
      expect(resolved?.ulid).toBe(skillUlid);
      expect('id' in resolved!.item && resolved!.item.id).toBe('resolve-test');
    });

    it('should resolve agent and return correct type', async () => {
      const agentUlid = testUlid('AGRES1');
      const metaManifest = {
        kynetic_meta: '1.0',
        agents: [
          {
            _ulid: agentUlid,
            id: 'test-agent',
            name: 'Test Agent',
            capabilities: ['search'],
            tools: [],
            conventions: [],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const resolved = resolveMetaRef(meta, 'test-agent');

      expect(resolved).not.toBeNull();
      expect(resolved?.type).toBe('agent');
      expect(resolved?.ulid).toBe(agentUlid);
    });

    it('should resolve workflow by id', async () => {
      const workflowUlid = testUlid('WFRES1');
      const metaManifest = {
        kynetic_meta: '1.0',
        workflows: [
          {
            _ulid: workflowUlid,
            id: 'test-workflow',
            trigger: 'manual',
            steps: [],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const resolved = resolveMetaRef(meta, 'test-workflow');

      expect(resolved).not.toBeNull();
      expect(resolved?.type).toBe('workflow');
      expect(resolved?.ulid).toBe(workflowUlid);
    });

    it('should resolve convention by domain', async () => {
      const convUlid = testUlid('CVRES1');
      const metaManifest = {
        kynetic_meta: '1.0',
        conventions: [
          {
            _ulid: convUlid,
            domain: 'testing',
            rules: ['Always test'],
            examples: [],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const resolved = resolveMetaRef(meta, 'testing');

      expect(resolved).not.toBeNull();
      expect(resolved?.type).toBe('convention');
      expect(resolved?.ulid).toBe(convUlid);
    });

    it('should resolve observation by ULID prefix', async () => {
      const obsUlid = testUlid('OBSRES');
      const metaManifest = {
        kynetic_meta: '1.0',
        observations: [
          {
            _ulid: obsUlid,
            type: 'friction',
            content: 'Test observation',
            created_at: new Date().toISOString(),
            resolved: false,
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const resolved = resolveMetaRef(meta, obsUlid.slice(0, 8));

      expect(resolved).not.toBeNull();
      expect(resolved?.type).toBe('observation');
      expect(resolved?.ulid).toBe(obsUlid);
    });

    it('should return null for non-existent ref', async () => {
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const resolved = resolveMetaRef(meta, 'nonexistent');

      expect(resolved).toBeNull();
    });

    it('should strip @ prefix from ref', async () => {
      const skillUlid = testUlid('SKPREFIX');
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'prefix-test',
            name: 'Prefix Test',
            origin: 'project',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const resolved = resolveMetaRef(meta, '@prefix-test');

      expect(resolved).not.toBeNull();
      expect(resolved?.type).toBe('skill');
    });

    it('should be case-insensitive for ULID prefix matching', async () => {
      const skillUlid = testUlid('SKCASE');
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: 'case-test',
            name: 'Case Test',
            origin: 'local',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      // Test with lowercase prefix
      const resolved = resolveMetaRef(meta, skillUlid.slice(0, 8).toLowerCase());

      expect(resolved).not.toBeNull();
      expect(resolved?.type).toBe('skill');
    });
  });

  describe('isSkill type guard', () => {
    // AC: @skill-type-guard ac-1 - isSkill returns true for skill items
    it('should return true for items with _type: skill', () => {
      const skill = {
        _ulid: testUlid('SKGARD'),
        _type: 'skill' as const,
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core' as const,
        tags: [],
      };

      expect(isSkill(skill)).toBe(true);
    });

    // AC: @skill-type-guard ac-2 - isSkill returns false for non-skill items
    it('should return false for items without _type: skill', () => {
      const agent = {
        _ulid: testUlid('AGSKIP'),
        id: 'test-agent',
        name: 'Test Agent',
        capabilities: [],
        tools: [],
        conventions: [],
      };

      const workflow = {
        _ulid: testUlid('WFSKIP'),
        id: 'test-workflow',
        trigger: 'on command',
        steps: [],
      };

      const convention = {
        _ulid: testUlid('CVSKIP'),
        domain: 'test-convention',
        rules: [],
        examples: [],
      };

      const observation = {
        _ulid: testUlid('OBSKIP'),
        type: 'friction' as const,
        content: 'Test observation',
        created_at: new Date().toISOString(),
        resolved: false,
      };

      expect(isSkill(agent)).toBe(false);
      expect(isSkill(workflow)).toBe(false);
      expect(isSkill(convention)).toBe(false);
      expect(isSkill(observation)).toBe(false);
    });

    // AC: @skill-type-guard ac-3 - isSkill handles edge cases safely
    it('should handle edge cases safely', () => {
      expect(isSkill(null)).toBe(false);
      expect(isSkill(undefined)).toBe(false);
      expect(isSkill('string')).toBe(false);
      expect(isSkill(123)).toBe(false);
      expect(isSkill({})).toBe(false);
      expect(isSkill({ _type: 'agent' })).toBe(false);
      expect(isSkill({ _type: 'observation' })).toBe(false);
    });

    // AC: @skill-type-guard ac-4 - isSkill works with parsed schema data
    it('should work with SkillSchema.parse() output', () => {
      const skillData = {
        _ulid: testUlid('SKSHEM'),
        id: 'schema-test',
        name: 'Schema Test Skill',
        origin: 'project' as const,
      };

      const parsed = SkillSchema.parse(skillData);
      expect(isSkill(parsed)).toBe(true);
      expect(parsed._type).toBe('skill');
    });

    // AC: @skill-type-guard ac-5 - backward compatibility with origin field
    it('should correctly identify skill items that have origin but were parsed through schema', () => {
      // Items without _type but with origin need to be parsed through schema to get _type
      const rawSkillData = {
        _ulid: testUlid('SKBACK'),
        id: 'backward-compat',
        name: 'Backward Compatible Skill',
        origin: 'local' as const,
        // No _type field - simulating old YAML file
      };

      // Before parsing, isSkill returns false (no _type)
      expect(isSkill(rawSkillData)).toBe(false);

      // After parsing through schema, isSkill returns true
      const parsed = SkillSchema.parse(rawSkillData);
      expect(isSkill(parsed)).toBe(true);
      expect(parsed._type).toBe('skill');
    });
  });
});
