import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kspec } from "./helpers/cli.js";

const cleanupDirs: string[] = [];

async function setupWorktreeProject(): Promise<{
  mainDir: string;
  codeWorktreeDir: string;
}> {
  const { createTempDir, initGitRepo } = await import("./helpers/cli.js");

  const mainDir = await createTempDir("kspec-cli-worktree-main-");
  cleanupDirs.push(mainDir);
  initGitRepo(mainDir);
  execSync('git commit --allow-empty -m "init"', { cwd: mainDir, stdio: "pipe" });

  const shadowDir = path.join(mainDir, ".kspec");
  execSync(`git worktree add "${shadowDir}" -b kspec-meta`, {
    cwd: mainDir,
    stdio: "pipe",
  });

  await fs.mkdir(path.join(shadowDir, "modules"), { recursive: true });
  await fs.writeFile(
    path.join(shadowDir, "kynetic.yaml"),
    'kynetic: "1"\ntitle: Worktree CLI Test\n',
    "utf-8",
  );
  await fs.writeFile(path.join(mainDir, "README.md"), "# main repo\n", "utf-8");
  execSync("git add README.md && git commit -m \"add readme\"", {
    cwd: mainDir,
    stdio: "pipe",
  });

  const worktreeBase = await createTempDir("kspec-cli-worktree-code-base-");
  cleanupDirs.push(worktreeBase);
  const codeWorktreeDir = path.join(worktreeBase, "code-wt");
  execSync(`git worktree add "${codeWorktreeDir}" -b feature/worktree-cli`, {
    cwd: mainDir,
    stdio: "pipe",
  });

  return { mainDir, codeWorktreeDir };
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      const { cleanupTempDir } = await import("./helpers/cli.js");
      await cleanupTempDir(dir);
    }
  }
});

describe("worktree-aware CLI command defaults", () => {
  // AC: @worktree-support ac-shadow-commands
  it("resolves shadow commands against the main repo root when run from a linked worktree", async () => {
    const { mainDir, codeWorktreeDir } = await setupWorktreeProject();

    const result = kspec("shadow status", codeWorktreeDir);

    expect(result.stdout).toContain(`Project root: ${mainDir}`);
    expect(result.stdout).toContain("Shadow branch is healthy");
  });

  // AC: @worktree-support ac-serve-default
  it("defaults serve commands to the main repo .kspec directory from a linked worktree", async () => {
    const { mainDir, codeWorktreeDir } = await setupWorktreeProject();
    const originalCwd = process.cwd();

    try {
      process.chdir(codeWorktreeDir);
      const { resolveDefaultKspecDir } = await import("../src/cli/commands/serve.js");

      await expect(resolveDefaultKspecDir()).resolves.toBe(path.join(mainDir, ".kspec"));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
