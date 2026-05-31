/**
 * Integration tests for runner-backed agent invocations.
 *
 * Verifies that runInvocation calls the runner resolver before spawn and
 * records runner identity in session metadata + the agent.dispatched event.
 *
 * Covers:
 *   @runner-resolution-and-preflight
 *     ac-one-shot-uses-runner-resolution
 *     ac-unknown-runner-blocks-before-spawn
 *     ac-unknown-runner-reports-guidance
 *     ac-invalid-runner-blocks-before-prompt
 *     ac-session-metadata-records-runner
 *     ac-dispatched-event-records-runner
 *   @agent-runner-configuration
 *     ac-adapter-field-backcompat
 *     ac-runner-precedence-over-adapter
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
// fs is used only for fs.access in the "no session directory" check.

import { runInvocation, RunnerResolutionError } from "../src/agent-runtime/invocation.js";
import { registerAdapter } from "../src/agents/adapters.js";
import { mergeRunnerConfigs } from "../src/agents/runner-config.js";
import type { EffectiveRunnerRegistry } from "../src/agents/runner-config.js";
import type { Agent } from "../src/schema/meta.js";
import { testUlid, createTempDir, cleanupTempDir, readTestOutput } from "./helpers/cli.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-runner-worker",
    name: "Test Runner Worker",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    adapter: "mock-acp",
    ...overrides,
  };
}

function registerMockAdapter(env: Record<string, string> = {}): void {
  registerAdapter("mock-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: {
      MOCK_ACP_PROJECT_DIR: process.cwd(),
      ...env,
    },
    description: "Mock ACP adapter for runner integration tests",
  });
}

/** Build a registry where the named runner uses the mock adapter. */
function registryWith(name: string): EffectiveRunnerRegistry {
  return mergeRunnerConfigs(null, {
    runners: {
      [name]: { kind: "acp_process", adapter: "mock-acp" },
    },
  });
}

async function readSessionYaml(sessionsDir: string, sessionId: string): Promise<unknown> {
  const sessionYamlPath = path.join(sessionsDir, sessionId, "session.yaml");
  const content = await readTestOutput(sessionYamlPath);
  return YAML.parse(content);
}

async function readEventsJsonl(
  sessionsDir: string,
  sessionId: string,
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const eventsPath = path.join(sessionsDir, sessionId, "events.jsonl");
  const raw = await readTestOutput(eventsPath);
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => JSON.parse(line));
}

// ─── ac-one-shot-uses-runner-resolution ──────────────────────────────────────

describe("runInvocation: runner resolution on one-shot path", { timeout: 120_000 }, () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runner-invoc-");
    sessionsDir = path.join(testDir, "sessions");
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution
  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  it("uses the runner-resolved adapter when the agent has a runner field", async () => {
    const agent = makeTestAgent({
      runner: "primary",
      // adapter intentionally points elsewhere — runner must win.
      adapter: "some-other-adapter",
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Runner-backed invocation",
      trigger: "task.ready",
      runnerRegistry: registryWith("primary"),
    });

    expect(result.outcome).toBe("success");
    // agent_type is the resolved adapter id, which is the runner's adapter
    // (mock-acp) rather than the legacy agent.adapter value.
    expect(result.session.agent_type).toBe("mock-acp");
  });

  // AC: @runner-resolution-and-preflight ac-session-metadata-records-runner
  it("records the runner name in session metadata for runner-backed invocations", async () => {
    const agent = makeTestAgent({ runner: "primary", adapter: undefined });
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Capture runner in metadata",
      trigger: "task.ready",
      runnerRegistry: registryWith("primary"),
    });

    const parsed = (await readSessionYaml(sessionsDir, result.session.id)) as {
      runner?: string;
      agent_type: string;
    };
    expect(parsed.runner).toBe("primary");
    expect(parsed.agent_type).toBe("mock-acp");
  });

  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("omits the runner field from session metadata for legacy adapter-only agents", async () => {
    const agent = makeTestAgent({ adapter: "mock-acp" });
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Legacy adapter only",
      trigger: "task.ready",
      runnerRegistry: { runners: {} },
    });

    const parsed = (await readSessionYaml(sessionsDir, result.session.id)) as {
      runner?: string;
      agent_type: string;
    };
    expect(parsed.runner).toBeUndefined();
    expect(parsed.agent_type).toBe("mock-acp");
  });
});

// ─── ac-dispatched-event-records-runner ──────────────────────────────────────

describe("runInvocation: agent.dispatched event payload", { timeout: 120_000 }, () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runner-dispatched-");
    sessionsDir = path.join(testDir, "sessions");
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
  it("includes runner and adapter on the agent.dispatched event for runner-backed agents", async () => {
    const agent = makeTestAgent({ runner: "primary", adapter: undefined });
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Runner dispatched event",
      trigger: "task.ready",
      runnerRegistry: registryWith("primary"),
    });

    const events = await readEventsJsonl(sessionsDir, result.session.id);
    const dispatched = events.find((e) => e.type === "agent.dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched!.data.runner).toBe("primary");
    // Adapter field stays populated so older consumers continue to work.
    expect(dispatched!.data.adapter).toBe("mock-acp");
    expect(dispatched!.data.agent_id).toBe(agent.id);
  });

  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("omits runner from the agent.dispatched event for legacy adapter-only agents", async () => {
    const agent = makeTestAgent({ adapter: "mock-acp" });
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Legacy dispatched event",
      trigger: "task.ready",
      runnerRegistry: { runners: {} },
    });

    const events = await readEventsJsonl(sessionsDir, result.session.id);
    const dispatched = events.find((e) => e.type === "agent.dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched!.data.runner).toBeUndefined();
    expect(dispatched!.data.adapter).toBe("mock-acp");
  });
});

// ─── ac-unknown-runner-blocks-before-spawn / before-prompt ───────────────────

describe("runInvocation: unknown runner blocks before spawn", { timeout: 30_000 }, () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-unknown-runner-");
    sessionsDir = path.join(testDir, "sessions");
    // Register a mock adapter so the failure cannot be confused with an
    // adapter-resolution failure — the agent references a runner, not the
    // legacy adapter.
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  it("throws RunnerResolutionError when the named runner is missing from the registry", async () => {
    const agent = makeTestAgent({ runner: "absent" });

    try {
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir,
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Should never reach the adapter",
        trigger: "task.ready",
        runnerRegistry: { runners: {} },
      });
      throw new Error("expected runInvocation to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerResolutionError);
      const e = err as RunnerResolutionError;
      expect(e.reason).toBe("unknown_runner");
      // Guidance must mention both project + system layers + agent definition.
      expect(e.message).toMatch(/absent/);
      expect(e.message).toMatch(/project/i);
      expect(e.message).toMatch(/system/i);
      expect(e.message).toMatch(/agent/i);
    }

    // No session directory should exist — the failure happened before
    // createSession ran.
    const sessionsExist = await fs
      .access(sessionsDir)
      .then(() => true)
      .catch(() => false);
    if (sessionsExist) {
      const entries = await fs.readdir(sessionsDir);
      expect(entries).toHaveLength(0);
    }
  });
});
