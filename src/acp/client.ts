/**
 * ACP (Agent Communication Protocol) Client
 *
 * Manages agent lifecycle and communication over JSON-RPC 2.0 stdio.
 * This is a simplified client focused on core operations:
 * - Initialize agent connection
 * - Create sessions
 * - Send prompts and receive responses
 * - Handle streaming updates
 * - Cancel operations (optional)
 */

import { EventEmitter } from 'node:events';
import type { JsonRpcFramingOptions } from './framing.js';
import { JsonRpcFraming } from './framing.js';

import type {
  AgentCapabilities,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SessionUpdate,
} from './types.js';

/**
 * Session state tracked by the client
 */
export interface SessionState {
  id: string;
  status: 'idle' | 'prompting' | 'cancelled';
}

/**
 * Options for ACPClient
 */
export interface ACPClientOptions extends JsonRpcFramingOptions {
  /** Client capabilities to advertise */
  capabilities?: ClientCapabilities;
  /** Client info */
  clientInfo?: {
    name: string;
    version?: string;
  };
}

// Event types for type-safe event handling
export interface ACPClientEvents {
  update: (sessionId: string, update: SessionUpdate) => void;
  request: (id: string | number, method: string, params: unknown) => void;
  close: () => void;
  error: (error: Error) => void;
}

/**
 * ACP Client
 *
 * Manages agent communication over JSON-RPC 2.0 stdio transport.
 * Handles initialization, session lifecycle, prompts, and streaming updates.
 *
 * Events:
 * - 'update': Emitted when session updates arrive (sessionId, update)
 * - 'close': Emitted when the connection is closed
 * - 'error': Emitted on errors
 */
export class ACPClient extends EventEmitter {
  private framing: JsonRpcFraming;
  private sessions = new Map<string, SessionState>();
  private agentCapabilities: AgentCapabilities = {};
  private clientCapabilities: ClientCapabilities;
  private clientInfo?: { name: string; version?: string };
  private initialized = false;

  constructor(options: ACPClientOptions = {}) {
    super();

    // Default capabilities - we don't handle file/terminal in this simplified client
    this.clientCapabilities = options.capabilities ?? {};
    this.clientInfo = options.clientInfo;

    // Create framing layer
    this.framing = new JsonRpcFraming(options);

    // Wire up notification handler for session updates
    this.framing.on('notification', (notification: JsonRpcNotification) => {
      this.handleNotification(notification);
    });

    // Forward request events for tool calls
    this.framing.on('request', (request: JsonRpcRequest) => {
      this.emit('request', request.id, request.method, request.params);
    });

    // Forward framing events
    this.framing.on('close', () => this.emit('close'));
    this.framing.on('error', (err: Error) => this.emit('error', err));
  }

  /**
   * Initialize the agent connection
   *
   * @returns Agent capabilities including supported features
   * @throws If already initialized or connection fails
   */
  async initialize(): Promise<AgentCapabilities> {
    if (this.initialized) {
      throw new Error('Client already initialized');
    }

    const params: InitializeRequest = {
      protocolVersion: 1,
      clientCapabilities: this.clientCapabilities,
      ...(this.clientInfo && {
        clientInfo: {
          name: this.clientInfo.name,
          version: this.clientInfo.version ?? '0.0.0',
        },
      }),
    };

    const result = (await this.framing.sendRequest(
      'initialize',
      params,
    )) as InitializeResponse;

    this.agentCapabilities = result.agentCapabilities ?? {};
    this.initialized = true;

    return this.agentCapabilities;
  }

  /**
   * Create a new session
   *
   * @param params Session parameters including cwd and optional metadata
   * @returns Session ID
   * @throws If not initialized or session creation fails
   */
  async newSession(params: NewSessionRequest): Promise<string> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const result = (await this.framing.sendRequest(
      'session/new',
      params,
    )) as NewSessionResponse;

    // Track session state
    this.sessions.set(result.sessionId, {
      id: result.sessionId,
      status: 'idle',
    });

    return result.sessionId;
  }

  /**
   * Send a prompt to the agent
   *
   * @param params Prompt request parameters including sessionId and prompt content
   * @returns Prompt response with stopReason
   * @throws If not initialized, session not found, or already prompting
   */
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    if (session.status === 'prompting') {
      throw new Error(`Session already prompting: ${params.sessionId}`);
    }

    // Update session state
    session.status = 'prompting';

    try {
      const result = (await this.framing.sendRequest(
        'session/prompt',
        params,
      )) as PromptResponse;

      // Update session state based on stop reason
      if (result.stopReason === 'cancelled') {
        session.status = 'cancelled';
      } else {
        session.status = 'idle';
      }

      return result;
    } catch (err) {
      // Reset to idle on error
      session.status = 'idle';
      throw err;
    }
  }

  /**
   * Cancel an ongoing prompt
   *
   * Note: session/cancel is an optional ACP method. If the agent doesn't
   * support it (returns "Method not found"), we silently ignore the error.
   * The caller should fall back to process termination (SIGTERM) if needed.
   *
   * @param sessionId The session to cancel
   * @throws If not initialized or session not found
   */
  async cancel(sessionId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('Client not initialized');
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      // Use silentMethodNotFound since not all agents implement session/cancel
      await this.framing.sendRequest(
        'session/cancel',
        { sessionId },
        { silentMethodNotFound: true },
      );

      // Update session state
      session.status = 'cancelled';
    } catch (err: unknown) {
      // Ignore "Method not found" errors - agent doesn't support cancel
      const error = err as { code?: number };
      if (error.code === -32601) {
        // Agent doesn't support session/cancel, caller should use SIGTERM
        return;
      }
      throw err;
    }
  }

  /**
   * Get session state
   *
   * @param sessionId The session to get
   * @returns Session state or undefined if not found
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions
   *
   * @returns Array of all session states
   */
  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get agent capabilities (available after initialize)
   *
   * @returns Agent capabilities
   */
  getCapabilities(): AgentCapabilities {
    return this.agentCapabilities;
  }

  /**
   * Check if client is initialized
   *
   * @returns true if initialize() has been called successfully
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if the client connection is closed
   *
   * @returns true if the connection is closed
   */
  isClosed(): boolean {
    return this.framing.isClosed();
  }

  /**
   * Send a response to an agent request (tool call)
   *
   * @param id - The request ID to respond to
   * @param result - The result to send back
   */
  respond(id: string | number, result: unknown): void {
    this.framing.sendResponse(id, result);
  }

  /**
   * Send an error response to an agent request
   *
   * @param id - The request ID to respond to
   * @param code - Error code
   * @param message - Error message
   */
  respondError(id: string | number, code: number, message: string): void {
    this.framing.sendError(id, { code, message });
  }

  /**
   * Close the client connection
   *
   * Rejects any pending requests and cleans up resources.
   */
  close(): void {
    this.framing.close();
  }

  /**
   * Handle incoming notifications from the agent
   */
  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === 'session/update') {
      const sessionNotification = notification.params as SessionNotification;
      this.emit(
        'update',
        sessionNotification.sessionId,
        sessionNotification.update,
      );
    }
  }
}
