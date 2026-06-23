/**
 * Normalized test-result run store.
 *
 * Durable sidecar storage for completed normalized test runs:
 *
 *   <specDir>/coverage/test-runs/index.yaml
 *   <specDir>/coverage/test-runs/runs/<run-ulid>/run.yaml
 *
 * The run file is authoritative for detailed case, mapping, diagnostic,
 * producer, and verification-effect data. The index is a bounded projection
 * for consumers that need list/latest summaries without loading heavy detail.
 *
 * Spec: @test-result-run-store
 */

import * as path from "node:path";
import {
  mkdirBufferAware,
  readdirBufferAware,
  runWithBuffer,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import { UlidSchema } from "../schema/common.js";
import {
  CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
  TestResultRunRecordInputSchema,
  TestResultRunRecordSchema,
  TestRunIndexSchema,
  type TestResultRunRecord,
  type TestResultRunRecordInput,
  type TestRunIndex,
  type TestRunIndexEntry,
} from "../schema/test-result-runs.js";
import {
  type FolderBackedEntityLayout,
  getEntityDir,
  getEntityFilePath,
  getEntityIndexPath,
  getStorageRoot,
  isValidUlidDirName,
  listEntityDirs,
  mergePreservingRawShape,
  objectsStructurallyEqual,
} from "./folder-backed-entity.js";
import { withFileLock } from "./file-lock.js";
import { ReferenceIndex } from "./refs.js";
import { mapTestResultCasesToAcceptanceCriteria } from "./test-result-ac-mapping.js";
import { commitIfShadow } from "./shadow.js";
import { loadAllItems, type KspecContext } from "./yaml.js";
import { readYamlFile, toYaml, writeYamlFile } from "./yaml.js";

// ── Layout ────────────────────────────────────────────────────────────────────

export const TEST_RUN_LAYOUT: FolderBackedEntityLayout = {
  entityType: "test-run",
  storageRoot: path.join("coverage", "test-runs", "runs"),
  indexFile: path.join("coverage", "test-runs", "index.yaml"),
};

export const TEST_RUN_FILENAME = "run.yaml";
export const TEST_RUN_INDEX_RELATIVE_ROOT = path.join("coverage", "test-runs");

export function getTestRunStoreRoot(ctx: KspecContext): string {
  return path.join(ctx.specDir, TEST_RUN_INDEX_RELATIVE_ROOT);
}

export function getTestRunRunsRoot(ctx: KspecContext): string {
  return getStorageRoot(ctx, TEST_RUN_LAYOUT);
}

export function getTestRunDir(ctx: KspecContext, runId: string): string {
  return getEntityDir(ctx, TEST_RUN_LAYOUT, runId);
}

export function getTestRunFilePath(ctx: KspecContext, runId: string): string {
  return getEntityFilePath(ctx, TEST_RUN_LAYOUT, runId, TEST_RUN_FILENAME);
}

export function getTestRunIndexPath(ctx: KspecContext): string {
  return getEntityIndexPath(ctx, TEST_RUN_LAYOUT);
}

// ── Record-Format Version Ceiling ────────────────────────────────────────────

export const TEST_RESULT_RUN_FORMAT_NEWER_THAN_SUPPORTED_CODE =
  "test_result_run_format_newer_than_supported";
export const TEST_RESULT_RUN_FORMAT_UNRECOGNIZED_CODE = "test_result_run_format_unrecognized";

const TEST_RESULT_RUN_UPGRADE_SUGGESTION =
  "Upgrade your kspec installation to a version that supports this test-result run record format, or use the newer kspec version that wrote this store.";

export class TestResultRunRecordFormatCompatibilityError extends Error {
  readonly code: string;
  readonly declaredVersion: string | number;
  readonly maxSupportedVersion: number;
  readonly suggestion: string;

  constructor(
    message: string,
    options: {
      code: string;
      declaredVersion: string | number;
      suggestion: string;
    },
  ) {
    super(message);
    this.name = "TestResultRunRecordFormatCompatibilityError";
    this.code = options.code;
    this.declaredVersion = options.declaredVersion;
    this.maxSupportedVersion = CURRENT_TEST_RESULT_RUN_RECORD_FORMAT;
    this.suggestion = options.suggestion;
  }
}

export function describeTestResultRunFormatIncompatibility(
  declared: unknown,
): TestResultRunRecordFormatCompatibilityError | null {
  if (declared === undefined || declared === null) return null;

  if (typeof declared !== "number" || !Number.isInteger(declared) || declared <= 0) {
    const literal = typeof declared === "string" ? declared : JSON.stringify(declared);
    return new TestResultRunRecordFormatCompatibilityError(
      `This test-result run store declares record-format version "${literal}", which cannot be ` +
        `interpreted as a known test-result run record format (maximum supported: ` +
        `${CURRENT_TEST_RESULT_RUN_RECORD_FORMAT}) ` +
        `[${TEST_RESULT_RUN_FORMAT_UNRECOGNIZED_CODE}]. ` +
        `${TEST_RESULT_RUN_UPGRADE_SUGGESTION}`,
      {
        code: TEST_RESULT_RUN_FORMAT_UNRECOGNIZED_CODE,
        declaredVersion: literal,
        suggestion: TEST_RESULT_RUN_UPGRADE_SUGGESTION,
      },
    );
  }

  if (declared > CURRENT_TEST_RESULT_RUN_RECORD_FORMAT) {
    return new TestResultRunRecordFormatCompatibilityError(
      `This test-result run store declares record-format version ${declared}, which is newer ` +
        `than the maximum record format supported by this kspec installation ` +
        `(${CURRENT_TEST_RESULT_RUN_RECORD_FORMAT}) ` +
        `[${TEST_RESULT_RUN_FORMAT_NEWER_THAN_SUPPORTED_CODE}]. The store was not modified. ` +
        `${TEST_RESULT_RUN_UPGRADE_SUGGESTION}`,
      {
        code: TEST_RESULT_RUN_FORMAT_NEWER_THAN_SUPPORTED_CODE,
        declaredVersion: declared,
        suggestion: TEST_RESULT_RUN_UPGRADE_SUGGESTION,
      },
    );
  }

  return null;
}

function getRawDeclaredFormat(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return undefined;
  return (raw as Record<string, unknown>).format;
}

function assertRawFormatSupported(raw: unknown): void {
  const err = describeTestResultRunFormatIncompatibility(getRawDeclaredFormat(raw));
  if (err) throw err;
}

// ── Raw Reads ────────────────────────────────────────────────────────────────

async function readRawYamlObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readYamlFile<unknown>(filePath);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

async function readRawRun(
  ctx: KspecContext,
  runId: string,
): Promise<Record<string, unknown> | null> {
  return readRawYamlObject(getTestRunFilePath(ctx, runId));
}

async function readRawIndex(ctx: KspecContext): Promise<Record<string, unknown> | null> {
  return readRawYamlObject(getTestRunIndexPath(ctx));
}

// ── Unknown-Field Preservation ───────────────────────────────────────────────

const RUN_RECORD_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "format",
  "run",
  "producer",
  "cases",
  "mapping",
  "verification_effects",
]);
const RUN_METADATA_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "id",
  "completed_at",
  "started_at",
  "duration_ms",
]);
const PRODUCER_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "label",
  "command",
  "ci_url",
  "agent_session",
  "actor",
  "code_revision",
  "native",
]);
const CASE_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "id",
  "display_name",
  "suite_path",
  "status",
  "duration_ms",
  "location",
  "diagnostic",
  "refs",
]);
const INDEX_SCHEMA_KEYS: ReadonlySet<string> = new Set(["format", "runs", "latest_run_id"]);

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mergeNestedObject(
  raw: unknown,
  normalized: unknown,
  schemaKeys: ReadonlySet<string>,
): Record<string, unknown> {
  return mergePreservingRawShape(recordObject(raw), recordObject(normalized), schemaKeys);
}

function mergeCaseUnknownFields(
  rawCases: unknown,
  parsedCases: TestResultRunRecord["cases"],
): TestResultRunRecord["cases"] {
  if (!Array.isArray(rawCases)) return parsedCases;
  const rawById = new Map<string, Record<string, unknown>>();
  for (const rawCase of rawCases) {
    if (rawCase && typeof rawCase === "object") {
      const id = (rawCase as Record<string, unknown>).id;
      if (typeof id === "string") rawById.set(id, rawCase as Record<string, unknown>);
    }
  }
  return parsedCases.map((testCase) => {
    const raw = rawById.get(testCase.id);
    if (!raw) return testCase;
    return mergePreservingRawShape(
      raw,
      testCase as unknown as Record<string, unknown>,
      CASE_SCHEMA_KEYS,
    ) as unknown as TestResultRunRecord["cases"][number];
  });
}

function mergeRunRecordForWrite(
  raw: Record<string, unknown> | null,
  parsed: TestResultRunRecord,
): Record<string, unknown> {
  const rawRecord = raw ?? {};
  const normalized = parsed as unknown as Record<string, unknown>;
  const merged = mergePreservingRawShape(rawRecord, normalized, RUN_RECORD_SCHEMA_KEYS);
  merged.format = parsed.format;
  merged.run = mergeNestedObject(rawRecord.run, parsed.run, RUN_METADATA_SCHEMA_KEYS);
  merged.producer = mergeNestedObject(rawRecord.producer, parsed.producer, PRODUCER_SCHEMA_KEYS);
  merged.cases = mergeCaseUnknownFields(rawRecord.cases, parsed.cases);
  merged.mapping = mergeNestedObject(rawRecord.mapping, parsed.mapping, new Set());
  merged.verification_effects = mergeNestedObject(
    rawRecord.verification_effects,
    parsed.verification_effects,
    new Set(),
  );
  return merged;
}

function mergeIndexForWrite(
  raw: Record<string, unknown> | null,
  nextIndex: TestRunIndex,
): Record<string, unknown> {
  return mergePreservingRawShape(
    raw ?? {},
    nextIndex as unknown as Record<string, unknown>,
    INDEX_SCHEMA_KEYS,
  );
}

// ── Index Projection ─────────────────────────────────────────────────────────

function countByStatus(
  cases: TestResultRunRecord["cases"],
  status: TestResultRunRecord["cases"][number]["status"],
): number {
  return cases.filter((testCase) => testCase.status === status).length;
}

export function toTestRunIndexEntry(record: TestResultRunRecord): TestRunIndexEntry {
  const entry: TestRunIndexEntry = {
    path: path.posix.join("runs", record.run.id, TEST_RUN_FILENAME),
    completed_at: record.run.completed_at,
    producer: {
      kind: record.producer.kind,
      label: record.producer.label,
    },
    totals: {
      cases: record.cases.length,
      mapped: record.mapping.attributed.length,
      unmapped: record.mapping.unmapped.length,
      invalid: record.mapping.invalid.length,
      passed: countByStatus(record.cases, "passed"),
      failed: countByStatus(record.cases, "failed"),
      errored: countByStatus(record.cases, "errored"),
      skipped: countByStatus(record.cases, "skipped"),
      unknown: countByStatus(record.cases, "unknown"),
      stamps_written: record.verification_effects.stamps_written.length,
    },
  };
  if (record.producer.code_revision) {
    entry.code_revision = record.producer.code_revision;
  }
  return entry;
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

function selectLatestRunId(runs: Record<string, TestRunIndexEntry>): string | undefined {
  let latestId: string | undefined;
  for (const [id, entry] of Object.entries(runs)) {
    if (!latestId) {
      latestId = id;
      continue;
    }
    if (compareRunOrder(id, entry, latestId, runs[latestId]) > 0) {
      latestId = id;
    }
  }
  return latestId;
}

function normalizeRawIndex(raw: Record<string, unknown> | null): TestRunIndex {
  if (!raw) {
    return { format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT, runs: {} };
  }
  assertRawFormatSupported(raw);
  const parsed = TestRunIndexSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return { format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT, runs: {} };
}

function optionalStringSemanticallyEqual(a: unknown, b: unknown): boolean {
  const aEmpty = a === undefined || a === null || a === "";
  const bEmpty = b === undefined || b === null || b === "";
  if (aEmpty && bEmpty) return true;
  return a === b;
}

export function testRunIndexEntriesEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return (
    a.path === b.path &&
    a.completed_at === b.completed_at &&
    optionalStringSemanticallyEqual(a.code_revision, b.code_revision) &&
    objectsStructurallyEqual(a.producer, b.producer) &&
    objectsStructurallyEqual(a.totals, b.totals)
  );
}

// ── Write API ────────────────────────────────────────────────────────────────

export async function normalizeTestRunForWrite(
  ctx: KspecContext,
  input: TestResultRunRecordInput,
): Promise<TestResultRunRecord> {
  const inputRecord = TestResultRunRecordSchema.parse(TestResultRunRecordInputSchema.parse(input));
  const items = await loadAllItems(ctx);
  const refIndex = new ReferenceIndex([], items);
  const parsed = TestResultRunRecordSchema.parse({
    ...inputRecord,
    mapping: mapTestResultCasesToAcceptanceCriteria(refIndex, items, inputRecord.cases),
  });
  assertRawFormatSupported(parsed);
  UlidSchema.parse(parsed.run.id);
  return parsed;
}

export async function writePreparedTestRun(
  ctx: KspecContext,
  parsed: TestResultRunRecord,
  options: { skipCommit?: boolean } = {},
): Promise<TestResultRunRecord> {
  const runId = parsed.run.id;
  const runDir = getTestRunDir(ctx, runId);
  const runPath = getTestRunFilePath(ctx, runId);
  const indexPath = getTestRunIndexPath(ctx);

  const existingRawRun = await readRawRun(ctx, runId);
  if (existingRawRun) assertRawFormatSupported(existingRawRun);
  const existingRawIndex = await readRawIndex(ctx);
  if (existingRawIndex) assertRawFormatSupported(existingRawIndex);

  await withFileLock(indexPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      const rawRun = await readRawRun(ctx, runId);
      if (rawRun) assertRawFormatSupported(rawRun);
      const rawIndex = await readRawIndex(ctx);
      if (rawIndex) assertRawFormatSupported(rawIndex);

      await mkdirBufferAware(runDir);
      await writeFileBufferAware(runPath, toYaml(mergeRunRecordForWrite(rawRun, parsed)));

      const currentIndex = normalizeRawIndex(rawIndex);
      const runs = { ...currentIndex.runs, [runId]: toTestRunIndexEntry(parsed) };
      const latest_run_id = selectLatestRunId(runs);
      const nextIndex: TestRunIndex = {
        format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
        runs,
        ...(latest_run_id ? { latest_run_id } : {}),
      };
      await mkdirBufferAware(getTestRunStoreRoot(ctx));
      await writeFileBufferAware(indexPath, toYaml(mergeIndexForWrite(rawIndex, nextIndex)));
    });
  });

  if (!options.skipCommit) {
    await commitIfShadow(ctx.shadow, "test result run", `@${runId}`, "ingested normalized run");
  }
  return parsed;
}

export async function writeTestRun(
  ctx: KspecContext,
  input: TestResultRunRecordInput,
  options: { skipCommit?: boolean } = {},
): Promise<TestResultRunRecord> {
  const parsed = await normalizeTestRunForWrite(ctx, input);
  return writePreparedTestRun(ctx, parsed, options);
}

// ── Read API ─────────────────────────────────────────────────────────────────

export async function loadTestRun(
  ctx: KspecContext,
  runId: string,
): Promise<TestResultRunRecord | undefined> {
  if (!isValidUlidDirName(runId)) return undefined;
  const raw = await readRawRun(ctx, runId);
  if (!raw) return undefined;
  assertRawFormatSupported(raw);
  const parsed = TestResultRunRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function loadTestRunIndex(ctx: KspecContext): Promise<TestRunIndex | undefined> {
  const raw = await readRawIndex(ctx);
  if (!raw) return undefined;
  assertRawFormatSupported(raw);
  const parsed = TestRunIndexSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function loadTestRuns(ctx: KspecContext): Promise<TestResultRunRecord[]> {
  let ids: string[] = [];
  const index = await loadTestRunIndex(ctx);
  if (index) {
    ids = Object.keys(index.runs);
  } else {
    ids = await listEntityDirs(ctx, TEST_RUN_LAYOUT);
  }

  const records: TestResultRunRecord[] = [];
  for (const id of ids.toSorted()) {
    const record = await loadTestRun(ctx, id);
    if (record) records.push(record);
  }
  return records;
}

export async function getLatestTestRun(
  ctx: KspecContext,
): Promise<TestResultRunRecord | undefined> {
  const index = await loadTestRunIndex(ctx);
  if (index?.latest_run_id) {
    return loadTestRun(ctx, index.latest_run_id);
  }
  const records = await loadTestRuns(ctx);
  let latest: TestResultRunRecord | undefined;
  for (const record of records) {
    if (
      !latest ||
      compareRunOrder(
        record.run.id,
        toTestRunIndexEntry(record),
        latest.run.id,
        toTestRunIndexEntry(latest),
      ) > 0
    ) {
      latest = record;
    }
  }
  return latest;
}

// ── Index Rebuild / Drift ────────────────────────────────────────────────────

export type TestRunIndexChange = {
  kind: "add" | "update" | "remove_stale";
  ref: string;
  path: string;
};

export type TestRunIndexConflict = {
  code: string;
  ref: string | null;
  path: string | null;
  message: string;
};

export interface TestRunRebuildReport {
  changes: TestRunIndexChange[];
  conflicts: TestRunIndexConflict[];
  folders: number;
  indexEntries: number;
  added: number;
  updated: number;
  removedStale: number;
}

export async function computeTestRunIndexDrift(ctx: KspecContext): Promise<TestRunRebuildReport> {
  const index = (await loadTestRunIndex(ctx)) ?? {
    format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
    runs: {},
  };
  const folderEntries = await readTestRunFolderIds(ctx);
  const folderSet = new Set(folderEntries);
  const changes: TestRunIndexChange[] = [];
  const conflicts: TestRunIndexConflict[] = [];

  for (const runId of folderEntries) {
    const record = await loadTestRun(ctx, runId);
    if (!record) {
      conflicts.push({
        code: "unloadable_test_run_folder",
        ref: runId,
        path: getTestRunDir(ctx, runId),
        message: `Test run folder ${runId} could not be loaded (missing or invalid run.yaml).`,
      });
      continue;
    }
    const rebuiltEntry = toTestRunIndexEntry(record);
    const existingEntry = index.runs[runId];
    if (!existingEntry) {
      changes.push({ kind: "add", ref: runId, path: getTestRunDir(ctx, runId) });
    } else if (
      !testRunIndexEntriesEqual(
        existingEntry as unknown as Record<string, unknown>,
        rebuiltEntry as unknown as Record<string, unknown>,
      )
    ) {
      changes.push({ kind: "update", ref: runId, path: getTestRunDir(ctx, runId) });
    }
  }

  for (const runId of Object.keys(index.runs)) {
    if (!folderSet.has(runId)) {
      changes.push({ kind: "remove_stale", ref: runId, path: getTestRunDir(ctx, runId) });
    }
  }

  const added = changes.filter((change) => change.kind === "add").length;
  const updated = changes.filter((change) => change.kind === "update").length;
  const removedStale = changes.filter((change) => change.kind === "remove_stale").length;
  return {
    changes,
    conflicts,
    folders: folderEntries.length,
    indexEntries: Object.keys(index.runs).length,
    added,
    updated,
    removedStale,
  };
}

export async function rebuildTestRunIndex(ctx: KspecContext): Promise<{ count: number }> {
  const indexPath = getTestRunIndexPath(ctx);
  return withFileLock(indexPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      const rawIndex = await readRawIndex(ctx);
      if (rawIndex) assertRawFormatSupported(rawIndex);
      const runs: Record<string, TestRunIndexEntry> = {};

      const folderIds = await readTestRunFolderIds(ctx);
      for (const runId of folderIds) {
        const record = await loadTestRun(ctx, runId);
        if (record) runs[runId] = toTestRunIndexEntry(record);
      }

      const latest_run_id = selectLatestRunId(runs);
      const nextIndex: TestRunIndex = {
        format: CURRENT_TEST_RESULT_RUN_RECORD_FORMAT,
        runs,
        ...(latest_run_id ? { latest_run_id } : {}),
      };
      await mkdirBufferAware(getTestRunStoreRoot(ctx));
      await writeFileBufferAware(indexPath, toYaml(mergeIndexForWrite(rawIndex, nextIndex)));
    });
    await commitIfShadow(ctx.shadow, "test result run index", "rebuild", "rebuilt index");
    const rebuilt = await loadTestRunIndex(ctx);
    return { count: Object.keys(rebuilt?.runs ?? {}).length };
  });
}

async function readTestRunFolderIds(ctx: KspecContext): Promise<string[]> {
  const root = getTestRunRunsRoot(ctx);
  try {
    const entries = (await readdirBufferAware(root, { withFileTypes: true })) as {
      isDirectory(): boolean;
      name: string;
    }[];
    return entries
      .filter((entry) => entry.isDirectory() && isValidUlidDirName(entry.name))
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    return [];
  }
}

// Utility retained for tests and future CLI wiring.
export async function writeTestRunIndex(ctx: KspecContext, index: TestRunIndex): Promise<void> {
  const indexPath = getTestRunIndexPath(ctx);
  assertRawFormatSupported(index);
  const parsed = TestRunIndexSchema.parse(index);
  await writeYamlFile(indexPath, parsed);
}
