/**
 * Shared test helpers for daemon API integration tests.
 *
 * These tests use Elysia's app.handle() to test API routes directly
 * without starting an HTTP server or requiring Chromium. This is the
 * vitest replacement for the Playwright-based e2e API tests.
 *
 * Pattern established in tests/daemon-api-input-validation.test.ts.
 */

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";
import { cleanupTempDir, createTempDir, initGitRepo } from "../helpers/cli.js";
import { projectContextMiddleware } from "../../dist/daemon/middleware/project-context.js";
import { createTasksRoutes } from "../../dist/daemon/routes/tasks.js";
import { createItemsRoutes } from "../../dist/daemon/routes/items.js";
import { createReviewsRoutes } from "../../dist/daemon/routes/reviews.js";
import { createTriageRoutes } from "../../dist/daemon/routes/triage.js";
import { createPlansRoutes } from "../../dist/daemon/routes/plans.js";
import { createSessionRoutes } from "../../dist/daemon/routes/sessions.js";
import { createValidationRoutes } from "../../dist/daemon/routes/validation.js";
import { createMetaRoutes } from "../../dist/daemon/routes/meta.js";
import { createInboxRoutes } from "../../dist/daemon/routes/inbox.js";
import { createAggregationRoutes } from "../../dist/daemon/routes/aggregation.js";
import { createAgentDispatchRoutes } from "../../dist/daemon/routes/agent-dispatch.js";
import { PubSubManager } from "../../dist/daemon/websocket/pubsub.js";
import { ensureSplitBackendRegistered } from "../../dist/parser/split-backend.js";
import type { ProjectContextManager } from "../../dist/daemon/project-context.js";

// Register the split storage backend so task routes can handle the split format
// used by e2e fixtures. In production this happens lazily via createRequire(),
// but vitest's ESM environment needs explicit registration.
ensureSplitBackendRegistered();

const E2E_FIXTURES = path.join(__dirname, "../e2e/fixtures");

/**
 * Copy e2e fixture files into a temp directory to simulate a kspec project.
 * Mirrors what the Playwright daemon fixture does: copies kynetic.yaml,
 * project.*.yaml, kynetic.meta.yaml, modules/, and tasks/ into a .kspec/ dir,
 * then sets up the fake shadow worktree structure.
 */
export function setupFixtures(tempDir: string): void {
  const kspecDir = path.join(tempDir, ".kspec");
  mkdirSync(kspecDir, { recursive: true });

  // Copy all fixture files into kspecDir (the .kspec/ directory)
  const filesToCopy = [
    "kynetic.yaml",
    "project.tasks.yaml",
    "project.inbox.yaml",
    "project.reviews.yaml",
    "project.plans.yaml",
    "project.triage.yaml",
    "kynetic.meta.yaml",
  ];

  for (const file of filesToCopy) {
    const src = path.join(E2E_FIXTURES, file);
    const dest = path.join(kspecDir, file);
    cpSync(src, dest);
  }

  // Copy modules directory
  cpSync(path.join(E2E_FIXTURES, "modules"), path.join(kspecDir, "modules"), { recursive: true });

  // Copy tasks directory (split task storage)
  cpSync(path.join(E2E_FIXTURES, "tasks"), path.join(kspecDir, "tasks"), { recursive: true });

  // Create sessions directory
  mkdirSync(path.join(tempDir, ".kspec-sessions"), { recursive: true });

  // Set up fake shadow worktree structure so initContext() resolves
  const worktreeDir = path.join(tempDir, ".git", "worktrees", "-kspec");
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(path.join(kspecDir, ".git"), `gitdir: ${worktreeDir}\n`);
  writeFileSync(path.join(worktreeDir, "gitdir"), `${kspecDir}/.git\n`);
  writeFileSync(path.join(worktreeDir, "HEAD"), "ref: refs/heads/kspec-meta\n");

  // Copy project-tests for AC coverage scanning
  const projectTestsSrc = path.join(E2E_FIXTURES, "project-tests");
  const projectTestsDest = path.join(tempDir, "tests");
  cpSync(projectTestsSrc, projectTestsDest, { recursive: true });

  // Create .kspec-session file with session context from the meta fixture.
  // The daemon's /api/meta/session endpoint reads from this file (via loadSessionContext),
  // not from the `session:` block in kynetic.meta.yaml.
  writeFileSync(
    path.join(kspecDir, ".kspec-session"),
    'focus: "E2E testing"\nthreads: []\nopen_questions: []\nupdated_at: "2026-03-01T00:00:00.000Z"\n',
  );

  // Commit so kspec sees a valid project state
  execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: "pipe" });
}

/**
 * Create an Elysia app instance with all API routes registered.
 * Uses the same route constructors as the production server but
 * without starting an HTTP listener.
 *
 * Includes a polyfill for Elysia's `error` context function which is
 * not available when using app.handle() (WebStandard adapter, Node.js).
 * The polyfill uses `set.status` to achieve the same effect.
 */
export function createTestApp(): {
  app: Elysia;
  pubsub: PubSubManager;
  manager: ProjectContextManager;
} {
  const pubsub = new PubSubManager();
  const { middleware, manager } = projectContextMiddleware();

  // app.handle() integration tests assert request/response behavior only. Starting
  // filesystem watchers for every temp project leaks resources across the suite
  // and causes unrelated timeout flakes under full-suite load.
  manager.startWatcher = async () => {};

  const app = new Elysia()
    // Polyfill Elysia's `error` function for app.handle() in Node.js.
    // In Bun with .listen(), Elysia provides `error` natively. In Node.js
    // with app.handle() (WebStandard adapter), it's undefined. This resolve
    // hook provides an equivalent implementation using set.status.
    .resolve(({ set }) => ({
      error: (status: number, body: unknown) => {
        set.status = status;
        return body;
      },
    }))
    .use(middleware)
    .use(createTasksRoutes({ pubsub }))
    .use(createItemsRoutes())
    .use(createReviewsRoutes({ pubsub }))
    .use(createTriageRoutes({ pubsub }))
    .use(createPlansRoutes())
    .use(createSessionRoutes())
    .use(createValidationRoutes())
    .use(createMetaRoutes())
    .use(createInboxRoutes({ pubsub }))
    .use(createAggregationRoutes())
    .use(createAgentDispatchRoutes());

  return { app, pubsub, manager };
}

/**
 * Make a request to the Elysia app using app.handle().
 * Converts a URL path + RequestInit into a full Request object
 * with the required headers for kspec project context resolution.
 */
export function makeRequest(
  app: Elysia,
  tempDir: string,
  urlPath: string,
  init: RequestInit = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: init.method ?? "GET",
      headers: {
        Host: "localhost",
        "X-Kspec-Dir": tempDir,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string>),
      },
      body: init.body,
    }),
  );
}

export { createTempDir, cleanupTempDir, initGitRepo };
