/**
 * Tests for Skill Schema Definition
 * AC: @skill-schema ac-1 through ac-3
 */
import { describe, it, expect } from 'vitest';
import { testUlid } from './helpers/cli';
import { SkillSchema } from '../src/schema/meta';

describe('Skill Schema Definition', () => {
  describe('id validation', () => {
    // AC: @skill-schema ac-1
    it('should reject id with uppercase characters', () => {
      const skill = {
        _ulid: testUlid('SKUPPR'),
        id: 'TaskWork', // uppercase
        name: 'Task Work',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        expect(idError?.message).toContain('kebab-case');
      }
    });

    // AC: @skill-schema ac-1
    it('should reject id with special characters', () => {
      const skill = {
        _ulid: testUlid('SKSPEC'),
        id: 'task_work', // underscore
        name: 'Task Work',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        expect(idError?.message).toContain('kebab-case');
      }
    });

    // AC: @skill-schema ac-1
    it('should reject id starting with number', () => {
      const skill = {
        _ulid: testUlid('SKNUM1'),
        id: '123-task',
        name: 'Task Work',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        expect(idError?.message).toContain('kebab-case');
      }
    });

    // AC: @skill-schema ac-1
    it('should accept valid kebab-case ids', () => {
      const validIds = ['task-work', 'pr-review', 'e2e', 'my-skill-v2'];

      for (const id of validIds) {
        const skill = {
          _ulid: testUlid('SKVAL'),
          id,
          name: 'Test Skill',
          origin: 'core',
        };

        const result = SkillSchema.safeParse(skill);
        expect(result.success).toBe(true);
      }
    });

    // AC: @skill-schema ac-2
    it('should reject missing id field', () => {
      const skill = {
        _ulid: testUlid('SKNOID'),
        name: 'No ID Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(false);
      if (!result.success) {
        const idError = result.error.issues.find(
          (issue) => issue.path.includes('id'),
        );
        expect(idError).toBeDefined();
        // Check for required field error
        expect(idError?.code === 'invalid_type' || idError?.message?.toLowerCase().includes('required')).toBe(true);
      }
    });
  });

  describe('platforms default', () => {
    // AC: @skill-schema ac-3
    it('should default platforms to ["claude-code"] when not specified', () => {
      const skill = {
        _ulid: testUlid('SKPLAT'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platforms).toEqual(['claude-code']);
      }
    });

    // AC: @skill-schema ac-3
    it('should preserve custom platforms when specified', () => {
      const skill = {
        _ulid: testUlid('SKCUST'),
        id: 'multi-platform-skill',
        name: 'Multi-Platform Skill',
        origin: 'core',
        platforms: ['claude-code', 'cursor', 'windsurf'],
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platforms).toEqual(['claude-code', 'cursor', 'windsurf']);
      }
    });
  });

  describe('other fields', () => {
    it('should default depends_on to empty array', () => {
      const skill = {
        _ulid: testUlid('SKDEPS'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.depends_on).toEqual([]);
      }
    });

    it('should accept depends_on refs', () => {
      const skill = {
        _ulid: testUlid('SKDEP2'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
        depends_on: ['@other-skill', '@another'],
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.depends_on).toEqual(['@other-skill', '@another']);
      }
    });

    it('should default tags to empty array', () => {
      const skill = {
        _ulid: testUlid('SKTAGS'),
        id: 'test-skill',
        name: 'Test Skill',
        origin: 'core',
      };

      const result = SkillSchema.safeParse(skill);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tags).toEqual([]);
      }
    });
  });
});
