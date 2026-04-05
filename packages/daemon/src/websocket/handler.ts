/**
 * WebSocket message handler
 *
 * AC coverage:
 * - ac-26 (@api-contract): Command format
 * - ac-27 (@api-contract): Ack response
 * - ac-28 (@api-contract): Subscribe to topics
 * - ac-30 (@api-contract): Malformed command error
 */

import type { WebSocketCommand, CommandAck, WebSocketConnection } from "./types.js";
import type { PubSubManager } from "./pubsub.js";
import { getWebSocketContextId } from "./context-id.js";

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
  handleMessage(ws: WebSocketConnection, rawMessage: WebSocketRawMessage): Promise<void> {
    return this.handleMessageInternal(ws, rawMessage);
  }

  private async handleMessageInternal(
    ws: WebSocketConnection,
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
        this.sendAck(ws, false, undefined, false, "validation_error", "Missing action field");
        return;
      }
    } catch {
      // AC: @api-contract ac-30
      this.sendAck(ws, false, undefined, false, "validation_error", "Invalid JSON");
      return;
    }

    // Process command
    try {
      this.injectTestFailure(command);

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
            true,
            command.request_id,
            false,
            "unknown_action",
            `Unknown action: ${command.action}`,
          );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Internal error";
      this.sendAck(ws, true, command.request_id, false, "error", errorMsg);
      ws.close(1011, "Internal error");
    }
  }

  /**
   * Handle subscribe command
   * AC: @api-contract ac-28
   */
  private handleSubscribe(ws: WebSocketConnection, command: WebSocketCommand) {
    const topics = command.payload?.topics;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      this.sendValidationError(ws, command.request_id, "Missing or invalid topics array");
      return;
    }

    const sessionId = this.resolveSessionId(ws);
    const success = sessionId ? this.pubsub.subscribe(sessionId, topics) : false;

    if (success) {
      this.sendAck(ws, true, command.request_id, true);
      console.log(`[ws] ${sessionId} subscribed to: ${topics.join(", ")}`);
    } else {
      this.sendAck(ws, true, command.request_id, false, "not_found", "Session not found");
    }
  }

  /**
   * Handle unsubscribe command
   */
  private handleUnsubscribe(ws: WebSocketConnection, command: WebSocketCommand) {
    const topics = command.payload?.topics;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      this.sendValidationError(ws, command.request_id, "Missing or invalid topics array");
      return;
    }

    const sessionId = this.resolveSessionId(ws);
    const success = sessionId ? this.pubsub.unsubscribe(sessionId, topics) : false;

    if (success) {
      this.sendAck(ws, true, command.request_id, true);
      console.log(`[ws] ${sessionId} unsubscribed from: ${topics.join(", ")}`);
    } else {
      this.sendAck(ws, true, command.request_id, false, "not_found", "Session not found");
    }
  }

  /**
   * Handle ping command (application-level ping, not WebSocket frame)
   */
  private handlePing(ws: WebSocketConnection, command: WebSocketCommand) {
    this.sendAck(ws, true, command.request_id, true);
  }

  private sendValidationError(
    ws: WebSocketConnection,
    request_id: string | undefined,
    details: string,
  ) {
    this.sendAck(ws, false, request_id, false, "validation_error", details);
  }

  private resolveSessionId(ws: WebSocketConnection): string | undefined {
    return this.pubsub.getSessionIdBySocket(ws, getWebSocketContextId(ws));
  }

  private injectTestFailure(command: WebSocketCommand) {
    const injectedRequestId = process.env.KSPEC_TEST_WS_FORCE_INTERNAL_ERROR_REQUEST_ID;
    if (injectedRequestId && command.request_id === injectedRequestId) {
      throw new Error(`Injected websocket failure for ${injectedRequestId}`);
    }
  }

  /**
   * Send ack response
   * AC: @api-contract ac-27
   */
  private sendAck(
    ws: WebSocketConnection,
    isAck: boolean,
    request_id: string | undefined,
    success: boolean,
    error?: string,
    details?: string,
  ) {
    const ackMessage: CommandAck = {
      ack: isAck,
      request_id,
      success,
      error,
      details,
    };

    ws.send(JSON.stringify(ackMessage));
  }
}
