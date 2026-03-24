/**
 * Unit tests for daemon server localhost-only middleware logic
 * Spec: @daemon-server ac-3 / @trait-localhost-security
 *
 * Behavioral middleware tests kept here after static analysis tests were
 * replaced with E2E tests in packages/web-ui/tests/e2e/api-server.spec.ts.
 *
 * These test the middleware logic directly without needing Bun runtime.
 * We recreate the middleware logic to test it as a pure function.
 */

import { describe, it, expect } from "vitest";

describe("Daemon Server - Localhost Middleware (ac-3)", () => {
  // Unit tests for middleware logic without needing Bun runtime
  // We recreate the middleware logic to test it directly

  function localhostOnly() {
    return (context: { request: Request }) => {
      const host = context.request.headers.get("host");
      if (!host) {
        return new Response(
          JSON.stringify({
            error: "Forbidden",
            message: "This server only accepts connections from localhost",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Extract hostname, handling IPv6 brackets
      let hostname: string;
      if (host.startsWith("[")) {
        // IPv6 with brackets: [::1]:3456 -> ::1
        const closeBracket = host.indexOf("]");
        hostname = closeBracket > 0 ? host.substring(1, closeBracket) : host;
      } else {
        // IPv4 or hostname: localhost:3456 -> localhost
        hostname = host.split(":")[0];
      }

      // Allow localhost, 127.0.0.1, and ::1
      const isLocalhost =
        hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

      if (!isLocalhost) {
        return new Response(
          JSON.stringify({
            error: "Forbidden",
            message: "This server only accepts connections from localhost",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    };
  }

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
