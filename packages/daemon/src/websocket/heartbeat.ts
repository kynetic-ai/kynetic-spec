/**
 * WebSocket heartbeat (ping/pong) management
 *
 * AC coverage:
 * - ac-13 (@daemon-server): Heartbeat ping every 30s
 * - ac-14 (@daemon-server): Timeout close after 90s without pong
 * - ac-4 (@trait-websocket-protocol): Send ping after 30s inactivity
 * - ac-5 (@trait-websocket-protocol): Close after 90s without pong
 * - ac-7 (@trait-websocket-protocol): Close code 1001 for timeout
 */

import { ConnectionStateManager } from "./connection-state.js";
import type { WebSocketConnection } from "./types.js";

export class HeartbeatManager {
  private pingInterval?: NodeJS.Timeout;
  private readonly PING_INTERVAL = 30_000; // 30 seconds
  private readonly PONG_TIMEOUT = 90_000; // 90 seconds

  constructor(private readonly connectionState: ConnectionStateManager) {}

  /**
   * Start heartbeat monitoring for all connections
   * AC: @daemon-server ac-13, @trait-websocket-protocol ac-4
   */
  start(connections: Map<string, WebSocketConnection>) {
    this.pingInterval = setInterval(() => {
      const now = Date.now();

      for (const [sessionId, ws] of connections) {
        const connection = this.connectionState.get(ws);
        if (!connection) {
          continue;
        }

        // Check if pong timeout exceeded
        if (connection.lastPing && !connection.lastPong) {
          const timeSincePing = now - connection.lastPing;

          // AC: @daemon-server ac-14, @trait-websocket-protocol ac-5, ac-7
          if (timeSincePing >= this.PONG_TIMEOUT) {
            console.warn(`[heartbeat] Closing ${sessionId} - no pong for ${timeSincePing}ms`);
            ws.close(1001, "Ping timeout"); // AC: @trait-websocket-protocol ac-7
            continue;
          }

          // Keep waiting for the outstanding pong instead of resetting the timeout window.
          continue;
        }

        // Send ping if no recent activity
        const lastActivity = connection.lastPong ?? connection.lastPing ?? 0;
        const timeSinceActivity = now - lastActivity;

        if (timeSinceActivity >= this.PING_INTERVAL) {
          if (typeof ws.ping !== "function") {
            continue;
          }

          connection.lastPing = now;
          connection.lastPong = undefined; // Reset pong until received
          try {
            ws.ping();
          } catch {
            // Defense-in-depth: Elysia's ElysiaWS wrapper exposes .ping() but
            // internally delegates to this.raw.ping() which may not exist on
            // all runtimes. Skip silently if the transport rejects the call.
            continue;
          }
          console.debug(`[heartbeat] Sent ping to ${sessionId}`);
        }
      }
    }, this.PING_INTERVAL);
  }

  /**
   * Stop heartbeat monitoring
   */
  stop() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
  }

  /**
   * Record pong received from connection
   */
  recordPong(ws: WebSocketConnection) {
    const connection = this.connectionState.get(ws);
    if (!connection) {
      return;
    }
    connection.lastPong = Date.now();
  }
}
