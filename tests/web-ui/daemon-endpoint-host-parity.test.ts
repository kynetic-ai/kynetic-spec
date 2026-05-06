/**
 * Parity test for the browser-safe daemon host-formatting helpers.
 *
 * The web UI cannot import the Node-only src/daemon-shared/endpoint
 * module directly (it pulls node:fs, node:net, node:os, etc.), so the
 * pure host-formatting helpers are mirrored in
 * packages/web-ui/src/lib/daemon-endpoint-host.ts. This test loads both
 * modules and verifies they agree on every host shape we care about
 * (defaults, IPv4 loopback, IPv6 loopback, bracketed IPv6 input,
 * non-loopback configured hosts, and URL construction with the canonical
 * default port).
 *
 * If any mirrored helper drifts from the Node implementation, this test
 * fails — keeping the two in lockstep without forcing the daemon module
 * to be browser-safe.
 *
 * AC: @daemon-network-endpoint-contract ac-clients-use-metadata
 * AC: @daemon-network-endpoint-contract ac-default-loopback-v4
 */

import { describe, it, expect } from "vitest";

import * as nodeEndpoint from "../../src/daemon-shared/endpoint";
import * as browserEndpoint from "../../packages/web-ui/src/lib/daemon-endpoint-host";

const HOST_CASES = [
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "::",
  "192.0.2.10",
  "[2001:db8::1]",
  "2001:db8::1",
];

describe("daemon-endpoint-host parity with Node module", () => {
  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("DEFAULT_DAEMON_PORT matches the Node module", () => {
    expect(browserEndpoint.DEFAULT_DAEMON_PORT).toBe(nodeEndpoint.DEFAULT_DAEMON_PORT);
  });

  // AC: @daemon-network-endpoint-contract ac-default-loopback-v4
  it("DEFAULT_BIND_HOST matches the Node module", () => {
    expect(browserEndpoint.DEFAULT_BIND_HOST).toBe(nodeEndpoint.DEFAULT_BIND_HOST);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("normalizeDaemonHost agrees on every host shape", () => {
    for (const host of HOST_CASES) {
      expect(browserEndpoint.normalizeDaemonHost(host)).toBe(
        nodeEndpoint.normalizeDaemonHost(host),
      );
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("normalizeDaemonHost rejects empty input identically", () => {
    expect(() => browserEndpoint.normalizeDaemonHost("")).toThrow();
    expect(() => nodeEndpoint.normalizeDaemonHost("")).toThrow();
    expect(() => browserEndpoint.normalizeDaemonHost("   ")).toThrow();
    expect(() => nodeEndpoint.normalizeDaemonHost("   ")).toThrow();
  });

  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  it("isIpv6Literal agrees on every host shape", () => {
    for (const host of HOST_CASES) {
      expect(browserEndpoint.isIpv6Literal(host)).toBe(nodeEndpoint.isIpv6Literal(host));
    }
  });

  // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
  it("formatHostForUrl brackets IPv6 identically", () => {
    for (const host of HOST_CASES) {
      expect(browserEndpoint.formatHostForUrl(host)).toBe(nodeEndpoint.formatHostForUrl(host));
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("buildDaemonUrls produces identical URLs for each host + default port", () => {
    for (const host of HOST_CASES) {
      const browser = browserEndpoint.buildDaemonUrls(host, browserEndpoint.DEFAULT_DAEMON_PORT);
      const node = nodeEndpoint.buildDaemonUrls(host, nodeEndpoint.DEFAULT_DAEMON_PORT);
      expect(browser).toEqual(node);
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("buildDaemonUrls produces identical URLs for non-default ports", () => {
    for (const host of HOST_CASES) {
      for (const port of [1, 3456, 4321, 65535]) {
        expect(browserEndpoint.buildDaemonUrls(host, port)).toEqual(
          nodeEndpoint.buildDaemonUrls(host, port),
        );
      }
    }
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("buildDaemonUrls rejects invalid ports identically", () => {
    for (const port of [0, -1, 65536, 1.5, NaN]) {
      expect(() => browserEndpoint.buildDaemonUrls("127.0.0.1", port)).toThrow(RangeError);
      expect(() => nodeEndpoint.buildDaemonUrls("127.0.0.1", port)).toThrow(RangeError);
    }
  });
});

describe("parseDaemonPort (browser-only helper)", () => {
  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("returns the parsed port when valid", () => {
    expect(browserEndpoint.parseDaemonPort("4321", browserEndpoint.DEFAULT_DAEMON_PORT)).toBe(4321);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("returns the fallback when the value is undefined, empty, or not numeric", () => {
    expect(browserEndpoint.parseDaemonPort(undefined, 9000)).toBe(9000);
    expect(browserEndpoint.parseDaemonPort("", 9000)).toBe(9000);
    expect(browserEndpoint.parseDaemonPort("   ", 9000)).toBe(9000);
    expect(browserEndpoint.parseDaemonPort("not-a-port", 9000)).toBe(9000);
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("returns the fallback when the value is out of range", () => {
    expect(browserEndpoint.parseDaemonPort("0", 9000)).toBe(9000);
    expect(browserEndpoint.parseDaemonPort("65536", 9000)).toBe(9000);
    expect(browserEndpoint.parseDaemonPort("-1", 9000)).toBe(9000);
  });
});
