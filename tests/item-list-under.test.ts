/**
 * Tests for kspec item list --under (module-scoped item listing)
 * AC: @module-scoped-item-listing
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

describe('kspec item list --under', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await setupTempFixtures();
  });

  afterAll(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @module-scoped-item-listing ac-under-filter
  it('should list only items structurally nested under specified parent', async () => {
    // The fixtures have: test-core (module) > test-feature > test-requirement
    const result = kspecJson<{ items: unknown[]; total: number }>(
      'item list --under @test-core',
      tempDir
    );

    // Should include the root (test-core), test-feature, and test-requirement
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
  });

  // AC: @module-scoped-item-listing ac-under-root-included
  it('should include the specified item as root node in output', async () => {
    const result = kspecJson<{ items: { slugs: string[] }[] }>(
      'item list --under @test-core',
      tempDir
    );

    const slugs = result.items.flatMap(item => item.slugs || []);
    expect(slugs).toContain('test-core');
  });

  // AC: @module-scoped-item-listing ac-nested-descendants
  it('should include all transitive descendants at multiple depth levels', async () => {
    const result = kspecJson<{ items: { slugs: string[] }[] }>(
      'item list --under @test-core',
      tempDir
    );

    const slugs = result.items.flatMap(item => item.slugs || []);
    // Should have module, feature, and requirement (3 levels)
    expect(slugs).toContain('test-core'); // level 1: module
    expect(slugs).toContain('test-feature'); // level 2: feature
    expect(slugs).toContain('test-requirement'); // level 3: requirement
  });

  // AC: @module-scoped-item-listing ac-under-with-tree
  it('should show hierarchical tree display with --tree flag', async () => {
    const result = kspec('item list --under @test-core --tree', tempDir);

    // Tree output should contain tree characters and all items
    expect(result.stdout).toContain('test-core');
    expect(result.stdout).toContain('test-feature');
    expect(result.stdout).toContain('test-requirement');
    // Tree formatting
    expect(result.stdout).toMatch(/[└├].*[──]/);
  });

  // AC: @module-scoped-item-listing ac-under-with-other-filters
  it('should apply other filters within the scoped subtree (AND logic)', async () => {
    // Filter by type within the scoped tree
    const result = kspecJson<{ items: { type: string }[]; total: number }>(
      'item list --under @test-core --type feature',
      tempDir
    );

    // Should only show the feature, not the module or requirement
    expect(result.total).toBe(1);
    expect(result.items[0].type).toBe('feature');
  });

  // AC: @module-scoped-item-listing ac-under-json
  it('should output JSON array with full item data when --json is used', async () => {
    const result = kspecJson<{ items: { _ulid: string; title: string; type: string }[] }>(
      'item list --under @test-feature',
      tempDir
    );

    // Each item should have full data
    for (const item of result.items) {
      expect(item).toHaveProperty('_ulid');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('type');
    }
  });

  // AC: @module-scoped-item-listing ac-under-invalid-ref
  it('should show error for invalid reference with suggestion', async () => {
    const result = kspec('item list --under @nonexistent', tempDir, { expectFail: true });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
    expect(result.stderr).toContain('kspec item get');
  });

  // AC: @module-scoped-item-listing ac-count-with-under
  it('should count only items in scoped subtree with --count', async () => {
    const result = kspec('item list --under @test-core --count', tempDir);

    // Should count 3 items: module + feature + requirement
    expect(result.stdout.trim()).toBe('3');
  });

  // Test that --under errors on task reference
  it('should reject task references with --under', async () => {
    // The fixtures have test-task-pending
    const result = kspec('item list --under @test-task-pending', tempDir, { expectFail: true });

    // Should error because tasks are not spec items
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('task');
  });

  // Test scoping to a leaf node (no children)
  it('should work for leaf items with no descendants', async () => {
    const result = kspecJson<{ items: unknown[]; total: number }>(
      'item list --under @test-requirement',
      tempDir
    );

    // Leaf item has no children, so only itself
    expect(result.total).toBe(1);
  });

  // Test scoping to a mid-level item
  it('should work for mid-level items (feature level)', async () => {
    const result = kspecJson<{ items: { slugs: string[] }[]; total: number }>(
      'item list --under @test-feature',
      tempDir
    );

    // Feature + requirement (2 items)
    expect(result.total).toBe(2);
    const slugs = result.items.flatMap(item => item.slugs || []);
    expect(slugs).toContain('test-feature');
    expect(slugs).toContain('test-requirement');
    expect(slugs).not.toContain('test-core'); // Parent should not be included
  });
});

describe('findDescendantItems', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await setupTempFixtures();

    // Add a second module file to test cross-file isolation
    const secondModule = `
_ulid: ${testUlid('M0D2')}
slugs:
  - other-module
title: Other Module
type: module
status:
  maturity: draft
  implementation: not_started
features:
  - _ulid: ${testUlid('FEAT2')}
    slugs:
      - other-feature
    title: Other Feature
    type: feature
    status:
      maturity: draft
      implementation: not_started
`;
    const modulesDir = path.join(tempDir, 'modules');
    await fs.writeFile(path.join(modulesDir, 'other.yaml'), secondModule);
  });

  afterAll(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should not include items from different source files', async () => {
    // When scoping to test-core, should not include items from other.yaml
    const result = kspecJson<{ items: { slugs: string[] }[]; total: number }>(
      'item list --under @test-core',
      tempDir
    );

    const slugs = result.items.flatMap(item => item.slugs || []);
    expect(slugs).toContain('test-core');
    expect(slugs).not.toContain('other-module');
    expect(slugs).not.toContain('other-feature');
  });
});
