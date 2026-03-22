/**
 * Native guard commands for kspec.
 *
 * Replaces bash shell script hooks with TypeScript CLI commands.
 * `kspec guard worktree` replaces kspec-worktree-guard.sh.
 *
 * AC: @native-guard-commands ac-worktree-guard - blocks dangerous git ops in .kspec
 * AC: @native-guard-commands ac-worktree-allow - allows safe commands
 */

import * as path from "node:path";
import type { Command } from "commander";
import { EXIT_CODES } from "../exit-codes.js";
import { isJsonMode, output } from "../output.js";
import {
  SHADOW_BRANCH_NAME,
  resolveProjectRoots,
} from "../../parser/shadow.js";
import { loadProjectConfig } from "../../parser/config.js";

/**
 * Decision from a guard check
 */
export interface GuardDecision {
  decision: "allow" | "block";
  reason?: string;
}

/**
 * PreToolUse hook input from Claude Code
 */
interface PreToolUseInput {
  tool_name?: string;
  tool_input?: {
    command?: string;
  };
  cwd?: string;
}

/**
 * Dangerous git patterns that should be blocked when operating in .kspec/ worktree.
 * These can corrupt session data or disrupt the kspec-meta branch.
 */
const DANGEROUS_PATTERNS: readonly string[] = [
  // Branch creation
  "git checkout -b",
  "git checkout -B",
  "git branch -c",
  "git branch -C",
  "git branch -m",
  "git branch -M",
  "git switch -c",
  "git switch -C",
  "git switch --create",
  // History rewriting
  "git reset",
  "git rebase",
  "git cherry-pick",
  "git commit --amend",
  // Force push
  "git push --force",
  "git push -f",
  // Discarding changes
  "git stash",
  "git clean",
  "git checkout -- ",
  "git restore",
];

/**
 * Check if a command targets the shadow branch worktree, either via cwd or cd commands.
 *
 * Compares against the resolved absolute path of the shadow worktree to avoid
 * false positives on unrelated directories that happen to share the shadow
 * directory name (e.g. /repo/packages/demo/.kspec is NOT the project shadow worktree).
 */
function isInKspec(command: string, cwd: string | undefined, shadowAbsPath: string): boolean {
  if (cwd) {
    // Normalize path separators for cross-platform support
    const normalizedCwd = cwd.replace(/\\/g, "/");
    if (isShadowWorktreePath(normalizedCwd, shadowAbsPath)) {
      return true;
    }
  }
  if (isCdToShadowWorktree(command, shadowAbsPath, cwd)) {
    return true;
  }
  return false;
}

/**
 * Check if a normalized path is inside the shadow worktree directory.
 *
 * Compares against the resolved absolute path of the shadow worktree.
 * Only matches the exact shadow worktree path or subdirectories of it.
 */
function isShadowWorktreePath(normalizedPath: string, shadowAbsPath: string): boolean {
  const normalizedShadow = shadowAbsPath.replace(/\\/g, "/");
  // Exact match: cwd IS the shadow worktree
  if (normalizedPath === normalizedShadow) {
    return true;
  }
  // Subdirectory match: cwd is inside the shadow worktree
  return normalizedPath.startsWith(normalizedShadow + "/");
}

/**
 * Check if a command contains a cd into the shadow worktree directory.
 *
 * For absolute cd targets, compares directly against the shadow worktree path.
 * For relative cd targets, resolves against cwd (if available) and compares.
 * Falls back to directory-name matching when cwd is not available.
 */
function isCdToShadowWorktree(command: string, shadowAbsPath: string, cwd: string | undefined): boolean {
  // Extract the cd target from the command
  const cdMatch = command.match(/cd\s+(\S+)/);
  if (!cdMatch) {
    return false;
  }
  const cdTarget = cdMatch[1];
  const normalizedShadow = shadowAbsPath.replace(/\\/g, "/");
  const shadowDirName = path.basename(normalizedShadow);

  // If cd target is absolute, compare directly
  if (cdTarget.startsWith("/")) {
    const normalizedTarget = cdTarget.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalizedTarget === normalizedShadow ||
      normalizedTarget.startsWith(normalizedShadow + "/");
  }

  // For relative targets, resolve against cwd if available
  if (cwd) {
    const resolved = path.resolve(cwd, cdTarget).replace(/\\/g, "/");
    return resolved === normalizedShadow ||
      resolved.startsWith(normalizedShadow + "/");
  }

  // Fallback: no cwd available, use directory-name segment matching
  // This only matches relative cd targets like "cd .kspec" or "cd .kspec/subdir"
  const escaped = shadowDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:/|$)`).test(cdTarget);
}

/**
 * Check if a command attempts to delete the kspec-meta branch.
 */
function isShadowBranchDeletion(command: string): boolean {
  // Remove quote characters to catch split-quote bypasses like git "branch" -D kspec-meta
  const unquoted = command.replace(/["']/g, "");
  // Escape branch name for regex and use word boundary to avoid matching prefixed branches
  const escaped = SHADOW_BRANCH_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`git\\s+branch\\s+-[dD]\\s+(?:.*\\s+)?${escaped}(?:\\s|$)`).test(unquoted);
}

/**
 * Check if a command matches any dangerous pattern when operating in .kspec.
 *
 * Uses two matching strategies (same as the original shell script):
 * 1. STRIPPED: Remove entire quoted strings to ignore patterns in arguments
 *    (allows: echo "git reset", grep "git stash")
 * 2. UNQUOTED + first-word check: Remove quote chars and check if first command is "git"
 *    (blocks: git "reset" --hard, git st'ash')
 */
function matchesDangerousPattern(command: string): string | null {
  // STRIPPED: remove quoted strings entirely to ignore patterns in args
  const stripped = command.replace(/'[^']*'/g, "").replace(/"[^"]*"/g, "");
  // UNQUOTED: remove quote chars to catch split-quote bypasses
  const unquoted = command.replace(/["']/g, "");
  // First command word (trimmed)
  const firstCmd = command.trimStart().split(/\s+/)[0] || "";

  for (const pattern of DANGEROUS_PATTERNS) {
    // Block if pattern is in the stripped command (actual command, not in quotes)
    // OR if pattern is in unquoted AND first command word is "git"
    if (
      stripped.includes(pattern) ||
      (unquoted.includes(pattern) && firstCmd === "git")
    ) {
      return pattern;
    }
  }
  return null;
}

/**
 * Options for evaluateWorktreeGuard to support configurable shadow directory.
 */
export interface GuardOptions {
  /**
   * Absolute path to the shadow worktree directory.
   * When provided, cwd is compared against this exact path (not a name pattern).
   * When omitted, the guard fails open (allows all cwd-based checks) since it
   * cannot distinguish the project's shadow worktree from unrelated directories.
   */
  shadowAbsolutePath?: string;
}

/**
 * Evaluate a PreToolUse hook input and return a guard decision.
 * This is the core logic, exported for testing.
 *
 * The shadowAbsolutePath is resolved from kspec.config.yaml + project root at
 * the CLI layer and passed in. When not provided, cwd-based shadow worktree
 * detection is skipped (fail-open) to avoid false positives on unrelated
 * directories that share the shadow directory name.
 *
 * AC: @native-guard-commands ac-worktree-guard
 * AC: @native-guard-commands ac-worktree-allow
 */
export function evaluateWorktreeGuard(input: PreToolUseInput, options?: GuardOptions): GuardDecision {
  const command = input.tool_input?.command;

  // No command means not a Bash tool call — allow
  if (!command) {
    return { decision: "allow" };
  }

  // Block shadow branch deletion from anywhere (does not need shadow path context)
  if (isShadowBranchDeletion(command)) {
    return {
      decision: "block",
      reason:
        `[kspec-worktree-guard] BLOCKED: Cannot delete ${SHADOW_BRANCH_NAME} branch. This is the main branch for the .kspec worktree.`,
    };
  }

  // shadowAbsolutePath is required for cwd-based shadow worktree detection.
  // The CLI handler resolves it from config + project root. Without it, the
  // guard cannot distinguish the project's shadow worktree from unrelated
  // directories that share the same name — fail-open to avoid false positives.
  if (!options?.shadowAbsolutePath) {
    return { decision: "allow" };
  }
  const shadowAbsPath = options.shadowAbsolutePath;

  // If not operating in the shadow worktree, allow everything
  if (!isInKspec(command, input.cwd, shadowAbsPath)) {
    return { decision: "allow" };
  }

  // Check for dangerous patterns in shadow worktree context
  const matched = matchesDangerousPattern(command);
  if (matched) {
    return {
      decision: "block",
      reason:
        "[kspec-worktree-guard] BLOCKED: Dangerous git operation in .kspec worktree. This worktree contains active session data and must stay on kspec-meta. Operations like reset, rebase, stash, and clean can corrupt session files.",
    };
  }

  return { decision: "allow" };
}

/**
 * Read all stdin as a string (for hook JSON input).
 */
async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
    // If stdin is already ended (e.g., no pipe), resolve empty
    if (process.stdin.readableEnded) {
      resolve("");
    }
  });
}

/**
 * Register the guard command group.
 *
 * AC: @trait-semantic-exit-codes ac-8 - exit code meanings documented in code
 */
export function registerGuardCommand(program: Command): void {
  const guard = program
    .command("guard")
    .description("Guard commands for protecting kspec state");

  guard
    .command("worktree")
    .description(
      "Guard against dangerous git operations in .kspec worktree (PreToolUse hook)",
    )
    .option("--json", "Output as JSON")
    .action(async () => {
      try {
        const raw = await readStdin();

        if (!raw.trim()) {
          // No input — allow (not a tool call we need to guard)
          // AC: @native-guard-commands ac-worktree-allow
          const result: GuardDecision = { decision: "allow" };
          console.log(JSON.stringify(result));
          process.exit(EXIT_CODES.SUCCESS);
          return;
        }

        let input: PreToolUseInput;
        try {
          input = JSON.parse(raw);
        } catch {
          // Invalid JSON — this is a validation error
          // AC: @trait-semantic-exit-codes ac-2 - validation error exit code 1
          if (isJsonMode()) {
            output({ error: "Invalid JSON input on stdin" });
          } else {
            // Guard hooks always output JSON for the hook protocol
            console.log(
              JSON.stringify({
                error: "Invalid JSON input on stdin",
              }),
            );
          }
          process.exit(EXIT_CODES.ERROR);
          return;
        }

        // Resolve the actual project root, handling the case where the hook
        // process itself was launched from inside a git worktree (e.g. from
        // the shadow worktree .kspec/). resolveProjectRoots() uses
        // git rev-parse --git-common-dir to find the main repo root even when
        // cwd is inside a worktree. Without this, getGitRoot() would return
        // .kspec/ as the git root, making shadowAbsolutePath wrong.
        const roots = resolveProjectRoots(process.cwd());
        const mainRoot = roots?.mainRoot ?? undefined;
        const { config, gitRoot } = await loadProjectConfig(process.cwd(), mainRoot);
        const projectRoot = gitRoot ?? process.cwd();
        const shadowAbsolutePath = path.resolve(projectRoot, config.shadow.directory);
        const decision = evaluateWorktreeGuard(input, {
          shadowAbsolutePath,
        });

        // Guard commands always output JSON (hook protocol requirement)
        // AC: @trait-json-output ac-1 - valid JSON with no ANSI codes
        console.log(JSON.stringify(decision));

        // AC: @trait-semantic-exit-codes ac-1 - exit 0 on success
        process.exit(EXIT_CODES.SUCCESS);
      } catch (err) {
        // AC: @trait-semantic-exit-codes ac-4 - runtime error exit code 3
        // AC: @trait-json-output ac-3 - error as JSON
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.log(JSON.stringify({ error: errorMsg }));
        process.exit(EXIT_CODES.NOT_FOUND); // Using 3 for runtime errors
      }
    });
}
