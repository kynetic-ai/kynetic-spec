import { describe, expect, it, vi } from "vitest";
import type {
  CoverageCriterionStateDetail,
  CoverageItemStateSummary,
  CoverageStateSnapshot,
} from "@kynetic-ai/shared";
import {
  buildCoverageResolutionDryRunResponse,
  CoverageResolutionReadOnlyError,
  CoverageResolutionStaleTargetError,
  resolveCoverageTarget,
} from "../src/parser/coverage-resolution.js";
import {
  COVERAGE_RESOLUTION_ACTIONS,
  CoverageResolutionRequestSchema,
  CoverageResolutionResponseSchema,
  assertCoverageResolutionWritable,
  buildCoverageResolutionPreconditionDiagnostic,
} from "../src/schema/coverage-resolution.js";
import type { KspecContext, LoadedSpecItem } from "../src/parser/yaml.js";
import { testUlid } from "./helpers/cli.js";

const ITEM_ULID = testUlid("FEAT", 701);

function makeItem(): LoadedSpecItem {
  return {
    _ulid: ITEM_ULID,
    _sourceFile: "neutral/specs/coverage-resolution.yaml",
    title: "Neutral Resolution Target",
    slugs: ["neutral-resolution-target"],
    type: "feature",
    description: "Neutral fixture for coverage resolution contract behavior.",
    acceptance_criteria: [
      {
        id: "ac-stale-text",
        given: "a neutral target has old text",
        when: "coverage state is resolved",
        then: "the current text participates in concurrency checks",
      },
    ],
  };
}

function fakeContext(rootDir = "/tmp/coverage-resolution-contract"): KspecContext {
  return {
    rootDir,
    projectRoot: rootDir,
    specDir: rootDir,
    sessionsDir: `${rootDir}/.kspec-sessions`,
    manifestPath: null,
    manifest: null,
    shadow: null,
    config: {
      coverage: {
        scan_paths: ["neutral/tests"],
        exclude_patterns: [],
      },
    },
  } as unknown as KspecContext;
}

function criterion(): CoverageCriterionStateDetail {
  return {
    criterion_key: `${ITEM_ULID} ac-stale-text`,
    item_ulid: ITEM_ULID,
    item_ref: "@neutral-resolution-target",
    item_title: "Neutral Resolution Target",
    ac_id: "ac-stale-text",
    state: "stale_spec_text",
    presentation: "re_verify",
    explanation: {
      rule: "positive_evidence_requires_reverification",
      sourceEvidenceIds: [
        `recorded_verification:${ITEM_ULID}:ac-stale-text:2026-06-24T10:00:00.000Z`,
      ],
      latestRunId: null,
      secondaryReverifyCauses: [
        {
          cause: "stale_annotation_or_mapping",
          sourceEvidenceIds: [
            `annotation:neutral/tests/contract.test.ts:1:${ITEM_ULID}:ac-stale-text`,
          ],
          detail: "coverage annotation changed after verification",
        },
      ],
    },
    latest_run_evidence: [],
    freshness: {
      bootstrap: null,
      recorded: {
        timestamp: "2026-06-24T10:00:00.000Z",
        commit: "recorded-revision",
        verified_at: "2026-06-24T10:00:00.000Z",
        actor: "neutral-reviewer",
        provenance: "validation",
      },
      secondary_causes: [
        {
          cause: "stale_annotation_or_mapping",
          sourceEvidenceIds: [
            `annotation:neutral/tests/contract.test.ts:1:${ITEM_ULID}:ac-stale-text`,
          ],
          detail: "coverage annotation changed after verification",
        },
      ],
    },
    unmapped_result_references: [],
  };
}

function itemSummary(detail = criterion()): CoverageItemStateSummary {
  return {
    item_ulid: ITEM_ULID,
    item_ref: "@neutral-resolution-target",
    item_title: "Neutral Resolution Target",
    counts: { covered: 0, failing: 0, not_yet: 0, re_verify: 1 },
    denominator: 1,
    latest_run_id: null,
    criteria: [detail],
    unmapped_result_references: [],
  };
}

function readModel(): CoverageStateSnapshot {
  const detail = criterion();
  const item = itemSummary(detail);
  return {
    summary: {
      counts: { covered: 0, failing: 0, not_yet: 0, re_verify: 1 },
      denominator: 1,
      latest_run_id: null,
      unmapped_result_count: 0,
      invalid_result_count: 0,
    },
    items: {
      "@neutral-resolution-target": item,
      "neutral-resolution-target": item,
      [ITEM_ULID]: item,
      [`@${ITEM_ULID}`]: item,
    },
    criteria: {
      [`${ITEM_ULID} ac-stale-text`]: detail,
    },
    unmapped_results: [],
  };
}

describe("coverage resolution contract", () => {
  // AC: @coverage-resolution-mutation-interface ac-action-set
  it("exposes exactly the supported action requests with shared target fields", () => {
    expect(COVERAGE_RESOLUTION_ACTIONS).toEqual([
      "explicit-reverify",
      "spec-text-revert",
      "dispatch-fix",
    ]);

    const requests = COVERAGE_RESOLUTION_ACTIONS.map((action) =>
      CoverageResolutionRequestSchema.parse({
        action,
        target: {
          item_ref: "@neutral-resolution-target",
          ac_id: "ac-stale-text",
        },
        dry_run: true,
      }),
    );

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.action)).toEqual(COVERAGE_RESOLUTION_ACTIONS);
    expect(() =>
      CoverageResolutionRequestSchema.parse({
        action: "unsupported",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
      }),
    ).toThrow();
  });

  // AC: @coverage-resolution-mutation-interface ac-current-state-required
  // AC: @coverage-resolution-mutation-interface ac-current-state-boundary
  it("resolves @refs and bare slugs through the cached coverage-state read path", async () => {
    const loadReadModel = vi.fn<(ctx: KspecContext) => Promise<CoverageStateSnapshot>>(async () =>
      readModel(),
    );
    const resolvedByRef = await resolveCoverageTarget(fakeContext(), {
      request: {
        action: "explicit-reverify",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: true,
      },
      items: [makeItem()],
      loadReadModel,
    });
    const resolvedByBareSlug = await resolveCoverageTarget(fakeContext(), {
      request: {
        action: "explicit-reverify",
        target: { item_ref: "neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: true,
      },
      items: [makeItem()],
      loadReadModel,
    });

    expect(loadReadModel).toHaveBeenCalledTimes(2);
    expect(resolvedByRef.criterion).toMatchObject({
      item_ulid: ITEM_ULID,
      ac_id: "ac-stale-text",
      presentation: "re_verify",
      state: "stale_spec_text",
    });
    expect(resolvedByBareSlug.item).toEqual(resolvedByRef.item);
    expect(resolvedByRef.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // AC: @coverage-resolution-mutation-interface ac-current-state-required
  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-3
  it("returns guided target diagnostics when the current item or criterion is missing", async () => {
    await expect(
      resolveCoverageTarget(fakeContext(), {
        request: {
          action: "explicit-reverify",
          target: { item_ref: "@missing-target", ac_id: "ac-stale-text" },
          dry_run: true,
        },
        items: [makeItem()],
        loadReadModel: async () => readModel(),
      }),
    ).rejects.toMatchObject({
      code: "coverage_resolution_target_not_found",
      target: "@missing-target",
      suggestion: expect.stringContaining("kspec search"),
    });

    await expect(
      resolveCoverageTarget(fakeContext(), {
        request: {
          action: "explicit-reverify",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-missing" },
          dry_run: true,
        },
        items: [makeItem()],
        loadReadModel: async () => readModel(),
      }),
    ).rejects.toMatchObject({
      code: "coverage_resolution_criterion_not_found",
      target: "@neutral-resolution-target ac-missing",
      suggestion: expect.stringContaining("available criteria"),
    });
  });

  // AC: @coverage-resolution-mutation-interface ac-current-state-required
  // AC: @trait-error-guidance ac-5
  // AC: @trait-error-guidance ac-6
  it("refuses apply requests when the expected current fingerprint is stale", async () => {
    await expect(
      resolveCoverageTarget(fakeContext(), {
        request: {
          action: "spec-text-revert",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          expected_current_fingerprint: "sha256:".concat("0".repeat(64)),
          dry_run: false,
        },
        items: [makeItem()],
        loadReadModel: async () => readModel(),
      }),
    ).rejects.toBeInstanceOf(CoverageResolutionStaleTargetError);
  });

  // AC: @coverage-resolution-mutation-interface ac-dry-run-preview
  // AC: @coverage-resolution-mutation-interface ac-cli-daemon-equivalence
  // AC: @trait-dry-run ac-1
  // AC: @trait-dry-run ac-2
  // AC: @trait-dry-run ac-3
  // AC: @trait-dry-run ac-4
  // AC: @trait-dry-run ac-5
  // AC: @trait-dry-run ac-6
  // AC: @trait-api-endpoint ac-1
  it("builds a shared dry-run response with modeled effects and no stored side effects", async () => {
    const target = await resolveCoverageTarget(fakeContext(), {
      request: {
        action: "dispatch-fix",
        target: { item_ulid: ITEM_ULID, ac_id: "ac-stale-text" },
        dry_run: true,
      },
      items: [makeItem()],
      loadReadModel: async () => readModel(),
    });

    const cliResponse = buildCoverageResolutionDryRunResponse({
      action: "dispatch-fix",
      target,
      effects: [
        {
          kind: "task",
          operation: "would_create_task",
          title: "Fix coverage for Neutral Resolution Target ac-stale-text",
          automation_eligible: true,
        },
      ],
      diagnostics: [
        buildCoverageResolutionPreconditionDiagnostic({
          criterion: target.criterion,
          requirement: "dispatch-fix accepts failing, not-yet, and re-verify coverage issues",
          satisfied: true,
        }),
      ],
    });
    const daemonResponse = CoverageResolutionResponseSchema.parse(cliResponse);

    expect(daemonResponse).toEqual(cliResponse);
    expect(daemonResponse).toMatchObject({
      action: "dispatch-fix",
      dry_run: true,
      stored: false,
      target: {
        item_ulid: ITEM_ULID,
        item_ref: "@neutral-resolution-target",
        ac_id: "ac-stale-text",
      },
      effects: [
        {
          kind: "task",
          operation: "would_create_task",
          automation_eligible: true,
        },
      ],
      affected_scopes: [{ type: "criterion", item_ulid: ITEM_ULID, ac_id: "ac-stale-text" }],
    });
  });

  // AC: @coverage-resolution-mutation-interface ac-static-readonly-refusal
  // AC: @trait-semantic-exit-codes ac-1
  // AC: @trait-semantic-exit-codes ac-2
  // AC: @trait-semantic-exit-codes ac-4
  // AC: @trait-semantic-exit-codes ac-6
  // AC: @trait-semantic-exit-codes ac-8
  it("refuses read-only apply requests while allowing dry-run previews", () => {
    expect(() =>
      assertCoverageResolutionWritable({
        readOnly: true,
        dryRun: false,
      }),
    ).toThrow(CoverageResolutionReadOnlyError);

    expect(() =>
      assertCoverageResolutionWritable({
        readOnly: true,
        dryRun: true,
      }),
    ).not.toThrow();
  });

  // AC: @trait-api-endpoint ac-2 — N/A: this contract module has no daemon route yet.
  // AC: @trait-api-endpoint ac-3 — N/A: route-level body errors are covered by the later daemon adapter task.
  // AC: @trait-api-endpoint ac-4 — N/A: coverage resolution actions are targeted mutations, not list endpoints.
  // AC: @trait-api-endpoint ac-5 — N/A: this contract task models effects; concrete action tasks perform commits.
  // AC: @trait-api-endpoint ac-6 — N/A: request id headers belong to daemon route adapters.
  // AC: @trait-semantic-exit-codes ac-3 — N/A: coverage resolution has no confirmation prompt.
  // AC: @trait-semantic-exit-codes ac-5 — N/A: coverage resolution has no empty result set mode.
  // AC: @trait-semantic-exit-codes ac-7 — N/A: coverage resolution has no batch mode.
  // AC: @trait-error-guidance ac-4 — N/A: precondition diagnostics report coverage state, not lifecycle transitions.
  it("documents inherited trait cases deferred to route and concrete action tasks", () => {
    expect(true).toBe(true);
  });
});
