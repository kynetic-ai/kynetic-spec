/**
 * Ralph command - automated task loop via ACP.
 *
 * Runs an ACP-compliant agent in a loop to process tasks autonomously.
 * Uses session event storage for full audit trail and streaming output.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { ulid } from 'ulid';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { initContext } from '../../parser/index.js';
import { error, info, success } from '../output.js';
import { gatherSessionContext, type SessionContext } from './session.js';
import { resolveAdapter, registerAdapter, type AgentAdapter } from '../../agents/index.js';
import { spawnAndInitialize, type SpawnedAgent } from '../../agents/spawner.js';
import type { SessionUpdate } from '../../acp/index.js';
import type { ACPClient } from '../../acp/client.js';
import {
  createSession,
  updateSessionStatus,
  appendEvent,
} from '../../sessions/index.js';
import { createTranslator, createCliRenderer } from '../../ralph/index.js';
import { errors } from '../../strings/index.js';

// ─── Prompt Template ─────────────────────────────────────────────────────────

function buildPrompt(
  sessionCtx: SessionContext,
  iteration: number,
  maxLoops: number,
  focus?: string
): string {
  const isFinal = iteration === maxLoops;

  const focusSection = focus ? `
## Session Focus (applies to ALL iterations)

> **${focus}**

Keep this focus in mind throughout your work. It takes priority over default task selection.
` : '';

  return `# Kspec Automation Session

You are running as part of a kspec automation loop. This is iteration ${iteration} of ${maxLoops}.
${focusSection}

## Current State
\`\`\`json
${JSON.stringify(sessionCtx, null, 2)}
\`\`\`

## Working Procedure

1. **Pick a task**: Review ready_tasks above. Pick the highest priority task (lowest number = higher priority). If there's an active (in_progress) task, continue that instead.

2. **Start the task** (if not already in_progress):
   \`\`\`bash
   npm run dev -- task start @task-ref
   \`\`\`

3. **Do the work**:
   - Read relevant files to understand the task
   - Make changes as needed
   - Run tests if applicable
   - Document as you go with task notes

4. **Document progress**:
   \`\`\`bash
   npm run dev -- task note @task-ref "What you did, decisions made, etc."
   \`\`\`

5. **Complete or checkpoint**:
   - If task is DONE:
     \`\`\`bash
     npm run dev -- task complete @task-ref --reason "Summary of completion"
     \`\`\`
   - If task is NOT done (WIP):
     \`\`\`bash
     npm run dev -- task note @task-ref "WIP: What's done, what remains..."
     \`\`\`

6. **Commit your work**:
   \`\`\`bash
   git add -A && git commit -m "feat/fix/chore: description

   Task: @task-ref"
   \`\`\`

7. **Reflect on this iteration**:
   Think about what you learned, any friction points, or observations worth remembering.
   Add them to inbox:
   \`\`\`bash
   npm run dev -- inbox add "Observation: ..."
   \`\`\`

## Important Notes
- Stay focused on ONE task per iteration
- The loop continues automatically - don't worry about picking the next task
- kspec tracks state across iterations via task status and notes
- Always commit before the iteration ends
- Always reflect and add at least one observation to inbox
${isFinal ? `
## FINAL ITERATION
This is the last iteration of the loop. After completing your work:
1. Commit any remaining changes
2. Reflect on the overall session
3. Add any final insights to inbox
` : ''}`;
}

// ─── Streaming Output ────────────────────────────────────────────────────────

// Translator and renderer are created per-session in the action handler.
// This allows the architecture to be reused by future TUI renderers.

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
  yolo: boolean
): Promise<void> {
  const p = params as Record<string, unknown>;

  try {
    switch (method) {
      case 'session/request_permission': {
        // In yolo mode, auto-approve all permissions
        // In normal mode, would need to implement permission UI
        const options = (p.options as Array<{ optionId: string; kind: string; name: string }>) || [];

        if (yolo) {
          // Find an "allow" option (prefer allow_always, then allow_once)
          const allowOption = options.find(o => o.kind === 'allow_always')
            || options.find(o => o.kind === 'allow_once');

          if (allowOption) {
            client.respondPermission(id, {
              outcome: { outcome: 'selected', optionId: allowOption.optionId },
            });
          } else {
            // No allow option available - cancel
            client.respondPermission(id, { outcome: { outcome: 'cancelled' } });
          }
        } else {
          // TODO: Implement permission prompting
          client.respondPermission(id, { outcome: { outcome: 'cancelled' } });
        }
        break;
      }

      case 'file/read': {
        const filePath = p.path as string;
        const content = await fs.readFile(filePath, 'utf-8');
        client.respond(id, { content });
        break;
      }

      case 'file/write': {
        const filePath = p.path as string;
        const content = p.content as string;
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        client.respond(id, {});
        break;
      }

      case 'terminal/run': {
        const command = p.command as string;
        const cwd = (p.cwd as string) || process.cwd();
        const timeout = (p.timeout as number) || 60000;

        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          const child = spawn(command, [], {
            cwd,
            shell: true,
            timeout,
          });

          let stdout = '';
          let stderr = '';

          child.stdout?.on('data', (data) => {
            stdout += data.toString();
          });

          child.stderr?.on('data', (data) => {
            stderr += data.toString();
          });

          child.on('close', (code) => {
            resolve({ stdout, stderr, exitCode: code ?? 1 });
          });

          child.on('error', (err) => {
            resolve({ stdout, stderr: err.message, exitCode: 1 });
          });
        });

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
    .command('ralph')
    .description('Run ACP agent in a loop to process ready tasks')
    .option('--max-loops <n>', 'Maximum iterations', '5')
    .option('--max-retries <n>', 'Max retries per iteration on error', '3')
    .option('--max-failures <n>', 'Max consecutive failed iterations before exit', '3')
    .option('--dry-run', 'Show prompt without executing')
    .option('--yolo', 'Use dangerously-skip-permissions (default)', true)
    .option('--no-yolo', 'Require normal permission prompts')
    .option('--adapter <id>', 'Agent adapter to use', 'claude-code-acp')
    .option('--adapter-cmd <cmd>', 'Custom adapter command (for testing)')
    .option('--focus <instructions>', 'Focus instructions included in every iteration prompt')
    .action(async (options) => {
      try {
        const maxLoops = parseInt(options.maxLoops, 10);
        const maxRetries = parseInt(options.maxRetries, 10);
        const maxFailures = parseInt(options.maxFailures, 10);

        if (isNaN(maxLoops) || maxLoops < 1) {
          error(errors.usage.maxLoopsPositive);
          process.exit(1);
        }

        if (isNaN(maxRetries) || maxRetries < 0) {
          error(errors.usage.maxRetriesNonNegative);
          process.exit(1);
        }

        if (isNaN(maxFailures) || maxFailures < 1) {
          error(errors.usage.maxFailuresPositive);
          process.exit(1);
        }

        // Handle custom adapter command for testing
        if (options.adapterCmd) {
          const parts = options.adapterCmd.split(/\s+/);
          const customAdapter: AgentAdapter = {
            command: parts[0],
            args: parts.slice(1),
            description: 'Custom adapter via --adapter-cmd',
          };
          registerAdapter('custom', customAdapter);
          options.adapter = 'custom';
        }

        // Resolve adapter
        const adapter = resolveAdapter(options.adapter);

        // Add yolo flag to adapter args if needed
        if (options.yolo && options.adapter === 'claude-code-acp') {
          adapter.args = [...adapter.args, '--dangerously-skip-permissions'];
        }

        info(`Starting ralph loop (adapter=${options.adapter}, max ${maxLoops} iterations, ${maxRetries} retries, ${maxFailures} max failures)`);
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
          type: 'session.start',
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

            // Gather fresh context each iteration
            const sessionCtx = await gatherSessionContext(ctx, { limit: '10' });

            // Check for ready tasks or active tasks
            const hasActiveTasks = sessionCtx.active_tasks.length > 0;
            const hasReadyTasks = sessionCtx.ready_tasks.length > 0;

            if (!hasActiveTasks && !hasReadyTasks) {
              info('No active or ready tasks. Exiting loop.');
              break;
            }

            // Build prompt
            const prompt = buildPrompt(sessionCtx, iteration, maxLoops, options.focus);

            if (options.dryRun) {
              console.log(chalk.yellow('=== DRY RUN - Prompt that would be sent ===\n'));
              console.log(prompt);
              console.log(chalk.yellow('\n=== END DRY RUN ==='));
              break;
            }

            // Log prompt
            await appendEvent(specDir, {
              session_id: sessionId,
              type: 'prompt.sent',
              data: {
                iteration,
                prompt,
                tasks: {
                  active: sessionCtx.active_tasks.map(t => t.ref),
                  ready: sessionCtx.ready_tasks.map(t => t.ref),
                },
              },
            });

            // Retry loop for this iteration
            let lastError: Error | null = null;
            let succeeded = false;

            for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
              if (attempt > 1) {
                console.log(chalk.yellow(`\nRetry attempt ${attempt - 1}/${maxRetries}...`));
              }

              try {
                // Spawn agent if not already running
                if (!agent) {
                  info('Spawning ACP agent...');
                  agent = await spawnAndInitialize(adapter, {
                    cwd: process.cwd(),
                    clientOptions: {
                      clientInfo: {
                        name: 'kspec-ralph',
                        version: '0.1.0',
                      },
                    },
                  });

                  // Set up streaming update handler with translator + renderer
                  agent.client.on('update', (_sid: string, update: SessionUpdate) => {
                    // Translate ACP event to RalphEvent and render
                    const event = translator.translate(update);
                    if (event) {
                      renderer.render(event);
                    }
                    // Log raw update event (async, non-blocking)
                    appendEvent(specDir, {
                      session_id: sessionId,
                      type: 'session.update',
                      data: { iteration, update },
                    }).catch(() => {
                      // Ignore logging errors during streaming
                    });
                  });

                  // Set up tool request handler
                  agent.client.on('request', (reqId: string | number, method: string, params: unknown) => {
                    handleRequest(agent!.client, reqId, method, params, options.yolo).catch((err) => {
                      agent!.client.respondError(reqId, -32000, err.message);
                    });
                  });
                }

                // Create fresh ACP session per iteration to keep context clean
                info('Creating ACP session...');
                acpSessionId = await agent.client.newSession({
                  cwd: process.cwd(),
                  mcpServers: [], // No MCP servers for now
                });

                info('Sending prompt to agent...');

                // Send prompt and wait for completion
                const response = await agent.client.prompt({
                  sessionId: acpSessionId!,
                  prompt: [{ type: 'text', text: prompt }],
                });

                // Log completion
                await appendEvent(specDir, {
                  session_id: sessionId,
                  type: 'session.update',
                  data: {
                    iteration,
                    stopReason: response.stopReason,
                    completed: true,
                  },
                });

                // Check stop reason
                if (response.stopReason === 'cancelled') {
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
              success(`Completed iteration ${iteration}`);
              consecutiveFailures = 0;
              console.log(); // Newline after streaming output
            } else {
              consecutiveFailures++;
              error(errors.failures.iterationFailedAfterRetries(iteration, maxRetries, consecutiveFailures, maxFailures));
              if (lastError) {
                error(errors.failures.lastError(lastError.message));
              }

              if (consecutiveFailures >= maxFailures) {
                error(errors.failures.reachedMaxFailures(maxFailures));
                break;
              }

              info('Continuing to next iteration...');
            }
          }
        } finally {
          // Clean up agent
          if (agent) {
            agent.kill();
          }

          // Log session end
          const status = consecutiveFailures >= maxFailures ? 'abandoned' : 'completed';
          await appendEvent(specDir, {
            session_id: sessionId,
            type: 'session.end',
            data: {
              status,
              consecutiveFailures,
            },
          });
          await updateSessionStatus(specDir, sessionId, status);
        }

        console.log(chalk.green(`\n${'─'.repeat(60)}`));
        success('Ralph loop completed');
        console.log(chalk.green(`${'─'.repeat(60)}\n`));

      } catch (err) {
        error(errors.failures.ralphLoop, err);
        process.exit(1);
      }
    });
}
