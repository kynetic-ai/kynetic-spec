import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";

// Controls the mocked fs.rename below. The restore direction renames the
// backup directory back into place, so a source path containing
// ".repair-backup-" identifies the restore rename (the stash rename has the
// backup path as its destination instead).
const renameControl = vi.hoisted(() => ({ failRestoreRename: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameControl.failRestoreRename && String(oldPath).includes(".repair-backup-")) {
        throw new Error("EACCES: simulated restore rename failure");
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import * as fs from "node:fs/promises";
import { initializeShadow, repairShadow, SHADOW_WORKTREE_DIR } from "../src/parser/shadow.js";
import { readTestOutput } from "./helpers/cli.js";

describe("shadow rebuild failure restore reporting", () => {
  // Use /tmp to ensure we're outside any git repo for proper isolation
  const testDir = path.join("/tmp", `kspec-shadow-restore-failure-test-${Date.now()}`);
  const worktreeDir = path.join(testDir, SHADOW_WORKTREE_DIR);
  const gitFile = path.join(worktreeDir, ".git");
  const competingWorktree = path.join(testDir, "shadow-conflict");

  // Set up a healthy shadow, then break it in a way that (a) makes the
  // worktree dir get stashed during rebuild (corrupted .git file) and
  // (b) makes the rebuild's `git worktree add` fail (kspec-meta already
  // checked out at a competing worktree).
  async function setupBrokenShadowWithFailingRebuild(): Promise<void> {
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });
    await fs.writeFile(path.join(testDir, "README.md"), "# Test");
    execSync('git add . && git commit -m "initial"', { cwd: testDir, stdio: "pipe" });
    await initializeShadow(testDir);

    await fs.writeFile(gitFile, "corrupted content");
    execSync(`git worktree add --force "${competingWorktree}" kspec-meta`, {
      cwd: testDir,
      stdio: "pipe",
    });
  }

  async function findBackupDirs(): Promise<string[]> {
    const entries = await fs.readdir(testDir);
    return entries.filter((e) => e.includes(".repair-backup-"));
  }

  beforeEach(async () => {
    renameControl.failRestoreRename = false;
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Doesn't exist, that's fine
    }
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    renameControl.failRestoreRename = false;
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  });

  function expectRestoreFailureReport(error: string): string {
    // Reports the restore failure alongside the original rebuild error
    expect(error).toContain("Shadow rebuild failed:");
    expect(error).toContain("Restoring the previous shadow directory also failed:");
    expect(error).toContain("simulated restore rename failure");

    // Identifies the absolute path of the preserved backup directory
    const backupMatch = error.match(/preserved at: (\S+\.repair-backup-\d+)/);
    expect(backupMatch).not.toBeNull();
    const backupDir = backupMatch![1];
    expect(path.isAbsolute(backupDir)).toBe(true);

    // Describes the resulting state of the shadow directory location.
    // restoreStashedWorktreeDir removes the worktree location before the
    // rename, so on rename failure the location is empty and the backup is
    // the only copy.
    expect(error).toContain(`The shadow directory location (${worktreeDir})`);
    expect(error).toContain("now empty");
    expect(error).toContain("only copy of the prior shadow state");

    // Provides concrete recovery steps
    expect(error).toContain("Recovery steps:");
    expect(error).toContain(`mv "${backupDir}" "${worktreeDir}"`);
    expect(error).toContain("kspec shadow repair");

    return backupDir;
  }

  describe("repairShadow", () => {
    // AC: @broken-shadow-safety ac-preserve-on-failure
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("reports backup location, worktree state, and recovery steps when rebuild and restore both fail", async () => {
      await setupBrokenShadowWithFailingRebuild();
      renameControl.failRestoreRename = true;

      const result = await repairShadow(testDir);

      expect(result.success).toBe(false);
      const backupDir = expectRestoreFailureReport(result.error ?? "");

      // The backup directory is never deleted on this path — it still holds
      // the pre-repair shadow state
      expect(await readTestOutput(path.join(backupDir, ".git"), "utf-8")).toBe("corrupted content");

      // The worktree location really is empty, matching the report
      await expect(fs.stat(worktreeDir)).rejects.toThrow();
    });

    // AC: @broken-shadow-safety ac-preserve-on-failure
    it("notes that the prior shadow state was restored when rebuild fails but restore succeeds", async () => {
      await setupBrokenShadowWithFailingRebuild();

      const result = await repairShadow(testDir);

      expect(result.success).toBe(false);
      // Rebuild failure is still reported, plus the restored-state note
      expect(result.error).toBeTruthy();
      expect(result.error).toContain(
        `The prior shadow directory state was restored to ${worktreeDir}.`,
      );

      // The prior shadow directory contents are back in place
      expect(await readTestOutput(gitFile, "utf-8")).toBe("corrupted content");

      // No orphaned backup directory is left behind after a successful restore
      expect(await findBackupDirs()).toEqual([]);
    });
  });

  describe("initializeShadow", () => {
    // AC: @broken-shadow-safety ac-preserve-on-failure
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("reports backup location, worktree state, and recovery steps when rebuild and restore both fail", async () => {
      await setupBrokenShadowWithFailingRebuild();
      renameControl.failRestoreRename = true;

      const result = await initializeShadow(testDir);

      expect(result.success).toBe(false);
      const backupDir = expectRestoreFailureReport(result.error ?? "");

      // The backup directory is never deleted on this path
      expect(await readTestOutput(path.join(backupDir, ".git"), "utf-8")).toBe("corrupted content");

      // The worktree location really is empty, matching the report
      await expect(fs.stat(worktreeDir)).rejects.toThrow();
    });

    // AC: @broken-shadow-safety ac-preserve-on-failure
    it("notes that the prior shadow state was restored when rebuild fails but restore succeeds", async () => {
      await setupBrokenShadowWithFailingRebuild();

      const result = await initializeShadow(testDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain(
        `The prior shadow directory state was restored to ${worktreeDir}.`,
      );

      // The prior shadow directory contents are back in place
      expect(await readTestOutput(gitFile, "utf-8")).toBe("corrupted content");

      // No orphaned backup directory is left behind after a successful restore
      expect(await findBackupDirs()).toEqual([]);
    });
  });
});
