/**
 * Shared Constants
 *
 * Centralized constants for daemon connection URLs.
 *
 * When served by the daemon (production build), the browser's origin IS the
 * daemon, so we use same-origin requests. In dev mode (Vite on port 5173),
 * the daemon runs on a separate port so we fall back to the default.
 */

export const DAEMON_PORT = 3456;

function getDaemonApiBase(): string {
  if (typeof window === "undefined") return `http://localhost:${DAEMON_PORT}`;
  // In dev mode, Vite serves on a different port than the daemon
  const isDev = import.meta.env?.DEV;
  if (isDev) return `http://localhost:${DAEMON_PORT}`;
  // Production: daemon serves the web UI, so use same-origin
  return window.location.origin;
}

function getDaemonWsBase(): string {
  if (typeof window === "undefined") return `ws://localhost:${DAEMON_PORT}`;
  const isDev = import.meta.env?.DEV;
  if (isDev) return `ws://localhost:${DAEMON_PORT}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

export const DAEMON_API_BASE = getDaemonApiBase();
export const DAEMON_WS_BASE = getDaemonWsBase();
