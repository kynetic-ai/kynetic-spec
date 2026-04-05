import type { ConnectionData, WebSocketConnection } from "./types.js";

export class ConnectionStateManager {
  private readonly state = new WeakMap<WebSocketConnection, ConnectionData>();

  init(ws: WebSocketConnection, data: ConnectionData): void {
    this.state.set(ws, data);
  }

  get(ws: WebSocketConnection): ConnectionData | undefined {
    return this.state.get(ws);
  }

  remove(ws: WebSocketConnection): void {
    this.state.delete(ws);
  }
}
