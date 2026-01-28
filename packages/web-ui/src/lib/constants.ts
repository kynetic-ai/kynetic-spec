/**
 * Shared Constants
 *
 * Centralized constants for daemon connection URLs to avoid hardcoding.
 */

export const DAEMON_PORT = 3456;
export const DAEMON_API_BASE = `http://localhost:${DAEMON_PORT}`;
export const DAEMON_WS_BASE = `ws://localhost:${DAEMON_PORT}`;
