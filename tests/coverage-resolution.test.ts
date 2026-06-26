import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CoverageCriterionStateDetail,
  CoverageItemStateSummary,
  CoverageStateSnapshot,
} from "@kynetic-ai/shared";
import {
  applyDispatchFixRequest,
  applyExplicitReverification,
  applySpecTextRevert,
  buildCoverageResolutionDryRunResponse,
  CoverageResolutionReadOnlyError,
  CoverageResolutionSpecTextUnavailableError,
  CoverageResolutionStaleTargetError,
  previewSpecTextRevert,
  resolveCoverageTarget,
} from "../src/parser/coverage-resolution.js";
import { invalidateCoverageStateReadModelCache } from "../src/parser/coverage-state-read-model.js";
import { resolveTaskDataManager } from "../src/parser/task-data-manager.js";
import {
  getVerificationRecordPath,
  readVerificationStamp,
  writeVerificationStamp,
} from "../src/parser/verification-record-store.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import {
  COVERAGE_RESOLUTION_ACTIONS,
  CoverageResolutionRequestSchema,
  CoverageResolutionResponseSchema,
  assertCoverageResolutionWritable,
  buildCoverageResolutionPreconditionDiagnostic,
} from "../src/schema/coverage-resolution.js";
import { CURRENT_VERIFICATION_RECORD_FORMAT } from "../src/schema/verification-records.js";
import { initContext } from "../src/parser/yaml.js";
import type { KspecContext, LoadedSpecItem } from "../src/parser/yaml.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";

const ITEM_ULID = testUlid("FEAT", 701);
const SESSION_ID = testUlid("SESS", 701);
const RUN_ID = testUlid("RUNN", 701);
const tempDirs: string[] = [];

ensureSplitBackendRegistered();

afterEach(async () => {
  invalidateCoverageStateReadModelCache();
  while (tempDirs.length > 0) {
    await cleanupTempDir(tempDirs.pop()!);
  }
});

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

function makeAlternateItem(): LoadedSpecItem {
  return {
    ...makeItem(),
    title: "Portable Contract Target",
    slugs: ["portable-contract-target"],
    description: "Second neutral fixture for coverage resolution task text.",
  };
}

function makeItemWithSource(sourceFile: string): LoadedSpecItem {
  return {
    ...makeItem(),
    _sourceFile: sourceFile,
    _path: "features[0]",
    acceptance_criteria: [
      {
        id: "ac-stale-text",
        given: "current given",
        when: "current when",
        then: "current then",
      },
      {
        id: "ac-sibling",
        given: "sibling given",
        when: "sibling when",
        then: "sibling then",
      },
    ],
    notes: [
      {
        content: "preserve item metadata",
        created_at: "2026-06-24T11:00:00.000Z",
        author: "neutral-author",
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
      identity: {
        author: "neutral-operator",
      },
      coverage: {
        scan_paths: ["neutral/tests"],
        exclude_patterns: [],
      },
    },
  } as unknown as KspecContext;
}

function criterion(
  overrides: Partial<
    Omit<CoverageCriterionStateDetail, "explanation" | "freshness" | "latest_run_evidence">
  > & {
    explanation?: Partial<CoverageCriterionStateDetail["explanation"]>;
    freshness?: Partial<CoverageCriterionStateDetail["freshness"]>;
    latest_run_evidence?: CoverageCriterionStateDetail["latest_run_evidence"];
  } = {},
): CoverageCriterionStateDetail {
  const base: CoverageCriterionStateDetail = {
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
          cause: "stale_spec_text",
          sourceEvidenceIds: [
            `annotation:neutral/tests/contract.test.ts:1:${ITEM_ULID}:ac-stale-text`,
          ],
          detail: "criterion text changed after verification",
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
          cause: "stale_spec_text",
          sourceEvidenceIds: [
            `annotation:neutral/tests/contract.test.ts:1:${ITEM_ULID}:ac-stale-text`,
          ],
          detail: "criterion text changed after verification",
        },
      ],
    },
    unmapped_result_references: [],
  };
  return {
    ...base,
    ...overrides,
    explanation: {
      ...base.explanation,
      ...overrides.explanation,
    },
    freshness: {
      ...base.freshness,
      ...overrides.freshness,
    },
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
  return readModelFor(detail);
}

function readModelFor(detail: CoverageCriterionStateDetail): CoverageStateSnapshot {
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
    },
    criteria: {
      [`${ITEM_ULID} ac-stale-text`]: detail,
    },
    unmapped_results: [],
  };
}

function readModelForItem(
  item: LoadedSpecItem,
  detail: CoverageCriterionStateDetail,
): CoverageStateSnapshot {
  const itemRef = `@${item.slugs[0]}`;
  const summary: CoverageItemStateSummary = {
    ...itemSummary(detail),
    item_ref: itemRef,
    item_title: item.title,
    criteria: [{ ...detail, item_ref: itemRef, item_title: item.title }],
  };
  const criterionDetail = summary.criteria[0]!;
  return {
    summary: {
      counts: { covered: 0, failing: 1, not_yet: 0, re_verify: 0 },
      denominator: 1,
      latest_run_id: criterionDetail.explanation.latestRunId,
      unmapped_result_count: 0,
      invalid_result_count: 0,
    },
    items: {
      [itemRef]: summary,
      [item.slugs[0]!]: summary,
    },
    criteria: {
      [`${ITEM_ULID} ac-stale-text`]: criterionDetail,
    },
    unmapped_results: [],
  };
}

function failingCriterion(
  overrides: Partial<
    Omit<CoverageCriterionStateDetail, "explanation" | "freshness" | "latest_run_evidence">
  > & {
    explanation?: Partial<CoverageCriterionStateDetail["explanation"]>;
    freshness?: Partial<CoverageCriterionStateDetail["freshness"]>;
    latest_run_evidence?: CoverageCriterionStateDetail["latest_run_evidence"];
  } = {},
): CoverageCriterionStateDetail {
  const baseExplanation: CoverageCriterionStateDetail["explanation"] = {
    rule: "latest_failed_or_errored_result",
    sourceEvidenceIds: [`test_run:${RUN_ID}:failed-case`],
    latestRunId: RUN_ID,
    secondaryReverifyCauses: [],
  };
  const baseFreshness: CoverageCriterionStateDetail["freshness"] = {
    bootstrap: null,
    recorded: null,
    secondary_causes: [],
  };
  const baseLatestRunEvidence: CoverageCriterionStateDetail["latest_run_evidence"] = [
    {
      run_id: RUN_ID,
      completed_at: "2026-06-24T12:00:00.000Z",
      case_id: "failed-case",
      display_name: "fails current behavior",
      status: "failed",
      producer: { kind: "local", label: "neutral-runner" },
      code_revision: "failing-revision",
    },
  ];
  return criterion({
    state: "failing_result",
    presentation: "failing",
    ...overrides,
    explanation: {
      ...baseExplanation,
      ...overrides.explanation,
    },
    latest_run_evidence: overrides.latest_run_evidence ?? baseLatestRunEvidence,
    freshness: {
      ...baseFreshness,
      ...overrides.freshness,
    },
  });
}

function notYetCriterion(): CoverageCriterionStateDetail {
  return criterion({
    state: "no_positive_evidence",
    presentation: "not_yet",
    explanation: {
      rule: "no_positive_evidence",
      sourceEvidenceIds: [],
      latestRunId: null,
      secondaryReverifyCauses: [],
    },
    freshness: {
      recorded: null,
      secondary_causes: [],
    },
  });
}

function coveredCriterion(): CoverageCriterionStateDetail {
  return criterion({
    state: "covered",
    presentation: "covered",
    explanation: {
      rule: "current_positive_evidence",
      secondaryReverifyCauses: [],
    },
    freshness: {
      secondary_causes: [],
    },
  });
}

async function createTempProject(prefix: string): Promise<string> {
  const tempDir = await createTempDir(prefix);
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeProjectFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

function commit(tempDir: string, message: string, iso: string): string {
  execSync(`git add -A && git commit -m "${message}"`, {
    cwd: tempDir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_DATE: iso,
    },
    stdio: "pipe",
  });
  return execSync("git rev-parse HEAD", {
    cwd: tempDir,
    encoding: "utf-8",
    stdio: "pipe",
  }).trim();
}

async function setupReverifyProject(): Promise<{
  tempDir: string;
  ctx: KspecContext;
  testFile: string;
  initialCommit: string;
  updatedCommit: string;
}> {
  const tempDir = await createTempProject("coverage-reverify-");
  initGitRepo(tempDir);
  await writeProjectFile(
    path.join(tempDir, "kynetic.yaml"),
    [
      'kynetic: "1.1"',
      "project:",
      "  name: Coverage Reverify Fixture",
      "includes:",
      "  - specs/widget.yaml",
      "",
    ].join("\n"),
  );
  await writeProjectFile(
    path.join(tempDir, "kspec.config.yaml"),
    [
      "identity:",
      "  author: neutral-operator",
      "coverage:",
      "  scan_paths:",
      "    - tests",
      "",
    ].join("\n"),
  );
  await writeProjectFile(
    path.join(tempDir, "specs", "widget.yaml"),
    [
      `- _ulid: ${ITEM_ULID}`,
      "  title: Neutral Resolution Target",
      "  slugs: [neutral-resolution-target]",
      "  type: feature",
      "  description: Neutral fixture for explicit re-verification.",
      "  acceptance_criteria:",
      "    - id: ac-stale-text",
      "      given: a neutral target has old text",
      "      when: coverage state is resolved",
      "      then: explicit re-verification can refresh the stamp",
      "",
    ].join("\n"),
  );
  const testFile = path.join(tempDir, "tests", "contract.test.ts");
  await writeProjectFile(
    testFile,
    [
      "// AC: @neutral-resolution-target ac-stale-text",
      "it('covers old behavior', () => {});",
      "",
    ].join("\n"),
  );
  const initialCommit = commit(tempDir, "initial coverage fixture", "2026-06-20T10:00:00.000Z");
  await writeProjectFile(
    path.join(tempDir, "specs", "widget.yaml"),
    [
      `- _ulid: ${ITEM_ULID}`,
      "  title: Neutral Resolution Target",
      "  slugs: [neutral-resolution-target]",
      "  type: feature",
      "  description: Neutral fixture for explicit re-verification.",
      "  acceptance_criteria:",
      "    - id: ac-stale-text",
      "      given: a neutral target has revised text",
      "      when: coverage state is recomputed",
      "      then: explicit re-verification can refresh the current stamp",
      "",
    ].join("\n"),
  );
  const updatedCommit = commit(
    tempDir,
    "update coverage criterion text",
    "2026-06-21T10:00:00.000Z",
  );
  const ctx = await initContext(tempDir, { syncMode: "skip" });
  await writeVerificationStamp(ctx, ITEM_ULID, "ac-stale-text", {
    verified_at: "2026-06-20T10:30:00.000Z",
    actor: "neutral-operator",
    provenance: "validation",
    commit: initialCommit,
  });
  return { tempDir, ctx, testFile, initialCommit, updatedCommit };
}

function specTextComparison() {
  return {
    acId: "ac-stale-text",
    status: "changed" as const,
    current: {
      id: "ac-stale-text",
      given: "current given",
      when: "current when",
      then: "current then",
    },
    previous: {
      id: "ac-stale-text",
      given: "prior given",
      when: "current when",
      then: "prior then",
    },
    changedFields: ["given", "then"] as Array<"given" | "when" | "then">,
    previousCommit: "1234567890abcdef1234567890abcdef12345678",
  };
}

type TestReadComparison = (
  item: LoadedSpecItem,
  acId: string,
  version: { atCommit?: string | null; atTimestamp?: string },
) => Promise<ReturnType<typeof specTextComparison>>;

async function writeSpecTextFixture(tempDir: string): Promise<string> {
  const specFile = path.join(tempDir, "coverage-resolution.yaml");
  await fs.writeFile(
    specFile,
    `features:
  - _ulid: ${ITEM_ULID}
    title: Neutral Resolution Target
    slugs:
      - neutral-resolution-target
    type: feature
    description: Neutral fixture for coverage resolution contract behavior.
    notes:
      - content: preserve item metadata
        created_at: "2026-06-24T11:00:00.000Z"
        author: neutral-author
    acceptance_criteria:
      - id: ac-stale-text
        given: current given
        when: current when
        then: current then
      - id: ac-sibling
        given: sibling given
        when: sibling when
        then: sibling then
`,
  );
  return specFile;
}

async function readFixtureItem(specFile: string) {
  const raw = parseYaml(await readTestOutput(specFile)) as {
    features: Array<{
      acceptance_criteria: Array<{ id: string; given: string; when: string; then: string }>;
      notes?: unknown[];
    }>;
  };
  return raw.features[0];
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
    expect(
      CoverageResolutionRequestSchema.parse({
        action: "explicit-reverify",
        target: { item_ulid: ITEM_ULID, ac_id: "ac-stale-text" },
      }).target,
    ).toEqual({ item_ulid: ITEM_ULID, ac_id: "ac-stale-text" });
    expect(() =>
      CoverageResolutionRequestSchema.parse({
        action: "explicit-reverify",
        target: {
          item_ref: "@wrong-target",
          item_ulid: ITEM_ULID,
          ac_id: "ac-stale-text",
        },
      }),
    ).toThrow("Exactly one of item_ref or item_ulid is required.");
  });

  // AC: @coverage-resolution-mutation-interface ac-current-state-required
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
  it("resolves canonical item ULIDs without accepting conflicting target refs", async () => {
    const resolvedByUlid = await resolveCoverageTarget(fakeContext(), {
      request: {
        action: "explicit-reverify",
        target: { item_ulid: ITEM_ULID, ac_id: "ac-stale-text" },
        dry_run: true,
      },
      items: [makeItem()],
      loadReadModel: async () => readModel(),
    });

    expect(resolvedByUlid.item).toMatchObject({
      item_ulid: ITEM_ULID,
      item_ref: "@neutral-resolution-target",
    });
    await expect(
      resolveCoverageTarget(fakeContext(), {
        request: {
          action: "explicit-reverify",
          target: {
            item_ref: "@wrong-target",
            item_ulid: ITEM_ULID,
            ac_id: "ac-stale-text",
          },
          dry_run: true,
        },
        items: [makeItem()],
        loadReadModel: async () => readModel(),
      }),
    ).rejects.toMatchObject({
      code: "coverage_resolution_ambiguous_target",
      suggestion: expect.stringContaining("either item_ref or item_ulid"),
    });
  });

  // AC: @coverage-resolution-mutation-interface ac-current-state-boundary
  it("uses the production cached coverage-state read model by default", async () => {
    vi.resetModules();
    type ReadModelModule = typeof import("../src/parser/coverage-state-read-model.js");
    const getCachedReadModel = vi.fn<ReadModelModule["getCachedCoverageStateReadModel"]>(async () =>
      readModel(),
    );
    const rawBuilder = vi.fn<ReadModelModule["buildCoverageStateReadModel"]>(() => {
      throw new Error("raw coverage-state builder bypassed the cached read path");
    });
    const freshnessBuilder = vi.fn<
      ReadModelModule["buildCoverageStateReadModelWithFreshnessComparison"]
    >(() => {
      throw new Error("freshness builder bypassed the cached read path");
    });
    const directLoader = vi.fn<ReadModelModule["loadCoverageStateReadModel"]>(() => {
      throw new Error("direct read-model loader bypassed the cached read path");
    });

    vi.doMock("../src/parser/coverage-state-read-model.js", async (importOriginal) => {
      const actual = await importOriginal<ReadModelModule>();
      return {
        ...actual,
        buildCoverageStateReadModel: rawBuilder,
        buildCoverageStateReadModelWithFreshnessComparison: freshnessBuilder,
        loadCoverageStateReadModel: directLoader,
        getCachedCoverageStateReadModel: getCachedReadModel,
      };
    });

    try {
      const { resolveCoverageTarget: resolveWithDefaultReadPath } =
        await import("../src/parser/coverage-resolution.js");

      const resolved = await resolveWithDefaultReadPath(fakeContext(), {
        request: {
          action: "explicit-reverify",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          dry_run: true,
        },
        items: [makeItem()],
      });

      expect(resolved.criterion.state).toBe("stale_spec_text");
      expect(getCachedReadModel).toHaveBeenCalledTimes(1);
      expect(rawBuilder).not.toHaveBeenCalled();
      expect(freshnessBuilder).not.toHaveBeenCalled();
      expect(directLoader).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../src/parser/coverage-state-read-model.js");
      vi.resetModules();
    }
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

  // AC: @coverage-spec-text-revert ac-revert-preconditions
  // AC: @coverage-spec-text-revert ac-revert-preview
  it("previews a stale spec-text revert with exact prior/current field diffs and no file writes", async () => {
    const tempDir = await createTempProject("coverage-spec-text-preview-");
    const specFile = await writeSpecTextFixture(tempDir);
    const before = await readTestOutput(specFile);
    const readComparison = vi.fn<TestReadComparison>(async () => specTextComparison());

    const response = await previewSpecTextRevert(fakeContext(tempDir), {
      request: {
        action: "spec-text-revert",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: true,
      },
      items: [makeItemWithSource(specFile)],
      loadReadModel: async () => readModel(),
      readComparison,
    });

    expect(readComparison).toHaveBeenCalledWith(
      expect.objectContaining({ _ulid: ITEM_ULID }),
      "ac-stale-text",
      { atCommit: "recorded-revision", atTimestamp: "2026-06-24T10:00:00.000Z" },
    );
    expect(await readTestOutput(specFile)).toBe(before);
    expect(response).toMatchObject({
      action: "spec-text-revert",
      dry_run: true,
      stored: false,
      effects: [
        {
          kind: "spec_text",
          operation: "would_edit_fields",
          item_ulid: ITEM_ULID,
          ac_id: "ac-stale-text",
          fields: ["given", "then"],
          prior_commit: "1234567890abcdef1234567890abcdef12345678",
          current_text: {
            given: "current given",
            when: "current when",
            then: "current then",
          },
          prior_text: {
            given: "prior given",
            when: "current when",
            then: "prior then",
          },
          summary: expect.stringContaining("@neutral-resolution-target ac-stale-text"),
        },
        {
          kind: "cache_event",
          operation: "would_invalidate",
          scopes: [{ type: "criterion", item_ulid: ITEM_ULID, ac_id: "ac-stale-text" }],
        },
      ],
      affected_scopes: [{ type: "criterion", item_ulid: ITEM_ULID, ac_id: "ac-stale-text" }],
    });
  });

  // AC: @coverage-spec-text-revert ac-revert-preview
  // AC: @coverage-resolution-mutation-interface ac-static-readonly-refusal
  it("honors dry-run and read-only semantics at the spec-text apply entry point", async () => {
    const tempDir = await createTempProject("coverage-spec-text-apply-dry-run-");
    initGitRepo(tempDir);
    const specFile = await writeSpecTextFixture(tempDir);
    execSync("git add . && git commit -m initial", { cwd: tempDir, stdio: "pipe" });
    const before = await readTestOutput(specFile);

    const response = await applySpecTextRevert(
      {
        ...fakeContext(tempDir),
        shadow: {
          enabled: true,
          worktreeDir: tempDir,
          branchName: "kspec-meta",
          projectRoot: tempDir,
        },
      },
      {
        request: {
          action: "spec-text-revert",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          dry_run: true,
        },
        readOnly: true,
        items: [makeItemWithSource(specFile)],
        loadReadModel: async () => readModel(),
        readComparison: async () => specTextComparison(),
      },
    );

    expect(response).toMatchObject({
      action: "spec-text-revert",
      dry_run: true,
      stored: false,
      effects: [
        {
          kind: "spec_text",
          operation: "would_edit_fields",
        },
        {
          kind: "cache_event",
          operation: "would_invalidate",
        },
      ],
    });
    expect(await readTestOutput(specFile)).toBe(before);
    expect(execSync("git log --oneline", { cwd: tempDir, encoding: "utf-8" }).trim()).toMatch(
      /^[0-9a-f]+ initial$/,
    );

    await expect(
      applySpecTextRevert(fakeContext(tempDir), {
        request: {
          action: "spec-text-revert",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          dry_run: false,
        },
        readOnly: true,
        items: [makeItemWithSource(specFile)],
        loadReadModel: async () => readModel(),
        readComparison: async () => specTextComparison(),
      }),
    ).rejects.toBeInstanceOf(CoverageResolutionReadOnlyError);
  });

  // AC: @coverage-spec-text-revert ac-revert-preconditions
  it("rejects spec-text revert when stale text state or prior comparison is missing", async () => {
    const staleCoveredCriterion: CoverageCriterionStateDetail = {
      ...criterion(),
      state: "covered",
      presentation: "covered",
      explanation: {
        ...criterion().explanation,
        secondaryReverifyCauses: [],
      },
      freshness: {
        ...criterion().freshness,
        secondary_causes: [],
      },
    };
    const coveredItem = itemSummary(staleCoveredCriterion);
    const coveredModel = {
      ...readModel(),
      items: {
        "@neutral-resolution-target": coveredItem,
        "neutral-resolution-target": coveredItem,
      },
      criteria: {
        [`${ITEM_ULID} ac-stale-text`]: staleCoveredCriterion,
      },
    };

    await expect(
      previewSpecTextRevert(fakeContext(), {
        request: {
          action: "spec-text-revert",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          dry_run: true,
        },
        items: [makeItem()],
        loadReadModel: async () => coveredModel,
        readComparison: async () => specTextComparison(),
      }),
    ).rejects.toMatchObject({
      code: "coverage_resolution_spec_text_unavailable",
      suggestion: expect.stringContaining("stale spec text"),
    });

    await expect(
      previewSpecTextRevert(fakeContext(), {
        request: {
          action: "spec-text-revert",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          dry_run: true,
        },
        items: [makeItem()],
        loadReadModel: async () => readModel(),
        readComparison: async () => ({
          ...specTextComparison(),
          status: "unknown" as const,
          previous: null,
          changedFields: [],
          previousCommit: null,
          detail: "prior criterion source could not be read",
        }),
      }),
    ).rejects.toBeInstanceOf(CoverageResolutionSpecTextUnavailableError);
  });

  // AC: @coverage-spec-text-revert ac-content-level-forward-edit
  // AC: @coverage-spec-text-revert ac-sibling-preservation
  it("applies only targeted criterion text through the spec item mutation path and commits forward", async () => {
    const tempDir = await createTempProject("coverage-spec-text-apply-");
    initGitRepo(tempDir);
    const specFile = await writeSpecTextFixture(tempDir);
    const sidecarFile = path.join(tempDir, "coverage-verifications.yaml");
    await fs.writeFile(sidecarFile, "stamps:\n  untouched: true\n");
    execSync("git add . && git commit -m initial", { cwd: tempDir, stdio: "pipe" });
    const sidecarBefore = await readTestOutput(sidecarFile);
    const target = await resolveCoverageTarget(fakeContext(tempDir), {
      request: {
        action: "spec-text-revert",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: true,
      },
      items: [makeItemWithSource(specFile)],
      loadReadModel: async () => readModel(),
    });

    const response = await applySpecTextRevert(
      {
        ...fakeContext(tempDir),
        shadow: {
          enabled: true,
          worktreeDir: tempDir,
          branchName: "kspec-meta",
          projectRoot: tempDir,
        },
      },
      {
        request: {
          action: "spec-text-revert",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          expected_current_fingerprint: target.fingerprint,
          dry_run: false,
        },
        items: [makeItemWithSource(specFile)],
        loadReadModel: async () => readModel(),
        readComparison: async () => specTextComparison(),
      },
    );

    const updated = await readFixtureItem(specFile);
    expect(updated.acceptance_criteria).toEqual([
      {
        id: "ac-stale-text",
        given: "prior given",
        when: "current when",
        then: "prior then",
      },
      {
        id: "ac-sibling",
        given: "sibling given",
        when: "sibling when",
        then: "sibling then",
      },
    ]);
    expect(updated.notes).toEqual([
      {
        content: "preserve item metadata",
        created_at: "2026-06-24T11:00:00.000Z",
        author: "neutral-author",
      },
    ]);
    expect(await readTestOutput(sidecarFile)).toBe(sidecarBefore);
    expect(execSync("git log -1 --format=%s", { cwd: tempDir, encoding: "utf-8" }).trim()).toBe(
      "Update Item AC: @neutral-resolution-target - ac-stale-text spec-text-revert",
    );
    expect(response).toMatchObject({
      action: "spec-text-revert",
      dry_run: false,
      stored: true,
      effects: [
        {
          kind: "spec_text",
          operation: "edited_fields",
          item_ulid: ITEM_ULID,
          ac_id: "ac-stale-text",
          fields: ["given", "then"],
          summary: expect.stringContaining("Neutral Resolution Target"),
        },
        {
          kind: "cache_event",
          operation: "invalidated",
          scopes: [{ type: "criterion", item_ulid: ITEM_ULID, ac_id: "ac-stale-text" }],
        },
      ],
    });
  });

  // AC: @coverage-spec-text-revert ac-concurrency-guard
  it("refuses apply when the preview fingerprint no longer matches current criterion text", async () => {
    await expect(
      applySpecTextRevert(fakeContext(), {
        request: {
          action: "spec-text-revert",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          expected_current_fingerprint: "sha256:".concat("0".repeat(64)),
          dry_run: false,
        },
        items: [makeItem()],
        loadReadModel: async () => readModel(),
        readComparison: async () => specTextComparison(),
      }),
    ).rejects.toMatchObject({
      suggestion: expect.stringContaining("Refresh the coverage detail"),
    });
  });

  // AC: @coverage-spec-text-revert ac-concurrency-guard
  it("refuses apply when criterion text changes after planning but before the locked mutation", async () => {
    const tempDir = await createTempProject("coverage-spec-text-race-");
    initGitRepo(tempDir);
    const specFile = await writeSpecTextFixture(tempDir);
    execSync("git add . && git commit -m initial", { cwd: tempDir, stdio: "pipe" });
    const target = await resolveCoverageTarget(fakeContext(tempDir), {
      request: {
        action: "spec-text-revert",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: true,
      },
      items: [makeItemWithSource(specFile)],
      loadReadModel: async () => readModel(),
    });

    await expect(
      applySpecTextRevert(
        {
          ...fakeContext(tempDir),
          shadow: {
            enabled: true,
            worktreeDir: tempDir,
            branchName: "kspec-meta",
            projectRoot: tempDir,
          },
        },
        {
          request: {
            action: "spec-text-revert",
            target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
            expected_current_fingerprint: target.fingerprint,
            dry_run: false,
          },
          items: [makeItemWithSource(specFile)],
          loadReadModel: async () => readModel(),
          readComparison: async () => {
            const concurrent = (await readTestOutput(specFile)).replace(
              "given: current given",
              "given: concurrent given",
            );
            await fs.writeFile(specFile, concurrent, "utf-8");
            return specTextComparison();
          },
        },
      ),
    ).rejects.toBeInstanceOf(CoverageResolutionStaleTargetError);

    const updated = await readFixtureItem(specFile);
    expect(updated.acceptance_criteria[0]).toEqual({
      id: "ac-stale-text",
      given: "concurrent given",
      when: "current when",
      then: "current then",
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

  // AC: @explicit-coverage-reverification ac-reverify-preconditions
  // AC: @explicit-coverage-reverification ac-reverify-stamp-written
  it("accepts current re-verify criteria and writes or replaces a re-verification stamp", async () => {
    const tempDir = await createTempProject("coverage-resolution-write-");
    const ctx = fakeContext(tempDir);
    const loadReadModel = vi.fn<(ctx: KspecContext) => Promise<CoverageStateSnapshot>>(async () =>
      readModel(),
    );

    const first = await applyExplicitReverification(
      ctx,
      {
        action: "explicit-reverify",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        actor: "neutral-operator",
        commit: { commit: "request-revision", branch: null, remote_url: null },
        session_id: SESSION_ID,
      },
      {
        items: [makeItem()],
        loadReadModel,
        now: () => "2026-06-25T12:00:00.000Z",
      },
    );

    expect(first).toMatchObject({
      action: "explicit-reverify",
      dry_run: false,
      stored: true,
      effects: [
        {
          kind: "verification_stamp",
          operation: "wrote_stamp",
          provenance: "re_verification",
          actor: "neutral-operator",
          verified_at: "2026-06-25T12:00:00.000Z",
          commit: "request-revision",
          session_id: SESSION_ID,
        },
        {
          kind: "cache_event",
          operation: "invalidated",
        },
      ],
    });
    expect(loadReadModel).toHaveBeenCalledTimes(2);
    await expect(readVerificationStamp(ctx, ITEM_ULID, "ac-stale-text")).resolves.toMatchObject({
      verified_at: "2026-06-25T12:00:00.000Z",
      actor: "neutral-operator",
      provenance: "re_verification",
      commit: "request-revision",
      session: SESSION_ID,
    });

    await applyExplicitReverification(
      ctx,
      {
        action: "explicit-reverify",
        target: { item_ulid: ITEM_ULID, ac_id: "ac-stale-text" },
        dry_run: false,
        actor: "neutral-operator",
      },
      {
        items: [makeItem()],
        loadReadModel,
        now: () => "2026-06-26T12:00:00.000Z",
      },
    );

    await expect(readVerificationStamp(ctx, ITEM_ULID, "ac-stale-text")).resolves.toMatchObject({
      verified_at: "2026-06-26T12:00:00.000Z",
      actor: "neutral-operator",
      provenance: "re_verification",
      commit: "recorded-revision",
    });
    expect(await readVerificationStamp(ctx, ITEM_ULID, "ac-stale-text")).not.toHaveProperty(
      "session",
    );
  });

  // AC: @explicit-coverage-reverification ac-reverify-preconditions
  it("rejects covered, not-yet, and failing criteria with guided precondition diagnostics", async () => {
    const tempDir = await createTempProject("coverage-resolution-reject-");
    const ctx = fakeContext(tempDir);

    const failing = await applyExplicitReverification(
      ctx,
      {
        action: "explicit-reverify",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        actor: "neutral-operator",
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(failingCriterion()),
        now: () => "2026-06-25T12:00:00.000Z",
      },
    );
    const notYet = await applyExplicitReverification(
      ctx,
      {
        action: "explicit-reverify",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        actor: "neutral-operator",
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(notYetCriterion()),
        now: () => "2026-06-25T12:00:00.000Z",
      },
    );
    const covered = await applyExplicitReverification(
      ctx,
      {
        action: "explicit-reverify",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        actor: "neutral-operator",
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(coveredCriterion()),
        now: () => "2026-06-25T12:00:00.000Z",
      },
    );

    expect(failing).toMatchObject({
      stored: false,
      diagnostics: [
        {
          satisfied: false,
          current_presentation: "failing",
          suggestion: expect.stringContaining("Fix failing tests"),
        },
      ],
      effects: [],
    });
    expect(notYet).toMatchObject({
      stored: false,
      diagnostics: [
        {
          satisfied: false,
          current_presentation: "not_yet",
          suggestion: expect.stringContaining("Add coverage evidence"),
        },
      ],
      effects: [],
    });
    expect(covered).toMatchObject({
      stored: false,
      diagnostics: [
        {
          satisfied: false,
          current_presentation: "covered",
          suggestion: expect.stringContaining("Refresh the coverage detail"),
        },
      ],
      effects: [],
    });
    expect(existsSync(getVerificationRecordPath(ctx, ITEM_ULID))).toBe(false);
  });

  // AC: @explicit-coverage-reverification ac-reverify-stamp-written
  it("propagates verification record format refusal without replacing stored records", async () => {
    const tempDir = await createTempProject("coverage-resolution-format-");
    const ctx = fakeContext(tempDir);
    const recordPath = getVerificationRecordPath(ctx, ITEM_ULID);
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(
      recordPath,
      [
        `format: ${CURRENT_VERIFICATION_RECORD_FORMAT + 1}`,
        "acs:",
        "  ac-stale-text:",
        "    verified_at: 2026-06-24T10:00:00.000Z",
        "    actor: neutral-operator",
        "    provenance: validation",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(
      applyExplicitReverification(
        ctx,
        {
          action: "explicit-reverify",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          dry_run: false,
          actor: "neutral-operator",
        },
        {
          items: [makeItem()],
          loadReadModel: async () => readModel(),
          now: () => "2026-06-25T12:00:00.000Z",
        },
      ),
    ).rejects.toMatchObject({
      code: "verification_record_format_newer_than_supported",
      declaredVersion: CURRENT_VERIFICATION_RECORD_FORMAT + 1,
      maxSupportedVersion: CURRENT_VERIFICATION_RECORD_FORMAT,
    });
  });

  // AC: @explicit-coverage-reverification ac-reverify-state-clears-when-current
  it("invalidates and recomputes coverage state so a current stamp clears the stale cause", async () => {
    const tempDir = await createTempProject("coverage-resolution-recompute-");
    const ctx = fakeContext(tempDir);
    const loadReadModel = vi.fn<(ctx: KspecContext) => Promise<CoverageStateSnapshot>>();
    loadReadModel
      .mockResolvedValueOnce(readModelFor(criterion()))
      .mockResolvedValueOnce(readModelFor(coveredCriterion()));

    const response = await applyExplicitReverification(
      ctx,
      {
        action: "explicit-reverify",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        actor: "neutral-operator",
      },
      {
        items: [makeItem()],
        loadReadModel,
        now: () => "2026-06-22T10:00:00.000Z",
      },
    );

    expect(loadReadModel).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({
      stored: true,
      current: {
        presentation: "covered",
        state: "covered",
      },
      effects: [
        {
          kind: "verification_stamp",
          operation: "wrote_stamp",
          commit: "recorded-revision",
        },
        {
          kind: "cache_event",
          operation: "invalidated",
        },
      ],
    });
    await expect(readVerificationStamp(ctx, ITEM_ULID, "ac-stale-text")).resolves.toMatchObject({
      provenance: "re_verification",
      verified_at: "2026-06-22T10:00:00.000Z",
    });
  });

  // AC: @explicit-coverage-reverification ac-reverify-no-test-execution
  it("writes only verification metadata and does not materialize test-run storage", async () => {
    const { ctx, tempDir, testFile, initialCommit } = await setupReverifyProject();

    await applyExplicitReverification(
      ctx,
      {
        action: "explicit-reverify",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        actor: "neutral-operator",
        commit: { commit: "manual-review-commit" },
      },
      {
        now: () => "2026-06-22T10:00:00.000Z",
      },
    );

    await expect(readVerificationStamp(ctx, ITEM_ULID, "ac-stale-text")).resolves.toMatchObject({
      provenance: "re_verification",
      commit: "manual-review-commit",
    });
    expect(existsSync(path.join(ctx.specDir, "coverage", "test-runs"))).toBe(false);
    expect(
      execSync("git status --short -- tests/contract.test.ts", { cwd: tempDir }).toString(),
    ).toBe("");
    expect(
      execSync(`git log --format=%H -- ${path.relative(tempDir, testFile)}`, {
        cwd: tempDir,
      })
        .toString()
        .trim()
        .split("\n"),
    ).toContain(initialCommit);
  });

  // AC: @coverage-dispatch-fix-request ac-dispatch-fix-task-shape
  it("creates ordinary tasks for failing, not-yet, and re-verify coverage issues", async () => {
    const tempDir = await createTempProject("coverage-dispatch-fix-create-");
    const ctx = fakeContext(tempDir);
    const details = [failingCriterion(), notYetCriterion(), criterion()];

    for (const detail of details) {
      const response = await applyDispatchFixRequest(
        ctx,
        {
          action: "dispatch-fix",
          target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
          dry_run: false,
          automation_eligible: false,
          allow_duplicate: true,
          allow_covered: false,
        },
        {
          items: [makeItem()],
          loadReadModel: async () => readModelFor(detail),
        },
      );

      expect(response).toMatchObject({
        action: "dispatch-fix",
        dry_run: false,
        stored: true,
        target: {
          item_ref: "@neutral-resolution-target",
          ac_id: "ac-stale-text",
        },
        current: {
          presentation: detail.presentation,
          state: detail.state,
          latest_run_id: detail.explanation.latestRunId,
        },
        effects: [
          {
            kind: "task",
            operation: "created_task",
            automation_eligible: false,
            idempotency_key: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          },
          {
            kind: "cache_event",
            operation: "invalidated",
          },
        ],
      });
    }

    const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task).toMatchObject({
        type: "task",
        status: "pending",
        spec_ref: "@neutral-resolution-target",
        tags: expect.arrayContaining(["coverage", "dispatch-fix"]),
      });
      expect(task.description).toContain("Coverage-Resolution-Key: sha256:");
      expect(task.description).toContain(
        "Item: @neutral-resolution-target — Neutral Resolution Target",
      );
      expect(task.description).toContain("Acceptance Criterion: ac-stale-text");
      expect(task.description).toContain("Presentation Bucket:");
      expect(task.description).toContain("Machine-Readable Explanation:");
      expect(task.description).toContain("Suggested Repair Checklist");
    }
  });

  // AC: @coverage-dispatch-fix-request ac-dispatch-fix-task-shape
  it("rejects covered criteria by default without creating a task", async () => {
    const tempDir = await createTempProject("coverage-dispatch-fix-covered-");
    const ctx = fakeContext(tempDir);

    const response = await applyDispatchFixRequest(
      ctx,
      {
        action: "dispatch-fix",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        automation_eligible: false,
        allow_duplicate: false,
        allow_covered: false,
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(coveredCriterion()),
      },
    );

    expect(response).toMatchObject({
      stored: false,
      diagnostics: [
        {
          satisfied: false,
          current_presentation: "covered",
          suggestion: expect.stringContaining("already covered"),
        },
      ],
      effects: [],
    });
    await expect(resolveTaskDataManager(ctx).loadAllTasks(ctx)).resolves.toEqual([]);
  });

  // AC: @coverage-dispatch-fix-request ac-dispatch-fix-task-shape
  it("creates a task for a covered criterion when explicitly allowed", async () => {
    const tempDir = await createTempProject("coverage-dispatch-fix-covered-allowed-");
    const ctx = fakeContext(tempDir);

    const response = await applyDispatchFixRequest(
      ctx,
      {
        action: "dispatch-fix",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        automation_eligible: false,
        allow_duplicate: false,
        allow_covered: true,
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(coveredCriterion()),
      },
    );

    expect(response).toMatchObject({
      stored: true,
      current: {
        presentation: "covered",
        state: "covered",
      },
      diagnostics: [
        {
          satisfied: true,
          current_presentation: "covered",
          suggestion: expect.stringContaining("explicitly requested"),
        },
      ],
      effects: [
        {
          kind: "task",
          operation: "created_task",
        },
        {
          kind: "cache_event",
          operation: "invalidated",
        },
      ],
    });
    const [task] = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
    expect(task?.description).toContain("Presentation Bucket: covered");
  });

  // AC: @coverage-dispatch-fix-request ac-idempotent-open-request
  it("reuses unresolved tasks by body idempotency key unless duplicates are allowed", async () => {
    const tempDir = await createTempProject("coverage-dispatch-fix-idempotent-");
    const ctx = fakeContext(tempDir);
    const request = {
      action: "dispatch-fix" as const,
      target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
      dry_run: false,
      automation_eligible: false,
      allow_duplicate: false,
      allow_covered: false,
    };

    const first = await applyDispatchFixRequest(ctx, request, {
      items: [makeItem()],
      loadReadModel: async () => readModelFor(failingCriterion()),
    });
    const repeated = await applyDispatchFixRequest(ctx, request, {
      items: [makeItem()],
      loadReadModel: async () => readModelFor(failingCriterion()),
    });

    expect(repeated.effects[0]).toMatchObject({
      kind: "task",
      operation: "reused_task",
      task_ref: first.effects[0]?.kind === "task" ? first.effects[0].task_ref : undefined,
      idempotency_key: first.effects[0]?.kind === "task" ? first.effects[0].idempotency_key : "",
    });
    await expect(resolveTaskDataManager(ctx).loadAllTasks(ctx)).resolves.toHaveLength(1);

    await applyDispatchFixRequest(
      ctx,
      {
        ...request,
        allow_duplicate: true,
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(failingCriterion()),
      },
    );
    await expect(resolveTaskDataManager(ctx).loadAllTasks(ctx)).resolves.toHaveLength(2);

    await applyDispatchFixRequest(ctx, request, {
      items: [makeItem()],
      loadReadModel: async () =>
        readModelFor(
          failingCriterion({
            explanation: {
              sourceEvidenceIds: [`test_run:${RUN_ID}:different-failure`],
              latestRunId: "different-run",
            },
          }),
        ),
    });
    await expect(resolveTaskDataManager(ctx).loadAllTasks(ctx)).resolves.toHaveLength(3);
  });

  // AC: @coverage-dispatch-fix-request ac-project-neutral-context
  it("generates neutral task bodies from normalized coverage evidence in different projects", async () => {
    const projectA = await createTempProject("coverage-dispatch-fix-neutral-a-");
    const projectB = await createTempProject("coverage-dispatch-fix-neutral-b-");
    const firstCtx = fakeContext(projectA);
    const secondCtx = fakeContext(projectB);
    const alternateItem = makeAlternateItem();

    await applyDispatchFixRequest(
      firstCtx,
      {
        action: "dispatch-fix",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        automation_eligible: false,
        allow_duplicate: false,
        allow_covered: false,
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(failingCriterion()),
      },
    );
    await applyDispatchFixRequest(
      secondCtx,
      {
        action: "dispatch-fix",
        target: { item_ref: "@portable-contract-target", ac_id: "ac-stale-text" },
        dry_run: false,
        automation_eligible: false,
        allow_duplicate: false,
        allow_covered: false,
      },
      {
        items: [alternateItem],
        loadReadModel: async () =>
          readModelForItem(
            alternateItem,
            failingCriterion({
              latest_run_evidence: [
                {
                  run_id: RUN_ID,
                  completed_at: "2026-06-24T12:00:00.000Z",
                  case_id: "portable-case",
                  display_name: "portable failing behavior",
                  status: "failed",
                  producer: { kind: "external", label: "portable-result-producer" },
                  code_revision: null,
                },
              ],
            }),
          ),
      },
    );

    const bodies = [
      (await resolveTaskDataManager(firstCtx).loadAllTasks(firstCtx))[0]?.description ?? "",
      (await resolveTaskDataManager(secondCtx).loadAllTasks(secondCtx))[0]?.description ?? "",
    ];

    expect(bodies[0]).toContain("neutral-runner");
    expect(bodies[1]).toContain("portable-result-producer");
    for (const body of bodies) {
      expect(body).toContain("Coverage-Resolution-Key: sha256:");
      expect(body).toContain("Latest Run Evidence:");
      expect(body).not.toContain("/home/chapel/Projects/kynetic-spec");
      expect(body).not.toContain("npm test");
      expect(body).not.toContain("Vitest");
      expect(body).not.toContain("feat/ui-redesign");
    }
  });

  // AC: @coverage-dispatch-fix-request ac-no-special-queue
  // AC: @coverage-dispatch-fix-request ac-existing-dispatch-policy
  it("uses normal task automation fields without a special queue or agent invocation", async () => {
    const tempDir = await createTempProject("coverage-dispatch-fix-automation-");
    const ctx = fakeContext(tempDir);

    const response = await applyDispatchFixRequest(
      ctx,
      {
        action: "dispatch-fix",
        target: { item_ref: "@neutral-resolution-target", ac_id: "ac-stale-text" },
        dry_run: false,
        automation_eligible: true,
        allow_duplicate: false,
        allow_covered: false,
      },
      {
        items: [makeItem()],
        loadReadModel: async () => readModelFor(notYetCriterion()),
      },
    );

    const [task] = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
    expect(task).toMatchObject({
      status: "pending",
      spec_ref: "@neutral-resolution-target",
      automation: "eligible",
    });
    expect(response.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task",
          operation: "created_task",
          automation_eligible: true,
        }),
      ]),
    );
    expect(task?.description).toContain("Existing Dispatch Policy:");
    expect(task?.description).not.toContain("agent_id:");
    expect(task?.description).not.toContain("queue:");
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
