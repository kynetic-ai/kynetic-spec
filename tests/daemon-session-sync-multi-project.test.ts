/**
 * Tests for multi-project session sync in daemon
 *
 * Verifies that session sync schedulers are started/stopped for projects
 * registered and unregistered via the projects API and middleware auto-registration.
 *
 * Task: @01KKBD6KH5F5MVC5BXV2NQG474
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupMultiDirFixtures, cleanupTempDir } from './helpers/cli';
import { join } from 'path';
import { ProjectContextManager } from '../packages/daemon/src/project-context';
import { createProjectsRoutes } from '../packages/daemon/src/routes/projects';

describe('Multi-project session sync', () => {
  let fixturesRoot: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    fixturesRoot = await setupMultiDirFixtures();
    projectA = join(fixturesRoot, 'project-a');
    projectB = join(fixturesRoot, 'project-b');
  });

  afterEach(async () => {
    await cleanupTempDir(fixturesRoot);
  });

  describe('Projects API callbacks', () => {
    it('should call onProjectRegistered when project is registered via POST', async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const onUnregistered = vi.fn();
      const manager = new ProjectContextManager();

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
        onProjectUnregistered: onUnregistered,
      });

      // Use Elysia's handler directly by creating a test app
      const { Elysia } = await import('elysia');
      const app = new Elysia().use(routes);

      const response = await app.handle(
        new Request('http://localhost/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectA }),
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);

      // onProjectRegistered should have been called with the normalized project path
      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(onRegistered).toHaveBeenCalledWith(projectA);
    });

    it('should call onProjectUnregistered when project is unregistered via DELETE', async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const onUnregistered = vi.fn();
      const manager = new ProjectContextManager();
      manager.registerProject(projectA);

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
        onProjectUnregistered: onUnregistered,
      });

      const { Elysia } = await import('elysia');
      const app = new Elysia().use(routes);

      const encodedPath = encodeURIComponent(projectA);
      const response = await app.handle(
        new Request(`http://localhost/api/projects/${encodedPath}`, {
          method: 'DELETE',
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);

      // onProjectUnregistered should have been called
      expect(onUnregistered).toHaveBeenCalledTimes(1);
      expect(onUnregistered).toHaveBeenCalledWith(projectA);
    });

    it('should not fail registration if onProjectRegistered throws', async () => {
      const onRegistered = vi.fn().mockRejectedValue(new Error('Session sync failed'));
      const manager = new ProjectContextManager();

      const routes = createProjectsRoutes({
        projectManager: manager,
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import('elysia');
      const app = new Elysia().use(routes);

      // Suppress expected error log
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await app.handle(
          new Request('http://localhost/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: projectA }),
          })
        );

        // Registration should still succeed even if session sync callback fails
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.success).toBe(true);

        // Project should be registered
        expect(manager.hasProject(projectA)).toBe(true);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('should work without callbacks (backward compatible)', async () => {
      const manager = new ProjectContextManager();

      // No callbacks provided — should still work
      const routes = createProjectsRoutes({
        projectManager: manager,
      });

      const { Elysia } = await import('elysia');
      const app = new Elysia().use(routes);

      const response = await app.handle(
        new Request('http://localhost/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: projectA }),
        })
      );

      expect(response.status).toBe(200);
      expect(manager.hasProject(projectA)).toBe(true);
    });
  });

  describe('Middleware auto-registration callback', () => {
    it('should call onProjectRegistered when project is auto-registered via middleware', async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const { projectContextMiddleware } = await import('../packages/daemon/src/middleware/project-context');

      const { manager, middleware } = projectContextMiddleware({
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import('elysia');
      const app = new Elysia()
        .use(middleware)
        .get('/api/test', () => ({ ok: true }));

      // First request with a new project path triggers auto-registration
      const response = await app.handle(
        new Request('http://localhost/api/test', {
          headers: {
            'Host': 'localhost',
            'X-Kspec-Dir': projectA,
          },
        })
      );

      // The request should succeed (auto-registration)
      expect(response.status).toBe(200);

      // onProjectRegistered should have been called
      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(onRegistered).toHaveBeenCalledWith(projectA);
    });

    it('should normalize path before calling onProjectRegistered (regression: non-canonical header)', async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const { projectContextMiddleware } = await import('../packages/daemon/src/middleware/project-context');

      const { manager, middleware } = projectContextMiddleware({
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import('elysia');
      const app = new Elysia()
        .use(middleware)
        .get('/api/test', () => ({ ok: true }));

      // Send a request with a non-normalized path (trailing "/./")
      const nonNormalizedPath = projectA + '/./';
      const response = await app.handle(
        new Request('http://localhost/api/test', {
          headers: {
            'Host': 'localhost',
            'X-Kspec-Dir': nonNormalizedPath,
          },
        })
      );

      expect(response.status).toBe(200);

      // Callback should receive the normalized path, not the raw header value
      expect(onRegistered).toHaveBeenCalledTimes(1);
      expect(onRegistered).toHaveBeenCalledWith(projectA);
      // Critically: NOT called with the non-normalized path
      expect(onRegistered).not.toHaveBeenCalledWith(nonNormalizedPath);
    });

    it('should not call onProjectRegistered for already-registered projects', async () => {
      const onRegistered = vi.fn().mockResolvedValue(undefined);
      const { projectContextMiddleware } = await import('../packages/daemon/src/middleware/project-context');

      const { manager, middleware } = projectContextMiddleware({
        startupProject: projectA,
        onProjectRegistered: onRegistered,
      });

      const { Elysia } = await import('elysia');
      const app = new Elysia()
        .use(middleware)
        .get('/api/test', () => ({ ok: true }));

      // Startup project is already registered — should not trigger callback
      const response = await app.handle(
        new Request('http://localhost/api/test', {
          headers: {
            'Host': 'localhost',
            'X-Kspec-Dir': projectA,
          },
        })
      );

      expect(response.status).toBe(200);
      expect(onRegistered).not.toHaveBeenCalled();
    });
  });
});
