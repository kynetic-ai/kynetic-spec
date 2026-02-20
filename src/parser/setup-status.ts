/**
 * Setup status utilities
 *
 * Extracted from cli/commands/setup.ts to avoid CLI module dependency for doctor.ts.
 * Provides setup status information without output formatting.
 *
 * AC: @doctor-command ac-setup-agent-hooks, ac-setup-skills-agents-md, ac-partial-init, ac-staleness-unknown
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Detected agent type
 */
export type AgentType = "claude-code" | "cursor" | "windsurf" | "unknown";

/**
 * Setup status information
 * AC: @enhanced-setup ac-7, ac-8 - status reporting
 */
export interface SetupStatus {
  agent: {
    detected: AgentType;
    confidence: "high" | "medium" | "low";
  };
  hooks: {
    promptCheck: boolean;
    stop: boolean;
    preToolUse: boolean;
    guardsPresent: string[];
  };
  skills: {
    total: number;
    rendered: number;
    drifted: number;
  };
  agentsMd: {
    exists: boolean;
    status: "current" | "stale" | "missing" | "unknown";
    generatedAt?: string;
  };
  seeding: {
    permissionsSeeded: boolean;
    memorySeeded: boolean;
    memoryPath?: string;
  };
  /** Error message if status check failed */
  error?: string;
}

/**
 * Guard scripts that can be installed
 */
const GUARD_SCRIPTS: Record<string, boolean> = {
  "bash-guard.mjs": true,
  "write-guard.mjs": true,
  "edit-guard.mjs": true,
};

/**
 * Detect the agent type in use.
 */
export async function detectAgent(): Promise<{
  type: AgentType;
  confidence: "high" | "medium" | "low";
}> {
  // Check environment variables for agent hints
  const envHints = {
    CLAUDE_CODE: "claude-code",
    CURSOR_TRACE_ID: "cursor",
    WINDSURF_SESSION: "windsurf",
  } as const;

  for (const [envVar, agent] of Object.entries(envHints)) {
    if (process.env[envVar]) {
      return { type: agent as AgentType, confidence: "high" };
    }
  }

  // Check for Claude Code by looking for .claude directory
  // This is a medium confidence indicator
  if (process.env.HOME) {
    // Global Claude Code config at ~/.claude
    const globalClaudeDir = path.join(process.env.HOME, ".claude");
    try {
      const stats = await fs.stat(globalClaudeDir);
      if (stats.isDirectory()) {
        return { type: "claude-code", confidence: "medium" };
      }
    } catch {
      // Directory doesn't exist
    }
  }

  return { type: "unknown", confidence: "low" };
}

/**
 * Debug logging helper
 */
function debugLog(message: string, _error?: unknown): void {
  if (process.env.KSPEC_DEBUG === "1") {
    console.error(`[DEBUG] ${message}`);
  }
}

/**
 * Get the current setup status for a project.
 *
 * AC: @doctor-command ac-setup-agent-hooks — checks hooks status
 * AC: @doctor-command ac-setup-skills-agents-md — checks skills and agents.md
 * AC: @doctor-command ac-partial-init — handles missing setup artifacts
 * AC: @doctor-command ac-staleness-unknown — returns "unknown" when staleness cannot be determined
 *
 * @param projectDir Project root directory
 */
export async function getSetupStatus(projectDir: string): Promise<SetupStatus> {
  const detected = await detectAgent();
  const configPath = path.join(projectDir, ".claude", "settings.json");
  const hooksDir = path.join(projectDir, ".claude", "hooks");
  const agentsMdPath = path.join(projectDir, "kspec-agents.md");
  const hashPath = path.join(projectDir, ".kspec", ".kspec-agents-hash");
  const skillsDir = path.join(projectDir, ".claude", "skills");

  // Check hooks
  const hooks = {
    promptCheck: false,
    stop: false,
    preToolUse: false,
    guardsPresent: [] as string[],
  };

  try {
    const configContent = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(configContent);
    const hooksConfig = config.hooks || {};

    // Check UserPromptSubmit
    const promptHooks = hooksConfig.UserPromptSubmit as
      | Array<{ hooks?: Array<{ command?: string }> }>
      | undefined;
    hooks.promptCheck =
      promptHooks?.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes("prompt-check"))
      ) ?? false;

    // Check Stop
    const stopHooks = hooksConfig.Stop as
      | Array<{ hooks?: Array<{ command?: string }> }>
      | undefined;
    hooks.stop =
      stopHooks?.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes("checkpoint"))
      ) ?? false;

    // Check PreToolUse
    const preToolUseHooks = hooksConfig.PreToolUse as
      | Array<{ hooks?: Array<{ command?: string }> }>
      | undefined;
    hooks.preToolUse =
      preToolUseHooks?.some((entry) =>
        entry.hooks?.some((h) => h.command?.includes(".claude/hooks/"))
      ) ?? false;
  } catch (err) {
    debugLog("Failed to read hooks config for status", err);
  }

  // Check guard scripts
  try {
    const guardFiles = await fs.readdir(hooksDir);
    for (const name of Object.keys(GUARD_SCRIPTS)) {
      if (guardFiles.includes(name)) {
        hooks.guardsPresent.push(name);
      }
    }
  } catch (err) {
    debugLog("Hooks dir doesn't exist", err);
  }

  // Check skills
  const skills = {
    total: 0,
    rendered: 0,
    drifted: 0,
  };

  try {
    const skillDirs = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const dir of skillDirs) {
      if (dir.isDirectory()) {
        const skillMdPath = path.join(skillsDir, dir.name, "SKILL.md");
        try {
          const content = await fs.readFile(skillMdPath, "utf-8");
          if (content.includes("<!-- kspec-managed -->")) {
            skills.total++;
            skills.rendered++;
            // TODO: check drift status
          }
        } catch (err) {
          debugLog(`SKILL.md doesn't exist in ${dir.name}`, err);
        }
      }
    }
  } catch (err) {
    debugLog("Skills dir doesn't exist", err);
  }

  // Check agents.md
  const agentsMd: SetupStatus["agentsMd"] = {
    exists: false,
    status: "missing",
  };

  try {
    await fs.access(agentsMdPath);
    agentsMd.exists = true;

    try {
      const hashContent = await fs.readFile(hashPath, "utf-8");
      const hashData = JSON.parse(hashContent);
      agentsMd.generatedAt = hashData.generatedAt;

      // AC: @doctor-command ac-staleness-unknown
      // Compare stored hash against current meta to detect staleness
      try {
        const { initContext, loadMetaContext } = await import("./index.js");
        // Dynamic import agents.js from CLI commands
        const { computeMetaHash, loadTemplateSections, getPackageRoot } = await import(
          "../cli/commands/agents.js"
        );
        const ctx = await initContext();
        if (ctx.manifestPath) {
          const metaCtx = await loadMetaContext(ctx);
          let templateSections: string[] = [];
          try {
            templateSections = await loadTemplateSections(getPackageRoot());
          } catch (err) {
            debugLog("Templates not available for staleness check", err);
          }
          const currentHash = computeMetaHash(
            metaCtx.skills,
            metaCtx.conventions,
            metaCtx.workflows,
            templateSections
          );
          agentsMd.status = hashData.metaHash === currentHash ? "current" : "stale";
        } else {
          // AC: @doctor-command ac-staleness-unknown — no manifest means we can't check
          agentsMd.status = "unknown";
        }
      } catch (err) {
        // AC: @doctor-command ac-staleness-unknown — hash computation failed
        debugLog("Could not compute meta hash for staleness check", err);
        agentsMd.status = "unknown";
      }
    } catch (err) {
      debugLog("Hash file missing or invalid, marking stale", err);
      agentsMd.status = "stale";
    }
  } catch (err) {
    debugLog("kspec-agents.md doesn't exist", err);
  }

  // Check seeding state
  const seeding: SetupStatus["seeding"] = {
    permissionsSeeded: false,
    memorySeeded: false,
  };

  try {
    const configContent = await fs.readFile(
      path.join(projectDir, ".claude", "settings.json"),
      "utf-8"
    );
    const config = JSON.parse(configContent);
    seeding.permissionsSeeded = !!config.permissions;
  } catch (err) {
    debugLog("Could not check permissions seeding state", err);
  }

  if (detected.type === "claude-code") {
    try {
      const { claudeCodeMemoryWriter } = await import(
        "../cli/commands/setup-seeding.js"
      );
      const memoryExists = await claudeCodeMemoryWriter.exists(projectDir);
      seeding.memorySeeded = memoryExists;
      if (memoryExists) {
        seeding.memoryPath = claudeCodeMemoryWriter.getMemoryPath(projectDir);
      }
    } catch (err) {
      debugLog("Could not check memory seeding state", err);
    }
  }

  return {
    agent: {
      detected: detected.type,
      confidence: detected.confidence,
    },
    hooks,
    skills,
    agentsMd,
    seeding,
  };
}
