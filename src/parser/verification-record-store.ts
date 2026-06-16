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

  await withFileLock(recordPath, async () => {
    await runWithBuffer(ctx.specDir, async () => {
      await mkdirBufferAware(storeRoot);

      const raw = (await readRawRecord(ctx, itemUlid)) ?? {};
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

  // Shadow commit AFTER flush — the record file is on disk atomically.
  await commitIfShadow(ctx.shadow, "verification stamp", `@${itemUlid}`, `${acId} verified`);

  return parsed;
}

// ── Read API ─────────────────────────────────────────────────────────────────

/**
 * Read one item's verification record, schema-validated. Returns `undefined`
 * when no record file exists or the file does not parse against the schema.
 */
export async function loadVerificationRecord(
  ctx: KspecContext,
  itemUlid: string,
): Promise<VerificationRecord | undefined> {
  const recordPath = getVerificationRecordPath(ctx, itemUlid);
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(recordPath);
  } catch {
    return undefined;
  }
  const result = VerificationRecordSchema.safeParse(raw);
  return result.success ? result.data : undefined;
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
 * Load every verification record in the store, tolerantly. Records whose
 * item ULID or AC ids no longer resolve still load here — they are filtered
 * out of resolved reads (and surfaced as orphans) by
 * `partitionVerificationReads`, never silently dropped. Files that are not
 * named by a full ULID, or that fail schema validation, are skipped.
 *
 * AC: @ac-verification-record-store ac-unresolvable-keys-tolerated
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
    const record = await loadVerificationRecord(ctx, itemUlid);
    if (record) {
      loaded.push({ itemUlid, record, _sourceFile: path.join(storeRoot, entry) });
    }
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
