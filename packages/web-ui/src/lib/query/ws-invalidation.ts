/**
 * WebSocket → Query Invalidation Wiring
 *
 * Maps WebSocket broadcast topics to TanStack Query key invalidations.
 * Centralized handler that replaces per-page WS reload patterns.
 *
 * AC: @ui-data-freshness ac-3 — WS events invalidate cached data
 * AC: @ui-data-freshness ac-4 — Event-driven, not polling
 * AC: @ui-data-freshness ac-warming-auto-transition — domain_ready events invalidate affected queries
 */

import type { QueryClient } from "@tanstack/svelte-query";
import type { BroadcastEvent } from "@kynetic-ai/shared";
import { queryKeys } from "./keys.js";
import { on, off, subscribe, unsubscribe } from "$lib/stores/connection.svelte";

/**
 * Topics we subscribe to for cache invalidation.
 * Must match the exact topic strings the daemon broadcasts on.
 */
const INVALIDATION_TOPICS = [
  "tasks:updates",
  "items:updates",
  "inbox:updates",
  "triage:updates",
  "reviews:updates",
  "agents",
  "sessions",
  "files:updates",
  "cache:status",
] as const;

/**
 * Map a broadcast event to the query keys that should be invalidated.
 *
 * Returns an array of query key prefixes to invalidate.
 * Returning an empty array means no invalidation needed (e.g., text chunks).
 */
function getInvalidationKeys(
  topic: string,
  event: BroadcastEvent,
): readonly (readonly unknown[])[] {
  switch (topic) {
    case "tasks:updates":
      // Task status changes affect task lists, summaries, sidebar counts,
      // and session context (which includes current focus/active work)
      return [queryKeys.tasks.all, queryKeys.validation.all, queryKeys.sessionContext.all];

    case "items:updates":
      // Spec item changes affect item lists and validation
      return [queryKeys.items.all, queryKeys.validation.all];

    case "inbox:updates":
      // Inbox changes affect inbox list, count, and merged inbox (triage status)
      return [queryKeys.inbox.all];

    case "triage:updates":
      // Triage changes affect the merged inbox view (triage status inline)
      return [queryKeys.inbox.all];

    case "reviews:updates":
      // Review changes affect review lists and task detail (review_ref display)
      return [queryKeys.reviews.all, queryKeys.tasks.all];

    case "agents": {
      // Streaming progress events don't need cache invalidation —
      // they're consumed directly by components for real-time display.
      const streamingEvents = new Set([
        "message_start",
        "message_progress",
        "thinking_start",
        "thinking_progress",
        "tool_call_start",
      ]);
      if (streamingEvents.has(event.event)) {
        return [];
      }
      // Completion events (message_complete, thinking_complete, tool_call_complete)
      // only invalidate session queries — they signal that a message/thought
      // finished, which is relevant for session detail views but NOT for
      // agent status or definitions. Avoids excessive agent/status refetches
      // during active dispatch work.
      if (
        event.event === "message_complete" ||
        event.event === "thinking_complete" ||
        event.event === "tool_call_complete"
      ) {
        const sessionId = (event.data as { session_id?: string })?.session_id;
        if (sessionId) {
          return [queryKeys.sessions.all];
        }
        return [];
      }
      // Agent lifecycle events (started, completed, failed) represent actual
      // dispatch state changes — invalidate both agents and sessions.
      return [queryKeys.agents.all, queryKeys.sessions.all];
    }

    case "sessions":
      return [queryKeys.sessions.all];

    case "files:updates":
      // File changes (e.g., settings save, meta edits) affect multiple caches
      // Observations and session context live in meta files
      // Automation config (hooks, schedules, compositions) lives in meta files
      return [
        queryKeys.settings.all,
        queryKeys.workflows.all,
        queryKeys.observations.all,
        queryKeys.validation.all,
        queryKeys.automation.all,
        queryKeys.sessionContext.all,
      ];

    case "cache:status":
      // AC: @ui-data-freshness ac-warming-auto-transition
      // When a cache domain finishes loading, invalidate queries for that domain
      // so they refetch immediately instead of waiting for retry polling.
      return getDomainReadyInvalidationKeys(event);

    default:
      return [];
  }
}

/**
 * Map a cache domain name to query keys that should be invalidated when that
 * domain becomes ready. Matches the daemon's CacheDomain type.
 *
 * AC: @ui-data-freshness ac-warming-auto-transition
 */
const DOMAIN_QUERY_KEY_MAP: Record<string, readonly (readonly unknown[])[]> = {
  tasks: [queryKeys.tasks.all, queryKeys.validation.all, queryKeys.sessionContext.all],
  items: [queryKeys.items.all, queryKeys.validation.all],
  inbox: [queryKeys.inbox.all],
  triage: [queryKeys.inbox.all],
  reviews: [queryKeys.reviews.all],
  plans: [queryKeys.plans.all],
  sessions: [queryKeys.sessions.all],
  // "meta" domain covers settings, workflows, observations, automation, and session context
  meta: [
    queryKeys.settings.all,
    queryKeys.workflows.all,
    queryKeys.observations.all,
    queryKeys.automation.all,
    queryKeys.sessionContext.all,
  ],
};

/**
 * Get invalidation keys for a domain_ready event.
 * Only processes "domain_ready" events; other cache:status events are ignored.
 */
function getDomainReadyInvalidationKeys(
  event: BroadcastEvent,
): readonly (readonly unknown[])[] {
  if (event.event !== "domain_ready") return [];

  const domain = (event.data as { domain?: string })?.domain;
  if (!domain) return [];

  return DOMAIN_QUERY_KEY_MAP[domain] ?? [];
}

let queryClientRef: QueryClient | null = null;
let handlersRegistered = false;

function handleBroadcastEvent(topic: string) {
  return (event: BroadcastEvent) => {
    if (!queryClientRef) return;

    const keys = getInvalidationKeys(topic, event);
    for (const key of keys) {
      queryClientRef.invalidateQueries({ queryKey: key as unknown[] });
    }
  };
}

// Store handler references for cleanup
const topicHandlers = new Map<string, (event: BroadcastEvent) => void>();

/**
 * Wire up WebSocket events to TanStack Query invalidation.
 * Call this once after the QueryClient and WebSocket connection are initialized.
 *
 * AC: @ui-data-freshness ac-3 — Broadcast events → query invalidation
 */
export function setupWsInvalidation(queryClient: QueryClient): void {
  if (handlersRegistered) return;

  queryClientRef = queryClient;

  // Subscribe to all relevant topics
  subscribe([...INVALIDATION_TOPICS]);

  // Register handlers for each topic
  for (const topic of INVALIDATION_TOPICS) {
    const handler = handleBroadcastEvent(topic);
    topicHandlers.set(topic, handler);
    on(topic, handler);
  }

  handlersRegistered = true;
}

/**
 * Tear down WebSocket invalidation wiring.
 * Called on app teardown or when reinitializing.
 */
export function teardownWsInvalidation(): void {
  if (!handlersRegistered) return;

  for (const [topic, handler] of topicHandlers) {
    off(topic, handler);
  }
  topicHandlers.clear();

  unsubscribe([...INVALIDATION_TOPICS]);

  queryClientRef = null;
  handlersRegistered = false;
}
