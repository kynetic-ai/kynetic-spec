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
import { getWorkingDirectoryOverride, initContext } from "../parser/yaml.js";
import { isBatchMode } from "./batch-context.js";
import {
  registerAgentCommands,
  registerAgentsCommands,
  registerBatchCommand,
  registerCloneForTestingCommand,
  registerCoverageCommands,
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
  registerRefsCommand,
  registerReleaseNotesCommand,
  registerReviewCommands,
  registerScheduleCommands,
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
  registerUpgradeCommand,
  registerUtilCommands,
  registerValidateCommand,
  registerWorkflowCommand,
} from "./commands/index.js";
import { EXIT_CODES } from "./exit-codes.js";
import { getVerboseMode, setJsonMode, setVerboseMode, setYamlMode } from "./output.js";
import { COMMAND_ALIASES, findClosestCommand, getAllCommands } from "./suggest.js";
import { isNoDaemonModeEnabled, PidFileManager } from "./pid-utils.js";
import { getAlwaysSyncAnnotation, getMutatingAnnotation } from "./command-annotations.js";
import { setSyncMode, clearSyncMode } from "./sync-mode.js";
import { spawn } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { acquireFileLock, type FileLockAcquireInfo } from "../parser/file-lock.js";
import { rollbackDirtyShadowWorktree } from "../agent-runtime/workspace.js";
import { shouldProxyCommand, proxyCommand, extractCommandPayload } from "./daemon-proxy.js";
import { buildDaemonChildEnv } from "./commands/serve.js";

// Initialize verbose mode getter for shadow operations
setVerboseModeGetter(getVerboseMode);

// Track if we've already shown the manifest daemon deprecation warning this session
let manifestDaemonWarningShown = false;
let heldMutationLockRelease: ((() => Promise<void>) & { info: FileLockAcquireInfo }) | null = null;
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
  const timeoutMs = timeoutRaw && Number.isFinite(Number(timeoutRaw)) ? Number(timeoutRaw) : 0;

  try {
    heldMutationLockRelease = await acquireFileLock(lockFile, timeoutMs);
    heldMutationLockPath = lockFile;

    // AC: @scoped-dispatch-shadow-serialization ac-11 — when the CLI
    // force-reclaims the lock from an alive-but-stuck holder, the shadow
    // worktree may contain uncommitted dirty state from the previous holder's
    // interrupted write. Roll it back before proceeding with the CLI mutation.
    if (heldMutationLockRelease.info.forceReclaimed) {
      await rollbackDirtyShadowWorktree(process.cwd(), "cli", heldMutationLockRelease.info);
    }
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
 * Resolve the top-level command name from a Commander action command.
 * Commander's actionCommand.name() returns the leaf subcommand (e.g. "start"
 * for "kspec serve start"). This walks the parent chain to find the first
 * command below the root program, so skip-list checks match top-level names.
 * AC: @config-daemon ac-8
 */
function getTopLevelCommandName(actionCommand: Command): string {
  let cmd = actionCommand;
  while (cmd.parent && cmd.parent.parent) {
    cmd = cmd.parent;
  }
  return cmd.name();
}

/**
 * Auto-start daemon if configured and not already running
 * AC: @daemon-server (implicit auto-start behavior)
 * AC: @config-daemon ac-3 — uses config.daemon.auto_start
 * AC: @config-daemon ac-4 — deprecation warning for manifest daemon block
 */
async function maybeAutoStartDaemon(): Promise<void> {
  try {
    // AC: @config-daemon ac-7 — suppress auto-start in dispatch agent sessions
    if (process.env.KSPEC_SESSION_ID) {
      return;
    }

    // Load context to get daemon config from kspec.config.yaml
    const context = await initContext();
    const daemonConfig = context.config.daemon;

    // AC: @config-daemon ac-4 — emit deprecation warning if manifest has daemon block
    if (context.manifest?.daemon && !manifestDaemonWarningShown) {
      manifestDaemonWarningShown = true;
      console.error(chalk.yellow('Warning: Manifest "daemon" block is deprecated.'));
      console.error(chalk.yellow("  Migrate to kspec.config.yaml:"));
      console.error(chalk.gray("    daemon:"));
      console.error(chalk.gray(`      port: ${context.manifest.daemon.port ?? 3456}`));
      console.error(chalk.gray(`      auto_start: ${context.manifest.daemon.auto_start ?? true}`));
    }

    // AC: @config-daemon ac-3 — auto_start from config (defaults to true)
    if (!daemonConfig.auto_start) {
      return;
    }

    // AC: @multi-directory-daemon ac-32
    if (isNoDaemonModeEnabled()) {
      return;
    }

    // AC: @config-daemon ac-1 — port from config (defaults to 3456)
    const port = daemonConfig.port;

    // Check if daemon is already running (global config path, not project specDir)
    const pidManager = new PidFileManager();

    if (pidManager.isDaemonRunning()) {
      // Already running, nothing to do
      return;
    }

    // Get path to daemon entry point - resolve relative to installed package
    const packageRoot = join(import.meta.dirname, "../../");
    const daemonBinary = join(packageRoot, "dist/daemon/index.js");
    if (!existsSync(daemonBinary)) {
      // Daemon not available, skip silently
      return;
    }

    // Start daemon in background using configured runtime rather than inheriting the CLI runtime.
    // AC: @daemon-network-endpoint-contract ac-configured-bind-host
    // AC: @config-daemon ac-connect-host-config
    // AC: @daemon-network-endpoint-contract ac-default-ipv6-fallback
    // Forward the resolved bind host, explicit-config flag, and connect host
    // so the auto-started daemon honors the same endpoint configuration that
    // `kspec serve start` uses. Without these, an auto-start under a project
    // configured with daemon.host, KSPEC_DAEMON_HOST, or daemon.connect_host
    // would spawn on the wrong host and write metadata for the wrong endpoint.
    const daemonArgs: string[] = [
      daemonBinary,
      "--port",
      String(port),
      "--kspec-dir",
      context.specDir,
      "--host",
      daemonConfig.host,
    ];
    if (daemonConfig.host_explicitly_configured) {
      daemonArgs.push("--host-explicit");
    }
    if (daemonConfig.connect_host) {
      daemonArgs.push("--connect-host", daemonConfig.connect_host);
    }
    const child = spawn(daemonConfig.runtime, daemonArgs, {
      detached: true,
      stdio: "ignore",
      cwd: process.cwd(),
      env: buildDaemonChildEnv(daemonConfig.runtime),
    });

    // Detach from parent
    child.unref();

    // Don't wait for daemon to start - let it happen in background
  } catch {
    // Errors during auto-start are non-fatal - continue with command
  }
}

function showRemovedRalphCommandError(): never {
  const header = chalk.red("✗ kspec ralph has been replaced by kspec agent");
  const msg = [
    chalk.red("error: unknown command 'ralph'"),
    "",
    header,
    "",
    `${chalk.bold("kspec ralph has been removed.")} Use ${chalk.cyan("kspec agent")} for equivalent functionality.`,
    "",
    chalk.bold("Equivalent commands:"),
    `  ${chalk.yellow("kspec ralph run")}      → ${chalk.cyan("kspec agent dispatch start")}`,
    `  ${chalk.yellow("kspec ralph --dry-run")} → ${chalk.cyan("kspec agent dispatch start --dry-run")}`,
    `  ${chalk.yellow("kspec ralph end-loop")} → ${chalk.cyan("kspec agent end-loop")}`,
    "",
    chalk.bold("Getting started:"),
    `  List configured agents:  ${chalk.cyan("kspec agent list")}`,
    `  Run a specific agent:    ${chalk.cyan("kspec agent run <agent-id>")}`,
    `  Start dispatch engine:   ${chalk.cyan("kspec agent dispatch start")}`,
    `  Check dispatch status:   ${chalk.cyan("kspec agent dispatch status")}`,
    "",
    `Run ${chalk.cyan("kspec setup")} to create built-in worker and reviewer agent definitions.`,
    `Run ${chalk.cyan("kspec agent --help")} for full documentation.`,
  ].join("\n");

  process.stderr.write(`${msg}\n`);
  process.exit(EXIT_CODES.ERROR);
}

function configureProgram(program: Command): Command {
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
    // AC: @cli-daemon-proxy ac-force-proxy — require daemon routing
    .option("--daemon", "Require daemon routing (fail if daemon is unavailable)")
    .hook("preAction", async (thisCommand, actionCommand) => {
      if (isBatchMode()) return;

      const opts = thisCommand.opts();
      const formatFlags = [];
      if (opts.json) formatFlags.push("--json");
      if (opts.yaml) formatFlags.push("--yaml");
      if (opts.raw) formatFlags.push("--raw");

      if (formatFlags.length > 1) {
        console.error(chalk.red(`error: Conflicting format options: ${formatFlags.join(", ")}`));
        console.error(chalk.gray("Use only one of: --json, --yaml, --raw"));
        process.exit(EXIT_CODES.ERROR);
      }

      if (opts.json || opts.raw) {
        setJsonMode(true);
      } else if (opts.yaml) {
        setYamlMode(true);
      }

      if (opts.debugShadow) {
        setVerboseMode(true);
      }

      const isAlwaysSync = getAlwaysSyncAnnotation(actionCommand);
      const isMutating = getMutatingAnnotation(actionCommand);

      if (isAlwaysSync) {
        setSyncMode("always");
      } else if (isMutating) {
        setSyncMode("skip");
      } else {
        setSyncMode("drift-check");
      }

      const proxySkipCommands = new Set([
        "init",
        "serve",
        "help",
        "setup",
        "upgrade",
        "release-notes",
        "shadow",
        "doctor",
        "clone-for-testing",
        "batch",
        "agent",
        "event",
      ]);

      let shouldSkipProxy = false;
      {
        let cmd: typeof actionCommand | null | undefined = actionCommand;
        while (cmd && typeof cmd.name === "function") {
          const name = cmd.name();
          if (name && name !== "kspec" && proxySkipCommands.has(name)) {
            shouldSkipProxy = true;
            break;
          }
          cmd = cmd.parent as typeof actionCommand | null | undefined;
        }
      }

      if (!shouldSkipProxy) {
        const proxyResult = await shouldProxyCommand({
          forceDaemon: opts.daemon,
        });

        if (proxyResult.proxy) {
          const { command, args: cmdArgs } = extractCommandPayload(actionCommand);

          const currentWorkingDirectory = getWorkingDirectoryOverride() ?? process.cwd();
          let projectPath: string;
          try {
            projectPath = path.resolve(currentWorkingDirectory);
          } catch {
            projectPath = currentWorkingDirectory;
          }

          const result = await proxyCommand({
            endpoint: proxyResult.endpoint,
            command,
            args: cmdArgs,
            projectPath,
            isMutating,
          });

          if (result.ok) {
            if (result.result.stdout) {
              process.stdout.write(result.result.stdout);
            }
            if (result.result.stderr) {
              process.stderr.write(result.result.stderr);
            }
            process.exit(result.result.exitCode);
          } else if (result.fallbackToDirectMode) {
            console.error(chalk.yellow(`⚠ ${result.error}`));
          } else {
            console.error(chalk.red(`error: ${result.error}`));
            if (opts.daemon) {
              console.error(
                chalk.gray(
                  "Suggested action: start the daemon with 'kspec serve start', or remove --daemon to allow direct mode.",
                ),
              );
            } else {
              console.error(
                chalk.gray(
                  "Suggested action: check daemon status with 'kspec serve status' or restart with 'kspec serve restart'.",
                ),
              );
            }
            process.exit(EXIT_CODES.ERROR);
          }
        } else if (opts.daemon && proxyResult.reason) {
          console.error(chalk.red(`error: ${proxyResult.reason}`));
          console.error(
            chalk.gray(
              "Suggested action: start the daemon with 'kspec serve start', or remove --daemon to allow direct mode.",
            ),
          );
          process.exit(EXIT_CODES.ERROR);
        }
      }

      await maybeAcquireDispatchMutationLock(isMutating);

      const skipCommands = ["init", "serve", "help", "kspec"];
      const topLevelName = getTopLevelCommandName(actionCommand);

      if (!skipCommands.includes(topLevelName)) {
        await maybeAutoStartDaemon();
      }
    })
    .hook("postAction", async () => {
      clearSyncMode();

      if (heldMutationLockRelease) {
        const release = heldMutationLockRelease;
        heldMutationLockRelease = null;
        heldMutationLockPath = null;
        await release();
      }
    });

  registerTasksCommands(program);
  registerTaskCommands(program);
  registerSetupCommand(program);
  registerSessionCommands(program);
  registerInitCommand(program);

  registerItemCommands(program);
  const itemCmd = program.commands.find((cmd) => cmd.name() === "item");
  if (itemCmd) {
    registerItemTraitCommands(itemCmd);
  }

  registerTraitCommands(program);
  registerValidateCommand(program);
  registerHelpCommand(program);
  registerDoctorCommand(program);
  registerCoverageCommands(program);
  registerDeriveCommand(program);
  registerInboxCommands(program);
  registerTriageCommands(program);
  registerShadowCommands(program);
  registerLogCommand(program);
  registerSearchCommand(program);
  registerRefsCommand(program);
  registerServeCommands(program);
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
  registerScheduleCommands(program);
  registerAgentsCommands(program);
  registerAgentCommands(program);
  registerUpgradeCommand(program);
  registerReleaseNotesCommand(program);

  program.on("command:*", (operands) => {
    const unknownCommand = operands[0];

    if (unknownCommand === "ralph") {
      showRemovedRalphCommandError();
    }

    if (COMMAND_ALIASES[unknownCommand]) {
      console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
      console.error(chalk.yellow(`Did you mean: kspec ${COMMAND_ALIASES[unknownCommand]}?`));
      process.exit(EXIT_CODES.ERROR);
    }

    const allCommands = getAllCommands(program);
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

  return program;
}

export function createProgram(): Command {
  return configureProgram(new Command());
}

const program = createProgram();

// Export program for introspection (used by help command)
export { program };

// Parse and execute (only when run directly)
// Use realpathSync to resolve symlinks (e.g., when run via npm link)
const scriptPath = realpathSync(process.argv[1]);
if (import.meta.url === `file://${scriptPath}`) {
  program.parse();
}
