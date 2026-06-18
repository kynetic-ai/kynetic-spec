/**
 * WebSocket cache:status domain_ready → query invalidation tests.
 *
 * Verifies that when the daemon broadcasts a "cache:status" event with
 * event "domain_ready", the ws-invalidation handler invalidates the
 * correct TanStack Query keys for that domain.
 *
 * AC: @ui-data-freshness ac-warming-auto-transition — domain_ready events
 *   invalidate affected queries so the view transitions to real data
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { BroadcastEvent } from "@kynetic-ai/shared";

// ── Module mocks (hoisted) ──────────────────────────────────────────────────

// Hoisted mock state — accessible inside vi.mock factories
const { connectionHandlers, subscribedTopics, connectionFns } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(event: any) => void>>();
  const topics = new Set<string>();
  const fns = {
    on: (topic: string, handler: (event: any) => void) => {
      if (!handlers.has(topic)) {
        handlers.set(topic, new Set());
      }
      handlers.get(topic)!.add(handler);
    },
    off: (topic: string, handler: (event: any) => void) => {
      handlers.get(topic)?.delete(handler);
    },
    subscribe: (topicNames: string[]) => {
      for (const t of topicNames) topics.add(t);
    },
    unsubscribe: (topicNames: string[]) => {
      for (const t of topicNames) topics.delete(t);
    },
  };
  return { connectionHandlers: handlers, subscribedTopics: topics, connectionFns: fns };
});

vi.mock("$lib/stores/connection.svelte", () => connectionFns);
vi.mock("../../packages/web-ui/src/lib/stores/connection.svelte", () => connectionFns);

// Mock @tanstack/svelte-query so we don't need Svelte runtime
vi.mock("@tanstack/svelte-query", () => ({}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  setupWsInvalidation,
  teardownWsInvalidation,
} from "../../packages/web-ui/src/lib/query/ws-invalidation";
import { queryKeys } from "../../packages/web-ui/src/lib/query/keys";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBroadcastEvent(
  topic: string,
  event: string,
  data: Record<string, unknown>,
): BroadcastEvent {
  return {
    msg_id: "01TEST000000000000000000",
    seq: 1,
    timestamp: new Date().toISOString(),
    topic,
    event,
    data,
  };
}

function createMockQueryClient() {
  return {
    invalidateQueries: vi.fn<(options: { queryKey: readonly unknown[] }) => void>(),
    setQueriesData:
      vi.fn<
        (filters: { queryKey: readonly unknown[] }, updater: (old: unknown) => unknown) => void
      >(),
  } as any;
}

/** Dispatch an event through the handler registered for the given topic. */
function dispatchEvent(topic: string, event: BroadcastEvent) {
  const handlers = connectionHandlers.get(topic);
  if (handlers) {
    for (const handler of handlers) {
      handler(event);
    }
  }
}

function invalidatedKeys(mockQueryClient: ReturnType<typeof createMockQueryClient>) {
  return mockQueryClient.invalidateQueries.mock.calls.map(
    ([arg]: [{ queryKey: readonly unknown[] }]) => arg.queryKey,
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ws-invalidation targeted entity event handling", () => {
  let mockQueryClient: ReturnType<typeof createMockQueryClient>;

  beforeEach(() => {
    connectionHandlers.clear();
    subscribedTopics.clear();
    mockQueryClient = createMockQueryClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownWsInvalidation();
  });

  describe("topic subscription", () => {
    it("subscribes to entity and fallback topics without subscribing to command events", () => {
      setupWsInvalidation(mockQueryClient);

      expect(subscribedTopics.has("tasks:updates")).toBe(true);
      expect(subscribedTopics.has("items:updates")).toBe(true);
      expect(subscribedTopics.has("reviews:updates")).toBe(true);
      expect(subscribedTopics.has("plans:updates")).toBe(true);
      expect(subscribedTopics.has("files:updates")).toBe(true);
      expect(subscribedTopics.has("command")).toBe(false);
    });
  });

  // AC: @ui-targeted-event-consumption ac-1
  it("refreshes only the affected task entity and task views for a task event", () => {
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("tasks:updates", "task_updated", {
      ref: "@task-target",
      ulid: "01TASKTARGET0000000000000",
      action: "start",
      title: "Target task",
      old_status: "pending",
      new_status: "in_progress",
    });

    dispatchEvent("tasks:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.tasks.detail("01TASKTARGET0000000000000"),
      queryKeys.tasks.detail("@task-target"),
      queryKeys.tasks.lists(),
      queryKeys.tasks.summary(),
    ]);
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.items.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.reviews.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.validation.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.sessionContext.all,
    });
    expect(mockQueryClient.setQueriesData).toHaveBeenCalled();
  });

  // AC: @ui-targeted-event-consumption ac-1
  it("refreshes review-created list/detail/for-task keys without refetching task domains", () => {
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("reviews:updates", "review_created", {
      review_ulid: "01REVIEWTARGET00000000000",
      title: "Task review",
      subject_type: "task",
      subject_ref: "@task-target",
      subject: { type: "task", ref: "@task-target" },
    });

    dispatchEvent("reviews:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.reviews.detail("01REVIEWTARGET00000000000"),
      queryKeys.reviews.lists(),
      queryKeys.reviews.forTask("@task-target"),
    ]);
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.items.all,
    });
  });

  // AC: @ui-targeted-event-consumption ac-1
  it("refreshes affected item and validation views for a spec-item event only", () => {
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("items:updates", "spec_item_changed", {
      item_ulid: "01ITEMTARGET0000000000000",
      action: "changed",
      title: "Target item",
    });

    dispatchEvent("items:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.items.detail("01ITEMTARGET0000000000000"),
      queryKeys.items.lists(),
      queryKeys.validation.all,
    ]);
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.reviews.all,
    });
  });

  // AC: @ui-targeted-event-consumption ac-1
  it("refreshes affected plan resource queries without touching other domains", () => {
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("plans:updates", "plan_resource_changed", {
      plan_ulid: "01PLANTARGET0000000000000",
      resource_id: "diagram",
      action: "added",
    });

    dispatchEvent("plans:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.plans.detail("01PLANTARGET0000000000000"),
      queryKeys.plans.content("01PLANTARGET0000000000000"),
      queryKeys.plans.lists(),
    ]);
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.items.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.reviews.all,
    });
  });

  // AC: @ui-targeted-event-consumption ac-2
  it("starts fallback file refresh immediately and does not schedule fixed-delay refreshes", () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("files:updates", "file_changed", {
      ref: "project.tasks.yaml",
    });

    dispatchEvent("files:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.tasks.lists(),
      queryKeys.tasks.summary(),
    ]);
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  // AC: @ui-targeted-event-consumption ac-4
  it("maps non-daemon task file changes to a single immediate task-domain refresh", () => {
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("files:updates", "file_changed", {
      ref: "tasks/01TASKTARGET0000000000000/task.yaml",
    });

    dispatchEvent("files:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.tasks.detail("01TASKTARGET0000000000000"),
      queryKeys.tasks.lists(),
      queryKeys.tasks.summary(),
    ]);
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.validation.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.sessionContext.all,
    });
  });

  // AC: @ui-targeted-event-consumption ac-4
  it("maps non-daemon plan folder changes to a single immediate affected-plan refresh", () => {
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("files:updates", "file_changed", {
      ref: "plans/01PLANTARGET0000000000000/resources/diagram.png",
    });

    dispatchEvent("files:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.plans.detail("01PLANTARGET0000000000000"),
      queryKeys.plans.content("01PLANTARGET0000000000000"),
      queryKeys.plans.lists(),
    ]);
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.items.all,
    });
  });

  // AC: @ui-targeted-event-consumption ac-4
  it("maps non-daemon review folder changes to a single immediate affected-review refresh", () => {
    setupWsInvalidation(mockQueryClient);
    const event = makeBroadcastEvent("files:updates", "file_changed", {
      ref: "reviews/01REVIEWTARGET00000000000/review.yaml",
    });

    dispatchEvent("files:updates", event);

    expect(invalidatedKeys(mockQueryClient)).toEqual([
      queryKeys.reviews.detail("01REVIEWTARGET00000000000"),
      queryKeys.reviews.content("01REVIEWTARGET00000000000"),
      queryKeys.reviews.lists(),
    ]);
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.all,
    });
    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: queryKeys.items.all,
    });
  });
});

describe("ws-invalidation cache:status handling", () => {
  let mockQueryClient: ReturnType<typeof createMockQueryClient>;

  beforeEach(() => {
    // Reset state
    connectionHandlers.clear();
    subscribedTopics.clear();

    mockQueryClient = createMockQueryClient();
  });

  afterEach(() => {
    teardownWsInvalidation();
  });

  // AC: @ui-data-freshness ac-warming-auto-transition
  describe("topic subscription", () => {
    it("subscribes to cache:status topic on setup", () => {
      setupWsInvalidation(mockQueryClient);

      expect(subscribedTopics.has("cache:status")).toBe(true);
    });

    it("registers a handler for cache:status topic", () => {
      setupWsInvalidation(mockQueryClient);

      expect(connectionHandlers.has("cache:status")).toBe(true);
      expect(connectionHandlers.get("cache:status")!.size).toBe(1);
    });

    it("unsubscribes from cache:status on teardown", () => {
      setupWsInvalidation(mockQueryClient);
      teardownWsInvalidation();

      expect(subscribedTopics.has("cache:status")).toBe(false);
    });
  });

  // AC: @ui-data-freshness ac-warming-auto-transition
  describe("domain_ready event → query invalidation", () => {
    it("invalidates tasks queries when tasks domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "tasks",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.tasks.all,
      });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.validation.all,
      });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.sessionContext.all,
      });
    });

    it("invalidates items queries when items domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "items",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.items.all,
      });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.validation.all,
      });
    });

    it("invalidates inbox queries when inbox domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "inbox",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.inbox.all,
      });
    });

    it("invalidates inbox queries when triage domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "triage",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.inbox.all,
      });
    });

    it("invalidates reviews queries when reviews domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "reviews",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.reviews.all,
      });
    });

    it("invalidates plans queries when plans domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "plans",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.plans.all,
      });
    });

    it("invalidates sessions queries when sessions domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "sessions",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.sessions.all,
      });
    });

    it("invalidates meta-related queries when meta domain is ready", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "meta",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.settings.all,
      });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.workflows.all,
      });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.observations.all,
      });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.automation.all,
      });
      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.sessionContext.all,
      });
    });
  });

  // AC: @ui-data-freshness ac-warming-auto-transition
  describe("edge cases", () => {
    it("does not invalidate for unknown domain", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        domain: "unknown_domain",
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it("does not invalidate for non-domain_ready cache:status events", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "some_other_event", {
        domain: "tasks",
        projectPath: "/test/project",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
    });

    it("does not invalidate when event data has no domain field", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("cache:status", "domain_ready", {
        projectPath: "/test/project",
        previousState: "loading",
      });

      dispatchEvent("cache:status", event);

      expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
    });
  });
});

// AC: @ui-data-freshness ac-3 — WebSocket events invalidate affected cached data
// AC: @ui-data-freshness ac-4 — Agent status stays fresh via event-driven invalidation
describe("ws-invalidation agents topic scoping", () => {
  let mockQueryClient: ReturnType<typeof createMockQueryClient>;

  beforeEach(() => {
    connectionHandlers.clear();
    subscribedTopics.clear();
    mockQueryClient = createMockQueryClient();
  });

  afterEach(() => {
    teardownWsInvalidation();
  });

  describe("completion events only invalidate sessions, not agents", () => {
    for (const eventName of ["message_complete", "thinking_complete", "tool_call_complete"]) {
      it(`${eventName} with session_id invalidates sessions.all but NOT agents.all`, () => {
        setupWsInvalidation(mockQueryClient);
        const event = makeBroadcastEvent("agents", eventName, {
          session_id: "01TEST_SESSION_ID",
          invocation_id: "01TEST_INVOCATION",
        });

        dispatchEvent("agents", event);

        // Should invalidate sessions
        expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.sessions.all,
        });
        // Should NOT invalidate agents
        expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
          queryKey: queryKeys.agents.all,
        });
      });

      it(`${eventName} without session_id does not invalidate agents.all`, () => {
        setupWsInvalidation(mockQueryClient);
        const event = makeBroadcastEvent("agents", eventName, {
          invocation_id: "01TEST_INVOCATION",
        });

        dispatchEvent("agents", event);

        // Without session_id, should still not invalidate agents.all
        expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
          queryKey: queryKeys.agents.all,
        });
      });
    }
  });

  describe("streaming progress events produce no invalidation", () => {
    for (const eventName of [
      "message_start",
      "message_progress",
      "thinking_start",
      "thinking_progress",
      "tool_call_start",
      "tool_call_input",
    ]) {
      it(`${eventName} does not invalidate any queries`, () => {
        setupWsInvalidation(mockQueryClient);
        const event = makeBroadcastEvent("agents", eventName, {
          session_id: "01TEST_SESSION_ID",
        });

        dispatchEvent("agents", event);

        expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
      });
    }
  });

  describe("dispatch status events invalidate agent queries without touching sessions", () => {
    it("sync_state invalidates agents.all but not sessions.all", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("agents", "sync_state", {
        degraded: true,
        reason: "integration target diverged",
        enteredAt: new Date().toISOString(),
      });

      dispatchEvent("agents", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.agents.all,
      });
      expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
        queryKey: queryKeys.sessions.all,
      });
    });

    it("unknown non-stream agents events conservatively invalidate agents.all only", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("agents", "some_future_status_event", {
        dispatch_enabled: false,
      });

      dispatchEvent("agents", event);

      expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.agents.all,
      });
      expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalledWith({
        queryKey: queryKeys.sessions.all,
      });
    });
  });

  describe("agent lifecycle events still invalidate agents.all", () => {
    // The daemon broadcasts a single "agent_invocation" event with data.status
    // carrying "started", "completed", or "failed" — not separate event names.
    for (const status of ["started", "completed", "failed"]) {
      it(`agent_invocation with status="${status}" invalidates both agents.all and sessions.all`, () => {
        setupWsInvalidation(mockQueryClient);
        const event = makeBroadcastEvent("agents", "agent_invocation", {
          session_id: "01TEST_SESSION_ID",
          agent_id: "task-worker",
          task_id: "@task-auth",
          task_title: "Implement authentication",
          status,
          timestamp: Date.now(),
        });

        dispatchEvent("agents", event);

        expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.agents.all,
        });
        expect(mockQueryClient.invalidateQueries).toHaveBeenCalledWith({
          queryKey: queryKeys.sessions.all,
        });
      });
    }
  });
});
