/**
 * Tests for the no-daemon-ts-imports oxlint rule.
 *
 * Verifies that the lint rule catches value imports from dist/daemon/
 * using .ts extensions while allowing type-only imports and .js imports.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function runOxlint(fileContent: string): { exitCode: number; output: string } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "lint-test-"));
  const testFile = path.join(tempDir, "test-file.ts");
  // Oxlint needs to be run from the project root to resolve jsPlugins
  const projectRoot = path.resolve(__dirname, "..");
  // Create a minimal oxlint config that only loads our rule
  const pluginPath = path.resolve(projectRoot, "tools/eslint-rules/no-daemon-ts-imports.js");
  const config = {
    plugins: ["typescript"],
    overrides: [
      {
        files: ["**/*.ts"],
        jsPlugins: [pluginPath],
        rules: {
          "no-daemon-ts-imports/no-daemon-ts-imports": "error",
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

describe("no-daemon-ts-imports lint rule", () => {
  it("should flag value imports from dist/daemon/ with .ts extension", () => {
    const result = runOxlint(
      `import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.ts";\n`,
    );
    expect(result.output).toContain("no-daemon-ts-imports");
  });

  it("should allow value imports from dist/daemon/ with .js extension", () => {
    const result = runOxlint(
      `import { projectContextMiddleware } from "../dist/daemon/middleware/project-context.js";\n`,
    );
    expect(result.output).not.toContain("no-daemon-ts-imports");
  });

  it("should allow type-only imports from dist/daemon/ with .ts extension", () => {
    const result = runOxlint(
      `import type { WriteThroughHint } from "../dist/daemon/entity-cache.ts";\n`,
    );
    expect(result.output).not.toContain("no-daemon-ts-imports");
  });

  it("should not flag imports from dist/parser/ with .ts extension", () => {
    const result = runOxlint(`import type { MetaContext } from "../dist/parser/meta.ts";\n`);
    expect(result.output).not.toContain("no-daemon-ts-imports");
  });

  it("should flag mixed imports where at least one specifier is a value import", () => {
    const result = runOxlint(
      `import { createServer, type ServerConfig } from "../dist/daemon/server.ts";\n`,
    );
    expect(result.output).toContain("no-daemon-ts-imports");
  });

  it("should flag side-effect-only imports from dist/daemon/ with .ts extension", () => {
    const result = runOxlint(`import "../dist/daemon/server.ts";\n`);
    expect(result.output).toContain("no-daemon-ts-imports");
  });
});
