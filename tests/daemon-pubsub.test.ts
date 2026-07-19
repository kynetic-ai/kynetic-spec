import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConnectionStateManager } from "../packages/daemon/src/websocket/connection-state";
import { PubSubManager } from "../packages/daemon/src/websocket/pubsub";
import type { ConnectionData, WebSocketConnection } from "../packages/daemon/src/websocket/types";
import type {
  TaskUpdatedEventData,
  InboxItemCreatedEventData,
  AgentInvocationEventData,
  MessageProgressEventData,
} from "../packages/shared/src/websocket";

describe("PubSubManager", () => {
  let manager: PubSubManager;
  let connectionState: ConnectionStateManager;

  beforeEach(() => {
    connectionState = new ConnectionStateManager();
    manager = new PubSubManager(connectionState);
  });

  describe("Broadcast Filtering", () => {
    // AC: @multi-directory-daemon ac-18
    it("should only send events to connections with matching projectPath", () => {
      const projectA = "/tmp/project-a";
      const projectB = "/tmp/project-b";

      // Mock WebSocket connections
      const wsA1 = createMockWebSocket(connectionState, "conn-a1", projectA, ["tasks:updates"]);
      const wsA2 = createMockWebSocket(connectionState, "conn-a2", projectA, ["tasks:updates"]);
      const wsB1 = createMockWebSocket(connectionState, "conn-b1", projectB, ["tasks:updates"]);

      manager.addConnection("conn-a1", wsA1);
      manager.addConnection("conn-a2", wsA2);
      manager.addConnection("conn-b1", wsB1);

      // Broadcast event scoped to project A
      manager.broadcast("tasks:updates", "task_updated", { ref: "task-1" }, projectA);

      // Only project A connections should receive the event
      expect(wsA1.send).toHaveBeenCalledOnce();
      expect(wsA2.send).toHaveBeenCalledOnce();
      expect(wsB1.send).not.toHaveBeenCalled();
    });

    // AC: @multi-directory-daemon ac-18
    it("should not send events when projectPath does not match", () => {
      const projectA = "/tmp/project-a";
      const projectB = "/tmp/project-b";

      const wsA = createMockWebSocket(connectionState, "conn-a", projectA, ["tasks:updates"]);
      const wsB = createMockWebSocket(connectionState, "conn-b", projectB, ["tasks:updates"]);

      manager.addConnection("conn-a", wsA);
      manager.addConnection("conn-b", wsB);

      // Broadcast to project B
      manager.broadcast("tasks:updates", "task_updated", { ref: "task-1" }, projectB);

      // Only project B should receive
      expect(wsA.send).not.toHaveBeenCalled();
      expect(wsB.send).toHaveBeenCalledOnce();
    });

    // AC: @multi-directory-daemon ac-18
    it("should broadcast to all subscribed connections when projectPath is undefined", () => {
      const projectA = "/tmp/project-a";
      const projectB = "/tmp/project-b";

      const wsA = createMockWebSocket(connectionState, "conn-a", projectA, ["tasks:updates"]);
      const wsB = createMockWebSocket(connectionState, "conn-b", projectB, ["tasks:updates"]);

      manager.addConnection("conn-a", wsA);
      manager.addConnection("conn-b", wsB);

      // Broadcast without project filter (legacy behavior)
      manager.broadcast("tasks:updates", "task_updated", { ref: "task-1" });

      // Both connections should receive
      expect(wsA.send).toHaveBeenCalledOnce();
      expect(wsB.send).toHaveBeenCalledOnce();
    });

    it("should respect topic subscription filtering alongside project filtering", () => {
      const projectA = "/tmp/project-a";

      const ws1 = createMockWebSocket(connectionState, "conn-1", projectA, ["tasks:updates"]);
      const ws2 = createMockWebSocket(connectionState, "conn-2", projectA, ["inbox:updates"]);

      manager.addConnection("conn-1", ws1);
      manager.addConnection("conn-2", ws2);

      // Broadcast task event to project A
      manager.broadcast("tasks:updates", "task_updated", { ref: "task-1" }, projectA);

      // Only conn-1 (subscribed to tasks:updates) should receive
      expect(ws1.send).toHaveBeenCalledOnce();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it("should handle connections with no projectPath (pre-multi-project)", () => {
      const projectA = "/tmp/project-a";

      const wsLegacy = createMockWebSocket(connectionState, "conn-legacy", undefined, [
        "tasks:updates",
      ]);
      const wsNew = createMockWebSocket(connectionState, "conn-new", projectA, ["tasks:updates"]);

      manager.addConnection("conn-legacy", wsLegacy);
      manager.addConnection("conn-new", wsNew);

      // Broadcast to project A
      manager.broadcast("tasks:updates", "task_updated", { ref: "task-1" }, projectA);

      // Only new connection (with matching projectPath) should receive
      expect(wsLegacy.send).not.toHaveBeenCalled();
      expect(wsNew.send).toHaveBeenCalledOnce();
    });

    it("should include correct message structure with sequence and metadata", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["tasks:updates"]);

      manager.addConnection("conn-1", ws);

      manager.broadcast(
        "tasks:updates",
        "task_updated",
        { ref: "task-1", action: "start" },
        projectA,
      );

      expect(ws.send).toHaveBeenCalledOnce();
      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);

      expect(sentMessage).toMatchObject({
        event: "task_updated",
        data: { ref: "task-1", action: "start" },
      });
      expect(sentMessage).toHaveProperty("msg_id");
      expect(sentMessage).toHaveProperty("seq");
      expect(sentMessage).toHaveProperty("timestamp");
      expect(sentMessage).toHaveProperty("topic", "tasks:updates");
    });

    it("should increment sequence number per connection", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["tasks:updates"]);

      manager.addConnection("conn-1", ws);

      manager.broadcast("tasks:updates", "event1", {}, projectA);
      manager.broadcast("tasks:updates", "event2", {}, projectA);
      manager.broadcast("tasks:updates", "event3", {}, projectA);

      expect(ws.send).toHaveBeenCalledTimes(3);

      const messages = (ws.send as any).mock.calls.map((call: any[]) => JSON.parse(call[0]));

      expect(messages[0].seq).toBe(1);
      expect(messages[1].seq).toBe(2);
      expect(messages[2].seq).toBe(3);
    });

    // AC: @daemon-runtime-adapter ac-backpressure-degradation
    // AC: @daemon-runtime-adapter ac-websocket-parity
    it("broadcasts when buffered amount queries are unavailable", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["tasks:updates"]);
      delete ws.getBufferedAmount;

      manager.addConnection("conn-1", ws);
      manager.broadcast("tasks:updates", "task_updated", { ref: "task-1" }, projectA);

      expect(ws.send).toHaveBeenCalledOnce();
      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(sentMessage.event).toBe("task_updated");
      expect(sentMessage.data).toMatchObject({ ref: "task-1" });
    });
  });

  // AC: @ui-api-aggregation ac-4
  describe("Enriched Broadcast Payloads", () => {
    it("task_updated payload includes title and old/new status for state transitions", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["tasks:updates"]);
      manager.addConnection("conn-1", ws);

      const payload: TaskUpdatedEventData = {
        ref: "@task-auth",
        ulid: "01ABC123",
        action: "start",
        title: "Implement authentication",
        old_status: "pending",
        new_status: "in_progress",
      };

      manager.broadcast("tasks:updates", "task_updated", payload, projectA);

      expect(ws.send).toHaveBeenCalledOnce();
      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);

      expect(sentMessage.data).toMatchObject({
        ref: "@task-auth",
        ulid: "01ABC123",
        action: "start",
        title: "Implement authentication",
        old_status: "pending",
        new_status: "in_progress",
      });
    });

    it("task_updated note_added payload has null old/new status", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["tasks:updates"]);
      manager.addConnection("conn-1", ws);

      const payload: TaskUpdatedEventData = {
        ref: "@task-auth",
        ulid: "01ABC123",
        action: "note_added",
        title: "Implement authentication",
        old_status: null,
        new_status: null,
        note_ulid: "01NOTE456",
      };

      manager.broadcast("tasks:updates", "task_updated", payload, projectA);

      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(sentMessage.data.title).toBe("Implement authentication");
      expect(sentMessage.data.old_status).toBeNull();
      expect(sentMessage.data.new_status).toBeNull();
      expect(sentMessage.data.note_ulid).toBe("01NOTE456");
    });

    it("inbox_item_created payload includes full item data", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["inbox:updates"]);
      manager.addConnection("conn-1", ws);

      const payload: InboxItemCreatedEventData = {
        ulid: "01INBOX789",
        text: "New feature idea",
        tags: ["mvp", "cli"],
        added_by: "user@example.com",
        created_at: "2026-03-14T00:00:00.000Z",
      };

      manager.broadcast("inbox:updates", "inbox_item_created", payload, projectA);

      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(sentMessage.data).toMatchObject({
        ulid: "01INBOX789",
        text: "New feature idea",
        tags: ["mvp", "cli"],
        added_by: "user@example.com",
        created_at: "2026-03-14T00:00:00.000Z",
      });
    });

    it("agent_invocation payload includes task_title", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["agents"]);
      manager.addConnection("conn-1", ws);

      const payload: AgentInvocationEventData = {
        session_id: "sess-1",
        agent_id: "task-worker",
        task_id: "@task-auth",
        task_title: "Implement authentication",
        status: "started",
        timestamp: 1710374400000,
      };

      manager.broadcast("agents", "agent_invocation", payload, projectA);

      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(sentMessage.data.task_title).toBe("Implement authentication");
      expect(sentMessage.data.task_id).toBe("@task-auth");
    });

    // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
    it("agent_invocation payload carries runner and resolved_adapter when present", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["agents"]);
      manager.addConnection("conn-1", ws);

      const payload: AgentInvocationEventData = {
        session_id: "sess-1",
        agent_id: "task-worker",
        task_id: "@task-auth",
        task_title: "Implement authentication",
        status: "started",
        timestamp: 1710374400000,
        runner: "production",
        resolved_adapter: "claude-code",
      };

      manager.broadcast("agents", "agent_invocation", payload, projectA);

      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(sentMessage.data.runner).toBe("production");
      expect(sentMessage.data.resolved_adapter).toBe("claude-code");
    });

    it("agent_invocation payload has null task_title when no task", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["agents"]);
      manager.addConnection("conn-1", ws);

      const payload: AgentInvocationEventData = {
        session_id: "sess-1",
        agent_id: "task-worker",
        task_id: null,
        task_title: null,
        status: "started",
        timestamp: 1710374400000,
      };

      manager.broadcast("agents", "agent_invocation", payload, projectA);

      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(sentMessage.data.task_id).toBeNull();
      expect(sentMessage.data.task_title).toBeNull();
    });

    it("message_progress payload includes task_title", () => {
      const projectA = "/tmp/project-a";
      const ws = createMockWebSocket(connectionState, "conn-1", projectA, ["agents"]);
      manager.addConnection("conn-1", ws);

      const payload: MessageProgressEventData = {
        type: "message_progress",
        session_id: "sess-1",
        agent_id: "task-worker",
        task_id: "@task-auth",
        task_title: "Implement authentication",
        text: "Working on it...",
        timestamp: 1710374400000,
      };

      manager.broadcast("agents", "message_progress", payload, projectA);

      const sentMessage = JSON.parse((ws.send as any).mock.calls[0][0]);
      expect(sentMessage.data.task_title).toBe("Implement authentication");
      expect(sentMessage.data.text).toBe("Working on it...");
    });
  });

  describe("Connection Management", () => {
    // AC: @daemon-runtime-adapter ac-connection-state
    // AC: @daemon-runtime-adapter ac-websocket-parity
    it("hydrates managed connection state from legacy websocket data during registration", () => {
      const legacyData: ConnectionData = {
        sessionId: "legacy-conn",
        topics: new Set(["tasks:updates"]),
        seq: 0,
        lastPing: undefined,
        lastPong: Date.now(),
        projectPath: "/tmp/project-a",
      };
      const ws: WebSocketConnection = {
        data: legacyData,
        send: vi.fn(),
        close: vi.fn(),
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
      };

      manager.addConnection("legacy-conn", ws);
      manager.broadcast("tasks:updates", "task_updated", { ref: "task-1" }, "/tmp/project-a");

      expect(manager.getConnectionState(ws)).toBe(legacyData);
      expect(ws.send).toHaveBeenCalledOnce();
    });

    // AC: @ws-disconnect-lifecycle-cleanup ac-1
    it("should track connection count", () => {
      const ws1 = createMockWebSocket(connectionState, "conn-1", "/tmp/project-a", []);
      const ws2 = createMockWebSocket(connectionState, "conn-2", "/tmp/project-b", []);

      expect(manager.getConnectionCount()).toBe(0);

      manager.addConnection("conn-1", ws1);
      expect(manager.getConnectionCount()).toBe(1);

      manager.addConnection("conn-2", ws2);
      expect(manager.getConnectionCount()).toBe(2);

      manager.removeConnection("conn-1");
      expect(manager.getConnectionCount()).toBe(1);
    });

    // AC: @ws-disconnect-lifecycle-cleanup ac-2
    it("removes connection by socket using stable session mapping when connection state is missing", () => {
      const ws = createMockWebSocket(connectionState, "conn-1", "/tmp/project-a", [
        "tasks:updates",
      ]);
      manager.addConnection("conn-1", ws);

      // Simulate close callback race where data no longer has sessionId.
      connectionState.remove(ws);

      const removedSessionId = manager.removeConnectionBySocket(ws);

      expect(removedSessionId).toBe("conn-1");
      expect(manager.getConnectionCount()).toBe(0);
      expect(manager.getSessionIdBySocket(ws)).toBeUndefined();
    });

    it("resolves session id from internal subscription topic when close callback socket wrapper differs", () => {
      const ws = createMockWebSocket(connectionState, "conn-1", "/tmp/project-a", [
        "tasks:updates",
      ]);
      manager.addConnection("conn-1", ws);

      const closeSocketWrapper = {
        data: {},
        subscriptions: ["__kspec_session:conn-1"],
      };

      const removedSessionId = manager.removeConnectionBySocket(closeSocketWrapper);

      expect(removedSessionId).toBe("conn-1");
      expect(manager.getConnectionCount()).toBe(0);
    });

    it("resolves session id from websocket context id when close callback loses data/subscriptions", () => {
      const ws = createMockWebSocket(connectionState, "conn-1", "/tmp/project-a", [
        "tasks:updates",
      ]);
      manager.addConnection("conn-1", ws, "ctx-1");

      const closeSocketWrapper = {
        data: {},
        subscriptions: [],
      };

      const removedSessionId = manager.removeConnectionBySocket(closeSocketWrapper, "ctx-1");

      expect(removedSessionId).toBe("conn-1");
      expect(manager.getConnectionCount()).toBe(0);
    });

    it("should clean up connection when removed", () => {
      const ws = createMockWebSocket(connectionState, "conn-1", "/tmp/project-a", [
        "tasks:updates",
      ]);

      manager.addConnection("conn-1", ws);
      manager.broadcast("tasks:updates", "event1", {}, "/tmp/project-a");
      expect(ws.send).toHaveBeenCalledOnce();

      manager.removeConnection("conn-1");
      manager.broadcast("tasks:updates", "event2", {}, "/tmp/project-a");

      // Should still only be called once (from before removal)
      expect(ws.send).toHaveBeenCalledOnce();
    });
  });
});

// Helper to create mock WebSocket with connection state
function createMockWebSocket(
  connectionState: ConnectionStateManager,
  sessionId: string,
  projectPath: string | undefined,
  topics: string[],
): WebSocketConnection {
  const data: ConnectionData = {
    sessionId,
    topics: new Set(topics),
    seq: 0,
    lastPing: undefined,
    lastPong: Date.now(),
    projectPath: projectPath as any, // Type assertion for test
  };

  const activeSubscriptions = new Set<string>();
  const ws: WebSocketConnection = {
    send: vi.fn(),
    close: vi.fn(),
    getBufferedAmount: vi.fn(() => 0),
    subscribe: vi.fn((topic: string) => {
      activeSubscriptions.add(topic);
    }),
    unsubscribe: vi.fn((topic: string) => {
      activeSubscriptions.delete(topic);
    }),
    get subscriptions() {
      return Array.from(activeSubscriptions);
    },
  };

  connectionState.init(ws, data);
  return ws;
}
