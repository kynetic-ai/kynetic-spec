/**
 * Tests for static-mode review fetching.
 *
 * Verifies that `fetchReviews` and `fetchReview` resolve against the
 * static snapshot when isStaticMode() is true, so the review list page
 * and review detail page (including the resource gallery) render in
 * GitHub Pages / offline mode.
 *
 * Coverage:
 *   - @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 *   - @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 *   - @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KspecSnapshot, ExportedReview } from "../../packages/shared/src/api";

const modeState = vi.hoisted(() => ({
  snapshot: null as KspecSnapshot | null,
  staticMode: false,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => modeState.snapshot,
  isStaticMode: () => modeState.staticMode,
  assertWritable: (op: string) => {
    if (modeState.staticMode) {
      throw new Error(`Cannot ${op} in read-only mode.`);
    }
  },
  ReadOnlyModeError: class ReadOnlyModeError extends Error {
    constructor(operation: string) {
      super(`Cannot ${operation} in read-only mode.`);
    }
  },
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
vi.mock("../../packages/web-ui/src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../../packages/web-ui/src/lib/constants", constantsMock);

import { fetchReview, fetchReviews, fetchReviewSiblings } from "../../packages/web-ui/src/lib/api";
import { fetchReviewStatic, fetchReviewsStatic } from "../../packages/web-ui/src/lib/api-static";

function makeExportedReview(overrides: Partial<ExportedReview> = {}): ExportedReview {
  return {
    _ulid: "01REV0000000000000000000001",
    slugs: ["sample-review"],
    title: "Sample Review",
    lifecycle_state: "open",
    author: "@reviewer",
    subject: {
      type: "task",
      ref: "@task-target",
      shadow_commit: "",
      content_hash: "",
    },
    related_refs: [],
    external_links: [],
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: null,
    examined_commit: null,
    disposition: "pending",
    resources: [],
    ...overrides,
  };
}

function makeSnapshot(reviews: ExportedReview[]): KspecSnapshot {
  return {
    version: "1.0.0",
    exported_at: "2026-04-01T00:00:00.000Z",
    project: { name: "Test", version: "0.0.1" },
    tasks: [],
    items: [],
    inbox: [],
    plans: [],
    reviews,
    session: null,
    observations: [],
    agents: [],
    workflows: [],
    conventions: [],
  };
}

beforeEach(() => {
  modeState.staticMode = false;
  modeState.snapshot = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchReviewsStatic", () => {
  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  it("returns the bounded projection summary for each snapshot review", () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({ slugs: ["r1"], _ulid: "01REV00000000000000000000R1" }),
      makeExportedReview({ slugs: ["r2"], _ulid: "01REV00000000000000000000R2" }),
    ]);
    const result = fetchReviewsStatic();
    expect(result.meta.total).toBe(2);
    expect(result.meta.cache_status).toBe("ready");
    expect(result.data.map((r) => r.slugs[0])).toEqual(["r1", "r2"]);
    // Counts the snapshot does not carry default to 0 — this is the
    // documented behavior of the bounded projection.
    for (const summary of result.data) {
      expect(summary.thread_count).toBe(0);
      expect(summary.unresolved_blocker_count).toBe(0);
      expect(summary.check_count).toBe(0);
      expect(summary.verdict_count).toBe(0);
    }
  });

  it("filters by status and disposition", () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({
        _ulid: "01REV00000000000000000000A1",
        slugs: ["open-pending"],
        lifecycle_state: "open",
        disposition: "pending",
      }),
      makeExportedReview({
        _ulid: "01REV00000000000000000000A2",
        slugs: ["closed-approved"],
        lifecycle_state: "closed",
        disposition: "approved",
      }),
    ]);
    expect(fetchReviewsStatic({ status: "open" }).data.map((r) => r.slugs[0])).toEqual([
      "open-pending",
    ]);
    expect(fetchReviewsStatic({ disposition: "approved" }).data.map((r) => r.slugs[0])).toEqual([
      "closed-approved",
    ]);
    expect(fetchReviewsStatic({ status: ["open", "closed"] }).data.map((r) => r.slugs[0])).toEqual([
      "open-pending",
      "closed-approved",
    ]);
  });

  it("filters by subject_ref and head_branch", () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({
        _ulid: "01REV00000000000000000000B1",
        slugs: ["task-review"],
        subject: {
          type: "task",
          ref: "@task-alpha",
          shadow_commit: "",
          content_hash: "",
        },
      }),
      makeExportedReview({
        _ulid: "01REV00000000000000000000B2",
        slugs: ["code-review"],
        subject: {
          type: "code",
          base_commit: "aaaa",
          head_commit: "bbbb",
          head_branch: "feat/x",
        },
      }),
    ]);
    expect(fetchReviewsStatic({ subject_ref: "@task-alpha" }).data.map((r) => r.slugs[0])).toEqual([
      "task-review",
    ]);
    expect(fetchReviewsStatic({ head_branch: "feat/x" }).data.map((r) => r.slugs[0])).toEqual([
      "code-review",
    ]);
  });

  it("returns an empty envelope when no snapshot is loaded", () => {
    modeState.snapshot = null;
    const result = fetchReviewsStatic();
    expect(result.meta.total).toBe(0);
    expect(result.data).toEqual([]);
  });
});

describe("fetchReviewStatic", () => {
  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("resolves a review by slug and exposes its resource metadata", () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({
        _ulid: "01REVDETAILS0000000000000R1",
        slugs: ["screenshot-review"],
        resources: [
          {
            id: "login-bug",
            label: "Login screenshot",
            path: "screenshots/login.png",
            content_type: "image/png",
            bytes: 12,
            sha256: "0".repeat(64),
            git_commit: null,
            git_path: null,
            description: null,
            exported_path:
              "assets/resources/review/01REVDETAILS0000000000000R1/screenshots/login.png",
          },
        ],
      }),
    ]);
    const result = fetchReviewStatic("@screenshot-review");
    expect(result).not.toBeNull();
    expect(result!.data.title).toBe("Sample Review");
    expect(result!.data.resources).toHaveLength(1);
    expect(result!.data.resources![0]).toMatchObject({
      id: "login-bug",
      content_type: "image/png",
      exported_path: "assets/resources/review/01REVDETAILS0000000000000R1/screenshots/login.png",
    });
    // Bounded projection: arrays the snapshot does not carry surface as empty.
    expect(result!.data.threads).toEqual([]);
    expect(result!.data.checks).toEqual([]);
    expect(result!.data.verdicts).toEqual([]);
  });

  it("resolves a review by ULID prefix", () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({
        _ulid: "01REVABCD000000000000000000",
        slugs: ["by-ulid"],
      }),
    ]);
    const result = fetchReviewStatic("01REVABCD");
    expect(result).not.toBeNull();
    expect(result!.data.slugs).toEqual(["by-ulid"]);
  });

  it("returns null when the review is not found", () => {
    modeState.snapshot = makeSnapshot([]);
    expect(fetchReviewStatic("@nothing-here")).toBeNull();
  });
});

describe("fetchReview in static mode", () => {
  beforeEach(() => {
    modeState.staticMode = true;
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("resolves from the static snapshot instead of throwing", async () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({
        _ulid: "01REVSTATIC0000000000000001",
        slugs: ["render-me"],
        resources: [
          {
            id: "shot",
            label: null,
            path: "shot.png",
            content_type: "image/png",
            bytes: 10,
            sha256: "0".repeat(64),
            git_commit: null,
            git_path: null,
            description: null,
            exported_path: "assets/resources/review/01REVSTATIC0000000000000001/shot.png",
          },
        ],
      }),
    ]);
    const detail = await fetchReview("@render-me");
    expect(detail.title).toBe("Sample Review");
    expect(detail.resources).toHaveLength(1);
    expect(detail.resources![0].exported_path).toBe(
      "assets/resources/review/01REVSTATIC0000000000000001/shot.png",
    );
  });

  it("throws when the static snapshot has no matching review", async () => {
    modeState.snapshot = makeSnapshot([]);
    await expect(fetchReview("@missing")).rejects.toThrow(/Review not found/);
  });
});

describe("fetchReviews in static mode", () => {
  beforeEach(() => {
    modeState.staticMode = true;
  });

  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  it("returns populated summaries from the static snapshot (not an empty list)", async () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({ _ulid: "01LIST00000000000000000001", slugs: ["first"] }),
      makeExportedReview({ _ulid: "01LIST00000000000000000002", slugs: ["second"] }),
    ]);
    const result = await fetchReviews();
    expect(result.total).toBe(2);
    expect(result.items.map((r) => r.slugs[0])).toEqual(["first", "second"]);
  });
});

describe("fetchReviewSiblings in static mode", () => {
  beforeEach(() => {
    modeState.staticMode = true;
  });

  it("returns siblings sharing the same subject from the static snapshot", async () => {
    modeState.snapshot = makeSnapshot([
      makeExportedReview({
        _ulid: "01SIB000000000000000000001",
        slugs: ["sib-a"],
        subject: {
          type: "task",
          ref: "@target",
          shadow_commit: "",
          content_hash: "",
        },
      }),
      makeExportedReview({
        _ulid: "01SIB000000000000000000002",
        slugs: ["sib-b"],
        subject: {
          type: "task",
          ref: "@target",
          shadow_commit: "",
          content_hash: "",
        },
      }),
      makeExportedReview({
        _ulid: "01SIB000000000000000000003",
        slugs: ["other"],
        subject: {
          type: "task",
          ref: "@unrelated",
          shadow_commit: "",
          content_hash: "",
        },
      }),
    ]);
    const siblings = await fetchReviewSiblings({
      subject_type: "task",
      subject_ref: "@target",
    });
    expect(siblings.map((s) => s.slugs[0])).toEqual(["sib-a", "sib-b"]);
  });
});
