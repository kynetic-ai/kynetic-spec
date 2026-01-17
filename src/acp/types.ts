/**
 * ACP (Agent Communication Protocol) Type Definitions
 *
 * This module re-exports types from the official @agentclientprotocol/sdk
 * to ensure spec compliance. Types are imported at compile-time only
 * (zero runtime cost since TypeScript types are erased).
 *
 * We keep JSON-RPC 2.0 base types and type guards local since the SDK
 * doesn't export them in the same way we use them.
 */

// ============================================================================
// ACP Types from Official SDK
//
// Import relevant types from the SDK. These are guaranteed to match the
// official ACP specification.
// ============================================================================

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
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  StopReason,
  TextContent,
} from '@agentclientprotocol/sdk';

// ============================================================================
// JSON-RPC 2.0 Base Types
//
// These are kept local because:
// 1. The SDK's internal JSON-RPC types aren't exported the same way
// 2. We need specific shapes for our type guards
// 3. These are standard JSON-RPC types, not ACP-specific
// ============================================================================

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 Response (success)
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

/**
 * JSON-RPC 2.0 Error object
 */
export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 Error response
 */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject;
}

/**
 * JSON-RPC 2.0 Notification (no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

/**
 * Any JSON-RPC message type
 */
export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcError
  | JsonRpcNotification;

// ============================================================================
// Validation Helpers
//
// Simple runtime type checks used by the JSON-RPC type guards.
// ============================================================================

/**
 * Check if a value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if a value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Check if a value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

/**
 * Check if an object has a specific property with an optional specific value
 */
export function hasProperty<T extends string>(
  obj: unknown,
  key: T,
  value?: unknown,
): obj is Record<T, unknown> {
  if (!isObject(obj)) return false;
  if (!(key in obj)) return false;
  if (value !== undefined && obj[key] !== value) return false;
  return true;
}

// ============================================================================
// JSON-RPC Type Guards
//
// Runtime type guards for validating incoming messages.
// These work with unknown data and narrow to specific types.
// ============================================================================

/**
 * Type guard for JSON-RPC Request
 */
export function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    'id' in msg &&
    (isString(msg.id) || isNumber(msg.id)) &&
    hasProperty(msg, 'method') &&
    isString(msg.method)
  );
}

/**
 * Type guard for JSON-RPC Response
 */
export function isResponse(msg: unknown): msg is JsonRpcResponse {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    'id' in msg &&
    (isString(msg.id) || isNumber(msg.id)) &&
    'result' in msg &&
    !('error' in msg)
  );
}

/**
 * Type guard for JSON-RPC Error
 */
export function isError(msg: unknown): msg is JsonRpcError {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    'id' in msg &&
    (msg.id === null || isString(msg.id) || isNumber(msg.id)) &&
    hasProperty(msg, 'error') &&
    isObject(msg.error) &&
    hasProperty(msg.error, 'code') &&
    isNumber(msg.error.code) &&
    hasProperty(msg.error, 'message') &&
    isString(msg.error.message)
  );
}

/**
 * Type guard for JSON-RPC Notification
 */
export function isNotification(msg: unknown): msg is JsonRpcNotification {
  return (
    isObject(msg) &&
    hasProperty(msg, 'jsonrpc', '2.0') &&
    !('id' in msg) &&
    hasProperty(msg, 'method') &&
    isString(msg.method)
  );
}
