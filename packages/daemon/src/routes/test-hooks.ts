/**
 * Test-Only Routes (KSPEC_TEST)
 *
 * Endpoints that support E2E test scenarios requiring fine-grained control
 * over daemon internals. These routes are only registered when the KSPEC_TEST
 * environment variable is set.
 *
 * - POST /api/__test__/cache/delay — inject a delay gate for a project's cache loading
 * - POST /api/__test__/cache/release — release the delay gate to allow loading to proceed
 * - GET /api/__test__/cache/delay-status — check if a delay gate is active
 */

import { Elysia, t } from "elysia";
import type { EntityCacheAccessor } from "./entity-cache-types.js";

interface TestHookRouteOptions {
  getEntityCache: EntityCacheAccessor;
}

export function createTestHookRoutes(options: TestHookRouteOptions) {
  const { getEntityCache: _getEntityCache } = options;

  // Lazy import to keep test-only code out of the hot path.
  // At runtime in dist/daemon/routes/, "../entity-cache.js" resolves to
  // dist/daemon/entity-cache.js.
  let entityCacheModule: {
    setTestDelay: (projectPath: string) => void;
    releaseTestDelay: (projectPath: string) => void;
    hasTestDelay: (projectPath: string) => boolean;
  } | null = null;
  async function getModule() {
    if (!entityCacheModule) {
      entityCacheModule = await import("../entity-cache.js");
    }
    return entityCacheModule;
  }

  return new Elysia({ prefix: "/api/__test__" })
    .post(
      "/cache/delay",
      async ({ body }) => {
        const mod = await getModule();
        mod.setTestDelay(body.projectPath);
        return { ok: true, projectPath: body.projectPath };
      },
      {
        body: t.Object({
          projectPath: t.String(),
        }),
      },
    )
    .post(
      "/cache/release",
      async ({ body }) => {
        const mod = await getModule();
        mod.releaseTestDelay(body.projectPath);
        return { ok: true, projectPath: body.projectPath };
      },
      {
        body: t.Object({
          projectPath: t.String(),
        }),
      },
    )
    .get("/cache/delay-status", async ({ query }) => {
      const mod = await getModule();
      const projectPath = query.projectPath;
      return {
        hasDelay: projectPath ? mod.hasTestDelay(projectPath) : false,
        projectPath: projectPath ?? null,
      };
    });
}
