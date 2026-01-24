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

export interface ProjectContextMiddlewareOptions {
  /**
   * Optional startup project path (daemon's cwd at boot if it has .kspec/)
   */
  startupProject?: string;
}

/**
 * Creates project context middleware plugin for Elysia.
 *
 * Extracts X-Kspec-Dir header, validates path, registers/retrieves project,
 * and attaches ProjectContext to request state.
 */
export function projectContextMiddleware(options: ProjectContextMiddlewareOptions = {}) {
  const manager = new ProjectContextManager(options.startupProject);

  // Register startup project if provided
  if (options.startupProject) {
    try {
      manager.registerProject(options.startupProject, true);
    } catch (error) {
      console.warn(`[daemon] Failed to register startup project: ${error}`);
    }
  }

  return (app: Elysia) =>
    app
      // Store manager in app state for WebSocket access
      .state('projectManager', manager)
      .derive(async ({ request, set }) => {
        try {
          // AC: @multi-directory-daemon ac-1 - Extract X-Kspec-Dir header
          const projectPath = request.headers.get('X-Kspec-Dir') || undefined;

          let projectContext: ProjectContext;

          if (projectPath) {
            // AC: @multi-directory-daemon ac-1, ac-4, ac-5, ac-6, ac-7, ac-8, ac-8b, ac-8c
            // Try to get existing or register new project
            try {
              projectContext = manager.getProject(projectPath);
            } catch (err) {
              // Not registered - try to register (ac-4: auto-register)
              projectContext = manager.registerProject(projectPath);
            }
          } else {
            // AC: @multi-directory-daemon ac-2, ac-3, ac-20b
            // No header - use default project
            projectContext = manager.getProject();
          }

          return { projectContext };
        } catch (err: any) {
          const message = err.message;

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

          // Other errors
          set.status = 500;
          return { error: 'Internal server error' };
        }
      });
}
