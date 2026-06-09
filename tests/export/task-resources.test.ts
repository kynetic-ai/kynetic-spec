/**
 * Static export — task resource asset copy + markdown rewrite.
 *
 * Verifies that `kspec export --format json --output <file>` copies the actual
 * resource bytes a task's description advertises through `./resources/<path>`
 * to the `assets/resources/task/<task-ulid>/<relative-path>` layout, rewrites
 * the task description to those exported paths, and surfaces drift/missing
 * status without advertising an asset path for bytes that do not match the
 * task's recorded resource hash.
 *
 * These tests drive the real CLI end-to-end (init → plan + resource → derive →
 * export) and assert on files that actually exist on disk, not just on
 * snapshot JSON strings.
 *
 * Spec: @static-export-resource-assets-complete
 *       @trait-entity-scoped-local-resources-1
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
  kspecOutput as kspecOk,
} from "../helpers/cli.js";

const projectCli = path.resolve(__dirname, "..", "..", "dist", "cli", "index.js");
const canRunInit = existsSync(projectCli);

interface TaskResourceRefJson {
  owner_type: "plan" | "task";
  owner_ref: string;
  id: string;
  path: string;
  sha256: string;
}

interface TaskJson {
  _ulid: string;
  slugs: string[];
  resource_refs?: TaskResourceRefJson[];
}

interface ExportedTaskResourceJson {
  id: string;
  owner_type: "plan" | "task";
  path: string;
  status: "present" | "drift" | "missing" | "unresolved";
  recorded_sha256: string;
  current_sha256: string | null;
  exported_path?: string;
}

interface ExportedTaskJson {
  _ulid: string;
  slugs: string[];
  description?: string;
  resolved_resources?: ExportedTaskResourceJson[];
}

interface SnapshotJson {
  tasks: ExportedTaskJson[];
}

let tempDir: string;

async function setupFolderProject(): Promise<void> {
  tempDir = await createTempDir();
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', { cwd: tempDir, stdio: "pipe" });
  const result = kspecRun("init --no-prompt", tempDir, { env: { KSPEC_AUTHOR: "@test" } });
  if (result.exitCode !== 0) throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
}

/**
 * Build an approved plan with a single declared resource and a manual task in
 * its `## Tasks` block that references that resource via `resource_refs`.
 */
async function buildPlanWithResource(options: {
  planSlug: string;
  moduleSlug: string;
  taskSlug: string;
  resourceId: string;
  resourcePath: string;
  sourceContents: string;
}): Promise<{ planRef: string; planUlid: string }> {
  kspecOk(`module add --title "${options.moduleSlug}" --slug ${options.moduleSlug}`, tempDir);
  kspecOk(
    `plan add --title "${options.planSlug}" --slug ${options.planSlug} --content stub`,
    tempDir,
  );
  const planRef = `@${options.planSlug}`;

  const sourceFile = path.join(tempDir, `${options.resourceId}-source.bin`);
  await fs.writeFile(sourceFile, options.sourceContents, "utf-8");
  kspecOk(
    `plan resource add ${planRef} "${sourceFile}" --id ${options.resourceId} --path ${options.resourcePath}`,
    tempDir,
  );

  const planMd = `# ${options.planSlug}

## Tasks

\`\`\`yaml
- title: ${options.taskSlug}
  slug: ${options.taskSlug}
  resource_refs:
    - ./resources/${options.resourcePath}
\`\`\`
`;
  const planMdPath = path.join(tempDir, `${options.planSlug}-content.md`);
  await fs.writeFile(planMdPath, planMd, "utf-8");
  kspecOk(`plan set ${planRef} --content-file "${planMdPath}"`, tempDir);
  kspecOk(`plan set ${planRef} --status approved`, tempDir);

  const plan = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir);
  return { planRef, planUlid: plan._ulid };
}

function runExport(): { exportDir: string; snapshot: SnapshotJson } {
  const exportDir = path.join(tempDir, "build");
  const outputFile = path.join(exportDir, "snapshot.json");
  // mkdir handled by writeFile/copy creating dirs; ensure dir exists for output.
  execSync(`mkdir -p "${exportDir}"`, { stdio: "pipe" });
  const result = kspecRun(`export --format json --output "${outputFile}"`, tempDir);
  if (result.exitCode !== 0) throw new Error(`export failed: ${result.stderr}`);
  const snapshot = JSON.parse(
    execSync(`cat "${outputFile}"`, { encoding: "utf-8" }),
  ) as SnapshotJson;
  return { exportDir, snapshot };
}

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

beforeEach(async () => {
  await setupFolderProject();
});

afterEach(async () => {
  if (tempDir) await cleanupTempDir(tempDir);
});

describe.runIf(canRunInit)("static export — task resources", () => {
  // AC: @static-export-resource-assets-complete ac-static-task-plan-owned-asset-uses-recorded-hash
  it("copies a plan-owned task resource to disk with bytes matching the recorded hash and rewrites the description", async () => {
    const { planRef } = await buildPlanWithResource({
      planSlug: "plan-owned-export",
      moduleSlug: "po-mod",
      taskSlug: "implement-plan-owned",
      resourceId: "shot",
      resourcePath: "shot.png",
      sourceContents: "PLAN_OWNED_PNG_BYTES",
    });
    expect(kspecRun(`plan derive ${planRef} --module @po-mod`, tempDir).exitCode).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-plan-owned", tempDir);
    expect(task.resource_refs?.[0].owner_type).toBe("plan");

    // Author a description that references the resource the task carries.
    kspecOk(
      `task set @implement-plan-owned --description 'See screenshot: ![shot](./resources/shot.png)'`,
      tempDir,
    );

    const { exportDir, snapshot } = runExport();
    const exported = snapshot.tasks.find((t) => t._ulid === task._ulid)!;
    expect(exported).toBeDefined();

    // Drift status projection exposes the resolved resource as present.
    const resource = exported.resolved_resources!.find((r) => r.path === "shot.png")!;
    expect(resource.status).toBe("present");
    const expectedPath = `assets/resources/task/${task._ulid}/shot.png`;
    expect(resource.exported_path).toBe(expectedPath);

    // The description markdown is rewritten to the exported asset path.
    expect(exported.description).toContain(`![shot](${expectedPath})`);
    expect(exported.description).not.toContain("./resources/shot.png");

    // The asset exists on disk and its bytes match the task's recorded hash.
    const onDisk = await fs.readFile(path.join(exportDir, expectedPath));
    expect(existsSync(path.join(exportDir, expectedPath))).toBe(true);
    expect(sha256Of(onDisk)).toBe(resource.recorded_sha256);
  });

  // AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
  it("copies a materialized task-owned resource to disk and rewrites the description", async () => {
    const { planRef, planUlid } = await buildPlanWithResource({
      planSlug: "mat-export",
      moduleSlug: "mat-mod",
      taskSlug: "implement-materialized",
      resourceId: "shot",
      resourcePath: "shot.png",
      sourceContents: "MATERIALIZED_PNG_BYTES",
    });
    expect(
      kspecRun(`plan derive ${planRef} --module @mat-mod --materialize-resources`, tempDir)
        .exitCode,
    ).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-materialized", tempDir);
    const ref = task.resource_refs![0];
    expect(ref.owner_type).toBe("task");
    // Materialized path is `plan/<plan-ulid>/shot.png`.
    expect(ref.path).toBe(path.posix.join("plan", planUlid, "shot.png"));

    kspecOk(
      `task set @implement-materialized --description 'Materialized: ![shot](./resources/${ref.path})'`,
      tempDir,
    );

    const { exportDir, snapshot } = runExport();
    const exported = snapshot.tasks.find((t) => t._ulid === task._ulid)!;
    const resource = exported.resolved_resources!.find((r) => r.path === ref.path)!;
    expect(resource.owner_type).toBe("task");
    expect(resource.status).toBe("present");
    const expectedPath = `assets/resources/task/${task._ulid}/${ref.path}`;
    expect(resource.exported_path).toBe(expectedPath);

    expect(exported.description).toContain(`![shot](${expectedPath})`);
    expect(exported.description).not.toContain(`./resources/${ref.path}`);

    // The asset exists on disk and matches the task-owned manifest hash.
    const onDisk = await fs.readFile(path.join(exportDir, expectedPath));
    expect(existsSync(path.join(exportDir, expectedPath))).toBe(true);
    expect(sha256Of(onDisk)).toBe(resource.recorded_sha256);
    expect(resource.current_sha256).toBe(resource.recorded_sha256);
  });

  // AC: @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
  it("surfaces drift status without rewriting the description or advertising an asset path", async () => {
    const { planRef } = await buildPlanWithResource({
      planSlug: "drift-export",
      moduleSlug: "drift-mod",
      taskSlug: "implement-drift",
      resourceId: "shot",
      resourcePath: "shot.png",
      sourceContents: "ORIGINAL_BYTES",
    });
    expect(kspecRun(`plan derive ${planRef} --module @drift-mod`, tempDir).exitCode).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-drift", tempDir);
    const recordedSha = task.resource_refs![0].sha256;

    kspecOk(
      `task set @implement-drift --description 'Drifted: ![shot](./resources/shot.png)'`,
      tempDir,
    );

    // Change the plan resource bytes so the task's recorded hash no longer
    // matches the owning plan's current resource hash.
    const newSource = path.join(tempDir, "drifted-source.bin");
    await fs.writeFile(newSource, "REPLACEMENT_BYTES_DIFFERENT", "utf-8");
    kspecOk(
      `plan resource add ${planRef} "${newSource}" --id shot --path shot.png --replace`,
      tempDir,
    );

    const { exportDir, snapshot } = runExport();
    const exported = snapshot.tasks.find((t) => t._ulid === task._ulid)!;
    const resource = exported.resolved_resources!.find((r) => r.path === "shot.png")!;

    // Drift is visible, recorded hash preserved, no asset path advertised.
    expect(resource.status).toBe("drift");
    expect(resource.recorded_sha256).toBe(recordedSha);
    expect(resource.current_sha256).not.toBe(recordedSha);
    expect(resource.exported_path).toBeUndefined();

    // The description target stays raw — not rewritten to replacement bytes.
    expect(exported.description).toContain("./resources/shot.png");

    // No asset is advertised, so no task asset for the drifted path on disk.
    const driftedAsset = path.join(
      exportDir,
      "assets",
      "resources",
      "task",
      task._ulid,
      "shot.png",
    );
    expect(existsSync(driftedAsset)).toBe(false);
  });

  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  // AC: @static-export-resource-assets-complete ac-static-task-materialized-asset-exists
  it("rejects the export with a TaskResourceExportError when a task resource escapes via a symlinked subdir", async () => {
    const { planRef, planUlid } = await buildPlanWithResource({
      planSlug: "sym-export",
      moduleSlug: "sym-mod",
      taskSlug: "implement-sym",
      resourceId: "shot",
      resourcePath: "shot.png",
      sourceContents: "SYMLINK_BYTES",
    });
    expect(
      kspecRun(`plan derive ${planRef} --module @sym-mod --materialize-resources`, tempDir)
        .exitCode,
    ).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-sym", tempDir);

    // Replace the materialized task resource's `plan/<ulid>` subdir with a
    // symlink that points outside the task tree. The manifest still declares
    // the path, but the symlink-safe copier must reject the copy.
    const taskResourcesDir = path.join(tempDir, ".kspec", "tasks", task._ulid, "resources");
    const planSubdir = path.join(taskResourcesDir, "plan");
    const outside = path.join(tempDir, "outside-task-res");
    await fs.mkdir(path.join(outside, planUlid), { recursive: true });
    await fs.rename(
      path.join(planSubdir, planUlid, "shot.png"),
      path.join(outside, planUlid, "shot.png"),
    );
    await fs.rm(planSubdir, { recursive: true, force: true });
    const fsSync = await import("node:fs");
    fsSync.symlinkSync(outside, planSubdir);

    const outputFile = path.join(tempDir, "build", "snapshot.json");
    execSync(`mkdir -p "${path.dirname(outputFile)}"`, { stdio: "pipe" });
    const result = kspecRun(`export --format json --output "${outputFile}"`, tempDir);
    // The export command surfaces the failure as a non-zero exit; the asset is
    // never written.
    expect(result.exitCode).not.toBe(0);
    const asset = path.join(
      tempDir,
      "build",
      "assets",
      "resources",
      "task",
      task._ulid,
      "plan",
      planUlid,
      "shot.png",
    );
    expect(existsSync(asset)).toBe(false);
  });

  // AC: @static-export-resource-assets-complete ac-static-task-drift-is-visible-not-rewritten
  it("surfaces missing status when the owning plan resource is removed", async () => {
    const { planRef } = await buildPlanWithResource({
      planSlug: "missing-export",
      moduleSlug: "missing-mod",
      taskSlug: "implement-missing",
      resourceId: "shot",
      resourcePath: "shot.png",
      sourceContents: "WILL_BE_REMOVED",
    });
    expect(kspecRun(`plan derive ${planRef} --module @missing-mod`, tempDir).exitCode).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-missing", tempDir);
    kspecOk(
      `task set @implement-missing --description 'Missing: ![shot](./resources/shot.png)'`,
      tempDir,
    );

    // Remove the plan resource entirely so the reference can no longer resolve.
    kspecOk(`plan resource remove ${planRef} shot --force`, tempDir);

    const { exportDir, snapshot } = runExport();
    const exported = snapshot.tasks.find((t) => t._ulid === task._ulid)!;
    const resource = exported.resolved_resources!.find((r) => r.path === "shot.png")!;

    expect(resource.status).toBe("missing");
    expect(resource.exported_path).toBeUndefined();
    expect(exported.description).toContain("./resources/shot.png");
    const asset = path.join(exportDir, "assets", "resources", "task", task._ulid, "shot.png");
    expect(existsSync(asset)).toBe(false);
  });
});
