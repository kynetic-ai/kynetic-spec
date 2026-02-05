/**
 * Tests for plan document parser
 *
 * AC: @plan-import ac-11 - Parse ## Specs YAML blocks
 * AC: @plan-import ac-12 - Support derive_from_specs flag
 * AC: @plan-import ac-13 - Extract ## Implementation Notes
 * AC: @plan-import ac-16 - Topological ordering
 * AC: @plan-import ac-17 - Detect missing parent references
 * AC: @plan-import ac-18 - Detect circular dependencies
 * AC: @plan-import ac-21 - Handle YAML parse errors
 * AC: @plan-import ac-22 - Validate required fields
 */

import { describe, expect, it } from "vitest";
import {
  parsePlanDocument,
  topologicalSort,
  validateParentRefs,
  type PlanSpec,
} from "../src/parser/plan-document.js";

describe("Plan Document Parser", () => {
  // AC: @plan-import ac-11
  it("should parse specs from ## Specs YAML block", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: JSON Output Mode
  slug: json-output
  type: feature
  description: Add JSON output support

- title: CLI Traits
  slug: cli-traits
  type: requirement
  description: Common CLI behaviors
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(2);
    expect(result.specs[0]).toMatchObject({
      title: "JSON Output Mode",
      slug: "json-output",
      type: "feature",
      description: "Add JSON output support",
    });
    expect(result.specs[1]).toMatchObject({
      title: "CLI Traits",
      slug: "cli-traits",
      type: "requirement",
    });
    expect(result.errors).toHaveLength(0);
  });

  // AC: @plan-import ac-12
  it("should parse derive_from_specs flag from ## Tasks section", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Feature A
\`\`\`

## Tasks

derive_from_specs: true
`;

    const result = parsePlanDocument(plan);

    expect(result.tasks.derive_from_specs).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // AC: @plan-import ac-13
  it("should extract ## Implementation Notes section", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Feature A
\`\`\`

## Implementation Notes

Use existing patterns.
Add comprehensive tests.
`;

    const result = parsePlanDocument(plan);

    expect(result.implementationNotes).toBe(
      "Use existing patterns.\nAdd comprehensive tests.",
    );
  });

  // AC: @plan-import ac-21
  it("should handle malformed YAML in Specs section", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Feature A
  invalid yaml: [unclosed
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("yaml");
    expect(result.errors[0].message).toContain("Malformed YAML");
  });

  // AC: @plan-import ac-22
  it("should validate required title field in specs", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- slug: missing-title
  type: feature

- title: Valid Spec
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0].title).toBe("Valid Spec");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("validation");
    expect(result.errors[0].message).toContain("missing required field: title");
    expect(result.errors[0].specIndex).toBe(0);
  });

  it("should handle empty plan documents", () => {
    const plan = `# Empty Plan`;

    const result = parsePlanDocument(plan);

    expect(result.title).toBe("Empty Plan");
    expect(result.specs).toHaveLength(0);
    expect(result.tasks).toEqual({});
    expect(result.implementationNotes).toBeNull();
    expect(result.errors).toHaveLength(0);
  });

  it("should handle plan without title", () => {
    const plan = `No heading here`;

    const result = parsePlanDocument(plan);

    expect(result.title).toBe("Untitled Plan");
  });

  it("should parse additional tasks from Tasks section", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Feature A
\`\`\`

## Tasks

derive_from_specs: true

\`\`\`yaml
- title: Manual Task 1
  priority: 1
  tags: [manual, testing]

- title: Manual Task 2
  priority: 2
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.tasks.derive_from_specs).toBe(true);
    expect(result.tasks.additional_tasks).toHaveLength(2);
    expect(result.tasks.additional_tasks?.[0]).toMatchObject({
      title: "Manual Task 1",
      priority: 1,
      tags: ["manual", "testing"],
    });
  });

  it("should handle specs with all optional fields", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Full Spec
  slug: full-spec
  type: feature
  parent: "@parent-spec"
  description: Full description
  acceptance_criteria:
    - id: ac-1
      given: condition
      when: action
      then: result
  traits:
    - "@json-output"
    - "@dry-run"
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(1);
    expect(result.specs[0]).toMatchObject({
      title: "Full Spec",
      slug: "full-spec",
      type: "feature",
      parent: "@parent-spec",
      description: "Full description",
      acceptance_criteria: [
        {
          id: "ac-1",
          given: "condition",
          when: "action",
          then: "result",
        },
      ],
      traits: ["@json-output", "@dry-run"],
    });
  });
});

describe("Topological Sort", () => {
  // AC: @plan-import ac-16
  it("should sort specs in topological order (parents before children)", () => {
    const specs: PlanSpec[] = [
      { title: "Child", slug: "child", parent: "@parent" },
      { title: "Parent", slug: "parent" },
      { title: "Grandchild", slug: "grandchild", parent: "@child" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).toBeNull();
    expect(result.sorted).toHaveLength(3);
    expect(result.sorted[0].slug).toBe("parent");
    expect(result.sorted[1].slug).toBe("child");
    expect(result.sorted[2].slug).toBe("grandchild");
  });

  // AC: @plan-import ac-18
  it("should detect circular parent references", () => {
    const specs: PlanSpec[] = [
      { title: "Spec A", slug: "spec-a", parent: "@spec-b" },
      { title: "Spec B", slug: "spec-b", parent: "@spec-a" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).not.toBeNull();
    expect(result.error?.type).toBe("circular");
    expect(result.error?.message).toContain("Circular parent reference");
    expect(result.error?.message).toContain("@spec-a");
    expect(result.error?.message).toContain("@spec-b");
  });

  it("should handle specs without parents", () => {
    const specs: PlanSpec[] = [
      { title: "Spec 1", slug: "spec-1" },
      { title: "Spec 2", slug: "spec-2" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).toBeNull();
    expect(result.sorted).toHaveLength(2);
  });

  it("should ignore external parent references", () => {
    const specs: PlanSpec[] = [
      { title: "Child", slug: "child", parent: "@external-parent" },
      { title: "Sibling", slug: "sibling" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).toBeNull();
    expect(result.sorted).toHaveLength(2);
  });

  it("should handle parent ref with or without @ prefix", () => {
    const specs: PlanSpec[] = [
      { title: "Child 1", slug: "child-1", parent: "@parent" },
      { title: "Child 2", slug: "child-2", parent: "parent" },
      { title: "Parent", slug: "parent" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).toBeNull();
    expect(result.sorted[0].slug).toBe("parent");
  });

  it("should handle complex dependency graph", () => {
    const specs: PlanSpec[] = [
      { title: "D", slug: "d", parent: "@b" },
      { title: "B", slug: "b", parent: "@a" },
      { title: "A", slug: "a" },
      { title: "C", slug: "c", parent: "@a" },
      { title: "E", slug: "e" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).toBeNull();
    expect(result.sorted).toHaveLength(5);

    // A must come before B, C, D
    const aIndex = result.sorted.findIndex(s => s.slug === "a");
    const bIndex = result.sorted.findIndex(s => s.slug === "b");
    const cIndex = result.sorted.findIndex(s => s.slug === "c");
    const dIndex = result.sorted.findIndex(s => s.slug === "d");

    expect(aIndex).toBeLessThan(bIndex);
    expect(aIndex).toBeLessThan(cIndex);
    expect(bIndex).toBeLessThan(dIndex);
  });

  it("should detect three-way circular dependency", () => {
    const specs: PlanSpec[] = [
      { title: "A", slug: "a", parent: "@b" },
      { title: "B", slug: "b", parent: "@c" },
      { title: "C", slug: "c", parent: "@a" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).not.toBeNull();
    expect(result.error?.type).toBe("circular");
    expect(result.error?.message).toContain("Circular parent reference");
  });

  it("should auto-generate slugs from titles when missing", () => {
    const specs: PlanSpec[] = [
      { title: "Child Spec", parent: "@parent-spec" },
      { title: "Parent Spec" },
    ];

    const result = topologicalSort(specs);

    expect(result.error).toBeNull();
    expect(result.sorted[0].title).toBe("Parent Spec");
    expect(result.sorted[1].title).toBe("Child Spec");
  });
});

describe("Parent Reference Validation", () => {
  // AC: @plan-import ac-17
  it("should detect missing parent references", () => {
    const specs: PlanSpec[] = [
      { title: "Child", slug: "child", parent: "@nonexistent" },
    ];

    const existingRefs = new Set<string>();

    const errors = validateParentRefs(specs, existingRefs);

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("dependency");
    expect(errors[0].message).toContain("Parent @nonexistent not found");
    expect(errors[0].spec).toBe(specs[0]);
  });

  // AC: @plan-import ac-33
  it("should provide recovery hint for missing parents", () => {
    const specs: PlanSpec[] = [
      { title: "Child", slug: "child", parent: "@missing" },
    ];

    const errors = validateParentRefs(specs, new Set());

    expect(errors[0].message).toContain(
      "Check parent exists or define it earlier in plan",
    );
  });

  it("should allow parent refs to specs within the plan", () => {
    const specs: PlanSpec[] = [
      { title: "Child", slug: "child", parent: "@parent" },
      { title: "Parent", slug: "parent" },
    ];

    const errors = validateParentRefs(specs, new Set());

    expect(errors).toHaveLength(0);
  });

  it("should allow parent refs to existing project specs", () => {
    const specs: PlanSpec[] = [
      { title: "Child", slug: "child", parent: "@existing-parent" },
    ];

    const existingRefs = new Set(["existing-parent"]);

    const errors = validateParentRefs(specs, existingRefs);

    expect(errors).toHaveLength(0);
  });

  it("should handle parent refs with or without @ prefix", () => {
    const specs: PlanSpec[] = [
      { title: "Child", slug: "child", parent: "parent" },
      { title: "Parent", slug: "parent" },
    ];

    const errors = validateParentRefs(specs, new Set());

    expect(errors).toHaveLength(0);
  });

  it("should validate multiple specs with mixed valid/invalid parents", () => {
    const specs: PlanSpec[] = [
      { title: "Valid Child", slug: "valid", parent: "@parent" },
      { title: "Invalid Child", slug: "invalid", parent: "@nonexistent" },
      { title: "Parent", slug: "parent" },
    ];

    const errors = validateParentRefs(specs, new Set());

    expect(errors).toHaveLength(1);
    expect(errors[0].spec?.slug).toBe("invalid");
  });
});
