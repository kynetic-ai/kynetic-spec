import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  validateReviewRecord,
  validateReviewRecordInput,
  validateReviewsFile,
  findReviewFiles,
  parseReviewRecord,
  parseReviewRecordInput,
} from "../src/parser/review-validation.js";
import { testUlid, testUlids } from "./helpers/cli.js";

const VALID_ULID = testUlid("RV", 1);
const VALID_ULID_2 = testUlid("RV", 2);
const VALID_ULID_3 = testUlid("RV", 3);
const VALID_DATE = "2026-03-14T00:00:00.000Z";
const VALID_COMMIT = "abc123def456";
const VALID_COMMIT_2 = "def456ghi789";
const VALID_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function validCodeSubject() {
  return {
    type: "code" as const,
    base_commit: VALID_COMMIT,
    head_commit: VALID_COMMIT_2,
  };
}

function validReviewRecord(overrides: Record<string, unknown> = {}) {
  return {
    _ulid: VALID_ULID,
    slugs: ["review-test-1"],
    title: "Test Review",
    lifecycle_state: "open",
    subject: validCodeSubject(),
    author: "test@example.com",
    related_refs: [],
    threads: [],
    checks: [],
    verdicts: [],
    events: [],
    notes: [],
    external_links: [],
    created_at: VALID_DATE,
    ...overrides,
  };
}

function validReviewInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Test Review",
    subject: validCodeSubject(),
    author: "test@example.com",
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(await fs.realpath("/tmp"), "review-val-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ============================================================
// AC-1: Schema validation covers all review model entities
// ============================================================

describe("validateReviewRecord", () => {
  // AC: @review-record-validation ac-1
  it("should accept a valid complete review record", () => {
    const result = validateReviewRecord(validReviewRecord());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // AC: @review-record-validation ac-1
  it("should validate review records with all entity types populated", () => {
    const record = validReviewRecord({
      threads: [
        {
          _ulid: VALID_ULID_2,
          kind: "blocker",
          entries: [
            {
              _ulid: VALID_ULID_3,
              author: "reviewer@example.com",
              body: "This needs fixing",
              created_at: VALID_DATE,
            },
          ],
        },
      ],
      checks: [
        {
          name: "ci-build",
          status: "pass",
          required: true,
          applies_to_version: {
            type: "code_compare",
            base_commit: VALID_COMMIT,
            head_commit: VALID_COMMIT_2,
          },
          created_at: VALID_DATE,
        },
      ],
      verdicts: [
        {
          reviewer: "reviewer@example.com",
          decision: "approve",
          applies_to_version: {
            type: "code_compare",
            base_commit: VALID_COMMIT,
            head_commit: VALID_COMMIT_2,
          },
          created_at: VALID_DATE,
        },
      ],
      events: [
        {
          _ulid: testUlid("EV", 1),
          event_type: "lifecycle_change",
          actor: "system",
          timestamp: VALID_DATE,
          payload: { from: "draft", to: "open" },
        },
      ],
    });

    const result = validateReviewRecord(record);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // AC: @review-record-validation ac-1
  it("should validate all subject binding types", () => {
    const subjectTypes = [
      { type: "code", base_commit: VALID_COMMIT, head_commit: VALID_COMMIT_2 },
      { type: "plan", ref: "@my-plan", shadow_commit: VALID_COMMIT, content_hash: VALID_HASH },
      { type: "task", ref: "@my-task", shadow_commit: VALID_COMMIT, content_hash: VALID_HASH },
      { type: "spec", ref: "@my-spec", shadow_commit: VALID_COMMIT, content_hash: VALID_HASH },
      { type: "external", url: "https://github.com/owner/repo/pull/1" },
    ];

    for (const subject of subjectTypes) {
      const result = validateReviewRecord(validReviewRecord({ subject }));
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(result.valid, `subject type '${subject.type}' should be valid`).toBe(true);
    }
  });

  // AC: @review-record-validation ac-1
  it("should reject review record missing required _ulid", () => {
    const { _ulid, ...noUlid } = validReviewRecord();
    const result = validateReviewRecord(noUlid);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // AC: @review-record-validation ac-1
  it("should reject review record missing required title", () => {
    const result = validateReviewRecord(validReviewRecord({ title: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("title"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should reject review record missing required subject", () => {
    const { subject: _subject, ...noSubject } = validReviewRecord();
    const result = validateReviewRecord(noSubject);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("subject"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should reject review record missing required author", () => {
    const { author: _author, ...noAuthor } = validReviewRecord();
    const result = validateReviewRecord(noAuthor);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("author"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should reject invalid subject type", () => {
    const result = validateReviewRecord(validReviewRecord({ subject: { type: "unknown_type" } }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("subject"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should reject invalid lifecycle state", () => {
    const result = validateReviewRecord(validReviewRecord({ lifecycle_state: "invalid_state" }));
    expect(result.valid).toBe(false);
  });

  // AC: @review-record-validation ac-1
  it("should reject invalid thread kind", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        threads: [
          {
            _ulid: VALID_ULID_2,
            kind: "invalid_kind",
            entries: [],
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("threads"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should reject invalid check status", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        checks: [
          {
            name: "ci",
            status: "invalid_status",
            applies_to_version: {
              type: "code_compare",
              base_commit: VALID_COMMIT,
              head_commit: VALID_COMMIT_2,
            },
            created_at: VALID_DATE,
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("checks"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should reject invalid verdict decision", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        verdicts: [
          {
            reviewer: "someone",
            decision: "invalid_decision",
            applies_to_version: {
              type: "code_compare",
              base_commit: VALID_COMMIT,
              head_commit: VALID_COMMIT_2,
            },
            created_at: VALID_DATE,
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("verdicts"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should reject invalid event type", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        events: [
          {
            _ulid: VALID_ULID_2,
            event_type: "invalid_event",
            actor: "system",
            timestamp: VALID_DATE,
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path?.includes("events"))).toBe(true);
  });

  // AC: @review-record-validation ac-1
  it("should include source file in errors", () => {
    const result = validateReviewRecord({}, "project.reviews.yaml");
    expect(result.valid).toBe(false);
    expect(result.errors.every((e) => e.file === "project.reviews.yaml")).toBe(true);
  });
});

describe("validateReviewRecordInput", () => {
  // AC: @review-record-validation ac-1
  it("should accept valid review input with minimal fields", () => {
    const result = validateReviewRecordInput(validReviewInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // AC: @review-record-validation ac-1
  it("should reject input missing required title", () => {
    const { title: _title, ...noTitle } = validReviewInput();
    const result = validateReviewRecordInput(noTitle);
    expect(result.valid).toBe(false);
  });

  // AC: @review-record-validation ac-1
  it("should reject input missing required subject", () => {
    const { subject: _subject, ...noSubject } = validReviewInput();
    const result = validateReviewRecordInput(noSubject);
    expect(result.valid).toBe(false);
  });

  // AC: @review-record-validation ac-1
  it("should reject input missing required author", () => {
    const { author: _author, ...noAuthor } = validReviewInput();
    const result = validateReviewRecordInput(noAuthor);
    expect(result.valid).toBe(false);
  });
});

// ============================================================
// AC-2: Actionable validation feedback on invalid data
// ============================================================

describe("actionable validation feedback", () => {
  // AC: @review-record-validation ac-2
  it("should provide actionable message for invalid subject type", () => {
    const result = validateReviewRecord(validReviewRecord({ subject: { type: "bad_type" } }));
    expect(result.valid).toBe(false);
    const subjectError = result.errors.find((e) => e.path?.includes("subject"));
    expect(subjectError).toBeDefined();
    expect(subjectError!.message).toContain("code, plan, task, spec, external");
  });

  // AC: @review-record-validation ac-2
  it("should provide actionable message for invalid applies_to_version type", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        checks: [
          {
            name: "ci",
            status: "pass",
            applies_to_version: { type: "bad_version" },
            created_at: VALID_DATE,
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    const versionError = result.errors.find((e) => e.path?.includes("applies_to_version"));
    expect(versionError).toBeDefined();
    expect(versionError!.message).toContain("code_compare, entity_version");
  });

  // AC: @review-spec-ac-anchors ac-anchor-variant-guidance
  it("should enumerate spec AC anchors in invalid anchor type guidance", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        threads: [
          {
            _ulid: VALID_ULID_2,
            kind: "nit",
            anchor: { type: "bad_anchor" },
            entries: [
              {
                _ulid: VALID_ULID_3,
                author: "@reviewer",
                body: "Bad anchor.",
                created_at: VALID_DATE,
              },
            ],
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    const anchorError = result.errors.find((e) => e.path?.includes("anchor"));
    expect(anchorError).toBeDefined();
    expect(anchorError!.message).toContain("code, structured, spec_ac, plan_text");
  });

  // AC: @review-record-validation ac-2
  it("should provide actionable message for empty title", () => {
    const result = validateReviewRecord(validReviewRecord({ title: "" }));
    expect(result.valid).toBe(false);
    const titleError = result.errors.find((e) => e.path?.includes("title"));
    expect(titleError).toBeDefined();
    expect(titleError!.message).toContain("required");
  });

  // AC: @review-record-validation ac-2
  it("should provide actionable message for invalid URL in external subject", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        subject: { type: "external", url: "not-a-url" },
      }),
    );
    expect(result.valid).toBe(false);
    const urlError = result.errors.find((e) => e.message.toLowerCase().includes("url"));
    expect(urlError).toBeDefined();
  });

  // AC: @review-record-validation ac-2
  it("should include dotted field path in errors for nested fields", () => {
    const result = validateReviewRecord(
      validReviewRecord({
        threads: [
          {
            _ulid: VALID_ULID_2,
            kind: "blocker",
            entries: [
              {
                // Missing required _ulid and author
                body: "test",
                created_at: VALID_DATE,
              },
            ],
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    // Should have a dotted path like "threads.0.entries.0._ulid"
    const nestedError = result.errors.find(
      (e) => e.path?.includes("threads") && e.path?.includes("entries"),
    );
    expect(nestedError).toBeDefined();
    expect(nestedError!.path).toMatch(/threads.*entries/);
  });

  // AC: @review-record-validation ac-2
  it("should report multiple errors for multiple invalid fields", () => {
    const result = validateReviewRecord({
      // Missing _ulid, title, subject, author — all required
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

// ============================================================
// File-level validation
// ============================================================

describe("validateReviewsFile", () => {
  // AC: @review-record-validation ac-1
  it("should validate a well-formed reviews YAML file", async () => {
    const content = YAML.stringify({
      kynetic_reviews: "1.0",
      reviews: [validReviewRecord()],
    });
    const filePath = path.join(tmpDir, "project.reviews.yaml");
    await fs.writeFile(filePath, content);

    const errors = await validateReviewsFile(filePath);
    expect(errors).toHaveLength(0);
  });

  // AC: @review-record-validation ac-2
  it("should report per-review errors with index path for invalid records", async () => {
    const content = YAML.stringify({
      kynetic_reviews: "1.0",
      reviews: [validReviewRecord(), validReviewRecord({ _ulid: "INVALID", title: "" })],
    });
    const filePath = path.join(tmpDir, "project.reviews.yaml");
    await fs.writeFile(filePath, content);

    const errors = await validateReviewsFile(filePath);
    expect(errors.length).toBeGreaterThan(0);
    // Errors should reference reviews[1]
    expect(errors.some((e) => e.path?.includes("reviews[1]"))).toBe(true);
  });

  // AC: @review-record-validation ac-2
  it("should report error for non-object reviews file", async () => {
    const filePath = path.join(tmpDir, "project.reviews.yaml");
    await fs.writeFile(filePath, "just a string\n");

    const errors = await validateReviewsFile(filePath);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("Invalid reviews file format");
  });

  // AC: @review-record-validation ac-2
  it("should report error for invalid YAML syntax", async () => {
    const filePath = path.join(tmpDir, "project.reviews.yaml");
    await fs.writeFile(filePath, "invalid: yaml: [unclosed");

    const errors = await validateReviewsFile(filePath);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("Failed to parse reviews YAML");
  });

  // AC: @review-record-validation ac-1
  it("should accept reviews file with multiple valid reviews", async () => {
    const [id1, id2] = testUlids("VR", 2);
    const content = YAML.stringify({
      kynetic_reviews: "1.0",
      reviews: [
        validReviewRecord({ _ulid: id1, title: "Review 1" }),
        validReviewRecord({ _ulid: id2, title: "Review 2" }),
      ],
    });
    const filePath = path.join(tmpDir, "project.reviews.yaml");
    await fs.writeFile(filePath, content);

    const errors = await validateReviewsFile(filePath);
    expect(errors).toHaveLength(0);
  });
});

// ============================================================
// findReviewFiles
// ============================================================

describe("findReviewFiles", () => {
  it("should find .reviews.yaml files", async () => {
    const filePath = path.join(tmpDir, "project.reviews.yaml");
    await fs.writeFile(filePath, "kynetic_reviews: '1.0'\nreviews: []\n");

    const files = await findReviewFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(filePath);
  });

  it("should find nested .reviews.yaml files", async () => {
    const subDir = path.join(tmpDir, "subdir");
    await fs.mkdir(subDir, { recursive: true });
    const filePath = path.join(subDir, "team.reviews.yaml");
    await fs.writeFile(filePath, "kynetic_reviews: '1.0'\nreviews: []\n");

    const files = await findReviewFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(filePath);
  });

  it("should return empty array for non-existent directory", async () => {
    const files = await findReviewFiles(path.join(tmpDir, "does-not-exist"));
    expect(files).toHaveLength(0);
  });

  it("should not match non-review YAML files", async () => {
    await fs.writeFile(path.join(tmpDir, "project.tasks.yaml"), "tasks: []\n");
    await fs.writeFile(path.join(tmpDir, "kynetic.yaml"), "kynetic: '1.0'\n");

    const files = await findReviewFiles(tmpDir);
    expect(files).toHaveLength(0);
  });
});

// ============================================================
// Parse convenience functions
// ============================================================

describe("parseReviewRecord", () => {
  // AC: @review-record-validation ac-1
  it("should return typed data on valid input", () => {
    const result = parseReviewRecord(validReviewRecord());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data._ulid).toBe(VALID_ULID);
      expect(result.data.title).toBe("Test Review");
    }
  });

  // AC: @review-record-validation ac-2
  it("should return errors on invalid input", () => {
    const result = parseReviewRecord({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("parseReviewRecordInput", () => {
  // AC: @review-record-validation ac-1
  it("should return typed data on valid input", () => {
    const result = parseReviewRecordInput(validReviewInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toBe("Test Review");
    }
  });

  // AC: @review-record-validation ac-2
  it("should return errors on invalid input", () => {
    const result = parseReviewRecordInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
