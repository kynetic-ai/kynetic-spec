/**
 * WebSocket constructor that works on Node 18+.
 *
 * Node 22+ ships a global WebSocket. Older versions need the `ws` package.
 * The fallback is loaded eagerly; the global is checked at call time so that
 * test stubs via `vi.stubGlobal("WebSocket", ...)` are respected.
 */

import WsDefault from "ws";

const WsFallback = WsDefault as unknown as typeof WebSocket;

export function getWebSocketCtor(): typeof WebSocket {
  return typeof globalThis.WebSocket !== "undefined"
    ? globalThis.WebSocket
    : WsFallback;
}
