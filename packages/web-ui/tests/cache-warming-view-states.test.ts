/**
 * Cache warming error detection and query retry integration tests.
 *
 * Tests the real CacheWarmingError class and isCacheWarmingError type guard
 * that views use to derive the cacheWarming state. Behavioral rendering tests
 * (skeleton display, CacheWarmingBanner rendering, retry button) are covered
 * by E2E tests in tests/e2e/cache-warming-views.spec.ts.
 *
 * AC: @ui-data-freshness ac-warming-skeleton — CacheWarmingError detection used by views
 * AC: @ui-data-freshness ac-warming-timeout — error properties for banner display
 */

import { describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => null,
  isStaticMode: () => false,
  assertWritable: () => {},
  ReadOnlyModeError: class extends Error {},
}));

const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => null,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));

const constantsMock = vi.hoisted(() => () => ({
  DAEMON_API_BASE: "http://localhost:3456",
}));

vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../src/lib/constants", constantsMock);
vi.mock("$lib/api-static", () => ({}));
vi.mock("../src/lib/api-static", () => ({}));
vi.mock("$lib/api", async () => {
  const actual = await vi.importActual("../src/lib/api");
  return actual;
});

import { CacheWarmingError, isCacheWarmingError } from "../src/lib/api";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CacheWarmingError for view state integration", () => {
  // AC: @ui-data-freshness ac-warming-skeleton
  describe("error detection used by view derived state", () => {
    it("isCacheWarmingError returns true for CacheWarmingError", () => {
      expect(isCacheWarmingError(new CacheWarmingError())).toBe(true);
    });

    it("isCacheWarmingError returns false for regular errors", () => {
      expect(isCacheWarmingError(new Error("Network timeout"))).toBe(false);
    });

    it("isCacheWarmingError returns false for null (no error state)", () => {
      expect(isCacheWarmingError(null)).toBe(false);
    });

    it("isCacheWarmingError returns false for non-Error values", () => {
      expect(isCacheWarmingError(undefined)).toBe(false);
      expect(isCacheWarmingError("string")).toBe(false);
      expect(isCacheWarmingError({ name: "CacheWarmingError" })).toBe(false);
    });
  });

  // AC: @ui-data-freshness ac-warming-timeout
  describe("CacheWarmingError properties for banner display", () => {
    it("has user-friendly message for UI display", () => {
      const err = new CacheWarmingError();
      expect(err.message).toContain("Cache is still warming");
    });

    it("cacheStatus is 'loading' for status detection", () => {
      const err = new CacheWarmingError();
      expect(err.cacheStatus).toBe("loading");
    });

    it("is an Error instance so TanStack Query treats it as failure", () => {
      const err = new CacheWarmingError();
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("CacheWarmingError");
    });
  });
});
