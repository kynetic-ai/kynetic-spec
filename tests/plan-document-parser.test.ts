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
  detectYamlUnsafeValues,
  type PlanSpec,
} from "../src/parser/plan-document.js";
import { createSpecItem } from "../src/parser/yaml.js";

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
  implementation_notes: |
    Use existing patterns for this feature.
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
      implementation_notes: "Use existing patterns for this feature.\n",
    });
  });

  // AC: @plan-import ac-36 - Parse priority on specs
  it("should parse priority field on specs", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: High Priority Feature
  slug: high-priority
  priority: 1

- title: Low Priority Feature
  slug: low-priority
  priority: 5

- title: Default Priority Feature
  slug: default-priority
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(3);
    expect(result.specs[0].priority).toBe(1);
    expect(result.specs[1].priority).toBe(5);
    expect(result.specs[2].priority).toBeUndefined();
  });

  // AC: @plan-import ac-35 - Parse depends_on on specs
  it("should parse depends_on array on specs", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Base Feature
  slug: base-feature
  type: feature

- title: Dependent Feature
  slug: dependent-feature
  type: feature
  depends_on:
    - base-feature
    - "@external-spec"
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(2);
    expect(result.specs[0].depends_on).toBeUndefined();
    expect(result.specs[1].depends_on).toEqual(["base-feature", "@external-spec"]);
    expect(result.errors).toHaveLength(0);
  });

  // AC: @plan-import ac-35 - Parse depends_on on manual tasks
  it("should parse depends_on array on additional tasks", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Feature A
\`\`\`

## Tasks

\`\`\`yaml
- title: Manual Task
  depends_on:
    - "@task-something"
    - other-task
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.tasks.additional_tasks).toHaveLength(1);
    expect(result.tasks.additional_tasks?.[0].depends_on).toEqual([
      "@task-something",
      "other-task",
    ]);
  });

  it("should parse implementation_notes on some specs and not others", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Spec With Notes
  slug: with-notes
  implementation_notes: |
    Specific notes for this spec.

- title: Spec Without Notes
  slug: without-notes
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(2);
    expect(result.specs[0].implementation_notes).toBe("Specific notes for this spec.\n");
    expect(result.specs[1].implementation_notes).toBeUndefined();
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

describe("Plan Document Parser - missing YAML block warning", () => {
  // AC: @plan-import ac-34
  it("should warn when Specs section exists but has no YAML code block", () => {
    const plan = `
# Test Plan

## Specs

Here are the specs I want to create:
- Feature A
- Feature B

## Implementation Notes

Some notes here.
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some(e =>
      e.type === "validation" && e.message.includes("no YAML code block")
    )).toBe(true);
  });

  it("should not warn when Specs section has a YAML code block", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Feature A
  slug: feature-a
  type: feature
  description: A feature
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.errors.filter(e =>
      e.type === "validation" && e.message.includes("no YAML code block")
    )).toHaveLength(0);
  });

  it("should not warn when there is no Specs section at all", () => {
    const plan = `
# Test Plan

## Implementation Notes

Just some notes, no specs section.
`;

    const result = parsePlanDocument(plan);

    expect(result.errors.filter(e =>
      e.message.includes("no YAML code block")
    )).toHaveLength(0);
  });
});

describe("createSpecItem", () => {
  // AC: @parser-write-type-safety ac-2
  it("should preserve acceptance_criteria when provided", () => {
    const ac = [
      { id: "ac-1", given: "precondition", when: "action", then: "result" },
    ];
    const item = createSpecItem({
      title: "Test Feature",
      type: "feature",
      slugs: ["test-feature"],
      acceptance_criteria: ac,
    });

    expect(item.acceptance_criteria).toEqual(ac);
  });

  it("should leave acceptance_criteria undefined when not provided", () => {
    const item = createSpecItem({
      title: "Test Feature",
      type: "feature",
      slugs: ["test-feature"],
    });

    expect(item.acceptance_criteria).toBeUndefined();
  });

  // AC: @parser-write-type-safety ac-1
  it("should reject invalid spec item input before creating the item", () => {
    expect(() =>
      createSpecItem({
        title: "Invalid Feature",
        type: "invalid" as never,
        slugs: ["invalid-feature"],
      }),
    ).toThrowError(/Invalid spec item input: type="invalid"/);
  });
});

describe("PlanSpecSchema type validation", () => {
  // AC: @parser-write-type-safety ac-3
  it("should fail when a plan spec uses an invalid item type", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Invalid Spec
  slug: invalid-spec
  type: invalid
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.type).toBe("validation");
    expect(result.errors[0]?.message).toContain("Spec at index 0 validation failed");
    expect(result.errors[0]?.message).toContain("Invalid enum value");
    expect(result.errors[0]?.message).toContain('"feature"');
  });
});

describe("detectYamlUnsafeValues", () => {
  it("should detect unquoted colons in then field", () => {
    const yaml = `
- title: Test
  acceptance_criteria:
    - id: ac-1
      given: Something
      when: Something else
      then: User sees error: something bad`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].field).toBe("then");
    expect(diagnostics[0].value).toContain("User sees error:");
    expect(diagnostics[0].line).toBe(7);
  });

  it("should detect unquoted colons in given and when fields", () => {
    const yaml = `
    - id: ac-1
      given: State: user is logged in
      when: Action: submit form
      then: Result`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].field).toBe("given");
    expect(diagnostics[1].field).toBe("when");
  });

  it("should detect unquoted colons in description field", () => {
    const yaml = `
- title: Test
  description: Note: this is important`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].field).toBe("description");
  });

  it("should skip already-quoted values", () => {
    const yaml = `
    - id: ac-1
      given: "State: user is logged in"
      when: 'Action: submit form'
      then: Result`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(0);
  });

  it("should skip block scalar indicators", () => {
    const yaml = `
    - id: ac-1
      given: |
        State: user is logged in
      when: >
        Action: submit form
      then: Result`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(0);
  });

  it("should not flag values without colon-space pattern", () => {
    const yaml = `
    - id: ac-1
      given: Something with a URL http://example.com
      when: User clicks submit
      then: Success message appears`;

    // http://example.com has colon but not "colon space" after the key-value split
    // Actually http: does have colon-space... let me check
    const diagnostics = detectYamlUnsafeValues(yaml);

    // "Something with a URL http://example.com" — "http:" has colon followed by //
    // not "colon space" so should not be flagged
    expect(diagnostics).toHaveLength(0);
  });

  it("should return empty for clean YAML", () => {
    const yaml = `
- title: Feature A
  slug: feature-a
  acceptance_criteria:
    - id: ac-1
      given: User is on login page
      when: User enters valid credentials
      then: User is redirected to dashboard`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(0);
  });

  it("should truncate long values in diagnostic", () => {
    const longValue = "This is a very long error message that goes on and on and on: with a colon somewhere in it";
    const yaml = `      then: ${longValue}`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].value.length).toBeLessThanOrEqual(60);
    expect(diagnostics[0].value).toMatch(/\.\.\.$/);
  });

  it("should detect unquoted colons in title with list marker prefix", () => {
    const yaml = `
- title: Error: invalid input format
  slug: error-handling`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].field).toBe("title");
    expect(diagnostics[0].value).toContain("Error:");
  });

  it("should detect multiple unsafe values in same spec", () => {
    const yaml = `
- title: Test
  acceptance_criteria:
    - id: ac-1
      given: Precondition
      when: Action
      then: Error: bad input
    - id: ac-2
      given: State: logged in
      when: Submit
      then: Warning: data loss`;

    const diagnostics = detectYamlUnsafeValues(yaml);

    expect(diagnostics).toHaveLength(3);
  });
});

describe("parsePlanDocument - YAML-unsafe diagnostics", () => {
  it("should include diagnostic hints when YAML parse fails due to unquoted colons", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Input Validation
  acceptance_criteria:
    - id: ac-1
      given: User enters data
      when: Form is submitted
      then: User sees error: Invalid input
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe("yaml");
    expect(result.errors[0].message).toContain("Hint:");
    expect(result.errors[0].message).toContain("then");
    expect(result.errors[0].message).toContain("unquoted colon");
    expect(result.errors[0].message).toContain("block scalars");
  });

  it("should not include hints when YAML fails for non-colon reasons", () => {
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
    expect(result.errors[0].message).not.toContain("Hint:");
  });

  it("should parse successfully when block scalars are used for colon values", () => {
    const plan = `
# Test Plan

## Specs

\`\`\`yaml
- title: Input Validation
  acceptance_criteria:
    - id: ac-1
      given: User enters data
      when: Form is submitted
      then: |
        User sees error: Invalid input
\`\`\`
`;

    const result = parsePlanDocument(plan);

    expect(result.specs).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.specs[0].acceptance_criteria?.[0].then).toContain("User sees error: Invalid input");
  });
});
