#!/usr/bin/env node

/**
 * Kspec Bootstrap Script
 *
 * Zero-dependency script that ensures kspec is installed, built, and initialized.
 * Run this at the start of any agent session to guarantee kspec is ready.
 *
 * Usage: node scripts/bootstrap.cjs
 *
 * This script:
 * 1. Detects if kspec is already working
 * 2. Runs only the setup steps needed
 * 3. Reports what it did (transparency for agents)
 * 4. Outputs session context at the end
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { checkProjectDependencies } = require('./dependency-health.cjs');

// Colors for terminal output (ANSI escape codes - no dependencies)
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

function log(msg) {
  console.log(msg);
}

function logStep(msg) {
  log(`${colors.cyan}→${colors.reset} ${msg}`);
}

function logSuccess(msg) {
  log(`${colors.green}✓${colors.reset} ${msg}`);
}

function logSkip(msg) {
  log(`${colors.dim}○ ${msg} (skipped)${colors.reset}`);
}

function logError(msg) {
  log(`${colors.red}✗${colors.reset} ${msg}`);
}

function logHeader(msg) {
  log(`\n${colors.bold}${colors.blue}=== ${msg} ===${colors.reset}\n`);
}

// Get project root (where this script lives is scripts/, go up one level)
const projectRoot = path.dirname(__dirname);

// Track what we did for the summary
const actions = [];

/**
 * Run a command and return { success, output, error }
 */
function run(cmd, options = {}) {
  const { silent = false, cwd = projectRoot } = options;
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: silent ? 'pipe' : 'inherit',
    });
    return { success: true, output: output || '' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout || '',
      error: err.stderr || err.message
    };
  }
}

/**
 * Check if a command exists and works (cross-platform)
 */
function commandExists(cmd) {
  try {
    // Try running the command with --version flag
    // This works cross-platform without relying on 'which' (Unix) or 'where' (Windows)
    execSync(`${cmd} --version`, { encoding: 'utf8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Internal helper for testable CLI link detection.
 */
function checkKspecCliWithDeps({
  commandExistsFn,
  runFn,
  fsApi,
  pathApi,
  platform,
  projectRootPath,
}) {
  if (!commandExistsFn('kspec')) {
    return { available: false, linked: false, reason: 'kspec command not found' };
  }

  const result = runFn('kspec --version', { silent: true });
  if (!result.success) {
    return { available: false, linked: false, reason: 'kspec command exists but failed to run' };
  }

  // Check if kspec resolves to the local project (npm link)
  // If dist/ doesn't exist yet, we definitely need to build and link
  const distCli = pathApi.join(projectRootPath, 'dist', 'cli', 'index.js');
  if (!fsApi.existsSync(distCli)) {
    return { available: true, linked: false, version: result.output.trim(), reason: 'local dist not built yet' };
  }

  // Check if the globally installed kspec points to our local project.
  // On Unix: npm link creates symlinks, so realpathSync follows them.
  // On Windows: npm link creates .cmd shims containing the JS path as text.
  const prefixResult = runFn('npm prefix -g', { silent: true });
  if (prefixResult.success) {
    const globalPrefix = prefixResult.output.trim();
    const resolvedDist = fsApi.realpathSync(distCli);

    if (platform === 'win32') {
      // Windows: npm creates a .cmd shim that contains the path to the JS entry
      const cmdShim = pathApi.join(globalPrefix, 'kspec.cmd');
      try {
        if (fsApi.existsSync(cmdShim)) {
          const shimContent = fsApi.readFileSync(cmdShim, 'utf8');
          // .cmd shims contain the target JS path — check if it references our project
          if (shimContent.includes(projectRootPath.replace(/\//g, '\\'))) {
            return { available: true, linked: true, version: result.output.trim() };
          }
        }
      } catch {
        // Shim read failed — fall through to not linked
      }
    } else {
      // Unix: follow the symlink chain
      const globalBin = pathApi.join(globalPrefix, 'bin', 'kspec');
      try {
        if (fsApi.existsSync(globalBin)) {
          const resolvedBin = fsApi.realpathSync(globalBin);
          if (resolvedBin === resolvedDist) {
            return { available: true, linked: true, version: result.output.trim() };
          }
        }
      } catch {
        // Symlink resolution failed — fall through to not linked
      }
    }
  }

  return { available: true, linked: false, version: result.output.trim(), reason: 'kspec is not npm-linked to local project' };
}

/**
 * Check if kspec CLI is available, working, and linked to the local build.
 * A globally installed kspec (e.g. from npm install -g) is not sufficient
 * for this project — we need the locally built version via npm link.
 */
function checkKspecCli() {
  return checkKspecCliWithDeps({
    commandExistsFn: commandExists,
    runFn: run,
    fsApi: fs,
    pathApi: path,
    platform: process.platform,
    projectRootPath: projectRoot,
  });
}

/**
 * Minimal shadow config understood by bootstrap before the main parser is ready.
 */
const DEFAULT_SHADOW_BOOTSTRAP_CONFIG = {
  branch: 'kspec-meta',
  directory: '.kspec',
  remote: null,
  remoteType: null,
};

function detectShadowRemoteType(remote) {
  if (
    remote.startsWith('/') ||
    remote.startsWith('./') ||
    remote.startsWith('../') ||
    remote.startsWith('~')
  ) {
    return 'path';
  }

  if (remote.includes('://') || remote.startsWith('git@')) {
    return 'url';
  }

  return 'named';
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadShadowBootstrapConfigWithDeps({ fsApi, pathApi, projectRootPath }) {
  const configPath = pathApi.join(projectRootPath, 'kspec.config.yaml');
  if (!fsApi.existsSync(configPath)) {
    return { ...DEFAULT_SHADOW_BOOTSTRAP_CONFIG };
  }

  try {
    const content = fsApi.readFileSync(configPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const shadowConfig = { ...DEFAULT_SHADOW_BOOTSTRAP_CONFIG };
    let inShadowBlock = false;
    let shadowIndent = 0;

    for (const line of lines) {
      if (!line.trim() || line.trimStart().startsWith('#')) {
        continue;
      }

      const match = line.match(/^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (!match) {
        continue;
      }

      const [, indentText, key, rawValue] = match;
      const indent = indentText.length;

      if (!inShadowBlock) {
        if (key === 'shadow' && rawValue.trim() === '') {
          inShadowBlock = true;
          shadowIndent = indent;
        }
        continue;
      }

      if (indent <= shadowIndent) {
        inShadowBlock = false;
        continue;
      }

      if (key === 'branch' || key === 'directory' || key === 'remote') {
        shadowConfig[key] = parseScalar(rawValue);
      }
    }

    if (shadowConfig.remote) {
      shadowConfig.remoteType = detectShadowRemoteType(shadowConfig.remote);
    }

    return shadowConfig;
  } catch {
    return { ...DEFAULT_SHADOW_BOOTSTRAP_CONFIG };
  }
}

function loadShadowBootstrapConfig() {
  return loadShadowBootstrapConfigWithDeps({
    fsApi: fs,
    pathApi: path,
    projectRootPath: projectRoot,
  });
}

function expandBootstrapPathRemote(remote) {
  if (!remote.startsWith('~')) {
    return remote;
  }

  return remote.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '~');
}

function resolveBootstrapRemoteTarget(shadowConfig) {
  if (!shadowConfig.remote) {
    return 'origin';
  }

  if (shadowConfig.remoteType === 'path') {
    return expandBootstrapPathRemote(shadowConfig.remote);
  }

  return shadowConfig.remote;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Check if the configured shadow directory exists and is healthy.
 */
function checkKspecDirWithDeps({ fsApi, pathApi, projectRootPath, shadowConfig }) {
  const kspecDir = pathApi.join(projectRootPath, shadowConfig.directory);

  if (!fsApi.existsSync(kspecDir)) {
    return { exists: false, healthy: false, reason: `${shadowConfig.directory}/ directory not found` };
  }

  // Check if it's a git worktree (has .git file, not directory)
  const gitPath = pathApi.join(kspecDir, '.git');
  if (!fsApi.existsSync(gitPath)) {
    return { exists: true, healthy: false, reason: `${shadowConfig.directory}/.git not found` };
  }

  const stat = fsApi.statSync(gitPath);
  if (stat.isDirectory()) {
    return { exists: true, healthy: false, reason: `${shadowConfig.directory}/.git is a directory, not a worktree link` };
  }

  // Read the gitdir reference
  const gitContent = fsApi.readFileSync(gitPath, 'utf8').trim();
  if (!gitContent.startsWith('gitdir:')) {
    return { exists: true, healthy: false, reason: `${shadowConfig.directory}/.git does not contain gitdir reference` };
  }

  return { exists: true, healthy: true };
}

function checkKspecDir(shadowConfig = DEFAULT_SHADOW_BOOTSTRAP_CONFIG) {
  return checkKspecDirWithDeps({
    fsApi: fs,
    pathApi: path,
    projectRootPath: projectRoot,
    shadowConfig,
  });
}

function checkShadowBranchExists(runFn, shadowConfig) {
  const result = runFn(`git branch --list ${shellQuote(shadowConfig.branch)}`, { silent: true });
  return result.success && Boolean(result.output.trim());
}

function checkRemoteShadowBranchExists(runFn, shadowConfig) {
  const remoteTarget = resolveBootstrapRemoteTarget(shadowConfig);

  if (shadowConfig.remote && shadowConfig.remoteType === 'named') {
    const remoteResult = runFn(
      `git remote get-url ${shellQuote(remoteTarget)}`,
      { silent: true },
    );
    if (!remoteResult.success) {
      return false;
    }
  } else if (!shadowConfig.remote) {
    const remoteResult = runFn(
      `git remote get-url ${shellQuote(remoteTarget)}`,
      { silent: true },
    );
    if (!remoteResult.success) {
      return false;
    }
  }

  const result = runFn(
    `git ls-remote --heads ${shellQuote(remoteTarget)} ${shellQuote(shadowConfig.branch)}`,
    { silent: true },
  );
  return result.success && Boolean(result.output.trim());
}

function resolveShadowBootstrapActionWithDeps({
  dirStatus,
  shadowConfig,
  runFn,
  kspecCmd,
}) {
  if (dirStatus.healthy) {
    return {
      kind: 'none',
      command: '',
      startMessage: '',
      successMessage: '',
      actionSummary: '',
    };
  }

  if (
    checkShadowBranchExists(runFn, shadowConfig) ||
    checkRemoteShadowBranchExists(runFn, shadowConfig)
  ) {
    return {
      kind: 'repair',
      command: `${kspecCmd} shadow repair`,
      startMessage: 'Repairing kspec shadow worktree (kspec shadow repair)...',
      successMessage: 'Kspec shadow repaired',
      actionSummary: 'Repaired shadow branch worktree (kspec shadow repair)',
    };
  }

  return {
    kind: 'init',
    command: `${kspecCmd} init --no-prompt`,
    startMessage: 'Initializing kspec (kspec init --no-prompt)...',
    successMessage: 'Kspec initialized',
    actionSummary: 'Initialized shadow branch (kspec init)',
  };
}

function checkNodeModulesWithDeps({
  projectRootPath,
  fsApi,
  pathApi,
}) {
  const result = checkProjectDependencies(projectRootPath, {
    fsApi,
    pathApi,
  });
  return result.ok
    ? { installed: true }
    : { installed: false, reason: result.reason || 'node_modules exists but missing dependencies' };
}

/**
 * Check if node_modules exists and has direct dependencies from package.json
 */
function checkNodeModules() {
  return checkNodeModulesWithDeps({
    projectRootPath: projectRoot,
    fsApi: fs,
    pathApi: path,
  });
}

/**
 * Check if dist/ exists and has the CLI
 */
function checkBuild() {
  // Always rebuild — it's fast and prevents stale dist/ issues
  return { built: false, reason: 'always rebuild to ensure dist/ matches source' };
}

/**
 * Main bootstrap logic
 */
async function bootstrap() {
  logHeader('Kspec Bootstrap');

  let status = 'already_configured';

  // Step 1: Check current state
  logStep('Checking current state...');

  const shadowConfig = loadShadowBootstrapConfig();
  const cliStatus = checkKspecCli();
  const dirStatus = checkKspecDir(shadowConfig);
  const modulesStatus = checkNodeModules();
  const buildStatus = checkBuild();

  // Determine what needs to be done
  const needsInstall = !modulesStatus.installed;
  const needsBuild = !buildStatus.built;
  const needsLink = !cliStatus.linked;
  const needsInit = !dirStatus.exists || !dirStatus.healthy;

  if (!needsInstall && !needsBuild && !needsLink && !needsInit) {
    logSuccess('Kspec is fully configured');
    log('');
  } else {
    status = needsInit && !dirStatus.exists ? 'fresh_setup' : 'repaired';

    // Step 2: npm ci (if needed) — use ci to avoid modifying package-lock.json
    if (needsInstall) {
      logStep('Installing dependencies (npm ci)...');
      const result = run('npm ci');
      if (!result.success) {
        logError('npm ci failed');
        process.exit(1);
      }
      logSuccess('Dependencies installed');
      actions.push('Installed dependencies (npm ci)');
    } else {
      logSkip('Dependencies already installed');
    }

    // Step 3: npm run build (if needed)
    if (needsBuild) {
      logStep('Building project (npm run build)...');
      const result = run('npm run build');
      if (!result.success) {
        logError('npm run build failed');
        process.exit(1);
      }
      logSuccess('Project built');
      actions.push('Built project (npm run build)');
    } else {
      logSkip('Project already built');
    }

    // Step 4: npm link (if needed)
    if (needsLink) {
      logStep('Linking CLI (npm link)...');
      const result = run('npm link');
      if (!result.success) {
        logError('npm link failed');
        process.exit(1);
      }
      logSuccess('CLI linked');
      actions.push('Linked CLI globally (npm link)');
    } else {
      logSkip('CLI already linked');
    }

    // Step 5: initialize or repair kspec shadow state (if needed)
    if (needsInit) {
      // Use the local dist if npm link might not have worked yet
      const kspecCmd = commandExists('kspec') ? 'kspec' : 'node dist/cli/index.js';
      const shadowAction = resolveShadowBootstrapActionWithDeps({
        dirStatus,
        shadowConfig,
        runFn: run,
        kspecCmd,
      });
      logStep(shadowAction.startMessage);
      const result = run(shadowAction.command);
      if (!result.success) {
        logError(`${shadowAction.kind === 'repair' ? 'kspec shadow repair' : 'kspec init'} failed`);
        process.exit(1);
      }
      logSuccess(shadowAction.successMessage);
      actions.push(shadowAction.actionSummary);
    } else {
      logSkip('Kspec already initialized');
    }
  }

  // Summary of actions
  if (actions.length > 0) {
    logHeader('Actions Taken');
    log(`Status: ${colors.yellow}${status}${colors.reset}\n`);
    for (const action of actions) {
      log(`  ${colors.green}•${colors.reset} ${action}`);
    }
    log('');
  }

  // Step 6: Always run session start
  logHeader('Session Context');

  const kspecCmd = commandExists('kspec') ? 'kspec' : 'node dist/cli/index.js';
  run(`${kspecCmd} session start`);
}

if (require.main === module) {
  // Run bootstrap
  bootstrap().catch(err => {
    logError(`Bootstrap failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  checkKspecCli,
  checkKspecCliWithDeps,
  checkNodeModulesWithDeps,
  loadShadowBootstrapConfig,
  loadShadowBootstrapConfigWithDeps,
  resolveShadowBootstrapActionWithDeps,
};
