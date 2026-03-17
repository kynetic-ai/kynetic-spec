/**
 * Enhanced setup command for kspec agent integration.
 *
 * Orchestrates the full onboarding pipeline:
 * - Detect agent environment (Claude Code, Cline, etc.)
 * - Install hooks (UserPromptSubmit, Stop, PreToolUse guards)
 * - Render skills from .kspec/skills/ to .claude/skills/
 * - Generate kspec-agents.md
 *
 * AC: @enhanced-setup ac-1 - summary displayed listing each step performed
 * AC: @enhanced-setup ac-2 - all hook entries (UserPromptSubmit, Stop, PreToolUse) present
 * AC: @enhanced-setup ac-3 - rendered skill files exist for each skill targeting claude-code
 * AC: @enhanced-setup ac-4 - kspec-agents.md exists after setup
 * AC: @enhanced-setup ac-5 - --skip-skills flag skips skill rendering
 * AC: @enhanced-setup ac-6 - --dry-run displays planned actions without changes
 * AC: @enhanced-setup ac-7 - --status reports current state including agent detected
 * AC: @enhanced-setup ac-8 - --status shows hooks status, skills rendered count, agents.md freshness
 * AC: @enhanced-setup ac-9 - skills referenced by ralph (task-work, reflect) are present
 */

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import type { Command } from "commander";
import {
  getGitRoot,
  getShadowStatus,
  repairShadow,
  remoteShadowBranchExists,
  SHADOW_BRANCH_NAME,
  SHADOW_WORKTREE_DIR,
  SESSIONS_WORKTREE_DIR,
  ensureSessionsGitignore,
  ensureShadowSessionsGitignore,
  needsSessionsGitignore,
  needsShadowSessionsGitignore,
  type ShadowOptions,
} from "../../parser/shadow.js";
import { loadProjectConfig } from "../../parser/config.js";
import {
  detectAgentFromEnv,
  type AgentConfidence,
} from "../../parser/agent-detection.js";
import {
  getSetupStatus as getSharedSetupStatus,
} from "../../parser/setup-status.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output, success, warn } from "../output.js";

/**
 * Log a message at debug level (only when KSPEC_DEBUG=1)
 * AC: @setup-pipeline-unification ac-4
 */
function debugLog(message: string, detail?: unknown): void {
  if (process.env.KSPEC_DEBUG === "1") {
    if (detail) {
      console.error(`[DEBUG] setup: ${message}`, detail);
    } else {
      console.error(`[DEBUG] setup: ${message}`);
    }
  }
}

/**
 * Supported agent types for auto-configuration
 */
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

/**
 * Result of agent detection
 */
export interface DetectedAgent {
  type: AgentType;
  confidence: AgentConfidence;
  configPath?: string;
  envVars?: Record<string, string>;
}

const SETUP_AGENT_OVERRIDES = [
  "claude-code",
  "cline",
  "droid",
  "cursor",
  "windsurf",
  "unknown",
] as const;

type SetupAgentOverride = (typeof SETUP_AGENT_OVERRIDES)[number];

function parseSetupAgentOverride(value: string): SetupAgentOverride {
  const normalized = value.trim().toLowerCase();
  if (
    (SETUP_AGENT_OVERRIDES as readonly string[]).includes(normalized)
  ) {
    return normalized as SetupAgentOverride;
  }

  const allowed = SETUP_AGENT_OVERRIDES.join(", ");
  throw new Error(
    `Invalid --agent value "${value}". Supported values: ${allowed}`,
  );
}

function buildDetectedAgent(type: AgentType): DetectedAgent {
  if (type === "claude-code") {
    return {
      type,
      confidence: "high",
      configPath: path.join(os.homedir(), ".claude", "settings.json"),
    };
  }
  if (type === "droid") {
    return {
      type,
      confidence: "high",
      configPath: path.join(os.homedir(), ".factory", "settings.json"),
    };
  }
  return { type, confidence: "high" };
}

/**
 * Detect which agent environment we're running in.
 * Returns the detected agent type and confidence level.
 *
 * Detection priority matters - more specific markers checked first.
 */
export function detectAgent(): DetectedAgent {
  const detected = detectAgentFromEnv();
  if (detected.type !== "unknown") {
    return detected;
  }

  // Fallback for non-interactive contexts where env markers may be absent.
  if (existsSync(path.join(os.homedir(), ".claude"))) {
    return {
      type: "claude-code",
      confidence: "low",
      configPath: path.join(os.homedir(), ".claude", "settings.json"),
    };
  }

  if (existsSync(path.join(os.homedir(), ".factory"))) {
    return {
      type: "droid",
      confidence: "low",
      configPath: path.join(os.homedir(), ".factory", "settings.json"),
    };
  }

  return detected;
}

/**
 * Install KSPEC_AUTHOR config for Claude Code (global settings)
 */
async function installClaudeCodeConfig(author: string): Promise<boolean> {
  const configPath = path.join(os.homedir(), ".claude", "settings.json");
  const configDir = path.dirname(configPath);

  try {
    // Ensure directory exists
    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (err) {
      debugLog("No existing Claude Code config, starting fresh", err);
    }

    // Merge env settings
    const env = (config.env as Record<string, string>) || {};
    env.KSPEC_AUTHOR = author;
    config.env = env;

    // Write back
    await fs.writeFile(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf-8",
    );
    return true;
  } catch (err) {
    debugLog("Failed to install Claude Code config", err);
    return false;
  }
}

/**
 * Result of installing hooks
 * AC: @enhanced-setup ac-2 - tracks all hook types
 */
export interface HooksInstallResult {
  promptCheck: boolean;
  stop: boolean;
  preToolUse: boolean;
  guardsCreated: string[];
}

/**
 * Native guard command for PreToolUse hooks.
 * Replaces bash shell scripts with `kspec guard worktree`.
 *
 * AC: @native-guard-commands ac-setup-native - references kspec guard worktree
 */
const NATIVE_GUARD_COMMAND = "kspec guard worktree";

/**
 * Old bash script filenames that should be migrated to native commands.
 * AC: @native-guard-commands ac-migrate-hooks
 */
const OLD_GUARD_SCRIPTS = [
  "kspec-worktree-guard.sh",
  "ralph-task-limit-guard.sh",
];

/**
 * Resolved hooks preferences for installation decisions.
 * AC: @project-config ac-hooks-section — each hook independently controllable
 */
interface HooksPreferences {
  /** Whether to install the checkpoint (Stop) hook */
  checkpoint: boolean;
  /** Whether to install the prompt-check (UserPromptSubmit) hook */
  prompt_check: boolean;
}

/**
 * Install hooks to project-level Claude Code settings (.claude/settings.json)
 * AC: @enhanced-setup ac-2 - all hook entries present
 * AC: @project-config ac-hooks-section — respects per-hook enable/disable from config
 */
async function installClaudeCodeHooks(
  projectDir: string,
  dryRun = false,
  hooksPrefs?: HooksPreferences,
): Promise<HooksInstallResult> {
  const configPath = path.join(projectDir, ".claude", "settings.json");
  const configDir = path.dirname(configPath);
  const hooksDir = path.join(projectDir, ".claude", "hooks");

  const result: HooksInstallResult = {
    promptCheck: false,
    stop: false,
    preToolUse: false,
    guardsCreated: [],
  };

  try {
    // Ensure directories exist
    if (!dryRun) {
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(hooksDir, { recursive: true });
    }

    // Read existing config or start fresh
    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (err) {
      debugLog("No existing hooks config, starting fresh", err);
    }

    // Get or create hooks object
    const hooks = (config.hooks as Record<string, unknown[]>) || {};

    // AC: @project-config ac-hooks-section — prompt-check independently controllable
    // Default: enabled (lightweight spec-first reminder)
    const promptCheckEnabled = hooksPrefs?.prompt_check ?? true;
    const promptCheckCommand = "kspec session prompt-check";
    const existingPromptHooks = hooks.UserPromptSubmit as
      | Array<{ hooks?: Array<{ command?: string }> }>
      | undefined;
    const promptAlreadyInstalled = existingPromptHooks?.some((entry) =>
      entry.hooks?.some((hook) =>
        hook.command?.includes("session prompt-check"),
      ),
    );

    if (promptCheckEnabled) {
      if (!promptAlreadyInstalled) {
        hooks.UserPromptSubmit = [
          ...(existingPromptHooks || []),
          {
            hooks: [
              {
                type: "command",
                command: promptCheckCommand,
              },
            ],
          },
        ];
        result.promptCheck = true;
      } else {
        result.promptCheck = true; // Already configured
      }
    } else {
      // AC: @project-config ac-hooks-section — remove if disabled and previously installed
      if (promptAlreadyInstalled) {
        const filtered = (existingPromptHooks || []).map((entry) => ({
          ...entry,
          hooks: entry.hooks?.filter(
            (hook) => !hook.command?.includes("session prompt-check"),
          ),
        })).filter((entry) => entry.hooks && entry.hooks.length > 0);
        if (filtered.length > 0) {
          hooks.UserPromptSubmit = filtered;
        } else {
          delete hooks.UserPromptSubmit;
        }
      }
      result.promptCheck = false;
    }

    // AC: @project-config ac-hooks-section — checkpoint independently controllable
    // Default: disabled (dispatch handles task lifecycle)
    const checkpointEnabled = hooksPrefs?.checkpoint ?? false;
    const stopHookCommand = "kspec session checkpoint --json";
    const existingStopHooks = hooks.Stop as
      | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      | undefined;
    const stopAlreadyInstalled = existingStopHooks?.some((entry) =>
      entry.hooks?.some((hook) => hook.command?.includes("session checkpoint")),
    );

    if (checkpointEnabled) {
      // AC: @project-config ac-hooks-section — install when enabled
      if (!stopAlreadyInstalled) {
        hooks.Stop = [
          ...(existingStopHooks || []),
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: stopHookCommand,
              },
            ],
          },
        ];
        result.stop = true;
      } else {
        result.stop = true; // Already configured
      }
    } else {
      // AC: @project-config ac-hooks-section — remove if disabled and previously installed
      if (stopAlreadyInstalled) {
        const filtered = (existingStopHooks || []).map((entry) => ({
          ...entry,
          hooks: entry.hooks?.filter(
            (hook) => !hook.command?.includes("session checkpoint"),
          ),
        })).filter((entry) => entry.hooks && entry.hooks.length > 0);
        if (filtered.length > 0) {
          hooks.Stop = filtered;
        } else {
          delete hooks.Stop;
        }
      }
      result.stop = false;
    }

    // AC: @enhanced-setup ac-2 - Install PreToolUse hooks with guards
    // AC: @native-guard-commands ac-setup-native - use native kspec guard worktree
    // AC: @native-guard-commands ac-no-task-limit-hook - no task-limit guard
    // AC: @native-guard-commands ac-migrate-hooks - replace old bash script entries
    // AC: @native-guard-commands ac-idempotent - no duplicate entries
    const existingPreToolUseHooks = hooks.PreToolUse as
      | Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>
      | undefined;

    // Check if native guard command is already installed
    const nativeAlreadyInstalled = existingPreToolUseHooks?.some((entry) =>
      entry.hooks?.some((hook) => hook.command === NATIVE_GUARD_COMMAND),
    );

    // Check for old bash script entries that need migration
    const hasOldScripts = existingPreToolUseHooks?.some((entry) =>
      entry.hooks?.some((hook) =>
        OLD_GUARD_SCRIPTS.some(
          (name) => hook.command?.includes(name),
        ),
      ),
    );

    if (hasOldScripts || !nativeAlreadyInstalled) {
      // Remove any PreToolUse entries that reference old bash scripts
      // AC: @native-guard-commands ac-migrate-hooks
      let filteredPreToolUse = (existingPreToolUseHooks || []).map((entry) => ({
        ...entry,
        hooks: entry.hooks?.filter(
          (hook) =>
            !OLD_GUARD_SCRIPTS.some((name) => hook.command?.includes(name)),
        ),
      }));
      // Remove entries with empty hooks arrays
      filteredPreToolUse = filteredPreToolUse.filter(
        (entry) => entry.hooks && entry.hooks.length > 0,
      );

      // Add native guard command if not already present
      if (!nativeAlreadyInstalled) {
        filteredPreToolUse.push({
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: NATIVE_GUARD_COMMAND,
            },
          ],
        });
      }

      hooks.PreToolUse = filteredPreToolUse;
      result.preToolUse = true;

      // Delete old bash script files
      // AC: @native-guard-commands ac-migrate-hooks - delete old files
      if (!dryRun) {
        for (const name of OLD_GUARD_SCRIPTS) {
          const scriptPath = path.join(hooksDir, name);
          try {
            await fs.unlink(scriptPath);
            result.guardsCreated.push(`deleted:${name}`);
          } catch (err) {
            debugLog(`Could not delete old guard script ${name}`, err);
          }
        }
      }
    } else {
      result.preToolUse = true; // Already configured with native command
    }

    config.hooks = hooks;

    // Write back
    if (!dryRun) {
      await fs.writeFile(
        configPath,
        `${JSON.stringify(config, null, 2)}\n`,
        "utf-8",
      );
    }
    return result;
  } catch (err) {
    debugLog("installClaudeCodeHooks failed", err);
    return result;
  }
}

/**
 * Install KSPEC_AUTHOR config for Aider (.aider.conf.yml)
 * Aider uses `set-env:` for environment variables in list format
 */
async function installAiderConfig(author: string): Promise<boolean> {
  const configPath = path.join(os.homedir(), ".aider.conf.yml");

  try {
    let content = "";
    try {
      content = await fs.readFile(configPath, "utf-8");
    } catch (err) {
      debugLog("No existing Aider config, starting fresh", err);
    }

    // Check if KSPEC_AUTHOR is already set
    if (content.includes("KSPEC_AUTHOR")) {
      // Replace existing value (handles both old and new format)
      content = content.replace(
        /^(\s*-?\s*KSPEC_AUTHOR\s*[=:]\s*).*$/m,
        `  - KSPEC_AUTHOR=${author}`,
      );
    } else {
      // Add to set-env section or create it
      if (content.includes("set-env:")) {
        // Append to existing set-env section
        content = content.replace(
          /(set-env:\s*\n)/m,
          `$1  - KSPEC_AUTHOR=${author}\n`,
        );
      } else {
        // Add new set-env section
        content += `\n# kspec author for note attribution\nset-env:\n  - KSPEC_AUTHOR=${author}\n`;
      }
    }

    await fs.writeFile(configPath, content, "utf-8");
    return true;
  } catch (err) {
    debugLog("installAiderConfig failed", err);
    return false;
  }
}

/**
 * Install KSPEC_AUTHOR for generic JSON config files
 */
async function installGenericJsonConfig(
  configPath: string,
  author: string,
): Promise<boolean> {
  try {
    const configDir = path.dirname(configPath);
    await fs.mkdir(configDir, { recursive: true });

    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch (err) {
      debugLog(`No existing config at ${configPath}, starting fresh`, err);
    }

    const env = (config.env as Record<string, string>) || {};
    env.KSPEC_AUTHOR = author;
    config.env = env;

    await fs.writeFile(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf-8",
    );
    return true;
  } catch (err) {
    debugLog(`installGenericJsonConfig failed for ${configPath}`, err);
    return false;
  }
}

/**
 * Get default author value for an agent type
 */
function getDefaultAuthor(agentType: AgentType): string {
  switch (agentType) {
    case "claude-code":
      return "@claude";
    case "cline":
      return "@cline";
    case "roo-code":
      return "@roo";
    case "copilot-cli":
      return "@copilot";
    case "gemini-cli":
      return "@gemini";
    case "codex-cli":
      return "@codex";
    case "droid":
      return "@droid";
    case "aider":
      return "@aider";
    case "opencode":
      return "@opencode";
    case "amp":
      return "@amp";
    default:
      return "@agent";
  }
}

/**
 * Prompt user for input with Y/N answer
 */
async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(`${question} `);
    return answer.toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

/**
 * Ensure .kspec worktree exists if kspec-meta branch is present.
 * AC: detect-existing-repo, auto-worktree-flag, worktree-already-exists
 *
 * @param autoWorktree If true, automatically create worktree without prompting
 * @returns true if worktree is ready to use
 */
async function ensureWorktree(autoWorktree: boolean): Promise<boolean> {
  const projectRoot = getGitRoot(process.cwd());
  if (!projectRoot) {
    // Not in a git repo, skip worktree check
    return true;
  }

  const { config } = await loadProjectConfig(projectRoot, projectRoot);
  const shadowOptions: ShadowOptions = {
    branchName: config.shadow.branch,
    directory: config.shadow.directory,
    remote: config.shadow.remote?.value,
    remoteType: config.shadow.remote?.type,
  };
  const branchName = shadowOptions.branchName || SHADOW_BRANCH_NAME;
  const worktreeDir = shadowOptions.directory || SHADOW_WORKTREE_DIR;
  const status = await getShadowStatus(projectRoot, shadowOptions);
  const remoteHasShadow = await remoteShadowBranchExists(
    projectRoot,
    shadowOptions,
  );
  const recoverableShadow = status.branchExists || remoteHasShadow;

  // AC: worktree-already-exists - if already valid, skip
  if (status.healthy) {
    return true;
  }

  // AC: detect-existing-repo - existing shadow state but missing/unhealthy worktree
  if (recoverableShadow && (!status.worktreeExists || !status.worktreeLinked)) {
    // AC: auto-worktree-flag - auto-create if flag set
    if (autoWorktree) {
      console.log(
        `Detected ${branchName} shadow state without a healthy ${worktreeDir} worktree. Creating...`,
      );
      const result = await repairShadow(projectRoot, shadowOptions);
      if (result.success) {
        success(`Created ${worktreeDir} worktree`);
        return true;
      } else {
        error(`Failed to create worktree: ${result.error}`);
        return false;
      }
    }

    // AC: detect-existing-repo - prompt user
    const shouldCreate = await promptYesNo(
      `${branchName} shadow state exists but ${worktreeDir} worktree is missing or unhealthy. Create it? (y/N)`,
    );

    if (shouldCreate) {
      console.log(`Creating ${worktreeDir} worktree...`);
      const result = await repairShadow(projectRoot, shadowOptions);
      if (result.success) {
        success(`Created ${worktreeDir} worktree`);
        return true;
      } else {
        error(`Failed to create worktree: ${result.error}`);
        return false;
      }
    } else {
      warn("Skipping worktree creation");
      return false;
    }
  }

  // No kspec-meta branch, or already healthy
  return true;
}

/**
 * Print manual setup instructions
 */
function printManualInstructions(agentType: AgentType): void {
  const author = getDefaultAuthor(agentType);

  console.log("\nManual setup instructions:\n");

  switch (agentType) {
    case "claude-code":
      console.log("Add to ~/.claude/settings.json:");
      console.log("```json");
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log("```");
      break;

    case "cline":
    case "roo-code":
      console.log("Add to your shell profile (~/.bashrc, ~/.zshrc):");
      console.log("```bash");
      console.log(`export KSPEC_AUTHOR="${author}"`);
      console.log("```");
      console.log(
        "\nThis will be inherited by terminals spawned by the VS Code extension.",
      );
      break;

    case "copilot-cli":
      console.log("Add to ~/.copilot/config.json:");
      console.log("```json");
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log("```");
      break;

    case "aider":
      console.log("Add to ~/.aider.conf.yml:");
      console.log("```yaml");
      console.log("set-env:");
      console.log(`  - KSPEC_AUTHOR=${author}`);
      console.log("```");
      break;

    case "codex-cli":
      console.log("Add to ~/.codex/config.toml:");
      console.log("```toml");
      console.log("[shell_environment_policy]");
      console.log(`set = { KSPEC_AUTHOR = "${author}" }`);
      console.log("```");
      break;

    case "droid":
      console.log("Add to .factory/settings.json:");
      console.log("```json");
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log("```");
      console.log(
        "\nDroid reads project environment variables from the env section of .factory/settings.json.",
      );
      break;

    case "opencode":
      console.log("Add to ~/.config/opencode/opencode.json:");
      console.log("```json");
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log("```");
      break;

    case "amp":
      console.log("Add to ~/.config/amp/settings.json:");
      console.log("```json");
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log("```");
      break;

    default:
      console.log("Set the KSPEC_AUTHOR environment variable:");
      console.log("```bash");
      console.log(`export KSPEC_AUTHOR="${author}"`);
      console.log("```");
      console.log("\nOr add to your shell profile (~/.bashrc, ~/.zshrc, etc.)");
  }
}

/**
 * Result of a setup step
 */
interface SetupStepResult {
  name: string;
  status: "done" | "skipped" | "failed";
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Result of running the setup pipeline
 * Used by both the setup command and init --setup
 * AC: @init-setup-integration ac-2, ac-3
 */
export interface SetupPipelineResult {
  success: boolean;
  steps: SetupStepResult[];
  coreSkillsInstalled: number;
  skillsRendered: number;
  hooksInstalled: boolean;
  agentsMdGenerated: boolean;
  permissionsSeeded: boolean;
  memorySeeded: boolean;
}

/**
 * Options for running the setup pipeline
 */
export interface SetupPipelineOptions {
  dryRun?: boolean;
  skipSkills?: boolean;
  installHooks?: boolean;
  force?: boolean;
  /** Explicit agent override (bypasses auto-detection) */
  agent?: SetupAgentOverride;
  /** Custom author string (overrides auto-detected default) */
  author?: string;
  /** Whether to configure author (only in command handler, not init) */
  configureAuthor?: boolean;
}

/**
 * Render skills using the platform renderer registry
 * AC: @setup-pipeline-unification ac-2 - uses getRenderer/getAllRenderers, not legacy renderClaudeCodeSkill
 * AC: @setup-pipeline-unification ac-4 - errors logged at debug level
 */
async function renderSkillsForSetup(
  projectDir: string,
  dryRun: boolean,
): Promise<{ rendered: number; skipped: number; pluginProvided: number; skillIds: string[] }> {
  // Dynamically import to avoid circular dependencies
  const { initContext, loadMetaContext } = await import(
    "../../parser/index.js"
  );
  const { getRenderer } = await import("../../parser/skill-render.js");

  try {
    const ctx = await initContext();

    if (!ctx.manifestPath) {
      return { rendered: 0, skipped: 0, pluginProvided: 0, skillIds: [] };
    }

    const metaCtx = await loadMetaContext(ctx);

    // Collect all skills that have a registered renderer for their platform
    const skillsToRender: Array<{ skill: typeof metaCtx.skills[0]; platform: string }> = [];
    for (const skill of metaCtx.skills) {
      for (const platform of skill.platforms) {
        const renderer = getRenderer(platform);
        if (renderer) {
          skillsToRender.push({ skill, platform });
        }
      }
    }

    if (skillsToRender.length === 0) {
      return { rendered: 0, skipped: 0, pluginProvided: 0, skillIds: [] };
    }

    let rendered = 0;
    let skipped = 0;
    let pluginProvided = 0;
    const skillIds: string[] = [];

    for (const { skill, platform } of skillsToRender) {
      const renderer = getRenderer(platform)!;
      try {
        const result = await renderer.render(ctx, projectDir, skill, {
          dryRun,
        });
        if (result.action === "created" || result.action === "updated") {
          rendered++;
          if (!skillIds.includes(skill.id)) {
            skillIds.push(skill.id);
          }
        } else if (result.action === "skipped" && result.skipCode === "plugin-provided") {
          pluginProvided++;
        } else {
          skipped++;
        }
      } catch (err) {
        debugLog(`Failed to render skill ${skill.id} for ${platform}`, err);
        skipped++;
      }
    }

    return { rendered, skipped, pluginProvided, skillIds };
  } catch (err) {
    debugLog("renderSkillsForSetup failed", err);
    return { rendered: 0, skipped: 0, pluginProvided: 0, skillIds: [] };
  }
}

function getHookInstallSkipMessage(agentType: AgentType): string {
  if (agentType === "droid") {
    return "droid hooks are not yet supported; skipping .factory/settings.json hook installation";
  }

  return `not applicable for ${agentType}`;
}

/**
 * Ensure built-in worker and reviewer agent definitions exist in the project meta.
 *
 * Creates task-worker and pr-reviewer agents with dispatch rules that match
 * ralph's behavior. Skips creation if agents already exist (idempotent).
 *
 * AC: @ralph-replacement ac-2 — built-in worker and reviewer agent definitions
 * created in kynetic.meta.yaml with default dispatch rules matching ralph's behavior
 */
async function ensureBuiltInAgents(
  projectDir: string,
  dryRun: boolean,
): Promise<{ created: string[]; skipped: string[] }> {
  const { initContext } = await import("../../parser/index.js");
  const { loadMetaContext, saveMetaItem } = await import(
    "../../parser/meta.js"
  );
  const { ulid } = await import("ulid");

  const created: string[] = [];
  const skipped: string[] = [];

  try {
    const ctx = await initContext();
    if (!ctx.manifestPath) {
      return { created, skipped };
    }

    const meta = await loadMetaContext(ctx);
    const existingIds = new Set((meta.agents || []).map((a) => a.id));

    // Built-in agent definitions — match ralph's dispatch behavior
    const builtInAgents = [
      {
        id: "task-worker",
        name: "Task Worker",
        description:
          "Autonomous task worker. Picks up automation-eligible ready and needs_work tasks.",
        capabilities: ["code", "test", "refactor"],
        tools: ["kspec", "git", "npm"],
        dispatch: [
          { on: "task.in_progress", filter: { automation: "eligible" } },
          { on: "task.ready", filter: { automation: "eligible" } },
          { on: "task.needs_work", filter: { automation: "eligible" } },
        ],
        skills: ["task-work"],
        concurrency: { max_concurrent: 1 },
        auto_approve: true,
      },
      {
        id: "pr-reviewer",
        name: "PR Reviewer",
        description:
          "Automated PR reviewer. Reviews pending_review tasks and merges when quality gates pass.",
        capabilities: ["review"],
        tools: ["kspec", "git", "gh"],
        dispatch: [{ on: "task.pending_review" }],
        skills: ["pr-review"],
        concurrency: { max_concurrent: 1 },
        auto_approve: false,
      },
    ] as const;

    for (const def of builtInAgents) {
      if (existingIds.has(def.id)) {
        skipped.push(def.id);
        continue;
      }

      if (!dryRun) {
        await saveMetaItem(
          ctx,
          {
            _ulid: ulid(),
            id: def.id,
            name: def.name,
            description: def.description,
            capabilities: [...def.capabilities],
            tools: [...def.tools],
            conventions: [],
            dispatch: def.dispatch.map((r) => ({ ...r })),
            skills: [...def.skills],
            concurrency: { ...def.concurrency },
            auto_approve: def.auto_approve,
          },
          "agent",
        );
      }
      created.push(def.id);
    }
  } catch (err) {
    debugLog("ensureBuiltInAgents failed", err);
  }

  return { created, skipped };
}

/**
 * Generate kspec-agents.md using the canonical implementation from agents.ts
 * AC: @setup-pipeline-unification ac-1 - calls generateAgentsContent() from agents.ts
 * AC: @setup-pipeline-unification ac-4 - errors logged at debug level
 */
async function generateAgentInstructions(
  projectDir: string,
  dryRun: boolean,
): Promise<{ success: boolean; path: string; skipped?: boolean }> {
  const outputPath = path.join(projectDir, "kspec-agents.md");
  const hashPath = path.join(projectDir, ".kspec", ".kspec-agents-hash");

  // Dynamically import to avoid circular dependencies
  const { initContext, loadMetaContext } = await import(
    "../../parser/index.js"
  );
  const {
    generateAgentsContent,
    loadTemplateSections,
    getPackageRoot,
    computeMetaHash,
  } = await import("./agents.js");

  try {
    const ctx = await initContext();

    if (!ctx.manifestPath) {
      return { success: false, path: outputPath };
    }

    const metaCtx = await loadMetaContext(ctx);
    const timestamp = new Date().toISOString();

    // Load templates using the canonical implementation
    let templateSections: string[] = [];
    try {
      templateSections = await loadTemplateSections(getPackageRoot());
    } catch (err) {
      debugLog("Failed to load template sections", err);
    }

    // Generate content using the canonical implementation from agents.ts
    const content = await generateAgentsContent(
      metaCtx.conventions,
      metaCtx.workflows,
      timestamp,
      templateSections,
    );

    if (!dryRun) {
      // Compute meta hash for freshness tracking
      const metaHash = computeMetaHash(
        metaCtx.conventions,
        metaCtx.workflows,
        templateSections,
      );

      // Skip regeneration when content unchanged (same pattern as kspec agents generate)
      let storedHash: string | undefined;
      try {
        const hashContent = await fs.readFile(hashPath, "utf-8");
        const hashData = JSON.parse(hashContent);
        storedHash = hashData.metaHash;
      } catch (_err) {
        // No hash file or invalid — regenerate
      }

      // Only skip if hash matches AND the output file actually exists
      let outputExists = false;
      try {
        await fs.access(outputPath);
        outputExists = true;
      } catch (_e) {
        // File missing — must regenerate even if hash matches
      }

      if (storedHash === metaHash && outputExists) {
        return { success: true, path: outputPath, skipped: true };
      }

      await fs.writeFile(outputPath, content, "utf-8");

      await fs.mkdir(path.dirname(hashPath), { recursive: true });
      // Dynamically import version to avoid top-level require
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const { version } = req("../../../package.json");

      await fs.writeFile(
        hashPath,
        JSON.stringify(
          {
            metaHash,
            generatedAt: timestamp,
            version,
          },
          null,
          2,
        ),
        "utf-8",
      );
    }

    return { success: true, path: outputPath };
  } catch (err) {
    debugLog("generateAgentInstructions failed", err);
    return { success: false, path: outputPath };
  }
}

/**
 * Install core skills for the setup pipeline
 * AC: @init-setup-integration ac-2 - core skills installed
 */
async function installCoreSkillsForSetup(
  projectDir: string,
  dryRun: boolean
): Promise<{
  installed: number;
  skipped: number;
  marketplaceRegistered?: boolean;
  pluginEnabled?: boolean;
  marketplaceMessage?: string;
  enableMessage?: string;
}> {
  // Dynamically import to avoid circular dependencies
  const {
    initContext,
    loadMetaContext,
    saveMetaItem,
    getSkillContentPath,
  } = await import("../../parser/index.js");
  const { commitIfShadow } = await import("../../parser/shadow.js");
  const { SkillSchema } = await import("../../schema/index.js");
  const {
    loadCoreSkillsManifest,
    copyCoreSkillFiles,
    getKspecPackageVersion,
  } = await import("./skill.js");
  const { ulid } = await import("ulid");

  let installed = 0;
  let skipped = 0;

  try {
    const ctx = await initContext();

    if (!ctx.manifestPath) {
      return { installed: 0, skipped: 0 };
    }

    const metaCtx = await loadMetaContext(ctx);
    const coreSkills = await loadCoreSkillsManifest();
    // AC: @cross-platform-and-version-robustness ac-3
    const kspecVersion = await getKspecPackageVersion();
    if (!kspecVersion) {
      debugLog("Could not determine kspec version — skills installed without version tracking");
    }

    for (const coreSkill of coreSkills) {
      // Check if skill exists
      const existingSkill = metaCtx.skills.find((s) => s.id === coreSkill.id);

      if (existingSkill && existingSkill.origin !== "core") {
        // Custom/project skill exists, skip
        skipped++;
        continue;
      }

      // Build skill data
      const skillData = {
        _ulid: existingSkill?._ulid || ulid(),
        id: coreSkill.id,
        name: coreSkill.name,
        description: coreSkill.description,
        origin: "core" as const,
        ...(kspecVersion && { version: kspecVersion }),
        platforms: coreSkill.platforms || ["claude-code"],
        depends_on: [],
        tags: ["core"],
      };

      const parsed = SkillSchema.safeParse(skillData);
      if (!parsed.success) {
        skipped++;
        continue;
      }

      if (!dryRun) {
        await saveMetaItem(ctx, parsed.data, "skill");

        // Copy skill files (SKILL.md + supporting dirs)
        const targetDir = path.dirname(getSkillContentPath(ctx, parsed.data.id));
        await copyCoreSkillFiles(coreSkill.id, targetDir);
      }

      installed++;
    }

    // Commit changes
    if (!dryRun && installed > 0) {
      const ctx2 = await initContext();
      await commitIfShadow(
        ctx2.shadow,
        "skill-install-core",
        `${installed} core skills`
      );
    }

    // AC: @core-skill-install ac-6, ac-7 - Register marketplace and enable plugin
    let marketplaceResult;
    let enableResult;
    if (!dryRun) {
      const {
        registerCorePluginMarketplace,
        enablePluginInProject,
      } = await import("../../lib/claude-plugin-registry.js");
      marketplaceResult = await registerCorePluginMarketplace();
      enableResult = await enablePluginInProject(projectDir);
    }

    return {
      installed,
      skipped,
      marketplaceRegistered: marketplaceResult?.success ?? false,
      pluginEnabled: enableResult?.success ?? false,
      marketplaceMessage: marketplaceResult?.message,
      enableMessage: enableResult?.message,
    };
  } catch (err) {
    debugLog("installCoreSkillsForSetup failed", err);
    return { installed: 0, skipped: 0 };
  }
}

/**
 * Run the full setup pipeline programmatically.
 * Used by both 'kspec setup' command and 'kspec init --setup'.
 * AC: @init-setup-integration ac-2, ac-3
 */
export async function runSetupPipeline(
  projectDir: string,
  options: SetupPipelineOptions
): Promise<SetupPipelineResult> {
  const dryRun = options.dryRun ?? false;
  const skipSkills = options.skipSkills ?? false;
  const installHooksFlag = options.installHooks ?? true;

  const steps: SetupStepResult[] = [];
  let coreSkillsInstalled = 0;
  let skillsRendered = 0;
  let hooksInstalled = false;
  let agentsMdGenerated = false;
  let permissionsSeeded = false;
  let memorySeeded = false;

  try {
    const detected = options.agent
      ? buildDetectedAgent(options.agent)
      : detectAgent();

    // Step 1: Agent detection
    steps.push({
      name: "Agent detection",
      status: "done",
      message: `${detected.type} (${detected.confidence} confidence)`,
    });

    // Step 2: Install core skills
    // AC: @init-setup-integration ac-2 - core skills installed in .kspec/skills/
    const coreResult = await installCoreSkillsForSetup(projectDir, dryRun);
    coreSkillsInstalled = coreResult.installed;

    if (coreResult.installed > 0 || coreResult.skipped > 0) {
      steps.push({
        name: "Install core skills",
        status: "done",
        message: `${coreResult.installed} installed, ${coreResult.skipped} skipped`,
      });
    } else {
      steps.push({
        name: "Install core skills",
        status: "skipped",
        message: "No core skills found in package",
      });
    }

    // Step 2b: Register plugin marketplace (reports result from installCoreSkillsForSetup)
    // AC: @core-skill-install ac-6, ac-7
    if (!dryRun && (coreResult.installed > 0 || coreResult.skipped > 0)) {
      const bothOk = coreResult.marketplaceRegistered && coreResult.pluginEnabled;
      if (bothOk) {
        steps.push({
          name: "Register plugin marketplace",
          status: "done",
          message: "marketplace registered, plugin enabled",
        });
      } else {
        const failures: string[] = [];
        if (!coreResult.marketplaceRegistered) {
          failures.push(coreResult.marketplaceMessage || "marketplace registration failed");
        }
        if (!coreResult.pluginEnabled) {
          failures.push(coreResult.enableMessage || "plugin enablement failed");
        }
        steps.push({
          name: "Register plugin marketplace",
          status: "failed",
          message: failures.join("; "),
        });
      }
    }

    // Step 3: Install hooks (Claude Code only)
    // AC: @init-setup-integration ac-3 - hooks present
    // AC: @project-config ac-hooks-section — read config to determine hook preferences
    if (detected.type === "claude-code" && installHooksFlag) {
      // Load project config to get hooks preferences
      const { config: projectConfig } = await loadProjectConfig(projectDir, projectDir);
      const hooksPrefs: HooksPreferences = {
        checkpoint: projectConfig.hooks.checkpoint,
        prompt_check: projectConfig.hooks.prompt_check,
      };

      const hooksResult = await installClaudeCodeHooks(projectDir, dryRun, hooksPrefs);
      const installedHooks: string[] = [];
      if (hooksResult.promptCheck) installedHooks.push("UserPromptSubmit");
      if (hooksResult.stop) installedHooks.push("Stop");
      if (hooksResult.preToolUse) installedHooks.push("PreToolUse");

      hooksInstalled =
        hooksResult.promptCheck || hooksResult.stop || hooksResult.preToolUse;

      steps.push({
        name: "Install hooks",
        status: "done",
        message: installedHooks.join(", "),
        details: {
          guards: hooksResult.guardsCreated,
        },
      });
    } else if (!installHooksFlag) {
      steps.push({
        name: "Install hooks",
        status: "skipped",
        message: "--no-hooks flag",
      });
    } else {
      steps.push({
        name: "Install hooks",
        status: "skipped",
        message: getHookInstallSkipMessage(detected.type),
      });
    }

    // Step 3a: Ensure artifacts directory exists
    // AC: @artifacts-directory ac-setup-ensures
    {
      const artifactsDir = path.join(projectDir, ".kspec", "artifacts");
      let artifactsCreated = false;
      try {
        await fs.access(artifactsDir);
      } catch (_e) {
        if (!dryRun) {
          await fs.mkdir(artifactsDir, { recursive: true });
        }
        artifactsCreated = true;
      }
      steps.push({
        name: "Ensure artifacts directory",
        status: artifactsCreated ? "done" : "skipped",
        message: artifactsCreated ? "created .kspec/artifacts/" : "already exists",
      });
    }

    // Step 3a-ii: Ensure sessions directory and gitignore entries
    // AC: @session-storage-modes ac-gitignore, ac-sessions-dir-autocreate
    // AC: @session-legacy-migration ac-shadow-gitignore
    {
      const actions: string[] = [];

      // Create .kspec-sessions/ directory
      const sessionsDirPath = path.join(projectDir, SESSIONS_WORKTREE_DIR);
      let sessionsCreated = false;
      try {
        await fs.access(sessionsDirPath);
      } catch (_e) {
        if (!dryRun) {
          await fs.mkdir(sessionsDirPath, { recursive: true });
        }
        sessionsCreated = true;
      }
      if (sessionsCreated) {
        actions.push(`${dryRun ? "create" : "created"} ${SESSIONS_WORKTREE_DIR}/`);
      }

      // Add .kspec-sessions/ to root .gitignore
      if (dryRun) {
        const rootNeeded = await needsSessionsGitignore(projectDir);
        if (rootNeeded) {
          actions.push(`add ${SESSIONS_WORKTREE_DIR}/ to .gitignore`);
        }
      } else {
        const rootAdded = await ensureSessionsGitignore(projectDir);
        if (rootAdded) {
          actions.push(`added ${SESSIONS_WORKTREE_DIR}/ to .gitignore`);
        }
      }

      // Add sessions/ to .kspec/.gitignore
      if (dryRun) {
        const shadowNeeded = await needsShadowSessionsGitignore(projectDir);
        if (shadowNeeded) {
          actions.push("add sessions/ to .kspec/.gitignore");
        }
      } else {
        const shadowAdded = await ensureShadowSessionsGitignore(projectDir);
        if (shadowAdded) {
          actions.push("added sessions/ to .kspec/.gitignore");
        }
      }

      steps.push({
        name: "Ensure sessions directory",
        status: actions.length > 0 ? "done" : "skipped",
        message: actions.length > 0 ? actions.join(", ") : "already configured",
      });
    }

    // Step 3a-iii: Initialize session branch worktree if sessions.storage is "branch"
    // AC: @session-branch-worktree ac-init
    {
      try {
        const { initContext } = await import("../../parser/index.js");
        const ctx = await initContext();
        const sessionStorage = ctx.manifest?.sessions?.storage;
        if (sessionStorage === "branch") {
          const { initializeSessionBranch, getSessionBranchStatus } = await import(
            "../../parser/session-branch.js"
          );
          const sessionBranchName = ctx.manifest?.sessions?.branch || "kspec-sessions";
          const sessionStatus = await getSessionBranchStatus(
            projectDir,
            sessionBranchName,
          );
          if (sessionStatus.healthy) {
            steps.push({
              name: "Session branch worktree",
              status: "skipped",
              message: "already initialized",
            });
          } else if (dryRun) {
            steps.push({
              name: "Session branch worktree",
              status: "done",
              message: `create orphan branch "${sessionBranchName}" with worktree at ${SESSIONS_WORKTREE_DIR}/`,
            });
          } else {
            const sessionResult = await initializeSessionBranch(
              projectDir,
              sessionBranchName,
            );
            if (sessionResult.success) {
              steps.push({
                name: "Session branch worktree",
                status: "done",
                message: sessionResult.alreadyExists
                  ? "already initialized"
                  : `created branch "${sessionBranchName}" with worktree at ${SESSIONS_WORKTREE_DIR}/`,
              });
            } else {
              steps.push({
                name: "Session branch worktree",
                status: "failed",
                message: sessionResult.error || "unknown error",
              });
            }
          }
        }
      } catch {
        // Session branch init is optional — don't block setup
      }
    }

    // Step 3b: Seed permissions (Claude Code only)
    // AC: @new-project-bootstrapping ac-1
    {
      const { seedPermissions } = await import("./setup-seeding.js");
      const permResult = await seedPermissions(projectDir, detected.type, {
        dryRun,
        force: options.force,
      });
      permissionsSeeded = permResult.seeded;

      steps.push({
        name: "Seed permissions",
        status: permResult.seeded ? "done" : "skipped",
        message: permResult.message,
      });
    }

    // Step 3c: Seed memory (platform-extensible)
    // AC: @new-project-bootstrapping ac-2, ac-3
    {
      const { seedMemory } = await import("./setup-seeding.js");
      const memResult = await seedMemory(projectDir, detected.type, {
        dryRun,
        force: options.force,
      });
      memorySeeded = memResult.seeded;
      const memoryStepStatus =
        memResult.message.startsWith("failed:")
          ? "failed"
          : memResult.seeded
            ? "done"
            : "skipped";

      steps.push({
        name: "Seed memory",
        status: memoryStepStatus,
        message: memResult.seeded ? memResult.path : memResult.message,
      });
    }

    // Step 4: Render skills
    // AC: @init-setup-integration ac-3 - rendered skill files present
    if (!skipSkills) {
      const skillsResult = await renderSkillsForSetup(projectDir, dryRun);
      skillsRendered = skillsResult.rendered;

      if (skillsResult.rendered > 0 || skillsResult.skipped > 0 || skillsResult.pluginProvided > 0) {
        const parts = [];
        if (skillsResult.rendered > 0) parts.push(`${skillsResult.rendered} rendered`);
        if (skillsResult.pluginProvided > 0) parts.push(`${skillsResult.pluginProvided} plugin-provided`);
        if (skillsResult.skipped > 0) parts.push(`${skillsResult.skipped} unchanged`);
        steps.push({
          name: "Render skills",
          status: "done",
          message: parts.join(", "),
          details: {
            skillIds: skillsResult.skillIds,
          },
        });
      } else {
        steps.push({
          name: "Render skills",
          status: "skipped",
          message: "No skills with registered renderers in meta",
        });
      }
    } else {
      steps.push({
        name: "Render skills",
        status: "skipped",
        message: "--skip-skills flag",
      });
    }

    // Step 4b: Ensure built-in worker and reviewer agent definitions exist
    // AC: @ralph-replacement ac-2 — built-in agents created in kynetic.meta.yaml
    {
      const agentsBuiltIn = await ensureBuiltInAgents(projectDir, dryRun);
      const totalNew = agentsBuiltIn.created.length;
      const totalSkipped = agentsBuiltIn.skipped.length;
      if (totalNew > 0 || totalSkipped > 0) {
        steps.push({
          name: "Ensure built-in agents",
          status: "done",
          message:
            totalNew > 0
              ? `created: ${agentsBuiltIn.created.join(", ")}`
              : `already exist: ${agentsBuiltIn.skipped.join(", ")}`,
        });
      }
    }

    // Step 5: Generate kspec-agents.md
    // AC: @init-setup-integration ac-3 - kspec-agents.md present
    const agentsResult = await generateAgentInstructions(projectDir, dryRun);
    agentsMdGenerated = agentsResult.success;

    if (agentsResult.success) {
      steps.push({
        name: "Generate kspec-agents.md",
        status: "done",
        message: agentsResult.skipped
          ? "already up to date"
          : agentsResult.path,
      });
    } else {
      steps.push({
        name: "Generate kspec-agents.md",
        status: "failed",
        message: "No kspec project found",
      });
    }

    // Step 6: Configure author (optional, used by setup command)
    if (options.configureAuthor) {
      const author = options.author || getDefaultAuthor(detected.type);
      if (!options.force && process.env.KSPEC_AUTHOR) {
        steps.push({
          name: "Configure author",
          status: "skipped",
          message: `KSPEC_AUTHOR already set to "${process.env.KSPEC_AUTHOR}"`,
        });
      } else {
        let authorInstalled = false;
        switch (detected.type) {
          case "claude-code":
            if (!dryRun) {
              authorInstalled = await installClaudeCodeConfig(author);
            } else {
              authorInstalled = true;
            }
            break;
          case "droid":
            authorInstalled = false;
            break;
          case "aider":
            if (!dryRun) {
              authorInstalled = await installAiderConfig(author);
            } else {
              authorInstalled = true;
            }
            break;
          default:
            break;
        }

        if (authorInstalled) {
          steps.push({
            name: "Configure author",
            status: "done",
            message: `KSPEC_AUTHOR="${author}"`,
          });
        } else if (detected.type === "droid") {
          steps.push({
            name: "Configure author",
            status: "skipped",
            message: "add KSPEC_AUTHOR to the .factory/settings.json env section",
          });
        } else if (detected.type === "unknown") {
          // AC: @cmd-setup ac-1 - show manual instructions for unknown agents
          steps.push({
            name: "Configure author",
            status: "skipped",
            message: `no auto-config for unknown agent — set KSPEC_AUTHOR manually`,
          });
        }
      }
    }

    // Output summary
    if (!dryRun) {
      console.log(chalk.bold("kspec Setup Summary\n"));

      for (const step of steps) {
        const icon =
          step.status === "done"
            ? chalk.green("✓")
            : step.status === "skipped"
              ? chalk.gray("○")
              : chalk.red("✗");
        const statusText =
          step.status === "done"
            ? ""
            : step.status === "skipped"
              ? chalk.gray(" (skipped)")
              : chalk.red(" (failed)");

        console.log(`${icon} ${step.name}${statusText}`);
        if (step.message) {
          console.log(chalk.gray(`  ${step.message}`));
        }
      }
    }

    const success = steps.every((s) => s.status !== "failed");

    return {
      success,
      steps,
      coreSkillsInstalled,
      skillsRendered,
      hooksInstalled,
      agentsMdGenerated,
      permissionsSeeded,
      memorySeeded,
    };
  } catch (err) {
    debugLog("runSetupPipeline failed", err);
    return {
      success: false,
      steps,
      coreSkillsInstalled,
      skillsRendered,
      hooksInstalled,
      agentsMdGenerated,
      permissionsSeeded,
      memorySeeded,
    };
  }
}

/**
 * Register the 'setup' command
 * AC: @enhanced-setup ac-1 through ac-9
 */
export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Configure agent environment for kspec (orchestrated pipeline)")
    .option(
      "--agent <type>",
      "Explicit agent type override (claude-code|cline|droid|cursor|windsurf|unknown)",
    )
    .option("--dry-run", "Show what would be done without making changes")
    .option(
      "--author <author>",
      "Custom author string (default: auto-detected based on agent)",
    )
    .option("--no-hooks", "Skip installing hooks")
    .option("--skip-skills", "Skip rendering skills")
    .option("--status", "Report current setup state without making changes")
    .option("--force", "Overwrite existing configuration")
    .option(
      "--auto-worktree",
      "Automatically create .kspec worktree if kspec-meta branch exists",
    )
    .action(async (options) => {
      try {
        const projectDir = process.cwd();
        const agentOverride = options.agent
          ? parseSetupAgentOverride(options.agent)
          : undefined;

        // AC: @enhanced-setup ac-7, ac-8 - --status mode
        if (options.status) {
          const status = await getSharedSetupStatus(projectDir, {
            agentOverride,
          });

          output(status, () => {
            console.log(chalk.bold("kspec Setup Status\n"));

            // Agent detection
            console.log(chalk.gray("Agent:"));
            console.log(
              `  Detected: ${status.agent.detected} (${status.agent.confidence} confidence)`,
            );
            if (status.agent.configPath) {
              console.log(`  Config:   ${status.agent.configPath}`);
            }
            console.log();

            // Hooks status
            console.log(chalk.gray("Hooks:"));
            if (status.hooks.supported) {
              console.log(
                `  UserPromptSubmit: ${status.hooks.promptCheck ? chalk.green("✓") : chalk.red("✗")}`,
              );
              console.log(
                `  Stop:             ${status.hooks.stop ? chalk.green("✓") : chalk.red("✗")}`,
              );
              console.log(
                `  PreToolUse:       ${status.hooks.preToolUse ? chalk.green("✓") : chalk.red("✗")}`,
              );
            } else {
              const unsupported = chalk.yellow("unsupported");
              console.log(`  UserPromptSubmit: ${unsupported}`);
              console.log(`  Stop:             ${unsupported}`);
              console.log(`  PreToolUse:       ${unsupported}`);
              if (status.agent.detected === "droid") {
                console.log(
                  "  Note:             droid hooks are not yet supported",
                );
              }
            }
            if (status.hooks.guardsPresent.length > 0) {
              console.log(
                `  Guards:           ${status.hooks.guardsPresent.join(", ")}`,
              );
            }
            console.log();

            // Skills status
            console.log(chalk.gray("Skills:"));
            console.log(`  Rendered: ${status.skills.rendered}`);
            if (status.skills.drifted > 0) {
              console.log(
                `  Drifted:  ${chalk.yellow(status.skills.drifted.toString())}`,
              );
            }
            console.log();

            // Plugin marketplace status
            // AC: @enhanced-setup ac-7, ac-8
            console.log(chalk.gray("Plugin:"));
            console.log(
              `  Marketplace: ${status.plugin.marketplaceRegistered ? (status.plugin.marketplaceHealthy ? chalk.green("healthy") : chalk.yellow("registered")) : chalk.red("not registered")}`,
            );
            console.log(
              `  Enabled:     ${status.plugin.pluginEnabled ? chalk.green("✓") : chalk.red("✗")}`,
            );
            if (status.plugin.registeredPath) {
              console.log(chalk.gray(`  Path: ${status.plugin.registeredPath}`));
            }
            if (status.plugin.healthMessage && !status.plugin.marketplaceHealthy) {
              console.log(chalk.yellow(`  ${status.plugin.healthMessage}`));
            }
            console.log();

            // Agents.md status
            console.log(chalk.gray("kspec-agents.md:"));
            if (status.agentsMd.exists) {
              // AC: @doctor-command ac-staleness-unknown — show appropriate color for unknown status
              const statusColor =
                status.agentsMd.status === "current"
                  ? chalk.green
                  : status.agentsMd.status === "unknown"
                    ? chalk.yellow
                    : chalk.yellow;
              console.log(`  Status: ${statusColor(status.agentsMd.status)}`);
              if (status.agentsMd.status === "unknown") {
                console.log(chalk.gray("  Could not determine staleness (no manifest or hash unavailable)"));
              }
              if (status.agentsMd.generatedAt) {
                console.log(`  Generated: ${status.agentsMd.generatedAt}`);
              }
            } else {
              console.log(`  Status: ${chalk.red("missing")}`);
              console.log(
                chalk.gray("  Run 'kspec setup' to generate"),
              );
            }
            console.log();

            // Seeding status
            console.log(chalk.gray("Seeding:"));
            console.log(
              `  Permissions: ${status.seeding.permissionsSeeded ? chalk.green("✓") : chalk.gray("○")}`,
            );
            console.log(
              `  Memory:      ${status.seeding.memorySeeded ? chalk.green("✓") : chalk.gray("○")}`,
            );
            if (status.seeding.memoryPath) {
              console.log(
                chalk.gray(`  Path: ${status.seeding.memoryPath}`),
              );
            }
          });
          return;
        }

        // AC: detect-existing-repo, auto-worktree-flag, worktree-already-exists
        const worktreeReady = await ensureWorktree(
          options.autoWorktree || false,
        );
        if (!worktreeReady) {
          // User declined worktree creation or it failed
          process.exit(EXIT_CODES.ERROR);
        }

        const detected = agentOverride
          ? buildDetectedAgent(agentOverride)
          : detectAgent();
        const dryRun = options.dryRun || false;

        // AC: @cmd-setup ac-1 - proceed with setup even when no agent is detected
        if (detected.type === "unknown") {
          warn("Could not auto-detect agent environment — proceeding with core setup steps");
        }

        // AC: @setup-pipeline-unification ac-3 - delegate to runSetupPipeline()
        // One code path for both 'kspec setup' and 'kspec init --setup'
        const result = await runSetupPipeline(projectDir, {
          dryRun,
          skipSkills: options.skipSkills || false,
          installHooks: options.hooks !== false,
          force: options.force || false,
          agent: agentOverride,
          author: options.author,
          configureAuthor: true,
        });

        // AC: @enhanced-setup ac-1 - Display summary
        // AC: @enhanced-setup ac-6 - dry-run displays planned actions
        output(
          {
            dry_run: dryRun,
            steps: result.steps.map((s) => ({
              name: s.name,
              status: s.status,
              message: s.message,
              details: s.details,
            })),
          },
          () => {
            if (dryRun) {
              console.log(chalk.yellow("DRY RUN - No changes made\n"));
            }

            // Pipeline already prints the summary when not dry-run
            // For dry-run, print it here since the pipeline skips output
            if (dryRun) {
              console.log(chalk.bold("kspec Setup Summary\n"));

              for (const step of result.steps) {
                const icon =
                  step.status === "done"
                    ? chalk.green("✓")
                    : step.status === "skipped"
                      ? chalk.gray("○")
                      : chalk.red("✗");
                const statusText =
                  step.status === "done"
                    ? ""
                    : step.status === "skipped"
                      ? chalk.gray(" (skipped)")
                      : chalk.red(" (failed)");

                console.log(`${icon} ${step.name}${statusText}`);
                if (step.message) {
                  console.log(chalk.gray(`  ${step.message}`));
                }
              }
            }

            console.log();

            if (dryRun) {
              console.log(
                chalk.yellow("Run without --dry-run to apply changes."),
              );
            } else {
              console.log(
                chalk.green("Setup complete."),
              );
              console.log(
                chalk.gray("Restart your agent session for changes to take effect."),
              );
            }

            const configureAuthorStep = result.steps.find(
              (step) => step.name === "Configure author",
            );
            const needsManualInstructions =
              configureAuthorStep?.status === "skipped" &&
              !configureAuthorStep.message?.includes("already set") &&
              (detected.type === "unknown" || detected.type === "droid");

            if (needsManualInstructions) {
              printManualInstructions(detected.type);
            }
          },
        );
      } catch (err) {
        error(errors.failures.setupFailed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
