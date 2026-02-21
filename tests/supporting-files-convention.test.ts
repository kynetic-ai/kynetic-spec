/**
 * Tests for Supporting Files Convention
 * AC: @supporting-files-convention ac-1, ac-2, ac-3, ac-4
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { createTempDir, cleanupTempDir, testUlid, initGitRepo } from './helpers/cli';
import {
  loadSkillSupportingFiles,
  listSkillSupportingDirs,
  getSkillSupportingDirPath,
  type SupportingDirType,
} from '../src/parser/meta';
import { initContext, type KspecContext } from '../src/parser/yaml';
import { loadMetaContext } from '../src/parser/meta';
import { claudeCodeRenderer } from '../src/parser/skill-render';

describe('Supporting Files Convention', () => {
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

  describe('loadSkillSupportingFiles (ac-1)', () => {
    // AC: @supporting-files-convention ac-1
    it('should load files from references/ directory', async () => {
      const skillId = 'test-skill';
      const skillUlid = testUlid('SKREF1');

      // Create skill directory with references
      const skillDir = path.join(tempDir, 'skills', skillId);
      const refsDir = path.join(skillDir, 'references');
      await fs.mkdir(refsDir, { recursive: true });

      // Create reference files
      const apiContent = '# API Reference\n\nEndpoints here.';
      const schemaContent = '# Schema\n\nTypes here.';
      await fs.writeFile(path.join(refsDir, 'api.md'), apiContent);
      await fs.writeFile(path.join(refsDir, 'schema.md'), schemaContent);

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Test Skill',
        origin: 'core' as const,
        tags: [],
        allowed_tools: [],
      };

      const files = await loadSkillSupportingFiles(ctx, skill, 'references');

      expect(files).toHaveLength(2);

      const apiFile = files.find(f => f.name === 'api.md');
      expect(apiFile).toBeDefined();
      expect(apiFile?.content).toBe(apiContent);
      expect(apiFile?.dirType).toBe('references');
      expect(apiFile?.path).toBe(path.join(refsDir, 'api.md'));

      const schemaFile = files.find(f => f.name === 'schema.md');
      expect(schemaFile).toBeDefined();
      expect(schemaFile?.content).toBe(schemaContent);
    });

    // AC: @supporting-files-convention ac-1
    it('should load files from scripts/ directory', async () => {
      const skillId = 'script-skill';
      const skillUlid = testUlid('SKSCR1');

      const skillDir = path.join(tempDir, 'skills', skillId);
      const scriptsDir = path.join(skillDir, 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });

      const scriptContent = '#!/bin/bash\necho "hello"';
      await fs.writeFile(path.join(scriptsDir, 'helper.sh'), scriptContent);

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Script Skill',
        origin: 'core' as const,
        tags: [],
        allowed_tools: [],
      };

      const files = await loadSkillSupportingFiles(ctx, skill, 'scripts');

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('helper.sh');
      expect(files[0].content).toBe(scriptContent);
      expect(files[0].dirType).toBe('scripts');
    });

    // AC: @supporting-files-convention ac-1
    it('should load files from assets/ directory', async () => {
      const skillId = 'asset-skill';
      const skillUlid = testUlid('SKAST1');

      const skillDir = path.join(tempDir, 'skills', skillId);
      const assetsDir = path.join(skillDir, 'assets');
      await fs.mkdir(assetsDir, { recursive: true });

      const configContent = '{"key": "value"}';
      await fs.writeFile(path.join(assetsDir, 'config.json'), configContent);

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Asset Skill',
        origin: 'core' as const,
        tags: [],
        allowed_tools: [],
      };

      const files = await loadSkillSupportingFiles(ctx, skill, 'assets');

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('config.json');
      expect(files[0].content).toBe(configContent);
      expect(files[0].dirType).toBe('assets');
    });

    // AC: @supporting-files-convention ac-1
    it('should return empty array when directory does not exist', async () => {
      const skill = {
        _ulid: testUlid('SKNDIR'),
        id: 'no-refs-skill',
        name: 'No Refs Skill',
        origin: 'core' as const,
        tags: [],
        allowed_tools: [],
      };

      const files = await loadSkillSupportingFiles(ctx, skill, 'references');
      expect(files).toEqual([]);
    });

    // AC: @supporting-files-convention ac-1
    it('should return empty array when directory is empty', async () => {
      const skillId = 'empty-refs';
      const skillUlid = testUlid('SKEMPR');

      const refsDir = path.join(tempDir, 'skills', skillId, 'references');
      await fs.mkdir(refsDir, { recursive: true });

      const skill = {
        _ulid: skillUlid,
        id: skillId,
        name: 'Empty Refs Skill',
        origin: 'core' as const,
        tags: [],
        allowed_tools: [],
      };

      const files = await loadSkillSupportingFiles(ctx, skill, 'references');
      expect(files).toEqual([]);
    });
  });

  describe('listSkillSupportingDirs (ac-1)', () => {
    // AC: @supporting-files-convention ac-1
    it('should list all existing supporting directories', async () => {
      const skillId = 'multi-dir-skill';

      // Create multiple supporting directories
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
      await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(skillDir, 'docs'), { recursive: true });

      const dirs = await listSkillSupportingDirs(ctx, skillId);

      expect(dirs).toContain('references');
      expect(dirs).toContain('scripts');
      expect(dirs).toContain('docs');
      expect(dirs).not.toContain('assets');
    });

    // AC: @supporting-files-convention ac-1
    it('should return empty array when no supporting directories exist', async () => {
      const skillId = 'no-dirs-skill';

      // Create skill directory without supporting dirs
      await fs.mkdir(path.join(tempDir, 'skills', skillId), { recursive: true });

      const dirs = await listSkillSupportingDirs(ctx, skillId);
      expect(dirs).toEqual([]);
    });

    // AC: @supporting-files-convention ac-1
    it('should return empty array when skill directory does not exist', async () => {
      const dirs = await listSkillSupportingDirs(ctx, 'nonexistent-skill');
      expect(dirs).toEqual([]);
    });
  });

  describe('getSkillSupportingDirPath (ac-1)', () => {
    // AC: @supporting-files-convention ac-1
    it('should return correct path for each directory type', () => {
      const skillId = 'test-skill';

      expect(getSkillSupportingDirPath(ctx, skillId, 'references')).toBe(
        path.join(tempDir, 'skills', skillId, 'references')
      );
      expect(getSkillSupportingDirPath(ctx, skillId, 'scripts')).toBe(
        path.join(tempDir, 'skills', skillId, 'scripts')
      );
      expect(getSkillSupportingDirPath(ctx, skillId, 'assets')).toBe(
        path.join(tempDir, 'skills', skillId, 'assets')
      );
      expect(getSkillSupportingDirPath(ctx, skillId, 'docs')).toBe(
        path.join(tempDir, 'skills', skillId, 'docs')
      );
    });
  });

  describe('render with supporting directories', () => {
    // AC: @supporting-files-convention ac-2
    it('should copy scripts/ and assets/ directories when rendered', async () => {
      const skillId = 'full-skill';
      const skillUlid = testUlid('SKFUL1');

      // Create skill with meta, content, and supporting dirs
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Full Skill\n\nContent here.');

      // Create scripts and assets
      const scriptsDir = path.join(skillDir, 'scripts');
      const assetsDir = path.join(skillDir, 'assets');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'build.sh'), '#!/bin/bash\necho build');
      await fs.writeFile(path.join(assetsDir, 'data.json'), '{"data": true}');

      // Create meta manifest
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: skillId,
            name: 'Full Skill',
            origin: 'core',
          },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const fullCtx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(fullCtx);
      const skill = metaCtx.skills[0];

      const result = await claudeCodeRenderer.render(fullCtx, tempDir, skill);

      expect(result.supportingDirsAction?.scripts).toBe('created');
      expect(result.supportingDirsAction?.assets).toBe('created');

      // Verify files were copied (core skills render under kspec/ namespace)
      const targetScriptsPath = path.join(tempDir, '.claude', 'skills', 'kspec', skillId, 'scripts', 'build.sh');
      const targetAssetsPath = path.join(tempDir, '.claude', 'skills', 'kspec', skillId, 'assets', 'data.json');

      const scriptsContent = await fs.readFile(targetScriptsPath, 'utf-8');
      const assetsContent = await fs.readFile(targetAssetsPath, 'utf-8');

      expect(scriptsContent).toContain('#!/bin/bash');
      expect(assetsContent).toContain('"data"');
    });

    // AC: @supporting-files-convention ac-3
    it('should copy docs/ directory for backward compatibility', async () => {
      const skillId = 'legacy-skill';
      const skillUlid = testUlid('SKLGCY');

      // Create skill with docs directory (legacy)
      const skillDir = path.join(tempDir, 'skills', skillId);
      const docsDir = path.join(skillDir, 'docs');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Legacy Skill');
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide');

      // Create meta manifest
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: skillId,
            name: 'Legacy Skill',
            origin: 'core',
          },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const fullCtx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(fullCtx);
      const skill = metaCtx.skills[0];

      const result = await claudeCodeRenderer.render(fullCtx, tempDir, skill);

      expect(result.supportingDirsAction?.docs).toBe('created');

      // Verify docs were copied (core skills render under kspec/ namespace)
      const targetDocsPath = path.join(tempDir, '.claude', 'skills', 'kspec', skillId, 'docs', 'guide.md');
      const content = await fs.readFile(targetDocsPath, 'utf-8');
      expect(content).toContain('# Guide');
    });

    // AC: @supporting-files-convention ac-4
    it('should render successfully with no supporting directories', async () => {
      const skillId = 'minimal-skill';
      const skillUlid = testUlid('SKMIN1');

      // Create skill with only SKILL.md, no supporting dirs
      const skillDir = path.join(tempDir, 'skills', skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Minimal Skill');

      // Create meta manifest
      const metaManifest = {
        kynetic_meta: '1.0',
        skills: [
          {
            _ulid: skillUlid,
            id: skillId,
            name: 'Minimal Skill',
            origin: 'core',
          },
        ],
      };
      await fs.writeFile(
        path.join(tempDir, 'kynetic.meta.yaml'),
        yamlStringify(metaManifest),
      );

      const fullCtx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(fullCtx);
      const skill = metaCtx.skills[0];

      const result = await claudeCodeRenderer.render(fullCtx, tempDir, skill);

      // All supporting dirs should be skipped
      expect(result.supportingDirsAction?.references).toBe('skipped');
      expect(result.supportingDirsAction?.scripts).toBe('skipped');
      expect(result.supportingDirsAction?.assets).toBe('skipped');
      expect(result.supportingDirsAction?.docs).toBe('skipped');

      // But the main file should be created
      expect(result.action).toBe('created');
    });
  });
});
