/**
 * Tests for Platform Renderer Contract
 * AC: @platform-renderer-trait ac-1 through ac-6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspec as kspecFull,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';
import {
  claudeCodeRenderer,
  droidRenderer,
  generateDroidFrontmatter,
  getRenderer,
  getAllRenderers,
  getPlatformDefaultOutputDir,
  registerRenderer,
  getPlatformRenderHashPath,
  readPlatformRenderHash,
  writePlatformRenderHash,
  checkPlatformSkillDrift,
  type PlatformRenderer,
  type PlatformRenderResult,
  type DriftStatus,
} from '../src/parser/skill-render';
import { initContext, loadMetaContext } from '../src/parser';

describe('Platform Renderer Contract', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a test skill
    const result = kspecFull(
      'skill add --id test-skill --name "Test Skill" --description "A test skill for rendering" --platform claude-code',
      tempDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`skill add failed: ${result.stderr || result.stdout}`);
    }

    // Write custom content to the skill's SKILL.md
    const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
    await fs.writeFile(skillMdPath, '# Test Skill\n\nThis is test content.\n', 'utf-8');
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function loadSkill(skillId = 'test-skill') {
    const ctx = await initContext(tempDir);
    const metaCtx = await loadMetaContext(ctx);
    const skill = metaCtx.skills.find((s) => s.id === skillId);
    if (!skill) {
      throw new Error(`Missing skill fixture: ${skillId}`);
    }

    return { ctx, skill };
  }

  // AC: @platform-renderer-trait ac-1
  describe('ac-1: Platform-specific output files written to configured output directory', () => {
    it('should write output files to the platform default output directory', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      // Should write to .claude/skills/<id>/SKILL.md
      expect(result.paths[0]).toBe(path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md'));

      // Verify file exists
      const content = await fs.readFile(result.paths[0], 'utf-8');
      expect(content).toContain('# Test Skill');
    });

    it('should use claude-code as the platform identifier', () => {
      expect(claudeCodeRenderer.platform).toBe('claude-code');
    });

    it('should have .claude/skills as the default output directory', () => {
      expect(claudeCodeRenderer.defaultOutputDir).toBe('.claude/skills');
    });
  });

  // AC: @platform-renderer-trait ac-2
  describe('ac-2: PlatformRenderResult returned with id, platform, action, and paths', () => {
    it('should return result with all required fields', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      expect(result.id).toBe('test-skill');
      expect(result.platform).toBe('claude-code');
      expect(result.action).toBe('created');
      expect(result.paths).toBeInstanceOf(Array);
      expect(result.paths.length).toBeGreaterThan(0);
    });

    it('should return unchanged action when file already matches', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      // First render
      await claudeCodeRenderer.render(ctx, tempDir, skill);

      // Second render - should be unchanged
      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      expect(result.action).toBe('unchanged');
    });

    it('should return updated action when source changes', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      // First render
      await claudeCodeRenderer.render(ctx, tempDir, skill);

      // Modify source
      const skillMdPath = path.join(tempDir, 'skills', 'test-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Test Skill\n\nUpdated content.\n', 'utf-8');

      // Second render
      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      expect(result.action).toBe('updated');
    });
  });

  // AC: @platform-renderer-trait ac-3
  describe('ac-3: Supporting directories copied to platform output', () => {
    it('should copy docs directory when present', async () => {
      // Create docs directory
      const docsDir = path.join(tempDir, 'skills', 'test-skill', 'docs');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n', 'utf-8');

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      // Check that docs action is tracked
      expect(result.supportingDirsAction).toBeDefined();
      expect(result.supportingDirsAction!.docs).toBe('created');

      // Verify docs were copied
      const targetDocsPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'docs', 'guide.md');
      const content = await fs.readFile(targetDocsPath, 'utf-8');
      expect(content).toContain('# Guide');
    });

    it('should copy references directory when present', async () => {
      // Create references directory
      const refsDir = path.join(tempDir, 'skills', 'test-skill', 'references');
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, 'api.md'), '# API Reference\n', 'utf-8');

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      expect(result.supportingDirsAction!.references).toBe('created');

      // Verify references were copied
      const targetRefsPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'references', 'api.md');
      const content = await fs.readFile(targetRefsPath, 'utf-8');
      expect(content).toContain('# API Reference');
    });

    it('should copy scripts directory when present', async () => {
      // Create scripts directory
      const scriptsDir = path.join(tempDir, 'skills', 'test-skill', 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'helper.sh'), '#!/bin/bash\necho "hello"\n', 'utf-8');

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      expect(result.supportingDirsAction!.scripts).toBe('created');

      // Verify scripts were copied
      const targetScriptsPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'scripts', 'helper.sh');
      const content = await fs.readFile(targetScriptsPath, 'utf-8');
      expect(content).toContain('#!/bin/bash');
    });

    it('should copy assets directory when present', async () => {
      // Create assets directory
      const assetsDir = path.join(tempDir, 'skills', 'test-skill', 'assets');
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, 'config.json'), '{"key": "value"}\n', 'utf-8');

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      expect(result.supportingDirsAction!.assets).toBe('created');

      // Verify assets were copied
      const targetAssetsPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'assets', 'config.json');
      const content = await fs.readFile(targetAssetsPath, 'utf-8');
      expect(content).toContain('"key"');
    });

    it('should show skipped for directories that do not exist', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      expect(result.supportingDirsAction).toBeDefined();
      expect(result.supportingDirsAction!.references).toBe('skipped');
      expect(result.supportingDirsAction!.scripts).toBe('skipped');
      expect(result.supportingDirsAction!.assets).toBe('skipped');
    });

    it('should include supporting directory paths in result.paths', async () => {
      // Create docs directory
      const docsDir = path.join(tempDir, 'skills', 'test-skill', 'docs');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n', 'utf-8');

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill);

      // paths should include both SKILL.md and docs directory
      expect(result.paths).toContain(path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md'));
      expect(result.paths).toContain(path.join(tempDir, '.claude', 'skills', 'test-skill', 'docs'));
    });

    // AC: @platform-renderer-trait ac-3
    it('should copy supporting directories for droid renderer', async () => {
      kspecFull(
        'skill add --id droid-support --name "Droid Support" --description "Droid support skill" --platform droid',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, 'skills', 'droid-support', 'SKILL.md'),
        '# Droid Support\n\nBody.\n',
        'utf-8'
      );
      const refsDir = path.join(tempDir, 'skills', 'droid-support', 'references');
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(path.join(refsDir, 'api.md'), '# API Reference\n', 'utf-8');

      const { ctx, skill } = await loadSkill('droid-support');
      const result = await droidRenderer.render(ctx, tempDir, skill);

      expect(result.supportingDirsAction!.references).toBe('created');
      expect(result.paths).toContain(path.join(tempDir, '.factory', 'skills', 'droid-support', 'references'));

      const copied = await fs.readFile(
        path.join(tempDir, '.factory', 'skills', 'droid-support', 'references', 'api.md'),
        'utf-8'
      );
      expect(copied).toContain('# API Reference');
    });
  });

  // AC: @platform-renderer-trait ac-4
  describe('ac-4: dryRun mode - no files written, result reflects what would happen', () => {
    it('should not write files when dryRun is true', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill, { dryRun: true });

      expect(result.action).toBe('created');

      // File should NOT exist
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md'))
      ).rejects.toThrow();
    });

    it('should not copy supporting directories when dryRun is true', async () => {
      // Create docs directory
      const docsDir = path.join(tempDir, 'skills', 'test-skill', 'docs');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n', 'utf-8');

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const result = await claudeCodeRenderer.render(ctx, tempDir, skill, { dryRun: true });

      expect(result.supportingDirsAction!.docs).toBe('created');

      // Target docs should NOT exist
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'test-skill', 'docs'))
      ).rejects.toThrow();
    });

    it('should return correct action for what would happen', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      // First render (actual)
      await claudeCodeRenderer.render(ctx, tempDir, skill);

      // Second render dry run - should show unchanged
      const result = await claudeCodeRenderer.render(ctx, tempDir, skill, { dryRun: true });

      expect(result.action).toBe('unchanged');
    });

    // AC: @platform-renderer-trait ac-4
    it('should not write droid files when dryRun is true', async () => {
      kspecFull(
        'skill add --id droid-dry-run --name "Droid Dry Run" --description "Droid dry run skill" --platform droid',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, 'skills', 'droid-dry-run', 'SKILL.md'),
        '# Droid Dry Run\n\nBody.\n',
        'utf-8'
      );
      const scriptsDir = path.join(tempDir, 'skills', 'droid-dry-run', 'scripts');
      await fs.mkdir(scriptsDir, { recursive: true });
      await fs.writeFile(path.join(scriptsDir, 'helper.sh'), '#!/bin/bash\necho hi\n', 'utf-8');

      const { ctx, skill } = await loadSkill('droid-dry-run');
      const result = await droidRenderer.render(ctx, tempDir, skill, { dryRun: true });

      expect(result.action).toBe('created');
      expect(result.supportingDirsAction!.scripts).toBe('created');
      await expect(
        fs.access(path.join(tempDir, '.factory', 'skills', 'droid-dry-run', 'SKILL.md'))
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(tempDir, '.factory', 'skills', 'droid-dry-run', 'scripts'))
      ).rejects.toThrow();
    });
  });

  // AC: @platform-renderer-trait ac-5
  describe('ac-5: Custom outputDir goes to custom path instead of platform default', () => {
    it('should write to custom output directory when specified', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const customOutputDir = 'custom/output/skills';
      const result = await claudeCodeRenderer.render(ctx, tempDir, skill, { outputDir: customOutputDir });

      // Should write to custom directory
      expect(result.paths[0]).toBe(path.join(tempDir, customOutputDir, 'test-skill', 'SKILL.md'));

      // Verify file exists at custom location
      const content = await fs.readFile(result.paths[0], 'utf-8');
      expect(content).toContain('# Test Skill');
    });

    it('should not write to default directory when custom outputDir specified', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      await claudeCodeRenderer.render(ctx, tempDir, skill, { outputDir: 'custom/output/skills' });

      // Default location should NOT have the file
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md'))
      ).rejects.toThrow();
    });

    it('should copy supporting directories to custom output directory', async () => {
      // Create docs directory
      const docsDir = path.join(tempDir, 'skills', 'test-skill', 'docs');
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n', 'utf-8');

      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const customOutputDir = 'custom/output/skills';
      const result = await claudeCodeRenderer.render(ctx, tempDir, skill, { outputDir: customOutputDir });

      expect(result.supportingDirsAction!.docs).toBe('created');

      // Verify docs at custom location
      const targetDocsPath = path.join(tempDir, customOutputDir, 'test-skill', 'docs', 'guide.md');
      const content = await fs.readFile(targetDocsPath, 'utf-8');
      expect(content).toContain('# Guide');
    });

    // AC: @platform-renderer-trait ac-5
    it('should write droid output to custom output directory', async () => {
      kspecFull(
        'skill add --id droid-custom --name "Droid Custom" --description "Droid custom output skill" --platform droid',
        tempDir
      );
      await fs.writeFile(
        path.join(tempDir, 'skills', 'droid-custom', 'SKILL.md'),
        '# Droid Custom\n\nBody.\n',
        'utf-8'
      );
      const assetsDir = path.join(tempDir, 'skills', 'droid-custom', 'assets');
      await fs.mkdir(assetsDir, { recursive: true });
      await fs.writeFile(path.join(assetsDir, 'config.json'), '{"key":"value"}\n', 'utf-8');

      const { ctx, skill } = await loadSkill('droid-custom');
      const customOutputDir = 'custom/droid/skills';
      const result = await droidRenderer.render(ctx, tempDir, skill, { outputDir: customOutputDir });

      expect(result.paths[0]).toBe(path.join(tempDir, customOutputDir, 'droid-custom', 'SKILL.md'));
      expect(result.supportingDirsAction!.assets).toBe('created');
      await expect(
        fs.access(path.join(tempDir, '.factory', 'skills', 'droid-custom', 'SKILL.md'))
      ).rejects.toThrow();

      const copied = await fs.readFile(
        path.join(tempDir, customOutputDir, 'droid-custom', 'assets', 'config.json'),
        'utf-8'
      );
      expect(copied).toContain('"key":"value"');
    });
  });

  // AC: @platform-renderer-trait ac-6
  describe('ac-6: Per-platform render hash written to .render-hash-<platform>', () => {
    it('should write per-platform hash file when storeHash is true', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      await claudeCodeRenderer.render(ctx, tempDir, skill, { storeHash: true });

      // Check for per-platform hash file
      const hashPath = getPlatformRenderHashPath(ctx.specDir, 'test-skill', 'claude-code');
      const hash = await fs.readFile(hashPath, 'utf-8');
      expect(hash.trim()).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should also write legacy hash for backward compatibility', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      await claudeCodeRenderer.render(ctx, tempDir, skill, { storeHash: true });

      // Check for legacy hash file (without platform suffix)
      const legacyHashPath = path.join(ctx.specDir, 'skills', 'test-skill', '.render-hash');
      const hash = await fs.readFile(legacyHashPath, 'utf-8');
      expect(hash.trim()).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should not write hash when storeHash is false', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      await claudeCodeRenderer.render(ctx, tempDir, skill, { storeHash: false });

      // Hash file should NOT exist
      const hashPath = getPlatformRenderHashPath(ctx.specDir, 'test-skill', 'claude-code');
      await expect(fs.access(hashPath)).rejects.toThrow();
    });

    it('should checkDrift using per-platform hash', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      // Render with hash
      await claudeCodeRenderer.render(ctx, tempDir, skill, { storeHash: true });

      // Check drift - should be in-sync
      const driftStatus = await claudeCodeRenderer.checkDrift(ctx.specDir, tempDir, 'test-skill');
      expect(driftStatus).toBe('in-sync');
    });

    it('should detect drift when rendered file is modified', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      // Render with hash
      await claudeCodeRenderer.render(ctx, tempDir, skill, { storeHash: true });

      // Modify the rendered file
      const renderedPath = path.join(tempDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
      const content = await fs.readFile(renderedPath, 'utf-8');
      await fs.writeFile(renderedPath, content + '\n# Manual edit\n', 'utf-8');

      // Check drift - should be drifted
      const driftStatus = await claudeCodeRenderer.checkDrift(ctx.specDir, tempDir, 'test-skill');
      expect(driftStatus).toBe('drifted');
    });

    it('should return not-rendered when file does not exist', async () => {
      const ctx = await initContext(tempDir);

      const driftStatus = await claudeCodeRenderer.checkDrift(ctx.specDir, tempDir, 'test-skill');
      expect(driftStatus).toBe('not-rendered');
    });

    it('should checkDrift with custom outputDir', async () => {
      const ctx = await initContext(tempDir);
      const metaCtx = await loadMetaContext(ctx);
      const skill = metaCtx.skills.find((s) => s.id === 'test-skill')!;

      const customOutputDir = 'custom/output/skills';

      // Render to custom location with hash
      await claudeCodeRenderer.render(ctx, tempDir, skill, {
        outputDir: customOutputDir,
        storeHash: true
      });

      // Check drift at default location - should be not-rendered
      const defaultDrift = await claudeCodeRenderer.checkDrift(ctx.specDir, tempDir, 'test-skill');
      expect(defaultDrift).toBe('not-rendered');

      // Check drift at custom location - should be in-sync
      const customDrift = await claudeCodeRenderer.checkDrift(ctx.specDir, tempDir, 'test-skill', {
        outputDir: customOutputDir,
      });
      expect(customDrift).toBe('in-sync');
    });
  });
});

describe('Platform Renderer Registry', () => {
  it('should return claude-code renderer from registry', () => {
    const renderer = getRenderer('claude-code');
    expect(renderer).toBeDefined();
    expect(renderer!.platform).toBe('claude-code');
  });

  it('should return droid renderer from registry', () => {
    const renderer = getRenderer('droid');
    expect(renderer).toBeDefined();
    expect(renderer).toBe(droidRenderer);
  });

  it('should return undefined for unknown platform', () => {
    const renderer = getRenderer('unknown-platform');
    expect(renderer).toBeUndefined();
  });

  it('should return all renderers', () => {
    const renderers = getAllRenderers();
    expect(renderers.length).toBeGreaterThan(0);
    expect(renderers.some((r) => r.platform === 'claude-code')).toBe(true);
    expect(renderers.some((r) => r.platform === 'droid')).toBe(true);
  });

  it('should allow registering custom renderers', () => {
    const mockRenderer: PlatformRenderer = {
      platform: 'test-platform',
      defaultOutputDir: '.test/skills',
      async render() {
        return {
          id: 'test',
          platform: 'test-platform',
          action: 'created',
          paths: [],
        };
      },
      async checkDrift() {
        return 'not-rendered';
      },
    };

    registerRenderer(mockRenderer);

    const retrieved = getRenderer('test-platform');
    expect(retrieved).toBe(mockRenderer);
  });
});

/**
 * Tests for Droid Skill Renderer
 */
describe('Droid Skill Renderer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function loadDroidSkill(skillId: string) {
    const ctx = await initContext(tempDir);
    const metaCtx = await loadMetaContext(ctx);
    const skill = metaCtx.skills.find((s) => s.id === skillId);
    return { ctx, skill };
  }

  // AC: @droid-renderer ac-1
  it('renders droid skills into .factory/skills/<id>/SKILL.md with YAML frontmatter', async () => {
    kspecFull(
      'skill add --id droid-skill --name "Droid Skill" --description "A skill for Droid"',
      tempDir
    );

    await fs.writeFile(
      path.join(tempDir, 'skills', 'droid-skill', 'SKILL.md'),
      '# Droid Skill\n\nDroid body.\n',
      'utf-8'
    );

    const { ctx, skill } = await loadDroidSkill('droid-skill');
    const result = await droidRenderer.render(ctx, tempDir, skill!, { storeHash: true });

    expect(result.action).toBe('created');
    expect(result.platform).toBe('droid');
    expect(result.paths[0]).toBe(path.join(tempDir, '.factory', 'skills', 'droid-skill', 'SKILL.md'));

    const rendered = await fs.readFile(result.paths[0], 'utf-8');
    expect(rendered).toContain('---');
    expect(rendered).toContain('name: droid-skill');
    expect(rendered).toContain('description: A skill for Droid');
  });

  // AC: @droid-renderer ac-2
  it('reads user-invocable from platform_config.droid', async () => {
    kspecFull(
      'skill add --id droid-ui --name "Droid UI" --description "Droid UI skill"',
      tempDir
    );

    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');
    metaContent = metaContent.replace(
      /id: droid-ui\n/,
      'id: droid-ui\n    platform_config:\n      droid:\n        user_invocable: false\n'
    );
    await fs.writeFile(metaPath, metaContent, 'utf-8');

    const { ctx, skill } = await loadDroidSkill('droid-ui');
    const frontmatter = generateDroidFrontmatter(skill!);

    expect(frontmatter).toContain('user-invocable: false');
    expect(frontmatter).not.toContain('user_invocable');
  });

  // AC: @droid-renderer ac-4
  it('includes the kspec-managed marker in rendered droid skill files', async () => {
    kspecFull(
      'skill add --id droid-marker --name "Droid Marker" --description "Marker skill"',
      tempDir
    );
    await fs.writeFile(
      path.join(tempDir, 'skills', 'droid-marker', 'SKILL.md'),
      '# Droid Marker\n',
      'utf-8'
    );

    const { ctx, skill } = await loadDroidSkill('droid-marker');
    await droidRenderer.render(ctx, tempDir, skill!);

    const rendered = await fs.readFile(
      path.join(tempDir, '.factory', 'skills', 'droid-marker', 'SKILL.md'),
      'utf-8'
    );
    expect(rendered).toContain('<!-- kspec-managed -->');
  });

  // AC: @droid-renderer ac-5
  it('resolves portable skill tokens to droid slash invocations', async () => {
    kspecFull(
      'skill add --id task-work --name "Task Work" --description "Core Task Work" --origin core',
      tempDir
    );
    kspecFull(
      'skill add --id helper --name "Helper" --description "Project Helper"',
      tempDir
    );
    await fs.writeFile(
      path.join(tempDir, 'skills', 'helper', 'SKILL.md'),
      '# Helper\n\nUse {skill:task-work} and {skill:helper}.\n',
      'utf-8'
    );

    const { ctx, skill } = await loadDroidSkill('helper');
    await droidRenderer.render(ctx, tempDir, skill!);

    const rendered = await fs.readFile(
      path.join(tempDir, '.factory', 'skills', 'helper', 'SKILL.md'),
      'utf-8'
    );
    expect(rendered).toContain('/kspec-task-work');
    expect(rendered).toContain('/helper');
    expect(rendered).not.toContain('{skill:task-work}');
    expect(rendered).not.toContain('{skill:helper}');
  });

  // AC: @droid-renderer ac-6
  it('writes a per-platform droid render hash when storeHash is true', async () => {
    kspecFull(
      'skill add --id droid-hash --name "Droid Hash" --description "Hash skill"',
      tempDir
    );
    await fs.writeFile(
      path.join(tempDir, 'skills', 'droid-hash', 'SKILL.md'),
      '# Droid Hash\n',
      'utf-8'
    );

    const { ctx, skill } = await loadDroidSkill('droid-hash');
    await droidRenderer.render(ctx, tempDir, skill!, { storeHash: true });

    const hashPath = getPlatformRenderHashPath(ctx.specDir, 'droid-hash', 'droid');
    const hash = await fs.readFile(hashPath, 'utf-8');
    expect(hash.trim()).toMatch(/^[a-f0-9]{64}$/);
  });

  // AC: @droid-renderer ac-7
  it('returns .factory/skills as the default droid output directory', () => {
    expect(getPlatformDefaultOutputDir('droid')).toBe('.factory/skills');
    expect(droidRenderer.defaultOutputDir).toBe('.factory/skills');
  });

  // AC: @droid-renderer ac-8
  it('reads disable-model-invocation from platform_config.droid', async () => {
    kspecFull(
      'skill add --id droid-dmi --name "Droid DMI" --description "Droid disable model invocation"',
      tempDir
    );

    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');
    metaContent = metaContent.replace(
      /id: droid-dmi\n/,
      'id: droid-dmi\n    platform_config:\n      droid:\n        disable_model_invocation: true\n'
    );
    await fs.writeFile(metaPath, metaContent, 'utf-8');

    const { skill } = await loadDroidSkill('droid-dmi');
    const frontmatter = generateDroidFrontmatter(skill!);

    expect(frontmatter).toContain('disable-model-invocation: true');
    expect(frontmatter).not.toContain('disable_model_invocation');
  });
});

describe('Per-Platform Hash Functions', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('getPlatformRenderHashPath returns correct path', () => {
    const hashPath = getPlatformRenderHashPath('/path/to/specDir', 'skill-id', 'claude-code');
    expect(hashPath).toBe('/path/to/specDir/skills/skill-id/.render-hash-claude-code');
  });

  it('writePlatformRenderHash and readPlatformRenderHash round-trip', async () => {
    const skillId = 'test-skill';
    const platform = 'claude-code';
    const hash = 'abc123def456';

    // Create skills directory
    await fs.mkdir(path.join(tempDir, 'skills', skillId), { recursive: true });

    await writePlatformRenderHash(tempDir, skillId, platform, hash);
    const read = await readPlatformRenderHash(tempDir, skillId, platform);

    expect(read).toBe(hash);
  });

  it('readPlatformRenderHash returns null when file does not exist', async () => {
    const read = await readPlatformRenderHash(tempDir, 'nonexistent', 'claude-code');
    expect(read).toBeNull();
  });

  it('checkPlatformSkillDrift returns not-rendered when rendered file missing', async () => {
    const result = await checkPlatformSkillDrift(
      tempDir,
      tempDir,
      'nonexistent-skill',
      'claude-code'
    );
    expect(result).toBe('not-rendered');
  });
});
