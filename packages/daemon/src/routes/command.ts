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
 * - @trait-api-endpoint ac-1: returns 2xx with JSON body on success
 * - @trait-api-endpoint ac-3: returns 400 on invalid body
 * - @trait-api-endpoint ac-6: includes X-Request-Id header
 */

import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import type { Command } from "commander";
import type { PubSubManager } from "../websocket/pubsub.js";
import type { EntityCacheAccessor, RouteEntityCache } from "./entity-cache-types.js";
import type { CacheDomain } from "../../daemon/entity-cache.js";
import { getDispatchShadowMutationLockPath } from "../../agent-runtime/workspace.js";
import { runWithEntityCache, runWithoutSpecDirOverride } from "../../parser/yaml.js";

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

// ── Route Options ──────────────────────────────────────────────────

interface CommandRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

// ── In-Process Dispatch Mutex ────────────────────────────────────────

/**
 * Promise-based mutex that serializes all command dispatches within the
 * daemon process. Required because executeCommand mutates process-global
 * state (process.cwd(), console.log/error/warn, process.stdout/stderr.write,
 * process.exit interceptor) that would corrupt concurrent requests if not
 * serialized.
 *
 * The file lock (withFileLock) only serializes mutating commands across
 * processes; this mutex serializes ALL dispatches (including reads) within
 * the same process to protect the shared console/cwd state.
 *
 * AC: @daemon-command-api ac-concurrent-mutations — in-process serialization
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
 * IMPORTANT: This function mutates process-global state (process.cwd(),
 * console.log/error/warn, process.stdout/stderr.write, process.exit) and
 * normally must be called inside the dispatch mutex. The route may bypass
 * the mutex only for cache-backed read commands that have been proven safe.
 *
 * Intercepts both console methods AND process.stdout/stderr.write to capture
 * all CLI output, since some commands write directly to process streams
 * (e.g., plan export uses process.stdout.write).
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
  const { buildCommandArgv, resetCommandTree } = await import("../../cli/batch-exec.js");
  const { extractCommandTree, findCommand } = await import("../../cli/introspection.js");
  const { installExitInterceptor, uninstallExitInterceptor, BatchExitError } =
    await import("../../cli/batch-context.js");
  const { setOutputFormat, setVerboseMode } = await import("../../cli/output.js");

  const tree = extractCommandTree(program);
  const parts = payload.command.trim().split(/\s+/);
  const cmdMeta = findCommand(tree, parts);

  // Build argv from payload. For unknown commands, pass the raw command words
  // so Commander's "command:*" handler fires and produces the same stderr
  // output as direct CLI execution (ac-response-parity).
  const argv = cmdMeta
    ? buildCommandArgv({ command: payload.command, args: payload.args, id: payload.id }, cmdMeta)
    : parts;

  // Reset Commander state and ALL output mode globals between dispatches.
  // setOutputFormat("text") resets json, yaml, or any other format — unlike
  // setJsonMode(false) which only clears json and leaves yaml intact.
  // AC: @daemon-command-api ac-response-parity — prevents output mode leaking between requests
  resetCommandTree(program);
  setOutputFormat("text");
  setVerboseMode(false);

  // Capture stdout and stderr separately.
  // Intercepts both console.log/error/warn AND process.stdout/stderr.write
  // because CLI commands use both paths (e.g., plan export uses process.stdout.write).
  // AC: @daemon-command-api ac-response-parity — full stdout/stderr capture
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;

  console.log = (...args: unknown[]) => {
    stdoutChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n",
    );
  };
  console.error = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n",
    );
  };
  console.warn = (...args: unknown[]) => {
    stderrChunks.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n",
    );
  };

  // Intercept process.stdout.write / process.stderr.write so commands that
  // bypass console (e.g., process.stdout.write(...)) are also captured.
  process.stdout.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    stdoutChunks.push(text);
    // Invoke the callback if provided (Node stream write signature)
    const cb =
      typeof rest[0] === "function" ? rest[0] : typeof rest[1] === "function" ? rest[1] : undefined;
    if (cb) (cb as () => void)();
    return true;
  };
  process.stderr.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    const text =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    stderrChunks.push(text);
    const cb =
      typeof rest[0] === "function" ? rest[0] : typeof rest[1] === "function" ? rest[1] : undefined;
    if (cb) (cb as () => void)();
    return true;
  };

  installExitInterceptor();

  const originalCwd = process.cwd();
  let exitCode = 0;

  try {
    // Set process.cwd() to the project path so initContext() discovers
    // the correct kspec project
    process.chdir(projectPath);

    // Run inside runWithoutSpecDirOverride so initContext() ignores the
    // KSPEC_SPEC_DIR env var (which may be set by concurrent threads such
    // as batch-atomic mode or test fixtures) and resolves the project
    // purely from cwd.  This avoids mutating process.env which is shared
    // across all threads in the process.
    const parseCommand = () =>
      runWithoutSpecDirOverride(() => program.parseAsync(argv, { from: "user" }));
    if (cacheAccessor) {
      await runWithEntityCache(parseCommand, cacheAccessor, projectPath);
    } else {
      await parseCommand();
    }
  } catch (err) {
    if (err instanceof BatchExitError) {
      exitCode = err.code;
    } else {
      exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      stderrChunks.push(msg);
    }
  } finally {
    process.chdir(originalCwd);
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    uninstallExitInterceptor();
  }

  // Combine captured chunks verbatim — no trimming, to preserve response
  // parity with direct CLI execution.
  // AC: @daemon-command-api ac-response-parity — exact stdout/stderr match
  const stdout = stdoutChunks.join("");
  const stderr = stderrChunks.join("");

  // Filter BatchExitError noise from stderr (preserving other content intact)
  const filteredStderr = stderr
    .split("\n")
    .filter((line) => !line.includes("BatchExitError"))
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
  const { pubsub, getEntityCache } = options;

  // In-process mutex serializes all command dispatches to protect
  // process-global state (cwd, console, exit interceptor).
  const dispatchMutex = new DispatchMutex();

  // Lazy-loaded Commander program reference — loaded once on first request
  let _program: Command | null = null;
  const getProgram = async (): Promise<Command> => {
    if (!_program) {
      // Ensure the split storage backend is registered before CLI commands execute.
      // The CLI's task commands need this backend for split-format task storage.
      const { ensureSplitBackendRegistered } = await import("../../parser/split-backend.js");
      ensureSplitBackendRegistered();

      const { program } = await import("../../cli/index.js");
      _program = program;
    }
    return _program;
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
        async ({ body, projectContext, set }) => {
          const program = await getProgram();

          // Single command mode
          const payload: CommandPayload = {
            command: body.command,
            args: body.args ?? {},
            id: body.id,
          };

          const mutating = await isCommandMutating(payload, program);
          const cache = getEntityCache?.(projectContext.path) ?? null;

          if (!mutating && cache && canServeFromCache(payload, cache)) {
            return executeCommand(payload, program, projectContext.path, getEntityCache);
          }

          // All command execution goes through the dispatch mutex to serialize
          // process-global state (cwd, console capture, exit interceptor).
          // Mutating commands additionally acquire the cross-process file lock.
          const result = await dispatchMutex.run(async () => {
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
          });

          // AC: @daemon-command-api ac-mutation-cache-update — update cache before response
          if (mutating && result.exitCode === 0) {
            const cache = getEntityCache?.(projectContext.path);
            if (cache) {
              await Promise.all(
                MUTATION_AFFECTED_DOMAINS.map((domain) =>
                  cache.writeThrough(domain).catch(() => {
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

          // Batch execution goes through the dispatch mutex (process-global
          // state protection) and optionally the file lock (cross-process).
          const batchResult = await dispatchMutex.run(async () => {
            const runBatch = () => {
              const originalCwd = process.cwd();
              process.chdir(projectPath);
              // Run inside runWithoutSpecDirOverride so initContext() ignores
              // the ambient KSPEC_SPEC_DIR env var (same rationale as
              // executeCommand above — avoids process.env mutation races).
              return runWithoutSpecDirOverride(() =>
                executeBatch(batchCommands, program, {
                  atomic: body.atomic !== false, // Default atomic
                  continueOnError: body.continue_on_error ?? false,
                  dryRun: false,
                  json: true,
                }),
              ).finally(() => {
                process.chdir(originalCwd);
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
          });

          // AC: @daemon-command-api ac-batch-support, ac-mutation-cache-update
          // Update cache once after batch completes
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
