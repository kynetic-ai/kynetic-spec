import type { ConnectionData, WebSocketConnection } from "./types.js";

function isConnectionData(value: unknown): value is ConnectionData {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ConnectionData>;
  return (
    typeof candidate.sessionId === "string" &&
    candidate.topics instanceof Set &&
    typeof candidate.seq === "number" &&
    typeof candidate.projectPath === "string"
  );
}

export class ConnectionStateManager {
  private readonly state = new WeakMap<WebSocketConnection, ConnectionData>();

  init(ws: WebSocketConnection, data: ConnectionData): void {
    this.state.set(ws, data);
  }

  get(ws: WebSocketConnection): ConnectionData | undefined {
    return this.state.get(ws);
  }

  adopt(ws: WebSocketConnection): ConnectionData | undefined {
    const data = ws.data;
    if (!isConnectionData(data)) {
      return undefined;
    }

    this.state.set(ws, data);
    return data;
  }

  remove(ws: WebSocketConnection): void {
    this.state.delete(ws);
  }
}
