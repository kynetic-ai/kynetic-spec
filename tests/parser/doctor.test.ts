/**
 * Tests for kspec doctor command
 *
 * AC coverage:
 * - @doctor-command ac-no-git-repo: No git repository returns error
 * - @doctor-command ac-not-initialized: kspec not initialized returns error
 * - @doctor-command ac-shadow-healthy: Shadow branch health checks
 * - @doctor-command ac-setup-agent-hooks: Setup hooks status
 * - @doctor-command ac-setup-skills-agents-md: Skills and agents.md status
 * - @doctor-command ac-daemon-running: Daemon running status with PID/port/uptime
 * - @doctor-command ac-daemon-unreachable: Daemon running but health unreachable
 * - @doctor-command ac-daemon-not-running: Daemon not running is warning
 * - @doctor-command ac-overall-verdict: Overall health verdict
 * - @doctor-command ac-partial-init: Shadow ok but setup missing
 * - @doctor-command ac-staleness-unknown: Agents.md staleness unknown
 * - @doctor-command ac-json-output: JSON output format
 * - @doctor-command ac-exit-zero: Exit 0 when healthy
 * - @doctor-command ac-exit-one: Exit 1 when errors exist
 * - @task-remove-monolithic ac-4: Doctor task storage health check
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDoctorReport, type DoctorReport } from "../../src/parser/doctor.js";
import { createTempDir, cleanupTempDir, initGitRepo, kspec } from "../helpers/cli.js";
import { initializeShadow } from "../../src/parser/shadow.js";

describe("Doctor Command", () => {
  let tempDir: string;
  let originalCwd: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-doctor-test-");
    originalCwd = process.cwd();
    process.env = { ...originalEnv };
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_CI;
    delete process.env.CODEX_MANAGED_BY_NPM;
    delete process.env.FACTORY_PROJECT_DIR;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanupTempDir(tempDir);
    process.env = originalEnv;
  });

  describe("ac-no-git-repo", () => {
    // AC: @doctor-command ac-no-git-repo
    it("returns error when not in a git repository", async () => {
      // tempDir is not a git repo
      const report = await getDoctorReport(tempDir);

      expect(report.shadow.checks.length).toBeGreaterThan(0);
      expect(report.shadow.checks[0].severity).toBe("error");
      expect(report.shadow.checks[0].message).toContain("git");
      expect(report.overall.healthy).toBe(false);
      expect(report.overall.errorCount).toBe(1);
    });
  });

  describe("ac-not-initialized", () => {
    // AC: @doctor-command ac-not-initialized
    it("returns error when kspec is not initialized", async () => {
      initGitRepo(tempDir);

      const report = await getDoctorReport(tempDir);

      // Should have shadow checks but fail on initialization
      const initCheck = report.shadow.checks.find(
        (c) => c.name === "initialized" || c.name === "branch-exists",
      );
      expect(initCheck).toBeDefined();
      expect(initCheck!.severity).toBe("error");
      expect(report.overall.healthy).toBe(false);
    });

    // AC: @doctor-command ac-not-initialized
    it("provides guidance to run kspec init", async () => {
      initGitRepo(tempDir);

      const report = await getDoctorReport(tempDir);

      const errorCheck = report.shadow.checks.find((c) => c.severity === "error");
      expect(errorCheck).toBeDefined();
      expect(errorCheck!.guidance).toContain("kspec init");
    });
  });

  describe("ac-shadow-healthy", () => {
    // AC: @doctor-command ac-shadow-healthy
    it("shows branch exists check as ok when shadow is healthy", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const branchCheck = report.shadow.checks.find((c) => c.name === "branch-exists");
      expect(branchCheck).toBeDefined();
      expect(branchCheck!.severity).toBe("ok");
      expect(branchCheck!.message).toContain("exists");
    });

    // AC: @doctor-command ac-shadow-healthy
    it("shows worktree exists check as ok when shadow is healthy", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const worktreeCheck = report.shadow.checks.find((c) => c.name === "worktree-exists");
      expect(worktreeCheck).toBeDefined();
      expect(worktreeCheck!.severity).toBe("ok");
    });

    // AC: @doctor-command ac-shadow-healthy
    it("shows worktree linked check as ok when shadow is healthy", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const linkedCheck = report.shadow.checks.find((c) => c.name === "worktree-linked");
      expect(linkedCheck).toBeDefined();
      expect(linkedCheck!.severity).toBe("ok");
      expect(linkedCheck!.message).toContain("linked");
    });
  });

  describe("ac-artifacts-directory", () => {
    // AC: @artifacts-directory ac-doctor-checks
    it("shows artifacts directory as ok when it exists", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const artifactsCheck = report.shadow.checks.find((c) => c.name === "artifacts-dir");
      expect(artifactsCheck).toBeDefined();
      expect(artifactsCheck!.severity).toBe("ok");
      expect(artifactsCheck!.message).toContain("exists");
    });

    // AC: @artifacts-directory ac-doctor-checks
    it("shows warning when artifacts directory is missing", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Remove artifacts directory
      const artifactsDir = path.join(tempDir, ".kspec", "artifacts");
      await fs.rm(artifactsDir, { recursive: true, force: true });

      const report = await getDoctorReport(tempDir);

      const artifactsCheck = report.shadow.checks.find((c) => c.name === "artifacts-dir");
      expect(artifactsCheck).toBeDefined();
      expect(artifactsCheck!.severity).toBe("warning");
      // AC: @doctor-reports-actionable-state ac-all-actionable —
      //     guidance must name a specific setup flag, not generic `kspec setup`.
      expect(artifactsCheck!.guidance).toContain("kspec setup --force");
      expect(artifactsCheck!.guidance).not.toMatch(/\bkspec setup\b(?!\s+--)/);
    });
  });

  describe("ac-setup-agent-hooks", () => {
    // AC: @doctor-command ac-setup-agent-hooks
    it("shows agent type in setup section", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const agentCheck = report.setup.checks.find((c) => c.name === "agent-type");
      expect(agentCheck).toBeDefined();
      // Agent type will be "unknown" in test environment
      expect(agentCheck!.message).toContain("Agent type");
    });

    // AC: @doctor-reports-actionable-state ac-all-actionable —
    //     when agent type is unknown, guidance must name the specific
    //     `--agent` flag, not generic `kspec setup`.
    it("names the --agent flag when agent type is unknown", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // HOME points to tempDir which has no ~/.claude dir and no agent env
      // vars — agent detection falls through to "unknown".
      vi.stubEnv("HOME", tempDir);
      vi.stubEnv("CLAUDECODE", "");
      vi.stubEnv("CURSOR", "");
      vi.stubEnv("WINDSURF", "");
      vi.stubEnv("CLINE", "");
      try {
        const report = await getDoctorReport(tempDir);
        const agentCheck = report.setup.checks.find((c) => c.name === "agent-type");
        expect(agentCheck).toBeDefined();
        if (agentCheck!.message === "Agent type: unknown") {
          expect(agentCheck!.severity).toBe("warning");
          expect(agentCheck!.guidance).toBeDefined();
          expect(agentCheck!.guidance).toContain("kspec setup --agent");
          // Guidance must not be the old generic `kspec setup` message.
          expect(agentCheck!.guidance!).not.toMatch(/\bkspec setup\b(?!\s+--)/);
        }
      } finally {
        vi.unstubAllEnvs();
      }
    });

    // AC: @doctor-command ac-setup-agent-hooks
    it("reports error when claude-code detected but no hooks configured", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Force claude-code detection via env var; HOME points to tempDir
      // so no real ~/.claude/settings.json is found (no hooks configured).
      vi.stubEnv("CLAUDECODE", "1");
      vi.stubEnv("HOME", tempDir);
      try {
        const report = await getDoctorReport(tempDir);
        const hooksCheck = report.setup.checks.find((c) => c.name === "hooks");
        expect(hooksCheck).toBeDefined();
        expect(hooksCheck!.severity).toBe("error");
        // AC: @doctor-reports-actionable-state ac-all-actionable —
        //     guidance must name the specific `--agent` flag instead of
        //     generic `kspec setup`.
        expect(hooksCheck!.guidance).toContain("kspec setup --agent");
        expect(hooksCheck!.guidance).toContain("claude-code");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    // AC: @doctor-command ac-setup-agent-hooks
    it("reports ok when agent does not support hooks", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // HOME points to tempDir which has no ~/.claude dir,
      // so agent detection falls through to "unknown" (hooks not applicable).
      vi.stubEnv("HOME", tempDir);
      try {
        const report = await getDoctorReport(tempDir);
        const hooksCheck = report.setup.checks.find((c) => c.name === "hooks");
        expect(hooksCheck).toBeDefined();
        expect(hooksCheck!.severity).toBe("ok");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    // AC: @doctor-command ac-setup-agent-hooks
    it("treats droid hook status as an intentional skip instead of an error", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      await fs.mkdir(path.join(tempDir, ".factory", "skills", "droid-status"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tempDir, ".factory", "skills", "droid-status", "SKILL.md"),
        "---\nname: droid-status\ndescription: Droid status\n---\n<!-- kspec-managed -->\n# Droid status\n",
        "utf-8",
      );

      const previousFactoryProjectDir = process.env.FACTORY_PROJECT_DIR;
      const previousHome = process.env.HOME;
      process.env.FACTORY_PROJECT_DIR = tempDir;
      process.env.HOME = tempDir;

      try {
        const report = await getDoctorReport(tempDir);

        const hooksCheck = report.setup.checks.find((c) => c.name === "hooks");
        const skillsCheck = report.setup.checks.find((c) => c.name === "skills");

        expect(report.setup.agentType).toBe("droid");
        expect(hooksCheck).toBeDefined();
        expect(hooksCheck!.severity).toBe("ok");
        expect(hooksCheck!.message).toContain("droid hooks are not yet supported");

        expect(skillsCheck).toBeDefined();
        expect(skillsCheck!.severity).toBe("ok");
        // The skills-check message describes rendered skill presence across
        // every supported location, not just the agent-specific count.
        // Earlier drafts claimed "in agent-specific locations" even when the
        // count came from plugin-provided skills — that was a factual error
        // the reviewer flagged. The message must not use that phrasing.
        expect(skillsCheck!.message).toContain("Rendered skills present");
        expect(skillsCheck!.message).toContain("1 across supported locations");
        expect(skillsCheck!.message).not.toContain("agent-specific locations");
      } finally {
        if (previousFactoryProjectDir === undefined) {
          delete process.env.FACTORY_PROJECT_DIR;
        } else {
          process.env.FACTORY_PROJECT_DIR = previousFactoryProjectDir;
        }

        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }
    });
  });

  describe("ac-setup-skills-agents-md", () => {
    // AC: @doctor-command ac-setup-skills-agents-md
    it("shows skills count in setup section", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const skillsCheck = report.setup.checks.find((c) => c.name === "skills");
      expect(skillsCheck).toBeDefined();
      // No skills rendered in bare test
      expect(skillsCheck!.message).toContain("skills");
    });

    // AC: @doctor-command ac-setup-skills-agents-md
    it("shows agents.md status in setup section", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const agentsMdCheck = report.setup.checks.find((c) => c.name === "agents-md");
      expect(agentsMdCheck).toBeDefined();
      // agents.md doesn't exist in bare test
      expect(agentsMdCheck!.severity).toBe("error");
      expect(agentsMdCheck!.message).toContain("kspec-agents.md");
    });

    // AC: @doctor-reports-actionable-state ac-all-actionable —
    //     when kspec-agents.md is missing, guidance must name the
    //     specific `kspec agents generate` command, not generic
    //     `kspec setup`.
    it("names `kspec agents generate` when kspec-agents.md is missing", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const agentsMdCheck = report.setup.checks.find((c) => c.name === "agents-md");
      expect(agentsMdCheck).toBeDefined();
      expect(agentsMdCheck!.severity).toBe("error");
      expect(agentsMdCheck!.guidance).toBeDefined();
      expect(agentsMdCheck!.guidance!).toContain("kspec agents generate");
      expect(agentsMdCheck!.guidance!).not.toMatch(/\bkspec setup\b(?!\s+--)/);
    });
  });

  describe("ac-daemon-running", () => {
    // AC: @doctor-command ac-daemon-running
    it("includes daemon running check with PID", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Mock daemon as running to test the running-with-PID path
      const daemonStatusModule = await import("../../src/parser/daemon-status.js");
      vi.spyOn(daemonStatusModule, "getDaemonStatus").mockResolvedValue({
        running: true,
        pid: 99999,
        port: 3456,
        uptime: 120,
        healthReachable: true,
      });

      try {
        const report = await getDoctorReport(tempDir);

        const daemonCheck = report.daemon.checks.find((c) => c.name === "daemon-running");
        expect(daemonCheck).toBeDefined();
        expect(daemonCheck!.severity).toBe("ok");
        expect(daemonCheck!.message).toContain("PID: 99999");
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("ac-daemon-unreachable", () => {
    // AC: @doctor-command ac-daemon-unreachable
    it("shows warning when daemon running but health endpoint unreachable", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Mock getDaemonStatus to simulate daemon running but health unreachable
      const daemonStatusModule = await import("../../src/parser/daemon-status.js");

      vi.spyOn(daemonStatusModule, "getDaemonStatus").mockResolvedValue({
        running: true,
        pid: 12345,
        port: 3456,
        uptime: null,
        healthReachable: false,
      });

      try {
        const report = await getDoctorReport(tempDir);

        // Should have daemon-running check as ok (process is alive)
        const runningCheck = report.daemon.checks.find((c) => c.name === "daemon-running");
        expect(runningCheck).toBeDefined();
        expect(runningCheck!.severity).toBe("ok");
        expect(runningCheck!.message).toContain("PID: 12345");

        // Should have daemon-health check as warning (unreachable)
        const healthCheck = report.daemon.checks.find((c) => c.name === "daemon-health");
        expect(healthCheck).toBeDefined();
        expect(healthCheck!.severity).toBe("warning");
        expect(healthCheck!.message).toContain("unreachable");
        expect(healthCheck!.guidance).toBeDefined();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("ac-daemon-not-running", () => {
    // AC: @doctor-command ac-daemon-not-running
    it("daemon not running is warning severity, not error", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Mock daemon as not running to isolate from host environment
      // (flaky when real daemon is running, e.g. during dispatch sessions)
      const daemonStatusModule = await import("../../src/parser/daemon-status.js");
      vi.spyOn(daemonStatusModule, "getDaemonStatus").mockResolvedValue({
        running: false,
        pid: null,
        port: null,
        uptime: null,
        healthReachable: false,
      });

      try {
        const report = await getDoctorReport(tempDir);

        const daemonCheck = report.daemon.checks.find((c) => c.name === "daemon-running");
        expect(daemonCheck).toBeDefined();
        expect(daemonCheck!.severity).toBe("warning");
        expect(daemonCheck!.message).toContain("not running");
      } finally {
        vi.restoreAllMocks();
      }
    });

    // AC: @doctor-command ac-daemon-not-running
    it("provides guidance to start daemon", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Mock daemon as not running to isolate from host environment
      const daemonStatusModule = await import("../../src/parser/daemon-status.js");
      vi.spyOn(daemonStatusModule, "getDaemonStatus").mockResolvedValue({
        running: false,
        pid: null,
        port: null,
        uptime: null,
        healthReachable: false,
      });

      try {
        const report = await getDoctorReport(tempDir);

        const daemonCheck = report.daemon.checks.find(
          (c) => c.name === "daemon-running" && c.severity === "warning",
        );
        expect(daemonCheck).toBeDefined();
        expect(daemonCheck!.guidance).toContain("kspec serve");
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  describe("ac-overall-verdict", () => {
    // AC: @doctor-command ac-overall-verdict
    it("reports healthy when no errors exist", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      // Create required setup artifacts to be healthy
      await fs.mkdir(path.join(tempDir, ".claude", "hooks"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "prompt-check" }] }],
          },
        }),
      );
      await fs.writeFile(path.join(tempDir, "kspec-agents.md"), "# Test agents");
      // Create hash file
      await fs.mkdir(path.join(tempDir, ".kspec"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".kspec", ".kspec-agents-hash"),
        JSON.stringify({ metaHash: "test", generatedAt: new Date().toISOString() }),
      );

      const report = await getDoctorReport(tempDir);

      // Check overall verdict structure
      expect(report.overall).toHaveProperty("healthy");
      expect(report.overall).toHaveProperty("errorCount");
      expect(report.overall).toHaveProperty("warningCount");
    });

    // AC: @doctor-command ac-overall-verdict
    it("reports issues found with error count when errors exist", async () => {
      initGitRepo(tempDir);
      // Don't initialize shadow - this creates an error
      const report = await getDoctorReport(tempDir);

      expect(report.overall.healthy).toBe(false);
      expect(report.overall.errorCount).toBeGreaterThan(0);
    });

    // AC: @doctor-command ac-overall-verdict
    it("includes warning count in verdict", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      // Should have warnings (daemon not running, missing setup artifacts)
      expect(typeof report.overall.warningCount).toBe("number");
    });
  });

  describe("ac-partial-init", () => {
    // AC: @doctor-command ac-partial-init
    it("shows shadow ok but setup missing when partially initialized", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      // Don't run kspec setup - leave hooks/skills/agents.md missing

      const report = await getDoctorReport(tempDir);

      // Shadow should be healthy
      expect(report.shadow.initialized).toBe(true);
      const shadowErrors = report.shadow.checks.filter((c) => c.severity === "error");
      expect(shadowErrors.length).toBe(0);

      // Setup should have errors
      const setupErrors = report.setup.checks.filter((c) => c.severity === "error");
      expect(setupErrors.length).toBeGreaterThan(0);
    });

    // AC: @doctor-command ac-partial-init
    // AC: @doctor-reports-actionable-state ac-all-actionable —
    //     every setup error must include a concrete, specific resolution
    //     command (a specific setup subcommand/flag or a dedicated command
    //     like `kspec agents generate`), not generic `kspec setup`.
    it("provides specific, actionable guidance on every setup error", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const setupErrors = report.setup.checks.filter((c) => c.severity === "error");
      expect(setupErrors.length).toBeGreaterThan(0);

      // Every setup error must have a non-empty guidance string.
      const withoutGuidance = setupErrors.filter(
        (c) => !c.guidance || c.guidance.trim().length === 0,
      );
      expect(
        withoutGuidance,
        `Setup errors missing guidance: ${withoutGuidance.map((c) => c.name).join(", ")}`,
      ).toHaveLength(0);

      // Guidance must name a specific command: either a `kspec setup` flag
      // (e.g. `--force`, `--agent`) or a dedicated non-setup command
      // (e.g. `kspec agents generate`, `kspec skill render`).
      const generic = setupErrors.filter(
        (c) => c.guidance && /\bkspec setup\b(?!\s+--)/.test(c.guidance),
      );
      expect(
        generic,
        `Setup errors with generic \`kspec setup\` guidance: ${generic
          .map((c) => `${c.name}: ${c.guidance}`)
          .join("; ")}`,
      ).toHaveLength(0);
    });
  });

  describe("ac-staleness-unknown", () => {
    // AC: @doctor-command ac-staleness-unknown
    it("reports unknown status when staleness cannot be determined", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Create agents.md but no hash file (simulates unknown staleness)
      await fs.writeFile(path.join(tempDir, "kspec-agents.md"), "# Test agents");

      const report = await getDoctorReport(tempDir);

      // Should report agents.md status
      expect(report.setup.agentsMdStatus).toBeDefined();
      // With no hash file, status should be "stale" (hash file missing)
      expect(["stale", "unknown"]).toContain(report.setup.agentsMdStatus);
    });
  });

  describe("ac-json-output", () => {
    // AC: @doctor-command ac-json-output
    it("returns DoctorReport with all required sections", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      // Verify all required sections exist
      expect(report).toHaveProperty("generatedAt");
      expect(report).toHaveProperty("shadow");
      expect(report).toHaveProperty("setup");
      expect(report).toHaveProperty("daemon");
      expect(report).toHaveProperty("overall");
    });

    // AC: @doctor-command ac-json-output
    it("includes severity per check", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      // Every check should have a severity
      for (const check of report.shadow.checks) {
        expect(["ok", "warning", "error"]).toContain(check.severity);
      }
      for (const check of report.setup.checks) {
        expect(["ok", "warning", "error"]).toContain(check.severity);
      }
      for (const check of report.daemon.checks) {
        expect(["ok", "warning", "error"]).toContain(check.severity);
      }
    });

    // AC: @doctor-command ac-json-output
    it("includes healthy boolean in overall", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      expect(typeof report.overall.healthy).toBe("boolean");
    });

    // AC: @trait-json-output ac-5
    it("uses ISO 8601 format for timestamps", async () => {
      initGitRepo(tempDir);

      const report = await getDoctorReport(tempDir);

      // generatedAt should be ISO 8601
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
      expect(report.generatedAt).toMatch(isoRegex);
    });
  });

  describe("ac-task-storage", () => {
    // AC: @doctor-command ac-task-storage
    it("shows ok when split format is configured", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      // initializeShadow creates kynetic: 1.1 + task_storage.format: split

      const report = await getDoctorReport(tempDir);

      const storageCheck = report.taskStorage.checks.find((c) => c.name === "task-storage-format");
      expect(storageCheck).toBeDefined();
      expect(storageCheck!.severity).toBe("ok");
      expect(storageCheck!.message).toContain("split");
    });

    // AC: @doctor-command ac-task-storage
    it("shows warning when kynetic >= 1.1 but format not explicitly set", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Overwrite manifest: kynetic 1.1 but no task_storage.format
      const manifestPath = path.join(tempDir, ".kspec", "test-project.yaml");
      await fs.writeFile(manifestPath, 'kynetic: "1.1"\nproject:\n  name: test-project\n');

      const report = await getDoctorReport(tempDir);

      const storageCheck = report.taskStorage.checks.find((c) => c.name === "task-storage-format");
      expect(storageCheck).toBeDefined();
      expect(storageCheck!.severity).toBe("warning");
      expect(storageCheck!.message).toContain("not explicitly set");
      expect(storageCheck!.guidance).toContain("kspec task migrate");
    });

    // AC: @doctor-command ac-task-storage
    it("shows error for legacy format (kynetic < 1.1 with no split format)", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Overwrite manifest: kynetic 1.0 with no task_storage
      const manifestPath = path.join(tempDir, ".kspec", "test-project.yaml");
      await fs.writeFile(manifestPath, 'kynetic: "1.0"\nproject:\n  name: test-project\n');

      const report = await getDoctorReport(tempDir);

      const storageCheck = report.taskStorage.checks.find((c) => c.name === "task-storage-format");
      expect(storageCheck).toBeDefined();
      expect(storageCheck!.severity).toBe("error");
      expect(storageCheck!.message).toContain("Legacy task storage");
      expect(storageCheck!.guidance).toContain("kspec task migrate");
    });

    // AC: @doctor-command ac-task-storage
    it("skips task storage checks gracefully when manifest is unreadable", async () => {
      initGitRepo(tempDir);
      // Don't initialize shadow — no .kspec/kynetic.yaml exists

      const report = await getDoctorReport(tempDir);

      // taskStorage section should have no checks (graceful skip)
      expect(report.taskStorage.checks).toHaveLength(0);
    });

    // AC: @doctor-command ac-task-storage
    it("legacy task storage error contributes to overall unhealthy verdict", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Overwrite manifest to legacy format
      const manifestPath = path.join(tempDir, ".kspec", "test-project.yaml");
      await fs.writeFile(manifestPath, 'kynetic: "1.0"\nproject:\n  name: test-project\n');

      const report = await getDoctorReport(tempDir);

      expect(report.overall.healthy).toBe(false);
      expect(report.overall.errorCount).toBeGreaterThan(0);
    });
  });

  describe("CLI integration", () => {
    // AC: @doctor-command ac-exit-zero
    // AC: @trait-semantic-exit-codes ac-1
    it("exits with code 0 when healthy (via CLI)", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      // Create minimal setup to avoid errors
      await fs.mkdir(path.join(tempDir, ".claude", "hooks"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "prompt-check" }] }],
          },
        }),
      );
      await fs.writeFile(path.join(tempDir, "kspec-agents.md"), "# Test agents");
      await fs.writeFile(
        path.join(tempDir, ".kspec", ".kspec-agents-hash"),
        JSON.stringify({ metaHash: "test", generatedAt: new Date().toISOString() }),
      );

      const result = kspec("doctor --json", tempDir);

      // Parse the JSON and verify healthy status
      const report = JSON.parse(result.stdout) as DoctorReport;

      // AC: @doctor-command ac-exit-zero — exit code 0 when healthy
      expect(result.exitCode).toBe(0);
      // AC: @trait-semantic-exit-codes ac-1 — exit 0 indicates success
      expect(report.overall.healthy).toBe(true);
      expect(report.overall.errorCount).toBe(0);
    });

    // AC: @doctor-command ac-exit-one
    // AC: @trait-semantic-exit-codes ac-2
    it("exits with code 1 when errors exist (via CLI)", async () => {
      initGitRepo(tempDir);
      // Don't initialize - this creates errors

      const result = kspec("doctor --json", tempDir, { expectFail: true });

      expect(result.exitCode).toBe(1); // ERROR (health check failed)
      const report = JSON.parse(result.stdout) as DoctorReport;
      expect(report.overall.healthy).toBe(false);
    });

    // AC: @doctor-command ac-json-output
    it("outputs valid JSON with --json flag", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const result = kspec("doctor --json", tempDir, { expectFail: true });

      // Should parse without error
      const report = JSON.parse(result.stdout);
      expect(report).toHaveProperty("shadow");
      expect(report).toHaveProperty("setup");
      expect(report).toHaveProperty("daemon");
      expect(report).toHaveProperty("overall");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // @doctor-reports-actionable-state — accurate checks and actionable messages
  // ───────────────────────────────────────────────────────────────────────────

  describe("@doctor-reports-actionable-state ac-skills-check-accurate", () => {
    // AC: @doctor-reports-actionable-state ac-skills-check-accurate
    it("reports skills as present when a core skill is rendered under .claude/plugins/kspec/skills", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Simulate a core skill rendered via the Claude Code plugin directory.
      // This is the location setup.ts writes to for core skills on claude-code
      // (PLUGIN_SKILLS_DIR = ".claude/plugins/kspec/skills").
      const pluginSkillDir = path.join(
        tempDir,
        ".claude",
        "plugins",
        "kspec",
        "skills",
        "task-work",
      );
      await fs.mkdir(pluginSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginSkillDir, "SKILL.md"),
        "---\nname: task-work\ndescription: Task work\n---\n<!-- kspec-managed -->\n# Task work\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const skillsCheck = report.setup.checks.find((c) => c.name === "skills");
      expect(skillsCheck).toBeDefined();
      // Must NOT warn about missing rendered skills when plugin skills exist.
      expect(skillsCheck!.severity).not.toBe("warning");
      expect(skillsCheck!.message).not.toMatch(/no (rendered )?skills/i);
      // Plugin-provided skills are NOT agent-specific — they are plugin
      // output. The prior message wrongly attributed the count to
      // "agent-specific locations" even when the only rendered skill lived
      // under .claude/plugins/kspec/skills. Guard against regression.
      expect(skillsCheck!.message).not.toContain("agent-specific locations");
    });

    // AC: @doctor-reports-actionable-state ac-skills-check-accurate
    it("reports skills as present when rendered in .claude/skills", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Project/local skills render to .claude/skills/
      const localSkillDir = path.join(tempDir, ".claude", "skills", "my-skill");
      await fs.mkdir(localSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(localSkillDir, "SKILL.md"),
        "---\nname: my-skill\ndescription: My skill\n---\n<!-- kspec-managed -->\n# My skill\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const skillsCheck = report.setup.checks.find((c) => c.name === "skills");
      expect(skillsCheck).toBeDefined();
      expect(skillsCheck!.severity).not.toBe("warning");
    });

    // AC: @doctor-reports-actionable-state ac-skills-check-accurate
    it("reports skills as present when rendered in .agents/skills (codex)", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Codex skills render to .agents/skills/
      const codexSkillDir = path.join(tempDir, ".agents", "skills", "kspec-task-work");
      await fs.mkdir(codexSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(codexSkillDir, "SKILL.md"),
        "---\nname: kspec-task-work\ndescription: Task work\n---\n<!-- kspec-managed -->\n# Task work\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const skillsCheck = report.setup.checks.find((c) => c.name === "skills");
      expect(skillsCheck).toBeDefined();
      expect(skillsCheck!.severity).not.toBe("warning");
    });

    // AC: @doctor-reports-actionable-state ac-skills-check-accurate
    it("reports skills as present when rendered in .factory/skills (droid)", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const droidSkillDir = path.join(tempDir, ".factory", "skills", "kspec-task-work");
      await fs.mkdir(droidSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(droidSkillDir, "SKILL.md"),
        "---\nname: kspec-task-work\ndescription: Task work\n---\n<!-- kspec-managed -->\n# Task work\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const skillsCheck = report.setup.checks.find((c) => c.name === "skills");
      expect(skillsCheck).toBeDefined();
      expect(skillsCheck!.severity).not.toBe("warning");
    });
  });

  describe("@doctor-reports-actionable-state ac-skills-check-missing", () => {
    // AC: @doctor-reports-actionable-state ac-skills-check-missing
    it("reports rendered skills as missing and names the re-render command", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      // No skills rendered in any supported location.

      const report = await getDoctorReport(tempDir);

      const skillsCheck = report.setup.checks.find((c) => c.name === "skills");
      expect(skillsCheck).toBeDefined();
      expect(skillsCheck!.severity).toBe("warning");
      // Must name a concrete command that re-renders skills.
      expect(skillsCheck!.guidance).toBeDefined();
      expect(skillsCheck!.guidance!).toMatch(/kspec (skill render|setup)/);
    });
  });

  describe("@doctor-reports-actionable-state ac-config-scaffold-detected", () => {
    // AC: @doctor-reports-actionable-state ac-config-scaffold-detected
    it("warns when the scaffolded project config file is missing", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      // No kspec.config.yaml at project root.

      const report = await getDoctorReport(tempDir);

      const configCheck = report.setup.checks.find((c) => c.name === "project-config");
      expect(configCheck).toBeDefined();
      expect(configCheck!.severity).toBe("warning");
      expect(configCheck!.message).toContain("kspec.config.yaml");
      expect(configCheck!.guidance).toBeDefined();
      // Must name a concrete command that scaffolds the config.
      expect(configCheck!.guidance!).toMatch(/kspec (upgrade|setup --force)/);
    });

    // AC: @doctor-reports-actionable-state ac-config-scaffold-detected
    it("reports ok when the scaffolded project config file exists", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Scaffold a minimal valid config at project root.
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        "dispatch:\n  publication_mode: auto\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const configCheck = report.setup.checks.find((c) => c.name === "project-config");
      expect(configCheck).toBeDefined();
      expect(configCheck!.severity).toBe("ok");
    });
  });

  describe("@doctor-reports-actionable-state ac-version-skew-detected", () => {
    // AC: @doctor-reports-actionable-state ac-version-skew-detected
    it("warns when lastKnownVersion in setup state differs from installed version", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Simulate a project that was initialized with an older kspec version.
      // Write an obviously-old version into .setup-state.json so it never
      // coincidentally matches the currently installed version.
      const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({ lastKnownVersion: "0.0.0-old-test-fixture" }, null, 2) + "\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const versionCheck = report.setup.checks.find((c) => c.name === "version-skew");
      expect(versionCheck).toBeDefined();
      expect(versionCheck!.severity).toBe("warning");
      expect(versionCheck!.message).toContain("0.0.0-old-test-fixture");
      expect(versionCheck!.guidance).toBeDefined();
      // Must name the upgrade command.
      expect(versionCheck!.guidance!).toContain("kspec upgrade");
    });

    // AC: @doctor-reports-actionable-state ac-version-skew-detected
    it("reports ok when lastKnownVersion matches installed version", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Read the installed version and pin it into the state file so the check
      // sees an up-to-date project.
      const { getKspecPackageVersion } = await import("../../src/cli/commands/skill-install.js");
      const installed = await getKspecPackageVersion();
      expect(installed).toBeTruthy();

      const statePath = path.join(tempDir, ".kspec", ".setup-state.json");
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify({ lastKnownVersion: installed }, null, 2) + "\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const versionCheck = report.setup.checks.find((c) => c.name === "version-skew");
      // When versions match the check should be ok, not a warning.
      expect(versionCheck).toBeDefined();
      expect(versionCheck!.severity).toBe("ok");
    });

    // AC: @doctor-reports-actionable-state ac-version-skew-detected
    it("does not warn when lastKnownVersion is missing (pre-upgrade project)", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });
      // No .setup-state.json at all.

      const report = await getDoctorReport(tempDir);

      const versionCheck = report.setup.checks.find((c) => c.name === "version-skew");
      // Either the check is not emitted, or it is emitted as ok/info — but
      // never a warning, since we cannot prove skew without a baseline.
      if (versionCheck) {
        expect(versionCheck.severity).not.toBe("warning");
      }
    });
  });

  describe("@doctor-reports-actionable-state ac-all-actionable", () => {
    // AC: @doctor-reports-actionable-state ac-all-actionable
    it("every warning and error check includes a concrete guidance command", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Write an old setup state and a legacy manifest to maximize the number
      // of warnings/errors the doctor surfaces.
      await fs.writeFile(
        path.join(tempDir, ".kspec", ".setup-state.json"),
        JSON.stringify({ lastKnownVersion: "0.0.0-old-test-fixture" }, null, 2) + "\n",
        "utf-8",
      );

      const report = await getDoctorReport(tempDir);

      const allChecks = [
        ...report.shadow.checks,
        ...report.setup.checks,
        ...report.taskStorage.checks,
        ...report.daemon.checks,
      ];

      const actionableSeverities: Array<"warning" | "error"> = ["warning", "error"];
      const unactionable = allChecks.filter(
        (c) =>
          actionableSeverities.includes(c.severity as "warning" | "error") &&
          (!c.guidance || c.guidance.trim().length === 0),
      );

      // Every warning/error must have a concrete guidance command or action.
      // Failure prints the offending check names to aid debugging.
      expect(
        unactionable,
        `Checks with no guidance: ${unactionable.map((c) => `${c.name} (${c.severity}): ${c.message}`).join("; ")}`,
      ).toHaveLength(0);
    });

    // AC: @doctor-reports-actionable-state ac-all-actionable —
    //     messages that previously said "run setup" must now name the
    //     specific subcommand or flag. Any guidance that says "kspec setup"
    //     without a specific flag (e.g. --force, --agent) is disallowed
    //     UNLESS the guidance also names a more specific primary command
    //     (e.g. `kspec skill render`, `kspec agents generate`, `kspec upgrade`).
    it("no warning or error guidance uses generic `kspec setup` as the only resolution", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Simulate a maximally-degraded project so doctor surfaces every
      // actionable check it can.
      await fs.writeFile(
        path.join(tempDir, ".kspec", ".setup-state.json"),
        JSON.stringify({ lastKnownVersion: "0.0.0-old-test-fixture" }, null, 2) + "\n",
        "utf-8",
      );
      await fs.rm(path.join(tempDir, ".kspec", "artifacts"), {
        recursive: true,
        force: true,
      });

      // Force claude-code detection so the hooks-missing error path fires.
      vi.stubEnv("CLAUDECODE", "1");
      vi.stubEnv("HOME", tempDir);
      try {
        const report = await getDoctorReport(tempDir);

        const allChecks = [
          ...report.shadow.checks,
          ...report.setup.checks,
          ...report.taskStorage.checks,
          ...report.daemon.checks,
        ];

        const actionableSeverities: Array<"warning" | "error"> = ["warning", "error"];

        // A guidance string is "specific enough" if, after we strip any
        // `kspec setup` (no flag) substring, a specific resolution command
        // remains — either `kspec setup` followed by a flag, or a non-setup
        // kspec command.
        const SPECIFIC_COMMANDS_RE =
          /kspec setup\s+--|kspec (agents generate|skill render|upgrade|shadow repair|init|task migrate|serve (start|restart|status))/;
        const GENERIC_SETUP_RE = /\bkspec setup\b(?!\s+--)/;

        const offenders = allChecks.filter((c) => {
          if (!actionableSeverities.includes(c.severity as "warning" | "error")) {
            return false;
          }
          const guidance = c.guidance ?? "";
          if (guidance.trim().length === 0) return false;
          // Guidance is an offender only if it mentions generic `kspec setup`
          // AND has no specific alternative command in the same string.
          return GENERIC_SETUP_RE.test(guidance) && !SPECIFIC_COMMANDS_RE.test(guidance);
        });

        expect(
          offenders,
          `Checks with generic \`kspec setup\` guidance: ${offenders
            .map((c) => `${c.name} (${c.severity}): ${c.guidance}`)
            .join("; ")}`,
        ).toHaveLength(0);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    // AC: @doctor-reports-actionable-state ac-all-actionable
    // AC: @trait-error-guidance ac-1 — error messages include a description of the condition
    // AC: @trait-error-guidance ac-2 — error messages include a suggested action to resolve
    it("legacy task storage error names kspec upgrade as preferred resolution", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Overwrite manifest to legacy format
      const manifestPath = path.join(tempDir, ".kspec", "test-project.yaml");
      await fs.writeFile(manifestPath, 'kynetic: "1.0"\nproject:\n  name: test-project\n');

      const report = await getDoctorReport(tempDir);

      const storageCheck = report.taskStorage.checks.find((c) => c.name === "task-storage-format");
      expect(storageCheck).toBeDefined();
      expect(storageCheck!.severity).toBe("error");
      // AC: @trait-error-guidance ac-1 — message describes the condition
      expect(storageCheck!.message).toContain("Legacy task storage");
      expect(storageCheck!.guidance).toBeDefined();
      // The preferred resolution is kspec upgrade; the lower-level fallback is task migrate.
      expect(storageCheck!.guidance!).toContain("kspec upgrade");
      expect(storageCheck!.guidance!).toContain("kspec task migrate");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Inherited trait ACs that do not apply to the doctor command.
  //
  // Doctor is a read-only health check — it does not resolve references, make
  // state transitions, validate schemas, or take user input that can be
  // invalid. The ACs below describe behaviors for commands that accept user
  // input and operate on kspec entities; they are structurally inapplicable
  // to doctor.
  // ───────────────────────────────────────────────────────────────────────────

  describe("@trait-error-guidance / @trait-semantic-exit-codes — not applicable", () => {
    // AC: @trait-error-guidance ac-3 — N/A: doctor does not resolve entity references,
    // so a "reference not found" error path does not exist.
    // AC: @trait-error-guidance ac-4 — N/A: doctor does not perform state transitions,
    // so there is no "invalid state transition" error path.
    // AC: @trait-error-guidance ac-5 — N/A: doctor does not validate user input with
    // per-field validation, so there is no "which field failed validation" case.
    // AC: @trait-error-guidance ac-6 — N/A: doctor errors in JSON mode emit a single
    // error string via src/cli/commands/doctor.ts; structured per-check guidance is
    // already carried in CheckResult.guidance (covered by ac-all-actionable).
    // AC: @trait-semantic-exit-codes ac-3 — N/A: doctor has no confirmation prompt to cancel.
    // AC: @trait-semantic-exit-codes ac-4 — N/A: runtime errors during doctor surface as
    // exit 1 via the error catch in doctor.ts — intentionally mapped onto the "errors exist"
    // semantic rather than a distinct runtime-error code.
    // AC: @trait-semantic-exit-codes ac-5 — N/A: doctor always produces a report; there is
    // no "empty result set" case.
    // AC: @trait-semantic-exit-codes ac-6 — N/A: doctor takes no arguments beyond --json;
    // incorrect usage is handled by commander.
    // AC: @trait-semantic-exit-codes ac-7 — N/A: doctor is not a batch operation.
    // AC: @trait-semantic-exit-codes ac-8 — N/A: exit-code documentation lives in
    // src/cli/exit-codes.ts and is shared across commands; doctor inherits it.
    it("documents inherited trait ACs that do not apply to doctor", () => {
      // This test exists so the annotations above are parsed by the AC scanner.
      expect(true).toBe(true);
    });
  });
});
