import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { setupTempFixtures, kspec, kspecJson, cleanupTempDir } from './helpers/cli.js';

describe('Item Set Relationship Flags', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  describe('--relates-to flag', () => {
    // AC: @item-set ac-5
    it('should add relates_to reference to item', () => {
      // Create two items
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);
      kspec('item add --under @test-core --title "Item B" --type requirement --slug item-b', tempDir);

      // Add relates_to reference
      const result = kspec('item set @item-a --relates-to @item-b', tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Updated item');

      // Verify the relationship was added
      const item = kspecJson<{ relates_to: string[] }>('item get @item-a', tempDir);
      expect(item.relates_to).toContain('@item-b');
    });

    it('should append to existing relates_to references', () => {
      // Create three items
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);
      kspec('item add --under @test-core --title "Item B" --type requirement --slug item-b', tempDir);
      kspec('item add --under @test-core --title "Item C" --type requirement --slug item-c', tempDir);

      // Add first relationship
      kspec('item set @item-a --relates-to @item-b', tempDir);

      // Add second relationship
      const result = kspec('item set @item-a --relates-to @item-c', tempDir);
      expect(result.exitCode).toBe(0);

      // Verify both relationships exist
      const item = kspecJson<{ relates_to: string[] }>('item get @item-a', tempDir);
      expect(item.relates_to).toContain('@item-b');
      expect(item.relates_to).toContain('@item-c');
    });

    it('should not add duplicate relates_to reference', () => {
      // Create two items
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);
      kspec('item add --under @test-core --title "Item B" --type requirement --slug item-b', tempDir);

      // Add relationship twice
      kspec('item set @item-a --relates-to @item-b', tempDir);
      kspec('item set @item-a --relates-to @item-b', tempDir);

      // Verify only one reference
      const item = kspecJson<{ relates_to: string[] }>('item get @item-a', tempDir);
      expect(item.relates_to.filter(r => r === '@item-b')).toHaveLength(1);
    });

    it('should error when relates_to reference does not exist', () => {
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);

      const result = kspec('item set @item-a --relates-to @nonexistent', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(3); // NOT_FOUND
      expect(result.stderr).toContain('not found');
    });

    it('should error when relates_to reference is a task, not a spec item', () => {
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);
      // test-task-pending is a task from the fixtures
      const result = kspec('item set @item-a --relates-to @test-task-pending', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2); // USAGE_ERROR
      expect(result.stderr).toContain('must be a spec item, not a task');
    });
  });

  describe('--implements flag', () => {
    // AC: @item-set ac-6
    it('should add implements reference to item', () => {
      // Create a feature and a requirement that implements it
      kspec('item add --under @test-core --title "Feature X" --type feature --slug feature-x', tempDir);
      kspec('item add --under @test-core --title "Requirement Y" --type requirement --slug req-y', tempDir);

      const result = kspec('item set @req-y --implements @feature-x', tempDir);
      expect(result.exitCode).toBe(0);

      const item = kspecJson<{ implements: string[] }>('item get @req-y', tempDir);
      expect(item.implements).toContain('@feature-x');
    });

    it('should append to existing implements references', () => {
      kspec('item add --under @test-core --title "Feature A" --type feature --slug feature-a', tempDir);
      kspec('item add --under @test-core --title "Feature B" --type feature --slug feature-b', tempDir);
      kspec('item add --under @test-core --title "Requirement" --type requirement --slug req', tempDir);

      kspec('item set @req --implements @feature-a', tempDir);
      kspec('item set @req --implements @feature-b', tempDir);

      const item = kspecJson<{ implements: string[] }>('item get @req', tempDir);
      expect(item.implements).toContain('@feature-a');
      expect(item.implements).toContain('@feature-b');
    });

    it('should error when implements reference does not exist', () => {
      kspec('item add --under @test-core --title "Requirement" --type requirement --slug req', tempDir);

      const result = kspec('item set @req --implements @nonexistent', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(3); // NOT_FOUND
    });
  });

  describe('--depends-on flag', () => {
    // AC: @item-set ac-7
    it('should add depends_on reference to item', () => {
      kspec('item add --under @test-core --title "Prereq" --type requirement --slug prereq', tempDir);
      kspec('item add --under @test-core --title "Dependent" --type requirement --slug dependent', tempDir);

      const result = kspec('item set @dependent --depends-on @prereq', tempDir);
      expect(result.exitCode).toBe(0);

      const item = kspecJson<{ depends_on: string[] }>('item get @dependent', tempDir);
      expect(item.depends_on).toContain('@prereq');
    });

    it('should append to existing depends_on references', () => {
      kspec('item add --under @test-core --title "Prereq A" --type requirement --slug prereq-a', tempDir);
      kspec('item add --under @test-core --title "Prereq B" --type requirement --slug prereq-b', tempDir);
      kspec('item add --under @test-core --title "Dependent" --type requirement --slug dependent', tempDir);

      kspec('item set @dependent --depends-on @prereq-a', tempDir);
      kspec('item set @dependent --depends-on @prereq-b', tempDir);

      const item = kspecJson<{ depends_on: string[] }>('item get @dependent', tempDir);
      expect(item.depends_on).toContain('@prereq-a');
      expect(item.depends_on).toContain('@prereq-b');
    });

    it('should error when depends_on reference does not exist', () => {
      kspec('item add --under @test-core --title "Dependent" --type requirement --slug dependent', tempDir);

      const result = kspec('item set @dependent --depends-on @nonexistent', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(3); // NOT_FOUND
    });
  });

  describe('--clear-* flags', () => {
    it('should clear all relates_to references', () => {
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);
      kspec('item add --under @test-core --title "Item B" --type requirement --slug item-b', tempDir);
      kspec('item set @item-a --relates-to @item-b', tempDir);

      const result = kspec('item set @item-a --clear-relates-to', tempDir);
      expect(result.exitCode).toBe(0);

      const item = kspecJson<{ relates_to: string[] }>('item get @item-a', tempDir);
      expect(item.relates_to).toEqual([]);
    });

    it('should clear all implements references', () => {
      kspec('item add --under @test-core --title "Feature" --type feature --slug feature', tempDir);
      kspec('item add --under @test-core --title "Req" --type requirement --slug req', tempDir);
      kspec('item set @req --implements @feature', tempDir);

      const result = kspec('item set @req --clear-implements', tempDir);
      expect(result.exitCode).toBe(0);

      const item = kspecJson<{ implements: string[] }>('item get @req', tempDir);
      expect(item.implements).toEqual([]);
    });

    it('should clear all depends_on references', () => {
      kspec('item add --under @test-core --title "Prereq" --type requirement --slug prereq', tempDir);
      kspec('item add --under @test-core --title "Dependent" --type requirement --slug dependent', tempDir);
      kspec('item set @dependent --depends-on @prereq', tempDir);

      const result = kspec('item set @dependent --clear-depends-on', tempDir);
      expect(result.exitCode).toBe(0);

      const item = kspecJson<{ depends_on: string[] }>('item get @dependent', tempDir);
      expect(item.depends_on).toEqual([]);
    });

    it('should error when using --relates-to and --clear-relates-to together', () => {
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);
      kspec('item add --under @test-core --title "Item B" --type requirement --slug item-b', tempDir);

      const result = kspec('item set @item-a --relates-to @item-b --clear-relates-to', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2); // USAGE_ERROR
      expect(result.stderr).toContain('Cannot use --relates-to and --clear-relates-to together');
    });

    it('should error when using --implements and --clear-implements together', () => {
      kspec('item add --under @test-core --title "Feature" --type feature --slug feature', tempDir);
      kspec('item add --under @test-core --title "Req" --type requirement --slug req', tempDir);

      const result = kspec('item set @req --implements @feature --clear-implements', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Cannot use --implements and --clear-implements together');
    });

    it('should error when using --depends-on and --clear-depends-on together', () => {
      kspec('item add --under @test-core --title "Prereq" --type requirement --slug prereq', tempDir);
      kspec('item add --under @test-core --title "Dependent" --type requirement --slug dependent', tempDir);

      const result = kspec('item set @dependent --depends-on @prereq --clear-depends-on', tempDir, { expectFail: true });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('Cannot use --depends-on and --clear-depends-on together');
    });
  });

  describe('JSON output', () => {
    // AC: @trait-json-output ac-1, ac-2
    it('should include updated relationships in JSON output', () => {
      kspec('item add --under @test-core --title "Item A" --type requirement --slug item-a', tempDir);
      kspec('item add --under @test-core --title "Item B" --type requirement --slug item-b', tempDir);
      kspec('item set @item-a --relates-to @item-b', tempDir);

      const item = kspecJson<{ relates_to: string[] }>('item get @item-a', tempDir);
      expect(item.relates_to).toContain('@item-b');
    });
  });
});
