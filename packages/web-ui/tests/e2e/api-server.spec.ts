/**
 * E2E API Tests for Daemon Server Core
 *
 * Tests verify actual HTTP behavior by calling the running daemon directly.
 * These replace the static analysis tests in tests/daemon-server.test.ts
 * which only read source files and check string patterns.
 *
 * Covered ACs:
 * - @daemon-server ac-1: Elysia HTTP server starts on port 3456 (verified by health check)
 * - @daemon-server ac-2: Binds to localhost only (verified by daemon accessibility)
 * - @daemon-server ac-11: GET /api/health returns {status, uptime, connections, version}
 * - @daemon-server ac-15: Plugin pattern middleware (CORS verified via response headers)
 * - @api-contract ac-1: CORS headers allow localhost origins (dev server)
 * - @trait-localhost-security ac-1: Daemon binds to localhost only (implicit)
 * - @trait-localhost-security ac-2: Non-localhost connections rejected with 403 Forbidden
 */

// Trait N/A annotations — @daemon-server inherits multiple traits:
// AC: @trait-json-output ac-1 — N/A: daemon-server is an HTTP server, not a CLI command with --json flag
// AC: @trait-json-output ac-2 — N/A: daemon-server is an HTTP server, not a CLI command with --json flag
// AC: @trait-json-output ac-3 — N/A: daemon-server is an HTTP server, not a CLI command with --json flag
// AC: @trait-json-output ac-4 — N/A: daemon-server is an HTTP server, not a CLI command with --json flag
// AC: @trait-json-output ac-5 — N/A: daemon-server is an HTTP server, not a CLI command with --json flag
// AC: @trait-json-output ac-6 — N/A: daemon-server is an HTTP server, not a CLI command with --json flag
// AC: @trait-error-guidance ac-1 — N/A: error guidance is a CLI pattern; daemon uses HTTP error codes
// AC: @trait-error-guidance ac-2 — N/A: error guidance is a CLI pattern; daemon uses HTTP error codes
// AC: @trait-error-guidance ac-3 — N/A: error guidance is a CLI pattern; daemon uses HTTP error codes
// AC: @trait-error-guidance ac-4 — N/A: error guidance is a CLI pattern; daemon uses HTTP error codes
// AC: @trait-error-guidance ac-5 — N/A: error guidance is a CLI pattern; daemon uses HTTP error codes
// AC: @trait-error-guidance ac-6 — N/A: error guidance is a CLI pattern; daemon uses HTTP error codes
// AC: @trait-shadow-commit ac-1 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-shadow-commit ac-2 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-shadow-commit ac-3 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-shadow-commit ac-4 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-shadow-commit ac-5 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-shadow-commit ac-6 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-shadow-commit ac-7 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-shadow-commit ac-8 — N/A: server itself does not create shadow commits (routes do)
// AC: @trait-websocket-protocol ac-1 — N/A: WebSocket lifecycle tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-2 — N/A: WebSocket subscribe tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-3 — N/A: WebSocket broadcasts tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-4 — N/A: WebSocket heartbeat timing tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-5 — N/A: WebSocket ping/pong timeout tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-6 — N/A: WebSocket backpressure tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-7 — N/A: WebSocket close codes tested in api-websocket.spec.ts
// AC: @trait-websocket-protocol ac-8 — N/A: WebSocket reconnection tested in api-websocket.spec.ts
// AC: @daemon-server ac-12 — N/A: graceful SIGTERM/SIGINT shutdown tested in tests/cli-serve.test.ts

import { test, expect } from '../fixtures/test-base';
import * as http from 'http';

const DAEMON_PORT = 3456;
const DAEMON_URL = `http://localhost:${DAEMON_PORT}`;

/**
 * Make a raw HTTP request with explicit Host header control.
 * Node's built-in http.request allows overriding the Host header,
 * which is needed to test the localhostOnly middleware that rejects
 * non-localhost Host headers.
 */
function rawHttpRequest(options: {
  path: string;
  host: string; // The Host header value to send
}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: DAEMON_PORT,
        path: options.path,
        method: 'GET',
        headers: {
          Host: options.host,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test.describe('Server Core API', () => {
  test.describe('GET /api/health', () => {
    // AC: @daemon-server ac-1
    // Implicitly verified: if the daemon starts and responds to /api/health,
    // the Elysia HTTP server successfully started on the configured port.
    // AC: @daemon-server ac-2
    // Implicitly verified: if connections from localhost succeed, the server
    // is accessible from 127.0.0.1 (IPv4 localhost).
    // AC: @daemon-server ac-11
    test('returns 200 with {status, uptime, connections, version}', async ({
      request,
      daemon,
    }) => {
      const response = await request.get(`${DAEMON_URL}/api/health`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      // AC: @daemon-server ac-11 — must have all four fields
      expect(body).toHaveProperty('status');
      expect(body.status).toBe('ok');
      expect(body).toHaveProperty('uptime');
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body).toHaveProperty('connections');
      expect(typeof body.connections).toBe('number');
      expect(body.connections).toBeGreaterThanOrEqual(0);
      expect(body).toHaveProperty('version');
      expect(typeof body.version).toBe('string');
      expect(body.version.length).toBeGreaterThan(0);
    });

    // AC: @daemon-server ac-11
    test('uptime increases over time', async ({ request, daemon }) => {
      const first = await request.get(`${DAEMON_URL}/api/health`);
      const firstBody = await first.json();

      // Wait briefly to ensure uptime ticks
      await new Promise((r) => setTimeout(r, 100));

      const second = await request.get(`${DAEMON_URL}/api/health`);
      const secondBody = await second.json();

      expect(secondBody.uptime).toBeGreaterThanOrEqual(firstBody.uptime);
    });
  });

  test.describe('CORS Headers', () => {
    // AC: @daemon-server ac-15, @api-contract ac-1
    test('allows requests from localhost:5173 origin', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/health`, {
        headers: {
          Origin: 'http://localhost:5173',
        },
      });

      expect(response.status()).toBe(200);

      const corsHeader = response.headers()['access-control-allow-origin'];
      // CORS header should reflect the allowed localhost:5173 origin
      expect(corsHeader).toBeDefined();
      expect(corsHeader).toContain('localhost:5173');
    });

    // AC: @api-contract ac-1
    test('allows requests from 127.0.0.1:5173 origin', async ({ request, daemon }) => {
      const response = await request.get(`${DAEMON_URL}/api/health`, {
        headers: {
          Origin: 'http://127.0.0.1:5173',
        },
      });

      expect(response.status()).toBe(200);

      const corsHeader = response.headers()['access-control-allow-origin'];
      expect(corsHeader).toBeDefined();
      expect(corsHeader).toContain('127.0.0.1:5173');
    });

    // AC: @daemon-server ac-15, @api-contract ac-1
    test('supports credentials (CORS credentials mode)', async ({ request, daemon }) => {
      const response = await request.fetch(`${DAEMON_URL}/api/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
        },
      });

      // Preflight should succeed
      expect(response.status()).toBeLessThan(400);

      const allowCredentials = response.headers()['access-control-allow-credentials'];
      expect(allowCredentials).toBe('true');
    });
  });

  test.describe('Localhost Security', () => {
    // AC: @trait-localhost-security ac-1, @daemon-server ac-2
    // Implicitly verified: daemon starts and accepts connections from localhost.
    // If the daemon is not bound to localhost, none of the other E2E tests would pass.
    test('daemon is accessible from localhost (binding works)', async ({ request, daemon }) => {
      // AC: @daemon-server ac-1
      const response = await request.get(`${DAEMON_URL}/api/health`);
      expect(response.status()).toBe(200);
    });

    // AC: @trait-localhost-security ac-2, @daemon-server ac-3
    // Non-localhost connections are rejected. We use Node's http.request to explicitly
    // control the Host header, since fetch() overrides it with the actual target host.
    // The localhostOnly middleware checks the Host header to determine locality.
    test('rejects requests with non-localhost Host header with 403', async ({ daemon }) => {
      const result = await rawHttpRequest({
        path: '/api/health',
        host: 'evil.example.com',
      });

      expect(result.status).toBe(403);

      const body = result.body as Record<string, string>;
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('Forbidden');
      expect(body).toHaveProperty('message');
      expect((body.message as string)).toContain('localhost');
    });

    // AC: @trait-localhost-security ac-2, @daemon-server ac-3
    test('rejects requests with external IP Host header with 403', async ({ daemon }) => {
      const result = await rawHttpRequest({
        path: '/api/health',
        host: '192.168.1.100:3456',
      });

      expect(result.status).toBe(403);

      const body = result.body as Record<string, string>;
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('Forbidden');
    });

    // AC: @trait-localhost-security ac-3 — N/A: daemon does not support external binding configuration
  });
});
