/**
 * Regression test: `kspec shadow repair` invoked from a linked git worktree
 * must continue to repair the main working tree's shadow, because the shadow
 * subcommand uses `resolveProjectRoots()` to pin operations to mainRoot.
 *
 * This also proves that the new shadow-cross-worktree guard does not
 * over-fire on legitimate lifecycle operations.
 *
 * Closes (repair-flow aspect):
 *   @worktree-support ac-shadow-ops-scoped-to-main
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir, cleanupTempDir, initGitRepo, kspec } from "./helpers/cli.js";
import {
  captureShadowBaseline,
  addLinkedWorktree,
} from "./helpers/worktree-baseline.js";

describe("kspec shadow repair from linked worktree (broken main)", () => {
  let tempDir: string;
  let linkedWt: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-repair-linked-");
    initGitRepo(tempDir);
    await fs.writeFile(path.join(tempDir, "README.md"), "# test\n");
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: "pipe" });

    // Initialize main shadow.
    const initResult = kspec("init --no-prompt", tempDir);
    if (initResult.exitCode !== 0) {
      throw new Error(
        `beforeEach: kspec init on main failed (exit ${initResult.exitCode}): ${initResult.stderr || initResult.stdout}`,
      );
    }

    // Break main's shadow by deleting the .git pointer file only. The
    // kspec-meta branch remains intact in the main repo's .git/worktrees
    // admin and as a ref; shadow repair should rebuild the worktree.
    const dotGit = path.join(tempDir, ".kspec", ".git");
    await fs.rm(dotGit, { force: true });

    linkedWt = addLinkedWorktree(tempDir, "sub");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @worktree-support ac-shadow-ops-scoped-to-main
  it("repairs main's shadow when invoked from the linked worktree, and does not create a linked .kspec", async () => {
    const beforeLinked = captureShadowBaseline(linkedWt);
    expect(beforeLinked.dirExists).toBe(false);

    const result = kspec("shadow repair", linkedWt, { expectFail: true });
    // Repair should succeed (exit 0) because the CLI layer resolves to mainRoot.
    expect(result.exitCode).toBe(0);

    // Linked worktree must not have a .kspec created under it.
    const linkedShadow = path.join(linkedWt, ".kspec");
    const linkedShadowExists = await fs
      .access(linkedShadow)
      .then(() => true)
      .catch(() => false);
    expect(linkedShadowExists).toBe(false);

    // Main working tree's shadow is healthy again — its .git pointer is
    // restored and points at a valid worktree entry.
    const dotGit = path.join(tempDir, ".kspec", ".git");
    const dotGitContent = await fs.readFile(dotGit, "utf-8");
    expect(dotGitContent).toContain("gitdir:");

    // Subsequent `kspec shadow status` from the main tree is clean.
    const statusResult = kspec("shadow status", tempDir);
    expect(statusResult.exitCode).toBe(0);
  });
});
