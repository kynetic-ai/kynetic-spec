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
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import * as os from "node:os";

type RemoveDirFn = typeof fs.rm;
let cleanupRmImpl: RemoveDirFn = (...args) => fs.rm(...args);

// Resolve helper dir under both CJS (vitest default) and ESM (Playwright,
// which loads .ts files as ESM because package.json declares "type": "module").
// Vitest internally transpiles to CJS where __dirname is provided; Playwright
// preserves ESM semantics where __dirname is undefined.
const HELPER_DIR =
  typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// Use built CLI for performance - requires `npm run build` before tests
export const CLI_PATH = path.join(HELPER_DIR, "..", "..", "dist", "cli", "index.js");

// Fixtures directory for test data
export const FIXTURES_DIR = path.join(HELPER_DIR, "..", "fixtures");

/**
 * Env vars that signal "I'm running under a dispatch loop or legacy session."
 * Stripped so subprocess tests don't inherit the parent's dispatch context.
 */
const DISPATCH_ENV_VARS = [
  "KSPEC_RALPH_SESSION",
  "KSPEC_SESSION_ID",
  "KSPEC_DISPATCH_CANONICAL_HEAD",
  "KSPEC_SHADOW_MUTATION_LOCK_FILE",
  "KSPEC_SHADOW_MUTATION_LOCK_TIMEOUT_MS",
];

/**
 * Ambient agent-detection markers left by editors / runtimes.
 * Stripped so CLI subprocess tests don't inherit whichever integration a prior
 * Vitest file ran under.
 */
const AGENT_ENV_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SESSION",
  "CLINE_ACTIVE",
  "CURSOR_TRACE_ID",
  "WINDSURF_SESSION",
  "AIDER_MODEL",
  "AIDER_DARK_MODE",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "GEMINI_CLI",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_MANAGED_BY_NPM",
  "FACTORY_PROJECT_DIR",
  "COPILOT_MODEL",
  "GH_TOKEN",
  "AMP_API_KEY",
  "AMP_TOOLBOX",
];

/**
 * Runner-mode env vars that change subprocess output behavior (auto-verbose,
 * progress reporter suppression, ANSI toggling). Stripped so tests exercising
 * non-CI / dev-mode output paths stay deterministic when the parent Vitest
 * worker runs under CI=true.
 */
const RUNNER_ENV_VARS = ["CI", "KSPEC_TEST_PROGRESS", "FORCE_COLOR", "NO_COLOR"];

/**
 * Build a clean env for a test-spawned subprocess.
 *
 * Starts from `process.env`, strips dispatch/agent/runner-mode vars that would
 * otherwise leak the parent process's context into the subprocess, then layers
 * `overrides` on top. Keys present in `overrides` are preserved regardless of
 * the strip lists (caller opts in explicitly).
 *
 * Any test that spawns a subprocess inheriting the parent's env (kspec CLI,
 * the test runner, a daemon helper, etc.) should route env through this
 * helper instead of spreading `process.env` directly.
 */
export function buildTestSubprocessEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const cleanEnv = { ...process.env };
  for (const key of [...DISPATCH_ENV_VARS, ...AGENT_ENV_VARS, ...RUNNER_ENV_VARS]) {
    if (!(key in overrides)) {
      delete cleanEnv[key];
    }
  }
  return { ...cleanEnv, ...overrides };
}

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
 * Result from one startup/readiness probe.
 */
export interface StartupProbeResult {
  /** Whether startup/readiness condition is satisfied */
  ok: boolean;
  /** Diagnostic detail for timeout errors */
  details: string;
}

/**
 * Options for startup/readiness wait helper.
 */
export interface WaitForStartupOptions {
  /** Maximum wait duration before failing */
  timeoutMs?: number;
  /** Poll interval between probe checks */
  intervalMs?: number;
}

/**
 * Run a kspec CLI command
 *
 * @param args - CLI arguments (e.g., "task list --json")
 * @param cwd - Working directory to run the command in (REQUIRED)
 * @param options - Optional settings for stdin, error handling, env vars
 * @returns KspecResult with exitCode, stdout, stderr
 * @throws Error if command fails and expectFail is not set
 *
 * **cwd is required.** A missing cwd is a test bug, not a default. A silent
 * `cwd ?? process.cwd()` fallback caused the 2026-04-11 shadow worktree
 * destruction incident: an unrelated test ran a subprocess that inherited
 * vitest's cwd and reached the shadow-lifecycle code path with a linked-
 * worktree cwd, silently destroying the main repo's shadow worktree via
 * git's shared worktree admin. The explicit-cwd contract removes that
 * amplifier and makes any future variant fail loudly at its origin.
 *
 * AC: @worktree-support ac-shadow-ops-scoped-to-main
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
  // AC: @worktree-support ac-shadow-ops-scoped-to-main
  // Enforce explicit cwd at runtime. TypeScript-only enforcement is
  // insufficient because vitest does not type-check test files; a caller
  // that omits cwd would otherwise silently inherit the vitest worker's
  // cwd and could reach the shadow-lifecycle code path against the wrong
  // working tree. Failing loudly here removes the silent amplifier.
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error(
      "kspec() requires an explicit cwd (non-empty string). A missing cwd is a test bug, not a default. See tests/helpers/cli.ts for rationale.",
    );
  }
  const { stdin, expectFail = false, env = {} } = options;

  // Build clean env: strip dispatch/session, ambient agent, and runner-mode
  // vars that pollute subprocess tests.
  const cleanEnv = buildTestSubprocessEnv(env);

  // Give each CLI subprocess an isolated home/config root by default so global
  // plugin marketplace, daemon PID/port, and agent home-directory probes are
  // scoped to the test project instead of the parent Vitest process.
  const defaultEnv: Record<string, string> = {
    KSPEC_NO_DAEMON: "1",
  };
  const isolatedHomeRoot = cwd;
  try {
    if (statSync(isolatedHomeRoot).isDirectory()) {
      const isolatedHome = path.join(isolatedHomeRoot, ".test-home");
      mkdirSync(path.join(isolatedHome, ".config", "kspec"), { recursive: true });
      defaultEnv.HOME = isolatedHome;
      defaultEnv.USERPROFILE = isolatedHome;
      defaultEnv.KSPEC_CLAUDE_HOME = path.join(isolatedHome, ".claude");
    }
  } catch {
    // Preserve caller-provided invalid cwd so runtime-error-path tests still
    // exercise the CLI instead of failing inside the helper bootstrap.
  }

  // Use spawnSync with shell to capture both stdout and stderr
  // Always use shell mode to properly handle argument parsing and quoting
  const result = spawnSync("/bin/sh", ["-c", `node ${CLI_PATH} ${args}`], {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...cleanEnv, ...defaultEnv, KSPEC_AUTHOR: "@test", ...env },
    input: stdin !== undefined ? (stdin.endsWith("\n") ? stdin : `${stdin}\n`) : undefined,
  });

  // Detect timeout (spawnSync kills the process and sets signal)
  if (result.signal === "SIGTERM" && result.error?.message?.includes("ETIMEDOUT")) {
    throw new Error(`Command timed out after 30s: node ${CLI_PATH} ${args}`);
  }

  const kspecResult: KspecResult = {
    exitCode: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
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

    throw new Error(
      `Command failed: node ${CLI_PATH} ${args}\n${kspecResult.stderr || result.error?.message}`,
    );
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

/**
 * Bounded polling helper for startup/readiness checks in daemon/process tests.
 *
 * Throws with the most recent probe details to make timeout failures actionable.
 *
 * Each probe call is itself raced against the remaining wait budget so a
 * probe that hangs (e.g. an unbounded `fetch` against a daemon that bound the
 * port but stopped responding) cannot stall the whole helper past its
 * configured timeout. Without this race, an unbounded probe would block
 * inside `await probe()` forever and the loop's `Date.now() - startedAt`
 * check would never re-evaluate — the only break would be the outer test
 * timeout, which is exactly the daemon-build hang class this guards against.
 */
export async function waitForStartup(
  description: string,
  probe: () => StartupProbeResult | Promise<StartupProbeResult>,
  options: WaitForStartupOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 100;
  const startedAt = Date.now();
  let lastDetails = "no observation collected";

  while (true) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;

    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    const probeBudgetExceeded = new Promise<StartupProbeResult>((resolveBudget) => {
      probeTimer = setTimeout(() => {
        resolveBudget({
          ok: false,
          details: `probe did not settle within ${remaining}ms remaining`,
        });
      }, remaining);
    });

    let probePromise: Promise<StartupProbeResult>;
    try {
      probePromise = Promise.resolve(probe());
    } catch (syncError) {
      clearTimeout(probeTimer);
      throw syncError;
    }
    // If the probe itself rejects (e.g. throws asynchronously), surface that
    // error to the caller rather than treating it as a non-ok observation.
    const result = await Promise.race([probePromise, probeBudgetExceeded]);
    clearTimeout(probeTimer);
    lastDetails = result.details;

    if (result.ok) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) break;

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out waiting for ${description} after ${timeoutMs}ms. Last observation: ${lastDetails}`,
  );
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-test-"));

  // Copy all fixtures except multi-dir
  const entries = await fs.readdir(FIXTURES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "multi-dir") continue; // Skip multi-dir fixtures
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
  const multiDirSource = path.join(FIXTURES_DIR, "multi-dir");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-multi-"));
  await fs.cp(multiDirSource, tempDir, { recursive: true });
  return tempDir;
}

/**
 * Downgrade a `kspec init`-generated manifest so the monolithic plan/review
 * storage manager remains functional for the duration of a test.
 *
 * `kspec init` writes `kynetic: "1.2"` with `plan_storage.format: folder`,
 * `review_storage.format: folder`, and `resource_storage.format: entity_scoped`
 * — declarations that block the monolithic plan/review managers via the
 * `entity_storage_incompatible` gate. The folder-backed storage managers that
 * make those declarations functional are implemented by sibling tasks under
 * the same plan; until they land, integration tests that exercise
 * plan/review CRUD must run against a legacy-format manifest.
 *
 * This helper rewrites the manifest in place to kynetic 1.1 and strips the
 * folder/entity_scoped storage declarations, leaving the rest of the project
 * setup (default module, includes, shadow worktree, etc.) untouched.
 */
export async function downgradeManifestToLegacyStorage(projectDir: string): Promise<void> {
  const specDir = path.join(projectDir, ".kspec");
  const manifestPath = await findManifestFileInDir(specDir);
  if (!manifestPath) {
    throw new Error(`downgradeManifestToLegacyStorage: no kspec manifest found under ${specDir}`);
  }
  const raw = await fs.readFile(manifestPath, "utf-8");
  const data = yamlParse(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") {
    throw new Error(
      `downgradeManifestToLegacyStorage: manifest at ${manifestPath} did not parse as an object`,
    );
  }
  data.kynetic = "1.1";
  delete data.plan_storage;
  delete data.review_storage;
  delete data.resource_storage;
  await fs.writeFile(manifestPath, yamlStringify(data), "utf-8");
}

/**
 * Locate the kspec manifest file inside a project's spec directory. Mirrors
 * the priority + kynetic-field discovery used by the production parser
 * (src/parser/yaml.ts) so the test helper finds either `kynetic.yaml`,
 * `kynetic.spec.yaml`, or any `<slug>.yaml` that carries a `kynetic` field.
 */
export async function findManifestFileInDir(specDir: string): Promise<string | null> {
  for (const candidate of ["kynetic.yaml", "kynetic.spec.yaml"]) {
    const filePath = path.join(specDir, candidate);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Not present, try next.
    }
  }
  let entries: string[];
  try {
    entries = await fs.readdir(specDir);
  } catch {
    return null;
  }
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(".yaml")) continue;
    if (entry.endsWith(".tasks.yaml")) continue;
    if (entry.endsWith(".inbox.yaml")) continue;
    if (entry.endsWith(".plans.yaml")) continue;
    if (entry.endsWith(".reviews.yaml")) continue;
    if (entry.endsWith(".triage.yaml")) continue;
    const filePath = path.join(specDir, entry);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = yamlParse(raw);
      if (parsed && typeof parsed === "object" && "kynetic" in parsed) {
        return filePath;
      }
    } catch {
      // Skip unreadable / non-YAML candidates.
    }
  }
  return null;
}

/**
 * Clean up a temp directory
 *
 * @param dir - Directory to remove
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  const transientCleanupErrors = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
  const maxRetries = 3;

  for (let attempt = 0; ; attempt++) {
    try {
      await cleanupRmImpl(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !transientCleanupErrors.has(code) || attempt >= maxRetries) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

export function _setCleanupRmForTesting(fn: RemoveDirFn): void {
  cleanupRmImpl = fn;
}

export function _resetCleanupRmForTesting(): void {
  cleanupRmImpl = (...args) => fs.rm(...args);
}

/**
 * Create an empty temp directory (no fixtures)
 *
 * @param prefix - Optional prefix for the temp directory name
 * @returns Path to the temp directory
 */
export async function createTempDir(prefix = "kspec-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Isolated HOME/config paths for daemon-sensitive CLI tests.
 */
export interface IsolatedKspecHome {
  /** Home directory used for HOME/USERPROFILE overrides */
  homeDir: string;
  /** kspec config directory under the isolated home */
  configDir: string;
  /** Global daemon PID file path under isolated HOME */
  daemonPidFilePath: string;
  /** Global daemon port file path under isolated HOME */
  daemonPortFilePath: string;
  /** Environment overrides for running commands in isolated HOME */
  env: Record<string, string>;
}

/**
 * Create isolated HOME/config paths for daemon-sensitive CLI tests.
 *
 * This avoids ambient ~/.config/kspec PID/port state leaking into tests.
 *
 * @param rootDir - Root directory where isolated home will be created
 * @param homeDirName - Optional isolated home subdirectory name
 */
export async function createIsolatedKspecHome(
  rootDir: string,
  homeDirName = ".home",
): Promise<IsolatedKspecHome> {
  const homeDir = path.join(rootDir, homeDirName);
  const configDir = path.join(homeDir, ".config", "kspec");
  await fs.mkdir(configDir, { recursive: true });

  return {
    homeDir,
    configDir,
    daemonPidFilePath: path.join(configDir, "daemon.pid"),
    daemonPortFilePath: path.join(configDir, "daemon.port"),
    env: {
      HOME: homeDir,
      USERPROFILE: homeDir,
    },
  };
}

/**
 * Initialize a git repo in a directory (useful for tests that need git)
 *
 * @param dir - Directory to initialize
 */
export function initGitRepo(dir: string): void {
  execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });
}

/**
 * Run a git command in a directory
 *
 * @param cmd - Git command (without 'git' prefix)
 * @param cwd - Working directory
 */
export function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: "pipe" });
}

/**
 * Read a file produced by test-generated output.
 *
 * Use this instead of raw fs.readFile / readFileSync in tests.
 * The no-source-scanning lint rule recognizes this function as safe,
 * so reads through it won't trigger lint errors.
 *
 * @param filePath - Path to the file to read (should be test-generated output)
 * @param encoding - File encoding (default: utf-8)
 * @returns File contents as a string
 *
 * @example
 * const content = await readTestOutput(path.join(tempDir, "output.yaml"));
 * expect(content).toContain("expected-value");
 */
export async function readTestOutput(
  filePath: string,
  encoding: BufferEncoding = "utf-8",
): Promise<string> {
  return fs.readFile(filePath, encoding);
}

/**
 * Synchronously read a file produced by test-generated output.
 *
 * Sync variant of readTestOutput for use outside async contexts.
 *
 * @param filePath - Path to the file to read (should be test-generated output)
 * @param encoding - File encoding (default: utf-8)
 * @returns File contents as a string
 */
export function readTestOutputSync(filePath: string, encoding: BufferEncoding = "utf-8"): string {
  return readFileSync(filePath, encoding);
}

/**
 * Crockford base32 alphabet (excludes I, L, O, U)
 * Used for ULID generation
 */
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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
export function testUlid(prefix = "", sequence = 0): string {
  // Replace invalid Crockford chars: I->J, L->K, O->0, U->V
  const safePrefix = prefix
    .toUpperCase()
    .replace(/I/g, "J")
    .replace(/L/g, "K")
    .replace(/O/g, "0")
    .replace(/U/g, "V");

  // Start with timestamp-like prefix (01 = valid ULID start)
  const base = `01${safePrefix}`;

  // Pad with zeros, leaving room for sequence and checksum
  const padLength = 24 - base.length; // 26 - 2 for suffix
  const sequenceStr = sequence.toString().padStart(Math.min(padLength, 8), "0");
  const padded = base + sequenceStr.slice(0, padLength);

  // Fill remaining with zeros and add a final valid char
  const filled = padded.padEnd(25, "0");

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

/**
 * Write a task in split storage format.
 *
 * Creates:
 * - tasks/<ULID>/task.yaml with core data (everything except notes)
 * - tasks/<ULID>/notes.yaml with notes array
 * - Appends a lean index entry to project.tasks.yaml
 *
 * The index entry excludes detail-only fields (description, todos, context,
 * vcs_refs) and instead includes notes_count and todos_count.
 *
 * @param dir - Project root directory (where project.tasks.yaml lives)
 * @param task - Full task record with _ulid. Notes should be in `notes` array.
 *
 * @example
 * seedSplitTask(tempDir, {
 *   _ulid: testUlid("TSK1", 1),
 *   slugs: ["my-task"],
 *   title: "My task",
 *   type: "task",
 *   status: "pending",
 *   priority: 2,
 *   depends_on: [],
 *   notes: [],
 *   todos: [],
 *   created_at: "2026-01-01T00:00:00Z",
 * });
 */
export function seedSplitTask(
  dir: string,
  task: Record<string, unknown> & { _ulid: string; notes?: unknown[] },
): void {
  const { notes = [], ...coreData } = task;
  const taskDir = path.join(dir, "tasks", task._ulid);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(path.join(taskDir, "task.yaml"), yamlStringify(coreData));
  writeFileSync(path.join(taskDir, "notes.yaml"), yamlStringify({ notes }));

  const indexPath = path.join(dir, "project.tasks.yaml");
  let entries: unknown[] = [];
  try {
    // oxlint-disable-next-line no-source-scanning/no-source-file-reads -- reading test fixture data, not source code
    const existing = readFileSync(indexPath, "utf8");
    const parsed = yamlParse(existing);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // File doesn't exist yet, start with empty array
  }

  const { description: _d, todos: _t, context: _c, vcs_refs: _v, ...indexFields } = coreData;
  entries.push({
    ...indexFields,
    notes_count: (notes as unknown[]).length,
    todos_count: Array.isArray(task.todos) ? (task.todos as unknown[]).length : 0,
  });
  writeFileSync(indexPath, yamlStringify(entries));
}

/**
 * Set up a project directory so initContext() detects the .kspec/ shadow worktree.
 *
 * Creates a git repo (via initGitRepo) and a fake .kspec/.git worktree pointer
 * so that isValidWorktree() passes and initContext() resolves specDir to .kspec/
 * instead of falling through to traditional mode.
 *
 * Use this when a test calls initContext() on a project directory that has a
 * .kspec/ subdirectory (e.g., from setupMultiDirFixtures()). Without shadow
 * detection setup, initContext() will silently resolve specDir to the project
 * root, causing loaders to look for data files in the wrong place.
 *
 * @param projectDir - Project root directory that contains a .kspec/ subdirectory
 *
 * @example
 * const fixturesRoot = await setupMultiDirFixtures();
 * const projectA = path.join(fixturesRoot, 'project-a');
 * await setupShadowDetection(projectA);
 * // Now initContext(projectA) will correctly resolve specDir to projectA/.kspec/
 */
export async function setupShadowDetection(projectDir: string): Promise<void> {
  // Initialize git repo
  initGitRepo(projectDir);

  // Create a worktree entry so isValidWorktree() passes
  const worktreeDir = path.join(projectDir, ".git", "worktrees", "-kspec");
  await fs.mkdir(worktreeDir, { recursive: true });
  await fs.writeFile(path.join(worktreeDir, "HEAD"), "0".repeat(40) + "\n", "utf-8");
  await fs.writeFile(
    path.join(worktreeDir, "gitdir"),
    path.join(projectDir, ".kspec", ".git") + "\n",
    "utf-8",
  );

  // Point .kspec/.git to the worktree entry
  await fs.writeFile(path.join(projectDir, ".kspec", ".git"), `gitdir: ${worktreeDir}\n`, "utf-8");
}
