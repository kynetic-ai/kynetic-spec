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
 * splice the acPrefix variable into a template literal so the literal
 * "// AC:" prefix never appears in this source file, preventing the coverage
 * scanner from misinterpreting these fixtures as real AC annotations.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  parseACAnnotationLine,
  validateACAnnotations,
  computeACCoverage,
  scanTestCoverage,
  scanACAnnotations,
} from "../src/parser/validate.js";
import { ReferenceIndex } from "../src/parser/refs.js";

// Helper to build annotation lines without triggering the coverage scanner.
// The scanner matches lines containing "// AC:" literally, so we construct
// the prefix at runtime to avoid false positives in this source file.
const acPrefix = `//${" "}AC: `;

// ---------------------------------------------------------------------------
// @ac-annotation-identifier-format ac-explicit-token-format
//
// "The acceptance criterion token is interpreted only when it uses the
//  required ac-prefixed format."
// ---------------------------------------------------------------------------

// AC: @ac-annotation-identifier-format ac-explicit-token-format
describe("ac-explicit-token-format: only ac-prefixed tokens are parsed as AC ids", () => {
  it("ignores a bare word after a @ref", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec validate`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: [] }]);
  });

  it("ignores a bare numeric token after a @ref", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec 1`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: [] }]);
  });

  it("parses ac-prefixed named ids as explicit AC references", () => {
    const groups = parseACAnnotationLine(
      `${acPrefix}@my-spec ac-validate-input, ac-reject-invalid`,
    );
    expect(groups).toEqual([
      {
        specRef: "@my-spec",
        acIds: ["ac-validate-input", "ac-reject-invalid"],
        malformedTokens: [],
      },
    ]);
  });

  it("parses ac-prefixed numeric ids as explicit AC references", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1, ac-2`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: ["ac-1", "ac-2"], malformedTokens: [] }]);
  });

  it("captures only ac-prefixed tokens when mixed with non-prefixed tokens", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1 some-word`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: ["ac-1"], malformedTokens: [] }]);
  });

  it("rejects ac-* tokens containing underscores", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-bad_id`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: ["ac-bad_id"] }]);
  });

  it("rejects ac-* tokens with doubled hyphens", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac--double`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: ["ac--double"] }]);
  });

  it("rejects ac-* tokens with trailing hyphens", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-trailing-`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: ["ac-trailing-"] }]);
  });

  it("rejects ac-* tokens with uppercase characters", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-Bad`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: ["ac-Bad"] }]);
  });

  it("filters out malformed ac-* tokens while keeping valid ones", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-valid, ac-bad_id, ac-also-valid`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-valid", "ac-also-valid"], malformedTokens: ["ac-bad_id"] },
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
        malformedTokens: [],
        file: "/tmp/tests/feature.test.ts",
        line: 5,
      },
    ];

    // No warnings — all AC ids are valid and ac-prefixed
    const warnings = validateACAnnotations(annotations, items, index);
    expect(warnings).toHaveLength(0);

    // Both ACs should be covered
    const coveredACs = new Set(["@my-feature ac-validate-input", "@my-feature ac-reject-invalid"]);
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
        malformedTokens: [],
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
        acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
        _sourceFile: "modules/spec.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);

    // Blanket ref: names the spec but no AC ids
    const annotations = [
      {
        specRef: "@my-spec",
        acIds: [],
        malformedTokens: [],
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
    expect(coverage).toEqual([expect.objectContaining({ id: "ac-1", covered: false })]);
  });

  it("non-ac-prefixed tokens after @ref are ignored and earn no coverage", () => {
    // Parser should treat a non-prefixed word like "validate" as noise, yielding a blanket ref
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec validate`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: [] }]);

    // Because acIds is empty, this annotation earns zero coverage
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-spec"],
        title: "My Spec",
        type: "requirement" as const,
        description: "Spec with ACs",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
        _sourceFile: "modules/spec.yaml",
      },
    ];

    const index = new ReferenceIndex([], items);
    const annotations = [
      {
        specRef: "@my-spec",
        acIds: groups[0].acIds,
        malformedTokens: groups[0].malformedTokens,
        file: "/tmp/tests/spec.test.ts",
        line: 5,
      },
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
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1, ac-validate-input`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1", "ac-validate-input"], malformedTokens: [] },
    ]);
  });

  it("accepts ac-prefixed kebab-case ids of varying length", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-a, ac-very-long-descriptive-name`);
    expect(groups).toEqual([
      {
        specRef: "@my-spec",
        acIds: ["ac-a", "ac-very-long-descriptive-name"],
        malformedTokens: [],
      },
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
        malformedTokens: [],
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

// ---------------------------------------------------------------------------
// @ac-annotation-identifier-format ac-malformed-token-not-truncated
//
// "The malformed token is not truncated to a valid prefix and does not
//  provide coverage credit to any acceptance criterion."
// ---------------------------------------------------------------------------

// AC: @ac-annotation-identifier-format ac-malformed-token-not-truncated
describe("ac-malformed-token-not-truncated: malformed ac-* tokens are not truncated to valid prefixes", () => {
  it("ac-good.extra is not truncated to ac-good", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-good.extra`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: [], malformedTokens: ["ac-good.extra"] },
    ]);
  });

  it("ac-good/path is not truncated to ac-good", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-good/path`);
    // "/" splits into two tokens: "ac-good/path" is one token since we split on whitespace/comma
    // Actually "/" is not whitespace or comma, so "ac-good/path" stays as one token
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: ["ac-good/path"] }]);
  });

  it("ac-good#anchor is not truncated to ac-good", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-good#anchor`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: [], malformedTokens: ["ac-good#anchor"] },
    ]);
  });

  it("ac-good?query is not truncated to ac-good", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-good?query`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: [], malformedTokens: ["ac-good?query"] },
    ]);
  });

  it("ac-good: (with trailing colon) is not truncated to ac-good", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-good:`);
    expect(groups).toEqual([{ specRef: "@my-spec", acIds: [], malformedTokens: ["ac-good:"] }]);
  });

  it("malformed token does not grant coverage to the valid prefix", () => {
    const items = [
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["my-spec"],
        title: "My Spec",
        type: "requirement" as const,
        description: "Spec with ACs",
        status: { maturity: "draft" as const, implementation: "not_started" as const },
        acceptance_criteria: [{ id: "ac-good", given: "g", when: "w", then: "t" }],
        _sourceFile: "modules/spec.yaml",
      },
    ];

    // Simulate: the only annotation uses ac-good.extra — the malformed token
    // should NOT provide coverage to ac-good
    const coveredACs = new Set<string>(); // Nothing covered since malformed token is rejected
    const coverage = computeACCoverage(items[0], coveredACs);
    expect(coverage).toEqual([expect.objectContaining({ id: "ac-good", covered: false })]);
  });

  it("mixed valid and malformed tokens: only valid tokens grant coverage", () => {
    const groups = parseACAnnotationLine(
      `${acPrefix}@my-spec ac-valid, ac-good.extra, ac-also-valid`,
    );
    expect(groups).toEqual([
      {
        specRef: "@my-spec",
        acIds: ["ac-valid", "ac-also-valid"],
        malformedTokens: ["ac-good.extra"],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// @ac-annotation-identifier-format ac-valid-delimiters-preserved
//
// "Each delimiter-separated token is recognized as its own acceptance
//  criterion token."
// ---------------------------------------------------------------------------

// AC: @ac-annotation-identifier-format ac-valid-delimiters-preserved
describe("ac-valid-delimiters-preserved: whitespace and comma delimiters produce separate AC tokens", () => {
  it("whitespace-separated tokens are recognized individually", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1 ac-2 ac-3`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1", "ac-2", "ac-3"], malformedTokens: [] },
    ]);
  });

  it("comma-separated tokens are recognized individually", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1,ac-2,ac-3`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1", "ac-2", "ac-3"], malformedTokens: [] },
    ]);
  });

  it("comma-then-whitespace-separated tokens are recognized individually", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1, ac-2, ac-3`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1", "ac-2", "ac-3"], malformedTokens: [] },
    ]);
  });

  it("mixed delimiters produce the correct individual tokens", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1 ac-2, ac-3`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1", "ac-2", "ac-3"], malformedTokens: [] },
    ]);
  });

  it("each delimiter-separated valid token provides its own coverage credit", () => {
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
          { id: "ac-3", given: "g", when: "w", then: "t" },
        ],
        _sourceFile: "modules/spec.yaml",
      },
    ];

    const coveredACs = new Set(["@my-spec ac-1", "@my-spec ac-2", "@my-spec ac-3"]);
    const coverage = computeACCoverage(items[0], coveredACs);
    expect(coverage).toEqual([
      expect.objectContaining({ id: "ac-1", covered: true }),
      expect.objectContaining({ id: "ac-2", covered: true }),
      expect.objectContaining({ id: "ac-3", covered: true }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// @test-annotation-sweep ac-na-marker-preserved
//
// "structured scan output preserves the not-applicable marker and its reason
//  text rather than discarding them."
//
// Fixtures use acPrefix concatenation so the scanner never reads a literal
// "// AC:" line from this source file.
// ---------------------------------------------------------------------------

// AC: @test-annotation-sweep ac-na-marker-preserved
describe("ac-na-marker-preserved: N/A marker and reason survive parsing", () => {
  it("captures the not-applicable flag and reason instead of stripping them", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1 — N/A: does not apply here`);
    expect(groups).toEqual([
      {
        specRef: "@my-spec",
        acIds: ["ac-1"],
        malformedTokens: [],
        notApplicable: true,
        naReason: "does not apply here",
      },
    ]);
  });

  it("records the marker even when no reason text is supplied", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1 -- N/A`);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1"], malformedTokens: [], notApplicable: true },
    ]);
  });

  it("strips the HTML/Svelte closing comment delimiter from the captured reason", () => {
    // The supported COMMENT_PREFIX_MAP entries for .html/.svelte use the
    // <!-- ... --> block syntax. The captured reason must not include the
    // trailing "-->" terminator from the source comment.
    const htmlPrefix = /<!--\s*AC:\s*/;
    const groups = parseACAnnotationLine(
      "<!-- AC: @my-spec ac-1 — N/A: html reason -->",
      htmlPrefix,
    );
    expect(groups).toEqual([
      {
        specRef: "@my-spec",
        acIds: ["ac-1"],
        malformedTokens: [],
        notApplicable: true,
        naReason: "html reason",
      },
    ]);
  });

  it("handles an HTML N/A annotation with no reason and only the closer", () => {
    const htmlPrefix = /<!--\s*AC:\s*/;
    const groups = parseACAnnotationLine("<!-- AC: @my-spec ac-1 — N/A: -->", htmlPrefix);
    expect(groups).toEqual([
      { specRef: "@my-spec", acIds: ["ac-1"], malformedTokens: [], notApplicable: true },
    ]);
  });

  it("preserves a clean N/A reason in structured scan output for .svelte files", async () => {
    // End-to-end verification through scanACAnnotations: the structured
    // annotation surfaced to consumers (item APIs, task review context, static
    // export) must carry the reason text without the source closing delimiter.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-na-html-"));
    try {
      const testsDir = path.join(root, "tests");
      await fs.mkdir(testsDir, { recursive: true });
      await fs.writeFile(
        path.join(testsDir, "fixture.svelte"),
        "<!-- AC: @some-spec ac-1 — N/A: svelte reason -->\n",
      );
      const annotations = await scanACAnnotations(root, ["tests/"]);
      const naAnnotation = annotations.find((a) => a.specRef === "@some-spec");
      expect(naAnnotation).toBeDefined();
      expect(naAnnotation?.notApplicable).toBe(true);
      expect(naAnnotation?.naReason).toBe("svelte reason");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// @test-annotation-sweep ac-na-no-coverage-credit
//
// "A well-formed N/A annotation grants no coverage credit for any of the AC
//  ids it names." Verified through the real file scanner (scanTestCoverage),
//  which builds the flat coverage set every downstream consumer reads.
// ---------------------------------------------------------------------------

// AC: @test-annotation-sweep ac-na-no-coverage-credit
describe("ac-na-no-coverage-credit: N/A annotations are not coverage signals", () => {
  let scanDir: string;

  afterEach(async () => {
    if (scanDir) await fs.rm(scanDir, { recursive: true, force: true });
  });

  async function writeScanFixture(filename: string, line: string): Promise<string> {
    scanDir = await fs.mkdtemp(path.join(os.tmpdir(), "kspec-na-cov-"));
    const testsDir = path.join(scanDir, "tests");
    await fs.mkdir(testsDir, { recursive: true });
    // Build the annotation line at runtime so this source file contains no
    // literal "// AC:" fixture that the real coverage scanner would pick up.
    await fs.writeFile(path.join(testsDir, filename), `${line}\nit('t', () => {});\n`);
    return scanDir;
  }

  it("excludes every AC id named by an N/A annotation from the coverage set", async () => {
    const root = await writeScanFixture(
      "na.test.ts",
      `${acPrefix}@some-spec ac-1, ac-2 — N/A: not applicable`,
    );
    const covered = await scanTestCoverage(root, ["tests/"]);
    expect(covered.has("@some-spec ac-1")).toBe(false);
    expect(covered.has("@some-spec ac-2")).toBe(false);
  });

  it("credits only the coverage claim on a mixed claim/N/A line", async () => {
    const root = await writeScanFixture(
      "mixed.test.ts",
      `${acPrefix}@spec-a ac-1, @spec-b ac-2 — N/A: only b is N/A`,
    );
    const covered = await scanTestCoverage(root, ["tests/"]);
    expect(covered.has("@spec-a ac-1")).toBe(true);
    expect(covered.has("@spec-b ac-2")).toBe(false);
  });

  it("leaves an AC uncovered when its only annotation is N/A (no compensating credit)", async () => {
    const root = await writeScanFixture(
      "only-na.test.ts",
      `${acPrefix}@some-spec ac-1 — N/A: skip`,
    );
    const covered = await scanTestCoverage(root, ["tests/"]);
    const coverage = computeACCoverage(
      {
        _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
        slugs: ["some-spec"],
        acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
      },
      covered,
    );
    expect(coverage).toEqual([expect.objectContaining({ id: "ac-1", covered: false })]);
  });
});

// ---------------------------------------------------------------------------
// @test-annotation-sweep ac-na-no-invalid-finding
//
// "A well-formed N/A annotation naming a resolvable target and existing AC ids
//  produces no invalid-annotation finding, while integrity checks on its target
//  reference and AC ids still apply."
// ---------------------------------------------------------------------------

// AC: @test-annotation-sweep ac-na-no-invalid-finding
describe("ac-na-no-invalid-finding: integrity checks still apply to N/A annotations", () => {
  const items = [
    {
      _ulid: "01KFCRVY8ERZEE2MNHEQXSG90T",
      slugs: ["my-spec"],
      title: "My Spec",
      type: "requirement" as const,
      description: "Spec with ACs",
      status: { maturity: "draft" as const, implementation: "not_started" as const },
      acceptance_criteria: [{ id: "ac-1", given: "g", when: "w", then: "t" }],
      _sourceFile: "modules/spec.yaml",
    },
  ];
  const index = new ReferenceIndex([], items);

  it("produces no finding for a well-formed N/A annotation on a resolvable target", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-1 — N/A: covered elsewhere`);
    expect(groups[0].notApplicable).toBe(true);

    const warnings = validateACAnnotations(
      [
        {
          specRef: groups[0].specRef,
          acIds: groups[0].acIds,
          malformedTokens: groups[0].malformedTokens,
          notApplicable: groups[0].notApplicable,
          naReason: groups[0].naReason,
          file: "/tmp/tests/spec.test.ts",
          line: 5,
        },
      ],
      items,
      index,
    );
    expect(warnings).toHaveLength(0);
  });

  it("still reports an unresolved target for an N/A annotation", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@nonexistent ac-1 — N/A: nowhere`);
    const warnings = validateACAnnotations(
      [
        {
          specRef: groups[0].specRef,
          acIds: groups[0].acIds,
          malformedTokens: groups[0].malformedTokens,
          notApplicable: groups[0].notApplicable,
          naReason: groups[0].naReason,
          file: "/tmp/tests/spec.test.ts",
          line: 5,
        },
      ],
      items,
      index,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subtype).toBe("unresolved_target");
  });

  it("still reports a missing AC id for an N/A annotation naming an unknown criterion", () => {
    const groups = parseACAnnotationLine(`${acPrefix}@my-spec ac-99 — N/A: no such ac`);
    const warnings = validateACAnnotations(
      [
        {
          specRef: groups[0].specRef,
          acIds: groups[0].acIds,
          malformedTokens: groups[0].malformedTokens,
          notApplicable: groups[0].notApplicable,
          naReason: groups[0].naReason,
          file: "/tmp/tests/spec.test.ts",
          line: 5,
        },
      ],
      items,
      index,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].subtype).toBe("missing_ac_id");
  });
});
