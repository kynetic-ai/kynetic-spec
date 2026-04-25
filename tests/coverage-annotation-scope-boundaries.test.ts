/**
 * Tests for coverage annotation scope boundaries.
 *
 * Verifies that AC coverage scanning is limited to the configured
 * coverage surface. Annotations outside configured scan paths or
 * inside excluded paths do not create coverage credit and do not
 * create invalid-annotation debt.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  scanTestCoverage,
  scanACAnnotations,
  validate,
} from "../src/parser/validate.js";
import { initContext, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";
import { createTempDir, cleanupTempDir, testUlid } from "./helpers/cli";

/**
 * Build fixture file content containing an AC annotation line.
 * Constructed at runtime so the scanner does not match these
 * string literals as real annotations in THIS source file.
 */
function acLine(ref: string, acId?: string): string {
  return `/${"/"} AC: ${ref}${acId ? ` ${acId}` : ""}`;
}

describe("coverage-annotation-scope-boundaries", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir("coverage-scope-boundaries-");
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  /**
   * Helper to set up a kspec project with configured coverage scanning.
   * Creates git repo, config, manifest, spec items, and test files.
   */
  async function setupProjectWithCoverage(opts: {
    scanPaths: string[];
    excludePatterns?: string[];
    specItems: unknown[];
    /** Files to create, keyed by path relative to tempDir */
    files?: Record<string, string>;
  }) {
    const specDir = path.join(tempDir, "spec");
    const modulesDir = path.join(specDir, "modules");
    await fs.mkdir(modulesDir, { recursive: true });

    // Initialize git for initContext
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: "pipe" });

    // Write kspec.config.yaml with coverage settings
    const coverageConfig: Record<string, unknown> = {
      scan_paths: opts.scanPaths,
    };
    if (opts.excludePatterns) {
      coverageConfig.exclude_patterns = opts.excludePatterns;
    }

    await writeYamlFilePreserveFormat(path.join(tempDir, "kspec.config.yaml"), {
      coverage: coverageConfig,
    });

    // Create manifest
    await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
      project: { name: "test-project" },
      includes: ["modules/specs.yaml"],
    });

    // Write spec items
    await writeYamlFilePreserveFormat(path.join(modulesDir, "specs.yaml"), opts.specItems);

    // Create all specified files
    if (opts.files) {
      for (const [relPath, content] of Object.entries(opts.files)) {
        const absPath = path.join(tempDir, relPath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content);
      }
    }

    return initContext(tempDir);
  }

  // AC: @coverage-annotation-scope-boundaries ac-only-configured-paths-scanned
  describe("ac-only-configured-paths-scanned: only configured paths are scanned", () => {
    it("should find annotations only in configured scan paths", async () => {
      const testsDir = path.join(tempDir, "tests");
      const srcDir = path.join(tempDir, "src");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.mkdir(srcDir, { recursive: true });

      // Annotation inside configured scan path
      await fs.writeFile(
        path.join(testsDir, "feature.test.ts"),
        `${acLine("@my-spec", "ac-1")}\nit("test", () => {});\n`,
      );

      // Annotation-like text OUTSIDE configured scan paths
      await fs.writeFile(
        path.join(srcDir, "implementation.ts"),
        `${acLine("@my-spec", "ac-2")}\nexport const x = 1;\n`,
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@my-spec ac-1")).toBe(true);
      expect(coverage.has("@my-spec ac-2")).toBe(false);
    });

    it("should not scan files in project root when only subdirectories are configured", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      // File at project root (not under any scan path)
      await fs.writeFile(
        path.join(tempDir, "root-file.ts"),
        `${acLine("@root-spec", "ac-1")}\nconst x = 1;\n`,
      );

      // File inside configured scan path
      await fs.writeFile(
        path.join(testsDir, "real.test.ts"),
        `${acLine("@real-spec", "ac-1")}\nit("test", () => {});\n`,
      );

      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@root-spec ac-1")).toBe(false);
      expect(coverage.has("@real-spec ac-1")).toBe(true);
    });

    it("should not return structured annotations from outside configured paths", async () => {
      const testsDir = path.join(tempDir, "tests");
      const docsDir = path.join(tempDir, "docs");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });

      // Inside configured path
      await fs.writeFile(
        path.join(testsDir, "real.test.ts"),
        `${acLine("@spec-a", "ac-1")}\nit("test", () => {});\n`,
      );

      // Outside configured path — has annotation-like text
      await fs.writeFile(
        path.join(docsDir, "examples.ts"),
        `${acLine("@spec-b", "ac-1")}\n// documentation example\n`,
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      const refs = annotations.map((a) => a.specRef);
      expect(refs).toContain("@spec-a");
      expect(refs).not.toContain("@spec-b");
    });

    it("should only scan the specific directories listed, not siblings", async () => {
      const unitDir = path.join(tempDir, "tests", "unit");
      const integDir = path.join(tempDir, "tests", "integration");
      const e2eDir = path.join(tempDir, "e2e");
      await fs.mkdir(unitDir, { recursive: true });
      await fs.mkdir(integDir, { recursive: true });
      await fs.mkdir(e2eDir, { recursive: true });

      await fs.writeFile(
        path.join(unitDir, "unit.test.ts"),
        `${acLine("@unit-spec", "ac-1")}\nit("test", () => {});\n`,
      );
      await fs.writeFile(
        path.join(integDir, "integ.test.ts"),
        `${acLine("@integ-spec", "ac-1")}\nit("test", () => {});\n`,
      );
      await fs.writeFile(
        path.join(e2eDir, "e2e.test.ts"),
        `${acLine("@e2e-spec", "ac-1")}\nit("test", () => {});\n`,
      );

      // Only scan tests/ — e2e/ is a sibling, not included
      const coverage = await scanTestCoverage(tempDir, ["tests/"]);
      expect(coverage.has("@unit-spec ac-1")).toBe(true);
      expect(coverage.has("@integ-spec ac-1")).toBe(true);
      expect(coverage.has("@e2e-spec ac-1")).toBe(false);
    });
  });

  // AC: @coverage-annotation-scope-boundaries ac-excluded-paths-skipped
  describe("ac-excluded-paths-skipped: excluded files within scan paths are skipped", () => {
    it("should skip files matching exact exclude patterns", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "real.test.ts"),
        `${acLine("@real-spec", "ac-1")}\nit("test", () => {});\n`,
      );
      await fs.writeFile(
        path.join(testsDir, "excluded.test.ts"),
        `${acLine("@excluded-spec", "ac-1")}\nit("test", () => {});\n`,
      );

      const coverage = await scanTestCoverage(
        tempDir,
        ["tests/"],
        ["tests/excluded.test.ts"],
      );
      expect(coverage.has("@real-spec ac-1")).toBe(true);
      expect(coverage.has("@excluded-spec ac-1")).toBe(false);
    });

    it("should skip files matching glob exclude patterns", async () => {
      const fixturesDir = path.join(tempDir, "tests", "fixtures");
      await fs.mkdir(fixturesDir, { recursive: true });
      const testsDir = path.join(tempDir, "tests");

      await fs.writeFile(
        path.join(testsDir, "real.test.ts"),
        `${acLine("@real-spec", "ac-1")}\nit("test", () => {});\n`,
      );
      await fs.writeFile(
        path.join(fixturesDir, "fixture-example.ts"),
        `${acLine("@fixture-spec", "ac-1")}\nexport const fixture = true;\n`,
      );

      const coverage = await scanTestCoverage(
        tempDir,
        ["tests/"],
        ["**/fixtures/**"],
      );
      expect(coverage.has("@real-spec ac-1")).toBe(true);
      expect(coverage.has("@fixture-spec ac-1")).toBe(false);
    });

    it("should skip excluded files from structured annotation scanning too", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "real.test.ts"),
        `${acLine("@real-spec", "ac-1")}\nit("test", () => {});\n`,
      );
      await fs.writeFile(
        path.join(testsDir, "parser-examples.test.ts"),
        `${acLine("@parser-doc", "ac-1")}\n// this is documentation, not real coverage\n`,
      );

      const annotations = await scanACAnnotations(
        tempDir,
        ["tests/"],
        ["tests/parser-examples.test.ts"],
      );
      expect(annotations).toHaveLength(1);
      expect(annotations[0].specRef).toBe("@real-spec");
    });
  });

  // AC: @coverage-annotation-scope-boundaries ac-skipped-annotations-no-credit
  describe("ac-skipped-annotations-no-credit: skipped annotations produce no coverage credit", () => {
    it("should not credit coverage from files outside scan paths", async () => {
      const ctx = await setupProjectWithCoverage({
        scanPaths: ["tests/"],
        specItems: [
          {
            _ulid: testUlid("SCPBNDA"),
            slugs: ["boundary-spec"],
            title: "Boundary Spec",
            type: "requirement",
            description: "A spec to test boundary behavior",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              { id: "ac-1", given: "condition", when: "action", then: "result" },
            ],
          },
        ],
        files: {
          // Annotation-like text in src/ (outside scan paths)
          "src/implementation.ts": `${acLine("@boundary-spec", "ac-1")}\nexport const x = 1;\n`,
        },
      });

      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      // The AC should still show as missing coverage because src/ is outside scan paths
      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" &&
          w.subtype === "own_ac" &&
          w.itemRef === "@boundary-spec",
      );
      expect(missingCoverage).toHaveLength(1);
      expect(missingCoverage[0].details).toContain("ac-1");
    });

    it("should not credit coverage from excluded files within scan paths", async () => {
      const ctx = await setupProjectWithCoverage({
        scanPaths: ["tests/"],
        excludePatterns: ["tests/excluded-example.test.ts"],
        specItems: [
          {
            _ulid: testUlid("SCPBNDB"),
            slugs: ["excluded-spec"],
            title: "Excluded Spec",
            type: "requirement",
            description: "Spec with AC in excluded file",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              { id: "ac-1", given: "condition", when: "action", then: "result" },
            ],
          },
        ],
        files: {
          // This file is excluded — annotation should not count
          "tests/excluded-example.test.ts":
            `${acLine("@excluded-spec", "ac-1")}\nit("test", () => {});\n`,
        },
      });

      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      // AC should show as missing because the only annotation is in an excluded file
      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" &&
          w.subtype === "own_ac" &&
          w.itemRef === "@excluded-spec",
      );
      expect(missingCoverage).toHaveLength(1);
      expect(missingCoverage[0].details).toContain("ac-1");
    });

    it("should credit coverage only from non-excluded files in scan paths", async () => {
      const ctx = await setupProjectWithCoverage({
        scanPaths: ["tests/"],
        excludePatterns: ["tests/excluded.test.ts"],
        specItems: [
          {
            _ulid: testUlid("SCPBNDC"),
            slugs: ["mixed-spec"],
            title: "Mixed Spec",
            type: "requirement",
            description: "Spec with ACs in both included and excluded files",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              { id: "ac-1", given: "g1", when: "w1", then: "t1" },
              { id: "ac-2", given: "g2", when: "w2", then: "t2" },
            ],
          },
        ],
        files: {
          // ac-1 covered in included file
          "tests/included.test.ts":
            `${acLine("@mixed-spec", "ac-1")}\nit("test ac-1", () => {});\n`,
          // ac-2 "covered" in excluded file — should not count
          "tests/excluded.test.ts":
            `${acLine("@mixed-spec", "ac-2")}\nit("test ac-2", () => {});\n`,
        },
      });

      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" &&
          w.subtype === "own_ac" &&
          w.itemRef === "@mixed-spec",
      );
      // ac-1 is covered (in included file), ac-2 is not (excluded file)
      expect(missingCoverage).toHaveLength(1);
      expect(missingCoverage[0].details).toContain("ac-2");
      expect(missingCoverage[0].details).not.toContain("ac-1");
    });
  });

  // AC: @coverage-annotation-scope-boundaries ac-skipped-annotations-no-invalid-debt
  describe("ac-skipped-annotations-no-invalid-debt: skipped annotations produce no invalid-annotation findings", () => {
    it("should not report invalid annotations from files outside scan paths", async () => {
      const ctx = await setupProjectWithCoverage({
        scanPaths: ["tests/"],
        specItems: [
          {
            _ulid: testUlid("SCPBNDD"),
            slugs: ["real-spec"],
            title: "Real Spec",
            type: "requirement",
            description: "A real spec",
            status: { maturity: "draft", implementation: "not_started" },
          },
        ],
        files: {
          // Invalid annotation (unresolved ref) in src/ (outside scan paths)
          "src/parser-doc.ts":
            `${acLine("@nonexistent-spec", "ac-1")}\n// This is a documentation example\n`,
          // Another invalid annotation (missing AC id) outside scan paths
          "docs/examples.ts":
            `${acLine("@real-spec", "ac-99")}\n// Documentation showing AC format\n`,
        },
      });

      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      // No invalid annotation findings — the files are outside scan paths
      expect(invalidAnnotations).toHaveLength(0);
    });

    it("should not report invalid annotations from excluded files within scan paths", async () => {
      const ctx = await setupProjectWithCoverage({
        scanPaths: ["tests/"],
        excludePatterns: ["tests/parser-examples.test.ts"],
        specItems: [
          {
            _ulid: testUlid("SCPBNDE"),
            slugs: ["real-spec"],
            title: "Real Spec",
            type: "requirement",
            description: "A real spec",
            status: { maturity: "draft", implementation: "not_started" },
          },
        ],
        files: {
          // Excluded file contains annotation referencing nonexistent spec
          "tests/parser-examples.test.ts":
            `${acLine("@nonexistent-parser-doc", "ac-1")}\nit("example from docs", () => {});\n`,
        },
      });

      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      // No invalid annotation findings — the file is excluded
      expect(invalidAnnotations).toHaveLength(0);
    });

    it("should report invalid annotations only from included, non-excluded files", async () => {
      const ctx = await setupProjectWithCoverage({
        scanPaths: ["tests/"],
        excludePatterns: ["tests/excluded-fixture.test.ts"],
        specItems: [
          {
            _ulid: testUlid("SCPBNDF"),
            slugs: ["real-spec"],
            title: "Real Spec",
            type: "requirement",
            description: "A real spec",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              { id: "ac-1", given: "g", when: "w", then: "t" },
            ],
          },
        ],
        files: {
          // Included file with invalid annotation — SHOULD be reported
          "tests/real.test.ts":
            `${acLine("@real-spec", "ac-99")}\nit("test with bad AC id", () => {});\n`,
          // Excluded file with invalid annotation — should NOT be reported
          "tests/excluded-fixture.test.ts":
            `${acLine("@bogus-ref", "ac-1")}\nit("fixture example", () => {});\n`,
          // Outside scan paths with invalid annotation — should NOT be reported
          "src/doc-example.ts":
            `${acLine("@another-bogus", "ac-1")}\nexport const x = 1;\n`,
        },
      });

      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      // Only the annotation in the included file should be flagged
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("@real-spec ac-99");
      expect(invalidAnnotations[0].subtype).toBe("missing_ac_id");
    });

    it("should not report blanket-ref warnings from excluded files", async () => {
      const ctx = await setupProjectWithCoverage({
        scanPaths: ["tests/"],
        excludePatterns: ["tests/blanket-example.test.ts"],
        specItems: [
          {
            _ulid: testUlid("SCPBNDG"),
            slugs: ["blanket-spec"],
            title: "Blanket Spec",
            type: "requirement",
            description: "Spec to test blanket ref in excluded file",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              { id: "ac-1", given: "g", when: "w", then: "t" },
            ],
          },
        ],
        files: {
          // Excluded file with blanket ref (no ac-N ids) — should NOT generate warning
          "tests/blanket-example.test.ts":
            `${acLine("@blanket-spec")}\nit("blanket ref example", () => {});\n`,
        },
      });

      const result = await validate(ctx, {
        completeness: true,
        schema: false,
        refs: false,
        orphans: false,
      });

      const blanketWarnings = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation" && w.subtype === "blanket_ref",
      );
      expect(blanketWarnings).toHaveLength(0);
    });
  });
});
