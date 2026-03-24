import { describe, it, expect } from "vitest";
import {
  createCodeSubject,
  createPlanSubject,
  createTaskSubject,
  createSpecSubject,
  createExternalSubject,
  extractSubjectVersion,
  isVersionStale,
  findStaleChecks,
  findStaleVerdicts,
} from "../src/review/subject-bindings.js";
import { computeContentHash } from "../src/parser/skill-render.js";
import { ReviewSubjectSchema, ReviewSubjectVersionSchema } from "../src/schema/review-records.js";
import type {
  ReviewCheck,
  ReviewVerdict,
  ReviewSubjectVersion,
} from "../src/schema/review-records.js";

const VALID_COMMIT = "abc123def456";
const VALID_COMMIT_2 = "def456ghi789";
const VALID_COMMIT_3 = "111222333444";
const VALID_DATE = "2026-03-14T00:00:00.000Z";

// --- AC-1: Subject type + stable ref or external identity ---

describe("Subject binding factories", () => {
  // AC: @review-subject-bindings ac-1
  it("createCodeSubject captures type and commit identity", () => {
    const subject = createCodeSubject({
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    });
    expect(subject.type).toBe("code");
    expect(subject.base_commit).toBe(VALID_COMMIT);
    expect(subject.head_commit).toBe(VALID_COMMIT_2);
    // Validates against schema
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
  });

  // AC: @review-subject-bindings ac-1
  it("createPlanSubject captures type and stable local ref", () => {
    const hash = computeContentHash("plan content");
    const subject = createPlanSubject({
      ref: "@my-plan",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    expect(subject.type).toBe("plan");
    expect(subject.ref).toBe("@my-plan");
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
  });

  // AC: @review-subject-bindings ac-1
  it("createTaskSubject captures type and stable local ref", () => {
    const hash = computeContentHash("task content");
    const subject = createTaskSubject({
      ref: "@my-task",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    expect(subject.type).toBe("task");
    expect(subject.ref).toBe("@my-task");
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
  });

  // AC: @review-subject-bindings ac-1
  it("createSpecSubject captures type and stable local ref", () => {
    const hash = computeContentHash("spec content");
    const subject = createSpecSubject({
      ref: "@my-spec",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    expect(subject.type).toBe("spec");
    expect(subject.ref).toBe("@my-spec");
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
  });

  // AC: @review-subject-bindings ac-1
  it("createExternalSubject captures type and external identity", () => {
    const subject = createExternalSubject({
      url: "https://github.com/org/repo/pull/42",
      external_id: "42",
      provider: "github",
    });
    expect(subject.type).toBe("external");
    expect(subject.url).toBe("https://github.com/org/repo/pull/42");
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
  });

  // AC: @review-subject-bindings ac-1
  it("createExternalSubject works with URL only", () => {
    const subject = createExternalSubject({
      url: "https://example.com/review/123",
    });
    expect(subject.type).toBe("external");
    expect(subject.external_id).toBeUndefined();
    expect(subject.provider).toBeUndefined();
    expect(ReviewSubjectSchema.safeParse(subject).success).toBe(true);
  });
});

// --- AC-2: Local ref authoritative, external as linkage metadata ---

describe("Local ref authority", () => {
  // AC: @review-subject-bindings ac-2
  it("plan subject stores local ref as the primary identity", () => {
    const subject = createPlanSubject({
      ref: "@my-plan",
      shadow_commit: VALID_COMMIT,
      content_hash: computeContentHash("content"),
    });
    // ref is the authoritative identity on the subject binding
    expect(subject.ref).toBe("@my-plan");
    // No external_id or provider fields exist on entity subjects
    expect(subject).not.toHaveProperty("external_id");
    expect(subject).not.toHaveProperty("provider");
    expect(subject).not.toHaveProperty("url");
  });

  // AC: @review-subject-bindings ac-2
  it("task subject stores local ref as the primary identity", () => {
    const subject = createTaskSubject({
      ref: "@my-task",
      shadow_commit: VALID_COMMIT,
      content_hash: computeContentHash("content"),
    });
    expect(subject.ref).toBe("@my-task");
    expect(subject).not.toHaveProperty("external_id");
    expect(subject).not.toHaveProperty("url");
  });

  // AC: @review-subject-bindings ac-2
  it("spec subject stores local ref as the primary identity", () => {
    const subject = createSpecSubject({
      ref: "@my-spec",
      shadow_commit: VALID_COMMIT,
      content_hash: computeContentHash("content"),
    });
    expect(subject.ref).toBe("@my-spec");
    expect(subject).not.toHaveProperty("external_id");
    expect(subject).not.toHaveProperty("url");
  });

  // AC: @review-subject-bindings ac-2
  it("external subject keeps external identifiers as linkage metadata", () => {
    const subject = createExternalSubject({
      url: "https://github.com/org/repo/pull/42",
      external_id: "42",
      provider: "github",
    });
    // external_id and provider are metadata, not authoritative identity
    expect(subject.external_id).toBe("42");
    expect(subject.provider).toBe("github");
    // No local ref field on external subjects
    expect(subject).not.toHaveProperty("ref");
  });
});

// --- AC-3: Code subject stores commit context, branches as metadata ---

describe("Code subject compare semantics", () => {
  // AC: @review-subject-bindings ac-3
  it("stores base_commit and head_commit as the frozen compare context", () => {
    const subject = createCodeSubject({
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    });
    expect(subject.base_commit).toBe(VALID_COMMIT);
    expect(subject.head_commit).toBe(VALID_COMMIT_2);
    expect(subject.merge_base_commit).toBeUndefined();
  });

  // AC: @review-subject-bindings ac-3
  it("stores optional merge_base_commit as part of the compare context", () => {
    const subject = createCodeSubject({
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
      merge_base_commit: VALID_COMMIT_3,
    });
    expect(subject.merge_base_commit).toBe(VALID_COMMIT_3);
  });

  // AC: @review-subject-bindings ac-3
  it("stores branch names as optional metadata, not authoritative identity", () => {
    const subject = createCodeSubject({
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
      base_branch: "main",
      head_branch: "feat/review-system",
    });
    expect(subject.base_branch).toBe("main");
    expect(subject.head_branch).toBe("feat/review-system");
    // Branches are optional metadata — the subject is still valid without them
    const subjectNoBranches = createCodeSubject({
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    });
    expect(subjectNoBranches.base_branch).toBeUndefined();
    expect(subjectNoBranches.head_branch).toBeUndefined();
    expect(ReviewSubjectSchema.safeParse(subjectNoBranches).success).toBe(true);
  });

  // AC: @review-subject-bindings ac-3
  it("extracts code_compare version from code subject", () => {
    const subject = createCodeSubject({
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
      base_branch: "main",
      head_branch: "feat/foo",
    });
    const version = extractSubjectVersion(subject);
    expect(version.type).toBe("code_compare");
    if (version.type === "code_compare") {
      expect(version.base_commit).toBe(VALID_COMMIT);
      expect(version.head_commit).toBe(VALID_COMMIT_2);
    }
    // Branch names do NOT appear in the version — commits are authoritative
    expect(version).not.toHaveProperty("base_branch");
    expect(version).not.toHaveProperty("head_branch");
    expect(ReviewSubjectVersionSchema.safeParse(version).success).toBe(true);
  });
});

// --- AC-4: Shadow branch entity stores shadow_commit + content_hash ---

describe("Shadow branch subject bindings", () => {
  // AC: @review-subject-bindings ac-4
  it("plan subject stores shadow_commit and content_hash", () => {
    const content = "title: My Plan\nstatus: active\n";
    const hash = computeContentHash(content);
    const subject = createPlanSubject({
      ref: "@my-plan",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    expect(subject.shadow_commit).toBe(VALID_COMMIT);
    expect(subject.content_hash).toBe(hash);
  });

  // AC: @review-subject-bindings ac-4
  it("task subject stores shadow_commit and content_hash", () => {
    const content = "title: My Task\nstatus: pending\n";
    const hash = computeContentHash(content);
    const subject = createTaskSubject({
      ref: "@my-task",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    expect(subject.shadow_commit).toBe(VALID_COMMIT);
    expect(subject.content_hash).toBe(hash);
  });

  // AC: @review-subject-bindings ac-4
  it("spec subject stores shadow_commit and content_hash", () => {
    const content = "title: My Spec\ntype: feature\n";
    const hash = computeContentHash(content);
    const subject = createSpecSubject({
      ref: "@my-spec",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    expect(subject.shadow_commit).toBe(VALID_COMMIT);
    expect(subject.content_hash).toBe(hash);
  });

  // AC: @review-subject-bindings ac-4
  it("content hash is stable for same content regardless of shadow branch HEAD", () => {
    const content = "title: My Plan\nstatus: active\n";
    const hash1 = computeContentHash(content);
    const hash2 = computeContentHash(content);
    expect(hash1).toBe(hash2);

    // Same content at different shadow commits produces same content_hash
    const subject1 = createPlanSubject({
      ref: "@my-plan",
      shadow_commit: "commit-aaa",
      content_hash: hash1,
    });
    const subject2 = createPlanSubject({
      ref: "@my-plan",
      shadow_commit: "commit-bbb",
      content_hash: hash2,
    });
    expect(subject1.content_hash).toBe(subject2.content_hash);
  });

  // AC: @review-subject-bindings ac-4
  it("content hash changes when entity content changes", () => {
    const hash1 = computeContentHash("title: Plan v1\n");
    const hash2 = computeContentHash("title: Plan v2\n");
    expect(hash1).not.toBe(hash2);
  });

  // AC: @review-subject-bindings ac-4
  it("review mutations on same shadow branch do not self-invalidate freshness", () => {
    // Scenario: A review mutation commits to shadow branch, changing its HEAD.
    // The entity content_hash stays the same if the reviewed entity is unchanged.
    const entityContent = "title: My Spec\ntype: requirement\n";
    const entityHash = computeContentHash(entityContent);

    // Original subject at shadow commit "aaa"
    const original = createSpecSubject({
      ref: "@my-spec",
      shadow_commit: "aaa",
      content_hash: entityHash,
    });

    // After a review mutation, shadow branch HEAD moves to "bbb"
    // but the spec entity itself hasn't changed
    const afterMutation = createSpecSubject({
      ref: "@my-spec",
      shadow_commit: "bbb",
      content_hash: entityHash, // same content → same hash
    });

    // Staleness is evaluated via content_hash, not shadow_commit
    const originalVersion = extractSubjectVersion(original);
    const afterMutationVersion = extractSubjectVersion(afterMutation);
    const result = isVersionStale(originalVersion, afterMutationVersion);
    expect(result.stale).toBe(false);
  });

  // AC: @review-subject-bindings ac-4
  it("extractSubjectVersion uses content_hash for entity subjects", () => {
    const hash = computeContentHash("content");
    for (const factory of [createPlanSubject, createTaskSubject, createSpecSubject]) {
      const subject = factory({
        ref: "@some-ref",
        shadow_commit: VALID_COMMIT,
        content_hash: hash,
      });
      const version = extractSubjectVersion(subject);
      expect(version.type).toBe("entity_version");
      if (version.type === "entity_version") {
        expect(version.content_hash).toBe(hash);
      }
      // shadow_commit does NOT appear in the version — content_hash is authoritative
      expect(version).not.toHaveProperty("shadow_commit");
    }
  });
});

// --- AC-5: Staleness detection ---

describe("Staleness detection", () => {
  // AC: @review-subject-bindings ac-5
  it("code version is not stale when commits match", () => {
    const version: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    };
    const result = isVersionStale(version, version);
    expect(result.stale).toBe(false);
  });

  // AC: @review-subject-bindings ac-5
  it("code version is stale when head_commit changes", () => {
    const original: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    };
    const updated: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_3,
    };
    const result = isVersionStale(original, updated);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("commits have changed");
  });

  // AC: @review-subject-bindings ac-5
  it("code version is stale when base_commit changes", () => {
    const original: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    };
    const updated: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT_3,
      head_commit: VALID_COMMIT_2,
    };
    const result = isVersionStale(original, updated);
    expect(result.stale).toBe(true);
  });

  // AC: @review-subject-bindings ac-5
  it("entity version is not stale when content_hash matches", () => {
    const hash = computeContentHash("same content");
    const version: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: hash,
    };
    const result = isVersionStale(version, version);
    expect(result.stale).toBe(false);
  });

  // AC: @review-subject-bindings ac-5
  it("entity version is stale when content_hash changes", () => {
    const original: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: computeContentHash("original content"),
    };
    const updated: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: computeContentHash("modified content"),
    };
    const result = isVersionStale(original, updated);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("content hash has changed");
  });

  // AC: @review-subject-bindings ac-5
  it("shadow branch entity uses content_hash for staleness, not shadow commit", () => {
    // This is the key behavior: shadow branch HEAD changes should NOT
    // invalidate a review when the reviewed entity hasn't changed.
    const entityContent = "title: My Task\nstatus: in_progress\n";
    const entityHash = computeContentHash(entityContent);

    const originalVersion: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: entityHash,
    };

    // Shadow branch HEAD changed (new commits for other entities),
    // but THIS entity's content is the same → not stale
    const currentVersion: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: entityHash, // same hash since entity unchanged
    };

    expect(isVersionStale(originalVersion, currentVersion).stale).toBe(false);
  });

  // AC: @review-subject-bindings ac-5
  it("detects staleness when version type changes", () => {
    const codeVersion: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    };
    const entityVersion: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: computeContentHash("content"),
    };
    const result = isVersionStale(codeVersion, entityVersion);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("type changed");
  });
});

describe("findStaleChecks", () => {
  // AC: @review-subject-bindings ac-5
  it("identifies stale checks whose applies_to_version does not match", () => {
    const currentVersion: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_3, // updated head
    };

    const checks: ReviewCheck[] = [
      {
        name: "tests",
        status: "pass",
        required: true,
        applies_to_version: {
          type: "code_compare",
          base_commit: VALID_COMMIT,
          head_commit: VALID_COMMIT_2, // old head → stale
        },
        created_at: VALID_DATE,
      },
      {
        name: "lint",
        status: "pass",
        required: true,
        applies_to_version: {
          type: "code_compare",
          base_commit: VALID_COMMIT,
          head_commit: VALID_COMMIT_3, // matches current → fresh
        },
        created_at: VALID_DATE,
      },
    ];

    const stale = findStaleChecks(checks, currentVersion);
    expect(stale).toHaveLength(1);
    expect(stale[0].check.name).toBe("tests");
    expect(stale[0].index).toBe(0);
    expect(stale[0].result.stale).toBe(true);
  });

  // AC: @review-subject-bindings ac-5
  it("returns empty array when all checks are current", () => {
    const currentVersion: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: computeContentHash("current content"),
    };

    const checks: ReviewCheck[] = [
      {
        name: "spec-alignment",
        status: "pass",
        required: true,
        applies_to_version: currentVersion,
        created_at: VALID_DATE,
      },
    ];

    expect(findStaleChecks(checks, currentVersion)).toHaveLength(0);
  });
});

describe("findStaleVerdicts", () => {
  // AC: @review-subject-bindings ac-5
  it("identifies stale verdicts whose applies_to_version does not match", () => {
    const currentVersion: ReviewSubjectVersion = {
      type: "entity_version",
      content_hash: computeContentHash("updated entity"),
    };

    const verdicts: ReviewVerdict[] = [
      {
        reviewer: "reviewer@example.com",
        role: "reviewer",
        decision: "approve",
        applies_to_version: {
          type: "entity_version",
          content_hash: computeContentHash("original entity"), // old → stale
        },
        created_at: VALID_DATE,
      },
      {
        reviewer: "maintainer@example.com",
        role: "maintainer",
        decision: "approve",
        applies_to_version: currentVersion, // matches → fresh
        created_at: VALID_DATE,
      },
    ];

    const stale = findStaleVerdicts(verdicts, currentVersion);
    expect(stale).toHaveLength(1);
    expect(stale[0].verdict.reviewer).toBe("reviewer@example.com");
    expect(stale[0].index).toBe(0);
    expect(stale[0].result.stale).toBe(true);
  });

  // AC: @review-subject-bindings ac-5
  it("returns empty array when all verdicts are current", () => {
    const currentVersion: ReviewSubjectVersion = {
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    };

    const verdicts: ReviewVerdict[] = [
      {
        reviewer: "lead@example.com",
        role: "reviewer",
        decision: "approve",
        applies_to_version: currentVersion,
        created_at: VALID_DATE,
      },
    ];

    expect(findStaleVerdicts(verdicts, currentVersion)).toHaveLength(0);
  });
});

// --- Content hash computation ---

describe("computeContentHash", () => {
  // AC: @review-subject-bindings ac-4
  it("produces a valid SHA-256 hex string", () => {
    const hash = computeContentHash("test content");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  // AC: @review-subject-bindings ac-4
  it("is deterministic for the same input", () => {
    const input = "title: My Plan\nstatus: active\n";
    expect(computeContentHash(input)).toBe(computeContentHash(input));
  });

  // AC: @review-subject-bindings ac-4
  it("produces different hashes for different inputs", () => {
    expect(computeContentHash("input a")).not.toBe(computeContentHash("input b"));
  });
});

// --- extractSubjectVersion ---

describe("extractSubjectVersion", () => {
  // AC: @review-subject-bindings ac-3
  it("extracts code_compare version from code subject", () => {
    const subject = createCodeSubject({
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    });
    const version = extractSubjectVersion(subject);
    expect(version).toEqual({
      type: "code_compare",
      base_commit: VALID_COMMIT,
      head_commit: VALID_COMMIT_2,
    });
  });

  // AC: @review-subject-bindings ac-4
  it("extracts entity_version from plan subject", () => {
    const hash = computeContentHash("plan data");
    const subject = createPlanSubject({
      ref: "@plan",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    const version = extractSubjectVersion(subject);
    expect(version).toEqual({
      type: "entity_version",
      content_hash: hash,
    });
  });

  // AC: @review-subject-bindings ac-4
  it("extracts entity_version from task subject", () => {
    const hash = computeContentHash("task data");
    const subject = createTaskSubject({
      ref: "@task",
      shadow_commit: VALID_COMMIT,
      content_hash: hash,
    });
    const version = extractSubjectVersion(subject);
    expect(version).toEqual({
      type: "entity_version",
      content_hash: hash,
    });
  });

  // AC: @review-subject-bindings ac-1
  it("extracts entity_version from external subject", () => {
    const subject = createExternalSubject({
      url: "https://example.com/review",
    });
    const version = extractSubjectVersion(subject);
    expect(version.type).toBe("entity_version");
    expect(ReviewSubjectVersionSchema.safeParse(version).success).toBe(true);
  });
});
