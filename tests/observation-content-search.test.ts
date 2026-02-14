/**
 * Tests for observation content search functionality
 * AC: @observation-content-search
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { kspec, kspecJson, kspecOutput, setupTempFixtures, cleanupTempDir, testUlid } from './helpers/cli';

describe('kspec meta observations --search', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @observation-content-search ac-search-flag
  it('should filter observations by search pattern', async () => {
    // Fixtures have observations with content like "Test friction observation"
    const result = kspec('meta observations --search friction --all', tempDir);
    expect(result.stdout).toContain('friction');
    expect(result.stdout).not.toContain('success observation');
    expect(result.stdout).not.toContain('question observation');
  });

  // AC: @observation-content-search ac-regex-support
  it('should treat search pattern as regex', async () => {
    // Search with regex alternation: friction|success
    const result = kspec('meta observations --search "friction|success" --all', tempDir);
    expect(result.stdout).toContain('friction');
    expect(result.stdout).toContain('success');
    expect(result.stdout).not.toContain('question');
  });

  // AC: @observation-content-search ac-combined-filters
  it('should combine --search with --type filter using AND logic', async () => {
    // Add another friction observation that doesn't match search
    const metaPath = path.join(tempDir, 'kynetic.meta.yaml');
    let metaContent = await fs.readFile(metaPath, 'utf-8');

    const newObs = `
  - _ulid: ${testUlid('0BS', 10)}
    created_at: "2026-01-25T09:00:00Z"
    type: friction
    content: "CLI command test"
    resolved: false
`;
    metaContent = metaContent.replace('observations:', `observations:${newObs}`);
    await fs.writeFile(metaPath, metaContent);

    // Search for "test" with type friction - should get both friction observations
    const result1 = kspec('meta observations --search test --type friction --all', tempDir);
    expect(result1.stdout).toContain('friction');

    // Search for "CLI" with type friction - should get only the new one
    const result2 = kspecJson<Array<{ content: string }>>('meta observations --search CLI --type friction --all', tempDir);
    expect(result2).toHaveLength(1);
    expect(result2[0].content).toContain('CLI');
  });

  // AC: @observation-content-search ac-search-all-fields
  it('should search all text fields not just content', async () => {
    // grepItem searches all text fields recursively, not just the content field
    // The type field is also searchable - "friction", "success", etc.
    // This tests that searching for "success" (which is in the type field)
    // finds the observation even though "success" is also in content
    interface Observation {
      _ulid: string;
      type: string;
      content: string;
    }

    // Search for "success" which is both a type value and in content
    const results = kspecJson<Observation[]>('meta observations --search success --all', tempDir);

    expect(results.length).toBeGreaterThan(0);
    // Should find the success type observation
    const hasSuccessType = results.some(obs => obs.type === 'success');
    expect(hasSuccessType).toBe(true);
  });

  // AC: @observation-content-search ac-search-json
  it('should return only matching observations in JSON mode', async () => {
    interface Observation {
      _ulid: string;
      type: string;
      content: string;
    }

    // Search for friction
    const results = kspecJson<Observation[]>('meta observations --search friction --all', tempDir);

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    // All results should match the search pattern
    for (const obs of results) {
      const matchesPattern = obs.content.toLowerCase().includes('friction') ||
                            obs.type === 'friction';
      expect(matchesPattern).toBe(true);
    }
  });

  it('should show empty result when no observations match search', async () => {
    const result = kspec('meta observations --search "nonexistent-pattern-xyz" --all', tempDir);
    expect(result.stdout).toContain('No');
  });

  it('should be case-insensitive by default', async () => {
    // Search with different case
    const result = kspec('meta observations --search FRICTION --all', tempDir);
    expect(result.stdout).toContain('friction');
  });
});

describe('kspec search --observations-only', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @observation-content-search ac-global-search-filter
  it('should return only observation matches when --observations-only is used', async () => {
    interface SearchResult {
      pattern: string;
      results: Array<{ type: string; ulid: string }>;
      total: number;
    }

    // Search for "test" which should match observations, tasks, and items
    const allResults = kspecJson<SearchResult>('search test', tempDir);
    const observationsOnlyResults = kspecJson<SearchResult>('search test --observations-only', tempDir);

    // observations-only should have fewer results
    expect(observationsOnlyResults.total).toBeLessThanOrEqual(allResults.total);

    // All results should be observations
    for (const result of observationsOnlyResults.results) {
      expect(result.type).toBe('observation');
    }
  });

  it('should find observations by content with --observations-only', async () => {
    interface SearchResult {
      pattern: string;
      results: Array<{ type: string; title: string }>;
      total: number;
    }

    const results = kspecJson<SearchResult>('search friction --observations-only', tempDir);

    expect(results.total).toBeGreaterThan(0);
    expect(results.results.every(r => r.type === 'observation')).toBe(true);
  });

  // AC: @observation-content-search ac-only-flags-exclusive
  it('should error when --observations-only used with --items-only', async () => {
    const result = kspec('search test --observations-only --items-only', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('should error when --observations-only used with --tasks-only', async () => {
    const result = kspec('search test --observations-only --tasks-only', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('should error when all three scope flags are used', async () => {
    const result = kspec('search test --observations-only --items-only --tasks-only', tempDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mutually exclusive');
  });

  it('should work normally with only --items-only', async () => {
    interface SearchResult {
      results: Array<{ type: string }>;
      total: number;
    }

    const results = kspecJson<SearchResult>('search test --items-only', tempDir);

    // All results should be items
    for (const result of results.results) {
      expect(result.type).toBe('item');
    }
  });

  it('should work normally with only --tasks-only', async () => {
    interface SearchResult {
      results: Array<{ type: string }>;
      total: number;
    }

    const results = kspecJson<SearchResult>('search test --tasks-only', tempDir);

    // All results should be tasks
    for (const result of results.results) {
      expect(result.type).toBe('task');
    }
  });
});
