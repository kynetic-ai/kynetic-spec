/**
 * Query client cache warming retry configuration tests.
 *
 * Verifies that TanStack Query is configured to retry CacheWarmingError
 * at 2-second intervals up to 15 attempts (30-second ceiling), while
 * keeping normal error retry behavior at 1 attempt / 1s delay.
 *
 * AC: @ui-data-freshness ac-warming-retry-fallback — retry at short intervals as fallback
 * AC: @ui-data-freshness ac-warming-timeout — 30s ceiling then error propagates
 * AC: @ui-data-freshness ac-warming-skeleton — warming data not cached as successful result
 */

import { describe, expect, it, vi } from "vitest";

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

// Mock @tanstack/svelte-query to avoid .svelte file resolution
vi.mock("@tanstack/svelte-query", () => ({
  QueryClient: class MockQueryClient {
    private opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
    getDefaultOptions() {
      return (this.opts as { defaultOptions?: Record<string, unknown> }).defaultOptions ?? {};
    }
  },
}));

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

// Mock SvelteKit $lib/ aliases — resolve to the actual relative-path modules
vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../../packages/web-ui/src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../../packages/web-ui/src/lib/constants", constantsMock);
vi.mock("$lib/api-static", () => ({}));
vi.mock("../../packages/web-ui/src/lib/api-static", () => ({}));

// Re-export CacheWarmingError from api.ts for the $lib/api alias used by client.ts
vi.mock("$lib/api", async () => {
  const actual = await vi.importActual("../../packages/web-ui/src/lib/api");
  return actual;
});

import {
  createQueryClientInstance,
  CACHE_WARMING_MAX_RETRIES,
  CACHE_WARMING_RETRY_DELAY_MS,
} from "../../packages/web-ui/src/lib/query/client";
import { CacheWarmingError, isCacheWarmingError } from "../../packages/web-ui/src/lib/api";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("query client cache warming retry", () => {
  // AC: @ui-data-freshness ac-warming-retry-fallback
  describe("retry callback", () => {
    it("allows up to 15 retries for CacheWarmingError", () => {
      const client = createQueryClientInstance();
      const retryFn = client.getDefaultOptions().queries?.retry;

      expect(typeof retryFn).toBe("function");
      if (typeof retryFn !== "function") return;

      const warmingError = new CacheWarmingError();

      // Should retry for attempts 0 through 14
      for (let i = 0; i < CACHE_WARMING_MAX_RETRIES; i++) {
        expect(retryFn(i, warmingError)).toBe(true);
      }

      // Should stop at attempt 15 (the 16th call)
      expect(retryFn(CACHE_WARMING_MAX_RETRIES, warmingError)).toBe(false);
    });

    it("allows only 1 retry for normal errors", () => {
      const client = createQueryClientInstance();
      const retryFn = client.getDefaultOptions().queries?.retry;

      expect(typeof retryFn).toBe("function");
      if (typeof retryFn !== "function") return;

      const normalError = new Error("Network error");

      // First attempt (failureCount=0) should retry
      expect(retryFn(0, normalError)).toBe(true);

      // Second attempt (failureCount=1) should not retry
      expect(retryFn(1, normalError)).toBe(false);
    });

    it("does not retry mutations", () => {
      const client = createQueryClientInstance();
      const mutationRetry = client.getDefaultOptions().mutations?.retry;
      expect(mutationRetry).toBe(0);
    });
  });

  // AC: @ui-data-freshness ac-warming-retry-fallback
  describe("retryDelay callback", () => {
    it("uses 2-second delay for CacheWarmingError", () => {
      const client = createQueryClientInstance();
      const retryDelayFn = client.getDefaultOptions().queries?.retryDelay;

      expect(typeof retryDelayFn).toBe("function");
      if (typeof retryDelayFn !== "function") return;

      const warmingError = new CacheWarmingError();

      expect(retryDelayFn(0, warmingError)).toBe(CACHE_WARMING_RETRY_DELAY_MS);
      expect(retryDelayFn(5, warmingError)).toBe(CACHE_WARMING_RETRY_DELAY_MS);
      expect(retryDelayFn(14, warmingError)).toBe(CACHE_WARMING_RETRY_DELAY_MS);
    });

    it("uses 1-second delay for normal errors", () => {
      const client = createQueryClientInstance();
      const retryDelayFn = client.getDefaultOptions().queries?.retryDelay;

      expect(typeof retryDelayFn).toBe("function");
      if (typeof retryDelayFn !== "function") return;

      const normalError = new Error("timeout");

      expect(retryDelayFn(0, normalError)).toBe(1000);
    });
  });

  // AC: @ui-data-freshness ac-warming-timeout
  describe("timeout ceiling", () => {
    it("retry constants produce 30-second ceiling", () => {
      expect(CACHE_WARMING_MAX_RETRIES).toBe(15);
      expect(CACHE_WARMING_RETRY_DELAY_MS).toBe(2000);
      expect(CACHE_WARMING_MAX_RETRIES * CACHE_WARMING_RETRY_DELAY_MS).toBe(30_000);
    });

    it("error propagates after reaching retry ceiling", () => {
      const client = createQueryClientInstance();
      const retryFn = client.getDefaultOptions().queries?.retry;

      expect(typeof retryFn).toBe("function");
      if (typeof retryFn !== "function") return;

      const warmingError = new CacheWarmingError();

      // At the ceiling, retry returns false — error propagates to the UI
      expect(retryFn(CACHE_WARMING_MAX_RETRIES, warmingError)).toBe(false);
      expect(retryFn(CACHE_WARMING_MAX_RETRIES + 1, warmingError)).toBe(false);
    });
  });

  // AC: @ui-data-freshness ac-warming-skeleton — warming errors not cached as successful data
  describe("CacheWarmingError prevents caching", () => {
    it("CacheWarmingError is an Error instance (TanStack Query treats it as failed)", () => {
      const err = new CacheWarmingError();
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("CacheWarmingError");
      expect(err.cacheStatus).toBe("loading");
    });
  });

  describe("isCacheWarmingError type guard", () => {
    // AC: @ui-data-freshness ac-warming-skeleton
    it("returns true for CacheWarmingError instances", () => {
      expect(isCacheWarmingError(new CacheWarmingError())).toBe(true);
    });

    it("returns false for regular Error instances", () => {
      expect(isCacheWarmingError(new Error("other"))).toBe(false);
    });

    it("returns false for non-error values", () => {
      expect(isCacheWarmingError(null)).toBe(false);
      expect(isCacheWarmingError(undefined)).toBe(false);
      expect(isCacheWarmingError("string")).toBe(false);
      expect(isCacheWarmingError({ name: "CacheWarmingError" })).toBe(false);
    });
  });

  describe("existing query config preserved", () => {
    it("preserves staleTime at 30s", () => {
      const client = createQueryClientInstance();
      expect(client.getDefaultOptions().queries?.staleTime).toBe(30_000);
    });

    it("preserves gcTime at 10 minutes", () => {
      const client = createQueryClientInstance();
      expect(client.getDefaultOptions().queries?.gcTime).toBe(600_000);
    });

    it("keeps refetchOnWindowFocus disabled", () => {
      const client = createQueryClientInstance();
      expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    });
  });
});
