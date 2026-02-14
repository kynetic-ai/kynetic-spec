/**
 * Tests for kspec refs (unified cross-reference lookup)
 * AC: @unified-cross-reference-lookup
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  testUlid,
} from './helpers/cli';

describe('kspec refs', () => {
  let tempDir: string;

  // Test ULIDs - using valid Crockford base32
  const specAUlid = testUlid('SPCA', 1);
  const specBUlid = testUlid('SPCB', 1);
  const specCUlid = testUlid('SPCC', 1);
  const specDUlid = testUlid('SPCD', 1);
  const specEUlid = testUlid('SPCE', 1);
  const oldSpecUlid = testUlid('0KDS', 1);
  const isolatedUlid = testUlid('JS0K', 1);
  const traitUlid = testUlid('TRAT', 1);
  const specXUlid = testUlid('SPCX', 1);
  const specYUlid = testUlid('SPCY', 1);
  const specZUlid = testUlid('SPCZ', 1);
  const workflowUlid = testUlid('WRKF', 1);
  const taskWithMetaUlid = testUlid('TMRF', 1);

  beforeAll(async () => {
    tempDir = await setupTempFixtures();

    // Add additional fixtures needed for refs tests

    // Spec A - will be referenced by others
    const specA = `_ulid: ${specAUlid}
slugs:
  - spec-a
title: Spec A (Target)
type: feature
status:
  maturity: draft
  implementation: not_started
`;

    // Spec B - depends_on spec-a
    const specB = `_ulid: ${specBUlid}
slugs:
  - spec-b
title: Spec B (depends on A)
type: feature
status:
  maturity: draft
  implementation: not_started
depends_on:
  - "@spec-a"
`;

    // Spec C - implements spec-a
    const specC = `_ulid: ${specCUlid}
slugs:
  - spec-c
title: Spec C (implements A)
type: feature
status:
  maturity: draft
  implementation: not_started
implements:
  - "@spec-a"
`;

    // Spec D - relates_to spec-a
    const specD = `_ulid: ${specDUlid}
slugs:
  - spec-d
title: Spec D (relates to A)
type: feature
status:
  maturity: draft
  implementation: not_started
relates_to:
  - "@spec-a"
`;

    // Old spec - will be superseded
    const oldSpec = `_ulid: ${oldSpecUlid}
slugs:
  - old-spec
title: Old Spec (deprecated)
type: feature
status:
  maturity: deprecated
  implementation: not_started
`;

    // Spec E - supersedes old-spec (supersedes is a single ref, not array)
    const specE = `_ulid: ${specEUlid}
slugs:
  - spec-e
title: Spec E (supersedes old)
type: feature
status:
  maturity: draft
  implementation: not_started
supersedes: "@old-spec"
`;

    // Isolated item with no references to it
    const isolatedSpec = `_ulid: ${isolatedUlid}
slugs:
  - isolated-item
title: Isolated Item
type: feature
status:
  maturity: draft
  implementation: not_started
`;

    // Trait for trait references
    const trait = `_ulid: ${traitUlid}
slugs:
  - my-trait
title: My Trait
type: trait
status:
  maturity: draft
  implementation: not_started
`;

    // Specs that use the trait (X, Y, Z)
    const specsWithTrait = `_ulid: ${specXUlid}
slugs:
  - spec-x
title: Spec X (uses trait)
type: feature
status:
  maturity: draft
  implementation: not_started
traits:
  - "@my-trait"
---
_ulid: ${specYUlid}
slugs:
  - spec-y
title: Spec Y (uses trait)
type: feature
status:
  maturity: draft
  implementation: not_started
traits:
  - "@my-trait"
---
_ulid: ${specZUlid}
slugs:
  - spec-z
title: Spec Z (uses trait)
type: feature
status:
  maturity: draft
  implementation: not_started
traits:
  - "@my-trait"
`;

    const modulesDir = path.join(tempDir, 'modules');
    await fs.writeFile(path.join(modulesDir, 'spec-a.yaml'), specA);
    await fs.writeFile(path.join(modulesDir, 'spec-b.yaml'), specB);
    await fs.writeFile(path.join(modulesDir, 'spec-c.yaml'), specC);
    await fs.writeFile(path.join(modulesDir, 'spec-d.yaml'), specD);
    await fs.writeFile(path.join(modulesDir, 'old-spec.yaml'), oldSpec);
    await fs.writeFile(path.join(modulesDir, 'spec-e.yaml'), specE);
    await fs.writeFile(path.join(modulesDir, 'isolated.yaml'), isolatedSpec);
    await fs.writeFile(path.join(modulesDir, 'trait.yaml'), trait);
    await fs.writeFile(path.join(modulesDir, 'trait-users.yaml'), specsWithTrait);

    // Update manifest to include the new modules
    const manifest = `kynetic: "1.0"

project:
  name: "Test Project"
  version: "0.1.0"
  status: draft
  description: A minimal test project for integration testing

includes:
  - modules/*.yaml

tasks_file: project.tasks.yaml
meta_file: kynetic.meta.yaml
`;
    await fs.writeFile(path.join(tempDir, 'kynetic.yaml'), manifest);

    // Add tasks that reference specs
    // Read existing tasks and add spec_ref to them
    const existingTasks = await fs.readFile(path.join(tempDir, 'project.tasks.yaml'), 'utf-8');
    const updatedTasks = existingTasks.replace(
      'spec_ref: "@test-core"',
      'spec_ref: "@test-core"'
    );

    // Add new tasks with spec_ref pointing to test-core
    const additionalTasks = `
  - _ulid: ${testUlid('TSK1', 1)}
    slugs:
      - task-for-core-1
    title: Task 1 (for test-core)
    type: task
    status: pending
    priority: 2
    spec_ref: "@test-core"
    depends_on: []
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"

  - _ulid: ${testUlid('TSK2', 1)}
    slugs:
      - task-for-core-2
    title: Task 2 (for test-core)
    type: task
    status: pending
    priority: 2
    spec_ref: "@test-core"
    depends_on: []
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"

  - _ulid: ${testUlid('TSK3', 1)}
    slugs:
      - task-with-dep
    title: Task 3 (depends on task-1)
    type: task
    status: pending
    priority: 2
    depends_on:
      - "@task-for-core-1"
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"

  - _ulid: ${taskWithMetaUlid}
    slugs:
      - task-with-meta-ref
    title: Task with meta_ref
    type: task
    status: pending
    priority: 2
    meta_ref: "@workflow-1"
    depends_on: []
    notes: []
    todos: []
    created_at: "2026-01-01T00:00:00Z"
`;

    // Append to tasks file
    const newTasksContent = updatedTasks.trim() + '\n' + additionalTasks;
    await fs.writeFile(path.join(tempDir, 'project.tasks.yaml'), newTasksContent);

    // Update meta manifest to include workflow
    const metaManifest = `kynetic_meta: "1.0"

agents:
  - _ulid: 01KF1645CB01TASKAGENT00001
    id: test-agent
    name: Test Agent
    role: developer
    capabilities:
      - code
    conventions:
      - "@testing-conventions"

workflows:
  - _ulid: ${workflowUlid}
    id: workflow-1
    trigger: Before doing task work
    description: A test workflow
    steps:
      - type: action
        content: Do the first thing

conventions:
  - _ulid: 01KF1645CB01CONVENTION0001
    domain: testing-conventions
    rules:
      - Write tests for all features

observations: []
`;
    await fs.writeFile(path.join(tempDir, 'kynetic.meta.yaml'), metaManifest);
  });

  afterAll(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @unified-cross-reference-lookup ac-task-spec-ref
  it('should show tasks with spec_ref pointing to target', async () => {
    const result = kspecJson<{ tasks_spec_ref?: { ref: string; title: string }[]; total: number }>(
      'refs @test-core',
      tempDir
    );

    expect(result.tasks_spec_ref).toBeDefined();
    expect(result.tasks_spec_ref!.length).toBeGreaterThanOrEqual(2);
    const titles = result.tasks_spec_ref!.map(r => r.title);
    expect(titles).toContain('Task 1 (for test-core)');
    expect(titles).toContain('Task 2 (for test-core)');
  });

  // AC: @unified-cross-reference-lookup ac-task-depends-on
  it('should show tasks with depends_on including target', async () => {
    const result = kspecJson<{ tasks_depends_on?: { ref: string; title: string }[]; total: number }>(
      'refs @task-for-core-1',
      tempDir
    );

    expect(result.tasks_depends_on).toBeDefined();
    expect(result.tasks_depends_on).toHaveLength(1);
    expect(result.tasks_depends_on![0].title).toBe('Task 3 (depends on task-1)');
  });

  // AC: @unified-cross-reference-lookup ac-spec-depends-on
  it('should show specs with depends_on including target', async () => {
    const result = kspecJson<{ specs_depends_on?: { ref: string; title: string }[]; total: number }>(
      'refs @spec-a',
      tempDir
    );

    expect(result.specs_depends_on).toBeDefined();
    expect(result.specs_depends_on).toHaveLength(1);
    expect(result.specs_depends_on![0].title).toBe('Spec B (depends on A)');
  });

  // AC: @unified-cross-reference-lookup ac-spec-implements
  it('should show specs with implements including target', async () => {
    const result = kspecJson<{ specs_implements?: { ref: string; title: string }[]; total: number }>(
      'refs @spec-a',
      tempDir
    );

    expect(result.specs_implements).toBeDefined();
    expect(result.specs_implements).toHaveLength(1);
    expect(result.specs_implements![0].title).toBe('Spec C (implements A)');
  });

  // AC: @unified-cross-reference-lookup ac-spec-relates-to
  it('should show specs with relates_to including target', async () => {
    const result = kspecJson<{ specs_relates_to?: { ref: string; title: string }[]; total: number }>(
      'refs @spec-a',
      tempDir
    );

    expect(result.specs_relates_to).toBeDefined();
    expect(result.specs_relates_to).toHaveLength(1);
    expect(result.specs_relates_to![0].title).toBe('Spec D (relates to A)');
  });

  // AC: @unified-cross-reference-lookup ac-trait-references
  it('should show specs with traits including target', async () => {
    const result = kspecJson<{ specs_traits?: { ref: string; title: string }[]; total: number }>(
      'refs @my-trait',
      tempDir
    );

    expect(result.specs_traits).toBeDefined();
    expect(result.specs_traits).toHaveLength(3);
    const titles = result.specs_traits!.map(r => r.title);
    expect(titles).toContain('Spec X (uses trait)');
    expect(titles).toContain('Spec Y (uses trait)');
    expect(titles).toContain('Spec Z (uses trait)');
  });

  // AC: @unified-cross-reference-lookup ac-meta-ref
  it('should show tasks with meta_ref pointing to target', async () => {
    const result = kspecJson<{ tasks_meta_ref?: { ref: string; title: string }[]; total: number }>(
      'refs @workflow-1',
      tempDir
    );

    expect(result.tasks_meta_ref).toBeDefined();
    expect(result.tasks_meta_ref).toHaveLength(1);
    expect(result.tasks_meta_ref![0].title).toBe('Task with meta_ref');
  });

  // AC: @unified-cross-reference-lookup ac-supersedes
  it('should show specs with supersedes including target', async () => {
    const result = kspecJson<{ specs_supersedes?: { ref: string; title: string }[]; total: number }>(
      'refs @old-spec',
      tempDir
    );

    expect(result.specs_supersedes).toBeDefined();
    expect(result.specs_supersedes).toHaveLength(1);
    expect(result.specs_supersedes![0].title).toBe('Spec E (supersedes old)');
  });

  // AC: @unified-cross-reference-lookup ac-grouped-output
  it('should group output by relationship type with clear section headers', async () => {
    // Use human-readable output (no --json)
    const result = kspec('refs @spec-a', tempDir);

    // Should have section headers (field names have underscores replaced with spaces)
    expect(result.stdout).toContain('Specs (depends on)');
    expect(result.stdout).toContain('Specs (implements)');
    expect(result.stdout).toContain('Specs (relates to)');

    // Should include the items
    expect(result.stdout).toContain('Spec B');
    expect(result.stdout).toContain('Spec C');
    expect(result.stdout).toContain('Spec D');
  });

  // AC: @unified-cross-reference-lookup ac-json-structured
  it('should return JSON object with keys per reference type', async () => {
    const result = kspecJson<Record<string, unknown>>(
      'refs @spec-a',
      tempDir
    );

    // Should have structured keys
    expect(result).toHaveProperty('target');
    expect(result).toHaveProperty('target_ulid');
    expect(result).toHaveProperty('total');

    // Each array should have proper structure
    if (result.specs_depends_on) {
      const deps = result.specs_depends_on as { ref: string; ulid: string; title: string; type: string }[];
      expect(deps[0]).toHaveProperty('ref');
      expect(deps[0]).toHaveProperty('ulid');
      expect(deps[0]).toHaveProperty('title');
      expect(deps[0]).toHaveProperty('type');
    }
  });

  // AC: @unified-cross-reference-lookup ac-no-refs
  it('should show "No references found" message for isolated items', async () => {
    const result = kspec('refs @isolated-item', tempDir);

    expect(result.stdout).toContain('No references found');
    expect(result.stdout).toContain('@isolated-item');
    expect(result.exitCode).toBe(0);
  });

  // AC: @unified-cross-reference-lookup ac-ref-resolution
  it('should support ULID, slug, and short ULID reference formats', async () => {
    // Test with slug
    const bySlug = kspecJson<{ total: number }>('refs @spec-a', tempDir);
    expect(bySlug.total).toBeGreaterThan(0);

    // Test with full ULID
    const byUlid = kspecJson<{ total: number }>(`refs ${specAUlid}`, tempDir);
    expect(byUlid.total).toBeGreaterThan(0);

    // Test with short ULID (first 8 chars)
    const byShortUlid = kspecJson<{ total: number }>(`refs ${specAUlid.slice(0, 8)}`, tempDir);
    expect(byShortUlid.total).toBeGreaterThan(0);
  });

  // Error handling: invalid reference
  it('should show error for invalid reference with suggestion', async () => {
    const result = kspec('refs @nonexistent', tempDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
    expect(result.stderr).toContain('search');
  });

  // Test total count
  it('should show correct total count in JSON output', async () => {
    const result = kspecJson<{ total: number }>(
      'refs @spec-a',
      tempDir
    );

    // spec-a is referenced by: spec-b (depends), spec-c (implements), spec-d (relates)
    expect(result.total).toBe(3);
  });
});
