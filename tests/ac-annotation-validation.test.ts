/**
 * Tests for AC annotation validation in test files.
 *
 * AC: @ref-validation ac-1, ac-2, ac-3, ac-4
 *
 * Validates that // AC: @slug ac-N comments reference real spec items/traits
 * and that ac-N exists on the referenced item.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  validate,
  scanACAnnotations,
  validateACAnnotations,
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
  }) {
    const specDir = path.join(tempDir, "spec");
    const modulesDir = path.join(specDir, "modules");
    const testsDir = path.join(tempDir, "tests");
    await fs.mkdir(modulesDir, { recursive: true });
    await fs.mkdir(testsDir, { recursive: true });

    // Create manifest
    await writeYamlFilePreserveFormat(path.join(specDir, "kynetic.yaml"), {
      project: { name: "test-project" },
      includes: ["modules/specs.yaml"],
    });

    // Write spec items
    await writeYamlFilePreserveFormat(
      path.join(modulesDir, "specs.yaml"),
      opts.specItems,
    );

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

      const annotations = await scanACAnnotations(tempDir);

      expect(annotations).toHaveLength(2);

      expect(annotations[0].specRef).toBe("@my-spec");
      expect(annotations[0].acIds).toEqual(["ac-1"]);
      expect(annotations[0].file).toContain("example.test.ts");
      expect(annotations[0].line).toBe(3);

      expect(annotations[1].specRef).toBe("@my-spec");
      expect(annotations[1].acIds).toEqual(["ac-2", "ac-3"]);
      expect(annotations[1].line).toBe(6);
    });

    it("should scan both tests/ and E2E directories", async () => {
      const testsDir = path.join(tempDir, "tests");
      const e2eDir = path.join(
        tempDir,
        "packages",
        "web-ui",
        "tests",
        "e2e",
      );
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

      const annotations = await scanACAnnotations(tempDir);
      expect(annotations).toHaveLength(2);

      const refs = annotations.map((a) => `${a.specRef} ${a.acIds[0]}`);
      expect(refs).toContain("@spec-a ac-1");
      expect(refs).toContain("@spec-b ac-2");
    });

    it("should handle annotations without specific AC ids", async () => {
      const testsDir = path.join(tempDir, "tests");
      await fs.mkdir(testsDir, { recursive: true });

      await fs.writeFile(
        path.join(testsDir, "generic.test.ts"),
        "// AC: @some-spec\nit('test', () => {});",
      );

      const annotations = await scanACAnnotations(tempDir);
      expect(annotations).toHaveLength(1);
      expect(annotations[0].specRef).toBe("@some-spec");
      expect(annotations[0].acIds).toEqual([]);
    });

    it("should return empty array when no test directories exist", async () => {
      const annotations = await scanACAnnotations(tempDir);
      expect(annotations).toEqual([]);
    });
  });

  // AC: @ref-validation ac-2
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
          "example.test.ts":
            '// AC: @nonexistent-spec ac-1\nit("test", () => {});',
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
          "example.test.ts":
            '// AC: @real-spec ac-1\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(0);
    });
  });

  // AC: @ref-validation ac-3
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
          "example.test.ts":
            '// AC: @my-spec ac-5\nit("test", () => {});',
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
          "example.test.ts":
            '// AC: @my-spec ac-1, ac-2, ac-3\nit("test", () => {});',
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
          "example.test.ts":
            '// AC: @my-spec ac-1, ac-2\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      expect(invalidAnnotations).toHaveLength(0);
    });
  });

  // AC: @ref-validation ac-4
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
    it("should skip AC existence check for annotations without specific AC ids", async () => {
      const ctx = await setupProject({
        specItems: [
          {
            _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
            slugs: ["my-spec"],
            title: "My Spec",
            type: "requirement",
            description: "A spec with no ACs",
            status: { maturity: "draft", implementation: "not_started" },
          },
        ],
        testFiles: {
          "example.test.ts":
            '// AC: @my-spec\nit("test", () => {});',
        },
      });

      const result = await validate(ctx, { completeness: true });

      const invalidAnnotations = result.completenessWarnings.filter(
        (w) => w.type === "invalid_ac_annotation",
      );
      // No specific AC referenced, so no invalid annotation warning
      expect(invalidAnnotations).toHaveLength(0);
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
          "example.test.ts":
            '// AC: @no-ac-spec ac-1\nit("test", () => {});',
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
          "my-feature.test.ts":
            '// AC: @bogus-ref ac-1\nit("test", () => {});',
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
          acceptance_criteria: [
            { id: "ac-1", given: "g", when: "w", then: "t" },
          ],
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
  });
});
