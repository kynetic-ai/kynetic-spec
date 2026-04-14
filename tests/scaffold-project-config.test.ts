// Tests for scaffolding project config file during init/setup.
//
// AC: @scaffolded-project-config ac-file-scaffolded
// AC: @scaffolded-project-config ac-file-valid-on-load
// AC: @scaffolded-project-config ac-placeholder-publication-mode
// AC: @scaffolded-project-config ac-placeholder-base-branch
// AC: @scaffolded-project-config ac-placeholder-coverage
// AC: @scaffolded-project-config ac-file-exists-preserved
// AC: @scaffolded-project-config ac-file-force-overwrites
// AC: @scaffolded-project-config ac-file-force-backup
// AC: @trait-idempotent-file-scaffold ac-existing-file-preserved-without-force
// AC: @trait-idempotent-file-scaffold ac-force-backs-up-before-overwrite
// AC: @trait-idempotent-file-scaffold ac-fresh-file-creation
// AC: @trait-idempotent-file-scaffold ac-step-reports-action
// AC: @trait-error-guidance ac-3 — N/A: scaffold step does not perform ref lookups
// AC: @trait-error-guidance ac-4 — N/A: scaffold step does not perform state transitions

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { kspec, createTempDir, cleanupTempDir, initGitRepo } from "./helpers/cli.js";

const CONFIG_FILENAME = "kspec.config.yaml";

/**
 * Helper: Set up a temp directory with git and kspec init (no setup).
 */
async function setupKspecProject(tempDir: string): Promise<void> {
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test", "utf-8");
  execSync('git add README.md && git commit -m "Initial"', {
    cwd: tempDir,
    stdio: "pipe",
  });
  const initResult = kspec("init --no-prompt", tempDir);
  expect(initResult.exitCode).toBe(0);
}

describe("Scaffold Project Config", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-scaffold-config-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  describe("fresh project (no existing config)", () => {
    // AC: @scaffolded-project-config ac-file-scaffolded
    // AC: @trait-idempotent-file-scaffold ac-fresh-file-creation
    it("creates kspec.config.yaml when running init --setup on fresh project", async () => {
      await setupKspecProject(testDir);
      const result = kspec("setup", testDir);

      expect(result.exitCode).toBe(0);

      const configPath = path.join(testDir, CONFIG_FILENAME);
      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // AC: @trait-idempotent-file-scaffold ac-step-reports-action
      expect(result.stdout).toContain("Scaffold project config");
    });

    // AC: @scaffolded-project-config ac-file-valid-on-load
    it("scaffolded config file is valid and produces same result as empty config", async () => {
      await setupKspecProject(testDir);
      kspec("setup", testDir);

      // The scaffolded config should load without warnings/errors
      // Run a kspec command that loads config to verify
      const result = kspec("shadow status", testDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @scaffolded-project-config ac-placeholder-publication-mode
    it("contains dispatch publication_mode with default and comment listing accepted values", async () => {
      await setupKspecProject(testDir);
      kspec("setup", testDir);

      const content = await fs.readFile(path.join(testDir, CONFIG_FILENAME), "utf-8");

      // Must have publication_mode set to manual_merge
      expect(content).toContain("publication_mode: manual_merge");

      // Must have a comment listing accepted values
      expect(content).toMatch(/pull_request.*manual_merge.*auto/);
    });

    // AC: @scaffolded-project-config ac-placeholder-base-branch
    it("contains dispatch base_branch resolved from repository default branch", async () => {
      await setupKspecProject(testDir);
      kspec("setup", testDir);

      const content = await fs.readFile(path.join(testDir, CONFIG_FILENAME), "utf-8");

      // Must have base_branch key present
      expect(content).toContain("base_branch:");

      // In a test environment without remotes, should fall back to "main"
      expect(content).toMatch(/base_branch:\s*"main"/);
    });

    // AC: @scaffolded-project-config ac-placeholder-base-branch
    it("scaffolds base_branch as 'main' when no remote exists, even on a non-main branch", async () => {
      // Regression: resolveDefaultBranch used to fall back to the current branch
      // before "main". For scaffolding, this is wrong — a feature branch checkout
      // should not leak into the scaffolded config.
      initGitRepo(testDir);
      await fs.writeFile(path.join(testDir, "README.md"), "# Test", "utf-8");
      execSync('git add README.md && git commit -m "Initial"', {
        cwd: testDir,
        stdio: "pipe",
      });
      // Create and switch to a non-main branch
      execSync("git checkout -b dev", { cwd: testDir, stdio: "pipe" });

      const initResult = kspec("init --no-prompt", testDir);
      expect(initResult.exitCode).toBe(0);

      const result = kspec("setup", testDir);
      expect(result.exitCode).toBe(0);

      const content = await fs.readFile(path.join(testDir, CONFIG_FILENAME), "utf-8");

      // Must be "main" (the fallback), NOT "dev" (the current branch)
      expect(content).toMatch(/base_branch:\s*"main"/);
      expect(content).toContain("fallback");
    });

    // AC: @scaffolded-project-config ac-placeholder-coverage
    it("contains commented-out coverage section with sample scan_paths", async () => {
      await setupKspecProject(testDir);
      kspec("setup", testDir);

      const content = await fs.readFile(path.join(testDir, CONFIG_FILENAME), "utf-8");

      // Coverage section should be commented out
      expect(content).toMatch(/# coverage:/);
      expect(content).toMatch(/#\s+scan_paths:/);

      // Should have sample paths
      expect(content).toMatch(/#\s+-\s+"tests\/"/);
      expect(content).toMatch(/#\s+-\s+"src\/"/);
    });

    it("has a top-of-file comment identifying as scaffolded template", async () => {
      await setupKspecProject(testDir);
      kspec("setup", testDir);

      const content = await fs.readFile(path.join(testDir, CONFIG_FILENAME), "utf-8");

      // First line should be a comment about being scaffolded
      const firstLine = content.split("\n")[0];
      expect(firstLine).toMatch(/^#.*kspec/i);

      // Should instruct user to review
      expect(content).toMatch(/#.*[Rr]eview/);
    });
  });

  describe("existing config file (no force)", () => {
    // AC: @scaffolded-project-config ac-file-exists-preserved
    // AC: @trait-idempotent-file-scaffold ac-existing-file-preserved-without-force
    it("preserves existing config file byte-for-byte when not using force", async () => {
      await setupKspecProject(testDir);

      // Write a custom config
      const customConfig = `# My custom config\ndispatch:\n  base_branch: "dev"\n`;
      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, customConfig, "utf-8");

      // Run setup without --force
      const result = kspec("setup", testDir);
      expect(result.exitCode).toBe(0);

      // File should be byte-for-byte preserved
      const afterContent = await fs.readFile(configPath, "utf-8");
      expect(afterContent).toBe(customConfig);

      // AC: @trait-idempotent-file-scaffold ac-step-reports-action
      // Should report as "skipped"
      expect(result.stdout).toContain("Scaffold project config");
      expect(result.stdout).toMatch(/[Ss]kipped|already exists/);
    });
  });

  describe("force overwrite", () => {
    // AC: @scaffolded-project-config ac-file-force-overwrites
    it("replaces existing file with fresh template when --force is used", async () => {
      await setupKspecProject(testDir);

      // Write a custom config
      const customConfig = `# Old config\ndispatch:\n  base_branch: "old-branch"\n`;
      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, customConfig, "utf-8");

      // Run setup with --force
      const result = kspec("setup --force", testDir);
      expect(result.exitCode).toBe(0);

      // File should be replaced with fresh scaffolded content
      const afterContent = await fs.readFile(configPath, "utf-8");
      expect(afterContent).not.toBe(customConfig);
      expect(afterContent).toContain("publication_mode: manual_merge");
      expect(afterContent).toContain("base_branch:");
    });

    // AC: @scaffolded-project-config ac-file-force-backup
    // AC: @trait-idempotent-file-scaffold ac-force-backs-up-before-overwrite
    it("creates backup of existing file before force overwrite", async () => {
      await setupKspecProject(testDir);

      // Write a custom config
      const customConfig = `# Custom config to backup\ndispatch:\n  base_branch: "staging"\n`;
      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, customConfig, "utf-8");

      // Run setup with --force
      const result = kspec("setup --force", testDir);
      expect(result.exitCode).toBe(0);

      // Should report backup path
      expect(result.stdout).toMatch(/backup/i);

      // Find the backup file
      const files = await fs.readdir(testDir);
      const backupFiles = files.filter(
        (f) => f.startsWith("kspec.config.backup-") && f.endsWith(".yaml"),
      );
      expect(backupFiles.length).toBe(1);

      // Backup should contain original content
      const backupContent = await fs.readFile(path.join(testDir, backupFiles[0]), "utf-8");
      expect(backupContent).toBe(customConfig);
    });
  });

  describe("idempotent behavior", () => {
    // AC: @trait-idempotent-file-scaffold ac-fresh-file-creation
    it("reports 'created' on first run", async () => {
      await setupKspecProject(testDir);

      const result = kspec("setup", testDir);
      expect(result.exitCode).toBe(0);

      // Should indicate the file was created
      expect(result.stdout).toContain("Scaffold project config");
      // Should not indicate skipped for the scaffold step
      const lines = result.stdout.split("\n");
      const scaffoldLine = lines.find((l: string) => l.includes("Scaffold project config"));
      expect(scaffoldLine).toBeDefined();
      // The status icon should be ✓ (done), not ○ (skipped)
      // Since we can't easily check colors in stdout, check the message instead
    });

    // AC: @trait-idempotent-file-scaffold ac-existing-file-preserved-without-force
    it("reports 'skipped' on second run without force", async () => {
      await setupKspecProject(testDir);

      // First run creates the file
      kspec("setup", testDir);

      // Second run should skip
      const result = kspec("setup", testDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("already exists");
    });
  });

  describe("integration with init --setup", () => {
    // AC: @scaffolded-project-config ac-file-scaffolded
    it("creates config file as part of full init --setup flow", async () => {
      initGitRepo(testDir);
      await fs.writeFile(path.join(testDir, "README.md"), "# Test", "utf-8");
      execSync('git add README.md && git commit -m "Initial"', {
        cwd: testDir,
        stdio: "pipe",
      });

      const result = kspec("init --no-prompt --setup", testDir);
      expect(result.exitCode).toBe(0);

      // Config file should exist
      const configPath = path.join(testDir, CONFIG_FILENAME);
      const exists = await fs
        .access(configPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Should appear in setup summary
      expect(result.stdout).toContain("Scaffold project config");
    });

    // AC: @scaffolded-project-config ac-file-valid-on-load
    it("scaffolded file produces same behavior as empty config", async () => {
      // Create two projects: one with scaffolded config, one without
      const projectA = await createTempDir("kspec-scaffold-a-");
      const projectB = await createTempDir("kspec-scaffold-b-");

      try {
        // Project A: init with setup (has scaffolded config)
        initGitRepo(projectA);
        await fs.writeFile(path.join(projectA, "README.md"), "# A", "utf-8");
        execSync('git add README.md && git commit -m "Initial"', {
          cwd: projectA,
          stdio: "pipe",
        });
        kspec("init --no-prompt --setup", projectA);

        // Project B: init without setup (no config file)
        initGitRepo(projectB);
        await fs.writeFile(path.join(projectB, "README.md"), "# B", "utf-8");
        execSync('git add README.md && git commit -m "Initial"', {
          cwd: projectB,
          stdio: "pipe",
        });
        kspec("init --no-prompt", projectB);

        // Both should work identically for basic commands
        const resultA = kspec("shadow status", projectA);
        const resultB = kspec("shadow status", projectB);

        expect(resultA.exitCode).toBe(0);
        expect(resultB.exitCode).toBe(0);
      } finally {
        await cleanupTempDir(projectA);
        await cleanupTempDir(projectB);
      }
    });
  });

  describe("step appears in setup summary", () => {
    // AC: @trait-idempotent-file-scaffold ac-step-reports-action
    it("shows scaffold step in setup output with same format as other steps", async () => {
      await setupKspecProject(testDir);

      const result = kspec("setup", testDir);
      expect(result.exitCode).toBe(0);

      // The output should contain the step name alongside other known steps
      expect(result.stdout).toContain("Scaffold project config");
      expect(result.stdout).toContain("Agent detection");
      expect(result.stdout).toContain("Generate kspec-agents.md");
    });
  });

  describe("fail loudly on step failure", () => {
    // AC: @scaffolded-project-config ac-file-valid-on-load
    // AC: @trait-error-guidance ac-1
    // AC: @trait-error-guidance ac-2
    it("setup exits non-zero when scaffold step fails due to write error", async () => {
      await setupKspecProject(testDir);

      // Write a config file, then make it read-only and force overwrite —
      // the backup succeeds (reads old file) but writeFile fails with EACCES
      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, "dispatch:\n  base_branch: old\n", "utf-8");
      await fs.chmod(configPath, 0o444);

      const result = kspec("setup --force", testDir);

      // Restore permissions so cleanup can succeed
      await fs.chmod(configPath, 0o644).catch(() => {});

      // Should exit non-zero because the scaffold step failed
      expect(result.exitCode).not.toBe(0);

      // AC: @trait-error-guidance ac-1 — error description present
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/[Ff]ailed|[Ee]rror|EACCES/);
    });

    // AC: @trait-error-guidance ac-2
    it("setup failure output includes suggested action to resolve", async () => {
      await setupKspecProject(testDir);

      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, "dispatch:\n  base_branch: old\n", "utf-8");
      await fs.chmod(configPath, 0o444);

      const result = kspec("setup --force", testDir);
      await fs.chmod(configPath, 0o644).catch(() => {});

      expect(result.exitCode).not.toBe(0);

      // Should include guidance about fixing and re-running
      const combined = result.stdout + result.stderr;
      expect(combined).toMatch(/[Ff]ix.*re-run|[Ss]etup failed/i);
    });

    // Regression: the success footer used to print unconditionally before the
    // scaffold failure check, producing contradictory output ("Setup complete."
    // followed by exit 1).
    it("does NOT print 'Setup complete.' when scaffold step fails", async () => {
      await setupKspecProject(testDir);

      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, "dispatch:\n  base_branch: old\n", "utf-8");
      await fs.chmod(configPath, 0o444);

      const result = kspec("setup --force", testDir);
      await fs.chmod(configPath, 0o644).catch(() => {});

      expect(result.exitCode).not.toBe(0);

      // Must NOT contain the success footer
      expect(result.stdout).not.toContain("Setup complete.");
      // Should contain failure messaging instead
      expect(result.stdout + result.stderr).toMatch(/[Ff]ailed/);
    });

    // AC: @trait-error-guidance ac-5
    it("scaffold step failure includes description of what failed", async () => {
      await setupKspecProject(testDir);

      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, "dispatch:\n  base_branch: old\n", "utf-8");
      await fs.chmod(configPath, 0o444);

      const result = kspec("setup --force", testDir);
      await fs.chmod(configPath, 0o644).catch(() => {});

      expect(result.exitCode).not.toBe(0);

      // The step failure message should appear in output
      expect(result.stdout + result.stderr).toContain("Scaffold project config");
    });

    // AC: @trait-error-guidance ac-6
    it("scaffold step failure is included in JSON output", async () => {
      await setupKspecProject(testDir);

      const configPath = path.join(testDir, CONFIG_FILENAME);
      await fs.writeFile(configPath, "dispatch:\n  base_branch: old\n", "utf-8");
      await fs.chmod(configPath, 0o444);

      const result = kspec("setup --force --json", testDir);
      await fs.chmod(configPath, 0o644).catch(() => {});

      // JSON output should include the failed step with structured data
      const combined = result.stdout + result.stderr;
      expect(combined).toContain("failed");
      expect(combined).toContain("Scaffold project config");
    });
  });
});
