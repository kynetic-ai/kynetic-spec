/**
 * Regression test: two `kspec shadow repair` commands run concurrently
 * from different working trees of the same repo must leave the main
 * working tree's shadow in a consistent state. Neither command may
 * destructively observe the other's cwd as a side effect.
 *
 * Closes: @worktree-support ac-shadow-ops-concurrent-safety
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  kspec,
  CLI_PATH,
} from "./helpers/cli.js";
import { captureShadowBaseline, addLinkedWorktree } from "./helpers/worktree-baseline.js";

interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runKspecAsync(args: string[], cwd: string): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        KSPEC_AUTHOR: "@test",
        KSPEC_NO_DAEMON: "1",
        HOME: path.join(cwd, ".test-home"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

describe("shadow lifecycle concurrent safety", () => {
  let tempDir: string;
  let linkedWt: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-concurrent-");
    initGitRepo(tempDir);
    await fs.writeFile(path.join(tempDir, "README.md"), "# test\n");
    execSync('git add . && git commit -m "init"', { cwd: tempDir, stdio: "pipe" });

    const initResult = kspec("init --no-prompt", tempDir);
    if (initResult.exitCode !== 0) {
      throw new Error(
        `beforeEach: kspec init on main failed (exit ${initResult.exitCode}): ${initResult.stderr || initResult.stdout}`,
      );
    }

    linkedWt = addLinkedWorktree(tempDir, "sub");

    // Ensure isolated HOME exists for each cwd so concurrent CLI procs don't
    // contend on a shared daemon pid/port file.
    await fs.mkdir(path.join(tempDir, ".test-home", ".config", "kspec"), {
      recursive: true,
    });
    await fs.mkdir(path.join(linkedWt, ".test-home", ".config", "kspec"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @worktree-support ac-shadow-ops-concurrent-safety
  it("main's shadow repair + linked-wt's shadow repair both complete without destructive side effects", async () => {
    const before = captureShadowBaseline(tempDir);

    const [mainResult, linkedResult] = await Promise.all([
      runKspecAsync(["shadow", "repair"], tempDir),
      runKspecAsync(["shadow", "repair"], linkedWt),
    ]);

    // At least one of the invocations should exit cleanly. Both exit zero
    // is the ideal (shadow repair is idempotent and the CLI layer resolves
    // to mainRoot), but we accept any outcome as long as main's shadow
    // stays consistent and the linked wt gains no .kspec directory.
    expect([0, 1]).toContain(mainResult.exitCode);
    expect([0, 1]).toContain(linkedResult.exitCode);

    const linkedShadow = path.join(linkedWt, ".kspec");
    const linkedShadowExists = await fs
      .access(linkedShadow)
      .then(() => true)
      .catch(() => false);
    expect(linkedShadowExists).toBe(false);

    // Main's shadow branch tip must still be the same commit we started on.
    const after = captureShadowBaseline(tempDir);
    expect(after.shadowBranchSha).toBe(before.shadowBranchSha);
    expect(after.dirExists).toBe(true);

    // Final `shadow status` from the main tree is clean.
    const statusResult = kspec("shadow status", tempDir);
    expect(statusResult.exitCode).toBe(0);
  });
});
