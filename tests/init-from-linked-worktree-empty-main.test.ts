/**
 * End-to-end regression tests for `kspec init` invoked from a linked git
 * worktree when the main working tree has NO shadow at all.
 *
 * Closes (empty-main edge case):
 *   @worktree-support ac-init-linked-wt-unchanged
 *   @worktree-support ac-init-main-wt-unchanged
 *   @worktree-support ac-init-guidance-direction
 *   @worktree-support ac-init-guidance-path
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir, cleanupTempDir, initGitRepo, kspec } from "./helpers/cli.js";
import {
  captureShadowBaseline,
  assertShadowUnchanged,
  addLinkedWorktree,
} from "./helpers/worktree-baseline.js";

describe("kspec init from linked worktree (empty main)", () => {
  let tempDir: string;
  let linkedWt: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-init-linked-empty-");
    initGitRepo(tempDir);
    await fs.writeFile(path.join(tempDir, "README.md"), "# test\n");
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: "pipe" });

    // NO kspec init on main — this test exercises the "empty main" case.
    linkedWt = addLinkedWorktree(tempDir, "sub");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @worktree-support ac-init-linked-wt-unchanged
  // AC: @worktree-support ac-init-main-wt-unchanged
  // AC: @worktree-support ac-init-guidance-direction
  // AC: @worktree-support ac-init-guidance-path
  it("refuses to run, leaves empty main untouched, and identifies the main path", async () => {
    const before = captureShadowBaseline(tempDir);
    expect(before.dirExists).toBe(false);

    const result = kspec("init --no-prompt", linkedWt, { expectFail: true });

    // Exit is non-zero and guidance identifies the main working tree.
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined.toLowerCase()).toMatch(/main working tree|main repo/);
    expect(combined).toContain(tempDir);

    // Neither working tree has a .kspec directory.
    const linkedShadow = path.join(linkedWt, ".kspec");
    const linkedShadowExists = await fs
      .access(linkedShadow)
      .then(() => true)
      .catch(() => false);
    expect(linkedShadowExists).toBe(false);

    const after = captureShadowBaseline(tempDir);
    expect(after.dirExists).toBe(false);
    assertShadowUnchanged(before, after, "kspec init empty-main from linked worktree");
  });
});
