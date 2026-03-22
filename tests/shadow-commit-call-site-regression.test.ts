import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecJson,
} from "./helpers/cli.js";
import { SHADOW_WORKTREE_DIR } from "../src/parser/shadow.js";

const projectCli = path.resolve(__dirname, "..", "dist", "cli", "index.js");
const canRunShadowTests = (() => {
  try {
    const version = execSync("git --version", { encoding: "utf-8" }).trim();
    const match = version.match(/(\d+)\.(\d+)/);
    if (!match) return false;
    const [, major, minor] = match.map(Number);
    return (major > 2 || (major === 2 && minor >= 42)) && existsSync(projectCli);
  } catch {
    return false;
  }
})();

async function setupShadowProject(projectDir: string): Promise<void> {
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "initial"', {
    cwd: projectDir,
    stdio: "pipe",
  });

  const result = kspec("init --no-prompt", projectDir, {
    env: { KSPEC_AUTHOR: "@test" },
  });
  if (result.exitCode !== 0) {
    throw new Error(`kspec init --no-prompt failed: ${result.stderr}`);
  }
}

function getShadowHeadSubject(projectDir: string): string {
  return execSync("git log --format=%s -1", {
    cwd: path.join(projectDir, SHADOW_WORKTREE_DIR),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

async function addTestWorkflow(projectDir: string, workflowId: string): Promise<void> {
  const steps = JSON.stringify([{ type: "action", content: "Execute test step" }]);
  const result = kspec(
    `meta add workflow --id ${workflowId} --trigger manual --steps '${steps}'`,
    projectDir,
  );
  if (result.exitCode !== 0) {
    throw new Error(`meta add workflow failed: ${result.stderr}`);
  }
}

describe("shadow commit call-site regressions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-shadow-call-sites-");
    await setupShadowProject(tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it.skipIf(!canRunShadowTests)(
    "records the created inbox item ref in the shadow commit subject",
    () => {
      // AC: @trait-shadow-commit ac-2
      // AC: @trait-shadow-commit ac-3
      kspec('inbox add "Shadow ref regression"', tempDir);

      const inboxItems = kspecJson<Array<{ _ulid: string; text: string }>>(
        "inbox list",
        tempDir,
      );
      const created = inboxItems.find((item) => item.text === "Shadow ref regression");
      expect(created).toBeDefined();
      expect(getShadowHeadSubject(tempDir)).toBe(
        `Add Inbox Item: @${created!._ulid} - Shadow ref regression`,
      );
    },
  );

  it.skipIf(!canRunShadowTests)(
    "uses workflow run refs for workflow lifecycle shadow commits",
    async () => {
      // AC: @trait-shadow-commit ac-2
      // AC: @trait-shadow-commit ac-3
      await addTestWorkflow(tempDir, "shadow-flow");

      const started = kspecJson<{ run_id: string }>(
        "workflow start @shadow-flow --json",
        tempDir,
      );
      expect(getShadowHeadSubject(tempDir)).toBe(
        `Start Workflow: @${started.run_id}`,
      );

      kspec(`workflow pause @${started.run_id}`, tempDir);
      expect(getShadowHeadSubject(tempDir)).toBe(
        `Pause Workflow: @${started.run_id}`,
      );

      kspec(`workflow resume @${started.run_id}`, tempDir);
      expect(getShadowHeadSubject(tempDir)).toBe(
        `Resume Workflow: @${started.run_id}`,
      );

      const completed = kspecJson<{ run_id: string }>(
        "workflow start @shadow-flow --json",
        tempDir,
      );
      kspec(`workflow complete @${completed.run_id}`, tempDir);
      expect(getShadowHeadSubject(tempDir)).toBe(
        `Complete Workflow: @${completed.run_id}`,
      );

      const advanced = kspecJson<{ run_id: string }>(
        "workflow start @shadow-flow --json",
        tempDir,
      );
      kspec(`workflow next @${advanced.run_id}`, tempDir);
      expect(getShadowHeadSubject(tempDir)).toBe(
        `Advance Workflow: @${advanced.run_id}`,
      );

      const aborted = kspecJson<{ run_id: string }>(
        "workflow start @shadow-flow --json",
        tempDir,
      );
      kspec(`workflow abort @${aborted.run_id}`, tempDir);
      expect(getShadowHeadSubject(tempDir)).toBe(
        `Abort Workflow: @${aborted.run_id}`,
      );
    },
  );

  it.skipIf(!canRunShadowTests)(
    "uses a workflow run ref when pruning a single run",
    async () => {
      // AC: @trait-shadow-commit ac-2
      // AC: @trait-shadow-commit ac-3
      await addTestWorkflow(tempDir, "shadow-prune-flow");

      const pruned = kspecJson<{ run_id: string }>(
        "workflow start @shadow-prune-flow --json",
        tempDir,
      );
      kspec("workflow prune --older-than 0m", tempDir);

      expect(getShadowHeadSubject(tempDir)).toBe(
        `Prune Workflow: @${pruned.run_id} - 1 run(s)`,
      );
    },
  );

  it.skipIf(!canRunShadowTests)(
    "keeps batch task assessment shadow commits detail-only instead of inventing a ref",
    () => {
      // AC: @trait-shadow-commit ac-2
      // AC: @trait-shadow-commit ac-3
      kspec('task add --title "Needs automation review"', tempDir);
      kspec("tasks assess automation --auto", tempDir);

      expect(getShadowHeadSubject(tempDir)).toBe("Assess Tasks: 1 task(s)");
    },
  );
});
