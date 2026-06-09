/**
 * Browser-fetch HTTP-outcome contract tests for resource URL project routing.
 *
 * The web-ui URL builders/rewriters — `reviewResourceBytesUrl` (`$lib/api`),
 * `buildPlanContentBlocks` -> `rewritePlanResourceLinks`, and
 * `rewriteTaskResourceLinks` — produce the URLs a browser `<img src>` /
 * `<a href>` requests. Those element-issued requests cannot send the
 * `X-Kspec-Dir` header the rest of the API relies on, so the selected
 * project's path MUST travel inside the URL as a `?kspec_dir=` query
 * parameter. The unit-level URL-shape pins live in
 * `tests/web-ui/resource-url-project-context.test.ts` and
 * `tests/web-ui/task-resource-links.test.ts`.
 *
 * THIS file closes the review finding that those pins "stop at URL-string
 * construction": each builder/rewriter output is fetched against a real
 * multi-project daemon WITHOUT an `X-Kspec-Dir` header and we assert the
 * SELECTED project's bytes come back — not the default project's bytes and
 * not a 404. Two projects are registered against one daemon: project A is the
 * default, project B is the selected non-default project. The same entity id
 * holds DIFFERENT bytes in each project, so any request that silently falls
 * back to the default returns A's bytes and the selected-project assertion
 * fails — exactly the user-facing defect (wrong / missing screenshot) these
 * ACs guard against.
 *
 * FLIPPED-ON-FIX protocol (see tests/lint-no-leaky-test-daemon.test.ts): the
 * plan and task rewrites are project-unaware today, so their end-to-end fetch
 * contracts are `it.fails` until the sibling task
 * `@generalize-live-ui-resource-markdown-rewriting` makes the rewrites append
 * `kspec_dir`. The review builder already appends `kspec_dir`, so its fetch
 * contracts are the passing comparator the plan/task rewrites are brought up
 * to parity with.
 *
 * The plan and review fetches hit the REAL daemon resource bytes routes
 * (`createTestApp`). The task resource bytes route lands in a later task, so
 * the task fetches go through a faithful stand-in route mounted on the REAL
 * `projectContextMiddleware` — only the byte-serving handler is simulated; the
 * project routing under contract (header-or-`kspec_dir`-or-default) is the
 * production middleware.
 *
 * Spec: @live-plan-resource-url-project-context
 * Spec: @live-review-resource-url-project-context
 * Spec: @live-task-resource-markdown-rendering
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as yamlStringify } from "yaml";
import type { PlanDetail, PlanResourceMetadata } from "@kynetic-ai/shared";

import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  setupFixtures,
} from "./helpers.js";
import { projectContextMiddleware } from "../../dist/daemon/middleware/project-context.js";

// ── Web-ui store mocks (mirrors the unit-level web-ui contract tests) ────────
// The builders read the selected project path / daemon base / mode from these
// stores; mocking the module specifiers lets us import the real builders
// without a SvelteKit runtime. `projectState.selectedPath` is the selected
// non-default project (project B) for the browser-fetch case.
const modeState = vi.hoisted(() => ({ staticMode: false }));
const projectState = vi.hoisted(() => ({ selectedPath: null as string | null }));

const modeMock = vi.hoisted(() => () => ({
  getSnapshot: () => null,
  isStaticMode: () => modeState.staticMode,
  assertWritable: () => {},
  ReadOnlyModeError: class ReadOnlyModeError extends Error {},
}));
const projectMock = vi.hoisted(() => () => ({
  getSelectedProjectPath: () => projectState.selectedPath,
  clearInvalidSelection: () => {},
  isInvalidProjectError: () => false,
}));
const constantsMock = vi.hoisted(() => () => ({ DAEMON_API_BASE: "http://localhost:3456" }));

vi.mock("$lib/stores/mode.svelte", modeMock);
vi.mock("../../packages/web-ui/src/lib/stores/mode.svelte", modeMock);
vi.mock("$lib/stores/project.svelte", projectMock);
vi.mock("../../packages/web-ui/src/lib/stores/project.svelte", projectMock);
vi.mock("$lib/constants", constantsMock);
vi.mock("../../packages/web-ui/src/lib/constants", constantsMock);
vi.mock("$lib/api-static", () => ({}));
vi.mock("../../packages/web-ui/src/lib/api-static", () => ({}));

import { reviewResourceBytesUrl } from "../../packages/web-ui/src/lib/api";
import { buildPlanContentBlocks } from "../../packages/web-ui/src/lib/utils/plan-embedded-content";
import {
  rewriteTaskResourceLinks,
  type ResolvedTaskResourceLink,
} from "../../packages/web-ui/src/lib/utils/task-resource-links";

import type { Elysia as ElysiaType } from "elysia";

// Reuse the fixture review seeded by setupFixtures into project.reviews.yaml.
const REVIEW_ULID = "01KKTX0CA45ZT43W2T6HJMVA01";
const PLAN_ULID = "01KG0RRPCA45ZT43W2T6HJMVP1";
const PLAN_SLUG = "browser-fetch-plan";
const TASK_ULID = "01KG0RRPCA45ZT43W2T6HJMVT1";

const PLAN_RESOURCES_BASE = `/api/plans/${PLAN_ULID}/resources`;
const TASK_RESOURCES_BASE = `/api/tasks/${TASK_ULID}/resources`;

// Distinct bytes per project so a default-fallback request is detectable.
const PLAN_IMAGE_A = Buffer.from("plan-image-default-projectA");
const PLAN_IMAGE_B = Buffer.from("plan-image-selected-projectB");
const PLAN_DOC_A = Buffer.from("plan-doc-default-projectA");
const PLAN_DOC_B = Buffer.from("plan-doc-selected-projectB");

const REVIEW_IMAGE_A = Buffer.from("review-image-default-projectA");
const REVIEW_IMAGE_B = Buffer.from("review-image-selected-projectB");
const REVIEW_DOC_A = Buffer.from("review-doc-default-projectA");
const REVIEW_DOC_B = Buffer.from("review-doc-selected-projectB");

const TASK_PLAN_OWNED_A = Buffer.from("task-plan-owned-default-projectA");
const TASK_PLAN_OWNED_B = Buffer.from("task-plan-owned-selected-projectB");
const TASK_OWNED_COPY_A = Buffer.from("task-owned-copy-default-projectA");
const TASK_OWNED_COPY_B = Buffer.from("task-owned-copy-selected-projectB");

interface SeedResource {
  id: string;
  relPath: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Seed one curated active plan with declared resources into the folder-backed
 * layout the daemon resolves bytes from. Mirrors
 * tests/daemon-api/plan-resources.test.ts so resource bytes are deterministic.
 */
function seedPlan(tempDir: string, resources: SeedResource[]): void {
  execSync(`rm -rf ${path.join(tempDir, ".kspec", "plans")}`);
  writeFileSync(
    path.join(tempDir, ".kspec", "project.plans.yaml"),
    `kynetic_plans: "1.0"\nplans:\n  - _ulid: ${PLAN_ULID}\n    slugs:\n      - ${PLAN_SLUG}\n    title: Browser Fetch Plan\n    status: active\n    derived_tasks: []\n    derived_specs: []\n    source_path: null\n    created_at: "2026-01-15T10:00:00Z"\n    approved_at: "2026-01-16T12:00:00Z"\n    completed_at: null\n`,
  );

  const planDir = path.join(tempDir, ".kspec", "plans", PLAN_ULID);
  const resourcesDir = path.join(planDir, "resources");
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(
    path.join(planDir, "plan.yaml"),
    yamlStringify({
      _ulid: PLAN_ULID,
      slugs: [PLAN_SLUG],
      title: "Browser Fetch Plan",
      status: "active",
      derived_tasks: [],
      derived_specs: [],
      source_path: null,
      created_at: "2026-01-15T10:00:00Z",
      approved_at: "2026-01-16T12:00:00Z",
      completed_at: null,
    }),
  );
  writeFileSync(path.join(planDir, "plan.md"), "# Browser Fetch Plan\n");

  const manifestEntries = resources.map((r) => {
    const abs = path.join(resourcesDir, r.relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, r.bytes);
    return {
      id: r.id,
      label: null,
      path: r.relPath,
      content_type: r.contentType,
      bytes: r.bytes.length,
      sha256: createHash("sha256").update(r.bytes).digest("hex"),
      git_commit: null,
      git_path: null,
      description: null,
    };
  });
  writeFileSync(
    path.join(planDir, "resources.yaml"),
    yamlStringify({ resources: manifestEntries }),
  );
}

/**
 * Seed task resource bytes addressed by id into a project for the simulated
 * task bytes route. The future real route will project these from the task's
 * resolved_resources; here we store one file per resolved-resource id so the
 * simulated route can serve "this project's bytes for this id".
 */
function seedTaskResourceBytes(tempDir: string, byId: Record<string, Buffer>): void {
  const dir = path.join(tempDir, ".kspec", "tasks", TASK_ULID, "resources", "by-id");
  mkdirSync(dir, { recursive: true });
  for (const [id, bytes] of Object.entries(byId)) {
    writeFileSync(path.join(dir, id), bytes);
  }
}

/** Upload a review resource's bytes into a specific project via the real route. */
async function uploadReviewResource(
  app: ElysiaType,
  targetTempDir: string,
  resource: { id: string; path: string; type: string; bytes: Buffer },
): Promise<void> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([resource.bytes], { type: resource.type }),
    path.basename(resource.path),
  );
  form.append("id", resource.id);
  form.append("path", resource.path);
  const response = await app.handle(
    new Request(`http://localhost/api/reviews/${REVIEW_ULID}/resources`, {
      method: "POST",
      headers: { Host: "localhost", "X-Kspec-Dir": targetTempDir },
      body: form,
    }),
  );
  if (response.status !== 201) {
    const body = await response.text();
    throw new Error(
      `Failed to seed review resource ${resource.id} for ${targetTempDir}: expected 201, got ${response.status}. Body: ${body}`,
    );
  }
}

/**
 * A faithful stand-in for the future task resource bytes route, mounted on the
 * REAL project-context middleware. The simulated part is only byte serving
 * (read the per-project file the resolved-resource id maps to); the project
 * routing under contract — header wins, else `kspec_dir` query, else default —
 * is the production middleware.
 */
function createTaskBytesApp(): {
  app: ElysiaType;
  manager: ReturnType<typeof projectContextMiddleware>["manager"];
} {
  const { middleware, manager } = projectContextMiddleware();
  manager.startWatcher = async () => {};
  const app = new Elysia()
    .resolve(({ set }) => ({
      error: (status: number, body: unknown) => {
        set.status = status;
        return body;
      },
    }))
    .use(middleware)
    .get("/api/tasks/:ref/resources/:resourceId/bytes", async ({ params, projectContext, set }) => {
      // Reject anything but a bare id so a test resource id can never escape the
      // project's task resource directory.
      if (!/^[A-Za-z0-9._-]+$/.test(params.resourceId) || params.resourceId.includes("..")) {
        set.status = 400;
        return { error: "invalid_resource_id" };
      }
      const file = path.join(
        projectContext.path,
        ".kspec",
        "tasks",
        params.ref,
        "resources",
        "by-id",
        params.resourceId,
      );
      try {
        const bytes = await fs.readFile(file);
        set.headers["Content-Type"] = "application/octet-stream";
        return new Response(bytes);
      } catch {
        set.status = 404;
        return { error: "resource_not_found" };
      }
    });
  return { app, manager };
}

function planResource(overrides: Partial<PlanResourceMetadata> = {}): PlanResourceMetadata {
  return {
    id: "shot",
    label: null,
    path: "screenshots/login.png",
    content_type: "image/png",
    bytes: 4,
    sha256: "a".repeat(64),
    git_commit: null,
    git_path: null,
    description: null,
    ...overrides,
  };
}

function planWith(content: string, resources: PlanResourceMetadata[]): PlanDetail {
  return {
    _ulid: PLAN_ULID,
    slugs: [PLAN_SLUG],
    title: "Browser Fetch Plan",
    status: "active",
    created_at: "2026-01-15T10:00:00.000Z",
    derived_specs: [],
    derived_tasks: [],
    spec_count: 0,
    task_count: 0,
    task_progress: { total: 0, completed: 0, in_progress: 0, pending: 0, blocked: 0 },
    content,
    resources,
    resources_base_url: PLAN_RESOURCES_BASE,
  };
}

function firstMarkdown(plan: PlanDetail): string {
  const block = buildPlanContentBlocks(plan, {}).find((b) => b.type === "markdown");
  if (!block || block.type !== "markdown") throw new Error("expected a markdown block");
  return block.markdown;
}

/** Grab the URL target of a markdown image/link by its label. */
function grabTarget(markdown: string, image: boolean, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${image ? "!" : ""}\\[${escaped}\\]\\(([^)]+)\\)`);
  const m = markdown.match(re);
  return m ? m[1] : null;
}

function resolvedResource(
  overrides: Partial<ResolvedTaskResourceLink> = {},
): ResolvedTaskResourceLink {
  return {
    id: "diagram",
    path: "diagrams/flow.png",
    status: "present",
    owner_type: "plan",
    ...overrides,
  };
}

/**
 * Fetch a browser-issued resource URL against `app` with NO `X-Kspec-Dir`
 * header — the `<img src>` / `<a href>` case. A target that is not a daemon
 * `/api/...` path (e.g. an un-rewritten `./resources/...` reference) is
 * un-fetchable, surfaced as status 0 so the selected-project byte assertion
 * fails for the right reason.
 */
async function browserFetch(
  app: ElysiaType,
  target: string | null,
): Promise<{ status: number; bytes: Buffer }> {
  if (!target || !target.startsWith("/api/")) {
    return { status: 0, bytes: Buffer.alloc(0) };
  }
  const response = await app.handle(
    new Request(`http://localhost${target}`, { method: "GET", headers: { Host: "localhost" } }),
  );
  const bytes =
    response.status === 200 ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
  return { status: response.status, bytes };
}

let projectA: string; // default project
let projectB: string; // selected non-default project
let app: ElysiaType;
let taskApp: ElysiaType;

beforeEach(async () => {
  modeState.staticMode = false;
  projectA = await createTempDir("kspec-browser-fetch-default-a-");
  projectB = await createTempDir("kspec-browser-fetch-selected-b-");
  initGitRepo(projectA);
  initGitRepo(projectB);
  setupFixtures(projectA);
  setupFixtures(projectB);

  // The web-ui builders treat project B as the selected non-default project.
  projectState.selectedPath = projectB;

  // Seed plan resources (same ids, different bytes per project).
  seedPlan(projectA, [
    { id: "shot", relPath: "screenshots/login.png", contentType: "image/png", bytes: PLAN_IMAGE_A },
    { id: "specdoc", relPath: "docs/spec.md", contentType: "text/markdown", bytes: PLAN_DOC_A },
  ]);
  seedPlan(projectB, [
    { id: "shot", relPath: "screenshots/login.png", contentType: "image/png", bytes: PLAN_IMAGE_B },
    { id: "specdoc", relPath: "docs/spec.md", contentType: "text/markdown", bytes: PLAN_DOC_B },
  ]);

  // Seed task resolved-resource bytes (plan-owned + task-owned copy).
  seedTaskResourceBytes(projectA, { diagram: TASK_PLAN_OWNED_A, homecopy: TASK_OWNED_COPY_A });
  seedTaskResourceBytes(projectB, { diagram: TASK_PLAN_OWNED_B, homecopy: TASK_OWNED_COPY_B });

  // Real daemon app for plan + review routes; project A is the default.
  const built = createTestApp();
  app = built.app;
  built.manager.registerProject(projectA, true);
  built.manager.registerProject(projectB, false);

  // Seed review resource bytes into each project via the real upload route.
  await uploadReviewResource(app, projectA, {
    id: "shot",
    path: "shot.png",
    type: "image/png",
    bytes: REVIEW_IMAGE_A,
  });
  await uploadReviewResource(app, projectB, {
    id: "shot",
    path: "shot.png",
    type: "image/png",
    bytes: REVIEW_IMAGE_B,
  });
  await uploadReviewResource(app, projectA, {
    id: "designdoc",
    path: "design.md",
    type: "text/markdown",
    bytes: REVIEW_DOC_A,
  });
  await uploadReviewResource(app, projectB, {
    id: "designdoc",
    path: "design.md",
    type: "text/markdown",
    bytes: REVIEW_DOC_B,
  });

  // Simulated task bytes route on the real project-context middleware.
  const taskBuilt = createTaskBytesApp();
  taskApp = taskBuilt.app;
  taskBuilt.manager.registerProject(projectA, true);
  taskBuilt.manager.registerProject(projectB, false);
});

afterEach(async () => {
  projectState.selectedPath = null;
  vi.restoreAllMocks();
  await cleanupTempDir(projectA);
  await cleanupTempDir(projectB);
});

describe("plan resource browser URLs fetch the selected project's bytes", () => {
  // AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
  // The rendered plan image URL, fetched by the browser WITHOUT X-Kspec-Dir in
  // a multi-project daemon, must return the SELECTED project's plan resource
  // bytes — not the default project's bytes. it.fails until the plan rewrite
  // appends kspec_dir (today the URL omits it, so the request falls back to the
  // default project and returns project A's bytes).
  it("fetches the selected project's plan image bytes from the rendered image URL", async () => {
    const md = firstMarkdown(
      planWith("# Plan\n\n![login](./resources/screenshots/login.png)\n", [planResource()]),
    );
    const result = await browserFetch(app, grabTarget(md, true, "login"));
    expect(result.status).toBe(200);
    expect(result.bytes.equals(PLAN_IMAGE_B)).toBe(true);
    expect(result.bytes.equals(PLAN_IMAGE_A)).toBe(false);
  });

  // AC: @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
  // The rendered plan document link, opened by the browser WITHOUT X-Kspec-Dir,
  // must return the SELECTED project's plan document bytes. it.fails until the
  // plan rewrite is project-aware.
  it("fetches the selected project's plan document bytes from the rendered link URL", async () => {
    const md = firstMarkdown(
      planWith("# Plan\n\nSee [the spec](./resources/docs/spec.md).\n", [
        planResource({ id: "specdoc", path: "docs/spec.md", content_type: "text/markdown" }),
      ]),
    );
    const result = await browserFetch(app, grabTarget(md, false, "the spec"));
    expect(result.status).toBe(200);
    expect(result.bytes.equals(PLAN_DOC_B)).toBe(true);
    expect(result.bytes.equals(PLAN_DOC_A)).toBe(false);
  });

  // AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
  // Shape + routing guard for the rewritten plan image URL: now that the rewrite
  // is project-aware, the rendered URL carries the selected project's kspec_dir
  // query, and a no-header fetch of that exact URL resolves to project B (the
  // selected project) and returns B's bytes — not the default project A's. This
  // pins the precise URL shape the flipped it() tests above rely on.
  it("the rewritten plan image URL carries the selected project's kspec_dir and serves its bytes", async () => {
    const md = firstMarkdown(
      planWith("# Plan\n\n![login](./resources/screenshots/login.png)\n", [planResource()]),
    );
    const target = grabTarget(md, true, "login");
    expect(target).toBe(
      `${PLAN_RESOURCES_BASE}/shot/bytes?kspec_dir=${encodeURIComponent(projectB)}`,
    );
    const result = await browserFetch(app, target);
    expect(result.status).toBe(200);
    expect(result.bytes.equals(PLAN_IMAGE_B)).toBe(true);
    expect(result.bytes.equals(PLAN_IMAGE_A)).toBe(false);
  });

  // AC: @live-plan-resource-url-project-context ac-plan-resource-url-still-uses-plan-manifest
  // The plan bytes route only resolves declared manifest paths. A rendered URL
  // for an undeclared resource id must 404 rather than serve unrelated bytes —
  // proving the project-routed URL still resolves through the owning plan's
  // manifest. Holds today (the manifest gate is route-side) and must keep
  // holding once the rewrite becomes project-aware.
  it("404s a plan bytes URL for an id not in the plan manifest", async () => {
    const result = await browserFetch(
      app,
      `${PLAN_RESOURCES_BASE}/undeclared/bytes?kspec_dir=${encodeURIComponent(projectB)}`,
    );
    expect(result.status).toBe(404);
    expect(result.bytes.length).toBe(0);
  });
});

describe("review resource browser URLs fetch the selected project's bytes (passing comparator)", () => {
  // AC: @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
  // The working comparator: `reviewResourceBytesUrl` already appends kspec_dir,
  // so the rendered review image URL fetched WITHOUT X-Kspec-Dir returns the
  // SELECTED project's image bytes and not the default project's.
  it("fetches the selected project's review image bytes from the built URL", async () => {
    const url = new URL(reviewResourceBytesUrl(REVIEW_ULID, "shot"));
    const result = await browserFetch(app, url.pathname + url.search);
    expect(result.status).toBe(200);
    expect(result.bytes.equals(REVIEW_IMAGE_B)).toBe(true);
    expect(result.bytes.equals(REVIEW_IMAGE_A)).toBe(false);
  });

  // AC: @live-review-resource-url-project-context ac-review-doc-link-routes-to-selected-project
  // Same builder for a document resource: the rendered review document link
  // fetched WITHOUT X-Kspec-Dir returns the SELECTED project's document bytes.
  it("fetches the selected project's review document bytes from the built URL", async () => {
    const url = new URL(reviewResourceBytesUrl(REVIEW_ULID, "designdoc"));
    const result = await browserFetch(app, url.pathname + url.search);
    expect(result.status).toBe(200);
    expect(result.bytes.equals(REVIEW_DOC_B)).toBe(true);
    expect(result.bytes.equals(REVIEW_DOC_A)).toBe(false);
  });

  // AC: @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
  //     — with no project selected the built URL omits kspec_dir and the fetch
  //     resolves to the default project's bytes (project A). Pins the
  //     default-routing direction of the comparator.
  it("fetches the default project's review image bytes when no project is selected", async () => {
    projectState.selectedPath = null;
    const url = new URL(reviewResourceBytesUrl(REVIEW_ULID, "shot"));
    const result = await browserFetch(app, url.pathname + url.search);
    expect(result.status).toBe(200);
    expect(result.bytes.equals(REVIEW_IMAGE_A)).toBe(true);
  });
});

describe("task resource markdown browser URLs fetch the selected project's resolved bytes", () => {
  // AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
  // A non-drifted plan-owned resolved resource: the rewritten image URL,
  // fetched WITHOUT X-Kspec-Dir, returns the SELECTED project's plan-owned
  // resource bytes through the task-scoped route. it.fails until
  // rewriteTaskResourceLinks produces the project-scoped bytes URL (the stub
  // returns the markdown unchanged, leaving an un-fetchable ./resources ref).
  it("fetches the selected project's plan-owned bytes from the rewritten image URL", async () => {
    const md = rewriteTaskResourceLinks(
      "![flow](./resources/diagrams/flow.png)",
      [resolvedResource({ id: "diagram", path: "diagrams/flow.png", owner_type: "plan" })],
      TASK_RESOURCES_BASE,
    );
    const result = await browserFetch(taskApp, grabTarget(md, true, "flow"));
    expect(result.status).toBe(200);
    expect(result.bytes.equals(TASK_PLAN_OWNED_B)).toBe(true);
    expect(result.bytes.equals(TASK_PLAN_OWNED_A)).toBe(false);
  });

  // AC: @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
  // A non-drifted plan-owned document link: opening the rewritten URL WITHOUT
  // X-Kspec-Dir returns the SELECTED project's plan-owned document bytes.
  it("fetches the selected project's plan-owned doc bytes from the rewritten link URL", async () => {
    const md = rewriteTaskResourceLinks(
      "See [the diagram](./resources/diagrams/flow.png).",
      [resolvedResource({ id: "diagram", path: "diagrams/flow.png", owner_type: "plan" })],
      TASK_RESOURCES_BASE,
    );
    const result = await browserFetch(taskApp, grabTarget(md, false, "the diagram"));
    expect(result.status).toBe(200);
    expect(result.bytes.equals(TASK_PLAN_OWNED_B)).toBe(true);
    expect(result.bytes.equals(TASK_PLAN_OWNED_A)).toBe(false);
  });

  // AC: @live-task-resource-markdown-rendering ac-materialized-task-image-renders
  // A task-owned copy (derived with --materialize-resources): the rewritten
  // image URL fetched WITHOUT X-Kspec-Dir returns the SELECTED project's
  // task-owned copy bytes — proving the resolved-resource owner projection is
  // what gets served, not the plan-owned original. it.fails until the rewrite
  // lands.
  it("fetches the selected project's task-owned copy bytes from the rewritten image URL", async () => {
    const md = rewriteTaskResourceLinks(
      "![home](./resources/screens/home.png)",
      [resolvedResource({ id: "homecopy", path: "screens/home.png", owner_type: "task" })],
      TASK_RESOURCES_BASE,
    );
    const result = await browserFetch(taskApp, grabTarget(md, true, "home"));
    expect(result.status).toBe(200);
    expect(result.bytes.equals(TASK_OWNED_COPY_B)).toBe(true);
    // Not the plan-owned bytes and not the default project's copy.
    expect(result.bytes.equals(TASK_PLAN_OWNED_B)).toBe(false);
    expect(result.bytes.equals(TASK_OWNED_COPY_A)).toBe(false);
  });

  // AC: @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
  // A task-owned copy document link: opening the rewritten URL WITHOUT
  // X-Kspec-Dir returns the SELECTED project's task-owned copy document bytes.
  it("fetches the selected project's task-owned copy doc bytes from the rewritten link URL", async () => {
    const md = rewriteTaskResourceLinks(
      "Read [the notes](./resources/screens/home.png).",
      [resolvedResource({ id: "homecopy", path: "screens/home.png", owner_type: "task" })],
      TASK_RESOURCES_BASE,
    );
    const result = await browserFetch(taskApp, grabTarget(md, false, "the notes"));
    expect(result.status).toBe(200);
    expect(result.bytes.equals(TASK_OWNED_COPY_B)).toBe(true);
    expect(result.bytes.equals(TASK_OWNED_COPY_A)).toBe(false);
  });

  // Positive control / regression guard for the simulated task bytes route +
  // real project-context middleware: a task bytes URL that DOES carry the
  // selected project's kspec_dir, fetched WITHOUT X-Kspec-Dir, returns project
  // B's resolved bytes (and not project A's). This proves the it.fails tests
  // above fail only because the stub does not yet PRODUCE this URL — the routing
  // contract they assert is already satisfied by the middleware. When the
  // rewrite lands and emits exactly this shape, those tests flip green.
  it("the simulated task bytes route serves the selected project's bytes for a kspec_dir URL", async () => {
    const result = await browserFetch(
      taskApp,
      `${TASK_RESOURCES_BASE}/diagram/bytes?kspec_dir=${encodeURIComponent(projectB)}`,
    );
    expect(result.status).toBe(200);
    expect(result.bytes.equals(TASK_PLAN_OWNED_B)).toBe(true);
    expect(result.bytes.equals(TASK_PLAN_OWNED_A)).toBe(false);
  });

  // AC: @live-task-resource-markdown-rendering ac-unmatched-task-resource-reference-stays-raw
  // A `./resources/<path>` reference with no matching resolved resource must
  // stay raw — never rewritten to a bytes URL. The raw reference is therefore
  // un-fetchable as a daemon URL (status 0), so no bytes are served. Holds
  // under the no-op stub and must keep holding after the rewrite lands.
  it("does not produce a fetchable bytes URL for an unmatched task resource reference", async () => {
    const md = rewriteTaskResourceLinks(
      "![gone](./resources/screens/missing.png)",
      [resolvedResource({ id: "diagram", path: "diagrams/flow.png" })],
      TASK_RESOURCES_BASE,
    );
    const target = grabTarget(md, true, "gone");
    expect(target).toBe("./resources/screens/missing.png");
    const result = await browserFetch(taskApp, target);
    expect(result.status).toBe(0);
    expect(result.bytes.length).toBe(0);
  });
});
