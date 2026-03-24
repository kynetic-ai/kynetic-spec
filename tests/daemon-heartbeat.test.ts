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

function createHeartbeatSocket(sessionId: string): ServerWebSocket<ConnectionData> {
  const thirtyOneSecondsAgo = Date.now() - 31_000;
  const data: ConnectionData = {
    sessionId,
    topics: new Set(),
    seq: 0,
    lastPing: undefined,
    lastPong: thirtyOneSecondsAgo,
    projectPath: "/tmp/project-a",
  };

  return {
    data,
    ping: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as ServerWebSocket<ConnectionData>;
}
