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
 * These tests stand up an in-process mock daemon via the shared
 * tests/helpers/mock-daemon.ts fixture, write canonical metadata pointing
 * at it, and assert getDaemonStatus() probed the metadata-advertised URL —
 * not a host or port re-derived from anywhere else.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 * AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
 * AC: @daemon-test-mode-boundaries ac-cli-client-tests-use-mock-daemon
 * AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
 * AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
 * AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
 * AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDaemonStatus } from "../src/parser/daemon-status.js";
import {
  cleanupTempDir,
  createIsolatedKspecHome,
  createTempDir,
  type IsolatedKspecHome,
} from "./helpers/cli.js";
import {
  expectedHostHeader,
  probeHostAvailable,
  startMockDaemon,
  writeLegacyDaemonPort,
  writeMockDaemonMetadata,
  type MockDaemonClient,
} from "./helpers/mock-daemon.js";

describe("getDaemonStatus reads from metadata-advertised endpoint", () => {
  let tempDir: string;
  let home: IsolatedKspecHome;
  let originalHome: string | undefined;
  let originalNoDaemon: string | undefined;
  let mock: MockDaemonClient | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-daemon-status-");
    home = await createIsolatedKspecHome(tempDir);
    originalHome = process.env.HOME;
    originalNoDaemon = process.env.KSPEC_NO_DAEMON;
    process.env.HOME = home.homeDir;
    delete process.env.KSPEC_NO_DAEMON;
  });

  afterEach(async () => {
    if (mock) {
      await mock.stop();
      mock = undefined;
    }
    process.env.HOME = originalHome!;
    if (originalNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = originalNoDaemon;
    }
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  // AC: @daemon-test-endpoint-consistency ac-resolved-endpoint-source
  // AC: @daemon-test-endpoint-consistency ac-mock-metadata-fidelity
  // AC: @daemon-test-endpoint-consistency ac-dynamic-port-propagation
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("probes /api/health at the metadata-advertised api_url", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();
    writeMockDaemonMetadata({ home, client: mock! });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.port).toBe(mock!.port);
    expect(status.healthReachable).toBe(true);

    // Mock recorded the probe at the advertised endpoint — proves the URL
    // came from metadata, not from a hardcoded localhost:port.
    const recorded = mock!.requests();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe("/api/health");
    expect(recorded[0].host).toBe(expectedHostHeader("127.0.0.1", mock!.port));
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  // AC: @trait-daemon-endpoint-consumer ac-wildcard-not-destination
  // The metadata explicitly advertises a non-default loopback alias
  // (127.0.0.2). On Linux this address routes to loopback; on macOS /
  // Windows it doesn't. If getDaemonStatus probed `127.0.0.1` instead of
  // honoring metadata, the request would land on the wrong server (or
  // nothing at all on those platforms). The test skips when the alias is
  // not addressable.
  it("honors a non-default connect_host advertised by metadata", async () => {
    if (!(await probeHostAvailable("127.0.0.2"))) {
      console.log("  ⊘ Skipping test - 127.0.0.2 loopback alias not available");
      return;
    }
    mock = (await startMockDaemon({ bindHost: "127.0.0.2" })) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - mock daemon failed to start on 127.0.0.2");
      return;
    }

    writeMockDaemonMetadata({
      home,
      client: mock,
      bindHost: "0.0.0.0",
      connectHost: "127.0.0.2",
    });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.healthReachable).toBe(true);
    const recorded = mock.requests();
    expect(recorded).toHaveLength(1);
    // Host header reflects the URL the client actually called — a
    // request that hardcoded 127.0.0.1 would never reach this server.
    expect(recorded[0].host).toBe(expectedHostHeader("127.0.0.2", mock.port));
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // AC: @daemon-network-endpoint-contract ac-tests-use-resolved-endpoint
  it("honors a bracketed IPv6 api_url advertised by metadata", async () => {
    if (!(await probeHostAvailable("::1"))) {
      console.log("  ⊘ Skipping test - IPv6 loopback (::1) not available");
      return;
    }
    mock = (await startMockDaemon({ bindHost: "::1" })) ?? undefined;
    if (!mock) {
      console.log("  ⊘ Skipping test - IPv6 server failed to start");
      return;
    }

    writeMockDaemonMetadata({ home, client: mock });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.healthReachable).toBe(true);
    const recorded = mock.requests();
    expect(recorded).toHaveLength(1);
    // The Host header includes the bracketed IPv6 literal verbatim,
    // proving the client used the bracketed api_url from metadata
    // rather than re-deriving (which would corrupt the bracket syntax).
    expect(recorded[0].host).toBe(expectedHostHeader("::1", mock.port));
  });

  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  it("falls back to legacy daemon.port and probes 127.0.0.1 at that port", async () => {
    mock = (await startMockDaemon()) ?? undefined;
    expect(mock).toBeDefined();

    // Only the legacy daemon.port file — no daemon.connection.json. Made
    // explicit at the call site via writeLegacyDaemonPort so the legacy
    // fallback path is visible in the test source.
    writeLegacyDaemonPort({ home, port: mock!.port });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.port).toBe(mock!.port);
    expect(status.healthReachable).toBe(true);
    const recorded = mock!.requests();
    expect(recorded).toHaveLength(1);
    // Legacy fallback synthesizes a 127.0.0.1 endpoint at the legacy port.
    expect(recorded[0].host).toBe(expectedHostHeader("127.0.0.1", mock!.port));
  });

  it("returns healthReachable=false when metadata exists but the server is unreachable", async () => {
    // Pick a port that's unlikely to be in use by writing metadata
    // without standing up a server. We construct the metadata directly
    // because writeMockDaemonMetadata expects a live MockDaemonClient.
    const unreachablePort = 1; // privileged port we can't bind to
    const fakeClient: MockDaemonClient = {
      port: unreachablePort,
      bindHost: "127.0.0.1",
      apiUrl: `http://127.0.0.1:${unreachablePort}`,
      wsUrl: `ws://127.0.0.1:${unreachablePort}/ws`,
      requests: () => [],
      stop: async () => {},
    };
    writeMockDaemonMetadata({ home, client: fakeClient });

    const status = await getDaemonStatus();

    expect(status.running).toBe(true);
    expect(status.port).toBe(unreachablePort);
    expect(status.healthReachable).toBe(false);
    expect(status.uptime).toBeNull();
  });
});
