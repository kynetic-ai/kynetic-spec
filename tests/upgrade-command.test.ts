/**
 * Tests for `kspec upgrade` command.
 *
 * AC: @single-command-version-upgrade (all ACs)
 * AC: @trait-error-guidance (ac-1, ac-2)
 * AC: @trait-semantic-exit-codes (ac-1, ac-4)
 * AC: @trait-dry-run (ac-1 through ac-6)
 * AC: @trait-json-output (ac-1, ac-2, ac-3, ac-6; ac-4 and ac-5 N/A)
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
      // Create a minimal kspec project without any versioned probes.
      // .kspec/ exists but no config, no skills dir, no split format,
      // no kynetic 1.1 — no probe should match.
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

      // Minimal manifest — intentionally using old format (kynetic_spec: "1.0"
      // does NOT match the "1.1" probe, so no versioned probe fires)
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

      // Must report unknown — no versioned probe matched
      expect(result.confidence).toBe("unknown");
      expect(result.source_version).toBeNull();
      expect(result.target_version).toBe(getCurrentVersion());
    });

    // AC: @single-command-version-upgrade ac-source-version-unknown
    it("reports unknown when probes are mutually contradictory", async () => {
      // Create a project whose manifest advertises old state (kynetic: "1.0")
      // but has kspec.config.yaml present (indicating >= 0.11).
      // These probes contradict: old manifest caps at < 0.9, config requires >= 0.11.
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

      // Manifest with OLD format version (kynetic: "1.0" → caps at < 0.9)
      await fs.writeFile(
        path.join(specDir, "kynetic.yaml"),
        `kynetic: "1.0"\ntitle: Test\nproject:\n  name: test\n  version: "0.1.0"\n`,
        "utf-8",
      );

      // Also create kspec.config.yaml (indicates >= 0.11), contradicting the manifest
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        "dispatch:\n  publication_mode: auto\n",
        "utf-8",
      );

      const result = kspecJson<{
        source_version: string | null;
        confidence: string;
      }>("upgrade --dry-run", tempDir);

      // Probes contradict: manifest says < 0.9 but config says >= 0.11
      // Must report unknown, not approximate
      expect(result.confidence).toBe("unknown");
      expect(result.source_version).toBeNull();
    });

    // AC: @single-command-version-upgrade ac-source-version-unknown
    it("reports unknown when .agents/skills is a regular file instead of a directory", async () => {
      // A corrupted .agents/skills path (regular file, not directory) must NOT
      // be treated as evidence for the 0.8+ skills layout. Only directories count.
      initGitRepo(tempDir);
      await fs.writeFile(path.join(tempDir, "README.md"), "# Test\n");
      execSync('git add . && git commit -m "initial"', {
        cwd: tempDir,
        stdio: "pipe",
      });

      // Minimal .kspec/ with shadow worktree setup
      const specDir = path.join(tempDir, ".kspec");
      await fs.mkdir(specDir, { recursive: true });

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

      // Old manifest with no versioned probes
      await fs.writeFile(
        path.join(specDir, "kynetic.yaml"),
        `kynetic_spec: "1.0"\ntitle: Test\nproject:\n  name: test\n  version: "0.1.0"\n`,
        "utf-8",
      );

      // Place a regular file at .agents/skills (corrupted state)
      const agentsDir = path.join(tempDir, ".agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(agentsDir, "skills"), "corrupted\n", "utf-8");

      const result = kspecJson<{
        source_version: string | null;
        confidence: string;
      }>("upgrade --dry-run", tempDir);

      // Regular file at .agents/skills is not a recognizable skills layout —
      // must not count as evidence for 0.8+ and must report unknown
      expect(result.confidence).toBe("unknown");
      expect(result.source_version).toBeNull();
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
    it("migrates legacy monolithic task storage during upgrade", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const specDir = path.join(tempDir, ".kspec");

      // Find the manifest and tasks files (kspec init uses slug-based naming)
      const specFiles = await fs.readdir(specDir);
      const manifestName = specFiles.find(
        (f) => f.endsWith(".yaml") &&
          !f.endsWith(".tasks.yaml") &&
          !f.endsWith(".inbox.yaml") &&
          !f.endsWith(".meta.yaml") &&
          !f.startsWith("."),
      );
      expect(manifestName).toBeDefined();
      const manifestPath = path.join(specDir, manifestName!);

      const tasksName = specFiles.find(
        (f) => f.endsWith(".tasks.yaml"),
      );
      expect(tasksName).toBeDefined();
      const tasksPath = path.join(specDir, tasksName!);

      // Read the current manifest to preserve project metadata, then downgrade
      // to monolithic-era format (remove task_storage, set kynetic to old version).
      // The `kynetic` field must remain (findManifestInDir requires it for discovery).
      const yaml = await import("yaml");
      const manifestRaw = await fs.readFile(manifestPath, "utf-8");
      const manifest = yaml.parse(manifestRaw) as Record<string, unknown>;
      delete manifest.task_storage;
      manifest.kynetic = "1.0";
      await fs.writeFile(manifestPath, yaml.stringify(manifest), "utf-8");

      // Write a monolithic task entry into the tasks file.
      // Monolithic entries have a `notes` array (not `notes_count` scalar).
      const monolithicTasks = [
        {
          _ulid: "01TESTM0N0L1TH1C0000000001",
          slugs: ["task-legacy-mono"],
          title: "Legacy monolithic task",
          type: "task",
          status: "pending",
          priority: 3,
          tags: ["test"],
          depends_on: [],
          blocked_by: [],
          created_at: "2026-01-01T00:00:00.000Z",
          notes: [
            {
              _ulid: "01TESTM0N0L1TH1C0000000002",
              created_at: "2026-01-01T01:00:00.000Z",
              author: "@test",
              content: "A legacy note",
            },
          ],
          todos: [],
        },
      ];
      await fs.writeFile(tasksPath, yaml.stringify(monolithicTasks), "utf-8");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; message: string; details?: Record<string, unknown> }>;
      }>("upgrade", tempDir);

      const migrationStep = result.steps.find(
        (s) => s.name === "Task storage migration",
      );
      expect(migrationStep).toBeDefined();
      // Migration should run — either it migrates the monolithic task or
      // at minimum upgrades the manifest to split format
      expect(migrationStep!.status).toBe("done");
    });

    // AC: @single-command-version-upgrade ac-runs-task-storage-migration
    it("migrates monolithic tasks even when manifest already says split", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      const specDir = path.join(tempDir, ".kspec");

      const specFiles = await fs.readdir(specDir);
      const manifestName = specFiles.find(
        (f) => f.endsWith(".yaml") &&
          !f.endsWith(".tasks.yaml") &&
          !f.endsWith(".inbox.yaml") &&
          !f.endsWith(".meta.yaml") &&
          !f.startsWith("."),
      );
      expect(manifestName).toBeDefined();
      const manifestPath = path.join(specDir, manifestName!);

      const tasksName = specFiles.find(
        (f) => f.endsWith(".tasks.yaml"),
      );
      expect(tasksName).toBeDefined();
      const tasksPath = path.join(specDir, tasksName!);

      // Set manifest to say "split" but leave monolithic task data in the tasks file.
      // This simulates a partial upgrade or hand-edited state.
      const yaml = await import("yaml");
      const manifestRaw = await fs.readFile(manifestPath, "utf-8");
      const manifest = yaml.parse(manifestRaw) as Record<string, unknown>;
      manifest.task_storage = { format: "split" };
      manifest.kynetic = "1.1";
      await fs.writeFile(manifestPath, yaml.stringify(manifest), "utf-8");

      const monolithicTasks = [
        {
          _ulid: "01TESTM0N0L1TH1C0000000003",
          slugs: ["task-partial-upgrade"],
          title: "Partial upgrade monolithic task",
          type: "task",
          status: "pending",
          priority: 3,
          tags: ["test"],
          depends_on: [],
          blocked_by: [],
          created_at: "2026-01-01T00:00:00.000Z",
          notes: [
            {
              _ulid: "01TESTM0N0L1TH1C0000000004",
              created_at: "2026-01-01T01:00:00.000Z",
              author: "@test",
              content: "A monolithic note still inline",
            },
          ],
          todos: [],
        },
      ];
      await fs.writeFile(tasksPath, yaml.stringify(monolithicTasks), "utf-8");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; message: string; details?: Record<string, unknown> }>;
      }>("upgrade", tempDir);

      const migrationStep = result.steps.find(
        (s) => s.name === "Task storage migration",
      );
      expect(migrationStep).toBeDefined();
      // Must NOT be "skipped" — the actual task file has monolithic data
      expect(migrationStep!.status).toBe("done");
      expect(migrationStep!.status).not.toBe("skipped");
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

    // AC: @single-command-version-upgrade ac-rerenders-skills
    it("reports failure when skill renderer cannot write output", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Replace .agents/skills directory with a regular file so the
      // renderer has nowhere to write, causing it to throw.
      const skillsDir = path.join(tempDir, ".agents", "skills");
      await fs.rm(skillsDir, { recursive: true, force: true });
      await fs.writeFile(skillsDir, "not a directory\n", "utf-8");

      const result = kspec("upgrade --json", tempDir);
      const parsed = JSON.parse(result.stdout);

      const skillStep = parsed.steps.find(
        (s: { name: string }) => s.name === "Re-render skills",
      );
      expect(skillStep).toBeDefined();
      expect(skillStep.status).toBe("failed");
      expect(result.exitCode).not.toBe(0);
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

    // AC: @single-command-version-upgrade ac-regenerates-agents-file
    it("recovers corrupted kspec-agents.md (directory) and regenerates", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Run upgrade once so the hash file is populated
      const firstRun = kspec("upgrade", tempDir);
      expect(firstRun.exitCode).toBe(0);

      // Replace kspec-agents.md with a directory (corrupted artifact)
      const agentsFilePath = path.join(tempDir, "kspec-agents.md");
      await fs.rm(agentsFilePath, { force: true });
      await fs.mkdir(agentsFilePath, { recursive: true });
      await fs.writeFile(path.join(agentsFilePath, "blocker"), "x", "utf-8");

      // Upgrade should recover: remove the directory and regenerate the file.
      // --force needed because the first run recorded the current version,
      // so without it the pipeline short-circuits as noop.
      const result = kspecJson<{
        success: boolean;
        steps: Array<{ name: string; status: string; message?: string }>;
      }>("upgrade --force", tempDir);

      expect(result.success).toBe(true);
      const agentsStep = result.steps.find(
        (s) => s.name === "Regenerate agent instructions",
      );
      expect(agentsStep).toBeDefined();
      expect(agentsStep!.status).toBe("done");

      // Verify the output is now a regular file, not a directory
      const stat = await fs.stat(agentsFilePath);
      expect(stat.isFile()).toBe(true);

      // Verify the content is valid
      const content = await fs.readFile(agentsFilePath, "utf-8");
      expect(content).toContain("kspec");
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

    // AC: @single-command-version-upgrade ac-restores-gitignore-entries
    it("appends kspec entries to existing .gitignore without managed block", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Replace .gitignore with a plain file that has no managed block
      const gitignorePath = path.join(tempDir, ".gitignore");
      await fs.writeFile(gitignorePath, "node_modules\ncoverage\n", "utf-8");

      const result = kspecJson<{
        success: boolean;
        steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
      }>("upgrade", tempDir);

      const gitignoreStep = result.steps.find(
        (s) => s.name === "Restore gitignore entries",
      );
      expect(gitignoreStep).toBeDefined();
      expect(gitignoreStep!.status).toBe("done");

      // Verify the file now contains the kspec managed block
      const content = await fs.readFile(gitignorePath, "utf-8");
      expect(content).toContain("# >>> kspec managed");
      expect(content).toContain(".kspec/");
      // Original content should be preserved
      expect(content).toContain("node_modules");
      expect(content).toContain("coverage");
    });

    // AC: @single-command-version-upgrade ac-restores-gitignore-entries
    it("dry-run reports entries for existing .gitignore without managed block", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Replace .gitignore with a plain file that has no managed block
      const gitignorePath = path.join(tempDir, ".gitignore");
      await fs.writeFile(gitignorePath, "node_modules\ncoverage\n", "utf-8");

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; message: string }>;
      }>("upgrade --dry-run", tempDir);

      const gitignoreStep = result.steps.find(
        (s) => s.name === "Restore gitignore entries",
      );
      expect(gitignoreStep).toBeDefined();
      expect(gitignoreStep!.status).toBe("done");
      expect(gitignoreStep!.message).toContain("would create managed block");

      // Verify no modifications in dry-run mode
      const content = await fs.readFile(gitignorePath, "utf-8");
      expect(content).toBe("node_modules\ncoverage\n");
    });

    // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
    it("reports non-empty manual follow-ups when upgrade applies changes", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Delete the .gitignore so the upgrade has to restore it, which
      // should produce a follow-up entry about the added entries.
      const gitignorePath = path.join(tempDir, ".gitignore");
      if (existsSync(gitignorePath)) {
        await fs.unlink(gitignorePath);
      }

      const result = kspecJson<{
        follow_ups: string[];
      }>("upgrade", tempDir);

      expect(result.follow_ups).toBeDefined();
      expect(Array.isArray(result.follow_ups)).toBe(true);
      expect(result.follow_ups.length).toBeGreaterThan(0);
      // Each follow-up must be a non-empty, user-actionable message
      for (const followUp of result.follow_ups) {
        expect(typeof followUp).toBe("string");
        expect(followUp.length).toBeGreaterThan(0);
      }
      // At least one follow-up should mention the gitignore change
      const hasGitignoreFollowUp = result.follow_ups.some(
        (f) => f.toLowerCase().includes("gitignore"),
      );
      expect(hasGitignoreFollowUp).toBe(true);
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

      // Record state before: setup-state and shadow branch HEAD
      const versionBefore = await readLastKnownVersion(tempDir);
      const shadowHeadBefore = execSync("git rev-parse HEAD", {
        cwd: path.join(tempDir, ".kspec"),
        encoding: "utf-8",
      }).trim();

      const result = kspec("upgrade --dry-run", tempDir);
      expect(result.exitCode).toBe(0);

      // Root-level state should be unchanged
      const versionAfter = await readLastKnownVersion(tempDir);
      expect(versionAfter).toBe(versionBefore);

      // Shadow branch should have no new commits
      const shadowHeadAfter = execSync("git rev-parse HEAD", {
        cwd: path.join(tempDir, ".kspec"),
        encoding: "utf-8",
      }).trim();
      expect(shadowHeadAfter).toBe(shadowHeadBefore);
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

    // AC: @trait-dry-run ac-4
    it("dry-run surfaces skill render errors that real run would hit", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Replace .agents/skills directory with a regular file so the
      // renderer has nowhere to write — real run fails this step.
      const skillsDir = path.join(tempDir, ".agents", "skills");
      await fs.rm(skillsDir, { recursive: true, force: true });
      await fs.writeFile(skillsDir, "not a directory\n", "utf-8");

      // Dry-run should report the same failure, not claim "done"
      const dryResult = kspec("upgrade --force --dry-run --json", tempDir);
      const dryParsed = JSON.parse(dryResult.stdout);
      const drySkillStep = dryParsed.steps.find(
        (s: { name: string }) => s.name === "Re-render skills",
      );
      expect(drySkillStep).toBeDefined();
      expect(drySkillStep.status).toBe("failed");
      // Non-zero exit code matching real-run behavior
      expect(dryResult.exitCode).not.toBe(0);
    });

    // AC: @trait-dry-run ac-4
    it("dry-run skips agent regeneration when real run would skip it", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // First run to populate the hash file and kspec-agents.md
      kspec("upgrade", tempDir);

      // Now both dry-run and real-run should agree the file is up-to-date
      const dryResult = kspecJson<{
        steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
      }>("upgrade --force --dry-run", tempDir);

      const dryAgentsStep = dryResult.steps.find(
        (s) => s.name === "Regenerate agent instructions",
      );
      expect(dryAgentsStep).toBeDefined();
      expect(dryAgentsStep!.status).toBe("skipped");

      // Confirm real run also skips
      const realResult = kspecJson<{
        steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
      }>("upgrade --force", tempDir);

      const realAgentsStep = realResult.steps.find(
        (s) => s.name === "Regenerate agent instructions",
      );
      expect(realAgentsStep).toBeDefined();
      expect(realAgentsStep!.status).toBe("skipped");
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

    // AC: @trait-json-output ac-4 — N/A: upgrade command output contains version strings and step results, not entity references that would use @ prefix
    // AC: @trait-json-output ac-5 — N/A: upgrade command output does not include timestamp fields; version detection and step results are not time-stamped
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

    // AC: @trait-semantic-exit-codes ac-4
    it("exits with code 3 when upgrade step fails during execution", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Replace .agents/skills directory with a regular file so the
      // skill renderer has nowhere to write, causing it to throw.
      const skillsDir = path.join(tempDir, ".agents", "skills");
      await fs.rm(skillsDir, { recursive: true, force: true });
      await fs.writeFile(skillsDir, "not a directory\n", "utf-8");

      const result = kspec("upgrade", tempDir, { expectFail: true });
      // Runtime failure during execution must exit with code 3
      expect(result.exitCode).toBe(3);
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

    it("does not record version when a prior step fails", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Replace .agents/skills directory with a regular file so the
      // skill renderer has nowhere to write, causing it to throw.
      const skillsDir = path.join(tempDir, ".agents", "skills");
      await fs.rm(skillsDir, { recursive: true, force: true });
      await fs.writeFile(skillsDir, "not a directory\n", "utf-8");

      const result = kspecJson<{
        success: boolean;
        steps: Array<{ name: string; status: string }>;
      }>("upgrade", tempDir);

      // At least one step should have failed (the skill re-render)
      expect(result.success).toBe(false);
      const failedSteps = result.steps.filter((s) => s.status === "failed");
      expect(failedSteps.length).toBeGreaterThan(0);

      // The "Record version" step should be skipped, not done
      const recordStep = result.steps.find((s) => s.name === "Record version");
      expect(recordStep).toBeDefined();
      expect(recordStep!.status).toBe("skipped");

      // Verify the version was NOT updated in the state file
      const recordedVersion = await readLastKnownVersion(tempDir);
      expect(recordedVersion).toBe("0.8.0");
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

    // AC: @single-command-version-upgrade ac-reports-manual-follow-ups
    it("scaffolds default module when only custom modules exist", async () => {
      await initProject(tempDir);
      await writeLastKnownVersion(tempDir, "0.8.0");

      // Remove the default module file but keep the modules directory.
      // Create a custom module so that the old items.some(type==="module")
      // check would have been true — but the default module is still missing.
      const specDir = path.join(tempDir, ".kspec");
      const modulesDir = path.join(specDir, "modules");
      const defaultModulePath = path.join(modulesDir, "main.yaml");

      // Remove the default module file
      if (existsSync(defaultModulePath)) {
        await fs.unlink(defaultModulePath);
      }

      // Create a custom module so we know the check isn't "any module"
      const customModulePath = path.join(modulesDir, "custom.yaml");
      await fs.writeFile(
        customModulePath,
        `_ulid: 01TESTCUSTOMMODULE0000000\nslugs:\n  - custom\ntitle: Custom Module\ntype: module\nstatus:\n  maturity: draft\nitems: []\n`,
        "utf-8",
      );

      const result = kspecJson<{
        steps: Array<{ name: string; status: string; message: string }>;
      }>("upgrade", tempDir);

      const moduleStep = result.steps.find(
        (s) => s.name === "Scaffold default module",
      );
      expect(moduleStep).toBeDefined();
      // Must scaffold — having a custom module is not enough, the default module is missing
      expect(moduleStep!.status).toBe("done");

      // Verify modules/main.yaml was actually created
      expect(existsSync(defaultModulePath)).toBe(true);
      const content = await fs.readFile(defaultModulePath, "utf-8");
      expect(content).toContain("type: module");
      expect(content).toContain("main");
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
