/**
 * Shared Constants
 *
 * Centralized constants for daemon connection URLs.
 *
 * When served by the daemon (production build), the browser's origin IS the
 * daemon, so we use same-origin requests. In dev mode (Vite on port 5173),
 * the daemon runs on a separate port. The Vite config injects
 * VITE_KSPEC_DAEMON_API_URL and VITE_KSPEC_DAEMON_WS_URL from the shared
 * daemon endpoint resolver when the running daemon has published its
 * connection metadata, so the dev client honors the same URLs the daemon
 * actually advertises (api_url / ws_url) — including IPv6 loopback
 * fallback, custom ports, and explicit connect hosts.
 *
 * When no daemon metadata exists yet (e.g. `npm run dev` started before
 * `kspec serve start`), the dev client honors the user-overridable
 * VITE_KSPEC_DAEMON_HOST and VITE_KSPEC_DAEMON_PORT env vars, then falls
 * back to the documented numeric defaults (127.0.0.1 and the shared
 * DEFAULT_DAEMON_PORT). Host and URL formatting (including IPv6
 * bracketing) goes through the shared host helpers.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 */

import {
  DEFAULT_BIND_HOST,
  DEFAULT_DAEMON_PORT,
  buildDaemonUrls,
  parseDaemonPort,
} from "./daemon-endpoint-host";

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function readEnv(key: string): string | undefined {
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  return env ? env[key] : undefined;
}

const ENV_DAEMON_HOST: string = nonEmpty(readEnv("VITE_KSPEC_DAEMON_HOST")) ?? DEFAULT_BIND_HOST;
const ENV_DAEMON_PORT: number = parseDaemonPort(
  readEnv("VITE_KSPEC_DAEMON_PORT"),
  DEFAULT_DAEMON_PORT,
);

const { apiUrl: ENV_DAEMON_API_URL, wsUrl: ENV_DAEMON_WS_URL } = buildDaemonUrls(
  ENV_DAEMON_HOST,
  ENV_DAEMON_PORT,
);

const DEV_DAEMON_API_URL: string =
  nonEmpty(readEnv("VITE_KSPEC_DAEMON_API_URL")) ?? ENV_DAEMON_API_URL;
const DEV_DAEMON_WS_URL: string =
  nonEmpty(readEnv("VITE_KSPEC_DAEMON_WS_URL")) ?? ENV_DAEMON_WS_URL;

function stripWsPath(url: string): string {
  return url.replace(/\/ws\/?$/, "");
}

function getDaemonApiBase(): string {
  if (typeof window === "undefined") return DEV_DAEMON_API_URL;
  // In dev mode, Vite serves on a different port than the daemon.
  // Use the daemon-advertised api_url that the Vite config injected
  // (or the env-derived URL when no daemon metadata is present yet).
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
