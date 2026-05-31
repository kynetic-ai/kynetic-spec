/**
 * CLI tests for agent runner mutation and display surfaces.
 *
 * Covers:
 * - AC: @agent-definition-schema ac-runner-field-accepted
 * - AC: @agent-definition-schema ac-meta-set-runner-preserves-fields
 * - AC: @agent-runner-configuration ac-agent-runner-reference
 * - AC: @agent-runner-configuration ac-adapter-field-backcompat
 * - AC: @runner-operator-surfaces ac-agent-set-updates-runner
 * - AC: @runner-operator-surfaces ac-agent-list-shows-runner
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  kspec as kspecRun,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";

interface AgentJsonRow {
  id: string;
  name?: string;
  adapter?: string;
  runner?: string;
  capabilities?: string[];
  tools?: string[];
  budget?: { max_tasks?: number; timeout_minutes?: number; max_retries?: number };
  concurrency?: { max_concurrent: number };
  auto_approve?: boolean;
  skills?: string[];
  tags?: string[];
}

// ─── meta add / meta set runner mutation ─────────────────────────────────────

describe("CLI: kspec meta add agent --runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @agent-definition-schema ac-runner-field-accepted
  // AC: @agent-runner-configuration ac-agent-runner-reference
  it("creates an agent with runner set", () => {
    const result = kspecRun(
      'meta add agent --id runner-agent --name "Runner Agent" --runner claude-code-default',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<AgentJsonRow[]>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "runner-agent");
    expect(agent).toBeDefined();
    expect(agent?.runner).toBe("claude-code-default");
  });

  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("creates a legacy adapter-only agent without runner field", () => {
    const result = kspecRun(
      'meta add agent --id legacy-agent --name "Legacy" --adapter "npx @kynetic/claude"',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<AgentJsonRow[]>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "legacy-agent");
    expect(agent).toBeDefined();
    expect(agent?.adapter).toBe("npx @kynetic/claude");
    expect(agent?.runner).toBeUndefined();
  });

  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  // Schema/CLI stores both; runtime resolution gives runner precedence.
  it("creates an agent that carries both runner and adapter", () => {
    const result = kspecRun(
      'meta add agent --id dual-agent --name "Dual" --runner runner-x --adapter adapter-y',
      tempDir,
    );
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<AgentJsonRow[]>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "dual-agent");
    expect(agent?.runner).toBe("runner-x");
    expect(agent?.adapter).toBe("adapter-y");
  });
});

describe("CLI: kspec meta set <agent> --runner / --clear-runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @runner-operator-surfaces ac-agent-set-updates-runner
  // AC: @agent-definition-schema ac-runner-field-accepted
  it("sets the runner field on an existing agent", () => {
    kspecRun('meta add agent --id mutate-runner --name "Mutate Runner"', tempDir);

    const result = kspecRun("meta set mutate-runner --runner codex-default", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<AgentJsonRow[]>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "mutate-runner");
    expect(agent?.runner).toBe("codex-default");
  });

  // AC: @runner-operator-surfaces ac-agent-set-updates-runner
  it("clears the runner field via --clear-runner", () => {
    kspecRun(
      'meta add agent --id clear-runner --name "Clear Runner" --runner claude-code-default',
      tempDir,
    );

    const result = kspecRun("meta set clear-runner --clear-runner", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<AgentJsonRow[]>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "clear-runner");
    expect(agent).toBeDefined();
    expect(agent?.runner).toBeUndefined();
  });

  // AC: @agent-definition-schema ac-meta-set-runner-preserves-fields
  // AC: @runner-operator-surfaces ac-agent-set-updates-runner
  it("preserves unrelated fields when setting the runner", () => {
    kspecRun(
      [
        'meta add agent --id preserve-set --name "Preserve Set"',
        "--adapter legacy-adapter",
        "--capability code --capability test",
        "--tool kspec",
        "--skill task-work",
        "--max-tasks 7 --timeout-minutes 45 --max-concurrent 2",
        "--auto-approve",
      ].join(" "),
      tempDir,
    );

    const result = kspecRun("meta set preserve-set --runner new-runner", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<AgentJsonRow[]>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "preserve-set");
    expect(agent).toBeDefined();
    expect(agent?.runner).toBe("new-runner");
    expect(agent?.adapter).toBe("legacy-adapter");
    expect(agent?.capabilities).toEqual(expect.arrayContaining(["code", "test"]));
    expect(agent?.tools).toEqual(expect.arrayContaining(["kspec"]));
    expect(agent?.skills).toEqual(expect.arrayContaining(["task-work"]));
    expect(agent?.budget?.max_tasks).toBe(7);
    expect(agent?.budget?.timeout_minutes).toBe(45);
    expect(agent?.concurrency?.max_concurrent).toBe(2);
    expect(agent?.auto_approve).toBe(true);
  });

  // AC: @agent-definition-schema ac-meta-set-runner-preserves-fields
  it("preserves unrelated fields when clearing the runner", () => {
    kspecRun(
      [
        'meta add agent --id preserve-clear --name "Preserve Clear"',
        "--runner old-runner",
        "--adapter legacy-adapter",
        "--capability code",
        "--tool git",
        "--skill review",
        "--max-tasks 3",
      ].join(" "),
      tempDir,
    );

    const result = kspecRun("meta set preserve-clear --clear-runner", tempDir);
    expect(result.exitCode).toBe(0);

    const agents = kspecJson<AgentJsonRow[]>("meta agents", tempDir);
    const agent = agents.find((a) => a.id === "preserve-clear");
    expect(agent).toBeDefined();
    expect(agent?.runner).toBeUndefined();
    expect(agent?.adapter).toBe("legacy-adapter");
    expect(agent?.capabilities).toEqual(expect.arrayContaining(["code"]));
    expect(agent?.tools).toEqual(expect.arrayContaining(["git"]));
    expect(agent?.skills).toEqual(expect.arrayContaining(["review"]));
    expect(agent?.budget?.max_tasks).toBe(3);
  });
});

// ─── agent list runner display ──────────────────────────────────────────────

interface AgentListJson {
  items: Array<{
    id: string;
    name?: string;
    adapter?: string;
    runner?: string;
  }>;
  total: number;
}

function writeAgentListProject(testDir: string, agents: object[]): void {
  initGitRepo(testDir);
  fsSync.writeFileSync(
    path.join(testDir, "kynetic.yaml"),
    YAML.stringify({ kynetic: "1", title: "Test" }),
  );
  fsSync.writeFileSync(
    path.join(testDir, "kynetic.meta.yaml"),
    YAML.stringify({ kynetic_meta: "1.0", agents }),
  );
  fsSync.writeFileSync(path.join(testDir, "project.tasks.yaml"), YAML.stringify({ tasks: [] }));
}

describe("CLI: kspec agent list runner field", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-list-runner-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-operator-surfaces ac-agent-list-shows-runner — JSON includes runner
  // AC: @agent-runner-configuration ac-agent-runner-reference
  it("includes runner in JSON output when an agent has runner set", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-listed",
        name: "Runner Listed",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "claude-code-default",
        auto_approve: false,
      },
    ]);

    const result = kspecRun("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as AgentListJson;
    expect(data.items[0].runner).toBe("claude-code-default");
    // AC: @agent-runner-configuration ac-adapter-field-backcompat — adapter still emitted
    expect(data.items[0].adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-operator-surfaces ac-agent-list-shows-runner — runner omitted when absent
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("omits runner from JSON output for legacy adapter-only agents", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "legacy-listed",
        name: "Legacy Listed",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const result = kspecRun("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as AgentListJson;
    expect(data.items[0].runner).toBeUndefined();
    expect(data.items[0].adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-operator-surfaces ac-agent-list-shows-runner — human-readable shows runner
  it("shows runner in human-readable output when present", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-human",
        name: "Runner Human",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "claude-code-default",
        auto_approve: false,
      },
    ]);

    const result = kspecRun("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("runner:");
    expect(result.stdout).toContain("claude-code-default");
    // Adapter still surfaces alongside runner.
    expect(result.stdout).toContain("claude-agent-acp");
  });

  it("does not show a runner line in human-readable output when absent", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "no-runner-human",
        name: "No Runner Human",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const result = kspecRun("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("runner:");
  });
});
