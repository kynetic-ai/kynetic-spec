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

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json at runtime
const require = createRequire(import.meta.url);
const { version } = require("../../../package.json");

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
    } catch {
      // File doesn't exist or invalid JSON, start fresh
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
  } catch (_err) {
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

# Block deleting kspec-meta from anywhere
if [[ "$COMMAND" == *"git branch -d kspec-meta"* || "$COMMAND" == *"git branch -D kspec-meta"* ]]; then
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
  if [[ "$COMMAND" == *"$pattern"* ]]; then
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
    } catch {
      // File doesn't exist or invalid JSON, start fresh
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
      // Create guard script files
      for (const [name, content] of Object.entries(GUARD_SCRIPTS)) {
        const scriptPath = path.join(hooksDir, name);
        if (!dryRun) {
          await fs.writeFile(scriptPath, content, { mode: 0o755 });
        }
        result.guardsCreated.push(name);
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
  } catch {
    return result;
  }
}

/**
 * Install stop hook to project-level Claude Code settings (.claude/settings.json)
 * @deprecated Use installClaudeCodeHooks instead
 */
async function _installClaudeCodeStopHook(
  projectDir: string,
): Promise<boolean> {
  const configPath = path.join(projectDir, ".claude", "settings.json");
  const configDir = path.dirname(configPath);

  try {
    // Ensure directory exists
    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, "utf-8");
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or invalid JSON, start fresh
    }

    // Build the stop hook command
    const stopHookCommand = "npx kspec session checkpoint --json";

    // Get or create hooks object
    const hooks = (config.hooks as Record<string, unknown[]>) || {};

    // Check if Stop hook already exists with our command
    const existingStopHooks = hooks.Stop as
      | Array<{ matcher?: object; hooks?: Array<{ command?: string }> }>
      | undefined;
    const alreadyInstalled = existingStopHooks?.some((entry) =>
      entry.hooks?.some((hook) => hook.command?.includes("session checkpoint")),
    );

    if (alreadyInstalled) {
      return true; // Already configured
    }

    // Add our stop hook using Claude Code hooks format
    // Note: matcher field is required even if empty string
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
    config.hooks = hooks;

    // Write back
    await fs.writeFile(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf-8",
    );
    return true;
  } catch {
    return false;
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
    } catch {
      // File doesn't exist, start fresh
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
  } catch {
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
    } catch {
      // Start fresh
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
  } catch {
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
  agentsMd: {
    exists: boolean;
    status: "current" | "stale" | "missing";
    generatedAt?: string;
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
  } catch {
    // Config doesn't exist or is invalid
  }

  // Check guard scripts
  try {
    const guardFiles = await fs.readdir(hooksDir);
    for (const name of Object.keys(GUARD_SCRIPTS)) {
      if (guardFiles.includes(name)) {
        hooks.guardsPresent.push(name);
      }
    }
  } catch {
    // Hooks dir doesn't exist
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
        } catch {
          // SKILL.md doesn't exist
        }
      }
    }
  } catch {
    // Skills dir doesn't exist
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
      agentsMd.status = "current"; // We can't verify staleness without meta context
      agentsMd.generatedAt = hashData.generatedAt;
    } catch {
      agentsMd.status = "stale";
    }
  } catch {
    // File doesn't exist
  }

  return {
    agent: {
      detected: detected.type,
      confidence: detected.confidence,
    },
    hooks,
    skills,
    agentsMd,
  };
}

/**
 * Render skills using the skill rendering library
 * AC: @enhanced-setup ac-3
 */
async function renderSkillsForSetup(
  projectDir: string,
  dryRun: boolean,
): Promise<{ rendered: number; skipped: number; skillIds: string[] }> {
  // Dynamically import to avoid circular dependencies
  const { initContext, loadMetaContext, loadSkillContent } = await import(
    "../../parser/index.js"
  );
  const { renderClaudeCodeSkill } = await import("../../parser/skill-render.js");

  try {
    const ctx = await initContext();

    if (!ctx.manifestPath) {
      return { rendered: 0, skipped: 0, skillIds: [] };
    }

    const metaCtx = await loadMetaContext(ctx);
    const skillsToRender = metaCtx.skills.filter((s) =>
      s.platforms.includes("claude-code"),
    );

    if (skillsToRender.length === 0) {
      return { rendered: 0, skipped: 0, skillIds: [] };
    }

    let rendered = 0;
    let skipped = 0;
    const skillIds: string[] = [];

    for (const skill of skillsToRender) {
      const result = await renderClaudeCodeSkill(ctx, projectDir, skill, {
        dryRun,
      });
      if (result.action === "created" || result.action === "updated") {
        rendered++;
        skillIds.push(skill.id);
      } else {
        skipped++;
      }
    }

    return { rendered, skipped, skillIds };
  } catch {
    return { rendered: 0, skipped: 0, skillIds: [] };
  }
}

/**
 * Generate kspec-agents.md
 * AC: @enhanced-setup ac-4
 */
async function generateAgentInstructions(
  projectDir: string,
  dryRun: boolean,
): Promise<{ success: boolean; path: string }> {
  const outputPath = path.join(projectDir, "kspec-agents.md");
  const hashPath = path.join(projectDir, ".kspec", ".kspec-agents-hash");

  // Dynamically import to avoid circular dependencies
  const {
    initContext,
    loadMetaContext,
    generateSkillsTable,
    generateConventionsSummary,
    generateWorkflowsSummary,
  } = await import("../../parser/index.js");

  try {
    const ctx = await initContext();

    if (!ctx.manifestPath) {
      return { success: false, path: outputPath };
    }

    const metaCtx = await loadMetaContext(ctx);
    const timestamp = new Date().toISOString();

    // Load template sections
    const packageRoot = path.resolve(__dirname, "..", "..", "..");
    const templatesPath = path.join(packageRoot, "templates", "agents-sections");
    const templateSections: string[] = [];

    try {
      const entries = await fs.readdir(templatesPath, { withFileTypes: true });
      const mdFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort();

      for (const filename of mdFiles) {
        const filePath = path.join(templatesPath, filename);
        const content = await fs.readFile(filePath, "utf-8");
        templateSections.push(content.trim());
      }
    } catch {
      // Templates not available
    }

    // Generate content
    const sections: string[] = [];
    sections.push(
      `<!-- Generated by kspec v${version} at ${timestamp} -->\n`,
    );
    sections.push(
      "<!-- Do not edit manually - regenerate with: kspec agents generate -->\n\n",
    );
    sections.push("# kspec Agent Instructions\n\n");
    sections.push(
      "This file is auto-generated from kspec meta. Include it in your AGENTS.md or similar agent instruction file.\n\n",
    );

    const skillsTable = generateSkillsTable(metaCtx.skills);
    if (skillsTable) sections.push(skillsTable);

    const conventionsSection = generateConventionsSummary(metaCtx.conventions);
    if (conventionsSection) sections.push(conventionsSection);

    const workflowsSection = generateWorkflowsSummary(metaCtx.workflows);
    if (workflowsSection) sections.push(workflowsSection);

    if (templateSections.length > 0) {
      sections.push("\n");
      for (const section of templateSections) {
        sections.push(section);
        sections.push("\n\n");
      }
    }

    const content = sections.join("");

    if (!dryRun) {
      await fs.writeFile(outputPath, content, "utf-8");

      // Write hash for freshness tracking
      const metaHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify({
            skills: metaCtx.skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
            })),
            conventions: metaCtx.conventions.map((c) => ({
              domain: c.domain,
              rules: c.rules,
            })),
            workflows: metaCtx.workflows.map((w) => ({
              id: w.id,
              trigger: w.trigger,
              description: w.description,
            })),
          }),
        )
        .digest("hex");

      await fs.mkdir(path.dirname(hashPath), { recursive: true });
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
  } catch {
    return { success: false, path: outputPath };
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

            // Agents.md status
            console.log(chalk.gray("kspec-agents.md:"));
            if (status.agentsMd.exists) {
              const statusColor =
                status.agentsMd.status === "current"
                  ? chalk.green
                  : chalk.yellow;
              console.log(`  Status: ${statusColor(status.agentsMd.status)}`);
              if (status.agentsMd.generatedAt) {
                console.log(`  Generated: ${status.agentsMd.generatedAt}`);
              }
            } else {
              console.log(`  Status: ${chalk.red("missing")}`);
              console.log(
                chalk.gray("  Run 'kspec setup' to generate"),
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
        const skipSkills = options.skipSkills || false;
        const installHooksFlag = options.hooks !== false;

        // Track setup steps for summary
        // AC: @enhanced-setup ac-1 - summary listing each step
        const steps: SetupStepResult[] = [];

        // Step 1: Agent detection
        steps.push({
          name: "Agent detection",
          status: "done",
          message: `${detected.type} (${detected.confidence} confidence)`,
        });

        if (detected.type === "unknown") {
          warn("Could not auto-detect agent environment");
          printManualInstructions("unknown");
          return;
        }

        // Step 2: Install hooks (Claude Code only)
        // AC: @enhanced-setup ac-2 - all hook entries present
        if (detected.type === "claude-code" && installHooksFlag) {
          const hooksResult = await installClaudeCodeHooks(projectDir, dryRun);
          const installedHooks: string[] = [];
          if (hooksResult.promptCheck) installedHooks.push("UserPromptSubmit");
          if (hooksResult.stop) installedHooks.push("Stop");
          if (hooksResult.preToolUse) installedHooks.push("PreToolUse");

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
        }

        // Step 3: Render skills
        // AC: @enhanced-setup ac-3 - rendered skill files exist
        // AC: @enhanced-setup ac-5 - --skip-skills flag
        if (!skipSkills) {
          const skillsResult = await renderSkillsForSetup(projectDir, dryRun);
          if (skillsResult.rendered > 0 || skillsResult.skipped > 0) {
            steps.push({
              name: "Render skills",
              status: "done",
              message: `${skillsResult.rendered} rendered, ${skillsResult.skipped} unchanged`,
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

        // Step 4: Generate kspec-agents.md
        // AC: @enhanced-setup ac-4 - kspec-agents.md exists
        const agentsResult = await generateAgentInstructions(projectDir, dryRun);
        if (agentsResult.success) {
          steps.push({
            name: "Generate kspec-agents.md",
            status: "done",
            message: agentsResult.path,
          });
        } else {
          steps.push({
            name: "Generate kspec-agents.md",
            status: "failed",
            message: "No kspec project found",
          });
        }

        // Step 5: Install author config
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

        // AC: @enhanced-setup ac-1 - Display summary
        // AC: @enhanced-setup ac-6 - dry-run displays planned actions
        output(
          {
            dry_run: dryRun,
            steps: steps.map((s) => ({
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
