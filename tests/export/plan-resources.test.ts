/**
 * Static export — plan resource asset copy + markdown rewrite.
 *
 * Verifies that `kspec export --format json -o ...` and the underlying
 * `generateJsonSnapshot({ assetsOutputDir })` path copy plan-owned resource
 * files to the `assets/resources/plan/<plan-ulid>/<relative-path>` layout
 * and rewrite `./resources/<path>` markdown link/image targets to those
 * exported paths so the static UI loads them offline.
 *
 * Spec: @trait-entity-scoped-local-resources-1
 *       @folder-backed-plan-storage-1
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yamlStringify } from "yaml";

import {
  generateJsonSnapshot,
  PlanResourceExportError,
  rewritePlanContentForStaticExport,
  type ExportedPlanResource,
} from "../../src/export/index.js";
import { ensureSplitBackendRegistered } from "../../src/parser/split-backend.js";

import { cleanupTempDir } from "../helpers/cli.js";

ensureSplitBackendRegistered();

let tempDir: string;
let originalCwd: string;

async function setupFolderBackedProject() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-export-plan-resources-"));

  // Minimal kspec project with folder-backed plan storage declared so the
  // export pipeline finds a plan with a real resource manifest. Manifest
  // wires the v1.2 storage declarations the resource pipeline requires.
  await fs.writeFile(
    path.join(tempDir, "kynetic.yaml"),
    `kynetic: "1.2"
project:
  name: "Export Resource Test"
  version: "0.1.0"
  status: draft
includes:
  - modules/core.yaml
tasks_file: project.tasks.yaml
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
  await fs.writeFile(path.join(tempDir, "project.tasks.yaml"), "");
  await fs.mkdir(path.join(tempDir, "modules"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "modules", "core.yaml"), "features: []\n");
  await fs.writeFile(path.join(tempDir, "project.inbox.yaml"), 'kynetic_inbox: "1.0"\nitems: []\n');

  const planUlid = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
  const planDir = path.join(tempDir, "plans", planUlid);
  const resourcesDir = path.join(planDir, "resources");
  await fs.mkdir(resourcesDir, { recursive: true });

  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const resourceRelativePath = "screenshots/login.png";
  await fs.mkdir(path.join(resourcesDir, "screenshots"), { recursive: true });
  await fs.writeFile(path.join(resourcesDir, resourceRelativePath), bytes);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(
    path.join(planDir, "resources.yaml"),
    yamlStringify({
      resources: [
        {
          id: "login-shot",
          label: null,
          path: resourceRelativePath,
          content_type: "image/png",
          bytes: bytes.length,
          sha256,
          git_commit: null,
          git_path: null,
          description: null,
        },
      ],
    }),
  );

  await fs.writeFile(
    path.join(planDir, "plan.yaml"),
    yamlStringify({
      _ulid: planUlid,
      slugs: ["export-plan"],
      title: "Export Plan",
      status: "active",
      derived_tasks: [],
      derived_specs: [],
      source_path: null,
      created_at: "2026-01-15T10:00:00Z",
      approved_at: "2026-01-16T12:00:00Z",
      completed_at: null,
    }),
  );
  await fs.writeFile(
    path.join(planDir, "plan.md"),
    "# Export Plan\n\nLook at this screenshot:\n\n![login](./resources/screenshots/login.png)\n",
  );

  await fs.writeFile(
    path.join(tempDir, "project.plans.yaml"),
    yamlStringify({
      kynetic_plans: "1.0",
      plans: [
        {
          _ulid: planUlid,
          slugs: ["export-plan"],
          title: "Export Plan",
          status: "active",
          derived_tasks: [],
          derived_specs: [],
          source_path: null,
          created_at: "2026-01-15T10:00:00Z",
          approved_at: "2026-01-16T12:00:00Z",
          completed_at: null,
        },
      ],
    }),
  );

  // git init/commit so kspec context init works
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: tempDir, stdio: "pipe" });
  execSync("git config user.name 'kspec-test'", { cwd: tempDir, stdio: "pipe" });
  execSync("git config user.email 'kspec@test.local'", { cwd: tempDir, stdio: "pipe" });
  execSync("git add -A && git commit -m 'init'", { cwd: tempDir, stdio: "pipe" });

  return { planUlid, resourceRelativePath, bytes, sha256 };
}

beforeEach(() => {
  originalCwd = process.cwd();
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (tempDir) await cleanupTempDir(tempDir);
});

describe("static export — plan resources", () => {
  // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
  // AC: @trait-entity-scoped-local-resources-1 ac-resource-metadata-exposes-safe-preview-fields
  it("includes resource metadata with exported_path on each plan", async () => {
    const { planUlid } = await setupFolderBackedProject();
    process.chdir(tempDir);

    const snapshot = await generateJsonSnapshot();
    const plan = snapshot.plans?.find((p) => p._ulid === planUlid);
    expect(plan).toBeDefined();
    expect(plan!.resources).toHaveLength(1);
    expect(plan!.resources[0]).toMatchObject({
      id: "login-shot",
      path: "screenshots/login.png",
      content_type: "image/png",
      exported_path: `assets/resources/plan/${planUlid}/screenshots/login.png`,
    });
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites plan markdown ./resources/<path> link/image targets to the exported path", async () => {
    const { planUlid } = await setupFolderBackedProject();
    process.chdir(tempDir);

    const snapshot = await generateJsonSnapshot();
    const plan = snapshot.plans?.find((p) => p._ulid === planUlid);
    expect(plan).toBeDefined();
    expect(plan!.content).toContain(
      `![login](assets/resources/plan/${planUlid}/screenshots/login.png)`,
    );
    expect(plan!.content).not.toContain("./resources/screenshots/login.png");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
  // AC: @static-export-resource-assets-complete ac-static-plan-image-asset-exists
  it("copies resource files to the export root when assetsOutputDir is provided", async () => {
    const { planUlid, bytes } = await setupFolderBackedProject();
    process.chdir(tempDir);

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-export-out-"));
    try {
      const snapshot = await generateJsonSnapshot(false, { assetsOutputDir: exportDir });

      const plan = snapshot.plans?.find((p) => p._ulid === planUlid);
      // The rewritten plan image URL must point at an asset that exists on disk.
      const imageResource = plan!.resources.find((r) => r.path === "screenshots/login.png")!;
      const exportedFile = path.join(exportDir, imageResource.exported_path);
      expect(plan!.content).toContain(`![login](${imageResource.exported_path})`);
      const copied = await fs.readFile(exportedFile);
      expect(copied.equals(bytes)).toBe(true);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });

  // AC: @static-export-resource-assets-complete ac-static-plan-doc-asset-exists
  it("copies a plan document resource referenced from plan markdown to disk", async () => {
    const { planUlid } = await setupFolderBackedProject();
    process.chdir(tempDir);

    // Declare a markdown document resource alongside the image and reference it
    // from the plan markdown via a document link.
    const planDir = path.join(tempDir, "plans", planUlid);
    const resourcesDir = path.join(planDir, "resources");
    const docRelativePath = "docs/spec.md";
    const docBytes = Buffer.from("# Linked spec document\n\nReference content.\n", "utf-8");
    await fs.mkdir(path.join(resourcesDir, "docs"), { recursive: true });
    await fs.writeFile(path.join(resourcesDir, docRelativePath), docBytes);

    const docSha = createHash("sha256").update(docBytes).digest("hex");
    await fs.writeFile(
      path.join(planDir, "resources.yaml"),
      yamlStringify({
        resources: [
          {
            id: "login-shot",
            label: null,
            path: "screenshots/login.png",
            content_type: "image/png",
            bytes: 8,
            // Hash of the PNG magic bytes the fixture wrote.
            sha256: createHash("sha256")
              .update(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
              .digest("hex"),
            git_commit: null,
            git_path: null,
            description: null,
          },
          {
            id: "spec-doc",
            label: null,
            path: docRelativePath,
            content_type: "text/markdown",
            bytes: docBytes.length,
            sha256: docSha,
            git_commit: null,
            git_path: null,
            description: null,
          },
        ],
      }),
    );
    await fs.writeFile(
      path.join(planDir, "plan.md"),
      "# Export Plan\n\nSee the [spec](./resources/docs/spec.md) and screenshot:\n\n" +
        "![login](./resources/screenshots/login.png)\n",
    );

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-export-doc-"));
    try {
      const snapshot = await generateJsonSnapshot(false, { assetsOutputDir: exportDir });
      const plan = snapshot.plans?.find((p) => p._ulid === planUlid);
      const docResource = plan!.resources.find((r) => r.path === docRelativePath)!;
      expect(docResource.exported_path).toBe(
        `assets/resources/plan/${planUlid}/${docRelativePath}`,
      );
      // The rewritten plan document link points at the exported asset...
      expect(plan!.content).toContain(`[spec](${docResource.exported_path})`);
      // ...and that asset exists on disk with the declared bytes.
      const onDisk = await fs.readFile(path.join(exportDir, docResource.exported_path));
      expect(onDisk.equals(docBytes)).toBe(true);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-binary-resources-are-not-inlined-into-yaml
  it("does not embed resource bytes in the snapshot JSON", async () => {
    const { planUlid } = await setupFolderBackedProject();
    process.chdir(tempDir);

    const snapshot = await generateJsonSnapshot();
    const plan = snapshot.plans?.find((p) => p._ulid === planUlid);
    expect(plan).toBeDefined();
    const serialized = JSON.stringify(plan);
    // The resource bytes start with PNG magic bytes — none of those bytes
    // should appear in the JSON serialisation (only the sha256 hash).
    expect(serialized).not.toContain("PNG");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  // AC: @trait-entity-scoped-local-resources-1 ac-static-export-copies-resource-assets
  it("rejects the export with actionable guidance when a resource escapes via a symlinked resources/ subdir", async () => {
    const { planUlid } = await setupFolderBackedProject();
    process.chdir(tempDir);

    // Swap the plan's `resources/screenshots` directory for a symlink that
    // points outside the plan tree. The declared manifest entry still has
    // path `screenshots/login.png`, but the resolver must reject the copy
    // because the chain resolves through a symlink escape.
    const planDir = path.join(tempDir, "plans", planUlid);
    const screenshotsDir = path.join(planDir, "resources", "screenshots");
    const outside = path.join(tempDir, "outside-screenshots");
    await fs.mkdir(outside, { recursive: true });
    // Move the real file out into the outside tree, then replace the
    // original screenshots dir with a symlink that points to it.
    await fs.rename(path.join(screenshotsDir, "login.png"), path.join(outside, "login.png"));
    await fs.rm(screenshotsDir, { recursive: true, force: true });
    const fsSync = await import("node:fs");
    fsSync.symlinkSync(outside, screenshotsDir);

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-export-fail-"));
    try {
      await expect(
        generateJsonSnapshot(false, { assetsOutputDir: exportDir }),
      ).rejects.toBeInstanceOf(PlanResourceExportError);

      // No silent success: the assets output dir must not contain the
      // symlinked-through file under the expected exported path. (The
      // resolver rejects before any copy happens.)
      const exportedFile = path.join(
        exportDir,
        "assets",
        "resources",
        "plan",
        planUlid,
        "screenshots",
        "login.png",
      );
      let copied = false;
      try {
        await fs.stat(exportedFile);
        copied = true;
      } catch {
        copied = false;
      }
      expect(copied).toBe(false);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("PlanResourceExportError carries the plan ulid, resource path, and resolver reason", async () => {
    const { planUlid } = await setupFolderBackedProject();
    process.chdir(tempDir);

    // Same setup as above — swap a resources subdir for an escaping symlink.
    const planDir = path.join(tempDir, "plans", planUlid);
    const screenshotsDir = path.join(planDir, "resources", "screenshots");
    const outside = path.join(tempDir, "outside-screenshots-2");
    await fs.mkdir(outside, { recursive: true });
    await fs.rename(path.join(screenshotsDir, "login.png"), path.join(outside, "login.png"));
    await fs.rm(screenshotsDir, { recursive: true, force: true });
    const fsSync = await import("node:fs");
    fsSync.symlinkSync(outside, screenshotsDir);

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-export-fail2-"));
    try {
      try {
        await generateJsonSnapshot(false, { assetsOutputDir: exportDir });
        throw new Error("expected PlanResourceExportError");
      } catch (err) {
        expect(err).toBeInstanceOf(PlanResourceExportError);
        const e = err as PlanResourceExportError;
        expect(e.planUlid).toBe(planUlid);
        expect(e.resourcePath).toBe("screenshots/login.png");
        expect(e.reason).toMatch(/symlink/i);
        // Actionable guidance is part of the message so CLI users get a
        // single, structured failure surface.
        expect(e.message).toMatch(/Fix the manifest entry|re-run the export/);
      }
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });
});

describe("rewritePlanContentForStaticExport", () => {
  const resources: ExportedPlanResource[] = [
    {
      id: "shot",
      label: null,
      path: "screenshots/login.png",
      content_type: "image/png",
      bytes: 4,
      sha256: "a".repeat(64),
      git_commit: null,
      git_path: null,
      description: null,
      exported_path: "assets/resources/plan/01EXPORTED/screenshots/login.png",
    },
  ];

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("rewrites declared image targets", () => {
    const out = rewritePlanContentForStaticExport(
      "# Plan\n\n![login](./resources/screenshots/login.png)\n",
      resources,
    );
    expect(out).toContain("![login](assets/resources/plan/01EXPORTED/screenshots/login.png)");
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-resource-reference-resolves-within-owner
  it("leaves undeclared references untouched", () => {
    const out = rewritePlanContentForStaticExport(
      "Missing: ![alt](./resources/missing.png)\n",
      resources,
    );
    expect(out).toContain("./resources/missing.png");
  });
});
