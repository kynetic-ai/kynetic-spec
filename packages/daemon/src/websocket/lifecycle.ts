import type { WebSocketConnection } from "./types.js";
import type { PubSubManager } from "./pubsub.js";
import { getWebSocketContextId } from "./context-id.js";

/**
 * Handle websocket close cleanup and logging with stable session identity.
 */
export function handleWebSocketClose(
  pubsub: PubSubManager,
  ws: WebSocketConnection,
  code: number,
  reason: string,
): string {
  const sessionId = pubsub.removeConnectionBySocket(ws, getWebSocketContextId(ws)) ?? "unknown";
  console.log(
    `[daemon] WebSocket client disconnected: ${sessionId} (code: ${code}, reason: ${reason})`,
  );
  return sessionId;
}
