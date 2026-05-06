/**
 * Behavioral tests for the helper the web UI Vite dev server uses to
 * resolve the daemon endpoint at dev-server start.
 *
 * The Vite config (packages/web-ui/vite.config.ts) calls
 * resolveDevDaemonEndpoint() and injects the returned api_url / ws_url
 * into the browser bundle. This test verifies the resolution rules:
 *
 *   1. Use daemon connection metadata when present (full fidelity —
 *      honors IPv6 fallback, custom ports, and non-default connect
 *      hosts the daemon actually advertises).
 *   2. Fall back to the legacy daemon.port file (synthesizes a
 *      127.0.0.1 endpoint).
 *   3. Fall back to 127.0.0.1:3456 when no daemon state exists, so
 *      `npm run dev` works before the daemon is started.
 *
 * The combination addresses the cycle-2 reviewer blocker that the dev
 * client constructed http://localhost:3456 directly instead of going
 * through the shared resolver.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONNECTION_METADATA_FILENAME,
  DEFAULT_DAEMON_PORT,
  LEGACY_PORT_FILENAME,
  LOOPBACK_HOST_V4,
  resolveDevDaemonEndpoint,
  resolveDevDaemonEndpointFromMetadata,
} from "../../src/daemon-shared/endpoint";

import { createTempDir, cleanupTempDir } from "../helpers/cli";

describe("resolveDevDaemonEndpoint (web UI vite dev server integration)", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await createTempDir("kspec-vite-endpoint-test-");
  });

  afterEach(async () => {
    await cleanupTempDir(configDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("returns the daemon-advertised api_url and ws_url when metadata is present", () => {
    writeFileSync(
      join(configDir, CONNECTION_METADATA_FILENAME),
      `${JSON.stringify(
        {
          pid: 12345,
          port: 4321,
          bind_host: "::1",
          connect_host: "::1",
          api_url: "http://[::1]:4321",
          ws_url: "ws://[::1]:4321/ws",
          runtime: "node",
        },
        null,
        2,
      )}\n`,
    );

    const { apiUrl, wsUrl } = resolveDevDaemonEndpoint(configDir);
    expect(apiUrl).toBe("http://[::1]:4321");
    expect(wsUrl).toBe("ws://[::1]:4321/ws");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("preserves a non-default connect host advertised by the daemon", () => {
    writeFileSync(
      join(configDir, CONNECTION_METADATA_FILENAME),
      `${JSON.stringify(
        {
          pid: 12345,
          port: 9000,
          bind_host: "0.0.0.0",
          connect_host: "192.0.2.10",
          api_url: "http://192.0.2.10:9000",
          ws_url: "ws://192.0.2.10:9000/ws",
          runtime: "node",
        },
        null,
        2,
      )}\n`,
    );

    const { apiUrl, wsUrl } = resolveDevDaemonEndpoint(configDir);
    expect(apiUrl).toBe("http://192.0.2.10:9000");
    expect(wsUrl).toBe("ws://192.0.2.10:9000/ws");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  it("falls back to the legacy daemon.port file when no metadata is present", () => {
    writeFileSync(join(configDir, LEGACY_PORT_FILENAME), "7777");

    const { apiUrl, wsUrl } = resolveDevDaemonEndpoint(configDir);
    // Legacy fallback synthesizes a 127.0.0.1 endpoint — the resolver
    // does not know what host the daemon actually bound to.
    expect(apiUrl).toBe("http://127.0.0.1:7777");
    expect(wsUrl).toBe("ws://127.0.0.1:7777/ws");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("returns the documented 127.0.0.1:3456 default when no daemon state exists", () => {
    // Empty configDir — neither metadata nor legacy port file exists.
    const { apiUrl, wsUrl } = resolveDevDaemonEndpoint(configDir);
    expect(apiUrl).toBe(`http://${LOOPBACK_HOST_V4}:${DEFAULT_DAEMON_PORT}`);
    expect(wsUrl).toBe(`ws://${LOOPBACK_HOST_V4}:${DEFAULT_DAEMON_PORT}/ws`);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("prefers metadata over the legacy port file when both exist", () => {
    writeFileSync(
      join(configDir, CONNECTION_METADATA_FILENAME),
      `${JSON.stringify(
        {
          pid: 12345,
          port: 4321,
          bind_host: "127.0.0.1",
          connect_host: "127.0.0.1",
          api_url: "http://127.0.0.1:4321",
          ws_url: "ws://127.0.0.1:4321/ws",
          runtime: "node",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(configDir, LEGACY_PORT_FILENAME), "9999");

    const { apiUrl, wsUrl } = resolveDevDaemonEndpoint(configDir);
    // Metadata wins — port 4321 (not 9999 from the legacy file).
    expect(apiUrl).toBe("http://127.0.0.1:4321");
    expect(wsUrl).toBe("ws://127.0.0.1:4321/ws");
  });
});

describe("resolveDevDaemonEndpointFromMetadata (vite.config.ts conditional inject)", () => {
  let configDir: string;

  beforeEach(async () => {
    configDir = await createTempDir("kspec-vite-endpoint-from-meta-");
  });

  afterEach(async () => {
    await cleanupTempDir(configDir);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("returns the daemon-advertised api_url and ws_url when metadata is present", () => {
    writeFileSync(
      join(configDir, CONNECTION_METADATA_FILENAME),
      `${JSON.stringify(
        {
          pid: 12345,
          port: 4321,
          bind_host: "127.0.0.1",
          connect_host: "127.0.0.1",
          api_url: "http://127.0.0.1:4321",
          ws_url: "ws://127.0.0.1:4321/ws",
          runtime: "node",
        },
        null,
        2,
      )}\n`,
    );

    const result = resolveDevDaemonEndpointFromMetadata(configDir);
    expect(result).not.toBeNull();
    expect(result?.apiUrl).toBe("http://127.0.0.1:4321");
    expect(result?.wsUrl).toBe("ws://127.0.0.1:4321/ws");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @daemon-network-endpoint-contract ac-legacy-port-fallback
  it("returns the legacy daemon.port endpoint when only legacy state exists", () => {
    writeFileSync(join(configDir, LEGACY_PORT_FILENAME), "7777");

    const result = resolveDevDaemonEndpointFromMetadata(configDir);
    expect(result).not.toBeNull();
    expect(result?.apiUrl).toBe("http://127.0.0.1:7777");
    expect(result?.wsUrl).toBe("ws://127.0.0.1:7777/ws");
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("returns null when no daemon state exists so user-provided env vars take effect", () => {
    // Empty configDir — neither metadata nor legacy port file exists.
    // The Vite config uses null to skip the define so user-provided
    // VITE_KSPEC_DAEMON_HOST / VITE_KSPEC_DAEMON_PORT (or the documented
    // numeric default in constants.ts) are honored instead of silently
    // overridden by the resolver's hardcoded fallback.
    expect(resolveDevDaemonEndpointFromMetadata(configDir)).toBeNull();
  });
});

describe("web UI constants module reads injected dev URLs", () => {
  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  //
  // The reviewer's cycle-2 blocker was that constants.ts produced
  // http://localhost:3456 in dev mode regardless of daemon metadata.
  // After the fix, in dev mode it MUST read the URLs that vite.config.ts
  // injected via VITE_KSPEC_DAEMON_API_URL / VITE_KSPEC_DAEMON_WS_URL
  // (the shared resolver populates these from daemon-advertised
  // metadata at dev-server start).
  //
  // We verify that contract by stubbing both the dev-mode flag and the
  // injected env vars, then re-importing the constants module.
  it("uses injected VITE_KSPEC_DAEMON_API_URL / WS_URL when dev mode is active", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("DEV", true as unknown as string);
    vi.stubEnv("VITE_KSPEC_DAEMON_API_URL", "http://[::1]:4321");
    vi.stubEnv("VITE_KSPEC_DAEMON_WS_URL", "ws://[::1]:4321/ws");
    try {
      vi.resetModules();
      const constants = await import(
        /* @vite-ignore */ `../../packages/web-ui/src/lib/constants?stub=${Date.now()}`
      );
      expect(constants.DAEMON_API_BASE).toBe("http://[::1]:4321");
      // DAEMON_WS_BASE strips the trailing /ws so existing call sites
      // can append their own path (e.g., `${BASE}/ws`).
      expect(constants.DAEMON_WS_BASE).toBe("ws://[::1]:4321");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("falls back to 127.0.0.1:3456 when the dev URL env vars are unset", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("DEV", true as unknown as string);
    // Explicitly clear the daemon URL env vars so the fallback kicks in
    // even if the test runner started with them set.
    vi.stubEnv("VITE_KSPEC_DAEMON_API_URL", "");
    vi.stubEnv("VITE_KSPEC_DAEMON_WS_URL", "");
    vi.stubEnv("VITE_KSPEC_DAEMON_HOST", "");
    vi.stubEnv("VITE_KSPEC_DAEMON_PORT", "");
    try {
      vi.resetModules();
      const constants = await import(
        /* @vite-ignore */ `../../packages/web-ui/src/lib/constants?stub=${Date.now()}`
      );
      // Empty string is falsy in the nullish-coalescing chain —
      // constants treats it as unset and uses the documented default.
      // The fallback is intentionally 127.0.0.1 (numeric) so it does
      // not depend on /etc/hosts or DNS.
      expect(constants.DAEMON_API_BASE).toBe("http://127.0.0.1:3456");
      expect(constants.DAEMON_WS_BASE).toBe("ws://127.0.0.1:3456");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // VITE_KSPEC_DAEMON_HOST + VITE_KSPEC_DAEMON_PORT let the user point
  // the dev client at a non-default daemon endpoint without the daemon
  // having published its connection metadata yet.
  it("honors VITE_KSPEC_DAEMON_HOST and VITE_KSPEC_DAEMON_PORT when URL env vars are unset", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("DEV", true as unknown as string);
    vi.stubEnv("VITE_KSPEC_DAEMON_API_URL", "");
    vi.stubEnv("VITE_KSPEC_DAEMON_WS_URL", "");
    vi.stubEnv("VITE_KSPEC_DAEMON_HOST", "192.0.2.10");
    vi.stubEnv("VITE_KSPEC_DAEMON_PORT", "4321");
    try {
      vi.resetModules();
      const constants = await import(
        /* @vite-ignore */ `../../packages/web-ui/src/lib/constants?stub=${Date.now()}`
      );
      expect(constants.DAEMON_API_BASE).toBe("http://192.0.2.10:4321");
      expect(constants.DAEMON_WS_BASE).toBe("ws://192.0.2.10:4321");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  // IPv6 host values must be bracketed in the constructed URLs (the
  // mirror's formatHostForUrl handles this) — the constants module
  // must not produce ws://::1:3456/ which is invalid.
  it("brackets IPv6 hosts from VITE_KSPEC_DAEMON_HOST", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("DEV", true as unknown as string);
    vi.stubEnv("VITE_KSPEC_DAEMON_API_URL", "");
    vi.stubEnv("VITE_KSPEC_DAEMON_WS_URL", "");
    vi.stubEnv("VITE_KSPEC_DAEMON_HOST", "::1");
    vi.stubEnv("VITE_KSPEC_DAEMON_PORT", "4321");
    try {
      vi.resetModules();
      const constants = await import(
        /* @vite-ignore */ `../../packages/web-ui/src/lib/constants?stub=${Date.now()}`
      );
      expect(constants.DAEMON_API_BASE).toBe("http://[::1]:4321");
      expect(constants.DAEMON_WS_BASE).toBe("ws://[::1]:4321");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // The injected URL env vars (populated by Vite from the daemon's
  // published metadata) win over the user-provided HOST/PORT, because
  // a running daemon's actually-advertised endpoint is the source of
  // truth — the user override is a fallback for the no-metadata case.
  it("prefers VITE_KSPEC_DAEMON_API_URL over VITE_KSPEC_DAEMON_HOST + PORT", async () => {
    const { vi } = await import("vitest");
    vi.stubEnv("DEV", true as unknown as string);
    vi.stubEnv("VITE_KSPEC_DAEMON_API_URL", "http://[::1]:9999");
    vi.stubEnv("VITE_KSPEC_DAEMON_WS_URL", "ws://[::1]:9999/ws");
    vi.stubEnv("VITE_KSPEC_DAEMON_HOST", "192.0.2.10");
    vi.stubEnv("VITE_KSPEC_DAEMON_PORT", "4321");
    try {
      vi.resetModules();
      const constants = await import(
        /* @vite-ignore */ `../../packages/web-ui/src/lib/constants?stub=${Date.now()}`
      );
      // URL env vars (from daemon metadata) win over HOST + PORT.
      expect(constants.DAEMON_API_BASE).toBe("http://[::1]:9999");
      expect(constants.DAEMON_WS_BASE).toBe("ws://[::1]:9999");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
