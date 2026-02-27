import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectAgent as detectSetupAgent } from "../src/cli/commands/setup.js";
import { detectAgent as detectStatusAgent } from "../src/parser/setup-status.js";

describe("Agent detection", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SANDBOX;
    delete process.env.CODEX_CI;
    delete process.env.CODEX_MANAGED_BY_NPM;
  });

  afterEach(() => {
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
});
