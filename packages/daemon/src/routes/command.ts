/**
 * Command API Route
 *
 * REST endpoint that accepts CLI command payloads and executes them
 * within the daemon process, returning structured results.
 *
 * AC Coverage:
 * - @daemon-command-api ac-command-endpoint: POST /api/command executes commands
 * - @daemon-command-api ac-mutation-cache-update: cache update + WebSocket broadcast after mutations
 * - @daemon-command-api ac-batch-support: batch array execution via existing batch runner
 * - @daemon-command-api ac-concurrent-mutations: file lock serialization
 * - @daemon-command-api ac-response-parity: stdout/stderr/exitCode match direct CLI
 * - @daemon-command-api ac-cache-context-propagation: command execution receives entity cache async context
 * - @daemon-command-api ac-command-timeout: bounded caller wait with structured 504
 * - @daemon-command-api ac-timeout-queue-bounded: queued commands get their own bound; expired ones are discarded
 * - @daemon-command-api ac-stuck-command-reported: wedge registry feeds the health endpoint
 * - @daemon-command-api ac-timeout-isolation: abandoned executions stay detached from later responses
 * - @daemon-command-api ac-timeout-late-completion-effects: completion side effects bound to completion, not response
 * - @trait-api-endpoint ac-1: returns 2xx with JSON body on success
 * - @trait-api-endpoint ac-3: returns 400 on invalid body
 * - @trait-api-endpoint ac-6: includes X-Request-Id header
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import type { Command } from "commander";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor, RouteEntityCache } from "./entity-cache-types.js";
import type { CacheDomain } from "../../daemon/entity-cache.js";
import { getDispatchShadowMutationLockPath } from "../../agent-runtime/workspace.js";
import { CommandExitError } from "../../cli/batch-context.js";
import {
  runWithEntityCache,
  runWithoutSpecDirOverride,
  runWithWorkingDirectory,
} from "../../parser/yaml.js";
import { runWithOutputState } from "../../cli/output.js";
import { runWithDaemonProxySuppressed } from "../../cli/daemon-proxy.js";
import { DEFAULT_DAEMON_COMMAND_TIMEOUT_MS } from "../pid.js";

// ── Types ──────────────────────────────────────────────────────────

/** Single command payload (matches kspec batch JSON format) */
interface CommandPayload {
  command: string;
  args: Record<string, unknown>;
  id?: string;
}

/** Response for a single command execution */
interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RefLikeEntity {
  _ulid: string;
  slugs?: string[];
}

export interface CommandExecutionContext {
  stdoutChunks: string[];
  stderrChunks: string[];
  interceptedExitCode?: number;
}

const commandExecutionStorage = new AsyncLocalStorage<CommandExecutionContext>();

function serializeConsoleArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
}

function extractGlobalOptionArgv(args: Record<string, unknown>): string[] {
  const globalFlags: string[] = [];
  const flagKeys: Array<[string, string]> = [
    ["json", "--json"],
    ["yaml", "--yaml"],
    ["raw", "--raw"],
    ["debugShadow", "--debug-shadow"],
    ["debug-shadow", "--debug-shadow"],
    ["daemon", "--daemon"],
  ];

  for (const [key, flag] of flagKeys) {
    if (args[key] === true) {
      globalFlags.push(flag);
      delete args[key];
    }
  }

  return globalFlags;
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalProcessExit = process.exit.bind(process);

console.log = (...args: unknown[]) => {
  const capture = commandExecutionStorage.getStore();
  if (capture) {
    capture.stdoutChunks.push(`${serializeConsoleArgs(args)}\n`);
    return;
  }
  originalConsoleLog(...args);
};

console.error = (...args: unknown[]) => {
  const capture = commandExecutionStorage.getStore();
  if (capture) {
    capture.stderrChunks.push(`${serializeConsoleArgs(args)}\n`);
    return;
  }
  originalConsoleError(...args);
};

console.warn = (...args: unknown[]) => {
  const capture = commandExecutionStorage.getStore();
  if (capture) {
    capture.stderrChunks.push(`${serializeConsoleArgs(args)}\n`);
    return;
  }
  originalConsoleWarn(...args);
};

process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  const capture = commandExecutionStorage.getStore();
  if (capture) {
    const text =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    capture.stdoutChunks.push(text);
    const callback =
      typeof rest[0] === "function" ? rest[0] : typeof rest[1] === "function" ? rest[1] : undefined;
    if (callback) {
      (callback as () => void)();
    }
    return true;
  }

  return originalStdoutWrite(
    chunk as Parameters<typeof process.stdout.write>[0],
    ...(rest as Parameters<typeof process.stdout.write>[1][]),
  );
}) as typeof process.stdout.write;

process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  const capture = commandExecutionStorage.getStore();
  if (capture) {
    const text =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    capture.stderrChunks.push(text);
    const callback =
      typeof rest[0] === "function" ? rest[0] : typeof rest[1] === "function" ? rest[1] : undefined;
    if (callback) {
      (callback as () => void)();
    }
    return true;
  }

  return originalStderrWrite(
    chunk as Parameters<typeof process.stderr.write>[0],
    ...(rest as Parameters<typeof process.stderr.write>[1][]),
  );
}) as typeof process.stderr.write;

process.exit = ((code?: number) => {
  const capture = commandExecutionStorage.getStore();
  if (capture) {
    capture.interceptedExitCode ??= code ?? 0;
    throw new CommandExitError(capture.interceptedExitCode);
  }
  return originalProcessExit(code);
}) as typeof process.exit;

// ── Route Options ──────────────────────────────────────────────────

interface CommandRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
  prepareProgram?: (program: Command) => void | Promise<void>;
  /**
   * Execution time limit in milliseconds for dispatched commands.
   * Defaults to 120 seconds when not configured.
   * AC: @daemon-command-api ac-command-timeout
   */
  commandTimeoutMs?: number;
}

// ── Wedge Registry ─────────────────────────────────────────────────

/**
 * The dispatch currently holding the mutex slot, tracked at module scope so
 * the health endpoint can report a wedged command queue. Null when no
 * serialized dispatch is executing.
 *
 * AC: @daemon-command-api ac-stuck-command-reported
 */
interface ActiveDispatchRecord {
  command: string;
  startedAt: number;
  limitMs: number;
}

let activeDispatch: ActiveDispatchRecord | null = null;

/** Current serialized dispatch, or null when the queue is idle. */
export function getActiveDispatch(): ActiveDispatchRecord | null {
  return activeDispatch;
}

export type CommandDispatchHealth =
  | { status: "ok" }
  | {
      status: "degraded";
      stuck_command: string;
      running_for_ms: number;
      limit_ms: number;
    };

/**
 * Health view of the command dispatch queue. Reports degraded with the
 * stuck command name and held duration once the currently executing
 * dispatch has exceeded its execution time limit; clears when it completes.
 *
 * AC: @daemon-command-api ac-stuck-command-reported
 */
export function getCommandDispatchHealth(): CommandDispatchHealth {
  if (activeDispatch) {
    const runningForMs = Date.now() - activeDispatch.startedAt;
    if (runningForMs > activeDispatch.limitMs) {
      return {
        status: "degraded",
        stuck_command: activeDispatch.command,
        running_for_ms: runningForMs,
        limit_ms: activeDispatch.limitMs,
      };
    }
  }
  return { status: "ok" };
}

// ── In-Process Dispatch Mutex ────────────────────────────────────────

/**
 * Promise-based mutex that serializes all command dispatches within the
 * daemon process. Console/stdout/stderr/exit interception is installed once
 * at module load and routed per call via AsyncLocalStorage, and the working
 * directory is ALS-scoped (runWithWorkingDirectory) — so there are no
 * process globals to restore between dispatches. The mutex remains the
 * serialization point for command execution: it keeps mutations ordered
 * (alongside the cross-process file lock) and gives non-allowlisted reads a
 * single execution lane.
 *
 * The file lock (withFileLock) only serializes mutating commands across
 * processes; this mutex serializes ALL dispatches (excluding cache-served
 * reads) within the same process.
 *
 * Timeout semantics: a caller whose execution time limit elapses receives a
 * structured 504, but the mutex slot is NOT released and the underlying
 * execution is NOT killed — releasing the slot would let new commands run
 * concurrently with the abandoned one (which may still hold the file lock).
 * Subsequent callers queue behind it, each with its own bounded timeout.
 *
 * AC: @daemon-command-api ac-concurrent-mutations — in-process serialization
 * AC: @daemon-command-api ac-command-timeout — slot held on timeout
 */
class DispatchMutex {
  private _queue: Promise<void> = Promise.resolve();

  /** Run fn exclusively — concurrent callers wait in FIFO order. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Chain onto the queue so callers execute one at a time
    const previous = this._queue;
    this._queue = gate;

    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
  }
}

// ── Command Execution ──────────────────────────────────────────────

/**
 * Execute a single CLI command within the daemon process.
 *
 * Executes a command inside request-scoped async context so concurrent
 * cache-backed reads do not share stdout/stderr capture, output mode,
 * exit interception, or working-directory discovery.
 *
 * AC: @daemon-command-api ac-command-endpoint — executes command in-process
 * AC: @daemon-command-api ac-response-parity — captures same stdout/stderr as direct CLI
 */
async function executeCommand(
  payload: CommandPayload,
  program: Command,
  projectPath: string,
  cacheAccessor?: EntityCacheAccessor,
): Promise<CommandResult> {
  // Lazy import to avoid loading the full CLI at daemon startup
  const { buildCommandArgv } = await import("../../cli/batch-exec.js");
  const { extractCommandTree, findCommand } = await import("../../cli/introspection.js");

  const tree = extractCommandTree(program);
  const parts = payload.command.trim().split(/\s+/);
  const cmdMeta = findCommand(tree, parts);
  const commandArgs = { ...payload.args };
  const globalArgv = extractGlobalOptionArgv(commandArgs);

  // Build argv from payload. For unknown commands, pass the raw command words
  // so Commander's "command:*" handler fires and produces the same stderr
  // output as direct CLI execution (ac-response-parity).
  const argv = cmdMeta
    ? [
        ...globalArgv,
        ...buildCommandArgv(
          { command: payload.command, args: commandArgs, id: payload.id },
          cmdMeta,
        ),
      ]
    : [...globalArgv, ...parts];
  const capture: CommandExecutionContext = {
    stdoutChunks: [],
    stderrChunks: [],
    interceptedExitCode: undefined,
  };
  let exitCode = 0;

  try {
    const parseCommand = () =>
      runWithDaemonProxySuppressed(() =>
        runWithOutputState(
          () =>
            runWithoutSpecDirOverride(() =>
              runWithWorkingDirectory(
                () => program.parseAsync(argv, { from: "user" }),
                projectPath,
              ),
            ),
          { outputFormat: "text", verboseMode: false },
        ),
      );

    await commandExecutionStorage.run(capture, async () => {
      if (cacheAccessor) {
        await runWithEntityCache(parseCommand, cacheAccessor, projectPath);
      } else {
        await parseCommand();
      }
    });
  } catch (err) {
    if (err instanceof CommandExitError) {
      exitCode = err.code;
    } else {
      exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      capture.stderrChunks.push(msg);
    }
  }

  // Combine captured chunks verbatim — no trimming, to preserve response
  // parity with direct CLI execution.
  // AC: @daemon-command-api ac-response-parity — exact stdout/stderr match
  const stdout = capture.stdoutChunks.join("");
  const stderr = capture.stderrChunks.join("");

  // Filter intercepted exit noise from stderr (preserving other content intact)
  const filteredStderr = stderr
    .split("\n")
    .filter((line) => !line.includes("BatchExitError") && !line.includes("CommandExitError"))
    .join("\n");

  return {
    stdout,
    stderr: filteredStderr,
    exitCode,
  };
}

/**
 * Determine if a command payload represents a mutating command.
 * Uses the same introspection mechanism as the batch command filter.
 */
async function isCommandMutating(payload: CommandPayload, program: Command): Promise<boolean> {
  const { extractCommandTree, findCommand } = await import("../../cli/introspection.js");
  const tree = extractCommandTree(program);
  const parts = payload.command.trim().split(/\s+/);
  const cmdMeta = findCommand(tree, parts);
  return cmdMeta?.mutating === true;
}

const COMMAND_CACHE_DOMAINS = new Map<string, readonly CacheDomain[]>([
  [
    "task list",
    [
      // src/cli/commands/task.ts:703 delegates to listTasksAction()
      // src/cli/commands/tasks.ts:90,92,96 load tasks, items, meta
      "tasks",
      "items",
      "meta",
    ],
  ],
  [
    "task get",
    [
      // src/cli/commands/task.ts:716,717,720,771
      // src/parser/yaml.ts:1751-1753 via buildIndexes()
      "tasks",
      "items",
      "reviews",
    ],
  ],
  [
    "tasks list",
    [
      // src/cli/commands/tasks.ts:221 delegates to listTasksAction()
      // src/cli/commands/tasks.ts:90,92,96 load tasks, items, meta
      "tasks",
      "items",
      "meta",
    ],
  ],
  [
    "tasks ready",
    [
      // src/cli/commands/tasks.ts:239-242 load tasks and items
      "tasks",
      "items",
    ],
  ],
  [
    "item list",
    [
      // src/cli/commands/item.ts:331 calls buildIndexes()
      // src/parser/yaml.ts:1751-1753 load tasks, items, reviews
      "tasks",
      "items",
      "reviews",
    ],
  ],
  [
    "item get",
    [
      // src/cli/commands/item.ts:471 calls buildIndexes()
      // src/parser/yaml.ts:1751-1753 load tasks, items, reviews
      "tasks",
      "items",
      "reviews",
    ],
  ],
  [
    "search",
    [
      // src/cli/commands/search.ts:170 calls buildIndexes()
      // src/parser/yaml.ts:1751-1753 load tasks, items, reviews
      "tasks",
      "items",
      "reviews",
    ],
  ],
  [
    "inbox list",
    [
      // src/cli/commands/inbox.ts:127 loads inbox items
      "inbox",
    ],
  ],
  [
    "plan list",
    [
      // src/cli/commands/plan.ts:1142-1143 load plans and tasks
      "plans",
      "tasks",
    ],
  ],
  [
    "plan get",
    [
      // src/cli/commands/plan.ts:777 loads plans
      "plans",
    ],
  ],
  [
    "review get",
    [
      // src/cli/commands/review.ts:547 loads review records
      "reviews",
    ],
  ],
  [
    "review list",
    [
      // src/cli/commands/review.ts:582 and 682 load review records
      "reviews",
    ],
  ],
]);

function normalizeCommandKey(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function getArgValue(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in args) {
      return args[key];
    }
  }
  return undefined;
}

function hasTruthyArg(args: Record<string, unknown>, ...keys: string[]): boolean {
  return Boolean(getArgValue(args, ...keys));
}

function getRefArg(payload: CommandPayload): string | null {
  const value = getArgValue(payload.args, "ref");
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function refExistsInCacheIndex(ref: string, entries: RefLikeEntity[] | null): boolean {
  if (!entries) {
    return false;
  }

  const normalized = ref.startsWith("@") ? ref.slice(1) : ref;
  const normalizedLower = normalized.toLowerCase();

  return entries.some((entry) => {
    if (entry._ulid.toLowerCase() === normalizedLower) {
      return true;
    }
    if (entry._ulid.toLowerCase().startsWith(normalizedLower)) {
      return true;
    }
    return (entry.slugs ?? []).some((slug) => slug.toLowerCase() === normalizedLower);
  });
}

function getRequiredCacheDomains(payload: CommandPayload): CacheDomain[] | null {
  const commandKey = normalizeCommandKey(payload.command);
  const baseDomains = COMMAND_CACHE_DOMAINS.get(commandKey);
  if (!baseDomains) {
    return null;
  }

  const domains = [...baseDomains];

  if (commandKey === "review list" && hasTruthyArg(payload.args, "task")) {
    // src/cli/commands/review.ts:629-650 loads tasks when --task is present
    domains.push("tasks");
  }

  if (commandKey === "search") {
    const itemsOnly = hasTruthyArg(payload.args, "itemsOnly", "items-only");
    const tasksOnly = hasTruthyArg(payload.args, "tasksOnly", "tasks-only");
    const observationsOnly = hasTruthyArg(payload.args, "observationsOnly", "observations-only");

    if (!itemsOnly && !tasksOnly && !observationsOnly) {
      // src/cli/commands/search.ts:235-253 conditionally loads inbox + meta
      domains.push("inbox", "meta");
    } else if (observationsOnly) {
      // src/cli/commands/search.ts:252-259 loads meta for observations-only searches
      domains.push("meta");
    }
  }

  return [...new Set(domains)];
}

function cacheHasResolvedRef(payload: CommandPayload, cache: RouteEntityCache): boolean {
  const ref = getRefArg(payload);
  if (!ref) {
    return false;
  }

  switch (normalizeCommandKey(payload.command)) {
    case "task get":
      return refExistsInCacheIndex(ref, cache.getTaskIndex());
    case "item get":
      return refExistsInCacheIndex(ref, cache.getItemIndex());
    case "plan get":
      return refExistsInCacheIndex(ref, cache.getPlansIndex());
    case "review get":
      return refExistsInCacheIndex(ref, cache.getReviewsIndex());
    default:
      return true;
  }
}

function canServeFromCache(payload: CommandPayload, cache: RouteEntityCache): boolean {
  const requiredDomains = getRequiredCacheDomains(payload);
  if (!requiredDomains) {
    return false;
  }

  if (requiredDomains.some((domain) => cache.getDomainState(domain) !== "ready")) {
    return false;
  }

  const commandKey = normalizeCommandKey(payload.command);
  if (commandKey.endsWith(" get")) {
    return cacheHasResolvedRef(payload, cache);
  }

  return true;
}

/**
 * All cache domains that might be affected by CLI mutations.
 * We write through all domains after a mutating command because
 * commands can have cross-domain side effects (e.g., task transitions
 * update spec implementation status).
 */
const MUTATION_AFFECTED_DOMAINS: CacheDomain[] = [
  "tasks",
  "items",
  "meta",
  "inbox",
  "plans",
  "triage",
  "reviews",
  "sessions",
];

// ── Route Factory ──────────────────────────────────────────────────

/**
 * Create the command API routes.
 *
 * AC: @daemon-command-api ac-command-endpoint — POST /api/command
 * AC: @daemon-command-api ac-concurrent-mutations — dispatch mutex + file lock
 * AC: @trait-api-endpoint ac-6 — X-Request-Id header
 */
export function createCommandRoutes(options: CommandRouteOptions) {
  const { pubsub, getEntityCache, prepareProgram } = options;

  // AC: @daemon-command-api ac-command-timeout — default 120s when not configured
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_DAEMON_COMMAND_TIMEOUT_MS;

  // In-process mutex serializes all command dispatches (see DispatchMutex).
  const dispatchMutex = new DispatchMutex();

  /** Sentinel: the caller timed out before execution began, so the queued
   * dispatch was discarded without executing. */
  const DISCARDED = Symbol("dispatch-discarded");
  /** Sentinel: the execution time limit elapsed before completion. */
  const TIMED_OUT = Symbol("dispatch-timed-out");

  /**
   * Run a dispatch through the mutex with a bounded caller wait.
   *
   * The completion side effects (`onComplete` — cache write-through and
   * WebSocket broadcast) ride on the execution promise, NOT the route
   * handler's await path: they run when the command actually completes,
   * before the response on the normal path and after the 504 has already
   * gone out on the timeout path.
   *
   * On timeout the mutex slot is NOT released and the execution is NOT
   * killed — the caller just stops waiting. A dispatch whose caller timed
   * out while it was still queued is discarded when its slot frees: it must
   * not execute after its caller was already told it timed out.
   *
   * AC: @daemon-command-api ac-command-timeout — bounded caller wait
   * AC: @daemon-command-api ac-timeout-queue-bounded — queued-command discard
   * AC: @daemon-command-api ac-timeout-isolation — abandoned execution stays detached
   * AC: @daemon-command-api ac-timeout-late-completion-effects — effects bound to completion
   */
  async function dispatchWithTimeout<T>(dispatch: {
    label: string;
    run: () => Promise<T>;
    onComplete: (result: T) => Promise<void>;
  }): Promise<{ timedOut: true } | { timedOut: false; result: T }> {
    const state = { timedOut: false };

    const execution = dispatchMutex
      .run(async (): Promise<T | typeof DISCARDED> => {
        // AC: @daemon-command-api ac-timeout-queue-bounded — a command whose
        // limit elapsed while still queued never executes.
        if (state.timedOut) {
          return DISCARDED;
        }

        // AC: @daemon-command-api ac-stuck-command-reported — register the
        // executing dispatch so health can report a wedge; cleared on
        // completion (including failure) in the finally block.
        activeDispatch = {
          command: dispatch.label,
          startedAt: Date.now(),
          limitMs: commandTimeoutMs,
        };
        try {
          return await dispatch.run();
        } finally {
          activeDispatch = null;
        }
      })
      .then(async (result) => {
        // Completion side effects are bound to command completion, not the
        // HTTP response — a mutating command that timed out for its caller
        // but later completes still updates the cache and broadcasts.
        // Discarded dispatches never executed, so they skip the effects.
        // AC: @daemon-command-api ac-timeout-late-completion-effects
        if (result !== DISCARDED) {
          await dispatch.onComplete(result as T);
        }
        return result;
      });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        // Set the discard flag synchronously in the timer callback so a
        // queued dispatch can never start between the timer firing and the
        // race settling.
        state.timedOut = true;
        resolve(TIMED_OUT);
      }, commandTimeoutMs);
    });

    try {
      const raced = await Promise.race([execution, timeout]);
      if (raced === TIMED_OUT) {
        // The abandoned execution keeps running detached from this request.
        // The .catch is REQUIRED: the daemon installs an unhandledRejection
        // handler that exits the process, so a late rejection (or a failing
        // late completion side effect) must never crash the daemon. This
        // handler runs outside any command capture store, so console.warn
        // reaches the daemon console directly.
        // AC: @daemon-command-api ac-timeout-isolation
        execution.catch((err: unknown) => {
          console.warn(
            `[command-api] Abandoned dispatch "${dispatch.label}" failed after its caller timed out:`,
            err,
          );
        });
        return { timedOut: true };
      }
      return { timedOut: false, result: raced as T };
    } finally {
      // Clear the timer on normal completion to avoid open-handle leaks.
      clearTimeout(timer);
    }
  }

  const getProgram = async (): Promise<Command> => {
    // Ensure the split storage backend is registered before CLI commands execute.
    // The CLI's task commands need this backend for split-format task storage.
    const { ensureSplitBackendRegistered } = await import("../../parser/split-backend.js");
    ensureSplitBackendRegistered();

    const { createProgram } = await import("../../cli/index.js");
    const program = createProgram();
    if (prepareProgram) {
      await prepareProgram(program);
    }
    return program;
  };

  return (
    new Elysia({ prefix: "/api/command" })
      // AC: @trait-api-endpoint ac-6 — X-Request-Id header on all responses.
      // Uses onTransform (not onBeforeHandle) because Elysia runs body validation
      // between onTransform and onBeforeHandle. Setting the header here ensures it
      // appears even on validation error responses.
      .onTransform(({ set }) => {
        set.headers["X-Request-Id"] = ulid();
      })

      // AC: @daemon-command-api ac-command-endpoint — single command execution
      // AC: @daemon-command-api ac-response-parity — stdout/stderr/exitCode parity
      // AC: @daemon-command-api ac-mutation-cache-update — cache + broadcast after mutations
      // AC: @daemon-command-api ac-concurrent-mutations — dispatch mutex + file lock
      // AC: @daemon-command-api ac-cache-context-propagation — entity cache async context installed for command execution
      // AC: @trait-api-endpoint ac-1 — returns 2xx with JSON body
      // AC: @trait-api-endpoint ac-3 — returns 400 on invalid body
      .post(
        "/",
        async ({ body, error: errorResponse, projectContext, set }) => {
          const program = await getProgram();

          // Single command mode
          const payload: CommandPayload = {
            command: body.command,
            args: body.args ?? {},
            id: body.id,
          };

          const mutating = await isCommandMutating(payload, program);
          const cache = getEntityCache?.(projectContext.path) ?? null;

          // Cache-served reads bypass the mutex and keep working during a
          // wedge — deliberately outside the timeout machinery.
          if (!mutating && cache && canServeFromCache(payload, cache)) {
            return executeCommand(payload, program, projectContext.path, getEntityCache);
          }

          // All command execution goes through the dispatch mutex (see
          // DispatchMutex). Mutating commands additionally acquire the
          // cross-process file lock.
          const outcome = await dispatchWithTimeout({
            label: payload.command,
            run: async () => {
              if (mutating) {
                // AC: @daemon-command-api ac-concurrent-mutations — file lock for cross-process safety
                // Uses the canonical dispatch shadow mutation lock path so that the command API
                // coordinates with the CLI and dispatch engine's mutation serialization.
                const { withFileLock } = await import("../../parser/file-lock.js");
                const lockPath = getDispatchShadowMutationLockPath(projectContext.path);
                return withFileLock(lockPath, () =>
                  executeCommand(payload, program, projectContext.path, getEntityCache),
                );
              }
              return executeCommand(payload, program, projectContext.path, getEntityCache);
            },
            // Completion side effects ride on the execution promise: before
            // the response on the normal path (update-before-response), and
            // after the 504 has gone out when the caller timed out.
            // AC: @daemon-command-api ac-mutation-cache-update — update cache before response
            // AC: @daemon-command-api ac-timeout-late-completion-effects — effects on late completion
            onComplete: async (result) => {
              if (mutating && result.exitCode === 0) {
                const mutationCache = getEntityCache?.(projectContext.path);
                if (mutationCache) {
                  await Promise.all(
                    MUTATION_AFFECTED_DOMAINS.map((domain) =>
                      mutationCache.writeThrough(domain).catch(() => {
                        // Non-fatal: cache may not have this domain loaded
                      }),
                    ),
                  );
                }

                // AC: @daemon-command-api ac-mutation-cache-update — WebSocket broadcast
                pubsub.broadcast(
                  "command",
                  "command_executed",
                  {
                    command: payload.command,
                    mutating: true,
                    success: true,
                  },
                  projectContext.path,
                );
              }
            },
          });

          // AC: @daemon-command-api ac-command-timeout — structured 504 on timeout
          if (outcome.timedOut) {
            return errorResponse(504, {
              error: "command_timeout",
              message: `Command "${payload.command}" did not complete within ${commandTimeoutMs}ms`,
              suggestion:
                "Check daemon health with `kspec serve status`. If command dispatch stays wedged, restart the daemon.",
            });
          }

          const result = outcome.result;

          // AC: @trait-api-endpoint ac-1 — success response
          if (result.exitCode === 0) {
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            };
          }

          // Non-zero exit: still return structured result but with appropriate status
          set.status = 422;
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          };
        },
        {
          body: t.Object({
            command: t.String({ minLength: 1 }),
            args: t.Optional(t.Record(t.String(), t.Unknown())),
            id: t.Optional(t.String()),
          }),
        },
      )

      // AC: @daemon-command-api ac-batch-support — batch command execution
      // AC: @daemon-command-api ac-concurrent-mutations — dispatch mutex + file lock
      // AC: @daemon-command-api ac-mutation-cache-update — cache updated once after batch
      .post(
        "/batch",
        async ({ body, error: errorResponse, projectContext, set }) => {
          const program = await getProgram();

          // Validate commands array
          if (!Array.isArray(body.commands) || body.commands.length === 0) {
            return errorResponse(400, {
              error: "validation_error",
              details: [
                {
                  field: "commands",
                  message: "Commands must be a non-empty array",
                },
              ],
            });
          }

          // Check if any command in the batch is mutating
          let hasMutating = false;
          for (const cmd of body.commands) {
            if (await isCommandMutating({ command: cmd.command, args: cmd.args ?? {} }, program)) {
              hasMutating = true;
              break;
            }
          }

          // Use the existing batch execution engine
          const { executeBatch } = await import("../../cli/batch-exec.js");

          // Build batch input from the request body
          const batchCommands = body.commands.map((cmd) => ({
            command: cmd.command,
            args: cmd.args ?? {},
            id: cmd.id,
          }));

          const projectPath = projectContext.path;
          const cacheAccessor = getEntityCache;

          // Batch execution goes through the dispatch mutex (process-global
          // state protection) and optionally the file lock (cross-process).
          // AC: @daemon-command-api ac-cache-context-propagation — entity cache context for batch
          // AC: @daemon-command-api ac-response-parity — capture process.stdout.write/stderr.write
          const capture: CommandExecutionContext = {
            stdoutChunks: [],
            stderrChunks: [],
            interceptedExitCode: undefined,
          };

          // AC: @daemon-command-api ac-command-timeout — the bound applies
          // whole-batch: a batch is one atomic dispatch.
          const batchLabel = `batch [${batchCommands.map((cmd) => cmd.command).join(", ")}]`;
          const outcome = await dispatchWithTimeout({
            label: batchLabel,
            run: async () => {
              const runBatch = () => {
                // Wrap batch execution in the same ALS nesting pattern as
                // executeCommand: entity cache → working directory → output
                // state → command execution storage. This ensures:
                // - Cache-backed reads work inside batch commands
                // - process.cwd() is not mutated (concurrent read safety)
                // - process.stdout.write/stderr.write are captured
                // - Output format is request-scoped
                const parseCommands = () =>
                  runWithOutputState(
                    () =>
                      runWithoutSpecDirOverride(() =>
                        runWithWorkingDirectory(
                          () =>
                            executeBatch(batchCommands, program, {
                              atomic: body.atomic !== false, // Default atomic
                              continueOnError: body.continue_on_error ?? false,
                              dryRun: false,
                              json: true,
                            }),
                          projectPath,
                        ),
                      ),
                    { outputFormat: "text", verboseMode: false },
                  );

                return commandExecutionStorage.run(capture, () => {
                  if (cacheAccessor) {
                    return runWithEntityCache(parseCommands, cacheAccessor, projectPath);
                  }
                  return parseCommands();
                });
              };

              if (hasMutating) {
                // AC: @daemon-command-api ac-concurrent-mutations — file lock for cross-process safety
                // Uses the canonical dispatch shadow mutation lock path so that the command API
                // coordinates with the CLI and dispatch engine's mutation serialization.
                const { withFileLock } = await import("../../parser/file-lock.js");
                const lockPath = getDispatchShadowMutationLockPath(projectPath);
                return withFileLock(lockPath, runBatch);
              }
              return runBatch();
            },
            // AC: @daemon-command-api ac-batch-support, ac-mutation-cache-update
            // Update cache once after batch completes — bound to completion,
            // so a late successful completion after a caller timeout still
            // writes through and broadcasts.
            // AC: @daemon-command-api ac-timeout-late-completion-effects
            onComplete: async (batchResult) => {
              if (hasMutating && batchResult.success) {
                const cache = getEntityCache?.(projectPath);
                if (cache) {
                  await Promise.all(
                    MUTATION_AFFECTED_DOMAINS.map((domain) =>
                      cache.writeThrough(domain).catch(() => {
                        // Non-fatal
                      }),
                    ),
                  );
                }

                // WebSocket broadcast for batch completion
                pubsub.broadcast(
                  "command",
                  "batch_executed",
                  {
                    total: batchResult.summary.total,
                    succeeded: batchResult.summary.succeeded,
                    failed: batchResult.summary.failed,
                    mutating: true,
                    success: batchResult.success,
                  },
                  projectPath,
                );
              }
            },
          });

          // AC: @daemon-command-api ac-command-timeout — structured 504 on timeout.
          // Late capture content is discarded with the per-request store.
          // AC: @daemon-command-api ac-timeout-isolation
          if (outcome.timedOut) {
            return errorResponse(504, {
              error: "command_timeout",
              message: `${batchLabel} did not complete within ${commandTimeoutMs}ms`,
              suggestion:
                "Check daemon health with `kspec serve status`. If command dispatch stays wedged, restart the daemon.",
            });
          }

          const batchResult = outcome.result;

          // Merge process.stdout.write/stderr.write output captured by the
          // ALS-based commandExecutionStorage hook into the batch response.
          // executeBatch()'s per-command OutputCapture handles console.log/
          // error/warn, but process.stdout.write (used by plan export and
          // similar commands) is only captured at the daemon level. Without
          // this merge the output would be silently dropped.
          // AC: @daemon-command-api ac-response-parity — include raw stdout/stderr in batch response
          const capturedStdout = capture.stdoutChunks.join("");
          const capturedStderr = capture.stderrChunks.join("");
          if (capturedStdout || capturedStderr) {
            (batchResult as Record<string, unknown>).stdout = capturedStdout;
            (batchResult as Record<string, unknown>).stderr = capturedStderr;
          }

          if (!batchResult.success) {
            set.status = 422;
          }

          return batchResult;
        },
        {
          body: t.Object({
            commands: t.Array(
              t.Object({
                command: t.String({ minLength: 1 }),
                args: t.Optional(t.Record(t.String(), t.Unknown())),
                id: t.Optional(t.String()),
              }),
              { minItems: 1 },
            ),
            atomic: t.Optional(t.Boolean()),
            continue_on_error: t.Optional(t.Boolean()),
          }),
        },
      )
  );
}
