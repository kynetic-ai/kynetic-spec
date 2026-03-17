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
import {
  detectAgentFromEnv,
  type AgentType,
  type AgentConfidence,
} from "./agent-detection.js";

/**
 * Detected agent type
 */
export type { AgentType } from "./agent-detection.js";

/**
 * Setup status information
 * AC: @enhanced-setup ac-7, ac-8 - status reporting
 */
export interface SetupStatus {
  agent: {
    detected: AgentType;
    confidence: AgentConfidence;
    configPath?: string;
  };
  hooks: {
    supported: boolean;
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
  plugin: {
    marketplaceRegistered: boolean;
    marketplaceHealthy: boolean;
    pluginEnabled: boolean;
    registeredPath?: string;
    healthMessage?: string;
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

export interface GetSetupStatusOptions {
  agentOverride?: AgentType;
}

/**
 * Guard scripts that can be installed
 */
const GUARD_SCRIPTS: Record<string, boolean> = {
  "bash-guard.mjs": true,
  "write-guard.mjs": true,
  "edit-guard.mjs": true,
};

const NATIVE_GUARD_COMMAND = "kspec guard worktree";
const LEGACY_GUARD_SCRIPTS = [
  "kspec-worktree-guard.sh",
  "ralph-task-limit-guard.sh",
];

/**
 * Detect the agent type in use.
 */
export async function detectAgent(): Promise<{
  type: AgentType;
  confidence: AgentConfidence;
  configPath?: string;
}> {
  const detected = detectAgentFromEnv();
  if (detected.type !== "unknown") {
    const configPath = detected.configPath ??
      (detected.type === "claude-code"
        ? path.join(process.env.HOME ?? "", ".claude", "settings.json")
        : detected.type === "droid"
          ? path.join(process.env.HOME ?? "", ".factory", "settings.json")
          : undefined);
    return {
      type: detected.type,
      confidence: detected.confidence,
      configPath,
    };
  }

  // Check for Claude Code by looking for .claude directory
  // This is a medium confidence indicator
  if (process.env.HOME) {
    // Global Claude Code config at ~/.claude
    const globalClaudeDir = path.join(process.env.HOME, ".claude");
    try {
      const stats = await fs.stat(globalClaudeDir);
      if (stats.isDirectory()) {
        return {
          type: "claude-code",
          confidence: "medium",
          configPath: path.join(process.env.HOME, ".claude", "settings.json"),
        };
      }
    } catch {
      // Directory doesn't exist
    }

    // AC: @droid-setup-status ac-2 — ~/.factory as medium-confidence droid fallback (after ~/.claude)
    const globalDroidDir = path.join(process.env.HOME, ".factory");
    try {
      const stats = await fs.stat(globalDroidDir);
      if (stats.isDirectory()) {
        return {
          type: "droid",
          confidence: "medium",
          configPath: path.join(process.env.HOME, ".factory", "settings.json"),
        };
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
export async function getSetupStatus(
  projectDir: string,
  options: GetSetupStatusOptions = {},
): Promise<SetupStatus> {
  const detected = options.agentOverride
    ? {
        type: options.agentOverride,
        confidence: "high" as const,
        configPath:
          options.agentOverride === "claude-code"
            ? path.join(process.env.HOME ?? "", ".claude", "settings.json")
            : options.agentOverride === "droid"
              ? path.join(process.env.HOME ?? "", ".factory", "settings.json")
              : undefined,
      }
    : await detectAgent();
  const agentsMdPath = path.join(projectDir, "kspec-agents.md");
  const hashPath = path.join(projectDir, ".kspec", ".kspec-agents-hash");
  const claudeConfigPath = path.join(projectDir, ".claude", "settings.json");
  const hooksDir = path.join(projectDir, ".claude", "hooks");
  // AC: @droid-setup-status ac-1 — scan .factory/skills/ for droid-rendered skills
  const skillDirs = new Set<string>([path.join(projectDir, ".claude", "skills")]);
  if (detected.type === "droid") {
    skillDirs.add(path.join(projectDir, ".factory", "skills"));
  }

  // Check hooks
  const hooks = {
    supported: detected.type === "claude-code",
    promptCheck: false,
    stop: false,
    preToolUse: false,
    guardsPresent: [] as string[],
  };

  if (hooks.supported) {
    try {
      const configContent = await fs.readFile(claudeConfigPath, "utf-8");
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
          entry.hooks?.some((h) =>
            h.command === NATIVE_GUARD_COMMAND ||
            h.command?.includes(".claude/hooks/")
          )
        ) ?? false;

      if (preToolUseHooks?.some((entry) =>
        entry.hooks?.some((h) => h.command === NATIVE_GUARD_COMMAND)
      )) {
        hooks.guardsPresent.push(NATIVE_GUARD_COMMAND);
      }
      if (preToolUseHooks?.some((entry) =>
        entry.hooks?.some((h) =>
          LEGACY_GUARD_SCRIPTS.some((name) => h.command?.includes(name))
        )
      )) {
        hooks.guardsPresent.push("legacy:bash-scripts");
      }
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
      for (const name of LEGACY_GUARD_SCRIPTS) {
        if (guardFiles.includes(name)) {
          hooks.guardsPresent.push(`legacy-file:${name}`);
        }
      }
    } catch (err) {
      debugLog("Hooks dir doesn't exist", err);
    }
  }

  // Check skills
  const skills = {
    total: 0,
    rendered: 0,
    drifted: 0,
  };

  // Helper to check a single skill directory for kspec-managed SKILL.md
  async function checkSingleSkillDir(dirPath: string, dirName: string): Promise<void> {
    const skillMdPath = path.join(dirPath, "SKILL.md");
    try {
      const content = await fs.readFile(skillMdPath, "utf-8");
      if (content.includes("<!-- kspec-managed -->")) {
        skills.total++;
        skills.rendered++;
      }
    } catch (err) {
      debugLog(`SKILL.md doesn't exist in ${dirName}`, err);
    }
  }

  // Helper to scan a directory for skill subdirectories
  async function scanForSkills(baseDir: string, label: string): Promise<void> {
    try {
      const dirs = await fs.readdir(baseDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          await checkSingleSkillDir(path.join(baseDir, dir.name), `${label}/${dir.name}`);
        }
      }
    } catch (err) {
      debugLog(`${label} dir doesn't exist`, err);
    }
  }

  for (const skillsDir of skillDirs) {
    await scanForSkills(skillsDir, path.relative(projectDir, skillsDir) || skillsDir);
  }

  // Check plugin marketplace health
  // AC: @enhanced-setup ac-7, ac-8
  const plugin = {
    marketplaceRegistered: false,
    marketplaceHealthy: false,
    pluginEnabled: false,
    registeredPath: undefined as string | undefined,
    healthMessage: undefined as string | undefined,
  };

  try {
    const { checkMarketplaceHealth } = await import(
      "../lib/claude-plugin-registry.js"
    );
    const health = await checkMarketplaceHealth();
    plugin.marketplaceRegistered = health.status !== "missing";
    plugin.marketplaceHealthy = health.status === "healthy";
    plugin.registeredPath = health.registeredPath;
    plugin.healthMessage = health.message;
  } catch (err) {
    debugLog("Could not check marketplace health", err);
    plugin.healthMessage = "Health check unavailable";
  }

  // Check if plugin is enabled in project settings
  try {
    const configContent = await fs.readFile(claudeConfigPath, "utf-8");
    const config = JSON.parse(configContent);
    plugin.pluginEnabled = config.enabledPlugins?.["kspec@kspec-plugins"] === true;
  } catch (err) {
    debugLog("Could not check plugin enablement", err);
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
      configPath: detected.configPath,
    },
    hooks,
    skills,
    plugin,
    agentsMd,
    seeding,
  };
}
