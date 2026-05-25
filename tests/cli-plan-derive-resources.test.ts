/**
 * CLI tests for `kspec plan derive` with resource_refs and the
 * `--materialize-resources` flag, plus task-detail drift visibility.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
 * AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
 * AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
 * AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
 */

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
} from "./helpers/cli";

const projectCli = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunInit = existsSync(projectCli);

async function setupFolderProject(projectDir: string): Promise<void> {
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: projectDir,
    stdio: "pipe",
  });
  const result = kspecRun("init --no-prompt", projectDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }
}

async function buildPlanWithResource(
  tempDir: string,
  options: {
    planSlug: string;
    sourceFileContents: string;
    resourceId: string;
    resourcePath: string;
    additionalTasks: string;
    moduleSlug?: string;
  },
): Promise<{ planRef: string; planUlid: string }> {
  // Add a module first so derive has somewhere to attach specs (none are
  // created in these tests, but the module helps derive's manual-task path
  // succeed even when later specs are added).
  if (options.moduleSlug) {
    const moduleResult = kspecRun(
      `module add --title "${options.moduleSlug}" --slug ${options.moduleSlug}`,
      tempDir,
    );
    if (moduleResult.exitCode !== 0) throw new Error(`module add failed: ${moduleResult.stderr}`);
  }

  const add = kspecRun(
    `plan add --title "${options.planSlug}" --slug ${options.planSlug} --content "stub"`,
    tempDir,
  );
  if (add.exitCode !== 0) throw new Error(`plan add failed: ${add.stderr}`);
  const planRef = `@${options.planSlug}`;

  const sourceFile = path.join(tempDir, "source.bin");
  await fs.writeFile(sourceFile, options.sourceFileContents, "utf-8");
  const attach = kspecRun(
    `plan resource add ${planRef} "${sourceFile}" --id ${options.resourceId} --path ${options.resourcePath}`,
    tempDir,
  );
  if (attach.exitCode !== 0) throw new Error(`attach failed: ${attach.stderr}`);

  const planMd = `# ${options.planSlug}

## Tasks

\`\`\`yaml
${options.additionalTasks}
\`\`\`
`;
  const planMdPath = path.join(tempDir, `${options.planSlug}-content.md`);
  await fs.writeFile(planMdPath, planMd, "utf-8");
  const setResult = kspecRun(
    `plan set ${planRef} --content-file "${planMdPath}"`,
    tempDir,
  );
  if (setResult.exitCode !== 0) throw new Error(`plan set failed: ${setResult.stderr}`);

  const approve = kspecRun(`plan set ${planRef} --status approved`, tempDir);
  if (approve.exitCode !== 0) throw new Error(`plan approve failed: ${approve.stderr}`);

  const plan = kspecJson<{ _ulid: string }>(`plan get ${planRef}`, tempDir);
  return { planRef, planUlid: plan._ulid };
}

interface TaskResourceRefJson {
  owner_type: "plan" | "task";
  owner_ref: string;
  id: string;
  path: string;
  sha256: string;
  git_commit: string | null;
  git_path: string | null;
  recorded_at: string;
}

interface ResolvedResourceJson {
  owner_type: "plan" | "task";
  owner_ref: string;
  id: string;
  path: string;
  status: "present" | "drift" | "missing" | "unresolved";
  recorded_sha256: string;
  current_sha256: string | null;
  message: string;
}

interface TaskJson {
  _ulid: string;
  slugs: string[];
  resource_refs?: TaskResourceRefJson[];
  resolved_resources?: ResolvedResourceJson[];
}

describe.runIf(canRunInit)("Integration: plan derive resource_refs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupFolderProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  // AC: @plan-resource-derivation-semantics-1 ac-derived-task-keeps-plan-resource-reference
  // AC: @plan-resource-derivation-semantics-1 ac-derived-task-records-resource-version
  it("records plan-owned resource references on derived tasks by default", async () => {
    const { planRef, planUlid } = await buildPlanWithResource(tempDir, {
      planSlug: "default-plan",
      sourceFileContents: "PNG_BYTES",
      resourceId: "shot",
      resourcePath: "shot.png",
      moduleSlug: "default-mod",
      additionalTasks: `- title: Implement shot view
  slug: implement-shot-view
  resource_refs:
    - ./resources/shot.png`,
    });

    const derive = kspecRun(`plan derive ${planRef} --module @default-mod`, tempDir);
    expect(derive.exitCode).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-shot-view", tempDir);
    expect(task.resource_refs).toHaveLength(1);
    const ref = task.resource_refs![0];
    expect(ref.owner_type).toBe("plan");
    expect(ref.owner_ref).toBe(planRef);
    expect(ref.id).toBe("shot");
    expect(ref.path).toBe("shot.png");
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Default mode must NOT copy bytes into the task directory.
    const taskResourcesDir = path.join(tempDir, ".kspec", "tasks", task._ulid, "resources");
    expect(existsSync(taskResourcesDir)).toBe(false);
    void planUlid;
  });

  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("rejects derive when a task declares an unresolved resource_ref", async () => {
    await buildPlanWithResource(tempDir, {
      planSlug: "unresolved-plan",
      sourceFileContents: "X",
      resourceId: "shot",
      resourcePath: "shot.png",
      moduleSlug: "unresolved-mod",
      additionalTasks: `- title: Implement Missing
  slug: implement-missing
  resource_refs:
    - ./resources/never-attached.png`,
    });

    const derive = kspecRun(
      `plan derive @unresolved-plan --module @unresolved-mod --json`,
      tempDir,
      { expectFail: true },
    );
    expect(derive.exitCode).toBe(2);
    expect(derive.stderr).toContain("not declared on the plan");
  });

  // AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
  it("--materialize-resources copies plan resource bytes into the derived task directory and rewrites the ref", async () => {
    const { planRef, planUlid } = await buildPlanWithResource(tempDir, {
      planSlug: "materialize-plan",
      sourceFileContents: "PNG_BYTES",
      resourceId: "shot",
      resourcePath: "shot.png",
      moduleSlug: "materialize-mod",
      additionalTasks: `- title: Implement shot view
  slug: implement-shot-view-mat
  resource_refs:
    - ./resources/shot.png`,
    });

    const derive = kspecRun(
      `plan derive ${planRef} --module @materialize-mod --materialize-resources`,
      tempDir,
    );
    expect(derive.exitCode).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-shot-view-mat", tempDir);
    expect(task.resource_refs).toHaveLength(1);
    const ref = task.resource_refs![0];
    expect(ref.owner_type).toBe("task");
    // Materialized id is prefixed with "plan-" per
    // ac-explicit-copy-mode-creates-task-owned-resource.
    expect(ref.id).toBe("plan-shot");
    expect(ref.path).toBe(path.posix.join("plan", planUlid, "shot.png"));

    const materialized = path.join(
      tempDir,
      ".kspec",
      "tasks",
      task._ulid,
      "resources",
      "plan",
      planUlid,
      "shot.png",
    );
    expect(existsSync(materialized)).toBe(true);
  });
});

describe.runIf(canRunInit)("Integration: task get drift visibility", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    await setupFolderProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
  it("task get JSON marks the resource present when the plan resource has not changed", async () => {
    const { planRef } = await buildPlanWithResource(tempDir, {
      planSlug: "no-drift-plan",
      sourceFileContents: "ONE",
      resourceId: "doc",
      resourcePath: "doc.txt",
      moduleSlug: "no-drift-mod",
      additionalTasks: `- title: Implement Doc
  slug: implement-doc-no-drift
  resource_refs:
    - ./resources/doc.txt`,
    });
    kspecRun(`plan derive ${planRef} --module @no-drift-mod`, tempDir);

    const task = kspecJson<TaskJson>("task get @implement-doc-no-drift", tempDir);
    expect(task.resolved_resources).toHaveLength(1);
    expect(task.resolved_resources![0].status).toBe("present");
    expect(task.resolved_resources![0].current_sha256).toBe(
      task.resolved_resources![0].recorded_sha256,
    );
  });

  // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
  it("task get JSON marks the resource drifted after the plan resource bytes change", async () => {
    const { planRef } = await buildPlanWithResource(tempDir, {
      planSlug: "drift-plan",
      sourceFileContents: "ORIGINAL",
      resourceId: "doc",
      resourcePath: "doc.txt",
      moduleSlug: "drift-mod",
      additionalTasks: `- title: Implement Doc
  slug: implement-doc-drift
  resource_refs:
    - ./resources/doc.txt`,
    });
    kspecRun(`plan derive ${planRef} --module @drift-mod`, tempDir);

    // Replace the plan resource bytes — drift should now be visible.
    const replacementFile = path.join(tempDir, "replacement.txt");
    await fs.writeFile(replacementFile, "UPDATED_VALUE", "utf-8");
    const replace = kspecRun(
      `plan resource add ${planRef} "${replacementFile}" --id doc --path doc.txt --replace`,
      tempDir,
    );
    expect(replace.exitCode).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-doc-drift", tempDir);
    expect(task.resolved_resources).toHaveLength(1);
    expect(task.resolved_resources![0].status).toBe("drift");
    expect(task.resolved_resources![0].current_sha256).not.toBe(
      task.resolved_resources![0].recorded_sha256,
    );

    // Text mode should also show the DRIFT label.
    const textResult = kspecRun("task get @implement-doc-drift", tempDir);
    expect(textResult.exitCode).toBe(0);
    expect(textResult.stdout).toContain("DRIFT");
  });

  // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
  it("task get JSON marks the resource missing after it is removed from the plan", async () => {
    const { planRef } = await buildPlanWithResource(tempDir, {
      planSlug: "removed-plan",
      sourceFileContents: "ORIGINAL",
      resourceId: "doc",
      resourcePath: "doc.txt",
      moduleSlug: "removed-mod",
      additionalTasks: `- title: Implement Doc
  slug: implement-doc-removed
  resource_refs:
    - ./resources/doc.txt`,
    });
    kspecRun(`plan derive ${planRef} --module @removed-mod`, tempDir);

    const remove = kspecRun(`plan resource remove ${planRef} doc --force`, tempDir);
    expect(remove.exitCode).toBe(0);

    const task = kspecJson<TaskJson>("task get @implement-doc-removed", tempDir);
    expect(task.resolved_resources).toHaveLength(1);
    expect(task.resolved_resources![0].status).toBe("missing");
  });
});
