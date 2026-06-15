/**
 * @kynetic-ai/shared
 *
 * Shared types and schemas for kspec packages.
 * Used by both daemon and web-ui for type safety and validation.
 */

// API types (includes the BreadcrumbAncestor contract type)
export * from "./api.js";

// Actor identity classification
export * from "./actor.js";

// Next-actor derivation (review awaited-role rule)
export * from "./next-actor.js";

// WebSocket types
export * from "./websocket.js";

// Zod schemas (re-exported from core)
export * from "./schemas.js";
