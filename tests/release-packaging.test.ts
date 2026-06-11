/**
 * Tests for release packaging completeness.
 * Spec: @published-artifact-completeness
 *
 * Verifies the packed npm artifact ships with everything a consumer needs.
 * Created by @task-add-license-file (license coverage, ac-1); extended by
 * @task-prepack-full-build-and-verification (built artifact completeness,
 * ac-2/ac-3, via scripts/verify-package.cjs).
 *
 * ac-4 (clean-source pack produces a complete package) is covered
 * behaviorally by scripts/verify-clean-pack.cjs, which performs a real
 * `npm pack` (full build via prepack) and runs in the publish workflow —
 * too slow for the vitest suite.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTestSubprocessEnv, cleanupTempDir, createTempDir } from "./helpers/cli";
import packageJson from "../package.json" with { type: "json" };

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_PACKAGE_SCRIPT = join(REPO_ROOT, "scripts", "verify-package.cjs");

/** Entry in `npm pack --json` output's `files` array. */
interface PackFileEntry {
  path: string;
  size: number;
  mode: number;
}

interface PackResult {
  files: PackFileEntry[];
}

/** Run scripts/verify-package.cjs against the package rooted at `cwd`. */
function runVerifyPackage(cwd: string) {
  return spawnSync("node", [VERIFY_PACKAGE_SCRIPT], {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    env: buildTestSubprocessEnv(),
  });
}

/**
 * Artifacts a staged fixture tree needs to satisfy verify-package.cjs
 * (the plugin/ entry stands in for "at least one plugin/ file").
 */
const FIXTURE_ARTIFACTS = [
  "LICENSE",
  "dist/cli/index.js",
  "dist/index.js",
  "dist/web-ui/index.html",
  "templates/skills/manifest.yaml",
  "plugin/plugins/kspec/skills/help/SKILL.md",
];

/**
 * Stage a minimal packable tree containing every required artifact,
 * optionally omitting some to simulate an incomplete build.
 */
function stagePackageTree(dir: string, omit: string[] = []): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "verify-package-fixture",
      version: "0.0.0",
      license: "MIT",
      files: ["dist", "templates", "plugin"],
    }),
  );
  for (const relPath of FIXTURE_ARTIFACTS) {
    if (omit.includes(relPath)) continue;
    const absPath = join(dir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, `fixture content for ${relPath}\n`);
  }
}

/**
 * Every user-facing installation/onboarding document: README.md, INSTALL.md,
 * and all markdown files under docs/, discovered dynamically so new docs are
 * covered without updating this list.
 */
function listUserFacingDocs(): string[] {
  const docs = [join(REPO_ROOT, "README.md"), join(REPO_ROOT, "INSTALL.md")];
  const docsDir = join(REPO_ROOT, "docs");
  for (const entry of readdirSync(docsDir, { recursive: true, encoding: "utf-8" })) {
    if (entry.endsWith(".md")) docs.push(join(docsDir, entry));
  }
  return docs;
}

function readUserFacingDoc(docPath: string): string {
  // eslint-disable-next-line no-source-scanning/no-source-file-reads -- The docs are the release artifacts under test: ac-2 requires their published Node.js version statements to match the engines minimum, which can only be verified by inspecting the documents themselves.
  return readFileSync(docPath, "utf-8");
}

/**
 * A Node.js version statement in prose, e.g. "Node.js 20+", "**Node.js** v20
 * or later", "Node 20". Captures the stated major version.
 */
const NODE_VERSION_STATEMENT = /node(?:\.js)?\*{0,2}\s+v?(\d+)(?:\.\d+)*/gi;

describe("Supported runtime version range", () => {
  // AC: @supported-runtime-range ac-1
  it("declares exactly one Node.js engine range with an explicit minimum major version", () => {
    expect(Object.keys(packageJson.engines)).toEqual(["node"]);
    // A single ">=<major>.<minor>.<patch>" range — no unions or upper bounds
    // that would make the minimum ambiguous.
    const match = packageJson.engines.node.match(/^>=(\d+)\.\d+\.\d+$/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
  });

  // AC: @supported-runtime-range ac-2
  it("states the engines minimum in every user-facing doc that mentions a Node.js version", () => {
    const minimumMajor = Number(packageJson.engines.node.match(/^>=(\d+)\./)![1]);
    const statements: { doc: string; line: number; text: string; major: number }[] = [];
    for (const docPath of listUserFacingDocs()) {
      const lines = readUserFacingDoc(docPath).split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(NODE_VERSION_STATEMENT)) {
          statements.push({
            doc: relative(REPO_ROOT, docPath),
            line: index + 1,
            text: match[0],
            major: Number(match[1]),
          });
        }
      });
    }

    // The docs do state a requirement — guard against a vacuous pass if the
    // statement pattern stops matching.
    expect(statements.length).toBeGreaterThan(0);

    const mismatches = statements.filter((statement) => statement.major !== minimumMajor);
    expect(
      mismatches,
      `Docs stating a Node.js version different from the engines minimum (${minimumMajor})`,
    ).toEqual([]);
  });
});

describe("Release packaging", () => {
  // AC: @published-artifact-completeness ac-1
  it("includes LICENSE at the package root when packed for publication", () => {
    // --ignore-scripts: prepack runs the full build, which must not be
    // triggered from inside the test suite; LICENSE inclusion is
    // independent of lifecycle scripts.
    const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 120_000,
      env: buildTestSubprocessEnv(),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    // npm may print notice/log lines to stdout before the JSON array,
    // so parse from the array's opening bracket.
    const stdout = result.stdout;
    const jsonStart = stdout.indexOf("[");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(jsonStart)) as PackResult[];

    const paths = parsed[0].files.map((file) => file.path);
    expect(paths).toContain("LICENSE");
  }, 180_000);

  // AC: @published-artifact-completeness ac-1
  it("declares the MIT license identifier in the package manifest", () => {
    expect(packageJson.license).toBe("MIT");
  });

  // AC: @published-artifact-completeness ac-1
  it("ships license terms that match the declared MIT identifier", () => {
    // eslint-disable-next-line no-source-scanning/no-source-file-reads -- The LICENSE text is the release artifact under test: ac-1 requires its terms to match the declared license identifier, which can only be verified by inspecting the artifact itself.
    const licenseText = readFileSync(join(REPO_ROOT, "LICENSE"), "utf-8");
    const headerLines = licenseText.split("\n").slice(0, 3);
    expect(headerLines[0]).toBe("MIT License");
    expect(headerLines[2]).toContain("Copyright (c)");
    expect(headerLines[2]).toContain("Kynetic AI");
  });

  describe("verify-package script", () => {
    let tempDir: string | undefined;

    afterEach(async () => {
      if (tempDir) {
        await cleanupTempDir(tempDir);
        tempDir = undefined;
      }
    });

    // AC: @published-artifact-completeness ac-2
    // AC: @published-artifact-completeness ac-3
    it("exits 0 against the built repository (CLI entry point and web UI assets packed)", () => {
      // CI builds before running tests, so the real package must verify
      // clean: bin's dist/cli/index.js, dist/index.js main, and the
      // dist/web-ui entry document all present in the pack listing.
      const result = runVerifyPackage(REPO_ROOT);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }, 180_000);

    it("exits 0 against a staged tree containing all required artifacts", async () => {
      tempDir = await createTempDir("kspec-verify-package-");
      stagePackageTree(tempDir);
      const result = runVerifyPackage(tempDir);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }, 60_000);

    // AC: @published-artifact-completeness ac-2
    it("exits non-zero when the CLI entry point is missing", async () => {
      tempDir = await createTempDir("kspec-verify-package-");
      stagePackageTree(tempDir, ["dist/cli/index.js"]);
      const result = runVerifyPackage(tempDir);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("dist/cli/index.js");
    }, 60_000);

    // AC: @published-artifact-completeness ac-3
    it("exits non-zero when the web UI entry document is missing", async () => {
      tempDir = await createTempDir("kspec-verify-package-");
      stagePackageTree(tempDir, ["dist/web-ui/index.html"]);
      const result = runVerifyPackage(tempDir);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("dist/web-ui/index.html");
    }, 60_000);
  });
});
