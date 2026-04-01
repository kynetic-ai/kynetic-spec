/**
 * Session event storage module.
 *
 * Provides JSONL-based event storage for agent sessions with:
 * - Append-only event logs for auditability
 * - Session metadata tracking
 * - Integration with kspec commit boundaries
 */

// Re-export storage functions
export * from "./store.js";
// Re-export types
export * from "./types.js";
