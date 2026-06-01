/**
 * End-to-end runner compatibility and regression coverage.
 *
 * Threads the runner layer across every boundary the focused per-surface
 * tests touch in isolation: layered config storage and merge, runner
 * resolver, env+secret boundary, runner-aware invocation lifecycle,
 * dispatch preflight, CLI surfaces, and daemon HTTP responses. The goal
 * is to surface regressions that only appear *between* surfaces — for
 * example, when the daemon API drops a field the Web UI mocks rely on,
 * or when the resolver and the CLI disagree about source attribution.
 *
 * Every flow uses temp project directories, fake adapters, and a mock
 * ACP process. Nothing depends on a live `~/Projects/kynetic-spec`
 * checkout or on real Claude/Codex binaries being installed.
 *
 * Covers (Task @task-runner-compatibility-regressions):
 *   @agent-runner-configuration
 *     ac-named-runners-loaded
 *     ac-project-runner-storage-is-repo-managed
 *     ac-system-runner-storage-is-local
 *     ac-system-overrides-project-values
 *     ac-project-layer-accepts-portable-runner-values
 *     ac-project-layer-blocks-known-secret-keys
 *     ac-agent-runner-reference
 *     ac-adapter-field-backcompat
 *     ac-runner-precedence-over-adapter
 *   @runner-resolution-and-preflight
 *     ac-one-shot-uses-runner-resolution
 *     ac-dispatch-uses-runner-resolution
 *     ac-unknown-runner-blocks-before-spawn
 *     ac-session-metadata-records-runner
 *     ac-dispatched-event-records-runner
 *   @runner-environment-secret-boundaries
 *     ac-project-env-literals-are-non-secret
 *     ac-secret-env-names-use-bindings
 *     ac-required-secret-missing-blocks
 *     ac-diagnostics-redact-secrets
 *   @runner-process-invocation-inputs
 *     ac-existing-executable-reference-resolves
 *   @runner-invocation-semantics
 *     ac-dispatch-preflight-accepts-configured-runners
 *     ac-dispatch-preflight-rejects-invalid-runners
 *   @runner-operator-surfaces
 *     ac-daemon-agent-api-includes-runner
 *     ac-daemon-dispatch-active-api-includes-runner
 *     ac-daemon-dispatch-queued-api-includes-runner
 *     ac-web-ui-agent-cards-include-runner
 *     ac-web-ui-active-invocations-include-runner
 *     ac-web-ui-queued-invocations-include-runner
 */

import * as fs from "node:fs/promises";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as YAML from "yaml";

import { runInvocation, RunnerResolutionError } from "../src/agent-runtime/invocation.js";
import { registerAdapter } from "../src/agents/adapters.js";
import {
  deriveProjectKeySync,
  loadProjectRunnerConfig,
  loadSystemRunnerConfig,
  mergeRunnerConfigs,
  resolveEffectiveRunners,
  type EffectiveRunnerRegistry,
} from "../src/agents/runner-config.js";
import { preflightRunnerInvocation, resolveRunnerInvocation } from "../src/agents/runners.js";
import type { Agent } from "../src/schema/meta.js";
import {
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  kspec,
  kspecJson,
  readTestOutput,
  testUlid,
} from "./helpers/cli.js";
import { createTestApp, makeRequest, setupInlineFixtures } from "./daemon-api/helpers.js";
import { getDispatchEngine, stopAllEngines } from "../dist/daemon/routes/agent-dispatch.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");

// A sentinel secret value. Tests assert it never leaks into any serialized
// output: stdout, JSON payloads, session events, diagnostic messages.
// AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
const SECRET_SENTINEL = "e2e-runner-secret-leak-canary-Xq8";

function registerMockAcpAdapter(): void {
  registerAdapter("mock-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: { MOCK_ACP_PROJECT_DIR: process.cwd() },
    description: "Mock ACP adapter for runner compatibility tests",
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "compat-agent",
    name: "Compatibility Test Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    ...overrides,
  };
}

function makeMockRunnerRegistry(name: string): EffectiveRunnerRegistry {
  return mergeRunnerConfigs(null, {
    runners: { [name]: { kind: "acp_process", adapter: "mock-acp" } },
  });
}

interface ProjectFixture {
  projectRoot: string;
  shadowDir: string;
  daemonConfigDir: string;
  homeDir: string;
}

/**
 * Build a temp project with both a shadow worktree marker and an isolated
 * daemon config dir under a fake HOME. Mirrors what the CLI subprocess
 * helper does for tests that need both layer files reachable through the
 * loader contract.
 */
async function createProjectFixture(prefix: string): Promise<ProjectFixture> {
  const projectRoot = await createTempDir(prefix);
  initGitRepo(projectRoot);
  const shadowDir = path.join(projectRoot, ".kspec");
  await fs.mkdir(shadowDir, { recursive: true });
  const homeDir = path.join(projectRoot, ".test-home");
  const daemonConfigDir = path.join(homeDir, ".config", "kspec");
  await fs.mkdir(daemonConfigDir, { recursive: true });
  return { projectRoot, shadowDir, daemonConfigDir, homeDir };
}

async function writeProjectLayer(fixture: ProjectFixture, contents: string): Promise<void> {
  await fs.writeFile(path.join(fixture.shadowDir, "project.runners.yaml"), contents, "utf-8");
}

async function writeSystemLayer(fixture: ProjectFixture, contents: string): Promise<void> {
  const key = deriveProjectKeySync(fixture.projectRoot);
  const dir = path.join(fixture.daemonConfigDir, "projects", key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "runners.yaml"), contents, "utf-8");
}

function makeFakeExecutable(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(filePath, 0o755);
  return filePath;
}

async function readSessionYaml(
  sessionsDir: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const content = await readTestOutput(path.join(sessionsDir, sessionId, "session.yaml"));
  return YAML.parse(content) as Record<string, unknown>;
}

async function readEventsJsonl(
  sessionsDir: string,
  sessionId: string,
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const raw = await readTestOutput(path.join(sessionsDir, sessionId, "events.jsonl"));
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

// ─── Flow 1 + 2: legacy adapter agents still work end-to-end ────────────────

describe("e2e: legacy adapter agents preserve pre-runner behavior", { timeout: 60_000 }, () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runner-e2e-legacy-");
    sessionsDir = path.join(testDir, "sessions");
    registerMockAcpAdapter();
  });
  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  // AC: @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution
  it("runs a one-shot invocation for an adapter-only agent without a runner", async () => {
    const agent = makeAgent({ adapter: "mock-acp" });
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Legacy adapter one-shot",
      trigger: "task.ready",
      runnerRegistry: { runners: {} },
    });

    expect(result.outcome).toBe("success");
    expect(result.session.agent_type).toBe("mock-acp");

    const session = await readSessionYaml(sessionsDir, result.session.id);
    expect(session.agent_type).toBe("mock-acp");
    expect(session.runner).toBeUndefined();

    const events = await readEventsJsonl(sessionsDir, result.session.id);
    const dispatched = events.find((e) => e.type === "agent.dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched!.data.adapter).toBe("mock-acp");
    expect(dispatched!.data.runner).toBeUndefined();
  });

  // AC: @runner-invocation-semantics ac-dispatch-preflight-accepts-configured-runners
  // AC: @runner-resolution-and-preflight ac-dispatch-uses-runner-resolution
  it("passes dispatch preflight for a legacy adapter-only agent", async () => {
    // Mirror the dispatch engine's preflight pipeline: resolve the runner
    // contract against an empty registry (legacy path) and then preflight.
    // No exception means dispatch accepts the agent without a runner.
    const agent = makeAgent({ adapter: "mock-acp" });
    const contract = resolveRunnerInvocation({
      agent,
      registry: { runners: {} },
      cwd: process.cwd(),
      sessionId: testUlid("SESS"),
      autoApprove: false,
      env: {},
    });

    expect(contract.runnerId).toBeNull();
    expect(contract.adapterId).toBe("mock-acp");
    await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();
  });
});

// ─── Flow 3: system-only runner-backed one-shot records runner metadata ─────

describe("e2e: system-only runner-backed one-shot invocation", { timeout: 60_000 }, () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runner-e2e-runner-backed-");
    sessionsDir = path.join(testDir, "sessions");
    registerMockAcpAdapter();
  });
  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-session-metadata-records-runner
  // AC: @runner-resolution-and-preflight ac-dispatched-event-records-runner
  // AC: @agent-runner-configuration ac-agent-runner-reference
  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  it("records runner name and resolved adapter on session metadata and agent.dispatched", async () => {
    // Configure the runner to use mock-acp; agent.adapter is left undefined
    // to prove the resolver carries the runner's adapter through to the
    // session, events, and agent_type fields.
    const registry = makeMockRunnerRegistry("primary");
    const agent = makeAgent({ runner: "primary", adapter: undefined });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir,
      cwd: process.cwd(),
      taskRef: `@${testUlid("TASK")}`,
      prompt: "Runner-backed one-shot",
      trigger: "task.ready",
      runnerRegistry: registry,
    });

    expect(result.outcome).toBe("success");
    expect(result.session.agent_type).toBe("mock-acp");

    const session = await readSessionYaml(sessionsDir, result.session.id);
    expect(session.runner).toBe("primary");
    expect(session.agent_type).toBe("mock-acp");

    const events = await readEventsJsonl(sessionsDir, result.session.id);
    const dispatched = events.find((e) => e.type === "agent.dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched!.data.runner).toBe("primary");
    expect(dispatched!.data.adapter).toBe("mock-acp");
  });
});

// ─── Flow 4: project + system layers merge with overrides + source layers ───

describe("e2e: project + system runner config merge", () => {
  let fixture: ProjectFixture;

  beforeEach(async () => {
    fixture = await createProjectFixture("kspec-runner-e2e-merge-");
  });
  afterEach(async () => {
    await cleanupTempDir(fixture.projectRoot);
  });

  // AC: @agent-runner-configuration ac-named-runners-loaded
  // AC: @agent-runner-configuration ac-project-runner-storage-is-repo-managed
  // AC: @agent-runner-configuration ac-system-runner-storage-is-local
  // AC: @agent-runner-configuration ac-system-overrides-project-values
  // AC: @agent-runner-configuration ac-project-layer-accepts-portable-runner-values
  it("threads both layers through the loader and exposes source attribution per field", async () => {
    await writeProjectLayer(
      fixture,
      `runners:
  configured:
    env:
      set:
        NODE_ENV: production
        LOG_LEVEL: info
    privacy:
      disable_nonessential_traffic: false
`,
    );
    await writeSystemLayer(
      fixture,
      `runners:
  configured:
    kind: acp_process
    adapter: claude-agent-acp
    env:
      set:
        LOG_LEVEL: debug
        EXTRA_FROM_SYSTEM: "1"
    privacy:
      disable_nonessential_traffic: true
`,
    );

    // Layer files were written under the runtime-configured shadow + daemon
    // dirs — the loader must pick them up without any side channel.
    const projectLoad = await loadProjectRunnerConfig(fixture.shadowDir);
    expect(projectLoad.loaded).toBe(true);
    expect(projectLoad.issues).toBeNull();
    const systemLoad = await loadSystemRunnerConfig(fixture.projectRoot, {
      daemonConfigDir: fixture.daemonConfigDir,
    });
    expect(systemLoad.loaded).toBe(true);
    expect(systemLoad.issues).toBeNull();

    const resolved = await resolveEffectiveRunners({
      projectRoot: fixture.projectRoot,
      shadowWorktreeDir: fixture.shadowDir,
      daemonConfigDir: fixture.daemonConfigDir,
    });
    const configured = resolved.registry.runners.configured;
    expect(configured).toBeDefined();
    expect(configured.adapter).toBe("claude-agent-acp");
    // Project value preserved when system did not override it.
    expect(configured.env.set.NODE_ENV).toBe("production");
    // System value won where both layers supplied the same key.
    expect(configured.env.set.LOG_LEVEL).toBe("debug");
    expect(configured.env.set.EXTRA_FROM_SYSTEM).toBe("1");
    // Scalar privacy override flipped to the system value.
    expect(configured.privacy.disable_nonessential_traffic).toBe(true);

    // Per-field source attribution makes the merge legible to operators.
    expect(configured.sources.envSet.keys.NODE_ENV).toBe("project");
    expect(configured.sources.envSet.keys.LOG_LEVEL).toBe("system");
    expect(configured.sources.envSet.keys.EXTRA_FROM_SYSTEM).toBe("system");
    expect(configured.sources.privacyDisableNonessentialTraffic).toBe("system");
    expect(configured.sources.overriddenBySystem).toContain("privacy.disable_nonessential_traffic");
    expect(configured.sources.overriddenBySystem).toContain("env.set.LOG_LEVEL");

    // Resolver-level diagnostics carry the merged source layer label so any
    // downstream surface (CLI, daemon API) can report it without rebuilding
    // the merge logic.
    const agent = makeAgent({ runner: "configured" });
    const contract = resolveRunnerInvocation({
      agent,
      registry: resolved.registry,
      cwd: fixture.projectRoot,
      sessionId: testUlid("SESS"),
      autoApprove: false,
      env: {},
    });
    expect(contract.diagnostics.sourceLayer).toBe("merged");
    expect(contract.diagnostics.overrides).toContain("privacy.disable_nonessential_traffic");
  });
});

// ─── Flow 5: project config containing a known secret is rejected ───────────

describe(
  "e2e: project runner config with known secret keys is rejected",
  { timeout: 60_000 },
  () => {
    let fixture: ProjectFixture;

    beforeEach(async () => {
      fixture = await createProjectFixture("kspec-runner-e2e-projsecret-");
      registerMockAcpAdapter();
    });
    afterEach(async () => {
      await cleanupTempDir(fixture.projectRoot);
    });

    // AC: @agent-runner-configuration ac-project-layer-blocks-known-secret-keys
    // AC: @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret
    // AC: @runner-environment-secret-boundaries ac-secret-env-names-use-bindings
    it("blocks the project layer at load time and flags the offending key", async () => {
      await writeProjectLayer(
        fixture,
        `runners:
  configured:
    env:
      set:
        ANTHROPIC_API_KEY: sk-test
`,
      );
      await writeSystemLayer(
        fixture,
        `runners:
  configured:
    kind: acp_process
    adapter: claude-agent-acp
`,
      );

      const projectLoad = await loadProjectRunnerConfig(fixture.shadowDir);
      expect(projectLoad.loaded).toBe(true);
      // The rejected file produces a null config + issues; loaders never
      // return a partially-parsed payload that could leak into the merge.
      expect(projectLoad.config).toBeNull();
      expect(projectLoad.issues).not.toBeNull();
      const messages = (projectLoad.issues ?? []).map((i) => i.message).join("\n");
      expect(messages).toMatch(/ANTHROPIC_API_KEY/);
    });

    // AC: @agent-runner-configuration ac-project-layer-blocks-known-secret-keys
    // AC: @runner-environment-secret-boundaries ac-project-env-literals-are-non-secret
    it("surfaces project-layer rejections through the CLI runners validate JSON output", async () => {
      // For a non-shadow CLI project, specDir resolves to the project root,
      // so the project runner config lives at <projectRoot>/project.runners.yaml.
      // The kspec helper isolates HOME to <projectRoot>/.test-home/, so the
      // system layer (if any) would be picked up from there.
      writeFileSync(
        path.join(fixture.projectRoot, "kynetic.yaml"),
        YAML.stringify({ kynetic: "1", title: "Test" }),
      );
      writeFileSync(
        path.join(fixture.projectRoot, "kynetic.meta.yaml"),
        YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
      );
      writeFileSync(
        path.join(fixture.projectRoot, "project.tasks.yaml"),
        YAML.stringify({ tasks: [] }),
      );
      writeFileSync(
        path.join(fixture.projectRoot, "project.runners.yaml"),
        `runners:
  configured:
    env:
      set:
        OPENAI_API_KEY: leak-attempt
`,
        "utf-8",
      );

      const result = kspec("agent runners validate --json", fixture.projectRoot, {
        expectFail: true,
      });
      expect(result.exitCode).not.toBe(0);
      const payload = JSON.parse(result.stdout) as {
        ok: boolean;
        issues: Array<{ reason: string; message: string }>;
      };
      expect(payload.ok).toBe(false);
      const messages = payload.issues.map((i) => i.message).join("\n");
      expect(messages).toMatch(/OPENAI_API_KEY/);
    });
  },
);

// ─── Flow 6: runner-backed dispatch diagnostics on daemon status ────────────

describe("e2e: runner-backed dispatch invocation visibility through daemon API", () => {
  let tempDir: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let app: Elysia;

  beforeEach(async () => {
    tempDir = await createTempDir("kspec-runner-e2e-daemon-");
    homeDir = await createTempDir("kspec-runner-e2e-daemon-home-");
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    initGitRepo(tempDir);
    const runnerAgentUlid = testUlid("AGNT", 1);
    const legacyAgentUlid = testUlid("AGNT", 2);
    setupInlineFixtures(tempDir, {
      meta: `kynetic_meta: "1.0"
agents:
  - _ulid: ${runnerAgentUlid}
    id: runner-worker
    name: Runner Worker
    description: Runner-backed worker
    adapter: claude-agent-acp
    runner: configured-runner
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
  - _ulid: ${legacyAgentUlid}
    id: legacy-worker
    name: Legacy Worker
    description: Legacy adapter-only worker
    adapter: claude-agent-acp
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
`,
      splitTasks: [],
    });
    // Place the system runner config under the fake HOME so the daemon
    // project context resolves it.
    const projectKey = deriveProjectKeySync(tempDir);
    const dir = path.join(homeDir, ".config", "kspec", "projects", projectKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "runners.yaml"),
      `runners:
  configured-runner:
    kind: acp_process
    adapter: claude-agent-acp
    env:
      inherit: minimal
      secrets:
        FAKE_API_KEY:
          source: env:KSPEC_TEST_SECRET
          required: false
`,
    );
    process.env.KSPEC_TEST_SECRET = SECRET_SENTINEL;
    ({ app } = createTestApp());
  });

  afterEach(async () => {
    await stopAllEngines();
    delete process.env.KSPEC_TEST_SECRET;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await cleanupTempDir(tempDir);
    await cleanupTempDir(homeDir);
  });

  /**
   * Verify the daemon API emits the exact shape the Web UI agents-route
   * mocks (tests/e2e/agents.spec.ts > Runner Surfaces) rely on. If either
   * side drifts — daemon drops a field or UI mocks add a field daemon
   * never emits — this regression test catches the divergence before
   * production agents render with missing runner identity.
   */
  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  // AC: @runner-operator-surfaces ac-web-ui-agent-cards-include-runner
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("daemon /api/meta/agents emits the field set the Web UI agent cards consume", async () => {
    const response = await makeRequest(app, tempDir, "/api/meta/agents");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    const runnerAgent = body.data.find((a) => a.id === "runner-worker") as Record<string, unknown>;
    expect(runnerAgent).toBeDefined();
    // Fields the Web UI runner surfaces (tests/e2e/agents.spec.ts:514+) read:
    expect(runnerAgent.adapter).toBe("claude-agent-acp");
    expect(runnerAgent.resolved_adapter).toBe("claude-agent-acp");
    expect(runnerAgent.runner).toBe("configured-runner");
    const validation = runnerAgent.runner_validation as {
      status: string;
      diagnostics: unknown[];
    };
    expect(validation).toBeDefined();
    expect(validation.status).toBe("valid");
    expect(Array.isArray(validation.diagnostics)).toBe(true);

    // Legacy agent must keep the adapter field populated and omit runner/
    // runner_validation — Web UI legacy-agent assertions depend on that.
    const legacy = body.data.find((a) => a.id === "legacy-worker") as Record<string, unknown>;
    expect(legacy).toBeDefined();
    expect(legacy.adapter).toBe("claude-agent-acp");
    expect(legacy.resolved_adapter).toBe("claude-agent-acp");
    expect(legacy.runner).toBeUndefined();
    expect(legacy.runner_validation).toBeUndefined();
  });

  // AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
  // AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
  // AC: @runner-operator-surfaces ac-web-ui-active-invocations-include-runner
  // AC: @runner-operator-surfaces ac-web-ui-queued-invocations-include-runner
  it("daemon /api/agent/status emits runner identity on active and queued invocations", async () => {
    await makeRequest(app, tempDir, "/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    interface FakeQueueEntry {
      agent: { id: string; name: string; runner?: string; adapter?: string };
      change: { taskRef: string; toStatus: string };
      retryCount: number;
      nextRetryAt: number;
      enqueuedAtMs: number;
      sequence: number;
      starvationDeferrals: number;
    }
    interface FakeActiveRecord {
      invocationId: string;
      sessionId: string;
      agentId: string;
      agentName: string;
      taskRef: string | undefined;
      role: "worker" | "reviewer";
      startedAtMs: number;
      resolvedAdapter: string;
      runner: string | undefined;
    }
    interface EngineInternals {
      queues: Map<string, FakeQueueEntry[]>;
      activeInvocationDetails: Map<string, FakeActiveRecord>;
      activeCount: Map<string, number>;
      nextQueueSequence: number;
    }

    const engine = getDispatchEngine(tempDir);
    expect(engine).toBeDefined();
    const internal = engine as unknown as EngineInternals;

    // Inject a runner-backed active invocation.
    internal.activeInvocationDetails.set("INVK-runner-active", {
      invocationId: "INVK-runner-active",
      sessionId: "SESS-runner-active",
      agentId: "runner-worker",
      agentName: "Runner Worker",
      taskRef: undefined,
      role: "worker",
      startedAtMs: Date.now() - 1000,
      resolvedAdapter: "claude-agent-acp",
      runner: "configured-runner",
    });
    internal.activeCount.set("runner-worker", 1);
    // And a legacy active invocation alongside it.
    internal.activeInvocationDetails.set("INVK-legacy-active", {
      invocationId: "INVK-legacy-active",
      sessionId: "SESS-legacy-active",
      agentId: "legacy-worker",
      agentName: "Legacy Worker",
      taskRef: undefined,
      role: "worker",
      startedAtMs: Date.now() - 500,
      resolvedAdapter: "claude-agent-acp",
      runner: undefined,
    });
    internal.activeCount.set("legacy-worker", 1);
    // And queued entries for both.
    internal.queues.set("runner-worker", [
      {
        agent: {
          id: "runner-worker",
          name: "Runner Worker",
          runner: "configured-runner",
          adapter: "claude-agent-acp",
        },
        change: { taskRef: "@queued-runner", toStatus: "in_progress" },
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs: Date.now() - 250,
        sequence: internal.nextQueueSequence++,
        starvationDeferrals: 0,
      },
    ]);
    internal.queues.set("legacy-worker", [
      {
        agent: {
          id: "legacy-worker",
          name: "Legacy Worker",
          adapter: "claude-agent-acp",
        },
        change: { taskRef: "@queued-legacy", toStatus: "in_progress" },
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs: Date.now(),
        sequence: internal.nextQueueSequence++,
        starvationDeferrals: 0,
      },
    ]);

    const response = await makeRequest(app, tempDir, "/api/agent/status");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      active_invocations: Array<Record<string, unknown>>;
      queued_invocations: Array<Record<string, unknown>>;
      agent_definitions: Array<Record<string, unknown>>;
    };

    const runnerActive = body.active_invocations.find((a) => a.session_id === "SESS-runner-active");
    expect(runnerActive).toBeDefined();
    expect(runnerActive!.runner).toBe("configured-runner");
    expect(runnerActive!.resolved_adapter).toBe("claude-agent-acp");
    const legacyActive = body.active_invocations.find((a) => a.session_id === "SESS-legacy-active");
    expect(legacyActive).toBeDefined();
    expect(legacyActive!.runner).toBeUndefined();
    expect(legacyActive!.resolved_adapter).toBe("claude-agent-acp");

    const queuedRunner = body.queued_invocations.find((q) => q.agent_id === "runner-worker");
    expect(queuedRunner).toBeDefined();
    expect(queuedRunner!.runner).toBe("configured-runner");
    expect(queuedRunner!.resolved_adapter).toBe("claude-agent-acp");
    const queuedLegacy = body.queued_invocations.find((q) => q.agent_id === "legacy-worker");
    expect(queuedLegacy).toBeDefined();
    expect(queuedLegacy!.runner).toBeUndefined();
    expect(queuedLegacy!.resolved_adapter).toBe("claude-agent-acp");

    const runnerDef = body.agent_definitions.find((d) => d.id === "runner-worker");
    expect(runnerDef!.runner).toBe("configured-runner");
    expect(runnerDef!.resolved_adapter).toBe("claude-agent-acp");
    expect(runnerDef!.adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("daemon responses never expose the resolved env secret literal", async () => {
    const agentsResponse = await makeRequest(app, tempDir, "/api/meta/agents");
    const agentsRaw = await agentsResponse.text();
    expect(agentsRaw).not.toContain(SECRET_SENTINEL);

    await makeRequest(app, tempDir, "/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });
    const statusResponse = await makeRequest(app, tempDir, "/api/agent/status");
    const statusRaw = await statusResponse.text();
    expect(statusRaw).not.toContain(SECRET_SENTINEL);
  });
});

// ─── Flow 7: unknown runner blocks before prompt + records redacted diags ───

describe("e2e: unknown runner blocks before prompt forwarding", { timeout: 30_000 }, () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runner-e2e-unknown-");
    sessionsDir = path.join(testDir, "sessions");
    registerMockAcpAdapter();
  });
  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
  // AC: @runner-invocation-semantics ac-dispatch-preflight-rejects-invalid-runners
  it("runInvocation rejects before spawning and writes no session directory", async () => {
    const agent = makeAgent({ runner: "absent-runner" });

    let captured: unknown;
    try {
      await runInvocation({
        agent,
        specDir: testDir,
        sessionsDir,
        cwd: process.cwd(),
        taskRef: `@${testUlid("TASK")}`,
        prompt: "This prompt must never reach the adapter",
        trigger: "task.ready",
        runnerRegistry: { runners: {} },
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(RunnerResolutionError);
    const e = captured as RunnerResolutionError;
    expect(e.reason).toBe("unknown_runner");
    // Actionable guidance must name both layers and the agent definition.
    expect(e.message).toMatch(/absent-runner/);
    expect(e.message).toMatch(/project/i);
    expect(e.message).toMatch(/system/i);
    expect(e.message).toMatch(/agent/i);

    // No session directory was created — the resolver short-circuited
    // before runInvocation reached createSession.
    const exists = await fs
      .access(sessionsDir)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const entries = await fs.readdir(sessionsDir);
      expect(entries).toHaveLength(0);
    }
  });

  // AC: @runner-invocation-semantics ac-dispatch-preflight-rejects-invalid-runners
  // AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
  it("dispatch preflight rejects the same unknown runner with a typed error", () => {
    const agent = makeAgent({ runner: "absent-runner" });
    expect(() =>
      resolveRunnerInvocation({
        agent,
        registry: { runners: {} },
        cwd: process.cwd(),
        sessionId: testUlid("SESS"),
        autoApprove: false,
        env: {},
      }),
    ).toThrow(RunnerResolutionError);
  });
});

// ─── Flow 8: required-secret-missing blocks before spawn ────────────────────

describe("e2e: missing required secret blocks before spawn", { timeout: 30_000 }, () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runner-e2e-secret-");
    sessionsDir = path.join(testDir, "sessions");
    registerMockAcpAdapter();
  });
  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-environment-secret-boundaries ac-required-secret-missing-blocks
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  // AC: @runner-resolution-and-preflight ac-unknown-runner-blocks-before-spawn
  it("rejects the invocation with missing_secret and no session is created", async () => {
    const registry = mergeRunnerConfigs(null, {
      runners: {
        gated: {
          kind: "acp_process",
          adapter: "mock-acp",
          env: {
            inherit: "none",
            secrets: {
              REQUIRED_SECRET_VAR: { source: "user_env", required: true },
            },
          },
        },
      },
    });
    const agent = makeAgent({ runner: "gated" });

    // Ensure the secret is NOT present in the test process env so the
    // user_env lookup fails deterministically.
    const previous = process.env.REQUIRED_SECRET_VAR;
    delete process.env.REQUIRED_SECRET_VAR;

    try {
      let captured: unknown;
      try {
        await runInvocation({
          agent,
          specDir: testDir,
          sessionsDir,
          cwd: process.cwd(),
          taskRef: `@${testUlid("TASK")}`,
          prompt: "Should be blocked by missing secret",
          trigger: "task.ready",
          runnerRegistry: registry,
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(RunnerResolutionError);
      const e = captured as RunnerResolutionError;
      expect(e.reason).toBe("missing_secret");
      expect(e.message).toContain("REQUIRED_SECRET_VAR");

      const exists = await fs
        .access(sessionsDir)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        const entries = await fs.readdir(sessionsDir);
        expect(entries).toHaveLength(0);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.REQUIRED_SECRET_VAR;
      } else {
        process.env.REQUIRED_SECRET_VAR = previous;
      }
    }
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("never echoes the resolved secret value through CLI validate stdout", async () => {
    // The resolver redaction layer scrubs secret values from CLI output.
    // We supply a sentinel value via env, configure a runner whose binding
    // resolves from that env, then run `kspec agent runners validate
    // --json` and assert the sentinel never appears in stdout.
    const fixture = await createProjectFixture("kspec-runner-e2e-secret-cli-");
    try {
      writeFileSync(
        path.join(fixture.projectRoot, "kynetic.yaml"),
        YAML.stringify({ kynetic: "1", title: "Test" }),
      );
      writeFileSync(
        path.join(fixture.projectRoot, "kynetic.meta.yaml"),
        YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
      );
      writeFileSync(
        path.join(fixture.projectRoot, "project.tasks.yaml"),
        YAML.stringify({ tasks: [] }),
      );
      await writeSystemLayer(
        fixture,
        `runners:
  secretful:
    kind: acp_process
    adapter: claude-agent-acp
    env:
      secrets:
        BOUND_SECRET:
          source: user_env
          required: true
`,
      );

      const result = kspec("agent runners validate --json", fixture.projectRoot, {
        env: { BOUND_SECRET: SECRET_SENTINEL },
      });
      // Either the resolver accepted the binding (exit 0) or surfaced a
      // diagnostic — neither path may include the literal secret value.
      expect(result.stdout).not.toContain(SECRET_SENTINEL);
      expect(result.stderr).not.toContain(SECRET_SENTINEL);
    } finally {
      await cleanupTempDir(fixture.projectRoot);
    }
  });
});

// ─── Flow 9: configured command reference traverses every diagnostic surface ─

describe(
  "e2e: configured command reference is identified across dry-run, preflight, session, diagnostics",
  { timeout: 60_000 },
  () => {
    let fixture: ProjectFixture;

    beforeEach(async () => {
      fixture = await createProjectFixture("kspec-runner-e2e-command-");
      registerMockAcpAdapter();
    });
    afterEach(async () => {
      await cleanupTempDir(fixture.projectRoot);
    });

    // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
    it("dry-run and preflight identify the configured executable; session records resolved adapter", async () => {
      const fakeExecutable = makeFakeExecutable(fixture.projectRoot, "fake-acp");
      // ── Project files for the CLI dry-run subprocess ──
      writeFileSync(
        path.join(fixture.projectRoot, "kynetic.yaml"),
        YAML.stringify({ kynetic: "1", title: "Test" }),
      );
      writeFileSync(
        path.join(fixture.projectRoot, "kynetic.meta.yaml"),
        YAML.stringify({
          kynetic_meta: "1.0",
          agents: [
            {
              _ulid: testUlid("AGNT"),
              id: "runner-only",
              name: "Runner Only",
              dispatch: [],
              concurrency: { max_concurrent: 1 },
              runner: "configured",
              auto_approve: false,
            },
          ],
        }),
      );
      writeFileSync(
        path.join(fixture.projectRoot, "project.tasks.yaml"),
        YAML.stringify({ tasks: [] }),
      );
      await writeSystemLayer(
        fixture,
        `runners:
  configured:
    kind: acp_process
    adapter: claude-agent-acp
    process:
      executable: ${fakeExecutable}
`,
      );

      // ── 1. Dry-run CLI ────────────────────────────────────────────────
      const dryRun = kspecJson<{
        validation_state: {
          selected?: boolean;
          status?: string;
          runner?: string;
          resolved_adapter?: string;
          command_source?: string;
        };
        runner_invocation: {
          resolved: boolean;
          summary?: {
            process: { command: string; command_source: string };
            runner: { name: string | null };
            adapter: { id: string };
          };
        };
      }>('agent run runner-only --dry-run "preview"', fixture.projectRoot);
      const vs = dryRun.validation_state;
      expect(vs.selected).toBe(true);
      expect(vs.status).toBe("valid");
      expect(vs.runner).toBe("configured");
      expect(vs.resolved_adapter).toBe("claude-agent-acp");
      expect(vs.command_source).toBe("runner.system");
      // The runner_invocation summary should also include the resolved
      // command path so operators can verify which executable will spawn.
      expect(dryRun.runner_invocation.resolved).toBe(true);
      expect(dryRun.runner_invocation.summary?.process.command).toBe(fakeExecutable);
      expect(dryRun.runner_invocation.summary?.process.command_source).toBe("runner.system");
      expect(dryRun.runner_invocation.summary?.runner.name).toBe("configured");
      expect(dryRun.runner_invocation.summary?.adapter.id).toBe("claude-agent-acp");

      // ── 2. Resolver-level diagnostics + preflight ─────────────────────
      const resolved = await resolveEffectiveRunners({
        projectRoot: fixture.projectRoot,
        shadowWorktreeDir: fixture.shadowDir,
        daemonConfigDir: fixture.daemonConfigDir,
      });
      const contract = resolveRunnerInvocation({
        agent: makeAgent({ runner: "configured" }),
        registry: resolved.registry,
        cwd: fixture.projectRoot,
        sessionId: testUlid("SESS"),
        autoApprove: false,
        env: {},
      });
      // Diagnostics origin records that the system layer supplied the
      // executable; the value itself never appears in the diagnostic JSON.
      expect(contract.diagnostics.fieldOrigins?.processExecutable).toBe("system");
      expect(contract.adapter.command).toBe(fakeExecutable);
      await expect(preflightRunnerInvocation(contract)).resolves.toBeUndefined();

      // ── 3. Session metadata records the runner identity ───────────────
      // Swap the adapter command back to the mock spawn so the lifecycle
      // can actually run end-to-end — what we are asserting is that the
      // session/event metadata records the runner, not that fake-acp
      // implements the ACP protocol.
      const mockBackedRegistry = makeMockRunnerRegistry("configured");
      const result = await runInvocation({
        agent: makeAgent({ runner: "configured" }),
        specDir: fixture.shadowDir,
        sessionsDir: path.join(fixture.projectRoot, "sessions"),
        cwd: fixture.projectRoot,
        taskRef: `@${testUlid("TASK")}`,
        prompt: "Command-reference session metadata check",
        trigger: "task.ready",
        runnerRegistry: mockBackedRegistry,
      });
      expect(result.outcome).toBe("success");
      const session = await readSessionYaml(
        path.join(fixture.projectRoot, "sessions"),
        result.session.id,
      );
      expect(session.runner).toBe("configured");
      expect(session.agent_type).toBe("mock-acp");
      const events = await readEventsJsonl(
        path.join(fixture.projectRoot, "sessions"),
        result.session.id,
      );
      const dispatched = events.find((e) => e.type === "agent.dispatched");
      expect(dispatched).toBeDefined();
      expect(dispatched!.data.runner).toBe("configured");
    });

    // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
    // AC: @runner-invocation-semantics ac-dispatch-preflight-rejects-invalid-runners
    it("preflight surfaces unspawnable_command when the configured executable is missing", async () => {
      const ghostPath = path.join(fixture.projectRoot, "no-such-executable");
      await writeSystemLayer(
        fixture,
        `runners:
  ghost:
    kind: acp_process
    adapter: claude-agent-acp
    process:
      executable: ${ghostPath}
`,
      );
      const resolved = await resolveEffectiveRunners({
        projectRoot: fixture.projectRoot,
        shadowWorktreeDir: fixture.shadowDir,
        daemonConfigDir: fixture.daemonConfigDir,
      });
      const contract = resolveRunnerInvocation({
        agent: makeAgent({ runner: "ghost" }),
        registry: resolved.registry,
        cwd: fixture.projectRoot,
        sessionId: testUlid("SESS"),
        autoApprove: false,
        env: {},
      });

      let captured: unknown;
      try {
        await preflightRunnerInvocation(contract);
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(RunnerResolutionError);
      const e = captured as RunnerResolutionError;
      expect(e.reason).toBe("unspawnable_command");
      expect(e.message).toContain(ghostPath);
    });
  },
);
