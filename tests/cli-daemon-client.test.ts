/**
 * Tests for the shared CLI daemon client helper.
 *
 * AC Coverage:
 * - @daemon-network-endpoint-contract ac-clients-use-metadata
 * - @daemon-network-endpoint-contract ac-legacy-port-fallback
 * - @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
 * - @trait-daemon-endpoint-consumer ac-wildcard-not-destination
 * - @cli-daemon-proxy ac-force-direct
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";
import { getRunningDaemonClient } from "../src/cli/daemon-client.js";

describe("getRunningDaemonClient", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalNoDaemon: string | undefined;

  beforeEach(async () => {
    tempDir = await createTempDir();
    originalHome = process.env.HOME;
    originalNoDaemon = process.env.KSPEC_NO_DAEMON;
    process.env.HOME = tempDir;
    delete process.env.KSPEC_NO_DAEMON;
  });

  afterEach(async () => {
    process.env.HOME = originalHome!;
    if (originalNoDaemon === undefined) {
      delete process.env.KSPEC_NO_DAEMON;
    } else {
      process.env.KSPEC_NO_DAEMON = originalNoDaemon;
    }
    await cleanupTempDir(tempDir);
  });

  function writePidFile(pid: number): void {
    const configDir = join(tempDir, ".config", "kspec");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "daemon.pid"), String(pid));
  }

  function writeMetadata(metadata: Record<string, unknown>): void {
    const configDir = join(tempDir, ".config", "kspec");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "daemon.connection.json"), JSON.stringify(metadata));
  }

  function writeLegacyPort(port: number): void {
    const configDir = join(tempDir, ".config", "kspec");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "daemon.port"), String(port));
  }

  it("returns null when the daemon PID file is absent", () => {
    writeMetadata({
      pid: 999_999,
      port: 31_234,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: "http://127.0.0.1:31234",
      ws_url: "ws://127.0.0.1:31234/ws",
      runtime: "node",
    });
    expect(getRunningDaemonClient()).toBeNull();
  });

  it("returns null when the PID file points at a non-running process", () => {
    // PID 1 is init on Linux — alive, so for negative case we want a dead one.
    writePidFile(999_999);
    writeMetadata({
      pid: 999_999,
      port: 31_234,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: "http://127.0.0.1:31234",
      ws_url: "ws://127.0.0.1:31234/ws",
      runtime: "node",
    });
    expect(getRunningDaemonClient()).toBeNull();
  });

  // AC: @cli-daemon-proxy ac-force-direct
  // KSPEC_NO_DAEMON=1 must suppress incidental daemon communication via the
  // shared helper, even when both the PID and metadata files exist.
  it("returns null when KSPEC_NO_DAEMON=1 even if daemon files are present", () => {
    writePidFile(process.pid); // live process so PID gate would otherwise pass
    writeMetadata({
      pid: process.pid,
      port: 31_234,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: "http://127.0.0.1:31234",
      ws_url: "ws://127.0.0.1:31234/ws",
      runtime: "node",
    });
    process.env.KSPEC_NO_DAEMON = "1";
    expect(getRunningDaemonClient()).toBeNull();
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @trait-daemon-endpoint-consumer ac-uses-reported-endpoint
  it("returns the metadata-advertised endpoint verbatim when daemon is running", () => {
    writePidFile(process.pid);
    writeMetadata({
      pid: process.pid,
      port: 31_234,
      bind_host: "0.0.0.0",
      connect_host: "127.0.0.2",
      api_url: "http://127.0.0.2:31234",
      ws_url: "ws://127.0.0.2:31234/ws",
      runtime: "bun",
    });
    const endpoint = getRunningDaemonClient();
    expect(endpoint).not.toBeNull();
    expect(endpoint!.apiUrl).toBe("http://127.0.0.2:31234");
    expect(endpoint!.wsUrl).toBe("ws://127.0.0.2:31234/ws");
    expect(endpoint!.connectHost).toBe("127.0.0.2");
    expect(endpoint!.bindHost).toBe("0.0.0.0");
    expect(endpoint!.runtime).toBe("bun");
    expect(endpoint!.source).toBe("metadata");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // Bracketed IPv6 api_url survives the helper unchanged so callers never
  // re-bracket or re-derive URLs from a port number alone.
  it("preserves bracketed IPv6 api_url advertised in metadata", () => {
    writePidFile(process.pid);
    writeMetadata({
      pid: process.pid,
      port: 31_234,
      bind_host: "::1",
      connect_host: "::1",
      api_url: "http://[::1]:31234",
      ws_url: "ws://[::1]:31234/ws",
      runtime: "node",
    });
    const endpoint = getRunningDaemonClient();
    expect(endpoint).not.toBeNull();
    expect(endpoint!.apiUrl).toBe("http://[::1]:31234");
    expect(endpoint!.wsUrl).toBe("ws://[::1]:31234/ws");
    expect(endpoint!.connectHost).toBe("::1");
  });

  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  // When metadata is absent but the legacy daemon.port file exists, the
  // helper synthesizes a 127.0.0.1 endpoint.
  it("synthesizes a 127.0.0.1 endpoint from the legacy daemon.port file", () => {
    writePidFile(process.pid);
    writeLegacyPort(45_678);
    const endpoint = getRunningDaemonClient();
    expect(endpoint).not.toBeNull();
    expect(endpoint!.apiUrl).toBe("http://127.0.0.1:45678");
    expect(endpoint!.connectHost).toBe("127.0.0.1");
    expect(endpoint!.source).toBe("legacy-port");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // Metadata wins over the legacy port file so daemons advertising a
  // non-default connect_host or non-default port are honored.
  it("prefers metadata over legacy daemon.port when both are present", () => {
    writePidFile(process.pid);
    writeLegacyPort(45_678);
    writeMetadata({
      pid: process.pid,
      port: 31_234,
      bind_host: "127.0.0.1",
      connect_host: "127.0.0.1",
      api_url: "http://127.0.0.1:31234",
      ws_url: "ws://127.0.0.1:31234/ws",
      runtime: "node",
    });
    const endpoint = getRunningDaemonClient();
    expect(endpoint).not.toBeNull();
    expect(endpoint!.port).toBe(31_234);
    expect(endpoint!.source).toBe("metadata");
  });
});
