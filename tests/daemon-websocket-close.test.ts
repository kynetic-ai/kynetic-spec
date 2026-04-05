import { describe, it, expect, vi } from "vitest";
import { ConnectionStateManager } from "../packages/daemon/src/websocket/connection-state";
import { handleWebSocketClose } from "../packages/daemon/src/websocket/lifecycle";
import { PubSubManager } from "../packages/daemon/src/websocket/pubsub";
import type { ConnectionData, WebSocketConnection } from "../packages/daemon/src/websocket/types";

describe("WebSocket close handler", () => {
  // AC: @ws-disconnect-lifecycle-cleanup ac-2
  it("logs stable session id and removes tracked connection for close code 1006", () => {
    const connectionState = new ConnectionStateManager();
    const pubsub = new PubSubManager(connectionState);
    const ws = createMockWebSocket(connectionState, "session-1006");
    const closeWsWrapper = {
      data: { id: "ctx-1006" },
      subscriptions: [],
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    pubsub.addConnection("session-1006", ws, "ctx-1006");
    const removedSessionId = handleWebSocketClose(pubsub, closeWsWrapper, 1006, "abnormal closure");
    const logged = logSpy.mock.calls.map(([message]) => String(message)).join("\n");

    expect(removedSessionId).toBe("session-1006");
    expect(pubsub.getConnectionCount()).toBe(0);
    expect(logged).toContain("session-1006");
    expect(logged).toContain("code: 1006");
    expect(logged).not.toContain("undefined");
    expect(connectionState.get(ws)).toBeUndefined();
  });
});

function createMockWebSocket(
  connectionState: ConnectionStateManager,
  sessionId: string,
): WebSocketConnection {
  const data: ConnectionData = {
    sessionId,
    topics: new Set(),
    seq: 0,
    lastPing: undefined,
    lastPong: Date.now(),
    projectPath: "/tmp/project-a",
  };

  const ws: WebSocketConnection = {
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
  };

  connectionState.init(ws, data);
  return ws;
}
