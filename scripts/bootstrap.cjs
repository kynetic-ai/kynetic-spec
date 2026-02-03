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
 * Check if a command exists and works
 */
function commandExists(cmd) {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Check if kspec CLI is available and working
 */
function checkKspecCli() {
  if (!commandExists('kspec')) {
    return { available: false, reason: 'kspec command not found' };
  }

  const result = run('kspec --version', { silent: true });
  if (!result.success) {
    return { available: false, reason: 'kspec command exists but failed to run' };
  }

  return { available: true, version: result.output.trim() };
}

/**
 * Check if .kspec/ directory exists and is healthy
 */
function checkKspecDir() {
  const kspecDir = path.join(projectRoot, '.kspec');

  if (!fs.existsSync(kspecDir)) {
    return { exists: false, healthy: false, reason: '.kspec/ directory not found' };
  }

  // Check if it's a git worktree (has .git file, not directory)
  const gitPath = path.join(kspecDir, '.git');
  if (!fs.existsSync(gitPath)) {
    return { exists: true, healthy: false, reason: '.kspec/.git not found' };
  }

  const stat = fs.statSync(gitPath);
  if (stat.isDirectory()) {
    return { exists: true, healthy: false, reason: '.kspec/.git is a directory, not a worktree link' };
  }

  // Read the gitdir reference
  const gitContent = fs.readFileSync(gitPath, 'utf8').trim();
  if (!gitContent.startsWith('gitdir:')) {
    return { exists: true, healthy: false, reason: '.kspec/.git does not contain gitdir reference' };
  }

  return { exists: true, healthy: true };
}

/**
 * Check if node_modules exists and has key dependencies
 */
function checkNodeModules() {
  const nodeModules = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    return { installed: false, reason: 'node_modules/ not found' };
  }

  // Check for a key dependency (zod is required)
  const zodPath = path.join(nodeModules, 'zod');
  if (!fs.existsSync(zodPath)) {
    return { installed: false, reason: 'node_modules exists but missing dependencies' };
  }

  return { installed: true };
}

/**
 * Check if dist/ exists and has the CLI
 */
function checkBuild() {
  const distCli = path.join(projectRoot, 'dist', 'cli', 'index.js');
  if (!fs.existsSync(distCli)) {
    return { built: false, reason: 'dist/cli/index.js not found' };
  }

  return { built: true };
}

/**
 * Main bootstrap logic
 */
async function bootstrap() {
  logHeader('Kspec Bootstrap');

  let status = 'already_configured';

  // Step 1: Check current state
  logStep('Checking current state...');

  const cliStatus = checkKspecCli();
  const dirStatus = checkKspecDir();
  const modulesStatus = checkNodeModules();
  const buildStatus = checkBuild();

  // Determine what needs to be done
  const needsInstall = !modulesStatus.installed;
  const needsBuild = !buildStatus.built;
  const needsLink = !cliStatus.available;
  const needsInit = !dirStatus.exists || !dirStatus.healthy;

  if (!needsInstall && !needsBuild && !needsLink && !needsInit) {
    logSuccess('Kspec is fully configured');
    log('');
  } else {
    status = needsInit && !dirStatus.exists ? 'fresh_setup' : 'repaired';

    // Step 2: npm install (if needed)
    if (needsInstall) {
      logStep('Installing dependencies (npm install)...');
      const result = run('npm install');
      if (!result.success) {
        logError('npm install failed');
        process.exit(1);
      }
      logSuccess('Dependencies installed');
      actions.push('Installed dependencies (npm install)');
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

    // Step 5: kspec init (if needed)
    if (needsInit) {
      logStep('Initializing kspec (kspec init --no-prompt)...');
      // Use the local dist if npm link might not have worked yet
      const kspecCmd = commandExists('kspec') ? 'kspec' : 'node dist/cli/index.js';
      const result = run(`${kspecCmd} init --no-prompt`);
      if (!result.success) {
        logError('kspec init failed');
        process.exit(1);
      }
      logSuccess('Kspec initialized');
      actions.push('Initialized shadow branch (kspec init)');
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

// Run bootstrap
bootstrap().catch(err => {
  logError(`Bootstrap failed: ${err.message}`);
  process.exit(1);
});
