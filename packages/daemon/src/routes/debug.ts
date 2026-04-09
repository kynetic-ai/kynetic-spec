/**
 * Debug API Routes
 *
 * Diagnostic endpoints for inspecting daemon internal state.
 *
 * - GET /api/debug/cache-status — per-project cache state including domain states,
 *   watcher status, entry counts, and last invalidation timestamps.
 *
 * AC Coverage:
 * - @daemon-server ac-18: cache diagnostic endpoint
 */

import { Elysia } from "elysia";
import type { ProjectContextManager } from "../project-context.js";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface DebugRouteOptions {
  projectManager: ProjectContextManager;
  getEntityCache: EntityCacheAccessor;
}

export function createDebugRoutes(options: DebugRouteOptions) {
  const { projectManager, getEntityCache } = options;

  return (
    new Elysia({ prefix: "/api/debug" })
      // AC: @daemon-server ac-18 — per-project cache diagnostic
      .get("/cache-status", () => {
        const projects = projectManager.listProjects();

        const result = projects.map((project) => {
          const cache = getEntityCache(project.path);
          return {
            path: project.path,
            watcherStatus: project.watcherActive ? "active" : "stopped",
            registeredAt: project.registeredAt.toISOString(),
            lastHealthCheckAt: project.lastHealthCheckAt?.toISOString() ?? null,
            consecutiveFailures: project.consecutiveFailures,
            domains: cache?.getCacheDiagnostics().domains ?? null,
          };
        });

        return { projects: result, total: projects.length };
      })
  );
}
