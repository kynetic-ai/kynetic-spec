#!/usr/bin/env node

/**
 * Kspec Test Runner
 *
 * Ensures environment readiness before running tests. Use this instead of
 * raw `npm test` or `npx vitest` — it verifies prerequisites and fixes
 * gaps automatically.
 *
 * Usage:
 *   node scripts/test.cjs              # Run all tests (cached if unchanged)
 *   node scripts/test.cjs --shard=1/3  # Run shard 1
 *   node scripts/test.cjs my-test      # Filter by name
 *   node scripts/test.cjs --dry-run    # Check environment only
 *   node scripts/test.cjs --fresh      # Force full re-run, ignore cache
 *   node scripts/test.cjs --verbose    # Stream full vitest output to terminal
 *
 * Environment variables:
 *   SKIP_BUILD=1          Skip build step (trust existing dist/)
 *   CI=true               Detected automatically in CI (implies --verbose)
 *   KSPEC_SESSION_ID=...  Session-scoped cache isolation for dispatch agents
 */

const { execSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkProjectDependencies } = require("./dependency-health.cjs");

// ANSI colors (zero dependencies)
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const projectRoot = path.dirname(__dirname);
const BUILD_ARTIFACTS = [
  "dist/cli/index.js",
  "packages/shared/dist/index.js",
  "dist/web-ui/index.html",
  "packages/web-ui/.svelte-kit/output/server/manifest-full.js",
  "dist/daemon/index.js",
  "dist/daemon/entity-cache.js",
];
const BUILD_INPUT_PATHS = [
  "src",
  "packages/shared/src",
  "packages/daemon/src",
  "packages/web-ui/src",
  "packages/web-ui/static",
  "package.json",
  "tsconfig.json",
  "packages/shared/package.json",
  "packages/daemon/package.json",
  "packages/web-ui/package.json",
  "packages/web-ui/vite.config.ts",
  "packages/web-ui/svelte.config.js",
];

// Paths that affect test outcomes — used for cache key computation
const TEST_INPUT_PATHS = [
  "src/",
  "tests/",
  "packages/shared/src/",
  "packages/daemon/src/",
  "packages/web-ui/src/",
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "tsconfig.json",
  "scripts/test.cjs",
  "scripts/test-progress-reporter.cjs",
  "scripts/dependency-health.cjs",
];

const CACHE_ROOT = path.join(os.tmpdir(), "kspec-test-cache");

// Environment variables that affect test behavior — included in the cache key
// so runs under different env conditions cannot serve each other's results
// (e.g. CI=true skips file-watcher tests). Curated allowlist rather than the
// full environment: hashing everything would invalidate the cache on
// irrelevant churn (PWD, SHLVL, terminal vars).
const ENV_KEY_VARS = ["CI", "TZ", "NODE_ENV", "NODE_OPTIONS"];
// KSPEC_SESSION_ID already scopes the cache directory (getCacheDir);
// KSPEC_TEST_PROGRESS affects only progress rendering, not test outcomes.
const ENV_KEY_EXCLUDED = new Set(["KSPEC_SESSION_ID", "KSPEC_TEST_PROGRESS"]);

// ─── Output helpers ────────────────────────────────────────────────

function logSetup(msg) {
  process.stderr.write(`${c.cyan}[test-runner]${c.reset} ${msg}\n`);
}

function logOk(msg) {
  process.stderr.write(`${c.green}[test-runner]${c.reset} ${msg}\n`);
}

function logWarn(msg) {
  process.stderr.write(`${c.yellow}[test-runner]${c.reset} ${msg}\n`);
}

function logErr(msg) {
  process.stderr.write(`${c.red}[test-runner]${c.reset} ${msg}\n`);
}

// ─── Cache key computation ────────────────────────────────────────

/**
 * Compute the env component of the cache key: behavior-affecting variables
 * (allowlist + KSPEC_* prefix, minus exclusions) as JSON-encoded sorted
 * [name, value] pairs. Absent vars are excluded entirely, so unset and
 * empty-string values produce different components. JSON encoding keeps
 * pair boundaries unambiguous even when values contain separators.
 */
function computeEnvCacheComponent(env) {
  const names = new Set(ENV_KEY_VARS);
  for (const name of Object.keys(env)) {
    if (name.startsWith("KSPEC_") && !ENV_KEY_EXCLUDED.has(name)) {
      names.add(name);
    }
  }
  const pairs = [...names]
    .filter((name) => env[name] !== undefined)
    .toSorted()
    .map((name) => [name, env[name]]);
  return JSON.stringify(pairs);
}

/**
 * Compute a deterministic cache key from repo content state + vitest args
 * + behavior-affecting environment variables.
 * Uses git blob SHAs (content-addressed) so commits/rebases don't invalidate.
 */
function computeCacheKey(vitestArgs) {
  const hash = crypto.createHash("sha256");

  // 1. Blob SHAs of tracked files in test-affecting paths
  const pathArgs = TEST_INPUT_PATHS.join(" ");
  try {
    const lsFiles = execSync(`git ls-files -s -- ${pathArgs}`, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    hash.update(lsFiles);
  } catch {
    // Not a git repo or git not available — no caching
    return null;
  }

  // 2. Unstaged changes (working tree differs from index)
  try {
    const diff = execSync(`git diff -- ${pathArgs}`, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    hash.update(diff);
  } catch {
    return null;
  }

  // 3. Untracked files in test-affecting paths
  try {
    const untracked = execSync(`git ls-files --others --exclude-standard -- ${pathArgs}`, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (untracked.trim()) {
      // Hash the actual content of untracked files
      for (const file of untracked.trim().split("\n")) {
        const filePath = path.join(projectRoot, file);
        try {
          hash.update(fs.readFileSync(filePath));
          hash.update(file); // include path so renames invalidate
        } catch {
          // File disappeared between listing and reading
        }
      }
    }
  } catch {
    // Ignore
  }

  // 4. Node version
  hash.update(process.version);

  // 5. Vitest args (different filters = different cache entries)
  hash.update(vitestArgs.join(" "));

  // 6. Behavior-affecting environment variables
  hash.update(computeEnvCacheComponent(process.env));

  return hash.digest("hex").slice(0, 16);
}

/**
 * Get the session-scoped cache directory.
 */
function getCacheDir() {
  const sessionId = process.env.KSPEC_SESSION_ID || "_default";
  return path.join(CACHE_ROOT, sessionId);
}

/**
 * Look up cached results for a given cache key.
 * Returns { json, logFile } or null if not cached.
 */
function getCachedResults(cacheKey) {
  if (!cacheKey) return null;
  const cacheDir = getCacheDir();
  const jsonPath = path.join(cacheDir, `${cacheKey}.json`);
  const logPath = path.join(cacheDir, `${cacheKey}.log`);

  if (!fs.existsSync(jsonPath)) return null;

  try {
    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    return { json, logFile: fs.existsSync(logPath) ? logPath : null };
  } catch {
    return null;
  }
}

/**
 * Store test results in the cache.
 */
function storeCachedResults(cacheKey, jsonPath, logPath) {
  if (!cacheKey) return;
  const cacheDir = getCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    fs.copyFileSync(jsonPath, path.join(cacheDir, `${cacheKey}.json`));
    if (logPath && fs.existsSync(logPath)) {
      fs.copyFileSync(logPath, path.join(cacheDir, `${cacheKey}.log`));
    }
  } catch {
    // Cache storage is best-effort
  }
}

/**
 * Clear session cache directory.
 */
function clearSessionCache() {
  const cacheDir = getCacheDir();
  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

// ─── Condensed output formatting ──────────────────────────────────

/**
 * Format condensed test results from vitest JSON output.
 * On success: summary stats only.
 * On failure: failed tests + error snippets + summary.
 */
function formatCondensedOutput(json, logFile) {
  const lines = [];

  if (!json.success) {
    // Show failed test suites and their failed assertions
    for (const suite of json.testResults || []) {
      if (suite.status !== "failed") continue;

      const suiteName = path.relative(projectRoot, suite.name);
      lines.push(`${c.red}FAIL${c.reset} ${suiteName}`);

      for (const assertion of suite.assertionResults || []) {
        if (assertion.status !== "failed") continue;

        lines.push(`  ${c.red}✕${c.reset} ${assertion.fullName}`);

        // Show first failure message, truncated
        if (assertion.failureMessages && assertion.failureMessages.length > 0) {
          const msg = assertion.failureMessages[0];
          // Take first 3 meaningful lines (skip empty lines)
          const msgLines = msg
            .split("\n")
            .filter((l) => l.trim())
            .slice(0, 3);
          for (const ml of msgLines) {
            lines.push(`    ${c.dim}${ml.trim()}${c.reset}`);
          }
        }
      }
      lines.push("");
    }
  }

  // Summary stats
  lines.push("─".repeat(50));

  const suitesPassed = `${c.green}${json.numPassedTestSuites} passed${c.reset}`;
  const suitesFailed =
    json.numFailedTestSuites > 0 ? `${c.red}${json.numFailedTestSuites} failed${c.reset}, ` : "";
  lines.push(
    ` Test Suites: ${suitesFailed}${suitesPassed}${c.dim} of ${json.numTotalTestSuites}${c.reset}`,
  );

  const testsPassed = `${c.green}${json.numPassedTests} passed${c.reset}`;
  const testsFailed =
    json.numFailedTests > 0 ? `${c.red}${json.numFailedTests} failed${c.reset}, ` : "";
  const testsPending =
    json.numPendingTests > 0 ? `${c.yellow}${json.numPendingTests} skipped${c.reset}, ` : "";
  lines.push(
    `      Tests: ${testsFailed}${testsPending}${testsPassed}${c.dim} of ${json.numTotalTests}${c.reset}`,
  );

  // Duration: compute from test results if available, else from startTime
  let totalMs = 0;
  for (const suite of json.testResults || []) {
    if (suite.endTime && suite.startTime) {
      totalMs += suite.endTime - suite.startTime;
    }
  }
  if (totalMs === 0 && json.startTime) {
    // Fallback: wall time (only accurate for live runs, not cached)
    totalMs = Date.now() - json.startTime;
  }
  const durationStr = totalMs > 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`;
  lines.push(`   Duration: ${durationStr}`);

  if (logFile) {
    lines.push("");
    lines.push(`${c.dim}Full log: ${logFile}${c.reset}`);
  }

  return lines.join("\n");
}

// ─── Environment checks ───────────────────────────────────────────

/**
 * Verify node_modules exists and has key dependencies.
 * @param {string} [root] - Project root to check (defaults to this repo's root)
 * Returns { ok: boolean, reason?: string }
 */
function checkDependencies(root) {
  const rootDir = root || projectRoot;
  return checkProjectDependencies(rootDir);
}

/**
 * Verify build artifacts exist.
 * @param {string} [root] - Project root to check (defaults to this repo's root)
 * Returns { ok: boolean, reason?: string }
 */
function checkBuild(root) {
  const rootDir = root || projectRoot;
  for (const artifact of BUILD_ARTIFACTS) {
    const fullPath = path.join(rootDir, artifact);
    if (!fs.existsSync(fullPath)) {
      return { ok: false, reason: `${artifact} not found` };
    }
  }

  const oldestArtifactMtime = Math.min(
    ...BUILD_ARTIFACTS.map((artifact) => fs.statSync(path.join(rootDir, artifact)).mtimeMs),
  );
  const newestInput = newestBuildInput(rootDir);

  if (newestInput && newestInput.mtimeMs > oldestArtifactMtime) {
    return {
      ok: false,
      reason: `${newestInput.relativePath} is newer than build artifacts`,
    };
  }

  return { ok: true };
}

function newestBuildInput(rootDir) {
  let newest = null;

  for (const relativePath of BUILD_INPUT_PATHS) {
    const fullPath = path.join(rootDir, relativePath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const candidate = newestPathMtime(fullPath, relativePath);
    if (!candidate) {
      continue;
    }

    if (!newest || candidate.mtimeMs > newest.mtimeMs) {
      newest = candidate;
    }
  }

  return newest;
}

function newestPathMtime(fullPath, relativePath) {
  const stat = fs.statSync(fullPath);
  if (!stat.isDirectory()) {
    return { relativePath, mtimeMs: stat.mtimeMs };
  }

  let newest = { relativePath, mtimeMs: stat.mtimeMs };
  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    const childFullPath = path.join(fullPath, entry.name);
    const childRelativePath = path.join(relativePath, entry.name);
    const candidate = newestPathMtime(childFullPath, childRelativePath);
    if (candidate && candidate.mtimeMs > newest.mtimeMs) {
      newest = candidate;
    }
  }

  return newest;
}

// ─── Fix helpers ───────────────────────────────────────────────────

function installDependencies() {
  logSetup("Installing dependencies (npm ci)...");
  try {
    execSync("npm ci", { cwd: projectRoot, stdio: "pipe" });
  } catch (err) {
    logErr("npm ci failed:");
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

function runBuild() {
  logSetup("Building project (npm run build)...");
  try {
    execSync("npm run build", { cwd: projectRoot, stdio: "pipe" });
  } catch (err) {
    logErr("npm run build failed:");
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

// ─── Hook points ───────────────────────────────────────────────────

/**
 * Pre-test hooks. Add future setup steps here.
 * Each hook is { name, check, fix } where:
 *   check() → { ok, reason? }
 *   fix() → void (throws on failure)
 */
const preTestHooks = [
  {
    name: "dependencies",
    check: checkDependencies,
    fix: installDependencies,
  },
  {
    name: "build",
    check: checkBuild,
    fix: runBuild,
    skip: () => process.env.SKIP_BUILD === "1",
  },
];

// Post-test hooks for future extensibility
const postTestHooks = [];

// ─── Main ──────────────────────────────────────────────────────────

function ensureEnvironment() {
  let fixedCount = 0;

  for (const hook of preTestHooks) {
    if (hook.skip && hook.skip()) {
      continue;
    }

    const result = hook.check();
    if (!result.ok) {
      logSetup(`${hook.name}: ${result.reason} — fixing...`);
      hook.fix();
      fixedCount++;

      // Verify fix worked
      const recheck = hook.check();
      if (!recheck.ok) {
        logErr(`${hook.name}: still failing after fix — ${recheck.reason}`);
        process.exit(1);
      }
      logOk(`${hook.name}: fixed`);
    }
  }

  return fixedCount;
}

function runPostTestHooks(exitCode) {
  for (const hook of postTestHooks) {
    try {
      hook.run(exitCode);
    } catch (err) {
      logWarn(`Post-test hook '${hook.name}' failed: ${err.message}`);
    }
  }
}

/**
 * Prefix used by test-progress-reporter.cjs to mark per-file progress lines.
 * The parent strips the prefix before forwarding to the terminal.
 */
const PROGRESS_PREFIX = "KSPEC_PROGRESS:";

/**
 * Run vitest and return exit code.
 * In verbose mode: streams to terminal and log file.
 * In condensed mode: streams to log file only, except progress lines (prefixed
 * with KSPEC_PROGRESS:) which are forwarded to the terminal for liveness.
 */

function runVitest(cmd, { verbose, logOutPath }) {
  return new Promise((resolve) => {
    const vitestEnv = { ...process.env, SKIP_BUILD: "1" };
    const logStream = fs.createWriteStream(logOutPath);

    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: projectRoot,
      stdio: ["inherit", "pipe", "pipe"],
      env: vitestEnv,
    });

    child.stdout.pipe(logStream);

    if (verbose) {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(logStream);
      child.stderr.pipe(process.stderr);
    } else {
      // In non-verbose mode, filter stderr line-by-line:
      // - Lines with KSPEC_PROGRESS: prefix → strip prefix, forward to terminal only
      // - All other lines → write to log file
      let stderrBuf = "";
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
        let nlIdx;
        while ((nlIdx = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nlIdx);
          stderrBuf = stderrBuf.slice(nlIdx + 1);

          if (line.startsWith(PROGRESS_PREFIX)) {
            const display = line.slice(PROGRESS_PREFIX.length);
            process.stderr.write(`${display}\n`);
          } else {
            logStream.write(`${line}\n`);
          }
        }
      });
      child.stderr.on("end", () => {
        if (stderrBuf) {
          if (stderrBuf.startsWith(PROGRESS_PREFIX)) {
            const display = stderrBuf.slice(PROGRESS_PREFIX.length);
            process.stderr.write(`${display}\n`);
          } else {
            logStream.write(`${stderrBuf}\n`);
          }
        }
      });
    }

    child.on("close", (code) => {
      logStream.end(() => resolve(code ?? 1));
    });
  });
}

async function main() {
  // Parse our own flags vs vitest pass-through args
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const fresh = args.includes("--fresh");
  const verbose = args.includes("--verbose") || !!process.env.CI;
  const ownFlags = ["--dry-run", "--fresh", "--verbose"];
  const vitestArgs = args.filter((a) => !ownFlags.includes(a));

  // ── Ensure environment ──
  const fixedCount = ensureEnvironment();

  if (fixedCount > 0) {
    logOk(`Environment ready (${fixedCount} issue${fixedCount > 1 ? "s" : ""} fixed)`);
  }

  if (dryRun) {
    logOk("Environment check passed (dry-run, skipping tests)");
    process.exit(0);
  }

  // ── Clear cache if --fresh ──
  if (fresh) {
    clearSessionCache();
    logSetup("Cache cleared (--fresh)");
  }

  // ── Check cache ──
  const cacheKey = computeCacheKey(vitestArgs);
  if (cacheKey && !fresh) {
    const cached = getCachedResults(cacheKey);
    if (cached) {
      logOk("Using cached results (repo state unchanged)");
      process.stderr.write("\n");

      if (verbose && cached.logFile) {
        // Verbose mode: stream the full cached log to terminal
        process.stdout.write(fs.readFileSync(cached.logFile));
      } else {
        process.stderr.write(formatCondensedOutput(cached.json, cached.logFile) + "\n");
      }

      process.stderr.write("\n");
      if (cached.json.success) {
        logOk(`${c.bold}Tests passed${c.reset} ${c.dim}(cached)${c.reset}`);
      } else {
        logErr(
          `${c.bold}Tests failed${c.reset} ${c.dim}(cached — use --fresh to re-run)${c.reset}`,
        );
      }
      process.exit(cached.json.success ? 0 : 1);
    }
  }

  // ── Prepare output paths ──
  const runId = `${Date.now()}-${process.pid}`;
  const sessionDir = getCacheDir();
  fs.mkdirSync(sessionDir, { recursive: true });
  const jsonOutPath = path.join(sessionDir, `${runId}.result.json`);
  const logOutPath = path.join(sessionDir, `${runId}.log`);

  // ── Run vitest ──
  // JSON reporter writes structured data to file; verbose reporter goes to stdout
  // (only JSON supports --outputFile, so we capture stdout ourselves for the log)
  // In non-verbose mode, add the progress reporter for per-file completion output
  const progressReporter = path.join(__dirname, "test-progress-reporter.cjs");
  const reporterArgs = [
    "--reporter=json",
    `--outputFile.json=${jsonOutPath}`,
    "--reporter=verbose",
    ...(!verbose && process.env.KSPEC_TEST_PROGRESS !== "0"
      ? [`--reporter=${progressReporter}`]
      : []),
  ];

  const cmd = ["npx", "vitest", "run", ...reporterArgs, ...vitestArgs];

  const exitCode = await runVitest(cmd, { verbose, logOutPath });

  // ── Post-test hooks ──
  runPostTestHooks(exitCode);

  // ── Read JSON results and display condensed output ──
  let jsonResults = null;
  if (fs.existsSync(jsonOutPath)) {
    try {
      jsonResults = JSON.parse(fs.readFileSync(jsonOutPath, "utf8"));
    } catch {
      // JSON parse failed — fall back to basic exit code reporting
    }
  }

  // Determine cached log path for display
  const cachedLogPath = cacheKey ? path.join(sessionDir, `${cacheKey}.log`) : logOutPath;

  if (jsonResults) {
    storeCachedResults(cacheKey, jsonOutPath, logOutPath);

    if (!verbose) {
      process.stderr.write("\n");
      const displayLogPath = fs.existsSync(cachedLogPath) ? cachedLogPath : null;
      process.stderr.write(formatCondensedOutput(jsonResults, displayLogPath) + "\n");
    }
  }

  // Clean up temp files (cached copies already stored under cache key names)
  for (const tmpFile of [jsonOutPath, logOutPath]) {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      // Best effort
    }
  }

  // ── Summary ──
  process.stderr.write("\n");
  if (exitCode === 0) {
    logOk(`${c.bold}Tests passed${c.reset}`);
  } else {
    logErr(`${c.bold}Tests failed${c.reset} (exit code ${exitCode})`);
    const displayLog = fs.existsSync(cachedLogPath) ? cachedLogPath : logOutPath;
    if (displayLog && fs.existsSync(displayLog)) {
      logSetup(`Full log: ${displayLog}`);
    }
  }

  process.exit(exitCode);
}

// Allow testing by exporting internals
if (require.main === module) {
  main().catch((err) => {
    logErr(err.message);
    process.exit(1);
  });
}

module.exports = {
  checkDependencies,
  checkBuild,
  ensureEnvironment,
  computeCacheKey,
  computeEnvCacheComponent,
  getCacheDir,
  getCachedResults,
  formatCondensedOutput,
  preTestHooks,
  postTestHooks,
};
