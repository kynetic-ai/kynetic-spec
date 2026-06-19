import { describe, it, expect } from "vitest";
import { testUlid } from "./helpers/cli.js";
import type {
  ReviewRecord,
  ReviewSubject,
  ReviewSubjectVersion,
  ReviewVerdict,
  ReviewCheck,
  ReviewThread,
} from "../src/schema/index.js";
import {
  getEffectiveVerdicts,
  computeDisposition,
  submitVerdict,
  refreshSubject,
  transitionLifecycle,
} from "../src/parser/review-operations.js";
import { extractSubjectVersion, isVersionStale } from "../src/review/subject-bindings.js";
import { evaluateGates } from "../src/review/checks.js";
import {
  resolveThread,
  reopenThread,
  getUnresolvedBlockers,
} from "../src/parser/review-threads.js";

// --- Test constants ---

const ULID_REVIEW = testUlid("VR", 1);
const ULID_THREAD_1 = testUlid("VT", 1);
const ULID_THREAD_2 = testUlid("VT", 2);
const ULID_ENTRY_1 = testUlid("VE", 1);
const VALID_DATE = "2026-03-14T00:00:00.000Z";
const VALID_DATE_2 = "2026-03-14T01:00:00.000Z";
const VALID_DATE_3 = "2026-03-14T02:00:00.000Z";
const COMMIT_BASE = "aaa111bbb222";
const COMMIT_HEAD = "ccc333ddd444";
const COMMIT_BASE_2 = "eee555fff666";
const COMMIT_HEAD_2 = "ggg777hhh888";
const CONTENT_HASH_1 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const CONTENT_HASH_2 = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

// --- Helpers ---

function codeSubject(base = COMMIT_BASE, head = COMMIT_HEAD): ReviewSubject {
  return { type: "code", base_commit: base, head_commit: head };
}

function taskSubject(hash = CONTENT_HASH_1): ReviewSubject {
  return {
    type: "task",
    ref: "@my-task",
    shadow_commit: COMMIT_BASE,
    content_hash: hash,
  };
}

function codeVersion(base = COMMIT_BASE, head = COMMIT_HEAD): ReviewSubjectVersion {
  return { type: "code_compare", base_commit: base, head_commit: head };
}

function entityVersion(hash = CONTENT_HASH_1): ReviewSubjectVersion {
  return { type: "entity_version", content_hash: hash };
}

function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    reviewer: "alice@example.com",
    role: "reviewer",
    decision: "approve",
    applies_to_version: codeVersion(),
    created_at: VALID_DATE,
    ...overrides,
  };
}

function makeCheck(overrides: Partial<ReviewCheck> = {}): ReviewCheck {
  return {
    name: "tests",
    status: "pass",
    required: true,
    applies_to_version: codeVersion(),
    created_at: VALID_DATE,
    ...overrides,
  };
}

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    _ulid: ULID_THREAD_1,
    kind: "nit",
    entries: [
      {
        _ulid: ULID_ENTRY_1,
        author: "reviewer@example.com",
        body: "Looks good",
        created_at: VALID_DATE,
      },
    ],
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    _ulid: ULID_REVIEW,
    slugs: ["test-review"],
    title: "Test Review",
    lifecycle_state: "open",
    subject: codeSubject(),
    author: "author@example.com",
    related_refs: [],
    threads: [],
    checks: [],
    verdicts: [],
    events: [],
    notes: [],
    external_links: [],
    created_at: VALID_DATE,
    updated_at: null,
    ...overrides,
  };
}

// ==========================================================================
// AC-1: Verdicts recorded with applies_to_version, distinct from disposition
// ==========================================================================

describe("AC-1: Verdict recording with version context", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-1
  it("records verdict with applies_to_version for code subject", () => {
    const review = makeReview({ subject: codeSubject() });
    const updated = submitVerdict(review, {
      reviewer: "alice@example.com",
      decision: "approve",
    });

    expect(updated.verdicts).toHaveLength(1);
    const verdict = updated.verdicts[0];
    expect(verdict.reviewer).toBe("alice@example.com");
    expect(verdict.decision).toBe("approve");
    expect(verdict.applies_to_version).toEqual({
      type: "code_compare",
      base_commit: COMMIT_BASE,
      head_commit: COMMIT_HEAD,
    });
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-1
  it("records verdict with applies_to_version for entity subject", () => {
    const review = makeReview({ subject: taskSubject() });
    const updated = submitVerdict(review, {
      reviewer: "bob@example.com",
      decision: "request_changes",
    });

    expect(updated.verdicts).toHaveLength(1);
    const verdict = updated.verdicts[0];
    expect(verdict.applies_to_version).toEqual({
      type: "entity_version",
      content_hash: CONTENT_HASH_1,
    });
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-1
  it("verdicts are stored distinctly from the overall review disposition", () => {
    const review = makeReview();
    const updated = submitVerdict(review, {
      reviewer: "alice@example.com",
      decision: "approve",
    });

    // Verdict is stored in the verdicts array
    expect(updated.verdicts).toHaveLength(1);
    // Disposition is computed, not stored on the record
    const disposition = computeDisposition(updated);
    expect(disposition).toBe("approved");
    // The record itself has no stored disposition field — it is computed
    expect((updated as Record<string, unknown>).disposition).toBeUndefined();
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-1
  it("records comment verdict without blocking", () => {
    const review = makeReview();
    const updated = submitVerdict(review, {
      reviewer: "carol@example.com",
      decision: "comment",
    });

    expect(updated.verdicts[0].decision).toBe("comment");
    // Comment alone should not make disposition approved
    expect(computeDisposition(updated)).toBe("pending");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-1
  it("appends verdict_submitted event to audit log", () => {
    const review = makeReview();
    const updated = submitVerdict(review, {
      reviewer: "alice@example.com",
      decision: "approve",
    });

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].event_type).toBe("verdict_submitted");
    expect(updated.events[0].actor).toBe("alice@example.com");
    expect(updated.events[0].payload).toMatchObject({
      decision: "approve",
    });
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-1
  it("records verdict on external subject using synthetic version", () => {
    const externalSubject: ReviewSubject = {
      type: "external",
      url: "https://example.com/review/1",
    };
    const review = makeReview({ subject: externalSubject });
    const updated = submitVerdict(review, {
      reviewer: "alice@example.com",
      decision: "approve",
    });

    // External subjects get a synthetic entity_version from extractSubjectVersion
    expect(updated.verdicts).toHaveLength(1);
    expect(updated.verdicts[0].applies_to_version.type).toBe("entity_version");
  });
});

// ==========================================================================
// AC-2: Thread resolution with timestamp and actor
// ==========================================================================

describe("AC-2: Thread resolution", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-2
  it("marks a thread as resolved with timestamp and actor", () => {
    const thread = makeThread({ _ulid: ULID_THREAD_1, kind: "blocker" });
    const review = makeReview({ threads: [thread] });

    const updated = resolveThread(review, {
      threadUlid: ULID_THREAD_1,
      actor: "fixer@example.com",
    });

    const resolved = updated.threads[0];
    expect(resolved.resolved_at).toBeTruthy();
    expect(resolved.resolved_by).toBe("fixer@example.com");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-2
  it("records thread_resolved event", () => {
    const thread = makeThread({ _ulid: ULID_THREAD_1, kind: "blocker" });
    const review = makeReview({ threads: [thread] });

    const updated = resolveThread(review, {
      threadUlid: ULID_THREAD_1,
      actor: "fixer@example.com",
    });

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].event_type).toBe("thread_resolved");
    expect(updated.events[0].actor).toBe("fixer@example.com");
    expect(updated.events[0].payload).toMatchObject({
      thread_ulid: ULID_THREAD_1,
    });
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-2
  it("throws when thread not found", () => {
    const review = makeReview({ threads: [] });
    expect(() =>
      resolveThread(review, {
        threadUlid: ULID_THREAD_1,
        actor: "actor@example.com",
      }),
    ).toThrow("Thread not found");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-2
  it("can reopen a resolved thread", () => {
    const thread = makeThread({
      _ulid: ULID_THREAD_1,
      resolved_at: VALID_DATE,
      resolved_by: "someone@example.com",
    });
    const review = makeReview({ threads: [thread] });

    const updated = reopenThread(review, {
      threadUlid: ULID_THREAD_1,
      actor: "reviewer@example.com",
    });

    expect(updated.threads[0].resolved_at).toBeNull();
    expect(updated.threads[0].resolved_by).toBeNull();
    expect(updated.events[0].event_type).toBe("thread_reopened");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-2
  it("does not mutate other threads when resolving one", () => {
    const thread1 = makeThread({ _ulid: ULID_THREAD_1, kind: "blocker" });
    const thread2 = makeThread({ _ulid: ULID_THREAD_2, kind: "nit" });
    const review = makeReview({ threads: [thread1, thread2] });

    const updated = resolveThread(review, {
      threadUlid: ULID_THREAD_1,
      actor: "actor@example.com",
    });

    expect(updated.threads[0].resolved_at).toBeTruthy();
    expect(updated.threads[1].resolved_at).toBeUndefined();
  });
});

// ==========================================================================
// Subject refresh and stale verdict handling (supports ac-7)
// ==========================================================================

describe("subject refresh and stale verdict handling", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("tracks subject refresh through event log", () => {
    const review = makeReview({ subject: codeSubject() });
    const newSubject = codeSubject(COMMIT_BASE_2, COMMIT_HEAD_2);

    const updated = refreshSubject(review, newSubject, "ci@example.com");

    expect(updated.subject).toEqual(newSubject);
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].event_type).toBe("subject_refreshed");
    expect(updated.events[0].payload).toMatchObject({
      previous_version: {
        type: "code_compare",
        base_commit: COMMIT_BASE,
        head_commit: COMMIT_HEAD,
      },
      new_version: {
        type: "code_compare",
        base_commit: COMMIT_BASE_2,
        head_commit: COMMIT_HEAD_2,
      },
    });
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("preserves full audit trail across review → changes_requested → re-review", () => {
    let review = makeReview({ subject: codeSubject() });

    // First cycle: reviewer requests changes
    review = submitVerdict(review, {
      reviewer: "reviewer@example.com",
      decision: "request_changes",
    });
    expect(computeDisposition(review)).toBe("changes_requested");

    // Author pushes fixes — subject updated
    const newSubject = codeSubject(COMMIT_BASE, COMMIT_HEAD_2);
    review = refreshSubject(review, newSubject, "author@example.com");

    // After refresh, old verdict is stale — disposition goes to pending
    expect(computeDisposition(review)).toBe("pending");

    // Re-review: reviewer approves new version
    review = submitVerdict(review, {
      reviewer: "reviewer@example.com",
      decision: "approve",
    });
    expect(computeDisposition(review)).toBe("approved");

    // All events are preserved
    expect(review.events).toHaveLength(3);
    expect(review.events.map((e) => e.event_type)).toEqual([
      "verdict_submitted",
      "subject_refreshed",
      "verdict_submitted",
    ]);

    // Both verdicts are preserved (old stale + new current)
    expect(review.verdicts).toHaveLength(2);
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("preserves entity subject re-review cycle", () => {
    let review = makeReview({ subject: taskSubject(CONTENT_HASH_1) });

    review = submitVerdict(review, {
      reviewer: "reviewer@example.com",
      decision: "request_changes",
    });
    expect(computeDisposition(review)).toBe("changes_requested");

    // Entity updated with new content hash
    const newSubject = taskSubject(CONTENT_HASH_2);
    review = refreshSubject(review, newSubject, "author@example.com");

    // Old verdict stale
    expect(computeDisposition(review)).toBe("pending");

    review = submitVerdict(review, {
      reviewer: "reviewer@example.com",
      decision: "approve",
    });
    expect(computeDisposition(review)).toBe("approved");

    // Full history preserved
    expect(review.verdicts).toHaveLength(2);
    expect(review.events).toHaveLength(3);
  });
});

// ==========================================================================
// AC-4: Blockers prevent approval
// ==========================================================================

describe("AC-4: Blockers prevent approved disposition", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("failing required gate prevents approval even with approve verdict", () => {
    const review = makeReview({
      verdicts: [makeVerdict({ decision: "approve" })],
      checks: [makeCheck({ name: "ci", status: "fail", required: true })],
    });

    expect(computeDisposition(review)).toBe("changes_requested");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("unresolved blocker thread prevents approval", () => {
    const blockerThread = makeThread({
      _ulid: ULID_THREAD_1,
      kind: "blocker",
    });
    const review = makeReview({
      verdicts: [makeVerdict({ decision: "approve" })],
      threads: [blockerThread],
    });

    expect(computeDisposition(review)).toBe("changes_requested");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("resolved blocker thread does not prevent approval", () => {
    const resolvedBlocker = makeThread({
      _ulid: ULID_THREAD_1,
      kind: "blocker",
      resolved_at: VALID_DATE_2,
      resolved_by: "fixer@example.com",
    });
    const review = makeReview({
      verdicts: [makeVerdict({ decision: "approve" })],
      threads: [resolvedBlocker],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("blocking change request prevents approval", () => {
    const review = makeReview({
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
          created_at: VALID_DATE,
        }),
        makeVerdict({
          reviewer: "bob@example.com",
          decision: "request_changes",
          created_at: VALID_DATE_2,
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("changes_requested");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("unresolved nit thread does not block approval", () => {
    const nitThread = makeThread({ _ulid: ULID_THREAD_1, kind: "nit" });
    const review = makeReview({
      verdicts: [makeVerdict({ decision: "approve" })],
      threads: [nitThread],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("unresolved question thread does not block approval", () => {
    const questionThread = makeThread({
      _ulid: ULID_THREAD_1,
      kind: "question",
    });
    const review = makeReview({
      verdicts: [makeVerdict({ decision: "approve" })],
      threads: [questionThread],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-idea-threads ac-idea-never-blocks
  it("unresolved idea thread does not block approval when gates pass and approval is current", () => {
    const ideaThread = makeThread({
      _ulid: ULID_THREAD_1,
      kind: "idea",
    });
    const review = makeReview({
      verdicts: [makeVerdict({ decision: "approve" })],
      checks: [makeCheck({ name: "ci", status: "pass", required: true })],
      threads: [ideaThread],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("multiple blockers all prevent approval", () => {
    const blockerThread = makeThread({
      _ulid: ULID_THREAD_1,
      kind: "blocker",
    });
    const review = makeReview({
      verdicts: [
        makeVerdict({
          reviewer: "bob@example.com",
          decision: "request_changes",
        }),
      ],
      checks: [makeCheck({ name: "ci", status: "fail", required: true })],
      threads: [blockerThread],
    });

    expect(computeDisposition(review)).toBe("changes_requested");
  });
});

// ==========================================================================
// AC-5: Aggregate disposition rule
// ==========================================================================

describe("AC-5: Default aggregation rule", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("changes_requested matching current version blocks approval", () => {
    const review = makeReview({
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
        }),
        makeVerdict({
          reviewer: "bob@example.com",
          decision: "request_changes",
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("changes_requested");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("at least one approve required for approved disposition", () => {
    const review = makeReview({
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "comment",
        }),
      ],
    });

    // Comment alone is not an approval
    expect(computeDisposition(review)).toBe("pending");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("single approve with no blockers yields approved", () => {
    const review = makeReview({
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("no verdicts at all yields pending", () => {
    const review = makeReview();
    expect(computeDisposition(review)).toBe("pending");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("code subject version matching uses both base and head", () => {
    // Verdict matches head but not base → stale
    const review = makeReview({
      subject: codeSubject(COMMIT_BASE, COMMIT_HEAD),
      verdicts: [
        makeVerdict({
          decision: "approve",
          applies_to_version: codeVersion(COMMIT_BASE_2, COMMIT_HEAD),
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("pending");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("entity subject matching uses content_hash", () => {
    const review = makeReview({
      subject: taskSubject(CONTENT_HASH_1),
      verdicts: [
        makeVerdict({
          decision: "approve",
          applies_to_version: entityVersion(CONTENT_HASH_1),
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("entity subject with mismatched hash treats verdict as stale", () => {
    const review = makeReview({
      subject: taskSubject(CONTENT_HASH_2),
      verdicts: [
        makeVerdict({
          decision: "approve",
          applies_to_version: entityVersion(CONTENT_HASH_1),
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("pending");
  });
});

// ==========================================================================
// AC-6: Verdict schema includes reviewer, role, timestamp
// ==========================================================================

describe("AC-6: Verdict schema fields", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-6
  it("verdict includes reviewer identity string", () => {
    const review = makeReview();
    const updated = submitVerdict(review, {
      reviewer: "agent-reviewer",
      decision: "approve",
    });

    expect(updated.verdicts[0].reviewer).toBe("agent-reviewer");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-6
  it("verdict includes role with default value", () => {
    const review = makeReview();
    const updated = submitVerdict(review, {
      reviewer: "alice@example.com",
      decision: "approve",
    });

    expect(updated.verdicts[0].role).toBe("reviewer");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-6
  it("verdict accepts custom role", () => {
    const review = makeReview();
    const updated = submitVerdict(review, {
      reviewer: "lead@example.com",
      decision: "approve",
      role: "lead",
    });

    expect(updated.verdicts[0].role).toBe("lead");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-6
  it("verdict includes timestamp", () => {
    const review = makeReview();
    const updated = submitVerdict(review, {
      reviewer: "alice@example.com",
      decision: "approve",
    });

    expect(updated.verdicts[0].created_at).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(updated.verdicts[0].created_at).toISOString()).toBe(
      updated.verdicts[0].created_at,
    );
  });
});

// ==========================================================================
// AC-7: Stale verdicts excluded from aggregation
// ==========================================================================

describe("AC-7: Stale verdict exclusion", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("excludes stale verdicts from effective set (code subject)", () => {
    const currentVersion = codeVersion(COMMIT_BASE, COMMIT_HEAD);
    const staleVersion = codeVersion(COMMIT_BASE, COMMIT_HEAD_2);

    const verdicts: ReviewVerdict[] = [
      makeVerdict({
        reviewer: "alice@example.com",
        decision: "approve",
        applies_to_version: staleVersion,
      }),
    ];

    const effective = getEffectiveVerdicts(verdicts, currentVersion);
    expect(effective).toHaveLength(0);
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("excludes stale verdicts from effective set (entity subject)", () => {
    const currentVersion = entityVersion(CONTENT_HASH_2);
    const staleVersion = entityVersion(CONTENT_HASH_1);

    const verdicts: ReviewVerdict[] = [
      makeVerdict({
        reviewer: "alice@example.com",
        decision: "approve",
        applies_to_version: staleVersion,
      }),
    ];

    const effective = getEffectiveVerdicts(verdicts, currentVersion);
    expect(effective).toHaveLength(0);
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("stale approve does not contribute to disposition", () => {
    const review = makeReview({
      subject: codeSubject(COMMIT_BASE, COMMIT_HEAD),
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD_2),
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("pending");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("stale changes_requested does not block approval", () => {
    const review = makeReview({
      subject: codeSubject(COMMIT_BASE, COMMIT_HEAD),
      verdicts: [
        // Stale request_changes (old version)
        makeVerdict({
          reviewer: "bob@example.com",
          decision: "request_changes",
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD_2),
          created_at: VALID_DATE,
        }),
        // Fresh approve (current version)
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD),
          created_at: VALID_DATE_2,
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("checks are also subject to staleness — stale check means gate unverified", () => {
    const review = makeReview({
      subject: codeSubject(COMMIT_BASE, COMMIT_HEAD),
      verdicts: [makeVerdict({ decision: "approve" })],
      checks: [
        makeCheck({
          name: "ci",
          status: "fail",
          required: true,
          // Stale check — ran against old version
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD_2),
        }),
      ],
    });

    // Required check has only stale runs → gate is not verified on current version → blocks
    expect(computeDisposition(review)).toBe("changes_requested");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-7
  it("stale check does not block when fresh passing run exists", () => {
    const review = makeReview({
      subject: codeSubject(COMMIT_BASE, COMMIT_HEAD),
      verdicts: [makeVerdict({ decision: "approve" })],
      checks: [
        makeCheck({
          name: "ci",
          status: "fail",
          required: true,
          // Stale check — ran against old version
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD_2),
          created_at: VALID_DATE,
        }),
        makeCheck({
          name: "ci",
          status: "pass",
          required: true,
          // Fresh check — matches current version
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD),
          created_at: VALID_DATE_2,
        }),
      ],
    });

    // Fresh passing run exists → stale failure doesn't matter
    expect(computeDisposition(review)).toBe("approved");
  });
});

// ==========================================================================
// AC-8: Latest verdict per reviewer
// ==========================================================================

describe("AC-8: Latest verdict per reviewer wins", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-8
  it("later approve from same reviewer overrides earlier request_changes", () => {
    const review = makeReview({
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "request_changes",
          created_at: VALID_DATE,
        }),
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
          created_at: VALID_DATE_2,
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("approved");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-8
  it("later request_changes overrides earlier approve", () => {
    const review = makeReview({
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
          created_at: VALID_DATE,
        }),
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "request_changes",
          created_at: VALID_DATE_2,
        }),
      ],
    });

    expect(computeDisposition(review)).toBe("changes_requested");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-8
  it("keeps latest per reviewer independently", () => {
    const review = makeReview({
      verdicts: [
        // Alice: request_changes then approve
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "request_changes",
          created_at: VALID_DATE,
        }),
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
          created_at: VALID_DATE_2,
        }),
        // Bob: approve only
        makeVerdict({
          reviewer: "bob@example.com",
          decision: "approve",
          created_at: VALID_DATE,
        }),
      ],
    });

    const effective = getEffectiveVerdicts(review.verdicts, extractSubjectVersion(review.subject));
    expect(effective).toHaveLength(2);
    expect(effective.find((v) => v.reviewer === "alice@example.com")?.decision).toBe("approve");
    expect(effective.find((v) => v.reviewer === "bob@example.com")?.decision).toBe("approve");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-8
  it("only considers current-version verdicts for latest calculation", () => {
    // Alice: old-version approve, then current-version request_changes
    const review = makeReview({
      subject: codeSubject(COMMIT_BASE, COMMIT_HEAD),
      verdicts: [
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "approve",
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD_2), // stale
          created_at: VALID_DATE_3, // most recent timestamp but stale version
        }),
        makeVerdict({
          reviewer: "alice@example.com",
          decision: "request_changes",
          applies_to_version: codeVersion(COMMIT_BASE, COMMIT_HEAD), // current
          created_at: VALID_DATE,
        }),
      ],
    });

    // Even though the approve is newer by timestamp, it's stale
    // Only the current-version request_changes counts
    expect(computeDisposition(review)).toBe("changes_requested");
  });
});

// ==========================================================================
// AC-9: Lifecycle finalization (closed/archived)
// ==========================================================================

describe("AC-9: Lifecycle finalization", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-9
  it("transitions from open to closed", () => {
    const review = makeReview({ lifecycle_state: "open" });
    const updated = transitionLifecycle(review, "closed", "admin@example.com");

    expect(updated.lifecycle_state).toBe("closed");
    expect(updated.events).toHaveLength(1);
    expect(updated.events[0].event_type).toBe("lifecycle_change");
    expect(updated.events[0].payload).toMatchObject({
      from: "open",
      to: "closed",
    });
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-9
  it("transitions from closed to archived", () => {
    const review = makeReview({ lifecycle_state: "closed" });
    const updated = transitionLifecycle(review, "archived", "admin@example.com");

    expect(updated.lifecycle_state).toBe("archived");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-9
  it("transitions from draft to open", () => {
    const review = makeReview({ lifecycle_state: "draft" });
    const updated = transitionLifecycle(review, "open", "author@example.com");

    expect(updated.lifecycle_state).toBe("open");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-9
  it("transitions from draft to closed", () => {
    const review = makeReview({ lifecycle_state: "draft" });
    const updated = transitionLifecycle(review, "closed", "author@example.com");

    expect(updated.lifecycle_state).toBe("closed");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-9
  it("allows reopening a closed review", () => {
    const review = makeReview({ lifecycle_state: "closed" });
    const updated = transitionLifecycle(review, "open", "admin@example.com");

    expect(updated.lifecycle_state).toBe("open");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-9
  it("rejects invalid transitions", () => {
    const openReview = makeReview({ lifecycle_state: "open" });
    expect(() => transitionLifecycle(openReview, "draft", "admin@example.com")).toThrow(
      "Invalid lifecycle transition: open → draft",
    );

    const archivedReview = makeReview({ lifecycle_state: "archived" });
    expect(() => transitionLifecycle(archivedReview, "open", "admin@example.com")).toThrow(
      "Invalid lifecycle transition: archived → open",
    );
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-9
  it("archived is a terminal state", () => {
    const review = makeReview({ lifecycle_state: "archived" });

    expect(() => transitionLifecycle(review, "open", "admin@example.com")).toThrow(
      "Invalid lifecycle transition",
    );
    expect(() => transitionLifecycle(review, "closed", "admin@example.com")).toThrow(
      "Invalid lifecycle transition",
    );
  });
});

// ==========================================================================
// Gate evaluation (delegates to evaluateGates from review/checks)
// ==========================================================================

describe("Gate evaluation via evaluateGates", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("returns passing when no required checks exist", () => {
    const result = evaluateGates([], codeVersion());
    expect(result.state).toBe("passing");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("returns passing when all required checks pass", () => {
    const checks: ReviewCheck[] = [
      makeCheck({ name: "tests", status: "pass", required: true }),
      makeCheck({ name: "lint", status: "pass", required: true }),
    ];

    expect(evaluateGates(checks, codeVersion()).state).toBe("passing");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("returns failing when any required check fails", () => {
    const checks: ReviewCheck[] = [
      makeCheck({ name: "tests", status: "pass", required: true }),
      makeCheck({ name: "lint", status: "fail", required: true }),
    ];

    expect(evaluateGates(checks, codeVersion()).state).toBe("failing");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("returns pending when required check is running", () => {
    const checks: ReviewCheck[] = [makeCheck({ name: "tests", status: "running", required: true })];

    expect(evaluateGates(checks, codeVersion()).state).toBe("pending");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("ignores non-required checks for gate evaluation", () => {
    const checks: ReviewCheck[] = [
      makeCheck({ name: "tests", status: "pass", required: true }),
      makeCheck({ name: "advisory", status: "fail", required: false }),
    ];

    expect(evaluateGates(checks, codeVersion()).state).toBe("passing");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("uses latest check per name", () => {
    const checks: ReviewCheck[] = [
      makeCheck({
        name: "tests",
        status: "fail",
        required: true,
        created_at: VALID_DATE,
      }),
      makeCheck({
        name: "tests",
        status: "pass",
        required: true,
        created_at: VALID_DATE_2,
      }),
    ];

    expect(evaluateGates(checks, codeVersion()).state).toBe("passing");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("treats stale-only required check as gate failure (unverified)", () => {
    const staleVersion = codeVersion(COMMIT_BASE, COMMIT_HEAD_2);
    const currentVersion = codeVersion(COMMIT_BASE, COMMIT_HEAD);

    const checks: ReviewCheck[] = [
      makeCheck({
        name: "tests",
        status: "fail",
        required: true,
        applies_to_version: staleVersion,
      }),
    ];

    // Required check with only stale runs → gate not verified → failing
    expect(evaluateGates(checks, currentVersion).state).toBe("failing");
  });

  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("fresh passing run supersedes stale failure for same check", () => {
    const staleVersion = codeVersion(COMMIT_BASE, COMMIT_HEAD_2);
    const currentVersion = codeVersion(COMMIT_BASE, COMMIT_HEAD);

    const checks: ReviewCheck[] = [
      makeCheck({
        name: "tests",
        status: "fail",
        required: true,
        applies_to_version: staleVersion,
        created_at: VALID_DATE,
      }),
      makeCheck({
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: currentVersion,
        created_at: VALID_DATE_2,
      }),
    ];

    expect(evaluateGates(checks, currentVersion).state).toBe("passing");
  });
});

// ==========================================================================
// Subject version extraction (delegates to extractSubjectVersion)
// ==========================================================================

describe("extractSubjectVersion", () => {
  it("extracts code_compare version from code subject", () => {
    const version = extractSubjectVersion(codeSubject());
    expect(version).toEqual({
      type: "code_compare",
      base_commit: COMMIT_BASE,
      head_commit: COMMIT_HEAD,
    });
  });

  it("extracts entity_version from task subject", () => {
    const version = extractSubjectVersion(taskSubject());
    expect(version).toEqual({
      type: "entity_version",
      content_hash: CONTENT_HASH_1,
    });
  });

  it("extracts entity_version from plan subject", () => {
    const subject: ReviewSubject = {
      type: "plan",
      ref: "@my-plan",
      shadow_commit: COMMIT_BASE,
      content_hash: CONTENT_HASH_1,
    };
    const version = extractSubjectVersion(subject);
    expect(version).toEqual({
      type: "entity_version",
      content_hash: CONTENT_HASH_1,
    });
  });

  it("extracts entity_version from spec subject", () => {
    const subject: ReviewSubject = {
      type: "spec",
      ref: "@my-spec",
      shadow_commit: COMMIT_BASE,
      content_hash: CONTENT_HASH_1,
    };
    const version = extractSubjectVersion(subject);
    expect(version).toEqual({
      type: "entity_version",
      content_hash: CONTENT_HASH_1,
    });
  });

  it("returns synthetic entity_version for external subject", () => {
    const subject: ReviewSubject = {
      type: "external",
      url: "https://example.com/review/1",
    };
    const version = extractSubjectVersion(subject);
    expect(version.type).toBe("entity_version");
    // External subjects get a synthetic content_hash from the URL
    expect((version as { type: "entity_version"; content_hash: string }).content_hash).toBeTruthy();
  });
});

// ==========================================================================
// isVersionStale (delegates to review/subject-bindings)
// ==========================================================================

describe("isVersionStale", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-5
  it("returns not stale when code versions match both base and head", () => {
    expect(isVersionStale(codeVersion(), codeVersion()).stale).toBe(false);
  });

  it("returns stale when base_commit differs", () => {
    expect(
      isVersionStale(codeVersion(COMMIT_BASE_2, COMMIT_HEAD), codeVersion(COMMIT_BASE, COMMIT_HEAD))
        .stale,
    ).toBe(true);
  });

  it("returns stale when head_commit differs", () => {
    expect(
      isVersionStale(codeVersion(COMMIT_BASE, COMMIT_HEAD_2), codeVersion(COMMIT_BASE, COMMIT_HEAD))
        .stale,
    ).toBe(true);
  });

  it("returns not stale when entity content_hash matches", () => {
    expect(isVersionStale(entityVersion(), entityVersion()).stale).toBe(false);
  });

  it("returns stale when entity content_hash differs", () => {
    expect(isVersionStale(entityVersion(CONTENT_HASH_1), entityVersion(CONTENT_HASH_2)).stale).toBe(
      true,
    );
  });

  it("returns stale when version types mismatch", () => {
    expect(isVersionStale(codeVersion(), entityVersion()).stale).toBe(true);
  });
});

// ==========================================================================
// getUnresolvedBlockers (delegates to parser/review-threads)
// ==========================================================================

describe("getUnresolvedBlockers", () => {
  // AC: @review-verdicts-and-resolution-lifecycle ac-4
  it("returns empty for review with no threads", () => {
    const review = makeReview({ threads: [] });
    expect(getUnresolvedBlockers(review)).toHaveLength(0);
  });

  it("returns empty when only nit threads are unresolved", () => {
    const review = makeReview({
      threads: [makeThread({ kind: "nit" })],
    });
    expect(getUnresolvedBlockers(review)).toHaveLength(0);
  });

  it("returns blocker thread when unresolved", () => {
    const review = makeReview({
      threads: [makeThread({ kind: "blocker" })],
    });
    expect(getUnresolvedBlockers(review)).toHaveLength(1);
  });

  it("returns empty when all blocker threads are resolved", () => {
    const review = makeReview({
      threads: [
        makeThread({
          kind: "blocker",
          resolved_at: VALID_DATE_2,
          resolved_by: "fixer@example.com",
        }),
      ],
    });
    expect(getUnresolvedBlockers(review)).toHaveLength(0);
  });
});

// ==========================================================================
// Integration: full review lifecycle
// ==========================================================================

describe("Integration: full review lifecycle", () => {
  it("handles complete review cycle: draft → open → changes → re-review → approved → closed → archived", () => {
    // Draft review created
    let review = makeReview({ lifecycle_state: "draft" });

    // Open the review
    review = transitionLifecycle(review, "open", "author@example.com");
    expect(review.lifecycle_state).toBe("open");

    // Reviewer requests changes
    review = submitVerdict(review, {
      reviewer: "reviewer@example.com",
      decision: "request_changes",
    });
    expect(computeDisposition(review)).toBe("changes_requested");

    // Author pushes fixes
    const newSubject = codeSubject(COMMIT_BASE, COMMIT_HEAD_2);
    review = refreshSubject(review, newSubject, "author@example.com");
    expect(computeDisposition(review)).toBe("pending");

    // Reviewer approves new version
    review = submitVerdict(review, {
      reviewer: "reviewer@example.com",
      decision: "approve",
    });
    expect(computeDisposition(review)).toBe("approved");

    // Close the review
    review = transitionLifecycle(review, "closed", "admin@example.com");
    expect(review.lifecycle_state).toBe("closed");

    // Archive the review
    review = transitionLifecycle(review, "archived", "admin@example.com");
    expect(review.lifecycle_state).toBe("archived");

    // Full audit trail preserved: open + verdict + refresh + verdict + close + archive
    expect(review.events).toHaveLength(6);
    expect(review.verdicts).toHaveLength(2);
  });
});
