/**
 * End-to-end regression tests for `kspec init` invoked from a linked git
 * worktree when the main working tree already has a healthy shadow.
 *
 * Closes:
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

describe("kspec init from linked worktree (existing main shadow)", () => {
  let tempDir: string;
  let linkedWt: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-init-linked-existing-");
    initGitRepo(tempDir);
    await fs.writeFile(path.join(tempDir, "README.md"), "# test\n");
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: "pipe" });

    // Establish a healthy shadow on the main working tree first.
    const initResult = kspec("init --no-prompt", tempDir);
    if (initResult.exitCode !== 0) {
      throw new Error(
        `beforeEach: kspec init on main failed (exit ${initResult.exitCode}): ${initResult.stderr || initResult.stdout}`,
      );
    }

    // Then create a linked worktree from which init will be (incorrectly) invoked.
    linkedWt = addLinkedWorktree(tempDir, "sub");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @worktree-support ac-init-linked-wt-unchanged
  // AC: @worktree-support ac-init-main-wt-unchanged
  // AC: @worktree-support ac-init-guidance-direction
  // AC: @worktree-support ac-init-guidance-path
  it("refuses to run, leaves both working trees unchanged, and identifies the main path", async () => {
    const before = captureShadowBaseline(tempDir);
    expect(before.dirExists).toBe(true);

    const result = kspec("init --no-prompt", linkedWt, { expectFail: true });

    // Exit is non-zero and the message points at the main working tree.
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined.toLowerCase()).toMatch(/main working tree|main repo/);
    expect(combined).toContain(tempDir);

    // Linked worktree did not gain a .kspec directory.
    const linkedShadow = path.join(linkedWt, ".kspec");
    const linkedShadowExists = await fs
      .access(linkedShadow)
      .then(() => true)
      .catch(() => false);
    expect(linkedShadowExists).toBe(false);

    // Main working tree's shadow is bit-for-bit unchanged.
    const after = captureShadowBaseline(tempDir);
    assertShadowUnchanged(before, after, "kspec init from linked worktree");
  });
});
