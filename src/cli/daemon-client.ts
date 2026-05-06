/**
 * Shared daemon client resolution for CLI command modules.
 *
 * Combines the recurring "is the daemon running and what endpoint should I
 * call" check used by `agent`, `event`, `schedule`, `task`, and other CLI
 * surfaces that talk to the running daemon. Returns the full resolved
 * endpoint so callers use `endpoint.apiUrl` / `endpoint.wsUrl` verbatim
 * instead of re-deriving URLs from a port number alone.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import {
  PidFileManager,
  resolveDaemonClientEndpoint,
  type DaemonClientEndpoint,
} from "./pid-utils.js";

/**
 * Resolve the running daemon's client endpoint, or null when the daemon
 * is not running or has no published endpoint.
 *
 * The check has two gates:
 * 1. The daemon PID file points at a live process. `PidFileManager`
 *    honors `KSPEC_NO_DAEMON` so non-management commands automatically
 *    suppress incidental daemon communication when the env var is set.
 * 2. The shared endpoint resolver finds connection metadata
 *    (~/.config/kspec/daemon.connection.json) or the legacy daemon.port
 *    fallback. Centralising this here keeps URL construction (IPv6
 *    bracketing, custom connect_host, legacy port synthesis) out of
 *    individual command files.
 *
 * AC: @cli-daemon-proxy ac-force-direct — KSPEC_NO_DAEMON suppresses
 *     incidental daemon communication via PidFileManager.isDaemonRunning()
 */
export function getRunningDaemonClient(): DaemonClientEndpoint | null {
  const pidManager = new PidFileManager();
  if (!pidManager.isDaemonRunning()) return null;
  return resolveDaemonClientEndpoint();
}
