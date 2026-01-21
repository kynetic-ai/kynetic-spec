import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { setupTempFixtures, kspec, cleanupTempDir } from './helpers/cli.js';
import path from 'path';
import fs from 'fs/promises';

describe('Item Delete with Children', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    // Create modules directory
    await fs.mkdir(path.join(tempDir, '.kspec/modules'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @spec-item-delete-children ac-1
  it('should error when deleting item with children without --cascade', async () => {
    // Create a parent item with nested child
    const parentYaml = `
_ulid: 01TESTPARENT00000000000000
type: feature
title: Parent Feature
slugs:
  - parent-feature
requirements:
  - _ulid: 01TESTCHILD000000000000000
    type: requirement
    title: Child Requirement
    slugs:
      - child-req
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-parent.yaml');
    await fs.writeFile(modulePath, parentYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@parent-feature'], { cwd: tempDir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Cannot delete: item has 1 children');
    expect(result.stderr).toContain('Use --cascade to delete recursively');
  });

  // AC: @spec-item-delete-children ac-2
  it('should delete item and all descendants with --cascade --force', async () => {
    // Create parent with child
    const parentYaml = `
_ulid: 01TESTPARENT00000000000000
type: feature
title: Parent Feature
slugs:
  - parent-feature
requirements:
  - _ulid: 01TESTCHILD000000000000000
    type: requirement
    title: Child Requirement
    slugs:
      - child-req
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-parent.yaml');
    await fs.writeFile(modulePath, parentYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@parent-feature', '--cascade', '--force'], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted 2 items');

    // Verify both items are gone
    const checkParent = await kspec(['item', 'get', '@parent-feature'], { cwd: tempDir });
    expect(checkParent.exitCode).not.toBe(0);

    const checkChild = await kspec(['item', 'get', '@child-req'], { cwd: tempDir });
    expect(checkChild.exitCode).not.toBe(0);
  });

  // AC: @spec-item-delete-children ac-3
  it('should delete deeply nested items (A->B->C) with --cascade', async () => {
    // Create A -> B -> C hierarchy
    const hierarchyYaml = `
_ulid: 01TESTITEMA0000000000000000
type: module
title: Module A
slugs:
  - module-a
features:
  - _ulid: 01TESTITEMB0000000000000000
    type: feature
    title: Feature B
    slugs:
      - feature-b
    requirements:
      - _ulid: 01TESTITEMC0000000000000000
        type: requirement
        title: Requirement C
        slugs:
          - requirement-c
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-hierarchy.yaml');
    await fs.writeFile(modulePath, hierarchyYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@module-a', '--cascade', '--force'], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted 3 items');
  });

  // AC: @spec-item-delete-children ac-4
  it('should allow normal deletion when item has no children', async () => {
    // Create standalone item
    const standaloneYaml = `
_ulid: 01TESTSTANDALN00000000000000
type: requirement
title: Standalone Requirement
slugs:
  - standalone-req
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-standalone.yaml');
    await fs.writeFile(modulePath, standaloneYaml, 'utf-8');

    // Set KSPEC_TEST_TTY to simulate interactive mode
    const result = await kspec(['item', 'delete', '@standalone-req', '--force'], {
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted item');
  });

  // AC: @spec-item-delete-children ac-5
  it('should treat --cascade as no-op when item has no children', async () => {
    // Create standalone item
    const standaloneYaml = `
_ulid: 01TESTSTANDALN00000000000000
type: requirement
title: Standalone Requirement
slugs:
  - standalone-req
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-standalone.yaml');
    await fs.writeFile(modulePath, standaloneYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@standalone-req', '--cascade', '--force'], {
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted item');
    // Should only delete one item, not report multiple
    expect(result.stdout).not.toContain('Deleted 2 items');
  });

  // AC: @spec-item-delete-children ac-6
  it('should create single shadow commit when cascade deletes multiple items', async () => {
    // Create parent with children
    const parentYaml = `
_ulid: 01TESTPARENT00000000000000
type: feature
title: Parent Feature
slugs:
  - parent-feature
requirements:
  - _ulid: 01TESTCHILD100000000000000
    type: requirement
    title: Child 1
    slugs:
      - child-1
  - _ulid: 01TESTCHILD200000000000000
    type: requirement
    title: Child 2
    slugs:
      - child-2
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-parent.yaml');
    await fs.writeFile(modulePath, parentYaml, 'utf-8');

    // Get commit count before
    const beforeLog = await kspec(['log', '@parent-feature', '--json'], { cwd: tempDir });
    const beforeCommits = JSON.parse(beforeLog.stdout);
    const beforeCount = beforeCommits.length;

    // Delete with cascade
    await kspec(['item', 'delete', '@parent-feature', '--cascade', '--force'], { cwd: tempDir });

    // Get commit count after - should be exactly one more commit
    const afterLog = await kspec(['log', '@parent-feature', '--json'], { cwd: tempDir });
    const afterCommits = JSON.parse(afterLog.stdout);
    const afterCount = afterCommits.length;

    // Should have exactly one new commit for the deletion
    expect(afterCount).toBe(beforeCount + 1);
  });

  // AC: @spec-item-delete-children ac-7
  it('should error when deleting trait with implementors', async () => {
    // Create a trait
    const traitYaml = `
_ulid: 01TESTTRAIT00000000000000000
type: trait
title: Test Trait
slugs:
  - test-trait
`;
    const traitPath = path.join(tempDir, '.kspec/modules/test-trait.yaml');
    await fs.writeFile(traitPath, traitYaml, 'utf-8');

    // Create an item that uses the trait
    const itemYaml = `
_ulid: 01TESTITEM000000000000000000
type: requirement
title: Item Using Trait
slugs:
  - item-with-trait
uses:
  - '@test-trait'
`;
    const itemPath = path.join(tempDir, '.kspec/modules/test-item-trait.yaml');
    await fs.writeFile(itemYaml, itemYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@test-trait'], { cwd: tempDir });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Cannot delete: trait is used by 1 specs');
    expect(result.stderr).toContain('Remove trait from specs first');
  });

  // AC: @spec-item-delete-children ac-8
  it('should allow deletion when item has relates_to refs', async () => {
    // Create two items with relates_to relationship
    const item1Yaml = `
_ulid: 01TESTITEM100000000000000000
type: requirement
title: Item 1
slugs:
  - item-1
relates_to:
  - '@item-2'
`;
    const item1Path = path.join(tempDir, '.kspec/modules/test-item1.yaml');
    await fs.writeFile(item1Path, item1Yaml, 'utf-8');

    const item2Yaml = `
_ulid: 01TESTITEM200000000000000000
type: requirement
title: Item 2
slugs:
  - item-2
`;
    const item2Path = path.join(tempDir, '.kspec/modules/test-item2.yaml');
    await fs.writeFile(item2Path, item2Yaml, 'utf-8');

    // Should allow deletion of item-1 even though it has relates_to refs
    const result = await kspec(['item', 'delete', '@item-1', '--force'], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Deleted item');
  });

  // AC: @spec-item-delete-children ac-9
  it('should prompt for confirmation when cascade deleting without --force', async () => {
    // Create parent with child
    const parentYaml = `
_ulid: 01TESTPARENT00000000000000
type: feature
title: Parent Feature
slugs:
  - parent-feature
requirements:
  - _ulid: 01TESTCHILD000000000000000
    type: requirement
    title: Child Requirement
    slugs:
      - child-req
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-parent.yaml');
    await fs.writeFile(modulePath, parentYaml, 'utf-8');

    // Test with 'n' response (decline)
    const resultDecline = await kspec(['item', 'delete', '@parent-feature', '--cascade'], {
      cwd: tempDir,
      env: { KSPEC_TEST_TTY: 'true' },
      input: 'n\n',
    });

    expect(resultDecline.exitCode).toBe(2);
    expect(resultDecline.stdout).toContain('Delete @parent-feature and 1 descendant items? [y/N]');
    expect(resultDecline.stdout).toContain('Operation cancelled');

    // Test with 'y' response (confirm)
    const resultConfirm = await kspec(['item', 'delete', '@parent-feature', '--cascade'], {
      cwd: tempDir,
      env: { KSPEC_TEST_TTY: 'true' },
      input: 'y\n',
    });

    expect(resultConfirm.exitCode).toBe(0);
    expect(resultConfirm.stdout).toContain('Deleted 2 items');
  });

  // AC: @spec-item-delete-children ac-10
  it('should include children array in JSON error output', async () => {
    // Create parent with children
    const parentYaml = `
_ulid: 01TESTPARENT00000000000000
type: feature
title: Parent Feature
slugs:
  - parent-feature
requirements:
  - _ulid: 01TESTCHILD100000000000000
    type: requirement
    title: Child 1
    slugs:
      - child-1
  - _ulid: 01TESTCHILD200000000000000
    type: requirement
    title: Child 2
    slugs:
      - child-2
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-parent.yaml');
    await fs.writeFile(modulePath, parentYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@parent-feature', '--json'], { cwd: tempDir });

    expect(result.exitCode).toBe(1);

    const output = JSON.parse(result.stdout);
    expect(output.error).toBe('has_children');
    expect(output.children).toBeInstanceOf(Array);
    expect(output.children.length).toBe(2);
    expect(output.children[0]).toHaveProperty('ulid');
    expect(output.children[0]).toHaveProperty('slug');
    expect(output.children[0]).toHaveProperty('title');
    expect(output.children[0]).toHaveProperty('ref');
  });

  // Additional tests for edge cases
  it('should error in JSON mode with --cascade but without --force', async () => {
    const parentYaml = `
_ulid: 01TESTPARENT00000000000000
type: feature
title: Parent Feature
slugs:
  - parent-feature
requirements:
  - _ulid: 01TESTCHILD000000000000000
    type: requirement
    title: Child Requirement
    slugs:
      - child-req
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-parent.yaml');
    await fs.writeFile(modulePath, parentYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@parent-feature', '--cascade', '--json'], {
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Confirmation required. Use --force with --json');
  });

  it('should error in non-interactive environment without --force', async () => {
    const parentYaml = `
_ulid: 01TESTPARENT00000000000000
type: feature
title: Parent Feature
slugs:
  - parent-feature
requirements:
  - _ulid: 01TESTCHILD000000000000000
    type: requirement
    title: Child Requirement
    slugs:
      - child-req
`;
    const modulePath = path.join(tempDir, '.kspec/modules/test-parent.yaml');
    await fs.writeFile(modulePath, parentYaml, 'utf-8');

    const result = await kspec(['item', 'delete', '@parent-feature', '--cascade'], {
      cwd: tempDir,
      env: { KSPEC_TEST_TTY: 'false' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Non-interactive environment. Use --force to proceed');
  });
});
