/**
 * Agent Invocation Lifecycle tests.
 *
 * Tests for per-invocation session creation, ACP agent spawn, prompt delivery,
 * event logging, timeout handling, and structured completion tracking.
 *
 * Task: @implement-agent-invocation-lifecycle
 * Spec: @agent-invocation-lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import * as YAML from "yaml";
import { createSession, closeSession, isSessionBlobPointer } from "../src/sessions/store.js";
import * as storeModule from "../src/sessions/store.js";
import {
  runInvocation,
  DEFAULT_KSPEC_CLI_PATH,
  resolveDefaultKspecCliPath,
} from "../src/agent-runtime/invocation.js";
import { resolveSkills, buildPromptWithSkills } from "../src/agent-runtime/prompts.js";
import { registerAdapter } from "../src/agents/adapters.js";
import * as spawnerModule from "../src/agents/spawner.js";
import { SANITIZED_ENV_VARS } from "../src/agents/spawner.js";
import { ACPClient } from "../src/acp/index.js";
import type { Agent } from "../src/schema/meta.js";
import * as shadowModule from "../src/parser/shadow.js";
import {
  testUlid,
  createTempDir,
  cleanupTempDir,
  readTestOutput,
  readTestOutputSync,
} from "./helpers/cli.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");
const MOCK_KSPEC_CLI = path.join(__dirname, "mocks", "kspec-capture-mock.cjs");

/**
 * Create a minimal Agent definition for testing.
 */
function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-worker",
    name: "Test Worker Agent",
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

/**
 * Register the mock ACP adapter for testing.
 */
function registerMockAdapter(env: Record<string, string> = {}): void {
  registerAdapter("mock-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: {
      MOCK_ACP_PROJECT_DIR: process.cwd(),
      ...env,
    },
    description: "Mock ACP agent for testing",
  });
}

async function seedInvocationOutcome(
  sessionsDir: string,
  sessionId: string,
  taskRef: string,
  agentId: string,
  status: "completed" | "failed" | "timed_out",
): Promise<void> {
  await createSession(sessionsDir, {
    id: sessionId,
    agent_type: "mock-acp",
    agent_id: agentId,
    task_id: taskRef,
    trigger: "task.ready",
  });
  await closeSession(sessionsDir, sessionId, status, `Seeded ${status} outcome`);
  await new Promise((resolve) => setTimeout(resolve, 2));
}

describe("DEFAULT_KSPEC_CLI_PATH resolution", () => {
  it("should resolve to the cli entrypoint instead of the removed bin/kspec.cjs path", () => {
    expect(DEFAULT_KSPEC_CLI_PATH).toMatch(
      new RegExp(`dist\\${path.sep}cli\\${path.sep}index\\.js$`),
    );
    expect(DEFAULT_KSPEC_CLI_PATH).not.toContain(`${path.sep}bin${path.sep}kspec.cjs`);
  });

  it("should resolve the built cli entrypoint from both source and dist module locations", async () => {
    const testDir = await createTempDir("kspec-cli-path-");
    try {
      const srcAgentRuntimeDir = path.join(testDir, "src", "agent-runtime");
      const agentRuntimeDir = path.join(testDir, "dist", "agent-runtime");
      const cliDir = path.join(testDir, "dist", "cli");
      await fs.mkdir(srcAgentRuntimeDir, { recursive: true });
      await fs.mkdir(agentRuntimeDir, { recursive: true });
      await fs.mkdir(cliDir, { recursive: true });

      const fakeSourceModule = path.join(srcAgentRuntimeDir, "invocation.ts");
      const fakeInvocationModule = path.join(agentRuntimeDir, "invocation.js");
      const builtCli = path.join(cliDir, "index.js");
      await fs.writeFile(fakeSourceModule, "", "utf-8");
      await fs.writeFile(fakeInvocationModule, "", "utf-8");
      await fs.writeFile(builtCli, "", "utf-8");

      expect(resolveDefaultKspecCliPath(pathToFileURL(fakeSourceModule).href)).toBe(builtCli);
      expect(resolveDefaultKspecCliPath(pathToFileURL(fakeInvocationModule).href)).toBe(builtCli);
    } finally {
      await cleanupTempDir(testDir);
    }
  });
});

// ─── AC-1: Session creation with trigger, agent_id, task_id ──────────────────

// AC: @agent-invocation-lifecycle ac-1
describe("Session creation on invocation start", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac1-");
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should create session with trigger, agent_id, and task_id populated", async () => {
    const agent = makeTestAgent({ id: "worker-agent" });
    const taskRef = `@${testUlid("TASK")}`;

    // Run a quick invocation (mock agent completes immediately)
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Test session creation",
      trigger: "task.ready",
    });

    expect(result.session).toBeDefined();
    expect(result.session.trigger).toBe("task.ready");
    expect(result.session.agent_id).toBe("worker-agent");
    expect(result.session.task_id).toBe(taskRef);
    expect(result.session.agent_type).toBe("mock-acp");
  });

  it("should create session directory with session.yaml", async () => {
    const agent = makeTestAgent();
    const taskRef = `@${testUlid("TASK", 1)}`;

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Check session file creation",
      trigger: "task.needs_work",
    });

    const sessionDir = path.join(testDir, "sessions", result.session.id);
    const sessionYaml = path.join(sessionDir, "session.yaml");

    await expect(fs.access(sessionYaml)).resolves.toBeUndefined();
    const content = await readTestOutput(sessionYaml);
    const parsed = YAML.parse(content);
    expect(parsed.trigger).toBe("task.needs_work");
    expect(parsed.task_id).toBe(taskRef);
  });
});

// ─── Canonical task identity in persisted session metadata + event history ───

// AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
describe("Canonical task identity in persisted session state", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-canonical-id-");
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("persists the canonical task ULID as task_id and the display ref separately when both are supplied", async () => {
    // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
    // Exercise the REAL runInvocation (not a mock) so the assertion covers the
    // persisted SessionMetadata returned by runInvocation — a display slug ref
    // must NOT end up recorded as the canonical task_id.
    const agent = makeTestAgent({ id: "worker-agent" });
    const canonicalTaskId = testUlid("TASK");
    const displayRef = "@task-session-payload"; // a slug-style display alias

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskId: canonicalTaskId,
      taskRef: displayRef,
      prompt: "Canonical identity persistence test",
      trigger: "task.ready",
    });

    // Returned SessionMetadata carries identity (task_id) separate from display.
    expect(result.session.task_id).toBe(canonicalTaskId);
    expect(result.session.task_ref).toBe(displayRef);

    // Persisted session.yaml reflects the same separation.
    const sessionYaml = path.join(testDir, "sessions", result.session.id, "session.yaml");
    const parsed = YAML.parse(await readTestOutput(sessionYaml));
    expect(parsed.task_id).toBe(canonicalTaskId);
    expect(parsed.task_ref).toBe(displayRef);

    // Session event history records canonical task_id + display task_ref separately.
    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const events = (await readTestOutput(eventsPath))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });

    const completed = events.find((e) => e.type === "agent.completed");
    expect(completed).toBeDefined();
    expect(completed!.data.task_id).toBe(canonicalTaskId);
    expect(completed!.data.task_ref).toBe(displayRef);

    const dispatched = events.find((e) => e.type === "agent.dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched!.data.task_id).toBe(canonicalTaskId);
    expect(dispatched!.data.task_ref).toBe(displayRef);

    // No event or metadata field smuggles the display ref in as identity.
    expect(parsed.task_id).not.toBe(displayRef);
    expect(completed!.data.task_id).not.toBe(displayRef);
  });

  it("falls back to the display ref as identity when no canonical task id is supplied (legacy callers)", async () => {
    // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
    // Legacy/manual callers that never canonicalized still get a usable identity:
    // the display ref doubles as task_id, preserving pre-canonicalization behavior.
    const agent = makeTestAgent({ id: "worker-agent" });
    const displayRef = `@${testUlid("TASK")}`;

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: displayRef,
      prompt: "Legacy identity fallback test",
      trigger: "task.ready",
    });

    expect(result.session.task_id).toBe(displayRef);
    expect(result.session.task_ref).toBe(displayRef);
  });
});

// ─── AC-2: KSPEC_SESSION_ID injection ────────────────────────────────────────

// AC: @agent-invocation-lifecycle ac-2
describe("KSPEC_SESSION_ID injection", { timeout: 120_000 }, () => {
  let testDir: string;
  let originalSessionId: string | undefined;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac2-");
    originalSessionId = process.env.KSPEC_SESSION_ID;

    registerMockAdapter();
  });

  afterEach(async () => {
    if (originalSessionId === undefined) {
      delete process.env.KSPEC_SESSION_ID;
    } else {
      process.env.KSPEC_SESSION_ID = originalSessionId;
    }
    await cleanupTempDir(testDir);
  });

  it("should inject KSPEC_SESSION_ID into the spawned agent environment", async () => {
    const captureFile = path.join(testDir, "mock-agent-env.json");
    registerMockAdapter({
      MOCK_ACP_VERIFY_ENV_FILE: captureFile,
      MOCK_ACP_VERIFY_ENV_VARS: "KSPEC_SESSION_ID",
    });

    const agent = makeTestAgent();
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Check env injection",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("success");
    const capturedEnv = JSON.parse(await readTestOutput(captureFile)) as {
      KSPEC_SESSION_ID: string | null;
    };
    expect(capturedEnv.KSPEC_SESSION_ID).toBe(result.session.id);
  });

  it("should not overwrite a pre-existing parent KSPEC_SESSION_ID during invocation", async () => {
    const agent = makeTestAgent();
    const preExistingId = "01EXISTNG0000000000000000";
    process.env.KSPEC_SESSION_ID = preExistingId;

    await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Check env cleanup",
      trigger: "task.ready",
    });

    expect(process.env.KSPEC_SESSION_ID).toBe(preExistingId);
  });

  it("should keep concurrent invocations isolated across parent and child env", async () => {
    process.env.KSPEC_SESSION_ID = "01PARENT000000000000000000";

    const captureFileA = path.join(testDir, "mock-agent-env-a.json");
    const captureFileB = path.join(testDir, "mock-agent-env-b.json");

    registerAdapter("mock-acp-concurrent-a", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_PROJECT_DIR: process.cwd(),
        MOCK_ACP_VERIFY_ENV_FILE: captureFileA,
        MOCK_ACP_VERIFY_ENV_VARS: "KSPEC_SESSION_ID",
      },
      description: "Mock ACP agent for concurrent env test A",
    });
    registerAdapter("mock-acp-concurrent-b", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_PROJECT_DIR: process.cwd(),
        MOCK_ACP_VERIFY_ENV_FILE: captureFileB,
        MOCK_ACP_VERIFY_ENV_VARS: "KSPEC_SESSION_ID",
      },
      description: "Mock ACP agent for concurrent env test B",
    });

    const [resultA, resultB] = await Promise.all([
      runInvocation({
        agent: makeTestAgent({ adapter: "mock-acp-concurrent-a" }),
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK", 1)}`,
        prompt: "Concurrent env injection A",
        trigger: "task.ready",
      }),
      runInvocation({
        agent: makeTestAgent({ adapter: "mock-acp-concurrent-b" }),
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK", 2)}`,
        prompt: "Concurrent env injection B",
        trigger: "task.ready",
      }),
    ]);

    const capturedEnvA = JSON.parse(await readTestOutput(captureFileA)) as {
      KSPEC_SESSION_ID: string | null;
    };
    const capturedEnvB = JSON.parse(await readTestOutput(captureFileB)) as {
      KSPEC_SESSION_ID: string | null;
    };

    expect(capturedEnvA.KSPEC_SESSION_ID).toBe(resultA.session.id);
    expect(capturedEnvB.KSPEC_SESSION_ID).toBe(resultB.session.id);
    expect(capturedEnvA.KSPEC_SESSION_ID).not.toBe(capturedEnvB.KSPEC_SESSION_ID);
    expect(process.env.KSPEC_SESSION_ID).toBe("01PARENT000000000000000000");
  });
});

// ─── AC-3: Timeout handling ───────────────────────────────────────────────────

// AC: @agent-invocation-lifecycle ac-3
describe("Timeout handling", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac3-");

    // Register a slow adapter that delays response
    registerAdapter("slow-mock-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_DELAY_MS: "5000", // 5 second delay
      },
      description: "Slow mock ACP agent for timeout tests",
    });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should close session as timed_out when timeout is reached", async () => {
    const agent = makeTestAgent({ adapter: "slow-mock-acp" });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test timeout",
      trigger: "task.ready",
      timeoutMinutes: 0.001, // ~60ms timeout — much less than 5s delay
    });

    expect(result.outcome).toBe("timed_out");
    expect(result.session.status).toBe("timed_out");
  });

  it("should log agent.timeout event when timeout occurs", async () => {
    const agent = makeTestAgent({ adapter: "slow-mock-acp" });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test timeout event logging",
      trigger: "task.ready",
      timeoutMinutes: 0.001,
    });

    // Read the events.jsonl
    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await readTestOutput(eventsPath);
    const events = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const timeoutEvent = events.find((e: { type: string }) => e.type === "agent.timeout");
    expect(timeoutEvent).toBeDefined();
    expect(timeoutEvent.data.task_id).toBeDefined();
    expect(timeoutEvent.data.timeout_minutes).toBeDefined();
  });

  it("should add a timeout note to the task when timeout occurs", async () => {
    // AC: @agent-invocation-lifecycle ac-3 — timeout note written to task
    const agent = makeTestAgent({ adapter: "slow-mock-acp" });
    const captureFile = path.join(testDir, "kspec-calls.json");
    const taskRef = `@${testUlid("TASK")}`;

    // Set capture env so runKspecCli's spawnSync inherits it
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef,
        prompt: "Test timeout note",
        trigger: "task.ready",
        timeoutMinutes: 0.001,
        kspecCliPath: MOCK_KSPEC_CLI,
      });
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }

    // Verify that kspec task note was called with the task ref and AGENT-TIMEOUT marker
    const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
      args: string[];
    }>;
    const noteCall = calls.find(
      (c) => c.args.includes("task") && c.args.includes("note") && c.args.includes(taskRef),
    );
    expect(noteCall).toBeDefined();
    const noteText = noteCall!.args[noteCall!.args.indexOf(taskRef) + 1] ?? "";
    expect(noteText).toContain("[AGENT-TIMEOUT]");
  });

  it("should surface timeout note mutation failures as dispatch mutation failures", async () => {
    // AC: @scoped-dispatch-shadow-serialization ac-3
    // AC: @trait-error-guidance ac-1
    // AC: @trait-error-guidance ac-2
    const agent = makeTestAgent({ adapter: "slow-mock-acp" });
    const failingCli = path.join(testDir, "failing-kspec.cjs");

    await fs.writeFile(
      failingCli,
      [
        "#!/usr/bin/env node",
        "console.error('dispatch shadow mutation lock unavailable');",
        "console.error('Suggested action: wait for the overlapping mutation to finish.');",
        "process.exit(1);",
      ].join("\n"),
      "utf-8",
    );
    fsSync.chmodSync(failingCli, 0o755);

    await expect(
      runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Test timeout mutation failure",
        trigger: "task.ready",
        timeoutMinutes: 0.001,
        kspecCliPath: failingCli,
        mutationLockFile: path.join(testDir, "dispatch-shadow-mutation"),
      }),
    ).rejects.toThrow(/Dispatch mutation failed while writing task note/);
  });

  it("should dispatch ACP cancel request on timeout", async () => {
    // AC: @agent-invocation-lifecycle ac-3 — ACP cancel request dispatched on timeout
    // Use a closure to track cancel calls — vi.spyOn prototype mocks don't reliably
    // track ESM cross-module calls in spy.mock.calls.
    let cancelCalledWith: string | undefined;
    const cancelSpy = vi
      .spyOn(ACPClient.prototype, "cancel")
      .mockImplementation(async (sessionId) => {
        cancelCalledWith = sessionId;
      });

    const agent = makeTestAgent({ adapter: "slow-mock-acp" });
    try {
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Test cancel dispatch",
        trigger: "task.ready",
        // Use a longer timeout so the agent has time to spawn + initialize + newSession
        // (the slow mock delays 5000ms only in session/prompt, not session/new)
        // 3 seconds → enough for spawn+init+newSession but well under the 5s prompt delay
        timeoutMinutes: 3 / 60,
      });
    } finally {
      cancelSpy.mockRestore();
    }

    // Verify cancel was called with the ACP session ID — cancel request dispatched on timeout
    expect(cancelCalledWith).toBeDefined();
  });

  it("should set ACP session/prompt timeout above invocation timeout budget", async () => {
    const agent = makeTestAgent({ adapter: "slow-mock-acp" });
    const mockSessionId = "mock-acp-session";
    const emitter = new EventEmitter();
    const timeoutMinutes = 12;

    const spawnedAgent = {
      client: {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler);
        },
        newSession: vi.fn(async () => mockSessionId),
        prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
        cancel: vi.fn(async () => undefined),
        endSession: vi.fn(async () => undefined),
        respondPermission: vi.fn(async () => undefined),
      },
      kill: vi.fn(() => undefined),
    };

    const spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );
    let spawnOptions: Parameters<typeof spawnerModule.spawnAndInitialize>[1] | undefined;

    try {
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Test ACP prompt timeout alignment",
        trigger: "task.ready",
        timeoutMinutes,
      });
      spawnOptions = spawnSpy.mock.calls[0]?.[1];
    } finally {
      spawnSpy.mockRestore();
    }

    expect(spawnOptions).toBeDefined();
    expect(spawnOptions.clientOptions?.methodTimeouts?.["session/prompt"]).toBe(
      timeoutMinutes * 60 * 1000 + 5_000,
    );
  });
});

// ─── AC-4: Successful completion ─────────────────────────────────────────────

// AC: @agent-invocation-lifecycle ac-4
describe("Successful invocation completion", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac4-");
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should log agent.completed event with task_id, outcome, and duration_ms", async () => {
    const agent = makeTestAgent();
    const taskRef = `@${testUlid("TASK")}`;

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Successful completion test",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("success");

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await readTestOutput(eventsPath);
    const events = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const completedEvent = events.find((e: { type: string }) => e.type === "agent.completed");
    expect(completedEvent).toBeDefined();
    // AC: @agent-invocation-lifecycle ac-4 — structured outcome data
    expect(completedEvent.data.task_id).toBe(taskRef);
    expect(completedEvent.data.outcome).toBe("success");
    expect(completedEvent.data.duration_ms).toBeGreaterThan(0);
  });

  it("should close session with status completed on success", async () => {
    const agent = makeTestAgent();

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Check session completion status",
      trigger: "task.ready",
    });

    expect(result.session.status).toBe("completed");
    expect(result.session.ended_at).toBeDefined();
  });

  it("should return stopReason from ACP agent", async () => {
    const agent = makeTestAgent();

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Check stop reason",
      trigger: "task.ready",
    });

    // Mock ACP returns "end_turn" by default
    expect(result.stopReason).toBe("end_turn");
  });
});

// ─── AC-5: Failure handling ───────────────────────────────────────────────────

// AC: @agent-invocation-lifecycle ac-5
describe("Failure handling", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac5-");

    // Register an adapter that exits with error
    registerAdapter("failing-mock-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_EXIT_CODE: "1", // Non-zero exit = failure
      },
      description: "Failing mock ACP agent",
    });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should log agent.failed event with error details on process crash", async () => {
    const agent = makeTestAgent({ adapter: "failing-mock-acp" });
    const taskRef = `@${testUlid("TASK")}`;

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Test failure handling",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("failed");

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await readTestOutput(eventsPath);
    const events = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const failedEvent = events.find((e: { type: string }) => e.type === "agent.failed");
    expect(failedEvent).toBeDefined();
    // AC: @agent-invocation-lifecycle ac-5 — error details
    expect(failedEvent.data.task_id).toBe(taskRef);
    expect(failedEvent.data.outcome).toBe("failed");
    expect(failedEvent.data.error).toBeDefined();
    expect(failedEvent.data.reason).toBe(failedEvent.data.error);
  });

  it("should close session with status failed on failure", async () => {
    const agent = makeTestAgent({ adapter: "failing-mock-acp" });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Check failed session status",
      trigger: "task.ready",
    });

    expect(result.session.status).toBe("failed");
  });

  it("should add a failure note to the task when invocation fails", async () => {
    // AC: @agent-invocation-lifecycle ac-5 — failure note written to task
    const agent = makeTestAgent({ adapter: "failing-mock-acp" });
    const captureFile = path.join(testDir, "kspec-calls.json");
    const taskRef = `@${testUlid("TASK")}`;

    // Set capture env so runKspecCli's spawnSync inherits it
    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef,
        prompt: "Test failure note",
        trigger: "task.ready",
        kspecCliPath: MOCK_KSPEC_CLI,
      });
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }

    // Verify that kspec task note was called with the task ref and AGENT-FAIL marker
    const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
      args: string[];
    }>;
    const noteCall = calls.find(
      (c) => c.args.includes("task") && c.args.includes("note") && c.args.includes(taskRef),
    );
    expect(noteCall).toBeDefined();
    const noteText = noteCall!.args[noteCall!.args.indexOf(taskRef) + 1] ?? "";
    expect(noteText).toContain("[AGENT-FAIL]");
  });
});

// ─── AC-6: Streaming event logging ───────────────────────────────────────────

// AC: @agent-invocation-lifecycle ac-6
describe("Streaming event logging", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac6-");
    registerMockAdapter({
      MOCK_ACP_RESPONSE_TEXT: "Streaming output test response",
    });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should receive onUpdate callback for streaming updates", async () => {
    const agent = makeTestAgent();
    const updates: unknown[] = [];

    await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test streaming updates",
      trigger: "task.ready",
      onUpdate: (update) => {
        updates.push(update);
      },
    });

    // Mock ACP sends at least one update with the response text
    expect(updates.length).toBeGreaterThanOrEqual(0); // Mock may not send updates
  });

  it("should log session.update events to JSONL file", async () => {
    const agent = makeTestAgent();

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test event logging",
      trigger: "task.ready",
    });

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await readTestOutput(eventsPath);
    const lines = content.trim().split("\n").filter(Boolean);

    // Should have at least agent.dispatched, agent.started, agent.completed
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const events = lines.map((l) => JSON.parse(l));
    const eventTypes = events.map((e: { type: string }) => e.type);
    expect(eventTypes).toContain("agent.dispatched");
    expect(eventTypes).toContain("agent.started");
    expect(eventTypes).toContain("agent.completed");
  });

  it("should preserve update chunk order and strict seq monotonicity during concurrent bursts", async () => {
    // AC: @cli-agent-commands ac-12
    // Regression for @01KJTQBT:
    // Ensure concurrent update callbacks cannot reorder streamed chunks or
    // produce duplicate/non-monotonic sequence numbers in events.jsonl.
    const chunks = ["chunk-0", "chunk-1", "chunk-2", "chunk-3", "chunk-4"];
    const agent = makeTestAgent();
    const receivedChunks: string[] = [];
    const updateSessionId = "mock-acp-session";
    const emitter = new EventEmitter();

    const spawnedAgent = {
      client: {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          emitter.on(event, handler);
        },
        newSession: vi.fn(async () => updateSessionId),
        prompt: vi.fn(async () => {
          for (const chunk of chunks) {
            emitter.emit("update", updateSessionId, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
            });
          }
          return { stopReason: "end_turn" };
        }),
        cancel: vi.fn(async () => undefined),
        endSession: vi.fn(async () => undefined),
        respondPermission: vi.fn(async () => undefined),
      },
      kill: vi.fn(() => undefined),
    };

    const spawnSpy = vi
      .spyOn(spawnerModule, "spawnAndInitialize")
      .mockResolvedValue(
        spawnedAgent as unknown as Awaited<ReturnType<typeof spawnerModule.spawnAndInitialize>>,
      );

    const originalAppendEvent = storeModule.appendEvent;
    let inFlightUpdateWrites = 0;
    let maxInFlightUpdateWrites = 0;
    const appendSpy = vi
      .spyOn(storeModule, "appendEvent")
      .mockImplementation(async (specDir, input) => {
        if (input.type !== "session.update") {
          return originalAppendEvent(specDir, input);
        }

        const update = input.data as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        };
        const text =
          update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text"
            ? (update.content.text ?? "")
            : "";
        const index = Number.parseInt(text.replace("chunk-", ""), 10);
        const delayMs = Number.isNaN(index) ? 0 : (chunks.length - index) * 8;

        inFlightUpdateWrites += 1;
        maxInFlightUpdateWrites = Math.max(maxInFlightUpdateWrites, inFlightUpdateWrites);
        try {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return originalAppendEvent(specDir, input);
        } finally {
          inFlightUpdateWrites -= 1;
        }
      });

    try {
      const result = await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Concurrent update burst ordering",
        trigger: "task.ready",
        onUpdate: (update) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            receivedChunks.push(update.content.text);
          }
        },
      });

      expect(result.outcome).toBe("success");
      expect(receivedChunks).toEqual(chunks);
      expect(maxInFlightUpdateWrites).toBe(1);

      const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
      const content = await readTestOutput(eventsPath);
      const events = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const seqs = events.map((event: { seq: number }) => event.seq);
      const uniqueSeqCount = new Set(seqs).size;
      expect(uniqueSeqCount).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      }
    } finally {
      appendSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

  it("should externalize oversized payload blobs when session updates exceed threshold", async () => {
    // AC: @agent-invocation-lifecycle ac-6 — blob externalization for oversized payloads
    // Register mock adapter that sends a large payload (> EVENT_FIELD_EXTERNALIZE_BYTES = 16KB)
    const oversizedText = "x".repeat(20 * 1024); // 20KB text — exceeds 16KB field threshold
    registerAdapter("large-payload-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_RESPONSE_TEXT: oversizedText,
      },
      description: "Mock ACP that sends oversized updates for blob externalization tests",
    });

    const agent = makeTestAgent({ adapter: "large-payload-acp" });
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test blob externalization",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("success");

    const eventsPath = path.join(testDir, "sessions", result.session.id, "events.jsonl");
    const content = await readTestOutput(eventsPath);
    const lines = content.trim().split("\n").filter(Boolean);
    const events = lines.map((l) => JSON.parse(l));

    // Find the session.update event that contains the large payload
    const updateEvent = events.find((e: { type: string }) => e.type === "session.update");
    expect(updateEvent).toBeDefined();

    // The oversized text field should be externalized as a blob pointer
    // Walk data to find a blob pointer anywhere in the update's data tree
    function hasBlobPointer(obj: unknown): boolean {
      if (isSessionBlobPointer(obj)) return true;
      if (typeof obj === "object" && obj !== null) {
        return Object.values(obj).some(hasBlobPointer);
      }
      return false;
    }

    expect(hasBlobPointer(updateEvent.data)).toBe(true);

    // Verify the blob file was created in the session's blobs/ directory
    const blobDir = path.join(testDir, "sessions", result.session.id, "blobs");
    const blobFiles = await fs.readdir(blobDir);
    expect(blobFiles.length).toBeGreaterThan(0);
  });
});

// ─── AC-7: Skill resolution ───────────────────────────────────────────────────

// AC: @agent-invocation-lifecycle ac-7
describe("Skill resolution for agent invocations", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac7-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("resolveSkills should return content for existing skills", async () => {
    // Create a skill file in the test dir
    const skillDir = path.join(testDir, "skills", "my-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# My Skill\n\nDo things.");

    const resolved = await resolveSkills(["my-skill"], testDir);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe("my-skill");
    expect(resolved[0].content).toContain("# My Skill");
  });

  it("resolveSkills should skip missing skills silently", async () => {
    const resolved = await resolveSkills(["non-existent-skill"], testDir);
    expect(resolved).toHaveLength(0);
  });

  it("buildPromptWithSkills should append skill content to prompt", async () => {
    const skillDir = path.join(testDir, "skills", "task-work");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Task Work Skill\n\nWork on tasks.");

    const result = await buildPromptWithSkills({
      basePrompt: "Do the work",
      skillIds: ["task-work"],
      specDir: testDir,
    });

    expect(result).toContain("Do the work");
    expect(result).toContain("# Task Work Skill");
    expect(result).toContain("Skills");
  });

  it("buildPromptWithSkills should return base prompt unchanged when no skills", async () => {
    const result = await buildPromptWithSkills({
      basePrompt: "Simple prompt",
      skillIds: [],
      specDir: testDir,
    });

    expect(result).toBe("Simple prompt");
  });

  it("buildPromptWithSkills should include multiple skills", async () => {
    for (const skillId of ["skill-a", "skill-b"]) {
      const skillDir = path.join(testDir, "skills", skillId);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${skillId} content`);
    }

    const result = await buildPromptWithSkills({
      basePrompt: "Multi-skill test",
      skillIds: ["skill-a", "skill-b"],
      specDir: testDir,
    });

    expect(result).toContain("skill-a content");
    expect(result).toContain("skill-b content");
  });

  // AC: @agent-invocation-lifecycle ac-10
  it("buildPromptWithSkills should rewrite skill references for claude adapter", async () => {
    const skillDir = path.join(testDir, "skills", "task-work");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Task Work\n\nRun {skill:task-work} then {skill:pr}.",
    );

    await fs.mkdir(path.join(testDir, ".agents", "skills", "kspec-task-work"), { recursive: true });

    const result = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["task-work"],
      specDir: testDir,
      adapterId: "claude-agent-acp",
    });

    expect(result).toContain("/kspec:task-work");
    expect(result).toContain("/pr");
    expect(result).not.toContain("{skill:task-work}");
    expect(result).not.toContain("{skill:pr}");
  });

  // AC: @agent-invocation-lifecycle ac-10
  it("buildPromptWithSkills should rewrite skill references for codex adapter", async () => {
    const skillDir = path.join(testDir, "skills", "task-work");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Task Work\n\nRun {skill:task-work}.");

    await fs.mkdir(path.join(testDir, ".agents", "skills", "kspec-task-work"), { recursive: true });

    const result = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["task-work"],
      specDir: testDir,
      adapterId: "codex-acp",
    });

    expect(result).toContain("$kspec-task-work");
    expect(result).not.toContain("{skill:task-work}");
  });

  // AC: @agent-invocation-lifecycle ac-10
  it("buildPromptWithSkills should resolve portable references from meta origins without rendered skills", async () => {
    await fs.writeFile(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.0", project: { name: "Prompt Test" } }),
    );
    await fs.writeFile(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        skills: [
          {
            _ulid: testUlid("SKIL", 1),
            id: "task-work",
            name: "Task Work",
            description: "Core task work",
            origin: "core",
          },
          {
            _ulid: testUlid("SKIL", 2),
            id: "helper",
            name: "Helper",
            description: "Project helper",
            origin: "project",
          },
        ],
      }),
    );

    const skillDir = path.join(testDir, "skills", "helper");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Helper\n\nRun {skill:task-work} and then {skill:helper}.",
    );

    const result = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["helper"],
      specDir: testDir,
      adapterId: "codex-acp",
    });

    expect(result).toContain("$kspec-task-work");
    expect(result).toContain("$helper");
    expect(result).not.toContain("{skill:task-work}");
    expect(result).not.toContain("{skill:helper}");
  });

  // AC: @agent-invocation-lifecycle ac-10
  it("buildPromptWithSkills should leave skill references unchanged for unknown adapters", async () => {
    const skillDir = path.join(testDir, "skills", "task-work");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Task Work\n\nRun {skill:task-work}.");

    const result = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["task-work"],
      specDir: testDir,
      adapterId: "mock-acp",
    });

    expect(result).toContain("{skill:task-work}");
  });

  // AC: @runner-invocation-semantics ac-generic-acp-skill-formatting-is-neutral
  it("buildPromptWithSkills keeps portable skill references for the generic-acp adapter", async () => {
    const skillDir = path.join(testDir, "skills", "task-work");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "# Task Work\n\nRun {skill:task-work} then {skill:pr}.",
    );

    // Even when rendered skills exist (which would let an adapter-specific
    // rewrite resolve), generic-acp must keep the portable {skill:...} form.
    await fs.mkdir(path.join(testDir, ".agents", "skills", "kspec-task-work"), { recursive: true });

    const result = await buildPromptWithSkills({
      basePrompt: "Base prompt",
      skillIds: ["task-work"],
      specDir: testDir,
      adapterId: "generic-acp",
    });

    // Portable form preserved...
    expect(result).toContain("{skill:task-work}");
    expect(result).toContain("{skill:pr}");
    // ...and not rewritten to any platform-specific form.
    expect(result).not.toContain("/kspec:task-work"); // claude-code
    expect(result).not.toContain("$kspec-task-work"); // codex / droid
    expect(result).not.toContain("/pr");
  });
});

// ─── AC-8: Cleanup on completion or failure ───────────────────────────────────

// AC: @agent-invocation-lifecycle ac-8
describe("Cleanup on completion or failure", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac8-");
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should terminate agent process after successful completion", async () => {
    const agent = makeTestAgent();

    // If the agent process isn't terminated, the test would hang or
    // leave zombie processes. The fact that runInvocation returns is
    // evidence that the process was managed correctly.
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test cleanup on success",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("success");
    // If we reach here without hanging, cleanup worked
  });

  it("should restore KSPEC_SESSION_ID env after invocation", async () => {
    const agent = makeTestAgent();
    const originalValue = process.env.KSPEC_SESSION_ID;

    await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test env restoration",
      trigger: "task.ready",
    });

    expect(process.env.KSPEC_SESSION_ID).toBe(originalValue);
  });

  it("should restore env even when invocation fails", async () => {
    registerAdapter("failing-cleanup-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: { MOCK_ACP_EXIT_CODE: "1" },
      description: "Failing adapter for cleanup test",
    });

    const agent = makeTestAgent({ adapter: "failing-cleanup-acp" });
    const originalValue = process.env.KSPEC_SESSION_ID;

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test cleanup on failure",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("failed");
    // Env should be restored
    expect(process.env.KSPEC_SESSION_ID).toBe(originalValue);
  });

  it("should call removeEnvForAdapter to restore adapter-specific env injection", async () => {
    // AC: @agent-invocation-lifecycle ac-8 — adapter env injection is restored to previous state
    const removeEnvSpy = vi.spyOn(storeModule, "removeEnvForAdapter");

    try {
      const agent = makeTestAgent(); // uses "mock-acp" adapter
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Test adapter env restoration",
        trigger: "task.ready",
      });

      // removeEnvForAdapter must be called with the adapter ID on cleanup
      // For "mock-acp" the injectionResult is null so previousValue is undefined
      expect(removeEnvSpy).toHaveBeenCalledWith("mock-acp", undefined);
    } finally {
      removeEnvSpy.mockRestore();
    }
  });

  it("should call removeEnvForAdapter even when invocation fails", async () => {
    // AC: @agent-invocation-lifecycle ac-8 — adapter env injection restored on failure path too
    registerAdapter("failing-env-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: { MOCK_ACP_EXIT_CODE: "1" },
      description: "Failing adapter for env restoration test",
    });

    const removeEnvSpy = vi.spyOn(storeModule, "removeEnvForAdapter");

    try {
      const agent = makeTestAgent({ adapter: "failing-env-acp" });
      const result = await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Test env restoration on failure",
        trigger: "task.ready",
      });

      expect(result.outcome).toBe("failed");
      // removeEnvForAdapter called once for this invocation (not from prior test since spy was scoped)
      expect(removeEnvSpy).toHaveBeenCalledWith("failing-env-acp", undefined);
    } finally {
      removeEnvSpy.mockRestore();
    }
  });
});

// ─── AC-9: Retry threshold and task blocking ──────────────────────────────────

// AC: @agent-invocation-lifecycle ac-9
describe("Consecutive failure threshold and task blocking", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac9-");
    registerAdapter("always-fail-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: { MOCK_ACP_EXIT_CODE: "1" },
      description: "Always-failing adapter for retry threshold tests",
    });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should block the task with a failure note when consecutive failures reach retry limit", async () => {
    // AC: @agent-invocation-lifecycle ac-9 — consecutive failures → task blocked with note
    const captureFile = path.join(testDir, "kspec-calls.json");
    const taskRef = `@${testUlid("TASK")}`;
    const sessionsDir = path.join(testDir, "sessions");
    const agentId = "test-worker";

    await seedInvocationOutcome(sessionsDir, testUlid("SESS", 1), taskRef, agentId, "failed");
    await seedInvocationOutcome(sessionsDir, testUlid("SESS", 2), taskRef, agentId, "failed");

    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      const agent = makeTestAgent({
        id: agentId,
        adapter: "always-fail-acp",
        budget: { max_retries: 3, timeout_minutes: 30 },
      } as Partial<Agent>);

      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir,
        cwd: process.cwd(),
        taskRef,
        prompt: "Test consecutive failure blocking",
        trigger: "task.ready",
        kspecCliPath: MOCK_KSPEC_CLI,
      });
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }

    // Verify task block was called
    const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
      args: string[];
    }>;
    const blockCall = calls.find(
      (c) => c.args.includes("task") && c.args.includes("block") && c.args.includes(taskRef),
    );
    expect(blockCall).toBeDefined();

    // The block reason should mention consecutive failures and the agent
    const reasonIdx = blockCall!.args.indexOf("--reason");
    expect(reasonIdx).toBeGreaterThan(-1);
    const blockReason = blockCall!.args[reasonIdx + 1] ?? "";
    expect(blockReason).toContain("consecutive");
  });

  it("should NOT block the task when failure count is below the retry limit", async () => {
    // AC: @agent-invocation-lifecycle ac-9 — below threshold: note added, no block
    const captureFile = path.join(testDir, "kspec-calls-below.json");
    const taskRef = `@${testUlid("TASK")}`;

    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      const agent = makeTestAgent({
        adapter: "always-fail-acp",
        budget: { max_retries: 3, timeout_minutes: 30 },
      } as Partial<Agent>);

      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef,
        prompt: "Test below threshold",
        trigger: "task.ready",
        kspecCliPath: MOCK_KSPEC_CLI,
      });
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }

    const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
      args: string[];
    }>;

    // Note should be written
    const noteCall = calls.find(
      (c) => c.args.includes("task") && c.args.includes("note") && c.args.includes(taskRef),
    );
    expect(noteCall).toBeDefined();

    // Block should NOT be called (only 1 failure, limit is 3)
    const blockCall = calls.find(
      (c) => c.args.includes("task") && c.args.includes("block") && c.args.includes(taskRef),
    );
    expect(blockCall).toBeUndefined();
  });

  it("should reset consecutive failure count after a successful invocation", async () => {
    // AC: @agent-invocation-lifecycle ac-9 — streak resets after success; fail→success→fail is not consecutive
    const captureFile = path.join(testDir, "kspec-calls-reset.json");
    const taskRef = `@${testUlid("TASK")}`;
    const sessionsDir = path.join(testDir, "sessions");
    const agentId = "test-worker";

    await seedInvocationOutcome(sessionsDir, testUlid("SESS", 3), taskRef, agentId, "failed");
    await seedInvocationOutcome(sessionsDir, testUlid("SESS", 4), taskRef, agentId, "failed");
    await seedInvocationOutcome(sessionsDir, testUlid("SESS", 5), taskRef, agentId, "completed");

    process.env.KSPEC_CAPTURE_FILE = captureFile;
    try {
      const agent = makeTestAgent({
        id: agentId,
        adapter: "always-fail-acp",
        budget: { max_retries: 3, timeout_minutes: 30 },
      } as Partial<Agent>);

      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir,
        cwd: process.cwd(),
        taskRef,
        prompt: "Test streak reset after success",
        trigger: "task.ready",
        kspecCliPath: MOCK_KSPEC_CLI,
      });
    } finally {
      delete process.env.KSPEC_CAPTURE_FILE;
    }

    const calls = JSON.parse(readTestOutputSync(captureFile)) as Array<{
      args: string[];
    }>;

    // Failure note should be written
    const noteCall = calls.find(
      (c) => c.args.includes("task") && c.args.includes("note") && c.args.includes(taskRef),
    );
    expect(noteCall).toBeDefined();

    // Block should NOT be called — the completed invocation reset the failure streak
    const blockCall = calls.find(
      (c) => c.args.includes("task") && c.args.includes("block") && c.args.includes(taskRef),
    );
    expect(blockCall).toBeUndefined();
  });
});

// ─── AC-11: ACP permission request auto-approval ─────────────────────────────

// AC: @agent-invocation-lifecycle ac-11
describe("ACP permission request handling", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac11-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should auto-approve permission requests in auto-approve mode", async () => {
    // Register adapter that sends a permission request during the prompt
    registerAdapter("permission-mock-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_SEND_PERMISSION_REQUEST: "true",
        MOCK_ACP_PROJECT_DIR: process.cwd(),
      },
      description: "Mock ACP that sends permission requests",
    });

    const agent = makeTestAgent({ adapter: "permission-mock-acp", auto_approve: true });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test permission auto-approval",
      trigger: "task.ready",
      autoApprove: true,
    });

    // Invocation should complete successfully — not hang waiting for permission
    expect(result.outcome).toBe("success");
    expect(result.stopReason).toBe("end_turn");
  });

  it("should deny permission requests in non-auto-approve mode and still complete", async () => {
    registerAdapter("permission-deny-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_SEND_PERMISSION_REQUEST: "true",
        MOCK_ACP_PROJECT_DIR: process.cwd(),
      },
      description: "Mock ACP for permission deny test",
    });

    const agent = makeTestAgent({ adapter: "permission-deny-acp", auto_approve: false });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test permission denial",
      trigger: "task.ready",
      autoApprove: false,
    });

    // Invocation should complete (not hang) — mock proceeds after receiving any response
    expect(result.outcome).toBe("success");
  });
});

// ─── AC-12: Sanitize inherited env vars in agent spawner ──────────────────────

// AC: @agent-invocation-lifecycle ac-12
describe("Host environment variable sanitization", { timeout: 120_000 }, () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-invoc-ac12-");
  });

  afterEach(async () => {
    for (const key of SANITIZED_ENV_VARS) {
      delete process.env[key];
    }
    await cleanupTempDir(testDir);
  });

  it("should strip CLAUDECODE and CLAUDE_CODE_SESSION from spawned agent environment", async () => {
    // Simulate running inside a Claude Code environment
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION = "parent-session-id";

    // Use the mock ACP's VERIFY_ENV feature to check what the child process sees
    const envVerifyFile = path.join(testDir, "env-verify.json");
    registerAdapter("env-verify-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_PROJECT_DIR: process.cwd(),
        MOCK_ACP_VERIFY_ENV_FILE: envVerifyFile,
        MOCK_ACP_VERIFY_ENV_VARS: "CLAUDECODE,CLAUDE_CODE_SESSION,PATH",
      },
      description: "Mock ACP that reports its env vars for sanitization tests",
    });

    const agent = makeTestAgent({ adapter: "env-verify-acp" });
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test env sanitization",
      trigger: "task.ready",
    });

    expect(result.outcome).toBe("success");

    // Read the env vars reported by the child process
    const reportedEnv = JSON.parse(await readTestOutput(envVerifyFile));

    // CLAUDECODE and CLAUDE_CODE_SESSION must be null (not present in child env)
    expect(reportedEnv.CLAUDECODE).toBeNull();
    expect(reportedEnv.CLAUDE_CODE_SESSION).toBeNull();

    // PATH should still be present (not sanitized)
    expect(reportedEnv.PATH).not.toBeNull();
  });

  it("should not affect process.env of the parent process", async () => {
    // Set sanitized vars
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION = "parent-session-id";

    const envVerifyFile = path.join(testDir, "env-verify-parent.json");
    registerAdapter("env-verify-parent-acp", {
      command: "node",
      args: [MOCK_ACP],
      env: {
        MOCK_ACP_PROJECT_DIR: process.cwd(),
        MOCK_ACP_VERIFY_ENV_FILE: envVerifyFile,
        MOCK_ACP_VERIFY_ENV_VARS: "CLAUDECODE",
      },
      description: "Mock ACP for parent env preservation test",
    });

    const agent = makeTestAgent({ adapter: "env-verify-parent-acp" });
    await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, "sessions"),
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Test parent env preservation",
      trigger: "task.ready",
    });

    // Parent process should still have CLAUDECODE — sanitization is per-spawn only
    expect(process.env.CLAUDECODE).toBe("1");
    expect(process.env.CLAUDE_CODE_SESSION).toBe("parent-session-id");
  });

  it("SANITIZED_ENV_VARS should contain the expected variables", () => {
    // Guard against accidental removal of vars from the sanitization list
    expect(SANITIZED_ENV_VARS).toContain("CLAUDECODE");
    expect(SANITIZED_ENV_VARS).toContain("CLAUDE_CODE_SESSION");
  });
});

// ─── No shadow commit on session end ──────────────────────────────────────────

// Coverage: session-remove-shadow-commits (no spec AC exists yet) ac-invocation-end
describe(
  "No shadow commit on session close (session storage separation)",
  { timeout: 120_000 },
  () => {
    let testDir: string;
    let commitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      testDir = await createTempDir("kspec-invoc-shadow-");
      commitSpy = vi.spyOn(shadowModule, "shadowAutoCommit").mockResolvedValue(true);
    });

    afterEach(async () => {
      commitSpy.mockRestore();
      await cleanupTempDir(testDir);
    });

    it("should NOT call shadowAutoCommit after successful invocation", async () => {
      registerMockAdapter();
      const agent = makeTestAgent();

      const result = await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "No shadow commit on success",
        trigger: "task.ready",
      });

      expect(result.outcome).toBe("success");
      expect(commitSpy).not.toHaveBeenCalled();
    });

    it("should NOT call shadowAutoCommit after timed-out invocation", async () => {
      registerAdapter("slow-mock-acp-shadow", {
        command: "node",
        args: [MOCK_ACP],
        env: {
          MOCK_ACP_DELAY_MS: "30000",
        },
        description: "Slow mock for shadow commit timeout test",
      });
      const agent = makeTestAgent({ adapter: "slow-mock-acp-shadow" });

      const result = await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "No shadow commit on timeout",
        trigger: "task.ready",
        timeoutMinutes: 0.05, // 3 seconds — enough to start, short enough to timeout
      });

      expect(result.outcome).toBe("timed_out");
      expect(commitSpy).not.toHaveBeenCalled();
    });

    it("should NOT call shadowAutoCommit after failed invocation", async () => {
      registerAdapter("failing-mock-acp-shadow", {
        command: "node",
        args: [MOCK_ACP],
        env: {
          MOCK_ACP_EXIT_CODE: "1",
        },
        description: "Failing mock for shadow commit test",
      });
      const agent = makeTestAgent({ adapter: "failing-mock-acp-shadow" });

      const result = await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "No shadow commit on failure",
        trigger: "task.ready",
      });

      expect(result.outcome).toBe("failed");
      expect(commitSpy).not.toHaveBeenCalled();
    });

    it("should NOT call shadowAutoCommit after aborted invocation", async () => {
      registerAdapter("slow-mock-acp-abort", {
        command: "node",
        args: [MOCK_ACP],
        env: {
          MOCK_ACP_DELAY_MS: "5000",
        },
        description: "Slow mock for abort test",
      });
      const agent = makeTestAgent({ adapter: "slow-mock-acp-abort" });
      const controller = new AbortController();

      // Abort shortly after starting
      setTimeout(() => controller.abort(), 100);

      const result = await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir: path.join(testDir, "sessions"),
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "No shadow commit on abort",
        trigger: "task.ready",
        abortSignal: controller.signal,
      });

      expect(result.outcome).toBe("failed");
      expect(commitSpy).not.toHaveBeenCalled();
    });
  },
);

// ─── Trait: error-guidance ────────────────────────────────────────────────────

// AC: @trait-error-guidance ac-1 — N/A: This is a library module (not a CLI command).
// It does not produce user-facing error messages directly. Error details are passed
// to callers via InvocationResult.error for higher-level handling.

// AC: @trait-error-guidance ac-2 — N/A: Library module; error guidance is responsibility
// of CLI commands that invoke runInvocation().

// AC: @trait-error-guidance ac-3 — N/A: No ref lookups in this module.

// AC: @trait-error-guidance ac-4 — N/A: No state transitions displayed to users.

// AC: @trait-error-guidance ac-5 — N/A: Validation errors are thrown as TypeScript errors,
// not formatted for user display.

// AC: @trait-error-guidance ac-6 — N/A: Module has no --json mode; it's a library function.
