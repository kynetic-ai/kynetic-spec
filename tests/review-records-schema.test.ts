import { describe, it, expect } from "vitest";
import {
  ReviewLifecycleStateSchema,
  ReviewDispositionSchema,
  ReviewGateStateSchema,
  ReviewSubjectSchema,
  ReviewSubjectVersionSchema,
  ReviewCodeAnchorSchema,
  ReviewStructuredAnchorSchema,
  ReviewSpecAcAnchorSchema,
  ReviewAnchorSchema,
  ReviewThreadKindSchema,
  ReviewThreadSchema,
  ReviewCheckStatusSchema,
  ReviewCheckSchema,
  ReviewVerdictDecisionSchema,
  ReviewVerdictSchema,
  ReviewEventTypeSchema,
  ReviewEventSchema,
  ReviewExternalLinkSchema,
  ReviewRecordSchema,
  ReviewRecordInputSchema,
  ReviewRecordsFileSchema,
} from "../src/schema/index.js";
import { testUlid } from "./helpers/cli.js";

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

function validTaskSubject() {
  return {
    type: "task" as const,
    ref: "@my-task",
    shadow_commit: VALID_COMMIT,
    content_hash: VALID_HASH,
  };
}

function validCodeCompareVersion() {
  return {
    type: "code_compare" as const,
    base_commit: VALID_COMMIT,
    head_commit: VALID_COMMIT_2,
  };
}

function validEntityVersion() {
  return {
    type: "entity_version" as const,
    content_hash: VALID_HASH,
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

// --- Lifecycle & Disposition enums ---

describe("ReviewLifecycleStateSchema", () => {
  // AC: @review-record-core-model ac-2
  it("should accept valid lifecycle states", () => {
    for (const state of ["draft", "open", "closed", "archived"]) {
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(ReviewLifecycleStateSchema.safeParse(state).success, `should accept ${state}`).toBe(
        true,
      );
    }
  });

  it("should reject invalid lifecycle states", () => {
    expect(ReviewLifecycleStateSchema.safeParse("active").success).toBe(false);
    expect(ReviewLifecycleStateSchema.safeParse("").success).toBe(false);
    expect(ReviewLifecycleStateSchema.safeParse("OPEN").success).toBe(false);
  });
});

describe("ReviewDispositionSchema", () => {
  // AC: @review-record-core-model ac-2
  it("should accept valid dispositions", () => {
    for (const d of ["pending", "approved", "changes_requested"]) {
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(ReviewDispositionSchema.safeParse(d).success, `should accept ${d}`).toBe(true);
    }
  });

  it("should reject invalid dispositions", () => {
    expect(ReviewDispositionSchema.safeParse("rejected").success).toBe(false);
  });
});

describe("ReviewGateStateSchema", () => {
  it("should accept valid gate states", () => {
    for (const s of ["passing", "failing", "pending"]) {
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(ReviewGateStateSchema.safeParse(s).success, `should accept ${s}`).toBe(true);
    }
  });
});

// --- Subject Bindings ---

describe("ReviewSubjectSchema", () => {
  // AC: @review-record-core-model ac-1
  it("should accept code subject with required fields", () => {
    const result = ReviewSubjectSchema.safeParse(validCodeSubject());
    expect(result.success).toBe(true);
  });

  it("should accept code subject with optional fields", () => {
    const result = ReviewSubjectSchema.safeParse({
      ...validCodeSubject(),
      merge_base_commit: "aaa111",
      base_branch: "main",
      head_branch: "feat/foo",
    });
    expect(result.success).toBe(true);
  });

  it("should accept task subject", () => {
    const result = ReviewSubjectSchema.safeParse(validTaskSubject());
    expect(result.success).toBe(true);
  });

  it("should accept plan subject", () => {
    const result = ReviewSubjectSchema.safeParse({
      type: "plan",
      ref: "@my-plan",
      shadow_commit: VALID_COMMIT,
      content_hash: VALID_HASH,
    });
    expect(result.success).toBe(true);
  });

  it("should accept spec subject", () => {
    const result = ReviewSubjectSchema.safeParse({
      type: "spec",
      ref: "@my-spec",
      shadow_commit: VALID_COMMIT,
      content_hash: VALID_HASH,
    });
    expect(result.success).toBe(true);
  });

  // AC: @review-record-core-model ac-3
  it("should accept external subject with URL", () => {
    const result = ReviewSubjectSchema.safeParse({
      type: "external",
      url: "https://github.com/org/repo/pull/42",
      external_id: "42",
      provider: "github",
    });
    expect(result.success).toBe(true);
  });

  it("should accept external subject with only required fields", () => {
    const result = ReviewSubjectSchema.safeParse({
      type: "external",
      url: "https://example.com/review",
    });
    expect(result.success).toBe(true);
  });

  it("should reject unknown subject type", () => {
    const result = ReviewSubjectSchema.safeParse({
      type: "unknown",
      ref: "@something",
    });
    expect(result.success).toBe(false);
  });

  it("should reject code subject missing required fields", () => {
    const result = ReviewSubjectSchema.safeParse({
      type: "code",
      base_commit: VALID_COMMIT,
      // missing head_commit
    });
    expect(result.success).toBe(false);
  });

  it("should reject task subject missing content_hash", () => {
    const result = ReviewSubjectSchema.safeParse({
      type: "task",
      ref: "@my-task",
      shadow_commit: VALID_COMMIT,
      // missing content_hash
    });
    expect(result.success).toBe(false);
  });
});

// --- Subject Version ---

describe("ReviewSubjectVersionSchema", () => {
  it("should accept code_compare version", () => {
    const result = ReviewSubjectVersionSchema.safeParse(validCodeCompareVersion());
    expect(result.success).toBe(true);
  });

  it("should accept entity_version", () => {
    const result = ReviewSubjectVersionSchema.safeParse(validEntityVersion());
    expect(result.success).toBe(true);
  });

  it("should reject unknown version type", () => {
    const result = ReviewSubjectVersionSchema.safeParse({
      type: "unknown",
      hash: "abc",
    });
    expect(result.success).toBe(false);
  });

  it("should reject code_compare missing head_commit", () => {
    const result = ReviewSubjectVersionSchema.safeParse({
      type: "code_compare",
      base_commit: VALID_COMMIT,
    });
    expect(result.success).toBe(false);
  });
});

// --- Anchors ---

describe("ReviewAnchorSchema", () => {
  it("should accept code anchor with all fields", () => {
    const result = ReviewAnchorSchema.safeParse({
      type: "code",
      path: "src/foo.ts",
      side: "head",
      line_start: 42,
      line_end: 46,
      commit: VALID_COMMIT,
    });
    expect(result.success).toBe(true);
  });

  it("should accept code anchor with base side", () => {
    const result = ReviewCodeAnchorSchema.safeParse({
      type: "code",
      path: "src/bar.ts",
      side: "base",
      line_start: 1,
      line_end: 5,
      commit: VALID_COMMIT,
    });
    expect(result.success).toBe(true);
  });

  it("should reject code anchor with invalid side", () => {
    const result = ReviewCodeAnchorSchema.safeParse({
      type: "code",
      path: "src/foo.ts",
      side: "left",
      line_start: 1,
      line_end: 5,
      commit: VALID_COMMIT,
    });
    expect(result.success).toBe(false);
  });

  it("should reject code anchor with non-positive line_start", () => {
    const result = ReviewCodeAnchorSchema.safeParse({
      type: "code",
      path: "src/foo.ts",
      side: "head",
      line_start: 0,
      line_end: 5,
      commit: VALID_COMMIT,
    });
    expect(result.success).toBe(false);
  });

  it("should accept structured anchor with optional fields", () => {
    const result = ReviewStructuredAnchorSchema.safeParse({
      type: "structured",
      section: "acceptance_criteria",
      field: "ac-1",
    });
    expect(result.success).toBe(true);
  });

  it("should accept structured anchor with all fields", () => {
    const result = ReviewStructuredAnchorSchema.safeParse({
      type: "structured",
      section: "description",
      field: "title",
      path: "modules/core.yaml",
      ref: "@my-spec",
    });
    expect(result.success).toBe(true);
  });

  it("should accept structured anchor with no optional fields", () => {
    const result = ReviewStructuredAnchorSchema.safeParse({
      type: "structured",
    });
    expect(result.success).toBe(true);
  });

  // AC: @review-spec-ac-anchors ac-typed-anchor-stored
  it("should accept spec AC anchor with typed spec and criterion fields", () => {
    const result = ReviewSpecAcAnchorSchema.safeParse({
      type: "spec_ac",
      spec_ref: "@my-spec",
      criterion_id: "ac-1",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      type: "spec_ac",
      spec_ref: "@my-spec",
      criterion_id: "ac-1",
    });
  });

  // AC: @review-spec-ac-anchors ac-anchor-field-validation
  it("should reject malformed spec AC anchor fields", () => {
    const invalidSpecRef = ReviewSpecAcAnchorSchema.safeParse({
      type: "spec_ac",
      spec_ref: "my-spec",
      criterion_id: "ac-1",
    });
    expect(invalidSpecRef.success).toBe(false);

    const invalidCriterionId = ReviewSpecAcAnchorSchema.safeParse({
      type: "spec_ac",
      spec_ref: "@my-spec",
      criterion_id: "criterion-1",
    });
    expect(invalidCriterionId.success).toBe(false);
  });

  it("should discriminate between code, structured, and spec AC anchors", () => {
    const codeResult = ReviewAnchorSchema.safeParse({
      type: "code",
      path: "src/foo.ts",
      side: "head",
      line_start: 1,
      line_end: 1,
      commit: VALID_COMMIT,
    });
    expect(codeResult.success).toBe(true);

    const structuredResult = ReviewAnchorSchema.safeParse({
      type: "structured",
      section: "ac-1",
    });
    expect(structuredResult.success).toBe(true);

    const specAcResult = ReviewAnchorSchema.safeParse({
      type: "spec_ac",
      spec_ref: "@my-spec",
      criterion_id: "ac-validation",
    });
    expect(specAcResult.success).toBe(true);
  });
});

// --- Threads ---

describe("ReviewThreadSchema", () => {
  it("should accept valid thread with entries", () => {
    const result = ReviewThreadSchema.safeParse({
      _ulid: VALID_ULID,
      kind: "blocker",
      entries: [
        {
          _ulid: VALID_ULID_2,
          author: "reviewer@example.com",
          body: "This needs fixing",
          created_at: VALID_DATE,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  // AC: @review-idea-threads ac-idea-kind-accepted
  it("should accept idea thread kind with entries", () => {
    const result = ReviewThreadSchema.safeParse({
      _ulid: VALID_ULID,
      kind: "idea",
      entries: [
        {
          _ulid: VALID_ULID_2,
          author: "reviewer@example.com",
          body: "A forward-looking improvement idea.",
          created_at: VALID_DATE,
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("idea");
    }
  });

  it("should default kind to nit", () => {
    const result = ReviewThreadSchema.safeParse({
      _ulid: VALID_ULID,
      entries: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("nit");
    }
  });

  it("should accept thread with anchor", () => {
    const result = ReviewThreadSchema.safeParse({
      _ulid: VALID_ULID,
      kind: "question",
      anchor: {
        type: "code",
        path: "src/foo.ts",
        side: "head",
        line_start: 10,
        line_end: 15,
        commit: VALID_COMMIT,
      },
      entries: [
        {
          _ulid: VALID_ULID_2,
          author: "agent@kspec",
          body: "Why is this needed?",
          created_at: VALID_DATE,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("should accept thread with resolved state", () => {
    const result = ReviewThreadSchema.safeParse({
      _ulid: VALID_ULID,
      entries: [],
      resolved_at: VALID_DATE,
      resolved_by: "author@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("should default entries to empty array", () => {
    const result = ReviewThreadSchema.safeParse({
      _ulid: VALID_ULID,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries).toEqual([]);
    }
  });
});

describe("ReviewThreadKindSchema", () => {
  it("should accept valid kinds", () => {
    for (const kind of ["blocker", "question", "nit", "idea"]) {
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(ReviewThreadKindSchema.safeParse(kind).success, `should accept ${kind}`).toBe(true);
    }
  });

  it("should reject invalid kinds", () => {
    expect(ReviewThreadKindSchema.safeParse("error").success).toBe(false);
    expect(ReviewThreadKindSchema.safeParse("warning").success).toBe(false);
  });
});

// --- Checks ---

describe("ReviewCheckSchema", () => {
  it("should accept valid check with code_compare version", () => {
    const result = ReviewCheckSchema.safeParse({
      name: "tests",
      status: "pass",
      required: true,
      runner: "vitest",
      evidence: "All 150 tests passed",
      applies_to_version: validCodeCompareVersion(),
      created_at: VALID_DATE,
      completed_at: VALID_DATE,
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid check with entity_version", () => {
    const result = ReviewCheckSchema.safeParse({
      name: "spec-alignment",
      status: "pass",
      applies_to_version: validEntityVersion(),
      created_at: VALID_DATE,
    });
    expect(result.success).toBe(true);
  });

  it("should default required to true", () => {
    const result = ReviewCheckSchema.safeParse({
      name: "lint",
      status: "pass",
      applies_to_version: validCodeCompareVersion(),
      created_at: VALID_DATE,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.required).toBe(true);
    }
  });

  it("should accept all check statuses", () => {
    for (const status of ["pass", "fail", "running", "skipped"]) {
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(ReviewCheckStatusSchema.safeParse(status).success, `should accept ${status}`).toBe(
        true,
      );
    }
  });

  it("should reject check missing applies_to_version", () => {
    const result = ReviewCheckSchema.safeParse({
      name: "tests",
      status: "pass",
      created_at: VALID_DATE,
    });
    expect(result.success).toBe(false);
  });
});

// --- Verdicts ---

describe("ReviewVerdictSchema", () => {
  it("should accept valid verdict with code_compare version", () => {
    const result = ReviewVerdictSchema.safeParse({
      reviewer: "reviewer@example.com",
      decision: "approve",
      applies_to_version: validCodeCompareVersion(),
      created_at: VALID_DATE,
    });
    expect(result.success).toBe(true);
  });

  it("should accept valid verdict with entity_version", () => {
    const result = ReviewVerdictSchema.safeParse({
      reviewer: "agent@kspec",
      decision: "request_changes",
      applies_to_version: validEntityVersion(),
      created_at: VALID_DATE,
    });
    expect(result.success).toBe(true);
  });

  it("should default role to reviewer", () => {
    const result = ReviewVerdictSchema.safeParse({
      reviewer: "test@example.com",
      decision: "approve",
      applies_to_version: validCodeCompareVersion(),
      created_at: VALID_DATE,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("reviewer");
    }
  });

  it("should accept custom role", () => {
    const result = ReviewVerdictSchema.safeParse({
      reviewer: "lead@example.com",
      role: "maintainer",
      decision: "approve",
      applies_to_version: validCodeCompareVersion(),
      created_at: VALID_DATE,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("maintainer");
    }
  });

  it("should accept all verdict decisions", () => {
    for (const d of ["approve", "request_changes", "comment"]) {
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(ReviewVerdictDecisionSchema.safeParse(d).success, `should accept ${d}`).toBe(true);
    }
  });

  it("should reject verdict with hyphenated decision name", () => {
    expect(ReviewVerdictDecisionSchema.safeParse("request-changes").success).toBe(false);
  });
});

// --- Events ---

describe("ReviewEventSchema", () => {
  // AC: @review-record-core-model ac-4
  it("should accept valid event with payload", () => {
    const result = ReviewEventSchema.safeParse({
      _ulid: VALID_ULID,
      event_type: "verdict_submitted",
      actor: "agent@kspec",
      timestamp: VALID_DATE,
      payload: {
        decision: "approve",
        applies_to_version: {
          type: "code_compare",
          base_commit: VALID_COMMIT,
          head_commit: VALID_COMMIT_2,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("should default payload to empty object", () => {
    const result = ReviewEventSchema.safeParse({
      _ulid: VALID_ULID,
      event_type: "lifecycle_change",
      actor: "user@example.com",
      timestamp: VALID_DATE,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payload).toEqual({});
    }
  });

  it("should accept all event types", () => {
    const eventTypes = [
      "lifecycle_change",
      "verdict_submitted",
      "thread_created",
      "thread_replied",
      "thread_resolved",
      "thread_reopened",
      "check_added",
      "subject_refreshed",
    ];
    for (const t of eventTypes) {
      // oxlint-disable-next-line jest/valid-expect -- Vitest supports custom message as 2nd arg
      expect(ReviewEventTypeSchema.safeParse(t).success, `should accept ${t}`).toBe(true);
    }
  });

  it("should reject invalid event type", () => {
    expect(ReviewEventTypeSchema.safeParse("comment_added").success).toBe(false);
  });
});

// --- External Links ---

describe("ReviewExternalLinkSchema", () => {
  // AC: @review-record-core-model ac-3
  it("should accept external link with all fields", () => {
    const result = ReviewExternalLinkSchema.safeParse({
      url: "https://github.com/org/repo/pull/42",
      provider: "github",
      external_id: "42",
      label: "PR #42",
    });
    expect(result.success).toBe(true);
  });

  it("should accept external link with only url", () => {
    const result = ReviewExternalLinkSchema.safeParse({
      url: "https://example.com/review/123",
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid url", () => {
    const result = ReviewExternalLinkSchema.safeParse({
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });
});

// --- Review Record ---

describe("ReviewRecordSchema", () => {
  // AC: @review-record-core-model ac-1
  it("should accept valid review record with code subject", () => {
    const result = ReviewRecordSchema.safeParse(validReviewRecord());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycle_state).toBe("open");
      expect(result.data.subject.type).toBe("code");
      expect(result.data.author).toBe("test@example.com");
      expect(result.data.events).toEqual([]);
    }
  });

  // AC: @review-record-core-model ac-1
  it("should accept valid review record with task subject", () => {
    const result = ReviewRecordSchema.safeParse(validReviewRecord({ subject: validTaskSubject() }));
    expect(result.success).toBe(true);
  });

  // AC: @review-record-core-model ac-2
  it("should store lifecycle_state separately (not collapsed with disposition)", () => {
    const record = validReviewRecord({ lifecycle_state: "draft" });
    const result = ReviewRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycle_state).toBe("draft");
      // Disposition is computed, not stored — only lifecycle_state is in the schema
      expect(result.data).not.toHaveProperty("disposition");
      expect(result.data).not.toHaveProperty("gate_state");
    }
  });

  // AC: @review-record-core-model ac-2
  it("should default lifecycle_state to draft", () => {
    const record = validReviewRecord();
    delete (record as Record<string, unknown>).lifecycle_state;
    const result = ReviewRecordSchema.safeParse(record);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lifecycle_state).toBe("draft");
    }
  });

  // AC: @review-record-core-model ac-3
  it("should store external links without making them authoritative", () => {
    const result = ReviewRecordSchema.safeParse(
      validReviewRecord({
        external_links: [
          {
            url: "https://github.com/org/repo/pull/42",
            provider: "github",
            external_id: "42",
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.external_links).toHaveLength(1);
      expect(result.data.lifecycle_state).toBe("open");
    }
  });

  // AC: @review-record-core-model ac-4
  it("should support append-only event log", () => {
    const result = ReviewRecordSchema.safeParse(
      validReviewRecord({
        events: [
          {
            _ulid: VALID_ULID_2,
            event_type: "lifecycle_change",
            actor: "user@example.com",
            timestamp: VALID_DATE,
            payload: { from: "draft", to: "open" },
          },
          {
            _ulid: VALID_ULID_3,
            event_type: "verdict_submitted",
            actor: "reviewer@example.com",
            timestamp: VALID_DATE,
            payload: { decision: "approve" },
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toHaveLength(2);
      expect(result.data.events[0].event_type).toBe("lifecycle_change");
      expect(result.data.events[1].event_type).toBe("verdict_submitted");
    }
  });

  it("should accept related_refs", () => {
    const result = ReviewRecordSchema.safeParse(
      validReviewRecord({
        related_refs: ["@my-task", "@other-task"],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.related_refs).toEqual(["@my-task", "@other-task"]);
    }
  });

  it("should default arrays to empty", () => {
    const minimal = {
      _ulid: VALID_ULID,
      title: "Minimal review",
      subject: validCodeSubject(),
      author: "test@example.com",
      created_at: VALID_DATE,
    };
    const result = ReviewRecordSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slugs).toEqual([]);
      expect(result.data.related_refs).toEqual([]);
      expect(result.data.threads).toEqual([]);
      expect(result.data.checks).toEqual([]);
      expect(result.data.verdicts).toEqual([]);
      expect(result.data.events).toEqual([]);
      expect(result.data.notes).toEqual([]);
      expect(result.data.external_links).toEqual([]);
    }
  });

  it("should require title", () => {
    const record = validReviewRecord();
    delete (record as Record<string, unknown>).title;
    const result = ReviewRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("should require subject", () => {
    const record = validReviewRecord();
    delete (record as Record<string, unknown>).subject;
    const result = ReviewRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("should require author", () => {
    const record = validReviewRecord();
    delete (record as Record<string, unknown>).author;
    const result = ReviewRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("should require _ulid", () => {
    const record = validReviewRecord();
    delete (record as Record<string, unknown>)._ulid;
    const result = ReviewRecordSchema.safeParse(record);
    expect(result.success).toBe(false);
  });

  it("should accept review with threads, checks, and verdicts together", () => {
    const result = ReviewRecordSchema.safeParse(
      validReviewRecord({
        threads: [
          {
            _ulid: VALID_ULID_2,
            kind: "blocker",
            entries: [
              {
                _ulid: VALID_ULID_3,
                author: "reviewer@example.com",
                body: "Must fix this",
                created_at: VALID_DATE,
              },
            ],
          },
        ],
        checks: [
          {
            name: "tests",
            status: "pass",
            required: true,
            applies_to_version: validCodeCompareVersion(),
            created_at: VALID_DATE,
          },
        ],
        verdicts: [
          {
            reviewer: "reviewer@example.com",
            decision: "approve",
            applies_to_version: validCodeCompareVersion(),
            created_at: VALID_DATE,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.threads).toHaveLength(1);
      expect(result.data.checks).toHaveLength(1);
      expect(result.data.verdicts).toHaveLength(1);
    }
  });

  it("should accept review with notes (reused from task schema)", () => {
    const noteUlid = testUlid("NT", 1);
    const result = ReviewRecordSchema.safeParse(
      validReviewRecord({
        notes: [
          {
            _ulid: noteUlid,
            created_at: VALID_DATE,
            author: "user@example.com",
            content: "Reviewed the changes, looks good overall.",
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.notes).toHaveLength(1);
    }
  });
});

// --- Review Record Input ---

describe("ReviewRecordInputSchema", () => {
  it("should accept minimal input (title, subject, author)", () => {
    const result = ReviewRecordInputSchema.safeParse({
      title: "New Review",
      subject: validCodeSubject(),
      author: "creator@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("should allow optional _ulid and slugs", () => {
    const result = ReviewRecordInputSchema.safeParse({
      _ulid: VALID_ULID,
      slugs: ["custom-slug"],
      title: "Custom Review",
      subject: validTaskSubject(),
      author: "test@example.com",
    });
    expect(result.success).toBe(true);
  });

  it("should allow optional lifecycle_state", () => {
    const result = ReviewRecordInputSchema.safeParse({
      title: "Draft Review",
      subject: validCodeSubject(),
      author: "test@example.com",
      lifecycle_state: "open",
    });
    expect(result.success).toBe(true);
  });

  it("should require title", () => {
    const result = ReviewRecordInputSchema.safeParse({
      subject: validCodeSubject(),
      author: "test@example.com",
    });
    expect(result.success).toBe(false);
  });
});

// --- Reviews File ---

describe("ReviewRecordsFileSchema", () => {
  it("should accept valid reviews file", () => {
    const result = ReviewRecordsFileSchema.safeParse({
      kynetic_reviews: "1.0",
      reviews: [validReviewRecord()],
    });
    expect(result.success).toBe(true);
  });

  it("should accept empty reviews array", () => {
    const result = ReviewRecordsFileSchema.safeParse({
      kynetic_reviews: "1.0",
      reviews: [],
    });
    expect(result.success).toBe(true);
  });

  it("should default version to 1.0", () => {
    const result = ReviewRecordsFileSchema.safeParse({
      reviews: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kynetic_reviews).toBe("1.0");
    }
  });

  it("should require reviews array", () => {
    const result = ReviewRecordsFileSchema.safeParse({
      kynetic_reviews: "1.0",
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid review in array", () => {
    const result = ReviewRecordsFileSchema.safeParse({
      kynetic_reviews: "1.0",
      reviews: [{ invalid: true }],
    });
    expect(result.success).toBe(false);
  });
});
