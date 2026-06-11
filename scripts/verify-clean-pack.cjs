#!/usr/bin/env node

// AC: @published-artifact-completeness ac-4

/**
 * Prove that packing from a clean source state produces a complete package.
 * Spec: @published-artifact-completeness (ac-4)
 *
 * Behavioral proof that the prepack lifecycle itself builds everything:
 * 1. Stage a pristine copy of the committed source (`git archive HEAD`)
 *    into a temp directory — no dist/, no plugin/, no other build output.
 * 2. Symlink this repository's installed node_modules into the staged copy
 *    (dependencies are not what's under test; the build pipeline is).
 * 3. Run a REAL `npm pack` there (not --dry-run — npm does not reliably run
 *    lifecycle scripts on dry runs, and the whole point is that prepack must
 *    produce the build output itself).
 * 4. List the resulting tarball with `tar -tzf` and fail unless every
 *    required artifact is present. The tarball listing is used instead of
 *    `npm pack --json` stdout because the full build's progress output
 *    pollutes stdout and makes JSON extraction fragile.
 *
 * Note: verifies the committed tree (HEAD) — commit your changes before
 * relying on the result. Runs a full build; intended for the publish
 * workflow and local pre-release checks, not the regular test suite.
 * Dependency-free: node builtins only.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findMissingArtifacts } = require("./verify-package.cjs");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUILD_TIMEOUT_MS = 20 * 60_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: BUILD_TIMEOUT_MS,
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}:\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result;
}

function main() {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "kspec-clean-pack-"));
  console.log(`Staging clean source copy (git archive HEAD) in ${stageDir}`);

  try {
    // Stage the committed source tree — by construction it contains no
    // dist/, plugin/, or any other gitignored build output.
    const archivePath = path.join(stageDir, "source.tar");
    run("git", ["archive", "--format=tar", "--output", archivePath, "HEAD"], { cwd: REPO_ROOT });
    const sourceDir = path.join(stageDir, "source");
    fs.mkdirSync(sourceDir);
    run("tar", ["-xf", archivePath, "-C", sourceDir]);
    fs.rmSync(archivePath);

    // Reuse this repo's installed dependencies (workspaces hoist to the
    // root node_modules, so one symlink covers the workspace packages too).
    fs.symlinkSync(
      path.join(REPO_ROOT, "node_modules"),
      path.join(sourceDir, "node_modules"),
      "dir",
    );

    // Real pack: the prepack lifecycle script must produce the full build.
    const packDest = path.join(stageDir, "pack-output");
    fs.mkdirSync(packDest);
    console.log("Running npm pack (prepack runs the full build; this takes a few minutes)...");
    run("npm", ["pack", "--pack-destination", packDest], { cwd: sourceDir });

    const tarballs = fs.readdirSync(packDest).filter((f) => f.endsWith(".tgz"));
    if (tarballs.length !== 1) {
      throw new Error(`expected exactly one tarball in ${packDest}, found: ${tarballs.join(", ")}`);
    }
    const tarballPath = path.join(packDest, tarballs[0]);

    // npm tarballs prefix every entry with "package/".
    const listing = run("tar", ["-tzf", tarballPath]);
    const packedPaths = listing.stdout
      .split("\n")
      .filter((line) => line.startsWith("package/"))
      .map((line) => line.slice("package/".length));

    const problems = findMissingArtifacts(packedPaths);
    if (problems.length > 0) {
      console.error("Clean-pack verification FAILED:");
      for (const problem of problems) {
        console.error(`  - ${problem}`);
      }
      process.exit(1);
    }
    console.log(
      `Clean-pack verification passed: packing from a clean source state produced a complete package (${packedPaths.length} files).`,
    );
  } finally {
    // rmSync does not follow symlinks, so the real node_modules is untouched.
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

main();
