/**
 * Tests for configurable, language-agnostic AC coverage scanner.
 *
 * AC: @coverage-scan-config ac-explicit-opt-in, ac-unconfigured-guidance,
 *     ac-configured-paths, ac-language-aware-parsing, ac-unrecognized-language,
 *     ac-no-silent-regression
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  scanTestCoverage,
  scanACAnnotations,
  getACLinePrefix,
  parseACAnnotationLine,
} from "../src/parser/validate.js";
import { resolveConfig, type ResolvedKspecConfig } from "../src/parser/config.js";
import { createTempDir, cleanupTempDir, testUlid } from "./helpers/cli";

describe("coverage-scan-config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("coverage-scan-config-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // AC: @coverage-scan-config ac-explicit-opt-in
  describe("ac-explicit-opt-in: no scanning when unconfigured", () => {
    it("should return empty coverage set when scan_paths is empty", async () => {
      // Create test files that would be found if scanning were active
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example.test.ts"),
        '// AC: @my-spec ac-1\nit("test", () => {});\n',
      );

      // Empty scan_paths = no scanning
      const coverage = await scanTestCoverage(tempDir, []);
      expect(coverage.size).toBe(0);
    });

    it("should return empty annotations when scan_paths is empty", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example.test.ts"),
        '// AC: @my-spec ac-1\nit("test", () => {});\n',
      );

      const annotations = await scanACAnnotations(tempDir, []);
      expect(annotations).toHaveLength(0);
    });

    it("should return empty coverage set when scan_paths is not provided (defaults to empty)", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example.test.ts"),
        '// AC: @my-spec ac-1\nit("test", () => {});\n',
      );

      // Calling without scan_paths parameter defaults to []
      const coverage = await scanTestCoverage(tempDir);
      expect(coverage.size).toBe(0);
    });

    it("should default scan_paths to empty array in config", () => {
      // No coverage section in config file -> defaults
      const config = resolveConfig(null);
      expect(config.coverage.scan_paths).toEqual([]);
    });
  });

  // AC: @coverage-scan-config ac-unconfigured-guidance
  // AC: @coverage-scan-config ac-no-silent-regression
  describe("ac-unconfigured-guidance / ac-no-silent-regression: warning when unconfigured", () => {
    it("should emit coverage_not_configured warning during validation", async () => {
      const { validate } = await import("../src/parser/validate.js");
      const { initContext, writeYamlFilePreserveFormat } = await import(
        "../src/parser/yaml.js"
      );

      // Initialize git so initContext can find project root for config loading
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: tempDir, stdio: "pipe" });
      execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: "pipe" });
      execSync('git config user.name "Test"', { cwd: tempDir, stdio: "pipe" });

      // Create a kspec.config.yaml with no coverage section
      await fs.writeFile(
        path.join(tempDir, "kspec.config.yaml"),
        "validation:\n  strict_refs: false\n",
      );

      // Create minimal kspec project (flat layout, not shadow branch)
      const modulesDir = path.join(tempDir, "modules");
      await fs.mkdir(modulesDir, { recursive: true });

      await writeYamlFilePreserveFormat(path.join(tempDir, "kynetic.yaml"), {
        project: { name: "test-project" },
        includes: ["modules/specs.yaml"],
      });

      await writeYamlFilePreserveFormat(path.join(modulesDir, "specs.yaml"), [
        {
          _ulid: testUlid("COVTEST"),
          title: "Test Feature",
          type: "feature",
          slugs: ["test-feature"],
          acceptance_criteria: [
            { id: "ac-1", given: "a", when: "b", then: "c" },
          ],
        },
      ]);

      const ctx = await initContext(tempDir);
      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      // Should contain the coverage_not_configured warning
      const coverageWarnings = result.completenessWarnings.filter(
        (w) => w.type === "coverage_not_configured",
      );
      expect(coverageWarnings).toHaveLength(1);
      expect(coverageWarnings[0].message).toContain("coverage.scan_paths");
      expect(coverageWarnings[0].message).toContain("kspec.config.yaml");
    });
  });

  // AC: @coverage-scan-config ac-configured-paths
  describe("ac-configured-paths: configured paths are scanned", () => {
    it("should scan files under configured paths", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example.test.ts"),
        '// AC: @my-spec ac-1\nit("test", () => {});\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@my-spec ac-1")).toBe(true);
    });

    it("should scan multiple configured paths", async () => {
      const testsDir = path.join(tempDir, "tests");
      const e2eDir = path.join(tempDir, "e2e");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.mkdir(e2eDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "unit.test.ts"),
        '// AC: @spec-a ac-1\nit("test", () => {});\n',
      );
      await fs.writeFile(
        path.join(e2eDir, "integration.spec.ts"),
        '// AC: @spec-b ac-2\ntest("test", async () => {});\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/", "e2e/"]);
      expect(coverage.has("@spec-a ac-1")).toBe(true);
      expect(coverage.has("@spec-b ac-2")).toBe(true);
    });

    it("should return structured annotations from configured paths", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example.test.ts"),
        '// AC: @my-spec ac-1\nit("test", () => {});\n',
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].specRef).toBe("@my-spec");
      expect(annotations[0].acIds).toEqual(["ac-1"]);
    });

    it("should handle non-existent scan paths gracefully", async () => {
      const coverage = await scanTestCoverage(tempDir, ["nonexistent/"]);
      expect(coverage.size).toBe(0);
    });

    it("should scan subdirectories recursively", async () => {
      const subDir = path.join(tempDir, "tests", "sub", "deep");
      await fs.mkdir(subDir, { recursive: true });
      await fs.writeFile(
        path.join(subDir, "deep.test.ts"),
        '// AC: @deep-spec ac-1\nit("deep test", () => {});\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@deep-spec ac-1")).toBe(true);
    });

    it("should resolve config scan_paths from config file", () => {
      const config = resolveConfig({
        coverage: { scan_paths: ["tests/", "e2e/"] },
      });
      expect(config.coverage.scan_paths).toEqual(["tests/", "e2e/"]);
    });
  });

  // AC: @coverage-scan-config ac-language-aware-parsing
  describe("ac-language-aware-parsing: comment syntax matches file language", () => {
    it("should parse // style AC annotations in TypeScript files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example.ts"),
        '// AC: @my-spec ac-1\nconst x = 1;\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@my-spec ac-1")).toBe(true);
    });

    it("should parse // style AC annotations in Rust files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "test_module.rs"),
        '// AC: @rust-spec ac-1\n#[test]\nfn test_something() {}\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@rust-spec ac-1")).toBe(true);
    });

    it("should parse # style AC annotations in Python files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "test_example.py"),
        '# AC: @python-spec ac-1\ndef test_something():\n    pass\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@python-spec ac-1")).toBe(true);
    });

    it("should parse # style AC annotations in Ruby files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "test_example.rb"),
        '# AC: @ruby-spec ac-1\nit "tests something" do\nend\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@ruby-spec ac-1")).toBe(true);
    });

    it("should parse -- style AC annotations in SQL files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "test_schema.sql"),
        "-- AC: @sql-spec ac-1\nSELECT 1;\n",
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@sql-spec ac-1")).toBe(true);
    });

    it("should parse -- style AC annotations in Lua files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "test_module.lua"),
        '-- AC: @lua-spec ac-1\nprint("test")\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@lua-spec ac-1")).toBe(true);
    });

    it("should parse // style AC annotations in Go files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example_test.go"),
        '// AC: @go-spec ac-1\nfunc TestSomething(t *testing.T) {}\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@go-spec ac-1")).toBe(true);
    });

    it("should parse # style AC annotations in shell scripts", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "test_script.sh"),
        '#!/bin/bash\n# AC: @shell-spec ac-1\necho "test"\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@shell-spec ac-1")).toBe(true);
    });

    it("should return correct comment prefix for known extensions", () => {
      // // style
      expect(getACLinePrefix(".ts")).toEqual(/\/\/\s*AC:\s*/);
      expect(getACLinePrefix(".js")).toEqual(/\/\/\s*AC:\s*/);
      expect(getACLinePrefix(".rs")).toEqual(/\/\/\s*AC:\s*/);
      expect(getACLinePrefix(".go")).toEqual(/\/\/\s*AC:\s*/);
      expect(getACLinePrefix(".java")).toEqual(/\/\/\s*AC:\s*/);
      expect(getACLinePrefix(".swift")).toEqual(/\/\/\s*AC:\s*/);
      expect(getACLinePrefix(".kt")).toEqual(/\/\/\s*AC:\s*/);

      // # style
      expect(getACLinePrefix(".py")).toEqual(/#\s*AC:\s*/);
      expect(getACLinePrefix(".rb")).toEqual(/#\s*AC:\s*/);
      expect(getACLinePrefix(".sh")).toEqual(/#\s*AC:\s*/);
      expect(getACLinePrefix(".yaml")).toEqual(/#\s*AC:\s*/);
      expect(getACLinePrefix(".toml")).toEqual(/#\s*AC:\s*/);

      // -- style
      expect(getACLinePrefix(".lua")).toEqual(/--\s*AC:\s*/);
      expect(getACLinePrefix(".sql")).toEqual(/--\s*AC:\s*/);
    });

    it("should parse annotation line with Python-style prefix", () => {
      const prefix = getACLinePrefix(".py")!;
      const groups = parseACAnnotationLine("# AC: @my-spec ac-1, ac-2", prefix);
      expect(groups).toHaveLength(1);
      expect(groups[0].specRef).toBe("@my-spec");
      expect(groups[0].acIds).toEqual(["ac-1", "ac-2"]);
    });

    it("should parse annotation line with SQL-style prefix", () => {
      const prefix = getACLinePrefix(".sql")!;
      const groups = parseACAnnotationLine("-- AC: @sql-spec ac-1", prefix);
      expect(groups).toHaveLength(1);
      expect(groups[0].specRef).toBe("@sql-spec");
      expect(groups[0].acIds).toEqual(["ac-1"]);
    });

    it("should return structured annotations with correct file and line for non-JS files", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "test_example.py"),
        'import pytest\n\n# AC: @py-spec ac-1\ndef test_something():\n    pass\n',
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].specRef).toBe("@py-spec");
      expect(annotations[0].acIds).toEqual(["ac-1"]);
      expect(annotations[0].file).toContain("test_example.py");
      expect(annotations[0].line).toBe(3);
    });
  });

  // AC: @coverage-scan-config ac-unrecognized-language
  describe("ac-unrecognized-language: unrecognized files are skipped", () => {
    it("should skip files with unrecognized extensions", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      // Create a file with an unrecognized extension containing AC-like content
      await fs.writeFile(
        path.join(testsDir, "data.xyz"),
        "// AC: @phantom-spec ac-1\nsome data\n",
      );

      // Also create a recognized file to prove scanning works
      await fs.writeFile(
        path.join(testsDir, "real.test.ts"),
        '// AC: @real-spec ac-1\nit("test", () => {});\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@phantom-spec ac-1")).toBe(false);
      expect(coverage.has("@real-spec ac-1")).toBe(true);
    });

    it("should return null for unrecognized extensions", () => {
      expect(getACLinePrefix(".xyz")).toBeNull();
      expect(getACLinePrefix(".bin")).toBeNull();
      expect(getACLinePrefix(".dat")).toBeNull();
      expect(getACLinePrefix("")).toBeNull();
    });

    it("should skip files without extensions", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "Makefile"),
        "# AC: @makefile-spec ac-1\nall: build\n",
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@makefile-spec ac-1")).toBe(false);
    });
  });

  // AC: @coverage-scan-config ac-no-silent-regression
  describe("ac-no-silent-regression: guidance warning surfaces on upgrade", () => {
    it("should not silently lose coverage when upgrading from implicit to explicit scanning", async () => {
      // Simulate: a project had tests that were scanned implicitly,
      // now upgrading to explicit config. Without config, scanner should warn.
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "important.test.ts"),
        '// AC: @important-spec ac-1\nit("test", () => {});\n',
      );

      // Without config (empty scan_paths), coverage is empty
      const coverageWithout = await scanTestCoverage(tempDir, []);
      expect(coverageWithout.size).toBe(0);

      // With config, coverage works
      const coverageWith = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverageWith.has("@important-spec ac-1")).toBe(true);
    });

    it("should surface unconfigured guidance warning in default config", () => {
      // Default config has empty scan_paths — completeness check should produce warning
      const config = resolveConfig(null);
      expect(config.coverage.scan_paths).toEqual([]);
      // The checkCompleteness function will produce a coverage_not_configured warning
      // when scan_paths is empty, which is tested in the ac-unconfigured-guidance test above
    });
  });

  describe("backward compatibility", () => {
    it("should scan .ts files (not just .test.ts) when path is configured", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      // Previously only .test.ts/.spec.ts files were scanned.
      // Now all recognized files in configured paths are scanned.
      await fs.writeFile(
        path.join(testsDir, "helpers.ts"),
        '// AC: @helper-spec ac-1\nexport const helper = true;\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@helper-spec ac-1")).toBe(true);
    });

    it("should still scan .test.ts and .spec.ts files correctly", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "example.test.ts"),
        '// AC: @spec-a ac-1\nit("test", () => {});\n',
      );
      await fs.writeFile(
        path.join(testsDir, "example.spec.ts"),
        '// AC: @spec-b ac-2\ntest("test", async () => {});\n',
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@spec-a ac-1")).toBe(true);
      expect(coverage.has("@spec-b ac-2")).toBe(true);
    });
  });

  describe("config schema", () => {
    it("should accept coverage config with scan_paths", async () => {
      const { KspecConfigSchema } = await import("../src/parser/config.js");
      const result = KspecConfigSchema.safeParse({
        coverage: { scan_paths: ["tests/", "e2e/"] },
      });
      expect(result.success).toBe(true);
    });

    it("should accept empty coverage config", async () => {
      const { KspecConfigSchema } = await import("../src/parser/config.js");
      const result = KspecConfigSchema.safeParse({
        coverage: {},
      });
      expect(result.success).toBe(true);
    });

    it("should reject invalid scan_paths type", async () => {
      const { KspecConfigSchema } = await import("../src/parser/config.js");
      const result = KspecConfigSchema.safeParse({
        coverage: { scan_paths: "not-an-array" },
      });
      expect(result.success).toBe(false);
    });
  });
});
