/**
 * Tests for the web-ui review-resource API helpers
 * (`reviewResourceBytesUrl`, `fetchReviewResources`).
 *
 * Verifies the URL contract the daemon publishes and the client surface the
 * Svelte detail page uses to render review evidence.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const modeState = vi.hoisted(() => ({
  staticMode: false,
}));

const projectState = vi.hoisted(() => ({
  selectedPath: null as string | null,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => null,
  isStaticMode: () => modeState.staticMode,
  assertWritable: () => {},
  ReadOnlyModeError: class ReadOnlyModeError extends Error {},
}));

const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => projectState.selectedPath,
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

vi.mock("$lib/api-static", () => ({}));
vi.mock("../../packages/web-ui/src/lib/api-static", () => ({}));

import {
  encodeStaticAssetPath,
  fetchReviewResources,
  reviewResourceBytesUrl,
} from "../../packages/web-ui/src/lib/api";

beforeEach(() => {
  modeState.staticMode = false;
  projectState.selectedPath = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reviewResourceBytesUrl", () => {
  it("builds the daemon URL for raw resource bytes", () => {
    expect(reviewResourceBytesUrl("@review-1", "shot")).toBe(
      "http://localhost:3456/api/reviews/%40review-1/resources/shot/bytes",
    );
  });

  it("URL-encodes both the review ref and the resource id", () => {
    expect(reviewResourceBytesUrl("review with spaces", "id/with/slash")).toBe(
      "http://localhost:3456/api/reviews/review%20with%20spaces/resources/id%2Fwith%2Fslash/bytes",
    );
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  // AC: @multi-directory-daemon ac-26 — selected non-default project context
  // must travel with the URL (browser <img>/<a> requests cannot set the
  // X-Kspec-Dir header, so the project path must be in the URL itself).
  it("includes the selected project path as a kspec_dir query param when a non-default project is selected", () => {
    projectState.selectedPath = "/home/me/other-project";
    expect(reviewResourceBytesUrl("@review-1", "shot")).toBe(
      "http://localhost:3456/api/reviews/%40review-1/resources/shot/bytes?kspec_dir=%2Fhome%2Fme%2Fother-project",
    );
  });

  it("URL-encodes special characters in the selected project path", () => {
    projectState.selectedPath = "/path with spaces/proj";
    expect(reviewResourceBytesUrl("@review-1", "shot")).toBe(
      "http://localhost:3456/api/reviews/%40review-1/resources/shot/bytes?kspec_dir=%2Fpath%20with%20spaces%2Fproj",
    );
  });

  it("omits the kspec_dir query param when no project is selected", () => {
    projectState.selectedPath = null;
    expect(reviewResourceBytesUrl("@review-1", "shot")).toBe(
      "http://localhost:3456/api/reviews/%40review-1/resources/shot/bytes",
    );
  });
});

describe("encodeStaticAssetPath", () => {
  // The schema for a resource `path` only rejects absolute paths,
  // traversal, backslashes, empty/dot segments, and trailing slashes.
  // URL-reserved characters such as `#` and `?` (and spaces) are
  // legitimate filename characters and can therefore land in a valid
  // exported_path. The browser interprets `#suffix` as a fragment and
  // `?suffix` as a query string when those characters appear raw in an
  // `<a href>` or `<img src>`, so the URL builder must encode each
  // segment individually while keeping the `/` path separators intact.
  //
  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("encodes `#` so it is not parsed as a URL fragment", () => {
    const encoded = encodeStaticAssetPath(
      "assets/resources/review/01REV/screenshots/login#bug.png",
    );
    expect(encoded).toBe(
      "assets/resources/review/01REV/screenshots/login%23bug.png",
    );
    const parsed = new URL(`https://example.com/base/${encoded}`);
    expect(parsed.pathname).toBe(
      "/base/assets/resources/review/01REV/screenshots/login%23bug.png",
    );
    expect(parsed.hash).toBe("");
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("encodes `?` so it is not parsed as a query string", () => {
    const encoded = encodeStaticAssetPath(
      "assets/resources/review/01REV/screenshots/login?ref.png",
    );
    expect(encoded).toBe(
      "assets/resources/review/01REV/screenshots/login%3Fref.png",
    );
    const parsed = new URL(`https://example.com/base/${encoded}`);
    expect(parsed.pathname).toBe(
      "/base/assets/resources/review/01REV/screenshots/login%3Fref.png",
    );
    expect(parsed.search).toBe("");
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("encodes spaces and other reserved characters per segment", () => {
    expect(
      encodeStaticAssetPath(
        "assets/resources/review/01REV/notes/draft & final.png",
      ),
    ).toBe(
      "assets/resources/review/01REV/notes/draft%20%26%20final.png",
    );
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("preserves `/` segment separators (does not collapse the path)", () => {
    const encoded = encodeStaticAssetPath(
      "assets/resources/review/01REV/sub/dir/file.png",
    );
    expect(encoded).toBe(
      "assets/resources/review/01REV/sub/dir/file.png",
    );
    expect(encoded.split("/")).toHaveLength(7);
  });

  // AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
  it("is a no-op for paths with no URL-reserved characters", () => {
    expect(
      encodeStaticAssetPath(
        "assets/resources/review/01REV/screenshots/login.png",
      ),
    ).toBe("assets/resources/review/01REV/screenshots/login.png");
  });
});

describe("fetchReviewResources", () => {
  it("hits GET /api/reviews/:id/resources and returns the unwrapped list", async () => {
    const sampleBody = {
      resources: [
        {
          id: "shot",
          label: "Screenshot",
          path: "shot.png",
          content_type: "image/png",
          bytes: 12,
          sha256: "0".repeat(64),
          git_commit: null,
          git_path: null,
          description: null,
        },
      ],
    };
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleBody),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchReviewResources("@review-1");
    expect(result).toEqual(sampleBody);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3456/api/reviews/%40review-1/resources",
      expect.any(Object),
    );
  });

  it("throws in static mode (snapshot reads happen client-side)", async () => {
    modeState.staticMode = true;
    await expect(fetchReviewResources("@review-1")).rejects.toThrow(/static mode/);
  });
});
