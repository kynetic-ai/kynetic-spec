/**
 * Tests for Skill Meta Integration
 * AC: @skill-meta-integration ac-1 through ac-4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import {
  kspecOutput as kspec,
  kspecJson,
  kspec as kspecFull,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
  testUlid,
} from './helpers/cli';

describe('Skill Meta Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create skills via kspec skill add
    const result1 = kspecFull(
      'skill add --id task-work --name "Task Work" --description "Work on tasks" --origin core --skill-version 0.1.0',
      tempDir
    );
    const result2 = kspecFull(
      'skill add --id pr-review --name "PR Review" --origin project --tag workflow',
      tempDir
    );
    if (result1.exitCode !== 0) throw new Error(`skill add failed: ${result1.stderr}`);
    if (result2.exitCode !== 0) throw new Error(`skill add failed: ${result2.stderr}`);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('kspec meta get for skills', () => {
    // AC: @skill-meta-integration ac-1
    it('should return skill metadata when kspec meta get @skill-id is run', () => {
      const result = kspecJson<{
        _ulid: string;
        id: string;
        name: string;
        origin: string;
      }>('meta get @task-work', tempDir);

      expect(result).toBeDefined();
      expect(result.id).toBe('task-work');
      expect(result.name).toBe('Task Work');
      expect(result.origin).toBe('core');
    });

    // AC: @skill-meta-integration ac-1 - using ULID prefix
    it('should return skill metadata by ULID prefix', () => {
      // First get the skill list to find its ULID
      const skills = kspecJson<Array<{ _ulid: string; id: string }>>('skill list', tempDir);
      const taskWorkSkill = skills.find(s => s.id === 'task-work');
      expect(taskWorkSkill).toBeDefined();

      // Get by ULID prefix (first 8 chars)
      const ulidPrefix = taskWorkSkill!._ulid.slice(0, 8);
      const result = kspecJson<{
        id: string;
        name: string;
      }>(`meta get @${ulidPrefix}`, tempDir);

      expect(result).toBeDefined();
      expect(result.id).toBe('task-work');
    });

    // AC: @skill-meta-integration ac-1 - human-readable output
    it('should display skill type and reference in human-readable output', () => {
      const output = kspec('meta get task-work', tempDir);

      expect(output).toContain('Skill: task-work');
      expect(output).toContain('task-work');
    });
  });

  describe('kspec meta list --type skill', () => {
    // AC: @skill-meta-integration ac-2
    it('should show only skills when --type skill is used', () => {
      const output = kspec('meta list --type skill', tempDir);

      // Should show skills
      expect(output).toContain('task-work');
      expect(output).toContain('pr-review');
      expect(output).toContain('skill');

      // Verify these are the only meta items shown (no agents, workflows, etc.)
      expect(output).not.toContain('agent');
      expect(output).not.toContain('workflow');
      expect(output).not.toContain('convention');
      expect(output).not.toContain('observation');
    });

    // AC: @skill-meta-integration ac-2 - JSON output
    it('should return only skills in JSON when --type skill is used', () => {
      const result = kspecJson<Array<{ id: string; type: string }>>('meta list --type skill', tempDir);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result.every(item => item.type === 'skill')).toBe(true);

      const ids = result.map(item => item.id);
      expect(ids).toContain('task-work');
      expect(ids).toContain('pr-review');
    });

    // AC: @skill-meta-integration ac-2 - skills included in full listing
    it('should include skills when listing all meta items', () => {
      const result = kspecJson<Array<{ id: string; type: string }>>('meta list', tempDir);

      const skills = result.filter(item => item.type === 'skill');
      expect(skills.length).toBe(2);
    });
  });

  describe('kspec meta show skill count', () => {
    // AC: @skill-meta-integration ac-3
    it('should include skill count in meta show summary', () => {
      const output = kspec('meta show', tempDir);

      // Should include skill count
      expect(output).toContain('Skills:');
      expect(output).toMatch(/Skills:\s*2/);
    });

    // AC: @skill-meta-integration ac-3 - with no skills
    it('should show 0 skills when none exist', async () => {
      // Create a new temp dir without skills
      const emptyDir = await setupTempFixtures();
      await initGitRepo(emptyDir);

      // Ensure .kspec directory exists and create empty meta manifest
      await fs.mkdir(path.join(emptyDir, '.kspec'), { recursive: true });
      await fs.writeFile(
        path.join(emptyDir, '.kspec', 'kynetic.meta.yaml'),
        yamlStringify({ kynetic_meta: '1.0', skills: [] })
      );

      try {
        const output = kspec('meta show', emptyDir);
        expect(output).toContain('Skills:');
        expect(output).toMatch(/Skills:\s*0/);
      } finally {
        await cleanupTempDir(emptyDir);
      }
    });

    // AC: @skill-meta-integration ac-3 - JSON output includes skills
    it('should include skill count in JSON output', () => {
      const result = kspecJson<{ stats: { skills: number } }>('meta show', tempDir);

      expect(result.stats).toBeDefined();
      expect(result.stats.skills).toBe(2);
    });
  });

  describe('resolveMetaRefToUlid for skills', () => {
    // AC: @skill-meta-integration ac-4 - indirect test via meta delete
    it('should resolve skill id when checking references', async () => {
      // Create an agent that would reference a skill (if supported)
      // For now, we test that the skill can be found by ref in meta get

      // Get skill ULID via list
      const skills = kspecJson<Array<{ _ulid: string; id: string }>>('skill list', tempDir);
      const skill = skills.find(s => s.id === 'task-work');
      expect(skill).toBeDefined();

      // Try to get by both id and ULID - this exercises resolveMetaRefToUlid
      const byId = kspecJson<{ _ulid: string }>('meta get task-work', tempDir);
      const byUlid = kspecJson<{ _ulid: string }>(`meta get ${skill!._ulid}`, tempDir);

      expect(byId._ulid).toBe(skill!._ulid);
      expect(byUlid._ulid).toBe(skill!._ulid);
    });

    // AC: @skill-meta-integration ac-4 - skill ULID is returned correctly
    it('should return skill ULID when resolving by id', () => {
      const skills = kspecJson<Array<{ _ulid: string; id: string }>>('skill list', tempDir);
      const prReview = skills.find(s => s.id === 'pr-review');
      expect(prReview).toBeDefined();

      const result = kspecJson<{ _ulid: string; id: string }>('meta get @pr-review', tempDir);
      expect(result._ulid).toBe(prReview!._ulid);
    });

    // AC: @skill-meta-integration ac-4 - skill ULID prefix resolution
    it('should return skill when resolved by ULID prefix', () => {
      const skills = kspecJson<Array<{ _ulid: string; id: string }>>('skill list', tempDir);
      const taskWork = skills.find(s => s.id === 'task-work');
      expect(taskWork).toBeDefined();

      // Use 10-char prefix
      const prefix = taskWork!._ulid.slice(0, 10);
      const result = kspecJson<{ _ulid: string; id: string }>(`meta get @${prefix}`, tempDir);
      expect(result.id).toBe('task-work');
    });
  });
});
