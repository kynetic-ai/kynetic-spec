/**
 * E2E tests for trait CLI commands
 * AC: @trait-cli ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('Trait CLI - trait add', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-cli ac-1
  it('should create trait-type item with title', () => {
    const result = kspecJson<{ trait: { _ulid: string; title: string; type: string } }>(
      'trait add "Test Trait"',
      tempDir
    );

    expect(result.trait).toBeDefined();
    expect(result.trait.title).toBe('Test Trait');
    expect(result.trait.type).toBe('trait');
    expect(result.trait._ulid).toMatch(/^[0-9A-Z]{26}$/);
  });

  // AC: @trait-cli ac-2
  it('should set description field when --description provided', () => {
    const result = kspecJson<{ trait: { title: string; description: string } }>(
      'trait add "Test Trait" --description "This is a test trait"',
      tempDir
    );

    expect(result.trait.description).toBe('This is a test trait');
    expect(result.trait.title).toBe('Test Trait');
  });

  it('should allow custom slug', () => {
    const result = kspecJson<{ trait: { slugs: string[] } }>(
      'trait add "Test Trait" --slug test-trait-custom',
      tempDir
    );

    expect(result.trait.slugs).toContain('test-trait-custom');
  });

  it('should add trait to kynetic.yaml traits array', async () => {
    kspec('trait add "Test Trait"', tempDir);

    const manifest = await fs.readFile(
      path.join(tempDir, 'kynetic.yaml'),
      'utf-8'
    );

    expect(manifest).toContain('traits:');
    expect(manifest).toContain('title: Test Trait');
    expect(manifest).toContain('type: trait');
  });
});

describe('Trait CLI - trait list', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create some traits
    kspec('trait add "Trait One" --slug trait-one', tempDir);
    kspec('trait add "Trait Two" --description "Second trait"', tempDir);
    kspec('trait add "Trait Three" --slug trait-three', tempDir);

    // Add AC to Trait One using CLI
    kspec(
      'item ac add @trait-one --given "condition" --when "action" --then "result"',
      tempDir
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-cli ac-3
  it('should list all traits with AC counts', () => {
    const output = kspec('trait list', tempDir);

    expect(output).toContain('Trait One');
    expect(output).toContain('Trait Two');
    expect(output).toContain('Trait Three');

    // Should show AC count
    expect(output).toMatch(/Trait One.*\(1 AC\)/);
    expect(output).toMatch(/Trait Two.*\(no AC\)/);
    expect(output).toMatch(/Trait Three.*\(no AC\)/);

    expect(output).toContain('3 trait(s)');
  });

  it('should include trait refs in list output', () => {
    const output = kspec('trait list', tempDir);

    // Should show slug for trait-three
    expect(output).toContain('@trait-three');
  });

  it('should return traits array in JSON mode', () => {
    const result = kspecJson<{ traits: Array<{ title: string; acceptanceCriteria: unknown[] }> }>(
      'trait list',
      tempDir
    );

    expect(result.traits).toHaveLength(3);
    expect(result.traits[0].title).toBe('Trait One');
    expect(result.traits[0].acceptanceCriteria).toHaveLength(1);
    expect(result.traits[1].acceptanceCriteria).toHaveLength(0);
  });
});

describe('Trait CLI - trait get', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a trait with AC
    kspec('trait add "JSON Output Support" --slug json-output --description "Trait for JSON support"', tempDir);

    // Add ACs using CLI
    kspec(
      'item ac add @json-output --given "command with --json flag" --when "executed" --then "outputs valid JSON"',
      tempDir
    );
    kspec(
      'item ac add @json-output --given "JSON output" --when "parsed" --then "contains required fields"',
      tempDir
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-cli ac-4
  it('should show trait details and acceptance criteria', () => {
    const output = kspec('trait get @json-output', tempDir);

    expect(output).toContain('JSON Output Support');
    expect(output).toContain('Type:      trait');
    expect(output).toContain('Slug:      @json-output');
    expect(output).toContain('Trait for JSON support');

    // AC: @trait-cli ac-4 - show acceptance criteria
    expect(output).toContain('Acceptance Criteria');
    expect(output).toContain('[ac-1]');
    expect(output).toContain('Given: command with --json flag');
    expect(output).toContain('When: executed');
    expect(output).toContain('Then: outputs valid JSON');

    expect(output).toContain('[ac-2]');
    expect(output).toContain('Given: JSON output');
  });

  it('should show usage count when trait is used', async () => {
    // Create a spec that uses the trait
    await fs.mkdir(path.join(tempDir, 'modules'), { recursive: true });
    const specModule = `_ulid: 01KFCVXQAABBCCDDEEFFGGHHXX
slugs:
  - test-spec
title: Test Spec
type: module
traits:
  - "@json-output"
`;
    await fs.writeFile(
      path.join(tempDir, 'modules/test.yaml'),
      specModule
    );

    const manifest = await fs.readFile(
      path.join(tempDir, 'kynetic.yaml'),
      'utf-8'
    );
    const updatedManifest = manifest.replace(
      'includes:\n  - modules/core.yaml',
      'includes:\n  - modules/core.yaml\n  - modules/test.yaml'
    );
    await fs.writeFile(
      path.join(tempDir, 'kynetic.yaml'),
      updatedManifest
    );

    const output = kspec('trait get @json-output', tempDir);

    expect(output).toContain('Used by 1 spec(s)');
  });

  it('should return full trait data in JSON mode', () => {
    const result = kspecJson<{
      trait: {
        ulid: string;
        slug: string;
        title: string;
        description: string;
        acceptanceCriteria: Array<{ id: string; given: string; when: string; then: string }>;
      };
    }>('trait get @json-output', tempDir);

    expect(result.trait.title).toBe('JSON Output Support');
    expect(result.trait.slug).toBe('json-output');
    expect(result.trait.description).toBe('Trait for JSON support');
    expect(result.trait.acceptanceCriteria).toHaveLength(2);
    expect(result.trait.acceptanceCriteria[0].id).toBe('ac-1');
  });
});

describe('Trait CLI - item trait add', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create a trait
    kspec('trait add "JSON Output Support" --slug json-output', tempDir);

    // Create a spec item in a module file
    await fs.mkdir(path.join(tempDir, 'modules'), { recursive: true });
    const specModule = `_ulid: 01KFCVXQ00MODULE00000000000
slugs:
  - test-module
title: Test Module
type: module
status:
  maturity: draft
  implementation: not_started

features:
  - _ulid: 01KFCVXQAABBCCDDEEFFGGHHXX
    slugs:
      - test-trait-feature
    title: Test Trait Feature
    type: feature
    status:
      maturity: draft
      implementation: not_started
`;
    await fs.writeFile(
      path.join(tempDir, 'modules/test.yaml'),
      specModule
    );

    const manifest = await fs.readFile(
      path.join(tempDir, 'kynetic.yaml'),
      'utf-8'
    );
    const updatedManifest = manifest.replace(
      'includes:\n  - modules/core.yaml',
      'includes:\n  - modules/core.yaml\n  - modules/test.yaml'
    );
    await fs.writeFile(
      path.join(tempDir, 'kynetic.yaml'),
      updatedManifest
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-cli ac-5
  it('should add trait to spec traits array', () => {
    const result = kspecJson<{ added: boolean; spec: string; trait: string }>(
      'item trait add @test-trait-feature @json-output',
      tempDir
    );

    expect(result.added).toBe(true);
    expect(result.spec).toContain('test-trait-feature');
    expect(result.trait).toBe('@json-output');
  });

  it('should persist trait in spec file', async () => {
    kspec('item trait add @test-trait-feature @json-output', tempDir);

    const specFile = await fs.readFile(
      path.join(tempDir, 'modules/test.yaml'),
      'utf-8'
    );

    expect(specFile).toContain('traits:');
    expect(specFile).toContain('- "@json-output"');
  });

  // AC: @trait-cli ac-6
  it('should be idempotent - no duplicate when trait already added', async () => {
    // Add trait once
    kspec('item trait add @test-trait-feature @json-output', tempDir);

    // Add again - should be idempotent
    const result = kspecJson<{ added: boolean }>(
      'item trait add @test-trait-feature @json-output',
      tempDir
    );

    expect(result.added).toBe(false);

    // Verify only one entry in file
    const specFile = await fs.readFile(
      path.join(tempDir, 'modules/test.yaml'),
      'utf-8'
    );

    const traitMatches = specFile.match(/@json-output/g);
    expect(traitMatches).toHaveLength(1);
  });

  // AC: @trait-cli ac-7
  it('should error when trait does not exist', () => {
    expect(() => {
      kspec('item trait add @test-trait-feature @nonexistent-trait', tempDir);
    }).toThrow();
  });

  it('should error when spec ref is invalid', () => {
    expect(() => {
      kspec('item trait add @nonexistent-spec @json-output', tempDir);
    }).toThrow();
  });

  it('should error when adding trait to task', async () => {
    // Create a task
    const tasksFile = `_version: "0.1"
_updated_at: "2026-01-20T00:00:00Z"

tasks:
  - _ulid: 01KFCVXQDD1122334455667788
    slugs:
      - test-task
    title: Test Task
    type: task
    status: pending
    priority: 2
    spec_ref: "@test-trait-feature"
    tags: []
    depends_on: []
    blocked_by: []
    notes: []
    todos: []
    created_at: "2026-01-20T00:00:00Z"
`;

    await fs.writeFile(
      path.join(tempDir, 'project.tasks.yaml'),
      tasksFile
    );

    expect(() => {
      kspec('item trait add @test-task @json-output', tempDir);
    }).toThrow(/task/i);
  });
});

describe('Trait CLI - item trait remove', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create traits
    kspec('trait add "Trait One" --slug trait-one', tempDir);
    kspec('trait add "Trait Two" --slug trait-two', tempDir);
    kspec('trait add "JSON Output" --slug json-output', tempDir);

    // Create a spec with both traits in a module file
    await fs.mkdir(path.join(tempDir, 'modules'), { recursive: true });
    const specModule = `_ulid: 01KFCVXQ00MODULE00000000000
slugs:
  - test-module
title: Test Module
type: module
status:
  maturity: draft
  implementation: not_started

features:
  - _ulid: 01KFCVXQAABBCCDDEEFFGGHHXX
    slugs:
      - test-trait-feature
    title: Test Trait Feature
    type: feature
    status:
      maturity: draft
      implementation: not_started
    traits:
      - "@trait-one"
      - "@trait-two"
`;
    await fs.writeFile(
      path.join(tempDir, 'modules/test.yaml'),
      specModule
    );

    const manifest = await fs.readFile(
      path.join(tempDir, 'kynetic.yaml'),
      'utf-8'
    );
    const updatedManifest = manifest.replace(
      'includes:\n  - modules/core.yaml',
      'includes:\n  - modules/core.yaml\n  - modules/test.yaml'
    );
    await fs.writeFile(
      path.join(tempDir, 'kynetic.yaml'),
      updatedManifest
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @trait-cli ac-8
  it('should remove trait from traits array', () => {
    const result = kspecJson<{ removed: boolean; spec: string; trait: string }>(
      'item trait remove @test-trait-feature @trait-one',
      tempDir
    );

    expect(result.removed).toBe(true);
    expect(result.spec).toContain('test-trait-feature');
    expect(result.trait).toBe('@trait-one');
  });

  it('should persist removal in spec file', async () => {
    kspec('item trait remove @test-trait-feature @trait-one', tempDir);

    const specFile = await fs.readFile(
      path.join(tempDir, 'modules/test.yaml'),
      'utf-8'
    );

    expect(specFile).not.toContain('@trait-one');
    expect(specFile).toContain('@trait-two'); // Should still have the other trait
  });

  it('should warn when trait not in spec traits array', () => {
    const result = kspecJson<{ removed: boolean }>(
      'item trait remove @test-trait-feature @json-output',
      tempDir
    );

    expect(result.removed).toBe(false);
  });

  it('should allow removing all traits', async () => {
    kspec('item trait remove @test-trait-feature @trait-one', tempDir);
    kspec('item trait remove @test-trait-feature @trait-two', tempDir);

    const specFile = await fs.readFile(
      path.join(tempDir, 'modules/test.yaml'),
      'utf-8'
    );

    // Traits array should be empty
    expect(specFile).toMatch(/traits:\s*\[\]/);
  });

  it('should error when trait ref is invalid', () => {
    expect(() => {
      kspec('item trait remove @test-trait-feature @nonexistent', tempDir);
    }).toThrow();
  });
});
