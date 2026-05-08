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
import { vi } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  seedSplitTask,
  testUlid,
  testUlids,
} from "../helpers/cli.js";
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
import type { EntityCacheAccessor } from "../../dist/daemon/routes/entity-cache-types.js";

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
 *
 * Use this for tests that need realistic project content (tasks, reviews,
 * plans, etc.) drawn from the shared e2e fixture set. For ad-hoc fixtures
 * with custom ULIDs and minimal data, prefer {@link setupInlineFixtures}.
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
 * Default minimal manifest used when {@link setupInlineFixtures} is called
 * without an explicit manifest. Declares the modern split task storage
 * format and a single `modules/test.yaml` include.
 *
 * Tests that need legacy/monolithic task storage (kynetic 1.0 with
 * `tasks_file: project.tasks.yaml`) must supply their own manifest.
 * Note: monolithic task storage has been removed for `/api/tasks`
 * routes — legacy manifests are still accepted for tests that only
 * exercise non-task routes (reviews, sessions, etc).
 */
export const DEFAULT_INLINE_MANIFEST = `kynetic: "1.1"
task_storage:
  format: split
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`;

/**
 * Legacy/monolithic manifest helper for tests that need
 * `tasks_file: project.tasks.yaml`. The manifest is still accepted by
 * the daemon's project context resolver, but `/api/tasks` mutation
 * routes throw because the monolithic storage backend has been removed.
 * Use this only for tests that exclusively exercise non-task routes
 * (reviews, sessions, validation, meta).
 */
export const LEGACY_INLINE_MANIFEST = `kynetic: "1.0"
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
tasks_file: project.tasks.yaml
`;

export type SeedSplitTaskInput = Parameters<typeof seedSplitTask>[1];

export interface InlineProjectFiles {
  /**
   * kynetic.yaml content. Defaults to {@link DEFAULT_INLINE_MANIFEST}
   * (legacy task storage). Override when the test requires split task
   * storage or a custom project name.
   */
  manifest?: string;
  /** Map of basename -> YAML content. Each entry is written to `modules/<basename>`. */
  modules?: Record<string, string>;
  /**
   * project.tasks.yaml content (legacy/inline format). Mutually exclusive
   * with `splitTasks`.
   */
  tasksFile?: string;
  /**
   * Tasks to seed via {@link seedSplitTask}. Use this when the manifest
   * declares `task_storage: format: split`. Mutually exclusive with `tasksFile`.
   */
  splitTasks?: SeedSplitTaskInput[];
  /** project.reviews.yaml content. */
  reviews?: string;
  /** project.plans.yaml content. */
  plans?: string;
  /** project.inbox.yaml content. */
  inbox?: string;
  /** project.triage.yaml content. */
  triage?: string;
  /** kynetic.meta.yaml content. */
  meta?: string;
  /**
   * When true, skip the trailing `git add -A && git commit` step. Useful
   * when the test wants to write more files before committing. Defaults to false.
   */
  skipCommit?: boolean;
}

/**
 * Set up an in-process daemon project at `tempDir` using inline YAML
 * fixtures. Files are written at the project root in traditional
 * (non-shadow) mode, matching the pattern established by
 * tests/daemon-api-input-validation.test.ts. The git repo is committed
 * once all files are written so the daemon sees a valid project state.
 *
 * Use this for focused in-process route tests that need ad-hoc spec/
 * task/review data with custom ULIDs. For tests that exercise realistic
 * project content drawn from the shared e2e fixture set, prefer
 * {@link setupFixtures} instead.
 *
 * Pre-conditions:
 *   - tempDir exists and is a clean directory
 *   - `initGitRepo(tempDir)` has been called
 *
 * Post-conditions:
 *   - `<tempDir>/.kspec/` exists (empty placeholder; not a worktree)
 *   - `<tempDir>/modules/` contains the requested module YAML files
 *   - `<tempDir>/kynetic.yaml` contains the manifest
 *   - Optional project.* and kynetic.meta.yaml files exist as requested
 *   - `<tempDir>/.kspec-sessions/` exists for any session-touching routes
 *   - All files are committed unless `skipCommit` is true
 */
export function setupInlineFixtures(tempDir: string, files: InlineProjectFiles = {}): void {
  if (files.tasksFile !== undefined && files.splitTasks !== undefined) {
    throw new Error(
      "setupInlineFixtures: provide either tasksFile or splitTasks, not both",
    );
  }

  mkdirSync(path.join(tempDir, ".kspec"), { recursive: true });
  mkdirSync(path.join(tempDir, "modules"), { recursive: true });
  mkdirSync(path.join(tempDir, ".kspec-sessions"), { recursive: true });

  const manifest = files.manifest ?? DEFAULT_INLINE_MANIFEST;
  writeFileSync(path.join(tempDir, "kynetic.yaml"), manifest);

  const modules = files.modules ?? {};
  for (const [name, content] of Object.entries(modules)) {
    writeFileSync(path.join(tempDir, "modules", name), content);
  }
  // The default manifest includes modules/test.yaml — make sure that file
  // exists even when the caller did not provide a modules override, so
  // includes resolution does not 500.
  if (
    files.manifest === undefined &&
    !Object.prototype.hasOwnProperty.call(modules, "test.yaml")
  ) {
    writeFileSync(path.join(tempDir, "modules", "test.yaml"), "features: []\n");
  }

  if (files.tasksFile !== undefined) {
    writeFileSync(path.join(tempDir, "project.tasks.yaml"), files.tasksFile);
  }
  if (files.splitTasks !== undefined) {
    for (const task of files.splitTasks) {
      seedSplitTask(tempDir, task);
    }
  }

  if (files.reviews !== undefined) {
    writeFileSync(path.join(tempDir, "project.reviews.yaml"), files.reviews);
  }
  if (files.plans !== undefined) {
    writeFileSync(path.join(tempDir, "project.plans.yaml"), files.plans);
  }
  if (files.inbox !== undefined) {
    writeFileSync(path.join(tempDir, "project.inbox.yaml"), files.inbox);
  }
  if (files.triage !== undefined) {
    writeFileSync(path.join(tempDir, "project.triage.yaml"), files.triage);
  }
  if (files.meta !== undefined) {
    writeFileSync(path.join(tempDir, "kynetic.meta.yaml"), files.meta);
  }

  if (!files.skipCommit) {
    execSync('git add -A && git commit -m "kspec project setup"', { cwd: tempDir, stdio: "pipe" });
  }
}

export interface CreateTestAppOptions {
  /**
   * EntityCacheAccessor passed to routes that participate in the
   * cache-write-through layer (tasks, reviews, etc.). Provide a fake
   * cache when the test is asserting cache-consistency behavior; omit
   * for tests that exercise route logic without a cache.
   */
  getEntityCache?: EntityCacheAccessor;
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
export function createTestApp(options: CreateTestAppOptions = {}): {
  app: Elysia;
  pubsub: PubSubManager;
  manager: ProjectContextManager;
} {
  const { getEntityCache } = options;
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
    .use(createTasksRoutes({ pubsub, getEntityCache }))
    .use(createItemsRoutes())
    .use(createReviewsRoutes({ pubsub, getEntityCache }))
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

/**
 * Make a JSON-bodied request to the Elysia app. Auto-stringifies `body`
 * (when provided) and forwards to {@link makeRequest}. Handles the
 * common `(method, urlPath, body)` invocation shape used by mutation
 * tests so each test file does not need to redefine its own helper.
 */
export function requestJson(
  app: Elysia,
  tempDir: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return makeRequest(app, tempDir, urlPath, init);
}

/**
 * Spy on a {@link PubSubManager}'s `broadcast` method for assertion
 * tests of websocket-related route side effects.
 *
 * Returns the underlying `vi.spyOn` mock so existing assertion patterns
 * (`spy.mock.calls`, `expect(spy).toHaveBeenCalledWith(...)`,
 * `spy.mockClear()`) continue to work directly without translation.
 * Centralizing this behind a helper keeps the broadcast method name in
 * one place and avoids importing `vi` into every websocket-side-effect
 * test purely for spying. Tests still call `vi.restoreAllMocks()` (or
 * `spy.mockRestore()`) in their own afterEach to clean up.
 */
export function captureBroadcasts(pubsub: PubSubManager) {
  return vi.spyOn(pubsub, "broadcast");
}

export { createTempDir, cleanupTempDir, initGitRepo, seedSplitTask, testUlid, testUlids };
