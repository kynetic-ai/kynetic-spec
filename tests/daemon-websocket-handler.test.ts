import { describe, it, expect, vi } from "vitest";
import { ConnectionStateManager } from "../packages/daemon/src/websocket/connection-state";
import { PubSubManager } from "../packages/daemon/src/websocket/pubsub";
import { WebSocketHandler } from "../packages/daemon/src/websocket/handler";
import type {
  ConnectionData,
  CommandAck,
  WebSocketConnection,
} from "../packages/daemon/src/websocket/types";

function createMockWebSocket(
  connectionState: ConnectionStateManager,
  sessionId: string,
): WebSocketConnection {
  const data: ConnectionData = {
    sessionId,
    topics: new Set<string>(),
    seq: 0,
    lastPing: undefined,
    lastPong: Date.now(),
    projectPath: "/tmp/ws-handler-test",
  };

  const ws: WebSocketConnection = {
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    getBufferedAmount: vi.fn(() => 0),
  };

  connectionState.init(ws, data);
  return ws;
}

describe("WebSocketHandler", () => {
  // AC: @trait-websocket-protocol ac-2
  it("accepts subscribe commands sent as Uint8Array payloads", async () => {
    const connectionState = new ConnectionStateManager();
    const pubsub = new PubSubManager(connectionState);
    const handler = new WebSocketHandler(pubsub);
    const ws = createMockWebSocket(connectionState, "session-uint8");
    pubsub.addConnection("session-uint8", ws);

    const commandBytes = new TextEncoder().encode(
      JSON.stringify({
        action: "subscribe",
        request_id: "sub-uint8",
        payload: { topics: ["agents"] },
      }),
    );

    await handler.handleMessage(ws, commandBytes);

    const sent = (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const ack = JSON.parse(String(sent)) as CommandAck;

    expect(ack.ack).toBe(true);
    expect(ack.success).toBe(true);
    expect(ack.request_id).toBe("sub-uint8");
    expect(connectionState.get(ws)?.topics.has("agents")).toBe(true);
  });

  // AC: @trait-websocket-protocol ac-2
  it("accepts subscribe commands sent as ArrayBuffer payloads", async () => {
    const connectionState = new ConnectionStateManager();
    const pubsub = new PubSubManager(connectionState);
    const handler = new WebSocketHandler(pubsub);
    const ws = createMockWebSocket(connectionState, "session-arraybuffer");
    pubsub.addConnection("session-arraybuffer", ws);

    const encoded = new TextEncoder().encode(
      JSON.stringify({
        action: "subscribe",
        request_id: "sub-arraybuffer",
        payload: { topics: ["tasks:updates"] },
      }),
    );
    const arrayBuffer = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    );

    await handler.handleMessage(ws, arrayBuffer);

    const sent = (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const ack = JSON.parse(String(sent)) as CommandAck;

    expect(ack.ack).toBe(true);
    expect(ack.success).toBe(true);
    expect(ack.request_id).toBe("sub-arraybuffer");
    expect(connectionState.get(ws)?.topics.has("tasks:updates")).toBe(true);
  });

  // AC: @trait-websocket-protocol ac-2
  it("accepts subscribe commands sent as Blob payloads", async () => {
    const connectionState = new ConnectionStateManager();
    const pubsub = new PubSubManager(connectionState);
    const handler = new WebSocketHandler(pubsub);
    const ws = createMockWebSocket(connectionState, "session-blob");
    pubsub.addConnection("session-blob", ws);

    const blob = new Blob(
      [
        JSON.stringify({
          action: "subscribe",
          request_id: "sub-blob",
          payload: { topics: ["agents"] },
        }),
      ],
      { type: "application/json" },
    );

    await handler.handleMessage(ws, blob);

    const sent = (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const ack = JSON.parse(String(sent)) as CommandAck;

    expect(ack.ack).toBe(true);
    expect(ack.success).toBe(true);
    expect(ack.request_id).toBe("sub-blob");
    expect(connectionState.get(ws)?.topics.has("agents")).toBe(true);
  });

  // AC: @trait-websocket-protocol ac-2
  it("accepts subscribe commands when runtime already parsed JSON into an object", async () => {
    const connectionState = new ConnectionStateManager();
    const pubsub = new PubSubManager(connectionState);
    const handler = new WebSocketHandler(pubsub);
    const ws = createMockWebSocket(connectionState, "session-object");
    pubsub.addConnection("session-object", ws);

    await handler.handleMessage(ws, {
      action: "subscribe",
      request_id: "sub-object",
      payload: { topics: ["agents"] },
    });

    const sent = (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const ack = JSON.parse(String(sent)) as CommandAck;

    expect(ack.ack).toBe(true);
    expect(ack.success).toBe(true);
    expect(ack.request_id).toBe("sub-object");
    expect(connectionState.get(ws)?.topics.has("agents")).toBe(true);
  });

  // AC: @trait-websocket-protocol ac-2
  it("subscribes successfully when message callback socket wrapper lacks sessionId", async () => {
    const connectionState = new ConnectionStateManager();
    const pubsub = new PubSubManager(connectionState);
    const handler = new WebSocketHandler(pubsub);
    const registeredWs = createMockWebSocket(connectionState, "session-context");
    pubsub.addConnection("session-context", registeredWs, "ctx-subscribe");

    const wrapperWs = {
      data: {
        id: "ctx-subscribe",
        topics: new Set<string>(),
        seq: 0,
        projectPath: "/tmp/ws-handler-test",
      },
      send: vi.fn(),
      close: vi.fn(),
      ping: vi.fn(),
      subscriptions: [],
    };

    await handler.handleMessage(wrapperWs, {
      action: "subscribe",
      request_id: "sub-context",
      payload: { topics: ["agents"] },
    });

    const sent = (wrapperWs.send as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const ack = JSON.parse(String(sent)) as CommandAck;

    expect(ack.ack).toBe(true);
    expect(ack.success).toBe(true);
    expect(ack.request_id).toBe("sub-context");
    expect(connectionState.get(registeredWs)?.topics.has("agents")).toBe(true);
  });

  // AC: @trait-websocket-protocol ac-2
  it("subscribes successfully when node runtime exposes only request.wsId in websocket context", async () => {
    const connectionState = new ConnectionStateManager();
    const pubsub = new PubSubManager(connectionState);
    const handler = new WebSocketHandler(pubsub);
    const registeredWs = createMockWebSocket(connectionState, "session-node-context");
    pubsub.addConnection("session-node-context", registeredWs, "node-ws-id");

    const wrapperWs = {
      data: {
        request: {
          wsId: "node-ws-id",
        },
      },
      send: vi.fn(),
      close: vi.fn(),
      ping: vi.fn(),
      subscriptions: [],
    };

    await handler.handleMessage(wrapperWs, {
      action: "subscribe",
      request_id: "sub-node-context",
      payload: { topics: ["files:updates"] },
    });

    const sent = (wrapperWs.send as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const ack = JSON.parse(String(sent)) as CommandAck;

    expect(ack.ack).toBe(true);
    expect(ack.success).toBe(true);
    expect(ack.request_id).toBe("sub-node-context");
    expect(connectionState.get(registeredWs)?.topics.has("files:updates")).toBe(true);
  });
});
