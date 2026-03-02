/**
 * kspec agent commands — manage and run agents.
 *
 * Provides subcommands for listing agent definitions, running one-shot
 * invocations, and managing the dispatch engine lifecycle via the daemon.
 *
 * AC: @cli-agent-commands ac-1 through ac-10
 * AC: @trait-json-output ac-1 through ac-6
 * AC: @trait-semantic-exit-codes ac-1 through ac-8
 * AC: @trait-error-guidance ac-1 through ac-6
 * AC: @trait-dry-run ac-1 through ac-6
 * AC: @trait-filterable-list ac-1 through ac-8
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  initContext,
  loadMetaContext,
} from "../../parser/index.js";
import { runInvocation } from "../../agent-runtime/invocation.js";
import { buildPromptWithSkills } from "../../agent-runtime/prompts.js";
import { resolveAdapter } from "../../agents/adapters.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, output, success, isJsonMode } from "../output.js";
import { parseIntOption } from "../validators.js";
import { PidFileManager } from "../pid-utils.js";
import { errors } from "../../strings/errors.js";
import type { LoadedAgent } from "../../parser/meta.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the daemon URL from the PID file manager.
 * Returns null if the daemon is not running.
 * AC: @cli-agent-commands ac-10
 */
function getDaemonUrl(): { url: string; port: number } | null {
  const pidManager = new PidFileManager();
  if (!pidManager.isDaemonRunning()) return null;
  try {
    const port = pidManager.readPort();
    return { url: `http://localhost:${port}`, port };
  } catch {
    return null;
  }
}

/**
 * Format dispatch rules summary for display.
 */
function formatDispatchRules(agent: LoadedAgent): string {
  if (!agent.dispatch || agent.dispatch.length === 0) {
    return "(none)";
  }
  return agent.dispatch.map((r) => {
    const filterParts: string[] = [];
    if (r.filter?.automation) filterParts.push(`automation=${r.filter.automation}`);
    if (r.filter?.tags?.length) filterParts.push(`tags=${r.filter.tags.join(",")}`);
    if (r.filter?.priority !== undefined) filterParts.push(`priority=${r.filter.priority}`);
    const filterStr = filterParts.length > 0 ? ` [${filterParts.join(", ")}]` : "";
    return `${r.on}${filterStr}`;
  }).join(", ");
}

// ─── Command Registration ─────────────────────────────────────────────────────

/**
 * Register the kspec agent command family.
 * AC: @cli-agent-commands ac-1 through ac-10
 */
export function registerAgentCommands(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage and run agents");

  // ─── kspec agent list ─────────────────────────────────────────────────────

  // AC: @cli-agent-commands ac-1
  // AC: @trait-filterable-list ac-1 through ac-8
  agent
    .command("list")
    .description("List all agent definitions")
    .option("--json", "Output as JSON")
    .option("--status <status>", "Filter by automation status (eligible|ineligible)")
    .option("--tag <tag>", "Filter by tag (repeatable)", (val: string, arr: string[]) => [...arr, val], [] as string[])
    .option("--limit <n>", "Maximum number of results")
    .option("--offset <n>", "Skip first N results")
    .option("--count", "Output only the count")
    .action(async (opts) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const meta = await loadMetaContext(ctx);
        let agents = meta.agents;

        // AC: @trait-filterable-list ac-1 - automation status filter
        if (opts.status) {
          agents = agents.filter((a) =>
            (a as LoadedAgent & { automation?: string }).automation === opts.status,
          );
        }

        // AC: @trait-filterable-list ac-2 - tag filter
        const tags: string[] = opts.tag ?? [];
        if (tags.length > 0) {
          agents = agents.filter((a) => {
            const agentTags = (a as LoadedAgent & { tags?: string[] }).tags ?? [];
            return tags.every((t) => agentTags.includes(t));
          });
        }

        const total = agents.length;

        // AC: @trait-filterable-list ac-8 - count mode
        if (opts.count) {
          output({ count: total }, () => {
            console.log(total);
          });
          return;
        }

        // AC: @trait-filterable-list ac-3, ac-4 - pagination
        const limit = opts.limit ? parseInt(opts.limit, 10) : total;
        const offset = opts.offset ? parseInt(opts.offset, 10) : 0;
        const paginated = agents.slice(offset, offset + limit);

        // AC: @trait-semantic-exit-codes ac-5 - empty result set exits 0
        // AC: @trait-filterable-list ac-6 - empty list with informative message
        if (paginated.length === 0) {
          output(
            { items: [], total, offset, limit },
            () => {
              if (opts.status || tags.length > 0) {
                console.log("No agents match the specified filters.");
              } else {
                console.log("No agent definitions found.");
              }
            },
          );
          return;
        }

        // AC: @trait-json-output ac-1 through ac-5
        output(
          {
            items: paginated.map((a) => ({
              id: a.id,
              name: a.name,
              adapter: a.adapter ?? "claude-agent-acp",
              dispatch: a.dispatch ?? [],
              concurrency: a.concurrency ?? { max_concurrent: 1 },
            })),
            total,
            offset,
            limit,
          },
          () => {
            // AC: @trait-filterable-list ac-7 - summary with total and filter state
            const filterDesc = [
              opts.status ? `status=${opts.status}` : "",
              tags.length > 0 ? `tags=${tags.join(",")}` : "",
            ].filter(Boolean).join(", ");
            const summaryStr = filterDesc ? ` (filtered: ${filterDesc})` : "";
            console.log(chalk.bold(`Agents${summaryStr}: ${paginated.length} of ${total}`));
            console.log();

            for (const a of paginated) {
              console.log(`  ${chalk.cyan(a.id)}  ${chalk.gray(a.adapter ?? "claude-agent-acp")}`);
              console.log(`    ${chalk.gray("dispatch:")} ${formatDispatchRules(a)}`);
              console.log(`    ${chalk.gray("concurrency:")} max ${a.concurrency?.max_concurrent ?? 1}`);
            }
          },
        );
      } catch (err) {
        error("Failed to list agents", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ─── kspec agent run ──────────────────────────────────────────────────────

  // AC: @cli-agent-commands ac-2, ac-3, ac-7, ac-8
  // AC: @trait-dry-run ac-1 through ac-6
  agent
    .command("run <agent-id> [prompt]")
    .description("Run a one-shot agent invocation")
    .option("--task <ref>", "Task reference to target")
    .option("--timeout <minutes>", "Timeout in minutes (overrides agent default)")
    .option("--budget <n>", "Budget override (max tasks)")
    .option("--adapter <id>", "Adapter override")
    .option("--dry-run", "Show prompt without spawning agent")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, prompt: string | undefined, opts) => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error(errors.project.noKspecProject);
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        const meta = await loadMetaContext(ctx);
        const agentDef = meta.agents.find((a) => a.id === agentId);

        // AC: @trait-error-guidance ac-3 - not found error with suggestion
        if (!agentDef) {
          error(
            `Agent "${agentId}" not found.`,
            {
              suggestion: `Check available agents with: kspec agent list`,
            },
          );
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // Resolve the effective adapter
        const adapterId = opts.adapter ?? agentDef.adapter ?? "claude-agent-acp";
        const adapter = resolveAdapter(adapterId);

        // Build the prompt
        const taskRef = opts.task as string | undefined;
        const basePrompt = prompt ?? (taskRef
          ? `Work on task ${taskRef} according to your configuration and skills.`
          : `Run as requested.`);

        // Note: buildPromptWithSkills is called here for the dry-run preview path.
        // runInvocation also calls buildPromptWithSkills internally, so we pass basePrompt
        // to runInvocation (not fullPrompt) to avoid double-expansion.
        const fullPromptForPreview = await buildPromptWithSkills({
          basePrompt,
          skillIds: agentDef.skills ?? [],
          specDir: ctx.specDir,
        });

        // AC: @trait-dry-run ac-1, ac-2, ac-3 - dry run shows prompt, no changes
        if (opts.dryRun) {
          // Pre-compute overrides so dry-run reflects what the actual invocation would use
          // AC: @cli-agent-commands ac-7 - overrides are visible in dry-run output
          // AC: @trait-semantic-exit-codes ac-2 - validate numeric inputs even in dry-run
          let dryTimeoutOverride: number | undefined;
          if (opts.timeout) {
            const parsed = parseIntOption(opts.timeout, { min: 1, max: 10080, name: "Timeout" });
            if (!parsed.ok) {
              error(`Invalid --timeout value: ${parsed.error}`, { suggestion: "Example: --timeout 30" });
              process.exit(EXIT_CODES.VALIDATION_FAILED);
            }
            dryTimeoutOverride = parsed.value;
          }
          let dryBudgetOverride: number | undefined;
          if (opts.budget) {
            const parsed = parseIntOption(opts.budget, { min: 1, max: 99999, name: "Budget" });
            if (!parsed.ok) {
              error(`Invalid --budget value: ${parsed.error}`, { suggestion: "Example: --budget 10" });
              process.exit(EXIT_CODES.VALIDATION_FAILED);
            }
            dryBudgetOverride = parsed.value;
          }

          const effectiveTimeoutMinutes = dryTimeoutOverride ?? agentDef.budget?.timeout_minutes;
          const effectiveMaxTasks = dryBudgetOverride ?? agentDef.budget?.max_tasks;

          // AC: @trait-dry-run ac-6 - JSON output includes dry_run field
          output(
            {
              dry_run: true,
              agent_id: agentId,
              adapter: adapterId,
              task_ref: taskRef ?? null,
              timeout_minutes: effectiveTimeoutMinutes ?? null,
              max_tasks: effectiveMaxTasks ?? null,
              prompt: fullPromptForPreview,
            },
            () => {
              console.log(chalk.yellow("DRY RUN - No agent will be spawned"));
              console.log();
              console.log(chalk.gray(`Agent:   ${agentId}`));
              console.log(chalk.gray(`Adapter: ${adapterId}`));
              if (taskRef) {
                console.log(chalk.gray(`Task:    ${taskRef}`));
              }
              if (effectiveTimeoutMinutes !== undefined) {
                console.log(chalk.gray(`Timeout: ${effectiveTimeoutMinutes} min`));
              }
              console.log();
              console.log(chalk.gray("--- Prompt that would be sent ---"));
              console.log(fullPromptForPreview);
              console.log(chalk.gray("--- End prompt ---"));
            },
          );
          return;
        }

        // AC: @cli-agent-commands ac-2 - one-shot invocation with task binding
        // AC: @cli-agent-commands ac-3 - one-shot invocation with custom prompt (no task binding)
        // AC: @cli-agent-commands ac-7 - CLI overrides agent defaults
        let timeoutOverride: number | undefined;
        if (opts.timeout) {
          const parsed = parseIntOption(opts.timeout, { min: 1, max: 10080, name: "Timeout" });
          if (!parsed.ok) {
            error(`Invalid --timeout value: ${parsed.error}`, { suggestion: "Example: --timeout 30" });
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          timeoutOverride = parsed.value;
        }
        let budgetOverride: number | undefined;
        if (opts.budget) {
          const parsed = parseIntOption(opts.budget, { min: 1, max: 99999, name: "Budget" });
          if (!parsed.ok) {
            error(`Invalid --budget value: ${parsed.error}`, { suggestion: "Example: --budget 10" });
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          budgetOverride = parsed.value;
        }

        const effectiveAgent = {
          ...agentDef,
          adapter: adapterId,
          budget: timeoutOverride !== undefined || budgetOverride !== undefined
            ? {
                ...agentDef.budget,
                timeout_minutes: timeoutOverride ?? agentDef.budget?.timeout_minutes,
                max_tasks: budgetOverride ?? agentDef.budget?.max_tasks,
              }
            : agentDef.budget,
        };

        console.log(chalk.gray(`Running agent "${agentId}"...`));

        // AC: @cli-agent-commands ac-3 - no task binding when --task not provided
        // Pass basePrompt (not fullPromptForPreview) — runInvocation expands skills internally
        const result = await runInvocation({
          agent: effectiveAgent,
          specDir: ctx.specDir,
          cwd: ctx.rootDir,
          taskRef: taskRef ?? undefined,
          prompt: basePrompt,
          trigger: "manual",
        });

        output(
          {
            outcome: result.outcome,
            session_id: result.session.id,
            duration_ms: result.durationMs,
            stop_reason: result.stopReason,
          },
          () => {
            if (result.outcome === "success") {
              success(`Agent invocation completed`, {
                session: result.session.id,
                duration: `${Math.round(result.durationMs / 1000)}s`,
              });
            } else {
              error(`Agent invocation ${result.outcome}: ${result.error ?? "unknown"}`);
            }
          },
        );

        if (result.outcome !== "success") {
          process.exit(EXIT_CODES.ERROR);
        }
      } catch (err) {
        error("Failed to run agent", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ─── kspec agent status ───────────────────────────────────────────────────

  // AC: @cli-agent-commands ac-6
  agent
    .command("status")
    .description("Show active and queued agent invocations")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const daemonConn = getDaemonUrl();

        // AC: @trait-error-guidance ac-1, ac-2
        if (!daemonConn) {
          error(
            "Daemon is not running. Cannot retrieve agent status.",
            { suggestion: "Start the daemon with: kspec serve" },
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {};
        if (ctx.rootDir) {
          headers["X-Kspec-Dir"] = ctx.rootDir;
        }

        const response = await fetch(`${daemonConn.url}/api/agent/dispatch/status`, { headers });
        if (!response.ok) {
          error(`Daemon returned error: ${response.status} ${response.statusText}`);
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @cli-agent-commands ac-6
        const data = await response.json() as {
          running: boolean;
          activeInvocations: number;
          queuedInvocations: number;
          invocations: Array<{
            invocationId: string;
            sessionId: string;
            agentId: string;
            agentName: string;
            taskRef: string | undefined;
            elapsedMs: number;
          }>;
          queued: Array<{
            agentId: string;
            agentName: string;
            taskRef: string | undefined;
            waitMs: number;
          }>;
        };

        output(data, () => {
          console.log(chalk.bold("Agent Status"));
          console.log();
          console.log(`  Dispatch engine: ${data.running ? chalk.green("running") : chalk.gray("stopped")}`);
          console.log(`  Active invocations: ${chalk.cyan(String(data.activeInvocations))}`);
          console.log(`  Queued invocations: ${chalk.cyan(String(data.queuedInvocations))}`);

          const invocations = data.invocations ?? [];
          if (invocations.length > 0) {
            console.log();
            console.log(chalk.bold("Active:"));
            for (const inv of invocations) {
              const elapsed = Math.round(inv.elapsedMs / 1000);
              const taskStr = inv.taskRef ? `  task: ${chalk.yellow(inv.taskRef)}` : "";
              console.log(`  ${chalk.cyan(inv.agentId)}  ${chalk.gray(inv.agentName)}`);
              console.log(`    session: ${chalk.gray(inv.sessionId)}  elapsed: ${elapsed}s${taskStr}`);
            }
          }

          const queuedItems = data.queued ?? [];
          if (queuedItems.length > 0) {
            console.log();
            console.log(chalk.bold("Queued:"));
            for (const q of queuedItems) {
              const wait = Math.round(q.waitMs / 1000);
              const taskStr = q.taskRef ? `  task: ${chalk.yellow(q.taskRef)}` : "";
              console.log(`  ${chalk.cyan(q.agentId)}  ${chalk.gray(q.agentName)}`);
              console.log(`    waiting: ${wait}s${taskStr}`);
            }
          }
        });
      } catch (err) {
        error("Failed to get agent status", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // ─── kspec agent dispatch ─────────────────────────────────────────────────

  const dispatch = agent
    .command("dispatch")
    .description("Manage the agent dispatch engine");

  // AC: @cli-agent-commands ac-4
  // AC: @cli-agent-commands ac-10
  dispatch
    .command("start")
    .description("Start the dispatch engine (daemon must be running)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const daemonConn = getDaemonUrl();

        // AC: @cli-agent-commands ac-10 - error when daemon not running
        if (!daemonConn) {
          error(
            "Daemon is not running. The dispatch engine requires the daemon.",
            { suggestion: "Start the daemon first with: kspec serve" },
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (ctx.rootDir) {
          headers["X-Kspec-Dir"] = ctx.rootDir;
        }

        const response = await fetch(`${daemonConn.url}/api/agent/dispatch/start`, {
          method: "POST",
          headers,
        });

        if (!response.ok) {
          const body = await response.text();
          error(`Failed to start dispatch engine: ${response.status} - ${body}`);
          process.exit(EXIT_CODES.ERROR);
        }

        const data = await response.json() as {
          started: boolean;
          reason?: string;
          status?: { running: boolean; activeInvocations: number; queuedInvocations: number };
        };

        output(data, () => {
          if (data.started) {
            success("Dispatch engine started");
          } else {
            console.log(chalk.yellow(`Dispatch engine: ${data.reason ?? "already running"}`));
          }
        });
      } catch (err) {
        error("Failed to start dispatch engine", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-agent-commands ac-5
  dispatch
    .command("stop")
    .description("Stop the dispatch engine gracefully")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const daemonConn = getDaemonUrl();

        if (!daemonConn) {
          error(
            "Daemon is not running.",
            { suggestion: "Start the daemon with: kspec serve" },
          );
          process.exit(EXIT_CODES.ERROR);
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (ctx.rootDir) {
          headers["X-Kspec-Dir"] = ctx.rootDir;
        }

        const response = await fetch(`${daemonConn.url}/api/agent/dispatch/stop`, {
          method: "POST",
          headers,
        });

        if (!response.ok) {
          const body = await response.text();
          error(`Failed to stop dispatch engine: ${response.status} - ${body}`);
          process.exit(EXIT_CODES.ERROR);
        }

        const data = await response.json() as { stopped: boolean; reason?: string };

        output(data, () => {
          if (data.stopped) {
            success("Dispatch engine stopped");
          } else {
            console.log(chalk.yellow(`Dispatch engine: ${data.reason ?? "not running"}`));
          }
        });
      } catch (err) {
        error("Failed to stop dispatch engine", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });

  // AC: @cli-agent-commands ac-9
  dispatch
    .command("status")
    .description("Show dispatch engine status and loaded agents")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const daemonConn = getDaemonUrl();

        if (!daemonConn) {
          // Daemon not running — show as disabled
          output(
            { running: false, activeInvocations: 0, queuedInvocations: 0, agents: [] },
            () => {
              console.log(chalk.bold("Dispatch Status"));
              console.log();
              console.log(`  Dispatch engine: ${chalk.gray("not available (daemon offline)")}`);
              console.log(chalk.gray("  Start daemon with: kspec serve"));
            },
          );
          return;
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {};
        if (ctx.rootDir) {
          headers["X-Kspec-Dir"] = ctx.rootDir;
        }

        // Get dispatch status
        const statusResponse = await fetch(`${daemonConn.url}/api/agent/dispatch/status`, { headers });
        if (!statusResponse.ok) {
          error(`Daemon returned error: ${statusResponse.status}`);
          process.exit(EXIT_CODES.ERROR);
        }

        const statusData = await statusResponse.json() as {
          running: boolean;
          activeInvocations: number;
          queuedInvocations: number;
        };

        // Get loaded agents
        let agents: Array<{ id: string; name: string }> = [];
        try {
          const meta = await loadMetaContext(ctx);
          agents = meta.agents.map((a) => ({ id: a.id, name: a.name }));
        } catch {
          // Meta may not be available
        }

        const fullData = { ...statusData, agents };

        output(fullData, () => {
          console.log(chalk.bold("Dispatch Status"));
          console.log();
          console.log(`  Engine:             ${statusData.running ? chalk.green("enabled") : chalk.yellow("disabled")}`);
          console.log(`  Active invocations: ${chalk.cyan(String(statusData.activeInvocations))}`);
          console.log(`  Queued invocations: ${chalk.cyan(String(statusData.queuedInvocations))}`);
          console.log();
          console.log(chalk.bold("Loaded Agents:"));
          if (agents.length === 0) {
            console.log(chalk.gray("  (none defined)"));
          } else {
            for (const a of agents) {
              console.log(`  ${chalk.cyan(a.id)}  ${chalk.gray(a.name)}`);
            }
          }
        });
      } catch (err) {
        error("Failed to get dispatch status", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
