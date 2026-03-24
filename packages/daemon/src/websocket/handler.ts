/**
 * WebSocket message handler
 *
 * AC coverage:
 * - ac-26 (@api-contract): Command format
 * - ac-27 (@api-contract): Ack response
 * - ac-28 (@api-contract): Subscribe to topics
 * - ac-30 (@api-contract): Malformed command error
 */

import type { ServerWebSocket } from "bun";
import type { WebSocketCommand, CommandAck, ConnectionData } from "./types";
import type { PubSubManager } from "./pubsub";

type WebSocketRawMessage =
  | string
  | Buffer
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | Record<string, unknown>;

/**
 * Decode inbound WebSocket payloads into UTF-8 text.
 *
 * Node/WebSocket clients may deliver command frames as Uint8Array/ArrayBuffer
 * or Blob instead of plain strings.
 */
async function decodeWebSocketMessage(rawMessage: WebSocketRawMessage): Promise<string> {
  if (typeof rawMessage === "string") {
    return rawMessage;
  }

  if (typeof rawMessage === "object" && rawMessage !== null && !ArrayBuffer.isView(rawMessage)) {
    if (rawMessage instanceof ArrayBuffer) {
      return Buffer.from(rawMessage).toString("utf-8");
    }

    if (rawMessage instanceof Blob) {
      return await rawMessage.text();
    }

    // Some runtimes already JSON-decode inbound websocket command payloads.
    return JSON.stringify(rawMessage);
  }

  if (ArrayBuffer.isView(rawMessage)) {
    return Buffer.from(rawMessage.buffer, rawMessage.byteOffset, rawMessage.byteLength).toString(
      "utf-8",
    );
  }

  return String(rawMessage);
}

export class WebSocketHandler {
  constructor(private pubsub: PubSubManager) {}

  /**
   * Handle incoming WebSocket command
   * AC: @api-contract ac-26, ac-27, ac-28, ac-30
   */
  handleMessage(
    ws: ServerWebSocket<ConnectionData>,
    rawMessage: WebSocketRawMessage,
  ): Promise<void> {
    return this.handleMessageInternal(ws, rawMessage);
  }

  private async handleMessageInternal(
    ws: ServerWebSocket<ConnectionData>,
    rawMessage: WebSocketRawMessage,
  ): Promise<void> {
    let command: WebSocketCommand;

    try {
      // Parse command
      const messageStr = await decodeWebSocketMessage(rawMessage);
      command = JSON.parse(messageStr);

      // Validate command structure
      if (!command.action) {
        // AC: @api-contract ac-30
        this.sendAck(ws, undefined, false, "validation_error", "Missing action field");
        return;
      }
    } catch  {
      // AC: @api-contract ac-30
      this.sendAck(ws, undefined, false, "validation_error", "Invalid JSON");
      return;
    }

    // Process command
    try {
      switch (command.action) {
        case "subscribe":
          this.handleSubscribe(ws, command);
          break;

        case "unsubscribe":
          this.handleUnsubscribe(ws, command);
          break;

        case "ping":
          this.handlePing(ws, command);
          break;

        default:
          // AC: @api-contract ac-30
          this.sendAck(
            ws,
            command.request_id,
            false,
            "unknown_action",
            `Unknown action: ${command.action}`,
          );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Internal error";
      this.sendAck(ws, command.request_id, false, "error", errorMsg);
    }
  }

  /**
   * Handle subscribe command
   * AC: @api-contract ac-28
   */
  private handleSubscribe(ws: ServerWebSocket<ConnectionData>, command: WebSocketCommand) {
    const topics = command.payload?.topics;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      this.sendAck(
        ws,
        command.request_id,
        false,
        "validation_error",
        "Missing or invalid topics array",
      );
      return;
    }

    const sessionId = this.resolveSessionId(ws);
    const success = sessionId ? this.pubsub.subscribe(sessionId, topics) : false;

    if (success) {
      this.sendAck(ws, command.request_id, true);
      console.log(`[ws] ${sessionId} subscribed to: ${topics.join(", ")}`);
    } else {
      this.sendAck(ws, command.request_id, false, "not_found", "Session not found");
    }
  }

  /**
   * Handle unsubscribe command
   */
  private handleUnsubscribe(ws: ServerWebSocket<ConnectionData>, command: WebSocketCommand) {
    const topics = command.payload?.topics;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      this.sendAck(
        ws,
        command.request_id,
        false,
        "validation_error",
        "Missing or invalid topics array",
      );
      return;
    }

    const sessionId = this.resolveSessionId(ws);
    const success = sessionId ? this.pubsub.unsubscribe(sessionId, topics) : false;

    if (success) {
      this.sendAck(ws, command.request_id, true);
      console.log(`[ws] ${sessionId} unsubscribed from: ${topics.join(", ")}`);
    } else {
      this.sendAck(ws, command.request_id, false, "not_found", "Session not found");
    }
  }

  /**
   * Handle ping command (application-level ping, not WebSocket frame)
   */
  private handlePing(ws: ServerWebSocket<ConnectionData>, command: WebSocketCommand) {
    this.sendAck(ws, command.request_id, true);
  }

  private resolveSessionId(ws: ServerWebSocket<ConnectionData>): string | undefined {
    const data = ws.data as { id?: unknown } | undefined;
    const contextId = typeof data?.id === "string" ? data.id : undefined;
    return this.pubsub.getSessionIdBySocket(ws, contextId);
  }

  /**
   * Send ack response
   * AC: @api-contract ac-27
   */
  private sendAck(
    ws: ServerWebSocket<ConnectionData>,
    request_id: string | undefined,
    success: boolean,
    error?: string,
    details?: string,
  ) {
    const ack: CommandAck = {
      ack: true,
      request_id,
      success,
      error,
      details,
    };

    ws.send(JSON.stringify(ack));
  }
}
