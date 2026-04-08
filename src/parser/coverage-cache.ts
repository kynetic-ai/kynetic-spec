/**
 * Test coverage cache for daemon performance optimization.
 *
 * Caches scanTestCoverage() results to avoid re-scanning test files
 * on every API request. The cache is per-project-directory and supports:
 * - TTL-based expiration (default 60 seconds)
 * - Explicit invalidation for file watcher integration
 *
 * @module coverage-cache
 */

import { scanTestCoverage } from "./validate.js";

/**
 * Cached coverage data with metadata
 */
interface CacheEntry {
  /** The actual coverage set */
  coverage: Set<string>;
  /** Timestamp when cache was populated */
  cachedAt: number;
  /** Promise for in-flight scan (prevents duplicate parallel scans) */
  pending?: Promise<Set<string>>;
}

/**
 * Default TTL in milliseconds (60 seconds)
 */
const DEFAULT_TTL_MS = 60_000;

/**
 * Per-project cache storage
 * Key: normalized root directory path + sorted scan paths
 */
const cache = new Map<string, CacheEntry>();

/**
 * Configurable TTL (for testing)
 */
let ttlMs = DEFAULT_TTL_MS;

/**
 * Normalize a directory path for use as cache key.
 * Removes trailing slashes for consistency.
 */
function normalizePath(dir: string): string {
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

/**
 * Build a cache key from rootDir, scanPaths, and excludePatterns.
 * Different scan/exclude configurations for the same rootDir
 * must produce different cache entries.
 */
function buildCacheKey(
  rootDir: string,
  scanPaths: string[],
  excludePatterns: string[],
): string {
  const normalizedDir = normalizePath(rootDir);
  const sortedPaths = [...scanPaths].sort().join("\0");
  const sortedExcludes = [...excludePatterns].sort().join("\0");
  return `${normalizedDir}\0${sortedPaths}\0${sortedExcludes}`;
}

/**
 * Check if a cache entry is still valid based on TTL.
 */
function isValid(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < ttlMs;
}

/**
 * Get test coverage for a project directory, using cache when available.
 *
 * This is the primary API for daemon routes. It:
 * 1. Returns cached results if valid
 * 2. Returns in-flight scan result if a scan is already in progress
 * 3. Otherwise initiates a new scan and caches the result
 *
 * @param rootDir - Project root directory
 * @param scanPaths - Directories to scan (relative to rootDir). Empty = no scanning.
 * @returns Set of covered AC references (e.g., "@spec-ref ac-1")
 */
export async function getCachedTestCoverage(
  rootDir: string,
  scanPaths: string[] = [],
  excludePatterns: string[] = [],
): Promise<Set<string>> {
  const key = buildCacheKey(rootDir, scanPaths, excludePatterns);
  const existing = cache.get(key);

  // Return cached result if valid
  if (existing && isValid(existing) && !existing.pending) {
    return existing.coverage;
  }

  // Return in-flight scan if one exists (prevents duplicate parallel scans)
  if (existing?.pending) {
    return existing.pending;
  }

  // Initiate new scan
  const scanPromise = scanTestCoverage(rootDir, scanPaths, excludePatterns);

  // Store pending promise to prevent parallel scans
  const entry: CacheEntry = existing || {
    coverage: new Set(),
    cachedAt: 0,
  };
  entry.pending = scanPromise;
  cache.set(key, entry);

  try {
    const coverage = await scanPromise;
    // Update cache with result
    entry.coverage = coverage;
    entry.cachedAt = Date.now();
    entry.pending = undefined;
    return coverage;
  } catch (error) {
    // Clear pending on error, allow retry
    entry.pending = undefined;
    throw error;
  }
}

/**
 * Invalidate the test coverage cache for a specific project or all projects.
 *
 * Call this when test files change (via file watcher) to ensure
 * fresh coverage data on next request.
 *
 * @param rootDir - Optional project root directory. If omitted, clears all caches.
 */
export function invalidateTestCoverageCache(rootDir?: string): void {
  if (rootDir) {
    const prefix = normalizePath(rootDir) + "\0";
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
}

/**
 * Set the cache TTL (for testing purposes).
 *
 * @param ms - TTL in milliseconds
 */
export function setTestCoverageCacheTTL(ms: number): void {
  ttlMs = ms;
}

/**
 * Reset the cache TTL to default (for testing purposes).
 */
export function resetTestCoverageCacheTTL(): void {
  ttlMs = DEFAULT_TTL_MS;
}

/**
 * Get current cache statistics (for debugging/monitoring).
 */
export function getTestCoverageCacheStats(): {
  entries: number;
  ttlMs: number;
} {
  return {
    entries: cache.size,
    ttlMs,
  };
}
