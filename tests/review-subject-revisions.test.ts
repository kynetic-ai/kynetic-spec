import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";
import { initContext } from "../src/parser/yaml.js";
import { getCurrentShadowCommit } from "../src/parser/plan-revisions.js";
import { createReviewRecord, saveReviewRecord } from "../src/parser/reviews.js";
import { computeContentHash } from "../src/parser/skill-render.js";
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

function subjectRefreshEvent() {
  return {
    _ulid: ulid(),
    event_type: "subject_refreshed" as const,
    actor: "@test",
    timestamp: new Date().toISOString(),
    payload: {},
  };
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
    "reports the bound plan revision ordinal instead of the refresh-derived ordinal",
    async () => {
      const projectDir = await setupShadowProject();
      tempDirs.push(projectDir);
      const ctx = await initContext(projectDir, { syncMode: "skip" });

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
      const secondRevision = plan.revisions[1];
      await saveReviewRecord(
        ctx,
        createReviewRecord({
          title: "Plan Binding Review",
          slugs: ["plan-binding-review"],
          subject: {
            type: "plan",
            ref: "@revision-plan",
            shadow_commit: secondRevision.shadow_commit,
            content_hash: computeContentHash("# Revision Plan\n\nUpdated body\n"),
          },
          author: "@test",
          events: [subjectRefreshEvent(), subjectRefreshEvent()],
        }),
      );

      // AC: @subject-revision-vocabulary ac-plan-subject-ordinal
      // AC: @plan-revisions ac-review-revision-binding
      const review = kspecJson<{ subject_revision: number }>(
        "review get @plan-binding-review",
        projectDir,
      );
      expect(review.subject_revision).toBe(2);
    },
  );

  it.runIf(canRunShadowTests)(
    "reports no plan revision for unpublished draft content",
    async () => {
      const projectDir = await setupShadowProject();
      tempDirs.push(projectDir);
      const ctx = await initContext(projectDir, { syncMode: "skip" });

      kspecOutput(
        'plan add --title "Revision Plan" --content "Initial body" --slug revision-plan',
        projectDir,
      );
      kspecOutput('plan publish @revision-plan --note "Initial publication"', projectDir);

      const draftPath = path.join(projectDir, "revision-plan-draft.md");
      await fs.writeFile(draftPath, "Unpublished draft body", "utf-8");
      kspecOutput(`plan set @revision-plan --content-file "${draftPath}"`, projectDir);

      await saveReviewRecord(
        ctx,
        createReviewRecord({
          title: "Draft Plan Review",
          slugs: ["draft-plan-review"],
          subject: {
            type: "plan",
            ref: "@revision-plan",
            shadow_commit: getCurrentShadowCommit(ctx),
            content_hash: computeContentHash("Unpublished draft body"),
          },
          author: "@test",
        }),
      );

      // AC: @plan-revisions ac-review-revision-binding
      const review = kspecJson<{ subject_revision: number | null }>(
        "review get @draft-plan-review",
        projectDir,
      );
      expect(review.subject_revision).toBeNull();
    },
  );
});
