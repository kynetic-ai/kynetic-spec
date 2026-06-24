/**
 * Per-acceptance-criterion freshness and revision comparison.
 *
 * This layer turns project/shadow git history and normalized run metadata into
 * freshness findings consumed by the pure coverage-state derivation.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type {
  CoverageAnnotationEvidence,
  CoverageEvidenceEntry,
  CoverageIngestedResultEvidence,
} from "./coverage-evidence-index.js";
import { deriveCoverageState, type CoverageStateFreshnessFinding } from "./coverage-state.js";
import { parseYaml, type LoadedSpecItem } from "./yaml.js";
import { SpecItemSchema, type AcceptanceCriterion, type SpecItem } from "../schema/spec.js";

const execFileAsync = promisify(execFile);
const ZERO_SHA = "0".repeat(40);

export type CriterionTextComparisonStatus = "current" | "changed" | "unknown";

export interface CriterionTextComparison {
  acId: string;
  status: CriterionTextComparisonStatus;
  current: AcceptanceCriterion | null;
  previous: AcceptanceCriterion | null;
  changedFields: Array<"given" | "when" | "then">;
  previousCommit: string | null;
  detail?: string;
}

export interface CriterionComparisonVersion {
  atTimestamp?: string;
  /** Commit in the criterion source repository. Project code revisions are not valid here. */
  atCommit?: string | null;
}

export interface CoverageFreshnessComparisonOptions {
  item: LoadedSpecItem;
  projectRoot?: string;
}

export async function deriveCoverageStateWithFreshnessComparison(
  entry: CoverageEvidenceEntry,
  options: CoverageFreshnessComparisonOptions,
) {
  const freshnessFindings = await compareCoverageFreshness(entry, options);
  return deriveCoverageState({ ...entry, freshnessFindings });
}

export async function compareCoverageFreshness(
  entry: CoverageEvidenceEntry,
  options: CoverageFreshnessComparisonOptions,
): Promise<CoverageStateFreshnessFinding[]> {
  if (!hasPositiveEvidence(entry)) return [];

  const findings: CoverageStateFreshnessFinding[] = [];
  const textFinding = await compareCriterionTextFreshness(entry, options.item);
  if (textFinding) findings.push(textFinding);

  for (const result of entry.latestIngestedResults) {
    if (result.status !== "passed") continue;
    findings.push(
      ...(await compareRunEvidenceFreshness(result, entry.annotations, options.projectRoot)),
    );
  }

  return dedupeFindings(findings);
}

/**
 * Read a focused prior/current comparison for a single criterion.
 *
 * Consumers can show the stale AC explanation without fetching or diffing the
 * entire spec item. The previous side is resolved from the item source file's
 * own git history, which is the shadow metadata repository for normal kspec
 * projects and the project repository for non-shadow fixtures.
 */
export async function readCriterionFreshnessComparison(
  item: LoadedSpecItem,
  acId: string,
  version: CriterionComparisonVersion,
): Promise<CriterionTextComparison> {
  const current = findCriterion(item, acId);
  if (!item._sourceFile) {
    return unknownTextComparison(acId, current, "criterion source file is unavailable");
  }

  const gitFile = await resolveGitFile(item._sourceFile);
  if (!gitFile) {
    return unknownTextComparison(acId, current, "criterion source file is not in git history");
  }

  const previousCommit =
    version.atCommit ||
    (version.atTimestamp ? await commitBefore(gitFile, version.atTimestamp) : null);
  if (!previousCommit) {
    return unknownTextComparison(acId, current, "prior criterion version could not be resolved");
  }

  const previousContent = await showFileAt(gitFile, previousCommit);
  if (previousContent === null) {
    return unknownTextComparison(acId, current, "prior criterion source could not be read");
  }

  const previousItem = findItemInRaw(parseYaml<unknown>(previousContent), item._ulid);
  const previous = previousItem ? findCriterion(previousItem, acId) : null;
  if (!current || !previous) {
    return {
      acId,
      status: "unknown",
      current: current ?? null,
      previous: previous ?? null,
      changedFields: [],
      previousCommit,
      detail: "criterion was absent from the current or prior version",
    };
  }

  const changedFields = compareCriterionText(previous, current);
  return {
    acId,
    status: changedFields.length > 0 ? "changed" : "current",
    current,
    previous,
    changedFields,
    previousCommit,
  };
}

async function compareCriterionTextFreshness(
  entry: CoverageEvidenceEntry,
  item: LoadedSpecItem,
): Promise<CoverageStateFreshnessFinding | null> {
  const verifiedAt = latestPositiveEvidenceVersion(entry);
  if (!verifiedAt) return null;

  const comparison = await readCriterionFreshnessComparison(item, entry.acId, verifiedAt);

  if (comparison.status === "changed") {
    return {
      cause: "stale_spec_text",
      sourceEvidenceIds: positiveEvidenceIds(entry),
      detail: `criterion text changed after ${formatComparisonVersion(verifiedAt)}`,
    };
  }

  if (comparison.status === "unknown") {
    return {
      cause: "unknown_freshness",
      sourceEvidenceIds: positiveEvidenceIds(entry),
      detail: comparison.detail ?? "criterion text freshness could not be compared",
    };
  }

  return null;
}

async function compareRunEvidenceFreshness(
  result: CoverageIngestedResultEvidence,
  annotations: readonly CoverageAnnotationEvidence[],
  projectRoot: string | undefined,
): Promise<CoverageStateFreshnessFinding[]> {
  const evidenceId = ingestedEvidenceId(result);
  if (!result.codeRevision) {
    return [
      {
        cause: "unknown_freshness",
        sourceEvidenceIds: [evidenceId],
        detail: "passing ingested result lacks comparable code revision metadata",
      },
    ];
  }

  const findings: CoverageStateFreshnessFinding[] = [];
  const caseLocation = result.testCase?.location ?? null;
  if (!caseLocation?.file || !caseLocation.line) {
    findings.push({
      cause: "unknown_freshness",
      sourceEvidenceIds: [evidenceId],
      detail: "mapped test case lacks a comparable source location",
    });
  } else {
    const comparison = await compareLineToRevision(
      caseLocation.file,
      caseLocation.line,
      result.codeRevision,
      projectRoot,
    );
    findings.push(
      ...sourceComparisonFinding(comparison, "stale_test_result", evidenceId, "mapped test case"),
    );
  }

  for (const annotation of annotations.filter((candidate) => candidate.notApplicable !== true)) {
    const comparison = await compareLineToRevision(
      annotation.file,
      annotation.line,
      result.codeRevision,
      projectRoot,
    );
    findings.push(
      ...sourceComparisonFinding(
        comparison,
        "stale_annotation_or_mapping",
        evidenceId,
        "coverage annotation",
      ),
    );
  }

  return findings;
}

type LineRevisionComparison =
  | { status: "current" }
  | { status: "changed"; commit: string }
  | { status: "unknown"; detail: string };

async function compareLineToRevision(
  file: string,
  line: number,
  revision: string,
  projectRoot: string | undefined,
): Promise<LineRevisionComparison> {
  const gitFile = await resolveGitFile(file, projectRoot);
  if (!gitFile) return { status: "unknown", detail: "source file is not in git history" };

  const blame = await blameLine(gitFile, line);
  if (!blame?.commit) {
    return { status: "unknown", detail: "source line history could not be resolved" };
  }
  if (blame.commit === revision) return { status: "current" };

  const ancestor = await isAncestor(gitFile.repoRoot, revision, blame.commit);
  if (ancestor === null) {
    return { status: "unknown", detail: "source revision could not be compared" };
  }
  if (ancestor) return { status: "changed", commit: blame.commit };

  const descendant = await isAncestor(gitFile.repoRoot, blame.commit, revision);
  if (descendant === null) {
    return { status: "unknown", detail: "source revision could not be compared" };
  }
  if (descendant) return { status: "current" };

  return { status: "unknown", detail: "source revision is not comparable to current line history" };
}

function sourceComparisonFinding(
  comparison: LineRevisionComparison,
  cause: "stale_annotation_or_mapping" | "stale_test_result",
  evidenceId: string,
  label: string,
): CoverageStateFreshnessFinding[] {
  if (comparison.status === "current") return [];
  if (comparison.status === "changed") {
    return [
      {
        cause,
        sourceEvidenceIds: [evidenceId],
        detail: `${label} changed after the ingested run revision`,
      },
    ];
  }
  return [
    {
      cause: "unknown_freshness",
      sourceEvidenceIds: [evidenceId],
      detail: `${label} freshness could not be compared: ${comparison.detail}`,
    },
  ];
}

interface GitFile {
  repoRoot: string;
  relPath: string;
}

async function resolveGitFile(file: string, rootDir?: string): Promise<GitFile | null> {
  const absPath = path.isAbsolute(file) ? file : path.resolve(rootDir ?? process.cwd(), file);
  const startDir = path.dirname(absPath);
  let repoRoot: string;
  try {
    const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf-8",
    });
    repoRoot = result.stdout.trim();
  } catch {
    return null;
  }
  return {
    repoRoot,
    relPath: path.relative(repoRoot, absPath).split(path.sep).join("/"),
  };
}

async function commitBefore(gitFile: GitFile, timestamp: string): Promise<string | null> {
  try {
    const result = await execFileAsync(
      "git",
      ["log", "--format=%H", `--before=${timestamp}`, "-n", "1", "--", gitFile.relPath],
      { cwd: gitFile.repoRoot, encoding: "utf-8" },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function showFileAt(gitFile: GitFile, commit: string): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["show", `${commit}:${gitFile.relPath}`], {
      cwd: gitFile.repoRoot,
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

async function blameLine(
  gitFile: GitFile,
  line: number,
): Promise<{ commit: string; timestamp: string | null } | null> {
  try {
    const result = await execFileAsync(
      "git",
      ["blame", "--line-porcelain", "-L", `${line},${line}`, "--", gitFile.relPath],
      { cwd: gitFile.repoRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 },
    );
    const commit = result.stdout.match(/^([0-9a-f]{40}) /)?.[1];
    if (!commit || commit === ZERO_SHA) return null;
    const timeText = result.stdout.match(/^committer-time (\d+)$/m)?.[1];
    return {
      commit,
      timestamp: timeText ? new Date(Number(timeText) * 1000).toISOString() : null,
    };
  } catch {
    return null;
  }
}

async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    return true;
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : null;
    return code === 1 ? false : null;
  }
}

function findItemInRaw(raw: unknown, ulid: string): SpecItem | null {
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const found = findItemInRaw(value, ulid);
      if (found) return found;
    }
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const parsed = SpecItemSchema.safeParse(raw);
  if (parsed.success && parsed.data._ulid === ulid) return parsed.data;

  for (const value of Object.values(raw)) {
    const found = findItemInRaw(value, ulid);
    if (found) return found;
  }
  return null;
}

function findCriterion(
  item: Pick<LoadedSpecItem, "acceptance_criteria"> | Pick<SpecItem, "acceptance_criteria">,
  acId: string,
): AcceptanceCriterion | null {
  return item.acceptance_criteria?.find((criterion) => criterion.id === acId) ?? null;
}

function compareCriterionText(
  previous: AcceptanceCriterion,
  current: AcceptanceCriterion,
): Array<"given" | "when" | "then"> {
  return (["given", "when", "then"] as const).filter((field) => previous[field] !== current[field]);
}

function unknownTextComparison(
  acId: string,
  current: AcceptanceCriterion | null,
  detail: string,
): CriterionTextComparison {
  return {
    acId,
    status: "unknown",
    current,
    previous: null,
    changedFields: [],
    previousCommit: null,
    detail,
  };
}

function hasPositiveEvidence(entry: CoverageEvidenceEntry): boolean {
  return positiveEvidenceIds(entry).length > 0;
}

function latestPositiveEvidenceVersion(
  entry: CoverageEvidenceEntry,
): CriterionComparisonVersion | null {
  const candidates: Array<CriterionComparisonVersion | null> = [
    entry.recordedVerification
      ? {
          atTimestamp: entry.recordedVerification.timestamp,
          atCommit: entry.recordedVerification.commit,
        }
      : null,
    entry.bootstrapFreshness &&
    (entry.bootstrapFreshness.timestamp || entry.bootstrapFreshness.commit)
      ? {
          ...(entry.bootstrapFreshness.timestamp
            ? { atTimestamp: entry.bootstrapFreshness.timestamp }
            : {}),
          atCommit: entry.bootstrapFreshness.commit,
        }
      : null,
    ...entry.latestIngestedResults
      .filter((result) => result.status === "passed")
      .map((result) => ({
        atTimestamp: result.completedAt,
      })),
  ];
  const versions = candidates.filter(
    (version): version is CriterionComparisonVersion => version !== null,
  );

  const withTimestamp = versions
    .filter((version) => version.atTimestamp)
    .toSorted((a, b) => a.atTimestamp!.localeCompare(b.atTimestamp!));
  return withTimestamp.at(-1) ?? versions[0] ?? null;
}

function formatComparisonVersion(version: CriterionComparisonVersion): string {
  return version.atTimestamp ?? version.atCommit ?? "positive evidence";
}

function positiveEvidenceIds(entry: CoverageEvidenceEntry): string[] {
  return [
    ...entry.annotations
      .filter((annotation) => annotation.notApplicable !== true)
      .map(
        (annotation) =>
          `annotation:${annotation.file}:${annotation.line}:${annotation.itemUlid}:${annotation.acId}`,
      ),
    ...(entry.recordedVerification
      ? [
          `recorded_verification:${entry.recordedVerification.itemUlid}:${entry.recordedVerification.acId}:${entry.recordedVerification.timestamp}`,
        ]
      : []),
    ...entry.latestIngestedResults
      .filter((result) => result.status === "passed")
      .map(ingestedEvidenceId),
  ].toSorted((a, b) => a.localeCompare(b));
}

function ingestedEvidenceId(result: CoverageIngestedResultEvidence): string {
  return `ingested_result:${result.runId}:${result.caseId}`;
}

function dedupeFindings(
  findings: readonly CoverageStateFreshnessFinding[],
): CoverageStateFreshnessFinding[] {
  const deduped = new Map<string, CoverageStateFreshnessFinding>();
  for (const finding of findings) {
    deduped.set(
      JSON.stringify([finding.cause, finding.sourceEvidenceIds ?? [], finding.detail ?? ""]),
      finding,
    );
  }
  return Array.from(deduped.values());
}
