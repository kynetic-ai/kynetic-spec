/**
 * Tests for review-task integration: sync rules and linkage.
 *
 * Covers all 7 acceptance criteria from @review-task-lifecycle-integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createReviewRecord, loadReviewRecords, saveReviewRecord } from "../src/parser/reviews.js";
import {
  linkReviewToTasks,
  handleVerdictTaskTransition,
  checkReviewLinkageConsistency,
} from "../src/parser/review-task-integration.js";
import { createTask } from "../src/parser/yaml.js";
import type { KspecContext, LoadedTask } from "../src/parser/yaml.js";
import { TaskSchema } from "../src/schema/index.js";
import type { ReviewRecordInput } from "../src/schema/index.js";
import { resolveTaskDataManager } from "../src/parser/task-data-manager.js";
import { ensureSplitBackendRegistered } from "../src/parser/split-backend.js";
import { toYaml } from "../src/parser/yaml.js";
import {
  createTempDir,
  cleanupTempDir,
  initGitRepo,
  testUlid,
  testUlids,
  seedSplitTask,
} from "./helpers/cli.js";

// Register the split backend
ensureSplitBackendRegistered();

function makeCtx(tempDir: string, specDir: string): KspecContext {
  return {
    rootDir: tempDir,
    projectRoot: tempDir,
    specDir,
    sessionsDir: path.join(tempDir, ".kspec-sessions"),
    manifestPath: path.join(specDir, "kynetic.yaml"),
    manifest: {
      kynetic_spec: "1.0",
      title: "Test Project",
      task_storage: { format: "split" as const },
    } as any,
    shadow: null,
    config: {} as any,
  } as KspecContext;
}

function makeReviewInput(overrides: Partial<ReviewRecordInput> = {}): ReviewRecordInput {
  return {
    title: "Test Review",
    author: "test-reviewer",
    subject: {
      type: "code",
      base_commit: "abc123",
      head_commit: "def456",
    },
    ...overrides,
  };
}

function createAndSaveTask(
  ctx: KspecContext,
  overrides: Partial<ReturnType<typeof createTask>> & { _ulid: string; title: string },
): LoadedTask {
  const task = createTask({
    ...overrides,
  });
  // Apply overrides that createTask may not handle (e.g. status)
  const fullTask = { ...task, ...overrides };

  // Delegate file writing to the canonical helper
  seedSplitTask(
    ctx.specDir,
    fullTask as Record<string, unknown> & { _ulid: string; notes?: unknown[] },
  );

  const taskDir = path.join(ctx.specDir, "tasks", fullTask._ulid);
  return {
    ...fullTask,
    _sourceFile: path.join(taskDir, "task.yaml"),
  };
}

describe("Review-Task Integration", () => {
  let tempDir: string;
  let kspecDir: string;
  let ctx: KspecContext;

  beforeEach(async () => {
    tempDir = await createTempDir();
    kspecDir = path.join(tempDir, ".kspec");
    await fs.mkdir(path.join(kspecDir, "tasks"), { recursive: true });
    initGitRepo(tempDir);

    // Write minimal manifest with split format
    await fs.writeFile(
      path.join(kspecDir, "kynetic.yaml"),
      toYaml({
        kynetic_spec: "1.0",
        title: "Test Project",
        task_storage: { format: "split" },
      }),
    );

    // Write empty index
    await fs.writeFile(path.join(kspecDir, "project.tasks.yaml"), toYaml([]));

    ctx = makeCtx(tempDir, kspecDir);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  // ============================================================
  // AC-1: review_ref field on task schema
  // ============================================================

  // AC: @review-task-lifecycle-integration ac-1
  it("should accept review_ref field in TaskSchema", () => {
    const taskData = {
      _ulid: testUlid("TSK"),
      title: "Test Task",
      status: "pending_review" as const,
      review_ref: "@my-review",
      slugs: ["test-task"],
      type: "task" as const,
      blocked_by: [] as string[],
      depends_on: [] as string[],
      context: [] as string[],
      priority: 3,
      tags: [] as string[],
      vcs_refs: [] as Array<{ type: string; value: string }>,
      notes: [] as Array<{ _ulid: string; created_at: string; content: string }>,
      todos: [] as Array<{ id: number; text: string; done: boolean; added_at: string }>,
      created_at: new Date().toISOString(),
    };

    const result = TaskSchema.safeParse(taskData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review_ref).toBe("@my-review");
    }
  });

  // AC: @review-task-lifecycle-integration ac-1
  it("should allow review_ref to be null", () => {
    const taskData = {
      _ulid: testUlid("TSK"),
      title: "Test Task",
      review_ref: null,
    };

    const result = TaskSchema.safeParse(taskData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review_ref).toBeNull();
    }
  });

  // AC: @review-task-lifecycle-integration ac-1
  it("should allow review_ref to be absent", () => {
    const taskData = {
      _ulid: testUlid("TSK"),
      title: "Test Task",
    };

    const result = TaskSchema.safeParse(taskData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review_ref).toBeUndefined();
    }
  });

  // AC: @review-task-lifecycle-integration ac-1
  it("should persist review_ref through save and load cycle", async () => {
    const taskUlid = testUlid("TSK");
    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Task With Review Ref",
      slugs: ["task-with-review"],
      status: "pending_review",
      review_ref: "@my-review",
    });

    const manager = resolveTaskDataManager(ctx);
    const loaded = await manager.loadAllTasks(ctx);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].review_ref).toBe("@my-review");
  });

  // ============================================================
  // AC-2: review add with task subject auto-sets review_ref
  // ============================================================

  // AC: @review-task-lifecycle-integration ac-2
  it("should auto-set review_ref when review is created with task subject", async () => {
    const [taskUlid, reviewUlid] = testUlids("INT", 2);

    // Create a task in pending_review
    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Task Under Review",
      slugs: ["task-under-review"],
      status: "pending_review",
    });

    // Create a review with task subject
    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["code-review-1"],
        subject: {
          type: "task",
          ref: "@task-under-review",
          shadow_commit: "abc123",
          content_hash: "hash123",
        },
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    // Link the review to tasks
    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const result = await linkReviewToTasks(ctx, review, tasks);

    expect(result.linkedTasks).toHaveLength(1);
    expect(result.linkedTasks[0].slug).toBe("task-under-review");

    // Verify the task now has review_ref
    const updatedTasks = await manager.loadAllTasks(ctx);
    const updatedTask = updatedTasks.find((t) => t._ulid === taskUlid);
    expect(updatedTask?.review_ref).toBe("@code-review-1");
  });

  // AC: @review-task-lifecycle-integration ac-2
  it("should use review ULID as ref when review has no slug", async () => {
    const [taskUlid, reviewUlid] = testUlids("INT", 2);

    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Task Under Review",
      slugs: ["task-no-slug-review"],
      status: "pending_review",
    });

    // Create review without slugs
    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: [],
        subject: {
          type: "task",
          ref: "@task-no-slug-review",
          shadow_commit: "abc123",
          content_hash: "hash123",
        },
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    await linkReviewToTasks(ctx, review, tasks);

    const updatedTasks = await manager.loadAllTasks(ctx);
    const updatedTask = updatedTasks.find((t) => t._ulid === taskUlid);
    expect(updatedTask?.review_ref).toBe(`@${reviewUlid}`);
  });

  // ============================================================
  // AC-3: review add with --related @task-ref sets review_ref
  // ============================================================

  // AC: @review-task-lifecycle-integration ac-3
  it("should auto-set review_ref when task is in related_refs of a code review", async () => {
    const [taskUlid, reviewUlid] = testUlids("REL", 2);

    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Related Task",
      slugs: ["related-task"],
      status: "pending_review",
    });

    // Create code review with task in related_refs
    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["code-review-related"],
        subject: {
          type: "code",
          base_commit: "abc123",
          head_commit: "def456",
        },
        related_refs: ["@related-task"],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const result = await linkReviewToTasks(ctx, review, tasks);

    expect(result.linkedTasks).toHaveLength(1);
    expect(result.linkedTasks[0].slug).toBe("related-task");

    // Verify review_ref set on the related task
    const updatedTasks = await manager.loadAllTasks(ctx);
    const updatedTask = updatedTasks.find((t) => t._ulid === taskUlid);
    expect(updatedTask?.review_ref).toBe("@code-review-related");
  });

  // AC: @review-task-lifecycle-integration ac-3
  it("should link review to multiple related tasks", async () => {
    const [task1Ulid, task2Ulid, reviewUlid] = testUlids("MUL", 3);

    createAndSaveTask(ctx, {
      _ulid: task1Ulid,
      title: "First Related Task",
      slugs: ["first-related"],
      status: "pending_review",
    });

    createAndSaveTask(ctx, {
      _ulid: task2Ulid,
      title: "Second Related Task",
      slugs: ["second-related"],
      status: "in_progress",
    });

    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["multi-task-review"],
        subject: {
          type: "code",
          base_commit: "abc123",
          head_commit: "def456",
        },
        related_refs: ["@first-related", "@second-related"],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const result = await linkReviewToTasks(ctx, review, tasks);

    expect(result.linkedTasks).toHaveLength(2);

    const updatedTasks = await manager.loadAllTasks(ctx);
    expect(updatedTasks.find((t) => t._ulid === task1Ulid)?.review_ref).toBe("@multi-task-review");
    expect(updatedTasks.find((t) => t._ulid === task2Ulid)?.review_ref).toBe("@multi-task-review");
  });

  // AC: @review-task-lifecycle-integration ac-3
  it("should not link non-task related_refs", async () => {
    const reviewUlid = testUlid("NTK");

    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["spec-review"],
        subject: {
          type: "code",
          base_commit: "abc123",
          head_commit: "def456",
        },
        related_refs: ["@some-spec-item"], // Not a task
      }),
    );

    // No tasks exist
    const tasks: LoadedTask[] = [];
    const result = await linkReviewToTasks(ctx, review, tasks);
    expect(result.linkedTasks).toHaveLength(0);
  });

  // ============================================================
  // AC-4: changes_requested verdict transitions task to needs_work
  // ============================================================

  // AC: @review-task-lifecycle-integration ac-4
  it("should transition task to needs_work on changes_requested verdict", async () => {
    const [taskUlid, reviewUlid] = testUlids("VRD", 2);

    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Task Needing Changes",
      slugs: ["task-needing-changes"],
      status: "pending_review",
      review_ref: "@verdict-review",
    });

    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["verdict-review"],
        subject: {
          type: "task",
          ref: "@task-needing-changes",
          shadow_commit: "abc123",
          content_hash: "hash123",
        },
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const results = await handleVerdictTaskTransition(
      ctx,
      review,
      "request_changes",
      tasks,
      "test-reviewer",
    );

    expect(results).toHaveLength(1);
    expect(results[0].transitioned).toBe(true);

    // Verify the task is now needs_work
    const updatedTasks = await manager.loadAllTasks(ctx);
    const updatedTask = updatedTasks.find((t) => t._ulid === taskUlid);
    expect(updatedTask?.status).toBe("needs_work");
    // Verify fix cycle note was added
    expect(updatedTask?.notes.some((n) => n.content.includes("[FIX_CYCLE: 1]"))).toBe(true);
    expect(updatedTask?.notes.some((n) => n.content.includes("test-reviewer"))).toBe(true);
  });

  // AC: @review-task-lifecycle-integration ac-4
  it("should not transition task if not in pending_review", async () => {
    const [taskUlid, reviewUlid] = testUlids("VNT", 2);

    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "In Progress Task",
      slugs: ["in-progress-task"],
      status: "in_progress",
    });

    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        subject: {
          type: "task",
          ref: "@in-progress-task",
          shadow_commit: "abc123",
          content_hash: "hash123",
        },
      }),
    );

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const results = await handleVerdictTaskTransition(
      ctx,
      review,
      "request_changes",
      tasks,
      "test-reviewer",
    );

    expect(results).toHaveLength(1);
    expect(results[0].transitioned).toBe(false);

    // Status should remain unchanged
    const updatedTasks = await manager.loadAllTasks(ctx);
    expect(updatedTasks.find((t) => t._ulid === taskUlid)?.status).toBe("in_progress");
  });

  // AC: @review-task-lifecycle-integration ac-4
  it("should not transition on approve verdict", async () => {
    const [taskUlid, reviewUlid] = testUlids("VAP", 2);

    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Approved Task",
      slugs: ["approved-task"],
      status: "pending_review",
    });

    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        subject: {
          type: "task",
          ref: "@approved-task",
          shadow_commit: "abc123",
          content_hash: "hash123",
        },
      }),
    );

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const results = await handleVerdictTaskTransition(
      ctx,
      review,
      "approve",
      tasks,
      "test-reviewer",
    );

    // approve should not trigger any transitions
    expect(results).toHaveLength(0);

    // Status should remain pending_review
    const updatedTasks = await manager.loadAllTasks(ctx);
    expect(updatedTasks.find((t) => t._ulid === taskUlid)?.status).toBe("pending_review");
  });

  // AC: @review-task-lifecycle-integration ac-4
  it("should transition related tasks on changes_requested for code review", async () => {
    const [taskUlid, reviewUlid] = testUlids("VRC", 2);

    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Related Code Review Task",
      slugs: ["related-code-task"],
      status: "pending_review",
    });

    // Code review with related task
    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        subject: {
          type: "code",
          base_commit: "abc123",
          head_commit: "def456",
        },
        related_refs: ["@related-code-task"],
      }),
    );

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    const results = await handleVerdictTaskTransition(
      ctx,
      review,
      "request_changes",
      tasks,
      "test-reviewer",
    );

    expect(results).toHaveLength(1);
    expect(results[0].transitioned).toBe(true);

    const updatedTasks = await manager.loadAllTasks(ctx);
    expect(updatedTasks.find((t) => t._ulid === taskUlid)?.status).toBe("needs_work");
  });

  // ============================================================
  // AC-5: Warning for inconsistent review linkage
  // ============================================================

  // AC: @review-task-lifecycle-integration ac-5
  it("should warn when pending_review task has no review_ref", () => {
    const taskUlid = testUlid("WRN");

    const tasks: LoadedTask[] = [
      {
        _ulid: taskUlid,
        title: "No Review Ref Task",
        slugs: ["no-review-ref"],
        status: "pending_review",
        type: "task",
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 3,
        tags: [],
        vcs_refs: [],
        notes: [],
        todos: [],
        created_at: new Date().toISOString(),
        _sourceFile: "/fake/path",
      },
    ];

    const warnings = checkReviewLinkageConsistency(tasks, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].taskRef).toBe("@no-review-ref");
    expect(warnings[0].message).toContain("no review_ref");
  });

  // AC: @review-task-lifecycle-integration ac-5
  it("should warn when review_ref points to a closed review", async () => {
    const [taskUlid, reviewUlid] = testUlids("WCL", 2);

    const tasks: LoadedTask[] = [
      {
        _ulid: taskUlid,
        title: "Closed Review Task",
        slugs: ["closed-review-task"],
        status: "pending_review",
        review_ref: "@closed-review",
        type: "task",
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 3,
        tags: [],
        vcs_refs: [],
        notes: [],
        todos: [],
        created_at: new Date().toISOString(),
        _sourceFile: "/fake/path",
      },
    ];

    const reviews = [
      {
        _ulid: reviewUlid,
        slugs: ["closed-review"],
        title: "Closed Review",
        lifecycle_state: "closed" as const,
        subject: { type: "code" as const, base_commit: "abc", head_commit: "def" },
        author: "test",
        related_refs: [] as string[],
        threads: [],
        checks: [],
        verdicts: [],
        events: [],
        notes: [],
        external_links: [],
        created_at: new Date().toISOString(),
        updated_at: null,
        _sourceFile: "/fake/path",
      },
    ];

    const warnings = checkReviewLinkageConsistency(tasks, reviews);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("closed");
  });

  // AC: @review-task-lifecycle-integration ac-5
  it("should warn when review_ref points to nonexistent review", () => {
    const taskUlid = testUlid("WNE");

    const tasks: LoadedTask[] = [
      {
        _ulid: taskUlid,
        title: "Missing Review Task",
        slugs: ["missing-review-task"],
        status: "pending_review",
        review_ref: "@nonexistent-review",
        type: "task",
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 3,
        tags: [],
        vcs_refs: [],
        notes: [],
        todos: [],
        created_at: new Date().toISOString(),
        _sourceFile: "/fake/path",
      },
    ];

    const warnings = checkReviewLinkageConsistency(tasks, []);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("not found");
  });

  // AC: @review-task-lifecycle-integration ac-5
  it("should not warn when pending_review task has valid open review", () => {
    const [taskUlid, reviewUlid] = testUlids("WOK", 2);

    const tasks: LoadedTask[] = [
      {
        _ulid: taskUlid,
        title: "Good Review Task",
        slugs: ["good-review-task"],
        status: "pending_review",
        review_ref: "@good-review",
        type: "task",
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 3,
        tags: [],
        vcs_refs: [],
        notes: [],
        todos: [],
        created_at: new Date().toISOString(),
        _sourceFile: "/fake/path",
      },
    ];

    const reviews = [
      {
        _ulid: reviewUlid,
        slugs: ["good-review"],
        title: "Good Review",
        lifecycle_state: "open" as const,
        subject: { type: "code" as const, base_commit: "abc", head_commit: "def" },
        author: "test",
        related_refs: [] as string[],
        threads: [],
        checks: [],
        verdicts: [],
        events: [],
        notes: [],
        external_links: [],
        created_at: new Date().toISOString(),
        updated_at: null,
        _sourceFile: "/fake/path",
      },
    ];

    const warnings = checkReviewLinkageConsistency(tasks, reviews);
    expect(warnings).toHaveLength(0);
  });

  // AC: @review-task-lifecycle-integration ac-5
  it("should not warn for tasks not in pending_review", () => {
    const taskUlid = testUlid("WIP");

    const tasks: LoadedTask[] = [
      {
        _ulid: taskUlid,
        title: "In Progress Task",
        slugs: ["in-progress"],
        status: "in_progress",
        type: "task",
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 3,
        tags: [],
        vcs_refs: [],
        notes: [],
        todos: [],
        created_at: new Date().toISOString(),
        _sourceFile: "/fake/path",
      },
    ];

    const warnings = checkReviewLinkageConsistency(tasks, []);
    expect(warnings).toHaveLength(0);
  });

  // ============================================================
  // AC-6: Review history preserved through fix cycles
  // ============================================================

  // AC: @review-task-lifecycle-integration ac-6
  it("should preserve review record through needs_work and re-review cycle", async () => {
    const [taskUlid, reviewUlid] = testUlids("FIX", 2);

    // Create task in pending_review with review_ref
    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Fix Cycle Task",
      slugs: ["fix-cycle-task"],
      status: "pending_review",
      review_ref: "@fix-review",
    });

    // Create the review
    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["fix-review"],
        lifecycle_state: "open",
        subject: {
          type: "task",
          ref: "@fix-cycle-task",
          shadow_commit: "abc123",
          content_hash: "hash123",
        },
        // Some existing verdicts and threads to prove history preservation
        verdicts: [
          {
            reviewer: "reviewer-1",
            role: "reviewer",
            decision: "comment",
            applies_to_version: { type: "entity_version", content_hash: "hash123" },
            created_at: new Date().toISOString(),
          },
        ],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    // Simulate changes_requested verdict transition
    const manager = resolveTaskDataManager(ctx);
    let tasks = await manager.loadAllTasks(ctx);
    await handleVerdictTaskTransition(ctx, review, "request_changes", tasks, "test-reviewer");

    // Verify task is now needs_work
    tasks = await manager.loadAllTasks(ctx);
    const needsWorkTask = tasks.find((t) => t._ulid === taskUlid);
    expect(needsWorkTask?.status).toBe("needs_work");
    expect(needsWorkTask?.review_ref).toBe("@fix-review"); // review_ref preserved

    // Verify the review record is still intact with its history
    const reviews = await loadReviewRecords(ctx);
    const loadedReview = reviews.find((r) => r._ulid === reviewUlid);
    expect(loadedReview).toBeDefined();
    expect(loadedReview?.verdicts).toHaveLength(1);
    expect(loadedReview?.lifecycle_state).toBe("open"); // Review still open
  });

  // AC: @review-task-lifecycle-integration ac-6
  it("should increment fix cycle counter on repeated changes_requested", async () => {
    const [taskUlid, reviewUlid] = testUlids("FC2", 2);

    // Create task with existing fix cycle note
    createAndSaveTask(ctx, {
      _ulid: taskUlid,
      title: "Multi Cycle Task",
      slugs: ["multi-cycle-task"],
      status: "pending_review",
      review_ref: "@multi-review",
      notes: [
        {
          _ulid: testUlid("NT1"),
          created_at: new Date().toISOString(),
          content: "[FIX_CYCLE: 1] First review findings",
        },
      ],
    });

    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["multi-review"],
        subject: {
          type: "task",
          ref: "@multi-cycle-task",
          shadow_commit: "abc123",
          content_hash: "hash123",
        },
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const manager = resolveTaskDataManager(ctx);
    const tasks = await manager.loadAllTasks(ctx);
    await handleVerdictTaskTransition(ctx, review, "request_changes", tasks, "test-reviewer");

    const updatedTasks = await manager.loadAllTasks(ctx);
    const updatedTask = updatedTasks.find((t) => t._ulid === taskUlid);
    // Should be cycle 2 since there's already a cycle 1 note
    expect(updatedTask?.notes.some((n) => n.content.includes("[FIX_CYCLE: 2]"))).toBe(true);
  });

  // ============================================================
  // AC-7: External links treated as compatibility linkage
  // ============================================================

  // AC: @review-task-lifecycle-integration ac-7
  it("should store external links without making them source of truth", () => {
    // This is an architectural constraint: review_url on tasks and
    // external_links on reviews are non-authoritative. The review_ref
    // field is the durable linkage. This test verifies both can coexist.
    const taskData = {
      _ulid: testUlid("EXT"),
      title: "Task with External Link",
      status: "pending_review" as const,
      review_ref: "@my-review-record", // Durable review linkage
      review_url: "https://github.com/org/repo/pull/42", // Compatibility
    };

    const result = TaskSchema.safeParse(taskData);
    expect(result.success).toBe(true);
    if (result.success) {
      // Both fields coexist: review_ref is authoritative, review_url is compatibility
      expect(result.data.review_ref).toBe("@my-review-record");
      expect(result.data.review_url).toBe("https://github.com/org/repo/pull/42");
    }
  });

  // AC: @review-task-lifecycle-integration ac-7
  it("should allow review records with external links alongside local state", async () => {
    const reviewUlid = testUlid("EXR");

    const review = createReviewRecord(
      makeReviewInput({
        _ulid: reviewUlid,
        slugs: ["external-linked-review"],
        external_links: [
          {
            url: "https://github.com/org/repo/pull/42",
            provider: "github",
            external_id: "42",
            label: "PR #42",
          },
        ],
      }),
    );
    await saveReviewRecord(ctx, { ...review });

    const reviews = await loadReviewRecords(ctx);
    const loadedReview = reviews.find((r) => r._ulid === reviewUlid);
    expect(loadedReview).toBeDefined();
    expect(loadedReview?.external_links).toHaveLength(1);
    expect(loadedReview?.external_links[0].provider).toBe("github");
    // Local lifecycle_state is the source of truth, not the external link
    expect(loadedReview?.lifecycle_state).toBe("draft");
  });
});
