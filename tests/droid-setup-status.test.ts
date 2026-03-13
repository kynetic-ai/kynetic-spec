/**
 * Tests for Droid Setup Status Reporting
 *
 * AC: @droid-setup-status ac-1, ac-2, ac-3
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";

const mockedOs = vi.hoisted(() => ({ homeDir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedOs.homeDir || actual.homedir(),
  };
});

import { detectAgent } from "../src/parser/setup-status.js";
import { getSetupStatus } from "../src/parser/setup-status.js";
import {
  kspec,
  kspecJson,
  createTempDir,
  cleanupTempDir,
  initGitRepo,
} from "./helpers/cli.js";

describe("Droid setup status reporting", () => {
  const originalEnv = process.env;
  let tempHome: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    // Clear all agent env vars to ensure clean detection
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_CI;
    delete process.env.CODEX_MANAGED_BY_NPM;
    delete process.env.FACTORY_PROJECT_DIR;
    delete process.env.CLINE_ACTIVE;
    delete process.env.CURSOR_TRACE_ID;
    delete process.env.WINDSURF_SESSION;
    delete process.env.AIDER_MODEL;
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.GEMINI_CLI;
    delete process.env.COPILOT_MODEL;
    delete process.env.GH_TOKEN;
    delete process.env.AMP_API_KEY;
    delete process.env.AMP_TOOLBOX;
    tempHome = await createTempDir("kspec-droid-status-");
    process.env.HOME = tempHome;
    mockedOs.homeDir = tempHome;
  });

  afterEach(async () => {
    await cleanupTempDir(tempHome);
    mockedOs.homeDir = "";
    process.env = originalEnv;
  });

  // AC: @droid-setup-status ac-1
  it("includes skills from .factory/skills/ in skill count for droid agent", async () => {
    // Create a project dir with .factory/skills containing kspec-managed skills
    const projectDir = path.join(tempHome, "project");
    await fs.mkdir(projectDir, { recursive: true });

    // Create .factory/skills with two kspec-managed skills
    const factorySkillsDir = path.join(projectDir, ".factory", "skills");
    const skill1Dir = path.join(factorySkillsDir, "kspec-task-work");
    const skill2Dir = path.join(factorySkillsDir, "kspec-reflect");
    await fs.mkdir(skill1Dir, { recursive: true });
    await fs.mkdir(skill2Dir, { recursive: true });

    await fs.writeFile(
      path.join(skill1Dir, "SKILL.md"),
      "---\nname: kspec-task-work\n---\n<!-- kspec-managed -->\n# Task Work\n",
    );
    await fs.writeFile(
      path.join(skill2Dir, "SKILL.md"),
      "---\nname: kspec-reflect\n---\n<!-- kspec-managed -->\n# Reflect\n",
    );

    const status = await getSetupStatus(projectDir, {
      agentOverride: "droid",
    });

    expect(status.skills.rendered).toBe(2);
    expect(status.skills.total).toBe(2);
  });

  // AC: @droid-setup-status ac-1
  it("counts skills from both .claude/skills/ and .factory/skills/ when droid is detected", async () => {
    const projectDir = path.join(tempHome, "project");
    await fs.mkdir(projectDir, { recursive: true });

    // Create .claude/skills with one kspec-managed skill
    const claudeSkillDir = path.join(projectDir, ".claude", "skills", "my-skill");
    await fs.mkdir(claudeSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeSkillDir, "SKILL.md"),
      "---\nname: my-skill\n---\n<!-- kspec-managed -->\n# My Skill\n",
    );

    // Create .factory/skills with one kspec-managed skill
    const factorySkillDir = path.join(projectDir, ".factory", "skills", "kspec-help");
    await fs.mkdir(factorySkillDir, { recursive: true });
    await fs.writeFile(
      path.join(factorySkillDir, "SKILL.md"),
      "---\nname: kspec-help\n---\n<!-- kspec-managed -->\n# Help\n",
    );

    const status = await getSetupStatus(projectDir, {
      agentOverride: "droid",
    });

    // Both directories are scanned
    expect(status.skills.rendered).toBe(2);
    expect(status.skills.total).toBe(2);
  });

  // AC: @droid-setup-status ac-1
  it("does not scan .factory/skills/ when agent is not droid", async () => {
    const projectDir = path.join(tempHome, "project");
    await fs.mkdir(projectDir, { recursive: true });

    // Create .factory/skills with a kspec-managed skill
    const factorySkillDir = path.join(projectDir, ".factory", "skills", "kspec-help");
    await fs.mkdir(factorySkillDir, { recursive: true });
    await fs.writeFile(
      path.join(factorySkillDir, "SKILL.md"),
      "---\nname: kspec-help\n---\n<!-- kspec-managed -->\n# Help\n",
    );

    const status = await getSetupStatus(projectDir, {
      agentOverride: "claude-code",
    });

    // .factory/skills/ should not be scanned for claude-code
    expect(status.skills.rendered).toBe(0);
    expect(status.skills.total).toBe(0);
  });

  // AC: @droid-setup-status ac-2
  it("returns droid with medium confidence when ~/.factory exists as filesystem fallback", async () => {
    // Create ~/.factory directory (no env vars set)
    await fs.mkdir(path.join(tempHome, ".factory"), { recursive: true });

    const detected = await detectAgent();

    expect(detected.type).toBe("droid");
    expect(detected.confidence).toBe("medium");
    expect(detected.configPath).toBe(
      path.join(tempHome, ".factory", "settings.json"),
    );
  });

  // AC: @droid-setup-status ac-2
  it("prefers ~/.claude over ~/.factory in filesystem fallback order", async () => {
    // Create both directories
    await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
    await fs.mkdir(path.join(tempHome, ".factory"), { recursive: true });

    const detected = await detectAgent();

    // .claude is checked first, so claude-code takes precedence
    expect(detected.type).toBe("claude-code");
    expect(detected.confidence).toBe("medium");
  });
});

describe("Droid session agent-type acceptance", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-droid-session-");
    initGitRepo(tempDir);

    await fs.writeFile(path.join(tempDir, "README.md"), "# Test", "utf-8");
    execSync("git add README.md && git commit -m 'Initial'", {
      cwd: tempDir,
      stdio: "pipe",
    });

    kspec("init --name test-project --no-prompt", tempDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @droid-setup-status ac-3
  it("accepts 'droid' as a valid --agent-type for session create", () => {
    const result = kspecJson<{
      agent_type: string;
      session_id: string;
      status: string;
    }>("session create --agent-type droid", tempDir);

    expect(result.agent_type).toBe("droid");
    expect(result.session_id).toBeTruthy();
    expect(result.status).toBe("active");
  });
});
