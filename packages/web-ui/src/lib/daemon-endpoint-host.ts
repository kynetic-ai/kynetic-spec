/**
 * Browser-safe daemon host formatting helpers.
 *
 * These mirror the pure host-formatting helpers in
 * src/daemon-shared/endpoint.ts so the web UI can construct daemon URLs
 * (with correct IPv6 bracketing, normalized hosts, and the canonical
 * default port) without importing the Node-only endpoint module.
 *
 * Parity with the Node module is enforced by
 * tests/web-ui/daemon-endpoint-host-parity.test.ts — any change here
 * must also be reflected in src/daemon-shared/endpoint.ts (or the
 * parity test will fail).
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 */

/**
 * Default daemon port. Mirror of `DEFAULT_DAEMON_PORT` in
 * src/daemon-shared/endpoint.ts.
 */
export const DEFAULT_DAEMON_PORT = 3456;

/**
 * Default bind host for the daemon. Numeric IPv4 loopback so URL
 * construction does not depend on /etc/hosts or DNS. Mirror of
 * `DEFAULT_BIND_HOST` in src/daemon-shared/endpoint.ts.
 *
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * Trim whitespace and strip surrounding brackets from IPv6 literals.
 * Throws on empty input.
 *
 * Mirror of `normalizeDaemonHost` in src/daemon-shared/endpoint.ts.
 */
export function normalizeDaemonHost(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Daemon host must not be empty");
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]") && trimmed.length >= 4) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Detect IPv6 literals; brackets accepted as input.
 *
 * Mirror of `isIpv6Literal` in src/daemon-shared/endpoint.ts.
 */
export function isIpv6Literal(host: string): boolean {
  return normalizeDaemonHost(host).includes(":");
}

/**
 * Bracket IPv6 literals for use inside a URL host segment.
 *
 * Mirror of `formatHostForUrl` in src/daemon-shared/endpoint.ts.
 */
export function formatHostForUrl(host: string): string {
  const normalized = normalizeDaemonHost(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function isValidPortValue(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Build api_url and ws_url for a connect host and port. IPv6 literals
 * are bracketed.
 *
 * Mirror of `buildDaemonUrls` in src/daemon-shared/endpoint.ts.
 */
export function buildDaemonUrls(
  connectHost: string,
  port: number,
): { apiUrl: string; wsUrl: string } {
  if (!isValidPortValue(port)) {
    throw new RangeError(`Invalid daemon port: ${port}`);
  }
  const formatted = formatHostForUrl(connectHost);
  return {
    apiUrl: `http://${formatted}:${port}`,
    wsUrl: `ws://${formatted}:${port}/ws`,
  };
}

/**
 * Parse a port string from an env var. Returns the fallback when the
 * input is missing or not a valid port (1..65535).
 */
export function parseDaemonPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  if (!isValidPortValue(parsed)) return fallback;
  return parsed;
}
