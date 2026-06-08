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
  const setResult = kspecRun(`plan set ${planRef} --content-file "${planMdPath}"`, tempDir);
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
  content_type: string | null;
  byte_size: number | null;
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

    // The materialized task-owned reference must be resolvable. Before the
    // fix to task-resource-resolver, the resolver only accepted owner_ref
    // matching task._ulid, but `materializePlanResourcesForTask` records
    // owner_ref as the task's canonical ref (slug-first), so the resolver
    // returned `unresolved` for the very task that owned the copy.
    expect(task.resolved_resources).toHaveLength(1);
    expect(task.resolved_resources![0].status).toBe("present");
    expect(task.resolved_resources![0].current_sha256).toBe(
      task.resolved_resources![0].recorded_sha256,
    );
    // The projection reports owner-manifest content type and byte size from
    // the current entry so the shared shape carries enough to render bytes.
    expect(task.resolved_resources![0].byte_size).toBeGreaterThan(0);
    expect(typeof task.resolved_resources![0].content_type).toBe("string");
  });

  // Regression — review @01KSF2EN9KP6B0BNZQMBQMDX1Q blocker on
  // src/parser/task-resource-resolver.ts:149. Materialized task-owned
  // resources are recorded with `owner_ref = canonicalRef(task)` which is
  // the task's first slug, but the resolver only accepted owner_ref equal
  // to `task._ulid`, so `task get` reported every materialized resource as
  // `unresolved`. This test asserts text-mode `task get` shows OK (not
  // UNRESOLVED) for a materialized task-owned resource — exercising the
  // formatted detail path the reviewer reproduced from.
  // AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
  // AC: @plan-resource-derivation-semantics-1 ac-resource-drift-is-visible
  it("task get resolves a materialized task-owned resource as present, not unresolved", async () => {
    const { planRef } = await buildPlanWithResource(tempDir, {
      planSlug: "matresolve-plan",
      sourceFileContents: "PNG_BYTES",
      resourceId: "shot",
      resourcePath: "shot.png",
      moduleSlug: "matresolve-mod",
      additionalTasks: `- title: Implement shot view
  slug: implement-shot-view-matresolve
  resource_refs:
    - ./resources/shot.png`,
    });
    const derive = kspecRun(
      `plan derive ${planRef} --module @matresolve-mod --materialize-resources`,
      tempDir,
    );
    expect(derive.exitCode).toBe(0);

    // The canonical ref recorded by derive is the task slug, not the ULID.
    const task = kspecJson<TaskJson>("task get @implement-shot-view-matresolve", tempDir);
    const ref = task.resource_refs![0];
    expect(ref.owner_type).toBe("task");
    expect(ref.owner_ref).toBe("@implement-shot-view-matresolve");
    expect(task.resolved_resources![0].status).toBe("present");

    // Text mode must not show the UNRESOLVED label for a freshly
    // materialized resource — that was the consumer-visible breakage.
    const textResult = kspecRun("task get @implement-shot-view-matresolve", tempDir);
    expect(textResult.exitCode).toBe(0);
    expect(textResult.stdout).not.toContain("UNRESOLVED");
    expect(textResult.stdout).toContain("[OK]");
  });

  // Regression — symlinked plan resource leaf (review @01KSEZSCAYY7HHFE619H6KN1TH
  // blocker on src/cli/commands/plan.ts:552). Before the preflight fix,
  // `fs.copyFile(sourceAbs, destinationAbs)` followed the symlink and
  // materialized bytes from outside the plan tree. The fix verifies the
  // source chain with `assertSafeResourceMutationPath` before any
  // `createTask` runs, so derive must fail fast with usage_error AND leave
  // no derived task on disk.
  // AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("--materialize-resources rejects a symlinked plan resource leaf and creates no task", async () => {
    const { planRef, planUlid } = await buildPlanWithResource(tempDir, {
      planSlug: "matsym-plan",
      sourceFileContents: "INNER",
      resourceId: "doc",
      resourcePath: "doc.bin",
      moduleSlug: "matsym-mod",
      additionalTasks: `- title: Implement Doc
  slug: implement-doc-matsym
  resource_refs:
    - ./resources/doc.bin`,
    });

    // Plant a symlinked plan resource leaf pointing at an outside secret.
    const outsideSecret = path.join(tempDir, "outside-secret.bin");
    await fs.writeFile(outsideSecret, "OUTSIDE_SECRET", "utf-8");
    const planResourceFile = path.join(
      tempDir,
      ".kspec",
      "plans",
      planUlid,
      "resources",
      "doc.bin",
    );
    await fs.rm(planResourceFile);
    await fs.symlink(outsideSecret, planResourceFile);

    const derive = kspecRun(
      `plan derive ${planRef} --module @matsym-mod --materialize-resources`,
      tempDir,
      { expectFail: true },
    );
    expect(derive.exitCode).toBe(2);
    expect(derive.stderr).toContain("symlink");

    // No derived task should have been written to disk.
    const taskLookup = kspecRun("task get @implement-doc-matsym", tempDir, {
      expectFail: true,
    });
    expect(taskLookup.exitCode).not.toBe(0);
  });

  // Regression — symlinked intermediate directory inside the plan resources
  // tree. Even with a non-symlinked leaf, an intermediate `sub/ → /outside`
  // symlink would let materialization pull bytes from outside the plan
  // directory. The preflight walks the chain segment-by-segment with
  // `assertSafeResourceMutationPath`, so this must also reject.
  // AC: @trait-entity-scoped-local-resources-1 ac-path-escape-rejected
  it("--materialize-resources rejects a symlinked intermediate directory in the plan resources tree", async () => {
    // Build the plan with a path inside a sub/ directory so we can replace
    // sub/ with a symlink without touching the leaf.
    const { planRef, planUlid } = await buildPlanWithResource(tempDir, {
      planSlug: "matsymdir-plan",
      sourceFileContents: "INNER",
      resourceId: "doc",
      resourcePath: "sub/doc.bin",
      moduleSlug: "matsymdir-mod",
      additionalTasks: `- title: Implement Doc
  slug: implement-doc-matsymdir
  resource_refs:
    - ./resources/sub/doc.bin`,
    });

    const outsideDir = path.join(tempDir, "outside-sub");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "doc.bin"), "OUTSIDE_SECRET", "utf-8");
    const planSubDir = path.join(tempDir, ".kspec", "plans", planUlid, "resources", "sub");
    await fs.rm(planSubDir, { recursive: true, force: true });
    await fs.symlink(outsideDir, planSubDir);

    const derive = kspecRun(
      `plan derive ${planRef} --module @matsymdir-mod --materialize-resources`,
      tempDir,
      { expectFail: true },
    );
    expect(derive.exitCode).toBe(2);
    expect(derive.stderr).toContain("symlink");

    const taskLookup = kspecRun("task get @implement-doc-matsymdir", tempDir, {
      expectFail: true,
    });
    expect(taskLookup.exitCode).not.toBe(0);
  });

  // Regression — prefixed resource id overflow (review @01KSEZSCAYY7HHFE619H6KN1TH
  // blocker on src/cli/commands/plan.ts:559). A 128-character plan resource
  // id (valid input) yields a 133-character `plan-…` id after prefixing,
  // which `computeResourceMetadata` rejects. Before the preflight fix this
  // failure surfaced AFTER `createTask` already wrote the derived task,
  // leaving partial state behind. The fix pre-validates every
  // materialization id before any task is created.
  // AC: @plan-resource-derivation-semantics-1 ac-explicit-copy-mode-creates-task-owned-resource
  it("--materialize-resources rejects when the prefixed id would exceed the resource id contract and creates no task", async () => {
    const longId = "a".repeat(128);
    const { planRef } = await buildPlanWithResource(tempDir, {
      planSlug: "matlong-plan",
      sourceFileContents: "INNER",
      resourceId: longId,
      resourcePath: "doc.bin",
      moduleSlug: "matlong-mod",
      additionalTasks: `- title: Implement Doc
  slug: implement-doc-matlong
  resource_refs:
    - ./resources/doc.bin`,
    });

    const derive = kspecRun(
      `plan derive ${planRef} --module @matlong-mod --materialize-resources`,
      tempDir,
      { expectFail: true },
    );
    expect(derive.exitCode).toBe(2);
    expect(derive.stderr).toMatch(/cannot be materialized/);

    // No derived task should have been written to disk.
    const taskLookup = kspecRun("task get @implement-doc-matlong", tempDir, {
      expectFail: true,
    });
    expect(taskLookup.exitCode).not.toBe(0);
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
