/**
 * Ralph command - automated task loop via ACP.
 *
 * Runs an ACP-compliant agent in a loop to process tasks autonomously.
 * Uses session event storage for full audit trail and streaming output.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { ulid } from "ulid";

// Read version from package.json for ACP client info
const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../../../package.json");

import type { ACPClient } from "../../acp/client.js";
import type {
  ReadTextFileRequest,
  RequestPermissionRequest,
  SessionUpdate,
  WriteTextFileRequest,
} from "../../acp/index.js";
import {
  type AgentAdapter,
  registerAdapter,
  resolveAdapter,
} from "../../agents/index.js";
import { type SpawnedAgent, spawnAndInitialize } from "../../agents/spawner.js";
import { initContext } from "../../parser/index.js";
import { createCliRenderer, createTranslator } from "../../ralph/index.js";
import {
  appendEvent,
  createSession,
  saveSessionContext,
  updateSessionStatus,
} from "../../sessions/index.js";
import { errors } from "../../strings/index.js";
import { EXIT_CODES } from "../exit-codes.js";
import { error, info, success } from "../output.js";
import { gatherSessionContext, type SessionContext } from "./session.js";

// ─── Prompt Template ─────────────────────────────────────────────────────────

function buildPrompt(
  sessionCtx: SessionContext,
  iteration: number,
  maxLoops: number,
  focus?: string,
): string {
  const isFinal = iteration === maxLoops;

  const focusSection = focus
    ? `
## Session Focus (applies to ALL iterations)

> **${focus}**

Keep this focus in mind throughout your work. It takes priority over default task selection.
`
    : "";

  return `# Kspec Automation Session

You are running as part of a kspec automation loop. This is iteration ${iteration} of ${maxLoops}.
${focusSection}

## Current State
\`\`\`json
${JSON.stringify(sessionCtx, null, 2)}
\`\`\`

## Working Procedure

Follow this order each iteration:

### 1. Check for Open PRs First

\`\`\`bash
gh pr list --state open
\`\`\`

If PRs exist, review and merge them before picking new tasks:
- Spawn a subagent for local review:
  \`\`\`
  Task tool → subagent_type: "general-purpose" → prompt: "Run /local-review for PR #N. Check AC coverage, test quality, E2E preference, and test isolation."
  \`\`\`
- Use \`@pr-review-merge\` workflow to review and merge
- After merge: \`kspec task complete @task-ref --reason "Merged in PR #N"\`

**Merge strategy**: Use \`--merge\` (not \`--squash\`) to preserve kspec trailers in commit messages.

### 2. Check for Pending Review Tasks

If there's a \`pending_review\` task without a PR (or work not pushed to origin):
- Push uncommitted work: \`git push\`
- Create PR: \`/pr\`
- Spawn subagent for local review (see step 1)
- Then use \`@pr-review-merge\` workflow

### 3. Pick or Continue a Task

Use the \`/task-work\` skill for the full task lifecycle:
- If \`active_tasks\` has an \`in_progress\` task, continue it
- Otherwise pick highest priority from \`ready_tasks\` (lowest number = higher priority)

\`\`\`bash
kspec task start @task-ref  # if not already in_progress
\`\`\`

### 4. Do the Work

- Read relevant files to understand the task
- Make changes as needed
- Run tests if applicable
- Document as you go with task notes

\`\`\`bash
kspec task note @task-ref "What you did, decisions made, etc."
\`\`\`

### 5. Submit When Done

If code is DONE (ready for PR):
\`\`\`bash
kspec task submit @task-ref
\`\`\`

If task is NOT done (WIP):
\`\`\`bash
kspec task note @task-ref "WIP: What's done, what remains..."
\`\`\`

### 6. Commit Your Work

\`\`\`bash
git add -A && git commit -m "feat/fix/chore: description

Task: @task-ref"
\`\`\`

### 7. Create PR and Review

After submitting:
- Create PR: \`/pr\`
- Spawn subagent for quality check:
  \`\`\`
  Task tool → subagent_type: "general-purpose" → prompt: "Run /local-review for the PR just created. Check AC coverage, test quality, E2E preference, and test isolation."
  \`\`\`
- Merge workflow: \`@pr-review-merge\`

### 8. Reflect (End of Iteration)

Use \`/reflect\` skill. **Be selective** (no human in the loop):

**Before adding anything**, search first:
\`\`\`bash
kspec meta observations list
kspec inbox list
kspec tasks list
\`\`\`

Only add if not already captured:
- **Systemic friction only** - skip one-off issues
- **High quality successes** - unique patterns worth replicating
- **Concrete only** - skip vague ideas

## Important Notes
- Stay focused on ONE task per iteration
- The loop continues automatically - don't worry about picking the next task
- kspec tracks state across iterations via task status and notes
- Always commit before the iteration ends
- Merge PRs before starting new work
${
  isFinal
    ? `
## FINAL ITERATION
This is the last iteration of the loop. After completing your work:
1. Commit any remaining changes
2. Create PR if work is ready: \`/pr\`
3. Spawn subagent for local review, then \`@pr-review-merge\` if PR created
4. Reflect using \`/reflect\` - capture unique, high-quality insights only
`
    : ""
}`;
}

// ─── Streaming Output ────────────────────────────────────────────────────────

// Translator and renderer are created per-session in the action handler.
// This allows the architecture to be reused by future TUI renderers.

// ─── Adapter Validation ──────────────────────────────────────────────────────

// AC: @ralph-adapter-validation valid-adapter-proceeds, invalid-adapter-error, validation-before-spawn
/**
 * Validate that the specified ACP adapter package exists.
 * Uses npx --no-install to check both global and local node_modules.
 *
 * @throws {Error} Never throws - exits process with code 3 if validation fails
 */
function validateAdapter(adapterPackage: string): void {
  // Use npx --no-install with --version to check if package exists
  // This checks both global and local node_modules, handles scoped packages
  const result = spawnSync(
    "npx",
    ["--no-install", adapterPackage, "--version"],
    {
      encoding: "utf-8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    error(
      `Adapter package not found: ${adapterPackage}. Install with: npm install -g ${adapterPackage}`,
    );
    process.exit(EXIT_CODES.NOT_FOUND);
  }
}

// ─── Tool Request Handler ────────────────────────────────────────────────────

/**
 * Handle tool requests from ACP agent.
 * Implements file operations, terminal commands, and permission handling.
 */
async function handleRequest(
  client: ACPClient,
  id: string | number,
  method: string,
  params: unknown,
  yolo: boolean,
): Promise<void> {
  try {
    switch (method) {
      case "session/request_permission": {
        const p = params as RequestPermissionRequest;
        // In yolo mode, auto-approve all permissions
        // In normal mode, would need to implement permission UI
        const options = p.options || [];

        if (yolo) {
          // Find an "allow" option (prefer allow_always, then allow_once)
          const allowOption =
            options.find((o) => o.kind === "allow_always") ||
            options.find((o) => o.kind === "allow_once");

          if (allowOption) {
            client.respondPermission(id, {
              outcome: { outcome: "selected", optionId: allowOption.optionId },
            });
          } else {
            // No allow option available - cancel
            client.respondPermission(id, { outcome: { outcome: "cancelled" } });
          }
        } else {
          // TODO: Implement permission prompting
          client.respondPermission(id, { outcome: { outcome: "cancelled" } });
        }
        break;
      }

      case "file/read": {
        const p = params as ReadTextFileRequest;
        const content = await fs.readFile(p.path, "utf-8");
        client.respondReadTextFile(id, { content });
        break;
      }

      case "file/write": {
        const p = params as WriteTextFileRequest;
        await fs.mkdir(path.dirname(p.path), { recursive: true });
        await fs.writeFile(p.path, p.content, "utf-8");
        client.respondWriteTextFile(id, {});
        break;
      }

      case "terminal/run": {
        // Custom method (not part of ACP spec - ACP uses createTerminal instead)
        // TODO: Consider migrating to standard ACP terminal methods
        const p = params as {
          command: string;
          cwd?: string;
          timeout?: number;
        };
        const command = p.command;
        const cwd = p.cwd || process.cwd();
        const timeout = p.timeout || 60000;

        const result = await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve) => {
          const child = spawn(command, [], {
            cwd,
            shell: true,
            timeout,
          });

          let stdout = "";
          let stderr = "";

          child.stdout?.on("data", (data) => {
            stdout += data.toString();
          });

          child.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          child.on("close", (code) => {
            resolve({ stdout, stderr, exitCode: code ?? 1 });
          });

          child.on("error", (err) => {
            resolve({ stdout, stderr: err.message, exitCode: 1 });
          });
        });

        // Using generic respond() since this is a custom method
        client.respond(id, result);
        break;
      }

      default:
        // Unknown method - return error
        client.respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    client.respondError(id, -32000, message);
  }
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerRalphCommand(program: Command): void {
  program
    .command("ralph")
    .description("Run ACP agent in a loop to process ready tasks")
    .option("--max-loops <n>", "Maximum iterations", "5")
    .option("--max-retries <n>", "Max retries per iteration on error", "3")
    .option(
      "--max-failures <n>",
      "Max consecutive failed iterations before exit",
      "3",
    )
    .option("--dry-run", "Show prompt without executing")
    .option("--yolo", "Use dangerously-skip-permissions (default)", true)
    .option("--no-yolo", "Require normal permission prompts")
    .option("--adapter <id>", "Agent adapter to use", "claude-code-acp")
    .option("--adapter-cmd <cmd>", "Custom adapter command (for testing)")
    .option(
      "--focus <instructions>",
      "Focus instructions included in every iteration prompt",
    )
    .action(async (options) => {
      try {
        const maxLoops = parseInt(options.maxLoops, 10);
        const maxRetries = parseInt(options.maxRetries, 10);
        const maxFailures = parseInt(options.maxFailures, 10);

        if (Number.isNaN(maxLoops) || maxLoops < 1) {
          error(errors.usage.maxLoopsPositive);
          process.exit(EXIT_CODES.ERROR);
        }

        if (Number.isNaN(maxRetries) || maxRetries < 0) {
          error(errors.usage.maxRetriesNonNegative);
          process.exit(EXIT_CODES.ERROR);
        }

        if (Number.isNaN(maxFailures) || maxFailures < 1) {
          error(errors.usage.maxFailuresPositive);
          process.exit(EXIT_CODES.ERROR);
        }

        // Handle custom adapter command for testing
        if (options.adapterCmd) {
          const parts = options.adapterCmd.split(/\s+/);
          const customAdapter: AgentAdapter = {
            command: parts[0],
            args: parts.slice(1),
            description: "Custom adapter via --adapter-cmd",
          };
          registerAdapter("custom", customAdapter);
          options.adapter = "custom";
        }

        // Resolve adapter
        const adapter = resolveAdapter(options.adapter);

        // Validate adapter package exists before proceeding
        // Skip validation for custom adapters (--adapter-cmd) and non-npx adapters
        if (
          !options.adapterCmd &&
          adapter.command === "npx" &&
          adapter.args[0]
        ) {
          validateAdapter(adapter.args[0]);
        }

        // Add yolo flag to adapter args if needed
        if (options.yolo && options.adapter === "claude-code-acp") {
          adapter.args = [...adapter.args, "--dangerously-skip-permissions"];
        }

        info(
          `Starting ralph loop (adapter=${options.adapter}, max ${maxLoops} iterations, ${maxRetries} retries, ${maxFailures} max failures)`,
        );
        if (options.focus) {
          info(`Focus: ${options.focus}`);
        }

        // Initialize kspec context
        const ctx = await initContext();
        const specDir = ctx.specDir;

        // Create session for event tracking
        const sessionId = ulid();
        await createSession(specDir, {
          id: sessionId,
          agent_type: options.adapter,
          task_id: undefined, // Will be determined per iteration
        });

        // Log session start
        await appendEvent(specDir, {
          session_id: sessionId,
          type: "session.start",
          data: {
            adapter: options.adapter,
            maxLoops,
            maxRetries,
            maxFailures,
            yolo: options.yolo,
            focus: options.focus,
          },
        });

        let consecutiveFailures = 0;
        let agent: SpawnedAgent | null = null;
        let acpSessionId: string | null = null;

        // Create translator and renderer for this session
        const translator = createTranslator();
        const renderer = createCliRenderer();

        try {
          for (let iteration = 1; iteration <= maxLoops; iteration++) {
            renderer.newSection?.(`Iteration ${iteration}/${maxLoops}`);

            // Gather fresh context each iteration (only automation-eligible tasks)
            // AC: @cli-ralph ac-16
            const sessionCtx = await gatherSessionContext(ctx, {
              limit: "10",
              eligible: true,
            });

            // Check for ready tasks or active tasks
            const hasActiveTasks = sessionCtx.active_tasks.length > 0;
            const hasReadyTasks = sessionCtx.ready_tasks.length > 0;

            if (!hasActiveTasks && !hasReadyTasks) {
              info("No active or eligible ready tasks. Exiting loop.");
              break;
            }

            // Build prompt
            const prompt = buildPrompt(
              sessionCtx,
              iteration,
              maxLoops,
              options.focus,
            );

            if (options.dryRun) {
              console.log(
                chalk.yellow("=== DRY RUN - Prompt that would be sent ===\n"),
              );
              console.log(prompt);
              console.log(chalk.yellow("\n=== END DRY RUN ==="));
              break;
            }

            // Log prompt
            await appendEvent(specDir, {
              session_id: sessionId,
              type: "prompt.sent",
              data: {
                iteration,
                prompt,
                tasks: {
                  active: sessionCtx.active_tasks.map((t) => t.ref),
                  ready: sessionCtx.ready_tasks.map((t) => t.ref),
                },
              },
            });

            // Retry loop for this iteration
            let lastError: Error | null = null;
            let succeeded = false;

            for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
              if (attempt > 1) {
                console.log(
                  chalk.yellow(
                    `\nRetry attempt ${attempt - 1}/${maxRetries}...`,
                  ),
                );
              }

              try {
                // Spawn agent if not already running
                if (!agent) {
                  info("Spawning ACP agent...");
                  agent = await spawnAndInitialize(adapter, {
                    cwd: process.cwd(),
                    clientOptions: {
                      clientInfo: {
                        name: "kspec-ralph",
                        version: packageVersion,
                      },
                    },
                  });

                  // Set up streaming update handler with translator + renderer
                  agent.client.on(
                    "update",
                    (_sid: string, update: SessionUpdate) => {
                      // Translate ACP event to RalphEvent and render
                      const event = translator.translate(update);
                      if (event) {
                        renderer.render(event);
                      }
                      // Log raw update event (async, non-blocking)
                      appendEvent(specDir, {
                        session_id: sessionId,
                        type: "session.update",
                        data: { iteration, update },
                      }).catch(() => {
                        // Ignore logging errors during streaming
                      });
                    },
                  );

                  // Set up tool request handler
                  agent.client.on(
                    "request",
                    (
                      reqId: string | number,
                      method: string,
                      params: unknown,
                    ) => {
                      // biome-ignore lint/style/noNonNullAssertion: agent is guaranteed to exist when callback is registered
                      handleRequest(
                        agent!.client,
                        reqId,
                        method,
                        params,
                        options.yolo,
                      ).catch((err) => {
                        // biome-ignore lint/style/noNonNullAssertion: agent is guaranteed to exist when callback is registered
                        agent!.client.respondError(reqId, -32000, err.message);
                      });
                    },
                  );
                }

                // Create fresh ACP session per iteration to keep context clean
                info("Creating ACP session...");
                acpSessionId = await agent.client.newSession({
                  cwd: process.cwd(),
                  mcpServers: [], // No MCP servers for now
                });

                info("Sending prompt to agent...");

                // Send prompt and wait for completion
                const response = await agent.client.prompt({
                  sessionId: acpSessionId!,
                  prompt: [{ type: "text", text: prompt }],
                });

                // Log completion
                await appendEvent(specDir, {
                  session_id: sessionId,
                  type: "session.update",
                  data: {
                    iteration,
                    stopReason: response.stopReason,
                    completed: true,
                  },
                });

                // Check stop reason
                if (response.stopReason === "cancelled") {
                  throw new Error(errors.usage.agentPromptCancelled);
                }

                succeeded = true;
                break;
              } catch (err) {
                lastError = err as Error;
                error(errors.failures.iterationFailed(lastError.message));

                // Clean up agent on error - will respawn next attempt
                if (agent) {
                  agent.kill();
                  agent = null;
                  acpSessionId = null;
                }
              }
            }

            if (succeeded) {
              console.log(); // Newline after streaming output

              // Save session context snapshot for audit trail
              await saveSessionContext(
                specDir,
                sessionId,
                iteration,
                sessionCtx,
              );

              success(`Completed iteration ${iteration}`);
              consecutiveFailures = 0;
            } else {
              consecutiveFailures++;
              error(
                errors.failures.iterationFailedAfterRetries(
                  iteration,
                  maxRetries,
                  consecutiveFailures,
                  maxFailures,
                ),
              );
              if (lastError) {
                error(errors.failures.lastError(lastError.message));
              }

              if (consecutiveFailures >= maxFailures) {
                error(errors.failures.reachedMaxFailures(maxFailures));
                break;
              }

              info("Continuing to next iteration...");
            }
          }
        } finally {
          // Clean up agent
          if (agent) {
            agent.kill();
          }

          // Log session end
          const status =
            consecutiveFailures >= maxFailures ? "abandoned" : "completed";
          await appendEvent(specDir, {
            session_id: sessionId,
            type: "session.end",
            data: {
              status,
              consecutiveFailures,
            },
          });
          await updateSessionStatus(specDir, sessionId, status);
        }

        console.log(chalk.green(`\n${"─".repeat(60)}`));
        success("Ralph loop completed");
        console.log(chalk.green(`${"─".repeat(60)}\n`));
      } catch (err) {
        error(errors.failures.ralphLoop, err);
        process.exit(EXIT_CODES.ERROR);
      }
    });
}
