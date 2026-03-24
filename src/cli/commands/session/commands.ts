/**
 * Session command registration.
 *
 * Wires up all session sub-commands with commander. This is the thin orchestration
 * layer that imports action handlers from sub-modules.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { initContext } from "../../../parser/index.js";
import { ShadowError } from "../../../parser/shadow.js";
import { isObject } from "../../../acp/types.js";
import { errors, sessionPrompt } from "../../../strings/index.js";
import { markAlwaysSync, markMutating } from "../../command-annotations.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { error, isJsonMode, output } from "../../output.js";
import { performCheckpoint } from "./checkpoint.js";
import { sessionCompactAction } from "./compact.js";
import { gatherSessionContext } from "./context.js";
import { sessionCreateAction } from "./create.js";
import { formatCheckpointResult, formatSessionContext } from "./format.js";
import {
  sessionLogListAction,
  sessionLogSearchAction,
  sessionLogShowAction,
  sessionLogStatsAction,
} from "./log.js";
import { sessionMigrateAction } from "./migrate.js";
import { sessionStaleCloseAction } from "./stale-close.js";
import type { CheckpointOptions, SessionOptions, StopHookInput } from "./types.js";

// ─── Debug Logging ──────────────────────────────────────────────────────────

function debugLog(message: string, detail?: unknown): void {
  if (process.env.KSPEC_DEBUG === "1") {
    if (detail) {
      console.error(`[DEBUG] session/commands: ${message}`, detail);
    } else {
      console.error(`[DEBUG] session/commands: ${message}`);
    }
  }
}

// ─── Action Handlers ────────────────────────────────────────────────────────

async function sessionStartAction(options: SessionOptions): Promise<void> {
  try {
    // AC: @shadow-sync ac-2 — initContext() performs pre-read shadow pull automatically
    const ctx = await initContext();

    const sessionCtx = await gatherSessionContext(ctx, options);

    output(sessionCtx, () => formatSessionContext(sessionCtx, options));
  } catch (err) {
    error(errors.failures.gatherSessionContext, err);
    process.exit(EXIT_CODES.ERROR);
  }
}

/**
 * Read stdin if available (non-blocking check for hook input)
 */
async function readStdinIfAvailable(): Promise<string | null> {
  // Check if stdin is a TTY (interactive) - if so, don't try to read
  if (process.stdin.isTTY) {
    return null;
  }

  return new Promise((resolve) => {
    let data = "";

    const onData = (chunk: string) => {
      data += chunk;
    };
    const onEnd = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(data || null);
    };
    const onError = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(data || null);
    }, 100); // 100ms timeout for stdin

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}

/**
 * Parse Claude Code hook input from stdin.
 * Returns null (with debug log) if input is missing, not valid JSON, or not an object.
 */
export function parseHookInput(stdin: string | null): StopHookInput | null {
  if (!stdin) return null;
  try {
    const parsed: unknown = JSON.parse(stdin.trim());
    if (!isObject(parsed)) {
      debugLog("parseHookInput: parsed value is not an object");
      return null;
    }
    return parsed as StopHookInput;
  } catch (err) {
    debugLog("parseHookInput: failed to parse stdin as JSON", err);
    return null;
  }
}

/**
 * Output spec-first reminder for UserPromptSubmit hook.
 *
 * This is a simple context injection - always outputs the reminder,
 * and Claude (Opus) is smart enough to apply it when relevant.
 */
async function sessionPromptCheckAction(): Promise<void> {
  // Lean, instructive reminder with kspec prefix
  console.log(sessionPrompt.specCheck);
}

async function sessionCheckpointAction(options: CheckpointOptions): Promise<void> {
  try {
    // Read stdin for Claude Code hook input
    const stdin = await readStdinIfAvailable();
    const hookInput = parseHookInput(stdin);

    // Check if this is a retry (stop hook already active)
    if (hookInput?.stop_hook_active) {
      options.stopHookActive = true;
    }

    const ctx = await initContext();
    const result = await performCheckpoint(ctx, options);

    // Output format depends on mode:
    // - JSON mode (--json): Output Claude Code hook format {"decision": "block", "reason": "..."}
    // - Human mode: Output formatted checkpoint result
    if (isJsonMode()) {
      if (!result.ok) {
        // Build reason message with issues and instructions
        const issueLines = result.issues.map((i) => `- ${i.description}`).join("\n");
        const instructionLines = result.instructions.filter((i) => i.trim()).join("\n");
        const reason = `${result.message}\n\nIssues:\n${issueLines}\n\n${instructionLines}`;
        console.log(JSON.stringify({ decision: "block", reason }));
      }
      // If ok, exit silently (Claude Code expects no output when allowing stop)
    } else {
      formatCheckpointResult(result);
      if (!result.ok) {
        process.exit(EXIT_CODES.ERROR);
      }
    }
  } catch (err) {
    // Handle RUNNING_FROM_SHADOW gracefully - skip with warning instead of erroring
    // This happens when the stop hook runs while cwd is inside .kspec/ directory
    if (err instanceof ShadowError && err.code === "RUNNING_FROM_SHADOW") {
      if (!isJsonMode()) {
        console.log(
          chalk.yellow(
            "[kspec] Session checkpoint skipped - running from inside .kspec/ directory",
          ),
        );
      }
      // Allow stop to proceed (exit successfully, no JSON output blocks the stop)
      return;
    }
    error(errors.failures.runCheckpoint, err);
    process.exit(EXIT_CODES.ERROR);
  }
}

// ─── Command Registration ───────────────────────────────────────────────────

/**
 * Register the 'session' command group and aliases
 */
export function registerSessionCommands(program: Command): void {
  const session = program.command("session").description("Session management and context");

  // Session create subcommand
  // AC: @droid-setup-status ac-3 — "droid" accepted as --agent-type value
  markMutating(session.command("create"))
    .description("Create a new kspec session with optional budget")
    .option(
      "--agent-type <type>",
      "Agent type (e.g., claude-code, codex-cli, droid)",
      "claude-code",
    )
    .option("--budget <n>", "Maximum tasks per cycle (positive integer)")
    .option("--inject", "Inject KSPEC_SESSION_ID into agent environment")
    .option("--task-id <id>", "Optional task ID being worked on")
    .action(sessionCreateAction);

  // AC: @shadow-lazy-read-sync ac-session-start-always-pulls
  markAlwaysSync(session.command("start").alias("resume"))
    .description("Surface relevant context for starting a new working session")
    .option("--brief", "Compact summary (default)")
    .option("--full", "Comprehensive context dump")
    .option("--since <time>", "Filter by recency (ISO8601 or relative: 1h, 2d, 1w)")
    .option("--no-git", "Skip git commit information")
    .option("-n, --limit <n>", "Limit items per section", "10")
    .action(sessionStartAction);

  // Session log subcommand group
  const log = session.command("log").description("Session log analysis commands");

  log
    .command("list")
    .description("List session logs with summary statistics")
    .option(
      "-s, --status <status>",
      "Filter by status (active, completed, abandoned, timed_out, failed, stalled)",
    )
    .option("--agent <type>", "Filter by agent type (alias for --agent-type)")
    .option("--agent-type <type>", "Filter by agent type")
    .option("--agent-id <id>", "Filter by agent definition ID (e.g. worker, pr-reviewer)")
    .option("--trigger <trigger>", "Filter by trigger (manual, dispatched, task.ready, etc.)")
    .option("--task <ref>", "Filter by task reference")
    .option(
      "--since <time>",
      "Only show sessions started after this time (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option(
      "--sort <field>",
      "Sort by field (started_at, duration, events, iterations, tasks_completed)",
      "started_at",
    )
    .option("--count", "Show only the count of matching sessions")
    .option("-n, --limit <n>", "Limit number of sessions shown")
    .option("--offset <n>", "Skip first N sessions")
    .action(sessionLogListAction);

  log
    .command("show <session-id>")
    .description("Show detailed view of a single session")
    .option("-e, --events", "Include chronological event timeline")
    .option("--text", "Replay assistant text output from session.update events")
    .option("-t, --type <type>", "Filter events by type (e.g., tool.call)")
    .option("-n, --limit <n>", "Show only the last N events")
    .option("-c, --context <n>", "Show context snapshot for iteration N")
    .option("--resolve-blobs", "Resolve externalized event payload blobs (requires --events)")
    .action(sessionLogShowAction);

  log
    .command("stats")
    .description("Aggregate analytics across sessions")
    .option(
      "--since <time>",
      "Only include sessions started after this time (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option("--agent <type>", "Only include sessions with this agent type")
    .option("--agent-type <type>", "Only include sessions with this agent type")
    .option("--agent-id <id>", "Only include sessions with this agent definition ID")
    .option("--trigger <trigger>", "Only include sessions with this trigger")
    .option("--task <ref>", "Only include sessions linked to this task")
    .option("--tool-usage", "Display top 10 tool calls by frequency")
    .option("--by-day", "Group stats by day")
    .option("--by-week", "Group stats by week")
    .action(sessionLogStatsAction);

  log
    .command("search <pattern>")
    .description("Search across session events by content")
    .option("-t, --type <type>", "Only search events of this type (e.g., session.update)")
    .option("--status <status>", "Only search sessions with this status")
    .option(
      "--since <time>",
      "Only search sessions started after this time (ISO8601 or relative: 1h, 2d, 1w)",
    )
    .option("--agent <type>", "Only search sessions with this agent type")
    .option("--agent-type <type>", "Only search sessions with this agent type")
    .option("--agent-id <id>", "Only search sessions with this agent definition ID")
    .option("--trigger <trigger>", "Only search sessions with this trigger")
    .option("--task <ref>", "Only search sessions linked to this task")
    .option("-n, --limit <n>", "Maximum matches to return (default: 50)")
    .option("--resolve-blobs", "Resolve externalized payload blobs for full-content search")
    .action(sessionLogSearchAction);

  // AC: @session-legacy-migration ac-migration-copy ac-migration-idempotent
  markMutating(session.command("migrate"))
    .description("Copy sessions from legacy .kspec/sessions/ to .kspec-sessions/")
    .action(sessionMigrateAction);

  markMutating(session.command("compact [session-id]"))
    .description("Retroactively compact session events by externalizing oversized payloads")
    .option("--all", "Compact all non-active sessions sequentially")
    .option("--dry-run", "Preview compaction without modifying files")
    .action(sessionCompactAction);

  const stale = session.command("stale").description("Stale active session cleanup commands");

  markMutating(stale.command("close [session-id]"))
    .description("Close stale active sessions by target or batch")
    .option("--refs <session-ids...>", "Evaluate specific sessions in batch mode")
    .option("--all", "Evaluate all active sessions")
    .option(
      "--older-than <duration>",
      "Minimum session age (relative duration, e.g., 24h, 7d, 2w, 1m)",
    )
    .option(
      "--inactive-for <duration>",
      "Minimum inactivity duration (relative duration, e.g., 6h)",
    )
    .option("--liveness-guard <duration>", "Protect recently-active sessions (default: 5m)")
    .option("--dry-run", "Preview stale-session closures without modifying files")
    .option("--force", "Skip confirmation prompts for destructive execution")
    .action(sessionStaleCloseAction);

  session
    .command("checkpoint")
    .description("Pre-stop hook: check for uncommitted work before ending session")
    .option("--force", "Allow session end regardless of issues")
    .action(sessionCheckpointAction);

  session
    .command("prompt-check")
    .description("UserPromptSubmit hook: inject spec-first reminder")
    .action(sessionPromptCheckAction);

  // Top-level alias: kspec context
  // AC: @shadow-lazy-read-sync ac-session-start-always-pulls
  markAlwaysSync(program.command("context"))
    .description("Alias for session start - surface session context")
    .option("--brief", "Compact summary (default)")
    .option("--full", "Comprehensive context dump")
    .option("--since <time>", "Filter by recency (ISO8601 or relative: 1h, 2d, 1w)")
    .option("--no-git", "Skip git commit information")
    .option("-n, --limit <n>", "Limit items per section", "10")
    .action(sessionStartAction);
}
