/**
 * Review CLI command tests
 *
 * AC: @review-cli-commands ac-1 — CLI provides commands for core review workflow
 * AC: @review-cli-commands ac-2 — Output includes subject, lifecycle, disposition, gate, threads, linkage
 * AC: @review-cli-commands ac-3 — Compatible with batch-oriented mutation flows
 * AC: @review-cli-creation-and-query ac-1, ac-2, ac-3, ac-4, ac-5
 * AC: @review-cli-mutation-commands ac-1, ac-1b, ac-2, ac-3, ac-4, ac-5, ac-6, ac-7
 * AC: @review-cli-task-linkage ac-1, ac-2
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  kspec as kspecRun,
  kspecOutput as kspec,
  kspecJson,
  setupTempFixtures,
  cleanupTempDir,
} from "./helpers/cli";

let tempDir: string;

beforeEach(async () => {
  tempDir = await setupTempFixtures();
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("Integration: review CLI commands", () => {
  describe("review add", () => {
    // AC: @review-cli-creation-and-query ac-1
    it("should create a review for a ref-backed subject", () => {
      const result = kspecJson<{
        _ulid: string;
        title: string;
        lifecycle_state: string;
        subject: { type: string; ref: string };
        author: string;
        disposition: string;
        gate_state: string;
      }>("review add --title 'Test Review' --subject-ref @task-slug --subject-type task", tempDir);

      expect(result._ulid).toBeDefined();
      expect(result.title).toBe("Test Review");
      expect(result.lifecycle_state).toBe("draft");
      expect(result.subject.type).toBe("task");
      expect(result.subject.ref).toBe("@task-slug");
      expect(result.author).toBeDefined();
      expect(result.disposition).toBe("pending");
      // No required checks → gate is trivially passing (vacuous truth, aligns with shared evaluateGates)
      expect(result.gate_state).toBe("passing");
    });

    // AC: @review-cli-creation-and-query ac-2
    it("should create a review for committed code with base and head", () => {
      const result = kspecJson<{
        _ulid: string;
        title: string;
        subject: { type: string; base_commit: string; head_commit: string };
      }>("review add --title 'Code Review' --base abc123 --head def456", tempDir);

      expect(result._ulid).toBeDefined();
      expect(result.title).toBe("Code Review");
      expect(result.subject.type).toBe("code");
      expect(result.subject.base_commit).toBe("abc123");
      expect(result.subject.head_commit).toBe("def456");
    });

    // AC: @review-cli-creation-and-query ac-ref-subject-remains-ref-subject
    // AC: @review-cli-creation-and-query ac-version-context-does-not-change-subject
    it("should keep a ref-backed subject when review context is provided separately", () => {
      const result = kspecJson<{
        subject: { type: string; ref: string };
        examined_commit: string | null;
      }>(
        "review add --title 'Task Review With Context' --subject-ref @task-slug --subject-type task --examined-commit abc123def456",
        tempDir,
      );

      expect(result.subject.type).toBe("task");
      expect(result.subject.ref).toBe("@task-slug");
      expect(result.examined_commit).toBe("abc123def456");
    });

    // AC: @review-cli-creation-and-query ac-2
    it("should accept merge-base and branch metadata for code subjects", () => {
      const result = kspecJson<{
        subject: {
          type: string;
          merge_base_commit?: string;
          base_branch?: string;
          head_branch?: string;
        };
      }>(
        "review add --title 'Code Review' --base abc123 --head def456 --merge-base 000aaa --base-branch main --head-branch feat/test",
        tempDir,
      );

      expect(result.subject.type).toBe("code");
      expect(result.subject.merge_base_commit).toBe("000aaa");
      expect(result.subject.base_branch).toBe("main");
      expect(result.subject.head_branch).toBe("feat/test");
    });

    // AC: @review-cli-creation-and-query ac-code-subject-created-only-when-requested
    it("should create a code subject when code comparison inputs are the selected subject", () => {
      const result = kspecJson<{
        subject: { type: string; base_commit: string; head_commit: string };
      }>(
        "review add --title 'Explicit Code Review' --subject-type code --base abc123 --head def456",
        tempDir,
      );

      expect(result.subject.type).toBe("code");
      expect(result.subject.base_commit).toBe("abc123");
      expect(result.subject.head_commit).toBe("def456");
    });

    // AC: @review-cli-creation-and-query ac-5
    it("should use provided slug when --slug is given", () => {
      const result = kspecJson<{
        slugs: string[];
        ref: string;
      }>("review add --title 'Slugged Review' --subject-ref @task-slug --slug my-review", tempDir);

      expect(result.slugs).toContain("my-review");
      expect(result.ref).toBe("@my-review");
    });

    // AC: @review-cli-creation-and-query ac-1
    it("should store related-ref when provided", () => {
      const result = kspecJson<{
        related_refs: string[];
      }>(
        "review add --title 'Linked Review' --subject-ref @task-slug --related-ref @task-other",
        tempDir,
      );

      expect(result.related_refs).toContain("@task-other");
    });

    it("should show human-readable success output", () => {
      const output = kspec("review add --title 'Human Review' --subject-ref @task-slug", tempDir);
      expect(output).toContain("Created review:");
    });

    // AC: @review-fix-cycle-diff ac-1
    it("should store examined_commit when --examined-commit is provided", () => {
      const result = kspecJson<{
        examined_commit: string | null;
      }>(
        "review add --title 'Commit Review' --subject-ref @task-slug --examined-commit abc123def456",
        tempDir,
      );
      expect(result.examined_commit).toBe("abc123def456");
    });

    // AC: @review-fix-cycle-diff ac-1
    it("should store examined_commit from KSPEC_DISPATCH_CANONICAL_HEAD env var", () => {
      const result = kspecJson<{
        examined_commit: string | null;
      }>("review add --title 'Env Commit Review' --subject-ref @task-slug", tempDir, {
        env: { KSPEC_DISPATCH_CANONICAL_HEAD: "envcommit789" },
      });
      expect(result.examined_commit).toBe("envcommit789");
    });

    // AC: @review-fix-cycle-diff ac-1
    it("should leave examined_commit null when not provided", () => {
      const result = kspecJson<{
        examined_commit: string | null;
      }>("review add --title 'No Commit Review' --subject-ref @task-slug", tempDir);
      expect(result.examined_commit).toBeNull();
    });

    // AC: @trait-error-guidance ac-1, ac-2, ac-5
    it("should error with guidance when subject is missing", () => {
      const result = kspecRun("review add --title 'No Subject'", tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Subject is required");
    });

    // AC: @trait-error-guidance ac-5
    it("should error when code subject is missing --head", () => {
      const result = kspecRun("review add --title 'Bad Code' --base abc123", tempDir, {
        expectFail: true,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--base and --head");
    });

    // AC: @review-cli-creation-and-query ac-ambiguous-review-subject-rejected
    it("should reject ambiguous inferred subject inputs", () => {
      const result = kspecRun(
        "review add --title 'Ambiguous Review' --subject-ref @task-slug --base abc123 --head def456",
        tempDir,
        { expectFail: true },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Ambiguous review subject");
    });

    // AC: @review-cli-creation-and-query ac-ambiguous-review-subject-rejected
    it("should reject code flags when an explicit task subject is selected", () => {
      const result = kspecRun(
        "review add --title 'Conflicting Task Review' --subject-type task --subject-ref @task-slug --base abc123 --head def456",
        tempDir,
        { expectFail: true },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Subject type task cannot be combined");
      expect(result.stderr).toContain("--examined-commit");
    });
  });

  describe("review get", () => {
    // AC: @review-cli-creation-and-query ac-3
    it("should show review details with lifecycle, disposition, gate, threads", () => {
      // Create a review first
      const created = kspecJson<{ _ulid: string }>(
        "review add --title 'Detail Review' --base abc --head def --slug detail-review",
        tempDir,
      );

      const result = kspecJson<{
        _ulid: string;
        title: string;
        lifecycle_state: string;
        disposition: string;
        gate_state: string;
        subject: { type: string };
        thread_state: {
          total: number;
          resolved: number;
          unresolved: number;
          blockers_unresolved: number;
        };
        threads: unknown[];
        checks: unknown[];
        verdicts: unknown[];
        events: unknown[];
        external_links: unknown[];
        created_at: string;
      }>("review get @detail-review", tempDir);

      // AC: @review-cli-commands ac-2
      expect(result._ulid).toBe(created._ulid);
      expect(result.title).toBe("Detail Review");
      expect(result.lifecycle_state).toBe("draft");
      expect(result.disposition).toBe("pending");
      // No required checks → gate is trivially passing (vacuous truth, aligns with shared evaluateGates)
      expect(result.gate_state).toBe("passing");
      expect(result.subject.type).toBe("code");
      expect(result.thread_state).toBeDefined();
      expect(result.thread_state.total).toBe(0);
      expect(result.threads).toEqual([]);
      expect(result.checks).toEqual([]);
      expect(result.verdicts).toEqual([]);
      expect(result.events).toBeDefined();
      expect(result.created_at).toBeDefined();
    });

    it("should show human-readable details", () => {
      kspec("review add --title 'HR Review' --base abc --head def --slug hr-review", tempDir);
      const output = kspec("review get @hr-review", tempDir);

      expect(output).toContain("HR Review");
      expect(output).toContain("Lifecycle:");
      expect(output).toContain("Disposition:");
      expect(output).toContain("Gate:");
      expect(output).toContain("Subject:");
    });

    // AC: @trait-error-guidance ac-3
    it("should error with guidance when review not found", () => {
      const result = kspecRun("review get @nonexistent", tempDir, { expectFail: true });
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("Review not found");
      expect(result.stderr).toContain("kspec review list");
    });

    // AC: @trait-error-guidance ac-6
    // AC: @trait-json-output ac-3
    it("should return JSON error when review not found in JSON mode", () => {
      const result = kspecRun("review get @nonexistent --json", tempDir, { expectFail: true });
      expect(result.exitCode).toBe(3);
      const parsed = JSON.parse(result.stderr);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Review not found");
    });
  });

  describe("review list", () => {
    beforeEach(() => {
      // Create some test reviews
      kspec("review add --title 'Open Review' --base a1 --head b1 --slug review-open", tempDir);
      kspec("review add --title 'Draft Review' --base a2 --head b2 --slug review-draft", tempDir);
    });

    // AC: @review-cli-creation-and-query ac-4
    it("should list all reviews", () => {
      const result = kspecJson<{
        reviews: Array<{
          title: string;
          lifecycle_state: string;
          disposition: string;
          gate_state: string;
          subject_type: string;
        }>;
        total: number;
      }>("review list", tempDir);

      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.reviews.length).toBeGreaterThanOrEqual(2);
      // Every review should have computed fields
      for (const r of result.reviews) {
        expect(r.disposition).toBeDefined();
        expect(r.gate_state).toBeDefined();
        expect(r.subject_type).toBeDefined();
      }
    });

    // AC: @trait-filterable-list ac-1
    it("should filter by lifecycle state", () => {
      kspec("review open @review-open", tempDir);

      const result = kspecJson<{ reviews: Array<{ lifecycle_state: string }>; total: number }>(
        "review list --status open",
        tempDir,
      );

      expect(result.total).toBe(1);
      expect(result.reviews[0].lifecycle_state).toBe("open");
    });

    // AC: @trait-filterable-list ac-3
    it("should limit results", () => {
      const result = kspecJson<{ reviews: unknown[]; total: number; showing: number }>(
        "review list --limit 1",
        tempDir,
      );

      expect(result.showing).toBe(1);
      expect(result.total).toBeGreaterThanOrEqual(2);
    });

    // AC: @trait-filterable-list ac-4
    it("should offset results", () => {
      const all = kspecJson<{ reviews: Array<{ _ulid: string }> }>("review list", tempDir);
      const offset = kspecJson<{ reviews: Array<{ _ulid: string }> }>(
        "review list --offset 1",
        tempDir,
      );

      expect(offset.reviews.length).toBe(all.reviews.length - 1);
    });

    // AC: @trait-filterable-list ac-6
    it("should show informative message when no reviews match", () => {
      const result = kspecJson<{ reviews: unknown[]; total: number; message: string }>(
        "review list --status archived",
        tempDir,
      );

      expect(result.total).toBe(0);
      expect(result.reviews).toEqual([]);
      expect(result.message).toContain("No reviews found");
    });

    // AC: @trait-filterable-list ac-8
    it("should return count only with --count flag", () => {
      const result = kspecJson<{ count: number }>("review list --count", tempDir);
      expect(result.count).toBeGreaterThanOrEqual(2);
    });

    // AC: @trait-filterable-list ac-7
    it("should show summary with total and showing counts", () => {
      const output = kspec("review list", tempDir);
      expect(output).toMatch(/Reviews \(\d+\/\d+\)/);
    });

    it("should filter by disposition", () => {
      const result = kspecJson<{ reviews: unknown[]; total: number }>(
        "review list --disposition pending",
        tempDir,
      );
      expect(result.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe("review comment", () => {
    let reviewSlug: string;

    beforeEach(() => {
      reviewSlug = "comment-test";
      kspec(`review add --title 'Comment Test' --base a1 --head b1 --slug ${reviewSlug}`, tempDir);
    });

    // AC: @review-cli-mutation-commands ac-1
    it("should add a comment thread with kind", () => {
      const result = kspecJson<{ thread_ulid: string; review_ulid: string }>(
        `review comment @${reviewSlug} --body 'This needs fixing' --kind blocker`,
        tempDir,
      );

      expect(result.thread_ulid).toBeDefined();
      expect(result.review_ulid).toBeDefined();

      // Verify thread was stored
      const review = kspecJson<{
        threads: Array<{ kind: string; entries: Array<{ body: string }> }>;
      }>(`review get @${reviewSlug}`, tempDir);
      expect(review.threads).toHaveLength(1);
      expect(review.threads[0].kind).toBe("blocker");
      expect(review.threads[0].entries[0].body).toBe("This needs fixing");
    });

    // AC: @review-idea-threads ac-idea-kind-accepted
    it("should add an idea thread and support reply, resolve, and reopen", () => {
      const result = kspecJson<{ thread_ulid: string; review_ulid: string }>(
        `review comment @${reviewSlug} --body 'Consider a future workflow' --kind idea`,
        tempDir,
      );

      kspec(
        `review reply @${reviewSlug} --thread ${result.thread_ulid} --body 'Captured'`,
        tempDir,
      );
      kspec(`review resolve @${reviewSlug} --thread ${result.thread_ulid}`, tempDir);
      kspec(`review reopen @${reviewSlug} --thread ${result.thread_ulid}`, tempDir);

      const review = kspecJson<{
        threads: Array<{
          kind: string;
          entries: Array<{ body: string }>;
          resolved_at: string | null;
          resolved_by: string | null;
        }>;
        events: Array<{ event_type: string }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.threads[0].kind).toBe("idea");
      expect(review.threads[0].entries.map((entry) => entry.body)).toEqual([
        "Consider a future workflow",
        "Captured",
      ]);
      expect(review.threads[0].resolved_at).toBeNull();
      expect(review.threads[0].resolved_by).toBeNull();
      expect(review.events.map((event) => event.event_type)).toEqual(
        expect.arrayContaining([
          "thread_created",
          "thread_replied",
          "thread_resolved",
          "thread_reopened",
        ]),
      );
    });

    // AC: @review-idea-threads ac-kind-validation
    it("should reject unknown thread kind with accepted-kind guidance", () => {
      const result = kspecRun(
        `review comment @${reviewSlug} --body 'Unknown kind' --kind warning`,
        tempDir,
        { expectFail: true },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid thread kind: warning");
      expect(result.stderr).toContain("Valid kinds: blocker, question, nit, idea");
    });

    // AC: @review-cli-mutation-commands ac-1
    it("should add a comment with code anchor", () => {
      kspec(
        `review comment @${reviewSlug} --body 'Fix this line' --path src/foo.ts --side head --line-start 42 --line-end 45 --commit abc123`,
        tempDir,
      );

      const review = kspecJson<{
        threads: Array<{
          anchor: {
            type: string;
            path: string;
            side: string;
            line_start: number;
            line_end: number;
          };
        }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.threads[0].anchor.type).toBe("code");
      expect(review.threads[0].anchor.path).toBe("src/foo.ts");
      expect(review.threads[0].anchor.side).toBe("head");
      expect(review.threads[0].anchor.line_start).toBe(42);
      expect(review.threads[0].anchor.line_end).toBe(45);
    });

    // AC: @review-spec-ac-anchors ac-typed-anchor-stored
    it("should add a comment with a typed spec AC anchor", () => {
      kspec(
        `review comment @${reviewSlug} --body 'Check this criterion' --spec-ref @review-spec --ac-id ac-1`,
        tempDir,
      );

      const review = kspecJson<{
        threads: Array<{
          anchor: {
            type: string;
            spec_ref: string;
            criterion_id: string;
          };
        }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.threads[0].anchor).toEqual({
        type: "spec_ac",
        spec_ref: "@review-spec",
        criterion_id: "ac-1",
      });
    });

    // AC: @review-spec-ac-anchors ac-anchor-field-validation
    it("should reject malformed spec AC anchors without storing a thread", () => {
      const result = kspecRun(
        `review comment @${reviewSlug} --body 'Bad criterion' --spec-ref review-spec --ac-id criterion-1`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toContain("spec_ref");

      const review = kspecJson<{ threads: unknown[] }>(`review get @${reviewSlug}`, tempDir);
      expect(review.threads).toHaveLength(0);
    });

    it("should default thread kind to nit", () => {
      kspec(`review comment @${reviewSlug} --body 'A nit'`, tempDir);

      const review = kspecJson<{ threads: Array<{ kind: string }> }>(
        `review get @${reviewSlug}`,
        tempDir,
      );
      expect(review.threads[0].kind).toBe("nit");
    });

    it("should append event on comment", () => {
      kspec(`review comment @${reviewSlug} --body 'Some comment'`, tempDir);

      const review = kspecJson<{ events: Array<{ event_type: string }> }>(
        `review get @${reviewSlug}`,
        tempDir,
      );
      // Should have creation event + thread_created event
      expect(review.events.some((e) => e.event_type === "thread_created")).toBe(true);
    });
  });

  describe("review reply", () => {
    let reviewSlug: string;
    let threadUlid: string;

    beforeEach(() => {
      reviewSlug = "reply-test";
      kspec(`review add --title 'Reply Test' --base a1 --head b1 --slug ${reviewSlug}`, tempDir);
      const commentResult = kspecJson<{ thread_ulid: string }>(
        `review comment @${reviewSlug} --body 'Original comment'`,
        tempDir,
      );
      threadUlid = commentResult.thread_ulid;
    });

    // AC: @review-cli-mutation-commands ac-1b
    it("should reply to an existing thread", () => {
      kspec(`review reply @${reviewSlug} --thread ${threadUlid} --body 'Fixed it'`, tempDir);

      const review = kspecJson<{
        threads: Array<{ entries: Array<{ body: string }> }>;
        events: Array<{ event_type: string }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.threads[0].entries).toHaveLength(2);
      expect(review.threads[0].entries[1].body).toBe("Fixed it");
      expect(review.events.some((e) => e.event_type === "thread_replied")).toBe(true);
    });

    it("should error when thread not found", () => {
      const result = kspecRun(
        `review reply @${reviewSlug} --thread 01AAAAAAAAAAAAAAAAAAAAAAAAA --body 'No thread'`,
        tempDir,
        { expectFail: true },
      );
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("Thread not found");
    });
  });

  describe("review check", () => {
    let reviewSlug: string;

    beforeEach(() => {
      reviewSlug = "check-test";
      kspec(`review add --title 'Check Test' --base a1 --head b1 --slug ${reviewSlug}`, tempDir);
    });

    // AC: @review-cli-mutation-commands ac-2
    it("should add a check result with auto-derived version", () => {
      const result = kspecJson<{ check_name: string; status: string }>(
        `review check @${reviewSlug} --name 'tests' --status pass`,
        tempDir,
      );

      expect(result.check_name).toBe("tests");
      expect(result.status).toBe("pass");

      const review = kspecJson<{
        checks: Array<{
          name: string;
          status: string;
          required: boolean;
          applies_to_version: { type: string; base_commit: string; head_commit: string };
        }>;
        gate_state: string;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.checks).toHaveLength(1);
      expect(review.checks[0].name).toBe("tests");
      expect(review.checks[0].status).toBe("pass");
      expect(review.checks[0].required).toBe(true);
      expect(review.checks[0].applies_to_version.type).toBe("code_compare");
      expect(review.gate_state).toBe("passing");
    });

    it("should add an optional check", () => {
      kspec(`review check @${reviewSlug} --name 'lint' --status fail --no-required`, tempDir);

      const review = kspecJson<{
        checks: Array<{ name: string; required: boolean }>;
        gate_state: string;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.checks[0].required).toBe(false);
      // No required checks → gate is trivially passing (vacuous truth, aligns with shared evaluateGates)
      expect(review.gate_state).toBe("passing");
    });

    it("should compute failing gate state", () => {
      kspec(`review check @${reviewSlug} --name 'tests' --status fail`, tempDir);

      const review = kspecJson<{ gate_state: string }>(`review get @${reviewSlug}`, tempDir);
      expect(review.gate_state).toBe("failing");
    });
  });

  describe("review verdict", () => {
    let reviewSlug: string;

    beforeEach(() => {
      reviewSlug = "verdict-test";
      kspec(`review add --title 'Verdict Test' --base a1 --head b1 --slug ${reviewSlug}`, tempDir);
    });

    // AC: @review-cli-mutation-commands ac-3
    it("should set an approve verdict with auto-derived version", () => {
      // `review-agent` is a configured roster identity; an out-of-pool reviewer
      // is rejected (see actor-write tests). AC: @actor-identity-resolution ac-7
      kspec(`review verdict @${reviewSlug} --decision approve --reviewer review-agent`, tempDir);

      const review = kspecJson<{
        verdicts: Array<{
          reviewer: string;
          decision: string;
          applies_to_version: { type: string; base_commit?: string; head_commit?: string };
        }>;
        disposition: string;
        events: Array<{ event_type: string }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.verdicts).toHaveLength(1);
      expect(review.verdicts[0].reviewer).toBe("review-agent");
      expect(review.verdicts[0].decision).toBe("approve");
      // Version auto-derived from code subject (--base a1 --head b1 on review add)
      expect(review.verdicts[0].applies_to_version.type).toBe("code_compare");
      expect(review.verdicts[0].applies_to_version.base_commit).toBe("a1");
      expect(review.verdicts[0].applies_to_version.head_commit).toBe("b1");
      expect(review.disposition).toBe("approved");
      expect(review.events.some((e) => e.event_type === "verdict_submitted")).toBe(true);
    });

    it("should compute changes_requested disposition", () => {
      kspec(`review verdict @${reviewSlug} --decision request_changes`, tempDir);

      const review = kspecJson<{ disposition: string }>(`review get @${reviewSlug}`, tempDir);
      expect(review.disposition).toBe("changes_requested");
    });

    // AC: @review-record-per-cycle-lifecycle ac-1
    it("should auto-close review on approve verdict", () => {
      kspec(`review verdict @${reviewSlug} --decision approve --reviewer review-agent`, tempDir);

      const review = kspecJson<{
        lifecycle_state: string;
        events: Array<{ event_type: string; payload?: Record<string, unknown> }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.lifecycle_state).toBe("closed");
      expect(review.events.some((e) => e.event_type === "lifecycle_change")).toBe(true);
      const closeEvent = review.events.find(
        (e) => e.event_type === "lifecycle_change" && e.payload?.to === "closed",
      );
      expect(closeEvent).toBeDefined();
    });

    // AC: @review-record-per-cycle-lifecycle ac-1
    it("should auto-close review on request_changes verdict", () => {
      kspec(
        `review verdict @${reviewSlug} --decision request_changes --reviewer review-agent`,
        tempDir,
      );

      const review = kspecJson<{
        lifecycle_state: string;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.lifecycle_state).toBe("closed");
    });

    // AC: @review-record-per-cycle-lifecycle ac-1
    it("should NOT auto-close review on comment verdict", () => {
      // Open the review first (review add creates in draft state)
      kspec(`review open @${reviewSlug}`, tempDir);

      kspec(`review verdict @${reviewSlug} --decision comment --reviewer review-agent`, tempDir);

      const review = kspecJson<{
        lifecycle_state: string;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.lifecycle_state).toBe("open");
    });

    // AC: @trait-error-guidance ac-5
    it("should error on invalid decision", () => {
      const result = kspecRun(`review verdict @${reviewSlug} --decision invalid`, tempDir, {
        expectFail: true,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Invalid verdict decision");
      expect(result.stderr).toContain("approve");
    });
  });

  describe("review resolve/reopen", () => {
    let reviewSlug: string;
    let threadUlid: string;

    beforeEach(() => {
      reviewSlug = "resolve-test";
      kspec(`review add --title 'Resolve Test' --base a1 --head b1 --slug ${reviewSlug}`, tempDir);
      const result = kspecJson<{ thread_ulid: string }>(
        `review comment @${reviewSlug} --body 'Issue found' --kind blocker`,
        tempDir,
      );
      threadUlid = result.thread_ulid;
    });

    // AC: @review-cli-mutation-commands ac-4
    it("should resolve a thread", () => {
      kspec(`review resolve @${reviewSlug} --thread ${threadUlid}`, tempDir);

      const review = kspecJson<{
        threads: Array<{ resolved_at: string | null; resolved_by: string | null }>;
        thread_state: { unresolved: number; blockers_unresolved: number };
        events: Array<{ event_type: string }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.threads[0].resolved_at).toBeDefined();
      expect(review.threads[0].resolved_at).not.toBeNull();
      expect(review.threads[0].resolved_by).toBeDefined();
      expect(review.thread_state.unresolved).toBe(0);
      expect(review.thread_state.blockers_unresolved).toBe(0);
      expect(review.events.some((e) => e.event_type === "thread_resolved")).toBe(true);
    });

    // AC: @review-cli-mutation-commands ac-4
    it("should reopen a resolved thread", () => {
      kspec(`review resolve @${reviewSlug} --thread ${threadUlid}`, tempDir);
      kspec(`review reopen @${reviewSlug} --thread ${threadUlid}`, tempDir);

      const review = kspecJson<{
        threads: Array<{ resolved_at: string | null }>;
        thread_state: { unresolved: number };
        events: Array<{ event_type: string }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.threads[0].resolved_at).toBeNull();
      expect(review.thread_state.unresolved).toBe(1);
      expect(review.events.some((e) => e.event_type === "thread_reopened")).toBe(true);
    });

    // AC: @trait-error-guidance ac-4
    it("should error when resolving an already resolved thread", () => {
      kspec(`review resolve @${reviewSlug} --thread ${threadUlid}`, tempDir);
      const result = kspecRun(`review resolve @${reviewSlug} --thread ${threadUlid}`, tempDir, {
        expectFail: true,
      });
      expect(result.stderr).toContain("already resolved");
    });

    // AC: @trait-error-guidance ac-4
    it("should error when reopening an unresolved thread", () => {
      const result = kspecRun(`review reopen @${reviewSlug} --thread ${threadUlid}`, tempDir, {
        expectFail: true,
      });
      expect(result.stderr).toContain("not resolved");
    });
  });

  describe("review lifecycle transitions", () => {
    let reviewSlug: string;

    beforeEach(() => {
      reviewSlug = "lifecycle-test";
      kspec(
        `review add --title 'Lifecycle Test' --base a1 --head b1 --slug ${reviewSlug}`,
        tempDir,
      );
    });

    // AC: @review-cli-mutation-commands ac-5
    it("should open a draft review", () => {
      kspec(`review open @${reviewSlug}`, tempDir);

      const review = kspecJson<{
        lifecycle_state: string;
        events: Array<{ event_type: string; payload: { from: string; to: string } }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.lifecycle_state).toBe("open");
      const event = review.events.find(
        (e) => e.event_type === "lifecycle_change" && e.payload?.to === "open",
      );
      expect(event).toBeDefined();
      expect(event?.payload.from).toBe("draft");
    });

    // AC: @review-cli-mutation-commands ac-5
    it("should close an open review", () => {
      kspec(`review open @${reviewSlug}`, tempDir);
      kspec(`review close @${reviewSlug}`, tempDir);

      const review = kspecJson<{ lifecycle_state: string }>(`review get @${reviewSlug}`, tempDir);
      expect(review.lifecycle_state).toBe("closed");
    });

    // AC: @review-cli-mutation-commands ac-5
    it("should archive a review", () => {
      kspec(`review archive @${reviewSlug}`, tempDir);

      const review = kspecJson<{ lifecycle_state: string }>(`review get @${reviewSlug}`, tempDir);
      expect(review.lifecycle_state).toBe("archived");
    });

    // AC: @review-cli-mutation-commands ac-5
    it("should reopen a closed review", () => {
      kspec(`review open @${reviewSlug}`, tempDir);
      kspec(`review close @${reviewSlug}`, tempDir);
      kspec(`review open @${reviewSlug}`, tempDir);

      const review = kspecJson<{ lifecycle_state: string }>(`review get @${reviewSlug}`, tempDir);
      expect(review.lifecycle_state).toBe("open");
    });

    // AC: @trait-error-guidance ac-4
    it("should error when opening an already open review", () => {
      kspec(`review open @${reviewSlug}`, tempDir);
      const result = kspecRun(`review open @${reviewSlug}`, tempDir, { expectFail: true });
      expect(result.stderr).toContain("Cannot open review");
      expect(result.stderr).toContain("open");
    });

    // AC: @trait-error-guidance ac-4
    it("should error when archiving an already archived review", () => {
      kspec(`review archive @${reviewSlug}`, tempDir);
      const result = kspecRun(`review archive @${reviewSlug}`, tempDir, { expectFail: true });
      expect(result.stderr).toContain("already archived");
    });

    // AC: @trait-error-guidance ac-4
    it("should error when closing an archived review", () => {
      kspec(`review archive @${reviewSlug}`, tempDir);
      const result = kspecRun(`review close @${reviewSlug}`, tempDir, { expectFail: true });
      expect(result.stderr).toContain("Cannot close review");
      expect(result.stderr).toContain("archived");
    });
  });

  describe("review refresh", () => {
    let reviewSlug: string;

    beforeEach(() => {
      reviewSlug = "refresh-test";
      kspec(`review add --title 'Refresh Test' --base a1 --head b1 --slug ${reviewSlug}`, tempDir);
    });

    // AC: @review-cli-mutation-commands ac-6
    it("should update head commit on refresh", () => {
      kspec(`review refresh @${reviewSlug} --head c1`, tempDir);

      const review = kspecJson<{
        subject: { head_commit: string; base_commit: string };
        events: Array<{ event_type: string; payload: { previous_head: string; new_head: string } }>;
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.subject.head_commit).toBe("c1");
      expect(review.subject.base_commit).toBe("a1");
      const event = review.events.find((e) => e.event_type === "subject_refreshed");
      expect(event).toBeDefined();
      expect(event?.payload.previous_head).toBe("b1");
      expect(event?.payload.new_head).toBe("c1");
    });

    // AC: @review-cli-mutation-commands ac-6
    it("should update both base and head on refresh", () => {
      kspec(`review refresh @${reviewSlug} --head c1 --base d1`, tempDir);

      const review = kspecJson<{
        subject: { head_commit: string; base_commit: string };
      }>(`review get @${reviewSlug}`, tempDir);

      expect(review.subject.head_commit).toBe("c1");
      expect(review.subject.base_commit).toBe("d1");
    });

    it("should error on non-code subject", () => {
      kspec("review add --title 'Task Review' --subject-ref @task-slug --slug task-rv", tempDir);
      const result = kspecRun("review refresh @task-rv --head c1", tempDir, { expectFail: true });
      expect(result.stderr).toContain("only supported for code subjects");
    });
  });

  describe("review for-task", () => {
    // AC: @review-cli-task-linkage ac-1
    it("should find reviews linked via related_refs", () => {
      kspec(
        "review add --title 'Task Linked' --base a1 --head b1 --slug task-linked --related-ref @my-task",
        tempDir,
      );

      const result = kspecJson<{
        reviews: Array<{ title: string; lifecycle_state: string; disposition: string }>;
        total: number;
        task_ref: string;
      }>("review for-task @my-task", tempDir);

      expect(result.total).toBe(1);
      expect(result.task_ref).toBe("@my-task");
      expect(result.reviews[0].title).toBe("Task Linked");
    });

    // AC: @review-cli-task-linkage ac-1
    it("should find reviews with task subject type", () => {
      kspec(
        "review add --title 'Task Subject' --subject-ref @my-task --subject-type task --slug task-subj",
        tempDir,
      );

      const result = kspecJson<{ reviews: Array<{ title: string }>; total: number }>(
        "review for-task @my-task",
        tempDir,
      );

      expect(result.total).toBe(1);
      expect(result.reviews[0].title).toBe("Task Subject");
    });

    // AC: @review-cli-task-linkage ac-2
    it("should return empty when no reviews linked to task", () => {
      const result = kspecJson<{ reviews: unknown[]; total: number }>(
        "review for-task @no-such-task",
        tempDir,
      );

      expect(result.total).toBe(0);
      expect(result.reviews).toEqual([]);
    });

    it("should show human-readable output", () => {
      kspec("review add --title 'Linked' --base a1 --head b1 --related-ref @my-task", tempDir);

      const output = kspec("review for-task @my-task", tempDir);
      expect(output).toContain("Reviews for @my-task");
    });
  });

  // AC: @review-cli-commands ac-3
  describe("batch compatibility", () => {
    it("should execute review add via batch", () => {
      const batchCommands = JSON.stringify([
        {
          command: "review add",
          args: {
            title: "Batch Review",
            base: "aaa",
            head: "bbb",
            slug: "batch-review",
          },
        },
      ]);

      const result = kspecRun(`batch --commands '${batchCommands}'`, tempDir);
      expect(result.exitCode).toBe(0);

      // Verify the review was created
      const review = kspecJson<{ title: string }>(`review get @batch-review`, tempDir);
      expect(review.title).toBe("Batch Review");
    });

    it("should execute multiple review mutations atomically via batch", () => {
      // First create a review normally
      kspec("review add --title 'Multi Batch' --base a1 --head b1 --slug multi-batch", tempDir);

      const batchCommands = JSON.stringify([
        {
          command: "review comment",
          args: {
            ref: "@multi-batch",
            body: "First comment",
            kind: "blocker",
          },
        },
        {
          command: "review open",
          args: { ref: "@multi-batch" },
        },
      ]);

      const result = kspecRun(`batch --commands '${batchCommands}'`, tempDir);
      expect(result.exitCode).toBe(0);

      // Verify both mutations applied
      const review = kspecJson<{
        lifecycle_state: string;
        threads: Array<{ entries: Array<{ body: string }> }>;
      }>(`review get @multi-batch`, tempDir);

      expect(review.lifecycle_state).toBe("open");
      expect(review.threads).toHaveLength(1);
      expect(review.threads[0].entries[0].body).toBe("First comment");
    });
  });

  // AC: @trait-json-output ac-1, ac-2, ac-4, ac-5
  describe("JSON output trait compliance", () => {
    // AC: @trait-json-output ac-1
    // AC: @trait-json-output ac-2
    it("should output valid JSON with no ANSI color codes", () => {
      kspec("review add --title 'JSON Test' --base a1 --head b1 --slug json-test", tempDir);
      const result = kspecRun("review get @json-test --json", tempDir);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toBeDefined();
      // No ANSI escape codes in JSON output
      // oxlint-disable-next-line eslint(no-control-regex) -- intentionally matching ANSI escape
      expect(result.stdout).not.toMatch(/\x1b\[/);
    });

    // AC: @trait-json-output ac-4
    it("should use @ prefix for references in JSON output", () => {
      kspec("review add --title 'Ref Test' --base a1 --head b1 --slug ref-test", tempDir);
      const result = kspecJson<{ ref: string }>("review get @ref-test", tempDir);
      expect(result.ref).toMatch(/^@/);
    });

    // AC: @trait-json-output ac-5
    it("should use ISO 8601 timestamps", () => {
      kspec("review add --title 'Time Test' --base a1 --head b1 --slug time-test", tempDir);
      const result = kspecJson<{ created_at: string }>("review get @time-test", tempDir);
      expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  // AC: @trait-semantic-exit-codes ac-1, ac-2, ac-5
  describe("semantic exit codes trait compliance", () => {
    // AC: @trait-semantic-exit-codes ac-1
    it("should exit 0 on success", () => {
      const result = kspecRun("review add --title 'Exit Test' --base a1 --head b1", tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-5
    it("should exit 0 with empty result set", () => {
      const result = kspecRun("review list --status archived", tempDir);
      expect(result.exitCode).toBe(0);
    });

    // AC: @trait-semantic-exit-codes ac-2
    it("should exit non-zero on validation error", () => {
      const result = kspecRun("review add --title 'No Subject'", tempDir, { expectFail: true });
      expect(result.exitCode).not.toBe(0);
    });
  });

  // AC: @review-cli-mutation-commands ac-7 — Design constraint: no delete command is implemented;
  // destructive operations are deferred to future work and will require explicit safety behavior
  // (--force / confirmation) separate from close/archive lifecycle transitions.

  // Trait ACs documented as N/A
  // AC: @trait-shadow-commit ac-1, ac-2, ac-3 — covered in source: commitIfShadow calls with semantic messages and ULID/slug refs
  // AC: @trait-shadow-commit ac-4 — N/A: test fixtures do not initialize shadow branch; shadow commits are a no-op
  // AC: @trait-shadow-commit ac-5 — structural: commitIfShadow only called after successful save in each command's try block
  // AC: @trait-shadow-commit ac-6 — N/A: test fixtures have no remote; fire-and-forget push is not testable in isolation
  // AC: @trait-shadow-commit ac-7 — N/A: test fixtures have no remote; sync warning not triggered
  // AC: @trait-shadow-commit ac-8 — covered via batch compatibility tests: batch commands produce single atomic commit
  // AC: @trait-filterable-list ac-2 — N/A: reviews do not have tags; --tag filter is not applicable
  // AC: @trait-filterable-list ac-5 — N/A: reviews do not support --tag filter; multi-filter AND logic tested with --status and --disposition instead
  // AC: @trait-confirmation-prompt ac-1 through ac-6 — N/A: review-cli-mutation-commands ac-7 defers destructive operations to future work
  // AC: @trait-json-output ac-6 — N/A: review commands have no competing format flags beyond global --json
  // AC: @trait-semantic-exit-codes ac-3 — N/A: no review commands use interactive confirmation prompts
  // AC: @trait-semantic-exit-codes ac-4 — runtime errors tested via not-found cases (exit 3)
  // AC: @trait-semantic-exit-codes ac-6 — tested via error cases that use wrong arguments
  // AC: @trait-semantic-exit-codes ac-7 — N/A: no batch-specific partial failure exit in review commands
  // AC: @trait-semantic-exit-codes ac-8 — exit code constants documented in src/cli/exit-codes.ts
});
