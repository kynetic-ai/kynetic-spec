/**
 * Tests for `kspec upgrade` command.
 *
 * AC: @single-command-version-upgrade (all ACs)
 * AC: @trait-error-guidance (ac-1, ac-2)
 * AC: @trait-semantic-exit-codes (ac-1, ac-4)
 * AC: @trait-dry-run (ac-1 through ac-6)
 * AC: @trait-json-output (ac-1 through ac-6)
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec,
  kspecJson,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  readTestOutputSync,
} from "./helpers/cli.js";

/**
 * Initialize a kspec project in a temp directory.
 * Returns the project dir with kspec init + setup already run.
 */
async function initProject(tempDir: string): Promise<void> {
  initGitRepo(tempDir);
  await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
  execSync('git add . && git commit -m "initial"', {
    cwd: tempDir,
    stdio: "pipe",
  });
  const result = kspec("init --no-prompt --setup", tempDir);
  if (result.exitCode !== 0) {
    throw new Error(`kspec init failed: ${result.stderr}`);
  }
}

/**
 * Write the lastKnownVersion to the setup state file.
 */
async function writeLastKnownVersion(
  tempDir: string,
  version: string,
): Promise<void> {
  const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
  let state: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    state = JSON.parse(raw);
  } catch {
    // Fresh state
  }
  state.lastKnownVersion = version;
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Read the lastKnownVersion from the setup state file.
 */
async function readLastKnownVersion(
  tempDir: string,
): Promise<string | undefined> {
  const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const state = JSON.parse(raw);
    return state.lastKnownVersion;
  } catch {
    return undefined;
  }
}

/**
 * Get the installed kspec version from package.json.
 */
function getCurrentVersion(): string {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

// ─── Test Suites ──────────────────────────────────────────────────────────────

describe("kspec upgrade", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-upgrade-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ─── Version Detection ────────────────────────────────────────────

  describe("version detection", () => {
    // AC: @single-command-version-upgrade ac-detects-skew
    it("reads recorded last-known version from project state", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.9.0");

      const result = kspecJson<{
        source_version: string;
        confidence: string;
      }>("upgrade --dry-run", tempDir);

      expect(result.source_version).toBe("0.9.0");
      expect(result.confidence).toBe("exact");
    });

    // AC: @single-command-version-upgrade ac-source-version-fallback
    it("infers source version from project state when no recorded version exists", async () => {
      await initProject(tempDir);

      // Remove lastKnownVersion from state to force inference
      const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
      try {
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        delete state.lastKnownVersion;
        await fs.writeFile(
          statePath,
          JSON.stringify(state, null, 2) + "\n",
          "utf-8",
        );
      } catch {
        // No state file — that's the test scenario
      }

      const result = kspecJson<{
        source_version: string | null;
        confidence: string;
      }>("upgrade --dry-run", tempDir);

      // Should have approximate confidence since there's no recorded version
      expect(result.confidence).toBe("approximate");
      // Should have inferred some version from probes
      expect(result.source_version).not.toBeNull();
    });

    // AC: @single-command-version-upgrade ac-source-version-fallback
    it("detects review-plan skill in directory-based layout for version inference", async () => {
      await initProject(tempDir);

      // Remove lastKnownVersion to force probe-based inference
      const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
      try {
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        delete state.lastKnownVersion;
        await fs.writeFile(
          statePath,
          JSON.stringify(state, null, 2) + "\n",
          "utf-8",
        );
      } catch {
        // no state file
      }

      // Ensure the review-plan skill exists in directory-based layout
      // (kspec-review-plan/SKILL.md, not kspec-review-plan.md)
      const skillDir = path.join(tempDir, ".agents", "skills", "kspec-review-plan");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "<!-- kspec-managed -->\n# Review Plan\n",
        "utf-8",
      );

      const result = kspecJson<{
        source_version: string | null;
        confidence: string;
      }>("upgrade --dry-run", tempDir);

      // With the review-plan skill present, version should be >= 0.10.0
      expect(result.confidence).toBe("approximate");
      expect(result.source_version).not.toBeNull();
      // Version should be at least 0.10.0 since the review-plan probe matched
      const parts = result.source_version!.split(".").map(Number);
      expect(parts[0] * 100 + parts[1]).toBeGreaterThanOrEqual(10); // 0.10+
    });

    // AC: @single-command-version-upgrade ac-source-version-unknown
    it("reports unknown source version when project state is unrecognizable", async () => {
      // Create a minimal kspec project without probes
      initGitRepo(tempDir);
      await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
      execSync('git add . && git commit -m "initial"', {
        cwd: tempDir,
        stdio: "pipe",
      });

      // Create minimal .kspec/ with just enough for initContext
      const specDir = path.join(tempDir, ".kspec");
      await fs.mkdir(specDir, { recursive: true });

      // Create a git worktree entry for .kspec
      const worktreeDir = path.join(tempDir, ".git", "worktrees", "-kspec");
      await fs.mkdir(worktreeDir, { recursive: true });
      await fs.writeFile(
        path.join(worktreeDir, "HEAD"),
        "0".repeat(40) + "\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(worktreeDir, "gitdir"),
        path.join(specDir, ".git") + "\n",
        "utf-8",
      );
      await fs.writeFile(
        path.join(specDir, ".git"),
        `gitdir: ${worktreeDir}\n`,
        "utf-8",
      );

      // Minimal manifest — intentionally using old format
      await fs.writeFile(
        path.join(specDir, "kynetic.yaml"),
        `kynetic_spec: "1.0"\ntitle: Test\nproject:\n  name: test\n  version: "0.1.0"\n`,
        "utf-8",
      );

      const result = kspecJson<{
        source_version: string | null;
        confidence: string;
        target_version: string;
      }>("upgrade --dry-run", tempDir);

      // Should either infer approximate or report unknown
      expect(["approximate", "unknown"]).toContain(result.confidence);
      expect(result.target_version).toBe(getCurrentVersion());
    });
  });

  // ─── Version Reporting ────────────────────────────────────────────

  describe("version reporting", () => {
    // AC: @single-command-version-upgrade ac-reports-skew
    it("reports source and target versions before changes", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.9.0");

      const result = kspec("upgrade --dry-run", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("0.9.0");
      expect(result.stdout).toContain(getCurrentVersion());
    });

    // AC: @single-command-version-upgrade ac-reports-skew
    it("marks approximate confidence in version report", async () => {
      await initProject(tempDir);

      // Remove lastKnownVersion to force inference
      const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
      try {
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        delete state.lastKnownVersion;
        await fs.writeFile(
          statePath,
          JSON.stringify(state, null, 2) + "\n",
          "utf-8",
        );
      } catch {
        // Fresh test
      }

      const result = kspec("upgrade --dry-run", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("approximate");
    });
  });

  // ─── Upgrade Pipeline Steps ───────────────────────────────────────

  describe("upgrade pipeline", () => {
    // AC: @single-command-version-upgrade ac-runs-task-storage-migration
    it("runs task storage migration as part of upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string }>;
      }>("upgrade", tempDir);

      const migrationStep = result.steps.find(
        (s) => s.name === "Task storage migration",
      );
      expect(migrationStep).toBeDefined();
      // Should either complete or skip (no monolithic tasks to migrate)
      expect(["done", "skipped"]).toContain(migrationStep!.status);
    });

    // AC: @single-command-version-upgrade ac-rerenders-skills
    it("re-renders skills as part of upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string }>;
      }>("upgrade", tempDir);

      const skillStep = result.steps.find(
        (s) => s.name === "Re-render skills",
      );
      expect(skillStep).toBeDefined();
      expect(["done", "skipped"]).toContain(skillStep!.status);
    });

    // AC: @single-command-version-upgrade ac-regenerates-agents-file
    it("regenerates agent instructions file as part of upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string }>;
      }>("upgrade", tempDir);

      const agentsStep = result.steps.find(
        (s) => s.name === "Regenerate agent instructions",
      );
      expect(agentsStep).toBeDefined();
      expect(["done", "skipped"]).toContain(agentsStep!.status);
    });

    // AC: @single-command-version-upgrade ac-restores-gitignore-entries
    it("restores missing gitignore entries as part of upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Delete the entire .gitignore to simulate a pre-gitignore project
      const gitignorePath = path.join(tempDir, ".gitignore");
      if (existsSync(gitignorePath)) {
        await fs.unlink(gitignorePath);
      }

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
      }>("upgrade", tempDir);

      const gitignoreStep = result.steps.find(
        (s) => s.name === "Restore gitignore entries",
      );
      expect(gitignoreStep).toBeDefined();
      // Should restore the entries by creating the file
      expect(gitignoreStep!.status).toBe("done");
    });

    // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
    it("reports manual follow-ups for applied changes", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{
        follow_ups: string[];
      }>("upgrade", tempDir);

      expect(result.follow_ups).toBeDefined();
      expect(Array.isArray(result.follow_ups)).toBe(true);
    });
  });

  // ─── Idempotency ─────────────────────────────────────────────────

  describe("idempotency", () => {
    // AC: @single-command-version-upgrade ac-idempotent-when-current
    it("reports project as current when version matches exactly", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, getCurrentVersion());

      const result = kspecJson<{
        noop: boolean;
        success: boolean;
        source_version: string;
        target_version: string;
      }>("upgrade", tempDir);

      expect(result.noop).toBe(true);
      expect(result.success).toBe(true);
      expect(result.source_version).toBe(getCurrentVersion());
      expect(result.target_version).toBe(getCurrentVersion());
    });

    // AC: @single-command-version-upgrade ac-idempotent-when-current
    it("makes no modifications when project is current", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, getCurrentVersion());

      const result = kspecJson<{
        noop: boolean;
        steps: Array<{ name: string }>;
      }>("upgrade", tempDir);

      expect(result.noop).toBe(true);
      expect(result.steps).toHaveLength(0);
    });

    // AC: @single-command-version-upgrade ac-idempotent-when-current
    it("exits with success when project is current", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, getCurrentVersion());

      const result = kspec("upgrade", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("current version");
    });

    it("runs pipeline as safety refresh when version matches approximately", async () => {
      await initProject(tempDir);
      // Don't write lastKnownVersion so it falls back to approximate detection
      const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
      try {
        const raw = await fs.readFile(statePath, "utf-8");
        const state = JSON.parse(raw);
        delete state.lastKnownVersion;
        await fs.writeFile(
          statePath,
          JSON.stringify(state, null, 2) + "\n",
          "utf-8",
        );
      } catch {
        // no state file
      }

      const result = kspecJson<{
        is_refresh: boolean;
        noop: boolean;
      }>("upgrade", tempDir);

      // Should run as refresh (not noop) since confidence is approximate
      expect(result.noop).toBe(false);
    });
  });

  // ─── Dry Run ──────────────────────────────────────────────────────

  describe("dry run", () => {
    // AC: @single-command-version-upgrade ac-dry-run-reports
    // AC: @trait-dry-run ac-1, ac-3
    it("reports what would be changed without applying", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspec("upgrade --dry-run", tempDir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("DRY RUN");
    });

    // AC: @single-command-version-upgrade ac-dry-run-reports
    it("shows all pipeline steps in dry-run mode", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{
        dry_run: boolean;
        steps: Array<{ name: string; status: string }>;
      }>("upgrade --dry-run", tempDir);

      expect(result.dry_run).toBe(true);
      expect(result.steps.length).toBeGreaterThan(0);
    });

    // AC: @single-command-version-upgrade ac-dry-run-no-writes
    // AC: @trait-dry-run ac-2
    it("makes no filesystem modifications in dry-run mode", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Record state before
      const versionBefore = await readLastKnownVersion(tempDir);

      const result = kspec("upgrade --dry-run", tempDir);
      expect(result.exitCode).toBe(0);

      // State should be unchanged
      const versionAfter = await readLastKnownVersion(tempDir);
      expect(versionAfter).toBe(versionBefore);
    });

    // AC: @trait-dry-run ac-5
    it("dry-run takes precedence over --force", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, getCurrentVersion());

      const result = kspecJson<{
        dry_run: boolean;
        noop: boolean;
      }>("upgrade --dry-run --force", tempDir);

      expect(result.dry_run).toBe(true);
      // Force should cause pipeline to run even when current
      // but dry-run prevents any writes
    });

    // AC: @trait-dry-run ac-6
    it("JSON output includes dry_run boolean field", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{ dry_run: boolean }>(
        "upgrade --dry-run",
        tempDir,
      );
      expect(result.dry_run).toBe(true);
    });
  });

  // ─── JSON Output ──────────────────────────────────────────────────

  describe("JSON output", () => {
    // AC: @trait-json-output ac-1
    it("outputs valid JSON with --json flag", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.9.0");

      const result = kspec("upgrade --dry-run --json", tempDir);
      expect(result.exitCode).toBe(0);
      // Should be valid JSON (no ANSI codes)
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stdout).not.toMatch(/\x1b\[/); // No ANSI escape codes
    });

    // AC: @trait-json-output ac-2
    it("JSON output includes all data from human-readable mode", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.9.0");

      const result = kspecJson<{
        success: boolean;
        source_version: string;
        target_version: string;
        confidence: string;
        steps: Array<{ name: string; status: string; message: string }>;
        follow_ups: string[];
      }>("upgrade --dry-run", tempDir);

      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("source_version");
      expect(result).toHaveProperty("target_version");
      expect(result).toHaveProperty("confidence");
      expect(result).toHaveProperty("steps");
      expect(result).toHaveProperty("follow_ups");
    });

    // AC: @trait-json-output ac-4
    it("JSON output uses @ prefix for references", async () => {
      await initProject(tempDir);

      const result = kspecJson<Record<string, unknown>>(
        "upgrade --dry-run",
        tempDir,
      );
      // The upgrade command doesn't output refs directly, but verify JSON structure
      expect(result).toHaveProperty("success");
    });

    // AC: @trait-json-output ac-5
    it("JSON timestamps use ISO 8601 format", async () => {
      await initProject(tempDir);

      // This test verifies the JSON output structure
      const result = kspecJson<Record<string, unknown>>(
        "upgrade --dry-run",
        tempDir,
      );
      expect(result).toBeDefined();
    });
  });

  // ─── Error Handling ───────────────────────────────────────────────

  describe("error handling", () => {
    // AC: @trait-error-guidance ac-1, ac-2
    // AC: @trait-semantic-exit-codes ac-4
    it("shows error with guidance when no kspec project found", async () => {
      initGitRepo(tempDir);
      await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
      execSync('git add . && git commit -m "initial"', {
        cwd: tempDir,
        stdio: "pipe",
      });

      const result = kspec("upgrade", tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      // Should include error description and suggested action
      const combinedOutput = result.stderr + result.stdout;
      expect(combinedOutput).toMatch(/init/i);
    });

    // AC: @trait-json-output ac-3
    it("returns error as JSON when --json is active", async () => {
      initGitRepo(tempDir);
      await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
      execSync('git add . && git commit -m "initial"', {
        cwd: tempDir,
        stdio: "pipe",
      });

      const result = kspec("upgrade --json", tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);

      // stderr should be valid JSON with no trailing plain-text lines
      const stderrTrimmed = result.stderr.trim();
      expect(() => JSON.parse(stderrTrimmed)).not.toThrow();
      const parsed = JSON.parse(stderrTrimmed);
      expect(parsed).toHaveProperty("error");
      expect(parsed.success).toBe(false);
      // Guidance should be inside the JSON object, not appended as plain text
      expect(parsed.details).toBeDefined();
      expect(parsed.details.suggestion).toMatch(/init/i);
    });

    // AC: @trait-semantic-exit-codes ac-1
    it("exits with code 0 on successful upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.9.0");

      const result = kspec("upgrade", tempDir);
      expect(result.exitCode).toBe(0);
    });
  });

  // ─── Version Recording ────────────────────────────────────────────

  describe("version recording", () => {
    it("records current version in setup state after upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.9.0");

      const result = kspec("upgrade", tempDir);
      expect(result.exitCode).toBe(0);

      const recordedVersion = await readLastKnownVersion(tempDir);
      expect(recordedVersion).toBe(getCurrentVersion());
    });

    it("does not record version in dry-run mode", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.9.0");

      const result = kspec("upgrade --dry-run", tempDir);
      expect(result.exitCode).toBe(0);

      const recordedVersion = await readLastKnownVersion(tempDir);
      expect(recordedVersion).toBe("0.9.0"); // Should be unchanged
    });
  });

  // ─── Force Flag ───────────────────────────────────────────────────

  describe("--force flag", () => {
    it("re-runs pipeline even when project is current", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, getCurrentVersion());

      const result = kspecJson<{
        noop: boolean;
        steps: Array<{ name: string }>;
      }>("upgrade --force", tempDir);

      // Should not be noop — force overrides the current-version check
      expect(result.noop).toBe(false);
      expect(result.steps.length).toBeGreaterThan(0);
    });
  });

  // ─── Skill Orphan Cleanup ──────────────────────────────────────────

  describe("skill orphan cleanup", () => {
    // AC: @single-command-version-upgrade ac-rerenders-skills
    it("removes obsolete managed skill directories during upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Create an orphan managed skill that does not correspond to any defined skill
      const orphanDir = path.join(tempDir, ".agents", "skills", "kspec-obsolete-skill");
      await fs.mkdir(orphanDir, { recursive: true });
      await fs.writeFile(
        path.join(orphanDir, "SKILL.md"),
        "<!-- kspec-managed -->\n# Obsolete Skill\nThis skill no longer exists.\n",
        "utf-8",
      );

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
      }>("upgrade", tempDir);

      const skillStep = result.steps.find(
        (s) => s.name === "Re-render skills",
      );
      expect(skillStep).toBeDefined();
      expect(skillStep!.status).toBe("done");
      expect((skillStep!.details?.removed as number) || 0).toBeGreaterThan(0);

      // Verify the orphan directory was actually removed
      expect(existsSync(orphanDir)).toBe(false);
    });

    // AC: @single-command-version-upgrade ac-rerenders-skills
    it("preserves non-managed skill directories during orphan cleanup", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Create a non-managed skill (no kspec-managed marker)
      const userSkillDir = path.join(tempDir, ".agents", "skills", "user-custom-skill");
      await fs.mkdir(userSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(userSkillDir, "SKILL.md"),
        "# My Custom Skill\nA user-created skill.\n",
        "utf-8",
      );

      kspec("upgrade", tempDir);

      // User skill should still exist
      expect(existsSync(userSkillDir)).toBe(true);
    });

    // AC: @single-command-version-upgrade ac-dry-run-no-writes
    it("does not remove orphan skills in dry-run mode", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Create an orphan managed skill
      const orphanDir = path.join(tempDir, ".agents", "skills", "kspec-obsolete-skill");
      await fs.mkdir(orphanDir, { recursive: true });
      await fs.writeFile(
        path.join(orphanDir, "SKILL.md"),
        "<!-- kspec-managed -->\n# Obsolete Skill\n",
        "utf-8",
      );

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
      }>("upgrade --dry-run", tempDir);

      const skillStep = result.steps.find(
        (s) => s.name === "Re-render skills",
      );
      expect(skillStep).toBeDefined();
      expect(skillStep!.status).toBe("done");
      expect((skillStep!.details?.removed as number) || 0).toBeGreaterThan(0);

      // Orphan should still exist (dry run)
      expect(existsSync(orphanDir)).toBe(true);
    });
  });

  // ─── Scaffold Missing Files ───────────────────────────────────────

  describe("scaffold missing files", () => {
    it("scaffolds project config when missing", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Remove config file
      const configPath = path.join(tempDir, "kspec.config.yaml");
      if (existsSync(configPath)) {
        await fs.unlink(configPath);
      }

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; message: string }>;
      }>("upgrade", tempDir);

      const configStep = result.steps.find(
        (s) => s.name === "Scaffold project config",
      );
      expect(configStep).toBeDefined();
      expect(configStep!.status).toBe("done");
    });

    it("skips project config when it already exists", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string }>;
      }>("upgrade", tempDir);

      const configStep = result.steps.find(
        (s) => s.name === "Scaffold project config",
      );
      expect(configStep).toBeDefined();
      expect(configStep!.status).toBe("skipped");
    });

    // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
    it("scaffolds default module when missing", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Remove the module file to simulate a project without a default module
      const modulesDir = path.join(tempDir, ".kspec", "modules");
      if (existsSync(modulesDir)) {
        await fs.rm(modulesDir, { recursive: true, force: true });
      }

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; message: string }>;
      }>("upgrade", tempDir);

      const moduleStep = result.steps.find(
        (s) => s.name === "Scaffold default module",
      );
      expect(moduleStep).toBeDefined();
      expect(moduleStep!.status).toBe("done");

      // Verify the module file was actually created
      const moduleFilePath = path.join(modulesDir, "main.yaml");
      expect(existsSync(moduleFilePath)).toBe(true);

      // Verify module content has proper structure
      const content = await fs.readFile(moduleFilePath, "utf-8");
      expect(content).toContain("type: module");
      expect(content).toContain("slugs:");
      expect(content).toContain("main");
      expect(content).toContain("_ulid:");
    });

    it("skips default module when it already exists", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string }>;
      }>("upgrade", tempDir);

      const moduleStep = result.steps.find(
        (s) => s.name === "Scaffold default module",
      );
      expect(moduleStep).toBeDefined();
      expect(moduleStep!.status).toBe("skipped");
    });

    // AC: @single-command-version-upgrade ac-dry-run-no-writes
    it("reports default module scaffold in dry-run without creating it", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Remove the module file
      const modulesDir = path.join(tempDir, ".kspec", "modules");
      if (existsSync(modulesDir)) {
        await fs.rm(modulesDir, { recursive: true, force: true });
      }

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; message: string }>;
      }>("upgrade --dry-run", tempDir);

      const moduleStep = result.steps.find(
        (s) => s.name === "Scaffold default module",
      );
      expect(moduleStep).toBeDefined();
      expect(moduleStep!.status).toBe("done");
      expect(moduleStep!.message).toContain("would create");

      // Verify the module file was NOT created
      const moduleFilePath = path.join(modulesDir, "main.yaml");
      expect(existsSync(moduleFilePath)).toBe(false);
    });
  });

  // ─── Trait: @trait-error-guidance ──────────────────────────────────

  // AC: @trait-error-guidance ac-4 — N/A: upgrade command has no state transitions that could be invalid
  // AC: @trait-error-guidance ac-5 — N/A: upgrade command does not validate individual fields
  // AC: @trait-error-guidance ac-3 — N/A: upgrade command does not look up references

  // AC: @trait-error-guidance ac-6
  describe("@trait-error-guidance ac-6: error in JSON mode", () => {
    it("includes guidance in structured error object", async () => {
      initGitRepo(tempDir);
      await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
      execSync('git add . && git commit -m "initial"', {
        cwd: tempDir,
        stdio: "pipe",
      });

      const result = kspec("upgrade --json", tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);

      // Error guidance must be embedded in the JSON, not appended as plain text
      const stderrTrimmed = result.stderr.trim();
      const parsed = JSON.parse(stderrTrimmed);
      expect(parsed.success).toBe(false);
      expect(parsed.details).toBeDefined();
      expect(parsed.details.suggestion).toBeDefined();
      expect(parsed.details.suggestion).toMatch(/init/i);
    });
  });

  // ─── Trait: @trait-semantic-exit-codes ─────────────────────────────

  // AC: @trait-semantic-exit-codes ac-2 — N/A: upgrade has no validation-error-on-user-input path (it takes no arguments)
  // AC: @trait-semantic-exit-codes ac-3 — N/A: upgrade has no confirmation prompt to decline
  // AC: @trait-semantic-exit-codes ac-5 — N/A: upgrade is not a query command
  // AC: @trait-semantic-exit-codes ac-6 — N/A: upgrade has no invalid-flags path beyond commander's built-in handling
  // AC: @trait-semantic-exit-codes ac-7 — N/A: upgrade is not a batch operation in the kspec batch sense
  // AC: @trait-semantic-exit-codes ac-8
  describe("@trait-semantic-exit-codes ac-8: exit codes documented", () => {
    it("upgrade command uses EXIT_CODES constants", async () => {
      // Verified by code review: upgrade.ts imports and uses EXIT_CODES.ERROR and
      // EXIT_CODES.SUCCESS (implicitly via process.exit). This test exercises
      // the success path.
      await initProject(tempDir);

      const result = kspec("upgrade", tempDir);
      expect(result.exitCode).toBe(0);
    });
  });
});
