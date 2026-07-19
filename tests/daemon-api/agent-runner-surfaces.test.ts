/**
 * API tests for runner surfaces on daemon agent + dispatch routes.
 *
 * Covered ACs:
 * - @runner-operator-surfaces ac-daemon-agent-api-includes-runner
 * - @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
 * - @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
 * - @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 * - @agent-runner-configuration ac-adapter-field-backcompat
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDispatchEngine, stopAllEngines } from "../../dist/daemon/routes/agent-dispatch.js";
import { deriveProjectKeySync } from "../../dist/agents/runner-config.js";
import {
  cleanupTempDir,
  createTempDir,
  createTestApp,
  initGitRepo,
  makeRequest,
  setupInlineFixtures,
  testUlid,
} from "./helpers.js";

let tempDir: string;
let homeDir: string;
let originalHome: string | undefined;
let app: Elysia;

const RUNNER_BACKED_AGENT_ULID = testUlid("AGNT", 1);
const LEGACY_AGENT_ULID = testUlid("AGNT", 2);
const UNKNOWN_RUNNER_AGENT_ULID = testUlid("AGNT", 3);
const RUNNER_ONLY_AGENT_ULID = testUlid("AGNT", 4);

// Synthetic env secret value — assert this never appears in API responses.
// AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
const SECRET_SENTINEL = "kspec-secret-sentinel-do-not-leak-xY9";

function buildMetaFixture(): string {
  return `kynetic_meta: "1.0"
agents:
  - _ulid: ${RUNNER_BACKED_AGENT_ULID}
    id: runner-worker
    name: Runner Worker
    description: Runner-backed worker agent
    adapter: claude-agent-acp
    runner: configured-runner
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
  - _ulid: ${LEGACY_AGENT_ULID}
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
  - _ulid: ${UNKNOWN_RUNNER_AGENT_ULID}
    id: orphan-runner-worker
    name: Orphan Runner Worker
    description: Agent referencing a runner that is not registered
    adapter: claude-agent-acp
    runner: missing-runner
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
  - _ulid: ${RUNNER_ONLY_AGENT_ULID}
    id: runner-only-worker
    name: Runner-Only Worker
    description: Runner-backed agent that omits the legacy adapter field
    runner: configured-runner
    dispatch: []
    capabilities: []
    tools: []
    skills: []
    concurrency:
      max_concurrent: 1
    auto_approve: false
`;
}

function writeSystemRunnerConfig(projectDir: string, home: string): void {
  const projectKey = deriveProjectKeySync(projectDir);
  const dir = path.join(home, ".config", "kspec", "projects", projectKey);
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
}

beforeEach(async () => {
  tempDir = await createTempDir("kspec-daemon-api-runner-surfaces-");
  homeDir = await createTempDir("kspec-daemon-api-runner-surfaces-home-");
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  // Force os.homedir() callers that cache through getuid() pwent on Linux to
  // pick up the override — Node only consults HOME when the env var is set.
  initGitRepo(tempDir);
  setupInlineFixtures(tempDir, {
    meta: buildMetaFixture(),
    splitTasks: [],
  });
  writeSystemRunnerConfig(tempDir, homeDir);
  // Make a sentinel value visible to the resolver so any failure to redact
  // would surface it in the response body.
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

function request(urlPath: string, init?: RequestInit): Promise<Response> {
  return makeRequest(app, tempDir, urlPath, init);
}

// ─── GET /api/meta/agents — runner fields and validation ────────────────────

describe("GET /api/meta/agents — runner-aware response", () => {
  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("returns runner-backed agent with runner, resolved_adapter, and valid runner_validation", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const agent = body.data.find((a: { id: string }) => a.id === "runner-worker");
    expect(agent).toBeDefined();
    // Legacy `adapter` field preserved for old clients.
    expect(agent.adapter).toBe("claude-agent-acp");
    // Runner-resolved adapter identity.
    expect(agent.resolved_adapter).toBe("claude-agent-acp");
    expect(agent.runner).toBe("configured-runner");
    expect(agent.runner_validation).toBeDefined();
    expect(agent.runner_validation.status).toBe("valid");
    expect(Array.isArray(agent.runner_validation.diagnostics)).toBe(true);
    expect(agent.runner_validation.diagnostics.length).toBe(0);
  });

  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("returns legacy adapter-backed agent with resolved_adapter and no runner_validation block", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const agent = body.data.find((a: { id: string }) => a.id === "legacy-worker");
    expect(agent).toBeDefined();
    expect(agent.adapter).toBe("claude-agent-acp");
    expect(agent.resolved_adapter).toBe("claude-agent-acp");
    expect(agent.runner).toBeUndefined();
    expect(agent.runner_validation).toBeUndefined();
  });

  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("populates the legacy adapter field with the resolved adapter when the agent omits adapter", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const agent = body.data.find((a: { id: string }) => a.id === "runner-only-worker");
    expect(agent).toBeDefined();
    expect(agent.runner).toBe("configured-runner");
    // The fixture omits `adapter`; the daemon must still emit the resolved
    // adapter on the legacy field so clients that read only `adapter` keep
    // seeing a valid adapter identity. Mirrors the CLI JSON behavior.
    expect(agent.adapter).toBe("claude-agent-acp");
    expect(agent.resolved_adapter).toBe("claude-agent-acp");
    expect(agent.runner_validation).toBeDefined();
    expect(agent.runner_validation.status).toBe("valid");
  });

  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  it("reports unknown_runner diagnostic when agent references a runner that is not registered", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const agent = body.data.find((a: { id: string }) => a.id === "orphan-runner-worker");
    expect(agent).toBeDefined();
    expect(agent.runner).toBe("missing-runner");
    expect(agent.runner_validation).toBeDefined();
    expect(agent.runner_validation.status).toBe("invalid");
    const reasons = agent.runner_validation.diagnostics.map((d: { reason: string }) => d.reason);
    expect(reasons).toContain("unknown_runner");
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("does not expose env secret literals or process env dump in the response payload", async () => {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const rawBody = await response.text();
    // The secret env value must never appear anywhere in the serialized
    // payload — diagnostics are pre-redacted and the daemon must not dump
    // resolved env into the response shape.
    expect(rawBody).not.toContain(SECRET_SENTINEL);
    // Defensive: the source identifier appears in the config; surfacing the
    // literal env var binding leaks no secret value, but the daemon should
    // not echo the bound source map into the agent response.
    expect(rawBody).not.toContain("KSPEC_TEST_SECRET");
  });
});

// ─── PATCH /api/meta/agents/:id — runner field write path ───────────────────

describe("PATCH /api/meta/agents/:id — runner field updates", () => {
  // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
  it("sets the runner field on an agent definition", async () => {
    const response = await request("/api/meta/agents/legacy-worker", {
      method: "PATCH",
      body: JSON.stringify({ runner: "configured-runner" }),
    });
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated.runner).toBe("configured-runner");

    // Reload via list to confirm persistence.
    const listResponse = await request("/api/meta/agents");
    const listBody = await listResponse.json();
    const reloaded = listBody.data.find((a: { id: string }) => a.id === "legacy-worker");
    expect(reloaded.runner).toBe("configured-runner");
  });

  // AC: @runner-operator-surfaces ac-web-ui-agent-edit-supports-runner
  it("clears the runner field when null is supplied", async () => {
    // First set, then clear.
    await request("/api/meta/agents/legacy-worker", {
      method: "PATCH",
      body: JSON.stringify({ runner: "configured-runner" }),
    });

    const clearResponse = await request("/api/meta/agents/legacy-worker", {
      method: "PATCH",
      body: JSON.stringify({ runner: null }),
    });
    expect(clearResponse.status).toBe(200);
    const updated = await clearResponse.json();
    expect(updated.runner).toBeUndefined();

    const listResponse = await request("/api/meta/agents");
    const listBody = await listResponse.json();
    const reloaded = listBody.data.find((a: { id: string }) => a.id === "legacy-worker");
    expect(reloaded.runner).toBeUndefined();
  });

  // ─── PATCH/GET runner-state parity ─────────────────────────────────────────
  // The PATCH endpoint must emit the same runner-aware response shape that
  // GET /api/meta/agents returns for the saved agent. Without this, API
  // clients could observe a less complete contract immediately after editing
  // runner fields than the list endpoint provides.

  async function getAgentFromList(agentId: string): Promise<Record<string, unknown>> {
    const response = await request("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const agent = body.data.find((a: { id: string }) => a.id === agentId);
    expect(agent).toBeDefined();
    return agent as Record<string, unknown>;
  }

  function assertRunnerStateParity(
    patched: Record<string, unknown>,
    fromList: Record<string, unknown>,
  ): void {
    // Per ac-daemon-agent-patch-returns-runner-state: PATCH must return the
    // same `adapter`, `resolved_adapter`, and redacted `runner_validation`
    // shape that the list endpoint would return for the saved agent.
    expect(patched.adapter).toBe(fromList.adapter);
    expect(patched.resolved_adapter).toBe(fromList.resolved_adapter);
    expect(patched.runner).toBe(fromList.runner);
    expect(patched.runner_validation).toEqual(fromList.runner_validation);
  }

  // AC: @runner-operator-surfaces ac-daemon-agent-patch-returns-runner-state
  it("PATCH sets a valid runner and returns the same runner-state shape as GET", async () => {
    const patchResponse = await request("/api/meta/agents/legacy-worker", {
      method: "PATCH",
      body: JSON.stringify({ runner: "configured-runner" }),
    });
    expect(patchResponse.status).toBe(200);
    const updated = await patchResponse.json();

    // Response must include the enriched runner shape, not the raw saved agent.
    expect(updated.runner).toBe("configured-runner");
    expect(updated.adapter).toBe("claude-agent-acp");
    expect(updated.resolved_adapter).toBe("claude-agent-acp");
    expect(updated.runner_validation).toBeDefined();
    expect(updated.runner_validation.status).toBe("valid");
    expect(updated.runner_validation.diagnostics).toEqual([]);

    const reloaded = await getAgentFromList("legacy-worker");
    assertRunnerStateParity(updated, reloaded);
  });

  // AC: @runner-operator-surfaces ac-daemon-agent-patch-returns-runner-state
  it("PATCH clearing a runner returns the same runner-state shape as GET", async () => {
    // Start from a runner-backed agent (runner-worker), clear it, then compare.
    const patchResponse = await request("/api/meta/agents/runner-worker", {
      method: "PATCH",
      body: JSON.stringify({ runner: null }),
    });
    expect(patchResponse.status).toBe(200);
    const updated = await patchResponse.json();

    // After clearing: no runner, no runner_validation block. Resolved adapter
    // falls back to the legacy adapter field.
    expect(updated.runner).toBeUndefined();
    expect(updated.runner_validation).toBeUndefined();
    expect(updated.adapter).toBe("claude-agent-acp");
    expect(updated.resolved_adapter).toBe("claude-agent-acp");

    const reloaded = await getAgentFromList("runner-worker");
    assertRunnerStateParity(updated, reloaded);
  });

  // AC: @runner-operator-surfaces ac-daemon-agent-patch-returns-runner-state
  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  it("PATCH setting an unknown runner returns the same runner-state shape as GET", async () => {
    const patchResponse = await request("/api/meta/agents/legacy-worker", {
      method: "PATCH",
      body: JSON.stringify({ runner: "definitely-not-registered" }),
    });
    expect(patchResponse.status).toBe(200);
    const updated = await patchResponse.json();

    expect(updated.runner).toBe("definitely-not-registered");
    expect(updated.adapter).toBe("claude-agent-acp");
    expect(updated.resolved_adapter).toBe("claude-agent-acp");
    expect(updated.runner_validation).toBeDefined();
    expect(updated.runner_validation.status).toBe("invalid");
    const reasons = updated.runner_validation.diagnostics.map((d: { reason: string }) => d.reason);
    expect(reasons).toContain("unknown_runner");

    const reloaded = await getAgentFromList("legacy-worker");
    assertRunnerStateParity(updated, reloaded);
  });
});

// ─── GET /api/agent/status — runner fields on dispatch state ────────────────

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

describe("GET /api/agent/status — runner fields on active and queued invocations", () => {
  // AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
  it("includes resolved_adapter and runner on active invocations", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const engine = getDispatchEngine(tempDir);
    expect(engine).toBeDefined();
    const internal = engine as unknown as EngineInternals;
    const invocationId = "INVK-runner-active";
    const sessionId = "SESS-runner-active";
    internal.activeInvocationDetails.set(invocationId, {
      invocationId,
      sessionId,
      agentId: "runner-worker",
      agentName: "Runner Worker",
      taskRef: undefined,
      role: "worker",
      startedAtMs: Date.now() - 1000,
      resolvedAdapter: "claude-agent-acp",
      runner: "configured-runner",
    });
    internal.activeCount.set("runner-worker", 1);

    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.active_invocations.length).toBeGreaterThanOrEqual(1);
    const active = body.active_invocations.find(
      (a: { session_id: string }) => a.session_id === sessionId,
    );
    expect(active).toBeDefined();
    expect(active.resolved_adapter).toBe("claude-agent-acp");
    expect(active.runner).toBe("configured-runner");
  });

  // AC: @runner-operator-surfaces ac-daemon-dispatch-active-api-includes-runner
  it("omits the runner field on active invocations for legacy adapter-only agents", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const engine = getDispatchEngine(tempDir);
    expect(engine).toBeDefined();
    const internal = engine as unknown as EngineInternals;
    const invocationId = "INVK-legacy-active";
    const sessionId = "SESS-legacy-active";
    internal.activeInvocationDetails.set(invocationId, {
      invocationId,
      sessionId,
      agentId: "legacy-worker",
      agentName: "Legacy Worker",
      taskRef: undefined,
      role: "worker",
      startedAtMs: Date.now() - 500,
      resolvedAdapter: "claude-agent-acp",
      runner: undefined,
    });
    internal.activeCount.set("legacy-worker", 1);

    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    const active = body.active_invocations.find(
      (a: { session_id: string }) => a.session_id === sessionId,
    );
    expect(active).toBeDefined();
    expect(active.resolved_adapter).toBe("claude-agent-acp");
    expect(active.runner).toBeUndefined();
  });

  // AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
  it("exposes queued_invocations with runner and registry-resolved adapter", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const engine = getDispatchEngine(tempDir);
    expect(engine).toBeDefined();
    const internal = engine as unknown as EngineInternals;
    const enqueuedAtMs = Date.now() - 250;
    internal.queues.set("runner-worker", [
      {
        agent: {
          id: "runner-worker",
          name: "Runner Worker",
          runner: "configured-runner",
          adapter: "claude-agent-acp",
        },
        change: { taskRef: "@queued-task", toStatus: "in_progress" },
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs,
        sequence: internal.nextQueueSequence++,
        starvationDeferrals: 0,
      },
    ]);

    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.queued_invocations)).toBe(true);
    expect(body.queued_invocations.length).toBe(1);
    const queued = body.queued_invocations[0];
    expect(queued.agent_id).toBe("runner-worker");
    expect(queued.runner).toBe("configured-runner");
    expect(queued.resolved_adapter).toBe("claude-agent-acp");
    expect(queued.task_ref).toBe("@queued-task");
    expect(typeof queued.wait_ms).toBe("number");
    expect(body.queue_depth).toBe(1);
  });

  // AC: @runner-operator-surfaces ac-daemon-dispatch-queued-api-includes-runner
  it("omits the runner field on queued invocations for legacy adapter-only agents", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });

    const engine = getDispatchEngine(tempDir);
    expect(engine).toBeDefined();
    const internal = engine as unknown as EngineInternals;
    internal.queues.set("legacy-worker", [
      {
        agent: {
          id: "legacy-worker",
          name: "Legacy Worker",
          adapter: "claude-agent-acp",
        },
        change: { taskRef: "@legacy-queue", toStatus: "in_progress" },
        retryCount: 0,
        nextRetryAt: 0,
        enqueuedAtMs: Date.now(),
        sequence: internal.nextQueueSequence++,
        starvationDeferrals: 0,
      },
    ]);

    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.queued_invocations.length).toBe(1);
    const queued = body.queued_invocations[0];
    expect(queued.agent_id).toBe("legacy-worker");
    expect(queued.runner).toBeUndefined();
    expect(queued.resolved_adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  it("agent_definitions entries include resolved_adapter and runner identity", async () => {
    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    const runner = body.agent_definitions.find((d: { id: string }) => d.id === "runner-worker");
    expect(runner).toBeDefined();
    expect(runner.runner).toBe("configured-runner");
    expect(runner.resolved_adapter).toBe("claude-agent-acp");
    // Legacy adapter field still populated for backwards compat.
    expect(runner.adapter).toBe("claude-agent-acp");

    const legacy = body.agent_definitions.find((d: { id: string }) => d.id === "legacy-worker");
    expect(legacy).toBeDefined();
    expect(legacy.runner).toBeUndefined();
    expect(legacy.resolved_adapter).toBe("claude-agent-acp");
    expect(legacy.adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("dispatch status response never includes raw env secret values", async () => {
    await request("/api/agent/dispatch", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    });
    const response = await request("/api/agent/status");
    expect(response.status).toBe(200);
    const rawBody = await response.text();
    expect(rawBody).not.toContain(SECRET_SENTINEL);
  });
});

// ─── Registry-load failure diagnostics on daemon agent + dispatch surfaces ──

describe("Daemon agent + dispatch surfaces — registry-load failures", () => {
  let regTempDir: string;
  let regHomeDir: string;
  let regOriginalHome: string | undefined;
  let regApp: Elysia;

  beforeEach(async () => {
    regTempDir = await createTempDir("kspec-daemon-api-registry-load-");
    regHomeDir = await createTempDir("kspec-daemon-api-registry-load-home-");
    regOriginalHome = process.env.HOME;
    process.env.HOME = regHomeDir;
    initGitRepo(regTempDir);
    setupInlineFixtures(regTempDir, {
      meta: buildMetaFixture(),
      splitTasks: [],
    });
    ({ app: regApp } = createTestApp());
  });

  afterEach(async () => {
    await stopAllEngines();
    if (regOriginalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = regOriginalHome;
    }
    await cleanupTempDir(regTempDir);
    await cleanupTempDir(regHomeDir);
  });

  function writeMalformedSystemRunners(projectDir: string, home: string, content: string): string {
    const projectKey = deriveProjectKeySync(projectDir);
    const dir = path.join(home, ".config", "kspec", "projects", projectKey);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "runners.yaml");
    writeFileSync(filePath, content);
    return filePath;
  }

  function regRequest(urlPath: string, init?: RequestInit): Promise<Response> {
    return makeRequest(regApp, regTempDir, urlPath, init);
  }

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  it("GET /api/meta/agents returns runner_registry_unavailable for runner-backed agents when system YAML is malformed", async () => {
    const sysPath = writeMalformedSystemRunners(
      regTempDir,
      regHomeDir,
      "runners:\n  configured-runner: [unterminated\n",
    );

    const response = await regRequest("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const runnerAgent = body.data.find((a: { id: string }) => a.id === "runner-worker");
    expect(runnerAgent).toBeDefined();
    expect(runnerAgent.runner).toBe("configured-runner");
    expect(runnerAgent.runner_validation).toBeDefined();
    expect(runnerAgent.runner_validation.status).toBe("invalid");
    const diag = runnerAgent.runner_validation.diagnostics[0];
    expect(diag.reason).toBe("runner_registry_unavailable");
    expect(diag.reason).not.toBe("unknown_runner");
    expect(diag.details.layer).toBe("system");
    expect(diag.details.config_path).toBe(sysPath);
    expect(Array.isArray(diag.details.issues)).toBe(true);

    // Legacy adapter-only agents remain unaffected.
    const legacy = body.data.find((a: { id: string }) => a.id === "legacy-worker");
    expect(legacy).toBeDefined();
    expect(legacy.runner_validation).toBeUndefined();
    expect(legacy.resolved_adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  it("GET /api/meta/agents surfaces system schema violations as runner_registry_unavailable", async () => {
    writeMalformedSystemRunners(
      regTempDir,
      regHomeDir,
      "runners:\n  configured-runner:\n    process:\n      args: []\n",
    );

    const response = await regRequest("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const runnerAgent = body.data.find((a: { id: string }) => a.id === "runner-worker");
    expect(runnerAgent).toBeDefined();
    const diag = runnerAgent.runner_validation.diagnostics[0];
    expect(diag.reason).toBe("runner_registry_unavailable");
    expect(diag.details.layer).toBe("system");
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  it("PATCH /api/meta/agents/:id returns the same runner_registry_unavailable shape as GET", async () => {
    writeMalformedSystemRunners(
      regTempDir,
      regHomeDir,
      "runners:\n  configured-runner: [malformed\n",
    );

    // PATCH the agent (e.g., flip a non-runner field). Even when the body
    // doesn't touch the runner field, the response must include the runner
    // validation block matching what GET would return.
    const patchResponse = await regRequest("/api/meta/agents/runner-worker", {
      method: "PATCH",
      body: JSON.stringify({ description: "Updated description" }),
    });
    expect(patchResponse.status).toBe(200);
    const updated = await patchResponse.json();
    expect(updated.runner).toBe("configured-runner");
    expect(updated.resolved_adapter).toBeDefined();
    expect(updated.runner_validation).toBeDefined();
    expect(updated.runner_validation.status).toBe("invalid");
    expect(updated.runner_validation.diagnostics[0].reason).toBe("runner_registry_unavailable");
    expect(updated.runner_validation.diagnostics[0].details.layer).toBe("system");

    // Reload via GET to confirm full runner-state parity.
    // AC: @runner-operator-surfaces ac-daemon-agent-patch-returns-runner-state
    const getResponse = await regRequest("/api/meta/agents");
    const getBody = await getResponse.json();
    const reloaded = getBody.data.find((a: { id: string }) => a.id === "runner-worker");
    expect(reloaded.adapter).toBe(updated.adapter);
    expect(reloaded.resolved_adapter).toBe(updated.resolved_adapter);
    expect(reloaded.runner).toBe(updated.runner);
    expect(reloaded.runner_validation).toEqual(updated.runner_validation);
  });

  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  it("PATCH /api/meta/agents/:id returns enriched runner shape when the registry is healthy", async () => {
    // Provide a valid system runner config so the validation pass succeeds.
    const projectKey = deriveProjectKeySync(regTempDir);
    const dir = path.join(regHomeDir, ".config", "kspec", "projects", projectKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "runners.yaml"),
      `runners:
  configured-runner:
    kind: acp_process
    adapter: claude-agent-acp
    env:
      inherit: minimal
`,
    );

    const patchResponse = await regRequest("/api/meta/agents/runner-worker", {
      method: "PATCH",
      body: JSON.stringify({ description: "Just touching description" }),
    });
    expect(patchResponse.status).toBe(200);
    const updated = await patchResponse.json();
    expect(updated.resolved_adapter).toBe("claude-agent-acp");
    expect(updated.adapter).toBe("claude-agent-acp");
    expect(updated.runner_validation).toBeDefined();
    expect(updated.runner_validation.status).toBe("valid");
    expect(updated.runner_validation.diagnostics).toEqual([]);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  // AC: @runner-operator-surfaces ac-daemon-agent-api-includes-runner
  it("GET /api/agent/status agent_definitions attach runner_registry_unavailable when the registry cannot load", async () => {
    writeMalformedSystemRunners(
      regTempDir,
      regHomeDir,
      "runners:\n  configured-runner: [malformed\n",
    );

    const response = await regRequest("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    const runnerDef = body.agent_definitions.find((d: { id: string }) => d.id === "runner-worker");
    expect(runnerDef).toBeDefined();
    expect(runnerDef.runner).toBe("configured-runner");
    expect(runnerDef.runner_validation).toBeDefined();
    expect(runnerDef.runner_validation.diagnostics[0].reason).toBe("runner_registry_unavailable");

    // Legacy agent definitions remain unaffected.
    const legacyDef = body.agent_definitions.find((d: { id: string }) => d.id === "legacy-worker");
    expect(legacyDef).toBeDefined();
    expect(legacyDef.runner_validation).toBeUndefined();
  });

  // Helper: write a valid system runner config for mixed-layer tests.
  function writeValidSystemRunners(projectDir: string, home: string): void {
    const projectKey = deriveProjectKeySync(projectDir);
    const dir = path.join(home, ".config", "kspec", "projects", projectKey);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "runners.yaml"),
      `runners:
  configured-runner:
    kind: acp_process
    adapter: claude-agent-acp
    env:
      inherit: minimal
`,
    );
  }

  function writeMalformedProjectRunners(
    projectDir: string,
    content: string,
  ): {
    metaPath: string;
    dispatchPath: string;
  } {
    // /api/meta/agents resolves the shadow worktree dir explicitly as
    // `<projectRoot>/.kspec`. /api/agent/status calls initContext, which in
    // this non-shadow inline test layout sets specDir = projectDir. Write
    // both locations so the test can assert against either endpoint without
    // depending on which path the route resolved.
    const metaPath = path.join(projectDir, ".kspec", "project.runners.yaml");
    const dispatchPath = path.join(projectDir, "project.runners.yaml");
    writeFileSync(metaPath, content);
    writeFileSync(dispatchPath, content);
    return { metaPath, dispatchPath };
  }

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  // Mixed-layer regression: malformed project layer must not be masked by a
  // surviving runner entry from the system layer.
  it("GET /api/meta/agents reports runner_registry_unavailable when project layer is malformed even if system contributes the runner", async () => {
    writeValidSystemRunners(regTempDir, regHomeDir);
    const { metaPath } = writeMalformedProjectRunners(
      regTempDir,
      "runners:\n  configured-runner: [unterminated\n",
    );

    const response = await regRequest("/api/meta/agents");
    expect(response.status).toBe(200);
    const body = await response.json();
    const runnerAgent = body.data.find((a: { id: string }) => a.id === "runner-worker");
    expect(runnerAgent).toBeDefined();
    expect(runnerAgent.runner_validation).toBeDefined();
    expect(runnerAgent.runner_validation.status).toBe("invalid");
    const diag = runnerAgent.runner_validation.diagnostics[0];
    // Must surface the malformed layer rather than the surviving runner.
    expect(diag.reason).toBe("runner_registry_unavailable");
    expect(diag.details.layer).toBe("project");
    expect(diag.details.config_path).toBe(metaPath);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("PATCH /api/meta/agents/:id returns runner_registry_unavailable in mixed-layer case", async () => {
    writeValidSystemRunners(regTempDir, regHomeDir);
    const { metaPath } = writeMalformedProjectRunners(
      regTempDir,
      "runners:\n  configured-runner: [unterminated\n",
    );

    const patchResponse = await regRequest("/api/meta/agents/runner-worker", {
      method: "PATCH",
      body: JSON.stringify({ description: "Touch description" }),
    });
    expect(patchResponse.status).toBe(200);
    const updated = await patchResponse.json();
    expect(updated.runner_validation).toBeDefined();
    expect(updated.runner_validation.status).toBe("invalid");
    expect(updated.runner_validation.diagnostics[0].reason).toBe("runner_registry_unavailable");
    expect(updated.runner_validation.diagnostics[0].details.layer).toBe("project");
    expect(updated.runner_validation.diagnostics[0].details.config_path).toBe(metaPath);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("GET /api/agent/status agent_definitions attach runner_registry_unavailable in mixed-layer case", async () => {
    writeValidSystemRunners(regTempDir, regHomeDir);
    const { dispatchPath } = writeMalformedProjectRunners(
      regTempDir,
      "runners:\n  configured-runner: [unterminated\n",
    );

    const response = await regRequest("/api/agent/status");
    expect(response.status).toBe(200);
    const body = await response.json();
    const runnerDef = body.agent_definitions.find((d: { id: string }) => d.id === "runner-worker");
    expect(runnerDef).toBeDefined();
    expect(runnerDef.runner_validation).toBeDefined();
    const diag = runnerDef.runner_validation.diagnostics[0];
    expect(diag.reason).toBe("runner_registry_unavailable");
    expect(diag.details.layer).toBe("project");
    expect(diag.details.config_path).toBe(dispatchPath);
  });
});
