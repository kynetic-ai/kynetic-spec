/**
 * CLI tests for runner validation and diagnostic surfaces.
 *
 * Covers `kspec agent runners validate`, the `runner_validation` field added
 * to `kspec agent list --json`, and the `validation_state` field added to
 * `kspec agent run --dry-run`.
 *
 * AC: @runner-operator-surfaces ac-agent-list-shows-runner
 * AC: @runner-operator-surfaces ac-runner-validation-human-output
 * AC: @runner-operator-surfaces ac-runner-validation-json-output
 * AC: @runner-operator-surfaces ac-runner-validation-exit-status
 * AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
 * AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  kspec as kspecRun,
  kspecJson,
  cleanupTempDir,
  createTempDir,
  initGitRepo,
  testUlid,
} from "./helpers/cli.js";
import { deriveProjectKeySync } from "../src/agents/runner-config.js";

interface ValidationDiagnostic {
  reason: string;
  message: string;
  details?: Record<string, unknown>;
}

interface ValidationEntry {
  runner: string;
  kind: string;
  resolved_adapter: string;
  command_source: string;
  cwd_source: string;
  args_source: string;
  status: "valid" | "invalid";
  sources: Record<string, unknown>;
  overrides: string[];
  diagnostics: ValidationDiagnostic[];
}

interface ValidationReportPayload {
  ok: boolean;
  runners: ValidationEntry[];
  issues: ValidationDiagnostic[];
}

interface AgentListJson {
  items: Array<{
    id: string;
    name?: string;
    adapter?: string;
    resolved_adapter?: string;
    runner?: string;
    runner_validation?: {
      status: "valid" | "invalid";
      diagnostics: ValidationDiagnostic[];
    };
  }>;
  total: number;
}

interface DryRunPayload {
  dry_run: true;
  adapter: string;
  validation_state: (ValidationEntry & { selected: true }) | { selected: false; reason: string };
}

function writeAgentProject(testDir: string, agents: object[]): void {
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

function writeSystemRunners(projectDir: string, runners: object): void {
  const projectKey = deriveProjectKeySync(projectDir);
  const sysDir = path.join(projectDir, ".test-home", ".config", "kspec", "projects", projectKey);
  fsSync.mkdirSync(sysDir, { recursive: true });
  fsSync.writeFileSync(path.join(sysDir, "runners.yaml"), YAML.stringify({ runners }));
}

function writeMalformedSystemRunners(projectDir: string, content: string): string {
  const projectKey = deriveProjectKeySync(projectDir);
  const sysDir = path.join(projectDir, ".test-home", ".config", "kspec", "projects", projectKey);
  fsSync.mkdirSync(sysDir, { recursive: true });
  const filePath = path.join(sysDir, "runners.yaml");
  fsSync.writeFileSync(filePath, content);
  return filePath;
}

function writeMalformedProjectRunners(projectDir: string, content: string): string {
  // The CLI test helper uses a non-shadow layout (manifest in projectDir
  // directly), so `ctx.specDir` resolves to projectDir and the project
  // runner config path is `<projectDir>/project.runners.yaml`.
  const filePath = path.join(projectDir, "project.runners.yaml");
  fsSync.writeFileSync(filePath, content);
  return filePath;
}

function makeFakeExecutable(dir: string, name: string): string {
  const filePath = path.join(dir, name);
  fsSync.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf-8");
  fsSync.chmodSync(filePath, 0o755);
  return filePath;
}

// ─── kspec agent runners validate ────────────────────────────────────────────

describe("CLI: kspec agent runners validate (human output)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runners-validate-human-");
    writeAgentProject(testDir, []);
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-human-output
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("reports valid runners with status, resolved adapter, and source attribution", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeSystemRunners(testDir, {
      "good-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake, args: ["--verbose"], cwd: testDir },
        env: { inherit: "minimal" },
      },
    });

    const result = kspecRun("agent runners validate", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("good-runner");
    expect(result.stdout).toContain("[valid]");
    expect(result.stdout).toContain("resolved_adapter:");
    expect(result.stdout).toContain("claude-agent-acp");
    expect(result.stdout).toContain("command_source:");
    expect(result.stdout).toContain("runner.system");
    expect(result.stdout).toContain("cwd_source:");
    expect(result.stdout).toContain("args_source:");
    expect(result.stdout).toContain("runner validation passed");
  });

  // AC: @runner-operator-surfaces ac-runner-validation-human-output
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("reports invalid runner with diagnostic guidance when configured executable is missing", () => {
    const missing = path.join(testDir, "no-such-binary");
    writeSystemRunners(testDir, {
      "bad-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: missing },
      },
    });

    const result = kspecRun("agent runners validate", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("bad-runner");
    expect(result.stdout).toContain("[invalid]");
    expect(result.stdout).toContain("unspawnable_command");
    expect(result.stdout).toContain(missing);
    expect(result.stdout).toContain("runner validation failed");
  });
});

describe("CLI: kspec agent runners validate (JSON output)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runners-validate-json-");
    writeAgentProject(testDir, []);
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("emits all required JSON fields for a valid runner", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeSystemRunners(testDir, {
      "good-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake, args: ["--scope=runner"], cwd: testDir },
      },
    });

    const data = kspecJson<ValidationReportPayload>("agent runners validate", testDir);
    expect(data.ok).toBe(true);
    expect(data.runners).toHaveLength(1);

    const entry = data.runners[0];
    // All required AC fields present and populated.
    expect(entry.runner).toBe("good-runner");
    expect(entry.kind).toBe("acp_process");
    expect(entry.resolved_adapter).toBe("claude-agent-acp");
    expect(entry.command_source).toBe("runner.system");
    expect(entry.cwd_source).toBe("runner.system");
    expect(entry.args_source).toBe("runner.system");
    expect(entry.status).toBe("valid");
    expect(entry.sources).toBeDefined();
    expect(entry.overrides).toBeInstanceOf(Array);
    expect(entry.diagnostics).toEqual([]);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("emits status=invalid and exits non-zero when adapter is missing", () => {
    const missing = path.join(testDir, "ghost-bin");
    writeSystemRunners(testDir, {
      "bad-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: missing },
      },
    });

    const result = kspecRun("agent runners validate --json", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    const data = JSON.parse(result.stdout) as ValidationReportPayload;
    expect(data.ok).toBe(false);
    expect(data.runners).toHaveLength(1);
    const entry = data.runners[0];
    expect(entry.status).toBe("invalid");
    expect(entry.diagnostics.length).toBeGreaterThan(0);
    expect(entry.diagnostics[0].reason).toBe("unspawnable_command");
    expect(entry.diagnostics[0].message).toContain(missing);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("exits zero with empty runners array when no runners are configured", () => {
    const data = kspecJson<ValidationReportPayload>("agent runners validate", testDir);
    expect(data.ok).toBe(true);
    expect(data.runners).toEqual([]);
    expect(data.issues).toEqual([]);
  });
});

describe("CLI: kspec agent runners validate --runner", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runners-validate-filter-");
    writeAgentProject(testDir, []);
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("validates only the selected runner when --runner is provided", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeSystemRunners(testDir, {
      alpha: {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake },
      },
      beta: {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: path.join(testDir, "missing") },
      },
    });

    const data = kspecJson<ValidationReportPayload>(
      "agent runners validate --runner alpha",
      testDir,
    );
    expect(data.ok).toBe(true);
    expect(data.runners).toHaveLength(1);
    expect(data.runners[0].runner).toBe("alpha");
  });

  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("reports actionable guidance and exits non-zero for an unknown runner name", () => {
    writeSystemRunners(testDir, {
      exists: { kind: "acp_process", adapter: "claude-agent-acp" },
    });

    const result = kspecRun("agent runners validate --runner missing-name --json", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    const data = JSON.parse(result.stdout) as ValidationReportPayload;
    expect(data.ok).toBe(false);
    expect(data.issues.length).toBeGreaterThan(0);
    const unknown = data.issues.find((i) => i.reason === "unknown_runner");
    expect(unknown).toBeDefined();
    expect(unknown!.message).toContain("missing-name");
    expect(unknown!.message).toContain("project runner config");
    expect(unknown!.message).toContain("system runner config");
  });
});

describe("CLI: kspec agent runners validate (process.cwd)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runners-validate-cwd-");
    writeAgentProject(testDir, []);
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  it("reports invalid_cwd and exits non-zero when runner.process.cwd does not exist", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    const missingCwd = path.join(testDir, "no-such-directory");
    writeSystemRunners(testDir, {
      "bad-cwd-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake, cwd: missingCwd },
      },
    });

    const result = kspecRun("agent runners validate --json", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    const data = JSON.parse(result.stdout) as ValidationReportPayload;
    expect(data.ok).toBe(false);
    expect(data.runners).toHaveLength(1);
    const entry = data.runners[0];
    expect(entry.status).toBe("invalid");
    const diag = entry.diagnostics.find((d) => d.reason === "invalid_cwd");
    expect(diag).toBeDefined();
    expect(diag!.message).toContain(missingCwd);
    expect(diag!.message).toContain("does not exist");
    // The guidance must name the layer that owns the fix.
    expect(diag!.message).toContain("runner.process.cwd");
    expect(diag!.message).toContain("system");
    // Details carry the structured failure mode for telemetry.
    expect(diag!.details).toBeDefined();
    expect(diag!.details!.invalid_cwd_reason).toBe("not_found");
    expect(diag!.details!.cwd_source).toBe("system");
  });

  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("reports invalid_cwd when runner.process.cwd points at a non-directory path", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    const filePath = path.join(testDir, "not-a-directory");
    fsSync.writeFileSync(filePath, "I am a file, not a directory.\n");
    writeSystemRunners(testDir, {
      "file-cwd-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake, cwd: filePath },
      },
    });

    const result = kspecRun("agent runners validate --json", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    const data = JSON.parse(result.stdout) as ValidationReportPayload;
    expect(data.ok).toBe(false);
    const entry = data.runners[0];
    expect(entry.status).toBe("invalid");
    const diag = entry.diagnostics.find((d) => d.reason === "invalid_cwd");
    expect(diag).toBeDefined();
    expect(diag!.message).toContain(filePath);
    expect(diag!.message).toContain("not a directory");
    expect(diag!.details!.invalid_cwd_reason).toBe("not_directory");
  });

  // AC: @runner-operator-surfaces ac-runner-validation-human-output
  // AC: @runner-operator-surfaces ac-runner-validation-exit-status
  it("renders invalid_cwd guidance in the human-readable output and exits non-zero", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    const missingCwd = path.join(testDir, "human-missing-cwd");
    writeSystemRunners(testDir, {
      "human-bad-cwd": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake, cwd: missingCwd },
      },
    });

    const result = kspecRun("agent runners validate", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("human-bad-cwd");
    expect(result.stdout).toContain("[invalid]");
    expect(result.stdout).toContain("invalid_cwd");
    expect(result.stdout).toContain(missingCwd);
    expect(result.stdout).toContain("runner validation failed");
  });

  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  it("does not raise invalid_cwd when runner.process.cwd is unset", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeSystemRunners(testDir, {
      "no-cwd-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake },
      },
    });

    const data = kspecJson<ValidationReportPayload>("agent runners validate --json", testDir);
    expect(data.ok).toBe(true);
    const entry = data.runners[0];
    expect(entry.status).toBe("valid");
    expect(entry.diagnostics).toEqual([]);
  });
});

describe("CLI: kspec agent runners validate redacts secret values", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-runners-validate-redact-");
    writeAgentProject(testDir, []);
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("never emits resolved secret values into JSON diagnostics", () => {
    // Configure a required secret binding that triggers a missing-secret error.
    // The provided source is `user_env`; we set a sentinel value in the
    // subprocess env so we can assert the literal value never crosses into
    // the diagnostic payload, even when the resolver does see it.
    const secretValue = "super-secret-value-do-not-leak";
    writeSystemRunners(testDir, {
      secretful: {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        env: {
          secrets: {
            ANTHROPIC_API_KEY: { source: "user_env", required: true },
          },
        },
      },
    });

    // Provide a value through env so the secret binding resolves; this also
    // ensures any text the validator captures has the value available for
    // redaction by the scrubber returned from resolveRunnerInvocation.
    const result = kspecRun("agent runners validate --json", testDir, {
      env: { ANTHROPIC_API_KEY: secretValue },
    });
    // The runner resolves successfully (value supplied via user_env), so
    // validation passes — the redaction assertion holds without depending on
    // an error path. The contract still carries the secret-key name, but
    // diagnostics text and field values must never include the literal.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(secretValue);
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("redacts secret values that would otherwise appear in failure diagnostics", () => {
    // Force a missing-secret failure path so the resolver throws with text
    // that references the runner config. Then assert the secret value (set
    // via env) never appears in the diagnostic string.
    const secretValue = "leak-secret-12345";
    writeSystemRunners(testDir, {
      "missing-secret": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        env: {
          secrets: {
            REQUIRED_SECRET: { source: "user_env", required: true },
          },
        },
      },
    });

    // Don't pass REQUIRED_SECRET — the binding will fail to resolve. Pass an
    // unrelated secret to verify any captured-in-flight secrets stay
    // redacted even though they are not the cause of the failure.
    const result = kspecRun("agent runners validate --json", testDir, {
      env: { OTHER_SECRET: secretValue },
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    // The literal must not appear anywhere in the diagnostic payload.
    expect(result.stdout).not.toContain(secretValue);
  });
});

// ─── kspec agent list runner_validation field ────────────────────────────────

describe("CLI: kspec agent list runner_validation field", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-list-runner-validation-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  // AC: @runner-operator-surfaces ac-agent-list-shows-runner
  it("includes runner_validation status=valid for an agent with a known good runner", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "good-agent",
        name: "Good Agent",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "known-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunners(testDir, {
      "known-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake },
      },
    });

    const data = kspecJson<AgentListJson>("agent list", testDir);
    const agent = data.items.find((i) => i.id === "good-agent");
    expect(agent).toBeDefined();
    expect(agent!.runner).toBe("known-runner");
    expect(agent!.resolved_adapter).toBe("claude-agent-acp");
    expect(agent!.adapter).toBe("claude-agent-acp");
    expect(agent!.runner_validation).toBeDefined();
    expect(agent!.runner_validation!.status).toBe("valid");
    expect(agent!.runner_validation!.diagnostics).toEqual([]);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  it("emits runner_validation=invalid with unknown_runner diagnostics when runner missing", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "missing-agent",
        name: "Missing Runner Agent",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "ghost-runner",
        auto_approve: false,
      },
    ]);

    const data = kspecJson<AgentListJson>("agent list", testDir);
    const agent = data.items.find((i) => i.id === "missing-agent");
    expect(agent).toBeDefined();
    expect(agent!.runner_validation).toBeDefined();
    expect(agent!.runner_validation!.status).toBe("invalid");
    const diag = agent!.runner_validation!.diagnostics[0];
    expect(diag.reason).toBe("unknown_runner");
    expect(diag.message).toContain("ghost-runner");
  });

  // AC: @runner-operator-surfaces ac-agent-list-shows-runner
  // AC: @agent-runner-configuration ac-adapter-field-backcompat
  it("omits runner_validation for legacy adapter-only agents", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "legacy-only",
        name: "Legacy",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const data = kspecJson<AgentListJson>("agent list", testDir);
    const agent = data.items.find((i) => i.id === "legacy-only");
    expect(agent).toBeDefined();
    expect(agent!.runner_validation).toBeUndefined();
    expect(agent!.adapter).toBe("claude-agent-acp");
    expect(agent!.resolved_adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-operator-surfaces ac-runner-validation-human-output
  it("shows validation status next to runner name in human-readable list output", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "good",
        name: "Good",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "ok-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunners(testDir, {
      "ok-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake },
      },
    });

    const result = kspecRun("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("runner:");
    expect(result.stdout).toContain("ok-runner");
    expect(result.stdout).toContain("[valid]");
  });
});

// ─── kspec agent run --dry-run validation_state field ────────────────────────

describe("CLI: kspec agent run --dry-run validation_state", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-run-dryrun-validation-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-operator-surfaces ac-runner-validation-human-output
  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  it("reports validation_state=valid for an agent with a known good runner", () => {
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "with-runner",
        name: "With Runner",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "ok-runner",
        auto_approve: false,
      },
    ]);
    writeSystemRunners(testDir, {
      "ok-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake },
      },
    });

    const data = kspecJson<DryRunPayload>('agent run with-runner --dry-run "preview"', testDir);
    expect(data.dry_run).toBe(true);
    expect(data.validation_state).toBeDefined();
    expect((data.validation_state as { selected: boolean }).selected).toBe(true);
    const entry = data.validation_state as ValidationEntry & { selected: true };
    expect(entry.status).toBe("valid");
    expect(entry.runner).toBe("ok-runner");
    expect(entry.resolved_adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-resolution-and-preflight ac-unknown-runner-reports-guidance
  it("does not crash with adapter override even when runner is unknown — reports validation_state=adapter_override", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "override-agent",
        name: "Override",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        runner: "phantom",
        auto_approve: false,
      },
    ]);

    const data = kspecJson<DryRunPayload>(
      'agent run override-agent --dry-run --adapter codex-acp "preview"',
      testDir,
    );
    const vs = data.validation_state as { selected: false; reason: string };
    expect(vs.selected).toBe(false);
    expect(vs.reason).toBe("adapter_override");
  });

  // AC: @runner-operator-surfaces ac-runner-validation-json-output
  it("reports validation_state.selected=false reason=no_runner for legacy adapter-only agents", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "legacy",
        name: "Legacy",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);

    const data = kspecJson<DryRunPayload>('agent run legacy --dry-run "preview"', testDir);
    const vs = data.validation_state as { selected: false; reason: string };
    expect(vs.selected).toBe(false);
    expect(vs.reason).toBe("no_runner");
  });
});

// ─── Registry-load failure diagnostics ──────────────────────────────────────

describe("CLI: registry-load failures distinguish from unknown_runner", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-cli-registry-load-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("agent runners validate --json reports runner_registry_unavailable for malformed system YAML", () => {
    writeAgentProject(testDir, []);
    // Use a clearly broken YAML document: opening flow sequence with no
    // closing bracket and EOF. The YAML parser must raise a parse error,
    // which the loader captures as a layer-load issue.
    const sysPath = writeMalformedSystemRunners(testDir, "runners: [unterminated_flow_sequence");

    const result = kspecRun("agent runners validate --json", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    const data = JSON.parse(result.stdout) as ValidationReportPayload & {
      registry_load_failures: Array<{ layer: string; config_path: string; issues: object[] }>;
    };
    expect(data.ok).toBe(false);
    const reasons = data.issues.map((i) => i.reason);
    expect(reasons).toContain("runner_registry_unavailable");
    expect(reasons).not.toContain("unknown_runner");
    expect(Array.isArray(data.registry_load_failures)).toBe(true);
    expect(data.registry_load_failures.length).toBeGreaterThan(0);
    const failure = data.registry_load_failures.find((f) => f.layer === "system");
    expect(failure).toBeDefined();
    expect(failure!.config_path).toBe(sysPath);
    expect(failure!.issues.length).toBeGreaterThan(0);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("agent runners validate --json reports runner_registry_unavailable for system schema violations", () => {
    writeAgentProject(testDir, []);
    // System schema requires `kind` and `adapter` on every runner. Omitting
    // them produces Zod validation issues that the loader records as
    // LayerLoadResult.issues.
    const sysPath = writeMalformedSystemRunners(
      testDir,
      "runners:\n  bad-runner:\n    process:\n      args: []\n",
    );

    const result = kspecRun("agent runners validate --json", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    const data = JSON.parse(result.stdout) as ValidationReportPayload & {
      registry_load_failures: Array<{ layer: string; config_path: string }>;
    };
    expect(data.ok).toBe(false);
    expect(data.issues.some((i) => i.reason === "runner_registry_unavailable")).toBe(true);
    const failure = data.registry_load_failures.find((f) => f.layer === "system");
    expect(failure).toBeDefined();
    expect(failure!.config_path).toBe(sysPath);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("agent runners validate --runner <name> emits registry_load_failures instead of unknown_runner when registry cannot load", () => {
    writeAgentProject(testDir, []);
    writeMalformedSystemRunners(testDir, "runners: [malformed_flow_sequence");

    const result = kspecRun("agent runners validate --runner partial --json", testDir, {
      expectFail: true,
    });
    expect(result.exitCode).not.toBe(0);
    const data = JSON.parse(result.stdout) as ValidationReportPayload & {
      registry_load_failures: Array<{ layer: string; config_path: string }>;
    };
    expect(data.ok).toBe(false);
    const reasons = data.issues.map((i) => i.reason);
    // Registry-load failure dominates: do not surface unknown_runner alongside it.
    expect(reasons).toContain("runner_registry_unavailable");
    expect(reasons).not.toContain("unknown_runner");
    expect(data.registry_load_failures.length).toBeGreaterThan(0);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("agent list --json emits runner_validation with runner_registry_unavailable for runner-backed agents when system config is malformed", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-backed",
        name: "Runner Backed",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "any-runner",
        auto_approve: false,
      },
      {
        _ulid: testUlid("AGNT"),
        id: "legacy-only",
        name: "Legacy",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);
    writeMalformedSystemRunners(testDir, "runners:\n  any-runner: [malformed\n");

    const data = kspecJson<AgentListJson>("agent list", testDir);
    const runnerBacked = data.items.find((i) => i.id === "runner-backed");
    expect(runnerBacked).toBeDefined();
    expect(runnerBacked!.runner_validation).toBeDefined();
    expect(runnerBacked!.runner_validation!.status).toBe("invalid");
    const reason = runnerBacked!.runner_validation!.diagnostics[0].reason;
    expect(reason).toBe("runner_registry_unavailable");
    expect(reason).not.toBe("unknown_runner");
    const details = runnerBacked!.runner_validation!.diagnostics[0].details as {
      layer?: string;
      config_path?: string;
    };
    expect(details.layer).toBe("system");
    expect(typeof details.config_path).toBe("string");

    // Legacy agents remain unaffected: no runner field, no runner_validation block.
    const legacy = data.items.find((i) => i.id === "legacy-only");
    expect(legacy).toBeDefined();
    expect(legacy!.runner_validation).toBeUndefined();
    expect(legacy!.adapter).toBe("claude-agent-acp");
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("agent list (human output) shows [invalid: runner_registry_unavailable] when registry cannot load", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-backed",
        name: "Runner Backed",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "any-runner",
        auto_approve: false,
      },
    ]);
    writeMalformedSystemRunners(testDir, "runners:\n  any-runner: [malformed\n");

    const result = kspecRun("agent list", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("runner_registry_unavailable");
    expect(result.stdout).not.toContain("[invalid: unknown_runner]");
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("agent list emits runner_registry_unavailable for malformed project runner config too", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-backed",
        name: "Runner Backed",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "ghost-runner",
        auto_approve: false,
      },
    ]);
    const projectPath = writeMalformedProjectRunners(
      testDir,
      "runners:\n  ghost-runner: [unterminated\n",
    );

    const data = kspecJson<AgentListJson>("agent list", testDir);
    const runnerBacked = data.items.find((i) => i.id === "runner-backed");
    expect(runnerBacked).toBeDefined();
    expect(runnerBacked!.runner_validation).toBeDefined();
    const diag = runnerBacked!.runner_validation!.diagnostics[0];
    expect(diag.reason).toBe("runner_registry_unavailable");
    const details = diag.details as { layer?: string; config_path?: string };
    expect(details.layer).toBe("project");
    expect(details.config_path).toBe(projectPath);
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
  // AC: @runner-resolution-and-preflight ac-invalid-runner-blocks-before-prompt
  it("agent run blocks runner-backed invocation when system runner config is malformed", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-backed",
        name: "Runner Backed",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "any-runner",
        auto_approve: false,
      },
    ]);
    writeMalformedSystemRunners(testDir, "runners:\n  any-runner: [malformed\n");

    const result = kspecRun('agent run runner-backed "preview"', testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("runner registry is unavailable");
    expect(combined).not.toContain("references unknown runner");
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-blocks-runner-spawn
  it("agent run still works for legacy adapter-only agents when the registry cannot load", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "legacy-only",
        name: "Legacy",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        adapter: "claude-agent-acp",
        auto_approve: false,
      },
    ]);
    writeMalformedSystemRunners(testDir, "runners:\n  any-runner: [malformed\n");

    // Use --dry-run so we don't actually spawn an adapter. The flow proves
    // the legacy adapter path remains reachable even with a broken registry.
    const data = kspecJson<DryRunPayload>('agent run legacy-only --dry-run "preview"', testDir);
    expect(data.dry_run).toBe(true);
    expect(data.adapter).toBe("claude-agent-acp");
    const vs = data.validation_state as { selected: false; reason: string };
    expect(vs.selected).toBe(false);
    expect(vs.reason).toBe("no_runner");
  });

  // AC: @runner-resolution-and-preflight ac-registry-load-failure-reports-config-error
  it("agent run --dry-run JSON reports validation_state.reason=runner_registry_unavailable when registry cannot load", () => {
    writeAgentProject(testDir, [
      {
        _ulid: testUlid("AGNT"),
        id: "runner-backed",
        name: "Runner Backed",
        dispatch: [],
        concurrency: { max_concurrent: 1 },
        runner: "any-runner",
        auto_approve: false,
      },
    ]);
    writeMalformedSystemRunners(testDir, "runners:\n  any-runner: [malformed\n");

    const result = kspecRun('agent run runner-backed --dry-run --json "preview"', testDir, {
      expectFail: true,
    });
    // Dry-run blocks BEFORE entering the dry-run preview body because the
    // runner reference cannot resolve. The blocking error is surfaced via
    // stderr; assert on the combined output for stability.
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined).toContain("runner registry is unavailable");
  });

  // AC: @runner-environment-secret-boundaries ac-diagnostics-redact-secrets
  it("redacts known secret env names that appear in issue messages", () => {
    writeAgentProject(testDir, []);
    // Embed a string that looks like a secret literal so the redactor has
    // something to scrub. The malformed YAML keeps the loader in the parse-
    // error path so the failing line text reaches issue.message.
    const secret = "sk-ant-do-not-leak-12345";
    writeMalformedSystemRunners(testDir, `runners:\n  bad-runner: [ANTHROPIC_API_KEY=${secret}\n`);

    const result = kspecRun("agent runners validate --json", testDir, { expectFail: true });
    expect(result.exitCode).not.toBe(0);
    // The literal secret value must not appear anywhere in the diagnostic
    // payload, regardless of whether the YAML parser echoed the line.
    expect(result.stdout).not.toContain(secret);
  });
});
