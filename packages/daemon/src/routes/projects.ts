/**
 * Projects API Routes
 *
 * REST endpoints for project management operations:
 * - GET /api/projects - list all registered projects
 * - POST /api/projects - manually register a project
 * - DELETE /api/projects/:encodedPath - unregister a project
 *
 * All endpoints return JSON responses.
 *
 * AC Coverage:
 * - ac-28: GET /api/projects returns list with paths, registration time, watcher status
 * - ac-29: POST /api/projects with {path: string} body for manual registration
 * - ac-30: DELETE /api/projects/:encodedPath unregisters and stops watcher
 */

import { Elysia, t } from 'elysia';
import { isAbsolute } from 'path';
import type { ProjectContextManager } from '../project-context';

interface ProjectsRouteOptions {
  projectManager: ProjectContextManager;
}

export function createProjectsRoutes(options: ProjectsRouteOptions) {
  const { projectManager } = options;

  return new Elysia({ prefix: '/api/projects' })
    // AC: @multi-directory-daemon ac-28 - List registered projects
    .get('/', async () => {
      const projects = projectManager.listProjects();

      // AC: @multi-directory-daemon ac-28 - Include paths, registration time, watcher status
      return {
        projects: projects.map(project => ({
          path: project.path,
          registeredAt: project.registeredAt.toISOString(),
          watcherStatus: project.watcherActive ? 'active' : 'stopped',
        })),
        total: projects.length,
      };
    })

    // AC: @multi-directory-daemon ac-29 - Manual project registration
    .post(
      '/',
      async ({ body, error: errorResponse }) => {
        // AC: @multi-directory-daemon ac-29 - Accept {path: string} body
        // Validate path is provided
        if (!body.path || typeof body.path !== 'string' || body.path.trim().length === 0) {
          return errorResponse(400, {
            error: 'validation_error',
            details: [
              {
                field: 'path',
                message: 'Path is required and must be a non-empty string',
              },
            ],
          });
        }

        // AC: @multi-directory-daemon ac-6 - Path must be absolute
        if (!isAbsolute(body.path)) {
          return errorResponse(400, {
            error: 'Path must be absolute',
          });
        }

        // AC: @multi-directory-daemon ac-7 - Reject parent traversal (..)
        if (body.path.includes('..')) {
          return errorResponse(400, {
            error: 'Path must not contain parent traversal',
          });
        }

        try {
          // AC: @multi-directory-daemon ac-29 - Use ProjectContextManager.registerProject()
          const context = projectManager.registerProject(body.path);

          // Start watcher for the registered project
          try {
            await projectManager.startWatcher(body.path);
          } catch (error: any) {
            // AC: @multi-directory-daemon ac-19 - Handle OS limits
            if (error.message.includes('resource limit')) {
              return errorResponse(503, {
                error: 'Unable to watch project - resource limit reached',
              });
            }
            throw error;
          }

          return {
            success: true,
            project: {
              path: context.path,
              registeredAt: context.registeredAt.toISOString(),
              watcherStatus: context.watcherActive ? 'active' : 'stopped',
            },
          };
        } catch (error: any) {
          // AC: @multi-directory-daemon ac-5 - Invalid project (no .kspec/)
          if (error.message.includes('.kspec/ not found')) {
            return errorResponse(400, {
              error: `Invalid kspec project - .kspec/ not found at ${body.path}`,
            });
          }

          // AC: @multi-directory-daemon ac-8b - Permission denied
          if (error.code === 'EACCES' || error.code === 'EPERM') {
            return errorResponse(403, {
              error: `Permission denied - cannot read ${body.path}`,
            });
          }

          // Generic error
          return errorResponse(500, {
            error: error.message || 'Failed to register project',
          });
        }
      },
      {
        body: t.Object({
          path: t.String(),
        }),
      }
    )

    // AC: @multi-directory-daemon ac-30 - Unregister project
    .delete('/:encodedPath', async ({ params, error: errorResponse }) => {
      // AC: @multi-directory-daemon ac-30 - Decode path from URL parameter
      const projectPath = decodeURIComponent(params.encodedPath);

      // Validate project exists
      if (!projectManager.hasProject(projectPath)) {
        return errorResponse(404, {
          error: `Project not registered: ${projectPath}`,
        });
      }

      try {
        // AC: @multi-directory-daemon ac-30 - Stop file watcher
        await projectManager.stopWatcher(projectPath);

        // AC: @multi-directory-daemon ac-30 - Unregister project
        projectManager.unregisterProject(projectPath);

        return {
          success: true,
          message: `Project unregistered: ${projectPath}`,
        };
      } catch (error: any) {
        return errorResponse(500, {
          error: error.message || 'Failed to unregister project',
        });
      }
    });
}
