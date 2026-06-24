/**
 * ProjectEntityCache — Tiered in-memory cache for daemon entity data.
 *
 * Two-tier model per domain:
 * - Index tier: summaries/counts always hot in memory
 * - Detail tier: full content loaded on demand, evicted on invalidation
 *
 * Domains load progressively on project registration.
 * File watcher drives invalidation; write-through avoids double-reload.
 *
 * AC Coverage:
 * - @daemon-entity-cache ac-load-on-register
 * - @daemon-entity-cache ac-serve-from-memory
 * - @daemon-entity-cache ac-detail-on-demand
 * - @daemon-entity-cache ac-watcher-invalidation
 * - @daemon-entity-cache ac-granular-reload
 * - @daemon-entity-cache ac-write-through
 * - @daemon-entity-cache ac-concurrent-reads
 * - @daemon-entity-cache ac-reload-dedup
 * - @daemon-entity-cache ac-graceful-degradation
 * - @daemon-entity-cache ac-project-isolation
 * - @daemon-entity-cache ac-unregister-cleanup
 * - @daemon-entity-cache ac-session-bounded-index
 * - @daemon-entity-cache ac-session-stale-exclusion
 * - @daemon-entity-cache ac-warming-availability
 * - @daemon-entity-cache ac-progressive-loading
 * - @daemon-entity-cache ac-stale-during-reload
 * - @daemon-entity-cache ac-domain-ready-event
 */

import { dirname, join, relative } from "path";
import {
  expandIncludePattern,
  getTaskFilePath,
  initContext,
  loadAllItems,
  loadSpecFile,
  loadMetaContext,
  loadSessionContext,
  loadPlans,
  rawToSummary,
  resolveTaskDataManager,
  invalidateCoverageStateReadModelCache,
  type KspecContext,
  type LoadedSpecItem,
  type LoadedTask,
  type TaskSummary,
} from "../parser/index.js";
import type { MetaContext } from "../parser/meta.js";
import {
  isDeterministicTaskStorageIncompatibility,
  type HistoryEntry,
  type TaskDataManagerError,
} from "../parser/task-data-manager.js";
import { loadInboxItems, type LoadedInboxItem } from "../parser/yaml.js";
import { loadTriageRecords, type LoadedTriageRecord } from "../parser/yaml.js";
import { loadReviewRecords, type LoadedReviewRecord } from "../parser/reviews.js";
import { type LoadedPlan } from "../parser/plans.js";
import { computeDisposition } from "../parser/review-operations.js";
import { getUnresolvedBlockers } from "../parser/review-threads.js";
import {
  EntityStorageCompatibilityError,
  requirePlanFolderStorage,
  requireReviewFolderStorage,
} from "../parser/entity-storage-compatibility.js";
import { getShadowStatus, hasRemoteTracking } from "../parser/shadow.js";
import {
  type SessionLogSummary,
  getSessionDir,
  getSessionMetadataOnly,
  resolveStaleSessionCriteria,
  getSessionActivityForStaleCheck,
} from "../sessions/store.js";
import type { Dir } from "fs";
import * as fs from "fs/promises";

async function closeDirectoryHandle(dir: Dir): Promise<void> {
  try {
    await dir.close();
  } catch (error) {
    const errorWithCode = error as NodeJS.ErrnoException;
    if (errorWithCode.code !== "ERR_DIR_CLOSED") {
      throw error;
    }
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Data domains managed by the cache, in priority load order. */
export type CacheDomain =
  | "tasks"
  | "items"
  | "meta"
  | "inbox"
  | "plans"
  | "triage"
  | "reviews"
  | "sessions";

/** Load priority order — higher-priority domains load first. */
export const DOMAIN_LOAD_ORDER: CacheDomain[] = [
  "tasks",
  "items",
  "meta",
  "inbox",
  "plans",
  "triage",
  "reviews",
  "sessions",
];

/** Per-domain state. */
export type DomainState = "unloaded" | "loading" | "ready" | "degraded";

export interface WriteThroughHint {
  ulid?: string;
  filePath?: string;
  sessionId?: string;
}

export type CachedTaskDetail = LoadedTask;

/** Summary type for spec items (index tier — excludes description, notes, AC content). */
export interface ItemSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  type?: string;
  status: unknown; // SpecItem.status can be string | object
  priority?: number | string;
  tags: string[];
  traits: string[];
  _sourceFile?: string;
  _path?: string;
  created?: string;
  acceptance_criteria_count: number;
}

/** Project a LoadedSpecItem to its index-tier summary (strip description, notes, AC content). */
function toItemSummary(item: LoadedSpecItem): ItemSummary {
  return {
    _ulid: item._ulid,
    slugs: item.slugs,
    title: item.title,
    type: item.type,
    status: item.status,
    priority: item.priority,
    tags: item.tags ?? [],
    traits: item.traits ?? [],
    _sourceFile: item._sourceFile,
    _path: item._path,
    created: item.created,
    acceptance_criteria_count: item.acceptance_criteria?.length ?? 0,
  };
}

function sortSessionSummaries(summaries: SessionLogSummary[]): void {
  summaries.sort((a, b) => {
    const aTs = new Date(a.started_at).getTime();
    const bTs = new Date(b.started_at).getTime();
    return bTs - aTs;
  });
}

/**
 * Bounded resource summary mirrored from the plan index — counts only,
 * never resource bytes. Keeping the shape inside `PlanIndexSummary` lets
 * cache-ready list responses surface resource presence without loading any
 * per-plan sidecar manifests.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export interface PlanIndexResourceSummary {
  count: number;
  total_bytes: number;
}

/** Summary type for plans (index tier — excludes content and notes). */
export interface PlanIndexSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  status: string;
  created_at: string;
  approved_at: string | null;
  completed_at: string | null;
  source_path: string | null;
  module_ref: string | null;
  derived_tasks: string[];
  derived_specs: string[];
  /**
   * Bounded resource summary carried through the cache index. `undefined`
   * when the plan has no `resources.yaml` sidecar; route consumers project
   * `{ count: 0, total_bytes: 0 }` in that case.
   *
   * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
   */
  resource_summary?: PlanIndexResourceSummary;
}

/** Project a LoadedPlan to its index-tier summary (strip content and notes). */
function toPlanIndexSummary(plan: LoadedPlan): PlanIndexSummary {
  const summary: PlanIndexSummary = {
    _ulid: plan._ulid,
    slugs: plan.slugs,
    title: plan.title,
    status: plan.status,
    created_at: plan.created_at,
    approved_at: plan.approved_at ?? null,
    completed_at: plan.completed_at ?? null,
    source_path: plan.source_path ?? null,
    module_ref: plan.module_ref ?? null,
    derived_tasks: plan.derived_tasks,
    derived_specs: plan.derived_specs,
  };
  // `LoadedPlan` may carry an attached `resource_summary` populated by the
  // folder-backed loader (read from the plan's `resources.yaml` sidecar at
  // load time). When present, project it through so the cache-ready list
  // path can surface bounded counts without a sidecar re-read.
  const attached = (plan as { resource_summary?: PlanIndexResourceSummary }).resource_summary;
  if (attached && typeof attached.count === "number" && typeof attached.total_bytes === "number") {
    summary.resource_summary = { count: attached.count, total_bytes: attached.total_bytes };
  }
  return summary;
}

/** Summary type for review records (index tier — excludes threads, checks, verdicts, events, notes). */
export interface ReviewIndexSummary {
  _ulid: string;
  slugs: string[];
  title: string;
  lifecycle_state: string;
  author: string;
  subject: LoadedReviewRecord["subject"];
  related_refs: string[];
  created_at: string;
  updated_at: string | null;
  examined_commit: string | null;
  external_links: LoadedReviewRecord["external_links"];
  /** Pre-computed disposition from threads/checks/verdicts at index load time. */
  disposition: string;
  /** Pre-computed counts from the full record. */
  thread_count: number;
  unresolved_blocker_count: number;
  check_count: number;
  verdict_count: number;
}

/** Project a LoadedReviewRecord to its index-tier summary (pre-compute derived values, strip heavy fields). */
function toReviewIndexSummary(review: LoadedReviewRecord): ReviewIndexSummary {
  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    author: review.author,
    subject: review.subject,
    related_refs: review.related_refs,
    created_at: review.created_at,
    updated_at: review.updated_at ?? null,
    examined_commit: review.examined_commit ?? null,
    external_links: review.external_links,
    disposition: computeDisposition(review),
    thread_count: review.threads.length,
    unresolved_blocker_count: getUnresolvedBlockers(review).length,
    check_count: review.checks.length,
    verdict_count: review.verdicts.length,
  };
}

/** Summary type for triage records (index tier — excludes item_snapshot, reasoning, override_reasoning). */
export interface TriageIndexSummary {
  _ulid: string;
  inbox_ref: string;
  status: string;
  created_at: string;
  action?: string;
  reasoning?: string;
  decided_by?: string;
  override_by?: string;
  override_at?: string;
  acted_at?: string;
  updated_at?: string;
  result_ref?: string;
  evidence_refs: string[];
}

/** Project a LoadedTriageRecord to its index-tier summary (strip item_snapshot, override_reasoning). */
function toTriageIndexSummary(record: LoadedTriageRecord): TriageIndexSummary {
  return {
    _ulid: record._ulid,
    inbox_ref: record.inbox_ref,
    status: record.status,
    created_at: record.created_at,
    action: record.action,
    reasoning: record.reasoning,
    decided_by: record.decided_by,
    override_by: record.override_by,
    override_at: record.override_at,
    acted_at: record.acted_at,
    updated_at: record.updated_at,
    result_ref: record.result_ref,
    evidence_refs: record.evidence_refs ?? [],
  };
}

/** Manifest summary for meta domain index tier. */
export interface MetaSummary {
  projectName?: string;
  version?: string;
  status?: string;
  modules?: string[];
}

/** Cached shadow branch status, computed at cache load time to avoid per-request git ops. */
export interface CachedShadowInfo {
  enabled: boolean;
  branch_name: string | null;
  worktree_dir: string | null;
  healthy: boolean;
  remote_tracking: boolean;
}

/** Cached project config, computed at cache load time to avoid per-request initContext. */
export interface CachedProjectConfig {
  project: { name?: string; version?: string; status?: string } | null;
  spec_version: string | null;
  root_dir: string;
  remote_tracking: { value: string; type: string } | null;
  daemon: { port: number; host: string; auto_start: boolean };
  manifest_path?: string | null;
  manifest?: KspecContext["manifest"];
  config?: KspecContext["config"];
}

/** Cached session context, computed at cache load time to avoid per-request disk reads. */
export interface CachedSessionContext {
  focus: string | null;
  threads: string[];
  questions: string[];
  updated_at: string;
}

/**
 * Tracked state for a deterministic task-storage compatibility/migration
 * failure on the tasks cache domain. Preserved across repeat reload paths
 * so the daemon can avoid amplifying the same unchanged condition.
 *
 * AC: @daemon-entity-cache ac-task-storage-incompatibility-degraded-state
 * AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
 */
export interface TaskStorageIncompatibilityState {
  /** Stable error code from TaskDataManagerError (e.g. "legacy_task_storage_removed"). */
  code: string;
  /** Human-readable message captured from the original error. */
  message: string;
  /** Recovery guidance (suggestion) carried over from the original error. */
  suggestion: string | null;
  /** Field that drove the error, when one was reported. */
  field: string | null;
  /** ISO 8601 timestamp the current incompatibility was first observed. */
  observedAt: string;
}

/** Per-domain diagnostic snapshot returned by getCacheDiagnostics(). */
export interface DomainDiagnostic {
  state: DomainState;
  indexCount: number;
  detailCount: number;
  lastError: string | null;
  lastInvalidatedAt: string | null;
  /**
   * Stable code identifying the current error class when available
   * (e.g. "legacy_task_storage_removed"). Null when the domain is healthy
   * or the error has no stable code.
   *
   * AC: @daemon-server ac-cache-diagnostics-degraded-reason
   */
  errorReason: string | null;
  /**
   * User-actionable guidance describing how to recover from the current
   * error, when the underlying error supplied one.
   *
   * AC: @daemon-server ac-cache-diagnostics-recovery-guidance
   */
  recoveryGuidance: string | null;
  /**
   * True when the only path to recovery is a relevant project-state change
   * (e.g. running a migration or updating the manifest). Surfaces the
   * suppressed/waiting state from bounded degraded-state behavior so
   * diagnostic clients can distinguish "stuck on user action" from
   * "transient failure".
   *
   * AC: @daemon-server ac-cache-diagnostics-recovery-readiness
   */
  recoveryWaitingOnProjectState: boolean;
}

/** Full cache diagnostic snapshot for a single project. */
export interface CacheDiagnostic {
  projectPath: string;
  domains: Record<CacheDomain, DomainDiagnostic>;
}

/** Session cache configuration. */
export interface SessionCacheConfig {
  /** Maximum number of session summaries to keep in index (default 100). */
  maxIndexSize: number;
}

/**
 * Callback invoked when a cache domain transitions to ready state.
 * AC: @daemon-entity-cache ac-domain-ready-event
 */
export type DomainReadyCallback = (
  domain: CacheDomain,
  projectPath: string,
  previousState: DomainState,
) => void;

/**
 * Callback invoked after a watcher-driven reload completes with fresh data.
 * AC: @daemon-entity-cache ac-broadcast-after-reload
 */
export type DomainReloadedCallback = (domain: CacheDomain, projectPath: string) => void;

interface ReloadCycle {
  contextPromise?: Promise<KspecContext>;
  pendingDomains: Set<CacheDomain>;
}

type MetaSubdomain = "manifest" | "shadow" | "session";

interface PendingDomainChange {
  filePath: string;
  content?: string;
}

interface MetaLoadState {
  manifest: boolean;
  shadow: boolean;
  session: boolean;
}

interface CachedMetaRuntime {
  rootDir: string;
  specDir: string;
  projectRoot: string;
  metaSourceFiles: string[];
  project: { name?: string; version?: string; status?: string } | null;
  specVersion: string | null;
  daemon: { port: number; host: string; auto_start: boolean };
  remoteTracking: { value: string; type: string } | null;
  shadow: {
    enabled: boolean;
    branchName: string | null;
    worktreeDir: string | null;
    directory: string;
  };
}

const TASK_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const DEFAULT_SESSION_CACHE_CONFIG: SessionCacheConfig = {
  maxIndexSize: 100,
};

const META_SUBDOMAIN_LOAD_ORDER: MetaSubdomain[] = ["manifest", "shadow", "session"];

// ─── Domain Data Store ───────────────────────────────────────────────────────

/** Generic per-domain store with index + detail tiers. */
interface DomainStore<TIndex, TDetail = unknown> {
  state: DomainState;
  index: TIndex | null;
  /** Detail cache keyed by entity ref (ULID or ID). */
  details: Map<string, TDetail>;
  /** Error from the last failed load attempt (for degraded state). */
  lastError?: Error;
  /** Timestamp of last invalidation (watcher-driven or write-through). */
  lastInvalidatedAt?: string;
}

interface TaskDomainStore extends DomainStore<TaskSummary[], CachedTaskDetail> {
  historyDetails: Map<string, HistoryEntry[]>;
  /**
   * Active deterministic task-storage incompatibility, when the tasks domain
   * cannot load because of a legacy/unmigrated storage state. Persists across
   * reload paths so the daemon does not amplify the unchanged condition.
   *
   * AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
   */
  storageIncompatibility: TaskStorageIncompatibilityState | null;
  /**
   * Whether a relevant task-storage project-state change has been observed
   * since the last evaluation. While false (and storageIncompatibility is
   * set), the next tasks reload is suppressed entirely. Set to true when
   * the watcher reports a change to kynetic.yaml, project.tasks.yaml, or
   * tasks/<ULID>/ — the signals that can resolve a deterministic
   * incompatibility.
   *
   * AC: @daemon-entity-cache ac-task-storage-incompatibility-rechecked-after-storage-change
   */
  needsTaskStorageRecheck: boolean;
}

// ─── File → Domain Mapping ───────────────────────────────────────────────────

/** Crockford-base32 ULID shape used to validate folder-backed entity roots. */
const ENTITY_ULID_SEGMENT = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Whether `relativePath` (relative to `.kspec/`) is a file inside a
 * folder-backed entity directory of the given storage root, i.e.
 * `<storageRoot>/<ULID>/<...>`. Requires the second segment to be a
 * Crockford-base32 ULID so look-alike prefixes like `plans-archive/...`
 * or top-level filenames like `plansreport.yaml` are not claimed.
 */
function isFolderBackedEntityChild(storageRoot: string, relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    segments.length >= 3 && segments[0] === storageRoot && ENTITY_ULID_SEGMENT.test(segments[1])
  );
}

/**
 * Map a changed file path (relative to .kspec/) to its data domain(s).
 * Returns an array of affected domains, or null if the file doesn't
 * map to any cached domain.
 *
 * A single file may affect multiple domains — e.g. kynetic.yaml is
 * both the project manifest (meta) and the root of the item include
 * tree (items). Both domains must be invalidated when it changes.
 *
 * AC: @daemon-entity-cache ac-granular-reload
 */
export function fileToDomain(
  relativePath: string,
  source?: "kspec" | "sessions",
): CacheDomain[] | null {
  const domains: CacheDomain[] = [];

  // Task files — both monolith (project.tasks.yaml, *.tasks.yaml, tasks.yaml) and
  // split-backend per-task directories (tasks/<ULID>/task.yaml, tasks/<ULID>/notes.yaml).
  // TaskDataManager.listTasks() explicitly loads tasks.yaml alongside *.tasks.yaml,
  // so the bare filename must also be matched.
  if (
    relativePath.endsWith(".tasks.yaml") ||
    relativePath === "project.tasks.yaml" ||
    relativePath === "tasks.yaml"
  ) {
    domains.push("tasks");
  }
  if (relativePath.startsWith("tasks/")) {
    domains.push("tasks");
  }
  // kynetic.yaml carries the task_storage configuration; manifest changes
  // are a relevant signal for re-evaluating task-storage compatibility.
  // AC: @daemon-entity-cache ac-manifest-task-storage-settings-affect-tasks-domain
  // AC: @daemon-entity-cache ac-task-storage-incompatibility-rechecked-after-storage-change
  if (relativePath === "kynetic.yaml") {
    domains.push("tasks");
  }

  // Inbox
  if (relativePath === "project.inbox.yaml") {
    domains.push("inbox");
  }

  // Plans — both the lean parent index (project.plans.yaml) and folder-backed
  // per-plan directories (plans/<ulid>/plan.md, plan.yaml, notes.yaml,
  // resources.yaml, resources/<file>). The folder match requires a valid
  // ULID-shaped segment after `plans/` so sibling paths like
  // `plans-archive/foo.yaml` or top-level `plansreport.yaml` do not collide.
  // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
  if (relativePath === "project.plans.yaml") {
    domains.push("plans");
  }
  if (isFolderBackedEntityChild("plans", relativePath)) {
    domains.push("plans");
  }

  // Reviews — both the lean parent index (project.reviews.yaml) and
  // folder-backed per-review directories (reviews/<ulid>/review.yaml,
  // resources.yaml, resources/<file>). Same ULID-segment guard as plans.
  // AC: @daemon-entity-cache ac-folder-backed-entity-directory-invalidation
  if (relativePath === "project.reviews.yaml") {
    domains.push("reviews");
  }
  if (isFolderBackedEntityChild("reviews", relativePath)) {
    domains.push("reviews");
  }

  // Triage
  if (relativePath === "project.triage.yaml") {
    domains.push("triage");
  }

  // Meta (manifest)
  if (relativePath === "kynetic.yaml" || relativePath.endsWith(".meta.yaml")) {
    domains.push("meta");
  }

  if (relativePath === ".kspec-session") {
    domains.push("meta");
  }

  // Spec items — modules/*.yaml, *.spec.yaml, or kynetic.yaml
  // (kynetic.yaml is the root of the item include tree; loadAllItems()
  // reads the manifest to discover module includes)
  if (
    relativePath.startsWith("modules/") ||
    relativePath.endsWith(".spec.yaml") ||
    relativePath === "kynetic.yaml"
  ) {
    domains.push("items");
  }

  // Session files — when handleFileChange is called with sessionsDir as
  // the base, the relative path is a bare session ID (session root from
  // SessionWatcher.getBroadcastPath) or sessionId/filename (e.g. metadata.json,
  // events.jsonl). Session IDs can be any string (ULIDs, plain strings like
  // "session-123", etc.) so we cannot match by ID shape alone. The `source`
  // parameter in fileToDomain() disambiguates — when source is "sessions",
  // ALL paths map to the sessions domain.
  // (Legacy: also match ULID-shaped segments for backward compatibility with
  // callers that don't pass source="sessions".)
  if (source === "sessions") {
    domains.push("sessions");
  } else {
    const firstSegment = relativePath.split("/")[0];
    if (firstSegment && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(firstSegment)) {
      domains.push("sessions");
    }
  }

  // Catch-all: any .yaml file not already matched should conservatively
  // invalidate items and meta. The loaders are broader than the explicit
  // patterns above — findManifest() accepts any *.yaml with a kynetic: header,
  // loadAllItems() follows arbitrary manifest.includes paths, and
  // loadMetaContext() follows arbitrary meta.includes. A project that keeps
  // specs or meta includes outside the hard-coded paths above would serve
  // stale cache data if we don't invalidate on those changes.
  if (relativePath.endsWith(".yaml") && domains.length === 0) {
    domains.push("items", "meta");
  }

  return domains.length > 0 ? domains : null;
}

// ─── ProjectEntityCache ──────────────────────────────────────────────────────

/**
 * In-memory entity cache for a single project.
 *
 * Each registered project gets its own ProjectEntityCache instance,
 * ensuring AC: @daemon-entity-cache ac-project-isolation.
 */
export class ProjectEntityCache {
  private projectPath: string;
  private sessionConfig: SessionCacheConfig;

  // Per-domain stores
  private tasks: TaskDomainStore = {
    state: "unloaded",
    index: null,
    details: new Map(),
    historyDetails: new Map(),
    storageIncompatibility: null,
    needsTaskStorageRecheck: true,
  };
  private items: DomainStore<ItemSummary[], LoadedSpecItem> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
  private itemSourceFiles = new Map<string, string>();
  private itemSourceFilesTracked = false;
  private meta: DomainStore<MetaSummary, MetaContext> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
  private inbox: DomainStore<LoadedInboxItem[]> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
  private plans: DomainStore<PlanIndexSummary[], LoadedPlan> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
  private triage: DomainStore<TriageIndexSummary[], LoadedTriageRecord> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
  private reviews: DomainStore<ReviewIndexSummary[], LoadedReviewRecord> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
  private sessions: DomainStore<SessionLogSummary[], SessionLogSummary> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };

  /** Cached shadow branch status, populated during meta domain load. */
  private cachedShadowInfo: CachedShadowInfo | null = null;

  /** Cached project config, populated during meta domain load. */
  private cachedProjectConfig: CachedProjectConfig | null = null;

  /** Cached session context, populated during meta domain load. */
  private cachedSessionContext: CachedSessionContext | null = null;
  private metaLoadState: MetaLoadState = {
    manifest: false,
    shadow: false,
    session: false,
  };
  private cachedMetaRuntime: CachedMetaRuntime | null = null;
  private pendingMetaSubdomains = new Set<MetaSubdomain>();
  private activeMetaSubdomains = new Set<MetaSubdomain>();
  private pendingMetaReloadCycle: ReloadCycle | undefined;

  /**
   * In-flight reload promises for dedup.
   * AC: @daemon-entity-cache ac-reload-dedup
   */
  private inFlightReloads = new Map<CacheDomain, Promise<void>>();

  /**
   * Write-through skip flags — when set, the next watcher invalidation
   * for this domain is skipped (the write already updated the cache).
   * AC: @daemon-entity-cache ac-write-through
   */
  private writeThroughSkip = new Set<CacheDomain>();

  /** Live event counters for active sessions served from the cached session index. */
  private liveEventCounts = new Map<string, number>();

  /**
   * Domain-level debounce timers for coalescing rapid watcher invalidations.
   * When multiple files in the same domain change within the debounce window
   * (e.g. modules/a.yaml and modules/b.yaml both map to "items"), only one
   * reload fires.
   *
   * AC: @daemon-entity-cache ac-reload-dedup
   */
  private domainDebounceTimers = new Map<CacheDomain, NodeJS.Timeout>();
  private domainDebounceMs = 100;
  private pendingDomainChanges = new Map<CacheDomain, Map<string, PendingDomainChange>>();

  /**
   * Deferred domain invalidation promises for callers awaiting the debounced reload.
   * AC: @daemon-entity-cache ac-reload-dedup
   */
  private domainDebouncePromises = new Map<
    CacheDomain,
    { resolve: () => void; promise: Promise<void> }
  >();

  /**
   * Debounce-cycle-scoped context reuse for watcher invalidations.
   * AC: @daemon-entity-cache ac-context-reuse
   */
  private currentReloadCycle: ReloadCycle | null = null;
  private domainReloadCycles = new Map<CacheDomain, ReloadCycle>();

  /** Whether dispose() has been called. */
  private disposed = false;

  /**
   * Optional callback for domain-ready transitions.
   * AC: @daemon-entity-cache ac-domain-ready-event
   */
  private onDomainReady?: DomainReadyCallback;

  /**
   * Optional callback for watcher-driven reload completion.
   * AC: @daemon-entity-cache ac-broadcast-after-reload
   */
  private onDomainReloaded?: DomainReloadedCallback;

  constructor(
    projectPath: string,
    sessionConfig?: Partial<SessionCacheConfig>,
    onDomainReady?: DomainReadyCallback,
    onDomainReloaded?: DomainReloadedCallback,
  ) {
    this.projectPath = projectPath;
    this.sessionConfig = { ...DEFAULT_SESSION_CACHE_CONFIG, ...sessionConfig };
    this.onDomainReady = onDomainReady;
    this.onDomainReloaded = onDomainReloaded;
  }

  // ─── Public Query API ────────────────────────────────────────────────────

  /** Get the project path this cache is bound to. */
  getProjectPath(): string {
    return this.projectPath;
  }

  /**
   * Get state of a domain.
   * AC: @daemon-entity-cache ac-warming-availability
   */
  getDomainState(domain: CacheDomain): DomainState {
    return this.getStore(domain).state;
  }

  /**
   * Get task summaries from index tier.
   * AC: @daemon-entity-cache ac-serve-from-memory
   */
  getTaskIndex(): TaskSummary[] | null {
    return this.tasks.index;
  }

  /**
   * Get a task detail from cache, or null if not cached.
   * Caller should fall back to disk if null and domain is ready.
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  getTaskDetail(ulid: string): CachedTaskDetail | null {
    return this.tasks.details.get(ulid) ?? null;
  }

  getTaskHistory(ulid: string): HistoryEntry[] | null {
    return this.tasks.historyDetails.get(ulid) ?? null;
  }

  /**
   * Store a task detail in the cache (loaded on demand).
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  setTaskDetail(ulid: string, task: LoadedTask | CachedTaskDetail): void {
    this.tasks.details.set(ulid, task);
  }

  /**
   * Apply a task mutation to the cache immediately — updates both the
   * index entry (summary) and the detail tier atomically so that subsequent
   * reads see the new task state without waiting for a full domain reload.
   *
   * Called by TaskDataManager.mutateTask() after the write buffer flushes,
   * ensuring post-mutation reads are immediately consistent even before the
   * post-command writeThrough or file-watcher debounce fires.
   */
  applyTaskMutation(ulid: string, task: LoadedTask | CachedTaskDetail): void {
    if (this.tasks.state !== "ready" || !this.tasks.index) return;

    const summary = rawToSummary(task);
    if (!summary) return;

    // Update index tier: replace existing entry or append new one
    const existingIndex = this.tasks.index.findIndex((t) => t._ulid === ulid);
    if (existingIndex >= 0) {
      this.tasks.index[existingIndex] = summary;
    } else {
      this.tasks.index.push(summary);
    }

    // Update detail tier
    this.tasks.details.set(ulid, task);

    // Invalidate history tier so subsequent reads fall through to disk
    // and pick up the freshly-written history entry from the mutation.
    // Without this, getTaskHistory() / loadTaskWithHistory() would return
    // stale cached history that predates the mutation.
    this.tasks.historyDetails.delete(ulid);
  }

  /**
   * Get spec item summaries from index tier.
   * AC: @daemon-entity-cache ac-serve-from-memory
   */
  getItemIndex(): ItemSummary[] | null {
    return this.items.index;
  }

  /**
   * Get an item detail from cache, or null if not cached.
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  getItemDetail(ulid: string): LoadedSpecItem | null {
    return this.items.details.get(ulid) ?? null;
  }

  /** Store an item detail in the cache. */
  setItemDetail(ulid: string, item: LoadedSpecItem): void {
    this.items.details.set(ulid, item);
  }

  /**
   * Get all full task entities from the detail tier.
   * Returns null if the tasks domain is not ready.
   * Populated during domain load alongside the index tier.
   */
  getAllTaskDetails(): CachedTaskDetail[] | null {
    if (this.tasks.state !== "ready") return null;
    return Array.from(this.tasks.details.values());
  }

  /**
   * Get all full spec item entities from the detail tier.
   * Returns null if the items domain is not ready.
   * Populated during domain load alongside the index tier.
   */
  getAllItemDetails(): LoadedSpecItem[] | null {
    if (this.items.state !== "ready") return null;
    return Array.from(this.items.details.values());
  }

  /** Get inbox items from index tier. */
  getInboxIndex(): LoadedInboxItem[] | null {
    return this.inbox.index;
  }

  /** Get plan summaries from index tier. */
  getPlansIndex(): PlanIndexSummary[] | null {
    return this.plans.index;
  }

  /**
   * Get a plan detail from cache, or null if not cached.
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  getPlanDetail(ulid: string): LoadedPlan | null {
    return this.plans.details.get(ulid) ?? null;
  }

  /** Store a plan detail in the cache. */
  setPlanDetail(ulid: string, plan: LoadedPlan): void {
    this.plans.details.set(ulid, plan);
  }

  /** Get review summaries from index tier. */
  getReviewsIndex(): ReviewIndexSummary[] | null {
    return this.reviews.index;
  }

  /**
   * Get a review detail from cache, or null if not cached.
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  getReviewDetail(ulid: string): LoadedReviewRecord | null {
    return this.reviews.details.get(ulid) ?? null;
  }

  /** Store a review detail in the cache. */
  setReviewDetail(ulid: string, review: LoadedReviewRecord): void {
    this.reviews.details.set(ulid, review);
  }

  /** Get triage summaries from index tier. */
  getTriageIndex(): TriageIndexSummary[] | null {
    return this.triage.index;
  }

  /**
   * Get a triage record detail from cache, or null if not cached.
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  getTriageDetail(ulid: string): LoadedTriageRecord | null {
    return this.triage.details.get(ulid) ?? null;
  }

  /** Store a triage record detail in the cache. */
  setTriageDetail(ulid: string, record: LoadedTriageRecord): void {
    this.triage.details.set(ulid, record);
  }

  /** Get meta summary from index tier. */
  getMetaIndex(): MetaSummary | null {
    return this.meta.index;
  }

  /**
   * Get the full MetaContext from cache (detail tier).
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  getMetaDetail(): MetaContext | null {
    return this.meta.details.get("_context") ?? null;
  }

  /** Store the full MetaContext in the cache. */
  setMetaDetail(meta: MetaContext): void {
    this.meta.details.set("_context", meta);
  }

  /**
   * Get cached shadow branch status (computed at cache load time).
   * AC: @daemon-read-path ac-no-per-request-sync
   */
  getShadowInfo(): CachedShadowInfo | null {
    return this.cachedShadowInfo;
  }

  /**
   * Get cached project config (computed at cache load time).
   * AC: @daemon-read-path ac-no-per-request-sync
   */
  getProjectConfig(): CachedProjectConfig | null {
    return this.cachedProjectConfig;
  }

  /**
   * Get cached session context (computed at cache load time).
   * AC: @daemon-read-path ac-no-per-request-sync
   */
  getSessionContext(): CachedSessionContext | null {
    return this.cachedSessionContext;
  }

  /**
   * Get session summaries from index tier.
   * Applies live event counters for active sessions.
   * AC: @daemon-entity-cache ac-serve-from-memory
   * AC: @daemon-entity-cache ac-session-bounded-index
   */
  getSessionIndex(): SessionLogSummary[] | null {
    if (!this.sessions.index) return null;
    return this.sessions.index.map((s) => {
      const liveCount = this.getSessionLiveEventCount(s.id);
      if ((s.status === "active" || s.status === "stalled") && liveCount !== undefined) {
        return { ...s, event_count: liveCount };
      }
      return s;
    });
  }

  getSessionLiveEventCount(sessionId: string): number | undefined {
    return this.liveEventCounts.get(sessionId);
  }

  /**
   * Get a session detail from cache.
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  getSessionDetail(sessionId: string): SessionLogSummary | null {
    return this.sessions.details.get(sessionId) ?? null;
  }

  /** Store a session detail in the cache. */
  setSessionDetail(sessionId: string, summary: SessionLogSummary): void {
    this.sessions.details.set(sessionId, summary);
  }

  /**
   * Increment live event counter for an active session.
   * On first call, seeds the counter from the persisted event_count in the
   * session index so that subsequent getSessionIndex() calls add to the
   * baseline rather than overwriting it with a counter that started at zero.
   * AC: @daemon-entity-cache ac-session-event-tracking
   */
  incrementSessionEventCount(sessionId: string): void {
    let current = this.liveEventCounts.get(sessionId);
    if (current === undefined) {
      // Seed from persisted event_count in the index
      const indexEntry = this.sessions.index?.find((s) => s.id === sessionId);
      current = indexEntry?.event_count ?? 0;
    }
    this.liveEventCounts.set(sessionId, current + 1);
  }

  /**
   * Discard live event counter for a session (on close).
   * AC: @daemon-entity-cache ac-session-stats-handoff
   */
  discardSessionLiveCounter(sessionId: string): void {
    this.liveEventCounts.delete(sessionId);
  }

  // ─── Diagnostics ─────────────────────────────────────────────────────────

  /**
   * Get a diagnostic snapshot of all domain states, counts, errors, and timestamps.
   * AC: @daemon-server ac-18
   */
  getCacheDiagnostics(): CacheDiagnostic {
    const domains = {} as Record<CacheDomain, DomainDiagnostic>;
    for (const domain of DOMAIN_LOAD_ORDER) {
      const store = this.getStore(domain);
      const indexCount =
        store.index == null ? 0 : Array.isArray(store.index) ? store.index.length : 1; // meta index is a single object

      // AC: @daemon-server ac-cache-diagnostics-degraded-reason
      // AC: @daemon-server ac-cache-diagnostics-recovery-guidance
      // AC: @daemon-server ac-cache-diagnostics-recovery-readiness
      // Tasks domain surfaces deterministic task-storage incompatibility
      // diagnostics so clients can distinguish "stuck on user action" from
      // "transient failure". Plans and reviews domains surface deterministic
      // entity-storage incompatibility codes from any
      // EntityStorageCompatibilityError that landed in lastError during
      // cache warm-up. Other domains report nulls/false.
      let errorReason: string | null = null;
      let recoveryGuidance: string | null = null;
      let recoveryWaitingOnProjectState = false;
      if (domain === "tasks" && this.tasks.storageIncompatibility) {
        errorReason = this.tasks.storageIncompatibility.code;
        recoveryGuidance = this.tasks.storageIncompatibility.suggestion;
        recoveryWaitingOnProjectState = !this.tasks.needsTaskStorageRecheck;
      } else if (
        (domain === "plans" || domain === "reviews") &&
        store.lastError instanceof EntityStorageCompatibilityError
      ) {
        errorReason = store.lastError.code;
        recoveryGuidance = store.lastError.suggestion ?? null;
        // The cache loader cannot recover without a project-state change
        // (manifest upgrade, migration, or layout fix). The next watcher-
        // driven reload after such a change will retry.
        recoveryWaitingOnProjectState = true;
      }

      domains[domain] = {
        state: store.state,
        indexCount,
        detailCount: store.details.size,
        lastError: store.lastError?.message ?? null,
        lastInvalidatedAt: store.lastInvalidatedAt ?? null,
        errorReason,
        recoveryGuidance,
        recoveryWaitingOnProjectState,
      };
    }
    return { projectPath: this.projectPath, domains };
  }

  // ─── Progressive Loading ─────────────────────────────────────────────────

  /**
   * Start progressive loading of all domains.
   * Domains load in priority order; each becomes available as soon as loaded.
   *
   * AC: @daemon-entity-cache ac-load-on-register
   * AC: @daemon-entity-cache ac-progressive-loading
   */
  async loadAll(): Promise<void> {
    if (this.disposed) return;

    // AC: @daemon-entity-cache ac-warming-availability — mark all domains
    // as "loading" upfront so routes return a loading indicator for domains
    // that haven't started their load yet (not-yet-started domains would
    // otherwise remain "unloaded" and routes would fall back to disk).
    for (const domain of DOMAIN_LOAD_ORDER) {
      const store = this.getStore(domain);
      if (store.state === "unloaded") {
        store.state = "loading";
      }
    }

    for (const domain of DOMAIN_LOAD_ORDER) {
      if (this.disposed) return;
      await this.loadDomain(domain);
    }
  }

  /**
   * Load a single domain's index tier.
   *
   * AC: @daemon-entity-cache ac-graceful-degradation — errors mark domain degraded
   * AC: @daemon-entity-cache ac-reload-dedup — in-flight promise dedup
   * AC: @daemon-entity-cache ac-stale-during-reload — ready domains stay ready during reload
   * AC: @daemon-entity-cache ac-domain-ready-event — broadcast on non-ready → ready transition
   */
  async loadDomain(domain: CacheDomain, cycle?: ReloadCycle): Promise<void> {
    if (this.disposed) return;

    if (domain === "meta") {
      await this.loadMetaDomain(META_SUBDOMAIN_LOAD_ORDER, cycle);
      return;
    }

    await this.runNonMetaDomainReload(domain, "dedupe", async () => {
      await this.loadNonMetaDomain(domain, cycle);
    });
  }

  private async doLoadDomain(domain: CacheDomain, cycle?: ReloadCycle): Promise<void> {
    // Test-only: wait for delay gate before loading (KSPEC_TEST)
    await awaitTestDelay(this.projectPath);
    if (this.disposed) return;

    const ctx = cycle
      ? await this.getReloadCycleContext(cycle)
      : await initContext(this.projectPath);
    // AC: @daemon-entity-cache ac-unregister-cleanup — bail after each await
    // to prevent a completed load from repopulating stores that dispose() cleared.
    if (this.disposed) return;

    switch (domain) {
      case "tasks": {
        // AC: @daemon-entity-cache ac-load-on-register — load task index
        // AC: @daemon-entity-cache ac-stale-during-reload — build new data locally,
        // then swap into the store atomically so reads see either all-old or all-new.
        // AC: @daemon-entity-cache ac-task-history-retention — bulk load retains history
        const tdm = resolveTaskDataManager(ctx);
        const summaries = await tdm.listTasks(ctx);
        if (this.disposed) return;
        // Eagerly populate detail tier so search (grepItem) can access full
        // entity data (description, notes, todos) that summaries strip.
        // Uses bulk loadAllTasksWithHistory() for a single pass instead of
        // per-task loadTaskWithHistory() calls — avoids N individual reads
        // during cache warm-up.
        // Non-fatal: if full loading fails, the detail tier stays empty and
        // search falls through to disk on miss.
        const newTaskDetails = new Map<string, CachedTaskDetail>();
        const newTaskHistoryDetails = new Map<string, HistoryEntry[]>();
        try {
          const tasksWithHistory = await tdm.loadAllTasksWithHistory(ctx);
          if (this.disposed) return;
          for (const { task, history } of tasksWithHistory) {
            newTaskDetails.set(task._ulid, task);
            newTaskHistoryDetails.set(task._ulid, history);
          }
        } catch {
          // Detail tier remains empty — search will use summaries or fall back to disk
        }
        // Atomic swap: replace index and details together
        this.tasks.index = summaries;
        this.tasks.details = newTaskDetails;
        this.tasks.historyDetails = newTaskHistoryDetails;
        break;
      }
      case "items": {
        // AC: @daemon-entity-cache ac-load-on-register — load item index + detail tier
        // AC: @daemon-entity-cache ac-stale-during-reload — build new data locally,
        // then swap into the store atomically so reads see either all-old or all-new.
        // Populate detail tier alongside index so full entities are available
        // for search (grepItem needs description, notes, AC content).
        const loadedItems = await loadAllItems(ctx);
        if (this.disposed) return;
        const newItemDetails = new Map<string, LoadedSpecItem>();
        const newItemSourceFiles = new Map<string, string>();
        for (const item of loadedItems) {
          newItemDetails.set(item._ulid, item);
          if (item._sourceFile) {
            newItemSourceFiles.set(item._ulid, item._sourceFile);
          }
        }
        // Atomic swap: replace index and details together
        this.items.index = loadedItems.map(toItemSummary);
        this.items.details = newItemDetails;
        this.itemSourceFiles = newItemSourceFiles;
        this.itemSourceFilesTracked = true;
        break;
      }
      case "meta": {
        await this.loadMetaManifestSubdomain(cycle);
        if (this.disposed) return;
        await this.loadMetaShadowSubdomain(cycle);
        if (this.disposed) return;
        await this.loadMetaSessionSubdomain();
        break;
      }
      case "inbox": {
        const inboxItems = await loadInboxItems(ctx);
        if (this.disposed) return;
        this.inbox.index = inboxItems;
        break;
      }
      case "plans": {
        // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
        // AC: @daemon-read-path ac-no-per-request-sync
        //     — run the strict folder-storage gate BEFORE loadPlans() so the
        //     cache cannot enter "ready" with monolithic data warmed via the
        //     lenient gate. Without this, the daemon plan routes' cache-ready
        //     fast path would serve legacy data with 200 instead of the
        //     required structured 409. When this throws, the catch block in
        //     runNonMetaDomainReload marks the plans domain "degraded" with
        //     the stored EntityStorageCompatibilityError; route handlers
        //     observe a non-"ready" state and run the gate at request entry,
        //     where the deterministic incompatibility is translated into 409.
        await requirePlanFolderStorage(ctx);
        if (this.disposed) return;
        const loadedPlans = await loadPlans(ctx);
        if (this.disposed) return;
        // AC: @daemon-entity-cache ac-stale-during-reload — atomic swap
        this.plans.index = loadedPlans.map(toPlanIndexSummary);
        // AC: @daemon-entity-cache ac-detail-on-demand — reset detail cache;
        // full plan records are loaded on demand when accessed by ID.
        this.plans.details = new Map();
        break;
      }
      case "triage": {
        const triageRecords = await loadTriageRecords(ctx);
        if (this.disposed) return;
        // AC: @daemon-entity-cache ac-stale-during-reload — atomic swap
        this.triage.index = triageRecords.map(toTriageIndexSummary);
        // AC: @daemon-entity-cache ac-detail-on-demand — reset detail cache;
        // full triage records are loaded on demand when accessed by ID.
        this.triage.details = new Map();
        break;
      }
      case "reviews": {
        // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
        // AC: @daemon-read-path ac-no-per-request-sync
        //     — run the strict folder-storage gate BEFORE loadReviewRecords()
        //     so the cache cannot enter "ready" with monolithic data warmed
        //     via the lenient gate (see the "plans" case for the full
        //     rationale).
        await requireReviewFolderStorage(ctx);
        if (this.disposed) return;
        const reviewRecords = await loadReviewRecords(ctx);
        if (this.disposed) return;
        // AC: @daemon-entity-cache ac-stale-during-reload — atomic swap
        this.reviews.index = reviewRecords.map(toReviewIndexSummary);
        // AC: @daemon-entity-cache ac-detail-on-demand — reset detail cache;
        // full review records are loaded on demand when accessed by ID.
        this.reviews.details = new Map();
        break;
      }
      case "sessions": {
        await this.loadSessionIndex(ctx);
        break;
      }
    }
  }

  /**
   * Load session index with bounding and stale exclusion.
   *
   * AC: @daemon-entity-cache ac-session-bounded-index
   * AC: @daemon-entity-cache ac-session-stale-exclusion
   */
  private async loadSessionIndex(ctx: KspecContext): Promise<void> {
    const sessionsDir = ctx.sessionsDir;
    let sessionIds: string[];
    let directory: Dir | null = null;

    try {
      directory = await fs.opendir(sessionsDir);
      sessionIds = [];

      while (true) {
        const entry = await directory.read();
        if (entry === null) break;
        if (entry.isDirectory()) {
          sessionIds.push(entry.name);
        }
        if (this.disposed) return;
      }
    } catch {
      // No sessions directory — empty index
      if (this.disposed) return;
      this.sessions.index = [];
      return;
    } finally {
      if (directory) {
        await closeDirectoryHandle(directory);
      }
    }

    // Load metadata-only summaries for all sessions (avoids reading events.jsonl)
    const summaries: SessionLogSummary[] = [];
    for (const id of sessionIds) {
      if (this.disposed) return;
      try {
        const summary = await getSessionMetadataOnly(sessionsDir, id);
        if (summary) summaries.push(summary);
      } catch (err) {
        console.warn(
          `[entity-cache] Skipping session ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Sort by started_at descending (most recent first)
    summaries.sort((a, b) => {
      const aTs = new Date(a.started_at).getTime();
      const bTs = new Date(b.started_at).getTime();
      return bTs - aTs;
    });

    // AC: @daemon-entity-cache ac-session-stale-exclusion
    // Resolve stale criteria — sessions with active status that exceed thresholds
    // are not treated as active in the cached index
    const staleResolved = resolveStaleSessionCriteria({});
    if (staleResolved.ok) {
      const now = Date.now();
      const { olderThanMs, inactiveForMs } = staleResolved.criteria;

      for (let i = 0; i < summaries.length; i++) {
        const s = summaries[i];
        if (s.status !== "active") continue;

        const startedAtMs = new Date(s.started_at).getTime();
        const ageMs = now - startedAtMs;

        // Check if this active session exceeds the stale criteria
        if (ageMs > olderThanMs) {
          // Check inactivity via file-based activity check
          const activityResult = await getSessionActivityForStaleCheck(sessionsDir, s.id);
          if (this.disposed) return;
          if (activityResult.ok) {
            const inactivityMs = now - activityResult.activity.lastActivityTs;
            if (inactivityMs > inactiveForMs) {
              // Mark as stale in the index — keep the summary but override the active flag
              // so consumers know this isn't truly active
              summaries[i] = { ...s, status: "stalled" as SessionLogSummary["status"] };
            }
          }
        }
      }
    }

    // AC: @daemon-entity-cache ac-unregister-cleanup — bail if disposed during stale check
    if (this.disposed) return;

    // AC: @daemon-entity-cache ac-session-bounded-index — keep only N most recent
    this.sessions.index = summaries.slice(0, this.sessionConfig.maxIndexSize);
    this.sessions.details.clear();
  }

  // ─── Invalidation ────────────────────────────────────────────────────────

  /**
   * Invalidate a domain and reload from disk.
   * Called by file watcher when a shadow branch file changes.
   *
   * Uses domain-level debouncing to coalesce rapid multi-file changes into
   * a single reload per domain. For example, if modules/a.yaml and
   * modules/b.yaml both change within 100ms, only one "items" reload fires.
   *
   * AC: @daemon-entity-cache ac-watcher-invalidation
   * AC: @daemon-entity-cache ac-granular-reload
   * AC: @daemon-entity-cache ac-reload-dedup
   */
  async invalidateDomain(domain: CacheDomain): Promise<void> {
    if (this.disposed) return;

    if (domain === "items" || domain === "meta") {
      invalidateCoverageStateReadModelCache(this.projectPath);
    }

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-rechecked-after-storage-change
    // Watcher-driven invalidation of the tasks domain is the canonical
    // signal of a relevant project-state change: project.tasks.yaml,
    // tasks/<ULID>/*, and kynetic.yaml all map to "tasks" via fileToDomain.
    // Flip the recheck flag synchronously so the upcoming reload re-evaluates
    // current task-storage state — suppression lifts before the debounced
    // reload actually runs.
    if (domain === "tasks") {
      this.tasks.needsTaskStorageRecheck = true;
    }

    // AC: @daemon-entity-cache ac-write-through — skip if write-through just updated this domain
    if (this.writeThroughSkip.has(domain)) {
      this.writeThroughSkip.delete(domain);
      this.pendingDomainChanges.delete(domain);
      return;
    }

    // AC: @daemon-entity-cache ac-reload-dedup — domain-level debounce.
    // Reset the timer on each call; when it finally fires, all callers
    // awaiting this domain's debounced promise get resolved together.
    const existingTimer = this.domainDebounceTimers.get(domain);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const cycle =
      this.domainReloadCycles.get(domain) ??
      (this.pendingDomainChanges.has(domain)
        ? this.getOrCreateReloadCycle()
        : { pendingDomains: new Set() });
    cycle.pendingDomains.add(domain);
    this.domainReloadCycles.set(domain, cycle);

    // Create or reuse the deferred promise for this domain's debounce window
    let deferred = this.domainDebouncePromises.get(domain);
    if (!deferred) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      deferred = { resolve, promise };
      this.domainDebouncePromises.set(domain, deferred);
    }

    const timer = setTimeout(async () => {
      this.domainDebounceTimers.delete(domain);
      const reloadCycle = this.domainReloadCycles.get(domain);
      this.domainReloadCycles.delete(domain);
      const pendingChanges = this.drainPendingDomainChanges(domain);
      if (reloadCycle) {
        reloadCycle.pendingDomains.delete(domain);
        this.maybeClearReloadCycle(reloadCycle);
      }
      const d = this.domainDebouncePromises.get(domain);
      this.domainDebouncePromises.delete(domain);
      try {
        // AC: @daemon-server ac-18 — track last invalidation timestamp
        this.getStore(domain).lastInvalidatedAt = new Date().toISOString();
        await this.processDomainChanges(domain, pendingChanges, reloadCycle);
        if (!this.disposed && this.getStore(domain).state === "ready") {
          this.onDomainReloaded?.(domain, this.projectPath);
        }
      } finally {
        d?.resolve();
      }
    }, this.domainDebounceMs);

    this.domainDebounceTimers.set(domain, timer);
    await deferred.promise;
  }

  /**
   * Handle a file change event from the watcher.
   * Maps the file path to a domain and invalidates it.
   *
   * AC: @daemon-entity-cache ac-watcher-invalidation
   * AC: @daemon-entity-cache ac-granular-reload
   */
  async handleFileChange(kspecDir: string, filePath: string, _content?: string): Promise<void> {
    if (this.disposed) return;

    const relativePath = relative(kspecDir, filePath);
    // Detect whether this change came from the sessions directory (.kspec-sessions/)
    // or the spec directory (.kspec/). Session IDs can be arbitrary strings (not just
    // ULIDs), so we pass a source hint to fileToDomain for correct domain mapping.
    const source = kspecDir.endsWith(".kspec-sessions")
      ? ("sessions" as const)
      : ("kspec" as const);
    const domains = fileToDomain(relativePath, source);
    if (domains) {
      for (const domain of domains) {
        this.recordPendingDomainChange(domain, filePath, _content);
      }
      await Promise.all(domains.map((d) => this.invalidateDomain(d)));
    }
  }

  /**
   * Mark a domain for write-through skip.
   * The next watcher invalidation for this domain will be ignored.
   *
   * AC: @daemon-entity-cache ac-write-through
   */
  markWriteThrough(domain: CacheDomain): void {
    this.writeThroughSkip.add(domain);
  }

  /**
   * Write-through update: refresh domain index from disk and skip
   * the next watcher invalidation.
   *
   * Only sets the skip flag after loadDomain() succeeds — if the reload
   * fails the watcher invalidation must NOT be suppressed, so a subsequent
   * file-change event can still recover the domain from degraded state.
   *
   * AC: @daemon-entity-cache ac-write-through
   */
  async writeThrough(domain: CacheDomain, entityHint?: WriteThroughHint): Promise<void> {
    // AC: @daemon-server ac-18 — track last invalidation timestamp
    this.getStore(domain).lastInvalidatedAt = new Date().toISOString();
    await this.runHintedWriteThrough(domain, entityHint);
    // Only suppress the next watcher invalidation when the reload succeeded —
    // if the domain degraded, the watcher must still fire so a subsequent
    // file-change event can recover the domain.
    if (this.getStore(domain).state === "ready") {
      this.markWriteThrough(domain);
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Dispose the cache — release all data and cancel in-flight reloads.
   *
   * AC: @daemon-entity-cache ac-unregister-cleanup
   */
  dispose(): void {
    this.disposed = true;

    // Release all domain data
    for (const domain of DOMAIN_LOAD_ORDER) {
      const store = this.getStore(domain);
      store.index = null;
      store.details.clear();
      if (domain === "tasks") {
        this.tasks.historyDetails.clear();
        this.tasks.storageIncompatibility = null;
        this.tasks.needsTaskStorageRecheck = true;
      }
      store.state = "unloaded";
      store.lastError = undefined;
    }

    this.inFlightReloads.clear();
    this.writeThroughSkip.clear();
    this.liveEventCounts.clear();
    this.itemSourceFiles.clear();
    this.itemSourceFilesTracked = false;
    this.cachedShadowInfo = null;
    this.cachedProjectConfig = null;
    this.cachedSessionContext = null;
    this.cachedMetaRuntime = null;
    this.metaLoadState = {
      manifest: false,
      shadow: false,
      session: false,
    };
    this.pendingMetaSubdomains.clear();
    this.activeMetaSubdomains.clear();
    this.pendingMetaReloadCycle = undefined;

    // Clear domain debounce timers
    for (const timer of this.domainDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.domainDebounceTimers.clear();
    this.pendingDomainChanges.clear();
    this.domainReloadCycles.clear();
    // Resolve any pending debounce promises so awaiting callers don't hang
    for (const deferred of this.domainDebouncePromises.values()) {
      deferred.resolve();
    }
    this.domainDebouncePromises.clear();
    this.currentReloadCycle = null;
  }

  /** Check if the cache has been disposed. */
  isDisposed(): boolean {
    return this.disposed;
  }

  // ─── Internal Helpers ────────────────────────────────────────────────────

  /** Get the store for a domain. */
  private getStore(domain: CacheDomain): DomainStore<unknown> {
    switch (domain) {
      case "tasks":
        return this.tasks;
      case "items":
        return this.items;
      case "meta":
        return this.meta;
      case "inbox":
        return this.inbox;
      case "plans":
        return this.plans;
      case "triage":
        return this.triage;
      case "reviews":
        return this.reviews;
      case "sessions":
        return this.sessions;
    }
  }

  private getOrCreateReloadCycle(): ReloadCycle {
    if (!this.currentReloadCycle) {
      this.currentReloadCycle = {
        pendingDomains: new Set(),
      };
    }
    return this.currentReloadCycle;
  }

  private async getReloadCycleContext(cycle: ReloadCycle): Promise<KspecContext> {
    cycle.contextPromise ??= initContext(this.projectPath);
    return await cycle.contextPromise;
  }

  private maybeClearReloadCycle(cycle: ReloadCycle): void {
    if (this.currentReloadCycle === cycle && cycle.pendingDomains.size === 0) {
      this.currentReloadCycle = null;
    }
  }

  private recordPendingDomainChange(domain: CacheDomain, filePath: string, content?: string): void {
    let changes = this.pendingDomainChanges.get(domain);
    if (!changes) {
      changes = new Map<string, PendingDomainChange>();
      this.pendingDomainChanges.set(domain, changes);
    }

    changes.set(filePath, { filePath, content });
  }

  private drainPendingDomainChanges(domain: CacheDomain): PendingDomainChange[] {
    const changes = this.pendingDomainChanges.get(domain);
    if (!changes) {
      return [];
    }

    this.pendingDomainChanges.delete(domain);
    return Array.from(changes.values());
  }

  private async tryHintedWriteThrough(
    domain: CacheDomain,
    entityHint?: WriteThroughHint,
  ): Promise<boolean> {
    if (!entityHint) {
      return false;
    }

    const change = await this.buildWriteThroughChange(domain, entityHint);
    if (!change) {
      return false;
    }

    await this.processDomainChanges(domain, [change]);
    return true;
  }

  private async runHintedWriteThrough(
    domain: CacheDomain,
    entityHint?: WriteThroughHint,
  ): Promise<void> {
    if (domain === "meta") {
      const handledIncrementally = await this.tryHintedWriteThrough(domain, entityHint);
      if (!handledIncrementally) {
        await this.loadDomain(domain);
      }
      return;
    }

    await this.runNonMetaDomainReload(domain, "queue", async () => {
      const handledIncrementally = await this.tryHintedWriteThrough(domain, entityHint);
      if (!handledIncrementally) {
        await this.loadNonMetaDomain(domain);
      }
    });
  }

  private async loadNonMetaDomain(
    domain: Exclude<CacheDomain, "meta">,
    cycle?: ReloadCycle,
  ): Promise<void> {
    // AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
    // AC: @daemon-entity-cache ac-task-storage-incompatibility-persists-when-unresolved
    // Bounded degraded-state behavior for the tasks domain: when a previous
    // load surfaced a deterministic task-storage incompatibility and no
    // relevant project-state change has been observed since, skip the reload
    // entirely. The store keeps its degraded state and lastError diagnostics;
    // no new failure report is emitted. Initial loads, explicit loadDomain
    // calls, writeThrough fallback reloads, and queued reloads all observe
    // the same suppression because they all funnel through this method.
    if (domain === "tasks" && this.isTaskStorageSuppressionActive()) {
      return;
    }

    const store = this.getStore(domain);

    // AC: @daemon-entity-cache ac-domain-ready-event — capture state before
    // transition so we can detect non-ready → ready and fire the callback.
    const previousState = store.state;

    // AC: @daemon-entity-cache ac-stale-during-reload — only transition to
    // "loading" for initial loads. When a domain is already "ready", keep it
    // ready so API routes continue serving cached data during the reload.
    // Previously cached data remains accessible until doLoadDomain() swaps
    // in the new data on completion.
    if (store.state !== "ready") {
      store.state = "loading";
    }

    try {
      await this.doLoadDomain(domain, cycle);
      if (!this.disposed) {
        store.state = "ready";
        store.lastError = undefined;

        // AC: @daemon-entity-cache ac-task-storage-incompatibility-recovers-after-migration
        // A successful load clears any prior deterministic task-storage
        // incompatibility — the project state is now compatible.
        if (domain === "tasks") {
          this.tasks.storageIncompatibility = null;
          this.tasks.needsTaskStorageRecheck = false;
        }

        // AC: @daemon-entity-cache ac-domain-ready-event — only fire when
        // transitioning FROM a non-ready state. Reloads of already-ready
        // domains (ac-stale-during-reload) do not trigger the event.
        if (previousState !== "ready" && this.onDomainReady) {
          this.onDomainReady(domain, this.projectPath, previousState);
        }
      }
    } catch (err) {
      if (this.disposed) {
        return;
      }

      // AC: @daemon-entity-cache ac-task-storage-incompatibility-degraded-state
      // AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
      // Deterministic task-storage incompatibility: track the stable code so
      // subsequent reload attempts are suppressed until a project-state
      // change clears it. Generic TaskDataManagerError cases (validation,
      // not-found, mutation) fall through to the normal degrade-on-error
      // path because they may resolve on retry.
      if (domain === "tasks" && isDeterministicTaskStorageIncompatibility(err)) {
        this.noteTaskStorageIncompatibility(err);
        return;
      }

      // AC: @daemon-entity-cache ac-graceful-degradation
      // Non-deterministic failure: clear any prior storage-incompatibility
      // marker so this generic error is not silently held under suppression
      // intended for deterministic cases.
      if (domain === "tasks") {
        this.tasks.storageIncompatibility = null;
        this.tasks.needsTaskStorageRecheck = false;
      }
      store.state = "degraded";
      store.lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[entity-cache] Failed to load domain "${domain}":`, err);
    }
  }

  /**
   * True when the tasks domain has an active deterministic task-storage
   * incompatibility and no relevant project-state change has been observed
   * since the last evaluation. Callers should bypass any reload work.
   *
   * AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
   * AC: @daemon-entity-cache ac-task-storage-incompatibility-persists-when-unresolved
   */
  private isTaskStorageSuppressionActive(): boolean {
    return this.tasks.storageIncompatibility !== null && !this.tasks.needsTaskStorageRecheck;
  }

  /**
   * Record a deterministic task-storage incompatibility surfaced by a load
   * attempt. The marker keeps the tasks domain degraded with stable
   * diagnostics; repeat observations of the same code suppress the duplicate
   * failure log so logs do not amplify the unchanged condition.
   *
   * AC: @daemon-entity-cache ac-task-storage-incompatibility-degraded-state
   * AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
   * AC: @daemon-entity-cache ac-task-storage-incompatibility-persists-when-unresolved
   */
  private noteTaskStorageIncompatibility(err: TaskDataManagerError & { code: string }): void {
    const previous = this.tasks.storageIncompatibility;
    const sameCondition = previous !== null && previous.code === err.code;

    this.tasks.storageIncompatibility = {
      code: err.code,
      message: err.message,
      suggestion: err.suggestion ?? null,
      field: err.field ?? null,
      // Preserve the original observation timestamp when the same code
      // persists across rechecks — the condition itself has not changed.
      observedAt: sameCondition ? previous!.observedAt : new Date().toISOString(),
    };
    this.tasks.needsTaskStorageRecheck = false;
    this.tasks.state = "degraded";
    this.tasks.lastError = err;

    if (!sameCondition) {
      console.error(`[entity-cache] Failed to load domain "tasks":`, err);
    }
  }

  private async runNonMetaDomainReload(
    domain: Exclude<CacheDomain, "meta">,
    mode: "dedupe" | "queue",
    work: () => Promise<void>,
  ): Promise<void> {
    const existing = this.inFlightReloads.get(domain);
    if (mode === "dedupe" && existing) {
      await existing;
      return;
    }

    const promise = (async () => {
      if (mode === "queue" && existing) {
        await existing;
      }
      if (this.disposed) {
        return;
      }
      await work();
    })().finally(() => {
      if (this.inFlightReloads.get(domain) === promise) {
        this.inFlightReloads.delete(domain);
      }
    });

    this.inFlightReloads.set(domain, promise);
    await promise;
  }

  private async buildWriteThroughChange(
    domain: CacheDomain,
    entityHint: WriteThroughHint,
  ): Promise<PendingDomainChange | null> {
    if (entityHint.filePath) {
      return { filePath: entityHint.filePath };
    }

    switch (domain) {
      case "tasks": {
        if (!entityHint.ulid) {
          return null;
        }
        const ctx = await initContext(this.projectPath);
        return { filePath: getTaskFilePath(ctx, entityHint.ulid) };
      }
      case "items": {
        if (!entityHint.ulid) {
          return null;
        }
        const filePath =
          this.itemSourceFiles.get(entityHint.ulid) ??
          this.items.details.get(entityHint.ulid)?._sourceFile ??
          null;
        return filePath ? { filePath } : null;
      }
      case "sessions": {
        const sessionId = entityHint.sessionId ?? entityHint.ulid;
        if (!sessionId) {
          return null;
        }
        const ctx = await initContext(this.projectPath);
        return { filePath: getSessionDir(ctx.sessionsDir, sessionId) };
      }
      default:
        return null;
    }
  }

  private async processDomainChanges(
    domain: CacheDomain,
    changes: PendingDomainChange[],
    cycle?: ReloadCycle,
  ): Promise<void> {
    // AC: @daemon-entity-cache ac-task-storage-incompatibility-stable-reporting
    // Suppression applies before any incremental path so writeThrough fallback
    // reloads and watcher-driven incremental refreshes both honor the
    // bounded degraded behavior when no state change has been observed.
    if (domain === "tasks" && this.isTaskStorageSuppressionActive()) {
      return;
    }

    if (domain === "meta" && (await this.tryIncrementalMetaUpdate(changes, cycle))) {
      return;
    }

    if (domain === "tasks" && (await this.tryIncrementalTaskUpdate(changes, cycle))) {
      return;
    }

    if (domain === "sessions" && (await this.tryIncrementalSessionUpdate(changes, cycle))) {
      return;
    }

    if (domain === "items" && (await this.tryIncrementalItemUpdate(changes, cycle))) {
      return;
    }

    await this.loadDomain(domain, cycle);
  }

  async refreshMetaShadowInfo(): Promise<void> {
    await this.loadMetaDomain(["shadow"]);
  }

  private async tryIncrementalMetaUpdate(
    changes: PendingDomainChange[],
    cycle?: ReloadCycle,
  ): Promise<boolean> {
    if (changes.length === 0) {
      return false;
    }

    const runtime = this.cachedMetaRuntime;
    const specDir = runtime?.specDir ?? join(this.projectPath, ".kspec");
    const manifestSourceFiles = new Set(runtime?.metaSourceFiles ?? []);
    const targets = new Set<MetaSubdomain>();

    for (const change of changes) {
      const relativePath = relative(specDir, change.filePath);
      const pathSegments = relativePath.split(/[\\/]/).filter(Boolean);
      const leaf = pathSegments[pathSegments.length - 1] ?? relativePath;
      if (
        leaf === "kynetic.yaml" ||
        leaf.endsWith(".meta.yaml") ||
        manifestSourceFiles.has(change.filePath)
      ) {
        targets.add("manifest");
        continue;
      }

      if (leaf === ".kspec-session") {
        targets.add("session");
        continue;
      }

      return false;
    }

    if (targets.size === 0) {
      return false;
    }

    await this.loadMetaDomain([...targets], cycle);
    return true;
  }

  private async tryIncrementalTaskUpdate(
    changes: PendingDomainChange[],
    cycle?: ReloadCycle,
  ): Promise<boolean> {
    if (changes.length === 0 || this.tasks.state !== "ready" || !this.tasks.index) {
      return false;
    }

    const ctx = cycle
      ? await this.getReloadCycleContext(cycle)
      : await initContext(this.projectPath);
    const changedUlids = new Set<string>();

    for (const change of changes) {
      const relativePath = relative(ctx.specDir, change.filePath);
      if (
        relativePath === "project.tasks.yaml" ||
        relativePath === "tasks.yaml" ||
        relativePath.endsWith(".tasks.yaml")
      ) {
        return false;
      }
      const segments = relativePath.split(/[\\/]/).filter(Boolean);
      if (
        segments.length !== 3 ||
        segments[0] !== "tasks" ||
        !TASK_ULID_PATTERN.test(segments[1]) ||
        (segments[2] !== "task.yaml" && segments[2] !== "notes.yaml")
      ) {
        return false;
      }

      changedUlids.add(segments[1]);
    }

    if (changedUlids.size === 0) {
      return false;
    }

    // AC: @daemon-entity-cache ac-task-storage-incompatibility-degraded-state
    // resolveTaskDataManager throws a deterministic incompatibility error
    // when the manifest is legacy/unmigrated. Funnel that into the same
    // bounded degraded-state behavior the full-reload path uses so the
    // incremental write-through path does not bypass suppression. Other
    // throws propagate unchanged.
    let tdm: ReturnType<typeof resolveTaskDataManager>;
    try {
      tdm = resolveTaskDataManager(ctx);
    } catch (err) {
      if (isDeterministicTaskStorageIncompatibility(err)) {
        this.noteTaskStorageIncompatibility(err);
        return true;
      }
      throw err;
    }
    const nextIndex = [...this.tasks.index];
    const nextDetails = new Map(this.tasks.details);
    const nextHistoryDetails = new Map(this.tasks.historyDetails);

    for (const ulid of changedUlids) {
      const taskFilePath = getTaskFilePath(ctx, ulid);
      let taskExists = true;
      try {
        await fs.access(taskFilePath);
      } catch {
        taskExists = false;
      }

      const existingIndex = nextIndex.findIndex((task) => task._ulid === ulid);

      if (!taskExists) {
        if (existingIndex >= 0) {
          nextIndex.splice(existingIndex, 1);
        }
        nextDetails.delete(ulid);
        nextHistoryDetails.delete(ulid);
        continue;
      }

      const { task: loadedTask, history } = await tdm.loadTaskWithHistory(ctx, ulid);
      if (!loadedTask) {
        return false;
      }
      const summary = rawToSummary(loadedTask);
      if (!summary) {
        return false;
      }

      if (existingIndex >= 0) {
        nextIndex[existingIndex] = summary;
      } else {
        nextIndex.push(summary);
      }
      nextDetails.set(ulid, loadedTask);
      nextHistoryDetails.set(ulid, history);
    }

    this.tasks.index = nextIndex;
    this.tasks.details = nextDetails;
    this.tasks.historyDetails = nextHistoryDetails;
    return true;
  }

  private async tryIncrementalSessionUpdate(
    changes: PendingDomainChange[],
    cycle?: ReloadCycle,
  ): Promise<boolean> {
    if (changes.length === 0 || this.sessions.state !== "ready" || !this.sessions.index) {
      return false;
    }

    const ctx = cycle
      ? await this.getReloadCycleContext(cycle)
      : await initContext(this.projectPath);
    const changedSessionIds = new Set<string>();

    for (const change of changes) {
      const relativePath = relative(ctx.sessionsDir, change.filePath);
      const segments = relativePath.split(/[\\/]/).filter(Boolean);
      if (segments.length === 0 || relativePath.startsWith("..")) {
        return false;
      }

      changedSessionIds.add(segments[0]);
    }

    if (changedSessionIds.size === 0) {
      return false;
    }

    const nextIndex = [...this.sessions.index];
    const nextDetails = new Map(this.sessions.details);

    for (const sessionId of changedSessionIds) {
      const sessionDir = getSessionDir(ctx.sessionsDir, sessionId);
      let sessionExists = true;
      try {
        await fs.access(sessionDir);
      } catch {
        sessionExists = false;
      }

      const existingIndex = nextIndex.findIndex((session) => session.id === sessionId);

      if (!sessionExists) {
        if (existingIndex >= 0) {
          nextIndex.splice(existingIndex, 1);
        }
        nextDetails.delete(sessionId);
        this.liveEventCounts.delete(sessionId);
        continue;
      }

      const summary = await this.loadCachedSessionSummary(ctx.sessionsDir, sessionId);
      if (!summary) {
        if (existingIndex >= 0) {
          nextIndex.splice(existingIndex, 1);
        }
        nextDetails.delete(sessionId);
        this.liveEventCounts.delete(sessionId);
        continue;
      }

      if (existingIndex >= 0) {
        nextIndex[existingIndex] = summary;
      } else {
        nextIndex.push(summary);
      }
      // Session detail is loaded on demand and may include live event counts.
      // Drop any cached detail so routes fall back to the refreshed index/detail loader.
      nextDetails.delete(sessionId);

      if (summary.status !== "active" && summary.status !== "stalled") {
        this.liveEventCounts.delete(sessionId);
      }
    }

    sortSessionSummaries(nextIndex);
    this.sessions.index = nextIndex.slice(0, this.sessionConfig.maxIndexSize);
    this.sessions.details = nextDetails;
    return true;
  }

  private async loadCachedSessionSummary(
    sessionsDir: string,
    sessionId: string,
  ): Promise<SessionLogSummary | null> {
    const summary = await getSessionMetadataOnly(sessionsDir, sessionId);
    if (!summary || summary.status !== "active") {
      return summary;
    }

    const staleResolved = resolveStaleSessionCriteria({});
    if (!staleResolved.ok) {
      return summary;
    }

    const now = Date.now();
    const startedAtMs = new Date(summary.started_at).getTime();
    if (now - startedAtMs <= staleResolved.criteria.olderThanMs) {
      return summary;
    }

    const activityResult = await getSessionActivityForStaleCheck(sessionsDir, sessionId);
    if (!activityResult.ok) {
      return summary;
    }

    const inactivityMs = now - activityResult.activity.lastActivityTs;
    if (inactivityMs <= staleResolved.criteria.inactiveForMs) {
      return summary;
    }

    return { ...summary, status: "stalled" };
  }

  private async tryIncrementalItemUpdate(
    changes: PendingDomainChange[],
    cycle?: ReloadCycle,
  ): Promise<boolean> {
    if (
      changes.length === 0 ||
      this.items.state !== "ready" ||
      this.items.index === null ||
      !this.itemSourceFilesTracked
    ) {
      return false;
    }

    const ctx = cycle
      ? await this.getReloadCycleContext(cycle)
      : await initContext(this.projectPath);
    if (this.disposed) return true;
    if (!ctx.manifest || !ctx.manifestPath) return false;

    const orderedSourceFiles = await this.getOrderedItemSourceFiles(ctx);
    if (this.disposed) return true;
    const allowedSourceFiles = new Set(orderedSourceFiles);

    const changedFiles: string[] = [];
    for (const change of changes) {
      if (change.filePath === ctx.manifestPath) {
        return false;
      }

      const relativePath = relative(ctx.specDir, change.filePath);
      if (relativePath.startsWith("..") || !allowedSourceFiles.has(change.filePath)) {
        return false;
      }

      changedFiles.push(change.filePath);
    }

    const newDetails = new Map(this.items.details);
    const newSourceFiles = new Map(this.itemSourceFiles);
    const removedUlids = new Set<string>();
    const groupedSummaries = new Map<string, ItemSummary[]>();
    const parsedItemsByUlid = new Map<string, LoadedSpecItem>();

    for (const filePath of changedFiles) {
      for (const [ulid, sourceFile] of newSourceFiles) {
        if (sourceFile === filePath) {
          removedUlids.add(ulid);
        }
      }

      const parsedItems = await loadSpecFile(filePath);
      if (this.disposed) return true;

      const summaries: ItemSummary[] = [];
      for (const item of parsedItems) {
        removedUlids.add(item._ulid);
        parsedItemsByUlid.set(item._ulid, item);
        summaries.push(toItemSummary(item));
      }

      groupedSummaries.set(filePath, summaries);
    }

    for (const ulid of removedUlids) {
      newDetails.delete(ulid);
      newSourceFiles.delete(ulid);
    }

    for (const [ulid, item] of parsedItemsByUlid) {
      newDetails.set(ulid, item);
      if (item._sourceFile) {
        newSourceFiles.set(ulid, item._sourceFile);
      }
    }

    const groupedExisting = new Map<string, ItemSummary[]>();
    for (const item of this.items.index) {
      if (removedUlids.has(item._ulid) || !item._sourceFile) {
        continue;
      }

      const existing = groupedExisting.get(item._sourceFile);
      if (existing) {
        existing.push(item);
      } else {
        groupedExisting.set(item._sourceFile, [item]);
      }
    }

    for (const [filePath, summaries] of groupedSummaries) {
      if (summaries.length > 0) {
        groupedExisting.set(filePath, summaries);
      } else {
        groupedExisting.delete(filePath);
      }
    }

    const nextIndex: ItemSummary[] = [];
    for (const filePath of orderedSourceFiles) {
      const summaries = groupedExisting.get(filePath);
      if (summaries) {
        nextIndex.push(...summaries);
      }
    }

    this.items.index = nextIndex;
    this.items.details = newDetails;
    this.itemSourceFiles = newSourceFiles;
    return true;
  }

  private async getOrderedItemSourceFiles(ctx: KspecContext): Promise<string[]> {
    if (!ctx.manifest || !ctx.manifestPath) {
      return [];
    }

    const orderedFiles = [ctx.manifestPath];
    const manifestDir = dirname(ctx.manifestPath);

    for (const include of ctx.manifest.includes ?? []) {
      const expandedPaths = await expandIncludePattern(include, manifestDir);
      orderedFiles.push(...expandedPaths);
    }

    return orderedFiles;
  }

  private async loadMetaDomain(subdomains: MetaSubdomain[], cycle?: ReloadCycle): Promise<void> {
    if (this.disposed) return;

    this.enqueueMetaReload(subdomains, cycle);
    const existing = this.inFlightReloads.get("meta");
    if (existing) {
      await existing;
      return;
    }

    const previousState = this.meta.state;
    if (this.meta.state !== "ready") {
      this.meta.state = "loading";
    }

    const promise = (async () => {
      try {
        while (true) {
          const nextReload = this.drainPendingMetaReload();
          if (!nextReload) {
            break;
          }

          await this.doLoadMetaSubdomains(nextReload.subdomains, nextReload.cycle);
          if (this.disposed) return;
        }
        this.meta.lastError = undefined;
        if (this.hasLoadedAllMetaSubdomains()) {
          this.meta.state = "ready";
          if (previousState !== "ready" && this.onDomainReady) {
            this.onDomainReady("meta", this.projectPath, previousState);
          }
        } else if (previousState === "ready") {
          this.meta.state = "ready";
        }
      } catch (err) {
        if (!this.disposed) {
          this.meta.state = "degraded";
          this.meta.lastError = err instanceof Error ? err : new Error(String(err));
          console.error(`[entity-cache] Failed to reload meta sub-domain(s):`, err);
        }
      } finally {
        this.inFlightReloads.delete("meta");
      }
    })();

    this.inFlightReloads.set("meta", promise);
    await promise;
  }

  private enqueueMetaReload(subdomains: MetaSubdomain[], cycle?: ReloadCycle): void {
    for (const subdomain of subdomains) {
      if (this.activeMetaSubdomains.has(subdomain)) {
        continue;
      }
      this.pendingMetaSubdomains.add(subdomain);
    }

    if (!cycle) {
      this.pendingMetaReloadCycle = undefined;
      return;
    }

    if (!this.pendingMetaReloadCycle) {
      this.pendingMetaReloadCycle = cycle;
      return;
    }

    if (this.pendingMetaReloadCycle !== cycle) {
      this.pendingMetaReloadCycle = undefined;
    }
  }

  private drainPendingMetaReload(): { subdomains: MetaSubdomain[]; cycle?: ReloadCycle } | null {
    if (this.pendingMetaSubdomains.size === 0) {
      this.pendingMetaReloadCycle = undefined;
      return null;
    }

    const subdomains = META_SUBDOMAIN_LOAD_ORDER.filter((subdomain) =>
      this.pendingMetaSubdomains.has(subdomain),
    );
    const cycle = this.pendingMetaReloadCycle;
    this.pendingMetaSubdomains.clear();
    this.pendingMetaReloadCycle = undefined;
    return { subdomains, cycle };
  }
  private async doLoadMetaSubdomains(
    subdomains: MetaSubdomain[],
    cycle?: ReloadCycle,
  ): Promise<void> {
    await awaitTestDelay(this.projectPath);
    if (this.disposed) return;

    this.activeMetaSubdomains = new Set(subdomains);

    try {
      for (const subdomain of subdomains) {
        try {
          switch (subdomain) {
            case "manifest":
              await this.loadMetaManifestSubdomain(cycle);
              break;
            case "shadow":
              await this.loadMetaShadowSubdomain(cycle);
              break;
            case "session":
              await this.loadMetaSessionSubdomain();
              break;
          }
        } finally {
          this.activeMetaSubdomains.delete(subdomain);
        }

        if (this.disposed) return;
      }
    } finally {
      this.activeMetaSubdomains.clear();
    }
  }

  private async loadMetaManifestSubdomain(cycle?: ReloadCycle): Promise<void> {
    const ctx = cycle
      ? await this.getReloadCycleContext(cycle)
      : await initContext(this.projectPath);
    if (this.disposed) return;

    const metaCtx = await loadMetaContext(ctx);
    if (this.disposed) return;

    const metaSourceFiles = metaCtx.manifestPath ? [metaCtx.manifestPath] : [];
    if (metaCtx.manifest?.includes && metaCtx.manifestPath) {
      const manifestDir = dirname(metaCtx.manifestPath);
      for (const include of metaCtx.manifest.includes) {
        const expandedPaths = await expandIncludePattern(include, manifestDir);
        metaSourceFiles.push(...expandedPaths);
      }
    }

    const newMetaIndex: MetaSummary = {
      projectName: ctx.manifest?.project?.name,
      version: ctx.manifest?.project?.version,
      status: ctx.manifest?.project?.status,
      modules: ctx.manifest?.modules?.map((m: { title?: string; name?: string } | string) =>
        typeof m === "string" ? m : (m.title ?? m.name ?? "unknown"),
      ),
    };

    const newProjectConfig: CachedProjectConfig = {
      project: ctx.manifest?.project
        ? {
            name: ctx.manifest.project.name,
            version: ctx.manifest.project.version,
            status: ctx.manifest.project.status,
          }
        : null,
      spec_version: ctx.manifest?.kynetic ?? null,
      root_dir: ctx.projectRoot,
      remote_tracking: ctx.config.shadow.remote
        ? { value: ctx.config.shadow.remote.value, type: ctx.config.shadow.remote.type }
        : null,
      daemon: {
        port: ctx.config.daemon.port,
        host: ctx.config.daemon.host,
        auto_start: ctx.config.daemon.auto_start,
      },
      manifest_path: ctx.manifestPath,
      manifest: ctx.manifest,
      config: ctx.config,
    };

    const newMetaDetails = new Map<string, MetaContext>();
    newMetaDetails.set("_context", metaCtx);
    this.meta.index = newMetaIndex;
    this.meta.details = newMetaDetails;
    this.cachedProjectConfig = newProjectConfig;
    this.cachedMetaRuntime = {
      rootDir: ctx.rootDir,
      specDir: ctx.specDir,
      projectRoot: ctx.projectRoot,
      metaSourceFiles,
      project: newProjectConfig.project,
      specVersion: newProjectConfig.spec_version,
      daemon: newProjectConfig.daemon,
      remoteTracking: newProjectConfig.remote_tracking,
      shadow: {
        enabled: ctx.shadow?.enabled ?? false,
        branchName: ctx.shadow?.branchName ?? null,
        worktreeDir: ctx.shadow?.worktreeDir ?? null,
        directory: ctx.config.shadow.directory,
      },
    };
    this.metaLoadState.manifest = true;
  }

  private async loadMetaShadowSubdomain(cycle?: ReloadCycle): Promise<void> {
    const runtime = await this.ensureMetaRuntime(cycle);
    if (this.disposed) return;

    let newShadowInfo: CachedShadowInfo;
    if (runtime.shadow.enabled && runtime.shadow.branchName && runtime.shadow.worktreeDir) {
      const status = await getShadowStatus(runtime.rootDir, {
        branchName: runtime.shadow.branchName,
        directory: runtime.shadow.directory,
      });
      if (this.disposed) return;
      const hasRemote = await hasRemoteTracking(runtime.shadow.worktreeDir, {
        branchName: runtime.shadow.branchName,
      });
      if (this.disposed) return;
      newShadowInfo = {
        enabled: true,
        branch_name: runtime.shadow.branchName,
        worktree_dir: runtime.shadow.worktreeDir,
        healthy: status.healthy,
        remote_tracking: hasRemote,
      };
    } else {
      newShadowInfo = {
        enabled: false,
        branch_name: null,
        worktree_dir: null,
        healthy: false,
        remote_tracking: false,
      };
    }

    this.cachedShadowInfo = newShadowInfo;
    this.metaLoadState.shadow = true;
  }

  private async loadMetaSessionSubdomain(): Promise<void> {
    const specDir = this.cachedMetaRuntime?.specDir ?? join(this.projectPath, ".kspec");
    const sessionCtx = await loadSessionContext({ specDir } as KspecContext);
    if (this.disposed) return;

    this.cachedSessionContext = {
      focus: sessionCtx.focus,
      threads: sessionCtx.threads || [],
      questions: sessionCtx.open_questions || [],
      updated_at: sessionCtx.updated_at,
    };
    this.metaLoadState.session = true;
  }

  private async ensureMetaRuntime(cycle?: ReloadCycle): Promise<CachedMetaRuntime> {
    if (!this.cachedMetaRuntime) {
      await this.loadMetaManifestSubdomain(cycle);
    }

    return this.cachedMetaRuntime as CachedMetaRuntime;
  }

  private hasLoadedAllMetaSubdomains(): boolean {
    return this.metaLoadState.manifest && this.metaLoadState.shadow && this.metaLoadState.session;
  }
}

// ─── Cache Registry ──────────────────────────────────────────────────────────

/**
 * Per-project cache registry.
 * AC: @daemon-entity-cache ac-project-isolation
 */
const cacheRegistry = new Map<string, ProjectEntityCache>();

/**
 * Get the entity cache for a project. Returns null if not registered.
 */
export function getEntityCache(projectPath: string): ProjectEntityCache | null {
  return cacheRegistry.get(projectPath) ?? null;
}

/**
 * Register an entity cache for a project.
 * AC: @daemon-entity-cache ac-load-on-register
 */
export function registerEntityCache(
  projectPath: string,
  sessionConfig?: Partial<SessionCacheConfig>,
  onDomainReady?: DomainReadyCallback,
  onDomainReloaded?: DomainReloadedCallback,
): ProjectEntityCache {
  // Reuse existing cache if already registered
  const existing = cacheRegistry.get(projectPath);
  if (existing && !existing.isDisposed()) {
    return existing;
  }

  const cache = new ProjectEntityCache(projectPath, sessionConfig, onDomainReady, onDomainReloaded);
  cacheRegistry.set(projectPath, cache);
  return cache;
}

/**
 * Unregister and dispose the entity cache for a project.
 * AC: @daemon-entity-cache ac-unregister-cleanup
 */
export function unregisterEntityCache(projectPath: string): void {
  const cache = cacheRegistry.get(projectPath);
  if (cache) {
    cache.dispose();
    cacheRegistry.delete(projectPath);
  }
}

/**
 * Enumerate all registered project caches.
 * AC: @daemon-server ac-18
 */
export function getAllRegisteredCaches(): ProjectEntityCache[] {
  return Array.from(cacheRegistry.values());
}

/**
 * Clear all registered caches (for testing).
 */
export function clearAllEntityCaches(): void {
  for (const cache of cacheRegistry.values()) {
    cache.dispose();
  }
  cacheRegistry.clear();
}

// ─── Test-Only Cache Delay (KSPEC_TEST) ─────────────────────────────────────

/**
 * Per-project delay gates for E2E testing.
 * When a delay is set for a project, loadDomain() awaits the gate promise
 * before loading each domain. This lets E2E tests hold cache warming in the
 * "loading" state for a controlled duration.
 *
 * Only available when KSPEC_TEST is set in the environment.
 */
const testDelayGates = new Map<string, { promise: Promise<void>; resolve: () => void }>();

/**
 * Set a delay gate for a project's cache loading.
 * All future loadDomain() calls for this project will block until the gate
 * is released via releaseTestDelay().
 *
 * No-op if KSPEC_TEST is not set.
 */
export function setTestDelay(projectPath: string): void {
  if (!process.env.KSPEC_TEST) return;
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  testDelayGates.set(projectPath, { promise, resolve: resolve! });
}

/**
 * Release a previously set delay gate, allowing cache loading to proceed.
 * No-op if no delay is set for the project.
 */
export function releaseTestDelay(projectPath: string): void {
  const gate = testDelayGates.get(projectPath);
  if (gate) {
    gate.resolve();
    testDelayGates.delete(projectPath);
  }
}

/**
 * Check if a test delay is active for a project.
 */
export function hasTestDelay(projectPath: string): boolean {
  return testDelayGates.has(projectPath);
}

/**
 * Wait for the test delay gate if one is set for this project.
 * Returns immediately if no gate is active.
 */
export async function awaitTestDelay(projectPath: string): Promise<void> {
  const gate = testDelayGates.get(projectPath);
  if (gate) {
    await gate.promise;
  }
}
