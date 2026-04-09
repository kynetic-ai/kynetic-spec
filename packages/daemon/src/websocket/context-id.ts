import type { WebSocketConnection } from "./types.js";

type WebSocketRequestContext = {
  wsId?: unknown;
};

type WebSocketDataContext = {
  id?: unknown;
  request?: WebSocketRequestContext;
};

export function getWebSocketContextId(ws: WebSocketConnection): string | undefined {
  if (typeof ws.id === "string" && ws.id.length > 0) {
    return ws.id;
  }

  const data = ws.data as WebSocketDataContext | undefined;
  if (typeof data?.id === "string" && data.id.length > 0) {
    return data.id;
  }

  const requestWsId = data?.request?.wsId;
  return typeof requestWsId === "string" && requestWsId.length > 0 ? requestWsId : undefined;
}
