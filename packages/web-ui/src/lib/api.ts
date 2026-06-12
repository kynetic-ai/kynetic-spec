/**
 * API Client
 *
 * Helper functions for making requests to the kspec daemon API.
 * Supports both daemon mode (live) and static mode (read-only JSON).
 *
 * AC Coverage:
 * - ac-26 (@multi-directory-daemon): X-Kspec-Dir header injection
 * - ac-36 (@multi-directory-daemon): Invalid project error detection
 * - ac-11 (@gh-pages-export): Mode-aware API dispatch
 * - ac-18 (@gh-pages-export): Graceful no-op for write operations
 */

import type {
  TaskSummary,
  TaskDetail,
  ItemSummary,
  ItemDetail,
  BatchItemsResponse,
  InboxItem,
  InboxItemWithTriage,
  SessionContext,
  Observation,
  Workflow,
  Convention,
  CacheStatus,
  PaginatedResponse,
  PlanSummary,
  PlanDetail,
  ReviewSummary,
  ReviewDetail,
  ReviewResource,
  ReviewThread,
  ReviewContentResourceContext,
  ErrorResponse,
  SearchResponse,
  AgentDefinition,
  AgentUpdatePayload,
  ValidationAggregation,
  TaskStatusSummary,
} from "@kynetic-ai/shared";
import type { TriageRecord } from "./types/triage";
import {
  getSelectedProjectPath,
  clearInvalidSelection,
  isInvalidProjectError,
  type Project,
} from "./stores/project.svelte";
import { isStaticMode, assertWritable } from "./stores/mode.svelte";
import {
  fetchTasksStatic,
  fetchTaskStatic,
  fetchTaskStatusSummaryStatic,
  fetchItemsStatic,
  fetchItemStatic,
  fetchItemTasksStatic,
  fetchBatchItemsStatic,
  fetchInboxStatic,
  fetchSessionContextStatic,
  fetchObservationsStatic,
  searchStatic,
  fetchTriageRecordsStatic,
  fetchPlansStatic,
  fetchPlanContentStatic,
  fetchReviewsStatic,
  fetchReviewStatic,
  fetchValidationStatic,
  fetchAlignmentStatic,
  fetchWorkflowsStatic,
} from "./api-static";
import { DAEMON_API_BASE } from "./constants";

const API_BASE = DAEMON_API_BASE;

/**
 * Error thrown when the daemon returns a response with cache_status "loading".
 * This prevents TanStack Query from caching empty/default data as if it were a
 * real result. The query layer treats this as a retryable error, keeping the
 * previous cached data visible while the cache warms.
 * AC: @api-contract ac-cache-status-field
 */
export class CacheWarmingError extends Error {
  readonly cacheStatus: CacheStatus;

  constructor() {
    super("Cache is still warming — data not yet available");
    this.name = "CacheWarmingError";
    this.cacheStatus = "loading";
  }
}

/**
 * Type guard for CacheWarmingError. Useful in view components to distinguish
 * cache warming from other query errors (e.g., to show skeletons vs error states).
 * AC: @ui-data-freshness ac-warming-skeleton
 */
export function isCacheWarmingError(error: unknown): error is CacheWarmingError {
  return error instanceof CacheWarmingError;
}

/**
 * Check envelope meta for cache_status and throw CacheWarmingError if "loading".
 * Must be called before extracting data so callers never see default/empty payloads
 * from a warming cache.
 * AC: @api-contract ac-cache-status-field
 */
function checkCacheStatus(meta: { cache_status?: CacheStatus }): void {
  if (meta.cache_status === "loading") {
    throw new CacheWarmingError();
  }
}

/**
 * Unwrap a unified API response envelope, returning just the data payload.
 * Throws CacheWarmingError if cache_status is "loading".
 * Used for detail/aggregation endpoints that return { data: T, meta: {...} }.
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */
function unwrapEnvelope<T>(envelope: { data: T; meta: { cache_status?: CacheStatus } }): T {
  checkCacheStatus(envelope.meta);
  return envelope.data;
}

/**
 * Unwrap a unified API response envelope into the legacy PaginatedResponse shape.
 * Throws CacheWarmingError if cache_status is "loading".
 * Maps { data: T[], meta: { total, offset, limit, cache_status } } → { items: T[], total, offset, limit }.
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */
function unwrapPaginatedEnvelope<T>(envelope: {
  data: T[];
  meta: { total?: number; offset?: number; limit?: number; cache_status?: CacheStatus };
}): PaginatedResponse<T> {
  checkCacheStatus(envelope.meta);
  return {
    items: envelope.data,
    total: envelope.meta.total ?? envelope.data.length,
    offset: envelope.meta.offset ?? 0,
    limit: envelope.meta.limit ?? envelope.data.length,
  };
}

/**
 * Unwrap a unified API response envelope for list endpoints that return { items, total }.
 * Throws CacheWarmingError if cache_status is "loading".
 * Maps { data: T[], meta: { total } } → { items: T[], total }.
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */
function unwrapListEnvelope<T>(envelope: {
  data: T[];
  meta: { total?: number; cache_status?: CacheStatus };
}): { items: T[]; total: number } {
  checkCacheStatus(envelope.meta);
  return {
    items: envelope.data,
    total: envelope.meta.total ?? envelope.data.length,
  };
}

/**
 * Unwrap a unified API response envelope for the session list pattern.
 * Throws CacheWarmingError if cache_status is "loading".
 * Maps { data: { items, unfiltered_total }, meta: { total, offset, limit } } → SessionListResponse.
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */
function unwrapSessionListEnvelope(envelope: {
  data: { items: SessionSummary[]; unfiltered_total?: number };
  meta: { total?: number; offset?: number; limit?: number; cache_status?: CacheStatus };
}): SessionListResponse {
  checkCacheStatus(envelope.meta);
  return {
    items: envelope.data.items,
    total: envelope.meta.total ?? envelope.data.items.length,
    unfiltered_total: envelope.data.unfiltered_total ?? 0,
    offset: envelope.meta.offset ?? 0,
    limit: envelope.meta.limit ?? envelope.data.items.length,
  };
}

/**
 * Unwrap a unified API response envelope for simple session list pattern (no unfiltered_total).
 * Throws CacheWarmingError if cache_status is "loading".
 * Maps { data: T[], meta: { total, offset, limit } } → SessionListResponse.
 * AC: @api-contract ac-envelope
 * AC: @api-contract ac-cache-status-field
 */
function unwrapSimpleSessionListEnvelope(envelope: {
  data: SessionSummary[];
  meta: { total?: number; offset?: number; limit?: number; cache_status?: CacheStatus };
}): SessionListResponse {
  checkCacheStatus(envelope.meta);
  return {
    items: envelope.data,
    total: envelope.meta.total ?? envelope.data.length,
    unfiltered_total: envelope.data.length,
    offset: envelope.meta.offset ?? 0,
    limit: envelope.meta.limit ?? envelope.data.length,
  };
}

/**
 * Get headers for API requests, including X-Kspec-Dir if project is selected
 * AC: @multi-directory-daemon ac-26
 */
function getProjectHeaders(): HeadersInit {
  const path = getSelectedProjectPath();
  return path ? { "X-Kspec-Dir": path } : {};
}

/**
 * Handle response errors, detecting invalid project errors
 * AC: @multi-directory-daemon ac-36
 */
async function handleResponseError(response: Response): Promise<never> {
  const error: ErrorResponse = await response.json();
  const message = error.message || error.error;

  // Check if this is an invalid project error
  if (isInvalidProjectError(response, message)) {
    clearInvalidSelection();
  }

  throw new Error(message);
}

/**
 * Fetch registered projects
 * AC: @multi-directory-daemon ac-25, ac-28
 */
export async function fetchProjects(): Promise<{ projects: Project[] }> {
  const response = await fetch(`${API_BASE}/api/projects`);
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Fetch tasks with optional filters
 * AC: @web-dashboard ac-9, ac-10
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchTasks(params?: {
  status?: string | string[];
  tag?: string;
  assignee?: string;
  automation?: string;
  plan?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<TaskSummary>> {
  // AC: @gh-pages-export ac-11 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapPaginatedEnvelope(fetchTasksStatic(params));
  }

  const url = new URL(`${API_BASE}/api/tasks`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

/**
 * Fetch pre-computed task status summary counts.
 * Live mode hits the server-side aggregation endpoint instead of retrieving
 * the full task list; static mode derives the same shape from the snapshot.
 * AC: @ui-dashboard-overview ac-counts-from-summary
 * AC: @ui-api-aggregation ac-1
 */
export async function fetchTaskStatusSummary(): Promise<TaskStatusSummary> {
  if (isStaticMode()) {
    return unwrapEnvelope(fetchTaskStatusSummaryStatic());
  }

  const response = await fetch(`${API_BASE}/api/aggregation/tasks/summary`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return unwrapEnvelope(await response.json());
}

/**
 * Fetch single task by reference
 * AC: @web-dashboard ac-5
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-12 - Static mode deep linking
 */
export async function fetchTask(ref: string): Promise<TaskDetail> {
  // AC: @gh-pages-export ac-12 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    const envelope = fetchTaskStatic(ref);
    if (!envelope) {
      throw new Error(`Task not found: ${ref}`);
    }
    return unwrapEnvelope(envelope);
  }

  const response = await fetch(`${API_BASE}/api/tasks/${ref}`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

/**
 * Start a task (change status to in_progress)
 * AC: @web-dashboard ac-7
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-16, ac-18 - Disabled in static mode
 */
export async function startTask(ref: string): Promise<void> {
  // AC: @gh-pages-export ac-16, ac-18 - Write operations throw in static mode
  assertWritable("start task");

  const response = await fetch(`${API_BASE}/api/tasks/${ref}/start`, {
    method: "POST",
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
}

/**
 * Add a note to a task
 * AC: @web-dashboard ac-8
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-18 - Disabled in static mode
 */
export async function addTaskNote(ref: string, content: string): Promise<void> {
  // AC: @gh-pages-export ac-18 - Write operations throw in static mode
  assertWritable("add note");

  const response = await fetch(`${API_BASE}/api/tasks/${ref}/note`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
}

/**
 * Submit a task for review (transition to pending_review)
 * AC: @ui-task-board ac-6
 */
export async function submitTask(ref: string): Promise<void> {
  assertWritable("submit task");

  const response = await fetch(`${API_BASE}/api/tasks/${ref}/submit`, {
    method: "POST",
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
}

/**
 * Complete a task
 * AC: @ui-task-board ac-6
 */
export async function completeTask(ref: string, reason: string): Promise<void> {
  assertWritable("complete task");

  const response = await fetch(`${API_BASE}/api/tasks/${ref}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
}

/**
 * Block a task
 * AC: @ui-task-board ac-6
 */
export async function blockTask(ref: string, reason: string): Promise<void> {
  assertWritable("block task");

  const response = await fetch(`${API_BASE}/api/tasks/${ref}/block`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
}

/**
 * Fetch agent/dispatch status
 * AC: @ui-task-board ac-4
 */

/**
 * Fetch spec items with optional filters
 * AC: @web-dashboard ac-11
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchItems(params?: {
  type?: string | string[];
  tag?: string;
  plan?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<ItemSummary>> {
  // AC: @gh-pages-export ac-11 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapPaginatedEnvelope(fetchItemsStatic(params));
  }

  const url = new URL(`${API_BASE}/api/items`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, String(v)));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

/**
 * Fetch single spec item by reference
 * AC: @web-dashboard ac-12
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-13 - Static mode deep linking
 */
export async function fetchItem(ref: string): Promise<ItemDetail> {
  // AC: @gh-pages-export ac-13 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    const envelope = fetchItemStatic(ref);
    if (!envelope) {
      throw new Error(`Item not found: ${ref}`);
    }
    return unwrapEnvelope(envelope);
  }

  const response = await fetch(`${API_BASE}/api/items/${ref}`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

export async function fetchBatchItems(refs: string[]): Promise<BatchItemsResponse> {
  if (isStaticMode()) {
    return fetchBatchItemsStatic(refs);
  }

  const response = await fetch(`${API_BASE}/api/items/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify({ refs }),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Fetch tasks linked to a spec item
 * AC: @web-dashboard ac-13
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchItemTasks(ref: string): Promise<PaginatedResponse<TaskSummary>> {
  // AC: @gh-pages-export ac-11 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapPaginatedEnvelope(fetchItemTasksStatic(ref));
  }

  const response = await fetch(`${API_BASE}/api/items/${ref}/tasks`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

/**
 * Fetch inbox items
 * AC: @web-dashboard ac-16
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchInbox(params?: {
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<InboxItem>> {
  // AC: @gh-pages-export ac-11 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapPaginatedEnvelope(fetchInboxStatic(params));
  }

  const url = new URL(`${API_BASE}/api/inbox`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

/**
 * Fetch inbox items with inline triage status from the merged aggregation endpoint.
 * Eliminates the need for separate fetchInbox + fetchTriageRecords + client-side join.
 * AC: @ui-api-aggregation ac-3 — Inbox items with inline triage status
 */
export async function fetchMergedInbox(): Promise<{
  items: InboxItemWithTriage[];
  total: number;
}> {
  // In static mode, fall back to separate fetches and merge client-side
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically
  if (isStaticMode()) {
    const inboxData = unwrapEnvelope(fetchInboxStatic());
    const triageData = unwrapEnvelope(fetchTriageRecordsStatic());
    const items: InboxItemWithTriage[] = inboxData.map((item) => {
      const record = triageData.find((r) => r.inbox_ref === item._ulid);
      const result: InboxItemWithTriage = { ...item };
      if (record) {
        result.triage = {
          _ulid: record._ulid,
          status: record.status,
          action: record.action,
          reasoning: record.reasoning,
          decided_by: record.decided_by,
          acted_at: record.acted_at,
          result_ref: record.result_ref,
        };
      }
      return result;
    });
    return { items, total: items.length };
  }

  const response = await fetch(`${API_BASE}/api/aggregation/inbox`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapListEnvelope(await response.json());
}

/**
 * Add a new inbox item
 * AC: @web-dashboard ac-18
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-17, ac-18 - Disabled in static mode
 */
export async function addInboxItem(text: string, tags?: string[]): Promise<InboxItem> {
  // AC: @gh-pages-export ac-17, ac-18 - Write operations throw in static mode
  assertWritable("add inbox item");

  const response = await fetch(`${API_BASE}/api/inbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify({ text, tags }),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  const result = await response.json();
  return result.item;
}

/**
 * Delete an inbox item
 * AC: @web-dashboard ac-19
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-18 - Disabled in static mode
 */
export async function deleteInboxItem(ref: string): Promise<void> {
  // AC: @gh-pages-export ac-18 - Write operations throw in static mode
  assertWritable("delete inbox item");

  const response = await fetch(`${API_BASE}/api/inbox/${ref}`, {
    method: "DELETE",
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
}

/**
 * Fetch session context
 * AC: @web-dashboard ac-20
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchSessionContext(): Promise<SessionContext> {
  // AC: @gh-pages-export ac-11 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    const envelope = fetchSessionContextStatic();
    if (!envelope) {
      return { focus: null, threads: [], open_questions: [], updated_at: new Date().toISOString() };
    }
    return unwrapEnvelope(envelope);
  }

  const response = await fetch(`${API_BASE}/api/meta/session`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

/**
 * Fetch observations
 * AC: @web-dashboard ac-21, ac-22
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function fetchObservations(params?: {
  type?: "friction" | "success" | "question" | "idea";
  resolved?: boolean;
}): Promise<PaginatedResponse<Observation>> {
  // AC: @gh-pages-export ac-11 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapPaginatedEnvelope(fetchObservationsStatic(params));
  }

  const url = new URL(`${API_BASE}/api/meta/observations`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

/**
 * Search across all entities
 * AC: @web-dashboard ac-24
 * AC: @multi-directory-daemon ac-26 - Includes X-Kspec-Dir header
 * AC: @gh-pages-export ac-11 - Static mode support
 */
export async function search(query: string): Promise<SearchResponse> {
  // AC: @gh-pages-export ac-11 - Use static data in static mode
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapEnvelope(searchStatic(query));
  }

  const url = new URL(`${API_BASE}/api/search`);
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

// ============================================================
// Triage API Functions
// AC: @interactive-triage-ui ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7
// ============================================================

/**
 * Fetch triage records with optional filters
 * AC: @interactive-triage-ui ac-1, ac-2, ac-7
 */
export async function fetchTriageRecords(params?: {
  status?: string;
  action?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<TriageRecord>> {
  // AC: @interactive-triage-ui ac-8 - Static mode: read-only triage data
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapPaginatedEnvelope(fetchTriageRecordsStatic(params));
  }

  const url = new URL(`${API_BASE}/api/triage`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

export type TriageExportFormat = "context" | "json";

/**
 * Fetch triage export content for preview in the UI.
 * AC: @triage-daemon-api ac-6
 */
export async function fetchTriageExport(format: TriageExportFormat): Promise<{
  format: TriageExportFormat;
  content: string;
}> {
  if (isStaticMode()) {
    throw new Error("Triage export is unavailable in static mode.");
  }

  const url = new URL(`${API_BASE}/api/triage/export`);
  url.searchParams.set("format", format);

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  const body = await response.json();
  if (format === "context") {
    return {
      format,
      content: typeof body.content === "string" ? body.content : "",
    };
  }

  return {
    format,
    content: JSON.stringify(body, null, 2),
  };
}

/**
 * Create or update a triage record
 * AC: @interactive-triage-ui ac-3
 */
export async function createTriageRecord(data: {
  inbox_ref: string;
  action: string;
  reasoning: string;
  decided_by?: string;
  evidence_refs?: string[];
}): Promise<{ success: boolean; record: TriageRecord }> {
  assertWritable("create triage record");

  const response = await fetch(`${API_BASE}/api/triage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Override a triage decision
 * AC: @interactive-triage-ui ac-4
 */
export async function overrideTriageRecord(
  ref: string,
  data: {
    action: string;
    reasoning: string;
    override_by?: string;
  },
): Promise<{ success: boolean; record: TriageRecord }> {
  assertWritable("override triage record");

  const response = await fetch(`${API_BASE}/api/triage/${ref}/override`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

// ============================================================
// Agent & Dispatch API Functions
// AC: @ui-agent-dispatch ac-1, ac-2, ac-3
// ============================================================

// AgentDefinition and AgentUpdatePayload are imported from @kynetic-ai/shared
// (schema-driven types mirroring AgentSchema from src/schema/meta.ts)
// Re-exported so existing imports from '$lib/api' continue to work.
// AC: @ui-agent-dispatch ac-4
export type { AgentDefinition, AgentUpdatePayload };

/**
 * Active invocation from GET /api/agent/status
 * AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
 */
export interface ActiveInvocation {
  session_id: string;
  agent_id: string;
  task_ref: string | null;
  task_title: string | null;
  elapsed_ms: number;
  /** Resolved adapter identity for the active invocation. */
  resolved_adapter?: string;
  /** Named runner that resolved this invocation, when one was configured. */
  runner?: string;
}

/**
 * Queued invocation from GET /api/agent/status
 * AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
 */
export interface QueuedInvocation {
  agent_id: string;
  task_ref: string | null;
  task_title: string | null;
  wait_ms: number;
  /** Resolved adapter identity (registry lookup or legacy adapter fallback). */
  resolved_adapter?: string;
  /** Runner reference declared on the agent definition, when present. */
  runner?: string;
}

/**
 * Agent dispatch status from GET /api/agent/status
 */
export interface AgentDispatchStatus {
  dispatch_enabled: boolean;
  active_invocations: ActiveInvocation[];
  queued_invocations?: QueuedInvocation[];
  queue_depth: number;
  agent_definitions: Array<{
    id: string;
    name: string;
    adapter: string;
    /** Resolved adapter identity (runner-aware). */
    resolved_adapter?: string;
    /** Runner reference declared on the agent definition. */
    runner?: string;
    completed_sessions?: number;
  }>;
}

/**
 * Fetch agent dispatch status (dispatch state + active invocations)
 * AC: @ui-agent-dispatch ac-1, ac-2, ac-3
 */
export async function fetchAgentStatus(): Promise<AgentDispatchStatus> {
  if (isStaticMode()) {
    return {
      dispatch_enabled: false,
      active_invocations: [],
      queued_invocations: [],
      queue_depth: 0,
      agent_definitions: [],
    };
  }
  const response = await fetch(`${API_BASE}/api/agent/status`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Fetch full agent definitions from meta
 * AC: @ui-agent-dispatch ac-1
 */
export async function fetchAgentDefinitions(): Promise<{
  items: AgentDefinition[];
  total: number;
}> {
  if (isStaticMode()) {
    return { items: [], total: 0 };
  }
  const response = await fetch(`${API_BASE}/api/meta/agents`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return unwrapListEnvelope(await response.json());
}

/**
 * Start or stop the dispatch engine
 * AC: @ui-agent-dispatch ac-2
 */
export async function controlDispatch(
  action: "start" | "stop",
): Promise<{ dispatch_enabled: boolean }> {
  assertWritable("control dispatch");

  const response = await fetch(`${API_BASE}/api/agent/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Update an agent definition via PATCH
 * AC: @ui-agent-dispatch ac-4
 */
export async function updateAgentDefinition(
  agentId: string,
  payload: AgentUpdatePayload,
): Promise<AgentDefinition> {
  assertWritable("update agent definition");

  const response = await fetch(`${API_BASE}/api/meta/agents/${agentId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Execute a triage action
 * AC: @interactive-triage-ui ac-3
 */
export async function actOnTriageRecord(
  ref: string,
): Promise<{ success: boolean; record: TriageRecord }> {
  assertWritable("execute triage action");

  const response = await fetch(`${API_BASE}/api/triage/${ref}/act`, {
    method: "POST",
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

// ============================================================
// Automation API Functions
// AC: @ui-automation-view ac-1 through ac-7
// ============================================================

/**
 * Hook summary from GET /api/hooks
 */
export interface HookSummary {
  id: string;
  name: string;
  on: string;
  filter: Record<string, unknown> | null;
  action_type: string;
  enabled: boolean;
}

/**
 * Schedule summary from GET /api/schedules
 */
export interface ScheduleSummary {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  overlap_policy: "skip" | "buffer_one" | "allow";
  next_tick: number | null;
  last_tick: number | null;
  run_count: number;
  active_run_count: number;
}

/**
 * Schedule runtime status from GET /api/schedules/:id/status
 */
export interface ScheduleRuntimeStatus extends ScheduleSummary {
  active_run_ids: string[];
  overlap_state: "idle" | "running" | "running_buffered";
}

/**
 * Event envelope from GET /api/events/recent
 */
export interface EventEnvelopeSummary {
  event_id: string;
  event_type: string;
  emitted_at: string;
  source_type: string;
  source_id: string;
  causation_id: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * Composition activation from GET /api/compositions/:config_id/activations
 */
export interface CompositionActivation {
  activation_id: string;
  group_id: string;
  completed_count: number;
  failed_count: number;
  total_members: number;
  member_action_run_ids: string[];
  timeout_remaining_ms: number | null;
  first_run_at: string | null;
}

/**
 * Fetch all hooks
 * AC: @ui-automation-view ac-1
 */
export async function fetchHooks(params?: {
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<HookSummary>> {
  if (isStaticMode()) {
    return { items: [], total: 0 };
  }
  const url = new URL(`${API_BASE}/api/hooks`);
  if (params?.limit !== undefined) url.searchParams.set("limit", String(params.limit));
  if (params?.offset !== undefined) url.searchParams.set("offset", String(params.offset));

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Fetch all schedules
 * AC: @ui-automation-view ac-1, ac-4
 */
export async function fetchSchedules(params?: {
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<ScheduleSummary>> {
  if (isStaticMode()) {
    return { items: [], total: 0 };
  }
  const url = new URL(`${API_BASE}/api/schedules`);
  if (params?.limit !== undefined) url.searchParams.set("limit", String(params.limit));
  if (params?.offset !== undefined) url.searchParams.set("offset", String(params.offset));

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Fetch schedule runtime status
 * AC: @ui-automation-view ac-4
 */
export async function fetchScheduleStatus(id: string): Promise<ScheduleRuntimeStatus> {
  if (isStaticMode()) {
    return {
      id,
      name: "",
      enabled: false,
      cron: "",
      timezone: "UTC",
      overlap_policy: "skip",
      next_tick: null,
      last_tick: null,
      run_count: 0,
      active_run_count: 0,
      active_run_ids: [],
      overlap_state: "idle",
    };
  }
  const response = await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(id)}/status`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Manually trigger a schedule
 * AC: @ui-automation-view ac-3
 */
export async function triggerSchedule(id: string): Promise<{
  outcome: "accepted" | "buffered" | "queued" | "skipped";
  accepted: boolean;
  reason: string | null;
}> {
  assertWritable("trigger schedule");

  const response = await fetch(`${API_BASE}/api/schedules/${encodeURIComponent(id)}/trigger`, {
    method: "POST",
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Fetch recent events from the event ring buffer
 * AC: @ui-automation-view ac-2
 */
export async function fetchRecentEvents(params?: {
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<EventEnvelopeSummary>> {
  if (isStaticMode()) {
    return { items: [], total: 0 };
  }
  const url = new URL(`${API_BASE}/api/events/recent`);
  if (params?.type) url.searchParams.set("type", params.type);
  if (params?.limit !== undefined) url.searchParams.set("limit", String(params.limit));
  if (params?.offset !== undefined) url.searchParams.set("offset", String(params.offset));

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Composition config summary from GET /api/compositions
 */
export interface CompositionConfigSummary {
  id: string;
  name: string;
  join_count: number;
  timeout_ms: number | null;
  enabled: boolean;
}

/**
 * Fetch composition configs
 * AC: @ui-automation-view ac-6
 */
export async function fetchCompositionConfigs(): Promise<
  PaginatedResponse<CompositionConfigSummary>
> {
  if (isStaticMode()) {
    return { items: [], total: 0 };
  }
  const response = await fetch(`${API_BASE}/api/compositions`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Fetch composition activations
 * AC: @ui-automation-view ac-6
 */
export async function fetchCompositionActivations(configId: string): Promise<{
  config_id: string;
  activations: CompositionActivation[];
}> {
  if (isStaticMode()) {
    return { config_id: configId, activations: [] };
  }
  const response = await fetch(
    `${API_BASE}/api/compositions/${encodeURIComponent(configId)}/activations`,
    { headers: getProjectHeaders() },
  );
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

// ============================================================
// Plans API Functions
// AC: @ui-plans-view ac-1
// ============================================================

/**
 * Fetch plans with optional status filter
 * AC: @ui-plans-view ac-1
 */
export async function fetchPlans(params?: {
  status?: string;
}): Promise<{ items: PlanSummary[]; total: number }> {
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapListEnvelope(fetchPlansStatic(params));
  }

  const url = new URL(`${API_BASE}/api/plans`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapListEnvelope(await response.json());
}

/**
 * Fetch a single plan's detail including content (lazy-loaded on expand)
 * AC: @ui-plans-view ac-2
 */
export async function fetchPlanContent(ref: string): Promise<PlanDetail> {
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapEnvelope(fetchPlanContentStatic(ref));
  }

  const response = await fetch(`${API_BASE}/api/plans/${ref}`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

// ============================================================
// Reviews API Functions
// AC: @review-records-web-ui ac-1
// ============================================================

/**
 * Fetch reviews with optional filters
 * AC: @review-records-web-ui ac-1
 */
export async function fetchReviews(params?: {
  status?: string | string[];
  disposition?: string;
  subject_type?: string;
  subject_ref?: string;
  head_branch?: string;
  task?: string;
  sort?: string;
  sort_dir?: string;
  limit?: number;
  offset?: number;
}): Promise<PaginatedResponse<ReviewSummary>> {
  // AC: @folder-backed-review-storage-1 ac-review-index-has-bounded-projection
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapPaginatedEnvelope(fetchReviewsStatic(params));
  }

  const url = new URL(`${API_BASE}/api/reviews`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        if (Array.isArray(value)) {
          value.forEach((v) => url.searchParams.append(key, v));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    });
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

/**
 * Fetch a single review by ID (ULID or slug).
 *
 * In static mode the bounded snapshot projection is unwrapped — threads,
 * checks, verdicts, events, and notes are empty by design (the snapshot
 * never carried them), but the subject, disposition, resources, and
 * external links survive so the detail page renders cleanly and exported
 * screenshot resources stay discoverable.
 *
 * AC: @review-records-web-ui ac-2
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 */
export async function fetchReview(id: string): Promise<ReviewDetail> {
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    const envelope = fetchReviewStatic(id);
    if (!envelope) {
      throw new Error(`Review not found: ${id}`);
    }
    return unwrapEnvelope(envelope);
  }

  const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(id)}`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

/**
 * Build the URL the daemon serves a single review-resource's raw bytes at.
 * Same shape as the static-export asset path, but rooted at the live
 * daemon's API base so the UI can render images / download links without
 * a snapshot.
 *
 * When a project is selected, the path is appended as a `kspec_dir` query
 * parameter so the daemon middleware can route the request to the right
 * project. Browser-issued requests for binary URLs from `<img src>` or
 * `<a href>` cannot include the `X-Kspec-Dir` header the rest of the API
 * relies on, so the URL itself must carry the project context — otherwise
 * the daemon falls back to the default project and screenshots for any
 * non-default selected project would 404 or load the wrong project's bytes.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @multi-directory-daemon ac-26 — preserves selected-project context
 */
export function reviewResourceBytesUrl(reviewRef: string, resourceId: string): string {
  const base = `${API_BASE}/api/reviews/${encodeURIComponent(reviewRef)}/resources/${encodeURIComponent(resourceId)}/bytes`;
  const projectPath = getSelectedProjectPath();
  return projectPath ? `${base}?kspec_dir=${encodeURIComponent(projectPath)}` : base;
}

/**
 * Encode a snapshot-relative `exported_path` (e.g.
 * `assets/resources/review/<ulid>/screenshots/login#bug.png`) for use as
 * a URL. Resource paths are POSIX paths and the schema only rejects
 * absolute paths, parent traversal, backslashes, empty segments, and
 * trailing slashes — URL-reserved characters such as `#` and `?` are
 * legitimate filename characters and reach here unencoded. Without
 * per-segment encoding a raw `<a href={exported_path}>` would have
 * `#suffix` treated as a fragment and `?suffix` treated as a query
 * string by the browser, so any such resource would 404 or load the
 * wrong bytes from the static export. Each `/`-separated segment is
 * encoded individually so the path separators stay intact while
 * `#` becomes `%23`, `?` becomes `%3F`, spaces become `%20`, etc.
 *
 * AC: @folder-backed-review-storage-1 ac-review-screenshot-resource-loads-in-ui
 * AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
 */
export function encodeStaticAssetPath(exportedPath: string): string {
  return exportedPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * List declared resources for a review. Always available against a live
 * daemon; static mode reads `review.resources` straight off the snapshot
 * instead of calling this helper.
 *
 * AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
 */
export async function fetchReviewResources(
  reviewRef: string,
): Promise<{ resources: ReviewResource[] }> {
  if (isStaticMode()) {
    throw new Error("Review resources are read from the snapshot in static mode");
  }
  const response = await fetch(
    `${API_BASE}/api/reviews/${encodeURIComponent(reviewRef)}/resources`,
    { headers: getProjectHeaders() },
  );
  if (!response.ok) {
    await handleResponseError(response);
  }
  return (await response.json()) as { resources: ReviewResource[] };
}

/**
 * Fetch sibling reviews for the same subject (for revision selector).
 * Returns all reviews matching the subject type, filtered client-side
 * by subject_ref or head_branch depending on subject type.
 * AC: @review-records-web-ui ac-11
 */
export async function fetchReviewSiblings(params: {
  subject_type: string;
  subject_ref?: string;
  head_branch?: string;
}): Promise<ReviewSummary[]> {
  // fetchReviews handles static mode internally via fetchReviewsStatic,
  // so the same filters work against the snapshot.
  const data = await fetchReviews({
    status: ["draft", "open", "closed", "archived"],
    sort: "created_at",
    sort_dir: "asc",
    subject_type: params.subject_type,
    subject_ref: params.subject_ref,
    head_branch: params.head_branch,
  });

  return data.items;
}

// ============================================================
// Diff API Functions
// AC: @review-code-diff-viewer ac-1, ac-2, ac-3, ac-6
// ============================================================

/**
 * Diff types matching the daemon's parsed diff format.
 * AC: @review-code-diff-viewer ac-1, ac-2
 */
export interface DiffChangeLine {
  type: "added" | "deleted" | "unchanged";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  changes: DiffChangeLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  stats: { additions: number; deletions: number };
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  base: string;
  head: string;
  files: DiffFile[];
  stats: {
    totalFiles: number;
    totalAdditions: number;
    totalDeletions: number;
  };
}

export interface DiffContextLine {
  lineNumber: number;
  content: string;
}

export interface DiffContextResponse {
  base: string;
  head: string;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: DiffContextLine[];
}

/**
 * Fetch full diff between two commits.
 * AC: @review-code-diff-viewer ac-1
 */
export async function fetchDiff(base: string, head: string): Promise<ParsedDiff> {
  if (isStaticMode()) {
    throw new Error("Diff not available in static mode");
  }

  const url = new URL(`${API_BASE}/api/diff`);
  url.searchParams.set("base", base);
  url.searchParams.set("head", head);

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Fetch diff for a single file (lazy loading).
 * AC: @review-code-diff-viewer ac-6
 */
export async function fetchFileDiff(
  base: string,
  head: string,
  path: string,
): Promise<{ base: string; head: string; file: DiffFile }> {
  if (isStaticMode()) {
    throw new Error("File diff not available in static mode");
  }

  const url = new URL(`${API_BASE}/api/diff/file`);
  url.searchParams.set("base", base);
  url.searchParams.set("head", head);
  url.searchParams.set("path", path);

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Fetch expanded context lines for a file region.
 * AC: @review-code-diff-viewer ac-3
 */
export async function fetchDiffContext(
  base: string,
  head: string,
  path: string,
  start: number,
  end: number,
): Promise<DiffContextResponse> {
  if (isStaticMode()) {
    throw new Error("Diff context not available in static mode");
  }

  const url = new URL(`${API_BASE}/api/diff/context`);
  url.searchParams.set("base", base);
  url.searchParams.set("head", head);
  url.searchParams.set("path", path);
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

// ============================================================
// Workflows API Functions
// AC: @ui-workflows-view ac-1
// ============================================================

/**
 * Fetch workflow definitions
 * AC: @ui-workflows-view ac-1
 */
export async function fetchWorkflows(): Promise<{ items: Workflow[]; total: number }> {
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapListEnvelope(fetchWorkflowsStatic());
  }

  const response = await fetch(`${API_BASE}/api/meta/workflows`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapListEnvelope(await response.json());
}

// ============================================================
// Session API Functions
// AC: @ui-session-stream ac-1, ac-2, ac-4
// ============================================================

/**
 * Session summary from the daemon API.
 */
export interface SessionSummary {
  id: string;
  status: "active" | "completed" | "abandoned" | "timed_out" | "failed" | "stalled";
  agent_type: string;
  /** Agent definition ID (e.g. worker, pr-reviewer). */
  agent_id?: string;
  session_type: "loop" | "invocation";
  /** Dispatch trigger for distinguishing dispatched agent vs manual CLI run. */
  trigger?: string;
  /** Task ID being worked on (if any). AC: @ui-session-history ac-1 */
  task_id?: string;
  /** Server-resolved task title. AC: @ui-api-ref-resolution ac-1 */
  task_title?: string | null;
  started_at: string;
  ended_at?: string;
  duration_ms: number;
  event_count: number;
  iteration_count: number;
  tasks_completed: number;
}

/**
 * Spec context with acceptance criteria checklist.
 * AC: @ui-session-stream ac-4
 */
export interface SessionSpecContext {
  spec_ref: string;
  title: string;
  acceptance_criteria: Array<{ id: string; description: string }>;
}

/**
 * Session budget info.
 * AC: @ui-session-stream ac-4
 */
export interface SessionBudget {
  max_per_cycle: number;
  started_this_cycle: number;
}

/**
 * Session detail with additional metadata.
 * AC: @ui-session-stream ac-4
 */
export interface SessionDetail extends SessionSummary {
  task_id?: string;
  agent_id?: string;
  trigger?: string;
  spec_context?: SessionSpecContext | null;
  budget?: SessionBudget | null;
}

/**
 * A single event from events.jsonl.
 */
export interface SessionEvent {
  ts: number;
  seq: number;
  type: string;
  session_id: string;
  trace_id?: string;
  data: unknown;
}

/**
 * Pagination and filter parameters for session list.
 * AC: @session-list-infinite-scroll ac-initial-load
 * AC: @session-filter-controls ac-status-filter, ac-agent-filter, ac-agent-type-filter, ac-trigger-filter, ac-date-filter
 */
export interface FetchSessionsParams {
  offset?: number;
  limit?: number;
  status?: string[];
  agent_id?: string;
  agent_type?: string;
  trigger?: string;
  since?: string;
  task_id?: string;
  spec_ref?: string;
}

export interface SessionSearchMatch {
  session_id: string;
  event_seq: number;
  timestamp: number;
  event_type: string;
  content_excerpt: string;
}

export interface SessionSearchResult {
  session_id: string;
  agent_type: string;
  started_at: string;
  matches: SessionSearchMatch[];
}

export interface FetchSessionSearchParams {
  q: string;
  status?: string[];
  agent_id?: string;
  agent_type?: string;
  trigger?: string;
  since?: string;
  task_id?: string;
  spec_ref?: string;
  limit?: number;
}

export interface SessionSearchResponse {
  items: SessionSearchResult[];
  total_sessions: number;
  total_matches: number;
  query: string;
}

/**
 * Paginated session list response.
 * AC: @session-list-infinite-scroll ac-initial-load
 */
export interface SessionListResponse {
  items: SessionSummary[];
  total: number;
  unfiltered_total: number;
  offset: number;
  limit: number;
}

/**
 * Fetch sessions with pagination and filtering.
 * AC: @ui-session-stream ac-1
 * AC: @session-list-infinite-scroll ac-initial-load
 */
export async function fetchSessions(params?: FetchSessionsParams): Promise<SessionListResponse> {
  if (isStaticMode()) {
    return { items: [], total: 0, unfiltered_total: 0, offset: 0, limit: 25 };
  }

  const url = new URL(`${API_BASE}/api/sessions`);
  if (params?.offset !== undefined) {
    url.searchParams.set("offset", String(params.offset));
  }
  if (params?.limit !== undefined) {
    url.searchParams.set("limit", String(params.limit));
  }
  // AC: @session-filter-controls ac-status-filter — Multi-value status filter
  if (params?.status?.length) {
    for (const s of params.status) {
      url.searchParams.append("status", s);
    }
  }
  // AC: @session-filter-controls ac-agent-filter
  if (params?.agent_id) {
    url.searchParams.set("agent_id", params.agent_id);
  }
  // AC: @session-filter-controls ac-agent-type-filter
  if (params?.agent_type) {
    url.searchParams.set("agent_type", params.agent_type);
  }
  // AC: @session-filter-controls ac-trigger-filter
  if (params?.trigger) {
    url.searchParams.set("trigger", params.trigger);
  }
  // AC: @session-filter-controls ac-date-filter
  if (params?.since) {
    url.searchParams.set("since", params.since);
  }
  if (params?.task_id) {
    url.searchParams.set("task_id", params.task_id);
  }
  if (params?.spec_ref) {
    url.searchParams.set("spec_ref", params.spec_ref);
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapSessionListEnvelope(await response.json());
}

export async function fetchSessionSearch(
  params: FetchSessionSearchParams,
): Promise<SessionSearchResponse> {
  if (isStaticMode()) {
    return { items: [], total_sessions: 0, total_matches: 0, query: params.q };
  }

  const url = new URL(`${API_BASE}/api/sessions/search`);
  url.searchParams.set("q", params.q);
  if (params.limit !== undefined) {
    url.searchParams.set("limit", String(params.limit));
  }
  if (params.status?.length) {
    for (const s of params.status) {
      url.searchParams.append("status", s);
    }
  }
  if (params.agent_id) {
    url.searchParams.set("agent_id", params.agent_id);
  }
  if (params.agent_type) {
    url.searchParams.set("agent_type", params.agent_type);
  }
  if (params.trigger) {
    url.searchParams.set("trigger", params.trigger);
  }
  if (params.since) {
    url.searchParams.set("since", params.since);
  }
  if (params.task_id) {
    url.searchParams.set("task_id", params.task_id);
  }
  if (params.spec_ref) {
    url.searchParams.set("spec_ref", params.spec_ref);
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

export async function fetchTaskSessions(ref: string): Promise<SessionListResponse> {
  if (isStaticMode()) {
    return { items: [], total: 0, unfiltered_total: 0, offset: 0, limit: 0 };
  }

  const response = await fetch(`${API_BASE}/api/tasks/${ref}/sessions`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapSimpleSessionListEnvelope(await response.json());
}

export async function fetchItemSessions(ref: string): Promise<SessionListResponse> {
  if (isStaticMode()) {
    return { items: [], total: 0, unfiltered_total: 0, offset: 0, limit: 0 };
  }

  const response = await fetch(`${API_BASE}/api/items/${ref}/sessions`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapSimpleSessionListEnvelope(await response.json());
}

/**
 * Fetch a single session by ID.
 * AC: @ui-session-stream ac-4
 */
export async function fetchSession(id: string): Promise<SessionDetail> {
  if (isStaticMode()) {
    throw new Error("Session data not available in static mode");
  }

  const response = await fetch(`${API_BASE}/api/sessions/${id}`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

/**
 * Fetch session events (optionally incremental via since_seq).
 * AC: @ui-session-stream ac-1, ac-2
 */
export async function fetchSessionEvents(
  id: string,
  sinceSeq?: number,
): Promise<{ events: SessionEvent[]; total: number }> {
  if (isStaticMode()) {
    return { events: [], total: 0 };
  }

  const url = new URL(`${API_BASE}/api/sessions/${id}/events`);
  if (sinceSeq !== undefined) {
    url.searchParams.set("since_seq", String(sinceSeq));
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  const json = await response.json();
  const { events } = unwrapEnvelope<{ events: SessionEvent[] }>(json);
  return { events, total: json.meta?.total ?? events.length };
}

/**
 * Fetch a single session event by sequence number (on-demand tool output).
 * AC: @ws-session-event-streaming ac-tool-output-on-demand
 */
export async function fetchSessionEventDetail(id: string, seq: number): Promise<SessionEvent> {
  if (isStaticMode()) {
    throw new Error("Session event detail not available in static mode");
  }

  const response = await fetch(`${API_BASE}/api/sessions/${id}/events/${seq}`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

// ============================================================
// Reviews API Functions
// AC: @review-records-web-ui ac-7
// ============================================================

/**
 * Fetch reviews linked to a task (via subject or related_refs).
 * Used by the task detail page to show linked review history.
 * AC: @review-records-web-ui ac-7
 */
export async function fetchReviewsForTask(
  taskRef: string,
): Promise<PaginatedResponse<ReviewSummary>> {
  if (isStaticMode()) {
    return { items: [], total: 0, offset: 0, limit: 0 };
  }

  const url = new URL(`${API_BASE}/api/reviews`);
  url.searchParams.set("task", taskRef);
  // Fetch all lifecycle states — backend defaults to 'open' when no status param
  for (const s of ["draft", "open", "closed", "archived"]) {
    url.searchParams.append("status", s);
  }

  const response = await fetch(url.toString(), {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapPaginatedEnvelope(await response.json());
}

// ============================================================
// Review Content API Functions
// AC: @review-structured-content-viewer ac-1, ac-2
// ============================================================

/**
 * Content section types returned by GET /api/reviews/:id/content
 */
export interface ContentSectionMarkdown {
  id: string;
  type: "markdown";
  title: string;
  content: string;
  /**
   * Byte-free resource context for `./resources/<relative-path>` markdown
   * targets in this section. Present when the review subject (plan or task)
   * owns resources: plan subjects carry declared plan manifest metadata with
   * a plan-scoped bytes base URL, task subjects carry the resolved-resource
   * status projection with a task-scoped bytes base URL. Clients rewrite only
   * declared/`present` resources and keep everything else visible.
   *
   * AC: @review-content-diff-api ac-5
   * AC: @review-content-diff-api ac-6
   */
  resource_context?: ReviewContentResourceContext;
}

export interface ContentSectionRefList {
  id: string;
  type: "ref_list";
  title: string;
  refs: string[];
}

export interface ContentSectionAcceptanceCriteria {
  id: string;
  type: "acceptance_criteria";
  title: string;
  criteria: Array<{ id: string; given?: string; when?: string; then?: string }>;
}

export interface ContentSectionNotes {
  id: string;
  type: "notes";
  title: string;
  notes: Array<{ author: string; body: string; created_at: string }>;
}

export interface ContentSectionMetadata {
  id: string;
  type: "metadata";
  title: string;
  metadata: Record<string, unknown>;
}

export type ContentSection =
  | ContentSectionMarkdown
  | ContentSectionRefList
  | ContentSectionAcceptanceCriteria
  | ContentSectionNotes
  | ContentSectionMetadata;

export interface ReviewContentResponse {
  review_id: string;
  subject_type: string;
  subject_ref: string | null;
  content: {
    title: string;
    sections: ContentSection[];
  } | null;
  diff_params?: {
    base: string;
    head: string;
  };
}

/**
 * Fetch structured content for a review (plan/spec/task subjects).
 * AC: @review-structured-content-viewer ac-1, ac-2
 */
export async function fetchReviewContent(reviewId: string): Promise<ReviewContentResponse> {
  if (isStaticMode()) {
    throw new Error("Review content not available in static mode");
  }

  const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/content`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

// ============================================================
// Review Interaction API Functions
// AC: @review-records-web-ui ac-3, ac-4, ac-5, ac-6
// ============================================================

/**
 * Create a new thread (comment) on a review.
 * AC: @review-records-web-ui ac-3
 */
export async function createReviewThread(
  reviewId: string,
  data: {
    body: string;
    kind?: "blocker" | "question" | "nit";
    author?: string;
    anchor?:
      | {
          type: "code";
          path: string;
          side: "base" | "head";
          line_start: number;
          line_end: number;
          commit: string;
        }
      | {
          type: "structured";
          section?: string;
          field?: string;
          path?: string;
          ref?: string;
        };
  },
): Promise<ReviewThread> {
  assertWritable("add comment to review");

  const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/comments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Reply to an existing thread on a review.
 * AC: @review-records-web-ui ac-4
 */
export async function replyToReviewThread(
  reviewId: string,
  threadId: string,
  data: { body: string; author?: string },
): Promise<ReviewThread> {
  assertWritable("reply to review thread");

  const response = await fetch(
    `${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(threadId)}/replies`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getProjectHeaders(),
      },
      body: JSON.stringify(data),
    },
  );
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Resolve a thread on a review.
 * AC: @review-records-web-ui ac-5
 */
export async function resolveReviewThread(
  reviewId: string,
  threadId: string,
  actor?: string,
): Promise<ReviewThread> {
  assertWritable("resolve review thread");

  const response = await fetch(
    `${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(threadId)}/resolve`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...getProjectHeaders(),
      },
      body: JSON.stringify({ actor: actor || "anonymous" }),
    },
  );
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Reopen a resolved thread on a review.
 * AC: @review-records-web-ui ac-5
 */
export async function reopenReviewThread(
  reviewId: string,
  threadId: string,
  actor?: string,
): Promise<ReviewThread> {
  assertWritable("reopen review thread");

  const response = await fetch(
    `${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/comments/${encodeURIComponent(threadId)}/reopen`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...getProjectHeaders(),
      },
      body: JSON.stringify({ actor: actor || "anonymous" }),
    },
  );
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

/**
 * Submit a verdict on a review.
 * AC: @review-records-web-ui ac-6
 */
export async function submitReviewVerdict(
  reviewId: string,
  data: { decision: "approve" | "request_changes" | "comment"; reviewer: string; role?: string },
): Promise<{
  review_ulid: string;
  decision: string;
  reviewer: string;
  lifecycle_state: string;
  disposition: string;
}> {
  assertWritable("submit review verdict");

  const response = await fetch(`${API_BASE}/api/reviews/${encodeURIComponent(reviewId)}/verdicts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getProjectHeaders(),
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return response.json();
}

// ============================================================
// Validation & Alignment API Functions
// AC: @ui-validation-view ac-1
// ============================================================

export interface SchemaValidationError {
  file: string;
  path?: string;
  message: string;
  details?: unknown;
}

export interface RefValidationError {
  ref: string;
  sourceFile?: string;
  sourceUlid?: string;
  field: string;
  error: "not_found" | "ambiguous" | "duplicate_slug";
  message: string;
}

export interface RefValidationWarning {
  ref: string;
  sourceFile?: string;
  sourceUlid?: string;
  field: string;
  warning: "deprecated_target";
  message: string;
}

export interface OrphanItem {
  ulid: string;
  title: string;
  type: string;
  file?: string;
}

export type CompletenessWarningType =
  | "missing_acceptance_criteria"
  | "missing_description"
  | "status_inconsistency"
  | "missing_test_coverage"
  | "automation_eligible_no_spec"
  | "ac_schema_field_mismatch";

export interface CompletenessWarning {
  type: CompletenessWarningType;
  subtype?: "own_ac" | "trait_ac";
  itemRef: string;
  itemTitle: string;
  message: string;
  details?: string;
}

export interface TraitCycleError {
  traitRef: string;
  traitTitle: string;
  cycle: string[];
  message: string;
}

export interface ValidationResponse {
  valid: boolean;
  schemaErrors: SchemaValidationError[];
  refErrors: RefValidationError[];
  refWarnings: RefValidationWarning[];
  orphans: OrphanItem[];
  completenessWarnings: CompletenessWarning[];
  traitCycles: TraitCycleError[];
}

/** Alias for backward compatibility with dashboard overview */
export type ValidationResult = ValidationResponse;

export interface AlignmentWarning {
  type: "orphaned_spec" | "status_mismatch" | "stale_implementation";
  specUlid?: string;
  specTitle?: string;
  taskUlid?: string;
  message: string;
}

export interface AlignmentStats {
  totalSpecs: number;
  specsWithTasks: number;
  alignedSpecs: number;
  orphanedSpecs: number;
}

export interface AlignmentResponse {
  stats: AlignmentStats;
  warnings: AlignmentWarning[];
}

/**
 * Fetch validation results
 * AC: @ui-validation-view ac-1
 */
export async function fetchValidation(): Promise<ValidationResponse> {
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    const data = unwrapEnvelope(fetchValidationStatic());
    // Normalize: ensure all array fields exist even if omitted
    return {
      valid: data.valid ?? true,
      schemaErrors: data.schemaErrors ?? [],
      refErrors: data.refErrors ?? [],
      refWarnings: data.refWarnings ?? [],
      orphans: data.orphans ?? [],
      completenessWarnings: data.completenessWarnings ?? [],
      traitCycles: data.traitCycles ?? [],
    };
  }

  const response = await fetch(`${API_BASE}/api/validate`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  const data = unwrapEnvelope<Partial<ValidationResponse>>(await response.json());
  // Normalize: ensure all array fields exist even if the API omits them
  return {
    valid: data.valid ?? true,
    schemaErrors: data.schemaErrors ?? [],
    refErrors: data.refErrors ?? [],
    refWarnings: data.refWarnings ?? [],
    orphans: data.orphans ?? [],
    completenessWarnings: data.completenessWarnings ?? [],
    traitCycles: data.traitCycles ?? [],
  };
}

/**
 * Fetch alignment stats and warnings
 * AC: @ui-validation-view ac-1
 */
export async function fetchAlignment(): Promise<AlignmentResponse> {
  // AC: @api-contract ac-envelope — static returns envelope, unwrap identically to live
  if (isStaticMode()) {
    return unwrapEnvelope(fetchAlignmentStatic());
  }

  const response = await fetch(`${API_BASE}/api/alignment`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }

  return unwrapEnvelope(await response.json());
}

// ============================================================
// Settings API Functions
// AC: @ui-settings-view ac-1
// ============================================================

/**
 * Daemon health check response
 * AC: @ui-settings-view ac-1 — daemon connection info (port, uptime, version)
 */
export interface HealthResponse {
  status: string;
  uptime: number;
  connections: number;
  version: string;
  runtime: string;
}

/**
 * Project config from manifest + kspec.config.yaml
 * AC: @ui-settings-view ac-1 — project config (name, version, remote tracking)
 */
export interface ProjectConfig {
  project: { name: string; version: string; status: string } | null;
  spec_version: string | null;
  root_dir: string;
  remote_tracking: { value: string; type: string } | null;
  daemon: { port: number; host: string; auto_start: boolean };
}

/**
 * Shadow branch status
 * AC: @ui-settings-view ac-1 — shadow branch status
 */
export interface ShadowStatusResponse {
  enabled: boolean;
  branch_name: string | null;
  worktree_dir: string | null;
  healthy: boolean;
  remote_tracking: boolean;
}

/**
 * Fetch daemon health
 * AC: @ui-settings-view ac-1
 */
export async function fetchHealth(): Promise<HealthResponse> {
  if (isStaticMode()) {
    return { status: "static", uptime: 0, connections: 0, version: "", runtime: "static" };
  }
  const response = await fetch(`${API_BASE}/api/health`);
  if (!response.ok) {
    await handleResponseError(response);
  }
  return response.json();
}

/**
 * Fetch project config (manifest + kspec.config.yaml)
 * AC: @ui-settings-view ac-1
 */
export async function fetchProjectConfig(): Promise<ProjectConfig> {
  if (isStaticMode()) {
    return {
      project: null,
      spec_version: null,
      root_dir: "",
      remote_tracking: null,
      daemon: { port: 0, host: "", auto_start: false },
    };
  }
  const response = await fetch(`${API_BASE}/api/meta/config`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return unwrapEnvelope(await response.json());
}

/**
 * Fetch shadow branch status
 * AC: @ui-settings-view ac-1
 */
export async function fetchShadowStatus(): Promise<ShadowStatusResponse> {
  if (isStaticMode()) {
    return {
      enabled: false,
      branch_name: null,
      worktree_dir: null,
      healthy: false,
      remote_tracking: false,
    };
  }
  const response = await fetch(`${API_BASE}/api/meta/shadow`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return unwrapEnvelope(await response.json());
}

/**
 * Fetch convention definitions
 * AC: @ui-settings-view ac-1
 */
export async function fetchConventions(): Promise<{ items: Convention[]; total: number }> {
  if (isStaticMode()) {
    return { items: [], total: 0 };
  }
  const response = await fetch(`${API_BASE}/api/meta/conventions`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return unwrapListEnvelope(await response.json());
}

/**
 * Fetch extended validation/alignment stats with entity and AC counts
 * AC: @ui-api-aggregation ac-2
 */
export async function fetchValidationAggregation(): Promise<ValidationAggregation> {
  if (isStaticMode()) {
    return {
      entity_count: 0,
      ac_count: 0,
      trait_ac_count: 0,
      trait_count: 0,
      coverage_percent: 0,
    } as ValidationAggregation;
  }
  const response = await fetch(`${API_BASE}/api/aggregation/validation`, {
    headers: getProjectHeaders(),
  });
  if (!response.ok) {
    await handleResponseError(response);
  }
  return unwrapEnvelope(await response.json());
}
