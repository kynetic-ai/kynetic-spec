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
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import chalk from "chalk";
import type { Command } from "commander";
import {
  getGitRoot,
  getShadowStatus,
  repairShadow,
  SHADOW_BRANCH_NAME,
} from "../../parser/shadow.js";
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
  | "aider"
  | "opencode"
  | "amp"
  | "unknown";

/**
 * Result of agent detection
 */
export interface DetectedAgent {
  type: AgentType;
  confidence: "high" | "medium" | "low";
  configPath?: string;
  envVars?: Record<string, string>;
}

/**
 * Detect which agent environment we're running in.
 * Returns the detected agent type and confidence level.
 *
 * Detection priority matters - more specific markers checked first.
 */
export function detectAgent(): DetectedAgent {
  // Claude Code: Multiple possible markers
  // CLAUDECODE=1 is set in CLI sessions
  // CLAUDE_CODE_ENTRYPOINT indicates entry point (cli, etc.)
  // CLAUDE_PROJECT_DIR is set in some contexts
  if (
    process.env.CLAUDECODE === "1" ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    process.env.CLAUDE_PROJECT_DIR
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
      },
    };
  }

  // Cline: CLINE_ACTIVE is set when running in Cline terminal
  if (process.env.CLINE_ACTIVE) {
    return {
      type: "cline",
      confidence: "high",
      // Cline uses VS Code settings, but env vars should be in shell profile
      configPath: undefined,
      envVars: { CLINE_ACTIVE: process.env.CLINE_ACTIVE },
    };
  }

  // GitHub Copilot CLI: Check for copilot-specific markers
  if (process.env.COPILOT_MODEL || process.env.GH_TOKEN) {
    return {
      type: "copilot-cli",
      confidence: "medium",
      configPath: path.join(os.homedir(), ".copilot", "config.json"),
    };
  }

  // Aider: Check for AIDER_* env vars
  if (process.env.AIDER_MODEL || process.env.AIDER_DARK_MODE !== undefined) {
    return {
      type: "aider",
      confidence: "high",
      configPath: path.join(os.homedir(), ".aider.conf.yml"),
    };
  }

  // OpenCode: Check for OPENCODE_* env vars
  if (process.env.OPENCODE_CONFIG_DIR || process.env.OPENCODE_CONFIG) {
    return {
      type: "opencode",
      confidence: "high",
      configPath:
        process.env.OPENCODE_CONFIG ||
        path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    };
  }

  // Gemini CLI: GEMINI_CLI=1 is set when running in Gemini CLI
  if (process.env.GEMINI_CLI === "1") {
    return {
      type: "gemini-cli",
      confidence: "high",
      configPath: path.join(os.homedir(), ".gemini", "settings.json"),
      envVars: { GEMINI_CLI: "1" },
    };
  }

  // Codex CLI: CODEX_SANDBOX is set when running in sandbox
  if (process.env.CODEX_SANDBOX) {
    return {
      type: "codex-cli",
      confidence: "high",
      configPath: path.join(os.homedir(), ".codex", "config.toml"),
      envVars: { CODEX_SANDBOX: process.env.CODEX_SANDBOX },
    };
  }

  // Amp (Sourcegraph): Check for AMP_API_KEY or AMP_TOOLBOX
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
 * PreToolUse guard hook scripts
 * These are the shell scripts that will be installed to .claude/hooks/
 */
const GUARD_SCRIPTS: Record<string, string> = {
  "kspec-worktree-guard.sh": `#!/bin/bash
# Guard against dangerous git operations in .kspec worktree
#
# This hook prevents accidentally creating branches or switching
# branches in the .kspec worktree, which should always stay on kspec-meta.

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command from the JSON input
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# If no command, allow (not a Bash tool call)
if [ -z "$COMMAND" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Two views of the command for safe matching:
# 1. UNQUOTED: remove quote chars (keeps content) to catch split-quote
#    bypasses like: git "reset" --hard → git reset --hard
# 2. STRIPPED: remove entire quoted strings to ignore patterns in args
#    like: echo "git reset" → echo
UNQUOTED=$(echo "$COMMAND" | sed 's/["\\x27]//g')
STRIPPED=$(echo "$COMMAND" | sed -e "s/\\x27[^\\x27]*\\x27//g" -e 's/"[^"]*"//g')
# First command word (handles leading whitespace)
FIRST_CMD=$(echo "$COMMAND" | sed 's/^[[:space:]]*//' | cut -d' ' -f1)

# Block deleting kspec-meta from anywhere (check unquoted to catch bypasses)
if [[ "$UNQUOTED" == *"git branch -d kspec-meta"* || "$UNQUOTED" == *"git branch -D kspec-meta"* ]]; then
  cat <<EOF
{
  "decision": "block",
  "reason": "[kspec-worktree-guard] BLOCKED: Cannot delete kspec-meta branch. This is the main branch for the .kspec worktree."
}
EOF
  exit 0
fi

# Get cwd from hook input (not pwd - hook runs in different context)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
IN_KSPEC=false

if [[ "$CWD" == *"/.kspec"* || "$CWD" == *"/.kspec" ]]; then
  IN_KSPEC=true
fi

# Also check if command contains cd to .kspec
if [[ "$COMMAND" == *"cd "*".kspec"* || "$COMMAND" == *"cd .kspec"* ]]; then
  IN_KSPEC=true
fi

if [ "$IN_KSPEC" = false ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Dangerous patterns in .kspec (branch creation/modification/history rewriting)
# Note: "git checkout kspec-meta" is safe and allowed
DANGEROUS_PATTERNS=(
  # Branch creation
  "git checkout -b"
  "git checkout -B"
  "git branch -c"
  "git branch -C"
  "git branch -m"
  "git branch -M"
  "git switch -c"
  "git switch -C"
  "git switch --create"
  # History rewriting - these can cause conflicts with active sessions
  "git reset"
  "git rebase"
  "git cherry-pick"
  "git commit --amend"
  # Force push
  "git push --force"
  "git push -f"
  # Discarding changes
  "git stash"
  "git clean"
  "git checkout -- "
  "git restore"
)

for pattern in "\${DANGEROUS_PATTERNS[@]}"; do
  # Block if:
  # - Pattern matches UNQUOTED AND first command is "git" (catches split-quote bypasses), OR
  # - Pattern matches STRIPPED (actual command outside any quotes)
  # This allows: echo "git reset", grep "git stash" (first cmd is echo/grep, pattern not in STRIPPED)
  # This blocks: git reset, git "reset" --hard, git st'ash' (first cmd is git OR pattern in STRIPPED)
  if [[ "$STRIPPED" == *"$pattern"* ]] || { [[ "$UNQUOTED" == *"$pattern"* ]] && [[ "$FIRST_CMD" == "git" ]]; }; then
    cat <<EOF
{
  "decision": "block",
  "reason": "[kspec-worktree-guard] BLOCKED: Dangerous git operation in .kspec worktree. This worktree contains active session data and must stay on kspec-meta. Operations like reset, rebase, stash, and clean can corrupt session files."
}
EOF
    exit 0
  fi
done

# Allow all other commands
echo '{"decision": "allow"}'
`,

  "ralph-task-limit-guard.sh": `#!/bin/bash
# Ralph task limit guard - blocks task start when limit reached
#
# This hook provides hard enforcement of the --max-tasks limit.
# Ralph writes a marker file when the limit is reached; this hook
# blocks 'kspec task start' commands when that marker exists.

# Marker file location (relative to project root)
MARKER_FILE=".claude/ralph-task-limit.json"

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command from the JSON input
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# If no command, allow (not a Bash tool call)
if [ -z "$COMMAND" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Only check commands that match "kspec task start"
if [[ ! "$COMMAND" =~ kspec[[:space:]]+task[[:space:]]+start ]]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Get cwd from hook input to find marker file
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
if [ -z "$CWD" ]; then
  CWD="$PWD"
fi

# Find project root by walking up looking for .claude directory
PROJECT_ROOT="$CWD"
while [ "$PROJECT_ROOT" != "/" ]; do
  if [ -d "$PROJECT_ROOT/.claude" ]; then
    break
  fi
  PROJECT_ROOT=$(dirname "$PROJECT_ROOT")
done

if [ "$PROJECT_ROOT" = "/" ]; then
  # No .claude directory found, allow
  echo '{"decision": "allow"}'
  exit 0
fi

MARKER_PATH="$PROJECT_ROOT/$MARKER_FILE"

# Check if marker file exists
if [ ! -f "$MARKER_PATH" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Read marker file and check if active
ACTIVE=$(jq -r '.active // false' "$MARKER_PATH" 2>/dev/null)
if [ "$ACTIVE" != "true" ]; then
  echo '{"decision": "allow"}'
  exit 0
fi

# Extract limit info for error message
MAX=$(jq -r '.max // "?"' "$MARKER_PATH" 2>/dev/null)
COMPLETED=$(jq -r '.completed // "?"' "$MARKER_PATH" 2>/dev/null)

# Block the command
cat <<EOF
{
  "decision": "block",
  "reason": "[ralph-task-limit-guard] BLOCKED: Task limit reached (\${COMPLETED}/\${MAX} tasks completed this iteration). This limit was set by --max-tasks. Please wrap up current work and let the iteration end naturally. Do not attempt to start new tasks."
}
EOF
exit 0
`,
};

/**
 * Install hooks to project-level Claude Code settings (.claude/settings.json)
 * AC: @enhanced-setup ac-2 - all hook entries present
 */
async function installClaudeCodeHooks(
  projectDir: string,
  dryRun = false,
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

    // Install UserPromptSubmit hook (spec-first reminder)
    const promptCheckCommand = "kspec session prompt-check";
    const existingPromptHooks = hooks.UserPromptSubmit as
      | Array<{ hooks?: Array<{ command?: string }> }>
      | undefined;
    const promptAlreadyInstalled = existingPromptHooks?.some((entry) =>
      entry.hooks?.some((hook) =>
        hook.command?.includes("session prompt-check"),
      ),
    );

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

    // Install Stop hook (checkpoint)
    const stopHookCommand = "kspec session checkpoint --json";
    const existingStopHooks = hooks.Stop as
      | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      | undefined;
    const stopAlreadyInstalled = existingStopHooks?.some((entry) =>
      entry.hooks?.some((hook) => hook.command?.includes("session checkpoint")),
    );

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

    // AC: @enhanced-setup ac-2 - Install PreToolUse hooks with guards
    const existingPreToolUseHooks = hooks.PreToolUse as
      | Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>
      | undefined;

    // Check if our guards are already installed
    const guardHookCommands = Object.keys(GUARD_SCRIPTS).map(
      (name) => `.claude/hooks/${name}`,
    );
    const guardsAlreadyInstalled = existingPreToolUseHooks?.some((entry) =>
      entry.hooks?.some((hook) =>
        guardHookCommands.some((cmd) => hook.command?.includes(cmd)),
      ),
    );

    if (!guardsAlreadyInstalled) {
      // Create guard script files, skipping when content unchanged
      for (const [name, content] of Object.entries(GUARD_SCRIPTS)) {
        const scriptPath = path.join(hooksDir, name);
        // Check if existing script already has the same content
        let existingContent: string | null = null;
        try {
          existingContent = await fs.readFile(scriptPath, "utf-8");
        } catch (_err) {
          // File doesn't exist yet
        }
        if (existingContent !== content) {
          if (!dryRun) {
            await fs.writeFile(scriptPath, content, { mode: 0o755 });
          }
          result.guardsCreated.push(name);
        }
      }

      // Add PreToolUse hook entry
      hooks.PreToolUse = [
        ...(existingPreToolUseHooks || []),
        {
          matcher: "Bash",
          hooks: Object.keys(GUARD_SCRIPTS).map((name) => ({
            type: "command",
            command: `.claude/hooks/${name}`,
          })),
        },
      ];
      result.preToolUse = true;
    } else {
      result.preToolUse = true; // Already configured
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

  const status = await getShadowStatus(projectRoot);

  // AC: worktree-already-exists - if already valid, skip
  if (status.healthy) {
    return true;
  }

  // AC: detect-existing-repo - branch exists but worktree doesn't
  if (status.branchExists && !status.worktreeExists) {
    // AC: auto-worktree-flag - auto-create if flag set
    if (autoWorktree) {
      console.log(
        `Detected ${SHADOW_BRANCH_NAME} branch without .kspec worktree. Creating...`,
      );
      const result = await repairShadow(projectRoot);
      if (result.success) {
        success("Created .kspec worktree");
        return true;
      } else {
        error(`Failed to create worktree: ${result.error}`);
        return false;
      }
    }

    // AC: detect-existing-repo - prompt user
    const shouldCreate = await promptYesNo(
      `${SHADOW_BRANCH_NAME} branch exists but .kspec worktree is missing. Create it? (y/N)`,
    );

    if (shouldCreate) {
      console.log("Creating .kspec worktree...");
      const result = await repairShadow(projectRoot);
      if (result.success) {
        success("Created .kspec worktree");
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
  /** Custom author string (overrides auto-detected default) */
  author?: string;
  /** Whether to configure author (only in command handler, not init) */
  configureAuthor?: boolean;
}

/**
 * Status of the setup state
 * AC: @enhanced-setup ac-7, ac-8 - status reporting
 */
interface SetupStatus {
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
  plugin: {
    marketplaceRegistered: boolean;
    marketplaceHealthy: boolean;
    pluginEnabled: boolean;
    registeredPath?: string;
    healthMessage?: string;
  };
  agentsMd: {
    exists: boolean;
    // AC: @doctor-command ac-staleness-unknown — includes "unknown" for indeterminate cases
    status: "current" | "stale" | "missing" | "unknown";
    generatedAt?: string;
  };
  seeding: {
    permissionsSeeded: boolean;
    memorySeeded: boolean;
    memoryPath?: string;
  };
}

/**
 * Check the current setup status
 * AC: @enhanced-setup ac-7, ac-8
 */
async function getSetupStatus(projectDir: string): Promise<SetupStatus> {
  const detected = detectAgent();
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
    const promptHooks = hooksConfig.UserPromptSubmit as Array<{
      hooks?: Array<{ command?: string }>;
    }> | undefined;
    hooks.promptCheck = promptHooks?.some((entry) =>
      entry.hooks?.some((h) => h.command?.includes("prompt-check")),
    ) ?? false;

    // Check Stop
    const stopHooks = hooksConfig.Stop as Array<{
      hooks?: Array<{ command?: string }>;
    }> | undefined;
    hooks.stop = stopHooks?.some((entry) =>
      entry.hooks?.some((h) => h.command?.includes("checkpoint")),
    ) ?? false;

    // Check PreToolUse
    const preToolUseHooks = hooksConfig.PreToolUse as Array<{
      hooks?: Array<{ command?: string }>;
    }> | undefined;
    hooks.preToolUse = preToolUseHooks?.some((entry) =>
      entry.hooks?.some((h) => h.command?.includes(".claude/hooks/")),
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

  // Helper to scan a directory for skill subdirs with kspec-managed SKILL.md
  async function scanForSkills(baseDir: string): Promise<void> {
    try {
      const dirs = await fs.readdir(baseDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (dir.isDirectory()) {
          const skillMdPath = path.join(baseDir, dir.name, "SKILL.md");
          try {
            const content = await fs.readFile(skillMdPath, "utf-8");
            if (content.includes("<!-- kspec-managed -->")) {
              skills.total++;
              skills.rendered++;
            }
          } catch (_noSkillMd) {
            // No SKILL.md
          }
        }
      }
    } catch (_notReadable) {
      // Directory doesn't exist
    }
  }

  // Scan .claude/skills/ (project/local skills)
  await scanForSkills(skillsDir);

  // Check plugin marketplace health
  // AC: @enhanced-setup ac-7, ac-8
  const plugin: SetupStatus["plugin"] = {
    marketplaceRegistered: false,
    marketplaceHealthy: false,
    pluginEnabled: false,
  };

  try {
    const { checkMarketplaceHealth } = await import(
      "../../lib/claude-plugin-registry.js"
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
    const configContent = await fs.readFile(configPath, "utf-8");
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

      // AC: @cross-platform-and-version-robustness ac-4
      // Compare stored hash against current meta to detect staleness
      try {
        const { initContext, loadMetaContext } = await import(
          "../../parser/index.js"
        );
        const { computeMetaHash, loadTemplateSections, getPackageRoot } = await import("./agents.js");
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
            templateSections,
          );
          agentsMd.status = hashData.metaHash === currentHash ? "current" : "stale";
        } else {
          // AC: @doctor-command ac-staleness-unknown — no manifest means we can't determine staleness
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
      "utf-8",
    );
    const config = JSON.parse(configContent);
    seeding.permissionsSeeded = !!config.permissions;
  } catch (err) {
    debugLog("Could not check permissions seeding state", err);
  }

  if (detected.type === "claude-code") {
    try {
      const { claudeCodeMemoryWriter } = await import("./setup-seeding.js");
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
    plugin,
    agentsMd,
    seeding,
  };
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
      metaCtx.skills,
      metaCtx.conventions,
      metaCtx.workflows,
      timestamp,
      templateSections,
    );

    if (!dryRun) {
      // Compute meta hash for freshness tracking
      const metaHash = computeMetaHash(
        metaCtx.skills,
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

      if (storedHash === metaHash) {
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
    const detected = detectAgent();

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
    if (detected.type === "claude-code" && installHooksFlag) {
      const hooksResult = await installClaudeCodeHooks(projectDir, dryRun);
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
        message: `not applicable for ${detected.type}`,
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
    // AC: @new-project-bootstrapping ac-2
    {
      const { seedMemory } = await import("./setup-seeding.js");
      const memResult = await seedMemory(projectDir, detected.type, {
        dryRun,
        force: options.force,
      });
      memorySeeded = memResult.seeded;

      steps.push({
        name: "Seed memory",
        status: memResult.seeded ? "done" : "skipped",
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
          message: "No claude-code skills in meta",
        });
      }
    } else {
      steps.push({
        name: "Render skills",
        status: "skipped",
        message: "--skip-skills flag",
      });
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

        // AC: @enhanced-setup ac-7, ac-8 - --status mode
        if (options.status) {
          const status = await getSetupStatus(projectDir);

          output(status, () => {
            console.log(chalk.bold("kspec Setup Status\n"));

            // Agent detection
            console.log(chalk.gray("Agent:"));
            console.log(
              `  Detected: ${status.agent.detected} (${status.agent.confidence} confidence)`,
            );
            console.log();

            // Hooks status
            console.log(chalk.gray("Hooks:"));
            console.log(
              `  UserPromptSubmit: ${status.hooks.promptCheck ? chalk.green("✓") : chalk.red("✗")}`,
            );
            console.log(
              `  Stop:             ${status.hooks.stop ? chalk.green("✓") : chalk.red("✗")}`,
            );
            console.log(
              `  PreToolUse:       ${status.hooks.preToolUse ? chalk.green("✓") : chalk.red("✗")}`,
            );
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

        const detected = detectAgent();
        const dryRun = options.dryRun || false;

        if (detected.type === "unknown") {
          warn("Could not auto-detect agent environment");
          printManualInstructions("unknown");
          return;
        }

        // AC: @setup-pipeline-unification ac-3 - delegate to runSetupPipeline()
        // One code path for both 'kspec setup' and 'kspec init --setup'
        const result = await runSetupPipeline(projectDir, {
          dryRun,
          skipSkills: options.skipSkills || false,
          installHooks: options.hooks !== false,
          force: options.force || false,
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
          },
        );
      } catch (err) {
        error(errors.failures.setupFailed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
