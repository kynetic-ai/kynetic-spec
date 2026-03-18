#!/usr/bin/env node

import { realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";

// Read version from package.json at runtime
// AC: @cli-version ac-2 - version automatically reflects package.json without code changes
const require = createRequire(import.meta.url);
const { version } = require("../../package.json");

import { setVerboseModeGetter } from "../parser/shadow.js";
import { initContext } from "../parser/yaml.js";
import { isBatchMode } from "./batch-context.js";
import {
  registerAgentCommands,
  registerAgentsCommands,
  registerBatchCommand,
  registerCloneForTestingCommand,
  registerDeriveCommand,
  registerDoctorCommand,
  registerEventCommands,
  registerExportCommand,
  registerGuardCommand,
  registerHelpCommand,
  registerHookCommands,
  registerInboxCommands,
  registerInitCommand,
  registerItemCommands,
  registerItemTraitCommands,
  registerLinkCommands,
  registerLogCommand,
  registerMergeDriverCommand,
  registerMetaCommands,
  registerModuleCommands,
  registerPlanCommands,
  registerRalphCommand,
  registerRefsCommand,
  registerReviewCommands,
  registerSearchCommand,
  registerServeCommands,
  registerSessionCommands,
  registerSetupCommand,
  registerShadowCommands,
  registerSkillCommands,
  registerTaskCommands,
  registerTasksCommands,
  registerTraitCommands,
  registerTriageCommands,
  registerUtilCommands,
  registerValidateCommand,
  registerWorkflowCommand,
} from "./commands/index.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  getVerboseMode,
  setJsonMode,
  setVerboseMode,
  setYamlMode,
} from "./output.js";
import {
  COMMAND_ALIASES,
  findClosestCommand,
  getAllCommands,
} from "./suggest.js";
import { PidFileManager } from "./pid-utils.js";
import { getAlwaysSyncAnnotation, getMutatingAnnotation } from "./command-annotations.js";
import { setSyncMode, clearSyncMode } from "./sync-mode.js";
import { spawn } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { acquireFileLock } from "../parser/file-lock.js";

const program = new Command();

// Initialize verbose mode getter for shadow operations
setVerboseModeGetter(getVerboseMode);

// Track if we've already shown the manifest daemon deprecation warning this session
let manifestDaemonWarningShown = false;
let heldMutationLockRelease: (() => Promise<void>) | null = null;
let heldMutationLockPath: string | null = null;

function releaseHeldMutationLockSync(): void {
  if (!heldMutationLockPath) return;
  try {
    rmSync(`${heldMutationLockPath}.lock`, { recursive: true, force: true });
  } catch {
    // Best effort cleanup on process exit
  }
}

process.once("exit", releaseHeldMutationLockSync);

async function maybeAcquireDispatchMutationLock(isMutating: boolean): Promise<void> {
  if (!isMutating || heldMutationLockRelease) return;

  const lockFile = process.env.KSPEC_SHADOW_MUTATION_LOCK_FILE;
  if (!lockFile) return;

  const timeoutRaw = process.env.KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS;
  const timeoutMs =
    timeoutRaw && Number.isFinite(Number(timeoutRaw))
      ? Number(timeoutRaw)
      : undefined;

  try {
    heldMutationLockRelease = await acquireFileLock(lockFile, timeoutMs);
    heldMutationLockPath = lockFile;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(chalk.red("error: dispatch shadow mutation lock unavailable"));
    console.error(chalk.gray(`Reason: ${reason}`));
    console.error(
      chalk.gray(
        `Suggested action: wait for the overlapping kspec mutation to finish, or remove ${path.basename(lockFile)}.lock if the lock holder is gone.`,
      ),
    );
    process.exit(EXIT_CODES.ERROR);
  }
}

/**
 * Auto-start daemon if configured and not already running
 * AC: @daemon-server (implicit auto-start behavior)
 * AC: @config-daemon ac-3 — uses config.daemon.auto_start
 * AC: @config-daemon ac-4 — deprecation warning for manifest daemon block
 */
async function maybeAutoStartDaemon(): Promise<void> {
  try {
    // Load context to get daemon config from kspec.config.yaml
    const context = await initContext();
    const daemonConfig = context.config.daemon;

    // AC: @config-daemon ac-4 — emit deprecation warning if manifest has daemon block
    if (context.manifest?.daemon && !manifestDaemonWarningShown) {
      manifestDaemonWarningShown = true;
      console.error(
        chalk.yellow('Warning: Manifest "daemon" block is deprecated.')
      );
      console.error(
        chalk.yellow('  Migrate to kspec.config.yaml:')
      );
      console.error(
        chalk.gray('    daemon:')
      );
      console.error(
        chalk.gray(`      port: ${context.manifest.daemon.port ?? 3456}`)
      );
      console.error(
        chalk.gray(`      auto_start: ${context.manifest.daemon.auto_start ?? true}`)
      );
    }

    // AC: @config-daemon ac-3 — auto_start from config (defaults to true)
    if (!daemonConfig.auto_start) {
      return;
    }

    // AC: @config-daemon ac-1 — port from config (defaults to 3456)
    const port = daemonConfig.port;

    // Check if daemon is already running
    const kspecDir = context.specDir;
    const pidManager = new PidFileManager(kspecDir);

    if (pidManager.isDaemonRunning()) {
      // Already running, nothing to do
      return;
    }

    // Get path to daemon entry point - resolve relative to installed package
    const packageRoot = join(import.meta.dirname, '../../');
    const daemonBinary = join(packageRoot, 'dist/daemon/index.js');
    if (!existsSync(daemonBinary)) {
      // Daemon not available, skip silently
      return;
    }

    // Start daemon in background using current runtime
    // Set BUN_ENV=production to prevent Bun dev mode HTML transformation
    const child = spawn(process.execPath, [daemonBinary, '--port', String(port), '--kspec-dir', kspecDir], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env: { ...process.env, BUN_ENV: 'production' },
    });

    // Detach from parent
    child.unref();

    // Don't wait for daemon to start - let it happen in background
  } catch {
    // Errors during auto-start are non-fatal - continue with command
  }
}

program
  .name("kspec")
  .description("Kynetic Spec - Structured specification format CLI")
  .version(version)
  // AC: @output-format-option ac-format-json, ac-format-yaml, ac-global-scope
  // Note: We use shorthands --json, --yaml, --raw as global options
  // --format is NOT global because it conflicts with command-specific --format options (e.g., export)
  // Commands can still use --format locally; the global behavior uses shorthands only
  .option("--json", "Output in JSON format")
  .option("--yaml", "Output in YAML format")
  .option("--raw", "Output in raw JSON format (same as --json)")
  .option("--debug-shadow", "Enable debug output for shadow operations")
  .hook("preAction", async (thisCommand, actionCommand) => {
    // Skip all hooks during batch dispatch — the batch handler manages modes itself
    if (isBatchMode()) return;

    // The actionCommand is the actual command being executed (e.g., 'export')
    const executingCommandName = actionCommand.name();

    // Check format options at top level
    const opts = thisCommand.opts();

    // AC: @output-format-option ac-conflict-error
    // Detect conflicting format shorthand specifications
    const formatFlags = [];
    if (opts.json) formatFlags.push("--json");
    if (opts.yaml) formatFlags.push("--yaml");
    if (opts.raw) formatFlags.push("--raw");

    if (formatFlags.length > 1) {
      console.error(
        chalk.red(`error: Conflicting format options: ${formatFlags.join(", ")}`)
      );
      console.error(chalk.gray("Use only one of: --json, --yaml, --raw"));
      process.exit(EXIT_CODES.ERROR);
    }

    // AC: @output-format-option ac-json-shorthand, ac-raw-shorthand, ac-yaml-shorthand
    // Set output format based on shorthand flags
    if (opts.json || opts.raw) {
      setJsonMode(true);
    } else if (opts.yaml) {
      setYamlMode(true);
    }

    if (opts.debugShadow) {
      setVerboseMode(true);
    }

    // AC: @shadow-lazy-read-sync ac-syncmode-propagation
    // AC: @shadow-write-sync ac-write-skips-read-check — mutating commands skip pre-read sync
    // Determine sync mode centrally based on command annotations
    const isAlwaysSync = getAlwaysSyncAnnotation(actionCommand);
    const isMutating = getMutatingAnnotation(actionCommand);

    if (isAlwaysSync) {
      setSyncMode("always");
    } else if (isMutating) {
      setSyncMode("skip");
    } else {
      setSyncMode("drift-check");
    }

    await maybeAcquireDispatchMutationLock(isMutating);

    // Auto-start daemon if configured and not running
    // Skip for init, serve, and help commands
    const skipCommands = ['init', 'serve', 'help', 'kspec'];

    if (!skipCommands.includes(executingCommandName)) {
      await maybeAutoStartDaemon();
    }
  })
  .hook("postAction", async () => {
    // Clear sync mode after command completes so non-Commander callers
    // (daemon, dispatch engine) that call initContext() later in the
    // same process get 'drift-check' default, not stale command state.
    clearSyncMode();

    if (heldMutationLockRelease) {
      const release = heldMutationLockRelease;
      heldMutationLockRelease = null;
      heldMutationLockPath = null;
      await release();
    }
  });

// Register command groups
registerTasksCommands(program);
registerTaskCommands(program);
registerSetupCommand(program);
registerSessionCommands(program);
registerInitCommand(program);

// Register item commands first, then add trait subcommands to it
registerItemCommands(program);
const itemCmd = program.commands.find((cmd) => cmd.name() === "item");
if (itemCmd) {
  registerItemTraitCommands(itemCmd);
}

registerTraitCommands(program);
registerValidateCommand(program);
registerHelpCommand(program);
registerDoctorCommand(program);
registerDeriveCommand(program);
registerInboxCommands(program);
registerTriageCommands(program);
registerShadowCommands(program);
registerLogCommand(program);
registerSearchCommand(program);
registerRefsCommand(program);
registerServeCommands(program);
registerRalphCommand(program);
registerMetaCommands(program);
registerLinkCommands(program);
registerModuleCommands(program);
registerPlanCommands(program);
registerReviewCommands(program);
registerCloneForTestingCommand(program);
registerWorkflowCommand(program);
registerMergeDriverCommand(program);
registerExportCommand(program);
registerGuardCommand(program);
registerHookCommands(program);
registerEventCommands(program);
registerUtilCommands(program);
registerBatchCommand(program);
registerSkillCommands(program);
registerAgentsCommands(program);
registerAgentCommands(program);

// Handle unknown commands with suggestions
program.on("command:*", (operands) => {
  const unknownCommand = operands[0];

  // Check for direct alias match
  if (COMMAND_ALIASES[unknownCommand]) {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(
      chalk.yellow(`Did you mean: kspec ${COMMAND_ALIASES[unknownCommand]}?`),
    );
    process.exit(EXIT_CODES.ERROR);
  }

  // Get all available commands
  const allCommands = getAllCommands(program);

  // Find closest match
  const suggestion = findClosestCommand(unknownCommand, allCommands);

  if (suggestion) {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(chalk.yellow(`Did you mean: kspec ${suggestion}?`));
  } else {
    console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
    console.error(chalk.gray(`Run 'kspec help' to see available commands`));
  }

  process.exit(EXIT_CODES.ERROR);
});

// Export program for introspection (used by help command)
export { program };

// Parse and execute (only when run directly)
// Use realpathSync to resolve symlinks (e.g., when run via npm link)
const scriptPath = realpathSync(process.argv[1]);
if (import.meta.url === `file://${scriptPath}`) {
  program.parse();
}
