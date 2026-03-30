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
  const connectionHandlers = new Map<string, Set<(event: any) => void>>();
  const subscribedTopics = new Set<string>();
  const connectionFns = {
    on: (topic: string, handler: (event: any) => void) => {
      if (!connectionHandlers.has(topic)) {
        connectionHandlers.set(topic, new Set());
      }
      connectionHandlers.get(topic)!.add(handler);
    },
    off: (topic: string, handler: (event: any) => void) => {
      connectionHandlers.get(topic)?.delete(handler);
    },
    subscribe: (topics: string[]) => {
      for (const t of topics) subscribedTopics.add(t);
    },
    unsubscribe: (topics: string[]) => {
      for (const t of topics) subscribedTopics.delete(t);
    },
  };
  return { connectionHandlers, subscribedTopics, connectionFns };
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
    invalidateQueries: vi.fn(),
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

// ── Tests ───────────────────────────────────────────────────────────────────

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

// AC: @task-fix-ws-invalidation-storm ac-1 (scoped invalidation for completion events)
// AC: @task-fix-ws-invalidation-storm ac-2 (lifecycle events still invalidate agents.all)
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
    for (const eventName of [
      "message_complete",
      "thinking_complete",
      "tool_call_complete",
    ]) {
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

  describe("unknown agent events produce no invalidation", () => {
    it("unrecognized event name does not invalidate any queries", () => {
      setupWsInvalidation(mockQueryClient);
      const event = makeBroadcastEvent("agents", "some_unknown_event", {
        session_id: "01TEST_SESSION_ID",
      });

      dispatchEvent("agents", event);

      expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
    });
  });
});
