/**
 * Historical actor normalization migration.
 *
 * A one-time upgrade step that rewrites historical actor fields across every
 * stored record kind to canonical identities. It is driven by the exhaustive
 * actor-field inventory (`actor-field-inventory.ts`) so every actor-bearing
 * storage path is either normalized or explicitly out of scope, and it fails
 * closed if a future schema field that looks actor-bearing is not classified.
 *
 * Resolution order for each actor value (highest precedence first):
 *   1. Built-in variant map — the shared actor classifier, configured from the
 *      project's identity (human author + canonical agent roster + non-derivable
 *      aliases). Recognizable variants resolve to their canonical identity.
 *   2. Operator-provided mapping — an optional file that resolves additional
 *      ambiguous historical values the classifier leaves unknown. Each mapping
 *      target must itself reduce to a canonical identity (recognizable aliases
 *      are normalized to their canonical id) or a declared default; a target
 *      that is neither fails the run closed so a typo cannot persist a
 *      non-canonical actor string.
 *   3. Declared default — the per-record-kind unknown/default actor, used when
 *      neither the variant map nor the operator mapping resolves the value. The
 *      original value is preserved in the report.
 *
 * Empty / absent values (null, undefined, blank strings) are never rewritten:
 * an unresolved thread (`resolved_by: null`) or an unassigned task
 * (`assignee: null`) is a semantic state, not a historical actor string.
 *
 * Canonical identities and the declared default are fixed points of the
 * resolver (they resolve to themselves), so re-running the step on an
 * already-normalized project changes nothing.
 *
 * AC: @actor-history-normalization ac-1 — recognizable variants → canonical
 * AC: @actor-history-normalization ac-2 — unresolved → declared default, original reported
 * AC: @actor-history-normalization ac-3 — idempotent (canonical values are fixed points)
 * AC: @actor-history-normalization ac-4 — preview mode reports without modifying
 * AC: @actor-history-normalization ac-5 — every inventoried field ends canonical-or-default
 * AC: @actor-history-normalization ac-6 — driven by the exhaustive inventory, fails closed
 * AC: @actor-identity-model ac-2 — historical records resolve once through this path
 */

import * as path from "node:path";

import { buildActorClassifier } from "@kynetic-ai/shared";
import type { ActorIdentityConfig, ClassifiedActor } from "@kynetic-ai/shared";

import {
  type ActorRecordKind,
  ACTOR_RECORD_KINDS,
  assertInventoryCoversSchemas,
  isActorRecordKind,
  normalizeFieldPathsFor,
} from "./actor-field-inventory.js";
import { buildActorIdentityConfig } from "../identity/actor-identity-config.js";
import { writeFileBufferAware } from "../cli/batch-write-buffer.js";
import { readYamlFile } from "./yaml.js";
import type { KspecContext } from "./yaml.js";

/**
 * Default declared unknown/default actor used when no rule resolves a value and
 * no per-record-kind override is declared. Distinct from any configured human
 * or agent identity so identity-derived views can treat it separately.
 *
 * AC: @actor-identity-model ac-3 — declared default is distinct from configured actors
 */
export const DEFAULT_UNKNOWN_ACTOR = "@unknown";

/**
 * Declared per-record-kind default actors. Empty by default — every kind falls
 * back to {@link DEFAULT_UNKNOWN_ACTOR}. The structure exists so a project (or a
 * future package decision) can declare a different default for a specific record
 * kind without touching the resolver. Operator-map `defaults` override these.
 */
export const DECLARED_DEFAULT_ACTORS: Partial<Record<ActorRecordKind, string>> = {};

/** How a rewritten value was resolved. */
export type ActorResolutionSource = "variant_map" | "operator_mapping" | "default";

/** A single actor-field rewrite recorded in the report. */
export interface ActorRewrite {
  recordKind: ActorRecordKind;
  /** Record identity (ULID or slug) for audit. */
  recordRef: string;
  /** Concrete field path with array indices, e.g. `threads[0].entries[2].author`. */
  fieldPath: string;
  /** The original recorded actor string. */
  original: string;
  /** The canonical identity or declared default it was rewritten to. */
  resolved: string;
  /** Which resolution rule produced the result. */
  resolutionSource: ActorResolutionSource;
}

/**
 * A record kind whose storage could not be read during a preview, deferred
 * rather than aborting the whole run.
 */
export interface ActorDeferredKind {
  recordKind: ActorRecordKind;
  /** Why the kind could not be loaded (e.g. its storage is not yet promoted). */
  reason: string;
}

/** Full report of a normalization run. */
export interface ActorNormalizationReport {
  /** True when the run was a preview (no records modified). */
  dryRun: boolean;
  /** ISO timestamp the report was generated (stamped by the caller/CLI). */
  generatedAt?: string;
  /** Number of records scanned across all record kinds. */
  recordsScanned: number;
  /** Number of records actually modified (always 0 in dry-run). */
  recordsModified: number;
  /** Number of actor-field values that would be / were rewritten. */
  rewriteCount: number;
  /** Every individual rewrite (original → resolved) with provenance. */
  rewrites: ActorRewrite[];
  /** Distinct original values that no rule resolved (fell to the default). */
  unresolvedOriginals: string[];
  /** Record kinds the run scanned. */
  recordKindsCovered: ActorRecordKind[];
  /**
   * Record kinds skipped during a preview because their storage could not be
   * read yet (e.g. a legacy project previewed with --dry-run before the
   * upgrade's storage migration has promoted that kind's layout). Always empty
   * for a real run, which only executes after storage promotion succeeds.
   */
  deferredKinds: ActorDeferredKind[];
}

/** Operator-provided mapping for ambiguous historical actor values. */
export interface OperatorActorMap {
  /**
   * Original recorded value → canonical identity. The target must reduce to a
   * canonical identity (recognizable aliases are normalized to their canonical
   * id) or a declared default; non-canonical targets are rejected by the
   * resolver (see {@link OperatorActorMapError}).
   */
  mappings: Record<string, string>;
  /** Optional per-record-kind default overrides. */
  defaults?: Partial<Record<ActorRecordKind, string>>;
}

const EMPTY_OPERATOR_MAP: OperatorActorMap = { mappings: {} };

/**
 * Load an operator-provided actor mapping file. Accepts YAML or JSON with a
 * top-level `mappings` object (original → canonical) and optional `defaults`
 * (record kind → default actor). Throws a descriptive error if the file is
 * present but malformed, so an operator typo cannot silently no-op.
 */
export async function loadOperatorActorMap(filePath: string): Promise<OperatorActorMap> {
  let raw: unknown;
  try {
    raw = await readYamlFile<unknown>(filePath);
  } catch (err) {
    throw new Error(
      `Could not read operator actor-mapping file at ${filePath}: ${(err as Error).message}`,
      {
        cause: err,
      },
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Operator actor-mapping file ${filePath} must be a mapping with a "mappings" object.`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const mappingsRaw = obj.mappings;
  const mappings: Record<string, string> = {};
  if (mappingsRaw !== undefined) {
    if (!mappingsRaw || typeof mappingsRaw !== "object" || Array.isArray(mappingsRaw)) {
      throw new Error(`Operator actor-mapping file ${filePath}: "mappings" must be an object.`);
    }
    for (const [key, value] of Object.entries(mappingsRaw as Record<string, unknown>)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `Operator actor-mapping file ${filePath}: mapping for "${key}" must be a non-empty string.`,
        );
      }
      mappings[key] = value;
    }
  }
  const result: OperatorActorMap = { mappings };
  const defaultsRaw = obj.defaults;
  if (defaultsRaw !== undefined) {
    if (!defaultsRaw || typeof defaultsRaw !== "object" || Array.isArray(defaultsRaw)) {
      throw new Error(`Operator actor-mapping file ${filePath}: "defaults" must be an object.`);
    }
    const defaults: Partial<Record<ActorRecordKind, string>> = {};
    for (const [key, value] of Object.entries(defaultsRaw as Record<string, unknown>)) {
      // Validate the KEY is a known record kind. An unknown key (typo or a kind
      // that does not exist) would silently never apply, masking the operator's
      // intent — fail closed instead.
      if (!isActorRecordKind(key)) {
        throw new Error(
          `Operator actor-mapping file ${filePath}: "defaults" key "${key}" is not a known ` +
            `record kind. Valid record kinds: ${ACTOR_RECORD_KINDS.join(", ")}.`,
        );
      }
      // Validate the VALUE is a non-empty string. A non-string default (e.g. a
      // number) would otherwise be written verbatim into an actor field,
      // corrupting schema-valid storage and violating @actor-history-normalization
      // ac-5 / @actor-identity-model ac-2 (an inventoried field left neither
      // canonical nor a declared string default).
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `Operator actor-mapping file ${filePath}: "defaults" value for "${key}" must be a ` +
            `non-empty string.`,
        );
      }
      defaults[key] = value;
    }
    result.defaults = defaults;
  }
  return result;
}

/** A rejected operator mapping entry: its original key and unusable target. */
export interface InvalidOperatorTarget {
  original: string;
  target: string;
}

/**
 * Thrown when an operator mapping target cannot be reduced to a canonical
 * identity or a declared default. Fails the run closed so an operator typo
 * cannot persist a non-canonical actor string verbatim.
 *
 * AC: @actor-history-normalization ac-5 — every inventoried field ends canonical-or-default
 */
export class OperatorActorMapError extends Error {
  readonly invalidTargets: ReadonlyArray<InvalidOperatorTarget>;

  constructor(invalidTargets: InvalidOperatorTarget[]) {
    const list = invalidTargets.map((e) => `"${e.original}" → "${e.target}"`).join(", ");
    super(
      `Operator actor-mapping target(s) do not resolve to a configured canonical identity ` +
        `(a human author id or a canonical agent id) or a declared default actor: ${list}. ` +
        `Map each value to an existing canonical identity, or omit it so the value falls to ` +
        `the declared default. Writing a non-canonical target verbatim would leave the field ` +
        `non-canonical and break idempotency.`,
    );
    this.name = "OperatorActorMapError";
    this.invalidTargets = invalidTargets;
  }
}

/**
 * Resolver for a single actor string: classifier → operator map → declared
 * default. Pure given its captured configuration.
 */
class ActorResolver {
  private readonly classify: (s: string) => ClassifiedActor;
  private readonly operatorRaw: Map<string, string>;
  private readonly operatorNormalized: Map<string, string>;
  private readonly defaults: Partial<Record<ActorRecordKind, string>>;

  constructor(config: ActorIdentityConfig, operatorMap: OperatorActorMap) {
    this.classify = buildActorClassifier(config);
    this.defaults = { ...DECLARED_DEFAULT_ACTORS, ...operatorMap.defaults };

    // Validate and normalize operator mapping TARGETS before they can be
    // written. An operator mapping asserts "this historical value IS <target>",
    // so the target must itself be a canonical identity — otherwise the rewrite
    // would persist whatever string the operator typed (e.g. `not-a-real-actor`)
    // into an actor field, violating @actor-history-normalization ac-5 (every
    // inventoried field ends canonical-or-default) and breaking ac-3 idempotency
    // (a non-canonical target is not a fixed point of the resolver, so the next
    // run would try to resolve it again and fall to the default).
    //
    // A recognizable target alias is normalized to its canonical id (e.g.
    // `@codex` → `codex`); a target that the operator deliberately routes to a
    // declared default sentinel (e.g. `@unknown`) is allowed as-is; anything
    // else fails the run closed.
    const allowedDefaults = new Set<string>([
      DEFAULT_UNKNOWN_ACTOR,
      ...Object.values(this.defaults).filter((v): v is string => v !== undefined),
    ]);
    const operatorRaw = new Map<string, string>();
    const operatorNormalized = new Map<string, string>();
    const invalid: InvalidOperatorTarget[] = [];
    for (const [original, target] of Object.entries(operatorMap.mappings)) {
      const canonical = this.canonicalizeTarget(target, allowedDefaults);
      if (canonical === null) {
        invalid.push({ original, target });
        continue;
      }
      operatorRaw.set(original, canonical);
      operatorNormalized.set(original.trim().toLowerCase(), canonical);
    }
    if (invalid.length > 0) {
      throw new OperatorActorMapError(invalid);
    }
    this.operatorRaw = operatorRaw;
    this.operatorNormalized = operatorNormalized;
  }

  /**
   * Reduce an operator mapping target to its canonical form: its canonical
   * identity if the classifier recognizes it, the target itself if it is a
   * declared default sentinel, or null if it is neither (an invalid target).
   */
  private canonicalizeTarget(target: string, allowedDefaults: Set<string>): string | null {
    const classified = this.classify(target);
    if (classified.kind !== "unknown" && classified.canonicalId) {
      return classified.canonicalId;
    }
    if (allowedDefaults.has(target)) {
      return target;
    }
    return null;
  }

  defaultFor(recordKind: ActorRecordKind): string {
    return this.defaults[recordKind] ?? DEFAULT_UNKNOWN_ACTOR;
  }

  /**
   * Resolve a non-empty actor string to its canonical/default identity.
   */
  resolve(
    original: string,
    recordKind: ActorRecordKind,
  ): { resolved: string; source: ActorResolutionSource } {
    const classified = this.classify(original);
    if (classified.kind !== "unknown" && classified.canonicalId) {
      return { resolved: classified.canonicalId, source: "variant_map" };
    }
    const opExact = this.operatorRaw.get(original);
    if (opExact !== undefined) {
      return { resolved: opExact, source: "operator_mapping" };
    }
    const opNormalized = this.operatorNormalized.get(original.trim().toLowerCase());
    if (opNormalized !== undefined) {
      return { resolved: opNormalized, source: "operator_mapping" };
    }
    return { resolved: this.defaultFor(recordKind), source: "default" };
  }
}

// ── Path-based field rewriting ──────────────────────────────────────────────

/** Parse a `[]`-segmented inventory field path into walk segments. */
function parseFieldPath(fieldPath: string): string[] {
  const segments: string[] = [];
  for (const part of fieldPath.split(".")) {
    let rest = part;
    while (rest.endsWith("[]")) {
      rest = rest.slice(0, -2);
      if (rest) {
        segments.push(rest);
        rest = "";
      }
      segments.push("[]");
    }
    if (rest) {
      segments.push(rest);
    }
  }
  return segments;
}

/**
 * Walk a record along the parsed path, applying `visit` to each terminal actor
 * string and mutating the holding object in place when `visit` returns a
 * changed value.
 */
function walkAndRewrite(
  node: unknown,
  segments: string[],
  concretePath: string,
  visit: (value: string, concretePath: string) => string,
): void {
  if (node === null || node === undefined) {
    return;
  }
  const [seg, ...rest] = segments;

  if (seg === "[]") {
    if (!Array.isArray(node)) {
      return;
    }
    node.forEach((el, i) => walkAndRewrite(el, rest, `${concretePath}[${i}]`, visit));
    return;
  }

  if (typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  const holder = node as Record<string, unknown>;

  if (rest.length === 0) {
    // Terminal segment — `holder[seg]` is the actor value.
    const value = holder[seg];
    if (typeof value === "string" && value.trim() !== "") {
      const concrete = concretePath ? `${concretePath}.${seg}` : seg;
      const next = visit(value, concrete);
      if (next !== value) {
        holder[seg] = next;
      }
    }
    return;
  }

  const child = holder[seg];
  walkAndRewrite(child, rest, concretePath ? `${concretePath}.${seg}` : seg, visit);
}

/**
 * Apply all normalize-disposition rewrites for a record kind to a single parsed
 * record, mutating it in place and appending each rewrite to `out`.
 *
 * Returns the number of values changed (0 means the record is already
 * normalized and need not be persisted — the basis for idempotency).
 */
function rewriteRecord(
  record: Record<string, unknown>,
  recordKind: ActorRecordKind,
  recordRef: string,
  fieldPaths: string[],
  resolver: ActorResolver,
  out: ActorRewrite[],
): number {
  let changed = 0;
  for (const fieldPath of fieldPaths) {
    const segments = parseFieldPath(fieldPath);
    walkAndRewrite(record, segments, "", (value, concretePath) => {
      const { resolved, source } = resolver.resolve(value, recordKind);
      if (resolved === value) {
        return value;
      }
      changed += 1;
      out.push({
        recordKind,
        recordRef,
        fieldPath: concretePath,
        original: value,
        resolved,
        resolutionSource: source,
      });
      return resolved;
    });
  }
  return changed;
}

// ── Per-record-kind handlers ────────────────────────────────────────────────

/**
 * A loaded record exposed to the engine. `data` is the mutable parsed object
 * the engine rewrites in place; `persist` writes that object back through the
 * record kind's standard, raw-shape-preserving save path.
 */
interface LoadedActorRecord {
  ref: string;
  data: Record<string, unknown>;
  persist: (ctx: KspecContext) => Promise<void>;
}

interface RecordKindHandler {
  recordKind: ActorRecordKind;
  load: (ctx: KspecContext) => Promise<LoadedActorRecord[]>;
}

/**
 * Build the handler set lazily so the migration only pays for the parser
 * modules it actually uses, and so the daemon bundle does not eagerly import
 * the upgrade-only code paths.
 */
async function buildHandlers(): Promise<RecordKindHandler[]> {
  const reviews = await import("./reviews.js");
  const taskMgr = await import("./task-data-manager.js");
  const yaml = await import("./yaml.js");
  const meta = await import("./meta.js");
  const plans = await import("./plans.js");

  return [
    {
      recordKind: "review",
      // Format-aware loader/save: reads folder-backed storage when the manifest
      // declares it and the monolithic file on legacy projects. This lets a
      // --dry-run preview run on a not-yet-promoted project; a real run only
      // executes after storage promotion, so it sees the folder layout.
      load: async (ctx) => {
        const records = await reviews.loadReviewRecords(ctx);
        return records.map((review) => ({
          ref: review._ulid,
          data: review as unknown as Record<string, unknown>,
          persist: (c: KspecContext) => reviews.saveReviewRecord(c, review),
        }));
      },
    },
    {
      recordKind: "task",
      load: async (ctx) => {
        // Ensure the split storage backend is registered. The manager registers
        // it lazily via createRequire, which cannot resolve the source module
        // under test runners — importing it here makes the migration work in
        // both the compiled CLI and test environments.
        const splitBackend = await import("./split-backend.js");
        splitBackend.ensureSplitBackendRegistered();
        const manager = taskMgr.resolveTaskDataManager(ctx);
        // Load each task WITH its per-task history. The history array lives in
        // task.yaml but is not part of TaskSchema, so the normal load/mutate
        // path strips it; the migration must also rewrite history[].author
        // (inventoried as a normalize field) per @actor-history-normalization
        // ac-5/ac-6.
        const loaded = await manager.loadAllTasksWithHistory(ctx);
        return loaded.map(({ task, history }) => {
          // Attach the history array onto the walked record so the engine
          // rewrites history[].author in place alongside the schema-backed
          // actor fields (assignee, todos[].added_by, notes[].author). The
          // array is mutated by reference, so `history` reflects the rewrites
          // when persist runs.
          const data = task as unknown as Record<string, unknown>;
          data.history = history;
          return {
            ref: task._ulid,
            data,
            // Persist the rewritten core fields AND the rewritten history via
            // the history-aware save path; no synthetic history entry is
            // appended — the only change is the actor rewrite.
            persist: async (c: KspecContext) => {
              await manager.saveActorNormalizedTask(c, task, history);
            },
          };
        });
      },
    },
    {
      recordKind: "inbox",
      load: async (ctx) => {
        const items = await yaml.loadInboxItems(ctx);
        return items.map((item) => ({
          ref: item._ulid,
          data: item as unknown as Record<string, unknown>,
          persist: (c: KspecContext) => yaml.saveInboxItem(c, item),
        }));
      },
    },
    {
      recordKind: "triage",
      load: async (ctx) => {
        const records = await yaml.loadTriageRecords(ctx);
        return records.map((record) => ({
          ref: record._ulid,
          data: record as unknown as Record<string, unknown>,
          persist: (c: KspecContext) => yaml.saveTriageRecord(c, record),
        }));
      },
    },
    {
      recordKind: "observation",
      load: async (ctx) => {
        const metaCtx = await meta.loadMetaContext(ctx);
        return metaCtx.observations.map((obs) => ({
          ref: obs._ulid,
          data: obs as unknown as Record<string, unknown>,
          persist: (c: KspecContext) => meta.saveObservation(c, obs),
        }));
      },
    },
    {
      recordKind: "workflow_run",
      load: async (ctx) => {
        const runs = await meta.loadWorkflowRuns(ctx);
        return runs.map((run) => ({
          ref: run._ulid,
          data: run as unknown as Record<string, unknown>,
          persist: (c: KspecContext) => meta.saveWorkflowRun(c, run),
        }));
      },
    },
    {
      recordKind: "spec_item",
      load: async (ctx) => {
        const items = await yaml.loadAllItems(ctx);
        return items.map((item) => ({
          ref: item._ulid,
          data: item as unknown as Record<string, unknown>,
          persist: async (c: KspecContext) => {
            // Pass only the actor-bearing top-level fields the migration may
            // touch so the patch stays minimal and round-trips through the
            // raw-shape-preserving spec writer.
            const updates: Record<string, unknown> = {};
            if (item.created_by !== undefined) {
              updates.created_by = item.created_by;
            }
            if (item.notes !== undefined) {
              updates.notes = item.notes;
            }
            await yaml.updateSpecItem(c, item, updates);
          },
        }));
      },
    },
    {
      recordKind: "plan",
      // Format-aware loader/save — see the review handler note above.
      load: async (ctx) => {
        const loadedPlans = await plans.loadPlans(ctx);
        return loadedPlans.map((plan) => ({
          ref: plan._ulid,
          data: plan as unknown as Record<string, unknown>,
          persist: (c: KspecContext) => plans.savePlan(c, plan),
        }));
      },
    },
  ];
}

// ── Public migration entry point ────────────────────────────────────────────

/** Options for {@link runActorNormalization}. */
export interface ActorNormalizationOptions {
  /** Preview mode — scan and report without modifying any record. */
  dryRun?: boolean;
  /** Path to an optional operator-provided actor-mapping file. */
  operatorMapPath?: string | null;
  /** Pre-resolved identity config (avoids reloading meta); built if omitted. */
  config?: ActorIdentityConfig;
  /** ISO timestamp to stamp on the report (defaults to now). */
  now?: string;
}

/**
 * Run the historical actor normalization over every in-scope record kind.
 *
 * Fails closed first: if any actor-bearing schema field is missing from the
 * inventory, this throws before touching a single record.
 *
 * AC: @actor-history-normalization ac-1..ac-6
 */
export async function runActorNormalization(
  ctx: KspecContext,
  options: ActorNormalizationOptions = {},
): Promise<ActorNormalizationReport> {
  const dryRun = options.dryRun ?? false;

  // ac-6 — refuse to run if a future actor-bearing field is unclassified.
  assertInventoryCoversSchemas();

  const config = options.config ?? (await resolveIdentityConfig(ctx));
  const operatorMap = options.operatorMapPath
    ? await loadOperatorActorMap(options.operatorMapPath)
    : EMPTY_OPERATOR_MAP;
  const resolver = new ActorResolver(config, operatorMap);

  const handlers = await buildHandlers();
  const rewrites: ActorRewrite[] = [];
  const recordKindsCovered: ActorRecordKind[] = [];
  const deferredKinds: ActorDeferredKind[] = [];
  let recordsScanned = 0;
  let recordsModified = 0;

  for (const handler of handlers) {
    const fieldPaths = normalizeFieldPathsFor(handler.recordKind);
    if (fieldPaths.length === 0) {
      recordKindsCovered.push(handler.recordKind);
      continue;
    }

    let records: LoadedActorRecord[];
    try {
      records = await handler.load(ctx);
    } catch (err) {
      // A preview may run before the upgrade's storage migration has promoted
      // this kind's layout (e.g. legacy task storage that the split backend
      // refuses to read). Defer the kind so the preview still reports every
      // rewrite it can compute, rather than aborting the whole dry-run. A real
      // run only executes after storage promotion, so a load failure there is a
      // genuine error and must surface.
      if (dryRun) {
        deferredKinds.push({
          recordKind: handler.recordKind,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      throw err;
    }

    recordKindsCovered.push(handler.recordKind);
    for (const record of records) {
      recordsScanned += 1;
      const changed = rewriteRecord(
        record.data,
        handler.recordKind,
        record.ref,
        fieldPaths,
        resolver,
        rewrites,
      );
      // Persist only records that actually changed. On an already-normalized
      // project nothing changes, so no record is written — the basis for ac-3
      // idempotency. Dry-run never persists.
      if (changed > 0 && !dryRun) {
        await record.persist(ctx);
        recordsModified += 1;
      }
    }
  }

  const unresolvedOriginals = [
    ...new Set(rewrites.filter((r) => r.resolutionSource === "default").map((r) => r.original)),
  ];

  return {
    dryRun,
    generatedAt: options.now,
    recordsScanned,
    recordsModified,
    rewriteCount: rewrites.length,
    rewrites,
    unresolvedOriginals,
    recordKindsCovered,
    deferredKinds,
  };
}

/** Build the classifier identity config from the project context + meta. */
async function resolveIdentityConfig(ctx: KspecContext): Promise<ActorIdentityConfig> {
  const { loadMetaContext } = await import("./meta.js");
  const metaCtx = await loadMetaContext(ctx);
  return buildActorIdentityConfig({
    configAuthor: ctx.config?.identity?.author,
    displayName: ctx.config?.identity?.display_name,
    humanAliases: ctx.config?.identity?.aliases,
    agentAliases: ctx.config?.identity?.agent_aliases,
    agents: metaCtx.agents,
  });
}

// ── Report artifact ─────────────────────────────────────────────────────────

/** Directory (under the spec dir) where durable normalization reports land. */
export const ACTOR_REPORT_DIR = "upgrade-reports";

/**
 * Compute the durable report artifact path for a run timestamp. The colons in
 * an ISO timestamp are replaced so the name is filesystem-portable.
 */
export function actorReportPath(ctx: KspecContext, generatedAt: string): string {
  const safeStamp = generatedAt.replace(/[:.]/g, "-");
  return path.join(ctx.specDir, ACTOR_REPORT_DIR, `actor-normalization-${safeStamp}.json`);
}

/**
 * Write the normalization report to a durable project-local artifact through
 * the buffer-aware writer so the shadow branch records it with the change set.
 * Returns the absolute artifact path.
 */
export async function writeActorReportArtifact(
  ctx: KspecContext,
  report: ActorNormalizationReport,
): Promise<string> {
  const generatedAt = report.generatedAt ?? new Date().toISOString();
  const reportPath = actorReportPath(ctx, generatedAt);
  await writeFileBufferAware(
    reportPath,
    `${JSON.stringify({ ...report, generatedAt }, null, 2)}\n`,
  );
  return reportPath;
}
