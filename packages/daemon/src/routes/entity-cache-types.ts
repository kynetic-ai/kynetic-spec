/**
 * Entity cache accessor types for route handlers.
 *
 * Defines the minimal interface that route handlers need from the entity cache.
 * The actual cache implementation lives in src/daemon/entity-cache.ts; these
 * types decouple routes from the import path so the cache is injected via
 * route constructor options from server.ts.
 */

import type { LoadedTask, TaskSummary, LoadedPlan, LoadedSpecItem } from "../../parser/index.js";
import type { ItemSummary, MetaSummary } from "../../daemon/entity-cache.js";
import type { SessionLogSummary } from "../../sessions/store.js";
import type { LoadedInboxItem } from "../../parser/yaml.js";
import type { LoadedTriageRecord } from "../../parser/yaml.js";
import type { LoadedReviewRecord } from "../../parser/reviews.js";

/** Domain state as reported by the cache. */
export type CacheDomainState = "unloaded" | "loading" | "ready" | "degraded";

/**
 * Minimal cache interface consumed by route handlers.
 * Matches ProjectEntityCache's public API surface that routes need.
 */
export interface RouteEntityCache {
  getDomainState(domain: string): CacheDomainState;
  getTaskIndex(): TaskSummary[] | null;
  getTaskDetail(ulid: string): LoadedTask | null;
  setTaskDetail(ulid: string, task: LoadedTask): void;
  getItemIndex(): ItemSummary[] | null;
  getItemDetail(ulid: string): LoadedSpecItem | null;
  setItemDetail(ulid: string, item: LoadedSpecItem): void;
  getSessionIndex(): SessionLogSummary[] | null;
  getSessionDetail(sessionId: string): SessionLogSummary | null;
  setSessionDetail(sessionId: string, summary: SessionLogSummary): void;
  getPlansIndex(): LoadedPlan[] | null;
  getInboxIndex(): LoadedInboxItem[] | null;
  getTriageIndex(): LoadedTriageRecord[] | null;
  getReviewsIndex(): LoadedReviewRecord[] | null;
  getMetaIndex(): MetaSummary | null;
  writeThrough(domain: string): Promise<void>;
  markWriteThrough(domain: string): void;
}

/**
 * Function that retrieves the entity cache for a project path.
 * Returns null if no cache is registered for the project.
 */
export type EntityCacheAccessor = (projectPath: string) => RouteEntityCache | null;
