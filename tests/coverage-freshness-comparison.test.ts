import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildCoverageEvidenceIndex,
  compareCoverageFreshness,
  deriveCoverageStateWithFreshnessComparison,
  readCriterionFreshnessComparison,
} from "../src/parser/index.js";
import { CURRENT_TEST_RESULT_RUN_RECORD_FORMAT } from "../src/schema/test-result-runs.js";
import type { CoverageEvidenceEntry } from "../src/parser/coverage-evidence-index.js";
import type { LoadedSpecItem } from "../src/parser/yaml.js";
import type { TestResultRunRecord } from "../src/schema/test-result-runs.js";
import { cleanupTempDir, createTempDir, initGitRepo, testUlid } from "./helpers/cli.js";
import { initContext, loadAllItems, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";

const ITEM_ULID = testUlid("FRESH", 41);
const RUN_OLD = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const RUN_NEW = "01CRZ3NDEKTSV4RRFFQ69G5FAV";

interface TestEnv {
  tempDir: string;
  specDir: string;
  specFile: string;
  testFile: string;
}

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function commitRepoPath(repo: string, relPath: string, iso: string): Promise<string> {
  const dateEnv = { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  git(repo, ["add", relPath], dateEnv);
  git(repo, ["commit", "-m", `update ${relPath}`], dateEnv);
  return git(repo, ["rev-parse", "HEAD"]);
}

async function commitPath(env: TestEnv, relPath: string, iso: string): Promise<string> {
  return commitRepoPath(env.tempDir, relPath, iso);
}

function ac(id: string, text = id) {
  return {
    id,
    given: `given ${text}`,
    when: `when ${text}`,
    then: `then ${text}`,
  };
}

async function writeSpec(env: TestEnv, criteria: ReturnType<typeof ac>[]): Promise<void> {
  await writeYamlFilePreserveFormat(env.specFile, [
    {
      _ulid: ITEM_ULID,
      title: "Neutral Freshness Feature",
      slugs: ["neutral-freshness"],
      type: "feature",
      description: "Neutral fixture for coverage freshness comparison.",
      acceptance_criteria: criteria,
    },
  ]);
}

async function setupProject(criteria = [ac("ac-one"), ac("ac-two")]): Promise<TestEnv> {
  const tempDir = await createTempDir("kspec-coverage-freshness-");
  initGitRepo(tempDir);
  const specDir = path.join(tempDir, "spec");
  const specFile = path.join(specDir, "modules", "specs.yaml");
  const testFile = path.join(tempDir, "tests", "coverage.test.ts");
  await fs.mkdir(path.dirname(specFile), { recursive: true });
  await fs.mkdir(path.dirname(testFile), { recursive: true });
  await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
    project: { name: "coverage-freshness-test" },
    includes: ["modules/specs.yaml"],
  });
  await writeSpec({ tempDir, specDir, specFile, testFile }, criteria);
  return { tempDir, specDir, specFile, testFile };
}

async function loadItem(env: TestEnv): Promise<LoadedSpecItem> {
  const ctx = await initContext(env.tempDir, { syncMode: "skip" });
  const item = (await loadAllItems(ctx)).find((candidate) => candidate._ulid === ITEM_ULID);
  if (!item) throw new Error("missing loaded item");
  return item;
}

function runRecord(options: {
  id?: string;
  completedAt: string;
  codeRevision?: string | null;
  location?: { file: string; line?: number } | null;
  status?: "passed" | "failed" | "errored" | "skipped" | "unknown";
}): TestResultRunRecord {
  const id = options.id ?? RUN_NEW;
  const status = options.status ?? "passed";
  return {
    format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    run: {
      id,
      completed_at: options.completedAt,
    },
    producer: {
      kind: "local",
      label: "neutral-runner",
      command: "neutral test command",
      code_revision: options.codeRevision ?? null,
    },
    cases: [
      {
        id: "case-one",
        display_name: "neutral case",
        status,
        ...(options.location !== undefined ? { location: options.location } : {}),
        refs: [{ item_ref: "@neutral-freshness", ac_id: "ac-one" }],
      },
    ],
    mapping: {
      attributed: [
        {
          case_id: "case-one",
          item_ulid: ITEM_ULID,
          item_ref: "@neutral-freshness",
          ac_id: "ac-one",
          status,
        },
      ],
      unmapped: [],
      invalid: [],
    },
    verification_effects: {
      stamps_written: [],
      non_positive_mapped_cases: [],
    },
  };
}

function entryByAc(
  items: LoadedSpecItem[],
  acId: string,
  options: {
    recorded?: { timestamp: string; commit: string | null };
    bootstrap?: { timestamp: string | null; commit: string | null };
    testRuns?: TestResultRunRecord[];
    annotationLine?: number;
  } = {},
): CoverageEvidenceEntry {
  const index = buildCoverageEvidenceIndex({
    items,
    annotations:
      options.annotationLine !== undefined
        ? [
            {
              specRef: "@neutral-freshness",
              acIds: [acId],
              malformedTokens: [],
              file: "tests/coverage.test.ts",
              line: options.annotationLine,
            },
          ]
        : [],
    freshness:
      options.recorded || options.bootstrap
        ? [
            {
              itemUlid: ITEM_ULID,
              acId,
              recorded: options.recorded
                ? {
                    source: "recorded",
                    timestamp: options.recorded.timestamp,
                    commit: options.recorded.commit,
                    stamp: {
                      verified_at: options.recorded.timestamp,
                      actor: "reviewer",
                      provenance: "validation",
                      ...(options.recorded.commit ? { commit: options.recorded.commit } : {}),
                    },
                  }
                : null,
              bootstrap: options.bootstrap
                ? {
                    source: "bootstrap",
                    timestamp: options.bootstrap.timestamp,
                    commit: options.bootstrap.commit,
                  }
                : null,
            },
          ]
        : [],
    testRuns: options.testRuns ?? [],
  });
  const entry = index.entriesByCriterion[`${ITEM_ULID} ${acId}`];
  if (!entry) throw new Error(`missing entry for ${acId}`);
  return entry;
}

describe("coverage freshness comparison", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupProject();
  });

  afterEach(async () => {
    await cleanupTempDir(env.tempDir);
  });

  // AC: @coverage-freshness-revision-comparison ac-ac-text-change-detected
  // AC: @coverage-freshness-revision-comparison ac-sibling-ac-unchanged
  it("marks only the changed AC stale when sibling criteria share the same spec file", async () => {
    const initialCommit = await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await writeSpec(env, [ac("ac-one", "changed"), ac("ac-two")]);
    await commitPath(env, "spec/modules/specs.yaml", "2026-06-03T00:00:00.000Z");
    const item = await loadItem(env);
    const items = [item];

    const changed = await deriveCoverageStateWithFreshnessComparison(
      entryByAc(items, "ac-one", {
        recorded: { timestamp: "2026-06-02T00:00:00.000Z", commit: initialCommit },
      }),
      { item, projectRoot: env.tempDir },
    );
    const sibling = await deriveCoverageStateWithFreshnessComparison(
      entryByAc(items, "ac-two", {
        recorded: { timestamp: "2026-06-02T00:00:00.000Z", commit: initialCommit },
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(changed.state).toBe("stale_spec_text");
    expect(changed.presentation).toBe("re_verify");
    expect(sibling.state).toBe("covered");
  });

  // AC: @coverage-freshness-revision-comparison ac-ac-text-change-detected
  it("marks annotation-only positive evidence stale when criterion text changed after bootstrap freshness", async () => {
    await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    const annotationCommit = await commitPath(
      env,
      "tests/coverage.test.ts",
      "2026-06-02T00:00:00.000Z",
    );
    await writeSpec(env, [ac("ac-one", "changed"), ac("ac-two")]);
    await commitPath(env, "spec/modules/specs.yaml", "2026-06-03T00:00:00.000Z");
    const item = await loadItem(env);

    const state = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        annotationLine: 1,
        bootstrap: { timestamp: "2026-06-02T00:00:00.000Z", commit: annotationCommit },
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(state.state).toBe("stale_spec_text");
    expect(state.presentation).toBe("re_verify");
    expect(state.explanation.sourceEvidenceIds).toEqual([
      `annotation:tests/coverage.test.ts:1:${ITEM_ULID}:ac-one`,
    ]);
  });

  // AC: @coverage-freshness-revision-comparison ac-per-ac-diff-read
  it("returns focused prior/current text comparison for one stale criterion", async () => {
    await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await writeSpec(env, [ac("ac-one", "changed"), ac("ac-two")]);
    await commitPath(env, "spec/modules/specs.yaml", "2026-06-03T00:00:00.000Z");
    const item = await loadItem(env);

    const comparison = await readCriterionFreshnessComparison(item, "ac-one", {
      atTimestamp: "2026-06-02T00:00:00.000Z",
    });

    expect(comparison.status).toBe("changed");
    expect(comparison.acId).toBe("ac-one");
    expect(comparison.changedFields).toEqual(["given", "when", "then"]);
    expect(comparison.current?.given).toBe("given changed");
    expect(comparison.previous?.given).toBe("given ac-one");
  });

  // AC: @coverage-freshness-revision-comparison ac-annotation-change-detected
  it("marks recorded verification stale when annotation freshness is newer", async () => {
    const initialCommit = await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    const annotationCommit = await commitPath(
      env,
      "tests/coverage.test.ts",
      "2026-06-03T00:00:00.000Z",
    );
    const item = await loadItem(env);

    const state = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        annotationLine: 1,
        recorded: { timestamp: "2026-06-02T00:00:00.000Z", commit: initialCommit },
        bootstrap: { timestamp: "2026-06-03T00:00:00.000Z", commit: annotationCommit },
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(state.state).toBe("stale_annotation_or_mapping");
    expect(state.presentation).toBe("re_verify");
  });

  // AC: @coverage-freshness-revision-comparison ac-annotation-change-detected
  it("lets newer passing evidence clear an older recorded annotation stale cause", async () => {
    const initialCommit = await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    const sourceCommit = await commitPath(
      env,
      "tests/coverage.test.ts",
      "2026-06-04T00:00:00.000Z",
    );
    const item = await loadItem(env);

    const state = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        annotationLine: 1,
        recorded: { timestamp: "2026-06-02T00:00:00.000Z", commit: initialCommit },
        bootstrap: { timestamp: "2026-06-03T00:00:00.000Z", commit: sourceCommit },
        testRuns: [
          runRecord({
            id: RUN_NEW,
            completedAt: "2026-06-05T00:00:00.000Z",
            codeRevision: sourceCommit,
            location: { file: "tests/coverage.test.ts", line: 2 },
          }),
        ],
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(state.state).toBe("covered");
    expect(state.presentation).toBe("covered");
  });

  // AC: @coverage-freshness-revision-comparison ac-test-result-code-revision-compared
  it("reports stale test-result evidence when the normalized case location changed after the run revision", async () => {
    await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    const runRevision = await commitPath(env, "tests/coverage.test.ts", "2026-06-02T00:00:00.000Z");
    await fs.writeFile(
      env.testFile,
      `// AC: @neutral-freshness ac-one\nit("covers changed", () => {});\n`,
    );
    await commitPath(env, "tests/coverage.test.ts", "2026-06-03T00:00:00.000Z");
    const item = await loadItem(env);

    const state = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        testRuns: [
          runRecord({
            completedAt: "2026-06-02T00:30:00.000Z",
            codeRevision: runRevision,
            location: { file: "tests/coverage.test.ts", line: 2 },
          }),
        ],
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(state.state).toBe("stale_test_result");
    expect(state.explanation.secondaryReverifyCauses).toEqual([]);
  });

  // AC: @coverage-freshness-revision-comparison ac-test-result-code-revision-compared
  // AC: @coverage-freshness-revision-comparison ac-unknown-comparison-degrades-to-reverify
  it("uses run timestamp instead of project code revision when comparing shadow spec text", async () => {
    initGitRepo(env.specDir);
    await commitRepoPath(env.specDir, "kynetic.yaml", "2026-06-01T00:00:00.000Z");
    await commitRepoPath(env.specDir, "modules/specs.yaml", "2026-06-01T00:01:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    const projectRevision = await commitPath(
      env,
      "tests/coverage.test.ts",
      "2026-06-02T00:00:00.000Z",
    );
    const item = await loadItem(env);

    const state = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        testRuns: [
          runRecord({
            completedAt: "2026-06-02T00:30:00.000Z",
            codeRevision: projectRevision,
            location: { file: "tests/coverage.test.ts", line: 2 },
          }),
        ],
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(state.state).toBe("covered");
    expect(state.presentation).toBe("covered");
  });

  // AC: @coverage-freshness-revision-comparison ac-ac-text-change-detected
  // AC: @coverage-freshness-revision-comparison ac-unknown-comparison-degrades-to-reverify
  it("uses recorded and bootstrap timestamps instead of project code revisions when comparing shadow spec text", async () => {
    initGitRepo(env.specDir);
    await commitRepoPath(env.specDir, "kynetic.yaml", "2026-06-01T00:00:00.000Z");
    await commitRepoPath(env.specDir, "modules/specs.yaml", "2026-06-01T00:01:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    const projectRevision = await commitPath(
      env,
      "tests/coverage.test.ts",
      "2026-06-02T00:00:00.000Z",
    );
    const item = await loadItem(env);

    const recorded = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        recorded: { timestamp: "2026-06-02T00:30:00.000Z", commit: projectRevision },
      }),
      { item, projectRoot: env.tempDir },
    );
    const bootstrap = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        annotationLine: 1,
        bootstrap: { timestamp: "2026-06-02T00:30:00.000Z", commit: projectRevision },
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(recorded.state).toBe("covered");
    expect(recorded.presentation).toBe("covered");
    expect(bootstrap.state).toBe("covered");
    expect(bootstrap.presentation).toBe("covered");
  });

  // AC: @coverage-freshness-revision-comparison ac-test-result-code-revision-compared
  // AC: @coverage-freshness-revision-comparison ac-unknown-comparison-degrades-to-reverify
  it("reports unknown freshness when source revisions are diverged rather than comparable", async () => {
    await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    await commitPath(env, "tests/coverage.test.ts", "2026-06-02T00:00:00.000Z");
    const mainBranch = git(env.tempDir, ["branch", "--show-current"]);
    git(env.tempDir, ["checkout", "-b", "run-side-branch"]);
    await fs.writeFile(path.join(env.tempDir, "side.txt"), "side branch only\n");
    const runRevision = await commitPath(env, "side.txt", "2026-06-02T00:30:00.000Z");
    git(env.tempDir, ["checkout", mainBranch]);
    await fs.writeFile(
      env.testFile,
      `// AC: @neutral-freshness ac-one\nit("covers changed", () => {});\n`,
    );
    await commitPath(env, "tests/coverage.test.ts", "2026-06-03T00:00:00.000Z");
    const item = await loadItem(env);

    const entry = entryByAc([item], "ac-one", {
      testRuns: [
        runRecord({
          completedAt: "2026-06-02T00:45:00.000Z",
          codeRevision: runRevision,
          location: { file: "tests/coverage.test.ts", line: 2 },
        }),
      ],
    });
    const findings = await compareCoverageFreshness(entry, { item, projectRoot: env.tempDir });
    const state = await deriveCoverageStateWithFreshnessComparison(entry, {
      item,
      projectRoot: env.tempDir,
    });

    expect(state.state).toBe("unknown_freshness");
    expect(findings).toContainEqual(
      expect.objectContaining({
        cause: "unknown_freshness",
        detail: expect.stringContaining("source revision is not comparable"),
      }),
    );
  });

  // AC: @coverage-freshness-revision-comparison ac-unknown-comparison-degrades-to-reverify
  it("reports unknown freshness for missing producer revision or uncomparable case location", async () => {
    await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await fs.writeFile(env.testFile, `// AC: @neutral-freshness ac-one\nit("covers", () => {});\n`);
    const sourceCommit = await commitPath(
      env,
      "tests/coverage.test.ts",
      "2026-06-02T00:00:00.000Z",
    );
    const item = await loadItem(env);

    const noRevision = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        testRuns: [
          runRecord({
            id: RUN_OLD,
            completedAt: "2026-06-02T00:30:00.000Z",
            codeRevision: null,
            location: { file: "tests/coverage.test.ts", line: 2 },
          }),
        ],
      }),
      { item, projectRoot: env.tempDir },
    );
    const noLocation = await deriveCoverageStateWithFreshnessComparison(
      entryByAc([item], "ac-one", {
        testRuns: [
          runRecord({
            id: RUN_NEW,
            completedAt: "2026-06-02T00:30:00.000Z",
            codeRevision: sourceCommit,
            location: null,
          }),
        ],
      }),
      { item, projectRoot: env.tempDir },
    );

    expect(noRevision.state).toBe("unknown_freshness");
    expect(noLocation.state).toBe("unknown_freshness");
  });

  // AC: @coverage-freshness-revision-comparison ac-sibling-ac-unchanged
  it("keeps a many-AC fixture focused on only the criteria whose text changed", async () => {
    const manyCriteria = Array.from({ length: 120 }, (_, index) => ac(`ac-${index + 1}`));
    await writeSpec(env, manyCriteria);
    const initialCommit = await commitPath(env, "spec", "2026-06-01T00:00:00.000Z");
    await writeSpec(
      env,
      manyCriteria.map((criterion, index) =>
        index === 63 ? ac(criterion.id, "changed") : criterion,
      ),
    );
    await commitPath(env, "spec/modules/specs.yaml", "2026-06-03T00:00:00.000Z");
    const item = await loadItem(env);
    const index = buildCoverageEvidenceIndex({
      items: [item],
      freshness: manyCriteria.map((criterion) => ({
        itemUlid: ITEM_ULID,
        acId: criterion.id,
        recorded: {
          source: "recorded",
          timestamp: "2026-06-02T00:00:00.000Z",
          commit: initialCommit,
          stamp: {
            verified_at: "2026-06-02T00:00:00.000Z",
            actor: "reviewer",
            provenance: "validation",
            commit: initialCommit,
          },
        },
      })),
    });

    const findings = await Promise.all(
      index.entries.map(async (entry) => ({
        acId: entry.acId,
        findings: await compareCoverageFreshness(entry, { item, projectRoot: env.tempDir }),
      })),
    );

    expect(
      findings
        .filter((result) => result.findings.some((f) => f.cause === "stale_spec_text"))
        .map((result) => result.acId),
    ).toEqual(["ac-64"]);
  });
});
