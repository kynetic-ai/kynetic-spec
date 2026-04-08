/**
 * Test coverage cache tests
 *
 * AC Coverage: Task @01KGGTYQ - Cache scanTestCoverage() results for daemon performance
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir, cleanupTempDir } from "./helpers/cli";
import {
  getCachedTestCoverage,
  invalidateTestCoverageCache,
  setTestCoverageCacheTTL,
  resetTestCoverageCacheTTL,
  getTestCoverageCacheStats,
} from "../src/parser/coverage-cache";

describe("coverage-cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("coverage-cache-");
    // Create tests directory structure
    await fs.mkdir(path.join(tempDir, "tests"), { recursive: true });
    // Clear cache between tests
    invalidateTestCoverageCache();
    resetTestCoverageCacheTTL();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
    invalidateTestCoverageCache();
    resetTestCoverageCacheTTL();
  });

  describe("getCachedTestCoverage", () => {
    it("should return empty set for project with no tests", async () => {
      const coverage = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(coverage).toBeInstanceOf(Set);
      expect(coverage.size).toBe(0);
    });

    it("should return coverage from test files with AC annotations", async () => {
      // Create a test file with AC annotations
      const testFile = path.join(tempDir, "tests", "example.test.ts");
      await fs.writeFile(
        testFile,
        `
// AC: @spec-item ac-1
it('should do something', () => {});

// AC: @spec-item ac-2, ac-3
it('should do more', () => {});
`,
      );

      const coverage = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@spec-item ac-1")).toBe(true);
      expect(coverage.has("@spec-item ac-2")).toBe(true);
      expect(coverage.has("@spec-item ac-3")).toBe(true);
    });

    it("should ignore bare spec refs without explicit AC ids", async () => {
      const testFile = path.join(tempDir, "tests", "bare-ref.test.ts");
      await fs.writeFile(
        testFile,
        `// AC: @spec-item
it('should not count as coverage', () => {});
`,
      );

      const coverage = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect([...coverage]).toEqual([]);
    });

    it("should return coverage from .spec.ts files in tests/ directory", async () => {
      // .spec.ts files (e.g., Playwright E2E tests) should also be scanned
      const specFile = path.join(tempDir, "tests", "example.spec.ts");
      await fs.writeFile(
        specFile,
        `
// AC: @api-contract ac-2
test('returns tasks', async () => {});

// AC: @api-contract ac-3
test('filters tasks', async () => {});
`,
      );

      const coverage = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@api-contract ac-2")).toBe(true);
      expect(coverage.has("@api-contract ac-3")).toBe(true);
    });

    it("should return coverage from E2E spec files in tests/e2e/", async () => {
      // E2E Playwright tests now live under tests/e2e/
      const e2eDir = path.join(tempDir, "tests", "e2e");
      await fs.mkdir(e2eDir, { recursive: true });
      await fs.writeFile(
        path.join(e2eDir, "api-tasks.spec.ts"),
        `
// AC: @api-contract ac-2
test('returns tasks with required fields', async () => {});

// AC: @api-contract ac-7
test('appends note to task', async () => {});
`,
      );

      const coverage = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@api-contract ac-2")).toBe(true);
      expect(coverage.has("@api-contract ac-7")).toBe(true);
    });

    it("should merge coverage from unit and E2E directories", async () => {
      // Coverage from both tests/ subdirectories should be combined
      await fs.writeFile(
        path.join(tempDir, "tests", "unit.test.ts"),
        '// AC: @spec-a ac-1\nit("unit test", () => {});',
      );
      const e2eDir = path.join(tempDir, "tests", "e2e");
      await fs.mkdir(e2eDir, { recursive: true });
      await fs.writeFile(
        path.join(e2eDir, "api.spec.ts"),
        '// AC: @api-contract ac-5\ntest("e2e test", async () => {});',
      );

      const coverage = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@spec-a ac-1")).toBe(true);
      expect(coverage.has("@api-contract ac-5")).toBe(true);
    });

    it("should cache results on second call", async () => {
      // First call populates cache
      const coverage1 = await getCachedTestCoverage(tempDir, ["tests/"]);
      const stats1 = getTestCoverageCacheStats();
      expect(stats1.entries).toBe(1);

      // Second call should return cached result
      const coverage2 = await getCachedTestCoverage(tempDir, ["tests/"]);

      // Should be the same object (cached)
      expect(coverage1).toBe(coverage2);
    });

    it("should handle parallel calls without duplicate scans", async () => {
      // Create a test file
      const testFile = path.join(tempDir, "tests", "example.test.ts");
      await fs.writeFile(testFile, '// AC: @spec ac-1\nit("test", () => {});');

      // Start multiple parallel calls
      const results = await Promise.all([
        getCachedTestCoverage(tempDir, ["tests/"]),
        getCachedTestCoverage(tempDir, ["tests/"]),
        getCachedTestCoverage(tempDir, ["tests/"]),
      ]);

      // All should return the same cached result
      expect(results[0]).toBe(results[1]);
      expect(results[1]).toBe(results[2]);

      // Only one cache entry should exist
      const stats = getTestCoverageCacheStats();
      expect(stats.entries).toBe(1);
    });

    // AC: @coverage-scan-config ac-configured-paths
    it("should cache separately per scan path configuration", async () => {
      // Regression: cache key must include scanPaths, not just rootDir.
      // Same rootDir with different scanPaths must produce independent cache entries.
      const dirA = path.join(tempDir, "a");
      const dirB = path.join(tempDir, "b");
      await fs.mkdir(dirA, { recursive: true });
      await fs.mkdir(dirB, { recursive: true });
      await fs.writeFile(
        path.join(dirA, "a.test.ts"),
        '// AC: @spec-a ac-1\nit("test a", () => {});',
      );
      await fs.writeFile(
        path.join(dirB, "b.test.ts"),
        '// AC: @spec-b ac-1\nit("test b", () => {});',
      );

      const coverageA = await getCachedTestCoverage(tempDir, ["a/"]);
      const coverageB = await getCachedTestCoverage(tempDir, ["b/"]);

      // Different scan paths should produce different results
      expect(coverageA.has("@spec-a ac-1")).toBe(true);
      expect(coverageA.has("@spec-b ac-1")).toBe(false);

      expect(coverageB.has("@spec-b ac-1")).toBe(true);
      expect(coverageB.has("@spec-a ac-1")).toBe(false);

      // Should NOT be the same object (different cache entries)
      expect(coverageA).not.toBe(coverageB);

      // Two cache entries should exist (one per scan path set)
      const stats = getTestCoverageCacheStats();
      expect(stats.entries).toBe(2);
    });

    it("should cache separately per project directory", async () => {
      const tempDir2 = await createTempDir("coverage-cache-2-");
      await fs.mkdir(path.join(tempDir2, "tests"), { recursive: true });

      try {
        // Create different test files in each directory
        await fs.writeFile(
          path.join(tempDir, "tests", "a.test.ts"),
          '// AC: @spec-a ac-1\nit("test", () => {});',
        );
        await fs.writeFile(
          path.join(tempDir2, "tests", "b.test.ts"),
          '// AC: @spec-b ac-1\nit("test", () => {});',
        );

        const coverage1 = await getCachedTestCoverage(tempDir, ["tests/"]);
        const coverage2 = await getCachedTestCoverage(tempDir2, ["tests/"]);

        // Different projects should have different coverage
        expect(coverage1.has("@spec-a ac-1")).toBe(true);
        expect(coverage1.has("@spec-b ac-1")).toBe(false);

        expect(coverage2.has("@spec-b ac-1")).toBe(true);
        expect(coverage2.has("@spec-a ac-1")).toBe(false);

        // Two cache entries should exist
        const stats = getTestCoverageCacheStats();
        expect(stats.entries).toBe(2);
      } finally {
        await cleanupTempDir(tempDir2);
      }
    });

    it("should expire cache after TTL", async () => {
      // Set a very short TTL
      setTestCoverageCacheTTL(10); // 10ms

      // Create initial test file
      const testFile = path.join(tempDir, "tests", "example.test.ts");
      await fs.writeFile(testFile, '// AC: @spec-a ac-1\nit("test", () => {});');

      const coverage1 = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(coverage1.has("@spec-a ac-1")).toBe(true);

      // Update the test file
      await fs.writeFile(testFile, '// AC: @spec-b ac-1\nit("test", () => {});');

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Should re-scan and get new coverage
      const coverage2 = await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(coverage2.has("@spec-b ac-1")).toBe(true);
      // Old coverage should be gone (new object)
      expect(coverage2).not.toBe(coverage1);
    });
  });

  describe("invalidateTestCoverageCache", () => {
    it("should clear cache for specific project", async () => {
      // Populate cache
      await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(getTestCoverageCacheStats().entries).toBe(1);

      // Invalidate
      invalidateTestCoverageCache(tempDir);
      expect(getTestCoverageCacheStats().entries).toBe(0);
    });

    it("should clear all caches when called without argument", async () => {
      const tempDir2 = await createTempDir("coverage-cache-2-");
      await fs.mkdir(path.join(tempDir2, "tests"), { recursive: true });

      try {
        // Populate caches for multiple projects
        await getCachedTestCoverage(tempDir, ["tests/"]);
        await getCachedTestCoverage(tempDir2, ["tests/"]);
        expect(getTestCoverageCacheStats().entries).toBe(2);

        // Invalidate all
        invalidateTestCoverageCache();
        expect(getTestCoverageCacheStats().entries).toBe(0);
      } finally {
        await cleanupTempDir(tempDir2);
      }
    });

    it("should invalidate all scan path variants for a project", async () => {
      // Populate cache with two different scan path configs for same rootDir
      const dirA = path.join(tempDir, "a");
      const dirB = path.join(tempDir, "b");
      await fs.mkdir(dirA, { recursive: true });
      await fs.mkdir(dirB, { recursive: true });
      await fs.writeFile(
        path.join(dirA, "a.test.ts"),
        '// AC: @spec-a ac-1\nit("test", () => {});',
      );
      await fs.writeFile(
        path.join(dirB, "b.test.ts"),
        '// AC: @spec-b ac-1\nit("test", () => {});',
      );

      await getCachedTestCoverage(tempDir, ["a/"]);
      await getCachedTestCoverage(tempDir, ["b/"]);
      expect(getTestCoverageCacheStats().entries).toBe(2);

      // Invalidating by rootDir should clear both scan path variants
      invalidateTestCoverageCache(tempDir);
      expect(getTestCoverageCacheStats().entries).toBe(0);
    });

    it("should handle path with trailing slash", async () => {
      // Populate cache with path without trailing slash
      await getCachedTestCoverage(tempDir, ["tests/"]);
      expect(getTestCoverageCacheStats().entries).toBe(1);

      // Invalidate with trailing slash - should still work
      invalidateTestCoverageCache(`${tempDir}/`);
      expect(getTestCoverageCacheStats().entries).toBe(0);
    });
  });

  describe("cache configuration", () => {
    it("should report correct TTL in stats", () => {
      const defaultStats = getTestCoverageCacheStats();
      expect(defaultStats.ttlMs).toBe(60_000); // 60 seconds default

      setTestCoverageCacheTTL(30_000);
      const customStats = getTestCoverageCacheStats();
      expect(customStats.ttlMs).toBe(30_000);
    });

    it("should reset TTL to default", () => {
      setTestCoverageCacheTTL(5_000);
      expect(getTestCoverageCacheStats().ttlMs).toBe(5_000);

      resetTestCoverageCacheTTL();
      expect(getTestCoverageCacheStats().ttlMs).toBe(60_000);
    });
  });
});
