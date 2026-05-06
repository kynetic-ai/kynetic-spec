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
 * AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
 */
export function resolveDaemonConnectHost(
  bindHost: string,
  explicitConnectHost?: string | null,
): string {
  if (explicitConnectHost && explicitConnectHost.trim().length > 0) {
    return normalizeDaemonHost(explicitConnectHost);
  }
  const normalized = normalizeDaemonHost(bindHost);
  if (normalized === WILDCARD_HOST_V4) return LOOPBACK_HOST_V4;
  if (normalized === WILDCARD_HOST_V6) return LOOPBACK_HOST_V6;
  return normalized;
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
