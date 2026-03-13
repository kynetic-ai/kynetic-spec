import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
const mockedOs = vi.hoisted(() => ({ homeDir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockedOs.homeDir || actual.homedir(),
  };
});
import { detectAgent as detectSetupAgent } from "../src/cli/commands/setup.js";
import { detectAgentFromEnv } from "../src/parser/agent-detection.js";
import { detectAgent as detectStatusAgent } from "../src/parser/setup-status.js";
import { cleanupTempDir, createTempDir } from "./helpers/cli.js";

describe("Agent detection", () => {
  const originalEnv = process.env;
  let tempHome: string;

  beforeEach(async () => {
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
    tempHome = await createTempDir("kspec-agent-home-");
    process.env.HOME = tempHome;
    mockedOs.homeDir = tempHome;
  });

  afterEach(async () => {
    await cleanupTempDir(tempHome);
    mockedOs.homeDir = "";
    process.env = originalEnv;
  });

  // AC: @01KJE3T7 - detect codex using CODEX_THREAD_ID even when sandbox var is absent
  it("detects codex-cli from CODEX_THREAD_ID without CODEX_SANDBOX", async () => {
    process.env.CODEX_THREAD_ID = "test-thread-123";

    const setupDetected = detectSetupAgent();
    const statusDetected = await detectStatusAgent();

    expect(setupDetected.type).toBe("codex-cli");
    expect(setupDetected.confidence).toBe("high");
    expect(setupDetected.envVars).toEqual({ CODEX_THREAD_ID: "test-thread-123" });

    expect(statusDetected).toEqual({
      type: "codex-cli",
      confidence: "high",
      configPath: path.join(tempHome, ".codex", "config.toml"),
    });
  });

  // AC: @01KJE3T7 - codex signal precedence over copilot markers
  it("prefers codex-cli when CODEX_THREAD_ID and GH_TOKEN are both present", async () => {
    process.env.CODEX_THREAD_ID = "test-thread-123";
    process.env.GH_TOKEN = "ghp_test";

    const setupDetected = detectSetupAgent();
    const statusDetected = await detectStatusAgent();

    expect(setupDetected.type).toBe("codex-cli");
    expect(setupDetected.confidence).toBe("high");
    expect(statusDetected.type).toBe("codex-cli");
    expect(statusDetected.confidence).toBe("high");
  });

  // AC: @01KJE3T7 - keep CODEX_SANDBOX compatibility for older codex environments
  it("keeps codex-cli detection via CODEX_SANDBOX", async () => {
    process.env.CODEX_SANDBOX = "1";

    const setupDetected = detectSetupAgent();
    const statusDetected = await detectStatusAgent();

    expect(setupDetected.type).toBe("codex-cli");
    expect(setupDetected.confidence).toBe("high");
    expect(statusDetected.type).toBe("codex-cli");
    expect(statusDetected.confidence).toBe("high");
  });

  // AC: @01KJE3T7 - setup and setup-status/doctor use aligned codex confidence semantics
  it("uses medium-confidence codex fallback signals consistently", async () => {
    process.env.CODEX_CI = "1";
    process.env.CODEX_MANAGED_BY_NPM = "1";

    const setupDetected = detectSetupAgent();
    const statusDetected = await detectStatusAgent();

    expect(setupDetected.type).toBe("codex-cli");
    expect(setupDetected.confidence).toBe("medium");
    expect(statusDetected.type).toBe("codex-cli");
    expect(statusDetected.confidence).toBe("medium");
  });

  // AC: @droid-agent-detection ac-1
  it("detects droid from FACTORY_PROJECT_DIR with high confidence", () => {
    process.env.FACTORY_PROJECT_DIR = "/tmp/factory-project";

    expect(detectAgentFromEnv()).toEqual({
      type: "droid",
      confidence: "high",
      configPath: path.join(tempHome, ".factory", "settings.json"),
      envVars: {
        FACTORY_PROJECT_DIR: "/tmp/factory-project",
      },
    });
  });

  // AC: @droid-agent-detection ac-2
  it("does not falsely detect droid when no droid markers are present", () => {
    const detected = detectAgentFromEnv();

    expect(detected.type).not.toBe("droid");
  });

  // AC: @droid-agent-detection ac-4
  it("keeps claude-code precedence over droid env markers", () => {
    process.env.CLAUDECODE = "1";
    process.env.FACTORY_PROJECT_DIR = "/tmp/factory-project";

    expect(detectAgentFromEnv().type).toBe("claude-code");
  });

  // AC: @droid-agent-detection ac-5
  it("uses ~/.factory as the low-confidence setup fallback", async () => {
    await fs.mkdir(path.join(tempHome, ".factory"), { recursive: true });

    const setupDetected = detectSetupAgent();
    const statusDetected = await detectStatusAgent();

    expect(setupDetected).toEqual({
      type: "droid",
      confidence: "low",
      configPath: path.join(tempHome, ".factory", "settings.json"),
    });
    expect(statusDetected).toEqual({
      type: "droid",
      confidence: "medium",
      configPath: path.join(tempHome, ".factory", "settings.json"),
    });
  });
});
