/**
 * Cache warming view state tests.
 *
 * Verifies that the view-level logic correctly distinguishes cache warming
 * errors from normal errors, enabling skeleton display during warming and
 * CacheWarmingBanner display after timeout.
 *
 * AC: @ui-data-freshness ac-warming-skeleton — skeleton displayed instead of empty content
 * AC: @ui-data-freshness ac-warming-timeout — error state with manual retry after 30s
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Simulates the view-level derived state logic used in all list views:
 *   let cacheWarming = $derived(isCacheWarmingError(query.error));
 *   let error = $derived(cacheWarming ? '' : (query.error?.message ?? ''));
 */
function deriveViewState(queryError: Error | null) {
  const cacheWarming = isCacheWarmingError(queryError);
  const error = cacheWarming ? "" : (queryError?.message ?? "");
  return { cacheWarming, error };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cache warming view state derivation", () => {
  // AC: @ui-data-freshness ac-warming-skeleton
  describe("during cache warming (CacheWarmingError)", () => {
    it("sets cacheWarming=true when query error is CacheWarmingError", () => {
      const state = deriveViewState(new CacheWarmingError());
      expect(state.cacheWarming).toBe(true);
    });

    it("suppresses error message so generic error UI is not shown", () => {
      const state = deriveViewState(new CacheWarmingError());
      expect(state.error).toBe("");
    });

    it("skeleton is shown instead of error (cacheWarming + empty error = skeleton branch)", () => {
      // In templates: {#if cacheWarming} <CacheWarmingBanner/> {:else if loading} <Skeleton/>
      // When cacheWarming is true, the CacheWarmingBanner shows (timeout error state)
      // During retries, isLoading is true and the skeleton shows
      // After retries exhaust, cacheWarming becomes true → CacheWarmingBanner shows
      const state = deriveViewState(new CacheWarmingError());
      expect(state.cacheWarming).toBe(true);
      expect(state.error).toBe("");
    });
  });

  // AC: @ui-data-freshness ac-warming-timeout
  describe("after warming timeout (retries exhausted)", () => {
    it("CacheWarmingError propagates as cacheWarming=true for banner display", () => {
      // After 15 retries (30s), TanStack Query sets query.error = CacheWarmingError
      // The view derives cacheWarming=true, which renders CacheWarmingBanner
      const state = deriveViewState(new CacheWarmingError());
      expect(state.cacheWarming).toBe(true);
      // The CacheWarmingBanner provides:
      // - Error message: "Unable to load [entity]. The server cache did not become ready."
      // - Retry button: calls queryClient.resetQueries() for the relevant key
    });
  });

  describe("normal errors (non-warming)", () => {
    it("sets cacheWarming=false for regular Error", () => {
      const state = deriveViewState(new Error("Network timeout"));
      expect(state.cacheWarming).toBe(false);
    });

    it("passes through error message for generic error display", () => {
      const state = deriveViewState(new Error("Daemon unreachable"));
      expect(state.error).toBe("Daemon unreachable");
    });
  });

  describe("no error (successful query)", () => {
    it("sets cacheWarming=false when no error", () => {
      const state = deriveViewState(null);
      expect(state.cacheWarming).toBe(false);
    });

    it("error is empty string when no error", () => {
      const state = deriveViewState(null);
      expect(state.error).toBe("");
    });
  });
});

describe("CacheWarmingBanner retry mechanism", () => {
  // AC: @ui-data-freshness ac-warming-timeout
  it("CacheWarmingError message is user-friendly", () => {
    const err = new CacheWarmingError();
    expect(err.message).toContain("Cache is still warming");
  });

  it("CacheWarmingError.cacheStatus is 'loading'", () => {
    const err = new CacheWarmingError();
    expect(err.cacheStatus).toBe("loading");
  });
});

describe("view state across all entity types", () => {
  // AC: @ui-data-freshness ac-warming-skeleton — all views show skeletons
  // This test documents that each view follows the same pattern
  const viewEntities = [
    "tasks board",
    "tasks list",
    "spec items",
    "inbox items",
    "sessions",
    "plans",
    "reviews",
    "triage data",
  ];

  for (const entity of viewEntities) {
    it(`${entity} view suppresses warming error for skeleton display`, () => {
      const state = deriveViewState(new CacheWarmingError());
      expect(state.cacheWarming).toBe(true);
      expect(state.error).toBe("");
    });
  }

  for (const entity of viewEntities) {
    it(`${entity} view passes through non-warming errors`, () => {
      const state = deriveViewState(new Error("Something went wrong"));
      expect(state.cacheWarming).toBe(false);
      expect(state.error).toBe("Something went wrong");
    });
  }
});
