import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { success, error, warn } from '../output.js';

/**
 * Supported agent types for auto-configuration
 */
export type AgentType =
  | 'claude-code'
  | 'cline'
  | 'roo-code'
  | 'copilot-cli'
  | 'gemini-cli'
  | 'codex-cli'
  | 'aider'
  | 'opencode'
  | 'amp'
  | 'unknown';

/**
 * Result of agent detection
 */
export interface DetectedAgent {
  type: AgentType;
  confidence: 'high' | 'medium' | 'low';
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
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_PROJECT_DIR) {
    return {
      type: 'claude-code',
      confidence: 'high',
      configPath: path.join(os.homedir(), '.claude', 'settings.json'),
      envVars: {
        ...(process.env.CLAUDECODE && { CLAUDECODE: process.env.CLAUDECODE }),
        ...(process.env.CLAUDE_CODE_ENTRYPOINT && { CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT }),
        ...(process.env.CLAUDE_PROJECT_DIR && { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR }),
      },
    };
  }

  // Cline: CLINE_ACTIVE is set when running in Cline terminal
  if (process.env.CLINE_ACTIVE) {
    return {
      type: 'cline',
      confidence: 'high',
      // Cline uses VS Code settings, but env vars should be in shell profile
      configPath: undefined,
      envVars: { CLINE_ACTIVE: process.env.CLINE_ACTIVE },
    };
  }

  // GitHub Copilot CLI: Check for copilot-specific markers
  if (process.env.COPILOT_MODEL || process.env.GH_TOKEN) {
    return {
      type: 'copilot-cli',
      confidence: 'medium',
      configPath: path.join(os.homedir(), '.copilot', 'config.json'),
    };
  }

  // Aider: Check for AIDER_* env vars
  if (process.env.AIDER_MODEL || process.env.AIDER_DARK_MODE !== undefined) {
    return {
      type: 'aider',
      confidence: 'high',
      configPath: path.join(os.homedir(), '.aider.conf.yml'),
    };
  }

  // OpenCode: Check for OPENCODE_* env vars
  if (process.env.OPENCODE_CONFIG_DIR || process.env.OPENCODE_CONFIG) {
    return {
      type: 'opencode',
      confidence: 'high',
      configPath: process.env.OPENCODE_CONFIG || path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    };
  }

  // Gemini CLI: GEMINI_CLI=1 is set when running in Gemini CLI
  if (process.env.GEMINI_CLI === '1') {
    return {
      type: 'gemini-cli',
      confidence: 'high',
      configPath: path.join(os.homedir(), '.gemini', 'settings.json'),
      envVars: { GEMINI_CLI: '1' },
    };
  }

  // Codex CLI: CODEX_SANDBOX is set when running in sandbox
  if (process.env.CODEX_SANDBOX) {
    return {
      type: 'codex-cli',
      confidence: 'high',
      configPath: path.join(os.homedir(), '.codex', 'config.toml'),
      envVars: { CODEX_SANDBOX: process.env.CODEX_SANDBOX },
    };
  }

  // Amp (Sourcegraph): Check for AMP_API_KEY or AMP_TOOLBOX
  if (process.env.AMP_API_KEY || process.env.AMP_TOOLBOX) {
    return {
      type: 'amp',
      confidence: 'medium',
      configPath: path.join(os.homedir(), '.config', 'amp', 'settings.json'),
    };
  }

  return {
    type: 'unknown',
    confidence: 'low',
  };
}

/**
 * Install KSPEC_AUTHOR config for Claude Code (global settings)
 */
async function installClaudeCodeConfig(author: string): Promise<boolean> {
  const configPath = path.join(os.homedir(), '.claude', 'settings.json');
  const configDir = path.dirname(configPath);

  try {
    // Ensure directory exists
    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or invalid JSON, start fresh
    }

    // Merge env settings
    const env = (config.env as Record<string, string>) || {};
    env.KSPEC_AUTHOR = author;
    config.env = env;

    // Write back
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Install stop hook to project-level Claude Code settings (.claude/settings.json)
 */
async function installClaudeCodeStopHook(projectDir: string): Promise<boolean> {
  const configPath = path.join(projectDir, '.claude', 'settings.json');
  const configDir = path.dirname(configPath);

  try {
    // Ensure directory exists
    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh
    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(existing);
    } catch {
      // File doesn't exist or invalid JSON, start fresh
    }

    // Build the stop hook command
    const stopHookCommand = 'npx tsx src/cli/index.ts session checkpoint --json';

    // Get or create hooks object
    const hooks = (config.hooks as Record<string, unknown[]>) || {};

    // Check if Stop hook already exists with our command
    const existingStopHooks = hooks.Stop as Array<{ matcher?: object; hooks?: Array<{ command?: string }> }> | undefined;
    const alreadyInstalled = existingStopHooks?.some(
      (entry) => entry.hooks?.some((hook) => hook.command?.includes('session checkpoint'))
    );

    if (alreadyInstalled) {
      return true; // Already configured
    }

    // Add our stop hook using Claude Code hooks format
    // Note: matcher field is required even if empty string
    hooks.Stop = [
      ...(existingStopHooks || []),
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: stopHookCommand,
          },
        ],
      },
    ];
    config.hooks = hooks;

    // Write back
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
  const configPath = path.join(os.homedir(), '.aider.conf.yml');

  try {
    let content = '';
    try {
      content = await fs.readFile(configPath, 'utf-8');
    } catch {
      // File doesn't exist, start fresh
    }

    // Check if KSPEC_AUTHOR is already set
    if (content.includes('KSPEC_AUTHOR')) {
      // Replace existing value (handles both old and new format)
      content = content.replace(/^(\s*-?\s*KSPEC_AUTHOR\s*[=:]\s*).*$/m, `  - KSPEC_AUTHOR=${author}`);
    } else {
      // Add to set-env section or create it
      if (content.includes('set-env:')) {
        // Append to existing set-env section
        content = content.replace(/(set-env:\s*\n)/m, `$1  - KSPEC_AUTHOR=${author}\n`);
      } else {
        // Add new set-env section
        content += `\n# kspec author for note attribution\nset-env:\n  - KSPEC_AUTHOR=${author}\n`;
      }
    }

    await fs.writeFile(configPath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Install KSPEC_AUTHOR for generic JSON config files
 */
async function installGenericJsonConfig(configPath: string, author: string): Promise<boolean> {
  try {
    const configDir = path.dirname(configPath);
    await fs.mkdir(configDir, { recursive: true });

    let config: Record<string, unknown> = {};
    try {
      const existing = await fs.readFile(configPath, 'utf-8');
      config = JSON.parse(existing);
    } catch {
      // Start fresh
    }

    const env = (config.env as Record<string, string>) || {};
    env.KSPEC_AUTHOR = author;
    config.env = env;

    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
    case 'claude-code':
      return '@claude';
    case 'cline':
      return '@cline';
    case 'roo-code':
      return '@roo';
    case 'copilot-cli':
      return '@copilot';
    case 'gemini-cli':
      return '@gemini';
    case 'codex-cli':
      return '@codex';
    case 'aider':
      return '@aider';
    case 'opencode':
      return '@opencode';
    case 'amp':
      return '@amp';
    default:
      return '@agent';
  }
}

/**
 * Print manual setup instructions
 */
function printManualInstructions(agentType: AgentType): void {
  const author = getDefaultAuthor(agentType);

  console.log('\nManual setup instructions:\n');

  switch (agentType) {
    case 'claude-code':
      console.log('Add to ~/.claude/settings.json:');
      console.log('```json');
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log('```');
      break;

    case 'cline':
    case 'roo-code':
      console.log('Add to your shell profile (~/.bashrc, ~/.zshrc):');
      console.log('```bash');
      console.log(`export KSPEC_AUTHOR="${author}"`);
      console.log('```');
      console.log('\nThis will be inherited by terminals spawned by the VS Code extension.');
      break;

    case 'copilot-cli':
      console.log('Add to ~/.copilot/config.json:');
      console.log('```json');
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log('```');
      break;

    case 'aider':
      console.log('Add to ~/.aider.conf.yml:');
      console.log('```yaml');
      console.log('set-env:');
      console.log(`  - KSPEC_AUTHOR=${author}`);
      console.log('```');
      break;

    case 'codex-cli':
      console.log('Add to ~/.codex/config.toml:');
      console.log('```toml');
      console.log('[shell_environment_policy]');
      console.log(`set = { KSPEC_AUTHOR = "${author}" }`);
      console.log('```');
      break;

    case 'opencode':
      console.log('Add to ~/.config/opencode/opencode.json:');
      console.log('```json');
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log('```');
      break;

    case 'amp':
      console.log('Add to ~/.config/amp/settings.json:');
      console.log('```json');
      console.log(JSON.stringify({ env: { KSPEC_AUTHOR: author } }, null, 2));
      console.log('```');
      break;

    default:
      console.log('Set the KSPEC_AUTHOR environment variable:');
      console.log('```bash');
      console.log(`export KSPEC_AUTHOR="${author}"`);
      console.log('```');
      console.log('\nOr add to your shell profile (~/.bashrc, ~/.zshrc, etc.)');
  }
}

/**
 * Register the 'setup' command
 */
export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Configure agent environment for kspec')
    .option('--dry-run', 'Show what would be done without making changes')
    .option('--author <author>', 'Custom author string (default: auto-detected based on agent)')
    .option('--no-hooks', 'Skip installing Claude Code stop hook')
    .option('--force', 'Overwrite existing configuration')
    .action(async (options) => {
      try {
        const detected = detectAgent();
        const projectDir = process.cwd();

        console.log(`Detected agent: ${detected.type} (confidence: ${detected.confidence})`);

        if (detected.type === 'unknown') {
          warn('Could not auto-detect agent environment');
          printManualInstructions('unknown');
          return;
        }

        const author = options.author || getDefaultAuthor(detected.type);
        const installHooks = options.hooks !== false && detected.type === 'claude-code';

        if (options.dryRun) {
          console.log(`\nWould configure:`);
          console.log(`  Agent: ${detected.type}`);
          console.log(`  Author: ${author}`);
          if (detected.configPath) {
            console.log(`  Global config: ${detected.configPath}`);
          }
          if (installHooks) {
            console.log(`  Project config: ${path.join(projectDir, '.claude', 'settings.json')}`);
            console.log(`  Stop hook: kspec session checkpoint`);
          }
          return;
        }

        // Check if already configured
        if (!options.force && process.env.KSPEC_AUTHOR) {
          warn(`KSPEC_AUTHOR is already set to "${process.env.KSPEC_AUTHOR}"`);
          console.log('Use --force to overwrite');
          return;
        }

        // Install config based on agent type
        let installed = false;
        let hooksInstalled = false;

        switch (detected.type) {
          case 'claude-code':
            installed = await installClaudeCodeConfig(author);
            if (installHooks) {
              hooksInstalled = await installClaudeCodeStopHook(projectDir);
            }
            break;

          case 'aider':
            installed = await installAiderConfig(author);
            break;

          case 'cline':
          case 'roo-code':
            // These VS Code extensions use shell env vars, not config files
            // Can't auto-install, must print instructions
            printManualInstructions(detected.type);
            return;

          case 'copilot-cli':
          case 'gemini-cli':
          case 'opencode':
          case 'amp':
            if (detected.configPath) {
              installed = await installGenericJsonConfig(detected.configPath, author);
            }
            break;

          case 'codex-cli':
            // Codex uses TOML config, would need special handling
            // For now, print manual instructions
            printManualInstructions(detected.type);
            return;
        }

        if (installed) {
          success(`Configured ${detected.type} with KSPEC_AUTHOR="${author}"`, {
            agent: detected.type,
            author,
            configPath: detected.configPath,
          });

          if (hooksInstalled) {
            success(`Installed stop hook to .claude/settings.json`, {
              hook: 'Stop',
              command: 'kspec session checkpoint',
            });
          }

          console.log('\nRestart your agent session for changes to take effect.');
        } else {
          error(`Failed to install config for ${detected.type}`);
          printManualInstructions(detected.type);
        }
      } catch (err) {
        error('Setup failed', err);
        process.exit(1);
      }
    });
}
