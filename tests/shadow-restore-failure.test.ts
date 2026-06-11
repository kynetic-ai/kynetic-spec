import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import * as path from "node:path";

// Controls the mocked fs.rename below. The restore direction renames the
// backup directory back into place, so a source path containing
// ".repair-backup-" identifies the restore rename (the stash rename has the
// backup path as its destination instead). occupyWorktreeOnFailure
// additionally recreates something at the destination when the restore
// rename fails, simulating a concurrent process reoccupying the worktree
// location between the restore's rm and rename — the condition under which
// recovery guidance must not blindly suggest `mv backup worktree`.
const renameControl = vi.hoisted(() => ({
  failRestoreRename: false,
  occupyWorktreeOnFailure: null as "empty-dir" | "file" | "partial-dir" | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameControl.failRestoreRename && String(oldPath).includes(".repair-backup-")) {
        const dest = String(newPath);
        if (renameControl.occupyWorktreeOnFailure === "empty-dir") {
          await actual.mkdir(dest, { recursive: true });
        } else if (renameControl.occupyWorktreeOnFailure === "file") {
          await actual.writeFile(dest, "stray file");
        } else if (renameControl.occupyWorktreeOnFailure === "partial-dir") {
          await actual.mkdir(dest, { recursive: true });
          await actual.writeFile(`${dest}/leftover`, "partial rebuild output");
        }
        throw new Error("EACCES: simulated restore rename failure");
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

import * as fs from "node:fs/promises";
import { initializeShadow, repairShadow, SHADOW_WORKTREE_DIR } from "../src/parser/shadow.js";
import { readTestOutput } from "./helpers/cli.js";

// POSIX single-quoting — the form the recovery commands must use so the
// shell takes paths literally (double quotes still expand $, backticks,
// and backslashes).
function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("shadow rebuild failure restore reporting", () => {
  // Paths for one isolated shadow-repair fixture rooted at /tmp/<dirName>.
  // Parameterized so the metacharacter-path suite can reuse the same setup
  // with a hostile directory name. /tmp keeps fixtures outside any git repo.
  function createFixture(dirName: string) {
    const testDir = path.join("/tmp", dirName);
    return {
      testDir,
      worktreeDir: path.join(testDir, SHADOW_WORKTREE_DIR),
      gitFile: path.join(testDir, SHADOW_WORKTREE_DIR, ".git"),
      competingWorktree: path.join(testDir, "shadow-conflict"),
    };
  }
  type Fixture = ReturnType<typeof createFixture>;

  const fixture = createFixture(`kspec-shadow-restore-failure-test-${Date.now()}`);
  // Directory name containing every class of character the shell treats
  // specially inside double quotes ($, backticks, backslash) plus quotes and
  // spaces — recovery commands must address this path literally.
  const metacharFixture = createFixture(
    `kspec-shadow-restore $HOME \`id\` "dq" 'sq' \\bs ${Date.now()}`,
  );

  // Set up a healthy shadow, then break it in a way that (a) makes the
  // worktree dir get stashed during rebuild (corrupted .git file) and
  // (b) makes the rebuild's `git worktree add` fail (kspec-meta already
  // checked out at a competing worktree). Git invocations that take fixture
  // paths use execFileSync arg arrays so the test setup itself never
  // round-trips paths through a shell.
  async function setupBrokenShadowWithFailingRebuild(fx: Fixture): Promise<void> {
    await fs.mkdir(fx.testDir, { recursive: true });
    execSync("git init", { cwd: fx.testDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: fx.testDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: fx.testDir, stdio: "pipe" });
    await fs.writeFile(path.join(fx.testDir, "README.md"), "# Test");
    execSync('git add . && git commit -m "initial"', { cwd: fx.testDir, stdio: "pipe" });
    await initializeShadow(fx.testDir);

    await fs.writeFile(fx.gitFile, "corrupted content");
    execFileSync("git", ["worktree", "add", "--force", fx.competingWorktree, "kspec-meta"], {
      cwd: fx.testDir,
      stdio: "pipe",
    });
  }

  async function findBackupDirs(fx: Fixture): Promise<string[]> {
    const entries = await fs.readdir(fx.testDir);
    return entries.filter((e) => e.includes(".repair-backup-"));
  }

  async function removeFixtureDirs(): Promise<void> {
    for (const fx of [fixture, metacharFixture]) {
      try {
        await fs.rm(fx.testDir, { recursive: true });
      } catch {
        // Doesn't exist, that's fine
      }
    }
  }

  beforeEach(async () => {
    renameControl.failRestoreRename = false;
    renameControl.occupyWorktreeOnFailure = null;
    await removeFixtureDirs();
  });

  afterEach(async () => {
    renameControl.failRestoreRename = false;
    renameControl.occupyWorktreeOnFailure = null;
    await removeFixtureDirs();
  });

  function expectRestoreFailureReport(fx: Fixture, error: string): string {
    // Reports the restore failure alongside the original rebuild error
    expect(error).toContain("Shadow rebuild failed:");
    expect(error).toContain("Restoring the previous shadow directory also failed:");
    expect(error).toContain("simulated restore rename failure");

    // Identifies the absolute path of the preserved backup directory
    const backupMatch = error.match(/^The previous shadow directory is preserved at: (.+)$/m);
    expect(backupMatch).not.toBeNull();
    const backupDir = backupMatch![1];
    expect(path.isAbsolute(backupDir)).toBe(true);
    expect(backupDir).toMatch(/\.repair-backup-\d+$/);

    // Describes the resulting state of the shadow directory location.
    // restoreStashedWorktreeDir removes the worktree location before the
    // rename, so on rename failure the location is empty and the backup is
    // the only copy.
    expect(error).toContain(`The shadow directory location (${fx.worktreeDir})`);
    expect(error).toContain("now empty");
    expect(error).toContain("only copy of the prior shadow state");

    // Provides concrete recovery steps. With nothing at the worktree
    // location, the plain mv restores the backup directly — there must be no
    // clear-the-destination step for a state that doesn't need one. Paths
    // are single-quoted so the shell cannot expand or split them.
    expect(error).toContain("Recovery steps:");
    const steps = parseRecoverySteps(error);
    expect(steps).toEqual([
      `mv ${shellQuoted(backupDir)} ${shellQuoted(fx.worktreeDir)}`,
      "kspec shadow repair",
    ]);

    return backupDir;
  }

  // Extracts the shell command from each numbered recovery step line
  // ("  N. <explanation>: <command>").
  function parseRecoverySteps(error: string): string[] {
    const lines = error.split("\n");
    const start = lines.indexOf("Recovery steps:");
    expect(start).toBeGreaterThan(-1);
    return lines.slice(start + 1).map((line) => {
      const match = line.match(/^ {2}\d+\. [^:]+: (.+)$/);
      expect(match, `unparseable recovery step line: ${line}`).not.toBeNull();
      return match![1];
    });
  }

  // Runs every recovery step from the error message: shell commands
  // verbatim via execSync (through /bin/sh, exactly as a user would paste
  // them), and the final "kspec shadow repair" as a real repairShadow()
  // call (the test setup's rebuild blockers are removed first so the repair
  // can succeed).
  async function executeRecoverySteps(fx: Fixture, steps: string[]): Promise<void> {
    renameControl.failRestoreRename = false;
    renameControl.occupyWorktreeOnFailure = null;
    execFileSync("git", ["worktree", "remove", "--force", fx.competingWorktree], {
      cwd: fx.testDir,
      stdio: "pipe",
    });

    for (const step of steps) {
      if (step === "kspec shadow repair") {
        // The prior shadow state must be back in place before the re-run —
        // this is what proves the preceding mv/rmdir commands actually
        // restored the backup rather than nesting, failing, or addressing a
        // shell-mangled path.
        expect(await readTestOutput(fx.gitFile, "utf-8")).toBe("corrupted content");
        const repaired = await repairShadow(fx.testDir);
        expect(repaired.success).toBe(true);
      } else {
        execSync(step, { cwd: fx.testDir, stdio: "pipe" });
      }
    }
  }

  describe("repairShadow", () => {
    // AC: @broken-shadow-safety ac-preserve-on-failure
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("reports backup location, worktree state, and recovery steps when rebuild and restore both fail", async () => {
      await setupBrokenShadowWithFailingRebuild(fixture);
      renameControl.failRestoreRename = true;

      const result = await repairShadow(fixture.testDir);

      expect(result.success).toBe(false);
      const backupDir = expectRestoreFailureReport(fixture, result.error ?? "");

      // The backup directory is never deleted on this path — it still holds
      // the pre-repair shadow state
      expect(await readTestOutput(path.join(backupDir, ".git"), "utf-8")).toBe("corrupted content");

      // The worktree location really is empty, matching the report
      await expect(fs.stat(fixture.worktreeDir)).rejects.toThrow();

      // Following the reported steps verbatim actually recovers
      await executeRecoverySteps(fixture, parseRecoverySteps(result.error ?? ""));
    });

    // AC: @broken-shadow-safety ac-preserve-on-failure
    it("notes that the prior shadow state was restored when rebuild fails but restore succeeds", async () => {
      await setupBrokenShadowWithFailingRebuild(fixture);

      const result = await repairShadow(fixture.testDir);

      expect(result.success).toBe(false);
      // Rebuild failure is still reported, plus the restored-state note
      expect(result.error).toBeTruthy();
      expect(result.error).toContain(
        `The prior shadow directory state was restored to ${fixture.worktreeDir}.`,
      );

      // The prior shadow directory contents are back in place
      expect(await readTestOutput(fixture.gitFile, "utf-8")).toBe("corrupted content");

      // No orphaned backup directory is left behind after a successful restore
      expect(await findBackupDirs(fixture)).toEqual([]);
    });
  });

  // The plain `mv <backup> <worktreeDir>` only restores the backup when
  // nothing exists at the destination — an existing directory makes mv nest
  // the backup inside it, and an existing file makes it fail. These tests
  // force the restore to fail while something reoccupies the worktree
  // location, then verify the guidance prescribes clearing the destination
  // first and that the prescribed commands really restore the backup.
  describe("state-aware recovery steps", () => {
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("prescribes rmdir before the mv when a leftover empty directory occupies the worktree location", async () => {
      await setupBrokenShadowWithFailingRebuild(fixture);
      renameControl.failRestoreRename = true;
      renameControl.occupyWorktreeOnFailure = "empty-dir";

      const result = await repairShadow(fixture.testDir);

      expect(result.success).toBe(false);
      const error = result.error ?? "";
      expect(error).toContain(
        `The shadow directory location (${fixture.worktreeDir}) is an empty directory`,
      );

      const steps = parseRecoverySteps(error);
      expect(steps).toHaveLength(3);
      expect(steps[0]).toBe(`rmdir ${shellQuoted(fixture.worktreeDir)}`);
      expect(steps[1]).toMatch(/^mv '\S+\.repair-backup-\d+' /);
      expect(steps[1].endsWith(` ${shellQuoted(fixture.worktreeDir)}`)).toBe(true);
      expect(steps[2]).toBe("kspec shadow repair");

      await executeRecoverySteps(fixture, steps);
    });

    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("prescribes moving a leftover file aside before the mv when a non-directory occupies the worktree location", async () => {
      await setupBrokenShadowWithFailingRebuild(fixture);
      renameControl.failRestoreRename = true;
      renameControl.occupyWorktreeOnFailure = "file";

      const result = await repairShadow(fixture.testDir);

      expect(result.success).toBe(false);
      const error = result.error ?? "";
      expect(error).toContain(
        `The shadow directory location (${fixture.worktreeDir}) is occupied by a non-directory file`,
      );

      const steps = parseRecoverySteps(error);
      expect(steps).toHaveLength(3);
      expect(
        steps[0].startsWith(
          `mv ${shellQuoted(fixture.worktreeDir)} '${fixture.worktreeDir}.failed-rebuild-`,
        ),
      ).toBe(true);
      expect(steps[1]).toMatch(/^mv '\S+\.repair-backup-\d+' /);
      expect(steps[1].endsWith(` ${shellQuoted(fixture.worktreeDir)}`)).toBe(true);
      expect(steps[2]).toBe("kspec shadow repair");

      await executeRecoverySteps(fixture, steps);
    });

    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("prescribes moving a leftover partial directory aside before the mv when a non-empty directory occupies the worktree location", async () => {
      await setupBrokenShadowWithFailingRebuild(fixture);
      renameControl.failRestoreRename = true;
      renameControl.occupyWorktreeOnFailure = "partial-dir";

      const result = await repairShadow(fixture.testDir);

      expect(result.success).toBe(false);
      const error = result.error ?? "";
      expect(error).toContain(
        `The shadow directory location (${fixture.worktreeDir}) is occupied by a partial or incomplete directory`,
      );

      const steps = parseRecoverySteps(error);
      expect(steps).toHaveLength(3);
      expect(
        steps[0].startsWith(
          `mv ${shellQuoted(fixture.worktreeDir)} '${fixture.worktreeDir}.failed-rebuild-`,
        ),
      ).toBe(true);
      expect(steps[1]).toMatch(/^mv '\S+\.repair-backup-\d+' /);
      expect(steps[1].endsWith(` ${shellQuoted(fixture.worktreeDir)}`)).toBe(true);
      expect(steps[2]).toBe("kspec shadow repair");

      await executeRecoverySteps(fixture, steps);
    });
  });

  // Double quotes still let the shell expand $, backticks, and backslashes,
  // so recovery commands built with them can address a different path than
  // the one that actually holds the backup (e.g. a literal "$HOME" path
  // segment expanding to the real home directory). These tests run the
  // whole double-failure flow inside a directory whose name contains every
  // such character plus quotes and spaces, and prove the prescribed
  // commands — executed verbatim through /bin/sh — restore the backup.
  describe("shell-metacharacter paths", () => {
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("emits recovery commands that restore the backup when the project path contains shell metacharacters", async () => {
      await setupBrokenShadowWithFailingRebuild(metacharFixture);
      renameControl.failRestoreRename = true;

      const result = await repairShadow(metacharFixture.testDir);

      expect(result.success).toBe(false);
      const backupDir = expectRestoreFailureReport(metacharFixture, result.error ?? "");
      expect(await readTestOutput(path.join(backupDir, ".git"), "utf-8")).toBe("corrupted content");

      // Executing the steps verbatim restores the backup to the worktree
      // location (asserted inside, before the repair re-run) and the
      // re-run succeeds
      await executeRecoverySteps(metacharFixture, parseRecoverySteps(result.error ?? ""));
    });

    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("emits a working clear-the-destination step when a leftover occupies a metacharacter worktree location", async () => {
      await setupBrokenShadowWithFailingRebuild(metacharFixture);
      renameControl.failRestoreRename = true;
      renameControl.occupyWorktreeOnFailure = "partial-dir";

      const result = await repairShadow(metacharFixture.testDir);

      expect(result.success).toBe(false);
      const steps = parseRecoverySteps(result.error ?? "");
      expect(steps).toHaveLength(3);

      await executeRecoverySteps(metacharFixture, steps);
    });
  });

  describe("initializeShadow", () => {
    // AC: @broken-shadow-safety ac-preserve-on-failure
    // AC: @broken-shadow-safety ac-restore-failure-reports-state
    it("reports backup location, worktree state, and recovery steps when rebuild and restore both fail", async () => {
      await setupBrokenShadowWithFailingRebuild(fixture);
      renameControl.failRestoreRename = true;

      const result = await initializeShadow(fixture.testDir);

      expect(result.success).toBe(false);
      const backupDir = expectRestoreFailureReport(fixture, result.error ?? "");

      // The backup directory is never deleted on this path
      expect(await readTestOutput(path.join(backupDir, ".git"), "utf-8")).toBe("corrupted content");

      // The worktree location really is empty, matching the report
      await expect(fs.stat(fixture.worktreeDir)).rejects.toThrow();
    });

    // AC: @broken-shadow-safety ac-preserve-on-failure
    it("notes that the prior shadow state was restored when rebuild fails but restore succeeds", async () => {
      await setupBrokenShadowWithFailingRebuild(fixture);

      const result = await initializeShadow(fixture.testDir);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.error).toContain(
        `The prior shadow directory state was restored to ${fixture.worktreeDir}.`,
      );

      // The prior shadow directory contents are back in place
      expect(await readTestOutput(fixture.gitFile, "utf-8")).toBe("corrupted content");

      // No orphaned backup directory is left behind after a successful restore
      expect(await findBackupDirs(fixture)).toEqual([]);
    });
  });
});
