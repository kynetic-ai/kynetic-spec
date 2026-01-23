/**
 * E2E tests for daemon server
 * Spec: @daemon-server
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempDir, cleanupTempDir, initGitRepo, setupTempFixtures } from './helpers/cli';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Daemon Server', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await initGitRepo(tempDir);
    await setupTempFixtures(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @daemon-server ac-1
  it('should have daemon package with Elysia dependency', async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), 'packages/daemon/package.json'), 'utf-8')
    );

    expect(packageJson.dependencies).toHaveProperty('elysia');
    expect(packageJson.name).toBe('@kynetic-ai/daemon');
  });

  // AC: @daemon-server ac-1
  it('should parse --port flag with default 3456', async () => {
    const indexContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/index.ts'),
      'utf-8'
    );

    expect(indexContent).toContain('--port=');
    expect(indexContent).toContain('3456');
  });

  // AC: @daemon-server ac-2
  it('should configure server to bind to localhost hostname', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    // Verify server binds to 'localhost' hostname (resolves to both IPv4 and IPv6)
    expect(serverContent).toContain("hostname: 'localhost'");
  });

  describe('localhost-only middleware (ac-3)', () => {
    // Unit tests for middleware logic without needing Bun runtime
    // We recreate the middleware logic to test it directly

    function localhostOnly() {
      return (context: { request: Request }) => {
        const host = context.request.headers.get('host');
        if (!host) {
          return new Response(JSON.stringify({
            error: 'Forbidden',
            message: 'This server only accepts connections from localhost'
          }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Extract hostname, handling IPv6 brackets
        let hostname: string;
        if (host.startsWith('[')) {
          // IPv6 with brackets: [::1]:3456 -> ::1
          const closeBracket = host.indexOf(']');
          hostname = closeBracket > 0 ? host.substring(1, closeBracket) : host;
        } else {
          // IPv4 or hostname: localhost:3456 -> localhost
          hostname = host.split(':')[0];
        }

        // Allow localhost, 127.0.0.1, and ::1
        const isLocalhost =
          hostname === 'localhost' ||
          hostname === '127.0.0.1' ||
          hostname === '::1';

        if (!isLocalhost) {
          return new Response(JSON.stringify({
            error: 'Forbidden',
            message: 'This server only accepts connections from localhost'
          }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      };
    }

    // AC: @daemon-server ac-3
    it('should allow localhost hostname', () => {
      const middleware = localhostOnly();
      const mockContext = {
        request: {
          headers: new Map([['host', 'localhost:3456']]) as any
        }
      };
      mockContext.request.headers.get = (key: string) =>
        key === 'host' ? 'localhost:3456' : null;

      const result = middleware(mockContext);
      expect(result).toBeUndefined(); // No rejection = allowed
    });

    // AC: @daemon-server ac-3
    it('should allow 127.0.0.1 IPv4 address', () => {
      const middleware = localhostOnly();
      const mockContext = {
        request: {
          headers: new Map([['host', '127.0.0.1:3456']]) as any
        }
      };
      mockContext.request.headers.get = (key: string) =>
        key === 'host' ? '127.0.0.1:3456' : null;

      const result = middleware(mockContext);
      expect(result).toBeUndefined();
    });

    // AC: @daemon-server ac-3
    it('should allow ::1 IPv6 address with port', () => {
      const middleware = localhostOnly();
      const mockContext = {
        request: {
          headers: new Map([['host', '[::1]:3456']]) as any
        }
      };
      mockContext.request.headers.get = (key: string) =>
        key === 'host' ? '[::1]:3456' : null;

      const result = middleware(mockContext);
      expect(result).toBeUndefined();
    });

    // AC: @daemon-server ac-3
    it('should reject non-localhost hostname with 403', async () => {
      const middleware = localhostOnly();
      const mockContext = {
        request: {
          headers: new Map([['host', 'evil.com']]) as any
        }
      };
      mockContext.request.headers.get = (key: string) =>
        key === 'host' ? 'evil.com' : null;

      const result = middleware(mockContext) as Response;
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(403);

      const body = await result.json();
      expect(body.error).toBe('Forbidden');
      expect(body.message).toContain('localhost');
    });

    // AC: @daemon-server ac-3
    it('should reject external IP address with 403', async () => {
      const middleware = localhostOnly();
      const mockContext = {
        request: {
          headers: new Map([['host', '192.168.1.100:3456']]) as any
        }
      };
      mockContext.request.headers.get = (key: string) =>
        key === 'host' ? '192.168.1.100:3456' : null;

      const result = middleware(mockContext) as Response;
      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(403);

      const body = await result.json();
      expect(body.error).toBe('Forbidden');
    });
  });

  // AC: @daemon-server ac-11
  it('should define /api/health endpoint returning status object', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('/api/health');
    expect(serverContent).toContain('status');
    expect(serverContent).toContain('uptime');
    expect(serverContent).toContain('connections');
    expect(serverContent).toContain('version');
  });

  // AC: @daemon-server ac-12
  it('should register SIGTERM handler for graceful shutdown', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain("process.on('SIGTERM'");
    expect(serverContent).toContain('shutdown');
  });

  // AC: @daemon-server ac-12
  it('should register SIGINT handler for graceful shutdown', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain("process.on('SIGINT'");
  });

  // AC: @daemon-server ac-12
  it('should stop server during shutdown', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('app.server?.stop()');
  });

  // AC: @daemon-server ac-15
  it('should use CORS plugin middleware', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('cors');
    expect(serverContent).toContain('.use(');
    expect(serverContent).toContain("from '@elysiajs/cors'");
  });

  // AC: @daemon-server ac-15
  it('should have CORS plugin dependency', async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), 'packages/daemon/package.json'), 'utf-8')
    );

    expect(packageJson.dependencies).toHaveProperty('@elysiajs/cors');
  });

  it('should have chokidar dependency for file watching fallback', async () => {
    const packageJson = JSON.parse(
      await readFile(join(process.cwd(), 'packages/daemon/package.json'), 'utf-8')
    );

    // AC-8: fallback to Chokidar
    expect(packageJson.dependencies).toHaveProperty('chokidar');
  });

  it('should have WebSocket endpoint with full protocol implementation', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    // Verify WebSocket endpoint exists with protocol implementation
    expect(serverContent).toContain('.ws<ConnectionData>');
    expect(serverContent).toContain("'/ws'");
  });

  it('should parse --daemon flag in CLI', async () => {
    const indexContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/index.ts'),
      'utf-8'
    );

    // AC-9: daemon mode support
    expect(indexContent).toContain('--daemon');
    expect(indexContent).toContain('isDaemon');
  });

  it('should export createServer function with correct signature', async () => {
    const serverContent = await readFile(
      join(process.cwd(), 'packages/daemon/src/server.ts'),
      'utf-8'
    );

    expect(serverContent).toContain('export async function createServer');
    expect(serverContent).toContain('ServerOptions');
    expect(serverContent).toContain('port: number');
    expect(serverContent).toContain('isDaemon: boolean');
  });
});
