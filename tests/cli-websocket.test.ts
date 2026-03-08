/**
 * Tests for the WebSocket polyfill utility.
 *
 * Verifies that the CLI WebSocket utility provides a working WebSocket
 * constructor regardless of Node version (uses `ws` package as fallback
 * when globalThis.WebSocket is unavailable, i.e. Node < 22).
 *
 * Task: @01KK617H896Z5RHSCVA51G9QFQ
 * Spec: @cli-agent-commands
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { getWebSocketCtor } from "../src/cli/websocket.js";

describe("cli/websocket polyfill", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a WebSocket constructor", () => {
    const WS = getWebSocketCtor();
    expect(typeof WS).toBe("function");
  });

  it("prefers globalThis.WebSocket when available", () => {
    class FakeWS { constructor(_url: string) { /* noop */ } }
    vi.stubGlobal("WebSocket", FakeWS);

    const WS = getWebSocketCtor();
    expect(WS).toBe(FakeWS);
  });

  it("falls back to ws package when globalThis.WebSocket is undefined", () => {
    // Simulate Node < 22 where globalThis.WebSocket does not exist
    vi.stubGlobal("WebSocket", undefined);

    const WS = getWebSocketCtor();
    expect(typeof WS).toBe("function");
    // The fallback should NOT be the (now-undefined) global
    expect(WS).not.toBe(undefined);
  });

  it("can establish a real WebSocket connection via the ws fallback", async () => {
    // Force the fallback path to simulate Node < 22
    vi.stubGlobal("WebSocket", undefined);

    const { WebSocketServer } = await import("ws");
    const { createServer } = await import("node:http");

    const server = createServer();
    const wss = new WebSocketServer({ server });
    let serverReceived: string | undefined;

    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        serverReceived = data.toString();
        ws.send("pong");
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const WS = getWebSocketCtor();
      const ws = new WS(`ws://localhost:${port}`);
      const result = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), 5000);
        ws.onopen = () => {
          ws.send("ping");
        };
        ws.onmessage = (event: MessageEvent) => {
          clearTimeout(timeout);
          resolve(event.data as string);
          ws.close();
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket error"));
        };
      });

      expect(result).toBe("pong");
      expect(serverReceived).toBe("ping");
    } finally {
      wss.close();
      server.close();
    }
  });
});
