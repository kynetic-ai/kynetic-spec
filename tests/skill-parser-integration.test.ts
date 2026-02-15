/**
 * Tests for Skill Parser Integration
 * AC: @skill-parser ac-1 through ac-6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { createTempDir, cleanupTempDir, testUlid, initGitRepo } from './helpers/cli';
import {
  loadMetaContext,
  saveMetaItem,
  deleteMetaItem,
  getMetaStats,
  isMetaItemType,
  type LoadedSkill,
} from '../src/parser/meta';
import type { KspecContext } from '../src/parser/yaml';
import { readYamlFile } from '../src/parser/yaml';
import type { MetaManifest } from '../src/schema/meta';

describe('Skill Parser Integration', () => {
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

  describe('saveMetaItem for skills', () => {
    // AC: @skill-parser ac-1
    it('should append skill to manifest.skills and write to disk', async () => {
      const skillUlid = testUlid('SKSAVE');
      const skill: LoadedSkill = {
        _ulid: skillUlid,
        id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
        origin: 'project',
        tags: ['testing'],
      };

      await saveMetaItem(ctx, skill, 'skill');

      // Verify manifest was written
      const manifestPath = path.join(tempDir, 'kynetic.meta.yaml');
      const raw = await readYamlFile<MetaManifest>(manifestPath);

      expect(raw.skills).toHaveLength(1);
      expect(raw.skills[0].id).toBe('test-skill');
      expect(raw.skills[0].name).toBe('Test Skill');
      expect(raw.skills[0].origin).toBe('project');
    });

    // AC: @skill-parser ac-2
    it('should create .kspec/skills/<id>/ directory when saving a skill', async () => {
      const skillUlid = testUlid('SKDIR');
      const skill: LoadedSkill = {
        _ulid: skillUlid,
        id: 'my-new-skill',
        name: 'My New Skill',
        origin: 'local',
        tags: [],
      };

      await saveMetaItem(ctx, skill, 'skill');

      // Verify directory was created
      const skillDir = path.join(tempDir, 'skills', 'my-new-skill');
      const stat = await fs.stat(skillDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should update existing skill when saving with same ULID', async () => {
      const skillUlid = testUlid('SKUPDT');
      const skill: LoadedSkill = {
        _ulid: skillUlid,
        id: 'update-skill',
        name: 'Original Name',
        origin: 'core',
        tags: [],
      };

      await saveMetaItem(ctx, skill, 'skill');

      // Update the skill
      const updatedSkill: LoadedSkill = {
        _ulid: skillUlid,
        id: 'update-skill',
        name: 'Updated Name',
        origin: 'core',
        version: '1.0.0',
        tags: ['updated'],
      };

      await saveMetaItem(ctx, updatedSkill, 'skill');

      // Verify only one skill exists with updated data
      const manifestPath = path.join(tempDir, 'kynetic.meta.yaml');
      const raw = await readYamlFile<MetaManifest>(manifestPath);

      expect(raw.skills).toHaveLength(1);
      expect(raw.skills[0].name).toBe('Updated Name');
      expect(raw.skills[0].version).toBe('1.0.0');
      expect(raw.skills[0].tags).toEqual(['updated']);
    });

    it('should strip _sourceFile metadata before saving', async () => {
      const skillUlid = testUlid('SKSTRP');
      const skill: LoadedSkill = {
        _ulid: skillUlid,
        id: 'strip-test',
        name: 'Strip Test',
        origin: 'project',
        _sourceFile: '/some/path/file.yaml',
        tags: [],
      };

      await saveMetaItem(ctx, skill, 'skill');

      // Verify _sourceFile is not in the saved file
      const manifestPath = path.join(tempDir, 'kynetic.meta.yaml');
      const content = await fs.readFile(manifestPath, 'utf-8');
      expect(content).not.toContain('_sourceFile');
    });

    it('should preserve existing manifest content when adding skill', async () => {
      // Create a manifest with existing agents
      const existingManifest = {
        kynetic_meta: '1.0',
        agents: [{ _ulid: testUlid('AGEXST'), id: 'existing-agent', name: 'Existing Agent', capabilities: [], tools: [], conventions: [] }],
        workflows: [],
        conventions: [],
        observations: [],
        skills: [],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(existingManifest),
      );

      const skill: LoadedSkill = {
        _ulid: testUlid('SKNEW'),
        id: 'new-skill',
        name: 'New Skill',
        origin: 'core',
        tags: [],
      };

      await saveMetaItem(ctx, skill, 'skill');

      // Verify existing agent is preserved
      const manifestPath = path.join(tempDir, 'kynetic.meta.yaml');
      const raw = await readYamlFile<MetaManifest>(manifestPath);

      expect(raw.agents).toHaveLength(1);
      expect(raw.agents[0].id).toBe('existing-agent');
      expect(raw.skills).toHaveLength(1);
      expect(raw.skills[0].id).toBe('new-skill');
    });
  });

  describe('deleteMetaItem for skills', () => {
    // AC: @skill-parser ac-3
    it('should remove skill from manifest.skills', async () => {
      const skillUlid = testUlid('SKDEL1');
      const existingManifest = {
        kynetic_meta: '1.0',
        agents: [],
        workflows: [],
        conventions: [],
        observations: [],
        skills: [
          { _ulid: skillUlid, id: 'to-delete', name: 'To Delete', origin: 'project' },
          { _ulid: testUlid('SKKEEP'), id: 'to-keep', name: 'To Keep', origin: 'core' },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(existingManifest),
      );

      const result = await deleteMetaItem(ctx, skillUlid, 'skill');

      expect(result).toBe(true);

      // Verify skill was removed
      const manifestPath = path.join(tempDir, 'kynetic.meta.yaml');
      const raw = await readYamlFile<MetaManifest>(manifestPath);

      expect(raw.skills).toHaveLength(1);
      expect(raw.skills[0].id).toBe('to-keep');
    });

    // AC: @skill-parser ac-4
    it('should delete .kspec/skills/<id>/ directory when deleting skill', async () => {
      const skillUlid = testUlid('SKDEL2');
      const skillId = 'dir-delete-test';

      // Create skill directory with content
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');
      await fs.mkdir(path.join(skillDir, 'docs'), { recursive: true });
      await fs.writeFile(path.join(skillDir, 'docs', 'quickref.md'), '# Quick Ref');

      // Create manifest with the skill
      const existingManifest = {
        kynetic_meta: '1.0',
        agents: [],
        workflows: [],
        conventions: [],
        observations: [],
        skills: [
          { _ulid: skillUlid, id: skillId, name: 'Dir Delete Test', origin: 'project' },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(existingManifest),
      );

      const result = await deleteMetaItem(ctx, skillUlid, 'skill');

      expect(result).toBe(true);

      // Verify directory was deleted
      await expect(fs.access(skillDir)).rejects.toThrow();
    });

    it('should return false when skill ULID not found', async () => {
      const existingManifest = {
        kynetic_meta: '1.0',
        agents: [],
        workflows: [],
        conventions: [],
        observations: [],
        skills: [
          { _ulid: testUlid('SKEXST'), id: 'existing', name: 'Existing', origin: 'core' },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(existingManifest),
      );

      const nonExistentUlid = testUlid('SKNONE');
      const result = await deleteMetaItem(ctx, nonExistentUlid, 'skill');

      expect(result).toBe(false);
    });

    it('should succeed even if skill directory does not exist', async () => {
      const skillUlid = testUlid('SKNDIR');
      const existingManifest = {
        kynetic_meta: '1.0',
        agents: [],
        workflows: [],
        conventions: [],
        observations: [],
        skills: [
          { _ulid: skillUlid, id: 'no-dir-skill', name: 'No Dir Skill', origin: 'local' },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(existingManifest),
      );

      // Note: we're NOT creating the skill directory

      const result = await deleteMetaItem(ctx, skillUlid, 'skill');

      expect(result).toBe(true);

      // Verify skill was removed from manifest
      const manifestPath = path.join(tempDir, 'kynetic.meta.yaml');
      const raw = await readYamlFile<MetaManifest>(manifestPath);
      expect(raw.skills).toHaveLength(0);
    });
  });

  describe('getMetaStats with skills', () => {
    // AC: @skill-parser ac-5
    it('should include skills count in stats', async () => {
      const metaManifest = {
        kynetic_meta: '1.0',
        agents: [{ _ulid: testUlid('AG001'), id: 'agent1', name: 'Agent 1', capabilities: [], tools: [], conventions: [] }],
        workflows: [],
        conventions: [],
        observations: [],
        skills: [
          { _ulid: testUlid('SK001'), id: 'skill1', name: 'Skill 1', origin: 'core' },
          { _ulid: testUlid('SK002'), id: 'skill2', name: 'Skill 2', origin: 'project' },
          { _ulid: testUlid('SK003'), id: 'skill3', name: 'Skill 3', origin: 'local' },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const stats = getMetaStats(meta);

      expect(stats.skills).toBe(3);
      expect(stats.agents).toBe(1);
    });

    it('should return 0 for skills when none defined', async () => {
      const metaManifest = {
        kynetic_meta: '1.0',
        agents: [],
        workflows: [],
        conventions: [],
        observations: [],
        skills: [],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const meta = await loadMetaContext(ctx);
      const stats = getMetaStats(meta);

      expect(stats.skills).toBe(0);
    });
  });

  describe('isMetaItemType for skills', () => {
    // AC: @skill-parser ac-6
    it('should return true for skill type', () => {
      expect(isMetaItemType('skill')).toBe(true);
    });

    it('should return true for all meta item types', () => {
      expect(isMetaItemType('agent')).toBe(true);
      expect(isMetaItemType('workflow')).toBe(true);
      expect(isMetaItemType('convention')).toBe(true);
      expect(isMetaItemType('observation')).toBe(true);
      expect(isMetaItemType('skill')).toBe(true);
    });

    it('should return false for non-meta types', () => {
      expect(isMetaItemType('task')).toBe(false);
      expect(isMetaItemType('spec')).toBe(false);
      expect(isMetaItemType('inbox')).toBe(false);
      expect(isMetaItemType('unknown')).toBe(false);
    });
  });
});
