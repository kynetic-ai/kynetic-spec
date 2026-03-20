#!/usr/bin/env node

/**
 * Kspec Test Runner
 *
 * Ensures environment readiness before running tests. Use this instead of
 * raw `npm test` or `npx vitest` — it verifies prerequisites and fixes
 * gaps automatically.
 *
 * Usage:
 *   node scripts/test.cjs              # Run all tests
 *   node scripts/test.cjs --shard=1/3  # Run shard 1
 *   node scripts/test.cjs my-test      # Filter by name
 *   node scripts/test.cjs --dry-run    # Check environment only
 *
 * Environment variables:
 *   SKIP_BUILD=1   Skip build step (trust existing dist/)
 *   CI=true        Detected automatically in CI
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { checkProjectDependencies } = require('./dependency-health.cjs');

// ANSI colors (zero dependencies)
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const projectRoot = path.dirname(__dirname);
const BUILD_ARTIFACTS = [
  'dist/cli/index.js',
  'dist/web-ui/index.html',
  'dist/daemon/index.ts',
];
const BUILD_INPUT_PATHS = [
  'src',
  'packages/shared/src',
  'packages/daemon/src',
  'packages/web-ui/src',
  'packages/web-ui/static',
  'package.json',
  'tsconfig.json',
  'packages/shared/package.json',
  'packages/daemon/package.json',
  'packages/web-ui/package.json',
  'packages/web-ui/vite.config.ts',
  'packages/web-ui/svelte.config.js',
];

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
  logSetup('Installing dependencies (npm ci)...');
  try {
    execSync('npm ci', { cwd: projectRoot, stdio: 'pipe' });
  } catch (err) {
    logErr('npm ci failed:');
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

function runBuild() {
  logSetup('Building project (npm run build)...');
  try {
    execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
  } catch (err) {
    logErr('npm run build failed:');
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
    name: 'dependencies',
    check: checkDependencies,
    fix: installDependencies,
  },
  {
    name: 'build',
    check: checkBuild,
    fix: runBuild,
    skip: () => process.env.SKIP_BUILD === '1',
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

function main() {
  // Parse our own flags vs vitest pass-through args
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const vitestArgs = args.filter(a => a !== '--dry-run');

  // ── Ensure environment ──
  const fixedCount = ensureEnvironment();

  if (fixedCount > 0) {
    logOk(`Environment ready (${fixedCount} issue${fixedCount > 1 ? 's' : ''} fixed)`);
  }

  if (dryRun) {
    logOk('Environment check passed (dry-run, skipping tests)');
    process.exit(0);
  }

  // ── Run vitest ──
  // Use npx vitest run to bypass npm pretest hook (we already ensured build)
  const cmd = ['npx', 'vitest', 'run', ...vitestArgs];

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Signal to vitest global-setup that build is already done
      SKIP_BUILD: '1',
    },
  });

  const exitCode = result.status ?? 1;

  // ── Post-test hooks ──
  runPostTestHooks(exitCode);

  // ── Summary ──
  process.stderr.write('\n');
  if (exitCode === 0) {
    logOk(`${c.bold}Tests passed${c.reset}`);
  } else {
    logErr(`${c.bold}Tests failed${c.reset} (exit code ${exitCode})`);
  }

  process.exit(exitCode);
}

// Allow testing by exporting internals
if (require.main === module) {
  main();
}

module.exports = {
  checkDependencies,
  checkBuild,
  ensureEnvironment,
  preTestHooks,
  postTestHooks,
};
