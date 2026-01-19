/**
 * Log command - search git history by spec/task reference
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import {
  initContext,
  loadAllTasks,
  loadAllItems,
  ReferenceIndex,
} from '../../parser/index.js';
import { output, error, info } from '../output.js';
import { isGitRepo } from '../../utils/git.js';
import { errors } from '../../strings/index.js';
import { EXIT_CODES } from '../exit-codes.js';

export interface LogCommit {
  hash: string;
  fullHash: string;
  date: Date;
  subject: string;
  author: string;
}

/**
 * Search git log for commits with trailer pattern
 */
function searchCommits(
  pattern: string,
  options: {
    limit: number;
    since?: string;
    cwd?: string;
    passthroughArgs?: string[];
  }
): LogCommit[] {
  const { limit, since, cwd, passthroughArgs = [] } = options;

  // Escape special regex characters in pattern except @
  const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let cmd = `git log --grep="${escapedPattern}" --format="%H|%aI|%s|%an" -n ${limit}`;
  if (since) {
    cmd += ` --since="${since}"`;
  }

  // Add passthrough args if provided
  if (passthroughArgs.length > 0) {
    cmd += ` ${passthroughArgs.join(' ')}`;
  }

  try {
    const result = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!result) return [];

    return result.split('\n').map((line) => {
      const [fullHash, dateStr, subject, author] = line.split('|');
      return {
        hash: fullHash.slice(0, 7),
        fullHash,
        date: new Date(dateStr),
        subject,
        author,
      };
    });
  } catch (err: any) {
    // If git command fails, show error and exit
    if (err.stderr) {
      error(err.stderr.toString());
      process.exit(err.status || 1);
    }
    return [];
  }
}

/**
 * Search git log with passthrough args (raw output)
 */
function searchCommitsRaw(
  patterns: string[],
  options: {
    limit: number;
    since?: string;
    cwd?: string;
    passthroughArgs: string[];
  }
): string {
  const { limit, since, cwd, passthroughArgs } = options;

  // Build grep args for all patterns
  const grepArgs = patterns.map((p) => {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `--grep="${escaped}"`;
  });

  let cmd = `git log ${grepArgs.join(' ')} -n ${limit}`;
  if (since) {
    cmd += ` --since="${since}"`;
  }

  // Add passthrough args
  cmd += ` ${passthroughArgs.join(' ')}`;

  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // If git command fails, show error and exit
    if (err.stderr) {
      error(err.stderr.toString());
      process.exit(err.status || 1);
    }
    return '';
  }
}

/**
 * Register the 'log' command
 */
export function registerLogCommand(program: Command): void {
  program
    .command('log [ref]')
    .description('Search git history for commits related to a spec or task')
    .option('--spec <ref>', 'Search for commits with Spec: trailer')
    .option('--task <ref>', 'Search for commits with Task: trailer')
    .option('-n, --limit <n>', 'Limit results', '10')
    .option('--oneline', 'Compact output format')
    .option('--since <time>', 'Only commits after date')
    .allowUnknownOption()
    .action(
      async (
        ref: string | undefined,
        options: {
          spec?: string;
          task?: string;
          limit: string;
          oneline?: boolean;
          since?: string;
        }
      ) => {
        try {
          const ctx = await initContext();

          if (!isGitRepo(ctx.rootDir)) {
            error(errors.git.notGitRepo);
            process.exit(EXIT_CODES.ERROR);
          }

          // Parse passthrough args (everything after --)
          const dashDashIndex = process.argv.indexOf('--');
          const passthroughArgs =
            dashDashIndex !== -1 ? process.argv.slice(dashDashIndex + 1) : [];

          // Determine what to search for
          const tasks = await loadAllTasks(ctx);
          const items = await loadAllItems(ctx);
          const index = new ReferenceIndex(tasks, items);

          // Build search patterns
          const patterns: string[] = [];

          if (ref) {
            // Resolve the reference to get canonical form
            const result = index.resolve(ref);
            if (!result.ok) {
              error(errors.reference.refNotFound(ref));
              process.exit(EXIT_CODES.NOT_FOUND);
            }

            // Determine if it's a task or spec
            const isTask = tasks.some((t) => t._ulid === result.ulid);
            const refString = ref.startsWith('@') ? ref : `@${ref}`;

            if (isTask) {
              patterns.push(`Task: ${refString}`);
            } else {
              // For spec items, search for Spec trailer AND Task trailers of linked tasks
              patterns.push(`Spec: ${refString}`);
              // Also find tasks that reference this spec
              const linkedTasks = tasks.filter((t) => t.spec_ref === refString);
              for (const t of linkedTasks) {
                const taskRef = t.slugs[0] ? `@${t.slugs[0]}` : `@${t._ulid.slice(0, 8)}`;
                patterns.push(`Task: ${taskRef}`);
              }
            }
          }

          if (options.spec) {
            patterns.push(
              `Spec: ${options.spec.startsWith('@') ? options.spec : '@' + options.spec}`
            );
          }

          if (options.task) {
            patterns.push(
              `Task: ${options.task.startsWith('@') ? options.task : '@' + options.task}`
            );
          }

          // AC: @cmd-log list-all-tracked
          // If no patterns specified, list all commits with Task: or Spec: trailers
          if (patterns.length === 0) {
            patterns.push('Task: @');
            patterns.push('Spec: @');
          }

          const limit = parseInt(options.limit, 10);

          // AC: @cmd-log passthrough-args, passthrough-invalid
          // If passthrough args are present, use raw git output
          if (passthroughArgs.length > 0) {
            const rawOutput = searchCommitsRaw(patterns, {
              limit,
              since: options.since,
              cwd: ctx.rootDir,
              passthroughArgs,
            });

            if (!rawOutput.trim()) {
              info('No commits found');
            } else {
              console.log(rawOutput);
            }
            return;
          }

          // Search for all patterns and dedupe
          const allCommits: LogCommit[] = [];
          const seenHashes = new Set<string>();

          for (const pattern of patterns) {
            const commits = searchCommits(pattern, {
              limit,
              since: options.since,
              cwd: ctx.rootDir,
            });

            for (const commit of commits) {
              if (!seenHashes.has(commit.fullHash)) {
                seenHashes.add(commit.fullHash);
                allCommits.push(commit);
              }
            }
          }

          // Sort by date descending
          allCommits.sort((a, b) => b.date.getTime() - a.date.getTime());

          // Limit results
          const limited = allCommits.slice(0, limit);

          output(limited, () => {
            if (limited.length === 0) {
              info('No commits found');
              return;
            }

            if (options.oneline) {
              for (const commit of limited) {
                console.log(`${chalk.yellow(commit.hash)} ${commit.subject}`);
              }
            } else {
              for (const commit of limited) {
                console.log(chalk.yellow(`commit ${commit.fullHash}`));
                console.log(`Author: ${commit.author}`);
                console.log(`Date:   ${commit.date.toISOString()}`);
                console.log('');
                console.log(`    ${commit.subject}`);
                console.log('');
              }
            }

            console.log(chalk.gray(`${limited.length} commit(s) found`));
          });
        } catch (err) {
          error(errors.failures.searchCommits, err);
          process.exit(EXIT_CODES.ERROR);
        }
      }
    );
}
