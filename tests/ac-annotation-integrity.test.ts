/**
 * Behavioral tests for @ac-annotation-integrity-reporting.
 *
 * These tests exercise validateACAnnotations() and computeACCoverage()
 * directly with programmatic data (no inline AC annotation strings that
 * would confuse the coverage scanner). This file is NOT excluded from
 * coverage scanning, so these AC annotations count.
 *
 * The integration-level tests in ac-annotation-validation.test.ts cover
 * the same behavior via validate() with full project setup, but that
 * file is excluded from scanning because it contains fixture strings
 * with AC annotation patterns.
 */
import { describe, it, expect } from "vitest";
import {
  validateACAnnotations,
  computeACCoverage,
} from "../src/parser/validate.js";
import { ReferenceIndex } from "../src/parser/refs.js";

describe("AC annotation integrity reporting", () => {
  // AC: @ac-annotation-integrity-reporting ac-unresolved-target-reported
  it("reports an invalid-annotation finding when target reference cannot be resolved", () => {
    const annotations = [
      {
        specRef: "@nonexistent-spec",
        acIds: ["ac-1"],
        file: "/tmp/tests/example.test.ts",
        line: 10,
      },
    ];

    const index = new ReferenceIndex([], []);
    const warnings = validateACAnnotations(annotations, [], index);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("invalid_ac_annotation");
    expect(warnings[0].subtype).toBe("unresolved_target");
    expect(warnings[0].itemRef).toBe("@nonexistent-spec");
    expect(warnings[0].message).toContain("cannot be resolved");
    expect(warnings[0].details).toContain("example.test.ts:10");
  });

  // AC: @ac-annotation-integrity-reporting ac-non-spec-target-reported
  it("reports an invalid-annotation finding when target resolves to a non-spec entity", () => {
    const tasks = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG91A",
        slugs: ["task-my-work"],
        title: "My Work Task",
        status: "pending" as const,
        priority: 3,
        _sourceFile: "project.tasks.yaml",
      },
    ];

    const index = new ReferenceIndex(tasks as any, []);
    const annotations = [
      {
        specRef: "@task-my-work",
        acIds: ["ac-1"],
        file: "/tmp/tests/example.test.ts",
        line: 5,
      },
    ];

    const warnings = validateACAnnotations(annotations, [], index);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("invalid_ac_annotation");
    expect(warnings[0].subtype).toBe("non_spec_target");
    expect(warnings[0].message).toContain("@task-my-work");
    expect(warnings[0].message).toContain("not a spec item or trait");
    expect(warnings[0].details).toContain("example.test.ts:5");
  });

  // AC: @ac-annotation-integrity-reporting ac-missing-ac-id-reported
  it("reports an invalid-annotation finding when AC id does not exist on resolved item", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-feature"],
        title: "My Feature",
        type: "requirement" as const,
        description: "A feature spec",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
        _sourceFile: "modules/feature.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);
    const annotations = [
      {
        specRef: "@my-feature",
        acIds: ["ac-1", "ac-nonexistent"],
        file: "/tmp/tests/feature.test.ts",
        line: 15,
      },
    ];

    const warnings = validateACAnnotations(annotations, items, index);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("invalid_ac_annotation");
    expect(warnings[0].subtype).toBe("missing_ac_id");
    expect(warnings[0].message).toContain("ac-nonexistent");
    expect(warnings[0].message).toContain("no acceptance criterion");
    expect(warnings[0].details).toContain("feature.test.ts:15");
  });

  // AC: @ac-annotation-integrity-reporting ac-blanket-ref-does-not-cover
  it("does not count a blanket annotation (no ac ids) as coverage for an item with ACs", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-feature"],
        title: "My Feature",
        type: "requirement" as const,
        description: "A feature spec",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-1", given: "g", when: "w", then: "t" },
          { id: "ac-2", given: "g2", when: "w2", then: "t2" },
        ],
        _sourceFile: "modules/feature.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);

    // Blanket annotation: names the spec but no specific AC ids
    const annotations = [
      {
        specRef: "@my-feature",
        acIds: [],
        file: "/tmp/tests/feature.test.ts",
        line: 3,
      },
    ];

    const warnings = validateACAnnotations(annotations, items, index);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe("invalid_ac_annotation");
    expect(warnings[0].subtype).toBe("blanket_ref");
    expect(warnings[0].message).toContain("without explicit ac-* ids");
    expect(warnings[0].message).toContain("does not count for coverage");
  });

  // AC: @ac-annotation-integrity-reporting ac-valid-annotation-covers-target
  it("treats a valid annotation naming an existing spec AC as covered", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-feature"],
        title: "My Feature",
        type: "requirement" as const,
        description: "A feature spec",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-1", given: "g", when: "w", then: "t" },
          { id: "ac-2", given: "g2", when: "w2", then: "t2" },
        ],
        _sourceFile: "modules/feature.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);

    // Valid annotation with specific AC id
    const annotations = [
      {
        specRef: "@my-feature",
        acIds: ["ac-1"],
        file: "/tmp/tests/feature.test.ts",
        line: 5,
      },
    ];

    // No warnings — annotation is valid
    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(0);

    // Verify coverage: ac-1 should be covered, ac-2 should not
    const coveredACs = new Set(["@my-feature ac-1"]);
    const coverage = computeACCoverage(items[0], coveredACs);

    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-1", covered: true }),
      expect.objectContaining({ id: "ac-2", covered: false }),
    ]);
  });
});
