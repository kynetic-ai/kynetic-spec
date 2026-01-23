/**
 * WebSocket message handler
 *
 * AC coverage:
 * - ac-26 (@api-contract): Command format
 * - ac-27 (@api-contract): Ack response
 * - ac-28 (@api-contract): Subscribe to topics
 * - ac-30 (@api-contract): Malformed command error
 */

import type { ServerWebSocket } from 'bun';
import type { WebSocketCommand, CommandAck, ConnectionData } from './types';
import type { PubSubManager } from './pubsub';

export class WebSocketHandler {
  constructor(private pubsub: PubSubManager) {}

  /**
   * Handle incoming WebSocket command
   * AC: @api-contract ac-26, ac-27, ac-28, ac-30
   */
  handleMessage(ws: ServerWebSocket<ConnectionData>, rawMessage: string | Buffer) {
    let command: WebSocketCommand;

    try {
      // Parse command
      const messageStr = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
      command = JSON.parse(messageStr);

      // Validate command structure
      if (!command.action) {
        // AC: @api-contract ac-30
        this.sendAck(ws, undefined, false, 'validation_error', 'Missing action field');
        return;
      }
    } catch (error) {
      // AC: @api-contract ac-30
      this.sendAck(ws, undefined, false, 'validation_error', 'Invalid JSON');
      return;
    }

    // Process command
    try {
      switch (command.action) {
        case 'subscribe':
          this.handleSubscribe(ws, command);
          break;

        case 'unsubscribe':
          this.handleUnsubscribe(ws, command);
          break;

        case 'ping':
          this.handlePing(ws, command);
          break;

        default:
          // AC: @api-contract ac-30
          this.sendAck(ws, command.request_id, false, 'unknown_action', `Unknown action: ${command.action}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Internal error';
      this.sendAck(ws, command.request_id, false, 'error', errorMsg);
    }
  }

  /**
   * Handle subscribe command
   * AC: @api-contract ac-28
   */
  private handleSubscribe(ws: ServerWebSocket<ConnectionData>, command: WebSocketCommand) {
    const topics = command.payload?.topics;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      this.sendAck(ws, command.request_id, false, 'validation_error', 'Missing or invalid topics array');
      return;
    }

    const success = this.pubsub.subscribe(ws.data.sessionId, topics);

    if (success) {
      this.sendAck(ws, command.request_id, true);
      console.log(`[ws] ${ws.data.sessionId} subscribed to: ${topics.join(', ')}`);
    } else {
      this.sendAck(ws, command.request_id, false, 'not_found', 'Session not found');
    }
  }

  /**
   * Handle unsubscribe command
   */
  private handleUnsubscribe(ws: ServerWebSocket<ConnectionData>, command: WebSocketCommand) {
    const topics = command.payload?.topics;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      this.sendAck(ws, command.request_id, false, 'validation_error', 'Missing or invalid topics array');
      return;
    }

    const success = this.pubsub.unsubscribe(ws.data.sessionId, topics);

    if (success) {
      this.sendAck(ws, command.request_id, true);
      console.log(`[ws] ${ws.data.sessionId} unsubscribed from: ${topics.join(', ')}`);
    } else {
      this.sendAck(ws, command.request_id, false, 'not_found', 'Session not found');
    }
  }

  /**
   * Handle ping command (application-level ping, not WebSocket frame)
   */
  private handlePing(ws: ServerWebSocket<ConnectionData>, command: WebSocketCommand) {
    this.sendAck(ws, command.request_id, true);
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
    details?: any
  ) {
    const ack: CommandAck = {
      ack: true,
      request_id,
      success,
      error,
      details
    };

    ws.send(JSON.stringify(ack));
  }
}
