/**
 * Resource lifecycle — holistic end-to-end proof in real temp projects.
 *
 * The per-surface resource behaviours already have focused coverage:
 * URL/route project-context routing in
 * `tests/daemon-api/resource-url-browser-fetch-contract.test.ts`, the
 * task `resolved_resources` projection in
 * `tests/daemon-api/task-resolved-resources.test.ts`, the task bytes route in
 * `tests/daemon-api/task-resources.test.ts`, and static-export asset copy in
 * `tests/export/{plan,task}-resources.test.ts` +
 * `tests/review-resource-static-export.test.ts`. Those drive rewriter
 * functions and `app.handle()` — none render in a real browser against a real
 * multi-project daemon fed by the real CLI authoring flow.
 *
 * THIS spec is the missing holistic proof. It builds two real temp projects
 * with the production CLI — one with default plan-owned task resource refs and
 * one derived with `--materialize-resources` (task-owned copies) — plus a
 * review carrying image + document resources, registers both with the isolated
 * E2E daemon (it never touches the host/dispatch daemon), selects the
 * non-default project in the live UI, and asserts that:
 *
 *   - the daemon bytes routes serve the project-scoped plan, task (plan-owned
 *     AND materialized), and review resource bytes via the `?kspec_dir=` query
 *     a browser `<img>/<a>` must carry;
 *   - the live plan markdown renders a real image (`naturalWidth > 0`) and a
 *     document link pointed at the plan bytes route;
 *   - the live task modal renders the resource image + document link for both
 *     the plan-owned and the materialized task;
 *   - the live review page renders the image card + document link;
 *   - `kspec export` writes the advertised plan/task/review resource assets to
 *     disk, with the plan-owned task asset bytes matching the recorded hash.
 *
 * Screenshots of each rendered surface are written under
 * `test-results/resource-lifecycle/` for the validation record.
 *
 * Spec: @live-plan-resource-url-project-context
 *       @task-resource-resolution-api-contract
 *       @live-task-resource-markdown-rendering
 *       @live-review-resource-url-project-context
 *       @static-export-resource-assets-complete
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { test, expect } from "./fixtures/test-base";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
} from "../helpers/cli.js";

// localStorage key the project store restores its selection from
// (packages/web-ui/src/lib/stores/project.svelte.ts).
const PROJECT_STORAGE_KEY = "kspec-selected-project";

// A real 1x1 PNG so a browser `<img>` that loads it reports naturalWidth > 0.
// "PNG_BYTES"-style placeholder text would decode to a broken image and make
// the render assertions meaningless.
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const DESIGN_DOC = "# Design Doc\n";

const PLAN_SLUG = "plan-resource-lifecycle-e2e";
const PLAN_REF = `@${PLAN_SLUG}`;
const TASK_SLUG = "implement-resource-view";
const TASK_REF = `@${TASK_SLUG}`;
const MODULE_REF = "@resources-mod";

const SCREENSHOT_DIR = path.join(process.cwd(), "test-results", "resource-lifecycle");

interface ResolvedResource {
  id: string;
  path: string;
  content_type: string | null;
  status: string;
  owner_type: "plan" | "task";
  recorded_sha256: string;
}

interface TaskJson {
  _ulid: string;
  resolved_resources?: ResolvedResource[];
}

interface BuiltProject {
  dir: string;
  planUlid: string;
  taskUlid: string;
  /** image resolved-resource id + authoring path (`./resources/<path>`). */
  image: { id: string; path: string; sha256: string };
  /** document resolved-resource id + authoring path. */
  doc: { id: string; path: string; sha256: string };
  /** Present only when the project was built with a review. */
  review?: { ulid: string; imageId: string; docId: string };
}

/** Initialise a real folder-backed kspec project with a module. */
function initProject(dir: string): void {
  initGitRepo(dir);
  writeFileSync(path.join(dir, "README.md"), "# Resource lifecycle E2E\n");
  execSync('git add README.md && git commit -m "initial"', { cwd: dir, stdio: "pipe" });
  const init = kspecRun("init --no-prompt", dir, { env: { KSPEC_AUTHOR: "@test" } });
  if (init.exitCode !== 0) throw new Error(`kspec init failed: ${init.stderr}`);
  const mod = kspecRun("module add --title 'Resources Mod' --slug resources-mod", dir);
  if (mod.exitCode !== 0) throw new Error(`module add failed: ${mod.stderr}`);
}

/** Write the plan markdown + sibling resources.yaml the import reads. */
function writePlanImport(dir: string): string {
  const importsDir = path.join(dir, "imports");
  const resourcesDir = path.join(importsDir, "resources");
  mkdirSync(resourcesDir, { recursive: true });
  writeFileSync(path.join(resourcesDir, "diagram.png"), ONE_BY_ONE_PNG);
  writeFileSync(path.join(resourcesDir, "design.md"), DESIGN_DOC);
  writeFileSync(
    path.join(importsDir, "resources.yaml"),
    "resources:\n  - id: diagram\n    path: diagram.png\n  - id: design\n    path: design.md\n",
  );
  const planMd = `# Resource Lifecycle E2E

![diagram](./resources/diagram.png)

See [the design doc](./resources/design.md).

## Tasks

\`\`\`yaml
- title: Implement resource view
  slug: ${TASK_SLUG}
  resource_refs:
    - ./resources/diagram.png
    - ./resources/design.md
\`\`\`
`;
  const planMdPath = path.join(importsDir, "plan.md");
  writeFileSync(planMdPath, planMd);
  return planMdPath;
}

/**
 * Build a real project through the production CLI: import the plan (with its
 * sibling resources), derive its task (optionally materialising the resource
 * copies), author a task description that references the resolved resources,
 * and optionally attach a review with image + document resources.
 */
async function buildProject(opts: {
  materialize: boolean;
  withReview: boolean;
}): Promise<BuiltProject> {
  const dir = await createTempDir("kspec-rl-e2e-");
  initProject(dir);
  const planMdPath = writePlanImport(dir);

  const imp = kspecRun(`plan import "${planMdPath}" --status approved`, dir);
  if (imp.exitCode !== 0) throw new Error(`plan import failed: ${imp.stderr}`);

  const deriveFlags = opts.materialize ? "--materialize-resources" : "";
  const derive = kspecRun(`plan derive ${PLAN_REF} --module ${MODULE_REF} ${deriveFlags}`, dir);
  if (derive.exitCode !== 0) throw new Error(`plan derive failed: ${derive.stderr}`);

  const planUlid = kspecJson<{ _ulid: string }>(`plan get ${PLAN_REF}`, dir)._ulid;
  const task = kspecJson<TaskJson>(`task get ${TASK_REF}`, dir);
  const resolved = task.resolved_resources ?? [];
  const imageEntry = resolved.find((r) => r.content_type === "image/png");
  const docEntry = resolved.find((r) => r.content_type === "text/markdown");
  if (!imageEntry || !docEntry) {
    throw new Error(`expected image + doc resolved resources, got ${JSON.stringify(resolved)}`);
  }
  expect(imageEntry.status).toBe("present");
  expect(docEntry.status).toBe("present");
  expect(imageEntry.owner_type).toBe(opts.materialize ? "task" : "plan");

  // Author a description that references the resolved resources by their
  // resolved path so the UI's `rewriteTaskResourceLinks` (exact-path match)
  // rewrites them to the task bytes route. Materialised copies resolve under
  // `plan/<plan-ulid>/<file>`, plan-owned refs under the bare `<file>`.
  const description = `Renders ![diagram](./resources/${imageEntry.path}) and [the doc](./resources/${docEntry.path}).`;
  const setDesc = kspecRun(`task set ${TASK_REF} --description '${description}'`, dir);
  if (setDesc.exitCode !== 0) throw new Error(`task set description failed: ${setDesc.stderr}`);

  const built: BuiltProject = {
    dir,
    planUlid,
    taskUlid: task._ulid,
    image: { id: imageEntry.id, path: imageEntry.path, sha256: imageEntry.recorded_sha256 },
    doc: { id: docEntry.id, path: docEntry.path, sha256: docEntry.recorded_sha256 },
  };

  if (opts.withReview) {
    const review = kspecJson<{ _ulid: string }>(
      `review add --title 'Resource Review' --subject-type task --subject-ref ${TASK_REF}`,
      dir,
    );
    const imgSrc = path.join(dir, "imports", "resources", "diagram.png");
    const docSrc = path.join(dir, "imports", "resources", "design.md");
    const addImg = kspecRun(
      `review resource add @${review._ulid} "${imgSrc}" --id rimg --path review-img.png`,
      dir,
    );
    if (addImg.exitCode !== 0)
      throw new Error(`review resource add (img) failed: ${addImg.stderr}`);
    const addDoc = kspecRun(
      `review resource add @${review._ulid} "${docSrc}" --id rdoc --path review-doc.md`,
      dir,
    );
    if (addDoc.exitCode !== 0)
      throw new Error(`review resource add (doc) failed: ${addDoc.stderr}`);
    built.review = { ulid: review._ulid, imageId: "rimg", docId: "rdoc" };
  }

  return built;
}

/** Register a real project with the isolated E2E daemon (idempotent). */
async function registerProject(baseUrl: string, projectPath: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
  });
  // 409 = already registered (re-register across tests is fine).
  if (!res.ok && res.status !== 409) {
    throw new Error(`register project ${projectPath} failed: ${res.status} ${await res.text()}`);
  }
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Fetch resource bytes the browser way: no X-Kspec-Dir header, project in the query. */
async function fetchBytes(
  baseUrl: string,
  route: string,
  projectPath: string,
): Promise<{ status: number; bytes: Buffer; contentType: string | null; sha: string | null }> {
  const url = `${baseUrl}${route}?kspec_dir=${encodeURIComponent(projectPath)}`;
  const res = await fetch(url);
  const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  return {
    status: res.status,
    bytes,
    contentType: res.headers.get("content-type"),
    sha: res.headers.get("x-kspec-resource-sha256"),
  };
}

let projectDefault: BuiltProject;
let projectMaterialized: BuiltProject;

test.describe.configure({ mode: "serial" });

test.describe("resource lifecycle end-to-end", () => {
  test.beforeAll(async () => {
    // CLI authoring across two projects spawns many subprocesses; give the
    // shared setup room beyond the per-test default.
    test.setTimeout(180_000);
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    projectDefault = await buildProject({ materialize: false, withReview: true });
    projectMaterialized = await buildProject({ materialize: true, withReview: false });
  });

  test.afterAll(async () => {
    if (projectDefault) await cleanupTempDir(projectDefault.dir);
    if (projectMaterialized) await cleanupTempDir(projectMaterialized.dir);
  });

  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-plan-owned-ref
  // AC: @task-resource-resolution-api-contract ac-task-resource-bytes-serve-present-task-owned-copy
  // AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
  // AC: @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
  // AC: @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
  // AC: @live-review-resource-url-project-context ac-review-doc-link-routes-to-selected-project
  test("daemon bytes routes serve project-scoped plan, task, and review resources", async ({
    daemon,
  }) => {
    await registerProject(daemon.baseUrl, projectDefault.dir);
    await registerProject(daemon.baseUrl, projectMaterialized.dir);

    // Plan resource bytes (image + doc) in the default project.
    const planImg = await fetchBytes(
      daemon.baseUrl,
      `/api/plans/${projectDefault.planUlid}/resources/diagram/bytes`,
      projectDefault.dir,
    );
    expect(planImg.status).toBe(200);
    expect(planImg.bytes.equals(ONE_BY_ONE_PNG)).toBe(true);
    expect(planImg.contentType).toContain("image/png");
    expect(planImg.sha).toBe(sha256(ONE_BY_ONE_PNG));

    const planDoc = await fetchBytes(
      daemon.baseUrl,
      `/api/plans/${projectDefault.planUlid}/resources/design/bytes`,
      projectDefault.dir,
    );
    expect(planDoc.status).toBe(200);
    expect(planDoc.bytes.toString("utf8")).toBe(DESIGN_DOC);

    // Plan-owned task resource bytes route (default project).
    const taskPlanOwned = await fetchBytes(
      daemon.baseUrl,
      `/api/tasks/${projectDefault.taskUlid}/resources/${projectDefault.image.id}/bytes`,
      projectDefault.dir,
    );
    expect(taskPlanOwned.status).toBe(200);
    expect(taskPlanOwned.bytes.equals(ONE_BY_ONE_PNG)).toBe(true);
    expect(taskPlanOwned.contentType).toContain("image/png");

    // Materialised (task-owned copy) task resource bytes route.
    const taskMaterialized = await fetchBytes(
      daemon.baseUrl,
      `/api/tasks/${projectMaterialized.taskUlid}/resources/${projectMaterialized.image.id}/bytes`,
      projectMaterialized.dir,
    );
    expect(taskMaterialized.status).toBe(200);
    expect(taskMaterialized.bytes.equals(ONE_BY_ONE_PNG)).toBe(true);
    expect(taskMaterialized.contentType).toContain("image/png");

    // Review resource bytes (image + doc) in the default project.
    const review = projectDefault.review!;
    const reviewImg = await fetchBytes(
      daemon.baseUrl,
      `/api/reviews/${review.ulid}/resources/${review.imageId}/bytes`,
      projectDefault.dir,
    );
    expect(reviewImg.status).toBe(200);
    expect(reviewImg.bytes.equals(ONE_BY_ONE_PNG)).toBe(true);
    expect(reviewImg.contentType).toContain("image/png");

    const reviewDoc = await fetchBytes(
      daemon.baseUrl,
      `/api/reviews/${review.ulid}/resources/${review.docId}/bytes`,
      projectDefault.dir,
    );
    expect(reviewDoc.status).toBe(200);
    expect(reviewDoc.bytes.toString("utf8")).toBe(DESIGN_DOC);
  });

  // AC: @live-plan-resource-url-project-context ac-plan-image-routes-to-selected-project
  // AC: @live-plan-resource-url-project-context ac-plan-doc-link-routes-to-selected-project
  test("live plan markdown renders image + document link routed to the selected project", async ({
    page,
    daemon,
  }) => {
    await registerProject(daemon.baseUrl, projectDefault.dir);
    await registerProject(daemon.baseUrl, projectMaterialized.dir);
    await page.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          /* private mode */
        }
      },
      [PROJECT_STORAGE_KEY, projectDefault.dir],
    );

    await page.goto("/plans");
    await page.waitForLoadState("networkidle");

    const planCard = page.getByTestId("plan-card").filter({ hasText: "Resource Lifecycle E2E" });
    await expect(planCard).toBeVisible();
    await planCard.getByTestId("plan-expand-toggle").click();

    const rendered = planCard.getByTestId("plan-content-rendered").first();
    await expect(rendered).toBeVisible();

    // The rendered image points at the plan bytes route carrying the selected
    // project's kspec_dir, and actually loads a decodable image.
    const img = rendered.locator("img").first();
    await expect(img).toBeVisible();
    await img.scrollIntoViewIfNeeded();
    const imgSrc = await img.getAttribute("src");
    expect(imgSrc).toContain(`/api/plans/${projectDefault.planUlid}/resources/`);
    expect(imgSrc).toContain(`kspec_dir=${encodeURIComponent(projectDefault.dir)}`);
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);

    // The rendered document link targets the plan bytes route with project context.
    const docLink = rendered.locator("a", { hasText: "the design doc" }).first();
    const docHref = await docLink.getAttribute("href");
    expect(docHref).toContain(`/api/plans/${projectDefault.planUlid}/resources/`);
    expect(docHref).toContain(`kspec_dir=${encodeURIComponent(projectDefault.dir)}`);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "plan-resources.png"),
      fullPage: true,
    });
  });

  // AC: @live-task-resource-markdown-rendering ac-plan-owned-task-image-renders
  // AC: @live-task-resource-markdown-rendering ac-plan-owned-task-doc-link-opens
  test("live task modal renders plan-owned task resource image + document link", async ({
    page,
    daemon,
  }) => {
    await renderTaskModal(page, daemon, projectDefault, "task-plan-owned.png");
  });

  // AC: @live-task-resource-markdown-rendering ac-materialized-task-image-renders
  // AC: @live-task-resource-markdown-rendering ac-materialized-task-doc-link-opens
  test("live task modal renders materialized (task-owned copy) resource image + document link", async ({
    page,
    daemon,
  }) => {
    await renderTaskModal(page, daemon, projectMaterialized, "task-materialized.png");
  });

  async function renderTaskModal(
    page: import("@playwright/test").Page,
    daemon: { baseUrl: string },
    project: BuiltProject,
    screenshot: string,
  ): Promise<void> {
    await registerProject(daemon.baseUrl, projectDefault.dir);
    await registerProject(daemon.baseUrl, projectMaterialized.dir);
    await page.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          /* private mode */
        }
      },
      [PROJECT_STORAGE_KEY, project.dir],
    );

    await page.goto(`/tasks?ref=${TASK_SLUG}`);
    await page.waitForLoadState("networkidle");

    const panel = page.getByTestId("task-detail-panel");
    await expect(panel).toBeVisible();
    const description = panel.getByTestId("task-description");
    await expect(description).toBeVisible();

    const img = description.locator("img").first();
    await expect(img).toBeVisible();
    await img.scrollIntoViewIfNeeded();
    const imgSrc = await img.getAttribute("src");
    expect(imgSrc).toContain(`/api/tasks/${project.taskUlid}/resources/${project.image.id}/bytes`);
    expect(imgSrc).toContain(`kspec_dir=${encodeURIComponent(project.dir)}`);
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);

    const docLink = description.locator("a", { hasText: "the doc" }).first();
    const docHref = await docLink.getAttribute("href");
    expect(docHref).toContain(`/api/tasks/${project.taskUlid}/resources/${project.doc.id}/bytes`);
    expect(docHref).toContain(`kspec_dir=${encodeURIComponent(project.dir)}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, screenshot), fullPage: true });
  }

  // AC: @live-review-resource-url-project-context ac-review-image-routes-to-selected-project
  // AC: @live-review-resource-url-project-context ac-review-doc-link-routes-to-selected-project
  test("live review page renders resource image card + document link routed to the selected project", async ({
    page,
    daemon,
  }) => {
    await registerProject(daemon.baseUrl, projectDefault.dir);
    await registerProject(daemon.baseUrl, projectMaterialized.dir);
    const review = projectDefault.review!;
    await page.addInitScript(
      ([key, value]) => {
        try {
          localStorage.setItem(key, value);
        } catch {
          /* private mode */
        }
      },
      [PROJECT_STORAGE_KEY, projectDefault.dir],
    );

    await page.goto(`/reviews/${review.ulid}`);
    await page.waitForLoadState("networkidle");

    const grid = page.getByTestId("resources-grid");
    await expect(grid).toBeVisible();

    const imageItem = grid.locator(`[data-resource-id="${review.imageId}"]`);
    await expect(imageItem).toBeVisible();
    const imageHref = await imageItem.getAttribute("href");
    expect(imageHref).toContain(`/api/reviews/${review.ulid}/resources/${review.imageId}/bytes`);
    expect(imageHref).toContain(`kspec_dir=${encodeURIComponent(projectDefault.dir)}`);

    const preview = imageItem.getByTestId("resource-image-preview");
    await expect(preview).toBeVisible();
    await preview.scrollIntoViewIfNeeded();
    await expect
      .poll(async () =>
        preview.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      )
      .toBe(true);

    const docItem = grid.locator(`[data-resource-id="${review.docId}"]`);
    await expect(docItem).toBeVisible();
    const docHref = await docItem.getAttribute("href");
    expect(docHref).toContain(`/api/reviews/${review.ulid}/resources/${review.docId}/bytes`);
    expect(docHref).toContain(`kspec_dir=${encodeURIComponent(projectDefault.dir)}`);
    await expect(docItem.getByTestId("resource-binary-placeholder")).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "review-resources.png"),
      fullPage: true,
    });
  });

  // AC: @static-export-resource-assets-complete ac-static-plan-image-asset-exists
  // AC: @static-export-resource-assets-complete ac-static-plan-doc-asset-exists
  // AC: @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
  // AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
  // AC: @static-export-resource-assets-complete ac-static-review-image-asset-exists
  // AC: @static-export-resource-assets-complete ac-static-review-doc-asset-exists
  test("static export writes all plan, task, and review resource assets", async () => {
    // Default project export: plan assets, plan-owned task asset, review assets.
    const defExport = path.join(projectDefault.dir, "build");
    mkdirSync(defExport, { recursive: true });
    const defOut = path.join(defExport, "snapshot.json");
    expect(kspecRun(`export --format json --output "${defOut}"`, projectDefault.dir).exitCode).toBe(
      0,
    );

    const planImgAsset = path.join(
      defExport,
      `assets/resources/plan/${projectDefault.planUlid}/diagram.png`,
    );
    const planDocAsset = path.join(
      defExport,
      `assets/resources/plan/${projectDefault.planUlid}/design.md`,
    );
    expect(existsSync(planImgAsset)).toBe(true);
    expect(existsSync(planDocAsset)).toBe(true);

    const taskPlanOwnedAsset = path.join(
      defExport,
      `assets/resources/task/${projectDefault.taskUlid}/diagram.png`,
    );
    expect(existsSync(taskPlanOwnedAsset)).toBe(true);
    // The exported plan-owned task asset bytes match the recorded hash.
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads a test-generated export asset, not source
    expect(sha256(await readFile(taskPlanOwnedAsset))).toBe(projectDefault.image.sha256);

    const review = projectDefault.review!;
    const reviewImgAsset = path.join(
      defExport,
      `assets/resources/review/${review.ulid}/review-img.png`,
    );
    const reviewDocAsset = path.join(
      defExport,
      `assets/resources/review/${review.ulid}/review-doc.md`,
    );
    expect(existsSync(reviewImgAsset)).toBe(true);
    expect(existsSync(reviewDocAsset)).toBe(true);

    // Materialized project export: the task-owned copy asset exists.
    const matExport = path.join(projectMaterialized.dir, "build");
    mkdirSync(matExport, { recursive: true });
    const matOut = path.join(matExport, "snapshot.json");
    expect(
      kspecRun(`export --format json --output "${matOut}"`, projectMaterialized.dir).exitCode,
    ).toBe(0);

    const materializedAsset = path.join(
      matExport,
      `assets/resources/task/${projectMaterialized.taskUlid}/${projectMaterialized.image.path}`,
    );
    expect(existsSync(materializedAsset)).toBe(true);
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reads a test-generated export asset, not source
    expect(sha256(await readFile(materializedAsset))).toBe(projectMaterialized.image.sha256);
  });
});
