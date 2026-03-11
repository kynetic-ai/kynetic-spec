import { execSync } from "node:child_process";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectRoots } from "../../src/parser/shadow.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
} from "../helpers/cli.js";

const cleanupDirs: string[] = [];

async function makeRepo(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  cleanupDirs.push(dir);
  initGitRepo(dir);
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: "pipe" });
  return dir;
}

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      await cleanupTempDir(dir);
    }
  }
});

describe("resolveProjectRoots", () => {
  // AC: @worktree-support ac-no-worktree-unchanged
  it("returns the repo root unchanged when not in a linked worktree", async () => {
    const repoDir = await makeRepo("kspec-project-roots-main-");

    const roots = resolveProjectRoots(repoDir);

    expect(roots).toEqual({
      mainRoot: repoDir,
      worktreeRoot: repoDir,
      isWorktree: false,
    });
  });

  // AC: @worktree-support ac-resolve-roots
  it("returns mainRoot and worktreeRoot for a linked worktree", async () => {
    const repoDir = await makeRepo("kspec-project-roots-linked-");
    const worktreeBase = await createTempDir("kspec-project-roots-linked-base-");
    cleanupDirs.push(worktreeBase);
    const worktreeDir = path.join(worktreeBase, "wt");

    execSync(`git worktree add "${worktreeDir}" -b feature/worktree-roots`, {
      cwd: repoDir,
      stdio: "pipe",
    });

    const roots = resolveProjectRoots(worktreeDir);

    expect(roots).toEqual({
      mainRoot: repoDir,
      worktreeRoot: worktreeDir,
      isWorktree: true,
    });
  });

  // AC: @worktree-support ac-resolve-roots
  it("resolves detached worktrees as linked worktrees", async () => {
    const repoDir = await makeRepo("kspec-project-roots-detached-");
    const worktreeBase = await createTempDir("kspec-project-roots-detached-base-");
    cleanupDirs.push(worktreeBase);
    const worktreeDir = path.join(worktreeBase, "detached");

    execSync(`git worktree add --detach "${worktreeDir}"`, {
      cwd: repoDir,
      stdio: "pipe",
    });

    const roots = resolveProjectRoots(worktreeDir);

    expect(roots).toEqual({
      mainRoot: repoDir,
      worktreeRoot: worktreeDir,
      isWorktree: true,
    });
  });

  // AC: @worktree-support ac-submodule-safe
  it("does not treat git submodules as linked worktrees", async () => {
    const parentDir = await makeRepo("kspec-project-roots-parent-");
    const submoduleSource = await makeRepo("kspec-project-roots-submodule-src-");
    const submodulePath = path.join(parentDir, "deps", "child");

    execSync(
      `git -c protocol.file.allow=always submodule add "${submoduleSource}" "${submodulePath}"`,
      { cwd: parentDir, stdio: "pipe" },
    );

    const roots = resolveProjectRoots(submodulePath);

    expect(roots).toEqual({
      mainRoot: submodulePath,
      worktreeRoot: submodulePath,
      isWorktree: false,
    });
  });

  it("returns null outside a git repository", async () => {
    const dir = await createTempDir("kspec-project-roots-none-");
    cleanupDirs.push(dir);

    expect(resolveProjectRoots(dir)).toBeNull();
  });

  it("returns null for bare repositories", async () => {
    const bareDir = await createTempDir("kspec-project-roots-bare-");
    cleanupDirs.push(bareDir);
    execSync("git init --bare", { cwd: bareDir, stdio: "pipe" });

    expect(resolveProjectRoots(bareDir)).toBeNull();
  });
});
