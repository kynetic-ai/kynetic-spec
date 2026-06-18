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
import type {
  BroadcastEvent,
  PlanResourceChangedEventData,
  ReviewCreatedEventData,
  SpecItemChangedEventData,
  TaskUpdatedEventData,
} from "@kynetic-ai/shared";
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
  "plans:updates",
  "agents",
  "sessions",
  "files:updates",
  "cache:status",
] as const;

function uniqueKeys(keys: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
  const seen = new Set<string>();
  const out: (readonly unknown[])[] = [];
  for (const key of keys) {
    const token = JSON.stringify(key);
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(key);
  }
  return out;
}

function taskViewInvalidationKeys(): readonly (readonly unknown[])[] {
  return [queryKeys.tasks.lists(), queryKeys.tasks.summary()];
}

function folderBackedEntityId(ref: string, root: string): string | null {
  const segments = ref.split("/");
  return segments[0] === root && typeof segments[1] === "string" && segments[1].length > 0
    ? segments[1]
    : null;
}

function canonicalTaskRefs(data: Partial<TaskUpdatedEventData>): string[] {
  return [data.ulid, data.ref].filter(
    (value, index, arr): value is string =>
      typeof value === "string" && value.length > 0 && arr.indexOf(value) === index,
  );
}

function getTaskInvalidationKeys(event: BroadcastEvent): readonly (readonly unknown[])[] {
  if (event.event !== "task_updated") {
    return taskViewInvalidationKeys();
  }

  const refs = canonicalTaskRefs(event.data as Partial<TaskUpdatedEventData>);
  return uniqueKeys([
    ...refs.map((ref) => queryKeys.tasks.detail(ref)),
    ...taskViewInvalidationKeys(),
  ]);
}

function getItemInvalidationKeys(event: BroadcastEvent): readonly (readonly unknown[])[] {
  if (event.event !== "spec_item_changed") {
    return [queryKeys.items.lists(), queryKeys.validation.all];
  }

  const data = event.data as Partial<SpecItemChangedEventData>;
  return uniqueKeys([
    ...(typeof data.item_ulid === "string" && data.item_ulid.length > 0
      ? [queryKeys.items.detail(data.item_ulid)]
      : []),
    queryKeys.items.lists(),
    queryKeys.validation.all,
  ]);
}

function getReviewInvalidationKeys(event: BroadcastEvent): readonly (readonly unknown[])[] {
  const data = event.data as Partial<
    ReviewCreatedEventData & {
      review_ulid: string;
    }
  >;
  const keys: (readonly unknown[])[] = [];

  if (typeof data.review_ulid === "string" && data.review_ulid.length > 0) {
    keys.push(queryKeys.reviews.detail(data.review_ulid));
    if (event.event !== "review_created") {
      keys.push(queryKeys.reviews.content(data.review_ulid));
    }
  }

  keys.push(queryKeys.reviews.lists());

  if (
    event.event === "review_created" &&
    data.subject_type === "task" &&
    typeof data.subject_ref === "string" &&
    data.subject_ref.length > 0
  ) {
    keys.push(queryKeys.reviews.forTask(data.subject_ref));
  }

  return uniqueKeys(keys);
}

function getPlanInvalidationKeys(event: BroadcastEvent): readonly (readonly unknown[])[] {
  if (event.event !== "plan_resource_changed") {
    return [queryKeys.plans.lists()];
  }

  const data = event.data as Partial<PlanResourceChangedEventData>;
  return uniqueKeys([
    ...(typeof data.plan_ulid === "string" && data.plan_ulid.length > 0
      ? [queryKeys.plans.detail(data.plan_ulid), queryKeys.plans.content(data.plan_ulid)]
      : []),
    queryKeys.plans.lists(),
  ]);
}

function getFileUpdateInvalidationKeys(event: BroadcastEvent): readonly (readonly unknown[])[] {
  const ref = (event.data as { ref?: string } | undefined)?.ref;
  if (!ref) {
    return [];
  }

  if (ref.endsWith(".tasks.yaml") || ref === "project.tasks.yaml" || ref === "tasks.yaml") {
    return taskViewInvalidationKeys();
  }

  const taskId = folderBackedEntityId(ref, "tasks");
  if (taskId) {
    return uniqueKeys([queryKeys.tasks.detail(taskId), ...taskViewInvalidationKeys()]);
  }

  if (ref === "project.inbox.yaml") {
    return [queryKeys.inbox.all];
  }

  if (ref === "project.triage.yaml") {
    return [queryKeys.inbox.all];
  }

  if (ref === "project.reviews.yaml") {
    return [queryKeys.reviews.lists()];
  }

  const reviewId = folderBackedEntityId(ref, "reviews");
  if (reviewId) {
    return uniqueKeys([
      queryKeys.reviews.detail(reviewId),
      queryKeys.reviews.content(reviewId),
      queryKeys.reviews.lists(),
    ]);
  }

  if (ref === "project.plans.yaml") {
    return [queryKeys.plans.lists()];
  }

  const planId = folderBackedEntityId(ref, "plans");
  if (planId) {
    return uniqueKeys([
      queryKeys.plans.detail(planId),
      queryKeys.plans.content(planId),
      queryKeys.plans.lists(),
    ]);
  }

  if (ref.startsWith("modules/") || ref.endsWith(".spec.yaml")) {
    return [queryKeys.items.lists(), queryKeys.validation.all];
  }

  if (ref === "kynetic.yaml" || ref.endsWith(".meta.yaml")) {
    return [
      queryKeys.items.all,
      queryKeys.settings.all,
      queryKeys.workflows.all,
      queryKeys.observations.all,
      queryKeys.validation.all,
      queryKeys.automation.all,
      queryKeys.sessionContext.all,
    ];
  }

  return [
    queryKeys.settings.all,
    queryKeys.workflows.all,
    queryKeys.observations.all,
    queryKeys.validation.all,
    queryKeys.automation.all,
    queryKeys.sessionContext.all,
  ];
}

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
      return getTaskInvalidationKeys(event);

    case "items:updates":
      return getItemInvalidationKeys(event);

    case "inbox:updates":
      // Inbox changes affect inbox list, count, and merged inbox (triage status)
      return [queryKeys.inbox.all];

    case "triage:updates":
      // Triage changes affect the merged inbox view (triage status inline)
      return [queryKeys.inbox.all];

    case "reviews:updates":
      return getReviewInvalidationKeys(event);

    case "plans:updates":
      return getPlanInvalidationKeys(event);

    case "agents": {
      // Streaming progress events don't need cache invalidation —
      // they're consumed directly by components for real-time display.
      const streamingEvents = new Set([
        "message_start",
        "message_progress",
        "thinking_start",
        "thinking_progress",
        "tool_call_start",
        "tool_call_input",
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
      // Agent lifecycle events: the daemon broadcasts a single "agent_invocation"
      // event with data.status = "started" | "completed" | "failed".
      // These represent actual dispatch state changes — invalidate both agents
      // and sessions.
      if (event.event === "agent_invocation") {
        return [queryKeys.agents.all, queryKeys.sessions.all];
      }
      // Other agent-topic events (for example sync_state degraded/recovered
      // broadcasts) affect dispatch status but not per-session detail views.
      return [queryKeys.agents.all];
    }

    case "sessions":
      return [queryKeys.sessions.all];

    case "files:updates":
      // File watcher broadcasts are the fallback path for direct on-disk edits.
      // Map the changed file to the same query families the UI would invalidate
      // for route-driven entity updates so active views stay fresh without reload.
      return getFileUpdateInvalidationKeys(event);

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
function getDomainReadyInvalidationKeys(event: BroadcastEvent): readonly (readonly unknown[])[] {
  if (event.event !== "domain_ready") return [];

  const domain = (event.data as { domain?: string })?.domain;
  if (!domain) return [];

  return DOMAIN_QUERY_KEY_MAP[domain] ?? [];
}

let queryClientRef: QueryClient | null = null;
let handlersRegistered = false;

function patchTaskLikeRecord<T>(record: T, event: Partial<TaskUpdatedEventData>): T {
  if (!record || typeof record !== "object") return record;
  const task = record as Record<string, unknown>;
  const matches =
    (typeof event.ulid === "string" && task._ulid === event.ulid) ||
    (typeof event.ref === "string" &&
      Array.isArray(task.slugs) &&
      task.slugs.some((slug) => `@${slug}` === event.ref || slug === event.ref));
  if (!matches) return record;

  return {
    ...task,
    ...(typeof event.title === "string" ? { title: event.title } : {}),
    ...(typeof event.new_status === "string" ? { status: event.new_status } : {}),
  } as T;
}

function applyTaskEventFastPath(event: BroadcastEvent): void {
  if (!queryClientRef || event.event !== "task_updated") return;
  const data = event.data as Partial<TaskUpdatedEventData>;
  if (canonicalTaskRefs(data).length === 0) return;

  queryClientRef.setQueriesData(
    { queryKey: queryKeys.tasks.lists() as unknown[] },
    (old: unknown) => {
      if (!old || typeof old !== "object" || !Array.isArray((old as { items?: unknown[] }).items)) {
        return old;
      }

      let changed = false;
      const previous = old as { items: unknown[] };
      const items = previous.items.map((item) => {
        const next = patchTaskLikeRecord(item, data);
        if (next !== item) changed = true;
        return next;
      });

      return changed ? { ...previous, items } : old;
    },
  );

  for (const ref of canonicalTaskRefs(data)) {
    queryClientRef.setQueriesData(
      { queryKey: queryKeys.tasks.detail(ref) as unknown[] },
      (old: unknown) => patchTaskLikeRecord(old, data),
    );
  }
}

function handleBroadcastEvent(topic: string) {
  return (event: BroadcastEvent) => {
    if (!queryClientRef) return;

    if (topic === "tasks:updates") {
      applyTaskEventFastPath(event);
    }

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
