import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createTempDir, cleanupTempDir, testUlid, testUlids } from "./helpers/cli.js";
import {
  toYaml,
  parseYaml,
  writeYamlFile,
  readYamlFile,
  writeYamlFilePreserveFormat,
  initContext,
  saveTask,
  mutateTaskAtomically,
  loadAllTasks,
  saveInboxItem,
  mutateInboxItemAtomically,
  deleteInboxItem,
  loadInboxItems,
} from "../src/parser/yaml.js";
import type { LoadedTask, LoadedInboxItem } from "../src/parser/yaml.js";
import {
  createReviewRecord,
  loadReviewRecords,
  saveReviewRecord,
  mutateReviewAtomically,
  deleteReviewRecord,
} from "../src/parser/reviews.js";
import {
  saveDispatchWorkspaceRecord,
  mutateDispatchWorkspaceRecordAtomically,
  loadDispatchWorkspaceRegistry,
  getDispatchWorkspaceRegistryPath,
} from "../src/parser/dispatch-workspaces.js";
import type { LoadedDispatchWorkspaceRecord } from "../src/parser/dispatch-workspaces.js";
import type { KspecContext } from "../src/parser/yaml.js";
import type { ReviewRecordInput } from "../src/schema/index.js";

/**
 * Round-trip stability tests for YAML serialization.
 *
 * Verifies that reading a YAML file and re-writing it without logical changes
 * produces identical output. This prevents noisy diffs in shadow branch history.
 */

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempDir("yaml-rt-");
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — toYaml", () => {
  it("round-trips a task with block scalar description", () => {
    const obj = {
      _ulid: testUlid("TASK", 1),
      slugs: ["task-with-description"],
      title: "Task with block scalar",
      type: "task",
      description:
        "This is a multi-line description.\nIt spans several lines.\n\nWith blank lines in between.",
      status: "pending",
      priority: 2,
      tags: ["test"],
      created_at: "2026-01-01T00:00:00.000Z",
      notes: [],
      todos: [],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips records with null and undefined fields", () => {
    const obj = {
      _ulid: testUlid("TASK", 2),
      slugs: ["task-nulls"],
      title: "Task with nulls",
      type: "task",
      description: null,
      spec_ref: null,
      status: "pending",
      notes: [],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips records with empty arrays and objects", () => {
    const obj = {
      _ulid: testUlid("TASK", 3),
      slugs: [],
      title: "Task empty collections",
      type: "task",
      status: "pending",
      depends_on: [],
      tags: [],
      notes: [],
      todos: [],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips deeply nested spec items with acceptance criteria", () => {
    const obj = {
      _ulid: testUlid("SPEC", 1),
      slugs: ["deep-spec"],
      title: "Deeply nested spec",
      type: "module",
      description: "A module with nested features and requirements.",
      features: [
        {
          _ulid: testUlid("FEAT", 1),
          slugs: ["nested-feature"],
          title: "Nested Feature",
          type: "feature",
          description: "Feature with requirements.",
          requirements: [
            {
              _ulid: testUlid("REQ", 1),
              slugs: ["nested-req"],
              title: "Nested Requirement",
              type: "requirement",
              acceptance_criteria: [
                {
                  id: "ac-1",
                  given: "a precondition with special chars: colon, #hash, @ref",
                  when: "the action is performed",
                  then: "the expected result occurs",
                },
                {
                  id: "ac-2",
                  given: "a multi-line\nprecondition",
                  when: "action occurs",
                  then: "result is correct",
                },
              ],
              traits: ["@trait-json-output"],
            },
          ],
        },
      ],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips review records stably", () => {
    const obj = {
      _ulid: testUlid("REVW", 1),
      slugs: ["review-test"],
      title: "Review record",
      type: "review",
      status: "open",
      disposition: null,
      created_at: "2026-01-15T10:00:00.000Z",
      notes: [
        {
          _ulid: testUlid("N0TE", 1),
          created_at: "2026-01-15T10:05:00.000Z",
          author: "@reviewer",
          content:
            "Found an issue with the implementation.\nNeeds to handle edge case.",
        },
      ],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips strings with YAML-special characters", () => {
    const obj = {
      _ulid: testUlid("TASK", 4),
      slugs: ["special-chars"],
      title: "Task: with colon",
      type: "task",
      description: "Description with {braces}, [brackets], and 'quotes'",
      status: "pending",
      tags: ["tag:with:colons", "tag-normal"],
      notes: [
        {
          _ulid: testUlid("N0TE", 2),
          created_at: "2026-01-01T00:00:00.000Z",
          author: "@test",
          content: "Note with @ref and #hash and `backticks`",
        },
      ],
    };
    const yaml1 = toYaml(obj);
    const parsed = parseYaml<typeof obj>(yaml1);
    const yaml2 = toYaml(parsed);
    expect(yaml2).toBe(yaml1);
  });

  it("round-trips the whitespace-only line fix across multiple cycles", () => {
    // Regression test: yaml library bug causes whitespace-only lines to accumulate
    const obj = {
      _ulid: testUlid("TASK", 5),
      title: "Block scalar task",
      type: "task",
      description: "Line one.\n\nLine after blank.\n\nAnother section.",
      status: "pending",
    };
    // Multiple cycles — the bug causes growth on each cycle
    let yaml = toYaml(obj);
    for (let i = 0; i < 5; i++) {
      const parsed = parseYaml<typeof obj>(yaml);
      const next = toYaml(parsed);
      expect(next).toBe(yaml);
      yaml = next;
    }
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — file-level", () => {
  it("writeYamlFile then readYamlFile then writeYamlFile produces identical content", async () => {
    const filePath = path.join(tempDir, "round-trip.yaml");
    const data = {
      _ulid: testUlid("TASK", 10),
      slugs: ["file-rt"],
      title: "File round trip",
      type: "task",
      description: "Test file-level round trip.",
      status: "pending",
      priority: 2,
      tags: ["test"],
      created_at: "2026-01-01T00:00:00.000Z",
      notes: [],
      todos: [],
    };

    await writeYamlFile(filePath, data);
    const content1 = await fs.readFile(filePath, "utf-8");

    const loaded = await readYamlFile<typeof data>(filePath);
    await writeYamlFile(filePath, loaded);
    const content2 = await fs.readFile(filePath, "utf-8");

    expect(content2).toBe(content1);
  });

  it("writeYamlFilePreserveFormat round-trips identically", async () => {
    const filePath = path.join(tempDir, "preserve-rt.yaml");
    const data = {
      tasks: [
        {
          _ulid: testUlid("TASK", 11),
          slugs: ["preserve-1"],
          title: "First task",
          type: "task",
          status: "pending",
          notes: [],
        },
        {
          _ulid: testUlid("TASK", 12),
          slugs: ["preserve-2"],
          title: "Second task",
          type: "task",
          status: "completed",
          notes: [
            {
              _ulid: testUlid("N0TE", 10),
              created_at: "2026-02-01T00:00:00.000Z",
              author: "@agent",
              content: "Multi-line note.\n\nWith paragraphs.",
            },
          ],
        },
      ],
    };

    await writeYamlFilePreserveFormat(filePath, data);
    const content1 = await fs.readFile(filePath, "utf-8");

    const loaded = await readYamlFile<typeof data>(filePath);
    await writeYamlFilePreserveFormat(filePath, loaded);
    const content2 = await fs.readFile(filePath, "utf-8");

    expect(content2).toBe(content1);
  });

  it("round-trips a spec module file through file write/read cycles", async () => {
    const filePath = path.join(tempDir, "spec-module.yaml");
    const data = {
      _ulid: testUlid("M0DV", 1),
      slugs: ["test-module"],
      title: "Test Module",
      type: "module",
      description: "A module for testing round-trip stability.",
      features: [
        {
          _ulid: testUlid("FEAT", 10),
          slugs: ["test-feature"],
          title: "Test Feature",
          type: "feature",
          description: "A feature with acceptance criteria.",
          acceptance_criteria: [
            {
              id: "ac-1",
              given: "the system is initialized",
              when: "the feature is activated",
              then: "it behaves correctly",
            },
          ],
          traits: ["@trait-json-output"],
          requirements: [
            {
              _ulid: testUlid("REQ", 10),
              slugs: ["test-req"],
              title: "Test Requirement",
              type: "requirement",
              acceptance_criteria: [
                {
                  id: "ac-1",
                  given: "a specific condition",
                  when: "an action is taken",
                  then: "the requirement is met",
                },
              ],
            },
          ],
        },
      ],
    };

    await writeYamlFile(filePath, data);
    const content1 = await fs.readFile(filePath, "utf-8");

    // Multiple read-write cycles
    for (let i = 0; i < 3; i++) {
      const loaded = await readYamlFile<typeof data>(filePath);
      await writeYamlFile(filePath, loaded);
    }
    const contentFinal = await fs.readFile(filePath, "utf-8");

    expect(contentFinal).toBe(content1);
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — saveTask path", () => {
  /**
   * Helper: set up a minimal kspec context with a task file.
   */
  async function setupTaskContext(tasks: Record<string, unknown>[]) {
    // Write manifest
    const manifestPath = path.join(tempDir, "kynetic.yaml");
    await writeYamlFile(manifestPath, {
      name: "test-project",
      modules: [],
    });

    // Write task file with tasks: wrapper
    const taskFilePath = path.join(tempDir, "project.tasks.yaml");
    await writeYamlFile(taskFilePath, { tasks });

    // Get the content after initial canonical write
    const initialContent = await fs.readFile(taskFilePath, "utf-8");

    // Init context pointing at tempDir as specDir
    const ctx = await initContext(tempDir);

    return { ctx, taskFilePath, initialContent };
  }

  it("saveTask with no changes produces identical file", async () => {
    const taskData = {
      _ulid: testUlid("TASK", 20),
      slugs: ["no-change-task"],
      title: "No change task",
      type: "task",
      status: "pending",
      priority: 2,
      tags: ["test"],
      description: "This task should not change.",
      depends_on: [],
      notes: [],
      todos: [],
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const { ctx, taskFilePath, initialContent } =
      await setupTaskContext([taskData]);

    // Load tasks and save the first one back with no modifications
    const loadedTasks = await loadAllTasks(ctx);
    expect(loadedTasks.length).toBe(1);

    await saveTask(ctx, loadedTasks[0]);
    const afterContent = await fs.readFile(taskFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("mutateTaskAtomically with identity function produces identical file", async () => {
    const taskData = {
      _ulid: testUlid("TASK", 21),
      slugs: ["identity-mutate"],
      title: "Identity mutation task",
      type: "task",
      status: "in_progress",
      priority: 1,
      tags: ["schema"],
      description: "A task for testing identity mutation stability.",
      depends_on: [],
      notes: [
        {
          _ulid: testUlid("N0TE", 20),
          created_at: "2026-01-15T00:00:00.000Z",
          author: "@agent",
          content: "Started working on this.",
        },
      ],
      todos: [
        {
          id: 1,
          text: "Step one",
          done: true,
          added_at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          text: "Step two",
          done: false,
          added_at: "2026-01-01T00:30:00.000Z",
        },
      ],
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-15T00:00:00.000Z",
    };

    const { ctx, taskFilePath, initialContent } =
      await setupTaskContext([taskData]);

    const loadedTasks = await loadAllTasks(ctx);
    // Identity mutation: return the task unchanged
    await mutateTaskAtomically(ctx, loadedTasks[0], (t) => t);
    const afterContent = await fs.readFile(taskFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("saveTask preserves file stability across multiple tasks", async () => {
    const tasks = [
      {
        _ulid: testUlid("TASK", 30),
        slugs: ["multi-1"],
        title: "First of many",
        type: "task",
        status: "pending",
        priority: 2,
        tags: ["test"],
        description: "First task in multi-task file.",
        depends_on: [],
        notes: [],
        todos: [],
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        _ulid: testUlid("TASK", 31),
        slugs: ["multi-2"],
        title: "Second of many",
        type: "task",
        status: "completed",
        priority: 3,
        tags: ["test"],
        description: "Second task in multi-task file.",
        depends_on: [],
        notes: [
          {
            _ulid: testUlid("N0TE", 30),
            created_at: "2026-01-02T00:00:00.000Z",
            author: "@agent",
            content: "Done.",
          },
        ],
        todos: [],
        created_at: "2026-01-01T00:00:00.000Z",
        completed_at: "2026-01-02T00:00:00.000Z",
      },
    ];

    const { ctx, taskFilePath, initialContent } =
      await setupTaskContext(tasks);

    // Load and save each task individually — file should not change
    const loadedTasks = await loadAllTasks(ctx);
    for (const task of loadedTasks) {
      await saveTask(ctx, task);
    }
    const afterContent = await fs.readFile(taskFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — saveReviewRecord path", () => {
  function makeReviewCtx(specDir: string): KspecContext {
    return { specDir } as KspecContext;
  }

  function makeReviewInput(overrides: Partial<ReviewRecordInput> = {}): ReviewRecordInput {
    return {
      title: "Test Review",
      author: "test-author",
      subject: {
        type: "code",
        base_commit: "abc123",
        head_commit: "def456",
      },
      ...overrides,
    };
  }

  it("saveReviewRecord with no changes produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-review-rt1");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeReviewCtx(kspecDir);

    const reviewUlid = testUlid("RRTK");
    const review = createReviewRecord(makeReviewInput({
      _ulid: reviewUlid,
      slugs: ["no-change-review"],
      lifecycle_state: "open",
      related_refs: ["@some-task"],
    }));

    // Save review initially
    await saveReviewRecord(ctx, { ...review });
    const initialContent = await fs.readFile(
      path.join(kspecDir, "project.reviews.yaml"),
      "utf-8",
    );

    // Load and save back with no modifications
    const loaded = await loadReviewRecords(ctx);
    expect(loaded).toHaveLength(1);
    await saveReviewRecord(ctx, loaded[0]);
    const afterContent = await fs.readFile(
      path.join(kspecDir, "project.reviews.yaml"),
      "utf-8",
    );

    expect(afterContent).toBe(initialContent);
  });

  it("mutateReviewAtomically with identity function produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-review-rt2");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeReviewCtx(kspecDir);

    const [reviewUlid, threadUlid, entryUlid] = testUlids("RRTM", 3);
    const review = createReviewRecord(makeReviewInput({
      _ulid: reviewUlid,
      slugs: ["identity-mutate-review"],
      lifecycle_state: "open",
      threads: [{
        _ulid: threadUlid,
        kind: "blocker",
        entries: [{
          _ulid: entryUlid,
          author: "reviewer",
          body: "Needs fixing",
          created_at: "2026-01-15T10:00:00.000Z",
        }],
      }],
    }));

    await saveReviewRecord(ctx, { ...review });
    const initialContent = await fs.readFile(
      path.join(kspecDir, "project.reviews.yaml"),
      "utf-8",
    );

    // Identity mutation: return the review unchanged
    const loaded = await loadReviewRecords(ctx);
    await mutateReviewAtomically(ctx, loaded[0], (r) => r);
    const afterContent = await fs.readFile(
      path.join(kspecDir, "project.reviews.yaml"),
      "utf-8",
    );

    expect(afterContent).toBe(initialContent);
  });

  it("saveReviewRecord preserves file stability across multiple reviews", async () => {
    const kspecDir = path.join(tempDir, ".kspec-review-rt3");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeReviewCtx(kspecDir);

    const [ulid1, ulid2, ulid3] = testUlids("RRTX", 3);
    const reviews = [
      createReviewRecord(makeReviewInput({
        _ulid: ulid1,
        slugs: ["multi-review-1"],
        lifecycle_state: "draft",
      })),
      createReviewRecord(makeReviewInput({
        _ulid: ulid2,
        slugs: ["multi-review-2"],
        lifecycle_state: "open",
        related_refs: ["@task-foo"],
      })),
      createReviewRecord(makeReviewInput({
        _ulid: ulid3,
        slugs: ["multi-review-3"],
        lifecycle_state: "closed",
      })),
    ];

    // Save all reviews initially
    for (const review of reviews) {
      await saveReviewRecord(ctx, { ...review });
    }
    const initialContent = await fs.readFile(
      path.join(kspecDir, "project.reviews.yaml"),
      "utf-8",
    );

    // Load and save each review individually — file should not change
    const loaded = await loadReviewRecords(ctx);
    for (const review of loaded) {
      await saveReviewRecord(ctx, review);
    }
    const afterContent = await fs.readFile(
      path.join(kspecDir, "project.reviews.yaml"),
      "utf-8",
    );

    expect(afterContent).toBe(initialContent);
  });

  it("non-target reviews are not polluted with Zod defaults", async () => {
    const kspecDir = path.join(tempDir, ".kspec-review-rt4");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeReviewCtx(kspecDir);

    // Write a minimal review file directly — only required fields
    const reviewsPath = path.join(kspecDir, "project.reviews.yaml");
    const [ulid1, ulid2] = testUlids("RRTP", 2);
    await writeYamlFilePreserveFormat(reviewsPath, {
      kynetic_reviews: "1.0",
      reviews: [
        {
          _ulid: ulid1,
          title: "Minimal review 1",
          author: "test",
          subject: { type: "code", base_commit: "aaa", head_commit: "bbb" },
          lifecycle_state: "draft",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          title: "Minimal review 2",
          author: "test",
          subject: { type: "code", base_commit: "ccc", head_commit: "ddd" },
          lifecycle_state: "draft",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    const initialContent = await fs.readFile(reviewsPath, "utf-8");

    // Mutate only the first review
    const loaded = await loadReviewRecords(ctx);
    await mutateReviewAtomically(ctx, loaded[0], (r) => ({
      ...r,
      lifecycle_state: "open",
    }));
    const afterContent = await fs.readFile(reviewsPath, "utf-8");

    // The second review should not gain any new fields (e.g. slugs, threads, checks, etc.)
    expect(afterContent).not.toContain("slugs:");
    expect(afterContent).not.toContain("threads:");
    expect(afterContent).not.toContain("checks:");
    expect(afterContent).not.toContain("verdicts:");
    expect(afterContent).not.toContain("events:");
    expect(afterContent).not.toContain("notes:");
    expect(afterContent).not.toContain("external_links:");
    expect(afterContent).not.toContain("examined_commit:");

    // But the mutation should have taken effect
    const reloaded = await loadReviewRecords(ctx);
    expect(reloaded[0].lifecycle_state).toBe("open");
    expect(reloaded[1].lifecycle_state).toBe("draft");
  });

  it("deleteReviewRecord preserves non-target reviews as raw data", async () => {
    const kspecDir = path.join(tempDir, ".kspec-review-rt5");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeReviewCtx(kspecDir);

    // Write a minimal review file directly
    const reviewsPath = path.join(kspecDir, "project.reviews.yaml");
    const [ulid1, ulid2] = testUlids("RRTD", 2);
    await writeYamlFilePreserveFormat(reviewsPath, {
      kynetic_reviews: "1.0",
      reviews: [
        {
          _ulid: ulid1,
          title: "Review to delete",
          author: "test",
          subject: { type: "code", base_commit: "aaa", head_commit: "bbb" },
          lifecycle_state: "draft",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          title: "Review to keep",
          author: "test",
          subject: { type: "code", base_commit: "ccc", head_commit: "ddd" },
          lifecycle_state: "open",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    await deleteReviewRecord(ctx, ulid1);
    const afterContent = await fs.readFile(reviewsPath, "utf-8");

    // Remaining review should not gain Zod default fields
    expect(afterContent).not.toContain("slugs:");
    expect(afterContent).not.toContain("threads:");
    expect(afterContent).not.toContain("checks:");

    // Only one review should remain
    const reloaded = await loadReviewRecords(ctx);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]._ulid).toBe(ulid2);
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — saveInboxItem path", () => {
  function makeInboxCtx(specDir: string): KspecContext {
    return { specDir } as KspecContext;
  }

  it("saveInboxItem with no changes produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-inbox-rt1");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeInboxCtx(kspecDir);

    // Write a minimal inbox file directly — only required fields, no tags
    const inboxPath = path.join(kspecDir, "project.inbox.yaml");
    const itemUlid = testUlid("INBX");
    await writeYamlFilePreserveFormat(inboxPath, {
      inbox: [
        {
          _ulid: itemUlid,
          text: "An idea without tags",
          created_at: "2026-01-01T00:00:00.000Z",
          added_by: "@user",
        },
      ],
    });
    const initialContent = await fs.readFile(inboxPath, "utf-8");

    // Load and save back with no modifications
    const loaded = await loadInboxItems(ctx);
    expect(loaded).toHaveLength(1);
    await saveInboxItem(ctx, loaded[0]);
    const afterContent = await fs.readFile(inboxPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("mutateInboxItemAtomically with identity function produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-inbox-rt2");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeInboxCtx(kspecDir);

    const inboxPath = path.join(kspecDir, "project.inbox.yaml");
    const itemUlid = testUlid("INBM");
    await writeYamlFilePreserveFormat(inboxPath, {
      inbox: [
        {
          _ulid: itemUlid,
          text: "Idea for identity mutation test",
          created_at: "2026-01-15T10:00:00.000Z",
          added_by: "@agent",
        },
      ],
    });
    const initialContent = await fs.readFile(inboxPath, "utf-8");

    // Identity mutation: return the item unchanged
    const loaded = await loadInboxItems(ctx);
    await mutateInboxItemAtomically(ctx, loaded[0], (i) => i);
    const afterContent = await fs.readFile(inboxPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("saveInboxItem preserves file stability across multiple items", async () => {
    const kspecDir = path.join(tempDir, ".kspec-inbox-rt3");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeInboxCtx(kspecDir);

    const inboxPath = path.join(kspecDir, "project.inbox.yaml");
    const [ulid1, ulid2, ulid3] = testUlids("INBS", 3);
    await writeYamlFilePreserveFormat(inboxPath, {
      inbox: [
        {
          _ulid: ulid1,
          text: "First inbox item",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          text: "Second inbox item with tags",
          created_at: "2026-01-02T00:00:00.000Z",
          tags: ["mvp", "cli"],
        },
        {
          _ulid: ulid3,
          text: "Third inbox item",
          created_at: "2026-01-03T00:00:00.000Z",
          added_by: "@alice",
        },
      ],
    });
    const initialContent = await fs.readFile(inboxPath, "utf-8");

    // Load and save each item individually — file should not change
    const loaded = await loadInboxItems(ctx);
    for (const item of loaded) {
      await saveInboxItem(ctx, item);
    }
    const afterContent = await fs.readFile(inboxPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("non-target inbox items are not polluted with Zod defaults", async () => {
    const kspecDir = path.join(tempDir, ".kspec-inbox-rt4");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeInboxCtx(kspecDir);

    // Write a minimal inbox file — items without tags field
    const inboxPath = path.join(kspecDir, "project.inbox.yaml");
    const [ulid1, ulid2] = testUlids("INBP", 2);
    await writeYamlFilePreserveFormat(inboxPath, {
      inbox: [
        {
          _ulid: ulid1,
          text: "Minimal item 1",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          text: "Minimal item 2",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    const initialContent = await fs.readFile(inboxPath, "utf-8");

    // Mutate only the first item (add tags)
    const loaded = await loadInboxItems(ctx);
    await mutateInboxItemAtomically(ctx, loaded[0], (i) => ({
      ...i,
      tags: ["important"],
    }));
    const afterContent = await fs.readFile(inboxPath, "utf-8");

    // The second item should not gain a tags field
    // Count occurrences of "tags:" — should be exactly 1 (from the mutated item)
    const tagsMatches = afterContent.match(/tags:/g) || [];
    expect(tagsMatches).toHaveLength(1);

    // But the mutation should have taken effect
    const reloaded = await loadInboxItems(ctx);
    expect(reloaded[0].tags).toEqual(["important"]);
    expect(reloaded[1].tags).toEqual([]); // Zod default when loaded, but not persisted
  });

  it("deleteInboxItem preserves non-target items as raw data", async () => {
    const kspecDir = path.join(tempDir, ".kspec-inbox-rt5");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeInboxCtx(kspecDir);

    // Write a minimal inbox file directly
    const inboxPath = path.join(kspecDir, "project.inbox.yaml");
    const [ulid1, ulid2] = testUlids("INBD", 2);
    await writeYamlFilePreserveFormat(inboxPath, {
      inbox: [
        {
          _ulid: ulid1,
          text: "Item to delete",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          text: "Item to keep",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    await deleteInboxItem(ctx, ulid1);
    const afterContent = await fs.readFile(inboxPath, "utf-8");

    // Remaining item should not gain Zod default fields (tags: [])
    expect(afterContent).not.toContain("tags:");

    // Only one item should remain
    const reloaded = await loadInboxItems(ctx);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]._ulid).toBe(ulid2);
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — saveDispatchWorkspaceRecord path", () => {
  function makeWorkspaceCtx(specDir: string): KspecContext {
    return { specDir } as KspecContext;
  }

  /**
   * Build a minimal dispatch workspace record that satisfies the schema.
   * Only includes fields that are required — no Zod defaults.
   */
  function makeMinimalWorkspaceYaml(workspaceId: string, taskRef: string, overrides: Record<string, unknown> = {}) {
    const now = "2026-03-01T00:00:00.000Z";
    return {
      workspace_id: workspaceId,
      task_ref: taskRef,
      task_slug: `task-${workspaceId}`,
      worktree_root: `/tmp/ws/${workspaceId}`,
      resolved_base_branch: "dev",
      base_branch_point: "abc123",
      canonical_branch: `dispatch/task/test/${workspaceId}`,
      canonical_branch_head: "def456",
      lifecycle_state: "active",
      worktrees: {
        worker: {
          path: `/tmp/ws/${workspaceId}`,
          branch_mode: "branch",
        },
      },
      bootstrap: {
        status: "succeeded",
      },
      integration: {
        status: "pending",
        target_branch: "dev",
        target_commit: "abc123",
        publication_mode: "manual_merge",
        outcome: "manual_merge",
        updated_at: now,
      },
      health: {
        status: "healthy",
        summary: "OK",
        updated_at: now,
      },
      cleanup: {
        status: "not_scheduled",
        updated_at: now,
      },
      timestamps: {
        created_at: now,
        updated_at: now,
      },
      ...overrides,
    };
  }

  it("saveDispatchWorkspaceRecord with no changes produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-dw-rt1");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeWorkspaceCtx(kspecDir);

    // Write a dispatch workspaces file directly with minimal fields
    const registryPath = path.join(kspecDir, "project.dispatch-workspaces.yaml");
    const ws1 = makeMinimalWorkspaceYaml("ws-001", "@task-foo");
    await writeYamlFilePreserveFormat(registryPath, {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [ws1],
    });
    const initialContent = await fs.readFile(registryPath, "utf-8");

    // Load and save back with no modifications
    const loaded = await loadDispatchWorkspaceRegistry(ctx);
    expect(loaded).toHaveLength(1);
    await saveDispatchWorkspaceRecord(ctx, loaded[0]);
    const afterContent = await fs.readFile(registryPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("mutateDispatchWorkspaceRecordAtomically with identity function produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-dw-rt2");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeWorkspaceCtx(kspecDir);

    const registryPath = path.join(kspecDir, "project.dispatch-workspaces.yaml");
    const ws1 = makeMinimalWorkspaceYaml("ws-002", "@task-bar");
    await writeYamlFilePreserveFormat(registryPath, {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [ws1],
    });
    const initialContent = await fs.readFile(registryPath, "utf-8");

    // Identity mutation: return the record unchanged
    await mutateDispatchWorkspaceRecordAtomically(ctx, "ws-002", (r) => r);
    const afterContent = await fs.readFile(registryPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("saveDispatchWorkspaceRecord preserves file stability across multiple workspaces", async () => {
    const kspecDir = path.join(tempDir, ".kspec-dw-rt3");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeWorkspaceCtx(kspecDir);

    const registryPath = path.join(kspecDir, "project.dispatch-workspaces.yaml");
    const ws1 = makeMinimalWorkspaceYaml("ws-003", "@task-a");
    const ws2 = makeMinimalWorkspaceYaml("ws-004", "@task-b");
    await writeYamlFilePreserveFormat(registryPath, {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [ws1, ws2],
    });
    const initialContent = await fs.readFile(registryPath, "utf-8");

    // Load and save each workspace individually — file should not change
    const loaded = await loadDispatchWorkspaceRegistry(ctx);
    for (const ws of loaded) {
      await saveDispatchWorkspaceRecord(ctx, ws);
    }
    const afterContent = await fs.readFile(registryPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("non-target workspaces are not polluted with Zod defaults", async () => {
    const kspecDir = path.join(tempDir, ".kspec-dw-rt4");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeWorkspaceCtx(kspecDir);

    // Write a dispatch workspaces file with minimal fields — no branch_provenance,
    // no roleStates, no bootstrap.invalidationReasons, no bootstrap.steps, etc.
    const registryPath = path.join(kspecDir, "project.dispatch-workspaces.yaml");
    const ws1 = makeMinimalWorkspaceYaml("ws-005", "@task-c");
    const ws2 = makeMinimalWorkspaceYaml("ws-006", "@task-d");
    await writeYamlFilePreserveFormat(registryPath, {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [ws1, ws2],
    });
    const initialContent = await fs.readFile(registryPath, "utf-8");

    // Mutate only the first workspace (change lifecycle_state)
    await mutateDispatchWorkspaceRecordAtomically(ctx, "ws-005", (r) => ({
      ...r,
      lifecycle_state: "stale",
    }));
    const afterContent = await fs.readFile(registryPath, "utf-8");

    // The second workspace should not gain any new fields from Zod defaults.
    // branch_provenance is the key default that gets added by schema parsing.
    // Count occurrences — only the mutated workspace should potentially have it.
    const branchProvenanceMatches = afterContent.match(/branch_provenance:/g) || [];
    // Neither workspace had branch_provenance originally; the mutated workspace
    // may gain it through schema normalization + merge, but the non-target must not.
    // Since the merge only adds non-trivial fields and branch_provenance is an object,
    // the mutated workspace will get it — so at most 1 occurrence is acceptable.
    expect(branchProvenanceMatches.length).toBeLessThanOrEqual(1);

    // roleStates should not appear for non-target workspace
    const roleStatesMatches = afterContent.match(/roleStates:/g) || [];
    expect(roleStatesMatches.length).toBeLessThanOrEqual(1);

    // But the mutation should have taken effect
    const reloaded = await loadDispatchWorkspaceRegistry(ctx);
    const ws5 = reloaded.find((w) => w.workspace_id === "ws-005");
    const ws6 = reloaded.find((w) => w.workspace_id === "ws-006");
    expect(ws5?.lifecycle_state).toBe("stale");
    expect(ws6?.lifecycle_state).toBe("active");
  });

  it("write-then-read-then-write produces byte-identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-dw-rt5");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeWorkspaceCtx(kspecDir);

    // Write a dispatch workspaces file, load one workspace, save it back
    // without changes, and confirm the file is byte-identical.
    const registryPath = path.join(kspecDir, "project.dispatch-workspaces.yaml");
    const ws1 = makeMinimalWorkspaceYaml("ws-007", "@task-e");
    const ws2 = makeMinimalWorkspaceYaml("ws-008", "@task-f");
    await writeYamlFilePreserveFormat(registryPath, {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [ws1, ws2],
    });
    const initialContent = await fs.readFile(registryPath, "utf-8");

    // Multiple round-trip cycles — save each workspace in turn
    for (let cycle = 0; cycle < 3; cycle++) {
      const loaded = await loadDispatchWorkspaceRegistry(ctx);
      for (const ws of loaded) {
        await saveDispatchWorkspaceRecord(ctx, ws);
      }
    }
    const finalContent = await fs.readFile(registryPath, "utf-8");

    expect(finalContent).toBe(initialContent);
  });
});

describe("toYaml — shared object reference safety", () => {
  it("does not crash on shared JS object references that produce YAML anchors/aliases", () => {
    // Regression: YAML.stringify with sortMapEntries can reorder keys such that
    // an alias (*a1) appears before its anchor (&a1), causing
    // "Unresolved alias (the anchor must be set before the alias): a1"
    const shared = { status: "not_run" };
    const data = {
      roleStates: { worker: shared, reviewer: shared },
    };
    // Should not throw
    const yaml = toYaml(data);
    // Both values should be serialized independently (no alias)
    expect(yaml).not.toContain("*a1");
    expect(yaml).not.toContain("&a1");
    // Values should still be correct
    const parsed = parseYaml<typeof data>(yaml);
    expect(parsed.roleStates.worker).toEqual({ status: "not_run" });
    expect(parsed.roleStates.reviewer).toEqual({ status: "not_run" });
  });
});
