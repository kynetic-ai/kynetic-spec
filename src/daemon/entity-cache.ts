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
 */

import { relative } from "path";
import {
  initContext,
  loadAllItems,
  loadMetaContext,
  loadPlans,
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
import {
  type SessionLogSummary,
  getSessionMetadataOnly,
  resolveStaleSessionCriteria,
  getSessionActivityForStaleCheck,
} from "../sessions/store.js";
import { readdir } from "fs/promises";

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
  decided_by?: string;
  override_by?: string;
  override_at?: string;
  acted_at?: string;
  updated_at?: string;
  result_ref?: string;
  evidence_refs: string[];
}

/** Project a LoadedTriageRecord to its index-tier summary (strip item_snapshot, reasoning, override_reasoning). */
function toTriageIndexSummary(record: LoadedTriageRecord): TriageIndexSummary {
  return {
    _ulid: record._ulid,
    inbox_ref: record.inbox_ref,
    status: record.status,
    created_at: record.created_at,
    action: record.action,
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

/** Session cache configuration. */
export interface SessionCacheConfig {
  /** Maximum number of session summaries to keep in index (default 100). */
  maxIndexSize: number;
}

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
export function fileToDomain(relativePath: string): CacheDomain[] | null {
  const domains: CacheDomain[] = [];

  // Task files
  if (relativePath.endsWith(".tasks.yaml") || relativePath === "project.tasks.yaml") {
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
  // the base, the relative path is a bare ULID (session root from
  // SessionWatcher.getBroadcastPath) or ULID/filename (e.g. metadata.json,
  // events.jsonl). Match the leading ULID segment (26 Crockford base32 chars).
  const firstSegment = relativePath.split("/")[0];
  if (firstSegment && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(firstSegment)) {
    domains.push("sessions");
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

  /** Live event counters for active sessions (migrated from SessionSummaryCache). */
  private liveEventCounts = new Map<string, number>();

  /** Whether dispose() has been called. */
  private disposed = false;

  constructor(projectPath: string, sessionConfig?: Partial<SessionCacheConfig>) {
    this.projectPath = projectPath;
    this.sessionConfig = { ...DEFAULT_SESSION_CACHE_CONFIG, ...sessionConfig };
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
   * Get session summaries from index tier.
   * Applies live event counters for active sessions.
   * AC: @daemon-entity-cache ac-serve-from-memory
   * AC: @daemon-entity-cache ac-session-bounded-index
   */
  getSessionIndex(): SessionLogSummary[] | null {
    if (!this.sessions.index) return null;
    return this.sessions.index.map((s) => {
      const liveCount = this.liveEventCounts.get(s.id);
      if (s.status === "active" && liveCount !== undefined) {
        return { ...s, event_count: liveCount };
      }
      return s;
    });
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
   * Migrated from SessionSummaryCache.
   */
  incrementSessionEventCount(sessionId: string): void {
    const current = this.liveEventCounts.get(sessionId) ?? 0;
    this.liveEventCounts.set(sessionId, current + 1);
  }

  /**
   * Discard live event counter for a session (on close).
   * Migrated from SessionSummaryCache.
   */
  discardSessionLiveCounter(sessionId: string): void {
    this.liveEventCounts.delete(sessionId);
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
   */
  async loadDomain(domain: CacheDomain): Promise<void> {
    if (this.disposed) return;

    // AC: @daemon-entity-cache ac-reload-dedup — reuse in-flight promise
    const existing = this.inFlightReloads.get(domain);
    if (existing) {
      await existing;
      return;
    }

    const store = this.getStore(domain);
    store.state = "loading";

    const promise = this.doLoadDomain(domain)
      .then(() => {
        if (!this.disposed) {
          store.state = "ready";
          store.lastError = undefined;
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

  private async doLoadDomain(domain: CacheDomain): Promise<void> {
    const ctx = await initContext(this.projectPath);

    switch (domain) {
      case "tasks": {
        // AC: @daemon-entity-cache ac-load-on-register — load task index
        const summaries = await resolveTaskDataManager(ctx).listTasks(ctx);
        this.tasks.index = summaries;
        this.tasks.details.clear();
        break;
      }
      case "items": {
        // AC: @daemon-entity-cache ac-load-on-register — load item index (summaries only)
        const loadedItems = await loadAllItems(ctx);
        this.items.index = loadedItems.map(toItemSummary);
        this.items.details.clear();
        break;
      }
      case "meta": {
        this.meta.index = {
          projectName: ctx.manifest?.project?.name,
          version: ctx.manifest?.project?.version,
          status: ctx.manifest?.project?.status,
          modules: ctx.manifest?.modules?.map(
            (m: { title?: string; name?: string } | string) =>
              typeof m === "string" ? m : m.title ?? m.name ?? "unknown",
          ),
        };
        // Load full MetaContext into detail tier for meta read routes
        const metaCtx = await loadMetaContext(ctx);
        this.meta.details.set("_context", metaCtx);
        break;
      }
      case "inbox": {
        const inboxItems = await loadInboxItems(ctx);
        this.inbox.index = inboxItems;
        break;
      }
      case "plans": {
        const loadedPlans = await loadPlans(ctx);
        this.plans.index = loadedPlans.map(toPlanIndexSummary);
        // AC: @daemon-entity-cache ac-detail-on-demand — clear detail cache;
        // full plan records are loaded on demand when accessed by ID.
        this.plans.details.clear();
        break;
      }
      case "triage": {
        const triageRecords = await loadTriageRecords(ctx);
        this.triage.index = triageRecords.map(toTriageIndexSummary);
        // AC: @daemon-entity-cache ac-detail-on-demand — clear detail cache;
        // full triage records are loaded on demand when accessed by ID.
        this.triage.details.clear();
        break;
      }
      case "reviews": {
        const reviewRecords = await loadReviewRecords(ctx);
        this.reviews.index = reviewRecords.map(toReviewIndexSummary);
        // AC: @daemon-entity-cache ac-detail-on-demand — clear detail cache;
        // full review records are loaded on demand when accessed by ID.
        this.reviews.details.clear();
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

    try {
      const entries = await readdir(sessionsDir, { withFileTypes: true });
      sessionIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // No sessions directory — empty index
      this.sessions.index = [];
      return;
    }

    // Load metadata-only summaries for all sessions (avoids reading events.jsonl)
    const summaries: SessionLogSummary[] = [];
    for (const id of sessionIds) {
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

    // AC: @daemon-entity-cache ac-session-bounded-index — keep only N most recent
    this.sessions.index = summaries.slice(0, this.sessionConfig.maxIndexSize);
    this.sessions.details.clear();
  }

  // ─── Invalidation ────────────────────────────────────────────────────────

  /**
   * Invalidate a domain and reload from disk.
   * Called by file watcher when a shadow branch file changes.
   *
   * AC: @daemon-entity-cache ac-watcher-invalidation
   * AC: @daemon-entity-cache ac-granular-reload
   */
  async invalidateDomain(domain: CacheDomain): Promise<void> {
    if (this.disposed) return;

    // AC: @daemon-entity-cache ac-write-through — skip if write-through just updated this domain
    if (this.writeThroughSkip.has(domain)) {
      this.writeThroughSkip.delete(domain);
      return;
    }

    await this.loadDomain(domain);
  }

  /**
   * Handle a file change event from the watcher.
   * Maps the file path to a domain and invalidates it.
   *
   * AC: @daemon-entity-cache ac-watcher-invalidation
   * AC: @daemon-entity-cache ac-granular-reload
   */
  async handleFileChange(kspecDir: string, filePath: string): Promise<void> {
    if (this.disposed) return;

    const relativePath = relative(kspecDir, filePath);
    const domains = fileToDomain(relativePath);
    if (domains) {
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
   * AC: @daemon-entity-cache ac-write-through
   */
  async writeThrough(domain: CacheDomain): Promise<void> {
    this.markWriteThrough(domain);
    await this.loadDomain(domain);
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
): ProjectEntityCache {
  // Reuse existing cache if already registered
  const existing = cacheRegistry.get(projectPath);
  if (existing && !existing.isDisposed()) {
    return existing;
  }

  const cache = new ProjectEntityCache(projectPath, sessionConfig);
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
 * Clear all registered caches (for testing).
 */
export function clearAllEntityCaches(): void {
  for (const cache of cacheRegistry.values()) {
    cache.dispose();
  }
  cacheRegistry.clear();
}
