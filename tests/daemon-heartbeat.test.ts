import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWebSocket } from "bun";
import { HeartbeatManager } from "../packages/daemon/src/websocket/heartbeat";
import { PubSubManager } from "../packages/daemon/src/websocket/pubsub";
import type { ConnectionData } from "../packages/daemon/src/websocket/types";

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
    const heartbeat = new HeartbeatManager();
    const pubsub = new PubSubManager();

    const idle = createHeartbeatSocket("idle", Date.now());
    pubsub.addConnection("idle", idle);

    heartbeat.start(pubsub.getAllConnections());

    vi.advanceTimersByTime(29_000);
    expect(idle.ping).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(idle.ping).toHaveBeenCalledTimes(1);
    expect(idle.data.lastPing).toBe(Date.now());
    expect(idle.data.lastPong).toBeUndefined();

    heartbeat.stop();
  });

  // AC: @trait-websocket-protocol ac-5
  // AC: @trait-websocket-protocol ac-7
  // AC: @api-contract ac-31
  it("closes the connection with code 1001 after 90 seconds without a pong", () => {
    const heartbeat = new HeartbeatManager();
    const pubsub = new PubSubManager();

    const idle = createHeartbeatSocket("idle", Date.now());
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

  // AC: @ws-disconnect-lifecycle-cleanup ac-3
  it("does not ping disconnected session after pubsub cleanup", () => {
    const heartbeat = new HeartbeatManager();
    const pubsub = new PubSubManager();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const active = createHeartbeatSocket("active");
    const disconnected = createHeartbeatSocket("disconnected");

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
  sessionId: string,
  lastPong = Date.now() - 31_000,
): ServerWebSocket<ConnectionData> {
  const data: ConnectionData = {
    sessionId,
    topics: new Set(),
    seq: 0,
    lastPing: undefined,
    lastPong,
    projectPath: "/tmp/project-a",
  };

  return {
    data,
    ping: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as ServerWebSocket<ConnectionData>;
}
