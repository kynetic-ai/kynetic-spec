/**
 * Session create command and library function tests.
 *
 * Tests for session creation, budget setup, environment injection,
 * and invalid session validation.
 *
 * Task: @implement-session-create-command
 * Spec: @session-creation-and-env-injection
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  createSessionWithBudget,
  validateSessionId,
  injectClaudeCodeEnv,
  injectCodexEnv,
  getFallbackInjectionInstructions,
  getSession,
  getBudget,
  getSessionBudgetPath,
  createSession,
} from "../src/sessions/store.js";
import type { SessionMetadataInput } from "../src/sessions/types.js";
import {
  kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
  createTempDir,
  testUlid,
} from "./helpers/cli.js";

// ─── Library Function: createSessionWithBudget ──────────────────────────────

describe("createSessionWithBudget", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-session-create-");
    // Create sessions directory
    await fs.mkdir(path.join(testDir, "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @session-creation-and-env-injection ac-create
  it("should create a session with status active and return metadata", async () => {
    const sessionId = testUlid("SESS", 1);
    const result = await createSessionWithBudget(testDir, {
      id: sessionId,
      agent_type: "claude-code",
    });

    expect(result.session_id).toBe(sessionId);
    expect(result.session.id).toBe(sessionId);
    expect(result.session.status).toBe("active");
    expect(result.session.agent_type).toBe("claude-code");
    expect(result.session.started_at).toBeTruthy();
    expect(result.budget).toBeNull();
  });

  // AC: @session-creation-and-env-injection ac-create
  it("should create session directory with session.yaml", async () => {
    const sessionId = testUlid("SESS", 2);
    await createSessionWithBudget(testDir, {
      id: sessionId,
      agent_type: "codex-cli",
    });

    const sessionDir = path.join(testDir, "sessions", sessionId);
    const stat = await fs.stat(sessionDir);
    expect(stat.isDirectory()).toBe(true);

    const metadataPath = path.join(sessionDir, "session.yaml");
    const content = await fs.readFile(metadataPath, "utf-8");
    expect(content).toContain("status: active");
    expect(content).toContain("agent_type: codex-cli");
  });

  // AC: @session-creation-and-env-injection ac-budget
  it("should create budget.json when budget option provided", async () => {
    const sessionId = testUlid("SESS", 3);
    const result = await createSessionWithBudget(testDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 5,
    });

    expect(result.budget).not.toBeNull();
    expect(result.budget!.max_per_cycle).toBe(5);
    expect(result.budget!.started_this_cycle).toBe(0);
  });

  // AC: @session-creation-and-env-injection ac-budget-local
  it("should store budget.json on local filesystem in session directory", async () => {
    const sessionId = testUlid("SESS", 4);
    await createSessionWithBudget(testDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 3,
    });

    const budgetPath = getSessionBudgetPath(testDir, sessionId);
    const content = await fs.readFile(budgetPath, "utf-8");
    const budget = JSON.parse(content);
    expect(budget.max_per_cycle).toBe(3);
    expect(budget.started_this_cycle).toBe(0);
    // Verify it's in the expected location
    expect(budgetPath).toContain(path.join("sessions", sessionId, "budget.json"));
  });

  // AC: @session-creation-and-env-injection ac-library
  it("should return metadata without console output", async () => {
    const sessionId = testUlid("SESS", 5);
    // Capture console output
    const consoleLogs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => consoleLogs.push(args.join(" "));

    try {
      const result = await createSessionWithBudget(testDir, {
        id: sessionId,
        agent_type: "claude-code",
        budget: 2,
      });

      // Library function should not produce console output
      expect(consoleLogs).toHaveLength(0);

      // Should return complete metadata
      expect(result.session_id).toBe(sessionId);
      expect(result.session.id).toBe(sessionId);
      expect(result.session.status).toBe("active");
      expect(result.budget).not.toBeNull();
      expect(result.budget!.max_per_cycle).toBe(2);
    } finally {
      console.log = originalLog;
    }
  });

  it("should include task_id when provided", async () => {
    const sessionId = testUlid("SESS", 6);
    const taskId = testUlid("TASK", 1);
    const result = await createSessionWithBudget(testDir, {
      id: sessionId,
      agent_type: "claude-code",
      task_id: taskId,
    });

    expect(result.session.task_id).toBe(taskId);
  });

  it("should not create budget when budget is undefined", async () => {
    const sessionId = testUlid("SESS", 7);
    const result = await createSessionWithBudget(testDir, {
      id: sessionId,
      agent_type: "claude-code",
    });

    expect(result.budget).toBeNull();

    // Verify no budget file exists
    const budgetPath = getSessionBudgetPath(testDir, sessionId);
    await expect(fs.access(budgetPath)).rejects.toThrow();
  });
});

// ─── Session Validation ──────────────────────────────────────────────────────

describe("validateSessionId", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-session-validate-");
    await fs.mkdir(path.join(testDir, "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @session-creation-and-env-injection ac-invalid-session
  it("should return valid for existing session with correct metadata", async () => {
    const sessionId = testUlid("VALID", 1);
    await createSession(testDir, {
      id: sessionId,
      agent_type: "claude-code",
    });

    const result = await validateSessionId(testDir, sessionId);
    expect(result.valid).toBe(true);
    expect(result.session).toBeDefined();
    expect(result.session!.id).toBe(sessionId);
  });

  // AC: @session-creation-and-env-injection ac-invalid-session
  it("should return error for nonexistent session with clear message", async () => {
    const result = await validateSessionId(testDir, "NONEXISTENT_SESSION");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Session not found");
    expect(result.error).toContain("NONEXISTENT_SESSION");
    expect(result.suggestion).toContain("kspec session create");
  });

  // AC: @session-creation-and-env-injection ac-invalid-session
  it("should return error for corrupt session metadata", async () => {
    const sessionId = testUlid("CRPT", 1);
    const sessionDir = path.join(testDir, "sessions", sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    // Write invalid YAML
    await fs.writeFile(
      path.join(sessionDir, "session.yaml"),
      "this is not valid yaml: [[[",
      "utf-8",
    );

    const result = await validateSessionId(testDir, sessionId);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("corrupt");
    expect(result.suggestion).toContain("kspec session create");
  });
});

// ─── Environment Injection ───────────────────────────────────────────────────

describe("Environment Injection", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-env-inject-");
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  describe("injectClaudeCodeEnv", () => {
    // AC: @session-creation-and-env-injection ac-inject-claude
    it("should write to CLAUDE_ENV_FILE when set", async () => {
      const envFile = path.join(testDir, "claude-env");
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        const sessionId = testUlid("CLDE", 1);
        const result = await injectClaudeCodeEnv(sessionId);

        expect(result.injected).toBe(true);
        expect(result.method).toBe("claude_env_file");
        expect(result.path).toBe(envFile);

        const content = await fs.readFile(envFile, "utf-8");
        expect(content).toContain(`KSPEC_SESSION_ID=${sessionId}`);
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        } else {
          delete process.env.CLAUDE_ENV_FILE;
        }
      }
    });

    // AC: @session-creation-and-env-injection ac-inject-claude
    it("should replace existing KSPEC_SESSION_ID in CLAUDE_ENV_FILE", async () => {
      const envFile = path.join(testDir, "claude-env");
      await fs.writeFile(
        envFile,
        "OTHER_VAR=foo\nKSPEC_SESSION_ID=old-session\nANOTHER=bar\n",
        "utf-8",
      );

      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        const sessionId = testUlid("CLDE", 2);
        await injectClaudeCodeEnv(sessionId);

        const content = await fs.readFile(envFile, "utf-8");
        expect(content).toContain(`KSPEC_SESSION_ID=${sessionId}`);
        expect(content).not.toContain("old-session");
        expect(content).toContain("OTHER_VAR=foo");
        expect(content).toContain("ANOTHER=bar");
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        } else {
          delete process.env.CLAUDE_ENV_FILE;
        }
      }
    });

    // AC: @session-creation-and-env-injection ac-inject-claude
    it("should write to .claude/settings.json when CLAUDE_ENV_FILE not set", async () => {
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      const originalCwd = process.cwd();
      delete process.env.CLAUDE_ENV_FILE;

      try {
        process.chdir(testDir);
        const sessionId = testUlid("CLDE", 3);
        const result = await injectClaudeCodeEnv(sessionId);

        expect(result.injected).toBe(true);
        expect(result.method).toBe("claude_settings");

        const settingsPath = path.join(testDir, ".claude", "settings.json");
        const content = await fs.readFile(settingsPath, "utf-8");
        const settings = JSON.parse(content);
        expect(settings.env.KSPEC_SESSION_ID).toBe(sessionId);
      } finally {
        process.chdir(originalCwd);
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        }
      }
    });
  });

  describe("injectCodexEnv", () => {
    // AC: @session-creation-and-env-injection ac-inject-codex
    it("should add KSPEC_SESSION_ID to codex config", async () => {
      const configDir = path.join(testDir, ".codex");
      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        const sessionId = testUlid("CDEX", 1);
        const result = await injectCodexEnv(sessionId);

        expect(result.injected).toBe(true);
        expect(result.method).toBe("codex_config");

        const configPath = path.join(configDir, "config.json");
        const content = await fs.readFile(configPath, "utf-8");
        const config = JSON.parse(content);
        expect(config.shell_environment_policy.set.KSPEC_SESSION_ID).toBe(
          sessionId,
        );
      } finally {
        process.env.HOME = originalHome;
      }
    });

    // AC: @session-creation-and-env-injection ac-inject-codex
    it("should preserve existing codex config values", async () => {
      const configDir = path.join(testDir, ".codex");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({
          model: "gpt-5",
          shell_environment_policy: {
            set: { EXISTING_VAR: "keep" },
            inherit: ["PATH"],
          },
        }),
        "utf-8",
      );

      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        const sessionId = testUlid("CDEX", 2);
        await injectCodexEnv(sessionId);

        const content = await fs.readFile(
          path.join(configDir, "config.json"),
          "utf-8",
        );
        const config = JSON.parse(content);
        expect(config.model).toBe("gpt-5");
        expect(config.shell_environment_policy.set.EXISTING_VAR).toBe("keep");
        expect(config.shell_environment_policy.set.KSPEC_SESSION_ID).toBe(
          sessionId,
        );
        expect(config.shell_environment_policy.inherit).toEqual(["PATH"]);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("getFallbackInjectionInstructions", () => {
    // AC: @session-creation-and-env-injection ac-inject-fallback
    it("should return export command for manual sourcing", () => {
      const sessionId = testUlid("FLLB", 1);
      const result = getFallbackInjectionInstructions(sessionId);

      expect(result.injected).toBe(false);
      expect(result.method).toBe("fallback");
      expect(result.description).toBe(
        `export KSPEC_SESSION_ID=${sessionId}`,
      );
    });
  });
});

// ─── CLI Command: session create ─────────────────────────────────────────────

describe("session create CLI", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @session-creation-and-env-injection ac-create
  // AC: @trait-semantic-exit-codes ac-1
  it("should create a session and print ID to stdout", () => {
    const result = kspec("session create --agent-type test-agent", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Created session:");
  });

  // AC: @session-creation-and-env-injection ac-budget
  it("should create budget when --budget flag provided", () => {
    const result = kspec(
      "session create --agent-type test-agent --budget 5",
      testDir,
    );
    expect(result.exitCode).toBe(0);
    // info() routes to stdout in text mode
    const allOutput = result.stdout + "\n" + result.stderr;
    expect(allOutput).toContain("Budget: 5 tasks per cycle");
  });

  // AC: @trait-json-output ac-1 - output is valid JSON with no ANSI
  it("should output valid JSON when --json flag provided", () => {
    const result = kspecJson<Record<string, unknown>>(
      "session create --agent-type test-agent --budget 3",
      testDir,
    );
    expect(result.session_id).toBeTruthy();
    expect(typeof result.session_id).toBe("string");
    expect(result.agent_type).toBe("test-agent");
    expect(result.status).toBe("active");
    expect(result.budget).toBeDefined();
    const budget = result.budget as { max_per_cycle: number; started_this_cycle: number };
    expect(budget.max_per_cycle).toBe(3);
    expect(budget.started_this_cycle).toBe(0);
  });

  // AC: @trait-json-output ac-2 - all data available in JSON
  it("should include all fields in JSON output", () => {
    const result = kspecJson<Record<string, unknown>>(
      "session create --agent-type claude-code",
      testDir,
    );
    expect(result.session_id).toBeTruthy();
    expect(result.agent_type).toBe("claude-code");
    expect(result.status).toBe("active");
    expect(result.started_at).toBeTruthy();
  });

  // AC: @trait-json-output ac-5 - timestamps use ISO 8601
  it("should use ISO 8601 timestamps in JSON output", () => {
    const result = kspecJson<Record<string, unknown>>(
      "session create --agent-type test",
      testDir,
    );
    const startedAt = result.started_at as string;
    // ISO 8601 pattern
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // AC: @trait-semantic-exit-codes ac-2 - validation error exit 1
  it("should exit with error for invalid budget value", () => {
    const result = kspec(
      "session create --agent-type test --budget abc",
      testDir,
      { expectFail: true },
    );
    // USAGE_ERROR = 2
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid budget value");
  });

  // AC: @trait-semantic-exit-codes ac-6 - invalid flags exit 1 with usage
  it("should show usage info for invalid budget", () => {
    const result = kspec(
      "session create --agent-type test --budget 0",
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("positive integer");
  });

  // AC: @trait-error-guidance ac-5 - indicate field/value that failed
  it("should indicate the invalid field in error message", () => {
    const result = kspec(
      "session create --agent-type test --budget -5",
      testDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("-5");
    expect(result.stderr).toContain("budget");
  });

  // AC: @session-creation-and-env-injection ac-inject-fallback
  it("should print export command when --inject with no known harness", () => {
    // Run without any agent env vars set
    const result = kspec(
      "session create --agent-type unknown --inject",
      testDir,
      {
        env: {
          // Clear any agent-detection env vars
          CLAUDECODE: "",
          CLAUDE_CODE_ENTRYPOINT: "",
          CLAUDE_PROJECT_DIR: "",
          CODEX_SANDBOX: "",
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KSPEC_SESSION_ID=");
  });

  // AC: @trait-json-output ac-3 - error as JSON object
  it("should return error as JSON when --json is active and validation fails", () => {
    const result = kspec(
      "session create --agent-type test --budget abc --json",
      testDir,
      { expectFail: true },
    );
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error).toContain("Invalid budget value");
  });

  // AC: @trait-json-output ac-6 - --json takes precedence
  it("should output JSON even when other formatting might apply", () => {
    const result = kspec(
      "session create --agent-type test --json",
      testDir,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.session_id).toBeTruthy();
  });

  // Default agent-type test
  it("should default agent-type to claude-code", () => {
    const result = kspecJson<Record<string, unknown>>(
      "session create",
      testDir,
    );
    expect(result.agent_type).toBe("claude-code");
  });

  // AC: @trait-semantic-exit-codes ac-8 - exit codes documented
  // This is a structural test — verifying the code has proper comments
  it("should have exit code documentation in action handler", async () => {
    const content = await fs.readFile(
      path.join(__dirname, "..", "src", "cli", "commands", "session.ts"),
      "utf-8",
    );
    // Verify exit code documentation comment exists
    expect(content).toContain("Exit codes documented per @trait-semantic-exit-codes ac-8");
  });
});
