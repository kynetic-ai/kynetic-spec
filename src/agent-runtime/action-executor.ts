/**
 * Action Executor
 *
 * Unified execution engine for all action types (command, kspec, agent, notify).
 * Every execution produces an ActionRun tracking record and emits lifecycle
 * events (action.started, action.completed, action.failed).
 *
 * AC: @dispatch-action-model ac-1 through ac-9
 */

import { spawn, type ChildProcess } from "node:child_process";
import { ulid } from "ulid";
import type {
  Action,
  ActionRun,
  CommandAction,
  KspecAction,
  AgentAction,
  NotifyAction,
} from "../schema/action.js";
import { interpolateTemplate } from "./prompts.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Event context passed to action execution — the triggering event's
 * envelope and payload fields available for template interpolation.
 */
export interface ActionEventContext {
  /** Event envelope fields */
  event_id: string;
  event_type: string;
  correlation_id?: string;
  causation_id?: string;
  source_type?: string;
  source_id?: string;
  /** Event payload fields (flattened for template access) */
  [key: string]: string | number | boolean | undefined;
}

/**
 * Callback for action run lifecycle events.
 */
export interface ActionRunEvent {
  type: "action.started" | "action.completed" | "action.failed";
  action_run: ActionRun;
  event_context: ActionEventContext;
}

/**
 * Callback signature for broadcasting notifications (notify action).
 * AC: @dispatch-action-model ac-6
 */
export type NotifyBroadcast = (
  topic: string,
  event: string,
  data: Record<string, unknown>,
) => void;

/**
 * Callback for spawning agent invocations (agent action).
 * Returns the invocation/session ID on success.
 * AC: @dispatch-action-model ac-4, ac-5
 */
export type AgentSpawner = (options: {
  agent_id: string;
  prompt?: string;
  task_ref?: string;
  timeout_minutes?: number;
  correlation_id?: string;
}) => Promise<{ invocation_id: string }>;

/**
 * Options for creating an ActionExecutor.
 */
export interface ActionExecutorOptions {
  /** Project root directory (used as cwd for kspec actions) */
  projectDir: string;
  /** Path to kspec CLI binary */
  kspecCliPath?: string;
  /** Callback for action run lifecycle events */
  onActionRunEvent?: (event: ActionRunEvent) => void;
  /** Broadcast function for notify actions */
  notifyBroadcast?: NotifyBroadcast;
  /** Spawner function for agent actions */
  agentSpawner?: AgentSpawner;
}

// ─── KSPEC_* Environment Variable Injection ─────────────────────────────────

/**
 * Maximum size in bytes for a single KSPEC_* environment variable value.
 * Values exceeding this limit are truncated.
 * AC: @dispatch-command-action ac-3
 */
export const ENV_VALUE_MAX_BYTES = 1024;

/**
 * Allowlisted event fields exposed as KSPEC_* environment variables.
 * Derived from the event envelope and payload schemas.
 * AC: @dispatch-command-action ac-3
 */
export const KSPEC_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Envelope fields
  "event_type",
  "event_id",
  "session_id",
  "correlation_id",
  "causation_id",
  "source_type",
  "source_id",
  // Task payload fields
  "task_id",
  "task_ref",
  "from_status",
  "to_status",
  // Invocation payload fields
  "agent_id",
]);

/**
 * Build KSPEC_* namespaced environment variables from event context.
 * Only allowlisted fields are exposed. Values exceeding 1KB are truncated.
 * AC: @dispatch-command-action ac-3
 */
export function buildKspecEnvVars(
  eventContext: ActionEventContext,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const field of KSPEC_ENV_ALLOWLIST) {
    const value = eventContext[field];
    if (value !== undefined) {
      const key = `KSPEC_${field.toUpperCase()}`;
      let strValue = String(value);
      // Truncate values exceeding 1KB
      const byteLength = Buffer.byteLength(strValue, "utf-8");
      if (byteLength > ENV_VALUE_MAX_BYTES) {
        // Truncate by encoding, slicing, and decoding safely
        const buf = Buffer.from(strValue, "utf-8");
        strValue = buf.subarray(0, ENV_VALUE_MAX_BYTES).toString("utf-8");
      }
      env[key] = strValue;
    }
  }
  return env;
}

// ─── Template Interpolation ──────────────────────────────────────────────────

/**
 * Resolve template variables in a string using event context.
 * Unresolved placeholders pass through unchanged.
 * AC: @dispatch-action-model ac-8
 */
export function resolveTemplateVars(
  template: string,
  context: ActionEventContext,
): string {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) {
      vars[key] = String(value);
    }
  }
  return interpolateTemplate(template, vars);
}

/**
 * Extract all template variable names from a string.
 * Used by validation to check for unknown variables.
 * AC: @dispatch-action-model ac-7
 */
export function extractTemplateVars(template: string): string[] {
  const vars: string[] = [];
  const pattern = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    vars.push(match[1]);
  }
  return vars;
}

// ─── Known Event Fields ──────────────────────────────────────────────────────

/**
 * Known fields available in event envelopes and payloads, organized by event domain.
 * Used by template validation to warn about unknown variable references.
 * AC: @dispatch-action-model ac-7
 */
export const KNOWN_EVENT_FIELDS: Record<string, Set<string>> = {
  // Universal envelope fields (available on all events)
  "*": new Set([
    "event_id",
    "event_type",
    "emitted_at",
    "source_type",
    "source_id",
    "correlation_id",
    "causation_id",
  ]),
  // Task event payload fields
  "task": new Set([
    "task_id",
    "task_ref",
    "from_status",
    "to_status",
    "task_title",
    "tags",
    "priority",
    "automation",
  ]),
  // Invocation event payload fields
  "invocation": new Set([
    "session_id",
    "agent_id",
    "trigger",
    "duration_ms",
    "task_ref",
  ]),
  // Session event payload fields — AC: @dispatch-event-payload ac-3
  "session": new Set([
    "session_id",
    "agent_id",
    "task_ref",
    "duration_ms",
    "terminal_reason",
    "work_summary",
  ]),
  // Action event payload fields
  "action": new Set([
    "action_run_id",
    "action_type",
    "status",
    "duration_ms",
    "source_name",
    "session_id",
  ]),
  // Schedule event payload fields
  "schedule": new Set([
    "schedule_id",
    "schedule_name",
    "tick_at",
  ]),
};

/**
 * Template validation warning for an unknown variable reference.
 * AC: @dispatch-action-model ac-7
 */
export interface TemplateValidationWarning {
  /** The template variable name that was not found */
  variable: string;
  /** The template string it was found in */
  template: string;
  /** Available fields for the referenced event type */
  available_fields: string[];
  /** The event type being validated against (if known) */
  event_type?: string;
}

/**
 * Validate template variables against known fields for a given event type.
 * Returns warnings for variables that don't match any known field.
 * AC: @dispatch-action-model ac-7
 */
export function validateActionTemplates(
  templates: string[],
  eventType?: string,
): TemplateValidationWarning[] {
  const warnings: TemplateValidationWarning[] = [];

  // Build the set of known fields for this event type
  const knownFields = new Set(KNOWN_EVENT_FIELDS["*"]);
  if (eventType) {
    const domain = eventType.split(".")[0];
    const domainFields = KNOWN_EVENT_FIELDS[domain];
    if (domainFields) {
      for (const field of domainFields) {
        knownFields.add(field);
      }
    }
  } else {
    // If no event type, include all fields from all domains
    for (const fields of Object.values(KNOWN_EVENT_FIELDS)) {
      for (const field of fields) {
        knownFields.add(field);
      }
    }
  }

  const availableFields = [...knownFields].sort();

  for (const template of templates) {
    const vars = extractTemplateVars(template);
    for (const variable of vars) {
      if (!knownFields.has(variable)) {
        warnings.push({
          variable,
          template,
          available_fields: availableFields,
          event_type: eventType,
        });
      }
    }
  }

  return warnings;
}

/**
 * Extract all template strings from an action definition.
 * Used by validation to collect templates for checking.
 * AC: @dispatch-action-model ac-7
 */
export function extractActionTemplates(action: Action): string[] {
  const templates: string[] = [];
  switch (action.type) {
    case "command":
      templates.push(action.command);
      templates.push(...action.args);
      if (action.cwd) templates.push(action.cwd);
      break;
    case "kspec":
      templates.push(action.command);
      break;
    case "agent":
      if (action.prompt) templates.push(action.prompt);
      break;
    case "notify":
      templates.push(action.message);
      break;
  }
  return templates;
}

// ─── ActionExecutor ──────────────────────────────────────────────────────────

/**
 * Executes actions and tracks their runs.
 *
 * Usage:
 *   const executor = new ActionExecutor({ projectDir, onActionRunEvent });
 *   const run = await executor.execute(action, eventContext);
 *
 * AC: @dispatch-action-model ac-1 through ac-9
 */
export class ActionExecutor {
  private projectDir: string;
  private kspecCliPath: string;
  private onActionRunEvent?: (event: ActionRunEvent) => void;
  private notifyBroadcast?: NotifyBroadcast;
  private agentSpawner?: AgentSpawner;

  constructor(options: ActionExecutorOptions) {
    this.projectDir = options.projectDir;
    this.kspecCliPath = options.kspecCliPath ?? "kspec";
    this.onActionRunEvent = options.onActionRunEvent;
    this.notifyBroadcast = options.notifyBroadcast;
    this.agentSpawner = options.agentSpawner;
  }

  /**
   * Execute a single action and return its action run.
   *
   * Actions execute asynchronously — this method returns a promise
   * that resolves when the action completes or fails.
   *
   * AC: @dispatch-action-model ac-1, ac-9
   */
  async execute(
    action: Action,
    eventContext: ActionEventContext,
    sourceName?: string,
  ): Promise<ActionRun> {
    const actionRunId = ulid();
    const startedAt = new Date().toISOString();

    const run: ActionRun = {
      action_run_id: actionRunId,
      action_type: action.type,
      status: "running",
      started_at: startedAt,
      source_name: sourceName,
      source_event_type: eventContext.event_type,
    };

    // Emit action.started
    this.emitEvent("action.started", run, eventContext);

    try {
      const result = await this.executeAction(action, eventContext, run);
      return result;
    } catch (err) {
      // AC: @dispatch-action-model ac-9 — failure is logged, does not propagate
      const errorMessage = err instanceof Error ? err.message : String(err);
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - new Date(startedAt).getTime();

      const failedRun: ActionRun = {
        ...run,
        status: "failed",
        completed_at: completedAt,
        duration_ms: durationMs,
        error: errorMessage,
        failure_reason: "error",
      };

      this.emitEvent("action.failed", failedRun, eventContext);
      return failedRun;
    }
  }

  /**
   * Execute multiple actions for the same event.
   * Each action runs independently — one failure does not affect others.
   * AC: @dispatch-action-model ac-9
   */
  async executeAll(
    actions: Action[],
    eventContext: ActionEventContext,
    sourceName?: string,
  ): Promise<ActionRun[]> {
    const results = await Promise.allSettled(
      actions.map((action) => this.execute(action, eventContext, sourceName)),
    );

    return results.map((result) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      // This shouldn't happen since execute() catches errors internally,
      // but handle defensively.
      const errorMessage =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      return {
        action_run_id: ulid(),
        action_type: "command" as const,
        status: "failed" as const,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: 0,
        error: errorMessage,
        failure_reason: "error" as const,
      };
    });
  }

  // ─── Per-Type Execution ──────────────────────────────────────────────────

  private async executeAction(
    action: Action,
    eventContext: ActionEventContext,
    run: ActionRun,
  ): Promise<ActionRun> {
    switch (action.type) {
      case "command":
        return this.executeCommand(action, eventContext, run);
      case "kspec":
        return this.executeKspec(action, eventContext, run);
      case "agent":
        return this.executeAgent(action, eventContext, run);
      case "notify":
        return this.executeNotify(action, eventContext, run);
    }
  }

  /**
   * Execute a command action — spawns an async child process.
   * Uses structured program + args form with shell: false by default.
   * AC: @dispatch-action-model ac-1, ac-2
   * AC: @dispatch-command-action ac-1, ac-2, ac-3, ac-4
   */
  private executeCommand(
    action: CommandAction,
    eventContext: ActionEventContext,
    run: ActionRun,
  ): Promise<ActionRun> {
    return new Promise<ActionRun>((resolve) => {
      // AC: @dispatch-command-action ac-2 — each arg is a separate array element;
      // template values are interpolated as literal strings, never shell syntax
      const resolvedCommand = resolveTemplateVars(action.command, eventContext);
      const resolvedArgs = action.args.map((arg) =>
        resolveTemplateVars(arg, eventContext),
      );
      const cwd = action.cwd
        ? resolveTemplateVars(action.cwd, eventContext)
        : this.projectDir;

      // AC: @dispatch-command-action ac-3 — inject KSPEC_* namespaced env vars
      const kspecEnv = buildKspecEnvVars(eventContext);

      let child: ChildProcess;
      try {
        // AC: @dispatch-command-action ac-1 — shell is false by default
        child = spawn(resolvedCommand, resolvedArgs, {
          cwd,
          env: {
            ...process.env,
            ...kspecEnv,
            ...action.env,
          },
          stdio: "pipe",
          shell: action.shell ?? false,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - new Date(run.started_at).getTime();
        const failedRun: ActionRun = {
          ...run,
          status: "failed",
          completed_at: completedAt,
          duration_ms: durationMs,
          error: `Failed to spawn: ${errorMessage}`,
          failure_reason: "spawn_error",
        };
        this.emitEvent("action.failed", failedRun, eventContext);
        resolve(failedRun);
        return;
      }

      const pid = child.pid;
      if (pid !== undefined) {
        run.pid = pid;
      }

      // AC: @dispatch-action-model ac-2 — timeout handling
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;

      if (action.timeout_ms) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          // Give it a moment, then SIGKILL
          setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }, 5000);
        }, action.timeout_ms);
      }

      child.on("close", (code, signal) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - new Date(run.started_at).getTime();

        if (timedOut) {
          const failedRun: ActionRun = {
            ...run,
            status: "failed",
            completed_at: completedAt,
            duration_ms: durationMs,
            exit_code: code ?? undefined,
            error: `Command timed out after ${action.timeout_ms}ms`,
            failure_reason: "timeout",
          };
          this.emitEvent("action.failed", failedRun, eventContext);
          resolve(failedRun);
          return;
        }

        if (code !== 0) {
          const failedRun: ActionRun = {
            ...run,
            status: "failed",
            completed_at: completedAt,
            duration_ms: durationMs,
            exit_code: code ?? undefined,
            error: signal
              ? `Command killed by signal: ${signal}`
              : `Command exited with code ${code}`,
            failure_reason: signal ? "signal" : "exit_code",
          };
          this.emitEvent("action.failed", failedRun, eventContext);
          resolve(failedRun);
          return;
        }

        const completedRun: ActionRun = {
          ...run,
          status: "completed",
          completed_at: completedAt,
          duration_ms: durationMs,
          exit_code: 0,
        };
        this.emitEvent("action.completed", completedRun, eventContext);
        resolve(completedRun);
      });

      child.on("error", (err) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - new Date(run.started_at).getTime();
        const failedRun: ActionRun = {
          ...run,
          status: "failed",
          completed_at: completedAt,
          duration_ms: durationMs,
          error: `Spawn error: ${err.message}`,
          failure_reason: "spawn_error",
        };
        this.emitEvent("action.failed", failedRun, eventContext);
        resolve(failedRun);
      });
    });
  }

  /**
   * Execute a kspec action — runs kspec CLI in the project root.
   * AC: @dispatch-action-model ac-3
   */
  private executeKspec(
    action: KspecAction,
    eventContext: ActionEventContext,
    run: ActionRun,
  ): Promise<ActionRun> {
    return new Promise<ActionRun>((resolve) => {
      const resolvedCommand = resolveTemplateVars(action.command, eventContext);
      const args = resolvedCommand.split(/\s+/);

      // AC: @dispatch-action-model ac-3 — inject correlation_id via env var
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
      };
      if (eventContext.correlation_id) {
        env.KSPEC_CORRELATION_ID = eventContext.correlation_id;
      }

      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [this.kspecCliPath, ...args], {
          cwd: this.projectDir,
          env,
          stdio: "pipe",
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - new Date(run.started_at).getTime();
        const failedRun: ActionRun = {
          ...run,
          status: "failed",
          completed_at: completedAt,
          duration_ms: durationMs,
          error: `Failed to spawn kspec: ${errorMessage}`,
          failure_reason: "spawn_error",
        };
        this.emitEvent("action.failed", failedRun, eventContext);
        resolve(failedRun);
        return;
      }

      const pid = child.pid;
      if (pid !== undefined) {
        run.pid = pid;
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;

      if (action.timeout_ms) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
          }, 5000);
        }, action.timeout_ms);
      }

      child.on("close", (code, signal) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - new Date(run.started_at).getTime();

        if (timedOut) {
          const failedRun: ActionRun = {
            ...run,
            status: "failed",
            completed_at: completedAt,
            duration_ms: durationMs,
            exit_code: code ?? undefined,
            error: `Kspec command timed out after ${action.timeout_ms}ms`,
            failure_reason: "timeout",
          };
          this.emitEvent("action.failed", failedRun, eventContext);
          resolve(failedRun);
          return;
        }

        if (code !== 0) {
          const failedRun: ActionRun = {
            ...run,
            status: "failed",
            completed_at: completedAt,
            duration_ms: durationMs,
            exit_code: code ?? undefined,
            error: signal
              ? `Kspec killed by signal: ${signal}`
              : `Kspec exited with code ${code}`,
            failure_reason: signal ? "signal" : "exit_code",
          };
          this.emitEvent("action.failed", failedRun, eventContext);
          resolve(failedRun);
          return;
        }

        const completedRun: ActionRun = {
          ...run,
          status: "completed",
          completed_at: completedAt,
          duration_ms: durationMs,
          exit_code: 0,
        };
        this.emitEvent("action.completed", completedRun, eventContext);
        resolve(completedRun);
      });

      child.on("error", (err) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        const completedAt = new Date().toISOString();
        const durationMs = Date.now() - new Date(run.started_at).getTime();
        const failedRun: ActionRun = {
          ...run,
          status: "failed",
          completed_at: completedAt,
          duration_ms: durationMs,
          error: `Kspec spawn error: ${err.message}`,
          failure_reason: "spawn_error",
        };
        this.emitEvent("action.failed", failedRun, eventContext);
        resolve(failedRun);
      });
    });
  }

  /**
   * Execute an agent action — spawns a new invocation.
   * AC: @dispatch-action-model ac-4, ac-5
   */
  private async executeAgent(
    action: AgentAction,
    eventContext: ActionEventContext,
    run: ActionRun,
  ): Promise<ActionRun> {
    if (!this.agentSpawner) {
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - new Date(run.started_at).getTime();
      const failedRun: ActionRun = {
        ...run,
        status: "failed",
        completed_at: completedAt,
        duration_ms: durationMs,
        error: "No agent spawner configured — cannot execute agent action",
        failure_reason: "error",
      };
      this.emitEvent("action.failed", failedRun, eventContext);
      return failedRun;
    }

    const resolvedPrompt = action.prompt
      ? resolveTemplateVars(action.prompt, eventContext)
      : undefined;

    const result = await this.agentSpawner({
      agent_id: action.agent_id,
      prompt: resolvedPrompt,
      task_ref: action.task_ref,
      timeout_minutes: action.timeout_minutes,
      correlation_id: eventContext.correlation_id,
    });

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(run.started_at).getTime();

    // AC: @dispatch-action-model ac-4 — track linked invocation_id
    const completedRun: ActionRun = {
      ...run,
      status: "completed",
      completed_at: completedAt,
      duration_ms: durationMs,
      invocation_id: result.invocation_id,
    };
    this.emitEvent("action.completed", completedRun, eventContext);
    return completedRun;
  }

  /**
   * Execute a notify action — broadcasts to WebSocket clients.
   * AC: @dispatch-action-model ac-6
   */
  private async executeNotify(
    action: NotifyAction,
    eventContext: ActionEventContext,
    run: ActionRun,
  ): Promise<ActionRun> {
    const resolvedMessage = resolveTemplateVars(action.message, eventContext);
    const topic = action.topic;

    if (this.notifyBroadcast) {
      this.notifyBroadcast(topic, "action.notify", {
        message: resolvedMessage,
        source_name: run.source_name,
        event_type: eventContext.event_type,
        payload_summary: this.buildPayloadSummary(eventContext),
      });
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - new Date(run.started_at).getTime();

    const completedRun: ActionRun = {
      ...run,
      status: "completed",
      completed_at: completedAt,
      duration_ms: durationMs,
    };
    this.emitEvent("action.completed", completedRun, eventContext);
    return completedRun;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private emitEvent(
    type: ActionRunEvent["type"],
    actionRun: ActionRun,
    eventContext: ActionEventContext,
  ): void {
    this.onActionRunEvent?.({
      type,
      action_run: actionRun,
      event_context: eventContext,
    });
  }

  private buildPayloadSummary(
    context: ActionEventContext,
  ): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(context)) {
      if (
        key !== "event_id" &&
        key !== "event_type" &&
        key !== "correlation_id" &&
        key !== "causation_id" &&
        key !== "source_type" &&
        key !== "source_id" &&
        value !== undefined
      ) {
        summary[key] = value;
      }
    }
    return summary;
  }
}
