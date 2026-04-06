import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStateManager } from "../packages/daemon/src/websocket/connection-state";
import { HeartbeatManager } from "../packages/daemon/src/websocket/heartbeat";
import { PubSubManager } from "../packages/daemon/src/websocket/pubsub";
import type { ConnectionData, WebSocketConnection } from "../packages/daemon/src/websocket/types";

describe("HeartbeatManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-03T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // AC: @trait-websocket-protocol ac-4
  it("sends a websocket ping after 30 seconds of inactivity", () => {
    const connectionState = new ConnectionStateManager();
    const heartbeat = new HeartbeatManager(connectionState);
    const pubsub = new PubSubManager(connectionState);

    const idle = createHeartbeatSocket(connectionState, "idle", Date.now());
    pubsub.addConnection("idle", idle);

    heartbeat.start(pubsub.getAllConnections());

    vi.advanceTimersByTime(29_000);
    expect(idle.ping).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(idle.ping).toHaveBeenCalledTimes(1);
    expect(connectionState.get(idle)?.lastPing).toBe(Date.now());
    expect(connectionState.get(idle)?.lastPong).toBeUndefined();

    heartbeat.stop();
  });

  // AC: @trait-websocket-protocol ac-5
  // AC: @trait-websocket-protocol ac-7
  // AC: @api-contract ac-31
  it("closes the connection with code 1001 after 90 seconds without a pong", () => {
    const connectionState = new ConnectionStateManager();
    const heartbeat = new HeartbeatManager(connectionState);
    const pubsub = new PubSubManager(connectionState);

    const idle = createHeartbeatSocket(connectionState, "idle", Date.now());
    pubsub.addConnection("idle", idle);

    heartbeat.start(pubsub.getAllConnections());

    vi.advanceTimersByTime(30_000);
    expect(idle.ping).toHaveBeenCalledTimes(1);
    expect(idle.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(90_000);
    expect(idle.ping).toHaveBeenCalledTimes(1);
    expect(idle.close).toHaveBeenCalledWith(1001, "Ping timeout");

    heartbeat.stop();
  });

  // AC: @daemon-runtime-adapter ac-heartbeat-degradation
  // AC: @daemon-runtime-adapter ac-websocket-parity
  it("skips heartbeat ping when the websocket runtime does not expose ping()", () => {
    const connectionState = new ConnectionStateManager();
    const heartbeat = new HeartbeatManager(connectionState);
    const pubsub = new PubSubManager(connectionState);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const idle = createHeartbeatSocket(connectionState, "idle", Date.now());
    delete idle.ping;
    pubsub.addConnection("idle", idle);

    heartbeat.start(pubsub.getAllConnections());
    vi.advanceTimersByTime(30_000);

    expect(connectionState.get(idle)?.lastPing).toBeUndefined();
    expect(connectionState.get(idle)?.lastPong).toBe(Date.now() - 30_000);
    expect(idle.close).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  // AC: @daemon-runtime-adapter ac-heartbeat-degradation
  it("does not reap idle connections when ping was never sent", () => {
    const connectionState = new ConnectionStateManager();
    const heartbeat = new HeartbeatManager(connectionState);
    const pubsub = new PubSubManager(connectionState);

    const idle = createHeartbeatSocket(connectionState, "idle", Date.now());
    delete idle.ping;
    pubsub.addConnection("idle", idle);

    heartbeat.start(pubsub.getAllConnections());

    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(90_000);

    expect(connectionState.get(idle)?.lastPing).toBeUndefined();
    expect(connectionState.get(idle)?.lastPong).toBe(Date.now() - 120_000);
    expect(idle.close).not.toHaveBeenCalled();

    heartbeat.stop();
  });

  // AC: @ws-disconnect-lifecycle-cleanup ac-3
  it("does not ping disconnected session after pubsub cleanup", () => {
    const connectionState = new ConnectionStateManager();
    const heartbeat = new HeartbeatManager(connectionState);
    const pubsub = new PubSubManager(connectionState);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const active = createHeartbeatSocket(connectionState, "active");
    const disconnected = createHeartbeatSocket(connectionState, "disconnected");

    pubsub.addConnection("active", active);
    pubsub.addConnection("disconnected", disconnected);

    heartbeat.start(pubsub.getAllConnections());

    // Simulate close callback cleanup before next heartbeat tick.
    pubsub.removeConnectionBySocket(disconnected);

    vi.advanceTimersByTime(30_000);

    expect(active.ping).toHaveBeenCalledTimes(1);
    expect(disconnected.ping).not.toHaveBeenCalled();
    expect(debugSpy.mock.calls.some(([msg]) => String(msg).includes("disconnected"))).toBe(false);

    heartbeat.stop();
  });
});

function createHeartbeatSocket(
  connectionState: ConnectionStateManager,
  sessionId: string,
  lastPong = Date.now() - 31_000,
): WebSocketConnection {
  const data: ConnectionData = {
    sessionId,
    topics: new Set(),
    seq: 0,
    lastPing: undefined,
    lastPong,
    projectPath: "/tmp/project-a",
  };

  const ws: WebSocketConnection = {
    ping: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
  };

  connectionState.init(ws, data);
  return ws;
}
