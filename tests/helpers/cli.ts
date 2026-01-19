/**
 * Shared CLI test utilities
 *
 * Provides centralized helpers for running kspec CLI commands in tests.
 * Uses pre-built dist/cli/index.js for performance (eliminates tsx transpilation overhead).
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Use built CLI for performance - requires `npm run build` before tests
export const CLI_PATH = path.join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

// Fixtures directory for test data
export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/**
 * Run a kspec CLI command and return stdout
 *
 * @param args - CLI arguments (e.g., "task list --json")
 * @param cwd - Working directory to run the command in
 * @returns stdout trimmed
 * @throws Error if command fails and doesn't produce stdout
 */
export function kspec(args: string, cwd: string): string {
  const cmd = `node ${CLI_PATH} ${args}`;
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, KSPEC_AUTHOR: '@test' },
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    // Return stdout even on error (some commands exit non-zero with valid output)
    if (execError.stdout) return execError.stdout.trim();
    throw new Error(`Command failed: ${cmd}\n${execError.stderr || execError.message}`);
  }
}

/**
 * Run kspec and return parsed JSON output
 *
 * @param args - CLI arguments (--json flag is added automatically)
 * @param cwd - Working directory
 * @returns Parsed JSON response
 */
export function kspecJson<T>(args: string, cwd: string): T {
  const output = kspec(`${args} --json`, cwd);
  return JSON.parse(output);
}

/**
 * Run kspec expecting it to fail, return the error message
 *
 * @param args - CLI arguments
 * @param cwd - Working directory
 * @returns Error message (stderr or exception message)
 * @throws Error if command succeeds when failure was expected
 */
export function kspecExpectFail(args: string, cwd: string): string {
  const cmd = `node ${CLI_PATH} ${args}`;
  try {
    execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, KSPEC_AUTHOR: '@test' },
    });
    throw new Error('Expected command to fail but it succeeded');
  } catch (error: unknown) {
    const execError = error as { stderr?: string; message?: string };
    if (execError.message === 'Expected command to fail but it succeeded') {
      throw execError;
    }
    return execError.stderr || execError.message || '';
  }
}

/**
 * Run kspec and capture both exit code and output
 *
 * @param args - CLI arguments
 * @param cwd - Working directory
 * @returns Object with exitCode, stdout, and stderr
 */
export function kspecWithStatus(
  args: string,
  cwd: string
): { exitCode: number; stdout: string; stderr: string } {
  const cmd = `node ${CLI_PATH} ${args}`;
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, KSPEC_AUTHOR: '@test' },
    });
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error: unknown) {
    const execError = error as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: execError.status ?? 1,
      stdout: (execError.stdout || '').trim(),
      stderr: (execError.stderr || '').trim(),
    };
  }
}

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
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: 'pipe' });
}
