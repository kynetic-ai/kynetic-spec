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

import type { ServerWebSocket } from 'bun';
import type { ConnectionData } from './types';

export class HeartbeatManager {
  private pingInterval?: NodeJS.Timeout;
  private readonly PING_INTERVAL = 30_000; // 30 seconds
  private readonly PONG_TIMEOUT = 90_000; // 90 seconds

  /**
   * Start heartbeat monitoring for all connections
   * AC: @daemon-server ac-13, @trait-websocket-protocol ac-4
   */
  start(connections: Map<string, ServerWebSocket<ConnectionData>>) {
    this.pingInterval = setInterval(() => {
      const now = Date.now();

      for (const [sessionId, ws] of connections) {
        // Check if pong timeout exceeded
        if (ws.data.lastPing && !ws.data.lastPong) {
          const timeSincePing = now - ws.data.lastPing;

          // AC: @daemon-server ac-14, @trait-websocket-protocol ac-5, ac-7
          if (timeSincePing > this.PONG_TIMEOUT) {
            console.warn(`[heartbeat] Closing ${sessionId} - no pong for ${timeSincePing}ms`);
            ws.close(1001, 'Ping timeout'); // AC: @trait-websocket-protocol ac-7
            continue;
          }
        }

        // Send ping if no recent activity
        const lastActivity = ws.data.lastPong ?? ws.data.lastPing ?? 0;
        const timeSinceActivity = now - lastActivity;

        if (timeSinceActivity >= this.PING_INTERVAL) {
          ws.data.lastPing = now;
          ws.data.lastPong = undefined; // Reset pong until received
          ws.ping();
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
  recordPong(ws: ServerWebSocket<ConnectionData>) {
    ws.data.lastPong = Date.now();
  }
}
