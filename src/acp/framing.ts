/**
 * JSON-RPC 2.0 Framing Layer
 *
 * Handles bidirectional stdio communication with auto-incrementing IDs,
 * request/response correlation, and timeout handling.
 */

import { EventEmitter } from 'node:events';
import type {
  JsonRpcError,
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';
import { isError, isNotification, isRequest, isResponse } from './types.js';

/**
 * Options for JsonRpcFraming
 */
export interface JsonRpcFramingOptions {
  /** Default timeout for pending requests in milliseconds (default: 30000) */
  timeout?: number;
  /** Per-method timeout overrides in milliseconds */
  methodTimeouts?: Record<string, number>;
  /** Input stream (default: process.stdin) */
  stdin?: NodeJS.ReadableStream;
  /** Output stream (default: process.stdout) */
  stdout?: NodeJS.WritableStream;
}

/**
 * Options for sendRequest
 */
export interface SendRequestOptions {
  /**
   * If true, don't log "Method not found" errors.
   * Use for optional methods that may not be supported by all agents.
   */
  silentMethodNotFound?: boolean;
}

/**
 * Pending request information
 */
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  /** Timeout duration for this request (used for timer resets) */
  timeoutMs: number;
  /** Request ID for logging */
  id: string | number;
  /** Options for this request */
  options?: SendRequestOptions;
}

/**
 * Default timeouts for long-running methods (in milliseconds)
 * These methods can legitimately take minutes, so they need longer timeouts.
 */
const DEFAULT_METHOD_TIMEOUTS: Record<string, number> = {
  'session/prompt': 5 * 60 * 1000, // 5 minutes
  'session/resume': 5 * 60 * 1000, // 5 minutes
};

/**
 * JSON-RPC 2.0 Framing Layer
 *
 * Provides bidirectional JSON-RPC 2.0 communication over stdio with:
 * - Auto-incrementing request IDs
 * - Request/response correlation
 * - Configurable timeout for pending requests (default 30s)
 * - Per-method timeout overrides for long-running operations
 * - Activity-based timeout reset (keepalive on incoming messages)
 * - Event-based message handling
 */
export class JsonRpcFraming extends EventEmitter {
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private timeout: number;
  private methodTimeouts: Record<string, number>;
  private stdin: NodeJS.ReadableStream;
  private stdout: NodeJS.WritableStream;
  private buffer = '';
  private closed = false;

  constructor(options: JsonRpcFramingOptions = {}) {
    super();
    this.timeout = options.timeout ?? 30000;
    // Merge default method timeouts with user-provided overrides
    this.methodTimeouts = {
      ...DEFAULT_METHOD_TIMEOUTS,
      ...options.methodTimeouts,
    };
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;

    // Set up stdin to receive data
    if ('setEncoding' in this.stdin) {
      (this.stdin as NodeJS.ReadStream).setEncoding('utf8');
    }
    this.stdin.on('data', (chunk: string | Buffer) =>
      this.handleData(chunk.toString()),
    );
    this.stdin.on('end', () => this.handleEnd());
    this.stdin.on('error', (err) => this.handleError(err));
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async sendRequest(
    method: string,
    params?: unknown,
    options?: SendRequestOptions,
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error('JsonRpcFraming is closed');
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined && { params }),
    };

    // Get timeout for this method (use per-method override if available)
    const timeoutMs = this.methodTimeouts[method] ?? this.timeout;

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Request ${id} timed out after ${timeoutMs}ms (method: ${method})`,
          ),
        );
      }, timeoutMs);

      // Store pending request with timeout info for potential resets
      this.pending.set(id, { resolve, reject, timer, method, timeoutMs, id, options });

      // Send the request
      this.send(request);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  sendNotification(method: string, params?: unknown): void {
    if (this.closed) {
      throw new Error('JsonRpcFraming is closed');
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined && { params }),
    };

    this.send(notification);
  }

  /**
   * Send a JSON-RPC response (in response to a request)
   */
  sendResponse(id: string | number, result: unknown): void {
    if (this.closed) {
      throw new Error('JsonRpcFraming is closed');
    }

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };

    this.send(response);
  }

  /**
   * Send a JSON-RPC error response
   */
  sendError(id: string | number | null, error: JsonRpcErrorObject): void {
    if (this.closed) {
      throw new Error('JsonRpcFraming is closed');
    }

    const errorResponse: JsonRpcError = {
      jsonrpc: '2.0',
      id,
      error,
    };

    this.send(errorResponse);
  }

  /**
   * Close the framing layer
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Reject all pending requests
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('JsonRpcFraming closed'));
      this.pending.delete(id);
    }

    this.emit('close');
  }

  /**
   * Check if the framing layer is closed
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Reset timeout timers for all pending requests
   *
   * Called when activity is detected from the agent (incoming requests/responses),
   * indicating the agent is still alive and working. This implements a keepalive
   * mechanism that prevents timeout during long-running operations where the agent
   * is actively making tool calls.
   */
  private resetPendingTimers(): void {
    for (const pending of this.pending.values()) {
      // Clear the old timer
      clearTimeout(pending.timer);

      // Create a new timer with the same timeout duration
      pending.timer = setTimeout(() => {
        this.pending.delete(pending.id);
        pending.reject(
          new Error(
            `Request ${pending.id} timed out after ${pending.timeoutMs}ms (method: ${pending.method})`,
          ),
        );
      }, pending.timeoutMs);
    }
  }

  /**
   * Send a JSON-RPC message
   */
  private send(message: JsonRpcMessage): void {
    try {
      const json = JSON.stringify(message);
      this.stdout.write(`${json}\n`);
    } catch (err) {
      console.error(`Error sending message: ${err}`);
    }
  }

  /**
   * Handle incoming data from stdin
   */
  private handleData(chunk: string): void {
    this.buffer += chunk;

    // Process complete lines
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        this.processLine(line);
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  /**
   * Process a complete line of input
   */
  private processLine(line: string): void {
    try {
      const message = JSON.parse(line);
      this.handleMessage(message);
    } catch {
      // Malformed JSON - send parse error response
      this.sendError(null, {
        code: -32700,
        message: 'Parse error',
        data: { line },
      });
    }
  }

  /**
   * Handle a parsed JSON-RPC message
   */
  private handleMessage(message: unknown): void {
    if (isResponse(message)) {
      this.handleResponse(message);
    } else if (isError(message)) {
      this.handleErrorResponse(message);
    } else if (isRequest(message)) {
      // Agent is sending us a request (e.g., tool call) - this proves it's alive
      // Reset timeout timers for any pending requests
      this.resetPendingTimers();
      this.emit('request', message);
    } else if (isNotification(message)) {
      // Agent is sending us a notification - also proves it's alive
      this.resetPendingTimers();
      this.emit('notification', message);
    } else {
      // Invalid message
      this.sendError(null, {
        code: -32600,
        message: 'Invalid Request',
        data: message,
      });
    }
  }

  /**
   * Handle a JSON-RPC response
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response.result);
    } else {
      // Unexpected response
      console.error(
        `Warning: Received response for unknown request ID: ${response.id}`,
      );
    }
  }

  /**
   * Handle a JSON-RPC error response
   */
  private handleErrorResponse(error: JsonRpcError): void {
    // JSON-RPC error code for "Method not found"
    const METHOD_NOT_FOUND = -32601;

    if (error.id === null) {
      // Error without request ID - emit as event
      this.emit('error', error.error);
      return;
    }

    const pending = this.pending.get(error.id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(error.id);

      // Skip logging for expected "Method not found" errors on optional methods
      const isSilentMethodNotFound =
        pending.options?.silentMethodNotFound &&
        error.error.code === METHOD_NOT_FOUND;

      if (!isSilentMethodNotFound) {
        console.error(
          `JSON-RPC error: ${error.error.message} (code: ${error.error.code}, method: ${pending.method})`,
        );
      }

      const err = Object.assign(new Error(error.error.message), {
        code: error.error.code,
        data: error.error.data,
      });
      pending.reject(err);
    } else {
      // Unexpected error response
      console.error(
        `Warning: Received error for unknown request ID: ${error.id}`,
      );
    }
  }

  /**
   * Handle stdin end
   */
  private handleEnd(): void {
    this.close();
  }

  /**
   * Handle stdin error
   */
  private handleError(err: Error): void {
    console.error(`Stdin error: ${err.message}`);
    this.emit('error', err);
    this.close();
  }
}
