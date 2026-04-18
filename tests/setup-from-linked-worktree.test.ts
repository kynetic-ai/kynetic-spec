/**
 * End-to-end regression tests for `kspec setup` invoked from a linked git
 * worktree. Setup must hard-error with a message identifying the main
 * working tree, and must not mutate shadow state in either working tree.
 *
 * Closes:
 *   @worktree-support ac-setup-linked-wt-unchanged
 *   @worktree-support ac-setup-main-wt-unchanged
 *   @worktree-support ac-setup-guidance-direction
 *   @worktree-support ac-setup-guidance-path
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

describe("kspec setup from linked worktree", () => {
  let tempDir: string;
  let linkedWt: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-setup-linked-");
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

    linkedWt = addLinkedWorktree(tempDir, "sub");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @worktree-support ac-setup-linked-wt-unchanged
  // AC: @worktree-support ac-setup-main-wt-unchanged
  // AC: @worktree-support ac-setup-guidance-direction
  // AC: @worktree-support ac-setup-guidance-path
  it("refuses to run, leaves both working trees unchanged, and identifies the main path", async () => {
    const before = captureShadowBaseline(tempDir);
    expect(before.dirExists).toBe(true);

    const result = kspec("setup --dry-run", linkedWt, { expectFail: true });

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

    // Main working tree shadow is bit-for-bit unchanged.
    const after = captureShadowBaseline(tempDir);
    assertShadowUnchanged(before, after, "kspec setup from linked worktree");
  });
});
