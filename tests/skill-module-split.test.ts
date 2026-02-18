/**
 * Tests for Skill Module Split
 *
 * AC: @skill-module-split ac-1 - skill.ts split into focused modules
 * AC: @skill-module-split ac-2 - shared render logic extracted into base function
 * AC: @skill-module-split ac-3 - re-exports maintain backward API compatibility
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const srcDir = path.resolve(__dirname, '../src/cli/commands');
const parserDir = path.resolve(__dirname, '../src/parser');

// AC: @skill-module-split ac-1
describe('AC-1: skill.ts split into focused modules', () => {
  it('should have skill-crud.ts module', async () => {
    // AC: @skill-module-split ac-1
    const stat = await fs.stat(path.join(srcDir, 'skill-crud.ts'));
    expect(stat.isFile()).toBe(true);
  });

  it('should have skill-install.ts module', async () => {
    // AC: @skill-module-split ac-1
    const stat = await fs.stat(path.join(srcDir, 'skill-install.ts'));
    expect(stat.isFile()).toBe(true);
  });

  it('should have skill-diff.ts module', async () => {
    // AC: @skill-module-split ac-1
    const stat = await fs.stat(path.join(srcDir, 'skill-diff.ts'));
    expect(stat.isFile()).toBe(true);
  });

  it('should have a thin skill.ts orchestrator', async () => {
    // AC: @skill-module-split ac-1
    const content = await fs.readFile(path.join(srcDir, 'skill.ts'), 'utf-8');
    const lines = content.split('\n').length;
    // Orchestrator should be significantly smaller than original (~2350 lines)
    expect(lines).toBeLessThan(100);
  });

  it('should delegate to focused modules from skill.ts', async () => {
    // AC: @skill-module-split ac-1
    const content = await fs.readFile(path.join(srcDir, 'skill.ts'), 'utf-8');
    expect(content).toContain('registerSkillCrudCommands');
    expect(content).toContain('registerSkillInstallCommands');
    expect(content).toContain('registerSkillDiffCommands');
  });
});

// AC: @skill-module-split ac-2
describe('AC-2: shared render logic extracted into renderSkillBase', () => {
  it('should export renderSkillBase from skill-render.ts', async () => {
    // AC: @skill-module-split ac-2
    const mod = await import('../src/parser/skill-render.js');
    expect(typeof mod.renderSkillBase).toBe('function');
  });

  it('should have renderSkillBase used by both renderers', async () => {
    // AC: @skill-module-split ac-2
    const content = await fs.readFile(path.join(parserDir, 'skill-render.ts'), 'utf-8');
    // Both Claude Code and Codex renderers should call renderSkillBase
    const matches = content.match(/renderSkillBase\(/g);
    // At least 3 occurrences: the export definition + claude-code render + codex render
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });
});

// AC: @skill-module-split ac-3
describe('AC-3: re-exports maintain backward API compatibility', () => {
  it('should re-export getExpectedRenderedContent from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.getExpectedRenderedContent).toBe('function');
  });

  it('should re-export generateUnifiedDiff from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.generateUnifiedDiff).toBe('function');
  });

  it('should re-export loadCoreSkillsManifest from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.loadCoreSkillsManifest).toBe('function');
  });

  it('should re-export loadCoreSkillContent from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.loadCoreSkillContent).toBe('function');
  });

  it('should re-export getKspecPackageVersion from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.getKspecPackageVersion).toBe('function');
  });

  it('should re-export isKspecManaged from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.isKspecManaged).toBe('function');
  });

  it('should re-export KSPEC_MANAGED_MARKER from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.KSPEC_MANAGED_MARKER).toBe('string');
  });

  it('should re-export renderClaudeCodeSkill from skill.ts', async () => {
    // AC: @skill-module-split ac-3
    const mod = await import('../src/cli/commands/skill.js');
    expect(typeof mod.renderClaudeCodeSkill).toBe('function');
  });
});
