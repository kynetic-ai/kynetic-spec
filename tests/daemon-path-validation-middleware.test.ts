/**
 * Tests for Path Validation Middleware
 *
 * Tests the HTTP middleware that validates X-Kspec-Dir header and attaches
 * project context to requests for the multi-directory daemon architecture.
 *
 * AC: @multi-directory-daemon ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8, ac-8b, ac-8c, ac-20b
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupMultiDirFixtures, cleanupTempDir } from './helpers/cli';
import { join } from 'path';
import { chmodSync } from 'fs';
import { symlink as symlinkAsync } from 'fs/promises';

// Mock types for Hono-like middleware
interface Context {
  req: {
    header(name: string): string | undefined;
  };
  set(key: string, value: unknown): void;
  json(data: unknown, status: number): Response;
}

interface Next {
  (): Promise<void>;
}

interface ProjectContext {
  path: string;
  registeredAt: Date;
}

// Mock ProjectContextManager (matching daemon-context-manager.test.ts)
class ProjectContextManager {
  private projects: Map<string, ProjectContext> = new Map();
  private defaultProjectPath: string | null = null;

  constructor(defaultProjectPath?: string) {
    if (defaultProjectPath) {
      this.defaultProjectPath = defaultProjectPath;
    }
  }

  registerProject(projectPath: string, isDefault = false): ProjectContext {
    if (!this.isAbsolutePath(projectPath)) {
      throw new Error('Path must be absolute');
    }

    if (projectPath.includes('..')) {
      throw new Error('Path must not contain parent traversal');
    }

    const normalizedPath = this.normalizePath(projectPath);

    // Check .kspec/ exists and is readable
    const { existsSync, readdirSync } = require('fs');
    const kspecDir = join(normalizedPath, '.kspec');
    if (!existsSync(kspecDir)) {
      throw new Error(`Invalid kspec project - .kspec/ not found at ${normalizedPath}`);
    }

    // Try to read directory to check permissions
    try {
      readdirSync(kspecDir);
    } catch (err: any) {
      if (err.code === 'EACCES') {
        throw new Error(`Permission denied - cannot read ${normalizedPath}`);
      }
      throw err;
    }

    // Check for already registered
    if (this.projects.has(normalizedPath)) {
      return this.projects.get(normalizedPath)!;
    }

    const context: ProjectContext = {
      path: normalizedPath,
      registeredAt: new Date(),
    };

    this.projects.set(normalizedPath, context);

    if (isDefault) {
      this.defaultProjectPath = normalizedPath;
    }

    return context;
  }

  getProject(projectPath?: string): ProjectContext {
    if (projectPath) {
      const normalizedPath = this.normalizePath(projectPath);
      const context = this.projects.get(normalizedPath);
      if (!context) {
        throw new Error('Project not registered');
      }
      return context;
    }

    // No path provided - use default
    if (!this.defaultProjectPath) {
      throw new Error('No default project configured. Specify X-Kspec-Dir header.');
    }

    // Check if default project still valid
    const { existsSync } = require('fs');
    const kspecDir = join(this.defaultProjectPath, '.kspec');
    if (!existsSync(kspecDir)) {
      throw new Error('Default project no longer valid. Specify X-Kspec-Dir header.');
    }

    const context = this.projects.get(this.defaultProjectPath);
    if (!context) {
      throw new Error('Default project not registered');
    }

    return context;
  }

  private isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
  }

  private normalizePath(path: string): string {
    // Remove trailing slashes
    let normalized = path.replace(/\/+$/, '');

    // Resolve "." and ".." segments BUT preserve symlinks
    // Since we reject ".." earlier, we only handle "."
    normalized = normalized.replace(/\/\.\//g, '/').replace(/\/\.$/, '');

    // Collapse multiple slashes
    normalized = normalized.replace(/\/+/g, '/');

    return normalized;
  }
}

// Mock path validation middleware
function createPathValidationMiddleware(manager: ProjectContextManager) {
  return async (ctx: Context, next: Next) => {
    try {
      const projectPath = ctx.req.header('X-Kspec-Dir');

      if (projectPath) {
        // AC: @multi-directory-daemon ac-1, ac-4, ac-5, ac-6, ac-7, ac-8, ac-8b, ac-8c
        // Try to get existing or register new project
        let projectContext: ProjectContext;
        try {
          projectContext = manager.getProject(projectPath);
        } catch (err) {
          // Not registered - try to register
          projectContext = manager.registerProject(projectPath);
        }

        ctx.set('projectContext', projectContext);
      } else {
        // AC: @multi-directory-daemon ac-2, ac-3, ac-20b
        // No header - use default project
        const projectContext = manager.getProject();
        ctx.set('projectContext', projectContext);
      }

      await next();
    } catch (err: any) {
      const message = err.message;

      // AC: @multi-directory-daemon ac-3, ac-20b
      if (message.includes('No default project configured') ||
          message.includes('Default project no longer valid')) {
        ctx.json({ error: message }, 400);
        return; // Don't call next()
      }

      // AC: @multi-directory-daemon ac-5
      if (message.includes('Invalid kspec project')) {
        ctx.json({ error: message }, 400);
        return;
      }

      // AC: @multi-directory-daemon ac-6
      if (message.includes('Path must be absolute')) {
        ctx.json({ error: 'Path must be absolute' }, 400);
        return;
      }

      // AC: @multi-directory-daemon ac-7
      if (message.includes('Path must not contain parent traversal')) {
        ctx.json({ error: 'Path must not contain parent traversal' }, 400);
        return;
      }

      // AC: @multi-directory-daemon ac-8b - permission denied
      if (message.includes('Permission denied') || message.includes('EACCES')) {
        ctx.json({ error: `Permission denied - cannot read ${ctx.req.header('X-Kspec-Dir')}` }, 403);
        return;
      }

      // Other errors
      ctx.json({ error: 'Internal server error' }, 500);
    }
  };
}

// Helper to create mock context
function createMockContext(headers: Record<string, string> = {}): {
  ctx: Context;
  state: Record<string, unknown>;
  responseRef: { current: { data: unknown; status: number } | null };
} {
  const state: Record<string, unknown> = {};
  const responseRef: { current: { data: unknown; status: number } | null } = { current: null };

  const ctx: Context = {
    req: {
      header(name: string) {
        return headers[name];
      },
    },
    set(key: string, value: unknown) {
      state[key] = value;
    },
    json(data: unknown, status: number) {
      responseRef.current = { data, status };
      return new Response();
    },
  };

  return { ctx, state, responseRef };
}

describe('Path Validation Middleware', () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;
  let projectInvalid: string;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, 'project-a');
    projectB = join(fixturesRoot, 'project-b');
    projectInvalid = join(fixturesRoot, 'project-invalid');
  });

  afterEach(async () => {
    await cleanupTempDir(fixturesRoot);
  });

  describe('X-Kspec-Dir header validation', () => {
    // AC: @multi-directory-daemon ac-1
    it('should use project from X-Kspec-Dir header when provided', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx, state } = createMockContext({ 'X-Kspec-Dir': projectA });

      await middleware(ctx, async () => {});

      expect(state.projectContext).toBeDefined();
      expect((state.projectContext as ProjectContext).path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-4
    it('should auto-register unknown project when valid', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx, state } = createMockContext({ 'X-Kspec-Dir': projectB });

      await middleware(ctx, async () => {});

      expect(state.projectContext).toBeDefined();
      expect((state.projectContext as ProjectContext).path).toBe(projectB);

      // Verify cached by making second request
      const { ctx: ctx2, state: state2 } = createMockContext({ 'X-Kspec-Dir': projectB });
      await middleware(ctx2, async () => {});

      expect(state2.projectContext).toBe(state.projectContext);
    });

    // AC: @multi-directory-daemon ac-5
    it('should reject invalid project path (no .kspec/)', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx, responseRef } = createMockContext({ 'X-Kspec-Dir': projectInvalid });

      await middleware(ctx, async () => {});

      expect(responseRef.current).toBeTruthy();
      expect(responseRef.current!.status).toBe(400);
      expect((responseRef.current!.data as any).error).toContain('Invalid kspec project');
      expect((responseRef.current!.data as any).error).toContain(projectInvalid);
    });

    // AC: @multi-directory-daemon ac-6
    it('should reject relative paths', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx, responseRef } = createMockContext({ 'X-Kspec-Dir': './relative/path' });

      await middleware(ctx, async () => {});

      expect(responseRef.current).toBeTruthy();
      expect(responseRef.current!.status).toBe(400);
      expect((responseRef.current!.data as any).error).toBe('Path must be absolute');
    });

    // AC: @multi-directory-daemon ac-7
    it('should reject paths with parent traversal', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx, responseRef } = createMockContext({ 'X-Kspec-Dir': projectA + '/../something' });

      await middleware(ctx, async () => {});

      expect(responseRef.current).toBeTruthy();
      expect(responseRef.current!.status).toBe(400);
      expect((responseRef.current!.data as any).error).toBe('Path must not contain parent traversal');
    });

    // AC: @multi-directory-daemon ac-8
    it('should normalize paths (remove trailing slashes)', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);

      // Register with trailing slash
      const { ctx: ctx1, state: state1 } = createMockContext({ 'X-Kspec-Dir': projectA + '/' });
      await middleware(ctx1, async () => {});

      // Request without trailing slash - should get same context
      const { ctx: ctx2, state: state2 } = createMockContext({ 'X-Kspec-Dir': projectA });
      await middleware(ctx2, async () => {});

      expect(state1.projectContext).toBe(state2.projectContext);
      expect((state1.projectContext as ProjectContext).path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-8 (multiple slashes)
    it('should normalize paths (collapse multiple slashes)', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);

      const pathWithMultipleSlashes = projectA.replace(/\//g, '//');
      const { ctx, state } = createMockContext({ 'X-Kspec-Dir': pathWithMultipleSlashes });
      await middleware(ctx, async () => {});

      expect((state.projectContext as ProjectContext).path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-8 (dot segments)
    it('should normalize paths (resolve dot segments)', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);

      const pathWithDots = projectA + '/.';
      const { ctx, state } = createMockContext({ 'X-Kspec-Dir': pathWithDots });
      await middleware(ctx, async () => {});

      expect((state.projectContext as ProjectContext).path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-8c
    it('should NOT resolve symlinks during normalization', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);

      // Create symlink to projectA
      const symlinkPath = join(fixturesRoot, 'symlink-to-a');
      await symlinkAsync(projectA, symlinkPath);

      // Register via symlink
      const { ctx: ctx1, state: state1 } = createMockContext({ 'X-Kspec-Dir': symlinkPath });
      await middleware(ctx1, async () => {});

      // Register via real path
      const { ctx: ctx2, state: state2 } = createMockContext({ 'X-Kspec-Dir': projectA });
      await middleware(ctx2, async () => {});

      // Should be different contexts (symlinks NOT resolved)
      expect(state1.projectContext).not.toBe(state2.projectContext);
      expect((state1.projectContext as ProjectContext).path).toBe(symlinkPath);
      expect((state2.projectContext as ProjectContext).path).toBe(projectA);
    });
  });

  describe('Default project handling', () => {
    // AC: @multi-directory-daemon ac-2
    it('should use default project when no X-Kspec-Dir header', async () => {
      const manager = new ProjectContextManager(projectA);
      manager.registerProject(projectA, true);

      const middleware = createPathValidationMiddleware(manager);
      const { ctx, state } = createMockContext();

      await middleware(ctx, async () => {});

      expect(state.projectContext).toBeDefined();
      expect((state.projectContext as ProjectContext).path).toBe(projectA);
    });

    // AC: @multi-directory-daemon ac-3
    it('should return 400 when no default configured and no header', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx, responseRef } = createMockContext();

      await middleware(ctx, async () => {});

      expect(responseRef.current).toBeTruthy();
      expect(responseRef.current!.status).toBe(400);
      expect((responseRef.current!.data as any).error).toBe('No default project configured. Specify X-Kspec-Dir header.');
    });

    // AC: @multi-directory-daemon ac-20b
    it('should return 400 when default project .kspec/ deleted', async () => {
      const manager = new ProjectContextManager(projectA);
      manager.registerProject(projectA, true);

      const middleware = createPathValidationMiddleware(manager);

      // Delete .kspec/ directory
      const { rmSync } = require('fs');
      const kspecDir = join(projectA, '.kspec');
      rmSync(kspecDir, { recursive: true, force: true });

      const { ctx, responseRef } = createMockContext();
      await middleware(ctx, async () => {});

      expect(responseRef.current).toBeTruthy();
      expect(responseRef.current!.status).toBe(400);
      expect((responseRef.current!.data as any).error).toBe('Default project no longer valid. Specify X-Kspec-Dir header.');
    });
  });

  describe('Permission handling', () => {
    // AC: @multi-directory-daemon ac-8b
    it('should return 403 for permission denied errors', async () => {
      // Skip on Windows (chmod behavior differs)
      if (process.platform === 'win32') {
        return;
      }

      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);

      // Make .kspec/ unreadable
      const kspecDir = join(projectA, '.kspec');
      chmodSync(kspecDir, 0o000);

      try {
        const { ctx, responseRef } = createMockContext({ 'X-Kspec-Dir': projectA });
        await middleware(ctx, async () => {});

        expect(responseRef.current).toBeTruthy();
        expect(responseRef.current!.status).toBe(403);
        expect((responseRef.current!.data as any).error).toContain('Permission denied');
        expect((responseRef.current!.data as any).error).toContain(projectA);
      } finally {
        // Restore permissions for cleanup
        chmodSync(kspecDir, 0o755);
      }
    });
  });

  describe('Middleware integration', () => {
    it('should call next() when validation succeeds', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx } = createMockContext({ 'X-Kspec-Dir': projectA });

      let nextCalled = false;
      await middleware(ctx, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
    });

    it('should not call next() when validation fails', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx } = createMockContext({ 'X-Kspec-Dir': './relative' });

      let nextCalled = false;
      await middleware(ctx, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
    });

    it('should attach projectContext to context state', async () => {
      const manager = new ProjectContextManager();
      const middleware = createPathValidationMiddleware(manager);
      const { ctx, state } = createMockContext({ 'X-Kspec-Dir': projectA });

      await middleware(ctx, async () => {});

      expect(state).toHaveProperty('projectContext');
      expect((state.projectContext as ProjectContext).path).toBe(projectA);
    });
  });
});
