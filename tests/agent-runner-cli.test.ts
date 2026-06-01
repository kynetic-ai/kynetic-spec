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

  // AC: @runner-process-invocation-inputs ac-relative-system-cwd-resolves-from-config-dir
  // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
  it("resolves a relative process.cwd against the system runners.yaml directory before probing", () => {
    // Place a real directory next to the system runners.yaml file. The
    // relative cwd entry points at the same name. The validator must resolve
    // it against the system config dir and pass the probe.
    const projectKey = deriveProjectKeySync(testDir);
    const sysDir = path.join(testDir, ".test-home", ".config", "kspec", "projects", projectKey);
    fsSync.mkdirSync(sysDir, { recursive: true });
    fsSync.mkdirSync(path.join(sysDir, "agents-cwd"), { recursive: true });
    const fake = makeFakeExecutable(testDir, "fake-bin");
    writeSystemRunners(testDir, {
      "relative-cwd-runner": {
        kind: "acp_process",
        adapter: "claude-agent-acp",
        process: { executable: fake, cwd: "agents-cwd" },
      },
    });

    const data = kspecJson<ValidationReportPayload>("agent runners validate --json", testDir);
    expect(data.ok).toBe(true);
    const entry = data.runners[0];
    expect(entry.status).toBe("valid");
    expect(entry.cwd_source).toBe("runner.system");
    // No raw relative cwd should ever surface in diagnostics or details on
    // the validated path — but the resolved cwd is what later spawn calls
    // will receive. We confirm by removing the resolved directory and
    // re-running to observe a `not_found` diagnostic naming the resolved path
    // (not the raw "agents-cwd" string).
    fsSync.rmdirSync(path.join(sysDir, "agents-cwd"));
    const fail = kspecRun("agent runners validate --json", testDir, { expectFail: true });
    expect(fail.exitCode).not.toBe(0);
    const failed = JSON.parse(fail.stdout) as ValidationReportPayload;
    const diag = failed.runners[0].diagnostics.find((d) => d.reason === "invalid_cwd");
    expect(diag).toBeDefined();
    expect(diag!.message).toContain(path.join(sysDir, "agents-cwd"));
    expect(diag!.details!.cwd).toBe(path.join(sysDir, "agents-cwd"));
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
