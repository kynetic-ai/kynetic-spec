/**
 * Backend coverage evidence index.
 *
 * Joins live acceptance criteria with structured annotation scan output,
 * freshness values, verification stamps, and normalized ingested test runs.
 * The builder deliberately stops at evidence selection; coverage-state
 * derivation belongs to the state engine layer.
 */

import type {
  BootstrapFreshnessValue,
  RecordedFreshnessValue,
  ResolvedFreshnessWithBoth,
} from "./freshness-resolver.js";
import { resolveAcFreshnessWithBoth } from "./freshness-resolver.js";
import type { ACAnnotation } from "./validate.js";
import { scanACAnnotations } from "./validate.js";
import { ReferenceIndex } from "./refs.js";
import { loadTestRun, loadTestRunIndex } from "./test-result-run-store.js";
import { loadAllItems, type KspecContext, type LoadedSpecItem } from "./yaml.js";
import type {
  NormalizedTestCase,
  TestResultCaseStatus,
  TestResultRunRecord,
  TestRunIndexEntry,
} from "../schema/test-result-runs.js";
import type { AcceptanceCriterion } from "../schema/spec.js";
import type { VerificationStamp } from "../schema/verification-records.js";

type TestResultAttributedMapping = TestResultRunRecord["mapping"]["attributed"][number];
type TestResultUnmappedCase = TestResultRunRecord["mapping"]["unmapped"][number];
type TestResultInvalidMapping = TestResultRunRecord["mapping"]["invalid"][number];

export type CoverageEvidenceSource =
  | "annotation"
  | "bootstrap_freshness"
  | "recorded_verification"
  | "ingested_result"
  | "unmapped_result";

export interface CoverageCriterionIdentity {
  criterionKey: string;
  itemUlid: string;
  itemRef: string;
  acId: string;
}

export interface CoverageAnnotationEvidence extends CoverageCriterionIdentity {
  source: "annotation";
  specRef: string;
  file: string;
  line: number;
  notApplicable: boolean;
  naReason?: string;
}

export interface CoverageBootstrapFreshnessEvidence extends CoverageCriterionIdentity {
  source: "bootstrap_freshness";
  timestamp: string | null;
  commit: string | null;
  value: BootstrapFreshnessValue;
}

export interface CoverageRecordedVerificationEvidence extends CoverageCriterionIdentity {
  source: "recorded_verification";
  timestamp: string;
  commit: string | null;
  stamp: VerificationStamp;
  value: RecordedFreshnessValue;
}

export interface CoverageIngestedResultEvidence extends CoverageCriterionIdentity {
  source: "ingested_result";
  runId: string;
  completedAt: string;
  caseId: string;
  displayName: string;
  status: TestResultCaseStatus;
  producer: {
    kind: TestResultRunRecord["producer"]["kind"];
    label: string;
  };
  codeRevision: string | null;
  mapping: TestResultAttributedMapping;
  testCase: NormalizedTestCase | null;
}

export interface CoverageUnmappedResultEvidence {
  source: "unmapped_result";
  kind: "unmapped" | "invalid";
  runId: string;
  completedAt: string;
  caseId: string;
  displayName?: string;
  reason: string;
  producer: {
    kind: TestResultRunRecord["producer"]["kind"];
    label: string;
  };
  itemRef?: string;
  acId?: string;
  testCase: NormalizedTestCase | null;
}

export type CoverageCriterionEvidenceFact =
  | CoverageAnnotationEvidence
  | CoverageBootstrapFreshnessEvidence
  | CoverageRecordedVerificationEvidence
  | CoverageIngestedResultEvidence;

export interface CoverageEvidenceEntry extends CoverageCriterionIdentity {
  itemTitle: string;
  criterion: AcceptanceCriterion;
  evidence: CoverageCriterionEvidenceFact[];
  annotations: CoverageAnnotationEvidence[];
  bootstrapFreshness: CoverageBootstrapFreshnessEvidence | null;
  recordedVerification: CoverageRecordedVerificationEvidence | null;
  latestRunId: string | null;
  latestIngestedResults: CoverageIngestedResultEvidence[];
}

export interface CoverageEvidenceIndex {
  entries: CoverageEvidenceEntry[];
  entriesByCriterion: Record<string, CoverageEvidenceEntry>;
  unmappedResults: CoverageUnmappedResultEvidence[];
}

export interface CoverageFreshnessInput {
  itemUlid: string;
  acId: string;
  recorded?: RecordedFreshnessValue | null;
  bootstrap?: BootstrapFreshnessValue | null;
}

export interface BuildCoverageEvidenceIndexInput {
  items: LoadedSpecItem[];
  annotations?: ACAnnotation[];
  freshness?: CoverageFreshnessInput[];
  testRuns?: TestResultRunRecord[];
}

interface MutableCoverageEvidenceEntry extends CoverageEvidenceEntry {
  evidence: CoverageCriterionEvidenceFact[];
  annotations: CoverageAnnotationEvidence[];
  latestIngestedResults: CoverageIngestedResultEvidence[];
}

/**
 * Build the joined evidence index from already-loaded inputs.
 */
export function buildCoverageEvidenceIndex(
  input: BuildCoverageEvidenceIndexInput,
): CoverageEvidenceIndex {
  const sortedItems = input.items.toSorted(compareItemsForIndex);
  const refIndex = new ReferenceIndex([], sortedItems);
  const entries: MutableCoverageEvidenceEntry[] = [];
  const entriesByCriterion = new Map<string, MutableCoverageEvidenceEntry>();

  for (const item of sortedItems) {
    for (const criterion of item.acceptance_criteria ?? []) {
      const identity = criterionIdentity(item, criterion.id, refIndex);
      const entry: MutableCoverageEvidenceEntry = {
        ...identity,
        itemTitle: item.title,
        criterion,
        evidence: [],
        annotations: [],
        bootstrapFreshness: null,
        recordedVerification: null,
        latestRunId: null,
        latestIngestedResults: [],
      };
      entries.push(entry);
      entriesByCriterion.set(identity.criterionKey, entry);
    }
  }

  addAnnotationEvidence(input.annotations ?? [], sortedItems, refIndex, entriesByCriterion);
  addFreshnessEvidence(input.freshness ?? [], sortedItems, refIndex, entriesByCriterion);
  const unmappedResults = addTestRunEvidence(
    input.testRuns ?? [],
    sortedItems,
    refIndex,
    entriesByCriterion,
  );

  const entryRecord: Record<string, CoverageEvidenceEntry> = {};
  for (const entry of entries) {
    entryRecord[entry.criterionKey] = entry;
  }
  return {
    entries,
    entriesByCriterion: entryRecord,
    unmappedResults,
  };
}

/**
 * Load all backend inputs from a project context and build the evidence index.
 *
 * This read path treats coverage/test-runs/index.yaml as the authoritative
 * bounded run list. If the index is absent, run folders are not scanned.
 */
export async function loadCoverageEvidenceIndex(ctx: KspecContext): Promise<CoverageEvidenceIndex> {
  const items = await loadAllItems(ctx);
  const annotations = await scanACAnnotations(
    ctx.rootDir,
    ctx.config.coverage.scan_paths,
    ctx.config.coverage.exclude_patterns,
  );
  const freshness = await resolveFreshnessInputs(ctx, items, annotations);
  const testRuns = await loadIndexedTestRuns(ctx);
  return buildCoverageEvidenceIndex({ items, annotations, freshness, testRuns });
}

async function resolveFreshnessInputs(
  ctx: KspecContext,
  items: LoadedSpecItem[],
  annotations: ACAnnotation[],
): Promise<CoverageFreshnessInput[]> {
  const refIndex = new ReferenceIndex([], items);
  const annotationLocations = buildAnnotationLocationsByCriterion(annotations, items, refIndex);
  const inputs: CoverageFreshnessInput[] = [];

  for (const item of items) {
    for (const criterion of item.acceptance_criteria ?? []) {
      const identity = criterionIdentity(item, criterion.id, refIndex);
      const locations = annotationLocations.get(identity.criterionKey) ?? [];
      const result = await resolveAcFreshnessWithBoth(ctx, item._ulid, criterion.id, locations);
      const input = freshnessResultToInput(item._ulid, criterion.id, result);
      if (input) inputs.push(input);
    }
  }
  return inputs;
}

async function loadIndexedTestRuns(ctx: KspecContext): Promise<TestResultRunRecord[]> {
  const index = await loadTestRunIndex(ctx);
  if (!index) return [];
  const ids = Object.keys(index.runs).toSorted((a, b) =>
    compareRunOrder(a, index.runs[a]!, b, index.runs[b]!),
  );
  const records: TestResultRunRecord[] = [];
  for (const id of ids) {
    const record = await loadTestRun(ctx, id);
    if (record) records.push(record);
  }
  return records;
}

function addAnnotationEvidence(
  annotations: ACAnnotation[],
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
  entriesByCriterion: Map<string, MutableCoverageEvidenceEntry>,
): void {
  for (const annotation of annotations) {
    const resolved = resolveAnnotationTarget(annotation, items, refIndex);
    if (!resolved) continue;
    for (const acId of annotation.acIds) {
      const entry = entriesByCriterion.get(criterionKey(resolved.item._ulid, acId));
      if (!entry) continue;
      const evidence: CoverageAnnotationEvidence = {
        ...criterionIdentity(resolved.item, acId, refIndex),
        source: "annotation",
        specRef: annotation.specRef,
        file: annotation.file,
        line: annotation.line,
        notApplicable: annotation.notApplicable === true,
        ...(annotation.naReason !== undefined ? { naReason: annotation.naReason } : {}),
      };
      entry.annotations.push(evidence);
      entry.evidence.push(evidence);
    }
  }
}

function addFreshnessEvidence(
  freshnessInputs: CoverageFreshnessInput[],
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
  entriesByCriterion: Map<string, MutableCoverageEvidenceEntry>,
): void {
  const itemsByUlid = new Map(items.map((item) => [item._ulid, item]));
  for (const freshness of freshnessInputs) {
    const item = itemsByUlid.get(freshness.itemUlid);
    if (!item) continue;
    const entry = entriesByCriterion.get(criterionKey(freshness.itemUlid, freshness.acId));
    if (!entry) continue;
    const identity = criterionIdentity(item, freshness.acId, refIndex);
    if (freshness.bootstrap) {
      const evidence: CoverageBootstrapFreshnessEvidence = {
        ...identity,
        source: "bootstrap_freshness",
        timestamp: freshness.bootstrap.timestamp,
        commit: freshness.bootstrap.commit,
        value: freshness.bootstrap,
      };
      entry.bootstrapFreshness = evidence;
      entry.evidence.push(evidence);
    }
    if (freshness.recorded) {
      const evidence: CoverageRecordedVerificationEvidence = {
        ...identity,
        source: "recorded_verification",
        timestamp: freshness.recorded.timestamp,
        commit: freshness.recorded.commit,
        stamp: freshness.recorded.stamp,
        value: freshness.recorded,
      };
      entry.recordedVerification = evidence;
      entry.evidence.push(evidence);
    }
  }
}

function addTestRunEvidence(
  testRuns: TestResultRunRecord[],
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
  entriesByCriterion: Map<string, MutableCoverageEvidenceEntry>,
): CoverageUnmappedResultEvidence[] {
  const itemsByUlid = new Map(items.map((item) => [item._ulid, item]));
  const latestByCriterion = new Map<string, TestResultRunRecord>();
  const unmappedResults: CoverageUnmappedResultEvidence[] = [];

  for (const run of testRuns) {
    for (const mapping of run.mapping.attributed) {
      const key = criterionKey(mapping.item_ulid, mapping.ac_id);
      if (!entriesByCriterion.has(key)) continue;
      const existing = latestByCriterion.get(key);
      if (!existing || compareRunRecords(run, existing) > 0) {
        latestByCriterion.set(key, run);
      }
    }
    for (const unmapped of run.mapping.unmapped) {
      unmappedResults.push(toUnmappedEvidence("unmapped", run, unmapped));
    }
    for (const invalid of run.mapping.invalid) {
      unmappedResults.push(toUnmappedEvidence("invalid", run, invalid));
    }
  }

  for (const [key, run] of latestByCriterion) {
    const entry = entriesByCriterion.get(key);
    if (!entry) continue;
    const item = itemsByUlid.get(entry.itemUlid);
    if (!item) continue;
    const identity = criterionIdentity(item, entry.acId, refIndex);
    const casesById = caseMap(run);
    const evidences = run.mapping.attributed
      .filter((mapping) => criterionKey(mapping.item_ulid, mapping.ac_id) === key)
      .map((mapping) =>
        toIngestedResultEvidence(identity, run, mapping, casesById.get(mapping.case_id)),
      );
    entry.latestRunId = run.run.id;
    entry.latestIngestedResults.push(...evidences);
    entry.evidence.push(...evidences);
  }

  return unmappedResults;
}

function buildAnnotationLocationsByCriterion(
  annotations: ACAnnotation[],
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
): Map<string, Array<{ file: string; line: number }>> {
  const locations = new Map<string, Array<{ file: string; line: number }>>();
  for (const annotation of annotations) {
    const resolved = resolveAnnotationTarget(annotation, items, refIndex);
    if (!resolved || annotation.notApplicable === true) continue;
    for (const acId of annotation.acIds) {
      const key = criterionKey(resolved.item._ulid, acId);
      if (!locations.has(key)) locations.set(key, []);
      locations.get(key)!.push({ file: annotation.file, line: annotation.line });
    }
  }
  return locations;
}

function resolveAnnotationTarget(
  annotation: ACAnnotation,
  items: LoadedSpecItem[],
  refIndex: ReferenceIndex,
): { item: LoadedSpecItem } | null {
  if (annotation.acIds.length === 0) return null;
  const resolved = refIndex.resolve(annotation.specRef);
  if (!resolved.ok) return null;
  const item = items.find((candidate) => candidate._ulid === resolved.ulid);
  if (!item) return null;
  const liveAcIds = new Set((item.acceptance_criteria ?? []).map((criterion) => criterion.id));
  if (annotation.acIds.every((acId) => liveAcIds.has(acId))) {
    return { item };
  }
  return { item };
}

function freshnessResultToInput(
  itemUlid: string,
  acId: string,
  result: ResolvedFreshnessWithBoth,
): CoverageFreshnessInput | null {
  if (result.kind === "absent") return null;
  return {
    itemUlid,
    acId,
    recorded: result.recorded,
    bootstrap: result.bootstrap,
  };
}

function toIngestedResultEvidence(
  identity: CoverageCriterionIdentity,
  run: TestResultRunRecord,
  mapping: TestResultAttributedMapping,
  testCase: NormalizedTestCase | undefined,
): CoverageIngestedResultEvidence {
  return {
    ...identity,
    source: "ingested_result",
    runId: run.run.id,
    completedAt: run.run.completed_at,
    caseId: mapping.case_id,
    displayName: testCase?.display_name ?? mapping.case_id,
    status: mapping.status,
    producer: {
      kind: run.producer.kind,
      label: run.producer.label,
    },
    codeRevision: run.producer.code_revision ?? null,
    mapping,
    testCase: testCase ?? null,
  };
}

function toUnmappedEvidence(
  kind: "unmapped",
  run: TestResultRunRecord,
  mapping: TestResultUnmappedCase,
): CoverageUnmappedResultEvidence;
function toUnmappedEvidence(
  kind: "invalid",
  run: TestResultRunRecord,
  mapping: TestResultInvalidMapping,
): CoverageUnmappedResultEvidence;
function toUnmappedEvidence(
  kind: "unmapped" | "invalid",
  run: TestResultRunRecord,
  mapping: TestResultUnmappedCase | TestResultInvalidMapping,
): CoverageUnmappedResultEvidence {
  const testCase = caseMap(run).get(mapping.case_id);
  const itemRef =
    "item_ref" in mapping && typeof mapping.item_ref === "string" ? mapping.item_ref : undefined;
  const acId = "ac_id" in mapping && typeof mapping.ac_id === "string" ? mapping.ac_id : undefined;
  return {
    source: "unmapped_result",
    kind,
    runId: run.run.id,
    completedAt: run.run.completed_at,
    caseId: mapping.case_id,
    ...(mapping.display_name !== undefined ? { displayName: mapping.display_name } : {}),
    reason: mapping.reason,
    producer: {
      kind: run.producer.kind,
      label: run.producer.label,
    },
    ...(itemRef ? { itemRef } : {}),
    ...(acId ? { acId } : {}),
    testCase: testCase ?? null,
  };
}

function caseMap(run: TestResultRunRecord): Map<string, NormalizedTestCase> {
  return new Map(run.cases.map((testCase) => [testCase.id, testCase]));
}

function compareItemsForIndex(a: LoadedSpecItem, b: LoadedSpecItem): number {
  const byFile = (a._sourceFile ?? "").localeCompare(b._sourceFile ?? "");
  if (byFile !== 0) return byFile;
  const byPath = (a._path ?? "").localeCompare(b._path ?? "");
  if (byPath !== 0) return byPath;
  return a._ulid.localeCompare(b._ulid);
}

function criterionIdentity(
  item: LoadedSpecItem,
  acId: string,
  refIndex: ReferenceIndex,
): CoverageCriterionIdentity {
  return {
    criterionKey: criterionKey(item._ulid, acId),
    itemUlid: item._ulid,
    itemRef: item.slugs?.[0] ? `@${item.slugs[0]}` : `@${refIndex.shortUlid(item._ulid)}`,
    acId,
  };
}

function criterionKey(itemUlid: string, acId: string): string {
  return `${itemUlid} ${acId}`;
}

function compareRunRecords(a: TestResultRunRecord, b: TestResultRunRecord): number {
  const byCompleted = a.run.completed_at.localeCompare(b.run.completed_at);
  if (byCompleted !== 0) return byCompleted;
  return a.run.id.localeCompare(b.run.id);
}

function compareRunOrder(
  aId: string,
  a: TestRunIndexEntry,
  bId: string,
  b: TestRunIndexEntry,
): number {
  const byCompleted = a.completed_at.localeCompare(b.completed_at);
  if (byCompleted !== 0) return byCompleted;
  return aId.localeCompare(bId);
}
