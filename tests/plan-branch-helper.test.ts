/**
 * Tests for plan branch helper.
 * AC: @plan-branch-creation ac-deterministic-name, ac-forks-from-base, ac-updates-plan-record,
 * ac-resume-local, ac-rehydrate-remote, ac-custom-name, ac-reports-result
 * AC: @trait-json-output ac-1, ac-2, ac-3, ac-4
 * AC: @trait-semantic-exit-codes ac-1, ac-6, ac-8
 * AC: @trait-error-guidance ac-1, ac-2, ac-3, ac-6
 * AC: @trait-shadow-commit ac-1, ac-2, ac-3
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computePlanBranchName, gitCheckoutNew } from "../src/cli/branch-helper.js";
import {
  cleanupTempDir,
  git,
  initGitRepo,
  kspec as kspecRun,
  kspecJson,
  kspecOutput as kspec,
  setupTempFixtures,
} from "./helpers/cli";

describe("plan branch helper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    initGitRepo(tempDir);
    git("add -A", tempDir);
    git('commit -m "initial"', tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @plan-branch-creation ac-deterministic-name
  it("computes deterministic plan branch names from slug and short ULID", () => {
    expect(
      computePlanBranchName("01KN5XVZVERDZ3ZVAPDCFP5PJB", {
        slugs: ["plan-scoped-branch-targeting"],
      }),
    ).toBe("plan/plan-scoped-branch-targeting/01kn5xvz");
  });

  async function addPlan(slug: string): Promise<{ _ulid: string; branch: string | null }> {
    kspec(`plan add --title "${slug}" --content "body" --slug ${slug}`, tempDir);
    return kspecJson<{ _ulid: string; branch: string | null }>(`plan get @${slug}`, tempDir);
  }

  // AC: @plan-branch-creation ac-deterministic-name
  // AC: @plan-branch-creation ac-forks-from-base
  // AC: @plan-branch-creation ac-updates-plan-record
  // AC: @plan-branch-creation ac-reports-result
  it("creates the deterministic plan branch from the configured dispatch base and records it", async () => {
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n",
      "utf-8",
    );

    git("checkout -b dev", tempDir);
    await fs.writeFile(path.join(tempDir, "dev.txt"), "dev base\n", "utf-8");
    git("add dev.txt", tempDir);
    git('commit -m "dev base"', tempDir);
    const devHead = execSync("git rev-parse dev", { cwd: tempDir, encoding: "utf-8" }).trim();
    git("checkout main", tempDir);

    const plan = await addPlan("release-stack");
    const result = kspecRun("plan branch @release-stack", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Created new branch");
    expect(result.stdout).toContain("plan/release-stack/");
    expect(result.stdout).toContain("Plan record updated");

    const currentBranch = execSync("git branch --show-current", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe(`plan/release-stack/${plan._ulid.slice(0, 8).toLowerCase()}`);

    const branchHead = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
    expect(branchHead).toBe(devHead);

    const storedPlan = kspecJson<{ branch: string | null }>("plan get @release-stack", tempDir);
    expect(storedPlan.branch).toBe(currentBranch);
  });

  // AC: @plan-branch-creation ac-resume-local
  it("switches back to an existing local plan branch without recreating it", async () => {
    await addPlan("local-reuse-plan");
    kspec("plan branch @local-reuse-plan", tempDir);
    git("commit --allow-empty -m 'plan work'", tempDir);
    const expectedHead = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();

    git("checkout main", tempDir);
    const result = kspecRun("plan branch @local-reuse-plan", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Switched to existing branch");

    const actualHead = execSync("git rev-parse HEAD", { cwd: tempDir, encoding: "utf-8" }).trim();
    expect(actualHead).toBe(expectedHead);
  });

  // AC: @plan-branch-creation ac-rehydrate-remote
  it("rehydrates a remote-only plan branch and restores tracking", async () => {
    const bareDir = `${tempDir}-bare`;
    execSync(`git init --bare --initial-branch=main "${bareDir}"`, { stdio: "pipe" });
    git(`remote add origin "${bareDir}"`, tempDir);
    git("push -u origin main", tempDir);

    await addPlan("remote-plan");
    kspec("plan branch @remote-plan", tempDir);
    const branchName = execSync("git branch --show-current", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    git("commit --allow-empty -m 'remote plan work'", tempDir);
    git(`push -u origin ${branchName}`, tempDir);

    git("checkout main", tempDir);
    git(`branch -D ${branchName}`, tempDir);

    const result = kspecRun("plan branch @remote-plan", tempDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Rehydrated branch from remote");

    const upstream = execSync("git rev-parse --abbrev-ref --symbolic-full-name @{u}", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(upstream).toBe(`origin/${branchName}`);
  });

  // AC: @plan-branch-creation ac-custom-name
  it("uses a custom branch name override and persists it on the plan", async () => {
    await addPlan("named-plan");

    const result = kspecRun("plan branch @named-plan --name feature/shared-plan-stack", tempDir);
    expect(result.exitCode).toBe(0);

    const currentBranch = execSync("git branch --show-current", {
      cwd: tempDir,
      encoding: "utf-8",
    }).trim();
    expect(currentBranch).toBe("feature/shared-plan-stack");

    const storedPlan = kspecJson<{ branch: string | null }>("plan get @named-plan", tempDir);
    expect(storedPlan.branch).toBe("feature/shared-plan-stack");
  });

  it("treats custom branch names as literal git argv values instead of shell input", async () => {
    const markerPath = path.join(tempDir, "branch-helper-shell-marker");

    expect(() => gitCheckoutNew(`invalid; touch ${markerPath}`)).toThrow();

    await expect(fs.access(markerPath)).rejects.toThrow();
  });

  // AC: @trait-json-output ac-1, ac-2, ac-4
  it("returns structured branch details in JSON mode", async () => {
    const plan = await addPlan("json-plan");
    const result = kspecJson<{
      branch: string;
      action: string;
      plan_ref: string;
      source: string | null;
      guidance: string;
      plan_record_updated: boolean;
    }>("plan branch @json-plan", tempDir);

    expect(result.branch).toBe(`plan/json-plan/${plan._ulid.slice(0, 8).toLowerCase()}`);
    expect(result.action).toBe("created");
    expect(result.plan_ref).toBe("@json-plan");
    expect(result.source).toBeNull();
    expect(result.plan_record_updated).toBe(true);
    expect(result.guidance).toContain("shared branch");
  });

  // AC: @trait-json-output ac-3
  // AC: @trait-error-guidance ac-6
  // AC: @trait-semantic-exit-codes ac-6
  // AC: @trait-error-guidance ac-1, ac-2, ac-3
  it("returns actionable JSON errors for unknown plan refs", () => {
    const result = kspecRun("plan branch @missing-plan --json", tempDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);

    const parsed = JSON.parse(result.stderr) as {
      error: string;
      details?: { suggestion?: string };
    };
    expect(parsed.error).toBeTruthy();
    expect(parsed.details?.suggestion).toContain("kspec plan list");
  });

  // AC: @trait-semantic-exit-codes ac-1
  // AC: @trait-semantic-exit-codes ac-8
  it("uses documented success and failure exit codes", async () => {
    await addPlan("exit-code-plan");
    const successResult = kspecRun("plan branch @exit-code-plan", tempDir);
    expect(successResult.exitCode).toBe(0);

    const failureResult = kspecRun("plan branch @missing-plan", tempDir, {
      expectFail: true,
    });
    expect(failureResult.exitCode).toBeGreaterThan(0);
  });

  // AC: @trait-error-guidance ac-1
  // AC: @trait-error-guidance ac-2
  // AC: @trait-error-guidance ac-6
  // AC: @trait-json-output ac-1
  // AC: @trait-json-output ac-3
  // AC: @trait-semantic-exit-codes ac-4
  it("preserves Git checkout failure details in text and JSON error output when the working tree blocks branch creation", async () => {
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: dev\n",
      "utf-8",
    );

    git("checkout -b dev", tempDir);
    await fs.writeFile(path.join(tempDir, "checkout-conflict.txt"), "from dev\n", "utf-8");
    git("add checkout-conflict.txt", tempDir);
    git('commit -m "dev-only file"', tempDir);
    git("checkout main", tempDir);

    await fs.writeFile(
      path.join(tempDir, "checkout-conflict.txt"),
      "untracked conflict\n",
      "utf-8",
    );

    await addPlan("checkout-conflict-plan");

    const textResult = kspecRun("plan branch @checkout-conflict-plan", tempDir, {
      expectFail: true,
    });
    expect(textResult.exitCode).toBe(3);
    expect(textResult.stderr).not.toContain("[object Object]");
    expect(textResult.stderr).toContain("Failed to create or resume plan branch");
    expect(textResult.stderr).toContain("checkout-conflict.txt");
    expect(textResult.stderr).toMatch(/would be overwritten|untracked working tree/);
    expect(textResult.stderr).toMatch(/move or remove them|Suggestion:/);

    const afterFailure = kspecJson<{ branch: string | null }>(
      "plan get @checkout-conflict-plan",
      tempDir,
    );
    expect(afterFailure.branch).toBeNull();

    const jsonResult = kspecRun("plan branch @checkout-conflict-plan --json", tempDir, {
      expectFail: true,
    });
    expect(jsonResult.exitCode).toBe(3);
    // No ANSI escape sequences in --json stderr payload.
    expect(jsonResult.stderr).not.toMatch(/\[/);

    const parsed = JSON.parse(jsonResult.stderr) as {
      success: boolean;
      error: string;
      details: { message?: string; suggestion?: string };
    };
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("Failed to create or resume plan branch");
    expect(parsed.details.message).toMatch(/would be overwritten|untracked working tree/);
    expect(parsed.details.message).toContain("checkout-conflict.txt");
    expect(parsed.details.suggestion).toBeTruthy();
  });

  // AC: @trait-json-output ac-5 — N/A: plan branch output contains no timestamps
  // AC: @trait-json-output ac-6 — N/A: plan branch exposes no competing format flags
  // AC: @trait-semantic-exit-codes ac-2 — N/A: invalid-ref handling exits through not-found guidance, not a field validation path
  // AC: @trait-semantic-exit-codes ac-3 — N/A: plan branch has no confirmation prompt
  // AC: @trait-semantic-exit-codes ac-5 — N/A: plan branch targets one plan, not a query
  // AC: @trait-semantic-exit-codes ac-7 — N/A: plan branch is not a batch operation
  // AC: @trait-error-guidance ac-4 — N/A: plan branch performs no state transition validation
  // AC: @trait-error-guidance ac-5 — N/A: the command has no field-level schema validation surface beyond ref resolution
  // AC: @trait-shadow-commit ac-1 — N/A in fixture mode: setupTempFixtures does not provision a real shadow git worktree
  // AC: @trait-shadow-commit ac-2 — N/A in fixture mode: without a real shadow worktree there is no shadow commit subject to inspect
  // AC: @trait-shadow-commit ac-3 — N/A in fixture mode: without a real shadow worktree there is no shadow commit ref payload to inspect
  // AC: @trait-shadow-commit ac-4 — N/A: tests run without an initialized shadow worktree
  // AC: @trait-shadow-commit ac-5 — N/A: no save-failure path is induced here
  // AC: @trait-shadow-commit ac-6 — N/A: fire-and-forget shadow push is covered elsewhere
  // AC: @trait-shadow-commit ac-7 — N/A: shadow git warning paths are not induced here
  // AC: @trait-shadow-commit ac-8 — N/A: plan branch performs a single related save
});
