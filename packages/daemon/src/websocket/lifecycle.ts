import type { ServerWebSocket } from "bun";
import type { ConnectionData } from "./types";
import type { PubSubManager } from "./pubsub";

/**
 * Handle websocket close cleanup and logging with stable session identity.
 */
export function handleWebSocketClose(
  pubsub: PubSubManager,
  ws: ServerWebSocket<ConnectionData>,
  code: number,
  reason: string,
): string {
  const closeContext = ws.data as { id?: unknown } | undefined;
  const contextId = typeof closeContext?.id === "string" ? closeContext.id : undefined;
  const sessionId = pubsub.removeConnectionBySocket(ws, contextId) ?? "unknown";
  console.log(
    `[daemon] WebSocket client disconnected: ${sessionId} (code: ${code}, reason: ${reason})`,
  );
  return sessionId;
}
