import { execSync } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import {
  getGitRoot,
  getShadowStatus,
  hasRemoteTracking,
  repairShadow,
  remoteShadowBranchExists,
  resolveProjectRoots,
  SHADOW_BRANCH_NAME,
  SHADOW_WORKTREE_DIR,
  SESSIONS_WORKTREE_DIR,
  type ShadowStatus,
  shadowSync,
} from "../../parser/shadow.js";
import { loadProjectConfig } from "../../parser/config.js";
import {
  getSessionBranchStatus,
  repairSessionBranch,
  type SessionBranchStatus,
} from "../../parser/session-branch.js";
import { shadowCommands } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, output, success, warn } from "../output.js";

function resolveCliProjectRoot(): string | null {
  return resolveProjectRoots(process.cwd())?.mainRoot ?? getGitRoot(process.cwd());
}

/**
 * Format shadow status for display
 */
function formatShadowStatus(
  status: ShadowStatus,
  gitRoot: string,
  branchName: string,
  worktreeDir: string,
  sessionStatus?: SessionBranchStatus,
  sessionBranchName?: string,
): void {
  console.log(chalk.bold("Shadow Branch Status"));
  console.log(chalk.gray("─".repeat(40)));
  console.log(`Project root: ${gitRoot}`);
  console.log(`Branch name:  ${branchName}`);
  console.log(`Worktree:     ${worktreeDir}/`);
  console.log();

  if (status.healthy) {
    console.log(chalk.green.bold("✓ Shadow branch is healthy"));
    console.log(chalk.green("  ✓ Branch exists"));
    console.log(chalk.green("  ✓ Worktree exists"));
    console.log(chalk.green("  ✓ Worktree linked"));
  } else if (!status.exists) {
    console.log(chalk.yellow("○ Shadow branch not initialized"));
    console.log(chalk.gray("  Run `kspec init` to set up shadow branch"));
  } else {
    console.log(chalk.red.bold("✗ Shadow branch has issues"));
    console.log(
      status.branchExists ? chalk.green("  ✓ Branch exists") : chalk.red("  ✗ Branch missing"),
    );
    console.log(
      status.worktreeExists
        ? chalk.green("  ✓ Worktree exists")
        : chalk.red("  ✗ Worktree missing"),
    );
    console.log(
      status.worktreeLinked
        ? chalk.green("  ✓ Worktree linked")
        : chalk.red("  ✗ Worktree not linked"),
    );

    if (status.error) {
      console.log();
      console.log(chalk.yellow(`Issue: ${status.error}`));
    }

    if (status.branchExists) {
      console.log();
      console.log(chalk.gray("Run `kspec shadow repair` to fix"));
    } else {
      console.log();
      console.log(chalk.gray("Run `kspec init --force` to reinitialize"));
    }
  }

  // AC: @session-branch-worktree ac-status — report session branch health
  if (sessionStatus) {
    console.log();
    console.log(chalk.bold("Session Branch Status"));
    console.log(chalk.gray("─".repeat(40)));
    console.log(`Branch name:  ${sessionBranchName || "kspec-sessions"}`);
    console.log(`Worktree:     ${SESSIONS_WORKTREE_DIR}/`);
    console.log();

    if (sessionStatus.healthy) {
      console.log(chalk.green.bold("✓ Session branch is healthy"));
      console.log(chalk.green("  ✓ Branch exists"));
      console.log(chalk.green("  ✓ Worktree exists"));
      console.log(chalk.green("  ✓ Worktree linked"));
    } else if (!sessionStatus.exists) {
      console.log(chalk.gray("○ Session branch not configured"));
      console.log(chalk.gray('  Set sessions.storage: "branch" in manifest and run `kspec setup`'));
    } else {
      console.log(chalk.red.bold("✗ Session branch has issues"));
      console.log(
        sessionStatus.branchExists
          ? chalk.green("  ✓ Branch exists")
          : chalk.red("  ✗ Branch missing"),
      );
      console.log(
        sessionStatus.worktreeExists
          ? chalk.green("  ✓ Worktree exists")
          : chalk.red("  ✗ Worktree missing"),
      );
      console.log(
        sessionStatus.worktreeLinked
          ? chalk.green("  ✓ Worktree linked")
          : chalk.red("  ✗ Worktree not linked"),
      );

      if (sessionStatus.error) {
        console.log();
        console.log(chalk.yellow(`Issue: ${sessionStatus.error}`));
      }

      console.log();
      console.log(chalk.gray("Run `kspec shadow repair` to fix"));
    }
  }
}

/**
 * Register shadow commands
 */
export function registerShadowCommands(program: Command): void {
  const shadow = program.command("shadow").description("Manage shadow branch for spec storage");

  shadow
    .command("status")
    .description("Show shadow branch status")
    .action(async () => {
      try {
        const gitRoot = resolveCliProjectRoot();

        if (!gitRoot) {
          error(shadowCommands.notGitRepo);
          process.exit(EXIT_CODES.ERROR);
        }

        const { config } = await loadProjectConfig(gitRoot, gitRoot);
        const shadowOptions = {
          branchName: config.shadow.branch,
          directory: config.shadow.directory,
          remote: config.shadow.remote?.value,
          remoteType: config.shadow.remote?.type,
        };
        const branchName = shadowOptions.branchName || SHADOW_BRANCH_NAME;
        const worktreeDir = shadowOptions.directory || SHADOW_WORKTREE_DIR;
        const status = await getShadowStatus(gitRoot, shadowOptions);

        // AC: @session-branch-worktree ac-status — check session branch if configured
        let sessionStatus: SessionBranchStatus | undefined;
        let sessionBranchName: string | undefined;
        try {
          const { initContext } = await import("../../parser/index.js");
          const ctx = await initContext();
          if (ctx.manifest?.sessions?.storage === "branch") {
            sessionBranchName = ctx.manifest.sessions.branch || "kspec-sessions";
            sessionStatus = await getSessionBranchStatus(gitRoot, sessionBranchName);
          }
        } catch {
          // Context not available — skip session branch status
        }

        output(
          {
            ...status,
            gitRoot,
            branchName,
            worktreeDir,
            ...(sessionStatus && {
              sessionBranch: {
                ...sessionStatus,
                branchName: sessionBranchName,
                worktreeDir: SESSIONS_WORKTREE_DIR,
              },
            }),
          },
          () =>
            formatShadowStatus(
              status,
              gitRoot,
              branchName,
              worktreeDir,
              sessionStatus,
              sessionBranchName,
            ),
        );

        if (!status.healthy && status.exists) {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error(shadowCommands.statusFailed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  shadow
    .command("repair")
    .description("Repair broken shadow branch worktree")
    .action(async () => {
      try {
        const gitRoot = resolveCliProjectRoot();

        if (!gitRoot) {
          error(shadowCommands.notGitRepo);
          process.exit(EXIT_CODES.ERROR);
        }

        const { config } = await loadProjectConfig(gitRoot, gitRoot);
        const shadowOptions = {
          branchName: config.shadow.branch,
          directory: config.shadow.directory,
          remote: config.shadow.remote?.value,
          remoteType: config.shadow.remote?.type,
        };
        const worktreeDir = shadowOptions.directory || SHADOW_WORKTREE_DIR;
        const status = await getShadowStatus(gitRoot, shadowOptions);
        const remoteHasShadow = await remoteShadowBranchExists(gitRoot, shadowOptions);
        let hadError = false;

        if (status.healthy) {
          info(shadowCommands.repair.alreadyHealthy);
        } else {
          info(shadowCommands.repair.repairing);

          const result = await repairShadow(gitRoot, shadowOptions);

          if (result.success) {
            if (result.alreadyExists) {
              info(shadowCommands.repair.stillHealthy);
            } else {
              success(shadowCommands.repair.repaired, {
                worktreeCreated: result.worktreeCreated,
              });
              console.log(shadowCommands.repair.worktreeCreated(worktreeDir));
            }
          } else {
            error(shadowCommands.repair.failed(result.error || "Unknown error"));
            if (!status.branchExists && !remoteHasShadow) {
              console.log(shadowCommands.repair.initHint);
            }
            hadError = true;
          }
        }

        // AC: @session-branch-worktree ac-repair — repair session branch independently
        // Runs regardless of kspec-meta health — session branch is independent
        try {
          const { initContext } = await import("../../parser/index.js");
          const ctx = await initContext();
          if (ctx.manifest?.sessions?.storage === "branch") {
            const sessionBranchName = ctx.manifest.sessions.branch || "kspec-sessions";
            const sessionStatus = await getSessionBranchStatus(gitRoot, sessionBranchName);
            if (!sessionStatus.healthy && sessionStatus.exists) {
              info("Repairing session branch worktree...");
              const sessionResult = await repairSessionBranch(gitRoot, sessionBranchName);
              if (sessionResult.success) {
                if (sessionResult.alreadyExists) {
                  info("Session branch already healthy");
                } else {
                  success("Session branch repaired", {
                    worktreeCreated: sessionResult.worktreeCreated,
                  });
                }
              } else {
                warn(`Session branch repair failed: ${sessionResult.error || "Unknown error"}`);
              }
            }
          }
        } catch {
          // Session branch repair is optional
        }

        if (hadError) {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error(shadowCommands.repair.commandFailed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  shadow
    .command("log")
    .description("Show recent shadow branch commits")
    .option("-n, --count <n>", "Number of commits to show", "10")
    .action(async (options) => {
      try {
        const gitRoot = resolveCliProjectRoot();

        if (!gitRoot) {
          error(shadowCommands.notGitRepo);
          process.exit(EXIT_CODES.ERROR);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          if (!status.branchExists) {
            warn(shadowCommands.log.branchNotExist);
            console.log(shadowCommands.log.initHint);
          } else {
            warn(shadowCommands.log.hasIssues);
            console.log(shadowCommands.log.repairHint);
          }
          process.exit(EXIT_CODES.ERROR);
        }

        const count = parseInt(options.count, 10) || 10;

        const log = execSync(`git log --oneline -n ${count} ${SHADOW_BRANCH_NAME}`, {
          cwd: gitRoot,
          encoding: "utf-8",
        }).trim();

        if (!log) {
          info(shadowCommands.log.noCommits);
          return;
        }

        console.log(chalk.bold(`Recent commits on ${SHADOW_BRANCH_NAME}:`));
        console.log(chalk.gray("─".repeat(40)));
        console.log(log);
      } catch (err) {
        error(shadowCommands.log.failed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @shadow-sync ac-5 - Shadow resolve command for conflict resolution
  shadow
    .command("resolve")
    .description("Resolve shadow branch sync conflicts")
    .option("--theirs", "Accept all remote changes, discard local")
    .option("--ours", "Keep all local changes, discard remote")
    .action(async (options) => {
      try {
        const gitRoot = resolveCliProjectRoot();

        if (!gitRoot) {
          error(shadowCommands.notGitRepo);
          process.exit(EXIT_CODES.ERROR);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          error(shadowCommands.resolve.notHealthy);
          console.log(shadowCommands.resolve.repairHint);
          process.exit(EXIT_CODES.ERROR);
        }

        const worktreeDir = `${gitRoot}/${SHADOW_WORKTREE_DIR}`;

        // Check if there's a rebase in progress
        let inRebase = false;
        try {
          execSync("git rebase --show-current-patch", {
            cwd: worktreeDir,
            stdio: ["pipe", "pipe", "pipe"],
          });
          inRebase = true;
        } catch {
          // Not in rebase
        }

        if (options.theirs) {
          // Accept remote changes
          info(shadowCommands.resolve.acceptingRemote);
          if (inRebase) {
            execSync("git rebase --abort", {
              cwd: worktreeDir,
              stdio: "inherit",
            });
          }
          execSync(`git fetch origin ${SHADOW_BRANCH_NAME}`, {
            cwd: worktreeDir,
            stdio: "inherit",
          });
          execSync(`git reset --hard origin/${SHADOW_BRANCH_NAME}`, {
            cwd: worktreeDir,
            stdio: "inherit",
          });
          success(shadowCommands.resolve.acceptedRemote);
        } else if (options.ours) {
          // Keep local changes
          info(shadowCommands.resolve.keepingLocal);
          if (inRebase) {
            execSync("git rebase --abort", {
              cwd: worktreeDir,
              stdio: "inherit",
            });
          }
          // Force push to override remote
          try {
            execSync("git push --force-with-lease", {
              cwd: worktreeDir,
              stdio: "inherit",
            });
            success(shadowCommands.resolve.keptLocal);
          } catch {
            warn(shadowCommands.resolve.pushFailed);
            console.log(shadowCommands.resolve.localPreserved);
          }
        } else {
          // Interactive guidance
          console.log(shadowCommands.resolve.interactive.header);
          console.log(shadowCommands.resolve.interactive.separator);

          if (inRebase) {
            console.log(shadowCommands.resolve.interactive.rebaseInProgress);
            console.log();
          }

          console.log(shadowCommands.resolve.interactive.options);
          console.log();
          console.log(shadowCommands.resolve.interactive.theirs.command);
          console.log(shadowCommands.resolve.interactive.theirs.description);
          console.log();
          console.log(shadowCommands.resolve.interactive.ours.command);
          console.log(shadowCommands.resolve.interactive.ours.description);
          console.log();
          console.log(shadowCommands.resolve.interactive.manual.header);
          console.log(shadowCommands.resolve.interactive.manual.cdCommand(SHADOW_WORKTREE_DIR));
          if (inRebase) {
            shadowCommands.resolve.interactive.manual.rebaseSteps.forEach((step) =>
              console.log(step),
            );
          } else {
            shadowCommands.resolve.interactive.manual.pullSteps.forEach((step) =>
              console.log(step),
            );
          }
        }
      } catch (err) {
        error(shadowCommands.resolve.failed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // Explicit sync command
  shadow
    .command("sync")
    .description("Manually sync shadow branch with remote (pull then push)")
    .action(async () => {
      try {
        const gitRoot = resolveCliProjectRoot();

        if (!gitRoot) {
          error(shadowCommands.notGitRepo);
          process.exit(EXIT_CODES.ERROR);
        }

        const status = await getShadowStatus(gitRoot);

        if (!status.healthy) {
          error(shadowCommands.sync.notHealthy);
          console.log(shadowCommands.sync.repairHint);
          process.exit(EXIT_CODES.ERROR);
        }

        const worktreeDir = `${gitRoot}/${SHADOW_WORKTREE_DIR}`;

        if (!(await hasRemoteTracking(worktreeDir))) {
          info(shadowCommands.sync.noRemote);
          console.log(shadowCommands.sync.localOnly);
          return;
        }

        info(shadowCommands.sync.syncing);

        const result = await shadowSync(worktreeDir);

        if (result.hadConflict) {
          warn(shadowCommands.sync.conflictDetected);
          console.log(shadowCommands.sync.resolveHint);
          process.exit(EXIT_CODES.ERROR);
        }

        if (result.pulled && result.pushed) {
          success(shadowCommands.sync.syncedBoth);
        } else if (result.pulled) {
          success(shadowCommands.sync.syncedPull);
        } else if (result.pushed) {
          success(shadowCommands.sync.syncedPush);
        } else {
          info(shadowCommands.sync.alreadyInSync);
        }
      } catch (err) {
        error(shadowCommands.sync.failed, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
