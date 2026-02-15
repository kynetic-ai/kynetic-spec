/**
 * Tests for Skill Validation in kspec
 * AC: @skill-validation ac-1, ac-2, ac-3, ac-4
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { createTempDir, cleanupTempDir, testUlid, initGitRepo } from './helpers/cli';
import { validate } from '../src/parser/validate';
import { initContext } from '../src/parser/yaml';

describe('Kspec Skill Validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await initGitRepo(tempDir);

    // Create minimal manifest
    await fs.writeFile(
      path.join(tempDir, 'kynetic.yaml'),
      yamlStringify({ kynetic: '1.0', includes: [] }),
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('missing content file validation (ac-1)', () => {
    // AC: @skill-validation ac-1
    it('should report error when skill has no SKILL.md file', async () => {
      const skillUlid = testUlid('SKVAL1');

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

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have a schema error for the missing content file
      const missingContentError = result.schemaErrors.find(
        err => err.message.includes('missing content file') ||
               err.message.includes('missing-content-skill'),
      );
      expect(missingContentError).toBeDefined();
      expect(missingContentError?.message).toContain('missing-content-skill');
    });

    // AC: @skill-validation ac-1
    it('should not report error when skill has SKILL.md file', async () => {
      const skillUlid = testUlid('SKVAL2');
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

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should not have any skill content errors
      const skillContentErrors = result.schemaErrors.filter(
        err => err.message.includes('missing content file'),
      );
      expect(skillContentErrors).toHaveLength(0);
    });
  });

  describe('depends_on reference validation (ac-2)', () => {
    // AC: @skill-validation ac-2
    it('should report warning when skill depends_on references non-existent skill', async () => {
      const skillUlid = testUlid('SKDEP1');
      const skillId = 'skill-with-broken-dep';

      // Create skill directory and SKILL.md
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill with broken dep');

      // Create meta manifest with skill referencing non-existent skill
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: skillId,
            name: 'Skill With Broken Dep',
            origin: 'core',
            depends_on: ['@nonexistent-skill'],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have a warning for the broken reference
      const brokenRefWarning = result.refWarnings.find(
        warn => warn.message.includes('cannot be resolved') &&
                warn.message.includes('nonexistent-skill'),
      );
      expect(brokenRefWarning).toBeDefined();
      expect(brokenRefWarning?.field).toBe('depends_on');
    });

    // AC: @skill-validation ac-2
    it('should not report warning when skill depends_on references existing skill', async () => {
      const skill1Ulid = testUlid('SKDEP2');
      const skill2Ulid = testUlid('SKDEP3');
      const skill1Id = 'base-skill';
      const skill2Id = 'dependent-skill';

      // Create skill directories and SKILL.md files
      const skill1Dir = path.join(tempDir, 'skills', skill1Id);
      const skill2Dir = path.join(tempDir, 'skills', skill2Id);
      await fs.mkdir(skill1Dir, { recursive: true });
      await fs.mkdir(skill2Dir, { recursive: true });
      await fs.writeFile(path.join(skill1Dir, 'SKILL.md'), '# Base Skill');
      await fs.writeFile(path.join(skill2Dir, 'SKILL.md'), '# Dependent Skill');

      // Create meta manifest with skill referencing existing skill
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skill1Ulid,
            id: skill1Id,
            name: 'Base Skill',
            origin: 'core',
          },
          {
            _ulid: skill2Ulid,
            id: skill2Id,
            name: 'Dependent Skill',
            origin: 'core',
            depends_on: [`@${skill1Id}`],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should not have any warnings for depends_on
      const dependsOnWarnings = result.refWarnings.filter(
        warn => warn.field === 'depends_on',
      );
      expect(dependsOnWarnings).toHaveLength(0);
    });

    // AC: @skill-validation ac-2
    it('should report warning when skill depends_on references non-skill item', async () => {
      const skillUlid = testUlid('SKDEP4');
      const agentUlid = testUlid('SKDEP5');
      const skillId = 'skill-dep-agent';

      // Create skill directory and SKILL.md
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Skill depending on agent');

      // Create meta manifest with skill referencing an agent (not a skill)
      const metaManifest = {
        kynetic_meta: '1.0',
        agents: [
          {
            _ulid: agentUlid,
            id: 'test-agent',
            name: 'Test Agent',
          },
        ],
        skills: [
          {
            _ulid: skillUlid,
            id: skillId,
            name: 'Skill Depending on Agent',
            origin: 'core',
            depends_on: ['@test-agent'],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have a warning that dep points to non-skill
      const nonSkillWarning = result.refWarnings.find(
        warn => warn.message.includes('non-skill'),
      );
      expect(nonSkillWarning).toBeDefined();
    });
  });

  describe('orphaned skill directory detection (ac-3)', () => {
    // AC: @skill-validation ac-3
    it('should report warning for directory with no corresponding meta entry', async () => {
      // Create orphaned skill directory (no meta entry)
      const orphanedDir = path.join(tempDir, 'skills', 'orphaned-skill');
      await fs.mkdir(orphanedDir, { recursive: true });
      await fs.writeFile(path.join(orphanedDir, 'SKILL.md'), '# Orphaned');

      // Create empty meta manifest (no skills)
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have a warning for the orphaned directory
      const orphanedWarning = result.refWarnings.find(
        warn => warn.message.includes('Orphaned skill directory') &&
                warn.message.includes('orphaned-skill'),
      );
      expect(orphanedWarning).toBeDefined();
    });

    // AC: @skill-validation ac-3
    it('should not report warning for directory with corresponding meta entry', async () => {
      const skillUlid = testUlid('SKORP1');
      const skillId = 'valid-skill';

      // Create skill directory
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Valid Skill');

      // Create meta manifest with matching skill entry
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

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should not have any orphan warnings
      const orphanedWarnings = result.refWarnings.filter(
        warn => warn.message.includes('Orphaned skill directory'),
      );
      expect(orphanedWarnings).toHaveLength(0);
    });

    // AC: @skill-validation ac-3
    it('should report multiple warnings for multiple orphaned directories', async () => {
      // Create multiple orphaned directories
      await fs.mkdir(path.join(tempDir, 'skills', 'orphan-one'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'skills', 'orphan-two'), { recursive: true });

      // Create empty meta manifest
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have warnings for both orphaned directories
      const orphanedWarnings = result.refWarnings.filter(
        warn => warn.message.includes('Orphaned skill directory'),
      );
      expect(orphanedWarnings).toHaveLength(2);
      expect(orphanedWarnings.some(w => w.message.includes('orphan-one'))).toBe(true);
      expect(orphanedWarnings.some(w => w.message.includes('orphan-two'))).toBe(true);
    });
  });

  describe('schema validation (ac-4)', () => {
    // AC: @skill-validation ac-4
    it('should report schema validation errors for invalid skill fields', async () => {
      // Create meta manifest with invalid skill (missing required fields)
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: testUlid('SKSCH1'),
            // Missing required 'id' field
            name: 'Invalid Skill',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have schema error for missing id
      // Path format is "meta:skills.0.id" (dot notation with meta: prefix)
      // Error message is "Skill ID is required"
      const schemaError = result.schemaErrors.find(
        err => err.path?.includes('skills') &&
               (err.message.includes('ID is required') || err.message.includes('id')),
      );
      expect(schemaError).toBeDefined();
    });

    // AC: @skill-validation ac-4
    it('should report schema validation errors for invalid ULID format', async () => {
      // Create meta manifest with invalid ULID
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: 'invalid-ulid',
            id: 'test-skill',
            name: 'Test Skill',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have schema error for invalid ULID
      // Path format is "meta:skills.0._ulid" (dot notation with meta: prefix)
      const ulidError = result.schemaErrors.find(
        err => err.path?.includes('skills') &&
               (err.path?.includes('_ulid') || err.message.includes('ULID') || err.message.includes('26 characters')),
      );
      expect(ulidError).toBeDefined();
    });

    // AC: @skill-validation ac-4
    it('should report schema validation errors for invalid origin value', async () => {
      // Create meta manifest with invalid origin
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: testUlid('SKSCH3'),
            id: 'test-skill',
            name: 'Test Skill',
            origin: 'invalid-origin', // Invalid - must be core/project/local
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have schema error for invalid origin
      // Path format is "meta:skills.0.origin" (dot notation with meta: prefix)
      const originError = result.schemaErrors.find(
        err => err.path?.includes('skills') && err.path?.includes('origin'),
      );
      expect(originError).toBeDefined();
    });

    // AC: @skill-validation ac-4
    it('should report schema validation errors for invalid id format (not kebab-case)', async () => {
      // Create skill directory first to avoid content file error
      const skillDir = path.join(tempDir, 'skills', 'InvalidSkillId');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Invalid');

      // Create meta manifest with invalid id format
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: testUlid('SKSCH4'),
            id: 'InvalidSkillId', // Invalid - must be kebab-case
            name: 'Test Skill',
            origin: 'core',
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should have schema error for invalid id format
      // Path format is "meta:skills.0.id" (dot notation with meta: prefix)
      const idError = result.schemaErrors.find(
        err => err.path?.includes('skills') &&
               err.path?.includes('id') &&
               err.message.includes('kebab-case'),
      );
      expect(idError).toBeDefined();
    });

    // AC: @skill-validation ac-4
    it('should pass validation for valid skill with all required fields', async () => {
      const skillUlid = testUlid('SKSCH5');
      const skillId = 'valid-skill';

      // Create skill directory and SKILL.md
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Valid Skill');

      // Create meta manifest with valid skill
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: skillId,
            name: 'Valid Skill',
            origin: 'core',
            description: 'A valid skill',
            platforms: ['claude-code'],
            tags: ['test'],
          },
        ],
      };

      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // Should not have any skill-related schema errors
      const skillErrors = result.schemaErrors.filter(
        err => err.path?.includes('skills'),
      );
      expect(skillErrors).toHaveLength(0);
    });
  });

  describe('metaStats includes skills', () => {
    it('should include skills count in metaStats', async () => {
      const skill1Ulid = testUlid('SKSTA1');
      const skill2Ulid = testUlid('SKSTA2');

      // Create skill directories and SKILL.md files
      await fs.mkdir(path.join(tempDir, 'skills', 'skill-one'), { recursive: true });
      await fs.mkdir(path.join(tempDir, 'skills', 'skill-two'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'skills', 'skill-one', 'SKILL.md'), '# One');
      await fs.writeFile(path.join(tempDir, 'skills', 'skill-two', 'SKILL.md'), '# Two');

      // Create meta manifest with two skills
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

      const ctx = await initContext(tempDir);
      const result = await validate(ctx);

      // metaStats should include skills count
      expect(result.metaStats).toBeDefined();
      expect(result.metaStats?.skills).toBe(2);
    });
  });
});
