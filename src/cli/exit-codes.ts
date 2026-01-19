/**
 * Semantic exit codes for kspec CLI
 *
 * AC: @cli-exit-codes exit-code-constants
 * Centralized constants for all CLI exit codes
 *
 * @see Use these constants instead of magic numbers throughout the CLI
 */
export const EXIT_CODES = {
  /** Command completed successfully */
  SUCCESS: 0,

  /** General error (catch-all for unexpected errors) */
  ERROR: 1,

  /** Usage error (invalid arguments, flags, or command syntax) */
  USAGE_ERROR: 2,

  /** Not found (task, spec item, inbox item, etc. doesn't exist) */
  NOT_FOUND: 3,

  /** Validation failed (invalid state, schema violation, or business rule violation) */
  VALIDATION_FAILED: 4,

  /** Conflict (resource already exists, duplicate slug, etc.) */
  CONFLICT: 5,
} as const;

/**
 * Type for exit codes
 */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Exit code metadata for documentation
 * AC: @cli-exit-codes exit-codes-documented
 */
export const EXIT_CODE_METADATA = [
  {
    code: EXIT_CODES.SUCCESS,
    name: 'SUCCESS',
    description: 'Command completed successfully',
    commands: 'All commands',
  },
  {
    code: EXIT_CODES.ERROR,
    name: 'ERROR',
    description: 'General error (unexpected error, file system error, etc.)',
    commands: 'All commands',
  },
  {
    code: EXIT_CODES.USAGE_ERROR,
    name: 'USAGE_ERROR',
    description: 'Usage error (invalid arguments, flags, or command syntax)',
    commands: 'All commands',
  },
  {
    code: EXIT_CODES.NOT_FOUND,
    name: 'NOT_FOUND',
    description: 'Resource not found (task, spec item, inbox item, etc.)',
    commands: 'task, item, inbox, derive, link, meta, tasks',
  },
  {
    code: EXIT_CODES.VALIDATION_FAILED,
    name: 'VALIDATION_FAILED',
    description: 'Validation failed (invalid state, schema violation, business rule violation)',
    commands: 'validate, task (state transitions), item (schema validation)',
  },
  {
    code: EXIT_CODES.CONFLICT,
    name: 'CONFLICT',
    description: 'Conflict (resource already exists, duplicate slug, etc.)',
    commands: 'item, task, module (when creating duplicates)',
  },
] as const;
