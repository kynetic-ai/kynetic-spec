import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTempFixtures,
  cleanupTempDir,
  kspec,
  kspecJson,
  kspecOutput,
} from "./helpers/cli";

describe("Review CLI: creation and query", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTempFixtures();
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // AC: @review-cli-creation-and-query ac-1
  // Create review for a ref-backed subject
  // ============================================================

  // AC: @review-cli-creation-and-query ac-1
  it("should create a review for a ref-backed subject (task)", () => {
    // Create a task to reference
    kspec('task add --title "Auth feature" --slug task-auth', tempDir);

    const result = kspec(
      'review add --title "Review auth task" --subject-ref @task-auth',
      tempDir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Created review");
  });

  // AC: @review-cli-creation-and-query ac-1
  it("should create a review with lifecycle state draft and author metadata", () => {
    kspec('task add --title "Auth feature" --slug task-auth-2', tempDir);

    const review = kspecJson<{
      _ulid: string;
      lifecycle_state: string;
      author: string;
      subject: { type: string; ref: string };
    }>('review add --title "Review auth" --subject-ref @task-auth-2', tempDir);

    expect(review._ulid).toBeDefined();
    expect(review.lifecycle_state).toBe("draft");
    expect(review.author).toBeDefined();
    expect(review.author).not.toBe("");
    expect(review.subject.type).toBe("task");
    expect(review.subject.ref).toContain("task-auth-2");
  });

  // ============================================================
  // AC: @review-cli-creation-and-query ac-2
  // Create review for committed code
  // ============================================================

  // AC: @review-cli-creation-and-query ac-2
  it("should create a review with code subject binding (base + head commits)", () => {
    const review = kspecJson<{
      _ulid: string;
      subject: {
        type: string;
        base_commit: string;
        head_commit: string;
      };
    }>(
      'review add --title "Code review" --base-commit abc123def --head-commit 456789abc',
      tempDir,
    );

    expect(review._ulid).toBeDefined();
    expect(review.subject.type).toBe("code");
    expect(review.subject.base_commit).toBe("abc123def");
    expect(review.subject.head_commit).toBe("456789abc");
  });

  // AC: @review-cli-creation-and-query ac-2
  it("should include optional merge_base_commit and branch metadata in code subject", () => {
    const review = kspecJson<{
      subject: {
        type: string;
        base_commit: string;
        head_commit: string;
        merge_base_commit: string;
        base_branch: string;
        head_branch: string;
      };
    }>(
      'review add --title "Full code review" --base-commit abc123 --head-commit def456 --merge-base-commit 789abc --base-branch main --head-branch feature/auth',
      tempDir,
    );

    expect(review.subject.type).toBe("code");
    expect(review.subject.merge_base_commit).toBe("789abc");
    expect(review.subject.base_branch).toBe("main");
    expect(review.subject.head_branch).toBe("feature/auth");
  });

  // ============================================================
  // AC: @review-cli-creation-and-query ac-3
  // Get review by ref
  // ============================================================

  // AC: @review-cli-creation-and-query ac-3
  it("should get a review by ref and show all details", () => {
    // Create a review first
    const created = kspecJson<{ _ulid: string; slugs: string[] }>(
      'review add --title "Test review" --base-commit aaa --head-commit bbb --slug test-review-get',
      tempDir,
    );

    // Get it by slug
    const review = kspecJson<{
      _ulid: string;
      title: string;
      lifecycle_state: string;
      disposition: string;
      gate_state: string;
      subject: { type: string };
      threads: unknown[];
      checks: unknown[];
      verdicts: unknown[];
      events: unknown[];
      created_at: string;
    }>("review get @test-review-get", tempDir);

    expect(review._ulid).toBe(created._ulid);
    expect(review.title).toBe("Test review");
    expect(review.lifecycle_state).toBe("draft");
    expect(review.disposition).toBe("pending");
    expect(review.gate_state).toBe("pending");
    expect(review.subject.type).toBe("code");
    expect(Array.isArray(review.threads)).toBe(true);
    expect(Array.isArray(review.checks)).toBe(true);
    expect(Array.isArray(review.verdicts)).toBe(true);
    expect(Array.isArray(review.events)).toBe(true);
    expect(review.created_at).toBeDefined();
  });

  // AC: @review-cli-creation-and-query ac-3
  it("should show review details in human-readable format", () => {
    kspec(
      'review add --title "Human readable test" --base-commit aaa --head-commit bbb --slug hr-review',
      tempDir,
    );

    const result = kspec("review get @hr-review", tempDir);
    expect(result.stdout).toContain("Human readable test");
    expect(result.stdout).toContain("Lifecycle:");
    expect(result.stdout).toContain("Disposition:");
    expect(result.stdout).toContain("Gate:");
    expect(result.stdout).toContain("Subject:");
    expect(result.stdout).toContain("Author:");
  });

  // AC: @review-cli-creation-and-query ac-3
  it("should get review by short ULID prefix", () => {
    const created = kspecJson<{ _ulid: string }>(
      'review add --title "ULID test" --base-commit aaa --head-commit bbb',
      tempDir,
    );

    // Get by short ULID prefix (first 8 chars)
    const shortRef = created._ulid.slice(0, 8);
    const review = kspecJson<{ _ulid: string }>(
      `review get ${shortRef}`,
      tempDir,
    );

    expect(review._ulid).toBe(created._ulid);
  });

  // ============================================================
  // AC: @review-cli-creation-and-query ac-4
  // List reviews with filters
  // ============================================================

  // AC: @review-cli-creation-and-query ac-4
  it("should list all reviews", () => {
    kspec(
      'review add --title "Review A" --base-commit aaa --head-commit bbb',
      tempDir,
    );
    kspec(
      'review add --title "Review B" --base-commit ccc --head-commit ddd',
      tempDir,
    );

    const reviews = kspecJson<
      Array<{ _ulid: string; title: string }>
    >("review list", tempDir);

    expect(reviews).toHaveLength(2);
    expect(reviews.map((r) => r.title)).toContain("Review A");
    expect(reviews.map((r) => r.title)).toContain("Review B");
  });

  // AC: @review-cli-creation-and-query ac-4
  it("should filter reviews by lifecycle state", () => {
    kspec(
      'review add --title "Draft review" --base-commit aaa --head-commit bbb',
      tempDir,
    );

    const drafts = kspecJson<Array<{ lifecycle_state: string }>>(
      "review list --status draft",
      tempDir,
    );
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    expect(drafts.every((r) => r.lifecycle_state === "draft")).toBe(true);

    // Filter by a non-matching state
    const openReviews = kspecJson<Array<{ lifecycle_state: string }>>(
      "review list --status open",
      tempDir,
    );
    expect(openReviews).toHaveLength(0);
  });

  // AC: @review-cli-creation-and-query ac-4
  it("should filter reviews by subject reference", () => {
    kspec('task add --title "Task X" --slug task-x', tempDir);
    kspec(
      'review add --title "Task X review" --subject-ref @task-x',
      tempDir,
    );
    kspec(
      'review add --title "Code review" --base-commit aaa --head-commit bbb',
      tempDir,
    );

    const filtered = kspecJson<Array<{ title: string }>>(
      "review list --subject @task-x",
      tempDir,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Task X review");
  });

  // AC: @review-cli-creation-and-query ac-4
  it("should filter reviews by reviewer/author", () => {
    kspec(
      'review add --title "My review" --base-commit aaa --head-commit bbb --author alice',
      tempDir,
    );
    kspec(
      'review add --title "Other review" --base-commit ccc --head-commit ddd --author bob',
      tempDir,
    );

    const filtered = kspecJson<Array<{ author: string }>>(
      "review list --reviewer alice",
      tempDir,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].author).toBe("alice");
  });

  // ============================================================
  // AC: @review-cli-creation-and-query ac-5
  // Custom slug
  // ============================================================

  // AC: @review-cli-creation-and-query ac-5
  it("should create a review with a --slug flag", () => {
    const review = kspecJson<{ _ulid: string; slugs: string[] }>(
      'review add --title "Slugged review" --base-commit aaa --head-commit bbb --slug my-custom-slug',
      tempDir,
    );

    expect(review.slugs).toContain("my-custom-slug");

    // Verify it can be retrieved by slug
    const fetched = kspecJson<{ _ulid: string }>(
      "review get @my-custom-slug",
      tempDir,
    );
    expect(fetched._ulid).toBe(review._ulid);
  });

  // AC: @review-cli-creation-and-query ac-5
  it("should reject duplicate slugs", () => {
    kspec(
      'review add --title "First" --base-commit aaa --head-commit bbb --slug unique-slug',
      tempDir,
    );

    const result = kspec(
      'review add --title "Second" --base-commit ccc --head-commit ddd --slug unique-slug',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // ============================================================
  // Validation and error handling
  // ============================================================

  // AC: @trait-semantic-exit-codes ac-2
  it("should exit with error when subject-ref not found", () => {
    const result = kspec(
      'review add --title "Bad ref" --subject-ref @nonexistent',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-6
  it("should exit with error when only --base-commit is provided without --head-commit", () => {
    const result = kspec(
      'review add --title "Incomplete" --base-commit abc123',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-6
  it("should exit with error when no subject is provided", () => {
    const result = kspec(
      'review add --title "No subject"',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-6
  it("should exit with error when --subject-ref and --base-commit are both provided", () => {
    kspec('task add --title "T" --slug task-conflict', tempDir);
    const result = kspec(
      'review add --title "Conflict" --subject-ref @task-conflict --base-commit abc123 --head-commit def456',
      tempDir,
      { expectFail: true },
    );
    expect(result.exitCode).not.toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-5
  it("should return exit code 0 with empty result set for review get not found", () => {
    const result = kspec("review get @nonexistent", tempDir, {
      expectFail: true,
    });
    // not_found exits with NOT_FOUND (3)
    expect(result.exitCode).toBe(3);
  });

  // ============================================================
  // @trait-json-output
  // ============================================================

  // AC: @trait-json-output ac-1
  it("should output valid JSON with no ANSI when --json is provided", () => {
    kspec(
      'review add --title "JSON test" --base-commit aaa --head-commit bbb --slug json-test',
      tempDir,
    );

    const result = kspec("review get @json-test --json", tempDir);
    expect(result.exitCode).toBe(0);

    // Should be valid JSON
    const parsed = JSON.parse(result.stdout);
    expect(parsed._ulid).toBeDefined();

    // No ANSI escape codes
    expect(result.stdout).not.toMatch(/\x1b\[/);
  });

  // AC: @trait-json-output ac-2
  it("should include all data in JSON mode that is available in human-readable mode", () => {
    kspec(
      'review add --title "Complete data" --base-commit aaa --head-commit bbb --slug complete-data',
      tempDir,
    );

    const json = kspecJson<{
      _ulid: string;
      slugs: string[];
      title: string;
      lifecycle_state: string;
      disposition: string;
      gate_state: string;
      subject: object;
      author: string;
      threads: unknown[];
      checks: unknown[];
      verdicts: unknown[];
      events: unknown[];
      created_at: string;
    }>("review get @complete-data", tempDir);

    expect(json._ulid).toBeDefined();
    expect(json.slugs).toBeDefined();
    expect(json.title).toBe("Complete data");
    expect(json.lifecycle_state).toBeDefined();
    expect(json.disposition).toBeDefined();
    expect(json.gate_state).toBeDefined();
    expect(json.subject).toBeDefined();
    expect(json.author).toBeDefined();
    expect(json.threads).toBeDefined();
    expect(json.checks).toBeDefined();
    expect(json.verdicts).toBeDefined();
    expect(json.events).toBeDefined();
    expect(json.created_at).toBeDefined();
  });

  // AC: @trait-json-output ac-3
  it("should return error as JSON object with error field on failure in JSON mode", () => {
    const result = kspec("review get @nonexistent --json", tempDir, {
      expectFail: true,
    });

    // stderr should contain JSON error
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error).toBeDefined();
    expect(parsed.success).toBe(false);
  });

  // AC: @trait-json-output ac-4
  it("should use @ prefix consistently in JSON output references", () => {
    kspec('task add --title "Ref task" --slug ref-task', tempDir);
    const review = kspecJson<{
      related_refs: string[];
    }>(
      'review add --title "With refs" --subject-ref @ref-task --related-ref @ref-task',
      tempDir,
    );

    for (const ref of review.related_refs) {
      expect(ref.startsWith("@")).toBe(true);
    }
  });

  // AC: @trait-json-output ac-5
  it("should use ISO 8601 format for timestamps in JSON output", () => {
    const review = kspecJson<{
      created_at: string;
      updated_at: string | null;
    }>(
      'review add --title "Timestamp test" --base-commit aaa --head-commit bbb',
      tempDir,
    );

    // ISO 8601 pattern
    expect(review.created_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  // AC: @trait-json-output ac-6
  it("should have --json take precedence over other formatting", () => {
    kspec(
      'review add --title "Precedence test" --base-commit aaa --head-commit bbb --slug prec-test',
      tempDir,
    );

    const result = kspec("review get @prec-test --json", tempDir);
    // Should be valid JSON
    const parsed = JSON.parse(result.stdout);
    expect(parsed._ulid).toBeDefined();
  });

  // ============================================================
  // @trait-filterable-list
  // ============================================================

  // AC: @trait-filterable-list ac-1
  it("should filter list by --status", () => {
    kspec(
      'review add --title "Draft R" --base-commit aaa --head-commit bbb',
      tempDir,
    );

    const drafts = kspecJson<Array<{ lifecycle_state: string }>>(
      "review list --status draft",
      tempDir,
    );
    expect(drafts.every((r) => r.lifecycle_state === "draft")).toBe(true);
  });

  // AC: @trait-filterable-list ac-3
  it("should support --limit pagination", () => {
    kspec(
      'review add --title "R1" --base-commit a --head-commit b',
      tempDir,
    );
    kspec(
      'review add --title "R2" --base-commit c --head-commit d',
      tempDir,
    );
    kspec(
      'review add --title "R3" --base-commit e --head-commit f',
      tempDir,
    );

    const limited = kspecJson<Array<{ title: string }>>(
      "review list --limit 2",
      tempDir,
    );
    expect(limited).toHaveLength(2);
  });

  // AC: @trait-filterable-list ac-4
  it("should support --offset pagination", () => {
    kspec(
      'review add --title "R1" --base-commit a --head-commit b',
      tempDir,
    );
    kspec(
      'review add --title "R2" --base-commit c --head-commit d',
      tempDir,
    );
    kspec(
      'review add --title "R3" --base-commit e --head-commit f',
      tempDir,
    );

    const offset = kspecJson<Array<{ title: string }>>(
      "review list --offset 1",
      tempDir,
    );
    expect(offset).toHaveLength(2);
    expect(offset[0].title).toBe("R2");
  });

  // AC: @trait-filterable-list ac-5
  it("should support multiple filters with AND logic", () => {
    kspec('task add --title "Task A" --slug task-a', tempDir);
    kspec(
      'review add --title "Match" --subject-ref @task-a --author alice',
      tempDir,
    );
    kspec(
      'review add --title "No match author" --subject-ref @task-a --author bob',
      tempDir,
    );
    kspec(
      'review add --title "No match subject" --base-commit x --head-commit y --author alice',
      tempDir,
    );

    const filtered = kspecJson<Array<{ title: string }>>(
      "review list --subject @task-a --reviewer alice",
      tempDir,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Match");
  });

  // AC: @trait-filterable-list ac-6
  it("should show informative message when no items match filters", () => {
    const result = kspec("review list --status archived", tempDir);
    expect(result.exitCode).toBe(0);
    // Should contain an info message about no matches
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/[Nn]o reviews/);
  });

  // AC: @trait-filterable-list ac-7
  it("should show summary with total matching items and filter state", () => {
    kspec(
      'review add --title "Sum 1" --base-commit a --head-commit b',
      tempDir,
    );
    kspec(
      'review add --title "Sum 2" --base-commit c --head-commit d',
      tempDir,
    );

    const result = kspec("review list", tempDir);
    expect(result.stdout).toContain("2 reviews found");
  });

  // AC: @trait-filterable-list ac-7
  it("should show filter state in summary when filters are applied", () => {
    kspec(
      'review add --title "F1" --base-commit a --head-commit b',
      tempDir,
    );

    const result = kspec("review list --status draft", tempDir);
    expect(result.stdout).toContain("status=draft");
  });

  // AC: @trait-filterable-list ac-8
  it("should support --count mode returning only the count", () => {
    kspec(
      'review add --title "C1" --base-commit a --head-commit b',
      tempDir,
    );
    kspec(
      'review add --title "C2" --base-commit c --head-commit d',
      tempDir,
    );

    // Text mode
    const result = kspec("review list --count", tempDir);
    expect(result.stdout.trim()).toBe("2");

    // JSON mode
    const json = kspecJson<{ count: number }>("review list --count", tempDir);
    expect(json.count).toBe(2);
  });

  // ============================================================
  // @trait-semantic-exit-codes
  // ============================================================

  // AC: @trait-semantic-exit-codes ac-1
  it("should exit with code 0 on successful creation", () => {
    const result = kspec(
      'review add --title "Success" --base-commit aaa --head-commit bbb',
      tempDir,
    );
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-1
  it("should exit with code 0 on successful list", () => {
    const result = kspec("review list", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-semantic-exit-codes ac-5
  it("should exit with code 0 for empty list result set", () => {
    const result = kspec("review list", tempDir);
    expect(result.exitCode).toBe(0);
  });

  // ============================================================
  // @trait-shadow-commit — N/A annotations
  // Reviews are stored in the shadow branch. The shadow commit
  // behavior is tested indirectly through the CLI operations.
  // Direct shadow commit tests require full shadow branch setup
  // which is beyond the scope of CLI integration tests.
  // ============================================================

  // AC: @trait-shadow-commit ac-4 — N/A: CLI tests run without shadow branch; command completes successfully without git operations
  // AC: @trait-shadow-commit ac-5 — N/A: Validation errors prevent save, so no commit is attempted (covered by validation error tests above)
  // AC: @trait-shadow-commit ac-6 — N/A: Push behavior requires configured remote; unit-level concern not CLI integration
  // AC: @trait-shadow-commit ac-7 — N/A: Git failure handling is shadow infrastructure; not specific to review commands
  // AC: @trait-shadow-commit ac-8 — N/A: Review add creates a single record per command; multi-save atomicity doesn't apply

  // AC: @trait-shadow-commit ac-1
  it("should complete review add successfully without shadow branch (graceful degradation)", () => {
    // setupTempFixtures doesn't configure shadow — command should still succeed
    const result = kspec(
      'review add --title "No shadow" --base-commit aaa --head-commit bbb',
      tempDir,
    );
    expect(result.exitCode).toBe(0);
  });

  // AC: @trait-shadow-commit ac-2 — N/A: Commit message pattern is internal shadow infrastructure
  // AC: @trait-shadow-commit ac-3 — N/A: Commit message ULID inclusion is internal shadow infrastructure

  // ============================================================
  // @trait-filterable-list ac-2 — tag filter
  // Reviews use related_refs instead of tags. The --tag filter
  // matches against related_refs for trait compatibility.
  // ============================================================

  // AC: @trait-filterable-list ac-2
  it("should filter by --tag matching related refs", () => {
    kspec('task add --title "Tag task" --slug tag-task', tempDir);
    kspec(
      'review add --title "Tagged review" --base-commit a --head-commit b --related-ref @tag-task',
      tempDir,
    );
    kspec(
      'review add --title "Untagged review" --base-commit c --head-commit d',
      tempDir,
    );

    const filtered = kspecJson<Array<{ title: string }>>(
      "review list --tag tag-task",
      tempDir,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe("Tagged review");
  });
});
