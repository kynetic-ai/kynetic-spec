import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createPlan, loadPlans, savePlan } from "../src/parser/plans.js";
import { resolvePlanRevisionContent } from "../src/parser/plan-revisions.js";
import {
  getPlanCoreFilePath,
  getPlanDocumentFilePath,
  getPlanIndexFilePath,
} from "../src/parser/plan-storage-manager.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  CLI_PATH,
  kspec as kspecRun,
  kspecJson,
  kspecOutput,
  readTestOutput,
} from "./helpers/cli.js";
import { SHADOW_WORKTREE_DIR } from "../src/parser/shadow.js";

const canRunShadowTests = (() => {
  try {
    const version = execSync("git --version", { encoding: "utf-8" }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    return (major > 2 || (major === 2 && minor >= 42)) && existsSync(CLI_PATH);
  } catch {
    return false;
  }
})();

interface TestCtx {
  specDir: string;
  projectRoot: string;
  manifest: { kynetic: string; plan_storage: { format: "folder" } };
  shadow: {
    enabled: boolean;
    worktreeDir: string;
    branchName: string;
    projectRoot: string;
  };
}

async function setupShadowFolderProject(): Promise<string> {
  const projectDir = await createTempDir("kspec-plan-revisions-");
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
  return projectDir;
}

function makeCtx(projectDir: string): TestCtx {
  return {
    specDir: path.join(projectDir, SHADOW_WORKTREE_DIR),
    projectRoot: projectDir,
    manifest: { kynetic: "1.2", plan_storage: { format: "folder" } },
    shadow: {
      enabled: true,
      worktreeDir: path.join(projectDir, SHADOW_WORKTREE_DIR),
      branchName: "kspec-meta",
      projectRoot: projectDir,
    },
  };
}

describe("Plan revisions", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await cleanupTempDir(dir);
    }
    tempDirs = [];
  });

  // AC: @plan-revisions ac-legacy-plans-load
  // AC: @plan-revisions ac-created-plans-start-empty
  it("loads folder-backed plans without revision fields as an empty revision history", async () => {
    const projectDir = await createTempDir("kspec-plan-revisions-folder-");
    tempDirs.push(projectDir);
    const specDir = path.join(projectDir, ".kspec");
    await fs.mkdir(specDir, { recursive: true });
    const ctx = {
      specDir,
      manifest: { kynetic: "1.2", plan_storage: { format: "folder" } },
    };

    const plan = createPlan({ title: "Fresh Plan", content: "Draft body" });
    expect(plan.revisions).toEqual([]);
    await savePlan(ctx as never, plan);

    const corePath = getPlanCoreFilePath(ctx as never, plan._ulid);
    const core = yamlParse(await readTestOutput(corePath)) as Record<string, unknown>;
    delete core.revisions;
    await fs.writeFile(corePath, `${JSON.stringify(core, null, 2)}\n`, "utf-8");

    const loaded = await loadPlans(ctx as never);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].revisions).toEqual([]);
  });

  it.runIf(canRunShadowTests)(
    "publishes and re-imports plan revisions with shadow commit pointers",
    async () => {
      const projectDir = await setupShadowFolderProject();
      tempDirs.push(projectDir);
      const ctx = makeCtx(projectDir);

      kspecOutput(
        'plan add --title "Revision Plan" --content "Initial body" --slug revision-plan',
        projectDir,
      );

      const created = kspecJson<{ _ulid: string; revisions: unknown[] }>(
        "plan get @revision-plan",
        projectDir,
      );
      expect(created.revisions).toEqual([]);

      // AC: @plan-revisions ac-publish-mints-revision
      // AC: @plan-revisions ac-revision-ordering
      kspecOutput('plan publish @revision-plan --note "Initial publication"', projectDir);
      const first = kspecJson<{
        _ulid: string;
        revisions: Array<{
          ordinal: number;
          author: string;
          note: string;
          created_at: string;
          shadow_commit: string;
        }>;
      }>("plan get @revision-plan", projectDir);

      expect(first.revisions).toHaveLength(1);
      expect(first.revisions[0]).toMatchObject({
        ordinal: 1,
        author: "@test",
        note: "Initial publication",
      });
      expect(first.revisions[0].created_at).toBeTruthy();
      expect(first.revisions[0].shadow_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(resolvePlanRevisionContent(ctx as never, first, first.revisions[0])).toBe(
        "Initial body",
      );

      const editPath = path.join(projectDir, "revision-plan-edit.md");
      await fs.writeFile(editPath, "# Revision Plan\n\nUpdated body\n", "utf-8");

      // AC: @plan-revisions ac-import-mints-revision
      kspecOutput(
        `plan import "${editPath}" --into @revision-plan --reason "Second publication"`,
        projectDir,
      );
      const second = kspecJson<{
        revisions: Array<{ ordinal: number; note: string; shadow_commit: string }>;
      }>("plan get @revision-plan", projectDir);

      expect(second.revisions.map((revision) => revision.ordinal)).toEqual([1, 2]);
      expect(second.revisions[1].note).toBe("Second publication");
      expect(second.revisions[1].shadow_commit).not.toBe(first.revisions[0].shadow_commit);
      expect(resolvePlanRevisionContent(ctx as never, first, second.revisions[1])).toBe(
        "# Revision Plan\n\nUpdated body\n",
      );

      // AC: @plan-revisions ac-no-body-duplication
      const core = yamlParse(
        await readTestOutput(getPlanCoreFilePath(ctx as never, first._ulid)),
      ) as Record<string, unknown>;
      const index = yamlParse(await readTestOutput(getPlanIndexFilePath(ctx as never))) as {
        plans: Array<Record<string, unknown>>;
      };
      expect(core.content).toBeUndefined();
      expect(JSON.stringify(core.revisions)).not.toContain("Updated body");
      expect(index.plans[0].current_revision).toBe(2);
      expect(index.plans[0].revisions).toBeUndefined();
      expect(index.plans[0].content).toBeUndefined();

      const draftPath = path.join(projectDir, "revision-plan-draft.md");
      await fs.writeFile(draftPath, "Unpublished draft body", "utf-8");

      // AC: @plan-revisions ac-draft-edits-do-not-mint
      kspecOutput(`plan set @revision-plan --content-file "${draftPath}"`, projectDir);
      kspecOutput('plan note @revision-plan "Metadata-only note"', projectDir);
      const afterDraft = kspecJson<{ revisions: unknown[] }>("plan get @revision-plan", projectDir);
      expect(afterDraft.revisions).toHaveLength(2);

      const text = kspecOutput("plan get @revision-plan", projectDir);
      expect(text).toContain("Revisions:");
      expect(text).toContain("1. Initial publication");
      expect(text).toContain("2. Second publication");

      expect(await readTestOutput(getPlanDocumentFilePath(ctx as never, first._ulid))).toBe(
        "Unpublished draft body",
      );
      expect(resolvePlanRevisionContent(ctx as never, first, second.revisions[1])).toBe(
        "# Revision Plan\n\nUpdated body\n",
      );
    },
  );

  // AC: @plan-revisions ac-backfill-revision-one — N/A: implemented by dependent @task-plan-revision-backfill.
  // AC: @plan-revisions ac-review-revision-binding — N/A: implemented by dependent @task-review-revision-binding.
});
