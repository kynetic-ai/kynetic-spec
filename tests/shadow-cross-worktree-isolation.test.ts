/**
 * Regression tests for the shadow worktree cross-contamination guard.
 *
 * These tests exercise the low-level guard in initializeShadow/repairShadow
 * directly, proving that the functions refuse to mutate shadow state when
 * called with a linked-worktree path as projectRoot.
 *
 * Closes: @worktree-support ac-shadow-ops-scoped-to-main
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir, cleanupTempDir, initGitRepo } from "./helpers/cli.js";
import {
  captureShadowBaseline,
  assertShadowUnchanged,
  addLinkedWorktree,
} from "./helpers/worktree-baseline.js";
import {
  initializeShadow,
  repairShadow,
  assertMainWorkingTree,
  ShadowError,
} from "../src/parser/shadow.js";

describe("shadow-cross-worktree-isolation (low-level guard)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-shadow-guard-");
    initGitRepo(tempDir);
    await fs.writeFile(path.join(tempDir, "README.md"), "# test\n");
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: "pipe" });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @worktree-support ac-shadow-ops-scoped-to-main
  it("assertMainWorkingTree throws a ShadowError when called from a linked worktree", async () => {
    const linked = addLinkedWorktree(tempDir, "sub");

    let thrown: unknown = null;
    try {
      assertMainWorkingTree(linked);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ShadowError);
    const error = thrown as ShadowError;
    expect(error.code).toBe("LINKED_WORKTREE_NOT_SUPPORTED");
    // Guidance message identifies the main working tree path so the user
    // can re-run the command from the correct location.
    expect(error.message).toContain(tempDir);
  });

  // AC: @worktree-support ac-shadow-ops-scoped-to-main
  it("assertMainWorkingTree does not throw when called from the main working tree", () => {
    expect(() => assertMainWorkingTree(tempDir)).not.toThrow();
  });

  // AC: @worktree-support ac-shadow-ops-scoped-to-main
  it("initializeShadow refuses to run when projectRoot is a linked worktree", async () => {
    const linked = addLinkedWorktree(tempDir, "sub");

    // Set up a healthy shadow on the main working tree first so we can
    // prove it's untouched.
    const setupResult = await initializeShadow(tempDir, { projectName: "Test" });
    expect(setupResult.success).toBe(true);

    const before = captureShadowBaseline(tempDir);
    expect(before.dirExists).toBe(true);

    const result = await initializeShadow(linked, { projectName: "Test" });
    expect(result.success).toBe(false);
    expect(result.error || "").toMatch(/linked worktree|main working tree/i);
    expect(result.error || "").toContain(tempDir);

    // Linked worktree must not have gained a .kspec directory.
    const linkedShadow = path.join(linked, ".kspec");
    const linkedShadowExists = await fs
      .access(linkedShadow)
      .then(() => true)
      .catch(() => false);
    expect(linkedShadowExists).toBe(false);

    const after = captureShadowBaseline(tempDir);
    assertShadowUnchanged(before, after, "initializeShadow from linked worktree");
  });

  // AC: @worktree-support ac-shadow-ops-scoped-to-main
  it("repairShadow refuses to run when projectRoot is a linked worktree", async () => {
    const linked = addLinkedWorktree(tempDir, "sub");

    const setupResult = await initializeShadow(tempDir, { projectName: "Test" });
    expect(setupResult.success).toBe(true);

    const before = captureShadowBaseline(tempDir);

    const result = await repairShadow(linked);
    expect(result.success).toBe(false);
    expect(result.error || "").toMatch(/linked worktree|main working tree/i);
    expect(result.error || "").toContain(tempDir);

    const linkedShadow = path.join(linked, ".kspec");
    const linkedShadowExists = await fs
      .access(linkedShadow)
      .then(() => true)
      .catch(() => false);
    expect(linkedShadowExists).toBe(false);

    const after = captureShadowBaseline(tempDir);
    assertShadowUnchanged(before, after, "repairShadow from linked worktree");
  });

  // AC: @worktree-support ac-shadow-ops-scoped-to-main
  it("repairShadow succeeds when projectRoot is the main working tree even if called from a linked cwd", async () => {
    // This test validates that the guard does not over-fire on legitimate
    // callers: when mainRoot is passed, the guard must NOT block repair,
    // regardless of which cwd the process was invoked from. The CLI layer
    // is responsible for resolving mainRoot before calling into the parser.
    addLinkedWorktree(tempDir, "sub");

    const initResult = await initializeShadow(tempDir, { projectName: "Test" });
    expect(initResult.success).toBe(true);

    // Simulate a broken worktree by deleting .kspec/.git pointer.
    const dotGit = path.join(tempDir, ".kspec", ".git");
    try {
      await fs.rm(dotGit, { force: true });
    } catch {
      // ignore
    }

    // Call repairShadow with mainRoot (not the linked wt) — the CLI layer
    // always resolves this before delegating.
    const repairResult = await repairShadow(tempDir);
    expect(repairResult.success).toBe(true);

    // Verify the shadow worktree is healthy again.
    const dotGitAfter = await fs.readFile(dotGit, "utf-8").catch(() => "");
    expect(dotGitAfter).toContain("gitdir:");
  });
});
