/**
 * Tests for Skill CLI Commands
 * AC: @skill-cli ac-1 through ac-8
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  kspecOutput as kspec,
  kspecJson,
  kspec as kspecFull,
  setupTempFixtures,
  cleanupTempDir,
  createTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Skill CLI - skill list', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create some skills via kspec add - note: run sequentially
    const result1 = kspecFull(
      'skill add --id task-work --name "Task Work" --description "Work on tasks" --origin core --skill-version 0.1.0',
      tempDir
    );
    const result2 = kspecFull(
      'skill add --id pr-review --name "PR Review" --origin project --tag workflow --tag review',
      tempDir
    );
    // Fail fast if skill creation failed
    if (result1.exitCode !== 0) throw new Error(`skill add failed: ${result1.stderr}`);
    if (result2.exitCode !== 0) throw new Error(`skill add failed: ${result2.stderr}`);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-cli ac-1
  it('should display table with ID, Name, Origin, Version, and Platforms columns', () => {
    const output = kspec('skill list', tempDir);

    // Check headers are present
    expect(output).toContain('ID');
    expect(output).toContain('Name');
    expect(output).toContain('Origin');
    expect(output).toContain('Version');
    expect(output).toContain('Platforms');

    // Check data
    expect(output).toContain('task-work');
    expect(output).toContain('Task Work');
    expect(output).toContain('core');
    expect(output).toContain('pr-review');
    expect(output).toContain('PR Review');
    expect(output).toContain('project');

    // Check skill count
    expect(output).toContain('2 skill(s)');
  });

  // AC: @skill-cli ac-2
  it('should return JSON array with full skill metadata when --json flag provided', () => {
    const result = kspecJson<Array<{
      _ulid: string;
      id: string;
      name: string;
      description?: string;
      origin: string;
      version?: string;
      platforms: string[];
      depends_on: string[];
      tags: string[];
    }>>('skill list', tempDir);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);

    const taskWork = result.find(s => s.id === 'task-work');
    expect(taskWork).toBeDefined();
    expect(taskWork?._ulid).toMatch(/^[0-9A-Z]{26}$/);
    expect(taskWork?.name).toBe('Task Work');
    expect(taskWork?.description).toBe('Work on tasks');
    expect(taskWork?.origin).toBe('core');
    expect(taskWork?.version).toBe('0.1.0');
    expect(taskWork?.platforms).toContain('claude-code');
    expect(taskWork?.depends_on).toEqual([]);

    const prReview = result.find(s => s.id === 'pr-review');
    expect(prReview).toBeDefined();
    expect(prReview?.origin).toBe('project');
    expect(prReview?.tags).toContain('workflow');
    expect(prReview?.tags).toContain('review');
  });

  it('should filter by origin', () => {
    const result = kspecJson<Array<{ id: string; origin: string }>>('skill list --origin core', tempDir);

    expect(result.length).toBe(1);
    expect(result[0].id).toBe('task-work');
    expect(result[0].origin).toBe('core');
  });

  it('should filter by tag', () => {
    const result = kspecJson<Array<{ id: string; tags: string[] }>>('skill list --tag workflow', tempDir);

    expect(result.length).toBe(1);
    expect(result[0].id).toBe('pr-review');
    expect(result[0].tags).toContain('workflow');
  });

  it('should show message when no skills defined', async () => {
    // Create fresh project with no skills
    const emptyDir = await createTempDir();
    await initGitRepo(emptyDir);
    await fs.writeFile(path.join(emptyDir, 'kynetic.yaml'), yamlStringify({ kynetic: '1.0' }));
    await fs.writeFile(
      path.join(emptyDir, 'kynetic.meta.yaml'),
      yamlStringify({ kynetic_meta: '1.0', skills: [] })
    );

    try {
      const output = kspec('skill list', emptyDir);
      expect(output).toContain('No skills defined');
    } finally {
      await cleanupTempDir(emptyDir);
    }
  });
});

describe('Skill CLI - skill add', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-cli ac-3
  // AC: @skill-add ac-1 - meta entry created
  it('should create meta entry with correct origin', () => {
    const result = kspecJson<{
      _ulid: string;
      id: string;
      name: string;
      origin: string;
    }>('skill add --id my-skill --name "My Skill" --description "A test skill"', tempDir);

    expect(result.id).toBe('my-skill');
    expect(result.name).toBe('My Skill');
    expect(result.origin).toBe('project'); // Default origin
    expect(result._ulid).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('should create meta entry with custom origin', () => {
    const result = kspecJson<{ id: string; origin: string }>(
      'skill add --id local-skill --name "Local Skill" --origin local',
      tempDir
    );

    expect(result.origin).toBe('local');
  });

  // AC: @skill-add ac-4, ac-5 - origin and version set correctly
  it('should set origin and version when --origin core --skill-version provided', () => {
    const result = kspecJson<{ id: string; origin: string; version: string }>(
      'skill add --id core-skill --name "Core Skill" --origin core --skill-version 0.2.0',
      tempDir
    );

    // AC: @skill-add ac-4 - origin is core
    expect(result.origin).toBe('core');
    // AC: @skill-add ac-5 - version is 0.2.0
    expect(result.version).toBe('0.2.0');
  });

  // AC: @skill-cli ac-4
  it('should create .kspec/skills/<id>/SKILL.md file', async () => {
    kspec('skill add --id my-skill --name "My Skill" --description "Test skill"', tempDir);

    const skillMdPath = path.join(tempDir, 'skills', 'my-skill', 'SKILL.md');
    const exists = await fs.access(skillMdPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    const content = await fs.readFile(skillMdPath, 'utf-8');
    expect(content).toContain('# My Skill');
    expect(content).toContain('Test skill');
  });

  it('should add skill to meta manifest', async () => {
    kspec('skill add --id my-skill --name "My Skill"', tempDir);

    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const meta = yamlParse(metaContent);

    expect(meta.skills).toBeDefined();
    const skill = meta.skills.find((s: { id: string }) => s.id === 'my-skill');
    expect(skill).toBeDefined();
    expect(skill.name).toBe('My Skill');
  });

  it('should set platforms to default value when not specified', () => {
    const result = kspecJson<{ platforms: string[] }>(
      'skill add --id my-skill --name "My Skill"',
      tempDir
    );

    expect(result.platforms).toEqual(['claude-code']);
  });

  it('should accept custom platforms', () => {
    const result = kspecJson<{ platforms: string[] }>(
      'skill add --id my-skill --name "My Skill" --platform cursor --platform windsurf',
      tempDir
    );

    expect(result.platforms).toContain('cursor');
    expect(result.platforms).toContain('windsurf');
  });

  it('should accept version option', () => {
    const result = kspecJson<{ version: string }>(
      'skill add --id my-skill --name "My Skill" --skill-version 1.2.3',
      tempDir
    );

    expect(result.version).toBe('1.2.3');
  });

  it('should accept tags option', () => {
    const result = kspecJson<{ tags: string[] }>(
      'skill add --id my-skill --name "My Skill" --tag workflow --tag automation',
      tempDir
    );

    expect(result.tags).toContain('workflow');
    expect(result.tags).toContain('automation');
  });

  it('should accept depends-on option', () => {
    // First create a skill to depend on
    kspec('skill add --id base-skill --name "Base Skill"', tempDir);

    const result = kspecJson<{ depends_on: string[] }>(
      'skill add --id my-skill --name "My Skill" --depends-on @base-skill',
      tempDir
    );

    expect(result.depends_on).toContain('@base-skill');
  });

  // AC: @skill-add ac-6 - duplicate ID error
  it('should reject duplicate skill ID', () => {
    kspec('skill add --id my-skill --name "My Skill"', tempDir);

    const result = kspecFull('skill add --id my-skill --name "Another Skill"', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists");
  });

  it('should reject invalid origin', () => {
    const result = kspecFull('skill add --id my-skill --name "My Skill" --origin invalid', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid origin");
  });

  it('should validate kebab-case ID', () => {
    const result = kspecFull('skill add --id MySkill --name "My Skill"', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("kebab-case");
  });

  // AC: @skill-add ac-3 - --content-file copies file to SKILL.md
  it('should copy content from --content-file to SKILL.md', async () => {
    // Create a source file with custom content
    const sourceContent = `# Custom Skill Content

This content comes from an existing file.

## Usage

Use this skill for custom tasks.
`;
    const sourceFile = path.join(tempDir, 'custom-skill.md');
    await fs.writeFile(sourceFile, sourceContent);

    // Create skill with --content-file
    kspec(`skill add --id custom-skill --name "Custom Skill" --content-file ${sourceFile}`, tempDir);

    // Verify SKILL.md has the content from the source file
    const skillMdPath = path.join(tempDir, 'skills', 'custom-skill', 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');
    expect(content).toBe(sourceContent);
    expect(content).toContain('Custom Skill Content');
    expect(content).toContain('This content comes from an existing file');
  });

  // AC: @skill-add ac-3 - --content-file with relative path
  it('should handle relative path for --content-file', async () => {
    // Create a source file with custom content
    const sourceContent = '# Relative Path Skill\n\nContent from relative path.\n';
    const sourceFile = path.join(tempDir, 'relative-source.md');
    await fs.writeFile(sourceFile, sourceContent);

    // Run kspec from tempDir so relative path works
    // Note: kspec already runs from tempDir
    kspec('skill add --id rel-skill --name "Relative Skill" --content-file relative-source.md', tempDir);

    // Verify SKILL.md has the content
    const skillMdPath = path.join(tempDir, 'skills', 'rel-skill', 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');
    expect(content).toBe(sourceContent);
  });

  // AC: @skill-add ac-3 - error when content file doesn't exist
  it('should error when --content-file does not exist', () => {
    const result = kspecFull(
      'skill add --id bad-skill --name "Bad Skill" --content-file /nonexistent/file.md',
      tempDir,
      { expectFail: true }
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Failed to read content file');
  });
});

describe('Skill CLI - skill get', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a skill with custom content
    const result = kspecFull(
      'skill add --id task-work --name "Task Work" --description "Work on tasks" --origin core --skill-version 0.1.0 --tag workflow',
      tempDir
    );
    if (result.exitCode !== 0) throw new Error(`skill add failed: ${result.stderr}`);

    // Update SKILL.md with custom content - the directory was created by skill add
    const skillMdPath = path.join(tempDir, 'skills', 'task-work', 'SKILL.md');
    await fs.writeFile(skillMdPath, `# Task Work

Use this skill when working on kspec tasks.

## Usage

\`\`\`bash
kspec task start @ref
\`\`\`
`);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-cli ac-5
  it('should display metadata including id, name, origin, and platforms', () => {
    const output = kspec('skill get @task-work', tempDir);

    expect(output).toContain('Task Work');
    expect(output).toContain('ID:');
    expect(output).toContain('task-work');
    expect(output).toContain('Origin:');
    expect(output).toContain('core');
    expect(output).toContain('Platforms:');
    expect(output).toContain('claude-code');
    expect(output).toContain('Version:');
    expect(output).toContain('0.1.0');
  });

  // AC: @skill-cli ac-6
  it('should display SKILL.md content', () => {
    const output = kspec('skill get @task-work', tempDir);

    expect(output).toContain('SKILL.md Content');
    expect(output).toContain('Use this skill when working on kspec tasks');
    expect(output).toContain('kspec task start @ref');
  });

  it('should include all metadata in JSON output', () => {
    const result = kspecJson<{
      _ulid: string;
      id: string;
      name: string;
      description: string;
      origin: string;
      version: string;
      platforms: string[];
      depends_on: string[];
      tags: string[];
      content: string;
      docs: Array<{ name: string; path: string }>;
    }>('skill get @task-work', tempDir);

    expect(result.id).toBe('task-work');
    expect(result.name).toBe('Task Work');
    expect(result.description).toBe('Work on tasks');
    expect(result.origin).toBe('core');
    expect(result.version).toBe('0.1.0');
    expect(result.platforms).toContain('claude-code');
    expect(result.tags).toContain('workflow');
    expect(result.content).toContain('Use this skill when working on kspec tasks');
    expect(Array.isArray(result.docs)).toBe(true);
  });

  it('should find skill by ULID prefix', async () => {
    // Get the skill's ULID first
    const list = kspecJson<Array<{ _ulid: string; id: string }>>('skill list', tempDir);
    const skill = list.find(s => s.id === 'task-work');
    const ulidPrefix = skill?._ulid.slice(0, 8);

    const output = kspec(`skill get @${ulidPrefix}`, tempDir);
    expect(output).toContain('task-work');
    expect(output).toContain('Task Work');
  });

  it('should return error when skill not found', () => {
    const result = kspecFull('skill get @nonexistent', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
  });

  it('should show (No SKILL.md content found) when file missing', async () => {
    // Delete the SKILL.md file
    const skillMdPath = path.join(tempDir, 'skills', 'task-work', 'SKILL.md');
    await fs.unlink(skillMdPath);

    const output = kspec('skill get @task-work', tempDir);
    expect(output).toContain('No SKILL.md content found');
  });
});

describe('Skill CLI - skill delete', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create skills
    kspec('skill add --id my-skill --name "My Skill"', tempDir);
    kspec('skill add --id dependent-skill --name "Dependent Skill" --depends-on @my-skill', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-cli ac-7
  it('should remove meta entry from manifest when --confirm provided', async () => {
    // First create a skill that has no dependencies
    kspec('skill add --id standalone-skill --name "Standalone Skill"', tempDir);

    // Verify it exists
    let list = kspecJson<Array<{ id: string }>>('skill list', tempDir);
    expect(list.some(s => s.id === 'standalone-skill')).toBe(true);

    // Delete it
    kspec('skill delete @standalone-skill --confirm', tempDir);

    // Verify it's gone
    list = kspecJson<Array<{ id: string }>>('skill list', tempDir);
    expect(list.some(s => s.id === 'standalone-skill')).toBe(false);
  });

  // AC: @skill-cli ac-8
  it('should delete .kspec/skills/<id>/ directory', async () => {
    // Create a standalone skill
    kspec('skill add --id standalone-skill --name "Standalone Skill"', tempDir);

    // Verify directory exists
    const skillDir = path.join(tempDir, 'skills', 'standalone-skill');
    let exists = await fs.access(skillDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Delete the skill
    kspec('skill delete @standalone-skill --confirm', tempDir);

    // Verify directory is gone
    exists = await fs.access(skillDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('should require --confirm flag', () => {
    const result = kspecFull('skill delete @my-skill', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--confirm');
  });

  it('should prevent deletion when other skills depend on it', () => {
    const result = kspecFull('skill delete @my-skill --confirm', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('referenced by');
    expect(result.stderr).toContain('@dependent-skill');
  });

  it('should return error when skill not found', () => {
    const result = kspecFull('skill delete @nonexistent --confirm', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
  });

  it('should find skill by ULID prefix', async () => {
    // Create a standalone skill and get its ULID
    const createResult = kspecJson<{ _ulid: string; id: string }>(
      'skill add --id temp-skill --name "Temp Skill"',
      tempDir
    );
    // Use a longer prefix to ensure uniqueness (12 chars instead of 8)
    const ulidPrefix = createResult._ulid.slice(0, 12);

    // Delete by ULID prefix
    const output = kspec(`skill delete @${ulidPrefix} --confirm`, tempDir);
    expect(output).toContain('Deleted');

    // Verify it's gone
    const list = kspecJson<Array<{ id: string }>>('skill list', tempDir);
    expect(list.some(s => s.id === 'temp-skill')).toBe(false);
  });
});

describe('Skill CLI - skill set', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a skill to update
    const result = kspecFull(
      'skill add --id my-skill --name "My Skill" --description "Original description" --origin project --skill-version 0.1.0',
      tempDir
    );
    if (result.exitCode !== 0) throw new Error(`skill add failed: ${result.stderr}`);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-set ac-1
  it('should update description field in meta', () => {
    kspec('skill set @my-skill --description "New description"', tempDir);

    const result = kspecJson<{ id: string; description: string }>('skill get @my-skill', tempDir);
    expect(result.description).toBe('New description');
  });

  // AC: @skill-set ac-1 - verify original description replaced
  it('should replace original description completely', async () => {
    kspec('skill set @my-skill --description "Completely new"', tempDir);

    // Also verify in manifest
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    const metaContent = await fs.readFile(metaPath, 'utf-8');
    const meta = yamlParse(metaContent);

    const skill = meta.skills.find((s: { id: string }) => s.id === 'my-skill');
    expect(skill.description).toBe('Completely new');
    expect(skill.description).not.toContain('Original');
  });

  // AC: @skill-set ac-2
  it('should add platform to platforms array', () => {
    kspec('skill set @my-skill --add-platform codex', tempDir);

    const result = kspecJson<{ platforms: string[] }>('skill get @my-skill', tempDir);
    expect(result.platforms).toContain('codex');
    expect(result.platforms).toContain('claude-code'); // Original still there
  });

  // AC: @skill-set ac-2 - multiple platforms
  it('should allow adding multiple platforms sequentially', () => {
    kspec('skill set @my-skill --add-platform codex', tempDir);
    kspec('skill set @my-skill --add-platform cursor', tempDir);

    const result = kspecJson<{ platforms: string[] }>('skill get @my-skill', tempDir);
    expect(result.platforms).toContain('claude-code');
    expect(result.platforms).toContain('codex');
    expect(result.platforms).toContain('cursor');
  });

  // AC: @skill-set ac-2 - no duplicates
  it('should not add duplicate platform', () => {
    // Default platform is claude-code
    kspec('skill set @my-skill --add-platform claude-code', tempDir);

    const result = kspecJson<{ platforms: string[] }>('skill get @my-skill', tempDir);
    const claudeCodeCount = result.platforms.filter(p => p === 'claude-code').length;
    expect(claudeCodeCount).toBe(1);
  });

  // AC: @skill-set ac-3
  it('should add tag to tags array', () => {
    kspec('skill set @my-skill --add-tag automation', tempDir);

    const result = kspecJson<{ tags: string[] }>('skill get @my-skill', tempDir);
    expect(result.tags).toContain('automation');
  });

  // AC: @skill-set ac-3 - multiple tags
  it('should allow adding multiple tags sequentially', () => {
    kspec('skill set @my-skill --add-tag automation', tempDir);
    kspec('skill set @my-skill --add-tag workflow', tempDir);

    const result = kspecJson<{ tags: string[] }>('skill get @my-skill', tempDir);
    expect(result.tags).toContain('automation');
    expect(result.tags).toContain('workflow');
  });

  // AC: @skill-set ac-3 - no duplicates
  it('should not add duplicate tag', () => {
    kspec('skill set @my-skill --add-tag test', tempDir);
    kspec('skill set @my-skill --add-tag test', tempDir);

    const result = kspecJson<{ tags: string[] }>('skill get @my-skill', tempDir);
    const testCount = result.tags.filter(t => t === 'test').length;
    expect(testCount).toBe(1);
  });

  it('should update name field', () => {
    kspec('skill set @my-skill --name "Updated Name"', tempDir);

    const result = kspecJson<{ name: string }>('skill get @my-skill', tempDir);
    expect(result.name).toBe('Updated Name');
  });

  it('should update origin field', () => {
    kspec('skill set @my-skill --origin core', tempDir);

    const result = kspecJson<{ origin: string }>('skill get @my-skill', tempDir);
    expect(result.origin).toBe('core');
  });

  it('should reject invalid origin', () => {
    const result = kspecFull('skill set @my-skill --origin invalid', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid origin');
  });

  it('should update version field', () => {
    kspec('skill set @my-skill --skill-version 0.2.0', tempDir);

    const result = kspecJson<{ version: string }>('skill get @my-skill', tempDir);
    expect(result.version).toBe('0.2.0');
  });

  it('should remove platform from array', () => {
    // Add another platform first
    kspec('skill set @my-skill --add-platform codex', tempDir);

    // Now remove it
    kspec('skill set @my-skill --remove-platform codex', tempDir);

    const result = kspecJson<{ platforms: string[] }>('skill get @my-skill', tempDir);
    expect(result.platforms).not.toContain('codex');
    expect(result.platforms).toContain('claude-code'); // Original still there
  });

  it('should remove tag from array', () => {
    // Add a tag first
    kspec('skill set @my-skill --add-tag workflow', tempDir);

    // Now remove it
    kspec('skill set @my-skill --remove-tag workflow', tempDir);

    const result = kspecJson<{ tags: string[] }>('skill get @my-skill', tempDir);
    expect(result.tags).not.toContain('workflow');
  });

  it('should add dependency reference', () => {
    // Create another skill
    kspec('skill add --id base-skill --name "Base Skill"', tempDir);

    // Add dependency
    kspec('skill set @my-skill --add-depends-on @base-skill', tempDir);

    const result = kspecJson<{ depends_on: string[] }>('skill get @my-skill', tempDir);
    expect(result.depends_on).toContain('@base-skill');
  });

  it('should remove dependency reference', () => {
    // Create another skill
    kspec('skill add --id base-skill --name "Base Skill"', tempDir);

    // Add and then remove dependency
    kspec('skill set @my-skill --add-depends-on @base-skill', tempDir);
    kspec('skill set @my-skill --remove-depends-on @base-skill', tempDir);

    const result = kspecJson<{ depends_on: string[] }>('skill get @my-skill', tempDir);
    expect(result.depends_on).not.toContain('@base-skill');
  });

  it('should find skill by ULID prefix', () => {
    // Get the skill's ULID first
    const list = kspecJson<Array<{ _ulid: string; id: string }>>('skill list', tempDir);
    const skill = list.find(s => s.id === 'my-skill');
    const ulidPrefix = skill?._ulid.slice(0, 8);

    kspec(`skill set @${ulidPrefix} --description "Updated via ULID"`, tempDir);

    const result = kspecJson<{ description: string }>('skill get @my-skill', tempDir);
    expect(result.description).toBe('Updated via ULID');
  });

  it('should return error when skill not found', () => {
    const result = kspecFull('skill set @nonexistent --description "Test"', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
  });

  it('should output updated skill in JSON mode', () => {
    const result = kspecJson<{ id: string; description: string }>(
      'skill set @my-skill --description "JSON test"',
      tempDir
    );

    expect(result.id).toBe('my-skill');
    expect(result.description).toBe('JSON test');
  });
});

describe('Skill CLI - skill set --platform-config', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a test skill
    const result = kspecFull(
      'skill add --id my-skill --name "My Skill" --description "Test skill"',
      tempDir
    );
    if (result.exitCode !== 0) throw new Error(`skill add failed: ${result.stderr}`);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @skill-platform-config-cli ac-1
  it('should set claude_code platform config', async () => {
    kspec('skill set @my-skill --platform-config claude_code.user_invocable=false', tempDir);

    const result = kspecJson<{ platform_config?: { claude_code?: { user_invocable?: boolean } } }>(
      'skill get @my-skill',
      tempDir
    );

    expect(result.platform_config).toBeDefined();
    expect(result.platform_config?.claude_code).toBeDefined();
    expect(result.platform_config?.claude_code?.user_invocable).toBe(false);
  });

  // AC: @skill-platform-config-cli ac-1 - true value
  it('should set claude_code.user_invocable to true', async () => {
    kspec('skill set @my-skill --platform-config claude_code.user_invocable=true', tempDir);

    const result = kspecJson<{ platform_config?: { claude_code?: { user_invocable?: boolean } } }>(
      'skill get @my-skill',
      tempDir
    );

    expect(result.platform_config?.claude_code?.user_invocable).toBe(true);
  });

  // AC: @skill-platform-config-cli ac-2
  it('should set codex platform config', async () => {
    kspec('skill set @my-skill --platform-config codex.allow_implicit_invocation=true', tempDir);

    const result = kspecJson<{ platform_config?: { codex?: { allow_implicit_invocation?: boolean } } }>(
      'skill get @my-skill',
      tempDir
    );

    expect(result.platform_config).toBeDefined();
    expect(result.platform_config?.codex).toBeDefined();
    expect(result.platform_config?.codex?.allow_implicit_invocation).toBe(true);
  });

  // AC: @skill-platform-config-cli ac-1, ac-2 - multiple platform configs
  it('should set multiple platform configs at once', async () => {
    kspec(
      'skill set @my-skill --platform-config claude_code.disable_model_invocation=true --platform-config codex.allow_implicit_invocation=false',
      tempDir
    );

    const result = kspecJson<{
      platform_config?: {
        claude_code?: { disable_model_invocation?: boolean };
        codex?: { allow_implicit_invocation?: boolean };
      };
    }>('skill get @my-skill', tempDir);

    expect(result.platform_config?.claude_code?.disable_model_invocation).toBe(true);
    expect(result.platform_config?.codex?.allow_implicit_invocation).toBe(false);
  });

  // AC: @skill-platform-config-cli ac-1 - string values
  it('should set string platform config values', async () => {
    kspec('skill set @my-skill --platform-config claude_code.context=full', tempDir);

    const result = kspecJson<{ platform_config?: { claude_code?: { context?: string } } }>(
      'skill get @my-skill',
      tempDir
    );

    expect(result.platform_config?.claude_code?.context).toBe('full');
  });

  // AC: @skill-platform-config-cli ac-2 - codex string values
  it('should set codex display_name string value', async () => {
    kspec('skill set @my-skill --platform-config codex.display_name="My Custom Name"', tempDir);

    const result = kspecJson<{ platform_config?: { codex?: { display_name?: string } } }>(
      'skill get @my-skill',
      tempDir
    );

    expect(result.platform_config?.codex?.display_name).toBe('My Custom Name');
  });

  // AC: @skill-platform-config-cli ac-3
  it('should include platform_config in JSON output', async () => {
    kspec('skill set @my-skill --platform-config claude_code.user_invocable=false', tempDir);

    const result = kspecJson<{ platform_config?: object }>('skill get @my-skill', tempDir);

    expect(result.platform_config).toBeDefined();
    expect(typeof result.platform_config).toBe('object');
  });

  // AC: @skill-platform-config-cli ac-4
  it('should show validation error with guidance for invalid key', async () => {
    const result = kspecFull(
      'skill set @my-skill --platform-config claude_code.invalid_key=value',
      tempDir,
      { expectFail: true }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('invalid_key');
    // Should include guidance on valid keys
    expect(result.stderr).toContain('Valid platform config keys');
    expect(result.stderr).toContain('claude_code');
    expect(result.stderr).toContain('user_invocable');
  });

  // AC: @skill-platform-config-cli ac-4 - invalid codex key
  it('should show validation error for invalid codex key', async () => {
    const result = kspecFull(
      'skill set @my-skill --platform-config codex.bad_key=true',
      tempDir,
      { expectFail: true }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('bad_key');
    expect(result.stderr).toContain('Valid platform config keys');
    expect(result.stderr).toContain('codex');
    expect(result.stderr).toContain('allow_implicit_invocation');
  });

  it('should show error for invalid format (missing platform)', async () => {
    const result = kspecFull(
      'skill set @my-skill --platform-config user_invocable=false',
      tempDir,
      { expectFail: true }
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Invalid platform config format');
    expect(result.stderr).toContain('platform.key=value');
  });

  it('should deep merge platform_config without replacing existing keys', async () => {
    // Set first key
    kspec('skill set @my-skill --platform-config claude_code.user_invocable=false', tempDir);

    // Set second key (should not remove first)
    kspec('skill set @my-skill --platform-config claude_code.context=full', tempDir);

    const result = kspecJson<{
      platform_config?: { claude_code?: { user_invocable?: boolean; context?: string } };
    }>('skill get @my-skill', tempDir);

    expect(result.platform_config?.claude_code?.user_invocable).toBe(false);
    expect(result.platform_config?.claude_code?.context).toBe('full');
  });

  it('should preserve existing platform_config when setting new platform', async () => {
    // Set claude_code config
    kspec('skill set @my-skill --platform-config claude_code.user_invocable=false', tempDir);

    // Set codex config (should not remove claude_code)
    kspec('skill set @my-skill --platform-config codex.allow_implicit_invocation=true', tempDir);

    const result = kspecJson<{
      platform_config?: {
        claude_code?: { user_invocable?: boolean };
        codex?: { allow_implicit_invocation?: boolean };
      };
    }>('skill get @my-skill', tempDir);

    expect(result.platform_config?.claude_code?.user_invocable).toBe(false);
    expect(result.platform_config?.codex?.allow_implicit_invocation).toBe(true);
  });
});

describe('Skill CLI - skill import', () => {
  let tempDir: string;
  let externalSkillDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create an external skill directory (simulating .claude/skills/task-work/)
    externalSkillDir = await createTempDir();
    await fs.mkdir(path.join(externalSkillDir, 'task-work'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    await cleanupTempDir(externalSkillDir);
  });

  // AC: @skill-import ac-1
  it('should extract name and description from YAML frontmatter', async () => {
    // Create SKILL.md with frontmatter
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on kspec tasks with proper lifecycle
---

# Task Work

This skill helps you work on tasks.
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    const result = kspecJson<{ id: string; name: string; description: string }>('skill get @task-work', tempDir);
    expect(result.name).toBe('Task Work');
    expect(result.description).toBe('Work on kspec tasks with proper lifecycle');
  });

  // AC: @skill-import ac-2
  it('should copy content to .kspec/skills/<id>/SKILL.md', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    const originalContent = `---
name: Task Work
description: Work on tasks
---

# Task Work

Use this skill when working on tasks.

## Commands

\`\`\`bash
kspec task start @ref
\`\`\`
`;
    await fs.writeFile(skillPath, originalContent);

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify content was copied
    const copiedPath = path.join(tempDir, 'skills', 'task-work', 'SKILL.md');
    const copiedContent = await fs.readFile(copiedPath, 'utf-8');
    expect(copiedContent).toContain('# Task Work');
    expect(copiedContent).toContain('Use this skill when working on tasks');
    expect(copiedContent).toContain('kspec task start @ref');
  });

  // AC: @skill-import ac-3
  it('should copy docs/ subdirectory if present', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---

# Task Work
`);

    // Create docs subdirectory with files
    const docsDir = path.join(externalSkillDir, 'task-work', 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'quickref.md'), '# Quick Reference\n\nShortcuts...');
    await fs.writeFile(path.join(docsDir, 'advanced.md'), '# Advanced Usage\n\nTips...');

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify docs were copied
    const copiedDocsDir = path.join(tempDir, 'skills', 'task-work', 'docs');
    const quickref = await fs.readFile(path.join(copiedDocsDir, 'quickref.md'), 'utf-8');
    const advanced = await fs.readFile(path.join(copiedDocsDir, 'advanced.md'), 'utf-8');
    expect(quickref).toContain('Quick Reference');
    expect(advanced).toContain('Advanced Usage');
  });

  // AC: @skill-import ac-4
  it('should set origin to core when --origin core specified', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---
`);

    kspec(`skill import "${skillPath}" --origin core`, tempDir);

    const result = kspecJson<{ origin: string }>('skill get @task-work', tempDir);
    expect(result.origin).toBe('core');
  });

  // AC: @skill-import ac-5
  it('should use custom ID when --id specified', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---
`);

    kspec(`skill import "${skillPath}" --id custom-task-work`, tempDir);

    const result = kspecJson<{ id: string; name: string }>('skill get @custom-task-work', tempDir);
    expect(result.id).toBe('custom-task-work');
    expect(result.name).toBe('Task Work');
  });

  // AC: @skill-import ac-6
  it('should error when no frontmatter and no --name/--description flags', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `# Task Work

Just some content without frontmatter.
`);

    const result = kspecFull(`skill import "${skillPath}"`, tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Name is required');
  });

  // AC: @skill-import ac-6 - description required
  it('should error when no description in frontmatter and no --description flag', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
---

# Task Work
`);

    const result = kspecFull(`skill import "${skillPath}"`, tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Description is required');
  });

  // AC: @skill-import ac-6 - allow override with flags
  it('should allow --name and --description flags to override missing frontmatter', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `# Task Work

Just content without frontmatter.
`);

    kspec(`skill import "${skillPath}" --name "Task Work" --description "Work on tasks"`, tempDir);

    const result = kspecJson<{ name: string; description: string }>('skill get @task-work', tempDir);
    expect(result.name).toBe('Task Work');
    expect(result.description).toBe('Work on tasks');
  });

  // AC: @skill-import ac-7
  it('should strip base-directory lines from imported content', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---

Base directory for this skill: /home/user/project/.claude/skills/task-work

# Task Work

Use this skill when working on tasks.
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify base-directory line was stripped
    const copiedPath = path.join(tempDir, 'skills', 'task-work', 'SKILL.md');
    const copiedContent = await fs.readFile(copiedPath, 'utf-8');
    expect(copiedContent).not.toContain('Base directory for this skill:');
    expect(copiedContent).toContain('# Task Work');
    expect(copiedContent).toContain('Use this skill when working on tasks');
  });

  it('should derive ID from directory name by default', async () => {
    // Create a skill in a directory with a specific name
    await fs.mkdir(path.join(externalSkillDir, 'pr-review'), { recursive: true });
    const skillPath = path.join(externalSkillDir, 'pr-review', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: PR Review
description: Review pull requests
---
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    // ID should be derived from directory name
    const result = kspecJson<{ id: string }>('skill get @pr-review', tempDir);
    expect(result.id).toBe('pr-review');
  });

  it('should error when skill with same ID already exists', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---
`);

    // First import succeeds
    kspec(`skill import "${skillPath}"`, tempDir);

    // Second import should fail
    const result = kspecFull(`skill import "${skillPath}"`, tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('already exists');
    expect(result.stderr).toContain('--id');
  });

  it('should error when file does not exist', () => {
    const result = kspecFull('skill import /nonexistent/path/SKILL.md', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('File not found');
  });

  it('should set default origin to project', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    const result = kspecJson<{ origin: string }>('skill get @task-work', tempDir);
    expect(result.origin).toBe('project');
  });

  it('should set version when --skill-version provided', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---
`);

    kspec(`skill import "${skillPath}" --skill-version 1.0.0`, tempDir);

    const result = kspecJson<{ version: string }>('skill get @task-work', tempDir);
    expect(result.version).toBe('1.0.0');
  });

  it('should output imported skill in JSON mode', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---
`);

    const result = kspecJson<{ id: string; name: string; origin: string }>(
      `skill import "${skillPath}"`,
      tempDir
    );

    expect(result.id).toBe('task-work');
    expect(result.name).toBe('Task Work');
    expect(result.origin).toBe('project');
  });

  it('should handle nested docs directory', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---
`);

    // Create nested docs structure
    const docsDir = path.join(externalSkillDir, 'task-work', 'docs');
    await fs.mkdir(path.join(docsDir, 'examples'), { recursive: true });
    await fs.writeFile(path.join(docsDir, 'examples', 'usage.md'), '# Example Usage');

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify nested structure was copied
    const copiedPath = path.join(tempDir, 'skills', 'task-work', 'docs', 'examples', 'usage.md');
    const content = await fs.readFile(copiedPath, 'utf-8');
    expect(content).toContain('Example Usage');
  });

  // AC: @import-frontmatter-strip ac-1 - all Agent Skills frontmatter fields populate meta.yaml
  it('should populate license, compatibility, allowed_tools from frontmatter', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
license: MIT
compatibility: ">=1.0.0"
allowed_tools:
  - Bash
  - Read
  - Write
---

# Task Work
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    const result = kspecJson<{
      license: string;
      compatibility: string;
      allowed_tools: string[];
    }>('skill get @task-work', tempDir);
    expect(result.license).toBe('MIT');
    expect(result.compatibility).toBe('>=1.0.0');
    expect(result.allowed_tools).toEqual(['Bash', 'Read', 'Write']);
  });

  // AC: @import-frontmatter-strip ac-2 - stored content has NO frontmatter (body-only)
  it('should store body-only content without frontmatter', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
license: MIT
user-invocable: true
---

# Task Work

This is the body content.
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify stored content has no frontmatter
    const copiedPath = path.join(tempDir, 'skills', 'task-work', 'SKILL.md');
    const copiedContent = await fs.readFile(copiedPath, 'utf-8');
    expect(copiedContent).not.toContain('---');
    expect(copiedContent).not.toContain('name: Task Work');
    expect(copiedContent).not.toContain('license: MIT');
    expect(copiedContent).toContain('# Task Work');
    expect(copiedContent).toContain('This is the body content.');
  });

  // AC: @import-frontmatter-strip ac-3 - Claude Code platform frontmatter populates platform_config.claude_code
  it('should populate platform_config.claude_code from Claude Code frontmatter fields', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
user-invocable: true
context: task
agent: task-worker
model: haiku
argument-hint: "@task-ref"
---

# Task Work
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    const result = kspecJson<{
      platform_config: {
        claude_code: {
          user_invocable: boolean;
          context: string;
          agent: string;
          model: string;
          argument_hint: string;
        };
      };
    }>('skill get @task-work', tempDir);

    expect(result.platform_config).toBeDefined();
    expect(result.platform_config.claude_code).toBeDefined();
    expect(result.platform_config.claude_code.user_invocable).toBe(true);
    expect(result.platform_config.claude_code.context).toBe('task');
    expect(result.platform_config.claude_code.agent).toBe('task-worker');
    expect(result.platform_config.claude_code.model).toBe('haiku');
    expect(result.platform_config.claude_code.argument_hint).toBe('@task-ref');
  });

  // AC: @import-frontmatter-strip ac-3 - underscore naming also works
  it('should handle underscore naming for Claude Code fields', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
user_invocable: false
disable_model_invocation: true
argument_hint: "--flag"
---

# Task Work
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    const result = kspecJson<{
      platform_config: {
        claude_code: {
          user_invocable: boolean;
          disable_model_invocation: boolean;
          argument_hint: string;
        };
      };
    }>('skill get @task-work', tempDir);

    expect(result.platform_config.claude_code.user_invocable).toBe(false);
    expect(result.platform_config.claude_code.disable_model_invocation).toBe(true);
    expect(result.platform_config.claude_code.argument_hint).toBe('--flag');
  });

  // AC: @import-frontmatter-strip ac-4 - references/ and scripts/ subdirectories copied
  it('should copy references/ and scripts/ subdirectories', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---

# Task Work
`);

    // Create references/ and scripts/ directories
    const referencesDir = path.join(externalSkillDir, 'task-work', 'references');
    const scriptsDir = path.join(externalSkillDir, 'task-work', 'scripts');
    await fs.mkdir(referencesDir, { recursive: true });
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(path.join(referencesDir, 'api.md'), '# API Reference');
    await fs.writeFile(path.join(scriptsDir, 'setup.sh'), '#!/bin/bash\necho "setup"');

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify both directories were copied
    const copiedReferencesPath = path.join(tempDir, 'skills', 'task-work', 'references', 'api.md');
    const copiedScriptsPath = path.join(tempDir, 'skills', 'task-work', 'scripts', 'setup.sh');
    const referencesContent = await fs.readFile(copiedReferencesPath, 'utf-8');
    const scriptsContent = await fs.readFile(copiedScriptsPath, 'utf-8');
    expect(referencesContent).toContain('API Reference');
    expect(scriptsContent).toContain('echo "setup"');
  });

  // AC: @import-frontmatter-strip ac-4 - assets/ subdirectory copied
  it('should copy assets/ subdirectory', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---

# Task Work
`);

    // Create assets/ directory
    const assetsDir = path.join(externalSkillDir, 'task-work', 'assets');
    await fs.mkdir(assetsDir, { recursive: true });
    await fs.writeFile(path.join(assetsDir, 'config.json'), '{"key": "value"}');

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify assets directory was copied
    const copiedAssetsPath = path.join(tempDir, 'skills', 'task-work', 'assets', 'config.json');
    const assetsContent = await fs.readFile(copiedAssetsPath, 'utf-8');
    expect(assetsContent).toContain('"key": "value"');
  });

  // AC: @import-frontmatter-strip ac-5 - docs/ copied for backward compatibility
  // (already tested in ac-3 of @skill-import, but confirm it still works with new code)
  it('should still copy docs/ subdirectory for backward compatibility', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Task Work
description: Work on tasks
---

# Task Work
`);

    // Create docs/ directory (legacy convention)
    const docsDir = path.join(externalSkillDir, 'task-work', 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'guide.md'), '# User Guide');

    kspec(`skill import "${skillPath}"`, tempDir);

    // Verify docs directory was copied
    const copiedDocsPath = path.join(tempDir, 'skills', 'task-work', 'docs', 'guide.md');
    const docsContent = await fs.readFile(copiedDocsPath, 'utf-8');
    expect(docsContent).toContain('User Guide');
  });

  // AC: @import-frontmatter-strip ac-6 - import succeeds with CLI flags when no frontmatter
  it('should import successfully with --name and --description flags when no frontmatter', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `# Task Work

This skill has no frontmatter at all.

## Usage

Use it like this.
`);

    kspec(`skill import "${skillPath}" --name "Task Work" --description "Work on tasks"`, tempDir);

    const result = kspecJson<{ name: string; description: string; id: string }>('skill get @task-work', tempDir);
    expect(result.name).toBe('Task Work');
    expect(result.description).toBe('Work on tasks');
    expect(result.id).toBe('task-work');

    // Verify content was stored as-is (no frontmatter to strip)
    const copiedPath = path.join(tempDir, 'skills', 'task-work', 'SKILL.md');
    const copiedContent = await fs.readFile(copiedPath, 'utf-8');
    expect(copiedContent).toContain('# Task Work');
    expect(copiedContent).toContain('This skill has no frontmatter at all.');
  });

  // AC: @import-frontmatter-strip ac-1, ac-3 - comprehensive test with all fields
  it('should handle all frontmatter fields together', async () => {
    const skillPath = path.join(externalSkillDir, 'task-work', 'SKILL.md');
    await fs.writeFile(skillPath, `---
name: Complete Skill
description: A skill with all frontmatter fields
license: Apache-2.0
compatibility: ">=0.5.0"
allowed_tools:
  - Bash
  - Read
user-invocable: true
context: general
model: sonnet
---

# Complete Skill

This has every field.
`);

    kspec(`skill import "${skillPath}"`, tempDir);

    const result = kspecJson<{
      name: string;
      description: string;
      license: string;
      compatibility: string;
      allowed_tools: string[];
      platform_config: {
        claude_code: {
          user_invocable: boolean;
          context: string;
          model: string;
        };
      };
    }>('skill get @task-work', tempDir);

    // Core metadata
    expect(result.name).toBe('Complete Skill');
    expect(result.description).toBe('A skill with all frontmatter fields');

    // Portable Agent Skills fields
    expect(result.license).toBe('Apache-2.0');
    expect(result.compatibility).toBe('>=0.5.0');
    expect(result.allowed_tools).toEqual(['Bash', 'Read']);

    // Platform config
    expect(result.platform_config.claude_code.user_invocable).toBe(true);
    expect(result.platform_config.claude_code.context).toBe('general');
    expect(result.platform_config.claude_code.model).toBe('sonnet');

    // Stored content has no frontmatter
    const copiedPath = path.join(tempDir, 'skills', 'task-work', 'SKILL.md');
    const copiedContent = await fs.readFile(copiedPath, 'utf-8');
    expect(copiedContent).not.toContain('---');
    expect(copiedContent).toContain('# Complete Skill');
  });
});
