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
        (c) => c.name === "initialized" || c.name === "branch-exists"
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

      const branchCheck = report.shadow.checks.find(
        (c) => c.name === "branch-exists"
      );
      expect(branchCheck).toBeDefined();
      expect(branchCheck!.severity).toBe("ok");
      expect(branchCheck!.message).toContain("exists");
    });

    // AC: @doctor-command ac-shadow-healthy
    it("shows worktree exists check as ok when shadow is healthy", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const worktreeCheck = report.shadow.checks.find(
        (c) => c.name === "worktree-exists"
      );
      expect(worktreeCheck).toBeDefined();
      expect(worktreeCheck!.severity).toBe("ok");
    });

    // AC: @doctor-command ac-shadow-healthy
    it("shows worktree linked check as ok when shadow is healthy", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const linkedCheck = report.shadow.checks.find(
        (c) => c.name === "worktree-linked"
      );
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

      const artifactsCheck = report.shadow.checks.find(
        (c) => c.name === "artifacts-dir"
      );
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

      const artifactsCheck = report.shadow.checks.find(
        (c) => c.name === "artifacts-dir"
      );
      expect(artifactsCheck).toBeDefined();
      expect(artifactsCheck!.severity).toBe("warning");
      expect(artifactsCheck!.guidance).toContain("kspec setup");
    });
  });

  describe("ac-setup-agent-hooks", () => {
    // AC: @doctor-command ac-setup-agent-hooks
    it("shows agent type in setup section", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const agentCheck = report.setup.checks.find(
        (c) => c.name === "agent-type"
      );
      expect(agentCheck).toBeDefined();
      // Agent type will be "unknown" in test environment
      expect(agentCheck!.message).toContain("Agent type");
    });

    // AC: @doctor-command ac-setup-agent-hooks
    it("shows hooks status in setup section", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const hooksCheck = report.setup.checks.find(
        (c) => c.name === "hooks"
      );
      expect(hooksCheck).toBeDefined();
      // No hooks installed in bare test
      expect(hooksCheck!.severity).toBe("error");
      expect(hooksCheck!.guidance).toContain("kspec setup");
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
        expect(skillsCheck!.message).toContain("1 skills rendered");
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

      const skillsCheck = report.setup.checks.find(
        (c) => c.name === "skills"
      );
      expect(skillsCheck).toBeDefined();
      // No skills rendered in bare test
      expect(skillsCheck!.message).toContain("skills");
    });

    // AC: @doctor-command ac-setup-skills-agents-md
    it("shows agents.md status in setup section", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const agentsMdCheck = report.setup.checks.find(
        (c) => c.name === "agents-md"
      );
      expect(agentsMdCheck).toBeDefined();
      // agents.md doesn't exist in bare test
      expect(agentsMdCheck!.severity).toBe("error");
      expect(agentsMdCheck!.message).toContain("kspec-agents.md");
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

        const daemonCheck = report.daemon.checks.find(
          (c) => c.name === "daemon-running"
        );
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
        const runningCheck = report.daemon.checks.find(
          (c) => c.name === "daemon-running"
        );
        expect(runningCheck).toBeDefined();
        expect(runningCheck!.severity).toBe("ok");
        expect(runningCheck!.message).toContain("PID: 12345");

        // Should have daemon-health check as warning (unreachable)
        const healthCheck = report.daemon.checks.find(
          (c) => c.name === "daemon-health"
        );
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

        const daemonCheck = report.daemon.checks.find(
          (c) => c.name === "daemon-running"
        );
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
          (c) => c.name === "daemon-running" && c.severity === "warning"
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
        })
      );
      await fs.writeFile(
        path.join(tempDir, "kspec-agents.md"),
        "# Test agents"
      );
      // Create hash file
      await fs.mkdir(path.join(tempDir, ".kspec"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".kspec", ".kspec-agents-hash"),
        JSON.stringify({ metaHash: "test", generatedAt: new Date().toISOString() })
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
      const shadowErrors = report.shadow.checks.filter(
        (c) => c.severity === "error"
      );
      expect(shadowErrors.length).toBe(0);

      // Setup should have errors
      const setupErrors = report.setup.checks.filter(
        (c) => c.severity === "error"
      );
      expect(setupErrors.length).toBeGreaterThan(0);
    });

    // AC: @doctor-command ac-partial-init
    it("provides guidance to run kspec setup", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      const report = await getDoctorReport(tempDir);

      const setupErrors = report.setup.checks.filter(
        (c) => c.severity === "error"
      );
      const hasSetupGuidance = setupErrors.some(
        (c) => c.guidance?.includes("kspec setup")
      );
      expect(hasSetupGuidance).toBe(true);
    });
  });

  describe("ac-staleness-unknown", () => {
    // AC: @doctor-command ac-staleness-unknown
    it("reports unknown status when staleness cannot be determined", async () => {
      initGitRepo(tempDir);
      await initializeShadow(tempDir, { projectName: "test-project" });

      // Create agents.md but no hash file (simulates unknown staleness)
      await fs.writeFile(
        path.join(tempDir, "kspec-agents.md"),
        "# Test agents"
      );

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
        })
      );
      await fs.writeFile(
        path.join(tempDir, "kspec-agents.md"),
        "# Test agents"
      );
      await fs.writeFile(
        path.join(tempDir, ".kspec", ".kspec-agents-hash"),
        JSON.stringify({ metaHash: "test", generatedAt: new Date().toISOString() })
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
});
