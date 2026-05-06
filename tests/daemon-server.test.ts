/**
 * Unit tests for daemon server localhost-only middleware logic
 * Spec: @daemon-server ac-3 / @trait-localhost-security
 *
 * Behavioral middleware tests kept here after static analysis tests were
 * replaced with E2E tests in tests/e2e/api-server.spec.ts.
 *
 * These test the middleware logic directly without needing Bun runtime.
 * We recreate the middleware logic to test it as a pure function.
 */

import { describe, it, expect } from "vitest";
import { localhostOnly } from "../dist/daemon/server.js";

describe("Daemon Server - Localhost Middleware (ac-3)", () => {
  // Unit tests for middleware logic without needing Bun runtime
  // We recreate the middleware logic to test it directly

  // AC: @daemon-server ac-3
  // AC: @trait-localhost-security ac-1
  it("should allow localhost hostname", () => {
    const middleware = localhostOnly();
    const mockContext = {
      request: {
        headers: new Map([["host", "localhost:3456"]]) as any,
      },
    };
    mockContext.request.headers.get = (key: string) => (key === "host" ? "localhost:3456" : null);

    const result = middleware(mockContext);
    expect(result).toBeUndefined(); // No rejection = allowed
  });

  // AC: @daemon-server ac-3
  // AC: @trait-localhost-security ac-1
  it("should allow 127.0.0.1 IPv4 address", () => {
    const middleware = localhostOnly();
    const mockContext = {
      request: {
        headers: new Map([["host", "127.0.0.1:3456"]]) as any,
      },
    };
    mockContext.request.headers.get = (key: string) => (key === "host" ? "127.0.0.1:3456" : null);

    const result = middleware(mockContext);
    expect(result).toBeUndefined();
  });

  // AC: @daemon-server ac-3
  // AC: @trait-localhost-security ac-1
  it("should allow ::1 IPv6 address with port", () => {
    const middleware = localhostOnly();
    const mockContext = {
      request: {
        headers: new Map([["host", "[::1]:3456"]]) as any,
      },
    };
    mockContext.request.headers.get = (key: string) => (key === "host" ? "[::1]:3456" : null);

    const result = middleware(mockContext);
    expect(result).toBeUndefined();
  });

  // AC: @daemon-server ac-3
  // AC: @trait-localhost-security ac-2
  it("should reject non-localhost hostname with 403", async () => {
    const middleware = localhostOnly();
    const mockContext = {
      request: {
        headers: new Map([["host", "evil.com"]]) as any,
      },
    };
    mockContext.request.headers.get = (key: string) => (key === "host" ? "evil.com" : null);

    const result = middleware(mockContext) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);

    const body = await result.json();
    expect(body.error).toBe("Forbidden");
    expect(body.message).toContain("localhost");
  });

  // AC: @daemon-server ac-3
  // AC: @trait-localhost-security ac-2
  it("should reject external IP address with 403", async () => {
    const middleware = localhostOnly();
    const mockContext = {
      request: {
        headers: new Map([["host", "192.168.1.100:3456"]]) as any,
      },
    };
    mockContext.request.headers.get = (key: string) =>
      key === "host" ? "192.168.1.100:3456" : null;

    const result = middleware(mockContext) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);

    const body = await result.json();
    expect(body.error).toBe("Forbidden");
  });

  // AC: @trait-localhost-security ac-3 — N/A: daemon does not support external binding configuration
});

describe("Daemon Server - Localhost Middleware (additionalAllowedHosts)", () => {
  function makeRequest(host: string) {
    const mockContext: { request: { headers: { get: (key: string) => string | null } } } = {
      request: {
        headers: {
          get: (key: string) => (key === "host" ? host : null),
        },
      },
    };
    return mockContext;
  }

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  // AC: @config-daemon ac-connect-host-config
  // The middleware accepts the daemon's resolved/advertised connect host
  // beyond the default localhost set so requests to the metadata-advertised
  // URL succeed when external binding is explicitly configured.
  it("accepts a non-default connect host listed in additionalAllowedHosts", () => {
    const middleware = localhostOnly({ additionalAllowedHosts: ["127.0.0.2"] });
    expect(middleware(makeRequest("127.0.0.2:3456"))).toBeUndefined();
    expect(middleware(makeRequest("127.0.0.2"))).toBeUndefined();
  });

  // AC: @config-daemon ac-connect-host-config
  it("accepts a non-loopback bind host listed in additionalAllowedHosts", () => {
    const middleware = localhostOnly({ additionalAllowedHosts: ["192.168.1.5"] });
    expect(middleware(makeRequest("192.168.1.5:3456"))).toBeUndefined();
  });

  // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
  it("still rejects hosts NOT in the allow-list with 403", async () => {
    const middleware = localhostOnly({ additionalAllowedHosts: ["127.0.0.2"] });
    const result = middleware(makeRequest("evil.com:3456")) as Response;
    expect(result).toBeInstanceOf(Response);
    expect(result.status).toBe(403);
  });

  // AC: @daemon-network-endpoint-contract ac-wildcard-connect-host
  // Wildcard addresses are bind targets, not real hosts — they must not
  // become accepted Host header values even if accidentally passed in.
  it("filters wildcard addresses out of the allow-list", async () => {
    const middleware = localhostOnly({ additionalAllowedHosts: ["0.0.0.0", "::"] });
    const v4Result = middleware(makeRequest("0.0.0.0:3456")) as Response;
    expect(v4Result.status).toBe(403);
    const v6Result = middleware(makeRequest("[::]:3456")) as Response;
    expect(v6Result.status).toBe(403);
  });

  it("accepts bracketed IPv6 hosts in additionalAllowedHosts", () => {
    const middleware = localhostOnly({ additionalAllowedHosts: ["[2001:db8::1]"] });
    expect(middleware(makeRequest("[2001:db8::1]:3456"))).toBeUndefined();
  });

  it("ignores empty/whitespace entries in additionalAllowedHosts", () => {
    const middleware = localhostOnly({ additionalAllowedHosts: ["", "  ", "127.0.0.2"] });
    expect(middleware(makeRequest("127.0.0.2:3456"))).toBeUndefined();
    const reject = middleware(makeRequest("evil.com:3456")) as Response;
    expect(reject.status).toBe(403);
  });

  // The default (no options) behavior is unchanged — preserved separately
  // so callers that don't configure external binding stay loopback-only.
  it("default options (no additionalAllowedHosts) still enforces localhost-only", async () => {
    const middleware = localhostOnly();
    expect(middleware(makeRequest("localhost:3456"))).toBeUndefined();
    expect(middleware(makeRequest("127.0.0.1:3456"))).toBeUndefined();
    const reject = middleware(makeRequest("127.0.0.2:3456")) as Response;
    expect(reject.status).toBe(403);
  });
});
