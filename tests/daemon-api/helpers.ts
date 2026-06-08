/**
 * Shared test helpers for daemon API route-handler integration tests.
 *
 * Scope (what these helpers cover):
 *   - In-process Elysia app driven via app.handle() that registers a
 *     curated subset of the daemon's API route handlers (see
 *     {@link createTestApp} for the exact list). No HTTP listener is
 *     started; tests assert request/response behavior on individual
 *     route handlers and any in-process side effects (e.g. PubSub
 *     broadcasts via {@link captureBroadcasts}).
 *   - Project-context middleware with the file watcher disabled, so
 *     tests do not leak Chokidar/inotify watchers across the suite.
 *   - Two project-fixture builders: {@link setupFixtures} (e2e shadow
 *     fixture set) and {@link setupInlineFixtures} (ad-hoc inline YAML).
 *
 * Out of scope (what these helpers do NOT cover):
 *   - Production server-level middleware: CORS, localhost-only host
 *     enforcement, WebSocket origin checks, web UI static serving, the
 *     inline /api/health endpoint, and the /ws WebSocket endpoint are
 *     all wired by `createServer()` (packages/daemon/src/server.ts) and
 *     are absent from {@link createTestApp}.
 *   - Production routes that {@link createTestApp} does not register
 *     (projects, refs, diff, command, automation, debug, plus the
 *     KSPEC_TEST-only test-hooks group). Any test asserting these
 *     routes must build its own app or use a real daemon child.
 *   - Server lifecycle wiring: heartbeat, watcher health monitor,
 *     dispatch-engine file change forwarding, entity-cache
 *     load-on-register, shadow sync, session sync, and SIGTERM/SIGINT
 *     graceful shutdown are all server-level concerns and are not
 *     reproduced here.
 *   - WebSocket protocol behavior (open/message/ping/pong/close,
 *     heartbeat, reconnect). Use a real daemon child via
 *     tests/helpers/daemon.ts (see tests/daemon-api/websocket-protocol.test.ts).
 *
 * Choosing a helper:
 *   - Asserting an API route handler in the supported subset (route
 *     handler logic, validation, response envelope, broadcast side
 *     effects) → use {@link createTestApp}. Pattern established in
 *     tests/daemon-api-input-validation.test.ts.
 *   - Asserting CORS, localhost enforcement, /api/health, or any other
 *     server-level middleware → build the production middleware in the
 *     test (see tests/daemon-api/server.test.ts) or import the production
 *     route under test directly (see tests/daemon-api/projects.test.ts).
 *   - Asserting WebSocket protocol or daemon process boundary
 *     behavior → spawn a real daemon (see tests/daemon-api/websocket-protocol.test.ts).
 */

import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Elysia } from "elysia";
import { vi } from "vitest";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
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
import { createTaskResourcesRoutes } from "../../dist/daemon/routes/task-resources.js";
import { createItemsRoutes } from "../../dist/daemon/routes/items.js";
import { createReviewsRoutes } from "../../dist/daemon/routes/reviews.js";
import { createReviewResourcesRoutes } from "../../dist/daemon/routes/review-resources.js";
import { createTriageRoutes } from "../../dist/daemon/routes/triage.js";
import { createPlansRoutes } from "../../dist/daemon/routes/plans.js";
import { createPlanResourcesRoutes } from "../../dist/daemon/routes/plan-resources.js";
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

  // AC: @entity-folder-migration-and-compatibility-1 ac-new-projects-declare-folder-storage
  // AC: @entity-folder-migration-and-compatibility-1 ac-unmigrated-projects-are-blocked-with-guidance
  //   — daemon review/plan/resource routes require folder-backed storage. The
  //   on-disk e2e fixture remains kynetic 1.0 to keep Playwright watcher specs
  //   happy, but every in-process daemon API test that calls setupFixtures()
  //   exercises the post-upgrade contract, so we overwrite the copied manifest
  //   with the 1.2 folder-backed declaration here and materialise matching
  //   `.kspec/reviews/<ulid>/` and `.kspec/plans/<ulid>/` shells below.
  writeFileSync(
    path.join(kspecDir, "kynetic.yaml"),
    `kynetic: "1.2"

project:
  name: "E2E Test Project"
  version: "0.1.0"
  status: draft
  description: A test project for E2E testing

includes:
  - modules/core.yaml

tasks_file: project.tasks.yaml
inbox_file: project.inbox.yaml
meta_file: kynetic.meta.yaml

task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
resource_storage:
  format: entity_scoped
`,
  );

  // Copy modules directory
  cpSync(path.join(E2E_FIXTURES, "modules"), path.join(kspecDir, "modules"), { recursive: true });

  // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
  // Create folder shells so detectPartialLayoutForDomain sees a consistent
  // layout. `loadPlans` / `loadReviewRecords` still serve full record data
  // from the copied monolithic files until the sibling folder-backed storage
  // manager replaces those readers.
  materializeFolderBackedReviewShells(kspecDir);
  materializeFolderBackedPlanShells(kspecDir);

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

/**
 * Folder-backed (kynetic 1.2) inline manifest. Declares the storage formats
 * that the daemon review/plan/resource route gates require:
 *   - `task_storage.format: split`
 *   - `plan_storage.format: folder`
 *   - `review_storage.format: folder`
 *   - `resource_storage.format: entity_scoped`
 *
 * Pair with {@link materializeFolderBackedReviewShells} /
 * {@link materializeFolderBackedPlanShells} (or rely on
 * {@link setupInlineFixtures}'s manifest auto-detection) so the
 * partial-layout detector sees matching `.kspec/<domain>/<ulid>/` folders
 * for each entry in the supplied monolithic YAML.
 */
export const FOLDER_BACKED_INLINE_MANIFEST = `kynetic: "1.2"
task_storage:
  format: split
plan_storage:
  format: folder
review_storage:
  format: folder
resource_storage:
  format: entity_scoped
project:
  name: Test Project
  version: "0.1.0"
  status: draft
includes:
  - modules/test.yaml
`;

/**
 * Materialise folder-shell directories for entries in a monolithic
 * `project.<domain>.yaml`. The partial-layout detector compares the ULIDs
 * declared in the index against the ULIDs of folders on disk that contain
 * the domain sidecar (`plan.yaml` / `review.yaml`). When both sets match,
 * the layout is treated as consistent and the strict folder-storage gate
 * passes.
 *
 * Until the sibling folder-backed storage manager lands, `loadPlans` /
 * `loadReviewRecords` still read from the monolithic file; these shells
 * exist solely so the gate accepts the fixture as folder-backed.
 *
 * AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
 */
function materializeFolderShellsFor(
  specDir: string,
  arrayKey: "plans" | "reviews",
  sidecarName: "plan.yaml" | "review.yaml",
): void {
  const monolithicPath = path.join(specDir, `project.${arrayKey}.yaml`);
  let raw: string;
  try {
    // Reads test-fixture YAML the caller just wrote into a temp specDir so
    // we can materialise per-entity folder shells the new folder-backed
    // managers expect. Not source scanning — the only consumer is fixture
    // bootstrap for daemon tests.
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads
    raw = readFileSync(monolithicPath, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = yamlParse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const arr = (parsed as Record<string, unknown>)[arrayKey];
  if (!Array.isArray(arr)) return;

  const folderRoot = path.join(specDir, arrayKey);
  mkdirSync(folderRoot, { recursive: true });
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record._ulid;
    if (typeof id !== "string" || id.length === 0) continue;
    const dir = path.join(folderRoot, id);
    mkdirSync(dir, { recursive: true });

    if (arrayKey === "reviews" && sidecarName === "review.yaml") {
      // Reviews are folder-backed and keep ONE cohesive review.yaml — the
      // full structured ReviewRecord lives inside the per-review sidecar so
      // the folder-backed manager can serve detail reads directly without
      // also touching the monolithic file.
      writeFileSync(path.join(dir, "review.yaml"), yamlStringify(record));
    } else if (arrayKey === "plans" && sidecarName === "plan.yaml") {
      // Plans are folder-backed: split the monolithic record into the
      // authoritative sidecars (plan.yaml metadata, plan.md content,
      // notes.yaml when notes exist). The folder-backed plan storage
      // manager reads from these — empty placeholder sidecars are not
      // enough.
      const { content, notes, ...core } = record;
      const documentContent = typeof content === "string" ? content : "";
      writeFileSync(path.join(dir, "plan.yaml"), yamlStringify(core));
      writeFileSync(path.join(dir, "plan.md"), documentContent);
      if (Array.isArray(notes) && notes.length > 0) {
        writeFileSync(path.join(dir, "notes.yaml"), yamlStringify({ notes }));
      }
    } else {
      // Minimal sidecar — the partial-layout detector only checks
      // existence, not contents.
      writeFileSync(path.join(dir, sidecarName), `_ulid: "${id}"\n`);
    }
  }
}

/**
 * Create folder shells for every review ULID in the monolithic
 * `project.reviews.yaml` so a folder-backed manifest's partial-layout
 * detector accepts the fixture. `specDir` is the directory that holds the
 * monolithic file (e.g. `<tempDir>/.kspec` for {@link setupFixtures} or
 * `<tempDir>` for {@link setupInlineFixtures}).
 */
export function materializeFolderBackedReviewShells(specDir: string): void {
  materializeFolderShellsFor(specDir, "reviews", "review.yaml");
}

/**
 * Create folder shells for every plan ULID in the monolithic
 * `project.plans.yaml`. See {@link materializeFolderBackedReviewShells}.
 */
export function materializeFolderBackedPlanShells(specDir: string): void {
  materializeFolderShellsFor(specDir, "plans", "plan.yaml");
}

/**
 * Detect from a manifest YAML string whether the project declares folder-
 * backed storage for the given domain. Returns true only when the relevant
 * declaration parses as `format: folder` (plans/reviews) or
 * `format: entity_scoped` (resources). Used by {@link setupInlineFixtures}
 * to auto-materialise folder shells when the caller passes monolithic
 * reviews/plans alongside a folder-backed manifest.
 */
function manifestDeclaresFolderFormat(manifestText: string, domain: "plans" | "reviews"): boolean {
  let parsed: unknown;
  try {
    parsed = yamlParse(manifestText);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const key = domain === "plans" ? "plan_storage" : "review_storage";
  const storage = (parsed as Record<string, unknown>)[key];
  if (!storage || typeof storage !== "object") return false;
  return (storage as Record<string, unknown>).format === "folder";
}

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
    throw new Error("setupInlineFixtures: provide either tasksFile or splitTasks, not both");
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
  if (files.manifest === undefined && !Object.prototype.hasOwnProperty.call(modules, "test.yaml")) {
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
    // AC: @entity-folder-migration-and-compatibility-1 ac-partial-folder-layouts-are-blocked
    // When the manifest declares folder-backed review storage, create matching
    // .kspec/reviews/<ulid>/review.yaml shells so the partial-layout detector
    // accepts the fixture as a consistent folder-backed layout.
    if (manifestDeclaresFolderFormat(manifest, "reviews")) {
      materializeFolderBackedReviewShells(tempDir);
    }
  }
  if (files.plans !== undefined) {
    writeFileSync(path.join(tempDir, "project.plans.yaml"), files.plans);
    if (manifestDeclaresFolderFormat(manifest, "plans")) {
      materializeFolderBackedPlanShells(tempDir);
    }
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
 * Build an in-process Elysia app that registers the curated subset of
 * API route handlers used by route-handler integration tests. The app is
 * exercised via `app.handle(Request)`; no HTTP listener is started.
 *
 * Registered route groups (each via the same constructor used by
 * `createServer()` in packages/daemon/src/server.ts):
 *   - createTasksRoutes        → /api/tasks/*
 *   - createTaskResourcesRoutes → /api/tasks/:ref/resources/*
 *   - createItemsRoutes        → /api/items/*
 *   - createReviewsRoutes      → /api/reviews/*
 *   - createTriageRoutes       → /api/triage/*
 *   - createPlansRoutes        → /api/plans/*
 *   - createSessionRoutes      → /api/sessions/*
 *   - createValidationRoutes   → /api/validate, /api/search (prefix /api)
 *   - createMetaRoutes         → /api/meta/*
 *   - createInboxRoutes        → /api/inbox/*
 *   - createAggregationRoutes  → /api/aggregation/*
 *   - createAgentDispatchRoutes → /api/agent/*
 *
 * Production routes that this helper does NOT register (asserting
 * these will return 404):
 *   - Inline /api/health endpoint (defined inline on the production app)
 *   - createProjectsRoutes      → /api/projects/*
 *   - createRefsRoutes          → /api/refs/*
 *   - createDiffRoutes          → /api/diff and related
 *   - createCommandRoutes       → /api/command/*
 *   - createAutomationRoutes    → /api/* automation actions
 *   - createDebugRoutes         → /api/debug/*
 *   - createTestHookRoutes      → /api/__test__/* (KSPEC_TEST-gated)
 *   - WebSocket endpoint        → /ws
 *   - Web UI static + entry routes (/, /assets/*, etc.)
 *
 * Production server-level wiring that this helper does NOT reproduce:
 *   - CORS plugin and origin allow-list
 *   - localhostOnly Host header enforcement
 *   - Heartbeat and connection-state managers, watcher health monitor
 *   - File watcher startup (the project-context manager's `startWatcher`
 *     is overridden to a no-op so route-handler tests do not leak
 *     filesystem watchers across the suite)
 *   - Entity cache load-on-register / unregister cleanup callbacks
 *   - Shadow sync and session sync schedulers
 *   - Dispatch-engine file change forwarding
 *   - SIGTERM/SIGINT graceful shutdown handlers
 *
 * Use this helper for tests that only need route-handler request /
 * response behavior or in-process broadcast side effects. Tests that
 * assert any of the omitted concerns must build their own app or use a
 * real daemon child (see the file-level docstring for guidance).
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
    .use(createTaskResourcesRoutes({ getEntityCache }))
    .use(createItemsRoutes())
    .use(createReviewsRoutes({ pubsub, getEntityCache }))
    .use(createReviewResourcesRoutes({ pubsub, getEntityCache }))
    .use(createTriageRoutes({ pubsub }))
    .use(createPlansRoutes({ getEntityCache }))
    .use(createPlanResourcesRoutes({ getEntityCache }))
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
  // For FormData bodies, omit the explicit Content-Type so the Request
  // constructor derives `multipart/form-data; boundary=…` automatically.
  // Explicit `application/json` would prevent the multipart body from
  // being parsed by `request.formData()` on the route side.
  const isFormDataBody = typeof FormData !== "undefined" && init.body instanceof FormData;
  const autoContentType =
    init.body && !isFormDataBody ? { "Content-Type": "application/json" } : {};
  return app.handle(
    new Request(`http://localhost${urlPath}`, {
      method: init.method ?? "GET",
      headers: {
        Host: "localhost",
        "X-Kspec-Dir": tempDir,
        ...autoContentType,
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
