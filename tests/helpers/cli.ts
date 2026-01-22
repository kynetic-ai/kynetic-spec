/**
 * Shared CLI test utilities
 *
 * Provides centralized helpers for running kspec CLI commands in tests.
 * Uses pre-built dist/cli/index.js for performance (eliminates tsx transpilation overhead).
 */
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Use built CLI for performance - requires `npm run build` before tests
export const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

// Fixtures directory for test data
export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/**
 * Options for running kspec CLI commands
 */
export interface KspecOptions {
  /** Input to pipe to stdin */
  stdin?: string;
  /** Don't throw on non-zero exit code */
  expectFail?: boolean;
  /** Additional environment variables */
  env?: Record<string, string>;
}

/**
 * Result from running a kspec CLI command
 */
export interface KspecResult {
  /** Exit code (0 = success) */
  exitCode: number;
  /** Standard output (trimmed) */
  stdout: string;
  /** Standard error (trimmed) */
  stderr: string;
}

/**
 * Run a kspec CLI command
 *
 * @param args - CLI arguments (e.g., "task list --json")
 * @param cwd - Working directory to run the command in
 * @param options - Optional settings for stdin, error handling, env vars
 * @returns KspecResult with exitCode, stdout, stderr
 * @throws Error if command fails and expectFail is not set
 *
 * @example
 * // Simple command
 * const result = kspec('task list', tempDir);
 *
 * @example
 * // With stdin
 * const result = kspec('item set @ref --status implemented', tempDir, { stdin: 'y' });
 *
 * @example
 * // Expecting failure
 * const result = kspec('task set @ref --priority 99', tempDir, { expectFail: true });
 * expect(result.exitCode).toBe(1);
 */
export function kspec(args: string, cwd: string, options: KspecOptions = {}): KspecResult {
  const { stdin, expectFail = false, env = {} } = options;

  // Use spawnSync with shell to capture both stdout and stderr
  // Always use shell mode to properly handle argument parsing and quoting
  const result = spawnSync('/bin/sh', ['-c', `node ${CLI_PATH} ${args}`], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, KSPEC_AUTHOR: '@test', ...env },
    input: stdin !== undefined ? (stdin.endsWith('\n') ? stdin : stdin + '\n') : undefined,
  });

  const kspecResult: KspecResult = {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };

  // Handle errors
  if (kspecResult.exitCode !== 0) {
    if (expectFail) {
      return kspecResult;
    }

    // For backwards compatibility: return stdout if present even on error
    // (some commands exit non-zero with valid output)
    if (kspecResult.stdout) {
      return kspecResult;
    }

    throw new Error(`Command failed: node ${CLI_PATH} ${args}\n${kspecResult.stderr || result.error?.message}`);
  }

  return kspecResult;
}

/**
 * Run kspec and return just stdout (convenience wrapper)
 *
 * @param args - CLI arguments
 * @param cwd - Working directory
 * @param options - Optional settings
 * @returns stdout trimmed
 */
export function kspecOutput(args: string, cwd: string, options: KspecOptions = {}): string {
  return kspec(args, cwd, options).stdout;
}

/**
 * Run kspec and return parsed JSON output
 *
 * @param args - CLI arguments (--json flag is added automatically)
 * @param cwd - Working directory
 * @param options - Optional settings
 * @returns Parsed JSON response
 */
export function kspecJson<T>(args: string, cwd: string, options: KspecOptions = {}): T {
  const result = kspec(`${args} --json`, cwd, options);
  return JSON.parse(result.stdout);
}

// Legacy aliases for backwards compatibility
export const kspecExpectFail = (args: string, cwd: string): string => {
  const result = kspec(args, cwd, { expectFail: true });
  return result.stderr || result.stdout;
};

export const kspecWithStatus = (args: string, cwd: string): KspecResult => {
  return kspec(args, cwd, { expectFail: true });
};

/**
 * Copy fixtures to a temp directory for isolated testing
 *
 * @returns Path to the temp directory
 */
export async function setupTempFixtures(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-test-'));
  await fs.cp(FIXTURES_DIR, tempDir, { recursive: true });
  return tempDir;
}

/**
 * Clean up a temp directory
 *
 * @param dir - Directory to remove
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Create an empty temp directory (no fixtures)
 *
 * @param prefix - Optional prefix for the temp directory name
 * @returns Path to the temp directory
 */
export async function createTempDir(prefix = 'kspec-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Initialize a git repo in a directory (useful for tests that need git)
 *
 * @param dir - Directory to initialize
 */
export function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });
}

/**
 * Run a git command in a directory
 *
 * @param cmd - Git command (without 'git' prefix)
 * @param cwd - Working directory
 */
export function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: 'pipe' });
}
