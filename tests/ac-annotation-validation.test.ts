/**
 * Tests for AC annotation validation in test files.
 *
 * AC: @ref-validation ac-1
 *
 * Validates that // AC: @slug ac-N comments reference real spec items/traits
 * and that ac-N exists on the referenced item.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
  computeACCoverage,
  validate,
  scanACAnnotations,
  validateACAnnotations,
  parseACAnnotationLine,
} from "../src/parser/validate.js";
import { initContext, writeYamlFilePreserveFormat } from "../src/parser/yaml.js";
import { ReferenceIndex } from "../src/parser/refs.js";

describe("AC annotation validation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-ac-annot-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to set up a minimal kspec project with a spec item and optional test files.
   */
  async function setupProject(opts: {
    specItems: unknown[];
    testFiles?: Record<string, string>;
    tasks?: unknown[];
  }) {
    const specDir = path.join(tempDir, "spec");
    const modulesDir = path.join(specDir, "modules");
    const testsDir = path.join(tempDir, "tests");
    await fs.mkdir(modulesDir, { recursive: true });
    await fs.mkdir(testsDir, { recursive: true });

    // Initialize git so loadProjectConfig can find config at git root
    execSync("git init", { cwd: tempDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: "pipe" });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: "pipe" });

    // Enable coverage scanning for tests
    await fs.writeFile(
      path.join(tempDir, "kspec.config.yaml"),
      "coverage:\n  scan_paths:\n    - tests/\n",
    );

    // Create manifest
    await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
      project: { name: "test-project" },
      includes: ["modules/specs.yaml"],
    });

    // Write spec items
    await writeYamlFilePreserveFormat(path.join(modulesDir, "specs.yaml"), opts.specItems);

    // Write tasks file
    if (opts.tasks) {
      await writeYamlFilePreserveFormat(path.join(specDir, "project.tasks.yaml"), {
        tasks: opts.tasks,
      });
    }

    // Write test files
    if (opts.testFiles) {
      for (const [filename, content] of Object.entries(opts.testFiles)) {
        await fs.writeFile(path.join(testsDir, filename), content);
      }
    }

    return initContext(tempDir);
  }

  // AC: @ref-validation ac-1
  describe("scanACAnnotations", () => {
    it("should return structured annotation data with file and line", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "example.test.ts"),
        `import { it } from 'vitest';

// AC: @my-spec ac-1
it('should work', () => {});

// AC: @my-spec ac-2, ac-3
it('should also work', () => {});
`,
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);

      expect(annotations).toHaveLength(2);

      expect(annotations[0].specRef).toBe("@my-spec");
      expect(annotations[0].acIds).toEqual(["ac-1"]);
      expect(annotations[0].file).toContain("example.test.ts");
      expect(annotations[0].line).toBe(3);

      expect(annotations[1].specRef).toBe("@my-spec");
      expect(annotations[1].acIds).toEqual(["ac-2", "ac-3"]);
      expect(annotations[1].line).toBe(6);
    });

    it("should scan multiple configured directories", async () => {
      const testsDir = path.join(tempDir, "tests");
      const e2eDir = path.join(tempDir, "packages", "web-ui", "tests", "e2e");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.mkdir(e2eDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "unit.test.ts"),
        "// AC: @spec-a ac-1\nit('test', () => {});",
      );
      await fs.writeFile(
        path.join(e2eDir, "e2e.spec.ts"),
        "// AC: @spec-b ac-2\ntest('test', async () => {});",
      );

      const annotations = await scanACAnnotations(tempDir, [
        "tests/",
        "packages/web-ui/tests/e2e/",
      ]);
      expect(annotations).toHaveLength(2);

      const refs = annotations.map((a) => `${a.specRef} ${a.acIds[0]}`);
      expect(refs).toContain("@spec-a ac-1");
      expect(refs).toContain("@spec-b ac-2");
    });

    // AC: @test-annotation-sweep ac-annotation-format
    it("should parse named ac ids on sweep annotations", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "named-ac.test.ts"),
        "// AC: @task-add ac-create, ac-priority-valid\nit('test', () => {});",
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].specRef).toBe("@task-add");
      expect(annotations[0].acIds).toEqual(["ac-create", "ac-priority-valid"]);
    });

    it("should handle annotations without specific AC ids", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "generic.test.ts"),
        "// AC: @some-spec\nit('test', () => {});",
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].specRef).toBe("@some-spec");
      expect(annotations[0].acIds).toEqual([]);
    });

    it("should return empty array when no test directories exist", async () => {
      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toEqual([]);
    });
  });

  // Unresolved references should emit invalid_ac_annotation warnings.
  describe("validateACAnnotations - unresolved references", () => {
    it("should warn when @slug does not resolve to any item", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["real-spec"],
            title: "Real Spec",
            type: "requirement",
            description: "A real spec",
            status: { maturity: "draft", implementation: "not_started" },
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @nonexistent-spec ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("@nonexistent-spec");
      expect(invalidAnnotations[0].message).toContain("cannot be resolved");
    });

    it("should not warn when @slug resolves to a real item", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["real-spec"],
            title: "Real Spec",
            type: "requirement",
            description: "A real spec",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-1",
                given: "condition",
                when: "action",
                then: "result",
              },
            ],
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @real-spec ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(0);
    });

    // AC: @test-annotation-sweep ac-explicit-mapping
    it("credits completeness coverage only when explicit ac ids are provided", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["real-spec"],
            title: "Real Spec",
            type: "requirement",
            description: "A real spec",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-1",
                given: "condition",
                when: "action",
                then: "result",
              },
            ],
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @real-spec ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" &&
          w.subtype === "own_ac" &&
          w.itemRef === "@real-spec",
      );

      expect(invalidAnnotations).toHaveLength(0);
      expect(missingCoverage).toHaveLength(0);
    });
  });

  // Non-existent AC ids should emit invalid_ac_annotation warnings.
  describe("validateACAnnotations - non-existent AC ids", () => {
    it("should warn when ac-N does not exist on the resolved item", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec with one AC",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-1",
                given: "condition",
                when: "action",
                then: "result",
              },
            ],
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @my-spec ac-5\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("@my-spec ac-5");
      expect(invalidAnnotations[0].message).toContain("no acceptance criterion 'ac-5'");
    });

    it("should warn for each non-existent AC in a multi-AC annotation", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec with one AC",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-1",
                given: "condition",
                when: "action",
                then: "result",
              },
            ],
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @my-spec ac-1, ac-2, ac-3\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      // ac-1 exists, ac-2 and ac-3 do not
      expect(invalidAnnotations).toHaveLength(2);
      const messages = invalidAnnotations.map((w) => w.message);
      expect(messages.some((m) => m.includes("ac-2"))).toBe(true);
      expect(messages.some((m) => m.includes("ac-3"))).toBe(true);
    });

    it("should not warn when all referenced ACs exist", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-1",
                given: "c1",
                when: "a1",
                then: "r1",
              },
              {
                id: "ac-2",
                given: "c2",
                when: "a2",
                then: "r2",
              },
            ],
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @my-spec ac-1, ac-2\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(0);
    });
  });

  // Trait references should validate against real trait AC ids.
  describe("validateACAnnotations - trait references", () => {
    it("should validate annotations referencing traits", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-trait"],
            title: "My Trait",
            type: "trait",
            description: "A trait with one AC",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-1",
                given: "condition",
                when: "action",
                then: "result",
              },
            ],
          },
        ],
        testFiles: {
          "example.test.ts": `
// AC: @my-trait ac-1
it('valid trait AC ref', () => {});

// AC: @my-trait ac-99
it('invalid trait AC ref', () => {});
`,
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("ac-99");
    });
  });

  describe("validateACAnnotations - edge cases", () => {
    // AC: @test-annotation-sweep ac-no-blanket-credit
    it("warns and withholds coverage when annotations omit ac ids for items with ACs", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec with ACs",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-1",
                given: "condition",
                when: "action",
                then: "result",
              },
            ],
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @my-spec\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" && w.subtype === "own_ac" && w.itemRef === "@my-spec",
      );

      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("without explicit ac-* ids");
      expect(missingCoverage).toHaveLength(1);
      expect(missingCoverage[0].details).toContain("ac-1");
    });

    it("should handle item with no acceptance_criteria array", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["no-ac-spec"],
            title: "No AC Spec",
            type: "requirement",
            description: "A spec with no AC",
            status: { maturity: "draft", implementation: "not_started" },
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @no-ac-spec ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("no acceptance criterion 'ac-1'");
    });

    it("should include file location in warning details", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec",
            status: { maturity: "draft", implementation: "not_started" },
          },
        ],
        testFiles: {
          "my-feature.test.ts": '// AC: @bogus-ref ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].details).toContain("my-feature.test.ts");
      expect(invalidAnnotations[0].details).toContain(":1");
    });

    it("should warn when AC annotation references a task instead of a spec item", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["real-spec"],
            title: "Real Spec",
            type: "requirement",
            description: "A real spec",
            status: { maturity: "draft", implementation: "not_started" },
          },
        ],
        tasks: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG91A",
            slugs: ["task-example"],
            title: "Example Task",
            status: "pending",
            priority: 3,
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @task-example ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("@task-example");
      expect(invalidAnnotations[0].message).toContain("not a spec item or trait");
    });

    it("should warn when AC annotation references a task even without AC ids", async () => {
      const ctx = await setupProject({
        specItems: [],
        tasks: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG91A",
            slugs: ["task-example"],
            title: "Example Task",
            status: "pending",
            priority: 3,
          },
        ],
        testFiles: {
          "example.test.ts": '// AC: @task-example\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("@task-example");
      expect(invalidAnnotations[0].message).toContain("not a spec item or trait");
    });
  });

  describe("validateACAnnotations unit tests", () => {
    it("should detect unresolved references without full kspec project", () => {
      const annotations = [
        {
          specRef: "@nonexistent",
          acIds: ["ac-1"],
          file: "/tmp/test.test.ts",
          line: 5,
        },
      ];

      // Empty index — nothing to resolve against
      const index = new ReferenceIndex([], []);
      const warnings = validateACAnnotations(annotations, [], index);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe("invalid_ac_annotation");
      expect(warnings[0].message).toContain("cannot be resolved");
    });

    it("should detect non-existent AC on resolved item", () => {
      const items = [
        {
          _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
          slugs: ["my-spec"],
          title: "My Spec",
          type: "requirement" as const,
          description: "test",
          status: { maturity: "draft" as const, implementation: "not_started" as const },
          acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          _sourceFile: "test.yaml",
        },
      ];

      const index = new ReferenceIndex([], items);
      const annotations = [
        {
          specRef: "@my-spec",
          acIds: ["ac-1", "ac-3"],
          file: "/tmp/test.test.ts",
          line: 10,
        },
      ];

      const warnings = validateACAnnotations(annotations, items, index);

      // ac-1 exists, ac-3 does not
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain("ac-3");
    });

    it("should warn when ref resolves to a task (not a spec item or trait)", () => {
      // Task is in the reference index but NOT in the spec items list
      const tasks = [
        {
          _ulid: "01KFCRVY8ERZEE2MNHEQXSG91A",
          slugs: ["task-example"],
          title: "Example Task",
          status: "pending" as const,
          priority: 3,
          _sourceFile: "project.tasks.yaml",
        },
      ];

      // Index has the task, but items list is empty (no spec items)
      const index = new ReferenceIndex(tasks as any, []);
      const annotations = [
        {
          specRef: "@task-example",
          acIds: ["ac-1"],
          file: "/tmp/test.test.ts",
          line: 5,
        },
      ];

      const warnings = validateACAnnotations(annotations, [], index);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe("invalid_ac_annotation");
      expect(warnings[0].message).toContain("@task-example");
      expect(warnings[0].message).toContain("not a spec item or trait");
    });

    it("should warn when ref resolves to a task even without specific AC ids", () => {
      const tasks = [
        {
          _ulid: "01KFCRVY8ERZEE2MNHEQXSG91A",
          slugs: ["task-example"],
          title: "Example Task",
          status: "pending" as const,
          priority: 3,
          _sourceFile: "project.tasks.yaml",
        },
      ];

      const index = new ReferenceIndex(tasks as any, []);
      const annotations = [
        {
          specRef: "@task-example",
          acIds: [],
          file: "/tmp/test.test.ts",
          line: 5,
        },
      ];

      const warnings = validateACAnnotations(annotations, [], index);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe("invalid_ac_annotation");
      expect(warnings[0].message).toContain("not a spec item or trait");
    });
  });

  describe("computeACCoverage", () => {
    // AC: @test-annotation-sweep ac-annotation-format
    it("uses the declared AC ids when computing coverage status", () => {
      const coverage = computeACCoverage(
        {
          _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
          slugs: ["task-add"],
          acceptance_criteria: [
            { id: "ac-create", given: "g", when: "w", then: "t" },
            { id: "ac-priority-valid", given: "g", when: "w", then: "t" },
          ],
        },
        new Set(["@task-add ac-create"]),
      );

      expect(coverage).toEqual([
        expect.objectContaining({ id: "ac-create", covered: true }),
        expect.objectContaining({ id: "ac-priority-valid", covered: false }),
      ]);
    });
  });

  describe("parseACAnnotationLine - multi-group annotations", () => {
    it("should parse a single @ref with single AC", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1");
      expect(groups).toEqual([{ specRef: "@spec-a", acIds: ["ac-1"] }]);
    });

    it("should parse a single @ref with multiple comma-separated ACs", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1, ac-2, ac-3");
      expect(groups).toEqual([{ specRef: "@spec-a", acIds: ["ac-1", "ac-2", "ac-3"] }]);
    });

    it("should parse multiple @ref groups on the same line", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1, @spec-b ac-2");
      expect(groups).toEqual([
        { specRef: "@spec-a", acIds: ["ac-1"] },
        { specRef: "@spec-b", acIds: ["ac-2"] },
      ]);
    });

    it("should parse multiple @ref groups with multiple ACs each", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1, ac-2, @spec-b ac-3, ac-4");
      expect(groups).toEqual([
        { specRef: "@spec-a", acIds: ["ac-1", "ac-2"] },
        { specRef: "@spec-b", acIds: ["ac-3", "ac-4"] },
      ]);
    });

    it("should parse three @ref groups", () => {
      const groups = parseACAnnotationLine(
        "// AC: @agent-instruction-gen ac-5, @agents-cli ac-3, @agents-cli ac-4",
      );
      expect(groups).toEqual([
        { specRef: "@agent-instruction-gen", acIds: ["ac-5"] },
        { specRef: "@agents-cli", acIds: ["ac-3"] },
        { specRef: "@agents-cli", acIds: ["ac-4"] },
      ]);
    });

    it("should parse @ref without AC ids", () => {
      const groups = parseACAnnotationLine("// AC: @some-spec");
      expect(groups).toEqual([{ specRef: "@some-spec", acIds: [] }]);
    });

    it("should strip N/A suffix", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1 — N/A: reason why");
      expect(groups).toEqual([{ specRef: "@spec-a", acIds: ["ac-1"] }]);
    });

    it("should strip parenthetical comments", () => {
      const groups = parseACAnnotationLine("// AC: @cli-exit-codes (exit 4 for validation errors)");
      expect(groups).toEqual([{ specRef: "@cli-exit-codes", acIds: [] }]);
    });

    it("should return empty array for non-AC lines", () => {
      expect(parseACAnnotationLine("// just a comment")).toEqual([]);
      expect(parseACAnnotationLine("const x = 1;")).toEqual([]);
    });
  });

  describe("scanACAnnotations - multi-group lines", () => {
    it("should produce separate annotations for each @ref group on a line", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "multi-ref.test.ts"),
        `// AC: @spec-a ac-1, @spec-b ac-2
it('test', () => {});
`,
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);

      expect(annotations).toHaveLength(2);
      expect(annotations[0]).toEqual(
        expect.objectContaining({ specRef: "@spec-a", acIds: ["ac-1"], line: 1 }),
      );
      expect(annotations[1]).toEqual(
        expect.objectContaining({ specRef: "@spec-b", acIds: ["ac-2"], line: 1 }),
      );
    });

    it("should produce separate annotations for three @ref groups on a line", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "triple-ref.test.ts"),
        `// AC: @feat-a ac-1, @feat-b ac-2, @feat-c ac-3
it('test', () => {});
`,
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);

      expect(annotations).toHaveLength(3);
      expect(annotations[0].specRef).toBe("@feat-a");
      expect(annotations[1].specRef).toBe("@feat-b");
      expect(annotations[2].specRef).toBe("@feat-c");
    });
  });

  describe("validateACAnnotations - multi-group validation", () => {
    it("should validate all @ref groups on a single line", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["spec-a"],
            title: "Spec A",
            type: "requirement",
            description: "A spec",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG91B",
            slugs: ["spec-b"],
            title: "Spec B",
            type: "requirement",
            description: "Another spec",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          "multi.test.ts": '// AC: @spec-a ac-1, @spec-b ac-99\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      // @spec-a ac-1 is valid, @spec-b ac-99 is invalid
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("@spec-b ac-99");
    });

    it("should warn for unresolved secondary @ref on a multi-group line", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["spec-a"],
            title: "Spec A",
            type: "requirement",
            description: "A spec",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          "multi.test.ts": '// AC: @spec-a ac-1, @nonexistent ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(1);
      expect(invalidAnnotations[0].message).toContain("@nonexistent");
      expect(invalidAnnotations[0].message).toContain("cannot be resolved");
    });
  });
});
