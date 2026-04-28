/**
 * Behavioral tests for @ac-annotation-identifier-format and
 * @test-annotation-sweep AC coverage annotations.
 *
 * This file is NOT excluded from coverage scanning, so these AC
 * annotations count toward completeness. Tests exercise
 * parseACAnnotationLine(), validateACAnnotations(), and
 * computeACCoverage() directly with programmatic data.
 *
 * IMPORTANT: Annotation fixture strings passed to parseACAnnotationLine()
 * are constructed via string concatenation to prevent the coverage scanner
 * from misinterpreting them as real AC annotations.
 */
import { describe, it, expect } from "vitest";
import {
  parseACAnnotationLine,
  validateACAnnotations,
  computeACCoverage,
} from "../src/parser/validate.js";
import { ReferenceIndex } from "../src/parser/refs.js";

// Helper to build annotation lines without triggering the coverage scanner.
// The scanner matches lines containing "// AC:" literally, so we construct
// the prefix at runtime to avoid false positives in this source file.
const acPrefix = "//" + " AC: ";

// ---------------------------------------------------------------------------
// @ac-annotation-identifier-format ac-explicit-token-format
//
// "The acceptance criterion token is interpreted only when it uses the
//  required ac-prefixed format."
// ---------------------------------------------------------------------------

// AC: @ac-annotation-identifier-format ac-explicit-token-format
describe("ac-explicit-token-format: only ac-prefixed tokens are parsed as AC ids", () => {
  it("ignores a bare word after a @ref", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec validate");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [] }]);
  });

  it("ignores a bare numeric token after a @ref", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec 1");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [] }]);
  });

  it("parses ac-prefixed named ids as explicit AC references", () => {
    const groups = parseACAnnotationLine(
      acPrefix + "@my-spec ac-validate-input, ac-reject-invalid",
    );
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-validate-input", "ac-reject-invalid"] },
    ]);
  });

  it("parses ac-prefixed numeric ids as explicit AC references", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec ac-1, ac-2");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: ["ac-1", "ac-2"] }]);
  });

  it("captures only ac-prefixed tokens when mixed with non-prefixed tokens", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec ac-1 some-word");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: ["ac-1"] }]);
  });

  it("rejects ac-* tokens containing underscores", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec ac-bad_id");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [] }]);
  });

  it("rejects ac-* tokens with doubled hyphens", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec ac--double");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [] }]);
  });

  it("rejects ac-* tokens with trailing hyphens", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec ac-trailing-");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [] }]);
  });

  it("rejects ac-* tokens with uppercase characters", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec ac-Bad");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [] }]);
  });

  it("filters out malformed ac-* tokens while keeping valid ones", () => {
    const groups = parseACAnnotationLine(
      acPrefix + "@my-spec ac-valid, ac-bad_id, ac-also-valid",
    );
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-valid", "ac-also-valid"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// @ac-annotation-identifier-format ac-valid-token-covers-ac
//
// "The named acceptance criterion receives coverage credit from the
//  annotation."
// ---------------------------------------------------------------------------

// AC: @ac-annotation-identifier-format ac-valid-token-covers-ac
describe("ac-valid-token-covers-ac: ac-prefixed tokens earn coverage credit", () => {
  it("credits coverage for ac-prefixed named ids", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-feature"],
        title: "My Feature",
        type: "requirement" as const,
        description: "A feature with named ACs",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-validate-input", given: "g", when: "w", then: "t" },
          { id: "ac-reject-invalid", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/feature.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);
    const annotations = [
      {
        specRef: "@my-feature",
        acIds: ["ac-validate-input", "ac-reject-invalid"],
        file: "/tmp/tests/feature.test.ts",
        line: 5,
      },
    ];

    // No warnings — all AC ids are valid and ac-prefixed
    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(0);

    // Both ACs should be covered
    const coveredACs = new Set([
      "@my-feature ac-validate-input",
      "@my-feature ac-reject-invalid",
    ]);
    const coverage = computeACCoverage(items[0], coveredACs);
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-validate-input", covered: true }),
      expect.objectContaining({ id: "ac-reject-invalid", covered: true }),
    ]);
  });

  it("credits coverage for ac-prefixed numeric ids", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["numbered-spec"],
        title: "Numbered Spec",
        type: "requirement" as const,
        description: "Spec with numeric ACs",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-1", given: "g", when: "w", then: "t" },
          { id: "ac-2", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/numbered.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);
    const annotations = [
      {
        specRef: "@numbered-spec",
        acIds: ["ac-1", "ac-2"],
        file: "/tmp/tests/numbered.test.ts",
        line: 10,
      },
    ];

    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(0);

    const coveredACs = new Set(["@numbered-spec ac-1", "@numbered-spec ac-2"]);
    const coverage = computeACCoverage(items[0], coveredACs);
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-1", covered: true }),
      expect.objectContaining({ id: "ac-2", covered: true }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// @ac-annotation-identifier-format ac-bare-ref-no-token-credit
//
// "The annotation provides no acceptance-criterion coverage credit."
// ---------------------------------------------------------------------------

// AC: @ac-annotation-identifier-format ac-bare-ref-no-token-credit
describe("ac-bare-ref-no-token-credit: annotations without valid AC tokens earn no coverage", () => {
  it("a blanket ref annotation earns no AC coverage", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-spec"],
        title: "My Spec",
        type: "requirement" as const,
        description: "Spec with ACs",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-1", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/spec.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);

    // Blanket ref: names the spec but no AC ids
    const annotations = [
      {
        specRef: "@my-spec",
        acIds: [],
        file: "/tmp/tests/spec.test.ts",
        line: 3,
      },
    ];

    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subtype).toBe("blanket_ref");
    expect(warnings[0].message).toContain("without explicit ac-* ids");

    // ac-1 should remain uncovered
    const coveredACs = new Set<string>(); // nothing covered
    const coverage = computeACCoverage(items[0], coveredACs);
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-1", covered: false }),
    ]);
  });

  it("non-ac-prefixed tokens after @ref are ignored and earn no coverage", () => {
    // Parser should treat a non-prefixed word like "validate" as noise, yielding a blanket ref
    const groups = parseACAnnotationLine(acPrefix + "@my-spec validate");
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [] }]);

    // Because acIds is empty, this annotation earns zero coverage
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-spec"],
        title: "My Spec",
        type: "requirement" as const,
        description: "Spec with ACs",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-1", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/spec.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);
    const annotations = [
      { specRef: "@my-spec", acIds: groups[0].acIds, file: "/tmp/tests/spec.test.ts", line: 5 },
    ];

    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subtype).toBe("blanket_ref");
  });
});

// ---------------------------------------------------------------------------
// @test-annotation-sweep ac-annotation-format
//
// "Annotations use the ac-prefixed token format."
// ---------------------------------------------------------------------------

// AC: @test-annotation-sweep ac-annotation-format
describe("ac-annotation-format: annotation tokens use ac-prefixed format", () => {
  it("parses mixed numeric and named ac-prefixed ids correctly", () => {
    const groups = parseACAnnotationLine(acPrefix + "@my-spec ac-1, ac-validate-input");
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1", "ac-validate-input"] },
    ]);
  });

  it("accepts ac-prefixed kebab-case ids of varying length", () => {
    const groups = parseACAnnotationLine(
      acPrefix + "@my-spec ac-a, ac-very-long-descriptive-name",
    );
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-a", "ac-very-long-descriptive-name"] },
    ]);
  });

  it("computeACCoverage uses declared ac-prefixed ids for coverage status", () => {
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

// ---------------------------------------------------------------------------
// @test-annotation-sweep ac-no-blanket-credit
//
// "Blanket annotations (no explicit AC token) do not earn coverage credit."
// ---------------------------------------------------------------------------

// AC: @test-annotation-sweep ac-no-blanket-credit
describe("ac-no-blanket-credit: blanket annotations earn no coverage credit", () => {
  it("a blanket ref for an item with ACs produces a warning and no coverage", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-spec"],
        title: "My Spec",
        type: "requirement" as const,
        description: "Spec with ACs",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-1", given: "g", when: "w", then: "t" },
          { id: "ac-2", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/spec.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);
    const annotations = [
      {
        specRef: "@my-spec",
        acIds: [],
        file: "/tmp/tests/spec.test.ts",
        line: 10,
      },
    ];

    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subtype).toBe("blanket_ref");
    expect(warnings[0].message).toContain("without explicit ac-* ids");
    expect(warnings[0].message).toContain("does not count for coverage");

    // Neither AC should be covered
    const coveredACs = new Set<string>();
    const coverage = computeACCoverage(items[0], coveredACs);
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-1", covered: false }),
      expect.objectContaining({ id: "ac-2", covered: false }),
    ]);
  });
});
