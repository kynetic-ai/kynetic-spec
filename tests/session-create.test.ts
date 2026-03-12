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
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import {
  createSessionWithBudget,
  validateSessionId,
  injectClaudeCodeEnv,
  removeClaudeCodeEnv,
  injectCodexEnv,
  removeCodexEnv,
  injectGeminiEnv,
  injectOpenCodeEnv,
  getFallbackInjectionInstructions,
  injectEnvForAdapter,
  removeEnvForAdapter,
  getSession,
  getBudget,
  getSessionBudgetPath,
  createSession,
} from "../src/sessions/store.js";
import type { SessionMetadataInput } from "../src/sessions/types.js";
import { resolveAdapter } from "../src/agents/adapters.js";
import { EXIT_CODES } from "../src/cli/exit-codes.js";
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
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-session-create-");
    sessionsDir = path.join(testDir, "sessions");
    // Create sessions directory
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @session-creation-and-env-injection ac-create
  it("should create a session with status active and return metadata", async () => {
    const sessionId = testUlid("SESS", 1);
    const result = await createSessionWithBudget(sessionsDir, {
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
    await createSessionWithBudget(sessionsDir, {
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
    const result = await createSessionWithBudget(sessionsDir, {
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
    await createSessionWithBudget(sessionsDir, {
      id: sessionId,
      agent_type: "claude-code",
      budget: 3,
    });

    const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
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
      const result = await createSessionWithBudget(sessionsDir, {
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
    const result = await createSessionWithBudget(sessionsDir, {
      id: sessionId,
      agent_type: "claude-code",
      task_id: taskId,
    });

    expect(result.session.task_id).toBe(taskId);
  });

  it("should not create budget when budget is undefined", async () => {
    const sessionId = testUlid("SESS", 7);
    const result = await createSessionWithBudget(sessionsDir, {
      id: sessionId,
      agent_type: "claude-code",
    });

    expect(result.budget).toBeNull();

    // Verify no budget file exists
    const budgetPath = getSessionBudgetPath(sessionsDir, sessionId);
    await expect(fs.access(budgetPath)).rejects.toThrow();
  });
});

// ─── Session Validation ──────────────────────────────────────────────────────

describe("validateSessionId", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await createTempDir("kspec-session-validate-");
    sessionsDir = path.join(testDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
  });

  // AC: @session-creation-and-env-injection ac-invalid-session
  it("should return valid for existing session with correct metadata", async () => {
    const sessionId = testUlid("VALID", 1);
    await createSession(sessionsDir, {
      id: sessionId,
      agent_type: "claude-code",
    });

    const result = await validateSessionId(sessionsDir, sessionId);
    expect(result.valid).toBe(true);
    expect(result.session).toBeDefined();
    expect(result.session!.id).toBe(sessionId);
  });

  // AC: @session-creation-and-env-injection ac-invalid-session
  it("should return error for nonexistent session with clear message", async () => {
    const result = await validateSessionId(sessionsDir, "NONEXISTENT_SESSION");
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

    const result = await validateSessionId(sessionsDir, sessionId);
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

    it("should capture previous value from CLAUDE_ENV_FILE", async () => {
      const envFile = path.join(testDir, "claude-env-prev");
      await fs.writeFile(envFile, "KSPEC_SESSION_ID=old-value\n", "utf-8");

      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        const sessionId = testUlid("CLDE", 4);
        const result = await injectClaudeCodeEnv(sessionId);

        expect(result.previousValue).toBe("old-value");
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        } else {
          delete process.env.CLAUDE_ENV_FILE;
        }
      }
    });

    it("should return null previousValue when no prior value exists", async () => {
      const envFile = path.join(testDir, "claude-env-noprev");

      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        const sessionId = testUlid("CLDE", 5);
        const result = await injectClaudeCodeEnv(sessionId);

        expect(result.previousValue).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        } else {
          delete process.env.CLAUDE_ENV_FILE;
        }
      }
    });

    // AC: @session-creation-and-env-injection ac-inject-claude
    it("should write to .claude/settings.local.json when CLAUDE_ENV_FILE not set", async () => {
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      const originalCwd = process.cwd();
      delete process.env.CLAUDE_ENV_FILE;

      try {
        process.chdir(testDir);
        const sessionId = testUlid("CLDE", 3);
        const result = await injectClaudeCodeEnv(sessionId);

        expect(result.injected).toBe(true);
        expect(result.method).toBe("claude_settings");

        const settingsPath = path.join(testDir, ".claude", "settings.local.json");
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

        const configPath = path.join(configDir, "config.toml");
        const content = await fs.readFile(configPath, "utf-8");
        const config = parseTOML(content) as Record<string, unknown>;
        const policy = config.shell_environment_policy as Record<string, Record<string, string>>;
        expect(policy.set.KSPEC_SESSION_ID).toBe(sessionId);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    // AC: @session-creation-and-env-injection ac-inject-codex
    it("should preserve existing codex config values", async () => {
      const configDir = path.join(testDir, ".codex");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.toml"),
        stringifyTOML({
          model: "gpt-5",
          shell_environment_policy: {
            set: { EXISTING_VAR: "keep" },
            inherit: "all",
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
          path.join(configDir, "config.toml"),
          "utf-8",
        );
        const config = parseTOML(content) as Record<string, unknown>;
        expect(config.model).toBe("gpt-5");
        const policy = config.shell_environment_policy as Record<string, unknown>;
        expect((policy.set as Record<string, string>).EXISTING_VAR).toBe("keep");
        expect((policy.set as Record<string, string>).KSPEC_SESSION_ID).toBe(
          sessionId,
        );
        expect(policy.inherit).toBe("all");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    // AC: @session-creation-and-env-injection ac-inject-codex
    it("should preserve complex TOML structures during inject/remove round-trip", async () => {
      const configDir = path.join(testDir, ".codex");
      await fs.mkdir(configDir, { recursive: true });

      // Pre-seed with a realistic codex config.toml containing various TOML types
      const originalConfig = {
        model: "gpt-5.3-codex",
        approval_policy: "never",
        sandbox_mode: "danger-full-access",
        shell_environment_policy: {
          inherit: "all",
          set: { MY_VAR: "keep-this", ANOTHER_VAR: "also-keep" },
        },
      };
      await fs.writeFile(
        path.join(configDir, "config.toml"),
        stringifyTOML(originalConfig),
        "utf-8",
      );

      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        const sessionId = testUlid("CDEX", 3);

        // Inject
        const result = await injectCodexEnv(sessionId);
        expect(result.previousValue).toBeNull();

        // Verify injection didn't clobber other values
        let content = parseTOML(
          await fs.readFile(path.join(configDir, "config.toml"), "utf-8"),
        ) as Record<string, unknown>;
        expect(content.model).toBe("gpt-5.3-codex");
        expect(content.approval_policy).toBe("never");
        expect(content.sandbox_mode).toBe("danger-full-access");
        const policy = content.shell_environment_policy as Record<string, unknown>;
        expect(policy.inherit).toBe("all");
        expect((policy.set as Record<string, string>).MY_VAR).toBe("keep-this");
        expect((policy.set as Record<string, string>).ANOTHER_VAR).toBe("also-keep");
        expect((policy.set as Record<string, string>).KSPEC_SESSION_ID).toBe(sessionId);

        // Remove — should delete KSPEC_SESSION_ID but preserve everything else
        await removeCodexEnv();
        content = parseTOML(
          await fs.readFile(path.join(configDir, "config.toml"), "utf-8"),
        ) as Record<string, unknown>;
        expect(content.model).toBe("gpt-5.3-codex");
        expect(content.approval_policy).toBe("never");
        const policyAfter = content.shell_environment_policy as Record<string, unknown>;
        expect(policyAfter.inherit).toBe("all");
        expect((policyAfter.set as Record<string, string>).MY_VAR).toBe("keep-this");
        expect((policyAfter.set as Record<string, string>).KSPEC_SESSION_ID).toBeUndefined();
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("config file safety", () => {
    it("should throw on corrupt .claude/settings.local.json instead of overwriting", async () => {
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      const originalCwd = process.cwd();
      delete process.env.CLAUDE_ENV_FILE;

      try {
        process.chdir(testDir);
        const settingsDir = path.join(testDir, ".claude");
        await fs.mkdir(settingsDir, { recursive: true });
        await fs.writeFile(
          path.join(settingsDir, "settings.local.json"),
          "this is not valid json {{{",
          "utf-8",
        );

        const sessionId = testUlid("CRPT", 1);
        await expect(injectClaudeCodeEnv(sessionId)).rejects.toThrow(
          "not valid JSON",
        );
      } finally {
        process.chdir(originalCwd);
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        }
      }
    });

    it("should throw on corrupt codex config.toml instead of overwriting", async () => {
      const configDir = path.join(testDir, ".codex");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.toml"),
        "not valid toml [[[",
        "utf-8",
      );

      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        const sessionId = testUlid("CRPT", 2);
        await expect(injectCodexEnv(sessionId)).rejects.toThrow(
          "not valid TOML",
        );
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("injectGeminiEnv", () => {
    // Spec: @session-creation-and-env-injection (harness-specific injection for Gemini CLI)
    it("should write KSPEC_SESSION_ID to .gemini/.env", async () => {
      const originalCwd = process.cwd();

      try {
        process.chdir(testDir);
        const sessionId = testUlid("GEMI", 1);
        const result = await injectGeminiEnv(sessionId);

        expect(result.injected).toBe(true);
        expect(result.method).toBe("gemini_dotenv");

        const dotenvPath = path.join(testDir, ".gemini", ".env");
        const content = await fs.readFile(dotenvPath, "utf-8");
        expect(content).toContain(`KSPEC_SESSION_ID=${sessionId}`);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("should replace existing KSPEC_SESSION_ID in .gemini/.env", async () => {
      const originalCwd = process.cwd();

      try {
        process.chdir(testDir);
        const dotenvDir = path.join(testDir, ".gemini");
        await fs.mkdir(dotenvDir, { recursive: true });
        await fs.writeFile(
          path.join(dotenvDir, ".env"),
          "GEMINI_API_KEY=abc123\nKSPEC_SESSION_ID=old-session\nGEMINI_MODEL=gemini-pro\n",
          "utf-8",
        );

        const sessionId = testUlid("GEMI", 2);
        await injectGeminiEnv(sessionId);

        const content = await fs.readFile(
          path.join(dotenvDir, ".env"),
          "utf-8",
        );
        expect(content).toContain(`KSPEC_SESSION_ID=${sessionId}`);
        expect(content).not.toContain("old-session");
        expect(content).toContain("GEMINI_API_KEY=abc123");
        expect(content).toContain("GEMINI_MODEL=gemini-pro");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("should create .gemini directory if it doesn't exist", async () => {
      const originalCwd = process.cwd();

      try {
        process.chdir(testDir);
        const sessionId = testUlid("GEMI", 3);
        await injectGeminiEnv(sessionId);

        const dotenvDir = path.join(testDir, ".gemini");
        const stat = await fs.stat(dotenvDir);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("injectOpenCodeEnv", () => {
    // Spec: @session-creation-and-env-injection (harness-specific injection for OpenCode)
    it("should write KSPEC_SESSION_ID to project .env file", async () => {
      const originalCwd = process.cwd();

      try {
        process.chdir(testDir);
        const sessionId = testUlid("OPEN", 1);
        const result = await injectOpenCodeEnv(sessionId);

        expect(result.injected).toBe(true);
        expect(result.method).toBe("opencode_dotenv");

        const dotenvPath = path.join(testDir, ".env");
        const content = await fs.readFile(dotenvPath, "utf-8");
        expect(content).toContain(`KSPEC_SESSION_ID=${sessionId}`);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("should replace existing KSPEC_SESSION_ID in .env", async () => {
      const originalCwd = process.cwd();

      try {
        process.chdir(testDir);
        await fs.writeFile(
          path.join(testDir, ".env"),
          "API_KEY=secret\nKSPEC_SESSION_ID=old-session\nDEBUG=true\n",
          "utf-8",
        );

        const sessionId = testUlid("OPEN", 2);
        await injectOpenCodeEnv(sessionId);

        const content = await fs.readFile(
          path.join(testDir, ".env"),
          "utf-8",
        );
        expect(content).toContain(`KSPEC_SESSION_ID=${sessionId}`);
        expect(content).not.toContain("old-session");
        expect(content).toContain("API_KEY=secret");
        expect(content).toContain("DEBUG=true");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("should create .env file if it doesn't exist", async () => {
      const originalCwd = process.cwd();

      try {
        process.chdir(testDir);
        const sessionId = testUlid("OPEN", 3);
        await injectOpenCodeEnv(sessionId);

        const dotenvPath = path.join(testDir, ".env");
        const stat = await fs.stat(dotenvPath);
        expect(stat.isFile()).toBe(true);
      } finally {
        process.chdir(originalCwd);
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

  describe("removeClaudeCodeEnv", () => {
    it("should remove KSPEC_SESSION_ID from CLAUDE_ENV_FILE", async () => {
      const envFile = path.join(testDir, "claude-env-remove");
      await fs.writeFile(
        envFile,
        "OTHER_VAR=foo\nKSPEC_SESSION_ID=some-session\nANOTHER=bar\n",
        "utf-8",
      );

      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        await removeClaudeCodeEnv();

        const content = await fs.readFile(envFile, "utf-8");
        expect(content).not.toContain("KSPEC_SESSION_ID");
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

    it("should remove KSPEC_SESSION_ID from .claude/settings.local.json", async () => {
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      const originalCwd = process.cwd();
      delete process.env.CLAUDE_ENV_FILE;

      try {
        process.chdir(testDir);
        const settingsDir = path.join(testDir, ".claude");
        await fs.mkdir(settingsDir, { recursive: true });
        await fs.writeFile(
          path.join(settingsDir, "settings.local.json"),
          JSON.stringify({
            hooks: {},
            env: { KSPEC_SESSION_ID: "old-session", OTHER: "keep" },
          }),
          "utf-8",
        );

        await removeClaudeCodeEnv();

        const content = await fs.readFile(
          path.join(settingsDir, "settings.local.json"),
          "utf-8",
        );
        const settings = JSON.parse(content);
        expect(settings.env.KSPEC_SESSION_ID).toBeUndefined();
        expect(settings.env.OTHER).toBe("keep");
        expect(settings.hooks).toBeDefined();
      } finally {
        process.chdir(originalCwd);
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        }
      }
    });

    it("should remove env section entirely when it becomes empty", async () => {
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      const originalCwd = process.cwd();
      delete process.env.CLAUDE_ENV_FILE;

      try {
        process.chdir(testDir);
        const settingsDir = path.join(testDir, ".claude");
        await fs.mkdir(settingsDir, { recursive: true });
        await fs.writeFile(
          path.join(settingsDir, "settings.local.json"),
          JSON.stringify({
            hooks: {},
            env: { KSPEC_SESSION_ID: "only-key" },
          }),
          "utf-8",
        );

        await removeClaudeCodeEnv();

        const content = await fs.readFile(
          path.join(settingsDir, "settings.local.json"),
          "utf-8",
        );
        const settings = JSON.parse(content);
        expect(settings.env).toBeUndefined();
        expect(settings.hooks).toBeDefined();
      } finally {
        process.chdir(originalCwd);
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        }
      }
    });

    it("should silently handle missing settings file", async () => {
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      const originalCwd = process.cwd();
      delete process.env.CLAUDE_ENV_FILE;

      try {
        process.chdir(testDir);
        // No settings.local.json exists — should not throw
        await expect(removeClaudeCodeEnv()).resolves.toBeUndefined();
      } finally {
        process.chdir(originalCwd);
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        }
      }
    });

    it("should restore previous value in CLAUDE_ENV_FILE when provided", async () => {
      const envFile = path.join(testDir, "claude-env-restore");
      await fs.writeFile(
        envFile,
        "OTHER_VAR=foo\nKSPEC_SESSION_ID=ralph-session\n",
        "utf-8",
      );

      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        await removeClaudeCodeEnv("previous-user-session");

        const content = await fs.readFile(envFile, "utf-8");
        expect(content).toContain("KSPEC_SESSION_ID=previous-user-session");
        expect(content).not.toContain("ralph-session");
        expect(content).toContain("OTHER_VAR=foo");
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        } else {
          delete process.env.CLAUDE_ENV_FILE;
        }
      }
    });

    it("should restore previous value in settings.local.json when provided", async () => {
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      const originalCwd = process.cwd();
      delete process.env.CLAUDE_ENV_FILE;

      try {
        process.chdir(testDir);
        const settingsDir = path.join(testDir, ".claude");
        await fs.mkdir(settingsDir, { recursive: true });
        await fs.writeFile(
          path.join(settingsDir, "settings.local.json"),
          JSON.stringify({
            env: { KSPEC_SESSION_ID: "ralph-session" },
          }),
          "utf-8",
        );

        await removeClaudeCodeEnv("original-user-session");

        const content = await fs.readFile(
          path.join(settingsDir, "settings.local.json"),
          "utf-8",
        );
        const settings = JSON.parse(content);
        expect(settings.env.KSPEC_SESSION_ID).toBe("original-user-session");
      } finally {
        process.chdir(originalCwd);
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        }
      }
    });
  });

  describe("injectEnvForAdapter / removeEnvForAdapter", () => {
    it("should inject for claude-agent-acp adapter", async () => {
      const envFile = path.join(testDir, "adapter-claude-env");
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        const sessionId = testUlid("ADPT", 1);
        const result = await injectEnvForAdapter("claude-agent-acp", sessionId);

        expect(result).not.toBeNull();
        expect(result!.injected).toBe(true);

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

    it("should inject for claude-code-acp adapter (deprecated alias)", async () => {
      const envFile = path.join(testDir, "adapter-claude-env-2");
      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        const sessionId = testUlid("ADPT", 2);
        const result = await injectEnvForAdapter("claude-code-acp", sessionId);

        expect(result).not.toBeNull();
        expect(result!.injected).toBe(true);
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        } else {
          delete process.env.CLAUDE_ENV_FILE;
        }
      }
    });

    it("should return null for unknown adapter", async () => {
      const result = await injectEnvForAdapter("some-custom-adapter", "session-id");
      expect(result).toBeNull();
    });

    it("should clean up for claude-agent-acp adapter", async () => {
      const envFile = path.join(testDir, "adapter-cleanup-env");
      await fs.writeFile(envFile, "KSPEC_SESSION_ID=to-remove\n", "utf-8");

      const originalEnv = process.env.CLAUDE_ENV_FILE;
      process.env.CLAUDE_ENV_FILE = envFile;

      try {
        await removeEnvForAdapter("claude-agent-acp");

        const content = await fs.readFile(envFile, "utf-8");
        expect(content).not.toContain("KSPEC_SESSION_ID");
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDE_ENV_FILE = originalEnv;
        } else {
          delete process.env.CLAUDE_ENV_FILE;
        }
      }
    });

    // AC: @codex-acp-adapter-registration ac-1
    it("should resolve codex-acp as a registered adapter (not ad-hoc)", () => {
      const adapter = resolveAdapter("codex-acp");
      // Registered adapters have a specific description; ad-hoc ones say "Ad-hoc adapter for ..."
      expect(adapter.description).not.toContain("Ad-hoc");
      expect(adapter.command).toBe("npx");
      expect(adapter.args).toContain("@zed-industries/codex-acp");
    });

    // AC: @codex-acp-adapter-registration ac-2
    it("should inject for codex-acp adapter via injectEnvForAdapter", async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        const sessionId = testUlid("ADPT", 3);
        const result = await injectEnvForAdapter("codex-acp", sessionId);

        expect(result).not.toBeNull();
        expect(result!.injected).toBe(true);
        expect(result!.method).toBe("codex_config");

        const configPath = path.join(testDir, ".codex", "config.toml");
        const content = parseTOML(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
        const policy = content.shell_environment_policy as Record<string, Record<string, string>>;
        expect(policy.set.KSPEC_SESSION_ID).toBe(sessionId);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    // AC: @codex-acp-adapter-registration ac-3
    it("should clean up for codex-acp adapter via removeEnvForAdapter", async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        // First inject
        const sessionId = testUlid("ADPT", 4);
        await injectCodexEnv(sessionId);

        // Verify injection
        const configPath = path.join(testDir, ".codex", "config.toml");
        let content = parseTOML(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
        const policy = content.shell_environment_policy as Record<string, Record<string, string>>;
        expect(policy.set.KSPEC_SESSION_ID).toBe(sessionId);

        // Remove via adapter function
        await removeEnvForAdapter("codex-acp");

        content = parseTOML(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
        expect(content.shell_environment_policy).toBeUndefined();
      } finally {
        process.env.HOME = originalHome;
      }
    });

    // AC: @codex-acp-adapter-registration ac-3
    it("should restore previous value for codex-acp adapter", async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        // Inject session
        const sessionId = testUlid("ADPT", 5);
        await injectCodexEnv(sessionId);

        // Remove with previousValue to restore
        const previousValue = "previous-session-id";
        await removeEnvForAdapter("codex-acp", previousValue);

        const configPath = path.join(testDir, ".codex", "config.toml");
        const content = parseTOML(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
        const policy = content.shell_environment_policy as Record<string, Record<string, string>>;
        expect(policy.set.KSPEC_SESSION_ID).toBe(previousValue);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    // AC: @codex-acp-adapter-registration ac-3
    it("should round-trip inject/remove for codex-acp via adapter path with previousValue propagation", async () => {
      const originalHome = process.env.HOME;
      process.env.HOME = testDir;

      try {
        // Pre-seed an existing KSPEC_SESSION_ID in Codex config
        const codexDir = path.join(testDir, ".codex");
        await fs.mkdir(codexDir, { recursive: true });
        await fs.writeFile(
          path.join(codexDir, "config.toml"),
          stringifyTOML({
            shell_environment_policy: { set: { KSPEC_SESSION_ID: "old-session" } },
          }),
          "utf-8",
        );

        // Inject via adapter — should capture previousValue
        const sessionId = testUlid("ADPT", 6);
        const result = await injectEnvForAdapter("codex-acp", sessionId);
        expect(result).not.toBeNull();
        expect(result!.previousValue).toBe("old-session");

        // Remove via adapter using the captured previousValue — should restore
        await removeEnvForAdapter("codex-acp", result!.previousValue);

        const configPath = path.join(codexDir, "config.toml");
        const content = parseTOML(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
        const policy = content.shell_environment_policy as Record<string, Record<string, string>>;
        expect(policy.set.KSPEC_SESSION_ID).toBe("old-session");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("should be a no-op for unknown adapter", async () => {
      // Should not throw
      await expect(removeEnvForAdapter("unknown-adapter")).resolves.toBeUndefined();
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

  // AC: @trait-semantic-exit-codes ac-2 - validation error exits non-zero
  // Project uses EXIT_CODES.USAGE_ERROR (2) for input validation errors
  it("should exit with non-zero code for invalid budget value", () => {
    const result = kspec(
      "session create --agent-type test --budget abc",
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("Invalid budget value");
  });

  // AC: @trait-semantic-exit-codes ac-6 - invalid arguments exit non-zero with usage info
  it("should show usage info for invalid budget", () => {
    const result = kspec(
      "session create --agent-type test --budget 0",
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBeGreaterThan(0);
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
          GEMINI_CLI: "",
          OPENCODE_CONFIG_DIR: "",
          OPENCODE_CONFIG: "",
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("export KSPEC_SESSION_ID=");
  });

  // Spec: @session-creation-and-env-injection (harness-specific injection for Gemini CLI)
  it("should inject via .gemini/.env when GEMINI_CLI=1", () => {
    const result = kspecJson<Record<string, unknown>>(
      "session create --agent-type gemini-cli --inject",
      testDir,
      {
        env: {
          CLAUDECODE: "",
          CLAUDE_CODE_ENTRYPOINT: "",
          CLAUDE_PROJECT_DIR: "",
          CODEX_SANDBOX: "",
          GEMINI_CLI: "1",
          OPENCODE_CONFIG_DIR: "",
          OPENCODE_CONFIG: "",
        },
      },
    );
    expect(result.env_injection).toBeDefined();
    const injection = result.env_injection as Record<string, unknown>;
    expect(injection.method).toBe("gemini_dotenv");
    expect(injection.injected).toBe(true);
  });

  // Spec: @session-creation-and-env-injection (harness-specific injection for OpenCode)
  it("should inject via .env when OpenCode detected", () => {
    const result = kspecJson<Record<string, unknown>>(
      "session create --agent-type opencode --inject",
      testDir,
      {
        env: {
          CLAUDECODE: "",
          CLAUDE_CODE_ENTRYPOINT: "",
          CLAUDE_PROJECT_DIR: "",
          CODEX_SANDBOX: "",
          GEMINI_CLI: "",
          OPENCODE_CONFIG_DIR: "/tmp/opencode-test",
          OPENCODE_CONFIG: "",
        },
      },
    );
    expect(result.env_injection).toBeDefined();
    const injection = result.env_injection as Record<string, unknown>;
    expect(injection.method).toBe("opencode_dotenv");
    expect(injection.injected).toBe(true);
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

  // AC: @trait-semantic-exit-codes ac-8 - documented exit code behavior
  it("should return USAGE_ERROR for invalid session create input", () => {
    const result = kspec(
      "session create --agent-type test --budget abc",
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
  });

  // AC: @trait-json-output ac-4 - references use @ prefix consistently
  it("should not include @ references in session create output", () => {
    // session create doesn't output references, so this is N/A for this command
    // but verify JSON output is clean and consistent
    const result = kspecJson<Record<string, unknown>>(
      "session create --agent-type test",
      testDir,
    );
    // No ref fields expected in session create output
    expect(result.session_id).not.toContain("@");
  });

  // AC: @trait-semantic-exit-codes ac-4 - runtime error exit code
  it("should exit non-zero on runtime errors", () => {
    // Trigger a runtime error by providing a directory that can't be initialized
    const result = kspec(
      "session create --agent-type test",
      "/nonexistent-dir-that-does-not-exist",
      { expectFail: true },
    );
    expect(result.exitCode).toBeGreaterThan(0);
  });

  // AC: @trait-error-guidance ac-1 - error includes description of what went wrong
  it("should describe what went wrong in error messages", () => {
    const result = kspec(
      "session create --agent-type test --budget 0",
      testDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("Invalid budget value");
    expect(result.stderr).toContain("Must be a positive integer");
  });

  // AC: @trait-error-guidance ac-2 - error includes suggested action
  it("should include suggestion in error output", () => {
    const result = kspec(
      "session create --agent-type test --budget abc",
      testDir,
      { expectFail: true },
    );
    expect(result.stderr).toContain("kspec session create --budget");
  });

  // AC: @trait-error-guidance ac-6 - guidance in structured error object
  it("should include guidance in JSON error object", () => {
    const result = kspec(
      "session create --agent-type test --budget xyz --json",
      testDir,
      { expectFail: true },
    );
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error).toBeTruthy();
    expect(parsed.details).toBeDefined();
    expect(parsed.details.suggestion).toContain("kspec session create --budget");
  });

  // AC: @session-creation-and-env-injection ac-inject-fallback (CLI level)
  it("should handle --inject flag in CLI with fallback for unknown harness", () => {
    const result = kspecJson<Record<string, unknown>>(
      "session create --agent-type unknown --inject",
      testDir,
      {
        env: {
          CLAUDECODE: "",
          CLAUDE_CODE_ENTRYPOINT: "",
          CLAUDE_PROJECT_DIR: "",
          CODEX_SANDBOX: "",
          GEMINI_CLI: "",
          OPENCODE_CONFIG_DIR: "",
          OPENCODE_CONFIG: "",
        },
      },
    );
    expect(result.env_injection).toBeDefined();
    const injection = result.env_injection as Record<string, unknown>;
    expect(injection.method).toBe("fallback");
    expect(injection.injected).toBe(false);
  });

  // AC: @session-creation-and-env-injection ac-invalid-session (CLI level)
  it("should warn when KSPEC_SESSION_ID is set to invalid value", () => {
    const result = kspec("session create --agent-type test", testDir, {
      env: { KSPEC_SESSION_ID: "NONEXISTENT_SESSION_12345" },
    });
    expect(result.exitCode).toBe(0); // Should still create successfully
    const allOutput = result.stdout + "\n" + result.stderr;
    expect(allOutput).toContain("invalid");
  });

  // Additional budget validation tests per Codex review
  it("should reject fractional budget values like 3.5", () => {
    const result = kspec(
      "session create --agent-type test --budget 3.5",
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("Invalid budget value");
  });

  it("should reject string-prefixed budget values like 3abc", () => {
    const result = kspec(
      "session create --agent-type test --budget 3abc",
      testDir,
      { expectFail: true },
    );
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.stderr).toContain("Invalid budget value");
  });
});

// ─── Trait AC Coverage Notes ─────────────────────────────────────────────────
//
// @trait-semantic-exit-codes:
//   ac-1: Tested (success exit 0) ✓
//   ac-2: Tested (validation error exits non-zero) ✓
//   ac-3: N/A - session create has no confirmation prompt
//   ac-4: Tested (runtime error exits non-zero) ✓
//   ac-5: N/A - session create always creates (no "nothing found" state)
//   ac-6: Tested (invalid flags with usage info) ✓
//   ac-7: N/A - session create is not a batch operation
//   ac-8: Tested (exit codes documented in code) ✓
//
// @trait-json-output:
//   ac-1: Tested (valid JSON, no ANSI) ✓
//   ac-2: Tested (all data in JSON mode) ✓
//   ac-3: Tested (error as JSON) ✓
//   ac-4: Tested (references with @ prefix - N/A, no refs in output) ✓
//   ac-5: Tested (ISO 8601 timestamps) ✓
//   ac-6: Tested (--json takes precedence) ✓
//
// @trait-error-guidance:
//   ac-1: Tested (error describes what went wrong) ✓
//   ac-2: Tested (error includes suggestion) ✓
//   ac-3: N/A - session create doesn't resolve references
//   ac-4: N/A - session create has no state transitions
//   ac-5: Tested (indicates field/value that failed) ✓
//   ac-6: Tested (guidance in JSON error object) ✓
