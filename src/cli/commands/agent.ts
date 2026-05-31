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
import { initContext, loadMetaContext, findTaskByRef } from "../../parser/index.js";
import { resolveTaskDataManager } from "../../parser/task-data-manager.js";
import { runInvocation } from "../../agent-runtime/invocation.js";
import type { SessionUpdate } from "../../acp/index.js";
import { buildPromptWithSkills, interpolateTemplate } from "../../agent-runtime/prompts.js";
import { resolveAdapter } from "../../agents/adapters.js";
import {
  resolveEffectiveRunners,
  type EffectiveRunnerRegistry,
} from "../../agents/runner-config.js";
import {
  probeRunnerInvocationExecutable,
  resolveRunnerInvocation,
  RunnerResolutionError,
  summarizeRunnerInvocation,
  type PreflightUnspawnableReason,
  type RunnerInvocationSummary,
} from "../../agents/runners.js";
import { ulid } from "ulid";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, output, success, warn, isJsonMode } from "../output.js";
import { parseIntOption, validateEnumOption } from "../validators.js";
import { getRunningDaemonClient } from "../daemon-client.js";
import { errors } from "../../strings/errors.js";
import type { LoadedAgent } from "../../parser/meta.js";
import { requestEndLoop } from "../../sessions/index.js";
import { AgentDispatchAutomationFilterSchema } from "../../schema/index.js";
import { describeEnumValues } from "../enum-help.js";
import WsDefault from "ws";

// WebSocket constructor that works on Node 18+.
// Uses the ws package by default. Tests override via _setWebSocketCtor.
const WsFallback = WsDefault as unknown as typeof WebSocket;
let _wsCtor: typeof WebSocket = WsFallback;

/** @internal Test-only: override the WebSocket constructor used by dispatch watch. */
export function _setWebSocketCtor(ctor: typeof WebSocket | null): void {
  _wsCtor = ctor ?? WsFallback;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Resolve the effective adapter identity for an agent definition.
 *
 * When the agent declares a `runner` field that resolves in the effective
 * runner registry, the runner's adapter wins over the legacy `adapter`
 * field. When the runner is missing from the registry (or no runner is
 * configured at all), the legacy `adapter` field is used. The final
 * fallback is the documented default "claude-agent-acp" so display
 * surfaces remain backwards-compatible for legacy agents.
 *
 * Returns both the resolved adapter and whether the runner reference was
 * resolved, so callers (e.g., `kspec agent run`) can decide whether to
 * reject an unresolved runner reference at invocation time.
 *
 * AC: @agent-runner-configuration ac-runner-precedence-over-adapter
 * AC: @agent-runner-configuration ac-adapter-field-backcompat
 * AC: @runner-operator-surfaces ac-agent-list-shows-runner
 */
function resolveAgentAdapter(
  agentDef: { runner?: string; adapter?: string },
  registry: EffectiveRunnerRegistry,
): { adapterId: string; runnerResolved: boolean } {
  if (agentDef.runner) {
    const runner = registry.runners[agentDef.runner];
    if (runner) {
      return { adapterId: runner.adapter, runnerResolved: true };
    }
    return {
      adapterId: agentDef.adapter ?? "claude-agent-acp",
      runnerResolved: false,
    };
  }
  return {
    adapterId: agentDef.adapter ?? "claude-agent-acp",
    runnerResolved: false,
  };
}

/**
 * Format dispatch rules summary for display.
 */
function formatDispatchRules(agent: LoadedAgent): string {
  if (!agent.dispatch || agent.dispatch.length === 0) {
    return "(none)";
  }
  return agent.dispatch
    .map((r) => {
      const filterParts: string[] = [];
      if (r.filter?.automation) filterParts.push(`automation=${r.filter.automation}`);
      if (r.filter?.tags?.length) filterParts.push(`tags=${r.filter.tags.join(",")}`);
      if (r.filter?.priority !== undefined) filterParts.push(`priority=${r.filter.priority}`);
      const filterStr = filterParts.length > 0 ? ` [${filterParts.join(", ")}]` : "";
      return `${r.on}${filterStr}`;
    })
    .join(", ");
}

/**
 * Build the runner invocation diagnostic block for `kspec agent run --dry-run`.
 *
 * Resolves the runner invocation contract the same way `runInvocation` would,
 * then probes the configured executable (when the runner contributed one) so
 * the dry-run output reports the spawnability outcome alongside the rest of
 * the process inputs. Resolution failures (unknown runner, invalid adapter,
 * missing secret, etc.) are reported in the summary as a typed `error` block
 * instead of throwing — the dry-run is a preview surface and should never
 * abort solely because the runner is misconfigured.
 *
 * AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
 * AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
 */
type DryRunRunnerInvocationDiagnostic =
  | { resolved: true; summary: RunnerInvocationSummary }
  | {
      resolved: false;
      error: { reason: string; message: string; details?: Record<string, unknown> };
    };

type DryRunPreflightOutcome =
  | { status: "ok"; resolved: string }
  | { status: "unspawnable"; reason: PreflightUnspawnableReason; message: string }
  | { status: "skipped" };

async function buildDryRunInvocationSummary(input: {
  agentDef: LoadedAgent;
  runnerRegistry: EffectiveRunnerRegistry;
  adapterOverride: string | undefined;
  cwd: string;
}): Promise<DryRunRunnerInvocationDiagnostic> {
  let contract;
  try {
    contract = resolveRunnerInvocation({
      agent: input.agentDef,
      registry: input.runnerRegistry,
      cwd: input.cwd,
      sessionId: ulid(),
      autoApprove: input.agentDef.auto_approve,
      env: {},
      adapterOverride: input.adapterOverride,
    });
  } catch (err) {
    if (err instanceof RunnerResolutionError) {
      return {
        resolved: false,
        error: { reason: err.reason, message: err.message, details: { ...err.details } },
      };
    }
    return {
      resolved: false,
      error: {
        reason: "preflight_failure",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Probe the runner-configured executable using the same env-aware
  // searchPath the spawn path would consult. Failures are reported as a
  // typed preflight diagnostic rather than thrown — dry-run is a preview
  // surface and operators want to inspect unspawnable diagnostics, not have
  // the preview abort partway through.
  let preflight: DryRunPreflightOutcome;
  const probe = await probeRunnerInvocationExecutable(contract);
  if (probe === null) {
    preflight = { status: "skipped" };
  } else if (probe.spawnable) {
    preflight = { status: "ok", resolved: probe.resolved };
  } else {
    preflight = { status: "unspawnable", reason: probe.reason, message: probe.message };
  }

  const effectiveRunner = contract.runnerId
    ? input.runnerRegistry.runners[contract.runnerId]
    : undefined;
  const summary = summarizeRunnerInvocation(contract, {
    effectiveRunner,
    preflight,
  });
  return { resolved: true, summary };
}

function renderDryRunInvocationSummary(diag: DryRunRunnerInvocationDiagnostic): void {
  if (!diag.resolved) {
    console.log();
    console.log(chalk.yellow(`Runner invocation: unresolved (${diag.error.reason})`));
    console.log(chalk.gray(`  ${diag.error.message}`));
    return;
  }
  const s = diag.summary;
  console.log();
  console.log(chalk.gray("--- Runner invocation contract ---"));
  if (s.runner.name) {
    console.log(chalk.gray(`Runner:  ${s.runner.name} (source: ${s.source_layer})`));
  } else {
    console.log(chalk.gray(`Runner:  (implicit / legacy path)`));
  }
  console.log(chalk.gray(`Adapter: ${s.adapter.id} (source: ${s.adapter.source})`));
  console.log(chalk.gray(`Command: ${s.process.command} (source: ${s.process.command_source})`));
  console.log(chalk.gray(`Cwd:     ${s.process.cwd} (source: ${s.process.cwd_source})`));
  if (s.process.runner_args.length > 0) {
    console.log(
      chalk.gray(
        `Args:    [${s.process.runner_args.join(" ")}] (source: ${s.process.runner_args_source})`,
      ),
    );
  } else {
    console.log(chalk.gray(`Args:    (none from runner)`));
  }
  if (s.process.auto_approve_args.length > 0) {
    console.log(chalk.gray(`Auto-approve args: [${s.process.auto_approve_args.join(" ")}]`));
  }
  if (s.env_policy.inherit !== null) {
    console.log(chalk.gray(`Env policy:`));
    console.log(chalk.gray(`  inherit: ${s.env_policy.inherit}`));
    if (s.env_policy.pass_keys.length > 0) {
      console.log(
        chalk.gray(
          `  pass:    [${s.env_policy.pass_keys.join(", ")}] (source: ${s.env_policy.pass_source})`,
        ),
      );
    }
    if (s.env_policy.set_keys.length > 0) {
      console.log(chalk.gray(`  set:     [${s.env_policy.set_keys.join(", ")}]`));
    }
    if (s.env_policy.secret_keys.length > 0) {
      console.log(
        chalk.gray(
          `  secrets: [${s.env_policy.secret_keys.join(", ")}] (source: ${s.env_policy.secret_source})`,
        ),
      );
    }
  } else {
    console.log(
      chalk.gray(
        `Env policy: implicit (host process env inherited: ${s.env_policy.inherit_parent_env})`,
      ),
    );
  }
  if (s.preflight.status === "ok") {
    console.log(chalk.gray(`Preflight: ok (resolved: ${s.preflight.resolved ?? ""})`));
  } else if (s.preflight.status === "unspawnable") {
    console.log(
      chalk.yellow(
        `Preflight: unspawnable (${s.preflight.reason ?? ""}) — ${s.preflight.message ?? ""}`,
      ),
    );
  } else {
    console.log(chalk.gray(`Preflight: skipped (no runner-configured command)`));
  }
}

// ─── Command Registration ─────────────────────────────────────────────────────

/**
 * Register the kspec agent command family.
 * AC: @cli-agent-commands ac-1 through ac-10
 */
export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Manage and run agents");

  // ─── kspec agent list ─────────────────────────────────────────────────────

  // AC: @cli-agent-commands ac-1
  // AC: @trait-filterable-list ac-1 through ac-8
  agent
    .command("list")
    .description("List all agent definitions")
    .option("--json", "Output as JSON")
    .option(
      "--status <status>",
      describeEnumValues(
        "Filter by automation status",
        AgentDispatchAutomationFilterSchema.options,
        "|",
      ),
    )
    .option(
      "--tag <tag>",
      "Filter by tag (repeatable)",
      (val: string, arr: string[]) => [...arr, val],
      [] as string[],
    )
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
        // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
        // AC: @runner-operator-surfaces ac-agent-list-shows-runner
        // Resolve the effective runner registry once so each entry can show
        // its runner-derived adapter identity rather than the raw legacy
        // adapter field. Loading failures degrade silently — agents without
        // runner references fall back to the legacy adapter and remain
        // listable.
        let runnerRegistry: EffectiveRunnerRegistry = { runners: {} };
        try {
          const resolved = await resolveEffectiveRunners({
            projectRoot: ctx.projectRoot,
            shadowWorktreeDir: ctx.specDir,
          });
          runnerRegistry = resolved.registry;
        } catch {
          // Runner config is optional for list — agents without runner fields
          // remain unaffected when the registry cannot be loaded.
        }
        let agents = meta.agents;

        // AC: @trait-filterable-list ac-1 - automation status filter
        if (opts.status) {
          const statusResult = validateEnumOption(
            opts.status,
            AgentDispatchAutomationFilterSchema.options,
            "agent automation status",
          );
          if (!statusResult.ok) {
            error(statusResult.error, {
              suggestion: `Valid statuses: ${AgentDispatchAutomationFilterSchema.options.join(", ")}`,
            });
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          agents = agents.filter(
            (a) => (a as LoadedAgent & { automation?: string }).automation === statusResult.value,
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
        // AC: @trait-semantic-exit-codes ac-2 - invalid numeric input exits with validation error
        let limit = total;
        if (opts.limit !== undefined) {
          const parsed = parseIntOption(opts.limit, {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            name: "Limit",
          });
          if (!parsed.ok) {
            error(`Invalid --limit value: ${parsed.error}`, { suggestion: "Example: --limit 10" });
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          limit = parsed.value;
        }
        let offset = 0;
        if (opts.offset !== undefined) {
          const parsed = parseIntOption(opts.offset, {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            name: "Offset",
          });
          if (!parsed.ok) {
            error(`Invalid --offset value: ${parsed.error}`, { suggestion: "Example: --offset 5" });
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          offset = parsed.value;
        }
        const paginated = agents.slice(offset, offset + limit);

        // AC: @trait-semantic-exit-codes ac-5 - empty result set exits 0
        // AC: @trait-filterable-list ac-6 - empty list with informative message
        if (paginated.length === 0) {
          output({ items: [], total, offset, limit }, () => {
            if (opts.status || tags.length > 0) {
              console.log("No agents match the specified filters.");
            } else {
              console.log("No agent definitions found.");
            }
          });
          return;
        }

        // AC: @trait-json-output ac-1 through ac-5
        // AC: @trait-json-output ac-2 - JSON includes all data available in human-readable mode
        // AC: @runner-operator-surfaces ac-agent-list-shows-runner — JSON includes runner when present
        // AC: @agent-runner-configuration ac-adapter-field-backcompat — adapter still emitted
        // AC: @agent-runner-configuration ac-runner-precedence-over-adapter — emit runner-resolved adapter
        output(
          {
            items: paginated.map((a) => {
              const { adapterId } = resolveAgentAdapter(a, runnerRegistry);
              const item: Record<string, unknown> = {
                id: a.id,
                name: a.name,
                adapter: adapterId,
                dispatch: a.dispatch ?? [],
                concurrency: a.concurrency ?? { max_concurrent: 1 },
              };
              if (a.runner) item.runner = a.runner;
              if (a.session) item.session = a.session;
              if (a.budget) item.budget = a.budget;
              if (a.skills && a.skills.length > 0) item.skills = a.skills;
              if (a.tags && a.tags.length > 0) item.tags = a.tags;
              if (a.automation) item.automation = a.automation;
              if (a.prompt_template) item.prompt_template = a.prompt_template;
              return item;
            }),
            total,
            offset,
            limit,
          },
          () => {
            // AC: @trait-filterable-list ac-7 - summary with total and filter state
            const filterDesc = [
              opts.status ? `status=${opts.status}` : "",
              tags.length > 0 ? `tags=${tags.join(",")}` : "",
            ]
              .filter(Boolean)
              .join(", ");
            const summaryStr = filterDesc ? ` (filtered: ${filterDesc})` : "";
            console.log(chalk.bold(`Agents${summaryStr}: ${paginated.length} of ${total}`));
            console.log();

            for (const a of paginated) {
              // AC: @runner-operator-surfaces ac-agent-list-shows-runner — show runner-resolved adapter
              // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
              const { adapterId } = resolveAgentAdapter(a, runnerRegistry);
              console.log(`  ${chalk.cyan(a.id)}  ${chalk.gray(adapterId)}`);
              // AC: @runner-operator-surfaces ac-agent-list-shows-runner
              // AC: @agent-runner-configuration ac-agent-runner-reference
              if (a.runner) {
                console.log(`    ${chalk.gray("runner:")} ${a.runner}`);
              }
              console.log(`    ${chalk.gray("dispatch:")} ${formatDispatchRules(a)}`);
              console.log(
                `    ${chalk.gray("concurrency:")} max ${a.concurrency?.max_concurrent ?? 1}`,
              );
              // AC: @cli-agent-commands ac-1 - show optional fields when present
              if (a.session) {
                const parts: string[] = [`mode=${a.session.mode ?? "auto_close"}`];
                if (a.session.idle_grace_period_ms !== undefined)
                  parts.push(`grace=${a.session.idle_grace_period_ms}ms`);
                if (a.session.idle_timeout_ms !== undefined)
                  parts.push(`timeout=${a.session.idle_timeout_ms}ms`);
                console.log(`    ${chalk.gray("session:")} ${parts.join(", ")}`);
              }
              if (a.budget) {
                const parts: string[] = [];
                if (a.budget.max_tasks !== undefined) parts.push(`max_tasks=${a.budget.max_tasks}`);
                if (a.budget.timeout_minutes !== undefined)
                  parts.push(`timeout=${a.budget.timeout_minutes}m`);
                if (a.budget.max_retries !== undefined)
                  parts.push(`max_retries=${a.budget.max_retries}`);
                if (parts.length > 0)
                  console.log(`    ${chalk.gray("budget:")} ${parts.join(", ")}`);
              }
              if (a.skills && a.skills.length > 0) {
                console.log(`    ${chalk.gray("skills:")} ${a.skills.join(", ")}`);
              }
              if (a.tags && a.tags.length > 0) {
                console.log(`    ${chalk.gray("tags:")} ${a.tags.join(", ")}`);
              }
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
          error(`Agent "${agentId}" not found.`, {
            suggestion: `Check available agents with: kspec agent list`,
          });
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }

        // AC: @agent-runner-configuration ac-runner-precedence-over-adapter
        // Load the effective runner registry so a configured runner reference
        // determines the resolved adapter / execution harness for this
        // invocation rather than the legacy adapter field.
        let runRegistry: EffectiveRunnerRegistry = { runners: {} };
        try {
          const resolved = await resolveEffectiveRunners({
            projectRoot: ctx.projectRoot,
            shadowWorktreeDir: ctx.specDir,
          });
          runRegistry = resolved.registry;
        } catch {
          // Defer to the registry's empty fallback — unresolved runner
          // references are caught explicitly below.
        }

        // Resolve the effective adapter
        // AC: @agent-runner-configuration ac-runner-precedence-over-adapter — runner wins over adapter
        // AC: @agent-runner-configuration ac-adapter-field-backcompat — legacy adapter still works
        // AC: @cli-agent-commands ac-7 — --adapter CLI override still wins over both
        const { adapterId: runnerResolvedAdapter, runnerResolved } = resolveAgentAdapter(
          agentDef,
          runRegistry,
        );
        if (agentDef.runner && !runnerResolved && !opts.adapter) {
          error(`Agent "${agentId}" references unknown runner "${agentDef.runner}".`, {
            suggestion: `Configure the runner via system or project runner config, or run with --adapter <id> to override.`,
          });
          process.exit(EXIT_CODES.VALIDATION_FAILED);
        }
        const adapterId = opts.adapter ?? runnerResolvedAdapter;
        const _adapter = resolveAdapter(adapterId);

        // Build the prompt — respect agent prompt_template when --task is used
        const taskRef = opts.task as string | undefined;
        let basePrompt: string;
        if (prompt) {
          // Explicit user prompt always wins
          basePrompt = prompt;
        } else if (taskRef && agentDef.prompt_template) {
          // Use agent's prompt_template with variable interpolation.
          // Best-effort task title resolution — falls back to "(unavailable)".
          let taskTitle = "(unavailable)";
          try {
            const tasks = await resolveTaskDataManager(ctx).loadAllTasks(ctx);
            const task = findTaskByRef(tasks, taskRef);
            if (task?.title) taskTitle = task.title;
          } catch {
            // Non-fatal — template still works with fallback title
          }
          basePrompt = interpolateTemplate(agentDef.prompt_template, {
            task_ref: taskRef,
            task_title: taskTitle,
            trigger: "manual",
            review_url: "",
          });
        } else if (taskRef) {
          basePrompt = `Work on task ${taskRef} according to your configuration and skills.`;
        } else {
          basePrompt = `Run as requested.`;
        }

        // Note: buildPromptWithSkills is called here for the dry-run preview path.
        // runInvocation also calls buildPromptWithSkills internally, so we pass basePrompt
        // to runInvocation (not fullPrompt) to avoid double-expansion.
        const fullPromptForPreview = await buildPromptWithSkills({
          basePrompt,
          skillIds: agentDef.skills ?? [],
          specDir: ctx.specDir,
          adapterId,
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
              error(`Invalid --timeout value: ${parsed.error}`, {
                suggestion: "Example: --timeout 30",
              });
              process.exit(EXIT_CODES.VALIDATION_FAILED);
            }
            dryTimeoutOverride = parsed.value;
          }
          let dryBudgetOverride: number | undefined;
          if (opts.budget) {
            const parsed = parseIntOption(opts.budget, { min: 1, max: 99999, name: "Budget" });
            if (!parsed.ok) {
              error(`Invalid --budget value: ${parsed.error}`, {
                suggestion: "Example: --budget 10",
              });
              process.exit(EXIT_CODES.VALIDATION_FAILED);
            }
            dryBudgetOverride = parsed.value;
          }

          const effectiveTimeoutMinutes = dryTimeoutOverride ?? agentDef.budget?.timeout_minutes;
          const effectiveMaxTasks = dryBudgetOverride ?? agentDef.budget?.max_tasks;

          // Resolve the runner invocation contract so dry-run reports the
          // command reference, cwd, args, and env policy that the actual
          // spawn would apply. This surfaces the runner process inputs in
          // the same shape they are described in the task spec — without
          // ever spawning the adapter or exposing env values.
          //
          // AC: @runner-process-invocation-inputs ac-existing-executable-reference-resolves
          // AC: @runner-process-invocation-inputs ac-runner-args-extend-acp-invocation
          // AC: @runner-process-invocation-inputs ac-runner-cwd-is-invocation-only
          // AC: @runner-process-invocation-inputs ac-invocation-diagnostics-identify-inputs
          const dryRunSummary = await buildDryRunInvocationSummary({
            agentDef,
            runnerRegistry: runRegistry,
            adapterOverride: opts.adapter as string | undefined,
            cwd: ctx.rootDir,
          });

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
              runner_invocation: dryRunSummary,
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
              renderDryRunInvocationSummary(dryRunSummary);
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
            error(`Invalid --timeout value: ${parsed.error}`, {
              suggestion: "Example: --timeout 30",
            });
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          timeoutOverride = parsed.value;
        }
        let budgetOverride: number | undefined;
        if (opts.budget) {
          const parsed = parseIntOption(opts.budget, { min: 1, max: 99999, name: "Budget" });
          if (!parsed.ok) {
            error(`Invalid --budget value: ${parsed.error}`, {
              suggestion: "Example: --budget 10",
            });
            process.exit(EXIT_CODES.VALIDATION_FAILED);
          }
          budgetOverride = parsed.value;
        }

        const effectiveAgent = {
          ...agentDef,
          // AC: @cli-agent-commands ac-7 — --adapter override bypasses the
          // configured runner so the resolver takes the implicit path with
          // the override adapter.
          runner: opts.adapter ? undefined : agentDef.runner,
          adapter: adapterId,
          budget:
            timeoutOverride !== undefined || budgetOverride !== undefined
              ? {
                  ...agentDef.budget,
                  timeout_minutes: timeoutOverride ?? agentDef.budget?.timeout_minutes,
                  max_tasks: budgetOverride ?? agentDef.budget?.max_tasks,
                }
              : agentDef.budget,
        };

        console.log(chalk.gray(`Running agent "${agentId}"...`));

        // AC: @cli-agent-commands ac-12 — stream text to stdout in interactive mode
        // AC: @cli-agent-commands ac-11 — suppress streaming in --json mode
        let didStream = false;
        const onUpdate = isJsonMode()
          ? undefined
          : (update: SessionUpdate) => {
              if (
                update.sessionUpdate === "agent_message_chunk" &&
                update.content.type === "text"
              ) {
                process.stdout.write(update.content.text);
                didStream = true;
              }
            };

        // AC: @cli-agent-commands ac-3 - no task binding when --task not provided
        // Pass basePrompt (not fullPromptForPreview) — runInvocation expands skills internally
        // AC: @runner-resolution-and-preflight ac-one-shot-uses-runner-resolution
        // Pass the pre-loaded runner registry so the resolver sees the same
        // state as the CLI did for runner display + override decisions.
        const result = await runInvocation({
          agent: effectiveAgent,
          specDir: ctx.specDir,
          cwd: ctx.rootDir,
          taskRef: taskRef ?? undefined,
          prompt: basePrompt,
          trigger: "manual",
          onUpdate,
          runnerRegistry: runRegistry,
        });

        // Ensure summary starts on its own line after streamed content
        if (didStream) process.stdout.write("\n");

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
    .action(async (_opts) => {
      try {
        const daemon = getRunningDaemonClient();

        // AC: @trait-error-guidance ac-1, ac-2
        if (!daemon) {
          error("Daemon is not running. Cannot retrieve agent status.", {
            suggestion: "Start the daemon with: kspec serve",
          });
          process.exit(EXIT_CODES.ERROR);
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {};
        if (ctx.projectRoot) {
          headers["X-Kspec-Dir"] = ctx.projectRoot;
        }

        const response = await fetch(`${daemon.apiUrl}/api/agent/dispatch/status`, { headers });
        if (!response.ok) {
          error(`Daemon returned error: ${response.status} ${response.statusText}`);
          process.exit(EXIT_CODES.ERROR);
        }

        // AC: @cli-agent-commands ac-6
        const data = (await response.json()) as {
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
          console.log(
            `  Dispatch engine: ${data.running ? chalk.green("running") : chalk.gray("stopped")}`,
          );
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
              console.log(
                `    session: ${chalk.gray(inv.sessionId)}  elapsed: ${elapsed}s${taskStr}`,
              );
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

  const dispatch = agent.command("dispatch").description("Manage the agent dispatch engine");

  // AC: @cli-agent-commands ac-4
  // AC: @cli-agent-commands ac-10
  dispatch
    .command("start")
    .description("Start the dispatch engine (daemon must be running)")
    .option("--json", "Output as JSON")
    .action(async (_opts) => {
      try {
        const daemon = getRunningDaemonClient();

        // AC: @cli-agent-commands ac-10 - error when daemon not running
        if (!daemon) {
          error("Daemon is not running. The dispatch engine requires the daemon.", {
            suggestion: "Start the daemon first with: kspec serve",
          });
          process.exit(EXIT_CODES.ERROR);
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (ctx.projectRoot) {
          headers["X-Kspec-Dir"] = ctx.projectRoot;
          if (ctx.rootDir !== ctx.projectRoot) {
            headers["X-Kspec-Cwd"] = ctx.rootDir;
          }
        }

        const response = await fetch(`${daemon.apiUrl}/api/agent/dispatch/start`, {
          method: "POST",
          headers,
        });

        if (!response.ok) {
          const body = await response.text();
          error(`Failed to start dispatch engine: ${response.status} - ${body}`);
          process.exit(EXIT_CODES.ERROR);
        }

        const data = (await response.json()) as {
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
    .action(async (_opts) => {
      try {
        const daemon = getRunningDaemonClient();

        if (!daemon) {
          error("Daemon is not running.", { suggestion: "Start the daemon with: kspec serve" });
          process.exit(EXIT_CODES.ERROR);
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (ctx.projectRoot) {
          headers["X-Kspec-Dir"] = ctx.projectRoot;
        }

        const response = await fetch(`${daemon.apiUrl}/api/agent/dispatch/stop`, {
          method: "POST",
          headers,
        });

        if (!response.ok) {
          const body = await response.text();
          error(`Failed to stop dispatch engine: ${response.status} - ${body}`);
          process.exit(EXIT_CODES.ERROR);
        }

        const data = (await response.json()) as { stopped: boolean; reason?: string };

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
    .action(async (_opts) => {
      try {
        const daemon = getRunningDaemonClient();

        if (!daemon) {
          // Daemon not running — show as disabled
          output({ running: false, activeInvocations: 0, queuedInvocations: 0, agents: [] }, () => {
            console.log(chalk.bold("Dispatch Status"));
            console.log();
            console.log(`  Dispatch engine: ${chalk.gray("not available (daemon offline)")}`);
            console.log(chalk.gray("  Start daemon with: kspec serve"));
          });
          return;
        }

        const ctx = await initContext();

        const headers: Record<string, string> = {};
        if (ctx.projectRoot) {
          headers["X-Kspec-Dir"] = ctx.projectRoot;
        }

        // Get dispatch status
        const statusResponse = await fetch(`${daemon.apiUrl}/api/agent/dispatch/status`, {
          headers,
        });
        if (!statusResponse.ok) {
          error(`Daemon returned error: ${statusResponse.status}`);
          process.exit(EXIT_CODES.ERROR);
        }

        const statusData = (await statusResponse.json()) as {
          running: boolean;
          activeInvocations: number;
          queuedInvocations: number;
          degraded?: {
            active: boolean;
            reason: string;
            enteredAt: string | null;
          };
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
          // AC: @dispatch-remote-branch-sync ac-degraded-status-api — prominent warning
          if (statusData.degraded?.active) {
            console.log(
              `${chalk.bgRed.white.bold("  ⚠ DEGRADED  ")} ${chalk.red("New workspace provisioning is paused")}`,
            );
            console.log(`  ${chalk.red("Reason:")} ${statusData.degraded.reason}`);
            if (statusData.degraded.enteredAt) {
              const enteredAt = new Date(statusData.degraded.enteredAt);
              const durationMs = Date.now() - enteredAt.getTime();
              const durationMin = Math.round(durationMs / 60_000);
              console.log(
                `  ${chalk.red("Since:")} ${enteredAt.toLocaleString()} (${durationMin}m ago)`,
              );
            }
            console.log();
          }
          console.log(
            `  Engine:             ${statusData.running ? chalk.green("enabled") : chalk.yellow("disabled")}`,
          );
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

  // ─── kspec agent dispatch watch ───────────────────────────────────────────

  // AC: @cli-agent-commands ac-13 through ac-18
  // AC: @ws-session-event-streaming ac-cli-watch-parity
  dispatch
    .command("watch")
    .description("Stream live agent activity via WebSocket event stream")
    .option("--agent <name>", "Only show output from this agent")
    .option("--session <id>", "Only show output from this session")
    .option("--retries <n>", "Number of reconnect attempts on disconnect (default 5)", "5")
    .option("--verbose", "Show thinking blocks (hidden by default)")
    .action(async (opts) => {
      const _DEFAULT_RETRIES = 5;
      const RETRY_BASE_MS = 1000;
      const MAX_RETRY_MS = 30_000;

      const parsedRetries = parseIntOption(opts.retries, {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        name: "Retries",
      });
      if (!parsedRetries.ok) {
        error(`Invalid --retries value: ${parsedRetries.error}`, {
          suggestion: "Example: --retries 5",
        });
        process.exit(EXIT_CODES.VALIDATION_FAILED);
        return;
      }
      const retryLimit = parsedRetries.value;

      // AC: @cli-agent-commands ac-15 — error when daemon is not running.
      // Validate local numeric options first so invalid CLI input returns the
      // validation exit code even on machines where the daemon is unavailable.
      const daemon = getRunningDaemonClient();
      if (!daemon) {
        error("Daemon is not running. The watch command requires the daemon.");
        info("Suggestion: Start the daemon with: kspec serve");
        // AC: @cli-agent-commands ac-15 — exit code 3
        process.exit(EXIT_CODES.NOT_FOUND);
        return;
      }
      const agentFilter: string | undefined = opts.agent;
      const sessionFilter: string | undefined = opts.session;
      const verbose: boolean = opts.verbose === true;
      type StreamRenderState = {
        hasRenderedBody: boolean;
        spacerPending: boolean;
      };
      const streamStates = new Map<string, StreamRenderState>();
      let activeStreamKey: string | null = null;
      let outputAtLineStart = true;

      function getStreamState(streamKey: string): StreamRenderState {
        let state = streamStates.get(streamKey);
        if (!state) {
          state = { hasRenderedBody: false, spacerPending: false };
          streamStates.set(streamKey, state);
        }
        return state;
      }

      function writeRaw(text: string): void {
        if (!text) return;
        process.stdout.write(text);
        outputAtLineStart = text.endsWith("\n");
      }

      function writeSpeakerText(text: string): void {
        if (!text) return;

        writeRaw(text);
      }

      function ensureLineBreak(): void {
        if (!outputAtLineStart) {
          writeRaw("\n");
        }
      }

      function startSpeakerSection(streamKey: string, prefix: string): void {
        if (activeStreamKey === streamKey) return;
        if (activeStreamKey) {
          ensureLineBreak();
        }
        writeRaw(`${prefix}\n`);
        activeStreamKey = streamKey;
      }

      function queuePrefixedChunk(streamKey: string, prefix: string, text: string): void {
        if (!text) return;
        const switchingSpeaker = activeStreamKey !== null && activeStreamKey !== streamKey;
        startSpeakerSection(streamKey, prefix);
        const state = getStreamState(streamKey);
        if (switchingSpeaker) {
          // Marker change already separates context; don't carry stale spacer
          // into the top of a newly active speaker section.
          state.spacerPending = false;
        } else if (state.spacerPending && state.hasRenderedBody) {
          ensureLineBreak();
          writeRaw("\n");
          state.spacerPending = false;
        }
        writeSpeakerText(text);
        state.hasRenderedBody = true;
      }

      function markMessageBoundary(streamKey: string): void {
        // Boundary signals are stream-local; ignore inactive streams.
        if (activeStreamKey !== streamKey) return;
        const state = getStreamState(streamKey);
        ensureLineBreak();
        // Coalesce repeated boundary events into one pending spacer.
        if (state.hasRenderedBody) {
          state.spacerPending = true;
        }
      }

      // oxlint-disable-next-line unicorn/consistent-function-scoping
      function formatSessionIdForDisplay(sessionId: string): string {
        // AC: @cli-agent-commands ac-17 — shorten session ULID in watch prefix.
        return sessionId ? sessionId.slice(0, 8) : "";
      }

      // oxlint-disable-next-line unicorn/consistent-function-scoping
      function summarizeToolInput(input: unknown): string {
        if (input == null) return "";
        try {
          const str = typeof input === "string" ? input : JSON.stringify(input);
          if (str.length <= 80) return ` (${str})`;
          return ` (${str.slice(0, 77)}...)`;
        } catch {
          return "";
        }
      }

      // Resolve project dir for WebSocket project binding
      let projectDir: string | undefined;
      try {
        const ctx = await initContext();
        projectDir = ctx.projectRoot;
      } catch {
        // non-fatal: WebSocket will use daemon default
      }

      let retryCount = 0;
      let shouldReconnect = true;

      function connect(): void {
        // AC: @daemon-network-endpoint-contract ac-clients-use-metadata
        const wsUrl = new URL(daemon!.wsUrl);
        if (projectDir) {
          wsUrl.searchParams.set("project", projectDir);
        }

        // Use _wsCtor (ws package by default; tests override via _setWebSocketCtor).
        // Always uses ws instead of native globalThis.WebSocket for Node < 22 compat.
        const ws = new _wsCtor(wsUrl.toString());

        ws.addEventListener("open", () => {
          retryCount = 0;
          // Subscribe to agents topic
          ws.send(
            JSON.stringify({
              action: "subscribe",
              request_id: "watch-subscribe",
              payload: { topics: ["agents"] },
            }),
          );
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(event.data as string);
          } catch {
            return;
          }

          // AC: @cli-agent-commands ac-18 — fail fast on subscribe handshake rejection.
          if (msg.ack === true && msg.request_id === "watch-subscribe") {
            if (msg.success === false) {
              shouldReconnect = false;
              const reasonParts = [msg.error, msg.details].filter(
                (value): value is string => typeof value === "string" && value.length > 0,
              );
              const reason = reasonParts.length > 0 ? ` (${reasonParts.join(": ")})` : "";
              if (activeStreamKey) {
                ensureLineBreak();
              }
              error(`Failed to subscribe to daemon agent output stream${reason}.`);
              info(
                "Suggestion: Verify daemon logs for subscribe errors, then restart with: kspec serve",
              );
              process.exit(EXIT_CODES.NOT_FOUND);
            }
            return;
          }

          // AC: @cli-agent-commands ac-13 — stream session events with per-line [agent-id session-id] prefixes
          // AC: @session-event-broadcast ac-replaces-text-chunks
          const eventType = msg.event as string;
          const sessionEventTypes = new Set([
            "message_start",
            "message_progress",
            "message_complete",
            "thinking_start",
            "thinking_progress",
            "thinking_complete",
            "tool_call_start",
            "tool_call_input",
            "tool_call_complete",
          ]);

          if (sessionEventTypes.has(eventType) && msg.data) {
            const data = msg.data as {
              session_id?: string;
              agent_id?: string;
              text?: string;
              tool_name?: string;
              tool_input?: unknown;
              status?: string;
              duration_ms?: number;
            };
            const sessionId = data.session_id ?? "";
            const agentId = data.agent_id ?? "";

            // AC: @cli-agent-commands ac-16 — filter by agent/session if specified
            if (agentFilter && agentId !== agentFilter) return;
            if (sessionFilter && sessionId !== sessionFilter) return;

            const streamKey = `${agentId}\u0000${sessionId}`;
            const displaySessionId = formatSessionIdForDisplay(sessionId);
            const prefix = `[${agentId} ${displaySessionId}]`;

            // AC: @ws-session-event-streaming ac-cli-watch-parity
            switch (eventType) {
              case "message_progress": {
                const text = data.text ?? "";
                if (text.length > 0) {
                  queuePrefixedChunk(streamKey, prefix, text);
                }
                break;
              }
              case "message_complete": {
                const text = data.text ?? "";
                if (text.length > 0) {
                  queuePrefixedChunk(streamKey, prefix, text);
                }
                markMessageBoundary(streamKey);
                break;
              }
              case "thinking_progress": {
                if (!verbose) break;
                const text = data.text ?? "";
                if (text.length > 0) {
                  // Dim ANSI escape: \x1b[2m ... \x1b[22m
                  queuePrefixedChunk(streamKey, prefix, `\x1b[2m${text}\x1b[22m`);
                }
                break;
              }
              case "thinking_complete": {
                if (!verbose) break;
                const text = data.text ?? "";
                if (text.length > 0) {
                  queuePrefixedChunk(streamKey, prefix, `\x1b[2m${text}\x1b[22m`);
                }
                markMessageBoundary(streamKey);
                break;
              }
              case "tool_call_start": {
                markMessageBoundary(streamKey);
                const toolName = data.tool_name ?? "unknown";
                const inputSummary = summarizeToolInput(data.tool_input);
                startSpeakerSection(streamKey, prefix);
                writeRaw(`  ⚡ Tool: ${toolName}${inputSummary}\n`);
                break;
              }
              // AC: @ws-session-event-streaming ac-tool-input-update
              case "tool_call_input": {
                const toolName = data.tool_name ?? "unknown";
                const inputSummary = summarizeToolInput(data.tool_input);
                if (inputSummary) {
                  startSpeakerSection(streamKey, prefix);
                  writeRaw(`  ⚡ Tool: ${toolName}${inputSummary}\n`);
                }
                break;
              }
              case "tool_call_complete": {
                const toolName = data.tool_name ?? "unknown";
                const status = data.status ?? "unknown";
                const durationMs = data.duration_ms ?? 0;
                const durationStr =
                  durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
                startSpeakerSection(streamKey, prefix);
                writeRaw(`  ✓ ${toolName} ${status} (${durationStr})\n`);
                break;
              }
              // message_start, thinking_start — no visual output needed
              default:
                break;
            }
          }
        });

        ws.addEventListener("error", () => {
          // error event fires before close, handled in onclose
        });

        ws.addEventListener("close", () => {
          if (!shouldReconnect) return;

          if (activeStreamKey) {
            ensureLineBreak();
          }

          if (retryCount >= retryLimit) {
            // AC: @cli-agent-commands ac-14 — exit code 3 when retries exhausted
            error(
              `WebSocket connection lost and reconnection failed after ${retryLimit} attempt(s).`,
            );
            info("Suggestion: Verify the daemon is still running with: kspec serve");
            process.exit(EXIT_CODES.NOT_FOUND);
            return;
          }

          retryCount++;
          const backoffMs = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount - 1), MAX_RETRY_MS);
          // AC: @cli-agent-commands ac-14 — print reconnecting message
          process.stderr.write(
            `[watch] Connection lost. Reconnecting in ${Math.round(backoffMs / 1000)}s (attempt ${retryCount}/${retryLimit})...\n`,
          );
          setTimeout(connect, backoffMs);
        });
      }

      connect();

      // Keep process alive (WebSocket is non-blocking in Node)
      // Users interrupt with Ctrl+C
      await new Promise<void>(() => {
        /* intentionally never resolves */
      });
    });

  // ─── kspec agent end-loop ─────────────────────────────────────────────────

  // AC: @ralph-replacement ac-1 — equivalent to kspec ralph end-loop
  // AC: @session-end-loop-signal ac-signal
  agent
    .command("end-loop")
    .description("Signal the agent dispatch engine to stop after current iteration")
    .option("--reason <reason>", "Reason for ending the loop")
    .action(async (options) => {
      try {
        const ctx = await initContext();
        const sessionId = process.env.KSPEC_SESSION_ID;

        if (!sessionId) {
          // AC: @trait-error-guidance ac-1, ac-2
          warn("No active agent session detected (KSPEC_SESSION_ID not set).");
          info(
            "This command requires an active session. It is designed to be called by agents during a dispatch invocation.",
          );
          info(
            "Suggestion: Ensure KSPEC_SESSION_ID is set, or start a session with: kspec session create",
          );
          process.exit(EXIT_CODES.VALIDATION_FAILED);
          return;
        }

        // Write end-loop state to session
        const updated = await requestEndLoop(ctx.sessionsDir, sessionId, options.reason);

        if (!updated) {
          // AC: @trait-error-guidance ac-1, ac-2
          error(`Session not found: ${sessionId}`);
          info("Suggestion: Check session ID with: kspec session log list");
          process.exit(EXIT_CODES.NOT_FOUND);
          return;
        }

        success("Loop end signal sent");
        if (options.reason) {
          info(`Reason: ${options.reason}`);
        }
      } catch (err) {
        // AC: @trait-error-guidance ac-1
        error("Failed to signal end-loop", err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
