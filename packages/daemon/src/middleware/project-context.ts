/**
 * Project Context Middleware for Multi-Directory Daemon
 *
 * Extracts X-Kspec-Dir header and attaches ProjectContext to request state.
 * Implements path validation and automatic project registration.
 *
 * AC: @multi-directory-daemon ac-1, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7, ac-8, ac-8b, ac-8c, ac-20b
 */

import type { Elysia } from 'elysia';
import { ProjectContextManager, type ProjectContext } from '../project-context';
import type { PubSubManager } from '../websocket/pubsub';

export interface ProjectContextMiddlewareOptions {
  /**
   * Optional startup project path (daemon's cwd at boot if it has .kspec/)
   */
  startupProject?: string;
  /**
   * PubSubManager for broadcasting file changes
   */
  pubsub?: PubSubManager;
  /**
   * Called when a project is auto-registered (e.g., to start session sync).
   * Errors are caught and logged — they do not block the request.
   */
  onProjectRegistered?: (projectPath: string) => Promise<void>;
}

function normalizeValidationField(path: string | undefined): string {
  if (!path || path === '/') {
    return 'request';
  }

  return path
    .replace(/^\//, '')
    .replaceAll('/', '.');
}

function collectConstAlternatives(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  if ('const' in schema && typeof schema.const === 'string') {
    return [schema.const];
  }

  const alternatives = new Set<string>();

  if (Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) {
    for (const branch of (schema as { anyOf: unknown[] }).anyOf) {
      for (const alternative of collectConstAlternatives(branch)) {
        alternatives.add(alternative);
      }
    }
  }

  if ('items' in schema) {
    for (const alternative of collectConstAlternatives((schema as { items?: unknown }).items)) {
      alternatives.add(alternative);
    }
  }

  return [...alternatives];
}

/**
 * Creates project context middleware plugin for Elysia.
 *
 * Extracts X-Kspec-Dir header, validates path, registers/retrieves project,
 * and attaches ProjectContext to request state.
 *
 * Returns both the manager (for external access) and the middleware function.
 */
export function projectContextMiddleware(options: ProjectContextMiddlewareOptions = {}) {
  const manager = new ProjectContextManager(options.startupProject, options.pubsub);

  // Register startup project if provided
  // Note: Watcher will be started later after full initialization
  if (options.startupProject) {
    try {
      manager.registerProject(options.startupProject, true);
    } catch (error) {
      console.warn(`[daemon] Failed to register startup project: ${error}`);
    }
  }

  const middleware = (app: Elysia) =>
    app
      // Store manager in app state for WebSocket access
      .state('projectManager', manager)
      .derive(async ({ request, set }) => {
        // Skip project context resolution for non-API routes (static files, SPA pages)
        // and /api/health which should work without a project configured
        const url = new URL(request.url, `http://${request.headers.get('host')}`);
        const needsProject = url.pathname.startsWith('/api/')
          && url.pathname !== '/api/health';
        if (!needsProject) {
          return { projectContext: undefined as unknown as ProjectContext };
        }

        try {
          // AC: @multi-directory-daemon ac-1 - Extract X-Kspec-Dir header
          const projectPath = request.headers.get('X-Kspec-Dir') || undefined;

          let projectContext: ProjectContext;

          if (projectPath) {
            // AC: @multi-directory-daemon ac-1, ac-4, ac-5, ac-6, ac-7, ac-8, ac-8b, ac-8c
            // Try to get existing or register new project
            const result = manager.getOrRegisterProject(projectPath);
            projectContext = result.context;
            if (result.wasRegistered) {
              // Start watcher asynchronously (don't block request)
              void manager.startWatcher(projectContext.path).catch((watcherError) => {
                console.error(`[daemon] Failed to start watcher for ${projectContext.path}:`, watcherError);
              });
              // Start session sync asynchronously (don't block request)
              if (options.onProjectRegistered) {
                void options.onProjectRegistered(projectContext.path).catch((syncError) => {
                  console.error(`[daemon] Failed to start session sync for ${projectContext.path}:`, syncError);
                });
              }
            }
          } else {
            // AC: @multi-directory-daemon ac-2, ac-3, ac-20b
            // No header - use default project
            projectContext = manager.getProject();
          }

          return { projectContext };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);

          // AC: @multi-directory-daemon ac-3, ac-20b
          if (
            message.includes('No default project configured') ||
            message.includes('Default project no longer valid')
          ) {
            set.status = 400;
            return { error: message };
          }

          // AC: @multi-directory-daemon ac-5
          if (message.includes('Invalid kspec project')) {
            set.status = 400;
            return { error: message };
          }

          // AC: @multi-directory-daemon ac-6
          if (message.includes('Path must be absolute')) {
            set.status = 400;
            return { error: 'Path must be absolute' };
          }

          // AC: @multi-directory-daemon ac-7
          if (message.includes('Path must not contain parent traversal')) {
            set.status = 400;
            return { error: 'Path must not contain parent traversal' };
          }

          // AC: @multi-directory-daemon ac-8b - permission denied
          if (message.includes('Permission denied')) {
            set.status = 403;
            return { error: message };
          }

          // AC: @multi-directory-daemon ac-19 - OS resource limits
          if (message.includes('Unable to watch project - resource limit reached')) {
            set.status = 503;
            return { error: message };
          }

          // Other errors
          set.status = 500;
          return { error: 'Internal server error' };
        }
      })
      .onError(({ code, error, set }) => {
        if (code !== 'VALIDATION') {
          return;
        }

        const valueError = (error as {
          valueError?: { path?: string; schema?: unknown; message?: string };
          schema?: unknown;
          error?: { path?: string; schema?: unknown; message?: string };
          summary?: string;
          message?: string;
        }).valueError;
        const decodeError = (error as {
          error?: { path?: string; schema?: unknown; message?: string };
        }).error;
        const field = normalizeValidationField(valueError?.path ?? decodeError?.path);
        const alternatives = collectConstAlternatives(
          valueError?.schema
            ?? decodeError?.schema
            ?? (error as { schema?: unknown }).schema,
        );

        set.status = 400;
        return {
          error: 'validation_error',
          details: [
            {
              field,
              message: alternatives.length > 0
                ? `Must be one of: ${alternatives.join(', ')}`
                : valueError?.message
                    ?? decodeError?.message
                    ?? (error as { summary?: string; message?: string }).summary
                    ?? (error as { message?: string }).message
                    ?? 'Request validation failed',
            },
          ],
        };
      });

  return { manager, middleware };
}
