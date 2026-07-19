/**
 * Tests for the no-unguarded-npm-pack oxlint rule.
 *
 * Verifies that the lint rule flags `npm pack` invocations missing
 * --ignore-scripts (prepack runs the full build, rewriting dist/ while
 * parallel vitest workers spawn the compiled CLI) and allows guarded packs.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Composed at runtime so this test file's own source never contains an
// unguarded `npm pack` literal that the repo-wide lint config would flag.
const NPM_PACK = ["npm", "pack"].join(" ");

function runOxlint(fileContent: string): { exitCode: number; output: string } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "lint-test-"));
  const testFile = path.join(tempDir, "test-file.ts");
  // Oxlint needs to be run from the project root to resolve jsPlugins
  const projectRoot = path.resolve(__dirname, "..");
  // Create a minimal oxlint config that only loads our rule
  const pluginPath = path.resolve(projectRoot, "tools/eslint-rules/no-unguarded-npm-pack.js");
  const config = {
    plugins: ["typescript"],
    overrides: [
      {
        files: ["**/*.ts"],
        jsPlugins: [pluginPath],
        rules: {
          "no-unguarded-npm-pack/no-unguarded-npm-pack": "error",
        },
      },
    ],
  };
  const configFile = path.join(tempDir, ".oxlintrc.json");
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(testFile, fileContent);

  try {
    const output = execSync(`npx oxlint --config ${configFile} ${testFile}`, {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    rmSync(tempDir, { recursive: true, force: true });
    return { exitCode: 0, output };
  } catch (err: unknown) {
    const error = err as { status: number; stdout: string; stderr: string };
    const output = (error.stdout || "") + (error.stderr || "");
    rmSync(tempDir, { recursive: true, force: true });
    return { exitCode: error.status, output };
  }
}

describe("no-unguarded-npm-pack lint rule", () => {
  it("should flag a template-literal npm pack without --ignore-scripts", () => {
    const result = runOxlint(
      `const out = execSync(\`${NPM_PACK} --pack-destination \${dir}\`, { cwd: root });\n`,
    );
    expect(result.output).toContain("no-unguarded-npm-pack");
  });

  it("should flag a plain-string npm pack without --ignore-scripts", () => {
    const result = runOxlint(`const out = execSync("${NPM_PACK}", { cwd: root });\n`);
    expect(result.output).toContain("no-unguarded-npm-pack");
  });

  it("should allow a template-literal npm pack with --ignore-scripts", () => {
    const result = runOxlint(
      `const out = execSync(\`${NPM_PACK} --ignore-scripts --pack-destination \${dir}\`, { cwd: root });\n`,
    );
    expect(result.output).not.toContain("no-unguarded-npm-pack");
  });

  it("should flag spawn-style array form without --ignore-scripts", () => {
    const result = runOxlint(
      'const result = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root });\n',
    );
    expect(result.output).toContain("no-unguarded-npm-pack");
  });

  it("should allow spawn-style array form with --ignore-scripts", () => {
    const result = runOxlint(
      'const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root });\n',
    );
    expect(result.output).not.toContain("no-unguarded-npm-pack");
  });

  it("should not flag other npm subcommands", () => {
    const result = runOxlint(
      'const out = execSync("npm install --no-save tarball.tgz", { cwd: dir });\n' +
        'const r = spawnSync("npm", ["run", "build:daemon"], { cwd: root });\n',
    );
    expect(result.output).not.toContain("no-unguarded-npm-pack");
  });

  it("should not flag a template literal with an interpolation between npm and pack", () => {
    const result = runOxlint("const out = execSync(`npm ${sub} pack-helper`, { cwd: root });\n");
    expect(result.output).not.toContain("no-unguarded-npm-pack");
  });
});
