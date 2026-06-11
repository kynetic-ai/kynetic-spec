/**
 * Shared daemon endpoint module.
 *
 * Single source of truth for daemon network configuration, URL formatting,
 * connection metadata, and PID/port file lifecycle. Used by both the CLI
 * (src/cli/*) and the daemon package (packages/daemon/src/*) to keep
 * localhost / IPv4 / IPv6 / wildcard / port behavior consistent.
 *
 * AC Coverage:
 * - @daemon-network-endpoint-contract ac-default-loopback-v4
 * - @daemon-network-endpoint-contract ac-wildcard-connect-host
 * - @daemon-network-endpoint-contract ac-connection-metadata
 * - @daemon-network-endpoint-contract ac-legacy-port-fallback
 * - @config-daemon ac-host-default
 * - @config-daemon ac-connect-host-config
 * - @config-daemon ac-port-env-precedence
 * - @config-daemon ac-connection-metadata
 * - @multi-directory-daemon ac-9, ac-9b, ac-9c, ac-10, ac-11, ac-13
 */

import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Runtime used to spawn the daemon process.
 */
export type DaemonRuntime = "node" | "bun";

/**
 * Inputs required to resolve a daemon endpoint.
 *
 * `bindHost` is the address the daemon binds to. `connectHost` is an
 * optional explicit override for what local clients should connect to;
 * when omitted, it is derived from `bindHost` (loopback when bind is a
 * wildcard).
 */
export interface DaemonNetworkConfig {
  port: number;
  bindHost: string;
  connectHost?: string;
}

/**
 * Resolved daemon endpoint with bind/connect hosts and the URLs that
 * clients should use. Returned from `resolveDaemonEndpoint`.
 */
export interface DaemonResolvedEndpoint {
  port: number;
  bindHost: string;
  connectHost: string;
  apiUrl: string;
  wsUrl: string;
  /** True when the bind host exposes the daemon outside the loopback. */
  externallyReachable: boolean;
}

/**
 * Daemon connection metadata persisted at
 * ~/.config/kspec/daemon.connection.json so clients can reach a running
 * daemon without re-deriving URLs from a port file alone.
 *
 * Field names use snake_case to match the on-disk JSON contract.
 *
 * AC: @daemon-network-endpoint-contract ac-connection-metadata
 */
export interface DaemonConnectionMetadata {
  pid: number;
  port: number;
  bind_host: string;
  connect_host: string;
  api_url: string;
  ws_url: string;
  runtime: DaemonRuntime;
}

// ── Constants ──────────────────────────────────────────────────────

/** Default daemon port (kept in sync with DEFAULT_CONFIG.daemon.port). */
export const DEFAULT_DAEMON_PORT = 3456;

/**
 * Default bind host for the daemon. Numeric IPv4 loopback avoids
 * /etc/hosts, DNS result ordering, and Node/Bun differences in how
 * `localhost` resolves.
 *
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 * AC: @config-daemon ac-host-default
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

export const LOOPBACK_HOST_V4 = "127.0.0.1";
export const LOOPBACK_HOST_V6 = "::1";
export const WILDCARD_HOST_V4 = "0.0.0.0";
export const WILDCARD_HOST_V6 = "::";

/** Filename for the legacy port-only fallback file. */
export const LEGACY_PORT_FILENAME = "daemon.port";
/** Filename for the new connection metadata file. */
export const CONNECTION_METADATA_FILENAME = "daemon.connection.json";
/** Filename for the daemon PID file. */
export const PID_FILENAME = "daemon.pid";
/**
 * Filename for the daemon operational log. Shared between the daemon's
 * in-process console tee and the CLI lifecycle commands so both resolve
 * the same path.
 * AC: @daemon-log-capture ac-detached-output-captured
 */
export const DAEMON_LOG_FILENAME = "daemon.log";
/**
 * Default maximum size of the active daemon log before rotation (5 MiB).
 * Overridable via daemon.log_max_size_bytes in project config.
 * AC: @daemon-log-capture ac-bounded-rotation
 */
export const DEFAULT_DAEMON_LOG_MAX_SIZE_BYTES = 5 * 1024 * 1024;

// ── Path helpers ───────────────────────────────────────────────────

/**
 * Returns the global kspec config directory (default ~/.config/kspec).
 * Honors a custom directory for tests.
 */
export function getDefaultDaemonConfigDir(): string {
  return join(homedir(), ".config", "kspec");
}

export function getDaemonPidPath(configDir: string = getDefaultDaemonConfigDir()): string {
  return join(configDir, PID_FILENAME);
}

export function getLegacyDaemonPortPath(configDir: string = getDefaultDaemonConfigDir()): string {
  return join(configDir, LEGACY_PORT_FILENAME);
}

export function getDaemonConnectionMetadataPath(
  configDir: string = getDefaultDaemonConfigDir(),
): string {
  return join(configDir, CONNECTION_METADATA_FILENAME);
}

/**
 * Path to the daemon operational log file.
 * AC: @daemon-log-capture ac-log-location-discoverable
 */
export function getDaemonLogPath(configDir: string = getDefaultDaemonConfigDir()): string {
  return join(configDir, DAEMON_LOG_FILENAME);
}

// ── Pure host helpers ──────────────────────────────────────────────

/**
 * Trim whitespace and strip surrounding brackets from IPv6 literals.
 * Throws on empty input. Does not resolve "localhost" — that mapping is
 * intentionally absent so the default 127.0.0.1 path never depends on
 * the OS resolver.
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

// Internal predicate variants assume already-normalized input. Composing
// helpers go through these to avoid re-normalizing the same string 4-5
// times per resolveDaemonEndpoint call.
function isLoopbackNormalized(host: string): boolean {
  return host === LOOPBACK_HOST_V4 || host === LOOPBACK_HOST_V6 || host.startsWith("127.");
}

function isWildcardNormalized(host: string): boolean {
  return host === WILDCARD_HOST_V4 || host === WILDCARD_HOST_V6;
}

/**
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 * AC: @config-daemon ac-host-default
 */
export function resolveDaemonBindHost(config?: { host?: string | null } | null): string {
  const raw = config?.host;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_BIND_HOST;
  }
  return normalizeDaemonHost(raw);
}

/**
 * Map a bind host to the host clients should connect to. Wildcard binds
 * fall back to the explicit connect host when configured, otherwise to
 * the matching loopback (0.0.0.0 → 127.0.0.1, :: → ::1).
 *
 * When `bindHost` is a specific (non-wildcard) address and an explicit
 * `connectHost` is supplied that differs from `bindHost`, the
 * configuration is rejected: a server bound only to a single specific
 * address is not reachable at any other address (even another loopback
 * alias such as 127.0.0.2 against a 127.0.0.1 bind). Advertising an
 * unreachable URL would break clients that honor the metadata.
 *
 * AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @config-daemon ac-connect-host-config
 */
export function resolveDaemonConnectHost(
  bindHost: string,
  explicitConnectHost?: string | null,
): string {
  const normalizedBind = normalizeDaemonHost(bindHost);
  if (explicitConnectHost && explicitConnectHost.trim().length > 0) {
    const normalizedConnect = normalizeDaemonHost(explicitConnectHost);
    if (!isWildcardNormalized(normalizedBind) && normalizedBind !== normalizedConnect) {
      throw new Error(
        `Invalid daemon endpoint configuration: connect_host '${normalizedConnect}' ` +
          `is not reachable for bind_host '${normalizedBind}'. A daemon bound to a ` +
          `specific address only accepts connections at that exact address. Either ` +
          `set bind_host to a wildcard ('${WILDCARD_HOST_V4}' or '${WILDCARD_HOST_V6}') ` +
          `to expose the daemon on multiple interfaces, or remove connect_host so the ` +
          `bind host is used directly.`,
      );
    }
    return normalizedConnect;
  }
  if (normalizedBind === WILDCARD_HOST_V4) return LOOPBACK_HOST_V4;
  if (normalizedBind === WILDCARD_HOST_V6) return LOOPBACK_HOST_V6;
  return normalizedBind;
}

/** Detect IPv6 literals; brackets accepted as input. */
export function isIpv6Literal(host: string): boolean {
  return normalizeDaemonHost(host).includes(":");
}

/** Bracket IPv6 literals for use inside a URL host segment. */
export function formatHostForUrl(host: string): string {
  const normalized = normalizeDaemonHost(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

/**
 * True when the host is a recognized numeric loopback address. DNS
 * names like "localhost" intentionally do NOT count — daemon code
 * resolves to numeric loopback so it does not depend on the OS resolver.
 */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackNormalized(normalizeDaemonHost(host));
}

/** True when the host is a wildcard bind address (0.0.0.0 or ::). */
export function isWildcardHost(host: string): boolean {
  return isWildcardNormalized(normalizeDaemonHost(host));
}

/**
 * True when binding to this host exposes the daemon outside loopback.
 * Wildcards and any non-loopback address count.
 */
export function isExternallyReachable(host: string): boolean {
  return !isLoopbackNormalized(normalizeDaemonHost(host));
}

/**
 * Build api_url and ws_url for a connect host and port. IPv6 literals
 * are bracketed.
 */
export function buildDaemonUrls(
  connectHost: string,
  port: number,
): { apiUrl: string; wsUrl: string } {
  if (!isValidPort(port)) {
    throw new RangeError(`Invalid daemon port: ${port}`);
  }
  const formatted = formatHostForUrl(connectHost);
  return {
    apiUrl: `http://${formatted}:${port}`,
    wsUrl: `ws://${formatted}:${port}/ws`,
  };
}

/**
 * Resolve a complete endpoint from network config. Normalizes the bind
 * host once and reuses it across the connect-host and externally-
 * reachable computations.
 */
export function resolveDaemonEndpoint(config: DaemonNetworkConfig): DaemonResolvedEndpoint {
  const bindHost = normalizeDaemonHost(config.bindHost);
  const connectHost = resolveDaemonConnectHost(bindHost, config.connectHost);
  const { apiUrl, wsUrl } = buildDaemonUrls(connectHost, config.port);
  return {
    port: config.port,
    bindHost,
    connectHost,
    apiUrl,
    wsUrl,
    externallyReachable: !isLoopbackNormalized(bindHost),
  };
}

// ── Bind probing / IPv6 fallback ───────────────────────────────────

/**
 * Reason a bind probe could not bind the requested host:port.
 *
 * - `address_unavailable`: the address itself is unusable on this system
 *   (e.g. 127.0.0.1 when IPv4 loopback is disabled). This is the only
 *   condition that justifies switching protocols (IPv4 → IPv6).
 * - `port_in_use`: the address works but the port is taken by another
 *   process. This is a real conflict that must surface to the user.
 * - `unknown`: every other error. Treated like `port_in_use` — never a
 *   trigger for protocol fallback.
 */
export type ProbeUnavailableReason = "address_unavailable" | "port_in_use" | "unknown";

/**
 * Result of `probeBindAvailable`. When `available` is false, the `reason`
 * lets the caller decide whether to fall back to a different host or
 * surface the error.
 */
export type ProbeBindResult =
  | { available: true }
  | { available: false; reason: ProbeUnavailableReason; code: string | null };

/**
 * Map a Node `errno` code to a probe failure reason. Only address-level
 * errors (the IPv4/IPv6 stack itself is unavailable on this system) map
 * to `address_unavailable`. Port collisions and everything else are
 * preserved as discrete signals so the caller does not silently swap
 * protocols on a real conflict.
 */
function classifyProbeError(code: string | null | undefined): ProbeUnavailableReason {
  if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return "address_unavailable";
  if (code === "EADDRINUSE") return "port_in_use";
  return "unknown";
}

function errorCode(err: unknown): string | null {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/**
 * Probe whether `host:port` can be bound. Opens a transient TCP listener
 * and resolves with `{ available: true }` on `listening`, or
 * `{ available: false, reason, code }` on error. The probe is closed
 * before resolving.
 *
 * Used by daemon startup to detect whether the default IPv4 loopback is
 * unusable on this system. Only `reason: 'address_unavailable'` justifies
 * falling back to ::1 — `port_in_use` is a real conflict the daemon must
 * surface, not silently route around by switching protocols on the same
 * port.
 *
 * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
 */
export function probeBindAvailable(host: string, port: number): Promise<ProbeBindResult> {
  return new Promise((resolve) => {
    const server = createNetServer();
    let settled = false;
    const finish = (result: ProbeBindResult): void => {
      if (settled) return;
      settled = true;
      try {
        server.close(() => resolve(result));
      } catch {
        resolve(result);
      }
    };
    server.once("error", (err: unknown) => {
      const code = errorCode(err);
      finish({ available: false, reason: classifyProbeError(code), code });
    });
    server.once("listening", () => finish({ available: true }));
    try {
      server.listen({ host, port, exclusive: true });
    } catch (err) {
      const code = errorCode(err);
      finish({ available: false, reason: classifyProbeError(code), code });
    }
  });
}

export interface StartupBindSelection {
  bindHost: string;
  fellBackToIpv6: boolean;
}

/**
 * Choose the bind host the daemon should actually use at startup. When
 * the resolved bind host is the default IPv4 loopback AND the user did
 * not explicitly configure a host, probe whether 127.0.0.1 can be bound;
 * fall back to ::1 ONLY when the probe reports the IPv4 loopback address
 * itself is unavailable (EADDRNOTAVAIL / EAFNOSUPPORT).
 *
 * Port-in-use (EADDRINUSE) and other errors do NOT trigger fallback —
 * the caller's actual `app.listen()` call will surface the same error
 * to the user. Silently switching protocols on a port collision would
 * mask a real conflict and start a daemon on the wrong endpoint.
 *
 * Pass `probe = probeBindAvailable` in production. Tests inject a stub.
 *
 * AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
 */
export async function selectStartupBindHost(args: {
  resolvedBindHost: string;
  port: number;
  hostExplicitlyConfigured: boolean;
  probe?: (host: string, port: number) => Promise<ProbeBindResult>;
}): Promise<StartupBindSelection> {
  const probe = args.probe ?? probeBindAvailable;
  const normalized = normalizeDaemonHost(args.resolvedBindHost);
  // Only consider fallback when the user did not configure a host AND
  // the resolved default is the IPv4 loopback. Explicit config is
  // honored verbatim — if the user asked for 127.0.0.1, surface a bind
  // error instead of silently switching protocols.
  if (args.hostExplicitlyConfigured || normalized !== LOOPBACK_HOST_V4) {
    return { bindHost: normalized, fellBackToIpv6: false };
  }
  const result = await probe(LOOPBACK_HOST_V4, args.port);
  if (result.available) {
    return { bindHost: LOOPBACK_HOST_V4, fellBackToIpv6: false };
  }
  // Fall back ONLY when the IPv4 loopback address itself is unavailable
  // on this system. Port collisions and other errors are passed through
  // so the daemon's actual listen() surfaces them to the user verbatim.
  if (result.reason !== "address_unavailable") {
    return { bindHost: LOOPBACK_HOST_V4, fellBackToIpv6: false };
  }
  return { bindHost: LOOPBACK_HOST_V6, fellBackToIpv6: true };
}

// ── Connection metadata I/O ────────────────────────────────────────

// mkdirSync({ recursive: true }) is idempotent, so no pre-existence check.
function ensureConfigDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: 0o755 });
}

function isValidRuntime(value: unknown): value is DaemonRuntime {
  return value === "node" || value === "bun";
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isMissingFileError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if (isMissingFileError(err)) return null;
    return null;
  }
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isMissingFileError(err)) throw err;
  }
}

function isValidConnectionMetadata(value: unknown): value is DaemonConnectionMetadata {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.pid === "number" &&
    Number.isInteger(r.pid) &&
    r.pid > 0 &&
    isValidPort(r.port) &&
    typeof r.bind_host === "string" &&
    r.bind_host.length > 0 &&
    typeof r.connect_host === "string" &&
    r.connect_host.length > 0 &&
    typeof r.api_url === "string" &&
    r.api_url.length > 0 &&
    typeof r.ws_url === "string" &&
    r.ws_url.length > 0 &&
    isValidRuntime(r.runtime)
  );
}

/**
 * Read the daemon connection metadata file. Returns null when the file
 * is absent, unreadable, or contains an invalid record.
 */
export function readDaemonConnectionMetadata(
  configDir: string = getDefaultDaemonConfigDir(),
): DaemonConnectionMetadata | null {
  const raw = readFileOrNull(getDaemonConnectionMetadataPath(configDir));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidConnectionMetadata(parsed)) return null;
  return {
    pid: parsed.pid,
    port: parsed.port,
    bind_host: parsed.bind_host,
    connect_host: parsed.connect_host,
    api_url: parsed.api_url,
    ws_url: parsed.ws_url,
    runtime: parsed.runtime,
  };
}

/**
 * Write the daemon connection metadata file (creates the parent dir).
 * Output is pretty-printed JSON with keys in the declared interface
 * order so the file diffs cleanly between daemon restarts.
 *
 * AC: @daemon-network-endpoint-contract ac-connection-metadata
 */
export function writeDaemonConnectionMetadata(
  metadata: DaemonConnectionMetadata,
  configDir: string = getDefaultDaemonConfigDir(),
): void {
  if (!Number.isInteger(metadata.pid) || metadata.pid <= 0) {
    throw new RangeError(`Invalid daemon pid: ${metadata.pid}`);
  }
  if (!isValidPort(metadata.port)) {
    throw new RangeError(`Invalid daemon port: ${metadata.port}`);
  }
  if (!isValidRuntime(metadata.runtime)) {
    throw new RangeError(`Invalid daemon runtime: ${String(metadata.runtime)}`);
  }
  ensureConfigDir(configDir);
  const ordered: DaemonConnectionMetadata = {
    pid: metadata.pid,
    port: metadata.port,
    bind_host: metadata.bind_host,
    connect_host: metadata.connect_host,
    api_url: metadata.api_url,
    ws_url: metadata.ws_url,
    runtime: metadata.runtime,
  };
  writeFileSync(
    getDaemonConnectionMetadataPath(configDir),
    `${JSON.stringify(ordered, null, 2)}\n`,
    "utf-8",
  );
}

/** Remove the daemon connection metadata file. Safe when absent. */
export function removeDaemonConnectionMetadata(
  configDir: string = getDefaultDaemonConfigDir(),
): void {
  unlinkIfPresent(getDaemonConnectionMetadataPath(configDir));
}

/**
 * Read the legacy global daemon.port file and synthesize a 127.0.0.1
 * connect endpoint. Returns null when the file is absent or invalid.
 *
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 */
export function readLegacyDaemonPortEndpoint(
  configDir: string = getDefaultDaemonConfigDir(),
): { port: number; connectHost: string; apiUrl: string; wsUrl: string } | null {
  const raw = readFileOrNull(getLegacyDaemonPortPath(configDir));
  if (raw === null) return null;
  const port = parseInt(raw.trim(), 10);
  if (!isValidPort(port)) return null;
  const connectHost = LOOPBACK_HOST_V4;
  const { apiUrl, wsUrl } = buildDaemonUrls(connectHost, port);
  return { port, connectHost, apiUrl, wsUrl };
}

/**
 * Resolved client endpoint surface every CLI/daemon client uses to
 * reach the daemon. `source` distinguishes the metadata path (full
 * fidelity, includes bind host and runtime) from the legacy port-file
 * fallback (synthesized 127.0.0.1 endpoint).
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 */
export interface DaemonClientEndpoint {
  port: number;
  connectHost: string;
  apiUrl: string;
  wsUrl: string;
  bindHost: string | null;
  runtime: DaemonRuntime | null;
  pid: number | null;
  source: "metadata" | "legacy-port";
}

/**
 * Resolve the endpoint a client should use to reach the daemon. Reads
 * the new connection metadata first; falls back to the legacy
 * daemon.port file. Returns null when neither is present.
 *
 * Centralises URL construction so command files do not derive daemon
 * URLs from a port number alone — required so daemons advertising a
 * non-loopback connect host (or IPv6 bracket syntax) work correctly.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 */
export function resolveDaemonClientEndpoint(
  configDir: string = getDefaultDaemonConfigDir(),
): DaemonClientEndpoint | null {
  const metadata = readDaemonConnectionMetadata(configDir);
  if (metadata) {
    return {
      port: metadata.port,
      connectHost: metadata.connect_host,
      apiUrl: metadata.api_url,
      wsUrl: metadata.ws_url,
      bindHost: metadata.bind_host,
      runtime: metadata.runtime,
      pid: metadata.pid,
      source: "metadata",
    };
  }
  const legacy = readLegacyDaemonPortEndpoint(configDir);
  if (legacy) {
    return {
      port: legacy.port,
      connectHost: legacy.connectHost,
      apiUrl: legacy.apiUrl,
      wsUrl: legacy.wsUrl,
      bindHost: null,
      runtime: null,
      pid: null,
      source: "legacy-port",
    };
  }
  return null;
}

/**
 * Resolve the api_url / ws_url that the web UI Vite dev server should
 * inject into the browser bundle so the dev client connects to the same
 * URLs the daemon advertises (honoring IPv6 fallback, custom ports, and
 * non-default connect hosts). When no daemon state is present, returns
 * the documented default `http://127.0.0.1:3456` so the dev server still
 * starts before the daemon is launched.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 */
export function resolveDevDaemonEndpoint(configDir: string = getDefaultDaemonConfigDir()): {
  apiUrl: string;
  wsUrl: string;
} {
  const endpoint = resolveDevDaemonEndpointFromMetadata(configDir);
  if (endpoint) return endpoint;
  return buildDaemonUrls(LOOPBACK_HOST_V4, DEFAULT_DAEMON_PORT);
}

/**
 * Resolve the api_url / ws_url from the running daemon's published
 * connection metadata only — returns `null` when no metadata or legacy
 * port file exists. Lets the Vite dev server distinguish "daemon is
 * running, use its advertised URLs" from "no daemon yet, fall back to
 * env-driven host/port or the documented default" so user-provided
 * VITE_KSPEC_DAEMON_HOST / VITE_KSPEC_DAEMON_PORT are not silently
 * overridden by the resolver's hardcoded default.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 */
export function resolveDevDaemonEndpointFromMetadata(
  configDir: string = getDefaultDaemonConfigDir(),
): { apiUrl: string; wsUrl: string } | null {
  const endpoint = resolveDaemonClientEndpoint(configDir);
  if (endpoint) {
    return { apiUrl: endpoint.apiUrl, wsUrl: endpoint.wsUrl };
  }
  return null;
}

// ── KSPEC_NO_DAEMON env helper ─────────────────────────────────────

function isFalsyNoDaemonValue(value: string): boolean {
  switch (value.trim().toLowerCase()) {
    case "":
    case "0":
    case "false":
    case "no":
    case "off":
      return true;
    default:
      return false;
  }
}

/**
 * True when KSPEC_NO_DAEMON is set to a truthy value. CLI code uses
 * this to suppress incidental daemon communication.
 */
export function isNoDaemonModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.KSPEC_NO_DAEMON;
  if (value === undefined) return false;
  return !isFalsyNoDaemonValue(value);
}

// ── PID / port / metadata file manager ─────────────────────────────

function writePidFileExclusive(path: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o644);
  try {
    writeFileSync(fd, process.pid.toString(), "utf-8");
  } finally {
    closeSync(fd);
  }
}

function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Manages the global daemon lifecycle files under ~/.config/kspec/:
 * daemon.pid, daemon.port (legacy), and daemon.connection.json.
 *
 * AC: @multi-directory-daemon ac-9, ac-9b, ac-9c, ac-10, ac-11, ac-13
 */
export class PidFileManager {
  private readonly configDir: string;
  private readonly pidFilePath: string;
  private readonly portFilePath: string;
  private readonly metadataFilePath: string;

  constructor(configDir: string = getDefaultDaemonConfigDir()) {
    this.configDir = configDir;
    this.pidFilePath = getDaemonPidPath(configDir);
    this.portFilePath = getLegacyDaemonPortPath(configDir);
    this.metadataFilePath = getDaemonConnectionMetadataPath(configDir);
  }

  /**
   * AC: @multi-directory-daemon ac-9, ac-10b
   * Writes the current process PID with O_CREAT|O_EXCL. On EEXIST,
   * checks whether the recorded daemon is still alive — if so, throws;
   * if stale, removes the existing files and retries once.
   */
  writePid(): void {
    ensureConfigDir(this.configDir);
    try {
      writePidFileExclusive(this.pidFilePath);
    } catch (err: unknown) {
      if (!isAlreadyExistsError(err)) throw err;
      if (this.isDaemonRunning({ ignoreNoDaemon: true })) {
        throw new Error("Daemon already running", { cause: err });
      }
      this.remove();
      writePidFileExclusive(this.pidFilePath);
    }
  }

  /** AC: @multi-directory-daemon ac-9 */
  writePort(port: number): void {
    if (!isValidPort(port)) {
      throw new RangeError(`Invalid daemon port: ${port}`);
    }
    ensureConfigDir(this.configDir);
    writeFileSync(this.portFilePath, port.toString(), "utf-8");
  }

  /** AC: @daemon-network-endpoint-contract ac-connection-metadata */
  writeConnectionMetadata(metadata: DaemonConnectionMetadata): void {
    writeDaemonConnectionMetadata(metadata, this.configDir);
  }

  readConnectionMetadata(): DaemonConnectionMetadata | null {
    return readDaemonConnectionMetadata(this.configDir);
  }

  /** AC: @daemon-network-endpoint-contract ac-legacy-port-fallback */
  readLegacyEndpoint(): {
    port: number;
    connectHost: string;
    apiUrl: string;
    wsUrl: string;
  } | null {
    return readLegacyDaemonPortEndpoint(this.configDir);
  }

  /** Returns null when the PID file is absent or contains invalid content. */
  readPid(): number | null {
    const raw = readFileOrNull(this.pidFilePath);
    if (raw === null) return null;
    const pid = parseInt(raw.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  }

  /**
   * AC: @multi-directory-daemon ac-9c, ac-13
   * Throws on missing/invalid content so callers can fall back to
   * "no daemon" cleanly.
   */
  readPort(): number {
    const raw = readFileOrNull(this.portFilePath);
    if (raw === null) {
      throw new Error("Invalid daemon port file");
    }
    const port = parseInt(raw.trim(), 10);
    if (!isValidPort(port)) {
      throw new Error("Invalid daemon port file");
    }
    return port;
  }

  /** AC: @multi-directory-daemon ac-11 */
  remove(): void {
    unlinkIfPresent(this.pidFilePath);
    unlinkIfPresent(this.portFilePath);
    unlinkIfPresent(this.metadataFilePath);
  }

  isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * AC: @multi-directory-daemon ac-10
   * Honors KSPEC_NO_DAEMON unless `ignoreNoDaemon: true`. Daemon-side
   * code (writePid stale-check, serve commands) opts out so it always
   * sees the truthful PID-file state.
   */
  isDaemonRunning(opts: { ignoreNoDaemon?: boolean } = {}): boolean {
    if (!opts.ignoreNoDaemon && isNoDaemonModeEnabled()) return false;
    const pid = this.readPid();
    if (pid === null) return false;
    return this.isProcessRunning(pid);
  }

  /** @deprecated Use readPid(). */
  read(): number | null {
    return this.readPid();
  }

  /** @deprecated Use writePid(). */
  write(): void {
    this.writePid();
  }
}
