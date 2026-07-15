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
 *   @runner-invocation-semantics
 *     ac-skill-formatting-uses-resolved-adapter
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
// fs is used only for fs.access in the "no session directory" check.

import { runInvocation, RunnerResolutionError } from "../src/agent-runtime/invocation.js";
import * as spawnerModule from "../src/agents/spawner.js";
import * as storeModule from "../src/sessions/store.js";
import { getAdapter, registerAdapter } from "../src/agents/adapters.js";
import type { AgentAdapter } from "../src/agents/adapters.js";
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

  it("releases admitted ownership when the dispatched event cannot be persisted", async () => {
    const agent = makeTestAgent({ adapter: "mock-acp" });
    const sessionId = testUlid("SESS", 9);
    const handoff = {
      invocationId: testUlid("INVK", 9),
      sessionId,
      taskId: null,
      agentId: agent.id,
      adapter: "mock-acp",
      ownerInstanceId: testUlid("OWNR", 9),
    };
    const ownershipFailed = vi.fn<(value: typeof handoff) => void>();
    const originalAppendEvent = storeModule.appendEvent;
    const append = vi.spyOn(storeModule, "appendEvent").mockImplementation(async (dir, input) => {
      if (input.type === "agent.dispatched") throw new Error("injected append failure");
      return originalAppendEvent(dir, input);
    });
    const spawn = vi.spyOn(spawnerModule, "spawnAndInitialize");

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      sessionId,
      cwd: process.cwd(),
      prompt: "Fault before spawn",
      trigger: "task.ready",
      runnerRegistry: { runners: {} },
      beforeCreate: async () => handoff,
      onOwnershipFailed: ownershipFailed,
    });

    expect(result.outcome).toBe("failed");
    expect(ownershipFailed).toHaveBeenCalledOnce();
    expect(ownershipFailed).toHaveBeenCalledWith(handoff);
    expect(spawn).not.toHaveBeenCalled();
    append.mockRestore();
    spawn.mockRestore();
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

// ─── ac-skill-formatting-uses-resolved-adapter ───────────────────────────────

describe("runInvocation: skill formatting uses the resolved adapter", { timeout: 120_000 }, () => {
  let testDir: string;
  let sessionsDir: string;
  let originalCodexAdapter: AgentAdapter | undefined;
  let originalClaudeAdapter: AgentAdapter | undefined;
  let promptCaptureFile: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runner-skill-format-");
    sessionsDir = path.join(testDir, "sessions");
    promptCaptureFile = path.join(testDir, "captured-prompts.jsonl");

    // Snapshot the real adapters so the test can restore them after running.
    originalCodexAdapter = getAdapter("codex-acp");
    originalClaudeAdapter = getAdapter("claude-agent-acp");

    // Replace both production adapters with the mock so a) we can spawn them
    // safely from a unit test and b) tests do not require codex/claude
    // binaries on PATH. The skill formatter still keys off the registered
    // adapter id (claude-agent-acp → claude-code, codex-acp → codex), so
    // overriding the spawn implementation does not change the prompt-rewrite
    // platform the resolver picks.
    const mockSpawn = {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_PROJECT_DIR: process.cwd(),
        MOCK_ACP_VERIFY_PROMPT_FILE: promptCaptureFile,
      },
    } satisfies AgentAdapter;
    registerAdapter("codex-acp", { ...mockSpawn });
    registerAdapter("claude-agent-acp", { ...mockSpawn });
  });

  afterEach(async () => {
    if (originalCodexAdapter) registerAdapter("codex-acp", originalCodexAdapter);
    if (originalClaudeAdapter) registerAdapter("claude-agent-acp", originalClaudeAdapter);
    await cleanupTempDir(testDir);
  });

  async function writeProjectMetaWithSkill(): Promise<void> {
    await fs.writeFile(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Skill Formatter Test" } }),
    );
    await fs.writeFile(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 11),
            id: "helper",
            name: "Helper",
            description: "Project helper skill",
            origin: "project",
          },
          {
            _ulid: testUlid("SKIL", 12),
            id: "other-helper",
            name: "Other Helper",
            description: "A second project helper for cross-skill references",
            origin: "project",
          },
        ],
      }),
    );

    const skillDir = path.join(testDir, "skills", "helper");
    await fs.mkdir(skillDir, { recursive: true });
    // The portable `{skill:other-helper}` reference must be rewritten using
    // the resolved adapter's platform formatter. Claude-style invocation is
    // `/other-helper`; codex-style is `$other-helper`. The two forms are
    // mutually exclusive and easy to distinguish in the captured prompt.
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Helper\n\nWhen extending behavior, use {skill:other-helper}.\n",
    );
  }

  function buildRegistryForAdapter(name: string, adapterId: string): EffectiveRunnerRegistry {
    return mergeRunnerConfigs(null, {
      runners: {
        [name]: { kind: "acp_process", adapter: adapterId },
      },
    });
  }

  async function readCapturedPrompts(): Promise<Array<{ prompt: Array<{ text?: string }> }>> {
    const raw = await readTestOutput(promptCaptureFile);
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { prompt: Array<{ text?: string }> });
  }

  // AC: @runner-invocation-semantics ac-skill-formatting-uses-resolved-adapter
  it("rewrites skill references using the runner's resolved adapter, not agent.adapter", async () => {
    await writeProjectMetaWithSkill();

    // Runner resolves to codex-acp; agent.adapter falsely points at the
    // claude-agent-acp formatter to prove the resolver wins.
    const agent = makeTestAgent({
      id: "skill-format-runner-worker",
      adapter: "claude-agent-acp",
      runner: "codex-runner",
      skills: ["helper"],
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: testDir,
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Drive the helper",
      trigger: "task.ready",
      runnerRegistry: buildRegistryForAdapter("codex-runner", "codex-acp"),
    });

    expect(result.outcome).toBe("success");
    // The resolved adapter is codex-acp (runner-resolved), not the agent's
    // legacy adapter field.
    expect(result.session.agent_type).toBe("codex-acp");

    const prompts = await readCapturedPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    const promptText = prompts[0].prompt
      .map((chunk) => (typeof chunk.text === "string" ? chunk.text : ""))
      .join("");

    // The runner resolved to codex-acp, so skill references must use
    // codex-style invocation (`$other-helper`), NOT claude-style
    // (`/other-helper`). The portable `{skill:...}` token must also be
    // rewritten — if rewriting were skipped, both forms would be absent and
    // the literal token would still be present.
    expect(promptText).toContain("$other-helper");
    expect(promptText).not.toContain("/other-helper");
    expect(promptText).not.toContain("{skill:other-helper}");
  });

  // AC: @runner-invocation-semantics ac-skill-formatting-uses-resolved-adapter
  it("rewrites skill references using agent.adapter on the legacy/implicit path", async () => {
    await writeProjectMetaWithSkill();

    // No runner configured — the implicit path resolves agent.adapter
    // (claude-agent-acp), so skill formatting must use claude-style refs.
    const agent = makeTestAgent({
      id: "skill-format-legacy-worker",
      adapter: "claude-agent-acp",
      runner: undefined,
      skills: ["helper"],
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: testDir,
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Drive the helper",
      trigger: "task.ready",
      runnerRegistry: { runners: {} },
    });

    expect(result.outcome).toBe("success");
    expect(result.session.agent_type).toBe("claude-agent-acp");

    const prompts = await readCapturedPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    const promptText = prompts[0].prompt
      .map((chunk) => (typeof chunk.text === "string" ? chunk.text : ""))
      .join("");

    expect(promptText).toContain("/other-helper");
    expect(promptText).not.toContain("$other-helper");
    expect(promptText).not.toContain("{skill:other-helper}");
  });
});
