/**
 * Tests for AC annotation validation in test files.
 *
 * AC: @ref-validation ac-1
 *
 * Validates that // AC: @slug ac-N comments reference real spec items/traits
 * and that ac-N exists on the referenced item.
 *
 * EXCLUDED from coverage scanning (kspec.config.yaml exclude_patterns) because
 * this file contains fixture AC annotation strings inside test file content
 * that would be misinterpreted as real coverage annotations by the scanner.
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
  scanTestCoverage,
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
    // AC: @ac-annotation-integrity-reporting ac-unresolved-target-reported
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
      expect(invalidAnnotations[0].subtype).toBe("unresolved_target");
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

    // AC: @ac-annotation-integrity-reporting ac-valid-annotation-covers-target
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
    // AC: @ac-annotation-integrity-reporting ac-missing-ac-id-reported
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
      expect(invalidAnnotations[0].subtype).toBe("missing_ac_id");
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
    // AC: @ac-annotation-integrity-reporting ac-blanket-ref-does-not-cover
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
      expect(invalidAnnotations[0].subtype).toBe("blanket_ref");
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
      expect(invalidAnnotations[0].subtype).toBe("missing_ac_id");
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

    // AC: @ac-annotation-integrity-reporting ac-non-spec-target-reported
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
      expect(invalidAnnotations[0].subtype).toBe("non_spec_target");
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
      expect(invalidAnnotations[0].subtype).toBe("non_spec_target");
      expect(invalidAnnotations[0].message).toContain("@task-example");
      expect(invalidAnnotations[0].message).toContain("not a spec item or trait");
    });
  });

  describe("validateACAnnotations unit tests", () => {
    // AC: @ac-annotation-integrity-reporting ac-unresolved-target-reported
    it("should detect unresolved references without full kspec project", () => {
      const annotations = [
        {
          specRef: "@nonexistent",
          acIds: ["ac-1"],
          malformedTokens: [],
          file: "/tmp/test.test.ts",
          line: 5,
        },
      ];

      // Empty index — nothing to resolve against
      const index = new ReferenceIndex([], []);
      const warnings = validateACAnnotations(annotations, [], index);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe("invalid_ac_annotation");
      expect(warnings[0].subtype).toBe("unresolved_target");
      expect(warnings[0].message).toContain("cannot be resolved");
      expect(warnings[0].itemRef).toBe("@nonexistent");
      expect(warnings[0].details).toContain("/tmp/test.test.ts:5");
    });

    // AC: @ac-annotation-integrity-reporting ac-missing-ac-id-reported
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
          malformedTokens: [],
          file: "/tmp/test.test.ts",
          line: 10,
        },
      ];

      const warnings = validateACAnnotations(annotations, items, index);

      // ac-1 exists, ac-3 does not
      expect(warnings).toHaveLength(1);
      expect(warnings[0].subtype).toBe("missing_ac_id");
      expect(warnings[0].message).toContain("ac-3");
      expect(warnings[0].itemRef).toBe("@my-spec");
      expect(warnings[0].details).toContain("/tmp/test.test.ts:10");
    });

    // AC: @ac-annotation-integrity-reporting ac-non-spec-target-reported
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
          malformedTokens: [],
          file: "/tmp/test.test.ts",
          line: 5,
        },
      ];

      const warnings = validateACAnnotations(annotations, [], index);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe("invalid_ac_annotation");
      expect(warnings[0].subtype).toBe("non_spec_target");
      expect(warnings[0].message).toContain("@task-example");
      expect(warnings[0].message).toContain("not a spec item or trait");
      expect(warnings[0].details).toContain("/tmp/test.test.ts:5");
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
          malformedTokens: [],
          file: "/tmp/test.test.ts",
          line: 5,
        },
      ];

      const warnings = validateACAnnotations(annotations, [], index);

      expect(warnings).toHaveLength(1);
      expect(warnings[0].type).toBe("invalid_ac_annotation");
      expect(warnings[0].subtype).toBe("non_spec_target");
      expect(warnings[0].message).toContain("not a spec item or trait");
    });
  });

  describe("computeACCoverage", () => {
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
      expect(groups).toEqual([{ specRef: "@spec-a", acIds: ["ac-1"], malformedTokens: [] }]);
    });

    it("should parse a single @ref with multiple comma-separated ACs", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1, ac-2, ac-3");
      expect(groups).toEqual([
        { specRef: "@spec-a", acIds: ["ac-1", "ac-2", "ac-3"], malformedTokens: [] },
      ]);
    });

    it("should parse multiple @ref groups on the same line", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1, @spec-b ac-2");
      expect(groups).toEqual([
        { specRef: "@spec-a", acIds: ["ac-1"], malformedTokens: [] },
        { specRef: "@spec-b", acIds: ["ac-2"], malformedTokens: [] },
      ]);
    });

    it("should parse multiple @ref groups with multiple ACs each", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1, ac-2, @spec-b ac-3, ac-4");
      expect(groups).toEqual([
        { specRef: "@spec-a", acIds: ["ac-1", "ac-2"], malformedTokens: [] },
        { specRef: "@spec-b", acIds: ["ac-3", "ac-4"], malformedTokens: [] },
      ]);
    });

    it("should parse three @ref groups", () => {
      const groups = parseACAnnotationLine(
        "// AC: @agent-instruction-gen ac-5, @agents-cli ac-3, @agents-cli ac-4",
      );
      expect(groups).toEqual([
        { specRef: "@agent-instruction-gen", acIds: ["ac-5"], malformedTokens: [] },
        { specRef: "@agents-cli", acIds: ["ac-3"], malformedTokens: [] },
        { specRef: "@agents-cli", acIds: ["ac-4"], malformedTokens: [] },
      ]);
    });

    it("should parse @ref without AC ids", () => {
      const groups = parseACAnnotationLine("// AC: @some-spec");
      expect(groups).toEqual([{ specRef: "@some-spec", acIds: [], malformedTokens: [] }]);
    });

    // AC: @test-annotation-sweep ac-na-marker-preserved
    it("should preserve the N/A marker and reason instead of stripping them", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1 — N/A: reason why");
      expect(groups).toEqual([
        {
          specRef: "@spec-a",
          acIds: ["ac-1"],
          malformedTokens: [],
          notApplicable: true,
          naReason: "reason why",
        },
      ]);
    });

    // AC: @test-annotation-sweep ac-na-marker-preserved
    it("should preserve an N/A marker with no reason text", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1 -- N/A");
      expect(groups).toEqual([
        { specRef: "@spec-a", acIds: ["ac-1"], malformedTokens: [], notApplicable: true },
      ]);
    });

    // AC: @test-annotation-sweep ac-na-no-coverage-credit
    it("should attach an N/A marker only to the last group on a mixed line", () => {
      const groups = parseACAnnotationLine("// AC: @spec-a ac-1, @spec-b ac-2 — N/A: only b");
      expect(groups).toEqual([
        { specRef: "@spec-a", acIds: ["ac-1"], malformedTokens: [] },
        {
          specRef: "@spec-b",
          acIds: ["ac-2"],
          malformedTokens: [],
          notApplicable: true,
          naReason: "only b",
        },
      ]);
    });

    it("should strip parenthetical comments", () => {
      const groups = parseACAnnotationLine("// AC: @cli-exit-codes (exit 4 for validation errors)");
      expect(groups).toEqual([{ specRef: "@cli-exit-codes", acIds: [], malformedTokens: [] }]);
    });

    it("should return empty array for non-AC lines", () => {
      expect(parseACAnnotationLine("// just a comment")).toEqual([]);
      expect(parseACAnnotationLine("const x = 1;")).toEqual([]);
    });

    it("should ignore non-ac-prefixed tokens after a @ref", () => {
      // A bare word like "validate" after @ref is NOT an AC id
      const groups = parseACAnnotationLine("// AC: @my-spec validate");
      expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: [] }]);
    });

    it("should ignore numeric-only tokens without ac- prefix", () => {
      // "1" or "2" are not ac-prefixed, so they should be ignored
      const groups = parseACAnnotationLine("// AC: @my-spec 1");
      expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: [] }]);
    });

    it("should parse ac-prefixed named ids as explicit AC references", () => {
      const groups = parseACAnnotationLine("// AC: @my-spec ac-validate-input, ac-reject-invalid");
      expect(groups).toEqual([
        {
          specRef: "@my-spec",
          acIds: ["ac-validate-input", "ac-reject-invalid"],
          malformedTokens: [],
        },
      ]);
    });

    it("should parse ac-prefixed numeric ids as explicit AC references", () => {
      const groups = parseACAnnotationLine("// AC: @my-spec ac-1, ac-2");
      expect(groups).toEqual([
        { specRef: "@my-spec", acIds: ["ac-1", "ac-2"], malformedTokens: [] },
      ]);
    });

    it("should treat mixed tokens correctly: only ac-prefixed tokens become AC ids", () => {
      // "some-word" is not ac-prefixed, so only ac-1 should be captured
      const groups = parseACAnnotationLine("// AC: @my-spec ac-1 some-word");
      expect(groups).toEqual([{ specRef: "@my-spec", acIds: ["ac-1"], malformedTokens: [] }]);
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

  describe("not-applicable annotations are not coverage signals", () => {
    // AC: @test-annotation-sweep ac-na-marker-preserved
    it("preserves the N/A marker and reason in structured scan output", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "na.test.ts"),
        "// AC: @some-spec ac-1 — N/A: does not apply here\nit('test', () => {});",
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toMatchObject({
        specRef: "@some-spec",
        acIds: ["ac-1"],
        notApplicable: true,
        naReason: "does not apply here",
      });
    });

    // AC: @test-annotation-sweep ac-na-no-coverage-credit
    it("excludes AC ids named by an N/A annotation from the coverage set", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "na.test.ts"),
        "// AC: @some-spec ac-1, ac-2 — N/A: not applicable\nit('test', () => {});",
      );

      const covered = await scanTestCoverage(tempDir, ["tests/"]);
      expect(covered.has("@some-spec ac-1")).toBe(false);
      expect(covered.has("@some-spec ac-2")).toBe(false);
    });

    // AC: @test-annotation-sweep ac-na-no-coverage-credit
    it("credits only the coverage claim on a mixed claim/N/A line", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "mixed.test.ts"),
        "// AC: @spec-a ac-1, @spec-b ac-2 — N/A: only b is N/A\nit('test', () => {});",
      );

      const covered = await scanTestCoverage(tempDir, ["tests/"]);
      expect(covered.has("@spec-a ac-1")).toBe(true);
      expect(covered.has("@spec-b ac-2")).toBe(false);
    });

    // AC: @test-annotation-sweep ac-na-no-coverage-credit
    it("leaves an AC uncovered when its only annotation is N/A", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-feature"],
            title: "My Feature",
            type: "requirement",
            description: "A feature",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          "feature.test.ts":
            '// AC: @my-feature ac-1 — N/A: not implemented yet\nit("t", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      // The N/A annotation grants no credit, so ac-1 is reported uncovered.
      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" &&
          w.subtype === "own_ac" &&
          w.itemRef === "@my-feature",
      );
      expect(missingCoverage.length).toBeGreaterThan(0);
    });

    // AC: @test-annotation-sweep ac-na-no-invalid-finding
    it("produces no invalid-annotation finding for a well-formed N/A annotation", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-feature"],
            title: "My Feature",
            type: "requirement",
            description: "A feature",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          "feature.test.ts": '// AC: @my-feature ac-1 — N/A: covered elsewhere\nit("t", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(0);
    });

    // AC: @test-annotation-sweep ac-na-no-invalid-finding
    it("still reports integrity findings for an N/A annotation with a bad target", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-feature"],
            title: "My Feature",
            type: "requirement",
            description: "A feature",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          "bad.test.ts":
            '// AC: @nonexistent ac-1 — N/A: still resolves nowhere\nit("t", () => {});',
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

    // AC: @test-annotation-sweep ac-na-no-invalid-finding
    it("still reports a missing AC id for an N/A annotation naming an unknown criterion", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-feature"],
            title: "My Feature",
            type: "requirement",
            description: "A feature",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          "missing.test.ts": '// AC: @my-feature ac-99 — N/A: no such ac\nit("t", () => {});',
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

  describe("ac-prefixed named ids provide coverage credit", () => {
    it("should credit coverage when annotation uses ac-prefixed named id", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-feature"],
            title: "My Feature",
            type: "requirement",
            description: "A feature with named ACs",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              {
                id: "ac-validate-input",
                given: "user provides input",
                when: "validation runs",
                then: "input is validated",
              },
              {
                id: "ac-reject-invalid",
                given: "user provides invalid input",
                when: "validation runs",
                then: "input is rejected",
              },
            ],
          },
        ],
        testFiles: {
          "feature.test.ts":
            '// AC: @my-feature ac-validate-input\nit("validates input", () => {});\n' +
            '// AC: @my-feature ac-reject-invalid\nit("rejects invalid", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      // No invalid annotations
      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(0);

      // No missing coverage for this spec
      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" &&
          w.subtype === "own_ac" &&
          w.itemRef === "@my-feature",
      );
      expect(missingCoverage).toHaveLength(0);
    });

    it("should credit coverage when annotation uses ac-prefixed numeric id", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["numbered-spec"],
            title: "Numbered Spec",
            type: "requirement",
            description: "A spec with numeric ACs",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [
              { id: "ac-1", given: "g", when: "w", then: "t" },
              { id: "ac-2", given: "g2", when: "w2", then: "t2" },
            ],
          },
        ],
        testFiles: {
          "numbered.test.ts": '// AC: @numbered-spec ac-1, ac-2\nit("covers both", () => {});',
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
          w.itemRef === "@numbered-spec",
      );

      expect(invalidAnnotations).toHaveLength(0);
      expect(missingCoverage).toHaveLength(0);
    });
  });

  describe("non-prefixed tokens after @ref provide no AC coverage", () => {
    it("should not credit coverage when annotation has non-prefixed word after @ref", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec with ACs",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          // "validate" is not ac-prefixed, so this should be treated as a blanket ref
          "bad-token.test.ts": '// AC: @my-spec validate\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      // Should warn about blanket ref (non-prefixed token is ignored by parser)
      const blanketWarnings = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation" && w.subtype === "blanket_ref",
      );
      expect(blanketWarnings).toHaveLength(1);
      expect(blanketWarnings[0].message).toContain("without explicit ac-* ids");

      // ac-1 should remain uncovered
      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" && w.subtype === "own_ac" && w.itemRef === "@my-spec",
      );
      expect(missingCoverage).toHaveLength(1);
      expect(missingCoverage[0].details).toContain("ac-1");
    });

    it("should not credit coverage when annotation has numeric-only token without ac- prefix", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec with ACs",
            status: { maturity: "draft", implementation: "not_started" },
            acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
          },
        ],
        testFiles: {
          // "1" is not ac-prefixed, parser ignores it → blanket ref behavior
          "numeric-token.test.ts": '// AC: @my-spec 1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const blanketWarnings = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation" && w.subtype === "blanket_ref",
      );
      expect(blanketWarnings).toHaveLength(1);

      const missingCoverage = result.completenessWarnings.filter(
        (w) =>
          w.type === "missing_test_coverage" && w.subtype === "own_ac" && w.itemRef === "@my-spec",
      );
      expect(missingCoverage).toHaveLength(1);
    });
  });

  describe("annotation format with ac-prefixed tokens", () => {
    it("should parse annotation with mixed numeric and named ac-prefixed ids", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "mixed-ids.test.ts"),
        "// AC: @my-spec ac-1, ac-validate-input\nit('test', () => {});",
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].specRef).toBe("@my-spec");
      expect(annotations[0].acIds).toEqual(["ac-1", "ac-validate-input"]);
    });

    it("should accept ac-prefixed kebab-case ids of varying length", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "kebab-ids.test.ts"),
        "// AC: @my-spec ac-a, ac-very-long-descriptive-name\nit('test', () => {});",
      );

      const annotations = await scanACAnnotations(tempDir, ["tests/"]);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].acIds).toEqual(["ac-a", "ac-very-long-descriptive-name"]);
    });
  });
});
