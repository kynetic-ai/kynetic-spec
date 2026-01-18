/**
 * Meta CLI commands for interacting with meta-spec.
 *
 * AC-meta-manifest-1: kspec meta show outputs summary
 * AC-meta-manifest-2: kspec validate includes meta line
 * AC-meta-manifest-3: kspec validate shows meta errors with prefix
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  initContext,
  loadMetaContext,
  getMetaStats,
  type MetaContext,
} from '../../parser/index.js';
import { output, error } from '../output.js';

/**
 * Format meta show output
 */
function formatMetaShow(meta: MetaContext): void {
  const stats = getMetaStats(meta);

  if (!meta.manifest) {
    console.log(chalk.yellow('No meta manifest found (kynetic.meta.yaml)'));
    console.log(chalk.gray('Create one to define agents, workflows, conventions, and observations'));
    return;
  }

  console.log(chalk.bold('Meta-Spec Summary'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`Agents:       ${stats.agents}`);
  console.log(`Workflows:    ${stats.workflows}`);
  console.log(`Conventions:  ${stats.conventions}`);
  console.log(`Observations: ${stats.observations} (${stats.unresolvedObservations} unresolved)`);
}

/**
 * Register meta commands
 */
export function registerMetaCommands(program: Command): void {
  const meta = program
    .command('meta')
    .description('Meta-spec commands (agents, workflows, conventions, observations)');

  // AC-meta-manifest-1: kspec meta show outputs summary with counts
  meta
    .command('show')
    .description('Display meta-spec summary')
    .action(async () => {
      try {
        const ctx = await initContext();

        if (!ctx.manifestPath) {
          error('No kspec project found');
          process.exit(1);
        }

        const metaCtx = await loadMetaContext(ctx);
        const stats = getMetaStats(metaCtx);

        output(
          {
            manifest: metaCtx.manifestPath,
            stats,
          },
          () => formatMetaShow(metaCtx)
        );
      } catch (err) {
        error('Failed to show meta', err);
        process.exit(1);
      }
    });
}
