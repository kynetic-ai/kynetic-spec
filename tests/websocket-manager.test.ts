import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketManager } from "../packages/web-ui/src/lib/websocket/manager";

type MockCloseEvent = {
  code: number;
  reason: string;
};

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = MockWebSocket.CLOSING;
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({} as Event);
  }

  emitClose(event: MockCloseEvent): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(event as CloseEvent);
  }
}

describe("WebSocketManager reconnect handling", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // AC: @web-dashboard ac-28
  // AC: @trait-websocket-protocol ac-8
  it("keeps the latest socket active when an older socket closes", () => {
    const manager = new WebSocketManager({
      url: "ws://localhost:3456/ws",
      projectPath: "/tmp/project-a",
    });

    manager.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.emitOpen();
    expect(manager.isConnected()).toBe(true);

    manager.subscribe(["tasks"]);
    expect(firstSocket.sent).toHaveLength(1);

    manager.setProjectPath("/tmp/project-b");
    expect(MockWebSocket.instances).toHaveLength(2);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.emitOpen();
    expect(manager.isConnected()).toBe(true);

    // Old socket closes after the new one is already connected.
    firstSocket.emitClose({ code: 1000, reason: "Client disconnect" });
    vi.runOnlyPendingTimers();

    manager.subscribe(["inbox"]);
    expect(secondSocket.sent).toHaveLength(1);
    expect(manager.isConnected()).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  // AC: @web-dashboard ac-28
  // AC: @trait-websocket-protocol ac-7
  it("does not reconnect after intentional disconnect", () => {
    const manager = new WebSocketManager("ws://localhost:3456/ws");

    manager.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    expect(manager.isConnected()).toBe(true);

    manager.disconnect();
    socket.emitClose({ code: 1000, reason: "Client disconnect" });
    vi.runOnlyPendingTimers();

    expect(manager.getState()).toBe("disconnected");
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  // AC: @web-dashboard ac-28
  it("still reconnects after unexpected disconnects", () => {
    const manager = new WebSocketManager("ws://localhost:3456/ws");

    manager.connect();
    const socket = MockWebSocket.instances[0];
    socket.emitOpen();
    expect(manager.isConnected()).toBe(true);

    socket.emitClose({ code: 1006, reason: "network failure" });
    expect(manager.getState()).toBe("disconnected");

    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
