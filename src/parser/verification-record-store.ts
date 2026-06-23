/**
 * Per-acceptance-criterion verification record store.
 *
 * Durable storage for verification stamps, kept as a shadow-branch sidecar:
 *
 *   <specDir>/coverage/verifications/<item-ulid>.yaml
 *
 * One file per spec item, named by the item's canonical ULID, holding the
 * map of acceptance-criterion id → current stamp. Keying by ULID (not slug
 * or source path) means a stamp survives a slug rename or a move to a
 * different spec module file. Spec source files are never touched by a stamp
 * write — verification state lives exclusively in this sidecar.
 *
 * The live record keeps exactly one current stamp per criterion
 * (replace-on-write); superseded stamps remain recoverable through the
 * shadow-branch commit history. Every stamp write commits to the shadow
 * branch through the same `commitIfShadow` path as other metadata mutations,
 * so a fresh checkout of the metadata reproduces the store.
 *
 * The store exposes a programmatic read/write API only — no CLI or daemon
 * endpoints. Orphan tolerance is surfaced to validation through
 * `partitionVerificationReads`.
 *
 * Spec: @ac-verification-record-store
 */

import { access } from "node:fs/promises";
import * as path from "node:path";
import {
  mkdirBufferAware,
  readdirBufferAware,
  runWithBuffer,
  writeFileBufferAware,
} from "../cli/batch-write-buffer.js";
import { AcIdSchema, UlidSchema } from "../schema/common.js";
import {
  CURRENT_VERIFICATION_RECORD_FORMAT,
  VerificationRecordSchema,
  VerificationStampSchema,
  type VerificationRecord,
  type VerificationStamp,
  type VerificationStampInput,
} from "../schema/verification-records.js";
import { commitIfShadow } from "./shadow.js";
import { withFileLock } from "./file-lock.js";
import type { KspecContext } from "./yaml.js";
import { readYamlFile, toYaml } from "./yaml.js";

/** Directory (relative to specDir) that holds per-item verification records. */
export const VERIFICATION_STORE_DIR = path.join("coverage", "verifications");

/** Matches a verification record filename: `<full-ulid>.yaml`. */
const VERIFICATION_FILE_PATTERN = /^([0-9A-HJKMNP-TV-Z]{26})\.yaml$/;

// ── Record-Format Version Ceiling ────────────────────────────────────────────

/**
 * Deterministic error code reserved for a verification record declaring a
 * record-format version newer than this installation supports. The condition
 * will not resolve on retry — only upgrading kspec (or using the newer kspec
 * that wrote the record) can clear it.
 *
 * AC: @coverage-record-compatibility ac-newer-record-format-refused
 */
export const VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE =
  "verification_record_format_newer_than_supported";

/**
 * Deterministic error code for a declared record-format version that cannot be
 * interpreted as a positive integer. Refused rather than silently treated as
 * the oldest format.
 *
 * AC: @coverage-record-compatibility ac-newer-record-format-refused
 */
export const VERIFICATION_RECORD_FORMAT_UNRECOGNIZED_CODE =
  "verification_record_format_unrecognized";

export const DETERMINISTIC_VERIFICATION_RECORD_FORMAT_INCOMPATIBILITY_CODES: ReadonlySet<string> =
  new Set([
    VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE,
    VERIFICATION_RECORD_FORMAT_UNRECOGNIZED_CODE,
  ]);

const VERIFICATION_RECORD_UPGRADE_SUGGESTION =
  "Upgrade your kspec installation to a version that supports this record format, or use the newer kspec version that wrote this verification record.";

/**
 * Error thrown when a verification record declares a record-format version
 * newer than this installation supports, or one that cannot be interpreted as
 * a positive integer. Carries both version values and upgrade guidance. The
 * deterministic code is embedded in the message so consumers that only surface
 * `err.message` still present it.
 *
 * AC: @coverage-record-compatibility ac-newer-record-format-refused
 */
export class VerificationRecordFormatCompatibilityError extends Error {
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
    this.name = "VerificationRecordFormatCompatibilityError";
    this.code = options.code;
    this.declaredVersion = options.declaredVersion;
    this.maxSupportedVersion = CURRENT_VERIFICATION_RECORD_FORMAT;
    this.suggestion = options.suggestion;
  }
}

/**
 * Build the record-format ceiling incompatibility for a RAW declared `format`
 * value, or return null when the value is supported.
 *
 * Semantics, decided on the raw representation:
 *  - `undefined` / `null` (field absent) → null; the missing-field case is
 *    tolerated at the schema layer (the field defaults on write).
 *  - finite positive integer ≤ {@link CURRENT_VERIFICATION_RECORD_FORMAT} →
 *    null (supported).
 *  - finite positive integer > {@link CURRENT_VERIFICATION_RECORD_FORMAT} →
 *    refused as newer-than-supported, naming both versions.
 *  - anything else (non-number, non-finite, non-positive, string) → refused
 *    as unrecognized, naming the literal value.
 *
 * AC: @coverage-record-compatibility ac-newer-record-format-refused
 */
export function describeVerificationRecordFormatIncompatibility(
  declared: unknown,
): VerificationRecordFormatCompatibilityError | null {
  if (declared === undefined || declared === null) return null;

  if (typeof declared !== "number" || !Number.isInteger(declared) || declared <= 0) {
    const literal = typeof declared === "string" ? declared : JSON.stringify(declared);
    return new VerificationRecordFormatCompatibilityError(
      `This verification record declares record-format version "${literal}", which cannot be ` +
        `interpreted as a known verification record format (maximum supported: ` +
        `${CURRENT_VERIFICATION_RECORD_FORMAT}) [${VERIFICATION_RECORD_FORMAT_UNRECOGNIZED_CODE}]. ` +
        `${VERIFICATION_RECORD_UPGRADE_SUGGESTION}`,
      {
        code: VERIFICATION_RECORD_FORMAT_UNRECOGNIZED_CODE,
        declaredVersion: literal,
        suggestion: VERIFICATION_RECORD_UPGRADE_SUGGESTION,
      },
    );
  }

  if (declared > CURRENT_VERIFICATION_RECORD_FORMAT) {
    return new VerificationRecordFormatCompatibilityError(
      `This verification record declares record-format version ${declared}, which is newer than ` +
        `the maximum record format supported by this kspec installation ` +
        `(${CURRENT_VERIFICATION_RECORD_FORMAT}) ` +
        `[${VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE}]. The store was not modified. ` +
        `${VERIFICATION_RECORD_UPGRADE_SUGGESTION}`,
      {
        code: VERIFICATION_RECORD_FORMAT_NEWER_THAN_SUPPORTED_CODE,
        declaredVersion: declared,
        suggestion: VERIFICATION_RECORD_UPGRADE_SUGGESTION,
      },
    );
  }

  return null;
}

/**
 * Extract the raw `format` field from a raw (non-schema-parsed) verification
 * record. Returns undefined when the record is not an object or the field is
 * absent.
 */
function getRawDeclaredRecordFormat(rawRecord: unknown): unknown {
  if (!rawRecord || typeof rawRecord !== "object") return undefined;
  return (rawRecord as Record<string, unknown>).format;
}

/**
 * Throw the record-format ceiling incompatibility for a raw verification
 * record object, if any. Callers pass the record as read from disk BEFORE
 * schema parsing so the missing-field case is genuinely absent.
 *
 * AC: @coverage-record-compatibility ac-newer-record-format-refused
 */
export function assertRawRecordFormatSupported(rawRecord: unknown): void {
  const err = describeVerificationRecordFormatIncompatibility(
    getRawDeclaredRecordFormat(rawRecord),
  );
  if (err) throw err;
}

/**
 * A verification record as loaded from disk, with its owning item ULID
 * (derived from the filename) and source path attached.
 */
export interface LoadedVerificationRecord {
  /** Owning spec item ULID — the canonical key the stamp resolves against. */
  itemUlid: string;
  /** The parsed record (format + current stamps). */
  record: VerificationRecord;
  /** Absolute path to the record file. */
  _sourceFile: string;
}

// ── Path Helpers ─────────────────────────────────────────────────────────────

/** Absolute path to the verification store root (`<specDir>/coverage/verifications/`). */
export function getVerificationStoreRoot(ctx: KspecContext): string {
  return path.join(ctx.specDir, VERIFICATION_STORE_DIR);
}

/** Absolute path to one item's verification record file. */
export function getVerificationRecordPath(ctx: KspecContext, itemUlid: string): string {
  return path.join(getVerificationStoreRoot(ctx), `${itemUlid}.yaml`);
}

// ── Raw Read Helpers ─────────────────────────────────────────────────────────

/**
 * Read the raw on-disk record object for an item without schema validation,
 * so a stamp write can replace a single AC entry while preserving the
 * record's other entries, its declared format, and any forward-compatible
 * extension fields. Returns `null` when the file is absent or unreadable.
 */
async function readRawRecord(
  ctx: KspecContext,
  itemUlid: string,
): Promise<Record<string, unknown> | null> {
  const recordPath = getVerificationRecordPath(ctx, itemUlid);
  try {
    const raw = await readYamlFile<unknown>(recordPath);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
  } catch {
    // Missing or unparseable — caller starts a fresh record.
  }
  return null;
}

// ── Write API ──────────────────────────────────────────────────────────────────

/**
 * Write (or replace) the current verification stamp for one acceptance
 * criterion of one spec item.
 *
 * The incoming stamp is schema-validated BEFORE any disk write — a stamp
 * missing `verified_at`, `actor`, or `provenance` throws and leaves the
 * stored verification state unchanged. On success the stamp replaces any
 * prior stamp for that criterion; the prior value is recoverable only from
 * the shadow-branch commit history, never from the live record. The store
 * directory and the item's record file materialize on first write.
 *
 * The write runs inside a buffered transaction and then commits to the
 * shadow branch, so every stamp write is one shadow commit.
 *
 * AC: @ac-verification-record-store ac-stamp-read-back
 * AC: @ac-verification-record-store ac-incomplete-stamp-rejected
 * AC: @ac-verification-record-store ac-current-stamp-replacement
 * AC: @ac-verification-record-store ac-spec-source-untouched
 * AC: @ac-verification-record-store ac-versioned-persistence
 */
export async function writeVerificationStamp(
  ctx: KspecContext,
  itemUlid: string,
  acId: string,
  stamp: VerificationStampInput,
): Promise<VerificationStamp> {
  const parsed = await runWithBuffer(ctx.specDir, async () =>
    writeVerificationStampWithoutCommit(ctx, itemUlid, acId, stamp),
  );

  // Shadow commit AFTER flush — the record file is on disk atomically.
  await commitIfShadow(ctx.shadow, "verification stamp", `@${itemUlid}`, `${acId} verified`);

  return parsed;
}

/**
 * Write (or replace) a verification stamp without creating a shadow commit.
 *
 * This is for higher-level metadata mutations that need verification effects
 * to be flushed and committed together with another sidecar write. It uses the
 * same validation, locking, record-format checks, and buffer-aware filesystem
 * operations as `writeVerificationStamp`; the caller owns the surrounding
 * buffered transaction and final commit.
 */
export async function writeVerificationStampWithoutCommit(
  ctx: KspecContext,
  itemUlid: string,
  acId: string,
  stamp: VerificationStampInput,
): Promise<VerificationStamp> {
  // Validate the keys BEFORE constructing any filesystem path. An unvalidated
  // itemUlid is interpolated into the record path, so a traversal value like
  // `../../modules/specs` would otherwise resolve outside the store and could
  // overwrite spec source. Rejecting malformed keys here keeps writes confined
  // to `coverage/verifications/<ulid>.yaml` and leaves stored state untouched.
  UlidSchema.parse(itemUlid);
  AcIdSchema.parse(acId);

  // Validate the stamp — rejection must not touch stored state.
  const parsed = VerificationStampSchema.parse(stamp);

  const recordPath = getVerificationRecordPath(ctx, itemUlid);
  const storeRoot = getVerificationStoreRoot(ctx);

  // Read the existing record (if any) outside the buffered transaction so the
  // record-format ceiling check refuses BEFORE any buffered or on-disk write.
  // A newer-than-supported record refuses the write with both versions named
  // and leaves stored state untouched.
  //
  // AC: @coverage-record-compatibility ac-newer-record-format-refused
  const existingRaw = await readRawRecord(ctx, itemUlid);
  if (existingRaw) {
    assertRawRecordFormatSupported(existingRaw);
  }

  await withFileLock(recordPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      await mkdirBufferAware(storeRoot);

      // Re-read inside the buffer in case a concurrent writer modified the
      // record between the pre-check and the lock acquisition; the format
      // ceiling is enforced again on this read for defense in depth.
      const raw = (await readRawRecord(ctx, itemUlid)) ?? {};
      if (raw.format !== undefined && raw.format !== null) {
        assertRawRecordFormatSupported(raw);
      }
      const format =
        typeof raw.format === "number" && Number.isInteger(raw.format) && raw.format > 0
          ? raw.format
          : CURRENT_VERIFICATION_RECORD_FORMAT;
      const acs =
        raw.acs && typeof raw.acs === "object" && !Array.isArray(raw.acs)
          ? { ...(raw.acs as Record<string, unknown>) }
          : {};

      // Replace-on-write: the AC's current stamp is overwritten in place.
      acs[acId] = parsed;

      const next: Record<string, unknown> = { ...raw, format, acs };
      await writeFileBufferAware(recordPath, toYaml(next));
    });
  });

  return parsed;
}

// ── Read API ─────────────────────────────────────────────────────────────────

/**
 * Outcome of a single-record load, reported with enough detail for the bulk
 * scan (`loadVerificationRecords`) to propagate format-incompatible records
 * rather than silently dropping them.
 */
type LoadRecordOutcome =
  | { status: "ok"; record: VerificationRecord }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "format_error"; error: VerificationRecordFormatCompatibilityError };

/**
 * Read one item's record file and apply the record-format ceiling, returning
 * a tagged outcome so direct and bulk callers surface the same refusal.
 */
async function loadVerificationRecordInternal(
  ctx: KspecContext,
  itemUlid: string,
): Promise<LoadRecordOutcome> {
  const recordPath = getVerificationRecordPath(ctx, itemUlid);
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(recordPath);
  } catch {
    return { status: "missing" };
  }
  // Enforce the record-format ceiling BEFORE schema parsing so a
  // newer-than-supported record is refused with both versions named rather
  // than silently passing (the schema accepts any positive integer).
  const formatError = describeVerificationRecordFormatIncompatibility(
    getRawDeclaredRecordFormat(raw),
  );
  if (formatError) {
    return { status: "format_error", error: formatError };
  }
  const result = VerificationRecordSchema.safeParse(raw);
  return result.success ? { status: "ok", record: result.data } : { status: "invalid" };
}

/**
 * Read one item's verification record, schema-validated. Returns `undefined`
 * when no record file exists or the file does not parse against the schema.
 *
 * A record declaring a newer-than-supported record-format version refuses
 * with a {@link VerificationRecordFormatCompatibilityError} naming both the
 * declared version and the maximum supported version. Both read paths
 * (this single-record load and the bulk `loadVerificationRecords` scan)
 * refuse on the same condition — the store's read operation refuses as a
 * whole, never silently dropping the incompatible record. Callers that do
 * not involve the store (e.g., `kspec task list`) are unaffected because
 * they never reach this path.
 *
 * AC: @coverage-record-compatibility ac-newer-record-format-refused
 */
export async function loadVerificationRecord(
  ctx: KspecContext,
  itemUlid: string,
): Promise<VerificationRecord | undefined> {
  const outcome = await loadVerificationRecordInternal(ctx, itemUlid);
  if (outcome.status === "format_error") throw outcome.error;
  if (outcome.status === "ok") return outcome.record;
  return undefined;
}

/**
 * Read the current verification stamp for a single acceptance criterion, or
 * `undefined` when none is stored.
 *
 * AC: @ac-verification-record-store ac-stamp-read-back
 * AC: @ac-verification-record-store ac-current-stamp-replacement
 */
export async function readVerificationStamp(
  ctx: KspecContext,
  itemUlid: string,
  acId: string,
): Promise<VerificationStamp | undefined> {
  const record = await loadVerificationRecord(ctx, itemUlid);
  return record?.acs[acId];
}

/**
 * Load every verification record in the store. Records whose item ULID or
 * AC ids no longer resolve still load here — they are filtered out of
 * resolved reads (and surfaced as orphans) by `partitionVerificationReads`,
 * never silently dropped. Files that are not named by a full ULID or that
 * fail schema validation are skipped.
 *
 * A record declaring a newer-than-supported record-format version refuses
 * the whole scan with a {@link VerificationRecordFormatCompatibilityError}
 * naming both versions. The bulk read is a public store read path, so the
 * refusal surfaces here — it is not absorbed per-file. Operations that do
 * not involve the store (e.g., `kspec task list`) never reach this path and
 * are unaffected; operations that do involve the store (e.g.,
 * `validate --completeness`'s orphan scan) propagate the refusal.
 *
 * AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
 * AC: @coverage-record-compatibility ac-newer-record-format-refused
 */
export async function loadVerificationRecords(
  ctx: KspecContext,
): Promise<LoadedVerificationRecord[]> {
  const storeRoot = getVerificationStoreRoot(ctx);
  let entries: string[];
  try {
    entries = (await readdirBufferAware(storeRoot)) as string[];
  } catch {
    return [];
  }

  const loaded: LoadedVerificationRecord[] = [];
  for (const entry of entries) {
    const match = VERIFICATION_FILE_PATTERN.exec(entry);
    if (!match) continue;
    const itemUlid = match[1];
    const outcome = await loadVerificationRecordInternal(ctx, itemUlid);
    if (outcome.status === "format_error") {
      // The store is declaring a newer-than-supported record format. The
      // bulk read is a public store read path, so refuse with both versions
      // named rather than silently dropping the incompatible record.
      throw outcome.error;
    }
    if (outcome.status === "ok") {
      loaded.push({ itemUlid, record: outcome.record, _sourceFile: path.join(storeRoot, entry) });
    }
    // missing / invalid → skip silently; these are not format-gate refusals
    // and unrelated records continue to load.
  }
  return loaded;
}

// ── Resolution / Orphan Partitioning ────────────────────────────────────────

/** A stamp whose item ULID and AC id both resolve to a live acceptance criterion. */
export interface ResolvedVerification {
  itemUlid: string;
  acId: string;
  stamp: VerificationStamp;
}

/** Why a stored stamp could not be resolved against the live spec corpus. */
export type OrphanedVerificationReason = "unknown_item" | "unknown_ac";

/** A stamp whose item ULID or AC id no longer resolves to a live criterion. */
export interface OrphanedVerification {
  itemUlid: string;
  acId: string;
  reason: OrphanedVerificationReason;
}

/** The split between resolved verification reads and orphaned records. */
export interface VerificationReadPartition {
  resolved: ResolvedVerification[];
  orphans: OrphanedVerification[];
}

/**
 * Partition loaded verification records into resolved reads and orphans
 * against the set of live acceptance criteria.
 *
 * `validCriteria` maps each live item ULID to the set of acceptance-criterion
 * ids that currently exist on it (own ACs plus inherited trait ACs). A stamp
 * whose item ULID is absent from the map is an `unknown_item` orphan; a stamp
 * whose AC id is absent from the item's set is an `unknown_ac` orphan.
 * Resolved reads exclude every orphan; orphans are reported, not dropped.
 *
 * AC: @ac-verification-record-store ac-keyed-by-canonical-identity
 * AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
 */
export function partitionVerificationReads(
  records: readonly LoadedVerificationRecord[],
  validCriteria: ReadonlyMap<string, ReadonlySet<string>>,
): VerificationReadPartition {
  const resolved: ResolvedVerification[] = [];
  const orphans: OrphanedVerification[] = [];

  for (const { itemUlid, record } of records) {
    const acIds = validCriteria.get(itemUlid);
    for (const [acId, stamp] of Object.entries(record.acs)) {
      if (!acIds) {
        orphans.push({ itemUlid, acId, reason: "unknown_item" });
      } else if (!acIds.has(acId)) {
        orphans.push({ itemUlid, acId, reason: "unknown_ac" });
      } else {
        resolved.push({ itemUlid, acId, stamp });
      }
    }
  }

  return { resolved, orphans };
}

// ── Session Linkage Resolution ───────────────────────────────────────────────

/**
 * The verification stamp's session-linkage state — a tri-state report of
 * whether the stored record names a session, and whether that session still
 * exists in the project's session store.
 *
 * - `none`         — the stamp was written without a session reference.
 * - `recorded`     — the stamp names a session, and that session exists in
 *                    the session store. The session id is the canonical
 *                    identity of the producing session.
 * - `unresolvable` — the stamp names a session, but the session can no
 *                    longer be found in the session store (pruned or
 *                    otherwise gone). The session id is still reported so
 *                    consumers know which session the stamp referenced;
 *                    the record remains a valid verification.
 *
 * AC: @verification-session-evidence ac-sessionless-stamps-valid
 * AC: @verification-session-evidence ac-pruned-session-tolerated
 */
export type SessionLinkageState =
  | { kind: "none" }
  | { kind: "recorded"; sessionId: string }
  | { kind: "unresolvable"; sessionId: string };

/** A verification stamp plus the resolved state of its session linkage. */
export interface VerificationStampWithLinkage extends VerificationStamp {
  sessionLinkage: SessionLinkageState;
}

/**
 * Returns true if the named session exists in the project's session store
 * (a `session.yaml` file under `ctx.sessionsDir/{sessionId}/`). The check is
 * a tolerant directory probe — a missing sessions root, missing session
 * directory, or missing metadata file all resolve to `false`. The session
 * store can be local (`.kspec-sessions/`) or a git worktree; both are
 * accessed through `ctx.sessionsDir` so this check is layout-agnostic.
 *
 * The probe is inlined here rather than delegated to `sessions/store.ts` so
 * this module stays package-safe: importing from the session store would
 * pull the broader session module graph (parser/session-branch, agent-
 * runtime/session-event-fields) into the verification-record read path and
 * the daemon's eager-load surface. The path layout mirrors the session
 * store's `getSessionMetadataPath` (`<sessionsDir>/<sessionId>/session.yaml`).
 *
 * AC: @verification-session-evidence ac-pruned-session-tolerated
 */
export async function isSessionResolvable(ctx: KspecContext, sessionId: string): Promise<boolean> {
  const metadataPath = path.join(ctx.sessionsDir, sessionId, "session.yaml");
  try {
    await access(metadataPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the session linkage for a stored session reference.
 *
 * The store keeps a session id, not a session record, so resolution is a
 * tolerant existence check against the session store: a missing session
 * reports `unresolvable` (preserving the id), a present session reports
 * `recorded`, and a session id of `undefined` reports `none`. The function
 * never throws on a missing session — pruning is an expected lifecycle
 * event and must not break stamp reads.
 *
 * AC: @verification-session-evidence ac-pruned-session-tolerated
 */
export async function resolveSessionLinkage(
  ctx: KspecContext,
  sessionId: string | undefined,
): Promise<SessionLinkageState> {
  if (sessionId === undefined) {
    return { kind: "none" };
  }
  const resolvable = await isSessionResolvable(ctx, sessionId);
  return resolvable ? { kind: "recorded", sessionId } : { kind: "unresolvable", sessionId };
}

/**
 * Read the current verification stamp for one acceptance criterion, with
 * its session linkage resolved against the session store.
 *
 * The basic `readVerificationStamp` returns the stamp as recorded — the
 * stored session id is the producing session's identity, readable from
 * the record alone without consulting session logs or other records
 * (ac-evidence-readable-from-record). This variant adds the linkage
 * resolution status (`recorded` if the session is still present,
 * `unresolvable` if it has been pruned) so consumers can answer
 * "does this stamp still link to a live session" without rebuilding
 * the lookup themselves. A pruned session does not fail the read —
 * the stamp remains a valid verification; only the linkage is
 * reported as unresolvable.
 *
 * AC: @verification-session-evidence ac-evidence-readable-from-record
 * AC: @verification-session-evidence ac-pruned-session-tolerated
 */
export async function readVerificationStampWithLinkage(
  ctx: KspecContext,
  itemUlid: string,
  acId: string,
): Promise<VerificationStampWithLinkage | undefined> {
  const stamp = await readVerificationStamp(ctx, itemUlid, acId);
  if (!stamp) return undefined;
  const sessionLinkage = await resolveSessionLinkage(ctx, stamp.session);
  return { ...stamp, sessionLinkage };
}
