/**
 * Tests for per-adapter auto-approve arguments.
 *
 * Verifies that each adapter has correct autoApproveArgs,
 * the spawner applies extraArgs correctly, and no cross-role leakage occurs.
 *
 * AC: @ralph-adapter-auto-approve
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getAdapter, resolveAdapter, type AgentAdapter } from "../../src/agents/adapters.js";
import { spawnAgent, type SpawnedAgent } from "../../src/agents/spawner.js";
import { setupTempFixtures, cleanupTempDir } from "../helpers/cli";

const MOCK_ACP = path.join(__dirname, "..", "mocks", "acp-mock.js");

/**
 * Helper to cleanly shut down a spawned agent, waiting for process exit.
 */
async function cleanShutdown(agent: SpawnedAgent): Promise<void> {
  return new Promise<void>((resolve) => {
    agent.process.on("exit", () => resolve());
    agent.client.close();
    // Give the client a moment to close, then force-kill
    setTimeout(() => {
      if (!agent.process.killed) agent.kill();
    }, 50);
  });
}

// ============================================================================
// Adapter Registry Tests
// ============================================================================

describe("Adapter auto-approve args registry", () => {
  // AC: @ralph-adapter-auto-approve ac-1
  it("codex-acp pins latest Zed package and has correct autoApproveArgs", () => {
    const adapter = getAdapter("codex-acp");
    expect(adapter).toBeDefined();
    expect(adapter!.args).toContain("@zed-industries/codex-acp@0.12.0");
    expect(adapter!.autoApproveArgs).toEqual([
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ]);
  });

  // AC: @ralph-adapter-auto-approve ac-2
  it("claude-agent-acp uses ACP org package with --dangerously-skip-permissions", () => {
    const adapter = getAdapter("claude-agent-acp");
    expect(adapter).toBeDefined();
    expect(adapter!.args).toContain("@agentclientprotocol/claude-agent-acp@0.31.4");
    expect(adapter!.autoApproveArgs).toEqual(["--dangerously-skip-permissions"]);
  });

  // AC: @ralph-adapter-auto-approve ac-2
  it("claude-code-acp (deprecated alias) uses same ACP org package and autoApproveArgs", () => {
    const adapter = getAdapter("claude-code-acp");
    expect(adapter).toBeDefined();
    expect(adapter!.args).toContain("@agentclientprotocol/claude-agent-acp@0.31.4");
    expect(adapter!.autoApproveArgs).toEqual(["--dangerously-skip-permissions"]);
  });

  it("mock-acp has no autoApproveArgs", () => {
    const adapter = getAdapter("mock-acp");
    expect(adapter).toBeDefined();
    expect(adapter!.autoApproveArgs).toBeUndefined();
  });

  it("ad-hoc adapters have no autoApproveArgs", () => {
    const adapter = resolveAdapter("some-unknown-package");
    expect(adapter.autoApproveArgs).toBeUndefined();
  });

  // AC: @runner-process-invocation-inputs ac-generic-acp-process-omits-built-in-launch-args
  it("generic-acp is registered as a requiresProcessExecutable profile with no command, empty args, and no autoApproveArgs", () => {
    const adapter = getAdapter("generic-acp");
    expect(adapter).toBeDefined();
    expect(adapter!.requiresProcessExecutable).toBe(true);
    expect(adapter!.command).toBeUndefined();
    expect(adapter!.args).toEqual([]);
    expect(adapter!.autoApproveArgs).toBeUndefined();
  });
});

// ============================================================================
// Spawner extraArgs Tests
// ============================================================================

describe("Spawner extraArgs handling", () => {
  // AC: @ralph-adapter-auto-approve ac-4
  it("does not mutate adapter.args when extraArgs provided", () => {
    const adapter: AgentAdapter = {
      command: "echo",
      args: ["base-arg"],
      description: "test adapter",
      autoApproveArgs: ["--auto-approve"],
    };

    const originalArgs = [...adapter.args];

    // spawnAgent will succeed (echo exits immediately) but adapter.args must remain unchanged
    try {
      const agent = spawnAgent(adapter, {
        cwd: process.cwd(),
        extraArgs: adapter.autoApproveArgs,
      });
      agent.kill();
    } catch {
      // Expected - echo doesn't speak ACP protocol
    }

    expect(adapter.args).toEqual(originalArgs);
  });
});

// ============================================================================
// Integration Tests - Args passed to spawned process
// ============================================================================

describe("Auto-approve args integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @ralph-adapter-auto-approve ac-1, ac-2
  it("passes adapter autoApproveArgs to spawned agent with --yolo", async () => {
    const argsFile = path.join(tempDir, "verify-args.json");

    const adapter: AgentAdapter = {
      command: "node",
      args: [MOCK_ACP],
      autoApproveArgs: ["--test-auto-approve-flag"],
    };

    const agent = spawnAgent(adapter, {
      cwd: tempDir,
      extraArgs: adapter.autoApproveArgs,
      env: { MOCK_ACP_VERIFY_ARGS_FILE: argsFile },
    });

    // Send initialize to trigger the mock to write args
    await agent.client.initialize();
    await cleanShutdown(agent);

    const args = JSON.parse(await fs.readFile(argsFile, "utf-8"));
    // process.argv includes [node, script, ...extraArgs]
    expect(args).toContain("--test-auto-approve-flag");
    // Original mock ACP path should be there too
    expect(args.some((a: string) => a.includes("acp-mock.js"))).toBe(true);
  });

  // AC: @ralph-adapter-auto-approve ac-3
  it("passes no extra args when extraArgs is undefined", async () => {
    const argsFile = path.join(tempDir, "verify-args.json");

    const adapter: AgentAdapter = {
      command: "node",
      args: [MOCK_ACP],
      autoApproveArgs: ["--should-not-appear"],
    };

    // Spawn WITHOUT extraArgs (simulates --no-yolo)
    const agent = spawnAgent(adapter, {
      cwd: tempDir,
      env: { MOCK_ACP_VERIFY_ARGS_FILE: argsFile },
    });

    await agent.client.initialize();
    await cleanShutdown(agent);

    const args = JSON.parse(await fs.readFile(argsFile, "utf-8"));
    expect(args).not.toContain("--should-not-appear");
  });

  // AC: @ralph-adapter-auto-approve ac-4
  it("worker and reviewer get independent auto-approve args (no leakage)", async () => {
    const workerArgsFile = path.join(tempDir, "worker-args.json");
    const reviewerArgsFile = path.join(tempDir, "reviewer-args.json");

    const adapter: AgentAdapter = {
      command: "node",
      args: [MOCK_ACP],
      autoApproveArgs: ["--auto-flag-1", "--auto-flag-2"],
    };

    // Spawn "worker" with auto-approve args
    const worker = spawnAgent(adapter, {
      cwd: tempDir,
      extraArgs: adapter.autoApproveArgs,
      env: { MOCK_ACP_VERIFY_ARGS_FILE: workerArgsFile },
    });

    await worker.client.initialize();
    await cleanShutdown(worker);

    // Spawn "reviewer" with auto-approve args (independent spawn)
    const reviewer = spawnAgent(adapter, {
      cwd: tempDir,
      extraArgs: adapter.autoApproveArgs,
      env: { MOCK_ACP_VERIFY_ARGS_FILE: reviewerArgsFile },
    });

    await reviewer.client.initialize();
    await cleanShutdown(reviewer);

    // Both should have the auto-approve args
    const workerArgs = JSON.parse(await fs.readFile(workerArgsFile, "utf-8"));
    const reviewerArgs = JSON.parse(await fs.readFile(reviewerArgsFile, "utf-8"));

    expect(workerArgs).toContain("--auto-flag-1");
    expect(workerArgs).toContain("--auto-flag-2");
    expect(reviewerArgs).toContain("--auto-flag-1");
    expect(reviewerArgs).toContain("--auto-flag-2");

    // Verify adapter.args was NOT mutated (no leakage from worker to reviewer)
    expect(adapter.args).toEqual([MOCK_ACP]);
  });
});
