import type {
  CoverageBucketCounts,
  CoverageCriterionStateDetail,
  CoverageFreshnessSummary,
  CoverageItemStateSummary,
  CoverageLatestRunEvidenceSummary,
  CoverageStateSnapshot,
  CoverageStateSummary,
  CoverageUnmappedResultSummary,
} from "@kynetic-ai/shared";
import {
  loadCoverageEvidenceIndex,
  type CoverageEvidenceIndex,
  type CoverageEvidenceEntry,
  type CoverageIngestedResultEvidence,
  type CoverageUnmappedResultEvidence,
} from "./coverage-evidence-index.js";
import { deriveCoverageState } from "./coverage-state.js";
import type { KspecContext } from "./yaml.js";

export type CoverageStateReadModel = CoverageStateSnapshot;

export interface CoverageStateReadModelCacheStats {
  entries: number;
  pending: number;
}

interface CoverageStateReadModelCacheEntry {
  model?: CoverageStateReadModel;
  pending?: Promise<CoverageStateReadModel>;
}

const readModelCache = new Map<string, CoverageStateReadModelCacheEntry>();

function emptyCounts(): CoverageBucketCounts {
  return { covered: 0, failing: 0, not_yet: 0, re_verify: 0 };
}

function addCounts(target: CoverageBucketCounts, source: CoverageBucketCounts): void {
  target.covered += source.covered;
  target.failing += source.failing;
  target.not_yet += source.not_yet;
  target.re_verify += source.re_verify;
}

function countCriterion(detail: CoverageCriterionStateDetail): CoverageBucketCounts {
  const counts = emptyCounts();
  counts[detail.presentation] += 1;
  return counts;
}

function normalizeCacheRoot(rootDir: string): string {
  return rootDir.endsWith("/") ? rootDir.slice(0, -1) : rootDir;
}

function cacheKey(ctx: KspecContext): string {
  const scanPaths = [...ctx.config.coverage.scan_paths].toSorted().join("\0");
  const excludePatterns = [...ctx.config.coverage.exclude_patterns].toSorted().join("\0");
  return `${normalizeCacheRoot(ctx.rootDir)}\0${scanPaths}\0${excludePatterns}`;
}

function latestRunId(entries: readonly CoverageEvidenceEntry[]): string | null {
  let latest: CoverageIngestedResultEvidence | null = null;
  for (const entry of entries) {
    for (const evidence of entry.latestIngestedResults) {
      if (isNewerRunEvidence(evidence, latest)) {
        latest = evidence;
      }
    }
  }
  return latest?.runId ?? null;
}

function isNewerRunEvidence(
  candidate: CoverageIngestedResultEvidence,
  current: CoverageIngestedResultEvidence | null,
): boolean {
  return (
    !current ||
    candidate.completedAt.localeCompare(current.completedAt) > 0 ||
    (candidate.completedAt === current.completedAt &&
      candidate.runId.localeCompare(current.runId) > 0)
  );
}

function latestRunEvidence(entry: CoverageEvidenceEntry): CoverageLatestRunEvidenceSummary[] {
  return entry.latestIngestedResults.map((evidence) => ({
    run_id: evidence.runId,
    completed_at: evidence.completedAt,
    case_id: evidence.caseId,
    display_name: evidence.displayName,
    status: evidence.status,
    producer: evidence.producer,
    code_revision: evidence.codeRevision,
  }));
}

function freshness(entry: CoverageEvidenceEntry): CoverageFreshnessSummary {
  return {
    bootstrap: entry.bootstrapFreshness
      ? {
          timestamp: entry.bootstrapFreshness.timestamp,
          commit: entry.bootstrapFreshness.commit,
        }
      : null,
    recorded: entry.recordedVerification
      ? {
          timestamp: entry.recordedVerification.timestamp,
          commit: entry.recordedVerification.commit,
          verified_at: entry.recordedVerification.stamp.verified_at,
          actor: entry.recordedVerification.stamp.actor,
          provenance: entry.recordedVerification.stamp.provenance,
        }
      : null,
    secondary_causes: [],
  };
}

function unmappedSummary(evidence: CoverageUnmappedResultEvidence): CoverageUnmappedResultSummary {
  return {
    kind: evidence.kind,
    run_id: evidence.runId,
    completed_at: evidence.completedAt,
    case_id: evidence.caseId,
    display_name: evidence.displayName ?? evidence.testCase?.display_name ?? null,
    reason: evidence.reason,
    producer: evidence.producer,
    item_ref: evidence.itemRef ?? null,
    ac_id: evidence.acId ?? null,
  };
}

function criterionDetail(
  entry: CoverageEvidenceEntry,
  unmappedResults: readonly CoverageUnmappedResultSummary[],
): CoverageCriterionStateDetail {
  const state = deriveCoverageState(entry);
  const relevantUnmapped = unmappedResults.filter(
    (result) => result.item_ref === entry.itemRef && result.ac_id === entry.acId,
  );
  const freshnessSummary = freshness(entry);
  freshnessSummary.secondary_causes = state.explanation.secondaryReverifyCauses;
  return {
    criterion_key: entry.criterionKey,
    item_ulid: entry.itemUlid,
    item_ref: entry.itemRef,
    item_title: entry.itemTitle,
    ac_id: entry.acId,
    state: state.state,
    presentation: state.presentation,
    explanation: state.explanation,
    latest_run_evidence: latestRunEvidence(entry),
    freshness: freshnessSummary,
    unmapped_result_references: relevantUnmapped,
  };
}

function addItemAlias(
  items: Record<string, CoverageItemStateSummary>,
  key: string,
  value: CoverageItemStateSummary,
): void {
  items[key] = value;
  if (key.startsWith("@")) {
    items[key.slice(1)] = value;
  } else {
    items[`@${key}`] = value;
  }
}

function compareUnmapped(
  a: CoverageUnmappedResultSummary,
  b: CoverageUnmappedResultSummary,
): number {
  const byRun = b.completed_at.localeCompare(a.completed_at);
  if (byRun !== 0) return byRun;
  const byRunId = b.run_id.localeCompare(a.run_id);
  if (byRunId !== 0) return byRunId;
  return a.case_id.localeCompare(b.case_id);
}

export function buildCoverageStateReadModel(
  evidenceIndex: CoverageEvidenceIndex,
): CoverageStateReadModel {
  const unmappedResults = evidenceIndex.unmappedResults
    .map(unmappedSummary)
    .toSorted(compareUnmapped);
  const criteria: Record<string, CoverageCriterionStateDetail> = {};
  const itemsByUlid = new Map<string, CoverageItemStateSummary>();
  const latestItemEvidence = new Map<string, CoverageIngestedResultEvidence>();
  const summaryCounts = emptyCounts();

  for (const entry of evidenceIndex.entries) {
    const detail = criterionDetail(entry, unmappedResults);
    criteria[entry.criterionKey] = detail;
    const counts = countCriterion(detail);
    addCounts(summaryCounts, counts);

    let item = itemsByUlid.get(entry.itemUlid);
    if (!item) {
      const itemUnmapped = unmappedResults.filter((result) => result.item_ref === entry.itemRef);
      item = {
        item_ulid: entry.itemUlid,
        item_ref: entry.itemRef,
        item_title: entry.itemTitle,
        counts: emptyCounts(),
        denominator: 0,
        latest_run_id: null,
        criteria: [],
        unmapped_result_references: itemUnmapped,
      };
      itemsByUlid.set(entry.itemUlid, item);
    }
    item.denominator += 1;
    addCounts(item.counts, counts);
    item.criteria.push(detail);
    for (const evidence of entry.latestIngestedResults) {
      if (isNewerRunEvidence(evidence, latestItemEvidence.get(entry.itemUlid) ?? null)) {
        latestItemEvidence.set(entry.itemUlid, evidence);
        item.latest_run_id = evidence.runId;
      }
    }
  }

  const items: Record<string, CoverageItemStateSummary> = {};
  for (const item of itemsByUlid.values()) {
    item.criteria.sort((a, b) => a.ac_id.localeCompare(b.ac_id));
    addItemAlias(items, item.item_ref, item);
    addItemAlias(items, item.item_ulid, item);
  }

  const invalidResultCount = unmappedResults.filter((result) => result.kind === "invalid").length;
  const unmappedResultCount = unmappedResults.filter((result) => result.kind === "unmapped").length;
  const summary: CoverageStateSummary = {
    counts: summaryCounts,
    denominator: evidenceIndex.entries.length,
    latest_run_id: latestRunId(evidenceIndex.entries),
    unmapped_result_count: unmappedResultCount,
    invalid_result_count: invalidResultCount,
  };

  return {
    summary,
    items,
    criteria,
    unmapped_results: unmappedResults,
  };
}

export async function loadCoverageStateReadModel(
  ctx: KspecContext,
): Promise<CoverageStateReadModel> {
  return buildCoverageStateReadModel(await loadCoverageEvidenceIndex(ctx));
}

export async function getCachedCoverageStateReadModel(
  ctx: KspecContext,
  options: {
    loadEvidenceIndex?: () => Promise<CoverageEvidenceIndex>;
  } = {},
): Promise<CoverageStateReadModel> {
  const key = cacheKey(ctx);
  const existing = readModelCache.get(key);
  if (existing?.model) return existing.model;
  if (existing?.pending) return existing.pending;

  const loadEvidenceIndex = options.loadEvidenceIndex ?? (() => loadCoverageEvidenceIndex(ctx));
  const pending = loadEvidenceIndex().then((index) => {
    const model = buildCoverageStateReadModel(index);
    readModelCache.set(key, { model });
    return model;
  });
  readModelCache.set(key, { pending });
  try {
    return await pending;
  } catch (error) {
    readModelCache.delete(key);
    throw error;
  }
}

export function invalidateCoverageStateReadModelCache(rootDir?: string): void {
  if (!rootDir) {
    readModelCache.clear();
    return;
  }
  const prefix = `${normalizeCacheRoot(rootDir)}\0`;
  for (const key of readModelCache.keys()) {
    if (key.startsWith(prefix)) {
      readModelCache.delete(key);
    }
  }
}

export function getCoverageStateReadModelCacheStats(): CoverageStateReadModelCacheStats {
  let pending = 0;
  for (const entry of readModelCache.values()) {
    if (entry.pending) pending += 1;
  }
  return {
    entries: readModelCache.size,
    pending,
  };
}
