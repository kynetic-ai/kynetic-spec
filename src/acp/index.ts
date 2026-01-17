/**
 * ACP (Agent Communication Protocol) Module
 *
 * Provides a JSON-RPC 2.0 based client for Agent Client Protocol communication.
 * Handles bidirectional stdio communication with ACP-compliant agents.
 */

// Client
export { ACPClient } from './client.js';
export type { ACPClientEvents, ACPClientOptions, SessionState } from './client.js';

// Framing layer
export { JsonRpcFraming } from './framing.js';
export type {
  JsonRpcFramingOptions,
  SendRequestOptions,
} from './framing.js';

// Types - JSON-RPC
export type {
  JsonRpcError,
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

// Types - Type guards
export {
  isError,
  isNotification,
  isRequest,
  isResponse,
} from './types.js';

// Types - ACP (re-exported from SDK)
export type {
  AgentCapabilities,
  ClientCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SessionUpdate,
  StopReason,
  TextContent,
} from './types.js';
