/**
 * Ralph command - automated task loop
 *
 * Runs Claude Code in a loop to process tasks autonomously.
 * Each iteration picks a task, works on it, documents progress,
 * commits, and reflects.
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { initContext } from '../../parser/index.js';
import { output, error, info, success, isJsonMode } from '../output.js';
import { gatherSessionContext, type SessionContext } from './session.js';

// ─── Prompt Template ─────────────────────────────────────────────────────────

function buildPrompt(
  sessionCtx: SessionContext,
  iteration: number,
  maxLoops: number
): string {
  const isFinal = iteration === maxLoops;

  return `# Kspec Automation Session

You are running as part of a kspec automation loop. This is iteration ${iteration} of ${maxLoops}.

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

// ─── Command Registration ────────────────────────────────────────────────────

export function registerRalphCommand(program: Command): void {
  program
    .command('ralph')
    .description('Run Claude Code in a loop to process ready tasks')
    .option('--max-loops <n>', 'Maximum iterations', '5')
    .option('--max-retries <n>', 'Max retries per iteration on error', '3')
    .option('--max-failures <n>', 'Max consecutive failed iterations before exit', '3')
    .option('--dry-run', 'Show prompt without executing')
    .option('--yolo', 'Use --dangerously-skip-permissions (default)', true)
    .option('--no-yolo', 'Require normal permission prompts')
    .action(async (options) => {
      try {
        const maxLoops = parseInt(options.maxLoops, 10);
        const maxRetries = parseInt(options.maxRetries, 10);
        const maxFailures = parseInt(options.maxFailures, 10);

        if (isNaN(maxLoops) || maxLoops < 1) {
          error('--max-loops must be a positive integer');
          process.exit(1);
        }

        if (isNaN(maxRetries) || maxRetries < 0) {
          error('--max-retries must be a non-negative integer');
          process.exit(1);
        }

        if (isNaN(maxFailures) || maxFailures < 1) {
          error('--max-failures must be a positive integer');
          process.exit(1);
        }

        info(`Starting ralph loop (max ${maxLoops} iterations, ${maxRetries} retries, ${maxFailures} max failures, yolo=${options.yolo})`);

        let consecutiveFailures = 0;

        for (let iteration = 1; iteration <= maxLoops; iteration++) {
          console.log(chalk.cyan(`\n${'─'.repeat(60)}`));
          console.log(chalk.cyan.bold(`Iteration ${iteration}/${maxLoops}`));
          console.log(chalk.cyan(`${'─'.repeat(60)}\n`));

          // Gather fresh context each iteration
          const ctx = await initContext();
          const sessionCtx = await gatherSessionContext(ctx, { limit: '10' });

          // Check for ready tasks or active tasks
          const hasActiveTasks = sessionCtx.active_tasks.length > 0;
          const hasReadyTasks = sessionCtx.ready_tasks.length > 0;

          if (!hasActiveTasks && !hasReadyTasks) {
            info('No active or ready tasks. Exiting loop.');
            break;
          }

          // Build prompt
          const prompt = buildPrompt(sessionCtx, iteration, maxLoops);

          if (options.dryRun) {
            console.log(chalk.yellow('=== DRY RUN - Prompt that would be sent ===\n'));
            console.log(prompt);
            console.log(chalk.yellow('\n=== END DRY RUN ==='));
            break;
          }

          // Build claude command args
          const claudeArgs = ['-p'];
          if (options.yolo) {
            claudeArgs.push('--dangerously-skip-permissions');
          }

          // Retry loop for this iteration
          let lastError: Error | null = null;
          let succeeded = false;

          for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            if (attempt > 1) {
              console.log(chalk.yellow(`\nRetry attempt ${attempt - 1}/${maxRetries}...`));
            }

            info(`Invoking Claude Code...`);

            try {
              // Execute Claude, piping prompt through stdin to avoid shell escaping issues
              const exitCode = await new Promise<number>((resolve, reject) => {
                const child = spawn('claude', claudeArgs, {
                  cwd: process.cwd(),
                  stdio: ['pipe', 'inherit', 'inherit'],
                });

                // Write prompt to stdin and close it
                child.stdin.write(prompt);
                child.stdin.end();

                child.on('close', (code) => {
                  resolve(code ?? 1);
                });

                child.on('error', (err) => {
                  reject(err);
                });
              });

              if (exitCode === 0) {
                succeeded = true;
                break;
              } else {
                lastError = new Error(`Claude exited with status ${exitCode}`);
                error(`Claude exited with status ${exitCode}`);
              }
            } catch (err) {
              lastError = err as Error;
              error('Failed to run Claude:', (err as Error).message);
            }
          }

          if (succeeded) {
            success(`Completed iteration ${iteration}`);
            consecutiveFailures = 0; // Reset on success
          } else {
            consecutiveFailures++;
            error(`Iteration ${iteration} failed after ${maxRetries + 1} attempts (${consecutiveFailures}/${maxFailures} consecutive failures)`);
            if (lastError) {
              error('Last error:', lastError.message);
            }

            if (consecutiveFailures >= maxFailures) {
              error(`Reached ${maxFailures} consecutive failures. Exiting loop.`);
              break;
            }

            info('Continuing to next iteration...');
          }
        }

        console.log(chalk.green(`\n${'─'.repeat(60)}`));
        success('Ralph loop completed');
        console.log(chalk.green(`${'─'.repeat(60)}\n`));

      } catch (err) {
        error('Ralph loop failed', err);
        process.exit(1);
      }
    });
}
