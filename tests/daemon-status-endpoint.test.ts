/**
 * Behavioral regression tests for `getDaemonStatus()` in
 * src/parser/daemon-status.ts.
 *
 * Before centralization, daemon-status.ts hardcoded `http://localhost:<port>`
 * for its `/api/health` probe. The fix is that it now resolves the URL via
 * `getRunningDaemonClient()` so the probe lands on whatever endpoint the
 * running daemon actually advertised in `daemon.connection.json` (honoring
 * IPv6 brackets, custom connect_host, and non-default ports).
 *
 * These tests stand up an in-process HTTP server, write metadata pointing
 * at it, and assert getDaemonStatus() probed the metadata-advertised URL —
 * not a host or port re-derived from anywhere else.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import http from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDaemonStatus } from "../src/parser/daemon-status.js";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";

interface RecordedRequest {
  host: string | null;
  method: string;
  url: string;
}

interface MockDaemon {
  server: http.Server;
  port: number;
  requests: RecordedRequest[];
}

async function startMockDaemonOn(host: string): Promise<MockDaemon | null> {
  return new Promise((resolve) => {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
      requests.push({
        host: req.headers.host ?? null,
        method: req.method ?? "GET",
        url: req.url ?? "",
      });
      if (req.url === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: 42 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once("error", () => {
      try {
        server.close(() => resolve(null));
      } catch {
        resolve(null);
      }
    });
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => resolve(null));
        return;
      }
      resolve({ server, port: addr.port, requests });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => {
      try {
        probe.close(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    try {
      probe.listen({ host: "::1", port: 0, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

function writeFakeDaemonState(
  configDir: string,
  metadata: Record<string, unknown>,
): void {
  mkdirSync(configDir, { recursive: true });
  // PID file holds the test process pid so PidFileManager.isDaemonRunning()
  // passes — we are intentionally pretending the test process is the daemon
  // for the purposes of pid-liveness checks.
  writeFileSync(join(configDir, "daemon.pid"), String(process.pid));
  writeFileSync(join(configDir, "daemon.connection.json"), JSON.stringify(metadata));
}

function writeFakeLegacyPort(configDir: string, port: number): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "daemon.pid"), String(process.pid));
  writeFileSync(join(configDir, "daemon.port"), String(port));
}

describe("getDaemonStatus reads from metadata-advertised endpoint", () => {
  let homeDir: string;
  let configDir: string;
  let originalHome: string | undefined;
  let originalNoDaemon: string | undefined;
  let mock: MockDaemon | undefined;

  beforeEach(async () => {
    homeDir = await createTempDir("kspec-daemon-status-home-");
    configDir = join(homeDir, ".config", "kspec");
    originalHome = process.env.HOME;
    originalNoDaemon = process.env.KSPEC_NO_DAEMON;
    process.env.HOME = homeDir;
    delete process.env.KSPEC_NO_DAEMON;
  });

  afterEach(async () => {
    if (mock) {
      await closeServer(mock.server);
      mock = undefined;
    }
    process.env.HOME = originalHome!;
    if (originalNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = originalNoDaemon;
    }
    await cleanupTempDir(homeDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("probes /api/health at the metadata-advertised api_url", async () => {
    mock = (await startMockDaemonOn("127.0.0.1")) ?? undefined;
    expect(mock).toBeDefined();
    const advertisedPort = mock!.port;

    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: advertisedPort,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: `http://127.0.0.1:${advertisedPort}`,
      ws_url: `ws://127.0.0.1:${advertisedPort}/ws`,
      runtime: "node",
    });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(advertisedPort);
    expect(status.healthReachable).toBe(true);
    expect(status.uptime).toBe(42);

    // Mock recorded the probe at the advertised endpoint — proves the URL
    // came from metadata, not from a hardcoded localhost:port.
    expect(mock!.requests).toHaveLength(1);
    expect(mock!.requests[0].url).toBe("/api/health");
    expect(mock!.requests[0].host).toBe(`127.0.0.1:${advertisedPort}`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  // The metadata explicitly advertises a non-default loopback alias
  // (127.0.0.2). On Linux this address routes to loopback; on macOS /
  // Windows it doesn't. If getDaemonStatus probed `127.0.0.1` instead of
  // honoring metadata, the request would land on the wrong server (or
  // nothing at all on those platforms). The test skips when the alias is
  // not addressable.
  it("honors a non-default connect_host advertised by metadata", async () => {
    mock = (await startMockDaemonOn("127.0.0.2")) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }
    const advertisedPort = mock.port;

    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: advertisedPort,
      bind_host: "0.0.0.0",
      connect_host: "127.0.0.2",
      api_url: `http://127.0.0.2:${advertisedPort}`,
      ws_url: `ws://127.0.0.2:${advertisedPort}/ws`,
      runtime: "node",
    });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.healthReachable).toBe(true);
    expect(mock.requests).toHaveLength(1);
    // Host header reflects the URL the client actually called — a
    // request that hardcoded 127.0.0.1 would never reach this server.
    expect(mock.requests[0].host).toBe(`127.0.0.2:${advertisedPort}`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  it("honors a bracketed IPv6 api_url advertised by metadata", async () => {
    if (!(await ipv6LoopbackAvailable())) {
      console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
      return;
    }
    mock = (await startMockDaemonOn("::1")) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - IPv6 server failed to start");
      return;
    }
    const advertisedPort = mock.port;

    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: advertisedPort,
      bind_host: "::1",
      connect_host: "::1",
      api_url: `http://[::1]:${advertisedPort}`,
      ws_url: `ws://[::1]:${advertisedPort}/ws`,
      runtime: "node",
    });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.healthReachable).toBe(true);
    expect(mock.requests).toHaveLength(1);
    // The Host header includes the bracketed IPv6 literal verbatim,
    // proving the client used the bracketed api_url from metadata
    // rather than re-deriving (which would corrupt the bracket syntax).
    expect(mock.requests[0].host).toBe(`[::1]:${advertisedPort}`);
  });

  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  it("falls back to legacy daemon.port and probes 127.0.0.1 at that port", async () => {
    mock = (await startMockDaemonOn("127.0.0.1")) ?? undefined;
    expect(mock).toBeDefined();
    const advertisedPort = mock!.port;

    // Only the legacy daemon.port file — no daemon.connection.json.
    writeFakeLegacyPort(configDir, advertisedPort);

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.port).toBe(advertisedPort);
    expect(status.healthReachable).toBe(true);
    expect(mock!.requests).toHaveLength(1);
    // Legacy fallback synthesizes a 127.0.0.1 endpoint at the legacy port.
    expect(mock!.requests[0].host).toBe(`127.0.0.1:${advertisedPort}`);
  });

  it("returns healthReachable=false when metadata exists but the server is unreachable", async () => {
    // Pick a port that's unlikely to be in use by writing to it directly
    // without standing up a server.
    writeFakeDaemonState(configDir, {
      pid: process.pid,
      port: 1, // privileged port we can't bind to — connection refused
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: "http://127.0.0.1:1",
      ws_url: "ws://127.0.0.1:1/ws",
      runtime: "node",
    });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.port).toBe(1);
    expect(status.healthReachable).toBe(false);
    expect(status.uptime).toBeNull();
  });
});
