/**
 * Shared CLI test utilities
 *
 * Provides centralized helpers for running kspec CLI commands in tests.
 * Uses pre-built dist/cli/index.js for performance (eliminates tsx transpilation overhead).
 *
 * ## ULID Patterns for Test Fixtures
 *
 * ULIDs use Crockford base32 which EXCLUDES: I, L, O, U
 * Valid characters: 0-9, A-H, J-K, M-N, P-T, V-Z
 *
 * Common test ULID mistakes:
 * - ❌ 01TRAIT10... (contains I)
 * - ❌ 01TASK100... (contains I)
 * - ❌ 01MODULE0... (contains O and U)
 * - ✅ 01TRATT100... (valid - no I, L, O, U)
 * - ✅ 01TASK0000... (valid - T, A, S, K are allowed)
 *
 * Use testUlid() to generate valid test ULIDs with readable prefixes.
 *
 * ## YAML Fixture Creation
 *
 * Don't use JSON.stringify() for YAML - it produces invalid syntax.
 * Options:
 * 1. Use setupTempFixtures() with pre-built fixtures (preferred)
 * 2. Write YAML strings directly with template literals
 * 3. Use the yaml library: import { stringify } from 'yaml'
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
 * Excludes the 'multi-dir' subdirectory (use setupMultiDirFixtures() for that).
 *
 * @returns Path to the temp directory
 */
export async function setupTempFixtures(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-test-'));

  // Copy all fixtures except multi-dir
  const entries = await fs.readdir(FIXTURES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'multi-dir') continue; // Skip multi-dir fixtures
    const source = path.join(FIXTURES_DIR, entry.name);
    const dest = path.join(tempDir, entry.name);
    if (entry.isDirectory()) {
      await fs.cp(source, dest, { recursive: true });
    } else {
      await fs.copyFile(source, dest);
    }
  }

  return tempDir;
}

/**
 * Copy multi-directory daemon fixtures to a temp directory
 *
 * Creates isolated copies of multiple kspec projects for testing
 * multi-directory daemon functionality.
 *
 * @returns Path to the temp directory containing project subdirectories
 *
 * @example
 * const fixturesRoot = await setupMultiDirFixtures();
 * const projectA = path.join(fixturesRoot, 'project-a');
 * const projectB = path.join(fixturesRoot, 'project-b');
 * const projectInvalid = path.join(fixturesRoot, 'project-invalid');
 *
 * // Clean up when done
 * await cleanupTempDir(fixturesRoot);
 */
export async function setupMultiDirFixtures(): Promise<string> {
  const multiDirSource = path.join(FIXTURES_DIR, 'multi-dir');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kspec-multi-'));
  await fs.cp(multiDirSource, tempDir, { recursive: true });
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

/**
 * Crockford base32 alphabet (excludes I, L, O, U)
 * Used for ULID generation
 */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a valid test ULID with an optional readable prefix
 *
 * ULIDs use Crockford base32 which excludes I, L, O, U.
 * This function replaces any invalid characters in the prefix
 * and pads to create a valid 26-character ULID.
 *
 * @param prefix - Optional prefix (invalid chars will be replaced)
 * @returns A valid 26-character ULID
 *
 * @example
 * // Generate deterministic ULID (use sequence for uniqueness)
 * const id = testUlid(); // '01000000000000000000000000'
 *
 * @example
 * // With prefix (great for debugging)
 * testUlid('TASK')    // '01TASK00000000000000000000'
 * testUlid('TASK', 1) // '01TASK00000001000000000001'
 * testUlid('TRAIT')   // '01TRAJT0000000000000000000' (I replaced with J)
 */
export function testUlid(prefix = '', sequence = 0): string {
  // Replace invalid Crockford chars: I->J, L->K, O->0, U->V
  const safePrefix = prefix.toUpperCase()
    .replace(/I/g, 'J')
    .replace(/L/g, 'K')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');

  // Start with timestamp-like prefix (01 = valid ULID start)
  const base = '01' + safePrefix;

  // Pad with zeros, leaving room for sequence and checksum
  const padLength = 24 - base.length; // 26 - 2 for suffix
  const sequenceStr = sequence.toString().padStart(Math.min(padLength, 8), '0');
  const padded = base + sequenceStr.slice(0, padLength);

  // Fill remaining with zeros and add a final valid char
  const filled = padded.padEnd(25, '0');

  // Use a deterministic final char based on sequence for uniqueness
  const finalChar = CROCKFORD_BASE32[sequence % 32];

  return (filled + finalChar).slice(0, 26);
}

/**
 * Generate multiple unique test ULIDs with the same prefix
 *
 * @param prefix - Prefix for all ULIDs
 * @param count - Number of ULIDs to generate
 * @returns Array of unique valid ULIDs
 *
 * @example
 * const [id1, id2, id3] = testUlids('TASK', 3);
 */
export function testUlids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => testUlid(prefix, i));
}
