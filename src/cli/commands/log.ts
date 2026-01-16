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
  options: { limit: number; since?: string; cwd?: string }
): LogCommit[] {
  const { limit, since, cwd } = options;

  // Escape special regex characters in pattern except @
  const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let cmd = `git log --grep="${escapedPattern}" --format="%H|%aI|%s|%an" -n ${limit}`;
  if (since) {
    cmd += ` --since="${since}"`;
  }

  try {
    const result = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
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
  } catch {
    return [];
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
            error('Not a git repository');
            process.exit(1);
          }

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
              error(`Reference not found: ${ref}`);
              process.exit(3);
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

          if (patterns.length === 0) {
            error('Provide a reference or use --spec/--task');
            process.exit(2);
          }

          // Search for all patterns and dedupe
          const allCommits: LogCommit[] = [];
          const seenHashes = new Set<string>();
          const limit = parseInt(options.limit, 10);

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
          error('Failed to search commits', err);
          process.exit(1);
        }
      }
    );
}
