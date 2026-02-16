/**
 * Tests for Multi-Platform Render CLI
 * AC: @multi-platform-render-cli ac-1 through ac-7
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspec as kspecFull,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Multi-Platform Render CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @multi-platform-render-cli ac-1
  describe('ac-1: Skills with multiple platforms render to all platforms', () => {
    it('should render to both claude-code and codex when skill has both platforms', async () => {
      // Create a skill with both platforms
      kspecFull(
        'skill add --id multi-plat --name "Multi Platform" --description "Test multi-platform" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'multi-plat', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Multi Platform Skill\n\nContent here.\n', 'utf-8');

      // Render
      kspecFull('skill render', tempDir);

      // Check claude-code output
      const claudeCodePath = path.join(tempDir, '.claude', 'skills', 'multi-plat', 'SKILL.md');
      const claudeCodeContent = await fs.readFile(claudeCodePath, 'utf-8');
      expect(claudeCodeContent).toContain('name: multi-plat');
      expect(claudeCodeContent).toContain('<!-- kspec-managed -->');
      expect(claudeCodeContent).toContain('# Multi Platform Skill');

      // Check codex output
      const codexPath = path.join(tempDir, '.agents', 'skills', 'multi-plat', 'SKILL.md');
      const codexContent = await fs.readFile(codexPath, 'utf-8');
      expect(codexContent).toContain('name: multi-plat');
      expect(codexContent).toContain('<!-- kspec-managed -->');
      expect(codexContent).toContain('# Multi Platform Skill');
    });

    it('should report results for both platforms', async () => {
      kspecFull(
        'skill add --id both-plat --name "Both Platforms" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'both-plat', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Both Platforms\n', 'utf-8');

      const result = kspecJson<{
        rendered: { id: string; platform: string; action: string }[];
      }>('skill render --json', tempDir);

      // Should have results for both platforms
      const claudeCodeResult = result.rendered.find(
        (r) => r.id === 'both-plat' && r.platform === 'claude-code'
      );
      const codexResult = result.rendered.find(
        (r) => r.id === 'both-plat' && r.platform === 'codex'
      );

      expect(claudeCodeResult).toBeDefined();
      expect(codexResult).toBeDefined();
      expect(claudeCodeResult?.action).toBe('created');
      expect(codexResult?.action).toBe('created');
    });
  });

  // AC: @multi-platform-render-cli ac-2
  describe('ac-2: Skills with only codex platform render only to codex', () => {
    it('should render only to codex when skill has only codex platform', async () => {
      kspecFull(
        'skill add --id codex-only --name "Codex Only" --description "Test" --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'codex-only', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Codex Only\n', 'utf-8');

      kspecFull('skill render', tempDir);

      // Check codex output exists
      const codexPath = path.join(tempDir, '.agents', 'skills', 'codex-only', 'SKILL.md');
      const codexContent = await fs.readFile(codexPath, 'utf-8');
      expect(codexContent).toContain('name: codex-only');

      // Check claude-code output does NOT exist
      const claudeCodePath = path.join(tempDir, '.claude', 'skills', 'codex-only', 'SKILL.md');
      await expect(fs.access(claudeCodePath)).rejects.toThrow();
    });

    it('should only include codex result in JSON output', async () => {
      kspecFull(
        'skill add --id codex-only2 --name "Codex Only 2" --description "Test" --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'codex-only2', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Codex Only 2\n', 'utf-8');

      const result = kspecJson<{
        rendered: { id: string; platform: string }[];
      }>('skill render --json', tempDir);

      const skillResults = result.rendered.filter((r) => r.id === 'codex-only2');
      expect(skillResults.length).toBe(1);
      expect(skillResults[0].platform).toBe('codex');
    });
  });

  // AC: @multi-platform-render-cli ac-3
  describe('ac-3: Status shows per-platform rows', () => {
    it('should show separate rows for each platform in status', async () => {
      kspecFull(
        'skill add --id status-multi --name "Status Multi" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'status-multi', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Status Multi\n', 'utf-8');

      // Render to create the files
      kspecFull('skill render', tempDir);

      // Check status
      const result = kspecJson<{
        id: string;
        platform: string;
        status: string;
      }[]>('skill status --json', tempDir);

      const claudeCodeStatus = result.find(
        (r) => r.id === 'status-multi' && r.platform === 'claude-code'
      );
      const codexStatus = result.find(
        (r) => r.id === 'status-multi' && r.platform === 'codex'
      );

      expect(claudeCodeStatus).toBeDefined();
      expect(codexStatus).toBeDefined();
      expect(claudeCodeStatus?.status).toBe('in-sync');
      expect(codexStatus?.status).toBe('in-sync');
    });

    it('should show Platform column in table output', async () => {
      kspecFull(
        'skill add --id status-table --name "Status Table" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'status-table', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Status Table\n', 'utf-8');

      kspecFull('skill render', tempDir);

      const output = kspec('skill status', tempDir);

      // Should show both platforms
      expect(output).toContain('claude-code');
      expect(output).toContain('codex');
      expect(output).toContain('Platform');
    });
  });

  // AC: @multi-platform-render-cli ac-4
  describe('ac-4: Custom --output-dir overrides platform default', () => {
    it('should render to custom directory when --output-dir is specified', async () => {
      kspecFull(
        'skill add --id custom-out --name "Custom Out" --description "Test" --platform claude-code',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'custom-out', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Custom Out\n', 'utf-8');

      kspecFull('skill render --output-dir custom/rendered', tempDir);

      // Check custom location
      const customPath = path.join(tempDir, 'custom', 'rendered', 'custom-out', 'SKILL.md');
      const content = await fs.readFile(customPath, 'utf-8');
      expect(content).toContain('name: custom-out');

      // Default location should NOT exist
      const defaultPath = path.join(tempDir, '.claude', 'skills', 'custom-out', 'SKILL.md');
      await expect(fs.access(defaultPath)).rejects.toThrow();
    });

    it('should apply custom output-dir to all platforms when multi-platform', async () => {
      kspecFull(
        'skill add --id custom-multi --name "Custom Multi" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'custom-multi', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Custom Multi\n', 'utf-8');

      kspecFull('skill render --output-dir shared/output', tempDir);

      // Both should be in the custom directory
      const claudeCodePath = path.join(tempDir, 'shared', 'output', 'custom-multi', 'SKILL.md');
      const codexPath = path.join(tempDir, 'shared', 'output', 'custom-multi', 'SKILL.md');

      // Since both use the same output dir, only one file exists (last one wins)
      // This is expected behavior - custom output-dir means ALL platforms go there
      const content = await fs.readFile(claudeCodePath, 'utf-8');
      expect(content).toContain('name: custom-multi');
    });
  });

  // AC: @multi-platform-render-cli ac-5
  describe('ac-5: --clean operates per-platform', () => {
    it('should clean orphans from each platform directory', async () => {
      // Create skills for both platforms
      kspecFull(
        'skill add --id keep-skill --name "Keep" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'keep-skill', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Keep\n', 'utf-8');

      // Render to create the outputs
      kspecFull('skill render', tempDir);

      // Manually create orphan directories in both locations
      const orphanClaudePath = path.join(tempDir, '.claude', 'skills', 'orphan-skill', 'SKILL.md');
      await fs.mkdir(path.dirname(orphanClaudePath), { recursive: true });
      await fs.writeFile(orphanClaudePath, '---\nname: orphan\ndescription: orphan\n---\n<!-- kspec-managed -->\n# Orphan\n', 'utf-8');

      const orphanCodexPath = path.join(tempDir, '.agents', 'skills', 'orphan-codex', 'SKILL.md');
      await fs.mkdir(path.dirname(orphanCodexPath), { recursive: true });
      await fs.writeFile(orphanCodexPath, '---\nname: orphan-codex\ndescription: orphan\n---\n<!-- kspec-managed -->\n# Orphan\n', 'utf-8');

      // Run clean
      kspecFull('skill render --clean', tempDir);

      // Orphans should be removed
      await expect(fs.access(path.dirname(orphanClaudePath))).rejects.toThrow();
      await expect(fs.access(path.dirname(orphanCodexPath))).rejects.toThrow();

      // Keep skill should still exist
      const keepClaudePath = path.join(tempDir, '.claude', 'skills', 'keep-skill', 'SKILL.md');
      const keepCodexPath = path.join(tempDir, '.agents', 'skills', 'keep-skill', 'SKILL.md');
      await expect(fs.access(keepClaudePath)).resolves.toBeUndefined();
      await expect(fs.access(keepCodexPath)).resolves.toBeUndefined();
    });

    it('should include platform in clean results JSON', async () => {
      // Create a skill
      kspecFull(
        'skill add --id clean-test --name "Clean" --description "Test" --platform claude-code',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'clean-test', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Clean\n', 'utf-8');
      kspecFull('skill render', tempDir);

      // Create orphan
      const orphanPath = path.join(tempDir, '.claude', 'skills', 'orphan-clean', 'SKILL.md');
      await fs.mkdir(path.dirname(orphanPath), { recursive: true });
      await fs.writeFile(orphanPath, '---\nname: orphan\ndescription: orphan\n---\n<!-- kspec-managed -->\n# Orphan\n', 'utf-8');

      const result = kspecJson<{
        cleaned: { id: string; platform?: string; action: string }[];
      }>('skill render --clean --json', tempDir);

      const orphanClean = result.cleaned.find((c) => c.id === 'orphan-clean');
      expect(orphanClean).toBeDefined();
      expect(orphanClean?.platform).toBe('claude-code');
      expect(orphanClean?.action).toBe('removed');
    });
  });

  // AC: @multi-platform-render-cli ac-6
  describe('ac-6: Render table includes Platform column', () => {
    it('should show platform in table output', async () => {
      kspecFull(
        'skill add --id table-test --name "Table Test" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'table-test', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Table Test\n', 'utf-8');

      const output = kspec('skill render', tempDir);

      // Output should show platform in brackets
      expect(output).toContain('[claude-code]');
      expect(output).toContain('[codex]');
    });

    it('should include platform in JSON output', async () => {
      kspecFull(
        'skill add --id json-plat --name "JSON Platform" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'json-plat', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# JSON Platform\n', 'utf-8');

      const result = kspecJson<{
        rendered: { id: string; platform: string }[];
      }>('skill render --json', tempDir);

      for (const r of result.rendered) {
        expect(r.platform).toBeDefined();
        expect(['claude-code', 'codex']).toContain(r.platform);
      }
    });
  });

  // AC: @multi-platform-render-cli ac-7
  describe('ac-7: Unregistered platform shows warning', () => {
    it('should warn for unregistered platform and skip it', async () => {
      kspecFull(
        'skill add --id unreg-plat --name "Unreg Platform" --description "Test" --platform claude-code --platform unknown-platform',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'unreg-plat', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Unreg Platform\n', 'utf-8');

      const output = kspec('skill render', tempDir);

      // Should show warning
      expect(output.toLowerCase()).toContain('unregistered');
      expect(output).toContain('unknown-platform');
    });

    it('should include warning in JSON output', async () => {
      kspecFull(
        'skill add --id json-unreg --name "JSON Unreg" --description "Test" --platform claude-code --platform fake-plat',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'json-unreg', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# JSON Unreg\n', 'utf-8');

      const result = kspecJson<{
        warnings: string[];
        rendered: { id: string; platform: string; action: string; skipReason?: string }[];
      }>('skill render --json', tempDir);

      expect(result.warnings).toBeDefined();
      expect(result.warnings.some((w) => w.includes('fake-plat'))).toBe(true);

      // Should have skipped result for the unregistered platform
      const skippedResult = result.rendered.find(
        (r) => r.id === 'json-unreg' && r.platform === 'fake-plat'
      );
      expect(skippedResult).toBeDefined();
      expect(skippedResult?.action).toBe('skipped');
      expect(skippedResult?.skipReason).toContain('unregistered');
    });

    it('should still render to valid platforms when one is unregistered', async () => {
      kspecFull(
        'skill add --id partial-valid --name "Partial Valid" --description "Test" --platform claude-code --platform bad-platform',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'partial-valid', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Partial Valid\n', 'utf-8');

      kspecFull('skill render', tempDir);

      // Claude-code should be rendered
      const claudeCodePath = path.join(tempDir, '.claude', 'skills', 'partial-valid', 'SKILL.md');
      const content = await fs.readFile(claudeCodePath, 'utf-8');
      expect(content).toContain('name: partial-valid');

      // Bad platform should not create any output (no .bad-platform directory)
      const badPath = path.join(tempDir, '.bad-platform');
      await expect(fs.access(badPath)).rejects.toThrow();
    });
  });

  // Additional edge cases
  describe('Edge cases', () => {
    it('should handle skill with empty platforms array gracefully', async () => {
      // Create a skill, then manually set empty platforms (edge case)
      kspecFull(
        'skill add --id no-plat --name "No Platform" --description "Test" --platform claude-code',
        tempDir
      );

      // Remove the platform
      kspecFull('skill set @no-plat --remove-platform claude-code', tempDir);

      const skillMdPath = path.join(tempDir, 'skills', 'no-plat', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# No Platform\n', 'utf-8');

      // Should not error, just produce no render results for that skill
      const result = kspecJson<{
        rendered: { id: string }[];
      }>('skill render --json', tempDir);

      const noPlat = result.rendered.filter((r) => r.id === 'no-plat');
      expect(noPlat.length).toBe(0);
    });

    it('should handle --dry-run with multiple platforms', async () => {
      kspecFull(
        'skill add --id dryrun-multi --name "DryRun Multi" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'dryrun-multi', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# DryRun Multi\n', 'utf-8');

      const result = kspecJson<{
        dry_run: boolean;
        rendered: { id: string; platform: string; action: string }[];
      }>('skill render --dry-run --json', tempDir);

      expect(result.dry_run).toBe(true);

      // Should show created for both platforms
      const claudeResult = result.rendered.find(
        (r) => r.id === 'dryrun-multi' && r.platform === 'claude-code'
      );
      const codexResult = result.rendered.find(
        (r) => r.id === 'dryrun-multi' && r.platform === 'codex'
      );

      expect(claudeResult?.action).toBe('created');
      expect(codexResult?.action).toBe('created');

      // Files should NOT exist
      await expect(
        fs.access(path.join(tempDir, '.claude', 'skills', 'dryrun-multi'))
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(tempDir, '.agents', 'skills', 'dryrun-multi'))
      ).rejects.toThrow();
    });

    it('should handle --force with drifted skills on multiple platforms', async () => {
      kspecFull(
        'skill add --id force-multi --name "Force Multi" --description "Test" --platform claude-code --platform codex',
        tempDir
      );

      const skillMdPath = path.join(tempDir, 'skills', 'force-multi', 'SKILL.md');
      await fs.writeFile(skillMdPath, '# Force Multi\n', 'utf-8');

      // Render first
      kspecFull('skill render', tempDir);

      // Modify rendered files to create drift
      const claudePath = path.join(tempDir, '.claude', 'skills', 'force-multi', 'SKILL.md');
      const codexPath = path.join(tempDir, '.agents', 'skills', 'force-multi', 'SKILL.md');

      await fs.appendFile(claudePath, '\n# Manual edit\n');
      await fs.appendFile(codexPath, '\n# Manual edit\n');

      // Render without force - should skip
      const resultNoForce = kspecJson<{
        rendered: { id: string; platform: string; action: string }[];
      }>('skill render --json', tempDir);

      const claudeSkipped = resultNoForce.rendered.find(
        (r) => r.id === 'force-multi' && r.platform === 'claude-code'
      );
      expect(claudeSkipped?.action).toBe('skipped');

      // Render with force - should update
      const resultForce = kspecJson<{
        rendered: { id: string; platform: string; action: string }[];
      }>('skill render --force --json', tempDir);

      const claudeForced = resultForce.rendered.find(
        (r) => r.id === 'force-multi' && r.platform === 'claude-code'
      );
      expect(claudeForced?.action).toBe('updated');
    });
  });
});
