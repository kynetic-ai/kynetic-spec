/**
 * ACP (Agent Communication Protocol) Module
 *
 * Provides a JSON-RPC 2.0 based client for Agent Client Protocol communication.
 * Handles bidirectional stdio communication with ACP-compliant agents.
 */

export type {
  ACPClientEvents,
  ACPClientOptions,
  SessionState,
} from "./client.js";
// Client
export { ACPClient } from "./client.js";
export type {
  JsonRpcFramingOptions,
  SendRequestOptions,
} from "./framing.js";
// Framing layer
export { JsonRpcFraming } from "./framing.js";
// Types - JSON-RPC
// Types - ACP (re-exported from SDK)
export type {
  AgentCapabilities,
  ClientCapabilities,
  ContentBlock,
  InitializeRequest,
  InitializeResponse,
  JsonRpcError,
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  StopReason,
  TextContent,
} from "./types.js";
// Types - Type guards
export {
  isError,
  isNotification,
  isRequest,
  isResponse,
} from "./types.js";
