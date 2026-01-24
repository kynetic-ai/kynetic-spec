/**
 * Topic-based pub/sub system for WebSocket connections
 *
 * AC coverage:
 * - ac-28 (@api-contract): Subscribe to topics
 * - ac-29 (@api-contract): Event format with seq
 * - ac-32 (@api-contract): Backpressure handling
 * - ac-2 (@trait-websocket-protocol): Subscribe command tracking
 * - ac-3 (@trait-websocket-protocol): Broadcast event format
 * - ac-6 (@trait-websocket-protocol): Backpressure pause
 */

import type { ServerWebSocket } from 'bun';
import { ulid } from 'ulidx';
import type { BroadcastEvent, ConnectionData } from './types';

export class PubSubManager {
  private connections = new Map<string, ServerWebSocket<ConnectionData>>();

  /**
   * Register a new WebSocket connection
   * AC: @trait-websocket-protocol ac-1
   */
  addConnection(sessionId: string, ws: ServerWebSocket<ConnectionData>) {
    this.connections.set(sessionId, ws);
  }

  /**
   * Remove a WebSocket connection
   */
  removeConnection(sessionId: string) {
    this.connections.delete(sessionId);
  }

  /**
   * Subscribe a connection to topics
   * AC: @api-contract ac-28, @trait-websocket-protocol ac-2
   */
  subscribe(sessionId: string, topics: string[]): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws) {
      return false;
    }

    for (const topic of topics) {
      ws.data.topics.add(topic);
    }

    return true;
  }

  /**
   * Unsubscribe a connection from topics
   */
  unsubscribe(sessionId: string, topics: string[]): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws) {
      return false;
    }

    for (const topic of topics) {
      ws.data.topics.delete(topic);
    }

    return true;
  }

  /**
   * Broadcast event to all connections subscribed to a topic
   * AC: @api-contract ac-29, @trait-websocket-protocol ac-3, ac-6
   * AC: @multi-directory-daemon ac-18, ac-21 - Filter by project binding
   */
  broadcast(topic: string, event: string, data: any, projectPath?: string) {
    for (const [sessionId, ws] of this.connections) {
      // AC: @multi-directory-daemon ac-18 - Only send to connections bound to same project
      if (projectPath && ws.data.projectPath !== projectPath) {
        continue;
      }

      // Only send to connections subscribed to this topic
      if (!ws.data.topics.has(topic)) {
        continue;
      }

      // AC: @trait-websocket-protocol ac-6 - Check backpressure
      // Bun's ServerWebSocket doesn't have bufferedAmount, so we use getBufferedAmount()
      const buffered = ws.getBufferedAmount?.() ?? 0;
      const MAX_BUFFER = 1024 * 1024; // 1MB threshold

      if (buffered > MAX_BUFFER) {
        console.warn(`[pubsub] Skipping broadcast to ${sessionId} - backpressure (${buffered} bytes buffered)`);
        continue;
      }

      // Increment sequence number for this connection
      ws.data.seq++;

      // AC: @api-contract ac-29, @trait-websocket-protocol ac-3
      const message: BroadcastEvent = {
        msg_id: ulid(),
        seq: ws.data.seq,
        timestamp: new Date().toISOString(),
        topic,
        event,
        data
      };

      ws.send(JSON.stringify(message));
    }
  }

  /**
   * Get all connections (for heartbeat checks)
   */
  getAllConnections(): Map<string, ServerWebSocket<ConnectionData>> {
    return this.connections;
  }

  /**
   * Get connection count
   */
  getConnectionCount(): number {
    return this.connections.size;
  }
}
