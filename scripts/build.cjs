#!/usr/bin/env node

/**
 * Lock-guarded build entrypoint.
 *
 * `npm run build` / `npm run build:e2e` route through this script so a build
 * cannot rewrite dist/ while scripts/test.cjs is mid-run (and vice versa).
 * The actual build steps stay in package.json as build:unlocked /
 * build:e2e-unlocked; this wrapper only adds the per-worktree lock.
 *
 * Usage: node scripts/build.cjs [npm-script-name]   (default: build:unlocked)
 *
 * AC: @test-suite-perf-reliability ac-7
 */

const { spawnSync } = require("child_process");
const path = require("path");
const { acquireBuildTestLock, HELD_ENV_VAR } = require("./build-test-lock.cjs");

const projectRoot = path.dirname(__dirname);
const ALLOWED_SCRIPTS = new Set(["build:unlocked", "build:e2e-unlocked"]);

async function main() {
  const script = process.argv[2] || "build:unlocked";
  if (!ALLOWED_SCRIPTS.has(script)) {
    process.stderr.write(
      `[build] Unknown build script "${script}". Allowed: ${[...ALLOWED_SCRIPTS].join(", ")}\n`,
    );
    process.exit(1);
  }

  const lock = await acquireBuildTestLock({
    rootDir: projectRoot,
    label: "build",
    onWait: (msg) => process.stderr.write(`[build] ${msg}\n`),
  });

  let status;
  try {
    const result = spawnSync("npm", ["run", script], {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, [HELD_ENV_VAR]: lock.lockPath },
    });
    status = result.status ?? 1;
  } finally {
    lock.release();
  }
  process.exit(status);
}

main().catch((err) => {
  process.stderr.write(`[build] ${err.message}\n`);
  process.exit(1);
});
