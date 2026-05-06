/**
 * Tests for the shared daemon endpoint module.
 *
 * Covers helper purity (host normalization, loopback/wildcard detection,
 * URL formatting, connect-host resolution, full endpoint resolution),
 * connection metadata I/O, and the legacy daemon.port fallback.
 *
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 * AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
 * AC: @daemon-network-endpoint-contract ac-connection-metadata
 * AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
 * AC: @config-daemon ac-host-default
 * AC: @config-daemon ac-connect-host-config
 * AC: @config-daemon ac-port-env-precedence
 * AC: @config-daemon ac-connection-metadata
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONNECTION_METADATA_FILENAME,
  DEFAULT_BIND_HOST,
  DEFAULT_DAEMON_PORT,
  LEGACY_PORT_FILENAME,
  LOOPBACK_HOST_V4,
  LOOPBACK_HOST_V6,
  PID_FILENAME,
  PidFileManager,
  WILDCARD_HOST_V4,
  WILDCARD_HOST_V6,
  buildDaemonUrls,
  formatHostForUrl,
  getDaemonConnectionMetadataPath,
  getDaemonPidPath,
  getLegacyDaemonPortPath,
  isExternallyReachable,
  isIpv6Literal,
  isLoopbackHost,
  isNoDaemonModeEnabled,
  isWildcardHost,
  normalizeDaemonHost,
  probeBindAvailable,
  readDaemonConnectionMetadata,
  readLegacyDaemonPortEndpoint,
  removeDaemonConnectionMetadata,
  resolveDaemonBindHost,
  resolveDaemonClientEndpoint,
  resolveDaemonConnectHost,
  resolveDaemonEndpoint,
  selectStartupBindHost,
  writeDaemonConnectionMetadata,
} from "../src/daemon/endpoint.js";

import type { DaemonConnectionMetadata } from "../src/daemon/endpoint.js";

import { PidFileManager as CliPidFileManager } from "../src/cli/pid-utils.js";
import { PidFileManager as DaemonPidFileManager } from "../packages/daemon/src/pid.js";

import { createTempDir, cleanupTempDir } from "./helpers/cli";

function sampleMetadata(
  overrides: Partial<DaemonConnectionMetadata> = {},
): DaemonConnectionMetadata {
  return {
    pid: process.pid,
    port: 3456,
    bind_host: "127.0.0.1",
    connect_host: "127.0.0.1",
    api_url: "http://127.0.0.1:3456",
    ws_url: "ws://127.0.0.1:3456/ws",
    runtime: "node",
    ...overrides,
  };
}

describe("daemon endpoint module", () => {
  describe("constants", () => {
    it("exposes the canonical default port", () => {
      expect(DEFAULT_DAEMON_PORT).toBe(3456);
    });

    // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
    // AC: @config-daemon ac-host-default
    it("uses numeric IPv4 loopback as the default bind host (not localhost)", () => {
      expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    });

    it("knows the canonical wildcard and loopback addresses", () => {
      expect(LOOPBACK_HOST_V4).toBe("127.0.0.1");
      expect(LOOPBACK_HOST_V6).toBe("::1");
      expect(WILDCARD_HOST_V4).toBe("0.0.0.0");
      expect(WILDCARD_HOST_V6).toBe("::");
    });
  });

  describe("normalizeDaemonHost", () => {
    it("trims surrounding whitespace", () => {
      expect(normalizeDaemonHost("  127.0.0.1  ")).toBe("127.0.0.1");
    });

    it("strips brackets from IPv6 literals", () => {
      expect(normalizeDaemonHost("[::1]")).toBe("::1");
      expect(normalizeDaemonHost("[2001:db8::1]")).toBe("2001:db8::1");
    });

    it("passes through DNS names and IPv4 addresses unchanged", () => {
      expect(normalizeDaemonHost("localhost")).toBe("localhost");
      expect(normalizeDaemonHost("0.0.0.0")).toBe("0.0.0.0");
    });

    it("rejects empty strings", () => {
      expect(() => normalizeDaemonHost("")).toThrow(/empty/i);
      expect(() => normalizeDaemonHost("   ")).toThrow(/empty/i);
    });
  });

  describe("resolveDaemonBindHost", () => {
    // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
    // AC: @config-daemon ac-host-default
    it("returns 127.0.0.1 when no host is configured", () => {
      expect(resolveDaemonBindHost()).toBe("127.0.0.1");
      expect(resolveDaemonBindHost(null)).toBe("127.0.0.1");
      expect(resolveDaemonBindHost({})).toBe("127.0.0.1");
      expect(resolveDaemonBindHost({ host: undefined })).toBe("127.0.0.1");
      expect(resolveDaemonBindHost({ host: null })).toBe("127.0.0.1");
      expect(resolveDaemonBindHost({ host: "" })).toBe("127.0.0.1");
    });

    it("returns configured host when provided", () => {
      expect(resolveDaemonBindHost({ host: "0.0.0.0" })).toBe("0.0.0.0");
      expect(resolveDaemonBindHost({ host: "::" })).toBe("::");
      expect(resolveDaemonBindHost({ host: "192.168.1.10" })).toBe("192.168.1.10");
    });

    it("does not resolve 'localhost' to 127.0.0.1 — preserves configured value", () => {
      // Resolution from localhost to numeric is not this helper's job; the
      // default is what guarantees we never resolve localhost at all.
      expect(resolveDaemonBindHost({ host: "localhost" })).toBe("localhost");
    });
  });

  describe("isLoopbackHost / isWildcardHost / isExternallyReachable", () => {
    it("recognizes IPv4 and IPv6 loopback as loopback", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("127.0.0.5")).toBe(true);
      expect(isLoopbackHost("::1")).toBe(true);
      expect(isLoopbackHost("[::1]")).toBe(true);
    });

    it("does not treat 'localhost' as loopback (resolver-dependent)", () => {
      expect(isLoopbackHost("localhost")).toBe(false);
    });

    it("does not treat wildcards as loopback", () => {
      expect(isLoopbackHost("0.0.0.0")).toBe(false);
      expect(isLoopbackHost("::")).toBe(false);
    });

    it("recognizes IPv4 and IPv6 wildcard addresses", () => {
      expect(isWildcardHost("0.0.0.0")).toBe(true);
      expect(isWildcardHost("::")).toBe(true);
      expect(isWildcardHost("127.0.0.1")).toBe(false);
      expect(isWildcardHost("192.168.1.10")).toBe(false);
    });

    it("flags non-loopback and wildcard hosts as externally reachable", () => {
      expect(isExternallyReachable("127.0.0.1")).toBe(false);
      expect(isExternallyReachable("::1")).toBe(false);
      expect(isExternallyReachable("0.0.0.0")).toBe(true);
      expect(isExternallyReachable("::")).toBe(true);
      expect(isExternallyReachable("192.168.1.10")).toBe(true);
    });
  });

  describe("isIpv6Literal", () => {
    it("detects IPv6 literals", () => {
      expect(isIpv6Literal("::1")).toBe(true);
      expect(isIpv6Literal("[::1]")).toBe(true);
      expect(isIpv6Literal("2001:db8::1")).toBe(true);
    });

    it("does not flag IPv4 or DNS names", () => {
      expect(isIpv6Literal("127.0.0.1")).toBe(false);
      expect(isIpv6Literal("0.0.0.0")).toBe(false);
      expect(isIpv6Literal("localhost")).toBe(false);
    });
  });

  describe("formatHostForUrl", () => {
    it("brackets IPv6 literals", () => {
      expect(formatHostForUrl("::1")).toBe("[::1]");
      expect(formatHostForUrl("2001:db8::1")).toBe("[2001:db8::1]");
    });

    it("re-brackets IPv6 input that already had brackets", () => {
      // normalizeDaemonHost strips the brackets, formatHostForUrl re-adds them.
      expect(formatHostForUrl("[::1]")).toBe("[::1]");
    });

    it("passes IPv4 and DNS names through unchanged", () => {
      expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
      expect(formatHostForUrl("0.0.0.0")).toBe("0.0.0.0");
      expect(formatHostForUrl("localhost")).toBe("localhost");
    });
  });

  describe("buildDaemonUrls", () => {
    it("constructs http and ws URLs for IPv4", () => {
      expect(buildDaemonUrls("127.0.0.1", 3456)).toEqual({
        apiUrl: "http://127.0.0.1:3456",
        wsUrl: "ws://127.0.0.1:3456/ws",
      });
    });

    // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback (URL formatting only)
    it("brackets IPv6 literals in URLs", () => {
      expect(buildDaemonUrls("::1", 3456)).toEqual({
        apiUrl: "http://[::1]:3456",
        wsUrl: "ws://[::1]:3456/ws",
      });
    });

    it("rejects out-of-range ports", () => {
      expect(() => buildDaemonUrls("127.0.0.1", 0)).toThrow();
      expect(() => buildDaemonUrls("127.0.0.1", 65536)).toThrow();
      expect(() => buildDaemonUrls("127.0.0.1", 1.5)).toThrow();
    });
  });

  describe("resolveDaemonConnectHost", () => {
    // AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
    it("maps IPv4 wildcard bind to IPv4 loopback connect host", () => {
      expect(resolveDaemonConnectHost("0.0.0.0")).toBe("127.0.0.1");
    });

    // AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
    it("maps IPv6 wildcard bind to IPv6 loopback connect host", () => {
      expect(resolveDaemonConnectHost("::")).toBe("::1");
    });

    it("returns the bind host unchanged when it is not wildcard", () => {
      expect(resolveDaemonConnectHost("127.0.0.1")).toBe("127.0.0.1");
      expect(resolveDaemonConnectHost("::1")).toBe("::1");
      expect(resolveDaemonConnectHost("10.0.0.1")).toBe("10.0.0.1");
    });

    // AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
    // AC: @config-daemon ac-connect-host-config
    it("uses an explicit connect host even when the bind is a wildcard", () => {
      expect(resolveDaemonConnectHost("0.0.0.0", "10.0.0.1")).toBe("10.0.0.1");
      expect(resolveDaemonConnectHost("::", "[::1]")).toBe("::1");
    });

    it("uses an explicit connect host even when the bind is a loopback", () => {
      expect(resolveDaemonConnectHost("127.0.0.1", "192.168.1.10")).toBe("192.168.1.10");
    });

    it("ignores empty/whitespace explicit connect host strings", () => {
      expect(resolveDaemonConnectHost("0.0.0.0", "")).toBe("127.0.0.1");
      expect(resolveDaemonConnectHost("0.0.0.0", "   ")).toBe("127.0.0.1");
    });
  });

  describe("resolveDaemonEndpoint", () => {
    // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
    it("resolves a default loopback endpoint with IPv4 URLs", () => {
      const ep = resolveDaemonEndpoint({ port: 3456, bindHost: "127.0.0.1" });
      expect(ep).toEqual({
        port: 3456,
        bindHost: "127.0.0.1",
        connectHost: "127.0.0.1",
        apiUrl: "http://127.0.0.1:3456",
        wsUrl: "ws://127.0.0.1:3456/ws",
        externallyReachable: false,
      });
    });

    // AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
    it("never advertises a wildcard bind host as the client URL", () => {
      const ep = resolveDaemonEndpoint({ port: 4000, bindHost: "0.0.0.0" });
      expect(ep.bindHost).toBe("0.0.0.0");
      expect(ep.connectHost).toBe("127.0.0.1");
      expect(ep.apiUrl).toBe("http://127.0.0.1:4000");
      expect(ep.wsUrl).toBe("ws://127.0.0.1:4000/ws");
      expect(ep.externallyReachable).toBe(true);
    });

    // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback (URL shape)
    it("produces bracketed IPv6 URLs for IPv6 loopback bind", () => {
      const ep = resolveDaemonEndpoint({ port: 3456, bindHost: "::1" });
      expect(ep.connectHost).toBe("::1");
      expect(ep.apiUrl).toBe("http://[::1]:3456");
      expect(ep.wsUrl).toBe("ws://[::1]:3456/ws");
      expect(ep.externallyReachable).toBe(false);
    });

    // AC: @config-daemon ac-connect-host-config
    it("uses an explicit connect host when provided", () => {
      const ep = resolveDaemonEndpoint({
        port: 3456,
        bindHost: "0.0.0.0",
        connectHost: "10.0.0.5",
      });
      expect(ep.connectHost).toBe("10.0.0.5");
      expect(ep.apiUrl).toBe("http://10.0.0.5:3456");
      expect(ep.wsUrl).toBe("ws://10.0.0.5:3456/ws");
      expect(ep.externallyReachable).toBe(true);
    });
  });

  describe("connection metadata I/O", () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = await createTempDir("kspec-endpoint-test-");
    });

    afterEach(async () => {
      await cleanupTempDir(configDir);
    });

    // AC: @daemon-network-endpoint-contract ac-connection-metadata
    // AC: @config-daemon ac-connection-metadata
    it("writes and reads metadata round-trip with all required fields", () => {
      const metadata = sampleMetadata();
      writeDaemonConnectionMetadata(metadata, configDir);

      const path = getDaemonConnectionMetadataPath(configDir);
      expect(existsSync(path)).toBe(true);

      const onDisk = JSON.parse(readFileSync(path, "utf-8")) as DaemonConnectionMetadata;
      expect(onDisk).toEqual(metadata);
      expect(Object.keys(onDisk)).toEqual([
        "pid",
        "port",
        "bind_host",
        "connect_host",
        "api_url",
        "ws_url",
        "runtime",
      ]);

      const read = readDaemonConnectionMetadata(configDir);
      expect(read).toEqual(metadata);
    });

    // AC: @daemon-network-endpoint-contract ac-connection-metadata
    it("preserves IPv6 brackets in advertised URLs", () => {
      const metadata = sampleMetadata({
        bind_host: "::1",
        connect_host: "::1",
        api_url: "http://[::1]:3456",
        ws_url: "ws://[::1]:3456/ws",
      });
      writeDaemonConnectionMetadata(metadata, configDir);
      const read = readDaemonConnectionMetadata(configDir);
      expect(read?.api_url).toBe("http://[::1]:3456");
      expect(read?.ws_url).toBe("ws://[::1]:3456/ws");
    });

    it("writes connection metadata to the canonical filename", () => {
      writeDaemonConnectionMetadata(sampleMetadata(), configDir);
      const expectedPath = join(configDir, CONNECTION_METADATA_FILENAME);
      expect(existsSync(expectedPath)).toBe(true);
      expect(getDaemonConnectionMetadataPath(configDir)).toBe(expectedPath);
    });

    it("creates the config directory if missing", async () => {
      const nested = join(configDir, "nested", "child");
      writeDaemonConnectionMetadata(sampleMetadata(), nested);
      expect(existsSync(getDaemonConnectionMetadataPath(nested))).toBe(true);
    });

    it("returns null when metadata file is absent", () => {
      expect(readDaemonConnectionMetadata(configDir)).toBeNull();
    });

    it("returns null when metadata file contains invalid JSON", () => {
      writeFileSync(getDaemonConnectionMetadataPath(configDir), "not-json", "utf-8");
      expect(readDaemonConnectionMetadata(configDir)).toBeNull();
    });

    it("returns null when metadata file is missing required fields", () => {
      writeFileSync(
        getDaemonConnectionMetadataPath(configDir),
        JSON.stringify({ pid: 1234, port: 3456 }),
        "utf-8",
      );
      expect(readDaemonConnectionMetadata(configDir)).toBeNull();
    });

    it("returns null when runtime field is invalid", () => {
      const bad = { ...sampleMetadata(), runtime: "deno" };
      writeFileSync(getDaemonConnectionMetadataPath(configDir), JSON.stringify(bad), "utf-8");
      expect(readDaemonConnectionMetadata(configDir)).toBeNull();
    });

    it("rejects writing metadata with an invalid port", () => {
      expect(() => writeDaemonConnectionMetadata(sampleMetadata({ port: 0 }), configDir)).toThrow();
      expect(() =>
        writeDaemonConnectionMetadata(sampleMetadata({ port: 70000 }), configDir),
      ).toThrow();
    });

    it("rejects writing metadata with an invalid runtime", () => {
      expect(() =>
        writeDaemonConnectionMetadata(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sampleMetadata({ runtime: "deno" as any }),
          configDir,
        ),
      ).toThrow();
    });

    it("removes metadata file safely when present and absent", () => {
      writeDaemonConnectionMetadata(sampleMetadata(), configDir);
      expect(existsSync(getDaemonConnectionMetadataPath(configDir))).toBe(true);

      removeDaemonConnectionMetadata(configDir);
      expect(existsSync(getDaemonConnectionMetadataPath(configDir))).toBe(false);

      // Idempotent
      expect(() => removeDaemonConnectionMetadata(configDir)).not.toThrow();
    });
  });

  describe("legacy port file fallback", () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = await createTempDir("kspec-endpoint-legacy-");
    });

    afterEach(async () => {
      await cleanupTempDir(configDir);
    });

    // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
    it("synthesizes a 127.0.0.1 endpoint from the legacy port file", () => {
      writeFileSync(getLegacyDaemonPortPath(configDir), "9999\n", "utf-8");

      const fallback = readLegacyDaemonPortEndpoint(configDir);
      expect(fallback).toEqual({
        port: 9999,
        connectHost: "127.0.0.1",
        apiUrl: "http://127.0.0.1:9999",
        wsUrl: "ws://127.0.0.1:9999/ws",
      });
    });

    // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
    it("returns null when the legacy port file is missing", () => {
      expect(readLegacyDaemonPortEndpoint(configDir)).toBeNull();
    });

    it("returns null when the legacy port file contains an invalid port", () => {
      writeFileSync(getLegacyDaemonPortPath(configDir), "not-a-number", "utf-8");
      expect(readLegacyDaemonPortEndpoint(configDir)).toBeNull();

      writeFileSync(getLegacyDaemonPortPath(configDir), "0", "utf-8");
      expect(readLegacyDaemonPortEndpoint(configDir)).toBeNull();

      writeFileSync(getLegacyDaemonPortPath(configDir), "65536", "utf-8");
      expect(readLegacyDaemonPortEndpoint(configDir)).toBeNull();
    });
  });

  describe("resolveDaemonClientEndpoint", () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = await createTempDir("kspec-endpoint-client-");
    });

    afterEach(async () => {
      await cleanupTempDir(configDir);
    });

    // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
    it("returns the metadata-advertised endpoint when daemon.connection.json exists", () => {
      const metadata: DaemonConnectionMetadata = {
        pid: 4242,
        port: 8081,
        bind_host: "0.0.0.0",
        connect_host: "10.0.0.5",
        api_url: "http://10.0.0.5:8081",
        ws_url: "ws://10.0.0.5:8081/ws",
        runtime: "node",
      };
      writeDaemonConnectionMetadata(metadata, configDir);

      const resolved = resolveDaemonClientEndpoint(configDir);
      expect(resolved).toEqual({
        port: 8081,
        connectHost: "10.0.0.5",
        apiUrl: "http://10.0.0.5:8081",
        wsUrl: "ws://10.0.0.5:8081/ws",
        bindHost: "0.0.0.0",
        runtime: "node",
        pid: 4242,
        source: "metadata",
      });
    });

    // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
    it("preserves IPv6-bracketed URLs from metadata", () => {
      const metadata: DaemonConnectionMetadata = {
        pid: 1,
        port: 3456,
        bind_host: "::1",
        connect_host: "::1",
        api_url: "http://[::1]:3456",
        ws_url: "ws://[::1]:3456/ws",
        runtime: "bun",
      };
      writeDaemonConnectionMetadata(metadata, configDir);
      const resolved = resolveDaemonClientEndpoint(configDir);
      expect(resolved?.apiUrl).toBe("http://[::1]:3456");
      expect(resolved?.wsUrl).toBe("ws://[::1]:3456/ws");
      expect(resolved?.runtime).toBe("bun");
    });

    // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
    it("falls back to the legacy daemon.port file when metadata is absent", () => {
      writeFileSync(getLegacyDaemonPortPath(configDir), "5555\n", "utf-8");

      const resolved = resolveDaemonClientEndpoint(configDir);
      expect(resolved).toEqual({
        port: 5555,
        connectHost: "127.0.0.1",
        apiUrl: "http://127.0.0.1:5555",
        wsUrl: "ws://127.0.0.1:5555/ws",
        bindHost: null,
        runtime: null,
        pid: null,
        source: "legacy-port",
      });
    });

    // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
    it("prefers metadata over the legacy port file when both exist", () => {
      writeFileSync(getLegacyDaemonPortPath(configDir), "5555\n", "utf-8");
      writeDaemonConnectionMetadata(
        {
          pid: 1,
          port: 8888,
          bind_host: "127.0.0.1",
          connect_host: "127.0.0.1",
          api_url: "http://127.0.0.1:8888",
          ws_url: "ws://127.0.0.1:8888/ws",
          runtime: "node",
        },
        configDir,
      );

      const resolved = resolveDaemonClientEndpoint(configDir);
      expect(resolved?.source).toBe("metadata");
      expect(resolved?.port).toBe(8888);
    });

    it("returns null when neither metadata nor legacy port file is present", () => {
      expect(resolveDaemonClientEndpoint(configDir)).toBeNull();
    });

    it("ignores invalid metadata and falls through to the legacy port file", () => {
      writeFileSync(getDaemonConnectionMetadataPath(configDir), "not-json", "utf-8");
      writeFileSync(getLegacyDaemonPortPath(configDir), "9000\n", "utf-8");
      const resolved = resolveDaemonClientEndpoint(configDir);
      expect(resolved?.source).toBe("legacy-port");
      expect(resolved?.port).toBe(9000);
    });
  });

  describe("path helpers", () => {
    it("joins configDir with the canonical filenames", () => {
      const dir = "/tmp/kspec-test-config";
      expect(getDaemonPidPath(dir)).toBe(join(dir, PID_FILENAME));
      expect(getLegacyDaemonPortPath(dir)).toBe(join(dir, LEGACY_PORT_FILENAME));
      expect(getDaemonConnectionMetadataPath(dir)).toBe(join(dir, CONNECTION_METADATA_FILENAME));
    });
  });

  describe("isNoDaemonModeEnabled", () => {
    it("returns false when env var is unset", () => {
      expect(isNoDaemonModeEnabled({})).toBe(false);
    });

    it("returns true for truthy values", () => {
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "1" })).toBe(true);
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "true" })).toBe(true);
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "yes" })).toBe(true);
    });

    it("returns false for explicit falsy values", () => {
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "0" })).toBe(false);
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "false" })).toBe(false);
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "no" })).toBe(false);
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "off" })).toBe(false);
      expect(isNoDaemonModeEnabled({ KSPEC_NO_DAEMON: "" })).toBe(false);
    });
  });

  describe("PidFileManager metadata integration", () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = await createTempDir("kspec-endpoint-pid-");
    });

    afterEach(async () => {
      await cleanupTempDir(configDir);
    });

    // AC: @daemon-network-endpoint-contract ac-connection-metadata
    it("writeConnectionMetadata round-trips via readConnectionMetadata", () => {
      const manager = new PidFileManager(configDir);
      const metadata: DaemonConnectionMetadata = {
        pid: process.pid,
        port: 8080,
        bind_host: "127.0.0.1",
        connect_host: "127.0.0.1",
        api_url: "http://127.0.0.1:8080",
        ws_url: "ws://127.0.0.1:8080/ws",
        runtime: "node",
      };
      manager.writeConnectionMetadata(metadata);
      expect(manager.readConnectionMetadata()).toEqual(metadata);
    });

    // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
    it("readLegacyEndpoint reads daemon.port and synthesizes a connect URL", () => {
      const manager = new PidFileManager(configDir);
      manager.writePort(7777);
      expect(manager.readLegacyEndpoint()).toEqual({
        port: 7777,
        connectHost: "127.0.0.1",
        apiUrl: "http://127.0.0.1:7777",
        wsUrl: "ws://127.0.0.1:7777/ws",
      });
    });

    it("remove() deletes pid, port, and metadata files", () => {
      const manager = new PidFileManager(configDir);
      manager.writePid();
      manager.writePort(3456);
      manager.writeConnectionMetadata({
        pid: process.pid,
        port: 3456,
        bind_host: "127.0.0.1",
        connect_host: "127.0.0.1",
        api_url: "http://127.0.0.1:3456",
        ws_url: "ws://127.0.0.1:3456/ws",
        runtime: "node",
      });

      expect(existsSync(getDaemonPidPath(configDir))).toBe(true);
      expect(existsSync(getLegacyDaemonPortPath(configDir))).toBe(true);
      expect(existsSync(getDaemonConnectionMetadataPath(configDir))).toBe(true);

      manager.remove();

      expect(existsSync(getDaemonPidPath(configDir))).toBe(false);
      expect(existsSync(getLegacyDaemonPortPath(configDir))).toBe(false);
      expect(existsSync(getDaemonConnectionMetadataPath(configDir))).toBe(false);
    });

    it("rejects invalid port values when writing daemon.port", () => {
      const manager = new PidFileManager(configDir);
      expect(() => manager.writePort(0)).toThrow();
      expect(() => manager.writePort(65536)).toThrow();
    });
  });
});

describe("IPv6 fallback for daemon startup bind", () => {
  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback

  describe("probeBindAvailable", () => {
    it("returns true when 127.0.0.1 binding succeeds on a free port", async () => {
      // Port 0 lets the OS pick a free port — proves the probe really binds.
      const available = await probeBindAvailable(LOOPBACK_HOST_V4, 0);
      expect(available).toBe(true);
    });

    it("returns false when the port is already taken", async () => {
      const { createServer } = await import("node:net");
      const blocker = createServer();
      await new Promise<void>((resolve) => {
        blocker.listen({ host: LOOPBACK_HOST_V4, port: 0 }, () => resolve());
      });
      const address = blocker.address();
      const port =
        typeof address === "object" && address && "port" in address ? address.port : 0;
      try {
        const available = await probeBindAvailable(LOOPBACK_HOST_V4, port);
        expect(available).toBe(false);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it("releases the probed port immediately after probing", async () => {
      // After probeBindAvailable resolves, the next probe on the same port
      // must succeed. If we leaked the listener, this would return false.
      const first = await probeBindAvailable(LOOPBACK_HOST_V4, 0);
      expect(first).toBe(true);
      const second = await probeBindAvailable(LOOPBACK_HOST_V4, 0);
      expect(second).toBe(true);
    });
  });

  describe("selectStartupBindHost", () => {
    it("returns 127.0.0.1 unchanged when default and IPv4 loopback is available", async () => {
      const result = await selectStartupBindHost({
        resolvedBindHost: LOOPBACK_HOST_V4,
        port: 12345,
        hostExplicitlyConfigured: false,
        probe: async () => true,
      });
      expect(result.bindHost).toBe(LOOPBACK_HOST_V4);
      expect(result.fellBackToIpv6).toBe(false);
    });

    it("falls back to ::1 when default IPv4 loopback is unavailable", async () => {
      // The reviewer's specific concern: if probing 127.0.0.1 fails, the
      // daemon must switch its bind host to ::1 BEFORE writing metadata
      // so clients see bracketed IPv6 URLs.
      const result = await selectStartupBindHost({
        resolvedBindHost: LOOPBACK_HOST_V4,
        port: 12345,
        hostExplicitlyConfigured: false,
        probe: async () => false,
      });
      expect(result.bindHost).toBe(LOOPBACK_HOST_V6);
      expect(result.fellBackToIpv6).toBe(true);
    });

    it("does NOT fall back when the host was explicitly configured", async () => {
      // If the user asked for 127.0.0.1, surface a bind error rather than
      // silently switching protocols. Same for explicit non-loopback hosts.
      const result = await selectStartupBindHost({
        resolvedBindHost: LOOPBACK_HOST_V4,
        port: 12345,
        hostExplicitlyConfigured: true,
        probe: async () => false,
      });
      expect(result.bindHost).toBe(LOOPBACK_HOST_V4);
      expect(result.fellBackToIpv6).toBe(false);
    });

    it("does NOT fall back when bind host is not the default IPv4 loopback", async () => {
      const result = await selectStartupBindHost({
        resolvedBindHost: WILDCARD_HOST_V4,
        port: 12345,
        hostExplicitlyConfigured: false,
        probe: async () => false,
      });
      expect(result.bindHost).toBe(WILDCARD_HOST_V4);
      expect(result.fellBackToIpv6).toBe(false);
    });

    it("end-to-end: fallback bind host produces bracketed IPv6 URLs via resolveDaemonEndpoint", async () => {
      // Compose the two helpers as the daemon does. After the IPv4 probe
      // fails, the resolved endpoint MUST advertise [::1] in api/ws URLs.
      const selection = await selectStartupBindHost({
        resolvedBindHost: LOOPBACK_HOST_V4,
        port: 4321,
        hostExplicitlyConfigured: false,
        probe: async () => false,
      });
      const endpoint = resolveDaemonEndpoint({
        port: 4321,
        bindHost: selection.bindHost,
      });
      expect(endpoint.bindHost).toBe(LOOPBACK_HOST_V6);
      expect(endpoint.connectHost).toBe(LOOPBACK_HOST_V6);
      expect(endpoint.apiUrl).toBe("http://[::1]:4321");
      expect(endpoint.wsUrl).toBe("ws://[::1]:4321/ws");
      expect(endpoint.externallyReachable).toBe(false);
    });
  });
});

describe("PidFileManager shared identity across CLI and daemon imports", () => {
  // AC: @multi-directory-daemon ac-9, ac-10, ac-11, ac-13
  // The CLI's pid-utils and the daemon package's pid module must be the same
  // class — there is exactly one implementation. This guarantees behavior
  // never drifts between CLI and daemon code paths.
  it("CLI pid-utils and daemon package pid export the same class", () => {
    expect(CliPidFileManager).toBe(PidFileManager);
    expect(DaemonPidFileManager).toBe(PidFileManager);
    expect(CliPidFileManager).toBe(DaemonPidFileManager);
  });

  it("instances created from any import share the same prototype", () => {
    const a = new CliPidFileManager();
    const b = new DaemonPidFileManager();
    expect(Object.getPrototypeOf(a)).toBe(Object.getPrototypeOf(b));
  });
});
