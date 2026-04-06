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

import { relative } from "path";
import {
  getTaskFilePath,
  initContext,
  loadAllItems,
  loadMetaContext,
  loadSessionContext,
  loadPlans,
  rawToSummary,
  resolveTaskDataManager,
  type KspecContext,
  type LoadedSpecItem,
  type LoadedTask,
  type TaskSummary,
} from "../parser/index.js";
import type { MetaContext } from "../parser/meta.js";
import { loadInboxItems, type LoadedInboxItem } from "../parser/yaml.js";
import { loadTriageRecords, type LoadedTriageRecord } from "../parser/yaml.js";
import { loadReviewRecords, type LoadedReviewRecord } from "../parser/reviews.js";
import { type LoadedPlan } from "../parser/plans.js";
import { computeDisposition } from "../parser/review-operations.js";
import { getUnresolvedBlockers } from "../parser/review-threads.js";
import { getShadowStatus, hasRemoteTracking } from "../parser/shadow.js";
import {
  type SessionLogSummary,
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
}

/** Project a LoadedPlan to its index-tier summary (strip content and notes). */
function toPlanIndexSummary(plan: LoadedPlan): PlanIndexSummary {
  return {
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
}

/** Cached session context, computed at cache load time to avoid per-request disk reads. */
export interface CachedSessionContext {
  focus: string | null;
  threads: string[];
  questions: string[];
  updated_at: string;
}

/** Per-domain diagnostic snapshot returned by getCacheDiagnostics(). */
export interface DomainDiagnostic {
  state: DomainState;
  indexCount: number;
  detailCount: number;
  lastError: string | null;
  lastInvalidatedAt: string | null;
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

interface PendingDomainChange {
  filePath: string;
  content?: string;
}

const TASK_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const DEFAULT_SESSION_CACHE_CONFIG: SessionCacheConfig = {
  maxIndexSize: 100,
};

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

// ─── File → Domain Mapping ───────────────────────────────────────────────────

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

  // Inbox
  if (relativePath === "project.inbox.yaml") {
    domains.push("inbox");
  }

  // Plans
  if (relativePath === "project.plans.yaml") {
    domains.push("plans");
  }

  // Reviews
  if (relativePath === "project.reviews.yaml") {
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
  private tasks: DomainStore<TaskSummary[], LoadedTask> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
  private items: DomainStore<ItemSummary[], LoadedSpecItem> = {
    state: "unloaded",
    index: null,
    details: new Map(),
  };
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
  getTaskDetail(ulid: string): LoadedTask | null {
    return this.tasks.details.get(ulid) ?? null;
  }

  /**
   * Store a task detail in the cache (loaded on demand).
   * AC: @daemon-entity-cache ac-detail-on-demand
   */
  setTaskDetail(ulid: string, task: LoadedTask): void {
    this.tasks.details.set(ulid, task);
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
  getAllTaskDetails(): LoadedTask[] | null {
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
      domains[domain] = {
        state: store.state,
        indexCount,
        detailCount: store.details.size,
        lastError: store.lastError?.message ?? null,
        lastInvalidatedAt: store.lastInvalidatedAt ?? null,
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

    // AC: @daemon-entity-cache ac-reload-dedup — reuse in-flight promise
    const existing = this.inFlightReloads.get(domain);
    if (existing) {
      await existing;
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

    const promise = this.doLoadDomain(domain, cycle)
      .then(() => {
        if (!this.disposed) {
          store.state = "ready";
          store.lastError = undefined;

          // AC: @daemon-entity-cache ac-domain-ready-event — only fire when
          // transitioning FROM a non-ready state. Reloads of already-ready
          // domains (ac-stale-during-reload) do not trigger the event.
          if (previousState !== "ready" && this.onDomainReady) {
            this.onDomainReady(domain, this.projectPath, previousState);
          }
        }
      })
      .catch((err) => {
        if (!this.disposed) {
          // AC: @daemon-entity-cache ac-graceful-degradation
          store.state = "degraded";
          store.lastError = err instanceof Error ? err : new Error(String(err));
          console.error(`[entity-cache] Failed to load domain "${domain}":`, err);
        }
      })
      .finally(() => {
        this.inFlightReloads.delete(domain);
      });

    this.inFlightReloads.set(domain, promise);
    await promise;
  }

  private async doLoadDomain(domain: CacheDomain, cycle?: ReloadCycle): Promise<void> {
    // Test-only: wait for delay gate before loading (KSPEC_TEST)
    await awaitTestDelay(this.projectPath);
    if (this.disposed) return;

    const ctx = cycle ? await this.getReloadCycleContext(cycle) : await initContext(this.projectPath);
    // AC: @daemon-entity-cache ac-unregister-cleanup — bail after each await
    // to prevent a completed load from repopulating stores that dispose() cleared.
    if (this.disposed) return;

    switch (domain) {
      case "tasks": {
        // AC: @daemon-entity-cache ac-load-on-register — load task index
        // AC: @daemon-entity-cache ac-stale-during-reload — build new data locally,
        // then swap into the store atomically so reads see either all-old or all-new.
        const tdm = resolveTaskDataManager(ctx);
        const summaries = await tdm.listTasks(ctx);
        if (this.disposed) return;
        // Eagerly populate detail tier so search (grepItem) can access full
        // entity data (description, notes, todos) that summaries strip.
        // Non-fatal: if full loading fails, the detail tier stays empty and
        // search falls through to disk on miss.
        const newTaskDetails = new Map<string, LoadedTask>();
        try {
          const fullTasks = await tdm.loadAllTasks(ctx);
          if (this.disposed) return;
          for (const task of fullTasks) {
            newTaskDetails.set(task._ulid, task);
          }
        } catch {
          // Detail tier remains empty — search will use summaries or fall back to disk
        }
        // Atomic swap: replace index and details together
        this.tasks.index = summaries;
        this.tasks.details = newTaskDetails;
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
        for (const item of loadedItems) {
          newItemDetails.set(item._ulid, item);
        }
        // Atomic swap: replace index and details together
        this.items.index = loadedItems.map(toItemSummary);
        this.items.details = newItemDetails;
        break;
      }
      case "meta": {
        // AC: @daemon-entity-cache ac-stale-during-reload — build all meta
        // artifacts into local variables, then swap into the store atomically
        // so reads see either all-old or all-new data during a reload.

        // Load full MetaContext into detail tier for meta read routes
        const metaCtx = await loadMetaContext(ctx);
        if (this.disposed) return;
        const newMetaIndex: MetaSummary = {
          projectName: ctx.manifest?.project?.name,
          version: ctx.manifest?.project?.version,
          status: ctx.manifest?.project?.status,
          modules: ctx.manifest?.modules?.map((m: { title?: string; name?: string } | string) =>
            typeof m === "string" ? m : (m.title ?? m.name ?? "unknown"),
          ),
        };

        // AC: @daemon-read-path ac-no-per-request-sync — cache shadow status
        // and project config so /api/meta/shadow and /api/meta/config routes
        // serve from memory without per-request git operations.
        let newShadowInfo: CachedShadowInfo;
        if (ctx.shadow) {
          const status = await getShadowStatus(ctx.rootDir, {
            branchName: ctx.shadow.branchName,
            directory: ctx.config.shadow.directory,
          });
          if (this.disposed) return;
          const hasRemote = await hasRemoteTracking(ctx.shadow.worktreeDir, {
            branchName: ctx.shadow.branchName,
          });
          if (this.disposed) return;
          newShadowInfo = {
            enabled: ctx.shadow.enabled,
            branch_name: ctx.shadow.branchName,
            worktree_dir: ctx.shadow.worktreeDir,
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
        };

        // AC: @daemon-read-path ac-no-per-request-sync — cache session context
        // so /api/meta/session serves from memory without per-request disk reads.
        const sessionCtx = await loadSessionContext(ctx);
        if (this.disposed) return;
        const newSessionContext: CachedSessionContext = {
          focus: sessionCtx.focus,
          threads: sessionCtx.threads || [],
          questions: sessionCtx.open_questions || [],
          updated_at: sessionCtx.updated_at,
        };

        // Atomic swap: replace all meta artifacts together so concurrent
        // readers never see a mix of old and new meta state.
        const newMetaDetails = new Map<string, MetaContext>();
        newMetaDetails.set("_context", metaCtx);
        this.meta.index = newMetaIndex;
        this.meta.details = newMetaDetails;
        this.cachedShadowInfo = newShadowInfo;
        this.cachedProjectConfig = newProjectConfig;
        this.cachedSessionContext = newSessionContext;
        break;
      }
      case "inbox": {
        const inboxItems = await loadInboxItems(ctx);
        if (this.disposed) return;
        this.inbox.index = inboxItems;
        break;
      }
      case "plans": {
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

    const cycle = this.domainReloadCycles.get(domain) ?? this.getOrCreateReloadCycle();
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
  async writeThrough(domain: CacheDomain): Promise<void> {
    // AC: @daemon-server ac-18 — track last invalidation timestamp
    this.getStore(domain).lastInvalidatedAt = new Date().toISOString();
    await this.loadDomain(domain);
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
      store.state = "unloaded";
      store.lastError = undefined;
    }

    this.inFlightReloads.clear();
    this.writeThroughSkip.clear();
    this.liveEventCounts.clear();

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

  private recordPendingDomainChange(
    domain: CacheDomain,
    filePath: string,
    content?: string,
  ): void {
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

  private async processDomainChanges(
    domain: CacheDomain,
    changes: PendingDomainChange[],
    cycle?: ReloadCycle,
  ): Promise<void> {
    if (domain === "tasks" && (await this.tryIncrementalTaskUpdate(changes, cycle))) {
      return;
    }

    await this.loadDomain(domain, cycle);
  }

  private async tryIncrementalTaskUpdate(
    changes: PendingDomainChange[],
    cycle?: ReloadCycle,
  ): Promise<boolean> {
    if (changes.length === 0 || this.tasks.state !== "ready" || !this.tasks.index) {
      return false;
    }

    const ctx = cycle ? await this.getReloadCycleContext(cycle) : await initContext(this.projectPath);
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

    const tdm = resolveTaskDataManager(ctx);
    const nextIndex = [...this.tasks.index];
    const nextDetails = new Map(this.tasks.details);

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
        continue;
      }

      const loadedTask = await tdm.getTask(ctx, ulid);
      const summary = rawToSummary(loadedTask);
      if (!loadedTask || !summary) {
        return false;
      }

      if (existingIndex >= 0) {
        nextIndex[existingIndex] = summary;
      } else {
        nextIndex.push(summary);
      }
      nextDetails.set(ulid, loadedTask);
    }

    this.tasks.index = nextIndex;
    this.tasks.details = nextDetails;
    return true;
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
