/**
 * Shared utilities for batch operations on multiple refs.
 * Supports --refs @a @b @c flag pattern for commands like task complete, cancel, etc.
 */

import chalk from 'chalk';
import type { ReferenceIndex } from '../parser/index.js';
import { error, isJsonMode } from './output.js';

/**
 * Result of a single ref operation within a batch
 */
export interface BatchOperationResult {
  ref: string;
  ulid: string | null;
  status: 'success' | 'error';
  error?: string;
  message?: string;
  data?: unknown;
}

/**
 * Summary of batch operation results
 */
export interface BatchSummary {
  total: number;
  succeeded: number;
  failed: number;
}

/**
 * Complete result of a batch operation
 */
export interface BatchResult {
  success: boolean;
  summary: BatchSummary;
  results: BatchOperationResult[];
}

/**
 * Options for executeBatchOperation
 */
export interface BatchOperationOptions<TItem, TContext> {
  /** The positional ref argument (if provided) */
  positionalRef?: string;
  /** The --refs flag values (if provided) */
  refsFlag?: string[];
  /** Context needed for operations */
  context: TContext;
  /** All items to search through */
  items: TItem[];
  /** Reference index for resolution */
  index: ReferenceIndex;
  /** Function to resolve a ref to an item - returns { item, error? } */
  resolveRef: (ref: string, items: TItem[], index: ReferenceIndex) => { item: TItem | null; error?: string };
  /** Function to execute the operation on a single item */
  executeOperation: (item: TItem, context: TContext) => Promise<{ success: boolean; message?: string; error?: string; data?: unknown }>;
  /** Function to extract ULID from an item */
  getUlid: (item: TItem) => string;
}

/**
 * Execute a batch operation with support for single-ref (positional) or multi-ref (--refs flag).
 * Handles mutual exclusion, partial failures, and unified output formatting.
 *
 * Returns a BatchResult object. Caller should use formatBatchOutput() to render results.
 */
export async function executeBatchOperation<TItem, TContext>(
  options: BatchOperationOptions<TItem, TContext>
): Promise<BatchResult> {
  const { positionalRef, refsFlag, context, items, index, resolveRef, executeOperation, getUlid } = options;

  // AC: @multi-ref-batch ac-3 - Mutual exclusion check
  if (positionalRef && refsFlag && refsFlag.length > 0) {
    error('Cannot use both positional ref and --refs flag');
    process.exit(3);
  }

  // Determine which refs to process
  let refs: string[];
  if (refsFlag && refsFlag.length > 0) {
    refs = refsFlag;
  } else if (positionalRef) {
    refs = [positionalRef];
  } else {
    // AC: @multi-ref-batch ac-7 - Empty refs error
    error('--refs requires at least one reference');
    process.exit(3);
  }

  // Process each ref
  const results: BatchOperationResult[] = [];

  // AC: @multi-ref-batch ac-4 - Continue processing after errors (partial failure handling)
  for (const ref of refs) {
    try {
      // AC: @multi-ref-batch ac-8 - Ref resolution uses existing logic
      const resolved = resolveRef(ref, items, index);

      if (!resolved.item) {
        // Resolution failed - record error and continue to next ref
        results.push({
          ref,
          ulid: null,
          status: 'error',
          error: resolved.error || `Failed to resolve reference: ${ref}`,
        });
        continue;
      }

      const ulid = getUlid(resolved.item);

      // Execute the operation
      const opResult = await executeOperation(resolved.item, context);

      results.push({
        ref,
        ulid: index.shortUlid(ulid),
        status: opResult.success ? 'success' : 'error',
        message: opResult.message,
        error: opResult.error,
        data: opResult.data,
      });
    } catch (err) {
      // Unexpected error during operation
      results.push({
        ref,
        ulid: null,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Calculate summary
  const succeeded = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'error').length;
  const summary: BatchSummary = {
    total: results.length,
    succeeded,
    failed,
  };

  // Determine overall success
  const success = failed === 0;

  return {
    success,
    summary,
    results,
  };
}

/**
 * Format and output batch operation results.
 * Handles both human-readable and JSON output formats.
 * Sets appropriate exit code based on results.
 *
 * AC: @multi-ref-batch ac-5 - Human output format
 * AC: @multi-ref-batch ac-6 - JSON output format
 */
export function formatBatchOutput(result: BatchResult, operationName: string): void {
  if (isJsonMode()) {
    // AC: @multi-ref-batch ac-6 - JSON output
    console.log(JSON.stringify(result, null, 2));
  } else {
    // AC: @multi-ref-batch ac-5 - Human output format
    const { summary, results } = result;

    // Summary line
    if (summary.total === 1) {
      // Single item - no summary needed, just show result
      const r = results[0];
      if (r.status === 'success') {
        console.log(chalk.green(`✓ ${operationName}: ${r.ulid || r.ref}`));
        if (r.message) {
          console.log(`  ${r.message}`);
        }
      } else {
        console.log(chalk.red(`✗ ${operationName} failed: ${r.ref}`));
        if (r.error) {
          console.log(chalk.red(`  ${r.error}`));
        }
      }
    } else {
      // Multiple items - show summary
      const verb = operationName.toLowerCase();
      console.log(`${chalk.bold(`${operationName}d ${summary.succeeded} of ${summary.total}:`
)}\n`);

      // List each result
      for (const r of results) {
        if (r.status === 'success') {
          console.log(chalk.green(`✓ ${r.ulid || r.ref}`));
          if (r.message) {
            console.log(`  ${r.message}`);
          }
        } else {
          console.log(chalk.red(`✗ ${r.ref}`));
          if (r.error) {
            console.log(chalk.red(`  ${r.error}`));
          }
        }
      }
    }
  }

  // Set exit code
  // AC: @multi-ref-batch ac-4 - Partial failure exit code
  if (!result.success) {
    if (result.summary.succeeded > 0) {
      // Partial failure
      process.exit(2);
    } else {
      // Complete failure
      process.exit(1);
    }
  }
}

/**
 * Helper to check if refs flag is being used (for backward compatibility checks)
 */
export function isBatchMode(refsFlag?: string[]): boolean {
  return Boolean(refsFlag && refsFlag.length > 0);
}
