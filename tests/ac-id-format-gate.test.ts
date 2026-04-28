/**
 * Gate verification tests for AC id format enforcement.
 *
 * These tests verify the integration of AC id format enforcement across
 * schema validation, CLI commands, annotation parsing, and completeness
 * validation. They exercise the end-to-end pipeline to confirm that the
 * ac-prefixed kebab-case format is consistently enforced.
 *
 * This file is NOT excluded from coverage scanning.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acIdPattern, AcIdSchema, AcceptanceCriterionSchema } from "../src/schema/index.js";
import { parseACAnnotationLine, validateACAnnotations, computeACCoverage } from "../src/parser/validate.js";
import { ReferenceIndex } from "../src/parser/refs.js";
import { kspec, kspecJson, setupTempFixtures, cleanupTempDir } from "./helpers/cli.js";

// Helper to build annotation lines without triggering the coverage scanner.
const acPrefix = "//" + " AC: ";

// ---------------------------------------------------------------------------
// @acceptance-criterion-id-format — End-to-end gate verification
// ---------------------------------------------------------------------------

// AC: @acceptance-criterion-id-format ac-stored-id-format
describe("Gate: stored AC ids conform to ac-prefixed format", () => {
  it("schema enforces ac-prefixed format on AcceptanceCriterionSchema", () => {
    // Valid: ac-prefixed ids pass schema
    const valid = AcceptanceCriterionSchema.safeParse({
      id: "ac-stored-id-format",
      given: "condition",
      when: "action",
      then: "result",
    });
    expect(valid.success).toBe(true);

    // Invalid: non-prefixed ids fail schema
    const invalid = AcceptanceCriterionSchema.safeParse({
      id: "stored-id-format",
      given: "condition",
      when: "action",
      then: "result",
    });
    expect(invalid.success).toBe(false);
  });

  it("acIdPattern matches the same format the schema enforces", () => {
    // Verify the regex and Zod schema agree
    expect(acIdPattern.test("ac-1")).toBe(true);
    expect(acIdPattern.test("ac-stored-id-format")).toBe(true);
    expect(acIdPattern.test("stored-id-format")).toBe(false);
    expect(acIdPattern.test("1")).toBe(false);
    expect(acIdPattern.test("")).toBe(false);
  });
});

// AC: @acceptance-criterion-id-format ac-invalid-stored-id-reported
describe("Gate: schema reports invalid persisted AC ids", () => {
  it("AcIdSchema rejects all non-prefixed variants", () => {
    const invalid = [
      "my-criterion",     // no ac- prefix
      "1",                // bare number
      "",                 // empty
      "ac-",              // prefix only, no suffix
      "AC-1",             // uppercase prefix
      "ac--double",       // double hyphen
      "ac-trailing-",     // trailing hyphen
    ];
    for (const id of invalid) {
      const result = AcIdSchema.safeParse(id);
      expect(result.success, `Expected "${id}" to be rejected`).toBe(false);
    }
  });

  it("AcIdSchema error message identifies the required format", () => {
    const result = AcIdSchema.safeParse("bad-id");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).toContain("ac-prefixed kebab-case");
    }
  });
});

// AC: @acceptance-criterion-id-format ac-create-rejects-invalid-id
describe("Gate: CLI rejects invalid AC id on create", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    kspec(
      'item add --under @test-core --title "Gate Test Item" --slug gate-test-item',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("item ac add --id rejects non-prefixed id and does not mutate", () => {
    const result = kspec(
      'item ac add @gate-test-item --id "no-prefix" --given "g" --when "w" --then "t"',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ac-prefixed kebab-case");

    // Verify no mutation occurred
    const item = kspecJson<{ acceptance_criteria?: unknown[] }>(
      "item get @gate-test-item",
      tempDir,
    );
    expect(item.acceptance_criteria ?? []).toHaveLength(0);
  });
});

// AC: @acceptance-criterion-id-format ac-rename-rejects-invalid-id
describe("Gate: CLI rejects invalid AC id on rename", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    kspec(
      'item add --under @test-core --title "Gate Rename Item" --slug gate-rename-item',
      tempDir,
    );
    kspec(
      'item ac add @gate-rename-item --id "ac-original" --given "g" --when "w" --then "t"',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("item ac set --id rejects non-prefixed rename and preserves original", () => {
    const result = kspec(
      'item ac set @gate-rename-item ac-original --id "not-valid"',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ac-prefixed kebab-case");

    // Original id preserved
    const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
      "item get @gate-rename-item",
      tempDir,
    );
    expect(item.acceptance_criteria[0].id).toBe("ac-original");
  });
});

// AC: @acceptance-criterion-id-format ac-generated-ids-conform
describe("Gate: auto-generated AC ids conform", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
    kspec(
      'item add --under @test-core --title "Gate Gen Item" --slug gate-gen-item',
      tempDir,
    );
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it("generated ids match acIdPattern", () => {
    kspec(
      'item ac add @gate-gen-item --given "g1" --when "w1" --then "t1"',
      tempDir,
    );
    kspec(
      'item ac add @gate-gen-item --given "g2" --when "w2" --then "t2"',
      tempDir,
    );
    const item = kspecJson<{ acceptance_criteria: Array<{ id: string }> }>(
      "item get @gate-gen-item",
      tempDir,
    );
    expect(item.acceptance_criteria).toHaveLength(2);
    for (const ac of item.acceptance_criteria) {
      expect(acIdPattern.test(ac.id), `Expected "${ac.id}" to match acIdPattern`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// @ac-annotation-identifier-format — Gate verification
// ---------------------------------------------------------------------------

// AC: @ac-annotation-identifier-format ac-explicit-token-format
describe("Gate: annotation parser only interprets ac-prefixed tokens", () => {
  it("non-prefixed tokens after @ref are not treated as AC ids", () => {
    const groups = parseACAnnotationLine(acPrefix + "@spec validate create");
    expect(groups).toEqual([{ specRef: "@spec", acIds: [] }]);
  });

  it("ac-prefixed tokens are captured as AC ids", () => {
    const groups = parseACAnnotationLine(acPrefix + "@spec ac-validate, ac-create");
    expect(groups).toEqual([{ specRef: "@spec", acIds: ["ac-validate", "ac-create"] }]);
  });
});

// AC: @ac-annotation-identifier-format ac-valid-token-covers-ac
describe("Gate: ac-prefixed annotation tokens earn coverage credit", () => {
  it("valid ac-prefixed token earns coverage in computeACCoverage", () => {
    const coverage = computeACCoverage(
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["gate-spec"],
        acceptance_criteria: [
          { id: "ac-create", given: "g", when: "w", then: "t" },
          { id: "ac-delete", given: "g", when: "w", then: "t" },
        ],
      },
      new Set(["@gate-spec ac-create"]),
    );

    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-create", covered: true }),
      expect.objectContaining({ id: "ac-delete", covered: false }),
    ]);
  });

  it("valid ac-prefixed annotation produces no warnings in validateACAnnotations", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["gate-spec"],
        title: "Gate Spec",
        type: "requirement" as const,
        description: "test",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
        _sourceFile: "modules/gate.yaml",
      },
    ];
    const index = new ReferenceIndex([], items);
    const annotations = [
      { specRef: "@gate-spec", acIds: ["ac-1"], file: "/tmp/test.ts", line: 1 },
    ];

    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(0);
  });
});

// AC: @ac-annotation-identifier-format ac-bare-ref-no-token-credit
describe("Gate: bare ref without ac-prefixed tokens earns no coverage", () => {
  it("annotation without AC ids produces blanket_ref warning", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["gate-spec"],
        title: "Gate Spec",
        type: "requirement" as const,
        description: "test",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
        _sourceFile: "modules/gate.yaml",
      },
    ];
    const index = new ReferenceIndex([], items);
    const annotations = [
      { specRef: "@gate-spec", acIds: [], file: "/tmp/test.ts", line: 1 },
    ];

    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subtype).toBe("blanket_ref");
  });

  it("bare ref annotation leaves ACs uncovered", () => {
    const coverage = computeACCoverage(
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["gate-spec"],
        acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
      },
      new Set<string>(),
    );
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-1", covered: false }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// @ac-annotation-integrity-reporting — Gate verification
// ---------------------------------------------------------------------------

// AC: @ac-annotation-integrity-reporting ac-valid-annotation-covers-target
describe("Gate: valid annotation covers target", () => {
  it("annotation with valid spec ref and AC id produces no warnings and earns coverage", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["gate-integrity"],
        title: "Gate Integrity",
        type: "requirement" as const,
        description: "test",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-validate", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/gate.yaml",
      },
    ];
    const index = new ReferenceIndex([], items);
    const annotations = [
      { specRef: "@gate-integrity", acIds: ["ac-validate"], file: "/tmp/test.ts", line: 1 },
    ];

    // No warnings
    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(0);

    // Coverage earned
    const coverage = computeACCoverage(items[0], new Set(["@gate-integrity ac-validate"]));
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-validate", covered: true }),
    ]);
  });
});

// AC: @ac-annotation-integrity-reporting ac-blanket-ref-does-not-cover
describe("Gate: blanket ref does not cover", () => {
  it("annotation naming spec without AC ids produces blanket_ref warning and no coverage", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["gate-blanket"],
        title: "Gate Blanket",
        type: "requirement" as const,
        description: "test",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [
          { id: "ac-1", given: "g", when: "w", then: "t" },
          { id: "ac-2", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/gate.yaml",
      },
    ];
    const index = new ReferenceIndex([], items);
    const annotations = [
      { specRef: "@gate-blanket", acIds: [], file: "/tmp/test.ts", line: 1 },
    ];

    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subtype).toBe("blanket_ref");
    expect(warnings[0].message).toContain("without explicit ac-* ids");

    // Neither AC covered
    const coverage = computeACCoverage(items[0], new Set<string>());
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-1", covered: false }),
      expect.objectContaining({ id: "ac-2", covered: false }),
    ]);
  });
});
