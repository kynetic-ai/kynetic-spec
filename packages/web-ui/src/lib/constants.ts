/**
 * Shared Constants
 *
 * Centralized constants for daemon connection URLs.
 *
 * When served by the daemon (production build), the browser's origin IS the
 * daemon, so we use same-origin requests. In dev mode (Vite on port 5173),
 * the daemon runs on a separate port. The Vite config injects
 * VITE_KSPEC_DAEMON_API_URL and VITE_KSPEC_DAEMON_WS_URL from the shared
 * daemon endpoint resolver so the dev client honors the same URLs the
 * daemon actually advertises (api_url / ws_url) — including IPv6 loopback
 * fallback, custom ports, and explicit connect hosts.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 */

export const DAEMON_PORT = 3456;

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

const DEV_DAEMON_API_URL: string =
  nonEmpty(import.meta.env?.VITE_KSPEC_DAEMON_API_URL as string | undefined) ??
  `http://127.0.0.1:${DAEMON_PORT}`;
const DEV_DAEMON_WS_URL: string =
  nonEmpty(import.meta.env?.VITE_KSPEC_DAEMON_WS_URL as string | undefined) ??
  `ws://127.0.0.1:${DAEMON_PORT}/ws`;

function stripWsPath(url: string): string {
  return url.replace(/\/ws\/?$/, "");
}

function getDaemonApiBase(): string {
  if (typeof window === "undefined") return DEV_DAEMON_API_URL;
  // In dev mode, Vite serves on a different port than the daemon.
  // Use the daemon-advertised api_url that the Vite config injected.
  const isDev = import.meta.env?.DEV;
  if (isDev) return DEV_DAEMON_API_URL;
  // Production: daemon serves the web UI, so use same-origin
  return window.location.origin;
}

function getDaemonWsBase(): string {
  if (typeof window === "undefined") return stripWsPath(DEV_DAEMON_WS_URL);
  const isDev = import.meta.env?.DEV;
  // In dev mode, use the daemon-advertised ws_url base (without the /ws
  // suffix so existing call sites can append their own path).
  if (isDev) return stripWsPath(DEV_DAEMON_WS_URL);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

export const DAEMON_API_BASE = getDaemonApiBase();
export const DAEMON_WS_BASE = getDaemonWsBase();
