import { afterEach, describe, expect, it, vi } from "vitest";

const modeState = vi.hoisted(() => ({
  staticMode: false,
}));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => null,
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
  getSelectedProjectPath: () => "/tmp/project",
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
  CoverageResolutionApiError,
  resolveCoverageResolution,
} from "../../packages/web-ui/src/lib/api";
import type { CoverageResolutionResponse } from "../../packages/web-ui/src/lib/spec-workspace/coverage-resolution";

function detailEnvelope<T>(data: T) {
  return { data, meta: { cache_status: "ready" } };
}

function mockFetchJson(body: unknown, ok = true, status = 200) {
  return vi.fn<() => Promise<Response>>().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function response(): CoverageResolutionResponse {
  return {
    action: "explicit-reverify",
    dry_run: true,
    stored: false,
    target: {
      item_ulid: "01ITEM0000000000000000000",
      item_ref: "@item",
      item_title: "Item",
      ac_id: "ac-1",
      current_fingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    current: {
      presentation: "re_verify",
      state: "stale_positive_evidence",
      rule: "positive_evidence_requires_reverification",
      latest_run_id: "run-1",
      source_evidence_ids: [],
      secondary_causes: [],
    },
    diagnostics: [],
    effects: [],
    affected_scopes: [],
  };
}

describe("coverage resolution API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    modeState.staticMode = false;
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-dry-run-before-apply
  // AC: @spec-workspace-coverage-resolution-panels ac-explicit-reverify-action
  it("routes dry-run preview requests to the shared coverage resolution endpoint", async () => {
    const fetchMock = mockFetchJson(detailEnvelope(response()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveCoverageResolution("explicit-reverify", {
      target: { item_ref: "@item", ac_id: "ac-1" },
      dry_run: true,
    });

    expect(result.dry_run).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:3456/api/coverage/resolve/reverify?dry_run=true");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kspec-Dir": "/tmp/project",
      },
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      action: "explicit-reverify",
      target: { item_ref: "@item", ac_id: "ac-1" },
      dry_run: true,
    });
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-spec-text-revert-action
  it("preserves stale-target conflict guidance and fingerprints from the shared endpoint", async () => {
    const fetchMock = mockFetchJson(
      {
        error: "stale_target",
        message: "Coverage criterion changed.",
        suggestion: "Refresh the coverage detail and retry with the latest current fingerprint.",
        code: "coverage_resolution_stale_target",
        expected_current_fingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        current_fingerprint:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      false,
      409,
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveCoverageResolution("spec-text-revert", {
        target: { item_ref: "@item", ac_id: "ac-1" },
        expected_current_fingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toMatchObject({
      name: "CoverageResolutionApiError",
      status: 409,
      code: "coverage_resolution_stale_target",
      currentFingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    } satisfies Partial<CoverageResolutionApiError>);
  });

  // AC: @spec-workspace-coverage-resolution-panels ac-readonly-resolution-refusal
  it("refuses coverage resolution calls in static read-only mode before opening confirmation", async () => {
    modeState.staticMode = true;
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      resolveCoverageResolution("dispatch-fix", {
        target: { item_ref: "@item", ac_id: "ac-1" },
      }),
    ).rejects.toThrow("Cannot resolve coverage in read-only mode.");
    expect(fetch).not.toHaveBeenCalled();
  });
});
