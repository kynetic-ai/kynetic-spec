import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { initializeShadow, SHADOW_BRANCH_NAME, SHADOW_WORKTREE_DIR } from "../src/parser/shadow.js";
import { kspec, createTempDir, cleanupTempDir, initGitRepo } from "./helpers/cli.js";

describe("kspec setup", () => {
  const testDir = path.join("/tmp", `kspec-setup-test-${Date.now()}`);
  const kspecBin = path.join(process.cwd(), "dist", "cli", "index.js");

  beforeEach(async () => {
    // Clean up any previous test directory
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Doesn't exist, that's fine
    }
    await fs.mkdir(testDir, { recursive: true });

    // Initialize a git repo
    execSync("git init", { cwd: testDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: testDir, stdio: "pipe" });

    // Create initial commit on 'main' branch
    await fs.writeFile(path.join(testDir, "README.md"), "# Test Project", "utf-8");
    execSync("git add README.md", { cwd: testDir, stdio: "pipe" });
    execSync('git commit -m "Initial commit"', { cwd: testDir, stdio: "pipe" });
    // Rename default branch to 'main' for consistency across git versions
    execSync("git branch -M main", { cwd: testDir, stdio: "pipe" });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  });

  // AC: worktree-already-exists
  it("should skip worktree creation when .kspec worktree already exists", async () => {
    // Create kspec-meta branch with worktree
    execSync(`git worktree add --orphan -b ${SHADOW_BRANCH_NAME} ${SHADOW_WORKTREE_DIR}`, {
      cwd: testDir,
      stdio: "pipe",
    });

    // Create a manifest file in the worktree
    const manifestPath = path.join(testDir, SHADOW_WORKTREE_DIR, "test.yaml");
    await fs.writeFile(manifestPath, 'kynetic: "1.0"\n', "utf-8");

    // Run kspec setup with dry-run to avoid actual agent config
    // Set CLAUDECODE=1 to simulate Claude Code environment (so agent detection works)
    const result = spawnSync("node", [kspecBin, "setup", "--dry-run"], {
      cwd: testDir,
      encoding: "utf-8",
      env: { ...process.env, CLAUDECODE: "1", KSPEC_NO_DAEMON: "1" },
    });

    // Should succeed without prompting for worktree creation
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Create it?");
    // Enhanced setup shows summary instead of "Would configure"
    expect(result.stdout).toContain("DRY RUN");
  });

  // AC: auto-worktree-flag
  it("should automatically create .kspec worktree with --auto-worktree flag", async () => {
    // Create kspec-meta branch without worktree
    execSync(`git checkout --orphan ${SHADOW_BRANCH_NAME}`, { cwd: testDir, stdio: "pipe" });
    execSync("git rm -rf .", { cwd: testDir, stdio: "pipe" });

    // Create a manifest file
    await fs.writeFile(path.join(testDir, "test.yaml"), 'kynetic: "1.0"\n', "utf-8");
    execSync("git add test.yaml", { cwd: testDir, stdio: "pipe" });
    execSync('git commit -m "Initialize shadow"', { cwd: testDir, stdio: "pipe" });

    // Switch back to main
    execSync("git checkout main", { cwd: testDir, stdio: "pipe" });

    // Verify worktree doesn't exist yet
    const worktreePath = path.join(testDir, SHADOW_WORKTREE_DIR);
    let worktreeExists = false;
    try {
      await fs.access(worktreePath);
      worktreeExists = true;
    } catch {
      // Expected - doesn't exist yet
    }
    expect(worktreeExists).toBe(false);

    // Run kspec setup with --auto-worktree and --dry-run
    const result = spawnSync("node", [kspecBin, "setup", "--auto-worktree", "--dry-run"], {
      cwd: testDir,
      encoding: "utf-8",
      env: { ...process.env, KSPEC_NO_DAEMON: "1" },
    });

    // Should succeed and create worktree without prompting
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Detected ${SHADOW_BRANCH_NAME} shadow state without a healthy ${SHADOW_WORKTREE_DIR} worktree`,
    );
    expect(result.stdout).toContain(`Created ${SHADOW_WORKTREE_DIR} worktree`);
    expect(result.stdout).not.toContain("Create it?");

    // Verify worktree was created
    try {
      await fs.access(worktreePath);
      worktreeExists = true;
    } catch {
      worktreeExists = false;
    }
    expect(worktreeExists).toBe(true);
  });

  // AC: detect-existing-repo
  it("should prompt to create worktree when kspec-meta exists but .kspec does not", async () => {
    // Create kspec-meta branch without worktree
    execSync(`git checkout --orphan ${SHADOW_BRANCH_NAME}`, { cwd: testDir, stdio: "pipe" });
    execSync("git rm -rf .", { cwd: testDir, stdio: "pipe" });

    // Create a manifest file
    await fs.writeFile(path.join(testDir, "test.yaml"), 'kynetic: "1.0"\n', "utf-8");
    execSync("git add test.yaml", { cwd: testDir, stdio: "pipe" });
    execSync('git commit -m "Initialize shadow"', { cwd: testDir, stdio: "pipe" });

    // Switch back to main
    execSync("git checkout main", { cwd: testDir, stdio: "pipe" });

    // Run kspec setup without --auto-worktree, provide 'n' as input to decline
    const result = spawnSync("node", [kspecBin, "setup", "--dry-run"], {
      cwd: testDir,
      encoding: "utf-8",
      input: "n\n", // Decline worktree creation
      env: { ...process.env, KSPEC_NO_DAEMON: "1" },
    });

    // Should prompt with the expected message
    expect(result.stdout).toContain(
      `${SHADOW_BRANCH_NAME} shadow state exists but ${SHADOW_WORKTREE_DIR} worktree is missing or unhealthy. Create it?`,
    );
    expect(result.status).toBe(1); // Exit with error since user declined
  });

  // AC: @broken-shadow-safety ac-bootstrap-reuses-repair
  it("should reattach remote shadow state with --auto-worktree when no local shadow branch exists", async () => {
    const remoteDir = path.join("/tmp", `kspec-setup-remote-${Date.now()}`);
    const cloneDir = path.join("/tmp", `kspec-setup-clone-${Date.now()}`);

    try {
      await fs.mkdir(remoteDir, { recursive: true });
      execSync("git init --bare", { cwd: remoteDir, stdio: "pipe" });
      execSync(`git remote add origin ${remoteDir}`, { cwd: testDir, stdio: "pipe" });
      execSync("git push -u origin main", { cwd: testDir, stdio: "pipe" });

      const initResult = await initializeShadow(testDir);
      expect(initResult.success).toBe(true);
      execSync(`git -C ${testDir}/${SHADOW_WORKTREE_DIR} push -u origin ${SHADOW_BRANCH_NAME}`, {
        stdio: "pipe",
      });

      execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: "pipe" });
      execSync('git config user.email "test@test.com"', { cwd: cloneDir, stdio: "pipe" });
      execSync('git config user.name "Test"', { cwd: cloneDir, stdio: "pipe" });

      const result = spawnSync("node", [kspecBin, "setup", "--auto-worktree", "--dry-run"], {
        cwd: cloneDir,
        encoding: "utf-8",
        env: { ...process.env, KSPEC_NO_DAEMON: "1" },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `Detected ${SHADOW_BRANCH_NAME} shadow state without a healthy ${SHADOW_WORKTREE_DIR} worktree`,
      );
      await fs.access(path.join(cloneDir, SHADOW_WORKTREE_DIR));
    } finally {
      await fs.rm(cloneDir, { recursive: true, force: true });
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });
});

describe("kspec setup without agent environment", () => {
  let tempDir: string;
  const kspecBinPath = path.join(process.cwd(), "dist", "cli", "index.js");

  // Build a minimal env that has NO agent detection vars at all.
  // This prevents false detection (e.g. AIDER_DARK_MODE !== undefined).
  function cleanEnv(): Record<string, string> {
    return {
      PATH: process.env.PATH || "",
      HOME: "/tmp/fake-home-no-claude", // Prevent ~/.claude fallback
      NODE_PATH: process.env.NODE_PATH || "",
      KSPEC_AUTHOR: "", // Explicitly unset so Configure author step runs
      KSPEC_NO_DAEMON: "1", // Suppress implicit daemon auto-start in test subprocesses
    };
  }

  function runSetup(args: string): { exitCode: number; stdout: string; stderr: string } {
    const result = spawnSync("node", [kspecBinPath, "setup", ...args.split(" ").filter(Boolean)], {
      cwd: tempDir,
      encoding: "utf-8",
      timeout: 30_000,
      env: cleanEnv(),
    });
    return {
      exitCode: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  }

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-setup-no-agent-");
    initGitRepo(tempDir);

    // Create initial commit
    await fs.writeFile(path.join(tempDir, "README.md"), "# Test", "utf-8");
    execSync('git add README.md && git commit -m "Initial"', {
      cwd: tempDir,
      stdio: "pipe",
    });

    // Initialize kspec project so setup pipeline has something to work with
    kspec("init --name test-project --no-prompt", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @cmd-setup ac-1
  it("should proceed with core setup steps when no agent environment is detected", () => {
    const result = runSetup("--dry-run");

    // Should NOT exit with error
    expect(result.exitCode).toBe(0);
    // Should warn about missing agent but proceed
    expect(result.stderr).toContain("Could not auto-detect agent environment");
    // Should still run the pipeline and show setup summary steps
    expect(result.stdout).toContain("Agent detection");
    expect(result.stdout).toContain("unknown");
    expect(result.stdout).toContain("Install core skills");
    expect(result.stdout).toContain("Render skills");
    expect(result.stdout).toContain("Generate kspec-agents.md");
  });

  // AC: @cmd-setup ac-1
  it("should print manual KSPEC_AUTHOR instructions for unknown agents", () => {
    const result = runSetup("--dry-run");

    expect(result.exitCode).toBe(0);
    // Should show manual instructions for setting KSPEC_AUTHOR
    expect(result.stdout).toContain("KSPEC_AUTHOR");
    expect(result.stdout).toContain("export KSPEC_AUTHOR");
  });

  // AC: @cmd-setup ac-1
  it("should show skipped Configure author step for unknown agents", () => {
    const result = runSetup("--dry-run");

    expect(result.exitCode).toBe(0);
    // Should show Configure author as skipped with manual instructions message
    expect(result.stdout).toContain("Configure author");
    expect(result.stdout).toContain("no auto-config for unknown agent");
  });
});
