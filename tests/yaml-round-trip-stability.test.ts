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
  loadTriageRecords,
  saveTriageRecord,
} from "../src/parser/yaml.js";
import type { LoadedTask, LoadedInboxItem, LoadedTriageRecord } from "../src/parser/yaml.js";
import {
  loadPlans,
  savePlan,
  mutatePlanAtomically,
  deletePlan,
} from "../src/parser/plans.js";
import {
  createReviewRecord,
  loadReviewRecords,
  saveReviewRecord,
  mutateReviewAtomically,
  deleteReviewRecord,
} from "../src/parser/reviews.js";
import {
  createObservation,
  saveObservation,
  deleteObservation,
  saveMetaItem,
  deleteMetaItem,
  getMetaManifestPath,
  loadMetaContext,
  loadWorkflowRuns,
  saveWorkflowRun,
  mutateWorkflowRunAtomically,
  deleteWorkflowRuns,
} from "../src/parser/meta.js";
import type { LoadedObservation, LoadedAgent, LoadedConvention } from "../src/parser/meta.js";
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
describe("round-trip stability — savePlan path", () => {
  /**
   * Helper: set up a minimal kspec context with a plans file.
   */
  async function setupPlanContext(plans: Record<string, unknown>[]) {
    // Write manifest
    const manifestPath = path.join(tempDir, "kynetic.yaml");
    await writeYamlFile(manifestPath, {
      name: "test-project",
      modules: [],
    });

    // Write plans file with canonical wrapper format
    const plansFilePath = path.join(tempDir, "project.plans.yaml");
    await writeYamlFile(plansFilePath, { kynetic_plans: "1.0", plans });

    // Get the content after initial canonical write
    const initialContent = await fs.readFile(plansFilePath, "utf-8");

    // Init context pointing at tempDir as specDir
    const ctx = await initContext(tempDir);

    return { ctx, plansFilePath, initialContent };
  }

  it("savePlan with no changes produces identical file", async () => {
    const planData = {
      _ulid: testUlid("PLAN", 1),
      slugs: ["no-change-plan"],
      title: "No change plan",
      content: "Plan content that should not change.",
      status: "draft",
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const { ctx, plansFilePath, initialContent } =
      await setupPlanContext([planData]);

    // Load plans and save the first one back with no modifications
    const loadedPlans = await loadPlans(ctx);
    expect(loadedPlans.length).toBe(1);

    await savePlan(ctx, loadedPlans[0]);
    const afterContent = await fs.readFile(plansFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("savePlan with no changes does not add Zod default fields", async () => {
    // Minimal plan — no slugs, no derived_tasks, no derived_specs, no notes
    const planData = {
      _ulid: testUlid("PLAN", 2),
      title: "Minimal plan",
      content: "Just the essentials.",
      status: "draft",
      created_at: "2026-01-01T00:00:00.000Z",
    };

    const { ctx, plansFilePath, initialContent } =
      await setupPlanContext([planData]);

    const loadedPlans = await loadPlans(ctx);
    await savePlan(ctx, loadedPlans[0]);
    const afterContent = await fs.readFile(plansFilePath, "utf-8");

    // File should be identical — no slugs: [], derived_tasks: [], etc. added
    expect(afterContent).toBe(initialContent);
  });

  it("mutatePlanAtomically with identity function produces identical file", async () => {
    const planData = {
      _ulid: testUlid("PLAN", 3),
      slugs: ["identity-mutate-plan"],
      title: "Identity mutation plan",
      content: "A plan for testing identity mutation stability.",
      status: "approved",
      derived_tasks: ["@task-one"],
      created_at: "2026-01-01T00:00:00.000Z",
      approved_at: "2026-01-10T00:00:00.000Z",
      notes: [
        {
          _ulid: testUlid("N0TE", 40),
          created_at: "2026-01-05T00:00:00.000Z",
          author: "@agent",
          content: "Plan looks good.",
        },
      ],
    };

    const { ctx, plansFilePath, initialContent } =
      await setupPlanContext([planData]);

    const loadedPlans = await loadPlans(ctx);
    // Identity mutation: return the plan unchanged
    await mutatePlanAtomically(ctx, loadedPlans[0], (p) => p);
    const afterContent = await fs.readFile(plansFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("savePlan preserves file stability across multiple plans", async () => {
    const plans = [
      {
        _ulid: testUlid("PLAN", 4),
        slugs: ["multi-plan-1"],
        title: "First of many plans",
        content: "First plan content.",
        status: "draft",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        _ulid: testUlid("PLAN", 5),
        slugs: ["multi-plan-2"],
        title: "Second of many plans",
        content: "Second plan content.",
        status: "approved",
        derived_tasks: ["@task-x"],
        created_at: "2026-01-02T00:00:00.000Z",
        approved_at: "2026-01-05T00:00:00.000Z",
        notes: [
          {
            _ulid: testUlid("N0TE", 41),
            created_at: "2026-01-03T00:00:00.000Z",
            author: "@agent",
            content: "Approved for implementation.",
          },
        ],
      },
    ];

    const { ctx, plansFilePath, initialContent } =
      await setupPlanContext(plans);

    // Load and save each plan individually — file should not change
    const loadedPlans = await loadPlans(ctx);
    for (const plan of loadedPlans) {
      await savePlan(ctx, plan);
    }
    const afterContent = await fs.readFile(plansFilePath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("deletePlan preserves non-target plans as raw data", async () => {
    const plans = [
      {
        _ulid: testUlid("PLAN", 6),
        slugs: ["keep-plan"],
        title: "Plan to keep",
        content: "This plan stays.",
        status: "draft",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        _ulid: testUlid("PLAN", 7),
        slugs: ["delete-plan"],
        title: "Plan to delete",
        content: "This plan gets removed.",
        status: "rejected",
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ];

    const { ctx, plansFilePath } = await setupPlanContext(plans);

    // Snapshot the first plan's raw YAML before deletion
    const beforeContent = await fs.readFile(plansFilePath, "utf-8");

    // Delete the second plan
    const deleted = await deletePlan(ctx, testUlid("PLAN", 7));
    expect(deleted).toBe(true);

    const afterContent = await fs.readFile(plansFilePath, "utf-8");

    // The remaining plan should be byte-identical in the output
    // (no Zod defaults added to the surviving plan)
    // Write a single-plan file for comparison
    const singlePlanFile = path.join(tempDir, "single-plan.yaml");
    await writeYamlFile(singlePlanFile, { kynetic_plans: "1.0", plans: [plans[0]] });
    const expectedContent = await fs.readFile(singlePlanFile, "utf-8");

    expect(afterContent).toBe(expectedContent);
  });

  it("multiple read-write cycles maintain stability", async () => {
    const planData = {
      _ulid: testUlid("PLAN", 8),
      slugs: ["cycle-plan"],
      title: "Plan for cycle testing",
      content: "Multi-line content.\n\nWith paragraphs.\n\nAnd more.",
      status: "active",
      derived_tasks: ["@task-a", "@task-b"],
      derived_specs: ["@spec-c"],
      created_at: "2026-01-01T00:00:00.000Z",
      approved_at: "2026-01-05T00:00:00.000Z",
      notes: [
        {
          _ulid: testUlid("N0TE", 42),
          created_at: "2026-01-02T00:00:00.000Z",
          author: "@agent",
          content: "Initial work note.",
        },
      ],
    };

    const { ctx, plansFilePath, initialContent } =
      await setupPlanContext([planData]);

    // Multiple cycles — load and save each time
    for (let i = 0; i < 5; i++) {
      const loadedPlans = await loadPlans(ctx);
      await savePlan(ctx, loadedPlans[0]);
    }
    const afterContent = await fs.readFile(plansFilePath, "utf-8");

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
describe("round-trip stability — saveObservation path", () => {
  function makeMetaCtx(specDir: string): KspecContext {
    return { specDir } as KspecContext;
  }

  it("saveObservation with no changes produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-meta-rt1");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeMetaCtx(kspecDir);

    const obsUlid = testUlid("0BS1");
    const obs = createObservation("friction", "Test observation content", {
      author: "test-author",
    });
    (obs as Record<string, unknown>)._ulid = obsUlid;

    // Save observation initially
    await saveObservation(ctx, { ...obs });
    const manifestPath = getMetaManifestPath(ctx);
    const initialContent = await fs.readFile(manifestPath, "utf-8");

    // Load and save back with no modifications
    const meta = await loadMetaContext(ctx);
    expect(meta.observations).toHaveLength(1);
    await saveObservation(ctx, meta.observations[0]);
    const afterContent = await fs.readFile(manifestPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("saveObservation does not add absent sections to file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-meta-rt2");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeMetaCtx(kspecDir);

    // Write a minimal meta manifest with only observations
    const manifestPath = getMetaManifestPath(ctx);
    const obsUlid = testUlid("0BS2");
    await writeYamlFilePreserveFormat(manifestPath, {
      kynetic_meta: "1.0",
      observations: [
        {
          _ulid: obsUlid,
          type: "friction",
          content: "Initial observation",
          created_at: "2026-01-01T00:00:00.000Z",
          author: "test",
          resolved: false,
        },
      ],
    });
    const initialContent = await fs.readFile(manifestPath, "utf-8");

    // Mutate the observation (resolve it)
    const meta = await loadMetaContext(ctx);
    const obs = meta.observations[0];
    obs.resolved = true;
    obs.resolution = "Addressed in task";
    await saveObservation(ctx, obs);
    const afterContent = await fs.readFile(manifestPath, "utf-8");

    // agents/workflows/conventions/skills/includes should NOT appear
    expect(afterContent).not.toContain("agents:");
    expect(afterContent).not.toContain("workflows:");
    expect(afterContent).not.toContain("conventions:");
    expect(afterContent).not.toContain("skills:");
    expect(afterContent).not.toContain("includes:");

    // But the mutation should have taken effect
    const reloaded = await loadMetaContext(ctx);
    expect(reloaded.observations[0].resolved).toBe(true);
    expect(reloaded.observations[0].resolution).toBe("Addressed in task");
  });

  it("deleteObservation preserves non-target sections as raw data", async () => {
    const kspecDir = path.join(tempDir, ".kspec-meta-rt3");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeMetaCtx(kspecDir);

    // Write a manifest with only observations (no agents/workflows/etc.)
    const manifestPath = getMetaManifestPath(ctx);
    const [ulid1, ulid2] = testUlids("0BS3", 2);
    await writeYamlFilePreserveFormat(manifestPath, {
      kynetic_meta: "1.0",
      observations: [
        {
          _ulid: ulid1,
          type: "friction",
          content: "Observation to delete",
          created_at: "2026-01-01T00:00:00.000Z",
          author: "test",
          resolved: false,
        },
        {
          _ulid: ulid2,
          type: "success",
          content: "Observation to keep",
          created_at: "2026-01-02T00:00:00.000Z",
          author: "test",
          resolved: false,
        },
      ],
    });

    await deleteObservation(ctx, ulid1);
    const afterContent = await fs.readFile(manifestPath, "utf-8");

    // Remaining content should not gain Zod default sections
    expect(afterContent).not.toContain("agents:");
    expect(afterContent).not.toContain("workflows:");
    expect(afterContent).not.toContain("conventions:");
    expect(afterContent).not.toContain("skills:");
    expect(afterContent).not.toContain("includes:");

    // Only one observation should remain
    const reloaded = await loadMetaContext(ctx);
    expect(reloaded.observations).toHaveLength(1);
    expect(reloaded.observations[0]._ulid).toBe(ulid2);
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — saveMetaItem path", () => {
  function makeMetaCtx(specDir: string): KspecContext {
    return { specDir } as KspecContext;
  }

  it("saveMetaItem for agent does not add absent sections to file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-meta-rt4");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeMetaCtx(kspecDir);

    // Write a minimal meta manifest with only agents
    const manifestPath = getMetaManifestPath(ctx);
    const agentUlid = testUlid("AG01");
    await writeYamlFilePreserveFormat(manifestPath, {
      kynetic_meta: "1.0",
      agents: [
        {
          _ulid: agentUlid,
          id: "test-worker",
          name: "Test Worker",
        },
      ],
    });

    // Save a new convention — only conventions array should be added
    const convUlid = testUlid("C0N1");
    const convention: LoadedConvention = {
      _ulid: convUlid,
      domain: "testing",
      rules: ["Rule 1"],
      examples: [],
    };
    await saveMetaItem(ctx, convention, "convention");
    const afterContent = await fs.readFile(manifestPath, "utf-8");

    // observations/workflows/skills/includes should NOT appear
    expect(afterContent).not.toContain("observations:");
    expect(afterContent).not.toContain("workflows:");
    expect(afterContent).not.toContain("skills:");
    expect(afterContent).not.toContain("includes:");

    // agents and conventions should be present
    expect(afterContent).toContain("agents:");
    expect(afterContent).toContain("conventions:");

    // Verify data integrity
    const reloaded = await loadMetaContext(ctx);
    expect(reloaded.agents).toHaveLength(1);
    expect(reloaded.conventions).toHaveLength(1);
    expect(reloaded.conventions[0].domain).toBe("testing");
  });

  it("saveMetaItem update does not pollute existing items with Zod defaults", async () => {
    const kspecDir = path.join(tempDir, ".kspec-meta-rt5");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeMetaCtx(kspecDir);

    // Write a minimal agent — only required fields
    const manifestPath = getMetaManifestPath(ctx);
    const agentUlid = testUlid("AG02");
    await writeYamlFilePreserveFormat(manifestPath, {
      kynetic_meta: "1.0",
      agents: [
        {
          _ulid: agentUlid,
          id: "minimal-agent",
          name: "Minimal Agent",
        },
      ],
    });

    // Load and save back — should not add capabilities, tools, conventions, etc.
    const meta = await loadMetaContext(ctx);
    const agent = meta.agents[0];
    // Modify the agent's name to trigger a save with actual changes
    agent.name = "Updated Minimal Agent";
    await saveMetaItem(ctx, agent, "agent");
    const afterContent = await fs.readFile(manifestPath, "utf-8");

    // Should not have gained Zod default fields (empty arrays, false)
    expect(afterContent).not.toContain("capabilities:");
    expect(afterContent).not.toContain("tools:");
    expect(afterContent).not.toContain("dispatch:");
    expect(afterContent).not.toContain("auto_approve:");

    // Other sections should not appear
    expect(afterContent).not.toContain("observations:");
    expect(afterContent).not.toContain("workflows:");
    expect(afterContent).not.toContain("conventions:");

    // But the mutation should have taken effect
    expect(afterContent).toContain("Updated Minimal Agent");
  });

  it("deleteMetaItem preserves non-target items as raw data", async () => {
    const kspecDir = path.join(tempDir, ".kspec-meta-rt6");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeMetaCtx(kspecDir);

    // Write manifest with agents and conventions — no other sections
    const manifestPath = getMetaManifestPath(ctx);
    const [agentUlid1, agentUlid2] = testUlids("AG03", 2);
    const convUlid = testUlid("C0N2");
    await writeYamlFilePreserveFormat(manifestPath, {
      kynetic_meta: "1.0",
      agents: [
        {
          _ulid: agentUlid1,
          id: "agent-to-delete",
          name: "Agent to Delete",
        },
        {
          _ulid: agentUlid2,
          id: "agent-to-keep",
          name: "Agent to Keep",
        },
      ],
      conventions: [
        {
          _ulid: convUlid,
          domain: "testing",
          rules: ["Rule 1"],
        },
      ],
    });

    await deleteMetaItem(ctx, agentUlid1, "agent");
    const afterContent = await fs.readFile(manifestPath, "utf-8");

    // Should not gain absent sections
    expect(afterContent).not.toContain("observations:");
    expect(afterContent).not.toContain("workflows:");
    expect(afterContent).not.toContain("skills:");
    expect(afterContent).not.toContain("includes:");

    // Remaining agent should not gain Zod defaults
    expect(afterContent).not.toContain("capabilities:");
    expect(afterContent).not.toContain("tools:");
    expect(afterContent).not.toContain("dispatch:");

    // Convention should still be present
    expect(afterContent).toContain("conventions:");

    // Verify data integrity
    const reloaded = await loadMetaContext(ctx);
    expect(reloaded.agents).toHaveLength(1);
    expect(reloaded.agents[0].id).toBe("agent-to-keep");
    expect(reloaded.conventions).toHaveLength(1);
  });

  it("multiple mutations across sections preserve file stability", async () => {
    const kspecDir = path.join(tempDir, ".kspec-meta-rt7");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeMetaCtx(kspecDir);

    // Write manifest with only observations
    const manifestPath = getMetaManifestPath(ctx);
    const obsUlid = testUlid("0BS7");
    await writeYamlFilePreserveFormat(manifestPath, {
      kynetic_meta: "1.0",
      observations: [
        {
          _ulid: obsUlid,
          type: "idea",
          content: "An idea to test",
          created_at: "2026-01-01T00:00:00.000Z",
          author: "test",
          resolved: false,
        },
      ],
    });

    // Add a minimal agent (only required fields, no Zod defaults)
    const agentUlid = testUlid("AG07");
    const agent = {
      _ulid: agentUlid,
      id: "new-agent",
      name: "New Agent",
    } as unknown as LoadedAgent;
    await saveMetaItem(ctx, agent, "agent");
    const afterContent = await fs.readFile(manifestPath, "utf-8");

    // Should have observations and agents, but NOT workflows/conventions/skills/includes
    expect(afterContent).toContain("observations:");
    expect(afterContent).toContain("agents:");
    expect(afterContent).not.toContain("workflows:");
    expect(afterContent).not.toContain("conventions:");
    expect(afterContent).not.toContain("skills:");
    expect(afterContent).not.toContain("includes:");

    // Verify data integrity
    const reloaded = await loadMetaContext(ctx);
    expect(reloaded.observations).toHaveLength(1);
    expect(reloaded.agents).toHaveLength(1);
    expect(reloaded.agents[0].id).toBe("new-agent");
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
describe("round-trip stability — saveTriageRecord path", () => {
  function makeTriageCtx(specDir: string): KspecContext {
    return { specDir } as KspecContext;
  }

  it("saveTriageRecord on a record with updated_at preserves non-default fields only", async () => {
    const kspecDir = path.join(tempDir, ".kspec-triage-rt1");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeTriageCtx(kspecDir);

    // Write a triage file with a record that already has updated_at
    const triagePath = path.join(kspecDir, "project.triage.yaml");
    const recordUlid = testUlid("TRIA");
    const inboxRef = testUlid("INBR");
    await writeYamlFilePreserveFormat(triagePath, {
      kynetic_triage: "1.0",
      triage: [
        {
          _ulid: recordUlid,
          inbox_ref: inboxRef,
          item_snapshot: "Test inbox item",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Load and save back — saveTriageRecord always sets updated_at,
    // but evidence_refs: [] (Zod default) should NOT appear in the output
    const loaded = await loadTriageRecords(ctx);
    expect(loaded).toHaveLength(1);
    await saveTriageRecord(ctx, loaded[0]);
    const afterContent = await fs.readFile(triagePath, "utf-8");

    // evidence_refs should not appear (it's a Zod default of [])
    expect(afterContent).not.toContain("evidence_refs");

    // The record should still load correctly
    const reloaded = await loadTriageRecords(ctx);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]._ulid).toBe(recordUlid);
  });

  it("saveTriageRecord does not pollute non-target records with Zod defaults", async () => {
    const kspecDir = path.join(tempDir, ".kspec-triage-rt2");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeTriageCtx(kspecDir);

    const triagePath = path.join(kspecDir, "project.triage.yaml");
    const [ulid1, ulid2] = testUlids("TRGP", 2);
    const [inboxRef1, inboxRef2] = testUlids("TIRP", 2);
    await writeYamlFilePreserveFormat(triagePath, {
      kynetic_triage: "1.0",
      triage: [
        {
          _ulid: ulid1,
          inbox_ref: inboxRef1,
          item_snapshot: "First triage item",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          inbox_ref: inboxRef2,
          item_snapshot: "Second triage item",
          status: "pending",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    // Mutate only the first record (add action + reasoning to simulate triage)
    const loaded = await loadTriageRecords(ctx);
    const mutated: LoadedTriageRecord = {
      ...loaded[0],
      status: "triaged",
      action: "promote",
      reasoning: "Promoting to spec",
      decided_by: "@agent",
    };
    await saveTriageRecord(ctx, mutated);
    const afterContent = await fs.readFile(triagePath, "utf-8");

    // The second record should NOT gain evidence_refs: [] from Zod default
    const evidenceMatches = afterContent.match(/evidence_refs:/g) || [];
    expect(evidenceMatches).toHaveLength(0);

    // But the mutation should have taken effect
    const reloaded = await loadTriageRecords(ctx);
    expect(reloaded[0].status).toBe("triaged");
    expect(reloaded[0].action).toBe("promote");
    expect(reloaded[1].status).toBe("pending");
  });

  it("saveTriageRecord preserves file stability across multiple records", async () => {
    const kspecDir = path.join(tempDir, ".kspec-triage-rt3");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeTriageCtx(kspecDir);

    const triagePath = path.join(kspecDir, "project.triage.yaml");
    const [ulid1, ulid2, ulid3] = testUlids("TRGS", 3);
    const [iref1, iref2, iref3] = testUlids("TIRS", 3);
    await writeYamlFilePreserveFormat(triagePath, {
      kynetic_triage: "1.0",
      triage: [
        {
          _ulid: ulid1,
          inbox_ref: iref1,
          item_snapshot: "First item",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          inbox_ref: iref2,
          item_snapshot: "Second item with action",
          status: "triaged",
          action: "defer",
          reasoning: "Later",
          decided_by: "@user",
          created_at: "2026-01-02T00:00:00.000Z",
        },
        {
          _ulid: ulid3,
          inbox_ref: iref3,
          item_snapshot: "Third item",
          status: "pending",
          created_at: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    const initialContent = await fs.readFile(triagePath, "utf-8");

    // Load all records — verify none gain Zod defaults just from loading+saving
    const loaded = await loadTriageRecords(ctx);
    expect(loaded).toHaveLength(3);

    // Save each record back — the target record gets updated_at set by saveTriageRecord,
    // but non-target records should be untouched
    // To verify non-target stability, save only the second (already-triaged) record
    await saveTriageRecord(ctx, loaded[1]);
    const afterContent = await fs.readFile(triagePath, "utf-8");

    // Non-target records (1st and 3rd) should not gain evidence_refs from Zod defaults
    // Count evidence_refs occurrences — should be 0 (none of the records had it originally)
    const evidenceMatches = afterContent.match(/evidence_refs:/g) || [];
    expect(evidenceMatches).toHaveLength(0);

    // Verify all records still load correctly
    const reloaded = await loadTriageRecords(ctx);
    expect(reloaded).toHaveLength(3);
    expect(reloaded[0]._ulid).toBe(ulid1);
    expect(reloaded[1]._ulid).toBe(ulid2);
    expect(reloaded[2]._ulid).toBe(ulid3);
  });

  it("multiple save cycles maintain stability for non-target records", async () => {
    const kspecDir = path.join(tempDir, ".kspec-triage-rt4");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeTriageCtx(kspecDir);

    const triagePath = path.join(kspecDir, "project.triage.yaml");
    const [ulid1, ulid2] = testUlids("TRGM", 2);
    const [iref1, iref2] = testUlids("TIRM", 2);
    await writeYamlFilePreserveFormat(triagePath, {
      kynetic_triage: "1.0",
      triage: [
        {
          _ulid: ulid1,
          inbox_ref: iref1,
          item_snapshot: "Stable item",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          inbox_ref: iref2,
          item_snapshot: "Mutated item",
          status: "pending",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    // Capture what the first (non-target) record looks like in YAML
    const initialContent = await fs.readFile(triagePath, "utf-8");
    const initialFirstRecordYaml = initialContent.split("- _ulid: " + ulid2)[0];

    // Save the second record multiple times through different mutations
    const loaded = await loadTriageRecords(ctx);
    const mutated1: LoadedTriageRecord = {
      ...loaded[1],
      status: "triaged",
      action: "promote",
      reasoning: "First pass",
      decided_by: "@agent",
    };
    await saveTriageRecord(ctx, mutated1);

    // Save again with more changes
    const reloaded = await loadTriageRecords(ctx);
    const mutated2: LoadedTriageRecord = {
      ...reloaded[1],
      reasoning: "Updated reasoning",
    };
    await saveTriageRecord(ctx, mutated2);

    // Third save cycle
    const reloaded2 = await loadTriageRecords(ctx);
    const mutated3: LoadedTriageRecord = {
      ...reloaded2[1],
      status: "acted_on",
      acted_at: "2026-01-15T00:00:00.000Z",
    };
    await saveTriageRecord(ctx, mutated3);

    const finalContent = await fs.readFile(triagePath, "utf-8");

    // The first record should not have gained evidence_refs or other Zod defaults
    // after 3 save cycles targeting the second record
    const evidenceInFirstRecord = finalContent.split("- _ulid: " + ulid2)[0];
    expect(evidenceInFirstRecord).not.toContain("evidence_refs");

    // Verify data integrity
    const final = await loadTriageRecords(ctx);
    expect(final).toHaveLength(2);
    expect(final[0].status).toBe("pending");
    expect(final[1].status).toBe("acted_on");
    expect(final[1].reasoning).toBe("Updated reasoning");
  });

  it("new triage record does not add Zod defaults to existing records", async () => {
    const kspecDir = path.join(tempDir, ".kspec-triage-rt5");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeTriageCtx(kspecDir);

    const triagePath = path.join(kspecDir, "project.triage.yaml");
    const existingUlid = testUlid("TRGE");
    const existingInboxRef = testUlid("TIRE");
    await writeYamlFilePreserveFormat(triagePath, {
      kynetic_triage: "1.0",
      triage: [
        {
          _ulid: existingUlid,
          inbox_ref: existingInboxRef,
          item_snapshot: "Existing minimal record",
          status: "pending",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Add a new record (not updating existing)
    const newUlid = testUlid("TRGN");
    const newInboxRef = testUlid("TIRN");
    const newRecord: LoadedTriageRecord = {
      _ulid: newUlid,
      inbox_ref: newInboxRef,
      item_snapshot: "New triage record",
      status: "triaged",
      action: "promote",
      reasoning: "Important item",
      decided_by: "@agent",
      evidence_refs: [],
      created_at: "2026-01-15T00:00:00.000Z",
    };
    await saveTriageRecord(ctx, newRecord);

    const afterContent = await fs.readFile(triagePath, "utf-8");

    // The existing record should not gain evidence_refs: []
    // Only the new record might have it (since it was explicitly in the input)
    // But since evidence_refs: [] is an empty array and this is a new record (not merged),
    // it will appear in the file. The key is the existing record is untouched.
    const existingRecordYaml = afterContent.split("- _ulid: " + newUlid)[0];
    expect(existingRecordYaml).not.toContain("evidence_refs");

    // Verify both records load correctly
    const reloaded = await loadTriageRecords(ctx);
    expect(reloaded).toHaveLength(2);
    expect(reloaded[0]._ulid).toBe(existingUlid);
    expect(reloaded[1]._ulid).toBe(newUlid);
  });
});

// AC: @yaml-serialization-invariants ac-3
describe("round-trip stability — saveWorkflowRun path", () => {
  function makeRunCtx(specDir: string): KspecContext {
    return { specDir, manifestPath: path.join(specDir, "kynetic.yaml") } as KspecContext;
  }

  it("saveWorkflowRun with no changes produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-run-rt1");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeRunCtx(kspecDir);

    // Write a minimal runs file directly — no step_results field
    const runsPath = path.join(kspecDir, "kynetic.runs.yaml");
    const runUlid = testUlid("WKRN");
    await writeYamlFilePreserveFormat(runsPath, {
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: runUlid,
          workflow_ref: "@session-start",
          status: "completed",
          current_step: 2,
          total_steps: 2,
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:05:00.000Z",
        },
      ],
    });
    const initialContent = await fs.readFile(runsPath, "utf-8");

    // Load and save back with no modifications
    const loaded = await loadWorkflowRuns(ctx);
    expect(loaded).toHaveLength(1);
    await saveWorkflowRun(ctx, loaded[0]);
    const afterContent = await fs.readFile(runsPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("saveWorkflowRun with no changes does not add Zod default fields", async () => {
    const kspecDir = path.join(tempDir, ".kspec-run-rt2");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeRunCtx(kspecDir);

    // Minimal run — no step_results, no initiated_by, no abort_reason, no task_ref, no result
    const runsPath = path.join(kspecDir, "kynetic.runs.yaml");
    const runUlid = testUlid("WKRM");
    await writeYamlFilePreserveFormat(runsPath, {
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: runUlid,
          workflow_ref: "@task-lifecycle",
          status: "active",
          current_step: 0,
          total_steps: 3,
          started_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const initialContent = await fs.readFile(runsPath, "utf-8");

    const loaded = await loadWorkflowRuns(ctx);
    await saveWorkflowRun(ctx, loaded[0]);
    const afterContent = await fs.readFile(runsPath, "utf-8");

    // File should be identical — no step_results: [] added
    expect(afterContent).toBe(initialContent);
    expect(afterContent).not.toContain("step_results:");
  });

  it("mutateWorkflowRunAtomically with identity function produces identical file", async () => {
    const kspecDir = path.join(tempDir, ".kspec-run-rt3");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeRunCtx(kspecDir);

    const runsPath = path.join(kspecDir, "kynetic.runs.yaml");
    const runUlid = testUlid("WKRI");
    await writeYamlFilePreserveFormat(runsPath, {
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: runUlid,
          workflow_ref: "@session-start",
          status: "active",
          current_step: 1,
          total_steps: 3,
          started_at: "2026-01-15T10:00:00.000Z",
          initiated_by: "@agent",
        },
      ],
    });
    const initialContent = await fs.readFile(runsPath, "utf-8");

    // Identity mutation: return the run unchanged
    const loaded = await loadWorkflowRuns(ctx);
    await mutateWorkflowRunAtomically(ctx, loaded[0], (r) => r);
    const afterContent = await fs.readFile(runsPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("saveWorkflowRun preserves file stability across multiple runs", async () => {
    const kspecDir = path.join(tempDir, ".kspec-run-rt4");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeRunCtx(kspecDir);

    const runsPath = path.join(kspecDir, "kynetic.runs.yaml");
    const [ulid1, ulid2, ulid3] = testUlids("WKRS", 3);
    await writeYamlFilePreserveFormat(runsPath, {
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: ulid1,
          workflow_ref: "@session-start",
          status: "completed",
          current_step: 2,
          total_steps: 2,
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:05:00.000Z",
        },
        {
          _ulid: ulid2,
          workflow_ref: "@task-lifecycle",
          status: "active",
          current_step: 1,
          total_steps: 4,
          started_at: "2026-01-02T00:00:00.000Z",
          initiated_by: "@worker",
        },
        {
          _ulid: ulid3,
          workflow_ref: "@codebase-audit",
          status: "aborted",
          current_step: 3,
          total_steps: 5,
          started_at: "2026-01-03T00:00:00.000Z",
          abort_reason: "User cancelled",
        },
      ],
    });
    const initialContent = await fs.readFile(runsPath, "utf-8");

    // Load and save each run individually — file should not change
    const loaded = await loadWorkflowRuns(ctx);
    for (const run of loaded) {
      await saveWorkflowRun(ctx, run);
    }
    const afterContent = await fs.readFile(runsPath, "utf-8");

    expect(afterContent).toBe(initialContent);
  });

  it("non-target runs are not polluted with Zod defaults", async () => {
    const kspecDir = path.join(tempDir, ".kspec-run-rt5");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeRunCtx(kspecDir);

    // Write minimal runs — no step_results field on either
    const runsPath = path.join(kspecDir, "kynetic.runs.yaml");
    const [ulid1, ulid2] = testUlids("WKRP", 2);
    await writeYamlFilePreserveFormat(runsPath, {
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: ulid1,
          workflow_ref: "@session-start",
          status: "active",
          current_step: 0,
          total_steps: 2,
          started_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          workflow_ref: "@task-lifecycle",
          status: "active",
          current_step: 0,
          total_steps: 3,
          started_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    const initialContent = await fs.readFile(runsPath, "utf-8");

    // Mutate only the first run
    const loaded = await loadWorkflowRuns(ctx);
    await mutateWorkflowRunAtomically(ctx, loaded[0], (r) => ({
      ...r,
      current_step: 1,
    }));
    const afterContent = await fs.readFile(runsPath, "utf-8");

    // The second run should not gain step_results: []
    // Count occurrences of "step_results:" — should be 0 (neither run had it originally)
    const stepResultsMatches = afterContent.match(/step_results:/g) || [];
    expect(stepResultsMatches).toHaveLength(0);

    // But the mutation should have taken effect
    const reloaded = await loadWorkflowRuns(ctx);
    expect(reloaded[0].current_step).toBe(1);
    expect(reloaded[1].current_step).toBe(0);
  });

  it("deleteWorkflowRuns preserves non-target runs as raw data", async () => {
    const kspecDir = path.join(tempDir, ".kspec-run-rt6");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeRunCtx(kspecDir);

    // Write minimal runs — no step_results field
    const runsPath = path.join(kspecDir, "kynetic.runs.yaml");
    const [ulid1, ulid2] = testUlids("WKRD", 2);
    await writeYamlFilePreserveFormat(runsPath, {
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: ulid1,
          workflow_ref: "@session-start",
          status: "completed",
          current_step: 2,
          total_steps: 2,
          started_at: "2026-01-01T00:00:00.000Z",
        },
        {
          _ulid: ulid2,
          workflow_ref: "@task-lifecycle",
          status: "active",
          current_step: 1,
          total_steps: 3,
          started_at: "2026-01-02T00:00:00.000Z",
        },
      ],
    });

    await deleteWorkflowRuns(ctx, [ulid1]);
    const afterContent = await fs.readFile(runsPath, "utf-8");

    // Remaining run should not gain Zod default fields (step_results: [])
    expect(afterContent).not.toContain("step_results:");

    // Only one run should remain
    const reloaded = await loadWorkflowRuns(ctx);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]._ulid).toBe(ulid2);
  });

  it("multiple read-write cycles maintain stability", async () => {
    const kspecDir = path.join(tempDir, ".kspec-run-rt7");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeRunCtx(kspecDir);

    const runsPath = path.join(kspecDir, "kynetic.runs.yaml");
    const runUlid = testUlid("WKRC");
    await writeYamlFilePreserveFormat(runsPath, {
      kynetic_runs: "1.0",
      runs: [
        {
          _ulid: runUlid,
          workflow_ref: "@session-start",
          status: "completed",
          current_step: 2,
          total_steps: 2,
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:05:00.000Z",
          initiated_by: "@user",
        },
      ],
    });
    const initialContent = await fs.readFile(runsPath, "utf-8");

    // Multiple cycles — load and save each time
    for (let i = 0; i < 5; i++) {
      const loaded = await loadWorkflowRuns(ctx);
      await saveWorkflowRun(ctx, loaded[0]);
    }
    const afterContent = await fs.readFile(runsPath, "utf-8");

    expect(afterContent).toBe(initialContent);
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

  it("mutateDispatchWorkspaceRecordAtomically rejects malformed sibling records", async () => {
    const kspecDir = path.join(tempDir, ".kspec-dw-rt6");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeWorkspaceCtx(kspecDir);

    // Write a registry with one valid workspace and one malformed sibling
    // (integration.target_branch is a number instead of a string)
    const registryPath = path.join(kspecDir, "project.dispatch-workspaces.yaml");
    const validWs = makeMinimalWorkspaceYaml("ws-valid", "@task-ok");
    const malformedWs = {
      ...makeMinimalWorkspaceYaml("ws-bad", "@task-bad"),
      integration: {
        status: "pending",
        target_branch: 123, // invalid: should be string
        target_commit: "abc123",
        publication_mode: "manual_merge",
        outcome: "manual_merge",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    };
    await writeYamlFilePreserveFormat(registryPath, {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [validWs, malformedWs],
    });

    // Mutating the valid workspace should fail because the sibling is malformed
    await expect(
      mutateDispatchWorkspaceRecordAtomically(ctx, "ws-valid", (r) => ({
        ...r,
        lifecycle_state: "stale",
      })),
    ).rejects.toThrow(/Expected string, received number/);
  });

  it("mutate persists newly-added object fields on legacy records without branch_provenance", async () => {
    const kspecDir = path.join(tempDir, ".kspec-dw-rt7");
    await fs.mkdir(kspecDir, { recursive: true });
    const ctx = makeWorkspaceCtx(kspecDir);

    // Write a legacy workspace without branch_provenance
    const registryPath = path.join(kspecDir, "project.dispatch-workspaces.yaml");
    const legacyWs = makeMinimalWorkspaceYaml("ws-legacy", "@task-legacy");
    // Confirm no branch_provenance in the raw data
    expect(legacyWs).not.toHaveProperty("branch_provenance");
    await writeYamlFilePreserveFormat(registryPath, {
      kynetic_dispatch_workspaces: "1.0",
      workspaces: [legacyWs],
    });

    // Mutate to add branch_provenance with meaningful data
    await mutateDispatchWorkspaceRecordAtomically(ctx, "ws-legacy", (r) => ({
      ...r,
      branch_provenance: {
        ownership: "adopted" as const,
        source: "manual",
        remote_ref: "origin/feat/x",
        adopted_from: "feat/x",
        adopted_at: "2026-03-01T12:00:00.000Z",
        rehydrated: null,
      },
    }));

    // Verify the branch_provenance was persisted
    const afterContent = await fs.readFile(registryPath, "utf-8");
    expect(afterContent).toContain("branch_provenance:");
    expect(afterContent).toContain("ownership: adopted");
    expect(afterContent).toContain("source: manual");
    expect(afterContent).toContain("adopted_from: feat/x");

    // Verify it round-trips correctly through load
    const reloaded = await loadDispatchWorkspaceRegistry(ctx);
    expect(reloaded[0].branch_provenance?.ownership).toBe("adopted");
    expect(reloaded[0].branch_provenance?.source).toBe("manual");
    expect(reloaded[0].branch_provenance?.adopted_from).toBe("feat/x");
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
