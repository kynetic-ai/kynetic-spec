#!/usr/bin/env node

/**
 * Verify the npm package ships with the complete built artifacts.
 * Spec: @published-artifact-completeness (ac-2, ac-3)
 *
 * Two layers of verification, run from the package root (cwd):
 * 1. Built artifacts exist on disk (catches a missing/partial build).
 * 2. `npm pack --dry-run --json --ignore-scripts` includes every required
 *    file (catches files/.npmignore configuration dropping built output).
 *
 * `--ignore-scripts` keeps the dry run from re-running the prepack build:
 * this script verifies the output of an explicit build (CI runs it right
 * after `npm run build`), and npm's dry-run lifecycle behavior varies
 * across versions, so the listing must not depend on prepack running.
 *
 * Exits non-zero with a list of problems if anything required is missing.
 * Dependency-free: node builtins only.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Files that must appear in the packed tarball (paths as npm reports them). */
const REQUIRED_FILES = [
  "LICENSE",
  "dist/cli/index.js",
  "dist/index.js",
  "dist/web-ui/index.html",
  "templates/skills/manifest.yaml",
];

/** At least one packed path must start with one of these prefixes. */
const REQUIRED_PREFIXES = ["plugin/"];

/**
 * Check a list of packed file paths against the required artifacts.
 * Returns an array of human-readable problem strings (empty = complete).
 */
function findMissingArtifacts(packedPaths) {
  const problems = [];
  for (const required of REQUIRED_FILES) {
    if (!packedPaths.includes(required)) {
      problems.push(`missing from package: ${required}`);
    }
  }
  for (const prefix of REQUIRED_PREFIXES) {
    if (!packedPaths.some((p) => p.startsWith(prefix))) {
      problems.push(`missing from package: at least one ${prefix} entry`);
    }
  }
  return problems;
}

/** Return whether a parsed value has npm's package-record shape. */
function isPackResult(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        !Array.isArray(file) &&
        typeof file.path === "string",
    )
  );
}

/** Normalize npm <=11's array and npm 12's package-name-keyed object. */
function normalizePackPayload(value) {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isPackResult) ? value : null;
  }
  if (value !== null && typeof value === "object") {
    const records = Object.values(value);
    return records.length > 0 && records.every(isPackResult) ? records : null;
  }
  return null;
}

/**
 * Extract balanced top-level object/array candidates without treating brackets
 * inside JSON strings as structure. Text outside a candidate is ignored so npm
 * notice lines before or after the payload remain harmless.
 */
function extractJsonCandidates(stdout) {
  const candidates = [];
  const malformed = [];

  for (let start = 0; start < stdout.length; start += 1) {
    const opening = stdout[start];
    if (opening !== "[" && opening !== "{") continue;

    const stack = [opening];
    let inString = false;
    let escaped = false;
    let end = start + 1;
    let mismatch = false;

    for (; end < stdout.length; end += 1) {
      const char = stdout[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "[" || char === "{") {
        stack.push(char);
      } else if (char === "]" || char === "}") {
        const expected = char === "]" ? "[" : "{";
        if (stack.pop() !== expected) {
          mismatch = true;
          break;
        }
        if (stack.length === 0) break;
      }
    }

    if (mismatch || stack.length > 0) {
      malformed.push(`unbalanced JSON value beginning at character ${start}`);
      start = end;
      continue;
    }

    const text = stdout.slice(start, end + 1);
    try {
      candidates.push(JSON.parse(text));
    } catch (err) {
      malformed.push(`invalid JSON value beginning at character ${start}: ${err.message}`);
    }
    start = end;
  }

  return { candidates, malformed };
}

/**
 * Parse and normalize the package listing from `npm pack --json` stdout.
 * npm <=11 emits an array; npm 12 emits an object keyed by package name.
 */
function parsePackJson(stdout) {
  const { candidates, malformed } = extractJsonCandidates(stdout);
  const payloads = candidates.map(normalizePackPayload).filter((value) => value !== null);

  if (payloads.length > 1) {
    throw new Error(`ambiguous npm pack output: found ${payloads.length} package JSON payloads`);
  }
  if (payloads.length === 1) {
    if (payloads[0].length !== 1) {
      throw new Error(
        `ambiguous npm pack output: found ${payloads[0].length} package records in one payload`,
      );
    }
    return payloads[0];
  }
  if (candidates.length > 0) {
    throw new Error("npm pack JSON payload contained no package records with valid files entries");
  }
  if (malformed.length > 0) {
    throw new Error(`malformed JSON payload in npm pack output: ${malformed[0]}`);
  }
  throw new Error("npm pack produced no JSON payload");
}

/**
 * Verify the package rooted at `rootDir`. Returns an array of problem
 * strings; empty means the package is complete.
 */
function verifyPackage(rootDir) {
  const problems = [];

  // Layer 1: built artifacts present on disk.
  const requiredOnDisk = REQUIRED_FILES.filter((f) => f.startsWith("dist/"));
  for (const relPath of requiredOnDisk) {
    if (!fs.existsSync(path.join(rootDir, relPath))) {
      problems.push(`missing on disk (build incomplete?): ${relPath}`);
    }
  }

  // Layer 2: packed file listing includes every required artifact.
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: rootDir,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (result.error) {
    problems.push(`npm pack --dry-run failed to spawn: ${result.error.message}`);
    return problems;
  }
  if (result.status !== 0) {
    problems.push(`npm pack --dry-run exited ${result.status}:\n${result.stderr}`);
    return problems;
  }

  let packedPaths;
  try {
    const parsed = parsePackJson(result.stdout);
    packedPaths = parsed[0].files.map((file) => file.path);
  } catch (err) {
    problems.push(`could not parse npm pack --dry-run --json output: ${err.message}`);
    return problems;
  }

  problems.push(...findMissingArtifacts(packedPaths));
  return problems;
}

function main() {
  const rootDir = process.cwd();
  const problems = verifyPackage(rootDir);
  if (problems.length > 0) {
    console.error("Package verification FAILED:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log("Package verification passed: all required artifacts present.");
}

if (require.main === module) {
  main();
}

module.exports = {
  REQUIRED_FILES,
  REQUIRED_PREFIXES,
  findMissingArtifacts,
  normalizePackPayload,
  parsePackJson,
};
