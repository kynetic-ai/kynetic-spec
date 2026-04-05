import { describe, expect, it, vi } from "vitest";
import { ConnectionStateManager } from "../packages/daemon/src/websocket/connection-state";
import type { ConnectionData, WebSocketConnection } from "../packages/daemon/src/websocket/types";

function createConnectionData(sessionId: string): ConnectionData {
  return {
    sessionId,
    topics: new Set<string>(),
    seq: 0,
    lastPing: undefined,
    lastPong: Date.now(),
    projectPath: "/tmp/project-a",
  };
}

function createMockSocket(): WebSocketConnection {
  return {
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
  };
}

describe("ConnectionStateManager", () => {
  // AC: @daemon-runtime-adapter ac-connection-state
  it("stores and retrieves per-connection state by websocket instance", () => {
    const manager = new ConnectionStateManager();
    const ws = createMockSocket();
    const state = createConnectionData("session-1");

    manager.init(ws, state);

    expect(manager.get(ws)).toBe(state);
    expect(manager.get(ws)?.sessionId).toBe("session-1");
  });

  // AC: @daemon-runtime-adapter ac-websocket-parity
  // AC: @daemon-runtime-adapter ac-connection-state
  it("removes tracked state explicitly during connection cleanup", () => {
    const manager = new ConnectionStateManager();
    const ws = createMockSocket();

    manager.init(ws, createConnectionData("session-2"));
    manager.remove(ws);

    expect(manager.get(ws)).toBeUndefined();
  });
});
