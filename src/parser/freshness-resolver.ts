/**
 * Per-acceptance-criterion freshness resolution.
 *
 * Resolves an AC's annotation freshness from two provenance sources:
 *  - "bootstrap" — derived on read from version-control history of the
 *    annotation's location, so existing annotations have freshness from day
 *    one with no prior bookkeeping.
 *  - "recorded" — the currently-stored verification stamp, returned verbatim
 *    when present and never compared against the bootstrap value.
 *
 * The resolver is a pure read API: it never writes to the verification
 * record store, never caches, and never reaches into the spec corpus
 * beyond what the structured annotation scan already produced. The
 * coverage-state engine (a later plan) consumes these values; this
 * module is the storage layer's read contract per
 * @annotation-freshness-provenance.
 *
 * Spec: @ac-freshness-resolution
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import type { VerificationStamp } from "../schema/verification-records.js";
import type { KspecContext } from "./yaml.js";
import { readVerificationStamp } from "./verification-record-store.js";

const execFileAsync = promisify(execFile);

// ── Public types ──────────────────────────────────────────────────────────

/** Where a freshness value came from. Recorded values also carry the stamp's provenance class. */
export type FreshnessProvenanceSource = "bootstrap" | "recorded";

/** A freshness value derived from version-control history of an annotation's location. */
export interface BootstrapFreshnessValue {
  source: "bootstrap";
  /** ISO 8601 committer timestamp; null only when the commit metadata could not be read. */
  timestamp: string | null;
  /** Full 40-character commit SHA; null when the line has no version-control history. */
  commit: string | null;
}

/**
 * A freshness value derived from a stored verification stamp. The full stamp
 * is attached so consumers can read the stamp's provenance class and other
 * fields without a second store lookup.
 */
export interface RecordedFreshnessValue {
  source: "recorded";
  /** ISO 8601 verification time, taken verbatim from the stamp's `verified_at`. */
  timestamp: string;
  /** Commit reference from the stamp's optional `commit` field, or null. */
  commit: string | null;
  stamp: VerificationStamp;
}

export type FreshnessValue = BootstrapFreshnessValue | RecordedFreshnessValue;

/** A freshness resolution result — absence is its own kind, not a fabricated value. */
export type ResolvedFreshness = { kind: "absent" } | { kind: "freshness"; value: FreshnessValue };

/**
 * A freshness resolution that returns the recorded and bootstrap values side
 * by side when both exist. Either side may be null; absence is reported only
 * when both are null.
 */
export type ResolvedFreshnessWithBoth =
  | { kind: "absent" }
  | {
      kind: "freshness";
      recorded: RecordedFreshnessValue | null;
      bootstrap: BootstrapFreshnessValue | null;
    };

/** An annotation location for bootstrap derivation — file path plus 1-based line number. */
export interface AnnotationLocation {
  file: string;
  line: number;
}

// ── Bootstrap derivation ──────────────────────────────────────────────────

/**
 * Derive a bootstrap freshness value from version-control history of the
 * given annotation locations.
 *
 * The most recent of the history values is returned. Locations without
 * history contribute no value; when every location lacks history, the
 * result is null. The returned value is never written anywhere — bootstrap
 * is always derived on read.
 *
 * AC: @ac-freshness-resolution ac-multi-annotation-most-recent
 * AC: @ac-freshness-resolution ac-no-history-absence
 */
export async function resolveAcBootstrap(
  ctx: KspecContext,
  annotations: readonly AnnotationLocation[],
): Promise<BootstrapFreshnessValue | null> {
  if (annotations.length === 0) return null;

  const byFile = groupLocationsByFile(annotations);
  const fileResults = await Promise.all(
    Array.from(byFile, ([file, lines]) => blameLines(ctx, file, lines)),
  );

  const candidates: BootstrapFreshnessValue[] = [];
  for (const lineBlames of fileResults) {
    for (const blame of lineBlames) {
      if (blame) candidates.push(blame);
    }
  }
  if (candidates.length === 0) return null;
  return pickMostRecent(candidates);
}

// ── Default resolution ────────────────────────────────────────────────────

/**
 * Resolve an AC's freshness per the standard precedence: a recorded
 * verification stamp wins when present, otherwise a bootstrap value from
 * annotation history, otherwise absence.
 *
 * The bootstrap value is never compared to the stamp — when a stamp
 * exists, the resolver returns it verbatim regardless of whether the
 * annotation's history is newer.
 *
 * AC: @ac-freshness-resolution ac-bootstrap-when-unstamped
 * AC: @ac-freshness-resolution ac-recorded-supersedes-bootstrap
 * AC: @ac-freshness-resolution ac-timestamp-or-commit
 * AC: @ac-freshness-resolution ac-absence-reported
 */
export async function resolveAcFreshness(
  ctx: KspecContext,
  itemUlid: string,
  acId: string,
  annotations: readonly AnnotationLocation[],
): Promise<ResolvedFreshness> {
  const recorded = await readVerificationStamp(ctx, itemUlid, acId);
  if (recorded) {
    return {
      kind: "freshness",
      value: stampToRecordedValue(recorded),
    };
  }
  const bootstrap = await resolveAcBootstrap(ctx, annotations);
  if (bootstrap) {
    return { kind: "freshness", value: bootstrap };
  }
  return { kind: "absent" };
}

// ── Both-provenances resolution ───────────────────────────────────────────

/**
 * Resolve an AC's freshness, returning the recorded stamp and the bootstrap
 * value side by side when both exist, each labeled with its provenance
 * source.
 *
 * Resolution neither alters nor compares the two values: the consumer that
 * needs to ask "is the stamp older than later annotation edits?" performs
 * that comparison itself. When only one provenance has a value, only that
 * side is populated. When neither has a value, the result is absence.
 *
 * AC: @ac-freshness-resolution ac-both-provenances-retrievable
 * AC: @ac-freshness-resolution ac-recorded-supersedes-bootstrap
 * AC: @ac-freshness-resolution ac-no-history-absence
 * AC: @ac-freshness-resolution ac-absence-reported
 */
export async function resolveAcFreshnessWithBoth(
  ctx: KspecContext,
  itemUlid: string,
  acId: string,
  annotations: readonly AnnotationLocation[],
): Promise<ResolvedFreshnessWithBoth> {
  const [recorded, bootstrap] = await Promise.all([
    readVerificationStamp(ctx, itemUlid, acId),
    resolveAcBootstrap(ctx, annotations),
  ]);
  if (!recorded && !bootstrap) return { kind: "absent" };
  return {
    kind: "freshness",
    recorded: recorded ? stampToRecordedValue(recorded) : null,
    bootstrap,
  };
}

// ── Internals ─────────────────────────────────────────────────────────────

function stampToRecordedValue(stamp: VerificationStamp): RecordedFreshnessValue {
  return {
    source: "recorded",
    timestamp: stamp.verified_at,
    commit: stamp.commit ?? null,
    stamp,
  };
}

function groupLocationsByFile(annotations: readonly AnnotationLocation[]): Map<string, number[]> {
  const byFile = new Map<string, number[]>();
  for (const { file, line } of annotations) {
    let arr = byFile.get(file);
    if (!arr) {
      arr = [];
      byFile.set(file, arr);
    }
    arr.push(line);
  }
  return byFile;
}

/** A line's blame — null when the line has no version-control history. */
type LineBlame = BootstrapFreshnessValue | null;

const UNCOMMITTED_SHA = "0".repeat(40);

/**
 * Run git blame for a batch of lines in a single file.
 *
 * Returns an array of the same length as the input (after de-duplication);
 * each entry is null when the corresponding line has no version-control
 * history (uncommitted file, a new line in the working tree, or a file the
 * repository does not track). Batched per file to keep the git call count
 * bounded — a single file with N annotations costs one blame invocation,
 * not N.
 */
async function blameLines(
  ctx: KspecContext,
  file: string,
  lines: readonly number[],
): Promise<LineBlame[]> {
  const uniqueLines = Array.from(new Set(lines));
  if (uniqueLines.length === 0) return [];

  const repoRoot = ctx.rootDir;
  const relPath = path.isAbsolute(file) ? path.relative(repoRoot, file) : file;
  const args: string[] = ["blame", "--line-porcelain"];
  for (const line of uniqueLines) args.push("-L", `${line},${line}`);
  args.push("--", relPath);

  let stdout: string;
  try {
    const result = await execFileAsync("git", args, {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch {
    // Repo missing, file not tracked, or path traversal — every line is "no history".
    return uniqueLines.map(() => null);
  }

  return parseBlamePorcelain(stdout, uniqueLines);
}

/**
 * Parse `git blame --line-porcelain` output into per-line records.
 *
 * Each record begins with a header `<sha> <orig-line> <final-line> [<count>]`,
 * followed by `key value` metadata lines, and ends with a tab-prefixed source
 * line. When multiple `-L` ranges are batched into a single invocation, git
 * emits the records contiguously — there is no blank-line separator between
 * them, so splitting on `\n\n` only ever yields the first record. Instead we
 * walk the output line by line and detect record boundaries by the header
 * pattern (a 40-char hex SHA followed by two integers). Source lines start
 * with a tab and never match that pattern, so they cannot be mistaken for a
 * new header. The `committer-time` field gives the unix timestamp the line
 * was last touched by a commit; the all-zero SHA marks uncommitted lines.
 */
function parseBlamePorcelain(stdout: string, lines: readonly number[]): LineBlame[] {
  const results: LineBlame[] = [];
  const headerRe = /^([0-9a-f]{40}) \d+ \d+/;
  let currentSha: string | null = null;
  let currentTime: number | null = null;

  for (const ln of stdout.split("\n")) {
    const m = ln.match(headerRe);
    if (m) {
      if (currentSha !== null) pushBlameRecord(results, currentSha, currentTime);
      currentSha = m[1]!;
      currentTime = null;
      continue;
    }
    if (currentSha === null) continue;
    if (ln.startsWith("committer-time ")) {
      const n = Number(ln.slice("committer-time ".length));
      if (Number.isFinite(n)) currentTime = n;
    }
  }
  if (currentSha !== null) pushBlameRecord(results, currentSha, currentTime);

  while (results.length < lines.length) results.push(null);
  return results;
}

function pushBlameRecord(results: LineBlame[], sha: string, time: number | null): void {
  if (sha === UNCOMMITTED_SHA) {
    results.push(null);
    return;
  }
  const timestamp = time !== null ? new Date(time * 1000).toISOString() : null;
  results.push({ source: "bootstrap", commit: sha, timestamp });
}

function pickMostRecent(values: BootstrapFreshnessValue[]): BootstrapFreshnessValue {
  let best = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    if (compareBootstrap(v, best) > 0) best = v;
  }
  return best;
}

/**
 * Compare two bootstrap freshness values for "most recent". ISO 8601
 * timestamps sort lexicographically; null is treated as oldest. Commit SHAs
 * are used as a stable tie-breaker.
 */
function compareBootstrap(a: BootstrapFreshnessValue, b: BootstrapFreshnessValue): number {
  if (a.timestamp && b.timestamp) {
    if (a.timestamp > b.timestamp) return 1;
    if (a.timestamp < b.timestamp) return -1;
  } else if (a.timestamp) {
    return 1;
  } else if (b.timestamp) {
    return -1;
  }
  if (a.commit && b.commit) {
    if (a.commit > b.commit) return 1;
    if (a.commit < b.commit) return -1;
  } else if (a.commit) {
    return 1;
  } else if (b.commit) {
    return -1;
  }
  return 0;
}
