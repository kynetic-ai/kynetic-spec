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

import type { ServerWebSocket } from "bun";
import { ulid } from "ulidx";
import type { BroadcastEvent, ConnectionData } from "./types";

const SESSION_TOPIC_PREFIX = "__kspec_session:";

function sessionTopic(sessionId: string): string {
  return `${SESSION_TOPIC_PREFIX}${sessionId}`;
}

export class PubSubManager {
  private connections = new Map<string, ServerWebSocket<ConnectionData>>();
  private sessionIdsBySocket = new WeakMap<ServerWebSocket<ConnectionData>, string>();
  private sessionIdsByContextId = new Map<string, string>();
  private contextIdsBySessionId = new Map<string, string>();

  /**
   * Register a new WebSocket connection
   * AC: @trait-websocket-protocol ac-1
   */
  addConnection(sessionId: string, ws: ServerWebSocket<ConnectionData>, contextId?: string) {
    this.connections.set(sessionId, ws);
    this.sessionIdsBySocket.set(ws, sessionId);
    if (contextId) {
      this.sessionIdsByContextId.set(contextId, sessionId);
      this.contextIdsBySessionId.set(sessionId, contextId);
    }
    ws.subscribe?.(sessionTopic(sessionId));
  }

  /**
   * Remove a WebSocket connection
   */
  removeConnection(sessionId: string): boolean {
    const ws = this.connections.get(sessionId);
    if (ws) {
      ws.unsubscribe?.(sessionTopic(sessionId));
      this.sessionIdsBySocket.delete(ws);
    }
    const contextId = this.contextIdsBySessionId.get(sessionId);
    if (contextId) {
      this.contextIdsBySessionId.delete(sessionId);
      this.sessionIdsByContextId.delete(contextId);
    }
    return this.connections.delete(sessionId);
  }

  /**
   * Resolve a stable session ID for a socket and remove that connection.
   * This is resilient when ws.data.sessionId is missing in close callbacks.
   */
  removeConnectionBySocket(
    ws: ServerWebSocket<ConnectionData>,
    contextId?: string,
  ): string | undefined {
    const sessionId = this.getSessionIdBySocket(ws, contextId);
    if (!sessionId) {
      return undefined;
    }

    this.removeConnection(sessionId);
    return sessionId;
  }

  /**
   * Get stable session ID for socket from registration mapping.
   */
  getSessionIdBySocket(
    ws: ServerWebSocket<ConnectionData>,
    contextId?: string,
  ): string | undefined {
    const mappedSessionId = this.sessionIdsBySocket.get(ws);
    if (mappedSessionId) {
      return mappedSessionId;
    }

    const data = ws.data as Partial<ConnectionData> | undefined;
    if (data?.sessionId) {
      return data.sessionId;
    }

    const subscriptions = (ws as Partial<ServerWebSocket<ConnectionData>>).subscriptions;
    if (Array.isArray(subscriptions)) {
      const sessionSubscription = subscriptions.find((topic) =>
        topic.startsWith(SESSION_TOPIC_PREFIX),
      );
      if (sessionSubscription) {
        return sessionSubscription.slice(SESSION_TOPIC_PREFIX.length);
      }
    }

    if (contextId) {
      const sessionFromContext = this.sessionIdsByContextId.get(contextId);
      if (sessionFromContext) {
        return sessionFromContext;
      }
    }

    return undefined;
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
  broadcast(topic: string, event: string, data: Record<string, unknown>, projectPath?: string) {
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
        console.warn(
          `[pubsub] Skipping broadcast to ${sessionId} - backpressure (${buffered} bytes buffered)`,
        );
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
        data,
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
