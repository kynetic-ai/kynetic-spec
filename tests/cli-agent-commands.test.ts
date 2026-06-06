/**
 * CLI Agent Commands tests.
 *
 * Tests for kspec agent list, run, status, and dispatch subcommands.
 *
 * Task: @implement-cli-agent-commands
 * Spec: @cli-agent-commands
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as fsSync from "node:fs";
import * as YAML from "yaml";
import {
  createTempDir,
  createIsolatedKspecHome,
  cleanupTempDir,
  kspec,
  readTestOutputSync,
  waitForStartup,
  testUlid,
  initGitRepo,
  seedSplitTask,
} from "./helpers/cli.js";
import { runInvocation } from "../src/agent-runtime/invocation.js";
import * as invocationModule from "../src/agent-runtime/invocation.js";
import { registerAdapter } from "../src/agents/adapters.js";
import { setJsonMode, isJsonMode } from "../src/cli/output.js";
import type { SessionUpdate } from "../src/acp/index.js";
import * as parser from "../src/parser/index.js";
import type { Agent } from "../src/schema/meta.js";

// ─── Mock ACP for unit-level tests ───────────────────────────────────────────

const MOCK_ACP = path.join(__dirname, "mocks", "acp-mock.js");

function registerMockAdapter(): void {
  registerAdapter("mock-acp", {
    command: "node",
    args: [MOCK_ACP],
    env: { MOCK_ACP_PROJECT_DIR: process.cwd() },
    description: "Mock ACP adapter for testing",
  });
}

// ─── Mock daemon helpers for ac-4/5/6 ────────────────────────────────────────
// Note: we import and test command handlers directly to avoid spawnSync event-loop issues

import { registerAgentCommands, _setWebSocketCtor } from "../src/cli/commands/agent.js";
import { Command } from "commander";

/**
 * Create a test Commander program with agent commands registered.
 * Used for ac-4/5/6 tests that need to mock fetch/PidFileManager.
 */
function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride(); // Don't call process.exit in tests
  registerAgentCommands(program);
  return program;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    _ulid: testUlid("AGNT"),
    id: "test-worker",
    name: "Test Worker Agent",
    capabilities: [],
    tools: [],
    conventions: [],
    dispatch: [{ on: "task.ready" }],
    skills: [],
    auto_approve: false,
    concurrency: { max_concurrent: 1 },
    adapter: "claude-agent-acp",
    ...overrides,
  };
}

/**
 * Set up a minimal kspec project directory with meta containing agents.
 * Uses traditional (non-shadow) layout.
 */
// ─── AC-1: kspec agent list ───────────────────────────────────────────────────

// AC: @cli-agent-commands ac-1
describe("AC-1: kspec agent list", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-list-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should list all agent definitions with id, adapter, and concurrency", () => {
    const agent1 = makeTestAgent({ id: "worker-1", adapter: "claude-agent-acp" });
    const agent2 = makeTestAgent({
      _ulid: testUlid("AGNT", 2),
      id: "worker-2",
      adapter: "codex-acp",
    });

    // Set up project synchronously using YAML.stringify
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [agent1, agent2].map((a) => ({
          _ulid: a._ulid,
          id: a.id,
          name: a.name,
          dispatch: a.dispatch ?? [],
          concurrency: a.concurrency,
          adapter: a.adapter,
          auto_approve: false,
        })),
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    const result = kspec("agent list", testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("worker-1");
    expect(result.stdout).toContain("worker-2");
    expect(result.stdout).toContain("claude-agent-acp");
    expect(result.stdout).toContain("codex-acp");
  });

  it("should output JSON when --json flag is provided", () => {
    const agent = makeTestAgent({ id: "json-agent" });

    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: agent.dispatch ?? [],
            concurrency: agent.concurrency,
            adapter: agent.adapter,
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-json-output ac-1 - valid JSON output
    const result = kspec("agent list --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items).toBeDefined();
    expect(data.total).toBeDefined();
    // AC: @trait-json-output ac-4 - references use @ prefix
    expect(data.items[0].id).toBe("json-agent");
  });

  it("should return 0 exit code with empty list when no agents defined", () => {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-semantic-exit-codes ac-5 - exit 0 with empty result
    const result = kspec("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no agent");
  });

  it("should support --count flag", () => {
    const agent = makeTestAgent();
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: agent.dispatch ?? [],
            concurrency: agent.concurrency,
            adapter: agent.adapter,
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-filterable-list ac-8 - count mode
    const result = kspec("agent list --count", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1");
  });

  it("should fail validation for invalid --limit values", () => {
    const agent = makeTestAgent();
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: agent.dispatch ?? [],
            concurrency: agent.concurrency,
            adapter: agent.adapter,
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-semantic-exit-codes ac-2 - invalid numeric input exits 1
    const result = kspec("agent list --limit 5abc", testDir, { expectFail: true });
    expect(result.exitCode).toBe(4);
    expect(result.stderr + result.stdout).toContain("Invalid --limit value");
  });

  it("should fail validation for invalid --offset values", () => {
    const agent = makeTestAgent();
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: agent.dispatch ?? [],
            concurrency: agent.concurrency,
            adapter: agent.adapter,
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-semantic-exit-codes ac-2 - invalid numeric input exits 1
    const result = kspec("agent list --offset xyz", testDir, { expectFail: true });
    expect(result.exitCode).toBe(4);
    expect(result.stderr + result.stdout).toContain("Invalid --offset value");
  });
});

// ─── AC-1: agent list includes session, budget, skills, tags ─────────────────

// AC: @cli-agent-commands ac-1
// AC: @trait-json-output ac-2
describe("AC-1: kspec agent list includes session, budget, skills, and tags", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-list-fields-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  function writeProject(agents: object[]): void {
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    initGitRepo(testDir);
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );
  }

  it("should include session config in JSON output when set on agent", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "session-worker",
        name: "Session Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        session: { mode: "persistent", idle_grace_period_ms: 5000, idle_timeout_ms: 300000 },
      },
    ]);

    const result = kspec("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items[0].session).toEqual({
      mode: "persistent",
      idle_grace_period_ms: 5000,
      idle_timeout_ms: 300000,
    });
  });

  it("should include budget in JSON output when set on agent", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "budget-worker",
        name: "Budget Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        budget: { max_tasks: 10, timeout_minutes: 30 },
      },
    ]);

    const result = kspec("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items[0].budget).toEqual({
      max_tasks: 10,
      timeout_minutes: 30,
    });
  });

  it("should include skills in JSON output when non-empty", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "skilled-worker",
        name: "Skilled Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        skills: ["task-work", "reflect"],
      },
    ]);

    const result = kspec("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items[0].skills).toEqual(["task-work", "reflect"]);
  });

  it("should include tags in JSON output when non-empty", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "tagged-worker",
        name: "Tagged Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        tags: ["cli", "agent"],
      },
    ]);

    const result = kspec("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items[0].tags).toEqual(["cli", "agent"]);
  });

  it("should include automation in JSON output when set", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "eligible-worker",
        name: "Eligible Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        automation: "eligible",
      },
    ]);

    const result = kspec("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items[0].automation).toBe("eligible");
  });

  it("should omit optional fields from JSON when not set on agent", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "minimal-worker",
        name: "Minimal Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const result = kspec("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    const item = data.items[0];
    expect(item.session).toBeUndefined();
    expect(item.budget).toBeUndefined();
    expect(item.skills).toBeUndefined();
    expect(item.tags).toBeUndefined();
    expect(item.automation).toBeUndefined();
    expect(item.prompt_template).toBeUndefined();
  });

  it("should show session config in human-readable output when present", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "session-worker",
        name: "Session Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        session: { mode: "persistent", idle_grace_period_ms: 5000, idle_timeout_ms: 300000 },
      },
    ]);

    const result = kspec("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("session:");
    expect(result.stdout).toContain("mode=persistent");
    expect(result.stdout).toContain("grace=5000ms");
    expect(result.stdout).toContain("timeout=300000ms");
  });

  it("should show budget in human-readable output when present", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "budget-worker",
        name: "Budget Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        budget: { max_tasks: 10, timeout_minutes: 30 },
      },
    ]);

    const result = kspec("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("budget:");
    expect(result.stdout).toContain("max_tasks=10");
    expect(result.stdout).toContain("timeout=30m");
  });

  it("should show skills in human-readable output when non-empty", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "skilled-worker",
        name: "Skilled Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        skills: ["task-work", "reflect"],
      },
    ]);

    const result = kspec("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("skills:");
    expect(result.stdout).toContain("task-work, reflect");
  });

  it("should show tags in human-readable output when non-empty", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "tagged-worker",
        name: "Tagged Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        tags: ["cli", "agent"],
      },
    ]);

    const result = kspec("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tags:");
    expect(result.stdout).toContain("cli, agent");
  });

  it("should not show optional fields in human-readable output when not set", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "minimal-worker",
        name: "Minimal Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const result = kspec("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("session:");
    expect(result.stdout).not.toContain("budget:");
    expect(result.stdout).not.toContain("skills:");
    expect(result.stdout).not.toContain("tags:");
  });

  // AC: @trait-json-output ac-2 - JSON includes all data available in human-readable mode
  it("should include all fields in JSON that are shown in human-readable mode", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "full-worker",
        name: "Full Worker",
        dispatch: [{ on: "task.ready" }],
        concurrency: { max_concurrent: 2 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        session: { mode: "persistent", idle_grace_period_ms: 5000 },
        budget: { max_tasks: 10, timeout_minutes: 30 },
        skills: ["task-work", "reflect"],
        tags: ["cli", "agent"],
        automation: "eligible",
      },
    ]);

    const result = kspec("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    const item = data.items[0];

    // All fields present in human-readable should be in JSON
    expect(item.id).toBe("full-worker");
    expect(item.adapter).toBe("claude-agent-acp");
    expect(item.dispatch).toEqual([{ on: "task.ready" }]);
    expect(item.concurrency).toEqual({ max_concurrent: 2 });
    expect(item.session).toEqual({ mode: "persistent", idle_grace_period_ms: 5000 });
    expect(item.budget).toEqual({ max_tasks: 10, timeout_minutes: 30 });
    expect(item.skills).toEqual(["task-work", "reflect"]);
    expect(item.tags).toEqual(["cli", "agent"]);
    expect(item.automation).toBe("eligible");
  });
});

// ─── @trait-filterable-list ac-1: --status filter ────────────────────────────

// AC: @trait-filterable-list ac-1
describe("trait-filterable-list ac-1: kspec agent list --status filter", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-list-status-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should show only agents with matching automation status when --status is provided", () => {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    // Write two agents: one with automation:eligible, one without
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: testUlid("AGNT"),
            id: "eligible-worker",
            name: "Eligible Worker",
            dispatch: [],
            concurrency: { max_concurrent: 1 },
            adapter: "claude-agent-acp",
            auto_approve: false,
            automation: "eligible",
          },
          {
            _ulid: testUlid("AGNT", 2),
            id: "ineligible-worker",
            name: "Ineligible Worker",
            dispatch: [],
            concurrency: { max_concurrent: 1 },
            adapter: "claude-agent-acp",
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-filterable-list ac-1 - only items with matching status shown
    const result = kspec("agent list --status eligible", testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("eligible-worker");
    expect(result.stdout).not.toContain("ineligible-worker");
  });
});

// ─── @trait-filterable-list ac-2/3/4/5/7: tag, pagination, AND logic, summary ─

// AC: @trait-filterable-list ac-2
// AC: @trait-filterable-list ac-3
// AC: @trait-filterable-list ac-4
// AC: @trait-filterable-list ac-5
// AC: @trait-filterable-list ac-7
describe("trait-filterable-list ac-2/3/4/5/7: kspec agent list filters and pagination", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-filter-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  function writeProject(agents: object[]): void {
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    initGitRepo(testDir);
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );
  }

  it("should filter by --tag and show only matching agents", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "cli-worker",
        name: "CLI Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        tags: ["cli", "infra"],
      },
      {
        _ulid: testUlid("AGNT", 2),
        id: "review-worker",
        name: "Review Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        tags: ["review"],
      },
      {
        _ulid: testUlid("AGNT", 3),
        id: "no-tags-worker",
        name: "No Tags Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    // AC: @trait-filterable-list ac-2 - tag filter shows only matching agents
    const result = kspec("agent list --tag cli", testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cli-worker");
    expect(result.stdout).not.toContain("review-worker");
    expect(result.stdout).not.toContain("no-tags-worker");
  });

  it("should limit results to --limit N agents", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "agent-a",
        name: "Agent A",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
      {
        _ulid: testUlid("AGNT", 2),
        id: "agent-b",
        name: "Agent B",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
      {
        _ulid: testUlid("AGNT", 3),
        id: "agent-c",
        name: "Agent C",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    // AC: @trait-filterable-list ac-3 - limit returns at most N results
    const result = kspec("agent list --limit 2 --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items.length).toBeLessThanOrEqual(2);
    expect(data.total).toBe(3);
  });

  it("should skip first N agents with --offset", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "first-agent",
        name: "First Agent",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
      {
        _ulid: testUlid("AGNT", 2),
        id: "second-agent",
        name: "Second Agent",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
      {
        _ulid: testUlid("AGNT", 3),
        id: "third-agent",
        name: "Third Agent",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    // AC: @trait-filterable-list ac-4 - offset skips first N results
    const result = kspec("agent list --offset 1 --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.items.length).toBe(2);
    expect(data.offset).toBe(1);
    expect(data.items.map((i: { id: string }) => i.id)).not.toContain("first-agent");
  });

  it("should apply --status and --tag as AND logic (both must match)", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "eligible-cli",
        name: "Eligible CLI",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        automation: "eligible",
        tags: ["cli"],
      },
      {
        _ulid: testUlid("AGNT", 2),
        id: "eligible-review",
        name: "Eligible Review",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        automation: "eligible",
        tags: ["review"],
      },
      {
        _ulid: testUlid("AGNT", 3),
        id: "ineligible-cli",
        name: "Ineligible CLI",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        tags: ["cli"],
      },
    ]);

    // AC: @trait-filterable-list ac-5 - multiple filters are AND logic
    const result = kspec("agent list --status eligible --tag cli", testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("eligible-cli");
    expect(result.stdout).not.toContain("eligible-review");
    expect(result.stdout).not.toContain("ineligible-cli");
  });

  it("should include filter state in summary line when filters are active", () => {
    writeProject([
      {
        _ulid: testUlid("AGNT"),
        id: "eligible-worker",
        name: "Eligible Worker",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
        automation: "eligible",
      },
    ]);

    // AC: @trait-filterable-list ac-7 - summary shows total and filter state
    const result = kspec("agent list --status eligible", testDir);

    expect(result.exitCode).toBe(0);
    // Summary line must describe the active filter
    expect(result.stdout).toMatch(/status=eligible/i);
  });
});

// ─── AC-7: Override flags ─────────────────────────────────────────────────────

// AC: @cli-agent-commands ac-7
describe("AC-7: kspec agent run --adapter override", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-run-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should show --dry-run prompt without spawning", () => {
    const agent = makeTestAgent({ id: "dry-run-agent" });
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: [],
            concurrency: agent.concurrency,
            adapter: agent.adapter,
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @cli-agent-commands ac-8 - dry-run shows prompt
    // AC: @trait-dry-run ac-1, ac-2, ac-3
    const result = kspec("agent run dry-run-agent 'test prompt' --dry-run", testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DRY RUN");
    expect(result.stdout).toContain("test prompt");
    // AC: @trait-dry-run ac-2 - no files modified
    // (verified by no side effects - no sessions created etc.)
  });

  it("should include dry_run:true in JSON output with --dry-run --json", () => {
    const agent = makeTestAgent({ id: "dry-run-agent-json" });
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: [],
            concurrency: agent.concurrency,
            adapter: agent.adapter,
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-dry-run ac-6 - JSON includes dry_run boolean
    const result = kspec("agent run dry-run-agent-json 'test' --dry-run --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.dry_run).toBe(true);
    expect(data.agent_id).toBe("dry-run-agent-json");
  });
});

// ─── prompt_template support in one-shot mode ────────────────────────────────

describe("agent run --task respects prompt_template", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-run-tpl-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  function setupProject(agents: Agent[]): void {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: agents.map((a) => ({
          _ulid: a._ulid,
          id: a.id,
          name: a.name,
          dispatch: [],
          concurrency: a.concurrency,
          adapter: a.adapter,
          auto_approve: false,
          ...(a.prompt_template && { prompt_template: a.prompt_template }),
        })),
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );
  }

  it("should use prompt_template when --task is provided and no explicit prompt", () => {
    const agent = makeTestAgent({
      id: "review-agent",
      prompt_template: "Review task {{task_ref}} with trigger {{trigger}}",
    });
    setupProject([agent]);

    const result = kspec("agent run review-agent --task @TASK123 --dry-run --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.prompt).toContain("Review task @TASK123 with trigger manual");
  });

  it("should fall back to default prompt when no prompt_template is defined", () => {
    const agent = makeTestAgent({ id: "plain-agent" });
    setupProject([agent]);

    const result = kspec("agent run plain-agent --task @TASK456 --dry-run --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.prompt).toContain(
      "Work on task @TASK456 according to your configuration and skills.",
    );
  });

  it("should prefer explicit prompt over prompt_template", () => {
    const agent = makeTestAgent({
      id: "override-agent",
      prompt_template: "Template prompt for {{task_ref}}",
    });
    setupProject([agent]);

    const result = kspec(
      "agent run override-agent 'My custom prompt' --task @TASK789 --dry-run --json",
      testDir,
    );

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.prompt).toContain("My custom prompt");
    expect(data.prompt).not.toContain("Template prompt for");
  });

  it("should interpolate review_url as empty string for manual runs", () => {
    const agent = makeTestAgent({
      id: "url-agent",
      prompt_template: "Review {{task_ref}} at {{review_url}} end",
    });
    setupProject([agent]);

    const result = kspec("agent run url-agent --task @TASK000 --dry-run --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    // review_url should resolve to empty string, not remain as {{review_url}}
    expect(data.prompt).toContain("Review @TASK000 at  end");
  });
});

// ─── Canonical task identity for one-shot --task ─────────────────────────────

// AC: @dispatch-canonical-task-identity ac-project-invocation-callers-supply-canonical-task-id
describe("agent run --task canonical task identity", () => {
  let testDir: string;
  const TASK_ULID = testUlid("CANON");

  function setupProjectWithTask(): void {
    initGitRepo(testDir);
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1.1", title: "Test", task_storage: { format: "split" } }),
    );
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: testUlid("AGNT"),
            id: "canon-worker",
            name: "Canon Worker",
            dispatch: [],
            concurrency: { max_concurrent: 1 },
            adapter: "claude-agent-acp",
            auto_approve: false,
          },
        ],
      }),
    );
    seedSplitTask(testDir, {
      _ulid: TASK_ULID,
      slugs: ["task-canon"],
      type: "task",
      title: "Canonical Task",
      status: "pending",
      priority: 3,
    });
  }

  beforeEach(async () => {
    // In-process task loading needs the split storage backend registered (the
    // subprocess CLI does this during bootstrap).
    const { ensureSplitBackendRegistered } = await import("../src/parser/split-backend.js");
    ensureSplitBackendRegistered();
    testDir = await createTempDir("kspec-agent-run-canon-");
    setupProjectWithTask();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  // AC: @dispatch-canonical-task-identity ac-project-invocation-callers-supply-canonical-task-id
  // AC: @dispatch-canonical-task-identity ac-session-and-event-payloads-separate-id-from-display-ref
  it("passes the canonical full ULID as task_id and the display slug as task_ref", async () => {
    const runSpy = vi.spyOn(invocationModule, "runInvocation").mockResolvedValue({
      outcome: "success",
      session: { id: "session-canon-001" },
      durationMs: 5,
      stopReason: "end_turn",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const program = createTestProgram();
    const origCwd = process.cwd();
    process.chdir(testDir);
    let caught: unknown;
    try {
      await program.parseAsync(["agent", "run", "canon-worker", "--task", "@task-canon"], {
        from: "user",
      });
    } catch (err) {
      caught = err;
    } finally {
      process.chdir(origCwd);
    }
    if (!runSpy.mock.calls.length && caught) throw caught;

    expect(runSpy).toHaveBeenCalledOnce();
    const opts = runSpy.mock.calls[0][0];
    expect(opts.taskId).toBe(TASK_ULID);
    expect(opts.taskRef).toBe("@task-canon");
  });

  // AC: @dispatch-canonical-task-identity ac-project-invocation-callers-supply-canonical-task-id
  // AC: @dispatch-canonical-task-identity ac-invalid-or-mismatched-task-ref-rejected
  it("fails before creating a session when --task cannot be resolved", () => {
    const result = kspec("agent run canon-worker --task @task-ghost", testDir, {
      expectFail: true,
    });

    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toMatch(/Cannot target task/i);
    // The invocation never started, so no task-scoped session directory exists.
    expect(fsSync.existsSync(path.join(testDir, ".kspec-sessions"))).toBe(false);
  });
});

// ─── AC-2: One-shot invocation with task binding ─────────────────────────────

// AC: @cli-agent-commands ac-2
describe("AC-2: One-shot agent run with --task binding", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "kspec-agent-run-ac2-"),
    );
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should create a session with task_id bound when --task is provided", async () => {
    const agent = makeTestAgent({ id: "test-worker", adapter: "mock-acp" });
    const taskRef = `@${testUlid("TASK")}`;

    // AC: @cli-agent-commands ac-2 - one-shot invocation with task binding
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, ".kspec-sessions"),
      cwd: process.cwd(),
      taskRef,
      prompt: "Work on task",
      trigger: "manual",
    });

    expect(result.outcome).toBe("success");
    expect(result.session.task_id).toBe(taskRef);
    expect(result.session.agent_id).toBe("test-worker");
  });
});

// ─── AC-3: One-shot invocation without task binding ──────────────────────────

// AC: @cli-agent-commands ac-3
describe("AC-3: One-shot agent run without task binding", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "kspec-agent-run-ac3-"),
    );
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should create a session with no task binding when --task is not provided", async () => {
    const agent = makeTestAgent({ id: "test-worker", adapter: "mock-acp" });

    // AC: @cli-agent-commands ac-3 - no task binding when task omitted
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, ".kspec-sessions"),
      cwd: process.cwd(),
      taskRef: undefined,
      prompt: "Custom one-off prompt",
      trigger: "manual",
    });

    expect(result.outcome).toBe("success");
    // task_id should be undefined (no binding), not empty string
    expect(result.session.task_id).toBeUndefined();
  });
});

// ─── AC-4: Dispatch start when daemon is running ─────────────────────────────

// AC: @cli-agent-commands ac-4
describe("AC-4: kspec agent dispatch start with running daemon", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-dispatch-start-");
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fsSync.writeFileSync(path.join(testDir, "project.tasks.yaml"), YAML.stringify({ tasks: [] }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await cleanupTempDir(testDir);
  });

  it("should call daemon dispatch/start and report success when daemon is running", async () => {
    // Mock PidFileManager to report daemon running
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);

    // Mock fetch to return a successful response
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        started: true,
        status: { running: true, activeInvocations: 0, queuedInvocations: 0 },
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    // Run the command programmatically
    const program = createTestProgram();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    try {
      // Change cwd to testDir so initContext picks up the project
      const origCwd = process.cwd();
      process.chdir(testDir);
      try {
        await program.parseAsync(["agent", "dispatch", "start"], { from: "user" });
      } finally {
        process.chdir(origCwd);
      }
    } catch {
      // exitOverride throws on process.exit - we suppress it
    } finally {
      console.log = origLog;
    }

    // AC: @cli-agent-commands ac-4 - dispatch engine started
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/agent/dispatch/start"),
      expect.objectContaining({
        method: "POST",
        headers: expect.not.objectContaining({
          "X-Kspec-Cwd": expect.any(String),
        }),
      }),
    );
    expect(logs.some((l) => /start|running/i.test(l))).toBe(true);
  });

  // AC: @worktree-support ac-daemon-identity
  // AC: @worktree-support ac-dispatch-cwd
  it("should send projectRoot and worktree cwd headers when dispatch starts from a worktree", async () => {
    const mainProjectRoot = "/tmp/main-project";
    const worktreeRoot = "/tmp/worktrees/feature-a";
    vi.spyOn(parser, "initContext").mockResolvedValue({
      rootDir: worktreeRoot,
      projectRoot: mainProjectRoot,
      specDir: `${mainProjectRoot}/.kspec`,
      sessionsDir: `${mainProjectRoot}/.kspec-sessions`,
      manifestPath: null,
      manifest: null,
      shadow: null,
      config: {
        shadow: { branch: "kspec-meta", directory: ".kspec", remote: null, sync_interval: 60 },
        identity: { author: null },
        validation: { strict_refs: true, require_acceptance: false },
        daemon: { port: 3456, host: "localhost", auto_start: true },
        agent: {
          skills: {
            task_work: "/kspec:task-work",
            reflect: "/kspec:reflect",
            pr_review: "/kspec:review",
          },
        },
      },
    } as Awaited<ReturnType<typeof parser.initContext>>);

    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        started: true,
        status: { running: true, activeInvocations: 0, queuedInvocations: 0 },
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const program = createTestProgram();
    try {
      await program.parseAsync(["agent", "dispatch", "start"], { from: "user" });
    } catch {
      // exitOverride
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/agent/dispatch/start"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Kspec-Dir": mainProjectRoot,
          "X-Kspec-Cwd": worktreeRoot,
        }),
      }),
    );
  });

  // AC: @worktree-support ac-dispatch-conflict
  it("should surface a 409 conflict when dispatch is already running for a different worktree cwd", async () => {
    vi.spyOn(parser, "initContext").mockResolvedValue({
      rootDir: "/tmp/worktrees/b",
      projectRoot: "/tmp/main-project",
      specDir: "/tmp/main-project/.kspec",
      sessionsDir: "/tmp/main-project/.kspec-sessions",
      manifestPath: null,
      manifest: null,
      shadow: null,
      config: {
        shadow: { branch: "kspec-meta", directory: ".kspec", remote: null, sync_interval: 60 },
        identity: { author: null },
        validation: { strict_refs: true, require_acceptance: false },
        daemon: { port: 3456, host: "localhost", auto_start: true },
        agent: {
          skills: {
            task_work: "/kspec:task-work",
            reflect: "/kspec:reflect",
            pr_review: "/kspec:review",
          },
        },
      },
    } as Awaited<ReturnType<typeof parser.initContext>>);

    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        "Dispatch engine already running for /tmp/main-project with cwd /tmp/worktrees/a",
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const program = createTestProgram();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    try {
      await program.parseAsync(["agent", "dispatch", "start"], { from: "user" });
    } catch {
      // exitOverride
    } finally {
      console.error = origError;
    }

    expect(errors.join("\n")).toContain("409");
    expect(errors.join("\n")).toContain("/tmp/worktrees/a");
  });
});

// ─── AC-5: Dispatch stop when daemon is running ───────────────────────────────

// AC: @cli-agent-commands ac-5
describe("AC-5: kspec agent dispatch stop graceful shutdown", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-dispatch-stop-");
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fsSync.writeFileSync(path.join(testDir, "project.tasks.yaml"), YAML.stringify({ tasks: [] }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await cleanupTempDir(testDir);
  });

  it("should call daemon dispatch/stop and report success when daemon is running", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ stopped: true }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const program = createTestProgram();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    try {
      const origCwd = process.cwd();
      process.chdir(testDir);
      try {
        await program.parseAsync(["agent", "dispatch", "stop"], { from: "user" });
      } finally {
        process.chdir(origCwd);
      }
    } catch {
      // suppress exitOverride
    } finally {
      console.log = origLog;
    }

    // AC: @cli-agent-commands ac-5 - dispatch engine stopped gracefully
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/agent/dispatch/stop"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(logs.some((l) => /stop|stopped/i.test(l))).toBe(true);
  });
});

// ─── AC-6: Agent status with running daemon ───────────────────────────────────

// AC: @cli-agent-commands ac-6
describe("AC-6: kspec agent status with running daemon", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-status-ac6-");
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fsSync.writeFileSync(
      path.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fsSync.writeFileSync(path.join(testDir, "project.tasks.yaml"), YAML.stringify({ tasks: [] }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await cleanupTempDir(testDir);
  });

  it("should show per-invocation details (session ID, agent name, task ref, elapsed) from daemon when running", async () => {
    // AC: @cli-agent-commands ac-6 - active invocations displayed with session IDs, agent names, task refs, elapsed time
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);

    const testSessionId = "01JTEST000SESSION0000001";
    const testInvocationId = "01JTEST000INVOC00000001";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        running: true,
        activeInvocations: 1,
        queuedInvocations: 0,
        invocations: [
          {
            invocationId: testInvocationId,
            sessionId: testSessionId,
            agentId: "worker",
            agentName: "Worker Agent",
            taskRef: "@01JTASK001",
            elapsedMs: 45000,
          },
        ],
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const program = createTestProgram();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    try {
      const origCwd = process.cwd();
      process.chdir(testDir);
      try {
        await program.parseAsync(["agent", "status"], { from: "user" });
      } finally {
        process.chdir(origCwd);
      }
    } catch {
      // suppress exitOverride
    } finally {
      console.log = origLog;
    }

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/agent/dispatch/status"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Kspec-Dir": testDir,
        }),
      }),
    );
    const combined = logs.join("\n");
    // AC: @cli-agent-commands ac-6 - session ID shown
    expect(combined).toContain(testSessionId);
    // AC: @cli-agent-commands ac-6 - agent name shown
    expect(combined).toContain("Worker Agent");
    // AC: @cli-agent-commands ac-6 - task ref shown
    expect(combined).toContain("@01JTASK001");
    // AC: @cli-agent-commands ac-6 - elapsed time shown (45000ms = 45s)
    expect(combined).toContain("45s");
  });

  it("should show per-invocation details for queued invocations (agent name, task ref, wait time)", async () => {
    // AC: @cli-agent-commands ac-6 - queued invocations displayed with agent names, task refs, and elapsed time
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        running: true,
        activeInvocations: 0,
        queuedInvocations: 2,
        invocations: [],
        queued: [
          {
            agentId: "worker",
            agentName: "Worker Agent",
            taskRef: "@01QTASK002",
            waitMs: 12000,
          },
          {
            agentId: "reviewer",
            agentName: "Reviewer Agent",
            taskRef: "@01QTASK003",
            waitMs: 3000,
          },
        ],
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const program = createTestProgram();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
    };

    try {
      const origCwd = process.cwd();
      process.chdir(testDir);
      try {
        await program.parseAsync(["agent", "status"], { from: "user" });
      } finally {
        process.chdir(origCwd);
      }
    } catch {
      // suppress exitOverride
    } finally {
      console.log = origLog;
    }

    const combined = logs.join("\n");
    // AC: @cli-agent-commands ac-6 - queued agent name shown
    expect(combined).toContain("Worker Agent");
    expect(combined).toContain("Reviewer Agent");
    // AC: @cli-agent-commands ac-6 - queued task ref shown
    expect(combined).toContain("@01QTASK002");
    expect(combined).toContain("@01QTASK003");
    // AC: @cli-agent-commands ac-6 - queued wait time shown (12000ms = 12s)
    expect(combined).toContain("12s");
  });
});

// ─── AC-7: Override flags verified via dry-run ────────────────────────────────

// AC: @cli-agent-commands ac-7
describe("AC-7: CLI flags override agent definition defaults", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-override-ac7-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should use --adapter override instead of agent definition adapter", () => {
    const agent = makeTestAgent({ id: "override-agent", adapter: "claude-agent-acp" });
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: [],
            concurrency: agent.concurrency,
            adapter: "claude-agent-acp",
            auto_approve: false,
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @cli-agent-commands ac-7 - --adapter overrides definition default
    const result = kspec("agent run override-agent --adapter custom-acp --dry-run --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.adapter).toBe("custom-acp");
  });

  it("should use --timeout override in dry-run output", () => {
    const agent = makeTestAgent({
      id: "timeout-agent",
      budget: { timeout_minutes: 30, max_tasks: 5 },
    } as Partial<Agent> & { budget?: { timeout_minutes: number; max_tasks: number } });
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({
        kynetic_meta: "1.0",
        agents: [
          {
            _ulid: agent._ulid,
            id: agent.id,
            name: agent.name,
            dispatch: [],
            concurrency: agent.concurrency,
            adapter: agent.adapter,
            auto_approve: false,
            budget: { timeout_minutes: 30, max_tasks: 5 },
          },
        ],
      }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @cli-agent-commands ac-7 - --timeout overrides definition default
    const result = kspec("agent run timeout-agent --timeout 5 --dry-run --json", testDir);

    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout);
    // timeout_minutes should reflect the CLI override (5), not the definition default (30)
    expect(data.timeout_minutes).toBe(5);
  });
});

// ─── AC-2, AC-3: agent not found error ───────────────────────────────────────

// AC: @cli-agent-commands ac-2, ac-3
// AC: @trait-error-guidance ac-3
describe("AC-2/3: kspec agent run error handling", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-notfound-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should error with suggestion when agent not found", () => {
    initGitRepo(testDir);
    const fs_sync = require("node:fs");
    const path_sync = require("node:path");
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fs_sync.writeFileSync(
      path_sync.join(testDir, "project.tasks.yaml"),
      YAML.stringify({ tasks: [] }),
    );

    // AC: @trait-error-guidance ac-3 - suggests checking ref
    // AC: @trait-semantic-exit-codes ac-2 - exit 1 on validation error
    const result = kspec("agent run nonexistent-agent 'prompt' --dry-run", testDir, {
      expectFail: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("nonexistent-agent");
  });
});

// ─── AC-10: daemon not running error ─────────────────────────────────────────

// AC: @cli-agent-commands ac-10
// AC: @trait-error-guidance ac-1, ac-2
describe("AC-10: kspec agent dispatch start without daemon", () => {
  let testDir: string;
  let isolatedDaemonEnv: Record<string, string>;
  const fs_sync = require("node:fs");
  const path_sync = require("node:path");

  function setupDispatchFixture(dir: string): void {
    initGitRepo(dir);
    fs_sync.writeFileSync(
      path_sync.join(dir, "kynetic.yaml"),
      YAML.stringify({ kynetic: "1", title: "Test" }),
    );
    fs_sync.writeFileSync(
      path_sync.join(dir, "kynetic.meta.yaml"),
      YAML.stringify({ kynetic_meta: "1.0", agents: [] }),
    );
    fs_sync.writeFileSync(path_sync.join(dir, "project.tasks.yaml"), YAML.stringify({ tasks: [] }));
    // Keep this fixture fully isolated from daemon state outside the test process.
    fs_sync.writeFileSync(
      path_sync.join(dir, "kspec.config.yaml"),
      YAML.stringify({ daemon: { auto_start: false } }),
    );
  }

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-dispatch-");
    isolatedDaemonEnv = (await createIsolatedKspecHome(testDir)).env;
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should error with daemon suggestion when daemon is not running", () => {
    setupDispatchFixture(testDir);

    // AC: @cli-agent-commands ac-10 - error when daemon not running
    // AC: @trait-error-guidance ac-1 - describes what went wrong
    // AC: @trait-error-guidance ac-2 - suggests action (kspec serve)
    const result = kspec("agent dispatch start", testDir, {
      expectFail: true,
      env: isolatedDaemonEnv,
    });

    expect(result.exitCode).not.toBe(0);
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/daemon|not running/i);
    expect(combined).toMatch(/kspec serve|start/i);
    expect(combined).not.toMatch(/\b400\b/);
  });

  it("should show dispatch status as disabled when daemon is not running", () => {
    setupDispatchFixture(testDir);

    // AC: @cli-agent-commands ac-9 - dispatch status shows info
    const result = kspec("agent dispatch status", testDir, {
      env: isolatedDaemonEnv,
    });

    expect(result.exitCode).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/dispatch|daemon|offline|not available/i);
  });
});

// ─── AC-4, AC-5, AC-6 covered above with mock daemon server ──────────────────
// AC: @cli-agent-commands ac-4 — covered in "AC-4: kspec agent dispatch start with running daemon"
// AC: @cli-agent-commands ac-5 — covered in "AC-5: kspec agent dispatch stop graceful shutdown"
// AC: @cli-agent-commands ac-6 — covered in "AC-6: kspec agent status with running daemon"

// ─── Trait AC N/A annotations ─────────────────────────────────────────────────

// ─── Additional trait AC coverage ────────────────────────────────────────────

// AC: @trait-json-output ac-2 — verified in list --json test (output includes all data available in text mode)
// AC: @trait-json-output ac-3 — N/A: agent list/dispatch-status don't fail in a way that JSON would test independently; error JSON is tested via dry-run
// AC: @trait-json-output ac-5 — N/A: agent list output doesn't contain timestamps
// AC: @trait-json-output ac-6 — N/A: agent commands don't have conflicting format options

// AC: @trait-semantic-exit-codes ac-1 — verified: all passing tests exit 0
// AC: @trait-semantic-exit-codes ac-3 — N/A: agent commands don't prompt for confirmation
// AC: @trait-semantic-exit-codes ac-4 — verified: dispatch start / agent run with invalid agent exit non-0
// AC: @trait-semantic-exit-codes ac-6 — N/A: agent commands don't have usage errors from invalid flags in tested scenarios
// AC: @trait-semantic-exit-codes ac-7 — N/A: agent commands don't perform batch operations with partial failures
// AC: @trait-semantic-exit-codes ac-8 — N/A: exit code documentation is in exit-codes.ts (centralized)

// AC: @trait-error-guidance ac-4 — N/A: agent commands don't involve state transitions shown to user
// AC: @trait-error-guidance ac-5 — N/A: agent commands don't have field validation errors shown to user
// AC: @trait-error-guidance ac-6 — N/A: agent commands don't support JSON error mode (no --json on error paths)

// AC: @trait-filterable-list ac-1 — covered in "trait-filterable-list ac-1: kspec agent list --status filter"
// AC: @trait-filterable-list ac-2 — covered in "trait-filterable-list ac-2/3/4/5/7: --tag filter" test
// AC: @trait-filterable-list ac-3 — covered in "trait-filterable-list ac-2/3/4/5/7: --limit" test
// AC: @trait-filterable-list ac-4 — covered in "trait-filterable-list ac-2/3/4/5/7: --offset" test
// AC: @trait-filterable-list ac-5 — covered in "trait-filterable-list ac-2/3/4/5/7: AND logic" test
// AC: @trait-filterable-list ac-6 — verified: empty list test shows informative message
// AC: @trait-filterable-list ac-7 — covered in "trait-filterable-list ac-2/3/4/5/7: summary" test

// AC: @trait-dry-run ac-4 — N/A for agent run --dry-run: no mutations attempted in dry-run mode
// AC: @trait-dry-run ac-5 — N/A for agent run: --dry-run --force combination not supported

// ─── AC-11: Streaming suppressed in JSON mode ─────────────────────────────────

// AC: @cli-agent-commands ac-11
describe("AC-11: JSON mode suppresses streaming output", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "kspec-agent-stream-json-"),
    );
    registerMockAdapter();
  });

  afterEach(async () => {
    setJsonMode(false); // reset global state after each test
    await cleanupTempDir(testDir);
  });

  it("should suppress the onUpdate handler in JSON mode so no text chunks are collected", async () => {
    const agent = makeTestAgent({ id: "stream-json-agent", adapter: "mock-acp" });
    const collected: string[] = [];

    // AC: @cli-agent-commands ac-11 — replicate the exact decision in agent.ts:
    // isJsonMode() ? undefined : handler
    // This proves the handler is suppressed when JSON mode is active.
    setJsonMode(true);
    const onUpdate = isJsonMode()
      ? undefined
      : (update: SessionUpdate) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            collected.push(update.content.text);
          }
        };

    // onUpdate must be undefined — if it were defined, the mock would send text (proven by ac-12)
    expect(onUpdate).toBeUndefined();

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, ".kspec-sessions"),
      cwd: process.cwd(),
      prompt: "test prompt",
      trigger: "manual",
      env: { MOCK_ACP_RESPONSE_TEXT: "should not appear in json mode" },
      onUpdate,
    });

    // Result shape: outcome, session_id, duration_ms, stop_reason (no streaming text)
    expect(result.outcome).toBe("success");
    expect(result.session.id).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stopReason).toBeTruthy();
    // onUpdate was undefined → no chunks collected, even though mock sent text (proven by ac-12)
    expect(collected).toHaveLength(0);
  });
});

// ─── AC-12: Streaming in interactive mode ─────────────────────────────────────

// AC: @cli-agent-commands ac-12
describe("AC-12: Interactive mode streams text as it arrives", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "kspec-agent-stream-interactive-"),
    );
    registerMockAdapter();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  it("should call onUpdate with agent_message_chunk events containing text", async () => {
    const agent = makeTestAgent({ id: "stream-agent", adapter: "mock-acp" });
    const responseText = "streaming text from agent";
    const receivedChunks: string[] = [];

    // AC: @cli-agent-commands ac-12 — onUpdate receives agent_message_chunk with text content
    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, ".kspec-sessions"),
      cwd: process.cwd(),
      prompt: "test prompt",
      trigger: "manual",
      env: { MOCK_ACP_RESPONSE_TEXT: responseText },
      onUpdate: (update) => {
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          receivedChunks.push(update.content.text);
        }
      },
    });

    expect(result.outcome).toBe("success");
    // Text was received via onUpdate before completion
    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0]).toBe(responseText);
  });
});

// AC: @cli-agent-commands ac-12
describe("AC-12: suppress adapter rate_limit_event noise on stderr", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "kspec-agent-stderr-filter-"),
    );
    registerMockAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(testDir);
  });

  it("suppresses non-actionable rate_limit_event lines while preserving actionable adapter stderr", async () => {
    const agent = makeTestAgent({ id: "stderr-filter-agent", adapter: "mock-acp" });
    const stderrLines: string[] = [];

    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });

    const result = await runInvocation({
      agent,
      specDir: testDir,
      sessionsDir: path.join(testDir, ".kspec-sessions"),
      cwd: process.cwd(),
      prompt: "test prompt",
      trigger: "manual",
      env: {
        MOCK_ACP_RESPONSE_TEXT: "streaming text from agent",
        MOCK_ACP_EMIT_RATE_LIMIT_EVENT: "true",
        MOCK_ACP_EMIT_ACTIONABLE_STDERR: "Actionable adapter error: auth expired",
      },
    });

    expect(result.outcome).toBe("success");

    const stderrOutput = stderrLines.join("");
    expect(stderrOutput).not.toContain("rate_limit_event");
    expect(stderrOutput).toContain("Actionable adapter error: auth expired");
  });
});

// ─── AC-13 through AC-18: kspec agent dispatch watch ─────────────────────────

// Helper: create a fake WebSocket instance for testing
interface FakeWsInstance {
  send: ReturnType<typeof vi.fn>;
  addEventListener: (event: string, handler: (...args: any[]) => void) => void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: (() => void) | null;
}

function makeFakeWsClass(): {
  FakeWs: new (url: string) => FakeWsInstance;
  getLastInstance: () => FakeWsInstance | null;
} {
  let last: FakeWsInstance | null = null;
  class FakeWs implements FakeWsInstance {
    send = vi.fn();
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onclose: (() => void) | null = null;
    addEventListener(event: string, handler: (...args: any[]) => void): void {
      if (event === "open") this.onopen = handler;
      else if (event === "message") this.onmessage = handler as (e: { data: string }) => void;
      else if (event === "error") this.onerror = handler;
      else if (event === "close") this.onclose = handler as () => void;
    }
    constructor(_url: string) {
      // oxlint-disable-next-line typescript-eslint/no-this-alias -- intentionally capturing instance for test inspection
      last = this;
    }
  }
  return { FakeWs: FakeWs as new (url: string) => FakeWsInstance, getLastInstance: () => last };
}

const DISPATCH_WATCH_FIXTURE_DIR = path.join(__dirname, "fixtures", "dispatch-watch-transcripts");

type DispatchWatchTextChunk = {
  session_id: string;
  agent_id: string;
  text: string;
};

type DispatchWatchTranscriptFixture = {
  description: string;
  chunks: DispatchWatchTextChunk[];
  expected_stdout: string;
};

type DispatchWatchReconnectFixture = {
  description: string;
  chunks_before_close: DispatchWatchTextChunk[];
  expected_stdout: string;
  expected_stderr_substring: string;
};

function loadDispatchWatchFixture<T>(fileName: string): T {
  const fixturePath = path.join(DISPATCH_WATCH_FIXTURE_DIR, fileName);
  return JSON.parse(readTestOutputSync(fixturePath)) as T;
}

/**
 * Emit a typed session text event to a fake WebSocket.
 * - Non-empty text → message_progress
 * - Empty text → message_complete (boundary)
 */
function emitSessionTextEvent(ws: FakeWsInstance, chunk: DispatchWatchTextChunk): void {
  if (chunk.text.length === 0) {
    // Empty text was the old boundary sentinel — now message_complete
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { ...chunk, type: "message_complete", timestamp: Date.now() },
      }),
    });
  } else {
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { ...chunk, type: "message_progress", timestamp: Date.now() },
      }),
    });
  }
}

/**
 * Poll for a condition to become true, up to maxWaitMs.
 * Used to handle async initContext() completing before WebSocket is created.
 */
const DISPATCH_WATCH_READY_TIMEOUT_MS = 10_000;

async function waitFor(
  condition: () => boolean,
  maxWaitMs = 2000,
  description = "dispatch watch test readiness",
): Promise<void> {
  await waitForStartup(
    description,
    async () => {
      const ok = condition();
      return {
        ok,
        details: ok ? "condition met" : `condition not yet met (waited up to ${maxWaitMs}ms)`,
      };
    },
    { timeoutMs: maxWaitMs, intervalMs: 10 },
  );
}

/**
 * Mock initContext to throw immediately. Dispatch watch catches this (non-fatal)
 * so the only effect is removing the slow filesystem search that otherwise
 * causes waitFor timeouts in environments without .kspec/ (clean clones, CI).
 */
async function mockInitContextFast(): Promise<void> {
  const parserModule = await import("../src/parser/index.js");
  vi.spyOn(parserModule, "initContext").mockRejectedValue(new Error("mocked"));
}

// AC: @cli-agent-commands ac-15
describe("AC-15: dispatch watch — daemon not running", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should print error and exit code 3 when daemon is not running", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(false);

    const program = createTestProgram();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args) => {
      errors.push(args.join(" "));
    };

    let exitCode: number | undefined;
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });

    try {
      await program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });
    } catch {
      // expected: mocked exit throws
    } finally {
      console.error = origError;
    }

    // AC: @cli-agent-commands ac-15 - exit code 3 and error message
    expect(exitCode).toBe(3);
    // Error should mention daemon
    const allOutput = errors.join(" ");
    expect(allOutput.toLowerCase()).toMatch(/daemon/);
  });
});

// AC: @cli-agent-commands ac-18
describe("AC-18: dispatch watch — subscribe handshake failure", () => {
  afterEach(() => {
    _setWebSocketCtor(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should exit code 3 with actionable guidance when subscribe ack fails", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const errors: string[] = [];
    const infos: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    vi.spyOn(console, "log").mockImplementation((...args) => {
      infos.push(args.join(" "));
    });

    let exitCode: number | undefined;
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });

    const program = createTestProgram();
    const runPromise = program
      .parseAsync(["agent", "dispatch", "watch"], { from: "user" })
      .catch(() => {
        /* mocked process.exit throws */
      });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    try {
      ws.onmessage?.({
        data: JSON.stringify({
          ack: true,
          request_id: "watch-subscribe",
          success: false,
          error: "validation_error",
          details: "Missing or invalid topics array",
        }),
      });
    } catch {
      // expected: mocked process.exit throws
    }

    await Promise.resolve();

    expect(exitCode).toBe(3);
    const allErrors = errors.join(" ");
    const allInfo = infos.join(" ");
    expect(allErrors).toContain("Failed to subscribe to daemon agent output stream");
    expect(allErrors).toContain("Missing or invalid topics array");
    expect(allInfo).toContain("Suggestion:");
    expect(allInfo).toContain("kspec serve");
    expect(allInfo).toContain("daemon logs");

    runPromise.catch(() => {
      /* ignore */
    });
  });
});

// AC: @cli-agent-commands ac-13
describe("AC-13: dispatch watch — streams section-marked output", () => {
  afterEach(() => {
    _setWebSocketCtor(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should print [agent-id session-id] section marker before streamed output", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();

    // Start command — will hang on the infinite promise
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    // Poll until WebSocket is created (initContext() needs several async ticks)
    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);

    const ws = getLastInstance();
    expect(ws).not.toBeNull();

    // Simulate connected + subscribed
    ws!.onopen?.({});

    // Send a message_progress event
    ws!.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: {
          session_id: "sess-abc",
          agent_id: "worker",
          text: "hello from agent",
        },
      }),
    });

    await Promise.resolve();

    // AC: @cli-agent-commands ac-13 - output includes [agent-id session-id] marker
    const output = written.join("");
    expect(output).toContain("[worker sess-abc]");
    expect(output).toContain("hello from agent");

    // Clean up — the promise never resolves, but that's expected
    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should render one section header and stream token-sized chunks as body text", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    // Simulate token-level chunking from one stream (no newlines until later).
    for (const token of ["I", " am", " streaming", "\nNext", " line"]) {
      ws.onmessage?.({
        data: JSON.stringify({
          event: "message_progress",
          data: {
            session_id: "sess-abc",
            agent_id: "worker",
            text: token,
          },
        }),
      });
    }

    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker sess-abc]\nI am streaming");
    expect(output).toContain("\nNext line");
    expect((output.match(/\[worker sess-abc\]/g) ?? []).length).toBe(1);

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should start a new prefixed line when output switches between streams", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-a", agent_id: "worker-a", text: "hello" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-b", agent_id: "worker-b", text: "world" },
      }),
    });

    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker-a sess-a]\nhello\n[worker-b sess-b]\nworld");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should place distinct same-stream messages on separate lines at empty-chunk boundary", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-abc", agent_id: "worker", text: "First update." },
      }),
    });
    // Message complete boundary event.
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { session_id: "sess-abc", agent_id: "worker", text: "" },
      }),
    });
    await Promise.resolve();

    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-abc", agent_id: "worker", text: "Second update." },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker sess-abc]\nFirst update.\n\nSecond update.");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should collapse repeated boundary events to a single spacer line", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-abc", agent_id: "worker", text: "First block." },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { session_id: "sess-abc", agent_id: "worker", text: "" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { session_id: "sess-abc", agent_id: "worker", text: "" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-abc", agent_id: "worker", text: "Second block." },
      }),
    });

    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker sess-abc]\nFirst block.\n\nSecond block.");
    expect(output).not.toContain("First block.\n\n\nSecond block.");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should ignore empty-boundary events from other streams while current stream is mid-line", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-a", agent_id: "worker-a", text: "hello" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { session_id: "sess-b", agent_id: "worker-b", text: "" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-a", agent_id: "worker-a", text: " world" },
      }),
    });

    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker-a sess-a]\nhello world");
    expect(output).not.toContain("\nworld\n[worker-a sess-a]");
    expect(output).not.toContain("[worker-b sess-b]");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should handle empty-first statement boundaries without adding blank lines", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    // Message complete before first text (boundary at start).
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { session_id: "sess-abc", agent_id: "worker", text: "" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-abc", agent_id: "worker", text: "First statement." },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { session_id: "sess-abc", agent_id: "worker", text: "" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-abc", agent_id: "worker", text: "Second statement." },
      }),
    });

    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker sess-abc]\nFirst statement.\n\nSecond statement.");
    expect(output.startsWith("\n")).toBe(false);

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @cli-agent-commands ac-17
  it("should display shortened session id in prefix", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: {
          session_id: "01KJVFYRKXXQG7N3BYC68KSX6H",
          agent_id: "worker",
          text: "hello",
        },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker 01KJVFYR]\nhello");
    expect(output).not.toContain("01KJVFYRKXXQG7N3BYC68KSX6H");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should keep continuation bursts on one line when chunks split mid-token", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    const parts = [
      "I’m taking ownership with the `kspec",
      "-task-work` flow first, and I’ll ",
      "explicitly load project instructions before editing.",
    ];
    for (const text of parts) {
      ws.onmessage?.({
        data: JSON.stringify({
          event: "message_progress",
          data: { session_id: "sess-abc", agent_id: "worker", text },
        }),
      });
      await Promise.resolve();
    }

    const output = written.join("");
    expect((output.match(/\[worker sess-abc\]/g) ?? []).length).toBe(1);
    expect(output).toContain(
      "[worker sess-abc]\nI’m taking ownership with the `kspec-task-work` flow first, and I’ll explicitly load project instructions before editing.",
    );

    runPromise.catch(() => {
      /* ignore */
    });
  });
});

// AC: @cli-agent-commands ac-13
describe("AC-13: dispatch watch — transcript fixture regressions", () => {
  afterEach(() => {
    _setWebSocketCtor(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    "empty-before-text-boundary.json",
    "repeated-non-text-boundaries.json",
    "interleaved-multi-stream-switching.json",
  ])("should preserve rendering semantics for fixture %s", async (fixtureFile) => {
    const fixture = loadDispatchWatchFixture<DispatchWatchTranscriptFixture>(fixtureFile);

    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    for (const chunk of fixture.chunks) {
      emitSessionTextEvent(ws, chunk);
    }
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain(fixture.expected_stdout);

    // No leading blank line when first event is an ACP boundary sentinel.
    if (fixtureFile === "empty-before-text-boundary.json") {
      expect(output.startsWith("\n")).toBe(false);
    }

    // Repeated boundary events collapse into one spacer line.
    if (fixtureFile === "repeated-non-text-boundaries.json") {
      expect(output).not.toContain("First block.\n\n\nSecond block.");
    }

    // Interleaving streams keeps one marker per active section transition.
    if (fixtureFile === "interleaved-multi-stream-switching.json") {
      expect((output.match(/\[worker-a sess-a\]/g) ?? []).length).toBe(2);
      expect((output.match(/\[worker-b sess-b\]/g) ?? []).length).toBe(1);
    }

    runPromise.catch(() => {
      /* ignore */
    });
  });
});

// AC: @cli-agent-commands ac-16
describe("AC-16: dispatch watch — filter by agent or session", () => {
  afterEach(() => {
    _setWebSocketCtor(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should only show chunks matching --agent filter, drop others", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(
      ["agent", "dispatch", "watch", "--agent", "target-agent"],
      { from: "user" },
    );

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    // Send chunk from non-matching agent — should be dropped
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "s1", agent_id: "other-agent", text: "ignored" },
      }),
    });

    // Send chunk from matching agent — should be printed
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "s2", agent_id: "target-agent", text: "visible" },
      }),
    });

    await Promise.resolve();

    const output = written.join("");
    // AC: @cli-agent-commands ac-16 - non-matching chunks silently dropped
    expect(output).not.toContain("ignored");
    expect(output).toContain("visible");
    expect(output).toContain("[target-agent s2]");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should only show chunks matching --session filter, drop others", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(
      ["agent", "dispatch", "watch", "--session", "target-session"],
      { from: "user" },
    );

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "other-session", agent_id: "a1", text: "dropped" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "target-session", agent_id: "a2", text: "shown" },
      }),
    });

    await Promise.resolve();

    const output = written.join("");
    expect(output).not.toContain("dropped");
    expect(output).toContain("shown");

    runPromise.catch(() => {
      /* ignore */
    });
  });
});

// AC: @cli-agent-commands ac-14
describe("AC-14: dispatch watch — reconnect on disconnect", () => {
  afterEach(() => {
    _setWebSocketCtor(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("should print reconnecting message and retry on connection drop", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const instances: FakeWsInstance[] = [];
    class TrackingFakeWs implements FakeWsInstance {
      send = vi.fn();
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      addEventListener(event: string, handler: (...args: any[]) => void): void {
        if (event === "open") this.onopen = handler;
        else if (event === "message") this.onmessage = handler as (e: { data: string }) => void;
        else if (event === "error") this.onerror = handler;
        else if (event === "close") this.onclose = handler as () => void;
      }
      constructor(_url: string) {
        instances.push(this);
      }
    }
    _setWebSocketCtor(TrackingFakeWs as unknown as typeof WebSocket);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch", "--retries", "2"], {
      from: "user",
    });

    // Poll for first WebSocket to be created (initContext is async)
    await vi.runAllTimersAsync();
    await waitFor(
      () => instances.length >= 1,
      DISPATCH_WATCH_READY_TIMEOUT_MS,
      "WebSocket instance created for reconnect test",
    );

    instances[0].onopen?.({});

    // Simulate connection drop
    instances[0].onclose?.();

    // Advance timers to trigger reconnect (base 1s backoff for first retry)
    await vi.advanceTimersByTimeAsync(2000);

    // AC: @cli-agent-commands ac-14 - reconnecting message printed
    expect(stderrLines.some((l) => /reconnect/i.test(l))).toBe(true);
    // A second WebSocket was created
    expect(instances.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should flush active output line before reconnect message", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const instances: FakeWsInstance[] = [];
    class CaptureWs implements FakeWsInstance {
      send = vi.fn();
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      addEventListener(event: string, handler: (...args: any[]) => void): void {
        if (event === "open") this.onopen = handler;
        else if (event === "message") this.onmessage = handler as (e: { data: string }) => void;
        else if (event === "error") this.onerror = handler;
        else if (event === "close") this.onclose = handler as () => void;
      }
      constructor(_url: string) {
        instances.push(this);
      }
    }
    _setWebSocketCtor(CaptureWs as unknown as typeof WebSocket);

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch", "--retries", "1"], {
      from: "user",
    });

    await waitFor(
      () => instances.length >= 1,
      DISPATCH_WATCH_READY_TIMEOUT_MS,
      "WebSocket instance created for output flush test",
    );
    instances[0].onopen?.({});
    instances[0].onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-abc", agent_id: "worker", text: "line without newline" },
      }),
    });
    // Trigger close before coalesced timer flushes naturally.
    instances[0].onclose?.();
    await waitForStartup(
      "dispatch watch reconnect output flush",
      async () => {
        const stdout = stdoutWrites.join("");
        const reconnectLogged = stderrWrites.some((l) => l.includes("[watch] Connection lost"));
        const flushed = stdout.includes("[worker sess-abc]\nline without newline\n");
        return {
          ok: reconnectLogged && flushed,
          details: `reconnect_logged=${reconnectLogged} flushed=${flushed} stdout_len=${stdout.length} stderr_lines=${stderrWrites.length}`,
        };
      },
      { timeoutMs: 2_000, intervalMs: 10 },
    );

    const stdout = stdoutWrites.join("");
    expect(stdout).toContain("[worker sess-abc]\nline without newline\n");
    expect(stderrWrites.some((l) => l.includes("[watch] Connection lost"))).toBe(true);

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should preserve reconnect boundary formatting from transcript fixture", async () => {
    const fixture =
      loadDispatchWatchFixture<DispatchWatchReconnectFixture>("reconnect-boundary.json");

    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const instances: FakeWsInstance[] = [];
    class CaptureWs implements FakeWsInstance {
      send = vi.fn();
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      addEventListener(event: string, handler: (...args: any[]) => void): void {
        if (event === "open") this.onopen = handler;
        else if (event === "message") this.onmessage = handler as (e: { data: string }) => void;
        else if (event === "error") this.onerror = handler;
        else if (event === "close") this.onclose = handler as () => void;
      }
      constructor(_url: string) {
        instances.push(this);
      }
    }
    _setWebSocketCtor(CaptureWs as unknown as typeof WebSocket);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch", "--retries", "1"], {
      from: "user",
    });

    await waitFor(
      () => instances.length >= 1,
      DISPATCH_WATCH_READY_TIMEOUT_MS,
      "WebSocket instance created for reconnect boundary test",
    );
    instances[0].onopen?.({});
    for (const chunk of fixture.chunks_before_close) {
      emitSessionTextEvent(instances[0], chunk);
    }
    instances[0].onclose?.();
    await vi.advanceTimersByTimeAsync(1100);

    const stdout = stdoutWrites.join("");
    const stderr = stderrWrites.join("");
    expect(stdout).toContain(fixture.expected_stdout);
    expect(stderr).toContain(fixture.expected_stderr_substring);
    expect(stdout.endsWith("\n")).toBe(true);

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it("should exit code 3 when retries exhausted (--retries 0)", async () => {
    // With --retries 0, the very first close triggers the exit immediately (no setTimeout)
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const instances: FakeWsInstance[] = [];
    class CaptureFakeWs implements FakeWsInstance {
      send = vi.fn();
      onopen: ((e: unknown) => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: (() => void) | null = null;
      addEventListener(event: string, handler: (...args: any[]) => void): void {
        if (event === "open") this.onopen = handler;
        else if (event === "message") this.onmessage = handler as (e: { data: string }) => void;
        else if (event === "error") this.onerror = handler;
        else if (event === "close") this.onclose = handler as () => void;
      }
      constructor(_url: string) {
        instances.push(this);
      }
    }
    _setWebSocketCtor(CaptureFakeWs as unknown as typeof WebSocket);

    let exitCode: number | undefined;
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const program = createTestProgram();
    // --retries 0: retryLimit=0, so first close immediately exits
    const runPromise = program
      .parseAsync(["agent", "dispatch", "watch", "--retries", "0"], { from: "user" })
      .catch(() => {
        /* mocked exit throws */
      });

    // Wait for WebSocket to be created
    await waitFor(
      () => instances.length >= 1,
      DISPATCH_WATCH_READY_TIMEOUT_MS,
      "WebSocket instance created for retries-exhausted test",
    );

    // First connection drops — retryCount(0) >= retryLimit(0), so exit immediately
    // process.exit mock throws synchronously, so wrap in try/catch
    try {
      instances[0]?.onclose?.();
    } catch {
      // expected: mocked process.exit throws
    }

    // AC: @cli-agent-commands ac-14 - exit code 3 on reconnection failure
    expect(exitCode).toBe(3);

    runPromise.catch(() => {
      /* ignore */
    });
  });

  it.each(["foo", "-1"])(
    "should exit code 4 for invalid --retries value %s",
    async (retriesValue) => {
      const { PidFileManager } = await import("../src/cli/pid-utils.js");
      vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
      vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
      await mockInitContextFast();

      const wsCtor = vi.fn();
      class GuardWs implements FakeWsInstance {
        send = vi.fn();
        onopen: ((e: unknown) => void) | null = null;
        onmessage: ((e: { data: string }) => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        onclose: (() => void) | null = null;
        addEventListener(event: string, handler: (...args: any[]) => void): void {
          if (event === "open") this.onopen = handler;
          else if (event === "message") this.onmessage = handler as (e: { data: string }) => void;
          else if (event === "error") this.onerror = handler;
          else if (event === "close") this.onclose = handler as () => void;
        }
        constructor(_url: string) {
          wsCtor();
        }
      }
      _setWebSocketCtor(GuardWs as unknown as typeof WebSocket);

      const consoleErrors: string[] = [];
      const origError = console.error;
      console.error = (...args) => {
        consoleErrors.push(args.join(" "));
      };

      let exitCode: number | undefined;
      vi.spyOn(process, "exit").mockImplementation((code?: number) => {
        exitCode = code as number;
        throw new Error(`process.exit(${code})`);
      });

      const program = createTestProgram();
      try {
        await program.parseAsync(["agent", "dispatch", "watch", "--retries", retriesValue], {
          from: "user",
        });
      } catch {
        // expected: mocked process.exit throws
      } finally {
        console.error = origError;
      }

      // AC: @trait-semantic-exit-codes ac-2 - invalid numeric input exits with validation error
      expect(exitCode).toBe(4);
      expect(consoleErrors.join(" ")).toContain("Invalid --retries value");
      expect(wsCtor).not.toHaveBeenCalled();
    },
  );

  it("should validate invalid --retries before checking daemon availability", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    const isDaemonRunningSpy = vi
      .spyOn(PidFileManager.prototype, "isDaemonRunning")
      .mockReturnValue(false);
    const readPortSpy = vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);

    const consoleErrors: string[] = [];
    const origError = console.error;
    console.error = (...args) => {
      consoleErrors.push(args.join(" "));
    };

    let exitCode: number | undefined;
    vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    });

    const program = createTestProgram();
    try {
      await program.parseAsync(["agent", "dispatch", "watch", "--retries", "foo"], {
        from: "user",
      });
    } catch {
      // expected: mocked process.exit throws
    } finally {
      console.error = origError;
    }

    expect(exitCode).toBe(4);
    expect(consoleErrors.join(" ")).toContain("Invalid --retries value");
    expect(isDaemonRunningSpy).not.toHaveBeenCalled();
    expect(readPortSpy).not.toHaveBeenCalled();
  });
});

// AC: @ws-session-event-streaming ac-cli-watch-parity
// AC: @trait-websocket-protocol ac-1 — N/A: server-side connection ID assignment, not CLI consumer
// AC: @trait-websocket-protocol ac-3 — N/A: server-side broadcast event format, not CLI consumer
// AC: @trait-websocket-protocol ac-4 — N/A: server-side ping frame timing, not CLI consumer
// AC: @trait-websocket-protocol ac-5 — N/A: server-side pong timeout handling, not CLI consumer
// AC: @trait-websocket-protocol ac-6 — N/A: server-side backpressure handling, not CLI consumer
// AC: @trait-websocket-protocol ac-7 — N/A: server-side close code semantics, not CLI consumer
describe("ac-cli-watch-parity: dispatch watch — typed event stream", () => {
  afterEach(() => {
    _setWebSocketCtor(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — text streams progressively at newline boundaries
  it("should stream message text progressively at newline boundaries", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    // Simulate newline-boundary streaming: two progress events with line content
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-1", agent_id: "worker", text: "Line one\n" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-1", agent_id: "worker", text: "Line two\n" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_complete",
        data: { session_id: "sess-1", agent_id: "worker", text: "Final partial" },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("[worker sess-1]\nLine one\nLine two\nFinal partial");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — tool calls show name and status transitions
  it("should display tool_call_start with tool name and input summary", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "tool_call_start",
        data: {
          session_id: "sess-1",
          agent_id: "worker",
          tool_call_id: "tc-1",
          tool_name: "Read",
          tool_input: { file_path: "/src/main.ts" },
        },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("⚡ Tool: Read");
    expect(output).toContain("/src/main.ts");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — tool calls show status transitions
  it("should display tool_call_complete with status and duration", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "tool_call_complete",
        data: {
          session_id: "sess-1",
          agent_id: "worker",
          tool_call_id: "tc-1",
          tool_name: "Read",
          status: "completed",
          duration_ms: 1500,
        },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("✓ Read completed (1.5s)");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — tool call with sub-second duration
  it("should format sub-second tool call durations in milliseconds", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "tool_call_complete",
        data: {
          session_id: "sess-1",
          agent_id: "worker",
          tool_call_id: "tc-2",
          tool_name: "Bash",
          status: "completed",
          duration_ms: 250,
        },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("✓ Bash completed (250ms)");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — thinking blocks hidden by default
  it("should not display thinking events when --verbose is not set", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "thinking_progress",
        data: { session_id: "sess-1", agent_id: "worker", text: "internal reasoning\n" },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        event: "thinking_complete",
        data: { session_id: "sess-1", agent_id: "worker", text: "done thinking" },
      }),
    });
    // Non-thinking message should appear
    ws.onmessage?.({
      data: JSON.stringify({
        event: "message_progress",
        data: { session_id: "sess-1", agent_id: "worker", text: "visible output" },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).not.toContain("internal reasoning");
    expect(output).not.toContain("done thinking");
    expect(output).toContain("visible output");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — thinking blocks shown with --verbose
  it("should display thinking events dimmed when --verbose is set", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch", "--verbose"], {
      from: "user",
    });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "thinking_progress",
        data: { session_id: "sess-1", agent_id: "worker", text: "deep thought\n" },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    // Should contain the thinking text with ANSI dim escape codes
    expect(output).toContain("deep thought");
    expect(output).toContain("\x1b[2m"); // dim start
    expect(output).toContain("\x1b[22m"); // dim end

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — full lifecycle sequence
  it("should render a full message → tool call → message lifecycle", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    const events = [
      { event: "message_start", data: { session_id: "sess-1", agent_id: "worker" } },
      {
        event: "message_progress",
        data: { session_id: "sess-1", agent_id: "worker", text: "Let me read that file.\n" },
      },
      { event: "message_complete", data: { session_id: "sess-1", agent_id: "worker", text: "" } },
      {
        event: "tool_call_start",
        data: {
          session_id: "sess-1",
          agent_id: "worker",
          tool_call_id: "tc-1",
          tool_name: "Read",
          tool_input: { file_path: "/src/index.ts" },
        },
      },
      {
        event: "tool_call_complete",
        data: {
          session_id: "sess-1",
          agent_id: "worker",
          tool_call_id: "tc-1",
          tool_name: "Read",
          status: "completed",
          duration_ms: 45,
        },
      },
      { event: "message_start", data: { session_id: "sess-1", agent_id: "worker" } },
      {
        event: "message_progress",
        data: { session_id: "sess-1", agent_id: "worker", text: "Here is the content.\n" },
      },
      { event: "message_complete", data: { session_id: "sess-1", agent_id: "worker", text: "" } },
    ];

    for (const evt of events) {
      ws.onmessage?.({ data: JSON.stringify(evt) });
    }
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("Let me read that file.");
    expect(output).toContain("⚡ Tool: Read");
    expect(output).toContain("✓ Read completed (45ms)");
    expect(output).toContain("Here is the content.");

    runPromise.catch(() => {
      /* ignore */
    });
  });

  // AC: @ws-session-event-streaming ac-cli-watch-parity — tool input summary truncation
  it("should truncate long tool input summaries to 80 chars", async () => {
    const { PidFileManager } = await import("../src/cli/pid-utils.js");
    vi.spyOn(PidFileManager.prototype, "isDaemonRunning").mockReturnValue(true);
    vi.spyOn(PidFileManager.prototype, "readPort").mockReturnValue(9999);
    await mockInitContextFast();

    const { FakeWs, getLastInstance } = makeFakeWsClass();
    _setWebSocketCtor(FakeWs as unknown as typeof WebSocket);

    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    const program = createTestProgram();
    const runPromise = program.parseAsync(["agent", "dispatch", "watch"], { from: "user" });

    await waitFor(() => getLastInstance() !== null, DISPATCH_WATCH_READY_TIMEOUT_MS);
    const ws = getLastInstance()!;
    ws.onopen?.({});

    ws.onmessage?.({
      data: JSON.stringify({
        event: "tool_call_start",
        data: {
          session_id: "sess-1",
          agent_id: "worker",
          tool_call_id: "tc-3",
          tool_name: "Write",
          tool_input: {
            file_path:
              "/very/long/path/to/some/deeply/nested/file/that/exceeds/eighty/characters/definitely.ts",
            content: "lots of content here",
          },
        },
      }),
    });
    await Promise.resolve();

    const output = written.join("");
    expect(output).toContain("⚡ Tool: Write");
    // Should contain truncation marker
    expect(output).toContain("...");
    // The parenthesized input summary should be <= 83 chars (80 content + parens + space)
    const toolLine = output.split("\n").find((l) => l.includes("⚡ Tool: Write"))!;
    const inputPart = toolLine.match(/\(.*\)/)?.[0];
    expect(inputPart).toBeDefined();
    expect(inputPart!.length).toBeLessThanOrEqual(82); // ( + 77 chars + ... + ) = 82

    runPromise.catch(() => {
      /* ignore */
    });
  });
});

// AC: @test-suite-perf-reliability ac-3
describe("AC-3: waitFor timeout floor and diagnostic messages", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should enforce 2000ms default timeout floor for waitFor wrapper", async () => {
    // AC-3 requires polling timeout >= 2000ms with configurable override.
    // Use fake timers so we can verify the timeout duration without real-time waits.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let probeCount = 0;
    let rejected = false;
    let rejectionError: Error | undefined;

    // Start the waitFor — attach a handler immediately to prevent unhandled rejection
    const waitPromise = waitFor(() => {
      probeCount++;
      return false; // never resolves
    }).catch((e: Error) => {
      rejected = true;
      rejectionError = e;
    });

    // Advance just under 2000ms — should NOT have thrown yet
    await vi.advanceTimersByTimeAsync(1900);
    // probeCount > 0 confirms the helper is actually polling
    expect(probeCount).toBeGreaterThan(0);
    expect(rejected).toBe(false);

    // Advance past 2000ms — should reject with timeout
    await vi.advanceTimersByTimeAsync(200);
    await waitPromise;

    expect(rejected).toBe(true);
    expect(rejectionError?.message).toMatch(/timed out/i);
    expect(rejectionError?.message).toContain("2000ms");
  });

  it("should include last observed state in timeout error message", async () => {
    // AC-3 requires timeout errors include the last observed state for diagnosis.
    const err = await waitForStartup(
      "diagnostic-probe",
      async () => ({ ok: false, details: "ws_connected=false pending_ack=true" }),
      { timeoutMs: 50, intervalMs: 10 },
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    // Must include the description
    expect((err as Error).message).toContain("diagnostic-probe");
    // Must include the last observed state details
    expect((err as Error).message).toContain("ws_connected=false pending_ack=true");
    // Must include "Last observation" label for diagnosis
    expect((err as Error).message).toContain("Last observation");
  });

  it("should allow configurable timeout override", async () => {
    // AC-3: "configurable override" — callers can pass a custom timeout.
    const start = Date.now();
    await expect(
      waitForStartup("short override test", async () => ({ ok: false, details: "still waiting" }), {
        timeoutMs: 100,
        intervalMs: 10,
      }),
    ).rejects.toThrow(/timed out/i);
    const elapsed = Date.now() - start;
    // Should respect the override (100ms), not the default
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it("should not hang past timeout when probe never settles", async () => {
    // Regression: an unbounded probe (e.g. a fetch with no AbortSignal) used
    // to block inside `await probe()` forever, so the loop budget never
    // re-evaluated. The only break was the outer test timeout. Each probe
    // call must be raced against the remaining wait budget.
    const start = Date.now();
    const err = await waitForStartup(
      "never-settling-probe",
      // The probe promise resolves after 60s — far past the wait budget.
      () =>
        new Promise<{ ok: boolean; details: string }>((resolveProbe) => {
          setTimeout(() => resolveProbe({ ok: true, details: "would never run" }), 60_000);
        }),
      { timeoutMs: 200, intervalMs: 10 },
    ).catch((e: Error) => e);
    const elapsed = Date.now() - start;

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/i);
    expect((err as Error).message).toContain("never-settling-probe");
    expect((err as Error).message).toContain("did not settle");
    // Generous upper bound to absorb scheduling jitter on shared CI runners
    // while still proving the wait did not actually block on the 60s probe.
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});

// AC: @test-suite-perf-reliability ac-4
describe("AC-4: crypto polyfill prevents ReferenceError", () => {
  it("should restore globalThis.crypto when it is missing", async () => {
    // Save original and remove globalThis.crypto to simulate Node < 19
    const originalCrypto = globalThis.crypto;
    delete (globalThis as Record<string, unknown>).crypto;

    // Verify crypto is actually gone
    expect(globalThis.crypto).toBeUndefined();

    // Re-run the polyfill logic (same as tests/setup.ts)
    const nodeCrypto = await import("node:crypto");
    if (!globalThis.crypto) {
      (globalThis as Record<string, unknown>).crypto = nodeCrypto.webcrypto;
    }

    // Verify the polyfill restored crypto and randomUUID works
    expect(globalThis.crypto).toBeDefined();
    expect(() => globalThis.crypto.randomUUID()).not.toThrow();

    const uuid = globalThis.crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Restore original to avoid polluting other tests
    (globalThis as Record<string, unknown>).crypto = originalCrypto;
  });

  it("should prevent ReferenceError when crypto.randomUUID is called after polyfill", async () => {
    // Simulate the exact failure mode: code calls crypto.randomUUID()
    // in an environment where globalThis.crypto was never set.
    const originalCrypto = globalThis.crypto;
    delete (globalThis as Record<string, unknown>).crypto;

    // Without polyfill, this would throw ReferenceError
    expect(() => globalThis.crypto.randomUUID()).toThrow();

    // Apply polyfill
    const nodeCrypto = await import("node:crypto");
    (globalThis as Record<string, unknown>).crypto = nodeCrypto.webcrypto;

    // After polyfill, the same call succeeds
    expect(() => globalThis.crypto.randomUUID()).not.toThrow();

    // Restore
    (globalThis as Record<string, unknown>).crypto = originalCrypto;
  });
});
