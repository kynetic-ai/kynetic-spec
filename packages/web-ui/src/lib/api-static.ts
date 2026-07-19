/**
 * Static API Provider
 *
 * Provides API responses from a static JSON snapshot.
 * Used when daemon is unavailable (GitHub Pages mode).
 *
 * AC Coverage:
 * - ac-11 (@gh-pages-export): Render from JSON snapshot
 * - ac-12, ac-13 (@gh-pages-export): Deep linking with ref resolution
 */

import type {
  TaskSummary,
  TaskDetail,
  ItemSummary,
  ItemDetail,
  BatchItemsResponse,
  BatchSpecItemSummary,
  BatchTaskSummary,
  InboxItem,
  PlanDetail,
  PlanResourceMetadata,
  PlanSummary,
  ReviewSummary,
  ReviewDetail,
  SessionContext,
  Observation,
  TriageRecord,
  AlignmentResponse,
  Workflow,
  SearchResponse,
  SearchResult,
  ApiResponse,
  ApiResponseMeta,
  TaskStatusSummary,
} from "@kynetic-ai/shared";
import type { ValidationResponse } from "$lib/api";
import type {
  KspecSnapshot,
  ExportedTask,
  ExportedItem,
  ExportedReview,
} from "$lib/types/snapshot";
import { getSnapshot, ReadOnlyModeError } from "$lib/stores/mode.svelte";

/**
 * Wrap data in a unified API response envelope with cache_status: "ready".
 * Static data is always "ready" since it's pre-baked at build time.
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */
function wrapEnvelope<T>(data: T, meta?: Partial<ApiResponseMeta>): ApiResponse<T> {
  return {
    data,
    meta: { cache_status: "ready", ...meta },
  };
}

/**
 * Convert ExportedTask to TaskSummary
 */
function toTaskSummary(task: ExportedTask): TaskSummary {
  return {
    _ulid: task._ulid,
    slugs: task.slugs,
    title: task.title,
    type: task.type,
    status: task.status,
    priority: task.priority,
    spec_ref: task.spec_ref ?? undefined,
    tags: task.tags,
    depends_on: task.depends_on,
    created_at: task.created_at,
    started_at: task.started_at ?? undefined,
    automation: task.automation,
    notes_count: task.notes?.length ?? 0,
    todos_count: task.todos?.length ?? 0,
  };
}

/**
 * Convert ExportedItem to ItemSummary
 */
function toItemSummary(item: ExportedItem): ItemSummary {
  return {
    _ulid: item._ulid,
    slugs: item.slugs,
    title: item.title,
    type: item.type,
    status: item.status,
    tags: item.tags,
    created_at: item.created_at ?? new Date().toISOString(),
    acceptance_criteria_count: item.acceptance_criteria?.length ?? 0,
  };
}

function toBatchSpecItemSummary(item: ExportedItem): BatchSpecItemSummary {
  const rawStatus = (item as ExportedItem & { status?: string | { maturity?: string } }).status;

  return {
    kind: "item",
    ulid: item._ulid,
    slugs: item.slugs,
    title: item.title,
    type: item.type,
    status: typeof rawStatus === "string" ? rawStatus : undefined,
    maturity: typeof rawStatus === "object" && rawStatus ? rawStatus.maturity : undefined,
    traits: item.traits ?? [],
    ac_count: item.acceptance_criteria?.length ?? 0,
  };
}

function toBatchTaskSummary(task: ExportedTask): BatchTaskSummary {
  const assignee = (task as ExportedTask & { assignee?: string }).assignee;

  return {
    kind: "task",
    ulid: task._ulid,
    slugs: task.slugs,
    title: task.title,
    status: task.status,
    priority: task.priority,
    spec_ref: task.spec_ref ?? undefined,
    assignee,
  };
}

function normalizeRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith("@") ? ref.slice(1) : ref;
}

/**
 * Convert an exported plan-resource entry into the strict `PlanResourceMetadata`
 * shape the web UI consumes. The exported_path field carried by the snapshot
 * is intentionally NOT projected onto `PlanResourceMetadata` (which must
 * remain the exact 9-field shape mirrored from the daemon API); static
 * content has its `./resources/<path>` references pre-rewritten at export
 * time, so the UI never needs a per-resource URL in static mode.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
function toStaticPlanResource(raw: unknown): PlanResourceMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const id = obj.id;
  const path = obj.path;
  if (typeof id !== "string" || typeof path !== "string") {
    return null;
  }
  return {
    id,
    label: typeof obj.label === "string" ? obj.label : null,
    path,
    content_type:
      typeof obj.content_type === "string" ? obj.content_type : "application/octet-stream",
    bytes: typeof obj.bytes === "number" ? obj.bytes : 0,
    sha256: typeof obj.sha256 === "string" ? obj.sha256 : "",
    git_commit: typeof obj.git_commit === "string" ? obj.git_commit : null,
    git_path: typeof obj.git_path === "string" ? obj.git_path : null,
    description: typeof obj.description === "string" ? obj.description : null,
  };
}

/**
 * Static-mode base URL for plan resources. Mirrors the daemon's
 * `resources_base_url` shape so the consumer's URL-construction logic
 * (`${base}/${encodeURIComponent(id)}/bytes`) does not need to branch on
 * mode. The static export pre-rewrites markdown `./resources/<path>`
 * references to absolute asset paths so consumers rarely need to build a
 * URL from this base, but exposing it keeps the `PlanDetail` shape
 * consistent across modes.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
function buildStaticResourcesBaseUrl(planUlid: string): string {
  return `assets/resources/plan/${planUlid}`;
}

/**
 * Build a resource_summary from raw exported resources when the snapshot
 * does not carry a pre-computed `resource_summary`. The summary mirrors the
 * daemon's bounded projection — counts only, never resource bytes.
 *
 * AC: @folder-backed-plan-storage-1 ac-plan-index-has-bounded-projection
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
function computeStaticResourceSummary(raw: unknown): { count: number; total_bytes: number } {
  if (!raw || typeof raw !== "object") return { count: 0, total_bytes: 0 };
  const obj = raw as Record<string, unknown>;
  const existing = obj.resource_summary;
  if (existing && typeof existing === "object") {
    const summary = existing as Record<string, unknown>;
    if (typeof summary.count === "number" && typeof summary.total_bytes === "number") {
      return { count: summary.count, total_bytes: summary.total_bytes };
    }
  }
  const rawResources = Array.isArray(obj.resources) ? obj.resources : [];
  let total = 0;
  for (const entry of rawResources) {
    if (entry && typeof entry === "object") {
      const bytes = (entry as Record<string, unknown>).bytes;
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0) {
        total += bytes;
      }
    }
  }
  return { count: rawResources.length, total_bytes: total };
}

/**
 * Project a snapshot plan record (which carries `ExportedPlanResource[]`) into
 * a web-UI `PlanDetail` whose `resources` field uses the strict
 * `PlanResourceMetadata` shape consumed by `rewritePlanResourceLinks` and
 * the rendered UI, alongside the sibling `resources_base_url` carrying the
 * safe fetch-URL prefix.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
function toStaticPlanDetail(raw: unknown): PlanDetail | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rawResources = Array.isArray(obj.resources) ? obj.resources : [];
  const resources = rawResources
    .map((entry) => toStaticPlanResource(entry))
    .filter((entry): entry is PlanResourceMetadata => entry !== null);
  const planUlid = typeof obj._ulid === "string" ? obj._ulid : "";
  return {
    ...(obj as unknown as PlanDetail),
    resources,
    resources_base_url: buildStaticResourcesBaseUrl(planUlid),
    resource_summary: computeStaticResourceSummary(raw),
  };
}

function findPlanByRef(snapshot: KspecSnapshot, ref: string): PlanDetail | null {
  const normalizedRef = normalizeRef(ref);
  if (!normalizedRef) return null;

  const match = snapshot.plans?.find(
    (plan) =>
      plan.slugs.includes(normalizedRef) ||
      plan._ulid.toUpperCase().startsWith(normalizedRef.toUpperCase()),
  );
  if (!match) return null;
  return toStaticPlanDetail(match);
}

/**
 * Filter helper for tasks
 */
function filterTasks(
  tasks: ExportedTask[],
  params?: {
    status?: string | string[];
    tag?: string;
    assignee?: string;
    automation?: string;
    plan?: string;
  },
): ExportedTask[] {
  let result = tasks;

  if (params?.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    result = result.filter((t) => statuses.includes(t.status));
  }
  if (params?.tag) {
    result = result.filter((t) => t.tags.includes(params.tag!));
  }
  if (params?.assignee) {
    result = result.filter((t) => t.assignee === params.assignee);
  }
  if (params?.automation) {
    result = result.filter((t) => t.automation === params.automation);
  }
  if (params?.plan) {
    // Bidirectional: check plan_ref (reverse) AND derived_tasks (forward)
    // AC: @api-contract ac-plan-filter-derived, ac-plan-filter-ref
    const snapshot = getSnapshot();
    const plan = snapshot ? findPlanByRef(snapshot, params.plan) : null;
    if (plan) {
      const derivedTaskRefs = new Set(plan.derived_tasks.map((ref) => normalizeRef(ref)));
      const planUlid = plan._ulid;
      const planSlugs = plan.slugs;
      result = result.filter((t) => {
        // Reverse: task's plan_ref resolves to this plan (compare against plan identity, not raw query)
        const taskPlanRef = normalizeRef(t.plan_ref);
        const matchesByPlanRef =
          taskPlanRef !== null &&
          (taskPlanRef === planUlid ||
            planUlid.startsWith(taskPlanRef.toUpperCase()) ||
            planSlugs.includes(taskPlanRef));
        // Forward: task is in plan's derived_tasks
        const matchesByDerived =
          derivedTaskRefs.has(t._ulid) || t.slugs.some((slug) => derivedTaskRefs.has(slug));
        return matchesByPlanRef || matchesByDerived;
      });
    } else {
      // AC: @api-contract ac-plan-filter-not-found
      result = [];
    }
  }

  return result;
}

/**
 * Filter helper for items
 */
function filterItems(
  items: ExportedItem[],
  params?: {
    type?: string | string[];
    tag?: string;
    plan?: string;
  },
): ExportedItem[] {
  let result = items;

  if (params?.type) {
    const types = Array.isArray(params.type) ? params.type : [params.type];
    result = result.filter((i) => types.includes(i.type));
  }
  if (params?.tag) {
    result = result.filter((i) => i.tags.includes(params.tag!));
  }
  if (params?.plan) {
    const snapshot = getSnapshot();
    const plan = snapshot ? findPlanByRef(snapshot, params.plan) : null;
    if (plan) {
      const planSpecRefs = new Set(plan.derived_specs.map((ref) => normalizeRef(ref)));
      result = result.filter(
        (i) => planSpecRefs.has(i._ulid) || i.slugs.some((slug) => planSpecRefs.has(slug)),
      );
    } else {
      result = [];
    }
  }

  return result;
}

/**
 * Paginate array and wrap in envelope
 * AC: @api-contract ac-envelope
 */
function paginateEnvelope<T>(
  items: T[],
  params?: { limit?: number; offset?: number },
): ApiResponse<T[]> {
  const limit = params?.limit ?? items.length;
  const offset = params?.offset ?? 0;
  const paged = items.slice(offset, offset + limit);

  return wrapEnvelope(paged, { total: items.length, offset, limit });
}

/**
 * Find task by reference (slug or ULID prefix)
 * AC: @gh-pages-export ac-12
 */
function findTaskByRef(tasks: ExportedTask[], ref: string): ExportedTask | null {
  const normalizedRef = ref.startsWith("@") ? ref.slice(1) : ref;

  // Try exact slug match first
  const bySlug = tasks.find((t) => t.slugs.includes(normalizedRef));
  if (bySlug) return bySlug;

  // Try ULID prefix match
  const byUlid = tasks.find((t) => t._ulid.startsWith(normalizedRef.toUpperCase()));
  if (byUlid) return byUlid;

  return null;
}

/**
 * Find item by reference (slug or ULID prefix)
 * AC: @gh-pages-export ac-13
 */
function findItemByRef(items: ExportedItem[], ref: string): ExportedItem | null {
  const normalizedRef = ref.startsWith("@") ? ref.slice(1) : ref;

  // Try exact slug match first
  const bySlug = items.find((i) => i.slugs.includes(normalizedRef));
  if (bySlug) return bySlug;

  // Try ULID prefix match
  const byUlid = items.find((i) => i._ulid.startsWith(normalizedRef.toUpperCase()));
  if (byUlid) return byUlid;

  return null;
}

// ============================================================
// Static API Functions
// ============================================================

/**
 * Fetch tasks from static snapshot
 * AC: @gh-pages-export ac-11
 * AC: @api-contract ac-envelope
 */
export function fetchTasksStatic(params?: {
  status?: string | string[];
  tag?: string;
  assignee?: string;
  automation?: string;
  plan?: string;
  limit?: number;
  offset?: number;
}): ApiResponse<TaskSummary[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as TaskSummary[], { total: 0, offset: 0, limit: 50 });
  }

  const filtered = filterTasks(snapshot.tasks, params);
  const envelope = paginateEnvelope(filtered, params);

  return wrapEnvelope(envelope.data.map(toTaskSummary), envelope.meta);
}

/**
 * Fetch single task from static snapshot
 * AC: @gh-pages-export ac-12
 * AC: @api-contract ac-envelope
 */
export function fetchTaskStatic(ref: string): ApiResponse<TaskDetail> | null {
  const snapshot = getSnapshot();
  if (!snapshot) return null;

  const task = findTaskByRef(snapshot.tasks, ref);
  if (!task) return null;

  // ExportedTask extends TaskDetail, so we can return it directly
  return wrapEnvelope<TaskDetail>(task);
}

/**
 * Derive the task status summary from the static snapshot.
 *
 * Mirrors GET /api/aggregation/tasks/summary semantics so live and static
 * modes agree: counts per status, plus dependency-aware ready vs
 * blocked_by_dependencies over pending and needs_work tasks. A task is ready
 * when it has no blocked_by entries and every depends_on ref resolves to a
 * completed task; unresolvable refs count as unmet, matching the server.
 *
 * AC: @ui-dashboard-overview ac-counts-from-summary
 * AC: @api-contract ac-envelope
 */
export function fetchTaskStatusSummaryStatic(): ApiResponse<TaskStatusSummary> {
  const snapshot = getSnapshot();
  const tasks = snapshot?.tasks ?? [];

  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] || 0) + 1;
  }

  let ready = 0;
  let blockedByDependencies = 0;
  for (const task of tasks) {
    if (task.status !== "pending" && task.status !== "needs_work") continue;
    // Older snapshots may omit blocked_by — treat missing as empty
    const blockedBy = task.blocked_by ?? [];
    const dependenciesMet = (task.depends_on ?? []).every((depRef) => {
      const depTask = findTaskByRef(tasks, depRef);
      return depTask?.status === "completed";
    });
    if (blockedBy.length > 0 || !dependenciesMet) {
      blockedByDependencies++;
    } else {
      ready++;
    }
  }

  return wrapEnvelope<TaskStatusSummary>({
    counts,
    ready,
    blocked_by_dependencies: blockedByDependencies,
    total: tasks.length,
  });
}

/**
 * Fetch items from static snapshot
 * AC: @gh-pages-export ac-11
 * AC: @api-contract ac-envelope
 */
export function fetchItemsStatic(params?: {
  type?: string | string[];
  tag?: string;
  plan?: string;
  limit?: number;
  offset?: number;
}): ApiResponse<ItemSummary[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as ItemSummary[], { total: 0, offset: 0, limit: 50 });
  }

  const filtered = filterItems(snapshot.items, params);
  const envelope = paginateEnvelope(filtered, params);

  return wrapEnvelope(envelope.data.map(toItemSummary), envelope.meta);
}

/**
 * Fetch single item from static snapshot
 * AC: @gh-pages-export ac-13
 * AC: @api-contract ac-envelope
 */
export function fetchItemStatic(ref: string): ApiResponse<ItemDetail> | null {
  const snapshot = getSnapshot();
  if (!snapshot) return null;

  const item = findItemByRef(snapshot.items, ref);
  if (!item) return null;

  return wrapEnvelope<ItemDetail>(item);
}

/**
 * Fetch tasks linked to an item from static snapshot
 * AC: @api-contract ac-envelope
 */
export function fetchItemTasksStatic(ref: string): ApiResponse<TaskSummary[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as TaskSummary[], { total: 0, offset: 0, limit: 50 });
  }

  const item = findItemByRef(snapshot.items, ref);
  if (!item) {
    return wrapEnvelope([] as TaskSummary[], { total: 0, offset: 0, limit: 50 });
  }

  // Find tasks that reference this item
  const linkedTasks = snapshot.tasks.filter((t) => {
    if (!t.spec_ref) return false;
    const specRef = t.spec_ref.startsWith("@") ? t.spec_ref.slice(1) : t.spec_ref;
    return item.slugs.includes(specRef) || item._ulid.startsWith(specRef.toUpperCase());
  });

  const summaries = linkedTasks.map(toTaskSummary);
  return wrapEnvelope(summaries, { total: summaries.length, offset: 0, limit: summaries.length });
}

export function fetchBatchItemsStatic(refs: string[]): BatchItemsResponse {
  const snapshot = getSnapshot();
  if (!snapshot || refs.length === 0) {
    return { items: [], unresolved: [] };
  }

  const items = [];
  const unresolved: string[] = [];

  for (const ref of refs) {
    const task = findTaskByRef(snapshot.tasks, ref);
    if (task) {
      items.push(toBatchTaskSummary(task));
      continue;
    }

    const item = findItemByRef(snapshot.items, ref);
    if (item) {
      items.push(toBatchSpecItemSummary(item));
      continue;
    }

    unresolved.push(ref);
  }

  return { items, unresolved };
}

/**
 * Fetch inbox from static snapshot
 * AC: @gh-pages-export ac-11
 * AC: @api-contract ac-envelope
 */
export function fetchInboxStatic(params?: {
  limit?: number;
  offset?: number;
}): ApiResponse<InboxItem[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as InboxItem[], { total: 0, offset: 0, limit: 50 });
  }

  return paginateEnvelope(snapshot.inbox, params);
}

/**
 * Fetch session context from static snapshot
 * AC: @api-contract ac-envelope
 */
export function fetchSessionContextStatic(): ApiResponse<SessionContext> | null {
  const snapshot = getSnapshot();
  if (!snapshot?.session) return null;
  return wrapEnvelope(snapshot.session);
}

/**
 * Fetch observations from static snapshot
 * AC: @api-contract ac-envelope
 */
export function fetchObservationsStatic(params?: {
  type?: "friction" | "success" | "question" | "idea";
  resolved?: boolean;
}): ApiResponse<Observation[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as Observation[], { total: 0, offset: 0, limit: 50 });
  }

  let filtered = snapshot.observations;

  if (params?.type) {
    filtered = filtered.filter((o) => o.type === params.type);
  }
  if (params?.resolved !== undefined) {
    filtered = filtered.filter((o) => o.resolved === params.resolved);
  }

  return wrapEnvelope(filtered, { total: filtered.length, offset: 0, limit: filtered.length });
}

/**
 * Search across static snapshot
 * AC: @gh-pages-export ac-11
 * AC: @api-contract ac-envelope
 */
export function searchStatic(query: string): ApiResponse<SearchResponse> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope({ results: [], total: 0, showing: 0 });
  }

  const lowerQuery = query.toLowerCase();
  const results: SearchResult[] = [];

  // Search tasks
  for (const task of snapshot.tasks) {
    if (
      task.title.toLowerCase().includes(lowerQuery) ||
      task.slugs.some((s) => s.includes(lowerQuery))
    ) {
      results.push({
        type: "task",
        ulid: task._ulid,
        title: task.title,
        matchedFields: ["title"],
      });
    }
  }

  // Search items
  for (const item of snapshot.items) {
    if (
      item.title.toLowerCase().includes(lowerQuery) ||
      item.slugs.some((s) => s.includes(lowerQuery))
    ) {
      results.push({
        type: "item",
        ulid: item._ulid,
        title: item.title,
        matchedFields: ["title"],
      });
    }
  }

  // Search inbox
  for (const inbox of snapshot.inbox) {
    if (inbox.text.toLowerCase().includes(lowerQuery)) {
      results.push({
        type: "inbox",
        ulid: inbox._ulid,
        title: inbox.text.slice(0, 50),
        matchedFields: ["text"],
      });
    }
  }

  return wrapEnvelope({
    results: results.slice(0, 20),
    total: results.length,
    showing: Math.min(results.length, 20),
  });
}

/**
 * Fetch triage records from static snapshot
 * AC: @interactive-triage-ui ac-8
 * AC: @api-contract ac-envelope
 */
export function fetchTriageRecordsStatic(params?: {
  status?: string;
  action?: string;
  limit?: number;
  offset?: number;
}): ApiResponse<TriageRecord[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as TriageRecord[], {
      total: 0,
      offset: params?.offset ?? 0,
      limit: params?.limit ?? 50,
    });
  }

  let items = snapshot.triage ?? [];

  if (params?.status) {
    items = items.filter((item) => item.status === params.status);
  }
  if (params?.action) {
    items = items.filter((item) => item.action === params.action);
  }

  return paginateEnvelope(items, params);
}

// ============================================================
// Workflows Static Functions
// ============================================================

/**
 * Fetch workflows from static snapshot
 * AC: @ui-workflows-view ac-1
 * AC: @api-contract ac-envelope
 */
export function fetchWorkflowsStatic(): ApiResponse<Workflow[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as Workflow[], { total: 0 });
  }

  const workflows = snapshot.workflows ?? [];
  return wrapEnvelope(workflows, { total: workflows.length });
}

// ============================================================
// Plans Static Functions
// ============================================================

/**
 * Fetch plans from static snapshot
 * AC: @api-contract ac-envelope
 */
export function fetchPlansStatic(_params?: { status?: string }): ApiResponse<PlanSummary[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as PlanSummary[], { total: 0 });
  }

  let items = snapshot.plans ?? [];
  if (_params?.status) {
    items = items.filter((plan) => plan.status === _params.status);
  }

  const summaries = items.map((plan) => {
    const { content: _content, ...rest } = plan;
    const projected = toStaticPlanDetail(rest);
    // toStaticPlanDetail returns null only for malformed snapshot entries;
    // fall back to the raw projection so existing fixtures without
    // resources keep rendering.
    if (!projected) return rest as PlanSummary;
    // List responses surface only the bounded resource summary, never the
    // full resource metadata array — that lives on detail responses.
    const {
      content: _c,
      resources: _resources,
      resources_base_url: _baseUrl,
      ...summary
    } = projected;
    return summary as PlanSummary;
  });
  return wrapEnvelope(summaries, { total: summaries.length });
}

/**
 * AC: @api-contract ac-envelope
 */
export function fetchPlanContentStatic(ref: string): ApiResponse<PlanDetail> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    throw new Error("Plan content not available in static mode");
  }

  const plan = findPlanByRef(snapshot, ref);
  if (!plan) {
    throw new Error(`Plan not found: ${ref}`);
  }

  return wrapEnvelope(plan);
}

/**
 * AC: @api-contract ac-envelope
 */
export function fetchValidationStatic(): ApiResponse<ValidationResponse> {
  const snapshot = getSnapshot();
  if (!snapshot?.validation) {
    return wrapEnvelope({
      valid: true,
      schemaErrors: [],
      refErrors: [],
      refWarnings: [],
      orphans: [],
      completenessWarnings: [],
      traitCycles: [],
    });
  }

  return wrapEnvelope({
    valid: snapshot.validation.valid,
    schemaErrors: snapshot.validation.schemaErrors ?? [],
    refErrors: snapshot.validation.refErrors ?? [],
    refWarnings: snapshot.validation.refWarnings ?? [],
    orphans: snapshot.validation.orphans ?? [],
    completenessWarnings: snapshot.validation.completenessWarnings ?? [],
    traitCycles: snapshot.validation.traitCycles ?? [],
  });
}

/**
 * AC: @api-contract ac-envelope
 */
export function fetchAlignmentStatic(): ApiResponse<AlignmentResponse> {
  const alignment = getSnapshot()?.alignment ?? {
    stats: { totalSpecs: 0, specsWithTasks: 0, alignedSpecs: 0, orphanedSpecs: 0 },
    warnings: [],
  };
  return wrapEnvelope(alignment);
}

// ============================================================
// Reviews Static Functions
// ============================================================

function findReviewByRef(snapshot: KspecSnapshot, ref: string): ExportedReview | null {
  const normalizedRef = normalizeRef(ref);
  if (!normalizedRef) return null;
  const reviews = snapshot.reviews ?? [];
  const bySlug = reviews.find((r) => r.slugs?.includes(normalizedRef));
  if (bySlug) return bySlug;
  const byUlid = reviews.find((r) => r._ulid.toUpperCase().startsWith(normalizedRef.toUpperCase()));
  return byUlid ?? null;
}

function toReviewSummary(review: ExportedReview): ReviewSummary {
  const subjectRef =
    review.subject.type === "task" ||
    review.subject.type === "spec" ||
    review.subject.type === "plan"
      ? review.subject.ref
      : undefined;
  const headBranch = review.subject.type === "code" ? review.subject.head_branch : undefined;

  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition: review.disposition,
    subject_type: review.subject.type,
    subject_ref: subjectRef,
    head_branch: headBranch,
    author: review.author,
    related_refs: review.related_refs,
    thread_count: 0,
    unresolved_blocker_count: 0,
    check_count: 0,
    verdict_count: 0,
    created_at: review.created_at,
    updated_at: review.updated_at ?? undefined,
  };
}

/**
 * Build a ReviewDetail from a bounded snapshot entry. The snapshot
 * projection is intentionally bounded — threads, checks, verdicts, events,
 * and notes are not exported. The static view exposes the same envelope
 * shape with those arrays empty so the review detail page renders cleanly
 * (resource gallery, subject info, disposition) without requiring a live
 * daemon.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 */
function toReviewDetail(review: ExportedReview): ReviewDetail {
  return {
    _ulid: review._ulid,
    slugs: review.slugs,
    title: review.title,
    lifecycle_state: review.lifecycle_state,
    disposition: review.disposition,
    subject: review.subject,
    author: review.author,
    related_refs: review.related_refs,
    threads: [],
    checks: [],
    verdicts: [],
    events: [],
    notes: [],
    external_links: review.external_links,
    examined_commit: review.examined_commit,
    created_at: review.created_at,
    updated_at: review.updated_at,
    resources: review.resources.map((resource) => ({ ...resource })),
  };
}

/**
 * Fetch reviews from the static snapshot. Returns the bounded-projection
 * summaries needed by the reviews list page. Counts that the snapshot does
 * not carry (thread/check/verdict totals) surface as 0 — static export
 * trades fidelity for a bounded, daemon-independent payload.
 *
 * AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
 * AC: @api-contract ac-envelope
 */
export function fetchReviewsStatic(params?: {
  status?: string | string[];
  disposition?: string;
  subject_type?: string;
  subject_ref?: string;
  head_branch?: string;
  limit?: number;
  offset?: number;
}): ApiResponse<ReviewSummary[]> {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return wrapEnvelope([] as ReviewSummary[], { total: 0, offset: 0, limit: 50 });
  }
  let items = snapshot.reviews ?? [];
  if (params?.status) {
    const statuses = Array.isArray(params.status) ? params.status : [params.status];
    items = items.filter((r) => statuses.includes(r.lifecycle_state));
  }
  if (params?.disposition) {
    items = items.filter((r) => r.disposition === params.disposition);
  }
  if (params?.subject_type) {
    items = items.filter((r) => r.subject.type === params.subject_type);
  }
  if (params?.subject_ref) {
    const target = normalizeRef(params.subject_ref);
    items = items.filter((r) => {
      if (!("ref" in r.subject)) return false;
      return normalizeRef(r.subject.ref) === target;
    });
  }
  if (params?.head_branch) {
    items = items.filter(
      (r) => r.subject.type === "code" && r.subject.head_branch === params.head_branch,
    );
  }
  const summaries = items.map(toReviewSummary);
  const envelope = paginateEnvelope(summaries, params);
  return envelope;
}

/**
 * Fetch a single review by ULID or slug from the static snapshot.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @api-contract ac-envelope
 */
export function fetchReviewStatic(ref: string): ApiResponse<ReviewDetail> | null {
  const snapshot = getSnapshot();
  if (!snapshot) return null;
  const review = findReviewByRef(snapshot, ref);
  if (!review) return null;
  return wrapEnvelope(toReviewDetail(review));
}

// ============================================================
// Write Operations (throw ReadOnlyModeError)
// ============================================================

/**
 * Start task - not available in static mode
 * AC: @gh-pages-export ac-16, ac-18
 */
export function startTaskStatic(_ref: string): never {
  throw new ReadOnlyModeError("start task");
}

/**
 * Add task note - not available in static mode
 * AC: @gh-pages-export ac-18
 */
export function addTaskNoteStatic(_ref: string, _content: string): never {
  throw new ReadOnlyModeError("add note");
}

/**
 * Add inbox item - not available in static mode
 * AC: @gh-pages-export ac-17, ac-18
 */
export function addInboxItemStatic(_text: string, _tags?: string[]): never {
  throw new ReadOnlyModeError("add inbox item");
}

/**
 * Delete inbox item - not available in static mode
 * AC: @gh-pages-export ac-18
 */
export function deleteInboxItemStatic(_ref: string): never {
  throw new ReadOnlyModeError("delete inbox item");
}
