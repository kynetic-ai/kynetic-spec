import * as os from "node:os";
import * as path from "node:path";

export type AgentType =
  | "claude-code"
  | "cline"
  | "roo-code"
  | "copilot-cli"
  | "gemini-cli"
  | "codex-cli"
  | "droid"
  | "aider"
  | "opencode"
  | "amp"
  | "cursor"
  | "windsurf"
  | "unknown";

export type AgentConfidence = "high" | "medium" | "low";

export interface DetectedAgent {
  type: AgentType;
  confidence: AgentConfidence;
  configPath?: string;
  envVars?: Record<string, string>;
}

/**
 * Shared environment-driven agent detection for setup and status/doctor paths.
 * Codex markers prioritize CODEX_THREAD_ID, with CODEX_SANDBOX kept for compatibility.
 */
export function detectAgentFromEnv(): DetectedAgent {
  if (
    process.env.CLAUDECODE === "1" ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CLAUDE_CODE
  ) {
    return {
      type: "claude-code",
      confidence: "high",
      configPath: path.join(os.homedir(), ".claude", "settings.json"),
      envVars: {
        ...(process.env.CLAUDECODE && { CLAUDECODE: process.env.CLAUDECODE }),
        ...(process.env.CLAUDE_CODE_ENTRYPOINT && {
          CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
        }),
        ...(process.env.CLAUDE_PROJECT_DIR && {
          CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
        }),
        ...(process.env.CLAUDE_CODE && { CLAUDE_CODE: process.env.CLAUDE_CODE }),
      },
    };
  }

  if (process.env.CLINE_ACTIVE) {
    return {
      type: "cline",
      confidence: "high",
      configPath: undefined,
      envVars: { CLINE_ACTIVE: process.env.CLINE_ACTIVE },
    };
  }

  if (process.env.CURSOR_TRACE_ID) {
    return {
      type: "cursor",
      confidence: "high",
    };
  }

  if (process.env.WINDSURF_SESSION) {
    return {
      type: "windsurf",
      confidence: "high",
    };
  }

  if (process.env.AIDER_MODEL || process.env.AIDER_DARK_MODE !== undefined) {
    return {
      type: "aider",
      confidence: "high",
      configPath: path.join(os.homedir(), ".aider.conf.yml"),
    };
  }

  if (process.env.OPENCODE_CONFIG_DIR || process.env.OPENCODE_CONFIG) {
    return {
      type: "opencode",
      confidence: "high",
      configPath:
        process.env.OPENCODE_CONFIG ||
        path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    };
  }

  if (process.env.GEMINI_CLI === "1") {
    return {
      type: "gemini-cli",
      confidence: "high",
      configPath: path.join(os.homedir(), ".gemini", "settings.json"),
      envVars: { GEMINI_CLI: "1" },
    };
  }

  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SANDBOX) {
    return {
      type: "codex-cli",
      confidence: "high",
      configPath: path.join(os.homedir(), ".codex", "config.toml"),
      envVars: {
        ...(process.env.CODEX_THREAD_ID && {
          CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
        }),
        ...(process.env.CODEX_SANDBOX && {
          CODEX_SANDBOX: process.env.CODEX_SANDBOX,
        }),
      },
    };
  }

  if (process.env.CODEX_CI || process.env.CODEX_MANAGED_BY_NPM) {
    return {
      type: "codex-cli",
      confidence: "medium",
      configPath: path.join(os.homedir(), ".codex", "config.toml"),
      envVars: {
        ...(process.env.CODEX_CI && { CODEX_CI: process.env.CODEX_CI }),
        ...(process.env.CODEX_MANAGED_BY_NPM && {
          CODEX_MANAGED_BY_NPM: process.env.CODEX_MANAGED_BY_NPM,
        }),
      },
    };
  }

  if (process.env.FACTORY_PROJECT_DIR) {
    return {
      type: "droid",
      confidence: "high",
      configPath: path.join(os.homedir(), ".factory", "settings.json"),
      envVars: {
        FACTORY_PROJECT_DIR: process.env.FACTORY_PROJECT_DIR,
      },
    };
  }

  if (process.env.COPILOT_MODEL || process.env.GH_TOKEN) {
    return {
      type: "copilot-cli",
      confidence: "medium",
      configPath: path.join(os.homedir(), ".copilot", "config.json"),
    };
  }

  if (process.env.AMP_API_KEY || process.env.AMP_TOOLBOX) {
    return {
      type: "amp",
      confidence: "medium",
      configPath: path.join(os.homedir(), ".config", "amp", "settings.json"),
    };
  }

  return {
    type: "unknown",
    confidence: "low",
  };
}
