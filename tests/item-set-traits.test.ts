/**
 * Tests for item set trait mutation flags and before→after diff display
 * AC: @trait-confirmation-prompt ac-1, ac-4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  initGitRepo,
} from './helpers/cli';

describe('item set --trait (replace with validation)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    // Create traits
    kspec('trait add "Trait A" --slug trait-a', tempDir);
    kspec('trait add "Trait B" --slug trait-b', tempDir);
    kspec('trait add "Trait C" --slug trait-c', tempDir);

    // Create a spec item with a trait
    kspec(
      'item add --under @test-core --title "Test Feature" --slug test-feat --trait @trait-a',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should replace traits with validated and canonicalized refs', () => {
    kspec('item set @test-feat --trait @trait-b @trait-c', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toEqual(['@trait-b', '@trait-c']);
    expect(item.traits).not.toContain('@trait-a');
  });

  it('should error when trait ref does not exist', () => {
    const result = kspec(
      'item set @test-feat --trait @nonexistent',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Trait not found');
  });

  it('should error when ref is not a trait type', () => {
    const result = kspec(
      'item set @test-feat --trait @test-core',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not a trait');
  });

  it('should deduplicate traits passed multiple times', () => {
    kspec('item set @test-feat --trait @trait-b @trait-b', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toHaveLength(1);
    expect(item.traits).toContain('@trait-b');
  });

  it('should store canonical slug form', () => {
    // Get ULID of trait-b
    const traitData = kspecJson<{ ulid: string }>('item get @trait-b', tempDir);

    // Pass by ULID
    kspec(`item set @test-feat --trait @${traitData.ulid}`, tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toContain('@trait-b');
    expect(item.traits).not.toContain(`@${traitData.ulid}`);
  });
});

describe('item set --add-trait (append)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    kspec('trait add "Trait A" --slug trait-a', tempDir);
    kspec('trait add "Trait B" --slug trait-b', tempDir);
    kspec('trait add "Trait C" --slug trait-c', tempDir);

    kspec(
      'item add --under @test-core --title "Test Feature" --slug test-feat --trait @trait-a',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should append trait to existing traits', () => {
    kspec('item set @test-feat --add-trait @trait-b', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toContain('@trait-a');
    expect(item.traits).toContain('@trait-b');
    expect(item.traits).toHaveLength(2);
  });

  it('should not duplicate when adding trait already present', () => {
    kspec('item set @test-feat --add-trait @trait-a', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toHaveLength(1);
    expect(item.traits).toContain('@trait-a');
  });

  it('should append multiple traits at once', () => {
    kspec('item set @test-feat --add-trait @trait-b @trait-c', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toContain('@trait-a');
    expect(item.traits).toContain('@trait-b');
    expect(item.traits).toContain('@trait-c');
    expect(item.traits).toHaveLength(3);
  });

  it('should validate trait refs', () => {
    const result = kspec(
      'item set @test-feat --add-trait @nonexistent',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Trait not found');
  });
});

describe('item set --remove-trait', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    kspec('trait add "Trait A" --slug trait-a', tempDir);
    kspec('trait add "Trait B" --slug trait-b', tempDir);

    kspec(
      'item add --under @test-core --title "Test Feature" --slug test-feat --trait @trait-a --trait @trait-b',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should remove specified trait and keep others', () => {
    kspec('item set @test-feat --remove-trait @trait-a', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).not.toContain('@trait-a');
    expect(item.traits).toContain('@trait-b');
    expect(item.traits).toHaveLength(1);
  });

  it('should remove multiple traits at once', () => {
    kspec('item set @test-feat --remove-trait @trait-a @trait-b', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toHaveLength(0);
  });

  it('should validate trait refs even when removing', () => {
    const result = kspec(
      'item set @test-feat --remove-trait @nonexistent',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Trait not found');
  });
});

describe('item set --clear-traits', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    kspec('trait add "Trait A" --slug trait-a', tempDir);

    kspec(
      'item add --under @test-core --title "Test Feature" --slug test-feat --trait @trait-a',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should clear all traits', () => {
    kspec('item set @test-feat --clear-traits', tempDir);

    const item = kspecJson<{ traits: string[] }>('item get @test-feat', tempDir);
    expect(item.traits).toHaveLength(0);
  });
});

describe('item set trait flag mutual exclusivity', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    kspec('trait add "Trait A" --slug trait-a', tempDir);
    kspec(
      'item add --under @test-core --title "Test Feature" --slug test-feat',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should error when combining --trait and --add-trait', () => {
    const result = kspec(
      'item set @test-feat --trait @trait-a --add-trait @trait-a',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Cannot combine');
  });

  it('should error when combining --trait and --remove-trait', () => {
    const result = kspec(
      'item set @test-feat --trait @trait-a --remove-trait @trait-a',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Cannot combine');
  });

  it('should error when combining --add-trait and --clear-traits', () => {
    const result = kspec(
      'item set @test-feat --add-trait @trait-a --clear-traits',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Cannot combine');
  });
});

describe('item set before→after diff display', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    await initGitRepo(tempDir);

    kspec('trait add "Trait A" --slug trait-a', tempDir);
    kspec('trait add "Trait B" --slug trait-b', tempDir);
    kspec(
      'item add --under @test-core --title "Test Feature" --slug test-feat --trait @trait-a',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('should show changed fields in success message', () => {
    const result = kspec('item set @test-feat --title "New Title"', tempDir);
    expect(result.stdout).toContain('title');
    expect(result.stdout).toContain('Updated item');
  });

  it('should show before→after for trait changes in text output', () => {
    const result = kspec('item set @test-feat --add-trait @trait-b', tempDir);
    // Should show the traits field changed
    expect(result.stdout).toContain('traits');
  });

  it('should include changes array in JSON output', () => {
    const result = kspecJson<{ changes: Array<{ field: string; before: unknown; after: unknown }> }>(
      'item set @test-feat --title "New Title"',
      tempDir,
    );
    expect(result.changes).toBeDefined();
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].field).toBe('title');
    expect(result.changes[0].before).toBe('Test Feature');
    expect(result.changes[0].after).toBe('New Title');
  });

  it('should include trait changes in JSON output', () => {
    const result = kspecJson<{ changes: Array<{ field: string; before: unknown; after: unknown }> }>(
      'item set @test-feat --add-trait @trait-b',
      tempDir,
    );
    expect(result.changes).toBeDefined();
    const traitChange = result.changes.find((c: { field: string }) => c.field === 'traits');
    expect(traitChange).toBeDefined();
    expect(traitChange!.before).toEqual(['@trait-a']);
    expect(traitChange!.after).toEqual(['@trait-a', '@trait-b']);
  });

  it('should warn when values are already set (no-op)', () => {
    // Set title to same value
    const result = kspec('item set @test-feat --title "Test Feature"', tempDir);
    // Should warn about no changes
    expect(result.stdout + result.stderr).toContain('No changes');
  });
});
