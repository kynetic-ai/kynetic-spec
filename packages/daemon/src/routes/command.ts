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
 * - @trait-api-endpoint ac-1: returns 2xx with JSON body on success
 * - @trait-api-endpoint ac-3: returns 400 on invalid body
 * - @trait-api-endpoint ac-6: includes X-Request-Id header
 */

import { Elysia, t } from "elysia";
import { ulid } from "ulidx";
import type { Command } from "commander";
import type { PubSubManager } from "../websocket/pubsub";
import type { EntityCacheAccessor } from "./entity-cache-types.js";
import type { CacheDomain } from "../../daemon/entity-cache.js";

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

// ── Route Options ──────────────────────────────────────────────────

interface CommandRouteOptions {
  pubsub: PubSubManager;
  getEntityCache?: EntityCacheAccessor;
}

// ── In-Process Dispatch Mutex ────────────────────────────────────────

/**
 * Promise-based mutex that serializes all command dispatches within the
 * daemon process. Required because executeCommand mutates process-global
 * state (process.cwd(), console.log/error/warn, process.exit interceptor)
 * that would corrupt concurrent requests if not serialized.
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
 * console.log/error/warn, process.exit) and MUST be called inside the
 * dispatch mutex to prevent concurrent request corruption.
 *
 * Reuses the batch execution infrastructure (OutputCapture, exit interceptor,
 * resetCommandTree) to run a command via Commander's parseAsync with captured
 * output streams.
 *
 * AC: @daemon-command-api ac-command-endpoint — executes command in-process
 * AC: @daemon-command-api ac-response-parity — captures same stdout/stderr as direct CLI
 */
async function executeCommand(
  payload: CommandPayload,
  program: Command,
  projectPath: string,
): Promise<CommandResult> {
  // Lazy import to avoid loading the full CLI at daemon startup
  const { buildCommandArgv, resetCommandTree } = await import("../../cli/batch-exec.js");
  const { extractCommandTree, findCommand } = await import("../../cli/introspection.js");
  const { installExitInterceptor, uninstallExitInterceptor, BatchExitError } =
    await import("../../cli/batch-context.js");
  const { setJsonMode, setVerboseMode } = await import("../../cli/output.js");

  const tree = extractCommandTree(program);
  const parts = payload.command.trim().split(/\s+/);
  const cmdMeta = findCommand(tree, parts);

  if (!cmdMeta) {
    return {
      stdout: "",
      stderr: `Unknown command: "${payload.command}"`,
      exitCode: 1,
    };
  }

  // Build argv from payload
  const argv = buildCommandArgv(
    { command: payload.command, args: payload.args, id: payload.id },
    cmdMeta,
  );

  // Reset Commander state between dispatches
  resetCommandTree(program);
  setJsonMode(false);
  setVerboseMode(false);

  // Capture stdout and stderr separately
  // AC: @daemon-command-api ac-response-parity — stdout/stderr separation
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  console.log = (...args: unknown[]) => {
    stdoutLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderrLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    stderrLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  installExitInterceptor();

  const originalCwd = process.cwd();
  let exitCode = 0;

  try {
    // Set process.cwd() to the project path so initContext() discovers
    // the correct kspec project
    process.chdir(projectPath);
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof BatchExitError) {
      exitCode = err.code;
      // Filter BatchExitError noise from captured output
      const filteredStderr = stderrLines
        .filter((line) => !line.includes("BatchExitError"))
        .join("\n")
        .trim();
      if (filteredStderr) {
        stderrLines.length = 0;
        stderrLines.push(filteredStderr);
      }
    } else {
      exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      stderrLines.push(msg);
    }
  } finally {
    process.chdir(originalCwd);
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
    uninstallExitInterceptor();
  }

  return {
    stdout: stdoutLines.join("\n"),
    stderr: stderrLines.join("\n"),
    exitCode,
  };
}

/**
 * Determine if a command payload represents a mutating command.
 * Uses the same introspection mechanism as the batch command filter.
 */
async function isCommandMutating(
  payload: CommandPayload,
  program: Command,
): Promise<boolean> {
  const { extractCommandTree, findCommand } = await import("../../cli/introspection.js");
  const tree = extractCommandTree(program);
  const parts = payload.command.trim().split(/\s+/);
  const cmdMeta = findCommand(tree, parts);
  return cmdMeta?.mutating === true;
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

  return new Elysia({ prefix: "/api/command" })
    // AC: @trait-api-endpoint ac-6 — X-Request-Id header on all responses
    .onBeforeHandle(({ set }) => {
      set.headers["X-Request-Id"] = ulid();
    })

    // AC: @daemon-command-api ac-command-endpoint — single command execution
    // AC: @daemon-command-api ac-response-parity — stdout/stderr/exitCode parity
    // AC: @daemon-command-api ac-mutation-cache-update — cache + broadcast after mutations
    // AC: @daemon-command-api ac-concurrent-mutations — dispatch mutex + file lock
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

        // All command execution goes through the dispatch mutex to serialize
        // process-global state (cwd, console capture, exit interceptor).
        // Mutating commands additionally acquire the cross-process file lock.
        const result = await dispatchMutex.run(async () => {
          if (mutating) {
            // AC: @daemon-command-api ac-concurrent-mutations — file lock for cross-process safety
            const { withFileLock } = await import("../../parser/file-lock.js");
            const lockPath = `${projectContext.path}/.kspec/shadow-mutation`;
            return withFileLock(lockPath, () =>
              executeCommand(payload, program, projectContext.path),
            );
          }
          return executeCommand(payload, program, projectContext.path);
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
            return executeBatch(batchCommands, program, {
              atomic: body.atomic !== false, // Default atomic
              continueOnError: body.continue_on_error ?? false,
              dryRun: false,
              json: true,
            }).finally(() => {
              process.chdir(originalCwd);
            });
          };

          if (hasMutating) {
            // AC: @daemon-command-api ac-concurrent-mutations — file lock for cross-process safety
            const { withFileLock } = await import("../../parser/file-lock.js");
            const lockPath = `${projectPath}/.kspec/shadow-mutation`;
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
    );
}
