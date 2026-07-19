/**
 * CLI tests for agent runner mutation and display surfaces.
 *
 * Covers:
 * - AC: @agent-definition-schema ac-runner-field-accepted
 * - AC: @agent-definition-schema ac-meta-set-runner-preserves-fields
 * - AC: @agent-runner-configuration ac-agent-runner-reference
 * - AC: @agent-runner-configuration ac-adapter-field-backcompat
 * - AC: @agent-runner-configuration ac-runner-precedence-over-adapter
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
import { deriveProjectKeySync } from "../src/agents/runner-config.js";

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

// ─── runner precedence over adapter (list + run) ────────────────────────────

/**
 * Write a system runner config under the CLI's isolated HOME so the
 * subprocess loads it via the standard `~/.config/kspec/projects/<key>/runners.yaml`
 * path. The test helper sets HOME to `<cwd>/.test-home` and creates the
 * config dir at the first kspec invocation; this writer creates the file
 * eagerly so the registry is populated before the CLI runs.
 */
function writeSystemRunnersForProject(projectDir: string, runners: object): void {
  const projectKey = deriveProjectKeySync(projectDir);
  const sysRunnersDir = path.join(
    projectDir,
    ".test-home",
    ".config",
    "kspec",
    "projects",
    projectKey,
  );
  fsSync.mkdirSync(sysRunnersDir, { recursive: true });
  fsSync.writeFileSync(path.join(sysRunnersDir, "runners.yaml"), YAML.stringify({ runners }));
}

describe("CLI: runner precedence over adapter", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-runner-precedence-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  // AC: @runner-operator-surfaces ac-agent-list-shows-runner
  it("agent list shows the runner-resolved adapter when both runner and adapter are set", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "dual",
        name: "Dual",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "named-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "named-runner": { kind: "acp_process", adapter: "codex-acp" },
    });

    const result = kspecRun("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as AgentListJson;
    expect(data.items[0].runner).toBe("named-runner");
    expect(data.items[0].adapter).toBe("codex-acp");
  });

  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  // AC: @runner-operator-surfaces ac-agent-list-shows-runner
  it("agent list shows the runner-resolved adapter for a runner-only agent", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-only",
        name: "Runner Only",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "named-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "named-runner": { kind: "acp_process", adapter: "codex-acp" },
    });

    const result = kspecRun("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as AgentListJson;
    expect(data.items[0].runner).toBe("named-runner");
    expect(data.items[0].adapter).toBe("codex-acp");
  });

  // AC: @runner-operator-surfaces ac-agent-list-shows-runner — human-readable shows runner-resolved adapter
  it("agent list human-readable shows runner-resolved adapter", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "dual-human",
        name: "Dual Human",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "named-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "named-runner": { kind: "acp_process", adapter: "codex-acp" },
    });

    const result = kspecRun("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("codex-acp");
    expect(result.stdout).not.toContain("claude-agent-acp");
    expect(result.stdout).toContain("runner: named-runner");
  });

  // AC: @agent-runner-configuration ac-adapter-field-backcompat — adapter still surfaces when no runner
  it("agent list falls back to agent.adapter when no runner is configured", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "legacy",
        name: "Legacy",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "codex-acp",
        auto_approve: false,
      },
    ]);

    const result = kspecRun("agent list --json", testDir);
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.stdout) as AgentListJson;
    expect(data.items[0].adapter).toBe("codex-acp");
  });

  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  // AC: @cli-agent-commands ac-7 — overrides visible in dry-run
  it("agent run --dry-run reports the runner-resolved adapter when runner is set", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "dual-run",
        name: "Dual Run",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "named-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "named-runner": { kind: "acp_process", adapter: "codex-acp" },
    });

    const data = kspecJson<{ adapter: string }>('agent run dual-run --dry-run "run me"', testDir);
    expect(data.adapter).toBe("codex-acp");
  });

  // AC: @cli-agent-commands ac-7 — --adapter CLI override wins over runner resolution
  it("agent run --adapter explicit override wins over runner resolution", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "override",
        name: "Override",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "named-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "named-runner": { kind: "acp_process", adapter: "codex-acp" },
    });

    const data = kspecJson<{ adapter: string }>(
      'agent run override --dry-run --adapter claude-code-acp "run me"',
      testDir,
    );
    expect(data.adapter).toBe("claude-code-acp");
  });

  // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
  // Unresolved runner reference fails fast at invocation rather than falling
  // back silently to a stale adapter — the validation surface owns this gate.
  it("agent run fails fast when runner reference does not resolve and no --adapter override is given", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "broken",
        name: "Broken",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "missing-runner",
        auto_approve: false,
      },
    ]);

    const result = kspecRun('agent run broken --dry-run "run me"', testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("missing-runner");
  });

  // AC: @cli-agent-commands ac-7 — --adapter unblocks a broken runner reference
  it("agent run --adapter unblocks an unresolved runner reference", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "rescue",
        name: "Rescue",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "missing-runner",
        auto_approve: false,
      },
    ]);

    const data = kspecJson<{ adapter: string }>(
      'agent run rescue --dry-run --adapter codex-acp "run me"',
      testDir,
    );
    expect(data.adapter).toBe("codex-acp");
  });
});

// ─── agent run rejects direct/legacy generic-acp selection ──────────────────

describe("CLI: generic-acp requires a runner-backed config", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-generic-acp-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-generic-acp-direct-invocation-requires-runner
  it("fails before spawn when an agent sets adapter: generic-acp without a runner", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "legacy-generic",
        name: "Legacy Generic",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "generic-acp",
        auto_approve: false,
      },
    ]);

    const result = kspecRun('agent run legacy-generic --dry-run "run me"', testDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("generic-acp");
    expect(combined).toContain("process.executable");
    expect(combined).toContain("runner");
  });

  // AC: @runner-resolution-and-preflight ac-generic-acp-direct-invocation-requires-runner
  it("fails before spawn when --adapter generic-acp is selected without a runner", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "override-generic",
        name: "Override Generic",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const result = kspecRun(
      'agent run override-generic --dry-run --adapter generic-acp "run me"',
      testDir,
      {
        expectFail: true,
      },
    );
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("generic-acp");
    expect(combined).toContain("process.executable");
    expect(combined).toContain("runner");
  });
});

// ─── agent run --dry-run reports runner process invocation contract ─────────

/**
 * Shape of the `runner_invocation` block surfaced by `kspec agent run --dry-run`.
 * Mirrors `RunnerInvocationSummary` from `src/agents/runners.ts` minus the
 * implementation-level type aliases — tests only assert on the shape that
 * crosses the JSON output boundary.
 */
interface DryRunSummary {
  resolved: true;
  summary: {
    runner: { name: string | null; source: string };
    adapter: { id: string; source: string };
    source_layer: string;
    overrides: string[];
    process: {
      command: string;
      command_source: string;
      cwd: string;
      cwd_source: string;
      runner_args: string[];
      runner_args_source: string;
      auto_approve_args: string[];
    };
    env_policy: {
      inherit_parent_env: boolean;
      inherit: string | null;
      pass_keys: string[];
      pass_source: string;
      set_keys: string[];
      set_keys_origin: Record<string, string>;
      secret_keys: string[];
      secret_source: string;
    };
    preflight: { status: string; reason?: string; message?: string; resolved?: string };
  };
}

interface DryRunSummaryError {
  resolved: false;
  error: { reason: string; message: string; details?: Record<string, unknown> };
}

type DryRunPayload = {
  dry_run: true;
  adapter: string;
  runner_invocation: DryRunSummary | DryRunSummaryError;
};

describe("CLI: agent run --dry-run runner process invocation contract", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-agent-dry-run-process-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  it("reports the runner-configured command reference, sources, and env policy", () => {
    const fakeExecutable = path.join(testDir, "fake-runner-binary");
    fsSync.writeFileSync(fakeExecutable, "#!/bin/sh\nexit 0\n", "utf-8");
    fsSync.chmodSync(fakeExecutable, 0o755);

    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "proc-diag",
        name: "Process Diagnostic",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "configured-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "configured-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: {
          executable: fakeExecutable,
          args: ["--scope=runner"],
          cwd: testDir,
        },
        env: {
          inherit: "none",
          pass: ["TZ"],
          set: { KSPEC_CHILD_FLAG: "1" },
          secrets: {
            ANTHROPIC_API_KEY: { source: "user_env", required: false },
          },
        },
      },
    });

    const data = kspecJson<DryRunPayload>('agent run proc-diag --dry-run "run me"', testDir);
    expect(data.dry_run).toBe(true);
    expect(data.runner_invocation.resolved).toBe(true);
    if (!data.runner_invocation.resolved) throw new Error("unreachable");
    const s = data.runner_invocation.summary;

    // Runner identity + adapter wired through the runner.
    expect(s.runner.name).toBe("configured-runner");
    expect(s.runner.source).toBe("agent.runner");
    expect(s.adapter.id).toBe("claude-agent-acp");
    expect(s.adapter.source).toBe("runner");

    // Process inputs: configured command + args + cwd, each with source attribution.
    expect(s.process.command).toBe(fakeExecutable);
    expect(s.process.command_source).toBe("runner.system");
    expect(s.process.cwd).toBe(testDir);
    expect(s.process.cwd_source).toBe("runner.system");
    expect(s.process.runner_args).toEqual(["--scope=runner"]);
    expect(s.process.runner_args_source).toBe("runner.system");

    // Env policy reports key names + inheritance policy without exposing values.
    expect(s.env_policy.inherit).toBe("none");
    expect(s.env_policy.inherit_parent_env).toBe(false);
    expect(s.env_policy.pass_keys).toEqual(["TZ"]);
    expect(s.env_policy.set_keys).toEqual(["KSPEC_CHILD_FLAG"]);
    expect(s.env_policy.secret_keys).toEqual(["ANTHROPIC_API_KEY"]);

    // Secret values are never carried into the diagnostic surface.
    const wholeOutput = JSON.stringify(data);
    expect(wholeOutput).not.toContain("user_env_value");
    // Set key values must not leak either — only key names.
    expect(wholeOutput).not.toMatch(/KSPEC_CHILD_FLAG.*1.*"value"/i);

    // Preflight outcome reflects the executable check the spawn would see.
    expect(s.preflight.status).toBe("ok");
    expect(s.preflight.resolved).toBe(fakeExecutable);
  });

  // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  it("reports a typed unspawnable preflight diagnostic when the configured executable is missing", () => {
    const missingExecutable = path.join(testDir, "no-such-runner");

    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "proc-unspawnable",
        name: "Process Unspawnable",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "broken-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "broken-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: missingExecutable },
      },
    });

    const data = kspecJson<DryRunPayload>(
      'agent run proc-unspawnable --dry-run "preview"',
      testDir,
    );
    expect(data.runner_invocation.resolved).toBe(true);
    if (!data.runner_invocation.resolved) throw new Error("unreachable");
    const s = data.runner_invocation.summary;

    // The contract still identifies the configured command so the operator
    // sees what the spawn would attempt — but the preflight block flips to
    // unspawnable with a typed reason instead of leaking a generic spawn ENOENT.
    expect(s.process.command).toBe(missingExecutable);
    expect(s.process.command_source).toBe("runner.system");
    expect(s.preflight.status).toBe("unspawnable");
    expect(s.preflight.reason).toBe("not_found");
    expect(s.preflight.message).toContain(missingExecutable);
  });

  // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
  it("reports the implicit/legacy path when no runner is configured", () => {
    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "legacy-proc",
        name: "Legacy",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const data = kspecJson<DryRunPayload>('agent run legacy-proc --dry-run "preview"', testDir);
    expect(data.runner_invocation.resolved).toBe(true);
    if (!data.runner_invocation.resolved) throw new Error("unreachable");
    const s = data.runner_invocation.summary;

    expect(s.runner.name).toBeNull();
    expect(s.runner.source).toBe("implicit");
    expect(s.source_layer).toBe("implicit");
    // Implicit path: command source falls back to the adapter registry.
    expect(s.process.command_source).toBe("adapter");
    expect(s.process.cwd_source).toBe("invocation");
    // Env policy collapses to the implicit (host-inherited) shape.
    expect(s.env_policy.inherit).toBeNull();
    expect(s.env_policy.inherit_parent_env).toBe(true);
    expect(s.env_policy.set_keys).toEqual([]);
    expect(s.env_policy.secret_keys).toEqual([]);
    // No runner-configured executable to preflight.
    expect(s.preflight.status).toBe("skipped");
  });

  // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
  it("splits auto-approve args from runner.process.args so each segment's source is identifiable", () => {
    const fakeExecutable = path.join(testDir, "fake-runner-args");
    fsSync.writeFileSync(fakeExecutable, "#!/bin/sh\nexit 0\n", "utf-8");
    fsSync.chmodSync(fakeExecutable, 0o755);

    writeAgentListProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "split-args",
        name: "Split Args",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "args-runner",
        auto_approve: true,
      },
    ]);
    writeSystemRunnersForProject(testDir, {
      "args-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: {
          executable: fakeExecutable,
          args: ["--runner-flag", "value"],
        },
      },
    });

    const data = kspecJson<DryRunPayload>('agent run split-args --dry-run "preview"', testDir);
    expect(data.runner_invocation.resolved).toBe(true);
    if (!data.runner_invocation.resolved) throw new Error("unreachable");
    const s = data.runner_invocation.summary;

    // Runner-process args are reported under their own source attribution.
    expect(s.process.runner_args).toEqual(["--runner-flag", "value"]);
    expect(s.process.runner_args_source).toBe("runner.system");
    // Auto-approve args from the adapter never get mislabeled as runner args
    // — the segments are split deterministically.
    for (const arg of s.process.auto_approve_args) {
      expect(s.process.runner_args).not.toContain(arg);
    }
  });
});
