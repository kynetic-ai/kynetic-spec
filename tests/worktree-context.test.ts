import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initContext } from "../src/parser/yaml.js";
import { cleanupTempDir, createTempDir, initGitRepo } from "./helpers/cli.js";

const cleanupDirs: string[] = [];

async function setupWorktreeProject(): Promise<{
  mainDir: string;
  codeWorktreeDir: string;
}> {
  const mainDir = await createTempDir("kspec-worktree-context-main-");
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
    'kynetic: "1"\ntitle: Worktree Test\n',
    "utf-8",
  );

  const worktreeBase = await createTempDir("kspec-worktree-context-code-base-");
  cleanupDirs.push(worktreeBase);
  const codeWorktreeDir = path.join(worktreeBase, "code-wt");
  execSync(`git worktree add "${codeWorktreeDir}" -b feature/worktree-context`, {
    cwd: mainDir,
    stdio: "pipe",
  });

  return { mainDir, codeWorktreeDir };
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await cleanupTempDir(dir);
    }
  }
});

describe("initContext with linked worktrees", () => {
  // AC: @worktree-support ac-resolve-roots
  it("uses the worktree root for rootDir and main repo root for projectRoot/specDir", async () => {
    const { mainDir, codeWorktreeDir } = await setupWorktreeProject();

    const ctx = await initContext(codeWorktreeDir);

    expect(ctx.rootDir).toBe(codeWorktreeDir);
    expect(ctx.projectRoot).toBe(mainDir);
    expect(ctx.specDir).toBe(path.join(mainDir, ".kspec"));
    expect(ctx.sessionsDir).toBe(path.join(mainDir, ".kspec-sessions"));
    expect(ctx.shadow?.projectRoot).toBe(mainDir);
  });

  // AC: @worktree-support ac-no-worktree-unchanged
  it("keeps rootDir and projectRoot identical in the main repo", async () => {
    const { mainDir } = await setupWorktreeProject();

    const ctx = await initContext(mainDir);

    expect(ctx.rootDir).toBe(mainDir);
    expect(ctx.projectRoot).toBe(mainDir);
    expect(ctx.specDir).toBe(path.join(mainDir, ".kspec"));
    expect(ctx.sessionsDir).toBe(path.join(mainDir, ".kspec-sessions"));
  });

  // AC: @coverage-scan-config ac-configured-paths
  it("loads config from worktree root, not main repo root", async () => {
    const { mainDir, codeWorktreeDir } = await setupWorktreeProject();

    // Write a config with coverage settings ONLY in the worktree, not in mainDir
    await fs.writeFile(
      path.join(codeWorktreeDir, "kspec.config.yaml"),
      'coverage:\n  scan_paths:\n    - tests/\n  exclude_patterns:\n    - "fixtures/**"\n',
      "utf-8",
    );
    // Main repo has no config — should NOT be loaded
    // (no kspec.config.yaml in mainDir)

    const ctx = await initContext(codeWorktreeDir);

    expect(ctx.config.coverage.scan_paths).toEqual(["tests/"]);
    expect(ctx.config.coverage.exclude_patterns).toEqual(["fixtures/**"]);
  });

  // AC: @coverage-scan-config ac-configured-paths
  it("worktree config takes precedence over main repo config", async () => {
    const { mainDir, codeWorktreeDir } = await setupWorktreeProject();

    // Main repo has a config WITHOUT coverage
    await fs.writeFile(
      path.join(mainDir, "kspec.config.yaml"),
      "dispatch:\n  base_branch: main\n",
      "utf-8",
    );
    // Worktree has a config WITH coverage
    await fs.writeFile(
      path.join(codeWorktreeDir, "kspec.config.yaml"),
      "coverage:\n  scan_paths:\n    - src/tests/\n",
      "utf-8",
    );

    const ctx = await initContext(codeWorktreeDir);

    expect(ctx.config.coverage.scan_paths).toEqual(["src/tests/"]);
  });
});
