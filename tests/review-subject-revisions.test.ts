import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedPlan } from "../src/parser/plans.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  CLI_PATH,
  kspec as kspecRun,
  kspecJson,
  kspecOutput,
} from "./helpers/cli.js";

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

async function setupShadowProject(): Promise<string> {
  const projectDir = await createTempDir("kspec-review-subject-revisions-");
  initGitRepo(projectDir);
  await fs.writeFile(path.join(projectDir, "README.md"), "# Test\n", "utf-8");
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

describe("Review subject revisions", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await cleanupTempDir(dir);
    }
  });

  // AC: @subject-revision-vocabulary ac-non-plan-derivation
  it("reports non-plan subject revisions from the subject refresh event sequence", async () => {
    const projectDir = await setupShadowProject();
    tempDirs.push(projectDir);

    kspecOutput("review add --title 'Code Rev' --base a1 --head b1 --slug code-rev", projectDir);
    kspecOutput("review refresh @code-rev --head c1", projectDir);
    kspecOutput("review refresh @code-rev --head d1", projectDir);

    const review = kspecJson<{ subject_revision: number }>("review get @code-rev", projectDir);
    expect(review.subject_revision).toBe(3);

    const text = kspecOutput("review get @code-rev", projectDir);
    expect(text).toContain("Subject Rev:  3");
  });

  it.runIf(canRunShadowTests)(
    "binds CLI-created plan reviews to the matching published plan revision",
    async () => {
      const projectDir = await setupShadowProject();
      tempDirs.push(projectDir);

      kspecOutput(
        'plan add --title "Revision Plan" --content "Initial body" --slug revision-plan',
        projectDir,
      );
      kspecOutput('plan publish @revision-plan --note "Initial publication"', projectDir);

      const editPath = path.join(projectDir, "revision-plan-edit.md");
      await fs.writeFile(editPath, "# Revision Plan\n\nUpdated body\n", "utf-8");
      kspecOutput(
        `plan import "${editPath}" --into @revision-plan --reason "Second publication"`,
        projectDir,
      );

      const plan = kspecJson<
        LoadedPlan & { revisions: Array<{ ordinal: number; shadow_commit: string }> }
      >("plan get @revision-plan", projectDir);
      expect(plan.revisions).toHaveLength(2);

      kspecOutput(
        'review add --title "Plan Binding Review" --subject-type plan --subject-ref @revision-plan --slug plan-binding-review',
        projectDir,
      );

      // AC: @review-subject-bindings ac-4
      // AC: @subject-revision-vocabulary ac-plan-subject-ordinal
      // AC: @plan-revisions ac-review-revision-binding
      const review = kspecJson<{
        subject: { type: "plan"; shadow_commit: string; content_hash: string };
        subject_revision: number;
      }>("review get @plan-binding-review", projectDir);
      expect(review.subject.shadow_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(review.subject.content_hash).toHaveLength(64);
      expect(review.subject_revision).toBe(2);
    },
  );

  it.runIf(canRunShadowTests)(
    "binds CLI-created plan reviews for unpublished draft content without a revision",
    async () => {
      const projectDir = await setupShadowProject();
      tempDirs.push(projectDir);

      kspecOutput(
        'plan add --title "Revision Plan" --content "Initial body" --slug revision-plan',
        projectDir,
      );
      kspecOutput('plan publish @revision-plan --note "Initial publication"', projectDir);

      const draftPath = path.join(projectDir, "revision-plan-draft.md");
      await fs.writeFile(draftPath, "Unpublished draft body", "utf-8");
      kspecOutput(`plan set @revision-plan --content-file "${draftPath}"`, projectDir);

      kspecOutput(
        'review add --title "Draft Plan Review" --subject-type plan --subject-ref @revision-plan --slug draft-plan-review',
        projectDir,
      );

      // AC: @review-subject-bindings ac-4
      // AC: @plan-revisions ac-review-revision-binding
      const review = kspecJson<{
        subject: { type: "plan"; shadow_commit: string; content_hash: string };
        subject_revision: number | null;
      }>("review get @draft-plan-review", projectDir);
      expect(review.subject.shadow_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(review.subject.content_hash).toHaveLength(64);
      expect(review.subject_revision).toBeNull();
    },
  );
});
